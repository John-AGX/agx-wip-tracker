/**
 * ONE LOOK ACROSS EVERY ESTIMATE DOCUMENT.
 *
 * The AGX Standard layout reproduced the signed proposal's STRUCTURE, but the
 * documents still printed in the old grey-and-blue palette and read flat beside
 * it. The palette here was measured out of the reference PDF's own content
 * streams — text colours, the filled table-header band, the hairline weight —
 * so this is not a taste assertion; it is the document AGX signs.
 *
 * What is pinned:
 *   1. the palette exists, with the measured values
 *   2. the OLD palette is gone — no rule may reintroduce it
 *   3. the shared furniture (tables, headings, totals, cards, the takeoff)
 *      draws from the tokens, so all seven layouts and the takeoff line up
 *   4. the layouts really do emit that furniture (rendered, not assumed)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/estimate-preview.js'), 'utf8');

// The stylesheet as the document actually receives it.
const CSS = (() => {
  const i = SRC.indexOf('function getProposalCSS()');
  const j = SRC.indexOf('function getPrintCSS()');
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return SRC.slice(i, j);
})();

// Measured off AGX_Proposal_Lakeside_Village_5020_Mill_Pond_AGX.pdf.
const MEASURED = {
  navy: '#003f51',    // section headings, table header band, rules
  teal: '#3a8878',    // numerals, prices, accents
  ink: '#202020',     // body
  muted: '#7f8591',   // italic lead-ins and fine print
  foot: '#8b909b',    // the running page foot
  hair: '#c9d4d8',    // table hairlines
  rule: '#9aa5ab',    // signature rules
  panel: '#f1f5f6'    // signature panels, total rows
};

describe('the palette is the reference document, not a preference', () => {
  test('every measured colour is declared as a token', () => {
    Object.entries(MEASURED).forEach(([name, hex]) => {
      expect(CSS).toContain('--' + name + ': ' + hex);
    });
  });

  test('the tokens are declared on the document root, so every layout inherits', () => {
    const decl = CSS.slice(CSS.indexOf('--ink:'), CSS.indexOf('--panel:') + 40);
    expect(CSS.indexOf("'.p86-proposal { --ink:")).toBeGreaterThan(-1);
    expect(decl).toContain('--navy');
  });
});

describe('the old look cannot come back', () => {
  // Each of these was in the stylesheet before the pass and is what made the
  // documents read as a different company's paperwork than the signed PDF.
  const RETIRED = ['#0f2346', '#4f8cff', '#e5e7eb', '#d1d5db', '#9ca3af', '#c8c8c8', '#ececec', '#d4d4d4'];

  test('no retired colour survives anywhere in the document stylesheet', () => {
    const found = RETIRED.filter((hex) => CSS.toLowerCase().includes(hex));
    expect(found).toEqual([]);
  });

  test('money is set in the body face with aligned figures, not monospace', () => {
    // "SF Mono" numerals were the other half of the flat look: a proposal is
    // not a terminal. Columns still have to align, hence tabular-nums.
    expect(CSS).not.toMatch(/SF Mono/);
    expect(CSS).toMatch(/\.c-money[^']*font-variant-numeric: tabular-nums|font-variant-numeric: tabular-nums;[^']*'/);
  });
});

describe('the shared furniture draws from the tokens', () => {
  const uses = (selector, token) => {
    const rules = CSS.split('\n').filter((l) => l.includes(selector));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => r.includes('var(--' + token + ')'))).toBe(true);
  };

  test('the table header is the navy band with white type', () => {
    const th = CSS.split('\n').find((l) => l.includes('.doc-table th {'));
    expect(th).toBeTruthy();
    expect(th).toContain('var(--navy)');
    expect(th).toContain('#fff');
    expect(th).toMatch(/text-transform: uppercase/);
  });

  test('section headings, totals and key-values are navy', () => {
    uses('.section-heading {', 'navy');
    uses('.tot-row td {', 'navy');
    uses('.doc-kv td:first-child {', 'navy');
  });

  test('accents — subheads, option prices, list numerals — are teal', () => {
    uses('.doc-subhead {', 'teal');
    uses('.tier-price {', 'teal');
    expect(CSS).toMatch(/ol > li::marker \{ color: var\(--teal\)/);
  });

  test('rules are the measured hairline, and signature lines their own weight', () => {
    uses('.doc-table th, .p86-proposal .doc-table td {', 'hair');
    uses('.sig-line {', 'rule');
  });

  test('the takeoff is the same family — it is printed back-to-back with these', () => {
    uses('.takeoff-table th {', 'navy');
    uses('.takeoff-section-name {', 'teal');
  });
});

// ── and the documents really emit it ────────────────────────────────────
function render(layoutId) {
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const win = { localStorage, location: { origin: 'https://x.test' }, addEventListener() {}, print() {}, alert() {} };
  win.window = win;
  const sandbox = {
    window: win, localStorage, alert: () => {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    console: { log() {}, warn() {}, error() {} },
    Promise, Intl, Date, Math, JSON, setTimeout, isNaN, Number, String, Array, Object, parseFloat, parseInt
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  load('js/pricing-pipeline.js');
  load('js/estimate-doc-layouts.js');
  const EST = {
    id: 'e1', title: 'Lakeside Village', issue: 'Exterior Repair', client: 'Saddlebrook HOA',
    community: 'Lakeside Village', propertyAddr: '5020 Mill Pond Road, Wesley Chapel, FL',
    alternates: [
      { id: 'a1', name: 'Base repair', scope: 'Summary line.\nFirst item.' },
      { id: 'a2', name: 'Stucco upgrade', scope: 'Summary line.\nFirst item.' },
      { id: 'x1', name: 'Concealed rot', scope: 'By change order.', excludeFromTotal: true }
    ]
  };
  const L = (o) => Object.assign({ estimateId: 'e1', unit: 'EA', markup: 25 }, o);
  win.appData = {
    estimates: [EST], currentEstimateId: 'e1',
    estimateLines: [
      L({ id: 'l1', alternateId: 'a1', description: 'Panels', qty: 10, unitCost: 50 }),
      L({ id: 'l2', alternateId: 'a2', description: 'Stucco', qty: 100, unitCost: 11 }),
      L({ id: 'l3', alternateId: 'x1', description: 'Allowance', qty: 1, unitCost: 1000 })
    ]
  };
  win.p86Org = { branding: {} };
  win.p86Api = {
    isAuthenticated: () => true,
    settings: { get: () => Promise.resolve({ setting: { value: { company_header: 'Clearwater, FL', license_line: 'CCC1336582', intro_template: 'Intro.', exclusions: ['One.'], payment_schedule: [{ term: '35%', detail: 'Deposit' }], signer_name: 'N', signer_title: 'P' } } }) },
    attachments: { list: () => Promise.resolve({ attachments: [] }) }
  };
  win.getActiveEstimateForPreview = () => EST;
  load('js/estimate-preview.js');
  let captured = null;
  win.open = () => { let b = ''; return { document: { write(s) { b += s; }, close() { captured = b; } } }; };
  win.setEstimateDocLayout(layoutId);
  win.printEstimateProposal();
  return new Promise((r) => setTimeout(() => setTimeout(() => r(captured), 0), 0));
}

describe('every layout ships the palette and uses the shared furniture', () => {
  const ids = ['agx', 'letterhead', 'sov', 'board', 'rfp', 'options', 'service'];

  test('all seven carry the token declaration', async () => {
    for (const id of ids) {
      const html = await render(id);
      expect(html).toContain('--navy: ' + MEASURED.navy);
      expect(html).toMatch(/class="p86-proposal layout-/);
    }
  }, 30000);

  test('the money layouts all print the navy-banded table, not a bare one', async () => {
    for (const id of ['agx', 'sov', 'rfp', 'board']) {
      const html = await render(id);
      expect(html).toMatch(/<table class="doc-table/);
    }
  }, 30000);

  test('the AGX document opens each section with a muted lead-in line', async () => {
    const html = await render('agx');
    expect(html).toMatch(/class="agx-sec-body"/);
    expect(CSS).toMatch(/\.agx-sec-body > p:first-child \{[^']*font-style: italic/);
  }, 30000);
});
