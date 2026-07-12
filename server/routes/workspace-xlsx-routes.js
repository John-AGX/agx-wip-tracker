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

// ════════════════════════════════════════════════════════════════════
// S3 — server-side xlsx IMPORT.
//
// The client's SheetJS Community build captures almost no styling on
// read (verified: 0 of ~1500 fills/borders on a real takeoff), resolves
// theme colors from a hardcoded palette, and drops style-only cells.
// exceljs reads everything; theme colors resolve EXACTLY from the
// file's own xl/theme1.xml (exceljs keeps the XML verbatim on
// workbook.model.themes).
//
// Contract: POST /api/workspace/import-xlsx
//   body: raw .xlsx bytes (application/octet-stream)
//   response: { sheets: [agxSheetSansId…], namedRanges: [{name, ref}…] }
// The client assigns sheet ids, group ids, tab placement, collision
// renames — this endpoint is a pure parser.
//
// Known limits (also listed in the client's import/export comment):
// charts/images, conditional formatting, data validation, fill
// patterns/gradients (approximated as solid), diagonal borders,
// rich-text runs (flattened), and `$` anchors in formulas (stripped so
// the grid engine can evaluate — values are unaffected, but re-exported
// formulas lose their anchors). Hidden sheets import as hidden TABS so
// cross-sheet formulas and named ranges into them keep resolving; the
// export side excludes them (export matches what's visible).

// ── Theme palette (exact, from the file's theme1.xml) ──────────────
// clrScheme XML order: dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink.
// The `theme` ATTRIBUTE on colors indexes a DIFFERENT order — Excel
// swaps the dark/light pairs: 0=lt1, 1=dk1, 2=lt2, 3=dk2, 4..9=accents,
// 10=hlink, 11=folHlink ("White, Background 1" is theme 0).
const THEME_SLOT_ORDER = ['lt1', 'dk1', 'lt2', 'dk2',
  'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
  'hlink', 'folHlink'];
// Office default theme — fallback when a file carries no theme part.
const THEME_FALLBACK = ['FFFFFF', '000000', 'E7E6E6', '44546A',
  '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47',
  '0563C1', '954F72'];

function parseThemePalette(wb) {
  const themes = (wb.model && wb.model.themes) || {};
  const xml = themes.theme1 || themes.theme || Object.values(themes)[0];
  if (!xml || typeof xml !== 'string') return THEME_FALLBACK.slice();
  const scheme = {};
  // <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
  // <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
  const re = /<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>([\s\S]*?)<\/a:\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const srgb = body.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/);
    const sys = body.match(/<a:sysClr\s+[^>]*lastClr="([0-9A-Fa-f]{6})"/);
    scheme[m[1]] = (srgb && srgb[1]) || (sys && sys[1]) || null;
  }
  return THEME_SLOT_ORDER.map((slot, i) => scheme[slot] || THEME_FALLBACK[i]);
}

// Excel's tint algorithm — operates on HSL luminance (the spec math,
// not the cheap per-channel approximation the client fallback used).
function applyTint(hex6, tint) {
  if (!tint) return hex6;
  const r = parseInt(hex6.slice(0, 2), 16) / 255;
  const g = parseInt(hex6.slice(2, 4), 16) / 255;
  const b = parseInt(hex6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  l = Math.max(0, Math.min(1, l));
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r2, g2, b2;
  if (s === 0) { r2 = g2 = b2 = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r2 = hue2rgb(p, q, h + 1 / 3);
    g2 = hue2rgb(p, q, h);
    b2 = hue2rgb(p, q, h - 1 / 3);
  }
  const to2 = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return (to2(r2) + to2(g2) + to2(b2)).toUpperCase();
}

// Legacy BIFF indexed palette (0-63). 64/65 = system auto → null.
const INDEXED_PALETTE = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'
];

