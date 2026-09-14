/**
 * @jest-environment jsdom
 */
// "Take photo" on the work-order punch list, office side and crew side.
//
// Android's image picker offers no camera for a plain
// <input type="file" accept="image/*">, so a crew on a phone could only reach
// the photo library. Every building card now carries two inputs per kind of
// photo: a CAMERA input (capture="environment", one shot a tap, never
// multiple) and a LIBRARY input (multiple, never capture). The camera
// controls are hidden wherever the main pointer is not a finger, because on a
// computer capture is ignored and "Take photo" would only repeat the upload
// button next to it; and on Windows (by user agent), whose 2-in-1s report a
// finger in tablet mode but have no camera behind a file input either.
//
// Driven through the REAL js/service-tickets.js, the REAL inline script of
// service-ticket-share.html, and the REAL stylesheets:
//
//   1. Per building, when the viewer can edit / the link can work: a camera
//      and a library input for completion and for before photos, each with
//      the right accept / capture / multiple / data-kind. A read-only viewer
//      or a view-only link gets no camera control and no file input at all.
//   2. Office: the Take photo tile opens the camera completion input, the
//      Upload photo tile the library one, and a camera input's file goes up
//      through p86Api.attachments.upload with the input's kind. On a phone
//      the tiles ARE the completion controls: the two completion labels are
//      hidden there, and a tile still opens (and uploads through) its hidden
//      input.
//   3. Crew link: a camera input's file is POSTed as FormData to the
//      building's photo door with its kind, and Enter on the camera label
//      (role=button) opens its input.
//   4. CSS: both pages hide the camera controls under
//      "@media not all and (pointer: coarse)", with selectors that beat every
//      display rule on the same element (the office phone block included),
//      asked of the real cascade by matching each rule against the rendered
//      element. The office phone block hides the completion labels.
//   5. Windows: each page's script marks <html> (p86-no-capture on the
//      office, no-capture on the crew link) when the user agent says
//      "Windows NT", and the CSS hides every camera control under that class
//      even for a finger; an Android or iPhone user agent is not marked.
//
// Each guard is also shown to FIRE: the drive is re-run against a copy of the
// shipped source with that guard broken, and the outcome has to come out
// wrong. The files are CRLF on disk, so the source is EOL-normalized before
// mutating, and an anchor that is missing, repeated, or moves no bytes throws.
'use strict';

const fs = require('fs');
const path = require('path');
const { rules, styleOf } = require('./helpers/css-rules');
const { mediaMatches, specificity } = require('./helpers/css-cascade');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const TICKETS_SRC = read('js/service-tickets.js');
const SHARE_HTML = read('service-ticket-share.html');
const STYLES_SRC = read('css/styles.css');
const JOB_LABEL = require('../js/job-label.js');

function count(src, needle) {
  let n = 0;
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + needle.length)) n++;
  return n;
}

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1) throw new Error('MUTATION ANCHOR NOT FOUND: ' + from);
  if (src.indexOf(from, at + from.length) !== -1) throw new Error('MUTATION ANCHOR NOT UNIQUE: ' + from);
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('MUTATION DID NOT CHANGE THE SOURCE: ' + from);
  return out;
}

// User agents for the Windows mark. jsdom's own says "(win32)", never
// "Windows NT", so an unset one stands for "not Windows" too.
const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 14; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
};

// Every page load starts from an unmarked <html> and jsdom's own user agent;
// a test that names one shadows the getter on this navigator only.
// A user agent, and the screen it comes with: a tablet-sized 1368x912 unless
// the test names one (the Windows mark needs both).
function resetPage(ua, screen) {
  document.documentElement.className = '';
  delete window.navigator.userAgent;
  delete window.screen.width;
  delete window.screen.height;
  if (ua) Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  if (ua || screen) {
    const s = screen || { width: 1368, height: 912 };
    Object.defineProperty(window.screen, 'width', { value: s.width, configurable: true });
    Object.defineProperty(window.screen, 'height', { value: s.height, configurable: true });
  }
}
afterEach(() => resetPage());

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 8; i++) await tick(); }

// Record which inputs .click() is called on, without letting jsdom act on it.
function spyInputClicks() {
  const clicked = [];
  const spy = jest.spyOn(window.HTMLInputElement.prototype, 'click').mockImplementation(function () { clicked.push(this); });
  return { clicked, restore: () => spy.mockRestore() };
}

function pickFile(inp, name) {
  const file = new File(['jpeg-bytes'], name || 'IMG_0001.jpg', { type: 'image/jpeg' });
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return file;
}

// One file input as the tests read it. `control` says which button wraps it.
function describeInput(inp, isCameraLabel) {
  const lab = inp.closest('label');
  return {
    control: lab ? (isCameraLabel(lab) ? 'camera' : 'library') : 'none',
    kind: inp.getAttribute('data-kind'),
    accept: inp.getAttribute('accept'),
    capture: inp.hasAttribute('capture') ? inp.getAttribute('capture') : null,
    multiple: inp.hasAttribute('multiple'),
  };
}

const CAMERA = (kind) => ({ control: 'camera', kind, accept: 'image/*', capture: 'environment', multiple: false });
const LIBRARY = (kind) => ({ control: 'library', kind, accept: 'image/*', capture: null, multiple: true });
const EXPECTED_INPUTS = [CAMERA('completion'), LIBRARY('completion'), CAMERA('before'), LIBRARY('before')];

// ── Office side: js/service-tickets.js ──────────────────────────────────

const OFFICE_TASKS = () => [
  { id: 'tk_784', title: 'Bldg 784 — Side A: rail post; tread 3', status: 'open', photos: [], notes: [] },
  { id: 'tk_790', title: 'Bldg 790 — Side D: stringer', status: 'open',
    photos: [{ id: 'ph_1', kind: 'completion', thumb_url: '/t/1.jpg', web_url: '/w/1.jpg' }], notes: [] },
];

function officeEnv(src, opts) {
  opts = opts || {};
  resetPage(opts.ua, opts.screen);
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="job-service-tickets"></div>';
  window.appState = { currentJobId: 'job_77' };
  window.appData = {
    jobs: [Object.assign({ id: 'job_77', jobNumber: 'M1001', title: 'Latitude stairs' }, opts.readOnly ? { _canEdit: false } : {})],
    leads: [],
  };
  window.p86JobLabel = JOB_LABEL;
  const ticket = {
    id: 'st_1', ticket_number: 'WO-0007', title: 'Replace rotted stair treads', status: opts.status || 'in_progress',
    priority: 'normal', job_id: 'job_77', lead_id: null, materials: [],
  };
  const state = { uploads: [] };
  window.p86Api = {
    serviceTickets: {
      list: jest.fn(() => Promise.resolve({ tickets: [ticket] })),
      get: jest.fn(() => Promise.resolve({ ticket: JSON.parse(JSON.stringify(ticket)), tasks: OFFICE_TASKS(), events: [], revisions: [], participants: [] })),
      materialSources: jest.fn(() => Promise.resolve({ files: [] })),
    },
    attachments: {
      upload: jest.fn((...args) => { state.uploads.push(args); return Promise.resolve({ ok: true }); }),
    },
  };
  window.p86Auth = { hasCapability: () => true };
  window.p86Toast = jest.fn();
  window.p86Confirm = jest.fn(() => Promise.resolve(true));
  window.alert = jest.fn();
  window.confirm = jest.fn();
  delete window.p86ServiceTickets;
  delete window.renderJobServiceTickets;
  window.eval(src);
  return state;
}

async function openTicket() {
  window.renderJobServiceTickets('job_77');
  await flush();
  document.querySelector('#job-service-tickets .p86-st-row-head').click();
  await flush();
  return document.querySelector('#job-service-tickets .p86-st-row.is-open .p86-st-detail');
}

const officeIsCamera = (lab) => lab.classList.contains('p86-wo-cam');
const labelText = (lab) => lab.textContent.replace(/\s+/g, ' ').trim();

