// SharePoint / OneDrive XLSX fetcher for the agent reference-links
// feature. Given a "Anyone with the link → Can view" share URL, pulls
// the workbook bytes, parses with exceljs, and renders a compact
// CSV-ish preview that's safe to embed in an agent system prompt.
//
// The trick for anonymous downloads from a SharePoint share URL is to
// flip the viewer link into a download link. The default share URL
// looks like:
//   https://tenant.sharepoint.com/:x:/g/personal/.../EXXX...?e=YYY
// Appending &download=1 (or ?download=1 if no query) tells SharePoint
// to return the binary instead of bouncing through the web viewer.
// This works for anonymous shares; non-anonymous shares 401 / 403 and
// we surface that in last_fetch_error.
//
// We don't bake any auth here — by design, only public-share links
// work for v1. Tenant-OAuth integration is a separate, larger build.

'use strict';

const ExcelJS = require('exceljs');

const UA = 'AGX/Project86 reference-link fetcher (project86.net)';
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap per workbook

// Convert a SharePoint / OneDrive viewer share URL into a direct
// download URL. Idempotent — re-running on a download URL leaves
// it alone. Tolerant of either ?param or &param shape.
function toDownloadUrl(shareUrl) {
  if (typeof shareUrl !== 'string' || !shareUrl) return shareUrl;
  // Already has download=1
  if (/[?&]download=1\b/i.test(shareUrl)) return shareUrl;
  return shareUrl + (shareUrl.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
}

async function fetchWorkbookBytes(shareUrl) {
  const url = toDownloadUrl(shareUrl);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
    redirect: 'follow'
  });
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' fetching share URL');
  }
  // Length-cap before slurping the whole body — SharePoint streams
  // the file, we don't want to OOM on a 500 MB workbook somebody
  // shared by mistake.
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (Number.isFinite(len) && len > MAX_BYTES) {
    throw new Error('Workbook too large: ' + len + ' bytes');
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) {
    throw new Error('Workbook too large: ' + ab.byteLength + ' bytes');
  }
  return Buffer.from(ab);
}

// Parse an XLSX buffer into a flattened representation:
//   { sheets: [{ name, rows, columns, totalRows }] }
// Only the first 200 rows of each sheet are retained by default to
// keep the agent context manageable; caller can override via maxRows.
async function parseWorkbook(buf, maxRows) {
  const cap = Math.max(1, parseInt(maxRows, 10) || 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = [];
  wb.eachSheet(function (ws) {
    const rows = [];
    let totalRows = 0;
    let columns = [];
    ws.eachRow({ includeEmpty: false }, function (row, rowNum) {
      totalRows++;
      if (rowNum === 1) {
        // Treat the first row as headers; trim and drop trailing empties.
        const hdrs = [];
        row.eachCell({ includeEmpty: true }, function (cell, colNum) {
          hdrs[colNum - 1] = cellToString(cell);
        });
        // Drop trailing all-empty header columns.
        while (hdrs.length && !hdrs[hdrs.length - 1]) hdrs.pop();
        columns = hdrs;
      }
      if (rows.length >= cap) return;
      const out = {};
      columns.forEach(function (h, i) {
        if (!h) return;
        const v = row.getCell(i + 1).value;
        out[h] = cellToString({ value: v });
      });
      rows.push(out);
    });
    sheets.push({
      name: ws.name,
      columns: columns.filter(Boolean),
      rows: rows,
      totalRows: totalRows
    });
  });
  return { sheets: sheets };
}

// Render the parsed workbook as plain text the agent can read.
// Prefix carries a small heading so the model can identify which
// reference set the rows came from. Rows are emitted as
// "col1: v1 | col2: v2 | ..." which is more model-readable than CSV
// and tolerates commas in cell values without needing escaping.
function renderForPrompt(parsed, opts) {
  opts = opts || {};
  const title = opts.title || 'Reference sheet';
  const lines = [];
  lines.push('## ' + title);
  if (opts.description) lines.push(opts.description);
  parsed.sheets.forEach(function (s) {
    if (!s.rows.length) return;
    lines.push('');
    lines.push('### Sheet: ' + s.name + ' (' + s.rows.length +
               (s.totalRows > s.rows.length ? ' of ' + s.totalRows + ' rows shown' : ' rows') + ')');
    if (s.columns.length) {
      lines.push('Columns: ' + s.columns.join(', '));
    }
    s.rows.forEach(function (row, idx) {
      const parts = s.columns.map(function (c) {
        var v = row[c];
        if (v == null || v === '') return null;
        return c + ': ' + v;
      }).filter(Boolean);
      if (parts.length) lines.push((idx + 1) + '. ' + parts.join(' | '));
    });
  });
  return lines.join('\n');
}

// Cell → string normalizer. exceljs cell values can be strings,
// numbers, dates, formulas-with-results, or rich-text. We collapse
// to plain text since the agent doesn't need formatting.
function cellToString(cell) {
  const v = cell && cell.value;
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    // Rich text
    if (Array.isArray(v.richText)) {
      return v.richText.map(function (r) { return r.text || ''; }).join('').trim();
    }
    // Formula result
    if (v.result != null) return cellToString({ value: v.result });
    // Hyperlink
    if (v.text) return String(v.text).trim();
    if (v.hyperlink) return String(v.hyperlink);
    return '';
  }
  return String(v);
}

// Top-level helper used by the route + the cron refresh: takes a
// share URL, fetches + parses + renders, returns
// { text, rowCount, sheets } on success or throws.
async function fetchAndRender(shareUrl, opts) {
  opts = opts || {};
  const buf = await fetchWorkbookBytes(shareUrl);
  const parsed = await parseWorkbook(buf, opts.maxRows);
  const text = renderForPrompt(parsed, {
    title: opts.title || 'Reference sheet',
    description: opts.description || ''
  });
  const rowCount = parsed.sheets.reduce(function (s, x) { return s + x.rows.length; }, 0);
  return { text: text, rowCount: rowCount, sheets: parsed.sheets };
}

module.exports = {
  toDownloadUrl: toDownloadUrl,
  fetchWorkbookBytes: fetchWorkbookBytes,
  parseWorkbook: parseWorkbook,
  renderForPrompt: renderForPrompt,
  fetchAndRender: fetchAndRender
};
