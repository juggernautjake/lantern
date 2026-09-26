// ecosystem-core/client/sound-panel.js — the Sound panel both apps show: a level for each kind of sound (with mute and a
// test button), where the sound plays, and which microphone listens. Everything device-related comes from the app
// (injected), so the panel never changes a device by itself: only when the user ticks one.
//
//   import { createSoundPanel } from ".../sound-panel.js";
//   const panel = createSoundPanel({
//     title: "Sound",
//     channels: CHANNELS,                                   // from audio-chain.js, or your own [key, icon, name, hint, min]
//     getLevel: (k) => audio.level(k), setLevel: (k, v) => audio.setLevel(k, v),
//     isMuted: (k) => audio.isMuted(k), mute: (k) => audio.mute(k),
//     test: (k) => …,                                       // optional: a short sample for that channel
//     outputs: { list: async () => [{ key, name, type, inUse }], set: async (keys) => … },   // optional
//     inputs:  { list: async () => [{ key, name, type, inUse }], set: async (key) => … },    // optional
//     extra: (el) => {},                                    // optional: add your own sections
//   });
//   panel.open() · panel.close() · panel.toggle() · panel.render() · panel.el
// Styles come with it (class names start with eco-snd) and use the shared tokens, so it looks right in either brand.

const TYPE_ICON = { headphones: "🎧", headset: "🎧", tv: "📺", speakers: "🔈", speaker: "🔈", mic: "🎙️", other: "🔈" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CSS = `
.eco-snd{position:fixed;top:max(3.2rem,6vh);right:max(1rem,3vw);z-index:60;width:min(26rem,calc(100vw - 2rem));max-height:calc(100vh - 6rem);overflow:auto;
  background:var(--glass-strong,#10142c);color:var(--ink,#eef0ff);border:1px solid var(--edge-2,#3a3f6a);border-radius:var(--r-lg,1.25em);box-shadow:var(--shadow-2,0 10px 40px #0008);
  padding:var(--sp-4,1rem) var(--sp-5,1.5rem);font-family:var(--font-body,system-ui);backdrop-filter:blur(var(--blur,16px))}
.eco-snd[hidden]{display:none}
.eco-snd header{display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--sp-2,.5rem)}
.eco-snd h3{margin:0;font-family:var(--font-display,inherit);font-size:var(--fs-lg,1.2rem);font-weight:var(--heading-weight,600)}
.eco-snd h4{margin:var(--sp-4,1rem) 0 var(--sp-2,.5rem);font-size:var(--fs-xs,.78rem);letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#a4abcc)}
.eco-snd button{font:inherit;color:inherit;background:var(--surface-2,#1a1f45);border:1px solid var(--edge,#2a2f55);border-radius:var(--r-pill,2em);cursor:pointer;padding:.3em .7em}
.eco-snd button:hover{border-color:var(--accent,#7c8cff)}
.eco-snd .x{padding:.2em .6em}
.eco-snd .lvl{display:grid;grid-template-columns:2.2em 1fr 2.4em 2em;align-items:center;gap:.5em;margin:.35em 0}
.eco-snd .lvl .mute{padding:.2em;width:2.2em;height:2.2em;border-radius:50%}
.eco-snd .lvl.muted .mute{opacity:.55;text-decoration:line-through}
.eco-snd .nm{display:block;font-size:var(--fs-sm,.9rem)} .eco-snd .nm small{display:block;color:var(--muted,#a4abcc);font-size:var(--fs-xs,.78rem)}
.eco-snd input[type=range]{width:100%;accent-color:var(--accent,#7c8cff)}
.eco-snd output{font-variant-numeric:tabular-nums;text-align:right;color:var(--muted,#a4abcc)}
.eco-snd .dev{display:grid;grid-template-columns:1.4em 1.6em 1fr auto;gap:.5em;align-items:center;padding:.4em .5em;border:1px solid var(--edge,#2a2f55);border-radius:var(--r,.9em);margin:.3em 0;cursor:pointer}
.eco-snd .dev:has(input:checked){border-color:var(--accent,#7c8cff)}
.eco-snd .st{font-size:var(--fs-xs,.78rem);color:var(--ok,#7ee3b0)}
.eco-snd .hint{color:var(--muted,#a4abcc);font-size:var(--fs-xs,.78rem);margin:.4em 0}
`;

export function createSoundPanel({ title = "Sound", channels, getLevel, setLevel, isMuted = () => false, mute = null, test = null, outputs = null, inputs = null, extra = null, mountTo = document.body } = {}) {
  if (!document.getElementById("eco-snd-css")) { const s = document.createElement("style"); s.id = "eco-snd-css"; s.textContent = CSS; document.head.appendChild(s); }
  const el = document.createElement("div");
  el.className = "eco-snd"; el.hidden = true; el.tabIndex = -1;
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", title);
  el.innerHTML = `<header><h3>${esc(title)}</h3><button class="x" data-act="close" aria-label="Close (Esc)" title="Close (Esc)">✕</button></header>
    <section class="sv" aria-label="Volume"><h4>Volume</h4>${channels.map(([k, ic, name, hint, min]) => `
      <div class="lvl" data-k="${esc(k)}"><button class="mute" data-act="mute" title="Mute ${esc(name.toLowerCase())}" aria-label="Mute ${esc(name)}" aria-pressed="false">${ic}</button>
        <label><span class="nm">${esc(name)}<small>${esc(hint)}</small></span><input type="range" min="${min}" max="100" step="1" aria-label="${esc(name)} volume"></label>
        <output>0</output>${test ? `<button class="tst" data-test="${esc(k)}" title="Play a short test" aria-label="Test ${esc(name)}">▶</button>` : "<span></span>"}</div>`).join("")}</section>
    ${outputs ? `<section class="so" aria-label="Plays on"><h4>Plays on</h4><div class="outs"><p class="hint">Looking for your speakers…</p></div></section>` : ""}
    ${inputs ? `<section class="si" aria-label="Microphone"><h4>Microphone</h4><div class="ins"></div></section>` : ""}`;
  mountTo.appendChild(el);
  extra?.(el);
  let opener = null;

  function render() {
    if (el.hidden) return;
    for (const [k, , , , min] of channels) {
      const row = el.querySelector(`.lvl[data-k="${k}"]`), r = row.querySelector("input");
      const v = Math.max(min, Number(getLevel(k)) || 0), m = Boolean(isMuted(k));
      if (document.activeElement !== r) r.value = v;
      row.querySelector("output").textContent = m ? "off" : v;
      row.classList.toggle("muted", m || v <= min);
      row.querySelector(".mute").setAttribute("aria-pressed", String(m));
    }
  }
  async function renderDevices() {
    if (outputs) {
      const box = el.querySelector(".outs");
      let list = []; try { list = await outputs.list(); } catch { box.innerHTML = `<p class="hint">The speakers couldn't be listed.</p>`; }
      if (list.length) box.innerHTML = list.map((d) => `<label class="dev"><input type="checkbox" data-key="${esc(d.key)}" ${d.inUse ? "checked" : ""}><span aria-hidden="true">${TYPE_ICON[d.type] ?? "🔈"}</span><span class="nm">${esc(d.name)}${d.hint ? `<small>${esc(d.hint)}</small>` : ""}</span>${d.inUse ? `<span class="st">in use</span>` : "<span></span>"}</label>`).join("");
    }
    if (inputs) {
      const box = el.querySelector(".ins");
      let list = []; try { list = await inputs.list(); } catch { list = []; }
      box.innerHTML = list.length ? list.map((d) => `<label class="dev"><input type="radio" name="eco-mic" data-key="${esc(d.key)}" ${d.inUse ? "checked" : ""}><span aria-hidden="true">${TYPE_ICON[d.type] ?? "🎙️"}</span><span class="nm">${esc(d.name)}</span>${d.inUse ? `<span class="st">listening</span>` : "<span></span>"}</label>`).join("") : `<p class="hint">No microphones found.</p>`;
    }
  }
  function open() { opener = document.activeElement; el.hidden = false; render(); renderDevices(); setTimeout(() => (el.querySelector(".sv input") ?? el).focus(), 30); }
  function close() { if (el.hidden) return; el.hidden = true; try { opener?.focus?.(); } catch { /* gone */ } }
  const toggle = () => (el.hidden ? open() : close());

  el.addEventListener("input", (e) => { const row = e.target.closest(".lvl"); if (row && e.target.matches("input[type=range]")) { setLevel(row.dataset.k, e.target.value); render(); } });
  el.addEventListener("change", async (e) => {
    const inp = e.target;
    if (inp.matches('.outs input[type="checkbox"]') && outputs) { const keys = [...el.querySelectorAll(".outs input:checked")].map((i) => i.dataset.key); await outputs.set(keys).catch(() => {}); renderDevices(); }
    else if (inp.matches('.ins input[type="radio"]') && inputs) { await inputs.set(inp.dataset.key).catch(() => {}); renderDevices(); }
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.act === "close") return close();
    if (b.dataset.test && test) return test(b.dataset.test);
    if (b.dataset.act === "mute") { const k = b.closest(".lvl").dataset.k; if (mute) mute(k); render(); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.hidden) { e.stopPropagation(); close(); } }, true);
  return { el, open, close, toggle, render, renderDevices };
}

if (typeof window !== "undefined") { window.EcoCore = window.EcoCore ?? {}; window.EcoCore.soundPanel = { createSoundPanel }; }
