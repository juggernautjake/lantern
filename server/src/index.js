#!/usr/bin/env node
/* ===========================================================================
   server/src/index.js — start Lantern.
   ---------------------------------------------------------------------------
       node server/src/index.js              the app (default)
       node server/src/index.js --selftest   load everything, check, exit 0/1
       LANTERN_MODE=demo node server/src/index.js   the demo school

   No install step. Node's own sqlite, http and fetch are the whole dependency
   list. Node 22.13 or newer.

   THE APP (docs/dev/architecture.md): one person per computer, listening on
   127.0.0.1:4321 only, data in the data folder (platform/config.js), courses
   as packs, progress saved here first and carried to the hub when it can be.

   With no ANTHROPIC_API_KEY it starts anyway; everything except the AI
   assistant works without one.
   =========================================================================== */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { open, one, run, all } from './db/db.js';
import { serve } from './http/server.js';
import { routes } from './routes.js';
import { runner, runnerError, course } from './course/runner.js';
import { indexCourse } from './search/index.js';
import { configured, MODELS } from './ai/client.js';
import { soloUser, soloProblem } from './http/server.js';
import * as config from './platform/config.js';
import * as platformRoutes from './platform/routes.js';
import * as assistantRoutes from './assistant/routes.js';
import * as packs from './platform/packs.js';
import * as local from './platform/local.js';
import * as settings from './platform/settings.js';
import * as engine from './platform/sync/engine.js';
import * as eco from './platform/eco.js';
import * as updater from './platform/updater.js';
import * as bus from './platform/bus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/* A .env file, read without a dependency: the one in the data folder
   (lantern.env), then the developer's server/.env. Real environment variables
   win, so a container's settings are never overridden by a file. */
function loadEnv() {
  let n = 0;
  for (const file of [process.env.LANTERN_ENV, config.paths.env(), join(HERE, '..', '.env')].filter(Boolean)) {
    if (!existsSync(file)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || process.env[m[1]] !== undefined) return;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
      n++;
    });
  }
  return n;
}

export function boot(opts) {
  const o = opts || {};
  loadEnv();
  const app = config.mode() === 'app';
  if (app) config.ensureDataDir();
  open(o.db);

  const R = runner();
  let indexed = 0;
  if (R && !app) {
    const c = course();
    if (c) {
      const courseRow = one("SELECT id FROM courses WHERE code = 'CFML-501'");
      indexed = indexCourse(c, courseRow ? courseRow.id : null);
    }
  }

  const r = routes();
  platformRoutes.register(r);
  assistantRoutes.register(r);
  r.static_('/app/', join(ROOT, 'app'));
  // ecosystem-core, shared with Dayspring: /eco/client/… (tokens, the lantern, the sound panel) and /eco/shared/…
  r.static_('/eco/', join(ROOT, 'vendor', 'ecosystem-core'));
  r.static_('/static/', join(HERE, '..', 'public'));
  r.static_('/shell/', join(HERE, '..', 'public', 'shell'));
  r.static_('/dist/', join(ROOT, 'dist'));

  const shellHtml = join(HERE, '..', 'public', 'shell', 'index.html');
  const classicHtml = join(HERE, '..', 'public', 'index.html');
  r.get('/workspace', async ({ send }) => { send(200, readFileSync(classicHtml), { 'content-type': 'text/html; charset=utf-8' }); }, { auth: false });

  let uid = null;
  if (app) {
    uid = local.userId();
    // Courses sitting next to the program (a course author's own build) are
    // installed when they are new or newer. The public program has none.
    const bundled = packs.installBundled(process.env.LANTERN_BUNDLED_PACKS || join(ROOT, 'dist', 'packs'));
    bundled.filter((b) => b.error).forEach((b) => console.warn('[lantern] could not install ' + b.file + ': ' + b.error));
    recordVersion();
  }

  const server = serve(r, {
    log: o.log !== undefined ? o.log : !app,
    guard: app ? (req) => eco.guard(req) : null,
    solo: app ? () => local.userId() : null,
    fallback: () => {
      const f = app ? shellHtml : classicHtml;
      return existsSync(f) ? { body: readFileSync(f), mime: 'text/html; charset=utf-8' } : null;
    },
  });

  return { server, indexed, cfml: !!R, app, uid };
}

/* The first start of a new version (installed by hand, or by the updater
   before it restarted) goes into the update log once. */
function recordVersion() {
  const v = config.version();
  if (settings.get('last_version') === v) return;
  const had = one("SELECT id FROM update_log WHERE channel = 'platform' AND to_version = ? AND status = 'installed'", v);
  const prev = settings.get('last_version');
  if (!had && prev) {
    run("INSERT INTO update_log (channel, subject, from_version, to_version, status, title, notes, message) VALUES ('platform','lantern',?,?, 'installed', ?, ?, ?)",
      prev, v, 'Lantern ' + v, changelogFor(v), 'Lantern ' + v + ' is installed.');
  }
  settings.set('last_version', v);
}

