/* ===========================================================================
   server/src/assistant/skills.js — the things Lantern does without an AI.
   ---------------------------------------------------------------------------
   Quick, certain commands are answered here first, AI or not: they are
   faster, they cost nothing, and a hint from here is exactly the course's
   own words. Everything else goes to the AI — or, with no AI set up, gets a
   friendly answer from the lesson itself and a note on what an AI would add.

     stop · pause/resume/next/previous · louder/quieter      the player and the voice
     play some focus music · play <anything> on YouTube      the mini player
     give me a hint                                          the course's next hint
     what's next · how far am I                              progress
     open unit 3 · open lesson 2 · open the next lesson      navigation
     find me a video (about …) · resources for this          the resource finder
     clear the chat
   and, only when there is no AI:
     explain this lesson · why is my code failing · look up … / what is …
   =========================================================================== */

import * as context from './context.js';
import * as resources from './resources.js';
import * as progress from '../platform/progress.js';
import { openTarget, gradeHere } from './tools.js';

const clean = (t) => String(t || '').toLowerCase().replace(/[’']/g, "'").replace(/[.!?,]+$/g, '').replace(/^(hey |ok |okay |hi )?(lantern[,]?\s+)?/, '').replace(/^(please |can you |could you |would you )+/, '').replace(/ please$/, '').trim();


/* { reply, actions, spoken? } or null when it is not one of these. */
export async function handle(text, S, opts) {
  const o = opts || {};
  const q = clean(text);
  if (!q) return null;
  let m;

  // the voice and the player
  if (/^(stop|stop talking|quiet|be quiet|shh+|hush|that's enough|enough|cancel|never ?mind)$/.test(q)) return { reply: '', actions: [{ type: 'stop' }], silent: true };
  if (/^(pop (it|this|that|the video) out|pop out( the video)?|open (it|this|that|the video) (in|on) (my |the )?browser)$/.test(q)) return { reply: 'Opening it in your browser.', actions: [{ type: 'media', action: 'popout' }] };
  if (/^(pause|pause (the )?(music|video|song|it))$/.test(q)) return { reply: 'Paused.', actions: [{ type: 'media', action: 'pause' }] };
  if (/^(resume|unpause|keep playing|play again|continue playing|resume (the )?(music|video))$/.test(q)) return { reply: 'Playing.', actions: [{ type: 'media', action: 'resume' }] };
  if (/^(next|skip|skip (it|this)|next (song|video|track))$/.test(q)) return { reply: 'Next one.', actions: [{ type: 'media', action: 'next' }] };
  if (/^(previous|go back|back|previous (song|video|track)|last (song|video))$/.test(q)) return { reply: 'Going back.', actions: [{ type: 'media', action: 'previous' }] };
  if (/^(stop|turn off|close) (the )?(music|video|player|song)$/.test(q)) return { reply: 'Stopped.', actions: [{ type: 'media', action: 'stop' }] };
  if (/^(louder|turn it up|volume up|turn (the )?(music|video|volume) up)$/.test(q)) return { reply: 'Louder.', actions: [{ type: 'media', action: 'louder' }] };
  if (/^(quieter|softer|turn it down|volume down|turn (the )?(music|video|volume) down)$/.test(q)) return { reply: 'Quieter.', actions: [{ type: 'media', action: 'quieter' }] };
  if (/^(clear|reset|start over|forget) (the |our |this )?(chat|conversation)$/.test(q)) return { reply: 'All clear. What shall we look at?', actions: [{ type: 'clear' }], clear: true };

  // music and videos
  if ((m = /^(?:play|put on|start)(?: me)?(?: some| a little)? ?(focus|study|lo-?fi|chill|calm|relaxing|classical|jazz|piano|ambient)? (?:music|beats|songs|tunes|playlist)(?: for (?:studying|focus|focusing))?$/.exec(q))) {
    return play(m[1] || 'focus', S, 'music');
  }
  if ((m = /^play (.{2,120}?)(?: on youtube)?$/.exec(q)) && !/^(it|again)$/.test(m[1])) return play(m[1], S, isMusic(m[1]) ? 'music' : 'video');

  // hints
  if (/\b(hint|clue|nudge)\b/.test(q) && !/\bno (more )?hints?\b/.test(q)) {
    const pack = context.currentPack();
    if (!pack) return { reply: 'Open a course first, and I can give you its hints one at a time.' };
    const h = context.nextHint(S.uid, pack);
    if (h.none) return { reply: h.message, hint: h };
    return { reply: 'Hint ' + h.n + ' of ' + h.of + ', ' + h.rung + ': ' + h.hint, hint: h };
  }

  // progress
  if (/^(what'?s|what is) next\b|^next lesson$|what should i (do|study|learn) next|where (was i|did i leave off)/.test(q)) {
    const pack = context.currentPack();
    if (!pack) return { reply: 'You have no courses yet. When someone sends you one, it appears on the Courses page.' };
    const ov = progress.overview(S.uid, pack);
    const n = ov.next;
    if (!n) return { reply: 'You have finished everything in ' + pack.title + '. Well done!' };
    return { reply: whereNext(ov) + ' Want me to open it?', actions: [{ type: 'suggest', course: pack.id, ref: n.id, title: n.title }] };
  }
  if (/how far (am i|have i got|along)|my progress|how am i doing|how much (have i done|is left)|how many lessons (are )?left|percent/.test(q)) {
    const pack = context.currentPack();
    if (!pack) return { reply: 'You have no courses yet.' };
    const ov = progress.overview(S.uid, pack);
    return { reply: 'You are ' + ov.percent + '% through ' + pack.title + ': ' + progress.measure(ov) + ' done, about ' + mins(ov.minutesLeft) + ' left.' + (ov.next ? ' ' + whereNext(ov) : '') };
  }

  // navigation
  if ((m = /^(?:open|go to|take me to|show me|start|jump to|bring up) (?:the )?((?:unit|module|chapter) \d+(?:,? lesson \d+)?|lesson \d+|overview|course overview|next(?: lesson| one)?|where i left off)$/.exec(q))) {
    const out = openTarget(S, m[1].replace(/^course /, ''));
    return { reply: out.opened ? 'Opening ' + out.title + '.' : out.message, actions: S.actions.splice(0) };
  }

  // resources
  if ((m = /\b(?:find|show|get|recommend|give)(?: me)? (?:a |an |some |more |good |other )*(?:videos?|articles?|resources?|tutorials?|reading|links?|material)(?: (?:about|on|for|explaining) (.{2,100}))?$/.exec(q)) || /^resources( for this( lesson)?)?$/.test(q)) {
    const topic = m && m[1] && !/^(this|it|that|this lesson|the lesson|this topic)$/.test(m[1]) ? m[1] : null;
    const pack = context.currentPack();
    const d = context.describe(S.uid);
    const r = await resources.find(d, pack ? context.resourcesOf(pack) : null, { topic });
    const vids = r.online.filter((x) => x.type === 'video').length;
    const reply = r.message ? r.message : (r.online.length ? 'Here is what I found about ' + r.topic + ': ' + vids + ' video' + (vids === 1 ? '' : 's') + ' and ' + (r.online.length - vids) + ' things to read.' : 'I did not find anything new about ' + r.topic + '. The docs are on the right.');
    return { reply, actions: [{ type: 'resources', topic: r.topic, offline: r.offline, online: r.online, message: r.message || null, fromCache: !!r.fromCache }] };
  }

  if (!o.noAI) return null;

  // ------ without an AI: answer from the lesson itself ------
  if (/^(help|what can you do|how do (i|you) use you|commands)$/.test(q)) return { reply: HELP };
  if (/\b(explain|teach me|what('?s| is) this (lesson )?about|summari[sz]e)\b/.test(q)) {
    const d = context.describe(S.uid);
    if (!d.item) return { reply: 'Open a lesson and I will tell you what it covers.' };
    const it = d.item;
    const parts = [it.title + '.'];
    if (it.objectives && it.objectives.length) parts.push('By the end you should be able to: ' + it.objectives.slice(0, 4).join('; ') + '.');
    if (it.takeaways && it.takeaways.length) parts.push('The key points: ' + it.takeaways.slice(0, 4).join(' ') );
    parts.push('With an AI set up in Settings, I can explain it in my own words and answer questions.');
    return { reply: parts.join(' ') };
  }
  if (/why (is|does|isn't|doesn't|won't) (my|this|the) code|what'?s wrong with (my|this) code|(check|review|look at) my code|why (is|did) it fail/.test(q)) {
    const pack = context.currentPack();
    const item = pack && context.currentItem(S.uid, pack);
    if (!item) return { reply: 'Open the exercise you are working on, and run it: the checks under the editor say what is missing.' };
    const code = context.learnerCode(S.uid, pack, item.id);
    const g = gradeHere(item.id, code);
    if (g && g.checks) {
      if (g.checks.passed) return { reply: 'Your code for ' + item.title + ' passes every check. Nice work.' };
      const f = g.checks.error ? 'It stops with an error on line ' + g.checks.error.line + ': ' + g.checks.error.message + '.' : 'The checks that fail say: ' + g.checks.failing.slice(0, 3).join(' Also: ');
      return { reply: f + ' Want a hint?' };
    }
    return { reply: 'Run your code with the Check button: the messages under the editor say exactly which check fails. If you are stuck, ask me for a hint.' };
  }
  if ((m = /^(?:look up|search (?:for|the web for)?|google|what (?:is|are|was|were)|who (?:is|was|were)|tell me about) (.{2,120})$/.exec(q))) {
    try {
      const r = await resources.generalWeb().search(m[1], { max: 4 });
      if (!r.results.length) return { reply: 'I could not find anything for that. The computer may be offline.' };
      const top = r.results[0];
      return { reply: (top.snippet || top.title) + ' (from ' + host(top.url) + ')', actions: [{ type: 'links', title: 'About ' + m[1], items: r.results.map((x) => ({ title: x.title, url: x.url, snippet: x.snippet, source: host(x.url) })) }] };
    } catch (e) { return { reply: 'I could not search just now. The computer may be offline.' }; }
  }
  if (/^(hi|hello|hey|good (morning|afternoon|evening))$/.test(q)) return { reply: 'Hello! I am Lantern. Ask me for a hint, what is next, or some focus music.' };
  return { reply: 'Without an AI set up, I can do the built-in things: hints, what is next, how far you are, opening lessons, finding videos and playing music. To chat about anything, add an AI in Settings, Assistant. Claude is recommended.' };
}

/* "You're on Loops over queries; next up: Arrays." — "next" is what comes
   AFTER where the learner is, not the first thing they skipped. */
function whereNext(ov) {
  const cur = ov.current, n = ov.next;
  if (!n) return '';
  if (cur && cur.id !== n.id && !isDoneIn(ov, cur.id)) return 'You are on ' + cur.title + '; next up: ' + n.title + '.';
  return 'Next up in ' + ov.title + ': ' + n.title + '.';
}
function isDoneIn(ov, id) {
  for (const u of ov.units) {
    for (const l of u.lessons) if (l.id === id) return l.status === 'done';
    for (const p of u.projects) if (p.id === id) return p.status === 'done';
    if (u.check && u.check.id === id) return u.check.status === 'done';
  }
  return false;
}

const HELP = 'Here is what I can do. "Give me a hint". "What is next?" "How far am I?" "Open unit 3". "Find me a video about this". "Play some focus music". "Pause", "next", "louder". With an AI set up, you can also ask me anything about the lesson, have me review your code, and look things up.';

export const isMusic = (w) => /\b(music|songs?|beats|playlist|album|lo-?fi|radio|jazz|piano|classical|ambient|soundtrack|band|singer)\b/i.test(String(w || ''));
async function play(what, S, kind) {
  const list = await resources.playable(what).catch(() => []);
  if (!list.length) return { reply: 'I could not find anything to play just now. The computer may be offline.' };
  return { reply: 'Playing ' + list[0].title + '.', actions: [{ type: 'play', queue: list.map((v) => ({ videoId: v.videoId, title: v.title, source: v.source, thumbnail: v.thumbnail })), index: 0, kind: kind || 'video' }] };
}
const mins = (m) => { m = Math.round(m || 0); if (m < 60) return m + ' minutes'; const h = Math.floor(m / 60); const r = m % 60; return h + ' hour' + (h === 1 ? '' : 's') + (r ? ' ' + r + ' minutes' : ''); };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return 'the web'; } };
export { clean };
