/**
 * @jest-environment jsdom
 */
// The takeoff on the crew link, office side and crew side, under the
// "price-free copy" rule.
//
// The heuristic price check could never be airtight, so John decided: on a
// crew link that hides financials (the default) a spreadsheet takeoff is
// NEVER sent as the original file. The server builds a copy holding only
// material, quantity and unit — the same extractor that fills the materials
// list — and stores its lines on crew_takeoff.copy. The original goes only to
// links sent with financial details. PDFs and photos are unchanged: the office
// is asked first, and every link shows the whole file.
//
// Driven through the REAL js/service-tickets.js and the REAL inline script of
// service-ticket-share.html:
//
//   1. The crew picker offers an old .xls again (nothing is read to put it on
//      the link), with a note that it shows only on links sent with financial
//      details. The read-a-takeoff picker still cannot open one.
//   2. The "Takeoff on the crew link" status says which links get what: the
//      copy and its line count, why no copy could be made, or — for a row
//      stored before copies existed — that the file must be picked again.
//      A row without a usable copy never claims a copy, and never claims the
//      whole file shows everywhere.
//   3. The save toast says the same thing in short.
//   4. A PDF or photo is still asked about first; a spreadsheet is not.
//   5. The crew page's Takeoff card names a copy as a materials list with the
//      prices removed, and keeps the Download / Open wording otherwise.
//
// Each guard is also shown to FIRE: the drive is re-run against a copy of the
// shipped source with that guard broken, and the outcome has to come out
// wrong. The files are CRLF on disk, so the source is EOL-normalized before
// mutating, and a mutation that moves no bytes throws.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const TICKETS_SRC = read('js/service-tickets.js');
const SHARE_HTML = read('service-ticket-share.html');
const STYLES = read('css/styles.css');
const JOB_LABEL = require('../js/job-label.js');

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1) throw new Error('MUTATION ANCHOR NOT FOUND: ' + from);
  if (src.indexOf(from, at + from.length) !== -1) throw new Error('MUTATION ANCHOR NOT UNIQUE: ' + from);
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('MUTATION DID NOT CHANGE THE SOURCE: ' + from);
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 8; i++) await tick(); }

// ── Office side ─────────────────────────────────────────────────────────

// The scenario's files: the PM's old estimating export, a real .xlsx, a PDF.
const FILES = [
  { id: 'a_est', where: 'job', kind: 'xls', filename: 'Estimate.xls', size_bytes: 88064 },
  { id: 'a_lr', where: 'job', kind: 'xlsx', filename: 'Lead Report.xlsx', size_bytes: 48213 },
  { id: 'a_pdf', where: 'job', kind: 'pdf', filename: 'Stair plan.pdf', size_bytes: 512000 },
];

const XLS_PROBLEM = "Old .xls files can't be read — save it as .xlsx for a price-free copy.";
const LINES = (n) => Array.from({ length: n }, (_, i) => ({ description: 'Stair tread ' + (i + 1), qty: '4', unit: 'ea' }));
const BASE = { set_at: '2026-09-14T12:00:00.000Z', set_by: 10 };

// What the PUT stores under the new contract, per file.
const STORED = {
  a_est: { attachment_id: 'a_est', filename: 'Estimate.xls', kind: 'xls', ...BASE, copy: null, copy_problem: XLS_PROBLEM },
  a_lr: {
    attachment_id: 'a_lr', filename: 'Lead Report.xlsx', kind: 'xlsx', ...BASE,
    copy: { lines: LINES(12), sheet: 'Lead Report', method: 'sheet', made_at: '2026-09-14T12:00:00.000Z' },
    copy_problem: null,
  },
  a_pdf: { attachment_id: 'a_pdf', filename: 'Stair plan.pdf', kind: 'pdf', ...BASE, copy: null, copy_problem: null },
};

