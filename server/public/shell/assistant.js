/* ===========================================================================
   server/public/shell/assistant.js — Lantern, the study companion.
   ---------------------------------------------------------------------------
   The docked panel (the glowing lantern, the conversation, the resources),
   its voice, the wake word, the sound panel and the mini player. Built on
   ecosystem-core (served at /eco/): the lantern avatar, the audio chain, the
   sound panel, screen fitting and the default voice chains.

   ONE VOICE AT A TIME. Everything Lantern says goes through one queue. Each
   "stop" bumps a generation number, and anything queued or half-spoken under
   an old generation is dropped — so Stop really stops, even with the
   browser's own voices (whose cancel() fires an error that would otherwise
   start the next sentence). Lantern tells other apps when it starts and stops
   talking (speaking.start / speaking.stop), waits while Dayspring is talking,
   and stops for a Dayspring alarm.

   THE MICROPHONE. The wake word ("Lantern", changeable) is heard with the
   browser's own speech recognition, and only when Lantern may listen: when
   Dayspring is not running, or Dayspring handed the microphone over. The
   push-to-talk button always works, because pressing it is asking. Lantern
   never changes the computer's audio devices.
   =========================================================================== */

import { mount as mountLantern, PRESETS, METALS } from '/eco/client/lantern-avatar.js';
import { createAudio, CHANNELS } from '/eco/client/audio-chain.js';
import { createSoundPanel } from '/eco/client/sound-panel.js';
import { createLayout } from '/eco/client/layout-core.js';
import { pickBrowserVoice } from '/eco/shared/voices-defaults.mjs';
import { createSpeechQueue } from '/shell/speech-queue.js';

const LS = window.LanternShell;
const { api, el, toast } = LS;
const $ = (s, r) => (r || document).querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTOMATED = !!navigator.webdriver;          // a test browser: never open the real microphone

const A = {
  info: null, prefs: null, lamp: null, audio: null, panel: null, layout: null,
  speech: null, speaking: false, curAudio: null, peer: null, paused: false,
  listening: false, rec: null, recWanted: false, micOk: false, awaitingCommand: 0,
  media: { player: null, queue: [], index: 0, kind: 'video', ready: false, unduck: null, apiLoading: null },
  tab: 'talk', thinking: false,
};

/* ================================================================ start === */
async function start() {
  try { A.info = await api('/api/assistant'); } catch (e) { return; }
  A.prefs = A.info.prefs;
  A.audio = createAudio({ levels: Object.assign({ alarm: 100 }, A.prefs.levels), onLevel: saveLevelsSoon });
  A.layout = createLayout({ get: displayPrefs, save: async (patch) => { await savePrefs({ display: patch.overscan !== undefined ? { marginTop: patch.overscan, marginBottom: patch.overscan, marginLeft: patch.overscan, marginRight: patch.overscan } : patch }); }, appName: 'Lantern' });
  A.panel = createSoundPanel({
    title: 'Sound', channels: CHANNELS.filter((c) => c[0] !== 'alarm'),
    getLevel: (k) => A.audio.level(k), setLevel: (k, v) => A.audio.setLevel(k, v),
    isMuted: (k) => A.audio.isMuted(k), mute: (k) => A.audio.mute(k),
    test: (k) => testSound(k),
    extra: (box) => box.appendChild(el('p', { class: 'hint', text: 'Lantern plays through this computer’s usual speakers. To change them, use Windows’ sound settings.' })),
  });
  $('#sound-btn').addEventListener('click', () => { A.audio.resume().catch(() => {}); A.panel.toggle(); });
  $('#assistant-btn').addEventListener('click', toggleDock);
  window.addEventListener('lantern:resources', () => { showDock(); showResources(); });
  document.addEventListener('pointerdown', () => { A.audio.resume().catch(() => {}); }, { once: true, capture: true });

  LS.registerAssistant(buildPanel);
  applyDock();
  try { window.matchMedia('(max-width: 900px)').addEventListener('change', applyDock); } catch (e) { /* old browser */ }
  registerSettingsSections();
  LS.on('eco-in', onEco);
  LS.on('mic', () => refreshMic());
  LS.on('assistant-prefs', (ev) => { if (ev && ev.prefs) { A.prefs = ev.prefs; applyPrefs(); } });
  LS.on('milestone', (ev) => { if (A.prefs.enabled && ev && ev.title) say((ev.kind === 'unit' ? 'You finished ' : 'You passed ') + ev.title + '. Well done!'); });
  LS.on('reminder', (ev) => { if (A.prefs.enabled && ev && ev.text && !(A.info.quiet && A.info.quiet.quiet)) say(ev.text); });
  LS.on('here', () => { if (A.tab === 'resources') showResources(); });
  refreshMic();
  window.LanternAssistant = { say, stop: stopSpeaking, send, showResources, play: playQueue, media: mediaControl, state: () => ({ speaking: A.speaking, queue: speechQueue().length, gen: speechQueue().generation, listening: A.listening, peer: A.peer, lamp: A.lamp ? A.lamp.getState() : null, media: A.media.queue.length ? { index: A.media.index, title: (A.media.queue[A.media.index] || {}).title, kind: A.media.kind } : null }) };
}

const displayPrefs = () => {
  const d = (A.prefs && A.prefs.display) || {};
  let motion = ''; try { motion = localStorage.getItem('lantern.shell.motion') || ''; } catch (e) { /* blocked */ }
  return { uiScale: d.uiScale, textScale: d.textScale, marginTop: d.marginTop, marginBottom: d.marginBottom, marginLeft: d.marginLeft, marginRight: d.marginRight, uiMotion: motion };
};
async function savePrefs(patch) {
  try { A.prefs = await api('/api/assistant/prefs', { method: 'PUT', body: patch }); applyPrefs(); } catch (e) { toast(e.message); }
  return A.prefs;
}
let levelTimer = null;
function saveLevelsSoon() {
  clearTimeout(levelTimer);
  levelTimer = setTimeout(() => { const L = A.audio.levels(); api('/api/assistant/prefs', { method: 'PUT', body: { levels: { master: L.master, voice: L.voice, sounds: L.sounds, music: L.music, video: L.video } } }).catch(() => {}); }, 600);
}
function applyPrefs() {
  applyDock();
  if (A.lamp) A.lamp.setOptions(avatarOptions(A.prefs.avatar));
  A.layout.apply(displayPrefs());
  const nm = $('.as-title b'); if (nm) nm.textContent = A.prefs.wakeWord || 'Lantern';
  refreshMic();
}
export function avatarOptions(a) {
  const o = {};
  for (const [k, v] of Object.entries(a || {})) if (v !== null && v !== undefined && k !== 'size') o[k] = v;
  return o;
}

