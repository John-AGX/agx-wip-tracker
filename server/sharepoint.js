// Workbook fetcher for the agent reference-links feature. Given an
// anonymous share URL from any supported provider, pulls the bytes,
// parses with exceljs, and renders a compact preview safe to embed
// in an agent system prompt.
//
// Supported providers:
//   - SharePoint / OneDrive for Business:
//       https://tenant.sharepoint.com/:x:/g/personal/.../EXXX...?e=YYY
//       Append &download=1 to the share URL to get the binary.
//       REQUIRES "Anyone with the link" share + a tenant policy
//       that allows anonymous external sharing.
//   - Google Sheets:
//       https://docs.google.com/spreadsheets/d/{FILE_ID}/edit?usp=sharing
//       Convert to https://docs.google.com/spreadsheets/d/{FILE_ID}/export?format=xlsx
//       Works server-side for "Anyone with the link → Viewer" sheets
//       without any tenant config gymnastics.
//   - Google Drive XLSX file:
//       https://drive.google.com/file/d/{FILE_ID}/view?usp=sharing
//       Convert to https://drive.google.com/uc?export=download&id={FILE_ID}
//       Same anonymous-share semantics as Sheets.
//
// We don't bake any auth here — by design, only public-share links
// work for v1. M365-OAuth integration is a separate, larger build.

'use strict';

const ExcelJS = require('exceljs');

const UA = 'AGX/Project86 reference-link fetcher (project86.net)';
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap per workbook

// Identify the provider so we can pick the right URL transform +
// produce provider-specific error messages.
function detectProvider(url) {
  if (typeof url !== 'string' || !url) return 'unknown';
  if (/docs\.google\.com\/spreadsheets/i.test(url)) return 'google_sheets';
  if (/drive\.google\.com\/(file|open|uc)/i.test(url)) return 'google_drive';
  if (/sharepoint\.com|onedrive\.live\.com|onedrive\.com|1drv\.ms/i.test(url)) return 'sharepoint';
  return 'unknown';
}

// Convert a viewer share URL into a direct download URL. Idempotent
// per-provider — re-running on a download URL leaves it alone.
function toDownloadUrl(shareUrl) {
  if (typeof shareUrl !== 'string' || !shareUrl) return shareUrl;
  const provider = detectProvider(shareUrl);

  if (provider === 'google_sheets') {
    // /spreadsheets/d/{ID}/...   →   /spreadsheets/d/{ID}/export?format=xlsx
    const m = shareUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) return shareUrl;
    return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/export?format=xlsx';
  }

  if (provider === 'google_drive') {
    // /file/d/{ID}/...   →   /uc?export=download&id={ID}
    let id = null;
    let m = shareUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) id = m[1];
    if (!id) {
      m = shareUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (m) id = m[1];
    }
    if (!id) return shareUrl;
    return 'https://drive.google.com/uc?export=download&id=' + id;
  }

  // SharePoint / OneDrive: append &download=1 if not already there.
  if (/[?&]download=1\b/i.test(shareUrl)) return shareUrl;
  return shareUrl + (shareUrl.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
}

async function fetchWorkbookBytes(shareUrl) {
  const provider = detectProvider(shareUrl);
  const url = toDownloadUrl(shareUrl);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      // Hint XLSX-friendly types so providers are more likely to
      // return binary bytes vs a JS-driven viewer page.
      'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, */*'
    },
    redirect: 'follow'
  });
  const ct = (res.headers.get('content-type') || '').toLowerCase();

  if (!res.ok) {
    throw new Error(buildAuthFailureMsg(provider, res.status));
  }
  // Length-cap before slurping the whole body.
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (Number.isFinite(len) && len > MAX_BYTES) {
    throw new Error('Workbook too large: ' + len + ' bytes');
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) {
    throw new Error('Workbook too large: ' + ab.byteLength + ' bytes');
  }
  if (ab.byteLength < 4) {
    throw new Error('Empty response from share URL.');
  }
  const buf = Buffer.from(ab);
  // XLSX files are ZIP archives — first 2 bytes are 'PK' (0x504B).
  // Anything else is either an HTML login page, a redirect viewer,
  // or some other auth wall. Surface a specific error instead of
  // letting exceljs blow up later with an opaque parse error.
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
    if (ct.indexOf('text/html') >= 0) {
      throw new Error(buildHtmlBlockMsg(provider));
    }
    throw new Error(
      'Response wasn\'t a valid XLSX (no ZIP signature). ' +
      'Content-Type: ' + (ct || 'unknown') + ', size: ' + ab.byteLength + ' bytes. ' +
      'The share URL may be returning a redirect or auth wall.'
    );
  }
  return buf;
}

function buildAuthFailureMsg(provider, status) {
  const head = 'HTTP ' + status + ' from the share URL. ';
  if (status === 401 || status === 403) {
    if (provider === 'sharepoint') {
      return head +
        'The share isn\'t actually anonymous. Microsoft 365 silently passes your Windows credentials to SharePoint even in InPrivate windows, so a link can feel "public" while still being org-restricted. ' +
        'To verify: open the URL on a phone with cellular data — if it asks you to sign in, the share is locked down. ' +
        'To fix: re-share with "Anyone with the link → Can view" (may need tenant admin to enable). ' +
        'OR move the file to Google Sheets / Drive — those handle anonymous shares cleanly.';
    }
    if (provider === 'google_sheets' || provider === 'google_drive') {
      return head +
        'The Google share isn\'t set to anonymous viewing. Right-click the file in Drive → Share → ' +
        'change "Restricted" to "Anyone with the link" → Viewer.';
    }
    return head + 'The share URL requires authentication.';
  }
  return head + 'Try re-copying the share URL.';
}

function buildHtmlBlockMsg(provider) {
  if (provider === 'sharepoint') {
    return 'SharePoint returned an HTML viewer page instead of the XLSX. ' +
      'The share isn\'t actually anonymous — Microsoft 365 SSO often makes it FEEL public when it\'s really org-restricted. ' +
      'Open the URL on your phone with cellular data: if it asks for a sign-in, anonymous downloads won\'t work. ' +
      'Fix: re-share as "Anyone with the link → Can view" (admin may need to enable), or move the file to Google Sheets / Drive — those just work.';
  }
  if (provider === 'google_sheets' || provider === 'google_drive') {
    return 'Google returned an HTML page instead of the XLSX. ' +
      'The share is probably set to "Restricted" — change to "Anyone with the link → Viewer" in Drive\'s Share dialog.';
  }
  return 'Server returned an HTML page instead of the XLSX. The share URL appears to require authentication.';
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
  detectProvider: detectProvider,
  toDownloadUrl: toDownloadUrl,
  fetchWorkbookBytes: fetchWorkbookBytes,
  parseWorkbook: parseWorkbook,
  renderForPrompt: renderForPrompt,
  fetchAndRender: fetchAndRender
};
