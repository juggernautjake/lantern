# Lantern platform inventory

Taken 22 Oct 2026, from the private working copy (`02-projects/lantern`, platform 0.1.9, FS 1.2.9 released, FS revamp in progress). This is a factual snapshot of what exists, measured against what a commercial, multi-course, multi-institution learning platform would need. Paths are relative to the repo root unless stated.

**Not inspected:** the installed copy. no installed copy was within reach of this survey. Secrets were not read either: `.env` files, keys, the claim code and the values in `config/hub.json`. The last one is not empty; it holds `url` and `anonKey` keys.

---

## 1. What Lantern is today

### Architecture
- **A desktop app** made of two parts (`docs/dev/architecture.md`, `server/src/index.js`):
  - a zero-dependency Node 22.13+ server on `127.0.0.1:4321`, using `node:sqlite` and `node:http` (`package.json` `engines`);
  - a browser "shell" (`server/public/shell/`) that loads each course pack in a same-origin iframe at `/packs/<id>/`.
- **Two server modes** (`server/src/platform/config.js`):
  - **`app`, the product.** One person per computer, no local password. Data lives in `%LOCALAPPDATA%\Lantern` (`platform/local.js`).
  - **`demo`, an older "demo school".** It has teachers, TAs, guardians, classes, assignments, grades, a filing system and a teacher-side AI agent (`server/README.md`, `server/src/db/schema.sql`, `server/src/seed.js`, `docs/19-platform-build-plan.md`). It is not what learners install.
  - **Most school features exist only in demo mode.** The demo routes are still registered in app mode (`index.js` boot), where they run as the local student.
- **The hub.** It is a Supabase project that each owner sets up on the free tier (`docs/public/setup-supabase.md`, `supabase/lantern_hub_all.sql`, `supabase/migrations/0001…0003`). It provides:
  - Auth;
  - Postgres with row-level security, where every write goes through a `lantern_*` RPC;
  - a private `course-packs` storage bucket.

  There is no other server.
- **Web.**
  - There is no hosted web app. `docs/01-architecture.md` plans one on Next.js/Vercel; it was never built.
  - Each course also builds as a single standalone HTML page: `dist/fs-studio.html` (21.6 MB) and `dist/cfml-studio.html` (2.0 MB). These are the "web version" in `docs/public/faq.md`.
- **The ecosystem.** Lantern vendors `vendor/ecosystem-core/` (shared with the sister app Dayspring). It covers the LLM wrapper, voices, the updater, the event bus, DPAPI credentials and design tokens. Lantern talks to Dayspring on `127.0.0.1:4747` (`docs/dev/ecosystem.md`, `docs/dev/dayspring-bridge.md`).
- **The data folder** (`docs/dev/architecture.md`) holds:
  - `lantern.db`;
  - `packs/<id>/<version>/` (the current version and the one before it);
  - `backups/` (the newest 10 databases and the newest 3 program copies);
  - `updates/`, `lantern.json` and `handoff.json`.

### How courses are built, packed and delivered
- **Source.** A course is a folder `courses/<id>/` holding `course.json`, `structure.json` or `structure.mjs`, and `site/` or a `build` step (`docs/dev/authoring-courses.md`). `courses/_template/` is a working example of about 80 lines.
- **Pack.**
  - `scripts/build-pack.mjs` writes `dist/packs/<id>.lpack`: one JSON file holding `{lanternPack:1, manifest, files:{path:base64}}`.
  - Each file in it carries a sha256, and a pack whose hashes don't match is refused (`server/src/platform/packs.js`).
  - The build refuses an assistant context that leaks answers (`contextLeak()`).
  - Lesson ids are permanent: the build warns, while publishing and installing refuse.
- **Publish.** `scripts/publish-course.mjs <id> [--publish|--open|--listed]` uploads to the hub bucket. It authenticates as the signed-in owner through the running app, or with a service-role key from a local `.env`.
  - Packs over 40 MB are gzipped and split into parts (`server/src/platform/sync/engine.js`).
