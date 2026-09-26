/* ===========================================================================
   server/src/files/retention.js — keeping things, and letting them go.
   ---------------------------------------------------------------------------
   Two obligations a school platform acquires the moment it holds real data,
   and neither is optional once it is used on real children:

     1  RETENTION. Nothing is destroyed on delete — it is marked deleted, and
        stays recoverable for a window. After that window it is destroyed
        properly, blob included, and a line is left in the audit saying so.
        The windows differ by what the thing is: a student's own draft can go
        quickly, a graded submission has to survive an appeal, and an audit
        trail outlives both.

     2  EXPORT. A person can ask for everything the platform holds about them
        and get it in a form they can open. Not a support ticket — a button.

   The sweep is deliberately conservative. It refuses to destroy anything that
   is still referenced, it never touches a blob another file still points at,
   and `plan()` shows what a sweep WOULD do without doing any of it, because a
   deletion routine nobody has previewed is a deletion routine nobody trusts.
   =========================================================================== */

import { all, one, run, insert } from '../db/db.js';
import * as paths from './paths.js';
import * as perms from './permissions.js';
import { store } from './store.js';
import { unindex } from '../search/index.js';

/* Days a soft-deleted file stays recoverable, by what it is. The numbers are
   defaults a school would change; the shape is the part that matters. */
export const WINDOWS = {
  submission: 365 * 3,   // long enough to survive an appeal and an audit
  feedback: 365 * 3,
  rubric: 365 * 3,
  brief: 365 * 2,
  transcript: 365,
  resource: 180,
  reading: 180,
  dataset: 180,
  reference: 180,
  template: 180,
  recording: 90,
  image: 90,
  export: 30,
  'starter-code': 180,
  solution: 365,
  other: 90,
};
export const DEFAULT_WINDOW = 90;

export const windowFor = (purpose) => WINDOWS[purpose] === undefined ? DEFAULT_WINDOW : WINDOWS[purpose];

const iso = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

/* What a sweep would destroy, and what it would leave. Read-only. */
export function plan(opts) {
  const o = opts || {};
  const now = o.now ? new Date(o.now) : new Date();
  const rows = all('SELECT * FROM files WHERE deleted_at IS NOT NULL');
  const due = [];
  const waiting = [];
  rows.forEach((f) => {
    const days = windowFor(f.purpose);
    const expires = new Date(new Date(String(f.deleted_at).replace(' ', 'T') + 'Z').getTime() + days * 86400000);
    const rec = { id: f.id, name: f.name, purpose: f.purpose, deletedAt: f.deleted_at,
      window: days, expiresAt: iso(expires) };
    if (expires <= now) due.push(rec); else waiting.push(rec);
  });
  return { due, waiting, sharedBlobs: sharedBlobCount() };
}

/* How many blobs more than one file points at. Content addressing means a
   worksheet uploaded by thirty students is stored once, which is worth
   showing — and it is why sweep() checks before it removes anything. */
export function sharedBlobCount() {
  const rows = all(
    `SELECT storage_key, COUNT(*) AS n FROM (
        SELECT storage_key FROM files
        UNION ALL
        SELECT storage_key FROM file_versions)
      GROUP BY storage_key HAVING n > 1`);
  return rows.length;
}

/* Destroy what is past its window. Returns what it did. */
export async function sweep(opts) {
  const o = opts || {};
  const p = plan(o);
  const purged = [];
  for (const rec of p.due) {
    if (o.dryRun) { purged.push(rec); continue; }
    const f = one('SELECT * FROM files WHERE id = ?', rec.id);
    if (!f) continue;
    const keys = [f.storage_key].concat(
      all('SELECT storage_key FROM file_versions WHERE file_id = ?', f.id).map((v) => v.storage_key));

    run('DELETE FROM file_versions WHERE file_id = ?', f.id);
    run('DELETE FROM files WHERE id = ?', f.id);
    unindex('file', f.id);

    // A blob only goes when nothing else points at it.
    for (const key of new Set(keys)) {
      const stillUsed = one('SELECT 1 AS x FROM files WHERE storage_key = ? LIMIT 1', key) ||
        one('SELECT 1 AS x FROM file_versions WHERE storage_key = ? LIMIT 1', key);
      if (!stillUsed) { try { await store().remove(key); } catch (e) { /* already gone */ } }
    }
    // The row is gone; the fact that it existed and was destroyed is not.
    insert('file_audit', { file_id: f.id, actor_id: o.actorId || null, action: 'purged',
      detail: f.name + ' (' + f.purpose + ', deleted ' + f.deleted_at + ')' });
    purged.push(rec);
  }
  return { purged, remaining: p.waiting.length, dryRun: !!o.dryRun };
}

