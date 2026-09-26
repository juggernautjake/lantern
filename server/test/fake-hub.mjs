#!/usr/bin/env node
/* ===========================================================================
   server/test/fake-hub.mjs — a stand-in for a Supabase project, for tests.
   ---------------------------------------------------------------------------
   Speaks the same HTTP as the real hub, for exactly the parts Lantern uses:
   Auth (password and email-code sign-in, refresh), the lantern_* functions
   (POST /rest/v1/rpc/<name>) and the course-packs Storage bucket. The rules
   of each function are the rules of supabase/migrations/0001_lantern_hub.sql
   and 0002_friends.sql,
   written again in JavaScript — so the app's real sync code runs against it
   unchanged, in one process or several.

       node server/test/fake-hub.mjs [port]         (prints its URL and keys)
       import { startFakeHub } from './fake-hub.mjs'

   Test-only helpers (no auth): GET /__test/otp?email=… (the emailed code),
   GET /__test/claim-code, GET /__test/state, POST /__test/expire-tokens,
   GET /__test/down?on=1|0 (the hub is unreachable), GET /__test/cut-downloads?n=1
   (the next n course downloads are cut off half way).
   =========================================================================== */

import { createServer } from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

export function startFakeHub(opts) {
  const o = opts || {};
  const ANON = o.anonKey || 'fake-anon-' + randomBytes(12).toString('hex');
  const db = {
    users: [],            // { id, email, password, confirmed, meta }
    profiles: [],         // { id, email, display_name, role, created_at }
    claimCode: randomBytes(9).toString('hex'),
    courses: [], versions: [], grants: [], offers: [], invites: [],
    groups: [], groupMembers: [], groupCourses: [], requests: [],
    friendRequests: [], friendships: [], blocks: [],   // 0002_friends.sql
    presence: [], items: [], time: [], position: [], snapshots: [], summary: [], prefs: new Map(),
    objects: new Map(),   // 'course-packs/<path>' → Buffer
    otps: new Map(),      // email → code
    links: new Map(),     // email → the sign-in link's address (redirect_to#access_token=…)
  };
  const tokens = new Map();   // access → { uid, exp }
  const refreshes = new Map(); // refresh → uid
  const now = () => new Date().toISOString();
  const TTL = o.tokenTtlSec || 3600;

  /* ------------------------------------------------------------- auth --- */
  function issue(uid) {
    const access = 'at_' + randomBytes(16).toString('hex');
    const refresh = 'rt_' + randomBytes(16).toString('hex');
    tokens.set(access, { uid, exp: Date.now() + TTL * 1000 });
    refreshes.set(refresh, uid);
    const u = db.users.find((x) => x.id === uid);
    return { access_token: access, refresh_token: refresh, expires_in: TTL, token_type: 'bearer', user: { id: uid, email: u.email } };
  }
  function newUser(email, password, meta, confirmed) {
    const u = { id: randomUUID(), email: email.toLowerCase(), password, confirmed: !!confirmed, meta: meta || {} };
    db.users.push(u);
    db.profiles.push({ id: u.id, email: u.email, display_name: (meta && meta.display_name) || u.email.split('@')[0], role: 'student', created_at: now(), friend_code: newCode(), findable_by_name: false });
    return u;
  }
  const who = (req) => {
    const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const s = tokens.get(t);
    return s && s.exp > Date.now() ? s.uid : null;
  };

  // LNT- and four characters without look-alikes (0002_friends.sql)
  function newCode() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (;;) { let c = 'LNT-'; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; if (!db.profiles.some((p) => p.friend_code === c)) return c; }
  }

  /* ------------------------------------------------------------- rules --- */
  const profile = (id) => db.profiles.find((p) => p.id === id);
  const isOwner = (uid) => !!(profile(uid) && profile(uid).role === 'owner');
  const course = (id) => db.courses.find((c) => c.id === id);
  const granted = (uid, cid) => db.grants.some((g) => g.user_id === uid && g.course_id === cid);
  const hasAccess = (uid, cid) => { const c = course(cid); return isOwner(uid) || !!(c && c.status === 'published' && (c.visibility === 'open' || granted(uid, cid))); };
  const fail = (msg, code) => { const e = new Error(msg); e.code = code || 'P0001'; throw e; };
  const needOwner = (uid) => { if (!isOwner(uid)) fail('Only the owner of this Lantern hub can do that.', '42501'); };

  function makeOffer(from, to, cid, message, via) {
    if (isOwner(to)) return false;
    if (granted(to, cid)) return false;
    if (db.offers.some((x) => x.to_user === to && x.course_id === cid && x.status === 'pending')) return false;
    db.offers.push({ id: randomUUID(), from_user: from, to_user: to, to_email: null, course_id: cid, message: String(message || '').slice(0, 500), status: 'pending', via: via || 'direct', created_at: now(), responded_at: null });
    return true;
  }
  function makeEmailOffer(from, email, cid, message, via) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail('That is not an email address: ' + email);
    const p = db.profiles.find((x) => x.email === e);
    if (p) return makeOffer(from, p.id, cid, message, via);
    if (db.offers.some((x) => !x.to_user && x.to_email === e && x.course_id === cid && x.status === 'pending')) return false;
    db.offers.push({ id: randomUUID(), from_user: from, to_user: null, to_email: e, course_id: cid, message: String(message || '').slice(0, 500), status: 'pending', via: via || 'direct', created_at: now(), responded_at: null });
    return true;
  }
  function attach(uid) {
    const u = db.users.find((x) => x.id === uid);
    if (!u || !u.confirmed) return 0;
    let n = 0;
    for (const x of db.offers) {
      if (!x.to_user && x.to_email === u.email && x.status === 'pending' && !granted(uid, x.course_id) &&
        !db.offers.some((y) => y.to_user === uid && y.course_id === x.course_id && y.status === 'pending')) { x.to_user = uid; n++; }
    }
    return n;
  }
  function me(uid) {
    attach(uid);
    attachFriends(uid);
    const p = profile(uid);
    return { id: p.id, email: p.email, display_name: p.display_name, role: p.role, friend_code: p.friend_code, findable_by_name: !!p.findable_by_name, owner_exists: db.profiles.some((x) => x.role === 'owner') };
  }

  /* ----------------------------------------------- friends (0002_friends) --- */
  const OPEN = ['pending', 'ignored'];
  const pair = (a, b) => (a < b ? [a, b] : [b, a]);
  const areFriends = (a, b) => { const [x, y] = pair(a, b); return db.friendships.some((f) => f.user_a === x && f.user_b === y); };
  const blockedEither = (a, b) => db.blocks.some((x) => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a));
  const befriend = (a, b) => { const [x, y] = pair(a, b); if (!areFriends(a, b)) db.friendships.push({ user_a: x, user_b: y, created_at: now() }); };
  const unfriend = (a, b) => { const [x, y] = pair(a, b); db.friendships = db.friendships.filter((f) => !(f.user_a === x && f.user_b === y)); };
  function attachFriends(uid) {
    const u = db.users.find((x) => x.id === uid);
    if (!u || !u.confirmed) return 0;
    let n = 0;
    for (const r of db.friendRequests) {
      if (r.to_user || r.to_email !== u.email || OPEN.indexOf(r.status) < 0) continue;
      if (r.from_user === uid || areFriends(r.from_user, uid) || db.friendRequests.some((x) => x !== r && x.from_user === r.from_user && x.to_user === uid && OPEN.indexOf(x.status) >= 0)) { r.status = 'cancelled'; r.responded_at = now(); continue; }
      r.to_user = uid; n++;
    }
    return n;
  }
  function resolvePerson(to) {
    const t = String(to || '').trim();
    if (/^[0-9a-f-]{36}$/i.test(t)) return (profile(t) || {}).id || null;
    if (/^(LNT-)?[A-Z0-9]{4}$/i.test(t)) { const c = /^LNT-/i.test(t) ? t.toUpperCase() : 'LNT-' + t.toUpperCase(); return (db.profiles.find((p) => p.friend_code === c) || {}).id || null; }
    if (t.includes('@')) return (db.profiles.find((p) => p.email === t.toLowerCase()) || {}).id || null;
    return null;
  }
  function relation(me_, other) {
    if (me_ === other) return 'you';
    if (db.blocks.some((b) => b.blocker === me_ && b.blocked === other)) return 'blocked';
    if (areFriends(me_, other)) return 'friend';
    if (db.friendRequests.some((r) => r.from_user === me_ && r.to_user === other && OPEN.indexOf(r.status) >= 0)) return 'sent';
    if (db.friendRequests.some((r) => r.from_user === other && r.to_user === me_ && OPEN.indexOf(r.status) >= 0)) return 'received';
    return 'none';
  }
  function pull(uid, cid, since) {
    const snap = db.snapshots.find((s) => s.user_id === uid && s.course_id === cid);
    const pos = db.position.find((s) => s.user_id === uid && s.course_id === cid);
    return {
      items: db.items.filter((i) => i.user_id === uid && i.course_id === cid).map(({ user_id, course_id, ...i }) => i),
      seconds: db.time.filter((t) => t.user_id === uid && t.course_id === cid).reduce((a, t) => a + t.seconds, 0),
      position: pos ? { ref: pos.ref, at: pos.at } : null,
      snapshot: snap && snap.at > (Number(since) || 0) ? { keys: snap.state, at: snap.at } : null,
    };
  }
  const courseOut = (uid, c) => {
    const v = db.versions.find((x) => x.course_id === c.id && x.version === c.latest_version);
    return { id: c.id, title: c.title, description: c.description, status: c.status, visibility: c.visibility, listed: c.listed,
      latest_version: c.latest_version, pack_path: v ? v.pack_path : null, size: v ? v.size : null, sha256: v ? v.sha256 : null,
      changelog: v ? v.changelog : null, access: isOwner(uid) ? 'owner' : granted(uid, c.id) ? 'granted' : 'open' };
  };
  const lastPresence = (uid) => db.presence.filter((p) => p.user_id === uid).sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))[0];

  const RPC = {
    lantern_me: (uid) => me(uid),
    lantern_set_findable: (uid, a) => { profile(uid).findable_by_name = !!a.p_by_name; return me(uid); },
    lantern_find_people: (uid, a) => {
      const q = String(a.p_query || '').trim();
      if (q.length < 2) return [];
      const owner = isOwner(uid), code = /^LNT-/i.test(q) ? q.toUpperCase() : 'LNT-' + q.toUpperCase(), ql = q.toLowerCase();
      return db.profiles.filter((p) => p.id !== uid && !db.blocks.some((b) => b.blocker === p.id && b.blocked === uid) &&
        (p.friend_code === code || p.email === ql || (p.findable_by_name && q.length >= 3 && p.display_name.toLowerCase().includes(ql)) ||
         (owner && (p.display_name.toLowerCase().includes(ql) || p.email.includes(ql)))))
        .slice(0, 20).sort((x, y) => (x.display_name < y.display_name ? -1 : 1))
        .map((p) => ({ id: p.id, display_name: p.display_name, friend_code: p.friend_code, email: owner ? p.email : null, relation: relation(uid, p.id) }));
    },
    lantern_send_friend_request: (uid, a) => {
      const raw = String(a.p_to || '').trim();
      const who = resolvePerson(raw);
      let e = null;
      if (!who && raw.includes('@')) { e = raw.toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail('That is not an email address: ' + raw); }
      else if (!who) fail('Nobody was found with that friend code or email.');
      if (who === uid) fail('That is you.');
      if (db.friendRequests.filter((r) => r.from_user === uid && Date.now() - Date.parse(r.created_at) < 86400000).length >= 20) fail('That is a lot of friend requests for one day. Try again tomorrow.');
      const msg = String(a.p_message || '').slice(0, 300);
      if (!who) {
        if (!db.friendRequests.some((r) => r.from_user === uid && !r.to_user && r.to_email === e && OPEN.indexOf(r.status) >= 0)) db.friendRequests.push({ id: randomUUID(), from_user: uid, to_user: null, to_email: e, message: msg, status: 'pending', created_at: now(), responded_at: null });
        return { status: 'sent', waiting_for_signup: true };
      }
      if (blockedEither(uid, who)) fail('You cannot send a friend request to this person.');
      if (areFriends(uid, who)) return { status: 'friend' };
      const theirs = db.friendRequests.find((r) => r.from_user === who && r.to_user === uid && OPEN.indexOf(r.status) >= 0);
      if (theirs) { theirs.status = 'accepted'; theirs.responded_at = now(); befriend(uid, who); return { status: 'friend', accepted_theirs: true }; }
      if (db.friendRequests.some((r) => r.from_user === uid && r.to_user === who && OPEN.indexOf(r.status) >= 0)) return { status: 'sent' };
      if (db.friendRequests.some((r) => r.from_user === uid && r.to_user === who && r.status === 'declined' && Date.now() - Date.parse(r.responded_at) < 7 * 86400000)) fail('They said no to a request recently. You can ask again after a week.');
      db.friendRequests.push({ id: randomUUID(), from_user: uid, to_user: who, to_email: null, message: msg, status: 'pending', created_at: now(), responded_at: null });
      return { status: 'sent' };
    },
    lantern_respond_friend_request: (uid, a) => {
      const r = db.friendRequests.find((x) => x.id === a.p_request && x.to_user === uid);
      if (!r) fail('That friend request was not found.');
      if (OPEN.indexOf(r.status) < 0) fail('That friend request is no longer waiting (it was ' + r.status + ').');
      if (a.p_action === 'accept') { r.status = 'accepted'; r.responded_at = now(); befriend(uid, r.from_user); return { status: 'friend', friend: r.from_user }; }
      if (a.p_action === 'decline') { r.status = 'declined'; r.responded_at = now(); return { status: 'declined' }; }
      if (a.p_action === 'ignore') { r.status = 'ignored'; r.responded_at = now(); return { status: 'ignored' }; }
      return fail('Say accept, decline or ignore.');
    },
    lantern_cancel_friend_request: (uid, a) => {
      const r = db.friendRequests.find((x) => x.id === a.p_request && x.from_user === uid && OPEN.indexOf(x.status) >= 0);
      if (!r) fail('That friend request is no longer waiting.');
      r.status = 'cancelled'; r.responded_at = now(); return { ok: true };
    },
    lantern_remove_friend: (uid, a) => { unfriend(uid, a.p_user); return { ok: true }; },
    lantern_block_user: (uid, a) => {
      if (a.p_user === uid) fail('That is you.');
      if (!db.blocks.some((b) => b.blocker === uid && b.blocked === a.p_user)) db.blocks.push({ blocker: uid, blocked: a.p_user, created_at: now() });
      unfriend(uid, a.p_user);
      for (const r of db.friendRequests) if (OPEN.indexOf(r.status) >= 0 && ((r.from_user === uid && r.to_user === a.p_user) || (r.from_user === a.p_user && r.to_user === uid))) { r.status = 'cancelled'; r.responded_at = now(); }
      return { ok: true };
    },
    lantern_unblock_user: (uid, a) => { db.blocks = db.blocks.filter((b) => !(b.blocker === uid && b.blocked === a.p_user)); return { ok: true }; },
    lantern_my_friends: (uid) => db.friendships.filter((f) => f.user_a === uid || f.user_b === uid).map((f) => {
      const p = profile(f.user_a === uid ? f.user_b : f.user_a);
      const pr = lastPresence(p.id);
      const c = pr && pr.course_id ? course(pr.course_id) : null;
      return { id: p.id, display_name: p.display_name, friend_code: p.friend_code, role: p.role, since: f.created_at, last_seen: pr ? pr.last_seen : null,
        online: !!(pr && Date.now() - Date.parse(pr.last_seen) < 120000), current_course: pr ? pr.course_id : null, current_course_title: c ? c.title : null };
    }).sort((x, y) => (x.display_name < y.display_name ? -1 : 1)),
    lantern_my_friend_requests: (uid) => {
      attachFriends(uid);
      const recent = (r) => r.responded_at && Date.now() - Date.parse(r.responded_at) < 7 * 86400000;
      return {
        received: db.friendRequests.filter((r) => r.to_user === uid && OPEN.indexOf(r.status) >= 0).reverse().map((r) => { const p = profile(r.from_user); return { id: r.id, from: r.from_user, from_name: p.display_name, from_code: p.friend_code, from_role: p.role, message: r.message, status: r.status, created_at: r.created_at }; }),
        sent: db.friendRequests.filter((r) => r.from_user === uid && (OPEN.indexOf(r.status) >= 0 || (['accepted', 'declined'].indexOf(r.status) >= 0 && recent(r)))).reverse().map((r) => ({ id: r.id, to: r.to_user, to_name: r.to_user ? profile(r.to_user).display_name : r.to_email, to_email: r.to_user ? null : r.to_email, status: r.status === 'ignored' ? 'pending' : r.status, created_at: r.created_at, responded_at: r.status === 'ignored' ? null : r.responded_at })),
        blocked: db.blocks.filter((b) => b.blocker === uid).map((b) => ({ id: b.blocked, display_name: profile(b.blocked).display_name })),
      };
    },
    lantern_set_name: (uid, a) => { if (!String(a.p_name || '').trim()) fail('A name is needed.'); profile(uid).display_name = String(a.p_name).trim().slice(0, 80); return me(uid); },
    lantern_claim_owner: (uid, a) => {
      if (db.profiles.some((p) => p.role === 'owner')) fail('This hub already has an owner.');
      if (a.p_code !== db.claimCode) fail('That claim code is not right.');
      profile(uid).role = 'owner'; return me(uid);
    },
    lantern_heartbeat: (uid, a) => {
      let p = db.presence.find((x) => x.user_id === uid && x.device_id === a.p_device);
      if (!p) { p = { user_id: uid, device_id: a.p_device }; db.presence.push(p); }
      Object.assign(p, { last_seen: now(), app_version: a.p_version, course_id: a.p_course, lesson_id: a.p_lesson, status: a.p_status });
      return { now: Date.now() };
    },
    lantern_my_courses: (uid) => db.courses.filter((c) => isOwner(uid) || (c.status === 'published' && (c.visibility === 'open' || granted(uid, c.id))))
      .sort((a, b) => (a.title < b.title ? -1 : 1)).map((c) => courseOut(uid, c)),
    lantern_listed_courses: (uid) => db.courses.filter((c) => c.status === 'published' && c.listed && !hasAccess(uid, c.id))
      .map((c) => ({ id: c.id, title: c.title, description: c.description, requested: db.requests.some((r) => r.user_id === uid && r.course_id === c.id && r.status === 'pending') })),
    lantern_request_course: (uid, a) => {
      const c = course(a.p_course);
      if (!c || c.status !== 'published' || !c.listed) fail('That course cannot be requested.');
      if (!db.requests.some((r) => r.user_id === uid && r.course_id === c.id && r.status === 'pending')) {
        db.requests.push({ id: randomUUID(), user_id: uid, course_id: c.id, message: String(a.p_message || ''), status: 'pending', created_at: now() });
      }
      return { ok: true };
    },
    lantern_my_offers: (uid) => db.offers.filter((x) => x.to_user === uid && x.status === 'pending').map((x) => ({
      id: x.id, course_id: x.course_id, course_title: course(x.course_id).title, course_description: course(x.course_id).description,
      from_name: (profile(x.from_user) || {}).display_name || 'Someone', message: x.message, status: x.status, via: x.via, created_at: x.created_at })),
    lantern_accept_offer: (uid, a) => {
      const x = db.offers.find((y) => y.id === a.p_offer && y.to_user === uid);
      if (!x) fail('That offer was not found.');
      if (x.status !== 'pending') fail('That offer is no longer waiting (it was ' + x.status + ').');
      if (!granted(uid, x.course_id)) db.grants.push({ user_id: uid, course_id: x.course_id, granted_by: x.from_user, via: 'offer', created_at: now() });
      x.status = 'accepted'; x.responded_at = now();
      return { course_id: x.course_id };
    },
    lantern_decline_offer: (uid, a) => {
      const x = db.offers.find((y) => y.id === a.p_offer && y.to_user === uid && y.status === 'pending');
      if (!x) fail('That offer is no longer waiting.');
      x.status = 'declined'; x.responded_at = now(); return { ok: true };
    },
    lantern_redeem_invite: (uid, a) => {
      const i = db.invites.find((x) => x.code === String(a.p_code || '').trim().toUpperCase());
      if (!i) fail('That invite code was not found.');
      if (i.expires_at && i.expires_at < Date.now()) fail('That invite has expired.');
      if (i.max_uses != null && i.uses >= i.max_uses) fail('That invite has been used up.');
      let n = 0;
      for (const c of i.course_ids) if (makeOffer(i.created_by, uid, c, i.message, 'invite')) n++;
      i.uses++; return { offers: n };
    },
    lantern_pull: (uid, a) => pull(uid, a.p_course, a.p_since),
    lantern_prefs_get: (uid) => db.prefs.get(uid) || { prefs: {}, updated_at: 0 },
    lantern_prefs_set: (uid, a) => { const cur = db.prefs.get(uid); if (!cur || Number(a.p_updated_at) > cur.updated_at) db.prefs.set(uid, { prefs: a.p_prefs || {}, updated_at: Number(a.p_updated_at) }); return db.prefs.get(uid); },
    lantern_sync: (uid, a) => {
      if (!hasAccess(uid, a.p_course)) fail('You do not have ' + a.p_course + ' any more.', '42501');
      for (const it of a.p_items || []) {
        let r = db.items.find((x) => x.user_id === uid && x.course_id === a.p_course && x.kind === it.kind && x.ref === it.ref);
        if (!r) { r = { user_id: uid, course_id: a.p_course, kind: it.kind, ref: it.ref, completed: false, best: 0, attempts: 0, first_done_at: null, updated_at: 0 }; db.items.push(r); }
        r.completed = r.completed || !!it.completed;
        r.best = Math.max(r.best, Number(it.best) || 0);
        r.attempts = Math.max(r.attempts, Number(it.attempts) || 0);
        const f = it.first_done_at == null ? null : Number(it.first_done_at);
        r.first_done_at = r.first_done_at == null ? f : f == null ? r.first_done_at : Math.min(r.first_done_at, f);
        r.updated_at = Math.max(r.updated_at, Number(it.updated_at) || 0);
      }
      for (const t of a.p_time || []) if (!db.time.some((x) => x.user_id === uid && x.id === t.id)) db.time.push({ user_id: uid, id: t.id, course_id: a.p_course, seconds: Math.max(0, Number(t.seconds) || 0), at: t.at });
      if (a.p_position && a.p_position.at) {
        const p = db.position.find((x) => x.user_id === uid && x.course_id === a.p_course);
        if (!p) db.position.push({ user_id: uid, course_id: a.p_course, ref: a.p_position.ref, at: Number(a.p_position.at) });
        else if (Number(a.p_position.at) > p.at) Object.assign(p, { ref: a.p_position.ref, at: Number(a.p_position.at) });
      }
      if (a.p_snapshot && a.p_snapshot.at) {
        const s = db.snapshots.find((x) => x.user_id === uid && x.course_id === a.p_course);
        if (!s) db.snapshots.push({ user_id: uid, course_id: a.p_course, state: a.p_snapshot.keys, at: Number(a.p_snapshot.at), device_id: a.p_device });
        else if (Number(a.p_snapshot.at) > s.at) Object.assign(s, { state: a.p_snapshot.keys, at: Number(a.p_snapshot.at), device_id: a.p_device });
      }
      if (a.p_summary) {
        let s = db.summary.find((x) => x.user_id === uid && x.course_id === a.p_course);
        if (!s) { s = { user_id: uid, course_id: a.p_course }; db.summary.push(s); }
        Object.assign(s, { percent: a.p_summary.percent || 0, finished: a.p_summary.finished || 0, count: a.p_summary.count || 0,
          current_ref: a.p_summary.current_ref || null, current_title: a.p_summary.current_title || null,
          seconds: db.time.filter((t) => t.user_id === uid && t.course_id === a.p_course).reduce((x, t) => x + t.seconds, 0), updated_at: now() });
      }
      return pull(uid, a.p_course, a.p_since);
    },

    lantern_owner_people: (uid) => {
      needOwner(uid);
      const people = db.profiles.map((p) => {
        const pr = lastPresence(p.id);
        return { id: p.id, email: p.email, display_name: p.display_name, role: p.role, created_at: p.created_at,
          friend_code: p.friend_code, relation: relation(uid, p.id),
          last_seen: pr ? pr.last_seen : null, online: !!(pr && Date.now() - Date.parse(pr.last_seen) < 120000),
          app_version: pr ? pr.app_version : null, current_course: pr ? pr.course_id : null, current_lesson: pr ? pr.lesson_id : null, status: pr ? pr.status : null,
          groups: db.groupMembers.filter((m) => m.user_id === p.id).map((m) => db.groups.find((g) => g.id === m.group_id).name),
          courses: db.summary.filter((s) => s.user_id === p.id).map(({ user_id, ...s }) => s),
          granted: db.grants.filter((g) => g.user_id === p.id).map((g) => g.course_id) };
      });
      const emails = new Map();
      for (const x of db.offers.filter((y) => !y.to_user && y.status === 'pending')) {
        if (!emails.has(x.to_email)) emails.set(x.to_email, []);
        emails.get(x.to_email).push(x.course_id);
      }
      for (const [e, list] of emails) people.push({ id: null, email: e, display_name: e, role: 'invited', pending_invite: true, online: false, courses: [], granted: [], groups: [], offered: list });
      return people.sort((a, b) => (a.display_name < b.display_name ? -1 : 1));
    },
    lantern_people_list: (uid) => RPC.lantern_owner_people(uid),
    lantern_owner_courses: (uid) => {
      needOwner(uid);
      return db.courses.map((c) => ({ id: c.id, title: c.title, description: c.description, status: c.status, visibility: c.visibility, listed: c.listed,
        latest_version: c.latest_version,
        versions: db.versions.filter((v) => v.course_id === c.id).map((v) => ({ version: v.version, published_at: v.published_at, changelog: v.changelog })),
        holders: db.grants.filter((g) => g.course_id === c.id).map((g) => { const s = db.summary.find((x) => x.user_id === g.user_id && x.course_id === c.id); return { user_id: g.user_id, display_name: profile(g.user_id).display_name, via: g.via, percent: s ? s.percent : 0, current_title: s ? s.current_title : null, updated_at: s ? s.updated_at : null }; }),
        pending: db.offers.filter((x) => x.course_id === c.id && x.status === 'pending').map((x) => ({ offer_id: x.id, user_id: x.to_user, display_name: x.to_user ? profile(x.to_user).display_name : x.to_email, created_at: x.created_at })),
      }));
    },
    lantern_owner_send: (uid, a) => {
      needOwner(uid);
      if (!course(a.p_course)) fail('There is no course ' + a.p_course + '.');
      let n = 0;
      for (const x of a.p_users || []) if (makeOffer(uid, x, a.p_course, a.p_message, 'direct')) n++;
      for (const e of a.p_emails || []) if (makeEmailOffer(uid, e, a.p_course, a.p_message, 'direct')) n++;
      return { offers: n };
    },
    lantern_send_offer: (uid, a) => {
      needOwner(uid);
      const to = String(a.p_to || '');
      return /^[0-9a-f-]{36}$/i.test(to) ? RPC.lantern_owner_send(uid, { p_users: [to], p_course: a.p_course, p_message: a.p_message })
        : RPC.lantern_owner_send(uid, { p_emails: [to], p_course: a.p_course, p_message: a.p_message });
    },
    lantern_owner_offers: (uid) => { needOwner(uid); return db.offers.map((x) => ({ id: x.id, to_user: x.to_user, to_email: x.to_email, to_name: x.to_user ? profile(x.to_user).display_name : x.to_email, course_id: x.course_id, course_title: course(x.course_id).title, message: x.message, status: x.status, via: x.via, created_at: x.created_at, responded_at: x.responded_at })); },
    lantern_owner_withdraw: (uid, a) => { needOwner(uid); const x = db.offers.find((y) => y.id === a.p_offer && y.status === 'pending'); if (!x) fail('That offer is no longer waiting.'); x.status = 'withdrawn'; x.responded_at = now(); return { ok: true }; },
    lantern_owner_invite: (uid, a) => { needOwner(uid); const code = randomBytes(5).toString('hex').toUpperCase(); db.invites.push({ code, created_by: uid, course_ids: a.p_courses, message: a.p_message || '', expires_at: a.p_days ? Date.now() + a.p_days * 86400000 : null, max_uses: a.p_uses == null ? null : a.p_uses, uses: 0 }); return { code }; },
    lantern_owner_grant: (uid, a) => { needOwner(uid); if (a.p_on) { if (!granted(a.p_user, a.p_course)) db.grants.push({ user_id: a.p_user, course_id: a.p_course, granted_by: uid, via: 'grant', created_at: now() }); } else db.grants = db.grants.filter((g) => !(g.user_id === a.p_user && g.course_id === a.p_course)); return { ok: true }; },
    lantern_owner_save_course: (uid, a) => {
      needOwner(uid);
      let c = course(a.p_id);
      if (!c) { c = { id: a.p_id, title: a.p_title, description: a.p_description || '', status: a.p_status || 'draft', visibility: a.p_visibility || 'private', listed: !!a.p_listed, latest_version: null }; db.courses.push(c); }
      else for (const [k, v] of [['title', a.p_title], ['description', a.p_description], ['status', a.p_status], ['visibility', a.p_visibility], ['listed', a.p_listed]]) if (v !== undefined && v !== null) c[k] = v;
      return { ok: true };
    },
    lantern_owner_publish: (uid, a) => {
      needOwner(uid);
      db.versions = db.versions.filter((v) => !(v.course_id === a.p_course && v.version === a.p_version));
      db.versions.push({ course_id: a.p_course, version: a.p_version, pack_path: a.p_pack_path, size: a.p_size, sha256: a.p_sha256, changelog: a.p_changelog || '', manifest: a.p_manifest, published_at: now() });
      course(a.p_course).latest_version = a.p_version;
      return { ok: true };
    },
    lantern_owner_groups: (uid) => { needOwner(uid); return db.groups.map((g) => ({ id: g.id, name: g.name, members: db.groupMembers.filter((m) => m.group_id === g.id).map((m) => ({ user_id: m.user_id, display_name: profile(m.user_id).display_name })), courses: db.groupCourses.filter((x) => x.group_id === g.id).map((x) => x.course_id) })); },
    lantern_owner_group_save: (uid, a) => { needOwner(uid); if (!a.p_id) { const g = { id: randomUUID(), name: a.p_name }; db.groups.push(g); return { id: g.id }; } db.groups.find((g) => g.id === a.p_id).name = a.p_name; return { id: a.p_id }; },
    lantern_owner_group_members: (uid, a) => {
      needOwner(uid); let n = 0;
      for (const x of a.p_add || []) {
        if (!db.groupMembers.some((m) => m.group_id === a.p_group && m.user_id === x)) db.groupMembers.push({ group_id: a.p_group, user_id: x });
        for (const gc of db.groupCourses.filter((y) => y.group_id === a.p_group)) if (makeOffer(uid, x, gc.course_id, gc.message, 'group')) n++;
      }
      db.groupMembers = db.groupMembers.filter((m) => !(m.group_id === a.p_group && (a.p_remove || []).includes(m.user_id)));
      return { offers: n };
    },
    lantern_owner_group_courses: (uid, a) => {
      needOwner(uid); let n = 0;
      for (const c of a.p_add || []) {
        const ex = db.groupCourses.find((y) => y.group_id === a.p_group && y.course_id === c);
        if (ex) ex.message = a.p_message || ''; else db.groupCourses.push({ group_id: a.p_group, course_id: c, message: a.p_message || '' });
        for (const m of db.groupMembers.filter((y) => y.group_id === a.p_group)) if (makeOffer(uid, m.user_id, c, a.p_message, 'group')) n++;
      }
      db.groupCourses = db.groupCourses.filter((y) => !(y.group_id === a.p_group && (a.p_remove || []).includes(y.course_id)));
      return { offers: n };
    },
    lantern_owner_requests: (uid) => { needOwner(uid); return db.requests.map((r) => ({ id: r.id, user_id: r.user_id, display_name: profile(r.user_id).display_name, course_id: r.course_id, course_title: course(r.course_id).title, message: r.message, status: r.status, created_at: r.created_at })); },
    lantern_owner_answer_request: (uid, a) => {
      needOwner(uid);
      const r = db.requests.find((x) => x.id === a.p_request && x.status === 'pending');
      if (!r) fail('That request is no longer waiting.');
      if (a.p_approve && !granted(r.user_id, r.course_id)) db.grants.push({ user_id: r.user_id, course_id: r.course_id, granted_by: uid, via: 'request', created_at: now() });
      r.status = a.p_approve ? 'approved' : 'declined'; return { ok: true };
    },
  };

  // A hub set up before 0002_friends.sql (tests that the app copes).
  if (o.noFriends) for (const k of Object.keys(RPC)) if (/friend|find_people|findable|block_user/.test(k)) delete RPC[k];

  /* ------------------------------------------------------------- http --- */
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = () => { try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) { return {}; } };
    const send = (status, obj, headers) => {
      const buf = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
      res.writeHead(status, Object.assign({ 'content-type': Buffer.isBuffer(obj) ? 'application/octet-stream' : 'application/json', 'content-length': buf.length }, headers || {}));
      res.end(buf);
    };
    const p = url.pathname;
    if (p.startsWith('/__test/')) {
      if (p === '/__test/link') return send(200, { link: db.links.get(String(url.searchParams.get('email')).toLowerCase()) || null });
      if (p === '/__test/otp') return send(200, { code: db.otps.get(String(url.searchParams.get('email')).toLowerCase()) || null });
      if (p === '/__test/claim-code') return send(200, { code: db.claimCode });
      if (p === '/__test/state') return send(200, Object.assign({}, db, { objects: [...db.objects.keys()], otps: undefined, links: undefined }));
      if (p === '/__test/expire-tokens') { for (const v of tokens.values()) v.exp = 0; return send(200, { ok: true }); }
      if (p === '/__test/cut-downloads') { server.cutDownloads = Number(url.searchParams.get('n') || 1); return send(200, { cut: server.cutDownloads }); }
      if (p === '/__test/down') { server.down = url.searchParams.get('on') !== '0'; return send(200, { down: server.down }); }
    }
    if (server.down) return send(503, { message: 'down for the test' });
    if (req.headers.apikey !== ANON) return send(401, { message: 'Invalid API key' });

    try {
      if (p === '/auth/v1/settings') return send(200, { external: { email: true } });
      if (p === '/auth/v1/signup' && req.method === 'POST') {
        const b = body();
        const email = String(b.email || '').toLowerCase();
        if (db.users.some((u) => u.email === email)) return send(422, { msg: 'User already registered' });
        if (String(b.password || '').length < 6) return send(422, { msg: 'Password should be at least 6 characters.' });
        const u = newUser(email, b.password, b.data, !o.confirmEmail);
        if (o.confirmEmail) return send(200, { id: u.id, email: u.email });
        return send(200, issue(u.id));
      }
      if (p === '/auth/v1/token' && req.method === 'POST') {
        const b = body();
        if (url.searchParams.get('grant_type') === 'password') {
          const u = db.users.find((x) => x.email === String(b.email || '').toLowerCase() && x.password === b.password);
          if (!u) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
          if (!u.confirmed) return send(400, { error: 'invalid_grant', error_description: 'Email not confirmed' });
          return send(200, issue(u.id));
        }
        if (url.searchParams.get('grant_type') === 'refresh_token') {
          const uid = refreshes.get(b.refresh_token);
          if (!uid) return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
          refreshes.delete(b.refresh_token);   // one use, as Supabase rotates them
          return send(200, issue(uid));
        }
      }
      if (p === '/auth/v1/otp' && req.method === 'POST') {
        const b = body();
        const email = String(b.email || '').toLowerCase();
        if (!db.users.some((u) => u.email === email)) {
          if (b.create_user === false) return send(422, { msg: 'Signups not allowed for otp' });
          newUser(email, null, b.data, false);
        }
        db.otps.set(email, String(Math.floor(100000 + Math.random() * 900000)));
        // the emailed link, as Supabase's default email has it: pressing it lands on
        // redirect_to with the session in the #fragment (and confirms the address)
        const to = url.searchParams.get('redirect_to');
        if (to) {
          const u = db.users.find((x) => x.email === email);
          const t = issue(u.id);
          u.confirmed = true;
          db.links.set(email, to + '#access_token=' + t.access_token + '&refresh_token=' + t.refresh_token + '&expires_in=' + t.expires_in + '&token_type=bearer&type=magiclink');
        }
        return send(200, {});
      }
      if (p === '/auth/v1/verify' && req.method === 'POST') {
        const b = body();
        const email = String(b.email || '').toLowerCase();
        if (!b.token || db.otps.get(email) !== String(b.token)) return send(403, { msg: 'Token has expired or is invalid' });
        db.otps.delete(email);
        const u = db.users.find((x) => x.email === email);
        u.confirmed = true;
        return send(200, issue(u.id));
      }
      if (p === '/auth/v1/logout') return send(204, {});

      const uid = who(req);
      if (p.startsWith('/rest/v1/rpc/')) {
        if (!uid) return send(401, { message: 'JWT expired' });
        const fn = RPC[decodeURIComponent(p.slice('/rest/v1/rpc/'.length))];
        if (!fn) return send(404, { message: 'Could not find the function' });
        try { return send(200, fn(uid, body())); }
        catch (e) { return send(e.code === '42501' ? 403 : 400, { message: e.message, code: e.code }); }
      }
      if (p.startsWith('/storage/v1/object/authenticated/course-packs/') && req.method === 'GET') {
        if (!uid) return send(401, { message: 'JWT expired' });
        const path = decodeURIComponent(p.slice('/storage/v1/object/authenticated/course-packs/'.length));
        if (!hasAccess(uid, path.split('/')[0])) return send(400, { message: 'Object not found' });
        const buf = db.objects.get(path);
        if (!buf) return send(400, { message: 'Object not found' });
        // a download cut off half way (the connection drops), for the retry test
        if (server.cutDownloads > 0) { server.cutDownloads--; res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length }); res.write(buf.subarray(0, Math.floor(buf.length / 3))); return setTimeout(() => res.destroy(), 50); }
        return send(200, buf);
      }
      if (p.startsWith('/storage/v1/object/course-packs/') && req.method === 'POST') {
        if (!uid || !isOwner(uid)) return send(403, { message: 'new row violates row-level security policy' });
        const path = decodeURIComponent(p.slice('/storage/v1/object/course-packs/'.length));
        db.objects.set(path, raw);
        return send(200, { Key: 'course-packs/' + path });
      }
      return send(404, { message: 'not found in the fake hub: ' + p });
    } catch (e) {
      return send(500, { message: e.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(o.port || 0, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + server.address().port;
      resolve({ url, anonKey: ANON, server, db, close: () => new Promise((r) => server.close(r)),
        claimCode: () => db.claimCode, otp: (email) => db.otps.get(String(email).toLowerCase()), link: (email) => db.links.get(String(email).toLowerCase()) });
    });
  });
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('fake-hub.mjs')) {
  startFakeHub({ port: Number(process.argv[2]) || 0, anonKey: process.env.FAKE_ANON || undefined }).then((h) => {
    console.log(JSON.stringify({ url: h.url, anonKey: h.anonKey, claimCode: h.claimCode() }));
  });
}
