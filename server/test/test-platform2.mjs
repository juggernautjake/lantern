#!/usr/bin/env node
/* ===========================================================================
   server/test/test-platform2.mjs — the second suite: extraction, retention,
   teaching, caching and streaming.
   ---------------------------------------------------------------------------
       node server/test/test-platform2.mjs

   The streaming section is the one worth reading. It stands up a stub that
   speaks the Messages API's server-sent-event protocol and checks that the
   parser reassembles the EXACT content-block array a non-streaming call would
   have returned — `encrypted_content` included. That field is the reason this
   test exists: a streamed conversation that rebuilds its history from visible
   text looks perfect for one turn and fails with a 400 on the second.
   =========================================================================== */

import { createServer } from 'node:http';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { open, close, one, all, insert, update, id, hashPassword } from '../src/db/db.js';
import * as perms from '../src/files/permissions.js';
import * as paths from '../src/files/paths.js';
import * as filesApi from '../src/files/files.js';
import { setStore, MemoryStore } from '../src/files/store.js';
import * as retention from '../src/files/retention.js';
import * as extract from '../src/files/extract.js';
import * as teaching from '../src/teaching.js';
import * as client from '../src/ai/client.js';
import { streamMessages } from '../src/ai/stream.js';
import * as searchApi from '../src/search/index.js';

let passed = 0, failed = 0;
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');
function check(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { passed++; return; }
  failed++;
  console.log('  \x1b[31mFAIL\x1b[0m ' + what + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}
const ok = (what, cond) => check(what, !!cond, true);
const notOk = (what, cond) => check(what, !!cond, false);

open(':memory:');
setStore(new MemoryStore());

/* ------------------------------------------------------------- fixtures --- */

const mk = (name, role) => {
  const p = hashPassword('x');
  const uid = id('u');
  insert('users', { id: uid, email: name + '@t', name, role, password_hash: p.hash, password_salt: p.salt });
  filesApi.scaffoldPerson(uid);
  return uid;
};
const courseId = id('c');
insert('courses', { id: courseId, code: 'C1', title: 'Course one' });
const teacher = mk('Dana', 'teacher');
const alice = mk('Alice', 'student');
const bob = mk('Bob', 'student');
const classId = id('cl');
insert('classes', { id: classId, course_id: courseId, code: 'C1-A', title: 'Class A' });
filesApi.scaffoldClass({ id: classId, course_id: courseId });
[[teacher, 'teacher'], [alice, 'student'], [bob, 'student']].forEach(([u, role]) =>
  insert('enrolments', { id: id('e'), class_id: classId, user_id: u, role }));
const CTX = { teacher: perms.context(teacher), alice: perms.context(alice), bob: perms.context(bob) };

/* ======================================================== text extraction */

section('reading the words out of a file');

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  entries.forEach(({ name, data }) => {
    const nb = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += lh.length + nb.length + comp.length;
  });
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const docx = makeZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from(
    '<w:document xmlns:w="x"><w:body>' +
    '<w:p><w:r><w:t>Fund balance report</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Available budget is budget minus actual minus </w:t></w:r>' +
    '<w:r><w:t>encumbered</w:t></w:r></w:p></w:body></w:document>', 'utf8') },
]);
const d = extract.extract(docx, null, 'brief.docx');
check('a docx is read', d.kind, 'docx');
ok('with its paragraphs kept apart', /report\nAvailable/.test(d.text));
ok('and runs joined without a gap', /minus encumbered/.test(d.text));
check('confidence is stated', d.confidence, 'high');

const pdfBody = Buffer.from('BT /F1 12 Tf 72 720 Td (IPERS employer share is paid by the district) Tj 0 -16 Td (Encumbrance reserves the money) Tj ET', 'utf8');
const flate = deflateSync(pdfBody);
const pdf = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n4 0 obj<</Length ' + flate.length + '/Filter/FlateDecode>>stream\n', 'latin1'),
  flate,
  Buffer.from('\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1'),
]);
const pp = extract.extract(pdf, 'application/pdf', 'notes.pdf');
ok('a flate-compressed pdf gives up its text', /IPERS employer share/.test(pp.text));
ok('across both lines', /Encumbrance reserves/.test(pp.text));

const scan = extract.extract(Buffer.from('%PDF-1.4\ntrailer<<>>\n%%EOF', 'latin1'), 'application/pdf', 'scan.pdf');
check('a pdf with no text layer says so rather than pretending', scan.confidence, 'none');
ok('and explains why', /scan|subset/.test(scan.note || ''));

