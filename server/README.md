# The Lantern platform server

> **This page describes the workspace side of the server** — filing, grading, the AI assistant — as it runs in `demo` mode (`LANTERN_MODE=demo`). The **Lantern app** (courses as packs, offline progress, the hub, updates) is described in [docs/dev/architecture.md](../docs/dev/architecture.md). Some tests and scripts named below need course content and are not in the public repository.

The filing system, the grader, the search index and the AI agent. Runs the
course too, and serves the studio.

```
node server/src/seed.js      # once: a demo school with people, classes and files
node server/src/index.js     # http://localhost:4321
```

That is the whole install. **There are no dependencies** — not "few", none. It
uses `node:sqlite`, `node:http`, `node:crypto` and the global `fetch`, so
there is no `npm install`, no lockfile, and nothing to audit. Node 22 or newer.

Sign in with any seeded account; the password is `lantern`.

| Account | Role | Useful because |
| --- | --- | --- |
| `sam@example.school` | student | Sees their own work and nobody else's |
| `dana@example.school` | teacher | Sees the whole class, can confirm grades |
| `rosa@example.home` | guardian | Sees one student's submitted work, never drafts |
| `admin@example.school` | admin | Sees everything |

---

## Turning the assistant on

One environment variable:

```
cp server/.env.example server/.env
# put your key in ANTHROPIC_API_KEY
node server/src/index.js
```

That single key enables chat, web search with cited links, image fetching, the
written half of code review, and rubric assessment. Nothing else is needed.

**Everything else works without it**, and that is a design decision rather than
a fallback: the auto-grader, the deterministic code reviewer, search, the
filing system and permissions are all local, instant and free. When the key is
absent the AI entry points return `null` and the UI says why. When a learner's
monthly budget runs out, the same thing happens. A school should never be in a
position where the marking stops because a bill was not paid.

`server/.env.example` documents every setting: models per job, monthly call and
search caps, the web-search domain allow-list, upload limits, and S3.

---

## What is where

```
server/src/
  db/schema.sql     the whole data model, commented. Read this first.
  db/db.js          the handle: one(), all(), run(), tx(), scrypt passwords
  files/
    paths.js        the virtual path scheme — a path says what a thing IS
    permissions.js  can(actor, action, resource) -> { allowed, reason, rule }
    store.js        content-addressed blobs: local disk, S3 (SigV4 written out), memory
    files.js        put / get / list / find / share / versions / audit
    extract.js      the words out of a DOCX, XLSX, PPTX or PDF, with no
                    dependency and an honest confidence when a PDF is a scan
    retention.js    how long things are kept, the sweep that destroys what is
                    past its window, and export-my-data
  search/index.js   one index over lessons, exercises and files
  ai/
    client.js       the Messages API over fetch: retries, pause_turn, budgets,
                    prompt-cache breakpoints
    stream.js       the streamed transport, and the SSE writer for our own
                    clients. Reassembles the exact content-block array, so
                    encrypted web-search content survives to the next turn
    tools.js        what the assistant may do — with the USER's permissions.
                    Three extra tools appear only for somebody who teaches
    prompts.js      the system prompts, and the answer-key guardrail
    agent.js        the conversation loop, streamed or not
    review.js       autoGrade() deterministic · aiReview() the write-up
  teaching.js       the class from the front of the room: who has handed in
                    what, and which finding to re-teach
  course/runner.js  loads the studio's own CFML engine so the server grades
                    with byte-identical logic to the browser
  http/server.js    router, multipart, sessions
  routes.js         every endpoint
  index.js          boot
public/index.html   the whole client: files, search, work, chat. No build step.
test/                 202 checks across two suites
```

---

## The four ideas worth knowing before you change anything

**1 — A path says what a thing is, so permissions can be computed rather than
stored.** `/classes/{c}/assignments/{a}/submissions/{u}` is a student's work by
construction. Nothing has to remember who may read it; the rule reads the path
and the roster, live. When a teacher is added to a class at half past three,
their access is correct at half past three, with no reindexing.

**2 — The assistant is a lens, never a key.** Every tool runs with the asking
user's own permission context. Ask it to read another student's submission and
it fails in the same place, with the same sentence, as opening it yourself
would. There is no elevated path, because the way this leaks is that somebody
adds one.

**3 — Nothing is destroyed, and a person can take their own record.** Deleting
sets a date; a sweep destroys what is past its window, and only after checking
that no other file points at the same bytes. `GET /api/export/{userId}`
gives a person everything the platform holds about them — a guardian can export their
student, a teacher cannot export anybody.

**4 — Correctness is decided before the model is asked anything.** A mark is
the assertion run (deterministic) plus the static reviewer (deterministic), and
the model is *told* that verdict rather than asked for it. So a confident
paragraph cannot overturn a failing test, and the assistant being down degrades
the feedback rather than the mark. No grade reaches a transcript until a person
confirms it — `grades.confirmed_by`.

---

## Tests

```
node server/test/test-platform.mjs      # 127 — permissions, filing, grading
node server/test/test-platform2.mjs     # 75  — extraction, retention, teaching,
                                        #       caching, streaming
node scripts/test-cfml.mjs              # 303 — the interpreter and analyser
node scripts/verify-cfml-content.mjs    # every solution passes, every starter fails
node scripts/audit-assignments.mjs      # is each assignment any good?
node scripts/audit-coverage.mjs         # does the course cover the case study?
```

The permissions matrix in the first of those is written the way it would be
argued about in a meeting — every principal against every kind of location —
and asserts the negatives as hard as the positives. A wrong MIME type is an
annoyance. A permission bug is a child's work shown to the wrong parent.

---

## Deploying it

- **Storage.** Local disk by default. Set `S3_BUCKET` and credentials to move
  blobs to any S3-compatible store; the signing is in `files/store.js`.
- **Database.** One SQLite file, WAL mode. Back it up with the blob directory
  and you have backed up the platform.
- **Behind a proxy.** Terminate TLS in front; the cookie is `HttpOnly` and
  `SameSite=Lax`. Set `LANTERN_SESSION_DAYS` to taste.
- **Do not run `seed.js` in production.** It refuses unless forced, and the
  demo passwords are all `lantern`.
