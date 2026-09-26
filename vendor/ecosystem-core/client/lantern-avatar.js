// ecosystem-core/client/lantern-avatar.js — Lantern's face: a warm glowing lantern with a living flame.
//
//   import { mount, PRESETS } from ".../lantern-avatar.js";      (or window.EcoCore.lanternAvatar.mount)
//   const lamp = mount(document.querySelector("#lamp"), { preset: "classic", size: 280 });
//   lamp.setState("idle" | "listen" | "think" | "speak" | "off");
//   lamp.setLevel(0..1)            how loud the voice is right now (or lamp.setAnalyser(webAudioAnalyserNode))
//   lamp.setOptions({ flameOuter: "#ff9a2e", metal: "copper", glowIntensity: 1.2 })  ·  lamp.setPreset("moonlight")
//   lamp.stats() → { fps, frames, running }  ·  lamp.destroy()
//
//   idle    a soft, slow flicker and a gently breathing glow
//   listen  the flame leans and brightens a little, as if someone opened a door
//   think   embers drift up from the chimney; the glow pulses slowly
//   speak   the flame and its glow follow the voice, with natural flicker; light spills out in a halo and soft rays
//   off     a low ember (the assistant is asleep or muted)
//
// Options: flameInner, flameOuter, glassTint, metal ("brass" | "iron" | "silver" | "copper"), glowColor,
// glowIntensity (0–2), glowRadius (0.4–2), flicker (0–1), rays (bool), embers (bool), size (px, or 0 = fill the
// element), reducedMotion ("auto" | true | false), label (the accessible name, default "Lantern").
// Draws on a canvas with requestAnimationFrame, pauses when hidden or off screen, and is announced to screen readers
// as an image whose name says what it's doing.

export const PRESETS = {
  classic:   { label: "Classic amber", flameInner: "#fff1b8", flameOuter: "#ff9f1c", glassTint: "#ffd9a0", metal: "brass",  glowColor: "#ffb547", glowIntensity: 1,    glowRadius: 1,    flicker: 0.6 },
  candle:    { label: "Candle",        flameInner: "#fffbea", flameOuter: "#ffd36b", glassTint: "#fff3d6", metal: "silver", glowColor: "#ffe29a", glowIntensity: 0.8,  glowRadius: 0.85, flicker: 0.45 },
  moonlight: { label: "Moonlight blue",flameInner: "#eef8ff", flameOuter: "#5eaefc", glassTint: "#cfe6ff", metal: "silver", glowColor: "#7cc3ff", glowIntensity: 0.9,  glowRadius: 1,    flicker: 0.5 },
  emerald:   { label: "Emerald",       flameInner: "#ecfff4", flameOuter: "#27c985", glassTint: "#bdf5da", metal: "iron",   glowColor: "#3fe39c", glowIntensity: 0.95, glowRadius: 1,    flicker: 0.55 },
  rose:      { label: "Rose",          flameInner: "#fff0f5", flameOuter: "#ff6b98", glassTint: "#ffd0de", metal: "copper", glowColor: "#ff8fb1", glowIntensity: 0.95, glowRadius: 1,    flicker: 0.55 },
  aurora:    { label: "Aurora",        flameInner: "#f0fffb", flameOuter: "#39e0c0", glassTint: "#d6f7ff", metal: "silver", glowColor: "#6fe7d8", glowIntensity: 1.05, glowRadius: 1.1,  flicker: 0.55, aurora: true },
};
export const METALS = {
  brass:  ["#f6dd92", "#c9a45c", "#6f5118"],
  iron:   ["#a3a3a8", "#4b4b52", "#1c1c21"],
  silver: ["#f5f7fb", "#b7bfcc", "#646c7a"],
  copper: ["#ffc6a3", "#c8733f", "#62300f"],
};
export const STATES = ["off", "idle", "listen", "think", "speak"];
const STATE_WORDS = { off: "resting", idle: "ready", listen: "listening", think: "thinking", speak: "speaking" };
const DEFAULTS = { preset: "classic", size: 0, rays: true, embers: true, reducedMotion: "auto", label: "Lantern" };

