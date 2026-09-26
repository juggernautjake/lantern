// The local app ecosystem: how Dayspring, Lantern (and any later sibling) find each other on one computer and talk.
// The full contract is docs/ECOSYSTEM.md; this is the shared implementation both apps use.
//
// DISCOVERY. Each running app writes a presence file into a shared per-user folder and removes it when it stops:
//   %LOCALAPPDATA%\Ecosystem\apps\<app>.json    (ECOSYSTEM_DIR overrides)
//   { app, version, port, pid, startedAt, token, api: "/api/eco", schema: 1, dataDir, handoff }
// An app finds another by reading its file and asking GET <api>/hello (a file left behind by a crash doesn't answer).
//
// SECURITY. Everything listens on 127.0.0.1 only, and:
//   - every request must name this computer in its Host header (stops DNS-rebinding pages)
//   - a request carrying an Origin must come from the app's own pages (stops ordinary websites)
//   - anything that changes something or opens a window needs the app's token, which only this Windows user's
//     processes can read from the presence file (it changes every start)
//
// EVENTS. One versioned shape, both directions: { v: 1, id, type, source, at, data }. EVENT_TYPES says who sends what.
//
//   const eco = createEco({ app: "dayspring", version: "1.0.1", port: 4747, dataDir });
//   eco.writePresence() · eco.peer("lantern") · eco.send("dnd", { on: true }) · eco.call("lantern", "/api/local/status")
//   eco.guard(req) → null | { status, error } · eco.tokenOk(req) · eco.validateEvent(ev)
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEMA = 1;

export function ecoDir(env = process.env) {
  if (env.ECOSYSTEM_DIR) return env.ECOSYSTEM_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "Ecosystem");
  return join(homedir(), ".local", "share", "ecosystem");
}

// type → { from: the apps that send it, data: the fields it must carry }
export const EVENT_TYPES = {
  // Lantern → others
  "lesson.started": { from: ["lantern"], data: ["course", "ref"] },
  "lesson.completed": { from: ["lantern"], data: ["course", "ref"] },
  "unit.completed": { from: ["lantern"], data: ["course", "ref", "title"] },
  "course.offered": { from: ["lantern"], data: ["course", "courseTitle", "from"] },
  "course.accepted": { from: ["lantern"], data: ["course"] },
  "course.declined": { from: ["lantern"], data: ["course"] },
  "course.updated": { from: ["lantern"], data: ["course", "to"] },
  "friend.request": { from: ["lantern"], data: ["requestId", "from"] },
  "friend.accepted": { from: ["lantern"], data: ["name"] },
  "reminder.due": { from: ["lantern", "dayspring"], data: ["text"] },
  "study.goal": { from: ["lantern"], data: ["minutes", "goal"] },
  "streak": { from: ["lantern"], data: ["days"] },
  "app.update.available": { from: ["lantern", "dayspring"], data: ["app", "version"] },
  "user.signed_in": { from: ["lantern", "dayspring"], data: [] },
  "user.signed_out": { from: ["lantern", "dayspring"], data: [] },
  "schedule.block.request": { from: ["lantern"], data: ["title", "time", "minutes"] },
  // Dayspring → Lantern
  "schedule.block.started": { from: ["dayspring"], data: ["title"] },
  "schedule.block.ended": { from: ["dayspring"], data: ["title"] },
  "alarm": { from: ["dayspring"], data: [] },
  "dnd": { from: ["dayspring"], data: ["on"] },
  "call.state": { from: ["dayspring"], data: ["inCall"] },
  "focus.start": { from: ["lantern", "dayspring"], data: [] },
  "focus.stop": { from: ["lantern", "dayspring"], data: [] },
  // only one app speaks at a time: the other waits (or ducks) until speaking.stop
  "speaking.start": { from: ["lantern", "dayspring"], data: ["app"] },
  "speaking.stop": { from: ["lantern", "dayspring"], data: ["app"] },
  // who listens for the wake word right now (one mic owner at a time)
  "mic.owner": { from: ["lantern", "dayspring"], data: ["app"] },
  "app.started": { from: ["lantern", "dayspring"], data: ["app"] },
  "app.stopping": { from: ["lantern", "dayspring"], data: ["app"] },
};