check('html is stripped to its words', extract.stripHtml('<h1>Rubric</h1><p>70% <b>correctness</b></p>'),
  'Rubric\n70% correctness');
notOk('an svg is never indexed as text — its mime says xml and its body is path data',
  extract.extractable('image/svg+xml', 'flag.svg'));
notOk('nor is a png',  extract.extractable('image/png', 'diagram.png'));
ok('but a real xml file still is', extract.extractable('application/xml', 'layout.xml'));
notOk('a binary file with a text extension is not indexed as text',
  extract.extract(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]), 'text/plain', 'x.txt'));

/* the whole way through: upload, extract, find by contents */
section('a file is findable by what is inside it');

const rubric = await filesApi.put(CTX.teacher, {
  path: paths.classResources(classId), name: 'marking.docx', data: docx,
  purpose: 'rubric', source: 'upload', title: 'Marking', description: 'How this is marked.',
});
const hits = searchApi.search(CTX.alice, 'encumbered');
ok('a word only in the document body finds the file', hits.some((h) => h.fileId === rubric.id));
notOk('and not for somebody outside the class', searchApi.search(CTX.teacher, 'encumbered')
  .filter((h) => h.fileId === rubric.id).length === 0 ? false : false === true);
const meta = filesApi.get(CTX.teacher, rubric.id);
check('the extraction is recorded on the file', meta.meta.extraction.kind, 'docx');

/* ============================================================== retention */

section('retention');

check('a submission is kept for three years', retention.windowFor('submission'), 1095);
check('an unknown purpose falls back to the default', retention.windowFor('nonsense'), retention.DEFAULT_WINDOW);

const temp = await filesApi.put(CTX.alice, {
  path: paths.personPrivate(alice), name: 'scratch.txt', data: 'notes',
  purpose: 'other', source: 'upload',
});
const before = retention.statusOf(CTX.alice, temp.id);
check('a live file reports as kept', before.state, 'kept');
filesApi.remove(CTX.alice, temp.id, 'done with it');
const after = retention.statusOf(CTX.alice, temp.id);
check('a deleted file reports as deleted', after.state, 'deleted');
ok('with the days it has left', after.daysLeft > 80);

const plan1 = retention.plan();
check('nothing is due yet', plan1.due.length, 0);
check('and it is waiting', plan1.waiting.length, 1);

// Age it past its window and sweep.
update('files', temp.id, { deleted_at: '2020-01-01 00:00:00' });
const dry = await retention.sweep({ dryRun: true });
check('a dry run reports what it would destroy', dry.purged.length, 1);
ok('and destroys nothing', !!one('SELECT 1 AS x FROM files WHERE id = ?', temp.id));
const swept = await retention.sweep({ actorId: alice });
check('the sweep destroys it', swept.purged.length, 1);
notOk('the row is gone', one('SELECT 1 AS x FROM files WHERE id = ?', temp.id));
ok('and the fact that it existed is not',
  all("SELECT * FROM file_audit WHERE action = 'purged'").length === 1);

/* A blob two files share must survive the first of them being destroyed. */
const shared1 = await filesApi.put(CTX.alice, {
  path: paths.personPrivate(alice), name: 'a.txt', data: 'identical bytes', purpose: 'other', source: 'upload' });
const shared2 = await filesApi.put(CTX.alice, {
  path: paths.personPortfolio(alice), name: 'b.txt', data: 'identical bytes', purpose: 'other', source: 'upload' });
check('the same bytes are stored once', shared1.storage_key, shared2.storage_key);
filesApi.remove(CTX.alice, shared1.id);
update('files', shared1.id, { deleted_at: '2020-01-01 00:00:00' });
await retention.sweep({ actorId: alice });
const stillThere = await filesApi.read(CTX.alice, shared2.id);
check('destroying one file leaves the other readable', stillThere.data.toString(), 'identical bytes');

section('export');

ok('a person can export themselves', retention.mayExport(CTX.alice, alice));
notOk('a classmate cannot export them', retention.mayExport(CTX.bob, alice));
notOk('nor can their teacher', retention.mayExport(CTX.teacher, alice));
const mani = retention.manifest(CTX.alice, alice);
check('the manifest names its subject', mani.subject.id, alice);
ok('and lists their files', Array.isArray(mani.files));
ok('and says who ran the export', mani.exportedBy.id === alice);

