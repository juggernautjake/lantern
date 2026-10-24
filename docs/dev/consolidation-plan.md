# Consolidation plan: features, code, dead code, performance, scripts

Written 22 Oct 2026. Analysis only: no code was changed. Line numbers are from the working tree on that date. `app/course/study.js` and the FS data were being edited at the same time, so their line numbers may have moved.

## Status (2026-10-23, unreleased)

Applied with the study-flow and UI-audit work, keeping every option the plan flags:
- **a1** done as the plan's table says: Practice's filters, *Solve-only*, *Topics I choose*, *Where to focus* and the weak-spot paper all stay reachable (see `study-flow-plan.md`, Status). **a2** done by moving the study and look-up pages to the top of the rail (no new Equations entry: the equation drill is on Study). **a3** done (names, palette count). **a4** done (one module table, on Progress). **a7** done. **a9** done (standing pages step between themselves).
- **f1, f2, f4, f5, f7** fixed, and **f3** (the backup now uses Lantern's format and carries the notes) and **f10** (the unsure mark is kept). **c12** and the dead `.hosted` rules (a5) removed.
- **Not touched:** a5's owner decision, a6, a8, b1–b8, c1–c11, d1–d7, e1–e8, f6, f8, f9, f11. **d1** edits `buildExam`, which the mock exam rule says to leave alone; the rest is code, performance or script work that changes no screen.

## The owner's rules this plan follows

- **Consolidate and smooth; never remove a capability.** The owner likes the course's current depth. Every merge below keeps every capability, and section (a) says where each one lives afterwards.
- **These must stay easy to find:**
  - lessons, videos and practice;
  - flashcards and the glossary;
  - custom study sessions, quizzes and mock exams;
  - topic and video search;
  - calculators, the handbook viewer, equations, and codes and standards.
- **No added complication.** Panels, hubs and navigation must make complete sense and look good.

## How the findings were checked

- Six audits ran over the kit, FS code, scripts, server, performance and the UI. Each candidate needed proof before it was kept:
  - grep of every call site, including:
    - string-built names and HTML `onclick`;
    - the hook contract;
    - `build-fs-studio.mjs`, `build-pack.mjs` and `courses/fs/structure.mjs`;
    - the server, every test and every `qa-*` script;
  - a diff of every "duplicate" pair;
  - a measurement for every performance claim;
  - for UI claims, a click-through of the built `dist/fs-studio.html` at 1400 px and 390 px, plus a mock Lantern wrapper.
- I then re-checked the main claims by hand. Two were weaker than first reported, and their confidence is lowered below (a5, a10).
- **86 candidates were rejected** as false flags; they are listed at the end with the reason for each.
- **Confidence:**
  - **High:** proved by code and, where possible, a run.
  - **Medium:** proved in code; the size of the effect or the intent is uncertain.
  - **Low:** none are kept.
- **Size:**
  - **S:** under half a day.
  - **M:** one to two days.
  - **L:** more than that.

### Relation to the other plans
- `study-flow-plan.md` (one study flow) and `mock-exam-plan.md` were written the same day. Where they already cover a finding, this plan points to them instead of repeating them.
- **Conflict to settle first:** `study-flow-plan.md` drops four capabilities. Under the owner's rule each becomes an option on the merged mode instead (a1):
  - the Practice page's difficulty filter;
  - Practice's bank-only and generated-only sources;
  - the Solve-only drill;
  - the Weak spots "Topics I choose" picker, and the Study page's "Where to focus" list.
- The module reorder (`fs-reorder-plan.md`) comes first. Several script items (e5) should land **before** it, because they cut the number of copies the reorder has to edit.

### What must not break
- **Saved progress:** the key `lantern-fs-prep` and its shape. Nothing below changes a saved key or field.
- **The two FS module lists:** `scripts/build-fs-studio.mjs:76-116` and `app/fs/test/harness.mjs:17-57`. Any new file goes in both (see b6).
- **The pack:** `build-pack.mjs` copies the built page as is, and `courses/fs/structure.mjs` reads `content.sectionLabel` and lesson minutes.
- **The installed app:** it ships the `scripts/export.mjs` allow-list. No proposed shared library is imported by an exported file.
- **Tests that click specific elements.** Each finding lists them.

---

## At a glance: the top items by value against risk

| # | Item | Group | Size | Risk |
|---|---|---|---|---|
| 1 | Mock papers can contain the same generator twice (the "flaky" test is a real defect) | f / d | S | Low |
| 2 | Eleven study tools sit about 12 screens down the rail, and Equations has no rail entry | a | M | Low |
| 3 | Broken controls: formula-sheet heading links, Notes not closing on Escape, the backup import | f | S | Low |
| 4 | One ranking of "weak", one way to practise a topic (merge the ten entry points) | a | M | Medium |
| 5 | Saving rewrites 2.7 M characters up to 3 times per answer | d | M | Medium |
| 6 | Load the studio data as a JSON block: first page 15% faster, 41% on a slow CPU | d | S | Low |
| 7 | Demo server routes and the CFML engine load in the installed app (650 ms at start) | c / d | S | Low |
| 8 | `check-equations` fails today, but `npm test` stays green | e / f | S | Low |
| 9 | One figure kit for m1–m13 (13 identical copies), fixing a live `[[fig:set]]` bug | b | M | Low |
| 10 | One `fs` tool, and shared data and patch libraries, before the module reorder | e | M | Low |

---

## (a) Features to combine (user-facing)

### a1. Ten ways to practise a weak topic, three formulas for "weak": make them one mode with options
- **Evidence:**
  - "Weak" is worked out three ways: `sessions.js:63`, `insights.js:263` and `weakspots.js:139`. On one simulated learner they give 790, 526 and 561 weak topics, shown on four pages.
  - The smoothed-accuracy score is written out four times.
  - "Practise this weak topic" runs four different ways: the Practice page, a quiz inside Weak spots, and a study session of 10 or of 15 questions. The review panel after a run alone sends "practise" to three pages.
  - There are two run loops (`sessions.js:327` copies `quiz.runner`) and two topic-set builders (`insights.questionsFor` and `weakspots.topicSet`).
  - All ten entry points are traced in `study-flow-plan.md` §1.1.
- **Change:** this is the study-flow plan's "one ranking, one builder, one runner" (§2.6), with every dropped capability kept as an option:

  | Capability today | Where it lives afterwards |
  |---|---|
  | Practice: module, difficulty, mixed / bank-only / generated-only / weak, count | Study → *A whole module*, with an *Options* line (difficulty, source, count) that defaults to mixed. `#practice` stays as a route and its rail entry stays, pointing there. |
  | Practise these topics (review panel, Progress, exam gaps) | One call, `sessions.start({kind:'topic', topics})`. Every button stays; they all open the same mode. |
  | Strengthen my weak spots / My 5 weakest / Every weak topic / My weak areas | One "Weak topics" mode with options: how many (5 or all), module, and "by question" (the old *My weak areas*, with a6 fixed). |
  | Questions I got wrong / Retry N / Fix my mistakes | One "Mistakes" mode, started from the Weak spots mistakes tab and from Up next. *Try it again now* stays on each mistake. |
  | Topics I choose (multi-pick) | Topic mode with the Weak spots checkbox list reused as its picker, reachable from Study and from Weak spots. |
  | Quiz vs timed paper | Both kept. The weak-spot paper stays reachable from Weak spots as well as from the Mock exam length list. |
  | Solve-only drill | An equation-drill preset, "Solve it only", with a "rank by topic weakness" option. See a7. |
  | Set up a drill / Quick drill / Best session | All kept on Study. |
  | Where to focus (Study) | A folded "Why these topics" list under Up next, using the shared ranking. |
  | Flashcards | Unchanged, a separate job (see the rejected list). |

- **Risk:** medium.
  - Learners see different weak-topic counts afterwards; the record itself is untouched.
  - The assistant's prompt names today's session titles (`server/src/assistant/prompts.js`), so it needs updating with any rename.
  - Tests and QA that click these buttons:
    - `server/test/e2e-fs-review.mjs` (`topic-practice`, `progress-practise-weak`), which the study-flow plan's test table misses;
    - `scripts/qa-weakspots.mjs` (`ws-practise`, `progress-open-weak`, `lr-open-weak`);
    - `scripts/qa-equations.mjs` (`session-best`);
    - `scripts/qa-phone-course.mjs` (`session-mixed`);
    - `test-weakspots.mjs` and `test-insights.mjs`.
- **Size:** M (phase 1 of the study-flow plan). **Confidence:** high.

### a2. The study tools are hard to find, and Equations has no entry
- **Evidence:**
  - `railRows` (`shell.js:174-194`) lists Start, search, then about 240 lesson rows, then the "Anytime" group. The group holds Study sessions, Practice, Weak spots, Videos, Flashcards, Mock exam, Calculator, Formula sheet, Glossary, Library, Progress and Appearance.
  - Measured in the browser, that group starts 10,702 px down the desktop rail and 12,549 px down the phone drawer.
  - Equations has no rail item. It is reachable only from card 10 of 12 on Study sessions, from a Weak spots tab that appears once answers exist, and from formula cards.
  - "Codes and standards" is reachable only as "Library", at the bottom.
- **Change (adds nothing new to learn, removes nothing):**
  1. Move the "Anytime" group to just under Start and the search box.
  2. Optionally split it under two short headings:
     - "Practise and review": Study, Practice, Weak spots, Flashcards, Equations, Mock exam;
     - "Look things up": Videos, Formula sheet, Glossary, Library, Calculator, Progress, Appearance.
  3. Add an **Equations** rail item that opens the existing drill setup and the equation record.
  4. Optionally fold each module to one row (the current module stays open).
- **Afterwards:**
  - every capability on the owner's list is within the first screen of the rail on both widths;
  - topic and video search stays the second row;
  - the handbook keeps its floating button and H key.
- **Risk:** low. QA selects rail items by test id or calls `Course.go`, so reordering is safe. Folding changes the `railShape` cache (`shell.js:200`); check that `openRail` (`shell.js:255`) still scrolls `aria-current` into view. Prev/next (`NAV`) order is unaffected.
- **Size:** M. **Confidence:** high.

### a3. One name per thing
- **Evidence:**
  - Weak-spot practice has about 8 labels: "Weak spots", "My weak areas", "Needs work", "Strengthen my weak spots" and others.
  - "Reference" names three things:
    - the ∑ floating button, the formula and constant sheet (`refsheet.js:199`);
    - the "Library", originally "Reference library" (`shell.js:82`);
    - the NCEES FS *Reference* Handbook (`library.js:474`).
  - The Appearance page says "Four palettes" but shows seven. It also mentions a header slider that is hidden on phones.
- **Change:**
  - "Weak spots" for the page, and "Practise *topic*" for every practise button (they share one route after a1).
  - Rename the ∑ button "Formula sheet". It is the same sheet the Formula sheet page ends with.
  - Rename "Library" to "Codes & standards library".
  - Compute the palette count from `PALETTES.length`, and make the slider sentence conditional.
- **Risk:** low. QA that matches label text needs updating; most uses test ids. **Size:** S. **Confidence:** high.

### a4. Two per-module progress tables, and progress shown in five or more places
- **Evidence:**
  - Study's "Where you stand" and Progress's "By module" are separate tables built by separate code.
  - The course's overall % is computed in several places (`study-flow-plan.md` §1.2).
- **Change:** one table component, rendered in full on Progress and as a fold on Study. Every place keeps its number; they all read one function.
- **Risk:** low. **Tests:** `server/test/e2e-fs-progress.mjs`, `scripts/qa/walk.mjs`. **Size:** S. **Confidence:** high.

### a5. Inside Lantern, the course shows a second header with a different %
- **Evidence:**
  - Hosted in the app, the FS course keeps its own top bar. Its blended % sits next to the app's "x of y steps". On phone that bar holds only "0% A A".
  - The kit adds the class `lantern-hosted` (`shell.js:2427`). `app/fs/styles.css:74-75` hides `.hosted .top`, a rule copied from CFML that never matches, so it is dead.
  - `styles-mobile.css:19, 154-155` styles a compact hosted header on purpose, so keeping the bar was at least partly a choice: it holds the text-size control.
- **Change:**
  - Delete the dead `.hosted` rules.
  - Owner decision: either hide the course % when hosted, keeping the text-size control (one measure, as the app's QA expects), or keep both but label them ("Course mastery" and "Steps done").
- **Risk:** low. **Tests:** `server/test/e2e-fs-progress.mjs` (`player-percent`). **Size:** S. **Confidence:** medium. Lowered on re-check: the agent first reported the header as wholly unintended.

### a6. Settings in two places
- **Evidence:**
  - The app's Settings and the course each have their own Appearance, High contrast and Text size.
  - The app's High contrast and Text size don't reach the lesson text in the iframe.
- **Change:** label which control affects what, and have the course take its text size from the app's setting when hosted (the course control stays for the standalone page).
- **Risk:** low. **Size:** S–M. **Confidence:** high on the gap; the fix is a design choice.

### a7. The Solve-only drill repeats the drill's *Solve it* kind, and isn't "fast"
- **Evidence:** the card promises "Fast" but shows a reading refresher before each topic (`sessions.js:366-371`).
- **Change:** make it the equation-drill preset "Solve it only" with no refreshers. It stays a card on Study.
- **Size:** S. **Confidence:** high.

### a8. Three "every answer" review lists
- **Evidence:**
  - The lists are `quiz.review`, `weakspots.answerList` and the exam report (`shell.js:1925`).
  - They have different filters and pills, and the exam one builds every solution up front (d3).
- **Change:** one lazy `quiz.review` component with options; each screen keeps its extras.
- **Risk:** low to medium; the mock-exam plan also changes the exam review. **Size:** M. **Confidence:** medium on how far to merge.

### a9. Prev/next on tool pages jumps between unrelated tools
- **Evidence:** Study sessions offers "← Descriptions… check" (it follows the `NAV` order).
- **Change:** on "Anytime" pages, prev/next steps within the group.
- **Size:** S. **Confidence:** high.

---

## (b) Code to consolidate

### b1. One figure kit for m1–m13 (`app/fs/figures/kit.js`)
- **Evidence:** every figure gets the drawing helpers `F` (`video.js:27-150`), but nothing supplies the module plumbing, so each module carries its own copy (diffed):
  - **Identical everywhere:** `editParts` (with mask, mute and omit) in all 13; `partList` in all 13; `live` in 9.
  - **One harmless gap:** `floored` (text-size floors), 11 copies, 10 identical. m12 lacks the `angleArc` floor, but m12 never calls it.
  - **Drifted:**
    - `sliderDemo`, 7 copies: m9 lacks `keepHidden`, and m1 and m2 are older designs;
    - `ctlDemo`, 4 copies: m12 and m13 lack `keepHidden`;
    - `nf`, 9 copies: only m12 guards NaN, so the other eight print "NaN".
  - **Also repeated:** `num`, `rad`, `sgn`, `sta`, `clamp`, `pick`, `dmsMin`, `mon` and `ring`. m2's `num` is a formatter, not a parser, so rename it first.
  - **The `fig` wrapper has 7 variants.** The differences (per-figure floor, hide, set) are features that fit one factory.
  - `tw` (text width) exists only in m12; `bare` is a parameter, not a copied helper.
- **Change:**
  - Add `Course.figkit` after `course/video.js` in **both** module lists.
  - Each module keeps a local `fig` alias, so the source scans still match (and fix those scans, e9).
  - Leave out on purpose: the per-module `MIN_TEXT` values, which are intentional and commented.
- **Gain:** about 1,250 lines (57 KB). The real gain is that a fix lands once: the NaN guard, `keepHidden`, and the `set` bug in f6.
- **Risk:** low if both lists are updated. If either is missed, the shipped page or the tests break.
- **Tests:** `test-fs.mjs:122-143` renders every figure. Nothing exercises demos or `set` cues in a DOM, so add a Playwright pass (`qa-figures`, after e3).
- **Size:** M. **Confidence:** high.

### b2. The calculator keypad is built twice, and the copies disagree
- **Evidence:**
  - `calculator.js` (the panel) and `calc-scene.js` (the video scene) each build the key tables and faces.
  - The panel ignores `shiftLabel` (`calc-scene.js:45, 66` uses it), so 16 keys show no 2nd-function label in the panel (σxn, P►R, FIX, DMS►DD…).
  - Five more labels differ between the two data sources.
- **Change:** one `keyFace(k)` used by both, and one label source.
- **Risk:** low; the saved calculator state is untouched. **Tests:** `test-keys.mjs` (146 checks, cross-checks all 10 models). **Size:** S. **Confidence:** high.
- **Related, for the content owner:** `keystrokes.js` tells learners to press ON/C, but the emulator has no ON/C key.

### b3. The answer-to-text formatter exists three times with different output
- **Evidence:** `insights.show` keeps empty array entries; `weakspots.show` drops them; `shell.answerWords` labels steps (a)(b) and units.
- **Change:** one `quiz.answerText(q, value, opts)`.
- **Tests:** `test-insights.mjs`, `test-weakspots.mjs`. **Size:** S. **Confidence:** high.

### b4. Small kit copies
- **Shuffle:** Fisher–Yates is copied identically in `content.js:213`, `hooks.js:122` and `equations.js:365`. Everything is `Math.random`; reproducibility comes from saved vars, not seeds, so merging is safe. Keep `content.shuffle`.
- **Escaping:** `library.js` escape duplicates `Course.md.esc`, with identical output.
- **The "inside Lantern?" check:** five copies. Make it one `Course.hosted` flag set at boot.
- **Run and record ids:** six hand-written generators. Make it one `Course.uid(prefix)`.
- **"Modules started":** two `startedModules()` with different meanings (`sessions.js:79` counts lessons or practice; `equations.js:236` counts lessons only). Pick one deliberately. Medium confidence that this is drift.
- **Size:** S each. **Tests:** `npm test`. **Confidence:** high, except the last.

### b5. Speech: one pronunciation path on the server, number words once
- **Evidence:**
  - The server voice skips `courseSpeech` when a pack has no `pronounce.json` (`assistant/routes.js:105-107`, `assistant/study.js:89-91`), and only FS has one. It then applies `brain.js`'s own word list (`brain.js:165`).
  - The browser voice always runs `courseSpeech` (`assistant.js:526`) and never applies that list.
  - In CFML, "SQL" is "sequel" on one voice and "S Q L" on the other; UDF, API and JSON differ too.
  - Number words and `year()` are written in both `spoken.js:45-46, 92-97` and `course-speech.js:31-44`. Their output matches across the range used.
  - **Not duplicated, despite the brief's suspicion:** the kit has no text-to-speech of its own, and there is one queue and one voice picker (see the rejected list).
- **Change:** `study.pronounce` always runs `courseSpeech` with one shared word table; `course-speech.js` imports the number words from `spoken.js`.
- **Risk:** the CFML server voice changes, and its cache refills once, which costs ElevenLabs credits. FS narration is unaffected (it already uses `pronounce.json`).
- **Tests:** `server/test/test-spoken.mjs` and `app/fs/test/test-speech.mjs` both pass (73 and 82). Merge their cases (e8).
- **Size:** S. **Confidence:** high.

### b6. One FS page manifest
- **Evidence:** the FS module list (39 files) and data-file list (11 files) live in both `harness.mjs:17-57` and `build-fs-studio.mjs:76-116`. They match today, but nothing enforces it, and b1 adds a file to both.
- **Change:** export one list (e.g. `app/fs/manifest.mjs`) that both import. `courses/fs/structure.mjs` keeps its deliberate 6-module subset and takes only the names from it.
- **Risk:** low. **Tests:** `npm test` and a studio build. **Size:** S. **Confidence:** high.

### b7. Hub error codes mapped for friends only
- **Evidence:**
  - Only `friends-routes.js:28-38` maps hub errors to HTTP codes.
  - Other hub routes fall through to `e.status || 500` (`http/server.js:294`), so a mistyped hub address answers 500 and logs a stack trace.
- **Change:** one mapping in the router.
- **Risk:** low; the shell doesn't branch on these codes. **Size:** S. **Confidence:** high.

### b8. Server copies of core code
- **Evidence:**
  - `platform/defaults.js:34-54` keeps a stale copy of core's voice chains: it lacks the catch-all rule, and `DAYSPRING_VOICE_CHAIN` is unused.
  - `platform/semver.js` copies core's version compare; the algorithms are identical.
- **Change:** import both from `vendor/ecosystem-core`, and fix the out-of-date header comment.
- **Size:** S. **Confidence:** high.

---

## (c) Dead code to delete

Every item had **no reference** anywhere: app, server, scripts, `courses/`, tests, QA, docs, the pack builder, and string-built names.

| # | What | Where | Notes | Confidence |
|---|---|---|---|---|
| c1 | Demo routes, `/workspace`, `/static/` and `/dist/` registered in app mode | `server/src/index.js:80-92` | Nothing in the shell, kit, tests, scripts or Dayspring calls them in app mode. `/dist/` serves the 361 MB working-copy pack through `readFileSync` (`http/server.js:307-317`); the phone guard limits this to the owner. Register them only when `mode !== 'app'`. `server/public/index.html` itself stays: it is the demo client. | High |
| c2 | `engine.generateBatch`, `engine.previewTemplate` | `app/course/engine.js:361, 386, 434-436` | | High |
| c3 | `weakspots.moduleTitle` | `weakspots.js:308` | Not exported, never called | High |
| c4 | Unused `var o = S.overall()` | `shell.js:375` | | High |
| c5 | Figure `plssConvergence` | `figures/m7.js:328-370` (registered `:363`) | Replaced by `m7Conv`; no video, lesson or generator uses it. Also fix the m7 header comment. | High |
| c6 | Figure helpers | m4:287 `exLegs`, m5:87 `az`, m9:88 `azOf`, m10:557 `v7`, m10:918 `money`, m8:1724 local `bisG`; `hooks.js:47 not` | `hooks.js:33 LEVEL` looks like an unfinished rule; ask the owner before deleting it. | High |
| c7 | Diagram types `compass`, `heightRelations` | `diagrams.js:351, 371` | 0 uses in templates or questions. The two `"compass"` strings in questions.json are a figure part and a rule name, not this type. A re-export from Starr could bring them back. | Medium |
| c8 | Dead CSS | `.kd-face/.kd-second/.kd-does/.kd-2nd/.kd-arrow` (`styles.css:441-447`, `styles-mobile.css:373`); `.vp-loading` (`styles-video.css:69`); `.btn.ok/.btn.bad` repeated (`styles-eq.css:162/164`); `.nt-title` overridden in the same block (`styles-mobile.css:127/138`); `.hosted` (a5) | String-built classes (`diff-*`, `tone-*`, `kind-op`) were checked and are in use | High |
| c9 | Twelve server exports never referenced | e.g. `aiAssess`, `safeEqual`, `setMicOwner`, `_reset`, `DAYSPRING_VOICE_CHAIN` (list in the audit notes) | | High |
| c10 | Four routes with no caller | `/api/assistant/play`, `/api/assistant/ai/models`, `GET /api/credentials`, `/api/packs/:id/export` | The export route is tested and described as an owner feature but has no button. Wire it to a button (Settings → course → Export) or delete it, depending on intent. | Medium |
| c11 | `sync_queue` table | `server/src/db/migrations.js:107-117` | Only a test checks that it exists. Drop it in a new migration, never by editing an old one. Small value. | High |
| c12 | Scripts `_fix-paths.cjs`, `_tagquiz.cjs` | `scripts/` | No references. Their fixes are already in place, and if run they only print MISS. | High |

**Kept on purpose, although they look dead:**
- `state.eqRuns`: written, and read only by QA.
- `content.sectionLabel`: used by `structure.mjs:113`.
- `study.weakQuestions`.
- The kit's `renderRefs` and `lr-practise` fallbacks, for courses without a library or sessions.
- `hooks.calcHintFor`: exported for the tests.

---

## (d) Performance work

### d1. Mock papers can repeat a generator (the flaky test)
- **Evidence:**
  - In `content.js:306-323`, a *dynamic* bank question (118 of them, each wrapping one template) can be picked into the same paper as a fresh draw of its own template. That happens because `used` records only bank keys and fresh template keys.
  - 97 of the 118 are in the same knowledge area as their template.
  - 7 of 400 simulated papers failed (1.8%), all from this cause (e.g. `tpl-076` fresh plus `q-0547`). The top-up `pick()` was never the cause.
- **Change:**
  - After the fresh loop, drop any dynamic question whose template is already in `used` (from `fmt` and `rest`), then clamp `nf`.
  - When a dynamic question is picked, add its template to `used`.
  - Filtering *before* the fresh loop still failed 2.1% of the time; the order matters.
- **Result:** 0 failures in 1,500 papers, no short papers, no duplicate keys. Tested in a scratch copy.
- **Coordinate with** `mock-exam-plan.md` §4.2, which also edits `buildExam`.
- **Tests:** `test-fs.mjs:328-337`, which stops being flaky. **Size:** S. **Confidence:** high.

### d2. Saving rewrites the whole progress record, up to three times per answer
- **Evidence (measured with the FS harness at the 12,000-answer log cap):**
  - `JSON.stringify(state)` is 2,683,074 characters and takes 35.9 ms.
  - `save()` (`study.js:59`) → `localStorage.setItem` (`shell.js:2376-2379`) runs synchronously, with no debounce, and quota errors are swallowed.
  - A module check saves 3 times per question: `recordAnswer`, then `onAnswer` → `saveCheck`, then `onDone` → `saveCheck` (`quiz.js:770-777`, `shell.js:734`, `study.js:650`). Every page change saves too (`shell.js:127-128`).
  - Inside Lantern, each write triggers the host's `storage` listener, which PUTs the whole key about 700 ms later (`server/public/shell/shell.js:647-655`).
- **Change:**
  1. Coalesce `save()`: mark dirty, flush within a second, and flush at once on `pagehide`/`visibilitychange` and after `recordExam`.
  2. Stop the double `saveCheck` per question.
  3. *Later, separately (L, risky):* compact the log or move it to its own storage key. That needs a pack `storage.keys` change and a migration, so it isn't proposed now.
- **Risk:** medium.
  - An answer could be lost in a crash before the flush; the `pagehide` flush and the short delay limit this.
  - Tests that read storage right after an answer need `Course.study.flush()`.
  - Coordinate with the progress-tracking audit now running in `study.js`.
- **Tests:** `test-checks.mjs` (resume), `server/test/e2e-fs-progress.mjs`, `qa-exam.mjs` (15 s autosave).
- **Size:** M (steps 1 and 2).
- **Confidence:** high on the costs and call counts. Medium on hitting the storage quota for real learners: the record is about half a typical per-origin quota at the cap, and the app and all courses share one origin.

### d3. Load the studio data as a JSON block, not a JS object
- **Evidence:**
  - `build-fs-studio.mjs:64` writes `Course.data = {…}`, 18.0 MB, which is 83% of the 21.7 MB page. The browser must compile it as JavaScript before anything runs.
  - Putting it in `<script type="application/json">` and reading it with `JSON.parse(el.textContent)` gave a byte-identical `Course.data` (same hash, 241 rail items, no errors).
  - First page, median timings in Chrome:

    | | As shipped | JSON block | Change |
    |---|---|---|---|
    | Normal CPU | 849 ms | 724 ms | −15% |
    | CPU slowed 4× | 5,866 ms | 3,461 ms | −41% |
    | Longest blocking task | ~400 ms | ≤265 ms | |

  - A quoted `JSON.parse('…')` string was *slower* (940 ms), so it is the separate block or nothing.
- **Change:** emit the data block before the code, keep the `safe()` escaping, and optionally remove the element after parsing to free the string.
- **Risk:** low.
  - Nothing reads `Course.data =` out of the built HTML; the harness reads the source JSON.
  - `build-pack.mjs:71-73` copies the page unchanged, so it behaves the same in `/packs/<id>/` and on file://.
- **Tests:** none cover the built page's start; run `qa-shell`, `qa-practice` and `qa-exam`. **Size:** S. **Confidence:** high.

### d4. App start does work it doesn't need (about 1.5 s)
- **Evidence:**
  - **CFML engine:** `index.js:70` loads it in app mode (650 ms). The installed app doesn't ship `app/cfml`, so it prints "runner did not load" on every start.
  - **Bundled packs:** `packs.js:316-333` reads the whole 361 MB `fs.lpack` and checks its hashes (about 870 ms) only to compare versions, then skips it; a new pack is parsed twice. This hits the owner's working copy and `test-assistant`/`test-notes`, not learners, whose `dist/packs` is empty.
  - **Manifest:** every `packs.get()`/`list()` re-parses the 278 KB FS manifest (`packs.js:265-281`), about 0.9 ms each time, on every course file request and sync pass.
- **Change:**
  - load the runner lazily, only for CFML routes in demo mode;
  - read only the pack header to compare versions;
  - cache the manifest by id, version and mtime.
- **Risk:** low. **Tests:** `test-foundation.mjs`, `--selftest`, `test-assistant.mjs`.
- **Size:** S each. **Confidence:** high for the first two; medium on the real-world gain of the cache.
- **Related, a cosmetic fix:** the startup log checks only `ANTHROPIC_API_KEY` (`index.js:245`), so with the shared DPAPI key it wrongly says the assistant is off. Use `brain.js`'s check.

### d5. The Study page generates real problems to write one sentence
- **Evidence:** `recommendText` builds a question set with `questionsFor` and throws it away (13 ms), and the page ranks topics twice.
- **Why now:** the study-flow plan's Up next would run this on every Study and Start render.
- **Change:** a cheap ranking-only path.
- **Size:** S. **Confidence:** high.

### d6. The exam report and answer history build too much up front
- **Exam report:** it builds all 110 worked solutions when it opens (`shell.js:1925`); the other review lists build on open. Build each one when it is expanded (this falls out of a8).
- **Answer history:** it rebuilds each day's list once per row and filters the whole log per day heading (`weakspots.js:906`), so cost grows with the square of a long day. Group once, then render.
- **Size:** S each. **Confidence:** medium for the exam report (the build was read, not timed); high for the history.

### d7. Small wins (do only alongside other work)
- **Strip dead fields in the build step only, never in the source JSON:**
  - `exam_category`;
  - `is_dynamic:false`;
  - question `bank` and `source`;
  - `tolerance` equal to the 0.01 default;
  - `options_generator {"method":"none"}`.

  That is 611 KB raw but only 17 KB gzipped, and parsing goes from 78 to 64 ms. Put a comment by the strip list. Confidence: medium-high.
- **Work out lesson reading minutes at build time:** `content.js` spends about 16 ms splitting 290k words at load. `structure.mjs` reads the same value, so it must stay identical.
- **Build the equation tiles on first use** (18.6 ms today).
- **ETag/304 for shell static files:** today they are sent `no-cache` with no ETag (`http/server.js:222, 308-317`). Also, `qr.js` loads on every page but is used only by Settings → Phone. Medium confidence on the gain.
- **Round SVG coordinates to 2 decimals** in `video.js` `attr()`: 9% of figure SVG (421 KB) is digits past the second decimal.

---

## (e) Scripts to merge

### e1. One CFML loader instead of seven copies; the error catalogue is incomplete today
- **Evidence:**
  - `server/src/course/runner.js:28-31` already loads the CFML course and is used by `courses/cfml/structure.mjs`.
  - Six scripts keep their own `ORDER` list (confirmed by grep): audit-assignments:34, audit-coverage:25, verify-cfml-content:19, check-syntax:22, fuzz-cfml:25 and build-error-catalogue:23. test-cfml and test-editor load subsets.
  - The lists have drifted: build-error-catalogue loads only 17 modules (no script-debug, unit5-keys, unit7–9, proj-extra, proj-web, review or selfcheck).
  - As a result, 7 of 73 lesson links in `docs/18-error-catalogue.md` show raw ids (u2l4, u5l7, u9l2). `--check` still says "in sync", because it compares with the same incomplete build.
- **Change:** use `runner({retry:true})` everywhere, then regenerate docs/18.
- **Risk:** low. **Tests:** `test-cfml.mjs` (303), `qa-studio.cjs`. **Size:** M. **Confidence:** high.

### e2. `check-equations` fails now, and `npm test` doesn't see it
- **Evidence:**
  - Run today, it exits 1 with 6 errors:
    - q-0255, q-0348 and q-m7-w4-c075 point at nothing;
    - tpl-068's hide text isn't in its question;
    - m2-f23 and m2-f24 have no entry.
  - `test-equations` passes 55/55 because `equations.js:97` silently drops unknown problem keys.
  - `--merge` (`:138-162`) rebuilds equations.json from scratch, which would erase every edit `apply-audit` has made.
- **Change:**
  - move the default check into `test-equations.mjs`;
  - remove `--merge`, or make it refuse when equations.json carries audit edits.
  - Expect `npm test` to go red until the 6 data errors are fixed; fix those in the content patches now running.
- **Size:** S. **Confidence:** high.

### e3. One `fs` tool with subcommands
- **Evidence:** ten FS scripts each load the data their own way. They are listed by role, inputs, outputs and writes in the audit notes:
  - rebuild-check, merge-rebuild, apply-audit, fs-sweep;
  - fs-handbook-check, fs-handbook-coverage, fs-notation, fs-ka-tags;
  - check-equations, and `lib/proposals.mjs`.
- **Change:** `node scripts/fs.mjs <cmd>`.
  - **Read-only, dry by default:**
    - `check` runs them all with one summary;
    - `rebuild N`, `sweep`, `handbook`, `coverage`, `equations`, `tags` and `notation`.
  - **Writers:** `apply` and `merge`.
  - **Kept apart on purpose (see the rejected list):**
    - the handbook *check* and *coverage* ask opposite questions;
    - rebuild-check works on drafts before a merge.
  - **Shims:** the old file names stay as one-line shims. `test-keys.mjs:358` imports `scripts/fs-notation.mjs`, and the fs-*.md briefs cite the names.
- **Optional CFML equivalent:** `cfml-check.mjs`, running test-cfml, verify-cfml-content, audit-assignments, audit-coverage, check-syntax, fuzz-cfml, `build-error-catalogue --check` and test-editor.
- **Risk:** low with shims. Nothing here is on the export allow-list, in build-pack or in structure.mjs. **Size:** M. **Confidence:** high.

### e4. A shared patch applier: coverage counts removed items today
- **Evidence:**
  - `fs-handbook-coverage --with` (`:97-119`) re-implements part of `apply-audit`'s patch format (`:62-183`).
  - It has no exact-once safety check and ignores `after` on new formula cards.
  - It also skips: remove, fixTemplates/removeTemplates, cards.fix/remove, glossary fix/aliases, lessonFields, edit/expect, headingRenames and equations.problems.
  - So it can count removed questions and flashcards as coverage.
- **Change:** move `apply-audit`'s logic to `scripts/lib/audit-patch.mjs` and use it in both.
- **Size:** M. **Confidence:** high.

### e5. Shared FS data access: do this before the module reorder
- **Evidence:**
  - Raw read/write of the FS data is copied across 7 scripts, and the JSON format rule across 6 writers.
  - Modules are looked up by array position (`modules[n-1]`, `i+1`) in 8 places.
  - `fs-reorder-plan.md:382-390` budgets a separate edit to each copy.
  - The draft overlay is written 4 times, with different key rules:
    - harness:81-85 and build-fs-studio:56-64 copy every key except `audit`/`headingRenames`;
    - fs-handbook-check:131 copies every key;
    - merge-rebuild:43-44 copies only 5 keys, so a draft can preview and pass checks but lose keys on merge.
  - merge-rebuild's `delete content_sections` does nothing; no module has that field.
- **Change:** `scripts/lib/fs-data.mjs` with read, write (keeping the format), `byN(n)` and `overlayDrafts()`. Prove a byte-identical round trip on the current data first.
- **Risk:** low, after the round-trip proof. **Size:** M. **Confidence:** high.

### e6. A shared FS page harness for the browser QA scripts
- **Evidence:** 11 FS qa scripts copy the same setup, with drift:
  - the browser fallback is missing in 3 and reversed in qa-phone-course;
  - only 4 block web fonts;
  - "Phone" is a Pixel 7 in one and 390×844 in others;
  - the default ports differ (4713, 4714, 4720, 4721), and each needs `serve-dir.mjs` started by hand;
  - `qa-figures` never fails;
  - `qa-studio.cjs` and `qa-editor.cjs` each carry a Playwright loader that ignores `PLAYWRIGHT_CORE`, which `server/test/helpers.mjs:101` honours.
- **Change:** `scripts/qa/fs-page.mjs`, with an in-process server and one device table, reusing `OFFLINE_ROUTES` from `scripts/qa/mocks.mjs`.
- **Fix at the same time:**
  - **`qa-videos`:** it waits for the player without calling `__videoStart` the way `qa-phone-videos` does. Players build only near the screen (`video.js:470-519`), so videos low in a reading will likely fail. Medium confidence: read, not run.
  - **"iPhone SE":** qa-phone-course uses a 320 px model and qa-phone-videos a 375 px one. Confirm which is intended.
- **Size:** M. **Confidence:** high.

### e7. Lists and rules kept in sync by hand
- **`answerFor`:** copied 5 times, all identical (four FS tests and rebuild-check:176). Export it from the harness.
- **The text-to-speech prep:** copied 6 times (videos.mjs, voice-qa, fs-handbook-coverage, test-speech, test-keys, test-spoken), with different handling of a missing pronunciation file and of whitespace.
- **"Exactly one knowledge-area tag":** written 4 ways. The `npm test` check (test-fs:326) only checks "at least one".
- **The figure-name regex:** copied 3 times (qa-figures, the rebuild-check duplicate-name check, fs-handbook-check). It misses 160 of the 673 registered figures (those registered through `exFig`, `walk`, `figH`, `figW` and `figM`). Read the names from the runtime registry instead.
- **Five "every learner text" walkers** cover different fields. test-keys checks explanations with `notation()`, while fs-notation rewrites them with `prose()` and also touches step and unit fields that test-keys skips. Make one walker in `fs-data`. Medium confidence on the right field set.
- **`app/fs/assets/notation.json`:** 7 live entries use a symbol another entry lists under "avoid" (e.g. D_H/D_E/D_G against DH/DE/DG; x̄_w against M̄_w; θ_rad against φ). merge-rebuild's notation merge (`:52-89`) never checks for this. Resolve the entries (content owner) and add the check.
- **Size:** S each. **Confidence:** high, except the walkers.

### e8. Tests and docs
- **Two speech test files:** `server/test/test-spoken.mjs` and `app/fs/test/test-speech.mjs` test the same function with no shared cases. `npm test` runs neither `test-spoken` nor `test-assistant`.
- **Merge the speech cases** into one file, and add `test-spoken` and `test-assistant` to `npm test` (both pass today).
- **Docs drift:**
  - `testing.md` omits `qa-studio.cjs` and every FS check;
  - `releasing.md`'s "course checks" gives FS nothing to run (after e3: `node scripts/fs.mjs check`);
  - `platform-inventory.md` §4 says test-speech isn't in `npm test`, but `test:fs` runs it;
  - `build-browser.mjs` and `extract-docx.cjs` are referenced nowhere. They aren't dead, so document them.
  - `app/course/README.md`'s hook table lacks `formulaSheet` and `decorateWorked`.
- **Size:** S. **Confidence:** high.

---

## (f) Defects found during the audit

These are real faults, not consolidation work. They are small and safe, so do them first.

| # | Defect | Evidence | Fix | Size |
|---|---|---|---|---|
| f1 | The 13 module headings on the Formula sheet do nothing when clicked | `shell.js:1990` calls `go('m'+n+'-formulas')`, a page id that no longer exists. Confirmed in the browser at both widths. | Link to that module's Summary sheet | S |
| f2 | Notes is the only floating panel Escape doesn't close; on phone it covers the Handbook button | Calculator (`calculator.js:585`), Reference (`refsheet.js:203-206`) and Handbook (`library.js:477-478`) close on Escape. The only Escape handler in `notes.js` (`:594`) hides the selection chip. | Add the Escape case to `notes.js:606-612` | S |
| f3 | The app's "Paste a backup…" can't import the FS course's backup | The import needs `{lantern:'backup', keys}` (`server/src/platform/progress.js:275`); FS "Download a backup" saves the raw record through a `data:` URL with a hard-coded `fs-exam-prep-progress.json` (`shell.js:2193-2201`). The import card says "Make a backup", which is CFML's label. Proved in code, not clicked through. | Write the backup format, use a Blob, take the file name from `Course.meta`, and list the notes key in the course's stored keys so notes carry over | S–M |
| f4 | Practice "My weak areas" ignores the module and difficulty you pick | `shell.js:852-853` ranks the top 10 across all modules, then filters. A fresh learner asking for 10 Module 4 questions got 3, 0, 1, 1 and 1. | Filter before ranking (kept as an option in a1) | S |
| f5 | Learners see internal tags as weak areas | The exam report's "Worth going back to" and the Progress fallback (`study.weakTags` → `shell.js:2177`) list `ncees-sub:6A`, `dynamic`, `fs-audit-2026`, `wave4` (`grader.js:513`, `shell.js:1897`). The mock plan fixes only the exam. | One label filter applied at display time, so saved papers are unchanged | S |
| f6 | A `[[fig:set]]` cue drops highlights in m3 and m4 | m3:690 and m4:186 `setter` restore hidden parts but not highlights. In `m4-v14.json`, scene `dz` highlights the circle, and the first of four `set` cues un-highlights it. | Use the kit's `live` set (b1) | S |
| f7 | *Continue* on Start promises weak topics but opens plain Practice | `shell.js:391` falls through to `go('practice')` for `kind:'weak'` | Covered by Up next in the study-flow plan | S |
| f8 | m4's demo builder lags m3's | m4 lacks `userSelect:none` and the aria-label cleanup that m3 has | Covered by b1 | S |
| f9 | Numbers get thousands commas inconsistently | Modules 5–13 add them from 4 digits, Modules 1–4 from 5 digits, and m3 inserts only one comma | Owner to pick one rule; it goes in the figure kit | S |
| f10 | The assistant reads a right-but-unsure answer as a miss | `server/src/assistant/study.js:116` strips the unsure mark from topic history | Keep the mark | S |
| f11 | The course manifest maps `practice` milestones to a field the kit never writes | `courses/fs/course.json` maps `practice` as passed by `complete`; `practice[n]` has no such field | Map it to a field that exists, or drop that mapping (server owner) | S |

---

## Considered and rejected (86)

These looked like problems but are not. They are listed so the same false flags aren't raised again.

### Features and UI
1. **Flashcards vs the equation drill's *Recall*:** only a partial overlap. Flashcards are term → definition cards on Leitner boxes; *Recall* is per equation, self-marked, and feeds equation strength. They already share the record (`study.js:524`). Keep both.
2. **The review panel's `lr-practise` "dead button":** hidden in FS only because `Course.sessions` exists (`insights.js:599`). It is the fallback for courses without sessions.
3. **Hash routes with no screen:** none. Every `go('<literal>')` target exists; only f1 is dead.
4. **`data-action` handlers:** none are used anywhere.
5. **Phone hides the Progress pill and palette swatches** (`styles-mobile.css:147`): Progress and Appearance stay in the drawer (checked in the browser).
6. **`nt-lessons` hidden by default:** shown on purpose only when notes are docked over the rail (≥1000 px).
7. **The kit's `renderRefs` unreachable in FS:** Library replaces it for FS. It is the fallback for other courses, not a user-facing fault.
8. **The rail search box duplicating the Videos page search:** the rail box is the entry point on every page and jumps into the same search. Keep it.
9. **"Make a backup" wording:** correct for CFML; only the FS mismatch matters (f3).
10. **A console 404 seen once:** not reproduced; no ≥400 response in a second walk.
11. **"More videos" link without `Course.meta.subject`:** it still works by topic title. Optional polish only.

### Kit code
12. **`quiz.js` shuffle vs `content.shuffle`:** `quiz.js:84` already delegates.
13. **Seeded vs unseeded shuffles:** none are seeded. Problems are rebuilt from saved vars, not seeds.
14. **`video.js` escape vs markdown escape:** different on purpose. It is for SVG text, omits `"`, and must run without `Course.md`.
15. **`glossary.js` esc:** a RegExp escaper, not HTML; the same goes for `shell.js:1077`.
16. **The two `startedModules()` as one copy:** they differ in meaning; kept as a decision item (b4), not a copy.
17. **`weakspots.when`/`ago` vs `notes.ago` and `shell when`:** different granularity and output.
18. **`study.weakQuestions` dead:** used by Practice (`shell.js:853`) and `test-weakspots.mjs:235`.
19. **`content.sectionLabel` unused:** used by the pack builder (`structure.mjs:113`).
20. **`grader.readAnswer`/`toleranceFor`/`statedStep` dead:** used inside `grader.js`, and asserted in tests.
21. **`insights.overall` slow:** 0.6 ms at the log cap.
22. **`standing()` slow:** 1.0 ms.
23. **Exam `idk`/`blank` counts unread:** the mock plan reads `idk` for old papers.
24. **`hooks.calcHintFor`/`CALC_HINTS` unused:** exported for `test-keys`/`test-fs`.
25. **`brief()` and the inline `md()` helper:** near-copies too small to be worth merging.
26. **Merging the kit's date helpers:** they differ in purpose.

### FS code and figures
27. **The per-module `MIN_TEXT` values (16/18/20/22):** intentional and commented, with deliberate per-figure overrides.
28. **Same-named `draw*` functions across modules:** different figures in separate scopes.
29. **`dms` (7 variants) and `brg` (4):** they format differently on purpose (seconds, decimals, signs, cardinal words).
30. **`R_FT` vs `GRS`:** mean earth radius vs the GRS 80 semi-major axis.
31. **Three hit-target shapes:** three kinds of click target.
32. **"Two TI-30Xa emulators":** only `calc-ti30xa.js` exists.
33. **`keystrokes.js` key labels:** they match the keypad data (except ON/C, noted in b2), and `test-keys` cross-checks all 10 models.
34. **`keystrokes.js` vs `eqmath.js` parsers:** different grammars and outputs.
35. **`refsheet` vs equations:** no code overlap, and 0 of 299 formula texts match.
36. **One shared calculator/reference panel shell:** low payoff, and it would risk the saved calculator state.
37. **Six unused keypads in the calculator data:** generated data, about 24 KB.
38. **Figure render speed:** no DOM text measurement or animation loops. All 673 figures render in 129 ms total in node (worst 3.5 ms).
39. **Minifying or stripping comments:** comments are about 1% of the page.
40. **Duplicate figure names:** none at load.
41. **The two module lists as a separate finding:** folded into b6.
42. **`tw` and `bare` as copied helpers:** `tw` exists once (m12) and `bare` is a parameter.
43. **The `fig` wrapper variants as drift:** the differences are features, folded into b1's factory.
44. **The `m3demo-*`/`m4demo-*` class names:** no CSS or test uses them, so they are harmless and fold into b1.
45. **The six string-built CSS classes flagged as uncertain:** all in use.

### Performance
46. **Generators compiled up front:** they aren't. Compilation is lazy and cached (`engine.js:52-70`).
47. **Engine retry loops:** capped at 13 draws, and all 1,087 templates succeed on the first. A 110-question `buildExam` has a median of 51 ms.
48. **Stripping tolerance from non-numeric questions:** `grader.js:375, 389-393` uses it for multiple-choice and true/false numeric matching.
49. **Lazy-loading figures m1–m13:** saves about 58 ms, within noise, and 2,820 question and template diagrams need them in any mixed set.
50. **Eager indexes:** about 5 ms, and `insights.warm` already runs in idle chunks.
51. **Pretty-printed JSON:** already minified.
52. **Fetching explanations on demand:** `fetch()` fails on file://, and the page promises to work with no network.
53. **The 142 ms layout in `go()` at boot:** it is the first page's layout, which has to happen anyway.
54. **Dropping the `medium`/`multiple_choice` defaults:** `pick()` filters on them (`content.js:236/240`).
55. **`pick()` cost:** 3–12 ms.
56. **`JSON.parse` of a quoted string:** slower than today (see d3).

### Server and shell
57. **`merge.js` vs SQL `lantern_sync`:** a required mirror. The hub merges in Postgres and the app on pull, and the rules match one for one.
58. **`fake-hub.mjs` as a third merge copy:** deliberately independent, or the tests would check the JS against itself.
59. **"Three AI clients":** in app mode only core's client runs. `brain.js` configures it; `chat.js` is the tool loop core leaves to each app; `ai/client.js` is demo-only, with budgets core lacks.
60. **Duplicated body parsing and error responses:** one parser (`http/server.js:260-269`) and one handler; only the hub mapping is duplicated (b7).
61. **Duplicated sqlite helpers:** one `db/db.js`.
62. **`routes.js` vs `platform/routes.js`:** no shared paths.
63. **Core `eco.handle()` for `/api/eco/*`:** different response shapes that the tests and Dayspring rely on.
64. **Core `bus.mjs`:** a different SSE format that the shell and Dayspring parse.
65. **Core updater:** kept on purpose (`ecosystem.md:202`).
66. **`server/public/index.html` dead:** it is the demo client and ships in the public repo; only its app-mode route goes (c1).
67. **`/api/local/*` unused:** Dayspring's API, and Dayspring calls it.
68. **Sync engine loop cost:** it backs off, is guarded, and skips idle packs.
69. **Range requests reading whole files:** the largest media file is 1.3 MB.
70. **`/eco/` serving core source:** no secrets, behind the guard.
71. **Two speech normalisers (shell vs kit):** the kit has no TTS; the narration build imports the shell's modules.
72. **Two voice pickers:** both use core `voices-defaults.mjs`.
73. **Two speech queues:** there is one `createSpeechQueue`; `voiceCache` is a clip cache.
74. **`browserSpeak` vs `voiceChunks` sentence splitting:** intentional (Stop between sentences vs batched fetches).
75. **`playBlob` vs `playBlobPhone`:** iOS needs the unlocked audio element.
76. **Vendored `voice.mjs` `speakable()`:** shared with Dayspring; don't fork it.

### Scripts
77. **fs-handbook-check vs fs-handbook-coverage as one check:** they ask opposite questions (forms the handbook doesn't use vs whether each of 464 items is taught). Two subcommands of one tool.
78. **rebuild-check vs test-fs vs fs-sweep:** drafts before a merge, the merged data, and arithmetic in the text. They share only `answerFor`.
79. **apply-audit vs merge-rebuild:** different inputs; both already use `lib/proposals.mjs`. merge-rebuild is the documented authoring pipeline (`mock-exam-plan.md:545`).
80. **audit-coverage:** the CFML case-study check, unrelated to FS handbook coverage.
81. **qa-shell, qa-fresh-install and qa-phone-shell:** they already share `qa/walk.mjs`, `mocks.mjs` and `helpers.mjs`.
82. **qa-videos vs qa-phone-videos:** different jobs (frames for a person vs device assertions); they share only "open a video".
83. **`courses/fs/structure.mjs`'s own loader:** isolated on purpose (it runs inside build-pack); only its module names should be shared.
84. **test-kit's loader:** a fixture course, not a copy.
85. **build-browser, extract-docx and qa-studio.cjs as dead:** their inputs exist and they are still used (qa-studio is the CFML studio's regression suite). Document them instead.
86. **The remaining script candidates:**
    - check-equations isn't redundant with test-equations; it catches what `equations.js` drops.
    - The fs-notation dry run isn't a duplicate of test-keys; they walk different fields.
    - The module count 13 appears only as intended assertions.
    - There are no hand-synced handbook section ids.
    - refsheet.json's missing final newline is intentional.
    - serve-dir is still needed (videos don't load over file://).
    - The phone thresholds match; only their copying is a finding.

### Re-checked and downgraded (kept, with lower confidence)
- **a5:** the second header in the app is partly deliberate (`styles-mobile.css:154-155`); only the `.hosted` rule is certainly dead.
- **c1:** `/dist/` exposure applies to the owner's working copy only. Learners' `dist/packs` is empty, and the phone guard admits only the owner.

---

## Suggested order

1. **Defects f1–f6** and **d1** (mock papers): small, safe, and visible to learners.
2. **a2 and a3** (findability and naming): the biggest improvement in "makes sense", with no logic change.
3. **c1–c12** (dead code) and **d3, d4** (load time): low risk, measurable.
4. **e2, e5, e1** (equations check, shared FS data, CFML loader), before the module reorder.
5. **The module reorder** (`fs-reorder-plan.md`).
6. **a1, a4, a7–a9** with the study-flow plan (amended to keep every capability), **d2** (saving) after the progress-tracking audit lands, then **b1–b8**.
7. **e3, e4, e6–e8** (the `fs` tool, QA harness, docs) at leisure.

The evidence, helper scripts, timings and screenshots behind every item are in the session scratchpad: a temporary working folder (not kept). It holds `kit-findings.md`, `fs-findings.md`, `scripts-findings.md`, `server-findings.md`, `perf-findings.md` and `ui-findings.md`, which has the full navigation map. It is temporary, so copy anything worth keeping.
