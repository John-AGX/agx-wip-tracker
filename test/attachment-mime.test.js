// test/attachment-mime.test.js — coverage for the magic-byte MIME
// sniffer + SVG sandbox + family-match helper shipped as the file-
// upload security defense (audit finding B3 / commit 55a8603).
// These guard against MIME spoofing (evil.html uploaded as image/png)
// and stored-XSS via SVG.

const { __internals__ } = require('../server/routes/attachment-routes');
const { sniffMimeFromBytes, sanitizeSvg, mimeFamilyMatches } = __internals__;

describe('sniffMimeFromBytes', () => {
  test('detects JPEG magic bytes', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    expect(sniffMimeFromBytes(buf)).toBe('image/jpeg');
  });

  test('detects PNG magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(sniffMimeFromBytes(buf)).toBe('image/png');
  });

  test('detects PDF magic bytes', () => {
    const buf = Buffer.from('%PDF-1.4\n');
    expect(sniffMimeFromBytes(buf)).toBe('application/pdf');
  });

  test('detects ZIP magic bytes (covers docx/xlsx/pptx)', () => {
    const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]);
    expect(sniffMimeFromBytes(buf)).toBe('application/zip');
  });

  test('detects SVG by text content', () => {
    const buf = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">\n</svg>');
    expect(sniffMimeFromBytes(buf)).toBe('image/svg+xml');
  });

  test('returns null for unrecognized formats', () => {
    const buf = Buffer.from('plain text file with no magic\n');
    expect(sniffMimeFromBytes(buf)).toBeNull();
  });

  test('returns null for very small buffers', () => {
    expect(sniffMimeFromBytes(Buffer.from([0xFF]))).toBeNull();
    expect(sniffMimeFromBytes(Buffer.alloc(0))).toBeNull();
  });

  test('returns null for non-Buffer input', () => {
    expect(sniffMimeFromBytes(null)).toBeNull();
    expect(sniffMimeFromBytes('not a buffer')).toBeNull();
  });
});

describe('mimeFamilyMatches', () => {
  test('exact match accepts', () => {
    expect(mimeFamilyMatches('image/png', 'image/png')).toBe(true);
  });

  test('image/jpg accepted against image/jpeg', () => {
    expect(mimeFamilyMatches('image/jpg', 'image/jpeg')).toBe(true);
  });

  test('different image formats accepted (image-family)', () => {
    expect(mimeFamilyMatches('image/png', 'image/webp')).toBe(true);
  });

  test('docx MIME accepted against application/zip sniff', () => {
    expect(mimeFamilyMatches(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip'
    )).toBe(true);
  });

  test('image/png claimed when bytes are HTML/PDF is REJECTED', () => {
    expect(mimeFamilyMatches('image/png', 'application/pdf')).toBe(false);
  });

  test('null sniffed value accepts (unknown format, no signal)', () => {
    expect(mimeFamilyMatches('text/plain', null)).toBe(true);
  });

  test('application/octet-stream client claim always accepts', () => {
    expect(mimeFamilyMatches('application/octet-stream', 'image/png')).toBe(true);
  });
});

describe('sanitizeSvg', () => {
  function svg(body) {
    return Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">\n' + body + '\n</svg>');
  }
  function text(buf) {
    return buf.toString('utf8');
  }

  test('strips inline <script> blocks', () => {
    const dirty = svg('<script>alert(1)</script><circle r="10"/>');
    const cleaned = text(sanitizeSvg(dirty));
    expect(cleaned).not.toMatch(/<script/i);
    expect(cleaned).toMatch(/<circle/);
  });

  test('strips self-closing <script /> tags', () => {
    const dirty = svg('<script src="evil.js" /><rect/>');
    const cleaned = text(sanitizeSvg(dirty));
    expect(cleaned).not.toMatch(/<script/i);
  });

  test('strips on*= event attributes', () => {
    const dirty = svg('<g onclick="evil()" onload="x()"><text>hi</text></g>');
    const cleaned = text(sanitizeSvg(dirty));
    expect(cleaned).not.toMatch(/onclick=/i);
    expect(cleaned).not.toMatch(/onload=/i);
    expect(cleaned).toMatch(/<text>hi<\/text>/);
  });

  test('strips javascript: URIs', () => {
    const dirty = svg('<a href="javascript:alert(1)"><text>click</text></a>');
    const cleaned = text(sanitizeSvg(dirty));
    expect(cleaned.toLowerCase()).not.toContain('javascript:');
  });

  test('strips <foreignObject> blocks (HTML injection vector)', () => {
    const dirty = svg('<foreignObject><body onload="evil()"><div/></body></foreignObject>');
    const cleaned = text(sanitizeSvg(dirty));
    expect(cleaned).not.toMatch(/<foreignObject/i);
    expect(cleaned).not.toMatch(/onload=/i);
  });

  test('leaves non-SVG buffers unchanged', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xDE, 0xAD]);
    expect(sanitizeSvg(png)).toBe(png);
  });
});
