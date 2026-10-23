/* ===========================================================================
   server/src/assistant/teach/draw.js — the drawing spec, checked.
   ---------------------------------------------------------------------------
   When nothing built fits (a niche question only), the model returns a small
   declarative drawing: data, never code. This file is the gate: a spec that is
   malformed or too big is refused with a reason the model can fix; one that
   passes is normalised (only known fields, clipped text, numbers rounded) and
   sent to the page, where app/course/drawing.js draws it with the course's
   look. The renderer checks again: it never trusts what it is given.

   Spec (y points up, angles are degrees counter-clockwise from +x):
     { view?: {x,y,w,h},                      // default 0 0 400 300
       items: [ item … ],                     // at most 80
       steps?: [ {say?, show?:[part…], hl?:[part…]} … ] }   // at most 16
   item = { t, part?, … } with t one of
     point  {x,y,label?}        line   {x1,y1,x2,y2,dash?}
     arc    {cx,cy,r,from,to}   polygon {pts:[[x,y]…],fill?}
     dim    {x1,y1,x2,y2,text,off?}   angle {x,y,r?,from,to,text?}
     label  {x,y,text,anchor?}  symbol  {kind,x,y,size?}
     grid   {x,y,w,h,step}      axes    {x,y,w,h,xlabel?,ylabel?}
      arrow  {x1,y1,x2,y2,text?,dash?}   circle {cx,cy,r,fill?,dash?}
     curve  {x1,y1,cx,cy,x2,y2,text?}   (quadratic: c is the control point; a parabola, a river)
     table  {x,y,rows:[[cell…]],colw?,rowh?,head?}   (≤ 8 rows of ≤ 5 cells)
     timeline {x1,y1,x2,y2,marks:[{at 0..1,text}]}   (≤ 10 marks, alternate above and below)
     line also takes text (set along the line, turned with it: a bearing or a length) and arrow;
     polygon fill may be true or "hatch" (a hatched region: cut, fill, a strip of accretion);
     symbol kinds: instrument rod north monument benchmark tripod target pin satellite prism antenna
   A part is a name (letters, digits, - _) shared by items; parts named in a
   step's show start hidden and appear at that step; hl pulses them.

   A derivation is ordered steps of maths: { steps: [{math, say?}] } (≤ 12).
   =========================================================================== */

