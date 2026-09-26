/* ===========================================================================
   server/src/platform/config.js — which Lantern this is, and where its data lives.
   ---------------------------------------------------------------------------
   One codebase, two ways to run it:

     app   (default)  Lantern on a person's own computer — learners and the
                      owner alike. One person per computer, no local password,
                      listens on this computer only, works fully offline.
                      Accounts, course access, presence and synced progress
                      live in the HUB, a hosted Supabase project, reached only
                      through platform/sync/.
     demo             the original demo school (server/src/seed.js), for
                      developing the platform itself.

   Chosen by LANTERN_MODE, or by "mode" in <data>/lantern.json.

   THE DATA FOLDER is the rule that keeps people's work safe: everything a
   person makes — the database, downloaded courses, backups, the update log —
   lives in one folder OUTSIDE the program files, so an update can replace the
   program wholesale and never touch it.

     LANTERN_DATA       if set, exactly this
     Windows            %LOCALAPPDATA%/Lantern
     elsewhere          ~/.local/share/lantern
     demo               server/data (next to the code, as before)
   =========================================================================== */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/* The program folder: the one an update replaces. */
export const ROOT = join(HERE, '..', '..', '..');
export const SERVER = join(ROOT, 'server');

export const MODES = ['app', 'demo'];
export const MIN_NODE = '22.13.0';   // node:sqlite without a flag
export const DEFAULT_PORT = 4321;

let pkgCache = null;
export function pkg() {
  if (pkgCache) return pkgCache;
  try { pkgCache = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); }
  catch (e) { pkgCache = { version: '0.0.0' }; }
  return pkgCache;
}
export const version = () => String(pkg().version || '0.0.0');

/* The base folder, before the mode is taken into account. */
function baseDir() {
  if (process.env.LANTERN_DATA) return process.env.LANTERN_DATA;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'Lantern');
  return join(homedir(), '.local', 'share', 'lantern');
}

