/* ===========================================================================
   server/src/files/extract.js — getting the words out of a file.
   ---------------------------------------------------------------------------
   A filing system whose search only sees filenames is a filing system where
   the rubric nobody titled properly is lost forever. So the contents of a file
   are pulled out and indexed when the file arrives.

   Written without a dependency, which is possible because the two formats that
   matter here are less closed than they look:

     DOCX, XLSX, PPTX  are ZIP archives of XML. Node's own zlib does the
                       inflating; the rest is reading the central directory and
                       stripping tags.
     PDF               is a container of streams, most of them Flate-compressed,
                       with text drawn by a handful of operators inside BT/ET
                       blocks.

   Honesty about the PDF extractor, because a silent half-answer is worse than
   a stated limit: it reads text drawn with the ordinary operators from fonts
   with a usable encoding. A PDF whose fonts are subset with a custom CMap, or
   one that is a scan with no text layer at all, will come back with little or
   nothing — and it says so, via `confidence`, rather than pretending. That is
   enough to make a document findable by the words in it, and it is not a
   replacement for a real PDF library if this ever needs to be exact.
   =========================================================================== */

import { inflateRawSync, inflateSync } from 'node:zlib';

/* What is worth trying to read at all. */
export function extractable(mime, name) {
  const n = String(name || '').toLowerCase();
  // A picture is described by its metadata, never by its contents. This is
  // checked first because an SVG's MIME type contains "xml" and would
  // otherwise put a hundred kilobytes of path data into the search index.
  if (/^image\//.test(mime || '') || /\.(svg|png|jpe?g|gif|webp|avif|ico)$/.test(n)) return false;
  return /^text\//.test(mime || '') ||
    /json|xml|sql|javascript|csv/.test(mime || '') ||
    /\.(docx|xlsx|pptx|pdf|txt|md|csv|tsv|json|xml|html?|sql|cfm|cfc|js|css)$/.test(n);
}

/* Returns { text, kind, confidence, note } or null when nothing could be read.
   Never throws: an unreadable file is a file with no extracted text, not a
   failed upload. */
export function extract(buf, mime, name) {
  const n = String(name || '').toLowerCase();
  try {
    if (/\.(docx|xlsx|pptx)$/.test(n)) return fromOfficeZip(buf, n);
    if (/\.pdf$/.test(n) || mime === 'application/pdf') return fromPdf(buf);
    if (/\.html?$/.test(n) || /text\/html/.test(mime || '')) {
      return { text: stripHtml(buf.toString('utf8')), kind: 'html', confidence: 'high' };
    }
    if (extractable(mime, name)) {
      const text = buf.toString('utf8');
      // A binary file with a text-ish extension shows up as replacement
      // characters; do not index a page of those.
      if (/�/.test(text.slice(0, 2000))) return null;
      return { text, kind: 'text', confidence: 'high' };
    }
  } catch (e) {
    return { text: '', kind: 'unreadable', confidence: 'none', note: e.message };
  }
  return null;
}

/* ------------------------------------------------------------------- zip --- */

/* The central directory, as { name -> buffer }. Only entries whose names are
   asked for are inflated, because a spreadsheet can hold hundreds. */
export function unzip(buf, wanted) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = {};

  for (let i = 0; i < count && at + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const entry = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    if (wanted && !wanted(entry)) continue;
    if (buf.readUInt32LE(localAt) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    out[entry] = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
  }
  return out;
}

function findEOCD(buf) {
  // The end-of-central-directory record is at the end, after a comment of up
  // to 64 KB, so scan backwards rather than assuming it is the last 22 bytes.
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

const OFFICE_PARTS = {
  docx: (n) => n === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(n),
  xlsx: (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  pptx: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n),
};

function fromOfficeZip(buf, name) {
  const kind = /\.docx$/.test(name) ? 'docx' : /\.xlsx$/.test(name) ? 'xlsx' : 'pptx';
  const want = OFFICE_PARTS[kind];
  const parts = unzip(buf, want);
  const names = Object.keys(parts).sort();
  if (!names.length) return { text: '', kind, confidence: 'none', note: 'no readable parts' };

  const text = names.map((n) => xmlText(parts[n].toString('utf8'), kind)).join('\n').trim();
  return { text, kind, confidence: text.length > 20 ? 'high' : 'low' };
}

/* Office XML puts runs of text in <w:t>, <a:t> or <t> depending on the format.
   Paragraph and row boundaries have to survive, or every word runs together. */
function xmlText(xml, kind) {
  let s = xml;
  s = s.replace(/<(w:p|a:p|row|w:tr)\b[^>]*>/g, '\n');
  s = s.replace(/<(w:tab|w:br)\b[^>]*\/?>/g, ' ');
  s = s.replace(/<\/(c|w:tc)>/g, '\t');
  const bits = [];
  const re = kind === 'xlsx' ? /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g : /<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>/g;
  let m;
  let last = 0;
  while ((m = re.exec(s))) {
    const between = s.slice(last, m.index);
    if (/\n/.test(between)) bits.push('\n');
    else if (/\t/.test(between)) bits.push('\t');
    bits.push(decodeXml(m[1]));
    last = re.lastIndex;
  }
  return bits.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

/* ------------------------------------------------------------------- pdf --- */

function fromPdf(buf) {
  const streams = pdfStreams(buf);
  if (!streams.length) {
    return { text: '', kind: 'pdf', confidence: 'none',
      note: 'no readable content streams — this may be a scan with no text layer' };
  }
  const pieces = [];
  streams.forEach((s) => { const t = pdfTextFromStream(s); if (t.trim()) pieces.push(t); });
  const text = pieces.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // A subset-encoded PDF yields mostly punctuation and single letters, so the
  // test is not length but whether what came out reads like prose: how many
  // real words there are, and what proportion of the characters are letters.
  // A short memo that extracted cleanly should not be labelled doubtful just
  // for being short.
  const words = (text.match(/[A-Za-z]{3,}/g) || []).length;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const printable = (text.match(/\S/g) || []).length || 1;
  const prose = letters / printable > 0.55;
  return {
    text, kind: 'pdf',
    confidence: (words > 40 || (words >= 5 && prose)) ? 'high' : words >= 5 ? 'low' : 'none',
    note: words >= 5 ? undefined
      : 'the text could not be recovered — the fonts are probably subset, or this is a scan',
  };
}

/* Every stream in the file, inflated where it is Flate-encoded. */
function pdfStreams(buf) {
  const out = [];
  const s = buf.toString('latin1');
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const dictStart = Math.max(0, s.lastIndexOf('<<', m.index));
    const dict = s.slice(dictStart, m.index);
    const raw = Buffer.from(s.slice(start, end), 'latin1');
    re.lastIndex = end;
    if (/\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dict)) continue;
    try {
      if (/\/FlateDecode/.test(dict)) {
        out.push(tryInflate(raw).toString('latin1'));
      } else if (!/\/Filter/.test(dict)) {
        out.push(raw.toString('latin1'));
      }
    } catch (e) { /* a stream that will not inflate is a stream we skip */ }
    if (out.length > 400) break;
  }
  return out;
}

function tryInflate(raw) {
  try { return inflateSync(raw); } catch (e) { return inflateRawSync(raw); }
}

/* Text-showing operators: (str) Tj, [(a) -20 (b)] TJ, (str) ' and (str) ".
   Td/TD/T* move the cursor, and are treated as line breaks so that lines do
   not run together. */
function pdfTextFromStream(s) {
  const out = [];
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[Jj]\b|\bT[dD]\b|\bT\*|\bTD\b|'|"/g;
  let pending = [];
  let m;
  while ((m = re.exec(s))) {
    const tok = m[0];
    if (tok[0] === '(') { pending.push(pdfString(tok.slice(1, -1))); continue; }
    if (tok[0] === '<') { pending.push(pdfHexString(tok.slice(1, -1))); continue; }
    if (tok === 'TJ' || tok === 'Tj' || tok === "'" || tok === '"') {
      if (pending.length) out.push(pending.join(''));
      pending = [];
      if (tok === "'" || tok === '"') out.push('\n');
      continue;
    }
    // a positioning operator ends the line
    if (pending.length) { out.push(pending.join('')); pending = []; }
    out.push('\n');
  }
  if (pending.length) out.push(pending.join(''));
  return out.join('').replace(/\n{2,}/g, '\n');
}

function pdfString(s) {
  return s.replace(/\\(\d{1,3}|.)/g, (m, c) => {
    if (/^\d+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return { n: '\n', r: '\n', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c] !== undefined
      ? { n: '\n', r: '\n', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c] : c;
  });
}

function pdfHexString(s) {
  const hex = s.replace(/\s+/g, '');
  let out = '';
  // Two-byte codes are the common case for subset fonts and rarely decode to
  // anything meaningful; one-byte codes usually do.
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code >= 32 && code < 127) out += String.fromCharCode(code);
  }
  return out;
}

/* ------------------------------------------------------------------ html --- */

export function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => decodeXml(e))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
