// js/work-order-notices.js — the "ready for approval" notice banner, Notify
// again, and the Progress list wording for the notice events (notify-backbone
// spec, Work Orders 1.29 shared contracts 5.2 and 5.6).
//
// Each test boots a fresh jsdom window and evaluates the SHIPPED
// js/service-ticket-ext.js and js/work-order-notices.js into it. The server is
// a stubbed p86Api.serviceTickets.notifyApprovers answering what
// server/routes/work-order-notice-routes.js answers.
//
//   1. noticeState reads the three bookkeeping columns: gave up, retrying, or
//      nothing — and only on a work order waiting for approval.
//   2. The banner wording, the Notify again button only for editors, one root.
//   3. The button: "Sending…" and disabled, the POST, the server's sentence as
//      the toast, then a re-read; a refusal toasts and gives the button back.
//   4. The event wording.
//
// Mutants copy the source to a temp dir, normalise CRLF, require the anchor
// exactly once and prove the named behaviour goes red.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const EXT_SRC = fs.readFileSync(path.join(ROOT, 'js', 'service-ticket-ext.js'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'work-order-notices.js'), 'utf8');

const GAVE_UP = 'Nobody has been told this is ready for approval.';
const RETRYING = "The ready-for-approval notice didn't go through. Trying again automatically.";

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.data = { error: message };
  e.retryAfter = null;
  return e;
}

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'https://project86.net/',
  });
  const win = dom.window;
  const gates = [];
  win.p86Api = {
    serviceTickets: {
      notifyApprovers: jest.fn(() => new Promise((resolve, reject) => {
        gates.push({ resolve, reject });
      })),
    },
  };
  win.eval(EXT_SRC);
  win.eval(o.src || SRC);
  return { win, doc: win.document, gates, api: win.p86Api.serviceTickets, WON: win.p86WorkOrderNotices };
}

function mutant(anchor, replacement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'won-ui-mutant-'));
  const copy = path.join(dir, 'work-order-notices.js');
  fs.writeFileSync(copy, SRC);
  const src = fs.readFileSync(copy, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length - 1 !== 1) throw new Error('anchor not found');
  return src.replace(anchor, replacement);
}

async function mustFail(check) {
  let threw = false;
  try { await check(); } catch (e) { threw = true; }
  expect(threw).toBe(true);
}

async function flush(n) {
  for (let i = 0; i < (n || 6); i++) await new Promise((r) => setTimeout(r, 0));
}

function ticket(extra) {
  return Object.assign({
    id: 'st_9', status: 'work_complete', title: 'Stair repairs',
    approval_notified_at: null, approval_notice_attempts: 0, approval_notice_gave_up_at: null,
  }, extra || {});
}

function ctxFor(t, extra) {
  return Object.assign({
    ticketId: t.id, t, r: { ticket: t }, canEdit: true,
    toast: jest.fn(),
    refresh: jest.fn(() => Promise.resolve()),
  }, extra || {});
}

// Paints the banner section the way the host does (contracts 5.2).
function paint(env, ctx) {
  const sections = env.win.p86StExt.collect('detailSections', ctx).reduce((a, s) => a.concat(s), []);
  const sec = sections.find((s) => s.key === 'notice-banner');
  const host = env.doc.getElementById('host');
  host.innerHTML = sec.html;
  const node = host.firstElementChild;
  if (node && sec.wire) sec.wire(node, ctx);
  return { sec, node };
}

function click(win, el) {
  if (!el) throw new Error('nothing to click');
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
}

// ── Checks reused by the mutants ────────────────────────────────────────
function checkState(src) {
  const { WON } = boot({ src });
  expect(WON.noticeState(ticket({ approval_notice_gave_up_at: '2026-09-15T10:00:00.000Z', approval_notice_attempts: 4 }))).toBe('gave_up');
  expect(WON.noticeState(ticket({ approval_notice_attempts: 2 }))).toBe('retrying');
  expect(WON.noticeState(ticket({ approval_notice_attempts: '1' }))).toBe('retrying');
  expect(WON.noticeState(ticket({ approval_notice_attempts: 0 }))).toBeNull();
  expect(WON.noticeState(ticket({ approval_notice_attempts: null }))).toBeNull();
  // Told already (a claim in progress or a success): nothing to say.
  expect(WON.noticeState(ticket({ approval_notice_attempts: 1, approval_notified_at: '2026-09-15T10:00:00.000Z' }))).toBeNull();
  // Moved on from Work complete: the banner goes, whatever the columns say.
  expect(WON.noticeState(ticket({ status: 'approved', approval_notice_gave_up_at: '2026-09-15T10:00:00.000Z' }))).toBeNull();
  expect(WON.noticeState(ticket({ status: 'in_progress', approval_notice_attempts: 3 }))).toBeNull();
  expect(WON.noticeState(null)).toBeNull();
}

