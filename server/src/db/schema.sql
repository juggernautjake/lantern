-- ===========================================================================
-- lantern/server/src/db/schema.sql
-- ---------------------------------------------------------------------------
-- The platform's spine. Four things live here and they are deliberately not
-- four separate systems:
--
--   1  WHO      people, the courses they teach or take, and the classes that
--               join the two. Every permission decision in the filing system
--               is answered from these three tables and nothing else.
--
--   2  WHAT     folders and files, with versions, metadata and provenance.
--               A file is never just bytes: it knows what it is for, which
--               course it belongs to, where it came from, and who may see it.
--
--   3  WORK     assignments, submissions and grades. A grade records who or
--               what produced it — the auto-grader, the AI reviewer, or a
--               teacher — and an AI grade is never final until a person has
--               confirmed it.
--
--   4  AI       threads, messages, tool calls and cost. Every agent turn is
--               logged with what it was given and what it did, because in a
--               school that is not optional.
--
-- SQLite, via node:sqlite. No ORM, no migration framework, no dependencies.
-- Every statement here is idempotent so the file can be re-run on boot.
-- ===========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1 — WHO
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- platform role. Class-level role lives on the enrolment; this is the
  -- floor: an admin is an admin everywhere, a student is never more than a
  -- student anywhere.
  role          TEXT NOT NULL CHECK (role IN ('admin','teacher','staff','student','guardian')),
  password_hash TEXT,
  password_salt TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  meta_json     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- 'CFML-501'
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A class is one running of a course: a teacher, a term, a roster.
CREATE TABLE IF NOT EXISTS classes (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,                  -- 'CFML-501-A'
  title      TEXT NOT NULL,
  term       TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, code)
);

CREATE TABLE IF NOT EXISTS enrolments (
  id         TEXT PRIMARY KEY,
  class_id   TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('student','teacher','ta','observer')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dropped','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_enrol_user  ON enrolments(user_id, status);
CREATE INDEX IF NOT EXISTS ix_enrol_class ON enrolments(class_id, role, status);

-- A guardian sees their own student's work and nobody else's. This table is
-- the whole of that rule.
CREATE TABLE IF NOT EXISTS guardianships (
  guardian_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'guardian',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guardian_id, student_id)
);

-- ---------------------------------------------------------------------------
-- 2 — WHAT: the filing system
-- ---------------------------------------------------------------------------
--
-- Folders carry a materialised path so a listing is one indexed query and a
-- permission walk is a string split rather than a recursive query. The path
-- scheme is fixed and meaningful — see files/paths.js — because a path that
-- tells you what something is beats a folder tree somebody has to maintain:
--
--   /courses/{courseId}/resources/...
--   /classes/{classId}/resources/...
--   /classes/{classId}/assignments/{assignmentId}/brief/...
--   /classes/{classId}/assignments/{assignmentId}/submissions/{userId}/...
--   /people/{userId}/private/...
--   /people/{userId}/portfolio/...
--   /shared/{folderId}/...
--   /system/ai/{threadId}/...

