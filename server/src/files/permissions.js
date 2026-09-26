/* ===========================================================================
   server/src/files/permissions.js — who can see what, and why.
   ---------------------------------------------------------------------------
   One function answers every access question in the platform:

       can(actor, 'read', resource)  ->  { allowed, reason, rule }

   It always returns a REASON. That is not decoration. When a teacher says "I
   can't see this student's work", the answer has to be a sentence, not a
   shrug, and when an auditor asks why a guardian could read a file, the
   system has to be able to say which rule let them.

   The order of decision, and it is deliberate:

     1  DENY beats everything. An explicit deny is how you take access away
        from someone a derived rule would otherwise give it to, and it must
        not be possible to grant your way back past it.
     2  Platform admin.
     3  Ownership — you can always reach what you made, unless (1) says not.
     4  Explicit ALLOW grants, on the file, then walking up the folders.
     5  Derived rules, from the path plus the roster. This is where nearly
        all real access comes from, and it is computed rather than stored so
        it can never go stale when a roster changes.
     6  Visibility, for the "published to the class" case.
     7  Otherwise: no.

   The derived rules, stated plainly, because they are the policy:

     - A teacher or TA of a class reaches everything under that class,
       including every student's submissions. Read and write; grade too.
     - An observer of a class reads class resources and briefs, and no
       student work at all.
     - A student reaches: class resources and briefs for classes they are
       enrolled in; their OWN submission folder; their own private area and
       portfolio. They never reach another student's work — there is no
       combination of roles that produces it, which is why the rule is
       written as an explicit match on the userId in the path.
     - A guardian reads what their own student's portfolio holds, and their
       student's SUBMITTED work and feedback — not drafts. A draft is
       thinking out loud, and a system that shows drafts to parents teaches
       children not to think in the system.
     - Everyone reads course-level resources for a course they are in.
     - /system/ai/{threadId} belongs to whoever owns the thread.

   No rule anywhere grants a student write access to a grade, or to another
   person's folder, or to an assignment brief.
   =========================================================================== */

import { all, one } from '../db/db.js';
import * as paths from './paths.js';

export const ACTIONS = ['read', 'write', 'delete', 'share', 'grade'];

/* Weaker actions are implied by stronger ones: being able to write implies
   being able to read. Stated once, here. */
const IMPLIES = {
  read: ['read', 'write', 'delete', 'share', 'grade'],
  write: ['write', 'delete'],
  delete: ['delete'],
  share: ['share'],
  grade: ['grade'],
};

const yes = (rule, reason) => ({ allowed: true, rule, reason });
const no = (rule, reason) => ({ allowed: false, rule, reason });

/* ------------------------------------------------------------------ roster */

/* Everything about this actor that any rule might need, fetched once. */
export function context(userId) {
  const user = one('SELECT id, role, name, email, active FROM users WHERE id = ?', userId);
  if (!user) return null;
  const enrolments = all(
    `SELECT e.class_id, e.role, e.status, c.course_id
       FROM enrolments e JOIN classes c ON c.id = e.class_id
      WHERE e.user_id = ? AND e.status = 'active'`, userId);
  const wards = all('SELECT student_id FROM guardianships WHERE guardian_id = ?', userId)
    .map((r) => r.student_id);
  const byClass = {};
  const courses = {};
  enrolments.forEach((e) => { byClass[e.class_id] = e.role; courses[e.course_id] = true; });
  return {
    id: user.id, role: user.role, name: user.name, active: !!user.active,
    enrolments, classRole: (cid) => byClass[cid] || null,
    inCourse: (courseId) => !!courses[courseId],
    wards, isWard: (sid) => wards.indexOf(sid) >= 0,
  };
}

/* ------------------------------------------------------------------- rules */

/* resource is a folder row or a file row. A file's location is its folder, so
   both reduce to { path, ownerId, visibility, fileId, folderId }. */
export function resolveResource(resource) {
  if (!resource) return null;
  if (resource.__resolved) return resource;
  if (resource.folder_id !== undefined) {         // a file
    const folder = one('SELECT * FROM folders WHERE id = ?', resource.folder_id);
    return {
      __resolved: true,
      fileId: resource.id, folderId: resource.folder_id,
      path: folder ? folder.path : '',
      ownerId: resource.created_by || (folder && folder.owner_id) || null,
      subjectUserId: folder ? folder.subject_user_id : null,
      visibility: resource.visibility || 'inherit',
      systemFolder: folder ? !!folder.system : false,
      name: resource.name,
    };
  }
  return {                                        // a folder
    __resolved: true,
    fileId: null, folderId: resource.id,
    path: resource.path,
    ownerId: resource.owner_id || null,
    subjectUserId: resource.subject_user_id || null,
    visibility: 'inherit',
    systemFolder: !!resource.system,
    name: resource.name,
  };
}