function checkReadOnlyHasNoButton(src) {
  const { WON } = boot({ src });
  const gave = ticket({ approval_notice_gave_up_at: '2026-09-15T10:00:00.000Z' });
  expect(WON.bannerHTML(gave, true)).toContain('>Notify again</button>');
  expect(WON.bannerHTML(gave, false)).toContain(GAVE_UP);
  expect(WON.bannerHTML(gave, false)).not.toContain('Notify again');
}

async function checkButtonFlow(src) {
  const env = boot({ src });
  const t = ticket({ approval_notice_attempts: 2 });
  const ctx = ctxFor(t);
  const { node } = paint(env, ctx);
  const btn = node.querySelector('.p86-won-again');
  click(env.win, btn);
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toBe('Sending…');
  expect(env.api.notifyApprovers).toHaveBeenCalledTimes(1);
  expect(env.api.notifyApprovers).toHaveBeenCalledWith('st_9');
  // A second click while sending does not send twice.
  click(env.win, btn);
  expect(env.api.notifyApprovers).toHaveBeenCalledTimes(1);
  expect(ctx.refresh).not.toHaveBeenCalled();

  env.gates[0].resolve({ ok: true, sent: 2, recipients: 2, skipped: null, message: 'Told 2 people.' });
  await flush();
  expect(ctx.toast).toHaveBeenCalledWith('Told 2 people.', 'success');
  expect(ctx.refresh).toHaveBeenCalledTimes(1);
  // The same banner can come back on the re-read; its button is usable again.
  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe('Notify again');
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('noticeState', () => {
  test('gave up, retrying, or nothing', () => {
    checkState(SRC);
  });

  test('MUTANT: ignoring whether it was already told shows a false retrying banner', () => {
    const src = mutant(' && !t.approval_notified_at) return', ') return');
    expect(() => checkState(src)).toThrow();
  });

  test('MUTANT: dropping the Work complete gate keeps the banner on an approved ticket', () => {
    const src = mutant("if (t.status !== 'work_complete') return null;", '');
    expect(() => checkState(src)).toThrow();
  });
});

describe('bannerHTML', () => {
  test('wording per state, one inline-styled root, button only for editors', () => {
    const { WON, win } = boot();
    const gave = WON.bannerHTML(ticket({ approval_notice_gave_up_at: '2026-09-15T10:00:00.000Z' }), true);
    const retry = WON.bannerHTML(ticket({ approval_notice_attempts: 1 }), true);
    for (const [html, text, state] of [[gave, GAVE_UP, 'gave_up'], [retry, RETRYING, 'retrying']]) {
      const tpl = win.document.createElement('template');
      tpl.innerHTML = html;
      expect(tpl.content.childElementCount).toBe(1);
      const root = tpl.content.firstElementChild;
      expect(root.getAttribute('data-state')).toBe(state);
      expect(root.getAttribute('role')).toBe('status');
      expect(root.getAttribute('style')).toMatch(/border-left:4px solid/);
      expect(root.querySelector('.p86-won-text').textContent).toBe(text);
      const btn = root.querySelector('button.p86-won-again');
      expect(btn.textContent).toBe('Notify again');
      expect(btn.getAttribute('type')).toBe('button');
    }
    expect(WON.bannerHTML(ticket(), true)).toBe('');
    expect(WON.bannerHTML(ticket({ status: 'approved', approval_notice_attempts: 2 }), true)).toBe('');
  });

  test('a viewer who cannot edit sees the sentence without the button', () => {
    checkReadOnlyHasNoButton(SRC);
  });

  test('MUTANT: offering Notify again to a read-only viewer is caught', () => {
    const src = mutant('      (canEdit\n', '      (true\n');
    expect(() => checkReadOnlyHasNoButton(src)).toThrow();
  });

  test('registers as work-order-notices, order 20, banner section keyed notice-banner', () => {
    const env = boot();
    const row = env.win.p86StExt.list().find((x) => x.name === 'work-order-notices');
    expect(row.order).toBe(20);
    expect(typeof row.ext.detailSections).toBe('function');
    expect(typeof row.ext.eventWhat).toBe('function');
    const t = ticket({ approval_notice_attempts: 3 });
    const sections = env.win.p86StExt.collect('detailSections', ctxFor(t, { canEdit: false }))[0];
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('notice-banner');
    expect(sections[0].slot).toBe('banner');
    expect(sections[0].html).toBe(env.WON.bannerHTML(t, false));
    expect(env.win.p86StExt.collect('detailSections', ctxFor(ticket()))[0][0].html).toBe('');
    ['noticeState', 'bannerHTML', 'bind', 'eventWhat'].forEach((k) => expect(typeof env.WON[k]).toBe('function'));
  });
});

describe('Notify again', () => {
  test('shows Sending…, posts once, toasts the server message, then re-reads', async () => {
    await checkButtonFlow(SRC);
  });

  test('MUTANT: a button that never says Sending… is caught', async () => {
    const src = mutant("    btn.textContent = 'Sending…';\n", '');
    await mustFail(() => checkButtonFlow(src));
  });

  test('MUTANT: skipping the re-read after a send is caught', async () => {
    const src = mutant('      return settle(opts);\n    }, function (err) {', '      return undefined;\n    }, function (err) {');
    await mustFail(() => checkButtonFlow(src));
  });

  test('the server’s other sentences are shown as they come', async () => {
    const messages = [
      { sent: 0, skipped: 'already_notified', message: 'Already sent in the last 15 minutes.' },
      { sent: 0, skipped: 'no_recipients', message: 'No one else who can approve this work order has these notices turned on.' },
      { sent: 0, skipped: 'nobody_reached', message: "The notice didn't go through. It will be tried again automatically." },
      { sent: 1, skipped: null, message: 'Told 1 person.' },
    ];
    for (const m of messages) {
      const env = boot();
      const ctx = ctxFor(ticket({ approval_notice_gave_up_at: '2026-09-15T10:00:00.000Z' }));
      const { node } = paint(env, ctx);
      click(env.win, node.querySelector('.p86-won-again'));
      env.gates[0].resolve(Object.assign({ ok: true, recipients: m.sent }, m));
      await flush();
      expect(ctx.toast).toHaveBeenCalledTimes(1);
      expect(ctx.toast.mock.calls[0][0]).toBe(m.message);
      expect(ctx.toast.mock.calls[0][1]).toBe(m.sent > 0 ? 'success' : undefined);
      expect(ctx.refresh).toHaveBeenCalledTimes(1);
    }
  });

  test('a failure toasts and gives the button back without a re-read', async () => {
    const env = boot();
    const ctx = ctxFor(ticket({ approval_notice_attempts: 1 }));
    const { node } = paint(env, ctx);
    const btn = node.querySelector('.p86-won-again');
    click(env.win, btn);
    env.gates[0].reject(httpError(500, 'Failed to send the notice'));
    await flush();
    expect(ctx.toast).toHaveBeenCalledWith('Failed to send the notice', 'error');
    expect(ctx.refresh).not.toHaveBeenCalled();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Notify again');
    // And it can be pressed again.
    click(env.win, btn);
    expect(env.api.notifyApprovers).toHaveBeenCalledTimes(2);
  });

  test('409 not waiting for approval toasts and re-reads so the banner goes', async () => {
    const env = boot();
    const ctx = ctxFor(ticket({ approval_notice_attempts: 1 }));
    const { node } = paint(env, ctx);
    click(env.win, node.querySelector('.p86-won-again'));
    env.gates[0].reject(httpError(409, "This work order isn't waiting for approval."));
    await flush();
    expect(ctx.toast).toHaveBeenCalledWith("This work order isn't waiting for approval.", 'error');
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
  });

  test('wire again with a newer ticket and ctx: the next click uses them, one listener only', async () => {
    const env = boot();
    const ctx1 = ctxFor(ticket({ id: 'st_old', approval_notice_attempts: 1 }));
    const { sec, node } = paint(env, ctx1);
    const ctx2 = ctxFor(ticket({ id: 'st_new', approval_notice_attempts: 2 }));
    sec.wire(node, ctx2);
    click(env.win, node.querySelector('.p86-won-again'));
    expect(env.api.notifyApprovers).toHaveBeenCalledTimes(1);
    expect(env.api.notifyApprovers).toHaveBeenCalledWith('st_new');
    env.gates[0].resolve({ ok: true, sent: 1, message: 'Told 1 person.' });
    await flush();
    expect(ctx2.toast).toHaveBeenCalledWith('Told 1 person.', 'success');
    expect(ctx2.refresh).toHaveBeenCalledTimes(1);
    expect(ctx1.refresh).not.toHaveBeenCalled();
  });

  test('bind() works on its own for a caller outside the registry', async () => {
    const env = boot();
    const t = ticket({ approval_notice_attempts: 1 });
    const host = env.doc.getElementById('host');
    host.innerHTML = '<div class="wrap">' + env.WON.bannerHTML(t, true) + '</div>';
    const onDone = jest.fn();
    const toast = jest.fn();
    env.WON.bind(host, t, { onDone, toast });
    click(env.win, host.querySelector('.p86-won-again'));
    env.gates[0].resolve({ ok: true, sent: 3, message: 'Told 3 people.' });
    await flush();
    expect(toast).toHaveBeenCalledWith('Told 3 people.', 'success');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('eventWhat', () => {
  function ev(kind, detail) {
    return { kind, actor_kind: 'system', detail: JSON.stringify(detail) };
  }

  test('approval_notified, with the admin fallback and the try number', () => {
    const { WON } = boot();
    expect(WON.eventWhat(ev('approval_notified', { names: ['Paula PM', 'Omar'], reason: 'office_moved' })))
      .toBe('told Paula PM, Omar it is ready for approval');
    expect(WON.eventWhat(ev('approval_notified', { names: ['Adam Admin'], reason: 'marked_complete', fallback: 'admins' })))
      .toBe('told Adam Admin it is ready for approval (nobody on the work order could approve it, so the admins were told)');
    expect(WON.eventWhat(ev('approval_notified', { names: ['Paula PM'], reason: 'retry', attempt: 3 })))
      .toBe('told Paula PM it is ready for approval — on try 3');
    expect(WON.eventWhat(ev('approval_notified', { names: ['Paula PM'], reason: 'retry', attempt: 1 })))
      .toBe('told Paula PM it is ready for approval');
    expect(WON.eventWhat(ev('approval_notified', { names: [] }))).toBeNull();
  });

  test('approval_notice_failed, assignee_notified and flag_notified', () => {
    const { WON } = boot();
    expect(WON.eventWhat(ev('approval_notice_failed', { attempts: 4, reason: 'nobody_reached' })))
      .toBe('could not tell anyone this is ready for approval');
    expect(WON.eventWhat(ev('approval_notice_failed', { attempts: 4, reason: 'muted' })))
      .toBe('could not tell anyone this is ready for approval — everyone who can approve it has these notices turned off');
    expect(WON.eventWhat(ev('assignee_notified', { names: ['Dana'] }))).toBe('told Dana this work order is assigned to them');
    expect(WON.eventWhat(ev('flag_notified', { names: ['Paula PM', 'Sam'], flag_id: 'f1' }))).toBe('told Paula PM, Sam about the problem');
    expect(WON.eventWhat(ev('flag_notified', { names: [], flag_id: 'f1' }))).toBeNull();
  });

  test('names are escaped; other events and bad details answer null', () => {
    const env = boot();
    const out = env.WON.eventWhat(ev('assignee_notified', { names: ['<img src=x onerror=alert(1)>'] }));
    expect(out).toBe('told &lt;img src=x onerror=alert(1)&gt; this work order is assigned to them');
    expect(env.WON.eventWhat(ev('status_changed', { to: 'work_complete' }))).toBeNull();
    expect(env.WON.eventWhat({ kind: 'approval_notified', detail: '{not json' })).toBeNull();
    // Through the registry, with the host's helpers carrying the parsed detail.
    const helpers = { esc: String, head: () => '', statusLabel: String, detail: { names: ['Paula PM'] } };
    expect(env.win.p86StExt.first('eventWhat', { kind: 'approval_notified', detail: null }, helpers))
      .toBe('told Paula PM it is ready for approval');
  });
});

describe('source rules', () => {
  test('CRLF, inline styles only, no native dialogs, no date helpers', () => {
    expect(SRC.includes('\r\n')).toBe(true);
    expect(SRC.replace(/\r\n/g, '').includes('\n')).toBe(false);
    const norm = SRC.replace(/\r\n/g, '\n');
    expect(norm).not.toMatch(/function\s+(fmtDate\w*|fmtDay\w*|formatDate\w*|todayISO)\s*\(/);
    expect(norm).not.toMatch(/window\.(confirm|prompt|alert)\s*\(/);
    expect(norm).not.toMatch(/\bp86Confirm\s*\(/);
    expect(norm).not.toMatch(/<link|\.css['"]/);
    expect(fs.existsSync(path.join(ROOT, 'css', 'work-order-notices.css'))).toBe(false);
  });
});
