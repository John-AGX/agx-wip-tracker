// Premium Email Hub — E4 rules API. Mounted at /api/email-rules.
//
// Endpoints:
//   GET    /                 the caller's own rules, in order
//   POST   /                 create (validated)
//   PATCH  /:id              update (re-validated)
//   DELETE /:id              delete
//   POST   /preview          DRY RUN — what would this rule have matched?
//
// SCOPING: every statement filters user_id = req.user.id. Rules are
// personal by construction (the dropbox is), so there is no org-shared
// branch to get wrong and no admin path that could file someone else's
// mail.
//
// VALIDATION IS THE POINT of this file. A rule is a standing instruction
// that moves mail unattended, and its failure modes are quiet: one that
// matches everything files a mailbox, one that can never match looks
// identical to one that is merely waiting. validateRule (in
// services/email-rules-match) refuses both, plus forward/auto_reply which
// have no send path behind them. Nothing here trusts a client-side check.
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { validateRule, matchesRule } = require('../services/email-rules-match');

const router = express.Router();

const MAX_RULES_PER_USER = 100;

function newId() {
  return 'erule_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function shape(r) {
  return {
    id: r.id, name: r.name, run_phase: r.run_phase, enabled: r.enabled,
    match_all: r.match_all, stop_on_match: r.stop_on_match, sort: r.sort,
    conditions: r.conditions || [], actions: r.actions || [],
    last_matched_at: r.last_matched_at, match_count: r.match_count,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

// Normalize an incoming rule to the stored shape. Unknown keys are dropped
// rather than merged — a rule blob is evaluated unattended, so it holds
// only fields this file put there.
function clean(body) {
  const b = body || {};
  return {
    name: String(b.name || '').trim().slice(0, 120),
    run_phase: b.run_phase === 'post_triage' ? 'post_triage' : 'inbound',
    enabled: b.enabled !== false,
    match_all: b.match_all !== false,
    stop_on_match: b.stop_on_match === true,
    sort: Number.isFinite(Number(b.sort)) ? Number(b.sort) : 0,
    conditions: (Array.isArray(b.conditions) ? b.conditions : []).slice(0, 20).map((c) => ({
      field: String((c && c.field) || '').trim(),
      op: String((c && c.op) || 'contains').trim(),
      value: typeof (c && c.value) === 'boolean' ? c.value : String((c && c.value) != null ? c.value : '').slice(0, 300),
    })),
    actions: (Array.isArray(b.actions) ? b.actions : []).slice(0, 10).map((a) => ({
      type: String((a && a.type) || '').trim(),
      folder: a && a.folder ? String(a.folder).slice(0, 80) : undefined,
      label: a && a.label ? String(a.label).slice(0, 60) : undefined,
      entity_type: a && a.entity_type ? String(a.entity_type).slice(0, 40) : undefined,
      entity_id: a && a.entity_id ? String(a.entity_id).slice(0, 80) : undefined,
      entity_label: a && a.entity_label ? String(a.entity_label).slice(0, 160) : undefined,
    })),
  };
}

// ── list ────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM email_rules WHERE user_id = $1
        ORDER BY sort ASC, created_at ASC LIMIT ${MAX_RULES_PER_USER}`,
      [req.user.id]
    );
    res.json({ rules: r.rows.map(shape) });
  } catch (e) {
    console.error('GET /api/email-rules error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── create ──────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    if (!req.user.organization_id) return res.status(400).json({ error: 'No organization for caller' });
    const rule = clean(req.body);
    const errs = validateRule(rule);
    if (errs.length) return res.status(400).json({ error: errs[0], errors: errs });

    const count = await pool.query('SELECT COUNT(*)::int AS n FROM email_rules WHERE user_id = $1', [req.user.id]);
    if (count.rows[0].n >= MAX_RULES_PER_USER) {
      return res.status(400).json({ error: 'You already have ' + MAX_RULES_PER_USER + ' rules — delete one first.' });
    }

    const r = await pool.query(
      `INSERT INTO email_rules
         (id, organization_id, user_id, name, run_phase, enabled, match_all, stop_on_match, sort, conditions, actions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
       RETURNING *`,
      [newId(), req.user.organization_id, req.user.id, rule.name, rule.run_phase, rule.enabled,
       rule.match_all, rule.stop_on_match, rule.sort,
       JSON.stringify(rule.conditions), JSON.stringify(rule.actions)]
    );
    res.json({ rule: shape(r.rows[0]) });
  } catch (e) {
    console.error('POST /api/email-rules error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── update ──────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const prior = await pool.query('SELECT * FROM email_rules WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    if (!prior.rowCount) return res.status(404).json({ error: 'Rule not found' });

    // Merge onto the stored rule, then validate the RESULT. Validating
    // only the patch would let a partial edit — flipping run_phase alone —
    // produce a rule that can never match.
    const merged = clean(Object.assign(shape(prior.rows[0]), req.body || {}));
    const errs = validateRule(merged);
    if (errs.length) return res.status(400).json({ error: errs[0], errors: errs });

    const r = await pool.query(
      `UPDATE email_rules
          SET name=$2, run_phase=$3, enabled=$4, match_all=$5, stop_on_match=$6,
              sort=$7, conditions=$8::jsonb, actions=$9::jsonb, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [req.params.id, merged.name, merged.run_phase, merged.enabled, merged.match_all,
       merged.stop_on_match, merged.sort,
       JSON.stringify(merged.conditions), JSON.stringify(merged.actions)]
    );
    res.json({ rule: shape(r.rows[0]) });
  } catch (e) {
    console.error('PATCH /api/email-rules/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── delete ──────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM email_rules WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/email-rules/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /preview — DRY RUN ─────────────────────────────────────────
// "What would this rule have done?" answered against the caller's real
// recent mail, WITHOUT touching a single message.
//
// This is the feature that makes an unattended rule safe to switch on. A
// rule that files mail is easy to write and hard to picture; seeing the
// actual messages it would have caught — including the ones you did not
// expect — is the difference between a tool and a trap. It runs the same
// matcher the engine uses, so what you see is what will happen.
router.post('/preview', requireAuth, async (req, res) => {
  try {
    const rule = clean(req.body);
    const errs = validateRule(rule);
    if (errs.length) return res.status(400).json({ error: errs[0], errors: errs });

    const limit = Math.max(1, Math.min(500, Number(req.body && req.body.scan) || 200));
    const r = await pool.query(
      `SELECT id, thread_id, from_name, from_email, orig_from_email, to_email, subject,
              body_text, has_attachments, direction, entity_type,
              ai_category, triage_urgency, needs_reply, received_at
         FROM inbound_emails
        WHERE user_id = $1 AND direction = 'inbound'
        ORDER BY received_at DESC LIMIT ${limit}`,
      [req.user.id]
    );

    const hits = [];
    for (const m of r.rows) {
      let hit = false;
      try { hit = matchesRule(Object.assign({}, rule, { enabled: true }), m); } catch (e) { hit = false; }
      if (!hit) continue;
      // Enough to recognise the message, no body — the caller is deciding
      // whether a rule is right, not reading their mail here.
      hits.push({
        thread_id: m.thread_id,
        from: m.orig_from_email || m.from_email,
        subject: m.subject,
        received_at: m.received_at,
        ai_category: m.ai_category,
      });
      if (hits.length >= 25) break;
    }

    res.json({
      scanned: r.rows.length,
      matched: hits.length,
      // Says plainly when the sample itself is the limit, so "2 matches"
      // is never mistaken for "only 2 exist".
      truncated: hits.length >= 25,
      hits,
    });
  } catch (e) {
    console.error('POST /api/email-rules/preview error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
