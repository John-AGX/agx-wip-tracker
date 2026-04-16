// ============================================================
// AGX Node Graph v5 — Engine (state, defs, compute, save, wires)
// ============================================================
var NG = (function(){
'use strict';

var PT = { C:'currency', P:'percent', N:'number', A:'any' };
var WCOL = { currency:'#34d399', percent:'#fbbf24', number:'#a78bfa', any:'#4f8cff' };

function canConn(a,b){ return a===b||a===PT.A||b===PT.A||(a===PT.N&&b===PT.C); }

// ── Node Definitions ──
var DEFS = {
  t1:    { cat:'t1',   icon:'🏗', label:'Tier 1',       ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C}], hasProg:true, nameEdit:true },
  t2:    { cat:'t2',   icon:'📋', label:'Tier 2',       ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C}], hasProg:true, nameEdit:true },
  labor: { cat:'cost', icon:'🛠', label:'Labor',        ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'labor' },
  mat:   { cat:'cost', icon:'🧱', label:'Materials',    ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'mat' },
  gc:    { cat:'cost', icon:'🏢', label:'Gen. Conditions', ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'gc' },
  other: { cat:'cost', icon:'📌', label:'Other',        ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'other' },
  sub:   { cat:'sub',  icon:'👷', label:'Sub',          ins:[{n:'PO Contract',t:PT.C},{n:'Invoiced',t:PT.C}], outs:[{n:'Actual Cost',t:PT.C}], nameEdit:true, hasProg:true },
  po:    { cat:'sub',  icon:'📄', label:'Purchase Order', ins:[{n:'Invoiced',t:PT.C}], outs:[{n:'Contract',t:PT.C},{n:'Invoiced',t:PT.C}], hasItems:true, nameEdit:true, itemType:'po' },
  inv:   { cat:'sub',  icon:'💳', label:'Invoice',       ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'inv' },
  co:    { cat:'co',   icon:'📝', label:'Change Order', ins:[], outs:[{n:'Income',t:PT.C}], nameEdit:true, hasItems:true, itemType:'co' },
  sum:   { cat:'math', icon:'∑',    label:'SUM',          ins:[{n:'A',t:PT.A},{n:'B',t:PT.A},{n:'C',t:PT.A},{n:'D',t:PT.A}], outs:[{n:'Result',t:PT.C}] },
  sub2:  { cat:'math', icon:'−',    label:'Subtract',     ins:[{n:'A',t:PT.C},{n:'B',t:PT.C}], outs:[{n:'Result',t:PT.C}] },
  mul:   { cat:'math', icon:'×',    label:'Multiply',     ins:[{n:'A',t:PT.A},{n:'B',t:PT.N}], outs:[{n:'Result',t:PT.C}] },
  pct:   { cat:'math', icon:'%',         label:'Percent',      ins:[{n:'Val',t:PT.C},{n:'%',t:PT.P}], outs:[{n:'Result',t:PT.C}] },
  wip:   { cat:'wip',  icon:'📊', label:'WIP',
    ins:[{n:'Costs',t:PT.C}],
    outs:[{n:'Total Income',t:PT.C},{n:'Actual Costs',t:PT.C},{n:'Revenue Earned',t:PT.C},{n:'Gross Profit',t:PT.C},{n:'Margin JTD',t:PT.P},{n:'Remaining',t:PT.C},{n:'Accrued',t:PT.C},{n:'Unbilled',t:PT.C},{n:'Backlog',t:PT.C}],
    master:true, hasFields:true
  },
  watch: { cat:'watch',icon:'📊', label:'Watch',        ins:[{n:'Value',t:PT.A}], outs:[], nameEdit:true },
  note:  { cat:'note', icon:'📌', label:'Note',         ins:[], outs:[] },
};
// ── Category tree for sidebar ──
var CATS = [
  { name:'Master',    items:['wip'] },
  { name:'Structure', items:['t1','t2'] },
  { name:'Costs',     items:['labor','mat','gc','other'] },
  { name:'Subs & COs',items:['sub','po','inv','co'] },
  { name:'Math',      items:['sum','sub2','mul','pct'] },
  { name:'Output',    items:['watch'] },
  { name:'Notes',     items:['note'] },
];

