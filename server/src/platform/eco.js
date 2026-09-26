/* ===========================================================================
   server/src/platform/eco.js — Lantern's side of the local app ecosystem.
   ---------------------------------------------------------------------------
   Lantern and its companion apps (Dayspring first) run on the same computer
   and talk over 127.0.0.1. The whole contract is docs/dev/ecosystem.md. The
   shared parts (presence files, the schema, the security checks, sending)
   are ecosystem-core's createEco() (vendor/ecosystem-core/lib/eco.mjs);
   this file keeps Lantern's interface and adds what is Lantern's own: the
   quiet state (calls, quiet hours, alarms, the other app speaking), who has
   the microphone, and turning Lantern's events into ecosystem events.

   DISCOVERY. Each running app writes a presence file into a shared per-user
   folder and removes it when it stops:

     %LOCALAPPDATA%/Ecosystem/apps/<app>.json   (ECOSYSTEM_DIR overrides)
     { "app": "lantern", "version": "0.2.0", "port": 4321, "pid": 1234,
       "startedAt": <ms>, "token": "<random, per start>", "api": "/api/eco",
       "schema": 1, "dataDir": "…", "handoff": "…/handoff.json" }

   An app finds another by reading its file and asking GET /api/eco/hello.

   SECURITY. Everything listens on 127.0.0.1 only, and on top of that:
     - every request must name this computer in its Host header
       (127.0.0.1:<port> or localhost:<port>): a DNS-rebinding page cannot
     - a request that carries an Origin must come from this app's own pages:
       an ordinary web page cannot drive Lantern from the browser
     - anything that CHANGES something or opens a window (POST /api/eco/event,
       /api/local/open, /api/local/report, offers) needs the app's token,
       which only processes of this Windows user can read from the file
     - read-only calls (status, events) need only the first two

   EVENTS. One versioned schema, both directions: { v: 1, id, type, source,
   at, data }. The types, their data and who sends them are in EVENT_TYPES.
   =========================================================================== */

import { join } from 'node:path';
import * as bus from './bus.js';
import { dataDir, version, port as ourPort } from './config.js';
import { createEco, EVENT_TYPES as CORE_TYPES, SCHEMA as CORE_SCHEMA, validateEvent as coreValidate, ecoDir as coreEcoDir } from '../../../vendor/ecosystem-core/lib/eco.mjs';

export const APP = 'lantern';
export const SCHEMA = CORE_SCHEMA;
export const EVENT_TYPES = CORE_TYPES;
export const ecoDir = () => coreEcoDir();

const core = createEco({ app: APP, version: () => version(), port: () => ourPort(), types: EVENT_TYPES });
export const ownToken = () => core.ownToken();

export const validateEvent = (ev) => coreValidate(ev, EVENT_TYPES);
export const makeEvent = (type, data) => core.makeEvent(type, data);

/* ------------------------------------------------------------ presence --- */

let cleanupSet = false;
export function writePresence(extra) {
  const p = core.writePresence(Object.assign({ dataDir: dataDir(), handoff: join(dataDir(), 'handoff.json') }, extra || {}));
  if (!cleanupSet) { cleanupSet = true; core.cleanupOnExit(); }
  return p;
}
export const readPresence = (app) => core.readPresence(app);
export const peers = () => core.peers();
/* Is that app actually running (not a file left behind by a crash)? */
export const alive = (p) => core.alive(p);
export const peer = (app) => core.peer(app);
/* Call a peer's local API with its token. */
export const call = (app, path, opts) => core.call(app, path, opts);

/* Send one event to every running peer (or one app). Never throws for delivery. */
export async function send(type, data, only) {
  const out = await core.send(type, data, only || null);
  bus.emit('eco-out', { event: out.event, delivered: out.delivered });
  return out;
}

/* ----------------------------------------------------------- security --- */

/* Called for EVERY request. Returns null when fine, or { status, error }. */
export function guard(req, opts) {
  const g = core.guard(req, { port: (opts && opts.port) || ourPort() });
  if (g && g.status === 421) return { status: 421, error: 'This address is not Lantern on this computer.' };
  if (g && g.status === 403) return { status: 403, error: 'Requests from other websites are not allowed.' };
  return g;
}

/* For write/open calls from other apps: the token from our presence file. */
export const tokenOk = (req) => core.tokenOk(req);

/* --------------------------------------------------------- incoming ---- */

const quiet = { dnd: false, until: null, inCall: false, focus: false };

/* The microphone: one app listens for its wake word at a time. Dayspring
   owns it whenever it is running, unless it hands it to Lantern with a
   mic.owner event (docs/dev/ecosystem.md). null = nobody has said. */
