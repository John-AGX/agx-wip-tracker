// js/service-ticket-print.js — what the office prints (Work Orders 1.29, B9).
//
// The printable work order is built by the SERVER from named columns (no
// approved scope, internal notes or crew takeoff can reach it), so what is left
// to prove here is the drawing: everything escaped, one tick box per building,
// a materials table with no price column, the sign-off block, the dollar-amount
// warning only when the server found one, and no inline event handler (the
// print window wires its own button). Then the completion report dialog: its
// sentences, who sees Send, the send result, Turn off, and the print window
// being opened inside the click so a popup blocker lets it through.
//
// The REAL file runs: in node for the pure builders, and in jsdom (with
// js/service-ticket-ext.js first, as index.html loads them) for the drives.
// Mutants: a copy of the source in the OS temp dir, CRLF normalised, each
// anchor exactly once or 'anchor not found'.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const PRINT_PATH = path.join(__dirname, '..', 'js', 'service-ticket-print.js');
const EXT_PATH = path.join(__dirname, '..', 'js', 'service-ticket-ext.js');
const PRINT_SRC = fs.readFileSync(PRINT_PATH, 'utf8');
const EXT_SRC = fs.readFileSync(EXT_PATH, 'utf8');

const made = [];
afterAll(() => {
  for (const p of made) {
    try { delete require.cache[require.resolve(p)]; } catch (_) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
  }
});

