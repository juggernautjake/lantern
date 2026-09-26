// ecosystem-core/client/voice-orb.js — Dayspring's face: a living ring and glassy orb.
//
//   import { mount, MOODS } from ".../voice-orb.js";           (or window.EcoCore.voiceOrb.mount)
//   const orb = mount(document.querySelector("#orb"), { size: 280, mood: "calm" });
//   orb.setState("off" | "idle" | "listen" | "think" | "speak")
//   orb.setMood("calm" | "soothing" | "bright" | "chipper" | "warm" | "playful" | "serious" | "spar" | "devil" | "celebrate" | "night")
//   orb.setLevel(0..1)        the voice (or, while listening, the room)  ·  orb.setAnalyser(analyserNode)
//   orb.stats() · orb.destroy()
//
//   idle: it breathes and drifts · listen: mint waves draw in and the ring follows the room · think: arcs orbit faster
//   speak: bars and the ring move with the voice. Every mood change glides (colours, shape, pace).

export const MOODS = {
  calm:      { a: 228, b: 268, sat: 85, speed: 1.0, wobble: 0.07, lobes: 3, spike: 0,   spark: 1.0, glow: 1.0,  label: "" },
  soothing:  { a: 188, b: 252, sat: 68, speed: 0.5, wobble: 0.09, lobes: 2, spike: 0,   spark: 0.6, glow: 0.85, label: "soothing" },
  bright:    { a: 200, b: 280, sat: 90, speed: 1.2, wobble: 0.09, lobes: 4, spike: 0,   spark: 1.3, glow: 1.1,  label: "bright" },
  chipper:   { a: 182, b: 318, sat: 95, speed: 1.6, wobble: 0.13, lobes: 5, spike: 0,   spark: 1.7, glow: 1.2,  label: "chipper" },
  warm:      { a: 28,  b: 332, sat: 82, speed: 0.8, wobble: 0.09, lobes: 3, spike: 0,   spark: 0.9, glow: 0.95, label: "warm" },
  playful:   { a: 300, b: 165, sat: 92, speed: 1.9, wobble: 0.22, lobes: 6, spike: 0,   spark: 1.8, glow: 1.15, label: "playful" },
  serious:   { a: 234, b: 252, sat: 42, speed: 0.4, wobble: 0.025, lobes: 2, spike: 0,  spark: 0.25, glow: 0.75, label: "serious" },
  spar:      { a: 16,  b: 348, sat: 96, speed: 1.4, wobble: 0.1,  lobes: 7, spike: 1,   spark: 1.2, glow: 1.15, label: "sparring" },
  devil:     { a: 356, b: 282, sat: 90, speed: 1.2, wobble: 0.12, lobes: 5, spike: 0.7, spark: 1.0, glow: 1.05, label: "devil's advocate" },
  celebrate: { a: 44,  b: 305, sat: 100, speed: 1.9, wobble: 0.14, lobes: 5, spike: 0,  spark: 2.6, glow: 1.3,  label: "celebrating" },
  night:     { a: 236, b: 262, sat: 38, speed: 0.35, wobble: 0.05, lobes: 2, spike: 0,  spark: 0.3, glow: 0.45, label: "night" },
};
const WORDS = { off: "resting", idle: "ready", listen: "listening", think: "thinking", speak: "speaking" };
const lerp = (a, b, k) => a + (b - a) * k;
const lerpHue = (a, b, k) => { const d = ((b - a + 540) % 360) - 180; return (a + d * k + 360) % 360; };

