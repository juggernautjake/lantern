/* ===========================================================================
   server/src/platform/progress.js — a person's progress in a course, kept
   safe on this computer first.
   ---------------------------------------------------------------------------
   A course pack keeps its own state in the browser (the storage keys its
   manifest declares). The player page hands every change of those keys to
   this module, which:

     1  keeps the state itself (so a new browser, a cleared cache or a new
        computer gets it back), with a history of every state it replaced
     2  reads PROGRESS ITEMS out of it — lessons finished, exercises passed,
        milestones reached — using the manifest's "progress" map, and merges
        them into progress_items by the rules in merge.js (dirty = not yet
        sent to the hub)
     3  turns the pack's own time counter into time EVENTS with ids
     4  notes where the person is (the position)

   Going the other way, applyItems() writes merged completions back INTO the
   pack's state before the player loads it, so work done on another computer
   shows up as done — without the pack having to know anything about sync.

   Nothing here needs the network. The hub sync (sync/engine.js) reads what is
   dirty and marks it clean when the hub has it.
   =========================================================================== */

import { randomUUID } from 'node:crypto';
import { one, all, run, json, tx } from '../db/db.js';
import { mergeItem, itemChanged, normItem } from './merge.js';

const nowMs = () => Date.now();

/* --------------------------------------------------------- the manifest --- */

/* The storage keys a pack owns. */
export const storageKeys = (manifest) => ((manifest && manifest.storage && manifest.storage.keys) || []).slice();

/* Every id a learner can make progress on, from the manifest's units. */
export function structure(manifest) {
  const units = (manifest.units || []).map((u) => ({
    id: u.id, n: u.n, title: u.title,
    lessons: (u.lessons || []).map((l) => ({ id: l.id, title: l.title, minutes: l.minutes || 0, exercises: l.exercises || [] })),
    check: u.check || null,
    projects: (u.projects || []).map((p) => ({ id: p.id, title: p.title, minutes: p.minutes || 0, milestones: p.milestones || [] })),
  }));
  return units;
}

/* Every stable id in a manifest (lessons, checks, exercises, milestones). */
export function allIds(manifest) {
  const ids = new Set((manifest.lessons || []).map((l) => l.id));
  for (const u of structure(manifest)) {
    u.lessons.forEach((l) => { ids.add(l.id); l.exercises.forEach((e) => ids.add(e.id)); });
    if (u.check) ids.add(u.check.id);
    u.projects.forEach((p) => { ids.add(p.id); p.milestones.forEach((m) => ids.add(m.id)); });
  }
  return ids;
}

/* The pack's main state object (the storage key named by progress.key). */
function mainState(manifest, keys) {
  const p = manifest.progress;
  if (!p || !p.key || !keys || typeof keys[p.key] !== 'string') return null;
  try { return JSON.parse(keys[p.key]); } catch (e) { return null; }
}

/* Progress items read out of a pack's state. */
export function deriveItems(manifest, keys) {
  const p = manifest.progress || {};
  const S = mainState(manifest, keys);
  if (!S) return [];
  const out = [];
  const at = (v) => (typeof v === 'number' ? v : null);
  const checkIds = new Set(structure(manifest).map((u) => u.check && u.check.id).filter(Boolean));
  const lessons = S[p.lessons || 'lessons'] || {};
  for (const [ref, v] of Object.entries(lessons)) {
    const done = !!(v && v[p.lessonDone || 'done']);
    if (!done) continue;
    out.push({ kind: checkIds.has(ref) ? 'check' : 'lesson', ref, completed: true, best: 0, attempts: 0, first_done_at: at(v.at), updated_at: at(v.at) || 0 });
  }
  const ex = S[p.exercises || 'exercises'] || {};
  for (const [ref, v] of Object.entries(ex)) {
    if (!v) continue;
    out.push({ kind: 'exercise', ref, completed: !!v[p.exercisePassed || 'passed'], best: Number(v[p.exerciseBest || 'best']) || 0,
      attempts: Number(v[p.exerciseAttempts || 'attempts']) || 0, first_done_at: at(v.firstPassAt), updated_at: at(v.lastAt) || 0 });
  }
  const ms = S[p.milestones || 'projects'] || {};
  for (const [ref, v] of Object.entries(ms)) {
    if (!v) continue;
    out.push({ kind: 'milestone', ref, completed: !!v[p.milestonePassed || 'passed'], best: 0,
      attempts: Number(v.attempts) || 0, first_done_at: at(v.at), updated_at: at(v.at) || 0 });
  }
  return out;
}