- **Delivery.** People get a course in one of these ways:
  - the owner sends an offer to a person, an email address or a group;
  - an invite code (30 days);
  - a request for a "listed" course, which the owner approves;
  - opening an `.lpack` file directly (`docs/public/sharing-courses.md`).

  The app then downloads the course and runs it offline. New versions install on the next sync, and progress is kept.
- **Progress capture.** The player mirrors the pack's declared `localStorage` keys into SQLite. The `progress` map in `course.json` tells the platform where lessons and exercises live in that state, so a pack needs no special API (`docs/dev/authoring-courses.md`).

### Accounts and auth
- **Local.**
  - No password: any request from 127.0.0.1 gets the single local user's session cookie.
  - The cookie is HttpOnly and SameSite=Lax, and lasts 14 days by default (`server/src/http/server.js`, `platform/local.js`).
- **Hub (Supabase Auth over plain fetch, `server/src/platform/sync/supabase.js`).** Sign-in methods:
  - email and password;
  - an emailed magic link (back to `/auth/callback`);
  - an optional 6-digit email code, which needs the owner's own SMTP;
  - a one-use handoff from Dayspring.

  There is no OAuth or SSO.
- **Hub roles.** `profiles.role` is `owner` or `student`, with **one owner per hub**, claimed with a one-time code (`supabase/migrations/0001_lantern_hub.sql`). Learners can also make friends: friend codes, requests and blocks (`0002_friends.sql`). `0003_lock_helpers.sql` closed a privilege gap.
- **Demo-mode roles.** `admin`, `teacher`, `staff`, `student` and `guardian`, plus per-class `student`, `teacher`, `ta` and `observer`. Passwords use scrypt (`server/src/db/schema.sql`).
- **Planned, not built.** Households, parents, child PIN and picture-password sign-in (`docs/04-accounts-and-roles.md`, `docs/02-data-model.sql`).

### Progress sync
- Offline first: every change is written locally (`server/src/platform/progress.js`).
- The engine runs every 15 s while online, backs off to 5 min while offline, and refreshes the token, the heartbeat, the course list and offers on each pass (`sync/engine.js`).
- **What syncs:** progress items, time events (deduplicated by id), position, whole-state snapshots, a summary, preferences and presence.
- **Merge rules** (`platform/merge.js`, mirrored in SQL in `lantern_sync`):
  - done stays done;
  - the best score wins, and so does the highest attempt count;
  - the earliest first-done time is kept;
  - the newest position wins.
- **Snapshots:** a newer remote snapshot replaces local state only when nothing local is unsent, and the replaced copy goes to `pack_progress_history`.
- **Clock skew:** offsets over 2 minutes are corrected against the hub's clock.
- **Tests:** two offline computers merging is covered by `server/test/test-ecosystem.mjs` and `e2e-offer-flow.mjs`.

### The AI assistant
- **Models.** Provider defaults are in `vendor/ecosystem-core/lib/llm.mjs`:
  - Anthropic `claude-sonnet-5` (choices: `claude-sonnet-5`, `claude-opus-5-5`, `claude-haiku-4-5-20251001`);
  - OpenAI `gpt-5-mini`, xAI `grok-4`, Ollama `llama3.1:8b`.
- **Key.** It comes from the shared DPAPI key file, used only with consent, or else from environment variables (`server/src/assistant/brain.js`). With no key, the built-in skills still work (`assistant/skills.js`).
- **Tools in a course** (`assistant/tools.js`):
  - `lesson_context`, `next_hint`, `course_progress`, `open_course`
  - `review_code`, `find_resources`, `play_video`, `lesson_video`
  - `read_notes`, `save_note`, `look_up`, `media_control`
  - Claude's own web search (at most 3 uses per turn).
- **Other features:**
  - a docked panel and voice (ElevenLabs "Will" with a browser fallback), a wake word, and push to talk;
  - a mini player;
  - a review of every finished quiz, check or mock exam (`assistant/review.js`, CHANGELOG 0.1.7, 0.1.9).