CREATE TABLE IF NOT EXISTS folders (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  path            TEXT NOT NULL UNIQUE,      -- '/classes/c1/assignments/a1/submissions/u9'
  kind            TEXT NOT NULL CHECK (kind IN (
                    'root','course-resources','class-resources','assignment-brief',
                    'submissions','student-work','personal','portfolio','shared',
                    'ai-artifacts','exports','archive')),
  course_id       TEXT REFERENCES courses(id) ON DELETE SET NULL,
  class_id        TEXT REFERENCES classes(id) ON DELETE SET NULL,
  assignment_id   TEXT,
  subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,  -- whose work this holds
  owner_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  system          INTEGER NOT NULL DEFAULT 0,   -- created by the platform, not deletable
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_folder_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS ix_folder_class  ON folders(class_id, kind);
CREATE INDEX IF NOT EXISTS ix_folder_person ON folders(subject_user_id, kind);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ext         TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',       -- where the bytes actually are
  version     INTEGER NOT NULL DEFAULT 1,

  -- What this file IS, as opposed to what it is called. Required, because a
  -- filing system whose metadata is optional is a folder tree with extra steps.
  purpose     TEXT NOT NULL CHECK (purpose IN (
                'brief','resource','reading','dataset','starter-code','solution',
                'rubric','submission','feedback','transcript','image','export',
                'reference','recording','template','other')),
  -- Where it came from. Provenance is a first-class column because "did a
  -- person upload this or did the assistant pull it off the web?" is the first
  -- question anyone asks about a file in a school.
  source      TEXT NOT NULL CHECK (source IN (
                'upload','generated','ai-fetched','ai-generated','imported','system')),
  source_url  TEXT NOT NULL DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'inherit' CHECK (visibility IN (
                'inherit','private','class','course','school','link')),
  link_token  TEXT,                            -- set only when visibility='link'

  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  meta_json   TEXT NOT NULL DEFAULT '{}',      -- author, licence, language, objectives…

  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT,                            -- soft delete; nothing is dropped
  UNIQUE (folder_id, name, version)
);
CREATE INDEX IF NOT EXISTS ix_file_folder  ON files(folder_id, deleted_at);
CREATE INDEX IF NOT EXISTS ix_file_purpose ON files(purpose, deleted_at);
CREATE INDEX IF NOT EXISTS ix_file_sha     ON files(sha256);
CREATE INDEX IF NOT EXISTS ix_file_link    ON files(link_token);

CREATE TABLE IF NOT EXISTS file_versions (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  size        INTEGER NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_id, version)
);

-- A file can belong to more than one course — a reading used by two courses is
-- one file with two rows here, not two copies.
CREATE TABLE IF NOT EXISTS file_courses (
  file_id   TEXT NOT NULL REFERENCES files(id)   ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, course_id)
);
CREATE TABLE IF NOT EXISTS file_classes (
  file_id  TEXT NOT NULL REFERENCES files(id)   ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, class_id)
);
CREATE TABLE IF NOT EXISTS file_tags (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (file_id, tag)
);
CREATE INDEX IF NOT EXISTS ix_tag ON file_tags(tag);

-- What a file is attached to: a lesson, an assignment, a submission, a chat
-- message, a project milestone. This is what makes the filing system part of
-- the learning platform rather than a drive bolted onto the side of it.
CREATE TABLE IF NOT EXISTS file_links (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
                'lesson','exercise','assignment','submission','grade','message',
                'thread','milestone','project','course','class','user')),
  entity_id   TEXT NOT NULL,
  relation    TEXT NOT NULL DEFAULT 'attachment',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_id, entity_type, entity_id, relation)
);
CREATE INDEX IF NOT EXISTS ix_link_entity ON file_links(entity_type, entity_id);

-- Explicit grants. The derived rules (a teacher can read their class's work)
-- live in code; this table is for the exceptions, which is what an ACL is for.
CREATE TABLE IF NOT EXISTS acl (
  id             TEXT PRIMARY KEY,
  file_id        TEXT REFERENCES files(id)   ON DELETE CASCADE,
  folder_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN (
                   'user','role','class','course','class-role','guardian-of','everyone')),
  principal_id   TEXT NOT NULL DEFAULT '',
  permission     TEXT NOT NULL CHECK (permission IN ('read','write','delete','share','grade')),
  effect         TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  granted_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT,
  reason         TEXT NOT NULL DEFAULT '',
  CHECK (file_id IS NOT NULL OR folder_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_acl_file   ON acl(file_id);
CREATE INDEX IF NOT EXISTS ix_acl_folder ON acl(folder_id);

CREATE TABLE IF NOT EXISTS file_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id  TEXT,
  folder_id TEXT,
  actor_id TEXT,
  action   TEXT NOT NULL,     -- read | download | upload | update | delete | share | denied
  detail   TEXT NOT NULL DEFAULT '',
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_file  ON file_audit(file_id, at);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON file_audit(actor_id, at);

-- ---------------------------------------------------------------------------
-- 3 — WORK
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  -- the studio's own id for this piece of work: 'u3l4e1', 'proj-fund-m2'
  ref         TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'exercise' CHECK (kind IN (
                'exercise','project-milestone','check','open-brief','upload','written')),
  title       TEXT NOT NULL,
  brief       TEXT NOT NULL DEFAULT '',
  due_at      TEXT,
  max_points  REAL NOT NULL DEFAULT 100,
  -- how much of the mark is correctness and how much is craft
  weight_json TEXT NOT NULL DEFAULT '{"correctness":0.7,"craft":0.3}',
  rubric_json TEXT NOT NULL DEFAULT '[]',
  published   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, ref, title)
);
CREATE INDEX IF NOT EXISTS ix_assign_class ON assignments(class_id, published);

