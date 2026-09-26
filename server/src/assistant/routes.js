/* ===========================================================================
   server/src/assistant/routes.js — the assistant's endpoints.
   ---------------------------------------------------------------------------
     GET  /api/assistant              everything the panel needs to start: the AI
                                      (never a key), the voice, who has the mic,
                                      the person's assistant settings
     POST /api/assistant/chat         { text } → { reply, actions, via }
     POST /api/assistant/tts          { text } → audio/mpeg, or 204 = "the page
                                      speaks with the browser's own voice"
     GET|PUT /api/assistant/voice     the voice: provider, which voice, speed
     GET|PUT /api/assistant/ai        the AI: provider, model, a key (saved
                                      encrypted, never returned); POST …/ai/test
     GET|PUT /api/assistant/prefs     appearance, wake word, dock, sound levels
     POST /api/assistant/here         the page open in the player (from the shell)
     POST /api/assistant/speaking     { on } → tells other apps (only one talks)
     GET  /api/assistant/mic          may Lantern listen for its wake word now?
     POST /api/assistant/resources    { topic?, refresh? } → the resource finder
     POST /api/assistant/play         { query } → YouTube results to play
     GET  /api/assistant/context      what the assistant knows about "this"
   =========================================================================== */

import * as brain from './brain.js';
import * as chatMod from './chat.js';
import * as context from './context.js';
import * as resources from './resources.js';
import * as settings from '../platform/settings.js';
import * as eco from '../platform/eco.js';
import * as bus from '../platform/bus.js';
import * as engine from '../platform/sync/engine.js';
import * as local from '../platform/local.js';
import * as packs from '../platform/packs.js';
import { allIds } from '../platform/progress.js';