/* ================================================================ panel === */
function buildPanel(slot) {
  slot.classList.add('as-slot');
  const lampBox = el('div', { class: 'as-lamp', 'data-testid': 'assistant-lamp' });
  const status = el('small', { class: 'as-status', text: 'Ready', 'aria-live': 'polite' });
  const talk = el('button', { class: 'as-ico', type: 'button', 'data-testid': 'ptt', title: 'Push to talk: press, then speak', 'aria-label': 'Push to talk' }, '🎙️');
  const stop = el('button', { class: 'as-ico', type: 'button', 'data-testid': 'stop-speaking', title: 'Stop talking (Esc)', 'aria-label': 'Stop talking' }, '■');
  const hide = el('button', { class: 'as-ico', type: 'button', title: 'Hide Lantern', 'aria-label': 'Hide Lantern' }, '⟩');
  talk.addEventListener('click', pushToTalk);
  stop.addEventListener('click', () => { stopSpeaking(); stopListeningForCommand(); });
  hide.addEventListener('click', toggleDock);
  const tabs = el('div', { class: 'as-tabs', role: 'tablist' }, [
    el('button', { type: 'button', role: 'tab', 'data-tab': 'talk', 'aria-selected': 'true', onclick: () => setTab('talk') }, 'Talk'),
    el('button', { type: 'button', role: 'tab', 'data-tab': 'resources', 'aria-selected': 'false', 'data-testid': 'tab-resources', onclick: () => { setTab('resources'); showResources(); } }, 'Resources'),
  ]);
  const log = el('div', { class: 'as-log', role: 'log', 'aria-live': 'polite', 'data-testid': 'assistant-log' });
  const res = el('div', { class: 'as-res', hidden: true, 'data-testid': 'resources-panel' });
  const input = el('textarea', { rows: '2', placeholder: 'Ask Lantern… (Enter to send)', 'aria-label': 'Message to Lantern', 'data-testid': 'assistant-input' });
  const sendBtn = el('button', { class: 'btn primary', type: 'submit', 'data-testid': 'assistant-send' }, 'Send');
  const form = el('form', { class: 'as-input' }, [input, sendBtn]);
  form.addEventListener('submit', (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = ''; send(t); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  const head = el('div', { class: 'as-head ln-lampglow' }, [lampBox,
    el('div', { class: 'as-title' }, [el('b', { text: A.prefs.wakeWord || 'Lantern' }), status]),
    el('div', { class: 'as-tools' }, [talk, stop, hide])]);
  slot.appendChild(el('div', { class: 'as-panel' }, [head, tabs, log, res, form]));

  A.lamp = mountLantern(lampBox, Object.assign({ size: 0, label: 'Lantern' }, avatarOptions(A.prefs.avatar)));
  A.lamp.setState(A.prefs.enabled ? 'idle' : 'off');
  greet(log);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (A.speaking || speechQueue().length)) stopSpeaking(); });
}
function greet(log) {
  const ai = A.info.ai;
  const who = /^(learner|you)?$/i.test(String(A.info.name || '').trim()) ? '' : String(A.info.name).split(' ')[0];
  const hi = (who ? 'Hello, ' + who + '. ' : 'Hello. ') + 'I am Lantern, your study companion. Ask me for a hint, what is next, or to find a video about this lesson.';
  addMsg('lantern', hi + (ai.ready ? '' : ' (No AI is set up yet, so I can do the built-in things. Add one in Settings, Assistant.)'), { quiet: true });
  void log;
}
function setTab(t) {
  A.tab = t;
  document.querySelectorAll('.as-tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false'));
  $('.as-log').hidden = t !== 'talk'; $('.as-input').hidden = t !== 'talk'; $('.as-res').hidden = t !== 'resources';
}
function setStatus(t) { const s = $('.as-status'); if (s) s.textContent = t; }
function setLamp(state) { if (A.lamp) A.lamp.setState(A.prefs.enabled ? state : 'off'); }

const narrow = () => !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
let openHere = false;          // on a phone: opened with the button, this visit
function applyDock() {
  const slot = $('#assistant-slot');
  let dock = A.prefs.enabled ? A.prefs.dock : 'hidden';
  if (dock !== 'hidden' && narrow() && !openHere) dock = 'hidden';
  document.body.dataset.dock = dock;
  slot.hidden = dock === 'hidden';
  $('#assistant-btn').setAttribute('aria-pressed', dock === 'hidden' ? 'false' : 'true');
}
function toggleDock() {
  const hidden = document.body.dataset.dock === 'hidden';
  if (narrow() && A.prefs.enabled && A.prefs.dock !== 'hidden') { openHere = hidden; applyDock(); return; }
  if (hidden) showDock(); else savePrefs({ dock: 'hidden' });
}
function showDock() {
  if (document.body.dataset.dock !== 'hidden') return;
  if (narrow() && A.prefs.enabled && A.prefs.dock !== 'hidden') { openHere = true; applyDock(); return; }
  savePrefs({ enabled: true, dock: A.prefs.dock === 'hidden' || !A.prefs.dock ? 'right' : A.prefs.dock });
}

function addMsg(who, text, opts) {
  const o = opts || {};
  const log = $('.as-log');
  if (!log) return null;
  const m = el('div', { class: 'as-msg ' + who, 'data-testid': 'msg-' + who }, [LS.md ? LS.md(text) : el('p', { text })]);
  if (o.links && o.links.length) m.appendChild(el('ul', { class: 'as-links' }, o.links.map((x) => el('li', {}, [el('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', text: x.title }), x.source ? el('small', { text: ' · ' + x.source }) : null]))));
  if (o.button) m.appendChild(o.button);
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.appendChild(m);
  if (nearBottom || who === 'me') scrollToMsg(log, m);
  return m;
}

function scrollToMsg(log, m) {
  const go = () => {
    const tall = m.offsetHeight > log.clientHeight - 24;
    log.scrollTop = tall ? Math.max(0, m.offsetTop - log.offsetTop - 8) : log.scrollHeight;
  };
  go();
  requestAnimationFrame(go);           // after fonts and links have laid out
}

/* ================================================================= talk === */
let sendChain = Promise.resolve();
export function send(text) {
  if (!text) return Promise.resolve(null);
  addMsg('me', text);                 // shown at once; answered in turn
  const run = sendChain.then(() => sendNow(text));
  sendChain = run.catch(() => null);
  return run;
}
async function sendNow(text) {
  A.audio.resume().catch(() => {});
  setLamp('think'); setStatus('Thinking…'); A.thinking = true;
  let out;
  try { out = await api('/api/assistant/chat', { method: 'POST', body: { text } }); }
  catch (e) { out = { reply: 'I could not answer just then: ' + e.message, actions: [] }; }
  A.thinking = false;
  const acts = out.actions || [];
  if (acts.some((a) => a.type === 'stop')) { stopSpeaking(); setLamp(A.listening ? 'listen' : 'idle'); setStatus('Ready'); return out; }
  if (acts.some((a) => a.type === 'clear')) { const log = $('.as-log'); if (log) log.innerHTML = ''; }
  const links = acts.filter((a) => a.type === 'links').flatMap((a) => a.items || []);
  const sug = acts.find((a) => a.type === 'suggest');
  const button = sug ? el('button', { class: 'btn', type: 'button', onclick: () => openRef(sug.course, sug.ref) }, 'Open ' + sug.title) : null;
  if (out.reply) addMsg('lantern', out.reply, { links: links.concat((out.citations || []).map((c) => ({ title: c.title, url: c.url }))), button });
  for (const a of acts) runAction(a);
  setStatus('Ready');
  if (out.reply && !out.silent) say(out.reply); else setLamp(A.listening ? 'listen' : 'idle');
  return out;
}
function runAction(a) {
  switch (a.type) {
    case 'open': openRef(a.course, a.ref); break;
    case 'play': playQueue(a.queue || [], a.index || 0, a.kind || 'video'); break;
    case 'media': mediaControl(a.action); break;
    case 'resources': showDock(); setTab('resources'); paintResources(a); break;
    default: break;
  }
}
function openRef(course, ref) {
  if (!course) return;
  location.hash = ref ? '#/learn/' + encodeURIComponent(course) + '?open=' + encodeURIComponent(ref) : '#/course/' + encodeURIComponent(course);
}

