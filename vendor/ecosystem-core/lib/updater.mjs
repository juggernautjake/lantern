// Updates from GitHub releases, for any of the apps. The release's download has a FIXED name (Dayspring.zip,
// Lantern.zip), so …/releases/latest/download/<name> always gets the newest version.
//
//   const up = createUpdater({
//     app: "Lantern",                          // shown in messages
//     root,                                    // the program folder (what gets replaced)
//     dataDir,                                 // the user's data (never replaced; backed up before every update)
//     repo: () => "owner/name",                // "" = updates off
//     assetName: "Lantern.zip",
//     entry: "server.mjs",                     // a file every real release has at its root
//     identify: (pkg) => pkg.name === "lantern",   // is this download really this app?
//     keep: ["data", ".env", "node_modules", "backups", "updates", "logs", "bin"],   // never replaced or removed
//     backupFiles: [".env"],                   // extra files in root copied with each data backup
//   })
//   up.check() · up.stage() · up.install({ restart }) · up.rollback(backup) · up.choose("now"|"launch"|"idle"|"later")
//   up.confirmStarted() · up.history() · up.startAuto({ notify, announce, busy, restart })
//
// install(): back up the data → move the old program files aside (a quick rename, so it can be undone) → move the new
// ones in → install packages only if package.json's dependencies changed → restart → the new version calls
// confirmStarted(); if it never does, the launcher calls rollback() and the old version comes back.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// "v1.2.10" → [1,2,10]; pre-release tags ("1.3.0-beta.1") sort before the release
export function cmp(a, b) {
  const parse = (v) => { const [core, pre] = String(v).trim().replace(/^v/i, "").split("-", 2); return { n: core.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? null }; };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.n.length, B.n.length, 3); i++) { const d = (A.n[i] ?? 0) - (B.n[i] ?? 0); if (d) return Math.sign(d); }
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : 1;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const defaultTar = () => { const t = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"); return existsSync(t) ? t : "tar"; };
const depsOf = (p) => { try { const j = JSON.parse(readFileSync(p, "utf8")); return JSON.stringify({ d: j.dependencies ?? {}, o: j.optionalDependencies ?? {} }); } catch { return ""; } };
const WHEN = ["ask", "launch", "idle"];

export function createUpdater({
  app = "App", root, dataDir, backupsDir = null, updatesDir = null, stateFile = null,
  repo = () => "", assetName = null, entry = "server.mjs", identify = () => true,
  keep = ["data", ".env", "node_modules", "backups", ".git", "dist-out", "bin", "updates", "logs"], backupFiles = [".env"],
  api = () => "https://api.github.com", fetch: f = globalThis.fetch, keepBackups = 5, tar = defaultTar,
  installDeps = (dir) => spawnSync("cmd.exe", ["/d", "/s", "/c", "npm install --omit=dev --no-audit --no-fund"], { cwd: dir, windowsHide: true, encoding: "utf8", timeout: 600_000 }).status === 0,
  userAgent = null,
} = {}) {
  if (!root) throw new Error("createUpdater needs the program folder (root)");
  const KEEP = new Set(keep);
  const BACKUPS = backupsDir ?? join(root, "backups"), UPDATES = updatesDir ?? join(root, "updates");
  const DATA = dataDir ?? join(root, "data");
  const STATE = stateFile ?? join(DATA, "updates.json");
  const UA = userAgent ?? `${app}-updater`;
  const R = () => String(typeof repo === "function" ? repo() : repo).trim();
  const API = () => String(typeof api === "function" ? api() : api).replace(/\/$/, "");
  const pkg = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = () => pkg().version ?? "0.0.0";

  // ---- saved plan and history -------------------------------------------------------------------------------------
  function load() { try { return { when: "ask", history: [], ...JSON.parse(readFileSync(STATE, "utf8")) }; } catch { return { when: "ask", history: [] }; } }
  function save(s) { mkdirSync(DATA, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); return s; }
  const patchState = (p) => save({ ...load(), ...p });
  const when = () => (WHEN.includes(load().when) ? load().when : "ask");
  function setWhen(w) { if (!WHEN.includes(w)) throw new Error("choose ask, launch or idle"); patchState({ when: w }); return w; }
  const history = () => (load().history ?? []).slice(-30).reverse();
  function addHistory(e) { const s = load(); s.history = [...(s.history ?? []), { at: new Date().toISOString(), ...e }].slice(-50); save(s); }
  function updateLastHistory(p) { const s = load(); const h = s.history ?? []; if (h.length) Object.assign(h[h.length - 1], p); save(s); }

  let state = { phase: "idle", message: "", at: null, latest: null, error: null };
  let onChange = null;
  const set = (p) => { state = { ...state, ...p, at: new Date().toISOString() }; onChange?.(status()); return state; };
  const onStatus = (fn) => { onChange = fn; };
  function status() {
    const s = load(), L = state.latest ?? s.latest ?? null;
    const latest = L ? { ...L, current: version(), available: cmp(L.latest, version()) > 0 } : null;
    return { ...state, latest, version: version(), repo: R() || null, when: when(), staged: s.staged ?? null, plan: s.plan ?? null, lastCheck: s.lastCheck ?? null, pendingVerify: s.pendingVerify ?? null };
  }

  async function gh(path) {
    const r = await f(`${API()}${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) throw new Error(`I couldn't find any ${app} updates at ${R()}.`);
    if (r.status === 403) throw new Error("GitHub is limiting requests right now. Try again in an hour.");
    if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
    return r.json();
  }

  async function check() {
    const rp = R();
    if (!rp) { set({ phase: "idle", message: `Automatic updates aren't set up for this copy of ${app}.`, error: null }); return { off: true, current: version(), message: state.message }; }
    if (!/^[\w.-]+\/[\w.-]+$/.test(rp)) throw new Error(`"${rp}" doesn't look like an update address (owner/name).`);
    set({ phase: "checking", message: "Checking for updates…", error: null });
    try {
      const rel = await gh(`/repos/${rp}/releases/latest`);
      const latest = String(rel.tag_name ?? "").replace(/^v/i, "");
      const zips = (rel.assets ?? []).filter((a) => /\.zip$/i.test(a.name ?? ""));
      const asset = (assetName && zips.find((a) => a.name.toLowerCase() === assetName.toLowerCase())) ?? zips[0];
      const out = { available: cmp(latest, version()) > 0, current: version(), latest, name: rel.name || `${app} ${latest}`, notes: String(rel.body ?? "").slice(0, 8000), url: rel.html_url ?? null, zip: asset?.browser_download_url ?? null, digest: asset?.digest ?? null, size: asset?.size ?? null, published: rel.published_at ?? null };
      patchState({ lastCheck: new Date().toISOString(), latest: out });
      set({ phase: "idle", latest: out, message: out.available ? `${app} ${latest} is available (you have ${version()}).` : `You're up to date (${version()}).` });
      return out;
    } catch (e) { set({ phase: "error", error: e.message, message: e.message }); throw e; }
  }

  function findRoot(dir, depth = 0) {
    if (existsSync(join(dir, entry)) && existsSync(join(dir, "package.json"))) return dir;
    if (depth > 2) return null;
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { const r = findRoot(join(dir, e.name), depth + 1); if (r) return r; }
    return null;
  }

  // Download and unpack into updates/<version>. Nothing in the running program changes.
  async function stage(info) {
    info ??= await check();
    if (info.off) throw new Error(info.message);
    if (!info.available) return null;
    const have = load().staged;
    if (have?.version === info.latest && existsSync(join(have.dir, entry))) return have;
    if (!info.zip) throw new Error("That release has no download attached.");
    set({ phase: "downloading", message: `Downloading ${app} ${info.latest}…`, error: null });
    const dir = join(UPDATES, info.latest);
    try {
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      const r = await f(info.zip, { headers: { "user-agent": UA, accept: "application/octet-stream" }, redirect: "follow", signal: AbortSignal.timeout(300_000) });
      if (!r.ok) throw new Error(`The download failed (${r.status}).`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (info.size && buf.length !== info.size) throw new Error("The download was incomplete. I'll try again later.");
      const m = /^sha256:([a-f0-9]{64})$/i.exec(info.digest ?? "");
      if (m && createHash("sha256").update(buf).digest("hex") !== m[1].toLowerCase()) throw new Error("The download didn't match GitHub's checksum, so I didn't use it.");
      const zip = join(dir, "release.zip");
      writeFileSync(zip, buf);
      const x = join(dir, "x"); mkdirSync(x);
      const t = spawnSync(typeof tar === "function" ? tar() : tar, ["-xf", zip, "-C", x], { windowsHide: true, encoding: "utf8" });
      if (t.status !== 0) throw new Error("The download couldn't be unpacked: " + (t.stderr || "").trim().slice(0, 200));
      const found = findRoot(x);
      if (!found) throw new Error(`That download doesn't look like ${app}.`);
      const p = JSON.parse(readFileSync(join(found, "package.json"), "utf8"));
      if (!identify(p)) throw new Error(`That download isn't ${app}.`);
      if (cmp(p.version, version()) <= 0) throw new Error(`That download is version ${p.version}, which isn't newer than yours.`);
      for (const k of KEEP) rmSync(join(found, k), { recursive: true, force: true });   // a release never brings data, keys or packages
      rmSync(zip, { force: true });
      const staged = { version: p.version, name: info.name, notes: info.notes, url: info.url, dir: found, at: new Date().toISOString() };
      patchState({ staged });
      set({ phase: "idle", message: `${app} ${p.version} is downloaded and ready to install.` });
      return staged;
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      set({ phase: "error", error: e.message, message: e.message });
      throw e;
    }
  }

  // ---- backups --------------------------------------------------------------------------------------------------------
  function prune(prefix) {
    if (!existsSync(BACKUPS)) return;
    const all = readdirSync(BACKUPS).filter((d) => d.startsWith(prefix)).map((d) => ({ d, t: statSync(join(BACKUPS, d)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { d } of all.slice(keepBackups)) rmSync(join(BACKUPS, d), { recursive: true, force: true });
  }
  function backupData(tag = version()) {
    const dir = join(BACKUPS, `data-${tag}-${stamp()}`);
    mkdirSync(dir, { recursive: true });
    if (existsSync(DATA)) cpSync(DATA, join(dir, "data"), { recursive: true, filter: (src) => !/[\\/](logs|backups|updates)([\\/]|$)/.test(src.slice(DATA.length)) });
    for (const fl of backupFiles) if (existsSync(join(root, fl))) cpSync(join(root, fl), join(dir, fl));
    prune("data-");
    return dir;
  }
  const programEntries = (dir) => readdirSync(dir).filter((e) => !KEEP.has(e));
  function moveAll(from, to, names) { mkdirSync(to, { recursive: true }); const moved = []; for (const e of names) { renameSync(join(from, e), join(to, e)); moved.push(e); } return moved; }

  function rollback(codeBackup, { reason = "" } = {}) {
    if (!codeBackup || !existsSync(codeBackup)) throw new Error("There's no backup to go back to.");
    const failed = join(BACKUPS, `failed-${version()}-${stamp()}`);
    moveAll(root, failed, programEntries(root));
    moveAll(codeBackup, root, readdirSync(codeBackup));
    rmSync(codeBackup, { recursive: true, force: true });
    const s = load(); delete s.pendingVerify; save(s);
    updateLastHistory({ ok: false, error: reason || "The new version didn't start, so the previous one was put back." });
    return { restored: version() };
  }

  let busyInstall = false;
  async function install({ restart = null, how = "now" } = {}) {
    if (busyInstall) throw new Error("An update is already being installed.");
    busyInstall = true;
    try {
      let staged = load().staged;
      if (!staged || !existsSync(join(staged.dir ?? "", entry))) staged = await stage();
      if (!staged) return { updated: false, message: state.message || `You're up to date (${version()}).` };
      const from = version(), to = staged.version;
      set({ phase: "applying", message: "Backing up your data…", error: null });
      const dataBackup = backupData(from);
      set({ message: `Installing ${app} ${to}…` });
      const codeBackup = join(BACKUPS, `code-${from}-${stamp()}`);
      const depsBefore = depsOf(join(root, "package.json"));
      let movedOld = [], movedNew = [];
      try {
        movedOld = moveAll(root, codeBackup, programEntries(root));
        movedNew = moveAll(staged.dir, root, programEntries(staged.dir));
      } catch (e) {
        for (const n of movedNew) try { renameSync(join(root, n), join(staged.dir, n)); } catch { /* keep going */ }
        for (const n of movedOld) try { renameSync(join(codeBackup, n), join(root, n)); } catch { /* keep going */ }
        throw new Error(`The update couldn't replace ${app}'s files (${e.code ?? e.message}). Nothing was changed; try again after restarting the computer.`);
      }
      const depsAfter = depsOf(join(root, "package.json"));
      const hasDeps = /"d":\{"|"o":\{"/.test(depsAfter);
      if (depsAfter !== depsBefore || (hasDeps && !existsSync(join(root, "node_modules")))) {
        set({ message: "Installing new parts…" });
        if (!installDeps(root)) {
          rollback(codeBackup, { reason: "New parts couldn't be downloaded." });
          installDeps(root);
          throw new Error(`${app} ${to} needs new parts, and they couldn't be downloaded. Your version was kept. Check the internet connection and try again.`);
        }
      }
      rmSync(UPDATES, { recursive: true, force: true });
      const s = load(); delete s.staged; delete s.plan; s.pendingVerify = { from, to, backup: codeBackup, dataBackup, at: new Date().toISOString() }; save(s);
      addHistory({ from, to, ok: null, how, name: staged.name, notes: staged.notes, dataBackup });
      prune("code-"); prune("failed-");
      set({ phase: "restarting", message: `Updated to ${to}. Restarting…`, latest: null });
      if (restart) setTimeout(() => restart({ verify: true }), 1500);
      return { updated: true, from, to, backup: codeBackup, dataBackup, message: state.message };
    } catch (e) {
      set({ phase: "error", error: e.message, message: e.message });
      throw e;
    } finally { busyInstall = false; }
  }

  // The new version, once it's running: the update worked.
  function confirmStarted() {
    const s = load(); const pv = s.pendingVerify;
    if (!pv || pv.to !== version()) return null;
    delete s.pendingVerify; save(s);
    updateLastHistory({ ok: true, confirmedAt: new Date().toISOString() });
    return pv;
  }
  // The launcher, if the new version didn't confirm within a minute: put the old one back.
  function rollbackIfUnconfirmed({ olderThanMs = 60_000 } = {}) {
    const pv = load().pendingVerify;
    if (!pv || Date.now() - Date.parse(pv.at) < olderThanMs) return null;
    return rollback(pv.backup, { reason: `${app} ${pv.to} didn't start, so ${pv.from} was put back.` });
  }

  async function choose(choice, { restart } = {}) {
    const known = status().latest;
    const info = known?.available ? known : await check();
    if (info.off) throw new Error(info.message);
    if (!info.available) return { ok: true, message: `You're up to date (${version()}).` };
    if (choice === "later") { patchState({ plan: { version: info.latest, when: "later" } }); return { ok: true, message: "Okay. It's in Settings → Updates whenever you want it." }; }
    if (choice === "now") return install({ restart, how: "now" });
    if (!["launch", "idle"].includes(choice)) throw new Error("choose now, launch, idle or later");
    const staged = await stage(info);
    patchState({ plan: { version: staged?.version ?? info.latest, when: choice } });
    return { ok: true, staged: Boolean(staged), message: choice === "launch" ? `${app} ${info.latest} is downloaded. It will install the next time ${app} starts.` : `${app} ${info.latest} is downloaded. It will install when you're not using ${app}.` };
  }
  const installAtLaunch = () => { const s = load(); return Boolean(s.staged && existsSync(join(s.staged.dir ?? "", entry)) && (["launch", "idle"].includes(s.plan?.when) || ["launch", "idle"].includes(when()))); };

  let lastActivity = Date.now();
  const touch = () => { lastActivity = Date.now(); };
  const idleMinutes = () => (Date.now() - lastActivity) / 60_000;
  let timers = [];
  function startAuto({ announce, notify, busy = () => false, restart, idleAfter = 30, firstMs = 60_000, everyMs = 6 * 3600_000, idleTickMs = 5 * 60_000 } = {}) {
    if (timers.length || !R()) return;
    const run = async () => {
      try {
        const info = await check();
        if (!info.available) return;
        const s = load(), mode = s.plan?.version === info.latest ? s.plan.when : when();
        if (mode === "later") return;
        if (mode === "launch" || mode === "idle") { await stage(info).catch(() => {}); if (mode === "launch") return; }
        if (mode === "ask" && s.told !== info.latest) { patchState({ told: info.latest }); notify?.({ ...info, when: mode }); announce?.(`There's a new version of ${app}: ${info.latest}. You can see what's new and choose when to install it.`, info); }
        else if (mode === "ask") notify?.({ ...info, when: mode, quiet: true });
      } catch { /* offline or rate-limited: try again later */ }
    };
    const idleTry = async () => {
      const s = load(), mode = s.plan?.when ?? when();
      if (mode !== "idle" || !s.staged || busyInstall) return;
      if (idleMinutes() < idleAfter || busy()) return;
      await install({ restart, how: "idle" }).catch(() => {});
    };
    timers.push(setTimeout(run, firstMs), setInterval(run, everyMs), setInterval(idleTry, idleTickMs));
    for (const t of timers) t.unref?.();
  }
  function stopAuto() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

  function backups() {
    if (!existsSync(BACKUPS)) return [];
    return readdirSync(BACKUPS).filter((d) => d.startsWith("code-") || d.startsWith("data-")).map((d) => ({ name: d, kind: d.startsWith("code-") ? "program" : "data", at: statSync(join(BACKUPS, d)).mtime.toISOString() })).sort((a, b) => b.at.localeCompare(a.at));
  }

  return { version, repo: R, when, setWhen, history, status, onStatus, check, stage, backupData, rollback, rollbackIfUnconfirmed, install, confirmStarted, choose, installAtLaunch, touch, idleMinutes, startAuto, stopAuto, backups, cmp, KEEP };
}
