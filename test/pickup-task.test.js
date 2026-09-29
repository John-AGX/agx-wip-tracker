// A PICKUP IS AN ERRAND, NOT A WORK ORDER (services/pickup-task.js).
//
// John, 2026-09-18, after 86 refused a service ticket for a Lowe's
// collection — order 300901261260239973, 96" aluminium soffit vents, qty 49,
// Plant City Pro Desk, due that day — because a work order needs a job or
// lead parent. Forcing an errand into one means inventing a parent job, and
// a work order also carries a scope, a punch list, photo-as-proof per
// building and an approval, none of which a supplier run has.
//
// So it is a TASK with kind 'pickup'. What is asserted here:
//
//   * the shape holds what a runner needs to do the job, and NO PRICE —
//     not a blank price field, no field at all, because a pickup goes out
//     on a forwardable link;
//   * a pickup with no supplier or nothing to collect is REFUSED, not
//     quietly saved as a blank errand;
//   * an errand can stand alone: no job, no lead, no work order;
//   * the order reference is searchable, because "what was that Lowe's
//     order number" is how somebody looks for one;
//   * A PICKUP IS NOT COLLECTED WITHOUT PROOF, and the office door and the
//     runner's link ask that of the SAME function — the two answering it
//     differently is exactly how the work order's photo rule went wrong
//     before 1.29.
'use strict';

const fs = require('fs');
const path = require('path');
const pickup = require('../server/services/pickup-task');

const ORDER = '300901261260239973';

function body(over) {
  return Object.assign({
    store: "Lowe's",
    branch: 'Plant City Pro Desk',
    order_ref: ORDER,
    phone: '(813) 555-0100',
    address: '1401 James L Redman Pkwy, Plant City, FL 33563',
    window_start: '08:00',
    window_end: '12:00',
    note: 'Ask for Dwayne at the Pro Desk.',
    items: [{ qty: 49, unit: 'ea', description: '96" aluminium soffit vent' }],
  }, over || {});
}

// ── 1. the shape ─────────────────────────────────────────────────────────
describe('what a pickup carries', () => {
  test('everything a runner needs to walk in and collect it', () => {
    const v = pickup.validate(body());
    expect(v.ok).toBe(true);
    expect(v.pickup).toEqual({
      v: 1,
      store: "Lowe's",
      branch: 'Plant City Pro Desk',
      order_ref: ORDER,
      phone: '(813) 555-0100',
      address: '1401 James L Redman Pkwy, Plant City, FL 33563',
      window_start: '08:00',
      window_end: '12:00',
      note: 'Ask for Dwayne at the Pro Desk.',
      items: [{ qty: 49, unit: 'ea', description: '96" aluminium soffit vent', got: false }],
    });
  });

  test('AND NO PRICE — not a blank field, no field at all', () => {
    // The errand goes to a runner or a sub on a forwardable link. What the
    // company pays for soffit vents is not their business, so the shape has
    // nowhere to put it rather than a box somebody is trusted to leave empty.
    const v = pickup.validate(body({
      items: [{ qty: 2, unit: 'ea', description: 'vent', price: 41.5, unit_cost: 41.5, total: 83 }],
      total: 83, cost: 83,
    }));
    expect(JSON.stringify(v.pickup)).not.toMatch(/41\.5|price|cost|total/i);
    expect(Object.keys(v.pickup.items[0]).sort()).toEqual(['description', 'got', 'qty', 'unit']);
  });

  test('the source file has no price field either — the shape is the guard', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'pickup-task.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/\b(price|unit_cost|unitCost|amount|subtotal)\b/);
  });

  test('a line can be ticked off as collected, for a partial pickup', () => {
    const v = pickup.validate(body({ items: [{ qty: 1, description: 'vent', got: true }] }));
    expect(v.pickup.items[0]).toEqual({ qty: 1, unit: null, description: 'vent', got: true });
  });
});

