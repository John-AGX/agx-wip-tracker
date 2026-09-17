// The crew link carries its own copy of the photo upload queue.
//
// service-ticket-share.html is a guest page and may not load app code, so the
// queue core that js/photo-upload-queue.js ships to the office is pasted into
// the page's inline script between the same two marker comments. Two copies
// drift unless something holds them together; this is that something:
//
//   1. Each file carries the block exactly once, and the page's copy sits in
//      its inline script, where the page builds its queue from it.
//   2. The two blocks are the same text, line for line, once CRLF is
//      normalised and each line's leading indentation is set aside (the page
//      may indent its copy differently; nothing else may differ).
//   3. The HEIC refusal the queue shows is word for word the server's
//      HEIC_REFUSAL, in both copies, so the crew reads one sentence whether
//      the phone or the server refuses the photo.
//
// Each check is also shown to FIRE: a copy of the page with one byte of its
// block changed, a line dropped, the HEIC sentence edited or a marker lost has
// to come out wrong. Anchors are CRLF-normalised and must occur exactly once.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BEGIN = '/* photo-queue core: begin */';
const END = '/* photo-queue core: end */';

const readRaw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n');

const QUEUE_SRC = norm(readRaw('js/photo-upload-queue.js'));
const PAGE_SRC = norm(readRaw('service-ticket-share.html'));
const { HEIC_REFUSAL } = require('../server/util/attachment-mime');

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1 || src.indexOf(from, at + from.length) !== -1) throw new Error('anchor not found');
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('anchor not found');
  return out;
}

// The block between the markers, markers included.
function coreBlock(src, label) {
  const s = norm(src);
  const a = s.indexOf(BEGIN);
  const b = s.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error(label + ': core markers not found');
  if (s.indexOf(BEGIN, a + 1) !== -1 || s.indexOf(END, b + 1) !== -1) throw new Error(label + ': core markers appear twice');
  return s.slice(a, b + END.length);
}

// The page's own inline script (the last one on the page).
function pageScript(html) {
  const open = html.lastIndexOf('<script>');
  const close = html.indexOf('</script>', open);
  if (open === -1 || close === -1) throw new Error('page script not found');
  return html.slice(open + '<script>'.length, close);
}

const unindent = (block) => block.split('\n').map((l) => l.replace(/^[ \t]+/, ''));

// null when the blocks agree, else the first line that differs.
function firstDifference(officeSrc, pageSrc) {
  const a = unindent(coreBlock(officeSrc, 'js/photo-upload-queue.js'));
  const b = unindent(coreBlock(pageSrc, 'service-ticket-share.html'));
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { line: i + 1, office: a[i] === undefined ? null : a[i], page: b[i] === undefined ? null : b[i] };
  }
  return null;
}

// Builds the queue from a block, with no browser around it: the core only
// reaches for window, document or navigator inside the functions it returns.
function coreFrom(src, label) {
  // eslint-disable-next-line no-new-func
  return new Function(coreBlock(src, label) + '\nreturn photoQueueCore();')();
}

describe('the crew page carries the queue core once, inside its own script', () => {
  test('each file holds the markers exactly once, and the page copy is in the inline script', () => {
    expect(() => coreBlock(QUEUE_SRC, 'office')).not.toThrow();
    expect(() => coreBlock(PAGE_SRC, 'page')).not.toThrow();
    const script = pageScript(PAGE_SRC);
    expect(script.split(BEGIN).length - 1).toBe(1);
    expect(script.split(END).length - 1).toBe(1);
  });

  test('the page builds its queue from that copy and defines no second core', () => {
    const script = pageScript(PAGE_SRC);
    expect(script.split('function photoQueueCore(').length - 1).toBe(1);
    expect(script).toContain('var PQ = photoQueueCore();');
    expect(script).toContain('PQ.createQueue({ send: sendPhoto, onChange: queueChanged, onIdle: queueIdle })');
    expect(script).toContain('PQ.statusText(s)');
  });

  test('both files are CRLF on disk, so the comparison below really is normalising', () => {
    const office = readRaw('js/photo-upload-queue.js');
    const page = readRaw('service-ticket-share.html');
    expect(office.split('\n').length - 1).toBe(office.split('\r\n').length - 1);
    expect(page.split('\n').length - 1).toBe(page.split('\r\n').length - 1);
  });
});

