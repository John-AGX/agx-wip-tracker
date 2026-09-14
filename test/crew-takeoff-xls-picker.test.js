/**
 * @jest-environment jsdom
 */
// An old .xls never goes onto the crew link from the office side.
//
// The price check cannot read an .xls (a binary workbook, or an "Export to
// Excel" HTML or XML table saved with that name), so a PM who picked
// 'Estimate.xls' with a Unit Cost column put it on every default crew link:
// no dialog, a "Takeoff shown on the crew link" toast, and a status line that
// said only PDFs and photos cannot be checked. The server now refuses one;
// this is the client half, driven through the REAL js/service-tickets.js:
//
//   1. The crew picker shows the .xls row disabled, with the one thing that
//      fixes it, and a click (even past the disabled attribute) sends nothing.
//   2. The "Also show this file on the crew link" path refuses one too.
//   3. A row stored before that rule (kind xls, has_prices null) says it could
//      not be checked and does not show on links that hide financials. It
//      never says "PDFs and photos can't be checked", and the toast after a
//      save never says "shown" for it.
//
// Each guard is also shown to FIRE: the drive is re-run against a copy of the
// shipped file with that guard broken, and the outcome has to come out wrong.
// The file is CRLF on disk, so the source is EOL-normalized before mutating
// and a mutation that moves no bytes throws.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const TICKETS_SRC = read('js/service-tickets.js');
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

// The scenario's files: the PM's old estimating export, a real .xlsx and a PDF.
const FILES = [
  { id: 'a_est', where: 'job', kind: 'xls', filename: 'Estimate.xls', size_bytes: 88064 },
  { id: 'a_lr', where: 'job', kind: 'xlsx', filename: 'Lead Report.xlsx', size_bytes: 48213 },
  { id: 'a_pdf', where: 'job', kind: 'pdf', filename: 'Stair plan.pdf', size_bytes: 512000 },
];

