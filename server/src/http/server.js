/* ===========================================================================
   server/src/http/server.js — the HTTP layer: routing, bodies, sessions.
   ---------------------------------------------------------------------------
   Small on purpose. A router that matches a method and a path pattern, a body
   reader that understands JSON and multipart uploads, cookie sessions, and an
   error handler that turns the domain's own error types into the right status
   code. Roughly what a framework would give, minus the dependency and minus
   the parts this platform will never use.

   Two things here are security decisions rather than plumbing:

     - Every request resolves a permission CONTEXT once, and handlers get that
       rather than a user id. There is no way to call the filing system without
       one, so there is no path that forgets to check.
     - Uploads are bounded before they are buffered. A body that exceeds the
       limit is refused while it streams, not after it has been held in memory.
   =========================================================================== */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { one, run, insert, id } from '../db/db.js';
import * as perms from '../files/permissions.js';
import { mimeFor } from '../files/paths.js';

/* ------------------------------------------------------------- sessions --- */

const SESSION_DAYS = Number(process.env.LANTERN_SESSION_DAYS || 14);

export function startSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  insert('sessions', { token, user_id: userId, expires_at: expires });
  return { token, expires };
}

export function endSession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
}

export function userForToken(token) {
  if (!token) return null;
  const s = one("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')", token);
  return s ? s.user_id : null;
}

/* ---------------------------------------------------------------- solo ---
   One person, their own machine, no sign-in. LANTERN_SOLO names the account
   every unauthenticated request becomes; the session cookie is then set as
   normal, so everything downstream — permissions, the filing system, the
   assistant — works exactly as it does for a signed-in person, with no second
   code path to keep correct.

   Two guards, because this is the one setting that would be a catastrophe
   left on: it is refused outright in production, and the boot banner says in
   plain words that anybody who can reach the port is signed in as that
   person. It is off unless the variable is set. */
export function soloUser() {
  const who = String(process.env.LANTERN_SOLO || '').trim();
  if (!who || who === 'off' || who === 'false') return null;
  if (process.env.NODE_ENV === 'production') return null;
  const row = who === 'on' || who === 'true'
    ? one("SELECT id FROM users WHERE role = 'student' AND active = 1 ORDER BY created_at LIMIT 1")
    : one('SELECT id FROM users WHERE lower(email) = ?', who.toLowerCase());
  return row ? row.id : null;
}

export function soloProblem() {
  const who = String(process.env.LANTERN_SOLO || '').trim();
  if (!who || who === 'off' || who === 'false') return null;
  if (process.env.NODE_ENV === 'production') return 'refused: NODE_ENV is production';
  if (soloUser()) return null;
  return who === 'on' || who === 'true'
    ? 'no student account exists yet — run: node server/src/seed.js'
    : 'no account with the email ' + who;
}

const cookies = (req) => {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((bit) => {
    const i = bit.indexOf('=');
    if (i > 0) out[bit.slice(0, i).trim()] = decodeURIComponent(bit.slice(i + 1).trim());
  });
  return out;
};

/* --------------------------------------------------------------- router --- */

export class Router {
  constructor() { this.routes = []; this.statics = []; }

  add(method, pattern, handler, opts) {
    // '/api/files/:id/content' -> regex with named groups
    const names = [];
    const rx = new RegExp('^' + String(pattern).replace(/\/:([\w]+)/g, (m, n) => {
      names.push(n); return '/([^/]+)';
    }).replace(/\*$/, '(.*)') + '$');
    this.routes.push({ method, rx, names, handler, opts: opts || {} });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  del(p, h, o) { return this.add('DELETE', p, h, o); }

  /* Serve a directory of files at a URL prefix. */
  static_(prefix, dir) { this.statics.push({ prefix, dir }); return this; }

  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(path);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
}

/* ---------------------------------------------------------------- bodies --- */

const MAX_BODY = Number(process.env.LANTERN_MAX_UPLOAD || 50 * 1024 * 1024);

function readBody(req, limit) {
  const cap = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        reject(Object.assign(new Error('That upload is larger than the ' +
          Math.round(cap / 1048576) + ' MB limit.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* multipart/form-data, written out. Files arrive as
   { name, filename, mime, data }; plain fields as strings. */
export function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(delim);
  if (start < 0) return { fields: {}, files: [] };
  start += delim.length;

  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;       // closing --
    if (buf[start] === 0x0d) start += 2;                             // CRLF
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const head = buf.slice(start, headEnd).toString('utf8');
    let bodyEnd = buf.indexOf(delim, headEnd);
    if (bodyEnd < 0) bodyEnd = buf.length;
    const body = buf.slice(headEnd + 4, Math.max(headEnd + 4, bodyEnd - 2));   // drop trailing CRLF

    const nameM = /name="([^"]*)"/i.exec(head);
    const fileM = /filename="([^"]*)"/i.exec(head);
    const typeM = /content-type:\s*([^\r\n;]+)/i.exec(head);
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : null,
      mime: typeM ? typeM[1].trim() : null,
      data: body,
    });
    start = bodyEnd + delim.length;
  }

  const fields = {};
  const files = [];
  parts.forEach((p) => {
    if (p.filename) files.push({ field: p.name, name: p.filename, mime: p.mime || mimeFor(p.filename), data: p.data });
    else fields[p.name] = p.data.toString('utf8');
  });
  return { fields, files };
}

/* ----------------------------------------------------------------- serve --- */