// ── State ──
var nodes = [], wires = [], nid = 1;
var panX = 0, panY = 0, zoom = 1;
var jobId = null;
var SNAP = 15;

function genId(){ return 'n'+(nid++); }

/** Create a real appData entry when a node is created from sidebar */
function createDataEntry(type, label){
  if(typeof appData === 'undefined' || !jobId) return {};
  var id, entry;
  var ts = new Date().toISOString();

  if(type === 't1'){
    id = 'b' + Date.now();
    entry = { id:id, jobId:jobId, name:label||'New Building', address:'', budget:0, budgetPct:0, materials:0, labor:0, sub:0, equipment:0, hoursWeek:0, hoursTotal:0, rate:40, workScope:'in-house', locked:false, excludeFromSubDist:false };
    appData.buildings.push(entry);
    if(typeof saveData === 'function') saveData();
    return entry;
  }

  if(type === 't2'){
    id = 'p' + Date.now();
    entry = { id:id, jobId:jobId, buildingId:'', phase:label||'New Phase', workScope:'in-house', locked:false, pctComplete:0, materials:0, labor:0, sub:0, equipment:0, phaseBudget:0, hoursWeek:0, hoursTotal:0, rate:40, notes:'', dateAdded:ts };
    appData.phases.push(entry);
    if(typeof saveData === 'function') saveData();
    return entry;
  }

  if(type === 'sub'){
    id = 's' + Date.now();
    entry = { id:id, jobId:jobId, name:label||'New Sub', trade:'', level:'job', buildingId:'', buildingIds:[], phaseId:'', phaseIds:[], contractAmt:0, billedToDate:0, notes:'' };
    appData.subs.push(entry);
    if(typeof saveData === 'function') saveData();
    return entry;
  }

  if(type === 'co'){
    id = 'co' + Date.now();
    entry = { id:id, jobId:jobId, coNumber:'CO-'+(appData.changeOrders.filter(function(c){return c.jobId===jobId;}).length+1), description:label||'', income:0, estimatedCosts:0, date:ts.split('T')[0], notes:'' };
    appData.changeOrders.push(entry);
    if(typeof saveData === 'function') saveData();
    return entry;
  }

  return {};
}

function addNode(type, x, y, label, data){
  var d = DEFS[type]; if(!d) return null;

  // If no data provided AND we have appData, create real data entry
  if(!data && typeof appData !== 'undefined' && jobId){
    data = createDataEntry(type, label);
  }

  var n = {
    id: genId(), type: type, cat: d.cat,
    x: Math.round(x/SNAP)*SNAP, y: Math.round(y/SNAP)*SNAP,
    label: label || d.label,
    data: data || {},
    value: 0,
    collapsed: false,
    noteText: '',
    items: [],
    pctComplete: 0,
    budget: 0,
    jobFields: {},
  };
  if(data){
    if(data._val != null) n.value = data._val;
    if(data.budget) n.budget = data.budget;
    if(data.pctComplete) n.pctComplete = data.pctComplete;
  }
  nodes.push(n);
  return n;
}

function findNode(id){ return nodes.find(function(n){ return n.id === id; }); }

// ── Value Computation ──
var _comp = {};