function env(src, ticket) {
  document.body.innerHTML = '<div id="job-service-tickets"></div>';
  window.appState = { currentJobId: 'job_77' };
  window.appData = { jobs: [{ id: 'job_77', jobNumber: 'M1001', title: 'Latitude stairs' }], leads: [] };
  window.p86JobLabel = JOB_LABEL;
  const state = { ticket: ticket, puts: [] };
  window.p86Api = { serviceTickets: {
    list: jest.fn(() => Promise.resolve({ tickets: [state.ticket] })),
    get: jest.fn(() => Promise.resolve({ ticket: JSON.parse(JSON.stringify(state.ticket)), tasks: [], events: [], revisions: [], participants: [] })),
    materialSources: jest.fn(() => Promise.resolve({ files: FILES.slice() })),
    extractMaterials: jest.fn(() => Promise.resolve({ ok: false, error: 'not in this drive' })),
    setCrewTakeoff: jest.fn((id, att) => {
      state.puts.push([id, att]);
      const f = FILES.find((x) => x.id === att);
      // What the server stored before the fix: an .xls went in as null.
      const ct = f ? { attachment_id: f.id, filename: f.filename, kind: f.kind, has_prices: f.kind === 'xlsx' ? false : null } : null;
      state.ticket = Object.assign({}, state.ticket, { crew_takeoff: ct });
      return Promise.resolve({ ok: true, ticket: state.ticket, crew_takeoff: ct });
    }),
  } };
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

// Drive 1: the crew picker, then a click on the .xls row.
async function drivePicker(src) {
  const s = env(src, TICKET());
  const d = await openTicket();
  d.querySelector('.p86-wo-crew-pick').click();
  await flush();
  const pick = document.getElementById('p86StTakeoffPick');
  const xls = rowFor(pick, 'Estimate.xls');
  const seen = {
    disabled: xls.disabled,
    legacy: xls.classList.contains('is-legacy'),
    meta: xls.querySelector('.p86-wo-pick-meta').textContent,
    xlsxDisabled: rowFor(pick, 'Lead Report.xlsx').disabled,
  };
  // A disabled button swallows a real click; a stale repaint or a script can
  // still clear the attribute, so the handler's own guard is what is proved.
  xls.disabled = false;
  xls.click();
  await flush();
  seen.puts = s.puts.slice();
  seen.confirmAsked = window.p86Confirm.mock.calls.length;
  seen.pickerOpen = !!document.getElementById('p86StTakeoffPick');
  seen.status = (document.querySelector('.p86-st-row.is-open .p86-wo-crew-status') || {}).textContent || null;
  return seen;
}

describe('the crew picker does not offer an .xls', () => {
  test("'Estimate.xls' is disabled with the fix on it, and a click sends nothing", async () => {
    const r = await drivePicker(TICKETS_SRC);
    expect(r.disabled).toBe(true);
    expect(r.legacy).toBe(true);
    expect(r.meta).toBe('Save as .xlsx to put it on the crew link');
    expect(r.xlsxDisabled).toBe(false);
    expect(r.puts).toEqual([]);
    expect(r.confirmAsked).toBe(0);
    expect(r.pickerOpen).toBe(true);
    expect(r.status).toBeNull();
  });

  test('FIRES: with the guard gone the same click puts the .xls on the link as unchecked', async () => {
    const broken = mutate(TICKETS_SRC, "return !!f && f.kind !== 'xls';", 'return !!f;');
    const r = await drivePicker(broken);
    expect(r.disabled).toBe(false);
    expect(r.puts).toEqual([['st_1', 'a_est']]);
  });

  test('the read-a-takeoff picker keeps its own copy for the same row', async () => {
    env(TICKETS_SRC, TICKET());
    const d = await openTicket();
    d.querySelector('.p86-wo-mats-edit').click();
    await flush();
    d.querySelector('.p86-wo-mat-fill').click();
    await flush();
    const xls = rowFor(document.getElementById('p86StTakeoffPick'), 'Estimate.xls');
    expect(xls.disabled).toBe(true);
    expect(xls.querySelector('.p86-wo-pick-meta').textContent).toBe('Save as .xlsx to read it');
  });
});

// Drive 2: the "Also show this file on the crew link" button, handed an .xls.
async function driveAlsoShow(src) {
  const s = env(src, TICKET());
  const d = await openTicket();
  const also = document.createElement('button');
  also.type = 'button';
  also.className = 'p86-wo-mat-crew';
  also.setAttribute('data-att', 'a_est');
  also.setAttribute('data-kind', 'xls');
  also.setAttribute('data-name', 'Estimate.xls');
  d.querySelector('.p86-wo-mats').appendChild(also);
  also.click();
  await flush();
  return { puts: s.puts.slice(), toasts: window.p86Toast.mock.calls.slice(), reEnabled: also.disabled === false };
}

describe('the "Also show" path refuses an .xls too', () => {
  test('nothing is sent, the PM is told to save it as .xlsx, and the button comes back', async () => {
    const r = await driveAlsoShow(TICKETS_SRC);
    expect(r.puts).toEqual([]);
    expect(r.toasts).toEqual([['Save Estimate.xls as .xlsx to put it on the crew link.', 'error']]);
    expect(r.reEnabled).toBe(true);
  });

  test('FIRES: without the guard in confirmWholeFile the .xls is sent', async () => {
    const broken = mutate(TICKETS_SRC, 'if (f && !pickable(f)) {', 'if (false) {');
    const r = await driveAlsoShow(broken);
    expect(r.puts).toEqual([['st_1', 'a_est']]);
  });
});

// Drive 3: a row stored before the rule.
async function driveLegacyRow(src, ct) {
  env(src, TICKET({ crew_takeoff: ct }));
  const d = await openTicket();
  const row = d.querySelector('.p86-wo-crew');
  return { cls: row.className, status: row.querySelector('.p86-wo-crew-status').textContent };
}

describe('a legacy unchecked spreadsheet row says what the link really does', () => {
  const LEGACY_XLS = { attachment_id: 'a_est', filename: 'Estimate.xls', kind: 'xls', has_prices: null };

  test('kind xls, has_prices null: could not be checked, not on links that hide financials', async () => {
    const r = await driveLegacyRow(TICKETS_SRC, LEGACY_XLS);
    expect(r.cls).toContain('is-unreadable');
    expect(r.status).not.toMatch(/PDFs and photos/);
    expect(r.status).not.toMatch(/shows this whole file/);
    expect(r.status).toMatch(/could not be checked for prices/);
    expect(r.status).toMatch(/links that hide financials \(the default\) don't show it/);
    expect(r.status).toMatch(/Save it as \.xlsx/);
  });

  test('an .xlsx or CSV stored with no verdict reads the same way', async () => {
    for (const kind of ['xlsx', 'csv']) {
      const r = await driveLegacyRow(TICKETS_SRC, { attachment_id: 'a_x', filename: 'Takeoff.' + kind, kind: kind, has_prices: null });
      expect(r.cls).toContain('is-unreadable');
      expect(r.status).not.toMatch(/PDFs and photos/);
    }
  });

  test('a PDF with no verdict still carries the whole-file warning', async () => {
    const r = await driveLegacyRow(TICKETS_SRC, { attachment_id: 'a_pdf', filename: 'Stair plan.pdf', kind: 'pdf', has_prices: null });
    expect(r.cls).toContain('is-unchecked');
    expect(r.status).toBe("The crew link shows this whole file. PDFs and photos can't be checked for prices — make sure it has none.");
  });

  test('a verdict that is neither true, false nor null never reads as shown everywhere', async () => {
    const r = await driveLegacyRow(TICKETS_SRC, { attachment_id: 'a_pdf', filename: 'Stair plan.pdf', kind: 'pdf', has_prices: 'yes' });
    expect(r.cls).toContain('is-unreadable');
  });

  test('FIRES: with every null read as "a PDF or photo" the .xls row claims only PDFs and photos', async () => {
    const broken = mutate(TICKETS_SRC,
      'if (ct.has_prices === null && !CREW_SHEET_KINDS[ct.kind]) return \'unchecked\';',
      'if (ct.has_prices === null) return \'unchecked\';');
    const r = await driveLegacyRow(broken, LEGACY_XLS);
    expect(r.status).toMatch(/PDFs and photos/);
  });

  test('the save toast does not say "shown" for a spreadsheet stored with no verdict', async () => {
    // The pre-fix server answer for the scenario's pick. The button path is
    // blocked for an .xls, so the answer comes back through Change on an
    // .xlsx row whose PUT reported null (a failed read stored by an older
    // build).
    const s = env(TICKETS_SRC, TICKET());
    window.p86Api.serviceTickets.setCrewTakeoff = jest.fn((id, att) => {
      s.puts.push([id, att]);
      const ct = { attachment_id: 'a_lr', filename: 'Lead Report.xlsx', kind: 'xlsx', has_prices: null };
      s.ticket = Object.assign({}, s.ticket, { crew_takeoff: ct });
      return Promise.resolve({ ok: true, ticket: s.ticket, crew_takeoff: ct });
    });
    const d = await openTicket();
    d.querySelector('.p86-wo-crew-pick').click();
    await flush();
    rowFor(document.getElementById('p86StTakeoffPick'), 'Lead Report.xlsx').click();
    await flush();
    expect(s.puts).toEqual([['st_1', 'a_lr']]);
    const msgs = window.p86Toast.mock.calls.map((c) => c[0]);
    expect(msgs).not.toContain('Takeoff shown on the crew link');
    expect(msgs).toContain('Saved — it could not be checked for prices, so it shows only on links sent with financial details');
  });
});
