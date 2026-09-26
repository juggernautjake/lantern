# The ecosystem contract

This is how Dayspring and Lantern (and any later sibling) work together on one computer. Each app works fully on its own. Everything here is extra, and it all degrades gracefully when the other app isn't there.

The implementation is `lib/eco.mjs` and `lib/credentials.mjs`. Lantern's `server/src/platform/eco.js` follows the same format, and the two must stay in step: same folder, file shape, schema number and event types.

## 1. Discovery: presence files

Each running app writes one file into a shared, per-user folder, and removes it when it stops:

```
%LOCALAPPDATA%\Ecosystem\apps\<app>.json        (ECOSYSTEM_DIR overrides the folder, for tests)
{ "app": "dayspring", "version": "1.0.1", "port": 4747, "pid": 1234, "startedAt": 1790000000000,
  "token": "<48 hex chars, new every start>", "api": "/api/eco", "schema": 1,
  "dataDir": "…", "handoff": "…/handoff.json" }
```

To find another app, read its file, then ask `GET <api>/hello`. The answer is `{ app, version, schema }`. A file left behind by a crash doesn't answer, so it's ignored. `eco.peer(name)` caches the result for 30 seconds.

**Ports:**
- Dayspring: 4747
- Lantern: 4321
- whisper (speech recognition): 4781 and up. Only one app runs it; see section 6.

## 2. Security

Everything listens on **127.0.0.1 only**. On top of that, every request goes through three checks:

| Check | Why |
|---|---|
| The `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (otherwise 421) | A web page can't use DNS rebinding to reach the app |
| A request with an `Origin` must come from the app's own pages (otherwise 403) | An ordinary website can't drive the app from the browser |
| Anything that changes something or opens a window needs `x-eco-token: <token>` from the target's presence file (otherwise 401) | Only processes run by this Windows user can read the file; the token changes every start and is compared in constant time |

Read-only calls (hello, status, event streams) need only the first two checks.

## 3. Events

There is one versioned shape, used in both directions:

```
POST <api>/event   (x-eco-token required)
{ "v": 1, "id": "<uuid>", "type": "lesson.completed", "source": "lantern", "at": <ms>, "data": { … } }
```

| Type | Sent by | Required data | What the other app does |
|---|---|---|---|
| `lesson.started` | lantern | course, ref | Dayspring's study card shows "studying now" |
| `lesson.completed` | lantern | course, ref | Dayspring updates the study card; celebrates milestones out loud |
| `unit.completed` | lantern | course, ref, title | A Dayspring celebration announcement |
| `course.offered` | lantern | course, courseTitle, from | Dayspring: "*[name] wants to send you a course on Lantern…*" (Accept / Decline / Install) |
| `course.accepted` / `course.declined` | lantern | course | Dayspring tells the sender |
| `course.updated` | lantern | course, to | Dayspring can mention it |
| `reminder.due` | both | text | Shown and spoken by whichever app is on screen; Dayspring can snooze it |
| `study.goal` / `streak` | lantern | minutes, goal / days | Dayspring's morning rundown |
| `app.update.available` | both | app, version | The other app can show the shared "What's new" card |
| `user.signed_in` / `user.signed_out` | both | — | Refresh anything account-related |
| `schedule.block.request` | lantern | title, time, minutes | "Add study times to your Dayspring schedule" |
| `schedule.block.started` / `ended` | dayspring | title | Lantern can offer to open the matching lesson |
| `alarm` | dayspring | — | Lantern goes quiet |
| `dnd` | dayspring | on | Lantern respects quiet hours |
| `call.state` | dayspring | inCall | Lantern stays silent during calls |
| `focus.start` / `focus.stop` | both | — | Fewer interruptions |
| `speaking.start` / `speaking.stop` | both | app | The other app waits (or ducks) while this one talks |
| `mic.owner` | both | app | Who listens for the wake word right now |
| `app.started` / `app.stopping` | both | app | Refresh peers |

`validateEvent()` rejects:
- an unknown type
- missing data fields
- an app sending a type it isn't allowed to send
- an app sending an event to itself

Add new types to `EVENT_TYPES` in both apps at the same time. Unknown types are refused, not ignored, so a mismatch shows up in testing.

## 4. The shared AI key (with the user's permission)

If the AI is set up in one app, the other can ask "**Use the AI key from Dayspring?**", and the same the other way round.

```
%LOCALAPPDATA%\Ecosystem\credentials.bin
"ECO1" + DPAPI(CurrentUser, entropy "ecosystem-credentials-v1") of
{ v: 1, ai: { provider, model, ollamaUrl, ttsProvider, keys: { anthropic, openai, xai, elevenlabs } },
  consent: { dayspring: true, lantern: false }, updatedAt, updatedBy }
