/* ===========================================================================
   server/src/platform/friends-routes.js — friends, for the app and for
   Dayspring.
   ---------------------------------------------------------------------------
     GET  /api/hub/friends[?refresh=1]      friends, requests (got / sent),
                                            blocked, my friend code
     POST /api/hub/friends/find             { query }  → people
     POST /api/hub/friends/request          { to, message }   to = friend code,
                                            email or account id
     POST /api/hub/friends/requests/:id/:action   accept | decline | ignore | cancel
     POST /api/hub/friends/:user/:action          remove | block | unblock
     POST /api/hub/friends/findable         { byName }

   For a companion app on this computer (docs/dev/dayspring-bridge.md):
     GET  /api/local/friends                read-only, like /api/local/offers
     POST /api/local/friends/request        needs the presence-file token
     POST /api/local/friend-requests/:id/:action   needs the token

   The rules (who may see and do what) live on the hub, in
   supabase/migrations/0002_friends.sql. Friends are a hub feature: the list
   is kept here so it shows offline, but every change needs the hub.
   =========================================================================== */

import * as engine from './sync/engine.js';

const ACTIONS = ['accept', 'decline', 'ignore', 'cancel'];

// A hub error shown to the person as the hub wrote it; "offline" as 503.
async function hubCall(fn) {
  try { return { body: await fn() }; }
  catch (e) {
    if (e && e.kind === 'offline') return { status: 503, body: { error: e.message, offline: true } };
    if (e && e.kind === 'auth') return { status: 401, body: { error: e.message } };
    if (e && e.kind === 'denied') return { status: 403, body: { error: e.message } };
    if (e && e.name === 'HubError') return { status: 400, body: { error: e.message } };
    throw e;
  }
}

export function view() {
  const st = engine.status();
  const f = engine.friendsState();
  return {
    signedIn: st.signedIn, online: st.online, owner: st.owner,
    me: st.profile ? { id: st.profile.id, display_name: st.profile.display_name, friend_code: st.profile.friend_code || null, findable_by_name: !!st.profile.findable_by_name } : null,
    available: f.available !== false, friends: f.friends, received: f.received, sent: f.sent, blocked: f.blocked, at: f.at || null,
    // the badge: new requests, not the ones set aside with Ignore
    waiting: f.received.filter((r) => r.status === 'pending').length,
  };
}

export function register(r, opts) {
  const o = opts || {};
  const needToken = o.needToken || (() => {});
  const L = o.local || { auth: false };
  const signedIn = () => { if (!engine.status().signedIn) throw Object.assign(new Error('Sign in to your hub first (Settings → Account & hub).'), { status: 401 }); };

  r.get('/api/hub/friends', async ({ query }) => {
    const q = query || {};
    const want = q.refresh === '1' || (q.get && q.get('refresh') === '1');
    if (want && engine.status().signedIn) { try { await engine.refreshFriends(); } catch (e) { /* offline: the kept copy */ } }
    return { body: view() };
  });
  r.post('/api/hub/friends/find', async ({ body }) => { signedIn(); return hubCall(() => engine.findPeople(body && body.query)); });
  r.post('/api/hub/friends/request', async ({ body }) => { signedIn(); return hubCall(() => engine.sendFriendRequest(body && body.to, body && body.message)); });
  r.post('/api/hub/friends/requests/:id/:action', async ({ params }) => {
    signedIn();
    if (ACTIONS.indexOf(params.action) < 0) return { status: 400, body: { error: 'Say accept, decline, ignore or cancel.' } };
    return hubCall(() => (params.action === 'cancel' ? engine.cancelFriendRequest(params.id) : engine.respondFriendRequest(params.id, params.action)));
  });
  r.post('/api/hub/friends/findable', async ({ body }) => { signedIn(); return hubCall(() => engine.setFindable(!!(body && body.byName))); });
  r.post('/api/hub/friends/:user/:action', async ({ params }) => {
    signedIn();
    const fn = { remove: engine.removeFriend, block: engine.blockUser, unblock: engine.unblockUser }[params.action];
    if (!fn) return { status: 400, body: { error: 'Say remove, block or unblock.' } };
    return hubCall(() => fn(params.user));
  });

  // A companion app (Dayspring): read freely on this computer, change with the token.
  r.get('/api/local/friends', async () => ({ body: view() }), L);
  r.post('/api/local/friends/request', async ({ req, body }) => { needToken(req); signedIn(); return hubCall(() => engine.sendFriendRequest(body && body.to, body && body.message)); }, L);
  r.post('/api/local/friend-requests/:id/:action', async ({ req, params }) => {
    needToken(req); signedIn();
    if (ACTIONS.indexOf(params.action) < 0) return { status: 400, body: { error: 'Say accept, decline, ignore or cancel.' } };
    return hubCall(() => (params.action === 'cancel' ? engine.cancelFriendRequest(params.id) : engine.respondFriendRequest(params.id, params.action)));
  }, L);
}
