/* ===========================================================================
   server/src/ai/review.js — grading, and the review that goes with it.
   ---------------------------------------------------------------------------
   A mark in this platform is two numbers and a paragraph:

     CORRECTNESS  produced by running the code against its assertions. This is
                  deterministic, it is the same for everybody, and no model
                  touches it. If the checks pass, it passed.

     CRAFT        produced by the static reviewer in app/cfml/review.js, which
                  measures the submission against the reference solution on
                  the same data — steps, database trips, loops — and applies a
                  rule table. Also deterministic.

     THE WRITE-UP the part a model is actually good at: was this the right
                  shape of solution, is there a simpler one, would this be
                  painful to change later.

   The order matters. Correctness and craft are decided before the model is
   asked anything, and the model is TOLD the verdict rather than asked for it.
   That is what stops a confident paragraph from overriding a failing test,
   and it is why the assistant being unavailable degrades the feedback rather
   than the mark.

   Nothing here writes a final grade. It writes a recommendation with
   grader_type 'ai' or 'auto', and a teacher confirms it.
   =========================================================================== */

import * as api from './client.js';
import * as prompts from './prompts.js';
import { loop } from './agent.js';
import { one, all, insert, update, id, json } from '../db/db.js';
import { runner } from '../course/runner.js';

/* ------------------------------------------------------- the deterministic half */

/* Grade one code submission. Never calls the model. This is the function the
   platform can always run, on every submission, for free, in milliseconds. */
export function autoGrade(spec) {
  const s = spec || {};
  const R = runner();
  if (!R) {
    return { ok: false, error: 'The CFML runner is not loaded on this server, so code cannot be graded here.' };
  }
  const exercise = s.exercise;
  if (!exercise || !exercise.assertions) {
    return { ok: false, error: 'That assignment has no checks attached, so it cannot be auto-graded.' };
  }

  const sim = exercise.simulate || {};
  const result = R.CFML.run(s.source, sim);
  const graded = R.Grader.grade(result, exercise.assertions, s.source);

  // The benchmark: the reference solution, run on the same simulated request.
  let reference = null;
  if (exercise.solution) {
    const refResult = R.CFML.run(exercise.solution, sim);
    if (refResult.ok) reference = { result: refResult, source: exercise.solution };
  }

  const review = R.CFReview.review({
    result, source: s.source, exercise, grade: graded,
    reference,
    at: s.at || exercise.at,
    revealed: !!graded.pass,     // once they have passed, nothing is held back
  });

  return {
    ok: true,
    correctness: {
      pass: graded.pass, percent: graded.percent,
      earned: graded.earned, possible: graded.possible,
      rows: graded.rows.map((r) => ({
        tier: r.tier, tierLabel: r.tierLabel, pass: r.pass,
        message: r.message, expected: r.pass ? undefined : r.expected, actual: r.pass ? undefined : r.actual,
      })),
      ran: result.ok,
      error: result.ok ? null : { message: result.error.message, line: result.error.line },
    },
    craft: {
      score: review.craft, band: review.band, headline: review.headline,
      findings: review.findings, deferred: review.deferred,
      metrics: review.metrics, comparison: review.comparison,
    },
    score: blend(graded, review, s.weights),
  };
}

/* One number out of two, with the split visible rather than baked in. The
   default leans on correctness because a beautiful wrong answer is a wrong
   answer, and craft is 30% because a mark that ignores it teaches that it
   does not matter. */
export function blend(graded, review, weights) {
  const w = Object.assign({ correctness: 0.7, craft: 0.3 }, weights || {});
  const correctness = graded.percent;
  const craft = review.craft;
  const total = Math.round(correctness * w.correctness + craft * w.craft);
  return {
    total,
    parts: [
      { name: 'Correctness', value: correctness, weight: w.correctness,
        why: graded.pass ? 'Every check passed.' : graded.rows.filter((r) => !r.pass).length + ' check(s) failed.' },
      { name: 'Craft', value: craft, weight: w.craft, why: review.headline },
    ],
  };
}

/* ------------------------------------------------------------- the model half */

