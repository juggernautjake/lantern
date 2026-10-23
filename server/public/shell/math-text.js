/* ===========================================================================
   server/public/shell/math-text.js — the course's math formatting, for chat.
   ---------------------------------------------------------------------------
   The readings turn "σ_mean", "h_cr", "x^2", "(1 + i)^n", "e^{-x}" into real
   subscripts and superscripts (app/course/markdown.js: SUB_RE, superscripts).
   The chat does the same with the same rules, so a reply never shows raw
   underscores or carets. Pure text in, parts out (no DOM), so Node can test it:

     mathParts(text) → [ { s: 'plain text' } | { sub: 'mean' } | { sup: 'n' } … ]

   The base of a subscript is one symbol (σ_m, 4A_m) or one of the short names
   surveyors subscript (Elev_B, Az_next, Lat_i), never the tail of a longer
   word, so snake_case stays as written. Keep this in step with markdown.js
   (the test compares the two).
   =========================================================================== */

const RE = /(?<![A-Za-zα-ωΑ-Ω_̄])((?:[ΔΣ])?(?:Elev|Az|Lat|Dep|Sta|Dist|[A-Za-zα-ωΑ-Ω])̄?)_(\{[^{}]+\}|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)|\^\{([^{}]+)\}|\^\(([^()]+)\)|\^(-?[A-Za-z0-9.]*[A-Za-z0-9])/g;

export function mathParts(text) {
  // x^2 → x², for the lone-digit exponents (as the readings do); longer ones become real superscripts
  const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const t = String(text == null ? '' : text).replace(/\^(\d)(?![\w.])/g, (_m, d) => SUP.charAt(Number(d)));
  const out = [];
  let last = 0, m;
  RE.lastIndex = 0;
  while ((m = RE.exec(t))) {
    if (m.index > last) out.push({ s: t.slice(last, m.index) });
    if (m[1] != null) {
      const inner = m[2].charAt(0) === '{' ? m[2].slice(1, -1) : m[2];
      out.push({ s: m[1] }, { sub: inner });
    } else out.push({ sup: m[3] || m[4] || m[5] });
    last = RE.lastIndex;
  }
  if (last < t.length) out.push({ s: t.slice(last) });
  return out;
}
/* the same, as the plain text a reader sees (for tests) */
export const mathText = (text) => mathParts(text).map((p) => (p.s != null ? p.s : p.sub != null ? p.sub : p.sup)).join('');
