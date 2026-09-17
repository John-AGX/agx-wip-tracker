// HEIC / HEIF photos (1.29): server/util/attachment-mime.js decides what is a
// HEIC upload and owns the one sentence every refusal shows. The installed
// sharp cannot decode HEVC, so a HEIC that reached the image pipeline used to
// fail as "Something went wrong."; the doors refuse it up front instead.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../server/util/attachment-mime');

const SRC = path.join(__dirname, '..', 'server', 'util', 'attachment-mime.js');
const made = [];
afterAll(() => { for (const p of made) { try { fs.unlinkSync(p); } catch (_) {} } });

function mutant(find, replace) {
  const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(find).length !== 2) throw new Error('anchor not found');
  const p = path.join(os.tmpdir(), '_p86_heic_' + process.pid + '_' + Math.random().toString(36).slice(2, 9) + '.js');
  fs.writeFileSync(p, src.replace(find, replace), 'utf8');
  made.push(p);
  return require(p);
}

test('the refusal is the exact sentence the crew page and the office queue show', () => {
  expect(M.HEIC_REFUSAL).toBe("This photo is in HEIC format (High efficiency), which can't be opened here yet. Use Take photo, or set your camera to save photos as JPEG, then add it again.");
});

test('the four HEIC / HEIF types are HEIC, whatever the name and case', () => {
  for (const mime of ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'IMAGE/HEIC', ' image/heif ; q=1']) {
    expect([mime, M.isHeicUpload(mime, 'photo.jpg')]).toEqual([mime, true]);
  }
});

test('a .heic or .heif name is HEIC even when the browser sent no useful type', () => {
  expect(M.isHeicUpload('application/octet-stream', 'IMG_2231.HEIC')).toBe(true);
  expect(M.isHeicUpload('', 'IMG_2231.heif')).toBe(true);
  expect(M.isHeicUpload(null, 'IMG_2231.heic ')).toBe(true);
  expect(M.isHeicUpload(undefined, 'IMG_2231.heic')).toBe(true);
});

test('everything else is not HEIC', () => {
  expect(M.isHeicUpload('image/jpeg', 'IMG_2231.jpg')).toBe(false);
  expect(M.isHeicUpload('image/png', 'heic.png')).toBe(false);
  expect(M.isHeicUpload('image/avif', 'photo.avif')).toBe(false);
  expect(M.isHeicUpload('application/pdf', 'notes.heic.pdf')).toBe(false);
  expect(M.isHeicUpload('image/heic-ish', 'x.jpg')).toBe(false);
  expect(M.isHeicUpload(null, null)).toBe(false);
});

test('the sniffed HEIC brand agrees with the check', () => {
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(12)]);
  const sniffed = M.sniffMimeFromBytes(buf);
  expect(sniffed).toBe('image/heic');
  expect(M.isHeicUpload(sniffed, 'upload.bin')).toBe(true);
});

test('the existing exports are still there', () => {
  for (const k of ['sniffMimeFromBytes', 'sanitizeSvg', 'mimeFamilyMatches', 'resolveStoredMime']) {
    expect(typeof M[k]).toBe('function');
  }
});

test('MUTANT: without the name check a HEIC sent as octet-stream reaches sharp', () => {
  const X = mutant('  return /\\.(heic|heif)$/i.test(String(filename == null ? \'\' : filename).trim());\n', '  return false;\n');
  expect(X.isHeicUpload('application/octet-stream', 'IMG_2231.HEIC')).toBe(false);
  expect(M.isHeicUpload('application/octet-stream', 'IMG_2231.HEIC')).toBe(true);
});

test('MUTANT: without the heif types a HEIF photo reaches sharp', () => {
  const X = mutant("const HEIC_MIMES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);",
    "const HEIC_MIMES = new Set(['image/heic']);");
  expect(X.isHeicUpload('image/heif', 'photo')).toBe(false);
  expect(M.isHeicUpload('image/heif', 'photo')).toBe(true);
});
