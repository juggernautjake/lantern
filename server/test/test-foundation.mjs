#!/usr/bin/env node
/* ===========================================================================
   server/test/test-foundation.mjs — the platform's foundation, in one process.
   ---------------------------------------------------------------------------
       node server/test/test-foundation.mjs

   Migrations and backups, course packs, progress (reading it out of a pack's
   state and writing it back, importing the web version's backup, history),
   the merge rules, the updater (against a fake GitHub, including a failed
   update that must roll back), the ecosystem event schema and guard, the
   shared AI key (Windows), and the privacy scan. Nothing here touches the
   real data folder, the network, or a real GitHub.
   =========================================================================== */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { suite, ROOT } from './helpers.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'lantern-foundation-'));
process.env.LANTERN_DATA = join(TMP, 'data');
process.env.ECOSYSTEM_DIR = join(TMP, 'eco');
mkdirSync(process.env.LANTERN_DATA, { recursive: true });

const db = await import('../src/db/db.js');
const { migrate, MIGRATIONS } = await import('../src/db/migrations.js');
const backups = await import('../src/platform/backups.js');
const packs = await import('../src/platform/packs.js');
const progress = await import('../src/platform/progress.js');
const merge = await import('../src/platform/merge.js');
const { cmp } = await import('../src/platform/semver.js');
const eco = await import('../src/platform/eco.js');
const updater = await import('../src/platform/updater.js');
const credentials = await import('../src/platform/credentials.js');
const settings = await import('../src/platform/settings.js');

const t = suite('Lantern foundation');

