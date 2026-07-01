// Background AI-agent task runner (Background AI Agent Tasks — see the plan).
//
// Drains the `agent_jobs` queue in-process, the same shape as the email-campaigns
// worker: a self-rescheduling setTimeout ticker. Each tick (a) resumes any
// needs_input job the user has answered, and (b) claims one queued job (atomic
// status CAS so it runs once, even if multiple Railway instances tick) and runs
// the headless 86/assistant loop.
//
// S1 = this skeleton (queue claim + lifecycle transitions; runJob/resumeJob are
// stubs). S2 wires runJob to driveSubtaskTurn; S5 wires resumeJob + pause/answer.
'use strict';

const { pool } = require('./db');

const TICK_MS = 10 * 1000;              // 10s cadence — low latency for a "ping me" feel
const FIRST_RUN_DELAY_MS = 30 * 1000;  // 30s warmup after boot
const MAX_CONCURRENT = 2;              // cap parallel running jobs (each is an agent loop)

let _running = 0;

// ── S2 fills this in: run a claimed job's agent loop to completion or a pause. ──
async function runJob(job) {
  console.log('[agent-jobs] runJob stub for ' + job.id + ' — S2 not wired yet; parking as failed');
  await failJob(job.id, new Error('background worker not yet wired (S2)'));
}

// ── S5 fills this in: resume a needs_input job once the user answered. ──
async function resumeJob(job) {
  console.log('[agent-jobs] resumeJob stub for ' + job.id + ' — S5 not wired yet');
}

async function failJob(id, e) {
  try {
    await pool.query(
      "UPDATE agent_jobs SET status='failed', error=$1, completed_at=NOW(), updated_at=NOW() WHERE id=$2",
      [String((e && e.message) || e).slice(0, 2000), id]
    );
  } catch (_) { /* defensive — never throw from the worker */ }
}

async function tick() {
  try {
    // 1. Resume answered pauses (user provided pause_answer). One per tick.
    const resumeR = await pool.query(
      "SELECT * FROM agent_jobs " +
      " WHERE status = 'needs_input' AND pause_answer IS NOT NULL " +
      " ORDER BY paused_at ASC NULLS FIRST LIMIT 1"
    );
    for (const row of resumeR.rows) {
      try { await resumeJob(row); }
      catch (e) { await failJob(row.id, e); }
    }

    // 2. Claim + run one queued job, respecting the concurrency cap. The
    //    UPDATE...FOR UPDATE SKIP LOCKED claim is atomic, so a job is taken once.
    if (_running < MAX_CONCURRENT) {
      const claimR = await pool.query(
        "UPDATE agent_jobs SET status='running', started_at=NOW(), updated_at=NOW() " +
        " WHERE id = (" +
        "   SELECT id FROM agent_jobs WHERE status='queued' " +
        "   ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED" +
        " ) RETURNING *"
      );
      if (claimR.rows.length) {
        const job = claimR.rows[0];
        _running++;
        Promise.resolve()
          .then(function () { return runJob(job); })
          .catch(function (e) { return failJob(job.id, e); })
          .finally(function () { _running--; });
      }
    }
  } catch (e) {
    console.warn('[agent-jobs] tick error:', e && e.message);
  }
}

let _started = false;
function start() {
  if (_started) return;
  _started = true;
  setTimeout(function runTick() {
    tick().catch(function (e) { console.warn('[agent-jobs] tick threw:', e && e.message); });
    setTimeout(runTick, TICK_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log('[agent-jobs] worker armed; tick every ' + (TICK_MS / 1000) + 's');
}

module.exports = {
  start: start,
  tick: tick,
  runJob: runJob,
  resumeJob: resumeJob,
  failJob: failJob
};
