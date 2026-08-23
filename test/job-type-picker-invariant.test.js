/**
 * @jest-environment jsdom
 */
// test/job-type-picker-invariant.test.js
//
// THE INVARIANT: a job whose type is not in the list a picker offers must
// never be silently rewritten by a save.
//
// This is a STATE rule, not a spelling. The defect it closes was not "M is
// missing from an array" — it was that the job-info editor built its type
// <select> from a hardcoded ['Service','Renovation','Work Order'] and then
// read that select straight back into job.jobType:
//
//   js/jobs.js  '<select id="edit-jobType">' + opts([...three...], job.jobType)
//   js/jobs.js  if ((v = gv('edit-jobType')) !== null) job.jobType = v;  → saveData()
//
// A <select> that does not contain the record's value resolves to its FIRST
// option. So opening an M job to fix its TITLE wrote jobType='Service' —
// silent reclassification of an identity field. It was already live for more
// than M: both convert paths copy the LEAD vocabulary into job.jobType
// (js/leads.js, js/estimate-editor.js), and 'Service & Repair' is not a job
// type and never will be.
//
// So these tests do not ask "is M in the list". They ask, for a range of
// values the list does NOT contain: does the value survive a round-trip
// through a real <select> and back out of `.value` — which is literally what
// the save reads. Anything that fails that is a data-loss bug regardless of
// which string triggered it.
//
// jsdom on purpose. The bug lives in the browser's option-selection
// behaviour; asserting on the generated HTML string would miss it entirely.

const fs = require('fs');
const path = require('path');

const JF = require('../js/job-finalize.js');

const AGX_REGISTRY = [
  { key: 'service', label: 'Service', prefix: 'S', pad: 4, next: 2288 },
  { key: 'mid_tier_service', label: 'Mid-Tier Service', prefix: 'M', pad: 4, next: 1 },
  { key: 'renovation', label: 'Renovation', prefix: 'RV', pad: 4, next: 2044 },
  { key: 'work_order', label: 'Work Order', prefix: 'WO', pad: 4, next: 1 },
];

// Stand in for GET /api/org/branding. `job_types_default` is the product
// defaults the server now serves alongside the org's own registry.
function serveRegistry(job_types, job_types_default) {
  window.p86Api = {
    org: {
      branding: () => Promise.resolve({
        branding: { job_types: job_types },
        job_types_default: job_types_default,
      }),
    },
  };
  return JF.loadRegistry(true);
}
function serveNothing() {
  window.p86Api = { org: { branding: () => Promise.reject(new Error('offline')) } };
  return JF.loadRegistry(true);
}

// Render the picker the way js/jobs.js renders it, mount it in a real
// document, and hand back the value the save would read.
function roundTrip(current) {
  document.body.innerHTML = '<select id="edit-jobType">' + JF.typeOptionsHTML(current) + '</select>';
  return document.getElementById('edit-jobType').value;
}

// ── 1. The invariant itself ───────────────────────────────────────────
describe('a job type the picker does not offer survives a save', () => {
  beforeEach(() => serveRegistry(AGX_REGISTRY, AGX_REGISTRY));

  // Not a list of special cases — a list of ways a value can be absent from
  // the registry. Every one of them is a real job in this database or one
  // edit away from being one.
  const UNOFFERED = [
    ['Mid-Tier Service (before this org adds M)', 'Mid-Tier Service'],
    ['the LEAD vocabulary, copied in by convert', 'Service & Repair'],
    ['a type an admin renamed out of the registry', 'Renovation - Interior'],
    ['a type an admin deleted from the registry', 'Warranty'],
    ['free text somebody typed years ago', 'service'],
    ['a value with markup in it', 'A & B <Service> "x"'],
    ['a value that is only whitespace-different', ' Service'],
  ];

  test.each(UNOFFERED)('%s round-trips unchanged', (_why, value) => {
    expect(roundTrip(value)).toBe(value);
  });

  test('it round-trips even against a registry that offers NONE of it', () => {
    return serveRegistry(
      [{ key: 'custom', label: 'Only This One', prefix: 'X', pad: 4, next: 1 }],
      AGX_REGISTRY
    ).then(() => {
      expect(roundTrip('Mid-Tier Service')).toBe('Mid-Tier Service');
      expect(roundTrip('Service')).toBe('Service');
    });
  });

  test('it round-trips with NO registry at all (cold cache / offline)', () => {
    return serveNothing().then(() => {
      // Falls back to the product defaults, and the union still holds.
      expect(roundTrip('Service & Repair')).toBe('Service & Repair');
      expect(roundTrip('Mid-Tier Service')).toBe('Mid-Tier Service');
    });
  });

  test('a job with NO type is not given one — blank stays blank', () => {
    // The other half of the same defect: an M job created by the QB-import
    // stub carries jobType=''. Offering only real types would make the first
    // one pre-selected, and the save would stamp it on a job nobody classified.
    expect(roundTrip('')).toBe('');
    expect(roundTrip(null)).toBe('');
    expect(roundTrip(undefined)).toBe('');
  });

  test('the value the user actually PICKS is still what gets read', () => {
    // The union must not break the picker's real job.
    document.body.innerHTML = '<select id="edit-jobType">' + JF.typeOptionsHTML('Mid-Tier Service') + '</select>';
    const sel = document.getElementById('edit-jobType');
    sel.value = 'Renovation';
    expect(sel.value).toBe('Renovation');
  });

  test('the current value appears exactly once, not twice', () => {
    document.body.innerHTML = '<select id="edit-jobType">' + JF.typeOptionsHTML('Service') + '</select>';
    const vals = Array.from(document.getElementById('edit-jobType').options).map((o) => o.value);
    expect(vals.filter((v) => v === 'Service')).toHaveLength(1);
  });
});

