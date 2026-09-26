# How Lantern is built

Lantern is a learning app that runs on each person's own computer. Courses are **packs** that work fully offline. A free hosted **hub** (a Supabase project) holds accounts, decides who may open which course, and keeps progress in sync between computers.

```
        a learner's computer                         the hub (Supabase, free tier)
 ┌──────────────────────────────────┐        ┌────────────────────────────────────┐
 │ browser: the app (server/public/ │        │ Auth: sign up, email links         │
 │   shell) + a course pack in an   │        │ Postgres: courses, offers, grants, │
 │   iframe (/packs/<id>/)          │ HTTPS  │   progress, presence, groups…      │
 │            │ same origin          │◀──────▶│   RLS on, writes only via RPCs     │
 │ Node server (127.0.0.1:4321)     │ (when  │ Storage: course-packs (private)    │
 │   SQLite in the DATA FOLDER      │ online)│                                    │
 │   sync engine + outbox           │        └────────────────────────────────────┘
 │   updater (GitHub releases)      │
 │   ecosystem API (Dayspring)      │◀── 127.0.0.1 ──▶ Dayspring, if it's running
 └──────────────────────────────────┘
```

## The rules

1. **Offline first.** Everything a person does is written on their own computer first. The hub is only a meeting place; the app never waits for it.
2. **The data folder is sacred.** Program files and data live apart. An update replaces the program, and never touches the data folder.
3. **Courses are not code.** A course is a pack: a manifest plus built pages. The platform can load any pack. Course content never goes into the public repo.
4. **Lesson ids are a promise.** Progress is stored against lesson, exercise and milestone ids. A new version of a course may add ids and reword things, but never drops or renames an id.
5. **No dependencies.** Node 22.13+ built-ins only: `node:sqlite`, `node:http`, `fetch`, `node:crypto`. There's no `npm install`.

## The layout

```
package.json                 version, "lantern.updateRepo"
server/
  src/
    index.js                 start-up: modes, boot, --selftest
    routes.js                the original platform API (files, grading, AI)
    http/server.js           router, bodies, sessions, the guard hook
    db/schema.sql            the baseline schema (idempotent)
    db/migrations.js         numbered, forward-only changes (with a backup first)
    platform/                ← the app around the courses
      config.js              modes, the data folder, the port, the hub address
      packs.js               course packs: validate, install, serve, export
      progress.js            progress items, the player's state, overview, import
      merge.js               the merge rules (done stays done, best wins, …)
      settings.js            small named values in the database
      local.js               the one person this copy is for; the device id
      backups.js             whole-database backups (VACUUM INTO) and rotation
      updater.js             Lantern updates from GitHub, with rollback
      bus.js                 in-process events, and SSE streams of them
      eco.js                 the ecosystem: presence, security, events
      credentials.js         the shared AI key (DPAPI), by consent
      defaults.js            default settings, including the voice chain
      routes.js              the app's endpoints (+ /api/local, /api/eco)
    assistant/             ← Lantern the companion (docs/dev/assistant.md)
      brain.js context.js tools.js skills.js chat.js prompts.js resources.js routes.js
      sync/
        supabase.js          the hub adapter (plain fetch)
        engine.js            sign-in, heartbeat, push/pull, downloads, offers
    ai/ files/ search/ …     the original platform (grading, filing, assistant)
  public/
    shell/                   the app's pages: courses, overview, player, settings, owner,
                             and the assistant (assistant.js, speech-queue.js)
    index.html               the original workspace (/workspace)
  test/                      the test suites and the fake hub
app/theme/                   palettes, fonts (offline), code themes
courses/<id>/                a course's source (course.json, structure, pages)
supabase/migrations/         the hub, in SQL
vendor/ecosystem-core/       shared with Dayspring (served at /eco/): AI, voices, web, the key file,
                             the app bus, tokens, the lantern avatar, sound panel (scripts/sync-core.mjs)
config/hub.json              the default hub (empty in the repo; a release can carry one)
scripts/                     build-pack, publish-course, launch, update, install,
                             export, release, privacy-scan
docs/                        people's guides; docs/dev: this and the contracts
```

## Modes

| Mode | What it is | Data folder |
|---|---|---|
| `app` (the default) | Lantern on a person's computer. One person, no local password, 127.0.0.1 only. | `%LOCALAPPDATA%\Lantern`, or `LANTERN_DATA` |
| `demo` | The original demo school, for working on the platform itself (`npm run demo`). | `server/data` |

The mode comes from `LANTERN_MODE` or from `lantern.json` in the data folder.

## The data folder

