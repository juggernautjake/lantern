# ecosystem-core

The shared building blocks of **Dayspring** (a day planner and voice assistant for a TV or second screen) and
**Lantern** (a learning platform). Both apps vendor this folder, so a fix in one place fixes both, and the two feel like
one family while keeping their own identity.

MIT licensed. Node 22.9 or newer. **No required dependencies.** The optional document readers are used only if the app
has them installed.

## What's inside

| Server (`lib/`) | What it does |
|---|---|
| `llm.mjs` | The AI "brain": Claude, ChatGPT, Grok or a local Ollama model, in one conversation format. The app passes its config in; nothing reads `.env` here. |
| `voice.mjs` | Text to speech: ElevenLabs, OpenAI, or the free voices built into the browser. Each app has its own default voice. |
| `web.mjs` | Web search (DuckDuckGo, then Bing, then Bing in a browser if the app provides one) and readable page text. Takes an optional allow-list, e.g. for learners. The injected browser page must be HEADLESS: nothing in the background may open a window. |
| `ytsearch.mjs` | YouTube search with no browser and no API key: reads youtube.com's own results page. Filters: recent, popular, newest, playlists, Shorts. An optional API key uses the Data API first. |
| `documents.mjs` | Reads Word, PDF, PowerPoint, Excel/CSV, OpenDocument, RTF, text, email and pictures of text. The app's permission check is passed in. |
| `updater.mjs` | GitHub-release updates. Backs up the data first, swaps the program files, installs new packages only when needed, rolls back if the new version doesn't start, and keeps a history. |
| `bus.mjs` | Server-Sent Events from an app's server to its own pages, plus an in-process hook. |
| `credentials.mjs` | The AI key shared between the apps on one computer. Encrypted per Windows user with DPAPI, and read by an app only after the user agrees. |
| `eco.mjs` | How the apps find each other on this computer (presence files and a token) and exchange events safely. |

| Pages (`client/`) | What it is |
|---|---|
| `tokens.css` | One design system, two brands: `data-brand="dayspring"` and `data-brand="lantern"` (plus Lantern's `data-theme="day"`), high contrast, and reduced motion. |
| `lantern-avatar.js` | Lantern's face: a warm lantern with a living flame that flickers, listens, thinks and speaks. Six presets, and colours you can customise. |
| `voice-orb.js` | Dayspring's face: the living ring and glassy orb, with moods. |
| `audio-chain.js` | Web Audio: a level for voice, chimes, alarm, music and video; a clearer voice; media that ducks under the voice. |
| `sound-panel.js` | The Sound panel: levels, mute, test, speakers and microphone (the device lists come from the app). |
| `layout-core.js` | Screen fitting: TV margins, UI and text scale, the Fit-to-screen calibration, and the hover window bar. |
| `icons/` | The two app marks (SVG, PNG 16–256 px, .ico), drawn as siblings on the same grid. |

`shared/voices-defaults.mjs` works in both Node and the browser. It holds each app's default voice chain:
- **Dayspring** has a warm female voice: Matilda, then Coral, then Edge Ava, Jenny or Aria, then Windows Zira.
- **Lantern** has a warm male voice: Will (or Daniel), then Ash, then Edge Andrew, Brian or Guy, then Windows David.

## Try it

```
node scripts/serve.mjs          # then open http://127.0.0.1:4799/demo/
```

The demo shows both brands side by side:
- the lantern with every option and preset
- the orb
- the Sound panel (with pretend devices)
- the shared "What's new" dialog
- the components that carry one app's content inside the other

## Check it

```
npm test                  # unit tests (33): voices, AI providers, bus, credentials (real DPAPI on Windows), ecosystem, updater, documents, web
npm run test:demo         # the demo page in headless Chrome/Edge: states, presets, frame rate, brands, no errors; screenshots
npm run contrast          # measures every text/background pair in both brands → docs/contrast.md
npm run icons             # redraws the PNGs and .ico files from the SVGs
```

The demo test and the icon script use the `playwright-core` that Dayspring already has. Set `PLAYWRIGHT_CORE` if it's somewhere else.

## Docs

- [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md): the contract between the apps (discovery, security, events, the shared AI key, who speaks and listens).
- [docs/BRAND.md](docs/BRAND.md): the two identities, when to use which, do's and don'ts, measured contrast.
- [docs/MIGRATION.md](docs/MIGRATION.md): moving Dayspring, then Lantern, onto these modules.