// ── 2. what it refuses ───────────────────────────────────────────────────
describe('a pickup nobody can run is refused, not saved', () => {
  test('no supplier', () => {
    for (const store of ['', '   ', null, undefined]) {
      expect([store, pickup.validate(body({ store: store })).error]).toEqual([store, pickup.MSG.store]);
    }
  });

  test('nothing to collect', () => {
    for (const items of [[], null, 'a list', [{}], [{ description: '' }]]) {
      const r = pickup.validate(body({ items: items }));
      expect([JSON.stringify(items), r.ok]).toEqual([JSON.stringify(items), false]);
    }
  });

  test('a line with no description, or no real quantity', () => {
    expect(pickup.validate(body({ items: [{ qty: 1, description: '  ' }] })).error).toBe(pickup.MSG.itemDesc);
    for (const qty of [0, -1, 'abc', null, 1e9]) {
      expect([qty, pickup.validate(body({ items: [{ qty: qty, description: 'v' }] })).error])
        .toEqual([qty, pickup.MSG.itemQty]);
    }
  });

  test('more lines than one errand carries', () => {
    const many = Array.from({ length: pickup.ITEMS_MAX + 1 }, () => ({ qty: 1, description: 'v' }));
    expect(pickup.validate(body({ items: many })).error).toBe(pickup.MSG.tooMany);
    const just = Array.from({ length: pickup.ITEMS_MAX }, () => ({ qty: 1, description: 'v' }));
    expect(pickup.validate(body({ items: just })).ok).toBe(true);
  });

  test('a time that is not a time', () => {
    for (const t of ['8am', '25:00', '08:60', '8:00', 'noon']) {
      expect([t, pickup.validate(body({ window_start: t })).error]).toEqual([t, pickup.MSG.time]);
    }
  });

  test('a window that runs backwards', () => {
    expect(pickup.validate(body({ window_start: '14:00', window_end: '09:00' })).error).toBe(pickup.MSG.window);
  });

  test('but one open end is fine — "any time before noon" is a real instruction', () => {
    expect(pickup.validate(body({ window_start: null })).ok).toBe(true);
    expect(pickup.validate(body({ window_end: null })).ok).toBe(true);
    expect(pickup.validate(body({ window_start: null, window_end: null })).ok).toBe(true);
  });

  test('everything but the supplier and the list is optional — an errand can be bare', () => {
    const v = pickup.validate({ store: 'Home Depot', items: [{ qty: 1, description: 'caulk' }] });
    expect(v.ok).toBe(true);
    expect(v.pickup.branch).toBe(null);
    expect(v.pickup.order_ref).toBe(null);
    expect(v.pickup.address).toBe(null);
  });
});

// ── 3. editing ───────────────────────────────────────────────────────────
describe('a partial edit keeps the rest', () => {
  const stored = () => pickup.validate(body()).pickup;

  test('changing one field leaves the others alone', () => {
    const v = pickup.merge(stored(), { phone: '(813) 555-0199' });
    expect(v.ok).toBe(true);
    expect(v.pickup.phone).toBe('(813) 555-0199');
    expect(v.pickup.order_ref).toBe(ORDER);
    expect(v.pickup.items).toHaveLength(1);
  });

  test('a field sent as empty is CLEARED, not ignored', () => {
    // The difference between "I did not touch the branch" and "there is no
    // branch" is a key being present, not its value being falsy.
    const v = pickup.merge(stored(), { branch: '' });
    expect(v.pickup.branch).toBe(null);
    expect(v.pickup.store).toBe("Lowe's");
  });

  test('an edit that would leave it unrunnable is refused', () => {
    expect(pickup.merge(stored(), { store: '' }).error).toBe(pickup.MSG.store);
    expect(pickup.merge(stored(), { items: [] }).error).toBe(pickup.MSG.items);
  });

  test('merging onto nothing is the same as creating', () => {
    const v = pickup.merge(null, body());
    expect(v.ok).toBe(true);
    expect(v.pickup.store).toBe("Lowe's");
  });
});

