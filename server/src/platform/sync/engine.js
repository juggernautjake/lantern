/* ===========================================================================
   server/src/platform/sync/engine.js — this computer and the hub.
   ---------------------------------------------------------------------------
   OFFLINE FIRST. Nothing a person does waits for the hub: progress is written
   here first (platform/progress.js) and this engine carries it up whenever
   the hub can be reached — on start, every few seconds while online, after
   backing off while offline, and immediately when the app says the network
   came back (nudge()).

   One sign-in, then offline: the session (and the person's profile) are kept
   in the data folder, so the app knows who it is without a network. The
   token is refreshed when it is near expiry and the hub is reachable.

   Each pass (tick):
     1  refresh the token if it is close to expiring
     2  heartbeat: "online, Lantern 0.2.0, in ColdFusion, lesson u3l2"
     3  push progress for every course with something unsent, and merge what
        the hub sends back (other computers' work) into this one
     4  every so often, pull the course list and offers:
          - a new offer → an event (the app shows it; Dayspring announces it)
          - a course this person has and has not downloaded, or a newer
            version of one → download and install it (progress is kept)
          - a course they no longer have → hidden here; progress is kept

   The hub itself is an adapter (supabase.js). Tests point the same adapter at
   a fake hub (server/test/fake-hub.mjs), so this file is tested as shipped.
   =========================================================================== */

import * as settings from '../settings.js';
import * as packs from '../packs.js';
import * as progress from '../progress.js';
import * as local from '../local.js';
import * as bus from '../bus.js';
import { hub as hubConfig, version as appVersion, saveFileConfig, resetCache } from '../config.js';
import { supabaseAdapter, HubError } from './supabase.js';
import { cmp } from '../semver.js';
import { run } from '../../db/db.js';

const TICK_MS = Number(process.env.LANTERN_SYNC_MS || 15000);
const HEARTBEAT_MS = Number(process.env.LANTERN_HEARTBEAT_MS || 60000);
const CATALOG_MS = Number(process.env.LANTERN_CATALOG_MS || 30000);
const PULL_MS = Number(process.env.LANTERN_PULL_MS || 60000);

const state = {
  online: false, lastOkAt: 0, lastError: null, failures: 0, nextAt: 0,
  lastHeartbeat: 0, lastCatalog: 0, lastPull: {}, running: false,
  downloads: {},          // courseId → { phase, received, total, error, version }
  activity: { course: null, lesson: null, status: 'idle' },
};
let adapter = null;
let timer = null;

/* ---------------------------------------------------------------- setup --- */

export function hubAdapter() {
  if (adapter) return adapter;
  const cfg = hubConfig();
  adapter = cfg ? supabaseAdapter(cfg) : null;
  return adapter;
}
export function useAdapter(a) { adapter = a; }   // tests

/* Save the hub's address and public key, after checking they work. */
export async function configure(url, anonKey) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  const key = String(anonKey || '').trim();
  if (!/^https?:\/\/\S+$/.test(clean)) throw new HubError('The hub address should start with https:// (it is the Project URL in Supabase).', 'hub');
  if (key.length < 20) throw new HubError('That does not look like the public key (anon or publishable).', 'hub');
  if (/service_role/.test(decodeJwtRole(key)) || /^sb_secret_/.test(key)) throw new HubError('That is a secret key. It must never go into the app: use the public (anon or publishable) key.', 'hub');
  const a = supabaseAdapter({ url: clean, anonKey: key });
  await a.ping();
  saveFileConfig({ hub: { url: clean, anonKey: key } });
  resetCache();
  adapter = a;
  settings.set('hub.session', null);
  settings.set('hub.profile', null);
  bus.emit('sync', status());
  return status();
}

function decodeJwtRole(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')).role || ''; }
  catch (e) { return ''; }
}

/* ---------------------------------------------------------------- state --- */

const session = () => settings.get('hub.session');
export const profile = () => settings.get('hub.profile');
export const isOwner = () => !!(profile() && profile().role === 'owner');

