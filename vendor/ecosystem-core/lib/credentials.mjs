// The AI key, shared between the apps on one computer, with the user's permission.
//
// Set up an AI in Dayspring and Lantern can ask "Use the AI key from Dayspring?" (and the other way round). The key
// lives in ONE file for this Windows user, encrypted with Windows' own per-user protection (DPAPI): another user of the
// computer, or a copy of the file on another computer, can't read it.
//
//   %LOCALAPPDATA%\Ecosystem\credentials.bin      (ECOSYSTEM_DIR overrides the folder; tests pass dir)
//   inside (after decryption): { v: 1, ai: { provider, model, keys: { anthropic, openai, xai, elevenlabs }, ollamaUrl },
//                                consent: { dayspring: true, lantern: false }, updatedAt, updatedBy }
//
//   const cred = createCredentials({ app: "lantern" });
//   cred.peek()                 → { exists, provider, model, hasKeys: { anthropic: true… }, consent, updatedBy, updatedAt }  (never a key)
//   cred.read()                 → the ai object, only if THIS app has consent (else null)
//   cred.write(ai)              → saves the shared AI settings; this app gets consent automatically
//   cred.allow(true|false)      → this app's consent (the "Use the AI key from Dayspring?" answer)
//   cred.clear()                → removes the file
//
// Rules: keys are never logged, never sent between the apps over HTTP, never put in course packs or synced anywhere.
// Error messages never contain the file's contents.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FILE_NAME = "credentials.bin";
const MAGIC = Buffer.from("ECO1");                   // file header: format version 1
export const KEY_NAMES = ["anthropic", "openai", "xai", "elevenlabs"];

export function ecoDir(env = process.env) {
  if (env.ECOSYSTEM_DIR) return env.ECOSYSTEM_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "Ecosystem");
  return join(homedir(), ".local", "share", "ecosystem");
}

// Windows DPAPI (CurrentUser scope) through PowerShell. The data goes through stdin/stdout as base64: it never appears
// on a command line (where other programs could see it), and the PowerShell window is hidden.
export function dpapi({ powershell = "powershell.exe", entropy = "ecosystem-credentials-v1" } = {}) {
  const script = (fn) => `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim();
$b=[Convert]::FromBase64String($in); $e=[Text.Encoding]::UTF8.GetBytes('${entropy}');
$o=[Security.Cryptography.ProtectedData]::${fn}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Convert]::ToBase64String($o))`;
  const call = (fn, buf) => {
    const r = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script(fn)], { input: buf.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 8 << 20 });
    if (r.status !== 0 || !r.stdout) throw new Error(fn === "Protect" ? "Windows couldn't protect the AI key." : "Windows couldn't unlock the saved AI key (it may belong to another user or computer).");
    return Buffer.from(r.stdout.trim(), "base64");
  };
  return { name: "dpapi", protect: (buf) => call("Protect", buf), unprotect: (buf) => call("Unprotect", buf) };
}
export function dpapiAvailable() {
  if (process.platform !== "win32") return false;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { windowsHide: true, timeout: 15_000 });
  return r.status === 0;
}

const clean = (ai = {}) => {
  const keys = {};
  for (const k of KEY_NAMES) if (typeof ai.keys?.[k] === "string" && ai.keys[k].trim()) keys[k] = ai.keys[k].trim();
  return { provider: String(ai.provider ?? "none").toLowerCase(), model: ai.model ? String(ai.model) : "", ollamaUrl: ai.ollamaUrl ? String(ai.ollamaUrl) : "", ttsProvider: ai.ttsProvider ? String(ai.ttsProvider) : "", keys };
};

export function createCredentials({ app, dir = null, crypto = null } = {}) {
  if (!app || !/^[a-z][a-z0-9-]{1,30}$/.test(app)) throw new Error("createCredentials needs the app's name");
  const folder = () => dir ?? ecoDir();
  const file = () => join(folder(), FILE_NAME);
  const box = crypto ?? dpapi();

  function load() {
    if (!existsSync(file())) return null;
    const raw = readFileSync(file());
    if (raw.length < 5 || !raw.subarray(0, 4).equals(MAGIC)) throw new Error("The shared AI settings file isn't one I recognise. You can clear it in Settings.");
    try { return JSON.parse(box.unprotect(raw.subarray(4)).toString("utf8")); }
    catch (e) { throw new Error(/unlock|recognise/.test(e.message) ? e.message : "The shared AI settings couldn't be read."); }
  }
  function store(obj) {
    mkdirSync(folder(), { recursive: true });
    const enc = Buffer.concat([MAGIC, box.protect(Buffer.from(JSON.stringify(obj), "utf8"))]);
    const tmp = file() + ".tmp";
    writeFileSync(tmp, enc, { mode: 0o600 });
    renameSync(tmp, file());                        // all or nothing: a crash mid-write never leaves half a file
  }

  function peek() {
    let s = null;
    try { s = load(); } catch (e) { return { exists: true, error: e.message }; }
    if (!s) return { exists: false };
    const ai = s.ai ?? {};
    return { exists: true, provider: ai.provider ?? "none", model: ai.model ?? "", ttsProvider: ai.ttsProvider ?? "", hasKeys: Object.fromEntries(KEY_NAMES.map((k) => [k, Boolean(ai.keys?.[k])])), consent: { ...(s.consent ?? {}) }, allowed: Boolean(s.consent?.[app]), updatedBy: s.updatedBy ?? null, updatedAt: s.updatedAt ?? null };
  }
  function read() {
    const s = load();
    if (!s || !s.consent?.[app]) return null;
    return clean(s.ai);
  }
  function write(ai, { keepOthers = true } = {}) {
    let s = null; try { s = load(); } catch { s = null; }
    const prev = clean(s?.ai ?? {});
    const next = clean(ai);
    if (keepOthers) next.keys = { ...prev.keys, ...next.keys };
    store({ v: 1, ai: next, consent: { ...(s?.consent ?? {}), [app]: true }, updatedAt: new Date().toISOString(), updatedBy: app });
    return peek();
  }
  function allow(on = true) {
    const s = load();
    if (!s) throw new Error("No AI has been set up in another app yet.");
    s.consent = { ...(s.consent ?? {}), [app]: Boolean(on) };
    store(s);
    return peek();
  }
  function clear() { rmSync(file(), { force: true }); return { exists: false }; }

  return { app, file, peek, read, write, allow, clear };
}

// A stand-in for tests (and non-Windows development): XOR with a fixed pad. NOT protection.
export function fakeCrypto() {
  const pad = Buffer.from("test-only-not-a-secret");
  const x = (buf) => Buffer.from(buf.map((b, i) => b ^ pad[i % pad.length]));
  return { name: "fake", protect: x, unprotect: x };
}
