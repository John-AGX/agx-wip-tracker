// AI estimating assistant — read-only chat panel attached to each estimate.
//
// Phase 1 (this file): the assistant can READ the estimate's full context
// (lines, scope, client, photos) and answer questions / draft scopes /
// flag missing items. It cannot modify the estimate. Phase 2 will add
// tool-use so Claude can propose changes the user approves.
//
// Per-user history: rows in ai_messages are partitioned by user_id so PMs
// each see their own conversation per estimate (two PMs working the same
// estimate don't see each other's prompts).
//
// Streaming uses Server-Sent Events. The frontend reads via fetch + a body
// reader since EventSource doesn't support POST.

const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { requireAuth, requireCapability, hasCapability } = require('../auth');
const { storage } = require('../storage');

const router = express.Router();

// Lazy SDK init — reads ANTHROPIC_API_KEY on first request rather than at
// module-load time. This is more robust against Railway's deploy timing:
// if the env var was set after the build started, a module-level capture
// would miss it and we'd serve "not configured" forever until restart.
// Lazy lookup re-checks on every request, so a fix-and-redeploy works.
let _anthropicClient = null;
let _anthropicKey = null;
function getAnthropic() {
  const raw = process.env.ANTHROPIC_API_KEY || '';
  const key = raw.trim();
  if (!key) return null;
  // Recreate the client if the key changed (rare, but possible on rotation)
  if (!_anthropicClient || _anthropicKey !== key) {
    _anthropicClient = new Anthropic({ apiKey: key });
    _anthropicKey = key;
  }
  return _anthropicClient;
}

// Startup diagnostic — prints to Railway logs whether the env was visible to
// the Node process at boot. The fingerprint (first 7 / last 4 chars) lets us
// spot accidental whitespace or wrong-key issues without leaking the secret.
(function() {
  const raw = process.env.ANTHROPIC_API_KEY || '';
  const trimmed = raw.trim();
  if (!trimmed) {
    console.log('[ai-routes] ANTHROPIC_API_KEY: MISSING at startup');
  } else {
    const fp = trimmed.length > 12
      ? trimmed.slice(0, 7) + '…' + trimmed.slice(-4)
      : '<short>';
    const wsNote = (raw.length !== trimmed.length) ? ' (had whitespace, trimmed)' : '';
    console.log('[ai-routes] ANTHROPIC_API_KEY: present, fingerprint ' + fp + ', length ' + trimmed.length + wsNote);
  }
})();

// Sonnet 4.6 = the right cost/capability tier for an estimating assistant.
// Override via env if we want to A/B against Opus.
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;

// Cap chat history fed back to the API so a long conversation doesn't
// balloon the per-call cost. Keep the most recent N round-trips
// (= 2N messages). System prompt rebuilds estimate context fresh each call,
// so dropped early messages don't lose factual context.
const MAX_HISTORY_PAIRS = 12;

// ──────────────────────────────────────────────────────────────────
// Context builder — pulls everything Claude needs to know about the
// estimate and formats it as a system-prompt prefix. Photos are returned
// separately so the chat handler can attach them as image blocks.
// ──────────────────────────────────────────────────────────────────

