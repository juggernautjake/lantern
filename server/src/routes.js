/* ===========================================================================
   server/src/routes.js — every endpoint the platform exposes.
   ---------------------------------------------------------------------------
   Handlers are thin. All of the judgement lives in files/, ai/ and search/,
   which is what makes it possible to test the rules without a server and to
   be sure that a second entry point cannot skip a check: there is no way to
   reach the filing system except with a permission context, and the router
   builds that from the session before a handler ever runs.
   =========================================================================== */

import { Router } from './http/server.js';
import * as filesApi from './files/files.js';
import * as paths from './files/paths.js';
import * as permsApi from './files/permissions.js';
import * as searchApi from './search/index.js';
import * as agent from './ai/agent.js';
import * as aiReview from './ai/review.js';
import * as aiClient from './ai/client.js';
import { runner, exerciseByRef, allExercises } from './course/runner.js';
import * as teaching from './teaching.js';
import * as retention from './files/retention.js';
import { one, all, run as sqlRun, insert, update, id, json, hashPassword, verifyPassword } from './db/db.js';
import { startSession, endSession, soloUser } from './http/server.js';
import { sseWriter } from './ai/stream.js';

export function routes() {
  const r = new Router();

  /* =================================================================== who */

  r.post('/api/auth/login', async ({ body, setSession }) => {
    const email = String((body && body.email) || '').trim().toLowerCase();
    const u = one('SELECT * FROM users WHERE lower(email) = ?', email);
    if (!u || !u.active || !verifyPassword((body && body.password) || '', u.password_hash, u.password_salt)) {
      // One message for both cases, deliberately: which of the two it was is
      // information an attacker wants and a user does not need.
      return { status: 401, body: { error: 'Those details did not match.' } };
    }
    const s = startSession(u.id);
    setSession(s.token);
    return { body: { user: publicUser(u), token: s.token } };
  }, { auth: false });

  r.post('/api/auth/logout', async ({ token, clearSession }) => {
    endSession(token); clearSession();
    return { body: { ok: true } };
  }, { auth: false });

  r.get('/api/me', async ({ ctx }) => ({
    body: {
      user: { id: ctx.id, name: ctx.name, role: ctx.role },
      classes: ctx.enrolments.map((e) => {
        const c = one('SELECT c.id, c.title, c.code, co.title AS course, co.id AS course_id FROM classes c JOIN courses co ON co.id = c.course_id WHERE c.id = ?', e.class_id);
        return c ? { id: c.id, title: c.title, code: c.code, course: c.course, courseId: c.course_id, role: e.role } : null;
      }).filter(Boolean),
      wards: ctx.wards.map((w) => { const u = one('SELECT id, name FROM users WHERE id = ?', w); return u; }).filter(Boolean),
      ai: { configured: aiClient.configured(), budget: aiClient.configured() ? aiClient.budgetFor(ctx.id) : null },
      solo: !!soloUser(),
      folders: {
        private: paths.personPrivate(ctx.id),
        portfolio: paths.personPortfolio(ctx.id),
      },
    },
  }));

  /* ================================================================= files */

  r.get('/api/files', async ({ ctx, query }) => {
    if (query.path || query.folderId) return { body: filesApi.list(ctx, { path: query.path, folderId: query.folderId }) };
    if (query.entityType && query.entityId) {
      return { body: { files: filesApi.forEntity(ctx, query.entityType, query.entityId) } };
    }
    return { body: { files: filesApi.find(ctx, query) } };
  });

  r.get('/api/files/:id', async ({ ctx, params }) => ({ body: filesApi.get(ctx, params.id) }));

  r.get('/api/files/:id/content', async ({ ctx, params, query, send }) => {
    const { meta, data } = await filesApi.read(ctx, params.id);
    const disposition = query.download ? 'attachment' : 'inline';
    send(200, data, {
      'content-type': meta.mime,
      'content-length': String(data.length),
      'content-disposition': `${disposition}; filename="${meta.name.replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=60',
    });
  });

  r.get('/api/files/:id/versions', async ({ ctx, params }) => ({ body: { versions: filesApi.versions(ctx, params.id) } }));
  r.get('/api/files/:id/audience', async ({ ctx, params }) => ({ body: filesApi.audience(ctx, params.id) }));
  r.get('/api/files/:id/audit', async ({ ctx, params, query }) => ({ body: { entries: filesApi.auditTrail(ctx, params.id, query.limit) } }));

  /* Upload. Multipart, one or many files, metadata in the form fields.
     Metadata is required — the filing system refuses a file it cannot
     describe, which is the whole difference between this and a shared drive. */
  r.post('/api/files', async ({ ctx, files, fields }) => {
    if (!files.length) return { status: 400, body: { error: 'No file was attached.' } };
    const targetPath = fields.path || paths.personPrivate(ctx.id);
    filesApi.ensureFolder({ path: targetPath, ownerId: ctx.id });
    const out = [];
    for (const f of files) {
      out.push(await filesApi.put(ctx, {
        path: targetPath, name: f.name, data: f.data, mime: f.mime,
        purpose: fields.purpose || 'resource',
        source: 'upload',
        title: fields.title || f.name,
        description: fields.description || '',
        visibility: fields.visibility || 'inherit',
        tags: splitList(fields.tags),
        courseIds: splitList(fields.courseIds),
        classIds: splitList(fields.classIds),
        links: fields.entityType && fields.entityId
          ? [{ type: fields.entityType, id: fields.entityId, relation: fields.relation || 'attachment' }] : [],
        meta: json(fields.meta, {}),
      }));
    }
    return { status: 201, body: { files: out } };
  });

  r.patch('/api/files/:id', async ({ ctx, params, body }) => ({ body: filesApi.updateMeta(ctx, params.id, body || {}) }));
  r.del('/api/files/:id', async ({ ctx, params, query }) => {
    filesApi.remove(ctx, params.id, query.reason);
    return { body: { ok: true } };
  });
  r.post('/api/files/:id/restore', async ({ ctx, params }) => ({ body: filesApi.restore(ctx, params.id) }));
  r.post('/api/files/:id/share', async ({ ctx, params, body }) => ({
    body: filesApi.share(ctx, Object.assign({ fileId: params.id }, body || {})),
  }));
  r.del('/api/shares/:id', async ({ ctx, params }) => { filesApi.unshare(ctx, params.id); return { body: { ok: true } }; });

  r.post('/api/folders', async ({ ctx, body }) => {
    const b = body || {};
    // A person may make folders under /shared and under their own area.
    const d = paths.describe(b.path || '');
    const mine = (d.kind === 'personal' || d.kind === 'portfolio') && d.userId === ctx.id;
    const isShared = d.root === 'shared';
    const teaches = d.classId && ['teacher', 'ta'].indexOf(ctx.classRole(d.classId)) >= 0;
    if (!(mine || isShared || teaches || ctx.role === 'admin')) {
      return { status: 403, body: { error: 'You cannot create a folder there.' } };
    }
    return { status: 201, body: filesApi.ensureFolder({ path: b.path, ownerId: ctx.id, system: false }) };
  });

  /* ================================================================ search */

  r.get('/api/search', async ({ ctx, query }) => ({
    body: { results: searchApi.search(ctx, query.q, { type: query.type, classId: query.classId, limit: Number(query.limit) || 12 }) },
  }));

  /* ============================================================== grading */

  /* Grade a piece of code without saving anything. This is what the studio
     calls while a learner is working: deterministic, instant, free. */
  r.post('/api/grade/preview', async ({ ctx, body }) => {
    const b = body || {};
    const exercise = b.exercise || exerciseByRef(b.ref);
    if (!exercise) return { status: 404, body: { error: 'No graded item called "' + b.ref + '".' } };
    const g = aiReview.autoGrade({ exercise, source: b.source || '', at: b.at || exercise.at, weights: b.weights });
    if (!g.ok) return { status: 503, body: { error: g.error } };
    return { body: strip(g) };
  });

  /* The full pass: grade, review, optionally ask the model for the write-up,
     and record it against a submission. */
  r.post('/api/grade', async ({ ctx, body }) => {
    const b = body || {};
    const sub = b.submissionId ? one('SELECT * FROM submissions WHERE id = ?', b.submissionId) : null;
    const asg = sub ? one('SELECT * FROM assignments WHERE id = ?', sub.assignment_id) : null;
    if (sub && sub.student_id !== ctx.id) {
      const role = asg ? ctx.classRole(asg.class_id) : null;
      if (ctx.role !== 'admin' && role !== 'teacher' && role !== 'ta') {
        return { status: 403, body: { error: 'That is not your submission.' } };
      }
    }
    const ref = b.ref || (asg && asg.ref);
    const exercise = b.exercise || exerciseByRef(ref);
    if (!exercise) return { status: 404, body: { error: 'No checks are attached to that assignment.' } };
    const source = b.source !== undefined ? b.source : (sub ? sub.body : '');

    const weights = asg ? json(asg.weight_json, undefined) : b.weights;
    const auto = aiReview.autoGrade({ exercise, source, at: b.at || exercise.at, weights });
    if (!auto.ok) return { status: 503, body: { error: auto.error } };

    // The write-up is a bonus and must never cost the mark — but a failure
    // has to be visible, or a broken key looks like a quiet model.
    let written = null, writtenProblem = null;
    if (b.ai !== false && aiClient.configured()) {
      try {
        const got = await aiReview.aiReview(ctx, {
          auto, source, title: asg ? asg.title : exercise.title,
          prompt: exercise.prompt || exercise.brief || '',
        });
        if (got && got.unavailable) { writtenProblem = got.unavailable; }
        else written = got;
      } catch (e) {
        writtenProblem = e.message;
      }
      if (writtenProblem) console.warn('[lantern] the written review failed: ' + writtenProblem);
    } else if (b.ai !== false) {
      writtenProblem = 'no API key is configured on this server';
    }

    let grade = null;
    if (sub) {
      grade = aiReview.recordGrade({
        submissionId: sub.id,
        graderType: written ? 'ai' : 'auto',
        score: auto.score.total, max: asg ? asg.max_points : 100,
        correctness: auto.correctness, craft: auto.craft,
        feedback: written ? written.summary : auto.craft.headline,
        model: written ? written.model : '',
      });
    }

    return { body: Object.assign(strip(auto), {
      written, writtenProblem,
      grade: grade ? { id: grade.id, score: grade.score, confirmed: false,
        note: 'This is a recommendation. A teacher confirms it before it counts.' } : null,
    }) };
  });

  r.post('/api/grades/:id/confirm', async ({ ctx, params, body }) => ({
    body: aiReview.confirmGrade(ctx, params.id, body || {}),
  }), { role: ['teacher', 'admin', 'staff'] });

  r.get('/api/submissions/:id/grades', async ({ ctx, params }) => {
    const sub = one('SELECT * FROM submissions WHERE id = ?', params.id);
    if (!sub) return { status: 404, body: { error: 'No such submission.' } };
    const asg = one('SELECT * FROM assignments WHERE id = ?', sub.assignment_id);
    const role = ctx.classRole(asg.class_id);
    const maySee = sub.student_id === ctx.id || ctx.role === 'admin' ||
      role === 'teacher' || role === 'ta' || ctx.isWard(sub.student_id);
    if (!maySee) return { status: 403, body: { error: 'That is not your submission.' } };
    return { body: { grades: aiReview.gradesFor(params.id) } };
  });

  /* =========================================================== submissions */

  r.post('/api/submissions', async ({ ctx, body }) => {
    const b = body || {};
    const asg = one('SELECT * FROM assignments WHERE id = ?', b.assignmentId);
    if (!asg) return { status: 404, body: { error: 'No such assignment.' } };
    if (!ctx.classRole(asg.class_id)) return { status: 403, body: { error: 'You are not in that class.' } };

    const prior = all('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ? ORDER BY attempt DESC', asg.id, ctx.id);
    const open = prior.find((p) => p.status === 'draft');
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);

    let sub;
    if (open) {
      update('submissions', open.id, { body: b.source || '', status: b.submit ? 'submitted' : 'draft', submitted_at: b.submit ? nowIso : null });
      sub = one('SELECT * FROM submissions WHERE id = ?', open.id);
    } else {
      const sid = id('sub');
      insert('submissions', {
        id: sid, assignment_id: asg.id, student_id: ctx.id,
        attempt: (prior[0] ? prior[0].attempt : 0) + 1,
        body: b.source || '', status: b.submit ? 'submitted' : 'draft',
        submitted_at: b.submit ? nowIso : null,
      });
      sub = one('SELECT * FROM submissions WHERE id = ?', sid);
    }

    // File the submission so it exists in the filing system too, with the
    // right audience, rather than living only in a column.
    if (b.submit && b.source) {
      const folder = paths.studentSubmission(asg.class_id, asg.id, ctx.id);
      filesApi.ensureFolder({ path: folder, classId: asg.class_id, assignmentId: asg.id, subjectUserId: ctx.id, ownerId: ctx.id });
      const f = await filesApi.put(ctx, {
        path: folder, name: (asg.ref || 'submission') + '.cfm', data: b.source,
        purpose: 'submission', source: 'upload', title: asg.title,
        description: 'Attempt ' + sub.attempt + ' of ' + asg.title,
        links: [{ type: 'submission', id: sub.id, relation: 'is' },
          { type: 'assignment', id: asg.id, relation: 'answers' }],
      });
      update('submissions', sub.id, { file_id: f.id });
    }
    return { status: 201, body: one('SELECT * FROM submissions WHERE id = ?', sub.id) };
  });

  r.get('/api/assignments', async ({ ctx, query }) => {
    const classId = query.classId;
    if (classId && !ctx.classRole(classId) && ctx.role !== 'admin') {
      return { status: 403, body: { error: 'You are not in that class.' } };
    }
    const rows = classId
      ? all('SELECT * FROM assignments WHERE class_id = ? ORDER BY created_at', classId)
      : all(`SELECT a.* FROM assignments a JOIN enrolments e ON e.class_id = a.class_id
              WHERE e.user_id = ? AND e.status='active' ORDER BY a.due_at`, ctx.id);
    return { body: { assignments: rows.map((a) => Object.assign({}, a, { weights: json(a.weight_json, {}), rubric: json(a.rubric_json, []) })) } };
  });

  r.get('/api/course/exercises', async () => ({ body: { exercises: allExercises() } }));

  /* Everything this person has handed in, every attempt, and how each was
     marked. One call, because a learner asking "how am I doing" should not
     have to open six screens to find out. */
  r.get('/api/me/grades', async ({ ctx }) => {
    const rows = all(
      `SELECT a.id AS assignment_id, a.title, a.ref, a.kind, a.due_at, a.max_points, a.class_id,
              c.code AS class_code
         FROM assignments a
         JOIN enrolments e ON e.class_id = a.class_id
         JOIN classes c ON c.id = a.class_id
        WHERE e.user_id = ? AND e.status = 'active' AND a.published = 1
        ORDER BY a.due_at, a.created_at`, ctx.id);

    const assignments = rows.map((a) => {
      const subs = all(
        `SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?
          ORDER BY attempt DESC`, a.assignment_id, ctx.id);
      const attempts = subs.map((sub) => {
        const grades = aiReview.gradesFor(sub.id);
        const latest = grades[0] || null;
        return {
          submissionId: sub.id, attempt: sub.attempt, status: sub.status,
          submittedAt: sub.submitted_at,
          score: latest ? latest.score : null,
          confirmed: latest ? !!latest.confirmed_at : false,
          by: latest ? latest.grader_type : null,
          feedback: latest ? latest.feedback : '',
          correctness: latest ? latest.correctness : null,
          craft: latest ? latest.craft : null,
        };
      });
      const marked = attempts.filter((x) => x.score !== null && x.score !== undefined);
      return Object.assign({}, a, {
        attempts,
        best: marked.length ? Math.max.apply(null, marked.map((x) => x.score)) : null,
        // The mark that counts is the best one. Retaking can only help, and
        // saying so is the difference between a learner who tries again and
        // one who does not.
        latest: attempts[0] || null,
      });
    });

    const graded = assignments.filter((a) => a.best !== null);
    return { body: {
      assignments,
      summary: {
        set: assignments.length,
        started: assignments.filter((a) => a.attempts.length).length,
        marked: graded.length,
        average: graded.length
          ? Math.round(graded.reduce((n, a) => n + a.best, 0) / graded.length) : null,
        awaitingConfirmation: assignments.reduce((n, a) =>
          n + a.attempts.filter((x) => x.score !== null && !x.confirmed).length, 0),
      },
    } };
  });

  /* The code of one attempt, so a retry can start from it. Yours, or a
     student's if you teach them. */
  r.get('/api/submissions/:id/source', async ({ ctx, params }) => {
    const sub = one('SELECT * FROM submissions WHERE id = ?', params.id);
    if (!sub) return { status: 404, body: { error: 'No such submission.' } };
    const asg = one('SELECT * FROM assignments WHERE id = ?', sub.assignment_id);
    const role = asg ? ctx.classRole(asg.class_id) : null;
    const maySee = sub.student_id === ctx.id || ctx.role === 'admin' || role === 'teacher' || role === 'ta';
    if (!maySee) return { status: 403, body: { error: 'That is not your submission.' } };
    return { body: { source: sub.body, attempt: sub.attempt, status: sub.status } };
  });

  /* ============================================================== teaching */

  r.get('/api/classes/:id/overview', async ({ ctx, params }) => ({
    body: teaching.overview(ctx, params.id),
  }));

  /* The one a teacher opens on a Monday: what to re-teach. */
  r.get('/api/classes/:id/craft', async ({ ctx, params, query }) => ({
    body: teaching.craftAcross(ctx, params.id, { assignmentId: query.assignmentId, limit: Number(query.limit) || 20 }),
  }));

  r.get('/api/classes/:id/students/:studentId', async ({ ctx, params }) => ({
    body: teaching.studentDetail(ctx, params.id, params.studentId),
  }));

  /* ============================================================= retention */

  /* Everything the platform holds about one person. A person can export
     themselves; a guardian can export their student; an admin can export
     anybody. Nobody else, including a teacher. */
  r.get('/api/export/:userId', async ({ ctx, params }) => ({
    body: retention.manifest(ctx, params.userId),
    headers: { 'content-disposition': 'attachment; filename="lantern-export.json"' },
  }));

  r.get('/api/files/:id/retention', async ({ ctx, params }) => {
    const st = retention.statusOf(ctx, params.id);
    if (!st) return { status: 404, body: { error: 'No such file, or you cannot see it.' } };
    return { body: st };
  });

  /* What a sweep would destroy, without destroying it. Admins only, and the
     preview is a separate call from the sweep on purpose. */
  r.get('/api/retention/plan', async () => ({ body: retention.plan() }), { role: ['admin'] });

  r.post('/api/retention/sweep', async ({ ctx, body }) => ({
    body: await retention.sweep({ actorId: ctx.id, dryRun: !(body && body.confirm) }),
  }), { role: ['admin'] });

  /* ================================================================== chat */

  r.get('/api/threads', async ({ ctx }) => ({
    body: { threads: all('SELECT id, title, class_id, updated_at FROM threads WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 50', ctx.id) },
  }));

  r.get('/api/threads/:id', async ({ ctx, params }) => {
    const t = agent.thread(ctx, params.id);
    if (!t) return { status: 404, body: { error: 'No such conversation.' } };
    return { body: { thread: t, messages: agent.history(t.id).map(renderMessage) } };
  });

  r.post('/api/chat', async ({ ctx, body }) => {
    const b = body || {};
    if (!b.text || !String(b.text).trim()) return { status: 400, body: { error: 'Say something.' } };
    if (!aiClient.configured()) {
      return { status: 503, body: {
        error: 'The assistant is not configured on this server.',
        detail: 'Set ANTHROPIC_API_KEY in server/.env and restart. Everything else — the auto-grader, ' +
          'the code reviewer, search and the filing system — works without it.',
      } };
    }
    const out = await agent.ask(ctx, {
      threadId: b.threadId, text: String(b.text), classId: b.classId,
      situation: b.situation || {}, attachments: b.attachments, web: b.web,
    });
    return { body: out };
  });

  /* Streamed chat. Same call as /api/chat, delivered as it is written: text
     fragments, and a line whenever the assistant reaches for a tool, so a
     six-second web search does not look like a hung page. */
  r.post('/api/chat/stream', async ({ ctx, body, res }) => {
    const b = body || {};
    if (!b.text || !String(b.text).trim()) return { status: 400, body: { error: 'Say something.' } };
    if (!aiClient.configured()) {
      return { status: 503, body: {
        error: 'The assistant is not configured on this server.',
        detail: 'Set ANTHROPIC_API_KEY in server/.env and restart.',
      } };
    }
    const sse = sseWriter(res);
    try {
      const out = await agent.askStream(ctx, {
        threadId: b.threadId, text: String(b.text), classId: b.classId,
        situation: b.situation || {}, attachments: b.attachments, web: b.web,
      }, (ev) => sse.send(ev.type, ev));
      sse.send('done', out);
    } catch (e) {
      sse.send('failed', { error: e.message, detail: e.detail });
    }
    sse.end();
    return undefined;
  });

  /* ================================================================ health */

  r.get('/api/health', async () => {
    const R = runner();
    return { body: {
      ok: true,
      cfml: !!R,
      exercises: R ? allExercises().length : 0,
      ai: aiClient.configured() ? 'configured' : 'no key',
      models: aiClient.MODELS,
    } };
  }, { auth: false });

  return r;
}

/* ------------------------------------------------------------------ bits */

const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

/* Grading responses carry a lot; the wire copy drops what only the server
   needs and, crucially, never carries the reference solution. */
function strip(g) {
  return {
    correctness: g.correctness,
    craft: {
      score: g.craft.score, band: g.craft.band, headline: g.craft.headline,
      findings: g.craft.findings.map((f) => ({
        id: f.id, severity: f.severity, line: f.line, label: f.label,
        seen: f.seen, why: f.why, better: f.better, concept: f.concept,
      })),
      deferred: (g.craft.deferred || []).map((f) => ({ label: f.label, until: f.deferredUntil })),
      metrics: g.craft.metrics,
      comparison: g.craft.comparison,
    },
    score: g.score,
  };
}

function renderMessage(m) {
  const blocks = m.content || [];
  return {
    id: m.id, role: m.role, at: m.at,
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    citations: blocks.flatMap((b) => (b.citations || []).map((c) => ({ url: c.url, title: c.title, quote: c.cited_text }))),
    toolCalls: blocks.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use')
      .map((b) => ({ name: b.name, input: b.input })),
  };
}
