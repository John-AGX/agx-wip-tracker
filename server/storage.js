// Storage abstraction — uploads land here regardless of where the bytes
// physically live. The route layer talks to a single `storage` object
// without caring which backend is running.
//
// Configuration via env:
//   STORAGE_BACKEND     — 'local' (default) or 'r2'
//   UPLOAD_DIR          — root path for local backend (default ./uploads;
//                         set to /data/uploads on Railway with a volume)
//   UPLOAD_PUBLIC_BASE  — URL prefix for serving local files (default /uploads)
//
// R2 backend (Cloudflare R2 — S3-compatible object storage):
//   R2_ACCOUNT_ID         — Cloudflare account id
//   R2_ACCESS_KEY_ID      — R2 API token's access key id
//   R2_SECRET_ACCESS_KEY  — R2 API token's secret (set in Railway env, NOT in code)
//   R2_BUCKET             — bucket name (e.g. 'project86-attachments')
//   R2_PUBLIC_BASE        — public custom-domain URL prefix
//                           (e.g. 'https://attachments.project86.net')

const fs = require('fs');
const path = require('path');
const { finished } = require('stream');

class StorageAdapter {
  /**
   * Upload a Buffer under the given key, return the public URL clients use
   * to fetch it. `contentType` is preserved when the backend supports it.
   */
  async put(/* key, buffer, contentType */) { throw new Error('not implemented'); }
  /** Idempotent — must not throw if the key is already gone. */
  async delete(/* key */) { throw new Error('not implemented'); }
}

// Local disk backend. Writes under UPLOAD_DIR and exposes the same path under
// UPLOAD_PUBLIC_BASE via Express static middleware (wired in server/index.js).
class LocalDiskStorage extends StorageAdapter {
  constructor(rootPath, publicBase) {
    super();
    this.rootPath = rootPath;
    this.publicBase = publicBase;
  }
  _full(key) { return path.join(this.rootPath, key); }
  async put(key, buffer /*, contentType */) {
    const full = this._full(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, buffer);
    return this.publicBase + '/' + key.split(path.sep).join('/');
  }
  async delete(key) {
    try { await fs.promises.unlink(this._full(key)); } catch (e) { /* idempotent */ }
  }
  // Read a previously-uploaded file's bytes back out. Used by backfill
  // jobs (e.g., re-extracting PDF text from older attachments).
  async getBuffer(key) {
    return fs.promises.readFile(this._full(key));
  }
  // Open a stored file to send on without holding it: { stream, size }. Used by
  // the crew link's takeoff door, which needs no login — reading a 25 MB file
  // whole there would hold one copy per download in flight. The size comes
  // from the SAME open descriptor the stream reads, so a file replaced between
  // the stat and the read cannot report one length and send another.
  async getStream(key) {
    const handle = await fs.promises.open(this._full(key), 'r');
    try {
      const st = await handle.stat();
      // autoClose (the default) gives the descriptor back when the stream ends
      // or is destroyed — including a stream destroyed before it was ever read,
      // which is what the crew link's size-mismatch refusal does
      // (test/storage-get-stream.test.js holds each way it can stop).
      return { stream: handle.createReadStream(), size: st.size };
    } catch (e) {
      await handle.close().catch(() => {});
      throw e;
    }
  }
}