- **Guardrails** (`docs/dev/assistant.md`, `assistant/prompts.js`, `assistant/context.js`):
  - On graded items the answer key is **absent** from the assistant's context, and `build-pack` enforces it.
  - Hints come one rung at a time, and never on checks or exams.
  - The learner's code is sent only when they ask about it.
  - Tool and web output is fenced and treated as data.
  - The guardrail is tested over every exercise (`server/test/test-assistant.mjs`, `e2e-assistant.mjs`).
  - **Gap:** `lesson_video` returns video end-questions with their answers. They are ungraded, but this is worth confirming as intended.
- **Limits and logging:**
  - In app mode there is no budget or rate limit, only per-turn caps (1,200 max tokens, 6 rounds, 60 s, 4,000-character input).
  - Chat history is kept in memory only, the last 10 turns. Quiz reviews are kept on disk, 40 per course.
- **Demo mode by comparison** (`server/src/ai/client.js`): a per-user monthly cap (500 calls, 100 searches), an `agent_runs` audit trail, and persisted threads.

### Offline behaviour
- Courses, grading, generators, videos (local audio), the calculator, the library and notes all run with no network (`docs/public/faq.md`, `app/fs/README.md`).
- The network is needed only to receive courses, sync, update, use the AI and search the web.
- **The hub:** if a free project pauses, apps keep working and sync later (`docs/public/setup-supabase.md`).
- **Robustness QA** (`scripts/qa/robust.mjs`) covers:
  - the hub down at start;
  - an expired sign-in;
  - a download cut off half way;
  - a full disk;
  - a damaged database.

### Payments and licensing
- **None.** There is no Stripe, no license keys, no paywall and no entitlements; a code search found nothing.
- Access is only `grants`, `course_offers`, `invites`, `course_requests` and `visibility='open'` (`0001_lantern_hub.sql`).
- The platform code is MIT-licensed (`repo/LICENSE`) and public at `github.com/juggernautjake/lantern`. Course content is kept out of that repo by `scripts/export.mjs` and `scripts/privacy-scan.mjs`.

### Analytics
- **No telemetry or third-party analytics.**
- The owner's dashboard reads `presence` and `progress_summary` (`server/public/shell/shell.js`, `lantern_owner_people`). It shows:
  - who is online and their app version;
  - the current course and lesson;
  - % complete, items finished and time spent;
  - groups, grants and pending email invites.
- **Inside a course** (local to the learner): weak topics, an answer log of up to 12,000 answers with CSV export, a mock-exam gap ranking, and a streak count (`app/course/weakspots.js`, `app/course/insights.js`, `server/src/platform/routes.js`).

### Accessibility
- **Shell:**
  - about 80 `aria-*` attributes, `aria-live` toasts, and native `<dialog>`;
  - a 3 px `:focus-visible` outline and `prefers-reduced-motion` (`server/public/shell/`).
- **Kit:**
  - 190 `aria-*`, 27 roles and 16 live regions;
  - keyboard shortcuts in the exam and video;
  - a reading-size slider from 80% to 180%;
  - six palettes, including High contrast (`app/course/shell.js`, `app/theme/palettes.css`).
- **Contrast:** measured in `docs/15-palettes.md` and `vendor/ecosystem-core/docs/contrast.md`. `scripts/qa-shell.mjs` checks small text at 4.5:1 at four window sizes.
- **Video:** captions, a transcript and chapters (`app/course/video.js`).
- **Missing:**
  - no skip link, `sr-only` utility or `forced-colors` support;
  - no screen-reader audit;
  - no WCAG conformance statement or VPAT.

### Phone support
- **Owner-only remote access through Tailscale** (`docs/dev/phone.md`, `server/src/platform/phone.js`). Settings → Phone runs `tailscale serve`. The guard admits only:
  - `*.ts.net` hosts;
  - the allow-listed Tailscale login;
  - a matching Origin.
- The PC must be on. There is no native app and nothing public.
- **Layout:** full phone layout in `app/fs/styles-mobile.css` and the shell (tab bar, sheets, Add to Home Screen; CHANGELOG 0.1.8).
- **iOS media:** byte-range serving and MP4 copies of the audio.
- **QA:** `scripts/qa-phone-shell.mjs`, `qa-phone-course.mjs` and `qa-phone-videos.mjs`.

