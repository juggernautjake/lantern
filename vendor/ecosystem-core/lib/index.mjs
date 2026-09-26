// ecosystem-core: the shared parts of Dayspring and Lantern. Import the pieces you need:
//   import { createLLM, fromEnv } from "ecosystem-core/llm"   (or from this index)
export { createLLM, fromEnv, PROVIDERS, ANTHROPIC_MODELS, toOpenAI } from "./llm.mjs";
export { createVoice, VOICES, OPENAI_VOICES, DESCRIBE, OPENAI_DESCRIBE, TONES, toneAt, speakable } from "./voice.mjs";
export { CHAINS, pickBrowserVoice, defaultsFor, pickOpenAIVoice } from "../shared/voices-defaults.mjs";
export { createWeb, readable, safeUrl } from "./web.mjs";
export { createDocuments, TYPES as DOCUMENT_TYPES, supported as documentSupported } from "./documents.mjs";
export { createUpdater, cmp as compareVersions } from "./updater.mjs";
export { createBus } from "./bus.mjs";
export { createCredentials, dpapi, dpapiAvailable, fakeCrypto, KEY_NAMES } from "./credentials.mjs";
export { createEco, EVENT_TYPES, SCHEMA as ECO_SCHEMA, validateEvent, ecoDir } from "./eco.mjs";
