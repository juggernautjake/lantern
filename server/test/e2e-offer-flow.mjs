#!/usr/bin/env node
/* ===========================================================================
   server/test/e2e-offer-flow.mjs — the first end-to-end flow, headless.
   ---------------------------------------------------------------------------
       node server/test/e2e-offer-flow.mjs

   Two copies of Lantern (the owner's and a learner's, each with its own data,
   port and browser) and a fake hub (fake-hub.mjs, the same HTTP as Supabase):

     1  both sign up in the app; the owner claims the hub
     2  the owner publishes ColdFusion (scripts/publish-course.mjs, through
        the owner's running app)
     3  the owner sees the learner in People and sends them the course with a
        message
     4  the learner sees the invitation ("<owner> sent you …" + the message),
        accepts, the course downloads for offline use
     5  the course overview lists every unit, lesson, exercise, project and
        check with a status, the %, and the time left
     6  the hub goes DOWN; the learner opens a lesson, passes an exercise and
        marks the lesson complete — all saved locally
     7  the hub comes back; the progress syncs; the owner's People list shows
        the learner online, in the lesson, with progress

   Needs dist/packs/cfml.lpack (node scripts/build-pack.mjs cfml) and Chrome
   (playwright-core is borrowed from a sibling project if not installed here).
   =========================================================================== */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeHub } from './fake-hub.mjs';
import { startApp, suite, until, sleep, loadPlaywright, ROOT } from './helpers.mjs';

const t = suite('Lantern end to end: send a course, accept it, study offline, sync');
const PACK = join(ROOT, 'dist', 'packs', 'cfml.lpack');
if (!existsSync(PACK)) { console.error('Build the pack first: node scripts/build-pack.mjs cfml'); process.exit(2); }
const pw = await loadPlaywright();
if (!pw) { console.error('playwright-core is not available.'); process.exit(2); }

const hub = await startFakeHub();
const owner = await startApp({ name: 'owner', port: 4461 });
const learner = await startApp({ name: 'learner', port: 4462 });
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
const shot = (p, name) => p.screenshot({ path: join(owner.base, name + '.png') }).catch(() => {});

