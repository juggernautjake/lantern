/* ===========================================================================
   server/src/files/store.js — where the bytes live.
   ---------------------------------------------------------------------------
   Content-addressed: the storage key is the SHA-256 of the contents, so the
   same file uploaded by thirty students is stored once, a re-upload of an
   unchanged file is free, and a corrupted read is detectable rather than
   silent. The database row is the thing with a name, an owner and a history;
   the blob underneath it is anonymous.

   Two adapters ship. LocalStore writes under server/data/blobs and is what
   runs on a laptop or a single box. S3Store is the same four methods against
   any S3-compatible endpoint and is what runs when there is more than one
   box. Nothing above this file knows which is in use.
   =========================================================================== */

import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../platform/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/* --------------------------------------------------------------- local --- */

export class LocalStore {
  constructor(root) {
    this.root = root || paths.blobs();
    mkdirSync(this.root, { recursive: true });
  }

  // ab/cdef… — two-character fan-out, because a directory with a million
  // entries in it is a directory no tool wants to open.
  _path(key) { return join(this.root, key.slice(0, 2), key.slice(2)); }

  async put(buf) {
    const key = sha256(buf);
    const p = this._path(key);
    if (!existsSync(p)) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, buf);
    }
    return { key, size: buf.length, sha256: key };
  }

  async get(key) {
    const p = this._path(key);
    if (!existsSync(p)) return null;
    const buf = readFileSync(p);
    // Content addressing is only worth having if it is checked.
    if (sha256(buf) !== key) throw new Error('Stored blob ' + key + ' does not match its hash. It is corrupt.');
    return buf;
  }

  async head(key) {
    const p = this._path(key);
    return existsSync(p) ? { key, size: statSync(p).size } : null;
  }

  // Only ever called when no file row references the blob any more.
  async remove(key) {
    const p = this._path(key);
    if (existsSync(p)) unlinkSync(p);
    return true;
  }
}

/* ------------------------------------------------------------------ s3 --- */
/* Signature Version 4, written out rather than pulled in. It is about sixty
   lines and it removes the only dependency this server would otherwise have. */

export class S3Store {
  constructor(cfg) {
    const c = cfg || {};
    this.bucket = c.bucket || process.env.S3_BUCKET;
    this.region = c.region || process.env.S3_REGION || 'us-east-1';
    this.endpoint = (c.endpoint || process.env.S3_ENDPOINT ||
      `https://s3.${this.region}.amazonaws.com`).replace(/\/+$/, '');
    this.accessKey = c.accessKey || process.env.S3_ACCESS_KEY_ID;
    this.secretKey = c.secretKey || process.env.S3_SECRET_ACCESS_KEY;
    this.prefix = (c.prefix || process.env.S3_PREFIX || 'blobs/').replace(/^\/+/, '');
    if (!this.bucket) throw new Error('S3Store needs a bucket (S3_BUCKET).');
    if (!this.accessKey || !this.secretKey) throw new Error('S3Store needs credentials.');
  }

  _url(key) { return `${this.endpoint}/${this.bucket}/${this.prefix}${key}`; }

  async put(buf) {
    const key = sha256(buf);
    if (await this.head(key)) return { key, size: buf.length, sha256: key };
    const res = await this._signedFetch('PUT', key, buf);
    if (!res.ok) throw new Error('S3 PUT failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return { key, size: buf.length, sha256: key };
  }

  async get(key) {
    const res = await this._signedFetch('GET', key, null);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('S3 GET failed: ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== key) throw new Error('Stored blob ' + key + ' does not match its hash.');
    return buf;
  }

  async head(key) {
    const res = await this._signedFetch('HEAD', key, null);
    if (!res.ok) return null;
    return { key, size: Number(res.headers.get('content-length') || 0) };
  }

  async remove(key) {
    const res = await this._signedFetch('DELETE', key, null);
    return res.ok || res.status === 404;
  }

  async _signedFetch(method, key, body) {
    const url = new URL(this._url(key));
    const payloadHash = body ? sha256(body) : sha256(Buffer.alloc(0));
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);

    const canonicalHeaders =
      `host:${url.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      method, url.pathname, url.search.slice(1),
      canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonicalRequest))].join('\n');

    const hmac = (k, v) => createHmac('sha256', k).update(v).digest();
    let signing = hmac('AWS4' + this.secretKey, date);
    signing = hmac(signing, this.region);
    signing = hmac(signing, 's3');
    signing = hmac(signing, 'aws4_request');
    const signature = createHmac('sha256', signing).update(stringToSign).digest('hex');

    return fetch(url, {
      method,
      body: body || undefined,
      headers: {
        host: url.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
  }
}

/* ---------------------------------------------------------------- memory --- */
/* For the test suite, so no test ever touches the disk. */

export class MemoryStore {
  constructor() { this.blobs = new Map(); }
  async put(buf) { const key = sha256(buf); this.blobs.set(key, Buffer.from(buf)); return { key, size: buf.length, sha256: key }; }
  async get(key) { return this.blobs.has(key) ? this.blobs.get(key) : null; }
  async head(key) { return this.blobs.has(key) ? { key, size: this.blobs.get(key).length } : null; }
  async remove(key) { return this.blobs.delete(key); }
}

/* ---------------------------------------------------------------- choose --- */

let current = null;
export function store() {
  if (current) return current;
  current = process.env.S3_BUCKET ? new S3Store() : new LocalStore();
  return current;
}
export function setStore(s) { current = s; return s; }