---

## 2. Courses that exist

| Course | Version | Size | State |
|---|---|---|---|
| **FS Exam Prep** (`fs`): NCEES Fundamentals of Surveying | 1.2.9 released (`courses/fs/course.json`) | See below. Pack is 361.6 MB (`dist/packs/fs-1.2.9.lpack`). Media is 805 MB in `app/fs/assets/`. Voice cache is in `../lantern-media/voice`. | Shipped and in daily use. A large revamp to Handbook 2.5 is in progress and unreleased. |
| **ColdFusion (CFML) 501** (`cfml`) | 1.0.0 (2026-09-25) | 9 units, 54 lessons, 56 exercises, 11 projects with milestones, 9 checks (`courses/cfml/structure.mjs`). 239 bank questions (`docs/19-platform-build-plan.md`). Pack is 3.3 MB. | Shipped and unchanged since. Built from `app/cfml/` with its own interpreter, grader and reviewer (26 rules). It does **not** use the course kit. `content/cfml-501/` is empty. |
| **Template** (`_template`) | 1.0.0 | 2 units, 3 lessons | An example to copy |

**FS data** (`app/fs/data/`, measured on 22 Oct):

| Item | Count |
|---|---|
| Modules | 13 |
| Lessons | 189, each with a reading and a video |
| Questions | 8,279 (study bank 7,926, mock bank 255, other 98) |
| Generators | 1,087 (393 draw a figure) |
| Flashcards | 1,173 |
| Glossary entries | 1,012 |
| Equations | 299 |
| Library documents | 38 |
| Reference-sheet sections | 25 |
| Calculator models | 10 |
| Video scripts | 748 (about 2,956 min) |
| Videos voiced | 363 (the other 385 are captions-only) |
| Figures | 673 (363 with interactive demos) |

- **Stale counts:** the released manifest and `app/fs/README.md` still describe 11 modules, 96 lessons and 1,365 questions (and older figures again).
- **Remaining FS work** (`docs/dev/fs-script-plan.md`, `docs/dev/fs-media-plan.md`, `docs/dev/fs-reorder-plan.md`, `docs/dev/fs-revoice.txt`):
  - 352 scripts need edits.
  - 150 new videos are needed.
  - 117 content inconsistencies must be fixed first.
  - A module reorder is designed but not applied.
  - The narration plan totals 2,273,680 characters against a 1,658,000-credit ElevenLabs budget, which is **137%**.
- **Uncommitted work:** the working tree has uncommitted figure edits (`app/fs/figures/m1, m5, m6, m10`).

**Catalogue (plan only):**
- 1,089 courses in `catalogue/` and 18 departments (`catalogue/stats.md`). The README's earlier "20" is out of date.
- 59 courses frameworked to unit level (`frameworks/COVERAGE.md`).
- Only FS and CFML have content.

---

## 3. The course kit's teaching features

The kit is `app/course/`; its contract is in `app/course/README.md`. A test scans it for surveying words (`app/course/test/test-kit.mjs`, 46 checks).

