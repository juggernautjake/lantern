/* ===========================================================================
   server/src/files/files.js — the filing system's public surface.
   ---------------------------------------------------------------------------
   Everything that puts a file into the platform, or takes one out, comes
   through here, and every one of these functions takes the actor as its first
   argument. There is no "internal" path that skips the permission check,
   because the way a filing system leaks is that somebody adds one.

   Three rules the API enforces rather than documents:

     1  Metadata is not optional. A file arrives with a purpose and a source
        or it does not arrive. "What is this and where did it come from" is
        answerable for every byte in the system, including the ones the
        assistant fetched off the web at two in the morning.

     2  Nothing is destroyed. delete() sets deleted_at. The blob stays until a
        sweep proves no version of any file still points at it.

     3  Every read of a file is recorded. Not every list — that would be noise
        — but every time bytes leave the system, with who and when.
   =========================================================================== */

import { all, one, run, insert, update, tx, id, json } from '../db/db.js';
import * as paths from './paths.js';
import * as perms from './permissions.js';
import { store } from './store.js';
import { indexFile, indexFileText, unindex } from '../search/index.js';
import { extract, extractable } from './extract.js';

export class Denied extends Error {
  constructor(decision) {
    super(decision.reason || 'Not permitted.');
    this.name = 'Denied';
    this.decision = decision;
    this.status = 403;
  }
}
export class NotFound extends Error {
  constructor(what) { super(what || 'Not found.'); this.name = 'NotFound'; this.status = 404; }
}
export class BadInput extends Error {
  constructor(what) { super(what); this.name = 'BadInput'; this.status = 400; }
}

const PURPOSES = ['brief', 'resource', 'reading', 'dataset', 'starter-code', 'solution', 'rubric',
  'submission', 'feedback', 'transcript', 'image', 'export', 'reference', 'recording', 'template', 'other'];
const SOURCES = ['upload', 'generated', 'ai-fetched', 'ai-generated', 'imported', 'system'];

function audit(action, res, actorId, detail) {
  insert('file_audit', {
    file_id: res.fileId || null, folder_id: res.folderId || null,
    actor_id: actorId || null, action, detail: detail || '',
  });
}

/* ---------------------------------------------------------------- folders */

export function folderByPath(path) {
  return one('SELECT * FROM folders WHERE path = ?', path) || null;
}
export function folderById(fid) {
  return one('SELECT * FROM folders WHERE id = ?', fid) || null;
}

/* Create a folder and every folder above it. Idempotent: the platform calls
   this whenever it needs somewhere to put something, and calling it twice is
   not an error. */
export function ensureFolder(spec) {
  const path = spec.path;
  if (!path || path[0] !== '/') throw new BadInput('A folder path must start with /.');
  const existing = folderByPath(path);
  if (existing) return existing;

  const parentPath = paths.parentOf(path);
  const parent = parentPath ? ensureFolder({ path: parentPath, kind: kindForPath(parentPath), system: true }) : null;
  const d = paths.describe(path);
  const row = {
    id: id('fld'),
    parent_id: parent ? parent.id : null,
    name: paths.nameOf(path),
    path,
    kind: spec.kind || kindForPath(path),
    course_id: spec.courseId || d.courseId || null,
    class_id: spec.classId || d.classId || null,
    assignment_id: spec.assignmentId || d.assignmentId || null,
    subject_user_id: spec.subjectUserId || d.userId || null,
    owner_id: spec.ownerId || null,
    system: spec.system === undefined ? 1 : (spec.system ? 1 : 0),
  };
  insert('folders', row);
  return folderByPath(path);
}

function kindForPath(path) {
  const d = paths.describe(path);
  if (d.kind !== 'unknown') return d.kind;
  return 'root';
}

/* The structure a class needs the moment it exists. Called on class creation
   and on assignment creation, so nobody ever has to make a folder by hand. */
export function scaffoldClass(classRow) {
  ensureFolder({ path: paths.classResources(classRow.id), kind: 'class-resources', classId: classRow.id, courseId: classRow.course_id });
  ensureFolder({ path: paths.classAssignments(classRow.id), kind: 'root', classId: classRow.id });
  ensureFolder({ path: paths.courseResources(classRow.course_id), kind: 'course-resources', courseId: classRow.course_id });
}