/* Write completions back into the pack's state. Returns { keys, changed }. */
export function applyItems(manifest, keys, items) {
  const p = manifest.progress;
  if (!p || !p.key) return { keys, changed: false };
  const S = mainState(manifest, keys) || (p.stateVersion ? { v: p.stateVersion } : {});
  let changed = false;
  const L = p.lessons || 'lessons', E = p.exercises || 'exercises', M = p.milestones || 'projects';
  S[L] = S[L] || {}; S[E] = S[E] || {}; S[M] = S[M] || {};
  for (const it of items || []) {
    if (!it || !it.ref) continue;
    if ((it.kind === 'lesson' || it.kind === 'check') && it.completed) {
      const cur = S[L][it.ref];
      if (!cur || !cur[p.lessonDone || 'done']) { S[L][it.ref] = { [p.lessonDone || 'done']: true, at: it.first_done_at || it.updated_at || null }; changed = true; }
    } else if (it.kind === 'exercise') {
      const cur = S[E][it.ref] || { attempts: 0, passed: false, hints: 0, firstPassAt: null, lastAt: null, best: 0 };
      const next = Object.assign({}, cur);
      if (it.completed && !cur[p.exercisePassed || 'passed']) { next[p.exercisePassed || 'passed'] = true; next.firstPassAt = it.first_done_at || it.updated_at || null; }
      next[p.exerciseBest || 'best'] = Math.max(Number(cur[p.exerciseBest || 'best']) || 0, Number(it.best) || 0);
      next[p.exerciseAttempts || 'attempts'] = Math.max(Number(cur[p.exerciseAttempts || 'attempts']) || 0, Number(it.attempts) || 0);
      if (JSON.stringify(next) !== JSON.stringify(cur) || !S[E][it.ref]) { S[E][it.ref] = next; changed = true; }
    } else if (it.kind === 'milestone' && it.completed) {
      const cur = S[M][it.ref];
      if (!cur || !cur[p.milestonePassed || 'passed']) {
        S[M][it.ref] = { attempts: Math.max((cur && cur.attempts) || 0, it.attempts || 0, 1), [p.milestonePassed || 'passed']: true, at: it.first_done_at || it.updated_at || null };
        changed = true;
      }
    }
  }
  if (!changed) return { keys, changed: false };
  return { keys: Object.assign({}, keys, { [p.key]: JSON.stringify(S) }), changed: true };
}

/* The pack's own time counter and position. */
function counters(manifest, keys) {
  const p = manifest.progress || {};
  const S = mainState(manifest, keys);
  if (!S) return { seconds: 0, position: null };
  return { seconds: Number(S[p.seconds || 'seconds']) || 0, position: S[p.position || 'lastPage'] || null };
}

/* Point the pack at a page before it loads ("open this lesson"). */
export function withPosition(manifest, keys, ref) {
  const p = manifest.progress;
  if (!p || !p.key || !ref) return keys;
  // A new state carries the pack's own format version, or the pack would
  // treat it as an old format and drop what is in it.
  const S = mainState(manifest, keys) || (p.stateVersion ? { v: p.stateVersion } : {});
  S[p.position || 'lastPage'] = ref;
  return Object.assign({}, keys, { [p.key]: JSON.stringify(S) });
}

/* ----------------------------------------------------------------- rows --- */

