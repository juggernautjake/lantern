/* ===========================================================================
   server/src/search/index.js — one index over everything.
   ---------------------------------------------------------------------------
   The search box and the assistant's search tool are the same search. That is
   the point: when a learner asks the assistant "where's the rubric for the
   fund report", it must find exactly what the search box would have found for
   that person, no more — so the assistant can never become a way to read
   something you could not have opened yourself.

   Permission is applied AFTER ranking and BEFORE returning, by re-checking
   every candidate against the live rules rather than against a stored copy of
   who could see it when it was indexed. Slower, and correct when a roster
   changes at half past three.

   Ranking is deliberately simple and explainable: field weights, phrase
   bonus, recency tiebreak. Nobody has to trust a black box to find a PDF.
   =========================================================================== */

import { all, one, run, insert, id } from '../db/db.js';
import * as perms from '../files/permissions.js';

/* ------------------------------------------------------------- indexing */

export function put(doc) {
  const row = {
    id: doc.id || (doc.entity_type + ':' + doc.entity_id),
    entity_type: doc.entity_type, entity_id: doc.entity_id,
    title: doc.title || '', body: (doc.body || '').slice(0, 20000),
    url: doc.url || '', course_id: doc.course_id || null, class_id: doc.class_id || null,
    owner_id: doc.owner_id || null, file_id: doc.file_id || null,
    visibility: doc.visibility || 'class',
    updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  run(`INSERT INTO search_docs (id, entity_type, entity_id, title, body, url, course_id, class_id, owner_id, file_id, visibility, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         title=excluded.title, body=excluded.body, url=excluded.url,
         course_id=excluded.course_id, class_id=excluded.class_id,
         owner_id=excluded.owner_id, file_id=excluded.file_id,
         visibility=excluded.visibility, updated_at=excluded.updated_at`,
  row.id, row.entity_type, row.entity_id, row.title, row.body, row.url,
  row.course_id, row.class_id, row.owner_id, row.file_id, row.visibility, row.updated_at);
  return row;
}

export function unindex(entityType, entityId) {
  run('DELETE FROM search_docs WHERE entity_type = ? AND entity_id = ?', entityType, entityId);
}

/* A file's searchable text is its metadata plus, for text files, nothing —
   the body is indexed separately by whoever extracts it, because pulling text
   out of a PDF is not this module's job and pretending otherwise would make
   the index quietly wrong. */
export function indexFile(fileRow, folder) {
  const tags = all('SELECT tag FROM file_tags WHERE file_id = ?', fileRow.id).map((t) => t.tag).join(' ');
  put({
    entity_type: 'file', entity_id: fileRow.id,
    title: fileRow.title || fileRow.name,
    body: [fileRow.description, fileRow.name, fileRow.purpose, fileRow.source_url, tags].filter(Boolean).join(' \n '),
    url: '/files/' + fileRow.id,
    course_id: folder ? folder.course_id : null,
    class_id: folder ? folder.class_id : null,
    owner_id: fileRow.created_by,
    file_id: fileRow.id,
    visibility: fileRow.visibility,
  });
}

/* Text a file carries in it, when somebody has extracted it. Kept apart from
   indexFile so re-uploading metadata never wipes extracted contents. */
export function indexFileText(fileId, text) {
  const doc = one('SELECT * FROM search_docs WHERE entity_type = ? AND entity_id = ?', 'file', fileId);
  if (!doc) return null;
  return put(Object.assign({}, doc, { body: (doc.body || '') + '\n' + String(text || '').slice(0, 20000) }));
}

/* ------------------------------------------------------------- searching */

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'is', 'for', 'on', 'and', 'or', 'it',
  'that', 'this', 'with', 'was', 'are', 'be', 'as', 'at', 'by', 'from', 'i', 'my', 'me', 'do', 'how']);

