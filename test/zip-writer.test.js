// THE ZIP WRITER (server/services/zip-writer.js).
//
// A hand-rolled archive format has one characteristic failure: it opens in
// the tool the author tested with and nowhere else. So the load-bearing test
// here does not read the archive with this repo's own code at all — it shells
// out to PowerShell's Expand-Archive, a completely independent
// implementation, and checks the files that come out.
//
// The rest pins the decisions: STORE (photos are already compressed), no
// ZIP64 and a refusal rather than a 32-bit overflow, UTF-8 names, no two
// entries sharing a name, and no entry able to climb out of the folder it is
// extracted into.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('node:zlib');

const { createZip, safeEntryName, dosDate, dosTime } = require('../server/services/zip-writer');

const LOCAL_SIG = 0x04034b50;
const EOCD_SIG = 0x06054b50;

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-zip-')); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ } });

/** Build an archive in memory. */
function build(entries) {
  const chunks = [];
  const sink = { write: (b) => { chunks.push(Buffer.from(b)); return true; } };
  const z = createZip(sink);
  for (const [name, body, opts] of entries) z.add(name, body, opts);
  const total = z.end();
  const buf = Buffer.concat(chunks);
  expect(buf.length).toBe(total);
  return { buf, zip: z };
}

describe('the archive is readable by something that is not us', () => {
  test('PowerShell Expand-Archive gets every file back, bytes and folders intact', () => {
    const { buf } = build([
      ['Work order summary.txt', 'WO-0001\r\nBelleair\r\n'],
      ['Before/Bldg 4 — 01 — rail.txt', 'before-bytes'],
      ['After/Bldg 4 — 01 — rail done.txt', 'after-bytes'],
      ['Issues/Bldg 9 — 01 — rot.txt', 'issue-bytes'],
      ['Documents/scope.txt', 'a document'],
    ]);
    const zipPath = path.join(dir, 'a.zip');
    const outDir = path.join(dir, 'a-out');
    fs.writeFileSync(zipPath, buf);
    fs.rmSync(outDir, { recursive: true, force: true });

    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) +
      ' -DestinationPath ' + JSON.stringify(outDir) + ' -Force'], { stdio: 'pipe' });

    const read = (p) => fs.readFileSync(path.join(outDir, p), 'utf8');
    expect(read('Work order summary.txt')).toBe('WO-0001\r\nBelleair\r\n');
    expect(read(path.join('Before', 'Bldg 4 — 01 — rail.txt'))).toBe('before-bytes');
    expect(read(path.join('After', 'Bldg 4 — 01 — rail done.txt'))).toBe('after-bytes');
    expect(read(path.join('Issues', 'Bldg 9 — 01 — rot.txt'))).toBe('issue-bytes');
    expect(read(path.join('Documents', 'scope.txt'))).toBe('a document');
  });

  test('binary bytes survive exactly — a photo is not text', () => {
    // Every byte value, so a stray encoding step anywhere shows up.
    const blob = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const { buf } = build([['After/photo.bin', blob]]);
    const zipPath = path.join(dir, 'b.zip');
    const outDir = path.join(dir, 'b-out');
    fs.writeFileSync(zipPath, buf);
    fs.rmSync(outDir, { recursive: true, force: true });
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) +
      ' -DestinationPath ' + JSON.stringify(outDir) + ' -Force'], { stdio: 'pipe' });
    expect(fs.readFileSync(path.join(outDir, 'After', 'photo.bin')).equals(blob)).toBe(true);
  });

  test('a UTF-8 name comes back as itself, not as mojibake', () => {
    const name = 'Before/café — naïve — über.txt';
    const { buf } = build([[name, 'x']]);
    const zipPath = path.join(dir, 'c.zip');
    const outDir = path.join(dir, 'c-out');
    fs.writeFileSync(zipPath, buf);
    fs.rmSync(outDir, { recursive: true, force: true });
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) +
      ' -DestinationPath ' + JSON.stringify(outDir) + ' -Force'], { stdio: 'pipe' });
    const got = fs.readdirSync(path.join(outDir, 'Before'));
    expect(got).toEqual(['café — naïve — über.txt']);
  });
});

describe('the bytes are the format, not something that merely unzips here', () => {
  test('it starts with a local header and ends with an EOCD naming every entry', () => {
    const { buf } = build([['a.txt', 'one'], ['b/c.txt', 'two']]);
    expect(buf.readUInt32LE(0)).toBe(LOCAL_SIG);
    const eocdAt = buf.length - 22;
    expect(buf.readUInt32LE(eocdAt)).toBe(EOCD_SIG);
    expect(buf.readUInt16LE(eocdAt + 8)).toBe(2);    // entries on this disk
    expect(buf.readUInt16LE(eocdAt + 10)).toBe(2);   // entries total
    // The central directory offset + size land exactly on the EOCD.
    const cdSize = buf.readUInt32LE(eocdAt + 12);
    const cdOff = buf.readUInt32LE(eocdAt + 16);
    expect(cdOff + cdSize).toBe(eocdAt);
  });

  test('STORE, with the real CRC — not a zero somebody would notice one day', () => {
    const body = Buffer.from('the quick brown fox');
    const { buf } = build([['a.txt', body]]);
    expect(buf.readUInt16LE(8)).toBe(0);                          // method STORE
    expect(buf.readUInt32LE(14)).toBe(zlib.crc32(body) >>> 0);    // crc
    expect(buf.readUInt32LE(18)).toBe(body.length);               // compressed
    expect(buf.readUInt32LE(22)).toBe(body.length);               // uncompressed
    expect(buf.readUInt16LE(6) & 0x0800).toBe(0x0800);            // UTF-8 flag
  });

  test('a stored entry is the bytes themselves — nothing was transformed', () => {
    const body = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    const { buf } = build([['x', body]]);
    const nameLen = buf.readUInt16LE(26);
    const at = 30 + nameLen;
    expect(buf.subarray(at, at + body.length).equals(body)).toBe(true);
  });
});