/* =============================================================== speech === */
function speechQueue() {
  if (A.speech) return A.speech;
  A.speech = createSpeechQueue({
    speak: speakOne,
    peerBusy: () => !!A.peer,
    onStart: () => {
      A.speaking = true;
      notifySpeaking(true);
      A.audio.duck(true);
      pauseRecognition();
      setLamp('speak'); setStatus('Speaking…');
    },
    onEnd: () => {
      A.speaking = false;
      notifySpeaking(false);
      A.audio.duck(false);
      if (A.lamp) { A.lamp.setAnalyser(null); A.lamp.setLevel(0); }
      setLamp(A.listening ? 'listen' : 'idle'); setStatus('Ready');
      resumeRecognition();
    },
  });
  return A.speech;
}
/* Say something: queued behind anything already being said. */
export function say(text) {
  if (!A.prefs.enabled || !A.prefs.speakReplies) return;
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' (the code is on screen) ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_#`>]/g, '').trim();
  if (t) speechQueue().say(t);
}
/* Stop now: what is playing, and everything queued. */
export function stopSpeaking() {
  speechQueue().stop();
  if (A.curAudio) { try { A.curAudio.pause(); A.curAudio.removeAttribute('src'); A.curAudio.load(); } catch (e) { /* gone */ } }
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* none */ }
  A.paused = false;
  if (A.lamp) { A.lamp.setAnalyser(null); A.lamp.setLevel(0); }
  setLamp(A.listening ? 'listen' : 'idle');
}
function notifySpeaking(on) { api('/api/assistant/speaking', { method: 'POST', body: { on } }).catch(() => {}); }

async function speakOne(text, stale) {
  // The server voice (ElevenLabs / OpenAI) when there is one; else the browser's own.
  let blob = null;
  try {
    const r = await fetch('/api/assistant/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (r.status === 200) blob = await r.blob();
  } catch (e) { blob = null; }
  if (stale()) return;
  if (blob) return playBlob(blob, stale);
  return browserSpeak(text, stale);
}
function playBlob(blob, stale) {
  return new Promise((resolve) => {
    const a = new Audio();
    A.curAudio = a;
    a.src = URL.createObjectURL(blob);
    const done = () => { clearInterval(watch); try { URL.revokeObjectURL(a.src); } catch (e) { /* fine */ } if (A.curAudio === a) A.curAudio = null; resolve(); };
    const watch = setInterval(() => { if (stale()) { try { a.pause(); } catch (e) { /* gone */ } done(); } }, 120);
    a.onended = done; a.onerror = done;
    try { A.audio.playVoice(a).catch(done); if (A.lamp) A.lamp.setAnalyser(A.audio.analyser); }
    catch (e) { a.play().catch(done); }
  });
}
let voicesCache = null;
function browserVoices() {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve([]);
    const v = window.speechSynthesis.getVoices();
    if (v && v.length) { voicesCache = v; return resolve(v); }
    let settled = false;
    const fin = () => { if (settled) return; settled = true; voicesCache = window.speechSynthesis.getVoices() || []; resolve(voicesCache); };
    window.speechSynthesis.addEventListener('voiceschanged', fin, { once: true });
    setTimeout(fin, 1200);
  });
}
export async function chosenBrowserVoice() {
  const list = await browserVoices();
  const want = (A.info.voice && A.info.voice.settings && A.info.voice.settings.browserVoice) || '';
  return (want && list.find((v) => v.name === want)) || pickBrowserVoice(list, 'lantern');
}
async function browserSpeak(text, stale) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
  const voice = await chosenBrowserVoice();
  const rate = Number((A.info.voice && A.info.voice.settings && A.info.voice.settings.rate) || 1);
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) || [text];
  let pulse = null;
  if (A.lamp) { A.lamp.setAnalyser(null); pulse = setInterval(() => A.lamp.setLevel(0.25 + Math.random() * 0.45), 110); }
  try {
    for (const p of parts) {
      if (stale()) return;                         // stopped: never start the next sentence
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(p.trim());
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        u.rate = rate;
        u.volume = Math.max(0, Math.min(1, (A.audio.isMuted('voice') ? 0 : A.audio.level('voice') / 100) * (A.audio.level('master') / 100)));
        let over = false;
        const end = () => { if (over) return; over = true; clearInterval(guard); resolve(); };
        u.onend = end; u.onerror = end;
        const guard = setInterval(() => { if (stale()) { try { window.speechSynthesis.cancel(); } catch (e) { /* none */ } end(); } }, 150);
        window.speechSynthesis.speak(u);
      });
    }
  } finally { if (pulse) clearInterval(pulse); if (A.lamp) A.lamp.setLevel(0); }
}
function testSound(k) {
  A.audio.resume().catch(() => {});
  if (k === 'voice') return say('This is my voice, at this volume.');
  if (k === 'music' || k === 'video') return toast('Play something (ask me for focus music) to hear this level.');
  return A.audio.testChime();
}

/* ============================================================ the peers === */
function onEco(ev) {
  const e = ev && ev.event;
  if (ev && ev.quiet) A.info.quiet = ev.quiet;
  if (!e) return;
  if (e.type === 'speaking.start' && e.source !== 'lantern') {
    A.peer = e.source;
    // Both started at once: Lantern gives way and says it after.
    if (A.speaking && A.curAudio) { try { A.curAudio.pause(); A.paused = true; } catch (x) { /* gone */ } }
    if (A.speaking && window.speechSynthesis && window.speechSynthesis.speaking) { try { window.speechSynthesis.pause(); A.paused = true; } catch (x) { /* none */ } }
  }
  if (e.type === 'speaking.stop' && e.source === A.peer) {
    A.peer = null;
    if (A.paused) { A.paused = false; try { if (A.curAudio) A.curAudio.play(); else if (window.speechSynthesis) window.speechSynthesis.resume(); } catch (x) { /* gone */ } }
  }
  if (e.type === 'app.stopping' && e.source === A.peer) A.peer = null;
  if (e.type === 'alarm') { stopSpeaking(); mediaControl('pause'); toast(el('div', {}, [el('span', { class: 'eco-chip', 'data-app': 'dayspring', text: 'Dayspring' }), ' An alarm is ringing, so Lantern paused.'])); }
  if (e.type === 'call.state' && e.data && e.data.inCall) { stopSpeaking(); mediaControl('pause'); }
}

