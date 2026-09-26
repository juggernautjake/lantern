// ecosystem-core/client/audio-chain.js — how the apps' pages make sound: one Web Audio graph with a level for each
// kind of sound, a clearer voice, a small bright room for chimes, and media that ducks under the voice.
//
//   import { createAudio } from ".../audio-chain.js";
//   const audio = createAudio({ levels: { master: 80, voice: 90, sounds: 70, alarm: 100, music: 60, video: 70 } });
//   await audio.resume()                        (after a click: browsers start audio only after the user does something)
//   audio.playVoice(audioElement)               a reply: through the voice EQ, the voice level and the analyser
//   audio.sfx(ctx => …) / audio.alarm(ctx => …) synth code writes into the chimes (or alarm) input
//   audio.setLevel("music", 40) · audio.level("voice") · audio.mute("sounds") · audio.analyser (for the avatar/orb)
//   audio.media.add({ kind: "music" | "video", setVolume(0..1) })   YouTube/Spotify players: follow their level and duck
//   audio.duck(true|false)                     media glides down under the voice (to 14%) and back up after
//   audio.chain("notify")                      a second, separate chain (e.g. announcements that always play on both outputs)
//
// Chains: voice → high-pass (85 Hz) → presence (+2.5 dB @ 3.2 kHz) → air (+1.5 dB shelf @ 9 kHz) ─┐
//         chimes, alarm ─→ room (1.2 s) + light stereo echo ────────────────────────────────────┼→ compressor → master → speakers

export const CHANNELS = [
  // key, icon, name, hint, minimum (the alarm can't be silenced below 30)
  ["voice", "🗣", "Voice", "replies and announcements", 0],
  ["sounds", "🔔", "Chimes", "reminders and sound effects", 0],
  ["alarm", "⏰", "Alarm", "the wake-up alarm", 30],
  ["music", "🎵", "Music", "Spotify and other music", 0],
  ["video", "🎬", "Videos", "YouTube and other videos", 0],
];