// ---------- small colour helpers (hex ↔ rgb ↔ hsl) ----------
const hexRgb = (h) => { h = String(h).replace("#", ""); if (h.length === 3) h = [...h].map((c) => c + c).join(""); const n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (h, a) => { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`; };
function rgbHsl([r, g, b]) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2; if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return [h * 360, s * 100, l * 100]; }
const hueShift = (hex, deg, a = 1) => { const [h, s, l] = rgbHsl(hexRgb(hex)); return `hsla(${(h + deg + 360) % 360},${s}%,${l}%,${a})`; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;

export function mount(host, options = {}) {
  if (!host) throw new Error("lantern-avatar: mount() needs an element");
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  // the preset's values are the starting point; explicit options override them
  let opts = { ...DEFAULTS, ...(PRESETS[given.preset ?? DEFAULTS.preset] ?? PRESETS.classic), ...given };
  const wrap = document.createElement("div");
  wrap.className = "eco-lantern";
  wrap.setAttribute("role", "img");
  wrap.style.cssText = "position:relative;display:inline-block;line-height:0;" + (opts.size ? `width:${opts.size}px;height:${opts.size}px;` : "width:100%;height:100%;");
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block;";
  canvas.setAttribute("aria-hidden", "true");
  const live = document.createElement("span");
  live.setAttribute("aria-live", "polite");
  live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;";
  wrap.append(canvas);
  host.append(wrap, live);     // the live region sits beside the image (an image's contents aren't read out)
  const cx2 = canvas.getContext("2d");

  let state = "idle", target = 0, level = 0, analyser = null, buf = null;
  let raf = 0, visible = true, onScreen = true, destroyed = false;
  let W = 0, H = 0, dpr = 1;
  const embers = [];
  const rnd = Array.from({ length: 8 }, () => Math.random() * Math.PI * 2);
  let walk = 0, walkV = 0, lean = 0, bright = 1, pulse = 0;
  let frames = 0, fps = 0, fpsFrames = 0, fpsAt = performance.now(), last = 0;

  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const reduced = () => (opts.reducedMotion === "auto" ? Boolean(mq?.matches) : Boolean(opts.reducedMotion));

  function label() {
    const name = opts.label || "Lantern";
    wrap.setAttribute("aria-label", `${name}: ${STATE_WORDS[state] ?? state}`);
  }
  function size() {
    const r = wrap.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(40, Math.round(r.width || opts.size || 240)), h = Math.max(40, Math.round(r.height || opts.size || 240));
    if (w * dpr !== canvas.width || h * dpr !== canvas.height) { canvas.width = w * dpr; canvas.height = h * dpr; }
    W = canvas.width; H = canvas.height;
  }

  // ---------- the level: voice analyser or setLevel(), smoothed (quick to rise, slow to fall) ----------
  function readLevel() {
    if (analyser) {
      buf ??= new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
      target = clamp(Math.sqrt(s / buf.length) * 3.2, 0, 1);
    }
    const t = state === "speak" ? target : state === "listen" ? target * 0.5 : 0;
    level += (t - level) * (t > level ? 0.35 : 0.08);
  }

  // ---------- drawing ----------
  function metalGrad(x0, x1, y) {
    const m = METALS[opts.metal] ?? METALS.brass;
    const g = cx2.createLinearGradient(x0, y, x1, y);
    g.addColorStop(0, m[2]); g.addColorStop(0.28, m[0]); g.addColorStop(0.55, m[1]); g.addColorStop(1, m[2]);
    return g;
  }
  function flameColor(which, t) {
    const base = which === "inner" ? opts.flameInner : opts.flameOuter;
    return opts.aurora && which === "outer" ? hueShift(base, Math.sin(t / 2600) * 70 + 20) : base;
  }
  function glowColorAt(t, a) { return opts.aurora ? hueShift(opts.glowColor, Math.sin(t / 2600) * 70 + 20, a) : rgba(opts.glowColor, a); }

  function draw(t) {
    const rm = reduced();
    const dt = last ? Math.min(64, t - last) : 16; last = t;
    readLevel();

    // flicker: layered slow waves plus a smoothed random walk (stilled for reduced motion)
    const fl = rm ? 0 : opts.flicker;
    walkV += (Math.random() - 0.5) * 0.08; walkV *= 0.9; walk = clamp(walk + walkV * (dt / 16), -1, 1) * 0.985;
    const wave = 0.5 * Math.sin(t * 0.0021 + rnd[0]) + 0.3 * Math.sin(t * 0.0057 + rnd[1]) + 0.2 * Math.sin(t * 0.0131 + rnd[2]);
    const flick = fl * (0.55 * wave + 0.45 * walk);
    const quick = rm ? 0 : fl * 0.5 * Math.sin(t * 0.045 + rnd[3]) * Math.sin(t * 0.017 + rnd[4]);

    // state targets: how bright, how tall, which way it leans
    const want = {
      off:    { b: 0.28, lean: 0 },
      idle:   { b: 0.9 + (rm ? 0 : 0.06 * Math.sin(t / 2600)), lean: 0 },
      listen: { b: 1.08, lean: rm ? 0 : 0.9 },
      think:  { b: 0.95, lean: 0 },
      speak:  { b: 1 + level * 0.45, lean: 0 },
    }[state] ?? { b: 0.9, lean: 0 };
    bright = lerp(bright, want.b, 0.08);
    lean = lerp(lean, want.lean, 0.05);
    pulse = state === "think" && !rm ? 0.5 + 0.5 * Math.sin(t / 900) : lerp(pulse, 0, 0.05);

    const ctx = cx2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const S = Math.min(W, H);
    const u = S / 150;                 // one design unit (the lantern is ~96 units tall)
    const cx = W / 2, top = H / 2 - 50 * u;
    const flameBase = top + 72 * u;
    const fh = 27 * u * (state === "off" ? 0.35 : 1) * (0.86 + flick * 0.14 + quick * 0.06 + level * 0.32 + pulse * 0.05);
    const fw = 7.6 * u * (state === "off" ? 0.6 : 1) * (1 + level * 0.12 + flick * 0.04);
    const fx = cx + lean * 2.4 * u + flick * 0.9 * u;
    const intensity = opts.glowIntensity * bright;

    // 1 · light spilling into the room: a wide halo, and soft rays when speaking
    ctx.globalCompositeOperation = "lighter";
    const R = S * 0.48 * opts.glowRadius * (0.8 + level * 0.35 + pulse * 0.08 + flick * 0.02);
    let g = ctx.createRadialGradient(fx, flameBase - fh * 0.45, 0, fx, flameBase - fh * 0.45, R);
    g.addColorStop(0, glowColorAt(t, 0.42 * intensity)); g.addColorStop(0.35, glowColorAt(t, 0.16 * intensity)); g.addColorStop(1, glowColorAt(t, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (opts.rays && (state === "speak" || state === "listen") && level > 0.02) {
      const n = 12, spin = rm ? 0 : t / 9000;
      ctx.save(); ctx.translate(fx, flameBase - fh * 0.5);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + spin, len = R * (0.75 + 0.25 * Math.sin(i * 1.7 + t / 700)) * (0.6 + level * 0.6);
        const rg = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
        rg.addColorStop(0, glowColorAt(t, 0)); rg.addColorStop(0.25, glowColorAt(t, 0.10 * level * intensity)); rg.addColorStop(1, glowColorAt(t, 0));
        ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.arc(0, 0, len, a - 0.06, a + 0.06); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";

    // 2 · the handle and the cap
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = metalGrad(cx - 13 * u, cx + 13 * u, top); ctx.lineWidth = 2.4 * u;
    ctx.beginPath(); ctx.arc(cx, top + 9 * u, 11 * u, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.fillStyle = metalGrad(cx - 3 * u, cx + 3 * u, top); ctx.beginPath(); ctx.arc(cx, top + 9.5 * u, 2.6 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = metalGrad(cx - 19 * u, cx + 19 * u, top);
    ctx.beginPath(); ctx.moveTo(cx - 19 * u, top + 22 * u); ctx.quadraticCurveTo(cx - 12 * u, top + 11 * u, cx, top + 10.5 * u); ctx.quadraticCurveTo(cx + 12 * u, top + 11 * u, cx + 19 * u, top + 22 * u); ctx.closePath(); ctx.fill();
    // vent holes in the cap (the flame's light shows through them)
    for (let i = -2; i <= 2; i++) { ctx.fillStyle = glowColorAt(t, 0.25 + 0.5 * bright * (0.6 + level)); ctx.beginPath(); ctx.arc(cx + i * 5 * u, top + 18.2 * u, 1.05 * u, 0, Math.PI * 2); ctx.fill(); }
    roundRect(ctx, cx - 21 * u, top + 21 * u, 42 * u, 5 * u, 2 * u); ctx.fillStyle = metalGrad(cx - 21 * u, cx + 21 * u, top); ctx.fill();

    // 3 · the glass globe with the light inside it
    const gTop = top + 26 * u, gBot = top + 79 * u;
    const globe = () => { ctx.beginPath(); ctx.moveTo(cx - 16 * u, gTop); ctx.bezierCurveTo(cx - 23 * u, gTop + 16 * u, cx - 23 * u, gBot - 16 * u, cx - 16 * u, gBot); ctx.lineTo(cx + 16 * u, gBot); ctx.bezierCurveTo(cx + 23 * u, gBot - 16 * u, cx + 23 * u, gTop + 16 * u, cx + 16 * u, gTop); ctx.closePath(); };
    globe(); ctx.fillStyle = rgba(opts.glassTint, 0.1 + 0.06 * bright); ctx.fill();
    ctx.save(); globe(); ctx.clip();
    g = ctx.createRadialGradient(fx, flameBase - fh * 0.4, 0, fx, flameBase - fh * 0.4, 30 * u);
    g.addColorStop(0, glowColorAt(t, 0.75 * intensity)); g.addColorStop(0.5, glowColorAt(t, 0.28 * intensity)); g.addColorStop(1, glowColorAt(t, 0.04));
    ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g; ctx.fillRect(cx - 30 * u, gTop, 60 * u, gBot - gTop);

    // the wick, under the flame
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(20,12,6,.85)"; ctx.lineWidth = 1.1 * u; ctx.beginPath(); ctx.moveTo(cx, flameBase - 1.5 * u); ctx.lineTo(cx, flameBase + 4 * u); ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    // 4 · the flame: a soft outer body, a bright inner flame, a blue root and a white-hot core
    const flame = (w, h, x) => { ctx.beginPath(); ctx.moveTo(x - w, flameBase); ctx.bezierCurveTo(x - w * 1.05, flameBase - h * 0.42, x - w * 0.35 + lean * 0.6 * u, flameBase - h * 0.78, x + lean * 1.4 * u + flick * 0.8 * u, flameBase - h); ctx.bezierCurveTo(x + w * 0.35 + lean * 0.6 * u, flameBase - h * 0.78, x + w * 1.05, flameBase - h * 0.42, x + w, flameBase); ctx.quadraticCurveTo(x, flameBase + w * 0.9, x - w, flameBase); ctx.closePath(); };
    flame(fw * 1.9, fh * 1.25, fx); g = ctx.createRadialGradient(fx, flameBase - fh * 0.3, 0, fx, flameBase - fh * 0.3, fh * 1.2);
    g.addColorStop(0, opts.aurora ? flameColor("outer", t).replace(/,1\)$/, ",0.35)") : rgba(opts.flameOuter, 0.35 * bright)); g.addColorStop(1, rgba(opts.flameOuter, 0)); ctx.fillStyle = g; ctx.fill();
    flame(fw, fh, fx); g = ctx.createLinearGradient(fx, flameBase, fx, flameBase - fh);
    g.addColorStop(0, rgba(opts.flameOuter, 0.95)); g.addColorStop(0.55, opts.aurora ? flameColor("outer", t) : rgba(opts.flameOuter, 0.85)); g.addColorStop(1, rgba(opts.flameOuter, 0.05)); ctx.fillStyle = g; ctx.fill();
    flame(fw * 0.55, fh * 0.66, fx); g = ctx.createLinearGradient(fx, flameBase, fx, flameBase - fh * 0.66);
    g.addColorStop(0, rgba(opts.flameInner, 0.95)); g.addColorStop(1, rgba(opts.flameInner, 0.1)); ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = `rgba(90,150,255,${(0.35 + level * 0.2) * bright})`; ctx.beginPath(); ctx.ellipse(fx, flameBase - fw * 0.1, fw * 0.62, fw * 0.36, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.55 * bright})`; ctx.beginPath(); ctx.ellipse(fx, flameBase - fh * 0.2, fw * 0.22, fh * 0.14, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    // a highlight on the glass
    g = ctx.createLinearGradient(cx - 18 * u, 0, cx - 9 * u, 0); g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,.16)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(cx - 18 * u, gTop + 6 * u, 9 * u, gBot - gTop - 14 * u);
    ctx.restore();
    globe(); ctx.strokeStyle = rgba(opts.glassTint, 0.45); ctx.lineWidth = 0.9 * u; ctx.stroke();

    // 5 · the frame: two posts and the wire guard around the glass
    ctx.strokeStyle = metalGrad(cx - 22 * u, cx + 22 * u, top); ctx.lineWidth = 2.2 * u;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + s * 17 * u, gTop); ctx.bezierCurveTo(cx + s * 24.5 * u, gTop + 16 * u, cx + s * 24.5 * u, gBot - 16 * u, cx + s * 17 * u, gBot); ctx.stroke(); }
    ctx.lineWidth = 1.3 * u;
    for (const k of [0.36, 0.66]) { const y = gTop + (gBot - gTop) * k; ctx.beginPath(); ctx.moveTo(cx - 22.4 * u, y); ctx.quadraticCurveTo(cx, y + 3 * u, cx + 22.4 * u, y); ctx.stroke(); }

    // 6 · the base
    roundRect(ctx, cx - 21 * u, gBot - 1 * u, 42 * u, 5 * u, 2 * u); ctx.fillStyle = metalGrad(cx - 21 * u, cx + 21 * u, top); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx - 19 * u, gBot + 4 * u); ctx.lineTo(cx + 19 * u, gBot + 4 * u); ctx.quadraticCurveTo(cx + 25 * u, gBot + 10 * u, cx + 22 * u, gBot + 15 * u); ctx.lineTo(cx - 22 * u, gBot + 15 * u); ctx.quadraticCurveTo(cx - 25 * u, gBot + 10 * u, cx - 19 * u, gBot + 4 * u); ctx.closePath();
    ctx.fillStyle = metalGrad(cx - 25 * u, cx + 25 * u, top); ctx.fill();
    // warm light caught on the base's top edge
    ctx.strokeStyle = glowColorAt(t, 0.35 * bright); ctx.lineWidth = 0.8 * u; ctx.beginPath(); ctx.moveTo(cx - 18 * u, gBot + 4.4 * u); ctx.lineTo(cx + 18 * u, gBot + 4.4 * u); ctx.stroke();

    // 7 · embers drifting up from the chimney (thinking; a few when speaking)
    const wantEmbers = opts.embers && !rm && (state === "think" || (state === "speak" && level > 0.35));
    if (wantEmbers && embers.length < 26 && Math.random() < (state === "think" ? 0.22 : 0.1)) embers.push({ x: cx + (Math.random() - 0.5) * 10 * u, y: top + 14 * u, vx: (Math.random() - 0.5) * 0.15 * u, vy: -(0.25 + Math.random() * 0.35) * u, life: 1, r: (0.5 + Math.random() * 0.9) * u, ph: Math.random() * 6 });
    ctx.globalCompositeOperation = "lighter";
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.x += e.vx + Math.sin(t / 500 + e.ph) * 0.12 * u; e.y += e.vy; e.life -= 0.008 * (dt / 16);
      if (e.life <= 0) { embers.splice(i, 1); continue; }
      ctx.fillStyle = glowColorAt(t, e.life * 0.85); ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.6 + e.life * 0.6), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function loop(t) {
    raf = 0;
    if (destroyed || !visible || !onScreen) return;
    // reduced motion, or resting: fewer frames
    const slow = reduced() || state === "off";
    if (slow && t - last < 66) { raf = requestAnimationFrame(loop); return; }
    size(); draw(t);
    frames++; fpsFrames++;
    if (t - fpsAt >= 1000) { fps = Math.round((fpsFrames * 1000) / (t - fpsAt)); fpsFrames = 0; fpsAt = t; }
    raf = requestAnimationFrame(loop);
  }
  const start = () => { if (!raf && !destroyed && visible && onScreen) { last = 0; raf = requestAnimationFrame(loop); } };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

  const onVis = () => { visible = document.visibilityState !== "hidden"; visible ? start() : stop(); };
  document.addEventListener("visibilitychange", onVis);
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); onScreen ? start() : stop(); }) : null;
  io?.observe(wrap);
  const ro = "ResizeObserver" in window ? new ResizeObserver(() => size()) : null;
  ro?.observe(wrap);

  label(); size(); start();

  const api = {
    el: wrap, canvas,
    setState(s) { if (!STATES.includes(s) || s === state) return api; state = s; label(); live.textContent = `${opts.label || "Lantern"} is ${STATE_WORDS[s]}`; if (s !== "think" && s !== "speak") embers.length = Math.min(embers.length, 6); return api; },
    getState: () => state,
    setLevel(v) { target = clamp(Number(v) || 0, 0, 1); return api; },
    setAnalyser(node) { analyser = node ?? null; buf = null; return api; },
    setOptions(o = {}) { const presetChanged = o.preset && o.preset !== opts.preset; opts = presetChanged ? { ...opts, ...(PRESETS[o.preset] ?? {}), ...o } : { ...opts, ...o }; if (o.size !== undefined) { wrap.style.width = o.size ? `${o.size}px` : "100%"; wrap.style.height = o.size ? `${o.size}px` : "100%"; } label(); return api; },
    setPreset(name) { return api.setOptions({ preset: name }); },
    getOptions: () => ({ ...opts }),
    stats: () => ({ fps, frames, running: Boolean(raf), state, level: Number(level.toFixed(3)) }),
    destroy() { destroyed = true; stop(); document.removeEventListener("visibilitychange", onVis); io?.disconnect(); ro?.disconnect(); wrap.remove(); live.remove(); },
  };
  return api;
}

if (typeof window !== "undefined") { window.EcoCore = window.EcoCore ?? {}; window.EcoCore.lanternAvatar = { mount, PRESETS, METALS, STATES }; }
