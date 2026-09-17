/**
 * @jest-environment jsdom
 */
// Office photo uploads on a work order (js/work-order-uploads.js), and the Site
// photos strip in its Scope card. Work Orders 1.29, crew-signal A6 / A7 office.
//
// Driven through the REAL js/photo-upload-queue.js and js/service-ticket-ext.js,
// on building cards with the host's markup, and once end to end through the
// REAL js/service-tickets.js:
//
//   1. Busy: the control that was tapped (the host's card._p86LastTap, else the
//      input's own label) is is-busy / aria-busy until the building settles,
//      and is marked again on a card the host has since redrawn (decorate).
//   2. Status: the line under the photos ("Uploading 1 of 2…", "2 photos
//      added.", "2 of 3 added. 1 didn't go through." with the refusal line,
//      Retry for a failed photo, Clear) and the head chip ("Uploading 1/2").
//   3. Landed: each photo that lands is a .p86-wo-thumb.is-new before the first
//      .p86-wo-addtile, and "No photos yet." goes.
//   4. Settled: ctx.onSettled runs ONCE per round, after the last photo; a
//      failure is toasted once ("1 photo on Bldg 784 didn't upload. Tap Retry
//      on the card."); a photo picked twice is skipped with a toast; Retry
//      resends under the same upload id.
//   5. Leaving the page while photos are going asks first.
//   6. Site photos: registered with p86StExt as 'work-order-uploads' (order
//      40), a 'sitephotos' section in the scopeCard slot, "Site photos · N",
//      escaped, and a thumbnail opens the lightbox on that list.
//   7. js/file-explorer.js: a bulk delete the server refuses (a work order's
//      photo proof, 409 photo_locked / last_completion_photo) says why instead
//      of toasting "Deleted".
//
// Each guard is also shown to FIRE: the drive is re-run against a copy of the
// shipped source with that guard broken. The files are CRLF on disk, so the
// source is EOL-normalized first, and an anchor that is missing, repeated or
// moves no bytes throws.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const EXT_SRC = read('js/service-ticket-ext.js');
const QUEUE_SRC = read('js/photo-upload-queue.js');
const UPLOADS_SRC = read('js/work-order-uploads.js');
const EDITOR_SRC = read('js/service-ticket-editor.js');
const MOVE_SRC = read('js/service-ticket-status-move.js');
const TICKETS_SRC = read('js/service-tickets.js');
const FX_SRC = read('js/file-explorer.js');
const JOB_LABEL = require('../js/job-label.js');
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1) throw new Error('anchor not found: ' + from);
  if (src.indexOf(from, at + from.length) !== -1) throw new Error('anchor not unique: ' + from);
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('mutation did not change the source: ' + from);
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 8; i++) await tick(); }
async function micro() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const photoFile = (name, type) => new File(['jpeg-bytes-' + name], name, { type: type || 'image/jpeg', lastModified: 1757952000000 });
const landed = (id) => ({ ok: true, attachment: { id, thumb_url: '/t/' + id + '.jpg', web_url: '/w/' + id + '.jpg' } });

