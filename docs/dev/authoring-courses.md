# Making a course

A course is a folder. One command builds it into a **pack**, and another puts it on your hub, where you can send it to people. The platform never changes to add a course.

```
courses/
  _template/            copy this to start a new course
  <id>/
    course.json         what the course is, and how it is built
    structure.json      its units, lessons, exercises, projects and checks
                        (or structure.mjs, a module that returns them)
    site/               its pages (index.html first), or a build step
```

## Start one

```
xcopy /E /I courses\_template courses\knots          (or copy the folder in Explorer)
```

1. In `courses/knots/course.json`, set `"id": "knots"` (lowercase letters, digits and dashes; this is permanent) and fill in the title, description and level.
2. Rename the storage key `course-template` to your own, e.g. `course-knots`, in **both** `course.json` (`storage.keys` and `progress.key`) and your pages.
3. Write your lessons in `site/`, and list them in `structure.json`.
4. Build: `node scripts/build-pack.mjs knots`. It checks everything, then writes `dist/packs/knots.lpack`.
5. Try it: start Lantern on this computer. Packs in `dist/packs` install themselves when Lantern starts, or you can use Courses → Add a course from a file.
6. Publish: `node scripts/publish-course.mjs knots`. It goes up as a **draft** (only you see it). Then run `node scripts/publish-course.mjs knots --publish` when it's ready.

## course.json

```json
{
  "id": "knots",
  "title": "Knots for Everyone",
  "version": "1.0.0",
  "description": "Twelve knots, and when to use each.",
  "level": "Beginner", "subject": "Outdoors", "estimatedHours": 4,
  "minPlatform": "0.1.0",
  "structure": "structure.json",
  "storage": { "keys": ["course-knots"] },
  "progress": {
    "key": "course-knots", "stateVersion": 1,
    "lessons": "lessons", "lessonDone": "done",
    "exercises": "exercises", "exercisePassed": "passed", "exerciseBest": "best", "exerciseAttempts": "attempts",
    "milestones": "projects", "milestonePassed": "passed",
    "seconds": "seconds", "position": "lastPage"
  },
  "changelog": [ { "version": "1.0.0", "date": "2026-10-01", "notes": "- First version." } ]
}
```

| Field | Meaning |
|---|---|
| `version` | Raise it for every published change: `1.0.1` for fixes, `1.1.0` for new lessons. People see the changelog entries newer than the version they had |
| `storage.keys` | The browser-storage keys your pages use. Lantern saves exactly these, restores them on another computer, and syncs them. Use names only your course would use |
| `progress` | Where, inside the JSON stored under `progress.key`, Lantern finds finished lessons, passed exercises, reached milestones, time spent and the current page. Lantern reads progress from there, and writes work done on another computer back there before your page loads |
| `build` | Instead of `site/`: `{ "command": "node scripts/build-my-course.mjs", "page": "dist/my-course.html", "assets": [{ "from": "…", "to": "…" }], "head": "<link …>" }` — one built page plus the files it needs offline |
| `minPlatform` | The oldest Lantern that can run it. People on older versions are told to update Lantern first |

## The state your pages keep

Keep one JSON object under your `progress.key`:

```json
{ "v": 1,
  "lessons":   { "<lesson or check id>": { "done": true, "at": 1790000000000 } },
  "exercises": { "<exercise id>": { "passed": true, "best": 100, "attempts": 2, "firstPassAt": 1790000000000 } },
  "projects":  { "<milestone id>": { "passed": true, "attempts": 1, "at": 1790000000000 } },
  "seconds": 1234,
  "lastPage": "<the id of the page on screen>" }
```

- **Save as you go** (`localStorage.setItem`). Lantern notices every change within a second.
- **Opening at a page:** read `lastPage` when your page starts and go there. That's how "open this lesson" works from the overview.
- **Moving while open:** also listen for `window.postMessage({ lantern: "go", id }, …)` from the parent, which moves an open course to a page.
- **Settings:** optionally, listen for `{ lantern: "settings", editor, appearance }`, and send `{ lantern: "settings-changed", editor, appearance }` to `window.parent` when the learner changes one. Lantern keeps these per person, across computers.
- **Offline:** work fully offline. Put fonts, images and scripts in the pack, not on the web.

`courses/_template/site/index.html` does all of this in about 80 lines.

