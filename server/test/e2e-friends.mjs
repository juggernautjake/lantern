#!/usr/bin/env node
/* ===========================================================================
   server/test/e2e-friends.mjs — friends first, then the course, headless.
   ---------------------------------------------------------------------------
       node server/test/e2e-friends.mjs

   Two copies of Lantern and a fake hub, driven through the real pages:
     1  both sign up; the owner claims the hub and publishes ColdFusion
     2  the owner sees the buddy under Friends → People on your hub, and also
        finds them by their friend code
     3  the owner sends a friend request; the buddy gets a toast and a badge
     4  the buddy IGNORES it (set aside; the owner still sees "Waiting"), then
        accepts it from "Set aside"
     5  the owner sees the new friend and sends them ColdFusion
     6  the buddy accepts the invitation; the course downloads and its
        overview opens
   No page errors in either app.

   Needs dist/packs/cfml.lpack (node scripts/build-pack.mjs cfml) and Chrome.
   =========================================================================== */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeHub } from './fake-hub.mjs';
import { startApp, suite, until, loadPlaywright, ROOT } from './helpers.mjs';

const t = suite('Lantern end to end: friends first, then the course');
const PACK = join(ROOT, 'dist', 'packs', 'cfml.lpack');
if (!existsSync(PACK)) { console.error('Build the pack first: node scripts/build-pack.mjs cfml'); process.exit(2); }
const pw = await loadPlaywright();
if (!pw) { console.error('playwright-core is not available.'); process.exit(2); }

const hub = await startFakeHub();
const owner = await startApp({ name: 'fr-e2e-owner', port: 4481 });
const buddy = await startApp({ name: 'fr-e2e-buddy', port: 4482 });
const browser = await pw.chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
const errors = [];
const page = async (app, who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(who + ': ' + e.message));
  await p.goto(app.url + '/#/settings/account');
  return p;
};
function run(cmd, args, env) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: Object.assign({}, process.env, env), windowsHide: true });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}
const shot = (p, name) => p.screenshot({ path: join(owner.base, name + '.png'), fullPage: true }).catch(() => {});

