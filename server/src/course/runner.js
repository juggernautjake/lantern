/* ===========================================================================
   server/src/course/runner.js — the studio's own engine, running on the server.
   ---------------------------------------------------------------------------
   The CFML interpreter, the assertion grader and the code reviewer are the
   same files the browser loads. They are written as plain scripts that attach
   to a global, with no DOM in them, which was the point: the server can grade
   a submission with byte-identical logic to the box the learner typed it in.

   That is not tidiness. It is the only way a mark can be defended. If the
   server graded with a second implementation, "it passed on my machine" would
   be a real complaint rather than a joke, and every disagreement between the
   two would be a support ticket nobody can resolve.

   The modules are loaded into a fresh object rather than into globalThis, so
   nothing the course defines can collide with the server.
   =========================================================================== */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.env.LANTERN_APP_DIR || join(HERE, '..', '..', '..', 'app', 'cfml');

/* Order matters and is the same order the build script uses: the SQL engine
   before the interpreter, the data before any unit, the units before the
   self-check that validates them. */
const CORE = ['sql', 'interpreter', 'errors', 'grader', 'review'];
const CONTENT = ['larkspur-data', 'dossier', 'content', 'bank', 'script-debug', 'generator', 'projects',
  'unit3', 'unit4', 'unit5', 'unit5-keys', 'unit6', 'unit7', 'unit8', 'unit9', 'capstone', 'proj-extra',
  'proj-web', 'bank-extra', 'sandbox', 'selfcheck'];

let loaded = null;
let failure = null;

export function runner(opts) {
  if (loaded) return loaded;
  if (failure && !(opts && opts.retry)) return null;
  try {
    const g = {};
    g.window = g;
    g.globalThis = g;
    const want = (opts && opts.coreOnly) ? CORE : CORE.concat(CONTENT);
    for (const name of want) {
      const file = join(APP, name + '.js');
      if (!existsSync(file)) {
        if (CORE.indexOf(name) >= 0) throw new Error('missing core module ' + name + '.js in ' + APP);
        continue;
      }
      // The modules end with (typeof window !== 'undefined' ? window : globalThis),
      // so handing them a function scope whose `window` is our sandbox is enough.
      new Function('window', 'globalThis', 'self', readFileSync(file, 'utf8')).call(g, g, g, g);
    }
    if (!g.CFML || !g.Grader || !g.CFReview) throw new Error('the course modules did not register CFML, Grader and CFReview');
    loaded = g;
    return loaded;
  } catch (e) {
    failure = e;
    // eslint-disable-next-line no-console
    console.warn('[lantern] the CFML runner did not load: ' + e.message +
      '\n           Auto-grading of code is off; everything else works.');
    return null;
  }
}

export function runnerError() { return failure ? failure.message : null; }

/* Look up one graded item by the id the studio knows it by — 'u4l2e1',
   'proj-fund-m2', 'u3checkcode'. This is what connects an assignment row in
   the database to the checks that grade it. */
export function exerciseByRef(ref) {
  const R = runner();
  if (!R || !ref) return null;

  if (R.CFContent && R.CFContent.COURSE) {
    for (const u of R.CFContent.COURSE.units) {
      for (const l of u.lessons) {
        for (const b of l.blocks || []) {
          if (b.t === 'exercise' && b.ex && b.ex.id === ref) return Object.assign({ at: l.id }, b.ex);
        }
      }
      if (u.check) {
        for (const q of u.check.code || []) if (q.id === ref) return Object.assign({ at: u.check.id }, q);
      }
    }
  }
  if (R.CFProjects) {
    for (const p of R.CFProjects.all || []) {
      for (const m of p.milestones || []) {
        if (m.id === ref) return Object.assign({ at: p.after, skills: p.skills }, m);
      }
    }
  }
  return null;
}

/* Every graded item, for seeding a class's assignment list. */
export function allExercises() {
  const R = runner();
  if (!R) return [];
  const out = [];
  if (R.CFContent && R.CFContent.COURSE) {
    R.CFContent.COURSE.units.forEach((u) => {
      u.lessons.forEach((l) => {
        (l.blocks || []).forEach((b) => {
          if (b.t === 'exercise' && b.ex) {
            out.push({ ref: b.ex.id, title: b.ex.title, kind: 'exercise', unit: u.n, at: l.id,
              prompt: b.ex.prompt, skills: b.ex.skills || [] });
          }
        });
      });
      if (u.check) {
        (u.check.code || []).forEach((q) => out.push({ ref: q.id, title: q.title, kind: 'check',
          unit: u.n, at: u.check.id, prompt: q.prompt, skills: q.skills || [] }));
      }
    });
  }
  (R.CFProjects ? R.CFProjects.all || [] : []).forEach((p) => {
    (p.milestones || []).forEach((m) => out.push({
      ref: m.id, title: p.title + ' — ' + m.title, kind: 'project-milestone',
      unit: p.unit, at: p.after, prompt: m.brief, skills: p.skills || [],
    }));
  });
  return out;
}

export function course() {
  const R = runner();
  return R && R.CFContent ? R.CFContent.COURSE : null;
}