const STATUS = {
  copy12: 'Links that hide financials (the default) get a price-free copy — material, quantity and unit only (12 lines). ' +
    'Links sent with financial details get the original file.',
  xls: "No price-free copy could be made (Old .xls files can't be read — save it as .xlsx for a price-free copy), " +
    'so this file only shows on links sent with financial details.',
  repick: 'Pick this file again to make a price-free copy for the crew link.',
  whole: "The crew link shows this whole file. PDFs and photos can't be checked for prices — make sure it has none.",
};
const TOAST = {
  copy: 'Takeoff shown on the crew link — default links get a price-free copy',
  narrow: 'Takeoff shown on the crew link — only on links sent with financial details',
  plain: 'Takeoff shown on the crew link',
};

function env(src, ticket, opts) {
  opts = opts || {};
  document.body.innerHTML = '<div id="job-service-tickets"></div>';
  window.appState = { currentJobId: 'job_77' };
  window.appData = {
    jobs: [Object.assign({ id: 'job_77', jobNumber: 'M1001', title: 'Latitude stairs' }, opts.readOnly ? { _canEdit: false } : {})],
    leads: [],
  };
  window.p86JobLabel = JOB_LABEL;
  const state = { ticket: ticket, puts: [] };
  window.p86Api = { serviceTickets: {
    list: jest.fn(() => Promise.resolve({ tickets: [state.ticket] })),
    get: jest.fn(() => Promise.resolve({ ticket: JSON.parse(JSON.stringify(state.ticket)), tasks: [], events: [], revisions: [], participants: [] })),
    materialSources: jest.fn(() => Promise.resolve({ files: FILES.slice() })),
    extractMaterials: jest.fn(() => Promise.resolve({ ok: false, error: 'not in this drive' })),
    setCrewTakeoff: jest.fn((id, att) => {
      state.puts.push([id, att]);
      const ct = opts.stored ? opts.stored(att) : (STORED[att] || null);
      state.ticket = Object.assign({}, state.ticket, { crew_takeoff: ct });
      return Promise.resolve({ ok: true, ticket: state.ticket, crew_takeoff: ct });
    }),
  } };
  window.p86Auth = { hasCapability: () => true };
  window.p86Toast = jest.fn();
  window.p86Confirm = jest.fn(() => Promise.resolve(opts.confirm !== false));
  window.alert = jest.fn();
  window.confirm = jest.fn();
  delete window.p86ServiceTickets;
  delete window.renderJobServiceTickets;
  window.eval(src);
  return state;
}

const TICKET = (extra) => Object.assign({
  id: 'st_1', ticket_number: 'WO-0007', title: 'Replace rotted stair treads', status: 'in_progress',
  priority: 'normal', job_id: 'job_77', lead_id: null, materials: [],
}, extra || {});

async function openTicket() {
  window.renderJobServiceTickets('job_77');
  await flush();
  document.querySelector('#job-service-tickets .p86-st-row-head').click();
  await flush();
  return document.querySelector('#job-service-tickets .p86-st-row.is-open .p86-st-detail');
}

function rowFor(pick, filename) {
  return Array.from(pick.querySelectorAll('.p86-wo-pick-row'))
    .find((b) => b.querySelector('.p86-wo-pick-name').textContent === filename);
}

function crewRow() {
  const row = document.querySelector('#job-service-tickets .p86-st-row.is-open .p86-wo-crew');
  return row ? { cls: row.className, status: (row.querySelector('.p86-wo-crew-status') || {}).textContent || null, el: row } : null;
}

// Open the crew picker, look at a row, click it (clearing a disabled
// attribute first, so the handler's own guard is what is proved).
async function drivePick(src, filename, opts) {
  const s = env(src, TICKET(), opts);
  const d = await openTicket();
  d.querySelector('.p86-wo-crew-pick').click();
  await flush();
  const pick = document.getElementById('p86StTakeoffPick');
  const row = rowFor(pick, filename);
  const seen = {
    note: pick.querySelector('.p86-wo-pick-note').textContent,
    disabled: row.disabled,
    cls: row.className,
    meta: row.querySelector('.p86-wo-pick-meta').textContent,
  };
  row.disabled = false;
  row.click();
  await flush();
  seen.puts = s.puts.slice();
  seen.confirmAsked = window.p86Confirm.mock.calls.length;
  seen.confirmArgs = window.p86Confirm.mock.calls[0] ? window.p86Confirm.mock.calls[0][0] : null;
  seen.pickerOpen = !!document.getElementById('p86StTakeoffPick');
  seen.rowDisabledAfter = seen.pickerOpen ? rowFor(document.getElementById('p86StTakeoffPick'), filename).disabled : null;
  seen.toasts = window.p86Toast.mock.calls.map((c) => c.slice());
  seen.crew = crewRow();
  return seen;
}

