// Workspace ⇄ Excel — server-side xlsx EXPORT (S1 of the fidelity plan).
//
// The client Workspace grid stores full visual styling (bold/italic/
// underline/strike, font color/size, cell fill, per-side borders,
// alignment, wrap) in its JSON model — but the old client-side export
// used the SheetJS Community build, which cannot WRITE styles, so every
// export came out unstyled. exceljs (already a dependency) both reads
// and writes styles, so export moves here: the client POSTs its live
// workbook model and streams back a faithful .xlsx.
//
// Contract: POST /api/workspace/export-xlsx
//   body: { filename, sheets: [agxSheet…], namedRanges: {…} }
//   - sheets are the client's REAL grid sheets (client filters out
//     hidden/pinned/embedded views before posting — same rule as the
//     old exporter).
//   - agxSheet: { id, name, rows, cols, cells:{ 'A1': cell }, colWidths:{c:px},
//     colWch:{c:wch}?, rowHeights:{r:px}, rowHpt:{r:pt}?, merges:[{r1,c1,r2,c2}],
//     frozen:'row'|'col'|'both'?, autoFilter:{r1,c1,r2,c2}? }
//   - cell: { raw, value, style?, fmt?, decimals?, numFmt?, hyperlink?,
//     note?, importedValue? } — style = { bold, italic, underline,
//     strikethrough, color:'#rrggbb', bg:'#rrggbb', align, valign?, wrap,
//     fontSize(px), fontFamily?, borders:{side:{style,width,color}} }.
//   response: the .xlsx bytes (attachment).
//
// buildWorkbook() is exported separately so it can be unit-tested
// without HTTP.

const express = require('express');
const ExcelJS = require('exceljs');
const { requireAuth } = require('../auth');

const router = express.Router();

// ── A1 helpers (server-side mirrors of the client's addr utils) ────
function colLetter(c) {
  let s = '';
  c = Number(c);
  do { s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26) - 1; } while (c >= 0);
  return s;
}
function parseAddr(a1) {
  const m = String(a1 || '').toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let c = 0;
  for (let i = 0; i < m[1].length; i++) c = c * 26 + (m[1].charCodeAt(i) - 64);
  return { r: parseInt(m[2], 10) - 1, c: c - 1 };
}

