/* ===========================================================================
   server/src/assistant/tools.js — what the assistant can do.
   ---------------------------------------------------------------------------
   Every tool reads from context.js (which never holds an answer) or does
   something for the learner in the app (an ACTION the page carries out:
   open a lesson, play a video, show resources, pause the music).

   review_code is the only tool that sends the learner's own code to the AI,
   and it is only offered on a turn where they asked about their code.
   =========================================================================== */

import * as context from './context.js';
import * as resources from './resources.js';
import * as progress from '../platform/progress.js';
import { runner, exerciseByRef } from '../course/runner.js';
import { autoGrade } from '../ai/review.js';

const obj = (props, required) => ({ type: 'object', properties: props || {}, required: required || [], additionalProperties: false });

export const DEFS = {
  lesson_context: { description: 'Where the learner is: the course, the unit, the lesson or check open now with its objectives and key terms, the exercise they are on (its prompt, whether they passed it, how many hints they have seen) and their progress. No answers are included.', input_schema: obj() },
  next_hint: { description: 'The course\'s own next hint for the exercise the learner is on, one rung at a time (nudge, idea, where to look, shape). Refuses on checks and exams. Say the hint in your own warm words without going beyond it.', input_schema: obj() },
  course_progress: { description: 'How far the learner is in the course, what is next, and time left.', input_schema: obj() },
  open_course: { description: 'Open a unit, a lesson or the course overview in the app. target examples: "unit 3", "unit 2 lesson 4", "lesson 2", a lesson title, "overview", "next".', input_schema: obj({ target: { type: 'string' } }, ['target']) },
  review_code: { description: 'The learner\'s own code for the exercise they are on, whether it has passed, and (when this computer can run the course) which checks fail and what a static reviewer noticed. Only use when the learner asked about their code.', input_schema: obj() },
  find_resources: { description: 'Free videos, articles, docs and discussions about the current lesson (or a topic), from YouTube, Crash Course, Khan Academy, Codecademy, freeCodeCamp, MDN, Wikipedia, Reddit and the course\'s docs. Shows them on screen as cards.', input_schema: obj({ topic: { type: 'string', description: 'optional: a topic instead of the current lesson' } }) },
  play_video: { description: 'Search YouTube and play the best match in the app\'s mini player (music or a video). query: what to play, e.g. "lofi study music" or "cfqueryparam tutorial".', input_schema: obj({ query: { type: 'string' } }, ['query']) },
  look_up: { description: 'Search the web and return the top results (title, link, snippet). Use for facts and current information.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
  media_control: { description: 'Control the app\'s player: pause, resume, next, previous, stop, louder, quieter, popout (open the video in their own browser at the same second).', input_schema: obj({ action: { type: 'string', enum: ['pause', 'resume', 'next', 'previous', 'stop', 'louder', 'quieter', 'popout'] } }, ['action']) },
};

export function definitions(opts) {
  const o = opts || {};
  return Object.entries(DEFS).filter(([name]) => name !== 'review_code' || o.allowCode).map(([name, d]) => Object.assign({ name }, d));
}


/* session: { uid, actions: [], allowCode, codeSent } */
export async function dispatch(name, input, session) {
  const inp = input || {};
  const S = session;
  try {
    switch (name) {
      case 'lesson_context': return ok(context.describe(S.uid));
      case 'next_hint': {
        const pack = context.currentPack();
        if (!pack) return ok({ none: 'no-course', message: 'No course is open.' });
        return ok(context.nextHint(S.uid, pack));
      }
      case 'course_progress': {
        const pack = context.currentPack();
        if (!pack) return ok({ message: 'No course is installed yet.' });
        const ov = progress.overview(S.uid, pack);
        return ok({ course: pack.title, percent: ov.percent, steps: ov.steps, lessons: ov.lessons, measure: progress.measure(ov), current: ov.current, finished: ov.finished, count: ov.count, next: ov.next, continue: ov.continue, minutesLeft: ov.minutesLeft, units: ov.units.map((u) => ({ n: u.n, title: u.title, done: u.done, count: u.count })) });
      }
      case 'open_course': {
        const out = openTarget(S, inp.target);
        return ok(out);
      }
      case 'review_code': {
        if (!S.allowCode) return err('The learner did not ask about their code on this turn.');
        const pack = context.currentPack();
        if (!pack) return err('No course is open.');
        const item = context.currentItem(S.uid, pack);
        if (!item) return err('There is no exercise on this page.');
        const code = context.learnerCode(S.uid, pack, item.id);
        S.codeSent = true;
        const out = { exercise: item.title, prompt: item.prompt || '', passed: item.passed, attempts: item.attempts, code: code || '(they have not written anything for this one yet)' };
        const checks = gradeHere(item.id, code);
        if (checks) Object.assign(out, checks);
        return ok(out);
      }
      case 'find_resources': {
        const pack = context.currentPack();
        const d = context.describe(S.uid);
        const res = pack ? context.resourcesOf(pack) : null;
        const r = await resources.find(d, res, { topic: inp.topic || null });
        S.actions.push({ type: 'resources', topic: r.topic, offline: r.offline, online: r.online, message: r.message || null, fromCache: !!r.fromCache });
        return ok({ topic: r.topic, shown: true, videos: r.online.filter((x) => x.type === 'video').slice(0, 4).map((x) => ({ title: x.title, url: x.url })), reading: r.online.filter((x) => x.type !== 'video').slice(0, 5).map((x) => ({ title: x.title, url: x.url, source: x.source })), docs: r.offline.slice(0, 5).map((x) => ({ title: x.title, url: x.url })), note: r.message || null });
      }
      case 'play_video': {
        const list = await resources.playable(String(inp.query || ''));
        if (!list.length) return ok({ played: false, message: 'Nothing came up for that (or the computer is offline).' });
        S.actions.push({ type: 'play', queue: list.map((v) => ({ videoId: v.videoId, title: v.title, source: v.source, thumbnail: v.thumbnail })), index: 0, kind: /\b(music|songs?|beats|playlist|album|lo-?fi|radio|jazz|piano|classical|ambient)\b/i.test(String(inp.query || '')) ? 'music' : 'video' });
        return ok({ played: true, title: list[0].title, queued: list.length });
      }
      case 'look_up': {
        const r = await resources.generalWeb().search(String(inp.query || ''), { max: 5 });
        return ok({ query: r.query, results: r.results.map((x) => ({ title: x.title, url: x.url, snippet: x.snippet })) });
      }
      case 'media_control': {
        S.actions.push({ type: 'media', action: inp.action });
        return ok({ done: true });
      }
      default: return err('No tool called ' + name + '.');
    }
  } catch (e) { return err(e.message); }
}
const ok = (x) => ({ content: JSON.stringify(x), isError: false });
const err = (m) => ({ content: JSON.stringify({ error: m }), isError: true });

/* When this computer has the course's source (a course author's), run the
   learner's code against its checks. Only the checks' own messages leave
   here: never an expected value, never the reference solution. */
export function gradeHere(id, code) {
  if (!code || !runner()) return null;
  const ex = exerciseByRef(id);
  if (!ex || !ex.assertions) return null;
  const g = autoGrade({ source: code, exercise: ex });
  if (!g || !g.ok) return null;
  return {
    checks: { passed: g.correctness.pass, percent: g.correctness.percent, failing: g.correctness.rows.filter((r) => !r.pass).map((r) => r.message), error: g.correctness.error ? { message: g.correctness.error.message, line: g.correctness.error.line } : null },
    reviewer: (g.craft.findings || []).slice(0, 5).map((f) => ({ label: f.label, line: f.line || null })),
  };
}

/* "unit 3", "lesson 2", a title, "next", "overview" → an open action. */
export function openTarget(S, target) {
  const pack = context.currentPack();
  if (!pack) return { opened: false, message: 'No course is installed yet.' };
  const t = String(target || '').trim().toLowerCase();
  if (!t || /^(the )?(overview|course|contents|outline)$/.test(t)) {
    S.actions.push({ type: 'open', course: pack.id, ref: null });
    return { opened: true, title: pack.title + ' overview' };
  }
  if (/^(next|the next( one| lesson)?|continue|where i left off)$/.test(t)) {
    const ov = progress.overview(S.uid, pack);
    const n = ov.continue || ov.next;
    if (!n) return { opened: false, message: 'You have finished everything in ' + pack.title + '.' };
    S.actions.push({ type: 'open', course: pack.id, ref: n.id });
    return { opened: true, title: n.title };
  }
  const hit = context.findTarget(pack, t);
  if (!hit || !hit.ref) return { opened: false, message: 'I could not find "' + target + '" in ' + pack.title + '.' };
  S.actions.push({ type: 'open', course: pack.id, ref: hit.ref });
  return { opened: true, title: hit.title };
}