function row(userId, packId) {
  return one('SELECT * FROM pack_progress WHERE user_id = ? AND pack_id = ?', userId, packId);
}
function ensureRow(userId, packId) {
  run('INSERT OR IGNORE INTO pack_progress (user_id, pack_id) VALUES (?, ?)', userId, packId);
  return row(userId, packId);
}

export function savedAt(userId, packId) {
  const r = row(userId, packId);
  return r ? r.saved_at : 0;
}

export function items(userId, packId) {
  return all('SELECT kind, ref, completed, best, attempts, first_done_at, updated_at, dirty FROM progress_items WHERE user_id = ? AND pack_id = ?', userId, packId)
    .map((r) => ({ kind: r.kind, ref: r.ref, completed: !!r.completed, best: r.best, attempts: r.attempts, first_done_at: r.first_done_at, updated_at: r.updated_at, dirty: !!r.dirty }));
}

/* Merge items in. markDirty: these came from this computer (so the hub needs
   them); false when they came from the hub. Returns the items that changed. */
export function mergeIn(userId, packId, list, markDirty) {
  const changed = [];
  tx(() => {
    for (const it of list || []) {
      if (!it || !it.ref || !it.kind) continue;
      const cur = one('SELECT * FROM progress_items WHERE user_id=? AND pack_id=? AND kind=? AND ref=?', userId, packId, it.kind, it.ref);
      const curItem = cur ? { kind: cur.kind, ref: cur.ref, completed: !!cur.completed, best: cur.best, attempts: cur.attempts, first_done_at: cur.first_done_at, updated_at: cur.updated_at } : null;
      const m = mergeItem(curItem, it);
      if (!itemChanged(curItem, m)) continue;
      // Dirty when this computer knows something the hub may not.
      const dirty = markDirty ? 1 : (cur && cur.dirty && itemChanged(normItem(it), m) ? 1 : 0);
      run(`INSERT INTO progress_items (user_id, pack_id, kind, ref, completed, best, attempts, first_done_at, updated_at, dirty)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(user_id, pack_id, kind, ref) DO UPDATE SET completed=excluded.completed, best=excluded.best,
             attempts=excluded.attempts, first_done_at=excluded.first_done_at, updated_at=excluded.updated_at, dirty=excluded.dirty`,
      userId, packId, m.kind, m.ref, m.completed ? 1 : 0, m.best, m.attempts, m.first_done_at, m.updated_at || nowMs(), dirty);
      changed.push(Object.assign({ was: curItem }, m));
    }
  });
  return changed;
}

/* ---------------------------------------------------------------- state --- */

/* The state the player should load: the saved keys, with every completion
   this computer knows about written back in, and (optionally) a position. */
export function stateForPlayer(userId, pack, opts) {
  const o = opts || {};
  const r = row(userId, pack.id);
  let keys = r ? json(r.state_json, {}) : {};
  const applied = applyItems(pack.manifest, keys, items(userId, pack.id));
  keys = applied.keys;
  if (o.open) keys = withPosition(pack.manifest, keys, o.open);
  return { keys, savedAt: r ? r.saved_at : 0, applied: applied.changed };
}

/* The learner opened a lesson (the course page's Start/Continue, the
   assistant, Dayspring): that is where they are now, even before the course
   saves anything, so "continue" and "what's next" follow them at once. */
export function openAt(userId, pack, ref) {
  if (!ref || !allIds(pack.manifest).has(ref)) return false;
  const cur = ensureRow(userId, pack.id);
  const pos = json(cur.position_json, null);
  if (pos && pos.ref === ref) return false;
  run('UPDATE pack_progress SET position_json=? WHERE user_id=? AND pack_id=?', JSON.stringify({ ref, at: nowMs() }), userId, pack.id);
  return true;
}

/* A new state from the player. Returns { savedAt, changed: [items], events: [...] }.
   Older than what is stored (savedAt) is refused so a stale tab can never
   overwrite newer work; the caller gets the newer state back instead. */