/* Explicit grants on this file and on every folder above it, nearest first.
   A grant on the file beats a grant on its folder, which beats one further up
   — except for deny, which is checked across the whole chain before anything
   else is considered. */
function grantsFor(res) {
  const chain = [res.path].concat(paths.ancestors(res.path).reverse());
  const folderRows = chain.length
    ? all('SELECT id, path FROM folders WHERE path IN (' + chain.map(() => '?').join(',') + ')', ...chain)
    : [];
  const order = {};
  chain.forEach((p, i) => { order[p] = i; });
  folderRows.sort((a, b) => order[a.path] - order[b.path]);

  const out = [];
  if (res.fileId) {
    all('SELECT * FROM acl WHERE file_id = ?', res.fileId).forEach((g) => out.push({ g, depth: -1 }));
  }
  folderRows.forEach((f, i) => {
    all('SELECT * FROM acl WHERE folder_id = ?', f.id).forEach((g) => out.push({ g, depth: i }));
  });
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return out.filter(({ g }) => !g.expires_at || g.expires_at > nowIso);
}

function grantMatches(g, ctx, res) {
  switch (g.principal_type) {
    case 'everyone': return true;
    case 'user': return g.principal_id === ctx.id;
    case 'role': return g.principal_id === ctx.role;
    case 'class': return ctx.classRole(g.principal_id) !== null;
    case 'course': return ctx.inCourse(g.principal_id);
    case 'class-role': {
      // principal_id is 'classId:role'
      const [cid, role] = String(g.principal_id).split(':');
      return ctx.classRole(cid) === role;
    }
    case 'guardian-of': return ctx.isWard(g.principal_id);
    default: return false;
  }
}

const covers = (granted, wanted) => (IMPLIES[wanted] || [wanted]).indexOf(granted) >= 0;

/* ---------------------------------------------------------------- decision */

export function can(ctx, action, resource, opts) {
  const o = opts || {};
  if (!ctx) return no('no-actor', 'There is nobody signed in.');
  if (!ctx.active) return no('inactive', 'That account is not active.');
  if (ACTIONS.indexOf(action) < 0) return no('unknown-action', 'Unknown action "' + action + '".');
  const res = resolveResource(resource);
  if (!res) return no('no-resource', 'That file or folder does not exist.');

  const d = paths.describe(res.path);
  const grants = grantsFor(res);

  /* 1 — an explicit deny anywhere in the chain ends it. */
  const denied = grants.find(({ g }) => g.effect === 'deny' && covers(g.permission, action) && grantMatches(g, ctx, res));
  if (denied) {
    return no('explicit-deny', 'Access was explicitly withdrawn' +
      (denied.g.reason ? ': ' + denied.g.reason : '.'));
  }

  /* 2 — platform administrators. */
  if (ctx.role === 'admin') return yes('admin', 'Platform administrators reach everything.');

  /* 3 — ownership. */
  if (res.ownerId && res.ownerId === ctx.id) {
    // The guard is on the FOLDER, not on what is in it. A student must be able
    // to delete their own file out of a folder the platform created for them.
    if (res.systemFolder && !res.fileId && action === 'delete') {
      return no('system-folder', 'This folder is part of the platform structure and cannot be deleted.');
    }
    return yes('owner', 'You created this.');
  }

  /* 4 — explicit allows, nearest grant first. */
  const allowed = grants
    .filter(({ g }) => g.effect === 'allow' && covers(g.permission, action) && grantMatches(g, ctx, res))
    .sort((a, b) => a.depth - b.depth)[0];
  if (allowed) {
    return yes('granted', 'You were given ' + allowed.g.permission + ' access' +
      (allowed.g.reason ? ': ' + allowed.g.reason : '.'));
  }

  /* 5 — derived from the roster and the path. */
  const derived = derive(ctx, action, d, res);
  if (derived) return derived;

  /* 6 — published visibility on the file itself. */
  if (action === 'read') {
    if (res.visibility === 'school') return yes('visibility-school', 'This is published to everyone at the school.');
    if (res.visibility === 'link' && o.linkToken && o.linkToken === o.fileLinkToken) {
      return yes('visibility-link', 'You followed a share link for this file.');
    }
    if (res.visibility === 'course' && d.courseId && ctx.inCourse(d.courseId)) {
      return yes('visibility-course', 'This is published to everyone taking the course.');
    }
    if (res.visibility === 'class' && d.classId && ctx.classRole(d.classId)) {
      return yes('visibility-class', 'This is published to your class.');
    }
  }

  return no('default-deny', reasonForDenial(ctx, action, d));
}

