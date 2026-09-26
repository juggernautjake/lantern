# Testing

Nothing here touches your real data, your real hub, GitHub, your microphone or your speakers. Every app a test starts gets its own temporary data folder, its own ecosystem folder and a spare port, and never opens a browser window.

| Command | What it covers | Time |
|---|---|---|
| `node server/test/test-foundation.mjs` | Migrations and backups, course packs, progress, merge rules, the updater against a fake GitHub (including a rollback), the ecosystem schema and guard, the shared AI key (Windows), export and privacy | ~20 s |
| `node server/test/test-ecosystem.mjs` | Real app processes against the fake hub: two computers offline merging, draft and published, groups, requests, revoking, an offer to an email and an emailed sign-in link (with its callback page), the sign-in handoff, the launcher (single copy, `lantern://`, `--open`, stop), eco security, a mock Dayspring, the quiet installer | ~2 min |
| `node server/test/e2e-offer-flow.mjs` | **The acceptance test.** Headless Chrome, two apps and the fake hub: sign up, claim the hub, publish, send, accept, download, overview, study offline, reconnect, sync, and the owner sees the progress | ~1 min |
| `node server/test/test-assistant.mjs` | The companion in one process (needs the built pack and the course source): the guardrail over every exercise (no solution or expected value in the pack's context, any `lesson_context`, any hint, or any payload sent to a fake Claude), the hint ladder, the built-in commands, the speech queue (Stop means stop, waiting for Dayspring), who has the microphone, the resource finder's queries and allow-list and cache, the shared AI key's consent (Windows), the default hub | ~20 s |
| `node server/test/e2e-assistant.mjs` | The companion in headless Chrome with a fake Claude, a fake web search and stand-ins for the browser's voices and the YouTube player: the panel and the lantern, chat with tools, the reply spoken in the Lantern voice, Stop, the hint ladder in a lesson, resources, "Play here" and "play some focus music", the settings pages, no answer ever sent | ~1 min |
| `node server/test/e2e-signin-link.mjs` | Headless Chrome: "Email me a link" (no code tab on a hub without a code email), the emailed link opens `/auth/callback`, which signs the person in and clears the address; a used link and an expired link are refused with a plain message | ~20 s |
| `node server/test/real-hub-smoke.mjs [hub file]` | **Private, against the live hub** (public key only): one throwaway learner signs up, checks what a learner can and can't do (owner functions refused, internal helpers locked, row security, storage), and signs out. Never claims the owner role. Delete the printed account afterwards (Authentication → Users) | ~15 s |
| `node server/src/index.js --selftest` | Loads everything and opens a throwaway database with every migration (the updater runs this before and after installing) | 2 s |

Before a release (the private checkout only; they need the built course pack):

| Command | What it covers | Time |
|---|---|---|
| `node scripts/qa-shell.mjs [--quick] [--soak <s>] [--no-robust]` | A bug hunt the way a new person meets the app (`scripts/qa/walk.mjs`): first run, sign-up, friends, sending and accepting a course, the overview and player (one header, one progress measure), the assistant (how far, what's next, hints, chat scrolling, Stop, one voice at a time), the owner's pages and every Settings page at four window sizes and in dark colours (no sideways scroll, nothing cut off, small text at 4.5:1 or better), double clicks, Escape, fast page changes, offline and back, a restart, no native pop-ups, no console errors or failed requests, nothing slower than a second, and a memory soak. Then `scripts/qa/robust.mjs`: the hub down at start, an expired sign-in, a download cut off half way, a full disk, a second copy, a damaged database | ~5 min |
| `node scripts/qa-fresh-install.mjs [--quick] [--offline] [--keep]` | The release zip, unzipped into a temp folder and installed quietly (no shortcuts or registry), started hidden twice (one copy, no console window), the same walk with the installed copy as the new user, every documentation link, an update to a newer version from a fake GitHub (one copy, no window, everything kept), and Stop | ~10 min (5-minute soak) |

Course checks (the private course repo only): `scripts/test-cfml.mjs`, `verify-cfml-content.mjs`, `audit-assignments.mjs`, `audit-coverage.mjs`, `check-syntax.mjs`, `fuzz-cfml.mjs`, `build-error-catalogue.mjs --check`, `test-editor.mjs`, `qa-editor.cjs`.

## The fake hub

`server/test/fake-hub.mjs` answers the same HTTP as a Supabase project, for the parts Lantern uses:
- Auth: password, emailed sign-in link (`e2e-signin-link.mjs` drives it in a browser), email code and refresh (with rotation)
- every `lantern_*` function, following the same rules as the SQL
- the course-packs bucket

The app's real sync code runs against it unchanged. Test-only helpers:
- `GET /__test/otp?email=` reads the emailed code
- `/__test/claim-code`
- `/__test/down?on=1|0` simulates the hub going away
- `/__test/cut-downloads?n=1` cuts the next course download off half way
- `POST /__test/expire-tokens` makes every sign-in token run out
- `/__test/state`

Run it on its own with `node server/test/fake-hub.mjs 54321`.

## The real hub

The SQL in `supabase/migrations/` hasn't been run in these tests; the fake hub stands in for it. After running the SQL in a new project, check it by hand with [setup-supabase.md](../setup-supabase.md#check-it-works): sign up two people, claim the hub, publish, send, accept, study, and watch the owner's People page.
