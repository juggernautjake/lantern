// Documents: open and understand files: Word (.docx and old .doc), PDF, PowerPoint, Excel/CSV, OpenDocument, RTF,
// plain text/markdown/HTML/email, and pictures of text (Windows' built-in OCR). Everything is read on this computer.
//
//   const docs = createDocuments({
//     guard: (path) => fullPath,        // REQUIRED: resolves a path and throws if the user hasn't allowed it
//     roots: () => ["C:\Users\<you>"],   // the folders the user allowed (for find())
//     canRead: (path) => true,          // optional: a quick yes/no for a folder while searching (default: guard doesn't throw)
//     isSecret: (path) => false,        // optional: extra secret-file rule (password stores, keys…); built-in rules always apply
//     progressFile: "…/docprogress.json",  // optional: where "where did I stop reading" is kept
//     require: createRequire(import.meta.url),  // optional: resolve the readers from the app's node_modules
//   })
//   docs.extract(path) · docs.outline(path) · docs.read(path, { from, n, section, page }) · docs.find(query)
//
// The readers are optional packages: mammoth (.docx), word-extractor (.doc), unpdf (.pdf), jszip (.pptx/.odt), xlsx
// (spreadsheets). A missing one gives a clear message instead of a crash.
import { readFile, stat, readdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const MAX_TEXT = 400_000;            // characters kept per document (a very long book is cut, and says so)
const MAX_ROWS = 400;                // spreadsheet rows per sheet
export const SECRET_DIR = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|1password|bitwarden|keepass|wallets?|electrum|exodus|metamask)([\\/]|$)/i;
export const SECRET_NAME = /(password|passwd|wallet|seed[-_ ]?phrase|recovery[-_ ]?(codes?|phrase)|private[-_ ]?key|\.kdbx$|login data|cookies$|^\.env$|credentials\.bin$)/i;
export const TYPES = {
  ".docx": "Word document", ".docm": "Word document", ".dotx": "Word template", ".doc": "Word document (older format)", ".rtf": "Rich Text document",
  ".odt": "OpenDocument text", ".odp": "OpenDocument presentation", ".ods": "OpenDocument spreadsheet",
  ".pdf": "PDF", ".pptx": "PowerPoint presentation", ".xlsx": "Excel spreadsheet", ".xlsm": "Excel spreadsheet", ".xls": "Excel spreadsheet (older format)", ".csv": "CSV table", ".tsv": "table",
  ".txt": "text file", ".md": "Markdown document", ".markdown": "Markdown document", ".json": "JSON file", ".html": "web page", ".htm": "web page", ".xml": "XML file", ".log": "log file", ".eml": "email",
  ".png": "picture", ".jpg": "picture", ".jpeg": "picture", ".bmp": "picture", ".gif": "picture", ".tif": "picture", ".tiff": "picture", ".webp": "picture",
};
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp"]);
export const supported = (p) => Boolean(TYPES[extname(String(p)).toLowerCase()]);
export const DENY = { files: "I haven't been given permission to open files yet. You can allow it in Settings → Permissions.", secret: "That looks like a password, key or wallet file, so I won't open it." };
const PACKAGES = { mammoth: ".docx files", "word-extractor": "older .doc files", unpdf: "PDF files", jszip: "PowerPoint and OpenDocument files", xlsx: "spreadsheets" };

