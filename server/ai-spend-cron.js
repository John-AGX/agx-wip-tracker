// AI spend alarm — emails the system admin when trailing-24h Anthropic
// token spend crosses a threshold.
//
// WHY THIS EXISTS: AI spend was fully observable and completely
// unwatched. The admin console can attribute every token to an agent and
// a job, but only when someone opens it and looks. A runaway loop at 3am
// — a retry storm, a wedged background job, a prompt that recurses — is
// invisible until the next time somebody happens to check the page or
// the invoice arrives. This turns an on-demand number into a signal that
// arrives on its own.
//
// SCOPE IS ACCOUNT-WIDE, NOT PER-ORG — by choice. The Anthropic bill is
// one account-level number, so that is the number worth alarming on.
// (ai_messages does carry a nullable organization_id, so a per-org split
// is possible — but rows with a NULL org would silently drop out of it,
// and a spend alarm that quietly ignores some of the spend is worse than
// one that reports a single honest total.)
//
// COST SOURCES — both, and this matters:
//   1. ai_messages  — interactive chat turns
//   2. agent_jobs   — headless background runs, which roll tokens up per
//                     job and are THE largest consumer. An alarm reading
//                     only chat would sit silent through exactly the
//                     runaway it exists to catch, because the runaway is
//                     a background job.
//
// Both are priced CACHE-AWARE. Note the two tables spell the cache
// columns differently — ai_messages uses cache_creation_input_tokens /
// cache_read_input_tokens, agent_jobs uses cache_creation_tokens /
// cache_read_tokens. Missing that on the chat side would under-report
// spend, which for an alarm is the dangerous direction to be wrong in.
//
// FAIL-SAFE POSTURE: enabled by default at a threshold far above normal
// operation. An alarm nobody remembered to switch on is not an alarm, and
// the cost of a spurious email is a rounding error next to the cost of a
// silent overrun. Set AI_SPEND_DAILY_ALERT_USD=0 to disable.

'use strict';

const { pool } = require('./db');
const { sendEmail } = require('./email');
const pricing = require('./services/ai-pricing');

const ONE_HOUR_MS = 60 * 60 * 1000;
// Five minutes after boot: long enough that a redeploy isn't immediately
// followed by a query, short enough that a deploy made *because* spend is
// running away gets an answer promptly.
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

// ~65× the observed pilot run rate (≈$0.37/day). Chosen so it cannot fire
// on ordinary use — a threshold that cries wolf gets muted, and a muted
// alarm is worse than none.
const DEFAULT_THRESHOLD_USD = 25;

const LOG_KEY = 'ai_spend_alert_log';

function thresholdUsd() {
  const raw = process.env.AI_SPEND_DAILY_ALERT_USD;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_THRESHOLD_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_THRESHOLD_USD;
  return n;   // 0 disables
}

function recipient() {
  return (process.env.SYSTEM_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim() || null;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

async function loadLog() {
  try {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [LOG_KEY]);
    return (r.rows.length && r.rows[0].value) || {};
  } catch (e) {
    console.warn('[ai-spend] log load failed:', e.message);
    return {};
  }
}

async function saveLog(log) {
  try {
    await pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2) ' +
      'ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
      [LOG_KEY, JSON.stringify(log)]
    );
  } catch (e) {
    console.warn('[ai-spend] log save failed:', e.message);
  }
}

/**
 * Trailing-24h spend, in USD, split by source. Pure read — no writes, no
 * side effects, safe to call from a diagnostic.
 */
async function computeSpend() {
  // 1. Interactive chat. Grouped by model so each is priced at its own
  //    rate rather than one blended guess — a Haiku-heavy day and an
  //    Opus-heavy day cost very differently for the same token count.
  const chatRes = await pool.query(`
    SELECT COALESCE(model, 'unknown') AS model,
           COALESCE(SUM(input_tokens),  0)::bigint                AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint                AS output_tokens,
           COALESCE(SUM(cache_creation_input_tokens), 0)::bigint  AS cache_creation,
           COALESCE(SUM(cache_read_input_tokens), 0)::bigint      AS cache_read
      FROM ai_messages
     WHERE created_at >= NOW() - INTERVAL '24 hours'
       AND role = 'assistant'
     GROUP BY model
  `);
  let chatUsd = 0;
  for (const r of chatRes.rows) {
    chatUsd += pricing.cacheCostRaw(
      r.model, r.input_tokens, r.output_tokens, r.cache_creation, r.cache_read
    );
  }

  // 2. Background jobs. Cache-aware — these rows DO carry cache columns.
  //    Priced at the live default model, matching how the admin metrics
  //    page prices them, so the two agree.
  const bgModel = process.env.AI_MODEL || 'claude-opus-4-8';
  const bgRes = await pool.query(`
    SELECT COUNT(*)::int                                   AS jobs,
           COALESCE(SUM(input_tokens), 0)::bigint          AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint         AS output_tokens,
           COALESCE(SUM(cache_creation_tokens), 0)::bigint AS cache_creation,
           COALESCE(SUM(cache_read_tokens), 0)::bigint     AS cache_read
      FROM agent_jobs
     WHERE created_at >= NOW() - INTERVAL '24 hours'
  `);
  const bg = bgRes.rows[0] || {};
  const bgUsd = pricing.cacheCostRaw(
    bgModel, bg.input_tokens, bg.output_tokens, bg.cache_creation, bg.cache_read
  );

  return {
    chatUsd,
    bgUsd,
    totalUsd: chatUsd + bgUsd,
    bgJobs: Number(bg.jobs || 0),
    chatTurns: chatRes.rows.length,
    byModel: chatRes.rows.map((r) => ({
      model: r.model,
      usd: pricing.cacheCostRaw(
        r.model, r.input_tokens, r.output_tokens, r.cache_creation, r.cache_read
      ),
    })),
  };
}

