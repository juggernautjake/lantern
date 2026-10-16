/* ===========================================================================
   server/src/platform/phone.js — Lantern on your phone, through Tailscale.
   ---------------------------------------------------------------------------
   Lantern listens on this computer only (127.0.0.1). To open it on a phone,
   Tailscale (a private network between your own devices) runs "tailscale
   serve" on this computer: https://<this-pc>.<your-tailnet>.ts.net is
   answered by Tailscale, which passes each request on to 127.0.0.1 and says
   which Tailscale account sent it (the Tailscale-User-Login header). Nothing
   is opened to the internet, and nothing else on the home network can reach
   Lantern.

   A request that arrives that way is let in only when ALL of these hold:
     - phone access is switched on (Settings → Phone);
     - it comes from this computer (Tailscale's own proxy);
     - it is addressed to a *.ts.net name;
     - it names a Tailscale login on the allowed list (the account that was
       signed in to Tailscale on this PC when phone access was switched on);
     - an Origin, if sent, is that same https address.
   Anything else falls through to the normal guard, which accepts only this
   computer's own address.

   See docs/dev/phone.md.
   =========================================================================== */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as settings from './settings.js';
import { port as ourPort } from './config.js';

const KEY = 'phone';
const TS_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/;

let cache = null, cachedAt = 0;
export function conf() {
  // read on every request: kept for a moment so a page of requests is one look-up
  if (cache && Date.now() - cachedAt < 2000) return cache;
  let c = null;
  try { c = settings.get(KEY, null); } catch (e) { c = null; }
  cache = { enabled: !!(c && c.enabled), logins: (c && Array.isArray(c.logins) ? c.logins : []).map((l) => String(l).toLowerCase()) };
  cachedAt = Date.now();
  return cache;
}
function save(c) { settings.set(KEY, c); cache = null; }

const loopback = (req) => {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};
const hostOf = (req) => String(req.headers.host || '').toLowerCase().replace(/:443$/, '');

/* Is this request the owner's phone, through Tailscale? */
export function remoteOk(req) {
  const c = conf();
  if (!c.enabled || !c.logins.length) return false;
  if (!loopback(req)) return false;
  const host = hostOf(req);
  if (!TS_NAME.test(host)) return false;
  const login = String(req.headers['tailscale-user-login'] || '').toLowerCase();
  if (!login || !c.logins.includes(login)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && String(origin).toLowerCase() !== 'https://' + host) return false;
  return true;
}
/* For pages that behave differently on the phone (no wake word, and so on). */
export const isRemote = (req) => remoteOk(req);

/* ------------------------------------------------------------ Tailscale --- */

function tsPath() {
  const candidates = [
    process.env.TAILSCALE_EXE,
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}
function ts(args, timeout) {
  const exe = tsPath();
  if (!exe) return Promise.resolve({ ok: false, out: '', err: 'Tailscale is not installed.' });
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: timeout || 15000, windowsHide: true }, (e, out, err) => resolve({ ok: !e, out: String(out || ''), err: String(err || (e && e.message) || '') }));
  });
}

/* What the Settings → Phone page shows. */
export async function status() {
  const c = conf();
  const base = { enabled: c.enabled, logins: c.logins, installed: !!tsPath(), running: false, signedIn: false, url: null, login: null, serving: false, port: ourPort() };
  if (!base.installed) return base;
  const st = await ts(['status', '--json']);
  if (!st.ok) return Object.assign(base, { problem: st.err.trim().split('\n')[0] || 'Tailscale is not running.' });
  let j = {};
  try { j = JSON.parse(st.out); } catch (e) { j = {}; }
  const self = j.Self || {};
  const user = j.User && self.UserID != null ? j.User[self.UserID] : null;
  const dns = String(self.DNSName || '').replace(/\.$/, '');
  base.running = j.BackendState === 'Running';
  base.signedIn = base.running && !!dns;
  base.login = user ? String(user.LoginName || '').toLowerCase() : null;
  base.url = dns ? 'https://' + dns + '/' : null;
  const sv = await ts(['serve', 'status', '--json']);
  if (sv.ok) {
    try {
      const s = JSON.parse(sv.out || '{}');
      const web = s.Web || {};
      base.serving = Object.keys(web).some((k) => JSON.stringify(web[k]).includes(':' + ourPort()));
    } catch (e) { /* older Tailscale: no JSON */ base.serving = sv.out.includes(String(ourPort())); }
  }
  return base;
}

/* Switch phone access on: allow the Tailscale account signed in on this PC,
   and have Tailscale serve Lantern on the tailnet (HTTPS, port 443). */
export async function enable() {
  const st = await status();
  if (!st.installed) return { ok: false, error: 'Install Tailscale on this computer first.', status: st };
  if (!st.signedIn || !st.login) return { ok: false, error: 'Sign in to Tailscale on this computer first.', status: st };
  const logins = Array.from(new Set(conf().logins.concat([st.login])));
  save({ enabled: true, logins });
  const r = await ts(['serve', '--bg', '--https=443', 'http://127.0.0.1:' + ourPort()], 30000);
  if (!r.ok) {
    // A new tailnet has Serve (and HTTPS certificates) switched off: Tailscale prints a
    // link where the owner approves it once. Pass that link on.
    const said = (r.out + '\n' + r.err).trim();
    const approve = (said.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0] || null;
    return { ok: false, approve, error: approve ? 'Tailscale needs you to allow Serve on your tailnet once: open the link, approve, then switch phone access on again.' : 'Tailscale would not serve Lantern: ' + (said.split('\n').pop() || 'unknown error'), status: await status() };
  }
  return { ok: true, status: await status() };
}

export async function disable() {
  const c = conf();
  save({ enabled: false, logins: c.logins });
  if (tsPath()) await ts(['serve', '--https=443', 'off'], 15000);
  return { ok: true, status: await status() };
}
