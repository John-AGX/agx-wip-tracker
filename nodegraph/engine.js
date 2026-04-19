// ============================================================
// AGX Node Graph v5 — Engine (state, defs, compute, save, wires)
// ============================================================
var NG = (function(){
'use strict';

var PT = { C:'currency', P:'percent', N:'number', A:'any' };
var WCOL = { currency:'#34d399', percent:'#fbbf24', number:'#a78bfa', any:'#4f8cff' };
// Wire color by SOURCE node type — matches node header colors
var SRCCOL = {
  labor:'#fbbf24', mat:'#fbbf24', gc:'#fbbf24', other:'#fbbf24',
  sub:'#a78bfa', po:'#a78bfa', inv:'#a78bfa',
  co:'#ec4899',
  t1:'#6aa3ff', t2:'#34d399',
  sum:'#818cf8', sub2:'#818cf8', mul:'#818cf8', pct:'#818cf8',
  wip:'#fbbf24', watch:'#fbbf24',
  job:'#60a5fa'
};

function canConn(a,b){ return a===b||a===PT.A||b===PT.A||(a===PT.N&&b===PT.C); }

// ── Node Definitions ──
var DEFS = {
  t1:    { cat:'t1',   icon:'🏗', label:'Tier 1',       ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C}], hasProg:true, nameEdit:true },
  t2:    { cat:'t2',   icon:'📋', label:'Tier 2',       ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C}], hasProg:true, nameEdit:true },
  labor: { cat:'cost', icon:'🛠', label:'Labor',        ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'labor' },
  mat:   { cat:'cost', icon:'🧱', label:'Materials',    ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'mat' },
  gc:    { cat:'cost', icon:'🏢', label:'Gen. Conditions', ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'gc' },
  other: { cat:'cost', icon:'📌', label:'Other',        ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'other' },
  sub:   { cat:'sub',  icon:'👷', label:'Sub',          ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C}], nameEdit:true },
  po:    { cat:'sub',  icon:'📄', label:'Purchase Order', ins:[{n:'Invoiced',t:PT.C}], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'po' },
  inv:   { cat:'sub',  icon:'💳', label:'Invoice',       ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'inv' },
  co:    { cat:'co',   icon:'📝', label:'Change Order', ins:[{n:'Costs',t:PT.C}], outs:[{n:'Income',t:PT.C}], nameEdit:true, hasItems:true, itemType:'co' },
  sum:   { cat:'math', icon:'∑',    label:'SUM',          ins:[{n:'A',t:PT.A},{n:'B',t:PT.A},{n:'C',t:PT.A},{n:'D',t:PT.A}], outs:[{n:'Result',t:PT.C}] },
  sub2:  { cat:'math', icon:'−',    label:'Subtract',     ins:[{n:'A',t:PT.C},{n:'B',t:PT.C}], outs:[{n:'Result',t:PT.C}] },
  mul:   { cat:'math', icon:'×',    label:'Multiply',     ins:[{n:'A',t:PT.A},{n:'B',t:PT.N}], outs:[{n:'Result',t:PT.C}] },
  pct:   { cat:'math', icon:'%',         label:'Percent',      ins:[{n:'Val',t:PT.C},{n:'%',t:PT.P}], outs:[{n:'Result',t:PT.C}] },
  wip:   { cat:'wip',  icon:'📊', label:'WIP',
    ins:[{n:'Costs',t:PT.C},{n:'+ Top',t:PT.C},{n:'+ Bottom',t:PT.C}],
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

  if(type === 'po'){
    id = 'po' + Date.now();
    entry = { id:id, jobId:jobId, poNumber:'PO-'+(appData.purchaseOrders.filter(function(p){return p.jobId===jobId;}).length+1), vendor:label||'', description:'', amount:0, billedToDate:0, date:ts.split('T')[0], status:'Open', notes:'' };
    appData.purchaseOrders.push(entry);
    if(typeof saveData === 'function') saveData();
    return entry;
  }

  if(type === 'inv'){
    id = 'inv' + Date.now();
    entry = { id:id, jobId:jobId, invNumber:'INV-'+(appData.invoices.filter(function(i){return i.jobId===jobId;}).length+1), vendor:label||'', description:'', amount:0, date:ts.split('T')[0], dueDate:'', status:'Draft', notes:'' };
    appData.invoices.push(entry);
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
    // Map real-data fields to node state by type
    if(type === 'po' && data.amount != null) n.value = data.amount;
    if(type === 'inv' && data.amount != null){
      n.items.push({
        date: data.date || '',
        invNum: data.invNumber || data.invNum || '',
        amount: data.amount || 0,
      });
    }
    if(type === 'co' && data.income != null) n.value = 0; // CO uses data.income via getOutput
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

  // Purchase Order: output = actual cost (invoiced amount if Invoice wired, else 0).
  // Contract total is displayed on the node body separately. The accrued portion
  // (contract - invoiced) flows through getAccrued, not getOutput.
  if(n.type === 'po'){
    wires.forEach(function(w){
      if(w.toNode === n.id){ var fn = findNode(w.fromNode); if(fn) v += getOutput(fn, w.fromPort); }
    });
    n._poContract = (n.value || 0) + itemsTotal;
    n._poInvoiced = v;
    _comp[n.id] = false; return v;
  }

  // Invoice: sum of invoice entries
  if(n.type === 'inv'){
    v = itemsTotal;
    _comp[n.id] = false; return v;
  }

  // Sub: single output = sum of wired cost inputs
  if(n.type === 'sub'){
    wires.forEach(function(w){
      if(w.toNode === n.id){ var fn = findNode(w.fromNode); if(fn) v += getOutput(fn, w.fromPort); }
    });
    _comp[n.id] = false; return v;
  }

  // CO: single output = income from items or data
  if(n.type === 'co'){
    v = itemsTotal || (n.data ? n.data.income || 0 : 0);
    _comp[n.id] = false; return v;
  }

  // T1/T2: single output = sum of wired COST inputs + own items.
  // CO inputs don't add to cost total; they accumulate as revenue additions on the node.
  if(n.type === 't1' || n.type === 't2'){
    v = itemsTotal;
    var coRev = 0;
    wires.forEach(function(w){
      if(w.toNode === n.id){
        var fn = findNode(w.fromNode); if(!fn) return;
        var amt = getOutput(fn, w.fromPort);
        if(fn.type === 'co') coRev += amt;
        else v += amt;
      }
    });
    n.coRevenue = coRev;
    _comp[n.id] = false; return v;
  }


  // WIP node: accepts inputs on Costs (pi=0), Top (pi=1), Bottom (pi=2).
  // CO nodes contribute to revenue; other wired sources contribute to actual (billed) and
  // accrued (committed, not yet billed) cost tracks via getActual / getAccrued.
  if(n.type === 'wip'){
    var jf = n.jobFields || {};
    var contract = jf.contractAmount || 0;
    var coIncome = jf.coIncome || 0;
    var estCosts = jf.estimatedCosts || 0;
    var coCosts = jf.coCosts || 0;
    var revChanges = jf.revisedCostChanges || 0;
    var invoiced = jf.invoicedToDate || 0;
    var pctComp = jf.pctComplete || 0;
    var actualCosts = 0;
    var accruedCosts = 0;
    var coIncomeWired = 0;
    wires.forEach(function(w){
      if(w.toNode === n.id){
        var fn = findNode(w.fromNode); if(!fn) return;
        if(fn.type === 'co') coIncomeWired += getOutput(fn, w.fromPort);
        else { actualCosts += getActual(fn); accruedCosts += getAccrued(fn); }
      }
    });
    n.coRevenue = coIncomeWired;
    var totalIncome = contract + coIncome + coIncomeWired;
    var revEstCosts = estCosts + coCosts + revChanges;
    var revEarned = totalIncome * (pctComp / 100);
    var grossProfit = revEarned - actualCosts;
    var marginJTD = revEarned > 0 ? (grossProfit / revEarned * 100) : 0;
    var remaining = revEstCosts - actualCosts;
    var unbilled = revEarned - invoiced;
    var backlog = totalIncome - revEarned;
    var wipOuts = [totalIncome, actualCosts, revEarned, grossProfit, marginJTD, remaining, accruedCosts, unbilled, backlog];
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

function resetComp(){ _comp = {}; _compA = {}; _compAc = {}; }

// ── Actual vs Accrued cost split ──
// getActual(n): the billed / spent portion flowing out of this node.
// getAccrued(n): the committed-but-not-yet-billed portion flowing out of this node.
// Cost nodes (labor/mat/gc/other/inv) are always actual. POs split based on wired invoices:
//   actual = sum of wired invoice amounts
//   accrued = max(0, contract_total - invoiced)
// Sub/T1/T2 aggregate children (excluding CO nodes which are revenue, not cost).
var _compA = {}, _compAc = {};

function _itemsTotal(n){
  var d = DEFS[n.type]; if(!d || !n.items) return 0;
  var iType = d.itemType || '', t = 0;
  n.items.forEach(function(item){
    if(iType === 'labor') t += (item.hours||0) * (item.rate||65);
    else if(iType === 'other') t += (item.qty||0) * (item.unitCost||0);
    else t += (item.amount||0);
  });
  return t;
}

function getActual(n){
  if(!n) return 0;
  if(_compA[n.id]) return 0;
  _compA[n.id] = true;
  var v = 0, iT = _itemsTotal(n);
  if(n.type==='labor'||n.type==='mat'||n.type==='gc'||n.type==='other'){ v = iT || n.value || 0; }
  else if(n.type==='inv'){ v = iT; }
  else if(n.type==='po'){
    // Sum wired Invoice amounts on the PO's input port
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) v += getOutput(fn, w.fromPort); }
    });
  }
  else if(n.type==='sub'){
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) v += getActual(fn); }
    });
  }
  else if(n.type==='co'){
    // CO actual costs = sum of wired cost children (mini-P&L)
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) v += getActual(fn); }
    });
  }
  else if(n.type==='t1'||n.type==='t2'){
    v = iT;
    // Include CO actual costs so CO work rolls up to the building/phase
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(!fn) return; v += getActual(fn); }
    });
  }
  _compA[n.id] = false;
  return v;
}

