/* ===========================================================================
   server/public/shell/wake.js — hearing "Lantern", every time.
   ---------------------------------------------------------------------------
     const w = createWakeListener({ Recognition, wakeWord, onWake, onCommand, … });
     w.start()   listen for the wake word, and keep listening
     w.stop()    stop for good (the person turned it off, or Dayspring has the mic)
     w.pause()   for push-to-talk, which needs the microphone to itself
   opts.onAsk(done)  the name was said on its own: record the request (and call
                     done() after, which gives the microphone back)
     w.resume()

   What used to go wrong, and what this does about it:

   • The name only counted at the very start of a phrase. The browser often
     hands back "so Lantern what's next", "lanterns what's next", "lantren …"
     or "lan tern …". matchWake() finds the name anywhere in the phrase and
     forgives the near misses a recogniser makes, then takes what follows it
     as the request.
   • Nothing happened until the browser decided the phrase was over. Partial
     results are read as they arrive: the moment the name is heard, Lantern
     lights up and chimes, and the request goes when the phrase is final.
   • The browser's listener ends on its own — after silence, after about a
     minute, on a network blip — and one failed restart left Lantern deaf until
     the page was reloaded. Every end is followed by a restart (backing off if
     it keeps failing), and a watchdog checks every few seconds that it really
     is listening, recycling a session that has gone quiet for too long.
   • It stopped listening while it spoke, so it could not be interrupted. Now it
     keeps listening; while it is speaking, only its name counts (and not when
     the name is in what it is saying itself).

   No DOM: the page passes in the browser's SpeechRecognition, the tests pass in
   a fake one.
   =========================================================================== */