## structure.json

```json
[ { "id": "u1", "n": 1, "title": "Getting started", "overview": "…",
    "lessons": [ { "id": "k-u1l1", "title": "The reef knot", "minutes": 15,
                   "objectives": ["Tie a reef knot"], "keyTerms": ["bight", "standing part"],
                   "exercises": [ { "id": "k-u1l1e1", "title": "Tie it blindfold" } ] } ],
    "check": { "id": "k-u1check", "title": "Unit 1 check", "minutes": 10 },
    "projects": [ { "id": "k-proj1", "title": "A rope ladder", "minutes": 60,
                    "milestones": [ { "id": "k-proj1-m1", "title": "The rungs" } ] } ] } ]
```

- **What it feeds:** the course overview (every item with its status, the %, time left, what's next) and the learning context (objectives and key terms, for the assistant and the resource finder).
- **Ids are forever.** Progress is stored against them. A new version may add ids and reword titles, but must never rename or remove one: the build warns, the publish refuses, and installing on a learner's computer refuses. To retire a lesson, keep its id and mark the page "no longer needed".

## Teaching with your course (the `teach` block)

Lantern's assistant knows nothing about any subject. What it can teach with, and what it stays on, comes from the **installed pack**: an optional `teach` block in `course.json`, carried into the manifest by `build-pack`. A course without it still gets the general assistant (the lessons, progress, notes, hints, videos and web search). A course with it gets exactly the tools its block supplies, never another course's.

```jsonc
"teach": {
  // the build's map: pack path -> source in the repo (a file or a folder). Not copied into the manifest.
  "files": { "teach/data/glossary.json": "courses/<id>/data/glossary.json", "teach/kit/engine.js": "app/course/engine.js" },

  // data the tools read (pack paths)
  "data": { "modules": "teach/data/modules.json", "equations": "...", "templates": "...", "glossary": "...", "acronyms": "...", "refsheet": "..." },

  // scripts the server runs to draw figures / generate problems, in load order (pack paths)
  "figures":    { "load": ["teach/kit/markdown.js", "teach/figures/m1.js"] },
  "generators": { "load": ["teach/kit/engine.js", "teach/content.js"] },

  // the subject: inline, or a pack path to a JSON file
  "scope": { "name": "…", "topic": "…", "tutor": "a … tutor", "about": "what is on topic", "vocabulary": ["words"], "patterns": ["regex"] },

  "tools":   "teach/tools.json",                 // tool descriptions in the course's words { tool: "text" }
  "prompts": { "tutor": "teach/tutor.md", "visuals": "teach/visuals.md" },   // notes added to the system prompt
  "reference": { "name": "…", "note": "…", "standardNote": "…" },           // turns on handbook + standard
  "glossary":  { "computational": "…", "conceptual": "…", "how": "…" },      // how to explain a term
  "lawBasis":  { "jurisdictionPattern": "regex", "how": "…" },               // turns on law_basis
  "review":    { "kindNames": { "exam": "mock exam" }, "note": "extra line for quiz reviews" },
  "videos":    { "dir": "assets/videos" },        // where the video scripts are (default as shown)
  "library":   { "index": "assets/library/index.json" }
}
```

What each part switches on:

| In `teach` | The assistant gets |
|---|---|
| `data.modules` + `figures.load` | `find_visuals`, `show_figure`, `show_demo`, `show_equation`, `show_passage`, `draw_figure`, `draw_derivation` |
| `data.templates` + `generators.load` | `worked_example` (numbers from your own engine, never the model's arithmetic) |
| `data.glossary` (+ `acronyms`, `refsheet`) | `glossary` (aliases, rough spelling, acronyms, the lessons that teach the term) |
| `reference` | `handbook` and `standard`, from the pack's `context/knowledge.json` inventory |
| `lawBasis` | `law_basis` (lessons to rest a scenario on, marking the jurisdiction-specific ones) |
| `scope` | the scope gate: a question is on, off or an injection before any tool or model runs |
| `prompts`, `tools`, `review` | your own wording |

**Scope.** With `scope`, the gate uses your `vocabulary` (plus your glossary's terms and `patterns`) and, when still unclear, one quick Haiku check whose prompt uses your `tutor` and `about` lines. With `teach` but no `scope`, the course is scoped to its title and description. With no `teach`, there is no gate. With no course open, the assistant helps with studying in general.

**Data shapes** (the same files the course page reads):

- `modules`: `[{ n, title, lessons: [{ id, title, objective, reading }], key_formulas: [{ id, name, formula, variables, demo }] }]`. A reading may contain `[figure:name {json params} "caption"]` and `[demo:name]` lines.
- `equations`: `{ formulas: { <id>: { symbols: [[sym, meaning]], means, when, how, derive, hook } } }`.
- `glossary`: `{ entries: [{ term, definition, example?, usage?, "confused-with"?, related? }], aliases: { "alias": "Term" } }`; `acronyms` and `refsheet` are optional.
- `templates`: the problem generators your engine runs (`Course.engine.generateValid(template)`).

**How the server runs your code.** Only from the installed pack's own folder, never from the platform's folder and never from a path outside the pack. Each file is checked against the sha256 in the manifest (the same hashes the installer verified) before it is read or run; a changed file is refused. The scripts run in plain functions that are given a `Course` object, with no access to the server's modules. It is your code, as it is on the course page. Results are cached per pack id and version.

**Building.** `build-pack` copies every file named in `teach.files` into the pack and fails if any path the block names is missing. A course that ships figure or engine code from the shared kit lists those kit files too (as FS does: `teach/kit/engine.js` and so on), because an installed copy of Lantern has no kit of its own. Lantern 0.2.1 or later reads the block (set `minPlatform`).

**Try it.** `courses/_template/course.json` carries a commented-out example (`_teach`); rename it to `teach` and build. `courses/fs/course.json` is a full one. `server/test/test-multicourse.mjs` shows what a second course gets.

## Publishing and updating

```
node scripts/publish-course.mjs knots              build, check, upload; a new course starts as a draft
node scripts/publish-course.mjs knots --publish    …and make it visible to the people you send it to
node scripts/publish-course.mjs knots --open       …to everyone signed in to your hub
node scripts/publish-course.mjs knots --listed     …show its title in "More courses" so people can ask for it
```

**How it signs in**
- With Lantern open on this computer, signed in as the hub's owner, nothing else is needed.
- Without the app, it uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from a local `.env` that's never committed or shipped.

**Updating a course**
1. Change the course.
2. Raise `version`.
3. Add a changelog entry.
4. Publish again.

Everyone who has the course gets the new version on their next sync, sees "*Knots for Everyone was updated to 1.1.0. Your progress is kept.*", and can read what's new.

## External media (build.media)

Big files (narration, video) can stay out of the pack and be served from Cloudflare R2. Declare them in `course.json`:

```json
"build": {
  "assets": [{ "from": "app/fs/assets", "to": "assets", "exclude": "\\.(webm|mp4)$" }],
  "media": { "from": "app/fs/assets/videos", "to": "assets/videos", "include": ["*.mp4"], "keyPrefix": "fs" }
}
```

- `from`: the folder of files; `to`: where they appear inside the pack (so pages keep using `assets/videos/x.mp4`); `include`: file patterns (`*` matches within a folder); `keyPrefix`: the key's folder in the bucket. An optional `base` is the public address used when `R2_PUBLIC_URL` is not set.
- Keep the same files out of `build.assets` (the example excludes them there) so they are not read into the pack.
- The build writes `manifest.media = { base, files: { "assets/videos/x.mp4": { key, size, sha256 } } }`. A key is `<keyPrefix>/<sha256><ext>`: it names the content, so it never changes meaning.
- Then `node scripts/upload-media.mjs <course>` and publish. The environment names (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`) and the setup are in `docs/dev/releasing.md`.
- Pages need no change. The app downloads the files into the installed pack, redirects to R2 until a file is there, and serves it locally afterwards. A pack with no `build.media` works exactly as before. Set `minPlatform` to 0.2.1 or newer.

## Packs, exactly

`.lpack` = `{ "lanternPack": 1, "manifest": {…}, "files": { "<path>": "<base64>" } }`.

- The build adds `entry`, `units`, `lessons` (lessons plus checks, flat), `assets` (`[{ path, size, sha256 }]`) and `builtAt` to your `course.json` fields.
- Lantern refuses a pack whose files don't match their hashes.
- You can hand someone a pack file directly (Owner → export, or `dist/packs/<id>.lpack`). They add it under Courses → Add a course from a file.
