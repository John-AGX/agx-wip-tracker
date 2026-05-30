// Wave 1.B — Context Registry helper.
//
// One concern: log "a piece of context loaded for the AI" without
// blowing up the calling tool if the log write fails. Tools must
// continue working even if the registry table is down, missing, or
// schema-drifted — registry data is observational, not load-bearing.
//
// Usage:
//   const { logContextLoad } = require('../services/context-registry');
//   logContextLoad(pool, {
//     organization_id, user_id,
//     layer: 'memory',           // 'memory' | 'entity_read' | 'entity_search' | 'turn_context' | 'skill' | 'watch'
//     item_id: row.id,           // (optional) string identifier
//     item_name: row.topic,      // (optional) human-readable name
//     item_meta: { kind, importance, score }  // (optional) JSONB context
//   });
//
// Returns: nothing (fire-and-forget). Don't await it from hot paths
// where a stalled DB would hurt user perception — but DO await it
// from cold paths (admin endpoints, migrations) so errors surface.
//
// The point of NOT awaiting is the helper handles its own promise
// chain via .catch, so an unhandled rejection won't crash the server.

/**
 * Log a context-load event. Fire-and-forget by default — caller
 * doesn't await. Catches all errors and logs them to console.warn.
 *
 * Multiple items can be logged in one call via the `items` array shape
 * — useful for recall (returns N memories) or search_entities (returns
 * N results). The function batches them into a single INSERT.
 *
 * @param {Pool} pool — pg Pool
 * @param {object} args
 * @param {number} args.organization_id  — REQUIRED, FK to organizations
 * @param {number} [args.user_id]        — actor user_id (nullable for system loads)
 * @param {string} args.layer            — REQUIRED, see header comment for values
 * @param {string} [args.item_id]        — identifier on the loaded item
 * @param {string} [args.item_name]      — human-readable label
 * @param {object} [args.item_meta]      — layer-specific JSONB context
 * @param {Array}  [args.items]          — alternative to item_*: array of {item_id, item_name, item_meta}
 *                                          for batched inserts. When present, item_id/item_name/item_meta
 *                                          on the args are ignored.
 */
function logContextLoad(pool, args) {
  if (!pool || !args || !args.organization_id || !args.layer) return;

  // Resolve to a uniform list of items to insert.
  const list = Array.isArray(args.items) && args.items.length
    ? args.items
    : [{
        item_id: args.item_id,
        item_name: args.item_name,
        item_meta: args.item_meta
      }];

  // Build a multi-row INSERT. Each row gets ($1, $2, $3, ..., $7N+ ...).
  // For typical N (1–10) this is well within Postgres parameter limits.
  const values = [];
  const placeholders = [];
  let p = 1;
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    placeholders.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5})`);
    values.push(
      args.organization_id,
      args.user_id || null,
      args.layer,
      it.item_id || null,
      it.item_name || null,
      it.item_meta ? JSON.stringify(it.item_meta) : null
    );
    p += 6;
  }

  const sql = `
    INSERT INTO context_load_events
      (organization_id, user_id, layer, item_id, item_name, item_meta)
    VALUES ${placeholders.join(', ')}
  `;

  // Fire and forget. Single .catch to swallow + log; never throws.
  pool.query(sql, values).catch(function(err) {
    // Don't spam the log if the table doesn't exist yet — Railway
    // deploys finish DB init asynchronously and the first few requests
    // can race that. After init the table is there.
    if (err && err.code === '42P01') return; // undefined_table
    console.warn('[context-registry] logContextLoad failed:', err && err.message);
  });
}

module.exports = { logContextLoad };
