// Bulk Document Import — OCR a PO / CO / Invoice document (image or PDF) with
// Haiku vision and return a structured header + LINE ITEMS + a job hint, so the
// client can queue many files, let the user review/correct, and create the real
// records. Mirrors the receipt OCR pattern (receipt-routes.js) but is
// entity-aware and pulls line items, not just a grand total.
//
// SECURITY: gated on ESTIMATES_EDIT (same capability that creates POs/COs/
// invoices) and bounded by the shared AI-spend limiters — a bulk import fires
// one vision call per file, so it must be rate-limited like /api/ai/*.
//
// Mounted at /api/doc-import (see server/index.js).

const express = require('express');
const { requireAuth, requireCapability } = require('../auth');
const { Anthropic } = require('@anthropic-ai/sdk');
const { aiChatLimiter, aiChatHourlyLimiter } = require('../rate-limit');

const router = express.Router();

// Single, capable-enough vision model for document extraction. Haiku is cheap
// for bulk and the client's review grid catches misreads before anything is
// created; bump to a Sonnet-class model here if line-item accuracy needs it.
const DOC_OCR_MODEL = 'claude-haiku-4-5';

let _anth = null;
function anthropic() {
  if (_anth) return _anth;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  _anth = new Anthropic({ apiKey: key });
  return _anth;
}

const ENTITY_TYPES = new Set(['po', 'co', 'invoice']);
const IMAGE_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const PDF_MEDIA = 'application/pdf';
// ~12MB of base64 (~9MB binary) — generous for a multi-page PO/invoice PDF.
const MAX_B64 = 16000000;

// A human label for each entity, used in the extraction prompt.
const ENTITY_LABEL = {
  po: 'Purchase Order (a contract issued to a subcontractor or supplier)',
  co: 'Change Order (a signed change to a construction contract)',
  invoice: 'Invoice / Bill (money owed to or by the company)'
};

// Number coercion: accept a number or a "$1,234.56" string; reject non-finite,
// negative, or absurd values. Rounds to cents.
function money(v) {
  if (v == null) return null;
  const n = (typeof v === 'number') ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n >= 100000000) return null;
  return Math.round(n * 100) / 100;
}
function qty(v) {
  if (v == null) return null;
  const n = (typeof v === 'number') ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n >= 1000000) return null;
  return Math.round(n * 1000) / 1000;
}
function isoDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
}
function str(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max || 200) : null;
}

// Build the entity-specific extraction prompt. Returns a strict JSON-only
// instruction; the model must emit header fields + a lines[] array.
function buildPrompt(entityType) {
  const label = ENTITY_LABEL[entityType] || 'document';
  return (
    'You are reading a scanned/photographed ' + label + '. It may span multiple pages. ' +
    'Extract its contents and return ONLY a JSON object, no prose, no markdown:\n' +
    '{\n' +
    '  "job_hint": string|null,   // the JOB this belongs to as printed on the doc: a job/project number, a property address, or a customer/project name. Copy it verbatim.\n' +
    '  "number": string|null,     // the document\'s own number (PO #, CO #, or Invoice #)\n' +
    '  "vendor": string|null,     // the subcontractor / supplier / company on the doc (who is being paid)\n' +
    '  "title": string|null,      // a short (< 80 char) summary of the scope/work\n' +
    '  "date": "YYYY-MM-DD"|null,  // issue/order date; null if not visible\n' +
    '  "due_date": "YYYY-MM-DD"|null, // payment due date if shown (invoices)\n' +
    '  "lines": [ { "description": string, "qty": number|null, "unit_cost": number|null, "amount": number|null } ],\n' +
    '  "total": number|null        // the grand total / amount due as a plain number\n' +
    '}\n' +
    'Rules:\n' +
    '- lines: one entry per line item in the cost/scope table. description is required per line; qty/unit_cost/amount are numbers with NO $ or commas (null if not shown). If only an extended amount is printed, put it in "amount" and leave qty/unit_cost null.\n' +
    '- Do NOT invent lines. If there is no itemized table, return a single line using the title/scope and the total as its amount.\n' +
    '- total: the final grand total (after tax/markup) as printed. null if you truly cannot read it.\n' +
    '- Use null for any field you cannot read. Return valid JSON only.'
  );
}

