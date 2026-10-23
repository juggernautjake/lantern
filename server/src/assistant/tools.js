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
import * as study from './study.js';
import * as resources from './resources.js';
import * as progress from '../platform/progress.js';
import { runner, exerciseByRef } from '../course/runner.js';
import { autoGrade } from '../ai/review.js';
import * as knowledge from './knowledge.js';
import * as catalogue from './catalogue.js';
import * as review from './review.js';
import * as visuals from './teach/visuals.js';
import * as examples from './teach/examples.js';
import * as draw from './teach/draw.js';
import * as glossary from './teach/glossary.js';
import * as teachCourse from './teach/course.js';

const obj = (props, required) => ({ type: 'object', properties: props || {}, required: required || [], additionalProperties: false });

export const DEFS = {
  lesson_context: { description: 'Where the learner is: the course, the unit, the lesson or check open now with its objectives and key terms, the exercise they are on (its prompt, whether they passed it, how many hints they have seen) and their progress. No answers are included.', input_schema: obj() },
  next_hint: { description: 'The course\'s own next hint for the exercise the learner is on, one rung at a time (nudge, idea, where to look, shape). Refuses on checks and exams. Say the hint in your own warm words without going beyond it.', input_schema: obj() },
  course_progress: { description: 'How far the learner is in the course, what is next, and time left.', input_schema: obj() },
  open_course: { description: 'Open a unit, a lesson or the course overview in the app. target examples: "unit 3", "unit 2 lesson 4", "lesson 2", a lesson title, "overview", "next".', input_schema: obj({ target: { type: 'string' } }, ['target']) },
  review_code: { description: 'The learner\'s own code for the exercise they are on, whether it has passed, and (when this computer can run the course) which checks fail and what a static reviewer noticed. Only use when the learner asked about their code.', input_schema: obj() },
  find_resources: { description: 'Free videos, articles, docs and discussions about the current lesson (or a topic), from YouTube, Crash Course, Khan Academy, Codecademy, freeCodeCamp, MDN, Wikipedia, Reddit and the course\'s docs. Shows them on screen as cards.', input_schema: obj({ topic: { type: 'string', description: 'optional: a topic instead of the current lesson' } }) },
  play_video: { description: 'Search YouTube and play the best match in the app\'s mini player: music, or a video the learner names. For a video that teaches a course topic use find_videos and show_videos instead. query: what to play, e.g. "lofi study music" or "cfqueryparam tutorial".', input_schema: obj({ query: { type: 'string' } }, ['query']) },
  look_up: { description: 'Search the web and return the top results (title, link, snippet). Use for facts and current information.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
  lesson_video: { description: 'The script of a lesson video in this course: its chapters, every word the narrator says, what the board, tables and diagrams show, the recap, and its questions with their answers. With no input, the video of the lesson open now; with lesson, a lesson id (m3-l2) or any video id: m3-v2 a lesson video, m3-f4 a formula explained (why it has its form, where its constants come from), m3-e1 a worked example solved step by step, calc-5 a TI-30Xa how-to; with query, the videos that match (titles, chapters, scripts). Use it to explain a video again, to quote its numbers and steps exactly, or to point the learner to the right video and chapter.', input_schema: obj({ lesson: { type: 'string' }, query: { type: 'string' } }) },
  read_notes: { description: 'The learner\'s own notes in this course, in full. Use when they mention their notes, ask what they wrote, want to be quizzed on them or reviewed, or ask about something they may have written down. With no query, the most recently edited notes; with a query, the notes whose name or text mention it; with a title, that note.', input_schema: obj({ query: { type: 'string', description: 'optional: words to look for' }, title: { type: 'string', description: 'optional: the name of one note' } }) },
  save_note: { description: 'Write something into the learner\'s notes in the course that is open. ONLY when they ask you to write, note, jot or save something down (or agree when you offer). mode "append" (the default) adds to the note with that title, making it if needed; "new" starts a separate note. Write it in their voice, short and plain: headings with #, lists with -, maths in plain symbols.', input_schema: obj({ title: { type: 'string' }, text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'new'] } }, ['title', 'text']) },
  search_course: { description: 'Search everything in the course: every lesson\'s reading, the glossary, the flashcards, every formula (what it means, why it has its form, when and how to use it), every video\'s chapters, the course\'s guide to the NCEES FS Reference Handbook (its notation, symbols and printed pages) and the library of standards. Returns the best passages with where each is from. Use it before explaining a term, formula, symbol, procedure or rule, so your answer matches the course. kinds (optional) narrows it: reading, glossary, card, formula, video, handbook, handbook-notes, library.', input_schema: obj({ query: { type: 'string' }, kinds: { type: 'array', items: { type: 'string', enum: ['reading', 'glossary', 'card', 'formula', 'video', 'handbook', 'handbook-notes', 'library'] } } }, ['query']) },
  handbook: { description: 'An item of the NCEES FS Reference Handbook 2.5 (the one reference on exam day): an equation, symbol, constant, table, figure or supplied standard, with its printed page, its exact form and symbols, what the exam asks about it, and what the course says about it (why the formula has its form, when and how to use it, the lessons and videos that teach it). By query (words or a symbol), id, or printed page. Always cite the page it gives ("Handbook p. 10 — Horizontal circular curves"). Shows the learner an Open button for each item you look up, which opens the detail of that item in the reference panel of the course; part (optional): the symbol or figure part to pick in it ("T", "PC").', input_schema: obj({ query: { type: 'string' }, id: { type: 'string' }, page: { type: 'string' }, part: { type: 'string' } }) },
  standard: { description: 'A code or standard the exam supplies or the course teaches (ALTA/NSPS, the FEMA Elevation Certificate, FGDC/NSSDA, NGS guidelines, the BLM Manual, OSHA trenching…): who publishes it, what it requires (in the course\'s own words), whether it is supplied on exam day, the lessons on it, and for a public-domain document the pages of its own text that match the query.', input_schema: obj({ query: { type: 'string' }, id: { type: 'string' } }) },
  find_videos: { description: 'Videos for a topic (or, with no topic, for the page open now): the course\'s own videos (lesson videos, formulas explained, worked examples, calculator how-tos) with the chapter that teaches it and the lesson where each is shown, and checked free videos from YouTube and Khan Academy. Only these outside videos may ever be recommended. Then call show_videos with the ids you recommend.', input_schema: obj({ topic: { type: 'string' } }) },
  show_videos: { description: 'Show videos in the chat as cards: a course video is a compact card in the chat (it does not start by itself; the learner presses Play) with an Open lesson button; an outside video is a link that opens in their browser. ids: from find_videos (course ids like m2-v5 or m3-f4; outside ids like yt:… or ka:…), at most 3. t (optional): a course video starts at this second (a chapter start); end (optional): it plays only to this second, so a recorded segment that explains the point plays with its recorded voice. Each course video gets a card id (c1…) for cues: [[c1:play 95 140]], [[c1:seek 95]], [[c1:pause]]. Do not write the links yourself.', input_schema: obj({ ids: { type: 'array', items: { type: 'string' } }, t: { type: 'number' }, end: { type: 'number' } }, ['ids']) },
  my_standing: { description: 'How the learner is doing, from the course\'s own record and its own ranking of weakness (the same one its Study, Weak spots and Progress pages use): their weakest and strongest topics with % right and answers, the lesson that teaches each weak topic, lessons read, videos watched, flashcards due, best check per module, best mock exam, and recent quiz reviews. Use it for "what should I work on", "how am I doing", "what am I good at".', input_schema: obj() },
  find_visuals: { description: 'Find what the course has already built to teach a topic: figures (with interactive demonstrations), equations and lesson passages. Returns ids for show_figure, show_demo, show_equation and show_passage. Use it first, before drawing anything.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
  show_figure: { description: 'Show one of the course’s own figures in the chat, drawn by the course’s own code, with an Open in the lesson link. id from find_visuals. params (optional) as in the lesson. Returns a card id (c1, c2…) and the figure’s named parts and steps: use them in cues, e.g. [[c1:hl bs]] or [[c1:step 2]], placed in your reply right where you say the thing.', input_schema: obj({ id: { type: 'string' }, params: { type: 'object' } }, ['id']) },
  show_demo: { description: 'Show a figure as its interactive demonstration (its own buttons, sliders and modes) in the chat. Same ids and cues as show_figure; only figures that have a demo (find_visuals says demo: true).', input_schema: obj({ id: { type: 'string' }, params: { type: 'object' } }, ['id']) },
  show_equation: { description: 'Show an equation card from the course: the form, each symbol with its meaning, and when, how and why. id like m5-f19 (from find_visuals), or words. Cues: [[c1:sym T]] emphasises a symbol in the equation, [[c1:open derive]] opens why/when/how.', input_schema: obj({ id: { type: 'string' } }, ['id']) },
  show_passage: { description: 'Show a passage of a lesson reading in the chat, as the lesson prints it, with Open in the lesson. ref is a lesson id (m2-l3); heading (optional) picks the part.', input_schema: obj({ ref: { type: 'string' }, heading: { type: 'string' } }, ['ref']) },
  draw_figure: { description: 'ONLY when nothing built fits (a niche question): draw a simple new illustration from a declarative spec, never code. spec = { view?:{x,y,w,h}, items:[{t:"point|line|arc|polygon|dim|angle|label|symbol|grid|axes", part?:"name", ...}], steps?:[{show?:[part], hl?:[part], say?}] }. y points up, angles in degrees counter-clockwise from +x. Items: point{x,y,label}, line{x1,y1,x2,y2,dash}, arc{cx,cy,r,from,to}, polygon{pts:[[x,y]],fill}, dim{x1,y1,x2,y2,text,off}, angle{x,y,r,from,to,text}, label{x,y,text,anchor}, symbol{kind:instrument|rod|north|monument|benchmark|tripod|target|pin,x,y,size}, grid{x,y,w,h,step}, axes{x,y,w,h,xlabel,ylabel}. At most 80 items, 16 steps, 9 KB. Parts named in a step’s show start hidden; cue them [[c1:show part]], [[c1:hl part]] or [[c1:step 2]]. Returns the card id or what to fix.', input_schema: obj({ title: { type: 'string' }, spec: { type: 'object' } }, ['spec']) },
  draw_derivation: { description: 'ONLY when no built equation card explains it: an equation derivation as ordered steps, shown with the course’s math formatting. steps = [{ math: "T = R tan(I/2)", say?: "why this line" }] (at most 12). Cue [[c1:step 2]] reveals through line 2, [[c1:hl 2]] stresses a line.', input_schema: obj({ title: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } } }, ['steps']) },
  worked_example: { description: 'A worked example with CORRECT numbers, from the course’s own problem generators (elevations and differential leveling, cut and fill, RTK GPS and GNSS, EDM, curves, traverses, error propagation…). Give a topic in course words; the engine draws fresh numbers and returns the question, every step’s computed result and the answer, and shows it in the chat with the generator’s own diagram. NEVER do the arithmetic of a shown answer yourself: quote these numbers. Then also show the matching figure (find_visuals + show_figure) when the example has no diagram of its own. Not available on a check or a mock exam.', input_schema: obj({ topic: { type: 'string' }, key: { type: 'string', description: 'a generator key from an earlier result, to draw again' } }) },
  glossary: { description: 'Explain a term, alias, acronym or symbol from the course glossary (spelling may be rough): the plain definition, and when the data has them an example sentence, usage, what it is confused with and related terms; for an acronym its entry; the lessons that teach it (with the lesson own sentence and how to open it); and the figure or equation that shows it (show_figure / show_equation ids, with cue_part). Use it FIRST for "what is X", "what does X mean", "explain X". For a legal or boundary term then give a sentence from a deed or report; for a computational one call worked_example. Fast, no network.', input_schema: obj({ term: { type: 'string' } }, ['term']) },
  law_basis: { description: 'For land-law and boundary questions: the lessons (and Texas-specific items) to rest a short realistic scenario on. Write the scenario yourself from what these say, cite each lesson by title, and say plainly what is US-general and what is Texas-specific.', input_schema: obj({ topic: { type: 'string' } }, ['topic']) },
  media_control: { description: 'Control the app\'s player: pause, resume, next, previous, stop, louder, quieter, popout (open the video in their own browser at the same second).', input_schema: obj({ action: { type: 'string', enum: ['pause', 'resume', 'next', 'previous', 'stop', 'louder', 'quieter', 'popout'] } }, ['action']) },
};