describe('the crew picker offers an old .xls, and says where it will show', () => {
  test("'Estimate.xls' is pickable with its note; the pick saves with no question and reads as financial-links only", async () => {
    const r = await drivePick(TICKETS_SRC, 'Estimate.xls');
    expect(r.disabled).toBe(false);
    expect(r.cls).toContain('is-narrow');
    expect(r.cls).not.toContain('is-legacy');
    expect(r.meta).toBe('Only on links sent with financial details (no price-free copy from .xls)');
    expect(r.puts).toEqual([['st_1', 'a_est']]);
    expect(r.confirmAsked).toBe(0);
    expect(r.pickerOpen).toBe(false);
    expect(r.toasts).toEqual([[TOAST.narrow]]);
    expect(r.crew.cls).toContain('is-original');
    expect(r.crew.status).toBe(STATUS.xls);
  });

  test('the picker note explains the copy, not price columns', async () => {
    const r = await drivePick(TICKETS_SRC, 'Lead Report.xlsx');
    expect(r.note).toMatch(/price-free copy/);
    expect(r.note).toMatch(/Links sent with financial details get the original/);
    expect(r.note).not.toMatch(/price columns/);
  });

  test('FIRES: with the old .xls refusal back, the row is disabled and the click sends nothing', async () => {
    const broken = mutate(TICKETS_SRC, "return !!f && (crew === true || f.kind !== 'xls');", "return !!f && f.kind !== 'xls';");
    const r = await drivePick(broken, 'Estimate.xls');
    expect(r.disabled).toBe(true);
    expect(r.puts).toEqual([]);
  });

  test('the read-a-takeoff picker still cannot open an .xls', async () => {
    env(TICKETS_SRC, TICKET());
    const d = await openTicket();
    d.querySelector('.p86-wo-mats-edit').click();
    await flush();
    d.querySelector('.p86-wo-mat-fill').click();
    await flush();
    const xls = rowFor(document.getElementById('p86StTakeoffPick'), 'Estimate.xls');
    expect(xls.disabled).toBe(true);
    expect(xls.classList.contains('is-legacy')).toBe(true);
    expect(xls.classList.contains('is-narrow')).toBe(false);
    expect(xls.querySelector('.p86-wo-pick-meta').textContent).toBe('Save as .xlsx to read it');
  });

  test('FIRES: let every mode pick an .xls and the read-a-takeoff row is offered', async () => {
    const broken = mutate(TICKETS_SRC, "return !!f && (crew === true || f.kind !== 'xls');", 'return !!f;');
    env(broken, TICKET());
    const d = await openTicket();
    d.querySelector('.p86-wo-mats-edit').click();
    await flush();
    d.querySelector('.p86-wo-mat-fill').click();
    await flush();
    expect(rowFor(document.getElementById('p86StTakeoffPick'), 'Estimate.xls').disabled).toBe(false);
  });
});

