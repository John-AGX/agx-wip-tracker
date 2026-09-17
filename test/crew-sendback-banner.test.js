/**
 * @jest-environment jsdom
 */
// "Sent back by the office" on the crew link (1.29, B3 crew page).
//
// When the office sends a work order back, the crew read carries send_back:
// { note, at, buildings: [{ id, title, note, reopened }] } until the work
// order next reaches Work complete. The page shows it to EVERY link that can
// see the work order:
//
//   - a red card right under the stepper, before the job site: "Sent back by
//     the office · <when>", the office's words (as text, line breaks kept),
//     "Buildings to redo" with each building's head and its own note, and
//     what to do next;
//   - a "Sent back" chip on each of those buildings that is not done again
//     yet, in place of the photo count / Needs photo (Done still reads Done,
//     and a problem waiting on the office still wins);
//   - nothing once the read stops sending it.
//
// Driven through the REAL inline script of service-ticket-share.html with a
// scripted fetch. Each guard is also shown to FIRE on a copy of the script
// with that guard broken (CRLF-normalised anchor, exactly once).
'use strict';

const fs = require('fs');
const path = require('path');
const { rules, styleOf } = require('./helpers/css-rules');

const ROOT = path.join(__dirname, '..');
const RAW_HTML = fs.readFileSync(path.join(ROOT, 'service-ticket-share.html'), 'utf8');
const SHARE_HTML = RAW_HTML.replace(/\r\n/g, '\n');
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

const TOKEN = 'b3'.repeat(32);
const API = '/api/service-ticket-share/' + TOKEN;
const SENT_AT = new Date(new Date().getFullYear(), 8, 12, 15, 5).toISOString();
const WHEN = () => new Date(SENT_AT).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

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

function makeNet(data) {
  const net = { calls: [], handlers: [], data };
  net.on = (pred, fn) => { net.handlers.unshift({ pred, fn }); return net; };
  net.of = (pred) => net.calls.filter(pred);
  window.fetch = jest.fn((url, init) => {
    init = init || {};
    const call = { url: String(url), method: init.method || 'GET', init };
    net.calls.push(call);
    for (const h of net.handlers) {
      if (h.pred(call)) return Promise.resolve().then(() => h.fn(call));
    }
    return Promise.reject(new TypeError('Failed to fetch'));
  });
  net.on(isGet, () => res(200, net.data));
  net.on((c) => c.method === 'POST' && /\/subtasks\/[^/]+\/(note|done)$/.test(c.url), () => res(200, { ok: true }));
  return net;
}

function tasks() {
  return [
    { id: 'tk_784', title: 'Bldg 784 — Side A: rail post; tread 3', done: false, photos: [], notes: [] },
    { id: 'tk_790', title: 'Bldg 790 — Side D: stringer', done: false,
      photos: [{ id: 'ph_1', kind: 'completion', thumb_url: '/t/1.jpg', web_url: '/w/1.jpg' }], notes: [] },
    { id: 'tk_801', title: 'Bldg 801 — Side B: tread 1', done: true,
      photos: [{ id: 'ph_2', kind: 'completion', thumb_url: '/t/2.jpg', web_url: '/w/2.jpg' }], notes: [] },
  ];
}

const SEND_BACK = () => ({
  note: 'Rail post on 784 is still loose.\nRe-photo tread 3.',
  at: SENT_AT,
  buildings: [
    { id: 'tk_784', title: 'Bldg 784 — Side A: rail post; tread 3', note: 'Post moves by hand', reopened: true },
    { id: 'tk_801', title: 'Bldg 801 — Side B: tread 1', note: null, reopened: false },
  ],
});

