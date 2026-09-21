// BUILDERTREND'S MARKET, on a Project 86 job or client.
//
// Buildertrend's Market is a DROPDOWN custom field, and what Clickr sends for
// it is not the market's name: it is a one-item list holding the chosen
// option's ID (live scout, 2026-09-21: 5 distinct IDs on contacts, 3 on jobs —
// the two record types carry separate Market fields, so separate IDs). The
// names are not in the data at all. So an ID means a market only once a person
// has said which one, and that answer is kept on the organisation:
//
//   organizations.settings.btMarketMap = { jobs: { '<optionId>': '<markets.id>' },
//                                          clients: { ... } }
//
// The preview shows the evidence to decide from — for each option, how the
// records carrying it that are ALREADY LINKED to P86 are filed there, and
// where Buildertrend says those records are — and suggests a market only when
// the linked records agree. Nothing is ever filled from an unmapped option.
//
// A mapped option is then an ordinary field on the contact rule: a P86 record
// with no market is filled; one filed under a different market is held back
// for a tick; a Buildertrend record with no option never erases a P86 market.
// Market is a DIMENSION in P86 (markets table + market_id), not free text, so
// what is written is market_id — with the legacy text beside it, which is what
// every surface falls back to when the id is missing.
'use strict';

const KINDS = ['jobs', 'clients'];
const OPTION_MAX = 64;

// The option a record's Market field holds, as a string, or null. A one-item
// list is its item; anything else (no field, an empty or several-item list, an
// object) is no option — never a guess at one.
function optionOf(v) {
  let x = v;
  if (Array.isArray(x)) {
    if (x.length !== 1) return null;
    x = x[0];
  }
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  if (typeof x === 'string') {
    const t = x.trim();
    if (t && t.length <= OPTION_MAX && !/[\u0000-\u001f\u007f]/.test(t)) return t;
  }
  return null;
}

function parseSettings(s) {
  if (s && typeof s === 'object') return s;
  if (typeof s === 'string') {
    try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }
  return {};
}

// { jobs: {optionId: marketId}, clients: {...} } out of organizations.settings,
// every key and id a string. Anything malformed is dropped, not repaired.
function mapFrom(settings) {
  const raw = parseSettings(settings).btMarketMap;
  const out = { jobs: {}, clients: {} };
  for (const k of KINDS) {
    const m = raw && raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k]) ? raw[k] : {};
    for (const opt of Object.keys(m)) {
      const id = m[opt];
      if (id == null || !/^\d{1,18}$/.test(String(id))) continue;
      out[k][opt] = String(id);
    }
  }
  return out;
}

// What the matcher is handed, per dataset: the map and this organisation's
// markets by id. A mapping to a market this organisation no longer has is not
// a market.
function contexts(marketRows, settings) {
  const markets = new Map((marketRows || []).map((m) => [String(m.id), { id: String(m.id), name: String(m.name || ''), active: m.active !== false }]));
  const map = mapFrom(settings);
  return { jobs: { map: map.jobs, markets }, clients: { map: map.clients, markets }, list: [...markets.values()] };
}

// The P86 market a Buildertrend option means, or null.
function btMarket(optionId, ctx) {
  if (!optionId || !ctx || !ctx.map) return null;
  const id = ctx.map[optionId];
  if (id == null) return null;
  return (ctx.markets && ctx.markets.get(String(id))) || null;
}

// The proposal, on the contact rule. `bt.market` is btMarket()'s answer, set on
// the Buildertrend side of the row by the matcher; `p.marketId` is the P86
// record's market_id ('' when it has none).
function proposal(acc, bt, p, ctx) {
  const m = bt && bt.market;
  if (!m) return;
  const cur = p && p.marketId ? String(p.marketId) : '';
  if (cur === String(m.id)) return;
  if (!cur) {
    acc.corrections.push({ field: 'market', label: 'Market', kind: 'fill', from: '', to: m.name, value: String(m.id) });
    return;
  }
  const had = ctx && ctx.markets ? ctx.markets.get(cur) : null;
  acc.heldBack.push({ field: 'market', label: 'Market', reason: 'differs', bt: m.name, p86: had ? had.name : 'another market',
    p86Id: cur, value: String(m.id), applicable: true,
    note: 'P86 files this under a different market. Never applied automatically — tick it to move it to Buildertrend\'s.' });
}

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, c]) => ({ value: k, count: c }));
}