try {
  /* 1 --------------------------------------------------------- accounts */
  t.section('Accounts');
  const O = await page(owner, 'owner');
  const L = await page(learner, 'learner');
  for (const [P, name, email] of [[O, 'Riley Owner', 'owner@example.com'], [L, 'Sam Learner', 'sam@example.com']]) {
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
  t.ok('both people signed up in the app', (await owner.api('/api/hub')).signedIn && (await learner.api('/api/hub')).signedIn);
  await O.goto(owner.url + '/#/settings/account');
  await O.fill('[data-testid=claim-code]', hub.claimCode());
  await O.click('[data-testid=claim-go]');
  await O.waitForSelector('#nav-owner:not([hidden])');
  t.ok('the owner claimed the hub and sees the Owner page', (await owner.api('/api/hub')).owner);

  /* 2 ---------------------------------------------------------- publish */
  t.section('Publish');
  // (async: the fake hub lives in this process and must keep answering)
  const pub = await run(process.execPath, [join(ROOT, 'scripts', 'publish-course.mjs'), 'cfml', '--no-build', '--publish'], { ECOSYSTEM_DIR: owner.eco });
  t.ok('publish-course put ColdFusion on the hub through the owner’s app', pub.status === 0 && /Published cfml 1\.0\.0 \(published\) through the Lantern app/.test(pub.stdout), pub.stdout + pub.stderr);
  await until('the owner’s own app downloads it (the owner has every course)', async () => (await owner.api('/api/courses')).courses.some((c) => c.id === 'cfml' && c.installed));
  t.ok('the owner has the course without any offer', true);

  /* 3 --------------------------------------------------------- send it */
  t.section('Send');
  await O.goto(owner.url + '/#/owner/people');
  await until('the learner appears in People', async () => { await O.reload(); return O.locator('[data-testid=person-row][data-email="sam@example.com"]').count(); });
  const row = O.locator('[data-testid=person-row][data-email="sam@example.com"]');
  t.ok('People shows the learner with Lantern’s version', /0\.1\.0/.test(await row.innerText()));
  await row.locator('input[type=checkbox]').check();
  await O.click('[data-testid=send-course]');
  await O.selectOption('[data-testid=send-course-select]', 'cfml');
  await O.fill('[data-testid=send-message]', 'Here is the ColdFusion course — have fun!');
  await O.click('[data-testid=send-go]');
  await until('the offer exists', async () => hub.db.offers.some((o) => o.status === 'pending'));
  t.ok('an OFFER was made, not a grant', hub.db.grants.length === 0 && hub.db.offers.length === 1);

  /* 4 ------------------------------------------------ accept + download */
  t.section('Accept');
  await L.goto(learner.url + '/#/');
  const inv = L.locator('[data-testid=invite]').first();
  await until('the learner sees the invitation', async () => (await L.locator('[data-testid=invite]').count()) > 0, 20000);
  const invText = await inv.innerText();
  t.ok('the invitation names the owner and the course', /Riley Owner sent you ColdFusion \(CFML\) 501/.test(invText), invText);
  t.ok('and shows the message', /have fun!/.test(invText));
  await inv.locator('[data-testid=accept]').click();
  await until('the course is downloaded and on the learner’s hub', async () => (await L.locator('[data-testid=open-cfml]').count()) > 0, 30000);
  t.ok('accepting made the grant and marked the offer accepted', hub.db.grants.length === 1 && hub.db.offers[0].status === 'accepted');
  t.ok('the course is stored locally for offline use', (await learner.api('/api/courses')).courses.find((c) => c.id === 'cfml').source === 'hub');
  await shot(L, 'learner-home');

  /* 5 ---------------------------------------------------------- overview */
  t.section('Overview');
  await L.click('[data-testid=open-cfml]');
  await L.waitForSelector('[data-testid=overview-title]');
  t.ok('overview: the course title', (await L.innerText('[data-testid=overview-title]')) === 'ColdFusion (CFML) 501');
  t.ok('overview: 0% to start', (await L.innerText('[data-testid=overview-percent]')) === '0%');
  t.ok('overview: all 9 units listed', (await L.locator('details.unit').count()) === 9);
  t.ok('overview: lessons, projects and checks each with a status', (await L.locator('[data-item] .status').count()) >= 60);
  t.ok('overview: a Start button and a time estimate', /Start/.test(await L.innerText('[data-testid=continue]')) && /left, of about/.test(await L.innerText('main')));
  await shot(L, 'learner-overview');

  /* 6 ---------------------------------------------- study while offline */
  t.section('Offline');
  await fetch(hub.url + '/__test/down?on=1');
  await L.locator('[data-item="u1l2"] button.open').click();
  await L.waitForSelector('[data-testid=player-frame]');
  const frame = L.frameLocator('[data-testid=player-frame]');
  await frame.locator('textarea.editor').first().waitFor({ timeout: 30000 });
  // the exercise's own editor is the one holding the exercise's starter code
  const { sol, idx } = await L.evaluate(() => {
    const w = document.querySelector('[data-testid=player-frame]').contentWindow;
    let ex = null;
    for (const u of w.CFContent.COURSE.units) for (const l of u.lessons) for (const b of l.blocks) if (b.t === 'exercise' && b.ex.id === 'u1l2e1') ex = b.ex;
    const tas = [...w.document.querySelectorAll('textarea.editor')];
    return { sol: ex.solution, idx: tas.findIndex((t) => t.value === ex.starter) };
  });
  t.ok('the lesson opened with its exercise', idx >= 0);
  await frame.locator('textarea.editor').nth(idx).fill(sol);
  await frame.locator('.runbtn').nth(idx).click();
  await sleep(600);
  await frame.locator('.donerow button').first().click();
  await until('the exercise and the lesson are saved locally', async () => {
    const ov = await learner.api('/api/courses/cfml/overview');
    const l = ov.units[0].lessons.find((x) => x.id === 'u1l2');
    return l.status === 'done' && l.exercises.find((e) => e.id === 'u1l2e1').status === 'done';
  });
  t.ok('while offline: exercise passed and lesson done, saved on this computer', true);
  t.ok('nothing reached the hub yet', !hub.db.items.some((i) => i.ref === 'u1l2'));
  await until('the learner’s app knows it is offline', async () => !(await learner.api('/api/hub')).online);
  await L.goto(learner.url + '/#/course/cfml');
  await until('the sync badge says offline', async () => /Offline/.test(await L.innerText('[data-testid=sync-pill]')), 15000);
  t.ok('the sync badge says offline, work saved here', true);

  /* 7 ----------------------------------------------------- back online */
  t.section('Back online');
  await fetch(hub.url + '/__test/down?on=0');
  await until('the progress reaches the hub', async () => hub.db.items.some((i) => i.ref === 'u1l2' && i.completed) && hub.db.items.some((i) => i.ref === 'u1l2e1' && i.completed), 40000);
  t.ok('lesson and exercise merged into the hub', true);
  await O.goto(owner.url + '/#/owner/people');
  await until('the owner sees the learner’s progress', async () => { await O.reload(); const txt = await O.locator('[data-testid=person-row][data-email="sam@example.com"]').innerText(); return /ColdFusion \(CFML\) 501 [1-9]\d*%/.test(txt) && /Online/.test(txt); }, 30000);
  const ownerRow = await O.locator('[data-testid=person-row][data-email="sam@example.com"]').innerText();
  t.ok('the owner sees: online, the current course and lesson (by title), and the %', /Online/.test(ownerRow) && ownerRow.includes('ColdFusion (CFML) 501 · cfoutput and the Hash Marks') && /\d+%/.test(ownerRow), ownerRow);
  await shot(O, 'owner-people');

  const offersTab = await owner.api('/api/hub/owner/offers', { method: 'POST', body: {} });
  t.ok('the owner sees the offer as accepted', offersTab[0].status === 'accepted');
  t.ok('no page errors in either app', errors.length === 0, errors.join('\n'));
} catch (e) {
  t.ok('the flow ran to the end', false, e.stack);
} finally {
  await browser.close().catch(() => {});
  await owner.stop(); await learner.stop(); await hub.close();
  t.done();
}