/* ------------------------------------------------------------ migrations */
t.section('Migrations and backups');
{
  // An "old" database: the baseline schema only, with somebody in it.
  const file = join(TMP, 'old.db');
  const raw = new DatabaseSync(file);
  raw.exec(readFileSync(join(ROOT, 'server', 'src', 'db', 'schema.sql'), 'utf8'));
  raw.prepare("INSERT INTO users (id, email, name, role) VALUES ('usr_1','a@b.c','A','student')").run();
  raw.close();
  db.open(file);
  const applied = db.all('SELECT version FROM schema_migrations').map((r) => r.version);
  t.eq('an existing database gets every migration', applied, MIGRATIONS.map((m) => m.version));
  const bdir = join(TMP, 'backups');
  const made = readdirSync(bdir).filter((f) => /before-migration-1/.test(f));
  t.ok('…after a whole backup was taken first', made.length === 1);
  t.ok('…and the data is still there', db.one('SELECT name FROM users WHERE id = ?', 'usr_1').name === 'A');
  t.ok('the new tables exist', ['packs', 'pack_progress', 'progress_items', 'sync_queue', 'update_log'].every((n) => db.one("SELECT name FROM sqlite_master WHERE name = ?", n)));
  db.close();
  db.open(file);
  t.ok('opening again changes nothing (forward-only, once each)', readdirSync(bdir).filter((f) => /before-migration/.test(f)).length === 1);
  db.close();

  const h = new DatabaseSync(':memory:');
  h.exec('CREATE TABLE users (id TEXT)');
  let threw = false;
  try { migrate(h, { migrations: [{ version: 1, name: 'good', up: 'CREATE TABLE a (x)' }, { version: 2, name: 'bad', up: 'CREATE TABLE a (x)' }] }); }
  catch (e) { threw = /migration 2/.test(e.message); }
  t.ok('a failing migration throws and says which', threw);
  t.ok('…the one before it stays applied', h.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n === 1);
  t.ok('…and nothing of the failed one is left', !h.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get() || h.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 2').get().n === 0);

  const rdir = join(TMP, 'rot');
  mkdirSync(rdir);
  for (let i = 0; i < 5; i++) writeFileSync(join(rdir, 'lantern-2026-01-0' + i + 'T00-00-00-x.db'), 'x');
  backups.rotate(rdir, 3);
  t.eq('backups keep only the newest N', readdirSync(rdir).sort(), ['lantern-2026-01-02T00-00-00-x.db', 'lantern-2026-01-03T00-00-00-x.db', 'lantern-2026-01-04T00-00-00-x.db']);
}

/* ----------------------------------------------------------------- packs */
t.section('Course packs');
db.open(':memory:');
const UID = 'usr_me';
db.insert('users', { id: UID, email: 'me@x.local', name: 'Me', role: 'student' });
const baseManifest = () => ({
  id: 'demo', title: 'Demo', version: '1.0.0', entry: 'index.html', description: 'A demo',
  storage: { keys: ['demo-state', 'demo-extra'] },
  progress: { key: 'demo-state', stateVersion: 1, lessons: 'lessons', exercises: 'exercises', milestones: 'projects', seconds: 'seconds', position: 'lastPage' },
  units: [{ id: 'u1', n: 1, title: 'One', lessons: [{ id: 'l1', title: 'L one', minutes: 10, objectives: ['do a thing'], keyTerms: ['thing'], exercises: [{ id: 'l1e1', title: 'E' }] }, { id: 'l2', title: 'L two', minutes: 20, exercises: [] }],
    check: { id: 'u1check', title: 'Check', minutes: 15 }, projects: [{ id: 'p1', title: 'Proj', minutes: 30, milestones: [{ id: 'p1m1', title: 'M1' }, { id: 'p1m2', title: 'M2' }] }] }],
  lessons: [{ id: 'l1', title: 'L one' }, { id: 'l2', title: 'L two' }, { id: 'u1check', title: 'Check' }],
  changelog: [{ version: '1.0.0', notes: '- first' }],
});
{
  const pk = packs.buildPack(baseManifest(), { 'index.html': '<p>hi</p>' });
  t.ok('a pack is built with a hash for every file', pk.manifest.assets.length === 1 && pk.manifest.assets[0].sha256.length === 64);
  const damaged = JSON.parse(JSON.stringify(pk));
  damaged.files['index.html'] = Buffer.from('<p>changed</p>').toString('base64');
  let refused = false; try { packs.parsePack(damaged); } catch (e) { refused = /damaged/.test(e.message); }
  t.ok('a damaged pack is refused', refused);
  let bad = false; try { packs.buildPack(Object.assign(baseManifest(), { id: 'Bad Id' }), { 'index.html': 'x' }); } catch (e) { bad = /id must be/.test(e.message); }
  t.ok('an invalid manifest is refused with a reason', bad);
  const r = packs.install(JSON.stringify(pk), { source: 'file' });
  t.ok('install puts it in the packs folder', r.changed && existsSync(join(process.env.LANTERN_DATA, 'packs', 'demo', '1.0.0', 'index.html')));
  t.ok('…and serves its files, never outside its folder', packs.fileFor('demo', 'index.html') && !packs.fileFor('demo', '../../lantern.db'));
  t.ok('…and logs it', db.one("SELECT COUNT(*) AS n FROM update_log WHERE channel='pack' AND subject='demo'").n === 1);

  const v2 = Object.assign(baseManifest(), { version: '1.1.0', changelog: [{ version: '1.1.0', notes: '- more' }, { version: '1.0.0', notes: '- first' }] });
  v2.units[0].lessons.push({ id: 'l3', title: 'L three', minutes: 5, exercises: [] });
  v2.lessons.push({ id: 'l3', title: 'L three' });
  packs.install(JSON.stringify(packs.buildPack(v2, { 'index.html': '<p>v2</p>' })), { source: 'file' });
  const log = db.one("SELECT * FROM update_log WHERE subject='demo' ORDER BY id DESC LIMIT 1");
  t.ok('an update logs only the notes since the old version', /1\.1\.0/.test(log.notes) && !/## 1\.0\.0/.test(log.notes) && log.from_version === '1.0.0');
  const v3 = Object.assign(baseManifest(), { version: '1.2.0' });
  v3.units[0].lessons = v3.units[0].lessons.filter((l) => l.id !== 'l2');
  v3.lessons = v3.lessons.filter((l) => l.id !== 'l2');
  let dropped = null; try { packs.install(JSON.stringify(packs.buildPack(v3, { 'index.html': 'x' }))); } catch (e) { dropped = e.details; }
  t.ok('a version that drops a lesson id is refused, naming it', Array.isArray(dropped) && dropped.includes('l2') && dropped.includes('l3'));
  let older = false; try { packs.install(JSON.stringify(packs.buildPack(baseManifest(), { 'index.html': 'x' }))); } catch (e) { older = /newer/.test(e.message); }
  t.ok('an older version is refused', older);
  const ex = packs.exportPack('demo');
  t.ok('an installed pack exports to a valid pack file', packs.parsePack(JSON.stringify(ex)).manifest.version === '1.1.0');
  t.ok('semver: 1.10.0 > 1.9.0, and 1.0.0 > 1.0.0-beta', cmp('1.10.0', '1.9.0') > 0 && cmp('1.0.0', '1.0.0-beta') > 0);
}

/* -------------------------------------------------------------- progress */
t.section('Progress');
{
  const pack = packs.get('demo');
  const state = (o) => JSON.stringify(Object.assign({ v: 1, lessons: {}, exercises: {}, projects: {}, seconds: 0 }, o));
  let r = progress.saveState(UID, pack, { keys: { 'demo-state': state({ lessons: { l1: { done: true, at: 1000 } }, exercises: { l1e1: { attempts: 2, passed: true, best: 100, firstPassAt: 900, lastAt: 1000 } }, seconds: 120, lastPage: 'l1' }), 'not-ours': 'x' }, savedAt: 2000 });
  t.ok('a saved state is read into items: the lesson and the exercise', r.changed.some((c) => c.ref === 'l1' && c.completed) && r.changed.some((c) => c.ref === 'l1e1' && c.completed));
  t.ok('…the time became one time event', progress.localSeconds(UID, 'demo') === 120);
  t.ok('…keys the pack does not own are ignored', !('not-ours' in progress.stateForPlayer(UID, pack).keys));
  t.ok('…a completion event was recorded', r.events.some((e) => e.kind === 'completed' && e.ref === 'l1'));
  const stale = progress.saveState(UID, pack, { keys: { 'demo-state': state({}) }, savedAt: 1500 });
  t.ok('an older save is refused (a stale tab cannot overwrite newer work)', stale.stale === true);
  progress.saveState(UID, pack, { keys: { 'demo-state': state({ lessons: { l1: { done: true, at: 1000 } }, seconds: 180, lastPage: 'l2' }) }, savedAt: 3000 });
  t.ok('only new time is counted', progress.localSeconds(UID, 'demo') === 180);
  t.ok('a redo in the pack never un-finishes an item', progress.items(UID, 'demo').find((i) => i.ref === 'l1e1').completed === true);
  const back = progress.stateForPlayer(UID, pack);
  const S = JSON.parse(back.keys['demo-state']);
  t.ok('…and the item is written back into the pack’s state for the player', S.exercises.l1e1 && S.exercises.l1e1.passed === true);
  const open = JSON.parse(progress.stateForPlayer(UID, pack, { open: 'p1' }).keys['demo-state']);
  t.ok('“open this lesson” sets the pack’s position', open.lastPage === 'p1');

  const ov = progress.overview(UID, pack);
  t.ok('overview: statuses per lesson, exercise, project, check', ov.units[0].lessons[0].status === 'done' && ov.units[0].lessons[1].status === 'in-progress' && ov.units[0].projects[0].status === 'not-started' && ov.units[0].check.status === 'not-started');
  t.ok('overview: percent, time left, where they are', ov.percent > 0 && ov.minutesLeft > 0 && ov.current && ov.current.id === 'l2' && ov.continue.id === 'l2');
  t.ok('overview: "next" is what comes AFTER where they are (not the first thing skipped)', ov.next && ov.next.id === 'l3', JSON.stringify(ov.next));
  t.ok('overview: ONE measure — steps (lessons, exercises, milestones, checks)', ov.count === 7 && ov.finished === 2 && ov.steps.total === 7 && ov.lessons.total === 3 && ov.lessons.done === 1 && ov.percent === 28, JSON.stringify({ c: ov.count, f: ov.finished, l: ov.lessons, p: ov.percent }));
  t.ok('…and the summary (course list, hub, Dayspring) says it the same way', progress.summary(UID, pack).measure === '2 of 7 steps · 1 of 3 lessons');
  t.ok('opening a lesson moves "where they are" at once (before the course saves)', progress.openAt(UID, pack, 'l3') && progress.overview(UID, pack).current.id === 'l3' && progress.overview(UID, pack).next.id === 'p1');
  t.ok('…but not to something the course does not have', !progress.openAt(UID, pack, 'nope'));
  progress.openAt(UID, pack, 'l2');

  // Import from the web version (the studio's own backup format)
  const backup = { lantern: 'backup', version: 1, at: '2026-09-01', keys: { 'demo-state': state({ lessons: { l2: { done: true, at: 5 } }, projects: { p1m1: { attempts: 1, passed: true, at: 6 } }, seconds: 3600 }), 'demo-extra': 'kept', 'someone-else': 'x' } };
  const imp = progress.importBackup(UID, pack, JSON.stringify(backup));
  t.eq('import takes only the pack’s own keys', imp.imported.sort(), ['demo-extra', 'demo-state']);
  const after = progress.items(UID, 'demo');
  t.ok('import adds what the backup had', after.some((i) => i.ref === 'l2' && i.completed) && after.some((i) => i.ref === 'p1m1' && i.completed));
  t.ok('…and keeps what was already done here', after.some((i) => i.ref === 'l1' && i.completed) && after.some((i) => i.ref === 'l1e1' && i.completed));
  t.ok('…the state it replaced is kept in the history', progress.history(UID, 'demo').some((h) => h.reason === 'before import'));
  let notBackup = false; try { progress.importBackup(UID, pack, '{"hello":1}'); } catch (e) { notBackup = /not a Lantern backup/.test(e.message); }
  t.ok('a paste that is not a backup is refused with directions', notBackup);
  const ctx = (await import('../src/platform/routes.js')).learningContext(UID, pack, 'l1');
  t.ok('the learning context: course, unit, lesson, objectives, key terms', ctx.course.id === 'demo' && ctx.unit.n === 1 && ctx.item.title === 'L one' && ctx.item.objectives[0] === 'do a thing' && ctx.item.keyTerms[0] === 'thing');
}

/* ----------------------------------------------------------------- merge */
t.section('Merging (two computers, offline)');
{
  const A = [{ kind: 'lesson', ref: 'l1', completed: true, best: 0, attempts: 0, first_done_at: 50, updated_at: 50 }, { kind: 'exercise', ref: 'e1', completed: false, best: 40, attempts: 3, updated_at: 60 }];
  const B = [{ kind: 'lesson', ref: 'l1', completed: false, best: 0, attempts: 0, updated_at: 90 }, { kind: 'exercise', ref: 'e1', completed: true, best: 100, attempts: 1, first_done_at: 70, updated_at: 70 }, { kind: 'lesson', ref: 'l2', completed: true, first_done_at: 80, updated_at: 80 }];
  const key = (l) => JSON.stringify(l.map((x) => merge.normItem(x)).sort((a, b) => (a.ref < b.ref ? -1 : 1)));
  const ab = merge.mergeItems(A, B), ba = merge.mergeItems(B, A);
  t.ok('order does not matter (A∪B = B∪A)', key(ab) === key(ba));
  t.ok('merging twice changes nothing', key(merge.mergeItems(ab, B)) === key(ab));
  const e1 = ab.find((x) => x.ref === 'e1'), l1 = ab.find((x) => x.ref === 'l1');
  t.ok('done stays done', l1.completed === true);
  t.ok('best score wins, attempts take the larger count', e1.best === 100 && e1.attempts === 3 && e1.completed);
  t.ok('the first completion time is the earliest', l1.first_done_at === 50);
  t.ok('time: each event counted once', merge.totalSeconds([{ id: 'a', seconds: 30 }, { id: 'b', seconds: 20 }, { id: 'a', seconds: 30 }]) === 50);
  t.ok('position: the newest wins', merge.mergePosition({ ref: 'x', at: 5 }, { ref: 'y', at: 9 }).ref === 'y' && merge.mergePosition({ ref: 'x', at: 9 }, { ref: 'y', at: 5 }).ref === 'x');

  const pack = packs.get('demo');
  const res = progress.applyRemote(UID, pack, { items: [{ kind: 'check', ref: 'u1check', completed: true, first_done_at: 10, updated_at: 10 }], seconds: 9999, position: { ref: 'u1check', at: Date.now() + 1000 } });
  t.ok('what the hub sends is merged in (not marked as unsent)', res.changed.length === 1 && progress.items(UID, 'demo').find((i) => i.kind === 'check' && i.ref === 'u1check').dirty === false);
  t.ok('…and shows in the overview and the player’s state', progress.overview(UID, pack).units[0].check.status === 'done' && JSON.parse(progress.stateForPlayer(UID, pack).keys['demo-state']).lessons.u1check.done === true);
  const pend = progress.pending(UID, 'demo');
  progress.markSynced(UID, 'demo', pend);
  t.ok('after a sync nothing is left unsent', (() => { const p = progress.pending(UID, 'demo'); return !p.items.length && !p.time.length && !p.snapshot; })());
}

/* --------------------------------------------------------------- updater */
t.section('A computer whose clock is wrong');
{
  const { supabaseAdapter } = await import('../src/platform/sync/supabase.js');
  const engine = await import('../src/platform/sync/engine.js');
  const YEAR = 365 * 86400000;
  // the hub's clock says a year ahead of this computer's
  const fetchAhead = async () => new Response('{}', { status: 200, headers: { date: new Date(Date.now() + YEAR).toUTCString(), 'content-type': 'application/json' } });
  const a = supabaseAdapter({ url: 'https://example.invalid', anonKey: 'k' }, { fetch: fetchAhead });
  await a.ping().catch(() => {});
  t.ok('the hub adapter measures how far this clock is from the hub’s', Math.abs(a.clockOffset() - YEAR) < 5000, a.clockOffset());
  engine.useAdapter(a);
  const sk = engine.skew();
  t.ok('…a big difference is corrected, a small one is not', Math.abs(sk - YEAR) < 5000);
  const out = engine.shiftTimes({ position: { ref: 'l1', at: 1000 }, snapshot: { at: 2000, keys: {} }, items: [{ ref: 'x', updated_at: 3000, first_done_at: null }], time: [{ id: 't', at: 4000 }] }, sk);
  const back = engine.shiftTimes(out, -sk);
  t.ok('…times go onto the hub’s clock on the way out and back on the way in', out.position.at === 1000 + sk && back.position.at === 1000 && back.snapshot.at === 2000 && back.items[0].updated_at === 3000 && back.items[0].first_done_at === null && back.time[0].at === 4000);
  engine.useAdapter(null);
}

t.section('Updates (fake GitHub)');
{
  // A fake installed copy, and a release of 9.9.9 made from it
  const install = join(TMP, 'install');
  mkdirSync(join(install, 'server', 'src'), { recursive: true });
  mkdirSync(join(install, 'server', 'data'), { recursive: true });
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'lantern', version: '0.1.0' }));
  writeFileSync(join(install, 'release.json'), '{}');
  writeFileSync(join(install, 'server', 'src', 'index.js'), '// old');
  writeFileSync(join(install, 'old-only.txt'), 'goes away');
  writeFileSync(join(install, 'server', 'data', 'keep.db'), 'MY DATA');
  writeFileSync(join(install, 'server', '.env'), 'SECRET=1');
  const rel = join(TMP, 'rel', 'Lantern');
  mkdirSync(join(rel, 'server', 'src'), { recursive: true });
  writeFileSync(join(rel, 'package.json'), JSON.stringify({ name: 'lantern', version: '9.9.9' }));
  writeFileSync(join(rel, 'release.json'), '{}');
  writeFileSync(join(rel, 'server', 'src', 'index.js'), '// new');
  writeFileSync(join(rel, 'new-only.txt'), 'arrives');
  const zip = join(TMP, 'Lantern.zip');
  const tarBin = process.platform === 'win32' ? join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  spawnSync(tarBin, ['-a', '-c', '-f', zip, '-C', rel, '.'], { windowsHide: true });
  const gh = createServer((req, res) => {
    if (req.url.startsWith('/repos/me/lantern/releases/latest')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: 'v9.9.9', name: 'Lantern 9.9.9', body: '## 9.9.9\n- Brighter', html_url: 'x', assets: [{ name: 'Lantern.zip', size: 1, browser_download_url: 'http://127.0.0.1:' + gh.address().port + '/dl/Lantern.zip' }] }));
    }
    if (req.url === '/dl/Lantern.zip') { res.writeHead(200); return res.end(readFileSync(zip)); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const api = 'http://127.0.0.1:' + gh.address().port;
  const info = await updater.check({ api, repo: 'me/lantern', current: '0.1.0' });
  t.ok('check finds the newer release and its notes', info.available && info.latest === '9.9.9' && /Brighter/.test(info.notes));

  const rows = [];
  const snapshot = (dir) => readdirSync(dir, { recursive: true }).map(String).sort().join('|');
  const before = snapshot(install);
  let rolled = null;
  try {
    await updater.apply({ root: install, dataDir: join(TMP, 'updata'), info, restart: false, log: (r) => rows.push(r), selftest: (d) => (d === install ? { ok: false, error: 'boom' } : { ok: true }) });
  } catch (e) { rolled = e.rolledBack; }
  t.ok('an update that fails after installing is ROLLED BACK', rolled === true);
  t.ok('…every file is exactly as it was', snapshot(install) === before && readFileSync(join(install, 'server', 'src', 'index.js'), 'utf8') === '// old');
  t.ok('…the person’s data and keys were never touched', readFileSync(join(install, 'server', 'data', 'keep.db'), 'utf8') === 'MY DATA' && existsSync(join(install, 'server', '.env')));
  t.ok('…and the log says so', rows[0] && rows[0].status === 'rolled-back');

  let pre = null;
  try { await updater.apply({ root: install, dataDir: join(TMP, 'updata'), info, restart: false, log: (r) => rows.push(r), selftest: () => ({ ok: false, error: 'bad build' }) }); }
  catch (e) { pre = e.rolledBack; }
  t.ok('a release that fails its check BEFORE installing changes nothing', pre === false && snapshot(install) === before);

  const dbh = new DatabaseSync(':memory:');
  const out = await updater.apply({ root: install, dataDir: join(TMP, 'updata'), info, restart: false, log: (r) => rows.push(r), selftest: () => ({ ok: true }), db: dbh });
  t.ok('a good update installs the new version', out.updated && out.to === '9.9.9' && readFileSync(join(install, 'server', 'src', 'index.js'), 'utf8') === '// new');
  t.ok('…removes what the new version no longer has, adds what it has', !existsSync(join(install, 'old-only.txt')) && existsSync(join(install, 'new-only.txt')));
  t.ok('…keeps the person’s data and keys', readFileSync(join(install, 'server', 'data', 'keep.db'), 'utf8') === 'MY DATA' && readFileSync(join(install, 'server', '.env'), 'utf8') === 'SECRET=1');
  t.ok('…backed up the old program first', existsSync(join(out.backup, 'server', 'src', 'index.js')) && readFileSync(join(out.backup, 'server', 'src', 'index.js'), 'utf8') === '// old');
  t.ok('…and logged what is new', rows[rows.length - 1].status === 'installed' && /Brighter/.test(rows[rows.length - 1].notes));
  let dev = false; try { await updater.apply({ root: join(TMP, 'rel'), info, restart: false }); } catch (e) { dev = /development copy/.test(e.message); }
  t.ok('a source checkout (no release.json) never updates itself', dev);
  gh.close();
}

