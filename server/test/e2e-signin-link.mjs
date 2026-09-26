/* e2e-signin-link.mjs — the emailed sign-in link, in a real (headless) browser.
   A person without a password asks for a link; the fake hub "emails" it; the
   browser opens it; the /auth/callback page reads the #fragment, hands the
   tokens to Lantern, clears the address bar and goes home signed in.
     node server/test/e2e-signin-link.mjs                                        */
import { startFakeHub } from './fake-hub.mjs';
import { startApp, until, loadPlaywright } from './helpers.mjs';

const pw = await loadPlaywright();
if (!pw) { console.error('playwright-core is not available.'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

const hub = await startFakeHub({});
const a = await startApp({ name: 'link', port: 4491 });
let browser;
try {
  await a.api('/api/hub/configure', { method: 'POST', body: { url: hub.url, anonKey: hub.anonKey } });
  browser = await pw.chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(a.url + '/#/settings/account');
  await page.getByTestId('tab-link').click();
  await page.getByTestId('link-email').fill('linkperson@example.com');
  await page.getByTestId('link-send').click();
  await page.getByText('Sent. Open the email').waitFor({ timeout: 10000 });
  ok('asking for a link says it was sent', true);
  ok('there is no "code" tab on a hub without a code email', (await page.getByTestId('tab-code').count()) === 0);
  const link = hub.link('linkperson@example.com');
  ok('the fake hub emailed a link back to this app', !!link && link.startsWith(a.url + '/auth/callback#'));
  await page.goto(link);
  await until('signed in', async () => (await a.api('/api/hub')).signedIn, 15000);
  ok('opening the link signs the person in', (await a.api('/api/hub')).signedIn);
  await page.waitForURL((u) => !String(u).includes('/auth/callback'), { timeout: 10000 });
  ok('the page goes on to Lantern', !page.url().includes('access_token'));
  // a used link (its refresh token was swapped) no longer works
  await a.api('/api/hub/signout', { method: 'POST' });
  await page.goto('about:blank');
  await page.goto(link);
  await page.getByText('did not work', { exact: false }).or(page.getByText('expired', { exact: false })).first().waitFor({ timeout: 10000 }).catch(() => {});
  ok('the same link cannot be used twice', !(await a.api('/api/hub')).signedIn);
  await page.goto('about:blank');
  await page.goto(a.url + '/auth/callback#error=access_denied&error_description=Email+link+is+invalid+or+has+expired');
  ok('an expired link explains itself', await page.getByText('Email link is invalid or has expired', { exact: false }).waitFor({ timeout: 8000 }).then(() => true, () => false));
  ok('no page errors', errors.length === 0);
} catch (e) {
  fail++; console.log('  ✗ ' + e.message);
} finally {
  if (browser) await browser.close();
  await a.stop(); await hub.close();
}
console.log((fail ? 'FAILED ' : 'all ') + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ''));
process.exit(fail ? 1 : 0);
