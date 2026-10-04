/**
 * THE AGX STANDARD PROPOSAL — the house document.
 *
 * Built to reproduce the signed PDF (Lakeside Village, 5020 Mill Pond Road):
 * letterhead with the licence numbers, a Submitted To / Project block, numbered
 * scope sections that carry their own price, an investment summary beside a
 * Not-Included table, payment schedule, the standard assumptions, and an
 * acceptance block naming both signers.
 *
 * Driven through the REAL print path (window.printEstimateProposal), so what is
 * asserted is what a client receives — not a builder called in isolation.
 *
 * The load-bearing conventions, each pinned below because each replaced a field
 * somebody would otherwise have to add:
 *   1. a scope group with NO priced line is a NARRATIVE section — no price in
 *      its heading, no row in the investment summary
 *   2. section numbering is ONE sequence across narrative, priced and standard
 *      closing sections, and the summary cites those same numbers
 *   3. an EXCLUDED group is named under "Not included in total" — with its
 *      amount if it has lines, as TBD if it does not
 *   4. a per-estimate intro replaces the org paragraph; empty falls back
 *   5. the licence line is its own line and is NOT the address line again
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// The org template as the seed defines it, plus the two fields an admin edits
// most. Deliberately NOT the renderer's fallback object: this stands in for the
// saved app_settings row, which is where the real text lives.
const TEMPLATE = {
  company_name: 'AG Exteriors',
  company_header: '13191 56th Court, Suite 102 · Clearwater, FL 33760',
  contact_line: '813-725-5233 · agxco.com',
  license_line: 'CCC1336582 · CGC1538588',
  intro_template: 'AG Exteriors is pleased to provide this proposal to furnish all materials, equipment and labor.',
  about_paragraph: 'We proudly specialize in a wide range of exterior services.',
  acceptance_text: 'The above prices, scope, specifications and conditions are satisfactory and are hereby accepted.',
  signature_text: 'This proposal may be withdrawn by AG Exteriors if not accepted within 30 days.',
  signer_name: 'Noah Pillsbury',
  signer_title: 'President & Founder',
  payment_schedule: [
    { term: '35%', detail: 'Deposit upon acceptance of proposal' },
    { term: 'Balance', detail: 'Progress billing as work is completed' }
  ],
  payment_note: 'Any prepayment of materials will be in addition to the 35% deposit.',
  pricing_note: 'Permit fees and engineering fees are not included.',
  standard_sections: [
    { title: 'Jobsite Management', body: 'Temporary fencing around the work zone.\nScaffold as required for second-floor work.' },
    { title: 'Resident / Construction Schedule', body: 'Advance notice to management before work begins.' }
  ],
  exclusions: ['This proposal may be withdrawn if not accepted within 30 days.', 'Existing windows remain in place.']
};

// One building, priced the way the reference proposal is: a narrative approach
// section with no lines, two priced scopes, a separately-itemized scope, an
// excluded TBD group and an excluded group that does carry a price.
function makeEstimate(over) {
  return Object.assign({
    id: 'e1',
    estimateNumber: 'EST-2051',
    title: 'Lakeside Village at Saddlebrook',
    issue: 'Exterior Repair & Improvement — 5020 Mill Pond Road',
    client: 'Saddlebrook Association HOA',
    community: 'Lakeside Village',
    managerName: 'Jennifer Apol',
    propertyAddr: '5020 Mill Pond Road, Wesley Chapel, FL 33543',
    billingAddr: '5020 Mill Pond Road, Wesley Chapel, FL 33543',
    alternates: [
      { id: 'a0', name: 'Project Approach', scope: 'Work is completed in phases, one building at a time.' },
      { id: 'a1', name: 'Base exterior repair (like-for-like)', scope: 'Replace deteriorated lower T1-11 panels.' },
      { id: 'a2', name: 'Stucco — recommended front upgrade', scope: 'Convert front panels to a sand-finish stucco system.' },
      { id: 'a3', name: 'Exterior paint', scope: 'Premium Sherwin-Williams coatings.' },
      { id: 'tbd', name: 'Concealed rot / unforeseen conditions', scope: 'Handled by written change order.', excludeFromTotal: true },
      { id: 'opt', name: 'Soffit — T4 vinyl', scope: 'Furnish and install new T4 vinyl soffit.', excludeFromTotal: true }
    ]
  }, over || {});
}

const L = (o) => Object.assign({ estimateId: 'e1', unit: 'EA', markup: '' }, o);
const LINES = [
  // 'a0' (Project Approach) gets NO lines — it is the narrative section.
  L({ id: 'h1', alternateId: 'a1', section: '__section_header__', description: 'Materials & Supplies Costs', markup: 20 }),
  L({ id: 'l1', alternateId: 'a1', description: 'T1-11 panels', qty: 65, unit: 'EA', unitCost: 48 }),
  L({ id: 'l2', alternateId: 'a2', description: 'Three-coat stucco', qty: 2400, unit: 'SF', unitCost: 9.5 }),
  L({ id: 'l3', alternateId: 'a3', description: 'Paint body and trim', qty: 1, unit: 'LS', unitCost: 12000 }),
  L({ id: 'l4', alternateId: 'opt', description: 'T4 vinyl soffit', qty: 1, unit: 'LS', unitCost: 9000 })
  // 'tbd' gets no lines either — it must read TBD, not $0.00.
];

function makeSandbox(opts) {
  opts = opts || {};
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }
  };
  const win = { localStorage, location: { origin: 'https://example.test' }, addEventListener() {}, print() {}, alert() {} };
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

  const EST = makeEstimate(opts.estimate);
  win.appData = { estimates: [EST], estimateLines: LINES, currentEstimateId: 'e1' };
  win.p86Org = { branding: { logo_url: '/uploads/org-logo.png' } };
  // The saved org template, served the way the renderer asks for it.
  win.p86Api = {
    isAuthenticated: () => true,
    settings: { get: () => Promise.resolve({ setting: { value: opts.template || TEMPLATE } }) },
    attachments: { list: () => Promise.resolve({ attachments: [] }) }
  };
  win.getActiveEstimateForPreview = () => EST;
  load('js/estimate-preview.js');

  let captured = null;
  win.open = function () {
    let buf = '';
    return { document: { write(s) { buf += s; }, close() { captured = buf; } } };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    win, EST,
    render: async (layoutId) => {
      win.setEstimateDocLayout(layoutId || 'agx');
      captured = null;
      win.printEstimateProposal();
      await flush(); await flush();
      return captured;
    }
  };
}

const textOf = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·')
  .replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

let S, HTML, TEXT;
beforeAll(async () => {
  S = makeSandbox();
  HTML = await S.render('agx');
  TEXT = textOf(HTML);
});

describe('it is the default document', () => {
  test('the registry clamps to AGX Standard, and a fresh browser renders it', () => {
    const reg = S.win.p86EstimateDocLayouts;
    expect(reg.getProposal('retired-id-from-2027').id).toBe('agx');
    expect(reg.listProposals()[0].id).toBe('agx');
    // Nothing stored = the house document.
    expect(HTML).toMatch(/layout-agx/);
  });

  test('with NOTHING stored, the proposal that prints is the AGX one', async () => {
    // The real default path: no setEstimateDocLayout call at all, which is the
    // state of a browser that has never touched the layout picker. Asserting
    // this through a render that first SELECTS 'agx' would prove nothing.
    const fresh = makeSandbox();
    let buf = null;
    fresh.win.open = function () {
      let b = '';
      return { document: { write(s) { b += s; }, close() { buf = b; } } };
    };
    fresh.win.printEstimateProposal();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(buf).toMatch(/layout-agx/);
    expect(buf).toMatch(/Investment Summary/);
  });

  test('a browser that deliberately picked another skeleton keeps it', async () => {
    const other = await S.render('sov');
    expect(other).toMatch(/layout-sov/);
    expect(other).toMatch(/Schedule of Values/);
  });

  test('every section the layout names has a builder behind it', () => {
    expect(HTML).not.toMatch(/could not be rendered/);
    expect(HTML).not.toMatch(/undefined|\[object Object\]|NaN/);
  });
});

describe('letterhead', () => {
  test('address, contact and licence each print, on their own line', () => {
    expect(HTML).toMatch(/13191 56th Court, Suite 102/);
    expect(HTML).toMatch(/813-725-5233/);
    expect(HTML).toMatch(/CCC1336582/);
    expect(HTML).toMatch(/class="agx-lic"/);
  });

  test('the licence line is NOT the address line printed twice', () => {
    // The band layouts fall back license_line -> company_header. On this
    // document that fallback would print the address in the licence slot of
    // every proposal for an org that has no licence numbers.
    const S2 = makeSandbox({ template: Object.assign({}, TEMPLATE, { license_line: '' }) });
    return S2.render('agx').then((html) => {
      expect(html).not.toMatch(/class="agx-lic"/);
      expect((html.match(/13191 56th Court/g) || []).length).toBe(1);
    });
  });
});

describe('the parties block', () => {
  test('submitted-to names the client, the attention line and the address', () => {
    expect(TEXT).toMatch(/Submitted to Saddlebrook Association HOA/);
    expect(TEXT).toMatch(/Attn: Jennifer Apol/);
  });

  test('project names the community, its address and a long-form date', () => {
    expect(TEXT).toMatch(/Project Lakeside Village/);
    expect(TEXT).toMatch(/5020 Mill Pond Road/);
    // "October 3, 2026" — not 10-3-2026, which is what the old meta block printed.
    expect(TEXT).toMatch(/Date: (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/);
  });
});

describe('scope sections', () => {
  test('numbered as one sequence: narrative, priced, then the standard closers', () => {
    const heads = [...HTML.matchAll(/class="agx-sec-no">(\d+)\.<\/span>\s*([^<]+)/g)]
      .map((m) => [Number(m[1]), m[2].trim()]);
    expect(heads.map((h) => h[0])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(heads[0][1]).toMatch(/Project Approach/);
    expect(heads[1][1]).toMatch(/Base exterior repair/);
    expect(heads[4][1]).toMatch(/Jobsite Management/);
    expect(heads[5][1]).toMatch(/Resident \/ Construction Schedule/);
  });

  test('a group with no priced line carries NO price in its heading', () => {
    const approach = HTML.slice(HTML.indexOf('Project Approach'), HTML.indexOf('Base exterior repair'));
    expect(approach).not.toMatch(/agx-sec-amt/);
    expect(approach).toMatch(/Work is completed in phases/);
  });

  test('a priced group prices its own heading', () => {
    const base = HTML.slice(HTML.indexOf('Base exterior repair'), HTML.indexOf('Stucco —'));
    expect(base).toMatch(/agx-sec-amt/);
    expect(base).toMatch(/\$[\d,]+\.\d{2}/);
  });

  test('a section with no scope typed says so, instead of printing an empty heading', async () => {
    // A blank body under a numbered heading reads as a document that lost a
    // paragraph in the mail; it has to name the gap for whoever is editing.
    const S2 = makeSandbox({ estimate: makeEstimate({ alternates: [{ id: 'a1', name: 'Base repair', scope: '' }] }) });
    const html = await S2.render('agx');
    expect(html).toMatch(/Scope not entered for this section/);
  });

  test('the standard closing sections print as numbered items', () => {
    const jobsite = HTML.slice(HTML.indexOf('Jobsite Management'));
    expect(jobsite).toMatch(/agx-sec-list/);
    expect(jobsite).toMatch(/Temporary fencing around the work zone/);
    expect(jobsite).toMatch(/Scaffold as required/);
  });
});

describe('investment summary', () => {
  test('one row per PRICED section, each citing its own section number', () => {
    const sum = HTML.slice(HTML.indexOf('Investment Summary'), HTML.indexOf('Not included in total'));
    expect(sum).toMatch(/Base exterior repair \(like-for-like\)\s*<span class="agx-sec-ref">\(Section 2\)/);
    expect(sum).toMatch(/\(Section 3\)/);
    expect(sum).toMatch(/\(Section 4\)/);
    // The narrative section and the closers are not priced rows.
    expect(sum).not.toMatch(/Project Approach/);
    expect(sum).not.toMatch(/Jobsite Management/);
  });

  test('the total prints to the CENT, like the column above it', () => {
    // The document's rows are cents; ctx.total is dollar-rounded for the
    // letterhead layout. Printing that under a column of cents gives a board a
    // total that does not add up.
    expect(TEXT).toMatch(/Total project investment \$[\d,]+\.\d{2}/);
  });

  test('the section numbers cited are the SAME numbers the headings carry', () => {
    const cited = [...HTML.matchAll(/\(Section (\d+)\)/g)].map((m) => Number(m[1]));
    const headings = [...HTML.matchAll(/class="agx-sec-no">(\d+)\./g)].map((m) => Number(m[1]));
    cited.forEach((n) => expect(headings).toContain(n));
    // ...and they point at the priced sections, not at section 1 (narrative).
    expect(cited).not.toContain(1);
  });

  test('excluded scope is NAMED, as TBD with no lines and priced with them', () => {
    const not = HTML.slice(HTML.indexOf('Not included in total'));
    expect(not).toMatch(/Concealed rot \/ unforeseen conditions/);
    expect(not).toMatch(/TBD/);
    expect(not).toMatch(/Soffit — T4 vinyl/);
    expect(not).toMatch(/\$[\d,]+\.\d{2}/);
  });

  test('the column adds up to the printed total, and excluded scope is not in it', () => {
    const totalCell = TEXT.match(/Total project investment \$([\d,]+\.\d{2})/);
    expect(totalCell).toBeTruthy();
    const total = Number(totalCell[1].replace(/,/g, ''));
    const sumRows = [...HTML.matchAll(/\(Section \d+\)<\/span><\/td><td class="c-money">\$([\d,]+\.\d{2})/g)]
      .map((m) => Number(m[1].replace(/,/g, '')));
    expect(sumRows.length).toBe(3);                     // three priced sections
    expect(sumRows.reduce((a, b) => a + b, 0)).toBeCloseTo(total, 2);
    // The excluded soffit group costs $9,000 before markup; if it had leaked
    // into the total, the column above would no longer equal it.
  });

  test('the pricing footnote prints under the summary', () => {
    expect(TEXT).toMatch(/Permit fees and engineering fees are not included/);
  });
});

describe('terms and acceptance', () => {
  test('the payment schedule prints its rows as typed', () => {
    expect(HTML).toMatch(/class="agx-term">35%/);
    expect(TEXT).toMatch(/Deposit upon acceptance of proposal/);
    expect(HTML).toMatch(/class="agx-term">Balance/);
    expect(TEXT).toMatch(/Any prepayment of materials/);
  });

  test('the standard assumptions still print, under their own heading', () => {
    expect(TEXT).toMatch(/Assumptions, Clarifications and Exclusions/);
    expect(TEXT).toMatch(/Existing windows remain in place/);
  });

  test('both parties sign, and the contractor signer is NAMED', () => {
    const acc = HTML.slice(HTML.indexOf('Acceptance of Proposal'));
    expect(acc).toMatch(/Accepted by — owner/);
    expect(acc).toMatch(/Saddlebrook Association HOA/);
    expect(acc).toMatch(/Submitted by — contractor/);
    expect(acc).toMatch(/Noah Pillsbury, President &amp; Founder/);
    expect((acc.match(/agx-sig-line/g) || []).length).toBe(6); // signature/name/date, twice
  });

  test('the running foot names the company and the project, on every page', () => {
    expect(HTML).toMatch(/agx-runfoot/);
    expect(textOf(HTML.slice(HTML.indexOf('agx-runfoot')))).toMatch(/AG Exteriors · Lakeside Village · Proposal/);
    // Fixed position is what repeats it per printed page.
    expect(HTML).toMatch(/\.agx-runfoot \{ position: fixed/);
  });
});

describe('the per-estimate intro', () => {
  test('a filled-in intro REPLACES the org paragraph', async () => {
    const S2 = makeSandbox({
      estimate: makeEstimate({ proposalIntro: 'In response to the Association RFP dated September 2, the stucco upgrade and exterior paint are priced separately.' })
    });
    const t = textOf(await S2.render('agx'));
    expect(t).toMatch(/In response to the Association RFP dated September 2/);
    expect(t).not.toMatch(/pleased to provide this proposal to furnish all materials/);
  });

  test('an empty one falls back to the standard paragraph', () => {
    expect(TEXT).toMatch(/pleased to provide this proposal to furnish all materials/);
  });

  test('whitespace is not an intro', async () => {
    const S2 = makeSandbox({ estimate: makeEstimate({ proposalIntro: '   \n  ' }) });
    expect(textOf(await S2.render('agx'))).toMatch(/pleased to provide this proposal/);
  });

  test('the estimate carries it through the editor, saved under its own key', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/estimate-editor.js'), 'utf8');
    expect(src).toMatch(/'ee-proposalIntro': 'proposalIntro'/);
    expect(src).toMatch(/field\('Proposal intro[^']*', 'ee-proposalIntro'/);
  });
});

describe('an org that has not filled the new fields in still gets a document', () => {
  test('no payment schedule, signer, footnote or closers: nothing breaks, nothing lies', async () => {
    const S2 = makeSandbox({
      template: {
        company_header: 'Somewhere, FL',
        intro_template: 'Here is our proposal.',
        exclusions: ['One exclusion.']
      }
    });
    const html = await S2.render('agx');
    expect(html).not.toMatch(/could not be rendered/);
    expect(html).not.toMatch(/undefined|NaN/);
    // The payment section omits itself rather than printing an empty table.
    expect(html).not.toMatch(/Payment Schedule/);
    // Acceptance still renders both columns; the contractor is just unnamed.
    expect(html).toMatch(/Submitted by — contractor/);
    expect(html).toMatch(/Investment Summary/);
  });
});