function money(n) { return '$' + Number(n || 0).toFixed(2); }

function buildEmail(spend, limit) {
  const rows = spend.byModel
    .filter((m) => m.usd >= 0.01)
    .sort((a, b) => b.usd - a.usd)
    .map((m) => '  ' + m.model + ' — ' + money(m.usd))
    .join('\n') || '  (no chat spend)';

  const text = [
    'AI spend in the last 24 hours has crossed the alert threshold.',
    '',
    '  Total (24h):   ' + money(spend.totalUsd),
    '  Threshold:     ' + money(limit),
    '',
    '  Interactive chat:  ' + money(spend.chatUsd),
    '  Background jobs:   ' + money(spend.bgUsd) + '  (' + spend.bgJobs + ' job' + (spend.bgJobs === 1 ? '' : 's') + ')',
    '',
    'Chat by model:',
    rows,
    '',
    'Where to look: Admin → Agents → usage forensics attributes tokens to',
    'a specific agent and job.',
    '',
    'Note: both sources are priced cache-aware from stored token counts,',
    'but this is a spend SIGNAL computed from our own records — not the',
    'invoice. Check the Anthropic console for the billed figure.',
    '',
    'To change the threshold, set AI_SPEND_DAILY_ALERT_USD. Set it to 0 to',
    'disable this alert.',
  ].join('\n');

  return {
    subject: 'Project 86 — AI spend alert: ' + money(spend.totalUsd) + ' in 24h',
    text,
  };
}

async function runOnce() {
  const limit = thresholdUsd();
  if (!limit) return;   // 0 / negative → disabled

  const to = recipient();
  if (!to) {
    console.warn('[ai-spend] no SYSTEM_ADMIN_EMAIL or ADMIN_EMAIL set — spend alerts cannot be delivered');
    return;
  }

  let spend;
  try {
    spend = await computeSpend();
  } catch (e) {
    console.warn('[ai-spend] spend query failed:', e.message);
    return;
  }
  if (spend.totalUsd < limit) return;

  const day = utcDay();
  const log = await loadLog();
  const prior = log[day] && Number(log[day].alerted_usd) || 0;

  // Alert at most once a day at a given level, but ESCALATE: if spend has
  // doubled since the last alert, that is a new fact and deserves a new
  // email. A flat once-per-day rule would report $26 at noon and stay
  // silent while the same runaway reached $2,600 by evening.
  if (prior && spend.totalUsd < prior * 2) return;

  const mail = buildEmail(spend, limit);
  try {
    const res = await sendEmail({
      to,
      subject: mail.subject,
      text: mail.text,
      tag: 'ai_spend_alert',
    });
    if (!res || !res.ok) {
      // Do NOT record the alert as sent — otherwise a delivery failure
      // silently consumes the day's one notification and the alarm goes
      // quiet for 24h having told nobody anything.
      console.warn('[ai-spend] alert send failed:', (res && res.error) || 'unknown');
      return;
    }
  } catch (e) {
    console.warn('[ai-spend] alert send threw:', e.message);
    return;
  }

  log[day] = { alerted_usd: spend.totalUsd, at: new Date().toISOString() };
  // Keep only the last 30 days so the blob stays small.
  const keep = Object.keys(log).sort().slice(-30);
  const pruned = {};
  keep.forEach((k) => { pruned[k] = log[k]; });
  await saveLog(pruned);

  console.log('[ai-spend] ALERT sent — ' + money(spend.totalUsd) + ' in 24h (threshold ' + money(limit) + ')');
}

function start() {
  const limit = thresholdUsd();
  if (!limit) {
    console.log('[ai-spend] alerts disabled (AI_SPEND_DAILY_ALERT_USD=0)');
    return;
  }
  console.log('[ai-spend] spend alarm armed at ' + money(limit) + ' / 24h');
  setTimeout(function tick() {
    runOnce().catch((e) => console.warn('[ai-spend] tick error:', e && e.message));
    setTimeout(tick, ONE_HOUR_MS);
  }, FIRST_RUN_DELAY_MS);
}

module.exports = { start, runOnce, computeSpend, thresholdUsd };