// Everything a building card offers for photos.
function officeCard(card) {
  const tiles = Array.from(card.querySelectorAll('.p86-wo-photos .p86-wo-addtile'));
  return {
    tiles: tiles.map((b) => ({ text: labelText(b), camera: b.classList.contains('p86-wo-camtile') })),
    buttons: Array.from(card.querySelectorAll('.p86-wo-sub-actions label')).map(labelText),
    inputs: Array.from(card.querySelectorAll('input[type=file]')).map((i) => describeInput(i, officeIsCamera)),
  };
}

async function officeCards(src, opts) {
  officeEnv(src, opts);
  const d = await openTicket();
  const cards = Array.from(d.querySelectorAll('.p86-wo-sub'));
  return {
    d,
    ids: cards.map((c) => c.getAttribute('data-task')),
    cards: cards.map(officeCard),
    anyFileInput: d.querySelectorAll('input[type=file]').length,
    anyCamera: d.querySelectorAll('.p86-wo-cam, .p86-wo-camtile, [capture]').length,
  };
}

const OFFICE_CARD = {
  tiles: [{ text: 'Take photo', camera: true }, { text: 'Upload photo', camera: false }],
  buttons: ['Take completion photo', 'Upload completion photo', 'Take before photo', 'Upload before photo'],
  inputs: EXPECTED_INPUTS,
};

describe('office: every building card has a camera and a library input for each kind', () => {
  test('both buildings: Take photo tile before Upload photo, and four inputs with the right capture / multiple / kind', async () => {
    const r = await officeCards(TICKETS_SRC);
    expect(r.ids).toEqual(['tk_784', 'tk_790']);
    expect(r.cards).toEqual([OFFICE_CARD, OFFICE_CARD]);
  });

  test('the two completion labels, and only they, carry is-completion (the phone block hides them)', async () => {
    const r = await officeCards(TICKETS_SRC);
    const tagged = Array.from(r.d.querySelectorAll('.p86-wo-sub[data-task="tk_784"] .is-completion')).map((l) => ({
      text: labelText(l),
      kind: l.querySelector('input[type=file]').getAttribute('data-kind'),
    }));
    expect(tagged).toEqual([
      { text: 'Take completion photo', kind: 'completion' },
      { text: 'Upload completion photo', kind: 'completion' },
    ]);
  });

  test('the camera icon is decoration only', async () => {
    const r = await officeCards(TICKETS_SRC);
    const icons = r.d.querySelectorAll('.p86-wo-sub .p86-wo-camico');
    expect(icons.length).toBe(6); // per card: the tile and two camera buttons
    icons.forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
  });

  test('a viewer who cannot edit gets no camera control and no file input at all', async () => {
    const r = await officeCards(TICKETS_SRC, { readOnly: true });
    expect(r.ids).toEqual(['tk_784', 'tk_790']);
    expect(r.cards).toEqual([{ tiles: [], buttons: [], inputs: [] }, { tiles: [], buttons: [], inputs: [] }]);
    expect(r.anyFileInput).toBe(0);
    expect(r.anyCamera).toBe(0);
  });

  test('a closed work order is read-only too', async () => {
    const r = await officeCards(TICKETS_SRC, { status: 'closed' });
    expect(r.anyFileInput).toBe(0);
    expect(r.anyCamera).toBe(0);
  });

  test('FIRES: drop capture="environment" from the completion camera input and it opens the library', async () => {
    const broken = mutate(TICKETS_SRC,
      'Take completion photo<input type="file" accept="image/*" capture="environment" hidden data-kind="completion" />',
      'Take completion photo<input type="file" accept="image/*" hidden data-kind="completion" />');
    const r = await officeCards(broken);
    expect(r.cards[0].inputs[0]).toEqual(Object.assign(CAMERA('completion'), { capture: null }));
    expect(r.cards[0]).not.toEqual(OFFICE_CARD);
  });

  test('FIRES: a multiple camera input, or a before camera input tagged completion, is caught', async () => {
    const multi = await officeCards(mutate(TICKETS_SRC,
      'Take before photo<input type="file" accept="image/*" capture="environment" hidden data-kind="before" />',
      'Take before photo<input type="file" accept="image/*" capture="environment" multiple hidden data-kind="before" />'));
    expect(multi.cards[1].inputs[2]).toEqual(Object.assign(CAMERA('before'), { multiple: true }));
    const wrongKind = await officeCards(mutate(TICKETS_SRC,
      'Take before photo<input type="file" accept="image/*" capture="environment" hidden data-kind="before" />',
      'Take before photo<input type="file" accept="image/*" capture="environment" hidden data-kind="completion" />'));
    expect(wrongKind.cards[0].inputs[2]).toEqual(CAMERA('completion'));
  });

  test('FIRES: capture on the library input is caught (Android would lose the library)', async () => {
    const r = await officeCards(mutate(TICKETS_SRC,
      'Upload completion photo<input type="file" accept="image/*" multiple hidden data-kind="completion" />',
      'Upload completion photo<input type="file" accept="image/*" multiple capture="environment" hidden data-kind="completion" />'));
    expect(r.cards[0].inputs[1]).toEqual(Object.assign(LIBRARY('completion'), { capture: 'environment' }));
  });

  test('FIRES: render the camera tile and buttons without the canEdit gate and a read-only viewer gets them', async () => {
    let broken = mutate(TICKETS_SRC,
      "(canEdit\n            ? '<button type=\"button\" class=\"p86-wo-addtile p86-wo-camtile\"",
      "(true\n            ? '<button type=\"button\" class=\"p86-wo-addtile p86-wo-camtile\"");
    broken = mutate(broken,
      "(canEdit\n          ? '<div class=\"p86-wo-sub-actions\">'",
      "(true\n          ? '<div class=\"p86-wo-sub-actions\">'");
    const r = await officeCards(broken, { readOnly: true });
    expect(r.anyFileInput).toBe(8);
    expect(r.anyCamera).toBeGreaterThan(0);
  });
});

// Click each tile of building 784 and see which inputs were opened.
async function officeTileClicks(src) {
  officeEnv(src);
  const d = await openTicket();
  const card = d.querySelector('.p86-wo-sub[data-task="tk_784"]');
  const spy = spyInputClicks();
  try {
    card.querySelector('.p86-wo-photos .p86-wo-camtile').click();
    const cam = spy.clicked.splice(0);
    Array.from(card.querySelectorAll('.p86-wo-photos .p86-wo-addtile')).find((b) => labelText(b) === 'Upload photo').click();
    const add = spy.clicked.splice(0);
    const view = (list) => list.map((i) => Object.assign(describeInput(i, officeIsCamera), { sameCard: i.closest('.p86-wo-sub') === card }));
    return { cam: view(cam), add: view(add), camInputs: cam, addInputs: add, card };
  } finally {
    spy.restore();
  }
}

describe('office: the tiles open their own completion input', () => {
  test('Take photo clicks the camera completion input only; Upload photo the library one only', async () => {
    const r = await officeTileClicks(TICKETS_SRC);
    expect(r.cam).toEqual([Object.assign(CAMERA('completion'), { sameCard: true })]);
    expect(r.add).toEqual([Object.assign(LIBRARY('completion'), { sameCard: true })]);
  });

  test('FIRES: the Take photo tile wired to the library input opens the library', async () => {
    const r = await officeTileClicks(mutate(TICKETS_SRC,
      'camTile.addEventListener(\'click\', function () { completionCam.click(); });',
      'camTile.addEventListener(\'click\', function () { completionIn.click(); });'));
    expect(r.cam).toEqual([Object.assign(LIBRARY('completion'), { sameCard: true })]);
  });

  test('FIRES: the tile selectors swapped, each tile opens the other input', async () => {
    let broken = mutate(TICKETS_SRC,
      "var camTile = card.querySelector('.p86-wo-camtile');",
      "var camTile = card.querySelector('.p86-wo-addtile:not(.p86-wo-camtile)');");
    broken = mutate(broken,
      "var addTile = card.querySelector('.p86-wo-addtile:not(.p86-wo-camtile)');",
      "var addTile = card.querySelector('.p86-wo-camtile');");
    const r = await officeTileClicks(broken);
    expect(r.cam).toEqual([Object.assign(LIBRARY('completion'), { sameCard: true })]);
    expect(r.add).toEqual([Object.assign(CAMERA('completion'), { sameCard: true })]);
  });

  test('FIRES: drop :not(.p86-wo-cam) from the library lookup and Upload photo opens the camera', async () => {
    const r = await officeTileClicks(mutate(TICKETS_SRC,
      "var completionIn = card.querySelector('.p86-wo-up:not(.p86-wo-cam) input[data-kind=\"completion\"]');",
      "var completionIn = card.querySelector('.p86-wo-up input[data-kind=\"completion\"]');"));
    expect(r.add).toEqual([Object.assign(CAMERA('completion'), { sameCard: true })]);
  });
});

