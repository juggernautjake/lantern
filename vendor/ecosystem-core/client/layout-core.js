// ecosystem-core/client/layout-core.js — screen fitting both apps share: margins for TVs that cut off the edges, UI and
// text scale, the "Fit to screen" calibration, and the window bar that appears when the pointer reaches the top.
//
//   import { createLayout } from ".../layout-core.js";
//   const layout = createLayout({
//     get: () => settings,                  // { overscan, marginTop, marginBottom, marginLeft, marginRight, uiScale, textScale }
//     save: async (patch) => {},            // stores a change (the calibration's Save)
//     appName: "Lantern",
//     contentTop: () => number,             // optional: where the content starts (the bar sits just above it)
//     windowBar: {                          // optional: omit for no bar
//       actions: ["sound", "fit", "full", "minimize", "max", "hide", "exit"],
//       onAction: (name) => {},             // the app does the window part (its server moves real windows)
//       isMax: () => bool,                  // optional
//     },
//   });
//   layout.apply(settings) · layout.openFit() · layout.showBar() · layout.destroy()
// CSS variables set on <html>: --st --sb --sl --sr (each edge's margin), --sx --sy (the larger pair), --ui, --txt.
// Style hooks: .eco-wbar (the bar) and .eco-fitcal (the calibration). Default styles are included.

const CSS = `
.eco-wbar{position:fixed;left:50%;transform:translate(-50%,-140%);top:max(2px,calc(var(--st,0vh) - 2.4em));z-index:70;display:flex;gap:.3em;align-items:center;
  padding:.3em .45em;border-radius:var(--r-pill,2em);background:var(--glass-strong,#10142c);border:1px solid var(--edge-2,#3a3f6a);box-shadow:var(--shadow-2,0 10px 40px #0008);
  transition:transform var(--dur-2,220ms) var(--ease,ease),opacity var(--dur-2,220ms);opacity:0;font-family:var(--font-body,system-ui);color:var(--ink,#fff)}
.eco-wbar.show{transform:translate(-50%,0);opacity:1}
.eco-wbar .wt{font-family:var(--font-wordmark,inherit);font-weight:var(--wordmark-weight,500);letter-spacing:var(--wordmark-tracking,0);text-transform:var(--wordmark-case,none);padding:0 .6em;font-size:.85em;color:var(--muted,#aab)}
.eco-wbar button{font:inherit;min-width:2.2em;height:2.2em;border-radius:var(--r-pill,2em);border:1px solid transparent;background:transparent;color:inherit;cursor:pointer}
.eco-wbar button:hover,.eco-wbar button:focus-visible{background:var(--surface-2,#1a1f45);border-color:var(--edge-2,#3a3f6a)}
.eco-wbar button.x:hover{background:color-mix(in srgb,var(--danger,#f88) 25%,transparent)}
.eco-fitcal{position:fixed;inset:0;z-index:90;font-family:var(--font-body,system-ui);color:var(--ink,#fff)}
.eco-fitcal .shade{position:absolute;background:rgb(255 90 140 / .28)}
.eco-fitcal .frame{position:absolute;outline:3px solid #3dff8f;outline-offset:-3px}
.eco-fitcal .edge{position:absolute;background:transparent;cursor:grab}
.eco-fitcal .edge.t,.eco-fitcal .edge.b{left:0;right:0;height:14px;margin:-7px 0}
.eco-fitcal .edge.l,.eco-fitcal .edge.r{top:0;bottom:0;width:14px;margin:0 -7px}
.eco-fitcal .edge.sel{background:rgb(61 255 143 / .25)}
.eco-fitcal .box{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(30rem,90vw);background:var(--glass-strong,#10142c);border:1px solid var(--edge-2,#3a3f6a);border-radius:var(--r-lg,1.2em);padding:1.2em 1.4em;box-shadow:var(--shadow-2,0 10px 40px #0008)}
.eco-fitcal .grid{display:grid;grid-template-columns:auto auto auto;gap:.4em .8em;align-items:center}
.eco-fitcal button{font:inherit;color:inherit;background:var(--surface-2,#1a1f45);border:1px solid var(--edge,#2a2f55);border-radius:var(--r-pill,2em);padding:.3em .8em;cursor:pointer}
.eco-fitcal button.go{background:var(--accent,#7c8cff);color:var(--accent-ink,#0a0d24);border-color:transparent;font-weight:600}
.eco-fitcal .actions{display:flex;flex-wrap:wrap;gap:.4em;justify-content:flex-end;margin-top:1em}
`;
const LABEL = { sound: ["🔊", "Sound: outputs, microphone and volume"], fit: ["📐", "Fit to screen: size and edges"], full: ["⛶", "Full screen (F11)"], minimize: ["—", "Minimize"], max: ["□", "Maximize"], hide: ["👁", "Hide (keeps listening)"], exit: ["✕", "Close"] };
const SIDES = { t: "marginTop", b: "marginBottom", l: "marginLeft", r: "marginRight" };
const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);

