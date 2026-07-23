// Promise confirm. Native confirm() returns undefined inside an installed PWA,
// so every `if (!confirm(x)) return` guard silently did nothing there: the
// dialog never appeared and the action never ran. Uses the in-app overlay when
// present, native only as a fallback.
function p86Ask(message, opts) {
  opts = opts || {};
  if (typeof window.p86Confirm === 'function') {
    return window.p86Confirm({
      title: opts.title || 'Confirm', message: message,
      confirmLabel: opts.confirmLabel || 'Confirm', confirmText: opts.confirmLabel || 'Confirm',
      cancelLabel: 'Cancel', cancelText: 'Cancel',
      danger: opts.danger !== false, destructive: opts.danger !== false
    });
  }
  return Promise.resolve(window.confirm(message));
}
// ============================================================
// Project 86 — Workspace Spreadsheet Engine (v3)
// v3 fix: click-to-select uses mousedown + preventDefault
// so formula bar stays focused during reference mode
// Enhanced with formula reference mode, grouped linkable fields,
// and colored cell reference highlighting
// ============================================================

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────
  // Default grid: A-Z (26 columns) × 100 rows. Existing workspaces grow
  // up to this minimum on next load — see loadSheetIntoGrid which uses
  // Math.max(saved.rows, MIN_ROWS) — so no data is lost, just more
  // empty space available to drag into.
  const MIN_ROWS = 100;
  const MIN_COLS = 26;
  const EXPAND_BUFFER = 2; // rows/cols to add when typing at edge
  const COL_DEFAULT_WIDTH = 100;
  const ROW_HEIGHT = 28;
  const UNDO_MAX = 50;

  // Reference mode colors (6 distinct colors for cell references)
  const REF_COLORS = [
    '#4f8cff', '#34d399', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899'
  ];

  // Color palette for fill/font pickers
  const COLOR_PALETTE = [
    '#ffffff', '#000000', '#f87171', '#fb923c', '#fbbf24', '#34d399',
    '#4f8cff', '#a78bfa', '#ec4899', '#6b7280',
    '#fecaca', '#1f2937', '#dc2626', '#ea580c', '#d97706', '#059669',
    '#2563eb', '#7c3aed', '#db2777', '#374151',
    '#fee2e2', '#111827', '#991b1b', '#9a3412', '#92400e', '#065f46',
    '#1e40af', '#5b21b6', '#9d174d', '#1a1a20'
  ];

  // Cell style presets
  const CELL_STYLES = [
    { name: 'Header', style: { bold: true, bg: '#2563eb', color: '#ffffff', align: 'center' } },
    { name: 'Header Dark', style: { bold: true, bg: '#1f2937', color: '#ffffff', align: 'center' } },
    { name: 'Header Green', style: { bold: true, bg: '#059669', color: '#ffffff', align: 'center' } },
    { name: 'Subheader', style: { bold: true, bg: '#374151', color: '#e4e6f0', align: 'left' } },
    { name: 'Total Row', style: { bold: true, bg: '#1a1a20', color: '#4f8cff', align: 'right' } },
    { name: 'Highlight', style: { bg: '#fef3c7', color: '#92400e' } },
    { name: 'Success', style: { bg: '#d1fae5', color: '#065f46' } },
    { name: 'Warning', style: { bg: '#fee2e2', color: '#991b1b' } },
    { name: 'Subtle', style: { bg: '#f3f4f6', color: '#374151' } },
    { name: 'Plain', style: {} }
  ];

  // Recent colors (max 3 each for fill and font)
  var recentFillColors = [];
  var recentFontColors = [];

  // ── State ──────────────────────────────────────────────────
  // Workbook = collection of sheets, like an Excel file. Persistent
  // state lives here. Each sheet carries its own grid (cells, dimensions,
  // links, merges, column widths). The active sheet's data is mirrored
  // into the `grid` object below, which all the existing rendering /
  // editing / formula functions read from. switchSheet keeps the two
  // in sync.
  let workbook = {
    // Pre-Phase-0, the workbook keyed off jobId only — both the
    // localStorage slot and the QB-Costs embedded view used it
    // directly. Phase 0 generalizes to (entityType, entityId) so the
    // estimate editor can host its own workbook alongside line items
    // / details / attachments, and so 86 has a server-readable
    // address for the workbook independent of which side hosts it.
    //
    // jobId is kept as a derived back-compat field: when entityType
    // is 'job', it equals entityId; otherwise null. Callers that
    // still read workbook.jobId (e.g. the QB-Costs renderer) keep
    // working without modification.
    entityType: null,   // 'job' | 'estimate'
    entityId: null,
    get jobId() {
      return this.entityType === 'job' ? this.entityId : null;
    },
    set jobId(v) {
      // Legacy assignment site — treat any set as the job side.
      this.entityType = v == null ? null : 'job';
      this.entityId = v;
    },
    activeSheetId: null,
    sheets: [],        // [{ id, name, rows, cols, cells, colWidths, links, merges }, ...]
    // Workbook-scoped named ranges: { NAME: { ref, sheetId?, comment? } }.
    // `ref` is an A1 reference ("Sheet1!A1", "A1:B5", or bare "A1"/"A1:B5"
    // that resolves against the sheet named in `sheetId`, falling back to
    // the active sheet). Names are case-insensitive (stored upper-cased).
    namedRanges: {},
    dirty: false
  };

  function newSheetId() {
    return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function makeBlankSheet(name) {
    return {
      id: newSheetId(),
      name: name || 'Sheet1',
      kind: 'grid',     // 'grid' (default Excel-style sheet) | 'qb-costs' (embedded Detailed Costs view)
      rows: MIN_ROWS,
      cols: MIN_COLS,
      cells: {},
      colWidths: {},
      rowHeights: {},   // { 0: 32, 5: 48, ... } — rows not in here get ROW_HEIGHT
      links: {},
      merges: [],
      tables: []        // [{ r1, c1, r2, c2, style }] — formatted ranges
    };
  }

  // Permanent embedded views (one slot per kind). Auto-injected into
  // every job's workbook on load so the user can switch between them
  // and grid sheets via the bottom tab strip.
  const QB_COSTS_SHEET_ID = '__qb_costs__';
  const ATTACHMENTS_SHEET_ID = '__attachments__';
  function makeQBCostsSheet() {
    return {
      id: QB_COSTS_SHEET_ID,
      name: 'Detailed Costs',
      kind: 'qb-costs',
      // Grid fields kept as no-ops so existing helpers that touch
      // sheets (e.g. exporters) don't blow up if they iterate.
      rows: 0, cols: 0, cells: {}, colWidths: {}, rowHeights: {},
      links: {}, merges: [], tables: [],
      pinned: true       // tab strip uses this to lock rename/delete
    };
  }
  function makeAttachmentsSheet() {
    return {
      id: ATTACHMENTS_SHEET_ID,
      name: 'Attachments',
      kind: 'attachments',
      rows: 0, cols: 0, cells: {}, colWidths: {}, rowHeights: {},
      links: {}, merges: [], tables: [],
      pinned: true
    };
  }
  function isEmbedSheet(sheet) {
    return !!(sheet && sheet.kind && sheet.kind !== 'grid');
  }
  function activeSheet() {
    return workbook.sheets.find(s => s.id === workbook.activeSheetId) || null;
  }

  // Excel theme toggle — only applies to actual spreadsheet sheets,
  // NOT to embedded views (Detailed Costs, Attachments). Those views
  // use the app's regular light/dark mode so they look like the rest
  // of the app rather than wearing an out-of-place white-on-white
  // Excel skin.
  function applyExcelThemeForActiveSheet() {
    if (!wsContainer) return;
    var s = activeSheet();
    var shouldTheme = !isEmbedSheet(s);
    wsContainer.classList.toggle('ws-excel-theme', shouldTheme);
  }

  let grid = {
    rows: MIN_ROWS,
    cols: MIN_COLS,
    cells: {},       // { "A1": { raw: "=B1*2", value: 42, fmt: null, style: {} }, ... }
    colWidths: {},   // { 0: 120, 1: 100, ... }
    rowHeights: {},  // { 0: 32, ... } — only rows resized away from default
    selection: null,  // { r: 0, c: 0 }
    selEnd: null,     // { r, c } for range selection end (null = single cell)
    editing: null,    // { r: 0, c: 0 }
    links: {},        // { "C5": "contractAmount", "D5": "estimatedCosts" }
    merges: [],       // [{ r1, c1, r2, c2 }, ...] merged cell ranges
    tables: [],       // [{ r1, c1, r2, c2, style }] — formatted table ranges
    jobId: null,
    dirty: false,
    refMode: false,   // TRUE when entering a formula
    refAnchor: null,  // Which cell/formula bar started the formula
    undoStack: [],
    redoStack: []
  };

  let wsContainer = null;   // DOM root
  let wsTable = null;
  let formulaBar = null;
  let linkPanel = null;
  let refModeOverlay = null; // Colored reference display overlay

  // ── Helpers ────────────────────────────────────────────────

  /** Column index → letter (0=A, 25=Z, 26=AA) */
  function colLetter(c) {
    let s = '';
    let n = c;
    while (n >= 0) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }

  /** Letter → index */
  function letterToCol(l) {
    let n = 0;
    for (let i = 0; i < l.length; i++) {
      n = n * 26 + (l.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  /** Cell address from row/col */
  function addr(r, c) { return colLetter(c) + (r + 1); }

  /** Parse "A1" → { r: 0, c: 0 } */
  function parseAddr(a) {
    const m = a.match(/^([A-Z]+)(\d+)$/i);
    if (!m) return null;
    return { r: parseInt(m[2], 10) - 1, c: letterToCol(m[1].toUpperCase()) };
  }

  /** Get cell data (never undefined) */
  function getCell(r, c) {
    const key = addr(r, c);
    if (!grid.cells[key]) grid.cells[key] = { raw: '', value: '', fmt: null, style: {} };
    return grid.cells[key];
  }

  /** Format a value for display */
  function displayVal(cell) {
    if (cell.value === '' || cell.value === null || cell.value === undefined) return '';
    if (cell.error) return cell.error;
    if (typeof cell.value === 'number') {
      // Phase 2: a custom Excel-style format string (cell.numFmt) wins
      // over the quick-button enum (cell.fmt). The user sets it via the
      // Number-format editor; it also round-trips to .xlsx as the `z`
      // code so Excel renders it identically.
      if (cell.numFmt) {
        var out = applyExcelNumFmt(cell.value, cell.numFmt);
        if (out != null) return out;
      }
      // Decimal count comes from cell.decimals when explicitly set
      // (the increase/decrease-decimal buttons write that field), else
      // each format has a sensible default (currency=2, percent=1,
      // comma=0). Lets the user nudge precision without losing the
      // base format choice.
      var fmtDecimals = (typeof cell.decimals === 'number')
        ? cell.decimals
        : (cell.fmt === 'currency' ? 2 : cell.fmt === 'percent' ? 1 : 0);
      if (cell.fmt === 'currency') return '$' + cell.value.toLocaleString('en-US', { minimumFractionDigits: fmtDecimals, maximumFractionDigits: fmtDecimals });
      if (cell.fmt === 'percent') return (cell.value * 100).toFixed(fmtDecimals) + '%';
      if (cell.fmt === 'comma') return cell.value.toLocaleString('en-US', { minimumFractionDigits: fmtDecimals, maximumFractionDigits: fmtDecimals });
      // Auto-format: if it looks like money (has decimals)
      if (Number.isFinite(cell.value) && !Number.isInteger(cell.value)) {
        return cell.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return cell.value.toLocaleString('en-US');
    }
    return String(cell.value);
  }

  /** Escape a string for safe insertion into innerHTML. */
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;';
    });
  }

  /**
   * The HTML that renders inside a cell's <td>. Plain values are escaped
   * (so cell content can never inject markup); a cell carrying a
   * hyperlink renders as a clickable anchor instead.
   */
  function cellInnerHTML(cell) {
    if (!cell) return '';
    var caret = (cell.validation && cell.validation.type === 'list')
      ? '<span class="ws-validation-caret" data-ws-vcaret="1" title="Pick from list">&#x25BE;</span>'
      : '';
    if (cell.hyperlink && cell.hyperlink.url) {
      var base = displayVal(cell);
      var disp = (base !== '' && base != null) ? base : (cell.hyperlink.display || cell.hyperlink.url);
      return '<a class="ws-hyperlink" data-ws-link="1" href="' + escapeHTML(cell.hyperlink.url) +
             '" target="_blank" rel="noopener noreferrer" title="' + escapeHTML(cell.hyperlink.url) + '">' +
             escapeHTML(disp) + '</a>' + caret;
    }
    return escapeHTML(displayVal(cell)) + caret;
  }

  /**
   * Minimal Excel custom-number-format renderer. Supports the common
   * subset that covers ~all real construction-workbook needs:
   *   digit placeholders  0  #  ?
   *   thousands grouping  ,        decimal point  .
   *   percent             %        literal $ and text
   *   quoted literals     "USD"    escaped char  \x
   *   positive;negative[;zero] sections (negatives can use parens/color)
   * Date codes (m/d/y/h/s) are recognized when the format looks like a
   * date pattern and the value is a plausible Excel serial date.
   * Returns null when it can't render (caller falls back to defaults).
   */
  function applyExcelNumFmt(value, fmt) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    if (typeof fmt !== 'string' || !fmt.trim()) return null;
    var f = fmt.trim();

    // General → default rendering.
    if (/^general$/i.test(f)) return null;

    // Date/time formats — detect by date tokens not inside quotes.
    var stripped = f.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    if (/[ymdhs]/i.test(stripped) && !/[#0]/.test(stripped)) {
      return formatExcelDate(value, f);
    }

    // Numeric: split into positive;negative;zero sections.
    var sections = f.split(';');
    var section;
    if (value > 0) section = sections[0];
    else if (value < 0) section = sections[1] != null ? sections[1] : sections[0];
    else section = sections[2] != null ? sections[2] : sections[0];
    if (section == null) section = sections[0];

    var negativeHandledBySection = value < 0 && sections[1] != null;
    // Always format the magnitude — the sign is conveyed by either the
    // dedicated negative section's literals (parens/minus) or the manual
    // '-' prefix we add below when falling back to the positive section.
    var abs = value < 0 ? Math.abs(value) : value;

    try {
      var rendered = renderNumericSection(abs, section);
      if (rendered == null) return null;
      // If we used the positive section for a negative number and the
      // section had no explicit sign handling, prefix a minus.
      if (value < 0 && !negativeHandledBySection && !/^[^0-9#]*-/.test(rendered)) {
        rendered = '-' + rendered;
      }
      return rendered;
    } catch (e) {
      return null;
    }
  }

  function renderNumericSection(value, section) {
    if (section == null) return null;

    // Pull out quoted literals + escaped chars FIRST so a quoted "%" or
    // "$" isn't mistaken for a percent multiplier / format code. Each
    // literal becomes a single sentinel, restored in order later.
    var literals = [];
    var work = section.replace(/"([^"]*)"/g, function (m, t) { literals.push(t); return '\u0000'; });
    work = work.replace(/\\(.)/g, function (m, ch) { literals.push(ch); return '\u0000'; });

    // Strip color/condition brackets like [Red] [>=100].
    work = work.replace(/\[[^\]]*\]/g, '');

    // A bare (unquoted) % multiplies the value by 100. A quoted "%" was
    // already pulled into a literal above, so it won't trigger this.
    var isPercent = work.indexOf('%') !== -1;
    var v = isPercent ? value * 100 : value;

    // Locate the numeric mask (the run containing 0 # ? . ,). Everything
    // before it is a prefix ($, etc.); everything after is a suffix (%).
    var maskMatch = work.match(/[#0?][#0?,]*(\.[#0?]*)?|\.[#0?]+/);
    if (!maskMatch) {
      // No numeric placeholders — pure text section. Restore literals.
      return restoreLiterals(work, literals);
    }
    var mask = maskMatch[0];
    var prefix = work.slice(0, maskMatch.index);
    var suffix = work.slice(maskMatch.index + mask.length);

    var hasComma = mask.indexOf(',') !== -1;
    var dotIdx = mask.indexOf('.');
    var intMask = dotIdx === -1 ? mask : mask.slice(0, dotIdx);
    var decMask = dotIdx === -1 ? '' : mask.slice(dotIdx + 1);
    intMask = intMask.replace(/,/g, '');
    var decimals = (decMask.match(/[0#?]/g) || []).length;

    var num = v.toLocaleString('en-US', {
      minimumFractionDigits: (decMask.match(/0/g) || []).length,
      maximumFractionDigits: decimals,
      useGrouping: hasComma
    });
    // Pad leading zeros to satisfy required integer digits (0 placeholders).
    var reqIntDigits = (intMask.match(/0/g) || []).length;
    if (reqIntDigits > 1) {
      var parts = num.split('.');
      var digitsOnly = parts[0].replace(/[^0-9]/g, '');
      if (digitsOnly.length < reqIntDigits) {
        parts[0] = '0'.repeat(reqIntDigits - digitsOnly.length) + parts[0];
      }
      num = parts.join('.');
    }

    return restoreLiterals(prefix, literals) + num + restoreLiterals(suffix, literals);
  }

  function restoreLiterals(str, literals) {
    return String(str).replace(/\u0000/g, function () { return literals.length ? literals.shift() : ""; });
  }

  // Excel serial-date → formatted string. Excel day 1 = 1900-01-01,
  // with the legacy 1900-leap-year bug (serial 60 = fictional Feb 29).
  function excelSerialToDate(serial) {
    var utcDays = Math.floor(serial) - 25569; // 25569 = days from 1970 epoch to 1900 base
    var ms = utcDays * 86400 * 1000;
    var frac = serial - Math.floor(serial);
    ms += Math.round(frac * 86400) * 1000;
    return new Date(ms);
  }

  function formatExcelDate(value, fmt) {
    // Only treat as a date when the value is in a plausible serial range
    // (roughly year 1900–2200). Otherwise let the default renderer win.
    if (value < 1 || value > 110000) return null;
    var d = excelSerialToDate(value);
    if (isNaN(d.getTime())) return null;
    var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var MONF = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var DAYF = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var h24 = d.getUTCHours();
    var h12 = h24 % 12; if (h12 === 0) h12 = 12;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var ampm = /am\/pm|a\/p/i.test(fmt);
    // Order matters — match longer tokens first.
    return fmt
      .replace(/"([^"]*)"/g, '$1')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/yyyy/gi, d.getUTCFullYear())
      .replace(/yy/gi, String(d.getUTCFullYear()).slice(-2))
      .replace(/mmmm/gi, MONF[d.getUTCMonth()])
      .replace(/mmm/gi, MON[d.getUTCMonth()])
      .replace(/dddd/gi, DAYF[d.getUTCDay()])
      .replace(/ddd/gi, DAY[d.getUTCDay()])
      .replace(/dd/gi, pad(d.getUTCDate()))
      .replace(/\bd\b/gi, d.getUTCDate())
      .replace(/mm/g, pad(d.getUTCMonth() + 1))
      .replace(/\bm\b/g, d.getUTCMonth() + 1)
      .replace(/hh/gi, pad(ampm ? h12 : h24))
      .replace(/\bh\b/gi, (ampm ? h12 : h24))
      .replace(/ss/gi, pad(d.getUTCSeconds()))
      .replace(/am\/pm/gi, h24 < 12 ? 'AM' : 'PM')
      .replace(/a\/p/gi, h24 < 12 ? 'A' : 'P')
      .replace(/d(?![a-z])/gi, d.getUTCDate());
  }

  // ── Reference Mode & Highlighting ─────────────────────────

  /**
   * Extract all cell references from a formula
   * Returns array of unique cell addresses like ['A1', 'B3', 'C5']
   */
  function extractCellRefs(formula) {
    const refs = [];
    const regex = /\b([A-Z]+)(\d+)\b/gi;
    let match;
    while ((match = regex.exec(formula)) !== null) {
      const ref = match[0].toUpperCase();
      if (!refs.includes(ref)) refs.push(ref);
    }
    return refs;
  }

  /**
   * Assign colors to cell references and return a map
   * { "A1": 0, "B3": 1, "C5": 2, ... } where number is color index
   */
  function getRefColorMap(formula) {
    const refs = extractCellRefs(formula);
    const map = {};
    refs.forEach((ref, idx) => {
      map[ref] = idx % REF_COLORS.length;
    });
    return map;
  }

  /**
   * Enter reference mode: user is building a formula
   */
  function enterRefMode(source = 'formulaBar') {
    grid.refMode = true;
    grid.refAnchor = { type: source };
    if (source === 'cell' && grid.editing) {
      grid.refAnchor.r = grid.editing.r;
      grid.refAnchor.c = grid.editing.c;
    }
    updateRefModeUI();
  }

  /**
   * Exit reference mode
   */
  function exitRefMode() {
    grid.refMode = false;
    grid.refAnchor = null;
    clearRefHighlights();
    updateRefModeUI();
  }

  /**
   * Clear all reference highlights from the grid
   */
  function clearRefHighlights() {
    wsTable.querySelectorAll('td.ws-cell').forEach(td => {
      td.style.borderColor = '';
      td.style.backgroundColor = '';
      td.classList.remove('ws-ref-highlight');
    });
  }

  /**
   * Apply colored highlights to cells referenced in the current formula
   */
  function applyRefHighlights(formula) {
    if (!formula) return;
    clearRefHighlights();

    const colorMap = getRefColorMap(formula);
    Object.entries(colorMap).forEach(([ref, colorIdx]) => {
      const parsed = parseAddr(ref);
      if (!parsed) return;
      const td = wsTable.querySelector(`td[data-r="${parsed.r}"][data-c="${parsed.c}"]`);
      if (td) {
        const color = REF_COLORS[colorIdx];
        td.style.borderColor = color;
        td.style.borderWidth = '2px';
        td.classList.add('ws-ref-highlight');
      }
    });
  }

  /**
   * Update UI to reflect reference mode state
   */
  function updateRefModeUI() {
    if (!formulaBar) return;
    if (grid.refMode) {
      formulaBar.classList.add('ws-ref-mode');
      // Apply highlights based on current formula bar content
      const content = formulaBar.value;
      if (content.startsWith('=')) {
        applyRefHighlights(content.substring(1));
      }
    } else {
      formulaBar.classList.remove('ws-ref-mode');
      clearRefHighlights();
    }
  }

  /**
   * Insert a cell reference into the formula bar at cursor position
   */
  function insertCellRefIntoFormula(cellRef) {
    // If formula bar is focused, insert into formula bar
    if (formulaBar === document.activeElement) {
      const cursorPos = formulaBar.selectionStart;
      const content = formulaBar.value;
      formulaBar.value = content.slice(0, cursorPos) + cellRef + content.slice(cursorPos);
      const newPos = cursorPos + cellRef.length;
      formulaBar.selectionStart = newPos;
      formulaBar.selectionEnd = newPos;
      if (grid.refMode && content.startsWith('=')) {
        applyRefHighlights(formulaBar.value.substring(1));
      }
      return;
    }

    // If editing a cell, insert into the cell and sync to formula bar
    if (grid.editing) {
      const td = wsTable.querySelector(`td[data-r="${grid.editing.r}"][data-c="${grid.editing.c}"]`);
      if (!td) return;
      const sel = window.getSelection();
      const content = td.textContent;
      let cursorPos = content.length;
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (td.contains(range.startContainer)) cursorPos = range.startOffset;
      }
      td.textContent = content.slice(0, cursorPos) + cellRef + content.slice(cursorPos);
      // Place cursor after inserted ref
      const newPos = cursorPos + cellRef.length;
      const range = document.createRange();
      if (td.firstChild) {
        range.setStart(td.firstChild, newPos);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      // Sync to formula bar
      if (formulaBar) formulaBar.value = td.textContent;
      if (grid.refMode && td.textContent.startsWith('=')) {
        applyRefHighlights(td.textContent.substring(1));
      }
    }
  }

  // ── Formula Engine ─────────────────────────────────────────

  /** Safe arithmetic expression evaluator - replaces Function()/eval() */
  function safeEvalExpr(expr) {
    var tokens = [];
    var str = expr.trim();
    var i = 0;

    // Tokenize
    while (i < str.length) {
      if (str[i] === ' ') { i++; continue; }

      // Number (including decimals and negative after operator/start)
      if (/[0-9.]/.test(str[i]) ||
          (str[i] === '-' && (tokens.length === 0 || typeof tokens[tokens.length - 1] === 'string'))) {
        var num = '';
        if (str[i] === '-') { num = '-'; i++; }
        while (i < str.length && /[0-9.eE]/.test(str[i])) { num += str[i]; i++; }
        var parsed = Number(num);
        if (isNaN(parsed)) throw new Error('Invalid number');
        tokens.push(parsed);
        continue;
      }

      // Two-char operators
      if (i + 1 < str.length) {
        var two = str[i] + str[i + 1];
        if (two === '>=' || two === '<=' || two === '==' || two === '!=') {
          tokens.push(two); i += 2; continue;
        }
      }

      // Single-char operators and parens
      if ('+-*/%()><'.indexOf(str[i]) !== -1) {
        tokens.push(str[i]); i++; continue;
      }

      // Ternary
      if (str[i] === '?' || str[i] === ':') {
        tokens.push(str[i]); i++; continue;
      }

      throw new Error('Unexpected character: ' + str[i]);
    }

    // Recursive descent parser
    var pos = 0;
    function peek() { return pos < tokens.length ? tokens[pos] : null; }
    function consume() { return tokens[pos++]; }

    function parseTernary() {
      var left = parseComparison();
      if (peek() === '?') {
        consume();
        var trueVal = parseTernary();
        if (peek() !== ':') throw new Error('Expected :');
        consume();
        var falseVal = parseTernary();
        return left ? trueVal : falseVal;
      }
      return left;
    }

    function parseComparison() {
      var left = parseAddSub();
      while (peek() === '>' || peek() === '<' || peek() === '>=' || peek() === '<=' || peek() === '==' || peek() === '!=') {
        var op = consume();
        var right = parseAddSub();
        if (op === '>') left = left > right ? 1 : 0;
        else if (op === '<') left = left < right ? 1 : 0;
        else if (op === '>=') left = left >= right ? 1 : 0;
        else if (op === '<=') left = left <= right ? 1 : 0;
        else if (op === '==') left = left == right ? 1 : 0;
        else if (op === '!=') left = left != right ? 1 : 0;
      }
      return left;
    }

    function parseAddSub() {
      var left = parseMulDiv();
      while (peek() === '+' || peek() === '-') {
        var op = consume();
        var right = parseMulDiv();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    }

    function parseMulDiv() {
      var left = parseUnary();
      while (peek() === '*' || peek() === '/' || peek() === '%') {
        var op = consume();
        var right = parseUnary();
        if (op === '*') left = left * right;
        else if (op === '/') left = right === 0 ? Infinity : left / right;
        else left = left % right;
      }
      return left;
    }

    function parseUnary() {
      if (peek() === '-') { consume(); return -parsePrimary(); }
      if (peek() === '+') { consume(); return parsePrimary(); }
      return parsePrimary();
    }

    function parsePrimary() {
      var t = peek();
      if (typeof t === 'number') { consume(); return t; }
      if (t === '(') {
        consume();
        var val = parseTernary();
        if (peek() !== ')') throw new Error('Expected )');
        consume();
        return val;
      }
      throw new Error('Unexpected token: ' + t);
    }

    var result = parseTernary();
    if (pos < tokens.length) throw new Error('Unexpected trailing tokens');
    return result;
  }

  // ── Formula Helpers ──────────────────────────────────────

  // Per-evaluation cross-sheet range registry. evaluate() resets this
  // at the start of each formula and pre-resolves every `Sheet!A1:B10`
  // reference into a sentinel token (`__XR<n>__`). getRange2D and
  // getRangeCells detect those tokens and return the registered values
  // — letting VLOOKUP / INDEX / MATCH / SUM-style functions consume
  // ranges from any sheet, not just the active one.
  var xrRegistry = [];

  function registerXRange(sheet, r1, c1, r2, c2) {
    var rows = [];
    var minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    var minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    for (var r = minR; r <= maxR; r++) {
      var row = [];
      for (var c = minC; c <= maxC; c++) {
        row.push(getCellFromSheet(sheet, r, c).value);
      }
      rows.push(row);
    }
    var idx = xrRegistry.length;
    xrRegistry.push(rows);
    return '__XR' + idx + '__';
  }

  function lookupXRange2D(token) {
    var m = String(token).match(/__XR(\d+)__/);
    if (!m) return null;
    return xrRegistry[+m[1]] || null;
  }

  /** Split function args by comma, respecting nested parens */
  function splitArgs(str) {
    var args = [], depth = 0, cur = '';
    for (var i = 0; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') depth--;
      if (str[i] === ',' && depth === 0) { args.push(cur.trim()); cur = ''; }
      else cur += str[i];
    }
    if (cur.trim()) args.push(cur.trim());
    return args;
  }

  /** Collect numeric values from a range like A1:B5 */
  function getRangeValues(rangeStr) {
    // Cross-sheet sentinel: flatten + filter numerics so SUM/AVERAGE/etc.
    // ranges from another sheet behave like in-sheet ranges.
    var xr = lookupXRange2D(rangeStr.trim());
    if (xr) {
      var vals = [];
      for (var i = 0; i < xr.length; i++)
        for (var j = 0; j < xr[i].length; j++) {
          var v = xr[i][j];
          if (typeof v === 'number') vals.push(v);
        }
      return vals;
    }
    var m = rangeStr.match(/^([A-Z]+\d+):([A-Z]+\d+)$/i);
    if (!m) return [];
    var s = parseAddr(m[1].toUpperCase()), e = parseAddr(m[2].toUpperCase());
    if (!s || !e) return [];
    var vals = [];
    for (var r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++)
      for (var c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
        var v = getCell(r, c).value;
        if (typeof v === 'number') vals.push(v);
      }
    return vals;
  }

  /** Evaluate a single function call */
  // ── Range / criteria helpers (used by expanded functions) ──

  /** Collect raw cell values (any type) from a range. Used by text and
   *  lookup functions where numeric coercion would lose information. */
  function getRangeCells(rangeStr) {
    // Cross-sheet range sentinel — flatten the registered 2D grid.
    var xr = lookupXRange2D(rangeStr.trim());
    if (xr) {
      var flat = [];
      for (var i = 0; i < xr.length; i++)
        for (var j = 0; j < xr[i].length; j++) flat.push(xr[i][j]);
      return flat;
    }
    var m = rangeStr.match(/^([A-Z]+\d+):([A-Z]+\d+)$/i);
    if (!m) {
      // single cell?
      var sm = rangeStr.match(/^([A-Z]+\d+)$/i);
      if (sm) {
        var sa = parseAddr(sm[1].toUpperCase());
        if (!sa) return [];
        return [getCell(sa.r, sa.c).value];
      }
      return [];
    }
    var s = parseAddr(m[1].toUpperCase()), e = parseAddr(m[2].toUpperCase());
    if (!s || !e) return [];
    var vals = [];
    for (var r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) {
      for (var c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
        vals.push(getCell(r, c).value);
      }
    }
    return vals;
  }

  /** Return the 2D cell-value array for a range — preserves rows/cols
   *  shape, needed by INDEX/VLOOKUP/MATCH. */
  function getRange2D(rangeStr) {
    var xr = lookupXRange2D(rangeStr.trim());
    if (xr) return xr;
    var m = rangeStr.match(/^([A-Z]+\d+):([A-Z]+\d+)$/i);
    if (!m) return [];
    var s = parseAddr(m[1].toUpperCase()), e = parseAddr(m[2].toUpperCase());
    if (!s || !e) return [];
    var r1 = Math.min(s.r, e.r), r2 = Math.max(s.r, e.r);
    var c1 = Math.min(s.c, e.c), c2 = Math.max(s.c, e.c);
    var out = [];
    for (var r = r1; r <= r2; r++) {
      var row = [];
      for (var c = c1; c <= c2; c++) row.push(getCell(r, c).value);
      out.push(row);
    }
    return out;
  }

  /** Match a value against an Excel-style criterion: ">5", "<>0",
   *  "<=10", "=Tampa", or a bare value (equality). */
  function matchesCriterion(value, criterion) {
    if (criterion == null) return value == null || value === '';
    var c = String(criterion).trim();
    // Try operator prefixes
    var op = null, target = c;
    if (c.startsWith('>=')) { op = '>='; target = c.slice(2); }
    else if (c.startsWith('<=')) { op = '<='; target = c.slice(2); }
    else if (c.startsWith('<>')) { op = '<>'; target = c.slice(2); }
    else if (c.startsWith('!=')) { op = '<>'; target = c.slice(2); }
    else if (c.startsWith('>'))  { op = '>';  target = c.slice(1); }
    else if (c.startsWith('<'))  { op = '<';  target = c.slice(1); }
    else if (c.startsWith('='))  { op = '=';  target = c.slice(1); }
    else                          { op = '=';  target = c; }
    target = target.trim();
    // Strip surrounding quotes from target (text criteria)
    if ((target.startsWith('"') && target.endsWith('"')) ||
        (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1);
    }
    var nValue = Number(value);
    var nTarget = Number(target);
    var bothNumeric = !isNaN(nValue) && !isNaN(nTarget);
    if (bothNumeric) {
      switch (op) {
        case '>=': return nValue >= nTarget;
        case '<=': return nValue <= nTarget;
        case '>':  return nValue >  nTarget;
        case '<':  return nValue <  nTarget;
        case '<>': return nValue !== nTarget;
        case '=':  return nValue === nTarget;
      }
    }
    // String comparison (case-insensitive). Wildcards * and ? supported
    // via a regex translation, mirroring Excel's COUNTIF/SUMIF semantics.
    var sValue = String(value || '').toLowerCase();
    var sTarget = String(target || '').toLowerCase();
    function wildcardToRegex(pattern) {
      var esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      esc = esc.replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp('^' + esc + '$');
    }
    var hasWildcard = /[*?]/.test(sTarget);
    if (op === '=' || op === '<>') {
      var match = hasWildcard
        ? wildcardToRegex(sTarget).test(sValue)
        : (sValue === sTarget);
      return op === '<>' ? !match : match;
    }
    // String comparisons for >, <, etc. fall through to lex order.
    if (op === '>')  return sValue >  sTarget;
    if (op === '<')  return sValue <  sTarget;
    if (op === '>=') return sValue >= sTarget;
    if (op === '<=') return sValue <= sTarget;
    return false;
  }

  /** Strip quotes from a string-literal arg, e.g., '"hello"' -> 'hello'.
   *  Used by text functions that take string operands directly. */
  function unquoteArg(s) {
    if (typeof s !== 'string') return String(s);
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    // Could be a cell reference — resolve to its raw value
    if (/^[A-Z]+\d+$/i.test(s)) {
      var ref = parseAddr(s.toUpperCase());
      if (ref) return String(getCell(ref.r, ref.c).value || '');
    }
    return s;
  }

  function evalFunction(name, argsStr) {
    var args = splitArgs(argsStr);
    switch (name) {
      // ── Aggregates ────────────────────────────────────────
      case 'SUM': { var v = getRangeValues(argsStr); return v.reduce(function (a, b) { return a + b; }, 0); }
      case 'AVERAGE':
      case 'AVG': { var v = getRangeValues(argsStr); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : 0; }
      case 'MAX': { var v = getRangeValues(argsStr); return v.length ? Math.max.apply(null, v) : 0; }
      case 'MIN': { var v = getRangeValues(argsStr); return v.length ? Math.min.apply(null, v) : 0; }
      case 'COUNT': { return getRangeValues(argsStr).length; }
      case 'COUNTA': {
        var raws = getRangeCells(argsStr);
        return raws.filter(function(x) { return x !== '' && x != null; }).length;
      }
      case 'COUNTBLANK': {
        var raws = getRangeCells(argsStr);
        return raws.filter(function(x) { return x === '' || x == null; }).length;
      }
      case 'MEDIAN': {
        var v = getRangeValues(argsStr).slice().sort(function(a, b) { return a - b; });
        if (!v.length) return 0;
        var mid = Math.floor(v.length / 2);
        return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
      }
      case 'STDEV':
      case 'STDEVP': {
        var v = getRangeValues(argsStr);
        if (!v.length) return 0;
        var mean = v.reduce(function(a, b) { return a + b; }, 0) / v.length;
        var sumSq = v.reduce(function(a, b) { return a + (b - mean) * (b - mean); }, 0);
        var divisor = (name === 'STDEV') ? Math.max(1, v.length - 1) : v.length;
        return Math.sqrt(sumSq / divisor);
      }
      case 'VAR':
      case 'VARP': {
        var v = getRangeValues(argsStr);
        if (!v.length) return 0;
        var mean = v.reduce(function(a, b) { return a + b; }, 0) / v.length;
        var sumSq = v.reduce(function(a, b) { return a + (b - mean) * (b - mean); }, 0);
        var divisor = (name === 'VAR') ? Math.max(1, v.length - 1) : v.length;
        return sumSq / divisor;
      }
      case 'LARGE': {
        var v = getRangeValues(args[0]).slice().sort(function(a, b) { return b - a; });
        var k = safeEvalExpr(args[1] || '1');
        return v[k - 1] != null ? v[k - 1] : '#ERR';
      }
      case 'SMALL': {
        var v = getRangeValues(args[0]).slice().sort(function(a, b) { return a - b; });
        var k = safeEvalExpr(args[1] || '1');
        return v[k - 1] != null ? v[k - 1] : '#ERR';
      }
      case 'SUMIF': {
        // SUMIF(range, criterion, [sum_range])
        if (args.length < 2) return '#ERR';
        var range = getRangeCells(args[0]);
        var sumRange = args[2] ? getRangeCells(args[2]) : range;
        var crit = unquoteArg(args[1]);
        var total = 0;
        for (var i = 0; i < range.length; i++) {
          if (matchesCriterion(range[i], crit)) {
            var n = Number(sumRange[i]);
            if (!isNaN(n)) total += n;
          }
        }
        return total;
      }
      case 'COUNTIF': {
        if (args.length < 2) return '#ERR';
        var range = getRangeCells(args[0]);
        var crit = unquoteArg(args[1]);
        return range.filter(function(v) { return matchesCriterion(v, crit); }).length;
      }
      case 'AVERAGEIF': {
        if (args.length < 2) return '#ERR';
        var range = getRangeCells(args[0]);
        var avgRange = args[2] ? getRangeCells(args[2]) : range;
        var crit = unquoteArg(args[1]);
        var total = 0, count = 0;
        for (var i = 0; i < range.length; i++) {
          if (matchesCriterion(range[i], crit)) {
            var n = Number(avgRange[i]);
            if (!isNaN(n)) { total += n; count++; }
          }
        }
        return count ? total / count : 0;
      }

      // ── Math / Trig ───────────────────────────────────────
      case 'ROUND': { return args.length >= 2 ? +safeEvalExpr(args[0]).toFixed(safeEvalExpr(args[1])) : Math.round(safeEvalExpr(args[0])); }
      case 'ROUNDUP': { var n = safeEvalExpr(args[0]), d = safeEvalExpr(args[1] || '0'); var f = Math.pow(10, d); return Math.ceil(n * f) / f; }
      case 'ROUNDDOWN': { var n = safeEvalExpr(args[0]), d = safeEvalExpr(args[1] || '0'); var f = Math.pow(10, d); return Math.floor(n * f) / f; }
      case 'ABS': { return Math.abs(safeEvalExpr(args[0])); }
      case 'CEILING': { var v = safeEvalExpr(args[0]), s = args.length >= 2 ? safeEvalExpr(args[1]) : 1; return Math.ceil(v / s) * s; }
      case 'FLOOR': { var v = safeEvalExpr(args[0]), s = args.length >= 2 ? safeEvalExpr(args[1]) : 1; return Math.floor(v / s) * s; }
      case 'SQRT': { return Math.sqrt(safeEvalExpr(args[0])); }
      case 'POWER': { return Math.pow(safeEvalExpr(args[0]), safeEvalExpr(args[1])); }
      case 'EXP': { return Math.exp(safeEvalExpr(args[0])); }
      case 'LN': { return Math.log(safeEvalExpr(args[0])); }
      case 'LOG': { var n = safeEvalExpr(args[0]), b = args.length >= 2 ? safeEvalExpr(args[1]) : 10; return Math.log(n) / Math.log(b); }
      case 'LOG10': { return Math.log10(safeEvalExpr(args[0])); }
      case 'MOD': { return safeEvalExpr(args[0]) % safeEvalExpr(args[1]); }
      case 'INT': { return Math.floor(safeEvalExpr(args[0])); }
      case 'TRUNC': { var n = safeEvalExpr(args[0]), d = args.length >= 2 ? safeEvalExpr(args[1]) : 0; var f = Math.pow(10, d); return Math.trunc(n * f) / f; }
      case 'SIGN': { var n = safeEvalExpr(args[0]); return n > 0 ? 1 : n < 0 ? -1 : 0; }
      case 'PI': { return Math.PI; }
      case 'RAND': { return Math.random(); }
      case 'RANDBETWEEN': { var lo = safeEvalExpr(args[0]), hi = safeEvalExpr(args[1]); return Math.floor(Math.random() * (hi - lo + 1)) + lo; }

      // ── Logical ───────────────────────────────────────────
      case 'IF': {
        if (args.length < 2) return '#ERR';
        return safeEvalExpr(args[0]) ? safeEvalExpr(args[1]) : (args.length >= 3 ? safeEvalExpr(args[2]) : false);
      }
      case 'IFS': {
        for (var i = 0; i + 1 < args.length; i += 2) {
          if (safeEvalExpr(args[i])) return safeEvalExpr(args[i + 1]);
        }
        return '#N/A';
      }
      case 'IFERROR': {
        try {
          var v = safeEvalExpr(args[0]);
          if (typeof v === 'string' && /^#[A-Z!\/]+$/i.test(v)) return safeEvalExpr(args[1]);
          return v;
        } catch (e) { return safeEvalExpr(args[1]); }
      }
      case 'IFNA': {
        try {
          var v = safeEvalExpr(args[0]);
          if (v === '#N/A') return safeEvalExpr(args[1]);
          return v;
        } catch (e) { return safeEvalExpr(args[1]); }
      }
      case 'AND': { return args.every(function(a) { return !!safeEvalExpr(a); }); }
      case 'OR':  { return args.some(function(a) { return !!safeEvalExpr(a); }); }
      case 'NOT': { return !safeEvalExpr(args[0]); }
      case 'XOR': { return args.reduce(function(acc, a) { return acc !== !!safeEvalExpr(a); }, false); }
      case 'TRUE': { return true; }
      case 'FALSE': { return false; }
      case 'SWITCH': {
        // SWITCH(expr, val1, result1, val2, result2, ..., [default])
        var expr = safeEvalExpr(args[0]);
        for (var i = 1; i + 1 < args.length; i += 2) {
          if (safeEvalExpr(args[i]) === expr) return safeEvalExpr(args[i + 1]);
        }
        return (args.length % 2 === 0) ? safeEvalExpr(args[args.length - 1]) : '#N/A';
      }

      // ── Text ──────────────────────────────────────────────
      case 'CONCAT':
      case 'CONCATENATE': {
        return args.map(function(a) { return unquoteArg(a); }).join('');
      }
      case 'LEN': { return unquoteArg(args[0]).length; }
      case 'LEFT':  { return unquoteArg(args[0]).slice(0, args.length >= 2 ? safeEvalExpr(args[1]) : 1); }
      case 'RIGHT': { var s = unquoteArg(args[0]); var n = args.length >= 2 ? safeEvalExpr(args[1]) : 1; return s.slice(s.length - n); }
      case 'MID':   { var s = unquoteArg(args[0]); var start = safeEvalExpr(args[1]); var len = safeEvalExpr(args[2]); return s.slice(start - 1, start - 1 + len); }
      case 'UPPER': { return unquoteArg(args[0]).toUpperCase(); }
      case 'LOWER': { return unquoteArg(args[0]).toLowerCase(); }
      case 'PROPER': {
        return unquoteArg(args[0]).replace(/\w\S*/g, function(t) {
          return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
        });
      }
      case 'TRIM': { return unquoteArg(args[0]).replace(/\s+/g, ' ').trim(); }
      case 'SUBSTITUTE': {
        var s = unquoteArg(args[0]);
        var oldStr = unquoteArg(args[1]);
        var newStr = unquoteArg(args[2]);
        // SUBSTITUTE replaces ALL occurrences by default; an optional 4th
        // arg lets you target the Nth occurrence only.
        if (args.length >= 4) {
          var nth = safeEvalExpr(args[3]);
          var count = 0, pos = 0, out = '';
          while (true) {
            var idx = s.indexOf(oldStr, pos);
            if (idx === -1) break;
            count++;
            if (count === nth) {
              return s.slice(0, idx) + newStr + s.slice(idx + oldStr.length);
            }
            pos = idx + oldStr.length;
          }
          return s;
        }
        return s.split(oldStr).join(newStr);
      }
      case 'REPLACE': {
        // REPLACE(old_text, start_num, num_chars, new_text)
        var s = unquoteArg(args[0]);
        var start = safeEvalExpr(args[1]);
        var len = safeEvalExpr(args[2]);
        var newStr = unquoteArg(args[3]);
        return s.slice(0, start - 1) + newStr + s.slice(start - 1 + len);
      }
      case 'FIND': {
        // Case-sensitive; returns 1-based position or #VALUE!
        var needle = unquoteArg(args[0]);
        var hay = unquoteArg(args[1]);
        var start = args.length >= 3 ? safeEvalExpr(args[2]) - 1 : 0;
        var idx = hay.indexOf(needle, start);
        return idx === -1 ? '#VALUE!' : idx + 1;
      }
      case 'SEARCH': {
        // Case-insensitive; supports * and ? wildcards.
        var needle = unquoteArg(args[0]).toLowerCase();
        var hay = unquoteArg(args[1]).toLowerCase();
        var start = args.length >= 3 ? safeEvalExpr(args[2]) - 1 : 0;
        var idx = hay.indexOf(needle, start);
        return idx === -1 ? '#VALUE!' : idx + 1;
      }
      case 'TEXT': {
        // Tiny TEXT() implementation — handles the most common patterns:
        //   0.00 / #,##0.00 / 0% / mm/dd/yyyy. Anything else falls through
        //   to JS's default toString. Real Excel format strings are way
        //   richer — we cover what actually shows up on AGX worksheets.
        var v = safeEvalExpr(args[0]);
        var fmt = unquoteArg(args[1]);
        if (typeof v !== 'number') return String(v);
        if (/^0\.0+$/.test(fmt)) return v.toFixed(fmt.split('.')[1].length);
        if (/^#,##0(\.0+)?$/.test(fmt)) {
          var dec = fmt.indexOf('.') >= 0 ? fmt.split('.')[1].length : 0;
          return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
        }
        if (/^0%$|^0\.0+%$/.test(fmt)) {
          var dec = fmt.indexOf('.') >= 0 ? fmt.split('.')[1].replace('%','').length : 0;
          return (v * 100).toFixed(dec) + '%';
        }
        return String(v);
      }

      // ── Date ──────────────────────────────────────────────
      case 'TODAY': { return new Date().toISOString().slice(0, 10); }
      case 'NOW': { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
      case 'DATE': {
        var y = safeEvalExpr(args[0]), m = safeEvalExpr(args[1]), d = safeEvalExpr(args[2]);
        var dt = new Date(y, m - 1, d);
        return dt.toISOString().slice(0, 10);
      }
      case 'YEAR':    { return new Date(unquoteArg(args[0])).getFullYear() || '#VALUE!'; }
      case 'MONTH':   { var dt = new Date(unquoteArg(args[0])); return isNaN(dt.getTime()) ? '#VALUE!' : dt.getMonth() + 1; }
      case 'DAY':     { var dt = new Date(unquoteArg(args[0])); return isNaN(dt.getTime()) ? '#VALUE!' : dt.getDate(); }
      case 'WEEKDAY': { var dt = new Date(unquoteArg(args[0])); return isNaN(dt.getTime()) ? '#VALUE!' : dt.getDay() + 1; }
      case 'DAYS': {
        var end = new Date(unquoteArg(args[0])), start = new Date(unquoteArg(args[1]));
        if (isNaN(end.getTime()) || isNaN(start.getTime())) return '#VALUE!';
        return Math.round((end - start) / (1000 * 60 * 60 * 24));
      }

      // ── Lookup / Reference ────────────────────────────────
      case 'VLOOKUP': {
        // VLOOKUP(lookup_value, table_array, col_index_num, [exact])
        if (args.length < 3) return '#ERR';
        var needle = safeEvalExpr(args[0]);
        var table = getRange2D(args[1]);
        var col = safeEvalExpr(args[2]) - 1;
        var exact = args.length >= 4 ? !safeEvalExpr(args[3]) : false;
        for (var i = 0; i < table.length; i++) {
          var key = table[i][0];
          if (exact) {
            if (String(key).toLowerCase() === String(needle).toLowerCase()) {
              return table[i][col] != null ? table[i][col] : '#N/A';
            }
          } else {
            if (Number(key) <= Number(needle)) {
              if (i === table.length - 1 || Number(table[i + 1][0]) > Number(needle)) {
                return table[i][col] != null ? table[i][col] : '#N/A';
              }
            }
          }
        }
        return '#N/A';
      }
      case 'HLOOKUP': {
        if (args.length < 3) return '#ERR';
        var needle = safeEvalExpr(args[0]);
        var table = getRange2D(args[1]);
        var row = safeEvalExpr(args[2]) - 1;
        if (!table.length || !table[0]) return '#N/A';
        for (var c = 0; c < table[0].length; c++) {
          var key = table[0][c];
          if (String(key).toLowerCase() === String(needle).toLowerCase()) {
            return table[row] && table[row][c] != null ? table[row][c] : '#N/A';
          }
        }
        return '#N/A';
      }
      case 'INDEX': {
        // INDEX(array, row_num, [col_num])
        var arr = getRange2D(args[0]);
        var rIdx = safeEvalExpr(args[1]) - 1;
        var cIdx = args.length >= 3 ? safeEvalExpr(args[2]) - 1 : 0;
        if (!arr[rIdx] || arr[rIdx][cIdx] == null) return '#REF!';
        return arr[rIdx][cIdx];
      }
      case 'MATCH': {
        // MATCH(lookup, range, [match_type])  -1 = greater, 0 = exact, 1 = lesser (default)
        var needle = safeEvalExpr(args[0]);
        var range = getRangeCells(args[1]);
        var type = args.length >= 3 ? safeEvalExpr(args[2]) : 1;
        if (type === 0) {
          for (var i = 0; i < range.length; i++) {
            if (String(range[i]).toLowerCase() === String(needle).toLowerCase()) return i + 1;
          }
        } else {
          var bestIdx = -1;
          for (var i = 0; i < range.length; i++) {
            var v = Number(range[i]);
            if (type === 1 && v <= Number(needle)) bestIdx = i;
            if (type === -1 && v >= Number(needle)) bestIdx = i;
          }
          if (bestIdx >= 0) return bestIdx + 1;
        }
        return '#N/A';
      }
      case 'CHOOSE': {
        var idx = safeEvalExpr(args[0]);
        return args[idx] != null ? safeEvalExpr(args[idx]) : '#VALUE!';
      }
      case 'ROW': {
        if (!args.length || !args[0]) return '#ERR';
        var ref = parseAddr(args[0].toUpperCase());
        return ref ? ref.r + 1 : '#REF!';
      }
      case 'COLUMN': {
        if (!args.length || !args[0]) return '#ERR';
        var ref = parseAddr(args[0].toUpperCase());
        return ref ? ref.c + 1 : '#REF!';
      }

      default: return '#ERR';
    }
  }

  // ── Named ranges (Phase 2.7) ───────────────────────────────
  // A named range maps a friendly identifier to an A1 reference. The
  // reference may be a single cell ("B2"), a range ("A1:A10"), or a
  // sheet-qualified form ("Sheet2!A1:A10"). Names are workbook-scoped
  // and case-insensitive (stored upper-cased on write).

  // Compute the reference string a name expands to, qualified with its
  // owning sheet when one is recorded and the stored ref isn't already
  // sheet-qualified. Quotes sheet names that contain spaces so the
  // cross-sheet regex passes match.
  function _namedRangeEffectiveRef(nr) {
    if (!nr || typeof nr.ref !== 'string') return null;
    var ref = nr.ref.trim();
    if (!ref) return null;
    if (ref.indexOf('!') !== -1) return ref;        // already qualified
    if (nr.sheetId) {
      var sh = workbook.sheets.find(function (s) { return s.id === nr.sheetId; });
      if (sh) {
        var nm = /\s/.test(sh.name) ? "'" + sh.name + "'" : sh.name;
        return nm + '!' + ref;
      }
    }
    return ref;   // bare ref — resolves against the active sheet
  }

  // Substitute every named-range token in a formula body with its
  // effective reference, BEFORE any cell/range resolution runs. Skips
  // tokens that are function calls (followed by "(") or part of a
  // sheet-qualified ref (preceded by "!"). Wraps single-cell refs in
  // parens so adjacent operators stay well-formed; range refs (with
  // ":") are left bare so range-aware functions like SUM() see them.
  function applyNamedRanges(expr) {
    var names = workbook.namedRanges;
    if (!names) return expr;
    var keys = Object.keys(names);
    if (!keys.length) return expr;
    return expr.replace(/\b[A-Za-z_\\][A-Za-z0-9_.\\]*\b/g, function (token, offset, full) {
      var up = token.toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(names, up)) return token;
      // Skip if this looks like a function call: next non-space char is "(".
      var after = full.slice(offset + token.length);
      if (/^\s*\(/.test(after)) return token;
      // Skip if the token is actually a sheet name in a qualified ref:
      //   Sheet1!A1   → token "Sheet1" followed by "!"
      //   'Sheet1'!A1 → token "Sheet1" wrapped in quotes
      if (/^\s*!/.test(after) || after.charAt(0) === "'") return token;
      var before = full.slice(0, offset);
      // Skip if preceded by "!" (part of a Sheet!Ref token) or by an
      // opening quote (inside a quoted sheet name).
      if (/!$/.test(before) || before.charAt(before.length - 1) === "'") return token;
      var eff = _namedRangeEffectiveRef(names[up]);
      if (!eff) return token;
      // Bare-cell ref (no ":" and no "!") → wrap so "Rate2" vs "Rate*2"
      // arithmetic stays correct. Ranges / qualified refs pass through.
      if (eff.indexOf(':') === -1 && eff.indexOf('!') === -1) return '(' + eff + ')';
      return eff;
    });
  }

  // Validate a proposed name against Excel-ish rules. Returns an error
  // string, or null when valid. Used by the named-ranges editor.
  function validateRangeName(name) {
    if (!name) return 'Name is required.';
    var n = String(name).trim();
    if (!n) return 'Name is required.';
    if (n.length > 255) return 'Name is too long.';
    if (!/^[A-Za-z_\\][A-Za-z0-9_.\\]*$/.test(n)) {
      return 'Use letters, digits, period, underscore; must start with a letter or underscore.';
    }
    // Must not look like a cell reference (e.g. "A1", "AB12").
    if (/^[A-Za-z]{1,3}[0-9]+$/.test(n)) return 'Name cannot look like a cell reference.';
    // Reserved single-letter column/row helpers Excel disallows.
    if (/^[RrCc]$/.test(n)) return '"R" and "C" are reserved.';
    return null;
  }

  /** Evaluate a cell's raw value; detect formulas starting with '=' */
  function evaluate(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('=')) {
      if (raw === '' || raw === null || raw === undefined) return '';
      const n = Number(raw);
      return isNaN(n) ? raw : n;
    }

    const expr = raw.substring(1);

    try {
      // Reset the cross-sheet range registry — each evaluate() call
      // resolves its own ranges; tokens MUST NOT leak across formulas.
      xrRegistry = [];

      // Named-range expansion runs FIRST so a name resolves to its
      // (possibly sheet-qualified) A1 ref before the cross-sheet and
      // same-sheet reference passes see it.
      var expandedExpr = applyNamedRanges(expr);

      // Cross-sheet RANGES first: `Sheet2!A1:B10` or `'Sheet Two'!A1:B10`.
      // We replace each one with a sentinel token (`__XR<n>__`) and
      // stash the resolved 2D values in xrRegistry. Range helpers
      // (getRange2D / getRangeCells / getRangeValues) detect the
      // token and return registered values. Must run BEFORE the
      // single-cell cross-sheet pass — otherwise that pass would
      // match `Sheet2!A1` and leave `:B10` dangling.
      var resolved = expandedExpr.replace(
        /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))!([A-Z]+\d+):([A-Z]+\d+)/gi,
        function (match, quotedName, bareName, a1, a2) {
          var sheetName = quotedName || bareName;
          var sheet = findSheetByName(sheetName);
          if (!sheet) return '0';
          var s = parseAddr(a1.toUpperCase()), e = parseAddr(a2.toUpperCase());
          if (!s || !e) return '0';
          return registerXRange(sheet, s.r, s.c, e.r, e.c);
        }
      );

      // Cross-sheet single refs: `Sheet2!A1` or `'Sheet Two'!A1`. These
      // need to be resolved BEFORE the same-sheet ref pass below,
      // otherwise the bare `A1` inside `Sheet2!A1` would match the
      // local-sheet regex and produce the wrong value.
      resolved = resolved.replace(
        /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))!([A-Z]+\d+)/gi,
        function (match, quotedName, bareName, addr) {
          var sheetName = quotedName || bareName;
          var sheet = findSheetByName(sheetName);
          if (!sheet) return '0';
          var ref = parseAddr(addr.toUpperCase());
          if (!ref) return '0';
          var refCell = getCellFromSheet(sheet, ref.r, ref.c);
          var v = refCell.value;
          return (typeof v === 'number') ? v : (v === '' ? '0' : JSON.stringify(v));
        }
      );

      // Same-sheet RANGES: register `A1:B10` exactly like cross-sheet
      // ranges BEFORE the bare-ref pass below — that pass rewrites each
      // endpoint to its value ("SUM(C4:C19)" → "SUM(0:14)"), which broke
      // every same-sheet range function (SUM/AVG/COUNT/VLOOKUP/…). The
      // __XR token is underscore-bounded so the bare-ref regex leaves it
      // alone; getRangeValues/getRangeCells/getRange2D resolve tokens
      // first. grid.cells is the sheet under evaluation (recalcAll
      // repoints it per sheet), so a pseudo-sheet wrapper is enough.
      resolved = resolved.replace(/\b([A-Z]+\d+):([A-Z]+\d+)\b/gi, function (match, a1, a2) {
        var s = parseAddr(a1.toUpperCase()), e = parseAddr(a2.toUpperCase());
        if (!s || !e) return match;
        return registerXRange({ cells: grid.cells }, s.r, s.c, e.r, e.c);
      });

      // Replace cell references with their numeric values
      resolved = resolved.replace(/\b([A-Z]+)(\d+)\b/gi, function (match, col, row) {
        var ref = parseAddr(match.toUpperCase());
        if (!ref) return '0';
        // Redirect merged cells to origin
        var m = getMerge(ref.r, ref.c);
        if (m) ref = { r: m.r1, c: m.c1 };
        const refCell = getCell(ref.r, ref.c);
        const v = refCell.value;
        return (typeof v === 'number') ? v : (v === '' ? '0' : JSON.stringify(v));
      });

      // Iteratively resolve innermost function calls (supports nesting)
      var maxIter = 50;
      var funcRe = /([A-Z]+)\(([^()]*)\)/i;
      while (funcRe.test(resolved) && maxIter-- > 0) {
        resolved = resolved.replace(funcRe, function (match, fname, args) {
          return evalFunction(fname.toUpperCase(), args);
        });
      }

      // Evaluate final arithmetic expression
      const result = safeEvalExpr(resolved);
      return (typeof result === 'number' && !isFinite(result)) ? '#DIV/0!' : result;
    } catch (e) {
      return '#ERR';
    }
  }

  /** Recalculate all cells (simple multi-pass for dependency chains) */
  function recalcAll() {
    // WORKBOOK-WIDE recalc. Cross-sheet refs (`='903'!C22`) read other
    // sheets' cell VALUES — the old active-sheet-only loop left never-
    // activated sheets holding their raw formula strings as values, so
    // an imported summary tab full of cross-refs evaluated to #ERR /
    // garbage until every tab had been visited. Point the engine's
    // active-grid context at each grid sheet in turn; grid.cells and the
    // active sheet's cells are the SAME object, so results land in the
    // sheets either way.
    const saved = { cells: grid.cells, merges: grid.merges, rows: grid.rows, cols: grid.cols };
    let sheetCtxs = [];
    try {
      sheetCtxs = (workbook && Array.isArray(workbook.sheets))
        ? workbook.sheets.filter(function (s) {
            return s && s.cells && (!s.kind || s.kind === 'grid') && !isEmbedSheet(s);
          })
        : [];
    } catch (e) { sheetCtxs = []; }

    const evalCellsOf = function (cells, merges, rows, cols) {
      grid.cells = cells;
      grid.merges = merges || [];
      if (rows) grid.rows = rows;
      if (cols) grid.cols = cols;
      Object.keys(cells).forEach(key => {
        const cell = cells[key];
        const result = evaluate(cell.raw);
        const isErr = (typeof result === 'string' && (result === '#ERR' || result === '#DIV/0!'));
        if (isErr && cell.importedValue != null) {
          // Untouched imported formula the engine couldn't evaluate —
          // fall back to Excel's cached result from the .xlsx (any user
          // edit deletes importedValue, so this never masks live edits).
          cell.value = cell.importedValue;
          cell.error = null;
        } else if (isErr) {
          cell.value = result;
          cell.error = result;
        } else {
          cell.value = result;
          cell.error = null;
        }
      });
    };

    // One extra pass when multiple sheets exist — cross-sheet chains
    // (summary → cluster totals → cluster rows) need values to settle in
    // whatever order the tabs happen to sit.
    const passes = sheetCtxs.length > 1 ? 4 : 3;
    for (let pass = 0; pass < passes; pass++) {
      if (sheetCtxs.length) {
        sheetCtxs.forEach(function (s) { evalCellsOf(s.cells, s.merges, s.rows, s.cols); });
        // Fresh unsaved edits can live in a grid.cells object that isn't
        // (yet) any sheet's cells — evaluate those too.
        const inSheets = sheetCtxs.some(function (s) { return s.cells === saved.cells; });
        if (!inSheets) evalCellsOf(saved.cells, saved.merges, saved.rows, saved.cols);
      } else {
        evalCellsOf(saved.cells, saved.merges, saved.rows, saved.cols);
      }
    }
    grid.cells = saved.cells;
    grid.merges = saved.merges;
    grid.rows = saved.rows;
    grid.cols = saved.cols;
  }

  // ── Cell → Job Field Linking ───────────────────────────────

  // ── Linkable Fields (multi-level) ────────────────────────────
  const JOB_FIELDS = [
    { key: 'revisedCostChanges', label: 'Revised Cost Changes', fmt: 'currency' },
    { key: 'materials', label: 'Materials $', fmt: 'currency' },
    { key: 'labor', label: 'Labor $', fmt: 'currency' },
    { key: 'sub', label: 'Subcontractor $', fmt: 'currency' },
    { key: 'equipment', label: 'Equipment $', fmt: 'currency' },
    { key: 'generalConditions', label: 'General Conditions $', fmt: 'currency' },
    { key: 'invoicedToDate', label: 'Invoiced to Date', fmt: 'currency' },
    { key: 'pctComplete', label: '% Complete', fmt: 'percent' },
  ];

  const BUILDING_FIELDS = [
    { key: 'budget', label: 'Budget $', fmt: 'currency' },
    { key: 'materials', label: 'Materials $', fmt: 'currency' },
    { key: 'labor', label: 'Labor $', fmt: 'currency' },
    { key: 'sub', label: 'Subcontractor $', fmt: 'currency' },
    { key: 'equipment', label: 'Equipment $', fmt: 'currency' },
  ];

  const PHASE_FIELDS = [
    { key: 'materials', label: 'Materials $', fmt: 'currency' },
    { key: 'labor', label: 'Labor $', fmt: 'currency' },
    { key: 'sub', label: 'Subcontractor $', fmt: 'currency' },
    { key: 'equipment', label: 'Equipment $', fmt: 'currency' },
  ];

  const SUB_FIELDS = [
    { key: 'contractAmt', label: 'Contract Amount', fmt: 'currency' },
    { key: 'billedToDate', label: 'Billed to Date', fmt: 'currency' },
  ];

  const CO_FIELDS = [
    { key: 'estimatedCosts', label: 'Estimated Costs', fmt: 'currency' },
  ];

  const PO_FIELDS = [
    { key: 'amount', label: 'Amount', fmt: 'currency' },
    { key: 'billedToDate', label: 'Billed to Date', fmt: 'currency' },
  ];

  const INV_FIELDS = [
    { key: 'amount', label: 'Amount', fmt: 'currency' },
  ];

  /** Get a flat list of all field definitions for looking up fmt by key */
  function findFieldDef(linkObj) {
    var lists = { job: JOB_FIELDS, building: BUILDING_FIELDS, phase: PHASE_FIELDS, sub: SUB_FIELDS, co: CO_FIELDS, po: PO_FIELDS, inv: INV_FIELDS };
    var fields = lists[linkObj.level] || JOB_FIELDS;
    return fields.find(function (f) { return f.key === linkObj.field; });
  }

  /** Get display label for a link object */
  function getLinkLabel(linkObj) {
    var fieldDef = findFieldDef(linkObj);
    var fieldLabel = fieldDef ? fieldDef.label : linkObj.field;
    if (linkObj.level === 'job') return fieldLabel;
    var targetName = '';
    if (typeof appData !== 'undefined') {
      if (linkObj.level === 'building') {
        var b = appData.buildings.find(function (x) { return x.id === linkObj.targetId; });
        targetName = b ? b.name : '?';
      } else if (linkObj.level === 'phase') {
        var p = appData.phases.find(function (x) { return x.id === linkObj.targetId; });
        targetName = p ? p.phase : '?';
      } else if (linkObj.level === 'sub') {
        var s = appData.subs.find(function (x) { return x.id === linkObj.targetId; });
        targetName = s ? s.name : '?';
      } else if (linkObj.level === 'co') {
        var co = appData.changeOrders.find(function (x) { return x.id === linkObj.targetId; });
        targetName = co ? (co.coNumber || co.description || '?') : '?';
      } else if (linkObj.level === 'po') {
        var po = appData.purchaseOrders.find(function (x) { return x.id === linkObj.targetId; });
        targetName = po ? (po.poNumber || po.vendor || '?') : '?';
      } else if (linkObj.level === 'inv') {
        var inv = appData.invoices.find(function (x) { return x.id === linkObj.targetId; });
        targetName = inv ? (inv.invNumber || inv.vendor || '?') : '?';
      }
    }
    return targetName + ' → ' + fieldLabel;
  }

  /** Migrate old string-format links to new object format */
  function migrateLinks() {
    Object.keys(grid.links).forEach(function (cellAddr) {
      var val = grid.links[cellAddr];
      if (typeof val === 'string') {
        grid.links[cellAddr] = { field: val, level: 'job' };
      }
    });
  }

  /** Push linked cell values into the appropriate target objects */
  function pushLinkedValues() {
    if (!grid.jobId || typeof appData === 'undefined') return;
    var job = appData.jobs.find(function (j) { return j.id === grid.jobId; });
    if (!job) return;

    // Collect ALL field keys that have ever been linked (to zero them if no links remain)
    var allFieldKeys = {};
    Object.values(grid.links).forEach(function (linkObj) {
      if (!linkObj || !linkObj.field) return;
      var key = (linkObj.level || 'job') + ':' + (linkObj.targetId || '') + ':' + linkObj.field;
      allFieldKeys[key] = linkObj;
    });

    // Group linked cells by target+field so multiple cells can SUM into one field
    var grouped = {};
    Object.entries(grid.links).forEach(function (entry) {
      var cellAddr = entry[0], linkObj = entry[1];
      if (!linkObj || !linkObj.field) return;
      var ref = parseAddr(cellAddr);
      if (!ref) return;
      var cell = getCell(ref.r, ref.c);
      if (typeof cell.value !== 'number') return;
      var key = (linkObj.level || 'job') + ':' + (linkObj.targetId || '') + ':' + linkObj.field;
      if (!grouped[key]) grouped[key] = { linkObj: linkObj, values: [] };
      grouped[key].values.push(cell.value);
    });

    var changed = false;

    // Write summed values for all grouped fields
    Object.keys(allFieldKeys).forEach(function (key) {
      var linkObj = allFieldKeys[key];
      var total = grouped[key] ? grouped[key].values.reduce(function (s, v) { return s + v; }, 0) : 0;

      var target = null;
      if (linkObj.level === 'job') {
        target = job;
      } else if (linkObj.level === 'building' && linkObj.targetId) {
        target = appData.buildings.find(function (b) { return b.id === linkObj.targetId; });
      } else if (linkObj.level === 'phase' && linkObj.targetId) {
        target = appData.phases.find(function (p) { return p.id === linkObj.targetId; });
      } else if (linkObj.level === 'sub' && linkObj.targetId) {
        target = appData.subs.find(function (s) { return s.id === linkObj.targetId; });
      } else if (linkObj.level === 'co' && linkObj.targetId) {
        target = appData.changeOrders.find(function (c) { return c.id === linkObj.targetId; });
      } else if (linkObj.level === 'po' && linkObj.targetId) {
        target = appData.purchaseOrders.find(function (p) { return p.id === linkObj.targetId; });
      } else if (linkObj.level === 'inv' && linkObj.targetId) {
        target = appData.invoices.find(function (i) { return i.id === linkObj.targetId; });
      }

      if (target) {
        target[linkObj.field] = total;
        changed = true;
      }
    });

    if (typeof saveData === 'function') {
      saveData();
    }
    updateLinkedIndicators();
  }

  /** Map job-level field keys to their DOM input IDs */
  var FIELD_INPUT_MAP = {
    materials: 'jobCostMaterials',
    labor: 'jobCostLabor',
    equipment: 'jobCostEquipment',
    generalConditions: 'jobCostGC',
    sub: 'jobCostSub'
    // revisedCostChanges / invoicedToDate / pctComplete no longer have DOM inputs
    // on the job page — the WIP Report Inputs card was removed (Site Map drives them).
  };

  /** Show "← Cell A5" badges on inputs linked to workspace cells */
  function updateLinkedIndicators() {
    // Clear all existing badges
    document.querySelectorAll('.ws-linked-badge').forEach(function (el) { el.remove(); });
    document.querySelectorAll('[data-ws-linked]').forEach(function (el) {
      el.removeAttribute('data-ws-linked');
      el.style.borderColor = '';
    });

    // Add badges for active links (only job-level have DOM inputs)
    Object.entries(grid.links).forEach(function (entry) {
      var cellAddr = entry[0], linkObj = entry[1];
      if (!linkObj || linkObj.level !== 'job') return;
      var inputId = FIELD_INPUT_MAP[linkObj.field];
      if (!inputId) return;
      var input = document.getElementById(inputId);
      if (!input) return;

      // Style the input
      input.setAttribute('data-ws-linked', cellAddr);
      input.style.borderColor = 'rgba(27, 133, 65, 0.5)';

      // Find the label and add badge
      var label = input.parentElement ? input.parentElement.querySelector('label') : null;
      if (label) {
        var badge = document.createElement('span');
        badge.className = 'ws-linked-badge';
        badge.textContent = '← ' + cellAddr;
        label.appendChild(badge);
      }
    });
  }

  /** Update summary cards without full re-render */
  function updateJobSummaryCards(job) {
    // Update visible summary values if the elements exist
    const summaryEls = document.querySelectorAll('.summary-card .value');
    // This is a best-effort update — the exact selectors depend on the WIP tracker's DOM
  }

  // ── Persistence ────────────────────────────────────────────

  // Sync grid (active sheet's working state) back to its sheet object
  // in the workbook. Called before persistence and before switching sheets.
  // Embedded sheets (qb-costs) carry no grid state, so we skip them —
  // their content is read live from appData on each render.
  function syncGridToActiveSheet() {
    if (!workbook.sheets.length) return;
    const sheet = workbook.sheets.find(s => s.id === workbook.activeSheetId);
    if (!sheet) return;
    if (isEmbedSheet(sheet)) return;
    sheet.rows = grid.rows;
    sheet.cols = grid.cols;
    sheet.cells = grid.cells;
    sheet.colWidths = grid.colWidths;
    sheet.rowHeights = grid.rowHeights;
    sheet.links = grid.links;
    sheet.merges = grid.merges;
    sheet.tables = grid.tables;
  }

  // Pull a sheet's persistent state into grid so the rest of the engine
  // (rendering, formulas, undo, etc.) keeps reading from the same place
  // it always has. Resets transient state — selection / editing / undo
  // history are per-sheet by virtue of being cleared on switch.
  function loadSheetIntoGrid(sheet) {
    if (isEmbedSheet(sheet)) {
      // Embedded view (e.g. Detailed Costs). Render path uses
      // renderEmbedSheet, not renderGrid — but we still clear the
      // shared `grid` object so any incidental call from a stale
      // event handler can't render leftovers from the previous
      // sheet (and so recalcAll has nothing to chew on).
      grid.cells = {};
      grid.links = {};
      grid.merges = [];
      grid.tables = [];
      grid.colWidths = {};
      grid.rowHeights = {};
      grid.selection = null;
      grid.selEnd = null;
      grid.editing = null;
      grid.refMode = false;
      grid.refAnchor = null;
      grid.undoStack = [];
      grid.redoStack = [];
      return;
    }
    grid.rows = Math.max(sheet.rows || MIN_ROWS, MIN_ROWS);
    grid.cols = Math.max(sheet.cols || MIN_COLS, MIN_COLS);
    grid.cells = sheet.cells || {};
    grid.colWidths = sheet.colWidths || {};
    grid.rowHeights = sheet.rowHeights || {};
    grid.links = sheet.links || {};
    grid.merges = sheet.merges || [];
    grid.tables = sheet.tables || [];
    grid.selection = null;
    grid.selEnd = null;
    grid.editing = null;
    grid.refMode = false;
    grid.refAnchor = null;
    grid.undoStack = [];
    grid.redoStack = [];
  }

  // Toggle between the standard grid chrome (formula bar, toolbars,
  // grid) and an embedded view (e.g. Detailed Costs). Called by
  // renderActiveSheet whenever the active sheet changes kind.
  function applyEmbedChrome(sheet) {
    if (!wsContainer) return;
    var isEmbed = isEmbedSheet(sheet);

    // Hide grid-only chrome. .ws-toolbar-fmt was the legacy
    // formatting-toolbar selector; the new Excel-style toolbar uses
    // .ws-ribbon, so both have to be in the list (older sheets may
    // still render the legacy toolbar). Inner workbook tabs also
    // hide on embed views since they only group spreadsheet sheets.
    var hideSelectors = [
      '.ws-toolbar',
      '.ws-toolbar-fmt',
      '.ws-ribbon',
      '.ws-link-panel',
      '.ws-grid-wrapper',
      '.ws-statusbar',
      '.ws-workbook-inner-tabs'
    ];
    hideSelectors.forEach(function(sel) {
      wsContainer.querySelectorAll(sel).forEach(function(el) {
        el.style.display = isEmbed ? 'none' : '';
      });
    });

    // Embed host — created once, attached just before the sheet tabs.
    var host = wsContainer.querySelector('#wsEmbedHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'wsEmbedHost';
      host.style.flex = '1 1 auto';
      host.style.minHeight = '0';
      host.style.overflow = 'hidden';
      host.style.display = 'none';
      var tabs = wsContainer.querySelector('#wsSheetTabs');
      if (tabs && tabs.parentNode) {
        tabs.parentNode.insertBefore(host, tabs);
      } else {
        wsContainer.appendChild(host);
      }
    }
    host.style.display = isEmbed ? 'flex' : 'none';
    host.style.flexDirection = 'column';
  }

  // Render whichever sheet is currently active. Grid sheets call into
  // the existing renderGrid path; embedded sheets dispatch to their
  // dedicated renderer.
  function renderActiveSheet() {
    var sheet = activeSheet();
    if (!sheet) return;
    applyEmbedChrome(sheet);
    if (isEmbedSheet(sheet)) {
      renderEmbedSheet(sheet);
    } else {
      renderGrid();
    }
  }

  function renderEmbedSheet(sheet) {
    var host = wsContainer && wsContainer.querySelector('#wsEmbedHost');
    if (!host) return;
    if (sheet.kind === 'qb-costs') {
      if (typeof window.renderJobQBCosts === 'function' && workbook.jobId) {
        window.renderJobQBCosts(workbook.jobId, host);
      } else {
        host.innerHTML = '<div style="padding:24px;color:var(--text-dim,#888);font-size:13px;">' +
          'Detailed Costs view is unavailable. Reload the page to retry.' +
        '</div>';
      }
    } else if (sheet.kind === 'attachments') {
      // Re-mount the universal attachments component into a host
      // div inside the embed area. The component owns its own
      // upload / list / lightbox / delete UI; we just hand it the
      // entity ids. Re-mounting on every activation is cheap (it
      // re-fetches the list anyway) and keeps state simple.
      if (typeof window.p86Attachments === 'undefined' || !window.p86Attachments.mount) {
        host.innerHTML = '<div style="padding:24px;color:var(--text-dim,#888);font-size:13px;">' +
          'Attachments component is unavailable. Reload the page to retry.' +
        '</div>';
        return;
      }
      if (!workbook.jobId) {
        host.innerHTML = '<div style="padding:24px;color:var(--text-dim,#888);font-size:13px;">' +
          'Open a job first to manage its attachments.' +
        '</div>';
        return;
      }
      // Mount target: a per-host child div with padded surface,
      // mirroring how the Detailed Costs embed sets up its inner
      // surface so the visual feels native to the panel.
      var mount = host.querySelector(':scope > .ws-attachments-embed');
      if (!mount) {
        host.innerHTML = '';
        mount = document.createElement('div');
        mount.className = 'ws-attachments-embed sub-tab-content-job';
        mount.style.display = 'block';
        mount.style.padding = '14px';
        mount.style.height = '100%';
        mount.style.overflowY = 'auto';
        mount.style.boxSizing = 'border-box';
        mount.style.background = 'var(--surface, #17171c)';
        // Header strip — matches the look of the QB Costs sheet so
        // the two embedded tabs feel like siblings.
        var header = document.createElement('div');
        header.className = 'action-buttons';
        header.style.alignItems = 'center';
        header.style.marginBottom = '12px';
        header.innerHTML =
          '<div style="display:flex;flex-direction:column;gap:2px;">' +
            '<strong style="font-size:14px;">Attachments</strong>' +
            '<span style="font-size:11px;color:var(--text-dim,#888);">' +
              'Photos, drawings, PDFs, contracts &mdash; anything tied to this job. Synced across devices. ' +
              '<strong style="color:#a78bfa;">.xlsx / .xls / .csv files auto-import as workspace sheets</strong> so 86 can read them.' +
            '</span>' +
          '</div>';
        mount.appendChild(header);
        // Optional xlsx import notice (toast-style, populated after a
        // successful intercept so the user sees what happened).
        var notice = document.createElement('div');
        notice.className = 'ws-attachments-xlsx-notice';
        notice.style.cssText = 'display:none;margin-bottom:10px;padding:10px 12px;background:rgba(167,139,250,0.10);border:1px solid rgba(167,139,250,0.4);border-radius:8px;font-size:12px;color:#ddd0ff;';
        mount.appendChild(notice);
        // Component mount target
        var componentSlot = document.createElement('div');
        componentSlot.className = 'ws-attachments-component';
        mount.appendChild(componentSlot);
        host.appendChild(mount);
      }
      var slot = mount.querySelector('.ws-attachments-component');
      var noticeEl = mount.querySelector('.ws-attachments-xlsx-notice');
      if (slot) {
        window.p86Attachments.mount(slot, {
          entityType: 'job',
          entityId: workbook.jobId,
          canEdit: true
        });
        // Intercept xlsx/csv files at the drop / file-input level —
        // route them through wsImportXlsxFile (which adds them as
        // workspace sheets so the AI can read via read_workspace_sheet_full)
        // INSTEAD of uploading them as opaque blobs the model can't read.
        // We keep a single capture-phase listener on the embed mount so
        // any drop/change inside `slot` is observed even if the
        // attachments component re-renders its drop-zone.
        if (!mount._xlsxInterceptWired) {
          mount._xlsxInterceptWired = true;
          var SPREADSHEET_RX = /\.(xlsx|xls|csv)$/i;
          var consumeXlsxFiles = function(fileList) {
            if (!fileList || !fileList.length) return [];
            var imported = [];
            var passthrough = [];
            Array.prototype.forEach.call(fileList, function(f) {
              if (f && SPREADSHEET_RX.test(f.name || '')) {
                imported.push(f);
              } else {
                passthrough.push(f);
              }
            });
            if (imported.length && typeof window.wsImportXlsxFile === 'function') {
              imported.forEach(function(f) {
                try { window.wsImportXlsxFile(f); } catch (e) { console.warn('[attachments] xlsx import failed:', e); }
              });
              if (noticeEl) {
                noticeEl.style.display = 'block';
                noticeEl.innerHTML =
                  '&#x1F4D1; Imported <strong>' + imported.length + '</strong> spreadsheet file' +
                  (imported.length === 1 ? '' : 's') +
                  ' as workspace sheet' + (imported.length === 1 ? '' : 's') +
                  '. 86 can now read them via the Detailed Costs / sheet tabs above.' +
                  ' Click any sheet tab at the bottom to view.';
                setTimeout(function() {
                  if (noticeEl) noticeEl.style.display = 'none';
                }, 8000);
              }
            }
            return passthrough;
          };

          // Drop intercept (capture phase so we get it before the
          // component's own drop handler).
          mount.addEventListener('drop', function(e) {
            if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
            var hasXlsx = Array.prototype.some.call(e.dataTransfer.files, function(f) {
              return SPREADSHEET_RX.test(f.name || '');
            });
            if (!hasXlsx) return; // let the component handle pure photo/PDF drops
            // Mixed drop: handle xlsx, let the rest fall through. We
            // can't selectively cancel, so cancel and re-dispatch the
            // non-xlsx files to the component's input via a synthetic
            // change. Simpler — only intercept if EVERY file is xlsx.
            var allXlsx = Array.prototype.every.call(e.dataTransfer.files, function(f) {
              return SPREADSHEET_RX.test(f.name || '');
            });
            if (!allXlsx) return; // mixed — let component upload all (xlsx will fail to render but at least be saved)
            e.stopPropagation();
            e.preventDefault();
            consumeXlsxFiles(e.dataTransfer.files);
          }, true);

          // File-input intercept — same logic for the click-to-pick path.
          mount.addEventListener('change', function(e) {
            var inp = e.target;
            if (!inp || inp.tagName !== 'INPUT' || inp.type !== 'file') return;
            if (!inp.files || !inp.files.length) return;
            var allXlsx = Array.prototype.every.call(inp.files, function(f) {
              return SPREADSHEET_RX.test(f.name || '');
            });
            if (!allXlsx) return;
            e.stopPropagation();
            e.preventDefault();
            consumeXlsxFiles(inp.files);
            // Reset the input so the same file can be re-picked.
            try { inp.value = ''; } catch (_) {}
          }, true);
        }
      }
    }
  }

  // Composite localStorage key for the new (entityType, entityId) model.
  // Format: `${entityType}:${entityId}` — keeps job-side and estimate-side
  // workbooks separated even if a jobId and estimateId ever collide.
  function _wsLocalKey(entityType, entityId) {
    return entityType + ':' + entityId;
  }
  // Legacy localStorage shape used plain jobId as the slot key on the
  // top-level `p86-workspaces` object. Detect + migrate on first load.
  function _wsLegacyLookup(allWs, entityType, entityId) {
    if (entityType !== 'job' || entityId == null) return null;
    // The legacy slot is the bare jobId (no prefix). If both the
    // composite and the legacy slots exist, prefer the composite (it's
    // newer); the legacy is the cold backup.
    return allWs[entityId] || null;
  }

  // Debounced server PUT. Fires 500ms after the last save call so a
  // burst of keystrokes only POSTs once. The first call goes out
  // immediately so the very first edit on a brand-new workspace lands
  // server-side even if the user closes the tab right after.
  let _wsServerSaveTimer = null;
  let _wsServerSaveInFlight = false;
  let _wsServerSavePending = false;
  function _wsServerSave(entityType, entityId, payload) {
    if (entityType !== 'job' && entityType !== 'estimate') return;
    if (entityId == null) return;
    if (_wsServerSaveInFlight) {
      // Coalesce: mark pending and let the in-flight save's .finally
      // re-trigger with the latest payload (closure capture below).
      _wsServerSavePending = true;
      _wsServerSavePendingPayload = payload;
      _wsServerSavePendingEntity = { entityType, entityId };
      return;
    }
    _wsServerSaveInFlight = true;
    var url = '/api/' + (entityType === 'job' ? 'jobs' : 'estimates') + '/' + encodeURIComponent(entityId) + '/workbook';
    fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(function(e) {
      // Non-fatal — localStorage already has the bytes; next save
      // will retry. Just log.
      console.warn('[workspace] server save failed:', e && e.message);
    }).finally(function() {
      _wsServerSaveInFlight = false;
      if (_wsServerSavePending) {
        _wsServerSavePending = false;
        var p = _wsServerSavePendingPayload;
        var ent = _wsServerSavePendingEntity;
        _wsServerSavePendingPayload = null;
        _wsServerSavePendingEntity = null;
        // Trampoline to flush the pending save (latest payload).
        _wsServerSave(ent.entityType, ent.entityId, p);
      }
    });
  }
  var _wsServerSavePendingPayload = null;
  var _wsServerSavePendingEntity = null;

  // ── WS-POP: pop-out window + single-live-copy coordination ──────────
  // The workspace can open in a dedicated browser window (/workspace/:type/:id)
  // so it can live on a second monitor. There's no live cell-sync and server
  // saves are last-write-wins, so only ONE instance of a given sheet is the
  // live editor at a time; the others show a placeholder. Coordination rides a
  // per-entity BroadcastChannel.
  var IS_WS_POPOUT = /^\/workspace\//.test(location.pathname || '');
  var _wsContainerId = null;   // where the current instance is mounted
  var _wsBC = null;            // BroadcastChannel for the active entity
  var _wsInstanceId = String(Date.now()) + '.' + Math.random().toString(36).slice(2);
  var _wsIsEditor = true;      // is this instance the live editor?
  var _wsClaimTs = 0;          // timestamp of my editor claim (tiebreak)
  var _wsUnloadWired = false;

  // Build the persisted workbook payload — shared by autosave + close-flush so
  // the two can never drift. Syncs the live grid into the active sheet first.
  function _wsBuildSaveData() {
    try { syncGridToActiveSheet(); } catch (e) {}
    return {
      version: 2,
      activeSheetId: workbook.activeSheetId,
      sheets: workbook.sheets,
      namedRanges: workbook.namedRanges || {},
      workbookGroupActive: workbook.workbookGroupActive || {}
    };
  }

  // Flush any pending debounced save immediately, surviving page unload via
  // fetch keepalive (so the last keystrokes in a closing pop-out persist).
  function _wsFlushSave() {
    if (!workbook.entityType || workbook.entityId == null) return;
    if (_wsServerSaveTimer) { clearTimeout(_wsServerSaveTimer); _wsServerSaveTimer = null; }
    var data = _wsBuildSaveData();
    try {
      var allWs = safeLoadJSON('p86-workspaces', {});
      allWs[_wsLocalKey(workbook.entityType, workbook.entityId)] = data;
      localStorage.setItem('p86-workspaces', JSON.stringify(allWs));
    } catch (e) {}
    var url = '/api/' + (workbook.entityType === 'job' ? 'jobs' : 'estimates') + '/' + encodeURIComponent(workbook.entityId) + '/workbook';
    try {
      fetch(url, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true });
    } catch (e) {}
  }

  // Stand up the per-entity coordination channel and claim editor role.
  function _wsSetupCoordination(type, id, containerId) {
    if (type == null || id == null || typeof BroadcastChannel === 'undefined') return;
    if (_wsBC) { try { _wsBC.close(); } catch (e) {} _wsBC = null; }
    _wsIsEditor = true;
    _wsClaimTs = Date.now();
    _wsBC = new BroadcastChannel('p86-ws-' + type + '-' + id);
    _wsBC.onmessage = function (ev) {
      var m = ev.data || {};
      if (!m || m.from === _wsInstanceId) return;
      if (m.t === 'claim') {
        // Newer claim wins; older yields. Tiebreak by instance id so two
        // simultaneous opens can't both yield (deadlock).
        var theyAreNewer = (m.ts > _wsClaimTs) || (m.ts === _wsClaimTs && m.from > _wsInstanceId);
        if (_wsIsEditor && theyAreNewer) _wsYieldToPlaceholder(type, id, containerId);
      } else if (m.t === 'released') {
        // Let the closing editor's keepalive PUT commit server-side before we
        // re-fetch, so the reclaiming instance loads the latest, not stale data.
        if (!_wsIsEditor) setTimeout(function () { if (!_wsIsEditor) _wsReclaim(type, id, containerId); }, 500);
      }
    };
    try { _wsBC.postMessage({ t: 'claim', from: _wsInstanceId, ts: _wsClaimTs }); } catch (e) {}
  }

  // Give up editor role: flush my edits, then swap the grid for a placeholder.
  function _wsYieldToPlaceholder(type, id, containerId) {
    _wsIsEditor = false;
    _wsFlushSave();
    var c = document.getElementById(containerId);
    if (!c) return;
    var sub = IS_WS_POPOUT
      ? 'This sheet is being edited in the main window — you can close this window.'
      : 'It’s open in a separate window so edits don’t overwrite each other.';
    c.innerHTML =
      '<div class="ws-popout-placeholder">' +
        '<div class="ws-pp-icon">⧉</div>' +
        '<div class="ws-pp-title">Workspace open in another window</div>' +
        '<div class="ws-pp-sub">' + sub + '</div>' +
        '<button class="ws-btn ws-pp-btn" type="button">Bring it back here</button>' +
      '</div>';
    var btn = c.querySelector('.ws-pp-btn');
    if (btn) btn.onclick = function () { _wsReclaim(type, id, containerId); };
  }

  // Become the editor again: re-mount (reloads the latest from the server) —
  // the fresh init re-broadcasts a claim so the other instance yields.
  function _wsReclaim(type, id, containerId) {
    initWorkspace(containerId, type, id);
  }

  // Wire the toolbar "Pop out" anchor for the current instance.
  function _wsSetupPopoutButton(type, id) {
    var a = wsContainer && wsContainer.querySelector('.ws-tb-popout');
    if (!a) return;
    if (IS_WS_POPOUT || type == null || id == null) { a.style.display = 'none'; return; }
    var href = '/workspace/' + type + '/' + encodeURIComponent(id);
    a.setAttribute('href', href);
    var winName = 'p86ws-' + type + '-' + id;
    a.onclick = function (e) {
      // Let non-left / modified clicks use the browser's native behavior
      // (right-click → Open in new window; ctrl/cmd/middle → new tab).
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      var w = Math.min((window.screen && screen.availWidth) || 1440, 1680);
      var h = Math.min((window.screen && screen.availHeight) || 900, 1180);
      window.open(href, winName, 'popup,width=' + w + ',height=' + h);
    };
  }

  // Render the standalone pop-out view (called by auth.js on /workspace/* URLs).
  function renderWorkspacePopout() {
    var m = /^\/workspace\/(job|estimate)\/([^\/?#]+)/.exec(location.pathname || '');
    if (!m) return false;
    var type = m[1], id = decodeURIComponent(m[2]);
    document.body.classList.add('p86-ws-popout');
    var host = document.getElementById('wsPopoutHost');
    if (!host) { host = document.createElement('div'); host.id = 'wsPopoutHost'; document.body.appendChild(host); }
    document.title = 'Workspace — ' + (type === 'job' ? 'Job' : 'Estimate') + ' ' + id;
    initWorkspace('wsPopoutHost', type, id);
    return true;
  }

  function saveWorkspace() {
    if (!workbook.entityType || workbook.entityId == null) return;
    const data = _wsBuildSaveData();
    // Write-through to localStorage immediately — that's the offline
    // cache + the safety net if the server PUT fails.
    const allWs = safeLoadJSON('p86-workspaces', {});
    allWs[_wsLocalKey(workbook.entityType, workbook.entityId)] = data;
    // Preserve legacy slot writes for 'job' so a browser that hasn't
    // run loadWorkspace yet still sees the pre-Phase-0 shape. Cheap
    // belt-and-suspenders during the migration window; can drop in a
    // future cleanup pass.
    if (workbook.entityType === 'job') {
      allWs[workbook.entityId] = data;
    }
    localStorage.setItem('p86-workspaces', JSON.stringify(allWs));
    workbook.dirty = false;
    grid.dirty = false;
    // Debounced server PUT — coalesces bursts of edits into one round-trip.
    if (_wsServerSaveTimer) clearTimeout(_wsServerSaveTimer);
    _wsServerSaveTimer = setTimeout(function() {
      _wsServerSaveTimer = null;
      _wsServerSave(workbook.entityType, workbook.entityId, data);
    }, 500);
  }

  // loadWorkspace is async — it fetches the server-side workbook first,
  // falls back to localStorage if the server slot is empty, and back-
  // fills the server from localStorage on first load (so legacy job-
  // side workbooks become visible to 86 + other devices without any
  // user action). Callers don't have to await — they fire it and let
  // the render loop catch up; initWorkspace renders after it resolves.
  //
  // Signature: loadWorkspace(entityType, entityId)
  // Back-compat: loadWorkspace(jobId) — single-arg form treated as
  // entityType='job'.
  async function loadWorkspace(entityTypeOrJobId, entityId) {
    var entityType;
    if (entityId === undefined) {
      // Legacy 1-arg form — bare jobId.
      entityType = 'job';
      entityId = entityTypeOrJobId;
    } else {
      entityType = entityTypeOrJobId;
    }
    workbook.entityType = entityType;
    workbook.entityId = entityId;
    grid.jobId = entityType === 'job' ? entityId : null;

    // 1. Try the server. Estimates + jobs only — the entity types we
    //    have endpoints for.
    var serverWb = null;
    if (entityType === 'job' || entityType === 'estimate') {
      try {
        var url = '/api/' + (entityType === 'job' ? 'jobs' : 'estimates') + '/' + encodeURIComponent(entityId) + '/workbook';
        var res = await fetch(url, { credentials: 'include' });
        if (res.ok) {
          var json = await res.json();
          serverWb = json && json.workbook ? json.workbook : null;
        }
      } catch (e) {
        // Network failure — fall through to localStorage path. Don't
        // surface the error; offline use should still work.
        console.warn('[workspace] server load failed, falling back to localStorage:', e && e.message);
      }
    }

    // 2. localStorage — composite key first, then legacy plain jobId.
    const allWs = safeLoadJSON('p86-workspaces', {});
    const localWb = allWs[_wsLocalKey(entityType, entityId)]
      || _wsLegacyLookup(allWs, entityType, entityId)
      || null;

    // 3. Pick the source. Server wins if non-empty. localStorage is
    //    the fallback. If neither: brand new.
    var saved = serverWb || localWb;
    var shouldBackfillServer = !serverWb && !!localWb;

    _hydrateWorkbookFromSaved(saved);

    // 4. If the server slot was empty but localStorage had data,
    //    backfill the server with what we found so 86 + cross-device
    //    can read it. One-shot; fire-and-forget.
    if (shouldBackfillServer && (entityType === 'job' || entityType === 'estimate')) {
      try {
        const data = {
          version: 2,
          activeSheetId: workbook.activeSheetId,
          sheets: workbook.sheets,
          namedRanges: workbook.namedRanges || {},
          workbookGroupActive: workbook.workbookGroupActive || {}
        };
        _wsServerSave(entityType, entityId, data);
      } catch (e) {
        console.warn('[workspace] backfill skipped:', e && e.message);
      }
    }
  }

  // Extracted from the old loadWorkspace body — given a `saved` object
  // (from server OR localStorage), hydrate workbook.sheets +
  // activeSheetId. Same shape rules either way.
  function _hydrateWorkbookFromSaved(saved) {

    if (saved && Array.isArray(saved.sheets) && saved.sheets.length) {
      // v2+ shape — already a workbook with sheets
      workbook.sheets = saved.sheets.map(s => ({
        id: s.id || newSheetId(),
        name: s.name || 'Sheet',
        kind: s.kind || 'grid',
        rows: Math.max(s.rows || MIN_ROWS, MIN_ROWS),
        cols: Math.max(s.cols || MIN_COLS, MIN_COLS),
        cells: s.cells || {},
        colWidths: s.colWidths || {},
        rowHeights: s.rowHeights || {},
        // Exact Excel geometry from xlsx import (S4) — without these in
        // the hydrate whitelist a reload silently downgraded exports to
        // px-converted widths.
        colWch: s.colWch || {},
        rowHpt: s.rowHpt || {},
        // Frozen panes — was missing from this whitelist entirely, so
        // freeze state never survived a reload.
        frozen: s.frozen || null,
        links: s.links || {},
        merges: s.merges || [],
        tables: s.tables || [],
        pinned: !!s.pinned,
        // Preserve xlsx-import provenance across reloads so future
        // tooling (e.g. "remove all sheets from <file>") can find them.
        sourceFile: s.sourceFile || null,
        sourceSheetName: s.sourceSheetName || null,
        // Workbook grouping (Phase: multi-sheet xlsx imports collapse
        // to a single workbook tab). Both fields are required so the
        // bottom-strip render can collapse siblings + so the inner
        // tab strip can find them on re-open.
        workbookGroupId: s.workbookGroupId || null,
        workbookGroupName: s.workbookGroupName || null,
        // Phase 0 — sheets snapshotted from an estimate at job-creation
        // time carry these so the bottom tab strip can render a
        // "from estimate" chip + tooltip. Set by the estimate→job
        // inheritance hook in leads.js (follow-up turn). Null on any
        // sheet created or imported on the host entity directly.
        sourceEstimateId: s.sourceEstimateId || null,
        sourceEstimateName: s.sourceEstimateName || null,
        // Hidden sheets stay in the workbook (so cross-sheet formulas
        // keep resolving) but disappear from the tab strips.
        hidden: !!s.hidden,
        // Phase 2.4 — AutoFilter state lives on the sheet: header row,
        // column span, and per-column allowed-value filters. Round-trips
        // as a plain object.
        autoFilter: (s.autoFilter && typeof s.autoFilter === 'object') ? s.autoFilter : null
      }));
      workbook.activeSheetId = saved.activeSheetId && workbook.sheets.find(s => s.id === saved.activeSheetId)
        ? saved.activeSheetId
        : workbook.sheets[0].id;
      // Restore the per-group "last active sheet" map so clicking a
      // workbook tab returns the user to the same inner sheet they
      // had open before the reload.
      workbook.workbookGroupActive = (saved.workbookGroupActive && typeof saved.workbookGroupActive === 'object')
        ? saved.workbookGroupActive
        : {};
    } else if (saved && (saved.cells || saved.rows)) {
      // v1 shape — legacy single-sheet save. Wrap it as Sheet1 of a new
      // workbook so existing data carries forward without loss.
      workbook.sheets = [{
        id: newSheetId(),
        name: 'Sheet1',
        rows: Math.max(saved.rows || MIN_ROWS, MIN_ROWS),
        cols: Math.max(saved.cols || MIN_COLS, MIN_COLS),
        cells: saved.cells || {},
        colWidths: saved.colWidths || {},
        rowHeights: {},
        links: saved.links || {},
        merges: saved.merges || [],
        tables: []
      }];
      workbook.activeSheetId = workbook.sheets[0].id;
    } else {
      // Brand-new workspace
      workbook.sheets = [makeBlankSheet('Sheet1')];
      workbook.activeSheetId = workbook.sheets[0].id;
    }

    // Auto-inject permanent built-in views (idempotent — appended at
    // the end of the tab strip, never duplicated). Pinned so
    // rename/delete is blocked from the context menu.
    //
    // Phase 0 gate: QB Costs is a job-side feature (reads
    // jobs.qb_cost_lines for the active jobId). On the estimate side
    // there's no QB job costs to embed, so we suppress the tab there.
    // Attachments works on either side (attachments are polymorphic).
    var isJobSide = workbook.entityType === 'job';
    if (isJobSide && !workbook.sheets.some(s => s.id === QB_COSTS_SHEET_ID)) {
      workbook.sheets.push(makeQBCostsSheet());
    }
    if (!workbook.sheets.some(s => s.id === ATTACHMENTS_SHEET_ID)) {
      workbook.sheets.push(makeAttachmentsSheet());
    }
    // Defensive — if a previously-saved estimate-side workbook ever
    // somehow accumulated a QB Costs sheet, strip it on load so the
    // tab strip doesn't render a broken view.
    if (!isJobSide) {
      workbook.sheets = workbook.sheets.filter(s => s.id !== QB_COSTS_SHEET_ID);
    }

    // Phase 2.7 — restore workbook-scoped named ranges. Keys are
    // upper-cased on write; normalize again here defensively in case an
    // older save stored mixed case. Drop any entry without a string ref.
    workbook.namedRanges = {};
    if (saved && saved.namedRanges && typeof saved.namedRanges === 'object') {
      Object.keys(saved.namedRanges).forEach(function(k) {
        var nr = saved.namedRanges[k];
        if (nr && typeof nr.ref === 'string' && nr.ref.trim()) {
          workbook.namedRanges[String(k).toUpperCase()] = {
            name: nr.name || String(k),
            ref: nr.ref.trim(),
            sheetId: nr.sheetId || null,
            comment: nr.comment || ''
          };
        }
      });
    }

    workbook.dirty = false;
    // grid.jobId set in loadWorkspace before this helper runs — kept
    // for back-compat with the QB-Costs renderer that reads it.
    grid.dirty = false;
    loadSheetIntoGrid(workbook.sheets.find(s => s.id === workbook.activeSheetId));
    migrateLinks();
    recalcAll();
  }

  // ── Sheet management ───────────────────────────────────────
  // Switch the active sheet. Saves current grid state back to its sheet,
  // loads the target sheet's state into grid, re-renders.
  function switchSheet(sheetId) {
    if (sheetId === workbook.activeSheetId) return;
    const target = workbook.sheets.find(s => s.id === sheetId);
    if (!target) return;
    syncGridToActiveSheet();
    workbook.activeSheetId = sheetId;
    // Hide the Link panel on sheet switch — it pins itself open
    // on click, but the link options it shows are scoped to the
    // PREVIOUS sheet's selection. Letting it persist across tabs
    // shows job-field chips that don't apply to the new active cell.
    var lp = document.getElementById('wsLinkPanel');
    if (lp) lp.classList.remove('ws-link-panel-open');
    loadSheetIntoGrid(target);
    workbook.dirty = true;
    grid.dirty = !isEmbedSheet(target);
    if (!isEmbedSheet(target)) recalcAll();
    renderActiveSheet();
    renderSheetTabs();
    if (!isEmbedSheet(target)) selectCell(0, 0);
    // Refresh the Excel-theme class — embedded views opt out so the
    // user sees the regular light/dark mode for QB Costs +
    // Attachments, while regular grid sheets keep the Excel palette.
    applyExcelThemeForActiveSheet();
  }

  function addSheet(initialName) {
    syncGridToActiveSheet();
    let name = initialName;
    if (!name) {
      let n = workbook.sheets.length + 1;
      while (workbook.sheets.some(s => s.name === 'Sheet' + n)) n++;
      name = 'Sheet' + n;
    }
    const sheet = makeBlankSheet(name);
    // Insert before any pinned trailing tabs (e.g. Detailed Costs) so
    // user-created sheets stay grouped on the left.
    var firstPinned = workbook.sheets.findIndex(s => s.pinned);
    if (firstPinned === -1) workbook.sheets.push(sheet);
    else workbook.sheets.splice(firstPinned, 0, sheet);
    workbook.activeSheetId = sheet.id;
    loadSheetIntoGrid(sheet);
    workbook.dirty = true;
    grid.dirty = true;
    renderActiveSheet();
    renderSheetTabs();
    selectCell(0, 0);
    return sheet.id;
  }

  async function deleteSheet(sheetId) {
    const sheet = workbook.sheets.find(s => s.id === sheetId);
    if (sheet && sheet.pinned) {
      alert('"' + sheet.name + '" is a built-in view and cannot be deleted.');
      return;
    }
    // At least one editable (non-pinned) grid sheet must remain.
    var editableCount = workbook.sheets.filter(s => !s.pinned).length;
    if (editableCount <= 1) {
      alert('Workbook must have at least one editable sheet.');
      return;
    }
    const idx = workbook.sheets.findIndex(s => s.id === sheetId);
    if (idx === -1) return;
    if (!(await p86Ask('Delete sheet "' + sheet.name + '"? This cannot be undone.'))) return;
    workbook.sheets.splice(idx, 1);
    if (workbook.activeSheetId === sheetId) {
      // Pick the previous non-pinned sheet so we don't land on a
      // built-in view by accident.
      var fallback = workbook.sheets.slice(0, idx).reverse().find(s => !s.pinned)
        || workbook.sheets.find(s => !s.pinned);
      workbook.activeSheetId = (fallback || workbook.sheets[0]).id;
      loadSheetIntoGrid(workbook.sheets.find(s => s.id === workbook.activeSheetId));
      recalcAll();
      renderActiveSheet();
      selectCell(0, 0);
    }
    workbook.dirty = true;
    renderSheetTabs();
    // Persist the delete to localStorage immediately. Without this the
    // sheet was only removed in memory — a page refresh re-loaded the
    // pre-delete workspace from disk and the deleted sheet came back.
    saveWorkspace();
  }

  // Hide a single sheet — kept in the workbook so cross-sheet formulas
  // still resolve, but disappears from both tab strips. Pinned built-in
  // views can't be hidden (they're always reachable from the bottom
  // strip). At least one visible non-pinned sheet must remain so the
  // user isn't stranded with nothing to edit.
  function hideSheet(sheetId) {
    const sheet = workbook.sheets.find(s => s.id === sheetId);
    if (!sheet) return;
    if (sheet.pinned) {
      alert('"' + sheet.name + '" is a built-in view and cannot be hidden.');
      return;
    }
    var visibleNonPinned = workbook.sheets.filter(s => !s.pinned && !s.hidden).length;
    if (visibleNonPinned <= 1) {
      alert('At least one visible sheet must remain.');
      return;
    }
    sheet.hidden = true;
    workbook.dirty = true;
    if (workbook.activeSheetId === sheetId) {
      // If the hidden sheet was active, fall back to the next visible
      // sibling in the same group, or any visible non-pinned sheet.
      var siblings = workbook.sheets.filter(s =>
        s.workbookGroupId && s.workbookGroupId === sheet.workbookGroupId && !s.hidden);
      var fallback = siblings[0]
        || workbook.sheets.find(s => !s.pinned && !s.hidden)
        || workbook.sheets.find(s => !s.hidden);
      if (fallback) {
        workbook.activeSheetId = fallback.id;
        loadSheetIntoGrid(fallback);
        recalcAll();
        renderActiveSheet();
        selectCell(0, 0);
      }
    }
    renderSheetTabs();
    saveWorkspace();
  }

  function unhideSheet(sheetId) {
    const sheet = workbook.sheets.find(s => s.id === sheetId);
    if (!sheet) return;
    sheet.hidden = false;
    workbook.dirty = true;
    renderSheetTabs();
    saveWorkspace();
  }

  // Pop a small picker listing every hidden sheet (optionally scoped to
  // a workbook group) so the user can restore one. Mirrors Excel's
  // "Unhide..." dialog.
  function showUnhideMenu(x, y, groupId) {
    var hidden = workbook.sheets.filter(function(s) {
      if (!s.hidden) return false;
      if (groupId) return s.workbookGroupId === groupId;
      return true;
    });
    if (!hidden.length) {
      alert('No hidden sheets.');
      return;
    }
    var items = hidden.map(function(s) {
      var label = s.workbookGroupName && !groupId
        ? s.name + '  —  ' + s.workbookGroupName
        : s.name;
      return { label: label, action: function() { unhideSheet(s.id); } };
    });
    showContextMenu(x, y, items);
  }

  function renameSheet(sheetId, newName) {
    const sheet = workbook.sheets.find(s => s.id === sheetId);
    if (!sheet) return;
    if (sheet.pinned) {
      alert('"' + sheet.name + '" is a built-in view and cannot be renamed.');
      return;
    }
    const trimmed = String(newName || '').trim();
    if (!trimmed) return;
    if (workbook.sheets.some(s => s.id !== sheetId && s.name === trimmed)) {
      alert('A sheet named "' + trimmed + '" already exists.');
      return;
    }
    sheet.name = trimmed;
    workbook.dirty = true;
    renderSheetTabs();
  }

  function duplicateSheet(sheetId) {
    syncGridToActiveSheet();
    const src = workbook.sheets.find(s => s.id === sheetId);
    if (!src) return;
    if (src.pinned) {
      alert('"' + src.name + '" is a built-in view and cannot be duplicated.');
      return;
    }
    const copy = {
      id: newSheetId(),
      name: src.name + ' (copy)',
      kind: 'grid',
      rows: src.rows,
      cols: src.cols,
      cells: JSON.parse(JSON.stringify(src.cells)),
      colWidths: JSON.parse(JSON.stringify(src.colWidths)),
      rowHeights: JSON.parse(JSON.stringify(src.rowHeights || {})),
      // Exact Excel geometry (S4) — deep-copied so a resize on the copy
      // can't mutate the original's stored units.
      colWch: JSON.parse(JSON.stringify(src.colWch || {})),
      rowHpt: JSON.parse(JSON.stringify(src.rowHpt || {})),
      links: JSON.parse(JSON.stringify(src.links)),
      merges: JSON.parse(JSON.stringify(src.merges))
    };
    const idx = workbook.sheets.findIndex(s => s.id === sheetId);
    workbook.sheets.splice(idx + 1, 0, copy);
    workbook.dirty = true;
    renderSheetTabs();
  }

  function moveSheet(sheetId, direction) {
    const idx = workbook.sheets.findIndex(s => s.id === sheetId);
    if (idx === -1) return;
    const target = direction === 'left' ? idx - 1 : idx + 1;
    if (target < 0 || target >= workbook.sheets.length) return;
    const [sheet] = workbook.sheets.splice(idx, 1);
    workbook.sheets.splice(target, 0, sheet);
    workbook.dirty = true;
    renderSheetTabs();
  }

  // ── xlsx / csv import ──────────────────────────────────────
  // .xlsx files parse on the SERVER (exceljs — full style + exact theme
  // color + shared-formula fidelity; S3 of the Excel-fidelity plan).
  // .xls / .csv keep the legacy SheetJS client path (exceljs reads
  // neither), and the SheetJS path doubles as the offline/server-error
  // fallback for .xlsx (values + formulas survive; styles don't).
  // Imported as window.wsImportXlsxFile so the Attachments embed (and
  // any future drop targets) can reuse the same parser/import path
  // when the user drops an xlsx anywhere in the workspace UI.
  function handleXlsxImport(file) {
    if (!file) return;
    if (/\.xlsx$/i.test(file.name || '')) {
      // Two-arg .then: the rejection handler covers ONLY the fetch/
      // parse. An install failure must NOT fall through to the SheetJS
      // path — the sheets may already be spliced in, and a second
      // import would duplicate every tab as "Name (2)".
      serverParseXlsx(file).then(function(parsed) {
        try {
          installImportedSheets(parsed.sheets || [], file.name, parsed.namedRanges || []);
        } catch (err) {
          console.error('xlsx install failed:', err);
          var status = document.getElementById('wsStatus');
          if (status) status.textContent = 'Ready';
          alert('Import failed: ' + (err.message || err));
        }
      }, function(e) {
        console.warn('[workspace] server import failed — falling back to SheetJS (no styles):', e && e.message);
        legacySheetJSImport(file);
      });
      return;
    }
    legacySheetJSImport(file);
  }

  // POST the raw bytes to the server parser; resolves to
  // { sheets: [agxSheetSansId…], namedRanges: [{name, ref}…] }.
  function serverParseXlsx(file) {
    var headers = { 'Content-Type': 'application/octet-stream' };
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) || localStorage.getItem('p86-auth-token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var status = document.getElementById('wsStatus');
    if (status) status.textContent = 'Importing…';
    return fetch('/api/workspace/import-xlsx', {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: file
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function(e) {
      if (status) status.textContent = 'Ready';
      throw e;
    });
  }

  // Legacy SheetJS parse (.xls / .csv, and .xlsx fallback). Builds the
  // same sheet-def shape the server returns, then shares the install.
  function legacySheetJSImport(file) {
    if (typeof XLSX === 'undefined') {
      alert('Spreadsheet library still loading. Try again in a moment.');
      return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const data = new Uint8Array(e.target.result);
        // cellFormula:true gives us .f (formula string) on each cell;
        // cellDates:true keeps dates as JS Date objects; cellStyles:true
        // returns what little styling the Community build can read.
        const wb = XLSX.read(data, {
          type: 'array',
          cellFormula: true,
          cellDates: true,
          cellStyles: true
        });
        if (!wb.SheetNames.length) {
          alert('No sheets in that file.');
          return;
        }
        const defs = [];
        wb.SheetNames.forEach(function(srcName) {
          const ws = wb.Sheets[srcName];
          if (!ws) return;
          const sheet = importXlsxSheet(ws, srcName);
          if (sheet) defs.push(sheet);
        });
        const nrDefs = [];
        if (wb.Workbook && Array.isArray(wb.Workbook.Names)) {
          wb.Workbook.Names.forEach(function(dn) {
            if (!dn || !dn.Name || !dn.Ref) return;
            const def = { name: dn.Name, ref: dn.Ref };
            if (typeof dn.Sheet === 'number' && wb.SheetNames[dn.Sheet]) {
              def.sheetName = wb.SheetNames[dn.Sheet];
            }
            nrDefs.push(def);
          });
        }
        installImportedSheets(defs, file.name, nrDefs);
      } catch (err) {
        console.error('xlsx import failed:', err);
        alert('Import failed: ' + (err.message || err));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // Install parsed sheet defs into the workbook — the shared back half
  // of both import paths. Handles ids, name collisions, workbook
  // grouping, tab placement, named ranges, recalc, and save.
  function installImportedSheets(sheetDefs, fileName, nrDefs) {
    sheetDefs = (sheetDefs || []).filter(Boolean);
    if (!sheetDefs.length) {
      alert('Nothing imported — sheets were empty.');
      return;
    }
    // Sync current grid before mutating workbook
    syncGridToActiveSheet();
    const baseName = String(fileName || 'import').replace(/\.[^.]+$/, '');
    // Multi-sheet imports group under one workbook entry — single tab
    // in the bottom bar, inner sheets on a secondary strip.
    const groupId = sheetDefs.length > 1
      ? ('wbgrp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6))
      : null;
    // Keep imported sheets together at the end of editable tabs but
    // before any pinned built-ins (Detailed Costs, Attachments).
    let insertAt = workbook.sheets.findIndex(s => s.pinned);
    if (insertAt === -1) insertAt = workbook.sheets.length;
    // Map source sheet name → new AGX sheet id, so workbook-level
    // defined names (named ranges) can be re-linked after install.
    const srcNameToSheetId = {};
    let added = 0;
    sheetDefs.forEach(function(def) {
      const srcName = def.sourceSheetName || def.name;
      let name = def.name;
      if (workbook.sheets.some(s => s.name === name)) {
        // Collision — append (n) until we find a free slot.
        let collisionN = 2;
        const stem = name;
        while (workbook.sheets.some(s => s.name === name)) {
          name = stem + ' (' + (collisionN++) + ')';
        }
      }
      const sheet = def;
      sheet.id = sheet.id || newSheetId();
      sheet.name = name;
      sheet.kind = sheet.kind || 'grid';
      sheet.rows = Math.max(sheet.rows || 0, MIN_ROWS);
      sheet.cols = Math.max(sheet.cols || 0, MIN_COLS);
      sheet.cells = sheet.cells || {};
      sheet.colWidths = sheet.colWidths || {};
      sheet.rowHeights = sheet.rowHeights || {};
      sheet.links = sheet.links || {};
      sheet.merges = sheet.merges || [];
      sheet.tables = sheet.tables || [];
      // Track origin so a future "delete imported workbook" action can
      // find every sheet from a given file.
      sheet.sourceFile = fileName;
      sheet.sourceSheetName = srcName;
      if (groupId) {
        sheet.workbookGroupId = groupId;
        sheet.workbookGroupName = baseName;
      }
      workbook.sheets.splice(insertAt, 0, sheet);
      insertAt++;
      added++;
      srcNameToSheetId[srcName] = sheet.id;
    });
    // Switch to the first newly-added VISIBLE sheet so the user sees
    // the result (hidden sheets import as hidden tabs — activating one
    // would land the user on an invisible sheet).
    const newSlice = workbook.sheets.slice(insertAt - added, insertAt);
    const firstNew = newSlice.find(s => !s.hidden) || newSlice[0];
    workbook.activeSheetId = firstNew.id;
    loadSheetIntoGrid(firstNew);

    // Workbook-level defined names (named ranges). Skips Excel
    // built-ins (_xlnm.*), invalid names, and clashes with names
    // already defined in this workbook.
    (nrDefs || []).forEach(function(dn) {
      if (!dn || !dn.name || !dn.ref) return;
      if (/^_xlnm\./i.test(dn.name)) return;
      var nm = String(dn.name);
      if (validateRangeName(nm)) return;
      if (!workbook.namedRanges) workbook.namedRanges = {};
      if (workbook.namedRanges[nm.toUpperCase()]) return;
      // Defined names may list multiple comma-separated areas — we
      // only model a single rectangular ref, so take the first.
      var ref = String(dn.ref).split(',')[0].trim();
      var sheetId = null, bare = ref;
      var bang = ref.lastIndexOf('!');
      if (bang !== -1) {
        var sn = ref.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
        bare = ref.slice(bang + 1);
        if (srcNameToSheetId[sn]) sheetId = srcNameToSheetId[sn];
        else { var sh = findSheetByName(sn); if (sh) sheetId = sh.id; }
        // A sheet-qualified name whose sheet didn't import must be
        // DROPPED, not installed bare — a bare ref resolves against
        // whatever sheet is active at eval time and yields plausible
        // wrong numbers with no error.
        if (!sheetId) return;
      } else if (dn.sheetName && srcNameToSheetId[dn.sheetName]) {
        sheetId = srcNameToSheetId[dn.sheetName];
      }
      bare = bare.replace(/\$/g, '');
      var parts = bare.split(':');
      var a = parseAddr(parts[0].toUpperCase());
      if (!a) return;
      workbook.namedRanges[nm.toUpperCase()] = {
        name: nm, ref: bare, sheetId: sheetId, comment: ''
      };
    });

    workbook.dirty = true;
    recalcAll();
    renderGrid();
    renderSheetTabs();
    selectCell(0, 0);
    saveWorkspace();
    var status = document.getElementById('wsStatus');
    if (status) {
      status.textContent = '✓ Imported ' + added + ' sheet(s)';
      setTimeout(function() { status.textContent = 'Ready'; }, 2500);
    }
  }

  // Convert one SheetJS worksheet object into an AGX sheet object.
  // Excel formulas (`.f`) come without a leading `=`; we add it so our
  // evaluator picks them up. Values are kept as-is (strings/numbers/Date
  // become string), formatted dates rendered as YYYY-MM-DD.
  //
  // Style preservation: when SheetJS was called with cellStyles:true,
  // each cell carries a `.s` object with font/fill/alignment we map
  // into our own style shape (see buildCellStyle for the rendering
  // side). Only present when the source file had explicit styling —
  // unstyled cells skip the conversion entirely.
  function importXlsxSheet(ws, name) {
    const ref = ws['!ref'];
    if (!ref) return null;
    const range = XLSX.utils.decode_range(ref);
    const rows = Math.max(range.e.r + 1, MIN_ROWS);
    const cols = Math.max(range.e.c + 1, MIN_COLS);
    const cells = {};
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const a = XLSX.utils.encode_cell({ r: r, c: c });
        const cell = ws[a];
        if (!cell) continue;
        const ourAddr = colLetter(c) + (r + 1);
        let raw;
        let importedValue;
        if (cell.f) {
          raw = '=' + cell.f;
          // Keep Excel's CACHED RESULT for the formula — correct display
          // straight after import (before recalc), and recalcAll's
          // fallback whenever our engine can't evaluate a function the
          // file uses. Cleared on any user edit of the cell.
          if (cell.v != null && typeof cell.v !== 'object') {
            importedValue = cell.v;
          } else if (cell.v instanceof Date) {
            importedValue = cell.v.toISOString().slice(0, 10);
          }
        } else if (cell.v instanceof Date) {
          raw = cell.v.toISOString().slice(0, 10);
        } else if (cell.v != null) {
          raw = cell.v;
        }
        // Translate SheetJS cell.s → AGX cell.style. Skip empty cells
        // unless they carry style — Excel often has style-only cells
        // (background fills) that we should preserve.
        const style = xlsxStyleToAgx(cell.s);
        if (raw == null && !style) continue;
        const out = {
          raw: raw == null ? '' : raw,
          value: raw == null ? '' : (importedValue != null ? importedValue : raw)
        };
        if (importedValue != null) out.importedValue = importedValue;
        if (style) out.style = style;
        // Number format pass-through. Maps Excel format strings to
        // (fmt, decimals) so values render with the right family +
        // precision. Covers currency / percent / comma / general
        // numeric formats. Examples handled:
        //   $#,##0.00          → currency, 2 decimals
        //   "$"#,##0           → currency, 0 decimals
        //   0.00%              → percent, 2 decimals
        //   #,##0              → comma, 0 decimals
        //   #,##0.000          → comma, 3 decimals
        //   0.0                → comma, 1 decimal (treat plain numeric
        //                        as comma so 1234.5 → "1,234.5")
        if (cell.z) {
          var z = String(cell.z);
          var hasCurrency = /[\$£€¥]/.test(z) || /\bUSD\b/i.test(z);
          var hasPercent  = /%/.test(z);
          var hasComma    = /#,##0/.test(z) || /,/.test(z);
          // Decimal count = number of zeros after the decimal point in
          // the format string. Looks at the first occurrence so
          // "0.00;[Red]0.00" picks up 2 correctly.
          var decMatch = z.match(/\.([0#]+)/);
          var decimals = decMatch ? decMatch[1].length : null;
          if (hasCurrency)      { out.fmt = 'currency'; if (decimals != null) out.decimals = decimals; }
          else if (hasPercent)  { out.fmt = 'percent';  if (decimals != null) out.decimals = decimals; }
          else if (hasComma)    { out.fmt = 'comma';    if (decimals != null) out.decimals = decimals; }
          else if (/^[0]+(\.[0]+)?$/.test(z) && decimals != null) {
            // Plain "0.00" style — render as comma without thousands
            // separator visually, but use comma fmt so trailing zeros
            // hold (e.g., 1.5 displays as "1.50" rather than "1.5").
            out.fmt = 'comma';
            out.decimals = decimals;
          }
          // Preserve the original Excel format string so the custom
          // number-format editor round-trips it on re-export.
          if (z && z !== 'General') out.numFmt = z;
        }
        // Hyperlink import — SheetJS `.l` = { Target, Tooltip }.
        if (cell.l && cell.l.Target) {
          out.hyperlink = { url: cell.l.Target };
          if (cell.l.Tooltip) out.hyperlink.display = cell.l.Tooltip;
        }
        // Comment import — SheetJS `.c` = [{ a: author, t: text }, ...].
        if (cell.c && cell.c.length) {
          var noteText = cell.c.map(function(cm) { return cm && cm.t ? cm.t : ''; })
                                .filter(Boolean).join('\n');
          if (noteText) out.note = noteText;
        }
        cells[ourAddr] = out;
      }
    }
    // Pull column widths from xlsx if present. colWch keeps Excel's
    // native character units verbatim so export round-trips exactly
    // (S4); px ≈ wch×7+5 is only the render approximation.
    const colWidths = {};
    const colWch = {};
    if (ws['!cols']) {
      ws['!cols'].forEach(function(col, idx) {
        if (col && (col.wpx || col.wch)) {
          colWidths[idx] = Math.max(24, Math.round(col.wpx || (col.wch * 7 + 5)));
          if (typeof col.wch === 'number' && col.wch > 0) colWch[idx] = col.wch;
        }
      });
    }
    // Row heights — preserve any explicit per-row height the source
    // xlsx had. rowHpt keeps Excel's native points verbatim (S4);
    // px ≈ pt × 1.333 is the render approximation.
    const rowHeights = {};
    const rowHpt = {};
    if (ws['!rows']) {
      ws['!rows'].forEach(function(row, idx) {
        if (row && (row.hpx || row.hpt)) {
          rowHeights[idx] = Math.max(12, Math.round(row.hpx || (row.hpt * 1.333)));
          if (typeof row.hpt === 'number' && row.hpt > 0) rowHpt[idx] = row.hpt;
        }
      });
    }
    // Pull merges if present (Excel format → our format)
    const merges = (ws['!merges'] || []).map(function(m) {
      return { r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c };
    });
    return {
      id: newSheetId(),
      name: name,
      kind: 'grid',
      rows: rows,
      cols: cols,
      cells: cells,
      colWidths: colWidths,
      colWch: colWch,
      rowHeights: rowHeights,
      rowHpt: rowHpt,
      links: {},
      merges: merges,
      tables: []
    };
  }

  // Translate a SheetJS cell.s object → AGX cell.style. Returns null
  // when the source has nothing to copy. SheetJS RGB colors come back
  // as 6-char hex strings without a leading `#`; some cells use ARGB
  // (8 chars) — strip the alpha byte. Theme colors aren't resolved
  // by the CE build so they fall through silently rather than guess.
  // Office 2007+ default theme palette, indexed by the *theme attribute*
  // value as it appears on <color theme="N"/> in xlsx XML. Note the
  // dk/lt swap — Microsoft remaps 0/1 and 2/3 from the underlying
  // theme XML order. Files without a custom theme1.xml resolve here;
  // files WITH a custom theme also fall back here when SheetJS
  // doesn't expose Themes (older builds). Close enough for most
  // construction-takeoff aesthetics — accent4 (#FFC000) maps the
  // common yellow highlights to the right hue.
  var XLSX_THEME_DEFAULTS = [
    '#000000', // 0 dk1 (text)
    '#FFFFFF', // 1 lt1 (bg)
    '#44546A', // 2 dk2
    '#E7E6E6', // 3 lt2
    '#5B9BD5', // 4 accent1 (Office 2016+ blue)
    '#ED7D31', // 5 accent2 (orange)
    '#A5A5A5', // 6 accent3 (gray)
    '#FFC000', // 7 accent4 (yellow)
    '#4472C4', // 8 accent5
    '#70AD47', // 9 accent6 (green)
    '#0563C1', // 10 hyperlink
    '#954F72'  // 11 followedHyperlink
  ];

  // Apply Excel's tint (-1..+1) to an RGB hex. Positive = lighten
  // toward white, negative = darken toward black, 0 = no change.
  // Cheap RGB-space approximation; matches Excel close enough for
  // the eye to read it as the same color family without doing full
  // HSL conversion.
  function xlsxApplyTint(rgb, tint) {
    if (!rgb || tint == null || tint === 0) return rgb;
    var r = parseInt(rgb.slice(1, 3), 16);
    var g = parseInt(rgb.slice(3, 5), 16);
    var b = parseInt(rgb.slice(5, 7), 16);
    if (tint > 0) {
      var t = Math.min(1, tint);
      r = Math.round(r + (255 - r) * t);
      g = Math.round(g + (255 - g) * t);
      b = Math.round(b + (255 - b) * t);
    } else {
      var d = 1 + Math.max(-1, tint); // 0..1
      r = Math.round(r * d);
      g = Math.round(g * d);
      b = Math.round(b * d);
    }
    var hex = function(v) {
      var h = Math.max(0, Math.min(255, v)).toString(16);
      return h.length === 1 ? '0' + h : h;
    };
    return '#' + hex(r) + hex(g) + hex(b);
  }

  function xlsxStyleToAgx(s) {
    if (!s || typeof s !== 'object') return null;
    var out = {};
    // Resolve any of SheetJS's color shapes to a #RRGGBB hex:
    //   { rgb: 'AARRGGBB' }      — explicit ARGB (alpha stripped)
    //   { rgb: 'RRGGBB' }        — explicit RGB
    //   { theme: N, tint: T }    — theme reference (resolved via
    //                              XLSX_THEME_DEFAULTS, then tinted)
    //   { indexed: N }           — legacy palette (sparse mapping)
    var hadColor = function(c) {
      if (!c || typeof c !== 'object') return null;
      // Direct RGB — most explicit colors come through this way.
      if (typeof c.rgb === 'string') {
        var rgb = c.rgb;
        if (rgb.length === 8) rgb = rgb.slice(2); // ARGB → RGB
        if (rgb.length === 6) {
          return xlsxApplyTint('#' + rgb.toLowerCase(), c.tint || 0);
        }
      }
      // Theme reference — resolve via the Office defaults and apply
      // the tint. This is what most modern xlsx files use.
      if (typeof c.theme === 'number') {
        var base = XLSX_THEME_DEFAULTS[c.theme];
        if (base) return xlsxApplyTint(base.toLowerCase(), c.tint || 0);
      }
      // Indexed (legacy) — only handle the values that come up most
      // often in real files. Black + white cover the bulk; the rest
      // mostly fall through to "no color preserved" rather than
      // showing a wrong color.
      if (typeof c.indexed === 'number') {
        if (c.indexed === 64) return null; // 64 = "automatic" — let theme decide
        var indexedMap = {
          0: '#000000', 1: '#ffffff',
          2: '#ff0000', 3: '#00ff00', 4: '#0000ff',
          5: '#ffff00', 6: '#ff00ff', 7: '#00ffff',
          8: '#000000', 9: '#ffffff'
        };
        var hex = indexedMap[c.indexed];
        if (hex) return xlsxApplyTint(hex, c.tint || 0);
      }
      return null;
    };
    if (s.font) {
      if (s.font.bold) out.bold = true;
      if (s.font.italic) out.italic = true;
      if (s.font.underline) out.underline = true;
      var fc = hadColor(s.font.color);
      if (fc) out.color = fc;
      if (typeof s.font.sz === 'number' && s.font.sz > 0 && s.font.sz !== 11) {
        // Excel default is 11pt — only persist non-defaults to keep
        // payloads small. Our render uses px; pt × 1.333 ≈ px.
        out.fontSize = Math.round(s.font.sz * 1.333);
      }
    }
    if (s.fill) {
      // Excel reserves fgColor for solid fills; bgColor is the pattern
      // background. For the common "filled cell" case fgColor is what
      // the user actually sees, so prefer it.
      var bg = hadColor(s.fill.fgColor) || hadColor(s.fill.bgColor);
      // Skip fully white / theme-default fills (Excel sometimes writes
      // "ffffff" on every cell). Black fills ARE preserved — they're
      // deliberate dividers / separators in construction takeoffs and
      // dropping them loses an important visual cue.
      if (bg && bg !== '#ffffff') out.bg = bg;
    }
    if (s.alignment) {
      if (typeof s.alignment.horizontal === 'string' && /^(left|center|right)$/i.test(s.alignment.horizontal)) {
        out.align = s.alignment.horizontal.toLowerCase();
      }
      if (s.alignment.wrapText) out.wrap = true;
    }
    // Borders — translate the four-side xlsx border object into a flat
    // {top,right,bottom,left} map of {style,width,color}. Common xlsx
    // styles (thin/medium/thick/dashed/dotted/double) get mapped to
    // their CSS equivalents. buildCellStyle then renders each side as
    // border-<side> inline so individual edges land in the right cell.
    if (s.border) {
      var styleMap = {
        thin:           { style: 'solid',  width: 1 },
        hair:           { style: 'solid',  width: 1 },
        medium:         { style: 'solid',  width: 2 },
        thick:          { style: 'solid',  width: 3 },
        dashed:         { style: 'dashed', width: 1 },
        mediumDashed:   { style: 'dashed', width: 2 },
        dotted:         { style: 'dotted', width: 1 },
        double:         { style: 'double', width: 3 }
      };
      var bord = {};
      ['top', 'right', 'bottom', 'left'].forEach(function(side) {
        var b = s.border[side];
        if (b && b.style && b.style !== 'none') {
          var bc = hadColor(b.color) || '#000000';
          var m = styleMap[b.style] || { style: 'solid', width: 1 };
          bord[side] = { style: m.style, width: m.width, color: bc };
        }
      });
      if (Object.keys(bord).length) out.borders = bord;
    }
    var anyKey = Object.keys(out).length > 0;
    return anyKey ? out : null;
  }

  // Resolve a sheet name to a sheet object — used by cross-sheet
  // formula refs (`=Sheet2!A1`). Case-insensitive match. Returns null
  // when the named sheet doesn't exist.
  function findSheetByName(name) {
    if (!name) return null;
    const target = String(name).trim().toLowerCase();
    return workbook.sheets.find(s => s.name.toLowerCase() === target) || null;
  }

  // Read a cell from a specific sheet without disturbing grid. Used by
  // cross-sheet formula resolution.
  function getCellFromSheet(sheet, r, c) {
    if (!sheet) return { value: '', raw: '' };
    const a = colLetter(c) + (r + 1);
    return sheet.cells[a] || { value: '', raw: '' };
  }

  // ── Rendering ──────────────────────────────────────────────

  // Ribbon icon helper — AGX heroicon/phosphor line icons via the
  // global registry. Defensive: if agx-icons.js hasn't executed yet
  // (script-order edge on a cold cache) fall back to the plain text
  // glyph so the button never renders empty.
  function wsIco(name, fallback) {
    if (window.p86Icon) {
      var svg = window.p86Icon(name, { class: 'ws-ribbon-ico' });
      if (svg) return svg;
    }
    return fallback || '';
  }

  function buildWorkspaceHTML() {
    return `
      <!-- Formula bar — Excel-style cell reference + formula input,
           kept as its own row above the ribbon so it gets full width
           and the long formula text isn't crowded by buttons. -->
      <div class="ws-toolbar">
        <input type="text" class="ws-cell-ref" id="wsCellRef" value="A1" spellcheck="false" title="Name Box — type a cell (A1), range (A1:B5), or named range to go there; type a new name to define one for the selection" />
        <input type="text" class="ws-formula-bar" id="wsFormulaBar" placeholder="Enter value or formula (e.g. =A1+B1)" spellcheck="false" />
      </div>

      <!-- Ribbon — single grouped row that mirrors Excel's Home tab
           layout: each section is a vertical stack of controls + a
           small uppercase label underneath, separated by 1px dividers.
           All button IDs / data-attrs preserved from the previous
           flat layout so the wiring code keeps working unchanged. -->
      <div class="ws-ribbon" id="wsToolbarFmt">

        <!-- File — Phase 1 round-trip + find/replace.
             The job side has Import/Save in the floating header (Quick
             Access Toolbar) and these are redundant there but harmless;
             the estimate side has no floating shell so these are the
             only way to import / export / find on that side. -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-btn-icon" id="wsImportXlsxBtn" title="Import .xlsx / .xls / .csv as new sheets">${wsIco('import', '&#x1F4E5;')}</button>
            <input type="file" id="wsImportXlsxInput" accept=".xlsx,.xls,.csv" style="display:none;" />
            <button class="ws-btn ws-btn-icon" id="wsExportXlsxBtn" onclick="window.wsExportXlsx()" title="Export workbook to .xlsx (preserves formulas, merges, column widths, frozen panes)">${wsIco('exports', '&#x1F4E4;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsExportCsvBtn" onclick="window.wsExportCsv()" title="Export active sheet to .csv">${wsIco('document-text', '&#x1F4DD;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsFindReplaceBtn" onclick="window.wsOpenFindReplace()" title="Find / Replace (Ctrl+F)">${wsIco('magnifying-glass', '&#x1F50D;')}</button>
            <a class="ws-btn ws-btn-icon ws-tb-popout" href="#" target="_blank" rel="noopener" title="Pop out to a separate window — drag it to another monitor (right-click → Open in new window)">${wsIco('popout', '&#x29C9;')}</a>
          </div>
          <div class="ws-ribbon-label">File</div>
        </div>

        <!-- History -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-btn-icon" id="wsUndoBtn" title="Undo (Ctrl+Z)">${wsIco('restore', '&#x21A9;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsRedoBtn" title="Redo (Ctrl+Y)">${wsIco('redo', '&#x21AA;')}</button>
          </div>
          <div class="ws-ribbon-label">History</div>
        </div>

        <!-- Font -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-fmt-toggle" id="wsBoldBtn" data-style="bold" title="Bold (Ctrl+B)">${wsIco('bold', '<b>B</b>')}</button>
            <button class="ws-btn ws-fmt-toggle" id="wsItalicBtn" data-style="italic" title="Italic (Ctrl+I)">${wsIco('italic', '<i>I</i>')}</button>
            <button class="ws-btn ws-fmt-toggle" id="wsUnderlineBtn" data-style="underline" title="Underline (Ctrl+U)">${wsIco('underline', '<u>U</u>')}</button>
            <button class="ws-btn ws-fmt-toggle" id="wsStrikeBtn" data-style="strikethrough" title="Strikethrough">${wsIco('strikethrough', '<s>S</s>')}</button>
            <div class="ws-color-dropdown" id="wsFillDropdown">
              <button class="ws-btn ws-btn-icon ws-color-trigger" id="wsFillBtn" title="Fill color">
                <span class="ws-color-icon">${wsIco('paint-brush', '&#x25A0;')}</span>
                <span class="ws-color-swatch" id="wsFillSwatch"></span>
              </button>
              <div class="ws-color-panel" id="wsFillPanel">
                <div class="ws-color-grid" id="wsFillGrid"></div>
                <div class="ws-color-recent-label">Recent</div>
                <div class="ws-color-recent" id="wsFillRecent"></div>
                <div class="ws-color-custom"><label>Custom <input type="color" id="wsFillCustom" value="#1a1a20" /></label></div>
              </div>
            </div>
            <div class="ws-color-dropdown" id="wsFontDropdown">
              <button class="ws-btn ws-btn-icon ws-color-trigger" id="wsFontBtn" title="Font color">
                <span class="ws-color-icon ws-color-icon-text">A</span>
                <span class="ws-color-swatch" id="wsFontSwatch"></span>
              </button>
              <div class="ws-color-panel" id="wsFontPanel">
                <div class="ws-color-grid" id="wsFontGrid"></div>
                <div class="ws-color-recent-label">Recent</div>
                <div class="ws-color-recent" id="wsFontRecent"></div>
                <div class="ws-color-custom"><label>Custom <input type="color" id="wsFontCustom" value="#e4e6f0" /></label></div>
              </div>
            </div>
          </div>
          <div class="ws-ribbon-label">Font</div>
        </div>

        <!-- Alignment -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-fmt-align" data-align="left" title="Align left">${wsIco('align-left', '&#x2190;')}</button>
            <button class="ws-btn ws-fmt-align" data-align="center" title="Align center">${wsIco('align-center', '&#x2194;')}</button>
            <button class="ws-btn ws-fmt-align" data-align="right" title="Align right">${wsIco('align-right', '&#x2192;')}</button>
            <button class="ws-btn ws-fmt-toggle" id="wsWrapBtn" data-style="wrap" title="Wrap text">${wsIco('wrap-text', '&#x21B5;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsMergeBtn" title="Merge cells">${wsIco('merge-cells', '&#x1F500;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsUnmergeBtn" title="Unmerge cells">${wsIco('fullscreen', '&#x2702;')}</button>
          </div>
          <div class="ws-ribbon-label">Alignment</div>
        </div>

        <!-- Number -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-btn-fmt" data-fmt="currency" title="Currency format">$</button>
            <button class="ws-btn ws-btn-fmt" data-fmt="percent" title="Percent format">%</button>
            <button class="ws-btn ws-btn-fmt" data-fmt="comma" title="Comma format (1,234.56)">,</button>
            <button class="ws-btn ws-btn-icon ws-btn-txt" id="wsIncDecBtn" onclick="window.wsIncDecimal()" title="Increase decimal places">&larr;.0</button>
            <button class="ws-btn ws-btn-icon ws-btn-txt" id="wsDecDecBtn" onclick="window.wsDecDecimal()" title="Decrease decimal places">.0&rarr;</button>
            <button class="ws-btn ws-btn-icon" id="wsNumFmtBtn" onclick="window.wsOpenNumFmt()" title="More number formats (custom)">${wsIco('hashtag', '&#x1F522;')}</button>
            <button class="ws-btn ws-btn-fmt" data-fmt="null" title="Clear number format">&times;</button>
          </div>
          <div class="ws-ribbon-label">Number</div>
        </div>

        <!-- Borders -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <div class="ws-color-dropdown" id="wsBorderDropdown">
              <button class="ws-btn ws-btn-icon" id="wsBorderBtn" title="Borders">${wsIco('borders', '&#x25A6;')}</button>
              <div class="ws-color-panel ws-border-panel" id="wsBorderPanel">
                <button class="ws-border-preset" data-border="all" title="All borders">&#x25A6; All borders</button>
                <button class="ws-border-preset" data-border="outside" title="Outside borders">&#x25A2; Outside</button>
                <button class="ws-border-preset" data-border="inside" title="Inside borders only">&#x25A4; Inside</button>
                <button class="ws-border-preset" data-border="thick-outside" title="Thick box border">&#x25A0; Thick outside</button>
                <button class="ws-border-preset" data-border="top" title="Top border">&#x2594; Top</button>
                <button class="ws-border-preset" data-border="bottom" title="Bottom border">&#x2581; Bottom</button>
                <button class="ws-border-preset" data-border="left" title="Left border">&#x258F; Left</button>
                <button class="ws-border-preset" data-border="right" title="Right border">&#x2595; Right</button>
                <button class="ws-border-preset" data-border="none" title="No border">&#x2718; None</button>
              </div>
            </div>
          </div>
          <div class="ws-ribbon-label">Borders</div>
        </div>

        <!-- Styles -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <div class="ws-color-dropdown" id="wsStyleDropdown">
              <button class="ws-btn ws-btn-icon" id="wsStyleBtn" title="Cell styles">${wsIco('swatch', '&#x1F3A8;')}</button>
              <div class="ws-color-panel ws-style-panel" id="wsStylePanel"></div>
            </div>
            <button class="ws-btn ws-btn-icon" id="wsClearFmtBtn" title="Clear formatting">${wsIco('eraser', '&#x2718;')}</button>
          </div>
          <div class="ws-ribbon-label">Styles</div>
        </div>

        <!-- Cells. Row/col insert + delete buttons removed — the
             statusbar's +Row / +Col controls cover adding to the
             grid bottom; per-row/col insert + delete are still
             available via the right-click context menu on row /
             column headers. -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-btn-icon" id="wsLinkBtn" title="Link cell to job field">${wsIco('links', '&#x1F517;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsMakeTableBtn" onclick="window.wsMakeTable()" title="Convert selected range into a styled table">${wsIco('workspace', '&#x1F5C2;')}</button>
          </div>
          <div class="ws-ribbon-label">Cells</div>
        </div>

        <!-- Data group — validation, filter, comments, hyperlinks,
             named ranges (Phase 2 Excel-parity tools). -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-btn-icon" id="wsDataValidationBtn" onclick="window.wsOpenDataValidation()" title="Data validation (dropdown list / rules)">${wsIco('check-circle', '&#x2714;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsAutoFilterBtn" onclick="window.wsToggleAutoFilter()" title="Toggle AutoFilter on the selected header row">${wsIco('funnel', '&#x1F53D;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsCommentBtn" onclick="window.wsOpenComment()" title="Insert / edit cell comment (Shift+F2)">${wsIco('conversations', '&#x1F4AC;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsHyperlinkBtn" onclick="window.wsOpenHyperlink()" title="Insert hyperlink (Ctrl+K)">${wsIco('link', '&#x1F517;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsNamedRangeBtn" onclick="window.wsOpenNamedRanges()" title="Define / manage named ranges">${wsIco('tag', '&#x1F3F7;')}</button>
          </div>
          <div class="ws-ribbon-label">Data</div>
        </div>

        <!-- Spacer pushes the Editing group to the far right of the
             ribbon so Σ / sort / find / freeze cluster against the
             right edge — matches the Outlook ribbon layout where
             secondary controls sit on the right. -->
        <div class="ws-toolbar-spacer"></div>

        <!-- Editing -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-btn-txt" id="wsAutoSumBtn" onclick="window.wsAutoSum()" title="AutoSum (Σ) — insert =SUM with auto-detected range">&#x03A3;</button>
            <button class="ws-btn ws-btn-icon" id="wsSortAscBtn" onclick="window.wsSortAscHeader()" title="Sort range ascending">${wsIco('sort-asc', '&#x2191;A')}</button>
            <button class="ws-btn ws-btn-icon" id="wsSortDescBtn" onclick="window.wsSortDescHeader()" title="Sort range descending">${wsIco('sort-desc', '&#x2193;Z')}</button>
            <button class="ws-btn ws-btn-icon" id="wsClearContentsBtn" onclick="window.wsClearContents()" title="Clear contents (Delete)">${wsIco('backspace', '&#x232B;')}</button>
            <button class="ws-btn ws-btn-icon" id="wsFindBtn" onclick="window.wsOpenFindReplace()" title="Find &amp; Replace (Ctrl+F)">${wsIco('magnifying-glass', '&#x1F50D;')}</button>
            <select id="wsFreezeSelect" class="ws-select-compact" onchange="window.wsSetFreeze(this.value || null); this.value='';" title="Freeze panes">
              <option value="">&#x2744;</option>
              <option value="row">Top row</option>
              <option value="col">First column</option>
              <option value="both">Top row + first column</option>
              <option value="">No freeze</option>
            </select>
          </div>
          <div class="ws-ribbon-label">Editing</div>
        </div>

        <!-- File group + Node Graph button removed. Import / Clear /
             Save now live in the floating panel header (Quick Access
             Toolbar pattern); Node Graph stays accessible from the
             WIP page sidebar. -->
      </div>
      <div class="ws-link-panel" id="wsLinkPanel">
        <div class="ws-link-header">
          <div class="ws-link-title">Link <span id="wsLinkCell">A1</span> → Job Field</div>
          <div class="ws-link-active" id="wsLinkActive"></div>
          <button class="ws-btn ws-btn-unlink" id="wsUnlinkBtn" style="display:none;">&#x1F517; Unlink</button>
        </div>
        <div class="ws-link-options" id="wsLinkOptions"></div>
      </div>
      <!-- Inner workbook tabs — appears only when the active sheet
           belongs to a multi-sheet xlsx import. Lists the workbook's
           sheets in their original order so the user can navigate
           between them without leaving the imported workbook. -->
      <div class="ws-workbook-inner-tabs" id="wsWorkbookInnerTabs" style="display:none;"></div>
      <div class="ws-grid-wrapper" id="wsGridWrapper">
        <table class="ws-grid" id="wsGrid"></table>
      </div>
      <div class="ws-sheet-tabs" id="wsSheetTabs"></div>
      <div class="ws-statusbar">
        <span id="wsStatus">Ready</span>
        <span id="wsQuickCalc"></span>
        <span class="ws-statusbar-actions">
          <button class="ws-btn ws-btn-add" id="wsAddRow" title="Add row">+ Row</button>
          <button class="ws-btn ws-btn-add" id="wsAddCol" title="Add column">+ Col</button>
        </span>
      </div>
    `;
  }

  // ── Sheet tab strip ────────────────────────────────────────
  // Excel-style tabs at the bottom of the workspace. Click to switch,
  // double-click to rename, right-click for the contextual menu.
  // The "+" appends a fresh sheet.
  function renderSheetTabs() {
    const wrap = document.getElementById('wsSheetTabs');
    if (!wrap) return;
    let html = '<div class="ws-sheet-tabs-list">';

    // Build a map: groupId → the active sheet within that group. When
    // an active sheet belongs to a group, we want the group tab to
    // render as "active" so the user can see which workbook is open.
    var activeSheet = workbook.sheets.find(function(s) { return s.id === workbook.activeSheetId; });
    var activeGroupId = activeSheet ? activeSheet.workbookGroupId : null;

    // Track which group ids we've already rendered so multi-sheet
    // workbook imports collapse to a single tab in the bottom bar.
    var renderedGroups = new Set();

    workbook.sheets.forEach(function(s) {
      // Hidden sheets disappear entirely from the bottom strip —
      // restore via the "Unhide..." action on the inner tabs or the
      // group tab's context menu.
      if (s.hidden && !s.workbookGroupId) return;

      // Imported workbook sheet: render the GROUP tab once, in place
      // of the first sheet in that group. Subsequent sheets of the
      // same group skip — they'll appear in the inner strip instead.
      if (s.workbookGroupId) {
        if (renderedGroups.has(s.workbookGroupId)) return;
        renderedGroups.add(s.workbookGroupId);
        var isActiveGroup = (s.workbookGroupId === activeGroupId);
        // Sheet count in the group — visible-only so the badge
        // matches what shows in the inner strip.
        var visibleSize = workbook.sheets.reduce(function(acc, x) {
          return acc + (x.workbookGroupId === s.workbookGroupId && !x.hidden ? 1 : 0);
        }, 0);
        // If every sheet in the group is hidden, hide the group tab too.
        if (visibleSize === 0) return;
        html += '<div class="ws-sheet-tab ws-workbook-tab' + (isActiveGroup ? ' active' : '') +
          '" data-workbook-group="' + s.workbookGroupId +
          '" title="' + escapeAttr(s.workbookGroupName || 'Workbook') + '">' +
          '<span class="ws-sheet-tab-icon" aria-hidden="true">' + wsIco('workspace', '&#x1F4D2;') + '</span> ' +
          '<span class="ws-sheet-tab-name">' + escapeHTML(s.workbookGroupName || 'Workbook') + '</span>' +
          '<span class="ws-workbook-tab-count">' + visibleSize + '</span>' +
        '</div>';
        return;
      }

      const active = s.id === workbook.activeSheetId;
      // Pinned built-in views (e.g. Detailed Costs, Attachments) get
      // a marker icon and a different class so the context menu can
      // lock destructive actions and CSS can style them subtly.
      var icon = '';
      var kindCls = '';
      if (s.kind === 'qb-costs') {
        icon = '<span class="ws-sheet-tab-icon" aria-hidden="true">' + wsIco('wip', '&#x1F4CB;') + '</span> ';
        kindCls = ' ws-sheet-tab-qb-costs';
      } else if (s.kind === 'attachments') {
        icon = '<span class="ws-sheet-tab-icon" aria-hidden="true">' + wsIco('attachments', '&#x1F4CE;') + '</span> ';
        kindCls = ' ws-sheet-tab-attachments';
      }
      // Phase 0 — sheets inherited from an estimate at the moment a
      // job was created get a small "📋" chip + a "From estimate"
      // tooltip so the PM can see at a glance which tabs were the
      // estimator's takeoff vs. tabs they built post-conversion.
      // sourceEstimateId/Name are stamped at conversion time (see the
      // estimate→job inheritance hook, follow-up turn).
      var sourceChip = '';
      var tabTitle = s.name;
      if (s.sourceEstimateId) {
        sourceChip = '<span class="ws-sheet-tab-source-chip" aria-hidden="true" style="margin-left:4px;opacity:0.7;font-size:10px;">&#x1F4CB;</span>';
        tabTitle = s.name + ' — From estimate' + (s.sourceEstimateName ? (' ' + s.sourceEstimateName) : '');
      }
      html += '<div class="ws-sheet-tab' + (active ? ' active' : '') +
        (s.pinned ? ' ws-sheet-tab-pinned' : '') + kindCls + '" data-sheet-id="' +
        s.id + '" title="' + escapeAttr(tabTitle) + '">' +
        icon +
        '<span class="ws-sheet-tab-name">' + escapeHTML(s.name) + '</span>' +
        sourceChip +
      '</div>';
    });
    html += '<button class="ws-sheet-tab-add" id="wsAddSheetBtn" title="Add sheet">+</button>';
    html += '</div>';
    wrap.innerHTML = html;

    // Workbook group tabs — click activates the group's last-active
    // sheet (or the first sheet in the group if none has been
    // visited yet). Each workbook tracks lastActiveSheetId so the
    // user returns to where they left off.
    wrap.querySelectorAll('.ws-workbook-tab').forEach(function(tab) {
      var groupId = tab.getAttribute('data-workbook-group');
      tab.addEventListener('click', function() {
        // Already on a sheet in this group? No-op (avoid re-render).
        if (activeGroupId === groupId) return;
        var groupSheets = workbook.sheets.filter(function(s) {
          return s.workbookGroupId === groupId && !s.hidden;
        });
        if (!groupSheets.length) return;
        var lastId = workbook.workbookGroupActive && workbook.workbookGroupActive[groupId];
        var target = lastId && groupSheets.find(function(s) { return s.id === lastId; });
        if (!target || target.hidden) target = groupSheets[0];
        switchSheet(target.id);
      });
      // Right-click on the workbook group tab: bulk operations on the
      // entire imported file (hide/unhide all, delete all). Per-sheet
      // actions live on the inner-tab strip.
      tab.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        var groupSheets = workbook.sheets.filter(function(s) { return s.workbookGroupId === groupId; });
        if (!groupSheets.length) return;
        var groupName = groupSheets[0].workbookGroupName || 'Workbook';
        var hasHidden = groupSheets.some(function(s) { return s.hidden; });
        var items = [
          { label: 'Open', action: function() {
            var visible = groupSheets.filter(function(s) { return !s.hidden; });
            if (visible.length) switchSheet(visible[0].id);
          } }
        ];
        if (hasHidden) {
          items.push({ label: 'Unhide sheet…', action: function() {
            showUnhideMenu(e.clientX, e.clientY, groupId);
          } });
        }
        items.push('---');
        items.push({ label: 'Delete entire workbook (' + groupSheets.length + ' sheets)', action: async function() {
          if (!(await p86Ask('Delete the entire "' + groupName + '" workbook? All ' + groupSheets.length + ' sheets will be removed. This cannot be undone.'))) return;
          // Remove sheets in reverse so splice indices stay valid.
          var ids = groupSheets.map(function(s) { return s.id; });
          ids.forEach(function(id) {
            var idx = workbook.sheets.findIndex(function(s) { return s.id === id; });
            if (idx !== -1) workbook.sheets.splice(idx, 1);
          });
          // If active sheet was in this group, fall back.
          if (!workbook.sheets.find(function(s) { return s.id === workbook.activeSheetId; })) {
            var fallback = workbook.sheets.find(function(s) { return !s.pinned && !s.hidden; })
              || workbook.sheets.find(function(s) { return !s.hidden; });
            if (fallback) {
              workbook.activeSheetId = fallback.id;
              loadSheetIntoGrid(fallback);
              recalcAll();
              renderActiveSheet();
              selectCell(0, 0);
            }
          }
          workbook.dirty = true;
          renderSheetTabs();
          saveWorkspace();
        } });
        showContextMenu(e.clientX, e.clientY, items);
      });
    });

    // Render the inner-tab strip whenever the active sheet belongs
    // to a workbook group. Hidden otherwise.
    renderWorkbookInnerTabs();
    // Wire interactions
    wrap.querySelectorAll('.ws-sheet-tab').forEach(function(tab) {
      const id = tab.dataset.sheetId;
      const sheet = workbook.sheets.find(s => s.id === id);
      const pinned = !!(sheet && sheet.pinned);
      tab.addEventListener('click', function() { switchSheet(id); });
      tab.addEventListener('dblclick', function() {
        if (pinned) return;
        const s = workbook.sheets.find(x => x.id === id);
        if (!s) return;
        const newName = prompt('Rename sheet:', s.name);
        if (newName != null) renameSheet(id, newName);
      });
      tab.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        if (pinned) {
          // Built-in views — only the navigation actions make sense.
          showContextMenu(e.clientX, e.clientY, [
            { label: 'Move Left',  action: function() { moveSheet(id, 'left'); } },
            { label: 'Move Right', action: function() { moveSheet(id, 'right'); } }
          ]);
          return;
        }
        var hasHiddenAny = workbook.sheets.some(function(x) { return x.hidden; });
        const items = [
          { label: 'Rename', action: function() {
            const s = workbook.sheets.find(x => x.id === id);
            if (!s) return;
            const newName = prompt('Rename sheet:', s.name);
            if (newName != null) renameSheet(id, newName);
          } },
          { label: 'Duplicate', action: function() { duplicateSheet(id); } },
          '---',
          { label: 'Move Left',  action: function() { moveSheet(id, 'left'); } },
          { label: 'Move Right', action: function() { moveSheet(id, 'right'); } },
          '---',
          { label: 'Hide', action: function() { hideSheet(id); } }
        ];
        if (hasHiddenAny) {
          items.push({ label: 'Unhide sheet…', action: function() {
            showUnhideMenu(e.clientX, e.clientY, null);
          } });
        }
        items.push('---');
        items.push({ label: 'Delete', action: function() { deleteSheet(id); } });
        showContextMenu(e.clientX, e.clientY, items);
      });
    });
    const addBtn = wrap.querySelector('#wsAddSheetBtn');
    if (addBtn) addBtn.addEventListener('click', function() { addSheet(); });
  }

  // Renders the secondary tab strip that appears above the grid when
  // the active sheet belongs to a multi-sheet xlsx import. Lists every
  // sheet in the same workbookGroupId so the user can flip between
  // them without losing the workbook context. Hidden when active sheet
  // is standalone.
  function renderWorkbookInnerTabs() {
    var strip = document.getElementById('wsWorkbookInnerTabs');
    if (!strip) return;
    var active = workbook.sheets.find(function(s) { return s.id === workbook.activeSheetId; });
    if (!active || !active.workbookGroupId) {
      strip.style.display = 'none';
      strip.innerHTML = '';
      return;
    }
    var groupId = active.workbookGroupId;
    var allSiblings = workbook.sheets.filter(function(s) { return s.workbookGroupId === groupId; });
    var siblings = allSiblings.filter(function(s) { return !s.hidden; });
    var hiddenCount = allSiblings.length - siblings.length;
    if (!siblings.length) {
      strip.style.display = 'none';
      return;
    }
    // Remember which sheet was last active in this group so the
    // outer workbook tab returns the user to the same place when
    // they leave + come back.
    if (!workbook.workbookGroupActive) workbook.workbookGroupActive = {};
    workbook.workbookGroupActive[groupId] = active.id;

    var html = '<div class="ws-workbook-inner-tabs-list">';
    html += '<span class="ws-workbook-inner-tabs-label" title="' +
      escapeAttr(active.workbookGroupName || 'Workbook') + '">&#x1F4D2; ' +
      escapeHTML(active.workbookGroupName || 'Workbook') + '</span>';
    siblings.forEach(function(s) {
      var on = (s.id === active.id);
      html += '<div class="ws-workbook-inner-tab' + (on ? ' active' : '') +
        '" data-sheet-id="' + s.id + '" title="' + escapeAttr(s.name) + '">' +
        escapeHTML(s.name) +
      '</div>';
    });
    if (hiddenCount > 0) {
      html += '<div class="ws-workbook-inner-tab ws-workbook-inner-tab-unhide" data-unhide-group="' + groupId +
        '" title="Show hidden sheets in this workbook">' +
        '&#x1F441; ' + hiddenCount + ' hidden' +
      '</div>';
    }
    html += '</div>';
    strip.innerHTML = html;
    strip.style.display = '';

    strip.querySelectorAll('.ws-workbook-inner-tab').forEach(function(tab) {
      var id = tab.getAttribute('data-sheet-id');
      var unhideGroup = tab.getAttribute('data-unhide-group');
      if (unhideGroup) {
        tab.addEventListener('click', function(e) {
          showUnhideMenu(e.clientX, e.clientY, unhideGroup);
        });
        return;
      }
      tab.addEventListener('click', function() { switchSheet(id); });
      // Right-click on an inner sheet tab: per-sheet operations
      // (rename / hide / delete) — Excel-style.
      tab.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        var s = workbook.sheets.find(function(x) { return x.id === id; });
        if (!s) return;
        var hasHiddenInGroup = workbook.sheets.some(function(x) {
          return x.workbookGroupId === groupId && x.hidden;
        });
        var items = [
          { label: 'Rename', action: function() {
            var sh = workbook.sheets.find(function(x) { return x.id === id; });
            if (!sh) return;
            var newName = prompt('Rename sheet:', sh.name);
            if (newName != null) renameSheet(id, newName);
          } },
          { label: 'Duplicate', action: function() { duplicateSheet(id); } },
          '---',
          { label: 'Hide', action: function() { hideSheet(id); } }
        ];
        if (hasHiddenInGroup) {
          items.push({ label: 'Unhide sheet…', action: function() {
            showUnhideMenu(e.clientX, e.clientY, groupId);
          } });
        }
        items.push('---');
        items.push({ label: 'Delete', action: function() { deleteSheet(id); } });
        showContextMenu(e.clientX, e.clientY, items);
      });
    });
  }

  // Light HTML escapers for sheet names. The tab text is user-typed so
  // we want to be careful, but the rest of workspace.js doesn't already
  // import these — quick local copies.
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHTML(s).replace(/"/g, '&quot;');
  }

  /** Build inline style string from cell.style */
  function buildCellStyle(cell, w) {
    var st = 'width:' + w + 'px;min-width:' + w + 'px;';
    var s = cell.style || {};
    if (s.bg) st += 'background:' + s.bg + ';';
    if (s.color) st += 'color:' + s.color + ';';
    if (s.bold) st += 'font-weight:700;';
    if (s.italic) st += 'font-style:italic;';
    // Combined text-decoration so underline + strikethrough can stack
    // on one cell (e.g., "ordered + cancelled" in a takeoff).
    var deco = [];
    if (s.underline) deco.push('underline');
    if (s.strikethrough) deco.push('line-through');
    if (deco.length) st += 'text-decoration:' + deco.join(' ') + ';';
    if (s.align) st += 'text-align:' + s.align + ';';
    if (s.wrap) st += 'white-space:normal;word-wrap:break-word;';
    // Imported xlsx cells carry an explicit pt → px font size; only
    // apply when set so the workspace's default sizing wins for
    // hand-typed cells.
    if (typeof s.fontSize === 'number' && s.fontSize > 0) {
      st += 'font-size:' + s.fontSize + 'px;';
    }
    // Font family + vertical alignment from the server xlsx import
    // (S3). Quotes/angle brackets stripped so a hostile font name in a
    // vendor file can't break out of the style attribute.
    if (s.fontFamily) {
      st += "font-family:'" + String(s.fontFamily).replace(/['"<>;]/g, '') + "';";
    }
    if (s.valign === 'top' || s.valign === 'middle' || s.valign === 'bottom') {
      st += 'vertical-align:' + s.valign + ';';
    }
    // Per-side borders from xlsx import. Each side overrides the
    // default grid border on that edge only — keeps the cell looking
    // like the source spreadsheet (heavy section dividers, thin row
    // separators, etc.). Inline style wins over the .ws-cell class
    // border by specificity.
    if (s.borders) {
      ['top', 'right', 'bottom', 'left'].forEach(function(side) {
        var b = s.borders[side];
        if (b) {
          st += 'border-' + side + ':' + b.width + 'px ' + b.style + ' ' + b.color + ';';
        }
      });
    }
    return st;
  }

  function renderGrid() {
    if (!wsTable) return;
    // Embedded sheets (Detailed Costs etc.) are rendered separately —
    // bail out so any incidental renderGrid call from edit/save paths
    // doesn't repaint the hidden grid table.
    if (isEmbedSheet(activeSheet())) return;

    var hidden = buildHiddenSet();
    var filterHiddenRows = computeFilterHiddenRows();
    var af = getAutoFilter();

    let html = '<thead><tr><th class="ws-corner"></th>';
    for (let c = 0; c < grid.cols; c++) {
      const w = grid.colWidths[c] || COL_DEFAULT_WIDTH;
      html += `<th class="ws-col-header" data-col="${c}" style="width:${w}px;min-width:${w}px;">${colLetter(c)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 0; r < grid.rows; r++) {
      const rh = grid.rowHeights && grid.rowHeights[r];
      let trStyleInner = rh ? `height:${rh}px;` : '';
      if (filterHiddenRows[r]) trStyleInner += 'display:none;';
      const trStyle = trStyleInner ? ` style="${trStyleInner}"` : '';
      // Row header carries data-row so the resize-handle hit test below
      // knows which row it's on. Resize handle is the bottom-edge strip.
      html += `<tr${trStyle}><td class="ws-row-header" data-row="${r}">${r + 1}<div class="ws-row-resize" data-row="${r}"></div></td>`;
      for (let c = 0; c < grid.cols; c++) {
        // Skip hidden merged cells
        if (hidden[r + ',' + c]) continue;

        const key = addr(r, c);
        const cell = grid.cells[key] || { raw: '', value: '', fmt: null, style: {} };
        const val = cellInnerHTML(cell);
        const isSelected = grid.selection && grid.selection.r === r && grid.selection.c === c;
        const isRangeSelected = !isSelected && inRange(r, c);
        const rng = getSelRange();
        const isLinked = grid.links[key];
        const isError = cell.error;
        const isFormula = typeof cell.raw === 'string' && cell.raw.startsWith('=');
        const tableStyle = getTableStyleForCell(r, c);

        let cls = 'ws-cell';
        if (isSelected) cls += ' ws-selected';
        if (isRangeSelected) cls += ' ws-range-selected';
        if (rng && (isSelected || isRangeSelected)) {
          if (r === rng.r1) cls += ' ws-range-top';
          if (r === rng.r2) cls += ' ws-range-bottom';
          if (c === rng.c1) cls += ' ws-range-left';
          if (c === rng.c2) cls += ' ws-range-right';
        }
        if (isLinked) cls += ' ws-linked';
        if (isError) cls += ' ws-error';
        if (isFormula) cls += ' ws-formula';
        if (tableStyle) cls += ' ws-table-cell ws-table-' + tableStyle.style + ' ws-table-' + tableStyle.role;
        if (typeof cell.value === 'number' && !(cell.style && cell.style.align)) cls += ' ws-number';
        if (cell.note) cls += ' ws-has-note';
        if (cell.validation && cell.validation.type === 'list') cls += ' ws-has-validation';
        if (cell.validation && cell.validation._invalid) cls += ' ws-validation-invalid';

        // Merge attributes
        var span = getMergeSpan(r, c);
        var mergeW = grid.colWidths[c] || COL_DEFAULT_WIDTH;
        if (span) {
          cls += ' ws-merged';
          // Sum widths for merged columns
          mergeW = 0;
          for (var mc = c; mc < c + span.colspan; mc++) mergeW += (grid.colWidths[mc] || COL_DEFAULT_WIDTH);
        }

        var st = buildCellStyle(cell, mergeW);
        var attrs = span ? ` colspan="${span.colspan}" rowspan="${span.rowspan}"` : '';
        var titleParts = [];
        if (cell.note) titleParts.push(cell.note);
        var linkObj = grid.links[key];
        if (linkObj && linkObj.field) titleParts.push('\u{1F517} ' + getLinkLabel(linkObj));
        var titleAttr = titleParts.length ? ' title="' + titleParts.join('\n').replace(/"/g, '&amp;quot;') + '"' : '';

        // AutoFilter dropdown button on the header-row cells in range.
        var filterBtn = '';
        if (af && r === af.r1 && c >= af.c1 && c <= af.c2) {
          var isFiltered = af.filters && af.filters[c];
          cls += ' ws-filter-header' + (isFiltered ? ' ws-filter-active' : '');
          filterBtn = '<span class="ws-filter-btn" data-ws-filter="1" title="Filter / sort this column">' +
                      (isFiltered ? '&#x1F53D;' : '&#x25BE;') + '</span>';
        }

        html += `<td class="${cls}" data-r="${r}" data-c="${c}" style="${st}"${attrs}${titleAttr}>${val}${filterBtn}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    wsTable.innerHTML = html;
  }

  function refreshCell(r, c) {
    const td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (!td) return;
    const key = addr(r, c);
    const cell = grid.cells[key] || { raw: '', value: '', fmt: null, style: {} };
    td.innerHTML = cellInnerHTML(cell);

    td.className = 'ws-cell';
    if (grid.selection && grid.selection.r === r && grid.selection.c === c) td.classList.add('ws-selected');
    if (grid.links[key]) td.classList.add('ws-linked');
    if (cell.error) td.classList.add('ws-error');
    if (typeof cell.raw === 'string' && cell.raw.startsWith('=')) td.classList.add('ws-formula');
    if (typeof cell.value === 'number' && !(cell.style && cell.style.align)) td.classList.add('ws-number');
    if (cell.note) td.classList.add('ws-has-note');
    if (cell.validation && cell.validation.type === 'list') td.classList.add('ws-has-validation');
    if (cell.validation && cell.validation._invalid) td.classList.add('ws-validation-invalid');
    if (getMergeSpan(r, c)) td.classList.add('ws-merged');
    var titleParts = [];
    if (cell.note) titleParts.push(cell.note);
    var linkObj = grid.links[key];
    if (linkObj && linkObj.field) titleParts.push('\u{1F517} ' + getLinkLabel(linkObj));
    td.title = titleParts.join('\n');

    // Apply inline styles
    var w = grid.colWidths[c] || COL_DEFAULT_WIDTH;
    var span = getMergeSpan(r, c);
    if (span) { w = 0; for (var mc = c; mc < c + span.colspan; mc++) w += (grid.colWidths[mc] || COL_DEFAULT_WIDTH); }
    td.setAttribute('style', buildCellStyle(cell, w));
  }

  // ── Color Palette Helpers ──────────────────────────────────

  function buildColorGrid(containerId, callback, noFillLabel) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    // "No Fill" / "No Color" button
    var noFill = document.createElement('div');
    noFill.className = 'ws-palette-nofill';
    noFill.textContent = noFillLabel || 'No Fill';
    noFill.addEventListener('click', function () { callback(null); });
    container.appendChild(noFill);
    // Color swatches
    COLOR_PALETTE.forEach(function (c) {
      var swatch = document.createElement('div');
      swatch.className = 'ws-palette-swatch';
      swatch.style.background = c;
      if (c === '#ffffff') swatch.style.border = '1px solid var(--border)';
      swatch.title = c;
      swatch.addEventListener('click', function () { callback(c); });
      container.appendChild(swatch);
    });
  }

  function buildRecentColors(containerId, recentArr, callback) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (recentArr.length === 0) {
      container.innerHTML = '<span style="font-size:9px;color:var(--text-dim);">None yet</span>';
      return;
    }
    recentArr.forEach(function (c) {
      var swatch = document.createElement('div');
      swatch.className = 'ws-palette-swatch';
      swatch.style.background = c;
      swatch.title = c;
      swatch.addEventListener('click', function () { callback(c); });
      container.appendChild(swatch);
    });
  }

  function addRecentColor(arr, color) {
    var idx = arr.indexOf(color);
    if (idx > -1) arr.splice(idx, 1);
    arr.unshift(color);
    if (arr.length > 3) arr.length = 3;
  }

  function buildStylePanel() {
    var panel = document.getElementById('wsStylePanel');
    if (!panel) return;
    panel.innerHTML = '';
    CELL_STYLES.forEach(function (preset) {
      var btn = document.createElement('div');
      btn.className = 'ws-style-preset';
      var s = preset.style;
      btn.style.background = s.bg || 'var(--cell-bg)';
      btn.style.color = s.color || 'var(--text)';
      if (s.bold) btn.style.fontWeight = '700';
      if (s.italic) btn.style.fontStyle = 'italic';
      if (s.align) btn.style.textAlign = s.align;
      btn.textContent = preset.name;
      btn.addEventListener('click', function () {
        applyStylePreset(preset.style);
        closeColorPanels();
      });
      panel.appendChild(btn);
    });
  }

  function applyStylePreset(presetStyle) {
    pushUndo();
    var rng = getSelRange();
    if (!rng) return;
    for (var r = rng.r1; r <= rng.r2; r++)
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        cell.style = JSON.parse(JSON.stringify(presetStyle));
      }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  }

  function closeColorPanels() {
    document.querySelectorAll('.ws-color-panel').forEach(function (p) { p.style.display = 'none'; });
  }

  function toggleColorPanel(panelId) {
    var panel = document.getElementById(panelId);
    if (!panel) return;
    var isOpen = panel.style.display === 'block';
    closeColorPanels();
    if (!isOpen) panel.style.display = 'block';
  }

  // ── Style Helpers ──────────────────────────────────────────

  /** Apply a style property to all cells in selection */
  function applyStyleToSelection(prop, value) {
    pushUndo();
    var rng = getSelRange();
    if (!rng) return;
    for (var r = rng.r1; r <= rng.r2; r++) {
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        if (!cell.style) cell.style = {};
        if (value === null || value === undefined || value === false) {
          delete cell.style[prop];
        } else {
          cell.style[prop] = value;
        }
      }
    }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  }

  /** Toggle a boolean style property on the selection */
  function toggleStyleOnSelection(prop) {
    var rng = getSelRange();
    if (!rng) return;
    // Check if ALL cells have the property set
    var allSet = true;
    for (var r = rng.r1; r <= rng.r2 && allSet; r++)
      for (var c = rng.c1; c <= rng.c2 && allSet; c++) {
        var cell = getCell(r, c);
        if (!cell.style || !cell.style[prop]) allSet = false;
      }
    applyStyleToSelection(prop, allSet ? false : true);
  }

  /** Clear all formatting from selection */
  function clearFormattingOnSelection() {
    pushUndo();
    var rng = getSelRange();
    if (!rng) return;
    for (var r = rng.r1; r <= rng.r2; r++)
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        cell.style = {};
        cell.fmt = null;
      }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  }

  /** Update formatting toolbar button states to reflect current selection */
  function updateFmtToolbar() {
    if (!grid.selection) return;
    var cell = getCell(grid.selection.r, grid.selection.c);
    var s = cell.style || {};

    // Toggle buttons
    var boldBtn = document.getElementById('wsBoldBtn');
    var italicBtn = document.getElementById('wsItalicBtn');
    var underlineBtn = document.getElementById('wsUnderlineBtn');
    var wrapBtn = document.getElementById('wsWrapBtn');
    if (boldBtn) boldBtn.classList.toggle('ws-active', !!s.bold);
    if (italicBtn) italicBtn.classList.toggle('ws-active', !!s.italic);
    if (underlineBtn) underlineBtn.classList.toggle('ws-active', !!s.underline);
    if (wrapBtn) wrapBtn.classList.toggle('ws-active', !!s.wrap);

    // Alignment buttons
    var alignBtns = document.querySelectorAll('.ws-fmt-align');
    alignBtns.forEach(function (btn) {
      btn.classList.toggle('ws-active', s.align === btn.dataset.align);
    });

    // Color swatches
    var fillSwatch = document.getElementById('wsFillSwatch');
    var fontSwatch = document.getElementById('wsFontSwatch');
    if (fillSwatch) fillSwatch.style.background = s.bg || '#1a1a20';
    if (fontSwatch) fontSwatch.style.background = s.color || '#e4e6f0';

    // Merge/unmerge button states
    var mergeBtn = document.getElementById('wsMergeBtn');
    var unmergeBtn = document.getElementById('wsUnmergeBtn');
    var hasMerge = getMerge(grid.selection.r, grid.selection.c);
    if (mergeBtn) mergeBtn.classList.toggle('ws-active', !!hasMerge);
    if (unmergeBtn) unmergeBtn.style.opacity = hasMerge ? '1' : '0.4';
  }

  // ── Selection & Editing ────────────────────────────────────

  function selectCell(r, c, keepRange) {
    // Redirect to merge origin if selecting a hidden merged cell
    var merge = getMerge(r, c);
    if (merge && (r !== merge.r1 || c !== merge.c1)) { r = merge.r1; c = merge.c1; }

    grid.selection = { r, c };
    if (!keepRange) grid.selEnd = null;

    renderSelectionClasses();

    // Update cell ref and formula bar
    const key = addr(r, c);
    if (formulaBar && !grid.refMode) formulaBar.value = getCell(r, c).raw || '';
    const refEl = document.getElementById('wsCellRef');
    if (refEl && document.activeElement !== refEl) {
      var rng = getSelRange();
      // If the selection's anchor cell matches a named range exactly,
      // show the name instead of the raw address (Excel behavior).
      var nameForCell = _nameForCurrentSelection(rng);
      if (nameForCell) {
        refEl.value = nameForCell;
      } else if (grid.selEnd && (rng.r1 !== rng.r2 || rng.c1 !== rng.c2)) {
        refEl.value = addr(rng.r1, rng.c1) + ':' + addr(rng.r2, rng.c2);
      } else {
        refEl.value = key;
      }
    }

    // Update link panel display
    updateLinkPanel(key);

    // Update quick calc
    updateQuickCalc();

    // Update formatting toolbar state
    updateFmtToolbar();
  }

  function startEditing(r, c) {
    grid.editing = { r, c };
    const td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (!td) return;

    const cell = getCell(r, c);
    td.classList.add('ws-editing');
    td.contentEditable = true;
    td.textContent = cell.raw || '';
    td.focus();

    // Check if we're entering a formula
    if (cell.raw && cell.raw.startsWith('=')) {
      enterRefMode('cell');
    }

    // Place cursor at end
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(td);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function commitEdit(r, c) {
    const td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (!td) return;

    const raw = td.textContent.trim();
    const cell = getCell(r, c);
    pushUndo();
    cell.raw = raw;
    delete cell.importedValue; // user edit — stop falling back to the imported cache

    td.contentEditable = false;
    td.classList.remove('ws-editing');
    grid.editing = null;
    exitRefMode();
    grid.dirty = true;

    // Recalculate
    recalcAll();

    // Re-validate against any data-validation rule on this cell.
    refreshCellValidity(r, c);

    // Re-render all cells (formulas may reference this cell)
    renderGrid();
    selectCell(r, c);

    // Push linked values
    pushLinkedValues();

    // Refresh job detail view and header metrics
    if (typeof renderJobDetail === 'function' && typeof appState !== 'undefined' && appState.currentJobId) {
      renderJobDetail(appState.currentJobId);
    }

    // Auto-expand if at edge
    autoExpand(r, c);

    // Auto-save
    saveWorkspace();
  }

  function cancelEdit() {
    if (!grid.editing) return;
    const { r, c } = grid.editing;
    const td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (td) {
      td.contentEditable = false;
      td.classList.remove('ws-editing');
      const cell = getCell(r, c);
      td.innerHTML = cellInnerHTML(cell);
    }
    grid.editing = null;
    exitRefMode();
  }

  /** Auto-expand grid when user types near the edge */
  function autoExpand(r, c) {
    let expanded = false;
    if (r >= grid.rows - 1) {
      grid.rows += EXPAND_BUFFER;
      expanded = true;
    }
    if (c >= grid.cols - 1) {
      grid.cols += EXPAND_BUFFER;
      expanded = true;
    }
    if (expanded) renderGrid();
  }

  // ── Link Panel ─────────────────────────────────────────────

  function updateLinkPanel(cellAddr) {
    var panel = document.getElementById('wsLinkPanel');
    var cellLabel = document.getElementById('wsLinkCell');
    var activeEl = document.getElementById('wsLinkActive');
    var unlinkBtn = document.getElementById('wsUnlinkBtn');
    if (!panel) return;

    if (cellLabel) cellLabel.textContent = cellAddr;

    var currentLink = grid.links[cellAddr];
    if (currentLink && currentLink.field) {
      var label = getLinkLabel(currentLink);
      if (activeEl) {
        activeEl.innerHTML = '<span class="ws-link-badge">\u2192 ' + label + '</span>';
        activeEl.style.display = 'inline-flex';
      }
      if (unlinkBtn) unlinkBtn.style.display = 'inline-flex';
    } else {
      if (activeEl) activeEl.style.display = 'none';
      if (unlinkBtn) unlinkBtn.style.display = 'none';
    }
  }

  function renderFieldButtons(fields, cellAddr, level, targetId) {
    var html = '';
    fields.forEach(function (f) {
      var linkObj = grid.links[cellAddr];
      var isActive = linkObj && linkObj.field === f.key && linkObj.level === level && (level === 'job' || linkObj.targetId === targetId);
      html += '<button class="ws-link-opt ' + (isActive ? 'active' : '') + '" data-field="' + f.key + '" data-level="' + level + '"' +
        (targetId ? ' data-target="' + targetId + '"' : '') + '>' + f.label + '</button>';
    });
    return html;
  }

  function showLinkPanel() {
    var panel = document.getElementById('wsLinkPanel');
    var optionsEl = document.getElementById('wsLinkOptions');
    if (!panel || !grid.selection) return;

    panel.classList.add('ws-link-panel-open');
    var cellAddr = addr(grid.selection.r, grid.selection.c);
    var html = '';

    // Job-level fields (always visible)
    html += '<div class="ws-link-group">';
    html += '<div class="ws-link-group-header">Job Level</div>';
    html += renderFieldButtons(JOB_FIELDS, cellAddr, 'job', null);
    html += '</div>';

    if (typeof appData !== 'undefined') {
      // Buildings
      var buildings = appData.buildings.filter(function (b) { return b.jobId === grid.jobId; });
      if (buildings.length > 0) {
        html += '<details class="ws-link-level"><summary class="ws-link-level-header">Buildings</summary>';
        buildings.forEach(function (b) {
          html += '<details class="ws-link-target"><summary class="ws-link-target-header">' + (b.name || 'Unnamed') + '</summary>';
          html += '<div class="ws-link-target-fields">' + renderFieldButtons(BUILDING_FIELDS, cellAddr, 'building', b.id) + '</div>';
          html += '</details>';
        });
        html += '</details>';
      }

      // Phases (grouped by building)
      var phases = appData.phases.filter(function (p) { return p.jobId === grid.jobId; });
      if (phases.length > 0) {
        html += '<details class="ws-link-level"><summary class="ws-link-level-header">Phases</summary>';
        var phasesByBldg = {};
        phases.forEach(function (p) {
          var bldg = appData.buildings.find(function (b) { return b.id === p.buildingId; });
          var bName = bldg ? bldg.name : 'Unassigned';
          if (!phasesByBldg[bName]) phasesByBldg[bName] = [];
          phasesByBldg[bName].push(p);
        });
        Object.keys(phasesByBldg).forEach(function (bName) {
          phasesByBldg[bName].forEach(function (p) {
            html += '<details class="ws-link-target"><summary class="ws-link-target-header">' + bName + ' \u203A ' + (p.phase || '?') + '</summary>';
            html += '<div class="ws-link-target-fields">' + renderFieldButtons(PHASE_FIELDS, cellAddr, 'phase', p.id) + '</div>';
            html += '</details>';
          });
        });
        html += '</details>';
      }

      // Subcontractors
      var subs = appData.subs.filter(function (s) { return s.jobId === grid.jobId; });
      if (subs.length > 0) {
        html += '<details class="ws-link-level"><summary class="ws-link-level-header">Subcontractors</summary>';
        subs.forEach(function (s) {
          html += '<details class="ws-link-target"><summary class="ws-link-target-header">' + (s.name || 'Unnamed') + ' (' + (s.trade || '') + ')</summary>';
          html += '<div class="ws-link-target-fields">' + renderFieldButtons(SUB_FIELDS, cellAddr, 'sub', s.id) + '</div>';
          html += '</details>';
        });
        html += '</details>';
      }

      // Change Orders
      var cos = appData.changeOrders.filter(function (c) { return c.jobId === grid.jobId; });
      if (cos.length > 0) {
        html += '<details class="ws-link-level"><summary class="ws-link-level-header">Change Orders</summary>';
        cos.forEach(function (c) {
          html += '<details class="ws-link-target"><summary class="ws-link-target-header">' + (c.coNumber || '') + ' \u2014 ' + (c.description || '') + '</summary>';
          html += '<div class="ws-link-target-fields">' + renderFieldButtons(CO_FIELDS, cellAddr, 'co', c.id) + '</div>';
          html += '</details>';
        });
        html += '</details>';
      }

      // Purchase Orders
      var pos = appData.purchaseOrders.filter(function (p) { return p.jobId === grid.jobId; });
      if (pos.length > 0) {
        html += '<details class="ws-link-level"><summary class="ws-link-level-header">Purchase Orders</summary>';
        pos.forEach(function (p) {
          html += '<details class="ws-link-target"><summary class="ws-link-target-header">' + (p.poNumber || '') + ' \u2014 ' + (p.vendor || '') + '</summary>';
          html += '<div class="ws-link-target-fields">' + renderFieldButtons(PO_FIELDS, cellAddr, 'po', p.id) + '</div>';
          html += '</details>';
        });
        html += '</details>';
      }

      // Invoices
      var invs = appData.invoices.filter(function (i) { return i.jobId === grid.jobId; });
      if (invs.length > 0) {
        html += '<details class="ws-link-level"><summary class="ws-link-level-header">Invoices</summary>';
        invs.forEach(function (i) {
          html += '<details class="ws-link-target"><summary class="ws-link-target-header">' + (i.invNumber || '') + ' \u2014 ' + (i.vendor || '') + '</summary>';
          html += '<div class="ws-link-target-fields">' + renderFieldButtons(INV_FIELDS, cellAddr, 'inv', i.id) + '</div>';
          html += '</details>';
        });
        html += '</details>';
      }
    }

    if (optionsEl) optionsEl.innerHTML = html;
    updateLinkPanel(cellAddr);
  }

  function setLink(cellAddr, linkObj) {
    var fieldDef = findFieldDef(linkObj);
    grid.links[cellAddr] = linkObj;
    var parsed = parseAddr(cellAddr);
    if (parsed) {
      var cell = getCell(parsed.r, parsed.c);
      if (fieldDef) cell.fmt = fieldDef.fmt;
    }

    grid.dirty = true;
    saveWorkspace();
    recalcAll();
    renderGrid();
    selectCell(grid.selection.r, grid.selection.c);
    pushLinkedValues();
    // Refresh the job detail view and header metrics
    if (typeof renderJobDetail === 'function' && typeof appState !== 'undefined' && appState.currentJobId) {
      renderJobDetail(appState.currentJobId);
    }
  }

  function unlinkCell(cellAddr) {
    delete grid.links[cellAddr];
    grid.dirty = true;
    saveWorkspace();
    // Recalculate — the unlinked field needs to be re-summed from remaining links
    pushLinkedValues();
    updateLinkPanel(cellAddr);
    renderGrid();
    selectCell(grid.selection.r, grid.selection.c);
    // Refresh the job detail view and header metrics
    if (typeof renderJobDetail === 'function' && typeof appState !== 'undefined' && appState.currentJobId) {
      renderJobDetail(appState.currentJobId);
    }
  }

  // ── Quick Calc (statusbar) ─────────────────────────────────

  function updateQuickCalc() {
    const el = document.getElementById('wsQuickCalc');
    if (!el || !grid.selection) return;

    // Collect numeric values from selected range
    const rng = getSelRange();
    const nums = [];
    for (var r = rng.r1; r <= rng.r2; r++)
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = grid.cells[addr(r, c)];
        if (cell && typeof cell.value === 'number') nums.push(cell.value);
      }

    if (nums.length > 1) {
      const sum = nums.reduce((a, b) => a + b, 0);
      const avg = sum / nums.length;
      el.textContent = `SUM: ${sum.toLocaleString('en-US', { minimumFractionDigits: 2 })}  |  AVG: ${avg.toLocaleString('en-US', { minimumFractionDigits: 2 })}  |  COUNT: ${nums.length}`;
    } else {
      el.textContent = '';
    }
  }

  // ── Undo / Redo ────────────────────────────────────────────

  function snapshotState() {
    // colWch/rowHpt live on the SHEET (exact Excel units, S4) — they
    // must travel with undo or a column insert + Ctrl+Z leaves them
    // shifted against the restored px widths and export writes the
    // imported width onto the wrong column.
    var sh = activeSheet();
    return {
      cells: JSON.parse(JSON.stringify(grid.cells)),
      links: JSON.parse(JSON.stringify(grid.links)),
      merges: JSON.parse(JSON.stringify(grid.merges)),
      rows: grid.rows, cols: grid.cols,
      colWidths: JSON.parse(JSON.stringify(grid.colWidths)),
      colWch: JSON.parse(JSON.stringify((sh && sh.colWch) || {})),
      rowHpt: JSON.parse(JSON.stringify((sh && sh.rowHpt) || {}))
    };
  }

  function pushUndo() {
    grid.undoStack.push(snapshotState());
    if (grid.undoStack.length > UNDO_MAX) grid.undoStack.shift();
    grid.redoStack = [];
  }

  function doUndo() {
    if (!grid.undoStack.length) return;
    grid.redoStack.push(snapshotState());
    var s = grid.undoStack.pop();
    grid.cells = s.cells; grid.links = s.links; grid.merges = s.merges || [];
    grid.rows = s.rows; grid.cols = s.cols; grid.colWidths = s.colWidths;
    var sh = activeSheet();
    if (sh) { sh.colWch = s.colWch || {}; sh.rowHpt = s.rowHpt || {}; }
    recalcAll(); renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c);
    saveWorkspace();
  }

  function doRedo() {
    if (!grid.redoStack.length) return;
    grid.undoStack.push(snapshotState());
    var s = grid.redoStack.pop();
    grid.cells = s.cells; grid.links = s.links; grid.merges = s.merges || [];
    grid.rows = s.rows; grid.cols = s.cols; grid.colWidths = s.colWidths;
    var sh = activeSheet();
    if (sh) { sh.colWch = s.colWch || {}; sh.rowHpt = s.rowHpt || {}; }
    recalcAll(); renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c);
    saveWorkspace();
  }

  // ── Range Selection Helpers ───────────────────────────────

  function getSelRange() {
    if (!grid.selection) return null;
    var s = grid.selection;
    if (!grid.selEnd) return { r1: s.r, c1: s.c, r2: s.r, c2: s.c };
    var e = grid.selEnd;
    return {
      r1: Math.min(s.r, e.r), c1: Math.min(s.c, e.c),
      r2: Math.max(s.r, e.r), c2: Math.max(s.c, e.c)
    };
  }

  function inRange(r, c) {
    var rng = getSelRange();
    return rng && r >= rng.r1 && r <= rng.r2 && c >= rng.c1 && c <= rng.c2;
  }

  function renderSelectionClasses() {
    if (!wsTable) return;
    var rng = getSelRange();
    wsTable.querySelectorAll('td.ws-cell').forEach(function (td) {
      var r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);
      td.classList.remove('ws-selected', 'ws-range-selected', 'ws-range-top', 'ws-range-bottom', 'ws-range-left', 'ws-range-right');
      if (!rng) return;
      var active = grid.selection && grid.selection.r === r && grid.selection.c === c;
      var inside = r >= rng.r1 && r <= rng.r2 && c >= rng.c1 && c <= rng.c2;
      if (active) td.classList.add('ws-selected');
      if (inside && !active) td.classList.add('ws-range-selected');
      if (inside) {
        if (r === rng.r1) td.classList.add('ws-range-top');
        if (r === rng.r2) td.classList.add('ws-range-bottom');
        if (c === rng.c1) td.classList.add('ws-range-left');
        if (c === rng.c2) td.classList.add('ws-range-right');
      }
    });

    // Header highlighting + full-row wrap. A row is "fully selected"
    // when the range spans every column (c1=0 and c2 reaches the last
    // column); cells in those rows wrap text downward via the
    // .ws-row-fullselected class on the tr.
    var lastCol = grid.cols - 1;
    var lastRow = grid.rows - 1;
    var fullCol = rng && rng.r1 === 0 && rng.r2 === lastRow;
    var fullRow = rng && rng.c1 === 0 && rng.c2 === lastCol;
    wsTable.querySelectorAll('th.ws-col-header').forEach(function (th) {
      var c = parseInt(th.dataset.col);
      th.classList.toggle('ws-col-selected', !!(rng && c >= rng.c1 && c <= rng.c2 && (fullCol || rng.r1 === rng.r2)));
    });
    var tbody = wsTable.querySelector('tbody');
    if (tbody) {
      Array.prototype.forEach.call(tbody.rows, function (tr, idx) {
        var rowHeader = tr.querySelector('td.ws-row-header');
        var inRange = rng && idx >= rng.r1 && idx <= rng.r2;
        if (rowHeader) {
          rowHeader.classList.toggle('ws-row-selected', !!(inRange && (fullRow || rng.c1 === rng.c2)));
        }
        tr.classList.toggle('ws-row-fullselected', !!(inRange && fullRow));
      });
    }

    // Drag-to-fill handle on the selection's bottom-right corner.
    positionFillHandle(rng);
  }

  // ── Merge Helpers ──────────────────────────────────────────

  /** Find the merge range containing cell (r, c), or null */
  function getMerge(r, c) {
    for (var i = 0; i < grid.merges.length; i++) {
      var m = grid.merges[i];
      if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m;
    }
    return null;
  }

  /** True if cell is part of a merge but NOT the top-left origin */
  function isMergeHidden(r, c) {
    var m = getMerge(r, c);
    return m && (r !== m.r1 || c !== m.c1);
  }

  /** Build a Set of hidden cell keys for fast lookup during rendering */
  function buildHiddenSet() {
    var hidden = {};
    grid.merges.forEach(function (m) {
      for (var r = m.r1; r <= m.r2; r++)
        for (var c = m.c1; c <= m.c2; c++)
          if (r !== m.r1 || c !== m.c1) hidden[r + ',' + c] = true;
    });
    return hidden;
  }

  /** Get merge info for origin cell (colspan/rowspan) */
  function getMergeSpan(r, c) {
    for (var i = 0; i < grid.merges.length; i++) {
      var m = grid.merges[i];
      if (r === m.r1 && c === m.c1) return { colspan: m.c2 - m.c1 + 1, rowspan: m.r2 - m.r1 + 1 };
    }
    return null;
  }

  /** Merge the current selection range */
  function mergeSelection() {
    var rng = getSelRange();
    if (!rng || (rng.r1 === rng.r2 && rng.c1 === rng.c2)) return; // need >1 cell
    // Check no overlap with existing merges
    for (var i = 0; i < grid.merges.length; i++) {
      var m = grid.merges[i];
      if (!(rng.r2 < m.r1 || rng.r1 > m.r2 || rng.c2 < m.c1 || rng.c1 > m.c2)) {
        // Overlapping — remove old merge first
        grid.merges.splice(i, 1);
        i--;
      }
    }
    pushUndo();
    grid.merges.push({ r1: rng.r1, c1: rng.c1, r2: rng.r2, c2: rng.c2 });
    grid.dirty = true;
    renderGrid();
    selectCell(rng.r1, rng.c1);
    saveWorkspace();
  }

  /** Unmerge cells at current selection */
  function unmergeSelection() {
    if (!grid.selection) return;
    var m = getMerge(grid.selection.r, grid.selection.c);
    if (!m) return;
    pushUndo();
    grid.merges = grid.merges.filter(function (mg) { return mg !== m; });
    grid.dirty = true;
    renderGrid();
    selectCell(grid.selection.r, grid.selection.c);
    saveWorkspace();
  }

  // ── Formula Reference Adjustment ──────────────────────────

  function adjustFormulaRefs(raw, rowDelta, colDelta) {
    if (!raw || !raw.startsWith('=')) return raw;
    return '=' + raw.substring(1).replace(/\b([A-Z]+)(\d+)\b/gi, function (match, colStr, rowStr) {
      var r = parseInt(rowStr) + rowDelta;
      var c = letterToCol(colStr.toUpperCase()) + colDelta;
      if (r < 1 || c < 0) return '#REF!';
      return colLetter(c) + r;
    });
  }

  // ── Fill Handle / Drag-to-Fill (Phase 2.1) ─────────────────
  //
  // Excel-style fill: drag the small square on the selection's bottom-
  // right corner to extend a series down/up/right/left. Detects numeric
  // arithmetic series, month/weekday name sequences, "Item 1"→"Item 2"
  // text patterns, and copies anything else. Formula cells have their
  // relative references adjusted by the per-cell offset.

  var FILL_MONTHS_FULL = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  var FILL_MONTHS_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  var FILL_DAYS_FULL = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  var FILL_DAYS_ABBR = ['sun','mon','tue','wed','thu','fri','sat'];

  function fillListByName(name) {
    return name === 'MF' ? FILL_MONTHS_FULL : name === 'MA' ? FILL_MONTHS_ABBR :
           name === 'DF' ? FILL_DAYS_FULL : FILL_DAYS_ABBR;
  }

  /** Detect a month/weekday name; returns { list, idx } or null. */
  function fillMatchSequenceWord(text) {
    var t = String(text == null ? '' : text).trim().toLowerCase();
    if (!t) return null;
    var i;
    if ((i = FILL_MONTHS_FULL.indexOf(t)) !== -1) return { list: 'MF', idx: i };
    if ((i = FILL_MONTHS_ABBR.indexOf(t)) !== -1) return { list: 'MA', idx: i };
    if ((i = FILL_DAYS_FULL.indexOf(t)) !== -1) return { list: 'DF', idx: i };
    if ((i = FILL_DAYS_ABBR.indexOf(t)) !== -1) return { list: 'DA', idx: i };
    return null;
  }

  /** Re-apply the capitalization style of `sample` to `word`. */
  function fillApplyCase(sample, word) {
    var s = String(sample);
    if (s && s === s.toUpperCase() && s !== s.toLowerCase()) return word.toUpperCase();
    if (s && s.charAt(0) === s.charAt(0).toUpperCase()) return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
  }

  /** "Item 12" → { prefix:'Item ', num:12, pad:2, suffix:'' }; null if no trailing int. */
  function fillSplitTrailingNumber(text) {
    var m = String(text == null ? '' : text).match(/^(.*?)(\d+)(\D*)$/);
    if (!m) return null;
    return { prefix: m[1], num: parseInt(m[2], 10), pad: m[2].length, suffix: m[3] };
  }

  /** Numeric value of a cell for series detection, or null. */
  function fillCellNumeric(cell) {
    if (!cell) return null;
    if (typeof cell.value === 'number' && isFinite(cell.value)) return cell.value;
    var raw = cell.raw;
    if (raw == null || raw === '' || String(raw).indexOf('=') === 0) return null;
    var s = String(raw).replace(/[$,%\s]/g, '');
    if (s === '' || isNaN(Number(s))) return null;
    return Number(s);
  }

  function fillFormatNumber(v) {
    var r = Math.round(v * 1e10) / 1e10;
    return String(r);
  }

  /**
   * Given the source cells along one fill line (in natural order) and the
   * number of target cells to produce, return an array of { raw, srcIndex }
   * describing each successive target in fill order. dir ∈ down|up|right|left.
   */
  function computeFillCells(srcCells, count, dir) {
    var n = srcCells.length;
    var raws = srcCells.map(function (c) { return (c && c.raw != null) ? String(c.raw) : ''; });
    var down = (dir === 'down' || dir === 'right');
    var rowAxis = (dir === 'down' || dir === 'up');
    var out = new Array(count);
    function srcIndexFor(k) { return down ? (k % n) : ((n - 1) - (k % n)); }

    // 1) All formulas → adjust relative refs by the per-block offset.
    var allFormula = n > 0 && raws.every(function (s) { return s.indexOf('=') === 0; });
    if (allFormula) {
      for (var k = 0; k < count; k++) {
        var si = srcIndexFor(k);
        var blockNum = Math.floor(k / n) + 1;
        var d = (down ? 1 : -1) * blockNum * n;
        out[k] = { raw: rowAxis ? adjustFormulaRefs(raws[si], d, 0) : adjustFormulaRefs(raws[si], 0, d), srcIndex: si };
      }
      return out;
    }

    // 2) All numeric → arithmetic series (single value copies).
    var nums = srcCells.map(fillCellNumeric);
    var allNumeric = n > 0 && nums.every(function (v) { return v !== null; });
    if (allNumeric) {
      if (n === 1) {
        for (var k1 = 0; k1 < count; k1++) out[k1] = { raw: raws[0], srcIndex: 0 };
      } else {
        var step = (nums[n - 1] - nums[0]) / (n - 1);
        var base = down ? nums[n - 1] : nums[0];
        for (var k2 = 0; k2 < count; k2++) {
          var val = down ? (base + step * (k2 + 1)) : (base - step * (k2 + 1));
          out[k2] = { raw: fillFormatNumber(val), srcIndex: srcIndexFor(k2) };
        }
      }
      return out;
    }

    // 3) Month/weekday name sequence.
    var seq = raws.map(fillMatchSequenceWord);
    var allSeq = n > 0 && seq.every(function (m, i) { return m && (i === 0 || m.list === seq[0].list); });
    if (allSeq) {
      var list = fillListByName(seq[0].list);
      var L = list.length;
      var sStep = (n >= 2) ? (seq[1].idx - seq[0].idx) : 1;
      if (sStep === 0) sStep = 1;
      var anchorIdx = down ? seq[n - 1].idx : seq[0].idx;
      var sample = down ? raws[n - 1] : raws[0];
      for (var k3 = 0; k3 < count; k3++) {
        var ni = down ? (anchorIdx + sStep * (k3 + 1)) : (anchorIdx - sStep * (k3 + 1));
        ni = ((ni % L) + L) % L;
        out[k3] = { raw: fillApplyCase(sample, list[ni]), srcIndex: srcIndexFor(k3) };
      }
      return out;
    }

    // 4) Text with a trailing integer ("Week 1" → "Week 2").
    var tn = raws.map(fillSplitTrailingNumber);
    var allText = n > 0 && tn.every(function (t, i) {
      return t && (i === 0 || (t.prefix === tn[0].prefix && t.suffix === tn[0].suffix));
    });
    if (allText) {
      var tStep = (n >= 2) ? (tn[n - 1].num - tn[0].num) : 1;
      if (tStep === 0) tStep = 1;
      var pad = tn[0].pad, pre = tn[0].prefix, suf = tn[0].suffix;
      var tBase = down ? tn[n - 1].num : tn[0].num;
      for (var k4 = 0; k4 < count; k4++) {
        var nv = down ? (tBase + tStep * (k4 + 1)) : (tBase - tStep * (k4 + 1));
        var ns = String(Math.abs(nv));
        while (ns.length < pad) ns = '0' + ns;
        out[k4] = { raw: pre + (nv < 0 ? '-' : '') + ns + suf, srcIndex: srcIndexFor(k4) };
      }
      return out;
    }

    // 5) Fallback: copy (cycle through the source block).
    for (var k5 = 0; k5 < count; k5++) {
      var si5 = srcIndexFor(k5);
      out[k5] = { raw: raws[si5], srcIndex: si5 };
    }
    return out;
  }

  /** Write one filled cell, copying presentation from its source cell. */
  function applyFilledCell(r, c, fill, srcCells) {
    if (!fill) return;
    var cell = getCell(r, c);
    cell.raw = fill.raw;
    delete cell.importedValue; // fill overwrote the cell
    var srcCell = srcCells[fill.srcIndex] || srcCells[0];
    if (srcCell) {
      cell.fmt = srcCell.fmt != null ? srcCell.fmt : null;
      if (srcCell.numFmt != null) cell.numFmt = srcCell.numFmt; else delete cell.numFmt;
      if (srcCell.decimals != null) cell.decimals = srcCell.decimals; else delete cell.decimals;
      if (srcCell.validation != null) cell.validation = JSON.parse(JSON.stringify(srcCell.validation)); else delete cell.validation;
      cell.style = srcCell.style ? JSON.parse(JSON.stringify(srcCell.style)) : {};
    }
  }

  /** Apply a completed fill drag: src block → dst (extended) range. */
  function applyFill(src, dst, dir) {
    if (!src || !dst || !dir) return;
    var vertical = (dir === 'down' || dir === 'up');
    var count;
    if (vertical) count = (dir === 'down') ? (dst.r2 - src.r2) : (src.r1 - dst.r1);
    else count = (dir === 'right') ? (dst.c2 - src.c2) : (src.c1 - dst.c1);
    if (count <= 0) return;
    pushUndo();
    if (vertical) {
      for (var c = src.c1; c <= src.c2; c++) {
        var col = [];
        for (var r = src.r1; r <= src.r2; r++) col.push(getCell(r, c));
        var fills = computeFillCells(col, count, dir);
        for (var k = 0; k < count; k++) {
          var tr = (dir === 'down') ? (src.r2 + 1 + k) : (src.r1 - 1 - k);
          applyFilledCell(tr, c, fills[k], col);
        }
      }
    } else {
      for (var rr = src.r1; rr <= src.r2; rr++) {
        var row = [];
        for (var cc = src.c1; cc <= src.c2; cc++) row.push(getCell(rr, cc));
        var fills2 = computeFillCells(row, count, dir);
        for (var k2 = 0; k2 < count; k2++) {
          var tc = (dir === 'right') ? (src.c2 + 1 + k2) : (src.c1 - 1 - k2);
          applyFilledCell(rr, tc, fills2[k2], row);
        }
      }
    }
    grid.dirty = true;
    recalcAll();
    renderGrid();
    grid.selection = { r: dst.r1, c: dst.c1 };
    grid.selEnd = { r: dst.r2, c: dst.c2 };
    selectCell(dst.r1, dst.c1, true);
    pushLinkedValues();
    saveWorkspace();
  }

  // Fill-drag preview helpers (operate on module-level `filling`).
  function clearFillPreview() {
    if (!wsTable) return;
    wsTable.querySelectorAll('.ws-fill-preview').forEach(function (el) { el.classList.remove('ws-fill-preview'); });
  }

  function updateFillPreview(r, c) {
    if (!filling) return;
    var src = filling.src;
    var below = r - src.r2, above = src.r1 - r, right = c - src.c2, left = src.c1 - c;
    var vMax = Math.max(below, above, 0), hMax = Math.max(right, left, 0);
    if (vMax === 0 && hMax === 0) { clearFillPreview(); filling.dst = null; filling.dir = null; return; }
    var dir, dst;
    if (vMax >= hMax) {
      if (below >= above) { dir = 'down'; dst = { r1: src.r1, c1: src.c1, r2: r, c2: src.c2 }; }
      else { dir = 'up'; dst = { r1: r, c1: src.c1, r2: src.r2, c2: src.c2 }; }
    } else {
      if (right >= left) { dir = 'right'; dst = { r1: src.r1, c1: src.c1, r2: src.r2, c2: c }; }
      else { dir = 'left'; dst = { r1: src.r1, c1: c, r2: src.r2, c2: src.c2 }; }
    }
    filling.dst = dst; filling.dir = dir;
    clearFillPreview();
    wsTable.querySelectorAll('td.ws-cell').forEach(function (td) {
      var tr = parseInt(td.dataset.r), tc = parseInt(td.dataset.c);
      var inDst = tr >= dst.r1 && tr <= dst.r2 && tc >= dst.c1 && tc <= dst.c2;
      var inSrc = tr >= src.r1 && tr <= src.r2 && tc >= src.c1 && tc <= src.c2;
      if (inDst && !inSrc) td.classList.add('ws-fill-preview');
    });
  }

  /** Place the drag-to-fill handle on the bottom-right corner of a range. */
  function positionFillHandle(rng) {
    if (!wsTable) return;
    var old = wsTable.querySelector('.ws-fill-handle');
    if (old) old.parentNode.removeChild(old);
    if (!rng || grid.editing) return;
    var td = wsTable.querySelector('td.ws-cell[data-r="' + rng.r2 + '"][data-c="' + rng.c2 + '"]');
    if (!td) return;
    var h = document.createElement('div');
    h.className = 'ws-fill-handle';
    td.appendChild(h);
  }

  // ── Row / Column Insert & Delete ──────────────────────────

  function shiftCellData(axis, position, delta) {
    var newCells = {}, newLinks = {};
    Object.keys(grid.cells).forEach(function (key) {
      var ref = parseAddr(key);
      if (!ref) return;
      var r = ref.r, c = ref.c;
      if (axis === 'row') {
        if (delta < 0 && r === position) return; // deleted row
        if (r >= position) r += delta;
      } else {
        if (delta < 0 && c === position) return; // deleted col
        if (c >= position) c += delta;
      }
      if (r >= 0 && c >= 0) newCells[addr(r, c)] = grid.cells[key];
    });
    Object.keys(grid.links).forEach(function (key) {
      var ref = parseAddr(key);
      if (!ref) return;
      var r = ref.r, c = ref.c;
      if (axis === 'row') {
        if (delta < 0 && r === position) return;
        if (r >= position) r += delta;
      } else {
        if (delta < 0 && c === position) return;
        if (c >= position) c += delta;
      }
      if (r >= 0 && c >= 0) newLinks[addr(r, c)] = grid.links[key];
    });
    grid.cells = newCells;
    grid.links = newLinks;
    // Shift colWidths for column operations — and the sheet's exact
    // Excel widths (colWch, S4) the same way so export doesn't apply
    // a stale imported width to the wrong column.
    if (axis === 'col') {
      var newW = {};
      Object.keys(grid.colWidths).forEach(function (k) {
        var ci = parseInt(k);
        if (delta < 0 && ci === position) return;
        if (ci >= position) ci += delta;
        if (ci >= 0) newW[ci] = grid.colWidths[k];
      });
      grid.colWidths = newW;
      var shWch = activeSheet();
      if (shWch && shWch.colWch) {
        var newWch = {};
        Object.keys(shWch.colWch).forEach(function (k) {
          var ci = parseInt(k);
          if (delta < 0 && ci === position) return;
          if (ci >= position) ci += delta;
          if (ci >= 0) newWch[ci] = shWch.colWch[k];
        });
        shWch.colWch = newWch;
      }
    }
    // Row structural ops don't remap rowHeights today (pre-existing);
    // drop the exact imported points so export can't resurrect heights
    // onto shifted rows while the px heights stay unshifted.
    if (axis === 'row') {
      var shHpt = activeSheet();
      if (shHpt && shHpt.rowHpt) shHpt.rowHpt = {};
    }
  }

  function shiftFormulaRefs(axis, position, delta) {
    Object.keys(grid.cells).forEach(function (key) {
      var cell = grid.cells[key];
      if (!cell.raw || !cell.raw.startsWith('=')) return;
      cell.raw = '=' + cell.raw.substring(1).replace(/\b([A-Z]+)(\d+)\b/gi, function (match, colStr, rowStr) {
        var r = parseInt(rowStr); // 1-indexed
        var c = letterToCol(colStr.toUpperCase()); // 0-indexed
        if (axis === 'row' && r >= position + 1) { r += delta; if (r < 1) return '#REF!'; }
        if (axis === 'col' && c >= position) { c += delta; if (c < 0) return '#REF!'; }
        return colLetter(c) + r;
      });
    });
  }

  function insertRow(atRow, direction) {
    pushUndo();
    var insertAt = direction === 'above' ? atRow : atRow + 1;
    shiftCellData('row', insertAt, 1);
    shiftFormulaRefs('row', insertAt, 1);
    grid.rows++;
    recalcAll(); renderGrid(); saveWorkspace();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c);
  }

  function deleteRow(atRow) {
    if (grid.rows <= 1) return;
    pushUndo();
    shiftCellData('row', atRow, -1);
    shiftFormulaRefs('row', atRow, -1);
    grid.rows = Math.max(grid.rows - 1, 1);
    recalcAll(); renderGrid(); saveWorkspace();
    if (grid.selection) {
      var nr = Math.min(grid.selection.r, grid.rows - 1);
      selectCell(nr, grid.selection.c);
    }
  }

  function insertColumn(atCol, direction) {
    pushUndo();
    var insertAt = direction === 'left' ? atCol : atCol + 1;
    shiftCellData('col', insertAt, 1);
    shiftFormulaRefs('col', insertAt, 1);
    grid.cols++;
    recalcAll(); renderGrid(); saveWorkspace();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c);
  }

  function deleteColumn(atCol) {
    if (grid.cols <= 1) return;
    pushUndo();
    shiftCellData('col', atCol, -1);
    shiftFormulaRefs('col', atCol, -1);
    grid.cols = Math.max(grid.cols - 1, 1);
    recalcAll(); renderGrid(); saveWorkspace();
    if (grid.selection) {
      var nc = Math.min(grid.selection.c, grid.cols - 1);
      selectCell(grid.selection.r, nc);
    }
  }

  // ── Cell Comments / Notes (Phase 2.5) ──────────────────────
  // A cell's comment is stored on cell.note (kept as the field name for
  // backward compatibility with existing saved workbooks + the red-triangle
  // indicator + hover title). The editor below replaces the old window.prompt
  // with an inline modal: multi-line, positioned near the cell, with
  // Save / Delete / Cancel.

  var _commentEditorEl = null;
  function closeCommentEditor() {
    if (_commentEditorEl && _commentEditorEl.parentNode) _commentEditorEl.parentNode.removeChild(_commentEditorEl);
    _commentEditorEl = null;
    document.removeEventListener('mousedown', _commentOutsideHandler, true);
  }
  function _commentOutsideHandler(e) {
    if (_commentEditorEl && !_commentEditorEl.contains(e.target)) {
      // Click outside saves whatever's typed (Excel-like), then closes.
      var ta = _commentEditorEl.querySelector('textarea');
      if (ta && _commentEditorEl._target) {
        _saveCommentValue(_commentEditorEl._target.r, _commentEditorEl._target.c, ta.value);
      }
      closeCommentEditor();
    }
  }
  function _saveCommentValue(r, c, text) {
    var cell = getCell(r, c);
    var trimmed = (text || '').trim();
    var prev = cell.note || '';
    if (trimmed === prev) return; // no change → skip undo churn
    pushUndo();
    if (trimmed) cell.note = trimmed; else delete cell.note;
    grid.dirty = true;
    renderGrid();
    selectCell(r, c);
    saveWorkspace();
  }

  function promptNote(r, c) {
    closeCommentEditor();
    var cell = getCell(r, c);
    var td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    var pop = document.createElement('div');
    pop.className = 'ws-comment-editor';
    pop._target = { r: r, c: c };
    pop.style.cssText = 'position:fixed;background:var(--surface,#181820);border:1px solid var(--border,#333);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:1600;width:260px;padding:10px;font-size:12px;';
    pop.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
        '<strong style="font-size:12px;">Cell Comment</strong>' +
        '<span style="font-size:11px;color:var(--text-dim,#aaa);">' + addr(r, c) + '</span>' +
      '</div>' +
      '<textarea class="ws-comment-text" rows="4" placeholder="Type a comment…" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);resize:vertical;font-family:inherit;">' +
        escapeHTML(cell.note || '') +
      '</textarea>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px;">' +
        '<button class="ws-btn" data-act="delete" style="padding:3px 8px;">Delete</button>' +
        '<button class="ws-btn" data-act="cancel" style="padding:3px 8px;">Cancel</button>' +
        '<button class="ws-btn ws-btn-primary" data-act="save" style="padding:3px 8px;">Save</button>' +
      '</div>';
    document.body.appendChild(pop);
    if (td) {
      var rect = td.getBoundingClientRect();
      var left = Math.min(rect.right + 4, window.innerWidth - 270);
      pop.style.left = Math.max(4, left) + 'px';
      pop.style.top = Math.min(rect.top, window.innerHeight - 180) + 'px';
    } else {
      pop.style.left = '40%';
      pop.style.top = '120px';
    }
    _commentEditorEl = pop;
    var ta = pop.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    pop.querySelector('[data-act="save"]').addEventListener('click', function () {
      _saveCommentValue(r, c, ta.value);
      closeCommentEditor();
    });
    pop.querySelector('[data-act="cancel"]').addEventListener('click', function () {
      closeCommentEditor();
    });
    pop.querySelector('[data-act="delete"]').addEventListener('click', function () {
      _saveCommentValue(r, c, '');
      closeCommentEditor();
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeCommentEditor(); }
      // Ctrl/Cmd+Enter saves.
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault(); _saveCommentValue(r, c, ta.value); closeCommentEditor();
      }
    });
    setTimeout(function () { document.addEventListener('mousedown', _commentOutsideHandler, true); }, 0);
  }

  // Ribbon entry point — edit the active cell's comment.
  window.wsOpenComment = function () {
    if (!grid || !grid.selection) return;
    promptNote(grid.selection.r, grid.selection.c);
  };

  function deleteNote(r, c) {
    var cell = getCell(r, c);
    if (!cell.note) return;
    pushUndo();
    delete cell.note;
    grid.dirty = true;
    refreshCell(r, c);
    saveWorkspace();
  }

  // ── Hyperlinks (Phase 2.6) ─────────────────────────────────
  // cell.hyperlink = { url, display }. The anchor rendering + click
  // styling live in cellInnerHTML / CSS; this is the Ctrl+K editor that
  // sets/clears the link on the active cell.

  var _hyperlinkEditorEl = null;
  function closeHyperlinkEditor() {
    if (_hyperlinkEditorEl && _hyperlinkEditorEl.parentNode) _hyperlinkEditorEl.parentNode.removeChild(_hyperlinkEditorEl);
    _hyperlinkEditorEl = null;
  }
  function _normalizeUrl(u) {
    u = (u || '').trim();
    if (!u) return '';
    // Allow mailto:, tel:, anchors, and protocol-relative; otherwise
    // default bare domains to https://.
    if (/^(https?:|mailto:|tel:|ftp:|\/\/|#|\/)/i.test(u)) return u;
    if (/^[\w.-]+@[\w.-]+\.\w+$/.test(u)) return 'mailto:' + u;
    return 'https://' + u;
  }

  function openHyperlinkEditor(r, c) {
    closeHyperlinkEditor();
    var cell = getCell(r, c);
    var existing = cell.hyperlink || null;
    var td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    var pop = document.createElement('div');
    pop.className = 'ws-hyperlink-editor';
    pop.style.cssText = 'position:fixed;background:var(--surface,#181820);border:1px solid var(--border,#333);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:1600;width:300px;padding:12px;font-size:12px;';
    var curText = existing ? (existing.display || '') : (displayVal(cell) || '');
    pop.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<strong style="font-size:13px;">Insert Hyperlink</strong>' +
        '<span style="font-size:11px;color:var(--text-dim,#aaa);">' + addr(r, c) + '</span>' +
      '</div>' +
      '<label style="font-size:11px;color:var(--text-dim,#aaa);">Address (URL)' +
        '<input type="text" id="wsHlUrl" placeholder="https://example.com" style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
      '</label>' +
      '<label style="font-size:11px;color:var(--text-dim,#aaa);display:block;margin-top:8px;">Text to display' +
        '<input type="text" id="wsHlText" placeholder="(optional)" style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
      '</label>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:10px;">' +
        '<button class="ws-btn" data-act="remove" style="padding:3px 8px;">Remove</button>' +
        '<button class="ws-btn" data-act="cancel" style="padding:3px 8px;">Cancel</button>' +
        '<button class="ws-btn ws-btn-primary" data-act="ok" style="padding:3px 8px;">OK</button>' +
      '</div>';
    document.body.appendChild(pop);
    if (td) {
      var rect = td.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 310)) + 'px';
      pop.style.top = Math.min(rect.bottom + 4, window.innerHeight - 200) + 'px';
    } else { pop.style.left = '40%'; pop.style.top = '120px'; }
    _hyperlinkEditorEl = pop;
    var urlInput = pop.querySelector('#wsHlUrl');
    var textInput = pop.querySelector('#wsHlText');
    urlInput.value = existing ? existing.url : '';
    textInput.value = curText;
    urlInput.focus();

    function applyHl() {
      var url = _normalizeUrl(urlInput.value);
      if (!url) { closeHyperlinkEditor(); return; }
      var display = textInput.value.trim();
      pushUndo();
      var tgt = getCell(r, c);
      tgt.hyperlink = { url: url };
      if (display) tgt.hyperlink.display = display;
      // If the cell is empty, show the display text (or the URL) so the
      // link is visible and clickable.
      var hasValue = (tgt.raw !== '' && tgt.raw != null);
      if (!hasValue) { tgt.raw = display || url; }
      grid.dirty = true;
      recalcAll();
      renderGrid();
      selectCell(r, c);
      saveWorkspace();
      closeHyperlinkEditor();
    }
    pop.querySelector('[data-act="ok"]').addEventListener('click', applyHl);
    pop.querySelector('[data-act="cancel"]').addEventListener('click', closeHyperlinkEditor);
    pop.querySelector('[data-act="remove"]').addEventListener('click', function () {
      pushUndo();
      var tgt = getCell(r, c);
      delete tgt.hyperlink;
      grid.dirty = true;
      renderGrid();
      selectCell(r, c);
      saveWorkspace();
      closeHyperlinkEditor();
    });
    [urlInput, textInput].forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyHl(); }
        if (e.key === 'Escape') { e.preventDefault(); closeHyperlinkEditor(); }
      });
    });
  }

  window.wsOpenHyperlink = function () {
    if (!grid || !grid.selection) return;
    openHyperlinkEditor(grid.selection.r, grid.selection.c);
  };

  // ── Context Menu ──────────────────────────────────────────

  var ctxMenu = null;

  function showContextMenu(x, y, items) {
    closeContextMenu();
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ws-context-menu';
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    items.forEach(function (item) {
      if (item === '---') {
        var sep = document.createElement('div');
        sep.className = 'ws-context-menu-separator';
        ctxMenu.appendChild(sep);
      } else {
        var el = document.createElement('div');
        el.className = 'ws-context-menu-item';
        el.textContent = item.label;
        el.addEventListener('click', function () { closeContextMenu(); item.action(); });
        ctxMenu.appendChild(el);
      }
    });
    document.body.appendChild(ctxMenu);
    // When the workspace lives inside the transformed node-graph canvas
    // it renders at the graph's zoom level. The context menu uses
    // viewport-fixed positioning so it draws at 1.0 — visually huge
    // next to a zoomed-out workspace. Match the menu's scale to the
    // canvas zoom so it reads as part of the same surface.
    var fp = document.getElementById('wsFloatingPanel');
    if (fp && fp.classList.contains('ws-floating-graph-mode') &&
        typeof NG !== 'undefined' && NG.zm) {
      var z = NG.zm() || 1;
      ctxMenu.style.transformOrigin = 'top left';
      ctxMenu.style.transform = 'scale(' + z + ')';
    }
    setTimeout(function () {
      document.addEventListener('click', closeContextMenu, { once: true });
      document.addEventListener('keydown', closeCtxOnEsc);
    }, 0);
  }

  function closeContextMenu() {
    if (ctxMenu && ctxMenu.parentNode) ctxMenu.parentNode.removeChild(ctxMenu);
    ctxMenu = null;
    document.removeEventListener('keydown', closeCtxOnEsc);
  }

  function closeCtxOnEsc(e) { if (e.key === 'Escape') closeContextMenu(); }

  // ── Event Handlers ─────────────────────────────────────────

  // ── Mouse selection state ──
  var dragging = false;
  var moving = null; // { startR, startC, rng } when edge-dragging to move cells
  var filling = null; // { src, dst, dir } when drag-to-fill is in progress

  /** Check if mouse is near the edge of the selected cell/range */
  function isOnSelectionEdge(td, e) {
    if (!grid.selection || grid.editing) return false;
    var r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);
    var rng = getSelRange();
    if (!rng) return false;
    // Must be on the border of the selection range
    var onRange = r >= rng.r1 && r <= rng.r2 && c >= rng.c1 && c <= rng.c2;
    if (!onRange) return false;
    var onEdge = r === rng.r1 || r === rng.r2 || c === rng.c1 || c === rng.c2;
    if (!onEdge) return false;
    // Check pixel proximity to td border (6px threshold)
    var rect = td.getBoundingClientRect();
    var mx = e.clientX, my = e.clientY;
    var t = 6;
    return mx - rect.left < t || rect.right - mx < t || my - rect.top < t || rect.bottom - my < t;
  }

  /** Move cell data (raw, value, fmt, style, note) + links from source range to dest */
  function moveCells(srcRng, destR, destC) {
    pushUndo();
    var rows = srcRng.r2 - srcRng.r1 + 1;
    var cols = srcRng.c2 - srcRng.c1 + 1;

    // Collect source data
    var srcData = [];
    var srcLinks = {};
    for (var r = 0; r < rows; r++) {
      srcData[r] = [];
      for (var c = 0; c < cols; c++) {
        var sr = srcRng.r1 + r, sc = srcRng.c1 + c;
        var key = addr(sr, sc);
        srcData[r][c] = JSON.parse(JSON.stringify(grid.cells[key] || { raw: '', value: '', fmt: null, style: {} }));
        if (grid.links[key]) {
          srcLinks[r + ',' + c] = JSON.parse(JSON.stringify(grid.links[key]));
          delete grid.links[key];
        }
        // Clear source
        delete grid.cells[key];
      }
    }

    // Place at destination
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var dr = destR + r, dc = destC + c;
        var key = addr(dr, dc);
        grid.cells[key] = srcData[r][c];
        if (srcLinks[r + ',' + c]) {
          grid.links[key] = srcLinks[r + ',' + c];
        }
      }
    }

    // Expand grid if needed
    if (destR + rows > grid.rows) grid.rows = destR + rows + 2;
    if (destC + cols > grid.cols) grid.cols = destC + cols + 2;

    grid.dirty = true;
    recalcAll();
    renderGrid();
    grid.selEnd = rows > 1 || cols > 1 ? { r: destR + rows - 1, c: destC + cols - 1 } : null;
    selectCell(destR, destC, !!grid.selEnd);
    pushLinkedValues();
    saveWorkspace();
  }

  function handleCellMouseDown(e) {
    // Grab the drag-to-fill handle (it lives inside the corner cell).
    if (e.target && e.target.classList && e.target.classList.contains('ws-fill-handle')) {
      if (grid.editing) commitEdit(grid.editing.r, grid.editing.c);
      e.preventDefault();
      filling = { src: getSelRange(), dst: null, dir: null };
      document.body.style.cursor = 'crosshair';
      return;
    }
    // Data-validation dropdown caret — open the list picker for this cell.
    if (e.target && e.target.classList && e.target.classList.contains('ws-validation-caret')) {
      var vtd = e.target.closest('td.ws-cell');
      if (vtd) {
        e.preventDefault();
        e.stopPropagation();
        var vr = parseInt(vtd.dataset.r), vc = parseInt(vtd.dataset.c);
        selectCell(vr, vc);
        openValidationDropdown(vr, vc, vtd);
      }
      return;
    }
    // AutoFilter dropdown button on a header cell — open the column filter.
    if (e.target && e.target.classList && e.target.classList.contains('ws-filter-btn')) {
      var ftd = e.target.closest('td.ws-cell');
      if (ftd) {
        e.preventDefault();
        e.stopPropagation();
        openFilterPopup(parseInt(ftd.dataset.c), e.target);
      }
      return;
    }
    // Hyperlink anchor click — select the cell but let the anchor's default
    // navigation (target="_blank") fire; do NOT preventDefault, do NOT start a drag.
    if (e.target && e.target.classList && e.target.classList.contains('ws-hyperlink')) {
      var htd = e.target.closest('td.ws-cell');
      if (htd) {
        var hr = parseInt(htd.dataset.r), hc = parseInt(htd.dataset.c);
        var hmerge = getMerge(hr, hc);
        if (hmerge) { hr = hmerge.r1; hc = hmerge.c1; }
        selectCell(hr, hc);
      }
      return;
    }
    var td = e.target.closest('td.ws-cell');
    if (!td) return;
    var r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);

    // Redirect to merge origin if clicking a merged cell
    var merge = getMerge(r, c);
    if (merge) { r = merge.r1; c = merge.c1; }

    // Reference mode: insert cell ref
    if (grid.refMode) {
      e.preventDefault();
      insertCellRefIntoFormula(addr(r, c));
      // Re-focus formula bar so next click continues inserting
      if (grid.refAnchor && grid.refAnchor.type === 'formulaBar') {
        formulaBar.focus();
      }
      return;
    }

    // Edge grab: start move drag
    if (isOnSelectionEdge(td, e)) {
      e.preventDefault();
      moving = { startR: r, startC: c, rng: getSelRange() };
      document.body.style.cursor = 'move';
      return;
    }

    if (grid.editing) commitEdit(grid.editing.r, grid.editing.c);

    if (e.shiftKey && grid.selection) {
      grid.selEnd = { r: r, c: c };
      selectCell(grid.selection.r, grid.selection.c, true);
    } else {
      selectCell(r, c);
    }
    dragging = true;
  }

  function handleCellMouseMove(e) {
    var td = e.target.closest('td.ws-cell');

    // Drag-to-fill in progress — preview the series extent.
    if (filling) {
      if (td) updateFillPreview(parseInt(td.dataset.r), parseInt(td.dataset.c));
      return;
    }

    // Show move cursor when hovering selection edge
    if (!dragging && !moving && td && !grid.editing && !grid.refMode) {
      td.style.cursor = isOnSelectionEdge(td, e) ? 'move' : '';
    }

    // Move drag in progress — show target highlight
    if (moving) {
      wsTable.querySelectorAll('.ws-move-target').forEach(function (el) { el.classList.remove('ws-move-target'); });
      if (td) {
        td.style.cursor = 'move';
        td.classList.add('ws-move-target');
      }
      return;
    }

    if (!dragging || grid.refMode) return;
    if (!td) return;
    var r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);
    if (!grid.selection) return;
    if (r !== (grid.selEnd ? grid.selEnd.r : grid.selection.r) || c !== (grid.selEnd ? grid.selEnd.c : grid.selection.c)) {
      grid.selEnd = { r: r, c: c };
      renderSelectionClasses();
      var rng = getSelRange();
      var refEl = document.getElementById('wsCellRef');
      if (refEl && rng && document.activeElement !== refEl) refEl.value = addr(rng.r1, rng.c1) + ':' + addr(rng.r2, rng.c2);
      updateQuickCalc();
    }
  }

  function handleCellMouseUp(e) {
    if (filling) {
      if (filling.dst && filling.dir) applyFill(filling.src, filling.dst, filling.dir);
      clearFillPreview();
      filling = null;
      document.body.style.cursor = '';
      return;
    }
    if (moving) {
      var td = e.target.closest ? e.target.closest('td.ws-cell') : null;
      if (td) {
        var r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);
        var rng = moving.rng;
        // Only move if destination is different from source
        if (r !== rng.r1 || c !== rng.c1) {
          moveCells(rng, r, c);
        }
      }
      moving = null;
      document.body.style.cursor = '';
      wsTable.querySelectorAll('.ws-move-target').forEach(function (el) { el.classList.remove('ws-move-target'); });
      return;
    }
    dragging = false;
  }

  function handleCellClick(e) {
    // Click is now handled by mousedown for selection
  }

  function handleCellDblClick(e) {
    const td = e.target.closest('td.ws-cell');
    if (!td) return;
    const r = parseInt(td.dataset.r);
    const c = parseInt(td.dataset.c);
    startEditing(r, c);
  }

  function handleKeyDown(e) {
    // Embedded views (Detailed Costs etc.) own their own keyboard
    // handling — the grid keymap doesn't apply.
    if (isEmbedSheet(activeSheet())) return;

    // Global shortcuts: undo/redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault(); doUndo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey))) {
      e.preventDefault(); doRedo(); return;
    }

    // Formatting shortcuts (work even while not editing)
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleStyleOnSelection('bold'); return; }
      if (e.key === 'i' || e.key === 'I') { e.preventDefault(); toggleStyleOnSelection('italic'); return; }
      if (e.key === 'u' || e.key === 'U') { e.preventDefault(); toggleStyleOnSelection('underline'); return; }
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); if (grid.selection) openHyperlinkEditor(grid.selection.r, grid.selection.c); return; }
    }

    // If editing a cell
    if (grid.editing) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit(grid.editing.r, grid.editing.c);
        if (grid.selection.r < grid.rows - 1) selectCell(grid.selection.r + 1, grid.selection.c);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commitEdit(grid.editing.r, grid.editing.c);
        if (grid.selection.c < grid.cols - 1) selectCell(grid.selection.r, grid.selection.c + 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
      return;
    }

    // If formula bar is focused
    if (document.activeElement === formulaBar) {
      if (e.key === 'Enter') {
        e.preventDefault();
        exitRefMode();
        if (grid.selection) {
          pushUndo();
          const cell = getCell(grid.selection.r, grid.selection.c);
          cell.raw = formulaBar.value.trim();
          delete cell.importedValue; // user edit via formula bar
          grid.dirty = true;
          recalcAll();
          renderGrid();
          selectCell(grid.selection.r, grid.selection.c);
          pushLinkedValues();
          saveWorkspace();
          if (typeof renderJobDetail === 'function' && typeof appState !== 'undefined' && appState.currentJobId) renderJobDetail(appState.currentJobId);
          if (grid.selection.r < grid.rows - 1) selectCell(grid.selection.r + 1, grid.selection.c);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        exitRefMode();
        formulaBar.blur();
        if (grid.selection) formulaBar.value = getCell(grid.selection.r, grid.selection.c).raw || '';
      } else if (e.key === '=' && formulaBar.value === '') {
        // Starting a new formula
        enterRefMode('formulaBar');
      } else if (grid.refMode && e.key.match(/^[+\-*/(,]$/) && formulaBar.value.endsWith(e.key)) {
        // Arrow keys after operator could navigate to next cell reference
        // This is already handled in the default grid navigation
      }
      return;
    }

    if (!grid.selection) return;

    const { r, c } = grid.selection;

    // Shift+F2 — add / edit the active cell's comment (Excel parity)
    if (e.shiftKey && e.key === 'F2') {
      e.preventDefault();
      promptNote(r, c);
      return;
    }

    // Alt+Down — open the data-validation dropdown on a list cell (Excel parity)
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'Down')) {
      const dvCell = grid.cells[addr(r, c)];
      if (dvCell && dvCell.validation && dvCell.validation.type === 'list') {
        e.preventDefault();
        const dvTd = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
        if (dvTd) openValidationDropdown(r, c, dvTd);
        return;
      }
    }

    // Arrow key navigation in ref mode (if formula bar has focus with operator at end)
    if (grid.refMode && formulaBar === document.activeElement && e.key.match(/^Arrow/)) {
      const content = formulaBar.value;
      const lastChar = content[content.length - 1];
      if (lastChar && lastChar.match(/^[+\-*/(,]$/)) {
        // Allow arrow navigation to insert cell refs
        let nr = r, nc = c;
        switch (e.key) {
          case 'ArrowUp': nr = r > 0 ? r - 1 : r; break;
          case 'ArrowDown': nr = r < grid.rows - 1 ? r + 1 : r; break;
          case 'ArrowLeft': nc = c > 0 ? c - 1 : c; break;
          case 'ArrowRight': nc = c < grid.cols - 1 ? c + 1 : c; break;
        }
        if (nr !== r || nc !== c) {
          e.preventDefault();
          const ref = addr(nr, nc);
          insertCellRefIntoFormula(ref);
          selectCell(nr, nc);
        }
      }
      return;
    }

    // Copy (Ctrl+C)
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      var rng = getSelRange();
      var text = '';
      for (var cr = rng.r1; cr <= rng.r2; cr++) {
        var rowVals = [];
        for (var cc = rng.c1; cc <= rng.c2; cc++) {
          var ccell = grid.cells[addr(cr, cc)];
          rowVals.push(ccell ? (ccell.raw || '') : '');
        }
        text += rowVals.join('\t') + '\n';
      }
      navigator.clipboard.writeText(text.trimEnd());
      return;
    }

    // Cut (Ctrl+X)
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      e.preventDefault();
      var rng = getSelRange();
      var text = '';
      for (var cr = rng.r1; cr <= rng.r2; cr++) {
        var rowVals = [];
        for (var cc = rng.c1; cc <= rng.c2; cc++) {
          var ccell = grid.cells[addr(cr, cc)];
          rowVals.push(ccell ? (ccell.raw || '') : '');
        }
        text += rowVals.join('\t') + '\n';
      }
      navigator.clipboard.writeText(text.trimEnd());
      pushUndo();
      for (var cr = rng.r1; cr <= rng.r2; cr++)
        for (var cc = rng.c1; cc <= rng.c2; cc++) {
          var ccell = getCell(cr, cc); ccell.raw = ''; ccell.value = ''; ccell.error = null;
        }
      grid.dirty = true; recalcAll(); renderGrid(); selectCell(r, c, !!grid.selEnd);
      pushLinkedValues(); saveWorkspace();
      return;
    }

    // Fill Down (Ctrl+D)
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      e.preventDefault();
      var rng = getSelRange();
      if (rng.r1 === rng.r2) return;
      pushUndo();
      for (var fc = rng.c1; fc <= rng.c2; fc++) {
        var src = getCell(rng.r1, fc);
        for (var fr = rng.r1 + 1; fr <= rng.r2; fr++) {
          var tgt = getCell(fr, fc);
          tgt.raw = adjustFormulaRefs(src.raw || '', fr - rng.r1, 0);
          delete tgt.importedValue; // fill-down overwrote the cell
          tgt.fmt = src.fmt;
          tgt.style = JSON.parse(JSON.stringify(src.style || {}));
        }
      }
      grid.dirty = true; recalcAll(); renderGrid(); selectCell(r, c, true);
      pushLinkedValues(); saveWorkspace();
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey) {
          var er = (grid.selEnd || grid.selection).r;
          if (er > 0) { grid.selEnd = { r: er - 1, c: (grid.selEnd || grid.selection).c }; selectCell(r, c, true); }
        } else { if (r > 0) selectCell(r - 1, c); }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (e.shiftKey) {
          var er = (grid.selEnd || grid.selection).r;
          if (er < grid.rows - 1) { grid.selEnd = { r: er + 1, c: (grid.selEnd || grid.selection).c }; selectCell(r, c, true); }
        } else { if (r < grid.rows - 1) selectCell(r + 1, c); else { autoExpand(r + 1, c); selectCell(r + 1, c); } }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) {
          var ec = (grid.selEnd || grid.selection).c;
          if (ec > 0) { grid.selEnd = { r: (grid.selEnd || grid.selection).r, c: ec - 1 }; selectCell(r, c, true); }
        } else { if (c > 0) selectCell(r, c - 1); }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) {
          var ec = (grid.selEnd || grid.selection).c;
          if (ec < grid.cols - 1) { grid.selEnd = { r: (grid.selEnd || grid.selection).r, c: ec + 1 }; selectCell(r, c, true); }
        } else { if (c < grid.cols - 1) selectCell(r, c + 1); else { autoExpand(r, c + 1); selectCell(r, c + 1); } }
        break;
      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) { if (c > 0) selectCell(r, c - 1); }
        else { if (c < grid.cols - 1) selectCell(r, c + 1); else { autoExpand(r, c + 1); selectCell(r, c + 1); } }
        break;
      case 'Enter':
        e.preventDefault();
        startEditing(r, c);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        pushUndo();
        var rng = getSelRange();
        for (var dr = rng.r1; dr <= rng.r2; dr++)
          for (var dc = rng.c1; dc <= rng.c2; dc++) {
            var dcell = getCell(dr, dc);
            dcell.raw = ''; dcell.value = ''; dcell.error = null;
          }
        grid.dirty = true;
        recalcAll(); renderGrid(); selectCell(r, c, !!grid.selEnd);
        pushLinkedValues(); saveWorkspace();
        break;
      case 'F2':
        e.preventDefault();
        startEditing(r, c);
        break;
      default:
        // Start typing directly into cell
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          startEditing(r, c);
          // Clear cell content and set to the typed char
          const td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
          if (td) {
            td.textContent = e.key;
            var rng = document.createRange();
            var sel = window.getSelection();
            rng.selectNodeContents(td);
            rng.collapse(false);
            sel.removeAllRanges();
            sel.addRange(rng);
          }
          // If user started with '=', enter ref mode
          if (e.key === '=') {
            enterRefMode('cell');
          }
        }
        break;
    }
  }

  function handleFormulaBarFocus() {
    if (grid.editing) {
      commitEdit(grid.editing.r, grid.editing.c);
    }
  }

  function handleFormulaBarInput(e) {
    const content = formulaBar.value;
    // Detect if we're starting a formula
    if (content === '=') {
      enterRefMode('formulaBar');
    } else if (grid.refMode && content && !content.startsWith('=')) {
      // User cleared the '=', exit ref mode
      exitRefMode();
    } else if (grid.refMode) {
      // Update highlights as user types
      updateRefModeUI();
    }
  }

  // ── Column Resize ──────────────────────────────────────────

  let resizing = null;
  let _resizeTip = null; // floating "120px" label that tracks the cursor

  function ensureResizeTip() {
    if (_resizeTip) return _resizeTip;
    _resizeTip = document.createElement('div');
    _resizeTip.className = 'ws-resize-tip';
    document.body.appendChild(_resizeTip);
    return _resizeTip;
  }
  function showResizeTip(x, y, text) {
    var t = ensureResizeTip();
    t.textContent = text;
    t.style.left = (x + 14) + 'px';
    t.style.top = (y + 14) + 'px';
    t.style.display = 'block';
  }
  function hideResizeTip() { if (_resizeTip) _resizeTip.style.display = 'none'; }

  // ── Exact-geometry invalidation (S4) ───────────────────────
  // Imported sheets carry Excel's native units (sheet.colWch in
  // characters, sheet.rowHpt in points) so export round-trips widths
  // bit-exactly. The moment the user resizes in-app, px becomes the
  // source of truth for that column/row — drop the stored Excel unit
  // so export falls back to the canonical px conversion instead of
  // resurrecting the stale imported size.
  function dropColWch(c) {
    var sh = activeSheet();
    if (sh && sh.colWch) {
      if (c == null) sh.colWch = {};
      else delete sh.colWch[c];
    }
  }
  function dropRowHpt(r) {
    var sh = activeSheet();
    if (sh && sh.rowHpt) {
      if (r == null) sh.rowHpt = {};
      else delete sh.rowHpt[r];
    }
  }

  function handleColResizeStart(e) {
    if (!e.target.classList.contains('ws-col-header')) return;
    const rect = e.target.getBoundingClientRect();
    const c = parseInt(e.target.dataset.col);
    // Right 6px is the resize handle; everywhere else on the header
    // becomes a column-select click. Shift-click extends from the
    // current selection.
    if (e.clientX > rect.right - 6) {
      e.preventDefault();
      resizing = {
        col: c,
        startX: e.clientX,
        startWidth: grid.colWidths[c] || COL_DEFAULT_WIDTH
      };
      document.body.style.cursor = 'col-resize';
      showResizeTip(e.clientX, e.clientY, resizing.startWidth + 'px');
    } else if (!isNaN(c)) {
      e.preventDefault();
      selectFullColumn(c, e.shiftKey);
    }
  }

  function handleColResizeMove(e) {
    if (!resizing) return;
    const newWidth = Math.max(40, resizing.startWidth + (e.clientX - resizing.startX));
    grid.colWidths[resizing.col] = newWidth;
    const th = wsTable.querySelector(`th[data-col="${resizing.col}"]`);
    if (th) { th.style.width = newWidth + 'px'; th.style.minWidth = newWidth + 'px'; }
    wsTable.querySelectorAll(`td[data-c="${resizing.col}"]`).forEach(td => {
      td.style.width = newWidth + 'px';
      td.style.minWidth = newWidth + 'px';
    });
    showResizeTip(e.clientX, e.clientY, Math.round(newWidth) + 'px');
  }

  function handleColResizeEnd() {
    if (resizing) {
      dropColWch(resizing.col);
      resizing = null;
      document.body.style.cursor = '';
      hideResizeTip();
      saveWorkspace();
    }
  }

  // ── Click-to-select whole column / row ─────────────────────
  function selectFullColumn(c, extend) {
    if (grid.editing) commitEdit(grid.editing.r, grid.editing.c);
    var lastRow = grid.rows - 1;
    if (extend && grid.selection) {
      grid.selEnd = { r: lastRow, c: c };
      selectCell(grid.selection.r, grid.selection.c, true);
    } else {
      grid.selection = { r: 0, c: c };
      grid.selEnd = { r: lastRow, c: c };
      selectCell(0, c, true);
    }
  }
  function selectFullRow(r, extend) {
    if (grid.editing) commitEdit(grid.editing.r, grid.editing.c);
    var lastCol = grid.cols - 1;
    if (extend && grid.selection) {
      grid.selEnd = { r: r, c: lastCol };
      selectCell(grid.selection.r, grid.selection.c, true);
    } else {
      grid.selection = { r: r, c: 0 };
      grid.selEnd = { r: r, c: lastCol };
      selectCell(r, 0, true);
    }
  }

  // ── Row Resize ────────────────────────────────────────────
  // Mirrors the column resize pattern. Drag handle is the .ws-row-resize
  // strip rendered at the bottom of each row header.
  let rowResizing = null;
  function handleRowResizeStart(e) {
    // Row resize: click the bottom-edge strip (.ws-row-resize). Plain
    // click on the row header itself becomes a row-select instead.
    const handle = e.target.classList && e.target.classList.contains('ws-row-resize');
    if (handle) {
      e.preventDefault();
      e.stopPropagation();
      const r = parseInt(e.target.dataset.row);
      rowResizing = {
        row: r,
        startY: e.clientY,
        startHeight: grid.rowHeights[r] || ROW_HEIGHT
      };
      document.body.style.cursor = 'row-resize';
      showResizeTip(e.clientX, e.clientY, rowResizing.startHeight + 'px');
      return;
    }
    const rowH = e.target.closest && e.target.closest('td.ws-row-header');
    if (rowH) {
      const r2 = parseInt(rowH.dataset.row);
      if (!isNaN(r2)) {
        e.preventDefault();
        selectFullRow(r2, e.shiftKey);
      }
    }
  }
  function handleRowResizeMove(e) {
    if (!rowResizing) return;
    const newHeight = Math.max(18, rowResizing.startHeight + (e.clientY - rowResizing.startY));
    grid.rowHeights[rowResizing.row] = newHeight;
    const tbody = wsTable.querySelector('tbody');
    if (tbody && tbody.rows[rowResizing.row]) {
      tbody.rows[rowResizing.row].style.height = newHeight + 'px';
    }
    showResizeTip(e.clientX, e.clientY, Math.round(newHeight) + 'px');
  }
  function handleRowResizeEnd() {
    if (rowResizing) {
      dropRowHpt(rowResizing.row);
      rowResizing = null;
      document.body.style.cursor = '';
      hideResizeTip();
      grid.dirty = true;
      saveWorkspace();
    }
  }

  // ── AutoFit + Resize All (rows + columns) ─────────────────
  // Excel's double-click-the-handle gesture: measure each cell's content
  // height, pick the tallest, set rowHeights[r] to that. For columns,
  // measure the longest rendered text and set width accordingly.

  // AutoFit one row's height. Strategy: probe rendered cell scrollHeight
  // since the browser already knows what a cell needs. Falls back to a
  // line-count heuristic for non-rendered cells.
  function autoFitRow(r) {
    const tbody = wsTable && wsTable.querySelector('tbody');
    let maxH = ROW_HEIGHT;
    if (tbody && tbody.rows[r]) {
      const tr = tbody.rows[r];
      // Temporarily release the explicit height so the row collapses to
      // content size; capture, then restore the explicit value.
      const oldHeight = tr.style.height;
      tr.style.height = '';
      const measured = tr.getBoundingClientRect().height;
      tr.style.height = oldHeight;
      maxH = Math.max(ROW_HEIGHT, Math.ceil(measured));
    }
    if (maxH === ROW_HEIGHT) {
      delete grid.rowHeights[r];
    } else {
      grid.rowHeights[r] = maxH;
    }
    dropRowHpt(r);
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function autoFitAllRows() {
    for (let r = 0; r < grid.rows; r++) {
      autoFitRowSilent(r);
    }
    dropRowHpt(null);
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }
  // Variant that skips the per-row save / re-render — caller does it once.
  function autoFitRowSilent(r) {
    const tbody = wsTable && wsTable.querySelector('tbody');
    let maxH = ROW_HEIGHT;
    if (tbody && tbody.rows[r]) {
      const tr = tbody.rows[r];
      const oldHeight = tr.style.height;
      tr.style.height = '';
      const measured = tr.getBoundingClientRect().height;
      tr.style.height = oldHeight;
      maxH = Math.max(ROW_HEIGHT, Math.ceil(measured));
    }
    if (maxH === ROW_HEIGHT) delete grid.rowHeights[r];
    else grid.rowHeights[r] = maxH;
  }

  // Apply one fixed height to every row in the sheet. Excel's "Resize
  // all rows" with a manual value.
  function setAllRowHeights(height) {
    const h = Math.max(18, Number(height) || ROW_HEIGHT);
    if (h === ROW_HEIGHT) {
      grid.rowHeights = {};
    } else {
      const out = {};
      for (let r = 0; r < grid.rows; r++) out[r] = h;
      grid.rowHeights = out;
    }
    dropRowHpt(null);
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function setRowHeight(r, height) {
    const h = Math.max(18, Number(height) || ROW_HEIGHT);
    if (h === ROW_HEIGHT) delete grid.rowHeights[r];
    else grid.rowHeights[r] = h;
    dropRowHpt(r);
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  // Column equivalents — Excel parity. Width-of-content via temporary
  // measurement of an off-screen probe element.
  function autoFitColumn(c) {
    let maxW = 60;
    // Measure every cell that's rendered in this column. scrollWidth
    // already accounts for the rendered text including font metrics.
    if (wsTable) {
      wsTable.querySelectorAll('td[data-c="' + c + '"]').forEach(function(td) {
        const old = td.style.width;
        const oldMin = td.style.minWidth;
        td.style.width = ''; td.style.minWidth = '';
        const w = td.scrollWidth;
        td.style.width = old; td.style.minWidth = oldMin;
        if (w > maxW) maxW = w;
      });
      // And the column header
      const th = wsTable.querySelector('th[data-col="' + c + '"]');
      if (th && th.scrollWidth > maxW) maxW = th.scrollWidth;
    }
    grid.colWidths[c] = Math.max(60, Math.ceil(maxW + 12)); // 12px breathing room
    dropColWch(c);
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function autoFitAllColumns() {
    for (let c = 0; c < grid.cols; c++) {
      autoFitColumnSilent(c);
    }
    dropColWch(null);
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }
  function autoFitColumnSilent(c) {
    let maxW = 60;
    if (wsTable) {
      wsTable.querySelectorAll('td[data-c="' + c + '"]').forEach(function(td) {
        const old = td.style.width;
        const oldMin = td.style.minWidth;
        td.style.width = ''; td.style.minWidth = '';
        const w = td.scrollWidth;
        td.style.width = old; td.style.minWidth = oldMin;
        if (w > maxW) maxW = w;
      });
      const th = wsTable.querySelector('th[data-col="' + c + '"]');
      if (th && th.scrollWidth > maxW) maxW = th.scrollWidth;
    }
    grid.colWidths[c] = Math.max(60, Math.ceil(maxW + 12));
  }

  function setAllColWidths(width) {
    const w = Math.max(40, Number(width) || COL_DEFAULT_WIDTH);
    if (w === COL_DEFAULT_WIDTH) {
      grid.colWidths = {};
    } else {
      const out = {};
      for (let c = 0; c < grid.cols; c++) out[c] = w;
      grid.colWidths = out;
    }
    dropColWch(null);
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function setColumnWidth(c, width) {
    const w = Math.max(40, Number(width) || COL_DEFAULT_WIDTH);
    if (w === COL_DEFAULT_WIDTH) delete grid.colWidths[c];
    else grid.colWidths[c] = w;
    dropColWch(c);
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  window.wsAutoFitRow = autoFitRow;
  window.wsAutoFitAllRows = autoFitAllRows;
  window.wsSetAllRowHeights = setAllRowHeights;
  window.wsSetRowHeight = setRowHeight;
  window.wsAutoFitColumn = autoFitColumn;
  window.wsAutoFitAllColumns = autoFitAllColumns;
  window.wsSetAllColWidths = setAllColWidths;
  window.wsSetColumnWidth = setColumnWidth;

  // ── Tables ────────────────────────────────────────────────
  // Tables are styled rectangular ranges. The cell renderer asks
  // getTableStyleForCell(r, c) for each cell; if the cell falls inside
  // a registered table, we tag it with two CSS classes:
  //   ws-table-<styleName>   (e.g., ws-table-classic)
  //   ws-table-<role>        (header / body-even / body-odd / total)
  // Style + role compose to give banded rows, header bar, total row.
  const TABLE_STYLES = ['classic', 'professional', 'minimal', 'bold', 'colorful', 'finance'];
  function getTableStyleForCell(r, c) {
    if (!grid.tables || !grid.tables.length) return null;
    for (const t of grid.tables) {
      if (r >= t.r1 && r <= t.r2 && c >= t.c1 && c <= t.c2) {
        let role;
        if (r === t.r1) role = 'header';
        else if (t.totalRow && r === t.r2) role = 'total';
        else role = ((r - t.r1) % 2 === 1) ? 'body-odd' : 'body-even';
        return { style: t.style || 'classic', role: role };
      }
    }
    return null;
  }

  // Convert the current selection range into a table. Prompts for a
  // style; the range is registered in grid.tables and re-rendered with
  // header / banded-body classes.
  function makeTable(style) {
    const rng = getSelRange();
    if (!rng || (rng.r1 === rng.r2 && rng.c1 === rng.c2)) {
      alert('Select a range of at least 2 rows × 2 columns first.');
      return;
    }
    style = style || 'classic';
    if (TABLE_STYLES.indexOf(style) === -1) style = 'classic';
    // Remove any overlapping tables before adding the new one — only
    // one table per range to keep semantics simple.
    grid.tables = (grid.tables || []).filter(function(t) {
      return rng.r2 < t.r1 || rng.r1 > t.r2 || rng.c2 < t.c1 || rng.c1 > t.c2;
    });
    grid.tables.push({
      r1: rng.r1, c1: rng.c1, r2: rng.r2, c2: rng.c2,
      style: style,
      totalRow: false
    });
    pushUndo();
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function changeTableStyle(style) {
    if (!grid.selection || !grid.tables || !grid.tables.length) return;
    for (const t of grid.tables) {
      if (grid.selection.r >= t.r1 && grid.selection.r <= t.r2 &&
          grid.selection.c >= t.c1 && grid.selection.c <= t.c2) {
        t.style = style;
        grid.dirty = true;
        renderGrid();
        saveWorkspace();
        return;
      }
    }
  }

  function removeTable() {
    if (!grid.selection || !grid.tables) return;
    const before = grid.tables.length;
    grid.tables = grid.tables.filter(function(t) {
      return !(grid.selection.r >= t.r1 && grid.selection.r <= t.r2 &&
               grid.selection.c >= t.c1 && grid.selection.c <= t.c2);
    });
    if (grid.tables.length !== before) {
      pushUndo();
      grid.dirty = true;
      renderGrid();
      saveWorkspace();
    }
  }

  function toggleTotalRow() {
    if (!grid.selection || !grid.tables) return;
    for (const t of grid.tables) {
      if (grid.selection.r >= t.r1 && grid.selection.r <= t.r2 &&
          grid.selection.c >= t.c1 && grid.selection.c <= t.c2) {
        t.totalRow = !t.totalRow;
        grid.dirty = true;
        renderGrid();
        saveWorkspace();
        return;
      }
    }
  }

  // Picker UI for "Make Table" — small popover with the 6 styles
  function openTableStylePicker(anchor) {
    const existing = document.getElementById('wsTableStylePicker');
    if (existing) existing.remove();
    const pop = document.createElement('div');
    pop.id = 'wsTableStylePicker';
    pop.style.cssText = 'position:fixed;background:var(--surface,#181820);border:1px solid var(--border,#333);border-radius:8px;padding:8px;z-index:1500;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;';
    const labels = {
      classic: 'Classic',
      professional: 'Professional',
      minimal: 'Minimal',
      bold: 'Bold',
      colorful: 'Colorful',
      finance: 'Finance'
    };
    TABLE_STYLES.forEach(function(s) {
      const btn = document.createElement('button');
      btn.className = 'ws-btn ws-table-style-' + s;
      btn.style.cssText = 'padding:8px 12px;font-size:11px;min-width:90px;';
      btn.textContent = labels[s];
      btn.onclick = function() { makeTable(s); pop.remove(); };
      pop.appendChild(btn);
    });
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';
    // Close when clicking outside
    setTimeout(function() {
      function offClick(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', offClick); }
      }
      document.addEventListener('mousedown', offClick);
    }, 0);
  }

  // ── Sort Range ────────────────────────────────────────────
  // Sort the cells in the selected range by the column the active cell
  // is in. Header row (top of selection) is preserved when the option is on.
  function sortSelection(direction, hasHeader) {
    const rng = getSelRange();
    if (!rng || rng.r1 === rng.r2) {
      alert('Select a multi-row range to sort.');
      return;
    }
    const sortCol = grid.selection.c;
    const startRow = hasHeader ? rng.r1 + 1 : rng.r1;
    if (startRow >= rng.r2) return;
    pushUndo();
    // Pull every row's cells into an array
    const rows = [];
    for (let r = startRow; r <= rng.r2; r++) {
      const row = [];
      for (let c = rng.c1; c <= rng.c2; c++) {
        const a = addr(r, c);
        row.push(grid.cells[a] ? Object.assign({}, grid.cells[a]) : null);
      }
      rows.push(row);
    }
    const sortColRel = sortCol - rng.c1;
    rows.sort(function(a, b) {
      const av = a[sortColRel] ? a[sortColRel].value : '';
      const bv = b[sortColRel] ? b[sortColRel].value : '';
      const an = Number(av), bn = Number(bv);
      const bothNum = !isNaN(an) && !isNaN(bn) && av !== '' && bv !== '';
      let cmp;
      if (bothNum) cmp = an - bn;
      else cmp = String(av).localeCompare(String(bv));
      return direction === 'desc' ? -cmp : cmp;
    });
    // Write back
    for (let i = 0; i < rows.length; i++) {
      const r = startRow + i;
      for (let cIdx = 0; cIdx < rows[i].length; cIdx++) {
        const c = rng.c1 + cIdx;
        const a = addr(r, c);
        if (rows[i][cIdx]) grid.cells[a] = rows[i][cIdx];
        else delete grid.cells[a];
      }
    }
    grid.dirty = true;
    recalcAll();
    renderGrid();
    selectCell(rng.r1, rng.c1);
    saveWorkspace();
  }

  // ── AutoFilter (Phase 2.4) ─────────────────────────────────
  // sheet.autoFilter = { r1, r2, c1, c2, filters: { <col>: [allowed strings] } }
  //   r1   header row index (gets the filter dropdown buttons)
  //   r2   last data row
  //   c1,c2 column span
  //   filters[col] present → only rows whose display value in that col is
  //   in the allowed list stay visible. Absent → column unfiltered.

  function getAutoFilter() {
    var sheet = activeSheet();
    return (sheet && sheet.autoFilter) ? sheet.autoFilter : null;
  }

  // Bounding box of all non-empty cells — used when AutoFilter is toggled
  // on a single-cell selection (mirror Excel's "current region" guess).
  function computeUsedRange() {
    var r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1;
    Object.keys(grid.cells).forEach(function (a) {
      var cell = grid.cells[a];
      var hasContent = cell && (cell.raw !== '' && cell.raw != null);
      if (!hasContent) return;
      var ref = parseAddr(a);
      if (!ref) return;
      if (ref.r < r1) r1 = ref.r;
      if (ref.c < c1) c1 = ref.c;
      if (ref.r > r2) r2 = ref.r;
      if (ref.c > c2) c2 = ref.c;
    });
    if (r2 < 0) return null;
    return { r1: r1, c1: c1, r2: r2, c2: c2 };
  }

  // Compute the set of data rows hidden by the active filters.
  function computeFilterHiddenRows() {
    var af = getAutoFilter();
    var hidden = {};
    if (!af || !af.filters) return hidden;
    var cols = Object.keys(af.filters);
    if (!cols.length) return hidden;
    for (var r = af.r1 + 1; r <= af.r2; r++) {
      var show = true;
      for (var i = 0; i < cols.length; i++) {
        var col = parseInt(cols[i], 10);
        var allowed = af.filters[cols[i]];
        if (!Array.isArray(allowed)) continue;
        var cell = grid.cells[addr(r, col)];
        var v = cell ? String(displayVal(cell)) : '';
        if (allowed.indexOf(v) === -1) { show = false; break; }
      }
      if (!show) hidden[r] = true;
    }
    return hidden;
  }

  window.wsToggleAutoFilter = function () {
    var sheet = activeSheet();
    if (!sheet || isEmbedSheet(sheet)) return;
    if (sheet.autoFilter) {
      // Turn off — drop filters and unhide everything.
      delete sheet.autoFilter;
      grid.dirty = true;
      renderGrid();
      if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
      saveWorkspace();
      return;
    }
    // Turn on — span the selection, or the used range for a 1×1 selection.
    var rng = getSelRange();
    if (rng && (rng.r1 !== rng.r2 || rng.c1 !== rng.c2)) {
      sheet.autoFilter = { r1: rng.r1, r2: rng.r2, c1: rng.c1, c2: rng.c2, filters: {} };
    } else {
      var used = computeUsedRange();
      if (!used) { alert('Nothing to filter — the sheet is empty.'); return; }
      sheet.autoFilter = { r1: used.r1, r2: used.r2, c1: used.c1, c2: used.c2, filters: {} };
    }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  };

  // Filter dropdown popup for one column.
  var _filterPopupEl = null;
  function closeFilterPopup() {
    if (_filterPopupEl && _filterPopupEl.parentNode) _filterPopupEl.parentNode.removeChild(_filterPopupEl);
    _filterPopupEl = null;
    document.removeEventListener('mousedown', _filterOutsideHandler, true);
  }
  function _filterOutsideHandler(e) {
    if (_filterPopupEl && !_filterPopupEl.contains(e.target) &&
        !(e.target.classList && e.target.classList.contains('ws-filter-btn'))) {
      closeFilterPopup();
    }
  }
  function openFilterPopup(col, btnEl) {
    closeFilterPopup();
    var af = getAutoFilter();
    if (!af) return;
    // Collect unique display values for this column across the data rows.
    var seen = {};
    var uniques = [];
    for (var r = af.r1 + 1; r <= af.r2; r++) {
      var cell = grid.cells[addr(r, col)];
      var v = cell ? String(displayVal(cell)) : '';
      if (!(v in seen)) { seen[v] = true; uniques.push(v); }
    }
    uniques.sort(function (a, b) {
      var an = Number(a), bn = Number(b);
      if (!isNaN(an) && !isNaN(bn) && a !== '' && b !== '') return an - bn;
      return String(a).localeCompare(String(b));
    });
    var current = af.filters[col]; // array of allowed, or undefined = all
    var pop = document.createElement('div');
    pop.className = 'ws-filter-popup';
    pop.style.cssText = 'position:fixed;background:var(--surface,#181820);border:1px solid var(--border,#333);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:1600;width:220px;font-size:12px;padding:8px;';
    var optsHtml = uniques.map(function (v, i) {
      var checked = !current || current.indexOf(v) !== -1;
      var label = (v === '') ? '(Blanks)' : escapeHTML(v);
      return '<label style="display:flex;align-items:center;gap:6px;padding:3px 4px;cursor:pointer;">' +
        '<input type="checkbox" class="ws-filter-opt" data-val="' + escapeHTML(v) + '"' + (checked ? ' checked' : '') + ' /> ' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</span></label>';
    }).join('');
    pop.innerHTML =
      '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
        '<button class="ws-btn" id="wsFilterSortAsc" style="flex:1;padding:3px 6px;">A→Z</button>' +
        '<button class="ws-btn" id="wsFilterSortDesc" style="flex:1;padding:3px 6px;">Z→A</button>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid var(--grid-border);margin-bottom:4px;cursor:pointer;font-weight:600;">' +
        '<input type="checkbox" id="wsFilterAll" checked /> (Select All)</label>' +
      '<div id="wsFilterOpts" style="max-height:200px;overflow-y:auto;">' + optsHtml + '</div>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px;">' +
        '<button class="ws-btn" id="wsFilterClear" style="padding:3px 8px;">Clear</button>' +
        '<button class="ws-btn ws-btn-primary" id="wsFilterApply" style="padding:3px 8px;">OK</button>' +
      '</div>';
    document.body.appendChild(pop);
    var rect = btnEl.getBoundingClientRect();
    var left = Math.min(rect.left, window.innerWidth - 230);
    pop.style.left = Math.max(4, left) + 'px';
    pop.style.top = rect.bottom + 'px';
    _filterPopupEl = pop;

    function syncAll() {
      var boxes = pop.querySelectorAll('.ws-filter-opt');
      var all = pop.querySelector('#wsFilterAll');
      var checkedCount = 0;
      boxes.forEach(function (b) { if (b.checked) checkedCount++; });
      all.checked = checkedCount === boxes.length;
      all.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
    }
    pop.querySelector('#wsFilterAll').addEventListener('change', function (e) {
      pop.querySelectorAll('.ws-filter-opt').forEach(function (b) { b.checked = e.target.checked; });
    });
    pop.querySelectorAll('.ws-filter-opt').forEach(function (b) {
      b.addEventListener('change', syncAll);
    });
    syncAll();

    pop.querySelector('#wsFilterApply').addEventListener('click', function () {
      var boxes = pop.querySelectorAll('.ws-filter-opt');
      var allowed = [];
      boxes.forEach(function (b) { if (b.checked) allowed.push(b.dataset.val); });
      if (allowed.length === uniques.length) {
        delete af.filters[col]; // all selected = no filter
      } else {
        af.filters[col] = allowed;
      }
      grid.dirty = true;
      renderGrid();
      if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
      saveWorkspace();
      closeFilterPopup();
    });
    pop.querySelector('#wsFilterClear').addEventListener('click', function () {
      delete af.filters[col];
      grid.dirty = true;
      renderGrid();
      if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
      saveWorkspace();
      closeFilterPopup();
    });
    pop.querySelector('#wsFilterSortAsc').addEventListener('click', function () {
      _sortAutoFilterRange(col, 'asc');
      closeFilterPopup();
    });
    pop.querySelector('#wsFilterSortDesc').addEventListener('click', function () {
      _sortAutoFilterRange(col, 'desc');
      closeFilterPopup();
    });
    setTimeout(function () { document.addEventListener('mousedown', _filterOutsideHandler, true); }, 0);
  }

  // Sort the AutoFilter data rows by one column, keeping the header fixed.
  function _sortAutoFilterRange(col, direction) {
    var af = getAutoFilter();
    if (!af) return;
    var startRow = af.r1 + 1;
    if (startRow >= af.r2) return;
    pushUndo();
    var rows = [];
    for (var r = startRow; r <= af.r2; r++) {
      var row = [];
      for (var c = af.c1; c <= af.c2; c++) {
        var a = addr(r, c);
        row.push(grid.cells[a] ? Object.assign({}, grid.cells[a]) : null);
      }
      rows.push(row);
    }
    var colRel = col - af.c1;
    rows.sort(function (a, b) {
      var av = a[colRel] ? a[colRel].value : '';
      var bv = b[colRel] ? b[colRel].value : '';
      var an = Number(av), bn = Number(bv);
      var bothNum = !isNaN(an) && !isNaN(bn) && av !== '' && bv !== '';
      var cmp = bothNum ? (an - bn) : String(av).localeCompare(String(bv));
      return direction === 'desc' ? -cmp : cmp;
    });
    for (var i = 0; i < rows.length; i++) {
      var rr = startRow + i;
      for (var cIdx = 0; cIdx < rows[i].length; cIdx++) {
        var cc = af.c1 + cIdx;
        var aa = addr(rr, cc);
        if (rows[i][cIdx]) grid.cells[aa] = rows[i][cIdx];
        else delete grid.cells[aa];
      }
    }
    grid.dirty = true;
    recalcAll();
    renderGrid();
    saveWorkspace();
  }

  // ── AutoSum ───────────────────────────────────────────────
  // Inserts =SUM(...) at the active cell, auto-detecting a contiguous
  // range of numeric cells immediately above (preferred) or to the left.
  function autoSum() {
    if (!grid.selection) return;
    const r = grid.selection.r, c = grid.selection.c;
    // Probe upward first
    let above = 0;
    for (let i = r - 1; i >= 0; i--) {
      const v = (grid.cells[addr(i, c)] || {}).value;
      if (v === '' || v == null || isNaN(Number(v))) break;
      above++;
    }
    let formula;
    if (above >= 1) {
      formula = '=SUM(' + addr(r - above, c) + ':' + addr(r - 1, c) + ')';
    } else {
      // Probe leftward
      let left = 0;
      for (let i = c - 1; i >= 0; i--) {
        const v = (grid.cells[addr(r, i)] || {}).value;
        if (v === '' || v == null || isNaN(Number(v))) break;
        left++;
      }
      if (left >= 1) {
        formula = '=SUM(' + addr(r, c - left) + ':' + addr(r, c - 1) + ')';
      } else {
        formula = '=SUM()';
      }
    }
    pushUndo();
    grid.cells[addr(r, c)] = { raw: formula, value: '', style: (grid.cells[addr(r, c)] || {}).style || {} };
    grid.dirty = true;
    recalcAll();
    renderGrid();
    selectCell(r, c);
    // Drop into edit mode so the user can tweak before committing
    startEditing(r, c);
    saveWorkspace();
  }

  // ── Find & Replace ────────────────────────────────────────
  // Lightweight modal — searches every sheet in the workbook, jumps to
  // each match in turn, optionally replaces.
  let _findState = { query: '', matches: [], idx: 0, caseSensitive: false };

  function openFindReplace() {
    const existing = document.getElementById('wsFindReplace');
    if (existing) { existing.style.display = 'block'; document.getElementById('wsFindInput').focus(); return; }
    const pop = document.createElement('div');
    pop.id = 'wsFindReplace';
    pop.style.cssText = 'position:fixed;top:80px;right:30px;background:var(--surface,#181820);border:1px solid var(--border,#333);border-radius:8px;padding:14px 16px;z-index:1500;box-shadow:0 8px 24px rgba(0,0,0,0.5);width:340px;font-size:12px;';
    pop.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
        '<strong style="font-size:13px;">Find &amp; Replace</strong>' +
        '<button class="ws-btn" onclick="document.getElementById(\'wsFindReplace\').style.display=\'none\';" style="padding:2px 8px;">×</button>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
        '<input type="text" id="wsFindInput" placeholder="Find what" style="padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
        '<input type="text" id="wsReplaceInput" placeholder="Replace with" style="padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
        '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim,#aaa);text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;">' +
          '<input type="checkbox" id="wsFindCase" /> Match case' +
        '</label>' +
        '<div id="wsFindStatus" style="font-size:11px;color:var(--text-dim,#aaa);min-height:15px;"></div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button class="ws-btn" onclick="window.wsFindNext()">Find Next</button>' +
          '<button class="ws-btn" onclick="window.wsReplaceCurrent()">Replace</button>' +
          '<button class="ws-btn" onclick="window.wsReplaceAll()">Replace All</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(pop);
    document.getElementById('wsFindInput').addEventListener('input', function(e) {
      _findState.query = e.target.value;
      _findState.matches = [];
      _findState.idx = 0;
    });
    document.getElementById('wsFindInput').focus();
  }

  function findAllMatches() {
    const q = _findState.query;
    if (!q) return [];
    const cs = !!document.getElementById('wsFindCase')?.checked;
    const matches = [];
    workbook.sheets.forEach(function(sheet) {
      Object.keys(sheet.cells).forEach(function(addr) {
        const v = String(sheet.cells[addr].value || sheet.cells[addr].raw || '');
        const haystack = cs ? v : v.toLowerCase();
        const needle = cs ? q : q.toLowerCase();
        if (haystack.indexOf(needle) !== -1) matches.push({ sheetId: sheet.id, addr: addr });
      });
    });
    return matches;
  }

  window.wsFindNext = function() {
    if (!_findState.query) return;
    if (!_findState.matches.length) {
      _findState.matches = findAllMatches();
      _findState.idx = 0;
    }
    const status = document.getElementById('wsFindStatus');
    if (!_findState.matches.length) {
      if (status) status.textContent = 'No matches.';
      return;
    }
    const m = _findState.matches[_findState.idx];
    if (m.sheetId !== workbook.activeSheetId) switchSheet(m.sheetId);
    const ref = parseAddr(m.addr);
    if (ref) selectCell(ref.r, ref.c);
    _findState.idx = (_findState.idx + 1) % _findState.matches.length;
    if (status) status.textContent = (_findState.idx === 0 ? _findState.matches.length : _findState.idx) +
      ' of ' + _findState.matches.length;
  };

  window.wsReplaceCurrent = function() {
    if (!grid.selection || !_findState.query) return;
    const a = addr(grid.selection.r, grid.selection.c);
    const cell = grid.cells[a];
    if (!cell) return;
    const replaceWith = document.getElementById('wsReplaceInput').value || '';
    const cs = !!document.getElementById('wsFindCase')?.checked;
    const raw = String(cell.raw != null ? cell.raw : cell.value);
    const re = new RegExp(_findState.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? '' : 'i');
    if (!re.test(raw)) return;
    pushUndo();
    grid.cells[a] = Object.assign({}, cell, { raw: raw.replace(re, replaceWith) });
    grid.dirty = true;
    recalcAll();
    renderGrid();
    saveWorkspace();
    _findState.matches = []; // refresh on next find-next
    window.wsFindNext();
  };

  window.wsReplaceAll = function() {
    if (!_findState.query) return;
    const replaceWith = document.getElementById('wsReplaceInput').value || '';
    const cs = !!document.getElementById('wsFindCase')?.checked;
    const re = new RegExp(_findState.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      cs ? 'g' : 'gi');
    let count = 0;
    pushUndo();
    workbook.sheets.forEach(function(sheet) {
      Object.keys(sheet.cells).forEach(function(addr) {
        const cell = sheet.cells[addr];
        const raw = String(cell.raw != null ? cell.raw : cell.value);
        if (re.test(raw)) {
          sheet.cells[addr] = Object.assign({}, cell, { raw: raw.replace(re, replaceWith) });
          count++;
        }
      });
    });
    syncGridToActiveSheet();
    loadSheetIntoGrid(workbook.sheets.find(s => s.id === workbook.activeSheetId));
    grid.dirty = true;
    recalcAll();
    renderGrid();
    saveWorkspace();
    const status = document.getElementById('wsFindStatus');
    if (status) status.textContent = 'Replaced ' + count + ' match' + (count === 1 ? '' : 'es') + '.';
    _findState.matches = [];
  };

  // ── Custom Number Format editor ───────────────────────────
  // Excel-style "Format Cells → Number" dialog. Presets cover the common
  // cases; a custom box accepts any format string our applyExcelNumFmt
  // renderer understands (sections, digit placeholders, color brackets,
  // date tokens). Writes cell.numFmt onto every cell in the selection and
  // clears the legacy cell.fmt enum so the two systems never fight.
  var NUMFMT_PRESETS = [
    { label: 'General',           code: '' },
    { label: 'Number',            code: '#,##0.00' },
    { label: 'Number (no comma)', code: '0.00' },
    { label: 'Currency',          code: '"$"#,##0.00' },
    { label: 'Currency (red −)',  code: '"$"#,##0.00;[Red]-"$"#,##0.00' },
    { label: 'Accounting',        code: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_)' },
    { label: 'Percent',           code: '0.00%' },
    { label: 'Percent (0 dp)',    code: '0%' },
    { label: 'Thousands',         code: '#,##0' },
    { label: 'Scientific',        code: '0.00E+00' },
    { label: 'Short Date',        code: 'm/d/yyyy' },
    { label: 'Long Date',         code: 'mmmm d, yyyy' },
    { label: 'Time',              code: 'h:mm:ss AM/PM' },
    { label: 'Date & Time',       code: 'm/d/yyyy h:mm' }
  ];

  function _numFmtSampleValue() {
    // Prefer the active cell's numeric value so the preview is meaningful;
    // otherwise fall back to a representative number.
    if (grid && grid.selection) {
      var c = getCell(grid.selection.r, grid.selection.c);
      if (c && typeof c.value === 'number' && isFinite(c.value)) return c.value;
    }
    return 1234.567;
  }

  function _numFmtRenderPreview() {
    var input = document.getElementById('wsNumFmtCode');
    var out = document.getElementById('wsNumFmtPreview');
    if (!input || !out) return;
    var code = input.value || '';
    var sample = _numFmtSampleValue();
    var shown;
    if (!code) {
      shown = (typeof sample === 'number') ? String(sample) : String(sample || '');
    } else {
      try {
        var r = applyExcelNumFmt(sample, code);
        shown = (r == null) ? '(invalid format)' : r;
      } catch (e) {
        shown = '(invalid format)';
      }
    }
    out.textContent = shown;
  }

  function openNumFmtEditor() {
    var existing = document.getElementById('wsNumFmt');
    if (existing) { existing.style.display = 'block'; }
    else {
      var pop = document.createElement('div');
      pop.id = 'wsNumFmt';
      pop.style.cssText = 'position:fixed;top:80px;right:30px;background:var(--surface,#181820);border:1px solid var(--border,#333);border-radius:8px;padding:14px 16px;z-index:1500;box-shadow:0 8px 24px rgba(0,0,0,0.5);width:320px;font-size:12px;';
      var presetOpts = NUMFMT_PRESETS.map(function(p, i) {
        return '<option value="' + i + '">' + escapeHTML(p.label) + '</option>';
      }).join('');
      pop.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<strong style="font-size:13px;">Number Format</strong>' +
          '<button class="ws-btn" onclick="document.getElementById(\'wsNumFmt\').style.display=\'none\';" style="padding:2px 8px;">×</button>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<label style="font-size:11px;color:var(--text-dim,#aaa);">Preset' +
            '<select id="wsNumFmtPreset" style="width:100%;margin-top:3px;padding:6px 8px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);">' +
              presetOpts +
            '</select>' +
          '</label>' +
          '<label style="font-size:11px;color:var(--text-dim,#aaa);">Format code' +
            '<input type="text" id="wsNumFmtCode" placeholder="e.g. #,##0.00" style="width:100%;margin-top:3px;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);font-family:monospace;" />' +
          '</label>' +
          '<div style="font-size:11px;color:var(--text-dim,#aaa);">Preview</div>' +
          '<div id="wsNumFmtPreview" style="padding:8px 10px;border:1px dashed var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);min-height:18px;font-family:monospace;text-align:right;">—</div>' +
          '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:4px;">' +
            '<button class="ws-btn" onclick="window.wsClearNumFmt()">Clear</button>' +
            '<button class="ws-btn ws-btn-primary" onclick="window.wsApplyNumFmt()">Apply</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(pop);
      var presetSel = document.getElementById('wsNumFmtPreset');
      var codeInput = document.getElementById('wsNumFmtCode');
      presetSel.addEventListener('change', function() {
        var p = NUMFMT_PRESETS[parseInt(presetSel.value, 10)];
        if (p) codeInput.value = p.code;
        _numFmtRenderPreview();
      });
      codeInput.addEventListener('input', _numFmtRenderPreview);
    }
    // Seed the code box from the active cell's current numFmt (if any).
    var codeBox = document.getElementById('wsNumFmtCode');
    if (codeBox && grid && grid.selection) {
      var cell = getCell(grid.selection.r, grid.selection.c);
      codeBox.value = (cell && cell.numFmt) ? cell.numFmt : '';
    }
    _numFmtRenderPreview();
    if (codeBox) codeBox.focus();
  }

  window.wsOpenNumFmt = openNumFmtEditor;

  window.wsApplyNumFmt = function() {
    var input = document.getElementById('wsNumFmtCode');
    if (!input) return;
    var code = (input.value || '').trim();
    var rng = getSelRange();
    if (!rng) return;
    pushUndo();
    for (var r = rng.r1; r <= rng.r2; r++) {
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        if (code) {
          cell.numFmt = code;
          // The custom string supersedes the legacy enum + decimals.
          if (cell.fmt) delete cell.fmt;
          if (cell.decimals != null) delete cell.decimals;
        } else {
          // Empty code === General: strip any custom format.
          if (cell.numFmt) delete cell.numFmt;
        }
      }
    }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  };

  window.wsClearNumFmt = function() {
    var rng = getSelRange();
    if (!rng) return;
    pushUndo();
    for (var r = rng.r1; r <= rng.r2; r++) {
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        if (cell.numFmt) delete cell.numFmt;
      }
    }
    var box = document.getElementById('wsNumFmtCode');
    if (box) box.value = '';
    _numFmtRenderPreview();
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  };

  // ── Named Ranges editor (Phase 2.7) ───────────────────────
  // A floating manager: lists every workbook-scoped name with its ref,
  // owning sheet, and optional comment; lets you add a new name (seeded
  // from the current selection) and delete existing ones. Names resolve
  // inside formulas via applyNamedRanges() (see evaluate()).

  // Build an A1 reference string for the current selection, qualified
  // with the active sheet name so the name still resolves if the user
  // is on a different sheet when the formula recalculates.
  function _selectionRefString() {
    var rng = getSelRange();
    if (!rng) return '';
    var a = colLetter(rng.c1) + (rng.r1 + 1);
    var ref = (rng.r1 === rng.r2 && rng.c1 === rng.c2)
      ? a
      : a + ':' + colLetter(rng.c2) + (rng.r2 + 1);
    var sh = activeSheet();
    if (sh) {
      var nm = /\s/.test(sh.name) ? "'" + sh.name + "'" : sh.name;
      return nm + '!' + ref;
    }
    return ref;
  }

  // Parse a bare A1 ref ("B2" or "A1:C5") into a normalized bounding
  // box {r1,c1,r2,c2}, or null if unparseable.
  function _refToBox(refStr) {
    if (!refStr) return null;
    var parts = String(refStr).replace(/\$/g, '').split(':');
    var a = parseAddr(parts[0].toUpperCase());
    if (!a) return null;
    var b = parts[1] ? parseAddr(parts[1].toUpperCase()) : a;
    if (!b) return null;
    return {
      r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c)
    };
  }

  // If the current selection on the active sheet exactly matches a named
  // range, return that name (original casing) for display in the Name Box.
  function _nameForCurrentSelection(rng) {
    if (!rng) return null;
    var names = workbook.namedRanges;
    if (!names) return null;
    var activeId = workbook.activeSheetId;
    var keys = Object.keys(names);
    for (var i = 0; i < keys.length; i++) {
      var nr = names[keys[i]];
      var nrSheet = nr.sheetId || activeId;
      if (nrSheet !== activeId) continue;
      var box = _refToBox(nr.ref);
      if (!box) continue;
      if (box.r1 === rng.r1 && box.c1 === rng.c1 && box.r2 === rng.r2 && box.c2 === rng.c2) {
        return nr.name || keys[i];
      }
    }
    return null;
  }

  // Handle Enter in the Name Box: navigate to a cell/range/named range,
  // or define a new name for the current selection when the typed token
  // is a fresh, valid name. Mirrors Excel's Name Box behavior.
  function _handleNameBoxEntry(rawVal) {
    var val = (rawVal || '').trim();
    if (!val) return;
    var names = workbook.namedRanges || {};
    // 1. Existing named range → go to it.
    if (Object.prototype.hasOwnProperty.call(names, val.toUpperCase())) {
      window.wsGotoNamedRange(encodeURIComponent(val.toUpperCase()));
      return;
    }
    // 2. Sheet-qualified or bare A1 cell / range → navigate.
    var sheetId = null, bareRef = val;
    var bang = val.lastIndexOf('!');
    if (bang !== -1) {
      var sheetName = val.slice(0, bang).replace(/^'|'$/g, '');
      bareRef = val.slice(bang + 1);
      var sh = findSheetByName(sheetName);
      if (sh) { sheetId = sh.id; }
    }
    var box = _refToBox(bareRef);
    if (box) {
      if (sheetId && sheetId !== workbook.activeSheetId) switchSheet(sheetId);
      selectCell(box.r1, box.c1);
      if (box.r2 !== box.r1 || box.c2 !== box.c1) {
        grid.selEnd = { r: box.r2, c: box.c2 };
        renderSelectionClasses();
        updateQuickCalc();
      }
      return;
    }
    // 3. A fresh, valid name → define it for the current selection.
    if (!validateRangeName(val)) {
      if (!workbook.namedRanges) workbook.namedRanges = {};
      workbook.namedRanges[val.toUpperCase()] = {
        name: val,
        ref: _selectionRefStringBare(),
        sheetId: workbook.activeSheetId,
        comment: ''
      };
      recalcAll();
      renderGrid();
      if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
      saveWorkspace();
      return;
    }
    // Otherwise: nothing matched — restore the box to the current address.
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
  }

  // Like _selectionRefString but without the sheet prefix (the name
  // stores sheetId separately, so the ref stays bare).
  function _selectionRefStringBare() {
    var rng = getSelRange();
    if (!rng) return 'A1';
    var a = colLetter(rng.c1) + (rng.r1 + 1);
    return (rng.r1 === rng.r2 && rng.c1 === rng.c2)
      ? a
      : a + ':' + colLetter(rng.c2) + (rng.r2 + 1);
  }

  // Re-render just the list portion (called after add/delete so the
  // modal updates in place without a full reopen).
  function _renderNamedRangesList() {
    var listEl = document.getElementById('wsNRList');
    if (!listEl) return;
    var names = workbook.namedRanges || {};
    var keys = Object.keys(names).sort();
    if (!keys.length) {
      listEl.innerHTML = '<div style="padding:10px;color:var(--text-dim,#aaa);text-align:center;font-style:italic;">No named ranges yet.</div>';
      return;
    }
    listEl.innerHTML = keys.map(function(k) {
      var nr = names[k];
      var displayName = nr.name || k;
      var sheetLabel = '';
      if (nr.sheetId) {
        var sh = workbook.sheets.find(function(s){ return s.id === nr.sheetId; });
        if (sh) sheetLabel = sh.name;
      }
      var refDisplay = escapeHTML(nr.ref) + (sheetLabel ? ' <span style="color:var(--text-dim,#888);">(' + escapeHTML(sheetLabel) + ')</span>' : '');
      return '<div style="display:flex;align-items:center;gap:8px;padding:5px 4px;border-bottom:1px solid var(--grid-border);">' +
        '<div style="flex:0 0 34%;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHTML(displayName) + (nr.comment ? ' — ' + escapeHTML(nr.comment) : '') + '">' + escapeHTML(displayName) + '</div>' +
        '<div style="flex:1;font-family:monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHTML(nr.ref) + '">' + refDisplay + '</div>' +
        '<button class="ws-btn" title="Go to" onclick="window.wsGotoNamedRange(\'' + encodeURIComponent(k) + '\')" style="padding:1px 7px;">&#x2197;</button>' +
        '<button class="ws-btn" title="Delete" onclick="window.wsDeleteNamedRange(\'' + encodeURIComponent(k) + '\')" style="padding:1px 7px;">×</button>' +
      '</div>';
    }).join('');
  }

  function openNamedRangesEditor() {
    var existing = document.getElementById('wsNamedRanges');
    if (existing) { existing.style.display = 'block'; }
    else {
      var pop = document.createElement('div');
      pop.id = 'wsNamedRanges';
      pop.style.cssText = 'position:fixed;top:80px;right:30px;background:var(--surface,#181820);border:1px solid var(--border,#333);border-radius:8px;padding:14px 16px;z-index:1500;box-shadow:0 8px 24px rgba(0,0,0,0.5);width:380px;font-size:12px;';
      pop.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<strong style="font-size:13px;">Named Ranges</strong>' +
          '<button class="ws-btn" onclick="document.getElementById(\'wsNamedRanges\').style.display=\'none\';" style="padding:2px 8px;">×</button>' +
        '</div>' +
        '<div id="wsNRList" style="max-height:200px;overflow:auto;margin-bottom:12px;border:1px solid var(--grid-border);border-radius:4px;"></div>' +
        '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-bottom:4px;">New name</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<input type="text" id="wsNRName" placeholder="e.g. TaxRate" autocomplete="off" style="width:100%;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
          '<div style="display:flex;gap:6px;align-items:center;">' +
            '<input type="text" id="wsNRRef" placeholder="Sheet1!A1:A10" style="flex:1;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);font-family:monospace;" />' +
            '<button class="ws-btn" title="Use current selection" onclick="window.wsNRUseSelection()" style="white-space:nowrap;">Use selection</button>' +
          '</div>' +
          '<input type="text" id="wsNRComment" placeholder="Comment (optional)" style="width:100%;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
          '<div id="wsNRError" style="color:#e06c6c;font-size:11px;min-height:14px;"></div>' +
          '<div style="display:flex;gap:6px;justify-content:flex-end;">' +
            '<button class="ws-btn ws-btn-primary" onclick="window.wsAddNamedRange()">Add</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(pop);
      var nameInput = document.getElementById('wsNRName');
      if (nameInput) {
        nameInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); window.wsAddNamedRange(); }
        });
      }
    }
    // Seed the ref box with the current selection each open.
    var refBox = document.getElementById('wsNRRef');
    if (refBox && !refBox.value) refBox.value = _selectionRefString();
    _renderNamedRangesList();
    var nb = document.getElementById('wsNRName');
    if (nb) nb.focus();
  }

  window.wsOpenNamedRanges = openNamedRangesEditor;

  window.wsNRUseSelection = function() {
    var refBox = document.getElementById('wsNRRef');
    if (refBox) refBox.value = _selectionRefString();
  };

  window.wsAddNamedRange = function() {
    var nameEl = document.getElementById('wsNRName');
    var refEl = document.getElementById('wsNRRef');
    var commentEl = document.getElementById('wsNRComment');
    var errEl = document.getElementById('wsNRError');
    if (!nameEl || !refEl) return;
    var name = (nameEl.value || '').trim();
    var ref = (refEl.value || '').trim();
    var comment = commentEl ? (commentEl.value || '').trim() : '';
    function showErr(msg) { if (errEl) errEl.textContent = msg; }
    var nameErr = validateRangeName(name);
    if (nameErr) { showErr(nameErr); return; }
    if (!ref) { showErr('Reference is required.'); return; }
    // If the ref carries a sheet prefix, split it off and resolve to a
    // sheetId so the name still works after a sheet rename.
    var sheetId = null;
    var bareRef = ref;
    var bang = ref.lastIndexOf('!');
    if (bang !== -1) {
      var sheetName = ref.slice(0, bang).replace(/^'|'$/g, '');
      bareRef = ref.slice(bang + 1);
      var sh = findSheetByName(sheetName);
      if (!sh) { showErr('Unknown sheet: ' + sheetName); return; }
      sheetId = sh.id;
    }
    // Validate the A1 portion (single cell or range).
    var parts = bareRef.replace(/\$/g, '').split(':');
    var a = parseAddr(parts[0].toUpperCase());
    var b = parts[1] ? parseAddr(parts[1].toUpperCase()) : a;
    if (!a || !b) { showErr('Invalid reference: ' + ref); return; }
    if (!workbook.namedRanges) workbook.namedRanges = {};
    workbook.namedRanges[name.toUpperCase()] = {
      name: name,
      ref: bareRef.replace(/\$/g, ''),
      sheetId: sheetId,
      comment: comment
    };
    showErr('');
    nameEl.value = '';
    if (commentEl) commentEl.value = '';
    _renderNamedRangesList();
    recalcAll();
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  };

  window.wsDeleteNamedRange = function(encKey) {
    var key = decodeURIComponent(encKey);
    if (workbook.namedRanges && workbook.namedRanges[key]) {
      delete workbook.namedRanges[key];
      _renderNamedRangesList();
      recalcAll();
      renderGrid();
      if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
      saveWorkspace();
    }
  };

  // Jump to a named range: switch to its sheet (if qualified) and select
  // the referenced cell/range.
  window.wsGotoNamedRange = function(encKey) {
    var key = decodeURIComponent(encKey);
    var nr = workbook.namedRanges && workbook.namedRanges[key];
    if (!nr) return;
    if (nr.sheetId && nr.sheetId !== workbook.activeSheetId) {
      var sh = workbook.sheets.find(function(s){ return s.id === nr.sheetId; });
      if (sh) switchSheet(sh.id);
    }
    var parts = String(nr.ref).replace(/\$/g, '').split(':');
    var a = parseAddr(parts[0].toUpperCase());
    if (!a) return;
    var b = parts[1] ? parseAddr(parts[1].toUpperCase()) : a;
    selectCell(a.r, a.c);
    if (b && (b.r !== a.r || b.c !== a.c)) {
      grid.selEnd = { r: b.r, c: b.c };
      renderSelectionClasses();
    }
  };

  // ── Data Validation (Phase 2.3) ───────────────────────────
  // Each validated cell carries cell.validation:
  //   { type:'list', values:[...] }            explicit dropdown options
  //   { type:'list', source:'A1:A10' }          options pulled from a range
  //   { type:'whole'|'decimal', op, min, max }  numeric rule
  //   { type:'textLength', op, min, max }        length rule
  //   { type:'date', op, min, max }              date rule (ISO strings)
  // A failing entry sets cell.validation._invalid (red box) but is NOT
  // rejected — Excel's "Warning"/"Information" style, which is the least
  // destructive for an estimator typing fast.

  // Resolve a list validation's options to an array of display strings,
  // pulling from an explicit values[] array or a range source like A1:A10.
  function resolveValidationOptions(validation) {
    if (!validation) return [];
    if (Array.isArray(validation.values) && validation.values.length) {
      return validation.values.slice();
    }
    if (validation.source) {
      var m = String(validation.source).trim().replace(/\$/g, '');
      var parts = m.split(':');
      var a = parseAddr(parts[0]);
      var b = parts[1] ? parseAddr(parts[1]) : a;
      if (!a || !b) return [];
      var r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r);
      var c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
      var out = [];
      for (var r = r1; r <= r2; r++) {
        for (var c = c1; c <= c2; c++) {
          var cell = grid.cells[addr(r, c)];
          var v = cell ? displayVal(cell) : '';
          if (v !== '' && v != null) out.push(String(v));
        }
      }
      return out;
    }
    return [];
  }

  // Validate a raw/typed value against a cell's validation rule.
  // Returns true when valid (or when there's no rule).
  function validateCellValue(validation, rawValue, numericValue) {
    if (!validation || !validation.type) return true;
    var t = validation.type;
    if (t === 'list') {
      var opts = resolveValidationOptions(validation);
      if (!opts.length) return true; // nothing to check against
      var s = String(rawValue == null ? '' : rawValue).trim();
      if (s === '') return true; // empty is allowed; use a separate "required" if needed
      return opts.some(function (o) { return String(o).trim() === s; });
    }
    var num = (typeof numericValue === 'number' && isFinite(numericValue))
      ? numericValue
      : parseFloat(rawValue);
    if (t === 'whole' || t === 'decimal') {
      if (isNaN(num)) return false;
      if (t === 'whole' && Math.floor(num) !== num) return false;
      return _checkNumericRule(validation, num);
    }
    if (t === 'textLength') {
      var len = String(rawValue == null ? '' : rawValue).length;
      return _checkNumericRule(validation, len);
    }
    if (t === 'date') {
      var d = Date.parse(rawValue);
      if (isNaN(d)) return false;
      var lo = validation.min != null ? Date.parse(validation.min) : null;
      var hi = validation.max != null ? Date.parse(validation.max) : null;
      return _checkRangeRule(validation.op, d, lo, hi);
    }
    return true;
  }

  function _checkNumericRule(validation, n) {
    var lo = validation.min != null ? parseFloat(validation.min) : null;
    var hi = validation.max != null ? parseFloat(validation.max) : null;
    return _checkRangeRule(validation.op, n, lo, hi);
  }
  function _checkRangeRule(op, n, lo, hi) {
    switch (op) {
      case 'between':    return (lo == null || n >= lo) && (hi == null || n <= hi);
      case 'notBetween': return !((lo == null || n >= lo) && (hi == null || n <= hi));
      case 'eq':  return lo == null || n === lo;
      case 'ne':  return lo == null || n !== lo;
      case 'gt':  return lo == null || n > lo;
      case 'gte': return lo == null || n >= lo;
      case 'lt':  return lo == null || n < lo;
      case 'lte': return lo == null || n <= lo;
      default:    return true;
    }
  }

  // Re-evaluate a cell's _invalid flag after its value changes.
  function refreshCellValidity(r, c) {
    var cell = grid.cells[addr(r, c)];
    if (!cell || !cell.validation) return;
    var ok = validateCellValue(cell.validation, cell.raw, cell.value);
    if (ok) { if (cell.validation._invalid) delete cell.validation._invalid; }
    else cell.validation._invalid = true;
  }

  // Floating dropdown list for list-type validations.
  var _validationDropdownEl = null;
  function closeValidationDropdown() {
    if (_validationDropdownEl && _validationDropdownEl.parentNode) {
      _validationDropdownEl.parentNode.removeChild(_validationDropdownEl);
    }
    _validationDropdownEl = null;
  }
  function openValidationDropdown(r, c, td) {
    closeValidationDropdown();
    var cell = grid.cells[addr(r, c)];
    if (!cell || !cell.validation || cell.validation.type !== 'list') return;
    var opts = resolveValidationOptions(cell.validation);
    if (!opts.length) return;
    var cur = displayVal(cell);
    var list = document.createElement('div');
    list.className = 'ws-validation-list';
    opts.forEach(function (o) {
      var item = document.createElement('div');
      item.className = 'ws-validation-opt' + (String(o) === String(cur) ? ' ws-vl-active' : '');
      item.textContent = o;
      item.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        pushUndo();
        var tgt = getCell(r, c);
        tgt.raw = String(o);
        delete tgt.importedValue; // dropdown pick overwrote the cell
        delete tgt.formula;
        grid.dirty = true;
        recalcAll();
        refreshCellValidity(r, c);
        renderGrid();
        selectCell(r, c);
        pushLinkedValues();
        saveWorkspace();
        closeValidationDropdown();
      });
      list.appendChild(item);
    });
    document.body.appendChild(list);
    var rect = td.getBoundingClientRect();
    list.style.left = rect.left + 'px';
    list.style.top = rect.bottom + 'px';
    list.style.minWidth = rect.width + 'px';
    _validationDropdownEl = list;
    // Dismiss on outside click / escape.
    setTimeout(function () {
      document.addEventListener('mousedown', _validationOutsideHandler, true);
      document.addEventListener('keydown', _validationKeyHandler, true);
    }, 0);
  }
  function _validationOutsideHandler(e) {
    if (_validationDropdownEl && !_validationDropdownEl.contains(e.target) &&
        !(e.target.classList && e.target.classList.contains('ws-validation-caret'))) {
      closeValidationDropdown();
      document.removeEventListener('mousedown', _validationOutsideHandler, true);
      document.removeEventListener('keydown', _validationKeyHandler, true);
    }
  }
  function _validationKeyHandler(e) {
    if (e.key === 'Escape') {
      closeValidationDropdown();
      document.removeEventListener('mousedown', _validationOutsideHandler, true);
      document.removeEventListener('keydown', _validationKeyHandler, true);
    }
  }

  // Data Validation editor modal.
  function openDataValidationEditor() {
    var existing = document.getElementById('wsDataValidation');
    if (existing) { existing.style.display = 'block'; }
    else {
      var pop = document.createElement('div');
      pop.id = 'wsDataValidation';
      pop.style.cssText = 'position:fixed;top:80px;right:30px;background:var(--surface,#181820);border:1px solid var(--border,#333);border-radius:8px;padding:14px 16px;z-index:1500;box-shadow:0 8px 24px rgba(0,0,0,0.5);width:330px;font-size:12px;';
      pop.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<strong style="font-size:13px;">Data Validation</strong>' +
          '<button class="ws-btn" onclick="document.getElementById(\'wsDataValidation\').style.display=\'none\';" style="padding:2px 8px;">×</button>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<label style="font-size:11px;color:var(--text-dim,#aaa);">Allow' +
            '<select id="wsDvType" style="width:100%;margin-top:3px;padding:6px 8px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);">' +
              '<option value="list">List (dropdown)</option>' +
              '<option value="whole">Whole number</option>' +
              '<option value="decimal">Decimal</option>' +
              '<option value="textLength">Text length</option>' +
              '<option value="date">Date</option>' +
            '</select>' +
          '</label>' +
          '<div id="wsDvListWrap">' +
            '<label style="font-size:11px;color:var(--text-dim,#aaa);">Options — comma-separated, or a range like A1:A10' +
              '<input type="text" id="wsDvList" placeholder="Yes, No, Maybe   (or)   A1:A10" style="width:100%;margin-top:3px;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
            '</label>' +
          '</div>' +
          '<div id="wsDvRuleWrap" style="display:none;flex-direction:column;gap:8px;">' +
            '<label style="font-size:11px;color:var(--text-dim,#aaa);">Condition' +
              '<select id="wsDvOp" style="width:100%;margin-top:3px;padding:6px 8px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);">' +
                '<option value="between">between</option>' +
                '<option value="notBetween">not between</option>' +
                '<option value="eq">equal to</option>' +
                '<option value="ne">not equal to</option>' +
                '<option value="gt">greater than</option>' +
                '<option value="gte">greater than or equal to</option>' +
                '<option value="lt">less than</option>' +
                '<option value="lte">less than or equal to</option>' +
              '</select>' +
            '</label>' +
            '<div style="display:flex;gap:8px;">' +
              '<label style="font-size:11px;color:var(--text-dim,#aaa);flex:1;"><span id="wsDvMinLabel">Minimum</span>' +
                '<input type="text" id="wsDvMin" style="width:100%;margin-top:3px;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
              '</label>' +
              '<label style="font-size:11px;color:var(--text-dim,#aaa);flex:1;" id="wsDvMaxWrap"><span id="wsDvMaxLabel">Maximum</span>' +
                '<input type="text" id="wsDvMax" style="width:100%;margin-top:3px;padding:6px 10px;border:1px solid var(--grid-border);border-radius:4px;background:var(--card-bg,#0c0c14);color:var(--text);" />' +
              '</label>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:4px;">' +
            '<button class="ws-btn" onclick="window.wsClearDataValidation()">Clear</button>' +
            '<button class="ws-btn ws-btn-primary" onclick="window.wsApplyDataValidation()">Apply</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(pop);
      var typeSel = document.getElementById('wsDvType');
      var opSel = document.getElementById('wsDvOp');
      function syncDvUi() {
        var t = typeSel.value;
        document.getElementById('wsDvListWrap').style.display = (t === 'list') ? 'block' : 'none';
        document.getElementById('wsDvRuleWrap').style.display = (t === 'list') ? 'none' : 'flex';
        var op = opSel.value;
        var twoArg = (op === 'between' || op === 'notBetween');
        document.getElementById('wsDvMaxWrap').style.display = twoArg ? 'block' : 'none';
        document.getElementById('wsDvMinLabel').textContent = twoArg ? 'Minimum' : 'Value';
      }
      typeSel.addEventListener('change', syncDvUi);
      opSel.addEventListener('change', syncDvUi);
      syncDvUi();
    }
    // Seed from the active cell's existing rule.
    if (grid && grid.selection) {
      var cell = grid.cells[addr(grid.selection.r, grid.selection.c)];
      var v = cell && cell.validation;
      if (v) {
        document.getElementById('wsDvType').value = v.type || 'list';
        if (v.type === 'list') {
          document.getElementById('wsDvList').value = v.source || (Array.isArray(v.values) ? v.values.join(', ') : '');
        } else {
          if (v.op) document.getElementById('wsDvOp').value = v.op;
          document.getElementById('wsDvMin').value = (v.min != null ? v.min : '');
          document.getElementById('wsDvMax').value = (v.max != null ? v.max : '');
        }
      }
      var ev = new Event('change');
      document.getElementById('wsDvType').dispatchEvent(ev);
    }
    document.getElementById('wsDvType').focus();
  }
  window.wsOpenDataValidation = openDataValidationEditor;

  window.wsApplyDataValidation = function () {
    var rng = getSelRange();
    if (!rng) return;
    var t = document.getElementById('wsDvType').value;
    var validation;
    if (t === 'list') {
      var raw = (document.getElementById('wsDvList').value || '').trim();
      if (!raw) { alert('Enter dropdown options or a range.'); return; }
      // A bare range like A1:A10 → source; otherwise treat as comma list.
      if (/^[A-Za-z]+\$?\d+(:\$?[A-Za-z]+\$?\d+)?$/.test(raw)) {
        validation = { type: 'list', source: raw.toUpperCase() };
      } else {
        var values = raw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
        validation = { type: 'list', values: values };
      }
    } else {
      var op = document.getElementById('wsDvOp').value;
      var min = (document.getElementById('wsDvMin').value || '').trim();
      var max = (document.getElementById('wsDvMax').value || '').trim();
      validation = { type: t, op: op };
      if (min !== '') validation.min = min;
      if (max !== '') validation.max = max;
    }
    pushUndo();
    for (var r = rng.r1; r <= rng.r2; r++) {
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        cell.validation = JSON.parse(JSON.stringify(validation));
        refreshCellValidity(r, c);
      }
    }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
    var modal = document.getElementById('wsDataValidation');
    if (modal) modal.style.display = 'none';
  };

  window.wsClearDataValidation = function () {
    var rng = getSelRange();
    if (!rng) return;
    pushUndo();
    for (var r = rng.r1; r <= rng.r2; r++) {
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        if (cell.validation) delete cell.validation;
      }
    }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
    var modal = document.getElementById('wsDataValidation');
    if (modal) modal.style.display = 'none';
  };

  // ── Freeze Panes ──────────────────────────────────────────
  // Toggle: top row, first column, both, or none. Stored on the active
  // sheet since freeze settings are sheet-specific in Excel too.
  function setFreeze(mode) {
    const sheet = workbook.sheets.find(s => s.id === workbook.activeSheetId);
    if (!sheet) return;
    sheet.frozen = mode; // 'row' | 'col' | 'both' | null
    workbook.dirty = true;
    saveWorkspace();
    renderGrid();
    applyFreezeClasses();
  }
  function applyFreezeClasses() {
    if (!wsTable) return;
    const sheet = workbook.sheets.find(s => s.id === workbook.activeSheetId);
    const mode = sheet && sheet.frozen;
    wsTable.classList.toggle('ws-freeze-row', mode === 'row' || mode === 'both');
    wsTable.classList.toggle('ws-freeze-col', mode === 'col' || mode === 'both');
  }

  window.wsMakeTable = function() {
    const btn = document.getElementById('wsMakeTableBtn');
    if (btn) openTableStylePicker(btn);
  };
  window.wsRemoveTable = removeTable;
  window.wsToggleTotalRow = toggleTotalRow;
  window.wsChangeTableStyle = changeTableStyle;
  window.wsSortAsc = function() { sortSelection('asc', false); };
  window.wsSortDesc = function() { sortSelection('desc', false); };
  window.wsSortAscHeader = function() { sortSelection('asc', true); };
  window.wsSortDescHeader = function() { sortSelection('desc', true); };
  window.wsAutoSum = autoSum;
  // Ribbon's Cells group — wrappers around the existing internal
  // insertRow / deleteRow / insertColumn / deleteColumn helpers.
  // Read the active selection so the buttons act on whatever the
  // user has clicked into.
  window.wsInsertRowAbove = function() {
    if (grid && grid.selection) insertRow(grid.selection.r, 'above');
  };
  window.wsInsertColLeft = function() {
    if (grid && grid.selection) insertColumn(grid.selection.c, 'left');
  };
  window.wsDeleteSelectedRow = function() {
    if (grid && grid.selection) deleteRow(grid.selection.r);
  };
  window.wsDeleteSelectedCol = function() {
    if (grid && grid.selection) deleteColumn(grid.selection.c);
  };

  // Number group — increase / decrease decimals on the selected cells.
  // Stores the chosen precision on cell.decimals so it persists; the
  // renderer reads it via the fmtDecimals helper in getDisplayValue.
  function bumpDecimalsOnSelection(delta) {
    var rng = getSelRange();
    if (!rng) return;
    pushUndo();
    for (var r = rng.r1; r <= rng.r2; r++) {
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        var cur = (typeof cell.decimals === 'number')
          ? cell.decimals
          : (cell.fmt === 'currency' ? 2 : cell.fmt === 'percent' ? 1 : 0);
        var next = Math.max(0, Math.min(10, cur + delta));
        cell.decimals = next;
      }
    }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  }
  window.wsIncDecimal = function() { bumpDecimalsOnSelection(+1); };
  window.wsDecDecimal = function() { bumpDecimalsOnSelection(-1); };

  // Editing group — Clear contents on the selected range. Empties
  // values + formulas but preserves cell styling (fills, borders,
  // alignment) so a clear-and-retype keeps the spreadsheet's look.
  // For a full clear-everything, the existing Clear-formatting button
  // (✘ in Styles) plus this together do the job.
  window.wsClearContents = function() {
    var rng = getSelRange();
    if (!rng) return;
    pushUndo();
    for (var r = rng.r1; r <= rng.r2; r++) {
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        cell.value = '';
        cell.raw = '';
        if (cell.formula) delete cell.formula;
      }
    }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  };

  // Borders group — apply a preset to the selected range. Each preset
  // computes which sides of each cell get a border:
  //   all          — every side of every cell
  //   outside      — only the outer perimeter of the range
  //   thick-outside— same as outside but 2px (heavy box)
  //   inside       — interior gridlines (not the outside)
  //   top/bottom/left/right — that single side on every cell
  //   none         — clear all borders on every cell
  // Defaults: 1px solid, color tuned for the dark theme so borders
  // read clearly on the surface.
  function applyBorderPreset(preset) {
    var rng = getSelRange();
    if (!rng) return;
    pushUndo();
    var thin  = { style: 'solid', width: 1, color: '#94a3b8' };
    var thick = { style: 'solid', width: 2, color: '#94a3b8' };
    for (var r = rng.r1; r <= rng.r2; r++) {
      for (var c = rng.c1; c <= rng.c2; c++) {
        var cell = getCell(r, c);
        if (!cell.style) cell.style = {};
        if (preset === 'none') {
          delete cell.style.borders;
          continue;
        }
        var bord = cell.style.borders ? Object.assign({}, cell.style.borders) : {};
        var b = (preset === 'thick-outside') ? thick : thin;
        var setTop, setBottom, setLeft, setRight;
        if (preset === 'all') {
          setTop = setBottom = setLeft = setRight = true;
        } else if (preset === 'outside' || preset === 'thick-outside') {
          setTop    = (r === rng.r1);
          setBottom = (r === rng.r2);
          setLeft   = (c === rng.c1);
          setRight  = (c === rng.c2);
        } else if (preset === 'inside') {
          setTop    = (r > rng.r1);
          setBottom = (r < rng.r2);
          setLeft   = (c > rng.c1);
          setRight  = (c < rng.c2);
        } else {
          setTop    = (preset === 'top');
          setBottom = (preset === 'bottom');
          setLeft   = (preset === 'left');
          setRight  = (preset === 'right');
        }
        if (setTop)    bord.top    = b;
        if (setBottom) bord.bottom = b;
        if (setLeft)   bord.left   = b;
        if (setRight)  bord.right  = b;
        cell.style.borders = bord;
      }
    }
    grid.dirty = true;
    renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
    saveWorkspace();
  }
  window.wsApplyBorder = applyBorderPreset;
  window.wsOpenFindReplace = openFindReplace;
  window.wsSetFreeze = setFreeze;
  // Public xlsx-import hook so the Attachments embed (and other drop
  // targets) can route .xlsx / .xls / .csv files into the workbook.
  window.wsImportXlsxFile = function(file) {
    if (!file) return;
    handleXlsxImport(file);
  };

  // ─────────────────────────────────────────────────────────────────
  // XLSX round-trip — fidelity contract (S1–S4 of the Excel plan)
  //
  // .xlsx import AND export run on the SERVER via exceljs
  // (/api/workspace/import-xlsx, /api/workspace/export-xlsx), which
  // reads and writes what SheetJS Community cannot. The SheetJS paths
  // below survive only as (a) the .xls / .csv importer and (b) the
  // offline/server-error export fallback.
  //
  // Preserved on a full import → export round-trip:
  //   - Values, formulas (with Excel's cached results), number formats
  //   - Fonts (bold/italic/underline/strike, color, size, family)
  //   - Fills (theme colors resolved EXACTLY from the file's own
  //     xl/theme1.xml + spec tint math), per-side borders
  //   - Alignment (horizontal, vertical, wrap), style-only blank cells
  //   - Column widths / row heights in Excel's native units, bit-exact
  //     (sheet.colWch chars / sheet.rowHpt points; a manual resize
  //     in-app drops the stored unit for that column/row so px becomes
  //     the source of truth — see dropColWch/dropRowHpt)
  //   - Merges, frozen panes (1 row/col), autoFilter range, named ranges
  //
  // Hard limits (not modeled — dropped on import, absent on export):
  //   - Charts, images, conditional formatting, data validation
  //   - Fill patterns/gradients (approximated as solid fgColor)
  //   - Diagonal borders, rich-text runs (flattened to plain text)
  //   - Hidden rows/columns (hidden SHEETS import as hidden tabs so
  //     formulas into them resolve, but are excluded from export)
  //   - `$` anchors in formulas (stripped so the grid engine can
  //     evaluate — values identical, anchors lost on re-export)
  //   - Multi-row/col freeze depths collapse to 1 row / 1 col
  //
  // What's deliberately skipped on export:
  //   - Embedded sheets (QB Costs, Attachments) — live views of server
  //     data, not authored sheets.
  //   - Hidden sheets — the export matches what's visible.
  // ─────────────────────────────────────────────────────────────────
  function _buildSheetJSWorksheetFromAgxSheet(sheet) {
    if (typeof XLSX === 'undefined') return null;
    const rowCount = sheet.rows || MIN_ROWS;
    const colCount = sheet.cols || MIN_COLS;
    // Build aoa (array of arrays) for the value layer. SheetJS uses
    // this as the seed; we then overlay formulas + format strings on
    // individual cells after.
    const aoa = [];
    for (let r = 0; r < rowCount; r++) {
      const row = [];
      for (let c = 0; c < colCount; c++) {
        const ref = addr(r, c);
        const cell = sheet.cells[ref];
        if (!cell) { row.push(null); continue; }
        // Prefer the evaluated value (so a formula export reads as
        // its computed number in Excel); the formula gets layered on
        // top in the second pass.
        const isFormula = typeof cell.raw === 'string' && cell.raw.startsWith('=');
        if (isFormula) {
          const v = cell.value;
          if (v == null || v === '' || (typeof v === 'number' && isNaN(v))) {
            row.push(null);
          } else {
            row.push(v);
          }
        } else {
          // Plain content — numbers stay numeric, strings stay strings.
          if (cell.raw == null || cell.raw === '') {
            row.push(null);
          } else {
            const n = Number(cell.raw);
            row.push(!isNaN(n) && String(n) === String(cell.raw).trim() ? n : String(cell.raw));
          }
        }
      }
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Second pass — attach formulas + number format strings to the
    // SheetJS cell objects we just built. SheetJS skips empty cells;
    // we have to materialize them when we want to add a formula or
    // format that has no corresponding aoa value (rare).
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        const ref = addr(r, c);
        const cell = sheet.cells[ref];
        if (!cell) continue;
        const sjsRef = XLSX.utils.encode_cell({ r: r, c: c });
        let sjsCell = ws[sjsRef];
        // Formula attach. SheetJS `f` is the formula text WITHOUT
        // the leading `=` — strip it before assigning.
        if (typeof cell.raw === 'string' && cell.raw.startsWith('=')) {
          if (!sjsCell) {
            sjsCell = { t: 'n', v: cell.value != null ? cell.value : 0 };
            ws[sjsRef] = sjsCell;
          }
          sjsCell.f = cell.raw.slice(1);
        }
        // Hyperlink (.l) and comment (.c) need a materialized cell object
        // even when the value is empty — SheetJS skips blank cells in the
        // aoa pass. Create a stub so the metadata has somewhere to live.
        if (!sjsCell && (cell.hyperlink || cell.note)) {
          sjsCell = { t: 's', v: cell.value != null ? cell.value : '' };
          ws[sjsRef] = sjsCell;
        }
        // Hyperlink — SheetJS `.l` = { Target, Tooltip }.
        if (cell.hyperlink && cell.hyperlink.url && sjsCell) {
          sjsCell.l = { Target: cell.hyperlink.url };
          if (cell.hyperlink.display) sjsCell.l.Tooltip = cell.hyperlink.display;
        }
        // Comment / note — SheetJS `.c` = [{ a: author, t: text }].
        if (cell.note && sjsCell) {
          sjsCell.c = [{ a: 'AGX', t: String(cell.note) }];
          sjsCell.c.hidden = true;
        }
        // Number-format hint. A custom Excel format string (cell.numFmt)
        // always wins — it round-trips verbatim into the .z slot. Otherwise
        // our `fmt` enum maps onto Excel format strings — currency, percent,
        // comma. Custom fmt strings flow through unchanged.
        if (cell.numFmt && sjsCell) {
          sjsCell.z = cell.numFmt;
        } else if (cell.fmt && sjsCell) {
          let z = null;
          const dec = Number.isFinite(cell.decimals) ? cell.decimals : 2;
          const decStr = dec > 0 ? '.' + Array(dec + 1).join('0') : '';
          if (cell.fmt === 'currency') z = '"$"#,##0' + decStr;
          else if (cell.fmt === 'percent') z = '0' + decStr + '%';
          else if (cell.fmt === 'comma') z = '#,##0' + decStr;
          else if (typeof cell.fmt === 'string') z = cell.fmt; // custom string
          if (z) sjsCell.z = z;
        }
      }
    }

    // Column widths — SheetJS uses `wpx` (pixels). Our colWidths map
    // is `{c: px}`. Build a dense array sized to the column count.
    if (sheet.colWidths && Object.keys(sheet.colWidths).length) {
      const cols = [];
      for (let c = 0; c < colCount; c++) {
        const w = sheet.colWidths[c];
        cols.push(w ? { wpx: w } : { wpx: 100 });
      }
      ws['!cols'] = cols;
    }

    // Row heights — sparse array; missing rows get Excel's default.
    if (sheet.rowHeights && Object.keys(sheet.rowHeights).length) {
      const rows = [];
      Object.keys(sheet.rowHeights).forEach(function(r) {
        const h = sheet.rowHeights[r];
        if (h) rows[Number(r)] = { hpx: h };
      });
      if (rows.length) ws['!rows'] = rows;
    }

    // Merged ranges.
    if (sheet.merges && sheet.merges.length) {
      ws['!merges'] = sheet.merges.map(function(m) {
        return {
          s: { r: m.r1, c: m.c1 },
          e: { r: m.r2, c: m.c2 }
        };
      });
    }

    // Frozen panes — SheetJS `!freeze` is a view-state hint with
    // `xSplit` / `ySplit` (number of frozen cols / rows).
    if (sheet.frozen) {
      const fz = {};
      if (sheet.frozen === 'row' || sheet.frozen === 'both') fz.ySplit = 1;
      if (sheet.frozen === 'col' || sheet.frozen === 'both') fz.xSplit = 1;
      if (fz.xSplit || fz.ySplit) ws['!freeze'] = fz;
    }

    return ws;
  }

  // Sanitize an Excel sheet-tab name. Excel rejects: > 31 chars,
  // these characters: \ / ? * [ ]. Also rejects empty names.
  function _sanitizeSheetName(name, fallback) {
    let s = String(name || fallback || 'Sheet').replace(/[\\/?*\[\]]/g, ' ').trim();
    if (!s) s = fallback || 'Sheet';
    if (s.length > 31) s = s.slice(0, 31);
    return s;
  }

  // De-duplicate sheet names within the export (Excel disallows
  // duplicates after sanitization). Appends ' (2)', ' (3)', etc. as
  // needed, respecting the 31-char ceiling.
  function _uniqueSheetName(name, used) {
    let candidate = name;
    let n = 2;
    while (used.has(candidate)) {
      const suffix = ' (' + n + ')';
      candidate = name.slice(0, 31 - suffix.length) + suffix;
      n++;
      if (n > 999) { candidate = name.slice(0, 26) + '_' + Date.now().toString(36).slice(-4); break; }
    }
    used.add(candidate);
    return candidate;
  }

  // Server-side export (full style fidelity) — POSTs the live workbook
  // model to /api/workspace/export-xlsx, where exceljs writes fonts,
  // fills, borders, alignment and exact geometry that the SheetJS
  // Community build (kept below as the OFFLINE fallback) cannot emit.
  window.wsExportXlsx = function() {
    syncGridToActiveSheet();
    var realSheets = workbook.sheets.filter(function(s) {
      return !s.hidden && !s.pinned && (!s.kind || s.kind === 'grid');
    });
    if (!realSheets.length) {
      alert('No grid sheets to export — add a sheet or import one first.');
      return;
    }
    var entityLabel = workbook.entityType || 'workspace';
    var idStr = workbook.entityId == null ? 'unknown' : String(workbook.entityId);
    var filename = 'workspace-' + entityLabel + '-' + idStr + '-' + new Date().toISOString().slice(0, 10) + '.xlsx';
    var status = document.getElementById('wsStatus');
    if (status) status.textContent = 'Exporting…';

    var headers = { 'Content-Type': 'application/json' };
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) || localStorage.getItem('p86-auth-token');
    if (token) headers['Authorization'] = 'Bearer ' + token;

    fetch('/api/workspace/export-xlsx', {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: JSON.stringify({
        filename: filename,
        activeSheetId: workbook.activeSheetId,
        sheets: realSheets,
        namedRanges: workbook.namedRanges || {}
      })
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function(blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      if (status) {
        status.textContent = '✓ Exported ' + realSheets.length + ' sheet(s)';
        setTimeout(function() { status.textContent = 'Ready'; }, 2500);
      }
    }).catch(function(e) {
      console.warn('[workspace] server export failed, falling back to client export:', e && e.message);
      if (status) status.textContent = 'Ready';
      wsExportXlsxClientFallback();
    });
  };

  // Legacy client-side export via SheetJS — offline / server-error
  // fallback only. Values + formulas + numFmts + geometry, NO styles
  // (Community-build limitation — the server path carries the styles).
  function wsExportXlsxClientFallback() {
    if (typeof XLSX === 'undefined') {
      alert('Excel library is still loading. Try again in a moment.');
      return;
    }
    syncGridToActiveSheet();
    // Real sheets only — drop embedded views (QB Costs, Attachments)
    // and hidden sheets, since the user wants what they see + Excel
    // can't usefully render a live server-data view.
    const realSheets = workbook.sheets.filter(function(s) {
      return !s.hidden
          && !s.pinned
          && (!s.kind || s.kind === 'grid');
    });
    if (!realSheets.length) {
      alert('No grid sheets to export — add a sheet or import one first.');
      return;
    }
    const wb = XLSX.utils.book_new();
    const usedNames = new Set();
    const sheetIdToExportName = {};
    realSheets.forEach(function(sheet, i) {
      const ws = _buildSheetJSWorksheetFromAgxSheet(sheet);
      if (!ws) return;
      const sanitized = _sanitizeSheetName(sheet.name, 'Sheet' + (i + 1));
      const finalName = _uniqueSheetName(sanitized, usedNames);
      sheetIdToExportName[sheet.id] = finalName;
      XLSX.utils.book_append_sheet(wb, ws, finalName);
    });

    // Workbook-scoped named ranges → SheetJS defined names. Each Ref is
    // qualified with the exported sheet name and made absolute ($A$1).
    // Names whose owning sheet wasn't exported (e.g. it pointed at an
    // embedded view) are skipped so the file stays valid.
    var nrKeys = Object.keys(workbook.namedRanges || {});
    if (nrKeys.length) {
      var defined = [];
      var activeExportName = sheetIdToExportName[workbook.activeSheetId] || null;
      var _abs = function(part) {
        var m = parseAddr(String(part).replace(/\$/g, '').toUpperCase());
        if (!m) return null;
        return '$' + colLetter(m.c) + '$' + (m.r + 1);
      };
      nrKeys.forEach(function(k) {
        var nr = workbook.namedRanges[k];
        if (!nr || !nr.ref) return;
        // Resolve the sheet name this name points at.
        var sheetExportName = nr.sheetId ? sheetIdToExportName[nr.sheetId] : activeExportName;
        var bare = nr.ref;
        var bang = nr.ref.lastIndexOf('!');
        if (bang !== -1) {
          var sn = nr.ref.slice(0, bang).replace(/^'|'$/g, '');
          var sh = findSheetByName(sn);
          if (sh && sheetIdToExportName[sh.id]) sheetExportName = sheetIdToExportName[sh.id];
          bare = nr.ref.slice(bang + 1);
        }
        if (!sheetExportName) return;  // owning sheet not exported
        var parts = bare.replace(/\$/g, '').split(':');
        var a = _abs(parts[0]);
        if (!a) return;
        var refBody = parts[1] ? (a + ':' + _abs(parts[1])) : a;
        if (/null/.test(refBody)) return;
        var qName = /\s/.test(sheetExportName) ? "'" + sheetExportName + "'" : sheetExportName;
        defined.push({ Name: (nr.name || k), Ref: qName + '!' + refBody });
      });
      if (defined.length) {
        wb.Workbook = wb.Workbook || {};
        wb.Workbook.Names = (wb.Workbook.Names || []).concat(defined);
      }
    }
    // Filename — workspace-{estimate|job}-{id}-YYYY-MM-DD.xlsx
    const entityLabel = workbook.entityType || 'workspace';
    const idStr = workbook.entityId == null ? 'unknown' : String(workbook.entityId);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = 'workspace-' + entityLabel + '-' + idStr + '-' + dateStr + '.xlsx';
    try {
      XLSX.writeFile(wb, filename);
      const status = document.getElementById('wsStatus');
      if (status) {
        status.textContent = '✓ Exported ' + realSheets.length + ' sheet(s)';
        setTimeout(function() { status.textContent = 'Ready'; }, 2500);
      }
    } catch (e) {
      console.error('[workspace] xlsx export failed:', e);
      alert('Export failed: ' + (e && e.message ? e.message : e));
    }
  };

  // CSV export — active sheet only (CSV is single-sheet by definition).
  // SheetJS writes UTF-8 with BOM by default; Excel desktop opens it
  // cleanly without prompting for encoding.
  window.wsExportCsv = function() {
    if (typeof XLSX === 'undefined') {
      alert('Excel library is still loading. Try again in a moment.');
      return;
    }
    syncGridToActiveSheet();
    const sheet = activeSheet();
    if (!sheet) { alert('No active sheet.'); return; }
    if (isEmbedSheet(sheet)) {
      alert('Switch to a grid sheet to export CSV — the "' + sheet.name + '" tab is a live view, not a sheet.');
      return;
    }
    const ws = _buildSheetJSWorksheetFromAgxSheet(sheet);
    if (!ws) { alert('Failed to build CSV.'); return; }
    let csv;
    try {
      csv = XLSX.utils.sheet_to_csv(ws);
    } catch (e) {
      console.error('[workspace] csv conversion failed:', e);
      alert('CSV conversion failed: ' + (e && e.message ? e.message : e));
      return;
    }
    // UTF-8 BOM so Excel desktop reads accented characters correctly.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    const safeName = String(sheet.name || 'sheet').replace(/[^A-Za-z0-9._-]+/g, '_');
    a.download = safeName + '-' + dateStr + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 250);
    const status = document.getElementById('wsStatus');
    if (status) {
      status.textContent = '✓ CSV downloaded';
      setTimeout(function() { status.textContent = 'Ready'; }, 2500);
    }
  };
  // Switch to a sheet by id from outside this module — used by the
  // attachments embed after an xlsx import to land the user on the
  // freshly-imported sheet.
  window.wsSwitchToSheetByName = function(name) {
    if (!name) return false;
    var s = workbook.sheets.find(function(x) { return x.name === name; });
    if (!s) return false;
    switchSheet(s.id);
    return true;
  };

  // ── Public Init ────────────────────────────────────────────

  // initWorkspace(containerId, entityType, entityId)
  // Back-compat: initWorkspace(containerId, jobId) — single trailing
  // arg is treated as a jobId (entityType='job'). All existing job-
  // side call sites use that form.
  async function initWorkspace(containerId, entityTypeOrJobId, entityId) {
    wsContainer = document.getElementById(containerId);
    if (!wsContainer) return;

    // Render the shell IMMEDIATELY so the user sees the workspace UI
    // even while the server-side workbook fetch is in flight. The
    // grid renders empty/default first, then the active sheet
    // re-renders when loadWorkspace resolves.
    wsContainer.innerHTML = buildWorkspaceHTML();
    wsTable = document.getElementById('wsGrid');
    formulaBar = document.getElementById('wsFormulaBar');

    await loadWorkspace(entityTypeOrJobId, entityId);
    // Excel theme application is sheet-aware — actual grid sheets get
    // the white Excel palette; Detailed Costs / Attachments embedded
    // views opt out and use the app's light/dark mode instead. Run
    // after innerHTML is set so the class lands on the live container.
    applyExcelThemeForActiveSheet();

    renderActiveSheet();
    renderSheetTabs();

    // WS-POP: wire the pop-out button + single-live-copy coordination now that
    // the entity (workbook.entityType/entityId) is known.
    _wsContainerId = containerId;
    _wsSetupPopoutButton(workbook.entityType, workbook.entityId);
    _wsSetupCoordination(workbook.entityType, workbook.entityId, containerId);
    if (!_wsUnloadWired) {
      _wsUnloadWired = true;
      window.addEventListener('beforeunload', function () {
        try { if (_wsIsEditor) _wsFlushSave(); } catch (e) {}
        try { if (_wsBC) _wsBC.postMessage({ t: 'released', from: _wsInstanceId }); } catch (e) {}
      });
    }

    // Select first cell only when starting on a grid sheet — embedded
    // views don't have cells.
    if (!isEmbedSheet(activeSheet())) selectCell(0, 0);

    // Show linked cell indicators on cost inputs and push linked values
    setTimeout(function(){
      pushLinkedValues();
      updateLinkedIndicators();
      if (typeof refreshHeaderMetrics === 'function') refreshHeaderMetrics();
    }, 500);

    // ── Wire events ──
    wsTable.addEventListener('mousedown', handleCellMouseDown);
    wsTable.addEventListener('mousemove', handleCellMouseMove);
    document.addEventListener('mouseup', handleCellMouseUp);
    wsTable.addEventListener('dblclick', handleCellDblClick);
    wsContainer.addEventListener('keydown', handleKeyDown);
    formulaBar.addEventListener('focus', handleFormulaBarFocus);
    formulaBar.addEventListener('input', handleFormulaBarInput);

    // Name Box (the cell-reference input): Enter navigates to a cell,
    // range, or named range — or defines a new name for the selection.
    var nameBoxEl = document.getElementById('wsCellRef');
    if (nameBoxEl) {
      nameBoxEl.addEventListener('focus', function() { nameBoxEl.select(); });
      nameBoxEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          _handleNameBoxEntry(nameBoxEl.value);
          nameBoxEl.blur();
          if (wsContainer) wsContainer.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          nameBoxEl.blur();
          if (grid.selection) selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
        }
      });
    }

    // Column resize
    wsTable.addEventListener('mousedown', handleColResizeStart);
    document.addEventListener('mousemove', handleColResizeMove);
    document.addEventListener('mouseup', handleColResizeEnd);

    // Row resize
    wsTable.addEventListener('mousedown', handleRowResizeStart);
    document.addEventListener('mousemove', handleRowResizeMove);
    document.addEventListener('mouseup', handleRowResizeEnd);

    // Double-click on a row/column resize handle = AutoFit (Excel parity)
    wsTable.addEventListener('dblclick', function(e) {
      // Row resize handle (bottom edge of row header)
      if (e.target.classList && e.target.classList.contains('ws-row-resize')) {
        e.stopPropagation();
        const r = parseInt(e.target.dataset.row);
        if (!isNaN(r)) autoFitRow(r);
        return;
      }
      // Column resize handle: header right edge (within ~6px). Mirrors
      // the column-resize hit test in handleColResizeStart.
      if (e.target.classList && e.target.classList.contains('ws-col-header')) {
        const rect = e.target.getBoundingClientRect();
        if (e.clientX > rect.right - 6) {
          e.stopPropagation();
          const c = parseInt(e.target.dataset.col);
          if (!isNaN(c)) autoFitColumn(c);
        }
      }
    }, true);

    // Find & Replace shortcut
    wsContainer.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openFindReplace();
      }
    }, true);

    // Apply freeze classes if the active sheet has them
    applyFreezeClasses();

    // Context menu on cells and headers
    wsTable.addEventListener('contextmenu', function (e) {
      var cellTd = e.target.closest('td.ws-cell');
      var rowH = e.target.closest('td.ws-row-header');
      var colH = e.target.closest('th.ws-col-header');
      if (cellTd) {
        e.preventDefault();
        var cr = parseInt(cellTd.dataset.r), cc = parseInt(cellTd.dataset.c);
        var cellObj = getCell(cr, cc);
        var items = [];
        if (cellObj.note) {
          items.push({ label: 'Edit Note', action: function () { promptNote(cr, cc); } });
          items.push({ label: 'Delete Note', action: function () { deleteNote(cr, cc); } });
        } else {
          items.push({ label: 'Add Note', action: function () { promptNote(cr, cc); } });
        }
        showContextMenu(e.clientX, e.clientY, items);
      } else if (rowH) {
        e.preventDefault();
        var rowIdx = parseInt(rowH.parentElement.querySelector('td.ws-cell').dataset.r);
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Insert Row Above', action: function () { insertRow(rowIdx, 'above'); } },
          { label: 'Insert Row Below', action: function () { insertRow(rowIdx, 'below'); } },
          '---',
          { label: 'AutoFit Height (Fit to Content)', action: function () { autoFitRow(rowIdx); } },
          { label: 'AutoFit All Rows', action: function () { autoFitAllRows(); } },
          { label: 'Set Row Height…', action: function () {
            var h = prompt('Row height (px):', String(grid.rowHeights[rowIdx] || ROW_HEIGHT));
            if (h != null) setRowHeight(rowIdx, parseInt(h, 10));
          } },
          { label: 'Set All Row Heights…', action: function () {
            var h = prompt('Apply this height to every row (px):', String(ROW_HEIGHT));
            if (h != null) setAllRowHeights(parseInt(h, 10));
          } },
          '---',
          { label: 'Delete Row', action: function () { deleteRow(rowIdx); } }
        ]);
      } else if (colH) {
        e.preventDefault();
        var colIdx = parseInt(colH.dataset.col);
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Insert Column Left', action: function () { insertColumn(colIdx, 'left'); } },
          { label: 'Insert Column Right', action: function () { insertColumn(colIdx, 'right'); } },
          '---',
          { label: 'AutoFit Width (Fit to Content)', action: function () { autoFitColumn(colIdx); } },
          { label: 'AutoFit All Columns', action: function () { autoFitAllColumns(); } },
          { label: 'Set Column Width…', action: function () {
            var w = prompt('Column width (px):', String(grid.colWidths[colIdx] || COL_DEFAULT_WIDTH));
            if (w != null) setColumnWidth(colIdx, parseInt(w, 10));
          } },
          { label: 'Set All Column Widths…', action: function () {
            var w = prompt('Apply this width to every column (px):', String(COL_DEFAULT_WIDTH));
            if (w != null) setAllColWidths(parseInt(w, 10));
          } },
          '---',
          { label: 'Delete Column', action: function () { deleteColumn(colIdx); } }
        ]);
      }
    });

    // +Row / +Col buttons
    document.getElementById('wsAddRow').addEventListener('click', function () {
      insertRow(grid.rows - 1, 'below');
    });
    document.getElementById('wsAddCol').addEventListener('click', function () {
      insertColumn(grid.cols - 1, 'right');
    });

    // xlsx / csv import — picker triggered by the header Import button
    // (Quick Access Toolbar). Each sheet in the file appends as a new
    // tab; the workbook switches focus to the first imported sheet so
    // the result is visible.
    const importBtn = document.getElementById('wsImportXlsxBtnHeader');
    const importInput = document.getElementById('wsImportXlsxInputHeader');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', function() { importInput.value = ''; importInput.click(); });
      importInput.addEventListener('change', function(e) {
        const file = e.target.files && e.target.files[0];
        if (file) handleXlsxImport(file);
      });
    }

    // Phase 1 — duplicate wiring for the embedded ribbon button so the
    // estimate side (which has no floating shell) can also import.
    // The two buttons share semantics; click either, same handler.
    const importBtn2 = document.getElementById('wsImportXlsxBtn');
    const importInput2 = document.getElementById('wsImportXlsxInput');
    if (importBtn2 && importInput2) {
      importBtn2.addEventListener('click', function() { importInput2.value = ''; importInput2.click(); });
      importInput2.addEventListener('change', function(e) {
        const file = e.target.files && e.target.files[0];
        if (file) handleXlsxImport(file);
      });
    }

    // Toolbar buttons
    document.getElementById('wsLinkBtn').addEventListener('click', () => {
      const panel = document.getElementById('wsLinkPanel');
      if (panel.classList.contains('ws-link-panel-open')) {
        panel.classList.remove('ws-link-panel-open');
      } else {
        showLinkPanel();
      }
    });

    // File-action buttons — Save, Clear. These now live in the
     // floating panel header (Quick Access Toolbar). The wsImportXlsxBtn
     // / wsImportXlsxInput pair is wired below in the import block.
    // Node Graph button removed; the graph is reachable from the WIP
    // page sidebar.
    var saveBtn = document.getElementById('wsSaveBtnHeader');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        saveWorkspace();
        const status = document.getElementById('wsStatus');
        if (status) { status.textContent = '✓ Saved'; setTimeout(() => status.textContent = 'Ready', 2000); }
      });
    }
    var clearBtn = document.getElementById('wsClearBtnHeader');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('Clear all workspace data?')) {
          pushUndo();
          grid.cells = {};
          grid.links = {};
          grid.merges = [];
          grid.rows = MIN_ROWS;
          grid.cols = MIN_COLS;
          grid.colWidths = {};
          // Exact imported Excel geometry must clear too, or export
          // resurrects the old vendor widths onto the wiped sheet.
          dropColWch(null);
          dropRowHpt(null);
          saveWorkspace();
          renderGrid();
          selectCell(0, 0);
        }
      });
    }

    // Format buttons — apply the enum format across the whole selection.
    // A custom numFmt (from the Number Format editor) would otherwise mask
    // the enum in displayVal, so clear it here so the quick buttons win.
    wsContainer.querySelectorAll('.ws-btn-fmt').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!grid.selection) return;
        const fmt = btn.dataset.fmt;
        const rng = getSelRange();
        if (!rng) return;
        pushUndo();
        for (let r = rng.r1; r <= rng.r2; r++) {
          for (let c = rng.c1; c <= rng.c2; c++) {
            const cell = getCell(r, c);
            cell.fmt = fmt === 'null' ? null : fmt;
            if (cell.numFmt) delete cell.numFmt;
          }
        }
        grid.dirty = true;
        renderGrid();
        selectCell(grid.selection.r, grid.selection.c, !!grid.selEnd);
        saveWorkspace();
      });
    });

    // Formatting toolbar
    document.getElementById('wsUndoBtn').addEventListener('click', doUndo);
    document.getElementById('wsRedoBtn').addEventListener('click', doRedo);

    // Bold / Italic / Underline / Wrap toggles
    wsContainer.querySelectorAll('.ws-fmt-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        var prop = btn.dataset.style;
        if (prop) toggleStyleOnSelection(prop);
      });
    });

    // Alignment buttons
    wsContainer.querySelectorAll('.ws-fmt-align').forEach(btn => {
      btn.addEventListener('click', () => {
        var align = btn.dataset.align;
        if (!grid.selection) return;
        var cell = getCell(grid.selection.r, grid.selection.c);
        var current = (cell.style || {}).align;
        applyStyleToSelection('align', current === align ? null : align);
      });
    });

    // Fill color palette
    function applyFillColor(c) {
      if (c) addRecentColor(recentFillColors, c);
      applyStyleToSelection('bg', c);
      var swatch = document.getElementById('wsFillSwatch');
      if (swatch) swatch.style.background = c || 'transparent';
      closeColorPanels();
      buildRecentColors('wsFillRecent', recentFillColors, applyFillColor);
    }
    document.getElementById('wsFillBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      buildRecentColors('wsFillRecent', recentFillColors, applyFillColor);
      toggleColorPanel('wsFillPanel');
    });
    buildColorGrid('wsFillGrid', applyFillColor, 'No Fill');
    document.getElementById('wsFillCustom').addEventListener('input', function (e) {
      applyFillColor(e.target.value);
    });

    // Font color palette
    function applyFontColor(c) {
      if (c) addRecentColor(recentFontColors, c);
      applyStyleToSelection('color', c);
      var swatch = document.getElementById('wsFontSwatch');
      if (swatch) swatch.style.background = c || 'transparent';
      closeColorPanels();
      buildRecentColors('wsFontRecent', recentFontColors, applyFontColor);
    }
    document.getElementById('wsFontBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      buildRecentColors('wsFontRecent', recentFontColors, applyFontColor);
      toggleColorPanel('wsFontPanel');
    });
    buildColorGrid('wsFontGrid', applyFontColor, 'No Color');
    document.getElementById('wsFontCustom').addEventListener('input', function (e) {
      applyFontColor(e.target.value);
    });

    // Cell styles
    document.getElementById('wsStyleBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      buildStylePanel();
      toggleColorPanel('wsStylePanel');
    });

    // Borders dropdown — opens the preset grid; clicking a preset
    // applies it to the current selection and closes the panel.
    var borderBtnEl = document.getElementById('wsBorderBtn');
    if (borderBtnEl) {
      borderBtnEl.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleColorPanel('wsBorderPanel');
      });
    }
    var borderPanelEl = document.getElementById('wsBorderPanel');
    if (borderPanelEl) {
      borderPanelEl.addEventListener('click', function(e) {
        var btn = e.target.closest('.ws-border-preset');
        if (!btn) return;
        e.stopPropagation();
        applyBorderPreset(btn.getAttribute('data-border'));
        closeColorPanels();
      });
    }

    // Close panels when clicking outside
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.ws-color-dropdown')) closeColorPanels();
    });

    // Clear formatting
    document.getElementById('wsClearFmtBtn').addEventListener('click', clearFormattingOnSelection);

    // Merge / Unmerge
    document.getElementById('wsMergeBtn').addEventListener('click', mergeSelection);
    document.getElementById('wsUnmergeBtn').addEventListener('click', unmergeSelection);

    // Link options
    document.getElementById('wsLinkOptions').addEventListener('click', (e) => {
      const btn = e.target.closest('.ws-link-opt');
      if (!btn || !grid.selection) return;
      const linkObj = { field: btn.dataset.field, level: btn.dataset.level };
      if (btn.dataset.target) linkObj.targetId = btn.dataset.target;
      const cellAddr = addr(grid.selection.r, grid.selection.c);
      setLink(cellAddr, linkObj);
    });

    document.getElementById('wsUnlinkBtn').addEventListener('click', () => {
      if (!grid.selection) return;
      unlinkCell(addr(grid.selection.r, grid.selection.c));
    });

    // Paste support
    wsContainer.addEventListener('paste', (e) => {
      if (!grid.selection || grid.editing) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      if (!text) return;
      pushUndo();
      const rows = text.split('\n').map(r => r.split('\t'));
      const startR = grid.selection.r;
      const startC = grid.selection.c;

      rows.forEach((row, ri) => {
        row.forEach((val, ci) => {
          const r = startR + ri;
          const c = startC + ci;
          // Expand grid if needed
          if (r >= grid.rows) grid.rows = r + EXPAND_BUFFER;
          if (c >= grid.cols) grid.cols = c + EXPAND_BUFFER;
          const cell = getCell(r, c);
          // Clean Excel formatting: strip $, commas, %, trailing whitespace
          var clean = val.trim();
          var numTest = clean.replace(/^\$/, '').replace(/,/g, '').trim();
          if (numTest.endsWith('%')) {
            var pctVal = parseFloat(numTest.replace('%', ''));
            if (!isNaN(pctVal)) { cell.raw = String(pctVal / 100); cell.fmt = 'percent'; }
            else cell.raw = clean;
            delete cell.importedValue; // paste overwrote the cell
          } else {
            var numVal = Number(numTest);
            if (numTest !== '' && !isNaN(numVal)) {
              cell.raw = String(numVal);
              if (clean.startsWith('$')) cell.fmt = 'currency';
            } else {
              cell.raw = clean;
            }
          }
        });
      });

      recalcAll();
      renderGrid();
      selectCell(startR, startC);
      pushLinkedValues();
      saveWorkspace();
    });
  }

  // ── Expose globally ────────────────────────────────────────
  window.initWorkspace = initWorkspace;
  window.renderWorkspacePopout = renderWorkspacePopout; // WS-POP: standalone window entry
  window.workspaceGrid = grid;

})();
