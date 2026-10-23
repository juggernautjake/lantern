/* ===========================================================================
   server/public/shell/speech-queue.js — one voice at a time, the newest answer
   first, and Stop means stop.
   ---------------------------------------------------------------------------
     const q = createSpeechQueue({ speak, onStart, onEnd, onCancel, peerBusy });
     q.say(text, { kind, id, maxAge })
     q.cancel(test)   drop what matches test(item), queued or being said
     q.stop()         now: what is playing and everything queued
     voiceChunks(text)  a long answer in pieces for the server voice (below)

   Two kinds of things are said:
     reply   an answer the learner asked for (a chat reply, a quiz review, a
             replay). A new reply replaces the one being said and any still
             waiting: the learner has moved on, so the old answer stops at once
             and the new one goes first. It lets a short note being said finish.
     note    an announcement (a milestone, a reminder) — the default. Notes wait
             their turn behind whatever is being said, in order, and one that
             has waited longer than maxAge (if given) is dropped unsaid.

   Every stop() bumps a generation number, and a cancelled item is marked.
   speak(text, stale, item) is handed a stale() function and must stop (and
   never start the next sentence) once it returns true. That is what makes
   Stop reliable even with the browser's own voices, whose cancel() fires an
   error that would otherwise start the next sentence. onCancel(item) is told
   at once when the item being said is cancelled, so the page can silence it
   without waiting for speak() to notice.

   onEnd({ stopped, more }): more is true when something else is about to be
   said straight after, so the page need not flicker back to idle between.

   peerBusy(): another app (Dayspring) is talking — wait for it (up to a
   minute) before starting, so the two never talk over each other.

   No DOM, no Node: the page uses it, and the tests run it in Node.
   =========================================================================== */

export function createSpeechQueue(opts) {
  const o = opts || {};
  const speak = o.speak;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || (() => Date.now());
  const peerBusy = o.peerBusy || (() => false);
  const maxWait = o.maxWait || 60000;
  let gen = 0;
  let busy = false;
  let pumping = false;
  let current = null;
  const queue = [];

  const stale = (item) => item.gen !== gen || item.cancelled;
  const expired = (item) => item.maxAge > 0 && now() - item.at > item.maxAge;
  function prune() {
    for (let i = queue.length - 1; i >= 0; i--) if (stale(queue[i]) || expired(queue[i])) queue.splice(i, 1);
  }

  function say(text, meta) {
    const t = String(text || '').trim();
    if (!t) return null;
    const m = meta || {};
    const item = { text: t, gen, kind: m.kind === 'reply' ? 'reply' : 'note', id: m.id == null ? null : m.id, maxAge: Number(m.maxAge) || 0, at: now(), meta: m, cancelled: false };
    if (item.kind === 'reply') {
      cancel((x) => x.kind === 'reply');
      queue.unshift(item);           // ahead of the notes still waiting
    } else queue.push(item);
    pump();
    return item;
  }

  function cancel(test) {
    let n = 0;
    for (let i = queue.length - 1; i >= 0; i--) if (test(queue[i])) { queue[i].cancelled = true; queue.splice(i, 1); n++; }
    if (current && !current.cancelled && test(current)) {
      const cur = current;
      cur.cancelled = true; n++;
      current = null;                // no longer what is being said, even before speak() notices
      if (o.onCancel) { try { o.onCancel(cur); } catch (e) { /* the speaker notices by itself */ } }
    }
    return n;
  }

  function stop() {
    gen++;
    queue.length = 0;
    const was = busy;
    busy = false;
    current = null;
    if (was && o.onEnd) o.onEnd({ stopped: true, more: false });
    return gen;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        prune();
        for (let waited = 0; queue.length && peerBusy() && waited < maxWait; waited += 250) { await sleep(250); prune(); }
        if (!queue.length) break;
        const item = queue.shift();
        current = item; busy = true;
        if (o.onStart) o.onStart(item);
        try { await speak(item.text, () => stale(item), item); } catch (e) { /* the next one still gets its turn */ }
        if (current === item) current = null;
        if (item.gen === gen) {            // after a stop(), stop() has already said it ended
          busy = false;
          prune();
          if (o.onEnd) o.onEnd({ stopped: item.cancelled, more: queue.length > 0, item });
        }
      }
    } finally { pumping = false; }
  }

  return {
    say, cancel, stop, pump,
    get generation() { return gen; },
    get busy() { return busy; },
    get length() { return queue.length; },
    get current() { return current; },
  };
}

/* A long answer, cut into pieces for the server voice: the first short (it
   starts sooner), the rest longer. Cut only after a sentence — never inside
   "3.5", after a list number ("1. "), an initial ("e.g. "), or inside $math$ or brackets. */
export function voiceChunks(text, first, rest) {
  const s = String(text || '').trim();
  const lim1 = first || 160, lim2 = rest || 420;
  const cuts = [];
  const re = /[.!?…]["')\]]*\s+|\n\s*\n/g;
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(0, m.index);
    if (/[.!?…]/.test(m[0]) && /(?:^|[\s(])(?:\d+|[A-Za-z]|[a-z]\.[a-z]|etc|vs|approx|Fig|Dr|Mr|Mrs|Ms)$/.test(before)) continue;
    const head = s.slice(0, m.index + m[0].length);
    if ((head.split('$').length - 1) % 2) continue;
    let depth = 0; for (const c of head) { if (c === '(' || c === '[' || c === '{') depth++; else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--; }
    if (depth) continue;
    cuts.push(m.index + m[0].length);
  }
  const out = [];
  let from = 0, last = 0;
  for (const c of cuts) {
    const limit = out.length ? lim2 : lim1;
    if (c - from > limit && last > from) { out.push(s.slice(from, last).trim()); from = last; }
    last = c;
  }
  if (s.length - from > (out.length ? lim2 : lim1) && last > from) { out.push(s.slice(from, last).trim()); from = last; }
  out.push(s.slice(from).trim());
  return out.filter(Boolean);
}