describe('a spreadsheet with a price-free copy', () => {
  test('an .xlsx pick: no question, the copy toast, and the status names the copy and its lines', async () => {
    const r = await drivePick(TICKETS_SRC, 'Lead Report.xlsx');
    expect(r.puts).toEqual([['st_1', 'a_lr']]);
    expect(r.confirmAsked).toBe(0);
    expect(r.toasts).toEqual([[TOAST.copy]]);
    expect(r.crew.cls).toContain('is-copy');
    expect(r.crew.status).toBe(STATUS.copy12);
  });

  test('one line reads "1 line"', async () => {
    env(TICKETS_SRC, TICKET({ crew_takeoff: Object.assign({}, STORED.a_lr, { copy: Object.assign({}, STORED.a_lr.copy, { lines: LINES(1) }) }) }));
    await openTicket();
    expect(crewRow().status).toMatch(/\(1 line\)\. Links sent with financial details/);
  });

  // The server serves a copy only when copy.lines is a non-empty list, so an
  // empty one must read as "no copy" here too.
  async function emptyCopyRow(src) {
    env(src, TICKET({ crew_takeoff: Object.assign({}, STORED.a_lr, { copy: { lines: [], sheet: null, method: 'sheet', made_at: BASE.set_at } }) }));
    await openTicket();
    return crewRow();
  }

  test('a copy with no lines is no copy: financial links only, never "get a price-free copy"', async () => {
    const r = await emptyCopyRow(TICKETS_SRC);
    expect(r.cls).toContain('is-original');
    expect(r.status).not.toMatch(/get a price-free copy/);
    expect(r.status).toBe('No price-free copy could be made, so this file only shows on links sent with financial details.');
  });

  test('FIRES: count any lines list as a copy and the empty copy claims one', async () => {
    const broken = mutate(TICKETS_SRC, 'Array.isArray(copy.lines) && copy.lines.length', 'Array.isArray(copy.lines)');
    const r = await emptyCopyRow(broken);
    expect(r.status).toMatch(/get a price-free copy/);
  });
});

describe('a spreadsheet no copy could be made from', () => {
  async function noCopyRow(src, extra) {
    env(src, TICKET({ crew_takeoff: Object.assign({ attachment_id: 'a_lr', filename: 'Lead Report.xlsx', kind: 'xlsx' }, BASE, { copy: null, copy_problem: null }, extra) }));
    await openTicket();
    return crewRow();
  }

  test("the server's reason sits in brackets, its closing full stop dropped", async () => {
    const r = await noCopyRow(TICKETS_SRC, { copy_problem: 'No material lines were found in Lead Report.xlsx.' });
    expect(r.cls).toContain('is-original');
    expect(r.status).toBe('No price-free copy could be made (No material lines were found in Lead Report.xlsx), ' +
      'so this file only shows on links sent with financial details.');
  });

  test('with no reason stored it still says where the file shows', async () => {
    const r = await noCopyRow(TICKETS_SRC, {});
    expect(r.status).toBe('No price-free copy could be made, so this file only shows on links sent with financial details.');
  });

  test('the reason is text, never markup', async () => {
    const r = await noCopyRow(TICKETS_SRC, { copy_problem: '<img src=x onerror="window.__pwned=1">' });
    expect(r.el.querySelector('img')).toBeNull();
    expect(r.status).toContain('<img src=x onerror="window.__pwned=1">');
    expect(window.__pwned).toBeUndefined();
  });

  test('FIRES: read "no copy" as a PDF-style row and the spreadsheet claims the whole file shows', async () => {
    const broken = mutate(TICKETS_SRC, "if (CREW_WHOLE_FILE_KINDS[ct.kind] && ct.has_prices !== true) return 'unchecked';", "if (!ct.copy) return 'unchecked';");
    const r = await noCopyRow(broken, { copy_problem: 'x' });
    expect(r.status).toBe(STATUS.whole);
  });
});