/* ---------------------------------------------------------- the name --- */

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const clean = (w) => String(w || '').toLowerCase().replace(/[’']s$/, '').replace(/[^a-z0-9]/g, '');

// How far a heard word may be from the name and still be it: one letter for a
// short name, two for a longer one ("lantern" → "lanterns", "lantren", "lanton").
function close(heard, name) {
  if (!heard || !name) return false;
  if (heard === name) return true;
  if (Math.abs(heard.length - name.length) > 2) return false;
  const allow = name.length >= 6 ? 2 : name.length >= 4 ? 1 : 0;
  return heard[0] === name[0] && lev(heard, name) <= allow;
}

/* Is the name in what was heard? → { at, rest } or null.
   `rest` is the request after it, without the "hey" or the comma. */
export function matchWake(transcript, wakeWord) {
  const name = clean(String(wakeWord || 'Lantern').replace(/\s+/g, ''));
  const words = String(transcript || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const one = clean(words[i]);
    const two = i + 1 < words.length ? one + clean(words[i + 1]) : '';
    let used = 0;
    if (close(one, name)) used = 1;
    else if (two && close(two, name)) used = 2;            // "lan tern"
    if (!used) continue;
    const rest = words.slice(i + used).join(' ').replace(/^[,.!?;:\s]+/, '').trim();
    return { at: i, rest };
  }
  return null;
}

/* ------------------------------------------------------ the listener --- */

export function createWakeListener(o) {
  const opts = o || {};
  const R = opts.Recognition;
  const T = opts.timers || { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t), every: (f, ms) => setInterval(f, ms), stopEvery: (t) => clearInterval(t) };
  const now = opts.now || (() => Date.now());
  const wakeWord = opts.wakeWord || (() => 'Lantern');
  const isSpeaking = opts.isSpeaking || (() => false);
  const speakingText = opts.speakingText || (() => '');
  const onWake = opts.onWake || (() => {});
  const onCommand = opts.onCommand || (() => {});
  const onIdle = opts.onIdle || (() => {});
  const onState = opts.onState || (() => {});
  const onBlocked = opts.onBlocked || (() => {});
  const FOLLOW_MS = opts.followMs || 10000;               // say the name, pause, then ask
  const STALE_MS = opts.staleMs || 90000;                 // a session silent this long is recycled
  const WATCH_MS = opts.watchMs || 3000;

  let wanted = false, paused = false, rec = null, listening = false, starting = false;
  let lastAlive = 0, failures = 0, retry = null, watch = null;
  let armedAt = 0;               // the name was heard; the request may come in the next phrase
  let armedUtterance = -1;       // which phrase chimed already (so one phrase chimes once)
  let utterance = 0;

  function state(s) { onState(s); }

  function make() {
    const r = new R();
    r.continuous = true;
    r.interimResults = true;
    r.lang = opts.lang || 'en-US';
    r.maxAlternatives = 3;
    r.onstart = () => { starting = false; listening = true; failures = 0; lastAlive = now(); state('listening'); };
    r.onaudiostart = () => { lastAlive = now(); };
    r.onspeechstart = () => { lastAlive = now(); };
    r.onresult = (e) => { lastAlive = now(); results(e); };
    r.onerror = (e) => {
      const why = e && e.error;
      if (why === 'not-allowed' || why === 'service-not-allowed') { wanted = false; onBlocked(why); state('blocked'); }
      else if (why !== 'no-speech' && why !== 'aborted') failures++;
    };
    r.onend = () => {
      if (rec !== r) return;                               // replaced or stopped
      rec = null;                                          // every session gets a fresh listener: a stalled one is not reused
      listening = false; starting = false;
      state('stopped');
      schedule();
    };
    return r;
  }

  function begin() {
    if (!wanted || paused || listening || starting || !R) return;
    if (!rec) rec = make();
    starting = true;
    try { rec.start(); }
    catch (e) {
      // "already started" means it is running; anything else: a fresh one next time
      starting = false;
      if (!/already|started/i.test(String(e && e.message))) { rec = null; failures++; schedule(); }
      else listening = true;
    }
  }
  // Restart soon after any end; back off if it keeps failing (never stop trying).
  function schedule() {
    if (!wanted || paused) return;
    if (retry) T.clear(retry);
    const wait = Math.min(250 * Math.pow(2, Math.min(failures, 4)), 4000);
    retry = T.set(() => { retry = null; begin(); }, wait);
  }

  function results(e) {
    const list = e.results;
    for (let i = e.resultIndex; i < list.length; i++) {
      const r = list[i];
      const alts = [];
      for (let k = 0; k < (r.length || 1); k++) if (r[k] && r[k].transcript) alts.push(String(r[k].transcript));
      if (!alts.length) continue;
      // the name in any of the recogniser's guesses counts
      let hit = null, text = alts[0];
      for (const a of alts) { const m = matchWake(a, wakeWord()); if (m) { hit = m; text = a; break; } }
      // while Lantern talks, it must not wake itself up by saying its own name
      if (hit && isSpeaking() && matchWake(speakingText(), wakeWord())) hit = null;
      if (hit && armedUtterance !== utterance) { armedUtterance = utterance; onWake({ interim: !r.isFinal }); }
      if (!r.isFinal) continue;
      utterance++;
      if (hit) {
        if (hit.rest) { armedAt = 0; onCommand(hit.rest); }
        else if (opts.onAsk) {
          // "Lantern." … then the request, as its own phrase. The browser often
          // ends this session at the pause, and words said while it restarts
          // were lost — so the request gets a recording of its own, which
          // says when it is ready and hands the microphone back after.
          armedAt = 0;
          this_.pause();
          opts.onAsk(() => this_.resume());
          return;
        } else armedAt = now();
      } else if (armedAt && now() - armedAt < FOLLOW_MS && !isSpeaking()) {
        armedAt = 0; onCommand(text.trim());
      }
    }
  }

  function watchdog() {
    if (!wanted || paused) return;
    if (armedAt && now() - armedAt >= FOLLOW_MS) { armedAt = 0; onIdle(); }
    if (!listening && !starting && !retry) begin();
    else if (listening && now() - lastAlive > STALE_MS && rec) { try { rec.abort(); } catch (e) { /* gone */ } }
  }

  const this_ = {
    start() {
      if (!R) return false;
      wanted = true; paused = false;
      begin();
      if (!watch) watch = T.every(watchdog, WATCH_MS);
      return true;
    },
    stop() {
      wanted = false; armedAt = 0;
      if (retry) { T.clear(retry); retry = null; }
      if (watch) { T.stopEvery(watch); watch = null; }
      const r = rec; rec = null; listening = false; starting = false;
      if (r) { try { r.abort(); } catch (e) { /* gone */ } }
      state('off');
    },
    pause() {
      paused = true;
      if (retry) { T.clear(retry); retry = null; }
      const r = rec; rec = null; listening = false; starting = false;
      if (r) { try { r.abort(); } catch (e) { /* gone */ } }
    },
    resume() { if (!wanted) return; paused = false; begin(); },
    kick() { watchdog(); },                                 // the page came back into view
    get listening() { return listening; },
    get wanted() { return wanted; },
    get awaiting() { return !!armedAt; },
  };
  return this_;
}

/* ------------------------------------------------- recording a request --- */
/* One request, start to finish. Used after the name is said on its own and by
   the push-to-talk button.

     recordRequest({ Recognition, onReady, onText, onDone })

   onReady()      the microphone is really recording — the moment to chime
   onText(text)   what has been heard so far (shown in the box as you speak)
   onDone(text)   the request, or null when nothing was heard — called once

   It does not stop at the first pause: it waits until you have stopped
   talking for a moment (pauseMs), gives up if you say nothing (silenceMs),
   and never runs past maxMs. */
export function recordRequest(o) {
  const opts = o || {};
  const R = opts.Recognition;
  const T = opts.timers || { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) };
  const now = opts.now || (() => Date.now());
  const PAUSE = opts.pauseMs || 1600, SILENCE = opts.silenceMs || 8000, MAX = opts.maxMs || 30000;
  let finalText = '', interim = '', heardAt = 0, startedAt = now(), done = false, ready = false, stopping = false;
  let tick = null, safety = null;
  const finish = (why) => {
    if (done) return;
    done = true;
    if (tick) T.clear(tick);
    if (safety) T.clear(safety);
    const text = (finalText + ' ' + interim).replace(/\s+/g, ' ').trim();
    (opts.onDone || (() => {}))(text || null, why || (text ? 'heard' : 'nothing'));
  };
  if (!R) { finish('unsupported'); return { stop() {} }; }
  const rec = new R();
  rec.continuous = true; rec.interimResults = true; rec.lang = opts.lang || 'en-US';
  const markReady = () => { if (!ready) { ready = true; startedAt = now(); (opts.onReady || (() => {}))(); } };
  rec.onstart = markReady;
  rec.onaudiostart = markReady;
  rec.onresult = (e) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = String((e.results[i][0] || {}).transcript || '');
      if (e.results[i].isFinal) finalText += ' ' + t; else interim += ' ' + t;
    }
    heardAt = now();
    (opts.onText || (() => {}))((finalText + ' ' + interim).replace(/\s+/g, ' ').trim());
  };
  rec.onerror = (e) => { if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')) finish('blocked'); };
  rec.onend = () => finish();
  const stop = () => {
    if (stopping || done) return;
    stopping = true;
    try { rec.stop(); } catch (e) { /* gone */ }
    safety = T.set(() => finish(), 2500);                 // in case the browser never says it ended
  };
  const check = () => {
    if (done) return;
    const t = now();
    if (heardAt && t - heardAt >= PAUSE) return stop();   // they have finished
    if (!heardAt && ready && t - startedAt >= SILENCE) return stop();   // they said nothing
    if (t - startedAt >= MAX) return stop();
    tick = T.set(check, 200);
  };
  try { rec.start(); } catch (e) { finish('error'); return { stop() {} }; }
  tick = T.set(check, 200);
  return { stop };
}