let micOwner = null;
export function micState(dayspringRunning) {
  const owner = micOwner || (dayspringRunning ? 'dayspring' : null);
  return { owner, lanternMayListen: owner === null ? !dayspringRunning : owner === APP };
}
export function setMicOwner(app) { micOwner = app || null; bus.emit('mic', { owner: micOwner }); }
export function quietState() {
  if (quiet.dnd && quiet.until && Date.now() > quiet.until) quiet.dnd = false;
  const alarm = !!(quiet.alarmAt && Date.now() - quiet.alarmAt < 10 * 60000);
  return { quiet: quiet.dnd || quiet.inCall || alarm, dnd: quiet.dnd, inCall: quiet.inCall, alarm, focus: quiet.focus, until: quiet.until, peerSpeaking: quiet.peerSpeaking || null };
}

/* An event from a peer (already guarded and token-checked by the route):
   validated here, then applied. The same shape as ecosystem-core's receive(). */
export function receive(ev) {
  const errs = validateEvent(ev);
  if (errs.length) return { ok: false, status: 400, errors: errs };
  if (ev.source === APP) return { ok: false, status: 400, errors: ['An app cannot send events to itself.'] };
  const d = ev.data || {};
  if (ev.type === 'dnd') { quiet.dnd = !!d.on; quiet.until = d.until ? Number(d.until) : null; }
  if (ev.type === 'call.state') quiet.inCall = !!d.inCall;
  if (ev.type === 'focus.start') quiet.focus = true;
  if (ev.type === 'focus.stop') quiet.focus = false;
  if (ev.type === 'alarm') quiet.alarmAt = Date.now();
  if (ev.type === 'speaking.start') quiet.peerSpeaking = ev.source;
  if (ev.type === 'speaking.stop' && quiet.peerSpeaking === ev.source) quiet.peerSpeaking = null;
  bus.emit('eco-in', { event: ev, quiet: quietState() });
  if (ev.type === 'mic.owner') { micOwner = d.app || null; bus.emit('mic', { owner: micOwner }); }
  if (ev.type === 'app.stopping' && ev.source === 'dayspring') { if (micOwner === 'dayspring' || micOwner === APP) micOwner = null; if (quiet.peerSpeaking === ev.source) quiet.peerSpeaking = null; bus.emit('mic', { owner: null }); }
  if (ev.type === 'app.started' && ev.source === 'dayspring') { micOwner = null; bus.emit('mic', { owner: 'dayspring' }); }
  if (ev.type === 'schedule.block.started' && (d.course || /study|lesson|course|lantern/i.test(String(d.title)))) {
    bus.emit('suggest-open', { course: d.course || null, lesson: d.lesson || null, title: d.title, from: ev.source });
  }
  return { ok: true, quiet: quietState() };
}

/* Lantern's own events, translated for the ecosystem. */
export function startForwarding(lookup) {
  const L = lookup || {};
  bus.on((ev) => {
    const go = (type, data) => { send(type, data).catch(() => {}); };
    switch (ev.type) {
      case 'offer': if (ev.offer) go('course.offered', { course: ev.offer.course_id, courseTitle: ev.offer.course_title, from: ev.offer.from_name, message: ev.offer.message || '', offerId: ev.offer.id }); break;
      case 'offer-answered': if (ev.offer) go(ev.accepted ? 'course.accepted' : 'course.declined', { course: ev.offer.course_id, courseTitle: ev.offer.course_title }); break;
      case 'friend-request': if (ev.request) go('friend.request', { requestId: ev.request.id, from: ev.request.from_name, message: ev.request.message || '' }); break;
      case 'friend-accepted': if (ev.friend) go('friend.accepted', { name: ev.friend.display_name, userId: ev.friend.id }); break;
      case 'course-updated': go('course.updated', { course: ev.course, title: ev.title, from: ev.from || null, to: ev.to }); break;
      case 'lesson-started': go('lesson.started', { course: ev.course, ref: ev.ref, title: ev.title || null }); break;
      case 'milestone':
        if (ev.kind === 'unit') go('unit.completed', { course: ev.course, ref: ev.ref, title: ev.title, courseTitle: ev.courseTitle });
        else go('lesson.completed', { course: ev.course, ref: ev.ref, kind: ev.kind, title: ev.title, courseTitle: ev.courseTitle });
        break;
      case 'lesson-completed': go('lesson.completed', { course: ev.course, ref: ev.ref, kind: 'lesson', title: ev.title || null, courseTitle: ev.courseTitle || null }); break;
      case 'reminder': if (!quietState().quiet) go('reminder.due', { text: ev.text, course: ev.course || null }); break;
      case 'update': if (ev.phase === 'available' && ev.latest) go('app.update.available', { app: APP, version: ev.latest.latest, notes: String(ev.latest.notes || '').slice(0, 2000) }); break;
      case 'signed-in': go('user.signed_in', { email: ev.email || null, display_name: ev.display_name || null }); break;
      case 'signed-out': go('user.signed_out', {}); break;
      case 'study-goal': go('study.goal', { minutes: ev.minutes, goal: ev.goal }); break;
      default: break;
    }
  });
  if (L.onStart) L.onStart();
}