// Find weighted-average pctComplete across all ancestor T1/T2 phases.
// When a PO/sub serves multiple phases, the contract is conceptually allocated
// proportionally to phase budgets; accrual = sum(phaseAlloc * phasePct).
// This is equivalent to contract * (weighted-avg pct), bounding total accrual
// at contract when all phases hit 100%.
function getAncestorPct(n, _seen){
  _seen = _seen || {};
  if(_seen[n.id]) return null;
  _seen[n.id] = true;
  var results = [];
  wires.forEach(function(w){
    if(w.fromNode===n.id){
      var parent=findNode(w.toNode);
      if(!parent) return;
      if((parent.type==='t1'||parent.type==='t2') && parent.pctComplete!=null){
        results.push({ pct: parent.pctComplete, weight: parent.budget || 0 });
      } else if(parent.type==='sub'||parent.type==='co'){
        var sub = getAncestorPct(parent, _seen);
        if(sub != null) results.push({ pct: sub, weight: parent.budget || 0 });
      }
    }
  });
  if(results.length === 0) return 100;
  var totalWeight = results.reduce(function(s, r){ return s + r.weight; }, 0);
  if(totalWeight === 0){
    // No budgets set — equal split
    return results.reduce(function(s, r){ return s + r.pct; }, 0) / results.length;
  }
  // Phases without budgets contribute 0 to numerator but also 0 to denominator,
  // so they're effectively ignored when other phases have budgets.
  return results.reduce(function(s, r){ return s + r.pct * r.weight; }, 0) / totalWeight;
}

