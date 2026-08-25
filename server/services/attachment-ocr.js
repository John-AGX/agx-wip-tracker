// Plain-text OCR for an image or scanned PDF via Haiku vision. Used by the
// email-attachment reading path (server/services/email-attachment-text.js) so
// the AI agents can read the CONTENTS of a photo / scanned attachment, not just
// its filename. Mirrors the doc-import OCR call (routes/doc-import-routes.js)
// but asks for a raw transcription instead of a structured extraction.
//
// "Smart & cheap": callers run this ONLY when a digital text layer failed
// (the file is a photo or an image-only/scanned PDF), so we never pay a vision
// call on a file we can read for free.

const { Anthropic } = require('@anthropic-ai/sdk');

const OCR_MODEL = 'claude-haiku-4-5';
const IMAGE_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const PDF_MEDIA = 'application/pdf';
// ~12MB of base64 (~9MB binary) — matches the doc-import ceiling.
const MAX_B64 = 16000000;

let _anth = null;
function anthropic() {
  if (_anth) return _anth;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  _anth = new Anthropic({ apiKey: key });
  return _anth;
}

function contentBlock(media, data) {
  if (media === PDF_MEDIA) return { type: 'document', source: { type: 'base64', media_type: PDF_MEDIA, data: data } };
  return { type: 'image', source: { type: 'base64', media_type: media, data: data } };
}

// Returns transcribed text, or '' when unavailable / unreadable / too big.
// Never throws — OCR is best-effort.
async function ocrToText(buffer, mimeRaw) {
  try {
    if (!buffer || !buffer.length) return '';
    const media = String(mimeRaw || '').toLowerCase();
    // Only formats Haiku vision accepts. An unknown image type (e.g. HEIC) is
    // skipped rather than mislabeled — a wrong bytes-vs-header pairing 400s.
    if (media !== PDF_MEDIA && !IMAGE_MEDIA.has(media)) return '';
    const client = anthropic();
    if (!client) return '';
    const data = buffer.toString('base64');
    if (!data || data.length > MAX_B64) return '';
    const msg = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          contentBlock(media, data),
          { type: 'text', text:
            'Transcribe ALL text visible in this document or image exactly as written, preserving line breaks and reading order. ' +
            'Include numbers, dates, totals, table rows (tab-separated), names, and addresses. ' +
            'Output ONLY the transcribed text — no commentary, no markdown, no code fences. ' +
            'If there is no legible text, output nothing.' }
        ]
      }]
    });
    let text = '';
    try { text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim(); } catch (_) {}
    return text || '';
  } catch (e) {
    console.warn('[attachment-ocr] ocrToText failed:', e.message);
    return '';
  }
}

module.exports = { ocrToText };
