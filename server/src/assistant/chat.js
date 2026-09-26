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
import * as context from './context.js';
import * as prompts from './prompts.js';
import * as local from '../platform/local.js';

const MAX_ROUNDS = 6;
const KEEP_TURNS = 10;
let history = [];                      // neutral (Anthropic-style) messages
export const clearHistory = () => { history = []; };
export const historyLength = () => history.length;

const ASKS_ABOUT_CODE = /\b(my code|this code|the code|my (answer|solution|attempt)|review|check (it|this|my)|why (is|does|isn't|doesn't|won't|did)\b.*\b(fail|work|pass|wrong|error|break)|what'?s wrong|debug|error|bug|line \d+)/i;

export async function chat(spec) {
  const s = spec || {};
  const text = String(s.text || '').trim().slice(0, 4000);
  const uid = local.userId();
  const S = { uid, actions: [], allowCode: ASKS_ABOUT_CODE.test(text), codeSent: false };
  if (!text) return { reply: '', actions: [], via: 'empty' };
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
  const system = prompts.system(d, { name: firstName(local.name()), webSearch: provider === 'anthropic' ? true : false });
  const defs = tools.definitions({ allowCode: S.allowCode });
  try {
    const out = provider === 'anthropic'
      ? await claudeLoop({ system, text, defs, S, L })
      : await L.chatWithToolsOpenAI({ system, history: history.slice(), userText: text, tools: defs, maxRounds: MAX_ROUNDS,
        runTool: async (name, input) => { const r = await tools.dispatch(name, input, S); return JSON.parse(r.content); } });
    const reply = out.reply || 'Done.';
    remember(text, reply);
    return { reply, actions: S.actions, via: provider, usage: out.usage || null, citations: out.citations || [], codeSent: S.codeSent };
  } catch (e) {
    const why = e.status === 401 ? 'The AI key was not accepted. Check it in Settings, Assistant.' : e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message) ? 'The AI took too long to answer.' : /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(e.message) ? 'I could not reach the AI. The computer may be offline.' : 'The AI had a problem: ' + e.message;
    const fallback = await skills.handle(text, S, { noAI: true }).catch(() => null);
    return { reply: why + (fallback && fallback.reply ? ' ' + fallback.reply : ''), actions: S.actions.concat((fallback && fallback.actions) || []), via: 'error', error: e.message };
  }
}

function remember(user, reply) {
  history.push({ role: 'user', content: user }, { role: 'assistant', content: reply });
  if (history.length > KEEP_TURNS * 2) history = history.slice(-KEEP_TURNS * 2);
}
const firstName = (n) => String(n || '').split(' ')[0] || '';

/* Claude: the Messages API with our tools and its own web search. */
async function claudeLoop({ system, text, defs, S, L }) {
  const messages = history.map((m) => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: text }]);
  const toolList = defs.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    .concat([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
  let reply = '';
  const usage = { input_tokens: 0, output_tokens: 0 };
  const citations = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = { max_tokens: 1200, system, messages, tools: toolList };
    const r = await L.messages(body, { timeoutMs: 60000 });
    usage.input_tokens += (r.usage && r.usage.input_tokens) || 0;
    usage.output_tokens += (r.usage && r.usage.output_tokens) || 0;
    const content = r.content || [];
    for (const b of content) {
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
      results.push({ type: 'tool_result', tool_use_id: c.id, content: prompts.fence('tool_result', out.content), is_error: out.isError || undefined });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: reply.trim(), usage, citations };
}
