/* ===========================================================================
   server/src/teaching.js — the class, seen from the front of the room.
   ---------------------------------------------------------------------------
   A gradebook tells a teacher who is behind. It does not tell them what to do
   on Tuesday. These two functions are for the second question.

   `overview()`   who has handed in what, who has not started, where the marks
                  actually sit — one row per student, one column per
                  assignment, and the shape read out in a sentence.

   `craftAcross()` the interesting one: every craft finding across every
                  submission in the class, counted. If nineteen of twenty-two
                  submissions put a query inside a loop, that is not nineteen
                  conversations, it is one lesson that did not land — and the
                  point of aggregating is to turn the first into the second.

   Both are permission-checked at the door and read nothing but what a teacher
   of that class could already open one submission at a time.
   =========================================================================== */

import { all, one, json } from './db/db.js';

function assertTeaches(ctx, classId) {
  const role = ctx.classRole(classId);
  if (ctx.role !== 'admin' && role !== 'teacher' && role !== 'ta') {
    const e = new Error('You do not teach that class.');
    e.status = 403; throw e;
  }
}

/* ------------------------------------------------------------- overview --- */

export function overview(ctx, classId) {
  assertTeaches(ctx, classId);
  const cls = one(
    `SELECT c.*, co.title AS course FROM classes c JOIN courses co ON co.id = c.course_id WHERE c.id = ?`,
    classId);
  if (!cls) { const e = new Error('No such class.'); e.status = 404; throw e; }

  const students = all(
    `SELECT u.id, u.name FROM enrolments e JOIN users u ON u.id = e.user_id
      WHERE e.class_id = ? AND e.role = 'student' AND e.status = 'active' ORDER BY u.name`, classId);
  const assignments = all(
    'SELECT id, ref, title, due_at, max_points FROM assignments WHERE class_id = ? ORDER BY due_at, created_at',
    classId);

  const rows = students.map((s) => {
    const cells = assignments.map((a) => {
      const sub = one(
        `SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?
          ORDER BY attempt DESC LIMIT 1`, a.id, s.id);
      if (!sub) return { assignmentId: a.id, state: 'not started' };
      const g = one(
        `SELECT * FROM grades WHERE submission_id = ? ORDER BY created_at DESC LIMIT 1`, sub.id);
      return {
        assignmentId: a.id,
        state: sub.status,
        attempt: sub.attempt,
        submittedAt: sub.submitted_at,
        score: g ? g.score : null,
        confirmed: !!(g && g.confirmed_at),
        craft: g ? (json(g.craft_json, {}) || {}).score : null,
        passed: g ? ((json(g.correctness_json, {}) || {}).pass === true) : null,
      };
    });
    return { student: s, cells };
  });

  /* The shape, in a sentence, because a grid is what you read second. */
  const started = rows.filter((r) => r.cells.some((c) => c.state !== 'not started')).length;
  const stuck = rows.filter((r) => r.cells.some((c) => c.state !== 'not started' && c.passed === false));
  // A cell for an assignment nobody has started carries no score at all, and
  // `undefined !== null` counted every one of them as an unconfirmed grade.
  const hasScore = (c) => c.score !== null && c.score !== undefined;
  const awaiting = rows.reduce((n, r) => n + r.cells.filter((c) => hasScore(c) && !c.confirmed).length, 0);

  return {
    class: { id: cls.id, code: cls.code, title: cls.title, course: cls.course },
    assignments, rows,
    summary: {
      students: students.length, started, notStarted: students.length - started,
      stuck: stuck.map((r) => r.student.name),
      awaitingConfirmation: awaiting,
      sentence: sentence(students.length, started, stuck.length, awaiting),
    },
  };
}

function sentence(total, started, stuck, awaiting) {
  const bits = [];
  bits.push(started + ' of ' + total + ' have started something');
  if (stuck) bits.push(stuck + ' ' + (stuck === 1 ? 'is' : 'are') + ' stuck on a failing check');
  if (awaiting) bits.push(awaiting + ' grade(s) are waiting for you to confirm');
  return bits.join('; ') + '.';
}

/* ---------------------------------------------------------------- craft --- */

/* Every craft finding across the class, counted, worst first. A finding that
   appears once is a conversation with one person. A finding that appears
   fifteen times is a lesson to re-teach, and the difference is the whole
   reason to look. */
