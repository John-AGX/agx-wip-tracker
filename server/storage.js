// Storage abstraction — uploads land here regardless of where the bytes
// physically live. Today: local disk on a Railway volume mount. Tomorrow:
// Cloudflare R2. The route layer talks to a single `storage` object
// without caring which one is running.
//
// Configuration via env:
//   STORAGE_BACKEND     — 'local' (default) or 'r2'
//   UPLOAD_DIR          — root path for local backend (default ./uploads;
//                         set to /data/uploads on Railway with a volume)
//   UPLOAD_PUBLIC_BASE  — URL prefix for serving local files (default /uploads)
//   R2_*                — added later when we cut over

const fs = require('fs');
const path = require('path');

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
}

// Stubbed R2 backend — wire up later with @aws-sdk/client-s3 (R2 is
// S3-compatible). Calling .put() throws so a misconfigured deploy fails
// loudly instead of silently dropping uploads.
class R2Storage extends StorageAdapter {
  async put() { throw new Error('R2 backend not yet implemented — set STORAGE_BACKEND=local'); }
  async delete() { throw new Error('R2 backend not yet implemented'); }
}

function buildStorage() {
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
  if (backend === 'r2') return new R2Storage();
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
storage.localRoot = (process.env.STORAGE_BACKEND || 'local').toLowerCase() === 'local'
  ? (process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'))
  : null;
storage.publicBase = process.env.UPLOAD_PUBLIC_BASE || '/uploads';

module.exports = { storage, StorageAdapter, LocalDiskStorage, R2Storage };
