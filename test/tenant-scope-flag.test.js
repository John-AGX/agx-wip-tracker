// THE ROLLBACK SWITCH — proved inert when unset, and proved HONEST when set.
//
// ── WHY BOTH HALVES ARE NECESSARY ─────────────────────────────────────────
// A kill switch nobody has pulled does not exist. Two things have to be true of
// it and neither is obvious from reading it:
//
//   1. UNSET, IT CHANGES NOTHING. `P86_TENANT_SCOPE` is unset in production
//      today and in CI always, so the interesting property is that the code
//      emits the SAME BYTES it emitted before the switch was introduced. That
//      is asserted here against the literal pre-switch string, not against a
//      re-derivation of it.
//   2. SET, IT ACTUALLY DOES SOMETHING. A switch that is quietly a no-op in
//      both positions is worse than no switch, because John would flip it at
//      9pm, see no change, and have no idea whether the mechanism or his
//      understanding was wrong. So `legacy` is asserted to genuinely disable
//      the predicate and to be LOUD about it.
//
// ── AND THE THIRD THING: ITS BLAST RADIUS IS DERIVED, NOT CLAIMED ─────────
// GOVERNED_SITES is a list in a module, and a list in a module is prose. The
// last test in this file GREPS server/ for real call sites and fails if the
// list disagrees with the code — in either direction. That is what stops the
// flag growing quietly into a general mechanism, which is the one thing it must
// never become.
'use strict';

const fs = require('fs');
const path = require('path');

const FLAG_PATH = path.join(__dirname, '..', 'server', 'tenant-scope-flag.js');

// The exact string the repaired code emitted BEFORE this switch existed, taken
// from commit 3e2c70a2. Written out literally rather than built from the module
// under test — a test that derives the expected value from the thing it is
// testing agrees with itself no matter what either one does.
const PRE_SWITCH_ARM_2 = '(organization_id = $2 OR organization_id IS NULL)';
const PRE_SWITCH_ARM_1 = '(organization_id = $1 OR organization_id IS NULL)';
const PRE_SWITCH_SCOPE_1 = '(r.organization_id = $1 OR r.organization_id IS NULL)';

let TENANT_SCOPE;

beforeEach(() => {
  delete process.env.P86_TENANT_SCOPE;
  jest.resetModules();
  TENANT_SCOPE = require('../server/tenant-scope-flag');
});
afterEach(() => { delete process.env.P86_TENANT_SCOPE; });

