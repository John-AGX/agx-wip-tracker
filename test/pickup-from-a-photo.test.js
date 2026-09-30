// 86 MAKES A PICKUP FROM A PHOTO OF THE ORDER CONFIRMATION.
//
// The second of the four parts John agreed on 2026-09-18, after 86 refused a
// service ticket for a Lowe's collection. The shape landed as tasks.kind
// 'pickup' (services/pickup-task.js); this is the door 86 writes one
// through, and the reason it exists is the photo: reading a Pro Desk slip
// and typing it in again is the errand nobody wants.
//
// What is asserted:
//   * the payload dispatcher accepts a pickup, validated by THE SAME
//     function the HTTP door uses — an agent cannot write a shape a person
//     could not;
//   * the kind and the supplier block travel together, both ways, and each
//     refusal names the other half rather than saying "invalid";
//   * NO PRICE survives, whatever the model sends. The list is what to
//     collect and it travels to whoever fetches it;
//   * what is STORED is the validated shape, not the model's object;
//   * and the Scribe is actually told all of this — the field list and the
//     read-the-image instruction are in its baseline, which is where
//     uncapped detail belongs (agent-tool-description.js explains why the
//     tool description itself cannot carry it).
'use strict';

const fs = require('fs');
const path = require('path');

const D = require('../server/services/payload-dispatcher');
const pickup = require('../server/services/pickup-task');

const ORDER = '300901261260239973';

function fields(over) {
  return Object.assign({
    title: "Pick up 49 soffit vents — Lowe's Plant City",
    kind: 'pickup',
    due_date: '2026-10-02',
    pickup: {
      store: "Lowe's",
      branch: 'Plant City Pro Desk',
      order_ref: ORDER,
      phone: '(813) 555-0100',
      address: '1401 James L Redman Pkwy, Plant City, FL 33563',
      window_start: '08:00',
      window_end: '12:00',
      items: [{ qty: 49, unit: 'ea', description: '96" aluminium soffit vent' }],
    },
  }, over || {});
}

/** The dispatcher's own validation, the way a task payload reaches it. */
function validate(f) {
  try {
    D.validateOps('task', { op: 'create', fields: f });
    return { ok: true };
  } catch (e) {
    // PayloadValidationError carries its machine-readable half on `.detail`,
    // which is what the agents read back to fix a rejected payload.
    const d = e.detail || {};
    return { ok: false, error: e.message, code: d.code || null, path: d.field_path || null };
  }
}

describe('a pickup can be written by an agent', () => {
  test('the whole thing off a slip is accepted', () => {
    expect(validate(fields())).toEqual({ ok: true });
  });

  test("'pickup' is a task kind the dispatcher knows", () => {
    // The kind and the field are two separate allowlists, and a payload needs
    // BOTH. Missing either one used to read as "unknown field".
    const r = validate(fields({ pickup: undefined, kind: 'pickup' }));
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(/kind invalid/);
  });

  test('a bare errand — a store and one line — is enough', () => {
    expect(validate(fields({
      title: 'Grab caulk', pickup: { store: 'Home Depot', items: [{ qty: 2, description: 'White exterior caulk' }] },
    }))).toEqual({ ok: true });
  });
});