describe('a row stored before copies existed', () => {
  async function legacyRow(src, ct, opts) {
    env(src, TICKET({ crew_takeoff: ct }), opts);
    await openTicket();
    return crewRow();
  }

  test('every old verdict on every spreadsheet kind asks for a re-pick and claims no copy', async () => {
    for (const kind of ['xlsx', 'csv', 'xls']) {
      for (const verdict of [false, true, null]) {
        const r = await legacyRow(TICKETS_SRC, { attachment_id: 'a_x', filename: 'Takeoff.' + kind, kind: kind, has_prices: verdict });
        expect(r.cls).toContain('is-repick');
        expect(r.status).toBe(STATUS.repick);
        expect(r.status).not.toMatch(/get a price-free copy|shows this whole file/);
      }
    }
  });

  test('a viewer who cannot edit is told what the link does meanwhile, with no controls', async () => {
    const r = await legacyRow(TICKETS_SRC, { attachment_id: 'a_x', filename: 'Takeoff.xlsx', kind: 'xlsx', has_prices: false }, { readOnly: true });
    expect(r.status).toBe('This file only shows on links sent with financial details until the office picks it again.');
    expect(r.el.querySelector('.p86-wo-crew-change')).toBeNull();
  });

  test('FIRES: without the no-copy-key branch the old row loses its re-pick instruction', async () => {
    const broken = mutate(TICKETS_SRC, "if (!Object.prototype.hasOwnProperty.call(ct, 'copy')) return 'repick';", '');
    const r = await legacyRow(broken, { attachment_id: 'a_x', filename: 'Takeoff.xlsx', kind: 'xlsx', has_prices: false });
    expect(r.status).not.toBe(STATUS.repick);
  });

  test('a PDF from before keeps the whole-file warning unless its byte check found prices', async () => {
    for (const verdict of [null, false, 'yes']) {
      const r = await legacyRow(TICKETS_SRC, { attachment_id: 'a_pdf', filename: 'Stair plan.pdf', kind: 'pdf', has_prices: verdict });
      expect(r.cls).toContain('is-unchecked');
      expect(r.status).toBe(STATUS.whole);
    }
  });

  // The old byte check read the bytes, so a {kind:'pdf', has_prices:true} row
  // was a workbook with a .pdf name. The server drops its kind and keeps it off
  // default links; the office must not be told the crew sees the whole file.
  test('a "pdf" row whose old byte check found prices reads as a spreadsheet to re-pick', async () => {
    const r = await legacyRow(TICKETS_SRC, { attachment_id: 'a_pdf', filename: 'bid.pdf', kind: 'pdf', has_prices: true });
    expect(r.cls).toContain('is-repick');
    expect(r.status).toBe(STATUS.repick);
  });

  test('FIRES: ignore the old verdict and the priced "pdf" claims the whole file shows', async () => {
    const broken = mutate(TICKETS_SRC, "if (CREW_WHOLE_FILE_KINDS[ct.kind] && ct.has_prices !== true) return 'unchecked';", "if (CREW_WHOLE_FILE_KINDS[ct.kind]) return 'unchecked';");
    const r = await legacyRow(broken, { attachment_id: 'a_pdf', filename: 'bid.pdf', kind: 'pdf', has_prices: true });
    expect(r.status).toBe(STATUS.whole);
  });

  test("a kind the reader could not name shows the server's reason, not the whole-file warning", async () => {
    const r = await legacyRow(TICKETS_SRC, Object.assign({ attachment_id: 'a_u', filename: 'takeoff.dat', kind: 'unknown' }, BASE, { copy: null, copy_problem: 'This file is not a spreadsheet the reader can open.' }));
    expect(r.cls).toContain('is-original');
    expect(r.status).toBe('No price-free copy could be made (This file is not a spreadsheet the reader can open), so this file only shows on links sent with financial details.');
  });

  test('FIRES: go back to "anything not a spreadsheet kind is the whole file" and the unknown kind claims it', async () => {
    const broken = mutate(TICKETS_SRC, "if (CREW_WHOLE_FILE_KINDS[ct.kind] && ct.has_prices !== true) return 'unchecked';", "if (!({ xlsx: 1, xls: 1, csv: 1 })[ct.kind]) return 'unchecked';");
    const r = await legacyRow(broken, Object.assign({ attachment_id: 'a_u', filename: 'takeoff.dat', kind: 'unknown' }, BASE, { copy: null, copy_problem: 'x' }));
    expect(r.status).toBe(STATUS.whole);
  });

  test('the save toast never says a plain "shown" for a spreadsheet the server answered with no copy key', async () => {
    const r = await drivePick(TICKETS_SRC, 'Lead Report.xlsx', {
      stored: () => ({ attachment_id: 'a_lr', filename: 'Lead Report.xlsx', kind: 'xlsx', has_prices: null }),
    });
    expect(r.puts).toEqual([['st_1', 'a_lr']]);
    expect(r.toasts).toEqual([[TOAST.narrow]]);
  });
});