/* ========================================================== listening === */
async function refreshMic() {
  try { A.info.mic = await api('/api/assistant/mic'); } catch (e) { return; }
  A.micOk = !!(A.info.mic && A.info.mic.lanternMayListen);
  const want = A.prefs.enabled && A.prefs.wakeOn && A.micOk && !AUTOMATED && !!recognitionClass();
  const t = $('[data-testid=ptt]');
  if (t) t.title = A.micOk ? 'Push to talk (or say “' + (A.prefs.wakeWord || 'Lantern') + '”)' : 'Push to talk. Dayspring is listening for its own name right now, so say “Dayspring” there, or press this.';
  if (want && !A.recWanted) startWake();
  if (!want && A.recWanted) stopWake();
}
const recognitionClass = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
function startWake() {
  const R = recognitionClass();
  if (!R) return;
  A.recWanted = true;
  const rec = new R();
  rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      heard(String(e.results[i][0].transcript || '').trim());
    }
  };
  rec.onend = () => { A.listening = false; if (A.recWanted && !A.speaking) setTimeout(() => { try { rec.start(); A.listening = true; } catch (x) { /* already */ } }, 400); };
  rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { A.recWanted = false; setStatus('The microphone is blocked. Allow it in the browser to use “' + (A.prefs.wakeWord || 'Lantern') + '”.'); } };
  A.rec = rec;
  try { rec.start(); A.listening = true; } catch (e) { A.listening = false; }
}
function stopWake() { A.recWanted = false; if (A.rec) { try { A.rec.abort(); } catch (e) { /* gone */ } } A.rec = null; A.listening = false; }
function pauseRecognition() { if (A.rec && A.listening) { try { A.rec.abort(); } catch (e) { /* gone */ } A.listening = false; } }
function resumeRecognition() { if (A.recWanted && A.rec && !A.listening) { try { A.rec.start(); A.listening = true; } catch (e) { /* already */ } } }
function heard(text) {
  const w = (A.prefs.wakeWord || 'Lantern').toLowerCase();
  const re = new RegExp('^(?:(?:hey|ok|okay|hi)[,\\s]+)?' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[,.!?\\s]*(.*)$', 'i');
  const m = re.exec(text);
  if (m) {
    const rest = m[1].trim();
    if (rest) { A.awaitingCommand = 0; send(rest); }
    else { A.awaitingCommand = Date.now(); setLamp('listen'); setStatus('Listening…'); A.audio.testChime(); }
    return;
  }
  if (A.awaitingCommand && Date.now() - A.awaitingCommand < 8000) { A.awaitingCommand = 0; send(text); }
}
function stopListeningForCommand() { A.awaitingCommand = 0; }
function pushToTalk() {
  const R = recognitionClass();
  if (!R) { toast('This browser cannot listen. Use Microsoft Edge or Google Chrome, or type instead.'); return; }
  if (AUTOMATED) { setStatus('Listening is off in test browsers.'); return; }
  stopSpeaking();
  pauseRecognition();
  const rec = new R();
  rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
  const input = $('[data-testid=assistant-input]');
  setLamp('listen'); setStatus('Listening… speak now');
  let final = '';
  rec.onresult = (e) => { let t = ''; for (let i = 0; i < e.results.length; i++) { t += e.results[i][0].transcript; if (e.results[i].isFinal) final = t; } if (input) input.value = t; };
  rec.onend = () => { setLamp('idle'); setStatus('Ready'); if (input) input.value = ''; resumeRecognition(); if (final.trim()) send(final.trim()); };
  rec.onerror = (e) => { setStatus(e.error === 'not-allowed' ? 'The microphone is blocked in this browser.' : 'I did not catch that.'); };
  try { rec.start(); } catch (e) { setStatus('I could not start listening.'); }
}

/* ========================================================= mini player === */
function mediaSlot() {
  let box = $('.as-media');
  if (box) return box;
  LS.registerMedia((slot) => {
    box = el('div', { class: 'as-media eco-glass', role: 'region', 'aria-label': 'Player', 'data-testid': 'media-player' });
    const vid = el('div', { class: 'as-video' }, el('div', { id: 'as-yt' }));
    const title = el('div', { class: 'as-mtitle', 'data-testid': 'media-title' });
    const seek = el('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Position', class: 'as-seek' });
    const time = el('span', { class: 'as-time', text: '0:00' });
    const speed = el('select', { 'aria-label': 'Speed', title: 'Speed' }, ['0.75', '1', '1.25', '1.5', '1.75', '2'].map((v) => el('option', { value: v, selected: v === '1' ? true : null }, v + '×')));
    const vol = el('input', { type: 'range', min: '0', max: '100', value: String(A.audio.level('video')), 'aria-label': 'Volume', class: 'as-vol' });
    const b = (label, icon, fn, id) => el('button', { type: 'button', class: 'as-ico', title: label, 'aria-label': label, 'data-testid': id || null, onclick: fn }, icon);
    const ctl = el('div', { class: 'as-mctl' }, [
      b('Previous', '⏮', () => mediaControl('previous'), 'media-prev'), b('Play or pause', '⏯', () => mediaControl('toggle'), 'media-toggle'), b('Next', '⏭', () => mediaControl('next'), 'media-next'),
      seek, time, speed, vol,
      b('Pop out into your browser', '↗', () => popOut(), 'media-popout'),
      b('Smaller or bigger', '▭', () => box.classList.toggle('big')),
      b('Close the player', '✕', () => mediaControl('stop'), 'media-close'),
    ]);
    const q = el('ol', { class: 'as-queue', 'aria-label': 'Up next' });
    box.append(vid, title, ctl, q);
    slot.appendChild(box);
    seek.addEventListener('input', () => { const p = A.media.player; if (p && p.getDuration) p.seekTo(p.getDuration() * seek.value / 1000, true); });
    speed.addEventListener('change', () => { const p = A.media.player; if (p && p.setPlaybackRate) p.setPlaybackRate(Number(speed.value)); });
    vol.addEventListener('input', () => A.audio.setLevel(A.media.kind, Number(vol.value)));
    setInterval(() => {
      const p = A.media.player;
      if (!p || !p.getCurrentTime || !A.media.ready) return;
      const d = p.getDuration() || 0, t = p.getCurrentTime() || 0;
      if (document.activeElement !== seek && d) seek.value = String(Math.round(t / d * 1000));
      time.textContent = fmt(t) + (d ? ' / ' + fmt(d) : '');
    }, 500);
  });
  return $('.as-media');
}
/* Pop the video out into the browser at the second it was on, and pause it here. */
function popOut() {
  const it = A.media.queue[A.media.index];
  if (!it) return;
  const p = A.media.player;
  let t = 0;
  try { if (p && p.getCurrentTime) t = Math.floor(p.getCurrentTime() || 0); if (p && p.pauseVideo) p.pauseVideo(); } catch (e) { /* gone */ }
  const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(it.videoId) + (t ? '&t=' + t + 's' : '');
  A.media.lastPopOut = url;
  window.open(url, '_blank', 'noopener');
}
const fmt = (s) => { s = Math.floor(s || 0); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (A.media.apiLoading) return A.media.apiLoading;
  A.media.apiLoading = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch (e) { /* theirs */ } resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { A.media.apiLoading = null; reject(new Error('The video player could not load. The computer may be offline.')); };
    document.head.appendChild(s);
    setTimeout(() => { if (!(window.YT && window.YT.Player)) { A.media.apiLoading = null; reject(new Error('The video player took too long to load.')); } }, 15000);
  });
  return A.media.apiLoading;
}
export async function playQueue(queue, index, kind) {
  if (!queue || !queue.length) return;
  A.media.queue = queue; A.media.index = index || 0; A.media.kind = kind === 'music' ? 'music' : 'video';
  const box = mediaSlot();
  box.hidden = false;
  box.classList.toggle('music', A.media.kind === 'music');
  paintQueue();
  let YT;
  try { YT = await loadYouTubeApi(); } catch (e) { toast(e.message); return; }
  const cur = A.media.queue[A.media.index];
  if (A.media.player && A.media.player.loadVideoById) { A.media.player.loadVideoById(cur.videoId); return; }
  A.media.player = new YT.Player('as-yt', {
    videoId: cur.videoId, width: '100%', height: '100%',
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: (e) => {
        A.media.ready = true;
        if (A.media.unduck) A.media.unduck();
        A.media.unduck = A.audio.media.add({ kind: A.media.kind, setVolume: (v) => { try { e.target.setVolume(Math.round(v * 100)); } catch (x) { /* gone */ } } });
        try { e.target.playVideo(); } catch (x) { /* autoplay may need a click */ }
      },
      onStateChange: (e) => { if (window.YT && e.data === window.YT.PlayerState.ENDED) mediaControl('next'); },
      onError: (e) => {
        const blocked = e && (e.data === 101 || e.data === 150);
        toast(blocked ? 'That video can’t play inside Lantern. Press ↗ to pop it out into your browser.' : 'That video cannot be played here. Trying the next one.');
        if (!blocked) mediaControl('next');
      },
    },
  });
}
function paintQueue() {
  const q = $('.as-queue'); const t = $('[data-testid=media-title]');
  const cur = A.media.queue[A.media.index];
  if (t) t.textContent = cur ? cur.title : '';
  if (!q) return;
  q.innerHTML = '';
  A.media.queue.forEach((it, i) => q.appendChild(el('li', { class: i === A.media.index ? 'on' : '' }, el('button', { type: 'button', onclick: () => { A.media.index = i; playQueue(A.media.queue, i, A.media.kind); } }, it.title))));
}
export function mediaControl(action) {
  const p = A.media.player;
  const has = p && A.media.ready;
  switch (action) {
    case 'pause': if (has) p.pauseVideo(); break;
    case 'resume': if (has) p.playVideo(); break;
    case 'toggle': if (has) { if (p.getPlayerState && window.YT && p.getPlayerState() === window.YT.PlayerState.PLAYING) p.pauseVideo(); else p.playVideo(); } break;
    case 'next': if (A.media.index < A.media.queue.length - 1) { A.media.index++; if (has) p.loadVideoById(A.media.queue[A.media.index].videoId); paintQueue(); } break;
    case 'previous': if (A.media.index > 0) { A.media.index--; if (has) p.loadVideoById(A.media.queue[A.media.index].videoId); paintQueue(); } else if (has) p.seekTo(0, true); break;
    case 'popout': popOut(); break;
    case 'louder': A.audio.setLevel(A.media.kind, Math.min(100, A.audio.level(A.media.kind) + 15)); break;
    case 'quieter': A.audio.setLevel(A.media.kind, Math.max(0, A.audio.level(A.media.kind) - 15)); break;
    case 'stop': {
      if (p && p.destroy) try { p.destroy(); } catch (e) { /* gone */ }
      if (A.media.unduck) A.media.unduck();
      A.media = Object.assign(A.media, { player: null, queue: [], index: 0, ready: false, unduck: null });
      const box = $('.as-media'); if (box) box.remove();
      const slot = $('#media-slot'); if (slot) slot.innerHTML = '';
      break;
    }
    default: break;
  }
}