describe('the kind and the supplier block travel together', () => {
  test('the block without the kind is refused, and the refusal says which kind', () => {
    const r = validate(fields({ kind: 'todo' }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('wrong_kind');
    expect(r.error).toContain("only for kind 'pickup'");
    expect(r.error).toContain('Nothing was saved');
  });

  test('…including with no kind at all', () => {
    const r = validate(fields({ kind: undefined }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('wrong_kind');
  });

  test('the kind without the block is refused, and the refusal LISTS the block', () => {
    const f = fields();
    delete f.pickup;
    const r = validate(f);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('missing_field');
    // A refusal that names the shape is one the model can act on.
    expect(r.error).toContain('store');
    expect(r.error).toContain('items');
    expect(r.error).toContain('order_ref');
  });

  test('an errand nobody can run is refused with the reason, not "invalid"', () => {
    for (const [bad, want] of [
      [{ store: '', items: [{ qty: 1, description: 'x' }] }, pickup.MSG.store],
      [{ store: 'Lowe\'s', items: [] }, pickup.MSG.items],
      [{ store: 'Lowe\'s', items: [{ qty: 0, description: 'x' }] }, pickup.MSG.itemQty],
      [{ store: 'Lowe\'s', items: [{ qty: 1, description: '' }] }, pickup.MSG.itemDesc],
    ]) {
      const r = validate(fields({ pickup: bad }));
      expect([want, r.ok]).toEqual([want, false]);
      expect([want, r.error]).toEqual([want, expect.stringContaining(want)]);
    }
  });

  test('it is THE SAME validator the HTTP door uses', () => {
    // Not a second copy with its own idea of what a pickup is. Every message
    // the dispatcher surfaces comes out of services/pickup-task.js.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'payload-dispatcher.js'), 'utf8');
    expect(src).toMatch(/require\('\.\/pickup-task'\)/);
    expect(src).toMatch(/pickupTask\.validate\(fields\.pickup\)/);
  });
});

describe('NO PRICE reaches the record, whatever the model sends', () => {
  test('price keys on an item are stripped, not stored', () => {
    const v = pickup.validate({
      store: "Lowe's",
      items: [{ qty: 2, unit: 'ea', description: 'vent', price: 41.5, unit_cost: 41.5, extended: 83 }],
    });
    expect(v.ok).toBe(true);
    expect(Object.keys(v.pickup.items[0]).sort()).toEqual(['description', 'got', 'qty', 'unit']);
    expect(JSON.stringify(v.pickup)).not.toMatch(/41\.5|83|price|cost/i);
  });

  test('and a total on the block itself does not survive either', () => {
    const v = pickup.validate({
      store: "Lowe's", total: 2035, order_total: '2035.00',
      items: [{ qty: 1, description: 'vent' }],
    });
    expect(JSON.stringify(v.pickup)).not.toMatch(/2035/);
  });

  test('the dispatcher stores the VALIDATED shape, not the object it was sent', () => {
    // The apply path re-validates and writes what comes back. A model that
    // sends an extra key does not get it persisted.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'payload-dispatcher.js'), 'utf8');
    const at = src.indexOf("if (k === 'pickup') {");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('}', src.indexOf('vals.push', at)));
    expect(block).toMatch(/pickupTask\.validate\(fields\.pickup\)/);
    expect(block).toMatch(/JSON\.stringify\(v\.pickup\)/);
    // NOT the raw field.
    expect(block).not.toMatch(/JSON\.stringify\(fields\.pickup\)/);
  });
});

describe('the Scribe is told how, and told to read the photo', () => {
  const baseline = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin-agents-routes.js'), 'utf8');
    const at = src.indexOf('const AGENT_SYSTEM_BASELINE');
    expect(at).toBeGreaterThan(0);
    return src.slice(at, src.indexOf('\nconst ', at + 10));
  })();

  test('the field list is there, with store and items named as required', () => {
    expect(baseline).toContain('pickup');
    expect(baseline).toMatch(/store and at least one item are required/i);
    expect(baseline).toMatch(/window_start/);
  });

  test('and it is told there is NO price field and not to invent one', () => {
    expect(baseline).toMatch(/NO PRICE FIELD AND YOU MUST NOT INVENT ONE/);
  });

  test('the photo instruction names the tool that actually reads an image', () => {
    // view_attachment_image is the only way 86 sees pixels; telling it to
    // "look at the photo" without naming the tool is telling it nothing.
    expect(baseline).toContain('view_attachment_image');
    expect(baseline).toMatch(/order confirmation|Pro Desk slip|will-call/i);
  });

  test('…and to copy rather than guess, naming the field it could not read', () => {
    // The failure that matters on a slip: a plausible-looking order number
    // that is not the one on the paper sends somebody to a desk for nothing.
    expect(baseline).toMatch(/COPY, DO NOT GUESS/);
    expect(baseline).toMatch(/say which field you could not read/i);
  });

  test('the tool description stays an INDEX and stays under the cap', () => {
    // agent-tool-description.js: the description ships on every turn of
    // every agent and is hard-capped at 1024, tail-cut, silently. Detail
    // belongs in the baseline, which is what the two tests above check.
    const { AGENT_TOOL_DESC_CAP } = require('../server/services/agent-tool-description');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js'), 'utf8');
    // The pickup detail must NOT have been added to the capped string.
    const at = src.indexOf("name: 'emit_payload_file'");
    const desc = src.slice(at, at + 4000);
    expect(desc).not.toMatch(/window_start|order_ref/);
    expect(AGENT_TOOL_DESC_CAP).toBe(1024);
  });
});

describe('the card describes an errand truthfully — no money in it', () => {
  const { describePayload } = require('../server/services/payload-describe');
  const mk = (p) => [{ entity_type: 'task', ops: { op: 'create',
    fields: { title: 'Pick up 49 soffit vents', kind: 'pickup', due_date: '2026-10-02', pickup: p } } }];

  test('a clean errand is not announced as a money change', () => {
    // `qty` is on the money list because qty × unit cost IS the amount. In a
    // pickup the other half does not exist, so calling it money puts a false
    // sentence on the card about the one record type guaranteed not to have
    // any — and buys nothing: 'task' is not in AUTO_APPLY_TYPES either way.
    const d = describePayload(mk({ store: "Lowe's", order_ref: ORDER,
      items: [{ qty: 49, unit: 'ea', description: '96" aluminium soffit vent' }] }));
    expect([d.risk, d.reasons]).toEqual(['low', []]);
    expect(d.line).not.toMatch(/money/);
  });

  test('a price the model slipped in STILL cards it, by name', () => {
    // The exemption is the count and nothing else. This is the case the deep
    // sweep exists for and it has to keep working.
    for (const [where, p] of [
      ['on a line', { store: "Lowe's", items: [{ qty: 49, description: 'vent', price: 41.5 }] }],
      ['on the block', { store: "Lowe's", total: 2035, items: [{ qty: 1, description: 'vent' }] }],
      ['as unit cost', { store: "Lowe's", items: [{ qty: 1, description: 'vent', unit_cost: 41.5 }] }],
    ]) {
      const d = describePayload(mk(p));
      expect([where, d.risk]).toEqual([where, 'high']);
      expect([where, d.line]).toEqual([where, expect.stringContaining('money field')]);
    }
  });

  test('qty is still money everywhere else — even on a task', () => {
    // The exemption is scoped to the pickup blob, not to tasks and not to the
    // word. A qty anywhere else is still half of an amount. Asserted on the
    // REASON, not just the verdict: a change order is high for four other
    // reasons too, and a test that only read the verdict would pass with the
    // money rule switched off entirely.
    const stray = describePayload([{ entity_type: 'task', ops: { op: 'create',
      fields: { title: 'x', qty: 5 } } }]);
    expect([stray.risk, stray.reasons]).toEqual(['high', ['money:qty']]);

    const coLine = describePayload([{ entity_type: 'job', entity_id: 'j1', ops: { op: 'update',
      change_orders: [{ op: 'create', fields: { title: 'x', lines: [{ qty: 2, description: 'v' }] } }] } }]);
    expect(coLine.reasons).toContain('money:qty');
  });
});

describe('the approval card shows the errand, so it can be checked against the photo', () => {
  // js/payload-artifact.js is an IIFE that exports one object; summarizeOps is
  // private to it, so the two functions are sliced out and run on their own.
  // Both anchors are asserted first — a rename must fail here loudly rather
  // than quietly stop testing anything.
  const summarizeOps = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'payload-artifact.js'), 'utf8');
    const a = src.indexOf('  function pickupLines(p) {');
    const b = src.indexOf('  function statusCardCss(');
    expect([a > 0, b > a]).toEqual([true, true]);
    return new Function('window', src.slice(a, b) + '; return summarizeOps;')({});
  })();

  const target = (f) => [{ entity_type: 'task', ops: { op: 'create', fields: f } }];

  test('the store, the order number and the list are all on the card', () => {
    // What the approver holds up against the slip. The order number is the
    // one that matters: a plausible wrong one sends somebody to a Pro Desk
    // for nothing, and the card is the last place to catch it.
    const out = summarizeOps(target(fields()));
    for (const want of ["Lowe's — Plant City Pro Desk", ORDER, '08:00–12:00', '(813) 555-0100',
      '49 ea 96" aluminium soffit vent']) {
      expect([want, out]).toEqual([want, expect.stringContaining(want)]);
    }
  });

  test('an errand with only a store and a line still reads', () => {
    const out = summarizeOps(target({ title: 'Grab caulk', kind: 'pickup',
      pickup: { store: 'Home Depot', items: [{ qty: 2, description: 'White exterior caulk' }] } }));
    expect(out).toContain('Home Depot');
    expect(out).toContain('2 White exterior caulk');
    expect(out).not.toMatch(/undefined|null|order |–/);
  });

  test('every other target is unchanged — op keys and nothing else', () => {
    const out = summarizeOps([{ entity_type: 'service_ticket', ops: { op: 'create', fields: { title: 'x' } } }]);
    expect(out).toBe('#1 service_ticket (new)\n    • op\n    • fields');
  });

  test('a junk pickup cannot break the card', () => {
    for (const p of [null, 'nope', 42, {}, { items: 'not a list' }, { items: [null, 7, {}] }]) {
      expect(() => summarizeOps(target({ title: 'x', kind: 'pickup', pickup: p }))).not.toThrow();
    }
  });
});
