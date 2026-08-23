/**
 * @jest-environment jsdom
 */
// test/converted-job-type-invariant.test.js
//
// THE INVARIANT: a job's TYPE must agree with its job NUMBER's prefix.
//
// A job number is IDENTITY — it is printed on purchase orders, pay
// applications, signed change orders and the QuickBooks project name — and its
// prefix is claimed out of the org's job-type registry by the coordinator at
// creation. The prefix therefore already ENCODES the type. Both convert paths
// ignored that and copied a word off the LEAD instead:
//
//   js/leads.js            jobType: l.project_type || ''
//   js/estimate-editor.js  jobType: (lead && lead.project_type) || est.jobType || ''
//
// Two vocabularies, different lists, nothing reconciling them:
//
//   LEAD project_type   Renovation · Service & Repair · Work Order
//   JOB type registry   Service (S) · Mid-Tier Service (M) · Renovation (RV) ·
//                       Work Order (WO)
//
// Two of three matched by accident. 'Service & Repair' matched NOTHING — such
// a job could never be reached by the Jobs-list type filter and vanished from
// the Schedule board whenever any type pill was on — and Mid-Tier Service was
// inexpressible on a lead at all, so a coordinator could not say the thing at
// the exact moment the classification is chosen.
//
// WHAT IS PINNED HERE IS A STATE RULE, NOT TWO PATCHED LINES. The last time
// this defect was fixed (6ab945f8) it was fixed at the job-info picker and
// left two sibling pickers armed fifteen lines away. So the rule lives at
// POST /api/jobs/convert — the one door every convert path goes through — and
// these tests drive that REAL handler rather than the callers. §3 proves the
// point by inventing a third convert path that was never written to be
// covered, and checking that it is.
//
// jsdom because half the surface under test is browser script: the lead
// editor's <select> and the estimate editor's picker are the two places a
// stored value can be silently rewritten, and that bug lives in the browser's
// option-selection behaviour — asserting on a generated HTML string misses it.

const fs = require('fs');
const path = require('path');

const jobTypes = require('../server/services/job-types');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ── Registries ────────────────────────────────────────────────────────
const AGX_REGISTRY = [
  { key: 'service', label: 'Service', prefix: 'S', pad: 4, next: 2288 },
  { key: 'mid_tier_service', label: 'Mid-Tier Service', prefix: 'M', pad: 4, next: 1 },
  { key: 'renovation', label: 'Renovation', prefix: 'RV', pad: 4, next: 2044 },
  { key: 'work_order', label: 'Work Order', prefix: 'WO', pad: 4, next: 1 },
];

// A tenant that renamed and re-prefixed everything. The rule must be about
// agreement with the registry, not about AGX's four strings.
const OTHER_TENANT_REGISTRY = [
  { key: 'callout', label: 'Call-Out', prefix: 'CO', pad: 3, next: 1 },
  { key: 'refurb', label: 'Refurbishment', prefix: 'RF', pad: 5, next: 1 },
  { key: 'sv', label: 'Survey', prefix: 'SV', pad: 4, next: 1 },
];

// Every word a convert path could plausibly put in jobType. Not a list of
// special cases — a list of WAYS the value can be wrong.
const JUNK_TYPES = [
  ['the lead vocabulary that matches no registry label', 'Service & Repair'],
  ['a lead word that matches a DIFFERENT type than the number', 'Renovation'],
  ['an empty lead (the QB-stub shape)', ''],
  ['a null', null],
  ['free text off a spreadsheet import', 'repaint / misc'],
  ['markup', '<b>Service</b>'],
  ['a near-miss on casing', 'service'],
  ['a value with stray whitespace', ' Work Order '],
  ['a registry label from a DIFFERENT tenant', 'Refurbishment'],
];

/* ═══════════════════════════════════════════════════════════════════════════
 * A fake Postgres that answers exactly the statements POST /api/jobs/convert
 * emits, and records every one — so a test can assert on what did NOT run,
 * which is how "nothing is reclassified" gets measured rather than asserted.
 * ══════════════════════════════════════════════════════════════════════════*/