describe('a PDF or photo is still asked about first', () => {
  test('crew picker, Yes: the question, then the plain toast and the whole-file warning', async () => {
    const r = await drivePick(TICKETS_SRC, 'Stair plan.pdf');
    expect(r.confirmAsked).toBe(1);
    expect(r.confirmArgs).toMatchObject({ title: 'Show the whole file to the crew?', confirmText: 'Show it' });
    expect(r.puts).toEqual([['st_1', 'a_pdf']]);
    expect(r.toasts).toEqual([[TOAST.plain]]);
    expect(r.crew.cls).toContain('is-unchecked');
    expect(r.crew.status).toBe(STATUS.whole);
  });

  test('crew picker, No: nothing is sent and the list stays up, usable', async () => {
    const r = await drivePick(TICKETS_SRC, 'Stair plan.pdf', { confirm: false });
    expect(r.confirmAsked).toBe(1);
    expect(r.puts).toEqual([]);
    expect(r.pickerOpen).toBe(true);
    expect(r.rowDisabledAfter).toBe(false);
  });

  test('FIRES: skip the kind gate in the question and a PDF goes out unasked', async () => {
    const broken = mutate(TICKETS_SRC,
      "if (!f || (f.kind !== 'pdf' && f.kind !== 'image')) return Promise.resolve(true);",
      'return Promise.resolve(true);');
    const r = await drivePick(broken, 'Stair plan.pdf', { confirm: false });
    expect(r.confirmAsked).toBe(0);
    expect(r.puts).toEqual([['st_1', 'a_pdf']]);
  });

  // The "Also show this file on the crew link" button, handed a file directly.
  async function driveAlsoShow(att, kind, name, opts) {
    const s = env(TICKETS_SRC, TICKET(), opts);
    const d = await openTicket();
    const also = document.createElement('button');
    also.type = 'button';
    also.className = 'p86-wo-mat-crew';
    also.setAttribute('data-att', att);
    also.setAttribute('data-kind', kind);
    also.setAttribute('data-name', name);
    d.querySelector('.p86-wo-mats').appendChild(also);
    also.click();
    await flush();
    return { puts: s.puts.slice(), confirmAsked: window.p86Confirm.mock.calls.length, toasts: window.p86Toast.mock.calls.map((c) => c.slice()), also };
  }

  test('"Also show": a spreadsheet is saved with no question and the copy toast', async () => {
    const r = await driveAlsoShow('a_lr', 'xlsx', 'Lead Report.xlsx');
    expect(r.confirmAsked).toBe(0);
    expect(r.puts).toEqual([['st_1', 'a_lr']]);
    expect(r.toasts).toEqual([[TOAST.copy]]);
  });

  test('"Also show": a PDF is asked about, and No sends nothing and gives the button back', async () => {
    const r = await driveAlsoShow('a_pdf', 'pdf', 'Stair plan.pdf', { confirm: false });
    expect(r.confirmAsked).toBe(1);
    expect(r.puts).toEqual([]);
    expect(r.also.disabled).toBe(false);
  });
});

describe('nothing on the office side reads the old price verdict', () => {
  // One read is allowed, and it can only narrow: a priced 'pdf' row stops
  // reading as the whole file (the server drops that row's kind the same way).
  test('the old verdict is read only to narrow; no dead status classes in the script or the stylesheet', () => {
    const reads = TICKETS_SRC.match(/\.has_prices\b|\[\s*['"]has_prices['"]\s*\]/g) || [];
    expect(reads).toEqual(['.has_prices']);
    expect(TICKETS_SRC).toContain("if (CREW_WHOLE_FILE_KINDS[ct.kind] && ct.has_prices !== true) return 'unchecked';");
    for (const dead of ['is-priced', 'is-unreadable', 'CREW_STATUS', 'CREW_UNREADABLE_NEXT']) {
      expect(TICKETS_SRC).not.toContain(dead);
    }
    expect(STYLES).not.toMatch(/\.p86-wo-crew\.is-(priced|unreadable|clean)\b/);
    // The amber rule covers every narrowed state that is drawn.
    for (const tone of ['is-original', 'is-repick', 'is-unchecked']) {
      expect(STYLES).toContain('.p86-wo-crew.' + tone + ' .p86-wo-crew-status');
    }
  });
});

// ── Crew side: service-ticket-share.html ────────────────────────────────

const TOKEN = 'ab'.repeat(32);
const SHARE_SCRIPT = (() => {
  const open = SHARE_HTML.lastIndexOf('<script>');
  const close = SHARE_HTML.indexOf('</script>', open);
  if (open === -1 || close === -1) throw new Error('share page script not found');
  return SHARE_HTML.slice(open + '<script>'.length, close);
})();

async function driveSharePage(takeoff, script) {
  document.head.innerHTML = '';
  document.body.innerHTML = '<div class="wrap" id="root"><div class="fatal" id="boot">Loading…</div></div>';
  window.history.replaceState({}, '', '/st/' + TOKEN);
  const payload = {
    ticket: { id: 'st_1', title: 'Replace rotted stair treads', ticket_number: 'WO-0007', status: 'scheduled', materials: [] },
    share: { scope: 'view', hide_financials: true },
    tasks: [],
    takeoff: takeoff,
  };
  const calls = [];
  window.fetch = jest.fn((url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) });
  });
  window.eval(script || SHARE_SCRIPT);
  await flush();
  const card = document.querySelector('#root .takeoff');
  const box = card ? card.closest('.card') : null;
  const link = box ? box.querySelector('a.btn') : null;
  return {
    calls,
    box,
    lbl: box ? box.querySelector('.lbl').textContent : null,
    name: box ? box.querySelector('.takeoff-name').textContent : null,
    size: box && box.querySelector('.takeoff-size') ? box.querySelector('.takeoff-size').textContent : null,
    lines: box && box.querySelector('.takeoff-lines') ? box.querySelector('.takeoff-lines').textContent : null,
    linkText: link ? link.textContent : null,
    href: link ? link.getAttribute('href') : null,
  };
}