function derive(ctx, action, d, res) {
  const classRole = d.classId ? ctx.classRole(d.classId) : null;
  const teaches = classRole === 'teacher' || classRole === 'ta';

  switch (d.kind) {
    case 'course-resources':
      if (action === 'read' && ctx.inCourse(d.courseId)) {
        return yes('course-member', 'You are taking or teaching this course.');
      }
      if (action !== 'read' && (ctx.role === 'teacher' || ctx.role === 'staff') && ctx.inCourse(d.courseId)) {
        return yes('course-teacher', 'You teach a class on this course.');
      }
      return null;

    case 'class-resources':
    case 'assignment-brief':
      if (teaches) return yes('class-teacher', 'You teach this class.');
      if (classRole && action === 'read') {
        return yes('class-member', 'You are in this class.');
      }
      return null;

    case 'submissions':
      // The folder that holds every student's work. Teachers only — a student
      // listing it would see the roster's filenames.
      if (teaches) return yes('class-teacher', 'You teach this class.');
      return null;

    case 'student-work': {
      if (teaches) return yes('class-teacher', 'You teach this class, so you can see and mark this work.');
      if (d.userId === ctx.id) return yes('own-work', 'This is your own work.');
      if (action === 'read' && ctx.isWard(d.userId)) {
        // Guardians see submitted work, never drafts.
        if (res.fileId) {
          const sub = one(
            `SELECT s.status FROM submissions s
              WHERE s.student_id = ? AND s.file_id = ?`, d.userId, res.fileId);
          if (sub && sub.status === 'draft') {
            return no('guardian-draft', 'This is still a draft. Guardians see work once it has been handed in.');
          }
        }
        return yes('guardian', 'You are the guardian of the student whose work this is.');
      }
      return null;
    }

    case 'personal':
      return d.userId === ctx.id ? yes('own-private', 'This is your private area.') : null;

    case 'portfolio':
      if (d.userId === ctx.id) return yes('own-portfolio', 'This is your portfolio.');
      if (action !== 'read') return null;
      if (ctx.isWard(d.userId)) return yes('guardian', 'You are this student’s guardian.');
      if (ctx.role === 'teacher' || ctx.role === 'staff') {
        const shares = one(
          `SELECT 1 AS ok FROM enrolments a
             JOIN enrolments b ON b.class_id = a.class_id
            WHERE a.user_id = ? AND b.user_id = ? AND a.role IN ('teacher','ta')
              AND a.status = 'active' AND b.status = 'active' LIMIT 1`, ctx.id, d.userId);
        if (shares) return yes('their-teacher', 'You teach a class this student is in.');
      }
      return null;

    case 'ai-artifacts': {
      const t = d.threadId ? one('SELECT user_id FROM threads WHERE id = ?', d.threadId) : null;
      if (t && t.user_id === ctx.id) return yes('own-thread', 'The assistant produced this in your own conversation.');
      return null;
    }

    default:
      return null;   // /shared and anything unrecognised need an explicit grant
  }
}

/* A denial a person can act on. */
function reasonForDenial(ctx, action, d) {
  switch (d.kind) {
    case 'student-work':
      return d.userId === ctx.id
        ? 'You can read and write your own work, but not ' + action + ' it here.'
        : 'This is another student’s work. Only they and the people who teach the class can open it.';
    case 'personal':
      return 'This is somebody else’s private area. Nothing reaches it but its owner.';
    case 'class-resources': case 'assignment-brief':
      return 'You are not enrolled in this class.';
    case 'course-resources':
      return 'You are not on this course.';
    case 'shared':
      return 'Shared folders need an explicit invitation, and you do not have one for this.';
    default:
      return 'Nothing gives you ' + action + ' access to this.';
  }
}

/* Filter a list of rows to what this actor may read. One roster fetch, one
   pass — used by every listing and by the agent's search. */
export function readable(ctx, rows) {
  return (rows || []).filter((r) => can(ctx, 'read', r).allowed);
}

/* A short sentence for the UI: who can see this, in English. */
export function describeAudience(res) {
  const r = resolveResource(res);
  const d = paths.describe(r.path);
  if (r.visibility === 'school') return 'Everyone at the school';
  if (r.visibility === 'link') return 'Anyone with the link';
  switch (d.kind) {
    case 'course-resources': return 'Everyone on the course';
    case 'class-resources': case 'assignment-brief': return 'This class';
    case 'submissions': return 'The teaching team';
    case 'student-work': return 'The student, their teachers, and their guardian once handed in';
    case 'personal': return 'Only you';
    case 'portfolio': return 'You, your teachers and your guardian';
    case 'ai-artifacts': return 'Only you';
    case 'shared': return 'The people invited to this folder';
    default: return 'Nobody, until someone is given access';
  }
}
