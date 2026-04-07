// ============================================================
// AGX Node Graph — Visual Cost Flow Editor (Beta)
// A Dynamo/Grasshopper-style visual programming canvas for
// connecting cost data nodes with live value propagation
// ============================================================

(function () {
  'use strict';

  // ── State ──
  var nodes = [];
  var wires = [];
  var nextId = 1;
  var canvas, canvasEl, wiresSvg, previewLine;
  var panX = -4500, panY = -4700; // start near center of 10000x10000
  var zoom = 1;
  var draggingNode = null;
  var dragOffset = { x: 0, y: 0 };
  var wiringFrom = null; // { nodeId, portIndex, portType, el }
  var selectedNode = null;

  // ── Node type definitions ──
  var NODE_TYPES = {
    // Data nodes (auto from job)
    building: { category: 'data', icon: '\u{1F3D7}', label: 'Building', outputs: ['Budget', 'Materials', 'Labor', 'Equipment', 'Sub', 'Total'] },
    phase:    { category: 'data', icon: '\u{1F4CB}', label: 'Phase', outputs: ['Materials', 'Labor', 'Equipment', 'Sub', 'Total', '% Complete'] },
    sub:      { category: 'data', icon: '\u{1F477}', label: 'Subcontractor', outputs: ['Contract', 'Billed', 'Remaining'] },
    co:       { category: 'data', icon: '\u{1F4DD}', label: 'Change Order', outputs: ['Income', 'Est. Costs'] },

    // Cost input nodes
    value:    { category: 'cost', icon: '\u{1F4B2}', label: 'Value', outputs: ['Value'], editable: true },
    materials:{ category: 'cost', icon: '\u{1F9F1}', label: 'Materials', outputs: ['Amount'], editable: true },
    labor:    { category: 'cost', icon: '\u{1F6E0}', label: 'Labor', outputs: ['Amount'], editable: true },
    equipment:{ category: 'cost', icon: '\u{2699}', label: 'Equipment', outputs: ['Amount'], editable: true },

    // Math nodes
    sum:      { category: 'math', icon: '\u{2211}', label: 'SUM', inputs: ['A', 'B', 'C', 'D'], outputs: ['Result'] },
    multiply: { category: 'math', icon: '\u{00D7}', label: 'Multiply', inputs: ['A', 'B'], outputs: ['Result'] },
    percent:  { category: 'math', icon: '%', label: 'Percent', inputs: ['Value', 'Percent'], outputs: ['Result'] },
    subtract: { category: 'math', icon: '\u{2212}', label: 'Subtract', inputs: ['A', 'B'], outputs: ['Result'] },

    // Output nodes
    jobTotal: { category: 'output', icon: '\u{1F4CA}', label: 'Job Total', inputs: ['Materials', 'Labor', 'Sub', 'Equipment', 'GC'], outputs: ['Total'] },
    profit:   { category: 'output', icon: '\u{1F4B0}', label: 'Profit', inputs: ['Revenue', 'Costs'], outputs: ['Profit', 'Margin %'] },
    display:  { category: 'output', icon: '\u{1F4CB}', label: 'Display', inputs: ['Value'] }
  };

  // Wire colors by source category
  var WIRE_COLORS = { data: '#4f8cff', cost: '#34d399', math: '#a78bfa', output: '#fbbf24' };

  // ── Helpers ──
  function genId() { return 'n' + (nextId++); }

  function createNode(type, x, y, label, data) {
    var def = NODE_TYPES[type];
    if (!def) return null;
    var node = {
      id: genId(),
      type: type,
      category: def.category,
      x: x, y: y,
      label: label || def.label,
      data: data || {},
      value: data ? data.value || 0 : 0,
      inputs: (def.inputs || []).map(function () { return null; }),
      outputs: (def.outputs || []).map(function () { return []; })
    };
    nodes.push(node);
    return node;
  }

  function findNode(id) { return nodes.find(function (n) { return n.id === id; }); }

  function getPortCenter(nodeId, portIndex, portType) {
    var portEl = canvasEl.querySelector('.ng-port[data-node="' + nodeId + '"][data-port="' + portIndex + '"][data-dir="' + portType + '"]');
    if (!portEl) return { x: 0, y: 0 };
    var rect = portEl.getBoundingClientRect();
    var canvasRect = canvas.getBoundingClientRect();
    return {
      x: (rect.left + rect.width / 2 - canvasRect.left) / zoom - panX,
      y: (rect.top + rect.height / 2 - canvasRect.top) / zoom - panY
    };
  }

  function makeBezierPath(x1, y1, x2, y2) {
    var dx = Math.abs(x2 - x1) * 0.5;
    return 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
  }

  // ── Propagate values through wires ──
  function propagate() {
    // Reset input values
    nodes.forEach(function (n) {
      var def = NODE_TYPES[n.type];
      if (!def) return;
      n._inputValues = (def.inputs || []).map(function () { return 0; });
    });

    // Push output values through wires
    wires.forEach(function (w) {
      var fromNode = findNode(w.fromNode);
      var toNode = findNode(w.toNode);
      if (!fromNode || !toNode) return;
      var val = getOutputValue(fromNode, w.fromPort);
      toNode._inputValues[w.toPort] = (toNode._inputValues[w.toPort] || 0) + val;
    });

    // Compute each node
    nodes.forEach(function (n) { computeNode(n); });
  }

  function getOutputValue(node, portIndex) {
    var def = NODE_TYPES[node.type];
    if (!def) return 0;

    if (def.editable) return node.value || 0;

    // Data nodes: pull from job data
    if (node.category === 'data' && node.data) {
      var d = node.data;
      var outputs = def.outputs;
      var label = outputs[portIndex];
      if (label === 'Budget') return d.budget || 0;
      if (label === 'Materials') return d.materials || 0;
      if (label === 'Labor') return d.labor || 0;
      if (label === 'Equipment') return d.equipment || 0;
      if (label === 'Sub') return d.sub || 0;
      if (label === 'Contract') return d.contractAmt || 0;
      if (label === 'Billed') return d.billedToDate || 0;
      if (label === 'Remaining') return (d.contractAmt || 0) - (d.billedToDate || 0);
      if (label === 'Income') return d.income || 0;
      if (label === 'Est. Costs') return d.estimatedCosts || 0;
      if (label === '% Complete') return d.pctComplete || 0;
      if (label === 'Total') return (d.materials || 0) + (d.labor || 0) + (d.sub || 0) + (d.equipment || 0);
    }

    // Math nodes
    var iv = node._inputValues || [];
    if (node.type === 'sum') return iv.reduce(function (s, v) { return s + (v || 0); }, 0);
    if (node.type === 'multiply') return (iv[0] || 0) * (iv[1] || 0);
    if (node.type === 'subtract') return (iv[0] || 0) - (iv[1] || 0);
    if (node.type === 'percent') return (iv[0] || 0) * ((iv[1] || 0) / 100);

    // Output nodes
    if (node.type === 'jobTotal') return iv.reduce(function (s, v) { return s + (v || 0); }, 0);
    if (node.type === 'profit') {
      if (portIndex === 0) return (iv[0] || 0) - (iv[1] || 0);
      if (portIndex === 1) return (iv[0] || 0) > 0 ? (((iv[0] || 0) - (iv[1] || 0)) / (iv[0] || 1) * 100) : 0;
    }
    if (node.type === 'display') return iv[0] || 0;

    return node.value || 0;
  }

  function computeNode(n) {
    var def = NODE_TYPES[n.type];
    if (!def) return;
    if (def.editable) return;
    if (n.type === 'profit') {
      n._computedOutputs = [getOutputValue(n, 0), getOutputValue(n, 1)];
    } else {
      n._computedOutputs = (def.outputs || []).map(function (_, i) { return getOutputValue(n, i); });
    }
  }

  function formatVal(v) {
    if (typeof v !== 'number' || isNaN(v)) return '—';
    if (Math.abs(v) >= 1000) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (v % 1 !== 0) return v.toFixed(1);
    return String(v);
  }

  // ── Rendering ──
  function renderNodes() {
    // Remove old node elements
    canvasEl.querySelectorAll('.ng-node').forEach(function (el) { el.remove(); });

    nodes.forEach(function (n) {
      var def = NODE_TYPES[n.type];
      if (!def) return;
      var div = document.createElement('div');
      div.className = 'ng-node ng-node-' + n.category + (selectedNode === n.id ? ' ng-selected' : '');
      div.setAttribute('data-id', n.id);
      div.style.left = n.x + 'px';
      div.style.top = n.y + 'px';

      // Header
      var header = '<div class="ng-node-header"><span class="ng-icon">' + def.icon + '</span>' + n.label + '</div>';

      // Body with ports
      var body = '<div class="ng-node-body">';
      var maxPorts = Math.max((def.inputs || []).length, (def.outputs || []).length);
      for (var i = 0; i < maxPorts; i++) {
        body += '<div class="ng-port-row">';
        if (def.inputs && i < def.inputs.length) {
          var connected = wires.some(function (w) { return w.toNode === n.id && w.toPort === i; });
          body += '<div class="ng-port ng-port-in' + (connected ? ' ng-connected' : '') + '" data-node="' + n.id + '" data-port="' + i + '" data-dir="in"></div>';
          body += '<span class="ng-port-label">' + def.inputs[i] + '</span>';
        } else {
          body += '<span></span><span></span>';
        }
        if (def.outputs && i < def.outputs.length) {
          var outVal = n._computedOutputs ? n._computedOutputs[i] : getOutputValue(n, i);
          body += '<span class="ng-port-value">' + formatVal(outVal) + '</span>';
          var outConnected = wires.some(function (w) { return w.fromNode === n.id && w.fromPort === i; });
          body += '<div class="ng-port ng-port-out' + (outConnected ? ' ng-connected' : '') + '" data-node="' + n.id + '" data-port="' + i + '" data-dir="out"></div>';
        }
        body += '</div>';
      }
      body += '</div>';

      // Editable value
      var valueHtml = '';
      if (def.editable) {
        valueHtml = '<div class="ng-node-value"><input type="number" value="' + (n.value || 0) + '" data-node="' + n.id + '" /></div>';
      }

      div.innerHTML = header + body + valueHtml;
      canvasEl.appendChild(div);
    });
  }

  function renderWires() {
    while (wiresSvg.childNodes.length > 1) wiresSvg.removeChild(wiresSvg.lastChild);

    wires.forEach(function (w, idx) {
      var p1 = getPortCenter(w.fromNode, w.fromPort, 'out');
      var p2 = getPortCenter(w.toNode, w.toPort, 'in');
      var fromNode = findNode(w.fromNode);
      var color = fromNode ? (WIRE_COLORS[fromNode.category] || '#4f8cff') : '#4f8cff';
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', makeBezierPath(p1.x, p1.y, p2.x, p2.y));
      path.setAttribute('class', 'ng-wire');
      path.setAttribute('stroke', color);
      path.setAttribute('data-wire', idx);
      path.style.pointerEvents = 'stroke';
      wiresSvg.appendChild(path);
    });
  }

  function render() {
    propagate();
    renderNodes();
    renderWires();
    updateZoomLabel();
  }

  function applyTransform() {
    canvasEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    wiresSvg.setAttribute('viewBox', (-panX / zoom) + ' ' + (-panY / zoom) + ' ' + (canvas.clientWidth / zoom) + ' ' + (canvas.clientHeight / zoom));
  }

  function updateZoomLabel() {
    var el = document.querySelector('.ng-zoom');
    if (el) el.textContent = Math.round(zoom * 100) + '%';
  }

  // ── Event handling ──
  function initEvents() {
    // Pan canvas
    var isPanning = false, panStart = { x: 0, y: 0 };

    canvas.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('ng-port')) return;
      if (e.target.closest('.ng-node')) return;
      isPanning = true;
      panStart = { x: e.clientX - panX, y: e.clientY - panY };
      if (selectedNode) { selectedNode = null; render(); }
    });

    canvas.addEventListener('mousemove', function (e) {
      if (isPanning) {
        panX = e.clientX - panStart.x;
        panY = e.clientY - panStart.y;
        applyTransform();
        renderWires();
      }

      if (draggingNode) {
        var n = findNode(draggingNode);
        if (n) {
          n.x = (e.clientX - canvas.getBoundingClientRect().left) / zoom - panX / zoom - dragOffset.x;
          n.y = (e.clientY - canvas.getBoundingClientRect().top) / zoom - panY / zoom - dragOffset.y;
          var el = canvasEl.querySelector('[data-id="' + n.id + '"]');
          if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
          renderWires();
        }
      }

      if (wiringFrom) {
        var canvasRect = canvas.getBoundingClientRect();
        var mx = (e.clientX - canvasRect.left) / zoom - panX / zoom;
        var my = (e.clientY - canvasRect.top) / zoom - panY / zoom;
        var p1 = getPortCenter(wiringFrom.nodeId, wiringFrom.portIndex, 'out');
        previewLine.setAttribute('d', makeBezierPath(p1.x, p1.y, mx, my));
        previewLine.style.display = '';
      }
    });

    canvas.addEventListener('mouseup', function (e) {
      isPanning = false;
      draggingNode = null;

      if (wiringFrom) {
        var targetPort = e.target.closest('.ng-port-in');
        if (targetPort) {
          var toNodeId = targetPort.getAttribute('data-node');
          var toPort = parseInt(targetPort.getAttribute('data-port'));
          if (toNodeId !== wiringFrom.nodeId) {
            // Check for duplicate wire
            var exists = wires.some(function (w) {
              return w.fromNode === wiringFrom.nodeId && w.fromPort === wiringFrom.portIndex && w.toNode === toNodeId && w.toPort === toPort;
            });
            if (!exists) {
              wires.push({ fromNode: wiringFrom.nodeId, fromPort: wiringFrom.portIndex, toNode: toNodeId, toPort: toPort });
            }
          }
        }
        wiringFrom = null;
        previewLine.style.display = 'none';
        render();
      }
    });

    // Zoom
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY > 0 ? 0.92 : 1.08;
      var newZoom = Math.max(0.2, Math.min(3, zoom * factor));
      // Zoom toward mouse position
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      panX = mx - (mx - panX) * (newZoom / zoom);
      panY = my - (my - panY) * (newZoom / zoom);
      zoom = newZoom;
      applyTransform();
      renderWires();
      updateZoomLabel();
    }, { passive: false });

    // Delegate: node drag, port wire, value edit, wire delete
    canvasEl.addEventListener('mousedown', function (e) {
      // Port wiring
      var port = e.target.closest('.ng-port-out');
      if (port) {
        e.stopPropagation();
        wiringFrom = {
          nodeId: port.getAttribute('data-node'),
          portIndex: parseInt(port.getAttribute('data-port'))
        };
        return;
      }

      // Node drag
      var nodeEl = e.target.closest('.ng-node');
      if (nodeEl && !e.target.closest('input')) {
        e.stopPropagation();
        var nid = nodeEl.getAttribute('data-id');
        var n = findNode(nid);
        if (!n) return;
        selectedNode = nid;
        draggingNode = nid;
        var rect = canvas.getBoundingClientRect();
        dragOffset = {
          x: (e.clientX - rect.left) / zoom - panX / zoom - n.x,
          y: (e.clientY - rect.top) / zoom - panY / zoom - n.y
        };
        render();
      }
    });

    // Value input changes
    canvasEl.addEventListener('input', function (e) {
      if (e.target.tagName === 'INPUT' && e.target.dataset.node) {
        var n = findNode(e.target.dataset.node);
        if (n) {
          n.value = parseFloat(e.target.value) || 0;
          propagate();
          renderNodes();
          renderWires();
        }
      }
    });

    // Wire right-click to delete
    wiresSvg.addEventListener('contextmenu', function (e) {
      var path = e.target.closest('.ng-wire');
      if (path) {
        e.preventDefault();
        var idx = parseInt(path.getAttribute('data-wire'));
        if (!isNaN(idx)) {
          wires.splice(idx, 1);
          render();
        }
      }
    });

    // Delete key removes selected node
    document.addEventListener('keydown', function (e) {
      if (!document.getElementById('nodeGraphTab').classList.contains('active')) return;
      if (e.key === 'Delete' && selectedNode && document.activeElement.tagName !== 'INPUT') {
        wires = wires.filter(function (w) { return w.fromNode !== selectedNode && w.toNode !== selectedNode; });
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
    menu.style.cssText = 'position:absolute;top:100%;left:0;background:#151926;border:1px solid #2a3050;border-radius:6px;padding:4px;z-index:20;min-width:150px;box-shadow:0 8px 24px rgba(0,0,0,0.5);';

    var categories = { cost: 'Cost Inputs', math: 'Math', output: 'Outputs' };
    Object.keys(categories).forEach(function (cat) {
      var header = document.createElement('div');
      header.style.cssText = 'font-size:9px;color:#5a6078;text-transform:uppercase;padding:4px 8px;letter-spacing:0.5px;';
      header.textContent = categories[cat];
      menu.appendChild(header);
      Object.keys(NODE_TYPES).forEach(function (key) {
        var def = NODE_TYPES[key];
        if (def.category !== cat) return;
        var item = document.createElement('div');
        item.style.cssText = 'padding:4px 8px;font-size:11px;color:#e4e6f0;cursor:pointer;border-radius:3px;';
        item.textContent = def.icon + ' ' + def.label;
        item.addEventListener('mouseenter', function () { this.style.background = '#1e2536'; });
        item.addEventListener('mouseleave', function () { this.style.background = ''; });
        item.addEventListener('click', function () {
          // Place in center of viewport
          var cx = (-panX + canvas.clientWidth / 2) / zoom;
          var cy = (-panY + canvas.clientHeight / 2) / zoom;
          createNode(key, cx - 80, cy - 40);
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
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', handler); }
      });
    }, 0);
  }

  // ── Auto-populate from job data ──
  function populateFromJob() {
    if (typeof appData === 'undefined' || typeof appState === 'undefined') return;
    var jobId = appState.currentJobId;
    if (!jobId) return;
    var job = appData.jobs.find(function (j) { return j.id === jobId; });
    if (!job) return;

    var x = 100, y = 100;

    // Buildings
    var buildings = appData.buildings.filter(function (b) { return b.jobId === jobId; });
    buildings.forEach(function (b, i) {
      createNode('building', x, y + i * 180, b.name || 'Building', b);
      // Phases for this building
      var phases = appData.phases.filter(function (p) { return p.buildingId === b.id; });
      phases.forEach(function (p, j) {
        createNode('phase', x + 250, y + i * 180 + j * 150, p.phase || 'Phase', p);
      });
    });

    // Subs
    var subs = appData.subs.filter(function (s) { return s.jobId === jobId; });
    subs.forEach(function (s, i) {
      createNode('sub', x + 500, y + i * 140, s.name || 'Sub', s);
    });

    // COs
    var cos = appData.changeOrders.filter(function (c) { return c.jobId === jobId; });
    cos.forEach(function (c, i) {
      createNode('co', x + 500, y + subs.length * 140 + 40 + i * 130, (c.coNumber || '') + ' ' + (c.description || ''), c);
    });

    // Output nodes
    createNode('jobTotal', x + 800, y + 100, 'Job Total');
    createNode('profit', x + 800, y + 350, 'Profit');
  }

  // ── Init ──
  function init() {
    var tab = document.getElementById('nodeGraphTab');
    if (!tab) return;

    canvas = tab.querySelector('.ng-canvas-wrap');
    canvasEl = tab.querySelector('.ng-canvas');
    wiresSvg = tab.querySelector('.ng-wires');

    // Create preview line
    previewLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    previewLine.setAttribute('class', 'ng-wire-preview');
    previewLine.style.display = 'none';
    wiresSvg.appendChild(previewLine);

    initEvents();
    applyTransform();

    // Wire buttons
    tab.querySelector('.ng-close-btn').addEventListener('click', function () {
      tab.classList.remove('active');
    });

    tab.querySelector('.ng-add-btn').addEventListener('click', function () {
      showAddMenu(this);
    });

    var populateBtn = tab.querySelector('.ng-populate-btn');
    if (populateBtn) {
      populateBtn.addEventListener('click', function () {
        nodes = []; wires = []; nextId = 1;
        populateFromJob();
        render();
      });
    }
  }

  // ── Public API ──
  window.openNodeGraph = function () {
    var tab = document.getElementById('nodeGraphTab');
    if (!tab) return;
    tab.classList.add('active');
    if (!canvas) init();
    if (nodes.length === 0) {
      populateFromJob();
      render();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { if (document.getElementById('nodeGraphTab')) init(); });
  }

})();
