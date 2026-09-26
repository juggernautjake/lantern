/* ===========================================================================
   server/src/assistant/brain.js — which AI answers, and which voice speaks.
   ---------------------------------------------------------------------------
   THE AI. Claude (recommended), ChatGPT, Grok, or a free local model through
   Ollama — through ecosystem-core's createLLM(), which uses fetch only. The
   key comes from, in order:

     1 the shared AI key (%LOCALAPPDATA%\Ecosystem\credentials.bin), when the
       person said yes to "Use the AI key from Dayspring?" — or set it up here
       (a key entered in Lantern is saved there, encrypted for this Windows user)
     2 environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY,
       AI_PROVIDER, AI_MODEL, OLLAMA_URL), e.g. in <data>/lantern.env
     3 none: the assistant still works, with its built-in commands

   On systems without Windows' key protection, a key entered here goes into
   <data>/lantern.env instead (readable only by this user's account).

   THE VOICE. ecosystem-core's createVoice({ app: "lantern" }): ElevenLabs Will
   when an ElevenLabs key is shared, else OpenAI "ash" when chosen, else the
   browser's own voices (Edge's Andrew, Brian or Guy first), picked in the page.
   =========================================================================== */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLLM, PROVIDERS } from '../../../vendor/ecosystem-core/lib/llm.mjs';
import { createVoice } from '../../../vendor/ecosystem-core/lib/voice.mjs';
import * as credentials from '../platform/credentials.js';
import * as settings from '../platform/settings.js';
import { dataDir, paths } from '../platform/config.js';

export { PROVIDERS };

/* ------------------------------------------------------- the shared key --- */

/* Reading the shared file asks Windows to unlock it (a short PowerShell call),
   so what it says is kept for a few minutes rather than asked every message. */
let sharedCache = { at: 0, ai: null, peek: null };
const SHARED_TTL = 5 * 60000;
export function shared(force) {
  if (!force && Date.now() - sharedCache.at < SHARED_TTL) return sharedCache;
  let ai = null, peek = { exists: false };
  try { peek = credentials.lantern.peek(); } catch (e) { peek = { exists: false, error: e.message }; }
  if (peek.exists && peek.allowed) { try { ai = credentials.lantern.read(); } catch (e) { ai = null; } }
  sharedCache = { at: Date.now(), ai, peek };
  return sharedCache;
}
export const forgetShared = () => { sharedCache = { at: 0, ai: null, peek: null }; };

/* ------------------------------------------------------------ the config --- */

export const aiSettings = () => settings.get('assistant.ai', {}) || {};

export function aiConfig() {
  const env = process.env;
  const s = aiSettings();
  const sh = s.useShared === false ? null : shared().ai;
  const keys = {
    anthropic: (sh && sh.keys.anthropic) || env.ANTHROPIC_API_KEY || '',
    openai: (sh && sh.keys.openai) || env.OPENAI_API_KEY || '',
    xai: (sh && sh.keys.xai) || env.XAI_API_KEY || '',
  };
  let provider = String(s.provider || (sh && sh.provider !== 'none' && sh.provider) || env.AI_PROVIDER || '').toLowerCase();
  if (!PROVIDERS[provider]) provider = keys.anthropic ? 'anthropic' : keys.openai ? 'openai' : keys.xai ? 'xai' : 'none';
  return {
    provider, keys,
    model: s.model || (sh && sh.provider === provider && sh.model) || env.AI_MODEL || '',
    ollamaUrl: s.ollamaUrl || (sh && sh.ollamaUrl) || env.OLLAMA_URL || '',
    bases: { anthropic: env.ANTHROPIC_BASE_URL || '', openai: env.OPENAI_BASE_URL || '', xai: env.XAI_BASE_URL || '' },
    source: sh && provider === sh.provider ? 'shared' : (keys[provider] || provider === 'ollama') ? 'lantern' : 'none',
  };
}

let fetchImpl = null;
export function useFetch(f) { fetchImpl = f; llmInst = null; voiceInst = null; }   // tests
const f = (...a) => (fetchImpl || globalThis.fetch)(...a);

let llmInst = null;
export function llm() { return llmInst || (llmInst = createLLM({ getConfig: aiConfig, fetch: f })); }

/* What the settings page shows: never a key. */
export function aiStatus() {
  const c = aiConfig();
  const L = llm();
  const sh = shared();
  return {
    ready: L.ready(), provider: c.provider, model: L.modelName(), label: L.label(), source: c.source,
    canSearchWeb: L.canSearchWeb(), hasKey: { anthropic: !!c.keys.anthropic, openai: !!c.keys.openai, xai: !!c.keys.xai },
    shared: sh.peek || { exists: false }, useShared: aiSettings().useShared !== false,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, keyUrl: p.keyUrl, defaultModel: p.defaultModel, needsKey: !!p.keyName }])),
    recommended: 'anthropic',
  };
}

/* Save the person's choice, and a key if they typed one. The key goes into
   the shared encrypted file (Windows) or <data>/lantern.env (elsewhere); it is
   never stored in the database, never logged and never returned. */
