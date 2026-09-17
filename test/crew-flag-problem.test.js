/**
 * @jest-environment jsdom
 */
// Flag a problem on the crew link (1.29, B4 crew page).
//
// A link that can work the punch list (respond/propose, live, not a draft)
// can tell the office about a problem right away, on one building or on the
// whole work order:
//
//   - Each building card has Flag a problem, and a "Problems for the office"
//     card sits under the punch list with its own Flag a problem and a hint.
//   - The form asks what kind ("Can't get access" | "More damage than the
//     scope" | "Short on material" | "Safety problem" | "Something else"),
//     what was found (required), and up to 6 photos (Take photo / Add
//     photos). It checks both before anything is sent.
//   - What was typed survives a redraw and a closed tab (the page's draft
//     store, under 'flag:<key>').
//   - Send POSTs JSON {category, note, task_id, client_ref, photos_expected,
//     name} to /flag. The same client_ref goes again on a re-send, so a
//     problem whose answer was lost is not stored twice. Then each photo goes
//     through the page's upload queue to /flags/<id>/photo, with its upload id
//     in the form AND the X-Upload-Id header.
//   - "Sent to the office." / "Sent to the office with 3 photos." — or "Sent
//     to the office, but 2 photos didn't upload." with Retry photos (which
//     sends only the ones that failed) and Done.
//   - A problem waiting on the office shows "Needs office" on its building,
//     ahead of every other chip; a resolved one reads "Resolved by the office
//     · <when>" with the office's note.
//   - A refusal from the server is shown verbatim.
//
// Driven through the REAL inline script of service-ticket-share.html with a
// scripted fetch and a fake clock. Each guard is also shown to FIRE on a copy
// of the script with that guard broken (CRLF-normalised anchor, exactly once).
'use strict';

const fs = require('fs');
const path = require('path');
const { CREW_FLAG_FIELDS } = require('../server/services/service-ticket-flags');

const ROOT = path.join(__dirname, '..');
const SHARE_HTML = fs.readFileSync(path.join(ROOT, 'service-ticket-share.html'), 'utf8').replace(/\r\n/g, '\n');
const SHARE_SCRIPT = (() => {
  const open = SHARE_HTML.lastIndexOf('<script>');
  const close = SHARE_HTML.indexOf('</script>', open);
  if (open === -1 || close === -1) throw new Error('share page script not found');
  return SHARE_HTML.slice(open + '<script>'.length, close);
})();
const BODY_MARKUP = (() => {
  const open = SHARE_HTML.indexOf('<body>');
  const close = SHARE_HTML.lastIndexOf('<script>');
  return SHARE_HTML.slice(open + '<body>'.length, close);
})();

const TOKEN = 'f4'.repeat(32);
const API = '/api/service-ticket-share/' + TOKEN;
const DRAFT_KEY = 'st-draft:' + TOKEN.slice(0, 16);
const CREW_LABELS = ["Can't get access", 'More damage than the scope', 'Short on material', 'Safety problem', 'Something else'];
const TICKET_HINT = "Can't get in, more damage than the scope, short on material, or something unsafe? Tell the office now — don't wait for the end of the day.";
const AT = new Date(new Date().getFullYear(), 8, 14, 9, 40).toISOString();
const RESOLVED_AT = new Date(new Date().getFullYear(), 8, 14, 11, 5).toISOString();
const when = (v) => new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1 || src.indexOf(from, at + from.length) !== -1) throw new Error('anchor not found');
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('anchor not found');
  return out;
}

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body == null ? '' : JSON.stringify(body)) };
}
const networkDown = () => Promise.reject(new TypeError('Failed to fetch'));
function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

const isGet = (c) => c.method === 'GET' && c.url === API;
const isFlagPost = (c) => c.method === 'POST' && c.url === API + '/flag';
const isFlagPhoto = (id) => (c) => c.method === 'POST' && c.url === API + '/flags/' + id + '/photo';
const isBuildingPhoto = (taskId) => (c) => c.method === 'POST' && c.url === API + '/subtasks/' + taskId + '/photo';
const anyPhotoPost = (c) => c.method === 'POST' && /\/photo$/.test(c.url);

function makeNet(data) {
  const net = { calls: [], handlers: [], data };
  net.on = (pred, fn) => { net.handlers.unshift({ pred, fn, once: false }); return net; };
  net.once = (pred, fn) => { net.handlers.unshift({ pred, fn, once: true }); return net; };
  net.of = (pred) => net.calls.filter(pred);
  window.fetch = jest.fn((url, init) => {
    init = init || {};
    const call = { url: String(url), method: init.method || 'GET', init };
    net.calls.push(call);
    for (let i = 0; i < net.handlers.length; i++) {
      const h = net.handlers[i];
      if (!h.pred(call)) continue;
      if (h.once) net.handlers.splice(i, 1);
      return Promise.resolve().then(() => h.fn(call));
    }
    return networkDown();
  });
  net.on(isGet, () => res(200, net.data));
  net.on((c) => c.method === 'POST' && /\/subtasks\/[^/]+\/(note|done)$/.test(c.url), () => res(200, { ok: true }));
  net.on(isFlagPost, () => res(200, { ok: true, flag: { id: 'fl_1', task_id: null, category: 'no_access', note: 'x', status: 'open', photos: [] } }));
  return net;
}

function tasks() {
  return [
    { id: 'tk_784', title: 'Bldg 784 — Side A: rail post; tread 3', done: false, photos: [], notes: [] },
    { id: 'tk_790', title: 'Bldg 790 — Side D: stringer', done: true,
      photos: [{ id: 'ph_1', kind: 'completion', thumb_url: '/t/1.jpg', web_url: '/w/1.jpg' }], notes: [] },
  ];
}