// exceljs color {argb}|{theme,tint}|{indexed} → '#rrggbb' or null.
function resolveColor(c, palette) {
  if (!c || typeof c !== 'object') return null;
  let hex = null;
  if (typeof c.argb === 'string' && c.argb.length === 8) hex = c.argb.slice(2);
  else if (typeof c.argb === 'string' && c.argb.length === 6) hex = c.argb;
  else if (typeof c.theme === 'number') hex = palette[c.theme] || null;
  else if (typeof c.indexed === 'number') hex = INDEXED_PALETTE[c.indexed] || null;
  if (!hex) return null;
  return '#' + applyTint(hex.toUpperCase(), c.tint || 0).toLowerCase();
}

// exceljs border style name → AGX {style,width}. Inverse of
// borderStyleName() above so a round-trip is lossless for the styles
// the AGX model can express.
const BORDER_NAME_TO_AGX = {
  thin: { style: 'solid', width: 1 }, hair: { style: 'solid', width: 1 },
  medium: { style: 'solid', width: 2 }, thick: { style: 'solid', width: 3 },
  dashed: { style: 'dashed', width: 1 }, mediumDashed: { style: 'dashed', width: 2 },
  dashDot: { style: 'dashed', width: 1 }, mediumDashDot: { style: 'dashed', width: 2 },
  dashDotDot: { style: 'dashed', width: 1 }, slantDashDot: { style: 'dashed', width: 2 },
  dotted: { style: 'dotted', width: 1 }, double: { style: 'double', width: 3 }
};

function xlsxStyleToAgxServer(cell, palette) {
  const out = {};
  const font = cell.font;
  if (font) {
    if (font.bold) out.bold = true;
    if (font.italic) out.italic = true;
    if (font.underline && font.underline !== 'none') out.underline = true;
    if (font.strike) out.strikethrough = true;
    const fc = resolveColor(font.color, palette);
    if (fc) out.color = fc;
    if (typeof font.size === 'number' && font.size > 0 && font.size !== 11) {
      out.fontSize = Math.round(font.size * 1.333); // pt → px (client convention)
    }
    if (font.name && font.name !== 'Calibri') out.fontFamily = String(font.name);
  }
  const fill = cell.fill;
  if (fill && fill.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
    // Non-solid patterns approximate as solid fgColor — better than
    // dropping a deliberate shading cue entirely.
    const bg = resolveColor(fill.fgColor, palette);
    if (bg) out.bg = bg;
  }
  const al = cell.alignment;
  if (al) {
    const h = al.horizontal;
    if (h === 'left' || h === 'center' || h === 'right') out.align = h;
    else if (h === 'centerContinuous') out.align = 'center';
    const v = al.vertical;
    if (v === 'top' || v === 'middle' || v === 'bottom') out.valign = v;
    if (al.wrapText) out.wrap = true;
  }
  const bd = cell.border;
  if (bd) {
    const borders = {};
    ['top', 'right', 'bottom', 'left'].forEach((side) => {
      const b = bd[side];
      if (!b || !b.style || b.style === 'none') return;
      const m = BORDER_NAME_TO_AGX[b.style] || { style: 'solid', width: 1 };
      borders[side] = {
        style: m.style, width: m.width,
        color: resolveColor(b.color, palette) || '#000000'
      };
    });
    if (Object.keys(borders).length) out.borders = borders;
  }
  return Object.keys(out).length ? out : null;
}