export function validateEvent(ev, types = EVENT_TYPES) {
  const errs = [];
  if (!ev || typeof ev !== "object") return ["The event must be a JSON object."];
  if (ev.v !== SCHEMA) errs.push(`v must be ${SCHEMA}.`);
  if (typeof ev.id !== "string" || !ev.id) errs.push("id is required.");
  const spec = types[ev.type];
  if (!spec) errs.push(`Unknown type "${ev.type}".`);
  if (typeof ev.source !== "string" || !ev.source) errs.push("source is required.");
  if (typeof ev.at !== "number") errs.push("at must be a number (ms).");
  if (!ev.data || typeof ev.data !== "object" || Array.isArray(ev.data)) errs.push("data must be an object.");
  if (spec && ev.data && typeof ev.data === "object") for (const k of spec.data) if (ev.data[k] === undefined) errs.push(`data.${k} is required for ${ev.type}.`);
  if (spec && ev.source && !spec.from.includes(ev.source)) errs.push(`${ev.type} is not sent by ${ev.source}.`);
  return errs;
}

export function createEco({ app, version = "0.0.0", port, dataDir = "", dir = null, api = "/api/eco", types = EVENT_TYPES, fetch: f = globalThis.fetch, onEvent = null } = {}) {
  if (!app) throw new Error("createEco needs the app's name");
  const folder = () => join(dir ?? ecoDir(), "apps");
  const own = () => join(folder(), `${app}.json`);
  let token = null;
  const getPort = () => (typeof port === "function" ? port() : port);
  const getVersion = () => (typeof version === "function" ? version() : version);

  const makeEvent = (type, data) => ({ v: SCHEMA, id: randomUUID(), type, source: app, at: Date.now(), data: data ?? {} });

  function writePresence(extra = {}) {
    token = randomBytes(24).toString("hex");
    mkdirSync(folder(), { recursive: true });
    const p = { app, version: getVersion(), port: getPort(), pid: process.pid, startedAt: Date.now(), token, api, schema: SCHEMA, dataDir, handoff: dataDir ? join(dataDir, "handoff.json") : null, ...extra };
    const tmp = own() + ".tmp"; writeFileSync(tmp, JSON.stringify(p, null, 2)); renameSync(tmp, own());
    return p;
  }
  // Remove our presence file (only if it's still ours: a newer copy of the app may have replaced it)
  function removePresence() { try { const cur = JSON.parse(readFileSync(own(), "utf8")); if (cur.pid === process.pid) rmSync(own(), { force: true }); } catch { /* gone */ } }
  function cleanupOnExit() {
    process.once("exit", removePresence);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => { removePresence(); process.exit(0); });
  }
  function readPresence(name) { try { return JSON.parse(readFileSync(join(folder(), `${name}.json`), "utf8")); } catch { return null; } }
  function peers() {
    if (!existsSync(folder())) return [];
    return readdirSync(folder()).filter((x) => x.endsWith(".json") && x !== `${app}.json`).map((x) => readPresence(x.replace(/\.json$/, ""))).filter(Boolean);
  }
  async function alive(p) {
    if (!p?.port) return false;
    try {
      const r = await f(`http://127.0.0.1:${p.port}${p.api || "/api/eco"}/hello`, { signal: AbortSignal.timeout(1200) });
      if (!r.ok) return false;
      const j = await r.json();
      return j?.app === p.app;
    } catch { return false; }
  }
  const cache = new Map();
  async function peer(name) {
    const p = readPresence(name);
    if (!p) return null;
    const c = cache.get(name);
    if (c && c.startedAt === p.startedAt && Date.now() - c.at < 30_000) return c.ok ? p : null;
    const ok = await alive(p);
    cache.set(name, { at: Date.now(), ok, startedAt: p.startedAt });
    return ok ? p : null;
  }
  // Send one event to every running peer (or just one). Never throws for delivery; throws for a malformed event.
  async function send(type, data, only = null) {
    const ev = makeEvent(type, data);
    const errs = validateEvent(ev, types);
    if (errs.length) throw new Error("Bad ecosystem event: " + errs.join(" "));
    const list = only ? [readPresence(only)].filter(Boolean) : peers();
    const delivered = [];
    for (const p of list) {
      if (!(await peer(p.app))) continue;
      try {
        const r = await f(`http://127.0.0.1:${p.port}${p.api || "/api/eco"}/event`, { method: "POST", headers: { "content-type": "application/json", "x-eco-token": p.token }, body: JSON.stringify(ev), signal: AbortSignal.timeout(2500) });
        delivered.push({ app: p.app, ok: r.ok });
      } catch { delivered.push({ app: p.app, ok: false }); }
    }
    return { event: ev, delivered };
  }
  // Call a peer's local API with its token: eco.call("lantern", "/api/local/status") · eco.call("lantern", "/api/local/open", { method: "POST", body: {...} })
  async function call(name, path, { method = "GET", body = undefined, timeoutMs = 4000 } = {}) {
    const p = await peer(name);
    if (!p) return { ok: false, status: 0, error: `${name} isn't running.` };
    try {
      const r = await f(`http://127.0.0.1:${p.port}${path}`, { method, headers: { "content-type": "application/json", "x-eco-token": p.token }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: j };
    } catch (e) { return { ok: false, status: 0, error: e.message }; }
  }

  // Called for EVERY request on the local server. null = fine, else { status, error }.
  function guard(req, { port: p = getPort(), allowOrigins = [] } = {}) {
    const host = String(req.headers.host ?? "").toLowerCase();
    const okHosts = [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
    if (!okHosts.includes(host)) return { status: 421, error: "This address isn't this app on this computer." };
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null") {
      const ok = [...okHosts.map((h) => `http://${h}`), ...allowOrigins].map((x) => x.toLowerCase());
      if (!ok.includes(String(origin).toLowerCase())) return { status: 403, error: "Requests from other websites aren't allowed." };
    } else if (origin === "null") return { status: 403, error: "Requests from other websites aren't allowed." };
    return null;
  }
  function tokenOk(req) {
    const t = req.headers["x-eco-token"] || String(req.headers.authorization ?? "").replace(/^Eco\s+/i, "");
    if (!token || !t) return false;
    const a = Buffer.from(String(t)), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  // An incoming event (already guarded and token-checked by the route): validate and pass on.
  function receive(ev) {
    const errs = validateEvent(ev, types);
    if (errs.length) return { ok: false, status: 400, errors: errs };
    if (ev.source === app) return { ok: false, status: 400, errors: ["An app can't send events to itself."] };
    try { onEvent?.(ev); } catch { /* the app's handler */ }
    return { ok: true };
  }
  // A small route handler both apps can mount: GET <api>/hello, POST <api>/event. Returns true when it answered.
  async function handle(req, res, { readJSON }) {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith(api)) return false;
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const g = guard(req);
    if (g) return send(g.status, { error: g.error }), true;
    if (url.pathname === `${api}/hello` && req.method === "GET") return send(200, { app, version: getVersion(), schema: SCHEMA }), true;
    if (url.pathname === `${api}/event` && req.method === "POST") {
      if (!tokenOk(req)) return send(401, { error: "The ecosystem token is missing or wrong." }), true;
      const ev = await readJSON(req).catch(() => null);
      const r = receive(ev);
      return send(r.ok ? 200 : r.status, r), true;
    }
    return false;
  }

  return { app, SCHEMA, EVENT_TYPES: types, folder, makeEvent, validateEvent: (ev) => validateEvent(ev, types), writePresence, removePresence, cleanupOnExit, readPresence, peers, alive, peer, send, call, guard, tokenOk, receive, handle, ownToken: () => token };
}
