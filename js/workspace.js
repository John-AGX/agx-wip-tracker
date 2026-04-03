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
  const MIN_ROWS = 8;
  const MIN_COLS = 8;
  const EXPAND_BUFFER = 2; // rows/cols to add when typing at edge
  const COL_DEFAULT_WIDTH = 100;
  const ROW_HEIGHT = 28;

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
    editing: null,    // { r: 0, c: 0 }
    links: {},        // { "C5": "contractAmount", "D5": "estimatedCosts" }
    jobId: null,
    dirty: false,
    refMode: false,   // TRUE when entering a formula
    refAnchor: null   // Which cell/formula bar started the formula { type: 'formulaBar'|'cell', r?, c? }
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

  /** Evaluate a cell's raw value; detect formulas starting with '=' */
  function evaluate(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('=')) {
      // Plain value — try number
      if (raw === '' || raw === null || raw === undefined) return '';
      const n = Number(raw);
      return isNaN(n) ? raw : n;
    }

    const expr = raw.substring(1);

    try {
      // Replace cell references (A1, AB12, etc.) with their numeric values
      const resolved = expr.replace(/\b([A-Z]+)(\d+)\b/gi, (match, col, row) => {
        const ref = parseAddr(match.toUpperCase());
        if (!ref) return '0';
        const refCell = getCell(ref.r, ref.c);
        const v = refCell.value;
        return (typeof v === 'number') ? v : (v === '' ? '0' : JSON.stringify(v));
      });

      // Handle SUM(range)
      const withFunctions = resolved.replace(/SUM\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (match, startRef, endRef) => {
        const s = parseAddr(startRef.toUpperCase());
        const e = parseAddr(endRef.toUpperCase());
        if (!s || !e) return '0';
        let total = 0;
        for (let r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) {
          for (let c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
            const v = getCell(r, c).value;
            if (typeof v === 'number') total += v;
          }
        }
        return total;
      });

      // Handle AVERAGE(range)
      const withAvg = withFunctions.replace(/AVERAGE\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (match, startRef, endRef) => {
        const s = parseAddr(startRef.toUpperCase());
        const e = parseAddr(endRef.toUpperCase());
        if (!s || !e) return '0';
        let total = 0, count = 0;
        for (let r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) {
          for (let c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
            const v = getCell(r, c).value;
            if (typeof v === 'number') { total += v; count++; }
          }
        }
        return count > 0 ? total / count : 0;
      });

      // Handle MAX(range)
      const withMax = withAvg.replace(/MAX\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (match, startRef, endRef) => {
        const s = parseAddr(startRef.toUpperCase());
        const e = parseAddr(endRef.toUpperCase());
        if (!s || !e) return '0';
        let max = -Infinity;
        for (let r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) {
          for (let c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
            const v = getCell(r, c).value;
            if (typeof v === 'number' && v > max) max = v;
          }
        }
        return max === -Infinity ? 0 : max;
      });

      // Handle MIN(range)
      const withMin = withMax.replace(/MIN\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (match, startRef, endRef) => {
        const s = parseAddr(startRef.toUpperCase());
        const e = parseAddr(endRef.toUpperCase());
        if (!s || !e) return '0';
        let min = Infinity;
        for (let r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) {
          for (let c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
            const v = getCell(r, c).value;
            if (typeof v === 'number' && v < min) min = v;
          }
        }
        return min === Infinity ? 0 : min;
      });

      // Handle COUNT(range)
      const withCount = withMin.replace(/COUNT\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (match, startRef, endRef) => {
        const s = parseAddr(startRef.toUpperCase());
        const e = parseAddr(endRef.toUpperCase());
        if (!s || !e) return '0';
        let count = 0;
        for (let r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) {
          for (let c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
            const v = getCell(r, c).value;
            if (typeof v === 'number') count++;
          }
        }
        return count;
      });

      // Handle IF(condition, trueVal, falseVal)
      const withIf = withCount.replace(/IF\((.+?),(.+?),(.+?)\)/gi, (match, cond, tVal, fVal) => {
        try {
          return Function('"use strict"; return (' + cond.trim() + ') ? (' + tVal.trim() + ') : (' + fVal.trim() + ')')();
        } catch (e) { return '#ERR'; }
      });

      // Evaluate the final expression
      const result = Function('"use strict"; return (' + withIf + ')')();
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
    // Revenue / Contract
    { key: 'contractAmount', label: 'Contract Amount', fmt: 'currency', group: 'Revenue' },
    { key: 'revisedContractAmount', label: 'Revised Contract', fmt: 'currency', group: 'Revenue' },
    { key: 'invoicedToDate', label: 'Invoiced to Date', fmt: 'currency', group: 'Revenue' },

    // Costs - As Sold
    { key: 'estimatedCosts', label: 'Est. Costs (As Sold)', fmt: 'currency', group: 'Costs' },
    { key: 'revisedCostChanges', label: 'Revised Cost Changes', fmt: 'currency', group: 'Costs' },

    // Cost Breakdown
    { key: 'materialsCost', label: 'Materials $', fmt: 'currency', group: 'Cost Breakdown' },
    { key: 'laborCost', label: 'Labor $', fmt: 'currency', group: 'Cost Breakdown' },
    { key: 'subcontractorCost', label: 'Subcontractor $', fmt: 'currency', group: 'Cost Breakdown' },
    { key: 'equipmentCost', label: 'Equipment $', fmt: 'currency', group: 'Cost Breakdown' },

    // General Conditions & Overhead
    { key: 'generalConditions', label: 'General Conditions', fmt: 'currency', group: 'Overhead' },
    { key: 'overhead', label: 'Overhead', fmt: 'currency', group: 'Overhead' },
    { key: 'profit', label: 'Profit', fmt: 'currency', group: 'Overhead' },

    // Labor
    { key: 'laborHours', label: 'Labor Hours', fmt: null, group: 'Labor' },
    { key: 'totalHours', label: 'Total Hours', fmt: null, group: 'Labor' },
    { key: 'avgHourlyRate', label: 'Avg Hourly Rate', fmt: 'currency', group: 'Labor' },

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
      // Refresh the job detail view if it exists
      if (typeof renderJobDetail === 'function' && appState && appState.currentJobId === grid.jobId) {
        // Don't re-render (would destroy workspace), just update summary cards
        updateJobSummaryCards(job);
      }
    }
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
    const allWs = JSON.parse(localStorage.getItem('agx-workspaces') || '{}');
    allWs[grid.jobId] = data;
    localStorage.setItem('agx-workspaces', JSON.stringify(allWs));
    grid.dirty = false;
  }

  function loadWorkspace(jobId) {
    const allWs = JSON.parse(localStorage.getItem('agx-workspaces') || '{}');
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
          <button class="ws-btn ws-btn-fmt" data-fmt="null" title="Clear format">×</button>
          <span class="ws-separator"></span>
          <button class="ws-btn" id="wsLinkBtn" title="Link cell → job field">🔗 Link</button>
          <button class="ws-btn" id="wsClearBtn" title="Clear workspace">🗑️ Clear</button>
          <button class="ws-btn ws-btn-save" id="wsSaveBtn" title="Save workspace">💾 Save</button>
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
        const isLinked = grid.links[key];
        const isError = cell.error;
        const isFormula = typeof cell.raw === 'string' && cell.raw.startsWith('=');

        let cls = 'ws-cell';
        if (isSelected) cls += ' ws-selected';
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

  function selectCell(r, c) {
    const prev = grid.selection;
    grid.selection = { r, c };

    // Update previous cell styling
    if (prev) {
      const prevTd = wsTable.querySelector(`td[data-r="${prev.r}"][data-c="${prev.c}"]`);
      if (prevTd) prevTd.classList.remove('ws-selected');
    }

    // Update new cell styling
    const td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (td) td.classList.add('ws-selected');

    // Update cell ref and formula bar
    const key = addr(r, c);
    if (formulaBar) formulaBar.value = getCell(r, c).raw || '';
    const refEl = document.getElementById('wsCellRef');
    if (refEl) refEl.textContent = key;

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

    // Collect all numeric cells for quick stats
    const nums = [];
    Object.values(grid.cells).forEach(cell => {
      if (typeof cell.value === 'number') nums.push(cell.value);
    });

    if (nums.length > 1) {
      const sum = nums.reduce((a, b) => a + b, 0);
      const avg = sum / nums.length;
      el.textContent = `SUM: ${sum.toLocaleString('en-US', { minimumFractionDigits: 2 })}  |  AVG: ${avg.toLocaleString('en-US', { minimumFractionDigits: 2 })}  |  COUNT: ${nums.length}`;
    } else {
      el.textContent = '';
    }
  }

  // ── Event Handlers ─────────────────────────────────────────

  // v3: mousedown handler for reference mode click-to-select
  function handleCellMouseDown(e) {
    if (!grid.refMode) return;
    const td = e.target.closest('td.ws-cell');
    if (!td) return;
    e.preventDefault(); // Prevent focus from leaving the formula bar
    const r = parseInt(td.dataset.r);
    const c = parseInt(td.dataset.c);
    const cellRef = addr(r, c);
    insertCellRefIntoFormula(cellRef);
    selectCell(r, c);
  }

  function handleCellClick(e) {
    if (grid.refMode) return; // v3: already handled by mousedown
    const td = e.target.closest('td.ws-cell');
    if (!td) return;
    const r = parseInt(td.dataset.r);
    const c = parseInt(td.dataset.c);

    // In reference mode, clicking a cell inserts its address into the formula
    if (grid.refMode && formulaBar === document.activeElement) {
      const cellRef = addr(r, c);
      insertCellRefIntoFormula(cellRef);
      return;
    }

    if (grid.editing) {
      commitEdit(grid.editing.r, grid.editing.c);
    }

    selectCell(r, c);
  }

  function handleCellDblClick(e) {
    const td = e.target.closest('td.ws-cell');
    if (!td) return;
    const r = parseInt(td.dataset.r);
    const c = parseInt(td.dataset.c);
    startEditing(r, c);
  }

  function handleKeyDown(e) {
    // If editing a cell
    if (grid.editing) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit(grid.editing.r, grid.editing.c);
        // Move down
        if (grid.selection.r < grid.rows - 1) selectCell(grid.selection.r + 1, grid.selection.c);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commitEdit(grid.editing.r, grid.editing.c);
        // Move right
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
          const cell = getCell(grid.selection.r, grid.selection.c);
          cell.raw = formulaBar.value.trim();
          grid.dirty = true;
          recalcAll();
          renderGrid();
          selectCell(grid.selection.r, grid.selection.c);
          pushLinkedValues();
          saveWorkspace();
          // Move down
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

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        if (r > 0) selectCell(r - 1, c);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (r < grid.rows - 1) selectCell(r + 1, c);
        else { autoExpand(r + 1, c); selectCell(r + 1, c); }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (c > 0) selectCell(r, c - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (c < grid.cols - 1) selectCell(r, c + 1);
        else { autoExpand(r, c + 1); selectCell(r, c + 1); }
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
        const cell = getCell(r, c);
        cell.raw = '';
        cell.value = '';
        cell.error = null;
        grid.dirty = true;
        recalcAll();
        renderGrid();
        selectCell(r, c);
        pushLinkedValues();
        saveWorkspace();
        break;
      case 'F2':
        e.preventDefault();
        startEditing(r, c);
        break;
      default:
        // Start typing directly into cell
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          startEditing(r, c);
          // Clear cell content and set to the typed char
          const td = wsTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
          if (td) td.textContent = e.key;
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

    // ── Wire events ──
    wsTable.addEventListener('mousedown', handleCellMouseDown); // v3: ref mode click-to-select
    wsTable.addEventListener('click', handleCellClick);
    wsTable.addEventListener('dblclick', handleCellDblClick);
    wsContainer.addEventListener('keydown', handleKeyDown);
    formulaBar.addEventListener('focus', handleFormulaBarFocus);
    formulaBar.addEventListener('input', handleFormulaBarInput);

    // Column resize
    wsTable.addEventListener('mousedown', handleColResizeStart);
    document.addEventListener('mousemove', handleColResizeMove);
    document.addEventListener('mouseup', handleColResizeEnd);

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
      if (confirm('Clear all workspace data? This cannot be undone.')) {
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
