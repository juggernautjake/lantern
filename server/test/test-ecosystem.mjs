#!/usr/bin/env node
/* ===========================================================================
   server/test/test-ecosystem.mjs — Lantern with its hub and its neighbours.
   ---------------------------------------------------------------------------
       node server/test/test-ecosystem.mjs

   Real copies of the app (child processes, their own data and ports) against
   the fake hub, plus a mock "Dayspring":

     two computers, one person, both offline → everything merges
     draft vs published · groups · requests · revoking a course
     an offer to an EMAIL → that person joins with an email code → accepts
     a sign-in handed over by another app · the launcher (one copy, --open, stop)
     the ecosystem endpoints: token, Host and Origin, the event schema
     a mock Dayspring: discovery both ways, events both ways, quiet hours
     the quiet installer, in a temp copy of the public export
   =========================================================================== */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeHub } from './fake-hub.mjs';
import { startApp, suite, until, sleep, tempDir, loadPlaywright, ROOT } from './helpers.mjs';
import { build } from '../../scripts/build-pack.mjs';
import { supabaseAdapter } from '../src/platform/sync/supabase.js';

const t = suite('Lantern ecosystem');
const hub = await startFakeHub();
const apps = [];
const app = async (name, port, o) => { const a = await startApp(Object.assign({ name, port }, o || {})); apps.push(a); return a; };
const tok = (a) => ({ 'x-eco-token': a.presence().token });
function run(cmd, args, env, cwd, verbatim) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: Object.assign({}, process.env, env), cwd: cwd || ROOT, windowsHide: true, windowsVerbatimArguments: !!verbatim });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (status) => resolve({ status, out }));
  });
}
const connect = (a) => a.api('/api/hub/configure', { method: 'POST', body: { url: hub.url, anonKey: hub.anonKey } });