describe('what an entry is allowed to be called', () => {
  test('nothing can climb out of the folder it is extracted into', () => {
    expect(safeEntryName('../../etc/passwd')).toBe('etc/passwd');
    expect(safeEntryName('..\\..\\windows\\system32')).toBe('windows/system32');
    expect(safeEntryName('a/../../b')).toBe('a/b');
    expect(safeEntryName('....//x')).toBe('x');
    expect(safeEntryName('a/....../b')).toBe('a/b');
    // …but a leading dot is a legitimate filename, not an escape.
    expect(safeEntryName('.hidden')).toBe('.hidden');
    expect(safeEntryName('/absolute/path')).toBe('absolute/path');
  });

  test('characters Windows refuses, and control characters, are removed', () => {
    expect(safeEntryName('a:b*c?d"e<f>g|h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(safeEntryName('bad\u0000name\u001f.txt')).toBe('badname.txt');
    expect(safeEntryName('trailing dot.')).toBe('trailing dot');
    expect(safeEntryName('  padded  /  x  ')).toBe('padded/x');
  });

  test('an empty or hopeless name still becomes something', () => {
    expect(safeEntryName('')).toBe('file');
    expect(safeEntryName('///')).toBe('file');
    expect(safeEntryName('..')).toBe('file');
    expect(safeEntryName(null)).toBe('file');
  });

  test('two entries never share a name — an unzip tool would drop one', () => {
    const { zip } = build([
      ['After/rail.jpg', 'a'],
      ['After/rail.jpg', 'b'],
      ['After/rail.jpg', 'c'],
    ]);
    expect(zip.entryCount).toBe(3);
  });

  test('the dedupe keeps the extension, so the second copy still opens', () => {
    const chunks = [];
    const z = createZip({ write: (b) => chunks.push(Buffer.from(b)) });
    expect(z.add('After/rail.jpg', 'a')).toBe('After/rail.jpg');
    expect(z.add('After/rail.jpg', 'b')).toBe('After/rail (2).jpg');
    expect(z.add('After/rail.jpg', 'c')).toBe('After/rail (3).jpg');
    z.end();
  });
});

describe('the limits refuse rather than overflow', () => {
  test('add() after end() is a mistake, not a silent no-op', () => {
    const z = createZip({ write: () => {} });
    z.add('a', 'x');
    z.end();
    expect(() => z.add('b', 'y')).toThrow(/after end/);
    expect(() => z.end()).toThrow(/twice/);
  });

  test('past 4GB it throws instead of writing a wrong 32-bit length', () => {
    // The offset counter is what wraps, and writing four gigabytes to find
    // out is not a test anybody would run. createZip takes a test-only
    // startOffset so the boundary is reachable with one small entry.
    const near = createZip({ write: () => {} }, { startOffset: 0xffffffff - 10 });
    expect(() => near.add('a.txt', 'this is more than ten bytes')).toThrow(/4GB|ZIP64/);

    // And just under it still works, so the guard is a boundary and not a
    // blanket refusal.
    const under = createZip({ write: () => {} }, { startOffset: 0xffffffff - 4096 });
    expect(() => under.add('a.txt', 'x')).not.toThrow();
  });

  test('the central directory is guarded too, not just the entries', () => {
    // end() writes 46+ bytes per entry and a 22-byte EOCD. A file that fits
    // under the ceiling and a directory that does not is exactly the case
    // that would write a truncated archive.
    // One entry costs 30 + name + data going in, and 46 + name coming back
    // out in the directory, plus a 22-byte EOCD. 60 bytes of headroom takes
    // the entry but not the directory that describes it.
    const z = createZip({ write: () => {} }, { startOffset: 0xffffffff - 60 });
    expect(() => z.add('a.txt', 'x')).not.toThrow();
    expect(() => z.end()).toThrow(/4GB|ZIP64/);
  });

  test('startOffset is documented as a test seam and production never passes it', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'zip-writer.js'), 'utf8');
    expect(src).toMatch(/TEST SEAM/);
    const routes = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'routes', 'service-ticket-export-routes.js'), 'utf8');
    expect(routes).not.toMatch(/startOffset/);
  });

  test('a date before 1980 does not underflow the DOS field', () => {
    // MS-DOS dates start at 1980; 1970 would write a negative year.
    const old = new Date(Date.UTC(1970, 0, 1, 0, 0, 0));
    expect(dosDate(old) >>> 9).toBe(0);
    expect(dosTime(old)).toBeGreaterThanOrEqual(0);
  });

  test('a real date round-trips through the DOS packing', () => {
    const d = new Date(2026, 8, 29, 14, 35, 20);   // 2026-09-29 14:35:20 local
    expect(dosDate(d) >>> 9).toBe(2026 - 1980);
    expect((dosDate(d) >> 5) & 0x0f).toBe(9);
    expect(dosDate(d) & 0x1f).toBe(29);
    expect(dosTime(d) >> 11).toBe(14);
    expect((dosTime(d) >> 5) & 0x3f).toBe(35);
    expect((dosTime(d) & 0x1f) * 2).toBe(20);
  });
});
