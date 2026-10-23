/* ===========================================================================
   server/public/shell/tutor-speech.js — what only a chat reply needs said right.
   ---------------------------------------------------------------------------
   Every spoken reply goes through the course's own conversion, the same as the
   videos: courseSpeech() (the course's pronunciations) and then spoken() (Δ is
   "delta", N 45°30′15″ E is words, 1:10,000 is "one to ten thousand"…).
   This layer runs FIRST, in the assistant only, and never touches spoken.js,
   so no recorded video narration can change. It fixes the few forms a model
   writes in a reply that the narration never uses:

     $0.045 per $100, $3.2 million, $250k    money with other than cents, or a
                                             magnitude word, said with "dollars"
     5′ 7⅜″, 12′-6″, 3/4", 12"               feet and inches (no degree sign
                                             before it) said as feet and inches
     | table | pipes |, a leading #          markup that is never said

   tutorSpeech(text) → text (still containing symbols; spoken() finishes it)
   =========================================================================== */

const MAG = { m: 'million', million: 'million', b: 'billion', billion: 'billion', k: 'thousand', thousand: 'thousand' };

export function tutorSpeech(input) {
  let t = String(input == null ? '' : input);
  // money: the forms spoken() reads as cents-and-dollars stay; the rest get "dollars" after the number
  t = t.replace(/(−|-)?\$\s?(\d[\d,]*)(\.\d+)?(?:\s?(million|billion|thousand|[MBK]|k)\b)?/g, (m, neg, whole, dec, mag) => {
    const sign = neg ? 'negative ' : '';
    if (mag) return sign + whole + (dec || '') + ' ' + MAG[mag.toLowerCase()] + ' dollars';
    if (!dec || dec.length === 3) return m;     // $1,250 and $12.50 stay: spoken() says dollars and cents
    return sign + whole + dec + ' dollars';
  });
  // feet and inches: 5′ 7⅜″, 12′-6″ (a digit run that does not follow a degree sign or another digit)
  t = t.replace(/(?<![°\d.′])(\d+)′[\s-]*(\d+(?:[⅛¼⅜½⅝¾⅞]|\.\d+)?)\s?[″"](?![A-Za-z0-9])/g, (m, ft, inch) => ft + ' ' + (ft === '1' ? 'foot' : 'feet') + ' ' + inch + ' ' + (inch === '1' ? 'inch' : 'inches'));
  // an inch mark after a number or fraction that is not a seconds mark (nothing like 45°30′15" before it)
  t = t.replace(/(^|[^°′\d./])(\d+\/\d+|\d+(?:\.\d+)?)"(?![A-Za-z0-9])/g, (m, pre, n) => pre + n + (n === '1' || n.includes('/') ? ' inch' : ' inches'));
  // markup that is never said
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\s*\|\s*/g, ', ').replace(/^,\s*|,\s*$/gm, '').replace(/^\s*[-*]\s+/gm, '');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1');
  return t;
}