let fileCfg = null;
/* <data>/lantern.json — what the installer or the settings page chose. */
function fileConfig() {
  if (fileCfg) return fileCfg;
  try { fileCfg = JSON.parse(readFileSync(join(baseDir(), 'lantern.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { fileCfg = {}; }
  return fileCfg;
}
export const resetCache = () => { pkgCache = null; fileCfg = null; defaultHubCache = undefined; };

export function mode() {
  const m = String(process.env.LANTERN_MODE || fileConfig().mode || 'app').trim().toLowerCase();
  return MODES.indexOf(m) >= 0 ? m : 'app';
}
export const isApp = () => mode() === 'app';

export function dataDir() {
  if (process.env.LANTERN_DATA) return process.env.LANTERN_DATA;
  if (mode() === 'demo') return join(SERVER, 'data');
  return baseDir();
}

export const paths = {
  db: () => process.env.LANTERN_DB || join(dataDir(), 'lantern.db'),
  blobs: () => process.env.LANTERN_BLOBS || join(dataDir(), 'blobs'),
  packs: () => join(dataDir(), 'packs'),
  backups: () => join(dataDir(), 'backups'),
  updates: () => join(dataDir(), 'updates'),
  logs: () => join(dataDir(), 'logs'),
  env: () => join(dataDir(), 'lantern.env'),
  settingsFile: () => join(baseDir(), 'lantern.json'),
};

export function ensureDataDir() {
  const d = dataDir();
  for (const p of [d, paths.packs(), paths.backups(), paths.logs()]) mkdirSync(p, { recursive: true });
  return d;
}

/* Lantern listens on this computer only. Its local API (docs/dev/dayspring-bridge.md)
   needs no token because nothing else can reach it. The port is fixed so other
   local apps, such as Dayspring, can find it. */
export function port() {
  if (process.env.PORT) return Number(process.env.PORT);
  return Number(fileConfig().port || DEFAULT_PORT);
}
export const host = () => process.env.LANTERN_HOST || '127.0.0.1';

/* The hub: a Supabase project's URL and its PUBLIC anon key. Null for a
   stand-alone copy. Where it comes from, first match wins:
     1 LANTERN_HUB_URL + LANTERN_HUB_ANON_KEY     (tests, developers)
     2 <data>/lantern.json "hub"                   (Settings → Account & hub)
     3 config/hub.json in the program folder       (the default hub a course owner
                                                    bakes into their release, so
                                                    learners have nothing to paste)
   Never a secret or service-role key: one of those is ignored wherever it
   comes from. */
export function hub() {
  const f = fileConfig();
  const env = process.env.LANTERN_HUB_URL && process.env.LANTERN_HUB_ANON_KEY ? { url: process.env.LANTERN_HUB_URL, anonKey: process.env.LANTERN_HUB_ANON_KEY, emailCode: process.env.LANTERN_HUB_EMAIL_CODE === '1' } : null;
  const saved = f.hub && f.hub.url && f.hub.anonKey ? f.hub : null;
  const pick = env || saved || defaultHub();
  if (!pick) return null;
  const url = String(pick.url || '').trim().replace(/\/+$/, '');
  const anonKey = String(pick.anonKey || '').trim();
  if (!url || !anonKey || secretKey(anonKey)) return null;
  // emailCode: the hub's sign-in email includes a 6-digit code (needs the
  // owner's own email sender on Supabase). Off by default: the email has a link.
  return { kind: 'supabase', url, anonKey, emailCode: pick.emailCode === true, source: env ? 'env' : saved ? 'settings' : 'default' };
}

/* config/hub.json: { "url": "https://<project>.supabase.co", "anonKey": "<public key>" },
   empty in the public repo. LANTERN_NO_DEFAULT_HUB=1 ignores it;
   LANTERN_DEFAULT_HUB_FILE reads another file instead (tests). */
let defaultHubCache;
export function defaultHub() {
  if (process.env.LANTERN_NO_DEFAULT_HUB) return null;
  if (defaultHubCache !== undefined) return defaultHubCache;
  defaultHubCache = null;
  try {
    const j = JSON.parse(readFileSync(process.env.LANTERN_DEFAULT_HUB_FILE || join(ROOT, 'config', 'hub.json'), 'utf8').replace(/^\uFEFF/, ''));
    const url = String(j.url || '').trim(), anonKey = String(j.anonKey || '').trim();
    if (url && anonKey) {
      if (secretKey(anonKey)) console.warn('[lantern] config/hub.json holds a SECRET key. It is ignored: only the public (anon or publishable) key may go there.');
      else if (!/^https:\/\/\S+$/.test(url)) console.warn('[lantern] config/hub.json: the url should start with https://. It is ignored.');
      else defaultHubCache = { url, anonKey, emailCode: j.emailCode === true };
    }
  } catch (e) { /* none */ }
  return defaultHubCache;
}

/* A key that must never be inside the app: service_role JWTs and sb_secret_ keys. */
export function secretKey(key) {
  const k = String(key || '').trim();
  if (/^sb_secret_/.test(k)) return true;
  try { return /service_role/.test(JSON.parse(Buffer.from(k.split('.')[1] || '', 'base64url').toString('utf8')).role || ''); }
  catch (e) { return false; }
}

/* The GitHub repository updates come from: package.json "lantern.updateRepo". */
export const updateRepo = () => String(process.env.LANTERN_UPDATE_REPO || (pkg().lantern && pkg().lantern.updateRepo) || '').trim();

/* Where Dayspring listens, if it is on this computer. */
export const dayspringUrl = () => String(process.env.LANTERN_DAYSPRING_URL || fileConfig().dayspringUrl || 'http://127.0.0.1:4747').replace(/\/+$/, '');

export function saveFileConfig(patch) {
  const next = Object.assign({}, fileConfig(), patch);
  mkdirSync(baseDir(), { recursive: true });
  writeFileSync(paths.settingsFile(), JSON.stringify(next, null, 2));
  fileCfg = next;
  return next;
}
export const fileConfigView = () => Object.assign({}, fileConfig());

/* true when this Node is new enough (22.13+: node:sqlite without a flag). */
export function nodeOk(v) {
  const a = String(v || process.versions.node).split('.').map(Number);
  const b = MIN_NODE.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; }
  return true;
}

export const exists = existsSync;
