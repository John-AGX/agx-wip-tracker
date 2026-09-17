// Idempotent uploads (1.29): server/services/upload-dedupe.js with a fake db
// and a fake storage.
//   * only a well-formed upload_id is used; anything else is ignored;
//   * the lookup is org-predicated and asks nothing when the org or the id is
//     missing;
//   * only a unique violation on uq_attachments_client_upload is a dedupe
//     race, not any 23505;
//   * discarding the just-stored keys never throws.
// Each rule is then removed from a temp copy and shown to fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../server/services/upload-dedupe');

const SRC = path.join(__dirname, '..', 'server', 'services', 'upload-dedupe.js');
const made = [];
afterAll(() => { for (const p of made) { try { fs.unlinkSync(p); } catch (_) {} } });

function mutant(find, replace) {
  const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(find).length !== 2) throw new Error('anchor not found');
  const p = path.join(os.tmpdir(), '_p86_dedupe_' + process.pid + '_' + Math.random().toString(36).slice(2, 9) + '.js');
  fs.writeFileSync(p, src.replace(find, replace), 'utf8');
  made.push(p);
  return require(p);
}

// A fake pool that answers one row for org 1 / task t782 / upload id u-12345678 only,
// by reading the PARAMETERS the statement was given.
function fakeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const [org, type, id, upload] = params;
      const sqlOrg = /organization_id = \$1/.test(sql);
      const hit = (!sqlOrg || org === 1) && type === 'task' && id === 't782' && upload === 'u-12345678';
      return { rows: hit ? [{ id: 'att1', organization_id: 1, entity_type: 'task', entity_id: 't782', client_upload_id: upload }] : [] };
    },
  };
}

describe('uploadIdFrom', () => {
  test('a well-formed id is used as sent', () => {
    expect(D.uploadIdFrom({ upload_id: 'u-12345678' })).toBe('u-12345678');
    expect(D.uploadIdFrom({ upload_id: 'A'.repeat(64) })).toBe('A'.repeat(64));
    expect(D.UPLOAD_ID_RE.source).toBe('^[A-Za-z0-9_-]{8,64}$');
  });

  test('a missing, short, long, spaced or non-string id is ignored', () => {
    for (const bad of [undefined, null, '', 'short', 'A'.repeat(65), 'has space1', 'semi;colon1', "x' OR 1=1--", 12345678, ['u-12345678'], { a: 1 }]) {
      expect(D.uploadIdFrom({ upload_id: bad })).toBeNull();
    }
    expect(D.uploadIdFrom(null)).toBeNull();
    expect(D.uploadIdFrom('u-12345678')).toBeNull();
  });
});

