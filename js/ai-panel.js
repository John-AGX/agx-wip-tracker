// AI estimating-assistant panel — slide-in right rail attached to the
// estimate editor. Read-only Q&A: it knows the estimate's full context
// (server-side) but cannot modify the estimate. Per-user chat history.
//
// Wire-up:
//   - Estimate editor calls window.agxAI.toggle() / .open(estimateId)
//   - On open, we GET /api/ai/estimates/:id/messages to load history
//   - User submits → POST /api/ai/estimates/:id/chat (SSE), we stream the
//     assistant's reply into a live message bubble
(function() {
  'use strict';

  var _open = false;
  // Generalized entity binding — the panel works against estimates today
  // and jobs as of Phase 2B. _entityType decides which API base path the
  // chat hits ('estimate' → /api/ai/estimates/:id, 'job' → /api/ai/jobs/:id)
  // and which features are available (estimate has photos + write tools,
  // job is read-only / no photos for now).
  var _entityType = 'estimate';
  var _entityId = null;
  var _estimateId = null; // legacy alias kept so existing call sites keep working
  var _messages = [];           // {role, content, ...}
  var _streaming = false;
  var _includePhotos = true;    // default-on with toggle, per the user
  var _abortController = null;

  function apiBase() {
    if (_entityType === 'job') return '/api/ai/jobs/' + encodeURIComponent(_entityId);
    if (_entityType === 'client') return '/api/ai/clients';
    return '/api/ai/estimates/' + encodeURIComponent(_entityId);
  }
  function isEstimateMode() { return _entityType === 'estimate'; }
  function isJobMode() { return _entityType === 'job'; }
  function isClientMode() { return _entityType === 'client'; }

  // Preset prompts surfaced as quick-tap buttons. Different presets per
  // entity — estimates focus on scope/materials, jobs on margin/billing.
  var ESTIMATE_PRESETS = [
    { label: 'Draft scope from photos', prompt: 'Look at the photos attached and draft a tight, bulleted scope of work for this estimate. Focus on the work AGX would actually be doing.' },
    { label: "What am I missing?",      prompt: 'Review the estimate as it stands. What line items, prep work, or costs am I likely missing? Propose the additions as line items so I can approve them in batch.' },
    { label: 'Build my line items',     prompt: 'Propose the cost-side line items I should add for this scope. Use realistic AGX prices for Central Florida and slot each one under the right standard section. Make multiple parallel proposals so I can approve them in batch.' },
    { label: 'Tighten this estimate',   prompt: 'Audit my line items for duplicates, overlapping descriptions, lines that should be split into materials + labor, and lines under the wrong section. Propose updates / deletes / moves where you\'re confident.' },
    { label: 'Adjust margin',           prompt: 'I want this estimate at roughly 28% blended GP. Walk through each section and propose new section markup percentages to get there, calling out which lines drove the change.' }
  ];
  var JOB_PRESETS = [
    { label: 'Audit this job',        prompt: 'Run a full audit of this job. Walk through:\n1. **Node graph connectivity** — list any orphan or disconnected cost nodes, and any phases/buildings that should be wired but aren\'t.\n2. **Missing inputs** — phases without %complete set, buildings without phases, cost nodes without budgets.\n3. **Cost coverage** — compare the QB cost categories against the cost-side nodes in the graph. Call out QB categories with significant spend ($1K+) that don\'t have a matching node, and nodes that have no recorded actual costs.\n4. **Billing posture** — revenue earned vs invoiced; flag under-billing.\n5. **Margin** — as-sold vs revised vs JTD; flag drift > 2 points.\nFormat as a checklist grouped by severity (🔴 needs action, 🟡 worth checking, 🟢 looks fine). Be specific — include node labels, dollar amounts, and category names.' },
    { label: 'Health check',          prompt: 'Run a quick WIP health check on this job. Margin trend, cost-to-complete sanity, any red flags I should look at first.' },
    { label: 'Am I underbilled?',     prompt: 'Compare revenue earned vs. invoiced to date. Am I behind on billing? If so, by how much, and what should I send next?' },
    { label: 'Missing change orders?', prompt: 'Look at the cost lines vs. the original estimated costs. Anything that looks like out-of-scope work that should have been captured as a change order?' },
    { label: 'Margin drift',          prompt: 'Compare as-sold margin, revised margin, and JTD margin. Is the job drifting? What\'s driving the change?' },
    { label: 'Uncategorized QB costs', prompt: 'Look at the QuickBooks cost data. Which categories have significant spend that don\'t map cleanly to a node in the graph? Group by Distribution Account and tell me which I should create nodes for or assign to existing ones.' }
  ];
  var CLIENT_PRESETS = [
    { label: 'Run full audit',           prompt: 'Run a full audit of the customer directory. Work in this order, using your tools to actually fix things — do not just describe them:\n1. Split any flat clients whose name encodes both a parent management company and a property/community (e.g., "PAC - Solace Tampa", "Associa | Wimbledon Greens", names with " - ", " | ", " / " separators followed by a property name). Reuse existing parents (existing_parent_id) when they already exist in the directory.\n2. Link any unparented properties to their existing parent management company when the company_name field, address, or context makes it obvious.\n3. Merge clear duplicates (typo variants, "Inc."/"LLC" mismatches, same property_address, same CAM email).\n4. Normalize parent-company name spelling to the canonical form across all children.\n5. At the end, in chat, list ambiguous cases that need my judgment — do not act on them.\nChain auto-tier tools efficiently (no preamble), and group approval-tier proposals so I can bulk-approve them.' },
    { label: 'Find duplicates',          prompt: 'Scan the directory for likely duplicate clients (typo variants, abbreviations vs full names, same CAM/email on different rows, same property_address). For each pair you are confident about, propose a merge — pick the row with more data as keep. List ambiguous pairs in chat for me to decide.' },
    { label: 'Organize flat clients',    prompt: 'Look at the unparented entries. For each one, decide: (a) is the name a parent+property compound that needs split_client_into_parent_and_property? (b) does it match an existing parent\'s company_name and just need link_property_to_parent? (c) is it a legitimate top-level parent? Apply auto-tier fixes; propose splits for me to approve.' },
    { label: 'Audit incomplete records', prompt: 'Show me properties missing key fields (no CAM contact, no property_address, no parent linkage, no market). Group by what\'s missing so I can fill them in efficiently. If you can fill anything from context (e.g., copying market from siblings under the same parent), do it via update_client_field.' },
    { label: 'Add a property',           prompt: 'Walk me through adding a new property. Ask which parent management company first (search existing parents in the directory). Then collect property name, property_address, on-site CAM name + email + phone, market, and gate code if any. Use create_property to apply.' }
  ];
  function getActivePresets() {
    if (isJobMode()) return JOB_PRESETS;
    if (isClientMode()) return CLIENT_PRESETS;
    return ESTIMATE_PRESETS;
  }

  function escapeHTMLLocal(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Client context for Job mode ──────────────────────────────
  // Bundles the node-graph snapshot (localStorage) plus an aggregated
  // QB cost summary (parsed from workspace sheets named
  // "QB Costs YYYY-MM-DD") so the WIP Assistant can reason about
  // wiring + uncategorized costs. Returns null if no useful data is
  // available — the server tolerates a missing clientContext.
  function buildJobClientContext() {
    var jobId = _entityId;
    if (!jobId) return null;
    var ctx = {};

    // Node graph
    try {
      var allGraphs = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
      var g = allGraphs[jobId];
      if (g && Array.isArray(g.nodes)) {
        ctx.nodeGraph = {
          nodes: g.nodes.map(function(n) {
            return {
              id: n.id, type: n.type, label: n.label,
              value: n.value, pctComplete: n.pctComplete,
              budget: n.budget, revenue: n.revenue,
              dataId: n.dataId, attachedTo: n.attachedTo
            };
          }),
          wires: (g.wires || []).map(function(w) {
            return { fromNode: w.fromNode, fromPort: w.fromPort, toNode: w.toNode, toPort: w.toPort };
          })
        };
      }
    } catch (e) { /* defensive */ }

    // QB cost data — Phase 2 made this server-persisted, so the
    // canonical source is appData.qbCostLines (hydrated from the
    // qb_cost_lines table on every login). Workspace "QB Costs"
    // sheets are now a secondary view, only used as a fallback if
    // no server lines exist for this job (e.g. a fresh browser
    // session that hasn't hydrated yet, or pre-Phase-2 data that
    // never made it to the server).
    try {
      var serverLines = (window.appData && Array.isArray(appData.qbCostLines))
        ? appData.qbCostLines.filter(function(l) {
            return (l.job_id || l.jobId) === jobId;
          })
        : [];

      var allLines = [];
      var mostRecent = '';
      var source = null;

      if (serverLines.length) {
        source = 'server';
        serverLines.forEach(function(l) {
          var amt = Number(l.amount || 0);
          if (!isFinite(amt) || amt === 0) return;
          var date = l.txn_date || l.date || '';
          if (typeof date === 'string' && date.length > 10) date = date.slice(0, 10);
          allLines.push({
            id: l.id || null,
            vendor: l.vendor || '',
            date: String(date || ''),
            amount: amt,
            account: l.account || '',
            klass: l.klass || '',
            memo: l.memo || '',
            linkedNodeId: l.linked_node_id || l.linkedNodeId || null
          });
          var rd = l.report_date || l.reportDate || '';
          if (typeof rd === 'string') {
            var rdNorm = rd.length > 10 ? rd.slice(0, 10) : rd;
            if (rdNorm > mostRecent) mostRecent = rdNorm;
          }
        });
      } else {
        // Fallback: parse the workspace sheets the same way Phase 1
        // did. Marked source='sheets' so the prompt can warn the AI
        // that the data is localStorage-only and may be partial.
        var allWs = JSON.parse(localStorage.getItem('agx-workspaces') || '{}');
        var wb = allWs[jobId];
        if (wb && Array.isArray(wb.sheets)) {
          var qbSheets = wb.sheets.filter(function(s) { return /^QB Costs /.test(s.name || ''); });
          if (qbSheets.length) {
            source = 'sheets';
            qbSheets.forEach(function(s) {
              var cells = s.cells || {};
              var headerCells = {};
              Object.keys(cells).forEach(function(k) {
                var m = k.match(/^(\d+),(\d+)$/);
                if (!m) return;
                var r = parseInt(m[1], 10), c = parseInt(m[2], 10);
                if (r === 3) headerCells[c] = String(cells[k].value || '').trim();
              });
              var col = {};
              Object.keys(headerCells).forEach(function(c) {
                var name = headerCells[c].toLowerCase();
                if (name === 'vendor') col.vendor = +c;
                else if (name === 'date') col.date = +c;
                else if (name === 'amount') col.amount = +c;
                else if (name === 'account') col.account = +c;
                else if (name === 'class') col.klass = +c;
                else if (name === 'memo') col.memo = +c;
              });
              var dateMatch = (s.name || '').match(/QB Costs (\d{4}-\d{2}-\d{2})/);
              if (dateMatch && dateMatch[1] > mostRecent) mostRecent = dateMatch[1];
              var rowKeys = {};
              Object.keys(cells).forEach(function(k) {
                var m = k.match(/^(\d+),(\d+)$/);
                if (!m) return;
                var r = parseInt(m[1], 10);
                if (r >= 4) rowKeys[r] = true;
              });
              Object.keys(rowKeys).forEach(function(r) {
                var ri = parseInt(r, 10);
                var cellAt = function(c) { var v = cells[ri + ',' + c]; return v ? v.value : null; };
                var amt = col.amount != null ? Number(cellAt(col.amount)) : 0;
                if (!isFinite(amt) || amt === 0) return;
                var labelCell = col.amount != null ? cells[ri + ',' + (col.amount - 1)] : null;
                if (labelCell && /^TOTAL$/i.test(String(labelCell.value || '').trim())) return;
                allLines.push({
                  vendor: col.vendor != null ? String(cellAt(col.vendor) || '') : '',
                  date: col.date != null ? String(cellAt(col.date) || '') : '',
                  amount: amt,
                  account: col.account != null ? String(cellAt(col.account) || '') : '',
                  klass: col.klass != null ? String(cellAt(col.klass) || '') : '',
                  memo: col.memo != null ? String(cellAt(col.memo) || '') : ''
                });
              });
            });
          }
        }
      }

      if (allLines.length) {
        var total = allLines.reduce(function(s, l) { return s + l.amount; }, 0);
        var byCategory = {};
        var unlinkedCount = 0;
        allLines.forEach(function(l) {
          var key = l.account || '(uncategorized)';
          byCategory[key] = (byCategory[key] || 0) + l.amount;
          if (!l.linkedNodeId) unlinkedCount++;
        });
        var samples = allLines.slice().sort(function(a, b) { return b.amount - a.amount; }).slice(0, 20);
        ctx.qbCosts = {
          source: source,
          total: total,
          byCategory: byCategory,
          lineCount: allLines.length,
          unlinkedCount: unlinkedCount,
          mostRecentImport: mostRecent || null,
          samples: samples
        };
      }
    } catch (e) { /* defensive */ }

    // Workspace sheets (the in-app spreadsheet). Includes anything the
    // user has typed — phase lists, scope notes, custom tables, etc.
    // We send a compact snapshot per sheet so the assistant can read
    // it and answer "what phases do I have in my workspace?" or
    // "extract the line items from sheet 2." QB Costs sheets are
    // skipped (their data already rolls up via ctx.qbCosts).
    try {
      var allWs2 = JSON.parse(localStorage.getItem('agx-workspaces') || '{}');
      var wb2 = allWs2[jobId];
      if (wb2 && Array.isArray(wb2.sheets)) {
        var nonQB = wb2.sheets.filter(function(s) { return !/^QB Costs /.test(s.name || ''); });
        if (nonQB.length) {
          // Index EVERY sheet by name first — even empty ones — so
          // the assistant can list available tabs and ask the user
          // which one to read. Without this, an AI suggestion to
          // "look at the bottom tab bar in your workspace" feels
          // useless when the assistant has the names right in scope.
          ctx.workspaceSheetIndex = nonQB.map(function(s) { return s.name || '(unnamed)'; });
          ctx.workspaceSheets = nonQB.slice(0, 5).map(function(s) {
            // Default preview: first 100 rows × 26 cols (A–Z). Covers
            // virtually every real-world AGX sheet. If something deeper
            // is needed, the assistant calls read_workspace_sheet_full
            // (an auto-applying read tool) to fetch the entire sheet
            // on demand without burning tokens preemptively.
            var cells = s.cells || {};
            var maxR = 0, maxC = 0;
            var trueMaxR = 0, trueMaxC = 0;
            var grid = {};
            Object.keys(cells).forEach(function(k) {
              var m = k.match(/^(\d+),(\d+)$/);
              if (!m) return;
              var r = parseInt(m[1], 10), c = parseInt(m[2], 10);
              var val = cells[k];
              if (val == null) return;
              var raw = (typeof val === 'object' && 'value' in val) ? val.value : val;
              if (raw == null || raw === '') return;
              if (r > trueMaxR) trueMaxR = r;
              if (c > trueMaxC) trueMaxC = c;
              if (r > 100 || c > 26) return; // outside preview window
              if (!grid[r]) grid[r] = {};
              grid[r][c] = String(raw);
              if (r > maxR) maxR = r;
              if (c > maxC) maxC = c;
            });
            // Render preview window as text table.
            var rows = [];
            for (var r = 0; r <= maxR; r++) {
              if (!grid[r]) continue;
              var parts = [];
              for (var c = 0; c <= maxC; c++) {
                if (grid[r][c] != null) {
                  var label = String.fromCharCode(65 + c);
                  parts.push(label + '=' + String(grid[r][c]).replace(/\s+/g, ' ').slice(0, 120));
                }
              }
              if (parts.length) rows.push((r + 1) + ': ' + parts.join(' · '));
            }
            var truncated = (trueMaxR > 100) || (trueMaxC > 26);
            return {
              name: s.name || '(unnamed)',
              cellCount: rows.length,
              preview: rows.join('\n'),
              totalRows: trueMaxR + 1,
              totalCols: trueMaxC + 1,
              truncated: truncated
            };
          });
          // Drop the heavy preview block when no sheet has content,
          // but keep the index so the assistant can still surface
          // sheet names.
          if (!ctx.workspaceSheets.some(function(s) { return s.cellCount > 0; })) {
            delete ctx.workspaceSheets;
          }
        }
      }
    } catch (e) { /* defensive */ }

    return (ctx.nodeGraph || ctx.qbCosts || ctx.workspaceSheets || (ctx.workspaceSheetIndex && ctx.workspaceSheetIndex.length)) ? ctx : null;
  }

  // Lightweight markdown — bold, italic, inline code, lists, paragraphs.
  // Safer than pulling in marked.js for this scale; trades feature breadth
  // for zero dependencies.
  function renderMarkdown(text) {
    if (!text) return '';
    var html = escapeHTMLLocal(text);
    // Code blocks (triple backtick)
    html = html.replace(/```([\s\S]*?)```/g, function(_, code) {
      return '<pre style="background:rgba(255,255,255,0.06);padding:8px 10px;border-radius:6px;overflow-x:auto;font-size:11px;font-family:SF Mono,Consolas,monospace;margin:6px 0;">' + code.trim() + '</pre>';
    });
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-family:SF Mono,Consolas,monospace;font-size:0.9em;">$1</code>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // Bulleted lists — group consecutive lines starting with - or *
    var lines = html.split('\n');
    var out = [];
    var inList = false;
    lines.forEach(function(line) {
      var bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
      var numberedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
      if (bulletMatch) {
        if (!inList) { out.push('<ul style="margin:6px 0;padding-left:20px;">'); inList = 'ul'; }
        out.push('<li>' + bulletMatch[1] + '</li>');
      } else if (numberedMatch) {
        if (!inList) { out.push('<ol style="margin:6px 0;padding-left:22px;">'); inList = 'ol'; }
        out.push('<li>' + numberedMatch[2] + '</li>');
      } else {
        if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        if (line.trim()) out.push('<p style="margin:4px 0;">' + line + '</p>');
      }
    });
    if (inList) out.push(inList === 'ul' ? '</ul>' : '</ol>');
    return out.join('');
  }

  // ──────────────────────────────────────────────────────────────────
  // Panel DOM lazy-init. We create the side rail once on first open and
  // toggle visibility from there.
  // ──────────────────────────────────────────────────────────────────

  // Persist the user's preferred panel width across sessions. Min/max
  // protect against the user pulling it off-screen or shrinking past
  // a usable width — the chat UI breaks below ~320px.
  var AI_PANEL_WIDTH_KEY = 'agx-ai-panel-width';
  var AI_PANEL_WIDTH_MIN = 320;
  var AI_PANEL_WIDTH_MAX_FRAC = 0.92; // 92% of viewport width
  function loadAIPanelWidth() {
    try {
      var v = parseInt(localStorage.getItem(AI_PANEL_WIDTH_KEY), 10);
      if (Number.isFinite(v) && v >= AI_PANEL_WIDTH_MIN) return v;
    } catch (e) {}
    return 420; // default
  }
  function saveAIPanelWidth(px) {
    try { localStorage.setItem(AI_PANEL_WIDTH_KEY, String(px)); } catch (e) {}
  }
  function clampAIPanelWidth(px) {
    var max = Math.floor(window.innerWidth * AI_PANEL_WIDTH_MAX_FRAC);
    return Math.max(AI_PANEL_WIDTH_MIN, Math.min(max, px));
  }

  function ensurePanel() {
    var panel = document.getElementById('agx-ai-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'agx-ai-panel';
    // z-index 200 sits above the node graph (#nodeGraphTab z-index:99)
    // so the WIP Assistant slides in over the graph rather than being
    // covered by it. Modals (.modal z:1000) still trump the panel.
    var initialWidth = clampAIPanelWidth(loadAIPanelWidth());
    panel.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:' + initialWidth + 'px;max-width:92vw;min-width:' + AI_PANEL_WIDTH_MIN + 'px;background:var(--surface,#0f0f1e);border-left:1px solid var(--border,#333);box-shadow:-4px 0 22px rgba(0,0,0,0.6);z-index:200;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.22s ease;';
    panel.innerHTML =
      // Left-edge resize grabber. Wider than it looks (12px hit area)
      // for easy targeting, but visually only a thin 2px line that
      // brightens on hover. While dragging we toggle a class that
      // disables the panel's slide transition so the resize feels
      // direct instead of laggy.
      '<div id="ai-panel-resizer" title="Drag to resize" aria-label="Resize panel" ' +
        'style="position:absolute;top:0;left:-6px;bottom:0;width:12px;cursor:ew-resize;z-index:1;display:flex;align-items:center;justify-content:center;">' +
        '<div style="width:2px;height:100%;background:rgba(79,140,255,0.18);transition:background 0.15s;"></div>' +
      '</div>' +
      // Header — close button is the most prominent control on the left
      // (mirrors a typical drawer/sidebar UX) so it's never missed.
      '<div style="padding:12px 14px;border-bottom:1px solid var(--border,#333);background:linear-gradient(135deg,#0d1f12 0%,#14351d 100%);display:flex;align-items:center;gap:10px;">' +
        '<button id="ai-close" title="Close (Esc)" style="background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;">&rarr; Close</button>' +
        '<div class="agx-ai-title" style="font-size:14px;font-weight:700;color:#fff;flex:1;text-align:right;">&#x2728; AI Assistant</div>' +
        '<button id="ai-trust" title="Trust settings — pick which tool types auto-apply (job mode only)" style="background:rgba(255,255,255,0.08);color:#ccc;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 8px;font-size:13px;cursor:pointer;display:none;">&#x2699;</button>' +
        '<button id="ai-clear" title="Clear conversation" style="background:rgba(255,255,255,0.08);color:#ccc;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;">Clear</button>' +
      '</div>' +
      // Notice strip
      '<div id="ai-notice" style="padding:8px 14px;background:rgba(79,140,255,0.08);border-bottom:1px solid var(--border,#333);font-size:11px;color:var(--text-dim,#aaa);">' +
        'Read-only — I see your estimate and photos but cannot change anything. Apply suggestions by hand.' +
      '</div>' +
      // Messages scroll area
      '<div id="ai-messages" style="flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--text,#e6e6e6);"></div>' +
      // Preset prompts
      '<div id="ai-presets" style="padding:8px 12px;border-top:1px solid var(--border,#333);display:flex;flex-wrap:wrap;gap:6px;background:rgba(255,255,255,0.02);"></div>' +
      // Input row. Photos are auto-included via the entity's attachments
      // and inline uploads via the + composer button — no separate toggle
      // needed.
      '<div style="padding:10px 12px 12px;border-top:1px solid var(--border,#333);background:var(--card-bg,#0c0c14);">' +
        // Pill-style input container — borderless textarea with attach,
        // camera, mic and send icons docked at the bottom-right. Grows
        // up as the user types so long prompts stay readable; capped at
        // 320px before internal scrolling (no visible scrollbar).
        '<div id="ai-input-pill" style="background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-radius:14px;padding:10px 12px 8px;transition:border-color 0.15s, background 0.15s;">' +
          '<div id="ai-attachments-strip" style="display:none;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>' +
          '<textarea id="ai-input" rows="1" placeholder="Ask anything about this estimate…" style="width:100%;resize:none;overflow-y:auto;min-height:22px;max-height:320px;background:transparent;border:none;outline:none;padding:0;color:var(--text,#fff);font-size:13px;line-height:1.5;font-family:inherit;box-sizing:border-box;display:block;"></textarea>' +
          '<div style="display:flex;align-items:center;gap:4px;margin-top:6px;">' +
            '<button id="ai-attach" type="button" title="Attach file (image or PDF)" aria-label="Attach file" style="background:transparent;border:none;color:var(--text-dim,#888);width:30px;height:30px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:18px;padding:0;transition:background 0.12s, color 0.12s;">&#x002B;</button>' +
            '<button id="ai-camera" type="button" title="Take a photo" aria-label="Take a photo" style="background:transparent;border:none;color:var(--text-dim,#888);width:30px;height:30px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:14px;padding:0;transition:background 0.12s, color 0.12s;">&#x1F4F7;</button>' +
            '<input id="ai-file-input" type="file" accept="image/*,application/pdf" multiple style="display:none;" />' +
            '<input id="ai-camera-input" type="file" accept="image/*" capture="environment" style="display:none;" />' +
            '<div style="flex:1;"></div>' +
            '<button id="ai-mic" type="button" title="Dictate (voice → text)" aria-label="Dictate" style="background:transparent;border:none;color:var(--text-dim,#888);width:30px;height:30px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:15px;padding:0;transition:background 0.12s, color 0.12s;">&#x1F3A4;</button>' +
            '<button id="ai-send" type="button" title="Send (Enter)" aria-label="Send" style="background:rgba(79,140,255,0.18);border:1px solid rgba(79,140,255,0.4);color:#4f8cff;width:30px;height:30px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:14px;padding:0;transition:background 0.12s, color 0.12s;">&#x27A4;</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    // Wire interactions
    panel.querySelector('#ai-close').onclick = close;
    panel.querySelector('#ai-clear').onclick = clearConversation;
    panel.querySelector('#ai-send').onclick = onSend;
    wireAIPanelResizer(panel);
    var trustBtn = panel.querySelector('#ai-trust');
    if (trustBtn) trustBtn.onclick = function(e) {
      e.stopPropagation();
      if (typeof window._agxAiPanelOpenTrust === 'function') {
        window._agxAiPanelOpenTrust(trustBtn);
      }
    };
    var input = panel.querySelector('#ai-input');
    var pill = panel.querySelector('#ai-input-pill');
    // Auto-grow: textarea expands as the user types, capped at max-height
    // (set in the inline style above). Reset to scrollHeight on each input.
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 320) + 'px';
    }
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });
    // Pill focus ring — gives visual feedback that the borderless textarea
    // is the active input target.
    input.addEventListener('focus', function() {
      if (pill) {
        pill.style.borderColor = 'rgba(79,140,255,0.5)';
        pill.style.background = 'rgba(255,255,255,0.06)';
      }
    });
    input.addEventListener('blur', function() {
      if (pill) {
        pill.style.borderColor = 'var(--border,#333)';
        pill.style.background = 'rgba(255,255,255,0.04)';
      }
    });
    setupVoiceInput(panel);
    setupFileAttachments(panel);

    // Initial preset render — refreshed on every open() to switch
    // between estimate and job preset sets when the entity changes.
    renderPresets();

    // Esc-to-close while focus is in the panel
    panel.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') close();
    });

    return panel;
  }

  // Bind drag-resize behavior to the panel's left-edge handle. The
  // panel sits flush-right (right:0), so dragging left = wider, drag
  // right = narrower. Width snaps within [320 .. 92vw]; pulled below
  // 320 it stays at 320, pulled past 92vw clamps so the panel can't
  // hide the close button. The handle's hit area is 12px wide for
  // easy targeting; the visible line is 2px and brightens during drag.
  function wireAIPanelResizer(panel) {
    var handle = panel.querySelector('#ai-panel-resizer');
    if (!handle) return;
    var line = handle.firstElementChild;
    var dragging = null;

    handle.addEventListener('mouseenter', function() {
      if (!dragging && line) line.style.background = 'rgba(79,140,255,0.55)';
    });
    handle.addEventListener('mouseleave', function() {
      if (!dragging && line) line.style.background = 'rgba(79,140,255,0.18)';
    });

    handle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dragging = {
        startX: e.clientX,
        startW: panel.getBoundingClientRect().width
      };
      // Disable the slide transition mid-drag so the panel tracks
      // the cursor 1:1; restore it after.
      panel.dataset._priorTransition = panel.style.transition || '';
      panel.style.transition = 'none';
      if (line) line.style.background = '#4f8cff';
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    function onMove(e) {
      if (!dragging) return;
      // Panel grows to the LEFT — moving cursor left should widen.
      var delta = dragging.startX - e.clientX;
      var w = clampAIPanelWidth(dragging.startW + delta);
      panel.style.width = w + 'px';
    }
    function onUp() {
      if (!dragging) return;
      var w = parseInt(panel.style.width, 10);
      if (Number.isFinite(w)) saveAIPanelWidth(w);
      panel.style.transition = panel.dataset._priorTransition || 'transform 0.22s ease';
      delete panel.dataset._priorTransition;
      if (line) line.style.background = 'rgba(79,140,255,0.18)';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      dragging = null;
    }

    // Re-clamp on viewport resize so a saved 1500px width doesn't
    // leave the panel wider than the new (smaller) screen.
    window.addEventListener('resize', function() {
      var cur = panel.getBoundingClientRect().width;
      var next = clampAIPanelWidth(cur);
      if (next !== cur) panel.style.width = next + 'px';
    });
  }

  // open() accepts either:
  //   open(estimateId)                       — legacy: opens for an estimate
  //   open({ entityType, entityId })         — explicit polymorphic form
  function open(arg) {
    var entityType, entityId;
    if (typeof arg === 'string') {
      entityType = 'estimate';
      entityId = arg;
    } else if (arg && typeof arg === 'object') {
      entityType = arg.entityType || 'estimate';
      entityId = arg.entityId;
    }
    // Client mode is global to the user — no entity ID needed (the
    // directory IS the context). Other modes still require an entity.
    var requiresEntity = entityType !== 'client';
    if (requiresEntity && !entityId) {
      alert('Save the ' + (entityType || 'record') + ' first to enable the AI assistant.');
      return;
    }
    if (!requiresEntity) entityId = '__global__';
    var panel = ensurePanel();
    if (_entityId !== entityId || _entityType !== entityType) {
      _entityType = entityType;
      _entityId = entityId;
      _estimateId = entityType === 'estimate' ? entityId : null;
      _messages = [];
      loadHistory();
    }
    panel.style.transform = 'translateX(0)';
    document.body.classList.add('agx-ai-open');
    _open = true;
    // Photos toggle and proposal cards only make sense on the estimate
    // side. Hide / disable them when running against a job.
    refreshModeSpecificUI();
    setTimeout(function() {
      var inp = document.getElementById('ai-input');
      if (inp) inp.focus();
    }, 240);
  }

  function refreshModeSpecificUI() {
    var headerEl = document.querySelector('#agx-ai-panel .agx-ai-title');
    if (headerEl) {
      if (isJobMode()) headerEl.textContent = '📊 WIP Assistant';
      else if (isClientMode()) headerEl.textContent = '🤝 Customer Relations Agent';
      else headerEl.textContent = '📐 AG · AGX Estimator';
    }
    // Trust gear visible only in job mode (where the toggles apply).
    var trustBtn = document.getElementById('ai-trust');
    if (trustBtn) trustBtn.style.display = isJobMode() ? 'inline-block' : 'none';
    var noticeEl = document.querySelector('#agx-ai-panel #ai-notice');
    if (noticeEl) {
      if (isJobMode()) noticeEl.textContent = 'I see WIP, costs, the node graph, and QB lines — and I can propose edits (e.g. set a phase\'s % complete) for you to approve before they apply.';
      else if (isClientMode()) noticeEl.textContent = 'Customer Relations Agent — I keep the parent-company / property hierarchy clean. Simple writes apply automatically; restructural changes (new parent, merges, splits, deletes) require approval.';
      else noticeEl.textContent = 'I\'m AG — your AGX estimator. I can draft scopes, add/edit/delete line items and sections, and tweak pricing. Every change is shown as a card with Approve / Reject before it lands.';
    }
    var inputEl = document.getElementById('ai-input');
    if (inputEl) {
      if (isClientMode()) inputEl.placeholder = 'Describe a change, ask a question, or tap "Run full audit" below…';
      else if (isJobMode()) inputEl.placeholder = 'Ask anything about this job…';
      else inputEl.placeholder = 'Ask AG to draft, edit, or clean up the estimate…';
    }
    renderPresets();
  }

  function renderPresets() {
    var presetWrap = document.getElementById('ai-presets');
    if (!presetWrap) return;
    presetWrap.innerHTML = '';
    getActivePresets().forEach(function(p) {
      var btn = document.createElement('button');
      btn.className = 'ee-btn ghost';
      btn.textContent = p.label;
      btn.onclick = function() {
        if (_streaming) return;
        var ta = document.getElementById('ai-input');
        if (ta) { ta.value = p.prompt; ta.focus(); }
      };
      presetWrap.appendChild(btn);
    });
  }

  function close() {
    var panel = document.getElementById('agx-ai-panel');
    if (panel) panel.style.transform = 'translateX(100%)';
    document.body.classList.remove('agx-ai-open');
    _open = false;
    if (_abortController) {
      try { _abortController.abort(); } catch (e) { /* ignore */ }
      _abortController = null;
    }
  }

  function toggle(estimateId) {
    if (_open) close();
    else open(estimateId);
  }

  // ──────────────────────────────────────────────────────────────────
  // Conversation rendering
  // ──────────────────────────────────────────────────────────────────

  function loadHistory() {
    if (!_entityId || !window.agxApi) return;
    var box = document.getElementById('ai-messages');
    if (box) box.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;">Loading…</div>';
    fetch(apiBase() + '/messages', {
      headers: authHeaders()
    }).then(function(r) { return r.json(); }).then(function(res) {
      _messages = res.messages || [];
      renderMessages();
    }).catch(function() {
      _messages = [];
      renderMessages();
    });
  }

  function clearConversation() {
    if (!_entityId) return;
    var go = (typeof window.agxConfirm === 'function')
      ? window.agxConfirm({
          title: 'Clear conversation',
          message: 'Clear this conversation? Your messages on this ' + _entityType + ' will be deleted.',
          confirmLabel: 'Clear',
          danger: true
        })
      : Promise.resolve(window.confirm('Clear this conversation?'));
    go.then(function(ok) {
      if (!ok) return;
      fetch(apiBase() + '/messages', {
        method: 'DELETE',
        headers: authHeaders()
      }).then(function() {
        _messages = [];
        renderMessages();
      }).catch(function(err) {
        if (typeof window.agxAlert === 'function') {
          window.agxAlert({ title: 'Clear failed', message: err.message || String(err) });
        } else {
          alert('Clear failed: ' + (err.message || err));
        }
      });
    });
  }

  function renderMessages() {
    var box = document.getElementById('ai-messages');
    if (!box) return;
    if (!_messages.length) {
      var hint;
      if (isJobMode()) hint = 'Pick a preset below or ask anything about the job.<br><span style="font-size:11px;opacity:0.7;">I see contract, costs, COs, %complete, billing — plus the node graph wiring and QuickBooks cost lines.</span>';
      else if (isClientMode()) hint = '<strong style="color:var(--text,#fff);">🤝 Customer Relations Agent</strong><br>Tap <strong>Run full audit</strong> to clean up the directory in one pass — I\'ll split parent+property compounds, link unparented entries, merge dupes, and surface anything ambiguous for you.<br><span style="font-size:11px;opacity:0.7;">I know the AGX hierarchy: parent management company → property/community → CAM contact.</span>';
      else hint = '<strong style="color:var(--text,#fff);">📐 AG — your AGX estimator</strong><br>Pick a preset or describe what you need. I can read the estimate, scope, client, and photos — and propose adds, edits, deletes, and pricing changes for you to approve.<br><span style="font-size:11px;opacity:0.7;">Try "tighten this estimate" or "build my line items".</span>';
      box.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:20px 0;text-align:center;line-height:1.6;">' + hint + '</div>';
      return;
    }
    var html = '';
    _messages.forEach(function(m) {
      html += renderBubble(m);
    });
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  function renderBubble(m) {
    var isUser = m.role === 'user';
    var bg = isUser ? 'rgba(79,140,255,0.12)' : 'rgba(255,255,255,0.04)';
    var border = isUser ? '#4f8cff' : 'var(--border,#333)';
    var labelColor = isUser ? '#4f8cff' : '#34d399';
    var label = isUser ? 'You' : 'Claude';
    var photoNote = (isUser && m.photos_included) ? ' <span style="color:var(--text-dim,#888);font-weight:400;">(' + m.photos_included + ' photo' + (m.photos_included === 1 ? '' : 's') + ' attached)</span>' : '';
    return '<div style="background:' + bg + ';border-left:3px solid ' + border + ';border-radius:6px;padding:8px 10px;">' +
      '<div style="font-size:10px;font-weight:700;color:' + labelColor + ';text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + photoNote + '</div>' +
      '<div class="ai-content" style="font-size:13px;line-height:1.5;">' + (isUser ? '<p style="margin:0;white-space:pre-wrap;">' + escapeHTMLLocal(m.content) + '</p>' : renderMarkdown(m.content)) + '</div>' +
    '</div>';
  }

  function appendStreamingBubble() {
    var box = document.getElementById('ai-messages');
    if (!box) return null;
    var div = document.createElement('div');
    div.className = 'ai-streaming';
    div.style.cssText = 'background:rgba(255,255,255,0.04);border-left:3px solid #34d399;border-radius:6px;padding:8px 10px;';
    div.innerHTML =
      '<div style="font-size:10px;font-weight:700;color:#34d399;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Claude</div>' +
      '<div class="ai-content" data-stream-content style="font-size:13px;line-height:1.5;"><span style="color:var(--text-dim,#888);font-style:italic;">Thinking…</span></div>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  // ──────────────────────────────────────────────────────────────────
  // Send / stream
  // ──────────────────────────────────────────────────────────────────

  function authHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var token = (window.agxAuth && window.agxAuth.getToken && window.agxAuth.getToken()) || localStorage.getItem('agx-auth-token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  }

  function onSend() {
    if (_streaming) return;
    var input = document.getElementById('ai-input');
    var text = (input && input.value || '').trim();
    if (!text) return;
    if (!_entityId) { alert('No ' + _entityType + ' is open.'); return; }
    input.value = '';
    // Reset auto-grow height after clearing the value, so the textarea
    // collapses back to one row on submit instead of staying tall.
    input.style.height = 'auto';
    sendMessage(text);
  }

  function sendMessage(text) {
    // Pull any base64 images from the composer chips (uploads or PDF
    // renders) for one-shot vision on this turn. The same images are
    // ALSO persisted to the entity's attachments via processFile, so
    // subsequent turns will see them via the system-prompt context.
    var composerImages = [];
    var composerNotes = [];
    _pendingComposer.forEach(function(e) {
      if (e.status !== 'ready') return;
      composerImages = composerImages.concat(e.base64Images || []);
      composerNotes.push((e.kind === 'pdf' ? 'PDF: ' : 'Image: ') + e.filename + (e.viewUrl ? ' [stored]' : ''));
    });

    var photoCount = countCurrentPhotos();
    var inlineImageCount = (_pendingImages && _pendingImages.images ? _pendingImages.images.length : 0) + composerImages.length;
    _messages.push({
      role: 'user', content: text,
      photos_included: (_includePhotos ? photoCount : 0) + inlineImageCount
    });
    renderMessages();
    var body = isEstimateMode()
      ? { message: text, includePhotos: _includePhotos }
      : { message: text };
    // Job mode: send a snapshot of the node graph + an aggregated
    // QB cost summary so the assistant can reason about wiring and
    // uncategorized expenses. Both currently live client-side
    // (graph in localStorage, QB lines in workspace sheets); when
    // Phase 2 lands the server can pull them from DB and this
    // attachment becomes redundant.
    if (isJobMode()) {
      var clientCtx = buildJobClientContext();
      if (clientCtx) body.clientContext = clientCtx;
    }
    // Combine one-shot images: pre-existing handoff (PDF viewer) + composer.
    var bodyImages = [];
    if (_pendingImages && _pendingImages.images && _pendingImages.images.length) {
      bodyImages = bodyImages.concat(_pendingImages.images);
      _pendingImages = null;
    }
    if (composerImages.length) bodyImages = bodyImages.concat(composerImages);
    if (bodyImages.length) body.additional_images = bodyImages.slice(0, 18);

    _pendingComposer = [];
    renderAttachmentsStrip();

    streamFromEndpoint(apiBase() + '/chat', body);
  }

  // Shared streaming runner — used by sendMessage (initial turn) and by
  // continueAfterProposals (tool-use continuation). Handles all SSE event
  // shapes: text deltas, tool_use proposals, awaiting_approval, errors,
  // and end-of-turn.
  function streamFromEndpoint(endpoint, body) {
    var streamDiv = appendStreamingBubble();
    var contentEl = streamDiv && streamDiv.querySelector('[data-stream-content]');
    var assistantText = '';
    var pendingToolUses = [];     // tool_use blocks captured this turn
    var pendingAssistantContent = null; // full content array for echo-back
    _streaming = true;
    setSendDisabled(true);

    _abortController = new AbortController();
    return fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: _abortController.signal
    }).then(function(r) {
      if (!r.ok) {
        return r.json().then(function(err) { throw new Error(err.error || 'HTTP ' + r.status); });
      }
      return readSSEStream(r, function(payload) {
        if (payload.delta) {
          assistantText += payload.delta;
          if (contentEl) contentEl.innerHTML = renderMarkdown(assistantText) +
            '<span style="display:inline-block;width:7px;height:13px;background:#34d399;margin-left:2px;animation:agx-blink 0.9s step-end infinite;"></span>';
          scrollToBottom();
        } else if (payload.tool_use) {
          pendingToolUses.push(payload.tool_use);
        } else if (payload.tool_applied) {
          // Server-side auto-tier tool already executed. Show an inline
          // confirmation chip in the streaming bubble.
          appendToolChip(streamDiv, '✓', payload.tool_applied.summary || (payload.tool_applied.name + ' applied'), '#34d399');
          if (isClientMode() && typeof window.refreshClientsAfterAI === 'function') {
            window.refreshClientsAfterAI();
          }
          scrollToBottom();
        } else if (payload.tool_failed) {
          appendToolChip(streamDiv, '✗', payload.tool_failed.error || (payload.tool_failed.name + ' failed'), '#f87171');
          scrollToBottom();
        } else if (payload.tool_rejected) {
          appendToolChip(streamDiv, '⊘', (payload.tool_rejected.name || 'tool') + ' rejected', '#a3a3a3');
          scrollToBottom();
        } else if (payload.awaiting_approval) {
          pendingAssistantContent = payload.pending_assistant_content;
        } else if (payload.done) {
          if (isClientMode() && typeof window.refreshClientsAfterAI === 'function') {
            window.refreshClientsAfterAI();
          }
        } else if (payload.error) {
          if (contentEl) contentEl.innerHTML = '<span style="color:#f87171;">' + escapeHTMLLocal(payload.error) + '</span>';
        }
      });
    }).then(function() {
      _streaming = false;
      setSendDisabled(false);
      _abortController = null;

      if (pendingToolUses.length && pendingAssistantContent) {
        // Tool-use turn — render approval cards inline. The streamDiv
        // stays as the assistant bubble; cards get appended below the
        // text. No history persistence on this turn — the conversation
        // gets persisted only after the final text response of the
        // multi-step exchange.
        finalizeProposalBubble(streamDiv, assistantText, pendingToolUses, pendingAssistantContent);
      } else {
        // Plain text response — drop the streaming placeholder and add
        // a permanent bubble (history already persisted server-side).
        if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
        _messages.push({ role: 'assistant', content: assistantText || '(no response)' });
        renderMessages();
      }
    }).catch(function(err) {
      _streaming = false;
      setSendDisabled(false);
      _abortController = null;
      if (err && err.name === 'AbortError') {
        if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
      } else {
        if (contentEl) contentEl.innerHTML = '<span style="color:#f87171;">Error: ' + escapeHTMLLocal(err.message || 'unknown') + '</span>';
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Approval cards — for each tool_use block from Claude, render a card
  // with Approve / Reject. When all are answered, continue the
  // conversation with /chat/continue passing the assembled tool_results.
  // ──────────────────────────────────────────────────────────────────
  // Read-only tools — no approval friction. The card is replaced by
  // a small "Reading…" chip; the tool runs immediately and feeds its
  // result back to the assistant via the same /chat/continue flow.
  var AUTO_READ_TOOLS = { read_workspace_sheet_full: true, read_qb_cost_lines: true };

  function finalizeProposalBubble(streamDiv, assistantText, toolUses, pendingContent) {
    var contentEl = streamDiv && streamDiv.querySelector('[data-stream-content]');
    if (contentEl) contentEl.innerHTML = renderMarkdown(assistantText || '');

    var propContainer = document.createElement('div');
    propContainer.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:6px;';
    streamDiv.appendChild(propContainer);

    var responses = [];
    var totalCount = toolUses.length;
    var bulkButtons = null;

    function answer(idx, approved, card) {
      var tu = toolUses[idx];
      var summary = '';
      if (approved) {
        try {
          summary = applyTool(tu);
        } catch (e) {
          if (typeof window.agxAlert === 'function') {
            window.agxAlert({ title: 'Could not apply', message: e.message || String(e) });
          } else {
            alert('Could not apply: ' + (e.message || e));
          }
          return;
        }
      }
      responses.push({ tool_use_id: tu.id, approved: approved, applied_summary: summary });
      markCardDone(card, approved, summary);

      // Refresh bulk-action button count
      if (bulkButtons) {
        var remaining = totalCount - responses.length;
        if (remaining <= 0) bulkButtons.remove();
        else bulkButtons.querySelector('[data-bulk-info]').textContent = remaining + ' remaining';
      }

      if (responses.length === totalCount) {
        continueAfterProposals(pendingContent, responses);
      }
    }

    // ── Trust countdown — for tool types the user has marked as
    //    "auto-apply." Card still renders so the user sees what
    //    happened, but a 5s countdown ticks down and applies on
    //    completion. Click Cancel during the countdown to fall
    //    back to manual approval.
    function attachTrustCountdown(card, idx, tu) {
      if (!isJobMode()) return;          // trust scoped to job tools only
      if (!isTrusted(tu.name)) return;
      var actionsRow = card.querySelector('[data-card-actions]');
      if (!actionsRow) return;
      actionsRow.innerHTML = '';
      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;font-size:11px;color:var(--text-dim,#aaa);';
      bar.innerHTML =
        '<span style="color:#34d399;font-weight:700;">&#x2713; Trusted</span>' +
        '<span data-countdown style="color:var(--text-dim,#888);">auto-applying in 5s…</span>' +
        '<button data-cancel class="ghost small" style="padding:3px 10px;font-size:10px;margin-left:auto;">Cancel &amp; review</button>';
      actionsRow.appendChild(bar);
      var seconds = 5;
      var iv = setInterval(function() {
        seconds--;
        var span = bar.querySelector('[data-countdown]');
        if (span) span.textContent = seconds > 0 ? 'auto-applying in ' + seconds + 's…' : 'applying…';
        if (seconds <= 0) {
          clearInterval(iv);
          answer(idx, true, card);
        }
      }, 1000);
      bar.querySelector('[data-cancel]').onclick = function() {
        clearInterval(iv);
        // Restore the manual buttons
        actionsRow.innerHTML =
          '<button data-card-approve class="success small" style="padding:4px 12px;font-size:11px;">&check; Approve</button>' +
          '<button data-card-reject class="ghost small" style="padding:4px 12px;font-size:11px;">&times; Reject</button>';
        actionsRow.querySelector('[data-card-approve]').onclick = function() { answer(idx, true, card); };
        actionsRow.querySelector('[data-card-reject]').onclick = function() { answer(idx, false, card); };
      };
    }

    // Bulk-action bar when there are 2+ proposals
    if (totalCount >= 2) {
      bulkButtons = document.createElement('div');
      bulkButtons.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(79,140,255,0.05);border:1px solid rgba(79,140,255,0.2);border-radius:6px;font-size:11px;color:var(--text-dim,#aaa);';
      bulkButtons.innerHTML =
        '<span data-bulk-info>' + totalCount + ' proposals</span>' +
        '<button data-bulk-approve class="success small" style="padding:4px 10px;font-size:11px;margin-left:auto;">&check; Approve all</button>' +
        '<button data-bulk-reject class="ghost small" style="padding:4px 10px;font-size:11px;">&times; Reject all</button>';
      propContainer.appendChild(bulkButtons);
      bulkButtons.querySelector('[data-bulk-approve]').onclick = function() {
        cards.forEach(function(card, i) {
          if (!isCardAnswered(card)) answer(i, true, card);
        });
      };
      bulkButtons.querySelector('[data-bulk-reject]').onclick = function() {
        cards.forEach(function(card, i) {
          if (!isCardAnswered(card)) answer(i, false, card);
        });
      };
    }

    var cards = [];
    toolUses.forEach(function(tu, i) {
      // Read-only / auto-apply tools render as a tight chip and run
      // immediately. No approval card, no Trust countdown — the
      // result feeds back via /chat/continue with the rest.
      if (AUTO_READ_TOOLS[tu.name]) {
        var chip = document.createElement('div');
        chip.style.cssText = 'background:rgba(79,140,255,0.06);border:1px solid rgba(79,140,255,0.25);border-left:3px solid #4f8cff;border-radius:6px;padding:6px 10px;font-size:11px;color:var(--text-dim,#aaa);display:flex;align-items:center;gap:8px;';
        chip.innerHTML =
          '<span style="color:#4f8cff;font-weight:700;">📖</span>' +
          '<span data-chip-text style="flex:1;">Reading <strong>' + escapeHTMLLocal(tu.input?.sheet_name || tu.name) + '</strong>…</span>';
        propContainer.appendChild(chip);
        cards.push(chip);
        var summary;
        try {
          summary = applyTool(tu);
          var t = chip.querySelector('[data-chip-text]');
          if (t) t.innerHTML = '✓ Read <strong>' + escapeHTMLLocal(tu.input?.sheet_name || tu.name) + '</strong>';
          chip.style.borderLeftColor = '#34d399';
        } catch (e) {
          summary = 'Read failed: ' + (e.message || String(e));
          var t2 = chip.querySelector('[data-chip-text]');
          if (t2) t2.textContent = summary;
          chip.style.borderLeftColor = '#f87171';
        }
        responses.push({ tool_use_id: tu.id, approved: true, applied_summary: summary });
        // Refresh bulk count if any
        if (bulkButtons) {
          var remaining = totalCount - responses.length;
          if (remaining <= 0) bulkButtons.remove();
          else bulkButtons.querySelector('[data-bulk-info]').textContent = remaining + ' remaining';
        }
        if (responses.length === totalCount) {
          continueAfterProposals(pendingContent, responses);
        }
        return; // skip the approval-card path entirely
      }
      var card = renderProposalCard(tu);
      card.querySelector('[data-card-approve]').onclick = function() { answer(i, true, card); };
      card.querySelector('[data-card-reject]').onclick = function() { answer(i, false, card); };
      propContainer.appendChild(card);
      cards.push(card);
      attachTrustCountdown(card, i, tu);
    });
    scrollToBottom();
  }

  // ── Trust toggles ────────────────────────────────────────────
  // localStorage map of job-side tool names → true|false. Default
  // false (always preview). Toggle via the gear in the panel header.
  function isTrusted(toolName) {
    try {
      var raw = localStorage.getItem('agx-ai-trust:job') || '{}';
      var map = JSON.parse(raw);
      return !!map[toolName];
    } catch (e) { return false; }
  }
  function setTrusted(toolName, val) {
    try {
      var raw = localStorage.getItem('agx-ai-trust:job') || '{}';
      var map = JSON.parse(raw);
      if (val) map[toolName] = true; else delete map[toolName];
      localStorage.setItem('agx-ai-trust:job', JSON.stringify(map));
    } catch (e) {}
  }
  // The four job-side tools available for trust toggling, with friendly
  // labels for the popover.
  var TRUSTABLE_TOOLS = [
    { name: 'create_node',            label: 'Create a new graph node (t1/t2/cost-bucket/etc.)' },
    { name: 'delete_node',            label: 'Remove a graph node + its wires (data preserved)' },
    { name: 'set_phase_pct_complete', label: 'Set phase % complete' },
    { name: 'set_phase_field',        label: 'Set phase $ field (materials/labor/sub/equip)' },
    { name: 'set_node_value',         label: 'Set cost node value (mat/labor/gc/other/sub)' },
    { name: 'wire_nodes',             label: 'Wire two graph nodes' },
    { name: 'assign_qb_line',         label: 'Assign QB line to a node' }
  ];

  function openTrustPopover(anchorBtn) {
    var existing = document.getElementById('agx-ai-trust-popover');
    if (existing) { existing.remove(); return; }
    var pop = document.createElement('div');
    pop.id = 'agx-ai-trust-popover';
    var rect = anchorBtn.getBoundingClientRect();
    pop.style.cssText =
      'position:fixed;top:' + (rect.bottom + 4) + 'px;right:' + Math.max(8, window.innerWidth - rect.right) + 'px;' +
      'background:var(--surface,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.6);padding:10px 12px;z-index:1100;width:300px;';
    pop.innerHTML =
      '<div style="font-size:11px;font-weight:700;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Trust auto-apply</div>' +
      '<div style="font-size:11px;color:var(--text-dim,#888);margin-bottom:8px;line-height:1.4;">Trusted tools still show a card, but auto-apply after a 5s countdown. Cancel &amp; review during the countdown to override.</div>' +
      TRUSTABLE_TOOLS.map(function(t) {
        var on = isTrusted(t.name);
        return '<label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px;color:var(--text,#e6e6e6);cursor:pointer;">' +
          '<input type="checkbox" data-tool="' + t.name + '"' + (on ? ' checked' : '') + ' />' +
          '<span>' + t.label + '</span>' +
        '</label>';
      }).join('');
    document.body.appendChild(pop);
    pop.querySelectorAll('input[data-tool]').forEach(function(box) {
      box.addEventListener('change', function() {
        setTrusted(box.getAttribute('data-tool'), box.checked);
      });
    });
    // Click-outside dismiss
    setTimeout(function() {
      document.addEventListener('click', function dismissOnce(e) {
        if (pop.contains(e.target) || anchorBtn.contains(e.target)) return;
        pop.remove();
        document.removeEventListener('click', dismissOnce);
      });
    }, 0);
  }
  // Public for the panel header button
  window._agxAiPanelOpenTrust = openTrustPopover;

  function applyTool(tu) {
    if (isClientMode()) {
      // Server applies client tools on /chat/continue. Just signal approval.
      return '';
    }
    if (isJobMode()) {
      return applyJobTool(tu);
    }
    if (!window.estimateEditorAPI) {
      throw new Error('Estimate editor not loaded — refresh the page.');
    }
    if (!window.estimateEditorAPI.isOpenFor(_estimateId)) {
      throw new Error('Open the estimate in the editor before approving changes.');
    }
    switch (tu.name) {
      case 'propose_add_line_item':    return window.estimateEditorAPI.applyAddLineItem(tu.input);
      case 'propose_add_section':      return window.estimateEditorAPI.applyAddSection(tu.input);
      case 'propose_update_scope':     return window.estimateEditorAPI.applyUpdateScope(tu.input);
      case 'propose_delete_line_item': return window.estimateEditorAPI.applyDeleteLine(tu.input);
      case 'propose_update_line_item': return window.estimateEditorAPI.applyUpdateLine(tu.input);
      case 'propose_delete_section':   return window.estimateEditorAPI.applyDeleteSection(tu.input);
      case 'propose_update_section':   return window.estimateEditorAPI.applyUpdateSection(tu.input);
      default: throw new Error('Unknown tool: ' + tu.name);
    }
  }

  // Job-side tool application. All writes go through appData + the
  // existing CRUD APIs so the rest of the app picks up changes via
  // the standard saveData() persistence path.
  function applyJobTool(tu) {
    var input = tu.input || {};
    switch (tu.name) {
      case 'set_phase_pct_complete': {
        // Phase IDs vs Node IDs: the AI sometimes hands us a graph
        // node id ("n2") instead of a phase record id ("ph_..."). Try
        // appData.phases first; if not found, look for a t2 node with
        // that id and route through it. T2 nodes carry their own
        // pctComplete which the engine syncs to the phase record on
        // the next render cycle, so either path lands the same value.
        var newPct = Math.max(0, Math.min(100, Number(input.pct_complete || 0)));
        var phase = (window.appData && (appData.phases || []).find(function(p) { return p.id === input.phase_id; }));
        if (phase) {
          var oldPct = Number(phase.pctComplete || 0);
          phase.pctComplete = newPct;
          if (typeof window.saveData === 'function') window.saveData();
          if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
            try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
          }
          return Math.round(oldPct) + '% → ' + Math.round(phase.pctComplete) + '% on phase "' + (phase.phase || phase.name || phase.id) + '"';
        }
        // Fallback — try as a graph node id.
        var liveNodesP = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
        var nodeP = liveNodesP.find(function(n) { return n.id === input.phase_id; });
        if (!nodeP) throw new Error('Phase id "' + input.phase_id + '" not found in appData.phases or in the node graph.');
        if (nodeP.type !== 't2' && nodeP.type !== 't1') {
          throw new Error('Node "' + input.phase_id + '" is type "' + nodeP.type + '" — set_phase_pct_complete only works on t2 (phase) or t1 (building) nodes. For cost-bucket nodes use set_node_value.');
        }
        var oldNodePct = Number(nodeP.pctComplete || 0);
        nodeP.pctComplete = newPct;
        if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph();
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }
        return Math.round(oldNodePct) + '% → ' + Math.round(newPct) + '% on node "' + (nodeP.label || nodeP.id) + '" (' + nodeP.type + ')';
      }

      case 'create_node': {
        // Spawn a new node on the graph. The engine's createDataEntry
        // path automatically creates the underlying data record for
        // structural types (t1=building, t2=phase, co=change order,
        // po, inv, sub) so the AI doesn't have to plumb ids manually.
        // Position is auto-cascaded near the WIP master node so the
        // graph stays tidy on bulk creates.
        var jidCN = (window.appState && appState.currentJobId) || null;
        if (!jidCN) throw new Error('No job is open.');
        if (typeof NG === 'undefined' || !NG.addNode) {
          throw new Error('Node graph is not loaded — open the Workspace tab on this job first so the engine is initialized.');
        }
        // Schema field is `node_type` (renamed from `type` to dodge a
        // JSON Schema keyword collision that was silently dropping the
        // value). Accept the legacy `type` for any in-flight tool_uses
        // queued before this rollout.
        var t = String(input.node_type || input.type || '').toLowerCase();
        var allowedTypes = { t1:1, t2:1, labor:1, mat:1, gc:1, other:1, burden:1, sub:1, po:1, inv:1, co:1, watch:1, note:1 };
        if (!allowedTypes[t]) throw new Error('Unsupported node type "' + t + '". Pick one of: ' + Object.keys(allowedTypes).join(', '));
        var lbl = String(input.label || '').trim();
        if (!lbl && t !== 'note') throw new Error('label required for ' + t + ' nodes.');

        // Compute a tidy position. Cascade newly-created nodes in a
        // grid so a bulk-create doesn't pile every node on top of the
        // last one — base off the highest-x existing node + offset.
        var existingNodes = NG.nodes() || [];
        var baseX = 80, baseY = 80;
        if (existingNodes.length) {
          // Find rightmost x, place 220px to its right; wrap to next
          // row every 6 nodes so big restructures stay readable.
          var maxX = 0, maxY = 0;
          existingNodes.forEach(function(n) {
            if ((n.x || 0) > maxX) maxX = n.x || 0;
            if ((n.y || 0) > maxY) maxY = n.y || 0;
          });
          // Count nodes recently created (no data.id yet, or just created
          // in this turn). We use a tiny per-call offset to space them.
          var spawnOffset = (window._agxAiSpawnCounter = ((window._agxAiSpawnCounter || 0) + 1));
          baseX = maxX + 220;
          baseY = 80 + ((spawnOffset - 1) % 6) * 140;
          if (spawnOffset > 6) baseX = baseX - 220 * Math.floor((spawnOffset - 1) / 6);
        }

        var newNode = NG.addNode(t, baseX, baseY, lbl);
        if (!newNode) throw new Error('addNode returned null — type may not support auto-creation.');

        // Optional initial values.
        if (typeof input.value === 'number' && isFinite(input.value)) {
          newNode.value = Math.max(0, input.value);
        }
        if (typeof input.budget === 'number' && isFinite(input.budget)) {
          newNode.budget = Math.max(0, input.budget);
          // Mirror to the underlying data record for t1/t2 so the WIP
          // page reads the budget correctly.
          if (newNode.data && (t === 't1' || t === 't2')) {
            newNode.data.budget = newNode.budget;
            if (t === 't2') newNode.data.phaseBudget = newNode.budget;
          }
        }
        if (typeof input.pct_complete === 'number' && isFinite(input.pct_complete)) {
          newNode.pctComplete = Math.max(0, Math.min(100, input.pct_complete));
          if (newNode.data && (t === 't1' || t === 't2')) {
            newNode.data.pctComplete = newNode.pctComplete;
          }
        }

        // Optional auto-wire to an existing target.
        var wiredTo = null;
        if (input.attach_to_node_id) {
          var liveWiresCN = NG.wires();
          var attachId = String(input.attach_to_node_id);
          var attachTarget = existingNodes.find(function(n) { return n.id === attachId; });
          if (!attachTarget) {
            // Try label match as a courtesy — same pattern as wire_nodes.
            var lower = attachId.trim().toLowerCase();
            attachTarget = existingNodes.find(function(n) { return (n.label || '').trim().toLowerCase() === lower; });
          }
          if (attachTarget) {
            liveWiresCN.push({
              fromNode: newNode.id,
              fromPort: 0,
              toNode: attachTarget.id,
              toPort: 0
            });
            wiredTo = attachTarget;
          }
        }

        if (typeof NG.saveGraph === 'function') NG.saveGraph();
        if (typeof window.saveData === 'function') window.saveData();
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }

        var summary = 'Created ' + t + ' node "' + (newNode.label || newNode.id) + '" (id=' + newNode.id + ')';
        if (wiredTo) summary += ' → wired to ' + (wiredTo.label || wiredTo.id);
        return summary;
      }

      case 'set_phase_field': {
        // Same id-fallback pattern as set_phase_pct_complete — accept
        // a graph node id and route through it when no matching phase
        // record exists. T2 nodes don't store materials/labor/sub/
        // equipment as direct fields — those flow up from wired cost
        // children — so falling back to a node id only makes sense
        // when the user passed a phase record id by accident.
        var allowed = ['materials', 'labor', 'sub', 'equipment'];
        if (allowed.indexOf(input.field) === -1) throw new Error('Field "' + input.field + '" not allowed.');
        var ph = (window.appData && (appData.phases || []).find(function(p) { return p.id === input.phase_id; }));
        if (ph) {
          var oldAmt = Number(ph[input.field] || 0);
          ph[input.field] = Math.max(0, Number(input.amount || 0));
          if (typeof window.saveData === 'function') window.saveData();
          if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
            try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
          }
          return input.field + ': $' + oldAmt.toFixed(0) + ' → $' + Number(ph[input.field]).toFixed(0) + ' on phase "' + (ph.phase || ph.name || ph.id) + '"';
        }
        // Helpful error: redirect the AI to the right tool when the
        // id looks like a node.
        var liveNodesF = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
        var nodeF = liveNodesF.find(function(n) { return n.id === input.phase_id; });
        if (nodeF) {
          throw new Error('"' + input.phase_id + '" is a graph node (type "' + nodeF.type + '"), not a phase record. Use set_node_value for cost-bucket nodes (labor/mat/gc/other/sub/burden), or set_phase_pct_complete for t2 % complete.');
        }
        throw new Error('Phase id "' + input.phase_id + '" not found.');
      }

      case 'delete_node': {
        // Remove a node from the graph + all its incoming/outgoing
        // wires. Underlying data record is intentionally LEFT IN
        // PLACE — same semantics as the "Remove from Graph" right-
        // click action in the node menu (vs "Delete from Job" which
        // also wipes data). Mirrors wire_nodes' live-engine-first
        // persistence so direct edits survive saveGraph.
        var jidDN = (window.appState && appState.currentJobId) || null;
        if (!jidDN) throw new Error('No job is open.');
        if (typeof NG === 'undefined' || !NG.nodes || !NG.wires) {
          throw new Error('Node graph is not loaded — open the Workspace tab on this job first.');
        }
        var liveNodesD = NG.nodes();
        var liveWiresD = NG.wires();
        var idOrLabelD = String(input.node_id || '');
        if (!idOrLabelD) throw new Error('node_id required.');
        // id-or-label fallback (same as wire_nodes / set_node_value)
        var nodeD = liveNodesD.find(function(n) { return n.id === idOrLabelD; });
        if (!nodeD) {
          var lowerD = idOrLabelD.trim().toLowerCase();
          nodeD = liveNodesD.find(function(n) { return (n.label || '').trim().toLowerCase() === lowerD; });
        }
        if (!nodeD) throw new Error('Node "' + idOrLabelD + '" not in graph.');

        // Block deleting the WIP master node — it's the graph's root
        // output and removing it leaves no place for costs to flow
        // upward. Re-deletable manually if the user really wants it,
        // but the AI shouldn't decide that on its own.
        if (nodeD.type === 'wip') {
          throw new Error('Refusing to delete the WIP master node — that\'s the graph\'s root output. The user can remove it manually if needed.');
        }

        // Count wires before removing for the summary line.
        var attachedWireCount = 0;
        for (var iD = 0; iD < liveWiresD.length; iD++) {
          var wD = liveWiresD[iD];
          if (wD.fromNode === nodeD.id || wD.toNode === nodeD.id) attachedWireCount++;
        }

        // Mutate live arrays via NG setters when available; fall back
        // to in-place splice so older builds without setters still
        // work.
        var keptWires = liveWiresD.filter(function(w) {
          return w.fromNode !== nodeD.id && w.toNode !== nodeD.id;
        });
        var keptNodes = liveNodesD.filter(function(n) { return n.id !== nodeD.id; });
        if (NG.setWires) NG.setWires(keptWires);
        else { liveWiresD.length = 0; Array.prototype.push.apply(liveWiresD, keptWires); }
        if (NG.setNodes) NG.setNodes(keptNodes);
        else { liveNodesD.length = 0; Array.prototype.push.apply(liveNodesD, keptNodes); }

        if (typeof NG.saveGraph === 'function') NG.saveGraph();
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }

        return 'Removed ' + nodeD.type + ' node "' + (nodeD.label || nodeD.id) + '" and ' +
          attachedWireCount + ' wire' + (attachedWireCount === 1 ? '' : 's') +
          '. Underlying job data preserved.';
      }

      case 'wire_nodes': {
        // Push directly to the engine's live wires array. Mutating
        // localStorage alone doesn't work — ngRender() ends with
        // E.saveGraph() which writes the engine's IN-MEMORY state
        // back to localStorage, overwriting any direct edits. So
        // we read/write through NG.* and let saveGraph persist.
        // Falls back to a localStorage-only path when the engine
        // isn't loaded (rare — graph would have to be uninitialized).
        var jid = (window.appState && appState.currentJobId) || null;
        if (!jid) throw new Error('No job is open.');

        var liveNodes = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : null;
        var liveWires = (typeof NG !== 'undefined' && NG.wires) ? NG.wires() : null;
        var nodesArr, wiresArr, persistDirect = false, graphsBlob = null, gBlob = null;
        if (Array.isArray(liveNodes) && Array.isArray(liveWires) && liveNodes.length) {
          nodesArr = liveNodes;
          wiresArr = liveWires;
        } else {
          // Engine hasn't loaded this job's graph yet — fall back to
          // the localStorage blob and persist directly.
          persistDirect = true;
          graphsBlob = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
          gBlob = graphsBlob[jid];
          if (!gBlob || !Array.isArray(gBlob.nodes)) throw new Error('Job has no node graph yet.');
          nodesArr = gBlob.nodes;
          wiresArr = Array.isArray(gBlob.wires) ? gBlob.wires : (gBlob.wires = []);
        }

        // Resolve id → fallback to label match if the AI sent a label.
        var resolveNode = function(idOrLabel) {
          if (!idOrLabel) return null;
          var byId = nodesArr.find(function(n) { return n.id === idOrLabel; });
          if (byId) return byId;
          var lower = String(idOrLabel).trim().toLowerCase();
          var byLabel = nodesArr.find(function(n) { return (n.label || '').trim().toLowerCase() === lower; });
          return byLabel || null;
        };
        var fromN = resolveNode(input.from_node_id);
        var toN = resolveNode(input.to_node_id);
        if (!fromN) throw new Error('from_node_id "' + input.from_node_id + '" not in graph.');
        if (!toN) throw new Error('to_node_id "' + input.to_node_id + '" not in graph.');

        var dup = wiresArr.some(function(w) {
          return w.fromNode === fromN.id && w.toNode === toN.id &&
                 w.fromPort === (input.from_port || 0) && w.toPort === (input.to_port || 0);
        });
        if (dup) return 'Wire ' + fromN.id + ' → ' + toN.id + ' already existed; no change.';

        wiresArr.push({
          fromNode: fromN.id,
          fromPort: input.from_port || 0,
          toNode: toN.id,
          toPort: input.to_port || 0
        });

        if (persistDirect) {
          graphsBlob[jid] = gBlob;
          localStorage.setItem('agx-nodegraphs', JSON.stringify(graphsBlob));
        } else if (typeof NG !== 'undefined' && NG.saveGraph) {
          // Write the now-updated in-memory state through the engine.
          NG.saveGraph();
        }
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }
        return 'Wired ' + (fromN.label || fromN.id) + ' → ' + (toN.label || toN.id);
      }

      case 'set_node_value': {
        // Set a cost-bucket node's `value` (the QB Total field rendered
        // on labor/mat/gc/other/sub nodes). Mutates the live engine
        // nodes array so the graph re-renders / pushes to job. Mirrors
        // wire_nodes' "live array first, localStorage fallback" pattern
        // so direct edits aren't overwritten by saveGraph on next render.
        var jidNV = (window.appState && appState.currentJobId) || null;
        if (!jidNV) throw new Error('No job is open.');

        var liveNodesV = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : null;
        var nodesArrV, persistDirectV = false, graphsBlobV = null, gBlobV = null;
        if (Array.isArray(liveNodesV) && liveNodesV.length) {
          nodesArrV = liveNodesV;
        } else {
          persistDirectV = true;
          graphsBlobV = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
          gBlobV = graphsBlobV[jidNV];
          if (!gBlobV || !Array.isArray(gBlobV.nodes)) throw new Error('Job has no node graph yet.');
          nodesArrV = gBlobV.nodes;
        }

        // id → label fallback (same pattern as wire_nodes / assign_qb_line)
        var idOrLabel = String(input.node_id || '');
        var node = nodesArrV.find(function(n) { return n.id === idOrLabel; });
        if (!node) {
          var lowerL = idOrLabel.trim().toLowerCase();
          node = nodesArrV.find(function(n) { return (n.label || '').trim().toLowerCase() === lowerL; });
        }
        if (!node) throw new Error('Node "' + idOrLabel + '" not in graph. Use a node id from the # Node graph block (not a phase id).');

        var allowedTypes = { labor: 1, mat: 1, gc: 1, other: 1, sub: 1, burden: 1 };
        if (!allowedTypes[node.type]) {
          throw new Error('set_node_value only works on cost-bucket nodes (labor/mat/gc/other/sub/burden). Node "' + (node.label || node.id) + '" is type "' + node.type + '". For phase fields use set_phase_field.');
        }

        var amt = Number(input.amount);
        if (!isFinite(amt) || amt < 0) throw new Error('amount must be a non-negative number.');

        var prior = Number(node.value || 0);
        node.value = amt;

        if (persistDirectV) {
          graphsBlobV[jidNV] = gBlobV;
          localStorage.setItem('agx-nodegraphs', JSON.stringify(graphsBlobV));
        } else if (typeof NG !== 'undefined' && NG.saveGraph) {
          NG.saveGraph();
        }
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }
        return 'Set ' + (node.label || node.id) + ' (' + node.type + ') value: $' +
          prior.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) +
          ' → $' + amt.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      }

      case 'read_workspace_sheet_full': {
        // Return the entire sheet's contents as the tool_result so
        // the assistant can analyze data past the default 100×26
        // preview window. Sheet name lookup is fuzzy: exact →
        // case-insensitive → trimmed-whitespace. Empty sheets return
        // a diagnostic message naming nearby tabs so the assistant
        // can suggest alternatives instead of saying "0 rows."
        var jid = (window.appState && appState.currentJobId) || null;
        if (!jid) throw new Error('No job is open.');
        var allWs = JSON.parse(localStorage.getItem('agx-workspaces') || '{}');
        var wb = allWs[jid];
        if (!wb || !Array.isArray(wb.sheets)) throw new Error('No workspace for this job.');
        var requested = String(input.sheet_name || '');
        // Hard-block legacy QB Costs import snapshots — the AI was
        // looping through these (one tool call per import date) when
        // the user just wants to know about QB spend. The canonical,
        // deduplicated, server-persisted data is already in the
        // qbCosts block of every prompt; reading these sheets is
        // never the right move.
        if (/^QB Costs /i.test(requested)) {
          return 'STOP — do not read individual "QB Costs YYYY-MM-DD" sheets. ' +
            'Those are legacy per-import snapshots. The consolidated, deduplicated, ' +
            'server-persisted QuickBooks data for this job is in the # QuickBooks cost data ' +
            'block of the system prompt (with totals, by-category breakdown, top lines, and ' +
            'most-recent-import date). Answer from that block instead. If you need a specific ' +
            'line by id, it\'s in the Top-N samples list there.';
        }
        var norm = function(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
        var rNorm = norm(requested);
        var sheet = wb.sheets.find(function(s) { return s.name === requested; }) ||
                    wb.sheets.find(function(s) { return norm(s.name) === rNorm; });
        if (!sheet) {
          // Tell the assistant which sheets DO exist so it can
          // re-prompt the user with valid options. QB Costs sheets
          // and the embedded "Detailed Costs" view are excluded
          // since they aren't user-readable via this tool.
          var available = wb.sheets
            .filter(function(s) {
              return !/^QB Costs /i.test(s.name || '') && s.kind !== 'qb-costs';
            })
            .map(function(s) { return s.name || '(unnamed)'; });
          throw new Error('Sheet "' + requested + '" not found. Available tabs: ' + (available.length ? available.join(' · ') : '(none)'));
        }
        // Same guard for the embedded Detailed Costs view (kind=qb-costs)
        // — its data is the qbCosts block, not cells.
        if (sheet.kind === 'qb-costs') {
          return 'STOP — the "Detailed Costs" tab is a live view of the # QuickBooks cost data block ' +
            'in the system prompt, not a grid sheet. Use that block to answer.';
        }
        var cells = sheet.cells || {};
        var grid = {};
        var maxR = 0, maxC = 0;
        Object.keys(cells).forEach(function(k) {
          var m = k.match(/^(\d+),(\d+)$/);
          if (!m) return;
          var r = parseInt(m[1], 10), c = parseInt(m[2], 10);
          if (r > 1000 || c > 26) return;
          var v = cells[k];
          if (v == null) return;
          var raw = (typeof v === 'object' && 'value' in v) ? v.value : v;
          if (raw == null || raw === '') return;
          if (!grid[r]) grid[r] = {};
          grid[r][c] = String(raw);
          if (r > maxR) maxR = r;
          if (c > maxC) maxC = c;
        });
        var rows = [];
        for (var r = 0; r <= maxR; r++) {
          if (!grid[r]) continue;
          var parts = [];
          for (var c = 0; c <= maxC; c++) {
            if (grid[r][c] != null) {
              var label = String.fromCharCode(65 + c);
              parts.push(label + '=' + String(grid[r][c]).replace(/\s+/g, ' '));
            }
          }
          if (parts.length) rows.push((r + 1) + ': ' + parts.join(' · '));
        }
        if (!rows.length) {
          // Empty sheet — be explicit so the assistant doesn't claim
          // "0 rows" generically. Includes the matched name + an
          // explanation that workspace sheets are localStorage-only
          // (so cross-device sync hasn't happened yet).
          var siblings = wb.sheets.map(function(s) { return s.name || '(unnamed)'; }).filter(function(n) { return n !== sheet.name; });
          return 'Sheet "' + sheet.name + '" exists but has no populated cells in this browser session. ' +
            'Workspace sheets are localStorage-only right now — cells aren\'t synced across devices/sessions, ' +
            'so if the user expects data here they may need to open the Workspace tab and Save it on this machine. ' +
            (siblings.length ? 'Other tabs in this job: ' + siblings.join(' · ') + '.' : '');
        }
        var header = 'Sheet "' + sheet.name + '" — ' + rows.length + ' populated rows × ' + (maxC + 1) + ' cols\n\n';
        return header + rows.join('\n');
      }

      case 'read_qb_cost_lines': {
        // Pull from appData.qbCostLines (server-hydrated). Returns the
        // full filtered list as a compact text block so the model can
        // reason over individual transactions without us having to
        // pre-stuff hundreds of lines into every system prompt.
        var jidQ = (window.appState && appState.currentJobId) || null;
        if (!jidQ) throw new Error('No job is open.');
        var allQB = (window.appData && Array.isArray(appData.qbCostLines))
          ? appData.qbCostLines.filter(function(l) { return (l.job_id || l.jobId) === jidQ; })
          : [];
        if (!allQB.length) {
          return 'No QuickBooks cost lines for this job. The user may not have imported QB data yet, or the import is on another device and the qb_cost_lines server table is empty for this job.';
        }
        var iLower = function(s) { return String(s == null ? '' : s).toLowerCase(); };
        var fAccount = iLower(input.account || '');
        var fVendor  = iLower(input.vendor  || '');
        var fSearch  = iLower(input.search  || '');
        var fStatus  = String(input.status  || 'all').toLowerCase();
        var lim      = Math.max(1, Math.min(1000, parseInt(input.limit, 10) || 200));
        var filtered = allQB.filter(function(l) {
          if (fAccount && iLower(l.account).indexOf(fAccount) === -1) return false;
          if (fVendor  && iLower(l.vendor).indexOf(fVendor) === -1) return false;
          if (fSearch) {
            var hay = iLower(l.vendor) + ' ' + iLower(l.memo) + ' ' + iLower(l.account) + ' ' + iLower(l.klass);
            if (hay.indexOf(fSearch) === -1) return false;
          }
          var linked = !!(l.linked_node_id || l.linkedNodeId);
          if (fStatus === 'linked' && !linked) return false;
          if (fStatus === 'unlinked' && linked) return false;
          return true;
        });
        // Sort newest first, biggest amount first as tiebreak.
        filtered.sort(function(a, b) {
          var da = String(a.txn_date || a.date || '');
          var db = String(b.txn_date || b.date || '');
          if (da !== db) return db.localeCompare(da);
          return Number(b.amount || 0) - Number(a.amount || 0);
        });
        var truncated = filtered.length > lim;
        var slice = filtered.slice(0, lim);
        var totalShown = slice.reduce(function(s, l) { return s + Number(l.amount || 0); }, 0);
        var totalAll   = filtered.reduce(function(s, l) { return s + Number(l.amount || 0); }, 0);
        var header = 'QB cost lines for this job — ' +
          'matched: ' + filtered.length + ' (showing ' + slice.length + (truncated ? ', truncated by limit' : '') + '), ' +
          'matched total: $' + totalAll.toFixed(2) + (truncated ? ', shown total: $' + totalShown.toFixed(2) : '') +
          '\n';
        if (fAccount || fVendor || fSearch || fStatus !== 'all') {
          var fparts = [];
          if (fAccount) fparts.push('account~"' + input.account + '"');
          if (fVendor)  fparts.push('vendor~"'  + input.vendor  + '"');
          if (fSearch)  fparts.push('search~"'  + input.search  + '"');
          if (fStatus !== 'all') fparts.push('status=' + fStatus);
          header += 'Filters: ' + fparts.join(', ') + '\n';
        }
        var body = slice.map(function(l) {
          var d = String(l.txn_date || l.date || '');
          if (d.length > 10) d = d.slice(0, 10);
          var amt = Number(l.amount || 0);
          var linked = (l.linked_node_id || l.linkedNodeId) ? ' →node:' + (l.linked_node_id || l.linkedNodeId) : ' →UNLINKED';
          var memo = l.memo ? ' — ' + String(l.memo).slice(0, 80) : '';
          return '- [id=' + (l.id || '?') + '] ' + d + ' $' + amt.toFixed(2) +
                 ' ' + (l.vendor || '(no vendor)') +
                 ' | ' + (l.account || '(no account)') +
                 (l.klass ? ' | ' + l.klass : '') +
                 memo + linked;
        }).join('\n');
        return header + '\n' + body;
      }

      case 'assign_qb_line': {
        // Server is the source of truth for QB lines (Phase 2 schema).
        // Optimistic local update + PATCH; the next hydration on /chat
        // /continue rebuild reflects the canonical state.
        // Same id-or-label fallback as wire_nodes for the node side.
        var jid2 = (window.appState && appState.currentJobId) || null;
        var graphs2 = jid2 ? JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}') : {};
        var nodes2 = (jid2 && graphs2[jid2] && graphs2[jid2].nodes) || [];
        var resolvedNodeId = input.node_id;
        var nMatch = nodes2.find(function(n) { return n.id === input.node_id; });
        if (!nMatch) {
          var lower2 = String(input.node_id || '').trim().toLowerCase();
          var byLabel = nodes2.find(function(n) { return (n.label || '').trim().toLowerCase() === lower2; });
          if (byLabel) resolvedNodeId = byLabel.id;
        }
        var lines = (window.appData && appData.qbCostLines) || [];
        var line = lines.find(function(l) { return l.id === input.line_id; });
        if (line) line.linked_node_id = resolvedNodeId;
        if (window.agxApi && window.agxApi.isAuthenticated && window.agxApi.isAuthenticated()) {
          window.agxApi.qbCosts.update(input.line_id, { linkedNodeId: resolvedNodeId }).catch(function(err) {
            console.warn('[ai] assign_qb_line server patch failed:', err && err.message);
          });
        }
        return 'Linked QB line ' + input.line_id + ' → node ' + resolvedNodeId;
      }

      default:
        throw new Error('Unknown job tool: ' + tu.name);
    }
  }

  // Inline confirmation chip — used when a server-side auto-tier tool
  // applies during the stream, so the user sees what happened without
  // needing an approval card.
  function appendToolChip(streamDiv, glyph, text, color) {
    if (!streamDiv) return;
    var chip = document.createElement('div');
    chip.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;padding:5px 9px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-left:3px solid ' + color + ';border-radius:4px;font-size:11px;color:var(--text-dim,#aaa);';
    chip.innerHTML = '<span style="color:' + color + ';font-weight:700;">' + glyph + '</span><span style="flex:1;">' + escapeHTMLLocal(text) + '</span>';
    streamDiv.appendChild(chip);
  }

  function continueAfterProposals(pendingContent, responses) {
    var body = { pending_assistant_content: pendingContent, tool_results: responses };
    // Job mode: re-attach the latest clientContext so the assistant
    // sees fresh state after the user-applied changes (e.g. updated
    // pctComplete reflects in the next reply).
    if (isJobMode()) {
      var ctx = buildJobClientContext();
      if (ctx) body.clientContext = ctx;
    }
    streamFromEndpoint(apiBase() + '/chat/continue', body);
  }

  // Card rendering — one per tool_use block, formatted by tool type.
  function renderProposalCard(tu) {
    var card = document.createElement('div');
    card.style.cssText = 'background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-left:3px solid #4f8cff;border-radius:6px;padding:10px 12px;';

    var heading = '';
    var detail = '';
    var input = tu.input || {};

    if (tu.name === 'propose_add_line_item') {
      heading = '&#x2795; Add line item';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.description || '') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;font-family:\'SF Mono\',monospace;">' +
          'qty ' + escapeHTMLLocal(String(input.qty)) + ' ' + escapeHTMLLocal(input.unit || 'ea') +
          ' @ $' + Number(input.unit_cost || 0).toFixed(2) +
          (input.markup_pct != null ? ' &middot; markup ' + input.markup_pct + '%' : '') +
        '</div>' +
        (input.section_name ? '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:3px;">section: ' + escapeHTMLLocal(input.section_name) + '</div>' : '');
    } else if (tu.name === 'propose_add_section') {
      heading = '&#x2795; Add section';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        (input.bt_category ? '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:3px;">BT category: ' + escapeHTMLLocal(input.bt_category) + '</div>' : '');
    } else if (tu.name === 'propose_update_scope') {
      heading = '&#x270F; Update scope (' + (input.mode || 'replace') + ')';
      var preview = (input.scope_text || '').slice(0, 280);
      if ((input.scope_text || '').length > 280) preview += '…';
      detail = '<pre style="white-space:pre-wrap;font-family:inherit;font-size:12px;margin:4px 0 0;color:var(--text,#ccc);background:rgba(0,0,0,0.2);padding:8px;border-radius:4px;max-height:160px;overflow-y:auto;">' + escapeHTMLLocal(preview) + '</pre>';
    } else if (tu.name === 'propose_delete_line_item') {
      heading = '&#x1F5D1; Delete line';
      detail = '<div style="font-size:10px;color:var(--text-dim,#888);font-family:monospace;">line: ' + escapeHTMLLocal(input.line_id || '') + '</div>';
    } else if (tu.name === 'propose_update_line_item') {
      heading = '&#x270F; Update line';
      var changes = [];
      if (input.description != null) changes.push('description → "' + input.description + '"');
      if (input.qty != null) changes.push('qty → ' + input.qty);
      if (input.unit != null) changes.push('unit → ' + input.unit);
      if (input.unit_cost != null) changes.push('unit cost → $' + Number(input.unit_cost).toFixed(2));
      if (input.markup_pct != null) changes.push('markup → ' + input.markup_pct + '%');
      else if (Object.prototype.hasOwnProperty.call(input, 'markup_pct')) changes.push('clear markup override');
      if (input.section_name) changes.push('move to section "' + input.section_name + '"');
      detail = (changes.length
        ? '<div style="font-size:12px;color:var(--text,#ccc);">' + escapeHTMLLocal(changes.join(' · ')) + '</div>'
        : '<div style="font-size:11px;color:var(--text-dim,#888);font-style:italic;">no fields specified</div>') +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;font-family:monospace;">line: ' + escapeHTMLLocal(input.line_id || '') + '</div>';
    } else if (tu.name === 'propose_delete_section') {
      heading = '&#x1F5D1; Delete section';
      detail = '<div style="font-size:11px;color:var(--text-dim,#aaa);">Lines under this section stay; they fall under whichever header now precedes them.</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;font-family:monospace;">section: ' + escapeHTMLLocal(input.section_id || '') + '</div>';
    } else if (tu.name === 'propose_update_section') {
      heading = '&#x270F; Update section';
      var sChanges = [];
      if (input.name != null) sChanges.push('rename → "' + input.name + '"');
      if (input.bt_category != null) sChanges.push('BT category → ' + input.bt_category);
      if (input.markup_pct != null) sChanges.push('markup → ' + input.markup_pct + '%');
      else if (Object.prototype.hasOwnProperty.call(input, 'markup_pct')) sChanges.push('clear markup');
      detail = (sChanges.length
        ? '<div style="font-size:12px;color:var(--text,#ccc);">' + escapeHTMLLocal(sChanges.join(' · ')) + '</div>'
        : '<div style="font-size:11px;color:var(--text-dim,#888);font-style:italic;">no fields specified</div>') +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;font-family:monospace;">section: ' + escapeHTMLLocal(input.section_id || '') + '</div>';
    } else if (tu.name === 'create_parent_company') {
      heading = '&#x1F3E2; New parent company';
      detail = '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        (input.notes ? '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">' + escapeHTMLLocal(input.notes) + '</div>' : '');
    } else if (tu.name === 'rename_client') {
      heading = '&#x270F; Rename client';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">→ <strong>' + escapeHTMLLocal(input.new_name || '') + '</strong></div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">id: ' + escapeHTMLLocal(input.client_id || '') + '</div>';
    } else if (tu.name === 'change_property_parent') {
      heading = '&#x21B7; Change parent';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">' +
        (input.new_parent_client_id ? 'New parent id: <code>' + escapeHTMLLocal(input.new_parent_client_id) + '</code>' : 'Detach (no parent)') +
        '</div><div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">property: ' + escapeHTMLLocal(input.property_client_id || '') + '</div>';
    } else if (tu.name === 'merge_clients') {
      heading = '&#x1F500; Merge duplicates';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Keep <code>' + escapeHTMLLocal(input.keep_client_id || '') + '</code></div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);">Fold in <code>' + escapeHTMLLocal(input.merge_from_client_id || '') + '</code></div>';
    } else if (tu.name === 'split_client_into_parent_and_property') {
      heading = '&#x2702; Split client';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Parent: <strong>' + escapeHTMLLocal(input.new_parent_name || '') + '</strong>' +
        (input.existing_parent_id ? ' <span style="color:var(--text-dim,#888);">(reuse existing)</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);">Property: <strong>' + escapeHTMLLocal(input.new_property_name || '') + '</strong></div>';
    } else if (tu.name === 'delete_client') {
      heading = '&#x1F5D1; Delete client';
      detail = '<div style="font-size:12px;color:#f87171;font-family:monospace;">id: ' + escapeHTMLLocal(input.client_id || '') + '</div>';
    } else if (tu.name === 'attach_business_card_to_client') {
      heading = '&#x1F4CE; Attach business card';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Save the most recent uploaded photo to this client\'s attachments.</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">client: ' + escapeHTMLLocal(input.client_id || '') + '</div>' +
        (input.caption ? '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">Caption: ' + escapeHTMLLocal(input.caption) + '</div>' : '');
    } else if (tu.name === 'read_workspace_sheet_full') {
      // Read-only — the auto-apply intercept normally renders this as
      // a chip without a card. This case is a safety net for older
      // cached clients that miss the intercept; user can still click
      // Approve and the apply path returns the sheet content.
      heading = '&#x1F4D6; Read full sheet';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.sheet_name || '(unspecified)') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:3px;">Read-only — returns the full sheet contents to the assistant for analysis.</div>';
    } else if (tu.name === 'set_phase_pct_complete') {
      // Look up the target locally so the card shows where the change
      // is going + the prior pct. Try phase records first (preferred)
      // then fall back to a graph node lookup since the apply path
      // accepts both ids — keeps the preview in sync with reality.
      var ph = (window.appData && (appData.phases || []).find(function(p) { return p.id === input.phase_id; })) || null;
      var bldg = ph ? (appData.buildings || []).find(function(b) { return b.id === ph.buildingId; }) : null;
      var location, oldPct;
      if (ph) {
        location = (bldg ? bldg.name + ' › ' : '') + (ph.phase || ph.name || '(unnamed)');
        oldPct = Number(ph.pctComplete || 0);
      } else {
        var pcNodes = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
        var pcNode = pcNodes.find(function(n) { return n.id === input.phase_id; });
        if (pcNode) {
          location = escapeHTMLLocal(pcNode.label || pcNode.id) +
            ' <span style="font-size:11px;color:var(--text-dim,#888);font-weight:400;">(' + escapeHTMLLocal(pcNode.type) + ' node)</span>';
          oldPct = Number(pcNode.pctComplete || 0);
        } else {
          location = '<em style="color:#fbbf24;">id ' + escapeHTMLLocal(input.phase_id) + ' (not found locally)</em>';
          oldPct = null;
        }
      }
      heading = '&#x270F; Set phase % complete';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + location + '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);margin-top:3px;">' +
          (oldPct != null ? Math.round(oldPct) + '% &rarr; ' : '') +
          '<strong style="color:#34d399;">' + Math.round(Number(input.pct_complete || 0)) + '%</strong>' +
        '</div>';
    } else if (tu.name === 'set_phase_field') {
      var ph2 = (window.appData && (appData.phases || []).find(function(p) { return p.id === input.phase_id; })) || null;
      var bldg2 = ph2 ? (appData.buildings || []).find(function(b) { return b.id === ph2.buildingId; }) : null;
      var loc2 = ph2 ? ((bldg2 ? bldg2.name + ' › ' : '') + (ph2.phase || ph2.name || '(unnamed)')) : '<em style="color:#fbbf24;">phase id ' + escapeHTMLLocal(input.phase_id) + '</em>';
      var oldVal = ph2 ? Number(ph2[input.field] || 0) : null;
      var fmt = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
      heading = '&#x270F; Set phase ' + escapeHTMLLocal(input.field);
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + loc2 + '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);margin-top:3px;">' +
          escapeHTMLLocal(input.field) + ': ' +
          (oldVal != null ? fmt(oldVal) + ' &rarr; ' : '') +
          '<strong style="color:#34d399;">' + fmt(input.amount) + '</strong>' +
        '</div>';
    } else if (tu.name === 'set_node_value') {
      // Mirror the set_phase_field card so the user sees old → new
      // before approving. Look the node up in the same place the
      // applier will (live engine first, then localStorage).
      var liveNV = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : null;
      var nvJid = (window.appState && appState.currentJobId) || null;
      var nvNodes = (Array.isArray(liveNV) && liveNV.length)
        ? liveNV
        : (function() {
            try {
              var g = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
              return (nvJid && g[nvJid] && g[nvJid].nodes) || [];
            } catch (e) { return []; }
          })();
      var nvNode = nvNodes.find(function(n) { return n.id === input.node_id; });
      if (!nvNode) {
        var lowerNV = String(input.node_id || '').trim().toLowerCase();
        nvNode = nvNodes.find(function(n) { return (n.label || '').trim().toLowerCase() === lowerNV; });
      }
      var nvOld = nvNode ? Number(nvNode.value || 0) : null;
      var fmtNV = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
      heading = '&#x1F4B5; Set node value';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' +
          escapeHTMLLocal(nvNode ? (nvNode.label || nvNode.type) : input.node_id) +
          (nvNode ? ' <span style="font-size:11px;color:var(--text-dim,#888);font-weight:400;">(' + escapeHTMLLocal(nvNode.type) + ')</span>' : '') +
        '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);margin-top:3px;">' +
          'value: ' +
          (nvOld != null ? fmtNV(nvOld) + ' &rarr; ' : '') +
          '<strong style="color:#34d399;">' + fmtNV(input.amount) + '</strong>' +
        '</div>';
    } else if (tu.name === 'create_node') {
      var typeLabels = {
        t1: 'Building (T1)', t2: 'Phase (T2)',
        labor: 'Labor', mat: 'Materials', gc: 'Gen. Conditions',
        other: 'Other', burden: 'Direct Burden',
        sub: 'Subcontractor', po: 'Purchase Order', inv: 'Invoice',
        co: 'Change Order', watch: 'Watch', note: 'Note'
      };
      // Schema renamed `type` → `node_type`; legacy fallback kept.
      var cnType = input.node_type || input.type || '?';
      var cnFmt = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); };
      var meta = [];
      if (input.value != null) meta.push('value: ' + cnFmt(input.value));
      if (input.budget != null) meta.push('budget: ' + cnFmt(input.budget));
      if (input.pct_complete != null) meta.push('% complete: ' + Math.round(Number(input.pct_complete)) + '%');
      var attachInfo = '';
      if (input.attach_to_node_id) {
        var liveCN = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
        var attachN = liveCN.find(function(n) { return n.id === input.attach_to_node_id; });
        attachInfo = '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:4px;">' +
          '&rarr; wires to <strong>' + escapeHTMLLocal(attachN ? (attachN.label || attachN.id) : input.attach_to_node_id) + '</strong>' +
        '</div>';
      }
      heading = '&#x2795; Create node';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' +
          escapeHTMLLocal(input.label || '(unnamed)') +
          ' <span style="font-size:11px;color:var(--text-dim,#888);font-weight:400;">(' +
          escapeHTMLLocal(typeLabels[cnType] || cnType) + ')</span>' +
        '</div>' +
        (meta.length
          ? '<div style="font-size:12px;color:var(--text,#ccc);margin-top:3px;">' + escapeHTMLLocal(meta.join(' · ')) + '</div>'
          : '') +
        attachInfo;
    } else if (tu.name === 'delete_node') {
      // Look up the node so the card shows what's actually being
      // removed (label + type + wire count) instead of just the
      // raw id. Falls back to label-match like the apply path.
      var liveDel = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
      var liveDelW = (typeof NG !== 'undefined' && NG.wires) ? NG.wires() : [];
      var idDel = String(input.node_id || '');
      var nodeDel = liveDel.find(function(n) { return n.id === idDel; });
      if (!nodeDel) {
        var lowDel = idDel.trim().toLowerCase();
        nodeDel = liveDel.find(function(n) { return (n.label || '').trim().toLowerCase() === lowDel; });
      }
      var wireCount = 0;
      if (nodeDel) {
        liveDelW.forEach(function(w) {
          if (w.fromNode === nodeDel.id || w.toNode === nodeDel.id) wireCount++;
        });
      }
      heading = '&#x1F5D1; Delete node';
      detail = nodeDel
        ? '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' +
            escapeHTMLLocal(nodeDel.label || nodeDel.id) +
            ' <span style="font-size:11px;color:var(--text-dim,#888);font-weight:400;">(' + escapeHTMLLocal(nodeDel.type) + ')</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:4px;">' +
            wireCount + ' attached wire' + (wireCount === 1 ? '' : 's') +
            ' will be removed. Underlying job data preserved.' +
          '</div>'
        : '<div style="font-size:12px;color:#fbbf24;">Node "' + escapeHTMLLocal(idDel) + '" not found in current graph.</div>';
    } else if (tu.name === 'wire_nodes') {
      var graphs = {};
      try { graphs = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}'); } catch (e) {}
      var jid = (window.appState && appState.currentJobId) || null;
      var nodes = (jid && graphs[jid] && graphs[jid].nodes) || [];
      var fromN = nodes.find(function(n) { return n.id === input.from_node_id; });
      var toN = nodes.find(function(n) { return n.id === input.to_node_id; });
      heading = '&#x1F50C; Wire nodes';
      detail =
        '<div style="font-size:12px;color:var(--text,#ccc);">' +
          '<strong>' + escapeHTMLLocal(fromN ? (fromN.label || fromN.type) : input.from_node_id) + '</strong>' +
          ' &rarr; ' +
          '<strong>' + escapeHTMLLocal(toN ? (toN.label || toN.type) : input.to_node_id) + '</strong>' +
        '</div>';
    } else if (tu.name === 'assign_qb_line') {
      var lines = (window.appData && appData.qbCostLines) || [];
      var line = lines.find(function(l) { return l.id === input.line_id; });
      var graphs2 = {};
      try { graphs2 = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}'); } catch (e) {}
      var jid2 = (window.appState && appState.currentJobId) || null;
      var nodes2 = (jid2 && graphs2[jid2] && graphs2[jid2].nodes) || [];
      var nodeT = nodes2.find(function(n) { return n.id === input.node_id; });
      var fmt2 = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
      heading = '&#x1F517; Assign QB line';
      detail = line
        ? '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(line.vendor || '(no vendor)') + ' &middot; ' + fmt2(line.amount) + '</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:2px;">' + escapeHTMLLocal(line.account || '') + (line.memo ? ' &middot; ' + escapeHTMLLocal(String(line.memo).slice(0, 60)) : '') + '</div>' +
          '<div style="font-size:12px;color:var(--text,#ccc);margin-top:6px;">&rarr; <strong>' + escapeHTMLLocal(nodeT ? (nodeT.label || nodeT.type) : input.node_id) + '</strong></div>'
        : '<div style="font-size:12px;color:#fbbf24;">QB line not found locally — server still has it.</div>';
    } else {
      heading = '? Unknown tool: ' + tu.name;
      detail = '<pre style="font-size:11px;">' + escapeHTMLLocal(JSON.stringify(input, null, 2)) + '</pre>';
    }

    var rationale = input.rationale
      ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:6px;font-style:italic;border-top:1px dashed var(--border,#333);padding-top:6px;">' + escapeHTMLLocal(input.rationale) + '</div>'
      : '';

    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
        '<div style="font-size:11px;font-weight:700;color:#4f8cff;flex:1;text-transform:none;letter-spacing:normal;">' + heading + '</div>' +
        '<div data-card-status style="font-size:10px;font-weight:600;"></div>' +
      '</div>' +
      detail + rationale +
      '<div data-card-actions style="display:flex;gap:6px;margin-top:8px;">' +
        '<button data-card-approve class="success small" style="padding:4px 12px;font-size:11px;">&check; Approve</button>' +
        '<button data-card-reject class="ghost small" style="padding:4px 12px;font-size:11px;">&times; Reject</button>' +
      '</div>';

    return card;
  }

  function markCardDone(card, approved, summary) {
    var status = card.querySelector('[data-card-status]');
    var actions = card.querySelector('[data-card-actions]');
    if (actions) actions.remove();
    if (status) {
      status.style.color = approved ? '#34d399' : '#f87171';
      status.textContent = approved ? '✓ Applied' : '✗ Rejected';
    }
    card.style.opacity = approved ? '1' : '0.55';
    card.style.borderLeftColor = approved ? '#34d399' : '#f87171';
  }

  function isCardAnswered(card) {
    return !card.querySelector('[data-card-actions]');
  }

  function scrollToBottom() {
    var box = document.getElementById('ai-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  // Read SSE chunks from a fetch response. Delegates to onChunk for each
  // `data: ...\n\n` payload until `[DONE]`. SSE in JS without EventSource
  // is just newline-delimited parsing.
  function readSSEStream(response, onChunk) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function(result) {
        if (result.done) return;
        buffer += decoder.decode(result.value, { stream: true });
        var parts = buffer.split('\n\n');
        buffer = parts.pop(); // last is incomplete
        parts.forEach(function(part) {
          var line = part.replace(/^data: /, '').trim();
          if (!line || line === '[DONE]') return;
          try {
            var payload = JSON.parse(line);
            onChunk(payload);
          } catch (e) { /* ignore malformed chunk */ }
        });
        return pump();
      });
    }
    return pump();
  }

  function setSendDisabled(disabled) {
    var btn = document.getElementById('ai-send');
    if (btn) {
      btn.disabled = disabled;
      // Dim the paper-plane while a request is in flight.
      btn.style.opacity = disabled ? '0.45' : '1';
    }
    var input = document.getElementById('ai-input');
    if (input) input.disabled = disabled;
  }

  // ──────────────────────────────────────────────────────────────────
  // File attachments composer — + and 📷 buttons.
  //
  // Flow per mode:
  //   estimate / job / lead
  //     image  → upload to that entity's attachments (real persistence),
  //              chip in pill with view link, AI sees it via context
  //     pdf    → upload to entity attachments AND render pages client-side
  //              into _pendingImages so the AI can read them as vision
  //   client (Customer Relations Agent)
  //     image  → no persistence (no client_id chosen yet); send as
  //              one-shot inline vision image so the AI can read e.g.
  //              a business card. Future tool will let the agent attach
  //              the staged image to the client it identifies.
  //     pdf    → render pages, attach as one-shot vision images
  //
  // Pending uploads are cleared on send.
  // ──────────────────────────────────────────────────────────────────
  // Tracks pending composer attachments — the chips currently visible in
  // the pill. Each entry: {id, kind:'image'|'pdf', filename, attachmentId?,
  // viewUrl?, base64Images:[]}
  var _pendingComposer = [];

  function setupFileAttachments(panel) {
    var attachBtn = panel.querySelector('#ai-attach');
    var cameraBtn = panel.querySelector('#ai-camera');
    var fileInput = panel.querySelector('#ai-file-input');
    var cameraInput = panel.querySelector('#ai-camera-input');
    if (!attachBtn || !fileInput) return;

    attachBtn.onclick = function() { fileInput.value = ''; fileInput.click(); };
    if (cameraBtn && cameraInput) {
      cameraBtn.onclick = function() { cameraInput.value = ''; cameraInput.click(); };
      cameraInput.onchange = function(e) { handleSelectedFiles(e.target.files); };
    }
    fileInput.onchange = function(e) { handleSelectedFiles(e.target.files); };
  }

  function handleSelectedFiles(fileList) {
    if (!fileList || !fileList.length) return;
    var files = Array.from(fileList);
    files.forEach(function(file) {
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      var isPdf = file.type === 'application/pdf' || ext === 'pdf';
      var isImage = !!(file.type && file.type.indexOf('image/') === 0) || /^(jpe?g|png|gif|webp|heic)$/.test(ext);
      if (!isPdf && !isImage) {
        alert('Unsupported file type: ' + file.name + '. Use an image or PDF.');
        return;
      }
      var entry = {
        id: 'pa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        kind: isPdf ? 'pdf' : 'image',
        filename: file.name,
        sizeBytes: file.size,
        status: 'processing',
        attachmentId: null,
        viewUrl: null,
        base64Images: []
      };
      _pendingComposer.push(entry);
      renderAttachmentsStrip();
      processFile(entry, file);
    });
  }

  function processFile(entry, file) {
    var supportsAttach = (_entityType === 'estimate' || _entityType === 'job' || _entityType === 'lead') && _entityId && _entityId !== '__global__';
    var jobs = [];
    // 1. Persist to entity attachments where it makes sense.
    if (supportsAttach && window.agxApi && window.agxApi.attachments) {
      jobs.push(
        window.agxApi.attachments.upload(_entityType, _entityId, file).then(function(res) {
          var att = res.attachment || res;
          entry.attachmentId = att.id;
          entry.viewUrl = att.web_url || att.original_url || null;
        }).catch(function(err) {
          entry.uploadError = err.message || 'Upload failed';
        })
      );
    }
    // 2. For PDFs, render pages client-side so the AI can see them this turn.
    if (entry.kind === 'pdf') {
      jobs.push(renderPdfFileToBase64(file).then(function(images) {
        entry.base64Images = images;
      }).catch(function(err) {
        entry.uploadError = err.message || 'PDF render failed';
      }));
    } else if (entry.kind === 'image') {
      // For images we ALSO push the raw bytes inline as one-shot vision so
      // the AI sees the just-uploaded photo without waiting for the next
      // round of context loading. (For estimate/job/lead it'll also come
      // in via the entity context; for client mode it's the only path.)
      jobs.push(fileToBase64(file).then(function(b64) {
        entry.base64Images = [b64];
      }).catch(function(err) {
        entry.uploadError = err.message || 'Image read failed';
      }));
    }
    Promise.all(jobs).then(function() {
      entry.status = entry.uploadError ? 'error' : 'ready';
      renderAttachmentsStrip();
    });
  }

  function fileToBase64(file) {
    return new Promise(function(resolve, reject) {
      var fr = new FileReader();
      fr.onload = function() {
        var s = String(fr.result || '');
        var i = s.indexOf('base64,');
        resolve(i >= 0 ? s.slice(i + 7) : s);
      };
      fr.onerror = function() { reject(new Error('Could not read file')); };
      fr.readAsDataURL(file);
    });
  }

  function renderPdfFileToBase64(file) {
    if (!window.pdfjsLib) return Promise.reject(new Error('PDF library not loaded'));
    return file.arrayBuffer().then(function(buf) {
      return window.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function(pdf) {
      var pageCount = Math.min(pdf.numPages, 10);
      var promises = [];
      for (var i = 1; i <= pageCount; i++) {
        promises.push(pdf.getPage(i).then(function(page) {
          var viewport = page.getViewport({ scale: 1.5 });
          var canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          var ctx = canvas.getContext('2d');
          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function() {
            var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            return dataUrl.slice(dataUrl.indexOf('base64,') + 7);
          });
        }));
      }
      return Promise.all(promises);
    });
  }

  function renderAttachmentsStrip() {
    var strip = document.getElementById('ai-attachments-strip');
    if (!strip) return;
    if (!_pendingComposer.length) {
      strip.style.display = 'none';
      strip.innerHTML = '';
      return;
    }
    strip.style.display = 'flex';
    strip.innerHTML = '';
    _pendingComposer.forEach(function(e) {
      var glyph = e.kind === 'pdf' ? '📄' : '🖼';
      var status = e.status === 'processing'
        ? '<span style="color:var(--text-dim,#888);font-size:10px;">processing…</span>'
        : (e.status === 'error'
          ? '<span style="color:#f87171;font-size:10px;">' + escapeHTMLLocal(e.uploadError || 'failed') + '</span>'
          : '<span style="color:#34d399;font-size:10px;">ready</span>');
      var chip = document.createElement('div');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-radius:12px;font-size:11px;color:var(--text,#ddd);';
      chip.innerHTML =
        '<span style="font-size:13px;">' + glyph + '</span>' +
        '<span style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTMLLocal(e.filename) + '</span>' +
        status +
        (e.viewUrl ? '<a href="' + e.viewUrl + '" target="_blank" rel="noopener" title="Open" style="color:#4f8cff;text-decoration:none;font-size:11px;">↗</a>' : '') +
        '<button data-remove="' + e.id + '" title="Remove" style="background:transparent;border:none;color:var(--text-dim,#888);cursor:pointer;font-size:13px;padding:0 2px;line-height:1;">×</button>';
      strip.appendChild(chip);
    });
    strip.querySelectorAll('[data-remove]').forEach(function(b) {
      b.onclick = function() {
        var id = b.getAttribute('data-remove');
        _pendingComposer = _pendingComposer.filter(function(e) { return e.id !== id; });
        renderAttachmentsStrip();
      };
    });
  }

  // Web Speech API mic wiring. Toggles dictation on/off; appends each
  // final transcript chunk to the textarea so the user can see what the
  // browser heard before sending. Hides the mic button on browsers that
  // don't support SpeechRecognition (Firefox without flags).
  var _recognition = null;
  var _isListening = false;
  function setupVoiceInput(panel) {
    var micBtn = panel.querySelector('#ai-mic');
    if (!micBtn) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtn.style.display = 'none';
      return;
    }
    micBtn.onclick = function() {
      if (_isListening) { stopListening(); return; }
      startListening();
    };
    function startListening() {
      try {
        _recognition = new SR();
        _recognition.continuous = true;
        _recognition.interimResults = true;
        _recognition.lang = navigator.language || 'en-US';
        var baseValue = '';
        _recognition.onstart = function() {
          _isListening = true;
          var input = document.getElementById('ai-input');
          baseValue = input ? input.value : '';
          if (baseValue && !/\s$/.test(baseValue)) baseValue += ' ';
          micBtn.style.background = 'rgba(248,113,113,0.18)';
          micBtn.style.color = '#f87171';
          micBtn.title = 'Stop dictation';
        };
        _recognition.onresult = function(e) {
          var final = '';
          var interim = '';
          for (var i = e.resultIndex; i < e.results.length; i++) {
            var t = e.results[i][0].transcript;
            if (e.results[i].isFinal) final += t;
            else interim += t;
          }
          var input = document.getElementById('ai-input');
          if (input) {
            input.value = baseValue + final + interim;
            input.dispatchEvent(new Event('input'));
            if (final) baseValue += final;
          }
        };
        _recognition.onerror = function(ev) {
          stopListening();
          if (ev && ev.error === 'not-allowed') {
            alert('Microphone access denied. Allow it in your browser settings to dictate.');
          }
        };
        _recognition.onend = function() { stopListening(); };
        _recognition.start();
      } catch (e) {
        alert('Could not start dictation: ' + (e.message || e));
        stopListening();
      }
    }
    function stopListening() {
      if (_recognition) {
        try { _recognition.stop(); } catch (e) { /* ignore */ }
        _recognition = null;
      }
      _isListening = false;
      micBtn.style.background = 'transparent';
      micBtn.style.color = 'var(--text-dim,#888)';
      micBtn.title = 'Dictate (voice → text)';
    }
  }

  function countCurrentPhotos() {
    // Best effort — we don't track photo state here, but we can read it
    // off the editor's currently-open list. The server is authoritative.
    if (!_estimateId) return 0;
    return 0; // placeholder; the count chip is informational only
  }

  // CSS for the cursor blink + body shift — appended once
  if (!document.getElementById('agx-ai-css')) {
    var style = document.createElement('style');
    style.id = 'agx-ai-css';
    style.textContent =
      '@keyframes agx-blink { from, to { opacity: 1; } 50% { opacity: 0; } } ' +
      '@keyframes agx-mic-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } } ' +
      '.ai-content p:first-child { margin-top: 0; } ' +
      '.ai-content p:last-child { margin-bottom: 0; } ' +
      // Hide scrollbar entirely on the input textarea — it grows up to its
      // cap, beyond which arrow keys still navigate. No visible chrome.
      '#ai-input { scrollbar-width: none; -ms-overflow-style: none; } ' +
      '#ai-input::-webkit-scrollbar { display: none; width: 0; height: 0; } ' +
      // Ghost scrollbars on the messages area + presets — dark, narrow,
      // only visible while actively scrolling.
      '#agx-ai-panel ::-webkit-scrollbar { width: 6px; height: 6px; } ' +
      '#agx-ai-panel ::-webkit-scrollbar-track { background: transparent; } ' +
      '#agx-ai-panel ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 3px; transition: background 0.2s; } ' +
      '#agx-ai-panel ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.14); } ' +
      '#agx-ai-panel { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.06) transparent; } ' +
      '#ai-mic:hover { background: rgba(255,255,255,0.08) !important; color: var(--text,#fff) !important; } ' +
      '#ai-attach:hover { background: rgba(255,255,255,0.08) !important; color: var(--text,#fff) !important; } ' +
      '#ai-camera:hover { background: rgba(255,255,255,0.08) !important; color: var(--text,#fff) !important; } ' +
      '#ai-send:hover:not(:disabled) { background: rgba(79,140,255,0.32) !important; } ' +
      // When the panel is open, push the entire page over so the editor
      // stays fully visible. Sticky elements (page nav, editor header)
      // respect this since they sit in the document flow. The fixed
      // panel itself stays at right:0 since fixed-position elements
      // ignore body padding.
      'body.agx-ai-open { padding-right: 420px; transition: padding-right 0.22s ease; } ' +
      // On narrow screens fall back to the overlay behavior — no point
      // shoving a tablet's content into a 200px column.
      '@media (max-width: 1100px) { body.agx-ai-open { padding-right: 0; } }';
    document.head.appendChild(style);
  }

  // One-shot inline images attached to the next message. Set by
  // openWithImages(); cleared after the next sendMessage so the images
  // don't ride along on every subsequent turn.
  var _pendingImages = null;

  // Open the panel for an entity AND attach a one-shot batch of images
  // (e.g., rendered PDF pages from the viewer) to the next outgoing
  // message. Used by the PDF viewer's "Ask AI" button.
  function openWithImages(opts) {
    opts = opts || {};
    if (!opts.entityType || !opts.entityId) {
      alert('Open an estimate or lead first.');
      return;
    }
    if (Array.isArray(opts.images) && opts.images.length) {
      _pendingImages = {
        images: opts.images.slice(0, 12), // hard cap matches Anthropic per-request limit
        note: opts.imagesNote || null
      };
    }
    open({ entityType: opts.entityType, entityId: opts.entityId });
    if (opts.prefill) {
      setTimeout(function() {
        var input = document.getElementById('ai-input');
        if (input) {
          input.value = opts.prefill;
          // Trigger auto-grow by dispatching an input event
          input.dispatchEvent(new Event('input'));
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }, 260);
    }
  }

  window.agxAI = {
    open: open,
    openWithImages: openWithImages,
    close: close,
    toggle: toggle,
    isOpen: function() { return _open; }
  };

  // Sticky-header shim mirroring openEstimateAI() — finds the active job id
  // from the workspace state and opens the panel against it. Lives here so
  // wip.js doesn't need to know about agxAI's internals.
  window.openJobAI = function() {
    var jobId = (window.appState && window.appState.currentJobId) || null;
    if (!jobId) { alert('Open a job first.'); return; }
    open({ entityType: 'job', entityId: jobId });
  };

  // Client-directory entry point. No entity ID — the directory IS the
  // context. Pages that want a refresh after the assistant changes things
  // can register window.refreshClientsAfterAI.
  window.openClientAI = function() {
    open({ entityType: 'client' });
  };
})();