// ── 4. THE PROOF RULE ────────────────────────────────────────────────────
describe('a pickup is not collected without proof', () => {
  const task = (over) => Object.assign({ id: 't1', kind: 'pickup', status: 'open' }, over || {});

  test('no photo, no collected', () => {
    expect(pickup.mayComplete(task(), [])).toEqual({ ok: false, error: pickup.MSG.needsProof });
    expect(pickup.mayComplete(task(), null).ok).toBe(false);
  });

  test('a photo of the receipt is what lets it through', () => {
    expect(pickup.mayComplete(task(), [{ mime_type: 'image/jpeg' }])).toEqual({ ok: true });
  });

  test('a PDF is not a photo of a receipt', () => {
    expect(pickup.mayComplete(task(), [{ mime_type: 'application/pdf' }]).ok).toBe(false);
    expect(pickup.mayComplete(task(), [{ mime_type: 'text/plain' }]).ok).toBe(false);
  });

  test('and the message says WHICH photo to take', () => {
    expect(pickup.MSG.needsProof).toMatch(/receipt|pickup ticket/i);
  });

  test('ONLY a pickup is held to it — every other task completes as it always has', () => {
    // The failure this guards: the rule becoming "no task completes without a
    // photo", which would break every checklist to-do in the app.
    for (const kind of ['todo', 'punch', 'follow_up', undefined, null]) {
      expect([kind, pickup.mayComplete(task({ kind: kind }), [])]).toEqual([kind, { ok: true }]);
    }
    expect(pickup.mayComplete(null, [])).toEqual({ ok: true });
  });

  test('both doors ask THIS function, not their own copy', () => {
    // The work order's photo rule went wrong before 1.29 by being answered
    // in more than one place. A pickup has two doors from day one — the
    // office and the runner's link — so this is checked rather than trusted.
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', rel), 'utf8')
      // Comments are PROSE ABOUT the rule — both doors explain it in words,
      // and they should. Only the code is scanned.
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [name, src] of [['office', read('tasks-routes.js')], ['guest', read('task-share-routes.js')]]) {
      expect([name, /pickupTask\.mayComplete\(/.test(src)]).toEqual([name, true]);
      // Neither invents its own sentence, or its own idea of what counts.
      expect([name, /image\\\//.test(src)]).toEqual([name, false]);
      expect([name, /receipt|pickup ticket/i.test(src)]).toEqual([name, false]);
      // …and each surfaces the ONE message rather than writing one.
      expect([name, /pickupTask\.MSG\.notPickup|verdict\.error/.test(src)]).toEqual([name, true]);
    }
  });
});

// ── 5. finding one again ─────────────────────────────────────────────────
describe('the order reference is searchable', () => {
  test('the list search matches it as well as the title', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'tasks-routes.js'), 'utf8');
    const at = src.indexOf('if (req.query.q)');
    expect(at).toBeGreaterThan(0);
    const clause = src.slice(at, src.indexOf('}', src.indexOf('params.push', at)));
    expect(clause).toMatch(/t\.title ILIKE/);
    // It ASKS the service for the column rather than spelling out
    // pickup->>'order_ref' here, so the two cannot drift apart.
    expect(clause).toMatch(/pickupTask\.searchSql\(/);
    expect(clause).not.toMatch(/order_ref/);
    // ONE bound value, matched twice — not two parameters that could drift.
    expect((clause.match(/params\.push/g) || []).length).toBe(1);
    expect((clause.match(/\$' \+ at/g) || []).length).toBe(2);
  });

  test('the sql names a validated alias and cannot be injected through', () => {
    expect(pickup.searchSql('t')).toBe("t.pickup->>'order_ref'");
    expect(() => pickup.searchSql("t; DROP TABLE tasks--")).toThrow(/bad alias/);
    expect(() => pickup.searchSql('')).not.toThrow();   // falls back to 't'
  });
});

// ── 6. what the runner sees ──────────────────────────────────────────────
describe('what travels down a share link', () => {
  test('everything needed to do the errand', () => {
    const p = pickup.publicPickup(pickup.validate(body()).pickup);
    expect(p.store).toBe("Lowe's");
    expect(p.branch).toBe('Plant City Pro Desk');
    expect(p.order_ref).toBe(ORDER);
    expect(p.phone).toBe('(813) 555-0100');
    expect(p.address).toContain('Plant City');
    expect(p.items).toEqual([{ qty: 49, unit: 'ea', description: '96" aluminium soffit vent', got: false }]);
  });

  test('projected by INCLUSION, so a field added later does not travel by default', () => {
    const p = pickup.publicPickup(Object.assign(pickup.validate(body()).pickup, {
      internal_cost: 2035, approved_by: 'Wendy', secret: 'x',
    }));
    expect(p).not.toHaveProperty('internal_cost');
    expect(p).not.toHaveProperty('approved_by');
    expect(p).not.toHaveProperty('secret');
    expect(JSON.stringify(p)).not.toMatch(/2035|Wendy/);
  });

  test('a task that is not a pickup has none', () => {
    expect(pickup.publicPickup(null)).toBe(null);
    expect(pickup.publicPickup(undefined)).toBe(null);
    expect(pickup.publicPickup('nonsense')).toBe(null);
  });
});