export function status() {
  const p = profile();
  return {
    configured: !!hubAdapter(), hubUrl: hubAdapter() ? hubAdapter().url : null, hubSource: (hubConfig() || {}).source || null,
    emailCode: !!(hubConfig() || {}).emailCode,
    signedIn: !!session(), online: state.online, lastOkAt: state.lastOkAt || null, lastError: state.lastError,
    profile: p ? { id: p.id, email: p.email, display_name: p.display_name, role: p.role, owner_exists: p.owner_exists, friend_code: p.friend_code || null, findable_by_name: !!p.findable_by_name } : null,
    owner: isOwner(), downloads: state.downloads,
    offers: settings.get('hub.offers', []), courses: settings.get('hub.courses', []),
  };
}

function setOnline(ok, err) {
  const was = state.online;
  state.online = ok;
  if (ok) { state.lastOkAt = Date.now(); state.lastError = null; state.failures = 0; }
  else { state.lastError = err ? err.message : null; state.failures++; }
  if (was !== ok) bus.emit('sync', { online: ok, signedIn: !!session(), error: state.lastError });
}

export const activity = () => Object.assign({}, state.activity);

/* What the person is doing right now, for the heartbeat. */
export function setActivity(a) {
  state.activity = Object.assign({}, state.activity, a || {});
}

/* ------------------------------------------------------------- accounts --- */

export async function signUp(email, password, name) {
  const a = need();
  const r = await a.signUp(String(email).trim(), String(password), String(name || '').trim());
  if (r.session) await startSession(r.session);
  return { confirm: r.confirm, status: status() };
}

export async function signIn(email, password) {
  const a = need();
  const s = await a.signIn(String(email).trim(), String(password));
  await startSession(s);
  return status();
}

/* Sign in (or join) with a link sent to the email address. The link comes
   back to this app's /auth/callback page. */
export async function sendLink(email, name) {
  const { port } = await import('../config.js');
  await need().sendLink(String(email).trim(), String(name || '').trim(), 'http://127.0.0.1:' + port() + '/auth/callback');
  return { sent: true };
}
export async function completeLink(tokens) {
  const s = await need().completeLink(tokens);
  await startSession(s);
  return status();
}

/* Sign in (or join) with a code sent to the email address (hubs whose email
   includes the code; see config "emailCode"). */
export async function sendCode(email, name) {
  await need().sendCode(String(email).trim(), String(name || '').trim());
  return { sent: true };
}
export async function verifyCode(email, code) {
  const s = await need().verifyCode(String(email).trim(), code);
  await startSession(s);
  return status();
}

/* ------------------------------------------------------------- handoff ---
   Another app on this computer (Dayspring) that already signed this person
   in can hand the session over, so they do not sign in twice. It writes
   <data>/handoff.json:

     { "v": 1, "refresh_token": "…", "hub": { "url": "…", "anonKey": "…" },
       "created_at": <ms>, "from": "dayspring" }

   Rules (docs/dev/ecosystem.md):
     - one use: the file is deleted before the token is used
     - fresh: older than 5 minutes is refused
     - the token is rotated at once, so the copy in the file is dead
     - the handing app stops using that session and uses Lantern's local
       API from then on (two apps cannot share one refresh-token chain)
   The data folder is inside the person's own profile, which Windows already
   keeps from other users. */
