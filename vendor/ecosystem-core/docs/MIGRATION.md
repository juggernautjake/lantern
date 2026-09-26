# Moving the apps onto ecosystem-core

Do Dayspring first: most of this package was ported from it, so its swap is mostly mechanical. Then do Lantern. Change one module per step, and run each app's full test suite after every step (Dayspring: `node scripts/audit.mjs` and `scripts/qa-fresh-install.mjs --quick`; Lantern: its course checks and server tests).

## 0. Vendoring

Copy (don't link) the package into each app, so a release zip carries it and each app can update on its own schedule:

```
dayspring/apps/desk/vendor/ecosystem-core/     lantern/vendor/ecosystem-core/
```

- Add `"ecosystem-core": "file:./vendor/ecosystem-core"` to each app's `package.json`, or import it by relative path.
- Serve `vendor/ecosystem-core/client/` and `shared/` as static files at `/eco/` so pages can `import "/eco/client/lantern-avatar.js"`.
- Record the vendored version in `vendor/ecosystem-core/package.json`.
- Each app's updater must treat `vendor/` as program files. It's replaced on update, which is the default: `vendor` is not in `keep`.
- **Version drift:**
  - Both apps check `ECO_SCHEMA` and refuse events from a newer schema with a clear log line.
  - Bump `SCHEMA` only for breaking event changes.
  - Otherwise, add new event types to both apps in the same release pair.

## 1. Dayspring → core

| Dayspring today | Core replacement | Notes |
|---|---|---|
| `lib/announcer.mjs`: `addClient`, `clientCount`, `broadcast` | `lib/bus.mjs` `createBus()` | **Do this first.** Create the bus in `lib/bus-instance.mjs`, have announcer.mjs re-export `broadcast`, `addClient` and `clientCount` from it, then point the 19 importers (`ambient-routes`, `ambient`, `assistant`, `calendar-routes`, `connector-routes`, `discover`, `display`, `docskills`, `helpskills`, `media`, `player-routes`, `results`, `skyprefs`, `snooze`, `study`, `tunein`, `window-routes`, `discord/bot`, `server.mjs`) at `bus-instance.mjs` when they only need `broadcast`. That breaks the import chain (announcer → store, owner, learning, goals, morning…) that stops sharing. Dayspring's `addClient(res, { page, id })` maps to `addClient(res, { kind: page })`. Keep Dayspring's "speaker" bookkeeping in announcer. |
| `lib/llm.mjs` (imported by announcer, assistant, devices, discover, docskills, morning, research, setup-routes, transcripts, discord/bot) | `createLLM({ getConfig: fromEnv(process.env, { modelVar: "DAYSPRING_MODEL" }) })` in `lib/llm.mjs` | Keep `lib/llm.mjs` as a thin file that creates the instance and re-exports `provider`, `ready`, `modelName`, `label`, `canSearchWeb`, `complete`, `chatWithToolsOpenAI`, `test`, `models`, `PROVIDERS`, so no importer changes. The assistant's Anthropic loop can keep using `@anthropic-ai/sdk`, or switch to `llm.messages()`. Then add the shared key: if `.env` has no key and `createCredentials({ app: "dayspring" }).read()` does, use it. |
| `lib/voice.mjs` (announcer, assistant, morning, setup-routes, discord/audio, server) | `createVoice({ app: "dayspring", getSettings: settings.get, setSettings: settings.set, getConfig: () => ({ provider: env.TTS_PROVIDER, keys: { elevenlabs: env.ELEVENLABS_API_KEY, openai: env.OPENAI_API_KEY }, elevenModel: env.ELEVENLABS_MODEL }), pronounce: [[/\bSQL\b/g, "S Q L"]] })` (plus the app's own words) | Keep in Dayspring: `styleNote()` (conversation modes), `refreshVoiceNames()`/`settings.knownVoices` syncing, and the `settings.onChange` voiceId hook. `defaults()` becomes `voice.defaults()`. |
| `public/voices.js` (`window.dsVoicePrefs.pick(kind)`) | `shared/voices-defaults.mjs` `pickBrowserVoice(voices, "dayspring" \| "guide")` | Keep `window.dsVoicePrefs` as a small wrapper, because tv.js and welcome.js call it. |
| `lib/web.mjs` (abilities, discover, research) | `createWeb({ browserPage: (n) => browser.page(n) })` | Same `search`, `read`, `readable` and `safeUrl`. |
| `lib/documents.mjs` (abilities, docskills, document-routes) | `createDocuments({ guard: (p) => permissionsResolve(p), roots: permissions.roots, canRead: (p) => permissions.check("read", p).ok, isSecret: files.isSecret, progressFile: join(DATA, "docprogress.json"), require: createRequire(import.meta.url) })` | Move the current `guard()`'s path-resolving part (relative to `roots()[0]`, `~`) into the app-side `guard`. The secret-file rules are built into core. |
| `lib/updater.mjs` (update-routes, server) | `createUpdater({ app: "Dayspring", root: DESK, assetName: "Dayspring.zip", repo: () => env.DAYSPRING_UPDATE_REPO \|\| pkg.dayspring.updateRepo, api: () => env.DAYSPRING_UPDATE_API \|\| "https://api.github.com", identify: (p) => /dayspring/i.test(p.name + JSON.stringify(p.dayspring ?? {})) })` | Keep in Dayspring: `restoreHelpers()` (the v1.0.0 → v1.0.1 bin/ recovery) and the `startDailyCheck` alias. Pass `busy` (alarm, call, Tune in) and `restart` to `startAuto`. |
| `public/tv.js` audio (`makeChain`, `audioCtx`, `onBus`, `duck`, the `LEVELS` mixer) | `client/audio-chain.js` `createAudio()` | tv.js is one large script, so migrate it last. `onBus("notify", fn)` becomes `audio.sfx(fn, "notify")`; the YouTube and Spotify players register through `audio.media.add({ kind, setVolume })`. Device routing (`setSinkId` per role) stays in tv.js. |
| `public/tv.js` sound panel (`#soundPanel`) | `client/sound-panel.js` | Pass `outputs` (`/devices`, `/sound/outputs`) and `inputs` (`/devices/use`). Dayspring's extra sections (Calls / Tune in, At night) go in through `extra(el)`. |
| `public/tv.js` orb (`drawViz`, `MOODS`) | `client/voice-orb.js` | `stage(mode)` calls `orb.setState(mode)`; `setMood` calls `orb.setMood`; while speaking, `orb.setAnalyser(analyser)`. The caption and chip stay in tv.js. |
| `public/layout.js` margins, scale, Fit to screen, window bar | `client/layout-core.js` | The fitters (the "More" menu, `.fitv`, row caps) stay Dayspring-specific. Pass `contentTop` and `windowBar.onAction: (a) => post("/window", { action: a })`. Keep the confirm dialogs for Hide and Exit in layout.js. |
| Colours in `tv.html`, `setup.html`, `welcome.html` | `client/tokens.css` with `data-brand="dayspring"` | The old names (`--bg --ink --muted --dim --glass --edge --edge2`) map across; `--edge2` becomes `--edge-2`. Add aliases for one release. |
| (new) | `lib/eco.mjs` | Write the presence file (port 4747) and mount `eco.handle` on `/api/eco/*`. Emit `schedule.block.started`/`ended`, `alarm`, `dnd`, `call.state`, `speaking.*` and `mic.owner`. Handle `course.offered`, `reminder.due`, `lesson.completed` and the rest per ECOSYSTEM.md. |
| (new) | `lib/credentials.mjs` | Setup's AI step writes the shared file (`write`). The AI step says "Lantern already has an AI set up. Use it?" when `peek().exists && !peek().allowed`. |

## 2. Lantern → core

Lantern's platform (`server/src/platform/`) already follows the same contracts:
- Its `eco.js` has the same presence format, security rules and event types.
- Its `updater.js` follows the same backup/swap/rollback pattern.
- Its `defaults.js` records the same voice chains.

| Lantern today | Core replacement |
|---|---|
| `server/src/platform/eco.js` | `createEco({ app: "lantern", port: 4321, version, dataDir, onEvent: receive })`. Keep Lantern's `startForwarding()` (its own bus events → ecosystem events) and `quietState()`. |
| `server/src/platform/updater.js` | `createUpdater({ app: "Lantern", assetName: "Lantern.zip", dataDir: <%LOCALAPPDATA%\Lantern>, root: <program folder>, identify: (p) => p.name === "lantern" })`. Lantern keeps its data outside the program folder, so pass `dataDir` and leave `data` in `keep` anyway. Course-pack updates stay Lantern's own. |
| `server/src/platform/bus.js` | Keep it (it's Lantern's in-process event hub); use `createBus()` for the SSE side. |
| `server/src/ai/client.js` (Messages API) | Keep it for the tutor (streaming, budgets, caching). Use `createLLM` for OpenAI, xAI and Ollama users, and for `test()`/`models()` in setup. |
| (new) assistant voice | `createVoice({ app: "lantern", … })` and `pickBrowserVoice(voices, "lantern")` |
| (new) AI key | `createCredentials({ app: "lantern" })`: "Use the AI key from Dayspring?" |
| (new) the assistant's face | `client/lantern-avatar.js` in the docked assistant panel. Settings → Assistant appearance drives `setOptions` (presets, colours, metal, glow, flicker, size, rays, embers, reduced motion). |
| (new) sound, screen | `client/audio-chain.js`, `client/sound-panel.js`, `client/layout-core.js` |
| Theme | `client/tokens.css` with `data-brand="lantern"` and the `data-theme="day"` option. Align a course's own palettes with the brand: its warm dark palette is the closest match. |
| (new) web lookup | `createWeb({ allow })` with the learning-resource allow-list (cfdocs.org, the Adobe docs, Khan Academy, CrashCourse, Codecademy, MDN, Wikipedia, YouTube, Reddit…) |
| (new) documents | `createDocuments({ guard })` for "read me this handout" |