// A body the SDK has wrapped around the HTTP response, tied back to it.
//
// clientConfig keeps GetObject from being wrapped at all. This is the second
// half, for a wrapper that arrives anyway — a caller that sets ChecksumMode, an
// SDK whose default moves, another middleware built the same way. The SDK's
// wrappers keep the response they read as `.source` and pipe it in, and a pipe
// carries neither teardown nor failure across:
//   * the wrapper destroyed (a reader gone, a refusal, a for-await that threw)
//     -> the response is destroyed with it, which closes its socket. A
//     response already read to its end is left to the agent: destroying a
//     complete IncomingMessage does not touch the socket, so a finished read
//     still gives its keep-alive connection back.
//   * the response failing, or closing before its end -> the wrapper is
//     destroyed with that error, so whoever reads it sees the failure instead
//     of waiting on an end that is never coming.
// A plain body (no `.source`) is handed back untouched.
function tieToResponse(body) {
  const inner = body && body.source;
  if (!inner || inner === body || typeof inner.destroy !== 'function' || typeof inner.on !== 'function') {
    return body;
  }
  const letGo = () => { if (!inner.destroyed) inner.destroy(); };
  if (body.destroyed) letGo();
  else body.once('close', letGo);
  finished(inner, (err) => {
    if (err && !body.destroyed) body.destroy(err);
  });
  return body;
}

// Cloudflare R2 backend. R2 speaks the S3 API, so we use @aws-sdk/client-s3
// pointed at R2's endpoint (https://<account-id>.r2.cloudflarestorage.com).
// Public reads are served via the bucket's bound custom domain
// (R2_PUBLIC_BASE), which makes <img src="..."> just work without signed
// URLs. The S3 client only handles writes + deletes.
class R2Storage extends StorageAdapter {
  constructor(opts) {
    super();
    // Lazy-required so a 'local' deploy doesn't pay the cost of loading
    // the AWS SDK or fail boot if @aws-sdk/client-s3 isn't installed yet.
    var awsSdk;
    try {
      awsSdk = require('@aws-sdk/client-s3');
    } catch (e) {
      throw new Error('@aws-sdk/client-s3 not installed — run `npm install` before booting with STORAGE_BACKEND=r2');
    }
    this._S3Client = awsSdk.S3Client;
    this._PutObjectCommand = awsSdk.PutObjectCommand;
    this._DeleteObjectCommand = awsSdk.DeleteObjectCommand;
    this._GetObjectCommand = awsSdk.GetObjectCommand;

    // Validate the env config up front so a missing var fails at boot
    // instead of on the first upload.
    ['accountId', 'accessKeyId', 'secretAccessKey', 'bucket', 'publicBase'].forEach(function(k) {
      if (!opts[k]) throw new Error('R2 storage missing required option: ' + k);
    });

    this.bucket = opts.bucket;
    // Normalize publicBase: strip trailing slash, prepend https:// if
    // the env var was set without a scheme. A bare hostname like
    // 'attachments.project86.net' would otherwise produce relative
    // URLs that the browser resolves under the AGX origin, 404ing.
    var pb = opts.publicBase.replace(/\/$/, '');
    if (!/^https?:\/\//i.test(pb)) pb = 'https://' + pb;
    this.publicBase = pb;
    this.client = new this._S3Client(R2Storage.clientConfig(opts));
  }

  // The S3Client options. A static so a test can build the SAME client against
  // a local endpoint (test/storage-get-stream.test.js) — only the endpoint and
  // the transport are swapped there, never the checksum mode.
  //
  // responseChecksumValidation: 'WHEN_REQUIRED'. The SDK default
  // (WHEN_SUPPORTED) asks for checksum mode on every GetObject, and when R2
  // answers with an x-amz-checksum-crc32 header the body handed back is not the
  // HTTP response but @smithy/util-stream's ChecksumStream, a Duplex the
  // response is piped into. That wrapper has no _destroy: destroying it only
  // unpipes, and the IncomingMessage underneath — never read to its end, never
  // destroyed — keeps its keep-alive socket out of the pool, paused, forever.
  // The agent allows 50 sockets. So fifty downloads cancelled on the crew link
  // (a closed tab, a size refusal) held all fifty, and every R2 call in the
  // process after that — uploads, getBuffer, other tenants' downloads — waited
  // on a socket that was never coming back. The same wrapper also never
  // forwards an error from the response, so a reset mid-read left its reader
  // waiting on an end that never came.
  //
  // WHEN_REQUIRED means GetObject is not asked for checksum mode, so the body
  // is the IncomingMessage itself, whose destroy closes its socket. What that
  // gives up is a CRC over bytes that already arrived over TLS, and the
  // streaming read gains little from that CRC anyway: it is checked only once
  // the last byte has been read, when the file has already gone out to the
  // crew. Uploads are unchanged — this names the
  // RESPONSE check, and requestChecksumCalculation (the CRC32 sent with
  // PutObject) keeps its default. DeleteObject carries no checksum either way.
  static clientConfig(opts) {
    return {
      region: 'auto', // R2 ignores region but the SDK demands one
      endpoint: 'https://' + opts.accountId + '.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey
      },
      responseChecksumValidation: 'WHEN_REQUIRED'
    };
  }