export function definitions(opts) {
  const o = opts || {};
  const TEACH = ['find_visuals','show_figure','show_demo','show_equation','show_passage','draw_figure','draw_derivation','worked_example','law_basis','glossary'];
  return Object.entries(DEFS).filter(([name]) => (name !== 'review_code' || o.allowCode) && (!TEACH.includes(name) || o.teach)).map(([name, d]) => Object.assign({ name }, d));
}


/* session: { uid, actions: [], allowCode, codeSent } */
/* A reply carries zero or one visual card by default (a video is a reference, not a visual). When a
   second one is asked for, the tool still answers, but tells the model to hold back and offer it. */
export async function dispatch(name, input, session) {
  const before = (session && session.visuals) || 0;
  const r = await dispatchTool(name, input, session);
  if (!r.isError && session && (session.visuals || 0) > before && session.visuals > 1) {
    try { const o = JSON.parse(r.content); o.note = ((o.note ? o.note + ' ' : '') + 'This is a second visual card in one reply. Keep to one visual by default: do not add more unless the learner asked for them; offer the rest in a short question.').trim(); r.content = JSON.stringify(o); } catch (e) { /* not an object */ }
  }
  return r;
}
async function dispatchTool(name, input, session) {
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
        const r = await findResources(pack, d, res, { topic: inp.topic || null });
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
      case 'lesson_video': {
        const pack = context.currentPack();
        if (!pack) return ok({ message: 'No course is open.' });
        if (inp.query && !inp.lesson) {
          const found = study.findVideos(pack, inp.query);
          return ok(found.length ? { matches: found } : { message: 'No lesson video matches "' + inp.query + '".' });
        }
        const ref = inp.lesson || context.where().ref;
        const v = study.videoScript(pack, ref);
        return ok(v || { message: ref ? 'Lesson ' + ref + ' has no video.' : 'No lesson is open; give a lesson id or a query.' });
      }
      case 'read_notes': {
        const pack = context.currentPack();
        if (!pack) return ok({ notes: [], message: 'No course is open.' });
        const all = context.notesOf(S.uid, pack);
        if (!all.length) return ok({ notes: [], message: 'They have not written any notes in ' + pack.title + ' yet.' });
        const title = String(inp.title || '').trim().toLowerCase();
        const words = String(inp.query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        let hits = title ? all.filter((n) => n.title.toLowerCase() === title || n.title.toLowerCase().includes(title)) : all;
        if (words.length) hits = hits.filter((n) => { const h = (n.title + ' ' + n.body).toLowerCase(); return words.every((w) => h.includes(w)); });
        let budget = 15000;
        const notes = hits.slice(0, 8).map((n) => {
          const body = n.body.slice(0, Math.max(400, budget));
          budget -= body.length;
          return { title: n.title, edited: n.updated ? new Date(n.updated).toISOString().slice(0, 10) : null, page: n.page, text: body + (body.length < n.body.length ? '…(cut short)' : '') };
        });
        return ok({ notes, total: all.length, matched: hits.length });
      }
      case 'save_note': {
        const pack = context.currentPack();
        const w = context.where();
        if (!pack || w.course !== pack.id) return err('The course is not open in the app, so there is nowhere to write the note. Ask them to open the course first.');
        if (context.notesIndex(S.uid, pack) === null) return err(pack.title + ' has no notes panel, so a note cannot be saved there. Offer to say it again instead, or suggest they copy it somewhere.');
        const text = String(inp.text || '').trim().slice(0, 20000);
        if (!text) return err('There is nothing to write.');
        const title = String(inp.title || 'From Lantern').trim().slice(0, 120) || 'From Lantern';
        S.actions.push({ type: 'note', course: pack.id, title, text, mode: inp.mode === 'new' ? 'new' : 'append' });
        return ok({ saved: true, title, mode: inp.mode === 'new' ? 'new' : 'append', shown: 'The note opens in the Notes panel.' });
      }
      case 'search_course': {
        const pack = context.currentPack();
        if (!pack) return ok({ message: 'No course is open.' });
        if (!knowledge.has(pack)) return ok({ message: 'This course has no search index; use lesson_context and lesson_video instead.' });
        const hits = knowledge.search(pack, String(inp.query || ''), { kinds: inp.kinds, limit: 8 });
        return ok(hits.length ? { results: hits } : { results: [], message: 'Nothing in the course matches "' + inp.query + '".' });
      }
      case 'handbook': {
        const pack = context.currentPack();
        const r = knowledge.handbook(pack, { query: inp.query, id: inp.id, page: inp.page });
        if (r.found) {
          const part = inp.part ? String(inp.part).slice(0, 40) : null;
          const items = r.items.slice(0, 3).map((x, i) => ({ id: x.id, equation: x.equation, page: String(x.page), section: x.section, form: x.form, cite: x.cite, part: i === 0 ? part : null }));
          const prev = S.actions.find((a) => a.type === 'handbook');
          if (prev) prev.items = prev.items.concat(items.filter((x) => !prev.items.some((y) => y.id === x.id))).slice(0, 4);
          else S.actions.push({ type: 'handbook', course: pack.id, items });
        }
        return ok(r);
      }
      case 'standard': return ok(knowledge.standard(context.currentPack(), { query: inp.query, id: inp.id }));
      case 'find_videos': {
        const pack = context.currentPack();
        if (!pack) return ok({ message: 'No course is open.' });
        const w = context.where();
        const ref = w.course === pack.id ? w.ref : null;
        const topic = String(inp.topic || '').trim() || (w.title || '');
        const course = knowledge.findVideos(pack, topic, { ref, limit: 5 });
        const outside = catalogue.match(pack, { topic: inp.topic || '', ref, limit: 5 });
        return ok({ course, outside: outside.map((v) => ({ id: v.id, title: v.title, channel: v.channel, site: v.provider === 'khan' ? 'Khan Academy' : 'YouTube', minutes: v.minutes, level: v.level, why: v.why, fits: v.topic })),
          note: catalogue.has(pack) ? 'Outside videos come only from the course\'s checked list. Recommend with show_videos; never write a video link yourself.' : 'This course has no checked list of outside videos.' });
      }
      case 'show_videos': {
        const pack = context.currentPack();
        if (!pack) return err('No course is open.');
        const ids = (Array.isArray(inp.ids) ? inp.ids : []).map(String).slice(0, 3);
        const shown = [], refused = [], outside = [];
        for (const id of ids) {
          const a = courseVideoAction(pack, id, ids.length === 1 ? inp.t : 0);
          if (a) {
            if (ids.length === 1 && Number.isFinite(Number(inp.end)) && Number(inp.end) > a.t) a.end = Math.round(Number(inp.end));
            a.card = newCard(S, { kind: 'video', seconds: knowledge.video(pack, id).seconds || 0 });
            S.actions.push(a); shown.push(a.title + ' (card ' + a.card + ')'); continue;
          }
          const o = catalogue.byId(pack, id);
          if (o) { outside.push(catalogue.card(o)); shown.push(o.title); continue; }
          refused.push(id);
        }
        if (outside.length) S.actions.push({ type: 'outside-videos', course: pack.id, items: outside });
        if (!shown.length) return err('None of those are videos in this course or its checked list: ' + refused.join(', ') + '. Use find_videos for the ids.');
        return ok({ shown, refused: refused.length ? refused : undefined, note: 'They are on screen now as cards; refer to them, do not repeat their links.' });
      }
      case 'my_standing': {
        const pack = context.currentPack();
        if (!pack) return ok({ message: 'No course is open.' });
        const st = context.lastStanding(pack.id);
        const ov = progress.overview(S.uid, pack);
        const rec = review.summary(S.uid, pack.id);
        const lessonFor = (r) => { if (!r || !r.ref) return null; const lt = knowledge.lessonTitle(pack, r.ref); return lt ? { ref: r.ref, title: lt.title, module: lt.unit } : { ref: r.ref }; };
        const vidFor = (r) => { const v = r && knowledge.findVideos(pack, (r.heading || r.title || ''), { ref: r.ref, limit: 1 })[0]; return v ? { id: v.id, title: v.title, chapter: v.chapter } : null; };
        if (!st) return ok({ ranking: null, message: 'The course has not reported their topics yet: they appear once the course page is open and some questions have been answered.', progress: { percent: ov.percent, lessons: ov.lessons }, reviews: rec && rec.runs ? rec : null });
        return ok({
          ranking: st.from || 'the course', asOf: st.at ? new Date(st.at).toISOString().slice(0, 16).replace('T', ' ') : null, live: !!st.live,
          weakest: (st.weak || []).map((r) => Object.assign({}, r, { lesson: lessonFor(r), video: vidFor(r) })),
          strongest: st.strong || [], topicsTried: st.tried,
          progress: { percent: ov.percent, lessons: ov.lessons, read: st.read, videosWatched: st.videosWatched, flashcardsDue: st.cardsDue, bestMock: st.bestMock, checks: st.checks },
          reviews: rec && rec.runs ? { runs: rec.runs, recent: rec.recent } : null,
          how: 'recent: the last answers, oldest first (1 right, 0 wrong, u unsure). Lead with what is going well, then the two or three weakest with their numbers, then one next step.',
        });
      }
      case 'find_visuals': case 'show_figure': case 'show_demo': case 'show_equation': case 'show_passage': case 'draw_figure': case 'draw_derivation': case 'worked_example': case 'law_basis': case 'glossary':
        return teach(name, inp, S);
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

/* The resource finder for a course with a checked list of outside videos:
   its videos come from that list (links, opened in the browser), not from a
   live YouTube search; reading and docs are found as before. */
export async function findResources(pack, d, res, opts) {
  const o = Object.assign({}, opts || {});
  if (!pack || !catalogue.has(pack)) return resources.find(d, res, o);
  const list = (o.providers || (res && res.providers) || ['youtube', 'khan', 'crashcourse', 'wikipedia', 'reddit']).filter((p) => !['youtube', 'crashcourse', 'khan'].includes(p));
  const r = await resources.find(d, res, Object.assign(o, { providers: list }));
  const w = context.where();
  const vids = catalogue.match(pack, { topic: o.topic || (d.item && d.item.title) || '', ref: o.topic ? null : (w.course === pack.id ? w.ref : null), limit: 8 })
    .map((v) => ({ title: v.title, url: v.url, source: v.channel + (v.provider === 'khan' ? '' : ' · YouTube'), type: 'video', provider: v.provider, checked: true, minutes: v.minutes, snippet: v.why || '' }));
  return Object.assign({}, r, { online: vids.concat((r.online || []).filter((x) => x.type !== 'video')) });
}

/* A course video as a card in the chat (assistant.js courseVideoCard): the
   video, where it is shown, and the second to start at. */
const KIND_NAME = { lesson: 'Lesson video', formula: 'Formula explained', example: 'Worked example', calc: 'Calculator how-to' };
export function courseVideoAction(pack, id, at) {
  const v = knowledge.video(pack, id);
  if (!v) return null;
  const lt = v.home ? knowledge.lessonTitle(pack, v.home.ref) : null;
  const t = Number.isFinite(Number(at)) ? Math.max(0, Math.min(v.seconds || 0, Math.round(Number(at)))) : 0;
  const ch = t ? (v.chapters || []).filter((c) => c.t <= t + 0.5).pop() : null;
  return { type: 'course-video', course: pack.id, id: v.id, title: v.title, kind: KIND_NAME[v.kind] || v.kind, minutes: Math.max(1, Math.round((v.seconds || 0) / 60)), captionsOnly: !!v.dry, t, chapter: ch ? ch.title : null,
    home: v.home ? { ref: v.home.ref, title: lt ? lt.title : v.home.ref, module: lt ? lt.unit : v.module, where: v.home.where } : null };
}

/* ---------------------------------------------------- teaching with visuals --- */
export function newCard(S, meta) {
  S.cards = S.cards || {};
  const id = 'c' + (Object.keys(S.cards).length + 1);
  S.cards[id] = meta;
  if (!meta || meta.kind !== 'video') S.visuals = (S.visuals || 0) + 1;
  return id;
}

function teach(name, inp, S) {
  const pack = context.currentPack();
  if (!pack || pack.id !== 'fs' || !teachCourse.available()) return err('Figures, equations and examples are only in the FS course.');
  const push = (kind, payload, meta) => {
    const card = newCard(S, Object.assign({ kind }, meta));
    S.actions.push(Object.assign({ type: 'teach', card, kind, course: pack.id }, payload));
    return card;
  };
  switch (name) {
    case 'find_visuals': return ok(Object.assign(visuals.find(inp.query), { next: 'Show with show_figure / show_demo / show_equation / show_passage; if nothing fits and the question is niche, draw_figure.' }));
    case 'show_figure': case 'show_demo': {
      const r = visuals.figure(inp.id, inp.params && typeof inp.params === 'object' ? inp.params : null, name === 'show_demo');
      if (r.error) return err(r.error);
      const d = r.d;
      const card = push(r.card.kind, r.card, { parts: d.parts.map((p) => p.id), steps: d.steps.length });
      return ok({ card, shown: true, kind: r.card.kind, from: r.card.title, parts: d.parts, steps: d.steps, opening: d.opening || undefined,
        cues: 'Cue it in your reply: [[' + card + ':hl PART]] / [[' + card + ':show PART]] / [[' + card + ':step N]]. Place each cue right where you say that thing.' });
    }
    case 'show_equation': {
      const r = visuals.equation(inp.id);
      if (r.error) return err(r.error);
      const card = push('equation', r.card, { symbols: r.card.symbols });
      return ok(Object.assign({ card, shown: true, cues: 'Emphasise a symbol as you explain it: [[' + card + ':sym T]]. [[' + card + ':open derive]] opens why it has this form.' }, r.out));
    }
    case 'show_passage': {
      const r = visuals.passage(inp.ref, inp.heading);
      if (r.error) return err(r.error);
      const card = push('passage', r.card, {});
      return ok(Object.assign({ card, shown: true }, r.out));
    }
    case 'draw_figure': {
      const v = draw.validateDrawing(inp.spec);
      if (!v.ok) return err('The drawing was refused: ' + v.errors.join(' '));
      const card = push('draw', { title: String(inp.title || '').slice(0, 80), spec: v.spec }, { parts: v.spec.parts, steps: (v.spec.steps || []).length });
      return ok({ card, shown: true, parts: v.spec.parts, steps: (v.spec.steps || []).length, cues: 'Cue it: [[' + card + ':show PART]], [[' + card + ':hl PART]], [[' + card + ':step N]].' });
    }
    case 'draw_derivation': {
      const v = draw.validateDerivation({ steps: inp.steps });
      if (!v.ok) return err('The derivation was refused: ' + v.errors.join(' '));
      const card = push('derive', { title: String(inp.title || '').slice(0, 80), spec: v.spec }, { steps: v.spec.steps.length });
      return ok({ card, shown: true, steps: v.spec.steps.length, cues: 'Cue it: [[' + card + ':step N]] reveals through line N.' });
    }
    case 'worked_example': {
      if (S.graded) return err('This is a check or exam page: do not work examples here.');
      const r = examples.generate({ topic: inp.topic, key: inp.key });
      if (r.error) return err(r.error);
      const card = push('example', r.card, { steps: r.card.steps.length });
      const near = inp.topic ? visuals.find(inp.topic).figures.slice(0, 2) : [];
      return ok(Object.assign({ card, shown: true, cues: 'Walk it with [[' + card + ':step N]] as you say each step.', figures_that_fit: near.length ? near : undefined }, r.out));
    }
    case 'glossary': {
      const r = glossary.lookup(String(inp.term || inp.query || ''));
      return ok(r);
    }
    case 'law_basis': {
      const r = examples.lawBasis(inp.topic);
      if (r.error) return err(r.error);
      return ok(r.out);
    }
    default: return err('No tool called ' + name + '.');
  }
}
