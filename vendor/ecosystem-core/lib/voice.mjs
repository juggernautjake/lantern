// Text to speech for either app. Three providers:
//   browser    free: the page speaks with the voices built into the browser (Edge has natural "Online (Natural)" voices).
//              tts() throws { status: 204 } and the page speaks by itself (pickBrowserVoice picks the default voice).
//   elevenlabs natural, expressive voices (an ElevenLabs key; a free tier exists)
//   openai     OpenAI's voices (an OpenAI key)
// Default: ElevenLabs when its key is set, otherwise the free browser voices.
//
//   const voice = createVoice({
//     app: "dayspring" | "lantern",                         // picks the default voice chain (shared/voices-defaults.mjs)
//     getSettings: () => ({ voice, voiceId, openaiVoice, speedAdj, timeTone, browserVoice }),
//     setSettings: (patch) => {},                            // optional: remembers a voice picked by name
//     getConfig: () => ({ provider, keys: { elevenlabs, openai }, elevenModel, openaiTtsModel }),
//     cacheDir: "…",                                         // optional: audio cached on disk too (phrases said often)
//     pronounce: [[/\bSQL\b/g, "S Q L"]],            // optional: words to say differently
//   })
// How it sounds can follow the time of day (soothing early, bright mid-morning, upbeat afternoon, warm evening).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAINS, defaultsFor } from "../shared/voices-defaults.mjs";

// OpenAI's voices (gpt-4o-mini-tts)
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
export const OPENAI_DESCRIBE = { Alloy: "neutral and balanced", Ash: "clear and direct", Ballad: "soft and melodic", Coral: "warm and friendly", Echo: "calm and even", Fable: "expressive storyteller",
  Nova: "bright and upbeat", Onyx: "deep and steady", Sage: "calm and wise", Shimmer: "light and gentle", Verse: "lively and versatile" };
// ElevenLabs' built-in voices: any ElevenLabs key can speak with these (a key may not be allowed to list voices).
export const VOICES = {
  Brian: "nPczCjzI2devNBz1zQrb", George: "JBFqnCBsd6RMkjVDRZzb", Eric: "cjVigY5qzO86Huf0OWal", Chris: "iP95p4xoKVk53GoZ742B",
  Daniel: "onwK4e9ZLuTAKqWW03F9", Sarah: "EXAVITQu4vr4xnSDxMaL", Jessica: "cgSgspJ2msm6clMCkdW9", Matilda: "XrExE9yKIg1WjnnlVkGX",
  Liam: "TX3LPaxmHKxFdv7VOQHJ", Will: "bIHbv24MWmeRgasZH58o", Alice: "Xb7hH8MSUJpSbSDYk0k2", Lily: "pFZP5JQG7iQjIQuC4Bku",
  Rachel: "21m00Tcm4TlvDq8ikWAM", Roger: "CwhRBWXzGAHq8TQ4Fs17", Charlotte: "XB0fDUnXU5powFXDhCwa", Callum: "N2lVS1w4EtoT3dr4eOWO",
};
export const DESCRIBE = { Brian: "deep and calm", George: "warm and British", Eric: "smooth", Chris: "casual", Daniel: "British and steady", Sarah: "soft", Jessica: "bright and expressive", Matilda: "warm", Liam: "young and clear", Will: "friendly and relaxed", Alice: "confident and British", Lily: "gentle and British", Rachel: "calm and clear", Roger: "laid-back and easy", Charlotte: "soft and a little smoky", Callum: "husky and intense" };

export const TONES = {
  soothing: { speed: 0.88, stability: 0.72, style: 0.05 },
  bright: { speed: 1.0, stability: 0.52, style: 0.2 },
  chipper: { speed: 1.05, stability: 0.4, style: 0.35 },
  warm: { speed: 0.97, stability: 0.58, style: 0.18 },
};
const OPENAI_TONE = { soothing: "Speak softly, slowly and warmly.", bright: "Speak clearly and brightly.", chipper: "Speak with upbeat energy.", warm: "Speak warmly and relaxed." };

