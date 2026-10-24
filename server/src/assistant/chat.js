/* ===========================================================================
   server/src/assistant/chat.js — one turn of talking to Lantern.
   ---------------------------------------------------------------------------
     chat({ text }) → { reply, actions, usage, via }

   1. The built-in commands (skills.js) answer first: hints, progress,
      navigation, the player, the resource finder. Certain and instant.
   2. Otherwise the AI answers, with the tools in tools.js:
        Claude      the Messages API loop here (tool_use, pause_turn), with
                    Claude's own web search
        others      ecosystem-core's chatWithToolsOpenAI (OpenAI, Grok, Ollama)
   3. No AI: skills.js answers from the lesson itself and says what an AI adds.

   The conversation is kept in memory (the last few turns): it is a study
   companion, not a record. The learner's code goes to the AI only on a turn
   where they asked about it (review_code is not even offered otherwise).
   =========================================================================== */

import * as brain from './brain.js';
import * as skills from './skills.js';
import * as tools from './tools.js';
import * as knowledge from './knowledge.js';
import * as context from './context.js';
import * as prompts from './prompts.js';
import * as local from '../platform/local.js';
import * as catalogue from './catalogue.js';
import * as scope from './teach/scope.js';
import * as cues from './teach/cues.js';
import * as teachPack from './teach/pack.js';
import { messagesStream } from './teach/stream.js';

const MAX_ROUNDS = 6;
const KEEP_TURNS = 10;
let history = [];
let lastOnCourse = false;                      // neutral (Anthropic-style) messages
export const clearHistory = () => { history = []; };
export const historyLength = () => history.length;

const ASKS_ABOUT_CODE = /\b(my code|this code|the code|my (answer|solution|attempt)|review|check (it|this|my)|why (is|does|isn't|doesn't|won't|did)\b.*\b(fail|work|pass|wrong|error|break)|what'?s wrong|debug|error|bug|line \d+)/i;

export async function chat(spec, hooks) {
  const s = spec || {};
  const H = hooks || {};
  const t0 = Date.now();
  setImmediate(() => { try { knowledge.warmVideos(context.currentPack()); } catch (e) { /* the index builds on first use instead */ } });   // the video index, ready before find_videos asks
  const timing = { firstAction: null, firstText: null, gate: null };
  const text = String(s.text || '').trim().slice(0, 4000);
  const uid = local.userId();
  const S = { uid, actions: [], cards: {}, allowCode: ASKS_ABOUT_CODE.test(text), codeSent: false, urls: new Set(), emitted: 0 };
  // each visual goes to the page the moment its tool returns
  S.flush = () => { for (; S.emitted < S.actions.length; S.emitted++) { if (timing.firstAction == null) timing.firstAction = Date.now() - t0; if (H.action) H.action(S.actions[S.emitted]); } };
  const onText = (chunk) => { if (timing.firstText == null) timing.firstText = Date.now() - t0; if (H.text) H.text(chunk); };
  if (!text) return { reply: '', actions: [], via: 'empty' };
  // what is on their screen as they ask (null when the course did not answer)
  context.setLook(s.look || null);
  const L = brain.llm();
  const noAI = !L.ready();

  const quick = await skills.handle(text, S, { noAI });
  if (quick) {
    if (quick.clear) clearHistory();
    else if (quick.reply && !quick.silent) remember(text, quick.reply);
    return { reply: quick.reply, actions: (quick.actions || []).concat(S.actions), via: 'skill', hint: quick.hint || null, silent: !!quick.silent };
  }

  const d = context.describe(uid);
  const provider = L.provider();
  const pack = context.currentPack();
  // the course's own teaching (its manifest's teach block); a pack without one gets the generic assistant
  const T = teachPack.of(pack);
  const teach = !!T;
  const sc = teach ? scope.resolve(pack) : null;
  S.graded = !!(d && (/check|exam/i.test(String(d.kind || '')) || (s.look && s.look.question && s.look.question.graded)));
  if (teach) {
    // on the course, or politely redirected: no model, no tools, no visuals for anything else
    const g = await scope.gate(text, { following: lastOnCourse && history.length > 0, course: true, scope: sc, classify: provider === 'anthropic' && L.ready() ? scope.haikuClassifier(L, sc) : null });
    timing.gate = g.ms;
    if (g.verdict !== 'on') {
      const reply = g.verdict === 'injection' ? scope.refusal(pack.title) : scope.redirect(pack.title, sc);
      lastOnCourse = false;
      onText(reply);
      return { reply, actions: [], via: 'scope', scope: g, timing };
    }
    lastOnCourse = true;
  }
  const popts = { teach: T, scope: sc, name: firstName(local.name()), webSearch: provider === 'anthropic' ? true : false };
  const system = prompts.system(d, popts);
  const defs = tools.definitions({ allowCode: S.allowCode, teach: T });
  try {
    const out = provider === 'anthropic'
      ? await claudeLoop({ system: prompts.systemBlocks(d, popts), text, defs, S, L, onText })
      : await L.chatWithToolsOpenAI({ system, history: history.slice(), userText: text, tools: defs, maxRounds: MAX_ROUNDS,
        runTool: async (name, input) => { const r = await tools.dispatch(name, input, S); catalogue.urlsIn(r.content).forEach((u) => S.urls.add(u)); S.flush(); return JSON.parse(r.content); } });
    // No link the model was not given: a video link must be on the course's
    // checked list, any other must have come from a tool or a search this turn.
    for (const c of out.citations || []) S.urls.add(c.url);
    const clean = catalogue.sanitize(out.reply || '', { pack: context.currentPack(), allowed: S.urls });
    const cued = teach ? cues.sanitize(clean.text, S.cards) : { text: clean.text, removed: 0, kept: 0 };
    const reply = cued.text || 'Done.';
    if (provider !== 'anthropic' && reply) onText(reply);
    S.flush();
    remember(text, reply);
    return { reply, actions: S.actions, via: provider, usage: out.usage || null, citations: out.citations || [], codeSent: S.codeSent, unlinked: clean.removed || 0, timing: Object.assign(timing, { total: Date.now() - t0 }), cues: { kept: cued.kept, removed: cued.removed } };
  } catch (e) {
    const why = e.status === 401 ? 'The AI key was not accepted: it may have expired or been turned off. Paste a new one in Settings, Assistant.' : e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message) ? 'The AI took too long to answer.' : /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(e.message) ? 'I could not reach the AI. The computer may be offline.' : 'The AI had a problem: ' + e.message;
    const fallback = await skills.handle(text, S, { noAI: true, afterError: true }).catch(() => null);
    return { reply: why + (fallback && fallback.reply ? ' ' + fallback.reply : ''), actions: S.actions.concat((fallback && fallback.actions) || []), via: 'error', error: e.message };
  }
}

