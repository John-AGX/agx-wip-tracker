/**
 * @jest-environment jsdom
 */
// Finish whole work order on the crew link (1.29, A1 crew page).
//
// The old "Mark work complete" button sat in the field report and let a crew
// member skip the punch list. It is gone. In its place, a card right under
// the punch list, drawn only when the link can work the punch list
// (respond/propose, live, not a draft):
//
//   - While any building is open, Finish whole work order is OFF and says how
//     many are left, in the server's counting words ("18 of 21 buildings
//     aren't finished. Mark each building complete above — when the last one
//     is done, the office is told automatically.").
//   - With every building done, or no punch list at all, Finish asks once
//     more, inline ("Finish the whole work order? All N buildings are done. /
//     This work order has no punch list. The office will be asked to approve
//     it." with Yes, finish it / Cancel). Yes PATCHes status work_complete
//     with the typed note and name, after any field-report photo still on
//     its way, then reads the work order again. A refusal is shown in the
//     card, verbatim.
//   - At Work complete: "Marked work complete. The office will review it."
//     and, while the server says this link may take it back (finish.can_undo),
//     Undo — not finished yet, which PATCHes status in_progress.
//
// Driven through the REAL inline script of service-ticket-share.html with a
// scripted fetch and a fake clock. Each guard is also shown to FIRE on a copy
// of the script with that guard broken (CRLF-normalised anchor, exactly once).
'use strict';

const fs = require('fs');
const path = require('path');

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

const TOKEN = 'a1'.repeat(32);
const API = '/api/service-ticket-share/' + TOKEN;
// The note's idempotency key (1.30): an opaque token, minted per unsent note,
// sent only when the body carries a note.
const REF = expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/);

const OPEN_LINE_18 = "18 of 21 buildings aren't finished. Mark each building complete above — when the last one is done, the office is told automatically.";
const ENABLED_HINT = 'Tells the office the whole job is done and ready for approval.';

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
function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

const isGet = (c) => c.method === 'GET' && c.url === API;
const isPatch = (c) => c.method === 'PATCH' && c.url === API;
const isSitePhoto = (c) => c.method === 'POST' && c.url === API + '/photo';

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
    return Promise.reject(new TypeError('Failed to fetch'));
  });
  net.on(isGet, () => res(200, net.data));
  net.on(isPatch, () => res(200, { ok: true }));
  return net;
}

function buildings(total, done) {
  const out = [];
  for (let i = 0; i < total; i++) {
    out.push({
      id: 'tk_' + (700 + i), title: 'Bldg ' + (700 + i) + ' — Side A: rail post', done: i < done,
      photos: [{ id: 'ph_' + i, kind: 'completion', thumb_url: '/t/' + i, web_url: '/w/' + i }], notes: [],
    });
  }
  return out;
}

function payload(o) {
  o = o || {};
  return {
    ticket: { id: 'st_1', title: 'Replace rotted stair treads', ticket_number: 'WO-0007', status: o.status || 'in_progress', materials: [] },
    share: { scope: o.scope || 'respond', hide_financials: true, recipient_name: o.anon ? null : 'Rafael' },
    tasks: o.tasks || [],
    site_photos: [],
    finish: o.finish || { can_undo: false },
  };
}

async function flush(ms) {
  for (let i = 0; i < 60; i++) await Promise.resolve();
  if (ms) await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 60; i++) await Promise.resolve();
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