export function mount(host, { size = 0, mood = "calm", label = "Voice assistant", reducedMotion = "auto" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "eco-orb"; wrap.setAttribute("role", "img");
  wrap.style.cssText = "position:relative;display:inline-block;line-height:0;" + (size ? `width:${size}px;height:${size}px;` : "width:100%;height:100%;");
  const viz = document.createElement("canvas"); viz.style.cssText = "width:100%;height:100%;display:block"; viz.setAttribute("aria-hidden", "true");
  const live = document.createElement("span"); live.setAttribute("aria-live", "polite"); live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)";
  wrap.append(viz); host.append(wrap, live);     // the live region sits beside the image
  const vx = viz.getContext("2d");
  let stageMode = "idle", level = 0, target = 0, raf = 0, lastFrame = 0, analyser = null, destroyed = false, frames = 0;
  const M = { ...(MOODS[mood] ?? MOODS.calm) }; let goal = MOODS[mood] ?? MOODS.calm;
  const freq = new Uint8Array(256), wave = new Uint8Array(512);
  const SPARKS = Array.from({ length: 70 }, (_, i) => ({ a: (i / 70) * Math.PI * 2, r: 0.25 + Math.random() * 0.5, s: 0.2 + Math.random() * 0.8, z: Math.random(), on: Math.random() }));
  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const reduced = () => (reducedMotion === "auto" ? Boolean(mq?.matches) : Boolean(reducedMotion));
  const setLabel = () => wrap.setAttribute("aria-label", `${label}: ${WORDS[stageMode] ?? stageMode}`);

  function fit() {
    const r = wrap.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round((r.width || size || 240) * dpr), h = Math.round((r.height || size || 240) * dpr);
    if (viz.width !== w || viz.height !== h) { viz.width = w; viz.height = h; }
  }
  function glide() { const k = 0.035; M.a = lerpHue(M.a, goal.a, k); M.b = lerpHue(M.b, goal.b, k); for (const p of ["sat", "speed", "wobble", "lobes", "spike", "spark", "glow"]) M[p] = lerp(M[p], goal[p], k); }
  function blob(cx, cy, R, t, phase, amp, voice) {
    vx.beginPath();
    const n = 180, sp = M.speed;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      let s = Math.sin(a * Math.round(M.lobes) + t * 0.0009 * sp + phase) * 0.5 + Math.sin(a * (Math.round(M.lobes) + 2) - t * 0.0013 * sp + phase * 1.7) * 0.3 + Math.sin(a * 2 + t * 0.0005 * sp + phase * 0.6) * 0.2;
      s *= M.wobble * amp;
      if (M.spike > 0.02) s += Math.pow(Math.abs(Math.sin(a * Math.round(M.lobes) * 1.5 + t * 0.002 * sp + phase)), 8) * M.spike * (0.06 + level * 0.25);
      if (voice) s += ((wave[(i * 3) % 512] - 128) / 128) * 0.2;
      const r = R * (1 + s), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? vx.lineTo(x, y) : vx.moveTo(x, y);
    }
    vx.closePath();
  }
  function draw(t) {
    raf = 0; if (destroyed) return;
    const slow = stageMode === "off" || stageMode === "idle" || reduced();
    if (slow && t - lastFrame < 33) { raf = requestAnimationFrame(draw); return; }
    lastFrame = t; frames++;
    fit(); glide();
    if (reduced()) t = 0;
    // drawn at the size of the smaller side, centred, so it stays round in any box
    const W = Math.min(viz.width, viz.height), cx = viz.width / 2, cy = viz.height / 2;
    vx.clearRect(0, 0, viz.width, viz.height);
    const live = analyser && stageMode === "speak";
    if (live) { analyser.getByteFrequencyData(freq); analyser.getByteTimeDomainData(wave); }
    else {
      const room = stageMode === "listen" ? target : 0;
      for (let i = 0; i < 256; i++) freq[i] = stageMode === "speak" ? 60 + 170 * target * (0.6 + 0.4 * Math.sin(t / 130 + i / 5))
        : stageMode === "think" ? 60 + 40 * Math.sin(t / 90 + i) : stageMode === "listen" ? 40 + room * 180 * (0.6 + 0.4 * Math.sin(t / 70 + i / 3)) : 22 + 14 * Math.sin(t / 900 + i / 7);
      wave.fill(128);
    }
    let avg = 0; for (let i = 2; i < 60; i++) avg += freq[i]; avg /= 58 * 255;
    level += (avg - level) * 0.22;
    const breathe = 1 + Math.sin(t / (1800 / Math.max(0.3, M.speed))) * 0.025;
    const R = W * 0.19 * breathe * (1 + level * 0.18);
    const A = M.a, B = M.b, S = M.sat, G = stageMode === "off" ? M.glow * 0.45 : M.glow;
    const halo = vx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 2.5);
    halo.addColorStop(0, `hsla(${A},${S}%,62%,${(0.2 + level * 0.45) * G})`); halo.addColorStop(0.55, `hsla(${B},${S}%,52%,${(0.07 + level * 0.15) * G})`); halo.addColorStop(1, `hsla(${B},${S}%,40%,0)`);
    vx.fillStyle = halo; vx.beginPath(); vx.arc(cx, cy, R * 2.5, 0, Math.PI * 2); vx.fill();
    vx.save(); vx.translate(cx, cy); vx.rotate(t / (26000 / M.speed));
    for (let i = 0; i < 72; i++) {
      const v = freq[(i * 5) % 100 + 3] / 255, a = (i / 72) * Math.PI * 2;
      const r1 = R * 1.72, r2 = r1 + W * (i % 6 === 0 ? 0.022 : 0.009) + v * W * 0.035 * (stageMode === "speak" ? 1 : 0.3);
      vx.strokeStyle = `hsla(${i % 6 === 0 ? A : B},${S}%,78%,${(0.16 + v * 0.5) * G})`; vx.lineWidth = W / (i % 6 === 0 ? 300 : 520);
      vx.beginPath(); vx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); vx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); vx.stroke();
    }
    vx.restore();
    const spin = stageMode === "think" ? 3.2 : 1;
    [[1.42, 0.9, 0.55, A], [1.55, -0.65, 0.35, B], [1.3, 0.45, 0.22, (A + 40) % 360]].forEach(([rr, dir, len, h], k) => {
      const a0 = (t / 2600) * dir * M.speed * spin + k * 2.1;
      vx.strokeStyle = `hsla(${h},${S}%,74%,${(stageMode === "think" ? 0.85 : 0.4) * G})`; vx.lineWidth = W / (k === 0 ? 170 : 260); vx.lineCap = "round";
      vx.beginPath(); vx.arc(cx, cy, R * rr, a0, a0 + Math.PI * len); vx.stroke();
    });
    if (stageMode === "listen") {
      const room = target;
      for (let k = 0; k < 3; k++) {
        const ph = ((t / 1400) + k / 3) % 1, rr = R * (2.3 - ph * 1.15);
        vx.strokeStyle = `hsla(${155 + k * 12},85%,72%,${Math.sin(ph * Math.PI) * (0.35 + room * 0.5)})`; vx.lineWidth = W / (230 - room * 90);
        vx.beginPath(); vx.arc(cx, cy, rr, 0, Math.PI * 2); vx.stroke();
      }
    }
    if (stageMode === "speak" || stageMode === "listen") {
      const N = 120;
      for (let i = 0; i < N; i++) {
        const half = i < N / 2 ? i : N - 1 - i;
        const v = freq[(half * 7) % 90 + 3] / 255 * (stageMode === "listen" ? 0.6 : 1);
        const a = (i / N) * Math.PI * 2 - Math.PI / 2 + t / 9000;
        const r1 = R * 1.13, r2 = r1 + W * 0.008 + v * W * 0.15;
        const g = vx.createLinearGradient(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        g.addColorStop(0, `hsla(${A + v * 40},${S}%,70%,${0.3 + v * 0.6})`); g.addColorStop(1, `hsla(${B},${S}%,75%,0)`);
        vx.strokeStyle = g; vx.lineWidth = W / 210;
        vx.beginPath(); vx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); vx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); vx.stroke();
      }
    }
    for (let k = 2; k >= 0; k--) {
      blob(cx, cy, R * (1.04 + k * 0.07), t, k * 1.9, 1 + k * 0.6, live && k === 0);
      vx.strokeStyle = `hsla(${lerpHue(A, B, k / 2)},${S}%,${80 - k * 8}%,${(0.62 - k * 0.17 + level * 0.3) * G})`;
      vx.lineWidth = W / (k === 0 ? 260 : 420);
      if (k === 0) { vx.shadowColor = `hsla(${A},${S}%,70%,.9)`; vx.shadowBlur = 16 * G; }
      vx.stroke(); vx.shadowBlur = 0;
    }
    const nS = Math.round(SPARKS.length * Math.min(1, M.spark / 2.6));
    for (let i = 0; i < nS; i++) {
      const s = SPARKS[i];
      if (!reduced()) s.a += 0.0016 * s.s * M.speed * (1 + level * 4);
      const r = R * (1.55 + s.r * (1 + level)), x = cx + Math.cos(s.a) * r, y = cy + Math.sin(s.a) * r * 0.92;
      const tw = 0.5 + 0.5 * Math.sin(t / 400 + s.on * 20);
      vx.fillStyle = `hsla(${lerpHue(A, B, s.z)},${S}%,82%,${(0.2 + s.z * 0.5) * tw * G})`;
      vx.beginPath(); vx.arc(x, y, W / 480 + s.z * W / 340, 0, Math.PI * 2); vx.fill();
    }
    const rc = R * (0.9 + level * 0.1);
    blob(cx, cy, rc, t * 0.7, 4.2, 0.5, false);
    const core = vx.createRadialGradient(cx - rc * 0.35, cy - rc * 0.4, rc * 0.05, cx, cy, rc * 1.05);
    core.addColorStop(0, `hsl(${A - 25},100%,${88 * Math.min(1, 0.7 + G * 0.3)}%)`); core.addColorStop(0.35, `hsl(${A},${S}%,${60 * G}%)`); core.addColorStop(0.75, `hsl(${B},${S * 0.85}%,${38 * G}%)`); core.addColorStop(1, `hsl(${B + 10},${S * 0.8}%,16%)`);
    vx.fillStyle = core; vx.fill();
    vx.save(); blob(cx, cy, rc, t * 0.7, 4.2, 0.5, false); vx.clip();
    for (let k = 0; k < 3; k++) {
      const a = t / ((2600 + k * 700) / M.speed) + k * 2.1;
      const px = cx + Math.cos(a) * rc * 0.45, py = cy + Math.sin(a) * rc * 0.45;
      const g = vx.createRadialGradient(px, py, 0, px, py, rc * 0.7);
      g.addColorStop(0, `hsla(${(A + 40 + k * 25) % 360},95%,75%,${(0.16 + level * 0.3) * G})`); g.addColorStop(1, "hsla(0,0%,0%,0)");
      vx.fillStyle = g; vx.fillRect(cx - rc * 1.3, cy - rc * 1.3, rc * 2.6, rc * 2.6);
    }
    vx.restore();
    raf = requestAnimationFrame(draw);
  }
  const onVis = () => { if (document.visibilityState === "hidden") { cancelAnimationFrame(raf); raf = 0; } else if (!raf) raf = requestAnimationFrame(draw); };
  document.addEventListener("visibilitychange", onVis);
  setLabel(); raf = requestAnimationFrame(draw);
  const api = {
    el: wrap, canvas: viz, MOODS,
    setState(s) { if (!WORDS[s] || s === stageMode) return api; stageMode = s; setLabel(); live.textContent = `${label} is ${WORDS[s]}`; return api; },
    getState: () => stageMode,
    setMood(name) { if (MOODS[name]) goal = MOODS[name]; return api; },
    setLevel(v) { target = Math.max(0, Math.min(1, Number(v) || 0)); return api; },
    setAnalyser(node) { analyser = node ?? null; return api; },
    stats: () => ({ frames, running: Boolean(raf), state: stageMode }),
    destroy() { destroyed = true; cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); wrap.remove(); live.remove(); },
  };
  return api;
}

if (typeof window !== "undefined") { window.EcoCore = window.EcoCore ?? {}; window.EcoCore.voiceOrb = { mount, MOODS }; }