/* ------------------------------------------------------------- ecosystem */
t.section('Ecosystem contract');
{
  const good = eco.makeEvent('lesson.completed', { course: 'cfml', ref: 'u1l1' });
  t.eq('a well-formed event passes the schema', eco.validateEvent(good), []);
  t.ok('an unknown type is refused', eco.validateEvent(Object.assign({}, good, { type: 'nope' })).length > 0);
  t.ok('missing data is refused, naming the field', eco.validateEvent(Object.assign({}, good, { data: { course: 'cfml' } })).some((e) => /data\.ref/.test(e)));
  t.ok('an event from the wrong app is refused', eco.validateEvent(Object.assign({}, good, { source: 'dayspring' })).some((e) => /not sent by dayspring/.test(e)));
  const req = (h) => ({ headers: h });
  t.ok('guard: this computer is allowed', eco.guard(req({ host: '127.0.0.1:4321' }), { port: 4321 }) === null);
  t.ok('guard: another host name (DNS rebinding) is refused', eco.guard(req({ host: 'evil.example:4321' }), { port: 4321 }).status === 421);
  t.ok('guard: a request from another website is refused', eco.guard(req({ host: '127.0.0.1:4321', origin: 'https://evil.example' }), { port: 4321 }).status === 403);
  eco.writePresence({ port: 4321 });
  const pres = eco.readPresence('lantern');
  t.ok('the presence file names the app, port, pid and a token', pres.app === 'lantern' && pres.port === 4321 && pres.pid === process.pid && pres.token.length === 48);
  t.ok('the token opens write calls; nothing else does', eco.tokenOk(req({ 'x-eco-token': pres.token })) && !eco.tokenOk(req({ 'x-eco-token': 'x'.repeat(48) })) && !eco.tokenOk(req({})));
  t.ok('mic.owner is part of the schema (Dayspring hands Lantern the microphone)', eco.validateEvent({ v: 1, id: 'm', type: 'mic.owner', source: 'dayspring', at: Date.now(), data: { app: 'lantern' } }).length === 0);
  t.ok('an app cannot send events to itself', eco.receive(eco.makeEvent('focus.start', {})).ok === false);
  const { defaultsFor } = await import('../src/platform/defaults.js');
  t.ok('voice defaults: Lantern is Will (male), Dayspring is Matilda', defaultsFor('lantern').eleven === 'Will' && defaultsFor('lantern').gender === 'male' && defaultsFor('dayspring').eleven === 'Matilda');
  eco.receive({ v: 1, id: 'x', type: 'dnd', source: 'dayspring', at: Date.now(), data: { on: true } });
  t.ok('Dayspring’s quiet hours make Lantern quiet', eco.quietState().quiet === true);
  eco.receive({ v: 1, id: 'y', type: 'dnd', source: 'dayspring', at: Date.now(), data: { on: false } });
}