export async function consumeHandoff(file) {
  const { existsSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { dataDir } = await import('../config.js');
  const f = file || join(dataDir(), 'handoff.json');
  if (!existsSync(f)) return { used: false };
  let h = null;
  try { h = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { /* unreadable */ }
  rmSync(f, { force: true });
  if (!h || h.v !== 1 || !h.refresh_token) return { used: false, error: 'The sign-in handoff was not readable.' };
  if (!(Number(h.created_at) > Date.now() - 5 * 60000)) return { used: false, error: 'The sign-in handoff was too old.' };
  if (h.hub && h.hub.url && h.hub.anonKey && !hubConfig()) {
    saveFileConfig({ hub: { url: String(h.hub.url).replace(/\/+$/, ''), anonKey: h.hub.anonKey } });
    resetCache();
    adapter = null;
  }
  const s = await need().refresh(h.refresh_token);
  await startSession(s);
  return { used: true, from: h.from || null, status: status() };
}

async function startSession(s) {
  settings.set('hub.session', s);
  setOnline(true);
  const me = await call('lantern_me', {});
  settings.set('hub.profile', me);
  if (me && me.display_name) local.setName(me.display_name);
  state.lastCatalog = 0;
  bus.emit('signed-in', { email: me && me.email, display_name: me && me.display_name, owner: !!(me && me.role === 'owner') });
  nudge();
}

export async function signOut() {
  const s = session();
  if (s && hubAdapter()) await hubAdapter().signOut(s.access_token);
  settings.set('hub.session', null);
  settings.set('hub.profile', null);
  settings.set('hub.offers', []);
  settings.set('hub.friends', null);
  bus.emit('signed-out', {});
  bus.emit('sync', status());
  return status();
}

export async function claimOwner(code) {
  const me = await call('lantern_claim_owner', { p_code: String(code || '').trim() });
  settings.set('hub.profile', me);
  return status();
}

export async function setName(name) {
  const me = await call('lantern_set_name', { p_name: name });
  settings.set('hub.profile', me);
  local.setName(me.display_name);
  return status();
}

function need() {
  const a = hubAdapter();
  if (!a) throw new HubError('This copy of Lantern is not connected to a hub yet. Open Settings → Hub.', 'hub');
  return a;
}

/* A hub function, with the session refreshed when needed. Marks the
   connection online or offline as a side effect. */
export async function call(name, args) {
  const a = need();
  let s = session();
  if (!s) throw new HubError('Sign in first.', 'auth');
  try {
    if (s.expires_at && s.expires_at - Date.now() < 60000) s = await refresh();
    const out = await a.rpc(name, args, s.access_token);
    setOnline(true);
    return out;
  } catch (e) {
    if (e.kind === 'auth' && s && s.refresh_token) {
      try {
        s = await refresh();
        const out = await a.rpc(name, args, s.access_token);
        setOnline(true);
        return out;
      } catch (e2) {
        if (e2.kind === 'offline') setOnline(false, e2);
        throw e2;
      }
    }
    if (e.kind === 'offline') setOnline(false, e);
    throw e;
  }
}

async function refresh() {
  const s = session();
  const next = await need().refresh(s.refresh_token);
  settings.set('hub.session', next);
  return next;
}

/* ----------------------------------------------------------------- tick --- */

export function start() {
  if (timer) return;
  const loop = async () => {
    try { await tick(); } catch (e) { /* recorded in state */ }
    const wait = state.online || !session() ? TICK_MS : Math.min(5 * 60000, TICK_MS * Math.pow(2, Math.min(state.failures, 5)));
    timer = setTimeout(loop, wait);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(loop, 500);
  if (timer.unref) timer.unref();
}
export function stop() { if (timer) clearTimeout(timer); timer = null; }

/* Do the next pass now (the network came back, the person pressed Sync,
   or something worth sending just happened). */
let nudged = null;
export function nudge() {
  if (nudged) return nudged;
  nudged = tick().catch(() => {}).finally(() => { nudged = null; });
  return nudged;
}

export async function tick() {
  if (!hubAdapter() || !session() || state.running) return status();
  state.running = true;
  try {
    const now = Date.now();
    if (now - state.lastHeartbeat >= HEARTBEAT_MS) {
      const a = state.activity;
      await call('lantern_heartbeat', { p_device: local.deviceId(), p_version: appVersion(), p_course: a.course, p_lesson: a.lesson, p_status: a.status });
      state.lastHeartbeat = now;
    }
    await pushAll();
    await pushPrefs();
    if (now - state.lastCatalog >= CATALOG_MS) {
      await refreshCatalog();
      await pullPrefs();
      state.lastCatalog = Date.now();
    }
    await downloadWanted();
  } catch (e) {
    if (e.kind !== 'offline') state.lastError = e.message;
  } finally {
    state.running = false;
  }
  return status();
}

/* ------------------------------------------------------------- progress --- */

/* A computer whose clock is off by more than a couple of minutes: its
   timestamps are moved onto the hub's clock on the way out, and back on the
   way in, so "the newest position wins" means the newest in real life. */
export function skew() {
  const a = adapter;
  const off = a && typeof a.clockOffset === 'function' ? Number(a.clockOffset()) || 0 : 0;
  return Math.abs(off) > 120000 ? off : 0;
}
export function shiftTimes(x, delta) {
  if (!x || !delta) return x;
  const t = (v) => (v === null || v === undefined || v === '' ? v : Number(v) + delta);
  const out = Object.assign({}, x);
  if (out.position && out.position.at) out.position = Object.assign({}, out.position, { at: t(out.position.at) });
  if (out.snapshot && out.snapshot.at) out.snapshot = Object.assign({}, out.snapshot, { at: t(out.snapshot.at) });
  if (Array.isArray(out.items)) out.items = out.items.map((i) => Object.assign({}, i, { updated_at: t(i.updated_at), first_done_at: t(i.first_done_at) }));
  if (Array.isArray(out.time)) out.time = out.time.map((e) => Object.assign({}, e, { at: t(e.at) }));
  return out;
}

async function pushAll() {
  const uid = local.userId();
  for (const p of packs.list()) {
    if (p.source !== 'hub' && !hubHas(p.id)) continue;
    const pend0 = progress.pending(uid, p.id);
    const sk = skew();
    const pend = shiftTimes(pend0, sk);
    const due = Date.now() - (state.lastPull[p.id] || 0) >= PULL_MS;
    const any = pend.items.length || pend.time.length || pend.position || pend.snapshot;
    if (!any && !due) continue;
    const sum = progress.summary(uid, p);
    const args = {
      p_course: p.id, p_device: local.deviceId(),
      p_items: pend.items, p_time: pend.time.map((t) => ({ id: t.id, seconds: Number(t.seconds) || 0, at: t.at })),
      p_position: pend.position, p_snapshot: pend.snapshot,
      p_summary: { percent: sum.percent, finished: sum.finished, count: sum.count,
        current_ref: sum.current ? sum.current.ref : null, current_title: sum.current ? sum.current.title : null },
      p_since: localSavedAt(uid, p.id) ? localSavedAt(uid, p.id) + sk : localSavedAt(uid, p.id),
    };
    let remote;
    try { remote = await call('lantern_sync', args); }
    catch (e) {
      if (e.kind === 'denied') continue;       // no longer theirs: keep local, try nothing more
      throw e;
    }
    progress.markSynced(uid, p.id, { items: pend0.items, time: pend0.time, position: pend0.position, snapshot: pend0.snapshot });
    const applied = progress.applyRemote(uid, p, shiftTimes(remote || {}, -sk));
    state.lastPull[p.id] = Date.now();
    if (applied.changed.length || applied.replaced) bus.emit('progress', { course: p.id, reason: 'hub' });
  }
}

const localSavedAt = (uid, packId) => progress.savedAt(uid, packId);

const hubHas = (id) => (settings.get('hub.courses', []) || []).some((c) => c.id === id);

/* -------------------------------------------------------------- catalog --- */

// The profile (name, role, friend code) can change on the hub, e.g. the owner role granted from the
// dashboard: fetch it again now and then so the app notices without signing out and in.
let profileAt = 0;
async function refreshProfile(force) {
  if (!force && Date.now() - profileAt < (Number(process.env.LANTERN_PROFILE_REFRESH_MS) || 60_000)) return;   // tests shorten it
  profileAt = Date.now();
  const me = await call('lantern_me', {}).catch(() => null);
  if (!me) return;
  const was = profile() || {};
  settings.set('hub.profile', me);
  if (was.role !== me.role || was.display_name !== me.display_name) bus.emit('profile', { profile: me });
}

export async function refreshCatalog() {
  await refreshProfile();
  const [courses, offers] = await Promise.all([call('lantern_my_courses', {}), call('lantern_my_offers', {})]);
  const before = new Set((settings.get('hub.offers', []) || []).map((o) => o.id));
  settings.set('hub.courses', courses || []);
  settings.set('hub.offers', offers || []);
  for (const o of offers || []) if (!before.has(o.id)) bus.emit('offer', { offer: o });

  // Courses taken away: hidden here, progress kept.
  const have = new Set((courses || []).map((c) => c.id));
  for (const p of packs.list()) {
    if (p.source === 'hub' && !have.has(p.id)) {
      packs.remove(p.id);
      bus.emit('courses', { removed: p.id });
    }
  }
  bus.emit('courses', {});
  await refreshFriends().catch(() => {});
  return { courses, offers };
}

/* Courses this person has whose newest version is not installed here. */
export function wanted() {
  const out = [];
  for (const c of settings.get('hub.courses', []) || []) {
    if (!c.latest_version || !c.pack_path) continue;
    const cur = packs.getAny(c.id);
    if (!cur || !cur.enabled || cmp(c.latest_version, cur.version) > 0) out.push(c);
  }
  return out;
}

async function downloadWanted() {
  for (const c of wanted()) {
    const d = state.downloads[c.id];
    if (d && (d.phase === 'downloading' || (d.phase === 'failed' && Date.now() - d.at < Number(process.env.LANTERN_DOWNLOAD_RETRY_MS || 20000)))) continue;
    await download(c.id).catch(() => {});
  }
}

export async function download(courseId) {
  const c = (settings.get('hub.courses', []) || []).find((x) => x.id === courseId);
  if (!c || !c.pack_path) throw new HubError('That course has nothing to download yet.', 'hub');
  const s = session();
  const set = (patch) => { state.downloads[courseId] = Object.assign({ version: c.latest_version }, state.downloads[courseId], patch, { at: Date.now() }); bus.emit('download', Object.assign({ course: courseId }, state.downloads[courseId])); };
  set({ phase: 'downloading', received: 0, total: c.size || 0, error: null });
  try {
    let buf;
    try { buf = await need().download(c.pack_path, s.access_token, (r, t) => set({ received: r, total: t || c.size || 0 })); }
    catch (e) {
      if (e.kind === 'auth') { await refresh(); buf = await need().download(c.pack_path, session().access_token, (r, t) => set({ received: r, total: t || c.size || 0 })); }
      else throw e;
    }
    const before = packs.getAny(courseId);
    const out = packs.install(buf, { source: 'hub', allowOlder: false });
    set({ phase: 'done', received: buf.length, total: buf.length });
    bus.emit('course-updated', { course: courseId, title: c.title, from: before ? before.version : null, to: out.version });
    bus.emit('courses', {});
    return out;
  } catch (e) {
    if (e.kind === 'offline') setOnline(false, e);
    set({ phase: 'failed', error: e.message });
    throw e;
  }
}

/* ----------------------------------------------------------- preferences ---
   Settings that follow the person between computers: the course editor and
   appearance (what the course pages report with 'settings-changed'). Kept
   here first; the newest copy wins. */
export function prefs() { return settings.get('prefs', { prefs: {}, updated_at: 0, dirty: false }); }
export function setPrefs(patch) {
  const cur = prefs();
  const next = Object.assign({}, cur.prefs);
  for (const k of ['editor', 'appearance']) if (patch && patch[k] && typeof patch[k] === 'object') next[k] = Object.assign({}, next[k] || {}, patch[k]);
  settings.set('prefs', { prefs: next, updated_at: Date.now(), dirty: true });
  if (session()) nudge();
  return prefs();
}
async function pushPrefs() {
  const p = prefs();
  if (!p.dirty) return;
  await call('lantern_prefs_set', { p_prefs: p.prefs, p_updated_at: p.updated_at });
  settings.set('prefs', Object.assign({}, prefs(), { dirty: prefs().updated_at !== p.updated_at }));
}
async function pullPrefs() {
  const r = await call('lantern_prefs_get', {});
  const p = prefs();
  if (r && Number(r.updated_at) > Number(p.updated_at) && !p.dirty) {
    settings.set('prefs', { prefs: r.prefs || {}, updated_at: Number(r.updated_at), dirty: false });
    bus.emit('prefs', { prefs: r.prefs || {} });
  }
}

/* --------------------------------------------------------------- offers --- */

export async function acceptOffer(offerId) {
  const r = await call('lantern_accept_offer', { p_offer: offerId });
  const offer = (settings.get('hub.offers', []) || []).find((o) => o.id === offerId);
  await refreshCatalog();
  bus.emit('offer-answered', { offer, accepted: true });
  nudge();   // the download starts straight away
  return r;
}

export async function declineOffer(offerId) {
  const r = await call('lantern_decline_offer', { p_offer: offerId });
  const offer = (settings.get('hub.offers', []) || []).find((o) => o.id === offerId);
  await refreshCatalog();
  bus.emit('offer-answered', { offer, accepted: false });
  return r;
}

export async function redeemInvite(code) {
  const r = await call('lantern_redeem_invite', { p_code: code });
  await refreshCatalog();
  return r;
}

export async function listedCourses() { return call('lantern_listed_courses', {}); }
export async function requestCourse(id, message) { return call('lantern_request_course', { p_course: id, p_message: message || '' }); }

/* Publish a built pack (the owner): upload the file to the course-packs
   bucket, register the course (a new one starts as a draft unless told
   otherwise) and its version with the changelog since the last version.
   Everybody who has the course gets the new version on their next sync. */
export async function publishPack(buf, opts) {
  const o = opts || {};
  if (!isOwner()) throw new HubError('Only the owner of this hub can publish courses.', 'denied');
  const { manifest } = packs.parsePack(buf);
  const existing = ((await call('lantern_owner_courses', {})) || []).find((c) => c.id === manifest.id);
  if (existing && existing.latest_version && cmp(manifest.version, existing.latest_version) <= 0 && !o.force) {
    throw new HubError(manifest.title + ' ' + existing.latest_version + ' is already published; raise the version in course.json to publish again.', 'hub');
  }
  const path = manifest.id + '/' + manifest.version + '.lpack';
  let s = session();
  if (s.expires_at && s.expires_at - Date.now() < 60000) s = await refresh();
  await need().upload(path, buf, s.access_token);
  const status = o.status || (existing ? existing.status : 'draft');
  await call('lantern_owner_save_course', { p_id: manifest.id, p_title: manifest.title, p_description: manifest.description || '',
    p_status: status, p_visibility: o.visibility || (existing ? existing.visibility : 'private'), p_listed: o.listed !== undefined ? !!o.listed : (existing ? existing.listed : false) });
  const { createHash } = await import('node:crypto');
  const { notesSince } = packs;
  await call('lantern_owner_publish', { p_course: manifest.id, p_version: manifest.version, p_pack_path: path, p_size: buf.length,
    p_sha256: createHash('sha256').update(buf).digest('hex'), p_changelog: notesSince(manifest, existing ? existing.latest_version : null),
    p_manifest: { id: manifest.id, title: manifest.title, version: manifest.version, units: (manifest.units || []).length, lessons: (manifest.lessons || []).length } });
  state.lastCatalog = 0;
  nudge();
  return { id: manifest.id, version: manifest.version, status, path, previous: existing ? existing.latest_version : null };
}

/* -------------------------------------------------------------- friends --- */
/* The friends list and requests are kept here too (hub.friends), so the app
   can show them offline; changes need the hub. A hub set up before
   0002_friends.sql has no friend functions: that is reported as
   { available: false } and nothing else breaks. */

const FRIENDS_EMPTY = { available: true, friends: [], received: [], sent: [], blocked: [], at: 0 };
export function friendsState() { return Object.assign({}, FRIENDS_EMPTY, settings.get('hub.friends') || {}); }

const missingFn = (e) => e && (e.status === 404 || /could not find the function|PGRST202/i.test(e.message || ''));

export async function refreshFriends() {
  if (!session()) return friendsState();
  const before = friendsState();
  let friends, reqs;
  try {
    [friends, reqs] = await Promise.all([call('lantern_my_friends', {}), call('lantern_my_friend_requests', {})]);
  } catch (e) {
    if (missingFn(e)) { settings.set('hub.friends', Object.assign(friendsState(), { available: false })); return friendsState(); }
    throw e;
  }
  // a sign-in from before the hub had friends: fetch the profile again for the friend code
  if (profile() && !profile().friend_code) { const me = await call('lantern_me', {}).catch(() => null); if (me) settings.set('hub.profile', me); }
  const next = { available: true, friends: friends || [], received: (reqs && reqs.received) || [], sent: (reqs && reqs.sent) || [], blocked: (reqs && reqs.blocked) || [], at: Date.now() };
  settings.set('hub.friends', next);
  // new requests for me (not ones I set aside with Ignore) and my requests that were accepted
  const had = new Set(before.received.map((r) => r.id));
  const first = !before.at;
  for (const r of next.received) if (!had.has(r.id) && r.status === 'pending' && !first) bus.emit('friend-request', { request: r });
  const wasFriend = new Set(before.friends.map((x) => x.id));
  for (const x of next.friends) if (!wasFriend.has(x.id) && !first) bus.emit('friend-accepted', { friend: x });
  bus.emit('friends', { received: next.received.filter((r) => r.status === 'pending').length });
  return next;
}

export async function findPeople(query) { return call('lantern_find_people', { p_query: String(query || '') }); }

export async function sendFriendRequest(to, message) {
  const r = await call('lantern_send_friend_request', { p_to: String(to || '').trim(), p_message: String(message || '') });
  await refreshFriends().catch(() => {});
  return r;
}

export async function respondFriendRequest(id, action) {
  if (['accept', 'decline', 'ignore'].indexOf(action) < 0) throw new HubError('Say accept, decline or ignore.', 'hub');
  const req = friendsState().received.find((r) => r.id === id) || null;
  const r = await call('lantern_respond_friend_request', { p_request: id, p_action: action });
  await refreshFriends().catch(() => {});
  if (action === 'accept') bus.emit('friend-answered', { request: req, accepted: true });
  return r;
}

export async function cancelFriendRequest(id) { const r = await call('lantern_cancel_friend_request', { p_request: id }); await refreshFriends().catch(() => {}); return r; }
export async function removeFriend(userId) { const r = await call('lantern_remove_friend', { p_user: userId }); await refreshFriends().catch(() => {}); return r; }
export async function blockUser(userId) { const r = await call('lantern_block_user', { p_user: userId }); await refreshFriends().catch(() => {}); return r; }
export async function unblockUser(userId) { const r = await call('lantern_unblock_user', { p_user: userId }); await refreshFriends().catch(() => {}); return r; }
export async function setFindable(byName) {
  const me = await call('lantern_set_findable', { p_by_name: !!byName });
  if (me) settings.set('hub.profile', me);
  return status();
}

/* The owner's calls go straight through (they need the network by nature). */
export const OWNER_CALLS = ['lantern_owner_people', 'lantern_owner_courses', 'lantern_owner_send', 'lantern_owner_offers',
  'lantern_owner_withdraw', 'lantern_owner_invite', 'lantern_owner_grant', 'lantern_owner_save_course',
  'lantern_owner_publish', 'lantern_owner_groups', 'lantern_owner_group_save', 'lantern_owner_group_members',
  'lantern_owner_group_courses', 'lantern_owner_requests', 'lantern_owner_answer_request'];

export async function owner(name, args) {
  if (OWNER_CALLS.indexOf(name) < 0) throw new HubError('Unknown owner action.', 'hub');
  return call(name, args || {});
}

/* A clean slate for tests. */
export function _reset() { stop(); adapter = null; Object.assign(state, { online: false, failures: 0, lastHeartbeat: 0, lastCatalog: 0, lastPull: {}, downloads: {}, running: false }); run('SELECT 1'); }
