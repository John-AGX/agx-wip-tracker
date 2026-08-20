#!/usr/bin/env node
// Recover a sheet drawing destroyed by the 2026-07-12 alias bug, from its
// plan_versions snapshots. SHOW FIRST, ACT ONLY WHEN TOLD.
//
//   node scripts/plan-recover.js --plan <plan_id>
//       Prints the live row's state and every restore point with the number
//       of objects it holds. CHANGES NOTHING. Ends by printing the exact
//       restore command, with the numbers filled in.
//
//   node scripts/plan-recover.js --plan <plan_id> --restore <version_id> \
//        --expect-entities <n> --operator "Your Name"
//       Takes that snapshot. Refuses on any mismatch. Snapshots the current
//       drawing first (so the restore is itself undoable), writes a tier-A
//       audit row, and only then overwrites.
//
//   node scripts/plan-recover.js --list
//       Every plan the census calls DESTROYED, with its best candidate.
//       CHANGES NOTHING. There is deliberately no --restore-all.
//
// ── WHY THERE IS NO AUTOMATIC RESTORE ───────────────────────────────────
// This whole incident is a surface that overwrote a drawing without being
// asked. A tool that walked the destroyed list and pushed snapshots back over
// live rows would be the same failure with better intentions: any plan
// somebody has since redrawn would be silently replaced by a stale copy, and
// the second loss would look like the recovery. So the restore path takes one
// plan, one version, an entity count the operator has actually read, and a
// named human. It refuses everything else.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────
//   * --expect-entities that does not match the snapshot as measured NOW
//     (a stale preview cannot authorise a write).
//   * a snapshot holding zero objects (restoring nothing over something, or
//     over nothing, is never the intent).
//   * a live row that still HAS a drawing, unless --replace-live is passed
//     as well: recovering onto a plan that is not empty is a different and
//     much more dangerous operation than recovering onto one that is.
//   * a missing --operator on the act path. An audit row that cannot name
//     who did it is thin evidence, and this is the one command in the
//     recovery that writes.

'use strict';

const { pool } = require('../server/db');
const { auditActorCritical } = require('../server/audit');
const { inspectPages, classifyPlan } = require('../server/services/plan-doc');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function flag(name) { return process.argv.indexOf('--' + name) >= 0; }

const P = console.log;
const MAX_VERSIONS = 60;

function ageDays(from) {
  if (!from) return null;
  return Math.round((Date.now() - new Date(from).getTime()) / 86400000);
}

async function loadPlan(planId) {
  const { rows } = await pool.query(
    'SELECT id, organization_id, name, base_kind, updated_at, pages FROM plans WHERE id = $1',
    [planId]
  );
  return rows[0] || null;
}

async function loadVersions(plan) {
  const { rows } = await pool.query(
    'SELECT id, created_at, created_by, pages FROM plan_versions ' +
    ' WHERE plan_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT ' + MAX_VERSIONS,
    [plan.id, plan.organization_id]
  );
  return rows;
}