| Feature | Where | Generic or FS-only |
|---|---|---|
| Readings split into one-idea cards, clickable glossary | `markdown.js`, `shell.js`, `glossary.js` | Generic |
| **Narrated videos**: a timeline of recorded audio driving a live SVG stage, not video files. Watch and Step-by-step modes, captions, transcript, chapters, counted as watched at 90%, 1–3 ungraded end questions | `video.js`. Scripts in `app/fs/videos/`, voiced by `scripts/videos.mjs` (ElevenLabs `eleven_multilingual_v2`, cached per line, Opus webm plus MP4) | Player generic; scripts and figures FS |
| Figures and animations, slider demos | `video.js` registry; `app/fs/figures/m1–m13.js`, `app/fs/diagrams.js` (15 generator figure kinds) | Mechanism generic, drawings FS |
| **8 question formats**: multiple choice, true/false, numeric (units, DMS, feet-inches, fractions), multi-select, ordering, drag-label, hotspot, multi-step | `grader.js`, `quiz.js` | Generic |
| **Generators**: data-defined parameters, an answer formula and worked steps. Courses can register parameter types; FS adds `bearing`. A logged problem can be rebuilt exactly. | `engine.js` (comments still say "FS"); `app/fs/content.js` | Generic |
| **Mock exam**: 110 questions, 320 min, pause, sleep-proof timer, 15 s autosave, question map, mark-for-review, "I don't know", 70% pass, gap ranking | Screen in `shell.js`; paper in `app/fs/content.js` `buildExam`/`examBlueprint` (NCEES knowledge-area weights); `pages.js` | Screen generic, blueprint FS |
| Flashcards: 5-box Leitner (0/1/3/7/21/60 days), not FSRS | `study.js` | Generic |
| Weak spots, open-mistake list, answer history with CSV | `weakspots.js`, `insights.js` | Generic |
| Study sessions: weak, drill, mixed (spaced and interleaved), topic, course-defined sets | `sessions.js` | Generic |
| Equation practice: 10 drill kinds | `equations.js`, `eqmath.js` | Generic |
| **Calculator trainer**: an emulated TI-30Xa, 40 keys, 7 routines, 5 drills. Keystrokes for every worked calculation on 7 models | `app/fs/calculator.js`, `calc-*.js`, `keystrokes.js`, `keys-ui.js` | FS-only |
| Library: pdf.js viewer; the learner's own copy of the NCEES handbook is stored on their device in IndexedDB, and the handbook is never shipped | `library.js`; `docs/dev/fs-handbook.md` | Generic |
| Reference/formula sheet | `app/fs/refsheet.js` | FS-only |
| Notes: Markdown editor, saves from highlights and solutions, synced, readable by the assistant | `notes.js` | Generic |
| Palettes (6), reading size | `app/theme/palettes.css`, `shell.js` | Generic |
| **All styling and phone CSS** | `app/fs/*.css` only; **the kit has no CSS** | FS-only, so a second kit course would have to copy it |

- **CFML uses its own stack instead** (`app/cfml/`):
  - a browser CFML interpreter;
  - four-tier assertions;
  - a craft reviewer;
  - inspector panes.
- **Kit gaps:** there is no lesson authoring UI; content is hand-written JSON and JS. There are no essay or rubric question types in the kit; rubric AI grading exists only in demo mode.

---

## 4. Operational state

### Tests and QA
- **`npm test`** runs:
  - `server/test/test-foundation.mjs` (about 95 checks);
  - `test-platform.mjs` and `test-platform2.mjs` (demo platform);
  - `app/course/test/test-kit.mjs` (46);
  - FS: `test-fs` 513 (217,400 generated problems checked), `test-keys` 146, `test-checks` 72, `test-insights` 86, `test-weakspots` 90, `test-equations` 55.
- **Not in `npm test`:**
  - `test-ecosystem`, `test-friends`, `test-assistant`, `test-review`, `test-notes`;
  - `app/fs/test/test-speech.mjs` (82);
  - the e2e suites (`e2e-offer-flow` is the acceptance test, `e2e-assistant`, `e2e-signin-link`, `e2e-fs-*`);
  - `real-hub-smoke.mjs` (live hub) (`docs/dev/testing.md`).
- **Release QA:**
  - `scripts/qa-shell.mjs` (walk, soak, robustness);
  - `qa-fresh-install.mjs`;
  - the phone QA scripts;
  - `qa-exam`, `qa-formats`, `qa-equations`, `qa-practice`, `qa-weakspots`, `qa-library`, `qa-videos`, `qa-figures`, `qa-video-search`.
- **Course QA:**
  - FS: `fs-sweep`, `fs-handbook-check`, `fs-handbook-coverage`, `rebuild-check`, `check-equations`, `apply-audit`.
  - CFML: `test-cfml` (303), `verify-cfml-content`, `audit-assignments`, `fuzz-cfml`.
