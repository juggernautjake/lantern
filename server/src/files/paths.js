/* ===========================================================================
   server/src/files/paths.js — the virtual path scheme.
   ---------------------------------------------------------------------------
   A filing system for a school fails in one of two ways. Either it is a free
   folder tree, and within a term nobody can find last year's rubric because
   four teachers invented four hierarchies. Or it is rigid, and the first real
   need it did not anticipate has to live in a folder called "misc".

   This scheme takes the first branch away and keeps the second one open. The
   shape of a path is fixed and derived from the platform's own objects — a
   class has one assignments folder, an assignment has one submissions folder,
   a student has exactly one submission folder inside it — so nothing has to be
   organised by hand and nothing can be misfiled. Anything that genuinely does
   not belong to a course, a class or a person goes under /shared, which is the
   one place free structure is allowed.

       /courses/{courseId}/resources          material for every running
       /classes/{classId}/resources           material for this class only
       /classes/{classId}/assignments/{aid}/brief
       /classes/{classId}/assignments/{aid}/submissions/{userId}
       /people/{userId}/private               nobody else, ever
       /people/{userId}/portfolio             what they choose to show
       /shared/{folderId}                     free structure, explicit grants
       /system/ai/{threadId}                  what the assistant produced

   Because a folder's path encodes what it is, permission questions are
   answered from the path plus the roster — see permissions.js — and never
   from a stored copy of who can see what, which is the thing that goes stale.
   =========================================================================== */

export const ROOTS = ['courses', 'classes', 'people', 'shared', 'system'];

/* One path segment, with no way out of it: no separator, no traversal, no
   whitespace, no control characters. Hyphens survive, because course codes
   are full of them. */
const clean = (s) => (String(s === undefined || s === null ? '' : s)
  .trim()
  .replace(/\s+/g, '-')
  .replace(/[^\w.-]+/g, '-')
  .replace(/\.{2,}/g, '.')
  .replace(/^[.-]+|[.-]+$/g, '')
  .slice(0, 64)) || 'x';

export const courseResources = (courseId) => `/courses/${clean(courseId)}/resources`;
export const classResources = (classId) => `/classes/${clean(classId)}/resources`;
export const classAssignments = (classId) => `/classes/${clean(classId)}/assignments`;
export const assignmentBrief = (classId, aid) => `${classAssignments(classId)}/${clean(aid)}/brief`;
export const assignmentSubmissions = (classId, aid) => `${classAssignments(classId)}/${clean(aid)}/submissions`;
export const studentSubmission = (classId, aid, userId) =>
  `${assignmentSubmissions(classId, aid)}/${clean(userId)}`;
export const personPrivate = (userId) => `/people/${clean(userId)}/private`;
export const personPortfolio = (userId) => `/people/${clean(userId)}/portfolio`;
export const shared = (folderId) => `/shared/${clean(folderId)}`;
export const aiArtifacts = (threadId) => `/system/ai/${clean(threadId)}`;

/* Every ancestor of a path, nearest last:
     /classes/c1/assignments/a1  ->  ['/classes', '/classes/c1', '/classes/c1/assignments'] */
export function ancestors(path) {
  const parts = String(path).split('/').filter(Boolean);
  const out = [];
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) { acc += '/' + parts[i]; out.push(acc); }
  return out;
}

export function parentOf(path) {
  const a = ancestors(path);
  return a.length ? a[a.length - 1] : null;
}

export function nameOf(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/* What a path IS, read straight off it. Returns
     { root, kind, courseId, classId, assignmentId, userId, sharedId, threadId }
   with only the fields that path actually carries. An unrecognised path gets
   kind 'unknown', which every permission rule treats as "no derived access". */
export function describe(path) {
  const p = String(path || '');
  const parts = p.split('/').filter(Boolean);
  const out = { path: p, root: parts[0] || '', kind: 'unknown' };
  if (!parts.length) return Object.assign(out, { kind: 'root' });

  switch (parts[0]) {
    case 'courses':
      out.courseId = parts[1];
      if (parts[2] === 'resources') out.kind = 'course-resources';
      break;
    case 'classes':
      out.classId = parts[1];
      if (parts[2] === 'resources') out.kind = 'class-resources';
      else if (parts[2] === 'assignments') {
        out.assignmentId = parts[3];
        if (parts[4] === 'brief') out.kind = 'assignment-brief';
        else if (parts[4] === 'submissions') {
          out.kind = parts[5] ? 'student-work' : 'submissions';
          if (parts[5]) out.userId = parts[5];
        }
      }
      break;
    case 'people':
      out.userId = parts[1];
      if (parts[2] === 'private') out.kind = 'personal';
      else if (parts[2] === 'portfolio') out.kind = 'portfolio';
      break;
    case 'shared':
      out.sharedId = parts[1];
      out.kind = 'shared';
      break;
    case 'system':
      if (parts[1] === 'ai') { out.threadId = parts[2]; out.kind = 'ai-artifacts'; }
      break;
    default: break;
  }
  return out;
}

/* A file name that cannot escape its folder or collide with the platform's
   own naming. Extensions are preserved; everything else is flattened. */
export function safeName(name) {
  const raw = String(name || 'file').replace(/^.*[\\/]/, '').trim();
  const dot = raw.lastIndexOf('.');
  const stem = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^\w.\- ]+/g, '-').replace(/\s+/g, ' ').trim();
  const ext = (dot > 0 ? raw.slice(dot + 1) : '').replace(/[^\w]+/g, '').toLowerCase();
  const base = (stem || 'file').slice(0, 120);
  return ext ? base + '.' + ext.slice(0, 12) : base;
}

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/* Enough of a MIME table to be useful, and honest about the rest. */
const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  cfm: 'text/x-coldfusion', cfc: 'text/x-coldfusion', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', ico: 'image/x-icon',
  sql: 'application/sql', zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
};
export const mimeFor = (name) => MIME[extOf(name)] || 'application/octet-stream';
export const isImage = (mime) => /^image\//.test(String(mime || ''));
export const isText = (mime) => /^text\/|json|xml|sql|javascript/.test(String(mime || ''));