// ── Excel constraints on sheet-tab names (ported from the client) ──
function sanitizeSheetName(name, fallback) {
  let s = String(name || fallback || 'Sheet').replace(/[\\/?*\[\]:]/g, ' ').trim();
  if (!s) s = fallback || 'Sheet';
  if (s.length > 31) s = s.slice(0, 31);
  return s;
}
function uniqueSheetName(name, used) {
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ' (' + n + ')';
    candidate = name.slice(0, 31 - suffix.length) + suffix;
    n++;
    if (n > 999) { candidate = name.slice(0, 26) + '_' + Date.now().toString(36).slice(-4); break; }
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// '#rrggbb' → exceljs { argb:'FFRRGGBB' }
function argb(hex) {
  const m = String(hex || '').match(/^#?([0-9a-fA-F]{6})$/);
  return m ? { argb: 'FF' + m[1].toUpperCase() } : null;
}

// AGX border {style:'solid'|'dashed'|'dotted'|'double', width:1..3} →
// exceljs border style name. Inverse of the client's import styleMap.
function borderStyleName(b) {
  if (!b) return null;
  const st = b.style || 'solid';
  const w = b.width || 1;
  if (st === 'double') return 'double';
  if (st === 'dotted') return 'dotted';
  if (st === 'dashed') return w >= 2 ? 'mediumDashed' : 'dashed';
  if (w >= 3) return 'thick';
  if (w === 2) return 'medium';
  return 'thin';
}

// AGX fmt enum → Excel number-format string (mirrors the client's map).
function fmtToNumFmt(cell) {
  if (cell.numFmt) return String(cell.numFmt);
  if (!cell.fmt) return null;
  const dec = Number.isFinite(cell.decimals) ? cell.decimals : 2;
  const decStr = dec > 0 ? '.' + '0'.repeat(dec) : '';
  if (cell.fmt === 'currency') return '"$"#,##0' + decStr;
  if (cell.fmt === 'percent') return '0' + decStr + '%';
  if (cell.fmt === 'comma') return '#,##0' + decStr;
  if (typeof cell.fmt === 'string') return cell.fmt; // custom string
  return null;
}

// px → Excel column width units (chars of the default font). Canonical
// inverse of the import's wch*7 fallback; wpx from SheetJS is ≈ wch*7+5.
function pxToWch(px) {
  const w = (Number(px) - 5) / 7;
  return Math.max(0.5, Math.round(w * 100) / 100);
}

function isFormulaCell(cell) {
  return cell && typeof cell.raw === 'string' && cell.raw.charAt(0) === '=';
}

// A usable cached result for a formula cell: the engine value when it
// evaluated, else the Excel-cached importedValue (S2 stores it).
function formulaResult(cell) {
  const bad = (v) => v == null || v === '' || v === '#ERR' || v === '#DIV/0!' ||
    (typeof v === 'number' && !isFinite(v));
  if (!bad(cell.value)) return cell.value;
  if (!bad(cell.importedValue)) return cell.importedValue;
  return undefined; // no cached value — Excel computes on open
}

function applyCellStyle(xc, style) {
  if (!style || typeof style !== 'object') return;
  const font = {};
  if (style.bold) font.bold = true;
  if (style.italic) font.italic = true;
  if (style.underline) font.underline = true;
  if (style.strikethrough) font.strike = true;
  const fc = argb(style.color);
  if (fc) font.color = fc;
  if (style.fontSize) font.size = Math.max(6, Math.round(style.fontSize * 0.75)); // px → pt
  if (style.fontFamily) font.name = String(style.fontFamily);
  if (Object.keys(font).length) xc.font = font;

  const bg = argb(style.bg);
  if (bg) xc.fill = { type: 'pattern', pattern: 'solid', fgColor: bg };

  const align = {};
  if (style.align) align.horizontal = style.align;
  if (style.valign) align.vertical = style.valign;
  if (style.wrap) align.wrapText = true;
  if (Object.keys(align).length) xc.alignment = align;

  if (style.borders && typeof style.borders === 'object') {
    const border = {};
    ['top', 'right', 'bottom', 'left'].forEach((side) => {
      const b = style.borders[side];
      if (!b) return;
      const name = borderStyleName(b);
      if (!name) return;
      border[side] = { style: name, color: argb(b.color) || { argb: 'FF000000' } };
    });
    if (Object.keys(border).length) xc.border = border;
  }
}

// Is a sheet worth exporting? Mirrors "skip the stray blank Sheet1":
// a never-touched default sheet has no cells, no merges, no widths.
function sheetHasContent(sheet) {
  if (!sheet) return false;
  const cells = sheet.cells || {};
  for (const k in cells) {
    const c = cells[k];
    if (!c) continue;
    if ((c.raw != null && c.raw !== '') || c.style || c.numFmt || c.fmt || c.note || c.hyperlink) return true;
  }
  if (sheet.merges && sheet.merges.length) return true;
  return false;
}

/**
 * Build an exceljs Workbook from the posted AGX workspace model.
 * Pure function — no HTTP. Returns { wb, exported, skipped }.
 */
function buildWorkbook(payload) {
  const sheets = Array.isArray(payload && payload.sheets) ? payload.sheets : [];
  const namedRanges = (payload && payload.namedRanges) || {};

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Project 86';
  wb.created = new Date();

  const used = new Set();
  const sheetIdToName = {};
  const agxNameToExport = {}; // lower-cased AGX name → exported tab name
  let exported = 0, skipped = 0;

  sheets.forEach((sheet, i) => {
    if (!sheetHasContent(sheet)) { skipped++; return; }
    const finalName = uniqueSheetName(sanitizeSheetName(sheet.name, 'Sheet' + (i + 1)), used);
    sheetIdToName[sheet.id] = finalName;
    if (sheet.name) agxNameToExport[String(sheet.name).toLowerCase()] = finalName;
    const ws = wb.addWorksheet(finalName);

    // Cells — iterate the sparse map (not rows×cols) for speed.
    const cells = sheet.cells || {};
    Object.keys(cells).forEach((ref) => {
      const cell = cells[ref];
      if (!cell) return;
      const pos = parseAddr(ref);
      if (!pos) return;
      const xc = ws.getCell(pos.r + 1, pos.c + 1);

      if (isFormulaCell(cell)) {
        const result = formulaResult(cell);
        xc.value = result === undefined
          ? { formula: cell.raw.slice(1) }
          : { formula: cell.raw.slice(1), result };
      } else if (cell.hyperlink && cell.hyperlink.url) {
        const text = (cell.value != null && cell.value !== '') ? String(cell.value)
          : (cell.raw != null ? String(cell.raw) : cell.hyperlink.url);
        xc.value = { text, hyperlink: cell.hyperlink.url };
      } else if (cell.raw != null && cell.raw !== '') {
        const n = Number(cell.raw);
        xc.value = (!isNaN(n) && String(n) === String(cell.raw).trim()) ? n : String(cell.raw);
      }

      const numFmt = fmtToNumFmt(cell);
      if (numFmt && numFmt !== 'General') xc.numFmt = numFmt;
      if (cell.note) xc.note = String(cell.note);
      applyCellStyle(xc, cell.style);
    });

    // Column widths — exact wch passthrough when the import stored it
    // (S4), else the canonical px→wch conversion.
    const colWch = sheet.colWch || {};
    const colWidths = sheet.colWidths || {};
    const colIdxs = new Set([...Object.keys(colWch), ...Object.keys(colWidths)]);
    colIdxs.forEach((k) => {
      const c = Number(k);
      if (!Number.isFinite(c) || c < 0) return;
      const wch = colWch[k] != null ? Number(colWch[k])
        : (colWidths[k] ? pxToWch(colWidths[k]) : null);
      if (wch) ws.getColumn(c + 1).width = wch;
    });

    // Row heights — exact pt passthrough when stored, else px → pt.
    const rowHpt = sheet.rowHpt || {};
    const rowHeights = sheet.rowHeights || {};
    const rowIdxs = new Set([...Object.keys(rowHpt), ...Object.keys(rowHeights)]);
    rowIdxs.forEach((k) => {
      const r = Number(k);
      if (!Number.isFinite(r) || r < 0) return;
      const pt = rowHpt[k] != null ? Number(rowHpt[k])
        : (rowHeights[k] ? Math.round(rowHeights[k] * 0.75 * 100) / 100 : null);
      if (pt) ws.getRow(r + 1).height = pt;
    });

    // Merges.
    (sheet.merges || []).forEach((m) => {
      try { ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1); }
      catch (e) { /* overlapping/invalid merge — skip rather than fail the file */ }
    });

    // Frozen panes.
    if (sheet.frozen) {
      const xSplit = (sheet.frozen === 'col' || sheet.frozen === 'both') ? 1 : 0;
      const ySplit = (sheet.frozen === 'row' || sheet.frozen === 'both') ? 1 : 0;
      if (xSplit || ySplit) ws.views = [{ state: 'frozen', xSplit, ySplit }];
    }

    // AutoFilter — AGX shape { r1, c1, r2, c2 }.
    if (sheet.autoFilter && Number.isFinite(sheet.autoFilter.r1)) {
      const f = sheet.autoFilter;
      ws.autoFilter = {
        from: { row: f.r1 + 1, column: f.c1 + 1 },
        to: { row: f.r2 + 1, column: f.c2 + 1 }
      };
    }
    exported++;
  });

  // Named ranges → defined names, qualified with the EXPORTED tab name.
  // An unqualified name with no sheetId belongs to the active sheet —
  // same default the old client exporter used.
  const activeName = payload && payload.activeSheetId ? sheetIdToName[payload.activeSheetId] : null;
  Object.keys(namedRanges).forEach((k) => {
    const nr = namedRanges[k];
    if (!nr || !nr.ref) return;
    let sheetName = nr.sheetId ? sheetIdToName[nr.sheetId] : activeName;
    let bare = String(nr.ref);
    const bang = bare.lastIndexOf('!');
    if (bang !== -1) {
      const sn = bare.slice(0, bang).replace(/^'|'$/g, '');
      if (agxNameToExport[sn.toLowerCase()]) sheetName = agxNameToExport[sn.toLowerCase()];
      bare = bare.slice(bang + 1);
    }
    if (!sheetName) return; // owning sheet not exported
    const parts = bare.replace(/\$/g, '').split(':');
    const a = parseAddr(parts[0]);
    if (!a) return;
    const absA = '$' + colLetter(a.c) + '$' + (a.r + 1);
    let refBody = absA;
    if (parts[1]) {
      const b = parseAddr(parts[1]);
      if (!b) return;
      refBody = absA + ':$' + colLetter(b.c) + '$' + (b.r + 1);
    }
    const qName = /[^A-Za-z0-9_]/.test(sheetName) ? "'" + sheetName.replace(/'/g, "''") + "'" : sheetName;
    try { wb.definedNames.add(qName + '!' + refBody, nr.name || k); }
    catch (e) { /* invalid name — skip */ }
  });

  return { wb, exported, skipped };
}

// ── POST /api/workspace/export-xlsx ────────────────────────────────
router.post('/export-xlsx', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const { wb, exported } = buildWorkbook(payload);
    if (!exported) return res.status(400).json({ error: 'No exportable sheets' });

    const rawName = String(payload.filename || 'workspace-export.xlsx');
    const safeName = rawName.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'workspace-export.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('POST /api/workspace/export-xlsx error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
    else res.end();
  }
});

module.exports = router;
module.exports.buildWorkbook = buildWorkbook;
