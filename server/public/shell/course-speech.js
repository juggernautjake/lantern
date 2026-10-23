// server/public/shell/course-speech.js — course words, said the way the lesson
// videos say them. Applied before spoken() by the video build (scripts/
// videos.mjs) and by Lantern's own voice when it talks about a course, so the
// narrator and the assistant never say the same thing two ways.
//
//   courseSpeech(text, words)
//     words: the course's pronunciations, { "HI": "H I", … } (whole words, case-sensitive)
//
// The course's own words count as whole words after a subscript mark or before
// a number too: Elev_BM → "elevation_B M", TP1 → "T P1", Y_PVC → "Y_P V C".
// Two are left for spoken() when they follow a number, because there they are
// units and spoken() says them singular or plural: "1 ppm" (one part per
// million), "2 hr" (two hours). A quarter or half after a direction is
// PLSS, also left for spoken(): NE¼ → "the northeast quarter".
//
// After the course's own words:
//   years      a four-digit year (1800–2099, no comma, no decimal, no unit after
//              it) is said as a year: 2022 → "twenty twenty-two", 1983 →
//              "nineteen eighty-three", 2009 → "two thousand nine". Only where
//              the words around it say it is a year ("in 2022", "SPCS 2022",
//              "NAD 83 (2011)").
//   capitals   an abbreviation of two to five capitals with no pronunciation of
//              its own is spelled out (BC → "B C", PCC → "P C C"), so it is never
//              read as a word ("US" as "us"), also as a subscript (D_BS → "D_B S")
//              and before a number (TP-1, TP1, WGS72 → "T P 1", "W G S 72").
//              A capitalised ordinary word is the word: "it IS the corner" →
//              "it is the corner", not "I S".

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function upTo99(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
}
export function year(y) {
  const n = Number(y);
  if (n % 1000 === 0) return ONES[n / 1000] + ' thousand';
  if (n >= 2000 && n <= 2009) return 'two thousand ' + ONES[n - 2000];
  const hi = Math.floor(n / 100), lo = n % 100;
  if (lo === 0) return upTo99(hi) + ' hundred';
  return upTo99(hi) + ' ' + (lo < 10 ? 'oh ' + ONES[lo] : upTo99(lo));
}

const UNIT_AFTER = /^\s*(?:-?\s*(?:ft|feet|foot|m|metres?|meters?|mm|cm|km|in|inch|inches|yd|yards?|mi|miles?|°|%|acres?|ha|lb|psi|ppm|s|sec|seconds?|min|minutes?|hours?|times|x|×)\b|[.,]\d|\d)/i;
const KEEP = new Set(['I', 'A', 'OK']);
// capitals that are ordinary words, written so for emphasis ("it IS the corner", "the LEAST
// precise"): said as the word, never spelled
const ENGLISH = new Set(('IS USE MORE ELSE MEAN NEXT LEAST MARK ABOVE THE OTHER LOST LEFT DOWN RIGHT ONE TWO SUM ALL ANY NOT NO YES ONLY NEVER ' +
  'BOTH EACH SAME LESS MUST AND OR BUT OUT UP OFF ON IN TO FROM WITH WHY HOW WHAT WHEN TRUE FALSE WRONG NOW THEN MOST LONG SHORT FIRST ' +
  'LAST HALF BACK SOME EVERY EVEN OVER UNDER BELOW AFTER NEVER THAN THIS THAT ITS IT AT IF OF AS BE DO SO WE HAS HAVE ARE WAS WERE CAN ' +
  'ADD DATA AREA RACE ' +
  // a figure's labels, printed in capitals: BASE LINE, GUIDE MERIDIAN, 160 ACRES, CENTER OF SECTION
  'BASE LINE GUIDE NORTH SOUTH EAST WEST DATUM SCALE ACRES ACRE CHAINS CHAIN RODS ROD FEET FOOT CENTER SECTION MAGNETIC FORWARD ' +
  'MEDIUM NORMAL HIGH LOW TOP END CUT FILL GRADE ROAD LOT LOTS BLOCK TRACT CORNER POINT STAR ARROW CLOSED OPEN EXCEPT ' +
  'DANGER WARNING CAUTION POISON NOTICE STOP').split(' '));
