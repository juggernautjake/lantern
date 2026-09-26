// Which voice each app speaks with when nobody has chosen one. One list, used by the servers (ElevenLabs and OpenAI)
// and by the pages (the free voices built into the browser). The user's own choice always wins; these are defaults.
//
//   Dayspring: a friendly, warm female voice.   Lantern: a warm, friendly male voice.
//   The two are different on purpose, so the apps are never mistaken for each other when both are running.
//
// This file has no imports and touches no Node or browser globals, so it works in both:
//   server:  import { CHAINS, pickBrowserVoice } from "ecosystem-core/voices-defaults"
//   page:    import { pickBrowserVoice } from "/vendor/ecosystem-core/shared/voices-defaults.mjs"

export const CHAINS = {
  dayspring: {
    gender: "female",
    elevenlabs: [{ name: "Matilda", id: "XrExE9yKIg1WjnnlVkGX" }],
    openai: ["coral", "shimmer"],
    // the free voices, tried in order (Edge's "Natural" voices first, then Windows' own)
    browser: [
      { name: "Ava", natural: true },
      { name: "Jenny", natural: true },
      { name: "Aria", natural: true },
      { names: ["Ava", "Jenny", "Aria", "Emma", "Michelle", "Sonia", "Libby", "Natasha"], natural: true },
      { name: "Zira" },
    ],
  },
  lantern: {
    gender: "male",
    elevenlabs: [{ name: "Will", id: "bIHbv24MWmeRgasZH58o" }, { name: "Daniel", id: "onwK4e9ZLuTAKqWW03F9", alternative: true }],
    openai: ["ash", "echo"],
    browser: [
      { name: "Andrew", natural: true },
      { name: "Brian", natural: true },
      { name: "Guy", natural: true },
      { names: ["Andrew", "Brian", "Guy", "Christopher", "Eric", "Roger", "Steffan", "Ryan", "Thomas", "William"], natural: true },
      { name: "David" },
    ],
  },
  // Dayspring's guided setup has its own guide voice (warm, male), separate from Dayspring's own voice.
  guide: {
    gender: "male",
    elevenlabs: [{ name: "Will", id: "bIHbv24MWmeRgasZH58o" }],
    openai: ["ash", "echo"],
    browser: [{ name: "Andrew", natural: true }, { name: "Brian", natural: true }, { name: "Guy", natural: true }, { name: "David" }],
  },
};

const EN = (v) => /^en([-_]|$)/i.test(v?.lang ?? "");
const US = (v) => /^en[-_]US/i.test(v?.lang ?? "");
const NATURAL = (v) => /natural|online|neural/i.test(v?.name ?? "");
const word = (n) => new RegExp(`\\b${n}\\b`, "i");

function matches(rule, v) {
  if (!v || typeof v.name !== "string") return false;
  if (rule.natural && !(NATURAL(v) && EN(v))) return false;
  if (!rule.natural && !EN(v)) return false;
  if (rule.name) return word(rule.name).test(v.name);
  if (rule.names) return rule.names.some((n) => word(n).test(v.name));
  return false;
}

// voices: the browser's list (speechSynthesis.getVoices()) or any [{ name, lang }].
// chain: "dayspring" | "lantern" | "guide" | a chain object. Returns one voice (or null when there are none).
export function pickBrowserVoice(voices, chain = "dayspring") {
  const c = typeof chain === "string" ? CHAINS[chain] ?? CHAINS.dayspring : chain;
  const list = [...(voices ?? [])];
  for (const rule of c.browser ?? []) {
    const v = list.find((x) => { try { return matches(rule, x); } catch { return false; } });
    if (v) return v;
  }
  return list.find(US) ?? list.find(EN) ?? list[0] ?? null;
}

// The ElevenLabs voice id and OpenAI voice for an app's default.
export function defaultsFor(app = "dayspring") {
  const c = CHAINS[app] ?? CHAINS.dayspring;
  const main = c.elevenlabs.find((v) => !v.alternative) ?? c.elevenlabs[0];
  return { app, gender: c.gender, eleven: main.name, elevenId: main.id, alternatives: c.elevenlabs.filter((v) => v.alternative), openai: c.openai[0], openaiFallback: c.openai[1] ?? null };
}

// The OpenAI voice to use, given the voices a provider accepts (a newer or older model may not have every name).
export function pickOpenAIVoice(available, app = "dayspring") {
  const c = CHAINS[app] ?? CHAINS.dayspring;
  const have = new Set((available ?? []).map((x) => String(x).toLowerCase()));
  return c.openai.find((v) => have.has(v)) ?? [...have][0] ?? c.openai[0];
}