export function craftAcross(ctx, classId, opts) {
  assertTeaches(ctx, classId);
  const o = opts || {};
  const where = ['a.class_id = ?'];
  const args = [classId];
  if (o.assignmentId) { where.push('a.id = ?'); args.push(o.assignmentId); }

  const graded = all(
    `SELECT g.*, s.student_id, s.attempt, a.id AS assignment_id, a.title AS assignment, u.name AS student
       FROM grades g
       JOIN submissions s ON s.id = g.submission_id
       JOIN assignments  a ON a.id = s.assignment_id
       JOIN users u ON u.id = s.student_id
      WHERE ` + where.join(' AND ') + `
      ORDER BY g.created_at`, ...args);

  // One submission, one voice: only the latest grade per submission counts,
  // or a student who pressed Check five times outvotes the rest of the class.
  const latest = {};
  graded.forEach((g) => { latest[g.submission_id] = g; });
  const rows = Object.values(latest);

  const byFinding = {};
  const byStudent = {};
  let craftTotal = 0, craftCount = 0;

  rows.forEach((g) => {
    const craft = json(g.craft_json, {}) || {};
    const passed = (json(g.correctness_json, {}) || {}).pass === true;
    // Craft on an answer that does not work yet is not a compliment. It is
    // counted only where the code does what it was asked to.
    if (passed && typeof craft.score === 'number') { craftTotal += craft.score; craftCount++; }
    byStudent[g.student_id] = byStudent[g.student_id] ||
      { name: g.student, submissions: 0, craft: [], findings: [], unfinished: 0 };
    byStudent[g.student_id].submissions++;
    if (!passed) byStudent[g.student_id].unfinished++;
    if (passed && typeof craft.score === 'number') byStudent[g.student_id].craft.push(craft.score);

    (craft.findings || []).forEach((f) => {
      if (f.severity === 'praise') return;
      const key = f.id || f.label;
      byFinding[key] = byFinding[key] || {
        id: key, label: f.label, severity: f.severity, concept: f.concept,
        why: f.why, better: f.better, count: 0, students: [], assignments: {},
      };
      const rec = byFinding[key];
      rec.count++;
      if (rec.students.indexOf(g.student) < 0) rec.students.push(g.student);
      rec.assignments[g.assignment] = (rec.assignments[g.assignment] || 0) + 1;
      byStudent[g.student_id].findings.push(f.label);
    });
  });

  const SEV = { error: 0, warning: 1, improve: 2, style: 3 };
  const findings = Object.values(byFinding).sort((a, b) =>
    b.students.length - a.students.length || (SEV[a.severity] - SEV[b.severity]));

  const students = Object.keys(byStudent).map((id) => {
    const s = byStudent[id];
    return {
      id, name: s.name, submissions: s.submissions, unfinished: s.unfinished,
      craft: s.craft.length ? Math.round(s.craft.reduce((a, b) => a + b, 0) / s.craft.length) : null,
      findings: s.findings.length,
      state: s.craft.length ? 'graded' : s.unfinished ? 'not working yet' : 'nothing graded',
    };
  // Somebody with nothing working yet sorts FIRST: they are the person the
  // list exists to surface, not a blank at the bottom of it.
  }).sort((a, b) => (a.craft === null ? -1 : a.craft) - (b.craft === null ? -1 : b.craft));

  const worst = findings[0];
  return {
    classId,
    graded: rows.length,
    averageCraft: craftCount ? Math.round(craftTotal / craftCount) : null,
    findings: findings.slice(0, o.limit || 20).map((f) => Object.assign({}, f, {
      assignments: Object.keys(f.assignments).map((k) => ({ title: k, count: f.assignments[k] })),
    })),
    students,
    // The point of the whole function, said out loud.
    teach: worst && worst.students.length > 1
      ? worst.students.length + ' of ' + students.length + ' submissions hit "' + worst.label +
        '". That is a lesson to re-teach rather than ' + worst.students.length + ' conversations.'
      : rows.length
        ? 'No single problem is widespread. What is left is individual.'
        : 'Nothing has been graded in this class yet.',
  };
}

/* One student, for a teacher — everything they have handed in and how it was
   marked. The same data the student sees, plus the unconfirmed grades. */
export function studentDetail(ctx, classId, studentId) {
  assertTeaches(ctx, classId);
  const u = one('SELECT id, name FROM users WHERE id = ?', studentId);
  if (!u) { const e = new Error('No such student.'); e.status = 404; throw e; }
  const enrolled = one(
    "SELECT 1 AS x FROM enrolments WHERE class_id = ? AND user_id = ? AND status='active'", classId, studentId);
  if (!enrolled) { const e = new Error('That student is not in this class.'); e.status = 404; throw e; }

  const subs = all(
    `SELECT s.*, a.title, a.ref FROM submissions s JOIN assignments a ON a.id = s.assignment_id
      WHERE s.student_id = ? AND a.class_id = ? ORDER BY s.created_at DESC`, studentId, classId);

  return {
    student: u,
    submissions: subs.map((s) => ({
      id: s.id, title: s.title, ref: s.ref, attempt: s.attempt, status: s.status,
      submittedAt: s.submitted_at,
      grades: all('SELECT * FROM grades WHERE submission_id = ? ORDER BY created_at DESC', s.id)
        .map((g) => ({
          id: g.id, score: g.score, max: g.max, by: g.grader_type,
          confirmed: !!g.confirmed_at, feedback: g.feedback,
          craft: json(g.craft_json, {}), correctness: json(g.correctness_json, {}),
        })),
    })),
  };
}
