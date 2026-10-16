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

   How a surveying instructor says it (each has a check in server/test/test-spoken.mjs):
     3,600ths, 60ths, 1,000s   three thousand six hundredths, sixtieths, thousands
     2nd-I                     second order, class one (FGCC)
     1′, 1″                    one minute, one second (singular after one)
     37′49″6 (TI-30Xa)         forty-nine point six seconds
     "display shows 2.0906 07" two point zero nine zero six times ten to the power of seven
     4°10′ W                   four degrees, ten minutes west
     1.5:1, 1:N, s:1           one point five to one, one to N, s to one
     %/sta, ft/ft, lb/ft       percent per station, feet per foot, pounds per foot
     (ft), 300-ft, 2-km        (feet), three hundred-foot, two-kilometer; per km: per kilometer
     V(yd³), A(sq ch)          V in cubic yards, A in square chains
     3,600 s, 5 h 20 min       seconds, hours; 1 in. Hg: one inch of mercury; per °C
     R(1 − cos(I/2))           R times the quantity one minus …;  (a)(b): (a) times (b);  (r/2)x: … times x
     R tan(I/2), σ√n, nΣx      R times the tangent of …, sigma times the square root of n, n times the sum of x
     tan of, the tan key       tangent of, the tangent key ("the … of" only before what it is of)
     Σ+, σxn−1, Sx             sigma plus, sigma x n minus one, S x (calculator keys)
     a = …, a₁, a·x², a − b    ay (the symbol); "a plus sign", "of a degree" keep the article
     Y_PVC, C_std              Y sub P V C, C sub s t d (an abbreviation subscript is spelled)
     w²L³, XᵢYᵢ₊₁              w squared L cubed, X sub i Y sub i plus one
     b is 40, s is 2           "s" after a comma is not seconds
     δ's                       delta's

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
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i', 'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ⁿ': 'n', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z' };
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
  ['sq\\.? ?ch', 'square chain', 'square chains'], ['ch', 'chain', 'chains'], ['rd', 'rod', 'rods'], ['lk', 'link', 'links'], ['lb', 'pound', 'pounds'], ['lbs', 'pound', 'pounds'],
  ['kg', 'kilogram', 'kilograms'], ['ppm', 'part per million', 'parts per million'], ['hr|hrs', 'hour', 'hours'], ['min', 'minute', 'minutes'],
  ['sec', 'second', 'seconds'], ['in\\^2|sq\\.? ?in', 'square inch', 'square inches'], ['in\\.', 'inch', 'inches'], ['s', 'second', 'seconds'],
];
// A unit on its own, or one per another (ft/ft, %/sta, lb/ft, ft²/ac): said, singular after "per"
const PER_UNIT = { ft: ['foot', 'feet'], 'ft^2': ['square foot', 'square feet'], 'ft^3': ['cubic foot', 'cubic feet'], 'yd^3': ['cubic yard', 'cubic yards'],
  in: ['inch', 'inches'], inches: ['inch', 'inches'], lb: ['pound', 'pounds'], mm: ['millimeter', 'millimeters'], km: ['kilometer', 'kilometers'], m: ['meter', 'meters'], '%': ['percent', 'percent'],
  mi: ['mile', 'miles'], ac: ['acre', 'acres'], sta: ['station', 'stations'], s: ['second', 'seconds'] };
const PER_RE = /(\d[\d,]*(?:\.\d+)?)?([ \t]?)(ft\^[23]|yd\^3|ft|lb|mm|inches|in|%|m)[ \t]?\/[ \t]?(yd\^3|ft|mi|km|sta|ac|s)\b\.?/g;
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

/* A bracket written against what it multiplies: R(1 − cos(I/2)), h_c(2R + h_c),
   (wL/2)(L/2). "R times the quantity one minus …," and ") times (". Only where
   the bracket holds a calculation and no comma, so W(1.0), V(prismoidal) and
   the coordinates A(1,000, 1,000) and R▸P(ΔN, ΔE) are left alone. */