export function createAudio({ levels = {}, onLevel = null, duckTo = 0.14 } = {}) {
  const L = { master: 80, voice: 90, sounds: 70, alarm: 100, music: 60, video: 70, ...levels };
  const muted = {};
  let ctx = null, analyser = null;
  const chains = {};
  const media = new Set();
  let ducked = false, duckK = 1, duckTimer = 0;

  const gainOf = (k) => { const min = CHANNELS.find((c) => c[0] === k)?.[4] ?? 0; const v = muted[k] ? min : Math.max(min, L[k] ?? 0); return (v / 100) ** 1.6; };   // a gentle curve: the slider feels even

  function makeChain(name) {
    const c = { name };
    c.comp = ctx.createDynamicsCompressor();
    c.comp.threshold.value = -18; c.comp.knee.value = 12; c.comp.ratio.value = 3.5; c.comp.attack.value = 0.004; c.comp.release.value = 0.22;
    c.master = ctx.createGain(); c.master.gain.value = gainOf("master");
    c.comp.connect(c.master).connect(ctx.destination);
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 85;
    const pres = ctx.createBiquadFilter(); pres.type = "peaking"; pres.frequency.value = 3200; pres.Q.value = 0.9; pres.gain.value = 2.5;
    const air = ctx.createBiquadFilter(); air.type = "highshelf"; air.frequency.value = 9000; air.gain.value = 1.5;
    c.voice = ctx.createGain(); c.voice.gain.value = 1.1;
    c.voiceLvl = ctx.createGain(); c.voiceLvl.gain.value = gainOf("voice");
    c.voice.connect(c.voiceLvl).connect(hp).connect(pres).connect(air); air.connect(c.comp); air.connect(analyser);
    // a small, bright room so bells ring instead of beep, and a light stereo echo
    const len = ctx.sampleRate * 1.2, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    const verb = ctx.createConvolver(); verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.16;
    const dl = ctx.createDelay(1), dr = ctx.createDelay(1), fb = ctx.createGain(), el = ctx.createGain(), lp = ctx.createBiquadFilter();
    dl.delayTime.value = 0.27; dr.delayTime.value = 0.41; fb.gain.value = 0.15; el.gain.value = 0.07; lp.type = "lowpass"; lp.frequency.value = 5000;
    const merge = ctx.createChannelMerger(2);
    c.bites = ctx.createGain();
    c.bites.connect(c.comp); c.bites.connect(verb); verb.connect(wet).connect(c.comp);
    c.sfx = ctx.createGain(); c.sfx.gain.value = gainOf("sounds"); c.sfx.connect(c.bites);
    c.alarmIn = ctx.createGain(); c.alarmIn.gain.value = gainOf("alarm"); c.alarmIn.connect(c.bites);
    c.bites.connect(el); el.connect(lp); lp.connect(dl); dl.connect(dr); dr.connect(fb); fb.connect(dl);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(c.comp);
    return c;
  }
  function context() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.8;
    chains.general = makeChain("general");
    return ctx;
  }
  const chain = (name = "general") => { context(); return (chains[name] ??= makeChain(name)); };

  function apply() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const c of Object.values(chains)) {
      c.master.gain.setTargetAtTime(gainOf("master"), now, 0.08);
      c.voiceLvl.gain.setTargetAtTime(gainOf("voice"), now, 0.08);
      c.sfx.gain.setTargetAtTime(gainOf("sounds"), now, 0.08);
      c.alarmIn.gain.setTargetAtTime(gainOf("alarm"), now, 0.08);
    }
  }
  const mediaVolume = (kind) => { const v = muted[kind] ? 0 : (L[kind] ?? 0) / 100; return v * (L.master / 100) * duckK; };
  function applyMedia() { for (const m of media) { try { m.setVolume(mediaVolume(m.kind)); } catch { /* player gone */ } } }

  function setLevel(k, v) {
    const min = CHANNELS.find((c) => c[0] === k)?.[4] ?? 0;
    L[k] = Math.max(min, Math.min(100, Math.round(Number(v) || 0)));
    if (L[k] > min) delete muted[k];
    apply(); applyMedia(); onLevel?.(k, L[k]);
    return L[k];
  }
  function mute(k, on = !muted[k]) { if (on) muted[k] = true; else delete muted[k]; apply(); applyMedia(); onLevel?.(k, on ? 0 : L[k]); return Boolean(muted[k]); }

  // A reply's audio: <audio> element → voice chain (only once per element)
  const wired = new WeakSet();
  function playVoice(el, name = "general") {
    const c = chain(name);
    if (!wired.has(el)) { ctx.createMediaElementSource(el).connect(c.voice); wired.add(el); }
    return el.play();
  }
  // Synth code for chimes (or the alarm): fn(ctx, input) → connect your nodes to input
  const sfx = (fn, name = "general") => { const c = chain(name); return fn(ctx, c.sfx); };
  const alarm = (fn, name = "general") => { const c = chain(name); return fn(ctx, c.alarmIn); };

  // media glides down under the voice and back up after
  function duck(on) {
    if (ducked === on) return;
    ducked = on; clearInterval(duckTimer);
    const goal = on ? duckTo : 1;
    duckTimer = setInterval(() => {
      duckK += (goal - duckK) * 0.35;
      if (Math.abs(goal - duckK) < 0.02) { duckK = goal; clearInterval(duckTimer); }
      applyMedia();
    }, 60);
  }

  // a short test chime: two soft bell notes through the chimes level
  function testChime(name = "general") {
    return sfx((c, input) => { [784, 1046.5].forEach((f, i) => { const o = c.createOscillator(), e = c.createGain(); o.frequency.value = f; const t = c.currentTime + i * 0.14; e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(0.5, t + 0.01); e.gain.exponentialRampToValueAtTime(0.0001, t + 0.9); o.connect(e).connect(input); o.start(t); o.stop(t + 1); }); }, name);
  }

  return {
    CHANNELS, context, chain, resume: () => context().resume(),
    get analyser() { context(); return analyser; },
    level: (k) => L[k], levels: () => ({ ...L }), isMuted: (k) => Boolean(muted[k]), setLevel, mute,
    playVoice, sfx, alarm, testChime, duck, isDucked: () => ducked,
    media: { add(m) { media.add(m); try { m.setVolume(mediaVolume(m.kind)); } catch { /* not ready */ } return () => media.delete(m); }, volume: mediaVolume },
  };
}

if (typeof window !== "undefined") { window.EcoCore = window.EcoCore ?? {}; window.EcoCore.audio = { createAudio, CHANNELS }; }