/* ------------------------------------------------------- shared AI key */
t.section('Shared AI key');
if (credentials.supported()) {
  // Dayspring saves its AI (the same file format as ecosystem-core)
  credentials.createCredentials('dayspring').write({ provider: 'anthropic', model: 'claude-sonnet-5', keys: { anthropic: 'sk-test-not-real-0000' } });
  const raw = readFileSync(join(process.env.ECOSYSTEM_DIR, 'credentials.bin'));
  t.ok('the shared file is ECO1 + encrypted (the key is not in it)', raw.subarray(0, 4).toString() === 'ECO1' && !raw.toString('latin1').includes('sk-test'));
  const pk = credentials.lantern.peek();
  t.ok('Lantern can see what is shared, without any key', pk.exists && pk.provider === 'anthropic' && pk.hasKeys.anthropic === true && pk.updatedBy === 'dayspring' && !JSON.stringify(pk).includes('sk-test'));
  t.ok('without the person’s yes, Lantern does not read the key', credentials.lantern.read() === null);
  credentials.lantern.allow(true);
  t.ok('with it, it does', credentials.lantern.read().keys.anthropic === 'sk-test-not-real-0000');
  t.ok('…and Dayspring’s own consent is untouched', credentials.lantern.peek().consent.dayspring === true);
  credentials.lantern.clear();
} else t.ok('(DPAPI is Windows-only: skipped)', true);