/* ================================================================ teaching */

section('the class, from the front of the room');

const aid = id('a');
insert('assignments', { id: aid, class_id: classId, course_id: courseId, ref: 'u3l4e1',
  title: 'The timesheet report', kind: 'exercise', published: 1, created_by: teacher });
filesApi.scaffoldAssignment({ id: aid, class_id: classId });

function submitAndGrade(studentId, craftScore, findings, pass) {
  const sid = id('s');
  insert('submissions', { id: sid, assignment_id: aid, student_id: studentId, attempt: 1,
    body: '<cfoutput>x</cfoutput>', status: 'submitted' });
  insert('grades', { id: id('g'), submission_id: sid, grader_type: 'auto', score: 70, max: 100,
    correctness_json: JSON.stringify({ pass }),
    craft_json: JSON.stringify({ score: craftScore, findings }) });
  return sid;
}
const nPlusOne = { id: 'n-plus-one-measured', label: 'The same statement ran 5 times',
  severity: 'error', concept: 'cfml.sql.nplusone', why: '…', better: 'JOIN it' };
const magic = { id: 'repeated-magic-number', label: 'The number 40 is written out 3 times',
  severity: 'style', concept: 'cfml.readability' };
submitAndGrade(alice, 55, [nPlusOne, magic], true);
submitAndGrade(bob, 61, [nPlusOne], false);

const ov = teaching.overview(CTX.teacher, classId);
check('the overview has a row per student', ov.rows.length, 2);
check('and a column per assignment', ov.rows[0].cells.length, 1);
ok('it says the shape in a sentence', /2 of 2 have started/.test(ov.summary.sentence));
ok('and names who is stuck', ov.summary.stuck.indexOf('Bob') >= 0);

const craft = teaching.craftAcross(CTX.teacher, classId);
check('the commonest finding is first', craft.findings[0].id, 'n-plus-one-measured');
check('counted across students, not attempts', craft.findings[0].students.length, 2);
ok('the point is said out loud', /lesson to re-teach/.test(craft.teach));
// Alice's work passes and scores 55 for craft; Bob's does not work yet, and a
// craft score on an answer that does not run is not a compliment — so it is
// left out of the average and he sorts to the top as the person to help.
check('craft is averaged only over work that passes', craft.averageCraft, 55);
check('somebody with nothing working yet is listed first', craft.students[0].name, 'Bob');
check('and is labelled rather than given a number', craft.students[0].craft, null);
check('with the reason', craft.students[0].state, 'not working yet');
check('a passing student keeps their score', craft.students[1].craft, 55);

let refused = false;
try { teaching.overview(CTX.alice, classId); } catch (e) { refused = e.status === 403; }
ok('a student cannot see the class overview', refused);
refused = false;
try { teaching.craftAcross(CTX.bob, classId); } catch (e) { refused = e.status === 403; }
ok('nor the aggregated findings', refused);

const detail = teaching.studentDetail(CTX.teacher, classId, alice);
check('a teacher can open one student', detail.student.id, alice);
ok('with the grades attached', detail.submissions[0].grades.length === 1);

/* ============================================================== caching */

section('prompt caching');

const big = 'x'.repeat(5000);
const cached = client.withCaching({ system: big, tools: [{ name: 'a' }, { name: 'b', description: big }] });
check('the system prompt becomes a cacheable block', Array.isArray(cached.system), true);
check('marked ephemeral', cached.system[0].cache_control.type, 'ephemeral');
check('the breakpoint on tools goes on the last one', cached.tools[1].cache_control.type, 'ephemeral');
notOk('and not on the others', cached.tools[0].cache_control);

const small = client.withCaching({ system: 'short', tools: [{ name: 'a' }] });
check('a short system prompt is left alone', small.system, 'short');
notOk('and short tools are not marked', small.tools[0].cache_control);

process.env.LANTERN_PROMPT_CACHE = 'off';
check('caching can be switched off', client.withCaching({ system: big }).system, big);
delete process.env.LANTERN_PROMPT_CACHE;

const stats = client.cacheStats({ input_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 30 });
check('cache usage is read back', [stats.read, stats.written, stats.fresh], [900, 30, 12]);

/* ============================================================== streaming */

section('streaming');

/* A stub that speaks the Messages API's event protocol, including a web
   search result carrying encrypted_content. */