function makeConvertDb(branding, opts) {
  opts = opts || {};
  const state = { log: [], inserted: null, committed: false, rolledBack: false };
  const query = async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.log.push({ sql: text, params: params || [] });
    if (/^BEGIN/i.test(text)) return { rows: [] };
    if (/^COMMIT/i.test(text)) { state.committed = true; return { rows: [] }; }
    if (/^ROLLBACK/i.test(text)) { state.rolledBack = true; return { rows: [] }; }
    if (/SELECT branding FROM organizations/i.test(text)) {
      return { rows: [{ branding: branding ? { job_types: branding } : {} }] };
    }
    if (/SELECT id, name FROM markets/i.test(text)) return { rows: [] };
    if (/SELECT job_id, market_id FROM leads/i.test(text)) {
      return { rows: [{ job_id: null, market_id: null }] };
    }
    if (/SELECT id FROM users/i.test(text)) return { rows: [{ id: params[0] }] };
    // canEdit's owner/org probe (PUT /:id).
    if (/SELECT owner_id, organization_id FROM jobs/i.test(text)) {
      return { rows: [{ owner_id: 'u1', organization_id: 1 }] };
    }
    if (/INSERT INTO jobs/i.test(text)) {
      state.inserted = JSON.parse(params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE jobs SET data/i.test(text)) {
      state.updatedJob = JSON.parse(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE leads SET job_id/i.test(text)) return { rows: [], rowCount: 1 };
    if (/UPDATE receipts SET/i.test(text)) return { rows: [], rowCount: 1 };
    if (/INSERT INTO node_graphs/i.test(text)) return { rows: [], rowCount: 1 };
    if (/UPDATE estimates SET data/i.test(text)) return { rows: [], rowCount: 1 };
    if (/SELECT 1 FROM jobs/i.test(text)) return { rows: [{}], rowCount: 1 };
    throw new Error('fake pg: unhandled statement -> ' + text.slice(0, 140));
  };
  state.client = { query, release() { state.released = true; } };
  state.query = query;
  return state;
}

let convertDb;

jest.mock('../server/db', () => ({
  pool: {
    connect: async () => global.__cvtDb.client,
    query: async (sql, params) => global.__cvtDb.query(sql, params),
  },
}));

jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireOrg: (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 1; next(); },
  requireRole: () => (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next(),
  resolveOrgId: (req, res, next) => next(),
  isAdminish: () => true,
}));

const jobRouter = require('../server/routes/job-routes');

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(method.toUpperCase() + ' ' + routePath + ' not found');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  res.end = () => res;
  return res;
}

// Drive the REAL POST /api/jobs/convert. `job` is the blob a convert path
// posts, verbatim — nothing here sanitizes it on the way in.
async function convert(job, registry, body) {
  convertDb = makeConvertDb(registry === undefined ? AGX_REGISTRY : registry);
  global.__cvtDb = convertDb;
  const res = fakeRes();
  await handlerFor(jobRouter, 'post', '/convert')(
    {
      body: Object.assign({ job: job, lead_id: 'lead-1' }, body || {}),
      user: { id: 'u1', role: 'admin', organization_id: 1 },
      orgId: 1,
    },
    res
  );
  return { res, db: convertDb, stored: convertDb.inserted };
}