function remember(user, reply) {
  history.push({ role: 'user', content: user }, { role: 'assistant', content: reply });
  if (history.length > KEEP_TURNS * 2) history = history.slice(-KEEP_TURNS * 2);
}
const firstName = (n) => String(n || '').split(' ')[0] || '';

/* Claude: the Messages API with our tools and its own web search. */
async function claudeLoop({ system, text, defs, S, L, onText }) {
  const key = brain.aiConfig().keys.anthropic;
  const messages = history.map((m) => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: text }]);
  const toolList = defs.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    .concat([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
  // the tools and the stable part of the system prompt are the same turn after
  // turn: cached, so rounds 2–6 and the next question read them for a tenth
  toolList[toolList.length - 1] = Object.assign({}, toolList[toolList.length - 1], { cache_control: { type: 'ephemeral' } });
  let reply = '';
  const usage = { input_tokens: 0, output_tokens: 0 };
  const citations = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = { max_tokens: 1200, system, messages, tools: toolList };
    const r = onText && key ? await messagesStream(L, brain.fetcher(), key, body, { timeoutMs: 60000, onText: (t) => onText(t) }) : await L.messages(body, { timeoutMs: 60000 });
    usage.input_tokens += (r.usage && r.usage.input_tokens) || 0;
    usage.output_tokens += (r.usage && r.usage.output_tokens) || 0;
    const content = r.content || [];
    for (const b of content) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const x of b.content) if (x && x.url) S.urls.add(x.url);
      if (b.type === 'text' && b.text) reply += (reply ? '\n' : '') + b.text;
      for (const c of b.citations || []) if (c.url && !citations.some((x) => x.url === c.url)) citations.push({ url: c.url, title: c.title || c.url });
    }
    messages.push({ role: 'assistant', content });
    if (r.stop_reason === 'pause_turn') continue;
    if (r.stop_reason !== 'tool_use') break;
    const calls = content.filter((b) => b.type === 'tool_use');
    if (!calls.length) break;
    const results = [];
    for (const c of calls) {
      const out = await tools.dispatch(c.name, c.input || {}, S);
      catalogue.urlsIn(out.content).forEach((u) => S.urls.add(u));
      S.flush();
      results.push({ type: 'tool_result', tool_use_id: c.id, content: prompts.fence('tool_result', out.content), is_error: out.isError || undefined });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: reply.trim(), usage, citations };
}