export function scaffoldAssignment(assignment) {
  ensureFolder({ path: paths.assignmentBrief(assignment.class_id, assignment.id), kind: 'assignment-brief', classId: assignment.class_id, assignmentId: assignment.id });
  ensureFolder({ path: paths.assignmentSubmissions(assignment.class_id, assignment.id), kind: 'submissions', classId: assignment.class_id, assignmentId: assignment.id });
}

export function scaffoldPerson(userId) {
  ensureFolder({ path: paths.personPrivate(userId), kind: 'personal', subjectUserId: userId, ownerId: userId });
  ensureFolder({ path: paths.personPortfolio(userId), kind: 'portfolio', subjectUserId: userId, ownerId: userId });
}

/* ------------------------------------------------------------------- put */

/* Put bytes into the system.

     ctx       the actor, from permissions.context()
     spec      { path | folderId, name, data, purpose, source, title,
                 description, sourceUrl, visibility, tags, courseIds,
                 classIds, links, meta }

   Returns the file row. If a file of that name already exists in that folder,
   this writes a new VERSION of it rather than a second file — which is what
   somebody re-uploading a corrected worksheet means, and never what a second
   row with the same name means. */
export async function put(ctx, spec) {
  const s = spec || {};
  if (!s.data) throw new BadInput('There are no contents to store.');
  if (PURPOSES.indexOf(s.purpose) < 0) {
    throw new BadInput('A file needs a purpose, one of: ' + PURPOSES.join(', ') + '.');
  }
  if (SOURCES.indexOf(s.source) < 0) {
    throw new BadInput('A file needs a source, one of: ' + SOURCES.join(', ') + '.');
  }
  const folder = s.folderId ? folderById(s.folderId) : folderByPath(s.path);
  if (!folder) throw new NotFound('No such folder: ' + (s.path || s.folderId));

  const decision = perms.can(ctx, 'write', folder);
  if (!decision.allowed) { audit('denied', { folderId: folder.id }, ctx && ctx.id, 'write: ' + decision.reason); throw new Denied(decision); }

  const data = Buffer.isBuffer(s.data) ? s.data : Buffer.from(String(s.data), 'utf8');
  if (data.length > maxBytes()) throw new BadInput('That file is larger than the ' + (maxBytes() / 1048576) + ' MB limit.');
  const name = paths.safeName(s.name || 'file');
  const blob = await store().put(data);

  const prior = one(
    `SELECT * FROM files WHERE folder_id = ? AND name = ? AND deleted_at IS NULL
      ORDER BY version DESC LIMIT 1`, folder.id, name);

  return tx(() => {
    if (prior) {
      // A re-upload of identical bytes is not a new version; say so rather
      // than filling the history with noise.
      if (prior.sha256 === blob.sha256) { audit('upload', { fileId: prior.id, folderId: folder.id }, ctx.id, 'unchanged'); return get(ctx, prior.id); }
      const version = prior.version + 1;
      insert('file_versions', {
        id: id('ver'), file_id: prior.id, version: prior.version, sha256: prior.sha256,
        storage_key: prior.storage_key, size: prior.size, created_by: prior.created_by,
        note: s.versionNote || '',
      });
      update('files', prior.id, {
        sha256: blob.sha256, storage_key: blob.key, size: data.length, version,
        mime: s.mime || paths.mimeFor(name),
        title: s.title !== undefined ? s.title : prior.title,
        description: s.description !== undefined ? s.description : prior.description,
        updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
      applyFacets(prior.id, s);
      audit('update', { fileId: prior.id, folderId: folder.id }, ctx.id, 'version ' + version);
      const row = one('SELECT * FROM files WHERE id = ?', prior.id);
      indexFile(row, folder);
      indexContents(row, data);
      return decorate(row, folder);
    }

    const fid = id('fil');
    insert('files', {
      id: fid, folder_id: folder.id, name, ext: paths.extOf(name),
      mime: s.mime || paths.mimeFor(name), size: data.length,
      sha256: blob.sha256, storage_key: blob.key, version: 1,
      purpose: s.purpose, source: s.source, source_url: s.sourceUrl || '',
      visibility: s.visibility || 'inherit',
      link_token: s.visibility === 'link' ? id('lnk') : null,
      title: s.title || name, description: s.description || '',
      meta_json: JSON.stringify(s.meta || {}),
      created_by: ctx.id,
    });
    applyFacets(fid, s);
    audit('upload', { fileId: fid, folderId: folder.id }, ctx.id, name);
    const row = one('SELECT * FROM files WHERE id = ?', fid);
    indexFile(row, folder);
    indexContents(row, data);
    return decorate(row, folder);
  });
}

const maxBytes = () => Number(process.env.LANTERN_MAX_UPLOAD || 50 * 1024 * 1024);

/* Pull the words out of a file and add them to what search can see, so a
   rubric nobody titled properly is still findable by what is in it. A file
   whose text cannot be recovered is indexed by its metadata alone and the
   reason is recorded on the row — silence here would look like a search bug
   for the rest of the file's life. */
function indexContents(row, data) {
  if (!extractable(row.mime, row.name)) return;
  if (data.length > Number(process.env.LANTERN_MAX_EXTRACT || 12 * 1024 * 1024)) return;
  let got;
  try { got = extract(data, row.mime, row.name); } catch (e) { got = null; }
  if (!got) return;
  const meta = json(row.meta_json, {}) || {};
  meta.extraction = { kind: got.kind, confidence: got.confidence, chars: (got.text || '').length,
    note: got.note };
  update('files', row.id, { meta_json: JSON.stringify(meta) });
  if (got.text && got.confidence !== 'none') indexFileText(row.id, got.text);
}

function applyFacets(fileId, s) {
  (s.courseIds || []).forEach((c) => run('INSERT OR IGNORE INTO file_courses (file_id, course_id) VALUES (?,?)', fileId, c));
  (s.classIds || []).forEach((c) => run('INSERT OR IGNORE INTO file_classes (file_id, class_id) VALUES (?,?)', fileId, c));
  (s.tags || []).forEach((t) => run('INSERT OR IGNORE INTO file_tags (file_id, tag) VALUES (?,?)', fileId, String(t).toLowerCase().trim()));
  (s.links || []).forEach((l) => {
    if (!l || !l.type || !l.id) return;
    run('INSERT OR IGNORE INTO file_links (id, file_id, entity_type, entity_id, relation) VALUES (?,?,?,?,?)',
      id('lnk'), fileId, l.type, l.id, l.relation || 'attachment');
  });
}

/* ------------------------------------------------------------------- get */

export function get(ctx, fileId) {
  const row = one('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', fileId);
  if (!row) throw new NotFound('No such file.');
  const folder = folderById(row.folder_id);
  const decision = perms.can(ctx, 'read', row, { fileLinkToken: row.link_token });
  if (!decision.allowed) { audit('denied', { fileId, folderId: row.folder_id }, ctx && ctx.id, 'read: ' + decision.reason); throw new Denied(decision); }
  return decorate(row, folder, decision);
}

/* The bytes. Separate from get() because reading metadata and taking a copy
   of the contents are different acts, and only one of them is worth logging
   every time. */
export async function read(ctx, fileId) {
  const meta = get(ctx, fileId);
  const buf = await store().get(meta.storage_key);
  if (!buf) throw new NotFound('The contents of that file are missing from storage.');
  audit('download', { fileId, folderId: meta.folder_id }, ctx && ctx.id, meta.name);
  return { meta, data: buf };
}

/* ------------------------------------------------------------------ list */

export function list(ctx, spec) {
  const s = spec || {};
  const folder = s.folderId ? folderById(s.folderId) : (s.path ? folderByPath(s.path) : null);
  if (!folder) throw new NotFound('No such folder.');
  const decision = perms.can(ctx, 'read', folder);
  if (!decision.allowed) throw new Denied(decision);

  const rows = all('SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY name', folder.id);
  const visible = rows.filter((r) => perms.can(ctx, 'read', r, { fileLinkToken: r.link_token }).allowed);
  const subfolders = all('SELECT * FROM folders WHERE parent_id = ? ORDER BY name', folder.id)
    .filter((f) => perms.can(ctx, 'read', f).allowed);

  return {
    folder: { id: folder.id, path: folder.path, name: folder.name, kind: folder.kind,
      audience: perms.describeAudience(folder) },
    folders: subfolders.map((f) => ({ id: f.id, name: f.name, path: f.path, kind: f.kind })),
    files: visible.map((r) => decorate(r, folder)),
  };
}

/* Everything this actor can reach, filtered. The one call a file browser and
   the agent's file search both use. */
export function find(ctx, q) {
  const s = q || {};
  const where = ['f.deleted_at IS NULL'];
  const args = [];
  if (s.purpose) { where.push('f.purpose = ?'); args.push(s.purpose); }
  if (s.source) { where.push('f.source = ?'); args.push(s.source); }
  if (s.mimePrefix) { where.push('f.mime LIKE ?'); args.push(s.mimePrefix + '%'); }
  if (s.owner) { where.push('f.created_by = ?'); args.push(s.owner); }
  if (s.text) {
    where.push('(f.name LIKE ? OR f.title LIKE ? OR f.description LIKE ?)');
    const like = '%' + s.text + '%'; args.push(like, like, like);
  }
  let sql = `SELECT f.*, d.path AS folder_path FROM files f JOIN folders d ON d.id = f.folder_id`;
  if (s.tag) { sql += ' JOIN file_tags t ON t.file_id = f.id'; where.push('t.tag = ?'); args.push(String(s.tag).toLowerCase()); }
  if (s.courseId) { sql += ' LEFT JOIN file_courses fc ON fc.file_id = f.id'; where.push('(fc.course_id = ? OR d.course_id = ?)'); args.push(s.courseId, s.courseId); }
  if (s.classId) { where.push('d.class_id = ?'); args.push(s.classId); }
  if (s.pathPrefix) { where.push('d.path LIKE ?'); args.push(s.pathPrefix + '%'); }
  sql += ' WHERE ' + where.join(' AND ') + ' ORDER BY f.updated_at DESC LIMIT ' + Math.min(Number(s.limit) || 50, 200);

  const rows = all(sql, ...args);
  const out = [];
  for (const r of rows) {
    if (perms.can(ctx, 'read', r, { fileLinkToken: r.link_token }).allowed) out.push(decorate(r, { path: r.folder_path }));
  }
  return out;
}

/* Everything attached to one platform object. */
export function forEntity(ctx, type, entityId) {
  const rows = all(
    `SELECT f.*, l.relation FROM file_links l JOIN files f ON f.id = l.file_id
      WHERE l.entity_type = ? AND l.entity_id = ? AND f.deleted_at IS NULL`, type, entityId);
  return rows.filter((r) => perms.can(ctx, 'read', r, { fileLinkToken: r.link_token }).allowed)
    .map((r) => Object.assign(decorate(r, folderById(r.folder_id)), { relation: r.relation }));
}

/* ---------------------------------------------------------------- change */

export function updateMeta(ctx, fileId, patch) {
  const row = one('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', fileId);
  if (!row) throw new NotFound('No such file.');
  const decision = perms.can(ctx, 'write', row);
  if (!decision.allowed) throw new Denied(decision);
  const p = patch || {};
  if (p.purpose && PURPOSES.indexOf(p.purpose) < 0) throw new BadInput('Unknown purpose "' + p.purpose + '".');
  update('files', fileId, {
    title: p.title, description: p.description, purpose: p.purpose,
    visibility: p.visibility,
    link_token: p.visibility === 'link' ? (row.link_token || id('lnk')) : (p.visibility ? null : undefined),
    meta_json: p.meta ? JSON.stringify(p.meta) : undefined,
    updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  applyFacets(fileId, p);
  audit('update', { fileId, folderId: row.folder_id }, ctx.id, Object.keys(p).join(','));
  const fresh = one('SELECT * FROM files WHERE id = ?', fileId);
  indexFile(fresh, folderById(fresh.folder_id));
  return decorate(fresh, folderById(fresh.folder_id));
}

export function remove(ctx, fileId, reason) {
  const row = one('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', fileId);
  if (!row) throw new NotFound('No such file.');
  const decision = perms.can(ctx, 'delete', row);
  if (!decision.allowed) throw new Denied(decision);
  update('files', fileId, { deleted_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
  unindex('file', fileId);
  audit('delete', { fileId, folderId: row.folder_id }, ctx.id, reason || '');
  return true;
}

export function restore(ctx, fileId) {
  const row = one('SELECT * FROM files WHERE id = ?', fileId);
  if (!row) throw new NotFound('No such file.');
  const decision = perms.can(ctx, 'write', row);
  if (!decision.allowed) throw new Denied(decision);
  update('files', fileId, { deleted_at: null });
  audit('restore', { fileId, folderId: row.folder_id }, ctx.id, '');
  return get(ctx, fileId);
}

export function versions(ctx, fileId) {
  get(ctx, fileId);   // the permission check
  const row = one('SELECT * FROM files WHERE id = ?', fileId);
  const past = all('SELECT * FROM file_versions WHERE file_id = ? ORDER BY version DESC', fileId);
  return [{ version: row.version, sha256: row.sha256, size: row.size, created_at: row.updated_at, current: true }]
    .concat(past.map((v) => ({ version: v.version, sha256: v.sha256, size: v.size, created_at: v.created_at, note: v.note, current: false })));
}

/* ----------------------------------------------------------------- share */

export function share(ctx, spec) {
  const s = spec || {};
  const target = s.fileId
    ? one('SELECT * FROM files WHERE id = ?', s.fileId)
    : one('SELECT * FROM folders WHERE id = ?', s.folderId);
  if (!target) throw new NotFound('Nothing to share.');
  const decision = perms.can(ctx, 'share', target);
  if (!decision.allowed) throw new Denied(decision);
  if (perms.ACTIONS.indexOf(s.permission) < 0) throw new BadInput('Unknown permission "' + s.permission + '".');

  const row = {
    id: id('acl'),
    file_id: s.fileId || null, folder_id: s.folderId || null,
    principal_type: s.principalType, principal_id: s.principalId || '',
    permission: s.permission, effect: s.effect || 'allow',
    granted_by: ctx.id, expires_at: s.expiresAt || null, reason: s.reason || '',
  };
  insert('acl', row);
  audit('share', { fileId: s.fileId, folderId: s.folderId }, ctx.id,
    s.effect === 'deny' ? 'deny ' : 'allow ' + s.permission + ' to ' + s.principalType + ':' + s.principalId);
  return row;
}

export function unshare(ctx, aclId) {
  const g = one('SELECT * FROM acl WHERE id = ?', aclId);
  if (!g) throw new NotFound('No such grant.');
  const target = g.file_id ? one('SELECT * FROM files WHERE id = ?', g.file_id)
    : one('SELECT * FROM folders WHERE id = ?', g.folder_id);
  const decision = perms.can(ctx, 'share', target);
  if (!decision.allowed) throw new Denied(decision);
  run('DELETE FROM acl WHERE id = ?', aclId);
  return true;
}

/* Who can see this, listed. The screen a teacher opens before they publish. */
export function audience(ctx, fileId) {
  const row = one('SELECT * FROM files WHERE id = ?', fileId);
  if (!row) throw new NotFound('No such file.');
  if (!perms.can(ctx, 'read', row).allowed) throw new Denied(perms.can(ctx, 'read', row));
  const folder = folderById(row.folder_id);
  const grants = all('SELECT * FROM acl WHERE file_id = ? OR folder_id = ?', fileId, row.folder_id);
  return {
    summary: perms.describeAudience(row),
    visibility: row.visibility,
    folder: folder.path,
    grants: grants.map((g) => ({
      id: g.id, who: g.principal_type + (g.principal_id ? ':' + g.principal_id : ''),
      permission: g.permission, effect: g.effect, reason: g.reason, expires: g.expires_at,
      scope: g.file_id ? 'this file' : 'the folder',
    })),
  };
}

export function auditTrail(ctx, fileId, limit) {
  const row = one('SELECT * FROM files WHERE id = ?', fileId);
  if (!row) throw new NotFound('No such file.');
  const d = perms.can(ctx, 'write', row);
  if (!d.allowed) throw new Denied(d);
  return all('SELECT * FROM file_audit WHERE file_id = ? ORDER BY at DESC LIMIT ?', fileId, Math.min(Number(limit) || 100, 500));
}

/* --------------------------------------------------------------- shaping */

function decorate(row, folder, decision) {
  return {
    id: row.id, name: row.name, title: row.title, description: row.description,
    ext: row.ext, mime: row.mime, size: row.size, version: row.version,
    purpose: row.purpose, source: row.source, sourceUrl: row.source_url,
    visibility: row.visibility, folder_id: row.folder_id,
    path: (folder && folder.path ? folder.path : '') + '/' + row.name,
    storage_key: row.storage_key,
    isImage: paths.isImage(row.mime), isText: paths.isText(row.mime),
    meta: json(row.meta_json, {}),
    tags: all('SELECT tag FROM file_tags WHERE file_id = ?', row.id).map((t) => t.tag),
    courses: all('SELECT course_id FROM file_courses WHERE file_id = ?', row.id).map((t) => t.course_id),
    classes: all('SELECT class_id FROM file_classes WHERE file_id = ?', row.id).map((t) => t.class_id),
    links: all('SELECT entity_type, entity_id, relation FROM file_links WHERE file_id = ?', row.id),
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    audience: folder && folder.path ? perms.describeAudience({ id: folder.id, path: folder.path, visibility: row.visibility }) : '',
    url: '/api/files/' + row.id + '/content',
    why: decision ? decision.reason : undefined,
  };
}

export { paths, perms };
