/**
 * GET /api/weather/leads — today's per-site conditions for the Leads map.
 *
 * The Leads map colours each open lead by whether today is a day for the site
 * walk. This route is what it asks. Pinned here, against the REAL handler and
 * a real leads table (the pg-sqlite shim):
 *   1. another organization's lead is indistinguishable from no lead at all —
 *      no coordinates, no conditions, and no upstream call spent on it
 *   2. it never geocodes: a lead with no stored coordinates says so
 *   3. coordinates reach the weather layer as NUMBERS (pg hands NUMERIC back
 *      as strings), with alerts off — per point, they would cost a round trip
 *      per pin
 *   4. one failed site costs that site, not the batch
 *   5. the batch is capped
 */
'use strict';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// pg returns NUMERIC columns as STRINGS; sqlite returns numbers. Hand the route
// what pg would, or a missing Number() cast passes here and ships.
jest.mock('../server/db', () => ({
  pool: {
    query: async (s, p) => {
      const r = await global.__leadsWxDb.pool.query(s, p);
      return Object.assign({}, r, { rows: (r.rows || []).map((row) => {
        const out = Object.assign({}, row);
        ['geocode_lat', 'geocode_lng'].forEach((k) => { if (out[k] != null) out[k] = String(out[k]); });
        return out;
      }) });
    },
  },
}));
jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
}));
// The route must never geocode. If it tries, the test fails loudly.
jest.mock('../server/geocoder', () => ({
  geocodeAddress: async () => { throw new Error('the leads route geocoded'); },
}));
jest.mock('../server/weather', () => ({
  getDailyForecast: async () => [],
  getSiteConditions: jest.fn(async (lat, lng) => ({
    days: [{ date: '2026-09-21', site: { windGustMph: 12, thunderPct: 10, precipPct: 10, lat, lng } }],
  })),
}));

const weather = require('../server/weather');
const router = require('../server/routes/weather-routes');

const ORG_A = 1, ORG_B = 900000002;

function handlerFor(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(method.toUpperCase() + ' ' + routePath + ' not found');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}
async function ask(ids, org) {
  const res = fakeRes();
  await handlerFor('get', '/leads')(
    { query: ids == null ? {} : { ids: ids.join(',') }, user: { id: 'u1', organization_id: org || ORG_A } },
    res
  );
  return res;
}

beforeEach(async () => {
  const db = createPgSqlite(sqliteSchema(['leads']));
  global.__leadsWxDb = db;
  const ins = (id, org, lat, lng) => db.pool.query(
    'INSERT INTO leads (id, organization_id, title, geocode_lat, geocode_lng) VALUES ($1,$2,$3,$4,$5)',
    [id, org, 'Lead ' + id, lat, lng]);
  await ins('a-tampa', ORG_A, '27.95060', '-82.45720');
  await ins('a-orl', ORG_A, '28.53830', '-81.37920');
  await ins('a-nocoords', ORG_A, null, null);
  await ins('a-abroad', ORG_A, '51.50740', '-0.12780');
  await ins('legacy', null, '27.90000', '-82.40000');
  await ins('b-secret', ORG_B, '33.44840', '-112.07400');
  weather.getSiteConditions.mockClear();
});

describe('the organization boundary', () => {
  test("another organization's lead answers exactly like a lead that does not exist", async () => {
    const res = await ask(['b-secret', 'no-such-lead']);
    expect(res.body.weather['b-secret']).toEqual({ status: 'unknown_lead' });
    expect(res.body.weather['b-secret']).toEqual(res.body.weather['no-such-lead']);
    // Nothing about it leaves the server, and no upstream call is spent on it.
    expect(JSON.stringify(res.body)).not.toMatch(/33\.44|112\.07/);
    expect(weather.getSiteConditions).not.toHaveBeenCalled();
  });

  test('the same id asked by its own organization does answer (the boundary is the org, not the row)', async () => {
    const res = await ask(['b-secret'], ORG_B);
    expect(res.body.weather['b-secret'].status).toBe('ok');
  });

  test('a legacy row with no organization reads, as it does on the map endpoint', async () => {
    const res = await ask(['legacy']);
    expect(res.body.weather.legacy.status).toBe('ok');
  });
});

describe('what it asks upstream', () => {
  test('coordinates arrive as NUMBERS, with alerts off', async () => {
    const res = await ask(['a-tampa']);
    expect(res.body.weather['a-tampa'].status).toBe('ok');
    expect(res.body.weather['a-tampa'].days[0].site.windGustMph).toBe(12);
    expect(weather.getSiteConditions).toHaveBeenCalledTimes(1);
    const [lat, lng, o] = weather.getSiteConditions.mock.calls[0];
    expect(typeof lat).toBe('number');
    expect(typeof lng).toBe('number');
    expect(lat).toBeCloseTo(27.9506, 3);
    expect(lng).toBeCloseTo(-82.4572, 3);
    expect(o).toEqual({ alerts: false });
  });

  test('a lead with no stored coordinates says so — it is never geocoded', async () => {
    // The geocoder mock throws; reaching it would turn this into 'error'.
    const res = await ask(['a-nocoords']);
    expect(res.body.weather['a-nocoords']).toEqual({ status: 'no_coords' });
    expect(weather.getSiteConditions).not.toHaveBeenCalled();
  });

  test('a site outside NWS coverage is not sent upstream', async () => {
    const res = await ask(['a-abroad']);
    expect(res.body.weather['a-abroad'].status).toBe('out_of_range');
    expect(weather.getSiteConditions).not.toHaveBeenCalled();
  });

  test('one failed site costs that site, not the batch', async () => {
    weather.getSiteConditions.mockImplementationOnce(async () => { throw new Error('NWS 503'); });
    const res = await ask(['a-tampa', 'a-orl']);
    const statuses = [res.body.weather['a-tampa'].status, res.body.weather['a-orl'].status].sort();
    expect(statuses).toEqual(['error', 'ok']);
  });
});

describe('the batch', () => {
  test('no ids is an empty answer, not an error', async () => {
    expect((await ask(null)).body).toEqual({ weather: {} });
    expect((await ask([])).body).toEqual({ weather: {} });
  });

  test('more than 120 ids is refused before any lookup', async () => {
    const ids = Array.from({ length: 121 }, (_, i) => 'x' + i);
    const res = await ask(ids);
    expect(res.statusCode).toBe(400);
    expect(weather.getSiteConditions).not.toHaveBeenCalled();
    // ...and 120 is allowed.
    const ok = await ask(ids.slice(0, 120));
    expect(ok.statusCode).toBe(200);
  });
});
