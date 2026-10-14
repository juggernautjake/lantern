/* ===========================================================================
   server/public/shell/spoken.js — what a reply SOUNDS like, said in full.
   ---------------------------------------------------------------------------
     spoken('Area = πr², so r = 2.5 ft gives ≈ 19.63 ft²')
       → 'Area equals pi r squared, so r equals two point five feet gives
          approximately nineteen point six three square feet'

   Voices (ElevenLabs' turbo model, the browser's own) stumble on symbols,
   decimals and math: "3.5" became "three … five", "x²" was skipped, "√" and
   "±" were silent, "N 45°30' E" was gibberish. So before anything is spoken,
   the text is rewritten as plain words — every number spelled out, every
   operator, power, root, Greek letter, unit, bearing and station said the way
   a tutor would say it aloud. The screen keeps the original.

   Running it twice changes nothing (what it returns has no symbols left), so
   the page and the server can both apply it.

   No DOM, no Node: the page uses it, the server uses it, the tests run it.
   =========================================================================== */

/* -------------------------------------------------------------- numbers --- */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', ' thousand', ' million', ' billion', ' trillion'];

function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  const out = [];
  if (h) out.push(ONES[h] + ' hundred');
  if (r) out.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : ''));
  return out.join(' ');
}

/* A whole number, as words. Very long digit strings are read digit by digit. */
export function cardinal(digits) {
  const s = String(digits).replace(/,/g, '');
  if (!/^\d+$/.test(s)) return s;
  if (s.length > 15 || (s.length > 1 && s[0] === '0')) return s.split('').map((d) => ONES[+d]).join(' ');
  let n = Number(s);
  if (n === 0) return 'zero';
  const parts = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const c = n % 1000;
    if (c) parts.unshift(under1000(c) + SCALES[i]);
  }
  return parts.join(' ');
}

const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
export function ordinal(digits) {
  const w = cardinal(digits);
  return w.replace(/(\w+)$/, (last) => ORD[last] || (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th'));
}

/* "1,234.056" → "one thousand two hundred thirty-four point zero five six" */
export function number(text) {
  const m = /^(\d[\d,]*)?(?:\.(\d+))?$/.exec(String(text));
  if (!m) return text;
  const whole = m[1] !== undefined ? cardinal(m[1]) : (m[2] ? 'point' : '');
  if (m[2] === undefined) return whole;
  // 0.0000833: "zero point, four zeros, then eight three three" — easier to follow than the zeros one by one
  const lead = /^0{4,}(?=[1-9])/.exec(m[2]);
  const frac = (lead ? cardinal(String(lead[0].length)) + ' zeros, then ' : '') + m[2].slice(lead ? lead[0].length : 0).split('').map((d) => ONES[+d]).join(' ');
  const pt = lead ? ' point, ' : ' point ';
  return m[1] !== undefined ? whole + pt + frac : pt.trim() + ' ' + frac;
}

/* 1983 → "nineteen eighty-three" (only where it is clearly a year) */
function year(y) {
  const n = Number(y);
  if (n % 1000 < 10 && n >= 2000) return cardinal(y);           // 2000, 2007
  const hi = Math.floor(n / 100), lo = n % 100;
  return cardinal(String(hi)) + ' ' + (lo === 0 ? 'hundred' : lo < 10 ? 'oh ' + ONES[lo] : cardinal(String(lo)));
}

/* -------------------------------------------------------------- symbols --- */

const GREEK = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
  Γ: 'capital gamma', Δ: 'delta', '∆': 'delta', Θ: 'capital theta', Λ: 'capital lambda', Π: 'capital pi', Σ: 'the sum of', Φ: 'capital phi', Ψ: 'capital psi', Ω: 'omega' };
const LATEX_GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega'];
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i', 'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ⁿ': 'n', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'q', 'ˢ': 'r', 'ᵗ': 's', 'ᵘ': 't', 'ᵛ': 'u', 'ʷ': 'v', 'ˣ': 'w', 'ʸ': 'x', 'ᶻ': 'y' };
const SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₙ': 'n', 'ᵢ': 'i', 'ⱼ': 'j', 'ₖ': 'k', 'ₓ': 'x', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o',
  'ₘ': 'm', 'ₚ': 'p', 'ₛ': 's', 'ₜ': 't', 'ₕ': 'h', 'ₗ': 'l', 'ᵣ': 'r', 'ᵤ': 'u', 'ᵥ': 'v', '₋': '-', '₊': '+', '₌': '=', '₍': '(', '₎': ')' };