/* The write-up. Given a submission that has ALREADY been graded, ask the model
   for the judgement the rule table cannot make. Returns null when the model is
   not configured, which every caller must handle — the platform works without
   it. */
export async function aiReview(ctx, spec) {
  if (!api.configured()) return { unavailable: 'no API key is configured on this server' };
  const s = spec || {};
  const auto = s.auto || autoGrade(s);
  if (!auto.ok) return { unavailable: auto.error || 'the code could not be graded' };
  const started = Date.now();

  const already = (auto.craft.findings || []).map((f) => '- ' + f.label + (f.line ? ' (line ' + f.line + ')' : ''));
  const m = auto.craft.metrics || {};
  const c = auto.craft.comparison;

  const brief = [
    'ASSIGNMENT: ' + (s.title || 'a CFML exercise'),
    'WHAT WAS ASKED: ' + strip(s.prompt || ''),
    '',
    'VERDICT ALREADY DECIDED BY RUNNING THE CODE — do not contradict it:',
    '  correctness: ' + (auto.correctness.pass ? 'PASSED' : 'FAILED') + ' (' + auto.correctness.percent + '%)',
    auto.correctness.pass ? '' : '  failing checks: ' +
      auto.correctness.rows.filter((r) => !r.pass).map((r) => r.message).join(' | '),
    '  craft score from the static reviewer: ' + auto.craft.score + '/100 (' + auto.craft.band + ')',
    '',
    'MEASUREMENTS (facts, taken by the runtime):',
    '  interpreter steps: ' + m.steps + (c && c.steps.bench ? '   benchmark: ' + c.steps.bench : ''),
    '  database statements: ' + m.queries + (c ? '   benchmark: ' + c.queries.bench : ''),
    '  loops: ' + m.loops + ', deepest nesting: ' + m.loopNesting + ', lines of code: ' + m.codeLines,
    '  unparameterised statements: ' + m.unsafeQueries,
    '',
    'THE STATIC REVIEWER HAS ALREADY SAID THIS — do not repeat any of it:',
    already.length ? already.join('\n') : '  (nothing)',
  ].filter((x) => x !== '').join('\n');

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: brief },
      { type: 'text', text: prompts.fence('student_code', s.source) },
    ],
  }];

  const session = { ctx, threadId: null, produced: [], toolsUsed: [], model: api.MODELS.review };
  const out = await loop({
    session, system: prompts.REVIEW_SYSTEM, messages, tools: [],
    model: api.MODELS.review, maxTokens: 1500,
  });

  api.recordUsage(ctx.id, out.usage, 0);
  api.logRun({ userId: ctx.id, purpose: 'review', model: api.MODELS.review, usage: out.usage,
    ms: Date.now() - started, ok: !out.error, error: out.error || '',
    redactions: ['reference solution withheld'] });

  if (out.error) return { unavailable: out.error };
  const parsed = firstJson(out.text);
  if (!parsed || !Array.isArray(parsed.points)) {
    return { unavailable: 'the reviewer did not reply with the expected JSON',
      sample: String(out.text || '').slice(0, 200) };
  }

  return {
    summary: String(parsed.summary || ''),
    approach: String(parsed.approach || ''),
    points: parsed.points.slice(0, 4).map((p) => ({
      line: Number(p.line) || 0,
      severity: ['improve', 'style', 'praise'].indexOf(p.severity) >= 0 ? p.severity : 'improve',
      label: String(p.label || '').slice(0, 140),
      why: String(p.why || '').slice(0, 800),
      better: String(p.better || '').slice(0, 1200),
      from: 'model',
    })),
    model: api.MODELS.review,
  };
}

/* A rubric assessment of a written answer. Same shape of contract: the model
   proposes, a person confirms. */