export async function saveAI(b) {
  const body = b || {};
  const provider = String(body.provider || '').toLowerCase();
  if (provider && !PROVIDERS[provider] && provider !== 'none') throw Object.assign(new Error('Choose Claude, ChatGPT, Grok or Ollama.'), { status: 400 });
  const next = Object.assign({}, aiSettings());
  if (provider) next.provider = provider === 'none' ? '' : provider;
  if (body.model !== undefined) next.model = String(body.model || '').slice(0, 80);
  if (body.ollamaUrl !== undefined) next.ollamaUrl = String(body.ollamaUrl || '').slice(0, 200);
  if (body.useShared !== undefined) next.useShared = !!body.useShared;
  settings.set('assistant.ai', next);
  const key = String(body.key || '').trim();
  if (key) {
    const p = provider && PROVIDERS[provider] ? provider : aiConfig().provider;
    const name = PROVIDERS[p] && PROVIDERS[p].keyName;
    if (!name) throw Object.assign(new Error('That AI does not use a key.'), { status: 400 });
    if (key.length < 16 || /\s/.test(key)) throw Object.assign(new Error('That does not look like a key. Copy it again from the provider’s page.'), { status: 400 });
    if (credentials.supported()) {
      credentials.lantern.write({ provider: p, model: next.model || '', keys: { [name]: key } });
      next.useShared = true;
      settings.set('assistant.ai', next);
    } else {
      saveEnvKey(PROVIDERS[p].keyVar, key);
    }
  }
  if (body.voiceKey && String(body.voiceKey).trim()) {
    const vk = String(body.voiceKey).trim();
    const vname = body.voiceProvider === 'openai' ? 'openai' : 'elevenlabs';
    if (credentials.supported()) credentials.lantern.write({ provider: aiConfig().provider, model: next.model || '', keys: { [vname]: vk } });
    else saveEnvKey(vname === 'openai' ? 'OPENAI_API_KEY' : 'ELEVENLABS_API_KEY', vk);
  }
  forgetShared(); llmInst = null; voiceInst = null;
  return aiStatus();
}

function saveEnvKey(name, value) {
  const file = paths.env();
  mkdirSync(dataDir(), { recursive: true });
  let lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith(name + '=')) : [];
  lines = lines.filter(Boolean).concat([name + '=' + value]);
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  process.env[name] = value;
}

/* Try a provider without saving anything (the Test button). */
export async function testAI(b) {
  const body = b || {};
  const p = String(body.provider || aiConfig().provider);
  return llm().test(p, body.key ? String(body.key).trim() : undefined, body.model || undefined);
}

/* -------------------------------------------------------------- the voice --- */

export const voiceSettings = () => Object.assign({ provider: 'auto', timeTone: false }, settings.get('assistant.voice', {}) || {});
export function voiceConfig() {
  const v = voiceSettings();
  const sh = shared().ai;
  const keys = { elevenlabs: (sh && sh.keys.elevenlabs) || process.env.ELEVENLABS_API_KEY || '', openai: (sh && sh.keys.openai) || process.env.OPENAI_API_KEY || '' };
  const provider = v.provider === 'auto' ? (keys.elevenlabs ? 'elevenlabs' : 'browser') : v.provider;
  return { provider, keys, elevenModel: process.env.ELEVENLABS_MODEL || '' };
}
let voiceInst = null;
export function voice() {
  return voiceInst || (voiceInst = createVoice({
    app: 'lantern',
    getSettings: () => voiceSettings(),
    setSettings: (patch) => settings.set('assistant.voice', Object.assign({}, voiceSettings(), patch)),
    getConfig: voiceConfig,
    cacheDir: join(dataDir(), 'assistant', 'voice-cache'),
    pronounce: [[/\bCFML\b/g, 'C F M L'], [/\bCFC\b/g, 'C F C'], [/\bSQL\b/g, 'sequel']],
    fetch: f,
  }));
}
export function saveVoice(b) {
  const body = b || {};
  const cur = voiceSettings();
  const next = Object.assign({}, cur);
  if (body.provider) { if (['auto', 'browser', 'elevenlabs', 'openai'].indexOf(body.provider) < 0) throw Object.assign(new Error('Unknown voice provider.'), { status: 400 }); next.provider = body.provider; }
  if (body.browserVoice !== undefined) next.browserVoice = String(body.browserVoice || '').slice(0, 120);
  if (body.speedAdj !== undefined) next.speedAdj = Math.max(-0.3, Math.min(0.3, Number(body.speedAdj) || 0));
  if (body.rate !== undefined) next.rate = Math.max(0.6, Math.min(1.6, Number(body.rate) || 1));
  settings.set('assistant.voice', next);
  voiceInst = null;
  if (body.voice) voice().setVoice(body.voice);
  return voiceStatus();
}
export function voiceStatus() {
  const v = voice();
  return Object.assign({ settings: voiceSettings(), choices: v.voiceChoices(), describe: v.describeFor(), defaults: v.defaults(), chain: v.chain }, v.voiceReady());
}