// What is left once the maths is words: arrows, marks and signs a voice would skip or spell.
const MARKS = [
  // a calculator's arrow keys, standing alone, are presses: "math, right, right, one"
  [/◄►/g, ' to '], [/(^|[\s`[(])[►▶](?=$|[\s`\])])/g, '$1 right, '], [/(^|[\s`[(])[◄◀](?=$|[\s`\])])/g, '$1 left, '],
  [/▲/g, ' up '], [/▼/g, ' down '],
  [/[▸►▶]/g, ' to '], [/[◂◄◀]/g, ' from '], [/↔/g, ' to and from '], [/⇄/g, ' swap '], [/[↑⇑]/g, ' up '], [/[↓⇓]/g, ' down '],
  [/[✓✔☑]/g, ' check. '], [/[✗✘]/g, ' no. '], [/⚠️?/g, ' Warning: '], [/§/g, ' section '], [/¶/g, ' paragraph '],
  [/[⟂⊥]/g, ' perpendicular to '], [/ℓ/g, ' ell '], [/[•◦▪]/g, ', '], [/[＋]/g, '+'], [/[－]/g, '-'], [/µm|μm/g, ' micrometers'], [/[µμ]/g, ' mu '],
  [/\$/g, ' dollars '], [/#/g, ' number '], [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?/gu, ' '], [/️/g, ''],
];
const FRACTIONS = { '½': ' one half', '⅓': ' one third', '⅔': ' two thirds', '¼': ' one quarter', '¾': ' three quarters', '⅛': ' one eighth', '⅜': ' three eighths', '⅝': ' five eighths', '⅞': ' seven eighths' };
const COMMON = { '1/2': 'one half', '1/3': 'one third', '2/3': 'two thirds', '1/4': 'one quarter', '3/4': 'three quarters', '1/8': 'one eighth', '3/8': 'three eighths', '5/8': 'five eighths', '7/8': 'seven eighths' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const SYMBOLS = [
  [/≠/g, ' does not equal '], [/≤|⩽/g, ' is less than or equal to '], [/≥|⩾/g, ' is greater than or equal to '],
  [/≡/g, ' is identical to '], [/∝/g, ' is proportional to '], [/±/g, ' plus or minus '], [/∓/g, ' minus or plus '],
  [/×|⋅|∙|·/g, ' times '], [/÷/g, ' divided by '], [/∞/g, ' infinity '], [/∑/g, ' the sum of '], [/∏/g, ' the product of '],
  [/∫/g, ' the integral of '], [/∂/g, ' partial '], [/∇/g, ' del '], [/∠/g, ' angle '], [/⊥/g, ' is perpendicular to '],
  [/∥/g, ' is parallel to '], [/∴/g, ' therefore '], [/∵/g, ' because '], [/⇒|⟹/g, ', which means '], [/⇔|⟺/g, ' if and only if '],
  [/→|⟶/g, ', which gives '], [/←/g, ' from '], [/∈/g, ' in '], [/∉/g, ' not in '], [/∪/g, ' union '], [/∩/g, ' intersect '],
  [/‰/g, ' per thousand'], [/%/g, ' percent'], [/&/g, ' and '], [/@/g, ' at '], [/№/g, ' number '],
];

/* Units, said in full after a number (singular when the number is one). */
const UNITS = [
  ['GHz', 'gigahertz', 'gigahertz'], ['MHz', 'megahertz', 'megahertz'], ['kHz', 'kilohertz', 'kilohertz'], ['Hz', 'hertz', 'hertz'],
  ['ns', 'nanosecond', 'nanoseconds'], ['µs|μs', 'microsecond', 'microseconds'], ['ms', 'millisecond', 'milliseconds'],
  ['µm|μm', 'micrometer', 'micrometers'], ['psi', 'pound per square inch', 'pounds per square inch'],
  ['sq\\.? ?ft|ft\\^2|ft2', 'square foot', 'square feet'], ['sq\\.? ?mi|mi\\^2', 'square mile', 'square miles'], ['sq\\.? ?yd|yd\\^2', 'square yard', 'square yards'],
  ['m\\^2|sq\\.? ?m', 'square meter', 'square meters'], ['km\\^2|sq\\.? ?km', 'square kilometer', 'square kilometers'],
  ['ft\\^3|cu\\.? ?ft', 'cubic foot', 'cubic feet'], ['yd\\^3|cu\\.? ?yd', 'cubic yard', 'cubic yards'], ['m\\^3', 'cubic meter', 'cubic meters'],
  ['US ?ft|usft|sft', 'U S survey foot', 'U S survey feet'], ['ft\\/s', 'foot per second', 'feet per second'], ['m\\/s', 'meter per second', 'meters per second'],
  ['km\\/h|kph', 'kilometer per hour', 'kilometers per hour'], ['mph', 'mile per hour', 'miles per hour'], ['ft\\/mi', 'foot per mile', 'feet per mile'],
  ['ft', 'foot', 'feet'], ['km', 'kilometer', 'kilometers'], ['cm', 'centimeter', 'centimeters'], ['mm', 'millimeter', 'millimeters'],
  ['m', 'meter', 'meters'], ['mi', 'mile', 'miles'], ['yd', 'yard', 'yards'], ['ac', 'acre', 'acres'], ['ha', 'hectare', 'hectares'],
  ['ch', 'chain', 'chains'], ['rd', 'rod', 'rods'], ['lk', 'link', 'links'], ['lb', 'pound', 'pounds'], ['lbs', 'pound', 'pounds'],
  ['kg', 'kilogram', 'kilograms'], ['ppm', 'part per million', 'parts per million'], ['hr|hrs', 'hour', 'hours'], ['min', 'minute', 'minutes'],
  ['sec', 'second', 'seconds'], ['in\\.', 'inch', 'inches'],
];
// "4ac" is algebra and "4 ac" is acres: only the unmistakable units may touch the number.
const TIGHT = /^(ft|km|cm|mm|m|mph|kg|ppm|m\/s|ft\/s|km\/h)$/;
const UNIT_RE = new RegExp('(\\d[\\d,]*(?:\\.\\d+)?)([ \\t]?)(' + UNITS.map((u) => u[0]).join('|') + ')(?![\\w^])', 'g');
function unitWords(num, unit) {
  for (const [re, one, many] of UNITS) if (new RegExp('^(?:' + re + ')$').test(unit)) return num + ' ' + (num === '1' ? one : many);
  return num + ' ' + unit;
}

const FUNCS = { sin: 'sine', cos: 'cosine', tan: 'tangent', sec: 'secant', csc: 'cosecant', cot: 'cotangent', log: 'log', ln: 'natural log', exp: 'e to the', arcsin: 'inverse sine', arccos: 'inverse cosine', arctan: 'inverse tangent' };

/* The innermost brace group, repeatedly: for LaTeX. */
function eachBrace(s, re, fn) {
  let prev;
  do { prev = s; s = s.replace(re, fn); } while (s !== prev);
  return s;
}

const OPERAND = '[A-Za-z0-9)\\]α-ωΑ-Ω]';
const HAS_OP = /[+\-−*/×÷=^]|\b(plus|minus|times|over)\b/;

/* √( … ) with any brackets inside: "the square root of the quantity …," */
function roots(s) {
  for (let i = s.indexOf('√'); i >= 0; i = s.indexOf('√', i + 1)) {
    let j = i + 1;
    while (s[j] === ' ') j++;
    if (s[j] !== '(') continue;
    let depth = 0, k = j;
    for (; k < s.length; k++) { if (s[k] === '(') depth++; else if (s[k] === ')' && --depth === 0) break; }
    if (k >= s.length) continue;
    const x = s.slice(j + 1, k);
    s = s.slice(0, i) + ' the square root of ' + (HAS_OP.test(x) ? 'the quantity ' + x + ', ' : x + ' ') + s.slice(k + 1);
  }
  return s;
}

/* ------------------------------------------------------------- spoken() --- */

export function spoken(input) {
  // Settled: what comes out reads the same if it is put through again (the
  // page and the server both apply it).
  let s = once(input);
  for (let i = 0; i < 3; i++) { const t = once(s); if (t === s) break; s = t; }
  return s;
}

function once(input) {
  let s = String(input == null ? '' : input).replace(/＋/g, '+').replace(/－/g, '-').replace(/＝/g, '=');

  // --- markdown ---
  s = s.replace(/```[\s\S]*?```/g, ' (the code is on screen) ');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/\bhttps?:\/\/\S+/g, 'the link on screen');
  // HTML a reading may carry (tables): rows and cells become pauses, tags go
  s = s.replace(/<\/(tr|p|li|h\d|div)>|<br\s*\/?>/gi, '. ').replace(/<\/t[dh]>/gi, ', ').replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // [2nd] [DMS]: key names in square brackets are read as the key; a bracket is a bracket
  s = s.replace(/\[/g, '(').replace(/\]/g, ')');
  // 68-95-99.7: a chain of numbers joined by hyphens is a list, not "68 to 95 to 99.7"
  s = s.replace(/\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?){2,}\b/g, (m) => m.split('-').join(', '));
  // the °′″ key or menu
  s = s.replace(/°\s*['′’]\s*["″”]/g, ' degrees minutes seconds ');
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '');      // table rule
  s = s.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(', ') + '.');
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, (_, h) => h + (/[.!?:]$/.test(h) ? '' : '.'));
  s = s.replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+(.*)$/gm, (_, li) => li + (/[.!?:;,]$/.test(li) ? '' : '.'));
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2').replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1$2').replace(/(^|[\s(])_(\S[^_\n]*?)_(?=[\s).,;:!?]|$)/g, '$1$2');
  s = s.replace(/`([^`]*)`/g, '$1');

  // --- LaTeX (the model is asked not to write it, but just in case) ---
  s = s.replace(/\$\$|\\\[|\\\]|\\\(|\\\)/g, ' ').replace(/\$([^$\n]+)\$/g, '$1');
  s = s.replace(/\\(?:left|right|displaystyle|,|;|!|quad|qquad)\b|\\[,;! ]/g, ' ');
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\(bar|overline)\{([^{}]*)\}/g, '$2 bar').replace(/\\hat\{([^{}]*)\}/g, '$1 hat');
  s = eachBrace(s, /\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a, b) => (HAS_OP.test(a) ? '(' + a + ')' : a) + ' / ' + (HAS_OP.test(b) ? '(' + b + ')' : b));
  s = eachBrace(s, /\\sqrt\[([^\]]+)\]\{([^{}]*)\}/g, (_, n, x) => ' the ' + (n === '3' ? 'cube' : n + 'th') + ' root of (' + x + ')');
  s = eachBrace(s, /\\sqrt\{([^{}]*)\}/g, (_, x) => '√(' + x + ')');
  s = s.replace(/\\(cdot|times)\b/g, ' × ').replace(/\\div\b/g, ' ÷ ').replace(/\\pm\b/g, ' ± ').replace(/\\mp\b/g, ' ∓ ')
    .replace(/\\(le|leq)\b/g, ' ≤ ').replace(/\\(ge|geq)\b/g, ' ≥ ').replace(/\\(ne|neq)\b/g, ' ≠ ').replace(/\\approx\b/g, ' ≈ ')
    .replace(/\\infty\b/g, ' ∞ ').replace(/\\sum\b/g, ' ∑ ').replace(/\\int\b/g, ' ∫ ').replace(/\\partial\b/g, ' ∂ ')
    .replace(/\\(Rightarrow|implies)\b/g, ' ⇒ ').replace(/\\(rightarrow|to)\b/g, ' → ').replace(/\\angle\b/g, ' ∠ ').replace(/\\circ\b/g, '°')
    .replace(/\\(sin|cos|tan|sec|csc|cot|log|ln|exp|arcsin|arccos|arctan)\b/g, '$1');
  s = s.replace(new RegExp('\\\\(' + LATEX_GREEK.join('|') + ')\\b', 'g'), (_, g) => ' ' + g.replace(/^var/, '').toLowerCase() + ' ');
  s = eachBrace(s, /([\^_])\{([^{}]*)\}/g, (_, op, x) => op + (x.length === 1 || /^-?\d+$/.test(x) ? x : '(' + x + ')'));

  // --- Unicode forms → one plain form ---
  s = s.replace(/[   ]/g, ' ').replace(/−|–(?=\s*\d)(?<=\s–)/g, '-');
  // 1³⁄₁₆ — a whole number and a fraction set with the fraction slash
  const SUPD = { '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 };
  const SUBD = { '₀': 0, '₁': 1, '₂': 2, '₃': 3, '₄': 4, '₅': 5, '₆': 6, '₇': 7, '₈': 8, '₉': 9 };
  s = s.replace(/(\d+)?\s?([⁰¹²³⁴⁵⁶⁷⁸⁹]+)⁄([₀₁₂₃₄₅₆₇₈₉]+)(\s?(?:in|ft)\b)?/g, (m, w, a, b, u) => u ? m.slice(0, -u.length) + (/in/.test(u) ? ' inches' : ' feet') : m);
  s = s.replace(/(\d+)?\s?([⁰¹²³⁴⁵⁶⁷⁸⁹]+)⁄([₀₁₂₃₄₅₆₇₈₉]+)/g, (_, w, a, b) => {
    const num = Number(a.split('').map((c) => SUPD[c]).join('')), den = Number(b.split('').map((c) => SUBD[c]).join(''));
    const part = den === 2 ? (num === 1 ? 'half' : 'halves') : den === 4 ? (num === 1 ? 'quarter' : 'quarters') : ordinal(String(den)) + (num === 1 ? '' : 's');
    return (w ? w + ' and ' : '') + cardinal(String(num)) + ' ' + part;
  });
  s = s.replace(/⁄/g, '/');
  // the empty boxes printed on template keys (1/□, ×10■): "box"
  s = s.replace(/[□■]/g, ' box ');
  // the HP 33s / 35s shift keys
  s = s.replace(/↰/g, ' left shift ').replace(/↱/g, ' right shift ');
  // 10 in = 25.4 mm, 33⅓ in: "in" is inches only where it cannot be the word "in"
  s = s.replace(/(\d[½⅓⅔¼¾⅛⅜⅝⅞]?)\s?in\b(?=\s*(?:[=,;:)×+\-\/]|\.(?!\d)|$))/g, '$1 inches');
  // PLSS aliquot parts: NE¼ → the northeast quarter, N½ → the north half
  const QUARTER = { NE: 'northeast', NW: 'northwest', SE: 'southeast', SW: 'southwest', N: 'north', S: 'south', E: 'east', W: 'west' };
  s = s.replace(/\b(NE|NW|SE|SW)\s?¼/g, (_, q) => QUARTER[q] + ' quarter').replace(/\b([NSEW])\s?½/g, (_, q) => QUARTER[q] + ' half');
  // 33⅓ → thirty-three and one third
  s = s.replace(/(\d)([½⅓⅔¼¾⅛⅜⅝⅞])/g, (_, d, c) => d + ' and' + FRACTIONS[c]);
  s = s.replace(/[½⅓⅔¼¾⅛⅜⅝⅞]/g, (c) => FRACTIONS[c]);
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ]+/g, (m) => { const x = m.split('').map((c) => SUP[c]).join(''); return '^' + (x.length > 1 && !/^-?\d+$/.test(x) ? '(' + x + ')' : x); });
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉ₙᵢⱼₖₓₐₑₒₘₚₛₜₕₗᵣᵤᵥ₋₊₌₍₎]+/g, (m) => { const x = m.split('').map((c) => SUB[c]).join(''); return '_' + (/[-+=]/.test(x) ? '(' + x + ')' : x); });
  s = s.replace(/([A-Za-z])̄/g, '$1 bar').replace(/([A-Za-z])̂/g, '$1 hat').replace(/([A-Za-z])̇/g, '$1 dot');
  s = s.replace(/ȳ/g, 'y bar').replace(/ŷ/g, 'y hat').replace(/x̂/g, 'x hat');

  // --- money, dates, ratios, times ---
  s = s.replace(/\$(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_, d, c) => d + (d === '1' ? ' dollar' : ' dollars') + (c && c !== '00' ? ' and ' + c + ' cents' : ''));
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, mo, d, y) => (+mo >= 1 && +mo <= 12 ? MONTHS[+mo - 1] + ' ' + ordinal(d) + ', ' + year(y) : m));
  s = s.replace(/\b(\d{1,2}):(\d{2})\s?([ap])\.?m\.?\b/gi, (_, h, mm, ap) => cardinal(h) + (mm === '00' ? '' : ' ' + (mm[0] === '0' ? 'oh ' + ONES[+mm[1]] : cardinal(mm))) + ' ' + ap.toLowerCase() + ' m');
  s = s.replace(/\b(\d[\d,]*)\s?:\s?(\d[\d,]*)\b/g, '$1 to $2');                               // 1:10,000 scale, 1:2 slope

  // --- surveying: bearings, angles, stations ---
  s = s.replace(/\b([NS])\s?(\d{1,3}(?:\.\d+)?\s?°(?:\s?\d{1,2}(?:\.\d+)?\s?['′])?(?:\s?\d{1,2}(?:\.\d+)?\s?(?:"|″|''))?)\s?([EW])\b/g,
    (_, ns, ang, ew) => (ns === 'N' ? 'north ' : 'south ') + ang + ' ' + (ew === 'E' ? 'east' : 'west'));
  s = s.replace(/\/\s?°\s?([FC])\b/g, (_, u) => ' per degree ' + (u === 'F' ? 'Fahrenheit' : 'Celsius'));
  s = s.replace(/(\d)\s?°\s?([FC])\b/g, (_, d, u) => d + (u === 'F' ? ' degrees Fahrenheit' : ' degrees Celsius'));
  s = s.replace(/(\d[\d,]*(?:\.\d+)?)\s?°(?:\s?(\d+(?:\.\d+)?)\s?['′])?(?:\s?(\d+(?:\.\d+)?)\s?(?:"|″|''))?/g,
    (_, d, m, sec) => d + (d === '1' ? ' degree' : ' degrees') + (m ? ', ' + m + (m === '1' ? ' minute' : ' minutes') : '') + (sec ? ', ' + sec + (sec === '1' ? ' second' : ' seconds') : ''));
  s = s.replace(/(\d+(?:\.\d+)?)\s?′/g, '$1 minutes').replace(/(\d+(?:\.\d+)?)\s?″/g, '$1 seconds');
  s = s.replace(/°/g, ' degrees ');
  s = s.replace(/′/g, ' prime ').replace(/″/g, ' double prime ');
  s = s.replace(/\b(?:sta\.?|station)\s*(\d+)\s?\+\s?(\d{2}(?:\.\d+)?)\b/gi, 'station $1 plus $2');
  s = s.replace(/(^|[\s(])(\d{1,4})\+(\d{2}\.\d+)\b/g, '$1station $2 plus $3');
  s = s.replace(/(station \d+ plus [\d.]+\s+(?:to|through|thru|and|or|-)\s+)(\d{1,4})\+(\d{2}(?:\.\d+)?)\b/g, '$1station $2 plus $3');

  // --- scientific notation, units ---
  s = s.replace(/(\d(?:\.\d+)?)[eE]([+-]?\d+)\b/g, (_, a, e) => a + ' × 10^' + e.replace('+', ''));
  s = s.replace(UNIT_RE, (m, n, sp, u) => (sp || TIGHT.test(u) ? unitWords(n, u) : m));

  // --- functions and roots ---
  s = s.replace(/\b(sin|cos|tan|sec|csc|cot)\s?\^\(?-1\)?/g, 'arc$1');
  s = s.replace(/\b(arcsin|arccos|arctan|sin|cos|tan|sec|csc|cot|log|ln)\b\s?(\^\(?\d+\)?)?\s?(?=[(A-Za-z0-9α-ωΑ-Ω√])/g,
    (_, f, p) => ' the ' + FUNCS[f] + (p ? ' ' + p : '') + ' of ');
  s = s.replace(/\b(arcsin|arccos|arctan|sin|cos|tan|sec|csc|cot)\b/g, (f) => FUNCS[f]);
  s = s.replace(/\bsqrt\s?\(/g, '√(');
  s = s.replace(/∛\s?/g, ' the cube root of ').replace(/∜\s?/g, ' the fourth root of ');
  s = roots(s);
  s = s.replace(/√\s?([A-Za-z0-9.α-ω]+)/g, ' the square root of $1 ');

  // --- powers, subscripts ---
  s = eachBrace(s, /\(([^()]*)\)\s?\^/g, (_, x) => (HAS_OP.test(x) ? ' the quantity ' + x + ', ' : x) + ' ^');
  // a closing bracket is taken only with its opening one: Σ(v^2) keeps its )
  const power = (neg, p) => (neg ? ' to the negative ' + p : p === '2' ? ' squared' : p === '3' ? ' cubed' : ' to the power of ' + p);
  s = s.replace(/\s?\^\s?\(\s?(-?)\s?(\d+(?:\.\d+)?|[A-Za-z])\)/g, (_, neg, p) => power(neg, p));
  s = s.replace(/\s?\^\s?(-?)\s?(\d+(?:\.\d+)?|[A-Za-z])/g, (_, neg, p) => power(neg, p));
  s = s.replace(/\s?\^\s?\(([^()]*)\)/g, ' to the power of $1,');
  s = s.replace(/([A-Za-zα-ωΑ-Ω])_[({]([^)}]*)[)}]/g, '$1 sub $2');             // Y_{i+1}, h_(n-1)
  s = s.replace(/([A-Za-zα-ωΑ-Ω])_([A-Za-z0-9]+)/g, '$1 sub $2');
  // a root whose inside still had brackets the first time: read it now the inside is plain
  s = roots(s);

  // --- fractions and division ---
  s = s.replace(/\b(\d+)\/(\d+)\b/g, (m, a, b) => COMMON[m] || a + ' over ' + b);
  s = s.replace(/\bN\/A\b/g, 'not applicable').replace(/\b(and)\/(or)\b/g, 'and or');
  s = s.replace(new RegExp('(' + OPERAND + ')[ \\t]*/[ \\t]*(?=[A-Za-z0-9(α-ωΑ-Ω√])', 'g'), '$1 over ');
  // |x|: the absolute value
  s = s.replace(/\|([^|\n]+)\|/g, ' the absolute value of $1 ');
  s = s.replace(/([A-Za-z]{2,})\/([A-Za-z]{2,})/g, '$1 or $2');

  // --- operators ---
  s = s.replace(/<=/g, ' ≤ ').replace(/>=/g, ' ≥ ').replace(/!=|=\/=/g, ' ≠ ').replace(/==/g, ' = ');
  s = s.replace(/(\S)[ \t]*<[ \t]*(?=\S)/g, '$1 is less than ').replace(/(\S)[ \t]*>[ \t]*(?=\S)/g, '$1 is greater than ');
  // "x ≈ 3" is "x is approximately three"; "gives ≈ 19" is "gives approximately nineteen"
  s = s.replace(/(\S*)[ \t]?[≈≅≃][ \t]?/g, (_, w) => w + (!w || /^(gives?|giving|gets?|got|is|are|was|were|be|of|to|at|about|by|equals|yields?|makes?|around|roughly|just|only|and|or|so|comes|works)$/i.test(w) ? ' approximately ' : ' is approximately '));
  for (const [re, say] of SYMBOLS) s = s.replace(re, say);
  s = s.replace(/[ \t]?=[ \t]?/g, ' equals ');
  s = s.replace(new RegExp('(' + OPERAND + '|squared|cubed)[ \\t]?\\*[ \\t]?(?=[A-Za-z0-9(α-ω])', 'g'), '$1 times ');
  // minus: "5 - 3" and "x-1" are subtraction, "-3" is negative, and "3-5 questions"
  // (no equation on the line) is a range. "x-axis" and "well-known" are words.
  s = s.split('\n').map((line) => (/equals|plus|times/.test(line) ? line : line.replace(/(\d)-(\d)/g, '$1 to $2'))).join('\n');
  s = s.replace(new RegExp('(' + OPERAND + '|squared|cubed|bar|hat)[ \\t]+-[ \\t]+(?=[A-Za-z0-9(α-ωΑ-Ω√.])', 'g'), '$1 minus ');
  s = s.replace(/(^|[^A-Za-z])([A-Za-z]|\d|\))-(?=\d|\.\d|[A-Za-zα-ω](?![A-Za-z])|\()/g, '$1$2 minus ');
  s = s.replace(/(^|[\s(\[,:])-[ \t]?(?=\d|\.\d|[A-Za-zα-ω](?![A-Za-z])|\(|√)/gm, '$1negative ');
  s = s.replace(/(^|[^+])\+(?!\+)/g, '$1 plus ');
  s = s.replace(/(?:\babout\s+)?~[ \t]?/g, 'about ');
  s = s.replace(/[α-ωΑ-ΩϕςΔ∆]/g, (c) => ' ' + GREEK[c] + ' ');
  s = s.replace(/√/g, ' square root ');                                              // "0.80 √ =": a key pressed after the number
  for (const [re, say] of MARKS) s = s.replace(re, say);

  // --- numbers, as words ---
  s = s.replace(/\b(in|since|by|until|from|year|before|after|of)\s(1[1-9]\d\d|20\d\d)\b(?![.,]?\d)/gi, (_, w, y) => w + ' ' + year(y));
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/g, (_, n) => ordinal(n));
  s = s.replace(/(\d)([A-Za-z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');
  s = s.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+/g, (n) => ' ' + number(n) + ' ');

  // --- a lone "a" as a variable: say "ay", not "uh" ---
  s = s.replace(/\ba\b(?=\s+(equals|plus|minus|times|over|squared|cubed|sub|to the power|is (less|greater|approximately)))/g, 'ay')
    .replace(/\b(equals|plus|minus|times|over|negative|of|root of)\s+a\b(?!\s+[a-z]{3,})/g, '$1 ay');

  // a minus sign standing alone — the (−) key, "up (+) or down (−)"
  s = s.replace(/(^|[\s(])[-−](?=[\s),.;:]|$)/gm, '$1 minus ').replace(/(^|[\s(])\+(?=[\s),.;:]|$)/gm, '$1 plus ');

  // --- tidy ---
  // brackets around one thing are not heard: "the sum of (v)" → "the sum of v"
  s = s.replace(/\(\s*([A-Za-z-]+(?: (?:squared|cubed|bar|hat|sub [A-Za-z-]+))?)\s*\)/g, ' $1 ');
  s = s.replace(/[{}\\|^_#*`]/g, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/ ([.,;:!?)])/g, '$1').replace(/\( /g, '(').replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').replace(/,\s*\)/g, ')').replace(/(\w) -(?=[A-Za-z])/g, '$1-').replace(/\.{2,}(?!\.)/g, '.');
  s = s.replace(/,[ \t]*$/gm, '').replace(/\n{2,}/g, '\n').replace(/[ \t]*\n[ \t]*/g, '\n');
  return s.trim();
}