describe('the two copies are the same code', () => {
  test('line for line, leading indentation aside', () => {
    expect(firstDifference(QUEUE_SRC, PAGE_SRC)).toBeNull();
    expect(unindent(coreBlock(PAGE_SRC, 'page')).length).toBeGreaterThan(700);
  });

  test('the same set of exports', () => {
    const office = Object.keys(coreFrom(QUEUE_SRC, 'office')).sort();
    const page = Object.keys(coreFrom(PAGE_SRC, 'page')).sort();
    expect(page).toEqual(office);
    expect(page).toEqual(['HEIC_MESSAGE', 'createQueue', 'prepareImage', 'spliceExif', 'statusText', 'uploadIdFor']);
  });

  test('indenting the page copy differently is allowed', () => {
    const block = coreBlock(PAGE_SRC, 'page');
    const reindented = PAGE_SRC.replace(block, () => block.split('\n').map((l) => '    ' + l).join('\n'));
    expect(reindented).not.toBe(PAGE_SRC);
    expect(firstDifference(QUEUE_SRC, reindented)).toBeNull();
  });

  test('FIRES: one changed byte in the page copy is named by its line', () => {
    const broken = mutate(PAGE_SRC, 'var BACKOFF_MS = [3000, 15000];', 'var BACKOFF_MS = [3000, 16000];');
    const diff = firstDifference(QUEUE_SRC, broken);
    expect(diff).not.toBeNull();
    expect(diff.office).toBe('var BACKOFF_MS = [3000, 15000];');
    expect(diff.page).toBe('var BACKOFF_MS = [3000, 16000];');
  });

  test('FIRES: a line dropped from the page copy is caught', () => {
    const broken = mutate(PAGE_SRC, '        if (it.retryAt <= now) { next = it; break; }\n', '');
    expect(firstDifference(QUEUE_SRC, broken)).not.toBeNull();
  });

  test('FIRES: trailing text on a line is not forgiven (only leading indentation is)', () => {
    const broken = mutate(PAGE_SRC, '    var MAX_ATTEMPTS = 3;\n', '    var MAX_ATTEMPTS = 3; \n');
    expect(firstDifference(QUEUE_SRC, broken)).toMatchObject({ page: 'var MAX_ATTEMPTS = 3; ' });
  });

  test('FIRES: a lost marker is refused rather than compared', () => {
    const broken = mutate(PAGE_SRC, BEGIN, '/* photo-queue core */');
    expect(() => firstDifference(QUEUE_SRC, broken)).toThrow('core markers not found');
  });
});

describe('the HEIC refusal is the server\'s sentence', () => {
  test('the page copy, the office copy and HEIC_REFUSAL are the same words', () => {
    expect(typeof HEIC_REFUSAL).toBe('string');
    expect(HEIC_REFUSAL.length).toBeGreaterThan(40);
    expect(coreFrom(PAGE_SRC, 'page').HEIC_MESSAGE).toBe(HEIC_REFUSAL);
    expect(coreFrom(QUEUE_SRC, 'office').HEIC_MESSAGE).toBe(HEIC_REFUSAL);
    expect(require('../js/photo-upload-queue.js').HEIC_MESSAGE).toBe(HEIC_REFUSAL);
  });

  test('the page copy refuses a .heic it cannot open with that sentence, without sending it', async () => {
    const core = coreFrom(PAGE_SRC, 'page');
    await expect(core.prepareImage({ name: 'IMG_2231.heic', type: 'image/heic', size: 1000 }))
      .rejects.toEqual({ permanent: true, message: HEIC_REFUSAL });
  });

  test('FIRES: an edited sentence in the page copy no longer matches the server', () => {
    const broken = mutate(PAGE_SRC, "which can't be opened here yet.", 'which cannot be opened here.');
    expect(coreFrom(broken, 'page').HEIC_MESSAGE).not.toBe(HEIC_REFUSAL);
    expect(firstDifference(QUEUE_SRC, broken)).not.toBeNull();
  });
});
