// js/work-order-review.js — the Review & approve bar, the review sheet, the
// Approve / Send back / Cancel / Reason dialogs and the Progress list wording
// (review-approve spec §7, Work Orders 1.29 shared contracts 5.2 and 5.6).
//
// Each test boots a fresh jsdom window and evaluates the SHIPPED files into
// it, in index.html order: js/service-ticket-ext.js (the registry),
// js/service-ticket-status-move.js (Move to…'s sender) and then
// js/work-order-review.js. The server is a stubbed
// p86Api.serviceTickets.setStatus. The host (js/service-tickets.js) is not
// loaded: its side of the contract is driven through window.p86StExt exactly
// as contracts 5.2 describe it, so this file does not depend on another unit's
// same-wave code.
//
// Mutants copy the source to a temp dir, normalise CRLF, require the anchor
// exactly once and prove the named behaviour goes red.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const REVIEW_PATH = path.join(ROOT, 'js', 'work-order-review.js');
const EXT_SRC = fs.readFileSync(path.join(ROOT, 'js', 'service-ticket-ext.js'), 'utf8');
const MOVE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'service-ticket-status-move.js'), 'utf8');
const SRC = fs.readFileSync(REVIEW_PATH, 'utf8');

const STALE = 'This work order just changed. Reload to see the latest.';

function httpError(status, message, data) {
  const e = new Error(message);
  e.status = status;
  e.data = data === undefined ? { error: message } : data;
  e.retryAfter = null;
  return e;
}

