#!/usr/bin/env node
'use strict';

/**
 * export-r2-files.js — download every uploaded file out of Cloudflare R2.
 *
 * WHY THIS EXISTS
 * The database stores only URLs and keys. The actual bytes of every photo,
 * plan, PDF, receipt and thumbnail live in an R2 bucket, and there is no
 * second copy of them anywhere. A database export alone preserves the records
 * and loses everything the records point at.
 *
 * Two buckets exist on this account: project86-attachments (current) and
 * agx-attachments (older — the migration at server/db.js rewrote URLs from
 * attachments.wip-agxco.com to attachments.project86.net, so the older bucket
 * may still hold files the app no longer references). Export both.
 *
 * READ ONLY: lists and downloads. It never writes to or deletes from R2.
 *
 * USAGE — credentials come from the environment, so they do not land in your
 * shell history. All four values are in Railway under the project86 service.
 *
 *   # PowerShell
 *   $env:R2_ACCOUNT_ID="..."
 *   $env:R2_ACCESS_KEY_ID="..."
 *   $env:R2_SECRET_ACCESS_KEY="..."
 *   node scripts/export-r2-files.js --bucket project86-attachments --out "G:/My Drive/Project 86 Archive/files"
 *
 *   # list and size it first, downloading nothing
 *   node scripts/export-r2-files.js --bucket project86-attachments --list-only
 *
 * Resumable: a file already on disk with a matching byte size is skipped, so
 * re-running after an interruption picks up where it stopped.
 */

const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const ARGV = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = ARGV.indexOf('--' + name);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : dflt;
};
const LIST_ONLY = ARGV.includes('--list-only');
const BUCKET = arg('bucket', 'project86-attachments');
const OUT = arg('out', path.join(process.cwd(), 'r2-' + BUCKET));

const ACCOUNT = process.env.R2_ACCOUNT_ID || '';
const KEY = process.env.R2_ACCESS_KEY_ID || '';
const SECRET = process.env.R2_SECRET_ACCESS_KEY || '';

if (!ACCOUNT || !KEY || !SECRET) {
  console.error('\nSet R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY first.');
  console.error('All three are in Railway under the project86 service variables.\n');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: 'https://' + ACCOUNT + '.r2.cloudflarestorage.com',
  credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
});

const human = (n) => (n < 1024 ? n + ' B'
  : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
  : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB'
  : (n / 1073741824).toFixed(2) + ' GB');

/* A key is a path inside the bucket and lands on disk as one. Refuse anything
 * that would climb out of the output directory. */
function safeJoin(root, key) {
  const dest = path.resolve(root, key);
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new Error('refusing key that escapes the output directory: ' + key);
  }
  return dest;
}

async function listAll() {
  const keys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, ContinuationToken: token, MaxKeys: 1000,
    }));
    for (const o of r.Contents || []) keys.push({ key: o.Key, size: o.Size || 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
    process.stdout.write('\r  listed ' + keys.length + ' objects…   ');
  } while (token);
  process.stdout.write('\r');
  return keys;
}

async function main() {
  console.log('\nbucket: ' + BUCKET + '\n');
  const objects = await listAll();
  const total = objects.reduce((n, o) => n + o.size, 0);
  console.log('  ' + objects.length + ' objects, ' + human(total) + ' total\n');

  /* What kinds of thing are in here, so the size is legible. */
  const byExt = {};
  for (const o of objects) {
    const e = (path.extname(o.key) || '(none)').toLowerCase();
    byExt[e] = byExt[e] || { n: 0, bytes: 0 };
    byExt[e].n++; byExt[e].bytes += o.size;
  }
  Object.entries(byExt).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 10)
    .forEach(([e, v]) => console.log('    ' + String(v.n).padStart(6) + '  ' + e.padEnd(8) + human(v.bytes)));

  if (LIST_ONLY) {
    console.log('\n--list-only: nothing downloaded.\n');
    return;
  }

  const root = path.resolve(OUT);
  fs.mkdirSync(root, { recursive: true });
  console.log('\nwriting to ' + root + '\n');

  let done = 0, skipped = 0, bytes = 0;
  const failed = [];

  for (const o of objects) {
    let dest;
    try { dest = safeJoin(root, o.key); }
    catch (e) { failed.push({ key: o.key, err: e.message }); continue; }

    /* Resume: same size on disk means it already came down. */
    try {
      const st = fs.statSync(dest);
      if (st.size === o.size) { skipped++; continue; }
    } catch (_) { /* not there yet */ }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: o.key }));
      await new Promise((res, rej) => {
        const w = fs.createWriteStream(dest);
        r.Body.pipe(w);
        r.Body.on('error', rej);
        w.on('error', rej);
        w.on('finish', res);
      });
      done++; bytes += o.size;
    } catch (e) {
      failed.push({ key: o.key, err: e.name || e.message });
    }
    if ((done + skipped) % 25 === 0) {
      process.stdout.write('\r  ' + (done + skipped) + '/' + objects.length + '  (' + human(bytes) + ')   ');
    }
  }

  console.log('\r' + ' '.repeat(60));
  console.log('='.repeat(60));
  console.log('downloaded ' + done + ', already present ' + skipped + ', ' + human(bytes));
  if (failed.length) {
    console.log('\nFAILED (' + failed.length + '):');
    failed.slice(0, 20).forEach((f) => console.log('  ' + f.key + '  — ' + f.err));
    if (failed.length > 20) console.log('  …and ' + (failed.length - 20) + ' more');
    console.log('\nRe-run to retry — anything already downloaded is skipped.');
    process.exitCode = 1;
  } else {
    console.log('every object in ' + BUCKET + ' is on disk.');
  }
}

main().catch((e) => {
  console.error('\n' + (e.stack || e));
  console.error('\nIf this is an auth error, check the three R2_ values came from the');
  console.error('project86 service in Railway and belong to this Cloudflare account.');
  process.exitCode = 1;
});