```

- `peek()` tells the app a key exists (provider, model, which keys) **without any key**. That's what the question shows.
- `read()` returns the keys only if this app has consent. The app that saved them has consent automatically.
- `allow(true)` records the user's yes, and `allow(false)` takes it back.

**Rules:**
- Keys are never sent between the apps over HTTP.
- Keys are never logged, and never put in course packs, syncs or error messages.
- Another Windows user, or a copy of the file on another computer, can't decrypt it.
- Writes are atomic (a temporary file, then a rename).

## 5. Signing in once (the handoff)

When both apps use the Lantern account, the one that's signed in writes a one-time handoff into the other app's `dataDir`. The path comes from the presence file's `handoff` field. The handoff holds a refresh token that expires in 5 minutes and is deleted as soon as it's read. The file lives in the user's own AppData, which only processes of this Windows user can read. The Lantern side owns the exact format; see Lantern's `docs/dev/ecosystem.md`.

## 6. One voice, one ear

**One voice at a time.**
- An app sends `speaking.start` before it talks and `speaking.stop` after.
- The other app holds anything it wants to say until `speaking.stop`, or for at most 20 seconds, and ducks its media meanwhile.
- An alarm always wins.

**One ear at a time.**
- Only one app listens for its wake word through the microphone.
- The rule: **Dayspring owns the mic when it's running**, and Lantern listens only when Dayspring isn't there, or when Dayspring passes the mic with `mic.owner: { app: "lantern" }`.
- Each app still answers to its own name, so Dayspring forwards "*Lantern, …*" requests to Lantern's local API.
- Only the mic owner runs whisper (port 4781+).

**Separate browser profiles and sign-ins.** Each app keeps its own media-browser profile (`DayspringMedia`, `LanternMedia`) and its own Spotify redirect URI (its own port), because two browsers can't share one profile.

## 7. Voices

Each app has its own default voice, so they're never mistaken for each other (`shared/voices-defaults.mjs`):

| | Dayspring (warm, female) | Lantern (warm, male) |
|---|---|---|
| ElevenLabs | Matilda `XrExE9yKIg1WjnnlVkGX` | Will `bIHbv24MWmeRgasZH58o` (alternative: Daniel `onwK4e9ZLuTAKqWW03F9`) |
| OpenAI | coral → shimmer | ash → echo |
| Edge natural voices (free) | Ava → Jenny → Aria → other English female natural voices | Andrew → Brian → Guy → other English male natural voices |
| Windows voices | Zira | David |

The user's own choice always wins.

## 8. Updates

Both apps use `lib/updater.mjs` the same way:
- **Releases:** a GitHub release with a fixed download name (`Dayspring.zip`, `Lantern.zip`).
- **When to install:** Update now, "Next time I open …", or "Automatically when I'm not using it". Idle installs never happen during an alarm, a call or while speaking.
- **Before installing:** the data is backed up.
- **If it fails:** the old version comes back.
- **History:** a readable history, and the shared "What's new" dialog (`.eco-whatsnew`).