export function saveState(userId, pack, body, opts) {
  const o = opts || {};
  const want = new Set(storageKeys(pack.manifest));
  const incoming = {};
  for (const [k, v] of Object.entries((body && body.keys) || {})) if (want.has(k) && typeof v === 'string') incoming[k] = v;
  const savedAt = Number(body && body.savedAt) || nowMs();
  const cur = ensureRow(userId, pack.id);
  if (!o.force && cur.saved_at && savedAt < cur.saved_at) {
    return { stale: true, savedAt: cur.saved_at, keys: json(cur.state_json, {}) };
  }
  const prevKeys = json(cur.state_json, {});
  const keys = o.replace ? incoming : Object.assign({}, prevKeys, incoming);
  if (o.reason && Object.keys(prevKeys).length) {
    run('INSERT INTO pack_progress_history (user_id, pack_id, state_json, saved_at, reason) VALUES (?,?,?,?,?)',
      userId, pack.id, cur.state_json, cur.saved_at, o.reason);
  }

  const events = [];
  const { seconds, position } = counters(pack.manifest, keys);
  let secondsSeen = cur.seconds_seen || 0;
  // Time: the pack counts up; each increase becomes one event with its own id.
  if (seconds > secondsSeen) {
    const add = seconds - secondsSeen;
    run('INSERT INTO progress_events (id, user_id, pack_id, kind, ref, data_json, at) VALUES (?,?,?,?,?,?,?)',
      (o.eventId || randomUUID()), userId, pack.id, 'time', null, JSON.stringify({ seconds: add }), savedAt);
    secondsSeen = seconds;
  } else if (seconds < secondsSeen) {
    secondsSeen = seconds;   // a reset in the pack: nothing to count, start again from here
  }
  let pos = json(cur.position_json, null);
  if (position && (!pos || pos.ref !== position)) {
    pos = { ref: position, at: savedAt };
    events.push({ kind: 'opened', ref: position, at: savedAt });
  }
  run(`UPDATE pack_progress SET state_json=?, saved_at=?, seconds_seen=?, position_json=?, updated_at=datetime('now')
       WHERE user_id=? AND pack_id=?`, JSON.stringify(keys), savedAt, secondsSeen, pos ? JSON.stringify(pos) : null, userId, pack.id);

  const changed = mergeIn(userId, pack.id, deriveItems(pack.manifest, keys), true);
  for (const c of changed) {
    if (c.completed && !(c.was && c.was.completed)) {
      const id = randomUUID();
      run('INSERT INTO progress_events (id, user_id, pack_id, kind, ref, data_json, at) VALUES (?,?,?,?,?,?,?)',
        id, userId, pack.id, 'completed', c.ref, JSON.stringify({ kind: c.kind }), savedAt);
      events.push({ kind: 'completed', itemKind: c.kind, ref: c.ref, at: savedAt });
    }
  }
  return { savedAt, changed, events, keys };
}

/* "Import progress from the web version": the studio's own backup text,
   { lantern: 'backup', version, at, keys }. The state it replaces is kept in
   the history, and completions already recorded here are never lost (they
   are merged back in by stateForPlayer). */
export function importBackup(userId, pack, backup) {
  let b = backup;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { throw Object.assign(new Error('That is not a backup — it could not be read.'), { status: 400 }); } }
  if (!b || b.lantern !== 'backup' || !b.keys || typeof b.keys !== 'object') {
    throw Object.assign(new Error('That is not a Lantern backup. On the web version, open Progress and press "Make a backup", then copy all of the text.'), { status: 400 });
  }
  const want = storageKeys(pack.manifest);
  const keys = {};
  for (const k of want) if (typeof b.keys[k] === 'string') keys[k] = b.keys[k];
  if (!Object.keys(keys).length) {
    throw Object.assign(new Error('That backup has no progress for ' + pack.title + '.'), { status: 400 });
  }
  // Keep whatever this computer has that the backup lacks (e.g. appearance).
  const cur = row(userId, pack.id);
  const merged = Object.assign({}, cur ? json(cur.state_json, {}) : {}, keys);
  // The imported time counter is new time for this computer: count it once.
  run('UPDATE pack_progress SET seconds_seen = 0 WHERE user_id = ? AND pack_id = ?', userId, pack.id);
  const out = saveState(userId, pack, { keys: merged, savedAt: nowMs() }, { force: true, replace: true, reason: 'before import' });
  return Object.assign(out, { imported: Object.keys(keys) });
}