describe('findUpload', () => {
  test('finds the row for this org, parent and id, and binds the org first', async () => {
    const db = fakeDb();
    const row = await D.findUpload(db, { orgId: 1, entityType: 'task', entityId: 't782', uploadId: 'u-12345678' });
    expect(row).toMatchObject({ id: 'att1' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toBe('SELECT * FROM attachments WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3 AND client_upload_id = $4');
    expect(db.calls[0].params).toEqual([1, 'task', 't782', 'u-12345678']);
  });

  test('another org, another parent or another id finds nothing', async () => {
    const db = fakeDb();
    expect(await D.findUpload(db, { orgId: 2, entityType: 'task', entityId: 't782', uploadId: 'u-12345678' })).toBeNull();
    expect(await D.findUpload(db, { orgId: 1, entityType: 'task', entityId: 't784', uploadId: 'u-12345678' })).toBeNull();
    expect(await D.findUpload(db, { orgId: 1, entityType: 'service_ticket', entityId: 't782', uploadId: 'u-12345678' })).toBeNull();
    expect(await D.findUpload(db, { orgId: 1, entityType: 'task', entityId: 't782', uploadId: 'u-87654321' })).toBeNull();
  });

  test('no org or no upload id: no query at all', async () => {
    const db = fakeDb();
    expect(await D.findUpload(db, { orgId: null, entityType: 'task', entityId: 't782', uploadId: 'u-12345678' })).toBeNull();
    expect(await D.findUpload(db, { entityType: 'task', entityId: 't782', uploadId: 'u-12345678' })).toBeNull();
    expect(await D.findUpload(db, { orgId: 1, entityType: 'task', entityId: 't782', uploadId: null })).toBeNull();
    expect(await D.findUpload(db, { orgId: 1, entityType: 'task', entityId: 't782' })).toBeNull();
    expect(await D.findUpload(db, null)).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  test('MUTANT: without the org predicate another org\'s upload is found', async () => {
    const M = mutant("    'SELECT * FROM attachments WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3 AND client_upload_id = $4',\n",
      "    'SELECT * FROM attachments WHERE entity_type = $2 AND entity_id = $3 AND client_upload_id = $4',\n");
    expect(await M.findUpload(fakeDb(), { orgId: 2, entityType: 'task', entityId: 't782', uploadId: 'u-12345678' })).not.toBeNull();
  });

  test('MUTANT: without the missing-org guard, an org-less caller queries', async () => {
    const M = mutant("  if (o.orgId == null || !o.uploadId || !o.entityType || o.entityId == null || o.entityId === '') return null;\n",
      "  if (!o.uploadId || !o.entityType || o.entityId == null || o.entityId === '') return null;\n");
    const db = fakeDb();
    await M.findUpload(db, { orgId: null, entityType: 'task', entityId: 't782', uploadId: 'u-12345678' });
    expect(db.calls).toHaveLength(1);
  });
});

describe('isUploadIdConflict', () => {
  test('a 23505 on uq_attachments_client_upload, by constraint or by message', () => {
    expect(D.isUploadIdConflict({ code: '23505', constraint: 'uq_attachments_client_upload' })).toBe(true);
    expect(D.isUploadIdConflict({ code: '23505', message: 'duplicate key value violates unique constraint "uq_attachments_client_upload"' })).toBe(true);
  });

  test('any other error, or a 23505 on another index, is not a dedupe race', () => {
    expect(D.isUploadIdConflict({ code: '23505', constraint: 'attachments_pkey', message: 'duplicate key value violates unique constraint "attachments_pkey"' })).toBe(false);
    expect(D.isUploadIdConflict({ code: '23503', constraint: 'uq_attachments_client_upload' })).toBe(false);
    expect(D.isUploadIdConflict(new Error('uq_attachments_client_upload'))).toBe(false);
    expect(D.isUploadIdConflict(null)).toBe(false);
  });

  test('MUTANT: treating every 23505 as a race would hide a real duplicate-key bug', () => {
    const M = mutant("  if (!e || String(e.code) !== '23505') return false;\n", "  if (!e || String(e.code) !== '23505') return false;\n  return true;\n");
    expect(M.isUploadIdConflict({ code: '23505', constraint: 'attachments_pkey' })).toBe(true);
  });
});

describe('discardKeys', () => {
  test('deletes each key once, and swallows every failure', async () => {
    const deleted = [];
    const storage = {
      delete: (k) => {
        if (k === 'web/boom') throw new Error('sync boom');
        if (k === 'orig/reject') return Promise.reject(new Error('R2 down'));
        deleted.push(k);
        return Promise.resolve();
      },
    };
    const n = await D.discardKeys(storage, ['thumb/a', 'web/boom', 'orig/reject', 'thumb/a', null, '']);
    expect(deleted).toEqual(['thumb/a']);
    expect(n).toBe(1);
  });

  test('no storage, or a storage with no delete, is a no-op', async () => {
    await expect(D.discardKeys(null, ['a'])).resolves.toBe(0);
    await expect(D.discardKeys({}, ['a'])).resolves.toBe(0);
    await expect(D.discardKeys({ delete: async () => {} }, null)).resolves.toBe(0);
  });

  test('MUTANT: without the catch, one failed delete rejects the whole answer', async () => {
    const M = mutant("      .then(function () { return true; }, function () { return false; });\n",
      "      .then(function () { return true; });\n");
    const storage = { delete: (k) => (k === 'b' ? Promise.reject(new Error('R2 down')) : Promise.resolve()) };
    await expect(M.discardKeys(storage, ['a', 'b'])).rejects.toThrow(/R2 down/);
    await expect(D.discardKeys(storage, ['a', 'b'])).resolves.toBe(1);
  });
});
