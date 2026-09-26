/* ===========================================================================
   server/src/platform/sync/supabase.js — the hub adapter for Supabase.
   ---------------------------------------------------------------------------
   Plain fetch against Supabase's own HTTP APIs; no client library.

     Auth     POST /auth/v1/signup, /auth/v1/token?grant_type=password|refresh_token,
              /auth/v1/logout
     Data     POST /rest/v1/rpc/<function> — every hub operation is one of the
              lantern_* functions in supabase/migrations, which check who is
              asking. The app never writes a table directly.
     Files    GET  /storage/v1/object/authenticated/course-packs/<path>
              POST /storage/v1/object/course-packs/<path>   (owner, publishing)

   The adapter interface (what engine.js needs from any hub):

     signUp(email, password, name)  → { session | null, user, confirm: bool }
     signIn(email, password)        → session { access_token, refresh_token, expires_at, user }
     refresh(refreshToken)          → session
     signOut(accessToken)
     rpc(name, args, accessToken)   → JSON
     download(path, accessToken, onProgress(received, total)) → Buffer
     upload(path, buffer, token)    → { path }

   Errors carry .kind: 'offline' (no network or the hub is down), 'auth'
   (signed out or the session is no good), 'denied', or 'hub' (the hub said no,
   with its own message, which is shown to the person as written).
   =========================================================================== */

export class HubError extends Error {
  constructor(message, kind, status) { super(message); this.name = 'HubError'; this.kind = kind || 'hub'; this.status = status || 0; }
}

