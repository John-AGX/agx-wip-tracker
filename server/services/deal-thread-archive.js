'use strict';

// Archive deal threads that hang from ANOTHER tenant's lineage. Runs on every
// boot (server/index.js, after init + role cache, before listen).
//
// WHY. Before resolveLineageRoot was org-scoped (leak2, 31d779ea) the deal
// resolver walked lead / estimate / job ids by bare id, so a user in org A who
// named org B's job minted — or resumed — a deal thread keyed on org B's
// lineage. Those ai_sessions rows are still in production and their history
// carries org B's contract and notes. The leak2 change stopped RESUMING them;
// this step stops LISTING them. The owner authorised archiving them.
//
// RULES (each one is asserted by test/deal-thread-archive.test.js):
//   - archive-only: `archived_at = NOW()`, the exact write the product already
//     uses to archive a session (ai-routes.js archiveActiveAiSession; PATCH
//     /api/ai/sessions/:id archived=true). The sidebar list hides
//     archived_at IS NOT NULL unless ?include_archived=1, and every resume path
//     requires archived_at IS NULL. No row and no message is deleted.
//   - only session_kind = 'deal_thread', only rows not already archived — so
//     a second run archives 0.
//   - only when the lineage root EXISTS and every row carrying that id is
//     stamped with an organization different from the session user's
//     (deal-memory.js lineageRootPlacement, the same definition the explicit
//     load refusals use). A missing root, an un-stamped (legacy) root, a
//     same-org root and a session whose user has no org are all left alone and
//     counted separately.
//   - ai_sessions has no reason column, so the reason is the log: one line per
//     (session org -> root org) pair, then one summary line.

const { lineageRootPlacements } = require('./deal-memory');

async function archiveForeignDealThreads(db, opts) {
  const log = (opts && typeof opts.log === 'function') ? opts.log : (m) => console.log(m);
  const counts = { scanned: 0, archived: 0, sameOrg: 0, missingRoot: 0, noLineageRoot: 0, sessionOrgUnresolved: 0, pairs: {} };

  const r = await db.query(
    `SELECT s.id, s.lineage_root, u.organization_id AS session_org
       FROM ai_sessions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.session_kind = 'deal_thread'
        AND s.archived_at IS NULL
      ORDER BY s.id ASC`
  );

  // One batched placement check per distinct session org.
  const rootsByOrg = new Map();
  for (const row of r.rows) {
    if (row.lineage_root == null || String(row.lineage_root) === '' || row.session_org == null) continue;
    const k = String(row.session_org);
    if (!rootsByOrg.has(k)) rootsByOrg.set(k, { orgId: row.session_org, roots: [] });
    rootsByOrg.get(k).roots.push(row.lineage_root);
  }
  const placedByOrg = new Map();
  for (const [k, v] of rootsByOrg) placedByOrg.set(k, await lineageRootPlacements(db, v.roots, v.orgId));

  const byPair = new Map();   // 'sessionOrg->rootOrg' -> [session ids]
  for (const row of r.rows) {
    counts.scanned++;
    if (row.lineage_root == null || String(row.lineage_root) === '') { counts.noLineageRoot++; continue; }
    if (row.session_org == null) { counts.sessionOrgUnresolved++; continue; }
    const { placement, rootOrgId } = placedByOrg.get(String(row.session_org)).get(String(row.lineage_root));
    if (placement === 'missing') { counts.missingRoot++; continue; }
    if (placement !== 'foreign') { counts.sameOrg++; continue; }
    const key = String(row.session_org) + '->' + String(rootOrgId);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(row.id);
  }

  for (const [key, sessionIds] of byPair) {
    // Re-asserts kind + not-archived in the write itself, so a row that changed
    // between the scan and here is not touched.
    const u = await db.query(
      `UPDATE ai_sessions SET archived_at = NOW()
        WHERE id = ANY($1::bigint[])
          AND session_kind = 'deal_thread'
          AND archived_at IS NULL`,
      [sessionIds]
    );
    const n = u.rowCount || 0;
    counts.archived += n;
    counts.pairs[key] = n;
    const [from, to] = key.split('->');
    log('[deal-thread-archive] org ' + from + ' deal threads on org ' + to + ' lineage: archived ' + n);
  }

  log('[deal-thread-archive] scanned ' + counts.scanned + ' active deal thread(s): archived ' + counts.archived +
    ', same-org ' + counts.sameOrg + ', missing root ' + counts.missingRoot + ' (left), no lineage root ' +
    counts.noLineageRoot + ' (left), user without org ' + counts.sessionOrgUnresolved + ' (left)');
  return counts;
}

module.exports = { archiveForeignDealThreads };
