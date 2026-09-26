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

## Packs, exactly

`.lpack` = `{ "lanternPack": 1, "manifest": {…}, "files": { "<path>": "<base64>" } }`.

- The build adds `entry`, `units`, `lessons` (lessons plus checks, flat), `assets` (`[{ path, size, sha256 }]`) and `builtAt` to your `course.json` fields.
- Lantern refuses a pack whose files don't match their hashes.
- You can hand someone a pack file directly (Owner → export, or `dist/packs/<id>.lpack`). They add it under Courses → Add a course from a file.
