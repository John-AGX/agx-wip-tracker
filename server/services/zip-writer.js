'use strict';

// A ZIP writer, streamed, with no dependency.
//
// WHY NOT A LIBRARY. The tree already carries 340-odd production packages and
// a clean licence position (docs/DEPENDENCIES.md), and every addition is a
// thing somebody has to review again. What this needs is the STORE half of a
// format that has not changed since 1993, which is about ninety lines. The
// risk of hand-rolling an archive format is writing one that opens in the
// tool you tested with and nowhere else, so that is exactly what the tests
// check: test/zip-writer.test.js unzips the output with PowerShell's
// Expand-Archive — a completely independent implementation — as well as
// reading it back here.
//
// STORE, NOT DEFLATE, and that is not laziness: a work order's export is
// JPEGs and PDFs, which are already compressed. Deflating them again costs
// CPU per megabyte to save low single-digit percentages, and on a 600MB
// export that is real time somebody waits for. Text entries (the report) are
// small enough that the same argument holds in reverse — the complexity is
// not worth the kilobytes.
//
// NO ZIP64. The 32-bit fields cap an entry, and the archive, at 4GB. That is
// far past anything a single work order holds, but "far past" is not "cannot
// happen", so add() and the total are CHECKED and throw rather than writing
// the silently-wrong length that a 32-bit overflow produces. A corrupt
// archive that opens and shows the wrong photos is worse than a refusal.
//
// EVERY ENTRY IS BUFFERED WHOLE, once, to compute its CRC before its header
// goes out. The alternative is a data descriptor after the bytes, which is
// legal and which several unzip tools have historically got wrong. One photo
// in memory at a time is a few megabytes; correctness is worth it.

const zlib = require('node:zlib');

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20;              // 2.0 — the floor for STORE + directories
const FLAG_UTF8 = 0x0800;        // bit 11: the name is UTF-8, not CP437
const METHOD_STORE = 0;
const MAX32 = 0xffffffff;
const NAME_MAX = 512;

if (typeof zlib.crc32 !== 'function') {
  // Node 22.2 added it. The app runs 22.23 and CI runs 24; a build that did
  // not have it would otherwise write archives with a zero CRC, which most
  // tools accept silently and one day somebody's does not.
  throw new Error('zip-writer needs zlib.crc32 (Node >= 22.2)');
}

/** MS-DOS packed time/date. Seconds have 2-second resolution — that is the format. */
function dosTime(d) {
  return ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
}
function dosDate(d) {
  const year = Math.max(1980, d.getFullYear());
  return (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
}

/**
 * A name a zip entry may carry. Forward slashes separate folders (the spec
 * says so — a backslash is a literal character in a name, which is how a
 * Windows path becomes one file with slashes in its name). Anything that
 * could climb out of the archive is removed here rather than trusted: the
 * caller builds names out of user text.
 */
function safeEntryName(name) {
  const parts = String(name == null ? '' : name)
    .replace(/\\/g, '/')
    .split('/')
    .map(function (seg) {
      return seg
        .replace(/[\u0000-\u001f\u007f]/g, '')     // control characters
        .replace(/^\.+$/, '')                       // '.' and '..' entirely
        .replace(/[:*?"<>|]/g, '_')                 // illegal on Windows
        .replace(/^\s+|[\s.]+$/g, '')               // Windows drops these anyway
        .slice(0, 120);
    })
    .filter(Boolean);
  const joined = parts.join('/').slice(0, NAME_MAX);
  return joined || 'file';
}

/**
 * createZip(out) -> { add, end, bytesWritten, entryCount }
 * `out` is any Writable (an http response). Entries are written as they are
 * added, so nothing holds the whole archive.
 *
 * add(name, buffer, opts?) — opts.date sets the entry's timestamp.
 * end() -> Promise<number>  writes the central directory and resolves with
 *                           the total byte count. The stream is NOT closed:
 *                           the caller owns it.
 */
function createZip(out, opts) {
  const entries = [];
  const used = new Set();
  // opts.startOffset is a TEST SEAM and nothing else: the 4GB refusal below
  // is unreachable in a test that would have to write four gigabytes to get
  // there, and a guard nobody has watched fire is a guard nobody has tested.
  // Production never passes it. It only moves the byte counter, so an
  // archive built with it would have wrong local-header offsets — which is
  // why it is documented as test-only rather than offered as a feature.
  let offset = (opts && Number.isFinite(opts.startOffset)) ? opts.startOffset : 0;
  let ended = false;

  function write(buf) {
    offset += buf.length;
    if (offset > MAX32) {
      throw new Error('zip-writer: archive would exceed 4GB, which needs ZIP64');
    }
    // Back-pressure is the caller's to await via drain if it cares; for a
    // response stream Node buffers, and an export is bounded by the cap above.
    out.write(buf);
  }

  /** Two files cannot share a name, or an unzip tool picks one and drops the other. */
  function uniqueName(name) {
    let n = safeEntryName(name);
    if (!used.has(n)) { used.add(n); return n; }
    const dot = n.lastIndexOf('.');
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : '';
    for (let i = 2; i < 10000; i += 1) {
      const candidate = stem + ' (' + i + ')' + ext;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
    throw new Error('zip-writer: cannot make a unique name for ' + n);
  }

  function add(name, body, opts) {
    if (ended) throw new Error('zip-writer: add() after end()');
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
    if (data.length > MAX32) throw new Error('zip-writer: entry larger than 4GB needs ZIP64');
    const entryName = uniqueName(name);
    const nameBuf = Buffer.from(entryName, 'utf8');
    const when = (opts && opts.date instanceof Date && !isNaN(opts.date)) ? opts.date : new Date();
    const crc = zlib.crc32(data) >>> 0;
    const time = dosTime(when);
    const date = dosDate(when);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);      // compressed  — STORE, so the same
    local.writeUInt32LE(data.length, 22);      // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);                // no extra field

    const localOffset = offset;
    write(local);
    write(nameBuf);
    write(data);
    entries.push({ nameBuf, crc, size: data.length, time, date, localOffset });
    return entryName;
  }

  function end() {
    if (ended) throw new Error('zip-writer: end() twice');
    ended = true;
    const cdStart = offset;
    for (const e of entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(CD_SIG, 0);
      cd.writeUInt16LE(VERSION, 4);            // version made by
      cd.writeUInt16LE(VERSION, 6);            // version needed
      cd.writeUInt16LE(FLAG_UTF8, 8);
      cd.writeUInt16LE(METHOD_STORE, 10);
      cd.writeUInt16LE(e.time, 12);
      cd.writeUInt16LE(e.date, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.size, 20);
      cd.writeUInt32LE(e.size, 24);
      cd.writeUInt16LE(e.nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);                 // extra
      cd.writeUInt16LE(0, 32);                 // comment
      cd.writeUInt16LE(0, 34);                 // disk number start
      cd.writeUInt16LE(0, 36);                 // internal attributes
      cd.writeUInt32LE(0, 38);                 // external attributes
      cd.writeUInt32LE(e.localOffset, 42);
      write(cd);
      write(e.nameBuf);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);                  // this disk
    eocd.writeUInt16LE(0, 6);                  // disk with the central directory
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);                 // no archive comment
    write(eocd);
    return offset;
  }

  return {
    add,
    end,
    get entryCount() { return entries.length; },
    get bytesWritten() { return offset; },
  };
}

module.exports = { createZip, safeEntryName, dosTime, dosDate, MAX32 };