try {
  /* ---------------------------------------------------------------- setup */
  const packDir = tempDir('packs');
  const tpl = await build('_template', { out: packDir, quiet: true });
  const owner = await app('owner', 4481);
  await connect(owner);
  await owner.api('/api/hub/signup', { method: 'POST', body: { email: 'owner@example.com', password: 'pw123456', name: 'Riley Owner' } });
  await owner.api('/api/hub/claim-owner', { method: 'POST', body: { code: hub.claimCode() } });
  const pub = (status, extra) => owner.api('/api/local/publish', { method: 'POST', headers: tok(owner), body: Object.assign({ file: tpl.file, status }, extra || {}) });
  const O = (fn, args) => owner.api('/api/hub/owner/' + fn, { method: 'POST', body: args || {} });

  /* ------------------------------------------ a role changed on the hub */
  t.section('A role changed on the hub is noticed');
  const promoted = await app('promoted', 4489, { env: { LANTERN_PROFILE_REFRESH_MS: '1' } });
  await connect(promoted);
  await promoted.api('/api/hub/signup', { method: 'POST', body: { email: 'promoted@example.com', password: 'pw123456', name: 'Pat Promoted' } });
  const pst = async () => (await promoted.api('/api/platform')).hub;
  t.ok('a new account starts as a learner', (await pst()).owner === false);
  const pr = hub.db.profiles.find((p) => p.email === 'promoted@example.com');
  pr.role = 'owner';                                                   // e.g. granted from the hub dashboard
  await new Promise((r) => setTimeout(r, 20));
  await promoted.api('/api/hub/sync', { method: 'POST', body: {} });
  t.ok('after the next catalog refresh the app knows it is the owner, no sign-out needed', (await pst()).owner === true);
  pr.role = 'student';

  /* --------------------------------------------------- draft / published */
  t.section('Draft and published');
  await pub('draft');
  const d1 = await app('dev1', 4482);
  await connect(d1);
  await d1.api('/api/hub/signup', { method: 'POST', body: { email: 'sam@example.com', password: 'pw123456', name: 'Sam' } });
  const samId = (await d1.api('/api/hub')).profile.id;
  await O('grant', { p_user: samId, p_course: 'template', p_on: true });
  await d1.api('/api/hub/sync', { method: 'POST' });
  t.ok('a draft is invisible to learners, even ones who were given it', !(await d1.api('/api/hub')).courses.some((c) => c.id === 'template'));
  t.ok('…but the owner sees it', (await O('courses')).some((c) => c.id === 'template' && c.status === 'draft'));
  await O('save_course', { p_id: 'template', p_title: 'Template Course', p_status: 'published' });
  await until('once published it downloads for the learner', async () => (await d1.api('/api/courses')).courses.some((c) => c.id === 'template' && c.installed));
  t.ok('once published, it appears and downloads', true);

  /* ------------------------------------------ two computers, offline, merge */
  t.section('Two computers, offline edits, merge');
  const d2 = await app('dev2', 4483);
  await connect(d2);
  await d2.api('/api/hub/signin', { method: 'POST', body: { email: 'sam@example.com', password: 'pw123456' } });
  await until('the second computer gets the course too', async () => (await d2.api('/api/courses')).courses.some((c) => c.id === 'template' && c.installed));
  await fetch(hub.url + '/__test/down?on=1');
  const st = (o) => JSON.stringify(Object.assign({ v: 1, lessons: {}, exercises: {}, projects: {}, seconds: 0 }, o));
  const now = Date.now();
  await d1.api('/api/courses/template/state', { method: 'PUT', body: { keys: { 'course-template': st({ lessons: { 't-u1l1': { done: true, at: now } }, exercises: { 't-u1l2e1': { attempts: 3, passed: false, best: 40 } }, seconds: 300, lastPage: 't-u1l2' }) }, savedAt: now } });
  await d2.api('/api/courses/template/state', { method: 'PUT', body: { keys: { 'course-template': st({ lessons: { 't-u2l1': { done: true, at: now + 5 } }, exercises: { 't-u1l2e1': { attempts: 1, passed: true, best: 100, firstPassAt: now + 5 } }, projects: { 't-proj-m1': { attempts: 1, passed: true, at: now + 6 } }, seconds: 120, lastPage: 't-proj' }) }, savedAt: now + 10 } });
  await fetch(hub.url + '/__test/down?on=0');
  const both = async (a) => { const ov = await a.api('/api/courses/template/overview'); const L = ov.units.flatMap((u) => u.lessons); const ex = L.find((l) => l.id === 't-u1l2').exercises[0]; return L.find((l) => l.id === 't-u1l1').status === 'done' && L.find((l) => l.id === 't-u2l1').status === 'done' && ex.status === 'done' && ov.units[1].projects[0].milestones[0].status === 'done'; };
  await until('computer 1 has both computers’ work', () => both(d1), 30000);
  await until('computer 2 has both computers’ work', () => both(d2), 30000);
  t.ok('both computers end up with the union of the offline work', true);
  const item = hub.db.items.find((i) => i.ref === 't-u1l2e1');
  t.ok('the exercise: passed, best 100, attempts 3 (nothing lost either way)', item.completed && item.best === 100 && item.attempts === 3);
  t.ok('time from both computers adds up, each counted once', hub.db.time.filter((x) => x.course_id === 'template').reduce((s, x) => s + x.seconds, 0) === 420);
  await d1.api('/api/hub/sync', { method: 'POST' }); await d2.api('/api/hub/sync', { method: 'POST' });
  t.ok('syncing again changes nothing (idempotent)', hub.db.time.filter((x) => x.course_id === 'template').length === 2);

  /* --------------------------------------------------------------- groups */
  t.section('Groups, requests, revoking');
  const d3 = await app('dev3', 4484);
  await connect(d3);
  await d3.api('/api/hub/signup', { method: 'POST', body: { email: 'alex@example.com', password: 'pw123456', name: 'Alex' } });
  const alexId = (await d3.api('/api/hub')).profile.id;
  const g = await O('group_save', { p_id: null, p_name: 'Template cohort' });
  const r1 = await O('group_courses', { p_group: g.id, p_add: ['template'], p_remove: [], p_message: 'Welcome to the cohort' });
  t.ok('a course added to an empty group offers nothing yet', r1.offers === 0);
  const r2 = await O('group_members', { p_group: g.id, p_add: [alexId, samId], p_remove: [] });
  t.ok('people added later are offered the group’s courses (not those who have it)', r2.offers === 1 && hub.db.offers.some((o) => o.to_user === alexId && o.via === 'group'));
  // requests: a second, listed course
  await O('save_course', { p_id: 'extra', p_title: 'Extra Course', p_description: 'More', p_status: 'published', p_visibility: 'private', p_listed: true });
  const listed = (await d3.api('/api/hub/listed')).courses;
  t.ok('a listed course shows its title to people who do not have it', listed.some((c) => c.id === 'extra'));
  await d3.api('/api/hub/request', { method: 'POST', body: { course: 'extra', message: 'Please?' } });
  const req = (await O('requests')).find((x) => x.course_id === 'extra');
  t.ok('the owner sees the request with its message', req && req.message === 'Please?' && req.display_name === 'Alex');
  await O('answer_request', { p_request: req.id, p_approve: true });
  t.ok('approving it grants the course in one click', hub.db.grants.some((x) => x.user_id === alexId && x.course_id === 'extra'));
  // revoking
  await O('grant', { p_user: samId, p_course: 'template', p_on: false });
  await d1.api('/api/hub/sync', { method: 'POST' });
  t.ok('a revoked course is hidden on the learner’s computer', !(await d1.api('/api/courses')).courses.some((c) => c.id === 'template' && c.installed));
  await O('grant', { p_user: samId, p_course: 'template', p_on: true });
  await until('given back, it returns with the progress intact', async () => { const c = (await d1.api('/api/courses')).courses.find((x) => x.id === 'template'); return c && c.installed && c.percent > 0; }, 20000);
  t.ok('given back, it returns with the progress intact', true);

  /* ------------------------------------------------ an offer to an email */
  t.section('An offer to someone who has no account yet');
  const sent = await owner.api('/api/local/send', { method: 'POST', headers: tok(owner), body: { to: 'newperson@example.com', course: 'template', message: 'Try this!' } });
  t.ok('the owner can send to an email address (Dayspring uses this)', sent.offers === 1);
  const ppl = await owner.api('/api/local/people', { headers: tok(owner) });
  t.ok('People lists the invitee as "invited by email"', ppl.people.some((p) => p.pending_invite && p.email === 'newperson@example.com'));
  const d4 = await app('dev4', 4485);
  await connect(d4);
  t.ok('without a code-capable email, the hub offers a link (not a code)', (await d4.api('/api/hub')).emailCode === false);
  await d4.api('/api/hub/link/send', { method: 'POST', body: { email: 'newperson@example.com' } });
  const link = hub.link('newperson@example.com');
  t.ok('the emailed link comes back to this app’s /auth/callback page', !!link && link.startsWith(d4.url + '/auth/callback#access_token='));
  const cb = await fetch(link.split('#')[0]);
  t.ok('the callback page is served (and reads the #fragment itself)', cb.status === 200 && /link\/complete/.test(await cb.text()));
  const frag = new URLSearchParams(link.split('#')[1]);
  t.ok('a made-up token is refused', (await d4.api('/api/hub/link/complete', { method: 'POST', body: { refresh_token: 'nope' }, allowError: true })).status >= 400);
  await d4.api('/api/hub/link/complete', { method: 'POST', body: { access_token: frag.get('access_token'), refresh_token: frag.get('refresh_token') } });
  t.ok('they join with an emailed link (no password)', (await d4.api('/api/hub')).signedIn);
  await d4.api('/api/hub/sync', { method: 'POST' });
  const offers = (await d4.api('/api/local/offers')).offers;
  t.ok('the waiting offer is now theirs, with the owner’s name and message', offers.length === 1 && offers[0].from_name === 'Riley Owner' && offers[0].message === 'Try this!');
  t.ok('accepting through the local API needs the token', (await d4.api('/api/local/offers/' + offers[0].id + '/accept', { method: 'POST', allowError: true })).status === 401);
  await d4.api('/api/local/offers/' + offers[0].id + '/accept', { method: 'POST', headers: tok(d4), body: { open: false } });
  await until('the accepted course downloads', async () => (await d4.api('/api/courses')).courses.some((c) => c.id === 'template' && c.installed));
  t.ok('accepted → the course is on their hub, ready offline', true);

  /* -------------------------------------------------- handoff + launcher */
  t.section('Sign-in handoff and the launcher');
  const base5 = tempDir('dev5');
  const data5 = join(base5, 'data');
  mkdirSync(data5, { recursive: true });
  const ad = supabaseAdapter({ url: hub.url, anonKey: hub.anonKey });
  const s5 = await ad.signIn('alex@example.com', 'pw123456');
  writeFileSync(join(data5, 'handoff.json'), JSON.stringify({ v: 1, refresh_token: s5.refresh_token, hub: { url: hub.url, anonKey: hub.anonKey }, created_at: Date.now(), from: 'dayspring' }));
  const d5 = await app('dev5', 4486, { base: base5 });
  await until('the handed-over sign-in is used', async () => (await d5.api('/api/hub')).signedIn);
  t.ok('Lantern starts signed in, from the handoff (and connected to the hub it named)', (await d5.api('/api/hub')).profile.email === 'alex@example.com');
  t.ok('the handoff file is gone (one use)', !existsSync(join(data5, 'handoff.json')));
  const old = await fetch(hub.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: hub.anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: s5.refresh_token }) });
  t.ok('the token in the file no longer works (rotated at once)', old.status === 400);
  // Alex has the group's offer waiting: accept it here
  await d5.api('/api/hub/sync', { method: 'POST' });
  const alexOffer = (await d5.api('/api/local/offers')).offers.find((o) => o.course_id === 'template');
  t.ok('the group’s offer was waiting for Alex', !!alexOffer);
  await d5.api('/api/local/offers/' + alexOffer.id + '/accept', { method: 'POST', headers: tok(d5), body: { open: false } });
  await until('dev5 has the course', async () => (await d5.api('/api/courses')).courses.some((c) => c.id === 'template' && c.installed));
  const pw = await loadPlaywright();
  if (pw) {
    const browser = await pw.chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
    const page = await browser.newPage();
    await page.goto(d5.url + '/#/');
    await sleep(1200);
    const envL = { ECOSYSTEM_DIR: d5.eco, LANTERN_DATA: d5.data, PORT: String(d5.port) };
    const l = await run(process.execPath, [join(ROOT, 'scripts', 'launch.mjs'), 'lantern://open?course=template&lesson=t-u1l2'], envL);
    t.ok('a lantern:// link reaches the copy that is running (no second copy)', l.status === 0 && /already running/.test(l.out), l.out);
    await page.waitForFunction(() => /#\/learn\/template\?open=t-u1l2/.test(location.hash), null, { timeout: 10000 });
    t.ok('…and opens the course at that lesson', true);
    await run(process.execPath, [join(ROOT, 'scripts', 'launch.mjs'), '--open', 'template'], envL);
    await page.waitForFunction(() => location.hash === '#/course/template', null, { timeout: 10000 });
    await page.waitForSelector('[data-testid=overview-title]');
    t.ok('--open <course> shows the course overview', (await page.innerText('[data-testid=overview-title]')) === 'Template Course');
    await browser.close();
  } else t.ok('(no browser available: launcher page checks skipped)', true);
  // start hidden, one copy only, stop
  const base6 = tempDir('dev6');
  const env6 = { ECOSYSTEM_DIR: join(base6, 'eco'), LANTERN_DATA: join(base6, 'data'), PORT: '4487', LANTERN_BUNDLED_PACKS: join(base6, 'none'), LANTERN_UPDATE_REPO: '' };
  const up = await run(process.execPath, [join(ROOT, 'scripts', 'launch.mjs'), '--hidden'], env6);
  t.ok('the launcher starts Lantern in the background', up.status === 0 && /running/.test(up.out), up.out);
  const again = await run(process.execPath, [join(ROOT, 'scripts', 'launch.mjs'), '--hidden'], env6);
  t.ok('starting it again does not start a second copy', /already running/.test(again.out));
  const stop = await run(process.execPath, [join(ROOT, 'scripts', 'launch.mjs'), '--stop'], env6);
  await sleep(800);
  const status = await run(process.execPath, [join(ROOT, 'scripts', 'launch.mjs'), '--status'], env6);
  t.ok('Stop stops it', /stopping/.test(stop.out) && status.status === 1);

  /* ------------------------------------------------- restart keeps it all */
  t.section('Progress survives a restart');
  const before = await d1.api('/api/courses/template/overview');
  await d1.stop();
  const d1b = await app('dev1-again', d1.port, { base: d1.base });
  const after = await d1b.api('/api/courses/template/overview');
  t.ok('after a restart the same work is there', before.percent > 0 && after.percent === before.percent && after.finished === before.finished);
  t.ok('…and it is still signed in (the session was kept, offline-ready)', (await d1b.api('/api/hub')).signedIn);

  /* --------------------------------------------------- ecosystem security */
  t.section('Ecosystem endpoints');
  const post = (a, path, body, headers) => fetch(a.url + path, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
  const ev = (type, data, source) => ({ v: 1, id: 'e' + Math.random(), type, source: source || 'dayspring', at: Date.now(), data });
  t.ok('an event without the token is refused (401)', (await post(d1, '/api/eco/event', ev('dnd', { on: true }))).status === 401);
  t.ok('a request from another website is refused (403)', (await post(d1, '/api/eco/event', ev('dnd', { on: true }), Object.assign({ origin: 'https://evil.example' }, tok(d1)))).status === 403);
  const rebind = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const rq = request({ host: '127.0.0.1', port: d1.port, path: '/api/local/status', headers: { host: 'evil.example:' + d1.port } }, (res) => resolve(res.statusCode));
      rq.on('error', () => resolve(0)); rq.end();
    });
  });
  t.ok('a request naming another host (DNS rebinding) is refused (421)', rebind === 421);
  const bad = await post(d1, '/api/eco/event', { v: 1, id: 'x', type: 'dnd', source: 'dayspring', at: Date.now(), data: {} }, tok(d1));
  t.ok('an event that breaks the schema is refused, saying why (400)', bad.status === 400 && /data\.on/.test(JSON.stringify(await bad.json())));
  t.ok('an event that fits the schema is taken', (await post(d1, '/api/eco/event', ev('dnd', { on: true }), tok(d1))).status === 200);
  t.ok('Dayspring’s quiet hours reach Lantern', (await d1.api('/api/eco/state')).quiet.quiet === true);
  await post(d1, '/api/eco/event', ev('dnd', { on: false }), tok(d1));
  t.ok('read-only status needs no token', (await d1.api('/api/local/status')).app === 'lantern');
  t.ok('opening a page needs the token', (await d1.api('/api/local/open', { method: 'POST', body: { course: 'template' }, allowError: true })).status === 401);

  /* ------------------------------------------------------- mock Dayspring */
  t.section('A mock Dayspring');
  const got = [];
  const dsToken = 'd'.repeat(48);
  const ds = createServer((q, s) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      if (q.url === '/api/eco/hello') { s.writeHead(200, { 'content-type': 'application/json' }); return s.end(JSON.stringify({ app: 'dayspring', version: '9.0.0' })); }
      if (q.url === '/api/eco/event' && q.headers['x-eco-token'] === dsToken) { got.push(JSON.parse(b)); s.writeHead(200); return s.end('{}'); }
      s.writeHead(401); s.end('{}');
    });
  });
  await new Promise((r) => ds.listen(0, '127.0.0.1', r));
  mkdirSync(join(d4.eco, 'apps'), { recursive: true });
  writeFileSync(join(d4.eco, 'apps', 'dayspring.json'), JSON.stringify({ app: 'dayspring', version: '9.0.0', port: ds.address().port, pid: process.pid, startedAt: Date.now(), token: dsToken, api: '/api/eco', schema: 1 }));
  await until('Lantern sees Dayspring running', async () => (await d4.api('/api/eco/state')).peers.some((p) => p.app === 'dayspring' && p.running));
  t.ok('Lantern discovers Dayspring from its presence file', true);
  const sb = await d4.api('/api/local/study-block', { method: 'POST', body: { course: 'template', time: '19:00', minutes: 30, days: [1, 3, 5] } });
  t.ok('"Add study time" reaches Dayspring as schedule.block.request, with Dayspring’s token', sb.sent && got.some((e) => e.type === 'schedule.block.request' && e.data.time === '19:00' && e.source === 'lantern'));
  await owner.api('/api/local/send', { method: 'POST', headers: tok(owner), body: { to: 'newperson@example.com', course: 'extra', message: 'One more' } });
  await until('a new offer is announced to Dayspring as course.offered', async () => got.some((e) => e.type === 'course.offered' && e.data.courseTitle === 'Extra Course' && e.data.from === 'Riley Owner'), 15000);
  t.ok('a course offer is announced to Dayspring (who sent it, what, the message)', true);
  const pres = d4.presence();
  const r3 = await post(d4, '/api/eco/event', ev('schedule.block.started', { title: 'Study Template Course', course: 'template' }), { 'x-eco-token': pres.token });
  t.ok('Dayspring’s "study block started" is accepted by Lantern', r3.status === 200);
  const statusNow = await d4.api('/api/local/status');
  t.ok('Dayspring can read progress, the next lesson and waiting offers in one call', statusNow.courses.some((c) => c.id === 'template' && c.next) && statusNow.offers.some((o) => o.course === 'Extra Course'));
  ds.close();

  /* ------------------------------------------------------ quiet installer */
  t.section('The quiet installer');
  if (process.platform === 'win32') {
    const { exportTo } = await import('../../scripts/export.mjs');
    const pubDir = join(tempDir('install'), 'Lantern');
    exportTo(pubDir, { quiet: true });
    const dataI = join(tempDir('install-data'), 'Lantern');
    const cmdline = (flags) => ['/d', '/s', '/c', '""' + join(pubDir, 'Install Lantern.cmd') + '" ' + flags + '"'];
    const inst = await run('cmd.exe', cmdline('--quiet --no-shortcuts --no-protocol --no-start'), { LANTERN_DATA: dataI }, pubDir, true);
    const stat = existsSync(join(dataI, 'install-status.json')) ? JSON.parse(readFileSync(join(dataI, 'install-status.json'), 'utf8').replace(/^\uFEFF/, '')) : null;
    t.ok('--quiet installs with no questions (exit 0)', inst.status === 0, inst.out);
    t.ok('…and writes its progress for another app to show', stat && stat.step === 'done' && stat.ok === true && stat.exitCode === 0, JSON.stringify(stat));
    const noNode = await run('cmd.exe', cmdline('--quiet --no-shortcuts --no-protocol --no-start'),
      { LANTERN_DATA: dataI, PATH: join(process.env.WINDIR || 'C:/Windows', 'System32') + ';' + join(process.env.WINDIR || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0') }, pubDir, true);
    const stat2 = JSON.parse(readFileSync(join(dataI, 'install-status.json'), 'utf8').replace(/^\uFEFF/, ''));
    t.ok('without Node.js, --quiet stops and says so (exit 10, or 11 with no winget) instead of installing anything', (noNode.status === 10 || noNode.status === 11) && stat2.step === 'node', noNode.status + ' ' + JSON.stringify(stat2));
  } else t.ok('(the installer is Windows-only: skipped)', true);
} catch (e) {
  t.ok('the ecosystem tests ran to the end', false, e.stack);
} finally {
  for (const a of apps) await a.stop();
  await hub.close();
  t.done();
}
