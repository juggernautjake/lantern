/* ===========================================================================
   server/test/helpers.mjs — start real copies of the app for tests.
   ---------------------------------------------------------------------------
   Each copy gets its own data folder, its own ecosystem folder and its own
   spare port, never the real ones, and never opens a browser. The sync
   intervals are shortened so a test sees in seconds what takes a minute.
   =========================================================================== */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function tempDir(label) { return mkdtempSync(join(tmpdir(), 'lantern-' + (label || 'test') + '-')); }

export async function startApp(opts) {
  const o = opts || {};
  const base = o.base || tempDir(o.name || 'app');
  const data = o.data || join(base, 'data');
  const eco = o.eco || join(base, 'eco');
  mkdirSync(data, { recursive: true });
  const port = o.port;
  const env = Object.assign({}, process.env, {
    LANTERN_DATA: data, ECOSYSTEM_DIR: eco, PORT: String(port), LANTERN_NO_BROWSER: '1',
    LANTERN_SYNC_MS: '1200', LANTERN_HEARTBEAT_MS: '1500', LANTERN_CATALOG_MS: '1500', LANTERN_PULL_MS: '2500',
    LANTERN_BUNDLED_PACKS: o.bundled || join(base, 'no-bundled-packs'), ANTHROPIC_API_KEY: '', LANTERN_UPDATE_REPO: '',
    LANTERN_DAYSPRING_URL: o.dayspring || 'http://127.0.0.1:9',
  }, o.env || {});
  const child = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 30000;
  for (;;) {
    try { const r = await fetch(url + '/api/eco/hello'); if (r.ok) break; } catch (e) { /* not yet */ }
    if (child.exitCode !== null) throw new Error('The app exited: ' + log);
    if (Date.now() > deadline) throw new Error('The app did not start: ' + log);
    await sleep(200);
  }
  const app = {
    url, port, data, eco, base, child, get log() { return log; },
    presence: () => JSON.parse(readFileSync(join(eco, 'apps', 'lantern.json'), 'utf8')),
    async api(path, init) {
      const i = Object.assign({ method: 'GET' }, init || {});
      i.headers = Object.assign({ 'content-type': 'application/json' }, i.headers || {});
      if (i.body !== undefined && typeof i.body !== 'string') i.body = JSON.stringify(i.body);
      const r = await fetch(url + path, i);
      const t = await r.text();
      let j = null;
      try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
      if (!r.ok && !i.allowError) throw new Error(i.method + ' ' + path + ' → ' + r.status + ' ' + t.slice(0, 300));
      return i.allowError ? { status: r.status, body: j } : j;
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise((res) => { child.once('exit', res); setTimeout(res, 3000); });
    },
  };
  return app;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, fn, ms) {
  const deadline = Date.now() + (ms || 20000);
  let last = null;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() > deadline) throw new Error('Timed out waiting for: ' + what + (last ? ' (' + last.message + ')' : ''));
    await sleep(250);
  }
}

/* A tiny test runner with the same output style as the other suites. */
export function suite(title) {
  let passed = 0, failed = 0;
  const fails = [];
  console.log('\n\x1b[1m' + title + '\x1b[0m');
  const t = {
    ok(what, cond, detail) {
      if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + what); }
      else { failed++; fails.push(what); console.log('  \x1b[31m✗ ' + what + '\x1b[0m' + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
    },
    eq(what, got, want) { t.ok(what, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); },
    section(s) { console.log('\n  \x1b[1m' + s + '\x1b[0m'); },
    done() {
      console.log('\n' + '─'.repeat(60));
      if (failed) { console.log('\x1b[31m' + failed + ' failed\x1b[0m, ' + passed + ' passed'); fails.forEach((f) => console.log('  - ' + f)); process.exitCode = 1; }
      else console.log('\x1b[1m\x1b[32mall ' + passed + ' checks passed\x1b[0m');
      return { passed, failed };
    },
  };
  return t;
}

export function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    // a sibling project that already has it (no install needed here)
    join(ROOT, '..', 'dayspring', 'apps', 'desk', 'node_modules', 'playwright-core', 'index.js'),
    join(ROOT, 'node_modules', 'playwright-core', 'index.js'),
  ].filter(Boolean);
  return (async () => {
    for (const c of candidates) { try { const m = await import('file:///' + c.replace(/\\/g, '/')); return m.default || m; } catch (e) { /* next */ } }
    return null;
  })();
}
