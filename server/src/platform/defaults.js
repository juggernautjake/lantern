/* ===========================================================================
   server/src/platform/defaults.js — Lantern's default settings.
   ---------------------------------------------------------------------------
   Values a fresh copy starts with; a person can change every one of them.
   Features that are not built yet (the spoken assistant) read their defaults
   from here so the choices are made in one place. See docs/dev/ecosystem.md.
   =========================================================================== */

export const DEFAULTS = {
  updates: { mode: 'next-launch' },          // 'ask' | 'next-launch' | 'idle'
  reminders: { enabled: false, time: '19:00', days: [1, 2, 3, 4, 5] },
  studyGoalMinutes: 20,
  dayspring: { announce: true, autoOpenOnStudyBlock: false },
  palette: null,                              // null = follow the system (light or dark)

  /* The assistant's voice: warm and friendly, male. (Dayspring's is a warm
     female voice, so the two apps are never mistaken for each other.) The
     first one available on this computer is used; the person can choose any. */
  voice: {
    character: 'warm, friendly, male',
    chain: [
      { provider: 'elevenlabs', voiceId: 'bIHbv24MWmeRgasZH58o', name: 'Will', alternative: { voiceId: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' } },
      { provider: 'openai', voice: 'ash', fallback: 'echo' },
      { provider: 'edge', names: ['Microsoft Andrew Online (Natural)', 'Microsoft Brian Online (Natural)', 'Microsoft Guy Online (Natural)'], thenAny: 'male Natural en-*' },
      { provider: 'windows', names: ['Microsoft David'] },
      { provider: 'any', lang: 'en-US' },
    ],
    // Only one app speaks at a time: announce speaking.start / speaking.stop on
    // the ecosystem bus and wait (or duck) while the other is speaking.
    coordinate: true,
  },
};

/* The same chains in the shape of ecosystem-core/shared/voices-defaults.mjs
   (CHAINS, defaultsFor), so moving to the shared package is a swap of imports. */
export const CHAINS = {
  lantern: { gender: 'male', elevenlabs: [{ name: 'Will', id: 'bIHbv24MWmeRgasZH58o' }, { name: 'Daniel', id: 'onwK4e9ZLuTAKqWW03F9', alternative: true }],
    openai: ['ash', 'echo'], browser: [{ name: 'Andrew', natural: true }, { name: 'Brian', natural: true }, { name: 'Guy', natural: true }, { name: 'David' }] },
  dayspring: { gender: 'female', elevenlabs: [{ name: 'Matilda', id: 'XrExE9yKIg1WjnnlVkGX' }],
    openai: ['coral', 'shimmer'], browser: [{ name: 'Ava', natural: true }, { name: 'Jenny', natural: true }, { name: 'Aria', natural: true }, { name: 'Zira' }] },
};
export function defaultsFor(app) {
  const c = CHAINS[app] || CHAINS.lantern;
  const main = c.elevenlabs.find((v) => !v.alternative) || c.elevenlabs[0];
  return { app: app || 'lantern', gender: c.gender, eleven: main.name, elevenId: main.id, alternatives: c.elevenlabs.filter((v) => v.alternative), openai: c.openai[0], openaiFallback: c.openai[1] || null };
}

/* Dayspring's, recorded here for the ecosystem contract and the tests. */
export const DAYSPRING_VOICE_CHAIN = [
  { provider: 'elevenlabs', voiceId: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda' },
  { provider: 'openai', voice: 'coral' },
  { provider: 'edge', names: ['Microsoft Ava Online (Natural)', 'Microsoft Jenny Online (Natural)', 'Microsoft Aria Online (Natural)'] },
  { provider: 'windows', names: ['Microsoft Zira'] },
];
