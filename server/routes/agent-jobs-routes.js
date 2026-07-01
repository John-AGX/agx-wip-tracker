// Background AI-agent tasks — the user's view of their own agent_jobs queue.
//
// A task is created by the start_background_task tool (ai-routes.js), run headless
// by the worker (agent-jobs-worker.js → runAgentJob), and (from S5) answered via the
// /answer + /approve|reject endpoints. Everything here is scoped to the caller's own
// jobs (user_id = req.user.id) — no cross-user access.
//
//   GET  /api/agent-jobs?limit=30   → recent tasks + an "attention" badge count
//   GET  /api/agent-jobs/:id        → one task
//   POST /api/agent-jobs/:id/seen   → mark seen (clears it from the badge)

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
console.log('[agent-jobs-routes] mounted at /api/agent-jobs');

router.use(requireAuth, (req, res, next) => {
  // Sub-portal users don't get the background-task surface.
  if (req.user && req.user.role === 'sub') {
    return res.status(403).json({ error: 'Background tasks are not available on the sub portal' });
  }
  next();
});

// GET /api/agent-jobs?limit=30 — the caller's recent background tasks + a badge count
// of the terminal/pause states they haven't seen yet.
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const r = await pool.query(
      "SELECT id, status, title, prompt, result, error, pause_question, pause_kind, " +
      "       created_at, started_at, paused_at, completed_at, seen_at " +
      "  FROM agent_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [req.user.id, limit]
    );
    const b = await pool.query(
      "SELECT COUNT(*)::int AS n FROM agent_jobs " +
      " WHERE user_id = $1 AND seen_at IS NULL AND status IN ('done','needs_input','failed')",
      [req.user.id]
    );
    res.json({ jobs: r.rows, attention: (b.rows[0] && b.rows[0].n) || 0 });
  } catch (e) {
    console.error('GET /api/agent-jobs error:', e);
    res.status(500).json({ error: 'Failed to load background tasks' });
  }
});

// GET /api/agent-jobs/:id — one task (the caller's own).
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM agent_jobs WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json({ job: r.rows[0] });
  } catch (e) {
    console.error('GET /api/agent-jobs/:id error:', e);
    res.status(500).json({ error: 'Failed to load task' });
  }
});

// POST /api/agent-jobs/:id/seen — mark a task seen so it drops off the badge.
router.post('/:id/seen', async (req, res) => {
  try {
    await pool.query(
      'UPDATE agent_jobs SET seen_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/agent-jobs/:id/seen error:', e);
    res.status(500).json({ error: 'Failed to mark seen' });
  }
});

// POST /api/agent-jobs/:id/answer  { answer } — answer a paused (needs_input) task.
// Stores the answer; the background worker resumes the task on its next tick,
// reusing the kept-alive session so the agent continues right where it left off.
router.post('/:id/answer', async (req, res) => {
  try {
    const answer = String((req.body && req.body.answer) || '').trim();
    if (!answer) return res.status(400).json({ error: 'An answer is required' });
    const r = await pool.query(
      "UPDATE agent_jobs SET pause_answer = $1, seen_at = NOW(), updated_at = NOW() " +
      " WHERE id = $2 AND user_id = $3 AND status = 'needs_input' RETURNING id",
      [answer.slice(0, 4000), req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Task not found or not awaiting an answer' });
    res.json({ ok: true, status: 'resuming' });
  } catch (e) {
    console.error('POST /api/agent-jobs/:id/answer error:', e);
    res.status(500).json({ error: 'Failed to submit answer' });
  }
});

module.exports = router;