export const LIMITS = { bytes: 9000, items: 80, steps: 16, text: 60, say: 200, math: 140, derive: 12, coord: 5000, pts: 40, parts: 40, rows: 8, cols: 5, marks: 10 };
const T = ['point', 'line', 'arc', 'polygon', 'dim', 'angle', 'label', 'symbol', 'grid', 'axes', 'arrow', 'circle', 'curve', 'table', 'timeline'];
const SYMBOLS = ['instrument', 'rod', 'north', 'monument', 'benchmark', 'tripod', 'target', 'pin', 'satellite', 'prism', 'antenna'];
const PART = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const num = (v, errs, where) => { const n = Number(v); if (!Number.isFinite(n) || Math.abs(n) > LIMITS.coord) { errs.push(where + ' must be a number within ±' + LIMITS.coord); return 0; } return Math.round(n * 100) / 100; };
const txt = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function validateDrawing(input) {
  const errs = [];
  let raw = input;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { return { ok: false, errors: ['The spec is not valid JSON.'] }; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['The spec must be an object with items.'] };
  if (JSON.stringify(raw).length > LIMITS.bytes) return { ok: false, errors: ['The spec is too large (over ' + LIMITS.bytes + ' bytes). Draw less: only what the point needs.'] };
  const items = Array.isArray(raw.items) ? raw.items : null;
  if (!items || !items.length) return { ok: false, errors: ['items must be a non-empty list.'] };
  if (items.length > LIMITS.items) return { ok: false, errors: ['At most ' + LIMITS.items + ' items; there are ' + items.length + '.'] };
  const out = { items: [] };
  const v = raw.view || {};
  out.view = { x: num(v.x == null ? 0 : v.x, errs, 'view.x'), y: num(v.y == null ? 0 : v.y, errs, 'view.y'), w: Math.max(10, num(v.w == null ? 400 : v.w, errs, 'view.w')), h: Math.max(10, num(v.h == null ? 300 : v.h, errs, 'view.h')) };
  const parts = new Set();
  items.forEach((it, i) => {
    const w = 'items[' + i + ']';
    if (!it || typeof it !== 'object' || !T.includes(it.t)) { errs.push(w + '.t must be one of ' + T.join(', ')); return; }
    const o = { t: it.t };
    if (it.part != null && it.part !== '') { if (!PART.test(String(it.part))) errs.push(w + '.part must be a name of letters, digits, - or _'); else { o.part = String(it.part); parts.add(o.part); } }
    switch (it.t) {
      case 'point': o.x = num(it.x, errs, w + '.x'); o.y = num(it.y, errs, w + '.y'); if (it.label != null) o.label = txt(it.label, LIMITS.text); break;
      case 'line': o.x1 = num(it.x1, errs, w + '.x1'); o.y1 = num(it.y1, errs, w + '.y1'); o.x2 = num(it.x2, errs, w + '.x2'); o.y2 = num(it.y2, errs, w + '.y2'); if (it.dash) o.dash = true; if (it.arrow) o.arrow = true; if (it.text != null) o.text = txt(it.text, LIMITS.text); break;
      case 'arc': o.cx = num(it.cx, errs, w + '.cx'); o.cy = num(it.cy, errs, w + '.cy'); o.r = Math.abs(num(it.r, errs, w + '.r')); o.from = num(it.from, errs, w + '.from'); o.to = num(it.to, errs, w + '.to'); break;
      case 'polygon': {
        if (!Array.isArray(it.pts) || it.pts.length < 3 || it.pts.length > LIMITS.pts) { errs.push(w + '.pts needs 3 to ' + LIMITS.pts + ' points'); break; }
        o.pts = it.pts.map((p, k) => (Array.isArray(p) ? [num(p[0], errs, w + '.pts[' + k + '][0]'), num(p[1], errs, w + '.pts[' + k + '][1]')] : (errs.push(w + '.pts[' + k + '] must be [x, y]'), [0, 0])));
        if (it.fill) o.fill = it.fill === 'hatch' ? 'hatch' : true; break;
      }
      case 'dim': o.x1 = num(it.x1, errs, w + '.x1'); o.y1 = num(it.y1, errs, w + '.y1'); o.x2 = num(it.x2, errs, w + '.x2'); o.y2 = num(it.y2, errs, w + '.y2'); o.text = txt(it.text, LIMITS.text); o.off = it.off == null ? 14 : Math.max(-80, Math.min(80, num(it.off, errs, w + '.off'))); break;
      case 'angle': o.x = num(it.x, errs, w + '.x'); o.y = num(it.y, errs, w + '.y'); o.r = Math.max(4, Math.min(200, it.r == null ? 24 : num(it.r, errs, w + '.r'))); o.from = num(it.from, errs, w + '.from'); o.to = num(it.to, errs, w + '.to'); if (it.text != null) o.text = txt(it.text, LIMITS.text); break;
      case 'label': o.x = num(it.x, errs, w + '.x'); o.y = num(it.y, errs, w + '.y'); o.text = txt(it.text, LIMITS.text); if (!o.text) errs.push(w + '.text is empty'); o.anchor = ['start', 'middle', 'end'].includes(it.anchor) ? it.anchor : 'middle'; break;
      case 'symbol': if (!SYMBOLS.includes(it.kind)) { errs.push(w + '.kind must be one of ' + SYMBOLS.join(', ')); break; } o.kind = it.kind; o.x = num(it.x, errs, w + '.x'); o.y = num(it.y, errs, w + '.y'); o.size = Math.max(6, Math.min(120, it.size == null ? 24 : num(it.size, errs, w + '.size'))); break;
      case 'grid': o.x = num(it.x, errs, w + '.x'); o.y = num(it.y, errs, w + '.y'); o.w = Math.abs(num(it.w, errs, w + '.w')); o.h = Math.abs(num(it.h, errs, w + '.h')); o.step = Math.max(1, Math.abs(num(it.step == null ? 50 : it.step, errs, w + '.step'))); if (o.w / o.step > 60 || o.h / o.step > 60) errs.push(w + ' has too many grid lines; use a larger step'); break;
      case 'axes': o.x = num(it.x, errs, w + '.x'); o.y = num(it.y, errs, w + '.y'); o.w = Math.abs(num(it.w, errs, w + '.w')); o.h = Math.abs(num(it.h, errs, w + '.h')); if (it.xlabel != null) o.xlabel = txt(it.xlabel, 24); if (it.ylabel != null) o.ylabel = txt(it.ylabel, 24); break;
      case 'arrow': o.x1 = num(it.x1, errs, w + '.x1'); o.y1 = num(it.y1, errs, w + '.y1'); o.x2 = num(it.x2, errs, w + '.x2'); o.y2 = num(it.y2, errs, w + '.y2'); if (it.text != null) o.text = txt(it.text, LIMITS.text); if (it.dash) o.dash = true; break;
      case 'circle': o.cx = num(it.cx, errs, w + '.cx'); o.cy = num(it.cy, errs, w + '.cy'); o.r = Math.abs(num(it.r, errs, w + '.r')); if (it.fill) o.fill = true; if (it.dash) o.dash = true; break;
      case 'curve': o.x1 = num(it.x1, errs, w + '.x1'); o.y1 = num(it.y1, errs, w + '.y1'); o.cx = num(it.cx, errs, w + '.cx'); o.cy = num(it.cy, errs, w + '.cy'); o.x2 = num(it.x2, errs, w + '.x2'); o.y2 = num(it.y2, errs, w + '.y2'); if (it.dash) o.dash = true; if (it.text != null) o.text = txt(it.text, LIMITS.text); break;
      case 'table': {
        if (!Array.isArray(it.rows) || !it.rows.length || it.rows.length > LIMITS.rows || it.rows.some((r) => !Array.isArray(r) || !r.length || r.length > LIMITS.cols)) { errs.push(w + '.rows needs 1 to ' + LIMITS.rows + ' rows of 1 to ' + LIMITS.cols + ' cells'); break; }
        o.x = num(it.x, errs, w + '.x'); o.y = num(it.y, errs, w + '.y'); o.rows = it.rows.map((r) => r.map((c) => txt(c, 22)));
        o.colw = Math.max(20, Math.min(200, it.colw == null ? 70 : num(it.colw, errs, w + '.colw'))); o.rowh = Math.max(14, Math.min(60, it.rowh == null ? 24 : num(it.rowh, errs, w + '.rowh'))); if (it.head) o.head = true; break;
      }
      case 'timeline': {
        if (!Array.isArray(it.marks) || !it.marks.length || it.marks.length > LIMITS.marks) { errs.push(w + '.marks needs 1 to ' + LIMITS.marks + ' marks {at 0..1, text}'); break; }
        o.x1 = num(it.x1, errs, w + '.x1'); o.y1 = num(it.y1, errs, w + '.y1'); o.x2 = num(it.x2, errs, w + '.x2'); o.y2 = num(it.y2, errs, w + '.y2');
        o.marks = it.marks.map((m, k) => ({ at: Math.max(0, Math.min(1, Number(m && m.at) || 0)), text: txt(m && m.text, 28) || (errs.push(w + '.marks[' + k + '].text is empty'), '') })); break;
      }
      default: break;
    }
    out.items.push(o);
  });
  if (parts.size > LIMITS.parts) errs.push('At most ' + LIMITS.parts + ' named parts.');
  if (raw.steps != null) {
    if (!Array.isArray(raw.steps) || raw.steps.length > LIMITS.steps) errs.push('steps must be a list of at most ' + LIMITS.steps);
    else {
      out.steps = raw.steps.map((s, i) => {
        const st = {};
        if (!s || typeof s !== 'object') { errs.push('steps[' + i + '] must be an object'); return st; }
        for (const k of ['show', 'hl']) if (s[k] != null) {
          if (!Array.isArray(s[k])) { errs.push('steps[' + i + '].' + k + ' must be a list of part names'); continue; }
          st[k] = s[k].map(String).filter((p) => { if (!parts.has(p)) { errs.push('steps[' + i + '].' + k + ' names "' + p + '", which no item has as its part'); return false; } return true; });
        }
        if (s.say != null) st.say = txt(s.say, LIMITS.say);
        return st;
      });
    }
  }
  out.parts = [...parts];
  return errs.length ? { ok: false, errors: errs.slice(0, 8) } : { ok: true, spec: out };
}

export function validateDerivation(input) {
  const errs = [];
  let raw = input;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { return { ok: false, errors: ['The derivation is not valid JSON.'] }; } }
  const steps = raw && Array.isArray(raw.steps) ? raw.steps : null;
  if (!steps || !steps.length) return { ok: false, errors: ['steps must be a non-empty list of {math, say?}.'] };
  if (steps.length > LIMITS.derive) return { ok: false, errors: ['At most ' + LIMITS.derive + ' steps.'] };
  const out = steps.map((s, i) => {
    const math = txt(s && s.math, LIMITS.math);
    if (!math) errs.push('steps[' + i + '].math is empty');
    return { math, say: s && s.say != null ? txt(s.say, LIMITS.say) : undefined };
  });
  return errs.length ? { ok: false, errors: errs } : { ok: true, spec: { steps: out } };
}