// Port of the client's numFmt → (fmt, decimals) family detection so
// imported cells render with the right $ / % / comma treatment in-grid.
function numFmtToAgx(z, out) {
  if (!z || z === 'General') return;
  z = String(z);
  const hasCurrency = /[\$£€¥]/.test(z) || /\bUSD\b/i.test(z);
  const hasPercent = /%/.test(z);
  const hasComma = /#,##0/.test(z) || /,/.test(z);
  const decMatch = z.match(/\.([0#]+)/);
  const decimals = decMatch ? decMatch[1].length : null;
  if (hasCurrency) { out.fmt = 'currency'; if (decimals != null) out.decimals = decimals; }
  else if (hasPercent) { out.fmt = 'percent'; if (decimals != null) out.decimals = decimals; }
  else if (hasComma) { out.fmt = 'comma'; if (decimals != null) out.decimals = decimals; }
  else if (/^[0]+(\.[0]+)?$/.test(z) && decimals != null) { out.fmt = 'comma'; out.decimals = decimals; }
  out.numFmt = z;
}

// ── Formula translation (shared-formula slaves) ────────────────────
function colNumToLetters(n) { // 1-based
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function lettersToColNum(s) { // → 1-based
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

// Shift the RELATIVE parts of every ref by (dR, dC); `$`-anchored parts
// stay put (Excel shared-formula semantics). Quoted strings and
// sheet-qualified names are left alone. The lookbehind/lookahead
// boundaries are load-bearing: without them, ref-shaped fragments
// INSIDE identifiers get shifted — defined names (Q1TOTAL → Q2TOTAL,
// W3_TOTAL → W4_TOTAL) and even function names (DEC2BIN → DEC3BIN,
// SUMX2MY2 → SUMX3MY2) corrupt in every shared-formula slave.
function translateFormula(f, dR, dC) {
  return String(f).replace(
    /("(?:[^"]|"")*"|'(?:[^']|'')*')|(?<![A-Za-z0-9_.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_.])/g,
    function (m, quoted, cAbs, colStr, rAbs, rowStr, offset, full) {
      if (quoted) return m;
      // A ref immediately followed by "!" is a sheet name (e.g. ABC1!D2)
      // and by "(" a function-looking token — leave both alone.
      const next = full.charAt(offset + m.length);
      if (next === '!' || next === '(') return m;
      let c = lettersToColNum(colStr);
      let r = parseInt(rowStr, 10);
      if (!cAbs) c += dC;
      if (!rAbs) r += dR;
      if (c < 1 || r < 1) return '#REF!';
      return cAbs + colNumToLetters(c) + rAbs + r;
    }
  );
}

// Strip `$` anchors (outside quoted strings) — the grid engine's ref
// regexes don't recognize them, so an anchored formula would silently
// evaluate to 0. Values are identical; only the anchor metadata is lost.
function stripAnchors(f) {
  return String(f).replace(
    /("(?:[^"]|"")*"|'(?:[^']|'')*')|\$([A-Z]{1,3})\$?(\d+)|([A-Z]{1,3})\$(\d+)/g,
    function (m, quoted, c1, r1, c2, r2) {
      if (quoted) return m;
      if (c1) return c1 + r1;
      return c2 + r2;
    }
  );
}

function importedValueOf(result) {
  if (result == null) return undefined;
  if (result instanceof Date) return result.toISOString().slice(0, 10);
  if (typeof result === 'object') return undefined; // {error:'#N/A'} etc.
  return result;
}

/**
 * Parse an .xlsx buffer into AGX sheet models (no ids — the client
 * assigns those on install). Pure function, unit-testable.
 */
async function parseXlsxToAgx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const palette = parseThemePalette(wb);
  const Types = ExcelJS.ValueType;
  const sheets = [];

  wb.eachSheet((ws) => {
    // Hidden sheets import as HIDDEN tabs — the client model supports
    // hidden:true (kept in the workbook so cross-sheet formulas and
    // named ranges into hidden rate/lookup sheets keep resolving, but
    // absent from the tab strips). Skipping them would silently break
    // every formula that reads them.
    const isHidden = !!(ws.state && ws.state !== 'visible');
    const cells = {};

    ws.eachRow({ includeEmpty: true }, (row, rn) => {
      row.eachCell({ includeEmpty: true }, (cell, cn) => {
        if (cell.type === Types.Merge) return; // merge slaves — origin + merges list carry it
        const ourAddr = colLetter(cn - 1) + rn;
        const out = { raw: '', value: '' };
        const v = cell.value;

        if (cell.type === Types.Formula || (v && typeof v === 'object' && (v.formula || v.sharedFormula))) {
          let f = v.formula;
          if (!f && v.sharedFormula) {
            // Slave cell → translate the master's formula by the offset.
            try {
              const master = ws.getCell(v.sharedFormula);
              const mf = master.value && master.value.formula;
              if (mf) {
                const mPos = parseAddr(v.sharedFormula.replace(/\$/g, ''));
                f = mPos ? translateFormula(mf, (rn - 1) - mPos.r, (cn - 1) - mPos.c) : mf;
              }
            } catch (e) { /* master unreachable — fall through */ }
          }
          if (f) {
            out.raw = '=' + stripAnchors(f);
            const iv = importedValueOf(v.result);
            if (iv !== undefined) { out.importedValue = iv; out.value = iv; }
          } else {
            const iv = importedValueOf(v.result);
            out.raw = iv !== undefined ? iv : '';
            out.value = out.raw;
          }
        } else if (v && typeof v === 'object' && v.richText) {
          out.raw = v.richText.map((r) => (r && r.text) || '').join('');
          out.value = out.raw;
        } else if (v && typeof v === 'object' && v.hyperlink) {
          // Display text may itself be a rich string (one bolded word,
          // pasted-from-browser runs) — exceljs nests it at v.text as
          // {richText:[…]}; String() would bake in "[object Object]".
          let text;
          if (v.text != null && typeof v.text === 'object' && v.text.richText) {
            text = v.text.richText.map((r) => (r && r.text) || '').join('');
          } else if (v.text != null) {
            text = String(v.text);
          } else {
            text = String(v.hyperlink);
          }
          out.raw = text; out.value = text;
          out.hyperlink = { url: String(v.hyperlink) };
        } else if (v instanceof Date) {
          out.raw = v.toISOString().slice(0, 10);
          out.value = out.raw;
        } else if (typeof v === 'boolean') {
          out.raw = v ? 'TRUE' : 'FALSE'; out.value = out.raw;
        } else if (v && typeof v === 'object' && v.error) {
          out.raw = String(v.error); out.value = out.raw;
        } else if (v != null) {
          out.raw = v; out.value = v;
        }

        const style = xlsxStyleToAgxServer(cell, palette);
        if (style) out.style = style;
        numFmtToAgx(cell.numFmt, out);
        if (cell.note) {
          const note = typeof cell.note === 'string' ? cell.note
            : (cell.note.texts || []).map((t) => (t && t.text) || '').join('');
          if (note) out.note = note;
        }

        // Keep the cell if it has content OR meaningful style/format —
        // style-only cells (bordered/filled blank regions) matter.
        if (out.raw === '' && !out.style && !out.numFmt && !out.note && !out.hyperlink) return;
        cells[ourAddr] = out;
      });
    });

    // Geometry — exact Excel units (S4) + px for the grid renderer.
    // ws.columns is NULL (not []) when a sheet has no <cols> element
    // and no cells — e.g. a blank leftover "Sheet3", which would
    // otherwise crash the whole parse.
    const colWidths = {}, colWch = {};
    (ws.columns || []).forEach((col, idx) => {
      if (col && typeof col.width === 'number' && col.width > 0) {
        colWch[idx] = col.width;
        colWidths[idx] = Math.max(24, Math.round(col.width * 7 + 5));
      }
    });
    const rowHeights = {}, rowHpt = {};
    ws.eachRow({ includeEmpty: true }, (row, rn) => {
      if (typeof row.height === 'number' && row.height > 0) {
        rowHpt[rn - 1] = row.height;
        rowHeights[rn - 1] = Math.max(12, Math.round(row.height * 1.333));
      }
    });

    const merges = ((ws.model && ws.model.merges) || []).map((ref) => {
      const parts = String(ref).split(':');
      const a = parseAddr(parts[0]), b = parseAddr(parts[1] || parts[0]);
      return (a && b) ? { r1: a.r, c1: a.c, r2: b.r, c2: b.c } : null;
    }).filter(Boolean);

    // Excel stores a merged block's outline border on its constituent
    // cells — the right edge lives on the last-COLUMN slaves and the
    // bottom edge on the last-ROW slaves — but the model keeps only
    // the origin (slaves were skipped above) and the grid renders a
    // merge as one origin <td>. Lift each outer edge from whichever
    // constituent carries it onto the origin so boxed merged headers
    // keep all four sides.
    merges.forEach((m) => {
      const originAddr = colLetter(m.c1) + (m.r1 + 1);
      let origin = cells[originAddr];
      const lift = (side, positions) => {
        if (origin && origin.style && origin.style.borders && origin.style.borders[side]) return;
        for (const pos of positions) {
          let b = null;
          try { b = ws.getCell(pos[0] + 1, pos[1] + 1).border; } catch (e) { /* out of range */ }
          const bs = b && b[side];
          if (bs && bs.style && bs.style !== 'none') {
            const map = BORDER_NAME_TO_AGX[bs.style] || { style: 'solid', width: 1 };
            if (!origin) origin = cells[originAddr] = { raw: '', value: '' };
            origin.style = origin.style || {};
            origin.style.borders = origin.style.borders || {};
            origin.style.borders[side] = {
              style: map.style, width: map.width,
              color: resolveColor(bs.color, palette) || '#000000'
            };
            return;
          }
        }
      };
      const rowSpan = [], colSpan = [];
      for (let r = m.r1; r <= m.r2; r++) rowSpan.push(r);
      for (let c = m.c1; c <= m.c2; c++) colSpan.push(c);
      lift('top', colSpan.map((c) => [m.r1, c]));
      lift('bottom', colSpan.map((c) => [m.r2, c]));
      lift('left', rowSpan.map((r) => [r, m.c1]));
      lift('right', rowSpan.map((r) => [r, m.c2]));
    });

    let frozen = null;
    const view = (ws.views || [])[0];
    if (view && view.state === 'frozen') {
      const fRow = (view.ySplit || 0) >= 1, fCol = (view.xSplit || 0) >= 1;
      frozen = fRow && fCol ? 'both' : (fRow ? 'row' : (fCol ? 'col' : null));
    }

    let autoFilter = null;
    const af = ws.autoFilter || (ws.model && ws.model.autoFilter);
    if (af) {
      let a = null, b = null;
      if (typeof af === 'string') {
        const parts = af.split(':');
        a = parseAddr(parts[0].replace(/\$/g, ''));
        b = parseAddr((parts[1] || parts[0]).replace(/\$/g, ''));
      } else if (af.from && af.to) {
        const norm = (x) => typeof x === 'string' ? parseAddr(x.replace(/\$/g, ''))
          : { r: (x.row || 1) - 1, c: (x.column || 1) - 1 };
        a = norm(af.from); b = norm(af.to);
      }
      if (a && b) autoFilter = { r1: a.r, c1: a.c, r2: b.r, c2: b.c, filters: {} };
    }

    const sheet = {
      name: ws.name,
      kind: 'grid',
      rows: Math.max(ws.rowCount || 1, 1),
      cols: Math.max(ws.columnCount || 1, 1),
      cells, colWidths, colWch, rowHeights, rowHpt,
      links: {}, merges, tables: []
    };
    if (isHidden) sheet.hidden = true;
    if (frozen) sheet.frozen = frozen;
    if (autoFilter) sheet.autoFilter = autoFilter;
    sheets.push(sheet);
  });

  // Workbook-level defined names → [{name, ref}] (first range only —
  // the AGX model is single-rectangle). Skips Excel built-ins.
  const namedRanges = [];
  try {
    (wb.definedNames.model || []).forEach((dn) => {
      if (!dn || !dn.name || /^_xlnm\./i.test(dn.name)) return;
      const ref = Array.isArray(dn.ranges) ? dn.ranges[0] : null;
      if (ref) namedRanges.push({ name: dn.name, ref: String(ref) });
    });
  } catch (e) { /* defined-names model unavailable — skip */ }

  return { sheets, namedRanges };
}

// ── POST /api/workspace/import-xlsx ─────────────────────────────────
router.post('/import-xlsx', requireAuth,
  express.raw({ type: () => true, limit: '30mb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length < 100) {
        return res.status(400).json({ error: 'No file bytes received' });
      }
      const parsed = await parseXlsxToAgx(req.body);
      if (!parsed.sheets.length) return res.status(400).json({ error: 'No importable sheets in that file' });
      res.json(parsed);
    } catch (e) {
      console.error('POST /api/workspace/import-xlsx error:', e);
      res.status(422).json({ error: 'Could not parse that .xlsx: ' + (e.message || e) });
    }
  });

module.exports = router;
module.exports.buildWorkbook = buildWorkbook;
module.exports.parseXlsxToAgx = parseXlsxToAgx;