function getOutput(n, pi){
  if(_comp[n.id]) return 0;
  _comp[n.id] = true;
  var d = DEFS[n.type], v = 0;

  // Items total — varies by item type
  var itemsTotal = 0;
  if(n.items && n.items.length > 0){
    var iType = d ? d.itemType : '';
    n.items.forEach(function(item){
      if(iType === 'labor') itemsTotal += (item.hours || 0) * (item.rate || 65);
      else if(iType === 'other') itemsTotal += (item.qty || 0) * (item.unitCost || 0);
      else itemsTotal += (item.amount || 0);
    });
  }

  // Cost nodes (labor, mat, gc, other): items total or direct value
  if(n.type === 'labor' || n.type === 'mat' || n.type === 'gc' || n.type === 'other'){
    v = itemsTotal || n.value || 0;
    _comp[n.id] = false; return v;
  }

  // Purchase Order: contract = base + amendments. Passes through invoiced from input.
  if(n.type === 'po'){
    if(pi === 0){
      // Output 0: Contract = base value + amendment items
      v = (n.value || 0) + itemsTotal;
    } else if(pi === 1){
      // Output 1: Invoiced = sum of wired Invoice inputs
      wires.forEach(function(w){
        if(w.toNode === n.id){
          var fn = findNode(w.fromNode);
          if(fn) v += getOutput(fn, w.fromPort);
        }
      });
    }
    _comp[n.id] = false; return v;
  }

  // Invoice: sum of invoice entries
  if(n.type === 'inv'){
    v = itemsTotal;
    _comp[n.id] = false; return v;
  }

  // Sub: single output = invoiced amount (actual cost)
  if(n.type === 'sub'){
    wires.forEach(function(w){
      if(w.toNode === n.id && w.toPort === 1){ var fn = findNode(w.fromNode); if(fn) v += getOutput(fn, w.fromPort); }
    });
    _comp[n.id] = false; return v;
  }

  // CO: single output = income from items or data
  if(n.type === 'co'){
    v = itemsTotal || (n.data ? n.data.income || 0 : 0);
    _comp[n.id] = false; return v;
  }

  // T1/T2: single output = sum of wired inputs + own items
  if(n.type === 't1' || n.type === 't2'){
    v = itemsTotal;
    wires.forEach(function(w){
      if(w.toNode === n.id){ var fn = findNode(w.fromNode); if(fn) v += getOutput(fn, w.fromPort); }
    });
    _comp[n.id] = false; return v;
  }


  // WIP node: T1s wire into Costs input. Revenue fields stored in jobFields.
  if(n.type === 'wip'){
    var jf = n.jobFields || {};
    var contract = jf.contractAmount || 0;
    var coIncome = jf.coIncome || 0;
    var estCosts = jf.estimatedCosts || 0;
    var coCosts = jf.coCosts || 0;
    var revChanges = jf.revisedCostChanges || 0;
    var invoiced = jf.invoicedToDate || 0;
    var pctComp = jf.pctComplete || 0;
    var totalIncome = contract + coIncome;
    var revEstCosts = estCosts + coCosts + revChanges;
    // Sum all wired cost inputs
    var actualCosts = 0;
    wires.forEach(function(w){
      if(w.toNode === n.id){ var fn = findNode(w.fromNode); if(fn) actualCosts += getOutput(fn, w.fromPort); }
    });
    var revEarned = totalIncome * (pctComp / 100);
    var grossProfit = revEarned - actualCosts;
    var marginJTD = revEarned > 0 ? (grossProfit / revEarned * 100) : 0;
    var remaining = revEstCosts - actualCosts;
    var accrued = Math.max(0, revEarned - invoiced);
    var unbilled = revEarned - invoiced;
    var backlog = totalIncome - revEarned;
    var wipOuts = [totalIncome, actualCosts, revEarned, grossProfit, marginJTD, remaining, accrued, unbilled, backlog];
    v = wipOuts[pi] || 0;
    _comp[n.id] = false; return v;
  }

  // Job node removed — revenue fields now in WIP node

  // Math nodes: collect inputs
  var ins = (d.ins || []).map(function(){ return 0; });
  wires.forEach(function(w){
    if(w.toNode === n.id){
      var fn = findNode(w.fromNode);
      if(fn) ins[w.toPort] = (ins[w.toPort] || 0) + getOutput(fn, w.fromPort);
    }
  });

  if(n.type === 'sum')  v = ins.reduce(function(s,x){ return s+x; }, 0);
  else if(n.type === 'sub2') v = (ins[0]||0) - (ins[1]||0);
  else if(n.type === 'mul')  v = (ins[0]||0) * (ins[1]||0);
  else if(n.type === 'pct')  v = (ins[0]||0) * ((ins[1]||0)/100);
  else if(n.type === 'watch') v = ins[0] || 0;

  _comp[n.id] = false;
  return v;
}

