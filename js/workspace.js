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
  const MIN_ROWS = 42;
  const MIN_COLS = 8;
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
  let grid = {
    rows: MIN_ROWS,
    cols: MIN_COLS,
    cells: {},       // { "A1": { raw: "=B1*2", value: 42, fmt: null, style: {} }, ... }
    colWidths: {},   // { 0: 120, 1: 100, ... }
    selection: null,  // { r: 0, c: 0 }
    selEnd: null,     // { r, c } for range selection end (null = single cell)
    editing: null,    // { r: 0, c: 0 }
    links: {},        // { "C5": "contractAmount", "D5": "estimatedCosts" }
    merges: [],       // [{ r1, c1, r2, c2 }, ...] merged cell ranges
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
  function evalFunction(name, argsStr) {
    var args = splitArgs(argsStr);
    switch (name) {
      case 'SUM': { var v = getRangeValues(argsStr); return v.reduce(function (a, b) { return a + b; }, 0); }
      case 'AVERAGE': { var v = getRangeValues(argsStr); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : 0; }
      case 'MAX': { var v = getRangeValues(argsStr); return v.length ? Math.max.apply(null, v) : 0; }
      case 'MIN': { var v = getRangeValues(argsStr); return v.length ? Math.min.apply(null, v) : 0; }
      case 'COUNT': { return getRangeValues(argsStr).length; }
      case 'ROUND': { return args.length >= 2 ? +safeEvalExpr(args[0]).toFixed(safeEvalExpr(args[1])) : Math.round(safeEvalExpr(args[0])); }
      case 'ABS': { return Math.abs(safeEvalExpr(args[0])); }
      case 'CEILING': { var v = safeEvalExpr(args[0]), s = args.length >= 2 ? safeEvalExpr(args[1]) : 1; return Math.ceil(v / s) * s; }
      case 'FLOOR': { var v = safeEvalExpr(args[0]), s = args.length >= 2 ? safeEvalExpr(args[1]) : 1; return Math.floor(v / s) * s; }
      case 'IF': {
        if (args.length < 3) return '#ERR';
        return safeEvalExpr(args[0]) ? safeEvalExpr(args[1]) : safeEvalExpr(args[2]);
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
      // Replace cell references with their numeric values
      var resolved = expr.replace(/\b([A-Z]+)(\d+)\b/gi, function (match, col, row) {
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

  /** Get a flat list of all field definitions for looking up fmt by key */
  function findFieldDef(linkObj) {
    var lists = { job: JOB_FIELDS, building: BUILDING_FIELDS, phase: PHASE_FIELDS, sub: SUB_FIELDS, co: CO_FIELDS };
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

  function saveWorkspace() {
    if (!grid.jobId) return;
    const data = {
      rows: grid.rows,
      cols: grid.cols,
      cells: grid.cells,
      colWidths: grid.colWidths,
      links: grid.links,
      merges: grid.merges
    };
    const allWs = safeLoadJSON('agx-workspaces', {});
    allWs[grid.jobId] = data;
    localStorage.setItem('agx-workspaces', JSON.stringify(allWs));
    grid.dirty = false;
  }

  function loadWorkspace(jobId) {
    const allWs = safeLoadJSON('agx-workspaces', {});
    const saved = allWs[jobId];
    if (saved) {
      grid.rows = Math.max(saved.rows || MIN_ROWS, MIN_ROWS);
      grid.cols = Math.max(saved.cols || MIN_COLS, MIN_COLS);
      grid.cells = saved.cells || {};
      grid.colWidths = saved.colWidths || {};
      grid.links = saved.links || {};
      grid.merges = saved.merges || [];
    } else {
      grid.rows = MIN_ROWS;
      grid.cols = MIN_COLS;
      grid.cells = {};
      grid.colWidths = {};
      grid.links = {};
      grid.merges = [];
    }
    grid.jobId = jobId;
    grid.selection = null;
    grid.editing = null;
    grid.refMode = false;
    grid.refAnchor = null;
    grid.dirty = false;
    migrateLinks();
    recalcAll();
  }

  // ── Rendering ──────────────────────────────────────────────

  function buildWorkspaceHTML() {
    return `
      <div class="ws-toolbar">
        <div class="ws-cell-ref" id="wsCellRef">A1</div>
        <input type="text" class="ws-formula-bar" id="wsFormulaBar" placeholder="Enter value or formula (e.g. =A1+B1)" spellcheck="false" />
        <div class="ws-toolbar-actions">
          <button class="ws-btn ws-btn-fmt" data-fmt="currency" title="Currency format">$</button>
          <button class="ws-btn ws-btn-fmt" data-fmt="percent" title="Percent format">%</button>
          <button class="ws-btn ws-btn-fmt" data-fmt="null" title="Clear format">&times;</button>
          <span class="ws-separator"></span>
          <button class="ws-btn" id="wsLinkBtn" title="Link cell to job field">&#x1F517; Link</button>
          <button class="ws-btn" id="wsClearBtn" title="Clear workspace">&#x1F5D1; Clear</button>
          <button class="ws-btn ws-btn-save" id="wsSaveBtn" title="Save workspace">&#x1F4BE; Save</button>
          <button class="ws-btn" id="wsNodeGraphBtn" title="Node Graph (Beta)">&#x26A1;</button>
        </div>
      </div>
      <div class="ws-toolbar-fmt" id="wsToolbarFmt">
        <button class="ws-btn ws-btn-icon" id="wsUndoBtn" title="Undo (Ctrl+Z)">&#x21A9;</button>
        <button class="ws-btn ws-btn-icon" id="wsRedoBtn" title="Redo (Ctrl+Y)">&#x21AA;</button>
        <span class="ws-separator"></span>
        <button class="ws-btn ws-fmt-toggle" id="wsBoldBtn" data-style="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="ws-btn ws-fmt-toggle" id="wsItalicBtn" data-style="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="ws-btn ws-fmt-toggle" id="wsUnderlineBtn" data-style="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <span class="ws-separator"></span>
        <button class="ws-btn ws-fmt-align" data-align="left" title="Align left">&#x2190;</button>
        <button class="ws-btn ws-fmt-align" data-align="center" title="Align center">&#x2194;</button>
        <button class="ws-btn ws-fmt-align" data-align="right" title="Align right">&#x2192;</button>
        <span class="ws-separator"></span>
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
        <button class="ws-btn ws-btn-icon" id="wsClearFmtBtn" title="Clear formatting">&#x2718;</button>
        <span class="ws-separator"></span>
        <div class="ws-color-dropdown" id="wsStyleDropdown">
          <button class="ws-btn ws-btn-icon" id="wsStyleBtn" title="Cell styles">&#x1F3A8; Style</button>
          <div class="ws-color-panel ws-style-panel" id="wsStylePanel"></div>
        </div>
        <span class="ws-separator"></span>
        <button class="ws-btn ws-fmt-toggle" id="wsWrapBtn" data-style="wrap" title="Wrap text">&#x21B5;</button>
        <span class="ws-separator"></span>
        <button class="ws-btn" id="wsMergeBtn" title="Merge cells">&#x1F500; Merge</button>
        <button class="ws-btn" id="wsUnmergeBtn" title="Unmerge cells">&#x2702; Unmerge</button>
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
    return st;
  }

  function renderGrid() {
    if (!wsTable) return;

    var hidden = buildHiddenSet();

    let html = '<thead><tr><th class="ws-corner"></th>';
    for (let c = 0; c < grid.cols; c++) {
      const w = grid.colWidths[c] || COL_DEFAULT_WIDTH;
      html += `<th class="ws-col-header" data-col="${c}" style="width:${w}px;min-width:${w}px;">${colLetter(c)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 0; r < grid.rows; r++) {
      html += `<tr><td class="ws-row-header">${r + 1}</td>`;
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

  function handleColResizeStart(e) {
    if (!e.target.classList.contains('ws-col-header')) return;
    const rect = e.target.getBoundingClientRect();
    // Only resize if clicking near right edge
    if (e.clientX > rect.right - 6) {
      e.preventDefault();
      resizing = {
        col: parseInt(e.target.dataset.col),
        startX: e.clientX,
        startWidth: grid.colWidths[e.target.dataset.col] || COL_DEFAULT_WIDTH
      };
      document.body.style.cursor = 'col-resize';
    }
  }

  function handleColResizeMove(e) {
    if (!resizing) return;
    const newWidth = Math.max(40, resizing.startWidth + (e.clientX - resizing.startX));
    grid.colWidths[resizing.col] = newWidth;
    // Update header and all cells in this column
    const th = wsTable.querySelector(`th[data-col="${resizing.col}"]`);
    if (th) { th.style.width = newWidth + 'px'; th.style.minWidth = newWidth + 'px'; }
    wsTable.querySelectorAll(`td[data-c="${resizing.col}"]`).forEach(td => {
      td.style.width = newWidth + 'px';
      td.style.minWidth = newWidth + 'px';
    });
  }

  function handleColResizeEnd() {
    if (resizing) {
      resizing = null;
      document.body.style.cursor = '';
      saveWorkspace();
    }
  }

  // ── Public Init ────────────────────────────────────────────

  function initWorkspace(containerId, jobId) {
    wsContainer = document.getElementById(containerId);
    if (!wsContainer) return;

    loadWorkspace(jobId);
    wsContainer.innerHTML = buildWorkspaceHTML();

    wsTable = document.getElementById('wsGrid');
    formulaBar = document.getElementById('wsFormulaBar');

    renderGrid();

    // Select first cell
    selectCell(0, 0);

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
          { label: 'Delete Row', action: function () { deleteRow(rowIdx); } }
        ]);
      } else if (colH) {
        e.preventDefault();
        var colIdx = parseInt(colH.dataset.col);
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Insert Column Left', action: function () { insertColumn(colIdx, 'left'); } },
          { label: 'Insert Column Right', action: function () { insertColumn(colIdx, 'right'); } },
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
