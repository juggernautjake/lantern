/* ===========================================================================
   server/src/platform/routes.js — the app's own endpoints.
   ---------------------------------------------------------------------------
     /api/platform             what this copy is (version, data folder, hub, updates)
     /api/events               everything that happens, as a live stream (SSE)
     /api/courses…             the course list, a course's overview, its saved
                               state for the player, import, history, download
     /packs/<id>/…             a course's own files, served from the data folder
     /api/packs…               add a course from a file; export one (owner)
     /api/hub…                 the hub: connect, sign up/in/out, offers,
                               invites, requests, and the owner's actions
     /api/updates…             Lantern updates: check, install, later, the log
     /api/backups              database backups
     /api/local/…              for other apps on this computer (Dayspring):
                               see docs/dev/dayspring-bridge.md

   The person is always ctx.id: in the app that is the one local person (the
   server signs them in automatically, and only for this computer).
   =========================================================================== */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { all, run, one, handle as dbHandle, file as dbFile, recoveredFrom } from '../db/db.js';
import * as config from './config.js';
import * as packs from './packs.js';
import * as progress from './progress.js';
import * as settings from './settings.js';
import * as backups from './backups.js';
import * as updater from './updater.js';
import * as engine from './sync/engine.js';
import * as bus from './bus.js';
import * as local from './local.js';
import * as eco from './eco.js';
import * as friendsRoutes from './friends-routes.js';
import { DEFAULTS } from './defaults.js';
import * as credentials from './credentials.js';
import { forgetShared } from '../assistant/brain.js';
import { mimeFor } from '../files/paths.js';

let lastActivity = Date.now();
export const idleFor = () => Date.now() - lastActivity;
const touch = () => { lastActivity = Date.now(); };

export const updateMode = () => updater.normalizeMode(settings.get('updates.mode', DEFAULTS.updates.mode));

export function logUpdate(row) {
  run(`INSERT INTO update_log (channel, subject, from_version, to_version, status, title, notes, message, backup)
       VALUES (?,?,?,?,?,?,?,?,?)`, row.channel, row.subject, row.from_version || null, row.to_version || null,
  row.status, row.title || '', row.notes || '', row.message || '', row.backup || null);
}

export function applyUpdate(info) {
  return updater.apply({ info, db: dbHandle(), dbFile: dbFile(), log: logUpdate });
}

function pack404(id) { return Object.assign(new Error('There is no course called "' + id + '" on this computer.'), { status: 404 }); }
function needPack(id) { const p = packs.get(id); if (!p) throw pack404(id); return p; }

/* Units and checks finished by this save, for "you finished unit 3". */
function milestones(uid, pack, events) {
  const done = events.filter((e) => e.kind === 'completed');
  if (!done.length) return;
  const ov = progress.overview(uid, pack);
  for (const e of done) {
    if (e.itemKind === 'check') {
      const u = ov.units.find((x) => x.check && x.check.id === e.ref);
      bus.emit('milestone', { course: pack.id, courseTitle: pack.title, kind: 'check', ref: e.ref, title: u ? u.check.title : e.ref });
    }
    const u = ov.units.find((x) => x.lessons.some((l) => l.id === e.ref) || (x.check && x.check.id === e.ref));
    if (u && u.done === u.count) bus.emit('milestone', { course: pack.id, courseTitle: pack.title, kind: 'unit', ref: u.id, title: 'Unit ' + u.n + ': ' + u.title });
  }
}

/* The course list: installed courses with progress, plus courses from the hub
   that are this person's but not downloaded yet. */
export function courseList(uid) {
  const installed = packs.list().map((p) => Object.assign(progress.summary(uid, p), {
    id: p.id, title: p.title, version: p.version, description: p.manifest.description || '', level: p.manifest.level || '',
    installed: true, source: p.source, color: p.manifest.color || null,
  }));
  const have = new Set(installed.map((c) => c.id));
  const st = engine.status();
  const remote = (st.courses || []).filter((c) => !have.has(c.id)).map((c) => ({
    id: c.id, title: c.title, description: c.description, version: c.latest_version, installed: false,
    status: c.status, access: c.access, size: c.size, download: st.downloads[c.id] || null, percent: 0,
  }));
  return installed.concat(remote);
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { /* no browser */ }
}

