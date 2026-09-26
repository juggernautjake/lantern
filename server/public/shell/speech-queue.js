/* ===========================================================================
   server/public/shell/speech-queue.js — one voice at a time, and Stop means stop.
   ---------------------------------------------------------------------------
     const q = createSpeechQueue({ speak, onStart, onEnd, peerBusy });
     q.say(text)      queued behind anything already being said
     q.stop()         now: what is playing and everything queued

   Every stop() bumps a generation number. Whatever was queued or is half
   spoken under an older generation is dropped: speak(text, stale) is handed a
   stale() function and must stop (and never start the next sentence) once it
   returns true. That is what makes Stop reliable even with the browser's own
   voices, whose cancel() fires an error that would otherwise start the next
   sentence.

   peerBusy(): another app (Dayspring) is talking — wait for it (up to a
   minute) before starting, so the two never talk over each other.

   No DOM, no Node: the page uses it, and the tests run it in Node.
   =========================================================================== */

export function createSpeechQueue(opts) {
  const o = opts || {};
  const speak = o.speak;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const peerBusy = o.peerBusy || (() => false);
  const maxWait = o.maxWait || 60000;
  let gen = 0;
  let busy = false;
  const queue = [];

  function say(text, meta) {
    const t = String(text || '').trim();
    if (!t) return false;
    queue.push({ text: t, gen, meta: meta || null });
    pump();
    return true;
  }

  function stop() {
    gen++;
    queue.length = 0;
    const was = busy;
    busy = false;
    if (was && o.onEnd) o.onEnd({ stopped: true });
    return gen;
  }

  async function pump() {
    if (busy) return;
    const item = queue.shift();
    if (!item) return;
    if (item.gen !== gen) { pump(); return; }
    for (let waited = 0; peerBusy() && item.gen === gen && waited < maxWait; waited += 250) await sleep(250);
    if (item.gen !== gen || busy) { if (item.gen === gen) queue.unshift(item); pump(); return; }
    busy = true;
    const mine = item.gen;
    const stale = () => mine !== gen;
    if (o.onStart) o.onStart(item);
    try { await speak(item.text, stale, item); } catch (e) { /* the next one still gets its turn */ }
    if (!stale()) { busy = false; if (o.onEnd) o.onEnd({ stopped: false }); }
    pump();
  }

  return {
    say, stop, pump,
    get generation() { return gen; },
    get busy() { return busy; },
    get length() { return queue.length; },
  };
}