/* ============================================================ resources === */
export async function showResources(topic) {
  setTab('resources');
  const box = $('.as-res');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(el('p', { class: 'muted', text: 'Looking for videos and reading about this lesson…' }));
  const h = LS.here();
  try {
    const r = await api('/api/assistant/resources', { method: 'POST', body: { course: h.course, ref: h.ref, topic: topic || null } });
    paintResources(r);
  } catch (e) { box.innerHTML = ''; box.appendChild(el('p', { class: 'err', text: e.message })); }
}
function paintResources(r) {
  const box = $('.as-res');
  if (!box) return;
  box.innerHTML = '';
  const q = el('input', { type: 'text', placeholder: 'Or search a topic…', 'aria-label': 'Search a topic', 'data-testid': 'res-topic' });
  box.appendChild(el('form', { class: 'as-res-search', onsubmit: (e) => { e.preventDefault(); if (q.value.trim()) showResources(q.value.trim()); } }, [q, el('button', { class: 'btn', type: 'submit' }, 'Search')]));
  box.appendChild(el('h3', { text: r.topic ? 'About ' + r.topic : 'Resources' }));
  if (r.message) box.appendChild(el('p', { class: 'muted', text: r.message }));
  else if (r.fromCache) box.appendChild(el('p', { class: 'muted', text: 'Found earlier. ', 'data-testid': 'res-cached' }, [el('button', { class: 'btn quiet', type: 'button', onclick: async () => { const h = LS.here(); paintResources(await api('/api/assistant/resources', { method: 'POST', body: { course: h.course, ref: h.ref, topic: r.topic && !h.ref ? r.topic : null, refresh: true } })); } }, 'Search again')]));
  const vids = (r.online || []).filter((x) => x.type === 'video');
  const reads = (r.online || []).filter((x) => x.type !== 'video');
  if (vids.length) {
    box.appendChild(el('h4', { text: 'Videos' }));
    box.appendChild(el('div', { class: 'as-cards', 'data-testid': 'res-videos' }, vids.map((v, i) => card(v, () => playQueue(vids.map((x) => ({ videoId: x.videoId, title: x.title, source: x.source, thumbnail: x.thumbnail })), i, 'video')))));
  }
  if (reads.length) {
    box.appendChild(el('h4', { text: 'Read and discuss' }));
    box.appendChild(el('div', { class: 'as-cards list', 'data-testid': 'res-reading' }, reads.map((v) => card(v))));
  }
  if ((r.offline || []).length) {
    box.appendChild(el('h4', { text: 'Reference (works offline too)' }));
    box.appendChild(el('ul', { class: 'as-links', 'data-testid': 'res-docs' }, r.offline.map((x) => el('li', {}, [el('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', text: x.title }), x.source ? el('small', { text: ' · ' + x.source }) : null]))));
  }
  if (!vids.length && !reads.length && !(r.offline || []).length) box.appendChild(el('p', { class: 'muted', text: 'Nothing found yet.' }));
}
function card(v, play) {
  return el('article', { class: 'as-card', 'data-testid': 'res-card' }, [
    v.thumbnail ? el('img', { src: v.thumbnail, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(el('div', { class: 'as-card-type', text: typeIcon(v.type) })) }) : el('div', { class: 'as-card-type', text: typeIcon(v.type) }),
    el('div', { class: 'as-card-body' }, [el('b', { text: v.title }), el('small', { text: (v.source || '') + (v.type ? ' · ' + v.type : '') }),
      el('div', { class: 'row' }, [play ? el('button', { class: 'btn primary', type: 'button', 'data-testid': 'play-here', onclick: play }, 'Play here') : null,
        el('a', { class: 'btn', href: v.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in browser')])]),
  ]);
}
const typeIcon = (t) => ({ video: '▶', docs: '📘', article: '📄', discussion: '💬', lesson: '🎓' })[t] || '🔗';

/* ============================================================= settings === */
function registerSettingsSections() {
  LS.registerSettings({ id: 'assistant', title: 'Assistant', order: 15, render: renderAssistantSettings });
  LS.registerSettings({ id: 'voice', title: 'Voice', order: 16, render: renderVoiceSettings });
  LS.registerSettings({ id: 'sound', title: 'Sound', order: 17, render: renderSoundSettings });
  LS.registerSettings({ id: 'lantern-look', title: 'Assistant appearance', order: 42, render: renderLookSettings });
  LS.registerSettings({ id: 'display', title: 'Display', order: 44, render: renderDisplaySettings });
}
const field = (label, input, hint) => el('label', { class: 'f' }, [el('span', { text: label }), input, hint ? el('small', { class: 'muted', text: hint }) : null]);
const check = (label, on, fn, testid) => { const c = el('input', { type: 'checkbox', checked: on ? true : null, 'data-testid': testid || null }); c.addEventListener('change', () => fn(c.checked)); return el('label', { class: 'f' }, [c, ' ' + label]); };

async function renderAssistantSettings(box) {
  const ai = await api('/api/assistant/ai');
  const p = A.prefs;
  box.appendChild(check('Show Lantern, the study companion', p.enabled, (v) => savePrefs({ enabled: v, dock: v ? (p.dock === 'hidden' ? 'right' : p.dock) : p.dock }), 'as-enabled'));
  const dock = el('select', {}, [['right', 'On the right'], ['left', 'On the left'], ['bottom', 'Along the bottom'], ['hidden', 'Hidden (the Lantern button shows it)']].map(([v, n]) => el('option', { value: v, selected: p.dock === v ? true : null }, n)));
  dock.addEventListener('change', () => savePrefs({ dock: dock.value }));
  box.appendChild(field('Where it sits', dock));

  box.appendChild(el('h3', { text: 'The AI' }));
  box.appendChild(el('p', { class: 'muted', text: 'An AI lets Lantern explain lessons in its own words, review your code and look things up. Without one, hints, progress, videos and music still work. ' + (ai.ready ? 'Now: ' + ai.label + '.' : 'None is set up yet.') }));
  const sh = ai.shared || {};
  if (sh.exists && !sh.error) {
    const from = sh.updatedBy ? sh.updatedBy.charAt(0).toUpperCase() + sh.updatedBy.slice(1) : 'another app';
    box.appendChild(el('div', { class: 'card', style: 'margin:10px 0' }, [
      el('p', { style: 'margin-top:0' }, ['An AI set up in ', el('b', { text: from }), ' is on this computer (' + sh.provider + (sh.model ? ', ' + sh.model : '') + '). The key stays encrypted here and is never sent between the apps.']),
      check('Use the AI key from ' + from, sh.allowed, async (v) => { try { await api('/api/credentials/consent', { method: 'PUT', body: { useShared: v } }); await savePrefsAI({ useShared: v }); toast('Saved.'); } catch (e) { toast(e.message); } }, 'use-shared'),
    ]));
  } else if (sh.error) box.appendChild(el('p', { class: 'err', text: sh.error }));
  const prov = el('select', { 'data-testid': 'ai-provider' }, [el('option', { value: 'none', selected: ai.provider === 'none' ? true : null }, 'No AI (built-in commands only)')].concat(Object.entries(ai.providers).map(([k, v]) => el('option', { value: k, selected: ai.provider === k ? true : null }, v.label + (k === ai.recommended ? ' — recommended' : '')))));
  const key = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste your key (it is saved encrypted and never shown again)', 'data-testid': 'ai-key' });
  const model = el('input', { type: 'text', placeholder: 'Leave empty for the recommended model', value: ai.provider !== 'none' && ai.model !== 'none' ? ai.model : '' });
  const ollama = el('input', { type: 'url', placeholder: 'http://127.0.0.1:11434' });
  const where = el('p', { class: 'muted' });
  const msg = el('p', { class: 'muted', 'data-testid': 'ai-msg' });
  const paintWhere = () => { const v = ai.providers[prov.value]; where.innerHTML = ''; if (v && v.keyUrl) where.appendChild(el('span', {}, [v.needsKey ? 'Get a key: ' : 'Get it: ', el('a', { href: v.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: v.keyUrl })])); key.disabled = !(v && v.needsKey); ollama.closest('label').hidden = prov.value !== 'ollama'; };
  box.appendChild(field('Which AI', prov));
  box.appendChild(where);
  box.appendChild(field('Key', key, ai.hasKey[prov.value] ? 'A key is already saved for this one. Paste a new one only to replace it.' : ''));
  box.appendChild(field('Model (optional)', model));
  box.appendChild(field('Ollama address', ollama));
  paintWhere();
  prov.addEventListener('change', paintWhere);
  box.appendChild(el('div', { class: 'row' }, [
    el('button', { class: 'btn primary', type: 'button', 'data-testid': 'ai-save', onclick: async () => { try { const r = await api('/api/assistant/ai', { method: 'PUT', body: { provider: prov.value, key: key.value, model: model.value, ollamaUrl: ollama.value || undefined } }); key.value = ''; A.info.ai = r; msg.textContent = r.ready ? 'Saved. ' + r.label + ' is ready.' : 'Saved.'; msg.className = 'ok'; } catch (e) { msg.textContent = e.message; msg.className = 'err'; } } }, 'Save'),
    el('button', { class: 'btn', type: 'button', onclick: async () => { msg.textContent = 'Trying…'; try { const r = await api('/api/assistant/ai/test', { method: 'POST', body: { provider: prov.value, key: key.value || undefined, model: model.value || undefined } }); msg.textContent = r.ok ? 'It works (' + r.model + ', ' + r.ms + ' ms).' : 'It did not work: ' + r.error; msg.className = r.ok ? 'ok' : 'err'; } catch (e) { msg.textContent = e.message; msg.className = 'err'; } } }, 'Test'),
  ]));
  box.appendChild(msg);

  box.appendChild(el('h3', { text: 'Talking to Lantern' }));
  const wake = el('input', { type: 'text', value: p.wakeWord || 'Lantern', maxlength: '30', 'data-testid': 'wake-word' });
  wake.addEventListener('change', () => savePrefs({ wakeWord: wake.value }));
  box.appendChild(field('Wake word', wake, 'Say it before a question: “' + (p.wakeWord || 'Lantern') + ', give me a hint.” Works in Microsoft Edge and Google Chrome.'));
  box.appendChild(check('Listen for the wake word', p.wakeOn, (v) => savePrefs({ wakeOn: v })));
  box.appendChild(check('Say replies out loud', p.speakReplies, (v) => { savePrefs({ speakReplies: v }); if (!v) stopSpeaking(); }));
  const mic = A.info.mic || {};
  box.appendChild(el('p', { class: 'muted', text: A.info.dayspring && !mic.lanternMayListen ? 'Dayspring is running, so it listens for its own name and Lantern does not (only one app listens at a time). The push-to-talk button still works.' : 'Only one app listens at a time. When Dayspring is running, it listens and Lantern waits.' }));
}
async function savePrefsAI(patch) { try { A.info.ai = await api('/api/assistant/ai', { method: 'PUT', body: patch }); } catch (e) { /* shown elsewhere */ } }

async function renderVoiceSettings(box) {
  const v = await api('/api/assistant/voice');
  A.info.voice = v;
  box.appendChild(el('p', { class: 'muted', text: 'Lantern’s voice is warm and friendly. With an ElevenLabs key it uses Will; without one it uses the best free voice on this computer (Microsoft Edge’s natural voices sound great).' }));
  const prov = el('select', { 'data-testid': 'voice-provider' }, [['auto', 'Automatic (ElevenLabs if set up, else free)'], ['browser', 'Free voices on this computer'], ['elevenlabs', 'ElevenLabs'], ['openai', 'OpenAI']].map(([k, n]) => el('option', { value: k, selected: v.settings.provider === k ? true : null }, n)));
  prov.addEventListener('change', async () => { A.info.voice = await api('/api/assistant/voice', { method: 'PUT', body: { provider: prov.value } }); LS.render(); });
  box.appendChild(field('Voices from', prov));
  const status = el('p', { class: 'muted', text: 'Now: ' + (v.provider === 'browser' ? 'free voice' : v.provider) + (v.voiceName ? ' · ' + v.voiceName : '') + (v.ready ? '' : ' (not ready: add its key below)') });
  box.appendChild(status);
  if (v.provider === 'browser') {
    const list = await browserVoices();
    const def = pickBrowserVoice(list, 'lantern');
    const sel = el('select', { 'data-testid': 'browser-voice' }, [el('option', { value: '' }, 'Automatic: ' + (def ? def.name : 'the default voice'))].concat(list.filter((x) => /^en/i.test(x.lang)).map((x) => el('option', { value: x.name, selected: v.settings.browserVoice === x.name ? true : null }, x.name + ' (' + x.lang + ')'))));
    sel.addEventListener('change', async () => { A.info.voice = await api('/api/assistant/voice', { method: 'PUT', body: { browserVoice: sel.value } }); });
    box.appendChild(field('Voice', sel, list.length ? '' : 'This browser has no voices to choose from.'));
    const rate = el('input', { type: 'range', min: '0.7', max: '1.4', step: '0.05', value: String(v.settings.rate || 1) });
    rate.addEventListener('change', async () => { A.info.voice = await api('/api/assistant/voice', { method: 'PUT', body: { rate: Number(rate.value) } }); });
    box.appendChild(field('Speed', rate));
  } else {
    const sel = el('select', { 'data-testid': 'server-voice' }, (v.choices || []).map((n) => el('option', { value: n, selected: v.voiceName === n ? true : null }, n + (v.describe && v.describe[n] ? ' — ' + v.describe[n] : ''))));
    sel.addEventListener('change', async () => { try { A.info.voice = await api('/api/assistant/voice', { method: 'PUT', body: { voice: sel.value } }); } catch (e) { toast(e.message); } });
    box.appendChild(field('Voice', sel));
    const sp = el('input', { type: 'range', min: '-0.3', max: '0.3', step: '0.05', value: String(v.settings.speedAdj || 0) });
    sp.addEventListener('change', async () => { A.info.voice = await api('/api/assistant/voice', { method: 'PUT', body: { speedAdj: Number(sp.value) } }); });
    box.appendChild(field('Speed', sp));
    const vk = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste a key to add or replace it' });
    box.appendChild(field((v.provider === 'openai' ? 'OpenAI' : 'ElevenLabs') + ' key', vk, 'Saved encrypted for this Windows user, and shared with Dayspring only if you allow it there.'));
    box.appendChild(el('button', { class: 'btn', type: 'button', onclick: async () => { if (!vk.value.trim()) return; try { await api('/api/assistant/ai', { method: 'PUT', body: { voiceKey: vk.value, voiceProvider: v.provider } }); vk.value = ''; toast('Saved.'); LS.render(); } catch (e) { toast(e.message); } } }, 'Save key'));
  }
  box.appendChild(el('div', { class: 'row', style: 'margin-top:14px' }, [
    el('button', { class: 'btn primary', type: 'button', 'data-testid': 'voice-preview', onclick: () => { stopSpeaking(); A.info.voice = v; say('Hello, I am Lantern. Shall we pick up where you left off?'); } }, 'Preview'),
    el('button', { class: 'btn', type: 'button', onclick: stopSpeaking }, 'Stop'),
  ]));
}

function renderSoundSettings(box) {
  box.appendChild(el('p', { class: 'muted', text: 'How loud each kind of sound is. The same controls are behind the 🔊 button at the top.' }));
  for (const [k, icon, name, hint, min] of CHANNELS.filter((c) => c[0] !== 'alarm').concat([['master', '🔈', 'Everything', 'all of Lantern’s sound', 0]])) {
    const r = el('input', { type: 'range', min: String(min), max: '100', value: String(A.audio.level(k)), 'data-testid': 'level-' + k });
    const out = el('output', { text: String(A.audio.level(k)) });
    r.addEventListener('input', () => { A.audio.setLevel(k, Number(r.value)); out.textContent = r.value; });
    box.appendChild(el('label', { class: 'f' }, [el('span', { text: icon + ' ' + name }), el('div', { class: 'row' }, [r, out]), el('small', { class: 'muted', text: hint })]));
  }
  box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn', type: 'button', onclick: () => testSound('sounds') }, 'Test a chime'), el('button', { class: 'btn', type: 'button', onclick: () => testSound('voice') }, 'Test the voice'), el('button', { class: 'btn', type: 'button', onclick: () => A.panel.open() }, 'Open the sound panel')]));
  box.appendChild(el('p', { class: 'muted', text: 'Music and videos get quieter by themselves while Lantern is talking. Lantern never changes which speakers or microphone the computer uses.' }));
}

function renderLookSettings(box) {
  const a = A.prefs.avatar;
  const preview = el('div', { class: 'as-preview ln-lampglow' });
  box.appendChild(preview);
  const lamp = mountLantern(preview, Object.assign({ size: 220, label: 'Preview of Lantern' }, avatarOptions(a)));
  const set = async (patch) => { await savePrefs({ avatar: patch }); lamp.setOptions(avatarOptions(A.prefs.avatar)); paintValues(); };
  box.appendChild(el('div', { class: 'row', role: 'group', 'aria-label': 'Try a state' }, ['idle', 'listen', 'think', 'speak', 'off'].map((s) => el('button', { class: 'btn quiet', type: 'button', onclick: () => { lamp.setState(s); if (s === 'speak') { let n = 0; const t = setInterval(() => { lamp.setLevel(0.2 + Math.random() * 0.6); if (++n > 30) { clearInterval(t); lamp.setLevel(0); } }, 100); } } }, s.charAt(0).toUpperCase() + s.slice(1)))));
  box.appendChild(el('h3', { text: 'Presets' }));
  box.appendChild(el('div', { class: 'row', 'data-testid': 'presets' }, Object.entries(PRESETS).map(([k, p]) => el('button', { class: 'btn' + (a.preset === k ? ' primary' : ''), type: 'button', 'data-preset': k, onclick: async () => { await set({ preset: k }); box.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('primary', b.dataset.preset === k)); } }, [el('span', { class: 'swatch', style: 'background:' + p.flameOuter }), ' ' + p.label]))));
  box.appendChild(el('h3', { text: 'Colours and light' }));
  const cur = () => Object.assign({}, PRESETS[A.prefs.avatar.preset] || PRESETS.classic, avatarOptions(A.prefs.avatar));
  const colours = [['flameInner', 'Flame (inside)'], ['flameOuter', 'Flame (outside)'], ['glassTint', 'Glass'], ['glowColor', 'Glow']];
  const inputs = {};
  box.appendChild(el('div', { class: 'grid as-look' }, colours.map(([k, n]) => { const i = el('input', { type: 'color', value: cur()[k], 'data-testid': 'look-' + k }); i.addEventListener('change', () => set({ [k]: i.value })); inputs[k] = i; return field(n, i); }).concat([
    (() => { const s = el('select', { 'data-testid': 'look-metal' }, Object.keys(METALS).map((m) => el('option', { value: m, selected: cur().metal === m ? true : null }, m.charAt(0).toUpperCase() + m.slice(1)))); s.addEventListener('change', () => set({ metal: s.value })); inputs.metal = s; return field('Frame', s); })(),
  ])));
  const sliders = [['glowIntensity', 'Glow brightness', 0, 2, 0.05], ['glowRadius', 'Glow size', 0.4, 2, 0.05], ['flicker', 'Flicker', 0, 1, 0.05], ['size', 'Size in the panel', 80, 320, 10]];
  for (const [k, n, lo, hi, st] of sliders) {
    const r = el('input', { type: 'range', min: String(lo), max: String(hi), step: String(st), value: String(k === 'size' ? A.prefs.avatar.size : cur()[k]), 'data-testid': 'look-' + k });
    r.addEventListener('change', () => { set({ [k]: Number(r.value) }); if (k === 'size') document.documentElement.style.setProperty('--as-lamp', r.value + 'px'); });
    if (k !== 'size') r.addEventListener('input', () => lamp.setOptions({ [k]: Number(r.value) }));
    inputs[k] = r;
    box.appendChild(field(n, r));
  }
  box.appendChild(check('Light rays while speaking', a.rays, (v) => set({ rays: v })));
  box.appendChild(check('Embers while thinking', a.embers, (v) => set({ embers: v })));
  const rm = el('select', {}, [['auto', 'Follow the computer'], ['true', 'Calm (almost still)'], ['false', 'Full motion']].map(([v, n]) => el('option', { value: v, selected: String(a.reducedMotion) === v ? true : null }, n)));
  rm.addEventListener('change', () => set({ reducedMotion: rm.value === 'auto' ? 'auto' : rm.value === 'true' }));
  box.appendChild(field('Motion', rm));
  box.appendChild(el('button', { class: 'btn', type: 'button', onclick: async () => { await savePrefs({ reset: 'avatar' }); lamp.setOptions(Object.assign({}, PRESETS.classic, avatarOptions(A.prefs.avatar))); paintValues(); } }, 'Back to the classic lantern'));
  function paintValues() { const c = cur(); for (const [k] of colours) if (inputs[k]) inputs[k].value = c[k]; if (inputs.metal) inputs.metal.value = c.metal; for (const [k] of sliders) if (inputs[k]) inputs[k].value = String(k === 'size' ? A.prefs.avatar.size : c[k]); }
}

function renderDisplaySettings(box) {
  const d = A.prefs.display;
  box.appendChild(el('p', { class: 'muted', text: 'Make everything bigger or smaller, and leave room at the edges for a TV that cuts them off.' }));
  const rows = [['uiScale', 'Size of everything', 70, 160, 5, '%'], ['textScale', 'Text size', 70, 180, 5, '%'], ['marginTop', 'Top edge', 0, 15, 0.5, '%'], ['marginBottom', 'Bottom edge', 0, 15, 0.5, '%'], ['marginLeft', 'Left edge', 0, 15, 0.5, '%'], ['marginRight', 'Right edge', 0, 15, 0.5, '%']];
  for (const [k, n, lo, hi, st, u] of rows) {
    const r = el('input', { type: 'range', min: String(lo), max: String(hi), step: String(st), value: String(d[k]), 'data-testid': 'display-' + k });
    const out = el('output', { text: d[k] + u });
    r.addEventListener('input', () => { out.textContent = r.value + u; A.layout.apply(Object.assign(displayPrefs(), { [k]: Number(r.value) })); });
    r.addEventListener('change', () => savePrefs({ display: { [k]: Number(r.value) } }));
    box.appendChild(el('label', { class: 'f' }, [el('span', { text: n }), el('div', { class: 'row' }, [r, out])]));
  }
  box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn', type: 'button', onclick: () => A.layout.openFit() }, 'Fit to screen…'), el('button', { class: 'btn', type: 'button', onclick: async () => { await savePrefs({ reset: 'display' }); LS.render(); } }, 'Reset')]));
}

start();