// ── SHOW ────────────────────────────────────────────────────────────────
async function show(planId) {
  const plan = await loadPlan(planId);
  if (!plan) { P('no plan with id %s', planId); process.exitCode = 1; return; }
  const versions = await loadVersions(plan);
  const rep = classifyPlan({ pages: plan.pages, versions });

  P('');
  P('plan     : %s   "%s"', plan.id, plan.name);
  P('org      : %s   kind=%s   last edited %s', plan.organization_id, plan.base_kind,
    plan.updated_at ? new Date(plan.updated_at).toISOString().slice(0, 16).replace('T', ' ') : '?');
  P('state    : %s', String(rep.state).toUpperCase());
  P('right now: %d object(s), %d layer(s) in the live row', rep.entities, rep.layers);
  P('');
  if (!versions.length) {
    P('restore points: NONE. There is nothing to recover from.');
    P('');
    return;
  }
  P('restore points (newest first) — %d loaded:', versions.length);
  P('');
  P('  %s  %s  %s  %s', 'version'.padEnd(10), 'taken'.padEnd(19), 'objects'.padEnd(9), 'age');
  P('  %s', '-'.repeat(58));
  versions.forEach(function (v) {
    const vr = inspectPages(v.pages);
    P('  %s  %s  %s  %s%s',
      String(v.id).padEnd(10),
      new Date(v.created_at).toISOString().slice(0, 16).replace('T', ' ').padEnd(19),
      String(vr.entities).padEnd(9),
      ageDays(v.created_at) + 'd ago',
      vr.entities ? '' : '   (empty — nothing in it)');
  });
  P('');
  if (!rep.candidate) {
    const anyGeom = versions.some((v) => inspectPages(v.pages).entities > 0);
    if (rep.entities > 0) {
      P('This drawing is NOT empty. Nothing needs recovering. If you still want an');
      P('older version, pick one above and pass --replace-live as well — that');
      P('overwrites %d live object(s).', rep.entities);
    } else if (!anyGeom) {
      P('Every restore point is empty too. There is nothing left to recover from.');
      P('This plan is either one nobody ever drew on, or one destroyed early');
      P('enough that its pre-bug snapshots have already been pruned. This tool');
      P('cannot tell those apart and will not guess.');
    }
    P('');
    return;
  }

  const c = rep.candidate;
  P('RECOVERABLE. Newest restore point that still holds a drawing:');
  P('');
  P('    version %s — %d object(s), taken %s (%dd ago)',
    c.id, c.entities, new Date(c.created_at).toISOString().slice(0, 16).replace('T', ' '), ageDays(c.created_at));
  P('');
  P('Taking it would replace the %d object(s) in the live row. The current row', rep.entities);
  P('is snapshotted first, so this is undoable by restoring that snapshot back.');
  P('');
  P('To take it, run exactly:');
  P('');
  P('    node scripts/plan-recover.js --plan %s \\', plan.id);
  P('        --restore %s --expect-entities %d --operator "Your Name"%s',
    c.id, c.entities, rep.entities > 0 ? ' \\\n        --replace-live' : '');
  P('');
}

// ── LIST ────────────────────────────────────────────────────────────────
async function list() {
  const { rows } = await pool.query(
    "SELECT id, organization_id, name, updated_at, pages FROM plans WHERE base_kind = 'sheet' ORDER BY updated_at DESC"
  );
  const hits = [];
  for (const r of rows) {
    if (inspectPages(r.pages).state !== 'empty') continue;
    const v = await pool.query(
      'SELECT id, created_at, pages FROM plan_versions WHERE plan_id = $1 AND organization_id = $2 ' +
      ' ORDER BY created_at DESC LIMIT ' + MAX_VERSIONS, [r.id, r.organization_id]);
    const rep = classifyPlan({ pages: r.pages, versions: v.rows });
    if (rep.state === 'destroyed') hits.push({ r, rep });
  }
  P('');
  if (!hits.length) {
    P('No plan is both empty and covered by a restore point that still holds a');
    P('drawing. Nothing here can be recovered by this tool. That is NOT the same');
    P('as "nothing was lost" — see the EMPTY - CANNOT TELL line in the census.');
    P('');
    return;
  }
  P('%d destroyed plan(s) with a recoverable snapshot:', hits.length);
  P('');
  hits.forEach(({ r, rep }) => {
    P('  %s  org=%s  v%s (%d objects, %dd ago)  "%s"',
      String(r.id).padEnd(30), r.organization_id, rep.candidate.id,
      rep.candidate.entities, ageDays(rep.candidate.created_at), r.name);
  });
  P('');
  P('Nothing above has been changed. Inspect one with:');
  P('    node scripts/plan-recover.js --plan <id>');
  P('');
}