// Pick a file on one of building 784's camera inputs, found by its button text
// (not by its attributes, so a mutated data-kind is still found).
async function officeCameraUpload(src, buttonText) {
  const s = officeEnv(src);
  const d = await openTicket();
  const card = d.querySelector('.p86-wo-sub[data-task="tk_784"]');
  const lab = Array.from(card.querySelectorAll('.p86-wo-sub-actions label')).find((l) => labelText(l) === buttonText);
  const gets = window.p86Api.serviceTickets.get.mock.calls.length;
  const file = pickFile(lab.querySelector('input[type=file]'));
  await flush();
  return {
    uploads: s.uploads.map((a) => [a[0], a[1], a[2] === file ? 'the picked file' : a[2], a[3]]),
    refreshed: window.p86Api.serviceTickets.get.mock.calls.length > gets,
  };
}

describe('office: a camera shot uploads down the same path as a library pick', () => {
  test('Take completion photo uploads to the building task tagged completion, then refreshes', async () => {
    const r = await officeCameraUpload(TICKETS_SRC, 'Take completion photo');
    expect(r.uploads).toEqual([['task', 'tk_784', 'the picked file', { tags: 'completion' }]]);
    expect(r.refreshed).toBe(true);
  });

  test('Take before photo uploads tagged before', async () => {
    const r = await officeCameraUpload(TICKETS_SRC, 'Take before photo');
    expect(r.uploads).toEqual([['task', 'tk_784', 'the picked file', { tags: 'before' }]]);
  });

  test('FIRES: wire only the library inputs and a camera shot is never uploaded', async () => {
    const r = await officeCameraUpload(mutate(TICKETS_SRC,
      "card.querySelectorAll('.p86-wo-up input[type=file]')",
      "card.querySelectorAll('.p86-wo-up:not(.p86-wo-cam) input[type=file]')"), 'Take completion photo');
    expect(r.uploads).toEqual([]);
  });

  test('FIRES: a before camera input tagged completion files the shot as a completion photo', async () => {
    const r = await officeCameraUpload(mutate(TICKETS_SRC,
      'Take before photo<input type="file" accept="image/*" capture="environment" hidden data-kind="before" />',
      'Take before photo<input type="file" accept="image/*" capture="environment" hidden data-kind="completion" />'), 'Take before photo');
    expect(r.uploads).toEqual([['task', 'tk_784', 'the picked file', { tags: 'completion' }]]);
  });
});

// ── Crew side: service-ticket-share.html ────────────────────────────────

const TOKEN = 'cd'.repeat(32);
const SHARE_SCRIPT = (() => {
  const open = SHARE_HTML.lastIndexOf('<script>');
  const close = SHARE_HTML.indexOf('</script>', open);
  if (open === -1 || close === -1) throw new Error('share page script not found');
  return SHARE_HTML.slice(open + '<script>'.length, close);
})();

const CREW_TASKS = () => [
  { id: 'tk_784', title: 'Bldg 784 — Side A: rail post; tread 3', done: false, photos: [], notes: [] },
  { id: 'tk_790', title: 'Bldg 790 — Side D: stringer', done: false,
    photos: [{ kind: 'completion', thumb_url: '/t/1.jpg', web_url: '/w/1.jpg' }], notes: [] },
];

async function crewEnv(script, opts) {
  opts = opts || {};
  resetPage(opts.ua, opts.screen);
  document.head.innerHTML = '';
  document.body.innerHTML = '<div class="wrap" id="root"><div class="fatal" id="boot">Loading…</div></div>';
  window.history.replaceState({}, '', '/st/' + TOKEN);
  const payload = {
    ticket: { id: 'st_1', title: 'Replace rotted stair treads', ticket_number: 'WO-0007', status: opts.status || 'in_progress', materials: [] },
    share: { scope: opts.scope || 'respond', hide_financials: true, recipient_name: 'Rafael' },
    tasks: CREW_TASKS(),
  };
  const calls = [];
  window.fetch = jest.fn((url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const body = init && init.method === 'POST' ? { ok: true } : payload;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
  });
  window.eval(script || SHARE_SCRIPT);
  await flush();
  return { calls };
}

const crewIsCamera = (lab) => lab.classList.contains('th-cam') || lab.classList.contains('cam-btn');

function crewCard(card) {
  return {
    tiles: Array.from(card.querySelectorAll('.shots label.th-add')).map((l) => ({ text: labelText(l), camera: l.classList.contains('th-cam') })),
    beforeButtons: Array.from(card.querySelectorAll('.before-add label')).map((l) => ({ text: labelText(l), camera: l.classList.contains('cam-btn') })),
    inputs: Array.from(card.querySelectorAll('input[type=file]')).map((i) => describeInput(i, crewIsCamera)),
  };
}

async function crewCards(script, opts) {
  await crewEnv(script, opts);
  const cards = Array.from(document.querySelectorAll('#root .bld'));
  return {
    ids: cards.map((c) => c.getAttribute('data-task')),
    cards: cards.map(crewCard),
    anyFileInput: document.querySelectorAll('input[type=file]').length,
    bldFileInput: document.querySelectorAll('.bld input[type=file]').length,
    anyCamera: document.querySelectorAll('.th-cam, .cam-btn, [capture]').length,
  };
}

const CREW_CARD = {
  tiles: [{ text: 'Take photo', camera: true }, { text: '+Upload photo', camera: false }],
  beforeButtons: [{ text: 'Take before photo', camera: true }, { text: 'Upload before photo', camera: false }],
  inputs: EXPECTED_INPUTS,
};
const NO_CONTROLS = { tiles: [], beforeButtons: [], inputs: [] };

describe('crew link: every building card has a camera and a library input for each kind', () => {
  test('both buildings on a respond link: Take photo before Upload photo, Take before photo before Upload before photo', async () => {
    const r = await crewCards();
    expect(r.ids).toEqual(['tk_784', 'tk_790']);
    expect(r.cards).toEqual([CREW_CARD, CREW_CARD]);
  });

  test('the camera controls are keyboard buttons like the rest', async () => {
    await crewEnv();
    const cams = Array.from(document.querySelectorAll('.bld .th-cam, .bld .cam-btn'));
    expect(cams.length).toBe(4);
    cams.forEach((l) => {
      expect(l.tagName).toBe('LABEL');
      expect(l.getAttribute('role')).toBe('button');
      expect(l.getAttribute('tabindex')).toBe('0');
      expect(l.querySelector('svg.camico').getAttribute('aria-hidden')).toBe('true');
    });
  });

  test('a view-only link: no camera control and no file input anywhere on the page', async () => {
    const r = await crewCards(undefined, { scope: 'view' });
    expect(r.ids).toEqual(['tk_784', 'tk_790']);
    // tk_790 still shows its completion photo, with no tiles after it.
    expect(document.querySelectorAll('.bld[data-task="tk_790"] .shots .shot').length).toBe(1);
    expect(r.cards).toEqual([NO_CONTROLS, NO_CONTROLS]);
    expect(r.anyFileInput).toBe(0);
    expect(r.anyCamera).toBe(0);
  });

  test('a respond link on an approved or draft work order cannot work the punch list either', async () => {
    const approved = await crewCards(undefined, { status: 'approved' });
    expect(approved.cards).toEqual([NO_CONTROLS, NO_CONTROLS]);
    expect(approved.anyCamera).toBe(0);
    const draft = await crewCards(undefined, { status: 'draft' });
    expect(draft.cards).toEqual([NO_CONTROLS, NO_CONTROLS]);
    expect(draft.bldFileInput).toBe(0);
    expect(draft.anyCamera).toBe(0);
  });

  test('FIRES: drop capture from the Take photo tile input and it opens the library', async () => {
    const r = await crewCards(mutate(SHARE_SCRIPT,
      '\'<input type="file" accept="image/*" capture="environment" data-kind="completion" />\'',
      '\'<input type="file" accept="image/*" data-kind="completion" />\''));
    expect(r.cards[0].inputs[0]).toEqual(Object.assign(CAMERA('completion'), { capture: null }));
  });

  test('FIRES: a multiple before camera input, or capture on the library before input, is caught', async () => {
    const multi = await crewCards(mutate(SHARE_SCRIPT,
      'Take before photo<input type="file" accept="image/*" capture="environment" data-kind="before" />',
      'Take before photo<input type="file" accept="image/*" capture="environment" multiple data-kind="before" />'));
    expect(multi.cards[0].inputs[2]).toEqual(Object.assign(CAMERA('before'), { multiple: true }));
    const cap = await crewCards(mutate(SHARE_SCRIPT,
      'Upload before photo<input type="file" accept="image/*" multiple data-kind="before" />',
      'Upload before photo<input type="file" accept="image/*" multiple capture="environment" data-kind="before" />'));
    expect(cap.cards[1].inputs[3]).toEqual(Object.assign(LIBRARY('before'), { capture: 'environment' }));
  });

  test('FIRES: render the Take photo tile without the canWork gate and a view-only link gets a camera', async () => {
    const r = await crewCards(mutate(SHARE_SCRIPT,
      "(canWork\n                  ? '<label class=\"th-add th-cam\"",
      "(true\n                  ? '<label class=\"th-add th-cam\""), { scope: 'view' });
    expect(r.anyCamera).toBeGreaterThan(0);
    expect(r.anyFileInput).toBeGreaterThan(0);
  });
});

