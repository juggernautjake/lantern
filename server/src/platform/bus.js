/* ===========================================================================
   server/src/platform/bus.js — one place things that happen are announced.
   ---------------------------------------------------------------------------
   The sync engine, the progress store and the updater emit; the app's pages
   (/api/events) and other local apps (/api/local/events, Dayspring) listen.

   Events: { type, ...data, at }
     offer             a course was offered to this person      { offer }
     offer-answered    this person accepted or declined          { offer, accepted }
     courses           the list of courses changed               { }
     download          a course download moved along             { course, phase, received, total, error }
     course-updated    a course was installed or updated         { course, title, from, to }
     progress          progress changed here or from the hub     { course, reason }
     milestone         a lesson, check or project was finished   { course, kind, ref, title }
     sync              the hub connection changed                { online, signedIn, error }
     update            a Lantern update is available/installed   { phase, latest }
     reminder          something is due                          { text, course }
   =========================================================================== */

import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(100);
const recent = [];

export function emit(type, data) {
  const ev = Object.assign({ type, at: Date.now() }, data || {});
  recent.push(ev);
  if (recent.length > 100) recent.shift();
  bus.emit('event', ev);
  return ev;
}

export function on(fn) { bus.on('event', fn); return () => bus.off('event', fn); }
export const last = (n) => recent.slice(-(n || 20));

/* An SSE stream of events to one response. filter(ev) chooses which. */
export function stream(res, filter) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (ev) => { if (!filter || filter(ev)) res.write('event: ' + ev.type + '\ndata: ' + JSON.stringify(ev) + '\n\n'); };
  const off = on(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  ping.unref && ping.unref();
  res.on('close', () => { off(); clearInterval(ping); });
}