| File | What |
|---|---|
| `lantern.db` | Everything: the person, installed packs, progress, the outbox, settings, the update log |
| `packs/<id>/<version>/` | Each installed course (the current version and the one before it) |
| `backups/` | `lantern-<time>-<reason>.db` (the newest 10) and `program-<version>-<time>/` (the newest 3) |
| `updates/` | Downloaded releases |
| `lantern.json` | Mode, port, the hub's address and public key |
| `handoff.json` | A one-time sign-in handed over by another app (deleted on read) |
| `privacy-terms.json` | On a course author's computer only: words the public export must never contain |

## Course packs

See [authoring-courses.md](authoring-courses.md) for the whole contract. In short:

- A `.lpack` file is one JSON document: `{ lanternPack: 1, manifest, files: { path: base64 } }`.
- Every file's size and sha256 are in the manifest, so a damaged download is refused.
- It installs to `packs/<id>/<version>/` and is served at `/packs/<id>/…`, the same origin as the app. The course's pages can therefore keep using browser storage.
- **The player** (`#/learn/<id>`) mirrors every change of the pack's declared storage keys into the database, and writes the database's copy back before the pack loads. It uses browser `storage` events, so a pack needs no special code to be saved and synced.
- **The progress map** in the manifest tells the platform where lessons, exercises and milestones live in the pack's state. It uses that to build progress items and the overview, and to write completions from other computers back in.

## Progress and sync

- **Items:** `progress_items` holds one row per lesson, exercise, milestone and check, merged by `merge.js`. `dirty = 1` means the hub doesn't have it yet.
- **Time:** time events, each with its own id, so they're counted once however often they're sent.
- **Position:** "where I was", with a timestamp; the newest wins.
- **Snapshot:** the pack's whole state. The newest copy wins, and only when nothing local is unsent. The one it replaces is kept in `pack_progress_history`.
- **The sync engine** (`sync/engine.js`) runs every few seconds while online, and backs off exponentially while offline. On each pass it:
  - refreshes the token
  - sends a heartbeat
  - pushes whatever is dirty and merges what comes back
  - refreshes the course list and offers (about every 30 seconds)
  - downloads any course or new version the person should have

## The hub

`supabase/migrations/0001_lantern_hub.sql` holds the hub.

- **Tables:**
  - `profiles` (with a role: owner or student)
  - `courses` (draft or published; private or open; listed or not), `course_versions`
  - `grants`, `course_offers` (to an account or to an email), `invites`
  - `groups`, `group_members`, `group_courses`, `course_requests`
  - `presence`
  - progress: `progress_items`, `progress_time`, `progress_position`, `progress_snapshots`, `progress_summary`
  - `preferences`
- **Security:** RLS is on everywhere. People read their own rows and the owner reads everything. Every write goes through a `lantern_*` function that checks who is asking.
- **Storage:** the private `course-packs` bucket is readable only for courses the person has.

The owner's dashboard reads the hub through `lantern_owner_*` functions. The app itself is the only client; there is no other server.

## Updates

See `platform/updater.js` and [releasing.md](releasing.md).

- **Where from:** GitHub releases with one asset, always named `Lantern.zip`.
- **Before installing:** the new version is checked (`--selftest`), and the database and the program are backed up.
- **Installing:** the program folder's entries are swapped by rename, the check runs again in place, and anything that fails is rolled back.
- **When:** one of three modes: ask, next launch, or idle. Idle never installs during a call, an alarm, or while another app is speaking.
- **Course updates:** these come from the hub and install on the next sync, and progress is kept.

## Seams for what comes next

| Seam | Where | For |
|---|---|---|
| `LanternShell.registerSettings({ id, title, order, render })` | `server/public/shell/shell.js` | Voice, Sound, Display, Assistant appearance, Code editor sections |
| `LanternShell.registerAssistant(render)` and `#assistant-slot` | shell | The docked "Lantern" assistant panel |
| `LanternShell.registerMedia(render)` and `#media-slot` | shell | A mini music or video player |
| `LanternShell.context()`, `GET /api/courses/:id/context`, `GET /api/context` | shell, `platform/routes.js` | The current course, unit, lesson, objectives and key terms, for the assistant and the resource finder |
| `credentials.lantern.peek() / read() / allow()` | `platform/credentials.js` | Using the AI key set up in Dayspring (with consent) |
| `DEFAULTS.voice`, `CHAINS`, `defaultsFor()` | `platform/defaults.js` | The assistant's voice (warm, male; Will first) |
| Semantic CSS tokens (`--bg`, `--surface`, `--ink`, `--accent`, …) | `shell/shell.css` | Switching to `ecosystem-core/client/tokens.css` (`data-brand="lantern"`) with one link |
| `eco.js`, `updater.js`, `defaults.js` | platform | Same shapes as ecosystem-core's `lib/eco.mjs`, `lib/updater.mjs` and `shared/voices-defaults.mjs`; see [ecosystem.md](ecosystem.md#moving-to-ecosystem-core) |