// Assemble the vision content block for an image or a PDF.
function fileContentBlock(mediaType, data) {
  if (mediaType === PDF_MEDIA) {
    return { type: 'document', source: { type: 'base64', media_type: PDF_MEDIA, data: data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: data } };
}

// POST /api/doc-import/ocr
// Body: { entity_type: 'po'|'co'|'invoice', file_base64 (raw or data-URL),
//         media_type }. Returns { ok, extracted: {...} } best-effort.
router.post('/ocr', requireAuth, requireCapability('ESTIMATES_EDIT'), aiChatLimiter, aiChatHourlyLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const entityType = String(b.entity_type || '').toLowerCase();
    if (!ENTITY_TYPES.has(entityType)) return res.json({ ok: false, error: 'bad-entity-type' });

    let data = String(b.file_base64 || '');
    if (data.startsWith('data:')) { const i = data.indexOf(','); if (i >= 0) data = data.slice(i + 1); }
    let media = String(b.media_type || '').toLowerCase();
    if (media !== PDF_MEDIA && !IMAGE_MEDIA.has(media)) media = 'image/jpeg';
    if (!data || data.length > MAX_B64) return res.json({ ok: false, error: 'bad-file' });

    const client = anthropic();
    if (!client) return res.json({ ok: false, error: 'ocr-unavailable' });

    const msg = await client.messages.create({
      model: DOC_OCR_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [ fileContentBlock(media, data), { type: 'text', text: buildPrompt(entityType) } ]
      }]
    });

    let text = '';
    try { text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''); } catch (_) {}
    let parsed = null;
    try { const m = text.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (_) {}
    if (!parsed || typeof parsed !== 'object') return res.json({ ok: false, error: 'unparsable' });

    // Validate + coerce every field. Never trust the model's raw numbers/strings.
    let lines = [];
    if (Array.isArray(parsed.lines)) {
      lines = parsed.lines.slice(0, 200).map((l) => {
        if (!l || typeof l !== 'object') return null;
        const desc = str(l.description, 300);
        const q = qty(l.qty);
        const uc = money(l.unit_cost);
        let amt = money(l.amount);
        // Derive a missing extended amount from qty × unit_cost when possible.
        if (amt == null && q != null && uc != null) amt = Math.round(q * uc * 100) / 100;
        if (!desc && amt == null) return null;
        return { description: desc || '(item)', qty: q, unit_cost: uc, amount: amt };
      }).filter(Boolean);
    }
    const total = money(parsed.total);
    // If the model gave a total but no usable lines, fall back to a single line
    // so the record still carries its money into the metrics.
    if (!lines.length && total != null) {
      lines = [{ description: str(parsed.title, 300) || 'Imported ' + entityType.toUpperCase(), qty: null, unit_cost: null, amount: total }];
    }

    const extracted = {
      entity_type: entityType,
      job_hint: str(parsed.job_hint, 200),
      number: str(parsed.number, 60),
      vendor: str(parsed.vendor, 200),
      title: str(parsed.title, 120),
      date: isoDate(parsed.date),
      due_date: isoDate(parsed.due_date),
      lines: lines,
      total: total,
      // Sum of line amounts — lets the client flag a mismatch vs the printed total.
      lines_total: Math.round(lines.reduce((s, l) => s + (l.amount || 0), 0) * 100) / 100
    };
    res.json({ ok: true, extracted: extracted });
  } catch (e) {
    console.error('POST /api/doc-import/ocr error:', e && e.message);
    res.json({ ok: false, error: 'ocr-error' });
  }
});

module.exports = router;