// answers: one entry per setStatus call — a value resolves, an Error rejects.
function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'https://project86.net/',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const calls = [];
  const queue = (o.answers || []).slice();
  win.p86Api = {
    serviceTickets: {
      setStatus: jest.fn((id, status, body) => {
        calls.push({ id, status, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
        const next = queue.shift();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }),
    },
  };
  win.p86Attachments = { openLightbox: jest.fn() };
  win.eval(EXT_SRC);
  win.eval(MOVE_SRC);
  win.eval(o.src || SRC);
  return { dom, win, doc: win.document, calls, api: win.p86Api.serviceTickets, WOR: win.p86WorkOrderReview };
}

function mutant(anchor, replacement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wor-ui-mutant-'));
  const copy = path.join(dir, 'work-order-review.js');
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

// ── Fixtures ────────────────────────────────────────────────────────────
function photo(id, kind) {
  return { id, kind, thumb_url: '/thumb/' + id + '.jpg', web_url: '/web/' + id + '.jpg' };
}

// Three buildings: one done with a completion photo, one done WITHOUT one,
// one not finished.
function workCompleteR(ticketExtra) {
  return {
    ticket: Object.assign({
      id: 'st_1', title: 'Stair repairs', status: 'work_complete',
      scope_proposed: 'Replace rotted treads on 784, 786 and 790.', scope_approved: '',
    }, ticketExtra || {}),
    site: { job_number: 'J-1042', name: 'Lakeside Villas', address: '12 Palm Way, Orlando' },
    tasks: [
      {
        id: 't1', title: 'Bldg 784 — Side A: rail post; tread 3', status: 'done',
        completed_by: 'Carlos Crew', completed_at: '2026-09-14T15:30:00.000Z',
        photos: [photo('p1', 'before'), photo('p2', 'completion')],
        notes: [
          { note: 'first note', by: 'Carlos Crew', at: '2026-09-12T12:00:00.000Z' },
          { note: 'second note', by: 'Carlos Crew', at: '2026-09-13T12:00:00.000Z' },
          { note: 'Rail post reset', by: 'Carlos Crew', at: '2026-09-14T12:00:00.000Z' },
        ],
      },
      {
        id: 't2', title: 'Bldg 786 — Side B: tread 1', status: 'done',
        completed_by: 'Dana Crew', completed_at: '2026-09-14T16:00:00.000Z',
        photos: [photo('p3', 'before')], notes: [],
      },
      { id: 't3', title: 'Bldg 790 — Side D: stringer', status: 'open', photos: [], notes: [] },
    ],
    review: { approved_by_name: null, cancelled_by_name: null, send_back: null },
    events: [],
  };
}

function ctxFor(win, r, extra) {
  const ctx = Object.assign({
    ticketId: r.ticket.id,
    t: r.ticket,
    r,
    canEdit: true,
    jobId: 'j1',
    leadId: null,
    toast: jest.fn(),
    refresh: jest.fn(() => Promise.resolve()),
    reload: jest.fn(() => Promise.resolve()),
    leave: jest.fn(() => Promise.resolve(true)),
    taskTitle: (id) => ((r.tasks || []).find((k) => k.id === id) || {}).title || '',
    api: () => win.p86Api.serviceTickets,
  }, extra || {});
  return ctx;
}

function click(win, el) {
  if (!el) throw new Error('nothing to click');
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
}

function setChecked(win, box, on) {
  if (!box) throw new Error('no checkbox');
  box.checked = on;
  box.dispatchEvent(new win.Event('change', { bubbles: true }));
}

function dialog(doc) {
  return doc.querySelector('.p86-wor-dlg');
}

function textOf(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

// Renders the banner section the way the host does (contracts 5.2): collect
// detailSections, put the html in the page, call wire with the root.
function paintBar(env, ctx) {
  const sections = env.win.p86StExt.collect('detailSections', ctx).reduce((a, s) => a.concat(s), []);
  const bar = sections.find((s) => s.key === 'wor-bar');
  const host = env.doc.getElementById('host');
  host.innerHTML = bar.html;
  const node = host.firstElementChild;
  if (node && bar.wire) bar.wire(node, ctx);
  return { bar, node };
}

async function openSheet(env, ctx) {
  const { node } = paintBar(env, ctx);
  click(env.win, node.querySelector('.p86-wor-open'));
  await flush();
  const sheet = env.doc.querySelector('.p86-wor-sheet');
  if (!sheet) throw new Error('sheet did not open');
  return sheet;
}

// The host's Move to… (contracts 5.2 / W3-A (b)): ask the registry, then send
// through p86MoveTicketStatus.
async function hostMove(env, ctx, to, answerDialog) {
  let extra = env.win.p86StExt.first('confirmMove', ctx, to);
  if (extra === undefined) extra = {};
  const pending = Promise.resolve(extra);
  await flush();
  if (answerDialog) await answerDialog();
  extra = await pending;
  if (extra === null) return { outcome: 'dismissed' };
  const out = await env.win.p86MoveTicketStatus(ctx.t, to, extra);
  if (out.outcome === 'moved') env.win.p86StExt.collect('afterStatus', ctx, out.response, ctx.t.status, to);
  return out;
}

// ── Checks reused by the mutants ────────────────────────────────────────
async function checkMoveToCancelledSendsReason(src) {
  const env = boot({ src, answers: [{ ok: true, ticket: { id: 'st_2', status: 'cancelled' } }] });
  const r = workCompleteR({ id: 'st_2', status: 'in_progress' });
  const ctx = ctxFor(env.win, r);
  const out = await hostMove(env, ctx, 'cancelled', async () => {
    const dlg = dialog(env.doc);
    if (!dlg) throw new Error('cancel dialog did not open');
    expect(dlg.getAttribute('data-dialog')).toBe('cancel');
    dlg.querySelector('.p86-wor-reason').value = 'Owner cancelled the repair.';
    click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
  });
  expect(out.outcome).toBe('moved');
  expect(env.calls).toEqual([
    { id: 'st_2', status: 'cancelled', body: { reason: 'Owner cancelled the repair.', expected_status: 'in_progress' } },
  ]);
  expect(ctx.toast).toHaveBeenCalledWith('Work order cancelled.', 'success');
}

async function checkSendBackNeedsReason(src) {
  const env = boot({ src, answers: [{ ok: true, ticket: { id: 'st_1', status: 'in_progress' }, send_back: { reopened: 1, crew_emailing: 1 } }] });
  const ctx = ctxFor(env.win, workCompleteR());
  const sheet = await openSheet(env, ctx);
  const card = sheet.querySelector('.p86-wor-card[data-task="t1"]');
  setChecked(env.win, card.querySelector('.p86-wor-pick-box'), true);
  card.querySelector('.p86-wor-pick-note').value = 'Rail post still loose';
  click(env.win, sheet.querySelector('.p86-wor-sendback'));
  const dlg = dialog(env.doc);
  expect(dlg.getAttribute('data-dialog')).toBe('send_back');
  click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
  await flush();
  expect(env.api.setStatus).not.toHaveBeenCalled();
  const err = dlg.querySelector('.p86-wor-err');
  expect(err.hidden).toBe(false);
  expect(err.textContent).toBe('Say what needs fixing.');
  expect(env.doc.activeElement).toBe(dlg.querySelector('.p86-wor-reason'));

  dlg.querySelector('.p86-wor-reason').value = '  Re-photo tread 3 and reset the post.  ';
  click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
  await flush();
  expect(env.calls).toEqual([{
    id: 'st_1',
    status: 'in_progress',
    body: {
      expected_status: 'work_complete',
      reason: 'Re-photo tread 3 and reset the post.',
      reopen_tasks: [{ id: 't1', note: 'Rail post still loose' }],
    },
  }]);
  expect(env.doc.querySelector('.p86-wor-back')).toBeNull();
  expect(dialog(env.doc)).toBeNull();
  expect(ctx.refresh).toHaveBeenCalledTimes(1);
  expect(ctx.toast).toHaveBeenCalledWith('Sent back to the crew. 1 building reopened. Emailing the link recipient.', 'success');
}

async function checkStaleClosesAndRefreshes(src) {
  const env = boot({ src, answers: [httpError(409, STALE, { error: STALE, code: 'status_changed', current_status: 'in_progress' })] });
  const ctx = ctxFor(env.win, workCompleteR());
  const sheet = await openSheet(env, ctx);
  click(env.win, sheet.querySelector('.p86-wor-approve'));
  click(env.win, dialog(env.doc).querySelector('.p86-wor-dlg-ok'));
  await flush();
  expect(env.api.setStatus).toHaveBeenCalledTimes(1);
  expect(ctx.toast).toHaveBeenCalledWith(STALE, 'error');
  expect(dialog(env.doc)).toBeNull();
  expect(env.doc.querySelector('.p86-wor-back')).toBeNull();
  expect(ctx.refresh).toHaveBeenCalledTimes(1);
}

// ── The bar ──────────────────────────────────────────────────────────────
describe('barHTML', () => {
  test('Ready for review counts buildings, completion photos, gaps and unfinished', () => {
    const { WOR, win } = boot();
    const html = WOR.barHTML(workCompleteR(), true);
    const tpl = win.document.createElement('template');
    tpl.innerHTML = html;
    expect(tpl.content.childElementCount).toBe(1);
    const text = textOf(tpl.content.firstElementChild);
    expect(text).toContain('Ready for review');
    expect(text).toContain('2 of 3 buildings done');
    expect(text).toContain('1 completion photo');
    expect(text).toContain('1 without a completion photo');
    expect(text).toContain('1 not finished');
    expect(tpl.content.querySelector('button.p86-wor-open').textContent).toBe('Review & approve');
  });

  test('a read-only viewer gets no Review bar on Work complete', () => {
    const { WOR } = boot();
    expect(WOR.barHTML(workCompleteR(), false)).toBe('');
  });

  test('no punch list says so', () => {
    const { WOR } = boot();
    const r = workCompleteR();
    r.tasks = [];
    expect(WOR.barHTML(r, true)).toContain('<strong>Ready for review</strong> · no punch list on this work order');
  });

  test('approved and closed show who approved it; cancelled shows who cancelled it', () => {
    const { WOR, win } = boot();
    const approved = workCompleteR({ status: 'approved', approved_at: '2026-09-15T14:00:00.000Z', approved_by: 7 });
    approved.review.approved_by_name = 'Paula PM';
    expect(WOR.barHTML(approved, false)).toContain('Approved by Paula PM · ');
    expect(WOR.barHTML(Object.assign({}, approved, { ticket: Object.assign({}, approved.ticket, { status: 'closed' }) }), true))
      .toContain('Approved by Paula PM');
    approved.review.approved_by_name = null;
    expect(WOR.barHTML(approved, true)).toContain('Approved by someone no longer on the team');

    const cancelled = workCompleteR({ status: 'cancelled', cancelled_at: '2026-09-15T14:00:00.000Z' });
    cancelled.review.cancelled_by_name = 'Omar Office';
    const html = WOR.barHTML(cancelled, true);
    expect(html).toContain('p86-wor-stamp is-cancel');
    expect(html).toContain('Cancelled by Omar Office · ');
    expect(html).toContain('. The reason is in Progress below.');
    const tpl = win.document.createElement('template');
    tpl.innerHTML = html;
    expect(tpl.content.childElementCount).toBe(1);
  });

  test('the sent-back note shows what the crew link shows, escaped', () => {
    const { WOR } = boot();
    const r = workCompleteR({ status: 'in_progress' });
    r.review.send_back = {
      note: 'Reset <b>the</b> post',
      at: '2026-09-15T14:00:00.000Z',
      buildings: [{ id: 't1', title: 'Bldg 784 — Side A: rail post', note: null, reopened: true }, { id: 't3', title: 'Bldg 790', note: 'x', reopened: false }],
    };
    const html = WOR.barHTML(r, true);
    expect(html).toContain('class="p86-wor-sentback"');
    expect(html).toContain('The crew link shows: “Reset &lt;b&gt;the&lt;/b&gt; post”');
    expect(html).toContain(' · Buildings to redo: Bldg 784, Bldg 790');
    expect(html).not.toContain('<b>');
  });

  test('registers as work-order-review, order 10, with a banner section keyed wor-bar', () => {
    const env = boot();
    const row = env.win.p86StExt.list().find((x) => x.name === 'work-order-review');
    expect(row.order).toBe(10);
    ['detailSections', 'confirmMove', 'afterStatus', 'eventWhat'].forEach((h) => expect(typeof row.ext[h]).toBe('function'));
    const ctx = ctxFor(env.win, workCompleteR());
    const sections = env.win.p86StExt.collect('detailSections', ctx)[0];
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('wor-bar');
    expect(sections[0].slot).toBe('banner');
    expect(sections[0].html).toBe(env.WOR.barHTML(workCompleteR(), true));
    ['barHTML', 'confirmMove', 'afterStatus', 'eventText', 'openReview'].forEach((k) => expect(typeof env.WOR[k]).toBe('function'));
  });
});

// ── The sheet ────────────────────────────────────────────────────────────
describe('review sheet', () => {
  test('opens after ctx.leave() and shows every building with its markers', async () => {
    const env = boot();
    const ctx = ctxFor(env.win, workCompleteR());
    const sheet = await openSheet(env, ctx);
    expect(ctx.leave).toHaveBeenCalledTimes(1);
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(env.doc.getElementById(sheet.getAttribute('aria-labelledby')).textContent).toBe('Review & approve');
    expect(textOf(sheet.querySelector('.p86-wor-title'))).toBe('Stair repairs');
    expect(textOf(sheet.querySelector('.p86-wor-site'))).toBe('J-1042 · Lakeside Villas · 12 Palm Way, Orlando');
    expect(sheet.querySelector('.p86-wor-x').getAttribute('aria-label')).toBe('Close');

    const cards = sheet.querySelectorAll('.p86-wor-card');
    expect(Array.from(cards).map((c) => c.getAttribute('data-task'))).toEqual(['t1', 't2', 't3']);
    expect(textOf(cards[0].querySelector('.p86-wor-card-head'))).toBe('Bldg 784');
    expect(textOf(cards[0].querySelector('.p86-wor-card-status'))).toMatch(/^Done by Carlos Crew · /);
    expect(cards[0].classList.contains('needs-look')).toBe(false);
    // The last two notes only.
    const notes = Array.from(cards[0].querySelectorAll('.p86-wor-note')).map(textOf);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^Carlos Crew · .*: second note$/);
    expect(notes[1]).toMatch(/: Rail post reset$/);
    expect(textOf(cards[1])).toContain('No completion photo');
    expect(cards[1].classList.contains('needs-look')).toBe(true);
    expect(textOf(cards[2].querySelector('.p86-wor-card-status'))).toBe('Not finished');
    expect(textOf(cards[2])).toContain('No before photo');

    const pills = sheet.querySelectorAll('.p86-wor-pill');
    expect(textOf(pills[0])).toBe('All buildings (3)');
    expect(textOf(pills[1])).toBe('Needs a look (2)');
    click(env.win, pills[1]);
    expect(Array.from(cards).map((c) => c.hidden)).toEqual([true, false, false]);
    click(env.win, pills[0]);
    expect(Array.from(cards).map((c) => c.hidden)).toEqual([false, false, false]);

    const foot = Array.from(sheet.querySelectorAll('.p86-wor-foot button')).map(textOf);
    expect(foot).toEqual(['Approve', 'Send back…', 'Cancel work order…', 'Close']);
  });

  test('stays shut when the unsaved-edits question says stay', async () => {
    const env = boot();
    const ctx = ctxFor(env.win, workCompleteR(), { leave: jest.fn(() => Promise.resolve(false)) });
    const { node } = paintBar(env, ctx);
    click(env.win, node.querySelector('.p86-wor-open'));
    await flush();
    expect(ctx.leave).toHaveBeenCalledTimes(1);
    expect(env.doc.querySelector('.p86-wor-sheet')).toBeNull();
  });

  test('a thumb opens the lightbox on that building’s photos at its own index', async () => {
    const env = boot();
    const ctx = ctxFor(env.win, workCompleteR());
    const sheet = await openSheet(env, ctx);
    click(env.win, sheet.querySelector('.p86-wor-card[data-task="t1"] .p86-wor-shot[data-kind="completion"]'));
    const lb = env.win.p86Attachments.openLightbox;
    expect(lb).toHaveBeenCalledTimes(1);
    expect(lb.mock.calls[0][0].map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(lb.mock.calls[0][1]).toBe(1);
    expect(lb.mock.calls[0][2]).toEqual({ parentLabel: 'Bldg 784', parentSubtitle: 'Stair repairs' });
  });

  test('picking a building reveals its note box and counts it; Escape and Close shut the sheet', async () => {
    const env = boot();
    const ctx = ctxFor(env.win, workCompleteR());
    const sheet = await openSheet(env, ctx);
    const count = sheet.querySelector('.p86-wor-count');
    expect(count.hidden).toBe(true);
    const card = sheet.querySelector('.p86-wor-card[data-task="t2"]');
    const note = card.querySelector('.p86-wor-pick-note');
    expect(note.hidden).toBe(true);
    expect(note.getAttribute('maxlength')).toBe('500');
    expect(note.getAttribute('placeholder')).toBe('What’s wrong here? (optional — the crew sees it)');
    setChecked(env.win, card.querySelector('.p86-wor-pick-box'), true);
    expect(note.hidden).toBe(false);
    expect(count.hidden).toBe(false);
    expect(textOf(count)).toBe('1 building marked to send back');

    env.doc.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(env.doc.querySelector('.p86-wor-back')).toBeNull();

    const again = await openSheet(env, ctx);
    click(env.win, again.querySelector('.p86-wor-close'));
    expect(env.doc.querySelector('.p86-wor-back')).toBeNull();
  });
});

// ── Dialogs from the sheet ──────────────────────────────────────────────
describe('send back', () => {
  test('blank reason is refused in the dialog; with a reason and a picked card it sends reopen_tasks', async () => {
    await checkSendBackNeedsReason(SRC);
  });

  test('the dialog lists done buildings, carries sheet picks, and a picked unfinished building is sent but not reopenable', async () => {
    const env = boot({ answers: [{ ok: true, ticket: { id: 'st_1', status: 'in_progress' }, send_back: { reopened: 0, crew_emailing: 0 } }] });
    const ctx = ctxFor(env.win, workCompleteR());
    const sheet = await openSheet(env, ctx);
    const unfinished = sheet.querySelector('.p86-wor-card[data-task="t3"]');
    setChecked(env.win, unfinished.querySelector('.p86-wor-pick-box'), true);
    unfinished.querySelector('.p86-wor-pick-note').value = 'Stringer not started';
    click(env.win, sheet.querySelector('.p86-wor-sendback'));
    const dlg = dialog(env.doc);
    expect(textOf(dlg.querySelector('.p86-st-modal-head'))).toBe('Send back to the crew');
    expect(textOf(dlg)).toContain('What needs fixing? *');
    expect(dlg.querySelector('.p86-wor-req')).not.toBeNull();
    expect(dlg.querySelector('.p86-wor-reason').getAttribute('maxlength')).toBe('1000');
    expect(dlg.querySelector('.p86-wor-reason').getAttribute('placeholder'))
      .toBe('e.g. Bldg 784 Side A: rail post is still loose. Re-photo tread 3 on Bldg 790.');
    expect(textOf(dlg)).toContain('The crew sees this at the top of their link, and whoever the link was emailed to gets it by email. Leave prices out.');
    expect(textOf(dlg)).toContain('Reopen buildings');

    const rows = Array.from(dlg.querySelectorAll('.p86-wor-rrow'));
    expect(rows.map((x) => x.getAttribute('data-task'))).toEqual(['t1', 't2', 't3']);
    const [r1, r2, r3] = rows.map((x) => x.querySelector('.p86-wor-rpick'));
    expect([r1.checked, r2.checked, r3.checked]).toEqual([false, false, true]);
    expect(r3.disabled).toBe(true);
    expect(textOf(rows[2])).toContain('already not finished');
    expect(rows[2].querySelector('.p86-wor-rnote').value).toBe('Stringer not started');
    expect(rows[0].querySelector('.p86-wor-rnote').getAttribute('placeholder')).toBe('Note for this building (optional)');
    const hint = dlg.querySelector('.p86-wor-hint');
    expect(textOf(hint)).toBe('No buildings will be reopened. The crew marks the work complete again once it’s fixed.');
    setChecked(env.win, r2, true);
    expect(textOf(hint)).toBe('Reopened buildings go back to not finished: the crew adds a new completion photo and marks each one complete again. Buildings you don’t reopen stay done.');
    rows[1].querySelector('.p86-wor-rnote').value = 'Tread 1 cracked';
    expect(textOf(dlg.querySelector('.p86-wor-dlg-cancel'))).toBe('Keep reviewing');

    dlg.querySelector('.p86-wor-reason').value = 'Two buildings need another pass.';
    click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
    await flush();
    expect(env.calls[0].body).toEqual({
      expected_status: 'work_complete',
      reason: 'Two buildings need another pass.',
      reopen_tasks: [{ id: 't2', note: 'Tread 1 cracked' }, { id: 't3', note: 'Stringer not started' }],
    });
    expect(ctx.toast).toHaveBeenCalledWith('Sent back to the crew. No crew link has an email address, so tell the crew directly.', 'success');
  });

  test('Keep reviewing closes the dialog and leaves the sheet open, with no request', async () => {
    const env = boot();
    const ctx = ctxFor(env.win, workCompleteR());
    const sheet = await openSheet(env, ctx);
    click(env.win, sheet.querySelector('.p86-wor-sendback'));
    click(env.win, dialog(env.doc).querySelector('.p86-wor-dlg-cancel'));
    expect(dialog(env.doc)).toBeNull();
    expect(env.doc.querySelector('.p86-wor-sheet')).not.toBeNull();
    // Escape closes the dialog first, then the sheet.
    click(env.win, sheet.querySelector('.p86-wor-cancel'));
    env.doc.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog(env.doc)).toBeNull();
    expect(env.doc.querySelector('.p86-wor-sheet')).not.toBeNull();
    env.doc.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(env.doc.querySelector('.p86-wor-sheet')).toBeNull();
    expect(env.api.setStatus).not.toHaveBeenCalled();
  });

  test('toast wording for reopened and link recipients', () => {
    const { WOR } = boot();
    const ctx = { t: { id: 'st_1', status: 'work_complete' }, toast: jest.fn() };
    WOR.afterStatus(ctx, { send_back: { reopened: 3, crew_emailing: 2 } }, 'work_complete', 'in_progress');
    WOR.afterStatus(ctx, { send_back: { reopened: 0, crew_emailing: 1 } }, 'work_complete', 'in_progress');
    WOR.afterStatus(ctx, { ok: true }, 'in_progress', 'scheduled');
    expect(ctx.toast.mock.calls).toEqual([
      ['Sent back to the crew. 3 buildings reopened. Emailing 2 link recipients.', 'success'],
      ['Sent back to the crew. Emailing the link recipient.', 'success'],
    ]);
  });
});

describe('cancel', () => {
  test('requires a reason, then sends it with the status the sheet opened on', async () => {
    const env = boot({ answers: [{ ok: true, ticket: { id: 'st_1', status: 'cancelled' } }] });
    const ctx = ctxFor(env.win, workCompleteR());
    const sheet = await openSheet(env, ctx);
    click(env.win, sheet.querySelector('.p86-wor-cancel'));
    const dlg = dialog(env.doc);
    expect(textOf(dlg.querySelector('.p86-st-modal-head'))).toBe('Cancel this work order?');
    expect(textOf(dlg)).toContain('The work stops and the crew link shows it as cancelled. You can reopen it later.');
    expect(textOf(dlg)).toContain('Why is it being cancelled? *');
    expect(textOf(dlg)).toContain('Office only — this goes on the Progress list, not the crew link.');
    const ok = dlg.querySelector('.p86-wor-dlg-ok');
    expect(textOf(ok)).toBe('Cancel work order');
    expect(ok.classList.contains('danger')).toBe(true);
    expect(textOf(dlg.querySelector('.p86-wor-dlg-cancel'))).toBe('Keep it');

    click(env.win, ok);
    await flush();
    expect(env.api.setStatus).not.toHaveBeenCalled();
    expect(textOf(dlg.querySelector('.p86-wor-err'))).toBe('Say why this work order is being cancelled.');

    dlg.querySelector('.p86-wor-reason').value = 'Owner sold the building.';
    click(env.win, ok);
    await flush();
    expect(env.calls).toEqual([{ id: 'st_1', status: 'cancelled', body: { expected_status: 'work_complete', reason: 'Owner sold the building.' } }]);
    expect(ctx.toast).toHaveBeenCalledWith('Work order cancelled.', 'success');
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('approve', () => {
  test('copy_scope is on by default when the approved scope is empty', async () => {
    const env = boot({ answers: [{ ok: true, ticket: { id: 'st_1', status: 'approved' } }] });
    const ctx = ctxFor(env.win, workCompleteR());
    const sheet = await openSheet(env, ctx);
    setChecked(env.win, sheet.querySelector('.p86-wor-card[data-task="t2"] .p86-wor-pick-box'), true);
    click(env.win, sheet.querySelector('.p86-wor-approve'));
    const dlg = dialog(env.doc);
    expect(textOf(dlg.querySelector('.p86-st-modal-head'))).toBe('Approve this work order?');
    expect(textOf(dlg)).toContain('1 building isn’t finished.');
    expect(textOf(dlg)).toContain('1 building has no completion photo.');
    expect(textOf(dlg)).toContain('You marked 1 building to send back. Approving ignores that.');
    const copy = dlg.querySelector('.p86-wor-copy');
    expect(copy.checked).toBe(true);
    expect(textOf(copy.closest('label'))).toBe('Copy the proposed scope into the approved scope');
    expect(textOf(dlg)).toContain('Note for the timeline (optional)');
    expect(textOf(dlg.querySelector('.p86-wor-dlg-cancel'))).toBe('Keep reviewing');
    dlg.querySelector('.p86-wor-reason').value = 'Looks good.';
    click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
    await flush();
    expect(env.calls).toEqual([{ id: 'st_1', status: 'approved', body: { expected_status: 'work_complete', reason: 'Looks good.', copy_scope: true } }]);
    expect(ctx.toast).toHaveBeenCalledWith('Work order approved. The approved scope was filled in from the proposed scope.', 'success');
  });

  test('copy_scope is off by default when the approved scope has text, and absent with no proposed scope', async () => {
    const env = boot({ answers: [{ ok: true, ticket: {} }, { ok: true, ticket: {} }] });
    const ctx = ctxFor(env.win, workCompleteR({ scope_approved: 'Signed scope v1' }));
    let sheet = await openSheet(env, ctx);
    click(env.win, sheet.querySelector('.p86-wor-approve'));
    let dlg = dialog(env.doc);
    const copy = dlg.querySelector('.p86-wor-copy');
    expect(copy.checked).toBe(false);
    expect(textOf(copy.closest('label'))).toBe('Replace the approved scope with the proposed scope');
    click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
    await flush();
    expect(env.calls[0].body).toEqual({ expected_status: 'work_complete', reason: '', copy_scope: false });
    expect(ctx.toast).toHaveBeenCalledWith('Work order approved.', 'success');

    const r2 = workCompleteR({ scope_proposed: '   ' });
    r2.tasks.forEach((k) => { k.status = 'done'; k.photos = [photo('c' + k.id, 'completion')]; });
    const ctx2 = ctxFor(env.win, r2);
    sheet = await openSheet(env, ctx2);
    click(env.win, sheet.querySelector('.p86-wor-approve'));
    dlg = dialog(env.doc);
    expect(dlg.querySelector('.p86-wor-copy')).toBeNull();
    expect(textOf(dlg)).toContain('All 3 buildings are done, with 3 completion photos.');
    click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
    await flush();
    expect(env.calls[1].body).toEqual({ expected_status: 'work_complete', reason: '', copy_scope: false });
  });
});

describe('errors from the status door', () => {
  test('a 409 toasts, closes the sheet and re-reads the work order', async () => {
    await checkStaleClosesAndRefreshes(SRC);
  });

  test('any other refusal toasts and keeps the dialog open with its buttons back', async () => {
    const env = boot({ answers: [httpError(403, 'A ticket cannot move from closed to approved.')] });
    const ctx = ctxFor(env.win, workCompleteR());
    const sheet = await openSheet(env, ctx);
    click(env.win, sheet.querySelector('.p86-wor-approve'));
    const dlg = dialog(env.doc);
    click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
    await flush();
    expect(ctx.toast).toHaveBeenCalledWith('A ticket cannot move from closed to approved.', 'error');
    expect(dialog(env.doc)).toBe(dlg);
    expect(dlg.querySelector('.p86-wor-dlg-ok').disabled).toBe(false);
    expect(dlg.querySelector('.p86-wor-dlg-cancel').disabled).toBe(false);
    expect(env.doc.querySelector('.p86-wor-sheet')).not.toBeNull();
    expect(ctx.refresh).not.toHaveBeenCalled();
  });

  test('MUTANT: treating a 409 like any other error leaves a stale sheet up', async () => {
    const src = mutant('        if (stale) {', '        if (false) {');
    await mustFail(() => checkStaleClosesAndRefreshes(src));
  });
});

// ── Move to… through the registry ───────────────────────────────────────
describe('Move to… reason dialogs (confirmMove)', () => {
  test('picking Cancelled opens the cancel dialog and sends the reason with expected_status', async () => {
    await checkMoveToCancelledSendsReason(SRC);
  });

  test('MUTANT: without confirmMove registered, Move to… sends no reason', async () => {
    const src = mutant('      confirmMove: confirmMoveHook,\n', '');
    // The mutant really does send a reason-less move: no dialog, no reason.
    const env = boot({ src, answers: [{ ok: true, ticket: {} }] });
    const r = workCompleteR({ id: 'st_2', status: 'in_progress' });
    await hostMove(env, ctxFor(env.win, r), 'cancelled');
    expect(env.calls).toEqual([{ id: 'st_2', status: 'cancelled', body: { expected_status: 'in_progress' } }]);
    await mustFail(() => checkMoveToCancelledSendsReason(src));
  });

  test('MUTANT: a blank send-back reason reaching the API is caught', async () => {
    const src = mutant("          dlg.error('Say what needs fixing.', reason.box);\n          return null;\n", "          dlg.error('Say what needs fixing.', reason.box);\n");
    await mustFail(() => checkSendBackNeedsReason(src));
  });

  test('dismissing resolves null and nothing is sent', async () => {
    const env = boot();
    const ctx = ctxFor(env.win, workCompleteR({ status: 'in_progress' }));
    const out = await hostMove(env, ctx, 'cancelled', async () => {
      click(env.win, dialog(env.doc).querySelector('.p86-wor-dlg-cancel'));
    });
    expect(out.outcome).toBe('dismissed');
    const esc = await hostMove(env, ctx, 'cancelled', async () => {
      env.doc.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(esc.outcome).toBe('dismissed');
    expect(env.api.setStatus).not.toHaveBeenCalled();
  });

  test('moves without a dialog answer undefined, so the host sends them as before', () => {
    const env = boot();
    const ctx = ctxFor(env.win, workCompleteR({ status: 'in_progress' }));
    expect(env.win.p86StExt.first('confirmMove', ctx, 'scheduled')).toBeUndefined();
    expect(env.win.p86StExt.first('confirmMove', ctx, 'work_complete')).toBeUndefined();
    expect(env.doc.querySelector('.p86-wor-dlg')).toBeNull();
  });

  test('Work complete to In progress opens Send back with nothing pre-checked', async () => {
    const env = boot({ answers: [{ ok: true, ticket: {}, send_back: { reopened: 0, crew_emailing: 2 } }] });
    const ctx = ctxFor(env.win, workCompleteR());
    await hostMove(env, ctx, 'in_progress', async () => {
      const dlg = dialog(env.doc);
      expect(dlg.getAttribute('data-dialog')).toBe('send_back');
      expect(Array.from(dlg.querySelectorAll('.p86-wor-rrow')).map((x) => x.getAttribute('data-task'))).toEqual(['t1', 't2']);
      expect(Array.from(dlg.querySelectorAll('.p86-wor-rpick')).some((b) => b.checked)).toBe(false);
      dlg.querySelector('.p86-wor-reason').value = 'Re-photo everything.';
      click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
    });
    expect(env.calls).toEqual([{ id: 'st_1', status: 'in_progress', body: { reason: 'Re-photo everything.', expected_status: 'work_complete' } }]);
    expect(ctx.toast).toHaveBeenCalledWith('Sent back to the crew. Emailing 2 link recipients.', 'success');
  });

  test('Approved from Move to… sends copy_scope and afterStatus says the scope was copied', async () => {
    const env = boot({ answers: [{ ok: true, ticket: {} }] });
    const ctx = ctxFor(env.win, workCompleteR());
    await hostMove(env, ctx, 'approved', async () => {
      const dlg = dialog(env.doc);
      expect(dlg.getAttribute('data-dialog')).toBe('approve');
      click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
    });
    expect(env.calls[0].body).toEqual({ reason: '', copy_scope: true, expected_status: 'work_complete' });
    expect(ctx.toast).toHaveBeenCalledWith('Work order approved. The approved scope was filled in from the proposed scope.', 'success');
  });

  test('reopen and take back approval ask why, with their own wording', async () => {
    const cases = [
      { from: 'closed', to: 'open', title: 'Reopen this work order?', label: 'Why is it being reopened?', ok: 'Reopen', empty: 'Say why this work order is being reopened.' },
      { from: 'cancelled', to: 'open', title: 'Reopen this work order?', label: 'Why is it being reopened?', ok: 'Reopen', empty: 'Say why this work order is being reopened.' },
      { from: 'approved', to: 'work_complete', title: 'Take back the approval?', label: 'Why is the approval being taken back?', ok: 'Take back approval', empty: 'Say why the approval is being taken back.' },
    ];
    for (const c of cases) {
      const env = boot({ answers: [{ ok: true, ticket: {} }] });
      const ctx = ctxFor(env.win, workCompleteR({ status: c.from }));
      await hostMove(env, ctx, c.to, async () => {
        const dlg = dialog(env.doc);
        expect(textOf(dlg.querySelector('.p86-st-modal-head'))).toBe(c.title);
        expect(textOf(dlg)).toContain(c.label + ' *');
        expect(textOf(dlg)).toContain('This goes on the Progress list.');
        expect(textOf(dlg.querySelector('.p86-wor-dlg-ok'))).toBe(c.ok);
        click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
        await flush();
        expect(textOf(dlg.querySelector('.p86-wor-err'))).toBe(c.empty);
        dlg.querySelector('.p86-wor-reason').value = 'Customer called back.';
        click(env.win, dlg.querySelector('.p86-wor-dlg-ok'));
      });
      expect(env.calls).toEqual([{ id: 'st_1', status: c.to, body: { reason: 'Customer called back.', expected_status: c.from } }]);
    }
  });
});

// ── Progress list wording ───────────────────────────────────────────────
describe('eventText', () => {
  function ev(kind, detail) {
    return { kind, actor_kind: 'user', detail: JSON.stringify(detail), created_at: '2026-09-15T14:00:00.000Z' };
  }
  const titles = { t1: 'Bldg 784 — Side A: rail post', t2: 'Bldg 786 & Co — Side B', t3: 'Bldg 790' };
  const titleFor = (id) => titles[id] || '';

  test('send back, approve, unapprove, cancel and reopen', () => {
    const { WOR } = boot();
    expect(WOR.eventText(ev('status_changed', {
      from: 'work_complete', to: 'in_progress', action: 'send_back', note: 'Post is loose',
      buildings: [{ task_id: 't1', title: 'Bldg 784 — old', note: null, reopened: true }, { task_id: 't3', title: 'Bldg 790', note: 'x', reopened: false }],
    }), titleFor)).toBe('sent it back for more work: “Post is loose” · reopened Bldg 784');
    expect(WOR.eventText(ev('status_changed', { from: 'work_complete', to: 'approved', action: 'approve', scope_copied: true, note: 'Nice' }), titleFor))
      .toBe('approved it and copied the proposed scope into the approved scope: “Nice”');
    expect(WOR.eventText(ev('status_changed', { from: 'work_complete', to: 'approved', action: 'approve' }), titleFor)).toBe('approved it');
    expect(WOR.eventText(ev('status_changed', { action: 'unapprove', note: 'Missed a tread' }), titleFor)).toBe('took back the approval: “Missed a tread”');
    expect(WOR.eventText(ev('status_changed', { action: 'cancel', note: 'Sold' }), titleFor)).toBe('cancelled it: “Sold”');
    expect(WOR.eventText(ev('status_changed', { action: 'reopen', note: 'Leak again' }), titleFor)).toBe('reopened it: “Leak again”');
  });

  test('a plain move with a note, with and without the override', () => {
    const { WOR } = boot();
    expect(WOR.eventText(ev('status_changed', { from: 'open', to: 'scheduled', note: 'Crew booked' }), titleFor)).toBe('moved it to Scheduled: “Crew booked”');
    expect(WOR.eventText(ev('status_changed', { from: 'in_progress', to: 'work_complete', note: 'Done enough', override: 'buildings_open', open: 2, total: 5 }), titleFor))
      .toBe('moved it to Work complete with 2 of 5 subtasks still open: “Done enough”');
    // No action and no note: the host's own wording.
    expect(WOR.eventText(ev('status_changed', { from: 'open', to: 'scheduled' }), titleFor)).toBeNull();
    expect(WOR.eventText(ev('status_changed', { to: 'work_complete', reason: 'all_subtasks_done' }), titleFor)).toBeNull();
  });

  test('crew_emailed and sent-back building notes', () => {
    const { WOR } = boot();
    expect(WOR.eventText(ev('crew_emailed', { about: 'send_back', sent: 1, failed: 0 }), titleFor)).toBe('emailed the send-back to the crew link');
    expect(WOR.eventText(ev('crew_emailed', { about: 'send_back', sent: 3, failed: 1 }), titleFor))
      .toBe('emailed the send-back to the crew link (3 people) — 1 could not be emailed');
    expect(WOR.eventText(ev('crew_emailed', { about: 'send_back', sent: 0, failed: 2 }), titleFor))
      .toBe('could not email the send-back to the crew link — tell the crew directly');
    expect(WOR.eventText(ev('subtask_note', { task_id: 't2', note: 'Tread <1>', sent_back: true }), titleFor))
      .toBe('sent back Bldg 786 &amp; Co: “Tread &lt;1&gt;”');
    expect(WOR.eventText(ev('subtask_note', { task_id: 't2', note: 'plain note' }), titleFor)).toBeNull();
    expect(WOR.eventText(ev('photo_added', { task_id: 't1' }), titleFor)).toBeNull();
  });

  test('through the registry with the host helpers: typed text is escaped once', () => {
    const env = boot();
    const helpers = {
      esc: (s) => String(s),
      head: (id) => (titles[id] ? titles[id].split(' — ')[0].replace(/&/g, '&amp;') : ''),
      statusLabel: (s) => ({ scheduled: 'Scheduled' }[s] || s),
      detail: { from: 'work_complete', to: 'in_progress', action: 'send_back', note: '<img src=x onerror=alert(1)>', buildings: [{ task_id: 't2', title: 'x', reopened: true }] },
    };
    const out = env.win.p86StExt.first('eventWhat', { kind: 'status_changed', detail: helpers.detail }, helpers);
    expect(out).toBe('sent it back for more work: “&lt;img src=x onerror=alert(1)&gt;” · reopened Bldg 786 &amp; Co');
    expect(out).not.toContain('<img');
  });
});

// ── Source rules ────────────────────────────────────────────────────────
describe('source rules', () => {
  const norm = SRC.replace(/\r\n/g, '\n');
  test('CRLF line endings, instant-only date helpers, no native dialogs', () => {
    expect(SRC.includes('\r\n')).toBe(true);
    expect(SRC.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(norm).not.toMatch(/function\s+(fmtDate\w*|fmtDay\w*|formatDate\w*|todayISO)\s*\(/);
    expect(norm).toMatch(/function fmtWhen\(/);
    expect(norm).toMatch(/function fmtWhenDay\(/);
    expect(norm).not.toMatch(/window\.(confirm|prompt|alert)\s*\(/);
    expect(norm).not.toMatch(/\bp86Confirm\s*\(/);
    // No money on anything this module shows.
    expect(norm).not.toMatch(/\b(price|unitCost|contractAmount|amount|total_cost)\b/i);
  });

  test('the stylesheet is CRLF and puts the sheet under the dialogs', () => {
    const css = fs.readFileSync(path.join(ROOT, 'css', 'work-order-review.css'), 'utf8');
    expect(css.includes('\r\n')).toBe(true);
    expect(css.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(css).toMatch(/\.p86-wor-back \{[^}]*z-index: 1090;/);
    expect(css).toMatch(/grid-template-columns: repeat\(auto-fill, minmax\(280px, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 760px\)/);
  });
});
