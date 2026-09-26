#!/usr/bin/env node
/* ===========================================================================
   server/src/seed.js — a demo school, so every screen has something in it.
   ---------------------------------------------------------------------------
       node server/src/seed.js [--force]

   Creates one course, two classes, a teacher, a TA, five students, a guardian,
   the folder structure, a handful of files with real metadata, and assignments
   drawn from the studio's own exercises so the auto-grader has something to
   grade. Idempotent: running it twice changes nothing unless --force.

   The passwords are printed. They are 'lantern' for everybody, which is fine
   for a demo on a laptop and is refused outright when NODE_ENV=production.
   =========================================================================== */

import { open, one, all, insert, run, id, hashPassword, tx } from './db/db.js';
import * as filesApi from './files/files.js';
import * as paths from './files/paths.js';
import * as perms from './files/permissions.js';
import { allExercises, runner, course, exerciseByRef } from './course/runner.js';
import { autoGrade, recordGrade } from './ai/review.js';
import { indexCourse } from './search/index.js';

const PASSWORD = 'lantern';

export async function seed(opts) {
  const o = opts || {};
  if (process.env.NODE_ENV === 'production' && !o.force) {
    throw new Error('Refusing to seed demo accounts in production.');
  }
  open(o.db);

  if (one("SELECT id FROM courses WHERE code = 'CFML-501'") && !o.force) {
    return { skipped: true, note: 'Already seeded. Pass --force to add anyway.' };
  }

  const made = { users: [], classes: [], assignments: 0, files: 0 };

  const courseId = id('crs');
  insert('courses', { id: courseId, code: 'CFML-501', title: 'ColdFusion 501',
    description: 'Nine units, from the request cycle to a working case-study application.' });

  const person = (name, email, role) => {
    const p = hashPassword(PASSWORD);
    const uid = id('usr');
    insert('users', { id: uid, email, name, role, password_hash: p.hash, password_salt: p.salt });
    filesApi.scaffoldPerson(uid);
    made.users.push({ id: uid, name, email, role });
    return uid;
  };

  const teacher = person('Dana Whitfield', 'dana@example.school', 'teacher');
  const ta = person('Marco Iles', 'marco@example.school', 'teacher');
  const students = [
    person('Sam Carter', 'sam@example.school', 'student'),
    person('Priya Raman', 'priya@example.school', 'student'),
    person('Ellis Boone', 'ellis@example.school', 'student'),
    person('Tomas Vega', 'tomas@example.school', 'student'),
    person('Nell Hardy', 'nell@example.school', 'student'),
  ];
  const guardian = person('Rosa Vega', 'rosa@example.home', 'guardian');
  const admin = person('System Admin', 'admin@example.school', 'admin');
  insert('guardianships', { guardian_id: guardian, student_id: students[3], relation: 'parent' });

  const mkClass = (code, title, term, roster) => {
    const cid = id('cls');
    insert('classes', { id: cid, course_id: courseId, code, title, term });
    filesApi.scaffoldClass({ id: cid, course_id: courseId });
    roster.forEach((rr) => insert('enrolments', { id: id('enr'), class_id: cid, user_id: rr.user, role: rr.role }));
    made.classes.push({ id: cid, code, title });
    return cid;
  };

  const classA = mkClass('CFML-501-A', 'ColdFusion 501, section A', 'Autumn 2026',
    [{ user: teacher, role: 'teacher' }, { user: ta, role: 'ta' }]
      .concat(students.slice(0, 4).map((s) => ({ user: s, role: 'student' }))));
  const classB = mkClass('CFML-501-B', 'ColdFusion 501, section B', 'Autumn 2026',
    [{ user: teacher, role: 'teacher' }, { user: students[4], role: 'student' }]);

  /* --- assignments, from the course's own graded items ------------------- */
  const teacherCtx = perms.context(teacher);
  const exercises = allExercises();
  const pick = exercises.filter((e) => ['u3l4e1', 'u4l2e1', 'u4l6e1', 'u6l6e1'].indexOf(e.ref) >= 0)
    .concat(exercises.filter((e) => e.kind === 'project-milestone').slice(0, 2));

  const dueIn = (days) => new Date(Date.now() + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const assignments = [];
  pick.forEach((e, i) => {
    const aid = id('asg');
    insert('assignments', {
      id: aid, class_id: classA, course_id: courseId, ref: e.ref, kind: e.kind,
      title: e.title, brief: String(e.prompt || '').slice(0, 4000),
      due_at: dueIn(3 + i * 4), max_points: 100, published: 1, created_by: teacher,
      weight_json: JSON.stringify({ correctness: 0.7, craft: 0.3 }),
    });
    filesApi.scaffoldAssignment({ id: aid, class_id: classA });
    assignments.push({ id: aid, ref: e.ref, title: e.title });
    made.assignments++;
  });

  /* --- a few files, with the metadata the system insists on -------------- */
  const put = async (spec) => { made.files++; return filesApi.put(teacherCtx, spec); };

  await put({
    path: paths.classResources(classA), name: 'course-outline.md',
    data: outline(), purpose: 'reading', source: 'upload',
    title: 'Course outline', description: 'What the seven units cover and in what order.',
    visibility: 'class', tags: ['outline', 'reference'], courseIds: [courseId], classIds: [classA],
  });
  await put({
    path: paths.courseResources(courseId), name: 'cfml-quick-reference.md',
    data: quickRef(), purpose: 'reference', source: 'upload',
    title: 'CFML quick reference', description: 'The tags and functions this course uses, on one page.',
    visibility: 'course', tags: ['reference', 'cfml'], courseIds: [courseId],
  });
  if (assignments.length) {
    await put({
      path: paths.assignmentBrief(classA, assignments[0].id), name: 'rubric.md',
      data: rubric(), purpose: 'rubric', source: 'upload',
      title: 'How this is marked', description: '70% correctness, 30% craft, and what craft means.',
      visibility: 'class', tags: ['rubric'],
      links: [{ type: 'assignment', id: assignments[0].id, relation: 'rubric-for' }],
    });
  }

  /* --- some work, actually graded ---------------------------------------
     A teacher's first screen is worthless with an empty class, and a grading
     pipeline nobody has watched run is a grading pipeline nobody trusts. So
     three students hand in three genuinely different answers to the first
     assignment, and they go through the real grader — the same call the
     platform makes when a learner presses Check.

     The three are chosen to show the thing the marking is for: one is wrong,
     one is right but wasteful, one is right and well made. They score very
     differently on craft and identically on nothing. */
  let gradedCount = 0;
  const first = assignments[0];
  const ex = first ? exerciseByRef(first.ref) : null;
  if (ex) {
    // Two of the four take the same expensive route, which is what actually
    // happens in a class and is the case the teacher's view exists for: one
    // lesson to re-teach rather than two conversations to have.
    const attempts = [
      { user: students[0], source: wasteful(ex), note: 'right answer, expensive route' },
      { user: students[1], source: wasteful(ex), note: 'the same expensive route' },
      { user: students[2], source: ex.solution, note: 'right, and cleanly' },
      { user: students[3], source: ex.starter, note: 'not finished — the checks fail' },
    ];
    for (const a of attempts) {
      const sid = id('sub');
      insert('submissions', {
        id: sid, assignment_id: first.id, student_id: a.user, attempt: 1,
        body: a.source, status: 'submitted',
        submitted_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
      const g = autoGrade({ exercise: ex, source: a.source, at: ex.at });
      if (!g.ok) continue;
      recordGrade({
        submissionId: sid, graderType: 'auto',
        score: g.score.total, max: 100,
        correctness: g.correctness, craft: g.craft,
        feedback: g.craft.headline,
      });
      gradedCount++;
      made.graded = (made.graded || 0) + 1;
    }
  }

  const c = course();
  const indexed = c ? indexCourse(c, courseId) : 0;

  return {
    courseId, classA, classB, made, indexed, graded: gradedCount,
    password: PASSWORD,
    note: 'Every account signs in with the password "' + PASSWORD + '".',
  };
}

/* A correct answer written the expensive way: the file re-read on every pass,
   the list walked by position, the report glued together one string at a time.
   Every check passes; the craft score does not. */
function wasteful(ex) {
  if (!/timesheet/i.test(String(ex.starter || '') + String(ex.solution || ''))) return ex.solution;
  return [
    '<cffile action="read" file="timesheet.csv" variable="raw">',
    '<cfset lines = ListToArray(Trim(raw), Chr(10))>',
    '<cfset report = "">',
    '<cfset total = 0>',
    '<cfset best = "">',
    '<cfset bestHours = 0>',
    '<cfloop from="2" to="#ArrayLen(lines)#" index="i">',
    '  <cffile action="read" file="timesheet.csv" variable="again">',
    '  <cfset cells = ListToArray(ListGetAt(again, i, Chr(10)), ",")>',
    '  <cfset report = report & cells[1] & ": " & cells[2] & Chr(10)>',
    '  <cfset total = total + cells[2]>',
    '  <cfif cells[2] GT bestHours><cfset bestHours = cells[2]><cfset best = cells[1]></cfif>',
    '</cfloop>',
    '<cfoutput>#report#Total: #total#<br>Best day: #best#</cfoutput>',
  ].join('\n');
}

/* ------------------------------------------------------------------ text */

const outline = () => `# ColdFusion 501 — outline

1. The server, the request and your first page
2. Decisions, loops and collections
3. Data on the page
4. The database
5. Components and the application
6. Integration and AI
7. The case study — school finance at a fictional software company

Every unit ends with a check. Projects unlock as you go, and the capstone
is an Employee Self-Service assistant that has to survive its own outage.
`;

const quickRef = () => `# CFML quick reference

## Output
    <cfoutput>#expression#</cfoutput>     hashes only mean anything inside cfoutput
    ##                                    a literal hash

## Variables and types
    <cfset total = 0>                     a bare expression, not attributes
    a & b                                 join text. + is arithmetic.

## Control
    <cfif x GT y> … <cfelseif> … <cfelse> … </cfif>
    <cfswitch expression="#v#"><cfcase value="a"> … </cfswitch>
    <cfloop from="1" to="10" index="i">   counted
    <cfloop array="#a#" index="row">      each item
    <cfloop query="q">                    each row
    <cfloop list="#l#" index="item">      each list item — reads the string once

## Database
    <cfquery name="q" datasource="larkspur">
      SELECT … WHERE id = <cfqueryparam value="#url.id#" cfsqltype="cf_sql_integer">
    </cfquery>
    q.recordCount                         how many rows came back

A value from the request goes in a cfqueryparam. A column name cannot —
whitelist it through a cfswitch first.

## Functions
    <cffunction name="f" returntype="numeric">
      <cfargument name="x" required="true">
      <cfset var sum = 0>                 var, or it leaks into the page
      <cfreturn sum>
    </cffunction>

## Talking to a service
    <cfhttp url="…" method="post" result="r" timeout="10">
      <cfhttpparam type="body" value="#SerializeJSON(payload)#">
    </cfhttp>
    <cfif r.statusCode EQ "200 OK" AND IsJSON(r.fileContent)>   check before you parse
`;

const rubric = () => `# How this is marked

**Correctness — 70%.** Your page is run against the same checks for everybody.
Output, state, tests, mechanics. This part is not a judgement call.

**Craft — 30%.** The same code is reviewed for how it was written. The reviewer
measures your page against a reference answer on the same data: interpreter
steps, database round trips, loops. Then it looks for the patterns that make a
page slow or fragile — a query inside a loop, a file read on every pass, a
string built by gluing onto the end of itself.

A page that passes every check and makes forty database trips is a pass and a
problem, and you will be told which.

**What you are never marked down for:** anything the course has not taught yet.
The reviewer holds those back and shows them as "coming up".
`;

/* ------------------------------------------------------------------- cli */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('seed.js');
if (isMain) {
  // The demo school goes in the demo database (server/data), never in a
  // learner's or a hub's real one — unless LANTERN_DATA says otherwise.
  if (!process.env.LANTERN_DATA && !process.env.LANTERN_DB) process.env.LANTERN_MODE = 'demo';
  seed({ force: process.argv.includes('--force') }).then((out) => {
    if (out.skipped) { console.log(out.note); return; }
    console.log('\nSeeded a demo school.\n');
    console.log('  course      CFML-501');
    console.log('  classes     ' + out.made.classes.map((c) => c.code).join(', '));
    console.log('  assignments ' + out.made.assignments);
    console.log('  files       ' + out.made.files);
    console.log('  graded      ' + out.graded + ' submissions, through the real grader');
    console.log('  indexed     ' + out.indexed + ' course documents\n');
    console.log('  Sign in with any of these, password "' + out.password + '":\n');
    out.made.users.forEach((u) => console.log('    ' + u.email.padEnd(26) + u.role.padEnd(9) + u.name));
    console.log('');
  }).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
