/**
 * @jest-environment jsdom
 */
// The crew link holds on through bad signal (1.29: A5, A6, A7 on the crew page).
//
// Driven through the REAL inline script of service-ticket-share.html, its real
// body markup, a fake clock and a scripted fetch:
//
//   Loading (A5)
//   - A first load that fails on the signal or the server shows "Couldn't
//     load this work order." with Try again (held back while the server asks
//     to wait); a link that does not work shows the server's own message.
//   - Once the work order is on the page, a failed refresh KEEPS the page and
//     says so in the bar above it ("Saved. Couldn't refresh — tap to retry.");
//     tapping the bar reads again and hides it. A 429 refresh waits as long as
//     the server says and retries by itself. Only 404/410 replace the page,
//     after what the crew typed is written to the phone.
//   - Loading the page makes exactly one request.
//
//   Drafts (A5)
//   - The field report, a building note and a suggested scope survive a
//     redraw and a reload of the page (localStorage under a token PREFIX, two
//     weeks), say "Restored what you typed earlier. It hasn't been sent yet.",
//     open the building they belong to, and are cleared only by a save that
//     worked. A restored scope is compared with the SERVER's scope.
//   - Focus stays in the box being typed in across a redraw.
//
//   Uploads (A6)
//   - A photo that fails on the network shows as a "Retrying" tile and does
//     not hold up the next one; after the last retry the building's status
//     line says what went through, with Retry, which resends under the same
//     upload id. Every photo POST sends kind, name (when typed), upload_id,
//     file, in that order. A 200 that is not the server's answer (a Wi-Fi
//     sign-in page) is not a landed photo: it retries like a lost signal.
//   - A building's Mark complete waits for its photos.
//   - Leaving with photos unsettled asks first; a HEIC the phone cannot open
//     is refused on the phone with the server's sentence.
//
//   Field report and Site photos (A7)
//   - d.site_photos shows as a "Site photos · N" card, for any link.
//   - Save report waits for the report's photos and then sends the note once;
//     an empty note with landed photos says where they went.
//   - Building notes carry a time.
//
// Each guard is also shown to FIRE: the drive runs again on a copy of the
// script with that guard broken (CRLF-normalised anchor, exactly once).
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
// The page's own body markup (the bar and #root), without its script.
const BODY_MARKUP = (() => {
  const open = SHARE_HTML.indexOf('<body>');
  const close = SHARE_HTML.lastIndexOf('<script>');
  return SHARE_HTML.slice(open + '<body>'.length, close);
})();

const TOKEN = 'ef'.repeat(32);
const API = '/api/service-ticket-share/' + TOKEN;
const DRAFT_KEY = 'st-draft:' + TOKEN.slice(0, 16);
const RESTORED = "Restored what you typed earlier. It hasn't been sent yet.";
// The note's idempotency key (1.30): an opaque token, minted per unsent note.
const CLIENT_REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const REF = expect.stringMatching(CLIENT_REF_RE);

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1 || src.indexOf(from, at + from.length) !== -1) throw new Error('anchor not found');
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('anchor not found');
  return out;
}

// ── A scripted server ────────────────────────────────────────────────────
function res(status, body, headers) {
  const r = {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body == null ? '' : JSON.stringify(body)),
  };
  if (headers) r.headers = { get: (k) => (Object.prototype.hasOwnProperty.call(headers, k) ? headers[k] : null) };
  return r;
}
const networkDown = () => Promise.reject(new TypeError('Failed to fetch'));
// A Wi-Fi sign-in page answering 200 in place of the server: nothing stored.
const signInPage = () => ({ ok: true, status: 200, text: () => Promise.resolve('<html>Sign in to Wi-Fi</html>') });

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

const isGet = (c) => c.method === 'GET' && c.url === API;
const isPatch = (c) => c.method === 'PATCH' && c.url === API;
const photoPost = (taskId) => (c) => c.method === 'POST' && c.url === (taskId ? API + '/subtasks/' + taskId + '/photo' : API + '/photo');

function makeNet(data) {
  const net = { calls: [], handlers: [], data };
  // The newest rule wins; a `once` rule is used up by its first match.
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
  net.on(isPatch, () => res(200, { ok: true }));
  return net;
}

const NOTE_AT = () => new Date(new Date().getFullYear(), 2, 4, 14, 32).toISOString();

function tasks() {
  return [
    { id: 'tk_784', title: 'Bldg 784 — Side A: rail post; tread 3', done: false, photos: [], notes: [] },
    {
      id: 'tk_790', title: 'Bldg 790 — Side D: stringer', done: false,
      photos: [{ id: 'ph_1', kind: 'completion', thumb_url: '/t/1.jpg', web_url: '/w/1.jpg' }],
      notes: [{ by: 'Rafael', at: NOTE_AT(), note: 'Stringer shimmed' }],
    },
  ];
}

function payload(o) {
  o = o || {};
  return {
    ticket: {
      id: 'st_1', title: 'Replace rotted stair treads', ticket_number: 'WO-0007',
      status: o.status || 'in_progress', materials: [], scope_proposed: 'Replace the rotted treads.',
    },
    share: { scope: o.scope || 'respond', hide_financials: true, recipient_name: o.anon ? null : 'Rafael' },
    tasks: o.tasks || tasks(),
    site_photos: o.site_photos || [],
  };
}

// ── Driving the page ─────────────────────────────────────────────────────
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
const card = (id) => $$('.bld').find((c) => c.getAttribute('data-task') === id) || null;
const netbar = () => document.getElementById('netbar');
const netbarText = () => (netbar() && !netbar().hidden ? netbar().querySelector('span').textContent : null);