/* --------------------------------------------------------------- export --- */

/* Everything the platform holds about one person, as a manifest plus the files
   themselves. A guardian may export their own ward; an admin may export
   anybody; everyone else may export only themselves. */
export function mayExport(ctx, subjectId) {
  if (!ctx) return false;
  if (ctx.id === subjectId) return true;
  if (ctx.role === 'admin') return true;
  return ctx.isWard(subjectId);
}

export function manifest(ctx, subjectId) {
  if (!mayExport(ctx, subjectId)) {
    const e = new Error('You can export your own record, and a guardian can export their student’s.');
    e.status = 403; throw e;
  }
  const user = one('SELECT id, name, email, role, created_at FROM users WHERE id = ?', subjectId);
  if (!user) { const e = new Error('No such person.'); e.status = 404; throw e; }

  const enrolments = all(
    `SELECT c.code, c.title, e.role, e.status, e.created_at
       FROM enrolments e JOIN classes c ON c.id = e.class_id WHERE e.user_id = ?`, subjectId);

  const submissions = all(
    `SELECT s.id, s.attempt, s.status, s.submitted_at, s.body, a.title, a.ref
       FROM submissions s JOIN assignments a ON a.id = s.assignment_id
      WHERE s.student_id = ? ORDER BY s.created_at`, subjectId);

  const grades = all(
    `SELECT g.score, g.max, g.grader_type, g.feedback, g.created_at, g.confirmed_at, a.title
       FROM grades g JOIN submissions s ON s.id = g.submission_id
       JOIN assignments a ON a.id = s.assignment_id
      WHERE s.student_id = ? ORDER BY g.created_at`, subjectId);

  // Files they created, plus files filed about them.
  const files = all(
    `SELECT f.id, f.name, f.title, f.purpose, f.source, f.source_url, f.mime, f.size,
            f.created_at, f.updated_at, d.path
       FROM files f JOIN folders d ON d.id = f.folder_id
      WHERE f.deleted_at IS NULL
        AND (f.created_by = ? OR d.subject_user_id = ?)`, subjectId, subjectId);

  const threads = all('SELECT id, title, created_at FROM threads WHERE user_id = ?', subjectId);
  const conversations = threads.map((t) => Object.assign({}, t, {
    messages: all('SELECT role, text, created_at FROM messages WHERE thread_id = ? ORDER BY created_at', t.id)
      .filter((m) => m.text),
  }));

  return {
    exportedAt: new Date().toISOString(),
    exportedBy: { id: ctx.id, name: ctx.name },
    subject: user,
    enrolments,
    submissions,
    grades: grades.map((g) => Object.assign({}, g, {
      confirmed: !!g.confirmed_at,
      note: g.confirmed_at ? undefined : 'This grade was never confirmed by a teacher, so it did not count.',
    })),
    files: files.map((f) => Object.assign({}, f, { download: '/api/files/' + f.id + '/content?download=1' })),
    conversations,
    aiUsage: one('SELECT month, calls, input_tokens, output_tokens, web_searches FROM ai_budget WHERE user_id = ?', subjectId) || null,
    accessLog: all(
      `SELECT action, detail, at FROM file_audit WHERE actor_id = ? ORDER BY at DESC LIMIT 500`, subjectId),
    note: 'Files are listed with a download link rather than embedded, so this manifest stays readable. ' +
      'Every link needs the same permission the file itself does.',
  };
}

/* The retention position for one file, for the UI to show beside it. */
export function statusOf(ctx, fileId) {
  const f = one('SELECT * FROM files WHERE id = ?', fileId);
  if (!f) return null;
  const d = perms.can(ctx, 'read', f);
  if (!d.allowed) return null;
  const days = windowFor(f.purpose);
  if (!f.deleted_at) {
    return { state: 'kept', window: days,
      summary: 'Kept while it is in use. If deleted, it stays recoverable for ' + days + ' days.' };
  }
  const expires = new Date(new Date(String(f.deleted_at).replace(' ', 'T') + 'Z').getTime() + days * 86400000);
  const left = Math.ceil((expires - Date.now()) / 86400000);
  return {
    state: 'deleted', window: days, expiresAt: iso(expires), daysLeft: left,
    summary: left > 0
      ? 'Deleted. Recoverable for another ' + left + ' day(s), then destroyed.'
      : 'Deleted and past its window. The next sweep will destroy it.',
  };
}

export { paths };