// Pick a file on one of building 784's camera inputs, found by label text.
async function crewCameraUpload(script, text) {
  const env = await crewEnv(script);
  const card = document.querySelector('.bld[data-task="tk_784"]');
  const lab = Array.from(card.querySelectorAll('label')).find((l) => labelText(l) === text);
  env.calls.length = 0;
  pickFile(lab.querySelector('input[type=file]'), 'IMG_0042.jpg');
  await flush();
  return env.calls.filter((c) => c.init.method === 'POST').map((c) => {
    const fd = c.init.body;
    const isForm = fd instanceof FormData;
    return {
      url: c.url,
      isForm,
      kind: isForm ? fd.get('kind') : null,
      file: isForm && fd.get('file') ? fd.get('file').name : null,
    };
  });
}

const PHOTO_DOOR = '/api/service-ticket-share/' + TOKEN + '/subtasks/tk_784/photo';

describe('crew link: a camera shot goes to the building photo door', () => {
  test('Take photo POSTs FormData with kind=completion and the file', async () => {
    const posts = await crewCameraUpload(undefined, 'Take photo');
    expect(posts).toEqual([{ url: PHOTO_DOOR, isForm: true, kind: 'completion', file: 'IMG_0042.jpg' }]);
  });

  test('Take before photo POSTs FormData with kind=before', async () => {
    const posts = await crewCameraUpload(undefined, 'Take before photo');
    expect(posts).toEqual([{ url: PHOTO_DOOR, isForm: true, kind: 'before', file: 'IMG_0042.jpg' }]);
  });

  test('FIRES: wire only the multiple inputs and a camera shot is never sent', async () => {
    const posts = await crewCameraUpload(mutate(SHARE_SCRIPT,
      "card.querySelectorAll('input[type=file]')",
      "card.querySelectorAll('input[type=file][multiple]')"), 'Take photo');
    expect(posts).toEqual([]);
  });

  test('FIRES: a before camera input tagged completion sends kind=completion', async () => {
    const posts = await crewCameraUpload(mutate(SHARE_SCRIPT,
      'Take before photo<input type="file" accept="image/*" capture="environment" data-kind="before" />',
      'Take before photo<input type="file" accept="image/*" capture="environment" data-kind="completion" />'), 'Take before photo');
    expect(posts).toEqual([{ url: PHOTO_DOOR, isForm: true, kind: 'completion', file: 'IMG_0042.jpg' }]);
  });
});

async function crewEnter(script, selector) {
  await crewEnv(script);
  const card = document.querySelector('.bld[data-task="tk_784"]');
  const lab = card.querySelector(selector);
  const spy = spyInputClicks();
  try {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    lab.dispatchEvent(ev);
    return {
      clicked: spy.clicked.map((i) => Object.assign(describeInput(i, crewIsCamera), { own: i.parentNode === lab })),
      prevented: ev.defaultPrevented,
    };
  } finally {
    spy.restore();
  }
}

describe('crew link: Enter on a camera label opens its input', () => {
  test('Enter on Take photo clicks the camera completion input', async () => {
    const r = await crewEnter(undefined, 'label.th-add.th-cam');
    expect(r.clicked).toEqual([Object.assign(CAMERA('completion'), { own: true })]);
    expect(r.prevented).toBe(true);
  });

  test('Enter on Take before photo clicks the camera before input', async () => {
    const r = await crewEnter(undefined, 'label.cam-btn');
    expect(r.clicked).toEqual([Object.assign(CAMERA('before'), { own: true })]);
  });

  test('FIRES: without role=button on the Take photo tile, Enter does nothing', async () => {
    const r = await crewEnter(mutate(SHARE_SCRIPT,
      '\'<label class="th-add th-cam" tabindex="0" role="button">\'',
      '\'<label class="th-add th-cam" tabindex="0">\''), 'label.th-add.th-cam');
    expect(r.clicked).toEqual([]);
  });

  test('FIRES: a keydown handler that only knows Space ignores Enter', async () => {
    const r = await crewEnter(mutate(SHARE_SCRIPT,
      "if (e.key !== 'Enter' && e.key !== ' ') return;",
      "if (e.key !== ' ') return;"), 'label.th-add.th-cam');
    expect(r.clicked).toEqual([]);
  });
});

// ── CSS: camera controls only where the main pointer is a finger ─────────
//
// jsdom applies no media query, so the cascade is asked here: every rule that
// sets `display` is matched against the RENDERED element with
// element.matches(), and the winner at a given size and pointer is picked by
// importance, specificity, then source order. css-cascade.js reads media
// features but not `not`, so the query is negated here.

const HIDE_MEDIA = 'not all and (pointer: coarse)';
const PHONE = { width: 390, pointer: 'coarse', label: '390px touch phone' };
const TABLET = { width: 1024, pointer: 'coarse', label: '1024px touch tablet' };
const MOUSE_NARROW = { width: 700, pointer: 'fine', label: '700px mouse window' };
const DESKTOP = { width: 1280, pointer: 'fine', label: '1280px desktop' };

function splitTop(text, sep) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

function mq(list, env) {
  return list.every((q) => splitTop(q, ',').some((one) => {
    one = one.trim();
    const neg = /^not\s+/i.test(one);
    const hit = mediaMatches([one.replace(/^(not|only)\s+/i, '')], env);
    return neg ? !hit : hit;
  }));
}