export function createDocuments({ guard: guardFn, roots = () => [], canRead = null, isSecret = () => false, progressFile = null, require: req = createRequire(import.meta.url), powershell = "powershell" } = {}) {
  if (typeof guardFn !== "function") throw new Error("createDocuments needs guard(path)");
  const rootsOf = () => (typeof roots === "function" ? roots() : roots) ?? [];
  const need = (name) => { try { return req(name); } catch { throw new Error(`Reading ${PACKAGES[name] ?? name} needs the "${name}" package, which isn't installed.`); } };
  const needAsync = async (name) => { try { return await import(pathToFileURL(req.resolve(name)).href).catch(() => import(name)); } catch { throw new Error(`Reading ${PACKAGES[name] ?? name} needs the "${name}" package, which isn't installed.`); } };
  function guard(p) {
    const full = guardFn(p);
    if (isSecret(full) || SECRET_DIR.test(full) || SECRET_NAME.test(basename(full))) throw new Error(DENY.secret);
    return full;
  }
  canRead ??= (x) => { try { guardFn(x); return true; } catch { return false; } };
  // ---------------------------------------------------------------- helpers
  const decode = (s) => String(s).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  const stripTags = (s) => decode(String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();
  const run = (cmd, args, ms = 120_000) => new Promise((ok, fail) => execFile(cmd, args, { windowsHide: true, timeout: ms, maxBuffer: 64 << 20 }, (e, out, err) => (e ? fail(new Error(String(err || e.message).trim().slice(0, 300))) : ok(String(out)))));
  const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

  // Blocks ({ kind: "h"|"p"|"li"|"row", level?, text }) → sections + paragraphs
  function fromBlocks(blocks, title) {
    const sections = []; let cur = { heading: "", text: "" };
    const push = () => { if (cur.heading || cur.text.trim()) sections.push({ heading: cur.heading, text: cur.text.trim() }); };
    for (const b of blocks) {
      const t = b.text.trim(); if (!t) continue;
      if (b.kind === "h") { push(); cur = { heading: t, text: "" }; }
      else cur.text += (b.kind === "li" ? "• " : "") + t + "\n\n";
    }
    push();
    return finish({ title, sections });
  }
  // Plain text → sections: markdown "#" headings, or short standalone lines that look like titles
  function fromText(text, title, { markdown = false } = {}) {
    const blocks = [];
    let src = String(text).replace(/\r\n?/g, "\n").replace(/\u000c/g, "\n\n");
    // no blank lines at all (old Word files, OCR): every line is its own paragraph
    if (!/\n[ \t]*\n/.test(src)) src = src.replace(/\n/g, "\n\n");
    for (const chunk of src.split(/\n[ \t]*\n+/)) {
      const lines = chunk.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
      if (!lines.length) continue;
      if (markdown && /^#{1,6}\s/.test(lines[0])) { blocks.push({ kind: "h", text: lines[0].replace(/^#+\s*/, "") }); lines.shift(); if (!lines.length) continue; }
      // a list: one item per line
      if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) { for (const l of lines) blocks.push({ kind: "li", text: l.replace(/^\s*([-*•]|\d+[.)])\s+/, "") }); continue; }
      blocks.push({ kind: "p", text: lines.join(markdown ? " " : "\n").trim() });
    }
    return fromBlocks(blocks, title);
  }
  // Shared ending: flat text, word count, paragraphs for reading aloud (long ones split at sentences), the size cap
  function finish(doc) {
    let text = doc.sections.map((s) => (s.heading ? `${s.heading}\n\n` : "") + s.text).join("\n\n").trim();
    let truncated = false;
    if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
    const paras = [];
    let used = 0;
    doc.sections.forEach((s, si) => {
      if (used > MAX_TEXT) return;
      if (s.heading) paras.push({ text: s.heading, section: si, heading: true });
      for (const p of s.text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
        used += p.length; if (used > MAX_TEXT) { truncated = true; break; }
        if (p.length <= 700) { paras.push({ text: p, section: si }); continue; }
        let buf = "";
        for (const sent of p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p]) { if ((buf + sent).length > 600 && buf) { paras.push({ text: buf.trim(), section: si }); buf = ""; } buf += sent; }
        if (buf.trim()) paras.push({ text: buf.trim(), section: si });
      }
    });
    const words = (text.match(/\S+/g) ?? []).length;
    return { ...doc, text, paras, words, minutes: Math.max(1, Math.round(words / 160)), truncated: truncated || doc.truncated || false };
  }

  // ---------------------------------------------------------------- formats
  async function docx(full) {
    const mammoth = need("mammoth");
    const { value: html } = await mammoth.convertToHtml({ path: full });
    const blocks = [];
    for (const m of html.matchAll(/<(h[1-6]|p|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      if (m[1] === "tr") { const cells = [...m[2].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => stripTags(c[1]).replace(/\n+/g, " ")); blocks.push({ kind: "row", text: cells.join(" | ") }); }
      else blocks.push({ kind: m[1][0] === "h" ? "h" : m[1], text: stripTags(m[2]) });
    }
    const title = blocks.find((b) => b.kind === "h")?.text;
    return fromBlocks(blocks, title);
  }
  // old Word files: the pure-JS reader first; if it can't, Word itself (when installed) reads it
  async function doc(full) {
    try {
      const WordExtractor = need("word-extractor");
      const d = await new WordExtractor().extract(full);
      const body = d.getBody();
      if (body?.trim()) return fromText(body, undefined);
    } catch { /* fall through to Word */ }
    try { return fromText(await readWithWord(full), undefined); }
    catch (e) { throw new Error(`I couldn't read that older Word file (${e.message}). Saving it as .docx in Word would let me read it.`); }
  }
  // Microsoft Word itself (when installed), read-only and invisible
  async function readWithWord(full) {
    const ps = `$ErrorActionPreference='Stop'; $w = New-Object -ComObject Word.Application; $w.Visible=$false; $w.DisplayAlerts=0;
  try { $d = $w.Documents.Open(${psq(full)}, $false, $true, $false); $t = $d.Content.Text; $d.Close(0); [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $t } finally { $w.Quit() }`;
    return (await run(powershell, ["-NoProfile", "-Command", ps], 90_000)).replace(/\r/g, "\n");
  }
  async function pdf(full) {
    const { extractText, getDocumentProxy } = await needAsync("unpdf");
    const buf = new Uint8Array(await readFile(full));
    const proxy = await getDocumentProxy(buf);
    let title; try { title = (await proxy.getMetadata())?.info?.Title || undefined; } catch { /* none */ }
    const { text, totalPages } = await extractText(proxy, { mergePages: false });
    const sections = text.map((t, i) => ({ heading: totalPages > 1 ? `Page ${i + 1}` : "", text: String(t).replace(/[ \t]+\n/g, "\n").replace(/([^\n.!?:;])\n(?=[a-z])/g, "$1 ").replace(/\n{3,}/g, "\n\n").trim(), page: i + 1 }));
    const out = finish({ title, sections, pages: totalPages });
    if (!out.text.trim()) out.note = "This PDF has no text layer (it's probably scanned). Save a page as a picture and I can read it with OCR.";
    return out;
  }
  function rtf(src) {
    let s = String(src).replace(/\\par[d]?\b/g, "\n\n").replace(/\\line\b/g, "\n").replace(/\\tab\b/g, "\t");
    s = s.replace(/\{\\\*[^{}]*\}/g, "").replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\s*\}?/g, "");
    s = s.replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)));
    return s.replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }
  async function zipXml(full) { const JSZip = need("jszip"); return JSZip.loadAsync(await readFile(full)); }
  async function pptx(full) {
    const zip = await zipXml(full);
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
    const sections = [];
    for (const n of slides) {
      const i = Number(n.match(/(\d+)\.xml$/)[1]);
      const xml = await zip.file(n).async("string");
      const paras = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((p) => decode([...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")).trim()).filter(Boolean);
      const notesFile = zip.file(`ppt/notesSlides/notesSlide${i}.xml`);
      let notes = "";
      if (notesFile) notes = [...(await notesFile.async("string")).matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((p) => decode([...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")).trim()).filter((x) => x && !/^\d+$/.test(x)).join("\n\n");
      sections.push({ heading: `Slide ${i}${paras[0] ? ": " + paras[0] : ""}`, text: [...paras.slice(1), notes ? `Speaker notes: ${notes}` : ""].filter(Boolean).join("\n\n"), page: i });
    }
    return finish({ title: sections[0]?.heading.replace(/^Slide 1: /, ""), sections, pages: slides.length });
  }
  async function odf(full) {
    const zip = await zipXml(full);
    const xml = await zip.file("content.xml").async("string");
    const ext = extname(full).toLowerCase();
    if (ext === ".ods") return sheet(full);
    const blocks = [];
    for (const m of xml.matchAll(/<text:(h|p)\b[^>]*?(?:text:outline-level="(\d)")?[^>]*>([\s\S]*?)<\/text:\1>|<text:(h|p)\b[^>]*\/>/g)) {
      if (!m[1]) continue;
      const t = decode(m[3].replace(/<text:s\b[^>]*\/>/g, " ").replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n").replace(/<[^>]+>/g, "")).trim();
      blocks.push({ kind: m[1] === "h" ? "h" : "p", text: t });
    }
    return fromBlocks(blocks, blocks.find((b) => b.kind === "h")?.text);
  }
  async function sheet(full) {
    const XLSX = need("xlsx");
    const wb = XLSX.read(await readFile(full), { type: "buffer", cellDates: true, sheetRows: MAX_ROWS + 1 });
    const sections = [];
    let truncated = false;
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, blankrows: false, defval: "" });
      if (!rows.length) continue;
      if (rows.length > MAX_ROWS) truncated = true;
      const head = rows[0].map((h) => String(h).trim());
      const looksHeader = head.filter(Boolean).length >= Math.max(1, head.length / 2) && head.every((h) => !/^\d+([.,]\d+)?$/.test(h));
      const body = (looksHeader ? rows.slice(1) : rows).slice(0, MAX_ROWS).map((r, i) => looksHeader
        ? r.map((v, j) => (String(v).trim() ? `${head[j] || `Column ${j + 1}`}: ${String(v).trim()}` : "")).filter(Boolean).join("; ")
        : `Row ${i + 1}: ${r.map((v) => String(v).trim()).filter(Boolean).join(" | ")}`).filter(Boolean);
      sections.push({ heading: `Sheet "${name}" (${rows.length - (looksHeader ? 1 : 0)} row${rows.length === 2 ? "" : "s"}${looksHeader ? `; columns: ${head.filter(Boolean).join(", ")}` : ""})`, text: body.join("\n\n") });
    }
    const out = finish({ sections });
    if (truncated) { out.truncated = true; out.note = `Only the first ${MAX_ROWS} rows of each sheet are included.`; }
    return out;
  }
  function eml(src) {
    const [head, ...rest] = String(src).replace(/\r\n/g, "\n").split(/\n\n/);
    const h = (k) => (new RegExp(`^${k}:\\s*(.+(?:\\n[ \\t].+)*)`, "mi").exec(head)?.[1] ?? "").replace(/\n[ \t]+/g, " ").trim();
    let body = rest.join("\n\n");
    const plain = /content-type:\s*text\/plain[\s\S]*?\n\n([\s\S]*?)(?=\n--|$)/i.exec(body);
    if (plain) body = plain[1]; else if (/<html/i.test(body)) body = stripTags(body);
    body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
    return fromText(`From: ${h("From")}\nTo: ${h("To")}\nDate: ${h("Date")}\n\n${body}`, h("Subject") || undefined);
  }
  // Pictures of text: Windows' own OCR engine (Windows 10/11), run through PowerShell
  async function ocr(full) {
    const ps = `$ErrorActionPreference='Stop'
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $await = [WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select -First 1
  function Await($op, [Type]$t) { $task = $await.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
  [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime] | Out-Null
  $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync(${psq(full)})) ([Windows.Storage.StorageFile])
  $s = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $d = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $b = Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $e) { throw 'No OCR language is installed in Windows.' }
  $r = Await ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
  [Console]::OutputEncoding=[Text.Encoding]::UTF8
  $r.Lines | % { $_.Text }`;
    try {
      const out = (await run(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], 60_000)).trim();
      const d = fromText(out.split(/\r?\n/).join("\n"), undefined);
      if (!out) d.note = "I didn't find any readable text in that picture.";
      return d;
    } catch (e) { return finish({ sections: [], note: `I couldn't read text from that picture: ${e.message}` }); }
  }

  // ---------------------------------------------------------------- extract (cached by path + modified time)
  const cache = new Map();
  async function extract(p) {
    const full = guard(p);
    const st = await stat(full);
    if (st.isDirectory()) throw new Error("That's a folder, not a document.");
    const key = `${full}|${st.mtimeMs}|${st.size}`;
    if (cache.has(key)) return cache.get(key);
    const ext = extname(full).toLowerCase();
    if (!TYPES[ext]) throw new Error(`I can't read ${ext || "that kind of"} files yet. I can read Word, PDF, PowerPoint, Excel, CSV, OpenDocument, RTF, text, web pages, emails and pictures of text.`);
    if (st.size > 150 << 20) throw new Error("That file is over 150 MB, which is too big for me to read.");
    let d;
    if ([".docx", ".docm", ".dotx"].includes(ext)) d = await docx(full);
    else if (ext === ".doc") d = await doc(full);
    else if (ext === ".pdf") d = await pdf(full);
    else if (ext === ".pptx") d = await pptx(full);
    else if ([".xlsx", ".xlsm", ".xls", ".csv", ".tsv", ".ods"].includes(ext)) d = await sheet(full);
    else if ([".odt", ".odp"].includes(ext)) d = await odf(full);
    else if (ext === ".rtf") d = fromText(rtf(await readFile(full, "latin1")), undefined);
    else if (ext === ".eml") d = eml(await readFile(full, "utf8"));
    else if (IMAGE.has(ext)) d = await ocr(full);
    else {
      let src = await readFile(full, "utf8");
      if (src.length > MAX_TEXT * 2) src = src.slice(0, MAX_TEXT * 2);
      if ([".html", ".htm"].includes(ext)) { const t = /<title>([\s\S]*?)<\/title>/i.exec(src)?.[1]; src = stripTags(src.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<\/(p|div|h\d|li|tr|section|article)>/gi, "\n\n")); d = fromText(src, t ? decode(t) : undefined); }
      else if (ext === ".xml") d = fromText(stripTags(src.replace(/>\s*</g, ">\n<")), undefined);
      else d = fromText(src, undefined, { markdown: [".md", ".markdown"].includes(ext) });
    }
    const out = { ...d, path: full, name: basename(full), type: TYPES[ext], ext, modified: st.mtime.toISOString(), size: st.size, title: (d.title || basename(full, ext)).slice(0, 200) };
    cache.set(key, out); if (cache.size > 30) cache.delete(cache.keys().next().value);
    return out;
  }

  // ---------------------------------------------------------------- outline and reading
  async function outline(p) {
    const d = await extract(p);
    return { path: d.path, name: d.name, title: d.title, type: d.type, pages: d.pages ?? null, words: d.words, minutes: d.minutes, paragraphs: d.paras.length, truncated: d.truncated, note: d.note,
      modified: d.modified, sections: d.sections.map((s, i) => ({ n: i + 1, heading: s.heading || (i === 0 ? "(start)" : `Part ${i + 1}`), words: (s.text.match(/\S+/g) ?? []).length, page: s.page ?? null })),
      start: d.text.slice(0, 3000) };
  }
  // paragraphs from `from` (0-based), or a whole section (1-based) or page (1-based)
  async function read(p, { from = 0, n = 25, section = null, page = null } = {}) {
    const d = await extract(p);
    let start = Math.max(0, Number(from) || 0);
    if (section) { const si = Number(section) - 1; const i = d.paras.findIndex((x) => x.section === si); if (i >= 0) start = i; }
    if (page) { const si = d.sections.findIndex((s) => s.page === Number(page)); const i = d.paras.findIndex((x) => x.section === si); if (i >= 0) start = i; }
    const count = Math.max(1, Math.min(200, Number(n) || 25));
    const paras = d.paras.slice(start, start + count).map((x, k) => ({ i: start + k, text: x.text, heading: Boolean(x.heading), section: x.section + 1 }));
    return { path: d.path, title: d.title, type: d.type, from: start, to: start + paras.length - 1, total: d.paras.length, done: start + paras.length >= d.paras.length, paras,
      sections: d.sections.map((s, i) => ({ n: i + 1, heading: s.heading, first: d.paras.findIndex((x) => x.section === i) })) };
  }

  // ---------------------------------------------------------------- finding a document by how the owner describes it
  const STOP = new Set("a an the my me i to of in on at for and or please can you could would open read show find pull up bring get give let see look that this those file files doc docs document documents one thing called named about from with it i'd like want need is was".split(" "));
  const EXT_HINTS = [[/\b(word|docx?|word doc)\b/, [".docx", ".doc", ".docm", ".rtf", ".odt"]], [/\bpdfs?\b/, [".pdf"]], [/\b(powerpoint|slides?|presentation|deck|pptx?)\b/, [".pptx", ".odp"]],
    [/\b(excel|spreadsheet|sheet|xlsx?|csv|workbook)\b/, [".xlsx", ".xls", ".xlsm", ".csv", ".ods"]], [/\b(picture|photo|screenshot|image|scan)\b/, [...IMAGE]], [/\b(email|e-mail|eml)\b/, [".eml"]], [/\b(text file|notes?|txt)\b/, [".txt", ".md"]]];
  const PLACES = [[/\bdownloads?\b/, "Downloads"], [/\bdesktop\b/, "Desktop"], [/\bdocuments folder\b|\bin (my )?documents\b/, "Documents"], [/\bone ?drive\b/, "OneDrive"]];
  function recencyWindow(q) {
    const day = 86_400_000;
    if (/\btoday\b|\bthis morning\b/.test(q)) return 1 * day;
    if (/\byesterday\b/.test(q)) return 2.2 * day;
    if (/\b(this|last) week\b|\bthe other day\b|\brecent(ly)?\b|\blatest\b|\bnewest\b|\bjust (saved|downloaded|edited)\b/.test(q)) return 8 * day;
    if (/\blast month\b|\bthis month\b/.test(q)) return 32 * day;
    return null;
  }
  async function find(query, { limit = 8, under = null } = {}) {
    const q = String(query ?? "").toLowerCase().replace(/[“”"']/g, "").trim();
    const roots = rootsOf();
    if (!roots.length) throw new Error(DENY.files);
    const exts = EXT_HINTS.find(([re]) => re.test(q))?.[1] ?? null;
    const place = PLACES.find(([re]) => re.test(q))?.[1] ?? null;
    const within = recencyWindow(q);
    const words = q.replace(/\b(yesterday|today|this morning|last|this|week|month|recent(ly)?|latest|newest|edited|saved|downloaded|modified|made|wrote|in|downloads?|desktop|one ?drive|documents? folder)\b/g, " ")
      .replace(/\b(word|docx?|pdfs?|powerpoint|slides?|presentation|deck|pptx?|excel|spreadsheet|xlsx?|csv|workbook|picture|photo|screenshot|image|scan|email|txt|text)\b/g, " ")
      .split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
    // where to look, likeliest first: Downloads, Documents, Desktop, OneDrive, then the rest of the allowed folders
    // every person folder among the allowed ones (the owner's files may live in another profile than Windows' own)
    const people = [homedir(), ...roots].filter((r, i, a) => a.findIndex((y) => y.toLowerCase() === r.toLowerCase()) === i);
    const prefer = people.flatMap((h) => ["Downloads", "Documents", "Desktop", "OneDrive", "OneDrive\\Documents", "OneDrive\\Desktop"].map((x) => join(h, x))).filter(existsSync);
    const starts = (under ? [guard(under)] : [...(place ? prefer.filter((x) => x.toLowerCase().includes(place.toLowerCase())) : []), ...prefer, ...roots])
      .filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i)
      .filter((x) => canRead(x));
    const hits = new Map(), t0 = Date.now(), seen = new Set();
    const SKIP = /^(node_modules|\.git|appdata|\$recycle\.bin|windows|program files|program files \(x86\)|programdata|\.cache|__pycache__|backups?|\.next|dist|build|\.venv|venv|site-packages)$/i;
    async function walk(dir, depth) {
      if (depth > 7 || Date.now() - t0 > 12_000 || seen.has(dir.toLowerCase())) return;
      seen.add(dir.toLowerCase());
      let ents; try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.test(e.name) && !e.name.startsWith(".") && !SECRET_DIR.test(p)) await walk(p, depth + 1); continue; }
        const ext = extname(e.name).toLowerCase();
        if (!TYPES[ext] || (exts && !exts.includes(ext)) || isSecret(p) || SECRET_DIR.test(p) || SECRET_NAME.test(e.name) || e.name.startsWith("~$")) continue;
        const name = e.name.toLowerCase().replace(/[_\-.]+/g, " ");
        const matched = words.filter((w) => name.includes(w)).length;
        if (words.length && !matched) continue;
        if (!words.length && !within && !exts) continue;
        let st; try { st = await stat(p); } catch { continue; }
        const age = Date.now() - st.mtimeMs;
        if (within && age > within) continue;
        let score = matched * 10 + (words.length && matched === words.length ? 8 : 0) + (exts ? 3 : 0) + (place && p.toLowerCase().includes(place.toLowerCase()) ? 5 : 0);
        score += Math.max(0, 6 - Math.log10(1 + age / 3_600_000) * 2);      // newer counts a little
        if (/\bdocuments?\b|\bdownloads?\b|\bdesktop\b/i.test(p)) score += 1;
        const prev = hits.get(p.toLowerCase());
        if (!prev || prev.score < score) hits.set(p.toLowerCase(), { path: p, name: e.name, type: TYPES[ext], modified: st.mtime.toISOString(), score: Math.round(score * 10) / 10 });
      }
    }
    // the likely folders first; a clear match there (every word in the name) ends the search, otherwise look further
    const clear = () => [...hits.values()].some((h) => words.length && words.every((w) => h.name.toLowerCase().replace(/[_\-.]+/g, " ").includes(w)));
    for (const s of starts) {
      if (Date.now() - t0 > 12_000) break;
      const likely = prefer.some((x) => x.toLowerCase() === s.toLowerCase());
      if (!likely && !under && clear()) break;
      await walk(s, 0);
    }
    const matches = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    const ambiguous = matches.length > 1 && matches[0].score - matches[1].score < 3;
    return { query: String(query), words, matches, best: matches[0] ?? null, ambiguous, searchedFor: { words, types: exts, place, withinDays: within ? Math.round(within / 86_400_000) : null } };
  }

  // ---------------------------------------------------------------- where the owner stopped reading each document
  const PROG = progressFile;
  const progAll = () => { try { return PROG && existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {}; } catch { return {}; } };
  function progress(p) { return progAll()[String(p).toLowerCase()] ?? null; }
  function setProgress(p, para, extra = {}) {
    const all = progAll(); all[String(p).toLowerCase()] = { path: p, para: Math.max(0, Number(para) || 0), at: Date.now(), ...extra };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 50);
    if (!PROG) return;
    try { writeFileSync(PROG, JSON.stringify(Object.fromEntries(keys.map((k) => [k, all[k]])), null, 1)); } catch { /* not critical */ }
  }
  function lastRead() { return Object.values(progAll()).sort((a, b) => b.at - a.at)[0] ?? null; }
  return { guard, readWithWord, extract, outline, read, find, progress, setProgress, lastRead, TYPES, supported };
}