async function buildEstimateContext(estimateId, includePhotos) {
  // Estimate row carries the JSONB blob with all the editor fields plus
  // alternates and lines (the bulk-save routes serialize them this way).
  const estRes = await pool.query(
    'SELECT id, owner_id, data FROM estimates WHERE id = $1',
    [estimateId]
  );
  if (!estRes.rows.length) throw new Error('Estimate not found');
  const blob = estRes.rows[0].data || {};

  // Active alternate carries the per-alt scope + lines that the editor uses
  const alternates = Array.isArray(blob.alternates) ? blob.alternates : [];
  const activeAlt = alternates.find(a => a.id === blob.activeAlternateId) || alternates[0] || null;
  const allLines = Array.isArray(blob.lines) ? blob.lines : [];
  const activeLines = activeAlt
    ? allLines.filter(l => l.alternateId === activeAlt.id)
    : allLines;

  // Linked client surfaces the salutation + community + addresses if set
  let clientRow = null;
  if (blob.client_id) {
    const cRes = await pool.query('SELECT * FROM clients WHERE id = $1', [blob.client_id]);
    clientRow = cRes.rows[0] || null;
  }

  // Photos for vision. We pull both leads' and the estimate's photos so the
  // assistant has every available visual. Limited to web-size (1600px,
  // ~150KB each) to keep token cost in check; ignored entirely if the
  // user toggled photos off.
  let photoBlocks = [];
  if (includePhotos) {
    const photoRows = [];
    const estPhotos = await pool.query(
      `SELECT * FROM attachments WHERE entity_type='estimate' AND entity_id=$1
       ORDER BY position, uploaded_at LIMIT 8`,
      [estimateId]
    );
    photoRows.push(...estPhotos.rows.map(r => ({ ...r, source: 'estimate' })));
    if (blob.lead_id) {
      const leadPhotos = await pool.query(
        `SELECT * FROM attachments WHERE entity_type='lead' AND entity_id=$1
         ORDER BY position, uploaded_at LIMIT 8`,
        [blob.lead_id]
      );
      photoRows.push(...leadPhotos.rows.map(r => ({ ...r, source: 'lead' })));
    }
    // Cap at 12 total to stay under Anthropic's 20-image-per-request limit
    photoRows.splice(12);
    for (const p of photoRows) {
      const block = await loadPhotoAsBlock(p);
      if (block) photoBlocks.push(block);
    }
  }

  // Build the structured system-prompt prefix
  const lines = [];
  lines.push('You are an estimating assistant for AG Exteriors, a Central Florida construction services company specializing in painting, deck repairs, roofing, and exterior services for HOAs and apartment communities.');
  lines.push('');
  lines.push('Here is the current estimate the user is working on:');
  lines.push('');
  lines.push('# Estimate');
  lines.push('- Title: ' + (blob.title || '(untitled)'));
  if (blob.issue) lines.push('- Issue / repair: ' + blob.issue);
  if (blob.jobType) lines.push('- Project type: ' + blob.jobType);
  if (clientRow) {
    lines.push('- Client: ' + (clientRow.name || ''));
    if (clientRow.community_name && clientRow.community_name !== clientRow.name) lines.push('  Community: ' + clientRow.community_name);
    if (clientRow.community_manager) lines.push('  CAM / contact: ' + clientRow.community_manager);
  } else if (blob.client) {
    lines.push('- Client: ' + blob.client);
  }
  if (blob.community && (!clientRow || clientRow.community_name !== blob.community)) lines.push('- Community / property: ' + blob.community);
  if (blob.propertyAddr) lines.push('- Job address: ' + blob.propertyAddr);
  lines.push('');

  if (alternates.length > 1) {
    lines.push('# Alternates (Good / Better / Best)');
    alternates.forEach(a => {
      const isActive = a.id === blob.activeAlternateId;
      lines.push('- ' + a.name + (isActive ? ' (active)' : ''));
    });
    lines.push('');
  }

  if (activeAlt) {
    lines.push('# Active alternate: ' + activeAlt.name);
    if (activeAlt.scope) {
      lines.push('## Scope of work');
      lines.push(activeAlt.scope);
      lines.push('');
    }
  } else if (blob.scopeOfWork) {
    // legacy estimates that haven't been opened post-migration
    lines.push('# Scope of work');
    lines.push(blob.scopeOfWork);
    lines.push('');
  }

  // Group lines by section header for readable rendering
  if (activeLines.length) {
    lines.push('## Line items (cost-side)');
    let currentSection = '(uncategorized)';
    let lineNumInSection = 0;
    activeLines.forEach(l => {
      if (l.section === '__section_header__') {
        currentSection = l.description || 'section';
        lineNumInSection = 0;
        lines.push('### ' + currentSection);
      } else {
        lineNumInSection++;
        const qty = parseFloat(l.qty) || 0;
        const unit = l.unit || 'ea';
        const cost = parseFloat(l.unitCost) || 0;
        const ext = qty * cost;
        const markup = (l.markup === '' || l.markup == null) ? (parseFloat(blob.defaultMarkup) || 0) : parseFloat(l.markup);
        lines.push(`${lineNumInSection}. ${l.description || '(no description)'} — qty ${qty} ${unit} @ $${cost.toFixed(2)} = $${ext.toFixed(2)}; markup ${markup}%`);
      }
    });
    lines.push('');
  } else {
    lines.push('## Line items');
    lines.push('(none yet)');
    lines.push('');
  }

  // Pricing posture
  const pricingBits = [];
  if (blob.defaultMarkup) pricingBits.push(`default markup ${blob.defaultMarkup}%`);
  if (blob.taxPct) pricingBits.push(`tax ${blob.taxPct}%`);
  if (blob.feeFlat) pricingBits.push(`flat fee $${blob.feeFlat}`);
  if (blob.feePct) pricingBits.push(`fee ${blob.feePct}%`);
  if (blob.roundTo) pricingBits.push(`round-up to nearest $${blob.roundTo}`);
  if (pricingBits.length) {
    lines.push('# Pricing settings');
    lines.push(pricingBits.join(', '));
    lines.push('');
  }

  if (photoBlocks.length) {
    lines.push('# Photos');
    lines.push(`${photoBlocks.length} photo(s) attached below — analyze them when relevant to the user's question.`);
    lines.push('');
  }

  lines.push('# Your role');
  lines.push('- Help the PM think through scope, materials, sequencing, and gotchas.');
  lines.push('- Spot missing line items, suggest items to add, flag risks (access, height, weather, code).');
  lines.push('- Cite cost-side prices (the user applies markup separately to get client price).');
  lines.push('- You are READ-ONLY for this conversation: you cannot edit the estimate. When recommending changes, format them clearly so the PM can apply them by hand.');
  lines.push('- Be concise. Construction trade vocabulary is welcome. If you need one piece of info to answer well, ask one targeted question.');

  return {
    systemPrompt: lines.join('\n'),
    photoBlocks: photoBlocks
  };
}

