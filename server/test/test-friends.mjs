#!/usr/bin/env node
/* ===========================================================================
   server/test/test-friends.mjs — friends on the hub, and the app's side.
   ---------------------------------------------------------------------------
       node server/test/test-friends.mjs

   Part 1 runs the hub's rules (fake-hub.mjs = supabase/migrations/0002_friends.sql
   in JavaScript) through the real Supabase adapter, as four people.
   Part 2 starts two real copies of the app and checks its friends routes,
   the events and the Dayspring (local) API; and a hub without friends.
   =========================================================================== */

import { startFakeHub } from './fake-hub.mjs';
import { supabaseAdapter } from '../src/platform/sync/supabase.js';
import { startApp, suite, until } from './helpers.mjs';
import { validateEvent, makeEvent } from '../src/platform/eco.js';

const t = suite('Friends: codes, requests, ignore, block, courses to friends');

async function person(hub, a, email, name) {
  const r = await a.signUp(email, 'correct horse', name);
  const tok = r.session.access_token;
  const call = (fn, args) => a.rpc(fn, args || {}, tok);
  const me = await call('lantern_me');
  return { email, name, tok, call, id: me.id, code: me.friend_code, me };
}
const fails = async (p) => { try { await p; return null; } catch (e) { return e; } };

t.section('Ecosystem events');
t.ok('friend.request is in the shared event schema', validateEvent(makeEvent('friend.request', { requestId: 'r1', from: 'Riley', message: '' })).length === 0);
t.ok('friend.accepted is in the shared event schema', validateEvent(makeEvent('friend.accepted', { name: 'Sam' })).length === 0);
t.ok('a friend.request without its fields is refused', validateEvent(makeEvent('friend.request', {})).length > 0);

