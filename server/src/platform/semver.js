/* server/src/platform/semver.js — "1.2.10" > "1.2.9"; a pre-release sorts before its release. */
export function cmp(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v || '0').trim().replace(/^v/i, '').split('-', 2);
    return { n: core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre === undefined ? null : pre };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.n.length, B.n.length, 3); i++) {
    const d = (A.n[i] || 0) - (B.n[i] || 0);
    if (d) return Math.sign(d);
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : 1;
}
export const newer = (a, b) => cmp(a, b) > 0;
