// ============================================================
// AGX Node Graph — Visual Cost Flow Editor (Beta) v2
// Simplified: 1 input port, 1 output port per node
// Wires drawn on canvas for reliable rendering
// ============================================================

(function () {
  'use strict';

  var nodes = [];
  var wires = [];
  var nextId = 1;
  var wrap, canvasEl, wireCanvas, wireCtx;
  var panX = 0, panY = 0, zoom = 1;
  var currentJobId = null;
  var draggingNode = null, dragOffset = { x: 0, y: 0 };
  var wiringFrom = null; // { nodeId }
  var wireMousePos = null;
  var selectedNode = null;
  var isPanning = false, panStart = { x: 0, y: 0 };

  var WIRE_COLORS = { data: '#4f8cff', cost: '#34d399', math: '#a78bfa', output: '#fbbf24' };

  var NODE_DEFS = {
    building:  { cat: 'data',   icon: '\u{1F3D7}',  label: 'Building' },
    phase:     { cat: 'data',   icon: '\u{1F4CB}',  label: 'Phase' },
    sub:       { cat: 'data',   icon: '\u{1F477}',  label: 'Sub' },
    co:        { cat: 'data',   icon: '\u{1F4DD}',  label: 'Change Order' },
    value:     { cat: 'cost',   icon: '\u{1F4B2}',  label: 'Value',     editable: true },
    materials: { cat: 'cost',   icon: '\u{1F9F1}',  label: 'Materials', editable: true },
    labor:     { cat: 'cost',   icon: '\u{1F6E0}',  label: 'Labor',     editable: true },
    equipment: { cat: 'cost',   icon: '\u{2699}',   label: 'Equipment', editable: true },
    gc:        { cat: 'cost',   icon: '\u{1F3E2}',  label: 'Gen. Cond.', editable: true },
    sum:       { cat: 'math',   icon: '\u{2211}',   label: 'SUM' },
    subtract:  { cat: 'math',   icon: '\u{2212}',   label: 'Subtract' },
    multiply:  { cat: 'math',   icon: '\u{00D7}',   label: 'Multiply' },
    percent:   { cat: 'math',   icon: '%',           label: 'Percent' },
    total:     { cat: 'output', icon: '\u{1F4CA}',   label: 'Total' },
    profit:    { cat: 'output', icon: '\u{1F4B0}',   label: 'Profit' },
    display:   { cat: 'output', icon: '\u{1F4CB}',   label: 'Display' }
  };

  // ── Helpers ──
  function genId() { return 'n' + (nextId++); }

  function createNode(type, x, y, label, data) {
    var def = NODE_DEFS[type];
    if (!def) return null;
    var n = {
      id: genId(), type: type, cat: def.cat,
      x: x, y: y,
      label: label || def.label,
      data: data || {},
      value: data && data._val != null ? data._val : 0
    };
    nodes.push(n);
    return n;
  }

  function findNode(id) { return nodes.find(function (n) { return n.id === id; }); }

  function getNodeValue(n) {
    var def = NODE_DEFS[n.type];
    if (!def) return 0;
    if (def.editable) return n.value || 0;

    // Data nodes: total from data
    if (n.cat === 'data' && n.data) {
      var d = n.data;
      if (n.type === 'building' || n.type === 'phase')
        return (d.materials || 0) + (d.labor || 0) + (d.sub || 0) + (d.equipment || 0);
      if (n.type === 'sub') return d.billedToDate || 0;
      if (n.type === 'co') return d.estimatedCosts || 0;
    }

    // Collect input values from connected wires
    var inputs = [];
    wires.forEach(function (w) {
      if (w.to === n.id) {
        var fromNode = findNode(w.from);
        if (fromNode) inputs.push(getNodeValue(fromNode));
      }
    });

    if (n.type === 'sum' || n.type === 'total') return inputs.reduce(function (s, v) { return s + v; }, 0);
    if (n.type === 'subtract') return (inputs[0] || 0) - (inputs[1] || 0);
    if (n.type === 'multiply') return (inputs[0] || 0) * (inputs[1] || 0);
    if (n.type === 'percent') return (inputs[0] || 0) * ((inputs[1] || 0) / 100);
    if (n.type === 'profit') return (inputs[0] || 0) - (inputs[1] || 0);
    if (n.type === 'display') return inputs[0] || 0;

    return 0;
  }

  function formatVal(v) {
    if (typeof v !== 'number' || isNaN(v)) return '$0';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  // ── Get port positions in canvas coordinates ──
  function getNodeEl(id) { return canvasEl.querySelector('[data-id="' + id + '"]'); }

  function getPortPos(nodeId, dir) {
    var n = findNode(nodeId);
    if (!n) return { x: 0, y: 0 };
    var el = getNodeEl(nodeId);
    var h = el ? el.offsetHeight : 60;
    if (dir === 'out') return { x: n.x + 180, y: n.y + h / 2 };
    return { x: n.x, y: n.y + h / 2 };
  }

  // ── Drawing wires on canvas ──
  function resizeWireCanvas() {
    wireCanvas.width = wrap.clientWidth;
    wireCanvas.height = wrap.clientHeight;
  }

  function drawWires() {
    resizeWireCanvas();
    wireCtx.clearRect(0, 0, wireCanvas.width, wireCanvas.height);
    wireCtx.save();
    wireCtx.translate(panX * zoom, panY * zoom);
    wireCtx.scale(zoom, zoom);

    wires.forEach(function (w) {
      var fromNode = findNode(w.from);
      var p1 = getPortPos(w.from, 'out');
      var p2 = getPortPos(w.to, 'in');
      var color = fromNode ? (WIRE_COLORS[fromNode.cat] || '#4f8cff') : '#4f8cff';
      var dx = Math.abs(p2.x - p1.x) * 0.4 + 40;

      wireCtx.beginPath();
      wireCtx.moveTo(p1.x, p1.y);
      wireCtx.bezierCurveTo(p1.x + dx, p1.y, p2.x - dx, p2.y, p2.x, p2.y);
      wireCtx.strokeStyle = color;
      wireCtx.lineWidth = 2.5;
      wireCtx.shadowColor = color;
      wireCtx.shadowBlur = 6;
      wireCtx.stroke();
      wireCtx.shadowBlur = 0;
    });

    // Preview wire while dragging
    if (wiringFrom && wireMousePos) {
      var p1 = getPortPos(wiringFrom.nodeId, 'out');
      var mx = (wireMousePos.x - panX * zoom) / zoom;
      var my = (wireMousePos.y - panY * zoom) / zoom;
      var dx = Math.abs(mx - p1.x) * 0.4 + 40;

      wireCtx.beginPath();
      wireCtx.moveTo(p1.x, p1.y);
      wireCtx.bezierCurveTo(p1.x + dx, p1.y, mx - dx, my, mx, my);
      wireCtx.strokeStyle = '#4f8cff';
      wireCtx.lineWidth = 2;
      wireCtx.setLineDash([6, 4]);
      wireCtx.stroke();
      wireCtx.setLineDash([]);
    }

    wireCtx.restore();
  }

  // ── Render nodes ──
  function renderNodes() {
    canvasEl.querySelectorAll('.ng-node').forEach(function (el) { el.remove(); });

    nodes.forEach(function (n) {
      var def = NODE_DEFS[n.type];
      if (!def) return;
      var val = getNodeValue(n);
      var div = document.createElement('div');
      div.className = 'ng-node ng-type-' + n.cat + (selectedNode === n.id ? ' ng-selected' : '');
      div.setAttribute('data-id', n.id);
      div.style.left = n.x + 'px';
      div.style.top = n.y + 'px';

      var hasInput = n.cat === 'math' || n.cat === 'output';
      var hasOutput = n.cat !== 'output' || n.type === 'total';
      var inConnected = wires.some(function (w) { return w.to === n.id; });
      var outConnected = wires.some(function (w) { return w.from === n.id; });

      var html = '';
      // Header
      html += '<div class="ng-node-header"><span class="ng-icon">' + def.icon + '</span>' + n.label + '</div>';

      // Value
      if (def.editable) {
        html += '<div class="ng-node-input"><input type="number" value="' + (n.value || 0) + '" data-node="' + n.id + '" /></div>';
      } else {
        var cls = val > 0 ? ' ng-positive' : val < 0 ? ' ng-negative' : '';
        html += '<div class="ng-node-value' + cls + '">' + formatVal(val) + '</div>';
      }

      // Sublabel for data nodes
      if (n.cat === 'data' && n.data) {
        var sub = '';
        if (n.type === 'sub') sub = 'Billed to Date';
        else if (n.type === 'co') sub = 'Est. Costs';
        else sub = 'Total Costs';
        html += '<div class="ng-node-sublabel">' + sub + '</div>';
      }

      // Input port
      if (hasInput) {
        html += '<div class="ng-port ng-port-in' + (inConnected ? ' ng-connected' : '') + '" data-node="' + n.id + '" data-dir="in"></div>';
      }
      // Output port
      if (hasOutput) {
        html += '<div class="ng-port ng-port-out' + (outConnected ? ' ng-connected' : '') + '" data-node="' + n.id + '" data-dir="out"></div>';
      }

      div.innerHTML = html;
      canvasEl.appendChild(div);
    });
  }

  function render() {
    renderNodes();
    drawWires();
    var z = document.querySelector('.ng-zoom');
    if (z) z.textContent = Math.round(zoom * 100) + '%';
  }

  function applyTransform() {
    canvasEl.style.transform = 'translate(' + (panX * zoom) + 'px,' + (panY * zoom) + 'px) scale(' + zoom + ')';
  }

  // ── Events ──
  function initEvents() {
    // Pan
    wrap.addEventListener('mousedown', function (e) {
      if (e.target.closest('.ng-port') || e.target.closest('.ng-node')) return;
      isPanning = true;
      panStart = { x: e.clientX / zoom - panX, y: e.clientY / zoom - panY };
      if (selectedNode) { selectedNode = null; render(); }
    });

    wrap.addEventListener('mousemove', function (e) {
      if (isPanning) {
        panX = e.clientX / zoom - panStart.x;
        panY = e.clientY / zoom - panStart.y;
        applyTransform();
        drawWires();
      }
      if (draggingNode) {
        var n = findNode(draggingNode);
        if (n) {
          n.x = e.clientX / zoom - panX - dragOffset.x;
          n.y = e.clientY / zoom - panY - dragOffset.y;
          var el = getNodeEl(n.id);
          if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
          drawWires();
        }
      }
      if (wiringFrom) {
        wireMousePos = { x: e.clientX - wrap.getBoundingClientRect().left, y: e.clientY - wrap.getBoundingClientRect().top };
        drawWires();
      }
    });

    wrap.addEventListener('mouseup', function (e) {
      isPanning = false;
      draggingNode = null;
      if (wiringFrom) {
        var targetPort = e.target.closest('.ng-port-in');
        if (targetPort) {
          var toId = targetPort.getAttribute('data-node');
          if (toId !== wiringFrom.nodeId) {
            var exists = wires.some(function (w) { return w.from === wiringFrom.nodeId && w.to === toId; });
            if (!exists) wires.push({ from: wiringFrom.nodeId, to: toId });
          }
        }
        wiringFrom = null;
        wireMousePos = null;
        render();
      }
    });

    // Zoom
    wrap.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY > 0 ? 0.92 : 1.08;
      var newZoom = Math.max(0.3, Math.min(3, zoom * factor));
      var rect = wrap.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      panX = mx / newZoom - (mx / zoom - panX);
      panY = my / newZoom - (my / zoom - panY);
      zoom = newZoom;
      applyTransform();
      render();
    }, { passive: false });

    // Node drag & port wiring
    canvasEl.addEventListener('mousedown', function (e) {
      var port = e.target.closest('.ng-port-out');
      if (port) {
        e.stopPropagation();
        wiringFrom = { nodeId: port.getAttribute('data-node') };
        return;
      }
      var nodeEl = e.target.closest('.ng-node');
      if (nodeEl && !e.target.closest('input')) {
        e.stopPropagation();
        var nid = nodeEl.getAttribute('data-id');
        var n = findNode(nid);
        if (!n) return;
        selectedNode = nid;
        draggingNode = nid;
        dragOffset = { x: e.clientX / zoom - panX - n.x, y: e.clientY / zoom - panY - n.y };
        render();
      }
    });

    // Value edit
    canvasEl.addEventListener('input', function (e) {
      if (e.target.tagName === 'INPUT' && e.target.dataset.node) {
        var n = findNode(e.target.dataset.node);
        if (n) { n.value = parseFloat(e.target.value) || 0; render(); }
      }
    });

    // Right-click wire to delete (check proximity to wire paths)
    wrap.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var rect = wrap.getBoundingClientRect();
      var mx = (e.clientX - rect.left - panX * zoom) / zoom;
      var my = (e.clientY - rect.top - panY * zoom) / zoom;
      // Find closest wire
      var closest = -1, closestDist = 30;
      wires.forEach(function (w, i) {
        var p1 = getPortPos(w.from, 'out'), p2 = getPortPos(w.to, 'in');
        // Simple midpoint proximity check
        var midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
        var d = Math.sqrt((mx - midX) * (mx - midX) + (my - midY) * (my - midY));
        if (d < closestDist) { closestDist = d; closest = i; }
      });
      if (closest >= 0) { wires.splice(closest, 1); render(); }
    });

    // Delete selected node
    document.addEventListener('keydown', function (e) {
      if (!document.getElementById('nodeGraphTab').classList.contains('active')) return;
      if (e.key === 'Delete' && selectedNode && document.activeElement.tagName !== 'INPUT') {
        wires = wires.filter(function (w) { return w.from !== selectedNode && w.to !== selectedNode; });
        nodes = nodes.filter(function (n) { return n.id !== selectedNode; });
        selectedNode = null;
        render();
      }
    });
  }

  // ── Add node menu ──
  function showAddMenu(button) {
    var existing = document.querySelector('.ng-add-menu');
    if (existing) { existing.remove(); return; }
    var menu = document.createElement('div');
    menu.className = 'ng-add-menu';

    var cats = { cost: 'Cost Inputs', math: 'Math', output: 'Outputs' };
    Object.keys(cats).forEach(function (cat) {
      var h = document.createElement('div');
      h.className = 'ng-add-menu-header';
      h.textContent = cats[cat];
      menu.appendChild(h);
      Object.keys(NODE_DEFS).forEach(function (key) {
        var def = NODE_DEFS[key];
        if (def.cat !== cat) return;
        var item = document.createElement('div');
        item.className = 'ng-add-menu-item';
        item.textContent = def.icon + ' ' + def.label;
        item.addEventListener('click', function () {
          var cx = -panX + wrap.clientWidth / 2 / zoom;
          var cy = -panY + wrap.clientHeight / 2 / zoom;
          createNode(key, cx - 90, cy - 40);
          render();
          menu.remove();
        });
        menu.appendChild(item);
      });
    });

    button.parentElement.style.position = 'relative';
    button.parentElement.appendChild(menu);
    setTimeout(function () {
      document.addEventListener('click', function handler(e) {
        if (!menu.contains(e.target) && e.target !== button) { menu.remove(); document.removeEventListener('click', handler); }
      });
    }, 0);
  }

  // ── Populate from job ──
  function populateFromJob() {
    if (typeof appData === 'undefined') return;
    var jobId = currentJobId || (typeof appState !== 'undefined' ? appState.currentJobId : null);
    if (!jobId) return;
    var job = appData.jobs.find(function (j) { return j.id === jobId; });
    if (!job) return;

    // Center of viewport
    var cx = -panX + (wrap ? wrap.clientWidth / 2 / zoom : 400);
    var cy = -panY + (wrap ? wrap.clientHeight / 2 / zoom : 300);
    var startX = cx - 350, startY = cy - 200;
    var col = 0;

    // Buildings
    var buildings = appData.buildings.filter(function (b) { return b.jobId === jobId; });
    buildings.forEach(function (b, i) {
      createNode('building', startX, startY + i * 100, b.name || 'Building', b);
    });

    // Phases
    var phases = appData.phases.filter(function (p) { return p.jobId === jobId; });
    phases.forEach(function (p, i) {
      var bldg = appData.buildings.find(function (b) { return b.id === p.buildingId; });
      var lbl = (bldg ? bldg.name + ' \u203A ' : '') + (p.phase || 'Phase');
      createNode('phase', startX + 220, startY + i * 100, lbl, p);
    });

    // Subs
    var subs = appData.subs.filter(function (s) { return s.jobId === jobId; });
    if (subs.length) {
      subs.forEach(function (s, i) {
        createNode('sub', startX + 440, startY + i * 90, s.name || 'Sub', s);
      });
    }

    // COs
    var cos = appData.changeOrders.filter(function (c) { return c.jobId === jobId; });
    if (cos.length) {
      var coY = startY + Math.max(subs.length, 1) * 90 + 20;
      cos.forEach(function (c, i) {
        createNode('co', startX + 440, coY + i * 90, (c.coNumber || 'CO') + ' ' + (c.description || ''), c);
      });
    }

    // Output nodes
    createNode('sum', startX + 660, startY + 50, 'SUM Costs');
    createNode('total', startX + 880, startY + 50, 'Job Total');
  }

  // ── Init ──
  function init() {
    var tab = document.getElementById('nodeGraphTab');
    if (!tab) return;

    wrap = tab.querySelector('.ng-canvas-wrap');
    canvasEl = tab.querySelector('.ng-canvas');
    wireCanvas = tab.querySelector('.ng-wire-canvas');
    wireCtx = wireCanvas.getContext('2d');

    initEvents();
    applyTransform();

    tab.querySelector('.ng-close-btn').addEventListener('click', function () {
      tab.classList.remove('active');
    });

    tab.querySelector('.ng-add-btn').addEventListener('click', function () {
      showAddMenu(this);
    });

    var popBtn = tab.querySelector('.ng-populate-btn');
    if (popBtn) {
      popBtn.addEventListener('click', function () {
        nodes = []; wires = []; nextId = 1;
        populateFromJob();
        render();
      });
    }
  }

  // ── Public API ──
  window.openNodeGraph = function (jobId) {
    var tab = document.getElementById('nodeGraphTab');
    if (!tab) return;
    tab.classList.add('active');
    if (!wrap) init();
    resizeWireCanvas();
    if (jobId && jobId !== currentJobId) {
      currentJobId = jobId;
      nodes = []; wires = []; nextId = 1;
      populateFromJob();
      render();
    } else if (nodes.length === 0) {
      currentJobId = jobId || (typeof appState !== 'undefined' ? appState.currentJobId : null);
      populateFromJob();
      render();
    } else {
      render();
    }
  };

})();