- **Known issues:**
  - one flaky check (`test-fs.mjs` "no generator twice on one paper"; likely the top-up `pick()` in `buildExam`);
  - the hub SQL itself is tested only through `server/test/fake-hub.mjs` and a manual smoke test.

### Release process and versions
- **Steps** (`docs/dev/releasing.md`):
  1. Bump `package.json` and `repo/CHANGELOG.md`.
  2. Run the tests.
  3. Run `node scripts/release.mjs`. It exports through an allow-list to `../lantern-app`, runs the privacy scan, and builds `dist-out/Lantern.zip`, optionally baking in a default hub's public key.
  4. Run `gh release create` on `juggernautjake/lantern`.
- **Versions:**
  - The platform is at **0.1.9**. The changelog covers 0.1.0–0.1.9 without dates.
  - FS has had 22 versions, 1.0.0 to 1.2.9.
  - CFML is at 1.0.0.
- **Updater** (`server/src/platform/updater.js`):
  - Modes: ask, next launch, or idle.
  - Steps: self-test, back up, swap, self-test again, roll back on failure.
  - **It does not verify a checksum or signature on the downloaded zip.** The vendored core updater can; Lantern's doesn't use it.
- **Installer** (`scripts/install.ps1`):
  - Windows only; needs Node, and can install it with winget.
  - Adds Start menu and desktop shortcuts and the `lantern://` protocol in HKCU.
  - Program runs from where it was unzipped. There is no signed installer.
- **Course releases:** `publish-course.mjs` to the hub (see §1).

### Hosting: what runs where

| Piece | Where |
|---|---|
| App and server | Each learner's Windows PC, on 127.0.0.1:4321 |
| Hub | One owner-run Supabase **free-tier** project. It pauses after a week idle and has no backups on the free plan (`docs/public/setup-supabase.md`) |
| Downloads and updates | GitHub Releases (`Lantern.zip`) |
| Phone | Tailscale to the owner's PC |
| Voice | ElevenLabs at build time (course videos) and runtime (assistant) |
| AI | The learner's or owner's own API key (Anthropic, OpenAI, xAI or Ollama) |

There is no web hosting, CDN, monitoring or status page.

### Known gaps and TODOs in the docs
- **FS:**
  - the narration budget shortfall, the 117 content fixes and the reorder (§2);
  - a stale manifest and README;
  - 13 generators without a `question_type`;
  - the library at 38 of 46 claimed documents.
- **Platform** (`docs/dev/assistant.md` "Not yet", `docs/19-platform-build-plan.md` §8):
  - no Spotify; the document reader is unwired;
  - rate limiting and CSRF are needed before any public deployment;
  - the retention sweep has no scheduler;
  - the teacher view shows one class only (demo).
- **Code:**
  - `sync_queue` table unused;
  - `platform/defaults.js` comment out of date.
- **Plans not built:**
  - households, children and parents (`docs/04-accounts-and-roles.md`);
  - an authoring UI, objectives and triggers, messaging, FSRS, transcripts, VMs and labs (`docs/06-build-roadmap.md`, `docs/02-data-model.sql`, `docs/07…`, `docs/05…`).

---

## 5. Against a commercial or institutional product

"Demo" means it exists only in the unshipped demo-school mode on a local SQLite server, not in the hub or the installed app.