// The evidence for each option a dataset's records carry. A suggestion is made
// only when the linked records that are filed in P86 AGREE: at least
// SUGGEST_MIN of them, and at least SUGGEST_SHARE under one market.
const SUGGEST_MIN = 3;
const SUGGEST_SHARE = 0.9;
function evidence(rows, ctx) {
  const by = new Map();
  for (const r of rows || []) {
    const opt = r.bt && r.bt.marketOption;
    if (!opt) continue;
    let e = by.get(opt);
    if (!e) {
      e = { optionId: opt, records: 0, linked: 0, filed: new Map(), unfiled: 0, states: new Map(), cities: new Map() };
      by.set(opt, e);
    }
    e.records++;
    const st = String(r.bt.state || '').trim().toUpperCase();
    if (st) e.states.set(st, (e.states.get(st) || 0) + 1);
    const city = String(r.bt.city || '').trim();
    if (city) e.cities.set(city, (e.cities.get(city) || 0) + 1);
    if ((r.class === 'matched' || r.class === 'conflict') && r.p86) {
      e.linked++;
      const mid = r.p86.marketId ? String(r.p86.marketId) : '';
      if (mid) e.filed.set(mid, (e.filed.get(mid) || 0) + 1);
      else e.unfiled++;
    }
  }
  const nameOf = (id) => {
    const m = ctx && ctx.markets ? ctx.markets.get(String(id)) : null;
    return m ? m.name : null;
  };
  return [...by.values()].sort((a, b) => b.records - a.records || (a.optionId < b.optionId ? -1 : 1)).map((e) => {
    const p86 = top(e.filed, 20).filter((x) => nameOf(x.value)).map((x) => ({ marketId: x.value, name: nameOf(x.value), count: x.count }));
    const filed = p86.reduce((s, x) => s + x.count, 0);
    const lead = p86[0];
    const mappedTo = ctx && ctx.map ? ctx.map[e.optionId] || null : null;
    return {
      optionId: e.optionId,
      records: e.records,
      linked: e.linked,
      p86,
      unfiled: e.unfiled,
      states: top(e.states, 3),
      cities: top(e.cities, 3),
      suggestion: lead && filed >= SUGGEST_MIN && lead.count / filed >= SUGGEST_SHARE ? lead.marketId : null,
      mappedTo: mappedTo && nameOf(mappedTo) ? mappedTo : null,
      mappedName: mappedTo ? nameOf(mappedTo) : null,
      // Mapped to a market that has since been deleted: shown so it can be
      // re-pointed, and treated everywhere else as unmapped.
      mappedGone: !!(mappedTo && !nameOf(mappedTo)),
    };
  });
}

// Is this a market of this organisation? Re-proved at every write: a mapping is
// saved once and used for months, and the FK alone would accept another
// tenant's market id.
async function ownMarket(db, orgId, marketId) {
  if (marketId == null || !/^\d{1,18}$/.test(String(marketId))) return null;
  const r = await db.query('SELECT id, name FROM markets WHERE id = $1 AND organization_id = $2', [String(marketId), orgId]);
  return r.rows[0] ? { id: String(r.rows[0].id), name: String(r.rows[0].name || '') } : null;
}

// ── the door: PUT /me?action=buildertrend-market-map ─────────────────────
// { kind: 'jobs'|'clients', optionId, marketId }  (marketId null = unmap)
// Behind the route's requireAuth + requireOrg + ROLES_MANAGE, and the same
// owner-organisation gate as the preview and apply. Read-modify-write under
// the organisation row's own lock, touching btMarketMap and nothing else in
// settings.
async function handleMap(req, res, deps) {
  const env = (deps && deps.env) || process.env;
  const org = req.organization;
  const preview = require('./sync-preview');
  if (!org || org.id == null) return res.status(403).json({ error: 'Market mapping needs an organization.' });
  if (String(org.slug || '') !== preview.ownerSlug(env)) {
    return res.status(403).json({ error: 'Market mapping is not available for this organization. The Buildertrend connection on this server belongs to a different company.', code: 'CLICKR_NOT_THIS_ORG' });
  }
  const b = req.body || {};
  if (KINDS.indexOf(b.kind) === -1) return res.status(400).json({ error: 'kind must be "jobs" or "clients".' });
  const optionId = (typeof b.optionId === 'string' || typeof b.optionId === 'number') ? optionOf(String(b.optionId)) : null;
  if (!optionId) return res.status(400).json({ error: 'optionId must name a Buildertrend Market option.' });
  const unmap = b.marketId === null || b.marketId === '';
  if (!unmap && !/^\d{1,18}$/.test(String(b.marketId))) return res.status(400).json({ error: 'marketId must be one of this organization\'s markets, or null to unmap.' });

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    let market = null;
    if (!unmap) {
      market = await ownMarket(client, org.id, b.marketId);
      if (!market) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'That market is not one of this organization\'s.' }); }
    }
    const cur = await client.query('SELECT settings FROM organizations WHERE id = $1 FOR UPDATE', [org.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Organization not found.' }); }
    const settings = Object.assign({}, parseSettings(cur.rows[0].settings));
    const map = mapFrom(settings);
    if (unmap) delete map[b.kind][optionId];
    else map[b.kind][optionId] = market.id;
    settings.btMarketMap = map;
    await client.query('UPDATE organizations SET settings = $1::jsonb, updated_at = NOW() WHERE id = $2', [JSON.stringify(settings), org.id]);
    await client.query('COMMIT');
    try {
      require('../../audit').auditLog(req, {
        action: 'buildertrend.market_map', targetType: 'organization', targetId: String(org.id), organizationId: org.id,
        detail: { kind: b.kind, optionId, marketId: market ? market.id : null, market: market ? market.name : null },
      });
    } catch (e) { /* the mapping is saved; an audit hiccup does not undo it */ }
    res.set('Cache-Control', 'no-store');
    res.json({ kind: b.kind, optionId, marketId: market ? market.id : null, market: market ? market.name : null, map });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('PUT buildertrend-market-map error:', e && e.message);
    res.status(500).json({ error: 'The market mapping could not be saved.' });
  } finally {
    client.release();
  }
}

module.exports = { optionOf, mapFrom, contexts, btMarket, proposal, evidence, ownMarket, handleMap, KINDS, SUGGEST_MIN, SUGGEST_SHARE };