/* ================================================================ part 1 */
{
  const hub = await startFakeHub();
  const a = supabaseAdapter({ url: hub.url, anonKey: hub.anonKey });
  try {
    t.section('Codes and finding people');
    const owner = await person(hub, a, 'owner@example.com', 'Riley Owner');
    await owner.call('lantern_claim_owner', { p_code: hub.claimCode() });
    const sam = await person(hub, a, 'sam@example.com', 'Sam Carter');
    const alex = await person(hub, a, 'alex@example.com', 'Alex Kim');
    const eve = await person(hub, a, 'eve@example.com', 'Eve Stone');
    t.ok('everyone gets a friend code like LNT-XXXX', [owner, sam, alex, eve].every((p) => /^LNT-[A-HJ-NP-Z2-9]{4}$/.test(p.code)));
    t.ok('codes are different', new Set([owner, sam, alex, eve].map((p) => p.code)).size === 4);

    let found = await alex.call('lantern_find_people', { p_query: sam.code });
    t.ok('found by exact friend code', found.length === 1 && found[0].id === sam.id && found[0].relation === 'none');
    found = await alex.call('lantern_find_people', { p_query: sam.code.slice(4).toLowerCase() });
    t.ok('found by the code without LNT-, any case', found.length === 1 && found[0].id === sam.id);
    found = await alex.call('lantern_find_people', { p_query: 'SAM@example.com' });
    t.ok('found by exact email', found.length === 1 && found[0].id === sam.id);
    t.ok('a learner does not see other people’s email addresses', found[0].email === null);
    found = await alex.call('lantern_find_people', { p_query: 'Carter' });
    t.ok('not found by name unless they allow it', found.length === 0);
    await sam.call('lantern_set_findable', { p_by_name: true });
    found = await alex.call('lantern_find_people', { p_query: 'Carter' });
    t.ok('found by name once they allow it', found.length === 1 && found[0].id === sam.id);
    found = await owner.call('lantern_find_people', { p_query: 'sto' });
    t.ok('the owner finds anyone by part of a name', found.some((p) => p.id === eve.id) && found[0].email);
    found = await alex.call('lantern_find_people', { p_query: 'x' });
    t.ok('a one-letter search finds nothing', found.length === 0);

    t.section('Request, ignore, accept');
    let r = await owner.call('lantern_send_friend_request', { p_to: sam.code, p_message: 'Hi Sam!' });
    t.eq('the owner sends Sam a request by code', r.status, 'sent');
    r = await owner.call('lantern_send_friend_request', { p_to: sam.code });
    t.ok('sending it again makes no second request', r.status === 'sent' && hub.db.friendRequests.filter((x) => x.from_user === owner.id && x.to_user === sam.id).length === 1);
    let sr = await sam.call('lantern_my_friend_requests');
    t.ok('Sam sees it, from the owner, with the note', sr.received.length === 1 && sr.received[0].from_name === 'Riley Owner' && sr.received[0].message === 'Hi Sam!' && sr.received[0].from_role === 'owner');
    const reqId = sr.received[0].id;
    const alexView = await alex.call('lantern_my_friend_requests');
    t.ok('Alex cannot see a request that is not theirs', alexView.received.length === 0 && alexView.sent.length === 0);
    t.ok('Alex cannot answer it', !!(await fails(alex.call('lantern_respond_friend_request', { p_request: reqId, p_action: 'accept' }))));
    await sam.call('lantern_respond_friend_request', { p_request: reqId, p_action: 'ignore' });
    sr = await sam.call('lantern_my_friend_requests');
    t.ok('ignored: still there for Sam, marked ignored', sr.received.length === 1 && sr.received[0].status === 'ignored');
    const os = await owner.call('lantern_my_friend_requests');
    t.ok('the sender still sees “pending” (not that it was ignored)', os.sent.length === 1 && os.sent[0].status === 'pending');
    r = await sam.call('lantern_respond_friend_request', { p_request: reqId, p_action: 'accept' });
    t.eq('Sam accepts it later', r.status, 'friend');
    const of = await owner.call('lantern_my_friends');
    const sf = await sam.call('lantern_my_friends');
    t.ok('friends on both sides', of.length === 1 && of[0].id === sam.id && sf.length === 1 && sf[0].id === owner.id);
    t.ok('answering twice is refused', /no longer waiting/.test((await fails(sam.call('lantern_respond_friend_request', { p_request: reqId, p_action: 'accept' }))) .message));
    r = await owner.call('lantern_send_friend_request', { p_to: sam.id });
    t.eq('asking a friend again: already friends', r.status, 'friend');

    t.section('Decline, cancel, the other way round');
    await alex.call('lantern_send_friend_request', { p_to: 'eve@example.com' });
    const er = await eve.call('lantern_my_friend_requests');
    await eve.call('lantern_respond_friend_request', { p_request: er.received[0].id, p_action: 'decline' });
    t.ok('declined: the sender sees “declined”', (await alex.call('lantern_my_friend_requests')).sent.some((x) => x.status === 'declined'));
    t.ok('asking again straight after a no is refused', /again after a week/.test((await fails(alex.call('lantern_send_friend_request', { p_to: eve.code }))).message));
    await alex.call('lantern_send_friend_request', { p_to: sam.code });
    const pendingId = (await alex.call('lantern_my_friend_requests')).sent.find((x) => x.to === sam.id).id;
    await alex.call('lantern_cancel_friend_request', { p_request: pendingId });
    t.ok('cancelled: gone from Sam’s requests', !(await sam.call('lantern_my_friend_requests')).received.some((x) => x.id === pendingId));
    await eve.call('lantern_send_friend_request', { p_to: sam.code });
    r = await sam.call('lantern_send_friend_request', { p_to: eve.code });
    t.ok('if they already asked you, asking them back makes you friends', r.status === 'friend' && r.accepted_theirs === true);
    t.ok('asking yourself is refused', /That is you/.test((await fails(sam.call('lantern_send_friend_request', { p_to: sam.code }))).message));
    t.ok('an unknown code is refused kindly', /Nobody was found/.test((await fails(sam.call('lantern_send_friend_request', { p_to: 'LNT-ZZZZ' }))).message));

    t.section('Block');
    await sam.call('lantern_block_user', { p_user: eve.id });
    t.ok('blocking removes the friendship', !(await sam.call('lantern_my_friends')).some((x) => x.id === eve.id));
    t.ok('the blocked person cannot send a request', /cannot send/.test((await fails(eve.call('lantern_send_friend_request', { p_to: sam.code }))).message));
    t.ok('and does not find you', (await eve.call('lantern_find_people', { p_query: sam.code })).length === 0);
    t.ok('you see who you blocked', (await sam.call('lantern_my_friend_requests')).blocked.some((b) => b.id === eve.id));
    await sam.call('lantern_unblock_user', { p_user: eve.id });
    t.ok('unblock: findable again', (await eve.call('lantern_find_people', { p_query: sam.code })).length === 1);

    t.section('Someone without an account yet');
    r = await owner.call('lantern_send_friend_request', { p_to: 'newbie@example.com', p_message: 'Get Lantern!' });
    t.ok('a request to an email with no account waits for them', r.waiting_for_signup === true);
    const newbie = await person(hub, a, 'newbie@example.com', 'New Person');
    const nr = await newbie.call('lantern_my_friend_requests');
    t.ok('it is there when they sign up', nr.received.length === 1 && nr.received[0].from_name === 'Riley Owner' && nr.received[0].message === 'Get Lantern!');

    t.section('A limit on requests');
    const spam = await person(hub, a, 'spam@example.com', 'Busy Sender');
    for (let i = 0; i < 20; i++) await spam.call('lantern_send_friend_request', { p_to: 'p' + i + '@example.com' });
    t.ok('the 21st request in a day is refused', /a lot of friend requests/.test((await fails(spam.call('lantern_send_friend_request', { p_to: 'p99@example.com' }))).message));

    t.section('Courses go to friends, from the owner');
    await owner.call('lantern_owner_save_course', { p_id: 'cfml', p_title: 'ColdFusion (CFML) 501', p_description: '', p_status: 'published', p_visibility: 'private', p_listed: false });
    await owner.call('lantern_owner_publish', { p_course: 'cfml', p_version: '1.0.0', p_pack_path: 'cfml/1.0.0.lpack', p_size: 1, p_sha256: 'x', p_changelog: '', p_manifest: {} });
    const notOwner = await fails(sam.call('lantern_owner_send', { p_users: [alex.id], p_course: 'cfml', p_message: '' }));
    t.ok('a learner cannot send courses', notOwner && notOwner.kind === 'denied');
    t.ok('a learner cannot use the one-person send either', !!(await fails(sam.call('lantern_send_offer', { p_to: alex.id, p_course: 'cfml', p_message: '' }))));
    r = await owner.call('lantern_owner_send', { p_users: [sam.id], p_course: 'cfml', p_message: 'For you' });
    t.eq('the owner sends the course to their friend', r.offers, 1);
    const offers = await sam.call('lantern_my_offers');
    t.ok('Sam sees the invitation', offers.length === 1 && offers[0].course_id === 'cfml');
    await sam.call('lantern_accept_offer', { p_offer: offers[0].id });
    t.ok('accepted: ColdFusion is in Sam’s courses', (await sam.call('lantern_my_courses')).some((c) => c.id === 'cfml'));
    const people = await owner.call('lantern_owner_people');
    t.ok('Owner → People says who is a friend', people.find((p) => p.id === sam.id).relation === 'friend' && people.find((p) => p.id === alex.id).relation === 'none');
  } catch (e) {
    t.ok('part 1 ran to the end', false, e.stack);
  } finally { await hub.close(); }
}

