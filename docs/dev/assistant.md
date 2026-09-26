# The assistant (for developers)

"Lantern" the companion: the docked panel with the lantern avatar, its voice, the wake word, the sound panel, the mini player and the resource finder. People's guide: [docs/assistant.md](../assistant.md).

## Where it is

```
server/src/assistant/
  brain.js       which AI (shared key by consent → env → none) and which voice (ecosystem-core createLLM / createVoice)
  context.js     where the learner is, the item in front of them, the hint ladder; never an answer
  tools.js       lesson_context · next_hint · course_progress · open_course · review_code · find_resources ·
                 play_video · look_up · media_control
  skills.js      the built-in commands (no AI needed): hints, progress, navigation, player, resources
  chat.js        one turn: skills first, then Claude's Messages loop or chatWithToolsOpenAI; history in memory
  prompts.js     the persona and the guardrail
  resources.js   queries per source, the allow-list, offline doc links, YouTube, the cache
  routes.js      /api/assistant/…  (see the header of the file)
server/public/shell/
  assistant.js   the panel, the speech queue, the wake word, the mini player, five settings sections
  speech-queue.js  one voice at a time; Stop means stop (pure, tested in Node)
  assistant.css
vendor/ecosystem-core/   shared with Dayspring: served at /eco/ (client/, shared/); lib/ imported by the server
```

## The guardrail

On a graded item the answer key is **absent**, not just forbidden:

- The assistant reads only the pack's manifest (objectives, key terms, takeaways), `context/exercises.json` (prompts and authored hints) and the learner's own progress.
- `context/exercises.json` comes from the course structure module's `context()` export. `scripts/build-pack.mjs` refuses one that has a `solution`, `starter`, `assertions`, `expected`, `answer…` or `value` field anywhere (`contextLeak()`).
- `review_code` is only offered on a turn where the learner asked about their code, and only then is their code sent. When this computer has the course's source (an author's), their code is also run against the checks; only the checks' **messages** leave, never an expected value.
- `next_hint` gives hint *n+1* only, where *n* is the larger of the hints the course recorded and the hints the assistant gave; never on a check or an exam.
- The system prompt says GRADED / PASSED / CHECK from the learner's actual state.
- Tests: `server/test/test-assistant.mjs` checks every exercise's solution and long assertion values against the pack's context, every `lesson_context`, every hint, and every payload sent to a fake Claude. `e2e-assistant.mjs` checks every request the running app sent.

## Adding a course

For hints on a learner's computer, the course's structure module exports `context()` returning `{ version: 1, items: [{ id, kind: "exercise" | "check" | "milestone", unit, lesson | project, title, prompt, hints: [], skills: [] }] }`. For resources, put a `resources.json` next to `course.json` (see `courses/cfml/resources.json`): `subject`, `language`, `docs`, `tagDocs` ("https://…/{name}"), `providers`, `subreddits`, and per-unit `topic`s. Both are optional; without them the assistant still explains from the manifest and searches with the lesson's title.

## One voice, one microphone

- **Speaking:** everything goes through `createSpeechQueue`. Each `stop()` bumps a generation; `speak(text, stale)` must stop when `stale()` is true and never start the next sentence. `POST /api/assistant/speaking {on}` sends `speaking.start` / `speaking.stop` to the other apps. While a peer is speaking (`eco-in` events), Lantern waits; if both started at once, Lantern pauses and resumes after. `alarm` and `call.state {inCall}` stop Lantern and pause the player.
- **Listening:** `GET /api/assistant/mic` → `eco.micState()`. Dayspring owns the wake word whenever it's running, unless it sends `mic.owner {app: "lantern"}`; `app.stopping` from Dayspring frees it. The page never opens the microphone in an automated browser (`navigator.webdriver`). Push to talk always works (the learner asked).
- Lantern never changes Windows audio devices; the sound panel has no device list.

## The AI

`brain.aiConfig()` order: the shared key file (only with this app's consent; cached for five minutes, since reading it asks Windows via a hidden PowerShell call), then `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` / `AI_PROVIDER` / `AI_MODEL` / `OLLAMA_URL`. A key typed in Settings goes into the shared encrypted file on Windows (and this app gets consent), or `<data>/lantern.env` elsewhere. `ANTHROPIC_BASE_URL` etc. point it elsewhere (the tests' fake Claude).

Claude's loop is in `chat.js` (tool_use, pause_turn, Claude's own `web_search`). OpenAI, Grok and Ollama use `chatWithToolsOpenAI` from ecosystem-core, with `look_up` for the web. On any AI failure the learner gets a plain sentence plus the built-in answer, never a stack trace.

## Test hooks

- `LANTERN_TEST_SEARCH=<url>`: web searches ask `<url>?q=` for `{ results: [{ title, url, snippet }] }` instead of the internet.
- `brain.useFetch(f)`, `resources.useWeb(w)`, `resources.useFetch(f)`: in-process stand-ins.
- `LANTERN_DEFAULT_HUB_FILE`, `LANTERN_NO_DEFAULT_HUB`: the default hub.

## Not yet

- **Spotify.** Dayspring plays Spotify through its own Playwright-driven browser and a PKCE sign-in whose redirect is fixed to port 4747. Lantern would need its own redirect URI (`http://127.0.0.1:4321/spotify/callback`), its own token file and a separate browser profile so the two apps don't fight over one. Until then, music in Lantern is YouTube (in the mini player).
- **Documents** ("read me this handout"): ecosystem-core's `createDocuments({ guard })` is vendored but not wired; it needs a folder-permission model first.
- **Dayspring-side wiring** of `speaking.*` and `mic.owner`: see [dayspring-bridge.md](dayspring-bridge.md).