export function history(userId, packId) {
  return all('SELECT id, saved_at, reason, at, length(state_json) AS size FROM pack_progress_history WHERE user_id = ? AND pack_id = ? ORDER BY id DESC LIMIT 50', userId, packId);
}

export function restore(userId, pack, historyId) {
  const h = one('SELECT * FROM pack_progress_history WHERE id = ? AND user_id = ? AND pack_id = ?', historyId, userId, pack.id);
  if (!h) throw Object.assign(new Error('That saved copy was not found.'), { status: 404 });
  return saveState(userId, pack, { keys: json(h.state_json, {}), savedAt: nowMs() }, { force: true, replace: true, reason: 'before restore' });
}

/* ------------------------------------------------------------- overview --- */
/* Everything the course page shows: every unit with its lessons, exercises,
   projects and check, each with a status; the overall percentage; what to do
   next; the time left. */
export function overview(userId, pack) {
  const m = pack.manifest;
  const its = items(userId, pack.id);
  const by = new Map(its.map((i) => [i.kind + ':' + i.ref, i]));
  const r = row(userId, pack.id);
  const pos = r ? json(r.position_json, null) : null;
  // A unit check may have been recorded as a lesson by an older copy: either counts.
  const done = (kind, ref) => !!((by.get(kind + ':' + ref) && by.get(kind + ':' + ref).completed) || (kind === 'check' && by.get('lesson:' + ref) && by.get('lesson:' + ref).completed));
  const tried = (kind, ref) => { const x = by.get(kind + ':' + ref); return !!(x && (x.attempts > 0 || x.completed)); };

  /* ONE measure everywhere (this page, the player bar, the assistant, the
     owner's dashboard, Dayspring, and the course's own header): STEPS.
     Every lesson, exercise, project milestone and unit check is one step:
     "12 of 174 steps · 8 of 54 lessons". */
  let count = 0, finished = 0, minutesTotal = 0, minutesLeft = 0, lessonsTotal = 0, lessonsDone = 0;
  const order = [];      // the places to go, in course order: lessons, projects, checks
  const units = structure(m).map((u) => {
    let uDone = 0, uCount = 0;
    const step = (isDone) => { count++; uCount++; if (isDone) { finished++; uDone++; } };
    const lessons = u.lessons.map((l) => {
      const exercises = l.exercises.map((e) => { const d = done('exercise', e.id); step(d); return { id: e.id, title: e.title, status: d ? 'done' : tried('exercise', e.id) ? 'in-progress' : 'not-started' }; });
      const isDone = done('lesson', l.id);
      const status = isDone ? 'done' : (exercises.some((e) => e.status !== 'not-started') || (pos && pos.ref === l.id)) ? 'in-progress' : 'not-started';
      step(isDone); lessonsTotal++; if (isDone) lessonsDone++;
      minutesTotal += l.minutes; if (!isDone) minutesLeft += l.minutes;
      order.push({ id: l.id, title: l.title, kind: 'lesson', done: isDone });
      return { id: l.id, title: l.title, minutes: l.minutes, status, exercises };
    });
    const projects = u.projects.map((p) => {
      const ms = p.milestones.map((x) => { const d = done('milestone', x.id); step(d); return { id: x.id, title: x.title, status: d ? 'done' : tried('milestone', x.id) ? 'in-progress' : 'not-started' }; });
      const allDone = ms.length > 0 && ms.every((x) => x.status === 'done');
      minutesTotal += p.minutes; if (!allDone) minutesLeft += p.minutes;
      order.push({ id: p.id, title: p.title, kind: 'project', done: allDone });
      return { id: p.id, title: p.title, minutes: p.minutes, milestones: ms, status: allDone ? 'done' : ms.some((x) => x.status !== 'not-started') ? 'in-progress' : 'not-started' };
    });
    let check = null;
    if (u.check) {
      const cd = done('check', u.check.id);
      step(cd);
      const mins = u.check.minutes || 30;
      minutesTotal += mins; if (!cd) minutesLeft += mins;
      order.push({ id: u.check.id, title: u.check.title, kind: 'check', done: cd });
      check = { id: u.check.id, title: u.check.title, minutes: mins, status: cd ? 'done' : 'not-started' };
    }
    return { id: u.id, n: u.n, title: u.title, lessons, projects, check, done: uDone, count: uCount };
  });
  // never "100%" before the last step, never "0%" after the first
  const percent = count ? (finished === count ? 100 : Math.max(finished ? 1 : 0, Math.floor((finished / count) * 100))) : 0;
  const started = its.length > 0 || !!pos;
  const seconds = Math.max(r ? r.hub_seconds : 0, localSeconds(userId, pack.id));
  // Where the learner is, and what comes AFTER it: the first unfinished place
  // following the current one (else the first unfinished place anywhere else).
  const at = pos && pos.ref ? order.findIndex((x) => x.id === pos.ref) : -1;
  const pick = (x) => (x ? { id: x.id, title: x.title, kind: x.kind } : null);
  const next = pick((at >= 0 ? order.slice(at + 1).find((x) => !x.done) : null) || order.find((x, i) => !x.done && i !== at) || null);
  const here = at >= 0 ? order[at] : null;
  return {
    id: pack.id, title: m.title, description: m.description || '', level: m.level || '', version: pack.version,
    units, percent, finished, count, started,
    steps: { done: finished, total: count }, lessons: { done: lessonsDone, total: lessonsTotal },
    // "Continue": where they were, unless that is finished (then what is next)
    continue: here ? (here.done ? next : pick(here)) : (pos && pos.ref ? { id: pos.ref, title: titleOf(m, pos.ref) } : null),
    current: here ? pick(here) : null,
    next, minutesTotal, minutesLeft, seconds,
  };
}

