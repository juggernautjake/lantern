/* ===========================================================================
   server/src/assistant/teach/cues.js — cues in a reply, in the video style.
   ---------------------------------------------------------------------------
   A reply carries cue markers in the same style as the lesson videos:

       The backsight goes on the benchmark. [[c1:hl bs]] It adds to the
       elevation to give HI. [[c1:step 2]] Watch the T. [[c2:sym T]]

   [[<card>:<action> <args>]]  — the card is the id a show_* / draw tool gave
   (c1, c2…). A cue fires the moment the reader's text reaches it, and is not
   shown or spoken. The page strips and runs them (shell/teach.js); this
   module is the server's side: parse, and keep only the cues that name a
   card that is on screen and a part, step or symbol it really has.

     figure, demo  show P · hide P · hl P · unhl [P] · draw P · step N · reset
     draw          show P · hide P · hl P · unhl [P] · step N · reset
     equation      sym S · unsym · open derive|when|how
     derive        step N (the first N lines) · hl N · reset
     example       step N (the first N lines of the working) · reset
     video         play T [END] · seek T · pause     (seconds)
   =========================================================================== */

export const CUE_RE = /\[\[([a-z]\d{1,2}):([^\]\n]{1,80})\]\]/g;

export function parse(text) {
  const cues = [];
  let out = '', last = 0;
  String(text || '').replace(CUE_RE, (m, card, body, at) => {
    out += text.slice(last, at);
    const bits = body.trim().split(/\s+/);
    cues.push({ at: out.length, card, action: bits[0], args: bits.slice(1) });
    last = at + m.length;
    return m;
  });
  out += String(text || '').slice(last);
  return { text: out, cues };
}

const needPart = ['show', 'hide', 'hl', 'draw'];
/* null when the cue is fine, else why not */
export function problem(cue, cards) {
  const c = cards && cards[cue.card];
  if (!c) return 'no card ' + cue.card + ' on screen';
  const a = cue.action, args = cue.args;
  const n = Number(args[0]);
  switch (c.kind) {
    case 'figure': case 'demo': case 'draw':
      if (a === 'reset') return null;
      if (a === 'unhl') return !args.length || (c.parts || []).includes(args[0]) ? null : 'no part ' + args[0];
      if (needPart.includes(a)) { if (a === 'draw' && c.kind === 'draw') return 'draw is for built figures'; return (c.parts || []).includes(args[0]) ? null : 'no part ' + args[0] + ' on ' + cue.card; }
      if (a === 'step') return Number.isInteger(n) && n >= 1 && n <= (c.steps || 0) ? null : 'no step ' + args[0] + ' on ' + cue.card;
      return 'unknown action ' + a;
    case 'equation':
      if (a === 'sym') return (c.symbols || []).includes(args.join(' ')) ? null : 'no symbol ' + args.join(' ') + ' in ' + cue.card;
      if (a === 'unsym') return null;
      if (a === 'open') return ['derive', 'when', 'how'].includes(args[0]) ? null : 'open derive, when or how';
      return 'unknown action ' + a;
    case 'derive': case 'example':
      if (a === 'reset') return null;
      if (a === 'step' || (a === 'hl' && c.kind === 'derive')) return Number.isInteger(n) && n >= 1 && n <= (c.steps || 0) ? null : 'no step ' + args[0] + ' on ' + cue.card;
      return 'unknown action ' + a;
    case 'video':
      if (a === 'pause') return null;
      if (a === 'seek' || a === 'play') {
        const t = Number(args[0]), e = args[1] == null ? null : Number(args[1]);
        if (!Number.isFinite(t) || t < 0 || (c.seconds && t > c.seconds)) return 'second out of range';
        if (e != null && (!Number.isFinite(e) || e <= t || (c.seconds && e > c.seconds + 1))) return 'bad end second';
        return null;
      }
      return 'unknown action ' + a;
    default: return 'cards of kind ' + c.kind + ' take no cues';
  }
}

/* the reply with every cue that cannot work taken out; the rest stay in place */
export function sanitize(text, cards) {
  let removed = 0, kept = 0;
  const clean = String(text || '').replace(/\[\[([^\]\n]{0,80})\]\]/g, (m, inner) => {
    const x = /^([a-z]\d{1,2}):(.{1,80})$/.exec(inner.trim());
    if (!x) { removed++; return ''; }
    const bits = x[2].trim().split(/\s+/);
    if (problem({ card: x[1], action: bits[0], args: bits.slice(1) }, cards)) { removed++; return ''; }
    kept++;
    return m;
  }).replace(/[ \t]{2,}/g, ' ');
  return { text: clean, removed, kept };
}
