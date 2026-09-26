#!/usr/bin/env node
/* ===========================================================================
   scripts/launch.mjs — start Lantern (once), open it, or stop it.
   ---------------------------------------------------------------------------
       node scripts/launch.mjs                         start if needed, open the app
       node scripts/launch.mjs --open cfml             … at a course's overview
       node scripts/launch.mjs --open cfml:u3l2        … at a lesson
       node scripts/launch.mjs "lantern://open?course=cfml&lesson=u3l2"
       node scripts/launch.mjs --hidden                start without opening a window
       node scripts/launch.mjs --status                is it running? (exit 0 yes, 1 no)
       node scripts/launch.mjs --stop                  stop it

   ONE COPY: if Lantern is already running (its presence file names a port
   that answers), this asks that copy to open the page instead of starting
   another. Otherwise it installs a waiting update first (Settings → Updates:
   "next time I open Lantern"), then starts the server in the background with
   no console window, and waits until it answers.

   Exit codes: 0 done · 1 not running (--status) · 2 could not start.
   Used by the Start/Stop shortcuts, the lantern:// link handler and other
   apps (Dayspring). See docs/dev/ecosystem.md.
   =========================================================================== */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPresence, alive } from '../server/src/platform/eco.js';
import { port as configPort } from '../server/src/platform/config.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function target() {
  const url = args.find((a) => /^lantern:\/\//i.test(a));
  let course = null, lesson = null;
  if (url) {
    try { const u = new URL(url); course = u.searchParams.get('course'); lesson = u.searchParams.get('lesson'); } catch (e) { /* ignore a bad link */ }
  }
  const oi = args.indexOf('--open');
  if (oi >= 0 && args[oi + 1]) [course, lesson] = args[oi + 1].split(':');
  const ok = (s) => (s && /^[\w.-]{1,80}$/.test(s) ? s : null);
  return { course: ok(course), lesson: ok(lesson) };
}

async function running() {
  const p = readPresence('lantern');
  return p && (await alive(p)) ? p : null;
}

async function post(p, path, body) {
  const r = await fetch('http://127.0.0.1:' + p.port + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eco-token': p.token }, body: JSON.stringify(body || {}) });
  return r.ok;
}

async function main() {
  if (has('--status')) { const p = await running(); console.log(p ? 'Lantern ' + p.version + ' is running on port ' + p.port + '.' : 'Lantern is not running.'); return p ? 0 : 1; }
  if (has('--stop')) {
    const p = await running();
    if (!p) { console.log('Lantern is not running.'); return 0; }
    await post(p, '/api/eco/shutdown').catch(() => {});
    console.log('Lantern is stopping.');
    return 0;
  }
  const t = target();
  const hidden = has('--hidden') || has('--no-browser');
  const p = await running();
  if (p) {
    if (!hidden) await post(p, '/api/local/open', { course: t.course, lesson: t.lesson }).catch(() => {});
    console.log('Lantern is already running.');
    return 0;
  }
  // A waiting update goes in before the program starts.
  if (!has('--no-update')) {
    const u = spawn(process.execPath, [join(ROOT, 'scripts', 'update.mjs'), '--pending'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    await new Promise((res) => u.on('exit', res));
  }
  const hash = t.course ? '#/' + (t.lesson ? 'learn/' + encodeURIComponent(t.course) + '?open=' + encodeURIComponent(t.lesson) : 'course/' + encodeURIComponent(t.course)) : '';
  const child = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    env: Object.assign({}, process.env, { LANTERN_OPEN: hash, LANTERN_NO_BROWSER: hidden ? '1' : '' }),
  });
  child.unref();
  const port = configPort();
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/eco/hello', { signal: AbortSignal.timeout(1000) }); if (r.ok) { console.log('Lantern is running: http://127.0.0.1:' + port + '/'); return 0; } } catch (e) { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('Lantern did not start. Run "node server/src/index.js" in the Lantern folder to see why.');
  return 2;
}

// Let open connections close by themselves (a hard exit while a socket is
// closing can crash Node on Windows); a timer makes sure it does end.
const end = (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 3000).unref(); };
main().then(end, (e) => { console.error(e.message); end(2); });