// capitals of six letters or more are words ("STANDARD PARALLEL", "PRINCIPAL MERIDIAN"), unless an acronym
const ACRONYMS = new Set('AASHTO NAVSTAR CERCLA AVIRIS ISODATA USNMAS CLRVAR MEMVAR STATVAR TBPELS NADCON VERTCON GLONASS NAPGD NATRF'.split(' '));
const MARK = String.fromCharCode(1), UNMARK = String.fromCharCode(2);
const YEAR_BEFORE = /(?:\b(?:in|since|until|before|after|through|year|years|Plane|NAD|NAVD|NGVD|SPCS|NSRS|GEOID|FGCC|FGCS|NSSDA|NMAS|ASPRS|ALTA|NSPS|ACSM|BLM|NGS|USGS|ITRF|datum|edition|version|circa)|\b(?:end|start|beginning|middle|spring|summer|fall|autumn|winter|as) of|\b(?:NAD|NAVD) ?\d\d ?\()\s*$/i;
const YEAR_AFTER = /^\s*(?:datum|edition|adjustment|survey foot|realization|epoch|manual|standards?)\b/i;
// course words that are units after a number: spoken() says them, singular or plural
const UNIT_WORDS = new Set(['ppm', 'hr']);

export function courseSpeech(text, words) {
  let t = String(text == null ? '' : text);
  const w = words || {};
  // a path of named points, O – PC – PI or A–B–C: "O to P C to P I"
  t = t.replace(/\bN[ \t]?[–-][ \t]?S\b/g, 'north-south').replace(/\bE[ \t]?[–-][ \t]?W\b/g, 'east-west');
  for (let p; (p = t.replace(/\b([A-Z]{1,3}[₀-₉0-9]*′?|\d+)[ \t]?–[ \t]?(?=(?:[A-Z]{1,3}[₀-₉0-9]*′?|\d+)(?![A-Za-z]))/, '$1 to ')) !== t;) t = p;
  // a document number, FGDC-STD-007.3, FF-206-FY-22-152: its parts, not "minus"
  t = t.replace(/\b(?=[A-Z0-9.-]*\d)(?=[A-Z0-9.-]*[A-Z]{2})[A-Z0-9]+(?:\.\d+)?(?:-[A-Z0-9]+(?:\.\d+)?){2,}\b/g, (m) => m.replace(/-/g, ' '));
  // epoch 2010.00: "twenty ten point zero zero"
  t = t.replace(/\b(epoch|year) ((?:19|20)\d\d)\.(\d+)\b/g, (_, e, y, d) => e + ' ' + year(y) + ' point ' + d.split('').map((x) => ONES[+x]).join(' '));
  // 29 CFR 1910.1200: "nineteen ten point twelve hundred", as the regulation is said
  t = t.replace(/\bCFR (\d{4})\.(\d{3,4})\b/g, (_, a, b) => 'CFR ' + year(a) + ' point ' + (b.length === 4 ? year(b) : b.split('').map((d) => ONES[+d]).join(' ')));
  // TP-1, BM-7: an abbreviation and its number, not "minus"
  t = t.replace(/\b([A-Z]{2,5})-(\d{1,3})\b(?![A-Za-z.]|,\d)/g, '$1 $2');
  // U.S. survey foot: "U S"
  t = t.replace(/\bU\.S\.(?=\s|$)/g, 'U S');
  for (const k of Object.keys(w).sort((a, b) => b.length - a.length)) {
    // Elev_B, D_BS, TP1: still the word. A word that starts with a symbol (ΣLat) needs nothing before it.
    const re = new RegExp((/^[A-Za-z0-9]/.test(k) ? '(^|[^A-Za-z0-9])' : '()') + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z¼½]|\\s?1\\/[24]\\b)', 'g');
    t = t.replace(re, (m, pre, at, all) => {
      const head = all.slice(0, at) + pre;
      if (UNIT_WORDS.has(k) && /\d[ \t]?$/.test(head)) return m;
      if (/^\d/.test(k) && /[\d.,]$/.test(head)) return m;      // 35s, but not inside 1.35s
      if (/^[Σ∑]/.test(k) && /[A-Za-z0-9)]$/.test(head)) return pre + ' times ' + w[k];   // 2ΣLat: "two times the sum of …"
      return pre + MARK + w[k] + UNMARK;            // said as given: not spelled again below
    });
  }
  // a word and its course abbreviation said alike are said once: "azimuth Az", "azimuth (Az)", "DEG mode"
  t = t.replace(/\b([A-Za-z]+)([ \t]+\(?)\x01\1\x02(\)?)/gi, (m, a, b, c) => a + (b.includes('(') && !c ? b.replace('(', '') : ''))
    .replace(/\x01([^\x02]*?\b([A-Za-z]+))\x02(\**)[ \t]+\2\b/gi, '\x01$1\x02$3');
  // years: only where the words say it is a year ("in 1983", "the end of 2022",
  // "State Plane 2022", "NAD 1927"), never a quantity ("gives 1980", "1800 yd³")
  // A four-digit number with no comma is a year (a 1958 deed, Clarke 1866, (2021), May 2026,
  // 29 CFR 1910) unless the maths around it makes it a quantity: a unit, an operator, "gives",
  // "about" ("1800 ÷ .9", "gives 1980", "1800 yd³"). The course writes quantities 1,800.
  t = t.replace(/(^|[^\d.,\w])(1[6-9]\d\d|20\d\d)(?![\d.,]\d|\d)/g, (m, pre, y, at, all) => {
    const before = all.slice(Math.max(0, at - 24), at + pre.length);
    const after = all.slice(at + m.length);
    if (UNIT_AFTER.test(after)) return m;
    if (!YEAR_BEFORE.test(before) && !YEAR_AFTER.test(after)) {
      if (/^\s*(?:[=+\-−×÷*/^%<>≤≥]|:\s?\d)/.test(after) && !/^\s*[-–]\s*(?:1[6-9]|20)\d\d\b/.test(after)) return m;
      if (/(?:[=+\-−×÷/^:<>≤≥≈±$#~"]|\b(?:gives?|giving|equals|is|are|was|were|about|approximately|roughly|nearly|than|by|times|exactly|only|just|total|N|E|sta|station|elevation)|\d[ \t])\s*$/.test(before)) return m;
    }
    return pre + year(y);
  });
  // a plat's labels: SEC 10, Sec. 10 (section), 160 AC. (acres)
  t = t.replace(/\b(?:SEC|Sec)\.?[ \t]?(?=\d)/g, 'section ').replace(/(\d)[ \t]AC\b\.?/g, '$1 acres');
  // abbreviations: spelled, also as a subscript (D_BS) and before a number (TP1); a capital word
  // is the word, but not one used as a quantity (AS², the A and S of a sight distance)
  t = t.replace(/(?<![A-Za-z\x01])(?<![A-Za-z_.]\d+)[A-Z]{2,5}(?![A-Za-z¼½\x02]|\s?1\/[24]\b)/g, (m, at, all) => (KEEP.has(m) ? m
    : ENGLISH.has(m) && !/^[²³⁰-⁹_^]/.test(all.slice(at + m.length)) ? m.toLowerCase()
      : m.split('').join(' ') + (/\d/.test(all[at + m.length] || '') ? ' ' : '')));
  t = t.replace(/(?<![A-Za-z0-9\x01])[A-Z]{6,}(?![A-Za-z0-9\x02])/g, (m) => (ACRONYMS.has(m) ? m : m.toLowerCase()));
  return t.split(MARK).join('').split(UNMARK).join('');
}