function changelogFor(v) {
  try {
    const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const m = new RegExp('^## \\[?' + v.replace(/\./g, '\\.') + '\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))', 'm').exec(text);
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}

/* Listen, and wait for a port the old copy is still letting go of (after an
   update restart). */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && tries++ < (process.env.LANTERN_RESTARTED ? 30 : 0)) return setTimeout(attempt, 500);
        reject(e);
      });
      server.listen(port, host, () => resolve());
    };
    attempt();
  });
}

function openBrowser(url) {
  import('node:child_process').then(({ spawn }) => {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { /* no browser */ }
  });
}

async function selftest() {
  // Everything loads, the database opens with every migration, the routes
  // build. The updater runs this on a new version before and after installing it.
  // A throwaway data folder: a self-test never touches anybody's real data.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'lantern-selftest-'));
  process.env.LANTERN_MODE = process.env.LANTERN_MODE || 'app';
  process.env.LANTERN_DATA = tmp;
  process.env.LANTERN_BUNDLED_PACKS = join(tmp, 'none');
  config.resetCache();
  const { server } = boot({ db: ':memory:', log: false });
  process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ } });
  const tables = all("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
  for (const t of ['users', 'packs', 'pack_progress', 'progress_items', 'update_log', 'schema_migrations']) {
    if (tables.indexOf(t) < 0) throw new Error('missing table ' + t);
  }
  server.close();
  console.log('selftest ok ' + config.version());
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain && process.argv.includes('--selftest')) {
  selftest().then(() => process.exit(0), (e) => { console.error('selftest failed: ' + (e.stack || e.message)); process.exit(1); });
} else if (isMain) {
  main().catch((e) => {
    if (e.code === 'EADDRINUSE') console.error('\nLantern is already running (port ' + config.port() + ' is in use). Open http://127.0.0.1:' + config.port() + '/');
    else console.error(e.stack || e.message);
    process.exit(1);
  });
}

async function main() {
  if (!config.nodeOk()) {
    console.error('Lantern needs Node.js ' + config.MIN_NODE + ' or newer (this is ' + process.versions.node + '). Get it from https://nodejs.org');
    process.exit(1);
  }
  const port = config.port();
  const { server, indexed, cfml, app, uid } = boot();
  const host = app ? config.host() : (process.env.LANTERN_HOST || '0.0.0.0');
  await listen(server, port, host);
  const line = (a, b) => console.log('  ' + String(a).padEnd(14) + b);
  console.log('\nLantern ' + config.version());
  line('listening', 'http://127.0.0.1:' + port);
  line('mode', config.mode());
  line('data', config.dataDir());

  if (app) {
    eco.writePresence();
    eco.startForwarding();
    engine.start();
    engine.consumeHandoff().then((h) => { if (h.used) console.log('  sign-in       handed over from ' + (h.from || 'another app')); else if (h.error) console.warn('  sign-in       ' + h.error); })
      .catch((e) => console.warn('  sign-in       handoff failed: ' + e.message));
    platformRoutes.startReminders(uid);
    updater.startLoop({
      getMode: platformRoutes.updateMode,
      // idle, and never during a call, an alarm or while another app is speaking
      idleFor: () => { const q = eco.quietState(); return q.inCall || q.alarm || q.peerSpeaking ? 0 : platformRoutes.idleFor(); },
      onAvailable: () => {},
      onApply: (info) => platformRoutes.applyUpdate(info),
    });
    eco.send('app.started', { app: 'lantern', version: config.version(), port }).catch(() => {});
    const h = engine.status();
    line('hub', h.configured ? (h.signedIn ? 'signed in as ' + (h.profile ? h.profile.display_name : '?') : 'connected, not signed in') : 'not connected (Settings → Hub)');
    line('courses', packs.list().map((p) => p.title + ' ' + p.version).join(', ') || 'none yet');
    const openHash = process.env.LANTERN_OPEN || '';
    if (!process.env.LANTERN_NO_BROWSER) openBrowser('http://127.0.0.1:' + port + '/' + openHash);
    bus.emit('started', { port });
  } else {
    line('CFML runner', cfml ? 'loaded' : 'NOT loaded (' + runnerError() + ')');
    line('search', indexed + ' course documents indexed');
    const solo = soloUser();
    const soloWhy = soloProblem();
    if (solo) {
      const u = one('SELECT name, email, role FROM users WHERE id = ?', solo);
      line('sign-in', 'SOLO MODE — every visitor is ' + u.name + ' (' + u.role + ', ' + u.email + ')');
    } else if (soloWhy) {
      line('sign-in', 'LANTERN_SOLO is set but not in use — ' + soloWhy);
    } else {
      line('sign-in', 'normal — a password is required');
    }
  }
  line('assistant', configured() ? 'configured · ' + MODELS.chat : 'no ANTHROPIC_API_KEY — the AI assistant is off');
  console.log('');
}