/* "12 of 174 steps · 8 of 54 lessons" */
export const measure = (ov) => ov.finished + ' of ' + ov.count + ' steps · ' + ov.lessons.done + ' of ' + ov.lessons.total + ' lessons';

export const titleFor = (m, ref) => titleOf(m, ref);

function titleOf(m, ref) {
  for (const u of structure(m)) {
    for (const l of u.lessons) if (l.id === ref) return l.title;
    if (u.check && u.check.id === ref) return u.check.title;
    for (const p of u.projects) if (p.id === ref) return p.title;
  }
  return ref;
}

export function localSeconds(userId, packId) {
  const r = one("SELECT COALESCE(SUM(json_extract(data_json, '$.seconds')), 0) AS s FROM progress_events WHERE user_id=? AND pack_id=? AND kind='time'", userId, packId);
  return Number(r.s) || 0;
}

/* The short version, for the course list, Dayspring and the hub. */
export function summary(userId, pack) {
  const o = overview(userId, pack);
  const r = row(userId, pack.id);
  const pos = r ? json(r.position_json, null) : null;
  return { id: pack.id, title: o.title, percent: o.percent, finished: o.finished, count: o.count, steps: o.steps, lessons: o.lessons, measure: measure(o),
    next: o.next, current: pos ? { ref: pos.ref, title: titleOf(pack.manifest, pos.ref), at: pos.at } : null,
    minutesLeft: o.minutesLeft, seconds: o.seconds, started: o.started };
}

/* ------------------------------------------------------------ for sync --- */