function implicitTimes(s) {
  for (let i = s.indexOf('('); i >= 0; i = s.indexOf('(', i + 1)) {
    if (i === 0) continue;
    const before = s.slice(0, i);
    const close = before.endsWith(')');
    // one letter (perhaps with a subscript) or a number: not a word, not a spelled abbreviation ("P W(")
    const factor = /(?:^|[^A-Za-z0-9_^.])(?:[A-Za-z](?:_(?:\{[^{}]*\}|[A-Za-z0-9]+))?|\d+(?:\.\d+)?)$/.test(before) && !/(?:^|\s)[A-Z] [A-Z]$/.test(before);
    if (!close && !factor) continue;
    let depth = 0, k = i;
    for (; k < s.length; k++) { if (s[k] === '(') depth++; else if (s[k] === ')' && --depth === 0) break; }
    if (k >= s.length) continue;
    const x = s.slice(i + 1, k);
    if (/,/.test(x) || (!close && !HAS_OP.test(x))) continue;
    const chain = close || s[k + 1] === '(';
    const head = chain ? ' times (' : ' times the quantity ';
    s = s.slice(0, i) + head + x + (chain ? ')' : ', ') + s.slice(k + 1);
    i += head.length - 1;                          // the next search starts inside x
  }
  // (r/2)x²: the bracket, times x
  return s.replace(/\)([A-Za-z])(?![A-Za-z])/g, ') times $1');
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

  // rates: "$8,000/yr", "12%/yr", "$120/hr" are "per year", "per hour"
  const PER = { yr: 'year', year: 'year', hr: 'hour', h: 'hour', mo: 'month', wk: 'week', day: 'day' };
  s = s.replace(/([\d%])\s?\/\s?(yr|year|hr|h|mo|wk|day)\b(?![\/^²³])/g, (_, a, u) => a + ' per ' + PER[u]);
  // slope ratios: "1½H:1V" is "one and a half horizontal to one vertical"
  s = s.replace(/(\d*½|\d+(?:\.\d+)?|\d+\/\d+)\s?H\s?:\s?(\d+(?:\.\d+)?)\s?V\b/g, (_, h, v) => h.replace(/^(\d+)½$/, '$1 and a half').replace(/^½$/, 'one half') + ' horizontal to ' + v + ' vertical');

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
  // calculator statistics keys and results: Σ+ "sigma plus", σxn−1 "sigma x n minus one", Sx "s x"
  s = s.replace(/Σ\s?\+(?![\d(A-Za-z])/g, ' sigma plus ').replace(/σx?n\s?[-−]\s?1\b/g, (m) => (/x/.test(m) ? ' sigma x n minus one ' : ' sigma n minus one '))
    .replace(/σxn\b/g, ' sigma x n ').replace(/σx\b/g, ' sigma x ').replace(/\b([Ss])x\b(?![²³^])/g, '$1 x');
  // nΣ, 2Σh₂: "n times the sum of", "two times the sum of"
  s = s.replace(/([A-Za-z0-9)\]])(?=[Σ∑])/g, '$1 times ');
  // the symbol a ("a = 3", "a₁", "a·x²", "a − b") is "ay"; the article a ("a plus sign") is not
  s = s.replace(/(?<![A-Za-z0-9'’.])a(?![A-Za-z0-9'’])(?=\s*(?:[=+×·∙⋅*/÷^²³₀-₉≤≥≠≈<>±]|[-−–]\s)|_)|(?<=(?:[=+−×·∙⋅*/÷≤≥≠≈<>±(]|(?:^|[\s(=])-)\s*)a(?![A-Za-z0-9'’-])(?!\s+[a-z]{2,})/g, 'ay');   // not "tangent-of-a-difference"
  // 1 in. Hg: "one inch of mercury"; per °C: "per degree Celsius"
  s = s.replace(/(\d[\d.,]*)\s?in\.?\s?Hg\b/g, (_, n) => n + (n === '1' ? ' inch' : ' inches') + ' of mercury');
  s = s.replace(/\bper\s?°\s?([FC])\b/g, (_, u) => 'per degree ' + (u === 'F' ? 'Fahrenheit' : 'Celsius'));
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
  // braced, so XᵢYᵢ₊₁ is "X sub i, Y sub i plus one", not "X sub iY"
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉ₙᵢⱼₖₓₐₑₒₘₚₛₜₕₗᵣᵤᵥ₋₊₌₍₎]+/g, (m) => '_{' + m.split('').map((c) => SUB[c]).join('') + '}');
  s = s.replace(/([A-Za-z])̄/g, '$1 bar').replace(/([A-Za-z])̂/g, '$1 hat').replace(/([A-Za-z])̇/g, '$1 dot');
  s = s.replace(/ȳ/g, 'y bar').replace(/ŷ/g, 'y hat').replace(/x̂/g, 'x hat');

  // --- money, dates, ratios, times ---
  s = s.replace(/\$(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_, d, c) => d + (d === '1' ? ' dollar' : ' dollars') + (c && c !== '00' ? ' and ' + c + ' cents' : ''));
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, mo, d, y) => (+mo >= 1 && +mo <= 12 ? MONTHS[+mo - 1] + ' ' + ordinal(d) + ', ' + year(y) : m));
  s = s.replace(/\b(\d{1,2}):(\d{2})\s?([ap])\.?m\.?\b/gi, (_, h, mm, ap) => cardinal(h) + (mm === '00' ? '' : ' ' + (mm[0] === '0' ? 'oh ' + ONES[+mm[1]] : cardinal(mm))) + ' ' + ap.toLowerCase() + ' m');
  // 1:10,000 scale, 1:2 slope (or 1 : 2). Not "2 times 0.0045: 0.009", where the
  // colon only introduces the answer: there is a space after it and none before.
  s = s.replace(/(^|[^\d.])(\d[\d,]*(?:\.\d+)?)(?::| : )(\d[\d,]*)\b/g, '$1$2 to $3');      // 1.5:1 too
  // …and with a letter or a bracket on one side: 1:N, s:1, 1 : (L/e)
  s = s.replace(/(^|[^\w.])(\d[\d,]*|[A-Za-z])(?::| : )([A-Za-z]|\d[\d,]*)(?![\w.]|,\d)/g, '$1$2 to $3').replace(/(\d) : (?=\()/g, '$1 to ');

  // --- surveying: bearings, angles, stations ---
  // the TI-30Xa shows 49.6 seconds as 37'49"6: "forty-nine point six seconds"
  s = s.replace(/(\d\s?['′’]\s?\d{1,2})(["″”])(\d+)(?![\d.,]\d|\d)/g, '$1.$3$2');
  // the TI-30Xa's exponent display, "2.0906 07" (×10⁷), where the words say it is a display
  s = s.replace(/(\b(?:display|displays|shows?|showing|screen|reads?|reading)\b[^.\n]{0,40}?)\b(\d\.\d+) {1,3}(-?)0?(\d{1,2})\b(?![.,]?\d)/gi, (_, pre, a, neg, e) => pre + a + ' × 10^' + neg + e);
  s = s.replace(/\b([NS])\s?(\d{1,3}(?:\.\d+)?\s?°(?:\s?\d{1,2}(?:\.\d+)?\s?['′])?(?:\s?\d{1,2}(?:\.\d+)?\s?(?:"|″|''))?)\s?([EW])\b/g,
    (_, ns, ang, ew) => (ns === 'N' ? 'north ' : 'south ') + ang + ' ' + (ew === 'E' ? 'east' : 'west'));
  // a direction after an angle on its own: a declination of 4°10′ W, 40°30′ N
  const DIR = { N: 'north', S: 'south', E: 'east', W: 'west' };
  s = s.replace(/(\d\s?°(?:\s?\d{1,2}(?:\.\d+)?\s?['′])?(?:\s?\d{1,2}(?:\.\d+)?\s?(?:"|″|''))?)\s?([NSEW])\b(?![A-Za-z'’]|\.\w|\s*[=_(])/g, (_, ang, d) => ang + ' ' + DIR[d]);
  s = s.replace(/\/\s?°\s?([FC])\b/g, (_, u) => ' per degree ' + (u === 'F' ? 'Fahrenheit' : 'Celsius'));
  s = s.replace(/(\d)\s?°\s?([FC])\b/g, (_, d, u) => d + (u === 'F' ? ' degrees Fahrenheit' : ' degrees Celsius'));
  s = s.replace(/(\d[\d,]*(?:\.\d+)?)\s?°(?:\s?(\d+(?:\.\d+)?)\s?['′])?(?:\s?(\d+(?:\.\d+)?)\s?(?:"|″|''))?/g,
    (_, d, m, sec) => {
      // 84°04′05″ is "four minutes, five seconds", not "zero four … zero five"
      const nz = (x) => x && x.replace(/^0+(?=\d)/, '');
      d = nz(d); m = nz(m); sec = nz(sec);
      return d + (d === '1' ? ' degree' : ' degrees') + (m ? ', ' + m + (m === '1' ? ' minute' : ' minutes') : '') + (sec ? ', ' + sec + (sec === '1' ? ' second' : ' seconds') : '');
    });
  s = s.replace(/(\d+(?:\.\d+)?)\s?′/g, (_, n) => n + (n === '1' ? ' minute' : ' minutes')).replace(/(\d+(?:\.\d+)?)\s?″/g, (_, n) => n + (n === '1' ? ' second' : ' seconds'));
  s = s.replace(/°/g, ' degrees ');
  s = s.replace(/′/g, ' prime ').replace(/″/g, ' double prime ');
  s = s.replace(/\b(?:sta\.?|station)\s*(\d+)\s?\+\s?(\d{2}(?:\.\d+)?)\b/gi, 'station $1 plus $2');
  s = s.replace(/(^|[\s(])(\d{1,4})\+(\d{2}\.\d+)\b/g, '$1station $2 plus $3');
  s = s.replace(/(station \d+ plus [\d.]+\s+(?:to|through|thru|and|or|-)\s+)(\d{1,4})\+(\d{2}(?:\.\d+)?)\b/g, '$1station $2 plus $3');

  // --- scientific notation, units ---
  s = s.replace(/(\d(?:\.\d+)?)[eE]([+-]?\d+)\b/g, (_, a, e) => a + ' × 10^' + e.replace('+', ''));
  s = s.replace(PER_RE, (m, n, sp, a, b, at, all) => {
    if (!n && /[\w^]$/.test(all.slice(0, at) + sp)) return m;                // r/m, Δm/s: not units
    return (n ? n + ' ' : ' ') + PER_UNIT[a][n === '1' ? 0 : 1] + ' per ' + PER_UNIT[b][0] + ' ';
  });
  // "b is 40, s is 2" and "b + 2 s c" are not seconds: a bare s is seconds only where the phrase ends
  s = s.replace(UNIT_RE, (m, n, sp, u, at, all) => (/,$/.test(n) || (u === 's' && !/^\s*(?:[,;:.)(=]|$|travel\b|per\b)/.test(all.slice(at + m.length))) ? m
    : sp || TIGHT.test(u) ? unitWords(n, u) : m));
  s = s.replace(/(\d)[ \t]h\b(?=\s+\d|\s*=)/g, (_, d, at, all) => d + (d === '1' && !/[\d.]$/.test(all.slice(0, at)) ? ' hour' : ' hours'));   // 5 h 20 min, 1 h = 60 min
  // a unit with no number: V(yd³) "V in cubic yards", "(ft)", "300-ft", "the US survey ft", "ft²"
  s = s.replace(/\b([A-Z])[ \t]?\((ft|yd|m)[ \t]?\^[ \t]?([23])\)/g, (_, v, u, p) => v + ' in ' + (p === '2' ? 'square ' : 'cubic ') + { ft: 'feet', yd: 'yards', m: 'meters' }[u] + ' ')
    .replace(/\b([A-Z])[ \t]?\(sq\.? ?(ch|ft)\)/g, (_, v, u) => v + ' in square ' + (u === 'ch' ? 'chains ' : 'feet '));
  s = s.replace(/(\d[\d,]*(?:\.\d+)?)[ \t]+(US survey|U S survey|[Ii]nternational|SI|survey) ft\b/g, (_, n, name) => n + ' ' + name + (n === '1' ? ' foot' : ' feet'))
    .replace(/\b(US survey|U S survey|[Ii]nternational|SI|survey) ft\b/g, '$1 foot')
    .replace(/(\d)-(ft|mi|yd|in|mm|km|m)\b(?!\.\d)/g, (_, d, u) => d + '-' + { ft: 'foot', mi: 'mile', yd: 'yard', in: 'inch', mm: 'millimeter', km: 'kilometer', m: 'meter' }[u])
    .replace(/(?<![\w^-])(mm|cm|km)[ \t]?\^[ \t]?([23])\b/g, (_, u, p) => (p === '2' ? 'square ' : 'cubic ') + { mm: 'millimeters', cm: 'centimeters', km: 'kilometers' }[u])
    .replace(/(?<![\w^-])(mm|cm|km)(?![\w^])/g, (_, u) => ({ mm: 'millimeters', cm: 'centimeters', km: 'kilometers' })[u])
    .replace(/(?<![\w^])ft[ \t]?\^[ \t]?2\b/g, 'square feet').replace(/(?<![\w^])ft[ \t]?\^[ \t]?3\b/g, 'cubic feet').replace(/(?<![\w^])yd[ \t]?\^[ \t]?3\b/g, 'cubic yards')
    .replace(/\bper (ft|km|mm|mi|yd|m|kilometers|millimeters|miles|meters|feet)\b(?![\w^])/g, (_, u) => 'per ' + ({ ft: 'foot', feet: 'foot', km: 'kilometer', kilometers: 'kilometer', mm: 'millimeter', millimeters: 'millimeter', mi: 'mile', miles: 'mile', yd: 'yard', m: 'meter', meters: 'meter' })[u])
    .replace(/\bper in\b(?=[\s.,;:)]|$)/g, 'per inch')
    .replace(/(?<![\w^-])sq\.? ?ch\b/g, 'square chains')
    .replace(/(?<![\w^-])ft(?![\w^])/g, 'feet')
    .replace(/\bper (square|cubic) (feet|yards|meters)\b/g, (_, k, u) => 'per ' + k + ' ' + { feet: 'foot', yards: 'yard', meters: 'meter' }[u]);

  // --- functions and roots ---
  s = s.replace(/\b(sin|cos|tan|sec|csc|cot)\s?\^\(?-1\)?/g, 'arc$1');
  // R tan(I/2), 2R sin(I/2): a quantity times a function
  // (not the keys "R C L tan": a spelled abbreviation is not a quantity)
  s = s.replace(/(^|[\s=(])(?<![A-Z] )(\d+(?:\.\d+)?[A-Za-z]?|[B-Z])[ \t]+(?=(?:sin|cos|tan|sec|csc|cot)\b)/g, '$1$2 times ');
  // "the sine of" only before what it is taken of: a bracket, a number, a root, one letter or
  // an angle's name. "the tan key", "tan of I", "arctan cannot" keep their own words.
  s = s.replace(/\b(arcsin|arccos|arctan|sin|cos|tan|sec|csc|cot|log|ln)\b\s?(\^\(?\d+\)?)?\s?(?=[(0-9√]|[A-Za-zα-ωΑ-Ω](?![A-Za-z])|(?:Az|azimuth|Lat|Dep|latitude|departure|alpha|beta|theta|delta|phi|Delta|zee)\b)/g,
    (_, f, p) => ' the ' + FUNCS[f] + (p ? ' ' + p : '') + ' of ');
  s = s.replace(/\b(arcsin|arccos|arctan|sin|cos|tan|sec|csc|cot)\b/g, (f) => FUNCS[f]);
  // σ√n: "sigma times the square root of n"
  s = s.replace(/([A-Za-z0-9)α-ωΑ-Ω])√(?=[(A-Za-z0-9.α-ωΣΔ∑])/g, '$1 times √');
  s = s.replace(/\bsqrt\s?\(/g, '√(');
  s = s.replace(/∛\s?/g, ' the cube root of ').replace(/∜\s?/g, ' the fourth root of ');
  s = roots(s);
  s = s.replace(/√\s?([ΣΔ∑]?[A-Za-z0-9.α-ω]+)/g, ' the square root of $1 ');               // √Σw too

  // --- powers, subscripts ---
  s = eachBrace(s, /\(([^()]*)\)\s?\^/g, (_, x) => (HAS_OP.test(x) ? ' the quantity ' + x + ', ' : x) + ' ^');
  // a closing bracket is taken only with its opening one: Σ(v^2) keeps its )
  // (a space after it when a letter follows: w²L³ is "w squared L cubed"; XᵢYᵢ is "X sub i Y sub i")
  const gap = (all, end) => (/[A-Za-z0-9(α-ωΑ-Ω√]/.test(all[end] || '') ? ' ' : '');
  const power = (neg, p) => (neg ? ' to the negative ' + p : p === '2' ? ' squared' : p === '3' ? ' cubed' : ' to the power of ' + p);
  s = s.replace(/\s?\^\s?\(\s?(-?)\s?(\d+(?:\.\d+)?|[A-Za-z])\)/g, (m, neg, p, at, all) => power(neg, p) + gap(all, at + m.length));
  s = s.replace(/\s?\^\s?(-?)\s?(\d+(?:\.\d+)?|[A-Za-z])/g, (m, neg, p, at, all) => power(neg, p) + gap(all, at + m.length));
  s = s.replace(/\s?\^\s?\(([^()]*)\)/g, ' to the power of $1,');
  s = implicitTimes(s);
  // a subscript abbreviation is spelled: Y_PVC "Y sub P V C", C_std "C sub s t d"; a word stays (Az_next "sub next")
  const subx = (x) => (/^[A-Z]{2,5}$/.test(x) || (/^[a-z]{2,4}$/.test(x) && !/[aeiouy]/.test(x)) ? x.split('').join(' ') : x);
  s = s.replace(/([A-Za-zα-ωΑ-Ω])_[({]([^)}]*)[)}]/g, (m, v, x, at, all) => v + ' sub ' + subx(x) + gap(all, at + m.length));   // Y_{i+1}, h_(n-1)
  s = s.replace(/([A-Za-zα-ωΑ-Ω])_([A-Za-z0-9]+)/g, (m, v, x, at, all) => v + ' sub ' + subx(x) + gap(all, at + m.length));
  // a root whose inside still had brackets the first time: read it now the inside is plain
  s = roots(s);

  // --- fractions and division ---
  s = s.replace(/\b(\d+)\/(\d+)\b/g, (m, a, b) => COMMON[m] || a + ' over ' + b);
  s = s.replace(/\bN\/A\b/g, 'not applicable').replace(/\b(and)\/(or)\b/g, 'and or');
  // 400/−300 is "over negative three hundred"; "√(A × E) / √(…)" keeps its "over" after the quantity's comma
  s = s.replace(new RegExp('(' + OPERAND + ')[ \\t]*/[ \\t]*(?=[A-Za-z0-9(α-ωΑ-Ω√]|-[ \\t]?[\\d.(A-Za-z])', 'g'), '$1 over ').replace(/,[ \t]*\/[ \t]*(?=\S)/g, ', over ');
  // |x|: the absolute value
  s = s.replace(/\|([^|\n]+)\|/g, ' the absolute value of $1 ');
  // ⌊x⌋: rounded down (the UTM zone number)
  s = s.replace(/⌊([^⌊⌋\n]+)⌋/g, ' the whole-number part of $1, ').replace(/[⌊⌋]/g, ' ');
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
  s = s.replace(/\b(squared|cubed) -(?=[\d.(A-Za-z])/g, '$1 minus ');                 // x²-1
  s = s.replace(/(^|[\s(\[,:])-[ \t]?(?=\d|\.\d|[A-Za-zα-ω](?![A-Za-z])|\(|√)/gm, '$1negative ');
  s = s.replace(/(^|[^+])\+(?!\+)/g, '$1 plus ');
  s = s.replace(/(?:\babout\s+)?~[ \t]?/g, 'about ');
  s = s.replace(/[α-ωΑ-ΩϕςΔ∆](?=['’]s\b)/g, (c) => ' ' + GREEK[c]);                   // δ's: "delta's"
  s = s.replace(/[α-ωΑ-ΩϕςΔ∆]/g, (c) => ' ' + GREEK[c] + ' ');
  s = s.replace(/√/g, ' square root ');                                              // "0.80 √ =": a key pressed after the number
  for (const [re, say] of MARKS) s = s.replace(re, say);

  // --- numbers, as words ---
  s = s.replace(/\b(in|since|by|until|from|year|before|after|of)\s(1[1-9]\d\d|20\d\d)\b(?![.,]?\d)/gi, (_, w, y) => w + ' ' + year(y));
  // FGCC orders: 2nd-I is "second order, class one"
  s = s.replace(/\b([1-3])(st|nd|rd)-(II|I|two|one)\b/g, (_, n, _s, c) => ordinal(n) + ' order, class ' + (c === 'I' || c === 'one' ? 'one' : 'two'));
  // 60ths, 3,600ths: "sixtieths", "three thousand six hundredths"
  s = s.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)(st|nd|rd|th)(s?)\b/g, (_, n, _o, pl) => ordinal(n) + pl);
  // two 180s, in 1,000s of feet: "two one hundred eighties", "in thousands of feet"
  s = s.replace(/(?<!HP ?|\/|over )\b(\d{1,3}(?:,\d{3})+|\d+)s\b/g, (m, n) => {
    const w = /^(1[89]|20)\d0$/.test(n) ? year(n) : cardinal(n);           // the 1980s
    if (/^one (hundred|thousand|million)$/.test(w)) return w.slice(4) + 's';
    return w.replace(/(\w+)$/, (last) => (last.endsWith('y') ? last.slice(0, -1) + 'ies' : last.endsWith('x') ? last + 'es' : last + 's'));
  });
  s = s.replace(/(\d)([A-Za-z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');
  s = s.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+/g, (n) => ' ' + number(n) + ' ');

  // --- a lone "a" as a variable: say "ay", not "uh" (most were caught by their symbols above;
  // "a plus sign", "not a minus", "of a Fahrenheit degree" keep the article) ---
  s = s.replace(/\ba\b(?=\s+(equals|squared|cubed|sub|to the power|is (less|greater|approximately)))/g, 'ay')
    .replace(/\b(equals|times|over|root of)\s+a\b(?!\s+[A-Za-z]{2,})/g, '$1 ay');

  // −ΣLat, once the course says it "the sum of the latitudes": "minus the sum …"
  s = s.replace(/(^|[\s(\[,:])[-−][ \t]?(?=the\b)/gm, '$1minus ');
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
