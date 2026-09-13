// A lead save that sends only some fields must leave the rest alone.
//
// pickEditable normalised four numeric keys — estimated_revenue_low/high and
// geocode_lat/lng — for EVERY request, whether the body carried them or not,
// turning an absent key into an explicit null. PUT /api/leads/:id then writes
// every key pickEditable returns. The lead editor saves one field per blur
// (js/leads.js _saveFieldNow) and bulk edit sends one field to many leads, so
// renaming a lead, changing its status or typing a note erased its estimated
// revenue and dropped its map pin.
//
// Driven through the real express router, requireAuth, requireCapability and
// a JWT, over the pg-sqlite engine with the leads table derived from db.js.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
delete process.env.GEOCODING_API_KEY;

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(['organizations', 'users', 'roles', 'leads', 'clients'], {
    pk: { organizations: 'id', users: 'id', roles: 'name', leads: 'id', clients: 'id' },
  })
);
globalThis.__P86_LEAD_PARTIAL_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_LEAD_PARTIAL_ENGINE__.pool }));
// Geocoding must never reach the network from a test; a miss is fine.
jest.mock('../server/geocoder', () => ({
  geocodeAddress: async () => null,
  geocodeViaGoogle: async () => null,
  geocodeViaCensus: async () => null,
}));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const leadRoutes = require('../server/routes/lead-routes');

const PM = { id: 10, email: 'pm@agx.test', name: 'Pat PM', role: 'pm', organization_id: 1 };

let server, baseUrl;

function seed() {
  engine.db.exec(`
    DELETE FROM leads; DELETE FROM clients; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name, slug) VALUES (1, 'AG Exteriors', 'agx');
    INSERT INTO users (id, email, name, role, organization_id, active) VALUES (10, 'pm@agx.test', 'Pat PM', 'pm', 1, 1);
    INSERT INTO roles (name, label, capabilities) VALUES ('pm', 'PM', '["LEADS_VIEW","LEADS_EDIT"]');
    INSERT INTO leads (id, title, status, street_address, city, state, zip,
                       estimated_revenue_low, estimated_revenue_high,
                       geocode_lat, geocode_lng, notes, organization_id)
    VALUES ('lead_1', 'Bay Pointe Roof Hatch', 'new', '100 Main St', 'Tampa', 'FL', '33602',
            12000, 18000, 27.95, -82.46, 'first visit', 1);
  `);
}

function row() {
  return engine.db.prepare(
    'SELECT title, status, notes, confidence, street_address, estimated_revenue_low, estimated_revenue_high, geocode_lat, geocode_lng FROM leads WHERE id = ?'
  ).get('lead_1');
}

async function put(body) {
  const res = await fetch(baseUrl + '/api/leads/lead_1', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + signToken(PM), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

beforeAll(async () => {
  setRolePool(engine.pool);
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => seed());

describe('a single-field save (editor blur, bulk edit) keeps revenue and the map pin', () => {
  test.each([
    ['title', { title: 'Bay Pointe Roof Hatch Replacement' }],
    ['status', { status: 'in_progress' }],
    ['notes', { notes: 'second visit' }],
    ['confidence', { confidence: 50 }],
  ])('saving only %s', async (_name, body) => {
    const r = await put(body);
    expect(r.status).toBe(200);
    const after = row();
    // The field that was sent changed...
    const key = Object.keys(body)[0];
    expect(String(after[key])).toBe(String(body[key]));
    // ...and nothing it did not send was touched.
    expect(after.estimated_revenue_low).toBe(12000);
    expect(after.estimated_revenue_high).toBe(18000);
    expect(after.geocode_lat).toBeCloseTo(27.95);
    expect(after.geocode_lng).toBeCloseTo(-82.46);
  });
});

describe('clearing on purpose still works', () => {
  test('revenue sent as empty string or null is cleared', async () => {
    expect((await put({ estimated_revenue_low: '', estimated_revenue_high: null })).status).toBe(200);
    const after = row();
    expect(after.estimated_revenue_low).toBeNull();
    expect(after.estimated_revenue_high).toBeNull();
    expect(after.geocode_lat).toBeCloseTo(27.95);
  });

  test('revenue sent as a number string is stored as that number', async () => {
    await put({ estimated_revenue_high: '25000' });
    expect(row().estimated_revenue_high).toBe(25000);
    expect(row().estimated_revenue_low).toBe(12000);
  });
});

describe('an address edit still replaces the pin', () => {
  test('street changed without coords drops the old pin (re-geocode fills it)', async () => {
    await put({ street_address: '200 Oak Ave' });
    const after = row();
    expect(after.street_address).toBe('200 Oak Ave');
    expect(after.geocode_lat).toBeNull();
    expect(after.geocode_lng).toBeNull();
    // Revenue is not an address field.
    expect(after.estimated_revenue_low).toBe(12000);
  });

  test('street changed WITH Places-picked coords keeps the coords sent', async () => {
    await put({ street_address: '200 Oak Ave', geocode_lat: 28.1, geocode_lng: -82.3 });
    const after = row();
    expect(after.geocode_lat).toBeCloseTo(28.1);
    expect(after.geocode_lng).toBeCloseTo(-82.3);
  });
});
