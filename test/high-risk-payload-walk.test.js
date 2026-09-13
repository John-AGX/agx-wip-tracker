// THE CLICK-ONLY GATE SEES A CHANGE WHEREVER THE DISPATCHER WOULD RUN IT.
//
// isHighRiskPayload (server/routes/payload-routes.js) decides whether a
// "yes" in chat may apply an AI write with no card. Its string scan read only
// target.ops, and matched entity_type case-sensitively, so the SAME
// status:'sold' that it cards as a plain target was harmless to it inside a
// bulk item, a move side, or under entity_type 'Estimate' — and the dispatcher
// runs all three (runTarget: `item.ops || item`, move source/dest). This is
// the 2026-08-09 incident (an estimate marked sold with no job) with the door
// left open one level down.
//
// John, 2026-09-12, widened what is click-only: money edits and completion %
// too, and anything the walk does not recognise.
//
// The REAL module is loaded (JWT_SECRET set, db stubbed — the gate never
// queries). The legacy scan is then shown missing each bulk/move/case form,
// and the walk shown to be what catches it: with classifyRisk forced low the
// same payloads auto-apply again.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

jest.mock('../server/db', () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }));

const SOLD = { field_updates: { status: 'sold' } };
const HIGH = {
  'a bulk item carrying status:sold': [{ entity_type: 'estimate', bulk: { items: [{ entity_id: 'e1', ops: SOLD }] } }],
  'a bulk item that IS its own ops': [{ entity_type: 'estimate', bulk: { items: [Object.assign({ entity_id: 'e1' }, SOLD)] } }],
  'a move whose source deletes lines': [{ op: 'move',
    source: { entity_type: 'estimate', entity_id: 'e1', ops: { line_deletes: ['ln_1'] } },
    dest: { entity_type: 'estimate', entity_id: 'e2', ops: { line_adds: [{ description: 'Fascia' }] } } }],
  'entity_type spelled Estimate': [{ entity_type: 'Estimate', entity_id: 'e1', ops: SOLD }],
  'a change order created with a sell price': [{ entity_type: 'job', entity_id: 'j1',
    ops: { change_orders: [{ op: 'create', title: 'Extra', lines: [{ unitSell: 100 }] }] } }],
};
const LOW = {
  'a personal to-do': [{ entity_type: 'todo', ops: { op: 'create', fields: { title: 'Call the stucco supplier', due_date: '2026-09-14' } } }],
  'a job note': [{ entity_type: 'job', entity_id: 'j1', ops: { field_updates: { notes: 'Gate code changed' } } }],
  'a lead gate code': [{ entity_type: 'lead', entity_id: 'l1', ops: { fields: { gate_code: '1234' } } }],
};

function load(forceLowWalk) {
  let mod;
  jest.isolateModules(() => {
    if (forceLowWalk) {
      jest.doMock('../server/services/payload-describe', () => ({ classifyRisk: () => ({ risk: 'low', reasons: [] }) }));
    }
    mod = require('../server/routes/payload-routes');
  });
  jest.dontMock('../server/services/payload-describe');
  return mod;
}

describe('isHighRiskPayload', () => {
  const { isHighRiskPayload } = load(false);

  test.each(Object.entries(HIGH))('cards %s', (_name, targets) => {
    expect(isHighRiskPayload({ targets })).toBe(true);
    expect(isHighRiskPayload({ targets: JSON.stringify(targets) })).toBe(true);
  });

  test.each(Object.entries(LOW))('still lets %s apply on a spoken yes', (_name, targets) => {
    expect(isHighRiskPayload({ targets })).toBe(false);
  });

  test('what the legacy scan already carded stays carded (a plain status change, a delete, a system target)', () => {
    expect(isHighRiskPayload({ targets: [{ entity_type: 'estimate', entity_id: 'e1', ops: SOLD }] })).toBe(true);
    expect(isHighRiskPayload({ targets: [{ entity_type: 'estimate', entity_id: 'e1', ops: { line_deletes: ['a'] } }] })).toBe(true);
    expect(isHighRiskPayload({ targets: [{ entity_type: 'system', ops: {} }] })).toBe(true);
    expect(isHighRiskPayload({ targets: 'not json' })).toBe(true);
  });
});

describe('MUTANT: the structured walk removed (classifyRisk always low)', () => {
  const { isHighRiskPayload } = load(true);

  test('harness: the legacy scan still cards a plain status change', () => {
    expect(isHighRiskPayload({ targets: [{ entity_type: 'estimate', entity_id: 'e1', ops: SOLD }] })).toBe(true);
  });

  test.each(Object.entries(HIGH))('%s AUTO-APPLIES again', (_name, targets) => {
    expect(isHighRiskPayload({ targets })).toBe(false);
  });
});