describe('the crew page Takeoff card', () => {
  const COPY = { filename: 'Materials - Lead Report.xlsx', kind: 'xlsx', size_bytes: null, copy: true, lines: 12 };

  test('a copy is named as a materials list with the prices removed', async () => {
    const r = await driveSharePage(COPY);
    expect(r.calls).toEqual(['/api/service-ticket-share/' + TOKEN]);
    expect(r.lbl).toBe('Materials list (prices removed)');
    expect(r.name).toBe('Materials - Lead Report.xlsx');
    expect(r.lines).toBe('12 lines — material, quantity and unit');
    expect(r.size).toBeNull();
    expect(r.linkText).toBe('Download the materials list');
    expect(r.href).toBe('/api/service-ticket-share/' + TOKEN + '/takeoff');
  });

  test('one line reads "1 line", and a missing count still says what is in it', async () => {
    expect((await driveSharePage(Object.assign({}, COPY, { lines: 1 }))).lines).toBe('1 line — material, quantity and unit');
    expect((await driveSharePage(Object.assign({}, COPY, { lines: null }))).lines).toBe('Material, quantity and unit');
  });

  test('the original spreadsheet on a financial link keeps the Takeoff wording and its size', async () => {
    const r = await driveSharePage({ filename: 'Lead Report.xlsx', kind: 'xlsx', size_bytes: 48213, copy: false, lines: null });
    expect(r.lbl).toBe('Takeoff');
    expect(r.size).toBe('47 KB');
    expect(r.lines).toBeNull();
    expect(r.linkText).toBe('Download the takeoff');
  });

  test('a PDF still opens', async () => {
    const r = await driveSharePage({ filename: 'Stair plan.pdf', kind: 'pdf', size_bytes: 512000, copy: false, lines: null });
    expect(r.lbl).toBe('Takeoff');
    expect(r.linkText).toBe('Open the takeoff');
  });

  test('a file name is text, never markup', async () => {
    const r = await driveSharePage(Object.assign({}, COPY, { filename: 'Materials - <img src=x onerror="window.__crew=1">.xlsx' }));
    expect(r.box.querySelector('img')).toBeNull();
    expect(r.name).toBe('Materials - <img src=x onerror="window.__crew=1">.xlsx');
    expect(window.__crew).toBeUndefined();
  });

  test('FIRES: ignore takeoff.copy and the copy is labelled as the takeoff itself', async () => {
    const broken = mutate(SHARE_SCRIPT, 'var copy = tk.copy === true;', 'var copy = false;');
    const r = await driveSharePage(COPY, broken);
    expect(r.lbl).toBe('Takeoff');
    expect(r.linkText).toBe('Download the takeoff');
  });
});