function flag(o) {
  return Object.assign({
    id: 'fl_9', task_id: null, category: 'no_access', note: 'Gate locked, no answer at the office',
    author_label: 'Jose', status: 'open', created_at: AT, resolved_at: null, resolution_note: null, photos: [],
  }, o || {});
}

function payload(o) {
  o = o || {};
  return {
    ticket: { id: 'st_1', title: 'Replace rotted stair treads', ticket_number: 'WO-0007', status: o.status || 'in_progress', materials: [], guest_log: o.log || null },
    share: { scope: o.scope || 'respond', hide_financials: true, recipient_name: o.anon ? null : 'Rafael' },
    tasks: o.tasks || tasks(),
    site_photos: [],
    flags: o.flags || [],
    send_back: null,
    finish: { can_undo: false },
  };
}

async function flush(ms) {
  for (let i = 0; i < 80; i++) await Promise.resolve();
  if (ms) await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

async function boot(net, script) {
  document.head.innerHTML = '';
  document.body.innerHTML = BODY_MARKUP;
  window.history.replaceState({}, '', '/st/' + TOKEN);
  window.eval(script || SHARE_SCRIPT);
  await flush();
  return net;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const card = (id) => $$('.bld').find((c) => c.getAttribute('data-task') === id) || null;
const chip = (id) => card(id).querySelector('.bld-head .chip');
const formOf = (key) => $$('.flagform').find((f) => f.getAttribute('data-flag-key') === key) || null;
const slotOf = (key) => $$('.flag-slot').find((f) => f.getAttribute('data-flag-key') === key) || null;
const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function type(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function pick(inp, files) {
  Object.defineProperty(inp, 'files', { value: files, configurable: true });
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}
let stamp = 1;
const jpeg = (name) => new File(['jpeg-' + name], name, { type: 'image/jpeg', lastModified: stamp++ });

// Open the form under `key` and fill it in.
function openForm(key) {
  const m = /^t:(.+)$/.exec(key);
  // A building's button is inside its card: the crew opens the card first.
  if (m && !card(m[1]).classList.contains('open')) card(m[1]).querySelector('.bld-head').click();
  slotOf(key).querySelector('.flag-open').click();
  return formOf(key);
}
function fill(key, cat, note) {
  const form = formOf(key);
  if (cat != null) form.querySelectorAll('.flag-cat')[cat].click();
  if (note != null) type(formOf(key).querySelector('.flag-note'), note);
  return formOf(key);
}
const libraryInput = (key) => Array.from(formOf(key).querySelectorAll('input.flag-photo')).find((i) => i.hasAttribute('multiple'));
const msgOf = (key) => formOf(key).querySelector('.flag-msg');

beforeEach(() => {
  jest.useFakeTimers();
  try { window.localStorage.clear(); } catch (e) { /* nothing */ }
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════
describe('where Flag a problem is offered', () => {
  test('a respond link: on every building, and a "Problems for the office" card under the punch list with its hint', async () => {
    await boot(makeNet(payload({ log: 'Day 1: started' })));
    for (const id of ['tk_784', 'tk_790']) {
      const b = card(id).querySelector('.flag-slot .flag-open');
      expect(b.textContent).toBe('Flag a problem');
      expect(b.getAttribute('data-flag-key')).toBe('t:' + id);
      // Above the building's note row.
      expect(before(b, card(id).querySelector('.note-row'))).toBe(true);
    }
    const p = $('#problems');
    expect(p.querySelector('.lbl').textContent).toBe('Problems for the office');
    expect(slotOf('ticket').querySelector('.flag-open').textContent).toBe('Flag a problem');
    expect(slotOf('ticket').querySelector('.hint').textContent).toBe(TICKET_HINT);
    const log = $$('.card').find((c) => c.querySelector('.log'));
    const blds = $$('.bld');
    expect(before(blds[blds.length - 1], p)).toBe(true);
    expect(before(p, log)).toBe(true);
    // Not inside the finish card.
    expect($('#finishCard').contains(p)).toBe(false);
    expect(before($('#finishCard'), p)).toBe(true);
  });

  test('a view-only link, and approved / closed / cancelled / draft work orders: no Flag a problem anywhere', async () => {
    for (const o of [{ scope: 'view' }, { status: 'approved' }, { status: 'closed' }, { status: 'cancelled' }, { status: 'draft' }]) {
      await boot(makeNet(payload(o)));
      expect([o, $$('.flag-open').length, $$('.flag-slot').length, $('#problems')]).toEqual([o, 0, 0, null]);
    }
  });

  test('a view-only link still sees the problems raised, with no controls', async () => {
    await boot(makeNet(payload({ scope: 'view', flags: [flag(), flag({ id: 'fl_8', task_id: 'tk_784', category: 'safety', note: 'Loose rail' })] })));
    expect($('#problems .flag .flag-n').textContent).toBe('Gate locked, no answer at the office');
    expect(card('tk_784').querySelector('.flags .flag-n').textContent).toBe('Loose rail');
    expect(chip('tk_784').textContent).toBe('Needs office');
    expect($$('.flag-open').length).toBe(0);
  });

  test('FIRES: render the building slot without its canWork gate and a view-only link gets Flag a problem', async () => {
    const broken = mutate(SHARE_SCRIPT,
      "        (canWork\n          ? '<div class=\"flag-slot\"",
      "        (true\n          ? '<div class=\"flag-slot\"");
    await boot(makeNet(payload({ scope: 'view' })), broken);
    expect($$('.bld .flag-open').length).toBe(2);
  });

  async function staleSendAfterApproval(script) {
    const net = await boot(makeNet(payload()), script);
    openForm('ticket');
    fill('ticket', 0, 'Gate locked');
    const stale = formOf('ticket').querySelector('.flag-send');
    net.data = payload({ status: 'approved' });
    card('tk_790').querySelector('.bnote-in').value = 'x';
    card('tk_790').querySelector('.bnote-go').click();
    await flush();
    expect($$('.flagform').length).toBe(0);
    $('#root').appendChild(stale.closest('.flagform'));
    stale.click();
    await flush();
    return net;
  }

  test('once the work order is approved, a problem form left over from before sends nothing', async () => {
    const net = await staleSendAfterApproval();
    expect(net.of(isFlagPost)).toEqual([]);
  });

  test('FIRES: without the canWork check in the listener, the leftover form still sends', async () => {
    const broken = mutate(SHARE_SCRIPT, '    if (key == null || !lastCanWork) return;\n', '    if (key == null) return;\n');
    const net = await staleSendAfterApproval(broken);
    expect(net.of(isFlagPost).length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('the form', () => {
  test('on a building: its question, the five kinds as a radio group, the note box, Take photo / Add photos, the hint, Send and Cancel', async () => {
    await boot(makeNet(payload()));
    const form = openForm('t:tk_784');
    expect(form.querySelector('.flag-title').textContent).toBe("What's wrong at Bldg 784?");
    const group = form.querySelector('.flag-cats');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('Kind of problem');
    const cats = Array.from(group.querySelectorAll('.flag-cat'));
    expect(cats.map((b) => b.textContent)).toEqual(CREW_LABELS);
    expect(cats.map((b) => [b.getAttribute('role'), b.getAttribute('aria-checked')])).toEqual(CREW_LABELS.map(() => ['radio', 'false']));
    const note = form.querySelector('textarea.flag-note');
    expect(note.getAttribute('maxlength')).toBe('2000');
    expect(note.getAttribute('placeholder')).toBe('Say what you found and where — the office reads this first.');
    expect(Array.from(form.querySelectorAll('.flag-pick-btn')).map((b) => b.textContent)).toEqual(['Take photo', 'Add photos']);
    const inputs = Array.from(form.querySelectorAll('input.flag-photo'));
    expect(inputs.map((i) => [i.getAttribute('capture'), i.hasAttribute('multiple')])).toEqual([['environment', false], [null, true]]);
    expect(form.querySelector('.flag-pick-btn').classList.contains('cam-btn')).toBe(true);
    expect(form.querySelector('.hint').textContent).toBe('The office gets this as soon as you send it.');
    expect(Array.from(form.querySelectorAll('.flag-acts .btn')).map((b) => b.textContent)).toEqual(['Send to the office', 'Cancel']);
    expect(form.querySelector('.flag-msg').getAttribute('aria-live')).toBe('polite');
    // The button it replaced is gone, and the building stays open.
    expect(slotOf('t:tk_784').querySelector('.flag-open')).toBeNull();
    expect(card('tk_784').classList.contains('open')).toBe(true);
  });

  test('on the whole work order: "What\'s wrong?"', async () => {
    await boot(makeNet(payload()));
    expect(openForm('ticket').querySelector('.flag-title').textContent).toBe("What's wrong?");
  });

  test('picking a kind checks that one only', async () => {
    await boot(makeNet(payload()));
    openForm('ticket');
    fill('ticket', 3);
    expect(Array.from(formOf('ticket').querySelectorAll('.flag-cat')).map((b) => b.getAttribute('aria-checked')))
      .toEqual(['false', 'false', 'false', 'true', 'false']);
    fill('ticket', 0);
    expect(Array.from(formOf('ticket').querySelectorAll('.flag-cat')).map((b) => b.getAttribute('aria-checked')))
      .toEqual(['true', 'false', 'false', 'false', 'false']);
  });

  test('Send with no kind says "Pick what kind of problem it is." and sends nothing; with no note, "Write what the problem is first."', async () => {
    const net = await boot(makeNet(payload()));
    openForm('ticket');
    fill('ticket', null, 'Gate locked');
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(msgOf('ticket').textContent).toBe('Pick what kind of problem it is.');
    expect(msgOf('ticket').classList.contains('bad')).toBe(true);
    expect(net.of(isFlagPost)).toEqual([]);

    type(formOf('ticket').querySelector('.flag-note'), '   ');
    fill('ticket', 0);
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(msgOf('ticket').textContent).toBe('Write what the problem is first.');
    expect(net.of(isFlagPost)).toEqual([]);
  });

  test('FIRES: without the kind check, a problem with no kind is sent', async () => {
    const broken = mutate(SHARE_SCRIPT,
      "    if (!CATEGORY_CREW[f.category]) { setFlagMsg(key, 'Pick what kind of problem it is.', true); return; }\n", '');
    const net = await boot(makeNet(payload()), broken);
    openForm('ticket');
    fill('ticket', null, 'Gate locked');
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(net.of(isFlagPost).length).toBe(1);
  });

  test('Cancel closes the form and brings the button back', async () => {
    await boot(makeNet(payload()));
    openForm('t:tk_784');
    fill('t:tk_784', 1, 'Two more treads rotted');
    formOf('t:tk_784').querySelector('.flag-cancel').click();
    expect(formOf('t:tk_784')).toBeNull();
    expect(slotOf('t:tk_784').querySelector('.flag-open')).not.toBeNull();
    await flush(400);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('what was typed survives a redraw, and a closed tab (the draft store, under flag:<key>)', async () => {
    const net = await boot(makeNet(payload()));
    openForm('t:tk_784');
    fill('t:tk_784', 1, 'Two more treads rotted on side A');
    // A save elsewhere, so the whole page redraws.
    card('tk_790').querySelector('.bnote-in').value = 'Stringer shimmed';
    card('tk_790').querySelector('.bnote-go').click();
    await flush();
    expect(net.of(isGet).length).toBe(2);
    expect(formOf('t:tk_784').querySelector('.flag-note').value).toBe('Two more treads rotted on side A');
    expect(formOf('t:tk_784').querySelectorAll('.flag-cat')[1].getAttribute('aria-checked')).toBe('true');

    await flush(400);
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_KEY));
    expect(Object.keys(stored.flags)).toEqual(['flag:t:tk_784']);
    expect(stored.flags['flag:t:tk_784']).toMatchObject({ category: 'extra_damage', note: 'Two more treads rotted on side A' });
    const ref = stored.flags['flag:t:tk_784'].client_ref;
    expect(ref).toMatch(/^[0-9a-f]{16}$/);

    const net2 = await boot(makeNet(payload()));
    const form = formOf('t:tk_784');
    expect(form.querySelector('.flag-note').value).toBe('Two more treads rotted on side A');
    expect(form.querySelector('.restored').textContent).toBe("Restored what you typed earlier. It hasn't been sent yet.");
    expect(card('tk_784').classList.contains('open')).toBe(true);
    form.querySelector('.flag-send').click();
    await flush();
    expect(JSON.parse(net2.of(isFlagPost)[0].init.body).client_ref).toBe(ref);
    await flush(400);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('FIRES: without the form state in the redraw, the typed note is lost', async () => {
    const broken = mutate(SHARE_SCRIPT,
      "' placeholder=\"Say what you found and where — the office reads this first.\"' + off + '>' + esc(f.note) + '</textarea>'",
      "' placeholder=\"Say what you found and where — the office reads this first.\"' + off + '></textarea>'");
    await boot(makeNet(payload()), broken);
    openForm('t:tk_784');
    fill('t:tk_784', 1, 'Two more treads rotted');
    card('tk_790').querySelector('.bnote-in').value = 'x';
    card('tk_790').querySelector('.bnote-go').click();
    await flush();
    expect(formOf('t:tk_784').querySelector('.flag-note').value).toBe('');
  });

  test('up to 6 photos: a 7th pick is refused with "Up to 6 photos on one problem."; × takes one off', async () => {
    const net = await boot(makeNet(payload()));
    openForm('ticket');
    pick(libraryInput('ticket'), ['1', '2', '3', '4', '5', '6', '7'].map((n) => jpeg('P' + n + '.jpg')));
    expect(formOf('ticket').querySelectorAll('.flag-pend').length).toBe(6);
    expect(msgOf('ticket').textContent).toBe('Up to 6 photos on one problem.');
    const rm = formOf('ticket').querySelectorAll('.flag-photo-rm');
    expect(rm[0].getAttribute('aria-label')).toBe('Remove photo');
    rm[0].click();
    expect(formOf('ticket').querySelectorAll('.flag-pend').length).toBe(5);
    expect(msgOf('ticket').textContent).toBe('');
    expect(net.of(anyPhotoPost)).toEqual([]);
  });

  // The form is open when the page redraws, so the building's own wiring
  // walks past its inputs.
  async function pickOnRedrawnForm(script) {
    const net = await boot(makeNet(payload()), script);
    net.on(isBuildingPhoto('tk_784'), () => res(200, { ok: true, photo: { id: 'ph_x', kind: 'completion', thumb_url: '/t/x', web_url: '/w/x' } }));
    openForm('t:tk_784');
    card('tk_790').querySelector('.bnote-in').value = 'x';
    card('tk_790').querySelector('.bnote-go').click();
    await flush();
    expect(net.of(isGet).length).toBe(2);
    pick(libraryInput('t:tk_784'), [jpeg('DAMAGE.jpg')]);
    await flush();
    return net;
  }

  test('a photo picked on a building\'s problem form is not a building photo: nothing is sent before Send', async () => {
    const net = await pickOnRedrawnForm();
    expect(net.of(anyPhotoPost)).toEqual([]);
    expect(card('tk_784').querySelector('.photos[data-sec="completion"] .lbl').textContent).toBe('Completion photos · 0');
    expect(formOf('t:tk_784').querySelectorAll('.flag-pend').length).toBe(1);
  });

  // ── the picker is open while the page redraws itself ──────────────────
  // The crew taps Take photo and the camera sheet opens. Behind it the page
  // keeps running: the upload queue settles and calls load() 600 ms later, or
  // the netbar retries — either way render() replaces #root and DETACHES the
  // very input the sheet is filling. A detached input's change event reaches
  // neither #root nor document, so a delegated listener never hears it: the
  // photo would be dropped with no tile and no message, and the problem would
  // reach the office with nothing attached. Only a listener ON THE INPUT runs.
  async function pickIntoDetachedInput(script) {
    const net = await boot(makeNet(payload()), script);
    net.on(isFlagPhoto('fl_1'), (c) => res(200, { ok: true, photo: { id: 'att_' + c.init.body.get('file').name, thumb_url: '/t/d', web_url: '/w/d' } }));
    openForm('t:tk_784');
    fill('t:tk_784', 1, 'Two more treads rotted on side A');
    const picker = libraryInput('t:tk_784');          // the sheet is open on THIS input
    // A save elsewhere finishes and the page redraws under the open sheet.
    card('tk_790').querySelector('.bnote-in').value = 'Stringer shimmed';
    card('tk_790').querySelector('.bnote-go').click();
    await flush();
    expect(net.of(isGet).length).toBe(2);
    expect(document.contains(picker)).toBe(false);    // really detached
    expect(picker.isConnected).toBe(false);
    pick(picker, [jpeg('DAMAGE.jpg')]);               // the crew taps Use Photo
    await flush();
    return net;
  }

  test('a photo picked while the page redrew under the open picker is kept, shown on the form, and sent with the problem', async () => {
    const net = await pickIntoDetachedInput();
    expect(formOf('t:tk_784').querySelectorAll('.flag-pend').length).toBe(1);
    expect(net.of(anyPhotoPost)).toEqual([]);          // nothing goes before Send
    formOf('t:tk_784').querySelector('.flag-send').click();
    await flush();
    expect(JSON.parse(net.of(isFlagPost)[0].init.body).photos_expected).toBe(1);
    expect(net.of(isFlagPhoto('fl_1')).map((c) => c.init.body.get('file').name)).toEqual(['DAMAGE.jpg']);
    expect(slotOf('t:tk_784').querySelector('.flag-sent').textContent).toBe('Sent to the office with 1 photo.');
  });

  test('FIRES: back on a delegated change listener and the damage photo is dropped without a word', async () => {
    const broken = mutate(SHARE_SCRIPT,
      "      inp.addEventListener('change', function () {\n        if (!alive() || !lastCanWork) return;\n        pickFlagPhotos(inp.getAttribute('data-flag-key'), inp);\n      });\n",
      "      root.addEventListener('change', function (e) {\n        if (!alive() || !lastCanWork || !root.contains(e.target) || e.target !== inp) return;\n        pickFlagPhotos(inp.getAttribute('data-flag-key'), inp);\n      });\n");
    const net = await pickIntoDetachedInput(broken);
    // No tile, no message: the crew has no way to know the photo was lost.
    expect(formOf('t:tk_784').querySelectorAll('.flag-pend').length).toBe(0);
    expect(msgOf('t:tk_784').textContent).toBe('');
    formOf('t:tk_784').querySelector('.flag-send').click();
    await flush();
    expect(JSON.parse(net.of(isFlagPost)[0].init.body).photos_expected).toBe(0);
    expect(net.of(isFlagPhoto('fl_1'))).toEqual([]);
  });

  test('the form still picks normally when nothing redrew, and a redrawn form picks on its own new inputs', async () => {
    const net = await boot(makeNet(payload()));
    openForm('ticket');
    pick(libraryInput('ticket'), [jpeg('A.jpg')]);
    expect(formOf('ticket').querySelectorAll('.flag-pend').length).toBe(1);
    // Redraw, then pick on the input the redraw created.
    card('tk_790').querySelector('.bnote-in').value = 'x';
    card('tk_790').querySelector('.bnote-go').click();
    await flush();
    pick(libraryInput('ticket'), [jpeg('B.jpg')]);
    expect(formOf('ticket').querySelectorAll('.flag-pend').length).toBe(2);
    expect(net.of(anyPhotoPost)).toEqual([]);
  });

  test('a stale input on a work order the office has approved cannot pick: the crew rule is asked on every change', async () => {
    const net = await boot(makeNet(payload()));
    openForm('ticket');
    const picker = libraryInput('ticket');
    net.data = payload({ status: 'approved' });       // the office approved it
    card('tk_790').querySelector('.bnote-in').value = 'x';
    card('tk_790').querySelector('.bnote-go').click();
    await flush();
    expect($$('.flagform').length).toBe(0);
    pick(picker, [jpeg('LATE.jpg')]);
    await flush();
    expect(net.of(anyPhotoPost)).toEqual([]);
    expect($$('.flag-pend').length).toBe(0);
  });

  test('FIRES: wire the problem form\'s inputs as building photos and the damage photo becomes completion proof', async () => {
    const broken = mutate(SHARE_SCRIPT, "        if (inp.hasAttribute('data-flag-key')) return;\n", '');
    const net = await pickOnRedrawnForm(broken);
    expect(net.of(isBuildingPhoto('tk_784')).length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sending', () => {
  async function sendWithPhotos(net, key, names) {
    openForm(key);
    fill(key, 0, 'Gate locked, manager not answering');
    if (names.length) pick(libraryInput(key), names.map(jpeg));
    formOf(key).querySelector('.flag-send').click();
    await flush();
  }

  test('a problem with 2 photos: JSON to /flag, then each photo to /flags/<id>/photo with its upload id in the form and the header; "Sent to the office with 2 photos."', async () => {
    const net = makeNet(payload());
    net.on(isFlagPost, () => res(200, { ok: true, flag: flag({ id: 'fl_77', task_id: 'tk_784' }) }));
    net.on(isFlagPhoto('fl_77'), (c) => res(200, { ok: true, photo: { id: 'att_' + c.init.body.get('file').name, thumb_url: '/t/f', web_url: '/w/f' } }));
    await boot(net);
    await sendWithPhotos(net, 't:tk_784', ['D1.jpg', 'D2.jpg']);

    const posts = net.of(isFlagPost);
    expect(posts.length).toBe(1);
    expect(posts[0].init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(posts[0].init.body);
    expect(Object.keys(body).sort()).toEqual(['category', 'client_ref', 'note', 'photos_expected', 'task_id']);
    for (const k of Object.keys(body)) expect(CREW_FLAG_FIELDS).toContain(k);
    expect(body).toMatchObject({ category: 'no_access', note: 'Gate locked, manager not answering', task_id: 'tk_784', photos_expected: 2 });
    expect(body.client_ref).toMatch(/^[0-9a-f]{16}$/);

    const photos = net.of(isFlagPhoto('fl_77'));
    expect(photos.map((c) => c.init.body.get('file').name)).toEqual(['D1.jpg', 'D2.jpg']);
    expect(photos.map((c) => Array.from(c.init.body.keys()))).toEqual([['upload_id', 'file'], ['upload_id', 'file']]);
    for (const c of photos) {
      expect(c.init.body.get('upload_id')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(c.init.headers['X-Upload-Id']).toBe(c.init.body.get('upload_id'));
    }
    expect(net.of(isBuildingPhoto('tk_784'))).toEqual([]);

    // Sent: the form is closed, the building stays open and says so, and the
    // page reads again to show the problem.
    expect(formOf('t:tk_784')).toBeNull();
    expect(slotOf('t:tk_784').querySelector('.flag-sent').textContent).toBe('Sent to the office with 2 photos.');
    expect(card('tk_784').classList.contains('open')).toBe(true);
    expect(net.of(isGet).length).toBeGreaterThanOrEqual(2);
  });

  test('FIRES: without the X-Upload-Id header, the photo door cannot recognise a retried photo early', async () => {
    const broken = mutate(SHARE_SCRIPT, "    if (toFlag) init.headers = { 'X-Upload-Id': item.uploadId };\n", '');
    const net = makeNet(payload());
    net.on(isFlagPost, () => res(200, { ok: true, flag: flag({ id: 'fl_77' }) }));
    net.on(isFlagPhoto('fl_77'), () => res(200, { ok: true, photo: { id: 'att_1' } }));
    await boot(net, broken);
    await sendWithPhotos(net, 'ticket', ['D1.jpg']);
    expect(net.of(isFlagPhoto('fl_77')).map((c) => (c.init.headers || {})['X-Upload-Id'])).toEqual([undefined]);
  });

  test('FIRES: without the problem door branch, its photos land on the work order as site photos', async () => {
    const broken = mutate(SHARE_SCRIPT, '    var url = toFlag\n', '    var url = false\n');
    const net = makeNet(payload());
    net.on(isFlagPost, () => res(200, { ok: true, flag: flag({ id: 'fl_77' }) }));
    net.on(anyPhotoPost, () => res(200, { ok: true, photo: { id: 'att_1' } }));
    await boot(net, broken);
    await sendWithPhotos(net, 'ticket', ['D1.jpg']);
    expect(net.of(isFlagPhoto('fl_77'))).toEqual([]);
    expect(net.of((c) => c.method === 'POST' && c.url === API + '/photo').length).toBe(1);
  });

  test('no photos: "Sent to the office.", kept over the reads that follow until Flag a problem is pressed again', async () => {
    const net = await boot(makeNet(payload()));
    await sendWithPhotos(net, 'ticket', []);
    const body = JSON.parse(net.of(isFlagPost)[0].init.body);
    expect(body).toMatchObject({ task_id: null, photos_expected: 0 });
    expect(slotOf('ticket').querySelector('.flag-sent').textContent).toBe('Sent to the office.');
    card('tk_790').querySelector('.bnote-in').value = 'x';
    card('tk_790').querySelector('.bnote-go').click();
    await flush(1000);
    expect(net.of(isGet).length).toBe(3);
    expect(slotOf('ticket').querySelector('.flag-sent').textContent).toBe('Sent to the office.');
    openForm('ticket');
    formOf('ticket').querySelector('.flag-cancel').click();
    expect(slotOf('ticket').querySelector('.flag-sent')).toBeNull();
  });

  test('a problem with photos: the quiet read after the photos settle keeps "Sent to the office with 1 photo."', async () => {
    const net = makeNet(payload());
    net.on(isFlagPost, () => res(200, { ok: true, flag: flag({ id: 'fl_q' }) }));
    net.on(isFlagPhoto('fl_q'), () => res(200, { ok: true, photo: { id: 'att_q' } }));
    await boot(net);
    await sendWithPhotos(net, 'ticket', ['Q.jpg']);
    await flush(1000);
    expect(net.of(isGet).length).toBeGreaterThanOrEqual(2);
    expect(slotOf('ticket').querySelector('.flag-sent').textContent).toBe('Sent to the office with 1 photo.');
  });

  test('the name typed on an anonymous link rides along', async () => {
    const net = await boot(makeNet(payload({ anon: true })));
    type($('#crewname'), 'Jose');
    await sendWithPhotos(net, 'ticket', []);
    expect(JSON.parse(net.of(isFlagPost)[0].init.body).name).toBe('Jose');
  });

  test('while sending, Send is off and says Sending…', async () => {
    const net = makeNet(payload());
    const hold = deferred();
    net.on(isFlagPost, () => hold.promise);
    await boot(net);
    openForm('ticket');
    fill('ticket', 4, 'Resident dog loose in the yard');
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(formOf('ticket').querySelector('.flag-send').disabled).toBe(true);
    expect(msgOf('ticket').textContent).toBe('Sending…');
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(net.of(isFlagPost).length).toBe(1);
    hold.resolve(res(200, { ok: true, flag: flag({ id: 'fl_5' }) }));
    await flush();
    expect(slotOf('ticket').querySelector('.flag-sent').textContent).toBe('Sent to the office.');
  });

  test('a refusal from the server is shown verbatim, and what was typed stays', async () => {
    const net = makeNet(payload());
    const refusal = 'This work order already has 20 problems waiting on the office. Call the office instead.';
    net.on(isFlagPost, () => res(429, { error: refusal }));
    await boot(net);
    openForm('ticket');
    fill('ticket', 2, 'Short 4 treads');
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(msgOf('ticket').textContent).toBe(refusal);
    expect(msgOf('ticket').classList.contains('bad')).toBe(true);
    expect(formOf('ticket').querySelector('.flag-note').value).toBe('Short 4 treads');
    expect(formOf('ticket').querySelector('.flag-send').disabled).toBe(false);
  });

  test('no signal: says so; sending again goes with the same client_ref', async () => {
    const net = makeNet(payload());
    net.once(isFlagPost, networkDown);
    await boot(net);
    openForm('ticket');
    fill('ticket', 0, 'Gate locked');
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(msgOf('ticket').textContent).toBe("Couldn't send that. Check your signal and try again.");
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    const refs = net.of(isFlagPost).map((c) => JSON.parse(c.init.body).client_ref);
    expect(refs.length).toBe(2);
    expect(refs[0]).toBe(refs[1]);
    expect(slotOf('ticket').querySelector('.flag-sent').textContent).toBe('Sent to the office.');
  });

  test('a 200 that is not the server\'s answer is not a sent problem', async () => {
    const net = makeNet(payload());
    net.once(isFlagPost, () => ({ ok: true, status: 200, text: () => Promise.resolve('<html>Sign in</html>') }));
    await boot(net);
    openForm('ticket');
    fill('ticket', 0, 'Gate locked');
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(formOf('ticket')).not.toBeNull();
    expect(msgOf('ticket').textContent).toBe("Couldn't send that. Check your signal and try again.");
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('photos that did not go', () => {
  test('one photo fails: "Sent to the office, but 1 photo didn\'t upload." with Retry photos and Done; Retry sends only that one, under the same upload id', async () => {
    const net = makeNet(payload());
    net.on(isFlagPost, () => res(200, { ok: true, flag: flag({ id: 'fl_3' }) }));
    let failBad = true;
    net.on(isFlagPhoto('fl_3'), (c) => {
      const name = c.init.body.get('file').name;
      if (name === 'BAD.jpg' && failBad) return networkDown();
      return res(200, { ok: true, photo: { id: 'att_' + name, thumb_url: '/t/' + name, web_url: '/w/' + name } });
    });
    await boot(net);
    openForm('ticket');
    fill('ticket', 1, 'Joist rot under 3 treads');
    pick(libraryInput('ticket'), [jpeg('GOOD.jpg'), jpeg('BAD.jpg')]);
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    expect(msgOf('ticket').textContent).toMatch(/^Uploading photo \d of 2…$/);
    await flush(3000);
    await flush(15000);

    const names = () => net.of(isFlagPhoto('fl_3')).map((c) => c.init.body.get('file').name);
    expect(names()).toEqual(['GOOD.jpg', 'BAD.jpg', 'BAD.jpg', 'BAD.jpg']);
    expect(msgOf('ticket').textContent).toBe("Sent to the office, but 1 photo didn't upload.");
    expect(Array.from(formOf('ticket').querySelectorAll('.flag-acts .btn')).map((b) => b.textContent)).toEqual(['Retry photos', 'Done']);
    expect(formOf('ticket').querySelector('.shot.pending .st').textContent).toBe('Not sent');

    failBad = false;
    formOf('ticket').querySelector('.flag-retry').click();
    await flush();
    expect(names()).toEqual(['GOOD.jpg', 'BAD.jpg', 'BAD.jpg', 'BAD.jpg', 'BAD.jpg']);
    const ids = net.of(isFlagPhoto('fl_3')).filter((c) => c.init.body.get('file').name === 'BAD.jpg').map((c) => c.init.body.get('upload_id'));
    expect(new Set(ids).size).toBe(1);
    expect(formOf('ticket')).toBeNull();
    expect(slotOf('ticket').querySelector('.flag-sent').textContent).toBe('Sent to the office with 2 photos.');
    // One problem stored, never a second.
    expect(net.of(isFlagPost).length).toBe(1);
  });

  test('FIRES: without the queue retry behind it, Retry photos sends nothing', async () => {
    const broken = mutate(SHARE_SCRIPT, "      queue.retry('flag:' + f.flagId);\n", '');
    const net = makeNet(payload());
    net.on(isFlagPost, () => res(200, { ok: true, flag: flag({ id: 'fl_3' }) }));
    net.on(isFlagPhoto('fl_3'), (c) => (c.init.body.get('file').name === 'BAD.jpg' ? networkDown() : res(200, { ok: true, photo: { id: 'att_g' } })));
    await boot(net, broken);
    openForm('ticket');
    fill('ticket', 1, 'Joist rot');
    pick(libraryInput('ticket'), [jpeg('GOOD.jpg'), jpeg('BAD.jpg')]);
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    await flush(3000);
    await flush(15000);
    const sent = net.of(isFlagPhoto('fl_3')).length;
    formOf('ticket').querySelector('.flag-retry').click();
    await flush(20000);
    expect(net.of(isFlagPhoto('fl_3')).length).toBe(sent);
  });

  test('Done closes it with what did land', async () => {
    const net = makeNet(payload());
    net.on(isFlagPost, () => res(200, { ok: true, flag: flag({ id: 'fl_4' }) }));
    net.on(isFlagPhoto('fl_4'), (c) => (c.init.body.get('file').name === 'BAD.jpg' ? networkDown() : res(200, { ok: true, photo: { id: 'att_g' } })));
    await boot(net);
    openForm('ticket');
    fill('ticket', 1, 'Joist rot');
    pick(libraryInput('ticket'), [jpeg('GOOD.jpg'), jpeg('BAD.jpg')]);
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    await flush(3000);
    await flush(15000);
    formOf('ticket').querySelector('.flag-done').click();
    await flush();
    expect(formOf('ticket')).toBeNull();
    expect(slotOf('ticket').querySelector('.flag-sent').textContent).toBe('Sent to the office with 1 photo.');
    // Nothing unsettled is left to hold the page.
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });

  async function flagPhotoRefusedWhileBuildingPhotoWaits(script) {
    const net = makeNet(payload());
    net.on(isFlagPost, () => res(200, { ok: true, flag: flag({ id: 'fl_6' }) }));
    const hold = deferred();
    net.on(isFlagPhoto('fl_6'), () => hold.promise);
    net.on(isBuildingPhoto('tk_784'), () => res(200, { ok: true, photo: { id: 'ph_b', kind: 'completion', thumb_url: '/t/b', web_url: '/w/b' } }));
    await boot(net, script);
    openForm('ticket');
    fill('ticket', 1, 'Joist rot');
    pick(libraryInput('ticket'), [jpeg('FULL.jpg')]);
    formOf('ticket').querySelector('.flag-send').click();
    await flush();
    // A building photo picked while the problem's photo is still going.
    pick(card('tk_784').querySelector('input[type=file][multiple][data-kind="completion"]'), [jpeg('BLDG.jpg')]);
    await flush();
    hold.resolve(res(409, { error: 'That problem already has 6 photos.' }));
    await flush();
    return net;
  }

  test('a problem photo the door refuses (409) is refused alone: the building photo waiting behind it still goes, and the reason is shown with Done only', async () => {
    const net = await flagPhotoRefusedWhileBuildingPhotoWaits();
    expect(net.of(isBuildingPhoto('tk_784')).length).toBe(1);
    expect(msgOf('ticket').textContent).toBe("Sent to the office, but 1 photo didn't upload.\nFULL.jpg wasn't sent: That problem already has 6 photos.");
    expect(Array.from(formOf('ticket').querySelectorAll('.flag-acts .btn')).map((b) => b.textContent)).toEqual(['Done']);
  });

  test('FIRES: pass the 409 on as it came and the queue refuses the building photo too', async () => {
    const broken = mutate(SHARE_SCRIPT, '      if (toFlag && err && Number(err.status) === 409) err.status = 400;\n', '');
    const net = await flagPhotoRefusedWhileBuildingPhotoWaits(broken);
    expect(net.of(isBuildingPhoto('tk_784'))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('problems already raised', () => {
  const FLAGS = () => [
    flag({ id: 'fl_t', task_id: null, category: 'safety', note: 'Live wire by the pool gate', author_label: 'Jose', created_at: AT,
      photos: [{ id: 'att_p', thumb_url: '/t/p.jpg', web_url: '/w/p.jpg' }] }),
    flag({ id: 'fl_b', task_id: 'tk_784', category: 'extra_damage', note: 'Stringer split too', author_label: null, created_at: AT }),
    flag({ id: 'fl_r', task_id: 'tk_790', category: 'material_short', note: 'Short 2 treads', status: 'resolved',
      resolved_at: RESOLVED_AT, resolution_note: 'Delivery tomorrow 8am' }),
    flag({ id: 'fl_gone', task_id: 'tk_gone', category: 'other', note: 'On a building no longer listed' }),
  ];

  test('a building\'s problems under "Flagged for the office"; the work order\'s in the Problems card with who is waiting', async () => {
    await boot(makeNet(payload({ flags: FLAGS() })));
    const b = card('tk_784').querySelector('.flags');
    expect(b.querySelector('.lbl').textContent).toBe('Flagged for the office');
    expect(b.querySelector('.flag-h').textContent).toBe('More damage than the scope · ' + when(AT));
    expect(b.querySelector('.flag-state').textContent).toBe('Waiting on the office');

    const p = $('#problems');
    expect(Array.from(p.querySelectorAll('.flag .flag-n')).map((n) => n.textContent)).toEqual(['Live wire by the pool gate', 'On a building no longer listed']);
    expect(p.querySelector('.flag-h').textContent).toBe('Safety problem · Jose · ' + when(AT));
    expect(p.querySelector('.flag .shot').getAttribute('href')).toBe('/w/p.jpg');
    expect(p.querySelector('.flag .shot img').getAttribute('src')).toBe('/t/p.jpg');
    expect(p.querySelector('.flag-wait').textContent).toBe('Waiting on the office: Bldg 784');
  });

  test('resolved: "Resolved by the office · <when>" and the office\'s note', async () => {
    await boot(makeNet(payload({ flags: FLAGS() })));
    const r = card('tk_790').querySelector('.flag.resolved');
    expect(r.querySelector('.flag-state').textContent).toBe('Resolved by the office · ' + when(RESOLVED_AT));
    expect(r.querySelector('.flag-res-note').textContent).toBe('Delivery tomorrow 8am');
  });

  test('"Needs office" on a building with an open problem, ahead of Done; a resolved one leaves the chip alone', async () => {
    await boot(makeNet(payload({
      flags: [flag({ id: 'a', task_id: 'tk_790', status: 'open' })],
    })));
    expect(chip('tk_790').textContent).toBe('Needs office');
    expect(chip('tk_790').className).toBe('chip flag');
    expect(chip('tk_784').textContent).toBe('Needs photo');
    await boot(makeNet(payload({ flags: [flag({ id: 'a', task_id: 'tk_790', status: 'resolved', resolved_at: RESOLVED_AT })] })));
    expect(chip('tk_790').textContent).toBe('✓ Done');
  });

  test('FIRES: without the open-problem line first, a done building hides its problem behind Done', async () => {
    const broken = mutate(SHARE_SCRIPT, "    if (openFlagsOf(x.id).length) return '<span class=\"chip flag\">Needs office</span>';\n", '');
    await boot(makeNet(payload({ flags: [flag({ id: 'a', task_id: 'tk_790', status: 'open' })] })), broken);
    expect(chip('tk_790').textContent).toBe('✓ Done');
  });

  test('what the crew and the office wrote is text, never markup', async () => {
    await boot(makeNet(payload({
      flags: [flag({ note: '<img src=x onerror="window.__fl=1">', author_label: '<b>J</b>', status: 'resolved', resolved_at: RESOLVED_AT, resolution_note: '<script>window.__fl=2</script>' })],
    })));
    const f = $('#problems .flag');
    expect(f.querySelector('img')).toBeNull();
    expect(f.querySelector('b')).toBeNull();
    expect(f.querySelector('.flag-n').textContent).toBe('<img src=x onerror="window.__fl=1">');
    expect(f.querySelector('.flag-res-note').textContent).toBe('<script>window.__fl=2</script>');
    expect(window.__fl).toBeUndefined();
  });
});