/* --------------------------------------------------------------- privacy */
t.section('Export and privacy');
{
  const { exportTo } = await import('../../scripts/export.mjs');
  const { scan } = await import('../../scripts/privacy-scan.mjs');
  const terms = join(TMP, 'terms.json');
  // (built from pieces, so this test file does not trip its own scan)
  const WHO = ['Zebulon', 'Quackenbush'].join(' '), TOWN = 'Quack' + 'ville';
  writeFileSync(terms, JSON.stringify({ terms: [WHO], words: [TOWN] }));
  const out = exportTo(join(TMP, 'public'), { quiet: true, termsFile: terms });
  t.ok('the public export passes its privacy scan', out.ok, JSON.stringify(out.hits.slice(0, 5)));
  t.ok('…holds the platform and no course content', existsSync(join(out.target, 'server', 'src', 'index.js')) && !existsSync(join(out.target, 'app', 'cfml')) && !existsSync(join(out.target, 'courses', 'cfml')));
  writeFileSync(join(out.target, 'planted.md'), ['Written by ' + WHO + '.', 'From ' + TOWN + '.', 'key sk-' + 'ant-' + 'a'.repeat(30)].join('\n'));
  const hits = scan(out.target, { termsFile: terms }).hits.map((h) => h.what);
  t.ok('the scan catches a private name, a private word and a key', hits.includes('private term') && hits.includes('private word') && hits.includes('Anthropic key'));
  rmSync(join(out.target, 'planted.md'));
}

db.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* Windows may hold a file */ }
t.done();