export function serve(router, opts) {
  const o = opts || {};
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const path = decodeURIComponent(url.pathname);

    const send = (status, body, headers) => {
      const h = Object.assign({ 'x-content-type-options': 'nosniff' }, headers || {});
      if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
        const json = JSON.stringify(body);
        h['content-type'] = h['content-type'] || 'application/json; charset=utf-8';
        res.writeHead(status, h); res.end(json);
      } else {
        res.writeHead(status, h);
        res.end(body === undefined || body === null ? '' : body);
      }
      if (o.log !== false && !path.startsWith('/static')) {
        // eslint-disable-next-line no-console
        console.log(`${req.method} ${path} ${status} ${Date.now() - started}ms`);
      }
    };

    try {
      // The app's guard (platform/eco.js): this computer's Host, our own Origin.
      if (o.guard) {
        const g = o.guard(req);
        if (g) return send(g.status, { error: g.error });
      }
      const hit = router.match(req.method, path);
      if (!hit) {
        const st = serveStatic(router, path);
        if (st) return send(200, st.body, { 'content-type': st.mime, 'cache-control': 'no-cache' });
        if (o.fallback && req.method === 'GET' && !path.startsWith('/api/')) {
          const fb = o.fallback();
          if (fb) return send(200, fb.body, { 'content-type': fb.mime });
        }
        return send(404, { error: 'No such endpoint: ' + req.method + ' ' + path });
      }

      const { route, params } = hit;
      const ck = cookies(req);
      const token = ck.lantern || (String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null);
      let userId = userForToken(token);

      // Solo mode: this machine is one person, so make a session rather than
      // showing a sign-in screen to the only person who will ever use it — and
      // take over a session left behind by somebody else, because a cookie from
      // last week signing you in as the wrong account is exactly the confusion
      // solo mode exists to remove. To be somebody else, change LANTERN_SOLO.
      // The app: the one local person, and only for requests from this computer.
      const solo = o.solo ? (isLoopback(req) ? o.solo() : null) : soloUser();
      if (solo && userId !== solo) {
        userId = solo;
        const fresh = startSession(solo);
        res.setHeader('set-cookie',
          `lantern=${fresh.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
      }
      const ctx = userId ? perms.context(userId) : null;

      if (route.opts.auth !== false && !ctx) {
        return send(401, { error: 'Sign in first.' });
      }
      if (route.opts.role && ctx && route.opts.role.indexOf(ctx.role) < 0) {
        return send(403, { error: 'This needs a ' + route.opts.role.join(' or ') + ' account.' });
      }

      let body = null, files = [], fields = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const raw = await readBody(req, route.opts.maxBody);
        const ct = String(req.headers['content-type'] || '');
        if (/multipart\/form-data/i.test(ct)) {
          const b = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
          const parsed = parseMultipart(raw, (b && (b[1] || b[2]) || '').trim());
          files = parsed.files; fields = parsed.fields;
          body = fields;
        } else if (/application\/json/i.test(ct) && raw.length) {
          try { body = JSON.parse(raw.toString('utf8')); }
          catch (e) { return send(400, { error: 'That request body is not valid JSON.' }); }
        } else {
          body = raw;
        }
      }

      const out = await route.handler({
        req, res, params, query: Object.fromEntries(url.searchParams),
        body, files, fields, ctx, token, send, url,
        setSession: (t) => { res.setHeader('set-cookie',
          `lantern=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`); },
        clearSession: () => { res.setHeader('set-cookie', 'lantern=; HttpOnly; Path=/; Max-Age=0'); },
      });

      // A handler that answered by itself (a stream, a file) is done.
      if (res.writableEnded || res.headersSent) return undefined;
      if (out === undefined) return send(204, null);
      return send(out.status || 200, out.body === undefined ? out : out.body, out.headers);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch (x) { /* closed */ } return undefined; }
      const full = /SQLITE_FULL|database or disk is full|ENOSPC/i.test(String(e.code || '') + ' ' + String(e.message || ''));
      const ro = !full && /SQLITE_READONLY|readonly database|EROFS|EACCES|EPERM/i.test(String(e.code || '') + ' ' + String(e.message || ''));
      if (full || ro) {
        console.error('[lantern] ' + (e.stack || e.message));
        return send(507, { error: full ? 'This computer’s disk is full, so Lantern could not save. Free up some space; nothing already saved is lost.' : 'Lantern is not allowed to write to its data folder, so it could not save. Nothing already saved is lost.' });
      }
      const status = e.status || 500;
      if (status >= 500) console.error('[lantern] ' + (e.stack || e.message));
      return send(status, {
        error: e.message || 'Something went wrong.',
        // A permission refusal explains itself; the UI shows this to the user.
        why: e.decision ? e.decision.reason : undefined,
        rule: e.decision ? e.decision.rule : undefined,
      });
    }
  });
  return server;
}

function serveStatic(router, path) {
  for (const s of router.statics) {
    if (!path.startsWith(s.prefix)) continue;
    const rel = normalize(path.slice(s.prefix.length)).replace(/^([.][.][/\\])+/, '');
    const file = join(s.dir, rel);
    if (!file.startsWith(s.dir + sep) && file !== s.dir) continue;   // no escaping the directory
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    return { body: readFileSync(file), mime: mimeFor(file) + (isTextExt(extname(file)) ? '; charset=utf-8' : '') };
  }
  return null;
}

const isTextExt = (e) => /^\.(html?|css|js|mjs|json|txt|md|csv|svg)$/i.test(e);

export function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

export { id, cookies };