function writeMutant(src, edits) {
  let out = src.replace(/\r\n/g, '\n');
  for (const [find, replace] of edits) {
    if (out.split(find).length !== 2) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  const p = path.join(os.tmpdir(), '_p86_w4c_print_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  made.push(p);
  return p;
}

const pure = (src) => {
  if (src == null) return require(PRINT_PATH).__test;
  return require(writeMutant(src.text, src.edits)).__test;
};

const BOX_OPEN = '☐';
const BOX_DONE = '☑';

function docFixture(over) {
  return Object.assign({
    v: 1,
    kind: 'work_order',
    org_name: 'AGX <Central>',
    ticket_number: 'ST-0042',
    title: 'Stairs <script>alert(1)</script>',
    status_label: 'In progress',
    priority_label: 'High',
    scheduled_label: 'Sep 18, 2026',
    due_label: 'Sep 20, 2026',
    site: { job_number: 'J-784', name: 'Maple Court', address: '12 Maple Ct', gate_code: '#4411' },
    site_contact: { name: 'Sam Site', phone: '(407) 555-0100' },
    office_contact: { name: 'Paula PM', phone: '(407) 555-0199' },
    scope: 'Replace rail posts <img src=x onerror=alert(2)>\nand treads',
    checklist: [{ text: 'Photos before', done: true }, { text: 'Sweep up', done: false }],
    materials: [{ description: 'Rail post 4x4', qty: '6', unit: 'ea' }],
    buildings: [
      { head: 'Bldg 784', sides: [{ label: 'Side A', items: ['rail post', 'tread 3'] }, { label: 'Side D', items: ['stringer'] }], done: true },
      { head: 'Bldg 790', sides: [{ label: '', items: ['whole stair'] }], done: false },
      { head: 'Bldg <b>12</b>', sides: [], done: false },
    ],
    money_mentions: [],
    printed_label: 'Sep 15, 2026 at 3:10 PM',
  }, over || {});
}

function tableBody(html, cls) {
  const at = html.indexOf('<table class="wo-grid ' + cls + '">');
  if (at < 0) return null;
  return html.slice(at, html.indexOf('</table>', at) + 8);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PRINTABLE WORK ORDER
 * ══════════════════════════════════════════════════════════════════════════*/
describe('workOrderHTML', () => {
  const { workOrderHTML } = pure();

  test('escapes what it prints: title, scope, org, building heads', () => {
    const html = workOrderHTML(docFixture(), { origin: 'https://project86.test' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Stairs &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain('AGX &lt;Central&gt;');
    expect(html).toContain('Bldg &lt;b&gt;12&lt;/b&gt;');
  });

  test('no inline event handler anywhere on the page', () => {
    const html = workOrderHTML(docFixture({ money_mentions: ['Scope of work'] }), { origin: '' });
    const withoutEscaped = html.replace(/&lt;[\s\S]*?&gt;/g, '');
    expect(withoutEscaped).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test('exactly one tick box per building, ticked only for the done ones', () => {
    const table = tableBody(workOrderHTML(docFixture(), {}), 'wo-buildings');
    const boxes = table.match(new RegExp('[' + BOX_OPEN + BOX_DONE + ']', 'g'));
    expect(boxes).toEqual([BOX_DONE, BOX_OPEN, BOX_OPEN]);
    expect(table).toContain('Side A: rail post; tread 3<br>Side D: stringer');
    expect(table).toContain('<th>Building</th><th>Work</th><th>Initials</th>');
  });

  test('the materials table has Qty, Unit and Material only — no price anywhere', () => {
    const html = workOrderHTML(docFixture(), {});
    const table = tableBody(html, 'wo-materials');
    expect(table).toContain('<thead><tr><th>Qty</th><th>Unit</th><th>Material</th></tr></thead>');
    for (const word of ['Price', 'Cost', 'Total', '$', 'Amount']) expect(table).not.toContain(word);
    expect(html).not.toContain('$');
  });

  test('the facts, the scope, the checklist, the notes lines and the sign-off captions', () => {
    const html = workOrderHTML(docFixture(), {});
    for (const text of ['WORK ORDER', 'ST-0042', 'Printed Sep 15, 2026 at 3:10 PM', 'J-784 · Maple Court', '12 Maple Ct',
      '#4411', 'Sep 18, 2026', 'Sep 20, 2026', 'High', 'Sam Site · (407) 555-0100', 'Paula PM · (407) 555-0199',
      'Scope of work', 'Checklist', 'Notes', 'Work completed by', 'Signature', 'Checked for AGX &lt;Central&gt;']) {
      expect(html).toContain(text);
    }
    expect(html.match(/<span class="wo-box">/g)).toHaveLength(2);
    expect(html.match(/<div class="wo-lines">(<div><\/div>){5}<\/div>/)).not.toBeNull();
  });

  test('empty sections: no Checklist / Materials / Buildings headings, "—" for missing facts, no "undefined"', () => {
    const html = workOrderHTML({ title: 'Bare' }, {});
    expect(html).not.toContain('<h2>Checklist</h2>');
    expect(html).not.toContain('<h2>Materials</h2>');
    expect(html).not.toContain('<h2>Buildings</h2>');
    expect(html).toContain('No scope written.');
    expect(html).toContain('<th>Gate code</th><td>—</td>');
    expect(html).not.toMatch(/undefined|null/);
  });

  test('the dollar-amount note shows only when the server found a mention', () => {
    const note = 'The scope mentions a dollar amount. Check it before you hand this to a crew.';
    expect(workOrderHTML(docFixture({ money_mentions: [] }), {})).not.toContain(note);
    expect(workOrderHTML(docFixture({ money_mentions: ['Scope of work'] }), {})).toContain(note);
  });

  test('MUTANT: an unescaped title puts the script on the page', () => {
    const mut = pure({ text: PRINT_SRC, edits: [["'<h1>' + esc(d.title || 'Work order') + '</h1>'", "'<h1>' + (d.title || 'Work order') + '</h1>'"]] });
    expect(mut.workOrderHTML(docFixture(), {})).toContain('<h1>Stairs <script>alert(1)</script></h1>');
  });

  test('MUTANT: the money note shown every time', () => {
    const mut = pure({ text: PRINT_SRC, edits: [["(money ? '<span class=\"wo-money\"", "(true ? '<span class=\"wo-money\""]] });
    expect(mut.workOrderHTML(docFixture({ money_mentions: [] }), {})).toContain('The scope mentions a dollar amount.');
  });

  test('MUTANT: an inline print handler is caught', () => {
    const mut = pure({ text: PRINT_SRC, edits: [[
      "'<button type=\"button\" id=\"p86woPrint\">Print / Save PDF</button>'",
      "'<button type=\"button\" id=\"p86woPrint\" onclick=\"window.print()\">Print / Save PDF</button>'"]] });
    expect(mut.workOrderHTML(docFixture(), {})).toMatch(/\son[a-z]+\s*=/i);
  });

  test('MUTANT: the done flag ignored and every building prints unticked', () => {
    const mut = pure({ text: PRINT_SRC, edits: [["'<tr><td class=\"wo-tick\">' + (b && b.done ? BOX_DONE : BOX_OPEN)", "'<tr><td class=\"wo-tick\">' + BOX_OPEN"]] });
    const boxes = tableBody(mut.workOrderHTML(docFixture(), {}), 'wo-buildings').match(new RegExp('[' + BOX_OPEN + BOX_DONE + ']', 'g'));
    expect(boxes).toEqual([BOX_OPEN, BOX_OPEN, BOX_OPEN]);
  });
});

describe('completionShellHTML', () => {
  const { completionShellHTML } = pure();

  test('the report stylesheets, an escaped bar, the renderer body, and the Print button waits for photos', () => {
    const html = completionShellHTML({ title: 'Completion report — <x>', org_name: 'AGX & Co', project_name: 'J-784 · Maple' },
      '<div class="p86-report-preview-paper">BODY</div>', { origin: 'https://project86.test' });
    expect(html).toContain('<link rel="stylesheet" href="https://project86.test/css/report-paper.css?v=2">');
    expect(html).toContain('<link rel="stylesheet" href="https://project86.test/css/report-style-packs.css?v=2">');
    expect(html).toContain('<title>Completion report — &lt;x&gt;</title>');
    expect(html).toContain('AGX &amp; Co');
    expect(html).toContain('<div id="p86crDoc"><div class="p86-report-preview-paper">BODY</div></div>');
    expect(html).toContain('id="p86crPrint" disabled>Loading photos…</button>');
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE COMPLETION REPORT DIALOG, PURE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the completion report dialog wording', () => {
  const t = pure();
  const summary = (over) => Object.assign({
    approved: { name: 'Paula PM', at_label: 'Sep 15, 2026 at 3:10 PM' }, sendable: true,
    buildings_total: 3, buildings_done: 2, before_photos: 4, completion_photos: 5,
    missing_completion: [], money_mentions: [], notes_included: true,
  }, over || {});

  test('approved, and not yet approved', () => {
    expect(t.approvalLine(summary())).toBe('Approved by Paula PM on Sep 15, 2026 at 3:10 PM.');
    expect(t.approvalLine(summary({ approved: { name: null, at_label: 'Sep 15, 2026' } }))).toBe('Approved on Sep 15, 2026.');
    expect(t.approvalLine(summary({ approved: null, sendable: false })))
      .toBe('This work order hasn\'t been approved yet. You can print a draft; it can be sent to the property manager once the work is approved.');
  });

  test('counts, missing completion photos and the money note', () => {
    const one = t.modalBodyHTML({ r: { summary: summary({ missing_completion: ['Bldg 12'], money_mentions: ['Scope of work'] }), shares: null }, includeNotes: true });
    expect(one).toContain('2 of 3 buildings finished · 4 before and 5 completion photos');
    expect(one).toContain('1 building has no completion photo: Bldg 12.');
    expect(one).toContain('Scope of work mentions a dollar amount. Whoever you send this to will see it.');
    const two = t.modalBodyHTML({ r: { summary: summary({ missing_completion: ['Bldg 12', 'Bldg 14'], money_mentions: ['Scope of work', 'Bldg 12 — crew notes'] }), shares: null } });
    expect(two).toContain('2 buildings have no completion photo: Bldg 12, Bldg 14.');
    expect(two).toContain('Scope of work and Bldg 12 — crew notes mention a dollar amount.');
  });

  test('Send shows only when the server sent shares (write access); not approved means disabled with the reason', () => {
    const reader = t.modalBodyHTML({ r: { summary: summary(), shares: null } });
    expect(reader).not.toContain('Send to the property manager');
    const writer = t.modalBodyHTML({ r: { summary: summary({ approved: null, sendable: false }), shares: [] } });
    expect(writer).toContain('Send to the property manager');
    expect(writer).toContain('placeholder="name@property.com"');
    expect(writer).toContain('Their name (optional)');
    expect(writer).toMatch(/<button type="button" class="ee-btn primary p86-st-cr-sendgo" disabled title="Approve the work order first">Send report<\/button>/);
    expect(writer).toContain('The link works for 30 days and you can turn it off.');
    const ready = t.modalBodyHTML({ r: { summary: summary(), shares: [] } });
    expect(ready).toMatch(/p86-st-cr-sendgo">Send report<\/button>/);
  });

  test('the sent list: who, state, views, expiry, and Turn off only while a link is live', () => {
    const rows = [
      { id: 'rs1', recipient_name: 'Pat <PM>', recipient_email: 'pat@x.test', state: 'opened', view_count: 1, expires_label: 'Oct 15, 2026' },
      { id: 'rs2', recipient_name: null, recipient_email: 'lee@x.test', state: 'revoked', view_count: 0, expires_label: 'Oct 1, 2026' },
      { id: 'rs3', recipient_name: null, recipient_email: null, state: 'sent', view_count: 3, expires_label: 'Oct 2, 2026' },
    ];
    const html = t.modalBodyHTML({ r: { summary: summary(), shares: rows } });
    expect(html).toContain('Pat &lt;PM&gt; · Opened · 1 view · expires Oct 15, 2026');
    expect(html).toContain('lee@x.test · Turned off · 0 views · expires Oct 1, 2026');
    expect(html).toContain('Link only · Sent · 3 views · expires Oct 2, 2026');
    expect(html.match(/data-share-off="/g)).toHaveLength(2);
    expect(html).not.toContain('data-share-off="rs2"');
  });

  test('the send result, for an email that went, one that did not, and a link only', () => {
    const link = 'https://project86.test/r/' + 'a'.repeat(64);
    expect(t.resultHTML({ link, email_sent: true }, 'pm@x.test')).toContain('Emailed to pm@x.test.');
    expect(t.resultHTML({ link, email_sent: false }, 'pm@x.test')).toContain('The email didn&#39;t send — copy the link instead.');
    const only = t.resultHTML({ link, email_sent: false }, '');
    expect(only).toContain('Copy this link and send it yourself.');
    expect(only).toContain('value="' + link + '"');
    expect(only).toContain('Copy this now: it is stored only as a hash, so it cannot be shown again.');
  });

  test('timeline wording', () => {
    expect(t.eventWhat({ kind: 'completion_report_sent', detail: { emailed: true } })).toBe('sent the completion report by email');
    expect(t.eventWhat({ kind: 'completion_report_sent', detail: '{"emailed":false}' })).toBe('made a completion report link');
    expect(t.eventWhat({ kind: 'completion_report_link_off', detail: {} })).toBe('turned a completion report link off');
    expect(t.eventWhat({ kind: 'status_changed', detail: {} })).toBeNull();
  });

  test('MUTANT: the send form shown to a reader', () => {
    const mut = pure({ text: PRINT_SRC, edits: [['    if (shares) {\n      var sendable', '    if (true) {\n      shares = shares || [];\n      var sendable']] });
    expect(mut.modalBodyHTML({ r: { summary: summary(), shares: null } })).toContain('Send to the property manager');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IN A PAGE
 * ══════════════════════════════════════════════════════════════════════════*/
const flush = () => new Promise((r) => setTimeout(r, 0));

// Every page and print window a test opened is closed after it, which also
// stops the 8-second photo wait's timer.
const windows = [];
afterEach(() => {
  while (windows.length) {
    try { windows.pop().close(); } catch (_) { /* already closed */ }
  }
});

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><body><div class="p86-st-detail"></div></body></html>', {
    runScripts: 'outside-only', url: 'https://project86.test/jobs/j1/job-service-tickets',
  });
  const win = dom.window;
  windows.push(win);
  const calls = [];
  const toasts = [];
  const children = [];
  win.p86Toast = (msg, kind) => toasts.push([msg, kind]);
  win.open = jest.fn(() => {
    if (o.blockPopups) return null;
    const child = new JSDOM('<!doctype html><html><body></body></html>', { url: 'about:blank' }).window;
    child.print = jest.fn();
    children.push(child);
    windows.push(child);
    return child;
  });
  const answer = (name, payload) => {
    calls.push([name, payload]);
    const h = o.api && o.api[name];
    return h ? h(payload) : Promise.resolve({});
  };
  win.p86Api = {
    serviceTickets: {
      workOrderPrint: (id) => answer('workOrderPrint', { id }),
      completionReport: (id, q) => answer('completionReport', { id, includeNotes: q && q.includeNotes }),
      sendCompletionReport: (id, body) => answer('sendCompletionReport', { id, body }),
      revokeCompletionReport: (id, shareId) => answer('revokeCompletionReport', { id, shareId }),
    },
  };
  if (o.confirm !== undefined) win.p86Confirm = o.confirm;
  win.p86ReportDocument = {
    render: (doc) => '<div class="p86-report-preview-paper"><h1>' + String(doc.title) + '</h1>' +
      (doc.withPhoto ? '<img class="shot" src="https://project86.test/x.jpg" alt="">' : '') + '</div>',
    wire: jest.fn(),
  };
  win.eval(EXT_SRC);
  win.eval(o.src || PRINT_SRC);
  return { win, doc: win.document, calls, toasts, children };
}

function ctxFor(win, over) {
  return Object.assign({ ticketId: 'st_1', t: { id: 'st_1', title: 'Stairs', status: 'approved', job_id: 'j1' }, r: {}, canEdit: true, refresh: jest.fn(() => Promise.resolve()), toast: undefined }, over || {});
}

function mountDetail(env, ctx) {
  const d = env.doc.querySelector('.p86-st-detail');
  const secs = env.win.p86StExt.collect('detailSections', ctx);
  const actions = [].concat.apply([], secs).filter((s) => s.slot === 'actions');
  d.innerHTML = '<div class="p86-st-actions">' + actions.map((s) => s.html).join('') + '</div>';
  d._st = ctx;
  env.win.p86StExt.collect('wireDetail', d, ctx);
  return d;
}

function click(win, el) {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('registration and the Print / PDF menu', () => {
  test('registers as ticket-print, order 60, with the menu in the actions slot and the timeline wording', () => {
    const env = boot();
    const entry = env.win.p86StExt.list().find((e) => e.name === 'ticket-print');
    expect(entry && entry.order).toBe(60);
    const secs = env.win.p86StExt.collect('detailSections', ctxFor(env.win));
    expect(secs[0]).toEqual([{ key: 'print-menu', slot: 'actions', html: expect.stringContaining('>Print / PDF</button>') }]);
    expect(env.win.p86StExt.collect('eventWhat', { kind: 'completion_report_link_off' }, {})).toEqual(['turned a completion report link off']);
    expect(env.win.p86ServiceTicketPrint.openCompletionReport).toEqual(expect.any(Function));
  });

  test('the menu offers both documents, and the work order window opens INSIDE the click', async () => {
    let release;
    const env = boot({ api: { workOrderPrint: () => new Promise((r) => { release = r; }) } });
    const d = mountDetail(env, ctxFor(env.win));
    click(env.win, d.querySelector('.p86-st-print'));
    const items = Array.from(d.querySelectorAll('[data-print]')).map((b) => b.textContent);
    expect(items).toEqual(['Work order — for the crew, no prices', 'Completion report — photos for the property manager']);
    click(env.win, d.querySelector('[data-print="work_order"]'));
    // Synchronously, before the document has even been fetched.
    expect(env.win.open).toHaveBeenCalledTimes(1);
    expect(env.win.open).toHaveBeenCalledWith('', '_blank');
    expect(d.querySelector('.p86-st-print-menu')).toBeNull();
    await flush();
    expect(env.children[0].document.body.textContent).toContain('Preparing…');
    release({ document: docFixture({ title: 'Stairs' }) });
    await flush(); await flush();
    const child = env.children[0];
    expect(child.document.body.textContent).toContain('WORK ORDER');
    child.document.getElementById('p86woPrint').dispatchEvent(new child.MouseEvent('click', { bubbles: true }));
    expect(child.print).toHaveBeenCalledTimes(1);
    expect(env.calls).toEqual([['workOrderPrint', { id: 'st_1' }]]);
  });

  test('a blocked popup says how to fix it and fetches nothing', async () => {
    const env = boot({ blockPopups: true });
    const d = mountDetail(env, ctxFor(env.win));
    click(env.win, d.querySelector('.p86-st-print'));
    click(env.win, d.querySelector('[data-print="work_order"]'));
    await flush();
    expect(env.toasts).toEqual([['Allow pop-ups to print.', 'error']]);
    expect(env.calls).toEqual([]);
  });

  test('a failed build says so in the window', async () => {
    const env = boot({ api: { workOrderPrint: () => Promise.reject(Object.assign(new Error('Service ticket not found'), { status: 404 })) } });
    env.win.p86ServiceTicketPrint.openWorkOrder({ id: 'st_1' });
    await flush(); await flush();
    expect(env.children[0].document.body.textContent).toContain('Could not build the work order');
    expect(env.children[0].document.body.textContent).toContain('Service ticket not found');
  });

  test('MUTANT: opening the window after the click has returned is what a popup blocker stops', async () => {
    const env = boot({
      src: fs.readFileSync(writeMutant(PRINT_SRC, [['    var w = openWindow(ctx);\n    if (!w) return Promise.resolve(null);\n    writeWindow(w, messagePage(',
        '    var w = null;\n    return Promise.resolve().then(function () { openWindow(ctx); });\n    writeWindow(w, messagePage(']]), 'utf8'),
    });
    const d = mountDetail(env, ctxFor(env.win));
    click(env.win, d.querySelector('.p86-st-print'));
    click(env.win, d.querySelector('[data-print="work_order"]'));
    expect(env.win.open).toHaveBeenCalledTimes(0);
    await flush();
  });
});

describe('the completion report dialog in a page', () => {
  const report = (over) => Object.assign({
    document: { title: 'Completion report — Stairs', org_name: 'AGX', sections: [] },
    summary: {
      approved: { name: 'Paula PM', at_label: 'Sep 15, 2026 at 3:10 PM' }, sendable: true,
      buildings_total: 2, buildings_done: 2, before_photos: 2, completion_photos: 2,
      missing_completion: [], money_mentions: [], notes_included: true,
    },
    shares: [{ id: 'rs_live', recipient_name: 'Pat', recipient_email: 'pat@x.test', state: 'sent', view_count: 0, expires_label: 'Oct 15, 2026' }],
  }, over || {});

  test('opens, reads with notes, and the notes toggle re-reads without them', async () => {
    const env = boot({ api: { completionReport: () => Promise.resolve(report()) } });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    const modal = env.doc.querySelector('.p86-st-cr-modal');
    expect(modal.textContent).toContain('Approved by Paula PM on Sep 15, 2026 at 3:10 PM.');
    const box = modal.querySelector('.p86-st-cr-notes-in');
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    await flush(); await flush();
    expect(env.calls.map((c) => c[1].includeNotes)).toEqual([true, false]);
    expect(env.doc.querySelector('.p86-st-cr-notes-in').checked).toBe(false);
  });

  test('Print / Save PDF opens the window in the click and renders the report through the shared renderer', async () => {
    const env = boot({ api: { completionReport: () => Promise.resolve(report()) } });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    click(env.win, env.doc.querySelector('.p86-st-cr-print'));
    expect(env.win.open).toHaveBeenCalledTimes(1);
    const child = env.children[0];
    expect(child.document.getElementById('p86crDoc').innerHTML).toContain('Completion report — Stairs');
    expect(env.win.p86ReportDocument.wire).toHaveBeenCalledTimes(1);
    const btn = child.document.getElementById('p86crPrint');
    // No photo still loading, so the button is ready at once.
    expect([btn.textContent, btn.disabled]).toEqual(['Print / Save PDF', false]);
    btn.dispatchEvent(new child.MouseEvent('click', { bubbles: true }));
    expect(child.print).toHaveBeenCalledTimes(1);
  });

  test('the print window\'s button waits for a photo still loading, then prints', async () => {
    const env = boot({ api: { completionReport: () => Promise.resolve(report({ document: { title: 'With photo', withPhoto: true, sections: [] } })) } });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    click(env.win, env.doc.querySelector('.p86-st-cr-print'));
    const child = env.children[0];
    const btn = child.document.getElementById('p86crPrint');
    expect([btn.textContent, btn.disabled]).toEqual(['Loading photos…', true]);
    child.document.querySelector('img.shot').dispatchEvent(new child.Event('load'));
    expect([btn.textContent, btn.disabled]).toEqual(['Print / Save PDF', false]);
  });

  test('MUTANT: a Print button that does not wait prints before the photos are there', async () => {
    const env = boot({
      src: fs.readFileSync(writeMutant(PRINT_SRC, [['    var waiting = imgs.filter(function (img) { return !img.complete; });',
        '    var waiting = [];']]), 'utf8'),
      api: { completionReport: () => Promise.resolve(report({ document: { title: 'With photo', withPhoto: true, sections: [] } })) },
    });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    click(env.win, env.doc.querySelector('.p86-st-cr-print'));
    const btn = env.children[0].document.getElementById('p86crPrint');
    expect(btn.disabled).toBe(false);
  });

  test('Send: email and name go to the server, the result gives the link once, and the list re-reads', async () => {
    const link = 'https://project86.test/r/' + 'b'.repeat(64);
    const env = boot({
      api: {
        completionReport: () => Promise.resolve(report()),
        sendCompletionReport: () => Promise.resolve({ ok: true, link, email_sent: true, email_error: null, share: { id: 'rs_new' } }),
      },
    });
    const ctx = ctxFor(env.win);
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctx);
    await flush(); await flush();
    env.doc.querySelector('.p86-st-cr-email').value = ' pm@property.test ';
    env.doc.querySelector('.p86-st-cr-name').value = 'Pat';
    click(env.win, env.doc.querySelector('.p86-st-cr-sendgo'));
    await flush(); await flush(); await flush();
    expect(env.calls[1]).toEqual(['sendCompletionReport', { id: 'st_1', body: { include_notes: true, email: 'pm@property.test', name: 'Pat' } }]);
    const modal = env.doc.querySelector('.p86-st-cr-modal');
    expect(modal.textContent).toContain('Emailed to pm@property.test.');
    expect(modal.querySelector('.p86-st-cr-link').value).toBe(link);
    expect(env.calls.filter((c) => c[0] === 'completionReport')).toHaveLength(2);
    expect(ctx.refresh).toHaveBeenCalled();
  });

  test('a refused send shows the server\'s own sentence (just_sent)', async () => {
    const sentence = 'A completion report link for this recipient was made a moment ago. Wait a minute before trying again.';
    const env = boot({
      api: {
        completionReport: () => Promise.resolve(report()),
        sendCompletionReport: () => Promise.reject(Object.assign(new Error(sentence), { status: 409, data: { error: sentence, code: 'just_sent' } })),
      },
    });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    click(env.win, env.doc.querySelector('.p86-st-cr-sendgo'));
    await flush(); await flush();
    const err = env.doc.querySelector('.p86-st-cr-err');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe(sentence);
  });

  test('Turn off asks with the destructive spelling, then revokes and re-reads', async () => {
    const confirm = jest.fn(() => Promise.resolve(true));
    const env = boot({ confirm, api: { completionReport: () => Promise.resolve(report()), revokeCompletionReport: () => Promise.resolve({ ok: true }) } });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    click(env.win, env.doc.querySelector('[data-share-off="rs_live"]'));
    await flush(); await flush(); await flush();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmText: 'Turn off', destructive: true, cancelText: 'Keep it' }));
    expect(env.calls.filter((c) => c[0] === 'revokeCompletionReport')).toEqual([['revokeCompletionReport', { id: 'st_1', shareId: 'rs_live' }]]);
    expect(env.calls.filter((c) => c[0] === 'completionReport')).toHaveLength(2);
  });

  // Turn off re-reads the report, and the re-read rebuilds the whole modal
  // body from the module's copy of the form. The address the office typed into
  // the send row above the Sent list lives only in the DOM until something
  // reads it back, so Turn off has to read it back the way Send does.
  test('Turn off keeps the recipient the office had just typed', async () => {
    const env = boot({
      confirm: () => Promise.resolve(true),
      api: { completionReport: () => Promise.resolve(report()), revokeCompletionReport: () => Promise.resolve({ ok: true }) },
    });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    env.doc.querySelector('.p86-st-cr-email').value = 'pm@property.test';
    env.doc.querySelector('.p86-st-cr-name').value = 'Pat Manager';
    click(env.win, env.doc.querySelector('[data-share-off="rs_live"]'));
    await flush(); await flush(); await flush();
    // The body really was rebuilt (a fresh input node), and it carries the
    // typed recipient rather than an empty box.
    expect(env.calls.filter((c) => c[0] === 'completionReport')).toHaveLength(2);
    expect(env.doc.querySelector('.p86-st-cr-email').value).toBe('pm@property.test');
    expect(env.doc.querySelector('.p86-st-cr-name').value).toBe('Pat Manager');
  });

  test('a Turn off the server refuses keeps them too', async () => {
    const env = boot({
      confirm: () => Promise.resolve(true),
      api: {
        completionReport: () => Promise.resolve(report()),
        revokeCompletionReport: () => Promise.reject(new Error('Could not turn that link off')),
      },
    });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    env.doc.querySelector('.p86-st-cr-email').value = 'pm@property.test';
    click(env.win, env.doc.querySelector('[data-share-off="rs_live"]'));
    await flush(); await flush(); await flush();
    expect(env.toasts).toContainEqual(['Could not turn that link off', 'error']);
    expect(env.doc.querySelector('.p86-st-cr-email').value).toBe('pm@property.test');
  });

  test('MUTANT: Turn off that does not read the form back wipes the typed address', async () => {
    const env = boot({
      src: fs.readFileSync(writeMutant(PRINT_SRC, [[
        '    keepTyped(m);\n    var st = api();\n',
        '    var st = api();\n',
      ]]), 'utf8'),
      confirm: () => Promise.resolve(true),
      api: { completionReport: () => Promise.resolve(report()), revokeCompletionReport: () => Promise.resolve({ ok: true }) },
    });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    env.doc.querySelector('.p86-st-cr-email').value = 'pm@property.test';
    click(env.win, env.doc.querySelector('[data-share-off="rs_live"]'));
    await flush(); await flush(); await flush();
    expect(env.doc.querySelector('.p86-st-cr-email').value).toBe('');
  });

  test('Keep it on the Turn off question revokes nothing', async () => {
    const env = boot({ confirm: () => Promise.resolve(false), api: { completionReport: () => Promise.resolve(report()) } });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush(); await flush();
    click(env.win, env.doc.querySelector('[data-share-off="rs_live"]'));
    await flush(); await flush();
    expect(env.calls.filter((c) => c[0] === 'revokeCompletionReport')).toEqual([]);
  });

  test('Escape closes the dialog', async () => {
    const env = boot({ api: { completionReport: () => Promise.resolve(report()) } });
    env.win.p86ServiceTicketPrint.openCompletionReport({ id: 'st_1', title: 'Stairs' }, true, ctxFor(env.win));
    await flush();
    env.doc.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(env.doc.querySelector('.p86-st-cr-back')).toBeNull();
  });
});

describe('house rules for this file', () => {
  test('no date helper names (the server sends labels) and no native dialogs', () => {
    expect(PRINT_SRC).not.toMatch(/function\s+(fmtDate\w*|fmtDay\w*|formatDate\w*|todayISO)\s*\(/);
    expect(PRINT_SRC.replace(/\/\/.*$/gm, '')).not.toMatch(/(^|[^.\w])(alert|confirm|prompt)\s*\(/);
  });

  test('CRLF on disk', () => {
    expect(PRINT_SRC.indexOf('\r\n')).toBeGreaterThan(-1);
  });
});