export function createLayout({ get = () => ({}), save = async () => {}, appName = "App", contentTop = null, windowBar = null, root = document.documentElement, defaultMargin = 0 } = {}) {
  if (!document.getElementById("eco-layout-css")) { const s = document.createElement("style"); s.id = "eco-layout-css"; s.textContent = CSS; document.head.appendChild(s); }
  let fitOpen = null, bar = null, barTimer = 0;
  const cleanups = [];
  const listen = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); cleanups.push(() => t.removeEventListener(ev, fn, o)); };

  const sides = (p = get()) => { const all = typeof p.overscan === "number" ? p.overscan : defaultMargin; const o = {}; for (const [k, key] of Object.entries(SIDES)) o[k] = typeof p[key] === "number" ? p[key] : all; return o; };
  function setMargins(m) {
    root.style.setProperty("--st", m.t + "vh"); root.style.setProperty("--sb", m.b + "vh");
    root.style.setProperty("--sl", m.l + "vw"); root.style.setProperty("--sr", m.r + "vw");
    root.style.setProperty("--sx", `max(${m.l}vw, ${m.r}vw)`); root.style.setProperty("--sy", `max(${m.t}vh, ${m.b}vh)`);
  }
  function apply(p = get()) {
    if (!fitOpen) setMargins(sides(p));
    root.style.setProperty("--ui", String(num(p.uiScale, 100) / 100));
    root.style.setProperty("--txt", String(num(p.textScale, 100) / 100));
    root.toggleAttribute("data-motion", p.uiMotion === "reduced"); if (p.uiMotion === "reduced") root.setAttribute("data-motion", "reduced");
  }

  let api_showBar = () => {};
  /* ---- the window bar ---- */
  if (windowBar) {
    bar = document.createElement("div");
    bar.className = "eco-wbar"; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Window");
    bar.innerHTML = `<span class="wt">${appName}</span>` + (windowBar.actions ?? Object.keys(LABEL)).map((a) => `<button data-w="${a}" class="${a === "exit" ? "x" : ""}" title="${LABEL[a]?.[1] ?? a}" aria-label="${LABEL[a]?.[1] ?? a}">${LABEL[a]?.[0] ?? a}</button>`).join("");
    document.body.appendChild(bar);
    const show = () => { clearTimeout(barTimer); bar.classList.add("show"); paint(); };
    const hideSoon = () => { clearTimeout(barTimer); barTimer = setTimeout(() => { if (!bar.matches(":hover") && !bar.contains(document.activeElement)) bar.classList.remove("show"); }, 1500); };
    const top = () => (contentTop ? contentTop() : innerHeight * (sides().t / 100) + 8);
    listen(window, "pointermove", (e) => { const t = top(), bb = bar.getBoundingClientRect().bottom; if (e.clientY <= t + 14) show(); else if (bar.classList.contains("show") && e.clientY > Math.max(t, bb) + 24) hideSoon(); }, { passive: true });
    listen(window, "keydown", (e) => { if (e.key === "Alt" && !e.repeat) { show(); hideSoon(); } });
    listen(bar, "pointerleave", hideSoon); listen(bar, "focusin", show); listen(bar, "focusout", hideSoon);
    const isMax = () => windowBar.isMax?.() ?? (Boolean(document.fullscreenElement) || (outerWidth >= screen.availWidth - 8 && outerHeight >= screen.availHeight - 8));
    function paint() { const b = bar.querySelector('[data-w="max"]'); if (b) { const m = isMax(); b.textContent = m ? "❐" : "□"; b.title = m ? "Restore down" : "Maximize"; b.setAttribute("aria-label", b.title); } }
    const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen?.() : root.requestFullscreen?.())?.catch?.(() => {});
    listen(window, "keydown", (e) => { if (e.key === "F11" && windowBar.actions?.includes("full")) { e.preventDefault(); toggleFull(); } }, true);
    listen(bar, "click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const a = b.dataset.w;
      if (a === "fit") return openFit();
      if (a === "full") return toggleFull();
      windowBar.onAction?.(a === "max" ? (isMax() ? "restore" : "maximize") : a);
      setTimeout(paint, 400);
    });
    api_showBar = show;
  }

  /* ---- Fit to screen: nudge each edge until its bright line is just visible ---- */
  function openFit() {
    if (fitOpen) return;
    const start = sides(), m = { ...start };
    let sel = "t", msg = "";
    const d = document.createElement("div");
    d.className = "eco-fitcal"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-label", "Fit to screen"); d.tabIndex = -1;
    const NAME = { t: "Top", b: "Bottom", l: "Left", r: "Right" };
    const clamp = (v) => Math.max(0, Math.min(20, Math.round(v * 2) / 2));
    function draw() {
      setMargins(m);
      const W = innerWidth, H = innerHeight, t = H * m.t / 100, b = H * m.b / 100, l = W * m.l / 100, r = W * m.r / 100;
      d.innerHTML = `<div class="shade" style="left:0;right:0;top:0;height:${t}px"></div><div class="shade" style="left:0;right:0;bottom:0;height:${b}px"></div>
        <div class="shade" style="left:0;width:${l}px;top:${t}px;bottom:${b}px"></div><div class="shade" style="right:0;width:${r}px;top:${t}px;bottom:${b}px"></div>
        <div class="frame" style="left:${l}px;right:${r}px;top:${t}px;bottom:${b}px"></div>
        ${["t", "b", "l", "r"].map((k) => `<div class="edge ${k}${sel === k ? " sel" : ""}" data-e="${k}" style="${k === "t" ? `top:${t}px` : k === "b" ? `bottom:${b}px` : k === "l" ? `left:${l}px` : `right:${r}px`}"></div>`).join("")}
        <div class="box"><h3>📐 Fit to screen</h3><p>Move each edge until its <b>bright green line</b> is just visible. The pink areas are what your screen may cut off.</p>
          <div class="grid">${Object.entries(NAME).map(([k, n]) => `<b>${n}</b><span><button data-a="${k}-" aria-label="${n} edge out">−</button> <button data-a="${k}+" aria-label="${n} edge in">+</button></span><output>${m[k]}%</output>`).join("")}</div>
          <p class="keys">Keys: T B L R pick an edge · arrows move it · Shift for bigger steps · Enter saves · Esc cancels. You can also drag the lines.</p>
          ${msg ? `<p>${msg}</p>` : ""}
          <div class="actions"><button data-a="reset">Reset</button><button data-a="cancel">Cancel</button><button data-a="save" class="go">Save</button></div></div>`;
    }
    const close = () => { d.remove(); fitOpen = null; removeEventListener("keydown", onKey, true); apply(); };
    async function doSave() { const same = m.t === m.b && m.b === m.l && m.l === m.r; await save(same ? { overscan: m.t } : { marginTop: m.t, marginBottom: m.b, marginLeft: m.l, marginRight: m.r }).catch(() => {}); fitOpen = null; close(); }
    function act(a) {
      if (a === "save") return doSave();
      if (a === "cancel") { Object.assign(m, start); return close(); }
      if (a === "reset") { for (const k of Object.keys(m)) m[k] = defaultMargin; msg = "Edges back to the default."; return draw(); }
      const k = a.slice(0, -1), step = a.endsWith("+") ? 0.5 : -0.5;
      if (m[k] !== undefined) { m[k] = clamp(m[k] + step); sel = k; }
      draw();
    }
    d.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b?.dataset.a) act(b.dataset.a); });
    d.addEventListener("pointerdown", (e) => {
      const ed = e.target.closest(".edge"); if (!ed) return;
      const k = ed.dataset.e; sel = k; e.preventDefault();
      const move = (ev) => { const W = innerWidth, H = innerHeight; const v = k === "t" ? ev.clientY / H : k === "b" ? (H - ev.clientY) / H : k === "l" ? ev.clientX / W : (W - ev.clientX) / W; m[k] = clamp(v * 100); draw(); };
      const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
    });
    function onKey(e) {
      const k = e.key.toLowerCase(), big = e.shiftKey ? 2 : 0.5;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return act("cancel"); }
      if (e.key === "Enter" && !e.target.closest?.("button")) { e.preventDefault(); return act("save"); }
      if (["t", "b", "l", "r"].includes(k) && !e.ctrlKey && !e.altKey) { sel = k; draw(); e.preventDefault(); return; }
      const dirs = { ArrowUp: { t: -1, b: 1 }, ArrowDown: { t: 1, b: -1 }, ArrowLeft: { l: -1, r: 1 }, ArrowRight: { l: 1, r: -1 } }[e.key];
      if (dirs && dirs[sel] !== undefined) { m[sel] = clamp(m[sel] + dirs[sel] * big); draw(); e.preventDefault(); e.stopPropagation(); }
    }
    addEventListener("keydown", onKey, true);
    fitOpen = d; document.body.appendChild(d); draw(); d.focus();
  }

  apply();
  return { apply, openFit, sides, setMargins, showBar: () => api_showBar(), destroy() { for (const c of cleanups) c(); bar?.remove(); fitOpen?.remove(); } };
}

if (typeof window !== "undefined") { window.EcoCore = window.EcoCore ?? {}; window.EcoCore.layout = { createLayout }; }
