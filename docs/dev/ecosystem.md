# Lantern in the ecosystem

Lantern and Dayspring are separate apps that feel like one family. Each works fully on its own. When both run on one computer they find each other, share one account, pass events both ways, and never talk over each other.

**The shared contract is `ecosystem-core/docs/ECOSYSTEM.md`.** It covers presence files, security, the event table, the shared AI key, "one voice, one ear", voices and updates. Lantern follows it exactly. This page adds what Lantern owns:
- the sign-in handoff format
- Lantern's local API
- launching and installing Lantern from another app
- the look

The Dayspring side's to-do list is [dayspring-bridge.md](dayspring-bridge.md).

## Presence, security, events (summary)

**Presence**
- Lantern writes `%LOCALAPPDATA%\Ecosystem\apps\lantern.json` at start and removes it at exit:
  `{ app, version, port: 4321, pid, startedAt, token, api: "/api/eco", schema: 1, dataDir, handoff }`.
- `ECOSYSTEM_DIR` overrides the folder (tests).

**Security**
- The server listens on 127.0.0.1 only.
- Every request must name this computer in `Host` (otherwise 421).
- A request that carries an `Origin` must come from Lantern's own pages (otherwise 403).
- Anything that changes something or opens a window needs `x-eco-token` from the presence file (otherwise 401).

**Events**
- `POST /api/eco/event` takes `{ v: 1, id, type, source, at, data }`.
- The types are in `server/src/platform/eco.js` `EVENT_TYPES`, the same list as core's, including `mic.owner`.
- Unknown types, missing data, a type the sender isn't allowed to send, and events to itself are refused with 400 and a list of problems.
- `GET /api/eco/events` streams Lantern's outgoing events (SSE).

**What Lantern sends**

| Lantern event | Sent when |
|---|---|
| `course.offered` | A new offer arrives: `{ course, courseTitle, from, message, offerId }` |
| `course.accepted` / `course.declined` | The person answers an offer |
| `course.updated` | A course installed a new version: `{ course, title, from, to }` |
| `friend.request` | A new friend request for this person: `{ requestId, from, message }` |
| `friend.accepted` | Someone accepted this person's friend request: `{ name, userId }` |
| `lesson.started` | The player opens a lesson: `{ course, ref, title }` |
| `lesson.completed` | A lesson or check is finished: `{ course, ref, kind, title, courseTitle }` |
| `unit.completed` | A whole unit is finished (celebrate it) |
| `reminder.due` | The study reminder comes due; held while Dayspring is quiet |
| `app.update.available` | A new Lantern is ready: `{ app, version, notes }` |
| `user.signed_in` / `user.signed_out` | The account changes |
| `schedule.block.request` | The person pressed "Add study time to Dayspring": `{ title, course, time, minutes, days }` |
| `app.started` / `app.stopping` | Lantern starts or stops |

**What Lantern does with Dayspring's events**

| Event from Dayspring | What Lantern does |
|---|---|
| `dnd {on, until}`, `call.state {inCall}`, `alarm` | Goes quiet: no reminder toasts or sounds, and no idle updates |
| `speaking.start` / `speaking.stop` | Lantern's voice waits until the other app has finished (if both started at once, Lantern pauses and resumes after). Lantern sends the same events around everything it says |
| `schedule.block.started {title, course?, lesson?}` | Shows "Your study block has started. Open the course?" with a Dayspring chip |
| `mic.owner {app}` | Whoever is named listens for the wake word; Dayspring owns the mic when it runs, and `app.stopping` from Dayspring frees it (`GET /api/assistant/mic`) |

## Lantern's local API (for Dayspring)

Base URL: `http://127.0.0.1:<port from the presence file>` (4321 by default). No sessions and no cookies.