// Load a photo's web variant from storage and return an Anthropic image
// content block. Returns null on read failure rather than throwing so a
// single broken file doesn't kill the chat.
async function loadPhotoAsBlock(photoRow) {
  try {
    if (!storage.localRoot || !photoRow.web_key) return null;
    const fullPath = path.join(storage.localRoot, photoRow.web_key);
    const buf = await fs.promises.readFile(fullPath);
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg', // web variants are jpeg-encoded by the upload pipeline
        data: buf.toString('base64')
      }
    };
  } catch (e) {
    console.warn('Could not load photo', photoRow.id, ':', e.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// History endpoints
// ──────────────────────────────────────────────────────────────────

router.get('/estimates/:id/messages',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, role, content, photos_included, created_at
         FROM ai_messages
         WHERE estimate_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [req.params.id, req.user.id]
      );
      res.json({ messages: rows });
    } catch (e) {
      console.error('GET /api/ai/estimates/:id/messages error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.delete('/estimates/:id/messages',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM ai_messages WHERE estimate_id = $1 AND user_id = $2',
        [req.params.id, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE history error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Streaming chat endpoint. Body: { message, includePhotos }.
// Response: text/event-stream with `data: {chunk}` per token + final
// `data: [DONE]`. Errors are sent as `data: {error}`.
// ──────────────────────────────────────────────────────────────────

router.post('/estimates/:id/chat',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured. Set ANTHROPIC_API_KEY in the server environment, then redeploy or restart the service.' });
    }
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });
    const includePhotos = req.body && req.body.includePhotos !== false;
    const estimateId = req.params.id;

    // SSE headers — flush immediately so the client knows the connection
    // is live and starts buffering.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx-style buffering
    res.flushHeaders();

    function send(payload) {
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
    }
    function abort(message) {
      send({ error: message });
      res.write('data: [DONE]\n\n');
      res.end();
    }

    try {
      // Pull the user's existing conversation for this estimate
      const histRes = await pool.query(
        `SELECT role, content
         FROM ai_messages
         WHERE estimate_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [estimateId, req.user.id]
      );
      // Trim to the most recent N pairs to cap token cost
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      // Build fresh context — estimate state may have changed since last
      // message, so we never cache it.
      const ctx = await buildEstimateContext(estimateId, includePhotos);

      // The user's new message gets the photo blocks attached as image
      // content (if any) so vision is available on this round. Past
      // messages are text-only — the system prompt re-mentions the photos.
      const userContent = ctx.photoBlocks.length
        ? [...ctx.photoBlocks, { type: 'text', text: userMessage }]
        : userMessage;

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userContent }
      ];

      // Persist the user message right away — even if streaming fails the
      // user can see what they asked.
      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, estimate_id, user_id, role, content, photos_included)
         VALUES ($1, $2, $3, 'user', $4, $5)`,
        [userMsgId, estimateId, req.user.id, userMessage, ctx.photoBlocks.length]
      );

      // Stream from Anthropic
      let assistantText = '';
      let usage = { input_tokens: null, output_tokens: null };
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: ctx.systemPrompt,
        messages: messages
      });

      stream.on('text', (delta) => {
        assistantText += delta;
        send({ delta: delta });
      });
      stream.on('finalMessage', (msg) => {
        if (msg && msg.usage) usage = msg.usage;
      });
      stream.on('error', (err) => {
        console.error('Anthropic stream error:', err);
        abort(err.message || 'AI request failed');
      });

      await stream.done();

      // Persist the assistant reply once streaming completes
      if (assistantText) {
        const assistantId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await pool.query(
          `INSERT INTO ai_messages (id, estimate_id, user_id, role, content, model, input_tokens, output_tokens)
           VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7)`,
          [assistantId, estimateId, req.user.id, assistantText, MODEL, usage.input_tokens, usage.output_tokens]
        );
      }
      send({ done: true, usage: usage });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      console.error('AI chat error:', e);
      abort(e.message || 'Server error');
    }
  }
);

module.exports = router;