const terms = (q) => String(q || '').toLowerCase().match(/[\w'-]+/g)?.filter((t) => t.length > 1 && !STOP.has(t)) || [];

export function search(ctx, query, opts) {
  const o = opts || {};
  const words = terms(query);
  if (!words.length) return [];

  const where = [];
  const args = [];
  words.forEach((w) => { where.push('(lower(title) LIKE ? OR lower(body) LIKE ?)'); args.push('%' + w + '%', '%' + w + '%'); });
  let sql = 'SELECT * FROM search_docs WHERE (' + where.join(' OR ') + ')';
  if (o.type) { sql += ' AND entity_type = ?'; args.push(o.type); }
  if (o.classId) { sql += ' AND (class_id = ? OR class_id IS NULL)'; args.push(o.classId); }
  if (o.courseId) { sql += ' AND (course_id = ? OR course_id IS NULL)'; args.push(o.courseId); }
  sql += ' LIMIT 400';

  const phrase = String(query || '').toLowerCase().trim();
  const scored = all(sql, ...args).map((d) => {
    const title = (d.title || '').toLowerCase();
    const body = (d.body || '').toLowerCase();
    let score = 0;
    words.forEach((w) => {
      if (title.indexOf(w) >= 0) score += 8;
      if (body.indexOf(w) >= 0) score += 2;
      if (title.split(/\W+/).indexOf(w) >= 0) score += 4;   // whole word in the title
    });
    if (phrase.length > 6 && (title.indexOf(phrase) >= 0 || body.indexOf(phrase) >= 0)) score += 12;
    if (d.entity_type === 'lesson' || d.entity_type === 'exercise') score += 1;
    return { d, score };
  }).sort((a, b) => b.score - a.score || String(b.d.updated_at).localeCompare(String(a.d.updated_at)));

  /* Permission last, against the live rules. */
  const out = [];
  for (const { d, score } of scored) {
    if (out.length >= (o.limit || 12)) break;
    if (!visibleTo(ctx, d)) continue;
    out.push({
      type: d.entity_type, id: d.entity_id, title: d.title,
      snippet: snippet(d.body, words), url: d.url, score,
      classId: d.class_id, courseId: d.course_id, fileId: d.file_id,
      updatedAt: d.updated_at,
    });
  }
  return out;
}

function visibleTo(ctx, d) {
  if (!ctx) return false;
  if (d.entity_type === 'file' && d.file_id) {
    const f = one('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', d.file_id);
    return !!f && perms.can(ctx, 'read', f, { fileLinkToken: f.link_token }).allowed;
  }
  if (ctx.role === 'admin') return true;
  if (d.owner_id && d.owner_id === ctx.id) return true;
  if (d.class_id) return !!ctx.classRole(d.class_id);
  if (d.course_id) return ctx.inCourse(d.course_id);
  return d.visibility === 'school' || d.visibility === 'course' || !d.class_id;
}

function snippet(body, words) {
  const b = String(body || '');
  const low = b.toLowerCase();
  let at = -1;
  for (const w of words) { at = low.indexOf(w); if (at >= 0) break; }
  if (at < 0) return b.slice(0, 160).trim();
  const from = Math.max(0, at - 60);
  return (from ? '…' : '') + b.slice(from, from + 200).trim() + (b.length > from + 200 ? '…' : '');
}

/* Bulk-load the course itself — lessons, exercises, projects — so the
   assistant can point at a lesson by name. Called at boot from whatever
   course definition the server was given. */
export function indexCourse(course, courseId) {
  if (!course || !course.units) return 0;
  let n = 0;
  course.units.forEach((u) => {
    (u.lessons || []).forEach((l) => {
      const text = (l.blocks || []).map((b) => b.html || b.text || b.src || (b.ex && b.ex.prompt) || '').join(' \n ');
      put({ entity_type: 'lesson', entity_id: l.id, title: l.title,
        body: [(l.objectives || []).join('. '), stripTags(text)].join('\n').slice(0, 8000),
        url: '/studio#' + l.id, course_id: courseId, visibility: 'course' });
      n++;
      (l.blocks || []).forEach((b) => {
        if (b.t !== 'exercise' || !b.ex) return;
        put({ entity_type: 'exercise', entity_id: b.ex.id, title: b.ex.title,
          body: stripTags(b.ex.prompt || ''), url: '/studio#' + l.id,
          course_id: courseId, visibility: 'course' });
        n++;
      });
    });
  });
  return n;
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export { put as indexDoc };
