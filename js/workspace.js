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

  // ── State ──────────────────────────────────────────────────
  let grid = {
    rows: MIN_ROWS,
    cols: MIN_COLS,
    cells: {},       // { "A1": { raw: "=B1*2", value: 42, fmt: null }, ... }
    colWidths: {},   // { 0: 120, 1: 100, ... }
    selection: null,  // { r: 0, c: 0 }
    selEnd: null,     // { r, c } for range selection end (null = single cell)
    editing: null,    // { r: 0, c: 0 }
    links: {},        // { "C5": "contractAmount", "D5": "estimatedCosts" }
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
    if (!grid.cells[key]) grid.cells[key] = { raw: '', value: '', fmt: null };
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
    if (formulaBar !== document.activeElement) return;

    const input = formulaBar;
    const cursorPos = input.selectionStart;
    const content = input.value;

    // Insert the reference
    input.value = content.slice(0, cursorPos) + cellRef + content.slice(cursorPos);

    // Move cursor after inserted reference
    const newPos = cursorPos + cellRef.length;
    input.selectionStart = newPos;
    input.selectionEnd = newPos;

    // Update highlights
    if (grid.refMode && content.startsWith('=')) {
      applyRefHighlights(input.value.substring(1));
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
        const ref = parseAddr(match.toUpperCase());
        if (!ref) return '0';
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

  const LINKABLE_FIELDS = [
    // Costs - Estimated
    { key: 'estimatedCosts', label: 'Est. Costs (As Sold)', fmt: 'currency', group: 'Estimated Costs' },
    { key: 'revisedCostChanges', label: 'Revised Cost Changes', fmt: 'currency', group: 'Estimated Costs' },

    // Cost Breakdown — Job Level
    { key: 'materials', label: 'Materials $', fmt: 'currency', group: 'Job Costs' },
    { key: 'labor', label: 'Labor $', fmt: 'currency', group: 'Job Costs' },
    { key: 'sub', label: 'Subcontractor $', fmt: 'currency', group: 'Job Costs' },
    { key: 'equipment', label: 'Equipment $', fmt: 'currency', group: 'Job Costs' },

    // General Conditions & Overhead
    { key: 'generalConditions', label: 'General Conditions', fmt: 'currency', group: 'Overhead' },
    { key: 'overhead', label: 'Overhead', fmt: 'currency', group: 'Overhead' },
    { key: 'profitAllowance', label: 'Profit Allowance', fmt: 'currency', group: 'Overhead' },

    // Labor
    { key: 'hoursWeek', label: 'Hours This Week', fmt: null, group: 'Labor' },
    { key: 'hoursTotal', label: 'Total Hours', fmt: null, group: 'Labor' },
    { key: 'rate', label: 'Hourly Rate', fmt: 'currency', group: 'Labor' },

    // Revenue
    { key: 'invoicedToDate', label: 'Invoiced to Date', fmt: 'currency', group: 'Revenue' },
    { key: 'revisedContractAmount', label: 'Revised Contract', fmt: 'currency', group: 'Revenue' },

    // WIP Metrics
    { key: 'targetMarginPct', label: 'Target Margin %', fmt: 'percent', group: 'WIP Metrics' },
    { key: 'pctComplete', label: '% Complete', fmt: 'percent', group: 'WIP Metrics' },
    { key: 'costToComplete', label: 'Cost to Complete', fmt: 'currency', group: 'WIP Metrics' },
  ];

  /** Get unique group names from LINKABLE_FIELDS */
  function getFieldGroups() {
    const groups = {};
    LINKABLE_FIELDS.forEach(field => {
      if (!groups[field.group]) groups[field.group] = [];
      groups[field.group].push(field);
    });
    return groups;
  }

  /** Push linked cell values into the current job */
  function pushLinkedValues() {
    if (!grid.jobId || typeof appData === 'undefined') return;
    const job = appData.jobs.find(j => j.id === grid.jobId);
    if (!job) return;

    let changed = false;
    Object.entries(grid.links).forEach(([cellAddr, fieldKey]) => {
      const ref = parseAddr(cellAddr);
      if (!ref) return;
      const cell = getCell(ref.r, ref.c);
      if (typeof cell.value === 'number') {
        job[fieldKey] = cell.value;
        changed = true;
      }
    });

    if (changed && typeof saveData === 'function') {
      saveData();
      if (typeof renderJobDetail === 'function' && appState && appState.currentJobId === grid.jobId) {
        updateJobSummaryCards(job);
      }
    }
    updateLinkedIndicators();
  }

  /** Map linkable field keys to their DOM input IDs */
  var FIELD_INPUT_MAP = {
    materials: 'jobCostMaterials',
    labor: 'jobCostLabor',
    equipment: 'jobCostEquipment',
    sub: 'jobCostSub',
    hoursWeek: 'jobCostHoursWeek',
    hoursTotal: 'jobCostHoursTotal',
    rate: 'jobCostRate',
    estimatedCosts: 'edit-jobEstCosts',
    targetMarginPct: 'edit-jobMargin'
  };

  /** Show "← Cell A5" badges on inputs linked to workspace cells */
  function updateLinkedIndicators() {
    // Clear all existing badges
    document.querySelectorAll('.ws-linked-badge').forEach(function (el) { el.remove(); });
    document.querySelectorAll('[data-ws-linked]').forEach(function (el) {
      el.removeAttribute('data-ws-linked');
      el.style.borderColor = '';
    });

    // Add badges for active links
    Object.entries(grid.links).forEach(function (entry) {
      var cellAddr = entry[0], fieldKey = entry[1];
      var inputId = FIELD_INPUT_MAP[fieldKey];
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
      links: grid.links
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
    } else {
      grid.rows = MIN_ROWS;
      grid.cols = MIN_COLS;
      grid.cells = {};
      grid.colWidths = {};
      grid.links = {};
    }
    grid.jobId = jobId;
    grid.selection = null;
    grid.editing = null;
    grid.refMode = false;
    grid.refAnchor = null;
    grid.dirty = false;
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
          <button class="ws-btn" id="wsLinkBtn" title="Link cell to job field">Link</button>
          <button class="ws-btn" id="wsClearBtn" title="Clear workspace">Clear</button>
          <button class="ws-btn ws-btn-save" id="wsSaveBtn" title="Save workspace">Save</button>
        </div>
      </div>
      <div class="ws-link-panel" id="wsLinkPanel" style="display:none;">
        <div class="ws-link-title">Link <span id="wsLinkCell">A1</span> → Job Field</div>
        <div class="ws-link-options" id="wsLinkOptions"></div>
        <div class="ws-link-active" id="wsLinkActive"></div>
        <button class="ws-btn ws-btn-unlink" id="wsUnlinkBtn" style="display:none;">Unlink</button>
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

  function renderGrid() {
    if (!wsTable) return;

    let html = '<thead><tr><th class="ws-corner"></th>';
    for (let c = 0; c < grid.cols; c++) {
      const w = grid.colWidths[c] || COL_DEFAULT_WIDTH;
      html += `<th class="ws-col-header" data-col="${c}" style="width:${w}px;min-width:${w}px;">${colLetter(c)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 0; r < grid.rows; r++) {
      html += `<tr><td class="ws-row-header">${r + 1}</td>`;
      for (let c = 0; c < grid.cols; c++) {
        const key = addr(r, c);
        const cell = grid.cells[key] || { raw: '', value: '', fmt: null };
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
        if (typeof cell.value === 'number') cls += ' ws-number';

        const w = grid.colWidths[c] || COL_DEFAULT_WIDTH;
        html += `<td class="${cls}" data-r="${r}" data-c="${c}" style="width:${w}px;min-width:${w}px;">${val}</td>`;
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
    const cell = grid.cells[key] || { raw: '', value: '', fmt: null };
    td.textContent = displayVal(cell);

    td.className = 'ws-cell';
    if (grid.selection && grid.selection.r === r && grid.selection.c === c) td.classList.add('ws-selected');
    if (grid.links[key]) td.classList.add('ws-linked');
    if (cell.error) td.classList.add('ws-error');
    if (typeof cell.raw === 'string' && cell.raw.startsWith('=')) td.classList.add('ws-formula');
    if (typeof cell.value === 'number') td.classList.add('ws-number');
  }

  // ── Selection & Editing ────────────────────────────────────

  function selectCell(r, c, keepRange) {
    grid.selection = { r, c };
    if (!keepRange) grid.selEnd = null;

    renderSelectionClasses();

    // Update cell ref and formula bar
    const key = addr(r, c);
    if (formulaBar) formulaBar.value = getCell(r, c).raw || '';
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
    const panel = document.getElementById('wsLinkPanel');
    const cellLabel = document.getElementById('wsLinkCell');
    const activeEl = document.getElementById('wsLinkActive');
    const unlinkBtn = document.getElementById('wsUnlinkBtn');
    if (!panel) return;

    if (cellLabel) cellLabel.textContent = cellAddr;

    const currentLink = grid.links[cellAddr];
    if (currentLink) {
      const field = LINKABLE_FIELDS.find(f => f.key === currentLink);
      if (activeEl) {
        activeEl.innerHTML = `<span class="ws-link-badge">→ ${field ? field.label : currentLink}</span>`;
        activeEl.style.display = 'block';
      }
      if (unlinkBtn) unlinkBtn.style.display = 'inline-block';
    } else {
      if (activeEl) activeEl.style.display = 'none';
      if (unlinkBtn) unlinkBtn.style.display = 'none';
    }
  }

  function showLinkPanel() {
    const panel = document.getElementById('wsLinkPanel');
    const optionsEl = document.getElementById('wsLinkOptions');
    if (!panel || !grid.selection) return;

    panel.style.display = 'block';
    const cellAddr = addr(grid.selection.r, grid.selection.c);

    // Group fields by group name and render with collapsible sections
    const groups = getFieldGroups();
    let html = '';

    Object.entries(groups).forEach(([groupName, fields]) => {
      html += `<div class="ws-link-group">
        <div class="ws-link-group-header">${groupName}</div>`;

      fields.forEach(f => {
        const isActive = grid.links[cellAddr] === f.key;
        html += `<button class="ws-link-opt ${isActive ? 'active' : ''}" data-field="${f.key}">${f.label}</button>`;
      });

      html += `</div>`;
    });

    if (optionsEl) optionsEl.innerHTML = html;

    updateLinkPanel(cellAddr);
  }

  function setLink(cellAddr, fieldKey) {
    // Remove any existing link to this field
    Object.entries(grid.links).forEach(([key, val]) => {
      if (val === fieldKey) delete grid.links[key];
    });

    const field = LINKABLE_FIELDS.find(f => f.key === fieldKey);
    grid.links[cellAddr] = fieldKey;
    const cell = getCell(parseAddr(cellAddr).r, parseAddr(cellAddr).c);
    if (field) cell.fmt = field.fmt;

    grid.dirty = true;
    saveWorkspace();
    recalcAll();
    renderGrid();
    selectCell(grid.selection.r, grid.selection.c);
    pushLinkedValues();
  }

  function unlinkCell(cellAddr) {
    delete grid.links[cellAddr];
    grid.dirty = true;
    saveWorkspace();
    updateLinkPanel(cellAddr);
    renderGrid();
    selectCell(grid.selection.r, grid.selection.c);
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
    grid.cells = s.cells; grid.links = s.links;
    grid.rows = s.rows; grid.cols = s.cols; grid.colWidths = s.colWidths;
    recalcAll(); renderGrid();
    if (grid.selection) selectCell(grid.selection.r, grid.selection.c);
    saveWorkspace();
  }

  function doRedo() {
    if (!grid.redoStack.length) return;
    grid.undoStack.push(snapshotState());
    var s = grid.redoStack.pop();
    grid.cells = s.cells; grid.links = s.links;
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

  function handleCellMouseDown(e) {
    var td = e.target.closest('td.ws-cell');
    if (!td) return;
    var r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);

    // Reference mode: insert cell ref
    if (grid.refMode) {
      e.preventDefault();
      insertCellRefIntoFormula(addr(r, c));
      selectCell(r, c);
      return;
    }

    if (grid.editing) commitEdit(grid.editing.r, grid.editing.c);

    if (e.shiftKey && grid.selection) {
      // Shift+click extends selection
      grid.selEnd = { r: r, c: c };
      selectCell(grid.selection.r, grid.selection.c, true);
    } else {
      selectCell(r, c);
    }
    dragging = true;
  }

  function handleCellMouseMove(e) {
    if (!dragging || grid.refMode) return;
    var td = e.target.closest('td.ws-cell');
    if (!td) return;
    var r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);
    if (!grid.selection) return;
    if (r !== (grid.selEnd ? grid.selEnd.r : grid.selection.r) || c !== (grid.selEnd ? grid.selEnd.c : grid.selection.c)) {
      grid.selEnd = { r: r, c: c };
      renderSelectionClasses();
      // Update cell ref display for range
      var rng = getSelRange();
      var refEl = document.getElementById('wsCellRef');
      if (refEl && rng) refEl.textContent = addr(rng.r1, rng.c1) + ':' + addr(rng.r2, rng.c2);
      updateQuickCalc();
    }
  }

  function handleCellMouseUp() {
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

    // Show linked cell indicators on cost inputs
    setTimeout(updateLinkedIndicators, 500);

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

    // Context menu on headers
    wsTable.addEventListener('contextmenu', function (e) {
      var rowH = e.target.closest('td.ws-row-header');
      var colH = e.target.closest('th.ws-col-header');
      if (rowH) {
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

    document.getElementById('wsClearBtn').addEventListener('click', () => {
      if (confirm('Clear all workspace data?')) {
        pushUndo();
        grid.cells = {};
        grid.links = {};
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

    // Link options
    document.getElementById('wsLinkOptions').addEventListener('click', (e) => {
      const btn = e.target.closest('.ws-link-opt');
      if (!btn || !grid.selection) return;
      const fieldKey = btn.dataset.field;
      const cellAddr = addr(grid.selection.r, grid.selection.c);
      setLink(cellAddr, fieldKey);
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
          cell.raw = val.trim();
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