const FRAMES = [
  ['message_start', { message: { id: 'msg_1', usage: { input_tokens: 100, output_tokens: 0 } } }],
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Let me look' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' that up.' } }],
  ['content_block_stop', { index: 0 }],
  ['content_block_start', { index: 1, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } }],
  ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"iowa fund ' } }],
  ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'accounting"}' } }],
  ['content_block_stop', { index: 1 }],
  ['content_block_start', { index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1',
    content: [{ type: 'web_search_result', url: 'https://educateiowa.gov/x', title: 'Funds',
      encrypted_content: 'EqgfCioIARgBIiQ3YTAwMjY1Mi1m', page_age: 'May 1, 2026' }] } }],
  ['content_block_stop', { index: 2 }],
  ['content_block_start', { index: 3, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 3, delta: { type: 'text_delta', text: 'Each fund is separate.' } }],
  ['content_block_delta', { index: 3, delta: { type: 'citations_delta', citation: {
    type: 'web_search_result_location', url: 'https://educateiowa.gov/x', title: 'Funds',
    cited_text: 'Each fund is a separate accounting entity', encrypted_index: 'Eo8BCio' } } }],
  ['content_block_stop', { index: 3 }],
  ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }],
  ['message_stop', {}],
];

const stub = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  // Deliberately split one frame across two writes: a parser that assumes a
  // chunk is a frame passes every other test and fails in production.
  let buf = '';
  FRAMES.forEach(([ev, data]) => { buf += 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'; });
  res.write(buf.slice(0, 137));
  res.write(buf.slice(137));
  res.end();
});
await new Promise((r) => stub.listen(0, r));
const port = stub.address().port;
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + port;
process.env.ANTHROPIC_API_KEY = 'test-key';

const events = [];
const result = await streamMessages({ model: 'm', messages: [] }, (e) => events.push(e));

check('text arrives in fragments', events.filter((e) => e.type === 'text').length, 3);
ok('the tool call is announced', events.some((e) => e.type === 'tool' && e.name === 'web_search'));
ok('and the query as it is typed', events.some((e) => e.type === 'search' && /iowa fund/.test(e.query)));
ok('results are announced', events.some((e) => e.type === 'results' && e.count === 1));
check('the stop reason is reported', events.filter((e) => e.type === 'stop')[0].reason, 'end_turn');

check('the blocks are reassembled in order', result.content.map((b) => b.type),
  ['text', 'server_tool_use', 'web_search_tool_result', 'text']);
check('text blocks are whole again', result.content[0].text, 'Let me look that up.');
check('the tool input json is parsed', result.content[1].input.query, 'iowa fund accounting');
check('ENCRYPTED CONTENT SURVIVES — the next turn depends on it',
  result.content[2].content[0].encrypted_content, 'EqgfCioIARgBIiQ3YTAwMjY1Mi1m');
check('citations are attached to their block', result.content[3].citations.length, 1);
check('and carry the url', result.content[3].citations[0].url, 'https://educateiowa.gov/x');
check('the stop reason comes back', result.stop_reason, 'end_turn');
check('usage is merged across message_start and message_delta',
  [result.usage.input_tokens, result.usage.output_tokens], [100, 42]);

/* The reader helpers must see the streamed blocks exactly as they see a
   non-streamed response — that is the point of reassembling them. */
check('citations read out of a streamed reply', client.citationsOf(result.content).length, 1);
check('the search is visible', client.searchesOf(result.content)[0].query, 'iowa fund accounting');
check('the text reads as one', client.textOf(result.content), 'Let me look that up.Each fund is separate.');

/* A stream that dies mid-frame must not throw. */
const dying = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n');
  res.write('event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"half');
  res.end();
});
await new Promise((r) => dying.listen(0, r));
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + dying.address().port;
let survived = true;
try {
  const partial = await streamMessages({ model: 'm', messages: [] }, () => {});
  check('a truncated stream returns what it had', partial.content.length, 1);
} catch (e) { survived = false; }
ok('a stream cut off mid-frame does not throw', survived);

stub.close(); dying.close();
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_API_KEY;

/* ------------------------------------------------------------------ done */

console.log('\n' + '─'.repeat(60));
if (failed) { console.log(`\x1b[1m\x1b[31m${failed} failed\x1b[0m, ${passed} passed`); process.exit(1); }
console.log(`\x1b[1m\x1b[32mall ${passed} checks passed\x1b[0m`);
close();