CREATE TABLE IF NOT EXISTS submissions (
  id            TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt       INTEGER NOT NULL DEFAULT 1,
  body          TEXT NOT NULL DEFAULT '',      -- the code, for code assignments
  file_id       TEXT REFERENCES files(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                  'draft','submitted','returned','resubmitted')),
  submitted_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (assignment_id, student_id, attempt)
);
CREATE INDEX IF NOT EXISTS ix_sub_student ON submissions(student_id, status);

CREATE TABLE IF NOT EXISTS grades (
  id               TEXT PRIMARY KEY,
  submission_id    TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  grader_type      TEXT NOT NULL CHECK (grader_type IN ('auto','ai','teacher')),
  grader_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  score            REAL,
  max              REAL NOT NULL DEFAULT 100,
  correctness_json TEXT NOT NULL DEFAULT '{}', -- the assertion run, verbatim
  craft_json       TEXT NOT NULL DEFAULT '{}', -- the code review, verbatim
  rubric_json      TEXT NOT NULL DEFAULT '[]',
  feedback         TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT '',
  -- An AI or auto grade is a recommendation until a person says otherwise.
  -- Nothing reaches a transcript on the model's say-so.
  confirmed_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at     TEXT,
  overridden       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_grade_sub ON grades(submission_id, created_at);

-- ---------------------------------------------------------------------------
-- 4 — AI
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id     TEXT REFERENCES classes(id) ON DELETE SET NULL,
  title        TEXT NOT NULL DEFAULT '',
  -- where the learner was standing when they opened it: lesson, exercise,
  -- file, assignment. The agent reads this instead of asking.
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  archived     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_thread_user ON threads(user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  -- the Anthropic content-block array, stored verbatim so a conversation can
  -- be replayed exactly — including encrypted_content on web search results,
  -- which the API requires back unchanged on later turns
  content_json TEXT NOT NULL DEFAULT '[]',
  text         TEXT NOT NULL DEFAULT '',       -- flattened, for search
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_msg_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT REFERENCES threads(id) ON DELETE SET NULL,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  purpose        TEXT NOT NULL,                -- chat | grade | review | search | explain
  model          TEXT NOT NULL DEFAULT '',
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  web_searches   INTEGER NOT NULL DEFAULT 0,
  tools_used     TEXT NOT NULL DEFAULT '',
  ms             INTEGER NOT NULL DEFAULT 0,
  ok             INTEGER NOT NULL DEFAULT 1,
  error          TEXT NOT NULL DEFAULT '',
  -- what the model was allowed to see, recorded so a guardrail failure is
  -- provable after the fact rather than a matter of opinion
  redactions     TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_run_user ON agent_runs(user_id, created_at);

-- A per-person spend ceiling, checked before every call.
CREATE TABLE IF NOT EXISTS ai_budget (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,                 -- '2026-08'
  calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches  INTEGER NOT NULL DEFAULT 0,
  cap_calls     INTEGER NOT NULL DEFAULT 500,
  cap_searches  INTEGER NOT NULL DEFAULT 100
);

-- ---------------------------------------------------------------------------
-- SEARCH
-- ---------------------------------------------------------------------------
-- One index over everything the agent and the search box can reach. Rows are
-- written with the visibility scope that governs them, so a search is
-- filtered before it is ranked rather than after.

CREATE TABLE IF NOT EXISTS search_docs (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',        -- where it opens in the platform
  course_id   TEXT,
  class_id    TEXT,
  owner_id    TEXT,
  file_id     TEXT,
  visibility  TEXT NOT NULL DEFAULT 'class',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS ix_search_scope ON search_docs(class_id, course_id);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