// ── 2. The picker reads the ORG registry, not a hardcoded three ───────
describe('the option list comes from the org registry', () => {
  test("an org's own types are what it is offered", () => {
    return serveRegistry([
      { key: 'svc', label: 'Service Call', prefix: 'SC', pad: 4, next: 1 },
      { key: 'reno', label: 'Remodel', prefix: 'RM', pad: 4, next: 1 },
    ], AGX_REGISTRY).then(() => {
      expect(JF.typeLabels('')).toEqual(['Service Call', 'Remodel']);
      // And crucially NOT the product defaults.
      expect(JF.typeLabels('')).not.toContain('Renovation');
    });
  });

  test('before the registry resolves, the offer is the SERVER defaults', () => {
    return serveNothing().then(() => {
      expect(JF.typeLabels('')).toEqual(['Service', 'Mid-Tier Service', 'Renovation', 'Work Order']);
    });
  });

  test('the served defaults replace the local last-resort copy', () => {
    return serveRegistry([], [
      { key: 'a', label: 'Alpha', prefix: 'A', pad: 4, next: 1 },
    ]).then(() => {
      expect(JF.defaults().map((t) => t.label)).toEqual(['Alpha']);
      expect(JF.typeLabels('')).toEqual(['Alpha']);
    });
  });

  test('the one local copy that remains is COMPLETE', () => {
    // Two of the three copies this replaced had drifted — both were missing
    // Work Order, so the Finalize modal told users WO was not a valid shape.
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'job-finalize.js'), 'utf8');
    const server = require('../server/services/job-types').DEFAULT_JOB_TYPES;
    server.forEach((t) => {
      expect(src).toContain("label: '" + t.label + "', prefix: '" + t.prefix + "'");
    });
  });
});

// ── 3. Number → type, off the same registry ───────────────────────────
describe('a job number reads back to its type through the registry', () => {
  beforeEach(() => serveRegistry(AGX_REGISTRY, AGX_REGISTRY));

  test.each([
    ['M0001', 'M', 'Mid-Tier Service'],
    ['S2287', 'S', 'Service'],
    ['RV2044', 'RV', 'Renovation'],
    ['WO0007', 'WO', 'Work Order'],
    ['m0001', 'M', 'Mid-Tier Service'],
  ])('%s → %s → %s', (num, prefix, label) => {
    expect(JF.prefixForNumber(num)).toBe(prefix);
    expect(JF.labelForNumber(num)).toBe(label);
  });

  test('the whole letter run is the prefix — RV is never read as R', () => {
    // The chains this replaced depended on TEST ORDER: a startsWith('S')
    // placed before a longer prefix silently claims it. Extracting the run
    // removes the ordering hazard rather than documenting it.
    return serveRegistry([
      { key: 's', label: 'Service', prefix: 'S', pad: 4, next: 1 },
      { key: 'sv', label: 'Survey', prefix: 'SV', pad: 4, next: 1 },
    ], AGX_REGISTRY).then(() => {
      expect(JF.labelForNumber('SV0003')).toBe('Survey');
      expect(JF.labelForNumber('S0003')).toBe('Service');
    });
  });

  test('a prefix this org does not number under reads as unknown, not as a guess', () => {
    expect(JF.prefixForNumber('ZZ0001')).toBe('');
    expect(JF.labelForNumber('ZZ0001')).toBe('');
    expect(JF.labelForNumber('')).toBe('');
    expect(JF.labelForNumber(null)).toBe('');
    expect(JF.labelForNumber('no digits here')).toBe('');
  });
});

// ── 4. The call sites actually read the one source ────────────────────
// Pinned on the source because these two files are 7k-line browser scripts
// with no module seam. What is being pinned is the ABSENCE of a second copy:
// a hardcoded list that drifts is exactly the defect, and it reintroduces
// itself by looking harmless.
describe('no browser file keeps its own job-type list', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  test('js/jobs.js builds the type picker from the shared source', () => {
    const src = read('js/jobs.js');
    expect(src).toMatch(/id="edit-jobType"[\s\S]{0,200}p86JobTypeOptions/);
    expect(src).not.toMatch(/opts\(\['Service', 'Renovation', 'Work Order'\]/);
  });

  test('js/jobs.js resolves number → type through the shared source', () => {
    const src = read('js/jobs.js');
    expect(src).toMatch(/p86JobFinalize\.prefixForNumber/);
    expect(src).toMatch(/p86JobFinalize\.labelForPrefix/);
    expect(src).not.toMatch(/if \(type === 'S'\) return 'Service';/);
    expect(src).not.toMatch(/num\.startsWith\('RV'\)/);
  });

  test('js/insights.js no longer keeps a second prefix→label chain', () => {
    const src = read('js/insights.js');
    expect(src).toMatch(/p86JobFinalize\.labelForNumber/);
    expect(src).not.toMatch(/\/\^RV\/\.test/);
  });

  test('js/admin.js seeds a new org from the SERVER defaults', () => {
    // This one writes the org's permanent numbering registry, so a drifted
    // copy here does not misrender a label — it seeds the counters wrong.
    const src = read('js/admin.js');
    expect(src).toMatch(/seedJobTypesFromJobs\(r && r\.job_types_default\)/);
    expect(src).not.toMatch(/key: 'mid_tier_service', label: 'Mid-Tier Service'/);
  });

  test('GET /api/org/branding serves the product defaults', () => {
    const src = read('server/routes/org-manifest-routes.js');
    expect(src).toMatch(/job_types_default: defaultJobTypes\(\)/);
  });
});
