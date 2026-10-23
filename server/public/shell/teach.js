/* ===========================================================================
   server/public/shell/teach.js — teaching with the course's own visuals, in the chat.
   ---------------------------------------------------------------------------
   The tutor's reply streams in. Visuals arrive as actions the moment their
   tools return (a figure, a demonstration, an equation, a passage, a worked
   example, a sketch, a derivation), each a small frame of the course page
   drawn by the course's own code (app/course/teach.js). The words carry cue
   markers in the lesson videos' style,

       The backsight goes on the benchmark. [[c1:hl bs]] It adds … [[c1:step 2]]

   and each cue fires when the text reaches it. Afterwards a Step / Replay
   control lets the learner go back over it. Nothing else is added to the chat.

     CueReader          incremental: feed(chunk) → visible text + cues, marker split across chunks held back
     stripCues(text)    the words without cues (for speech and plain views)
     chatStream(...)    POST /api/assistant/chat-stream (lines of JSON)
     Turn               one reply on screen: cards, streaming text, cue firing, replay
   =========================================================================== */

const CUE = /\[\[([a-z]\d{1,2}):([^\]\n]{1,80})\]\]/g;

export function stripCues(text) {
  return String(text || '').replace(/\[\[(?:[a-z]\d{1,2}:)?[^\]\n]{0,80}\]\]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim();
}

/* feed(chunk) → { text, cues: [{ at (in the text so far), card, cue }] }. A marker that is not finished is kept for the next chunk. */
export class CueReader {
  constructor() { this.held = ''; this.len = 0; }
  feed(chunk) {
    let s = this.held + String(chunk || '');
    this.held = '';
    const open = s.lastIndexOf('[[');
    if (open >= 0 && s.indexOf(']]', open) < 0 && s.length - open <= 90) { this.held = s.slice(open); s = s.slice(0, open); }
    else if (s.endsWith('[')) { this.held = '['; s = s.slice(0, -1); }
    const cues = [];
    let text = '', last = 0;
    s.replace(CUE, (m, card, body, at) => {
      text += s.slice(last, at);
      cues.push({ at: this.len + text.length, card, cue: body.trim() });
      last = at + m.length;
      return m;
    });
    text += s.slice(last);
    this.len += text.length;
    return { text, cues };
  }
  flush() { const t = this.held; this.held = ''; return t.startsWith('[') ? '' : t; }
}

export async function chatStream(body, hooks) {
  const h = hooks || {};
  const res = await fetch('/api/assistant/chat-stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok || !res.body) throw new Error('stream ' + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      if (ev.t === 'text' && h.onText) h.onText(ev.s, ev.ms);
      else if (ev.t === 'action' && h.onAction) h.onAction(ev.a, ev.ms);
      else if (ev.t === 'done') done = ev.out;
    }
  }
  if (!done) throw new Error('stream ended early');
  return done;
}

const KIND_NAME = { figure: 'Figure', demo: 'Try it', equation: 'Equation', passage: 'From the lesson', example: 'Worked example', draw: 'Sketch', derive: 'Derivation' };

/* ---------------------------------------------------------------- a card --- */
class Card {
  constructor(a, ctx) {
    this.a = a; this.ctx = ctx; this.ready = false; this.queue = [];
    const { el } = ctx;
    this.frame = el('iframe', { class: 'as-tframe', title: (KIND_NAME[a.kind] || 'Figure') + ': ' + (a.title || a.name || ''), 'data-testid': 'teach-frame', 'data-card': a.card, 'data-kind': a.kind, loading: 'eager' });
    this.frame.style.height = '150px';
    this.frame.src = '/packs/' + encodeURIComponent(a.course) + '/index.html?host=lantern&lantern-teach=1&day=' + (ctx.day() ? 1 : 0);
    const open = ctx.canOpen(a) ? el('button', { class: 'btn quiet as-topen', type: 'button', 'data-testid': 'teach-open', title: 'Go to ' + (a.home ? a.home.title : 'the lesson') + ', to this' }, 'Open in the lesson') : null;
    if (open) open.addEventListener('click', () => ctx.open(a));
    this.root = el('figure', { class: 'as-tcard', 'data-testid': 'teach-card', 'data-kind': a.kind, 'data-card': a.card }, [
      el('figcaption', { class: 'as-thead' }, [el('b', { text: KIND_NAME[a.kind] || 'Figure' }), el('small', { text: a.title || a.name || '' })]),
      this.frame, open,
    ]);
    this.fired = 0;
  }
  init() { this.post({ lantern: 'teach-init', card: this.a, day: this.ctx.day() }); }
  post(m) { try { this.frame.contentWindow.postMessage(m, location.origin); } catch (e) { /* not there yet */ } }
  cue(text) {
    this.fired++;
    // a small trail the tests read: which cue fired, and how much of the words had been read
    try { (window.__teachLog = window.__teachLog || []).push({ card: this.a.card, cue: text, at: Math.round(performance.now()), read: this.ctx.read ? this.ctx.read() : null }); } catch (e) { /* fine */ }
    if (this.ready) this.post({ lantern: 'teach-cue', cue: text }); else this.queue.push(text);
  }
  reset() { this.fired = 0; this.post({ lantern: 'teach-cue', cue: 'reset' }); this.queue = []; }
  showAll() { this.post({ lantern: 'teach-all' }); }
  onReady() { this.ready = true; this.queue.splice(0).forEach((c) => this.post({ lantern: 'teach-cue', cue: c })); }
}