function getAccrued(n){
  if(!n) return 0;
  if(_compAc[n.id]) return 0;
  _compAc[n.id] = true;
  var v = 0, iT = _itemsTotal(n);
  if(n.type==='po'){
    var contract = (n.value||0) + iT, invSum = 0;
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) invSum += getOutput(fn, w.fromPort); }
    });
    var pct = getAncestorPct(n);
    v = Math.max(0, contract * (pct/100) - invSum);
  }
  else if(n.type==='sub'){
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) v += getAccrued(fn); }
    });
  }
  else if(n.type==='co'){
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) v += getAccrued(fn); }
    });
  }
  else if(n.type==='t1'||n.type==='t2'){
    // Include CO accrued so CO committed-not-billed rolls up
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(!fn) return; v += getAccrued(fn); }
    });
  }
  _compAc[n.id] = false;
  return v;
}

// ── Formatting ──
function fmtC(v){ return '$'+v.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtP(v){ return v.toFixed(1)+'%'; }
function fmtV(v,t){ return t===PT.P ? fmtP(v) : t===PT.C ? fmtC(v) : v.toLocaleString(); }

// ── Save / Load ──
var GRAPH_VER = 6; // bump to force re-populate on next open
function saveGraph(){
  if(!jobId) return;
  var state = {
    ver: GRAPH_VER,
    nodes: nodes.map(function(n){
      return {
        id:n.id, type:n.type, x:n.x, y:n.y, label:n.label,
        value:n.value, collapsed:n.collapsed, noteText:n.noteText,
        items:n.items, pctComplete:n.pctComplete, budget:n.budget, jobFields:n.jobFields||{},
        _coRevApplied: n._coRevApplied||0,
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
      else if(sn.type === 'co') data = appData.changeOrders.find(function(c){ return c.id === sn.dataId; }) || {};
      else if(sn.type === 'po') data = (appData.purchaseOrders||[]).find(function(p){ return p.id === sn.dataId; }) || {};
      else if(sn.type === 'inv') data = (appData.invoices||[]).find(function(i){ return i.id === sn.dataId; }) || {};
    }
    var savedItems = sn.items || [];
    var savedValue = sn.value || 0;
    // Re-hydrate from data if saved state is empty (upgrading old graphs)
    if(sn.type === 'po' && data.amount != null && !savedValue && savedItems.length === 0){
      savedValue = data.amount;
    }
    if(sn.type === 'inv' && data.amount != null && savedItems.length === 0){
      savedItems = [{ date: data.date||'', invNum: data.invNumber||data.invNum||'', amount: data.amount||0 }];
    }
    var n = {
      id:sn.id, type:sn.type, cat:d.cat,
      x:sn.x, y:sn.y, label:sn.label,
      data:data, value:savedValue,
      collapsed:sn.collapsed||false,
      noteText:sn.noteText||'',
      items:savedItems,
      pctComplete:sn.pctComplete||0,
      budget:sn.budget||0,
      jobFields:sn.jobFields||{},
      _coRevApplied:sn._coRevApplied||0,
    };
    nodes.push(n);
  });
  return true;
}

// ── Wire Drawing ──
function hexToRgba(hex, a){
  var h = hex.replace('#','');
  if(h.length===3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  var r = parseInt(h.substring(0,2),16);
  var g = parseInt(h.substring(2,4),16);
  var b = parseInt(h.substring(4,6),16);
  return 'rgba('+r+','+g+','+b+','+a+')';
}
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
    var fn = findNode(w.fromNode);
    var col = (fn && SRCCOL[fn.type]) || WCOL[tp] || '#4f8cff';
    // Detect vertical approach: WIP's top (pi=1) and bottom (pi=2) ports
    var vertIn = tn && tn.type==='wip' && (w.toPort===1||w.toPort===2);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y);
    if(vertIn){
      var vy = w.toPort===1 ? -60 : 60; // approach top from above, bottom from below
      ctx.bezierCurveTo(p1.x+60, p1.y, p2.x, p2.y+vy, p2.x, p2.y);
    } else {
      var dx = Math.max(Math.abs(p2.x-p1.x)*0.4, 50);
      ctx.bezierCurveTo(p1.x+dx, p1.y, p2.x-dx, p2.y, p2.x, p2.y);
    }
    // Gradient: breathing fade — bright near nodes, dips in middle
    var grad = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
    grad.addColorStop(0,    hexToRgba(col, 0.15));
    grad.addColorStop(0.15, hexToRgba(col, 0.85));
    grad.addColorStop(0.35, hexToRgba(col, 0.45));
    grad.addColorStop(0.50, hexToRgba(col, 0.30));
    grad.addColorStop(0.65, hexToRgba(col, 0.45));
    grad.addColorStop(0.85, hexToRgba(col, 0.85));
    grad.addColorStop(1,    hexToRgba(col, 0.15));
    ctx.strokeStyle = grad; ctx.lineWidth = 3;
    ctx.shadowColor = col; ctx.shadowBlur = 4;
    ctx.stroke(); ctx.shadowBlur = 0;
  });

  // Preview wire
  if(wiringFrom && wireMouse){
    var p1 = portPos(wiringFrom.nid, wiringFrom.pi, 'out');
    var mx = wireMouse.x/zoom - panX, my = wireMouse.y/zoom - panY;
    var dx = Math.max(Math.abs(mx-p1.x)*0.4, 50);
    var wf = findNode(wiringFrom.nid);
    var pcol = (wf && SRCCOL[wf.type]) || '#4f8cff';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.bezierCurveTo(p1.x+dx, p1.y, mx-dx, my, mx, my);
    ctx.strokeStyle = pcol; ctx.lineWidth = 2;
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
  PT:PT, DEFS:DEFS, CATS:CATS, WCOL:WCOL, SRCCOL:SRCCOL, SNAP:SNAP,
  nodes:function(){ return nodes; },
  wires:function(){ return wires; },
  setNodes:function(n){ nodes=n; },
  setWires:function(w){ wires=w; },
  setNid:function(n){ nid=n; },
  pan:function(x,y){ if(x!=null)panX=x; if(y!=null)panY=y; return{x:panX,y:panY}; },
  zm:function(z){ if(z!=null)zoom=z; return zoom; },
  job:function(j){ if(j!=null)jobId=j; return jobId; },
  canConn:canConn, addNode:addNode, findNode:findNode,
  getOutput:getOutput, getActual:getActual, getAccrued:getAccrued, resetComp:resetComp,
  fmtC:fmtC, fmtP:fmtP, fmtV:fmtV,
  saveGraph:saveGraph, loadGraph:loadGraph,
  drawWires:drawWires, drawGrid:drawGrid,
  portPos:portPos, setCanvasEl:setCanvasEl,
  genId:genId,
};
})();