  async put(key, buffer, contentType) {
    await this.client.send(new this._PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream'
    }));
    // Public URL via the bound custom domain. Same shape as the local
    // backend's return so the route layer doesn't branch.
    return this.publicBase + '/' + key.split(path.sep).join('/');
  }

  async delete(key) {
    try {
      await this.client.send(new this._DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      }));
    } catch (e) {
      // Idempotent — a 404 on delete is fine (key already gone).
      if (e && e.$metadata && e.$metadata.httpStatusCode === 404) return;
      // Anything else (auth failure, network) — log but don't throw,
      // the caller doesn't have a meaningful recovery path here.
      console.warn('[r2.delete]', key, e && e.message);
    }
  }

  // Read bytes back. Used by backfill jobs (e.g. re-extracting PDF text
  // from older attachments). Streams in S3 SDK are Node streams; we
  // collect into a single Buffer to match the LocalDiskStorage signature.
  async getBuffer(key) {
    const res = await this.client.send(new this._GetObjectCommand({
      Bucket: this.bucket,
      Key: key
    }));
    const body = tieToResponse(res.Body);
    if (!body) throw new Error('R2 getBuffer: empty body for key ' + key);
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }

  // The streaming read (see LocalDiskStorage.getStream): the S3 body is
  // already a Node stream, handed on uncollected, with the length R2 reports
  // for the object — null when it reports none. Destroying it lets the R2
  // connection go (see clientConfig and tieToResponse).
  async getStream(key) {
    const res = await this.client.send(new this._GetObjectCommand({
      Bucket: this.bucket,
      Key: key
    }));
    const body = tieToResponse(res.Body);
    if (!body) throw new Error('R2 getStream: empty body');
    const size = res.ContentLength == null ? null : Number(res.ContentLength);
    return { stream: body, size: Number.isFinite(size) ? size : null };
  }
}

function buildStorage() {
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
  if (backend === 'r2') {
    return new R2Storage({
      accountId: process.env.R2_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      bucket: process.env.R2_BUCKET,
      publicBase: process.env.R2_PUBLIC_BASE
    });
  }
  // Default: local disk. Falls back to a project-relative path so dev
  // works without any volume setup; production should set UPLOAD_DIR to
  // the mounted volume path.
  const rootPath = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const publicBase = process.env.UPLOAD_PUBLIC_BASE || '/uploads';
  // Make sure the dir exists at boot so the first upload doesn't race a
  // mkdir. Sync is fine here — runs once on startup.
  try { fs.mkdirSync(rootPath, { recursive: true }); } catch (e) { /* OK */ }
  return new LocalDiskStorage(rootPath, publicBase);
}

const storage = buildStorage();

// Expose a couple of metadata bits the static-file middleware needs.
// Only the local backend needs Express to serve files from disk; R2
// serves directly via its bound custom domain, so localRoot stays null
// and the static middleware can skip mounting.
const _backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
storage.localRoot = _backend === 'local'
  ? (process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'))
  : null;
storage.publicBase = _backend === 'r2'
  ? (process.env.R2_PUBLIC_BASE || '')
  : (process.env.UPLOAD_PUBLIC_BASE || '/uploads');
storage.backend = _backend;

module.exports = { storage, StorageAdapter, LocalDiskStorage, R2Storage };