export function toneAt(d = new Date(), timeTone = true) {
  if (!timeTone) return "bright";
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 8.5) return "soothing";
  if (h < 12) return "bright";
  if (h < 18) return "chipper";
  if (h < 21) return "warm";
  return "soothing";
}

export function speakable(text, pronounce = []) {
  let s = String(text).replace(/\*\*|__|`|#+\s/g, "").replace(/(\d{1,2}):00\s?(am|pm)/gi, "$1 $2").replace(/→/g, ", ");
  for (const [re, say] of pronounce) s = s.replace(re, () => say);
  return s.slice(0, 2500);
}

const err = (message, status) => Object.assign(new Error(message), { status });

export function createVoice({ app = "dayspring", getSettings = () => ({}), setSettings = null, getConfig = () => ({}), cacheDir = null, pronounce = [], fetch: f = globalThis.fetch, maxCache = 60 } = {}) {
  const chain = CHAINS[app] ?? CHAINS.dayspring;
  const def = defaultsFor(app);
  const S = () => getSettings() ?? {};
  const C = () => { const c = getConfig() ?? {}; return { ...c, keys: { ...(c.keys ?? {}) } }; };
  const elevenKey = () => String(C().keys.elevenlabs ?? "");
  const openaiKey = () => String(C().keys.openai ?? "");
  const elevenModel = () => C().elevenModel || "eleven_turbo_v2_5";

  function ttsProvider() {
    const p = String(C().provider ?? "").toLowerCase();
    if (["browser", "elevenlabs", "openai"].includes(p)) return p;
    return elevenKey() ? "elevenlabs" : "browser";
  }

  // The user's own ElevenLabs voice library (custom, cloned, added), when their key may list it.
  let library = { at: 0, voices: {} };
  async function loadLibrary({ force = false } = {}) {
    if (!elevenKey() || (!force && Date.now() - library.at < 3600_000)) return library.voices;
    library.at = Date.now();
    try {
      const r = await f("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": elevenKey() }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return library.voices;                          // some keys may only speak, not list
      const j = await r.json();
      library.voices = Object.fromEntries((j.voices ?? []).map((v) => [String(v.name).split(/[ -]/)[0], { id: v.voice_id, describe: [v.labels?.description, v.labels?.accent, v.labels?.gender].filter(Boolean).join(", ") || v.category }]));
    } catch { /* offline: the built-in list still works */ }
    return library.voices;
  }
  const allEleven = () => ({ ...VOICES, ...Object.fromEntries(Object.entries(library.voices).map(([n, v]) => [n, v.id])) });
  const voiceId = () => { const s = S(), all = allEleven(); return s.voiceId || (s.voice && all[s.voice]) || def.elevenId; };
  const openaiVoice = () => { const v = String(S().openaiVoice ?? "").toLowerCase(); return OPENAI_VOICES.includes(v) ? v : chain.openai.find((x) => OPENAI_VOICES.includes(x)) ?? "coral"; };
  const toneNow = (d = new Date()) => toneAt(d, S().timeTone !== false);

  function voiceReady() {
    const p = ttsProvider();
    if (p === "browser") return { ready: true, provider: p, voiceName: S().browserVoice || `the browser's ${chain.gender} voice`, tone: toneNow() };
    if (p === "openai") return { ready: Boolean(openaiKey()), provider: p, voiceName: openaiVoice(), tone: toneNow() };
    const all = allEleven(), id = voiceId();
    return { ready: Boolean(elevenKey()), provider: p, voiceId: id, voiceName: Object.keys(all).find((k) => all[k] === id) ?? S().voice ?? "custom", model: elevenModel(), tone: toneNow() };
  }
  // The voices the user can pick from right now (the browser's own list comes from the page itself)
  function voiceChoices() {
    const p = ttsProvider();
    if (p === "openai") return OPENAI_VOICES.map((n) => n.charAt(0).toUpperCase() + n.slice(1));
    if (p === "elevenlabs") return [...new Set([...Object.keys(library.voices), ...Object.keys(VOICES)])];
    return [];
  }
  const describeFor = (p = ttsProvider()) => (p === "openai" ? OPENAI_DESCRIBE : p === "elevenlabs" ? { ...DESCRIBE, ...Object.fromEntries(Object.entries(library.voices).map(([n, v]) => [n, v.describe])) } : {});
  function setVoice(name) {
    const p = ttsProvider();
    if (p === "openai") { const v = String(name).toLowerCase(); if (!OPENAI_VOICES.includes(v)) throw new Error(`unknown voice ${name}`); setSettings?.({ openaiVoice: v }); return voiceReady(); }
    const all = allEleven();
    const v = Object.keys(all).find((k) => k.toLowerCase() === String(name).toLowerCase() || all[k] === name);
    if (!v) throw new Error(`unknown voice ${name}`);
    setSettings?.({ voice: v, voiceId: all[v] });
    return voiceReady();
  }
  function nextVoice() { const names = Object.keys(VOICES), cur = voiceReady().voiceName; return names[(names.indexOf(cur) + 1) % names.length]; }

  // audio cache: memory, plus disk when cacheDir is given
  const mem = new Map();
  const cacheGet = (k) => {
    if (mem.has(k)) return mem.get(k);
    if (cacheDir) { const p = join(cacheDir, k + ".mp3"); if (existsSync(p)) { const b = readFileSync(p); mem.set(k, b); return b; } }
    return null;
  };
  const cachePut = (k, buf) => {
    mem.set(k, buf); if (mem.size > maxCache) mem.delete(mem.keys().next().value);
    if (cacheDir) { try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(join(cacheDir, k + ".mp3"), buf); } catch { /* cache only */ } }
  };

  async function tts(text, opts = {}) {
    const p = ttsProvider();
    if (p === "browser") throw err("browser voice", 204);          // the page speaks for itself
    const s = S();
    const tone = TONES[opts.tone] ?? TONES[toneNow()];
    const speed = Math.max(0.7, Math.min(1.2, (Number(opts.speed) || tone.speed) + (s.speedAdj ?? 0)));
    const say = speakable(text, pronounce);
    if (p === "openai") {
      if (!openaiKey()) throw err("There's no OpenAI key for the voice.", 503);
      const v = opts.voice ? String(opts.voice).toLowerCase() : openaiVoice();
      const k = createHash("sha1").update(["openai", v, speed.toFixed(2), say].join("|")).digest("hex");
      const hit = cacheGet(k); if (hit) return hit;
      const r = await f("https://api.openai.com/v1/audio/speech", {
        method: "POST", headers: { authorization: `Bearer ${openaiKey()}`, "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ model: C().openaiTtsModel || "gpt-4o-mini-tts", voice: OPENAI_VOICES.includes(v) ? v : openaiVoice(), input: say, speed, response_format: "mp3", instructions: OPENAI_TONE[opts.tone ?? toneNow()] }),
      });
      if (!r.ok) throw err(`OpenAI voice ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`, 502);
      const buf = Buffer.from(await r.arrayBuffer()); cachePut(k, buf); return buf;
    }
    if (!elevenKey()) throw err("There's no ElevenLabs key for the voice.", 503);
    const vid = (opts.voice && allEleven()[opts.voice]) || voiceId();
    const k = createHash("sha1").update([vid, speed.toFixed(2), tone.stability, tone.style, say].join("|")).digest("hex");
    const hit = cacheGet(k); if (hit) return hit;
    const r = await f(`https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": elevenKey(), "content-type": "application/json", accept: "audio/mpeg" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ text: say, model_id: elevenModel(), voice_settings: { stability: tone.stability, similarity_boost: 0.75, style: tone.style, use_speaker_boost: true, speed } }),
    });
    if (!r.ok) throw err(`ElevenLabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`, 502);
    const buf = Buffer.from(await r.arrayBuffer()); cachePut(k, buf); return buf;
  }

  return { app, chain, defaults: () => def, ttsProvider, voiceReady, voiceChoices, describeFor, loadLibrary, setVoice, nextVoice, tts, toneNow, speakable: (t) => speakable(t, pronounce), VOICES, OPENAI_VOICES };
}