const shellClients = () => shellCount;
let shellCount = 0;

export function register(r) {
  /* ------------------------------------------------------------ platform */
  r.get('/api/platform', async ({ ctx }) => ({ body: {
    name: 'Lantern', version: config.version(), mode: config.mode(), node: process.versions.node,
    dataDir: config.dataDir(), person: { id: ctx.id, name: ctx.name },
    hub: engine.status(), update: updater.status(), updateMode: updateMode(),
    unseenUpdates: unseen().length,
    // the database was damaged at start and Lantern carried on from a backup
    recovered: recoveredFrom(),
  } }));

  r.post('/api/activity', async ({ body }) => {
    touch();
    if (body && (body.course !== undefined || body.lesson !== undefined || body.status)) {
      engine.setActivity({ course: body.course || null, lesson: body.lesson || null, status: body.status || 'studying' });
    }
    return { body: { ok: true } };
  });

  r.get('/api/events', async ({ res }) => {
    shellCount++;
    res.on('close', () => { shellCount--; });
    bus.stream(res);
  });

  /* ------------------------------------------------------------- courses */
  r.get('/api/courses', async ({ ctx }) => ({ body: { courses: courseList(ctx.id), offers: engine.status().offers || [] } }));

  /* The current learning context: what the person is studying right now, for
     the assistant and the resource finder (and anything else that helps with
     "this lesson"). ?ref= picks a lesson; otherwise where they are. */
  r.get('/api/courses/:id/context', async ({ ctx, params, query }) => ({ body: learningContext(ctx.id, needPack(params.id), query.ref) }));
  r.get('/api/context', async ({ ctx }) => {
    const a = engine.activity();
    const p = (a.course && packs.get(a.course)) || null;
    return { body: p ? learningContext(ctx.id, p, a.lesson) : { course: null } };
  });

  r.get('/api/courses/:id/overview', async ({ ctx, params }) => ({ body: progress.overview(ctx.id, needPack(params.id)) }));

  r.get('/api/courses/:id/state', async ({ ctx, params, query }) => {
    const p = needPack(params.id);
    touch();
    if (query.open && progress.openAt(ctx.id, p, query.open)) engine.setActivity({ course: p.id, lesson: query.open, status: 'studying' });
    return { body: Object.assign(progress.stateForPlayer(ctx.id, p, { open: query.open }), {
      storageKeys: progress.storageKeys(p.manifest), entry: p.manifest.entry, title: p.title, version: p.version } ) };
  });

  r.put('/api/courses/:id/state', async ({ ctx, params, body }) => {
    const p = needPack(params.id);
    touch();
    const out = progress.saveState(ctx.id, p, body || {});
    if (out.stale) return { status: 409, body: { error: 'A newer copy is already saved.', savedAt: out.savedAt, keys: out.keys } };
    const pos = progress.summary(ctx.id, p).current;
    engine.setActivity({ course: p.id, lesson: pos ? pos.ref : null, status: 'studying' });
    milestones(ctx.id, p, out.events);
    for (const e of out.events) {
      if (e.kind === 'opened') bus.emit('lesson-started', { course: p.id, ref: e.ref, title: progress.titleFor(p.manifest, e.ref) });
      if (e.kind === 'completed' && e.itemKind === 'lesson') bus.emit('lesson-completed', { course: p.id, ref: e.ref, title: progress.titleFor(p.manifest, e.ref), courseTitle: p.title });
    }
    if (out.events.length) bus.emit('progress', { course: p.id, reason: 'local' });
    if (out.changed.length) engine.nudge();
    return { body: { savedAt: out.savedAt, changed: out.changed.length } };
  }, { maxBody: 20 * 1024 * 1024 });

  r.post('/api/courses/:id/import', async ({ ctx, params, body }) => {
    const p = needPack(params.id);
    const out = progress.importBackup(ctx.id, p, body && (body.backup || body));
    bus.emit('progress', { course: p.id, reason: 'import' });
    engine.nudge();
    return { body: { imported: out.imported, savedAt: out.savedAt, overview: progress.overview(ctx.id, p) } };
  }, { maxBody: 20 * 1024 * 1024 });

  /* The person's course settings (code editor, appearance): pushed into every
     course page when it opens, saved when the course reports a change. */
  r.get('/api/prefs', async () => ({ body: engine.prefs().prefs }));
  r.put('/api/prefs', async ({ body }) => { const p = engine.setPrefs(body || {}); bus.emit('prefs', { prefs: p.prefs, local: true }); return { body: p.prefs }; });

  r.get('/api/courses/:id/history', async ({ ctx, params }) => ({ body: { history: progress.history(ctx.id, params.id) } }));
  r.post('/api/courses/:id/restore', async ({ ctx, params, body }) => {
    const p = needPack(params.id);
    const out = progress.restore(ctx.id, p, Number(body && body.id));
    bus.emit('progress', { course: p.id, reason: 'restore' });
    return { body: { savedAt: out.savedAt } };
  });

  r.post('/api/courses/:id/download', async ({ params }) => {
    const out = await engine.download(params.id);
    return { body: out };
  });

  /* --------------------------------------------------------- pack files */
  r.get('/packs/:id/*', async ({ params, url, send }) => {
    const rel = decodeURIComponent(url.pathname).replace(/^\/packs\/[^/]+\/?/, '') || null;
    const f = packs.fileFor(params.id, rel);
    if (!f) return { status: 404, body: { error: 'Not in this course.' } };
    const text = /^\.(html?|css|js|mjs|json|txt|svg)$/i.test(extname(f));
    send(200, readFileSync(f), { 'content-type': mimeFor(f) + (text ? '; charset=utf-8' : ''), 'cache-control': 'no-cache' });
  });

  r.post('/api/packs/import', async ({ body }) => {
    const out = packs.install(Buffer.isBuffer(body) ? body : JSON.stringify(body), { source: 'file' });
    bus.emit('courses', {});
    if (out.changed) bus.emit('course-updated', { course: out.id, title: packs.get(out.id).title, from: out.previous, to: out.version });
    return { status: 201, body: out };
  }, { maxBody: 200 * 1024 * 1024 });

  r.get('/api/packs/:id/export', async ({ params, send }) => {
    if (!engine.isOwner() && config.mode() !== 'demo') return { status: 403, body: { error: 'Only the owner can export a course.' } };
    const pk = packs.exportPack(params.id);
    send(200, JSON.stringify(pk), { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="' + params.id + '-' + pk.manifest.version + '.lpack"' });
  });

  /* ----------------------------------------------------------------- hub */
  r.get('/api/hub', async () => ({ body: engine.status() }));
  r.post('/api/hub/configure', async ({ body }) => ({ body: await engine.configure(body && body.url, body && body.anonKey) }));
  r.post('/api/hub/signup', async ({ body }) => ({ body: await engine.signUp(body.email, body.password, body.name) }));
  r.post('/api/hub/signin', async ({ body }) => ({ body: await engine.signIn(body.email, body.password) }));
  r.post('/api/hub/link/send', async ({ body }) => ({ body: await engine.sendLink(body.email, body.name) }));
  r.post('/api/hub/link/complete', async ({ body }) => ({ body: await engine.completeLink(body || {}) }));
  // where an emailed sign-in link lands: the tokens are in the address's #fragment,
  // which only the page can read, so this page reads them and posts them back
  r.get('/auth/callback', async ({ send }) => { send(200, AUTH_CALLBACK_HTML, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); });
  r.post('/api/hub/code/send', async ({ body }) => ({ body: await engine.sendCode(body.email, body.name) }));
  r.post('/api/hub/code/verify', async ({ body }) => ({ body: await engine.verifyCode(body.email, body.code) }));
  r.post('/api/hub/signout', async () => ({ body: await engine.signOut() }));
  r.post('/api/hub/claim-owner', async ({ body }) => ({ body: await engine.claimOwner(body && body.code) }));
  r.post('/api/hub/name', async ({ body }) => ({ body: await engine.setName(body && body.name) }));
  r.post('/api/hub/sync', async () => { await engine.refreshCatalog().catch(() => {}); return { body: await engine.tick() }; });
  r.post('/api/hub/offers/:id/accept', async ({ params }) => ({ body: await engine.acceptOffer(params.id) }));
  r.post('/api/hub/offers/:id/decline', async ({ params }) => ({ body: await engine.declineOffer(params.id) }));
  r.post('/api/hub/redeem', async ({ body }) => ({ body: await engine.redeemInvite(body && body.code) }));
  // offline is an answer, not an error: the page says "available when you are online"
  r.get('/api/hub/listed', async () => {
    try { return { body: { courses: await engine.listedCourses() } }; }
    catch (e) { if (e && e.kind === 'offline') return { body: { courses: [], offline: true } }; throw e; }
  });
  r.post('/api/hub/request', async ({ body }) => ({ body: await engine.requestCourse(body && body.course, body && body.message) }));
  r.post('/api/hub/owner/:fn', async ({ params, body }) => {
    if (!engine.isOwner()) return { status: 403, body: { error: 'Only the owner of this hub can do that.' } };
    return { body: await engine.owner('lantern_owner_' + params.fn, body || {}) };
  });

  /* ------------------------------------------------------------- updates */
  r.get('/api/updates', async () => ({ body: {
    status: updater.status(), mode: updateMode(), pending: settings.get('updates.pending', null),
    log: all('SELECT * FROM update_log ORDER BY id DESC LIMIT 100'), unseen: unseen().map((x) => x.id),
  } }));
  r.post('/api/updates/check', async () => {
    try { return { body: await updater.check() }; }
    catch (e) { return { status: 502, body: { error: e.message } }; }
  });
  r.post('/api/updates/apply', async () => {
    const st = updater.status();
    const info = st.latest || await updater.check();
    if (!info || !info.available) return { body: { updated: false, message: 'Lantern is up to date.' } };
    const out = await applyUpdate(info);
    return { body: out };
  });
  r.post('/api/updates/later', async () => {
    const st = updater.status();
    settings.set('updates.pending', st.latest ? st.latest.latest : true);
    return { body: { pending: true, message: 'Lantern will update the next time you open it.' } };
  });
  r.put('/api/updates/mode', async ({ body }) => ({ body: { mode: settings.set('updates.mode', updater.normalizeMode(body && body.mode)) } }));
  r.post('/api/updates/seen', async () => {
    const last = one('SELECT MAX(id) AS id FROM update_log');
    settings.set('updates.seenId', last && last.id ? last.id : 0);
    return { body: { ok: true } };
  });

  /* ------------------------------------------------ the shared AI key --- */
  // Only what is shared and whether this person agreed; never the key itself.
  r.get('/api/credentials', async () => ({ body: { supported: credentials.supported(), shared: credentials.lantern.peek() } }));
  r.put('/api/credentials/consent', async ({ body }) => { const shared = credentials.lantern.allow(!!(body && body.useShared)); forgetShared(); return { body: { shared } }; });

  /* ------------------------------------------------------------- backups */
  r.get('/api/backups', async () => ({ body: { dir: config.paths.backups(), backups: backups.list() } }));
  r.post('/api/backups', async () => ({ status: 201, body: { file: backups.backupDb(dbHandle(), 'manual', { file: dbFile() }) } }));

  /* --------------------------------------------------- settings: basics */
  r.get('/api/settings', async () => ({ body: {
    name: local.name(), updateMode: updateMode(), dayspring: settings.get('dayspring.announce', true),
    reminders: settings.get('reminders', DEFAULTS.reminders), voice: settings.get('voice', DEFAULTS.voice),
    dataDir: config.dataDir(), port: config.port(),
  } }));
  r.put('/api/settings', async ({ body }) => {
    const b = body || {};
    if (b.name) local.setName(b.name);
    if (b.updateMode) settings.set('updates.mode', updater.normalizeMode(b.updateMode));
    if (b.dayspring !== undefined) settings.set('dayspring.announce', !!b.dayspring);
    if (b.reminders) settings.set('reminders', sanitizeReminders(b.reminders));
    return { body: { ok: true } };
  });

  /* --------------------------------------------- ecosystem (other apps) ---
     Read-only calls: this computer only (the server guard checks Host and
     Origin on every request). Anything that changes something or opens a
     window also needs the token from Lantern's presence file. See
     docs/dev/ecosystem.md. These routes do not use sessions. */
  const needToken = (req) => {
    if (!eco.tokenOk(req)) throw Object.assign(new Error("This needs the token from Lantern’s presence file."), { status: 401 });
  };
  const L = { auth: false };

  r.get('/api/eco/hello', async () => ({ body: { app: 'lantern', version: config.version(), schema: eco.SCHEMA, port: config.port() } }), L);
  r.get('/api/eco/events', async ({ res }) => bus.stream(res, (ev) => ev.type === 'eco-out'), L);
  r.post('/api/eco/event', async ({ req, body }) => {
    needToken(req);
    const r2 = eco.receive(body);
    if (!r2.ok) return { status: r2.status, body: { error: 'That event does not match the schema.', problems: r2.errors } };
    return { body: Object.assign(r2, { quiet: eco.quietState() }) };
  }, L);
  // Stop Lantern (the Stop shortcut, or another app). Answers, then exits.
  r.post('/api/eco/shutdown', async ({ req }) => {
    needToken(req);
    eco.send('app.stopping', { app: 'lantern' }).catch(() => {});
    setTimeout(() => process.exit(0), 300);
    return { body: { stopping: true } };
  }, L);
  r.get('/api/eco/state', async () => ({ body: { quiet: eco.quietState(), peers: await peerList() } }), L);

  r.get('/api/local/status', async () => ({ body: localStatus(local.userId()) }), L);
  r.get('/api/local/events', async ({ res }) => bus.stream(res, (ev) => ['offer', 'offer-answered', 'milestone', 'reminder', 'course-updated', 'progress', 'sync', 'lesson-started', 'lesson-completed', 'friend-request', 'friend-accepted', 'friends'].indexOf(ev.type) >= 0), L);
  r.get('/api/local/courses/:id', async ({ params }) => ({ body: progress.overview(local.userId(), needPack(params.id)) }), L);
  r.post('/api/local/open', async ({ req, body }) => {
    needToken(req);
    return { body: openInApp(body && body.course, body && body.lesson) };
  }, L);
  r.post('/api/local/report', async ({ req, body }) => {
    needToken(req);
    return { body: report(local.userId(), body || {}) };
  }, L);
  // The hub, for a companion app that has no session of its own (after a handoff).
  r.get('/api/local/offers', async () => ({ body: { offers: engine.status().offers || [], signedIn: engine.status().signedIn } }), L);
  // Accept, then show Lantern: the course page once it is here, the course list
  // (where it is downloading) until then.
  r.post('/api/local/offers/:id/accept', async ({ req, params, body }) => {
    needToken(req);
    const out = await engine.acceptOffer(params.id);
    if (!body || body.open !== false) openInApp(packs.get(out.course_id) ? out.course_id : null);
    return { body: out };
  }, L);
  r.post('/api/local/offers/:id/decline', async ({ req, params }) => { needToken(req); return { body: await engine.declineOffer(params.id) }; }, L);
  r.get('/api/local/people', async ({ req }) => {
    needToken(req);
    if (!engine.isOwner()) return { status: 403, body: { error: 'Only the owner can see people.' } };
    return { body: { people: await engine.owner('lantern_owner_people', {}) } };
  }, L);
  // Friends: the app's own routes and the companion-app ones (friends-routes.js).
  friendsRoutes.register(r, { needToken, local: L });
  r.post('/api/local/send', async ({ req, body }) => {
    needToken(req);
    if (!engine.isOwner()) return { status: 403, body: { error: 'Only the owner can send courses.' } };
    return { body: await engine.call('lantern_send_offer', { p_to: String(body.to || ''), p_course: String(body.course || ''), p_message: String(body.message || '') }) };
  }, L);
  // The owner's publish tool (scripts/publish-course.mjs) hands a built pack
  // to the running app, which uploads it with the owner's own sign-in.
  r.post('/api/local/publish', async ({ req, body }) => {
    needToken(req);
    const b = body || {};
    const buf = b.file ? readFileSync(String(b.file)) : Buffer.from(JSON.stringify(b.pack));
    return { body: await engine.publishPack(buf, { status: b.status, visibility: b.visibility, listed: b.listed, force: !!b.force }) };
  }, Object.assign({ maxBody: 200 * 1024 * 1024 }, L));
  // "Add a study time to my Dayspring schedule" (from Lantern's own pages too).
  r.post('/api/local/study-block', async ({ body }) => {
    const b = body || {};
    const p = packs.get(b.course);
    const out = await eco.send('schedule.block.request', {
      title: b.title || ('Study ' + (p ? p.title : 'with Lantern')), course: b.course || null,
      time: String(b.time || '19:00'), minutes: Number(b.minutes) || 30, days: Array.isArray(b.days) ? b.days : [1, 2, 3, 4, 5],
    }, 'dayspring');
    const ok = out.delivered.some((d) => d.ok);
    return { status: ok ? 200 : 503, body: ok ? { sent: true } : { sent: false, error: 'Dayspring is not running on this computer.' } };
  });
}

async function peerList() {
  const out = [];
  for (const p of eco.peers()) out.push({ app: p.app, version: p.version, port: p.port, running: !!(await eco.peer(p.app)) });
  return out;
}

export function openInApp(course, lesson) {
  if (course && !packs.get(course)) throw Object.assign(new Error('That course is not on this computer.'), { status: 404 });
  const hash = course ? '#/course/' + encodeURIComponent(course) + (lesson ? '?open=' + encodeURIComponent(lesson) : '') : '#/';
  bus.emit('open', { course: course || null, lesson: lesson || null });
  const url = 'http://127.0.0.1:' + config.port() + '/' + hash;
  if (!shellClients()) openBrowser(url);
  return { opened: true, url };
}

/* "I finished lesson X": Lantern checks its own record rather than taking the
   word for it, and says what is next. */
export function report(uid, body) {
  const p = packs.get(body.course) || packs.list()[0];
  if (!p) throw Object.assign(new Error('No courses on this computer yet.'), { status: 404 });
  const ov = progress.overview(uid, p);
  const want = String(body.lesson || '').toLowerCase();
  let found = null;
  for (const u of ov.units) for (const l of u.lessons) if (l.id.toLowerCase() === want || l.title.toLowerCase() === want) found = l;
  return {
    course: p.id, lesson: found ? { id: found.id, title: found.title, status: found.status } : null,
    verified: !!(found && found.status === 'done'),
    message: !found ? 'I could not find that lesson in ' + p.title + '.'
      : found.status === 'done' ? 'Yes, ' + found.title + ' is done.'
        : found.title + ' is not finished yet in Lantern' + (found.status === 'in-progress' ? ' (it is started).' : '.'),
    next: ov.next, percent: ov.percent,
  };
}

export function learningContext(uid, pack, ref) {
  const m = pack.manifest;
  const cur = ref || (progress.summary(uid, pack).current || {}).ref || null;
  let unit = null, lesson = null, kind = null;
  for (const u of m.units || []) {
    for (const l of u.lessons || []) if (l.id === cur) { unit = u; lesson = l; kind = 'lesson'; }
    if (u.check && u.check.id === cur) { unit = u; lesson = u.check; kind = 'check'; }
    for (const pr of u.projects || []) if (pr.id === cur) { unit = u; lesson = pr; kind = 'project'; }
  }
  return {
    course: { id: pack.id, title: pack.title, subject: m.subject || '', level: m.level || '' },
    unit: unit ? { id: unit.id, n: unit.n, title: unit.title, overview: unit.overview || '' } : null,
    item: lesson ? { id: lesson.id, kind, title: lesson.title, objectives: lesson.objectives || [], keyTerms: lesson.keyTerms || [],
      takeaways: lesson.takeaways || [], exercises: (lesson.exercises || []).map((e) => e.title) } : null,
  };
}

function sanitizeReminders(x) {
  const time = /^\d{2}:\d{2}$/.test(String(x.time)) ? x.time : '19:00';
  const days = Array.isArray(x.days) ? x.days.map(Number).filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
  return { enabled: !!x.enabled, time, days };
}

export function unseen() {
  const seen = settings.get('updates.seenId', 0) || 0;
  return all("SELECT id FROM update_log WHERE id > ? AND status = 'installed' ORDER BY id", seen);
}

/* What Dayspring (or anything local) needs to know in one call. */
export function localStatus(uid) {
  const list = courseList(uid);
  const st = engine.status();
  const streakDays = one("SELECT COUNT(DISTINCT date(at/1000, 'unixepoch', 'localtime')) AS n FROM progress_events WHERE user_id = ? AND at > ?", uid, Date.now() - 7 * 86400000);
  return {
    app: 'lantern', version: config.version(), name: local.name(),
    signedIn: st.signedIn, online: st.online, owner: st.owner,
    courses: list.map((c) => ({ id: c.id, title: c.title, installed: c.installed, percent: c.percent || 0,
      steps: c.steps || null, lessons: c.lessons || null, measure: c.measure || null,
      next: c.next || null, current: c.current || null, minutesLeft: c.minutesLeft || null })),
    offers: (st.offers || []).map((o) => ({ id: o.id, from: o.from_name, course: o.course_title, message: o.message })),
    friendRequests: engine.friendsState().received.filter((q) => q.status === 'pending').map((q) => ({ id: q.id, from: q.from_name, message: q.message })),
    reminders: dueReminders(uid),
    daysStudiedThisWeek: streakDays ? streakDays.n : 0,
    sync: { online: st.online, lastOkAt: st.lastOkAt, pending: pendingCount(uid) },
  };
}

function pendingCount(uid) {
  const a = one('SELECT COUNT(*) AS n FROM progress_items WHERE user_id = ? AND dirty = 1', uid);
  const b = one("SELECT COUNT(*) AS n FROM progress_events WHERE user_id = ? AND kind = 'time' AND synced = 0", uid);
  return (a ? a.n : 0) + (b ? b.n : 0);
}

/* Reminders that are due today: the study time, if set and not yet studied. */
export function dueReminders(uid) {
  const rem = settings.get('reminders', null);
  const out = [];
  if (!rem || !rem.enabled) return out;
  const now = new Date();
  if (rem.days.indexOf(now.getDay()) < 0) return out;
  const [h, m] = rem.time.split(':').map(Number);
  const due = new Date(now); due.setHours(h, m, 0, 0);
  const studied = one("SELECT COUNT(*) AS n FROM progress_events WHERE user_id = ? AND kind = 'time' AND date(at/1000,'unixepoch','localtime') = date('now','localtime')", uid);
  if (now >= due && !(studied && studied.n)) out.push({ text: 'Time to study — pick up where you left off in Lantern.', at: due.toISOString() });
  return out;
}

/* Once a minute: announce a study reminder when it comes due (once a day). */
export function startReminders(uid) {
  const t = setInterval(() => {
    const due = dueReminders(uid);
    const today = new Date().toISOString().slice(0, 10);
    if (due.length && settings.get('reminders.lastSaid') !== today) {
      settings.set('reminders.lastSaid', today);
      bus.emit('reminder', { text: due[0].text });
    }
  }, 60000);
  if (t.unref) t.unref();
}

/* The page an emailed sign-in link opens. Reads access/refresh tokens from the
   #fragment (never sent to any server by the browser), clears them from the
   address bar, hands them to this app, then goes home. */
const AUTH_CALLBACK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing in… · Lantern</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15100b;color:#f6ead2;font:16px/1.5 system-ui,Segoe UI,sans-serif}
.card{max-width:28em;padding:28px 32px;border-radius:14px;background:#211a12;border:1px solid #3a2e20;text-align:center}
h1{font:600 22px Georgia,serif;margin:0 0 8px}a{color:#ffb547}.err{color:#ff9d87}</style></head>
<body><main class="card"><h1>Lantern</h1><p id="m">Signing you in…</p></main>
<script>
(async () => {
  const m = document.getElementById('m');
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const q = new URLSearchParams(location.search);
  history.replaceState(null, '', location.pathname);
  const fail = (t) => { m.className = 'err'; m.innerHTML = ''; m.append(t + ' '); const a = document.createElement('a'); a.href = '/#/settings/account'; a.textContent = 'Back to Lantern'; m.append(a); };
  const err = h.get('error_description') || q.get('error_description');
  if (err) return fail('That sign-in link did not work: ' + err.split('+').join(' ') + '. Ask for a new one.');
  if (!h.get('refresh_token')) return fail(q.get('code') ? 'This link is for a different sign-in method. Ask for a new link from Lantern.' : 'That sign-in link was incomplete. Ask for a new one.');
  try {
    const r = await fetch('/api/hub/link/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token') }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return fail(j.error || 'Signing in did not work.');
    m.textContent = 'You are signed in. Opening Lantern…';
    setTimeout(() => location.replace('/#/'), 600);
  } catch (e) { fail('Lantern is not answering. Is it still open?'); }
})();
</script></body></html>`;