export const PREF_DEFAULTS = {
  enabled: true,
  dock: 'right',                 // 'right' | 'left' | 'bottom' | 'hidden'
  wakeWord: 'Lantern',
  wakeOn: true,
  speakReplies: true,
  avatar: { preset: 'classic', flameInner: null, flameOuter: null, glassTint: null, glowColor: null, metal: null, glowIntensity: null, glowRadius: null, flicker: null, size: 150, rays: true, embers: true, reducedMotion: 'auto' },
  levels: { master: 80, voice: 90, sounds: 70, music: 60, video: 70 },
  display: { uiScale: 100, textScale: 100, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 },
};
export function prefs() {
  const p = settings.get('assistant.prefs', {}) || {};
  return Object.assign({}, PREF_DEFAULTS, p, {
    avatar: Object.assign({}, PREF_DEFAULTS.avatar, p.avatar || {}),
    levels: Object.assign({}, PREF_DEFAULTS.levels, p.levels || {}),
    display: Object.assign({}, PREF_DEFAULTS.display, p.display || {}),
  });
}
const PRESETS = ['classic', 'candle', 'moonlight', 'emerald', 'rose', 'aurora'];
const METALS = ['brass', 'iron', 'silver', 'copper'];
const hex = (v) => (v === null || v === undefined || v === '' ? null : /^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : undefined);
const num = (v, lo, hi) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : undefined);
export function savePrefs(b) {
  const body = b || {};
  const cur = prefs();
  const next = JSON.parse(JSON.stringify(cur));
  if (body.enabled !== undefined) next.enabled = !!body.enabled;
  if (body.dock !== undefined && ['right', 'left', 'bottom', 'hidden'].indexOf(body.dock) >= 0) next.dock = body.dock;
  if (body.wakeWord !== undefined) { const w = String(body.wakeWord || '').trim().replace(/[^\p{L}\p{N}' -]/gu, '').slice(0, 30); next.wakeWord = w || 'Lantern'; }
  if (body.wakeOn !== undefined) next.wakeOn = !!body.wakeOn;
  if (body.speakReplies !== undefined) next.speakReplies = !!body.speakReplies;
  if (body.avatar) {
    const a = body.avatar;
    if (a.preset !== undefined && PRESETS.indexOf(a.preset) >= 0) next.avatar = Object.assign({}, PREF_DEFAULTS.avatar, { preset: a.preset, size: next.avatar.size, rays: next.avatar.rays, embers: next.avatar.embers, reducedMotion: next.avatar.reducedMotion });
    for (const k of ['flameInner', 'flameOuter', 'glassTint', 'glowColor']) if (a[k] !== undefined && hex(a[k]) !== undefined) next.avatar[k] = hex(a[k]);
    if (a.metal !== undefined && (a.metal === null || METALS.indexOf(a.metal) >= 0)) next.avatar.metal = a.metal;
    const ranges = { glowIntensity: [0, 2], glowRadius: [0.4, 2], flicker: [0, 1], size: [80, 320] };
    for (const [k, [lo, hi]] of Object.entries(ranges)) if (a[k] !== undefined && num(a[k], lo, hi) !== undefined) next.avatar[k] = num(a[k], lo, hi);
    for (const k of ['rays', 'embers']) if (a[k] !== undefined) next.avatar[k] = !!a[k];
    if (a.reducedMotion !== undefined && ['auto', true, false].indexOf(a.reducedMotion) >= 0) next.avatar.reducedMotion = a.reducedMotion;
  }
  if (body.levels) for (const k of Object.keys(PREF_DEFAULTS.levels)) if (body.levels[k] !== undefined && num(body.levels[k], 0, 100) !== undefined) next.levels[k] = Math.round(num(body.levels[k], 0, 100));
  if (body.display) {
    const r = { uiScale: [70, 160], textScale: [70, 180], marginTop: [0, 15], marginBottom: [0, 15], marginLeft: [0, 15], marginRight: [0, 15] };
    for (const [k, [lo, hi]] of Object.entries(r)) if (body.display[k] !== undefined && num(body.display[k], lo, hi) !== undefined) next.display[k] = num(body.display[k], lo, hi);
  }
  if (body.reset === 'avatar') next.avatar = Object.assign({}, PREF_DEFAULTS.avatar);
  if (body.reset === 'display') next.display = Object.assign({}, PREF_DEFAULTS.display);
  settings.set('assistant.prefs', next);
  bus.emit('assistant-prefs', { prefs: next });
  return next;
}

async function dayspringRunning() { try { return !!(await eco.peer('dayspring')); } catch (e) { return false; } }

export function register(r) {
  r.get('/api/assistant', async () => {
    const ds = await dayspringRunning();
    return { body: { ai: brain.aiStatus(), voice: brain.voiceStatus(), mic: eco.micState(ds), dayspring: ds, quiet: eco.quietState(), prefs: prefs(), name: local.name() } };
  });
  r.get('/api/assistant/context', async () => ({ body: context.describe(local.userId()) }));

  r.post('/api/assistant/chat', async ({ body }) => ({ body: await chatMod.chat({ text: body && body.text }) }));

  r.post('/api/assistant/tts', async ({ body, send }) => {
    const text = String((body && body.text) || '').slice(0, 2500);
    if (!text.trim()) return { status: 400, body: { error: 'Nothing to say.' } };
    try {
      const buf = await brain.voice().tts(text, { voice: body && body.voice ? String(body.voice) : undefined });
      send(200, buf, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
    } catch (e) {
      if (e.status === 204) return { status: 204, body: null };
      return { status: e.status && e.status >= 400 ? e.status : 502, body: { error: e.message, fallback: 'browser' } };
    }
  }, { maxBody: 64 * 1024 });

  r.get('/api/assistant/voice', async () => { await brain.voice().loadLibrary().catch(() => {}); return { body: brain.voiceStatus() }; });
  r.put('/api/assistant/voice', async ({ body }) => ({ body: brain.saveVoice(body) }));

  r.get('/api/assistant/ai', async () => ({ body: brain.aiStatus() }));
  r.put('/api/assistant/ai', async ({ body }) => ({ body: await brain.saveAI(body) }));
  r.post('/api/assistant/ai/test', async ({ body }) => ({ body: await brain.testAI(body) }));
  r.get('/api/assistant/ai/models', async ({ query }) => ({ body: { models: await brain.llm().models(query.provider || undefined) } }));

  r.get('/api/assistant/prefs', async () => ({ body: prefs() }));
  r.put('/api/assistant/prefs', async ({ body }) => ({ body: savePrefs(body) }));

  r.post('/api/assistant/here', async ({ body }) => {
    const b = body || {};
    const h = context.setHere({ course: b.course, ref: b.ref, kind: b.kind, title: b.title });
    // The owner's "studying now" follows real lessons only (not the course's
    // start page, its settings or the overview): saving progress sets it too.
    const pack = h.course && packs.get(h.course);
    if (pack && h.ref && allIds(pack.manifest).has(h.ref)) engine.setActivity({ course: h.course, lesson: h.ref, status: 'studying' });
    return { body: h };
  });

  // Only one app talks at a time: tell the others when Lantern starts and stops.
  r.post('/api/assistant/speaking', async ({ body }) => {
    const on = !!(body && body.on);
    eco.send(on ? 'speaking.start' : 'speaking.stop', { app: 'lantern' }).catch(() => {});
    return { body: { quiet: eco.quietState() } };
  });

  r.get('/api/assistant/mic', async () => ({ body: eco.micState(await dayspringRunning()) }));

  r.post('/api/assistant/resources', async ({ body }) => {
    const b = body || {};
    const pack = context.currentPack(b.course);
    const d = context.describe(local.userId(), b.course, b.ref);
    return { body: await resources.find(d, pack ? context.resourcesOf(pack) : null, { topic: b.topic || null, refresh: !!b.refresh }) };
  });
  r.post('/api/assistant/play', async ({ body }) => {
    const list = await resources.playable(String((body && body.query) || 'focus')).catch(() => []);
    return { body: { queue: list.map((v) => ({ videoId: v.videoId, title: v.title, source: v.source, thumbnail: v.thumbnail })) } };
  });
}
