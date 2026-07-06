// Training-example capture — the proprietary-model data flywheel.
//
// captureExample() records one (model output, human correction) pair into
// ai_training_examples. Fire-and-forget by design: a capture failure must
// NEVER break the user action it rides on (same contract as
// usage-meter.js recordUsage). Callers can await it or not.
//
// The rows feed GET /api/admin/agents/training-export (JSONL for LoRA
// fine-tuning — see docs/proprietary-model-v1.md) and the admin
// "Training data" readiness card. Image BYTES are never stored — pass
// attachment ids/refs in `input` instead.

'use strict';

const { pool } = require('../db');

// Canonical task names — reference these, don't drift on spelling.
const TASKS = {
  RECEIPT_FIELDS: 'receipt_fields',       // receipt photo -> {vendor,date,cost_code,amount}
  COST_CODE: 'cost_code',                 // receipt context -> materials|labor|sub|gc
  SCRIBE_PAYLOAD: 'scribe_payload',       // write intent -> payload ops (approve/reject signal)
  LEAD_EXTRACT: 'lead_extract',           // lead doc pages -> structured lead fields
  PO_EXTRACT: 'po_extract',               // Buildertrend PO PDF pages -> structured PO fields
  MATERIAL_NORMALIZE: 'material_normalize' // raw vendor description -> clean desc/category/unit
};

// Fine-tune viability thresholds per task — the readiness card renders
// "count / threshold". Rough LoRA-SFT floors for a narrow single task;
// tune as the pilot (docs/proprietary-model-v1.md) learns.
const THRESHOLDS = {
  [TASKS.COST_CODE]: 500,
  [TASKS.RECEIPT_FIELDS]: 1500,
  [TASKS.SCRIBE_PAYLOAD]: 1000,
  [TASKS.LEAD_EXTRACT]: 300,
  [TASKS.PO_EXTRACT]: 300,
  [TASKS.MATERIAL_NORMALIZE]: 400
};

function exampleId() {
  return 'tex_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// Record one example. Never throws; invalid/missing core fields are a
// silent no-op. `id` may be passed for deterministic dedupe (backfills,
// two-phase captures) — ON CONFLICT DO NOTHING makes re-captures safe.
async function captureExample({ id, orgId, task, sourceKind, sourceId, input, modelOutput, humanFinal, accepted, model }) {
  try {
    const org = Number(orgId);
    if (!org || !task) return;
    await pool.query(
      `INSERT INTO ai_training_examples
         (id, organization_id, task, source_kind, source_id, input, model_output, human_final, accepted, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        id || exampleId(), org, String(task),
        sourceKind != null ? String(sourceKind) : null,
        sourceId != null ? String(sourceId) : null,
        input != null ? JSON.stringify(input) : null,
        modelOutput != null ? JSON.stringify(modelOutput) : null,
        humanFinal != null ? JSON.stringify(humanFinal) : null,
        typeof accepted === 'boolean' ? accepted : null,
        model != null ? String(model) : null
      ]
    );
  } catch (e) {
    console.warn('[training-capture] captureExample failed task=' + task + ':', e.message);
  }
}

// Per-task rollup for the admin readiness card:
// [{ task, examples, accepted, corrected, last_at, threshold }]
async function taskCounts() {
  try {
    const r = await pool.query(
      `SELECT task,
              COUNT(*)::int AS examples,
              COUNT(*) FILTER (WHERE accepted IS TRUE)::int  AS accepted,
              COUNT(*) FILTER (WHERE accepted IS FALSE)::int AS corrected,
              MAX(created_at) AS last_at
         FROM ai_training_examples
        GROUP BY task
        ORDER BY examples DESC`
    );
    return r.rows.map((row) => Object.assign({}, row, {
      threshold: THRESHOLDS[row.task] || null
    }));
  } catch (e) {
    console.warn('[training-capture] taskCounts failed:', e.message);
    return [];
  }
}

module.exports = { TASKS, THRESHOLDS, captureExample, taskCounts, exampleId };