export function supabaseAdapter(cfg, opts) {
  const o = opts || {};
  const doFetch = o.fetch || globalThis.fetch;
  const base = String(cfg.url).replace(/\/+$/, '');
  const anon = cfg.anonKey;
  const TIMEOUT = o.timeout || 20000;
  // How far this computer's clock is from the hub's (the hub's "Date" header,
  // taken from quick answers only): a computer whose clock is wrong must not
  // make its progress look newer, or older, than another computer's.
  const clock = { offset: 0, samples: 0 };

  async function req(path, init, token) {
    const headers = Object.assign({ apikey: anon, 'content-type': 'application/json' }, init && init.headers);
    // The public key goes in apikey. Authorization carries a signed-in
    // person's token only (Supabase's newer publishable keys are not tokens).
    if (token) headers.authorization = 'Bearer ' + token;
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    let r;
    try {
      r = await doFetch(base + path, Object.assign({}, init, { headers, signal: AbortSignal.timeout(init && init.timeout || TIMEOUT) }));
    } catch (e) {
      throw new HubError('The hub cannot be reached right now. Lantern will keep working and try again.', 'offline');
    }
    if (r.status >= 500 || r.status === 429) throw new HubError('The hub is busy or down (' + r.status + '). Lantern will try again.', 'offline', r.status);
    try {
      const d = Date.parse(r.headers.get('date') || '');
      if (!isNaN(d)) { const off = d + 500 - Date.now(); clock.offset = clock.samples ? Math.round(clock.offset * 0.7 + off * 0.3) : off; clock.samples++; }
    } catch (e) { /* no date */ }
    return r;
  }

  async function jsonOf(r) {
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = { message: text }; }
    if (r.ok) return body;
    const msg = (body && (body.msg || body.message || body.error_description || body.error)) || ('The hub answered ' + r.status + '.');
    if (r.status === 401 || /jwt|token/i.test(msg) && r.status === 403) throw new HubError(msg, 'auth', r.status);
    if (r.status === 403 || (body && body.code === '42501')) throw new HubError(msg, 'denied', r.status);
    throw new HubError(msg, 'hub', r.status);
  }

  const session = (b) => {
    if (!b || !b.access_token) return null;
    return {
      access_token: b.access_token, refresh_token: b.refresh_token,
      expires_at: b.expires_at ? b.expires_at * 1000 : Date.now() + (Number(b.expires_in) || 3600) * 1000,
      user: b.user ? { id: b.user.id, email: b.user.email } : null,
    };
  };

  return {
    kind: 'supabase',
    url: base,
    /* hub time minus this computer's time, in ms (0 until the hub has answered) */
    clockOffset: () => clock.offset,

    async ping() {
      const r = await req('/auth/v1/settings', { method: 'GET' });
      if (!r.ok) throw new HubError('That does not look like a Supabase project (the address or the key is wrong).', 'hub', r.status);
      return true;
    },

    async signUp(email, password, name) {
      const b = await jsonOf(await req('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password, data: { display_name: name || '' } }) }));
      const s = session(b);
      const user = (b && (b.user || (b.id ? b : null))) || null;
      return { session: s, user: user ? { id: user.id, email: user.email } : null, confirm: !s };
    },

    async signIn(email, password) {
      const s = session(await jsonOf(await req('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) })));
      if (!s) throw new HubError('Signing in did not work.', 'auth');
      return s;
    },

    /* Email sign-in link: Supabase emails a link; pressing it opens
       redirectTo#access_token=…&refresh_token=… on this computer, and the
       callback page hands those to completeLink(). Works with Supabase's
       default email (free plan, no custom SMTP). Creates the account if there
       is none (that is how an invited person joins). */
    async sendLink(email, name, redirectTo) {
      const q = redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : '';
      await jsonOf(await req('/auth/v1/otp' + q, { method: 'POST', body: JSON.stringify({ email, create_user: true, data: { display_name: name || '' } }) }));
      return true;
    },

    /* The tokens from a pressed sign-in link. The refresh token is swapped at
       once, which both proves it is real and makes the copy in the address
       bar useless. */
    async completeLink(tokens) {
      const t = tokens || {};
      if (!t.refresh_token) throw new HubError('That sign-in link was incomplete. Ask for a new one.', 'auth');
      const s = session(await jsonOf(await req('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: String(t.refresh_token) }) })));
      if (!s) throw new HubError('That sign-in link has expired. Ask for a new one.', 'auth');
      return s;
    },

    /* Email code sign-in: a 6-digit code is emailed; no password needed.
       Only when the hub's email template includes {{ .Token }}, which on
       Supabase needs your own email sender (custom SMTP); the hub config says
       so with "emailCode": true. */
    async sendCode(email, name) {
      await jsonOf(await req('/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email, create_user: true, data: { display_name: name || '' } }) }));
      return true;
    },

    async verifyCode(email, code) {
      const s = session(await jsonOf(await req('/auth/v1/verify', { method: 'POST', body: JSON.stringify({ type: 'email', email, token: String(code).trim() }) })));
      if (!s) throw new HubError('That code did not work. Ask for a new one.', 'auth');
      return s;
    },

    async refresh(refreshToken) {
      const s = session(await jsonOf(await req('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) })));
      if (!s) throw new HubError('Your sign-in has expired. Sign in again.', 'auth');
      return s;
    },

    async signOut(token) {
      try { await req('/auth/v1/logout', { method: 'POST', body: '{}' }, token); } catch (e) { /* signing out locally is what matters */ }
    },

    async rpc(name, args, token) {
      return jsonOf(await req('/rest/v1/rpc/' + encodeURIComponent(name), { method: 'POST', body: JSON.stringify(args || {}) }, token));
    },

    async download(path, token, onProgress) {
      const r = await req('/storage/v1/object/authenticated/course-packs/' + path.split('/').map(encodeURIComponent).join('/'),
        { method: 'GET', headers: { 'content-type': undefined }, timeout: 10 * 60000 }, token);
      if (!r.ok) await jsonOf(r);
      const total = Number(r.headers.get('content-length')) || 0;
      if (!r.body || !r.body.getReader) return Buffer.from(await r.arrayBuffer());
      const reader = r.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        let step;
        try { step = await reader.read(); } catch (e) { throw new HubError('The download was interrupted. Try again.', 'offline'); }
        if (step.done) break;
        chunks.push(Buffer.from(step.value));
        received += step.value.length;
        if (onProgress) onProgress(received, total);
      }
      return Buffer.concat(chunks);
    },

    async upload(path, buf, token) {
      const r = await req('/storage/v1/object/course-packs/' + path.split('/').map(encodeURIComponent).join('/'),
        { method: 'POST', body: buf, headers: { 'content-type': 'application/json', 'x-upsert': 'true' }, timeout: 10 * 60000 }, token);
      await jsonOf(r);
      return { path };
    },
  };
}