/* ----------------------------------------------------------------- a turn --- */
export class Turn {
  /* ctx: { el, md, day(), canOpen(a), open(a), videoCard(a) → element, playVideo(a), addMsg, attach(m, words), scroll(m) } */
  constructor(ctx) {
    this.ctx = ctx; this.cards = {}; this.videos = {}; this.reader = new CueReader(); this.cues = []; this.m = null; this.said = '';
    this.t = { start: performance.now(), firstVisual: null, firstText: null };
    this.timers = [];
  }
  ensure() {
    if (this.m) return this.m;
    const { el } = this.ctx;
    this.vis = el('div', { class: 'as-vis' });
    this.body = el('p', { class: 'as-streaming', 'data-testid': 'msg-stream' });
    this.m = this.ctx.addMsg('lantern', '', { stream: true });
    this.m.classList.add('teach', 'streaming');
    Array.from(this.m.children).forEach((n) => { if (!n.textContent.trim() && !n.querySelector('iframe')) n.remove(); });
    this.m.insertBefore(this.vis, this.m.firstChild);
    this.m.appendChild(this.body);
    window.addEventListener('message', this.onMsg = (e) => this.message(e));
    return this.m;
  }
  message(e) {
    if (e.origin !== location.origin) return;
    const d = e.data || {};
    for (const c of Object.values(this.cards)) {
      if (c.frame.contentWindow !== e.source) continue;
      if (d.lantern === 'teach-hello') c.init();
      else if (d.lantern === 'teach-ready') { c.onReady(); }
      else if (d.lantern === 'teach-size' && Number(d.h) > 0) { c.frame.style.height = Math.min(Math.round(Number(d.h)) + 2, Math.round(window.innerHeight * 0.8)) + 'px'; }
    }
  }
  action(a) {
    if (a.type === 'teach') {
      this.ensure();
      const c = new Card(a, this.ctx);
      this.cards[a.card] = c;
      c.ctx = Object.assign({}, this.ctx, { read: () => this.said.length });
      this.vis.appendChild(c.root);
      if (this.t.firstVisual == null) this.t.firstVisual = performance.now() - this.t.start;
      this.ctx.scroll(this.m);
      return true;
    }
    if (a.type === 'course-video' && a.card) {
      this.ensure();
      const node = this.ctx.videoCard(a);
      this.videos[a.card] = { a, node };
      this.vis.appendChild(node);
      if (this.t.firstVisual == null) this.t.firstVisual = performance.now() - this.t.start;
      return true;
    }
    return false;
  }
  text(chunk) {
    this.ensure();
    if (this.t.firstText == null) this.t.firstText = performance.now() - this.t.start;
    const r = this.reader.feed(chunk);
    this.said += r.text;
    this.body.textContent = this.said;
    for (const c of r.cues) { this.cues.push(Object.assign({ at: c.at }, c)); this.fire(c); }
    this.ctx.scroll(this.m);
  }
  fire(c) {
    const card = this.cards[c.card];
    if (card) { card.cue(c.cue); return; }
    const v = this.videos[c.card];
    if (v) this.ctx.cueVideo(v.a, v.node, c.cue);
  }
  /* the reply is complete: markdown, the cue anchors, the Step / Replay control */
  finish(reply, extras) {
    if (!this.m && !reply) return null;
    this.ensure();
    const { el } = this.ctx;
    const final = String(reply || '');
    // the reply as the server checked it: its cues are the ones that stay
    const cues = []; let plain = '', last = 0;
    final.replace(CUE, (m, card, body, at) => { plain += final.slice(last, at) + '' + cues.length + ''; cues.push({ card, cue: body.trim() }); last = at + m.length; return m; });
    plain += final.slice(last);
    this.body.remove();
    const html = this.ctx.md(plain || ' ');
    html.classList.add('as-answer');
    this.m.appendChild(html);
    // zero-width anchors where the cues were
    const walker = document.createTreeWalker(html, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      if (!/\d+/.test(n.nodeValue)) continue;
      const frag = document.createDocumentFragment();
      n.nodeValue.split(/(\d+)/).forEach((p) => {
        const k = /^(\d+)$/.exec(p);
        if (k) frag.appendChild(el('span', { class: 'as-cue', 'data-cue': k[1], 'aria-hidden': 'true' }));
        else if (p) frag.appendChild(document.createTextNode(p));
      });
      n.parentNode.replaceChild(frag, n);
    }
    this.cues = cues;
    // a card nobody cued stays whole; one that was walked through is left where the words ended
    for (const c of Object.values(this.cards)) if (!c.fired) c.showAll();
    for (const x of extras || []) this.m.appendChild(x);
    if (cues.length) this.m.appendChild(this.controls());
    window.removeEventListener('message', this.onMsg);
    window.addEventListener('message', this.onMsg);   // cards keep reporting their size
    this.m.classList.remove('streaming');
    this.ctx.scroll(this.m);
    return this.m;
  }
  /* ◀ Step ▶ and Replay: go back over the reply, a cue at a time or paced */
  controls() {
    const { el } = this.ctx;
    const count = el('span', { class: 'as-stepn', 'aria-live': 'polite', text: this.cues.length + ' steps' });
    const back = el('button', { class: 'btn quiet', type: 'button', 'data-testid': 'teach-back', 'aria-label': 'Previous step' }, '◀');
    const next = el('button', { class: 'btn quiet', type: 'button', 'data-testid': 'teach-next', 'aria-label': 'Next step' }, '▶');
    const replay = el('button', { class: 'btn quiet', type: 'button', 'data-testid': 'teach-replay' }, '↻ Replay');
    this.pos = this.cues.length;
    const go = (i) => {
      this.stopTimers();
      i = Math.max(0, Math.min(this.cues.length, i));
      for (const c of Object.values(this.cards)) c.reset();
      for (let k = 0; k < i; k++) this.fire(this.cues[k]);
      this.pos = i;
      count.textContent = i ? 'Step ' + i + ' of ' + this.cues.length : 'Start';
      this.mark(i - 1);
      // not `disabled`: a button that goes dead under the finger drops the keyboard focus
      back.setAttribute('aria-disabled', String(i <= 0)); next.setAttribute('aria-disabled', String(i >= this.cues.length));
    };
    back.addEventListener('click', () => { if (this.pos > 0) go(this.pos - 1); });
    next.addEventListener('click', () => { if (this.pos < this.cues.length) go(this.pos + 1); });
    replay.addEventListener('click', () => {
      go(0);
      let i = 0;
      const tick = () => { if (i >= this.cues.length) return; go(i + 1); i++; this.timers.push(setTimeout(tick, 1600)); };
      this.timers.push(setTimeout(tick, 400));
    });
    this.go = go;
    return el('div', { class: 'as-cuebar', 'data-testid': 'teach-controls', role: 'group', 'aria-label': 'Go back over this answer' }, [back, count, next, replay]);
  }
  stopTimers() { this.timers.splice(0).forEach(clearTimeout); }
  /* the words that led to cue i are marked (CSS custom highlight), and scrolled to */
  mark(i) {
    const hl = typeof CSS !== 'undefined' && CSS.highlights;
    if (hl) hl.delete('as-cue-text');
    this.m.querySelectorAll('.as-cue.on').forEach((n) => n.classList.remove('on'));
    if (i < 0) return;
    const at = this.m.querySelector('.as-cue[data-cue="' + i + '"]');
    if (!at) return;
    at.classList.add('on');
    if (hl && typeof Highlight !== 'undefined') {
      const prev = i > 0 ? this.m.querySelector('.as-cue[data-cue="' + (i - 1) + '"]') : null;
      const r = document.createRange();
      try {
        if (prev) r.setStartAfter(prev); else r.setStart(at.closest('.as-answer') || this.m, 0);
        r.setEndBefore(at);
        hl.set('as-cue-text', new Highlight(r));
      } catch (e) { /* the marker still shows */ }
    }
  }
}
