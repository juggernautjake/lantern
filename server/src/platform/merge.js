/* ===========================================================================
   server/src/platform/merge.js — how two copies of somebody's progress agree.
   ---------------------------------------------------------------------------
   A person can study on two computers, or offline for a week, and every copy
   must end up the same without anything being lost. The rules are chosen so
   that merging is idempotent (merging twice changes nothing) and order-free
   (A then B equals B then A), which is what makes offline safe:

     completed      once done, always done — never goes back to not done
     best           the best score wins
     attempts       the larger count wins (each copy counts its own tries)
     first_done_at  the earliest completion wins
     updated_at     the latest wins
     time           a sum over time EVENTS, each with its own id, so an event
                    that arrives twice is counted once
     position       "where I was" — the one with the newest timestamp wins

   The hub applies exactly these rules in SQL (supabase/migrations), and the
   app applies them locally when it pulls; the tests hold both to them.
   =========================================================================== */

export const ITEM_KINDS = ['lesson', 'exercise', 'milestone', 'check', 'practice'];

export function mergeItem(a, b) {
  if (!a) return normItem(b);
  if (!b) return normItem(a);
  const minNonNull = (x, y) => (x == null ? y : y == null ? x : Math.min(x, y));
  return {
    kind: a.kind || b.kind,
    ref: a.ref || b.ref,
    completed: !!(a.completed || b.completed),
    best: Math.max(Number(a.best) || 0, Number(b.best) || 0),
    attempts: Math.max(Number(a.attempts) || 0, Number(b.attempts) || 0),
    first_done_at: minNonNull(num(a.first_done_at), num(b.first_done_at)),
    updated_at: Math.max(num(a.updated_at) || 0, num(b.updated_at) || 0),
  };
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
export function normItem(x) {
  if (!x) return null;
  return {
    kind: x.kind, ref: x.ref, completed: !!x.completed,
    best: Number(x.best) || 0, attempts: Number(x.attempts) || 0,
    first_done_at: num(x.first_done_at), updated_at: num(x.updated_at) || 0,
  };
}

/* Two lists of items, keyed by kind+ref. */
export function mergeItems(listA, listB) {
  const out = new Map();
  for (const x of [].concat(listA || [], listB || [])) {
    if (!x || !x.ref) continue;
    const k = x.kind + ':' + x.ref;
    out.set(k, mergeItem(out.get(k), x));
  }
  return [...out.values()];
}

/* Did merging `incoming` into `current` change anything? */
export function itemChanged(current, merged) {
  if (!current) return true;
  return current.completed !== merged.completed || current.best !== merged.best ||
    current.attempts !== merged.attempts || current.first_done_at !== merged.first_done_at;
}

export function mergePosition(a, b) {
  if (!a || !a.at) return b || null;
  if (!b || !b.at) return a;
  return Number(b.at) > Number(a.at) ? b : a;
}

/* Time events: [{ id, seconds }] → total, each id once. */
export function totalSeconds(events) {
  const seen = new Map();
  for (const e of events || []) if (e && e.id && !seen.has(e.id)) seen.set(e.id, Math.max(0, Number(e.seconds) || 0));
  let t = 0;
  for (const v of seen.values()) t += v;
  return t;
}
