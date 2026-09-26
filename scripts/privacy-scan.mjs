#!/usr/bin/env node
/* ===========================================================================
   scripts/privacy-scan.mjs — nothing private leaves in the public repo.
   ---------------------------------------------------------------------------
       node scripts/privacy-scan.mjs [folder] [--terms <file>]

   Fails (exit 1) when the folder holds:
     - anything that looks like a secret: API keys, a Supabase service-role
       key or any JWT, a GitHub token, a private key
     - a personal email address, a phone number, a path into a Windows user
       folder, a real Supabase project address
     - any word from the PRIVATE terms list: <data folder>/privacy-terms.json
       { "terms": [phrases, matched anywhere, any case], "words": [single
       words, matched whole and case-sensitive] } — kept in the owner's own
       data folder, so the list itself never ships
     - course content (the public repo holds the platform only)
   Used by export.mjs and release.mjs; they stop when it fails.
   =========================================================================== */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(fileURLToPath(import.meta.url), '..');
export const DEFAULT_TARGET = resolve(HERE, '..', '..', 'lantern-app');

const PATTERNS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/],
  ['xAI key', /\bxai-[A-Za-z0-9]{24,}/],
  ['Google key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['a JWT (Supabase key?)', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a real Supabase project address', /https:\/\/(?!xxxx|your-project|example)[a-z0-9]{20}\.supabase\.co/],
  ['personal email address', /\b[A-Za-z0-9._%+-]+@(?:gmail|yahoo|outlook|hotmail|icloud|live|aol|proton|protonmail)\.(?:com|me)\b/i],
  ['phone number', /(?<![\w.-])\+1\d{10}\b|\(\d{3}\)\s?\d{3}-\d{4}\b|\b\d{3}-\d{3}-\d{4}\b/],
  ['user folder path', /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!Public|Default|<|\$|%|you|YOU|Name|name|USERNAME|\.\.\.)[A-Za-z][^\\/"'`\s]*/],
];
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.txt', '.cmd', '.bat', '.ps1', '.sql', '.example', '.yml', '.yaml', '.svg', '.lpack', '']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'dist-out']);

export function termsFile() {
  if (process.env.LANTERN_PRIVACY_TERMS_FILE) return process.env.LANTERN_PRIVACY_TERMS_FILE;
  const base = process.env.LANTERN_DATA || (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Lantern') : join(process.env.HOME || '.', '.local', 'share', 'lantern'));
  return join(base, 'privacy-terms.json');
}

export function loadTerms(file) {
  const f = file || termsFile();
  let j = {};
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { /* none */ }
  const extra = String(process.env.LANTERN_PRIVACY_TERMS || '').split(';').map((s) => s.trim()).filter(Boolean);
  return { terms: (j.terms || []).concat(extra).filter((t) => String(t).length >= 3), words: (j.words || []).filter(Boolean), file: f, found: existsSync(f) };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(join(dir, e.name));
    else if (e.isFile()) yield join(dir, e.name);
  }
}

export function scan(target, opts) {
  const o = opts || {};
  const T = o.terms || loadTerms(o.termsFile);
  const rx = [
    ...T.terms.map((t) => ['private term', new RegExp(esc(t), 'i')]),
    ...T.words.map((w) => ['private word', new RegExp('(?<![A-Za-z0-9])' + esc(w) + '(?![A-Za-z0-9])')]),
  ];
  const hits = [];
  for (const f of walk(target)) {
    const rel = relative(target, f).replace(/\\/g, '/');
    if (/\.lpack$/i.test(rel) || /^courses\/(?!_template\/)/.test(rel) || /^app\/cfml\//.test(rel)) hits.push({ file: rel, line: 0, what: 'course content does not belong in the public repo', text: rel });
    for (const [what, r] of rx) if (r.test(rel)) hits.push({ file: rel, line: 0, what: what + ' in a file name', text: rel });
    if (!TEXT.has(extname(f).toLowerCase()) || statSync(f).size > 8000000) continue;
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const [what, r] of PATTERNS) if (r.test(line)) { hits.push({ file: rel, line: i + 1, what, text: line.trim().replace(r, (m) => m.slice(0, 6) + '…').slice(0, 160) }); return; }
      for (const [what, r] of rx) if (r.test(line)) { hits.push({ file: rel, line: i + 1, what, text: '(a private term; see the terms file)' }); return; }
    });
  }
  return { hits, terms: T };
}

export function report(result, target) {
  const { hits, terms } = result;
  if (!terms.found) console.log('Privacy scan: note — no private terms list at ' + terms.file + ' (only the built-in checks ran).');
  if (!hits.length) { console.log('Privacy scan: clean (' + (terms.terms.length + terms.words.length) + ' private terms checked).'); return true; }
  console.log('Privacy scan FAILED: ' + hits.length + ' problem' + (hits.length === 1 ? '' : 's') + ' in ' + target + ':');
  hits.slice(0, 60).forEach((h) => console.log('  ' + h.file + (h.line ? ':' + h.line : '') + '  [' + h.what + ']  ' + h.text));
  return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const ti = a.indexOf('--terms');
  const target = resolve(a.find((x, i) => !x.startsWith('--') && (ti < 0 || i !== ti + 1)) || DEFAULT_TARGET);
  if (!existsSync(target)) { console.error('Nothing to scan: ' + target + ' does not exist.'); process.exit(2); }
  process.exit(report(scan(target, { termsFile: ti >= 0 ? a[ti + 1] : undefined }), target) ? 0 : 1);
}