| Need | State | Evidence |
|---|---|---|
| Multi-tenant organisations (universities, firms) | **Missing** | One owner per hub; a separate Supabase project per owner (`0001_lantern_hub.sql`). Households are planned only (`docs/02-data-model.sql`) |
| Roles: student, instructor, admin | **Partial** | Hub has owner and student only. Demo has admin, teacher, TA, guardian and observer (`server/src/db/schema.sql`) |
| Course authoring by instructors | **Missing** | Courses are code and JSON built with Node scripts by the author (`docs/dev/authoring-courses.md`). A builder UI is planned only (`docs/06-build-roadmap.md` phase 3) |
| Assignments, due dates | **Partial (demo)** | `assignments.due_at` and `submissions` in demo schema. Nothing on the hub |
| Gradebook, grade export | **Partial (demo)** | Demo `grades` (`confirmed_by`), `GET /api/me/grades` and a teacher craft view (`docs/19` §2, §9). No export, nothing on the hub |
| Cohorts and classes | **Partial** | Hub `groups` (named sets of people with courses, `0001`). Demo `classes` and `enrolments` |
| LMS integration (LTI 1.3, grade passback, roster sync) | **Missing** | No code or docs |
| SSO (SAML, OIDC, Google, Microsoft) | **Missing** | Email, password and magic link only (`sync/supabase.js`). Supabase could add OAuth providers, but nothing is wired |
| Subscriptions, payments, invoicing | **Missing** | No code; access is free grants and offers only |
| Certificates, transcripts | **Missing** | Planned (`docs/04`, `docs/06` phase 4c/6) |
| Proctoring | **Missing** | The mock exam is self-timed, with no identity or lockdown (`app/course/shell.js`) |
| Accessibility (WCAG 2.1 AA, VPAT) | **Partial** | ARIA, contrast-measured palettes, captions, keyboard, reading size, and automated contrast QA. No audit, no screen-reader testing, no VPAT, no skip links |
| Privacy (FERPA, COPPA, GDPR) | **Partial** | Data is local-first, with no telemetry. The FAQ says what goes to the hub (`docs/public/faq.md`). There is no privacy policy, terms, data processing agreement, consent records, age gating or export/delete on the hub. Demo has export-my-data and retention |
| Data retention | **Partial (demo)** | `server/src/files/retention.js` (demo, no scheduler). Hub has none; account deletion only by cascade from Supabase Auth |
| Audit logs | **Partial (demo)** | Demo has `file_audit` and `agent_runs`. The hub has none |
| Uptime and hosting | **Missing** | A free-tier Supabase that pauses, with no backups, SLA, monitoring or status page. The app is Windows-only and runs from a zip |
| Content licensing and provenance | **Partial** | `sources/registry.json` (licence per source). `app/fs/assets/IMAGE_CREDITS.md` has no 🔴 images. The NCEES handbook is never shipped (`docs/dev/fs-handbook.md`). **Open question:** the FS content and its original diagrams came from another of the owner's projects (`app/fs/README.md`), so the rights to sell it need to be settled in writing |
| Analytics for instructors | **Partial** | Owner → People shows %, time, current lesson and online status. No per-question or item analysis, no cohort reports, no export. Demo has a teacher's common-problems view |
| AI tutor governance | **Partial** | Structural answer-key guardrail, tested. Prompt-injection fencing. The no-key fallback works. App mode has **no** spend cap, rate limit, conversation log or admin controls, and it uses the learner's own key. Demo has budgets and `agent_runs`. There is no model policy, disclosure text or human review of AI grades on the hub |
| Signed and verified updates, installers | **Missing** | Updater doesn't verify the zip. No code signing. Windows only. Needs Node |

---

## Summary

### Strengths
- A deep, heavily tested FS course: 8,279 questions, 1,087 generators, a mock exam built to the NCEES weighting, and narrated step-by-step videos.
- An offline-first sync with sound merge rules.
- A structural AI answer-key guardrail.
- A clean course-pack contract that loads any course.
- Thorough QA tooling.

### Biggest gaps for selling FS to individuals soon
- payments and licensing;
- a hosted, reliable hub (paid tier, backups);
- signed installers and a verified updater;
- a Mac, web or phone path that doesn't need the PC on;
- settled content rights (the Starr origin);
- an AI cost model (who pays for the key);
- a privacy policy and terms;
- finishing the revamp: narration budget, content fixes, an updated manifest.

### Biggest gaps for an institutional platform later
- multi-tenant organisations;
- instructor roles and authoring;
- assignments, a gradebook and grade export on the hub (only demo today);
- LTI 1.3 and SSO;
- certificates and transcripts;
- instructor analytics;
- audit logs and retention;
- a WCAG audit and VPAT;
- FERPA, COPPA and GDPR compliance;
- uptime, an SLA and monitoring;
- AI governance controls.
