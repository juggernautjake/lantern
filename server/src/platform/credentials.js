/* ===========================================================================
   server/src/platform/credentials.js — one AI key for the whole ecosystem.
   ---------------------------------------------------------------------------
   Set up an AI in Dayspring and Lantern can ask "Use the AI key from
   Dayspring?" (and the other way round). The implementation is the shared
   one, vendor/ecosystem-core/lib/credentials.mjs; this file keeps Lantern's
   interface (createCredentials(app, opts), supported(), lantern) so nothing
   that uses it changes. docs/dev/ecosystem.md §4 has the format:

     %LOCALAPPDATA%/Ecosystem/credentials.bin        (ECOSYSTEM_DIR overrides)
     "ECO1" + DPAPI(CurrentUser) of { v: 1, ai: {…}, consent: {…}, … }

     peek()        what is shared — provider, model, which keys — never a key
     read()        the AI settings, only if the person said yes in THIS app
     write(ai)     save them (this app has consent automatically)
     allow(yes)    this app's consent, the answer to "Use the AI key from …?"

   Keys never go over HTTP between the apps, into logs, packs, backups or the
   hub. DPAPI ties the file to this Windows user. Other systems: nothing is
   shared (peek says so).
   =========================================================================== */

import { createCredentials as coreCredentials, KEY_NAMES as CORE_KEYS } from '../../../vendor/ecosystem-core/lib/credentials.mjs';

export const FILE_NAME = 'credentials.bin';
export const KEY_NAMES = CORE_KEYS;

export const supported = () => process.platform === 'win32';

export function createCredentials(app, opts) {
  const o = opts || {};
  const inner = coreCredentials({ app, dir: o.dir || null, crypto: o.crypto || null });
  return {
    app,
    file: inner.file,
    peek() { if (!supported() && !o.crypto) return { exists: false, supported: false }; return inner.peek(); },
    read: inner.read,
    write: (ai, w) => inner.write(ai, { keepOthers: !(w && w.keepOthers === false) }),
    allow: (on) => inner.allow(!!on),
    clear: inner.clear,
  };
}

/* Lantern's own view of the shared file. */
export const lantern = createCredentials('lantern');
