// Connectivity & completeness audit for the active job.
//
// Walks appData + the node graph + qb cost lines through a small set
// of rules and surfaces what's disconnected, missing, or drifting.
// Each finding has a severity (high / med / low) and an optional
// jump-to-node id so the user can act on it inline.
//
// Triggered by the ⚠ Audit button on the node graph topbar; the
// badge count reflects high+med findings (low items are nudges,
// not problems).

(function() {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────
  function fmtMoney(n) {
    var v = Number(n || 0);
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

  // ── Build the audit context ──────────────────────────────────
  // Pulls everything the rules need from appData + localStorage in
  // one pass so individual rules stay simple.
  function buildContext(jobId) {
    var job = (window.appData && (appData.jobs || []).find(function(j) { return j.id === jobId; })) || null;
    var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
    var phases = (appData.phases || []).filter(function(p) { return p.jobId === jobId; });
    var subs = (appData.subs || []).filter(function(s) { return s.jobId === jobId; });
    var changeOrders = (appData.changeOrders || []).filter(function(c) { return c.jobId === jobId; });
    var purchaseOrders = (appData.purchaseOrders || []).filter(function(p) { return p.jobId === jobId; });
    var invoices = (appData.invoices || []).filter(function(i) { return i.jobId === jobId; });
    var qbLines = (appData.qbCostLines || []).filter(function(l) { return (l.job_id || l.jobId) === jobId; });

    var graph = { nodes: [], wires: [] };
    try {
      var graphs = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
      var g = graphs[jobId];
      if (g) {
        graph.nodes = g.nodes || [];
        graph.wires = g.wires || [];
      }
    } catch (e) {}

    // Pre-compute connectivity hints on graph nodes
    var hasIncoming = {};
    var hasOutgoing = {};
    graph.wires.forEach(function(w) {
      hasIncoming[w.toNode] = true;
      hasOutgoing[w.fromNode] = true;
    });

    // Pre-compute WIP if available — used by margin drift rule
    var wip = null;
    if (typeof window.computeJobWIP === 'function') {
      try { wip = window.computeJobWIP(job, buildings, phases, changeOrders, subs, invoices); } catch (e) {}
    }

    return {
      jobId: jobId,
      job: job,
      buildings: buildings,
      phases: phases,
      subs: subs,
      changeOrders: changeOrders,
      purchaseOrders: purchaseOrders,
      invoices: invoices,
      qbLines: qbLines,
      graph: graph,
      hasIncoming: hasIncoming,
      hasOutgoing: hasOutgoing,
      wip: wip
    };
  }

  // ── Rules ────────────────────────────────────────────────────
  // Each rule is a function that takes ctx and returns an array of
  // findings: { severity: 'high'|'med'|'low', title, detail, nodeId? }
  var RULES = [
    // R1: phases with cost/budget but no %complete entered
    function(ctx) {
      return ctx.phases
        .filter(function(p) {
          var hasCost = Number(p.materials || 0) + Number(p.labor || 0) + Number(p.sub || 0) > 0;
          var hasBudget = Number(p.phaseBudget || 0) > 0;
          var noPct = !p.pctComplete || Number(p.pctComplete) <= 0;
          return (hasCost || hasBudget) && noPct;
        })
        .map(function(p) {
          var bldg = ctx.buildings.find(function(b) { return b.id === p.buildingId; });
          return {
            severity: 'high',
            title: 'Phase missing % complete',
            detail: (bldg ? bldg.name + ' › ' : '') + (p.phase || p.name || '(unnamed phase)') +
              ' has costs/budget recorded but % complete is 0. Revenue earned will read $0 for this phase.'
          };
        });
    },

    // R2: orphan phases (no building)
    function(ctx) {
      return ctx.phases
        .filter(function(p) { return !p.buildingId; })
        .map(function(p) {
          return {
            severity: 'med',
            title: 'Phase has no parent building',
            detail: (p.phase || p.name || '(unnamed)') + ' is not attached to any building. It won\'t roll up into building totals.'
          };
        });
    },

    // R3: empty buildings (no phases)
    function(ctx) {
      var withPhases = {};
      ctx.phases.forEach(function(p) { if (p.buildingId) withPhases[p.buildingId] = true; });
      return ctx.buildings
        .filter(function(b) { return !withPhases[b.id]; })
        .map(function(b) {
          return {
            severity: 'low',
            title: 'Building has no phases',
            detail: (b.name || '(unnamed)') + ' is in the structure but has no phases — costs and progress can\'t be tracked here yet.'
          };
        });
    },

    // R4: cost-side graph nodes that aren't wired into the cost flow
    function(ctx) {
      var costTypes = { sub: 1, t1: 1, t2: 1, co: 1, po: 1, inv: 1 };
      return ctx.graph.nodes
        .filter(function(n) {
          if (!costTypes[n.type]) return false;
          return !ctx.hasIncoming[n.id] && !ctx.hasOutgoing[n.id];
        })
        .map(function(n) {
          return {
            severity: 'med',
            title: 'Node disconnected in graph',
            detail: '"' + (n.label || n.type) + '" (' + n.type + ') has no wires — it\'s not contributing to the WIP rollup.',
            nodeId: n.id
          };
        });
    },

    // R5: QB cost lines not linked to any node — sample + total
    function(ctx) {
      var unlinked = ctx.qbLines.filter(function(l) { return !l.linked_node_id && !l.linkedNodeId; });
      if (!unlinked.length) return [];
      var total = unlinked.reduce(function(s, l) { return s + Number(l.amount || 0); }, 0);
      var top = unlinked.slice().sort(function(a, b) { return Number(b.amount || 0) - Number(a.amount || 0); }).slice(0, 5);
      var preview = top.map(function(l) {
        return '• ' + fmtMoney(l.amount) + ' ' + (l.vendor || '(no vendor)') + (l.account ? ' [' + l.account + ']' : '');
      }).join('<br>');
      return [{
        severity: total > 5000 ? 'high' : 'med',
        title: unlinked.length + ' QB cost line' + (unlinked.length === 1 ? '' : 's') + ' unlinked',
        detail: fmtMoney(total) + ' of QuickBooks costs aren\'t assigned to any node in the graph. Top 5:<br>' + preview,
        action: { label: 'Open Detailed', target: 'tab:job-qb-costs' }
      }];
    },

    // R6: POs without a wire in the graph
    function(ctx) {
      var poNodes = ctx.graph.nodes.filter(function(n) { return n.type === 'po'; });
      var orphan = poNodes.filter(function(n) { return !ctx.hasIncoming[n.id] && !ctx.hasOutgoing[n.id]; });
      return orphan.map(function(n) {
        return {
          severity: 'med',
          title: 'Purchase order node disconnected',
          detail: '"' + (n.label || n.type) + '" PO is in the graph but not wired — its amount isn\'t flowing into actual costs.',
          nodeId: n.id
        };
      });
    },

    // R7: Invoices without a wire
    function(ctx) {
      var invNodes = ctx.graph.nodes.filter(function(n) { return n.type === 'inv'; });
      var orphan = invNodes.filter(function(n) { return !ctx.hasIncoming[n.id] && !ctx.hasOutgoing[n.id]; });
      return orphan.map(function(n) {
        return {
          severity: 'low',
          title: 'Invoice node disconnected',
          detail: '"' + (n.label || n.type) + '" invoice has no wires — it isn\'t reducing your unbilled balance.',
          nodeId: n.id
        };
      });
    },

    // R8: Margin drift — JTD vs revised
    function(ctx) {
      if (!ctx.wip) return [];
      var revised = Number(ctx.wip.revisedMargin || 0);
      var jtd = Number(ctx.wip.jtdMargin || 0);
      if (Math.abs(revised - jtd) < 5) return [];
      return [{
        severity: Math.abs(revised - jtd) > 10 ? 'high' : 'med',
        title: 'Margin drift: ' + Math.abs(revised - jtd).toFixed(1) + ' points',
        detail: 'Revised margin is ' + revised.toFixed(1) + '%, JTD is ' + jtd.toFixed(1) + '%. Either costs are running over or revenue is mis-pulled.'
      }];
    },

    // R9: Subs in directory assigned to this job but with no graph node
    function(ctx) {
      // Per-job inline subs that aren't represented as nodes
      var graphSubLabels = {};
      ctx.graph.nodes.filter(function(n) { return n.type === 'sub'; }).forEach(function(n) {
        graphSubLabels[(n.label || '').toLowerCase()] = true;
      });
      var missing = ctx.subs.filter(function(s) {
        if (!s.name) return false;
        return !graphSubLabels[s.name.toLowerCase()];
      });
      if (!missing.length) return [];
      return [{
        severity: 'low',
        title: missing.length + ' sub' + (missing.length === 1 ? '' : 's') + ' not represented in graph',
        detail: 'Job has ' + missing.length + ' sub assignment' + (missing.length === 1 ? '' : 's') +
          ' (' + missing.slice(0, 5).map(function(s) { return s.name; }).join(', ') + (missing.length > 5 ? ', …' : '') +
          ') but no matching graph nodes. They aren\'t contributing to the WIP rollup visualization.'
      }];
    },

    // R10: Unbilled balance way ahead of invoiced
    function(ctx) {
      if (!ctx.wip) return [];
      var unbilled = Number(ctx.wip.unbilled || 0);
      var earned = Number(ctx.wip.revenueEarned || 0);
      if (earned <= 0) return [];
      var pct = unbilled / earned;
      if (pct < 0.25) return [];
      return [{
        severity: pct > 0.5 ? 'high' : 'med',
        title: 'Underbilled: ' + Math.round(pct * 100) + '% of earned revenue not yet invoiced',
        detail: fmtMoney(unbilled) + ' of revenue earned hasn\'t been invoiced yet. Send the next billing.'
      }];
    }
  ];

  // ── Run ──────────────────────────────────────────────────────
  function runAudit(jobId) {
    var ctx = buildContext(jobId);
    var findings = [];
    RULES.forEach(function(rule) {
      try {
        var hits = rule(ctx) || [];
        hits.forEach(function(h) { findings.push(h); });
      } catch (e) {
        console.warn('[audit] rule failed:', e);
      }
    });
    return { findings: findings, context: ctx };
  }

  function findingCount(jobId, severityFilter) {
    var r = runAudit(jobId);
    if (!severityFilter) return r.findings.length;
    return r.findings.filter(function(f) { return severityFilter.indexOf(f.severity) !== -1; }).length;
  }

  // ── Modal renderer ───────────────────────────────────────────
  function openAuditModal(jobId) {
    var existing = document.getElementById('jobAuditModal');
    if (existing) existing.remove();

    var result = runAudit(jobId);
    var bySeverity = { high: [], med: [], low: [] };
    result.findings.forEach(function(f) {
      (bySeverity[f.severity] || bySeverity.low).push(f);
    });

    var modal = document.createElement('div');
    modal.id = 'jobAuditModal';
    modal.className = 'modal active';
    modal.innerHTML = buildAuditHTML(result, bySeverity);
    document.body.appendChild(modal);

    modal.querySelector('[data-close]')?.addEventListener('click', function() { modal.remove(); });
    modal.querySelectorAll('[data-jump]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var nodeId = btn.getAttribute('data-jump');
        modal.remove();
        jumpToNode(nodeId);
      });
    });
    modal.querySelectorAll('[data-target]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var target = btn.getAttribute('data-target');
        modal.remove();
        if (target.indexOf('tab:') === 0) {
          var t = [].slice.call(document.querySelectorAll('.ws-right-tab')).find(function(x) {
            return x.dataset.panel === target.slice(4);
          });
          if (t) t.click();
        }
      });
    });
    modal.querySelectorAll('[data-ai]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var prompt = btn.getAttribute('data-ai');
        modal.remove();
        if (typeof window.openJobAI === 'function') window.openJobAI();
        // Stuff the prompt into the AI input after the panel renders
        setTimeout(function() {
          var input = document.getElementById('ai-input');
          if (input) input.value = prompt;
          input?.focus();
        }, 200);
      });
    });
  }

  function buildAuditHTML(result, bySeverity) {
    var headStat = function(label, value, color) {
      return '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;padding:8px 12px;">' +
        '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">' + label + '</div>' +
        '<div style="font-size:22px;font-weight:700;color:' + color + ';">' + value + '</div>' +
      '</div>';
    };

    var sectionHTML = function(title, color, list) {
      if (!list.length) return '';
      return '<div style="margin-bottom:18px;">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:' + color + ';margin-bottom:8px;">' +
          title + ' (' + list.length + ')' +
        '</div>' +
        list.map(function(f) {
          var actions = '';
          if (f.nodeId) {
            actions += '<button class="ee-btn secondary" style="font-size:11px;padding:3px 10px;" data-jump="' + escapeAttr(f.nodeId) + '">Find in graph &rarr;</button>';
          }
          if (f.action && f.action.target) {
            actions += '<button class="ee-btn secondary" style="font-size:11px;padding:3px 10px;" data-target="' + escapeAttr(f.action.target) + '">' + escapeHTML(f.action.label || 'Open') + ' &rarr;</button>';
          }
          var aiPrompt = 'I just ran an audit and found this: "' + f.title + ' — ' + (f.detail || '').replace(/<[^>]+>/g, '') + '". Walk me through how to fix it.';
          actions += '<button class="ee-btn ghost" style="font-size:11px;padding:3px 10px;" data-ai="' + escapeAttr(aiPrompt) + '">&#x2728; Ask AI</button>';
          return '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;padding:10px 12px;margin-bottom:8px;">' +
            '<div style="font-weight:600;font-size:13px;margin-bottom:4px;color:' + color + ';">' + escapeHTML(f.title) + '</div>' +
            '<div style="font-size:12px;color:var(--text-dim,#aaa);margin-bottom:8px;line-height:1.45;">' + (f.detail || '') + '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + actions + '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    };

    var emptyState = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);">' +
      '<div style="font-size:36px;margin-bottom:8px;">&#x1F389;</div>' +
      '<div style="font-weight:600;font-size:15px;margin-bottom:4px;color:#34d399;">All clear</div>' +
      '<div style="font-size:13px;">No connectivity or completeness issues found on this job.</div>' +
    '</div>';

    var body;
    if (!result.findings.length) {
      body = emptyState;
    } else {
      body = sectionHTML('🔴 High priority', '#f87171', bySeverity.high) +
             sectionHTML('🟡 Worth checking', '#fbbf24', bySeverity.med) +
             sectionHTML('🟢 Low priority', '#34d399', bySeverity.low);
    }

    return '<div class="modal-content" style="max-width:720px;width:92vw;max-height:90vh;display:flex;flex-direction:column;">' +
      '<div class="modal-header" style="display:flex;align-items:center;gap:10px;">' +
        '<span>&#x26A0; Job Audit</span>' +
        '<span style="font-size:11px;color:var(--text-dim,#888);font-weight:normal;">' + (result.context.job?.title || '') + '</span>' +
      '</div>' +
      '<div style="padding:14px 18px 0;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">' +
        headStat('Total findings', result.findings.length, result.findings.length > 0 ? '#fbbf24' : '#34d399') +
        headStat('High', bySeverity.high.length, bySeverity.high.length > 0 ? '#f87171' : '#34d399') +
        headStat('Med', bySeverity.med.length, '#fbbf24') +
        headStat('Low', bySeverity.low.length, '#34d399') +
      '</div>' +
      '<div style="padding:14px 18px;overflow-y:auto;flex:1;">' + body + '</div>' +
      '<div class="action-buttons" style="margin:0;padding:12px 18px;border-top:1px solid var(--border,#333);">' +
        '<button class="ee-btn primary" data-close style="margin-left:auto;">Close</button>' +
      '</div>' +
    '</div>';
  }

  // Best-effort jump: select the node + center the canvas on it
  function jumpToNode(nodeId) {
    if (typeof NG === 'undefined' || !NG.zm || !NG.pan) return;
    try {
      var graphs = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
      var jobId = (window.appState && appState.currentJobId) || null;
      if (!jobId) return;
      var node = (graphs[jobId]?.nodes || []).find(function(n) { return n.id === nodeId; });
      if (!node) return;
      // Pan to center the node at zoom 1.0
      var area = document.querySelector('#nodeGraphTab .ng-canvas-area');
      var ar = area ? area.getBoundingClientRect() : { width: 1280, height: 720 };
      NG.zm(1.0);
      NG.pan(ar.width / 2 - (node.x + 100), ar.height / 2 - (node.y + 60));
      if (typeof window.ngApplyTx === 'function') window.ngApplyTx();
      if (typeof window.ngRender === 'function') window.ngRender();
    } catch (e) {}
  }

  // ── Public API ───────────────────────────────────────────────
  window.agxJobAudit = {
    run: runAudit,
    open: openAuditModal,
    findingCount: findingCount
  };
})();