export function pending(userId, packId) {
  const r = row(userId, packId);
  return {
    items: items(userId, packId).filter((i) => i.dirty).map(({ dirty, ...i }) => i),
    time: all("SELECT id, json_extract(data_json, '$.seconds') AS seconds, at FROM progress_events WHERE user_id=? AND pack_id=? AND kind='time' AND synced=0", userId, packId),
    position: r && r.position_json && (json(r.position_json, {}).at || 0) > r.position_synced_at ? json(r.position_json, null) : null,
    snapshot: r && r.saved_at > r.snapshot_synced_at ? { keys: json(r.state_json, {}), at: r.saved_at } : null,
  };
}

export function markSynced(userId, packId, sent) {
  tx(() => {
    for (const i of sent.items || []) {
      run('UPDATE progress_items SET dirty = 0 WHERE user_id=? AND pack_id=? AND kind=? AND ref=? AND completed=? AND best=? AND attempts=?',
        userId, packId, i.kind, i.ref, i.completed ? 1 : 0, i.best, i.attempts);
    }
    for (const t of sent.time || []) run('UPDATE progress_events SET synced = 1 WHERE id = ?', t.id);
    if (sent.position) run('UPDATE pack_progress SET position_synced_at = ? WHERE user_id=? AND pack_id=?', sent.position.at, userId, packId);
    if (sent.snapshot) run('UPDATE pack_progress SET snapshot_synced_at = ? WHERE user_id=? AND pack_id=?', sent.snapshot.at, userId, packId);
  });
}

/* What the hub sent back: merged items, the total time, the newest position
   and (when newer than anything here and nothing here is unsent) the newest
   whole state from another computer. */
export function applyRemote(userId, pack, remote) {
  ensureRow(userId, pack.id);
  const changed = mergeIn(userId, pack.id, remote.items || [], false);
  const r = row(userId, pack.id);
  if (remote.seconds != null) run('UPDATE pack_progress SET hub_seconds = ? WHERE user_id=? AND pack_id=?', Number(remote.seconds) || 0, userId, pack.id);
  if (remote.position && remote.position.at) {
    const cur = json(r.position_json, null);
    if (!cur || Number(remote.position.at) > Number(cur.at || 0)) {
      run('UPDATE pack_progress SET position_json = ?, position_synced_at = ? WHERE user_id=? AND pack_id=?',
        JSON.stringify(remote.position), Number(remote.position.at), userId, pack.id);
    }
  }
  let replaced = false;
  const snap = remote.snapshot;
  if (snap && snap.keys && Number(snap.at) > r.saved_at && r.saved_at <= r.snapshot_synced_at) {
    // This computer has nothing unsent, and another has a newer copy: take it
    // (keeping ours in the history), then let the merged items fill it in.
    // Its time was counted on the computer that spent it, so it is not new here.
    run('UPDATE pack_progress SET seconds_seen = ? WHERE user_id=? AND pack_id=?', counters(pack.manifest, snap.keys).seconds, userId, pack.id);
    saveState(userId, pack, { keys: snap.keys, savedAt: Number(snap.at) }, { force: true, replace: true, reason: 'newer copy from another computer' });
    run('UPDATE pack_progress SET snapshot_synced_at = saved_at WHERE user_id=? AND pack_id=?', userId, pack.id);
    // The copy's completions were read out as new; those the hub already has
    // are not.
    const hubHas = new Map((remote.items || []).map((i) => [i.kind + ':' + i.ref, i]));
    for (const it of items(userId, pack.id).filter((i) => i.dirty)) {
      const h = hubHas.get(it.kind + ':' + it.ref);
      if (h && !itemChanged(mergeItem(h, h), mergeItem(h, it))) {
        run('UPDATE progress_items SET dirty = 0 WHERE user_id=? AND pack_id=? AND kind=? AND ref=?', userId, pack.id, it.kind, it.ref);
      }
    }
    replaced = true;
  }
  return { changed, replaced };
}