try {
  /* 1 ------------------------------------------------------------ setup */
  t.section('Accounts and the course');
  const O = await page(owner, 'owner');
  const B = await page(buddy, 'buddy');
  for (const [P, name, email] of [[O, 'Riley Owner', 'owner@example.com'], [B, 'Sam Buddy', 'sam@example.com']]) {
    await P.fill('[data-testid=hub-url]', hub.url);
    await P.fill('[data-testid=hub-key]', hub.anonKey);
    await P.click('[data-testid=hub-connect]');
    await P.waitForSelector('[data-testid=su-name]');
    await P.fill('[data-testid=su-name]', name);
    await P.fill('[data-testid=su-email]', email);
    await P.fill('[data-testid=su-password]', 'correct horse');
    await P.click('[data-testid=su-go]');
    await P.waitForFunction(() => location.hash === '#/');
  }
  await O.goto(owner.url + '/#/settings/account');
  await O.fill('[data-testid=claim-code]', hub.claimCode());
  await O.click('[data-testid=claim-go]');
  await O.waitForSelector('#nav-owner:not([hidden])');
  const pub = await run(process.execPath, [join(ROOT, 'scripts', 'publish-course.mjs'), 'cfml', '--no-build', '--publish'], { ECOSYSTEM_DIR: owner.eco });
  t.ok('both signed up; the owner claimed the hub and published ColdFusion', pub.status === 0, pub.stdout + pub.stderr);

  /* 2 ----------------------------------------------------- finding them */
  t.section('Finding the buddy');
  await B.goto(buddy.url + '/#/friends');
  await B.waitForSelector('[data-testid=friends-code]');
  const code = (await B.innerText('[data-testid=friends-code]')).trim();
  t.ok('the buddy’s Friends page shows their friend code', /^LNT-[A-Z2-9]{4}$/.test(code), code);
  await B.waitForSelector('[data-testid=friends-empty]');
  t.ok('an empty friends list explains what to do', true);
  await O.goto(owner.url + '/#/friends');
  await until('the owner sees the buddy under People on your hub', async () => { await O.reload(); return (await O.locator('[data-testid=hub-person][data-email="sam@example.com"]').count()) === 1; }, 45000);   // the People list refreshes on a timer; a busy machine is slow
  t.ok('Friends → People on your hub lists the buddy (they have Lantern)', /Lantern 0\.\d+\.\d+/.test(await O.locator('[data-testid=hub-person][data-email="sam@example.com"]').innerText()));
  await O.fill('[data-testid=find-input]', code);
  await O.click('[data-testid=find-go]');
  await O.waitForSelector('[data-testid=find-result]');
  t.ok('and finds them by their friend code', /Sam Buddy/.test(await O.innerText('[data-testid=find-result]')));

  /* 3 -------------------------------------------------------- the request */
  t.section('The friend request');
  await B.goto(buddy.url + '/#/');
  await O.locator('[data-testid=find-result] [data-testid=add-friend]').click();
  await until('the request is on the hub', async () => hub.db.friendRequests.some((r) => r.status === 'pending'));
  await until('the buddy gets a toast', async () => (await B.locator('[data-testid=friend-toast]').count()) > 0, 20000);
  t.ok('the toast names the owner', /Riley Owner wants to be friends/.test(await B.locator('[data-testid=friend-toast]').first().innerText()));
  await until('the badge shows 1', async () => (await B.innerText('[data-testid=friends-badge]')).trim() === '1');
  t.ok('the Friends link has a badge: 1', true);
  await shot(B, 'buddy-toast');

  /* 4 ------------------------------------------------ ignore, then accept */
  t.section('Ignore, then accept');
  await B.locator('[data-testid=friend-toast] .x').first().click();
  await B.goto(buddy.url + '/#/friends');
  await B.waitForSelector('[data-testid=fr-received][data-status=pending]');
  await B.click('[data-testid=fr-received][data-status=pending] [data-testid=fr-ignore]');
  await until('the request is set aside', async () => (await B.locator('[data-testid=fr-ignored]').count()) === 1);
  t.ok('ignored: it moves under “Set aside”', true);
  await until('the badge clears', async () => await B.locator('[data-testid=friends-badge]').isHidden());
  t.ok('the badge clears', true);
  await O.goto(owner.url + '/#/friends');
  await O.waitForSelector('[data-testid=fr-sent-row]');
  t.ok('the owner still sees it as Waiting', (await O.getAttribute('[data-testid=fr-sent-row]', 'data-status')) === 'pending' && /Waiting/.test(await O.innerText('[data-testid=fr-sent-row]')));
  await B.click('[data-testid=fr-ignored] summary');
  await B.click('[data-testid=fr-ignored] [data-testid=fr-accept]');
  await until('they are friends on the hub', async () => hub.db.friendships.length === 1);
  await B.waitForSelector('[data-testid=friend-row][data-name="Riley Owner"]');
  t.ok('the buddy’s friends list shows the owner', true);
  t.ok('the buddy (not the owner) has no Send a course button', (await B.locator('[data-testid=friend-send-course]').count()) === 0);
  await shot(B, 'buddy-friends');

  /* 5 ----------------------------------------------------- send a course */
  t.section('Send the course to the friend');
  await until('the owner sees the new friend', async () => { await O.reload(); return (await O.locator('[data-testid=friend-row][data-name="Sam Buddy"]').count()) === 1; }, 20000);
  t.ok('the owner’s friends list shows the buddy', true);
  await O.click('[data-testid=friend-row][data-name="Sam Buddy"] [data-testid=friend-send-course]');
  await O.selectOption('[data-testid=friend-course-select]', 'cfml');
  await O.fill('[data-testid=friend-course-message]', 'Here is ColdFusion — enjoy!');
  await O.click('[data-testid=friend-send-go]');
  await until('the offer exists', async () => hub.db.offers.some((o) => o.status === 'pending'));
  t.ok('an offer (not a grant) went to the friend', hub.db.grants.length === 0 && hub.db.offers.length === 1);
  await shot(O, 'owner-friends');

  /* 6 --------------------------------------------------------- accept it */
  t.section('The buddy accepts and studies');
  await B.goto(buddy.url + '/#/');
  await until('the buddy sees the invitation', async () => (await B.locator('[data-testid=invite]').count()) > 0, 20000);
  t.ok('the invitation names the owner, the course and the note', /Riley Owner sent you ColdFusion \(CFML\) 501/.test(await B.locator('[data-testid=invite]').first().innerText()) && /enjoy!/.test(await B.locator('[data-testid=invite]').first().innerText()));
  await B.locator('[data-testid=invite] [data-testid=accept]').first().click();
  await until('the course is downloaded', async () => (await B.locator('[data-testid=open-cfml]').count()) > 0, 30000);
  await B.click('[data-testid=open-cfml]');
  await B.waitForSelector('[data-testid=overview-title]');
  t.ok('the course overview opens: ColdFusion, 9 units', (await B.innerText('[data-testid=overview-title]')) === 'ColdFusion (CFML) 501' && (await B.locator('details.unit').count()) === 9);
  await shot(B, 'buddy-overview');
  t.ok('no page errors in either app', errors.length === 0, errors.join('\n'));
} catch (e) {
  t.ok('the flow ran to the end', false, e.stack);
} finally {
  await browser.close().catch(() => {});
  await owner.stop(); await buddy.stop(); await hub.close();
  t.done();
}