beforeEach(() => {
  jest.useFakeTimers();
  try { window.localStorage.clear(); } catch (e) { /* nothing */ }
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════
describe('buildings still open: Finish is off and says how many', () => {
  test('3 of 21 done: #finishBtn is disabled with the server\'s sentence; the card sits after the last building and before the field report; the report has no Mark work complete', async () => {
    const net = await boot(makeNet(payload({ tasks: buildings(21, 3) })));
    const btn = $('#finishBtn');
    expect(btn.textContent).toBe('Finish whole work order');
    expect(btn.disabled).toBe(true);
    expect(btn.className).toBe('btn go big');
    expect($('#finishCard .hint').textContent).toBe(OPEN_LINE_18);
    expect($('#finishConfirm')).toBeNull();
    const blds = $$('.bld');
    expect(blds.length).toBe(21);
    expect(before(blds[20], $('#finishCard'))).toBe(true);
    expect(before($('#finishCard'), $('#report'))).toBe(true);
    expect($('#complete')).toBeNull();
    expect(document.body.textContent).not.toContain('Mark work complete');
    btn.click();
    await flush();
    expect(net.of(isPatch)).toEqual([]);
  });

  test('the counting words follow the server: "1 of 21 buildings isn\'t", "1 of 1 building isn\'t", "2 of 2 buildings aren\'t"', async () => {
    const hint = async (total, done) => {
      await boot(makeNet(payload({ tasks: buildings(total, done) })));
      return $('#finishCard .hint').textContent.split(' finished.')[0];
    };
    expect(await hint(21, 20)).toBe("1 of 21 buildings isn't");
    expect(await hint(1, 0)).toBe("1 of 1 building isn't");
    expect(await hint(2, 0)).toBe("2 of 2 buildings aren't");
  });

  test('FIRES: without the disabled attribute, Finish is offered with buildings open', async () => {
    const broken = mutate(SHARE_SCRIPT,
      '\'<button type="button" id="finishBtn" class="btn go big" disabled>Finish whole work order</button>\'',
      '\'<button type="button" id="finishBtn" class="btn go big">Finish whole work order</button>\'');
    await boot(makeNet(payload({ tasks: buildings(21, 3) })), broken);
    expect($('#finishBtn').disabled).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('nothing left open: Finish asks once more, then sends', () => {
  test('no punch list: Finish shows the question; Cancel hides it and sends nothing', async () => {
    const net = await boot(makeNet(payload()));
    const btn = $('#finishBtn');
    expect(btn.disabled).toBe(false);
    expect($('#finishCard .hint').textContent).toBe(ENABLED_HINT);
    expect($('#finishConfirm').hidden).toBe(true);

    btn.click();
    expect($('#finishConfirm').hidden).toBe(false);
    expect(btn.hidden).toBe(true);
    expect($('#finishConfirm .finish-q').textContent)
      .toBe('Finish the whole work order? This work order has no punch list. The office will be asked to approve it.');
    expect($$('#finishConfirm button').map((b) => b.textContent)).toEqual(['Yes, finish it', 'Cancel']);

    $('#finishNo').click();
    await flush();
    expect($('#finishConfirm').hidden).toBe(true);
    expect($('#finishBtn').hidden).toBe(false);
    expect(net.of(isPatch)).toEqual([]);
  });

  test('FIRES: a Finish that sends straight away skips the question', async () => {
    const broken = mutate(SHARE_SCRIPT,
      '      finishOpen = true;\n      box.hidden = false;\n',
      '      startReport(true);\n      return;\n');
    const net = await boot(makeNet(payload()), broken);
    $('#finishBtn').click();
    await flush();
    expect(net.of(isPatch).length).toBe(1);
  });

  test('every building done: "All 2 buildings are done."', async () => {
    await boot(makeNet(payload({ tasks: buildings(2, 2) })));
    $('#finishBtn').click();
    expect($('#finishConfirm .finish-q').textContent)
      .toBe('Finish the whole work order? All 2 buildings are done. The office will be asked to approve it.');
  });

  test('Yes PATCHes {status: work_complete, note, name} once, then reads the work order again and shows the stamp', async () => {
    const net = await boot(makeNet(payload({ anon: true })));
    type($('#crewname'), 'Jose');
    type($('#note'), 'All six stair runs done');
    $('#finishBtn').click();
    net.data = payload({ anon: true, status: 'work_complete', finish: { can_undo: true } });
    $('#finishYes').click();
    expect($('#finishYes').disabled).toBe(true);
    expect($('#fmsg').textContent).toBe('Saving…');
    await flush();
    expect(net.of(isPatch).map((c) => JSON.parse(c.init.body))).toEqual([{ status: 'work_complete', note: 'All six stair runs done', name: 'Jose', client_ref: REF }]);
    expect(net.of(isGet).length).toBe(2);
    expect($('#finishCard .done-note').textContent).toBe('Marked work complete. The office will review it.');
    expect($('#finishBtn')).toBeNull();
    expect($('#note').value).toBe('');
  });

  test('the question stays open across a redraw', async () => {
    await boot(makeNet(payload()));
    $('#finishBtn').click();
    type($('#note'), 'Gate code changed to 4411');
    $('#save').click();
    await flush();
    expect($('#finishConfirm').hidden).toBe(false);
    expect($('#finishBtn').hidden).toBe(true);
  });

  test('a refusal is shown in the card, verbatim, and Yes can be pressed again', async () => {
    const net = await boot(makeNet(payload()));
    const refusal = "2 of 3 buildings aren't finished. Finish each building on the punch list first — the office is told automatically when the last one is done.";
    net.once(isPatch, () => res(409, { error: refusal, code: 'buildings_open', open: 2, total: 3 }));
    $('#finishBtn').click();
    $('#finishYes').click();
    await flush();
    expect($('#fmsg').textContent).toBe(refusal);
    expect($('#fmsg').classList.contains('bad')).toBe(true);
    expect($('#finishYes').disabled).toBe(false);
    expect($('#finishNo').disabled).toBe(false);
  });

  async function finishWhileSitePhotoGoes(script) {
    const net = await boot(makeNet(payload()), script);
    const hold = deferred();
    net.on(isSitePhoto, () => hold.promise);
    pick(document.getElementById('photo'), [jpeg('SITE_F.jpg')]);
    await flush();
    $('#finishBtn').click();
    $('#finishYes').click();
    await flush();
    return { net, hold };
  }

  test('a field-report photo still on its way: Yes waits for it, then sends once', async () => {
    const { net, hold } = await finishWhileSitePhotoGoes();
    expect(net.of(isPatch)).toEqual([]);
    expect($('#fmsg').textContent).toBe('Waiting for 1 photo to finish, then the work order will be finished.');
    expect($('#finishYes').disabled).toBe(true);
    expect($('#save').disabled).toBe(true);
    hold.resolve(res(200, { ok: true, photo: { id: 'a_f', kind: 'site', thumb_url: '/t/f', web_url: '/w/f' } }));
    await flush();
    expect(net.of(isPatch).map((c) => JSON.parse(c.init.body))).toEqual([{ status: 'work_complete' }]);
  });

  test('FIRES: without the wait, the finish goes before the photo lands', async () => {
    const broken = mutate(SHARE_SCRIPT, "    if (busyCount('site')) {\n      reportWait", "    if (false) {\n      reportWait");
    const { net } = await finishWhileSitePhotoGoes(broken);
    expect(net.of(isPatch).length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('at Work complete', () => {
  test('with finish.can_undo: the stamp and Undo — not finished yet, which PATCHes {status: in_progress} and reads again', async () => {
    const net = await boot(makeNet(payload({ status: 'work_complete', tasks: buildings(2, 2), finish: { can_undo: true } })));
    expect($('#finishCard .done-note').textContent).toBe('Marked work complete. The office will review it.');
    const undo = $('#finishUndo');
    expect(undo.textContent).toBe('Undo — not finished yet');
    expect(undo.className).toBe('btn quiet big');
    expect($('#finishCard .hint').textContent).toBe('You can take this back until the office acts on it.');
    expect($('#finishBtn')).toBeNull();
    net.data = payload({ status: 'in_progress', tasks: buildings(2, 2) });
    undo.click();
    await flush();
    expect(net.of(isPatch).map((c) => JSON.parse(c.init.body))).toEqual([{ status: 'in_progress' }]);
    expect(net.of(isGet).length).toBe(2);
    expect($('#finishBtn').disabled).toBe(false);
  });

  test('without can_undo: the stamp and no Undo', async () => {
    await boot(makeNet(payload({ status: 'work_complete', finish: { can_undo: false } })));
    expect($('#finishCard .done-note').textContent).toBe('Marked work complete. The office will review it.');
    expect($('#finishUndo')).toBeNull();
    expect($('#finishCard .hint')).toBeNull();
  });

  test('an Undo the office already acted on shows the server\'s sentence and can be pressed again', async () => {
    const net = await boot(makeNet(payload({ status: 'work_complete', finish: { can_undo: true } })));
    const refusal = "The office has already acted on this work order, so it can't be taken back from this link. Call the office if work is still needed.";
    net.once(isPatch, () => res(409, { error: refusal, code: 'finish_not_yours' }));
    $('#finishUndo').click();
    await flush();
    expect($('#fmsg').textContent).toBe(refusal);
    expect($('#fmsg').classList.contains('bad')).toBe(true);
    expect($('#finishUndo').disabled).toBe(false);
  });

  test('FIRES: ignore finish.can_undo and Undo is offered to a link that cannot take it back', async () => {
    const broken = mutate(SHARE_SCRIPT, '(d.finish && d.finish.can_undo\n', '(true\n');
    await boot(makeNet(payload({ status: 'work_complete', finish: { can_undo: false } })), broken);
    expect($('#finishUndo')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('links that cannot finish get no card', () => {
  test('draft, approved, closed and cancelled work orders, and a view-only link: no #finishCard', async () => {
    for (const o of [{ status: 'draft' }, { status: 'approved' }, { status: 'closed' }, { status: 'cancelled' }, { scope: 'view' }, { scope: 'view', status: 'work_complete' }]) {
      await boot(makeNet(payload(Object.assign({ tasks: buildings(2, 2) }, o))));
      expect([o, $('#finishCard')]).toEqual([o, null]);
      expect([o, $('#finishUndo')]).toEqual([o, null]);
    }
  });

  test('a propose link on a live work order does get it', async () => {
    await boot(makeNet(payload({ scope: 'propose', tasks: buildings(2, 2) })));
    expect($('#finishBtn')).not.toBeNull();
  });

  test('FIRES: gate the card on the field report\'s rule and a draft work order gets Finish', async () => {
    const broken = mutate(SHARE_SCRIPT,
      '    if (canWork) html += finishCardHTML(d, t, tasks, done);\n',
      '    if (canRespond && live) html += finishCardHTML(d, t, tasks, done);\n');
    await boot(makeNet(payload({ status: 'draft' })), broken);
    expect($('#finishCard')).not.toBeNull();
  });
});