// ── ACT ─────────────────────────────────────────────────────────────────
async function restore(planId, vid, expect, operator) {
  const plan = await loadPlan(planId);
  if (!plan) { P('no plan with id %s', planId); process.exitCode = 1; return; }
  const { rows: vr } = await pool.query(
    'SELECT id, created_at, pages FROM plan_versions WHERE id = $1 AND plan_id = $2 AND organization_id = $3',
    [vid, plan.id, plan.organization_id]
  );
  if (!vr.length) { P('no restore point %s on plan %s', vid, planId); process.exitCode = 1; return; }

  const live = inspectPages(plan.pages);
  const snap = inspectPages(vr[0].pages);

  P('');
  P('  taking   : version %s — %d object(s), taken %s', vid, snap.entities,
    new Date(vr[0].created_at).toISOString().slice(0, 16).replace('T', ' '));
  P('  replacing: the live row — %d object(s)', live.entities);
  P('');

  if (snap.entities !== expect) {
    P('REFUSED. You passed --expect-entities %d but that restore point holds %d.', expect, snap.entities);
    P('The preview you acted on is stale. Re-run without --restore and read the');
    P('current numbers.');
    process.exitCode = 1; return;
  }
  if (!snap.entities) {
    P('REFUSED. That restore point is empty — restoring it cannot bring anything');
    P('back and would overwrite whatever is in the row.');
    process.exitCode = 1; return;
  }
  if (live.entities > 0 && !flag('replace-live')) {
    P('REFUSED. The live row still holds %d object(s). Recovering onto a drawing', live.entities);
    P('that is NOT empty overwrites work somebody may have done since. If that is');
    P('genuinely what you want, add --replace-live.');
    process.exitCode = 1; return;
  }

  const actor = { actorKind: 'system', actorLabel: 'plan-recover-cli:' + operator, orgId: plan.organization_id };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1. Snapshot what is about to be replaced. Unthrottled and unconditional
    //    — this is the undo for the restore itself.
    const safety = await client.query(
      'INSERT INTO plan_versions (plan_id, organization_id, name, pages, totals, created_by) ' +
      'SELECT p.id, p.organization_id, p.name, p.pages, p.totals, NULL FROM plans p ' +
      ' WHERE p.id = $1 AND p.organization_id = $2 RETURNING id',
      [plan.id, plan.organization_id]
    );
    // 2. Tier A, fail closed, in the same transaction: the row and the write
    //    commit together or neither does.
    await auditActorCritical(actor, {
      action: 'plan.version_restore', tier: 'A', outcome: 'ok',
      targetType: 'plan', targetId: String(plan.id), organizationId: plan.organization_id,
      detail: {
        via: 'cli', operator: operator, version_id: Number(vid),
        entities_taken: snap.entities, entities_replaced: live.entities,
        replaced_a_populated_drawing: live.entities > 0,
        undo_version_id: safety.rows[0] && safety.rows[0].id
      }
    }, { client });
    // 3. Overwrite.
    const upd = await client.query(
      'UPDATE plans p SET pages = v.pages, totals = COALESCE(v.totals, p.totals), updated_at = NOW() ' +
      '  FROM plan_versions v WHERE p.id = $1 AND p.organization_id = $2 ' +
      '   AND v.id = $3 AND v.plan_id = p.id AND v.organization_id = p.organization_id RETURNING p.id',
      [plan.id, plan.organization_id, vid]
    );
    if (!upd.rows.length) throw new Error('restore matched no row');
    await client.query('COMMIT');
    P('RESTORED. %d object(s) are back on plan %s.', snap.entities, plan.id);
    P('');
    P('Undo: the pre-restore state was saved as version %s.',
      safety.rows[0] && safety.rows[0].id);
    P('    node scripts/plan-recover.js --plan %s --restore %s --expect-entities %d --operator "%s"%s',
      plan.id, safety.rows[0] && safety.rows[0].id, live.entities, operator,
      snap.entities > 0 ? ' --replace-live' : '');
    P('');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    if (e && e.auditFailure) {
      P('REFUSED. The audit row could not be written, so nothing was changed.');
      P('A recovery that cannot be recorded does not happen.');
    } else {
      P('restore failed: %s — nothing was changed.', e && e.message);
    }
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

async function main() {
  const planId = arg('plan');
  if (flag('list')) return list();
  if (!planId) {
    P('');
    P('usage:');
    P('  node scripts/plan-recover.js --list');
    P('  node scripts/plan-recover.js --plan <plan_id>');
    P('  node scripts/plan-recover.js --plan <plan_id> --restore <version_id> \\');
    P('       --expect-entities <n> --operator "Your Name" [--replace-live]');
    P('');
    process.exitCode = 1; return;
  }
  const vid = arg('restore');
  if (!vid) return show(planId);

  const expectRaw = arg('expect-entities');
  const operator = arg('operator');
  if (expectRaw == null || !/^\d+$/.test(String(expectRaw))) {
    P('REFUSED. --expect-entities <n> is required: pass the object count you were');
    P('shown for that restore point. Run without --restore to see it.');
    process.exitCode = 1; return;
  }
  if (!operator || !String(operator).trim()) {
    P('REFUSED. --operator "Your Name" is required. This command writes, and the');
    P('audit row has to name a human.');
    process.exitCode = 1; return;
  }
  return restore(planId, parseInt(vid, 10), parseInt(expectRaw, 10), String(operator).trim());
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('plan-recover failed:', e.message); pool.end(); process.exitCode = 1; });