/* ================================================================ part 2 */
{
  t.section('The app: routes, events, the Dayspring API');
  const hub = await startFakeHub();
  const A = await startApp({ name: 'fr-owner', port: 4471 });
  const B = await startApp({ name: 'fr-buddy', port: 4472 });
  try {
    for (const [app, email, name] of [[A, 'owner@example.com', 'Riley Owner'], [B, 'buddy@example.com', 'Sam Buddy']]) {
      await app.api('/api/hub/configure', { method: 'POST', body: { url: hub.url, anonKey: hub.anonKey } });
      await app.api('/api/hub/signup', { method: 'POST', body: { email, password: 'correct horse', name } });
    }
    await A.api('/api/hub/claim-owner', { method: 'POST', body: { code: hub.claimCode() } });
    const bv = await B.api('/api/hub/friends?refresh=1');
    t.ok('GET /api/hub/friends: my code, no friends yet', /^LNT-/.test(bv.me.friend_code) && bv.friends.length === 0 && bv.available);

    // the buddy's app is listening for the new request
    const events = [];
    const ctl = new AbortController();
    (async () => {
      const r = await fetch(B.url + '/api/local/events', { signal: ctl.signal });
      const rd = r.body.getReader(); const dec = new TextDecoder();
      for (;;) { const { value, done } = await rd.read(); if (done) break; events.push(dec.decode(value)); }
    })().catch(() => {});

    const found = await A.api('/api/hub/friends/find', { method: 'POST', body: { query: bv.me.friend_code } });
    t.ok('the owner finds the buddy by code', found.length === 1 && found[0].relation === 'none');
    await A.api('/api/hub/friends/request', { method: 'POST', body: { to: found[0].id, message: 'Hello!' } });
    await until('the buddy’s app sees the request', async () => (await B.api('/api/hub/friends?refresh=1')).received.length === 1);
    await until('a friend-request event reached /api/local/events', async () => events.join('').includes('friend-request'), 15000);
    t.ok('the buddy’s app raised a friend-request event (Dayspring can announce it)', true);
    const st = await B.api('/api/local/status');
    t.ok('/api/local/status lists the waiting request', st.friendRequests.length === 1 && st.friendRequests[0].from === 'Riley Owner');
    const lf = await B.api('/api/local/friends');
    t.ok('/api/local/friends shows it, badge 1', lf.waiting === 1 && lf.received[0].message === 'Hello!');
    const noTok = await B.api('/api/local/friend-requests/' + lf.received[0].id + '/accept', { method: 'POST', body: {}, allowError: true });
    t.ok('answering through the local API needs the token', noTok.status === 401);
    const tok = B.presence().token;
    await B.api('/api/local/friend-requests/' + lf.received[0].id + '/ignore', { method: 'POST', body: {}, headers: { 'x-eco-token': tok } });
    const after = await B.api('/api/hub/friends');
    t.ok('ignored with the token: set aside, badge 0', after.received[0].status === 'ignored' && after.waiting === 0);
    await B.api('/api/hub/friends/requests/' + after.received[0].id + '/accept', { method: 'POST', body: {} });
    await until('the owner’s app sees the new friend', async () => (await A.api('/api/hub/friends?refresh=1')).friends.length === 1);
    t.ok('accepted: friends in both apps', (await B.api('/api/hub/friends')).friends.length === 1);
    const bad = await B.api('/api/hub/friends/requests/x/shout', { method: 'POST', body: {}, allowError: true });
    t.ok('an unknown action is a clear 400', bad.status === 400);
    const notOwner = await B.api('/api/hub/owner/send', { method: 'POST', body: { p_users: [], p_course: 'cfml' }, allowError: true });
    t.ok('the buddy’s app cannot send courses', notOwner.status === 403);
    ctl.abort();
  } catch (e) {
    t.ok('part 2 ran to the end', false, e.stack + '\n' + B.log.slice(-800));
  } finally { await A.stop(); await B.stop(); await hub.close(); }

  t.section('A hub set up before friends existed');
  const old = await startFakeHub({ noFriends: true });
  const C = await startApp({ name: 'fr-old', port: 4473 });
  try {
    await C.api('/api/hub/configure', { method: 'POST', body: { url: old.url, anonKey: old.anonKey } });
    await C.api('/api/hub/signup', { method: 'POST', body: { email: 'x@example.com', password: 'correct horse', name: 'X' } });
    const v = await C.api('/api/hub/friends?refresh=1');
    t.ok('the app says friends are not switched on, and nothing else breaks', v.available === false && v.signedIn === true);
    t.ok('courses and offers still work', Array.isArray((await C.api('/api/courses')).courses));
  } catch (e) {
    t.ok('the old-hub check ran', false, e.stack);
  } finally { await C.stop(); await old.close(); }
}

t.done();