function type(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function pick(inp, files) {
  Object.defineProperty(inp, 'files', { value: files, configurable: true });
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}

let fileStamp = 1;
function jpeg(name) {
  return new File(['jpeg-bytes-' + name], name, { type: 'image/jpeg', lastModified: fileStamp++ });
}

function formFields(call) {
  const fd = call.init.body;
  return Array.from(fd.keys());
}

async function addBuildingNote(id, text) {
  const c = card(id);
  type(c.querySelector('.bnote-in'), text);
  c.querySelector('.bnote-go').click();
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  try { window.localStorage.clear(); } catch (e) { /* nothing */ }
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════
describe('first load', () => {
  test('loading the page makes exactly one request, and the bar sits before #root, hidden', async () => {
    const net = await boot(makeNet(payload()));
    expect(net.calls.map((c) => [c.method, c.url])).toEqual([['GET', API]]);
    expect($$('.bld').length).toBe(2);
    expect(netbar().nextElementSibling.id).toBe('root');
    expect(netbar().hidden).toBe(true);
    expect(netbar().getAttribute('role')).toBe('status');
  });

  test('a 500 shows "Couldn\'t load this work order." with Try again, which loads the page', async () => {
    const net = makeNet(payload());
    net.once(isGet, () => res(500, { error: 'Something went wrong opening this link.' }));
    await boot(net);
    expect($('#root .fatal strong').textContent).toBe("Couldn't load this work order.");
    expect($('#root .fatal').textContent).toContain('Check your signal and try again.');
    const again = document.getElementById('fatalRetry');
    expect(again.textContent).toBe('Try again');
    expect(again.disabled).toBe(false);
    again.click();
    await flush();
    expect(net.of(isGet).length).toBe(2);
    expect($$('.bld').length).toBe(2);
  });

  test('no signal at all gets the same card', async () => {
    const net = makeNet(payload());
    net.once(isGet, networkDown);
    await boot(net);
    expect($('#root .fatal strong').textContent).toBe("Couldn't load this work order.");
    expect(document.getElementById('fatalRetry')).not.toBeNull();
  });

  test('a 429 holds Try again back for as long as the server asks', async () => {
    const net = makeNet(payload());
    net.once(isGet, () => res(429, { error: 'Too many requests', retryAfter: 20 }));
    await boot(net);
    const again = document.getElementById('fatalRetry');
    expect(again.disabled).toBe(true);
    await flush(19000);
    expect(again.disabled).toBe(true);
    await flush(1000);
    expect(again.disabled).toBe(false);
  });

  test('a link that does not work shows the server\'s message, with no Try again', async () => {
    const net = makeNet(payload());
    net.once(isGet, () => res(404, { error: 'This link is not valid.' }));
    await boot(net);
    expect($('#root .fatal strong').textContent).toBe('This link is not valid.');
    expect(document.getElementById('fatalRetry')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('a refresh that fails keeps the page', () => {
  async function noteThenRefreshFails(script) {
    const net = await boot(makeNet(payload()), script);
    net.once(isGet, networkDown);
    await addBuildingNote('tk_784', 'Post reset');
    return net;
  }

  test('after a building note: the cards stay and the bar says "Saved. Couldn\'t refresh — tap to retry."; tapping it reads again and hides it', async () => {
    const net = await noteThenRefreshFails();
    expect(net.of((c) => c.method === 'POST' && c.url.endsWith('/subtasks/tk_784/note')).length).toBe(1);
    expect($$('.bld').length).toBe(2);
    expect($('#root .fatal')).toBeNull();
    expect(netbarText()).toBe("Saved. Couldn't refresh — tap to retry.");
    // The saved note is out of the box, so it is not sent twice.
    expect(card('tk_784').querySelector('.bnote-in').value).toBe('');
    const gets = net.of(isGet).length;
    netbar().click();
    await flush();
    expect(net.of(isGet).length).toBe(gets + 1);
    expect(netbar().hidden).toBe(true);
    expect($$('.bld').length).toBe(2);
  });

  test('FIRES: send every load failure to the full-page message and the page is lost', async () => {
    const broken = mutate(SHARE_SCRIPT, '    if (!rendered) {\n', '    if (true) {\n');
    await noteThenRefreshFails(broken);
    expect($$('.bld').length).toBe(0);
    expect($('#root .fatal strong').textContent).toBe("Couldn't load this work order.");
  });

  test('coming back online retries the bar by itself', async () => {
    const net = await noteThenRefreshFails();
    const gets = net.of(isGet).length;
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(net.of(isGet).length).toBe(gets + 1);
    expect(netbar().hidden).toBe(true);
  });

  test('a 429 refresh says the server is busy and refreshes by itself after Retry-After', async () => {
    const net = await boot(makeNet(payload()));
    net.once(isGet, () => res(429, { error: 'Too many requests' }, { 'Retry-After': '30' }));
    await addBuildingNote('tk_784', 'Post reset');
    expect(netbarText()).toBe('Saved. The server is busy — refreshing in 30 s.');
    const gets = net.of(isGet).length;
    await flush(29000);
    expect(net.of(isGet).length).toBe(gets);
    await flush(1000);
    expect(net.of(isGet).length).toBe(gets + 1);
    expect(netbar().hidden).toBe(true);
  });

  test('a 410 on a refresh replaces the page with the server\'s message, after writing what was typed to the phone', async () => {
    const net = await boot(makeNet(payload()));
    type(card('tk_790').querySelector('.bnote-in'), 'Half done, back tomorrow');
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull(); // still inside the typing pause
    net.once(isGet, () => res(410, { error: 'This link has been turned off.' }));
    card('tk_790').querySelector('.bdone').click();
    await flush();
    expect($$('.bld').length).toBe(0);
    expect($('#root .fatal strong').textContent).toBe('This link has been turned off.');
    expect(netbar().hidden).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY)).bnotes).toEqual({ tk_790: 'Half done, back tomorrow' });
  });

  test('two saves while a read is out make one more read after it, not two', async () => {
    const net = await boot(makeNet(payload()));
    const slow = deferred();
    net.once(isGet, () => slow.promise);
    await addBuildingNote('tk_784', 'First');
    await addBuildingNote('tk_790', 'Second');
    card('tk_790').querySelector('.bdone').click();
    await flush();
    const before = net.of(isGet).length;
    slow.resolve(res(200, payload()));
    await flush();
    expect(net.of(isGet).length).toBe(before + 1);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('drafts', () => {
  test('the field report survives a redraw, comes back after a reload with the hint, and a save clears it', async () => {
    const net = await boot(makeNet(payload()));
    type($('#note'), 'Rail post reset on side A');
    await addBuildingNote('tk_784', 'Post reset'); // a save, so a redraw
    expect(net.of(isGet).length).toBe(2);
    expect($('#note').value).toBe('Rail post reset on side A');

    await flush(400);
    const stored = window.localStorage.getItem(DRAFT_KEY);
    expect(JSON.parse(stored)).toMatchObject({ v: 1, note: 'Rail post reset on side A' });
    expect(DRAFT_KEY).toBe('st-draft:efefefefefefefef');
    expect(Object.keys(window.localStorage).some((k) => k.indexOf(TOKEN) !== -1)).toBe(false);

    await boot(makeNet(payload()));
    expect($('#note').value).toBe('Rail post reset on side A');
    expect($('#report .restored').textContent).toBe(RESTORED);

    $('#save').click();
    await flush();
    const patches = window.fetch.mock.calls.filter((c) => (c[1] || {}).method === 'PATCH');
    expect(patches.map((c) => JSON.parse(c[1].body))).toEqual([{ note: 'Rail post reset on side A', client_ref: REF }]);
    expect($('#note').value).toBe('');
    expect($('#report .restored')).toBeNull();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect($('#msg').textContent).toBe('Report saved.');
  });

  test('FIRES: without the draft in the report box, a reload shows an empty box', async () => {
    await boot(makeNet(payload()));
    type($('#note'), 'Rail post reset on side A');
    await flush(400);
    const broken = mutate(SHARE_SCRIPT,
      '\'<textarea id="note" rows="3" placeholder="What did you find? What did you do?">\' + esc(drafts.note) + \'</textarea>\'',
      '\'<textarea id="note" rows="3" placeholder="What did you find? What did you do?"></textarea>\'');
    await boot(makeNet(payload()), broken);
    expect($('#note').value).toBe('');
  });

  test('a failed save keeps the draft', async () => {
    const net = await boot(makeNet(payload()));
    type($('#note'), 'Gate was locked');
    net.once(isPatch, () => res(403, { error: 'This link is view-only.' }));
    $('#save').click();
    await flush(400);
    expect($('#msg').textContent).toBe('This link is view-only.');
    expect($('#msg').classList.contains('bad')).toBe(true);
    expect($('#note').value).toBe('Gate was locked');
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY)).note).toBe('Gate was locked');
  });

  test('a building note survives a redraw and, after a reload, opens its building with the hint', async () => {
    await boot(makeNet(payload()));
    type(card('tk_784').querySelector('.bnote-in'), 'Tread 3 needs a shim');
    await addBuildingNote('tk_790', 'Stringer done'); // a save elsewhere, so a redraw
    expect(card('tk_784').querySelector('.bnote-in').value).toBe('Tread 3 needs a shim');
    await flush(400);

    await boot(makeNet(payload()));
    const c = card('tk_784');
    expect(c.classList.contains('open')).toBe(true);
    expect(c.querySelector('.bld-body').hidden).toBe(false);
    expect(c.querySelector('.bnote-in').value).toBe('Tread 3 needs a shim');
    expect(c.querySelector('.restored').textContent).toBe(RESTORED);
    expect(card('tk_790').classList.contains('open')).toBe(false);
  });

  test('a draft older than two weeks is dropped when the page opens', async () => {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
      v: 1, at: Date.now() - 15 * 24 * 60 * 60 * 1000, note: 'Old note', scope: '', bnotes: {},
    }));
    await boot(makeNet(payload()));
    expect($('#note').value).toBe('');
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('a draft from 13 days ago is still there', async () => {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
      v: 1, at: Date.now() - 13 * 24 * 60 * 60 * 1000, note: 'Recent note', scope: '', bnotes: {},
    }));
    await boot(makeNet(payload()));
    expect($('#note').value).toBe('Recent note');
  });

  test('a restored scope is compared with the server\'s scope: Send revision with the restored text still sends it', async () => {
    const net = makeNet(payload({ scope: 'propose' }));
    net.on((c) => c.method === 'POST' && c.url === API + '/revision', () => res(200, { ok: true }));
    await boot(net);
    expect($('#scope').value).toBe('Replace the rotted treads.');
    type($('#scope'), 'Replace the rotted treads and the side D stringer.');
    await flush(400);

    await boot(net);
    expect($('#scope').value).toBe('Replace the rotted treads and the side D stringer.');
    expect($('.restored[data-for="scope"]').textContent).toBe(RESTORED);
    $('#propose').click();
    await flush();
    const sent = net.of((c) => c.url === API + '/revision');
    expect(sent.map((c) => JSON.parse(c.init.body).fields)).toEqual([{ scope_proposed: 'Replace the rotted treads and the side D stringer.' }]);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect($('#pmsg').textContent).toMatch(/^Sent to the office\./);
  });

  test('FIRES: compare with the box as drawn and the restored scope reads as unchanged', async () => {
    const broken = mutate(SHARE_SCRIPT, "    var original = t.scope_proposed || '';\n", '    var original = box.value;\n');
    const net = makeNet(payload({ scope: 'propose' }));
    net.on((c) => c.method === 'POST' && c.url === API + '/revision', () => res(200, { ok: true }));
    await boot(net, broken);
    type($('#scope'), 'Replace the rotted treads and the side D stringer.');
    await flush(400);
    await boot(net, broken);
    $('#propose').click();
    await flush();
    expect(net.of((c) => c.url === API + '/revision')).toEqual([]);
    expect($('#pmsg').textContent).toBe('Change the scope first.');
  });

  test('a scope draft that reads the same as the server is no draft', async () => {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
      v: 1, at: Date.now(), note: '', scope: 'Replace the rotted treads.', bnotes: {},
    }));
    await boot(makeNet(payload({ scope: 'propose' })));
    expect($('.restored')).toBeNull();
    await flush(400);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('focus and the caret stay in the box being typed in across a redraw', async () => {
    await boot(makeNet(payload()));
    const box = card('tk_784').querySelector('.bnote-in');
    card('tk_784').querySelector('.bld-head').click();
    type(box, 'Tread 3');
    box.focus();
    box.setSelectionRange(2, 4);
    card('tk_790').querySelector('.bdone').click(); // a save, so a redraw
    await flush();
    const now = card('tk_784').querySelector('.bnote-in');
    expect(now).not.toBe(box);
    expect(document.activeElement).toBe(now);
    expect([now.selectionStart, now.selectionEnd]).toEqual([2, 4]);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('building photo uploads', () => {
  test('a network failure shows "Retrying" and does not hold up the next photo; after the last retry Retry resends under the same upload id', async () => {
    const net = await boot(makeNet(payload()));
    const ids = [];
    let failFirst = true;
    net.on(photoPost('tk_784'), (c) => {
      const fd = c.init.body;
      ids.push([fd.get('file').name, fd.get('upload_id')]);
      if (fd.get('file').name === 'IMG_1.jpg' && failFirst) return networkDown();
      return res(200, { ok: true, photo: { id: 'ph_' + fd.get('file').name, kind: 'completion', thumb_url: '/t/' + fd.get('file').name, web_url: '/w/' + fd.get('file').name } });
    });
    const c = card('tk_784');
    pick(c.querySelector('input[type=file][multiple][data-kind="completion"]'), [jpeg('IMG_1.jpg'), jpeg('IMG_2.jpg')]);
    await flush();

    expect(ids.map((x) => x[0])).toEqual(['IMG_1.jpg', 'IMG_2.jpg']);
    const tiles = () => Array.from(card('tk_784').querySelectorAll('.shot.pending .st')).map((s) => s.textContent);
    expect(tiles()).toEqual(['Retrying']);
    expect(card('tk_784').querySelector('.photos[data-sec="completion"] .lbl').textContent).toBe('Completion photos · 1');
    expect(card('tk_784').querySelector('.upq .upq-t').textContent).toBe('Uploading 1 of 2… 1 will retry');

    await flush(3000);
    await flush(15000);
    expect(ids.map((x) => x[0])).toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_1.jpg', 'IMG_1.jpg']);
    expect(tiles()).toEqual(['Not sent']);
    const upq = card('tk_784').querySelector('.upq');
    expect(upq.querySelector('.upq-t').textContent).toBe("1 of 2 added. 1 didn't go through.");
    expect(upq.classList.contains('bad')).toBe(true);
    expect(Array.from(upq.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Retry', 'Clear']);

    failFirst = false;
    upq.querySelector('.upq-retry').click();
    await flush();
    const first = ids.filter((x) => x[0] === 'IMG_1.jpg').map((x) => x[1]);
    expect(first.length).toBe(4);
    expect(new Set(first).size).toBe(1);
    expect(first[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(ids.find((x) => x[0] === 'IMG_2.jpg')[1]).not.toBe(first[0]);
    expect(tiles()).toEqual([]);
    expect(card('tk_784').querySelector('.upq .upq-t').textContent).toBe('2 photos added.');
    expect(card('tk_784').querySelector('.photos[data-sec="completion"] .lbl').textContent).toBe('Completion photos · 2');
  });

  test('FIRES: without the Retry button the crew cannot resend a failed photo', async () => {
    const broken = mutate(SHARE_SCRIPT, "(s.failed ? '<button type=\"button\" class=\"btn small upq-retry\"", "(false ? '<button type=\"button\" class=\"btn small upq-retry\"");
    const net = await boot(makeNet(payload()), broken);
    net.on(photoPost('tk_784'), networkDown);
    pick(card('tk_784').querySelector('input[type=file][multiple][data-kind="completion"]'), [jpeg('IMG_9.jpg')]);
    await flush();
    await flush(3000);
    await flush(15000);
    expect(card('tk_784').querySelector('.upq-retry')).toBeNull();
  });

  async function signInPageAnswers(script) {
    const net = await boot(makeNet(payload()), script);
    net.on(photoPost('tk_784'), signInPage);
    pick(card('tk_784').querySelector('input[type=file][multiple][data-kind="completion"]'), [jpeg('IMG_W.jpg')]);
    await flush();
    return net;
  }

  test('a 200 that is not the server\'s answer is not counted as landed: it retries, ends "Not sent" with Retry, and Retry sends it under the same upload id', async () => {
    const net = await signInPageAnswers();
    const tiles = () => Array.from(card('tk_784').querySelectorAll('.shot.pending .st')).map((s) => s.textContent);
    expect(tiles()).toEqual(['Retrying']);
    expect(card('tk_784').querySelector('.upq .upq-t').textContent).not.toBe('Photo added.');
    expect(card('tk_784').querySelector('.bld-head .chip').textContent).toBe('Needs photo');
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);

    await flush(3000);
    await flush(15000);
    const posts = net.of(photoPost('tk_784'));
    expect(posts.length).toBe(3);
    expect(tiles()).toEqual(['Not sent']);
    expect(card('tk_784').querySelector('.bld-head .chip').textContent).toBe('Needs photo');
    expect(card('tk_784').querySelector('.upq-retry')).not.toBeNull();

    net.on(photoPost('tk_784'), () => res(200, { ok: true, photo: { id: 'ph_w', kind: 'completion', thumb_url: '/t/w', web_url: '/w/w' } }));
    card('tk_784').querySelector('.upq-retry').click();
    await flush();
    const all = net.of(photoPost('tk_784'));
    expect(all.length).toBe(4);
    expect(new Set(all.map((c) => c.init.body.get('upload_id'))).size).toBe(1);
    expect(tiles()).toEqual([]);
    expect(card('tk_784').querySelector('.upq .upq-t').textContent).toBe('Photo added.');
    expect(card('tk_784').querySelector('.bld-head .chip').textContent).toBe('1 photo');
  });

  test('FIRES: without the answer check the sign-in page counts as landed and the photo vanishes with no Retry', async () => {
    const broken = mutate(SHARE_SCRIPT, '      if (!data || data.ok !== true) {\n', '      if (false) {\n');
    await signInPageAnswers(broken);
    expect(card('tk_784').querySelector('.upq .upq-t').textContent).toBe('Photo added.');
    await flush(3000);
    await flush(15000);
    expect(card('tk_784').querySelectorAll('.shot.pending').length).toBe(0);
    expect(card('tk_784').querySelector('.upq-retry')).toBeNull();
  });

  test('the photo POST sends kind, name (when typed), upload_id and file, in that order', async () => {
    const net = await boot(makeNet(payload({ anon: true })));
    net.on(photoPost('tk_784'), () => res(200, { ok: true, photo: { id: 'ph_b', kind: 'before', thumb_url: '/t/b', web_url: '/w/b' } }));
    pick(card('tk_784').querySelector('input[type=file][multiple][data-kind="before"]'), [jpeg('IMG_B1.jpg')]);
    await flush();
    type($('#crewname'), 'Jose');
    pick(card('tk_784').querySelector('input[type=file][multiple][data-kind="before"]'), [jpeg('IMG_B2.jpg')]);
    await flush();
    const posts = net.of(photoPost('tk_784'));
    expect(posts.map(formFields)).toEqual([['kind', 'upload_id', 'file'], ['kind', 'name', 'upload_id', 'file']]);
    expect(posts.map((c) => c.init.body.get('kind'))).toEqual(['before', 'before']);
    expect(posts[1].init.body.get('name')).toBe('Jose');
    expect(posts.every((c) => c.init.cache === 'no-store' && c.init.signal && typeof c.init.signal.aborted === 'boolean')).toBe(true);
    // A before photo shows its grid, which a building with none keeps hidden.
    expect(card('tk_784').querySelector('.photos[data-sec="before"]').hidden).toBe(false);
    expect(card('tk_790').querySelector('.photos[data-sec="before"]').hidden).toBe(true);
    expect(card('tk_784').querySelector('.photos[data-sec="before"] .lbl').textContent).toMatch(/^Before photos · [12]$/);
  });

  test('the same photo picked twice for one building is sent once', async () => {
    const net = await boot(makeNet(payload()));
    const hold = deferred();
    net.on(photoPost('tk_784'), () => hold.promise);
    const f = jpeg('IMG_SAME.jpg');
    const inp = card('tk_784').querySelector('input[type=file][multiple][data-kind="completion"]');
    pick(inp, [f]);
    await flush();
    pick(inp, [f]);
    await flush();
    expect(net.of(photoPost('tk_784')).length).toBe(1);
    expect(card('tk_784').querySelector('.upq .upq-t').textContent).toContain('Skipped 1 photo already added.');
  });

  test('Mark complete waits for the building\'s photos, then counts the one that landed', async () => {
    const net = await boot(makeNet(payload()));
    const hold = deferred();
    net.on(photoPost('tk_784'), () => hold.promise);
    card('tk_784').querySelector('.bld-head').click();
    pick(card('tk_784').querySelector('input[type=file][capture][data-kind="completion"]'), [jpeg('IMG_C.jpg')]);
    await flush();
    const btn = () => card('tk_784').querySelector('.bdone');
    expect(btn().disabled).toBe(true);
    expect(card('tk_784').querySelector('.bdone-wrap .need-hint').textContent).toBe('Wait for the photos to finish uploading.');
    expect(card('tk_784').querySelector('.shot.pending .st').textContent).toBe('Sending…');

    hold.resolve(res(200, { ok: true, photo: { id: 'ph_c', kind: 'completion', thumb_url: '/t/c.jpg', web_url: '/w/c.jpg' } }));
    await flush();
    expect(btn().disabled).toBe(false);
    expect(card('tk_784').querySelector('.bdone-wrap .need-hint')).toBeNull();
    expect(card('tk_784').querySelector('.bld-head .chip').textContent).toBe('1 photo');
    expect(card('tk_784').querySelector('.shots a.shot img').getAttribute('src')).toBe('/t/c.jpg');
    // The card stayed open and was not redrawn wholesale.
    expect(card('tk_784').classList.contains('open')).toBe(true);
  });

  test('FIRES: without the wait branch the button says to add a photo while one is uploading', async () => {
    const broken = mutate(SHARE_SCRIPT, '    if (s.busy) {\n', '    if (false) {\n');
    const net = await boot(makeNet(payload()), broken);
    net.on(photoPost('tk_784'), () => deferred().promise);
    pick(card('tk_784').querySelector('input[type=file][capture][data-kind="completion"]'), [jpeg('IMG_C.jpg')]);
    await flush();
    expect(card('tk_784').querySelector('.bdone-wrap .need-hint').textContent).not.toBe('Wait for the photos to finish uploading.');
  });

  test('once everything settles the page reads again quietly, 600 ms later', async () => {
    const net = await boot(makeNet(payload()));
    net.on(photoPost('tk_784'), () => res(200, { ok: true, photo: { id: 'ph_q', kind: 'completion', thumb_url: '/t/q', web_url: '/w/q' } }));
    pick(card('tk_784').querySelector('input[type=file][multiple][data-kind="completion"]'), [jpeg('IMG_Q.jpg')]);
    await flush();
    expect(net.of(isGet).length).toBe(1);
    await flush(599);
    expect(net.of(isGet).length).toBe(1);
    await flush(1);
    expect(net.of(isGet).length).toBe(2);
  });

  test('leaving while a photo is still going asks first; once it lands it does not', async () => {
    const net = await boot(makeNet(payload()));
    const hold = deferred();
    net.on(photoPost('tk_784'), () => hold.promise);
    pick(card('tk_784').querySelector('input[type=file][multiple][data-kind="completion"]'), [jpeg('IMG_L.jpg')]);
    await flush();
    const leave = () => {
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(leave()).toBe(true);
    hold.resolve(res(200, { ok: true, photo: { id: 'ph_l', kind: 'completion', thumb_url: '/t/l', web_url: '/w/l' } }));
    await flush();
    expect(leave()).toBe(false);
  });

  test('a HEIC this phone cannot open is refused on the phone with the server\'s sentence, and never sent', async () => {
    const { HEIC_REFUSAL } = require('../server/util/attachment-mime');
    const net = await boot(makeNet(payload()));
    const heic = new File(['heic'], 'IMG_2231.heic', { type: 'image/heic', lastModified: 5 });
    pick(card('tk_784').querySelector('input[type=file][multiple][data-kind="completion"]'), [heic]);
    await flush();
    expect(net.of(photoPost('tk_784'))).toEqual([]);
    expect(card('tk_784').querySelector('.upq .upq-t').textContent)
      .toBe("0 of 1 added. 1 didn't go through.\nIMG_2231.heic wasn't sent: " + HEIC_REFUSAL);
    expect(card('tk_784').querySelector('.upq-retry')).toBeNull();
    card('tk_784').querySelector('.upq-clear').click();
    await flush();
    expect(card('tk_784').querySelector('.upq').hidden).toBe(true);
    expect(card('tk_784').querySelectorAll('.shot.pending').length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('field report and site photos', () => {
  const SITE = () => [
    { id: 'a_2', thumb_url: '/t/s2.jpg', web_url: '/w/s2.jpg', uploaded_at: NOTE_AT(), by: 'Jose' },
    { id: 'a_1', thumb_url: '/t/s1.jpg', web_url: '/w/s1.jpg', uploaded_at: NOTE_AT(), by: 'Crew link' },
  ];

  test('d.site_photos shows as "Site photos · N" after the field log, on a view-only link too', async () => {
    for (const scope of ['respond', 'view']) {
      await boot(makeNet(payload({ scope, site_photos: SITE() })));
      const box = document.getElementById('siteShots');
      expect(box.querySelector('.lbl').textContent).toBe('Site photos · 2');
      const shots = Array.from(box.querySelectorAll('a.shot'));
      expect(shots.map((a) => a.getAttribute('href'))).toEqual(['/w/s2.jpg', '/w/s1.jpg']);
      expect(shots.map((a) => a.querySelector('img').getAttribute('src'))).toEqual(['/t/s2.jpg', '/t/s1.jpg']);
      const when = new Date(NOTE_AT()).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      expect(shots[0].querySelector('img').getAttribute('alt')).toBe('Photo by Jose, ' + when);
    }
  });

  test('no site photos, no card', async () => {
    await boot(makeNet(payload()));
    expect(document.getElementById('siteShots')).toBeNull();
  });

  test('building notes carry the time they were written', async () => {
    await boot(makeNet(payload()));
    const when = new Date(NOTE_AT()).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(card('tk_790').querySelector('.bnote small').textContent).toBe('Rafael · ' + when);
    expect(when).toMatch(/\d:\d\d/);
  });

  async function saveWhilePhotoPending(script) {
    const net = await boot(makeNet(payload()), script);
    const hold = deferred();
    net.on(photoPost(null), () => hold.promise);
    pick(document.getElementById('photo'), [jpeg('SITE_1.jpg')]);
    await flush();
    type($('#note'), 'Resident refused access to side D');
    $('#save').click();
    await flush();
    return { net, hold };
  }

  test('Save report while a report photo is still going waits, then sends the note once', async () => {
    const { net, hold } = await saveWhilePhotoPending();
    expect($('#rshots').hidden).toBe(false);
    expect($('#rshots .shot.pending .st').textContent).toBe('Sending…');
    expect($('#msg').textContent).toBe('Waiting for 1 photo to finish, then your note will be saved.');
    expect($('#save').disabled).toBe(true);
    expect(net.of(isPatch)).toEqual([]);

    hold.resolve(res(200, { ok: true, photo: { id: 'a_9', kind: 'site', thumb_url: '/t/s9.jpg', web_url: '/w/s9.jpg' } }));
    await flush();
    await flush(1000);
    expect(net.of(isPatch).map((c) => JSON.parse(c.init.body))).toEqual([{ note: 'Resident refused access to side D', client_ref: REF }]);
    expect($('#msg').textContent).toBe('Report saved.');
    expect($('#note').value).toBe('');
    expect($('#rshots').hidden).toBe(true);
    expect($('#save').disabled).toBe(false);
  });

  test('FIRES: without the wait, the note goes before its photo has landed', async () => {
    const broken = mutate(SHARE_SCRIPT, "    if (busyCount('site')) {\n      reportWait", "    if (false) {\n      reportWait");
    const { net } = await saveWhilePhotoPending(broken);
    expect(net.of(isPatch).length).toBe(1);
  });

  test('a report photo that did not go through: the note is still saved, and says so', async () => {
    const net = await boot(makeNet(payload()));
    net.on(photoPost(null), networkDown);
    pick(document.getElementById('photoCam'), [jpeg('SITE_2.jpg')]);
    await flush();
    type($('#note'), 'Side D rail replaced');
    $('#save').click();
    await flush();
    expect(net.of(isPatch)).toEqual([]);
    await flush(3000);
    await flush(15000);
    expect(net.of(isPatch).length).toBe(1);
    expect($('#msg').textContent).toBe("Report saved. 1 photo didn't go through — tap Retry above.");
    expect($('#rupq .upq-retry')).not.toBeNull();
  });

  test('an empty note with a landed report photo says where the photo went, and sends nothing', async () => {
    const net = await boot(makeNet(payload()));
    net.on(photoPost(null), () => res(200, { ok: true, photo: { id: 'a_7', kind: 'site', thumb_url: '/t/s7.jpg', web_url: '/w/s7.jpg' } }));
    pick(document.getElementById('photo'), [jpeg('SITE_3.jpg')]);
    await flush();
    expect($('#rupq .upq-t').textContent).toBe('Photo added.');
    $('#save').click();
    await flush();
    expect(net.of(isPatch)).toEqual([]);
    expect($('#msg').textContent).toBe('Your photos are saved under Site photos. Write a note if you want to add one.');
    // Said once: a second empty Save with no new photos asks for a note.
    $('#save').click();
    await flush();
    expect(net.of(isPatch)).toEqual([]);
    expect($('#msg').textContent).toBe('Write something first.');
  });

  async function anonEmptySaveWithPhoto(script) {
    window.localStorage.setItem('st-crew-name', 'Jose');
    const net = await boot(makeNet(payload({ anon: true })), script);
    expect($('#crewname').value).toBe('Jose');
    net.on(photoPost(null), () => res(200, { ok: true, photo: { id: 'a_8', kind: 'site', thumb_url: '/t/s8.jpg', web_url: '/w/s8.jpg' } }));
    pick(document.getElementById('photo'), [jpeg('SITE_8.jpg')]);
    await flush();
    $('#save').click();
    await flush();
    return net;
  }

  test('on a link where the crew typed their name, an empty note with a landed photo still says where it went and sends nothing', async () => {
    const net = await anonEmptySaveWithPhoto();
    expect(net.of(isPatch)).toEqual([]);
    expect($('#msg').textContent).toBe('Your photos are saved under Site photos. Write a note if you want to add one.');
  });

  test('FIRES: decide the empty note on note or name and the name alone goes out as "Report saved."', async () => {
    const broken = mutate(SHARE_SCRIPT, '    if (!complete && !body.note) {\n', '    if (!complete && !body.note && !body.name) {\n');
    const net = await anonEmptySaveWithPhoto(broken);
    expect(net.of(isPatch).map((c) => JSON.parse(c.init.body))).toEqual([{ name: 'Jose' }]);
  });

  test('a report photo whose answer was a sign-in page is not reported as saved', async () => {
    const net = await boot(makeNet(payload()));
    net.on(photoPost(null), signInPage);
    pick(document.getElementById('photo'), [jpeg('SITE_W.jpg')]);
    await flush();
    expect($('#rupq .upq-t').textContent).not.toBe('Photo added.');
    expect($('#rshots .shot.pending .st').textContent).toBe('Retrying');
    await flush(3000);
    await flush(15000);
    expect($('#rshots .shot.pending .st').textContent).toBe('Not sent');
    expect($('#rupq .upq-retry')).not.toBeNull();
    $('#save').click();
    await flush();
    expect(net.of(isPatch)).toEqual([]);
    expect($('#msg').textContent).toBe('Write something first.');
  });

  // Finish whole work order moved to its own card under the punch list
  // (1.29, test/crew-finish-work-order.test.js); the bad-signal rule holds.
  const allDone = () => tasks().map((x) => Object.assign(x, { done: true }));

  async function finishThenRefreshFails(script) {
    const net = await boot(makeNet(payload({ tasks: allDone() })), script);
    type($('#note'), 'All buildings done');
    net.once(isGet, networkDown);
    $('#finishBtn').click();
    $('#finishYes').click();
    await flush();
    return net;
  }

  test('Finish whole work order that saved but could not refresh: says Saved. and keeps Yes off', async () => {
    const net = await finishThenRefreshFails();
    expect(net.of(isPatch).map((c) => JSON.parse(c.init.body))).toEqual([{ status: 'work_complete', note: 'All buildings done', client_ref: REF }]);
    expect(netbarText()).toBe("Saved. Couldn't refresh — tap to retry.");
    expect($('#fmsg').textContent).toBe('Saved.');
    expect($('#finishYes').disabled).toBe(true);
    expect($('#save').disabled).toBe(false);
  });

  test('FIRES: without keeping it off, Yes, finish it is offered again after a failed refresh', async () => {
    const broken = mutate(SHARE_SCRIPT, '        finishButtons(true);\n', '');
    await finishThenRefreshFails(broken);
    expect($('#finishYes').disabled).toBe(false);
  });

  test('Upload photo takes several at once and sends them one after another to the photo door', async () => {
    const net = await boot(makeNet(payload()));
    let n = 0;
    net.on(photoPost(null), () => res(200, { ok: true, photo: { id: 'a_m' + (++n), kind: 'site', thumb_url: '/t/m', web_url: '/w/m' } }));
    expect(document.getElementById('photo').hasAttribute('multiple')).toBe(true);
    pick(document.getElementById('photo'), [jpeg('M1.jpg'), jpeg('M2.jpg'), jpeg('M3.jpg')]);
    await flush();
    const posts = net.of(photoPost(null));
    expect(posts.map((c) => c.init.body.get('file').name)).toEqual(['M1.jpg', 'M2.jpg', 'M3.jpg']);
    expect(posts.map(formFields)).toEqual([['upload_id', 'file'], ['upload_id', 'file'], ['upload_id', 'file']]);
    expect($('#rupq .upq-t').textContent).toBe('3 photos added.');
  });
});

// ════════════════════════════════════════════════════════════════════════
// A save that gets NO ANSWER says what to do (1.30)
//
// readJSON only stamps err.status when a response exists, so a fetch that
// rejects reaches every catch with no status and the browser's own string:
// "Failed to fetch" on Android Chrome, "Load failed" on iOS Safari. Neither
// says whether the work was saved, on a page whose whole premise is surviving
// bad signal. Every crew save now routes its message through saveError(), so a
// refusal is still the server's own words and no answer at all is one sentence
// the crew can act on — the sentence the problem form already used.
describe('a save with no answer from the server', () => {
  const NO_ANSWER = "Couldn't send that. Check your signal and try again.";
  const doneDoor = (taskId) => (c) => c.method === 'POST' && c.url === API + '/subtasks/' + taskId + '/done';
  const noteDoor = (taskId) => (c) => c.method === 'POST' && c.url === API + '/subtasks/' + taskId + '/note';
  const isRevision = (c) => c.method === 'POST' && c.url === API + '/revision';
  const bmsg = (id) => card(id).querySelector('.msg');
  const withUndo = (o) => Object.assign(payload(o), { finish: { can_undo: true } });

  test('Mark complete on a building: the sentence, styled bad — not "Failed to fetch"', async () => {
    const net = await boot(makeNet(payload()));
    net.on(doneDoor('tk_790'), networkDown);
    card('tk_790').querySelector('.bdone').click();
    await flush();
    expect(bmsg('tk_790').textContent).toBe(NO_ANSWER);
    expect(bmsg('tk_790').classList.contains('bad')).toBe(true);
    expect(net.of(doneDoor('tk_790')).length).toBe(1);
  });

  test('a building note', async () => {
    const net = await boot(makeNet(payload()));
    net.on(noteDoor('tk_784'), networkDown);
    await addBuildingNote('tk_784', 'Post reset');
    expect(bmsg('tk_784').textContent).toBe(NO_ANSWER);
    // The note is still in the box and the button is back, so it can be retried.
    expect(card('tk_784').querySelector('.bnote-in').value).toBe('Post reset');
    expect(card('tk_784').querySelector('.bnote-go').disabled).toBe(false);
  });

  test('Save report', async () => {
    const net = await boot(makeNet(payload()));
    net.on(isPatch, networkDown);
    type($('#note'), 'Resident refused access to side D');
    $('#save').click();
    await flush();
    expect($('#msg').textContent).toBe(NO_ANSWER);
    expect($('#msg').classList.contains('bad')).toBe(true);
    expect($('#note').value).toBe('Resident refused access to side D');
    expect($('#save').disabled).toBe(false);
  });

  test('Finish whole work order answers in the finish card', async () => {
    const net = await boot(makeNet(payload({ tasks: tasks().map((x) => Object.assign(x, { done: true })) })));
    net.on(isPatch, networkDown);
    $('#finishBtn').click();
    $('#finishYes').click();
    await flush();
    expect($('#fmsg').textContent).toBe(NO_ANSWER);
    expect($('#finishYes').disabled).toBe(false);
  });

  test('Undo — not finished yet', async () => {
    const net = await boot(makeNet(withUndo({ status: 'work_complete' })));
    net.on(isPatch, networkDown);
    $('#finishUndo').click();
    await flush();
    expect($('#fmsg').textContent).toBe(NO_ANSWER);
    expect($('#finishUndo').disabled).toBe(false);
  });

  test('Send revision, on a propose link', async () => {
    const net = await boot(makeNet(payload({ scope: 'propose' })));
    net.on(isRevision, networkDown);
    type($('#scope'), 'Replace the rotted treads and the side D stringer.');
    $('#propose').click();
    await flush();
    expect($('#pmsg').textContent).toBe(NO_ANSWER);
    expect($('#propose').disabled).toBe(false);
  });

  test('a REFUSAL is still the server\'s own words, verbatim, on every one of them', async () => {
    const net = await boot(makeNet(payload()));
    net.on(isPatch, () => res(409, { error: 'The office has approved this work order. Ask them to reopen it for changes.' }));
    net.on(doneDoor('tk_790'), () => res(409, { error: 'This work order just changed. Reload to see the latest.' }));
    type($('#note'), 'Rails set');
    $('#save').click();
    await flush();
    expect($('#msg').textContent).toBe('The office has approved this work order. Ask them to reopen it for changes.');
    card('tk_790').querySelector('.bdone').click();
    await flush();
    expect(bmsg('tk_790').textContent).toBe('This work order just changed. Reload to see the latest.');
  });

  test('FIRES: hand the browser\'s own rejection straight to the message line and the crew reads "Failed to fetch"', async () => {
    const broken = mutate(SHARE_SCRIPT,
      '    return e && e.status ? e.message : NO_ANSWER;\n',
      '    return e.message;\n');
    const net = await boot(makeNet(payload()), broken);
    net.on(isPatch, networkDown);
    net.on(noteDoor('tk_784'), networkDown);
    type($('#note'), 'Rails set');
    $('#save').click();
    await flush();
    expect($('#msg').textContent).toBe('Failed to fetch');
    await addBuildingNote('tk_784', 'Post reset');
    expect(bmsg('tk_784').textContent).toBe('Failed to fetch');
  });
});

// ════════════════════════════════════════════════════════════════════════
// A retried note is ONE note (1.30)
//
// The save can land and its answer never come back: the page keeps the note in
// the box and re-enables Save, so the crew taps it again and the office's field
// log used to read the same line twice. One client_ref per UNSENT note, kept
// beside the draft so a reload keeps it, retired only by a save that was
// confirmed.
describe('the note carries one key per unsent note', () => {
  const refsOf = (net) => net.of(isPatch).map((c) => JSON.parse(c.init.body).client_ref);
  const noteDoor = (taskId) => (c) => c.method === 'POST' && c.url === API + '/subtasks/' + taskId + '/note';

  test('a save whose answer was lost and the retry that follows carry the SAME key', async () => {
    const net = await boot(makeNet(payload()));
    net.once(isPatch, networkDown);
    type($('#note'), 'Rail post replaced, tread 3 re-cut');
    $('#save').click();
    await flush();
    expect($('#msg').textContent).toBe("Couldn't send that. Check your signal and try again.");
    $('#save').click();
    await flush();
    const refs = refsOf(net);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatch(CLIENT_REF_RE);
    expect(refs[1]).toBe(refs[0]);
    expect($('#msg').textContent).toBe('Report saved.');
  });

  test('the NEXT note, after a save that worked, gets a new key', async () => {
    const net = await boot(makeNet(payload()));
    type($('#note'), 'First note');
    $('#save').click();
    await flush();
    type($('#note'), 'Second note');
    $('#save').click();
    await flush();
    const refs = refsOf(net);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatch(CLIENT_REF_RE);
    expect(refs[1]).toMatch(CLIENT_REF_RE);
    expect(refs[1]).not.toBe(refs[0]);
  });

  test('the key rides with the draft, so a phone that lost the tab retries under it', async () => {
    const net = await boot(makeNet(payload()));
    net.on(isPatch, networkDown);
    type($('#note'), 'Rail post replaced');
    $('#save').click();
    await flush(400);
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_KEY));
    expect(stored.note).toBe('Rail post replaced');
    expect(stored.noteRef).toMatch(CLIENT_REF_RE);

    const net2 = await boot(makeNet(payload()));
    expect($('#note').value).toBe('Rail post replaced');
    $('#save').click();
    await flush();
    expect(refsOf(net2)).toEqual([stored.noteRef]);
    // A save that worked clears the draft, key and all.
    await flush(400);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('a body with no note carries no key: a finish on its own, and a name on its own', async () => {
    const net = await boot(makeNet(payload({ tasks: tasks().map((x) => Object.assign(x, { done: true })) })));
    $('#finishBtn').click();
    $('#finishYes').click();
    await flush();
    expect(net.of(isPatch).map((c) => JSON.parse(c.init.body))).toEqual([{ status: 'work_complete' }]);
  });

  test('a building note carries its own key, reused by the retry after a lost answer', async () => {
    const net = await boot(makeNet(payload()));
    net.once(noteDoor('tk_784'), networkDown);
    await addBuildingNote('tk_784', 'Post reset');
    await addBuildingNote('tk_784', 'Post reset');
    const bodies = net.of(noteDoor('tk_784')).map((c) => JSON.parse(c.init.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].client_ref).toMatch(CLIENT_REF_RE);
    expect(bodies[1].client_ref).toBe(bodies[0].client_ref);
    // And the next note on the same building is a new note.
    await addBuildingNote('tk_784', 'Tread 3 re-cut');
    const third = JSON.parse(net.of(noteDoor('tk_784'))[2].init.body);
    expect(third.client_ref).not.toBe(bodies[0].client_ref);
  });

  test('FIRES: mint a fresh key on every send and the retried report is two notes to the office', async () => {
    const broken = mutate(SHARE_SCRIPT,
      '    if (!drafts.noteRef) { drafts.noteRef = newClientRef(); saveDraftSoon(); }\n    return drafts.noteRef;\n',
      '    drafts.noteRef = newClientRef(); saveDraftSoon();\n    return drafts.noteRef;\n');
    const net = await boot(makeNet(payload()), broken);
    net.once(isPatch, networkDown);
    type($('#note'), 'Rail post replaced, tread 3 re-cut');
    $('#save').click();
    await flush();
    $('#save').click();
    await flush();
    const refs = refsOf(net);
    expect(refs).toHaveLength(2);
    expect(refs[1]).not.toBe(refs[0]);
  });
});