describe('unset — the switch is inert and the SQL is byte-identical to pre-switch', () => {
  test('the default mode is enforce', () => {
    expect(TENANT_SCOPE.mode()).toBe('enforce');
    expect(TENANT_SCOPE.isLegacy()).toBe(false);
  });

  test('orgArm emits exactly the pre-switch string, for every position used', () => {
    expect(TENANT_SCOPE.orgArm(2, 'admin-agents:/metrics')).toBe(PRE_SWITCH_ARM_2);
    expect(TENANT_SCOPE.orgArm(1, 'admin-agents:/metrics')).toBe(PRE_SWITCH_ARM_1);
  });

  test('orgArm with a column alias emits exactly the pre-switch registryScope string', () => {
    expect(TENANT_SCOPE.orgArm(1, 'admin-agents:registryScope', 'r.organization_id'))
      .toBe(PRE_SWITCH_SCOPE_1);
  });

  test('an unrecognised value is NOT treated as legacy — only the exact word is', () => {
    for (const v of ['', 'off', 'observe', 'true', '1', 'ENFORCE', 'legacyish', 'no']) {
      process.env.P86_TENANT_SCOPE = v;
      expect(TENANT_SCOPE.mode()).toBe('enforce');
    }
  });

  test('nothing is printed when the switch is off', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    TENANT_SCOPE.orgArm(2, 'admin-agents:/metrics');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('legacy — the switch genuinely disables the predicate, and says so', () => {
  test('the exact word "legacy" (any case, any padding) turns it on', () => {
    for (const v of ['legacy', 'LEGACY', '  Legacy  ']) {
      process.env.P86_TENANT_SCOPE = v;
      expect(TENANT_SCOPE.mode()).toBe('legacy');
      expect(TENANT_SCOPE.isLegacy()).toBe(true);
    }
  });

  test('the predicate is switched OFF, and still binds its parameter', () => {
    process.env.P86_TENANT_SCOPE = 'legacy';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const arm = TENANT_SCOPE.orgArm(2, 'admin-agents:/metrics');
    spy.mockRestore();
    // `OR TRUE` — the predicate is inert.
    expect(arm).toBe('(organization_id = $2 OR TRUE)');
    // It STILL references $2. Postgres rejects a bind carrying more parameters
    // than the statement uses, so dropping the reference would turn a rollback
    // into an outage at every call site at once.
    expect(arm).toContain('$2');
  });

  test('it is LOUD — every single use prints, never once at boot', () => {
    process.env.P86_TENANT_SCOPE = 'legacy';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    TENANT_SCOPE.orgArm(2, 'site-one');
    TENANT_SCOPE.orgArm(2, 'site-two');
    TENANT_SCOPE.orgArm(2, 'site-three');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(String(spy.mock.calls[0][0])).toContain('[TENANT-SCOPE:legacy]');
    expect(String(spy.mock.calls[0][0])).toContain('site-one');
    // It has to say how to undo itself. A warning that does not name the
    // variable leaves the next person grepping.
    expect(String(spy.mock.calls[0][0])).toContain('P86_TENANT_SCOPE');
    spy.mockRestore();
  });

  test('there is no third value — anything not "legacy" is enforce', () => {
    // A silent middle state is how "observe" becomes the finish line.
    expect(TENANT_SCOPE.ENFORCE).toBe('enforce');
    expect(TENANT_SCOPE.LEGACY).toBe('legacy');
    expect(Object.keys(TENANT_SCOPE).filter((k) => k === k.toUpperCase() && typeof TENANT_SCOPE[k] === 'string'))
      .toEqual(['ENFORCE', 'LEGACY']);
  });

  test('the flag is read PER CALL, so a Railway restart is enough to change it', () => {
    // Cached at module load, setting the variable would require the process to
    // have started after it — a footgun in exactly the situation this exists
    // for, since the operator has no way to tell the difference.
    expect(TENANT_SCOPE.mode()).toBe('enforce');
    process.env.P86_TENANT_SCOPE = 'legacy';
    expect(TENANT_SCOPE.mode()).toBe('legacy');
    delete process.env.P86_TENANT_SCOPE;
    expect(TENANT_SCOPE.mode()).toBe('enforce');
  });
});

describe('the blast radius is DERIVED from the code, not claimed by the list', () => {
  // Every real call site, found by reading server/ rather than by trusting the
  // module's own list. The two must agree, in both directions.
  function realCallSites() {
    const dir = path.join(__dirname, '..', 'server');
    const found = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (p === FLAG_PATH) continue;
        const src = fs.readFileSync(p, 'utf8');
        // The parameter position may be a LITERAL (`orgArm(1, 'site')`) or a
        // VARIABLE (`orgArm(n, 'site')`). The first draft of this only matched
        // digits and therefore missed the /metrics site entirely — reporting a
        // smaller blast radius than the code has, which is the exact direction
        // of error a blast-radius check must never make.
        const re = /TENANT_SCOPE\.(?:orgArm|announce)\(\s*(?:[^,'()]+,\s*)?'([^']+)'/g;
        let m;
        while ((m = re.exec(src))) found.push(m[1]);
      }
    };
    walk(dir);
    return [...new Set(found)].sort();
  }

  test('GOVERNED_SITES names exactly the sites that exist in server/', () => {
    expect(realCallSites()).toEqual(TENANT_SCOPE.GOVERNED_SITES.slice().sort());
  });

  test('the count is committed — the flag may not grow without this moving', () => {
    expect(TENANT_SCOPE.GOVERNED_SITES.length).toBe(3);
  });

  test('the flag reaches ONE router, and never the agent tool surface', () => {
    // Every agent read tool already refused an org-less caller before the
    // repairs (orgLessToolRefusal predates them), so no repair there created a
    // way to lose access and there is nothing for a switch to rescue. A
    // "serve everything" switch behind 112 tools would be pure downside.
    for (const s of TENANT_SCOPE.GOVERNED_SITES) expect(s.startsWith('admin-agents:')).toBe(true);
    const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js'), 'utf8');
    expect(aiSrc).not.toContain('tenant-scope-flag');
  });

  test('no OTHER module imports the flag', () => {
    const dir = path.join(__dirname, '..', 'server');
    const importers = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!e.name.endsWith('.js') || p === FLAG_PATH) continue;
        if (fs.readFileSync(p, 'utf8').includes('tenant-scope-flag')) importers.push(path.basename(p));
      }
    };
    walk(dir);
    expect(importers.sort()).toEqual(['admin-agents-routes.js']);
  });
});