function cmp(x, y) {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

const PSEUDO_ELEMENT = /::|:(before|after|first-line|first-letter)\b/i;

// Every display declaration whose selector matches the element, in any media.
function displayRulesFor(sheet, el) {
  const out = [];
  const unreadable = [];
  for (const rule of sheet) {
    const decls = rule.decls.map((d, di) => ({ d, di })).filter((x) => x.d.prop === 'display');
    if (!decls.length) continue;
    for (const sel of rule.selectors) {
      if (PSEUDO_ELEMENT.test(sel)) continue;
      let hit = false;
      try { hit = el.matches(sel); } catch (e) { unreadable.push(sel); continue; }
      if (!hit) continue;
      for (const { d, di } of decls) {
        out.push({
          selector: sel,
          media: rule.media,
          value: d.value.replace(/\s*!important\s*$/i, ''),
          important: /!important/i.test(d.value),
          spec: specificity(sel),
          order: rule.order,
          di,
        });
      }
    }
  }
  // A selector jsdom cannot read must not be one that could name this element.
  const names = Array.from(el.classList).map((c) => '.' + c);
  const relevant = unreadable.filter((s) => names.some((n) => new RegExp('\\' + n + '(?![\\w-])').test(s)));
  return { all: out, relevant };
}

const keyOf = (c) => [c.important ? 1 : 0].concat(c.spec, [c.order, c.di]);

function displayAt(cands, env) {
  let best = null;
  for (const c of cands) {
    if (!mq(c.media, env)) continue;
    if (!best || cmp(keyOf(c), keyOf(best)) >= 0) best = c;
  }
  return best ? { value: best.value, selector: best.selector, media: best.media.join(' / ') } : null;
}
const shown = (r) => (r ? r.value : '(no rule)');

// The strongest hide rule on the element, and every display rule it has to
// beat when both apply. "Beat" is importance, then specificity, then order.
function hideVersusRest(cands) {
  const hides = cands.filter((c) => c.media.length === 1 && c.media[0] === HIDE_MEDIA && c.value === 'none');
  const best = hides.reduce((p, c) => (!p || cmp(keyOf(c), keyOf(p)) > 0 ? c : p), null);
  const rest = cands.filter((c) => !hides.includes(c) && c.value !== 'none');
  return {
    best: best ? { selector: best.selector, spec: best.spec } : null,
    losers: best ? rest.filter((c) => cmp(keyOf(best), keyOf(c)) > 0).map((c) => c.selector) : [],
    winners: best ? rest.filter((c) => cmp(keyOf(best), keyOf(c)) <= 0).map((c) => ({ selector: c.selector, spec: c.spec, media: c.media.join(' / ') })) : rest.map((c) => c.selector),
    specAtLeastAll: !!best && rest.every((c) => cmp(best.spec, c.spec) >= 0),
    rest,
  };
}

// The office's photo controls on building 784, rendered by the real script.
async function officeElements(src, opts) {
  officeEnv(src || TICKETS_SRC, opts);
  const d = await openTicket();
  const card = d.querySelector('.p86-wo-sub[data-task="tk_784"]');
  const labels = Array.from(card.querySelectorAll('.p86-wo-sub-actions label'));
  const tiles = Array.from(card.querySelectorAll('.p86-wo-photos .p86-wo-addtile'));
  return {
    camTile: tiles.find((b) => labelText(b) === 'Take photo'),
    addTile: tiles.find((b) => labelText(b) === 'Upload photo'),
    camButton: labels.find((l) => labelText(l) === 'Take completion photo'),
    uploadButton: labels.find((l) => labelText(l) === 'Upload completion photo'),
    camBeforeButton: labels.find((l) => labelText(l) === 'Take before photo'),
    uploadBeforeButton: labels.find((l) => labelText(l) === 'Upload before photo'),
  };
}

const OFFICE_NODES = ['camTile', 'addTile', 'camButton', 'uploadButton', 'camBeforeButton', 'uploadBeforeButton'];

// What each of building 784's photo controls computes to in one environment.
function officeDisplays(sheet, el, env) {
  const out = {};
  for (const k of OFFICE_NODES) {
    const { all, relevant } = displayRulesFor(sheet, el[k]);
    if (relevant.length) throw new Error('unreadable selector names ' + k + ': ' + relevant.join(' | '));
    out[k] = shown(displayAt(all, env));
  }
  return out;
}

const HIDE_BLOCK_OFFICE =
  '@media not all and (pointer: coarse) {\n' +
  '  .p86-wo-up.p86-wo-cam,\n' +
  '  .p86-wo-addtile.p86-wo-camtile,\n' +
  '  #job-service-tickets .p86-wo-sub-actions .p86-wo-up.p86-wo-cam,\n' +
  '  #job-service-tickets .p86-wo-photos .p86-wo-addtile.p86-wo-camtile { display: none; }\n' +
  '}';

describe('styles.css: the office camera controls show only for a finger', () => {
  const STYLES = rules(STYLES_SRC);

  test('one "@media not all and (pointer: coarse)" block hides both camera controls, with and without #job-service-tickets', () => {
    expect(count(STYLES_SRC, '@media not all and (pointer: coarse) {')).toBe(1);
    const hideSels = STYLES
      .filter((r) => r.media.length === 1 && r.media[0] === HIDE_MEDIA && r.decls.some((d) => d.prop === 'display' && d.value === 'none'))
      .reduce((a, r) => a.concat(r.selectors), []);
    expect(hideSels).toEqual(expect.arrayContaining(['.p86-wo-up.p86-wo-cam', '.p86-wo-addtile.p86-wo-camtile']));
    expect(hideSels.filter((s) => /^#job-service-tickets .*\.p86-wo-up\.p86-wo-cam$/.test(s)).length).toBeGreaterThan(0);
    expect(hideSels.filter((s) => /^#job-service-tickets .*\.p86-wo-addtile\.p86-wo-camtile$/.test(s)).length).toBeGreaterThan(0);
  });

  test('every hide selector outranks the phone block display rule on the same element', async () => {
    const el = await officeElements();
    const cases = [
      [el.camTile, ['#job-service-tickets .p86-wo-addtile']],
      [el.camButton, ['#job-service-tickets .p86-wo-sub-actions .p86-wo-up']],
      [el.camBeforeButton, ['#job-service-tickets .p86-wo-sub-actions .p86-wo-up']],
    ];
    for (const [node, phoneSels] of cases) {
      const { all, relevant } = displayRulesFor(STYLES, node);
      expect(relevant).toEqual([]);
      const phone = all.filter((c) => c.media.join(' / ') === '(max-width: 760px)' && c.value !== 'none');
      expect(phone.map((c) => c.selector)).toEqual(phoneSels);
      const hides = all.filter((c) => c.media.length === 1 && c.media[0] === HIDE_MEDIA);
      // Both hide selectors that name this element, the plain and the prefixed.
      expect(hides.length).toBe(2);
      for (const h of hides.filter((c) => c.selector.startsWith('#job-service-tickets '))) {
        for (const p of phone) expect(cmp(h.spec, p.spec)).toBeGreaterThanOrEqual(0);
      }
      const v = hideVersusRest(all);
      expect(v.specAtLeastAll).toBe(true);
      expect(v.winners).toEqual([]);
    }
  });

  // Per environment, building 784's six controls. On a phone the tiles are
  // the completion controls, so both completion labels are hidden there
  // whatever the pointer; the before pair stays, Take before photo for a
  // finger only. Above 760px the tiles are gone and the labels are
  // inline-flex, the Take ones again for a finger only.
  const OFFICE_CASCADE = {
    [PHONE.label]: {
      camTile: 'flex', addTile: 'flex',
      camButton: 'none', uploadButton: 'none',
      camBeforeButton: 'flex', uploadBeforeButton: 'flex',
    },
    [MOUSE_NARROW.label]: {
      camTile: 'none', addTile: 'flex',
      camButton: 'none', uploadButton: 'none',
      camBeforeButton: 'none', uploadBeforeButton: 'flex',
    },
    [TABLET.label]: {
      camTile: 'none', addTile: 'none',
      camButton: 'inline-flex', uploadButton: 'inline-flex',
      camBeforeButton: 'inline-flex', uploadBeforeButton: 'inline-flex',
    },
    [DESKTOP.label]: {
      camTile: 'none', addTile: 'none',
      camButton: 'none', uploadButton: 'inline-flex',
      camBeforeButton: 'none', uploadBeforeButton: 'inline-flex',
    },
  };
  const ENVS = [PHONE, MOUSE_NARROW, TABLET, DESKTOP];
  const cascadeOf = (sheet, el) => Object.fromEntries(ENVS.map((env) => [env.label, officeDisplays(sheet, el, env)]));

  test('the cascade: phone tiles replace the completion labels; camera controls only for a finger; labels inline-flex above 760px', async () => {
    const el = await officeElements();
    expect(cascadeOf(STYLES, el)).toEqual(OFFICE_CASCADE);
  });

  test('the inline-flex label rule is the one that wins above 760px, for a mouse and a finger', async () => {
    const el = await officeElements();
    for (const k of ['uploadButton', 'uploadBeforeButton']) {
      for (const env of [TABLET, DESKTOP]) {
        expect(displayAt(displayRulesFor(STYLES, el[k]).all, env)).toEqual({ value: 'inline-flex', selector: '.p86-wo-sub-actions .p86-wo-up', media: '' });
      }
    }
  });

  test('FIRES: without the inline-flex label rule the desktop labels fall back to the label default', async () => {
    const broken = rules(mutate(STYLES_SRC,
      '.p86-wo-sub-actions .p86-wo-up { display: inline-flex; align-items: center; }\n', ''));
    const el = await officeElements();
    const c = cascadeOf(broken, el);
    expect(c[DESKTOP.label].uploadButton).not.toBe('inline-flex');
    expect(c[TABLET.label].camBeforeButton).not.toBe('inline-flex');
    expect(c).not.toEqual(OFFICE_CASCADE);
  });

  test('FIRES: without the prefixed selectors the phone block wins in a narrow mouse window', async () => {
    expect(count(STYLES_SRC, HIDE_BLOCK_OFFICE)).toBe(1);
    const broken = rules(mutate(STYLES_SRC,
      '  .p86-wo-addtile.p86-wo-camtile,\n' +
      '  #job-service-tickets .p86-wo-sub-actions .p86-wo-up.p86-wo-cam,\n' +
      '  #job-service-tickets .p86-wo-photos .p86-wo-addtile.p86-wo-camtile { display: none; }',
      '  .p86-wo-addtile.p86-wo-camtile { display: none; }'));
    const el = await officeElements();
    // Take completion photo is hidden on a phone width by .is-completion
    // anyway, so the camera tile and Take before photo show the leak.
    for (const node of [el.camTile, el.camButton, el.camBeforeButton]) {
      const v = hideVersusRest(displayRulesFor(broken, node).all);
      expect(v.specAtLeastAll).toBe(false);
      expect(v.winners.map((w) => w.media)).toContain('(max-width: 760px)');
    }
    const narrow = officeDisplays(broken, el, MOUSE_NARROW);
    expect(narrow.camTile).toBe('flex');
    expect(narrow.camBeforeButton).toBe('flex');
  });

  test('FIRES: remove the phone .is-completion rule and both completion labels show on a phone beside the tiles', async () => {
    const IS_COMPLETION_RULE = '  #job-service-tickets .p86-wo-sub-actions .p86-wo-up.is-completion { display: none; }\n';
    const broken = rules(mutate(STYLES_SRC, IS_COMPLETION_RULE, ''));
    const el = await officeElements();
    const phone = officeDisplays(broken, el, PHONE);
    expect(phone).toMatchObject({ camTile: 'flex', addTile: 'flex', camButton: 'flex', uploadButton: 'flex' });
    expect(officeDisplays(broken, el, MOUSE_NARROW).uploadButton).toBe('flex');
    expect(cascadeOf(broken, el)).not.toEqual(OFFICE_CASCADE);
  });

  test('FIRES: drop is-completion from the Upload completion label and it shows on a phone beside Upload photo', async () => {
    const el = await officeElements(mutate(TICKETS_SRC,
      '<label class="ee-btn primary p86-wo-up is-completion">Upload completion photo',
      '<label class="ee-btn primary p86-wo-up">Upload completion photo'));
    expect(officeDisplays(STYLES, el, PHONE)).toMatchObject({ addTile: 'flex', camButton: 'none', uploadButton: 'flex' });
  });

  test('FIRES: remove the hide block and the camera controls show on a computer', async () => {
    const broken = rules(mutate(STYLES_SRC, HIDE_BLOCK_OFFICE, ''));
    const el = await officeElements();
    expect(hideVersusRest(displayRulesFor(broken, el.camButton).all).best).toBeNull();
    expect(shown(displayAt(displayRulesFor(broken, el.camTile).all, MOUSE_NARROW))).toBe('flex');
    expect(shown(displayAt(displayRulesFor(broken, el.camButton).all, DESKTOP))).not.toBe('none');
  });

  test('FIRES: drop the `not` and the camera controls vanish from the phone', async () => {
    const broken = rules(mutate(STYLES_SRC, '@media not all and (pointer: coarse) {', '@media (pointer: coarse) {'));
    const el = await officeElements();
    expect(officeDisplays(STYLES, el, PHONE)).toMatchObject({ camTile: 'flex', camBeforeButton: 'flex' });
    // (Take completion photo is hidden on a phone by .is-completion either way.)
    expect(officeDisplays(broken, el, PHONE)).toMatchObject({ camTile: 'none', camBeforeButton: 'none' });
    expect(officeDisplays(broken, el, TABLET).camButton).toBe('none');
  });
});

// ── On a phone the tiles open the hidden completion inputs ───────────────

describe('office phone: the tiles still open, and upload through, the hidden completion inputs', () => {
  const STYLES = rules(STYLES_SRC);
  const labelDisplay = (inp, env) => shown(displayAt(displayRulesFor(STYLES, inp.closest('label')).all, env));

  test('Take photo and Upload photo show on a phone, their inputs sit in hidden labels, and each tile opens its own', async () => {
    const r = await officeTileClicks(TICKETS_SRC);
    expect(r.cam).toEqual([Object.assign(CAMERA('completion'), { sameCard: true })]);
    expect(r.add).toEqual([Object.assign(LIBRARY('completion'), { sameCard: true })]);
    const tileDisplay = (sel) => shown(displayAt(displayRulesFor(STYLES, r.card.querySelector(sel)).all, PHONE));
    expect(tileDisplay('.p86-wo-camtile')).toBe('flex');
    expect(tileDisplay('.p86-wo-addtile:not(.p86-wo-camtile)')).toBe('flex');
    expect(labelDisplay(r.camInputs[0], PHONE)).toBe('none');
    expect(labelDisplay(r.addInputs[0], PHONE)).toBe('none');
    expect(labelDisplay(r.addInputs[0], MOUSE_NARROW)).toBe('none');
  });

  test('a file picked through the Upload photo tile uploads tagged completion and refreshes', async () => {
    const r = await officeTileClicks(TICKETS_SRC);
    const uploads = window.p86Api.attachments.upload.mock.calls;
    const gets = window.p86Api.serviceTickets.get.mock.calls.length;
    const file = pickFile(r.addInputs[0]);
    await flush();
    expect(uploads.map((a) => [a[0], a[1], a[2] === file ? 'the picked file' : a[2], a[3]]))
      .toEqual([['task', 'tk_784', 'the picked file', { tags: 'completion' }]]);
    expect(window.p86Api.serviceTickets.get.mock.calls.length).toBeGreaterThan(gets);
  });

  test('FIRES: the completion labels dropped from the markup ("hidden on a phone anyway") and neither tile opens anything', async () => {
    let broken = mutate(TICKETS_SRC,
      "'<label class=\"ee-btn primary p86-wo-up p86-wo-cam is-completion\">' + CAM_ICON_BTN + 'Take completion photo<input type=\"file\" accept=\"image/*\" capture=\"environment\" hidden data-kind=\"completion\" /></label>' +\n",
      '');
    broken = mutate(broken,
      "'<label class=\"ee-btn primary p86-wo-up is-completion\">Upload completion photo<input type=\"file\" accept=\"image/*\" multiple hidden data-kind=\"completion\" /></label>' +\n",
      '');
    const r = await officeTileClicks(broken);
    expect(r.cam).toEqual([]);
    expect(r.add).toEqual([]);
  });

  test('FIRES: a lookup that skips the hidden completion labels leaves the Upload photo tile dead', async () => {
    const r = await officeTileClicks(mutate(TICKETS_SRC,
      "var completionIn = card.querySelector('.p86-wo-up:not(.p86-wo-cam) input[data-kind=\"completion\"]');",
      "var completionIn = card.querySelector('.p86-wo-up:not(.p86-wo-cam):not(.is-completion) input[data-kind=\"completion\"]');"));
    expect(r.cam).toEqual([Object.assign(CAMERA('completion'), { sameCard: true })]);
    expect(r.add).toEqual([]);
  });
});

// ── Windows: no camera control, whatever the pointer ─────────────────────

describe('office on Windows: service-tickets.js marks <html> p86-no-capture and styles.css hides every camera control', () => {
  const STYLES = rules(STYLES_SRC);
  const MARK_JS = "document.documentElement.classList.add('p86-no-capture');";
  const NO_CAPTURE_BLOCK =
    '.p86-no-capture .p86-wo-up.p86-wo-cam,\n' +
    '.p86-no-capture .p86-wo-addtile.p86-wo-camtile,\n' +
    '.p86-no-capture #job-service-tickets .p86-wo-sub-actions .p86-wo-up.p86-wo-cam,\n' +
    '.p86-no-capture #job-service-tickets .p86-wo-photos .p86-wo-addtile.p86-wo-camtile { display: none; }\n';
  const CAMERA_OFF = { camTile: 'none', camButton: 'none', camBeforeButton: 'none' };
  const marked = () => document.documentElement.classList.contains('p86-no-capture');

  test('a Windows NT user agent marks the page; Android, iPhone and jsdom do not', async () => {
    officeEnv(TICKETS_SRC, { ua: UA.windows });
    expect(marked()).toBe(true);
    for (const ua of [UA.android, UA.iphone, undefined]) {
      officeEnv(TICKETS_SRC, { ua });
      expect(window.navigator.userAgent).toEqual(ua || expect.not.stringContaining('Windows NT'));
      expect(marked()).toBe(false);
    }
  });

  test('marked, every camera control is hidden even for a finger; the library controls are untouched', async () => {
    expect(count(STYLES_SRC, NO_CAPTURE_BLOCK)).toBe(1);
    const el = await officeElements(TICKETS_SRC, { ua: UA.windows });
    expect(marked()).toBe(true);
    const phone = officeDisplays(STYLES, el, PHONE);
    const tablet = officeDisplays(STYLES, el, TABLET);
    expect(phone).toEqual({ camTile: 'none', addTile: 'flex', camButton: 'none', uploadButton: 'none', camBeforeButton: 'none', uploadBeforeButton: 'flex' });
    expect(tablet).toEqual({ camTile: 'none', addTile: 'none', camButton: 'none', uploadButton: 'inline-flex', camBeforeButton: 'none', uploadBeforeButton: 'inline-flex' });
    expect(officeDisplays(STYLES, el, MOUSE_NARROW)).toMatchObject(CAMERA_OFF);
    expect(officeDisplays(STYLES, el, DESKTOP)).toMatchObject(CAMERA_OFF);
  });

  test('unmarked (Android), a finger keeps its camera controls', async () => {
    const el = await officeElements(TICKETS_SRC, { ua: UA.android });
    expect(marked()).toBe(false);
    expect(officeDisplays(STYLES, el, PHONE)).toMatchObject({ camTile: 'flex', camBeforeButton: 'flex' });
    expect(officeDisplays(STYLES, el, TABLET)).toMatchObject({ camButton: 'inline-flex', camBeforeButton: 'inline-flex' });
  });

  test('FIRES: without the mark in service-tickets.js a Windows tablet shows Take photo', async () => {
    const broken = mutate(TICKETS_SRC, MARK_JS, 'void 0; /* unmarked */');
    const el = await officeElements(broken, { ua: UA.windows });
    expect(marked()).toBe(false);
    expect(officeDisplays(STYLES, el, TABLET)).toMatchObject({ camButton: 'inline-flex', camBeforeButton: 'inline-flex' });
    expect(officeDisplays(STYLES, el, PHONE)).toMatchObject({ camTile: 'flex', camBeforeButton: 'flex' });
  });

  test('a phone sending a Windows user agent (a desktop-site request) keeps its camera', async () => {
    const el = await officeElements(TICKETS_SRC, { ua: UA.windows, screen: { width: 412, height: 915 } });
    expect(marked()).toBe(false);
    expect(officeDisplays(STYLES, el, PHONE)).toMatchObject({ camTile: 'flex', camBeforeButton: 'flex' });
  });

  test('FIRES: the Windows mark without its screen-size test hides the camera on that phone', async () => {
    const broken = mutate(TICKETS_SRC, ' && Math.min(screen.width || 0, screen.height || 0) >= 600', '');
    const el = await officeElements(broken, { ua: UA.windows, screen: { width: 412, height: 915 } });
    expect(marked()).toBe(true);
    expect(officeDisplays(STYLES, el, PHONE)).toMatchObject({ camTile: 'none', camBeforeButton: 'none' });
  });

  test('FIRES: the mark without its Windows NT test hides the camera on an Android phone', async () => {
    const broken = mutate(TICKETS_SRC, 'if (/Windows NT/.test(navigator.userAgent) && Math.min(screen.width || 0, screen.height || 0) >= 600) ' + MARK_JS, MARK_JS);
    const el = await officeElements(broken, { ua: UA.android });
    expect(marked()).toBe(true);
    expect(officeDisplays(STYLES, el, PHONE)).toMatchObject({ camTile: 'none', camBeforeButton: 'none' });
  });

  test('FIRES: remove the no-capture CSS and a marked Windows tablet and phone show the camera', async () => {
    const broken = rules(mutate(STYLES_SRC, NO_CAPTURE_BLOCK, ''));
    const el = await officeElements(TICKETS_SRC, { ua: UA.windows });
    expect(marked()).toBe(true);
    expect(officeDisplays(broken, el, TABLET)).toMatchObject({ camButton: 'inline-flex', camBeforeButton: 'inline-flex' });
    expect(officeDisplays(broken, el, PHONE)).toMatchObject({ camTile: 'flex', camBeforeButton: 'flex' });
  });

  test('FIRES: without the #job-service-tickets no-capture selectors the phone block wins on a Windows phone width', async () => {
    const broken = rules(mutate(STYLES_SRC, NO_CAPTURE_BLOCK,
      '.p86-no-capture .p86-wo-up.p86-wo-cam,\n' +
      '.p86-no-capture .p86-wo-addtile.p86-wo-camtile { display: none; }\n'));
    const el = await officeElements(TICKETS_SRC, { ua: UA.windows });
    // Above 760px the short selectors are enough...
    expect(officeDisplays(broken, el, TABLET)).toMatchObject(CAMERA_OFF);
    // ...but at a phone width the phone block's #job-service-tickets rules outrank them.
    expect(officeDisplays(broken, el, PHONE)).toMatchObject({ camTile: 'flex', camBeforeButton: 'flex' });
  });
});

// The crew page's photo controls on building 784, rendered by the real script.
async function crewElements(script, opts) {
  await crewEnv(script, opts);
  const card = document.querySelector('.bld[data-task="tk_784"]');
  return {
    camTile: card.querySelector('label.th-add.th-cam'),
    addTile: Array.from(card.querySelectorAll('label.th-add')).find((l) => !l.classList.contains('th-cam')),
    camButton: card.querySelector('label.btn.cam-btn'),
    addButton: Array.from(card.querySelectorAll('.before-add label.btn')).find((l) => !l.classList.contains('cam-btn')),
  };
}

const HIDE_BLOCK_CREW =
  '  @media not all and (pointer: coarse) {\n' +
  '    .th-add.th-cam, .btn.cam-btn { display: none; }\n' +
  '  }\n';

describe('service-ticket-share.html: the crew camera controls show only for a finger', () => {
  const SHEET = rules(styleOf(SHARE_HTML));

  test('the inline CSS hides .th-add.th-cam and .btn.cam-btn under the same media query', () => {
    expect(count(SHARE_HTML, '@media not all and (pointer: coarse) {')).toBe(1);
    expect(count(SHARE_HTML, HIDE_BLOCK_CREW)).toBe(1);
    const hide = SHEET.filter((r) => r.media.length === 1 && r.media[0] === HIDE_MEDIA);
    expect(hide.map((r) => ({ selectors: r.selectors, decls: r.decls }))).toEqual([
      { selectors: ['.th-add.th-cam', '.btn.cam-btn'], decls: [{ prop: 'display', value: 'none' }] },
    ]);
  });

  // For each camera control: the display rules it must beat are the .th-add /
  // .btn ones, and the hide rule comes after them with specificity >= theirs.
  function crewHideCheck(sheet, node, hideSel) {
    const { all, relevant } = displayRulesFor(sheet, node);
    const hide = all.find((c) => c.media.length === 1 && c.media[0] === HIDE_MEDIA && c.selector === hideSel) || null;
    const rest = all.filter((c) => c !== hide && c.value !== 'none');
    return {
      relevant,
      hide: hide ? hide.selector : null,
      rest: rest.map((c) => c.selector),
      after: !!hide && rest.every((c) => hide.order > c.order),
      specAtLeast: !!hide && rest.every((c) => cmp(hide.spec, c.spec) >= 0),
    };
  }

  test('the hide rule comes after the .th-add and .btn display rules, with specificity >= theirs', async () => {
    const el = await crewElements();
    const tile = crewHideCheck(SHEET, el.camTile, '.th-add.th-cam');
    expect(tile).toEqual({ relevant: [], hide: '.th-add.th-cam', rest: ['.th-add'], after: true, specAtLeast: true });
    const btn = crewHideCheck(SHEET, el.camButton, '.btn.cam-btn');
    expect(btn.relevant).toEqual([]);
    expect(btn.rest).toContain('.btn');
    expect(btn).toMatchObject({ hide: '.btn.cam-btn', after: true, specAtLeast: true });
  });

  test('the cascade: shown on a touch phone and tablet, hidden for a mouse; Add photo is never hidden', async () => {
    const el = await crewElements();
    const at = (node, env) => shown(displayAt(displayRulesFor(SHEET, node).all, env));
    for (const env of [PHONE, TABLET]) {
      expect(at(el.camTile, env)).toBe('flex');
      expect(at(el.camButton, env)).toBe('flex');
    }
    for (const env of [MOUSE_NARROW, DESKTOP]) {
      expect(at(el.camTile, env)).toBe('none');
      expect(at(el.camButton, env)).toBe('none');
      expect(at(el.addTile, env)).toBe('flex');
      expect(at(el.addButton, env)).toBe('flex');
    }
  });

  test('FIRES: remove the hide block and Take photo shows on a desktop', async () => {
    const broken = rules(styleOf(mutate(SHARE_HTML, HIDE_BLOCK_CREW, '')));
    const el = await crewElements();
    expect(crewHideCheck(broken, el.camTile, '.th-add.th-cam').hide).toBeNull();
    expect(shown(displayAt(displayRulesFor(broken, el.camTile).all, DESKTOP))).toBe('flex');
    expect(shown(displayAt(displayRulesFor(broken, el.camButton).all, DESKTOP))).toBe('flex');
  });

  test('FIRES: a weaker hide rule moved above .btn loses on order, and the camera shows on a desktop', async () => {
    let html = mutate(SHARE_HTML, HIDE_BLOCK_CREW, '');
    html = mutate(html, '  .btn {\n    display: flex;',
      '  @media not all and (pointer: coarse) {\n    .th-cam, .cam-btn { display: none; }\n  }\n  .btn {\n    display: flex;');
    const broken = rules(styleOf(html));
    const el = await crewElements();
    const tile = crewHideCheck(broken, el.camTile, '.th-cam');
    expect(tile).toMatchObject({ hide: '.th-cam', after: false });
    expect(crewHideCheck(broken, el.camButton, '.cam-btn')).toMatchObject({ hide: '.cam-btn', after: false });
    expect(shown(displayAt(displayRulesFor(broken, el.camTile).all, DESKTOP))).toBe('flex');
    expect(shown(displayAt(displayRulesFor(broken, el.camButton).all, DESKTOP))).toBe('flex');
  });

  test('FIRES: a tile display rule that outranks the hide selector is caught', async () => {
    const broken = rules(styleOf(mutate(SHARE_HTML, '  .th-add {\n    display: flex;', '  .photos .shots .th-add {\n    display: flex;')));
    const el = await crewElements();
    expect(crewHideCheck(broken, el.camTile, '.th-add.th-cam')).toMatchObject({ after: true, specAtLeast: false });
    expect(shown(displayAt(displayRulesFor(broken, el.camTile).all, DESKTOP))).toBe('flex');
  });
});

describe('crew link on Windows: the script marks <html> no-capture and the inline CSS hides every camera control', () => {
  const SHEET = rules(styleOf(SHARE_HTML));
  const MARK_JS = "document.documentElement.classList.add('no-capture');";
  const NO_CAPTURE_RULE = '  .no-capture .th-add.th-cam, .no-capture .btn.cam-btn { display: none; }\n';
  const CREW_NODES = ['camTile', 'addTile', 'camButton', 'addButton'];
  const marked = () => document.documentElement.classList.contains('no-capture');
  const displays = (sheet, el, env) => {
    const out = {};
    for (const k of CREW_NODES) {
      const { all, relevant } = displayRulesFor(sheet, el[k]);
      if (relevant.length) throw new Error('unreadable selector names ' + k + ': ' + relevant.join(' | '));
      out[k] = shown(displayAt(all, env));
    }
    return out;
  };
  const FINGER_ON = { camTile: 'flex', addTile: 'flex', camButton: 'flex', addButton: 'flex' };
  const CAMERA_OFF = { camTile: 'none', addTile: 'flex', camButton: 'none', addButton: 'flex' };

  test('a Windows NT user agent marks the page; Android, iPhone and jsdom do not', async () => {
    expect(count(SHARE_SCRIPT, MARK_JS)).toBe(1);
    await crewEnv(undefined, { ua: UA.windows });
    expect(marked()).toBe(true);
    for (const ua of [UA.android, UA.iphone, undefined]) {
      await crewEnv(undefined, { ua });
      expect(marked()).toBe(false);
    }
  });

  test('marked, both camera controls are hidden for a finger at any width; Upload photo and Upload before photo stay', async () => {
    expect(count(SHARE_HTML, NO_CAPTURE_RULE)).toBe(1);
    const el = await crewElements(undefined, { ua: UA.windows });
    expect(marked()).toBe(true);
    for (const env of [PHONE, TABLET, MOUSE_NARROW, DESKTOP]) {
      expect([env.label, displays(SHEET, el, env)]).toEqual([env.label, CAMERA_OFF]);
    }
  });

  test('unmarked (iPhone, Android), a finger keeps both camera controls', async () => {
    for (const ua of [UA.iphone, UA.android]) {
      const el = await crewElements(undefined, { ua });
      expect(marked()).toBe(false);
      expect(displays(SHEET, el, PHONE)).toEqual(FINGER_ON);
      expect(displays(SHEET, el, TABLET)).toEqual(FINGER_ON);
    }
  });

  test('FIRES: without the mark in the inline script a Windows tablet shows Take photo', async () => {
    const el = await crewElements(mutate(SHARE_SCRIPT, MARK_JS, 'void 0; /* unmarked */'), { ua: UA.windows });
    expect(marked()).toBe(false);
    expect(displays(SHEET, el, TABLET)).toEqual(FINGER_ON);
  });

  test('a phone sending a Windows user agent (a desktop-site request) keeps both camera controls', async () => {
    const el = await crewElements(undefined, { ua: UA.windows, screen: { width: 412, height: 915 } });
    expect(marked()).toBe(false);
    expect(displays(SHEET, el, PHONE)).toEqual(FINGER_ON);
  });

  test('FIRES: the Windows mark without its screen-size test hides the camera on that phone', async () => {
    const el = await crewElements(mutate(SHARE_SCRIPT, ' && Math.min(screen.width || 0, screen.height || 0) >= 600', ''), { ua: UA.windows, screen: { width: 412, height: 915 } });
    expect(marked()).toBe(true);
    expect(displays(SHEET, el, PHONE)).toEqual(CAMERA_OFF);
  });

  test('FIRES: the mark without its Windows NT test hides the camera on an iPhone', async () => {
    const el = await crewElements(mutate(SHARE_SCRIPT, 'if (/Windows NT/.test(navigator.userAgent) && Math.min(screen.width || 0, screen.height || 0) >= 600) ' + MARK_JS, MARK_JS), { ua: UA.iphone });
    expect(marked()).toBe(true);
    expect(displays(SHEET, el, PHONE)).toEqual(CAMERA_OFF);
  });

  test('FIRES: remove the no-capture rule and a marked Windows tablet and phone show the camera', async () => {
    const broken = rules(styleOf(mutate(SHARE_HTML, NO_CAPTURE_RULE, '')));
    const el = await crewElements(undefined, { ua: UA.windows });
    expect(marked()).toBe(true);
    expect(displays(broken, el, TABLET)).toEqual(FINGER_ON);
    expect(displays(broken, el, PHONE)).toEqual(FINGER_ON);
  });
});