export async function aiAssess(ctx, spec) {
  if (!api.configured()) return null;
  const s = spec || {};
  const rubric = s.rubric || [];
  if (!rubric.length) return null;
  const started = Date.now();

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'QUESTION: ' + strip(s.prompt || '') + '\n\nRUBRIC:\n' +
        rubric.map((r, i) => `  ${r.id || 'c' + (i + 1)} (${r.points} pts): ${r.criterion}`).join('\n') },
      { type: 'text', text: prompts.fence('student_answer', s.answer) },
    ],
  }];

  const session = { ctx, threadId: null, produced: [], toolsUsed: [], model: api.MODELS.grade };
  const out = await loop({
    session, system: prompts.GRADE_SYSTEM, messages, tools: [],
    model: api.MODELS.grade, maxTokens: 1500,
  });

  api.recordUsage(ctx.id, out.usage, 0);
  api.logRun({ userId: ctx.id, purpose: 'grade', model: api.MODELS.grade, usage: out.usage,
    ms: Date.now() - started, ok: !out.error, error: out.error || '' });

  if (out.error) return { unavailable: out.error };
  const parsed = firstJson(out.text);
  if (!parsed || !Array.isArray(parsed.criteria)) {
    return { unavailable: 'the assessor did not reply with the expected JSON' };
  }

  const max = rubric.reduce((a, r) => a + Number(r.points || 0), 0);
  const total = parsed.criteria.reduce((a, c2) => a + Number(c2.points || 0), 0);
  return {
    criteria: parsed.criteria, total: Math.min(total, max), max,
    feedback: String(parsed.feedback || ''),
    confidence: parsed.confidence || 'medium',
    needsHuman: parsed.needs_human !== false,
    model: api.MODELS.grade,
  };
}

/* ------------------------------------------------------------- persistence */

/* Record a grade against a submission. grader_type says who decided, and
   nothing is confirmed until a person confirms it. */
export function recordGrade(spec) {
  const s = spec;
  const gid = id('grd');
  insert('grades', {
    id: gid, submission_id: s.submissionId,
    grader_type: s.graderType, grader_id: s.graderId || null,
    score: s.score, max: s.max === undefined ? 100 : s.max,
    correctness_json: JSON.stringify(s.correctness || {}),
    craft_json: JSON.stringify(s.craft || {}),
    rubric_json: JSON.stringify(s.rubric || []),
    feedback: s.feedback || '', model: s.model || '',
    confirmed_by: s.graderType === 'teacher' ? (s.graderId || null) : null,
    confirmed_at: s.graderType === 'teacher' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
  });
  return one('SELECT * FROM grades WHERE id = ?', gid);
}

export function confirmGrade(ctx, gradeId, patch) {
  const g = one('SELECT * FROM grades WHERE id = ?', gradeId);
  if (!g) return null;
  const sub = one('SELECT * FROM submissions WHERE id = ?', g.submission_id);
  const asg = sub ? one('SELECT * FROM assignments WHERE id = ?', sub.assignment_id) : null;
  const role = asg ? ctx.classRole(asg.class_id) : null;
  if (ctx.role !== 'admin' && role !== 'teacher' && role !== 'ta') {
    const e = new Error('Only the teaching team confirms a grade.');
    e.status = 403; throw e;
  }
  const p = patch || {};
  update('grades', gradeId, {
    score: p.score === undefined ? g.score : p.score,
    feedback: p.feedback === undefined ? g.feedback : p.feedback,
    overridden: p.score !== undefined && Number(p.score) !== Number(g.score) ? 1 : g.overridden,
    confirmed_by: ctx.id,
    confirmed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  return one('SELECT * FROM grades WHERE id = ?', gradeId);
}

export function gradesFor(submissionId) {
  return all('SELECT * FROM grades WHERE submission_id = ? ORDER BY created_at DESC', submissionId)
    .map((g) => Object.assign({}, g, {
      correctness: json(g.correctness_json, {}), craft: json(g.craft_json, {}),
      rubric: json(g.rubric_json, []),
      confirmed: !!g.confirmed_at,
    }));
}

/* ------------------------------------------------------------------ bits */

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

/* The model is asked for JSON only, and usually gives it. When it wraps the
   object in prose or a fence, take the first balanced object rather than
   failing the whole review over punctuation. */
export function firstJson(text) {
  const t = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (!depth) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}
