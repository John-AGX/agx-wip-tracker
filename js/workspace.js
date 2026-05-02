// ============================================================
// AGX WIP Tracker — Workspace Spreadsheet Engine (v3)
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
    '#1e40af', '#5b21b6', '#9d174d', '#1e2130'
  ];

  // Cell style presets
  const CELL_STYLES = [
    { name: 'Header', style: { bold: true, bg: '#2563eb', color: '#ffffff', align: 'center' } },
    { name: 'Header Dark', style: { bold: true, bg: '#1f2937', color: '#ffffff', align: 'center' } },
    { name: 'Header Green', style: { bold: true, bg: '#059669', color: '#ffffff', align: 'center' } },
    { name: 'Subheader', style: { bold: true, bg: '#374151', color: '#e4e6f0', align: 'left' } },
    { name: 'Total Row', style: { bold: true, bg: '#1e2130', color: '#4f8cff', align: 'right' } },
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
    jobId: null,
    activeSheetId: null,
    sheets: [],        // [{ id, name, rows, cols, cells, colWidths, links, merges }, ...]
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
      if (cell.fmt === 'currency') return '$' + cell.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (cell.fmt === 'percent') return (cell.value * 100).toFixed(1) + '%';
      // Auto-format: if it looks like money (has decimals)
      if (Number.isFinite(cell.value) && !Number.isInteger(cell.value)) {
        return cell.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return cell.value.toLocaleString('en-US');
    }
    return String(cell.value);
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

  /** Evaluate a cell's raw value; detect formulas starting with '=' */
  function evaluate(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('=')) {
      if (raw === '' || raw === null || raw === undefined) return '';
      const n = Number(raw);
      return isNaN(n) ? raw : n;
    }

    const expr = raw.substring(1);

    try {
      // Cross-sheet refs first: `Sheet2!A1` or `'Sheet Two'!A1`. These
      // need to be resolved BEFORE the same-sheet ref pass below,
      // otherwise the bare `A1` inside `Sheet2!A1` would match the
      // local-sheet regex and produce the wrong value.
      var resolved = expr.replace(
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
    // 3 passes handles most dependency depths
    for (let pass = 0; pass < 3; pass++) {
      Object.keys(grid.cells).forEach(key => {
        const cell = grid.cells[key];
        const result = evaluate(cell.raw);
        if (typeof result === 'string' && (result === '#ERR' || result === '#DIV/0!')) {
          cell.value = result;
          cell.error = result;
        } else {
          cell.value = result;
          cell.error = null;
        }
      });
    }
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
    sub: 'jobCostSub',
    revisedCostChanges: 'wipRevisedCostChanges',
    invoicedToDate: 'wipInvoicedToDate',
    pctComplete: 'wipPctComplete'
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

    // Hide grid-only chrome
    var hideSelectors = [
      '.ws-toolbar',
      '.ws-toolbar-fmt',
      '.ws-link-panel',
      '.ws-grid-wrapper',
      '.ws-statusbar'
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
      if (typeof window.agxAttachments === 'undefined' || !window.agxAttachments.mount) {
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
        mount.style.background = 'var(--surface, #1a1d27)';
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
              '<strong style="color:#a78bfa;">.xlsx / .xls / .csv files auto-import as workspace sheets</strong> so the WIP Assistant can read them.' +
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
        window.agxAttachments.mount(slot, {
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
                  '. The WIP Assistant can now read them via the Detailed Costs / sheet tabs above.' +
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

  function saveWorkspace() {
    if (!workbook.jobId) return;
    syncGridToActiveSheet();
    const data = {
      // Versioned shape so the next migration knows what it's reading.
      version: 2,
      activeSheetId: workbook.activeSheetId,
      sheets: workbook.sheets
    };
    const allWs = safeLoadJSON('agx-workspaces', {});
    allWs[workbook.jobId] = data;
    localStorage.setItem('agx-workspaces', JSON.stringify(allWs));
    workbook.dirty = false;
    grid.dirty = false;
  }

  function loadWorkspace(jobId) {
    const allWs = safeLoadJSON('agx-workspaces', {});
    const saved = allWs[jobId];

    workbook.jobId = jobId;

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
        links: s.links || {},
        merges: s.merges || [],
        tables: s.tables || [],
        pinned: !!s.pinned,
        // Preserve xlsx-import provenance across reloads so future
        // tooling (e.g. "remove all sheets from <file>") can find them.
        sourceFile: s.sourceFile || null,
        sourceSheetName: s.sourceSheetName || null
      }));
      workbook.activeSheetId = saved.activeSheetId && workbook.sheets.find(s => s.id === saved.activeSheetId)
        ? saved.activeSheetId
        : workbook.sheets[0].id;
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
    if (!workbook.sheets.some(s => s.id === QB_COSTS_SHEET_ID)) {
      workbook.sheets.push(makeQBCostsSheet());
    }
    if (!workbook.sheets.some(s => s.id === ATTACHMENTS_SHEET_ID)) {
      workbook.sheets.push(makeAttachmentsSheet());
    }

    workbook.dirty = false;
    grid.jobId = jobId;
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
    loadSheetIntoGrid(target);
    workbook.dirty = true;
    grid.dirty = !isEmbedSheet(target);
    if (!isEmbedSheet(target)) recalcAll();
    renderActiveSheet();
    renderSheetTabs();
    if (!isEmbedSheet(target)) selectCell(0, 0);
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

  function deleteSheet(sheetId) {
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
    if (!confirm('Delete sheet "' + sheet.name + '"? This cannot be undone.')) return;
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
  // Parse a vendor xlsx with SheetJS and append each Excel sheet as a
  // new tab in the workbook. Existing sheets are preserved.
  // Imported as window.wsImportXlsxFile so the Attachments embed (and
  // any future drop targets) can reuse the same parser/import path
  // when the user drops an xlsx anywhere in the workspace UI.
  function handleXlsxImport(file) {
    if (typeof XLSX === 'undefined') {
      alert('Spreadsheet library still loading. Try again in a moment.');
      return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const data = new Uint8Array(e.target.result);
        // cellFormula:true gives us .f (formula string) on each cell;
        // cellDates:true keeps dates as JS Date objects so we can render
        // them sensibly.
        // cellStyles: true asks SheetJS to return per-cell font/fill/
        // alignment so we can preserve the look of the source xlsx —
        // headers stay bold, totals keep their fills, etc.
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
        // Sync current grid before mutating workbook
        syncGridToActiveSheet();
        const baseName = file.name.replace(/\.[^.]+$/, '');
        let added = 0;
        // Multi-sheet xlsx files behave like a workbook themselves —
        // ALWAYS prefix the file name so the resulting AGX tabs stay
        // visually grouped ("Q1 · Sales", "Q1 · Costs") and the user
        // can see at a glance which sheets came from which import.
        // Single-sheet files don't need the prefix; the bare sheet
        // name reads cleaner.
        const isMulti = wb.SheetNames.length > 1;
        // Find the right insertion index — keep imported sheets
        // grouped together at the end of editable tabs but before
        // any pinned built-ins (Detailed Costs, Attachments).
        let insertAt = workbook.sheets.findIndex(s => s.pinned);
        if (insertAt === -1) insertAt = workbook.sheets.length;
        wb.SheetNames.forEach(function(srcName) {
          const ws = wb.Sheets[srcName];
          if (!ws) return;
          // Multi-sheet → always prefix with file name. Single-sheet
          // → bare name; collision-prefix only on conflict.
          let name = isMulti ? (baseName + ' · ' + srcName) : srcName;
          if (workbook.sheets.some(s => s.name === name)) {
            // Collision after the standard naming rule — append (n)
            // until we find a free slot.
            let collisionN = 2;
            const stem = name;
            while (workbook.sheets.some(s => s.name === name)) {
              name = stem + ' (' + (collisionN++) + ')';
            }
          }
          const sheet = importXlsxSheet(ws, name);
          if (sheet) {
            // Track origin so a future "delete imported workbook"
            // action can find every sheet from a given file.
            sheet.sourceFile = file.name;
            sheet.sourceSheetName = srcName;
            workbook.sheets.splice(insertAt, 0, sheet);
            insertAt++;
            added++;
          }
        });
        if (!added) {
          alert('Nothing imported — sheets were empty.');
          return;
        }
        // Switch to the first newly-added sheet so the user sees the
        // result of their import.
        const firstNew = workbook.sheets[workbook.sheets.length - added];
        workbook.activeSheetId = firstNew.id;
        loadSheetIntoGrid(firstNew);
        workbook.dirty = true;
        recalcAll();
        renderGrid();
        renderSheetTabs();
        selectCell(0, 0);
      } catch (err) {
        console.error('xlsx import failed:', err);
        alert('Import failed: ' + (err.message || err));
      }
    };
    reader.readAsArrayBuffer(file);
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
        if (cell.f) {
          raw = '=' + cell.f;
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
        const out = { raw: raw == null ? '' : raw, value: raw == null ? '' : raw };
        if (style) out.style = style;
        // Number format pass-through — when Excel format is currency
        // or percent, set our fmt so values render correctly.
        if (cell.z) {
          if (/[\$£€¥]/.test(cell.z) || /\bUSD\b/i.test(cell.z)) out.fmt = 'currency';
          else if (/%/.test(cell.z)) out.fmt = 'percent';
        }
        cells[ourAddr] = out;
      }
    }
    // Pull column widths from xlsx if present
    const colWidths = {};
    if (ws['!cols']) {
      ws['!cols'].forEach(function(col, idx) {
        if (col && (col.wpx || col.wch)) {
          colWidths[idx] = Math.max(60, Math.round(col.wpx || (col.wch * 7)));
        }
      });
    }
    // Row heights — preserve any explicit per-row height the source
    // xlsx had (Excel uses points; we use px ≈ pt × 1.333).
    const rowHeights = {};
    if (ws['!rows']) {
      ws['!rows'].forEach(function(row, idx) {
        if (row && (row.hpx || row.hpt)) {
          rowHeights[idx] = Math.max(18, Math.round(row.hpx || (row.hpt * 1.333)));
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
      rowHeights: rowHeights,
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
  function xlsxStyleToAgx(s) {
    if (!s || typeof s !== 'object') return null;
    var out = {};
    var hadColor = function(c) {
      if (!c || typeof c !== 'object') return null;
      var rgb = c.rgb;
      if (typeof rgb !== 'string') return null;
      // ARGB → RGB (drop alpha) and AABBCC → #AABBCC
      if (rgb.length === 8) rgb = rgb.slice(2);
      if (rgb.length !== 6) return null;
      return '#' + rgb.toLowerCase();
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

  function buildWorkspaceHTML() {
    return `
      <!-- Formula bar — Excel-style cell reference + formula input,
           kept as its own row above the ribbon so it gets full width
           and the long formula text isn't crowded by buttons. -->
      <div class="ws-toolbar">
        <div class="ws-cell-ref" id="wsCellRef">A1</div>
        <input type="text" class="ws-formula-bar" id="wsFormulaBar" placeholder="Enter value or formula (e.g. =A1+B1)" spellcheck="false" />
      </div>

      <!-- Ribbon — single grouped row that mirrors Excel's Home tab
           layout: each section is a vertical stack of controls + a
           small uppercase label underneath, separated by 1px dividers.
           All button IDs / data-attrs preserved from the previous
           flat layout so the wiring code keeps working unchanged. -->
      <div class="ws-ribbon" id="wsToolbarFmt">

        <!-- History -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-btn-icon" id="wsUndoBtn" title="Undo (Ctrl+Z)">&#x21A9;</button>
            <button class="ws-btn ws-btn-icon" id="wsRedoBtn" title="Redo (Ctrl+Y)">&#x21AA;</button>
          </div>
          <div class="ws-ribbon-label">History</div>
        </div>

        <!-- Font -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-fmt-toggle" id="wsBoldBtn" data-style="bold" title="Bold (Ctrl+B)"><b>B</b></button>
            <button class="ws-btn ws-fmt-toggle" id="wsItalicBtn" data-style="italic" title="Italic (Ctrl+I)"><i>I</i></button>
            <button class="ws-btn ws-fmt-toggle" id="wsUnderlineBtn" data-style="underline" title="Underline (Ctrl+U)"><u>U</u></button>
            <div class="ws-color-dropdown" id="wsFillDropdown">
              <button class="ws-btn ws-btn-icon ws-color-trigger" id="wsFillBtn" title="Fill color">
                <span class="ws-color-icon">&#x25A0;</span>
                <span class="ws-color-swatch" id="wsFillSwatch"></span>
              </button>
              <div class="ws-color-panel" id="wsFillPanel">
                <div class="ws-color-grid" id="wsFillGrid"></div>
                <div class="ws-color-recent-label">Recent</div>
                <div class="ws-color-recent" id="wsFillRecent"></div>
                <div class="ws-color-custom"><label>Custom <input type="color" id="wsFillCustom" value="#1e2130" /></label></div>
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
            <button class="ws-btn ws-fmt-align" data-align="left" title="Align left">&#x2190;</button>
            <button class="ws-btn ws-fmt-align" data-align="center" title="Align center">&#x2194;</button>
            <button class="ws-btn ws-fmt-align" data-align="right" title="Align right">&#x2192;</button>
            <button class="ws-btn ws-fmt-toggle" id="wsWrapBtn" data-style="wrap" title="Wrap text">&#x21B5;</button>
            <button class="ws-btn" id="wsMergeBtn" title="Merge cells">&#x1F500;</button>
            <button class="ws-btn" id="wsUnmergeBtn" title="Unmerge cells">&#x2702;</button>
          </div>
          <div class="ws-ribbon-label">Alignment</div>
        </div>

        <!-- Number -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn ws-btn-fmt" data-fmt="currency" title="Currency format">$</button>
            <button class="ws-btn ws-btn-fmt" data-fmt="percent" title="Percent format">%</button>
            <button class="ws-btn ws-btn-fmt" data-fmt="null" title="Clear number format">&times;</button>
          </div>
          <div class="ws-ribbon-label">Number</div>
        </div>

        <!-- Styles -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <div class="ws-color-dropdown" id="wsStyleDropdown">
              <button class="ws-btn ws-btn-icon" id="wsStyleBtn" title="Cell styles">&#x1F3A8;</button>
              <div class="ws-color-panel ws-style-panel" id="wsStylePanel"></div>
            </div>
            <button class="ws-btn ws-btn-icon" id="wsClearFmtBtn" title="Clear formatting">&#x2718;</button>
          </div>
          <div class="ws-ribbon-label">Styles</div>
        </div>

        <!-- Cells -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn" id="wsLinkBtn" title="Link cell to job field">&#x1F517;</button>
            <button class="ws-btn" id="wsMakeTableBtn" onclick="window.wsMakeTable()" title="Convert selected range into a styled table">&#x1F5C2;</button>
          </div>
          <div class="ws-ribbon-label">Cells</div>
        </div>

        <!-- Editing -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn" id="wsAutoSumBtn" onclick="window.wsAutoSum()" title="AutoSum (Σ) — insert =SUM with auto-detected range">&#x03A3;</button>
            <button class="ws-btn" id="wsSortAscBtn" onclick="window.wsSortAscHeader()" title="Sort range ascending">&#x2191;A</button>
            <button class="ws-btn" id="wsSortDescBtn" onclick="window.wsSortDescHeader()" title="Sort range descending">&#x2193;Z</button>
            <button class="ws-btn" id="wsFindBtn" onclick="window.wsOpenFindReplace()" title="Find &amp; Replace (Ctrl+F)">&#x1F50D;</button>
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

        <span class="ws-toolbar-spacer"></span>

        <!-- File (right-aligned via spacer) -->
        <div class="ws-ribbon-group">
          <div class="ws-ribbon-controls">
            <button class="ws-btn" id="wsImportXlsxBtn" title="Import .xlsx as new sheets">&#x1F4E5;</button>
            <input type="file" id="wsImportXlsxInput" accept=".xlsx,.xls,.csv" style="display:none;" />
            <button class="ws-btn" id="wsClearBtn" title="Clear workspace">&#x1F5D1;</button>
            <button class="ws-btn ws-btn-save" id="wsSaveBtn" title="Save workspace (Ctrl+S)">&#x1F4BE;</button>
            <button class="ws-btn" id="wsNodeGraphBtn" title="Node Graph (Beta)">&#x1F4CA;</button>
          </div>
          <div class="ws-ribbon-label">File</div>
        </div>
      </div>
      <div class="ws-link-panel" id="wsLinkPanel" style="display:none;">
        <div class="ws-link-header">
          <div class="ws-link-title">Link <span id="wsLinkCell">A1</span> → Job Field</div>
          <div class="ws-link-active" id="wsLinkActive"></div>
          <button class="ws-btn ws-btn-unlink" id="wsUnlinkBtn" style="display:none;">&#x1F517; Unlink</button>
        </div>
        <div class="ws-link-options" id="wsLinkOptions"></div>
      </div>
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
    workbook.sheets.forEach(function(s) {
      const active = s.id === workbook.activeSheetId;
      // Pinned built-in views (e.g. Detailed Costs, Attachments) get
      // a marker icon and a different class so the context menu can
      // lock destructive actions and CSS can style them subtly.
      var icon = '';
      var kindCls = '';
      if (s.kind === 'qb-costs') {
        icon = '<span class="ws-sheet-tab-icon" aria-hidden="true">&#x1F4CB;</span> ';
        kindCls = ' ws-sheet-tab-qb-costs';
      } else if (s.kind === 'attachments') {
        icon = '<span class="ws-sheet-tab-icon" aria-hidden="true">&#x1F4CE;</span> ';
        kindCls = ' ws-sheet-tab-attachments';
      }
      html += '<div class="ws-sheet-tab' + (active ? ' active' : '') +
        (s.pinned ? ' ws-sheet-tab-pinned' : '') + kindCls + '" data-sheet-id="' +
        s.id + '" title="' + escapeAttr(s.name) + '">' +
        icon +
        '<span class="ws-sheet-tab-name">' + escapeHTML(s.name) + '</span>' +
      '</div>';
    });
    html += '<button class="ws-sheet-tab-add" id="wsAddSheetBtn" title="Add sheet">+</button>';
    html += '</div>';
    wrap.innerHTML = html;
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
          { label: 'Delete', action: function() { deleteSheet(id); } }
        ];
        showContextMenu(e.clientX, e.clientY, items);
      });
    });
    const addBtn = wrap.querySelector('#wsAddSheetBtn');
    if (addBtn) addBtn.addEventListener('click', function() { addSheet(); });
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
    if (s.underline) st += 'text-decoration:underline;';
    if (s.align) st += 'text-align:' + s.align + ';';
    if (s.wrap) st += 'white-space:normal;word-wrap:break-word;';
    // Imported xlsx cells carry an explicit pt → px font size; only
    // apply when set so the workspace's default sizing wins for
    // hand-typed cells.
    if (typeof s.fontSize === 'number' && s.fontSize > 0) {
      st += 'font-size:' + s.fontSize + 'px;';
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

    let html = '<thead><tr><th class="ws-corner"></th>';
    for (let c = 0; c < grid.cols; c++) {
      const w = grid.colWidths[c] || COL_DEFAULT_WIDTH;
      html += `<th class="ws-col-header" data-col="${c}" style="width:${w}px;min-width:${w}px;">${colLetter(c)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 0; r < grid.rows; r++) {
      const rh = grid.rowHeights && grid.rowHeights[r];
      const trStyle = rh ? ` style="height:${rh}px;"` : '';
      // Row header carries data-row so the resize-handle hit test below
      // knows which row it's on. Resize handle is the bottom-edge strip.
      html += `<tr${trStyle}><td class="ws-row-header" data-row="${r}">${r + 1}<div class="ws-row-resize" data-row="${r}"></div></td>`;
      for (let c = 0; c < grid.cols; c++) {
        // Skip hidden merged cells
        if (hidden[r + ',' + c]) continue;

        const key = addr(r, c);
        const cell = grid.cells[key] || { raw: '', value: '', fmt: null, style: {} };
        const val = displayVal(cell);
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

        html += `<td class="${cls}" data-r="${r}" data-c="${c}" style="${st}"${attrs}${titleAttr}>${val}</td>`;
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
    td.textContent = displayVal(cell);

    td.className = 'ws-cell';
    if (grid.selection && grid.selection.r === r && grid.selection.c === c) td.classList.add('ws-selected');
    if (grid.links[key]) td.classList.add('ws-linked');
    if (cell.error) td.classList.add('ws-error');
    if (typeof cell.raw === 'string' && cell.raw.startsWith('=')) td.classList.add('ws-formula');
    if (typeof cell.value === 'number' && !(cell.style && cell.style.align)) td.classList.add('ws-number');
    if (cell.note) td.classList.add('ws-has-note');
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
    if (fillSwatch) fillSwatch.style.background = s.bg || '#1e2130';
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
    if (refEl) {
      var rng = getSelRange();
      if (grid.selEnd && (rng.r1 !== rng.r2 || rng.c1 !== rng.c2)) {
        refEl.textContent = addr(rng.r1, rng.c1) + ':' + addr(rng.r2, rng.c2);
      } else {
        refEl.textContent = key;
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

    td.contentEditable = false;
    td.classList.remove('ws-editing');
    grid.editing = null;
    exitRefMode();
    grid.dirty = true;

    // Recalculate
    recalcAll();

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
      td.textContent = displayVal(cell);
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

    panel.style.display = 'block';
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
    return {
      cells: JSON.parse(JSON.stringify(grid.cells)),
      links: JSON.parse(JSON.stringify(grid.links)),
      merges: JSON.parse(JSON.stringify(grid.merges)),
      rows: grid.rows, cols: grid.cols,
      colWidths: JSON.parse(JSON.stringify(grid.colWidths))
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
    // Shift colWidths for column operations
    if (axis === 'col') {
      var newW = {};
      Object.keys(grid.colWidths).forEach(function (k) {
        var ci = parseInt(k);
        if (delta < 0 && ci === position) return;
        if (ci >= position) ci += delta;
        if (ci >= 0) newW[ci] = grid.colWidths[k];
      });
      grid.colWidths = newW;
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

  // ── Cell Notes ─────────────────────────────────────────────

  function promptNote(r, c) {
    var cell = getCell(r, c);
    var text = prompt('Cell note:', cell.note || '');
    if (text === null) return; // cancelled
    pushUndo();
    if (text) {
      cell.note = text;
    } else {
      delete cell.note;
    }
    grid.dirty = true;
    renderGrid();
    selectCell(r, c);
    saveWorkspace();
  }

  function deleteNote(r, c) {
    var cell = getCell(r, c);
    if (!cell.note) return;
    pushUndo();
    delete cell.note;
    grid.dirty = true;
    refreshCell(r, c);
    saveWorkspace();
  }

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
      if (refEl && rng) refEl.textContent = addr(rng.r1, rng.c1) + ':' + addr(rng.r2, rng.c2);
      updateQuickCalc();
    }
  }

  function handleCellMouseUp(e) {
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
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function autoFitAllRows() {
    for (let r = 0; r < grid.rows; r++) {
      autoFitRowSilent(r);
    }
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
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function setRowHeight(r, height) {
    const h = Math.max(18, Number(height) || ROW_HEIGHT);
    if (h === ROW_HEIGHT) delete grid.rowHeights[r];
    else grid.rowHeights[r] = h;
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
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function autoFitAllColumns() {
    for (let c = 0; c < grid.cols; c++) {
      autoFitColumnSilent(c);
    }
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
    grid.dirty = true;
    renderGrid();
    saveWorkspace();
  }

  function setColumnWidth(c, width) {
    const w = Math.max(40, Number(width) || COL_DEFAULT_WIDTH);
    if (w === COL_DEFAULT_WIDTH) delete grid.colWidths[c];
    else grid.colWidths[c] = w;
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
  window.wsOpenFindReplace = openFindReplace;
  window.wsSetFreeze = setFreeze;
  // Public xlsx-import hook so the Attachments embed (and other drop
  // targets) can route .xlsx / .xls / .csv files into the workbook.
  window.wsImportXlsxFile = function(file) {
    if (!file) return;
    handleXlsxImport(file);
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

  function initWorkspace(containerId, jobId) {
    wsContainer = document.getElementById(containerId);
    if (!wsContainer) return;

    loadWorkspace(jobId);
    wsContainer.innerHTML = buildWorkspaceHTML();

    wsTable = document.getElementById('wsGrid');
    formulaBar = document.getElementById('wsFormulaBar');

    renderActiveSheet();
    renderSheetTabs();

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

    // xlsx / csv import — picker triggered by toolbar button. Each
    // sheet in the file appends as a new tab; the workbook switches
    // focus to the first imported sheet so the result is visible.
    const importBtn = document.getElementById('wsImportXlsxBtn');
    const importInput = document.getElementById('wsImportXlsxInput');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', function() { importInput.value = ''; importInput.click(); });
      importInput.addEventListener('change', function(e) {
        const file = e.target.files && e.target.files[0];
        if (file) handleXlsxImport(file);
      });
    }

    // Toolbar buttons
    document.getElementById('wsLinkBtn').addEventListener('click', () => {
      const panel = document.getElementById('wsLinkPanel');
      if (panel.style.display === 'none') showLinkPanel();
      else panel.style.display = 'none';
    });

    document.getElementById('wsSaveBtn').addEventListener('click', () => {
      saveWorkspace();
      const status = document.getElementById('wsStatus');
      if (status) { status.textContent = '✓ Saved'; setTimeout(() => status.textContent = 'Ready', 2000); }
    });

    document.getElementById('wsNodeGraphBtn').addEventListener('click', () => {
      var ngTab = document.getElementById('nodeGraphTab');
      if (!ngTab) return;
      if (ngTab.classList.contains('active')) {
        // Switch back to spreadsheet
        ngTab.classList.remove('active');
      } else {
        // Switch to node graph
        if (typeof openNodeGraph === 'function') openNodeGraph(grid.jobId);
      }
    });

    document.getElementById('wsClearBtn').addEventListener('click', () => {
      if (confirm('Clear all workspace data?')) {
        pushUndo();
        grid.cells = {};
        grid.links = {};
        grid.merges = [];
        grid.rows = MIN_ROWS;
        grid.cols = MIN_COLS;
        grid.colWidths = {};
        saveWorkspace();
        renderGrid();
        selectCell(0, 0);
      }
    });

    // Format buttons
    wsContainer.querySelectorAll('.ws-btn-fmt').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!grid.selection) return;
        const cell = getCell(grid.selection.r, grid.selection.c);
        const fmt = btn.dataset.fmt;
        cell.fmt = fmt === 'null' ? null : fmt;
        grid.dirty = true;
        refreshCell(grid.selection.r, grid.selection.c);
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
  window.workspaceGrid = grid;

})();