// THE PROPERTY, as one assertion. Deliberately re-derived from the STORED
// number rather than from what the test asked for: a rule that reads its
// answer out of the same variable it is checking proves nothing.
function assertTypeAgreesWithNumber(stored, registry) {
  expect(stored).toBeTruthy();
  const expected = jobTypes.labelForNumber(stored.jobNumber, registry);
  expect(expected).not.toBe('');
  expect(stored.jobType).toBe(expected);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE PROPERTY — every convert, every type, every junk value
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a converted job carries a type its own number resolves to', () => {
  const cases = [];
  AGX_REGISTRY.forEach((t) => {
    JUNK_TYPES.forEach(([why, junk]) => {
      cases.push([t.prefix + '0007', why, junk, t.label]);
    });
  });

  test.each(cases)(
    '%s converted with %s → %s',
    async (jobNumber, _why, junk, expectedLabel) => {
      const { stored } = await convert({ id: 'j1', jobNumber, jobType: junk, title: 'x' });
      assertTypeAgreesWithNumber(stored, AGX_REGISTRY);
      expect(stored.jobType).toBe(expectedLabel);
    }
  );

  test('Mid-Tier Service is reachable — the type a lead could not express', async () => {
    // The whole reported hole, in one case: the coordinator picks the M0001
    // chip and the lead says 'Service & Repair'. It used to be stored as the
    // lead's word; the number is now what decides.
    const { stored } = await convert({ id: 'j1', jobNumber: 'M0001', jobType: 'Service & Repair' });
    expect(stored.jobType).toBe('Mid-Tier Service');
  });

  test('it holds for a tenant with an entirely different registry', async () => {
    for (const t of OTHER_TENANT_REGISTRY) {
      const { stored } = await convert(
        { id: 'j1', jobNumber: t.prefix + '0001', jobType: 'Service & Repair' },
        OTHER_TENANT_REGISTRY
      );
      assertTypeAgreesWithNumber(stored, OTHER_TENANT_REGISTRY);
      expect(stored.jobType).toBe(t.label);
    }
  });

  test('it holds for an org with NO registry — the product defaults answer', async () => {
    for (const t of jobTypes.DEFAULT_JOB_TYPES) {
      const { stored } = await convert({ id: 'j1', jobNumber: t.prefix + '0009', jobType: '' }, null);
      assertTypeAgreesWithNumber(stored, null);
      expect(stored.jobType).toBe(t.label);
    }
  });

  test('a prefix the org does not number under is REFUSED, not typed as blank', async () => {
    // The failure ordering matters: an unregistered prefix must die at the
    // door with a message naming the allowed set, not slip through carrying
    // an empty type on a job nobody can classify afterwards.
    const { res, stored } = await convert({ id: 'j1', jobNumber: 'XX0001', jobType: 'Service' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/prefix/i);
    expect(stored).toBeNull();
  });

  test('an org that DELETED a default type refuses that prefix', async () => {
    const noM = AGX_REGISTRY.filter((t) => t.prefix !== 'M');
    const { res } = await convert({ id: 'j1', jobNumber: 'M0001', jobType: 'Mid-Tier Service' }, noM);
    expect(res.statusCode).toBe(400);
  });

  test('the derived type follows a RENAMED label, because it reads the registry', async () => {
    // The label is the match key for type → prefix, so renaming one is a
    // known hazard. What must not happen is the derivation drifting off it.
    const renamed = AGX_REGISTRY.map((t) =>
      t.prefix === 'M' ? Object.assign({}, t, { label: 'Mid-Tier Svc' }) : t
    );
    const { stored } = await convert({ id: 'j1', jobNumber: 'M0001', jobType: 'Mid-Tier Service' }, renamed);
    expect(stored.jobType).toBe('Mid-Tier Svc');
  });

  test('lower-case input is normalized on BOTH halves together', async () => {
    const { stored } = await convert({ id: 'j1', jobNumber: 'm0001', jobType: 'whatever' });
    expect(stored.jobNumber).toBe('M0001');
    expect(stored.jobType).toBe('Mid-Tier Service');
    assertTypeAgreesWithNumber(stored, AGX_REGISTRY);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. NOTHING IS RECLASSIFIED
 *
 * John's rule, and the reason the derivation is confined to the create door:
 * "dont reclassify anything, this is moving forward and done on job creation
 * by the coordinator." A job number is identity.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the rule creates, it never rewrites', () => {
  test('convert issues no UPDATE against any existing job row', async () => {
    const { db } = await convert({ id: 'j1', jobNumber: 'S2288', jobType: 'Service & Repair' });
    const touchedJobs = db.log.filter((q) => /UPDATE jobs/i.test(q.sql));
    expect(touchedJobs).toHaveLength(0);
    expect(db.log.some((q) => /INSERT INTO jobs/i.test(q.sql))).toBe(true);
    expect(db.committed).toBe(true);
  });

  test('convert never reads another job in order to renumber it', async () => {
    const { db } = await convert({ id: 'j1', jobNumber: 'S2288', jobType: '' });
    const reads = db.log.filter((q) => /SELECT[\s\S]*FROM jobs/i.test(q.sql));
    expect(reads).toHaveLength(0);
  });

  test('PUT /api/jobs/:id stores a mismatched type UNCHANGED', async () => {
    // Deliberate. Deriving on update would rewrite the type of every legacy
    // job on its next save — the silent reclassification the job-info picker
    // union exists to stop, arriving through the back door instead.
    convertDb = makeConvertDb(AGX_REGISTRY);
    global.__cvtDb = convertDb;
    const res = fakeRes();
    await handlerFor(jobRouter, 'put', '/:id')(
      {
        params: { id: 'j-old' },
        body: { id: 'j-old', jobNumber: 'S2100', jobType: 'Service & Repair' },
        user: { id: 'u1', role: 'admin', organization_id: 1 },
        orgId: 1,
      },
      res
    );
    expect(convertDb.updatedJob).toEqual(
      expect.objectContaining({ jobNumber: 'S2100', jobType: 'Service & Repair' })
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. A CONVERT PATH THAT DID NOT EXIST WHEN THE RULE WAS WRITTEN
 *
 * The structural claim under test: the guarantee is a property of the STATE,
 * so it covers callers nobody thought about. This path is written the WRONG
 * way on purpose — the way the two real ones were written, and the way a third
 * one would be if somebody copied them.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a brand-new convert path is covered without being told to be', () => {
  // A hypothetical "convert an inbound email into a job" feature, written by
  // someone who has never read this file and copies the shape they found.
  async function inboundEmailConvert(lead, chosenNumber) {
    return convert({
      id: 'j' + Date.now(),
      jobNumber: chosenNumber,
      title: lead.subject,
      jobType: lead.project_type || '',   // ← the original defect, reproduced
      client: lead.from,
    });
  }

  test.each([
    ['Service & Repair', 'M0001', 'Mid-Tier Service'],
    ['Service & Repair', 'S2288', 'Service'],
    ['Renovation', 'WO0012', 'Work Order'],
    ['', 'RV2044', 'Renovation'],
  ])(
    'a new caller copying `jobType: lead.project_type` (%s → %s) still lands %s',
    async (projectType, number, expected) => {
      const { stored } = await inboundEmailConvert(
        { subject: 'Stair repairs', from: 'pm@example.com', project_type: projectType },
        number
      );
      expect(stored.jobType).toBe(expected);
      assertTypeAgreesWithNumber(stored, AGX_REGISTRY);
    }
  );

  test('a caller that omits jobType entirely still gets a real type', async () => {
    const { stored } = await convert({ id: 'j1', jobNumber: 'WO0012', title: 'no type field at all' });
    expect(stored.jobType).toBe('Work Order');
  });

  test('the door TELLS the caller what it stored, so the cache cannot drift', async () => {
    // The caller pushes its own blob into appData.jobs and a later saveData()
    // writes that cache back through PUT /api/jobs/bulk/save. A local copy
    // that disagrees with the row is a queued overwrite of an identity field,
    // so the response has to carry the decision — not just the row id.
    const { res, stored } = await convert({ id: 'j1', jobNumber: 'm0001', jobType: 'Service & Repair' });
    expect(res.body.jobType).toBe('Mid-Tier Service');
    expect(res.body.jobNumber).toBe('M0001');
    expect(res.body.jobType).toBe(stored.jobType);
    expect(res.body.jobNumber).toBe(stored.jobNumber);
  });

  test('both real convert paths adopt the response over their own copy', () => {
    const leads = read('js', 'leads.js');
    const ee = read('js', 'estimate-editor.js');
    [leads, ee].forEach((src) => {
      expect(src).toMatch(/if \(res && res\.jobNumber\) newJob\.jobNumber = res\.jobNumber;/);
      expect(src).toMatch(/if \(res && res\.jobType\) newJob\.jobType = res\.jobType;/);
    });
  });

  test('the guarantee does not depend on any client deriving it', async () => {
    // If it did, it would be a call-site rule wearing a state rule's clothes.
    // Every case above posts a value the server has to overrule; this one
    // states it directly.
    const { stored } = await convert({ id: 'j1', jobNumber: 'S2288', jobType: 'Mid-Tier Service' });
    expect(stored.jobType).toBe('Service');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. THE AGENT WRITE PATH — identity is not free text
 * ══════════════════════════════════════════════════════════════════════════*/
describe('86/Scribe cannot write a job number or a job type', () => {
  const { internals } = require('../server/services/payload-dispatcher');
  const { dispatchJob } = internals;

  function runner(existing) {
    const queries = [];
    let saved = null;
    return {
      queries,
      get saved() { return saved; },
      query: async (sql, params) => {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        queries.push({ sql: text, params: params || [] });
        if (/SELECT 1 FROM jobs/i.test(text)) return { rows: [{}], rowCount: 1 };
        if (/SELECT data FROM jobs/i.test(text)) return { rows: [{ data: JSON.parse(JSON.stringify(existing)) }] };
        if (/UPDATE jobs SET data/i.test(text)) { saved = JSON.parse(params[0]); return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  const EXISTING = { id: 'j1', jobNumber: 'S2100', jobType: 'Service & Repair', title: 'Old' };

  test('field_updates.jobType is dropped, not applied', async () => {
    const r = runner(EXISTING);
    await dispatchJob(r, { entity_id: 'j1', ops: { field_updates: { jobType: 'Mid-Tier Service', title: 'New' } } }, {}, { organizationId: 1 });
    expect(r.saved.jobType).toBe('Service & Repair');   // untouched
    expect(r.saved.title).toBe('New');                  // the legitimate half still lands
  });

  test('field_updates.jobNumber is dropped — identity is not agent-writable', async () => {
    const r = runner(EXISTING);
    await dispatchJob(r, { entity_id: 'j1', ops: { field_updates: { jobNumber: 'M0001' } } }, {}, { organizationId: 1 });
    expect(r.saved.jobNumber).toBe('S2100');
  });

  test('arbitrary free text cannot reach either identity field', async () => {
    const r = runner(EXISTING);
    await dispatchJob(r, { entity_id: 'j1', ops: { field_updates: { jobType: 'banana', jobNumber: 'not-a-number' } } }, {}, { organizationId: 1 });
    expect(r.saved.jobType).toBe('Service & Repair');
    expect(r.saved.jobNumber).toBe('S2100');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. NO PICKER REWRITES A STORED VALUE THE USER DID NOT TOUCH
 *
 * Three pickers, three separate implementations, one rule. A <select> that
 * does not contain the record's value resolves to its FIRST option, and the
 * next save writes THAT.
 * ══════════════════════════════════════════════════════════════════════════*/

// The browser global js/app.js provides. Supplied here because these two
// files are script tags, not modules.
global.escapeHTML = function (str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

const JF = require('../js/job-finalize.js');

function serveRegistry(types) {
  window.p86Api = {
    org: { branding: () => Promise.resolve({ branding: { job_types: types } }) },
  };
  return JF.loadRegistry(true);
}

// Values a record can hold that the offered list does not contain. Every one
// of them is a real row in this database or one edit away from being one.
const UNOFFERED = [
  ['the lead vocabulary this change retires', 'Service & Repair'],
  ['free text from a BT / CSV import', 'Repaint - exterior'],
  ['a type an admin deleted from the registry', 'Warranty'],
  ['markup', 'A & B <x> "y"'],
  ['a casing near-miss', 'service'],
];

describe('the LEAD editor picker', () => {
  const Leads = require('../js/leads.js');

  // The SHIPPED markup, lifted out of index.html — not a replica. A replica
  // would keep passing after somebody edited the real thing.
  const LEAD_SELECT_HTML = (() => {
    const html = read('index.html');
    const m = html.match(/<select id="leadEditor_project_type">[\s\S]*?<\/select>/);
    if (!m) throw new Error('index.html no longer contains #leadEditor_project_type');
    return m[0];
  })();

  beforeEach(() => {
    document.body.innerHTML = LEAD_SELECT_HTML;
    return serveRegistry(AGX_REGISTRY);
  });

  test.each(UNOFFERED)('%s survives open → save', (_why, value) => {
    Leads.setField('project_type', value);
    expect(Leads.getField('project_type')).toBe(value);
  });

  test('a lead with no type is not given one', () => {
    Leads.setField('project_type', '');
    expect(Leads.getField('project_type')).toBe('');
    Leads.setField('project_type', null);
    expect(Leads.getField('project_type')).toBe('');
  });

  test('the offered list is the ORG registry, not a hardcoded three', () => {
    Leads.setField('project_type', '');
    const opts = Array.from(document.getElementById('leadEditor_project_type').options).map((o) => o.value);
    expect(opts).toEqual(['', 'Service', 'Mid-Tier Service', 'Renovation', 'Work Order']);
  });

  test("a custom tenant's own types are what IT is offered", () => {
    return serveRegistry(OTHER_TENANT_REGISTRY).then(() => {
      Leads.setField('project_type', '');
      const opts = Array.from(document.getElementById('leadEditor_project_type').options).map((o) => o.value);
      expect(opts).toEqual(['', 'Call-Out', 'Refurbishment', 'Survey']);
    });
  });

  test('Mid-Tier Service is sayable on a lead — the reported hole', () => {
    Leads.setField('project_type', 'Mid-Tier Service');
    expect(Leads.getField('project_type')).toBe('Mid-Tier Service');
  });

  test('a legacy value does not accumulate as a stray on the next lead', () => {
    // The <select> is one shared node across every lead the user opens.
    Leads.setField('project_type', 'Service & Repair');
    Leads.setField('project_type', 'Renovation');
    const opts = Array.from(document.getElementById('leadEditor_project_type').options).map((o) => o.value);
    expect(opts).not.toContain('Service & Repair');
    expect(Leads.getField('project_type')).toBe('Renovation');
  });

  test('the filter chips can still reach a lead holding a retired word', () => {
    Leads._setLeadsCacheForTest([
      { project_type: 'Service & Repair' },
      { project_type: 'Renovation' },
      { project_type: 'Repaint - exterior' },
    ]);
    const chips = Leads.leadTypeFilterOptions().map((o) => o.v);
    expect(chips).toContain('Mid-Tier Service');       // registry
    expect(chips).toContain('Service & Repair');       // stray, still findable
    expect(chips).toContain('Repaint - exterior');     // import free text
    expect(chips.filter((c) => c === 'Renovation')).toHaveLength(1); // no dupes
  });
});

describe('the ESTIMATE editor picker', () => {
  const EE = require('../js/estimate-editor.js');

  beforeEach(() => serveRegistry(AGX_REGISTRY));

  function roundTrip(current) {
    document.body.innerHTML =
      '<select id="ee-jobType">' + EE.pickerOptionsHTML(current, EE.jobTypeVocabulary()) + '</select>';
    return document.getElementById('ee-jobType').value;
  }

  test.each(UNOFFERED)('%s survives open → autosave', (_why, value) => {
    expect(roundTrip(value)).toBe(value);
  });

  test('an estimate with no type is not given one', () => {
    expect(roundTrip('')).toBe('');
  });

  test('the offered list is the org registry', () => {
    expect(EE.jobTypeVocabulary()).toEqual(['Service', 'Mid-Tier Service', 'Renovation', 'Work Order']);
  });

  test('with no registry module at all it offers nothing rather than a stale list', () => {
    const saved = window.p86JobFinalize;
    try {
      delete window.p86JobFinalize;
      expect(EE.jobTypeVocabulary()).toEqual([]);
      // …and the stored value is still what comes back out.
      expect(roundTrip('Service & Repair')).toBe('Service & Repair');
    } finally {
      window.p86JobFinalize = saved;
    }
  });

  test('the value the user actually picks is still what is read', () => {
    document.body.innerHTML =
      '<select id="ee-jobType">' + EE.pickerOptionsHTML('Service & Repair', EE.jobTypeVocabulary()) + '</select>';
    const sel = document.getElementById('ee-jobType');
    sel.value = 'Mid-Tier Service';
    expect(sel.value).toBe('Mid-Tier Service');
  });
});

describe('the JOB card picker still holds (the rule 6ab945f8 established)', () => {
  beforeEach(() => serveRegistry(AGX_REGISTRY));

  test.each(UNOFFERED)('%s survives a save', (_why, value) => {
    document.body.innerHTML = '<select id="edit-jobType">' + JF.typeOptionsHTML(value) + '</select>';
    expect(document.getElementById('edit-jobType').value).toBe(value);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. ONE VOCABULARY, ONE SOURCE
 *
 * Source-pinned, and said plainly: these are the places a SECOND copy of the
 * list would reappear. A second copy is the defect — it is how the lead list
 * and the job registry came to disagree in the first place — and it
 * reintroduces itself by looking harmless.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('nothing keeps a private copy of the type list', () => {
  const LABELS = jobTypes.DEFAULT_JOB_TYPES.map((t) => t.label);

  test('the AI lead-extraction enum is the registry vocabulary', () => {
    // Source-pinned: ai-routes.js is a 15k-line route module that opens an
    // Anthropic client and arms interval timers at load. What matters here is
    // that the enum is DERIVED rather than written out, which is exactly a
    // property of the source text.
    const src = read('server', 'routes', 'ai-routes.js');
    expect(src).not.toMatch(/enum: \['', 'Renovation', 'Service & Repair', 'Work Order'\]/);
    expect(src).not.toMatch(/enum: \['Renovation', 'Service & Repair', 'Work Order'\]/);
    // Derived, so it cannot drift from the registry defaults.
    expect(src).toMatch(/const JOB_TYPE_LABELS = jobTypes\.DEFAULT_JOB_TYPES\.map/);
    const enums = src.match(/project_type:\s*\{[^}]*enum:\s*\[''\]\.concat\(JOB_TYPE_LABELS\)/g) || [];
    expect(enums.length).toBe(2);
  });

  test('an agent can now say Service and Mid-Tier Service', () => {
    expect(LABELS).toContain('Service');
    expect(LABELS).toContain('Mid-Tier Service');
  });

  test('index.html offers the product defaults on both lead and estimate forms', () => {
    const html = read('index.html');
    ['leadEditor_project_type', 'estJobType'].forEach((id) => {
      const m = html.match(new RegExp('<select id="' + id + '">[\\s\\S]*?</select>'));
      expect(m).toBeTruthy();
      const values = Array.from(m[0].matchAll(/<option value="([^"]*)"/g)).map((x) =>
        x[1].replace(/&amp;/g, '&')
      );
      expect(values).toEqual([''].concat(LABELS));
    });
  });

  test('neither convert path copies a lead word into the job type any more', () => {
    const leads = read('js', 'leads.js');
    const ee = read('js', 'estimate-editor.js');
    expect(leads).not.toMatch(/jobType:\s*l\.project_type/);
    expect(ee).not.toMatch(/jobType:\s*\(lead && lead\.project_type\)/);
    expect(leads).toMatch(/jobType:\s*jobTypeFromNumber/);
    expect(ee).toMatch(/jobType:\s*jobTypeFromNumber/);
  });

  test('the convert door derives the type from the number', () => {
    const src = read('server', 'routes', 'job-routes.js');
    expect(src).toMatch(/job\.jobType = jobTypes\.labelForNumber\(normalizedNumber, orgJobTypes\)/);
  });

  test('the census is READ-ONLY and cannot quietly grow a write', () => {
    // John has not asked for a normalisation. A script that reports a
    // hypothetical is one careless edit away from performing it, so the
    // absence of a write verb is pinned rather than trusted.
    const src = read('scripts', 'job-type-census.js');

    // Every statement it can issue, read off the source. Prose is not
    // evidence — the assertion is about the SQL, so the SQL is what gets read.
    const calls = Array.from(src.matchAll(/\.query\(\s*(['"`])([\s\S]*?)\1/g));
    expect(calls.length).toBeGreaterThan(0);
    calls.forEach(([, , sql]) => expect(sql.trim()).toMatch(/^SELECT\b/i));

    // …and every call goes through the pool, so none of them can be a
    // transaction doing something the literal above does not show.
    const anyQuery = Array.from(src.matchAll(/(\w+)\.query\(/g)).map((m) => m[1]);
    expect(new Set(anyQuery)).toEqual(new Set(['pool']));
    // And it reads the schedule board's real filter list rather than
    // re-declaring one, so C4 cannot understate itself after an edit there.
    expect(src).toMatch(/require\('\.\.\/js\/schedule\.js'\)\.JOB_TYPE_FILTERS/);
  });

  test('the server and the browser resolve number → type the same way', () => {
    // Two implementations (Node service + browser script) of one lookup. They
    // are allowed to be two files; they are not allowed to disagree.
    return serveRegistry(AGX_REGISTRY).then(() => {
      ['S2288', 'M0001', 'RV2044', 'WO0012', 'm0001', 'ZZ0001', '', 'nope'].forEach((n) => {
        expect(jobTypes.labelForNumber(n, AGX_REGISTRY)).toBe(JF.labelForNumber(n));
      });
    });
  });
});