function payload(o) {
  o = o || {};
  return {
    org_name: 'AGX Central Florida',
    ticket: { id: 'st_1', title: 'Replace rotted stair treads', ticket_number: 'WO-0007', status: o.status || 'in_progress', materials: [] },
    share: { scope: o.scope || 'respond', hide_financials: true, recipient_name: 'Rafael' },
    site: { job_number: 'M1001', name: 'Latitude Apartments', address: '100 Main St, Tampa, FL' },
    tasks: o.tasks || tasks(),
    site_photos: [],
    flags: o.flags || [],
    send_back: o.send_back === undefined ? SEND_BACK() : o.send_back,
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
const card = (id) => $$('.bld').find((c) => c.getAttribute('data-task') === id) || null;
const chip = (id) => card(id).querySelector('.bld-head .chip');

beforeEach(() => {
  jest.useFakeTimers();
  try { window.localStorage.clear(); } catch (e) { /* nothing */ }
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════
describe('the banner', () => {
  test('right under the stepper, before the job site: when, the office\'s words, the buildings to redo, what to do', async () => {
    await boot(makeNet(payload()));
    const b = $('.card.sentback');
    expect(b).not.toBeNull();
    expect(b.getAttribute('role')).toBe('alert');
    expect(b.previousElementSibling.classList.contains('stepper')).toBe(true);
    expect(b.nextElementSibling.classList.contains('site')).toBe(true);
    expect(b.querySelector('.lbl').textContent).toBe('Sent back by the office · ' + WHEN());
    expect(b.querySelector('.sb-note').textContent).toBe('Rail post on 784 is still loose.\nRe-photo tread 3.');
    expect(b.querySelector('.sb-bld-lbl').textContent).toBe('Buildings to redo');
    expect(Array.from(b.querySelectorAll('.sb-bld li')).map((li) => li.textContent))
      .toEqual(['Bldg 784 — Post moves by hand', 'Bldg 801']);
    expect(Array.from(b.querySelectorAll('.sb-bld li b')).map((x) => x.textContent)).toEqual(['Bldg 784', 'Bldg 801']);
    expect(b.querySelector('.hint').textContent).toBe(
      'Fix these, add a new completion photo to each, and mark each building complete again. The office is told when every building is done.');
  });

  test('no buildings reopened: no list, and the shorter instruction', async () => {
    await boot(makeNet(payload({ send_back: { note: 'Clean up the debris by the dumpster.', at: SENT_AT, buildings: [] } })));
    const b = $('.card.sentback');
    expect(b.querySelector('.sb-bld')).toBeNull();
    expect(b.querySelector('.sb-bld-lbl')).toBeNull();
    expect(b.querySelector('.hint').textContent).toBe('Fix this, then mark the work complete again. The office is told when it’s done.');
  });

  test('a view-only link sees it too', async () => {
    await boot(makeNet(payload({ scope: 'view' })));
    expect($('.card.sentback .sb-note').textContent).toContain('Rail post on 784');
    expect(chip('tk_784').textContent).toBe('Sent back');
  });

  test('no send_back, or one with no words: no banner', async () => {
    await boot(makeNet(payload({ send_back: null })));
    expect($('.card.sentback')).toBeNull();
    await boot(makeNet(payload({ send_back: { note: '', at: SENT_AT, buildings: SEND_BACK().buildings } })));
    expect($('.card.sentback')).toBeNull();
  });

  test('FIRES: drop the words check and an empty send_back draws an empty red card', async () => {
    const broken = mutate(SHARE_SCRIPT,
      '    if (d.send_back && d.send_back.note) html += sentBackHTML(d.send_back);\n',
      '    if (d.send_back) html += sentBackHTML(d.send_back);\n');
    await boot(makeNet(payload({ send_back: { note: '', at: SENT_AT, buildings: [] } })), broken);
    expect($('.card.sentback')).not.toBeNull();
  });

  test('the office\'s words and building titles are text, never markup', async () => {
    await boot(makeNet(payload({
      send_back: {
        note: '<img src=x onerror="window.__sb=1">',
        at: SENT_AT,
        buildings: [{ id: 'tk_784', title: '<b>Bldg 784</b> — x', note: '<script>window.__sb=2</script>', reopened: true }],
      },
    })));
    const b = $('.card.sentback');
    expect(b.querySelector('img')).toBeNull();
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('.sb-note').textContent).toBe('<img src=x onerror="window.__sb=1">');
    expect(b.querySelector('.sb-bld li').textContent).toBe('<b>Bldg 784</b> — <script>window.__sb=2</script>');
    expect(window.__sb).toBeUndefined();
  });

  test('no time on the event: the label is just "Sent back by the office"', async () => {
    await boot(makeNet(payload({ send_back: { note: 'Fix it', at: null, buildings: [] } })));
    expect($('.card.sentback .lbl').textContent).toBe('Sent back by the office');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('the Sent back chip', () => {
  test('on a reopened building not done yet; Done stays Done; a building the office did not name keeps its photo count', async () => {
    await boot(makeNet(payload()));
    expect(chip('tk_784').textContent).toBe('Sent back');
    expect(chip('tk_784').className).toBe('chip back');
    expect(chip('tk_801').textContent).toBe('✓ Done');
    expect(chip('tk_790').textContent).toBe('1 photo');
  });

  test('a completion photo landing on a sent-back building keeps the chip (the card repaints in place)', async () => {
    const net = await boot(makeNet(payload()));
    const hold = deferred();
    net.on((c) => c.method === 'POST' && c.url === API + '/subtasks/tk_784/photo', () => hold.promise);
    const inp = card('tk_784').querySelector('input[type=file][multiple][data-kind="completion"]');
    Object.defineProperty(inp, 'files', { value: [new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg', lastModified: 1 })], configurable: true });
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    hold.resolve(res(200, { ok: true, photo: { id: 'ph_9', kind: 'completion', thumb_url: '/t/9', web_url: '/w/9' } }));
    await flush();
    expect(card('tk_784').querySelector('.photos[data-sec="completion"] .lbl').textContent).toBe('Completion photos · 1');
    expect(chip('tk_784').textContent).toBe('Sent back');
  });

  test('FIRES: without the sent-back branch the chip reads Needs photo', async () => {
    const broken = mutate(SHARE_SCRIPT, "      : sentBackIds[String(x.id)]\n", '      : false\n');
    await boot(makeNet(payload()), broken);
    expect(chip('tk_784').textContent).toBe('Needs photo');
  });

  test('a problem waiting on the office still wins over Sent back', async () => {
    await boot(makeNet(payload({
      flags: [{ id: 'fl_1', task_id: 'tk_784', category: 'no_access', note: 'Gate locked', author_label: 'Rafael', status: 'open', created_at: SENT_AT, resolved_at: null, resolution_note: null, photos: [] }],
    })));
    expect(chip('tk_784').textContent).toBe('Needs office');
  });

  test('once the read stops sending it, the banner and the chips go', async () => {
    const net = await boot(makeNet(payload()));
    expect(chip('tk_784').textContent).toBe('Sent back');
    net.data = payload({ send_back: null });
    const c = card('tk_790');
    c.querySelector('.bnote-in').value = 'Stringer shimmed';
    c.querySelector('.bnote-go').click();
    await flush();
    expect(net.of(isGet).length).toBe(2);
    expect($('.card.sentback')).toBeNull();
    expect(chip('tk_784').textContent).toBe('Needs photo');
  });

  test('FIRES: without clearing the list on each read, the chip outlives the send-back', async () => {
    const broken = mutate(SHARE_SCRIPT, '    sentBackIds = {};\n', '');
    const net = await boot(makeNet(payload()), broken);
    net.data = payload({ send_back: null });
    card('tk_790').querySelector('.bnote-in').value = 'Stringer shimmed';
    card('tk_790').querySelector('.bnote-go').click();
    await flush();
    expect(chip('tk_784').textContent).toBe('Sent back');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('it arrives inline', () => {
  test('the banner and chip styles are in the page\'s own <style>, and the page still links no script or stylesheet', () => {
    const sheet = rules(styleOf(SHARE_HTML));
    const decl = (sel, prop) => {
      const r = sheet.filter((x) => x.selectors.includes(sel) && !x.media.length);
      const d = [].concat(...r.map((x) => x.decls)).filter((x) => x.prop === prop);
      return d.length ? d[d.length - 1].value : null;
    };
    expect(decl('.card.sentback', 'border-color')).toBe('var(--red)');
    expect(decl('.sentback .lbl', 'color')).toBe('var(--red)');
    expect(decl('.sb-note', 'white-space')).toBe('pre-wrap');
    expect(decl('.chip.back', 'color')).toBe('var(--red)');
    expect(SHARE_HTML).not.toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(SHARE_HTML).not.toMatch(/<link[^>]*stylesheet/i);
    expect(RAW_HTML.split('\n').length - 1).toBe(RAW_HTML.split('\r\n').length - 1);
  });
});