| Call | Token? | What |
|---|---|---|
| `GET /api/eco/hello` | no | `{ app: "lantern", version, schema, port }` |
| `GET /api/local/status` | no | Everything in one call: name, signed in/online, `courses[{ id, title, installed, percent, next, current, minutesLeft }]`, waiting `offers[{ id, from, course, message }]`, due `reminders`, `daysStudiedThisWeek`, and `sync { online, lastOkAt, pending }` |
| `GET /api/local/courses/<id>` | no | The full course overview: units, lessons, exercises, projects and checks, each with a status, plus the %, what's next and the time left |
| `GET /api/local/events` | no | SSE: offer, offer-answered, milestone, reminder, course-updated, progress, sync, lesson-started, lesson-completed, friend-request, friend-accepted, friends |
| `GET /api/local/offers` | no | Offers waiting for this person |
| `POST /api/local/offers/<id>/accept` `{ open?: false }` | yes | Accept. The course downloads, and Lantern opens (unless `open: false`) |
| `POST /api/local/offers/<id>/decline` | yes | Decline. The sender sees it in their Offers list |
| `POST /api/local/open` `{ course?, lesson? }` | yes | Opens Lantern at the course overview, or at a lesson |
| `POST /api/local/report` `{ course, lesson }` | yes | "I finished lesson X". Lantern checks its own record and answers `{ verified, lesson { status }, message, next, percent }`; it doesn't take the word for it |
| `GET /api/local/people` | yes, and the owner | The owner's people: accounts and email invitees, online, version, current course and lesson, progress |
| `POST /api/local/send` `{ to, course, message }` | yes, and the owner | Send a course; `to` is an account id or an email address |
| `GET /api/local/friends` | no | Friends, requests received (pending and ignored) and sent, the friend code, and `waiting` (the badge count) |
| `POST /api/local/friends/request` `{ to, message }` | yes | A friend request; `to` is a friend code, an email (waits for sign-up) or an account id |
| `POST /api/local/friend-requests/<id>/<accept\|decline\|ignore\|cancel>` | yes | Answer a request (or cancel your own) |
| `POST /api/local/study-block` `{ course, time, minutes, days }` | no (Lantern's own pages use it) | Sends `schedule.block.request` to Dayspring |
| `POST /api/eco/shutdown` | yes | Stop Lantern |

## One account: the sign-in handoff

The Lantern account (Supabase Auth) is the ecosystem account. Dayspring may sign into it with email + password or an emailed sign-in link (a 6-digit code only on hubs with custom SMTP). When Dayspring then installs or starts Lantern, it hands the session over so the person doesn't sign in twice.

Dayspring writes `<Lantern dataDir>/handoff.json`. The path is in Lantern's presence file as `handoff`; before Lantern first runs it's `%LOCALAPPDATA%\Lantern\handoff.json`.

```json
{ "v": 1, "refresh_token": "…", "hub": { "url": "https://….supabase.co", "anonKey": "…" },
  "created_at": 1790000000000, "from": "dayspring" }
```

**Rules**
- **One use:** Lantern deletes the file before it uses the token.
- **Fresh:** a handoff older than 5 minutes is refused.
- **Rotated at once:** Lantern exchanges the token immediately, so the copy in the file is dead afterwards.
- **The handing app lets go:** two apps can't share one refresh-token chain, because Supabase rotates tokens and treats reuse as theft. After handing over, Dayspring stops using its own session and uses Lantern's local API for everything account-related (offers, people, send). If Lantern is later removed, Dayspring asks the person to connect again.
- **Where it lives:** the file sits in the person's own `%LOCALAPPDATA%`, which Windows keeps from other users. It holds no password.
- **The hub:** `hub` is optional. If Lantern isn't connected to a hub yet, it adopts this one (the public anon key, never the service-role key).

## Starting, opening and installing Lantern

**Launcher:** `scripts/launch.mjs`. The Start shortcut and `lantern://` links go through `scripts/launch-hidden.vbs`, so no console window appears.

| Command | What it does |
|---|---|
| `node scripts/launch.mjs` | Starts Lantern if needed, then opens it. Only one copy ever runs |
| `… --open cfml` / `--open cfml:u3l2` | Opens at a course overview, or at a lesson |
| `… "lantern://open?course=cfml&lesson=u3l2"` | The same, from a link |
| `… --hidden` | Starts with no window (for Windows start-up, or another app) |
| `… --status` | Exit 0 if it's running, 1 if not |
| `… --stop` | Stops it |

- If Lantern is already running, the launcher calls that copy's `/api/local/open` with its token.
- Otherwise it installs a waiting update first, starts the server hidden, and waits until it answers.
- `lantern://` is registered per user (`HKCU\Software\Classes\lantern`) by the installer.

**Installer:** `Install Lantern.cmd` runs `scripts/install.ps1`.

| Option | Meaning |
|---|---|
| `--quiet` | No questions, no pauses |
| `--install-node` | Install Node.js LTS with winget if it's missing (only after the person agreed, e.g. in Dayspring) |
| `--no-shortcuts`, `--no-protocol`, `--no-start`, `--startup` | As named |
| `--status <file>` | Where progress JSON is written (default `%LOCALAPPDATA%\Lantern\install-status.json`) |

Progress is written after every step: `{ step, progress, ok, message, exitCode, root, at }`.

| Exit | Meaning | What the calling app does |
|---|---|---|
| 0 | Installed | Open Lantern (`launch.mjs`, or the Start shortcut) |
| 10 | Node.js missing, `--install-node` not given | Ask the person, "Lantern needs Node.js. Install it now?", then run again with `--install-node` |
| 11 | Node.js missing and there's no winget | Open https://nodejs.org (LTS), then run again |
| 12 | The self-test failed | Download `Lantern.zip` again and retry |
| 13 | Installing Node.js failed | As 11 |
| 14 | Anything else | Show the message |

The download is always `https://github.com/<owner>/lantern/releases/latest/download/Lantern.zip`. The suggested install folder is `%LOCALAPPDATA%\Programs\Lantern`; show it and ask before extracting.

## The shared AI key

This is core's format exactly: `%LOCALAPPDATA%\Ecosystem\credentials.bin`, which is `"ECO1"` followed by the DPAPI(CurrentUser, entropy `ecosystem-credentials-v1`) encryption of `{ v, ai: { provider, model, ollamaUrl, ttsProvider, keys }, consent: { dayspring, lantern }, updatedAt, updatedBy }`.

- **Implementation:** `server/src/platform/credentials.js`.
  - `peek()` shows what is shared, never a key.
  - `read()` works only after the person's yes in Lantern (Settings → AI key).
  - `allow()` records that answer.
- **Rules:** keys never go over HTTP between the apps, into logs, packs, backups, exports or the hub.

## Voices

| | Lantern: warm, friendly, male | Dayspring: warm, female |
|---|---|---|
| ElevenLabs | Will `bIHbv24MWmeRgasZH58o` (suggested alternative: Daniel `onwK4e9ZLuTAKqWW03F9`) | Matilda `XrExE9yKIg1WjnnlVkGX` |
| OpenAI | ash, then echo | coral |
| Edge natural voices | Andrew, then Brian, then Guy, then other male English "Natural" voices | Ava, then Jenny, then Aria |
| Windows | Microsoft David | Microsoft Zira |
| Last resort | The first en-US voice | |

- These are recorded in `server/src/platform/defaults.js` (`DEFAULTS.voice`, `CHAINS`, `defaultsFor()`).
- The person can pick any voice.
- **One voice at a time:** announce `speaking.start` before talking and `speaking.stop` after; wait (or duck) while the other app is speaking; an alarm always wins.

## The look: related but recognisable

**Semantic tokens.** Both apps style everything with the same token names:
- colour: `--bg`, `--surface`, `--surface-2`, `--line`, `--ink`, `--ink-2`, `--muted`, `--accent`, `--accent-2`, `--ok`, `--warn`, `--danger`, `--focus`
- radius: `--radius-s`, `--radius`, `--radius-l`
- space: `--space-1` … `--space-6`
- type: `--step--1` … `--step-3`, `--font-body` (Outfit), `--font-display`

**Brands**

| Brand | Look |
|---|---|
| **Lantern** (`data-brand="lantern"`) | Warm walnut and charcoal; amber/ember and brass accents; parchment ink; a teal counter-note; Fraunces for headings and the wordmark; a soft lamp glow (`--glow`); a "Lantern day" light variant |
| **Dayspring** (`data-brand="dayspring"`) | Dawn indigo glass |

- Lantern defines its values in `server/public/shell/shell.css` for now. Adopting `ecosystem-core/client/tokens.css` is one `<link>`; see the comment in `shell/index.html`.
- **Brand chips:** a notice that came from the other app wears a small chip in that app's colour, `<span class="chip dayspring">Dayspring</span>`.
- **Fonts:** Outfit and Fraunces ship in `app/theme/fonts/` for offline use.

**Shared patterns**
- **Updates:** "Update now / Next time I open Lantern / When I'm not using it", a "What's new" dialog with the release notes, a data backup before every update, and a rollback if it fails.
- **Launchers:** hidden consoles, one copy only, Start and Stop shortcuts, and `--quiet` installs with status JSON.

## Each app alone

Everything above degrades gracefully when the other app is missing:
- Lantern with no Dayspring: no chip, no announcements, and the "Add study time" button is off with a note.
- Dayspring with no Lantern: its study cards show "Install Lantern" instead of progress.

Every call to the other app has a short timeout and never blocks.

## Moving to ecosystem-core

Lantern now vendors `ecosystem-core` at `vendor/ecosystem-core` (`node scripts/sync-core.mjs` copies it in and records the version in `VENDORED.json`; an update replaces it with the program). The page files are served at `/eco/` (`/eco/client/tokens.css`, `/eco/client/lantern-avatar.js`, `/eco/shared/voices-defaults.mjs`, …). Done so far:

- `platform/eco.js` and `platform/credentials.js` are thin wrappers around core's `createEco` and `createCredentials`, keeping Lantern's interfaces (and its quiet state, microphone state and forwarding).
- The shell uses `tokens.css` with `data-brand="lantern"` (day theme, high contrast and less motion are `data-theme`, `data-contrast`, `data-motion`).
- The assistant uses core's `createLLM`, `createVoice`, `createWeb`, the lantern avatar, the audio chain, the sound panel, `layout-core` and the voice chains ([assistant.md](assistant.md)).
- **Still Lantern's own:** `platform/updater.js`. It adds what core's updater doesn't have: a database backup (`VACUUM INTO`), the `--selftest` gate before and after installing, and the update log in the database. Core's `cmp` and Lantern's `semver.js` agree.

The original mapping, for reference:

| Lantern today | Core | Notes |
|---|---|---|
| `platform/eco.js` (`writePresence`, `readPresence`, `peers`, `alive`, `peer`, `send`, `guard`, `tokenOk`, `receive`, `validateEvent`, `makeEvent`, `EVENT_TYPES`) | `createEco({ app: "lantern", port, dataDir, onEvent })` | The same names and shapes. `receive()` returns `{ ok, status, errors }` in both. Keep Lantern's `quietState()` and `startForwarding()` as the `onEvent` handler and bus bridge |
| `platform/credentials.js` (`createCredentials`, `lantern`) | `createCredentials({ app: "lantern" })` | The same file and format |
| `platform/defaults.js` (`CHAINS`, `defaultsFor`) | `shared/voices-defaults.mjs` | The same shape |
| `platform/updater.js` (`check`, `apply`, `status`, `normalizeMode`, `startLoop`) | `createUpdater({ app: "Lantern", root, dataDir, repo, assetName: "Lantern.zip", entry: "server/src/index.js", keep: KEEP })` | Core's "launch" is Lantern's "next-launch" (both accepted). Keep Lantern's update log (database) and the `--selftest` check in place |
| `platform/bus.js` | `lib/bus.mjs` `createBus()` | Same `emit`, `on` and SSE stream |