// A building card as js/service-tickets.js subtaskHTML draws it for an editor,
// trimmed to what the upload module reads and writes.
function cardHTML(taskId, title) {
  return '<div class="p86-wo-sub is-open" data-task="' + taskId + '">' +
    '<div class="p86-wo-sub-head">' +
      '<button type="button" class="p86-wo-sub-toggle"><span class="p86-wo-sub-name">' + title + '</span></button>' +
      '<span class="p86-wo-sub-meta"><span class="p86-wo-needs">Needs photo</span></span>' +
    '</div>' +
    '<div class="p86-wo-sub-body">' +
      '<div class="p86-wo-photos">' +
        '<div class="p86-wo-nophotos">No photos yet.</div>' +
        '<button type="button" class="p86-wo-addtile p86-wo-camtile">Take photo</button>' +
        '<button type="button" class="p86-wo-addtile">Upload photo</button>' +
      '</div>' +
      '<div class="p86-wo-sub-actions">' +
        '<label class="ee-btn primary p86-wo-up p86-wo-cam is-completion">Take completion photo<input type="file" accept="image/*" capture="environment" hidden data-kind="completion" /></label>' +
        '<label class="ee-btn primary p86-wo-up is-completion">Upload completion photo<input type="file" accept="image/*" multiple hidden data-kind="completion" /></label>' +
        '<label class="ee-btn secondary p86-wo-up p86-wo-cam">Take before photo<input type="file" accept="image/*" capture="environment" hidden data-kind="before" /></label>' +
        '<label class="ee-btn secondary p86-wo-up">Upload before photo<input type="file" accept="image/*" multiple hidden data-kind="before" /></label>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// opts.answer(args, n) -> the upload's promise; 'manual' queues deferreds.
function env(opts) {
  opts = opts || {};
  document.body.innerHTML = '<div class="p86-st-detail">' + cardHTML('tk_784', 'Bldg 784') + cardHTML('tk_790', 'Bldg 790') + '</div>';
  const sends = [];
  window.p86Toast = jest.fn();
  window.p86Attachments = { openLightbox: jest.fn() };
  window.p86Api = {
    attachments: {
      upload: jest.fn((...args) => {
        const n = sends.length;
        const d = deferred();
        sends.push({ args, d });
        if (opts.answer === 'manual') return d.promise;
        return (opts.answer || (() => Promise.resolve(landed('att_' + (n + 1)))))(args, n);
      }),
    },
  };
  for (const g of ['p86StExt', 'p86PhotoQueue', 'p86WorkOrderUploads']) delete window[g];
  window.eval(EXT_SRC);
  window.eval(QUEUE_SRC);
  window.eval(opts.src || UPLOADS_SRC);
  const U = window.p86WorkOrderUploads;
  const card = (id) => document.querySelector('.p86-wo-sub[data-task="' + id + '"]');
  const input = (c, kind, cam) => Array.from(c.querySelectorAll('.p86-wo-up')).find((l) =>
    l.classList.contains('p86-wo-cam') === !!cam && l.querySelector('input').getAttribute('data-kind') === kind).querySelector('input');
  const tile = (c, cam) => Array.from(c.querySelectorAll('.p86-wo-addtile')).find((b) => b.classList.contains('p86-wo-camtile') === !!cam);
  const onSettled = jest.fn(() => Promise.resolve());
  return { U, sends, card, input, tile, onSettled };
}

// What one card shows, as the tests read it.
function view(c) {
  const line = c.querySelector('.p86-wo-upq');
  const chip = c.querySelector('.p86-wo-upchip');
  return {
    busy: Array.from(c.querySelectorAll('.is-busy')).map((el) => el.textContent.trim() + (el.getAttribute('aria-busy') === 'true' ? ' [aria-busy]' : '')),
    status: line ? Array.from(line.querySelectorAll('.p86-wo-upq-line')).map((s) => s.textContent) : null,
    buttons: line ? Array.from(line.querySelectorAll('button')).map((b) => b.textContent) : [],
    bad: !!line && line.classList.contains('is-bad'),
    chip: chip ? chip.textContent : null,
    grid: Array.from(c.querySelector('.p86-wo-photos').children).map((el) =>
      el.classList.contains('p86-wo-thumb') ? 'thumb' + (el.classList.contains('is-new') ? '.is-new' : '') + ':' + el.querySelector('img').getAttribute('src') + ':' + el.querySelector('.p86-wo-kind').textContent
        : el.classList.contains('p86-wo-addtile') ? 'tile:' + el.textContent.trim()
          : el.className),
  };
}

const toasts = () => window.p86Toast.mock.calls.map((c) => c.slice(0, 2));

afterEach(() => {
  jest.useRealTimers();
});

// ── 1-4. A batch on one building ─────────────────────────────────────────

async function twoPhotoBatch(src) {
  const e = env({ src, answer: 'manual' });
  const c = e.card('tk_784');
  c._p86LastTap = e.tile(c, false);
  const res = e.U.addPhotos(c, e.input(c, 'completion', false), [photoFile('IMG_1.jpg'), photoFile('IMG_2.jpg')],
    { ticketId: 'st_1', taskId: 'tk_784', kind: 'completion', onSettled: e.onSettled });
  await flush();
  const first = view(c);
  const sentFirst = e.sends.length;
  e.sends[0].d.resolve(landed('att_1'));
  await flush();
  const middle = view(c);
  const settledMid = e.onSettled.mock.calls.length;
  e.sends[1].d.resolve(landed('att_2'));
  await flush();
  return { e, c, res, first, sentFirst, middle, settledMid, last: view(c), other: view(e.card('tk_790')) };
}

describe('a batch of photos on one building card', () => {
  test('the tapped Upload photo tile is busy, the line and chip count, each photo lands before the tiles, and onSettled runs once at the end', async () => {
    const r = await twoPhotoBatch();
    expect(r.res).toEqual({ added: 2, skipped: 0 });
    expect(r.sentFirst).toBe(1); // one at a time
    expect(r.first).toEqual({
      busy: ['Upload photo [aria-busy]'],
      status: ['Uploading 1 of 2…'],
      buttons: [],
      bad: false,
      chip: 'Uploading 1/2',
      grid: ['p86-wo-nophotos', 'tile:Take photo', 'tile:Upload photo'],
    });
    expect(r.middle).toEqual({
      busy: ['Upload photo [aria-busy]'],
      status: ['Uploading 2 of 2…'],
      buttons: [],
      bad: false,
      chip: 'Uploading 2/2',
      grid: ['thumb.is-new:/t/att_1.jpg:Done', 'tile:Take photo', 'tile:Upload photo'],
    });
    expect(r.settledMid).toBe(0);
    expect(r.last).toEqual({
      busy: [],
      status: ['2 photos added.'],
      buttons: [],
      bad: false,
      chip: null,
      grid: ['thumb.is-new:/t/att_1.jpg:Done', 'thumb.is-new:/t/att_2.jpg:Done', 'tile:Take photo', 'tile:Upload photo'],
    });
    expect(r.e.onSettled).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([]);
    // The other building is untouched.
    expect(r.other).toMatchObject({ busy: [], status: null, chip: null });
  });

  test('the upload goes to the building task with its kind, an upload id and the abort signal', async () => {
    const r = await twoPhotoBatch();
    const [a, b] = r.e.sends.map((s) => s.args);
    expect(a.slice(0, 2)).toEqual(['task', 'tk_784']);
    expect(a[2].name).toBe('IMG_1.jpg');
    expect(a[3]).toEqual({ tags: 'completion', upload_id: expect.stringMatching(UPLOAD_ID_RE) });
    expect(a[4].signal).toBeTruthy();
    expect(b[3].upload_id).not.toBe(a[3].upload_id);
  });

  test('FIRES: without the busy class the tapped tile does not show it is working', async () => {
    const r = await twoPhotoBatch(mutate(UPLOADS_SRC, "el.classList.add('is-busy');", ''));
    expect(r.first.busy).toEqual([]);
  });

  test('FIRES: a thumbnail appended after the tiles is caught', async () => {
    const r = await twoPhotoBatch(mutate(UPLOADS_SRC,
      "grid.insertBefore(thumbFor(photo), tile && tile.parentNode === grid ? tile : null);",
      'grid.appendChild(thumbFor(photo));'));
    expect(r.middle.grid).toEqual(['tile:Take photo', 'tile:Upload photo', 'thumb.is-new:/t/att_1.jpg:Done']);
  });

  test('FIRES: settling on every change instead of when nothing is left runs onSettled more than once', async () => {
    const r = await twoPhotoBatch(mutate(UPLOADS_SRC, '    if (s.active + s.waiting > 0) return;\n    rec.armed = false;', '    rec.armed = false;'));
    expect(r.settledMid).toBeGreaterThan(0);
  });

  test('a camera shot on Take before photo with no tile tapped marks that label busy, and lands as a Before photo', async () => {
    const e = env({ answer: 'manual' });
    const c = e.card('tk_784');
    const inp = e.input(c, 'before', true);
    e.U.addPhotos(c, inp, [photoFile('IMG_9.jpg')], { ticketId: 'st_1', taskId: 'tk_784', kind: 'before', onSettled: e.onSettled });
    await flush();
    expect(view(c).busy).toEqual(['Take before photo [aria-busy]']);
    e.sends[0].d.resolve(landed('att_9'));
    await flush();
    expect(view(c)).toMatchObject({ busy: [], status: ['Photo added.'], grid: ['thumb.is-new:/t/att_9.jpg:Before', 'tile:Take photo', 'tile:Upload photo'] });
    expect(e.sends[0].args[3].tags).toBe('before');
  });

  async function twoRounds(src) {
    const e = env({ src });
    const c = e.card('tk_784');
    const ctx = (kind) => ({ ticketId: 'st_1', taskId: 'tk_784', kind, onSettled: e.onSettled });
    e.U.addPhotos(c, e.input(c, 'completion', false), [photoFile('IMG_1.jpg'), photoFile('IMG_2.jpg')], ctx('completion'));
    await flush();
    const first = view(c).status;
    e.U.addPhotos(c, e.input(c, 'before', true), [photoFile('IMG_3.jpg')], ctx('before'));
    const during = view(c);
    await flush();
    return { first, during, second: view(c).status, settled: e.onSettled.mock.calls.length };
  }

  test('a new round on a settled building counts only its own photos', async () => {
    const r = await twoRounds();
    expect(r.first).toEqual(['2 photos added.']);
    expect(r.during).toMatchObject({ status: ['Uploading 1 of 1…'], chip: 'Uploading 1/1' });
    expect(r.second).toEqual(['Photo added.']);
    expect(r.settled).toBe(2);
  });

  test('FIRES: without the round floor the before photo is counted with the settled completion photos', async () => {
    const r = await twoRounds(mutate(UPLOADS_SRC, 'return seqOf(it) > floor;', 'return true;'));
    expect(r.during.status).toEqual(['Uploading 3 of 3…']);
    expect(r.second).toEqual(['3 photos added.']);
  });

  test('the same photo picked again while it is still going is skipped with a toast, and sent once', async () => {
    const e = env({ answer: 'manual' });
    const c = e.card('tk_784');
    const f = photoFile('IMG_1.jpg');
    const ctx = { ticketId: 'st_1', taskId: 'tk_784', kind: 'completion', onSettled: e.onSettled };
    e.U.addPhotos(c, e.input(c, 'completion', false), [f], ctx);
    const again = e.U.addPhotos(c, e.input(c, 'completion', false), [f], ctx);
    expect(again).toEqual({ added: 0, skipped: 1 });
    expect(toasts()).toEqual([['Skipped 1 photo already uploaded.', undefined]]);
    await flush();
    e.sends[0].d.resolve(landed('att_1'));
    await flush();
    expect(e.sends.length).toBe(1);
    expect(e.onSettled).toHaveBeenCalledTimes(1);
  });
});

describe('when photos fail', () => {
  const HEIC = "This photo is in HEIC format (High efficiency), which can't be opened here yet. Use Take photo, or set your camera to save photos as JPEG, then add it again.";

  async function refusedBatch(src) {
    const e = env({
      src,
      answer: (args, n) => {
        if (n === 1) return Promise.reject(Object.assign(new Error(HEIC), { status: 415, data: { error: HEIC } }));
        return Promise.resolve(landed('att_' + (n + 1)));
      },
    });
    const c = e.card('tk_784');
    c._p86LastTap = e.tile(c, true);
    e.U.addPhotos(c, e.input(c, 'completion', true), [photoFile('IMG_1.jpg'), photoFile('IMG_2.jpg'), photoFile('IMG_3.jpg')],
      { ticketId: 'st_1', taskId: 'tk_784', kind: 'completion', onSettled: e.onSettled });
    await flush();
    return { e, c, v: view(c) };
  }

  test('a refused photo does not stop the rest; the line says so with Clear, the chip and one toast name the building, onSettled still runs', async () => {
    const r = await refusedBatch();
    expect(r.e.sends.length).toBe(3);
    expect(r.v).toEqual({
      busy: [],
      status: ["2 of 3 added. 1 didn't go through.", "IMG_2.jpg wasn't sent: " + HEIC],
      buttons: ['Clear'],
      bad: true,
      chip: "1 didn't upload",
      grid: ['thumb.is-new:/t/att_1.jpg:Done', 'thumb.is-new:/t/att_3.jpg:Done', 'tile:Take photo', 'tile:Upload photo'],
    });
    expect(toasts()).toEqual([["1 photo on Bldg 784 didn't upload. The card says why.", 'error']]);
    expect(r.e.onSettled).toHaveBeenCalledTimes(1);
    r.c.querySelector('.p86-wo-upq button').click();
    expect(view(r.c)).toMatchObject({ status: ['2 photos added.'], buttons: [], bad: false, chip: null });
  });

  test('FIRES: without the failure toast nobody is told', async () => {
    const r = await refusedBatch(mutate(UPLOADS_SRC, "    if (s.failed + s.refused > 0) toast(failureText(s, rec.label), 'error');\n", ''));
    expect(toasts()).toEqual([]);
  });

  test('a photo that keeps losing the connection is retried at 3 s and 15 s, then offers Retry, which resends under the same upload id', async () => {
    jest.useFakeTimers();
    let failing = true;
    const e = env({
      answer: (args, n) => (failing ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(landed('att_' + (n + 1)))),
    });
    const c = e.card('tk_784');
    e.U.addPhotos(c, e.input(c, 'completion', false), [photoFile('IMG_5.jpg')], { ticketId: 'st_1', taskId: 'tk_784', kind: 'completion', onSettled: e.onSettled });
    await micro();
    expect(e.sends.length).toBe(1);
    expect(view(c)).toMatchObject({ status: ['Uploading 1 of 1… 1 will retry'], chip: 'Uploading 1/1' });
    await jest.advanceTimersByTimeAsync(3000);
    expect(e.sends.length).toBe(2);
    expect(e.onSettled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(15000);
    expect(e.sends.length).toBe(3);
    await micro();
    expect(view(c)).toMatchObject({ busy: [], status: ["0 of 1 added. 1 didn't go through."], buttons: ['Retry', 'Clear'], bad: true, chip: "1 didn't upload" });
    expect(toasts()).toEqual([["1 photo on Bldg 784 didn't upload. Tap Retry on the card.", 'error']]);
    expect(e.onSettled).toHaveBeenCalledTimes(1);

    failing = false;
    Array.from(c.querySelectorAll('.p86-wo-upq button')).find((b) => b.textContent === 'Retry').click();
    await micro();
    expect(e.sends.length).toBe(4);
    const ids = e.sends.map((s) => s.args[3].upload_id);
    expect(new Set(ids).size).toBe(1);
    expect(view(c)).toMatchObject({ status: ['Photo added.'], buttons: [], bad: false, chip: null, grid: ['thumb.is-new:/t/att_4.jpg:Done', 'tile:Take photo', 'tile:Upload photo'] });
    expect(e.onSettled).toHaveBeenCalledTimes(2);
  });

  test('a 200 answer that is not the server\'s (a sign-in page) is not counted as landed', async () => {
    jest.useFakeTimers();
    const e = env({ answer: () => Promise.resolve({ html: '<title>Sign in to Wi-Fi</title>' }) });
    const c = e.card('tk_784');
    e.U.addPhotos(c, e.input(c, 'completion', false), [photoFile('IMG_6.jpg')], { ticketId: 'st_1', taskId: 'tk_784', kind: 'completion', onSettled: e.onSettled });
    await micro();
    expect(view(c).status).toEqual(['Uploading 1 of 1… 1 will retry']);
    expect(c.querySelector('.is-new')).toBeNull();
  });
});

// ── Redraws and leaving ──────────────────────────────────────────────────

async function redrawnMidBatch(src) {
  const e = env({ src, answer: 'manual' });
  let c = e.card('tk_784');
  c._p86LastTap = e.tile(c, false);
  e.U.addPhotos(c, e.input(c, 'completion', false), [photoFile('IMG_1.jpg'), photoFile('IMG_2.jpg')],
    { ticketId: 'st_1', taskId: 'tk_784', kind: 'completion', onSettled: e.onSettled });
  await flush();
  e.sends[0].d.resolve(landed('att_1'));
  await flush();
  // The host draws the card again from a read that does not have the photo yet.
  const tpl = document.createElement('template');
  tpl.innerHTML = cardHTML('tk_784', 'Bldg 784');
  c.parentNode.replaceChild(tpl.content.firstElementChild, c);
  c = e.card('tk_784');
  const bare = view(c);
  e.U.decorate(document.querySelector('.p86-st-detail'), 'st_1');
  return { e, bare, again: view(c) };
}

describe('a card the host redraws mid-batch', () => {
  test('decorate puts back the busy tile, the line, the chip and the landed thumbnail', async () => {
    const r = await redrawnMidBatch();
    expect(r.bare).toMatchObject({ busy: [], status: null, chip: null });
    expect(r.again).toEqual({
      busy: ['Upload photo [aria-busy]'],
      status: ['Uploading 2 of 2…'],
      buttons: [],
      bad: false,
      chip: 'Uploading 2/2',
      grid: ['thumb.is-new:/t/att_1.jpg:Done', 'tile:Take photo', 'tile:Upload photo'],
    });
  });

  test('decorate for another work order leaves the card alone', async () => {
    const e = env({ answer: 'manual' });
    const c = e.card('tk_784');
    e.U.addPhotos(c, e.input(c, 'completion', false), [photoFile('IMG_1.jpg')], { ticketId: 'st_1', taskId: 'tk_784', kind: 'completion' });
    await flush();
    const tpl = document.createElement('template');
    tpl.innerHTML = cardHTML('tk_784', 'Bldg 784');
    c.parentNode.replaceChild(tpl.content.firstElementChild, c);
    e.U.decorate(document.querySelector('.p86-st-detail'), 'st_2');
    expect(view(e.card('tk_784'))).toMatchObject({ busy: [], status: null, chip: null });
  });

  test('FIRES: a busy mark that only knows the old node is lost on the redrawn card', async () => {
    const r = await redrawnMidBatch(mutate(UPLOADS_SRC, '    if (tap.tile) {', '    if (false) {'));
    expect(r.again.busy).toEqual([]);
  });
});

describe('leaving the page', () => {
  // The handler THIS copy of the module registers (when its queue is made),
  // so a copy evaluated by an earlier test, with photos of its own still
  // waiting, cannot answer for it.
  async function drive(src) {
    const e = env({ src, answer: 'manual' });
    const c = e.card('tk_784');
    const spy = jest.spyOn(window, 'addEventListener');
    e.U.addPhotos(c, e.input(c, 'completion', false), [photoFile('IMG_1.jpg')], { ticketId: 'st_1', taskId: 'tk_784', kind: 'completion' });
    const handlers = spy.mock.calls.filter((call) => call[0] === 'beforeunload').map((call) => call[1]);
    spy.mockRestore();
    expect(handlers.length).toBe(1);
    const leave = () => {
      const ev = new Event('beforeunload', { cancelable: true });
      handlers[0](ev);
      return ev.defaultPrevented;
    };
    await flush();
    const whileGoing = leave();
    e.sends[0].d.resolve(landed('att_1'));
    await flush();
    return { whileGoing, afterDone: leave() };
  }

  test('asks while a photo is still going, not once it has landed', async () => {
    expect(await drive()).toEqual({ whileGoing: true, afterDone: false });
  });

  test('FIRES: a guard that never looks at the queue lets the page go', async () => {
    const r = await drive(mutate(UPLOADS_SRC, '      if (!_queue || !_queue.unsettled()) return undefined;', '      return undefined;'));
    expect(r.whileGoing).toBe(false);
  });
});

// ── 6. Site photos ───────────────────────────────────────────────────────

const SITE_PHOTOS = [
  { id: 'sp_2', filename: 'b.jpg', mime_type: 'image/jpeg', thumb_url: '/t/sp2.jpg', web_url: '/w/sp2.jpg', original_url: '/o/sp2.jpg', uploaded_at: '2026-09-15T18:32:00Z', by: 'Jose <crew>', via_link: true },
  { id: 'sp_1', filename: 'a.jpg', mime_type: 'image/jpeg', thumb_url: '/t/sp1.jpg', web_url: '/w/sp1.jpg', original_url: '/o/sp1.jpg', uploaded_at: '2026-09-14T13:05:00Z', by: 'Office', via_link: false },
];

describe('the Site photos section', () => {
  test('registers as work-order-uploads, order 40, with a sitephotos section in the scopeCard slot', () => {
    const e = env();
    const row = window.p86StExt.list().find((x) => x.name === 'work-order-uploads');
    expect(row).toMatchObject({ order: 40 });
    const secs = window.p86StExt.collect('detailSections', { r: { site_photos: SITE_PHOTOS }, t: { title: 'Stairs' } });
    expect(secs.length).toBe(1);
    expect(secs[0].map((s) => ({ key: s.key, slot: s.slot, wire: typeof s.wire }))).toEqual([{ key: 'sitephotos', slot: 'scopeCard', wire: 'function' }]);
    const empty = window.p86StExt.collect('detailSections', { r: { site_photos: [] } });
    expect(empty[0][0].html).toBe('');
    expect(e.U.sitePhotosHTML(undefined)).toBe('');
  });

  test('"Site photos · N", one root, a thumbnail per photo titled with who and when, everything escaped', () => {
    const e = env();
    const tpl = document.createElement('template');
    tpl.innerHTML = e.U.sitePhotosHTML(SITE_PHOTOS);
    expect(tpl.content.children.length).toBe(1);
    const root = tpl.content.firstElementChild;
    expect(root.querySelector('.p86-st-lbl').textContent).toBe('Site photos · 2');
    const thumbs = Array.from(root.querySelectorAll('.p86-wo-photos.p86-wo-sitephotos > .p86-wo-thumb'));
    expect(thumbs.map((b) => [b.getAttribute('data-idx'), b.querySelector('img').getAttribute('src'), b.title.split(' · ')[0]]))
      .toEqual([['0', '/t/sp2.jpg', 'Jose <crew>'], ['1', '/t/sp1.jpg', 'Office']]);
    expect(thumbs[0].querySelector('img').getAttribute('alt')).toMatch(/^Photo by Jose <crew>, /);
    expect(root.querySelectorAll('crew').length).toBe(0);
  });

  test('a thumbnail opens the lightbox on the list, labelled Site photos under the work order title', () => {
    const e = env();
    const host = document.createElement('div');
    host.innerHTML = e.U.sitePhotosHTML(SITE_PHOTOS);
    document.body.appendChild(host);
    const node = host.firstElementChild;
    e.U.wireSitePhotos(node, SITE_PHOTOS, { title: 'Replace rotted stair treads' });
    e.U.wireSitePhotos(node, SITE_PHOTOS, { title: 'Replace rotted stair treads' }); // wiring twice adds no second listener
    node.querySelectorAll('.p86-wo-thumb')[1].querySelector('img').click();
    expect(window.p86Attachments.openLightbox.mock.calls).toEqual([[SITE_PHOTOS, 1, { parentLabel: 'Site photos', parentSubtitle: 'Replace rotted stair treads' }]]);
  });
});

// ── End to end through js/service-tickets.js ─────────────────────────────

function officeEnv(opts) {
  opts = opts || {};
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="job-service-tickets"></div>';
  window.appState = { currentJobId: 'job_77' };
  window.appData = { jobs: [{ id: 'job_77', jobNumber: 'M1001', title: 'Latitude stairs' }], leads: [] };
  window.p86JobLabel = JOB_LABEL;
  const ticket = { id: 'st_1', ticket_number: 'WO-0007', title: 'Replace rotted stair treads', status: 'in_progress', priority: 'normal', job_id: 'job_77', lead_id: null, materials: [], guest_log: 'Jose: resident refused access' };
  const state = { photos: [], site: opts.site || [], uploads: [] };
  const read = () => ({
    ticket: JSON.parse(JSON.stringify(ticket)),
    tasks: [{ id: 'tk_784', title: 'Bldg 784 — Side A: rail post', status: 'open', photos: state.photos.slice(), notes: [] }],
    events: [], revisions: [], participants: [], site_photos: state.site.slice(),
  });
  window.p86Api = {
    serviceTickets: {
      list: jest.fn(() => Promise.resolve({ tickets: [ticket] })),
      get: jest.fn(() => Promise.resolve(read())),
      materialSources: jest.fn(() => Promise.resolve({ files: [] })),
      assignees: jest.fn(() => Promise.resolve({ users: [] })),
    },
    attachments: {
      upload: jest.fn((...args) => {
        state.uploads.push(args);
        if (opts.refuse) return Promise.reject(Object.assign(new Error(opts.refuse), { status: 409, data: { error: opts.refuse } }));
        const att = { id: 'att_' + state.uploads.length, kind: args[3].tags, thumb_url: '/t/new.jpg', web_url: '/w/new.jpg' };
        state.photos.push(att);
        return Promise.resolve({ ok: true, attachment: att });
      }),
    },
  };
  window.p86Auth = { hasCapability: () => true };
  window.p86Toast = jest.fn();
  window.p86Attachments = { openLightbox: jest.fn() };
  window.p86Confirm = jest.fn(() => Promise.resolve(true));
  delete window.p86ServiceTickets;
  delete window.renderJobServiceTickets;
  for (const g of ['p86StExt', 'p86PhotoQueue', 'p86WorkOrderUploads', 'p86StEditor', 'p86MoveTicketStatus']) delete window[g];
  window.eval(EXT_SRC);
  window.eval(QUEUE_SRC);
  window.eval(opts.src || UPLOADS_SRC);
  window.eval(EDITOR_SRC);
  window.eval(MOVE_SRC);
  window.eval(TICKETS_SRC);
  return state;
}

async function openTicket() {
  window.renderJobServiceTickets('job_77');
  await flush();
  document.querySelector('#job-service-tickets .p86-st-row-head').click();
  await flush();
  return document.querySelector('#job-service-tickets .p86-st-row.is-open .p86-st-detail');
}

describe('on the real work order screen', () => {
  test('the Site photos strip sits in the Scope card after the Field log, and its thumbnails open the lightbox', async () => {
    officeEnv({ site: SITE_PHOTOS });
    const d = await openTicket();
    const sec = d.querySelector('.p86-st-scopecard > [data-st-sec="sitephotos"]');
    expect(sec).not.toBeNull();
    expect(sec.previousElementSibling.getAttribute('data-st-sec')).toBe('scopeextra');
    expect(sec.querySelector('.p86-st-lbl').textContent).toBe('Site photos · 2');
    sec.querySelectorAll('.p86-wo-thumb')[0].click();
    expect(window.p86Attachments.openLightbox).toHaveBeenCalledWith(SITE_PHOTOS, 0, { parentLabel: 'Site photos', parentSubtitle: 'Replace rotted stair treads' });
  });

  test('FIRES: the section in another slot is not in the Scope card', async () => {
    officeEnv({ site: SITE_PHOTOS, src: mutate(UPLOADS_SRC, "slot: 'scopeCard',", "slot: 'actions',") });
    const d = await openTicket();
    expect(d.querySelector('.p86-st-scopecard [data-st-sec="sitephotos"]')).toBeNull();
  });

  test('a photo picked on the Upload photo tile uploads through the queue, the card is re-read once, and the read\'s own thumbnail replaces the landed one', async () => {
    const s = officeEnv();
    const d = await openTicket();
    let card = d.querySelector('.p86-wo-sub[data-task="tk_784"]');
    card.querySelector('.p86-wo-sub-toggle').click();
    const tileBtn = Array.from(card.querySelectorAll('.p86-wo-addtile')).find((b) => !b.classList.contains('p86-wo-camtile'));
    const spy = jest.spyOn(window.HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    tileBtn.click();
    spy.mockRestore();
    expect(card._p86LastTap).toBe(tileBtn);
    const gets = window.p86Api.serviceTickets.get.mock.calls.length;
    const inp = card.querySelector('.p86-wo-up:not(.p86-wo-cam) input[data-kind="completion"]');
    Object.defineProperty(inp, 'files', { value: [photoFile('IMG_1.jpg')], configurable: true });
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    expect(tileBtn.classList.contains('is-busy')).toBe(true);
    await flush();
    expect(s.uploads.map((a) => [a[0], a[1], a[3]])).toEqual([['task', 'tk_784', { tags: 'completion', upload_id: expect.stringMatching(UPLOAD_ID_RE) }]]);
    expect(window.p86Api.serviceTickets.get.mock.calls.length).toBe(gets + 1);
    card = d.querySelector('.p86-wo-sub[data-task="tk_784"]');
    expect(card.querySelectorAll('.p86-wo-thumb').length).toBe(1);
    expect(card.querySelector('.p86-wo-thumb.is-new')).toBeNull();
    expect(card.querySelector('.p86-wo-upq')).toBeNull();
    expect(card.querySelector('.is-busy')).toBeNull();
    expect(window.p86Toast.mock.calls.filter((c) => c[1] === 'error')).toEqual([]);
  });

  test('a work order closed to writes: the refusal stays on the card after the re-read, and is toasted once', async () => {
    const LOCKED = 'This work order is approved. Reopen it before changing its punch list.';
    officeEnv({ refuse: LOCKED });
    const d = await openTicket();
    let card = d.querySelector('.p86-wo-sub[data-task="tk_784"]');
    const inp = card.querySelector('.p86-wo-up.p86-wo-cam input[data-kind="before"]');
    Object.defineProperty(inp, 'files', { value: [photoFile('IMG_7.jpg')], configurable: true });
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    card = d.querySelector('.p86-wo-sub[data-task="tk_784"]');
    expect(Array.from(card.querySelectorAll('.p86-wo-upq-line')).map((x) => x.textContent))
      .toEqual(["0 of 1 added. 1 didn't go through.", "IMG_7.jpg wasn't sent: " + LOCKED]);
    expect(card.querySelector('.p86-wo-upchip').textContent).toBe("1 didn't upload");
    expect(window.p86Toast.mock.calls.filter((c) => c[1] === 'error').map((c) => c[0]))
      .toEqual(["1 photo on Bldg 784 didn't upload. The card says why."]);
  });
});

// ── 7. js/file-explorer.js: a refused delete is said ─────────────────────

async function explorerDelete(removeAnswers, src) {
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="fx"></div>';
  const files = Object.keys(removeAnswers).map((id) => ({ id, filename: id + '.jpg', mime_type: 'image/jpeg', thumb_url: '/t/' + id + '.jpg', folder_id: null, uploaded_at: '2026-09-15T12:00:00Z' }));
  const shown = jest.fn();
  window.p86Toast = Object.assign(jest.fn(), { show: shown });
  window.p86Confirm = jest.fn(() => Promise.resolve(true));
  window.p86Api = {
    fileFolders: { tree: jest.fn(() => Promise.resolve({ folders: [] })) },
    attachments: {
      list: jest.fn(() => Promise.resolve({ attachments: files })),
      remove: jest.fn((id) => removeAnswers[id]()),
    },
  };
  try { localStorage.setItem('p86fx-view', 'list'); } catch (e) { /* nothing */ }
  delete window.p86Explorer;
  window.eval(src || FX_SRC);
  window.p86Explorer.mount(document.getElementById('fx'), { entityType: 'task', entityId: 'tk_784', canEdit: true });
  await flush();
  for (const id of Object.keys(removeAnswers)) {
    document.querySelector('[data-check="' + id + '"]').click();
  }
  document.querySelector('[data-bulk="delete"]').click();
  await flush();
  return { toasts: shown.mock.calls.map((c) => c.slice(0, 2)), removed: window.p86Api.attachments.remove.mock.calls.map((c) => c[0]) };
}

const LAST = "This is the last completion photo on Bldg 784, and the building is marked done. Reopen the building first.";
const refuse409 = (msg, code) => () => Promise.reject(Object.assign(new Error(msg), { status: 409, data: { error: msg, code } }));
const ok = () => Promise.resolve({ ok: true });

describe('file explorer: a delete the server refuses is said, not swallowed', () => {
  test('one photo refused: the server\'s sentence, as an error, and no "Deleted"', async () => {
    const r = await explorerDelete({ a1: refuse409(LAST, 'last_completion_photo') });
    expect(r.removed).toEqual(['a1']);
    expect(r.toasts).toEqual([[LAST, 'error']]);
  });

  test('two files, one refused: how many went, how many were kept, and why', async () => {
    const r = await explorerDelete({ a1: refuse409('This photo is proof on a locked work order.', 'photo_locked'), a2: ok });
    expect(r.removed.sort()).toEqual(['a1', 'a2']);
    expect(r.toasts).toEqual([['1 of 2 deleted. 1 file was kept: This photo is proof on a locked work order.', 'error']]);
  });

  test('nothing refused still says Deleted', async () => {
    const r = await explorerDelete({ a1: ok, a2: ok });
    expect(r.toasts).toEqual([['Deleted', undefined]]);
  });

  test('FIRES: a refusal swallowed again reads as Deleted', async () => {
    const broken = mutate(FX_SRC,
      "              kept.push((er && er.message) || 'Delete failed');\n",
      '');
    const r = await explorerDelete({ a1: refuse409(LAST, 'last_completion_photo') }, broken);
    expect(r.toasts).toEqual([['Deleted', undefined]]);
  });
});