function resetComp(){ _comp = {}; }

// ── Formatting ──
function fmtC(v){ return '$'+v.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtP(v){ return v.toFixed(1)+'%'; }
function fmtV(v,t){ return t===PT.P ? fmtP(v) : t===PT.C ? fmtC(v) : v.toLocaleString(); }

// ── Save / Load ──
var GRAPH_VER = 3; // bump to force re-populate on next open
function saveGraph(){
  if(!jobId) return;
  var state = {
    ver: GRAPH_VER,
    nodes: nodes.map(function(n){
      return {
        id:n.id, type:n.type, x:n.x, y:n.y, label:n.label,
        value:n.value, collapsed:n.collapsed, noteText:n.noteText,
        items:n.items, pctComplete:n.pctComplete, budget:n.budget, jobFields:n.jobFields||{},
        dataId: n.data ? n.data.id : null
      };
    }),
    wires: wires,
    panX:panX, panY:panY, zoom:zoom, nid:nid
  };
  var all = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
  all[jobId] = state;
  localStorage.setItem('agx-nodegraphs', JSON.stringify(all));
}

function loadGraph(){
  if(!jobId) return false;
  var all = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
  var state = all[jobId];
  if(!state || !state.nodes || !state.nodes.length) return false;
  if((state.ver||0) < GRAPH_VER) return false; // stale version → re-populate

  nodes = []; wires = state.wires || []; nid = state.nid || 1;
  panX = state.panX || 0; panY = state.panY || 0; zoom = state.zoom || 1;

  state.nodes.forEach(function(sn){
    var d = DEFS[sn.type]; if(!d) return;
    var data = {};
    if(sn.dataId && typeof appData !== 'undefined'){
      if(sn.type === 't1') data = appData.buildings.find(function(b){ return b.id === sn.dataId; }) || {};
      else if(sn.type === 't2') data = appData.phases.find(function(p){ return p.id === sn.dataId; }) || {};
      else if(sn.type === 'sub') data = appData.subs.find(function(s){ return s.id === sn.dataId; }) || {};
      else if(sn.type === 'co') data = appData.changeOrders.find(function(c){ return c.id === sn.dataId; }) || {};}
    var n = {
      id:sn.id, type:sn.type, cat:d.cat,
      x:sn.x, y:sn.y, label:sn.label,
      data:data, value:sn.value||0,
      collapsed:sn.collapsed||false,
      noteText:sn.noteText||'',
      items:sn.items||[],
      pctComplete:sn.pctComplete||0,
      budget:sn.budget||0,
      jobFields:sn.jobFields||{},
    };
    nodes.push(n);
  });
  return true;
}

// ── Wire Drawing ──
function drawWires(ctx, wrap, wiringFrom, wireMouse){
  ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
  ctx.save();
  ctx.translate(panX*zoom, panY*zoom);
  ctx.scale(zoom, zoom);

  wires.forEach(function(w){
    var p1 = portPos(w.fromNode, w.fromPort, 'out');
    var p2 = portPos(w.toNode, w.toPort, 'in');
    var tn = findNode(w.toNode), td = DEFS[tn?tn.type:''];
    var tp = td && td.ins && td.ins[w.toPort] ? td.ins[w.toPort].t : PT.A;
    var col = WCOL[tp] || '#4f8cff';
    var dx = Math.max(Math.abs(p2.x-p1.x)*0.4, 50);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.bezierCurveTo(p1.x+dx, p1.y, p2.x-dx, p2.y, p2.x, p2.y);
    ctx.strokeStyle = col; ctx.lineWidth = 2.5;
    ctx.shadowColor = col; ctx.shadowBlur = 4;
    ctx.stroke(); ctx.shadowBlur = 0;
  });

  // Preview wire
  if(wiringFrom && wireMouse){
    var p1 = portPos(wiringFrom.nid, wiringFrom.pi, 'out');
    var mx = wireMouse.x/zoom - panX, my = wireMouse.y/zoom - panY;
    var dx = Math.max(Math.abs(mx-p1.x)*0.4, 50);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.bezierCurveTo(p1.x+dx, p1.y, mx-dx, my, mx, my);
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 2;
    ctx.setLineDash([6,4]); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
}

// ── Port Positions ──
var _canvasEl = null;
function setCanvasEl(el){ _canvasEl = el; }

function portPos(nid2, pi, dir){
  var n = findNode(nid2); if(!n) return {x:0,y:0};
  if(!_canvasEl) return {x:n.x, y:n.y+20};
  var el = _canvasEl.querySelector('[data-id="'+nid2+'"]');
  if(!el) return {x:n.x, y:n.y+20};
  var nr = el.getBoundingClientRect();
  var allPorts = el.querySelectorAll('.ng-p[data-dir="'+dir+'"]');
  var port = null;
  allPorts.forEach(function(p){
    var ppi = parseInt(p.getAttribute('data-pi'));
    if(ppi === pi && p.getBoundingClientRect().width > 0) port = p;
    if(n.collapsed && p.getBoundingClientRect().width > 0 && !port) port = p;
  });
  if(port){
    var pr = port.getBoundingClientRect();
    return { x: n.x + (pr.left+pr.width/2-nr.left)/zoom, y: n.y + (pr.top+pr.height/2-nr.top)/zoom };
  }
  var w = nr.width/zoom, h = nr.height/zoom;
  return dir==='out' ? {x:n.x+w, y:n.y+h/2} : {x:n.x, y:n.y+h/2};
}

// ── Grid Drawing ──
function drawGrid(ctx, w, h){
  ctx.clearRect(0,0,w,h);
  // Read theme colors from computed styles
  var style = getComputedStyle(document.documentElement);
  var dotColor = style.getPropertyValue('--ng-grid-dot').trim() || '#161b2a';
  var lineColor = style.getPropertyValue('--ng-grid-line').trim() || '#141828';
  var s = SNAP*2*zoom, ox = (panX*zoom)%s, oy = (panY*zoom)%s;
  ctx.fillStyle = dotColor;
  for(var x=ox;x<w;x+=s) for(var y=oy;y<h;y+=s) ctx.fillRect(x-.5,y-.5,1,1);
  var m=s*5, omx=(panX*zoom)%m, omy=(panY*zoom)%m;
  ctx.strokeStyle=lineColor; ctx.lineWidth=1; ctx.beginPath();
  for(var x2=omx;x2<w;x2+=m){ctx.moveTo(x2,0);ctx.lineTo(x2,h);}
  for(var y2=omy;y2<h;y2+=m){ctx.moveTo(0,y2);ctx.lineTo(w,y2);}
  ctx.stroke();
}

// ── Public API ──
return {
  PT:PT, DEFS:DEFS, CATS:CATS, WCOL:WCOL, SNAP:SNAP,
  nodes:function(){ return nodes; },
  wires:function(){ return wires; },
  setNodes:function(n){ nodes=n; },
  setWires:function(w){ wires=w; },
  setNid:function(n){ nid=n; },
  pan:function(x,y){ if(x!=null)panX=x; if(y!=null)panY=y; return{x:panX,y:panY}; },
  zm:function(z){ if(z!=null)zoom=z; return zoom; },
  job:function(j){ if(j!=null)jobId=j; return jobId; },
  canConn:canConn, addNode:addNode, findNode:findNode,
  getOutput:getOutput, resetComp:resetComp,
  fmtC:fmtC, fmtP:fmtP, fmtV:fmtV,
  saveGraph:saveGraph, loadGraph:loadGraph,
  drawWires:drawWires, drawGrid:drawGrid,
  portPos:portPos, setCanvasEl:setCanvasEl,
  genId:genId,
};
})();
