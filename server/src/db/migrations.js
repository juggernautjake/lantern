/* ===========================================================================
   server/src/db/migrations.js — changes to the database, in order, forever.
   ---------------------------------------------------------------------------
   schema.sql is the baseline and is applied on every open (it is idempotent).
   Everything that changes the database AFTER a release has gone out goes here
   instead, as a numbered migration:

     - forward-only: a migration is never edited or removed once released;
       a mistake is corrected by the next migration
     - each one runs inside a transaction, so it lands completely or not at all
     - before any pending migration touches a database that already has data,
       a timestamped backup of the whole file is taken (see backups.js)
     - schema_migrations records what ran and when

   To add one: append { version: <next>, name, up } where up is SQL text or a
   function (db) => void. Versions are integers and must increase.
   =========================================================================== */

export const MIGRATIONS = [
  {
    version: 1,
    name: 'platform: settings, course packs, progress, sync queue, update log',
    up: `
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Course packs installed on this computer (student) or held by the hub.
      CREATE TABLE IF NOT EXISTS packs (
        id               TEXT PRIMARY KEY,           -- 'cfml'
        title            TEXT NOT NULL,
        version          TEXT NOT NULL,
        manifest_json    TEXT NOT NULL,
        source           TEXT NOT NULL DEFAULT 'file' CHECK (source IN ('hub','file','bundled')),
        previous_version TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        installed_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- One row per person per course: the pack's own saved state (the browser
      -- storage keys it declares), plus what the platform keeps beside it.
      CREATE TABLE IF NOT EXISTS pack_progress (
        user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pack_id            TEXT NOT NULL,
        state_json         TEXT NOT NULL DEFAULT '{}',   -- { key: string value }
        saved_at           INTEGER NOT NULL DEFAULT 0,   -- ms, when the state last changed
        seconds_seen       INTEGER NOT NULL DEFAULT 0,   -- the pack's own time counter, last seen
        position_json      TEXT,                         -- { ref, at }
        position_synced_at INTEGER NOT NULL DEFAULT 0,
        snapshot_synced_at INTEGER NOT NULL DEFAULT 0,
        hub_seconds        INTEGER NOT NULL DEFAULT 0,   -- all devices, as the hub last reported
        updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, pack_id)
      );

      -- Every earlier state, kept whenever a state is replaced wholesale (an
      -- import, a restore, a newer copy from another computer), so nothing a
      -- person did can be lost by a single click.
      CREATE TABLE IF NOT EXISTS pack_progress_history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        pack_id    TEXT NOT NULL,
        state_json TEXT NOT NULL,
        saved_at   INTEGER NOT NULL DEFAULT 0,
        reason     TEXT NOT NULL DEFAULT '',
        at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS ix_pph_user ON pack_progress_history(user_id, pack_id, id);

      -- Progress item by item (lesson, exercise, project milestone, unit check),
      -- merged by the rules in platform/merge.js. dirty = not yet at the hub.
      CREATE TABLE IF NOT EXISTS progress_items (
        user_id       TEXT NOT NULL,
        pack_id       TEXT NOT NULL,
        kind          TEXT NOT NULL,
        ref           TEXT NOT NULL,
        completed     INTEGER NOT NULL DEFAULT 0,
        best          REAL NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        first_done_at INTEGER,
        updated_at    INTEGER NOT NULL DEFAULT 0,
        dirty         INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, pack_id, kind, ref)
      );
      CREATE INDEX IF NOT EXISTS ix_pi_dirty ON progress_items(dirty, user_id, pack_id);

      -- Things that happened: time spent (each with its own id, so it is
      -- counted once however often it is sent), lessons finished, and so on.
      CREATE TABLE IF NOT EXISTS progress_events (
        id        TEXT PRIMARY KEY,
        user_id   TEXT NOT NULL,
        pack_id   TEXT NOT NULL,
        kind      TEXT NOT NULL,                  -- 'time' | 'completed' | 'opened' | …
        ref       TEXT,
        data_json TEXT NOT NULL DEFAULT '{}',
        at        INTEGER NOT NULL,               -- ms since epoch
        synced    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ix_pe_user ON progress_events(user_id, pack_id, at);
      CREATE INDEX IF NOT EXISTS ix_pe_sync ON progress_events(synced, kind);

      -- Anything that must reach the hub, waiting until it can. Survives
      -- restarts; a row is done when done_at is set.
      CREATE TABLE IF NOT EXISTS sync_queue (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        next_at      TEXT,
        done_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_sync_pending ON sync_queue(done_at, next_at);

      -- Every update: the program, or one course. What the person reads under
      -- "What's new", and the record of what was installed when.
      CREATE TABLE IF NOT EXISTS update_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        at           TEXT NOT NULL DEFAULT (datetime('now')),
        channel      TEXT NOT NULL CHECK (channel IN ('platform','pack')),
        subject      TEXT NOT NULL,                  -- 'lantern' or a pack id
        from_version TEXT,
        to_version   TEXT,
        status       TEXT NOT NULL CHECK (status IN ('installed','failed','rolled-back')),
        title        TEXT NOT NULL DEFAULT '',
        notes        TEXT NOT NULL DEFAULT '',
        message      TEXT NOT NULL DEFAULT '',
        backup       TEXT
      );
    `,
  },
];

export const LATEST = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

/* Apply what has not run yet. before(pending) is called once, before the
   first pending migration, when the database already holds data — that is
   where the backup is taken. Returns the versions applied. */
export function migrate(db, opts) {
  const o = opts || {};
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const list = (o.migrations || MIGRATIONS).slice().sort((a, b) => a.version - b.version);
  const pending = list.filter((m) => !done.has(m.version));
  if (!pending.length) return [];
  if (o.before && hasData(db)) o.before(pending);
  const applied = [];
  for (const m of pending) {
    db.exec('BEGIN');
    try {
      if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      db.exec('COMMIT');
      applied.push(m.version);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
      throw Object.assign(new Error('Database migration ' + m.version + ' (' + m.name + ') failed: ' + e.message), { cause: e });
    }
  }
  return applied;
}

/* A database worth backing up: anybody in it, or anything recorded. */
function hasData(db) {
  try { return (db.prepare('SELECT COUNT(*) AS n FROM users').get().n || 0) > 0; }
  catch (e) { return false; }
}
