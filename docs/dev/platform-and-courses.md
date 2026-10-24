# The platform and its courses

Lantern is a platform. A course is a pack installed on it. FS Exam Prep, ColdFusion and any course written later are the same kind of thing: a folder under `courses/<id>/` that `scripts/build-pack.mjs` turns into a pack, installed to `%LOCALAPPDATA%\Lantern\packs\<id>\<version>\` and served at `/packs/<id>/`. Nothing the platform does may depend on which course is installed, or on a course's files being next to the platform's own.

The test that keeps this true is `server/test/test-multicourse.mjs`: it runs the FS pack in a copy whose `app` folder has only the theme, runs a second course that declares no teaching, runs a third that declares its own subject, and scans the platform's assistant, pack layer and `build-pack` for any course word or path.

## What belongs to which side

| Platform (ships with Lantern) | Course (ships in its pack) |
|---|---|
| The shell, routing, accounts, sync, backups, the pack installer and its hash check | The pages, lessons, exercises, checks, projects |
| The assistant: chat loop, tools, scope gate, cues, voice, notes, hints, web and video search, quiz review | Everything the assistant teaches *with*: figures, equations, generators, glossary, reference, subject, wording (`teach`) |
| `app/course`, the shared course kit (it ships **inside each pack's page**, and is copied into the pack for the server when a course lists it in `teach.files`) | The subject: its data, its figure code, its problem templates, its calculator, its pages |
| The progress model (ids, the manifest's `progress` map) | The ids and the state its pages keep |
| Speech normalising (`spoken.js`), generic maths, units | A course's pronunciations (`assets/videos/pronounce.json`) |
| `resources.js`: the generic allow-list of learning sites | A course's own documentation sites (`resources.json`: `docSites`, `blogSites`, `allow`, `tagDocs`, `tagPattern`) |

## The couplings found, and what was done

Found by searching `server/`, `server/public/`, `app/course`, `scripts/` and the export ALLOW list for the course ids, the subject (surveying and the exam body's name), `app/fs`, `courses/fs`, ColdFusion and CFML.

| Where | The coupling | Now |
|---|---|---|
| `assistant/chat.js` | Teaching and the scope gate switched on by `pack.id === 'fs'` and by the FS files being present | Switched on by the pack's own `teach` block (`teach/pack.js`) |
| `assistant/tools.js` | "only in the FS course"; the teaching tools offered as a group; FS-flavoured tool descriptions | Each tool is offered when the block has what it needs; descriptions are generic and a course overrides them (`teach.tools`) |
| `assistant/teach/course.js` | Read `app/fs` from the platform's `app` folder (`LANTERN_APP_ROOT`); ran `fs/diagrams.js`, the figure modules and the kit from there | Reads and runs the files the pack names, from the installed pack, hash-checked; per pack id and version |
| `assistant/teach/scope.js` | Surveying vocabulary, `app/fs` glossary, a Haiku prompt about the FS exam, FS number patterns | Vocabulary, patterns and the gate's subject lines come from `teach.scope`; else the pack's title and description; else study help in general |
| `assistant/teach/glossary.js`, `examples.js`, `visuals.js` | `app/fs/data/*`, deed and Texas wording, `law_basis` for land law | Take the pack; wording and the jurisdiction pattern from `teach.glossary` and `teach.lawBasis`; `law_basis` only for a pack that declares it |
| `assistant/prompts.js` | The handbook rules, the land-law rule, "FS exam" in the scope rule | Generic rules plus the pack's own notes (`teach.prompts`) |
| `assistant/knowledge.js` | Notes naming the exam body's handbook | `teach.reference` |
| `assistant/review.js` | Subject wording in comments | Generic; a pack may add `teach.review` (kind names and a note) |
| `assistant/resources.js` | ColdFusion documentation and blog sites in the allow-list and defaults; `cf*` tag detection | Removed; `courses/cfml/resources.json` carries them (`docSites`, `blogSites`, `allow`, `tagPattern`) |
| `assistant/brain.js` | CFML and CFC in the voice's pronunciations | Removed; `courses/cfml/pronounce.json` goes into the pack |
| `app/course/shell.js` | "FS mock exam" as the mock exam's title; the exam body named in comments | `Course.meta.examName` (FS sets it), default "Mock exam" |
| `platform/media.js`, `assistant/context.js` | Course named in comments | Comments made generic |
| Tests | FS fixtures | Kept as fixtures; they read the teaching from the built pack, as an installed copy does |

### Still course-shaped, deliberately

These are not part of the assistant's teaching and do not stop a second course from working. They are recorded here so they are not forgotten.

- **The classroom workspace** (`server/src/ai/*`, `server/src/course/runner.js`, `server/src/seed.js`, `server/src/index.js`'s `CFML-501` seed, the school pages in `server/public/index.html`). It is the older school product with a ColdFusion 501 sample class; it loads `app/cfml` only when that folder exists and degrades without it. Moving it to be a course pack like the others is a separate piece of work.
- **`server/public/shell/spoken.js`** has rules for how bearings, stations and calculator keys are said. They are harmless to other courses (they match patterns a course without them never writes) but they are one subject's wording inside the shared speaker. The planned home is a pack-supplied speech rules file next to `pronounce.json`.
- **Comments** in `app/course/*` that use a subject as an example. `app/course/test/test-kit.mjs` forbids the subject's words in the kit's code (not in comments).

## Rules for new platform code

1. A course id, subject word or `app/<course>` path never appears in platform code. Read it from the pack's manifest.
2. Never read a course's files from the platform's own folder: an installed copy has none. Read them through `packs.fileFor(id, rel)` (confined to the pack's folder) and, for anything that is run, through `teach/pack.js` (hash-checked).
3. A course that declares nothing gets the general assistant. Never fall back to another course's behaviour.
4. When something needs a course's words, add a field to the pack's manifest and document it in `authoring-courses.md`.
