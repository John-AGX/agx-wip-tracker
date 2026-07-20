// ============================================================
// AGX Node Graph v5 — Engine (state, defs, compute, save, wires)
// ============================================================
var NG = (function(){
'use strict';

var PT = { C:'currency', P:'percent', N:'number', A:'any' };
var WCOL = { currency:'#34d399', percent:'#fbbf24', number:'#a78bfa', any:'#4f8cff' };
// Wire color by SOURCE node type — matches node header colors
var SRCCOL = {
  labor:'#fbbf24', mat:'#fbbf24', gc:'#fbbf24', other:'#fbbf24', burden:'#fbbf24',
  sub:'#a78bfa', po:'#22d3ee', inv:'#fce7f3',
  co:'#ec4899',
  t1:'#6aa3ff', t2:'#34d399',
  sum:'#818cf8', sub2:'#818cf8', mul:'#818cf8', pct:'#818cf8',
  wip:'#fbbf24', watch:'#fbbf24',
  job:'#60a5fa'
};

function canConn(a,b){ return a===b||a===PT.A||b===PT.A||(a===PT.N&&b===PT.C); }

// ── Node Definitions ──
var DEFS = {
  t1:    { cat:'t1',   icon:'🏗', label:'Building',     ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C}], hasProg:true, nameEdit:true },
  t2:    { cat:'t2',   icon:'📋', label:'Scope',        ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C}], hasProg:true, nameEdit:true },
  labor: { cat:'cost', icon:'🛠', label:'Labor',        ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'labor' },
  mat:   { cat:'cost', icon:'🧱', label:'Materials',    ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'mat' },
  gc:    { cat:'cost', icon:'🏢', label:'Gen. Conditions', ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'gc' },
  other: { cat:'cost', icon:'📌', label:'Other',        ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'other' },
  // Direct burden — payroll burden / insurance / taxes layered on
  // labor. Same line-entry shape as Materials (date + amount), so the
  // user can map QB "Direct Burden" account totals directly without
  // touching qty/rate math.
  burden:{ cat:'cost', icon:'⚖️', label:'Direct Burden', ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'burden' },
  sub:   { cat:'sub',  icon:'👷', label:'Sub',          ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C}], nameEdit:true },
  po:    { cat:'sub',  icon:'📄', label:'Purchase Order', ins:[{n:'Invoiced',t:PT.C}], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'po' },
  inv:   { cat:'sub',  icon:'💳', label:'Invoice',       ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'inv' },
  co:    { cat:'co',   icon:'📝', label:'Change Order', ins:[{n:'Costs',t:PT.C}], outs:[{n:'Income',t:PT.C}], hasProg:true, nameEdit:true, hasItems:true, itemType:'co' },
  sum:   { cat:'math', icon:'∑',    label:'SUM',          ins:[{n:'A',t:PT.A},{n:'B',t:PT.A},{n:'C',t:PT.A},{n:'D',t:PT.A}], outs:[{n:'Result',t:PT.C}] },
  sub2:  { cat:'math', icon:'−',    label:'Subtract',     ins:[{n:'A',t:PT.C},{n:'B',t:PT.C}], outs:[{n:'Result',t:PT.C}] },
  mul:   { cat:'math', icon:'×',    label:'Multiply',     ins:[{n:'A',t:PT.A},{n:'B',t:PT.N}], outs:[{n:'Result',t:PT.C}] },
  pct:   { cat:'math', icon:'%',         label:'Percent',      ins:[{n:'Val',t:PT.C},{n:'%',t:PT.P}], outs:[{n:'Result',t:PT.C}] },
  wip:   { cat:'wip',  icon:'📊', label:'WIP',
    ins:[{n:'Costs',t:PT.C},{n:'+ Top',t:PT.C},{n:'+ Bottom',t:PT.C}],
    outs:[{n:'Total Income',t:PT.C},{n:'Actual Costs',t:PT.C},{n:'Revenue Earned',t:PT.C},{n:'Gross Profit',t:PT.C},{n:'Margin JTD',t:PT.P},{n:'Remaining',t:PT.C},{n:'Accrued',t:PT.C},{n:'Backlog',t:PT.C}],
    master:true, hasFields:true
  },
  watch: { cat:'watch',icon:'📊', label:'Watch',        ins:[{n:'Value',t:PT.A}], outs:[], nameEdit:true },
  note:  { cat:'note', icon:'📌', label:'Note',         ins:[], outs:[] },
};
// ── Category tree for sidebar ──
var CATS = [
  { name:'Master',    items:['wip'] },
  { name:'Structure', items:['t1','t2'] },
  { name:'Costs',     items:['labor','mat','gc','burden','other'] },
  { name:'Subs & COs',items:['sub','po','inv','co'] },
  { name:'Math',      items:['sum','sub2','mul','pct'] },
  { name:'Output',    items:['watch'] },
  { name:'Notes',     items:['note'] },
];

// ── State ──
var nodes = [], wires = [], nid = 1;
var frames = []; // NG8: group boxes — additive overlay, never wired, never in calcs
var measurements = []; // Site-plan survey measurements (distance/area). Additive geometry:
                       // { id, mode:'distance'|'area', pts:[{lat,lng}], pitch, label }.
                       // Never wired, never in cost calcs — pure annotation persisted on the blob.
var panX = 0, panY = 0, zoom = 1;
var jobId = null;
// n8n-style "Clean Mode" — flat calm nodes + wires. Default ON; persisted
// per-user (anyone who toggled it off keeps that choice).
var cleanMode = (function(){ try { var v = localStorage.getItem('ngCleanMode'); return v === null ? true : v === '1'; } catch(_) { return true; } })();
function setCleanMode(v){ cleanMode = !!v; try { localStorage.setItem('ngCleanMode', cleanMode ? '1' : '0'); } catch(_){} return cleanMode; }
function getCleanMode(){ return cleanMode; }
// Site-plan view mode (Slice 1) — a spatial rendering of the SAME graph:
// only building (t1) + the master WIP node show, as blocks, with the existing
// t1->wip wires flowing inward. RENDER-ONLY — nodes, wires, values, and
// persistence are all untouched; toggling back to 'graph' restores everything.
// Mapping-only: the abstract card/wire graph is retired, so site-plan is the only
// mode. Default to 'siteplan' regardless of any persisted value (openNodeGraph also
// forces it on each open); 'graph' is no longer reachable from the UI.
var viewMode = 'siteplan';
function setViewMode(v){ viewMode = (v === 'siteplan') ? 'siteplan' : 'graph'; try { localStorage.setItem('ngViewMode', viewMode); } catch(_){} return viewMode; }
function getViewMode(){ return viewMode; }
// Node types shown as spatial blocks in site-plan mode (Slice 1: buildings + WIP hub).
function sitePlanVisible(t){ return t === 't1' || t === 'wip'; }
// Site-plan footprint size for a building (t1) — area roughly proportional to
// budget so a site reads with varied block sizes, clamped to a sane range.
// A node.footprint {w,h} override (set by drag-resize in a later slice) wins.
function budgetFootprint(b){
  b = Number(b) || 0;
  var f = b > 0 ? Math.min(1, Math.sqrt(b) / Math.sqrt(150000)) : 0.25;
  return { w: Math.round(190 + f * 110), h: Math.round(104 + f * 76) };
}
// Real-world building footprint for SATELLITE/geo mode, returned in graph UNITS.
// budgetFootprint's pixel sizes (~190-300px = ~95-150m at SP_M_PER_UNIT) dwarf
// real buildings on the imagery; here we size in METERS (budget-aware, ~12-35m
// wide) then convert via SP_M_PER_UNIT so a block matches building scale.
function spBuildingFootprint(b){
  b = Number(b) || 0;
  var f = b > 0 ? Math.min(1, Math.sqrt(b) / Math.sqrt(150000)) : 0.2;
  var wM = 12 + f * 23, hM = 9 + f * 16;        // ~12-35m wide, ~9-25m deep
  return { w: Math.round(wM / SP_M_PER_UNIT), h: Math.round(hM / SP_M_PER_UNIT) };
}
// Site-plan drill-in focus (Slice 3): when set to an id-map, only those nodes
// (+ the WIP hub) render in site-plan mode — used to drill into one building's
// phases/costs. View-state only; never persisted. ui.js sets it on dbl-click.
var _spFocusSet = null;
function setSitePlanFocusSet(s){ _spFocusSet = (s && typeof s === 'object') ? s : null; }
// Is this node visible in site-plan mode right now? Gates BOTH renderNodes
// (ui.js) and drawWires (below) so node + wire visibility never diverge.
function spNodeVisible(type, id){
  // Site Plan (satellite OR abstract): the WIP hub + its shared/site-cost chips live
  // in the sidebar metrics panel, never on the canvas. WIP data is now read from the
  // job (getJobWIP), so the hub node is purely vestigial here — hidden unconditionally.
  // Visibility-only: the wip node object + every wire stay alive, so getOutput totals
  // are unchanged. spNodeVisible is consulted ONLY in site-plan render paths (renderNodes
  // gates on sitePlan; drawWires on viewMode==='siteplan'), so the abstract graph is
  // byte-identical — the WIP node still renders there as before.
  if (_spFocusSet) {
    if (type === 'wip') return false;          // drilled-in: hub stays off-canvas (a building wires INTO it, so it would otherwise leak via the focus set)
    return _spFocusSet[id] === 1;
  }
  if (type === 'wip') return false;            // whole-site: hub lives in the sidebar
  if (type === 't1' || type === 't2') return true;   // buildings + phases
  var _dd = DEFS[type];
  if (_dd && (_dd.cat === 'cost' || _dd.cat === 'sub' || _dd.cat === 'co')) return true; // costs/subs/POs/invoices/COs show on the whole-site map too (fanned around their building); so an added node never just vanishes
  return false;                                // utility nodes (watch/note/math) stay off-canvas
}
// First ins/outs index on a def whose port type can connect with `type` in
// the given direction ('in'|'out'). Used to auto-wire added/spliced nodes.
function firstCompatPort(def, type, dir){
  if(!def) return 0;
  var list = dir === 'out' ? def.outs : def.ins;
  if(!list || !list.length) return 0;
  for(var i=0;i<list.length;i++){
    var a = dir === 'out' ? list[i].t : type, b = dir === 'out' ? type : list[i].t;
    if(canConn(a,b)) return i;
  }
  return 0;
}
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
    entry = { id:id, jobId:jobId, buildingId:'', phase:label||'New Phase', workScope:'in-house', locked:false, pctComplete:0, materials:0, labor:0, sub:0, equipment:0, phaseBudget:0, asSoldRevenue:0, hoursWeek:0, hoursTotal:0, rate:40, notes:'', dateAdded:ts };
    appData.phases.push(entry);
    if(typeof saveData === 'function') saveData();
    return entry;
  }

  if(type === 'sub'){
    // Subs are first-class (Phase A) — never push to appData.subs
    // (the legacy per-job inline array). Add to the global
    // directory + fire a server-side create so it persists. The
    // node references the directory id; deleting the node leaves
    // the directory entry intact (user removes it from the Subs
    // sub-tab if they want it gone).
    id = 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    entry = {
      id: id,
      name: label || 'New Sub',
      trade: '',
      contact_name: null,
      phone: null,
      email: null,
      status: 'active'
    };
    if (!Array.isArray(appData.subsDirectory)) appData.subsDirectory = [];
    appData.subsDirectory.push(entry);
    // Best-effort server persist — keeps directory idempotent
    // across devices. If unauthenticated/offline, the local copy
    // is still useful for this session.
    if (window.agxApi && window.agxApi.isAuthenticated && window.agxApi.isAuthenticated()) {
      try {
        window.agxApi.subs.create({
          id: id,
          name: entry.name,
          status: 'active'
        }).catch(function(err) {
          console.warn('[engine] sub directory create failed:', err && err.message);
        });
      } catch (e) {}
    }
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
    revenue: 0,
    jobFields: {},
    attachedTo: null,
  };
  if(data){
    if(data._val != null) n.value = data._val;
    if(data.budget) n.budget = data.budget;
    if(data.pctComplete) n.pctComplete = data.pctComplete;
    if(type === 't2' && data.asSoldRevenue != null) n.revenue = data.asSoldRevenue;
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

  // Cost nodes (labor, mat, gc, other, burden). Line-level data — manual
  // items + any QuickBooks cost lines linked to this node — is the actual
  // total; n.value (the manual "QuickBooks Total" shortcut field) is only the
  // fallback "used if no line entries". So linked QB lines SUPERSEDE a typed
  // total rather than adding to it (no double-count), while still flowing
  // through when the node has no manual entry — previously they were ignored.
  if(n.type === 'labor' || n.type === 'mat' || n.type === 'gc' || n.type === 'other' || n.type === 'burden'){
    // QB import is now folded into the job's actual cost as a single job-level
    // total (see ui.js ngActualCosts assembly) — NOT per-node here — so it can't
    // double-count. This node reflects only manual line entries / typed total.
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

  // Sub: single output = sum of wired cost inputs, or n.value
  // (the QuickBooks Total fallback) when no cost wires feed in.
  // Lets the user point at a single QB sub-trade rollup without
  // wiring labor/mat/gc/other children explicitly.
  if(n.type === 'sub'){
    var subWired = 0;
    wires.forEach(function(w){
      if(w.toNode === n.id){ var fn = findNode(w.fromNode); if(fn) subWired += getOutput(fn, w.fromPort); }
    });
    v = subWired || (n.value || 0);
    _comp[n.id] = false; return v;
  }

  // CO: single output = income from items or data
  if(n.type === 'co'){
    v = itemsTotal || (n.data ? n.data.income || 0 : 0);
    _comp[n.id] = false; return v;
  }

  // T1/T2: single output = sum of wired COST inputs + own items.
  // CO inputs don't add to cost total; they accumulate as revenue additions
  // on the node, proportional to the wire's allocPct.
  if(n.type === 't1' || n.type === 't2'){
    v = itemsTotal;
    var coRev = 0;
    wires.forEach(function(w){
      if(w.toNode === n.id){
        var fn = findNode(w.fromNode); if(!fn) return;
        var amt = getOutput(fn, w.fromPort);
        if(fn.type === 'co'){
          var ap = (w.allocPct != null) ? w.allocPct : 100;
          coRev += amt * (ap / 100);
        }
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
    var computedPct = getWIPWeightedPct(n);
    var pctComp = (computedPct != null) ? computedPct : (jf.pctComplete || 0);
    var actualCosts = 0;
    var accruedCosts = 0;
    var coIncomeWired = 0;
    wires.forEach(function(w){
      if(w.toNode === n.id){
        var fn = findNode(w.fromNode); if(!fn) return;
        if(fn.type === 'co'){
          var coAp = (w.allocPct != null) ? w.allocPct : 100;
          coIncomeWired += getOutput(fn, w.fromPort) * (coAp / 100);
        }
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
    var backlog = totalIncome - revEarned;
    var wipOuts = [totalIncome, actualCosts, revEarned, grossProfit, marginJTD, remaining, accruedCosts, backlog];
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

// Sum of QuickBooks cost lines the user has LINKED to this node
// (qb_cost_lines.linked_node_id === node.id, hydrated into
// appData.qbCostLines on load). Linking a QB actual to a cost node is how
// real spend is meant to flow into the WIP actual-cost track — this helper
// is the ONE place that sum enters the engine, so getOutput + getActual
// both add it and stay consistent. Added to (not replacing) the node's
// manual total, matching the side-by-side "Linked QB lines" node hint.
function _qbLinked(nodeId){
  try {
    var lines = (typeof appData !== 'undefined' && appData && appData.qbCostLines) || null;
    if(!lines || !lines.length) return 0;
    var t = 0;
    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      if((l.linked_node_id || l.linkedNodeId) === nodeId) t += Number(l.amount || 0);
    }
    return t;
  } catch(e){ return 0; }
}

function getActual(n){
  if(!n) return 0;
  if(_compA[n.id]) return 0;
  _compA[n.id] = true;
  var v = 0, iT = _itemsTotal(n);
  // Line-level data (manual items + linked QB) supersedes the manual "QB Total"
  // fallback (n.value) — same rule as getOutput; keeps actual = output.
  if(n.type==='labor'||n.type==='mat'||n.type==='gc'||n.type==='other'||n.type==='burden'){ v = iT || n.value || 0; } // QB folded once at job level (ui.js), not per-node — see getOutput note
  else if(n.type==='inv'){ v = iT; }
  else if(n.type==='po'){
    // Sum wired Invoice amounts on the PO's input port
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) v += getOutput(fn, w.fromPort); }
    });
  }
  else if(n.type==='sub'){
    wires.forEach(function(w){
      if(w.toNode!==n.id) return;
      var fn=findNode(w.fromNode); if(!fn) return;
      // PO with its own direct phase wires routes cost through those
      // wires, not through this sub. Without this skip, the sub's
      // accrued / actual would double-count the same dollars on every
      // phase that the sub fans out to. The sub still shows the PO
      // visually under it, but the cost flow lives on the po→phase
      // edges.
      if(fn.type === 'po' && _poHasDirectPhaseWires(fn)) return;
      v += getActual(fn);
    });
  }
  else if(n.type==='co'){
    // CO actual costs = sum of wired cost children (mini-P&L)
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) v += getActual(fn); }
    });
  }
  else if(n.type==='t2'){
    v = iT;
    wires.forEach(function(w){
      if(w.toNode!==n.id) return;
      var fn=findNode(w.fromNode); if(!fn) return;
      if(fn.type==='co'){
        var share = getT2ShareToT1(fn, n.id);
        v += getActual(fn) * share;
      } else if(fn.type==='po' || fn.type==='sub'){
        // PO / sub can fan out to multiple phases. Honor the wire's
        // allocPct so each phase only sees its share — otherwise a
        // sub wired to N phases double-counts the same dollars at
        // every one of them. allocPct=100 (or undefined) keeps the
        // legacy behavior; lower values apportion across phases.
        v += getActual(fn) * (_alloc(w) / 100);
      } else {
        v += getActual(fn);
      }
    });
  }
  else if(n.type==='t1'){
    v = iT;
    wires.forEach(function(w){
      if(w.toNode!==n.id) return;
      var fn=findNode(w.fromNode); if(!fn) return;
      if(fn.type==='t2' || fn.type==='co'){
        var share = getT2ShareToT1(fn, n.id);
        v += getActual(fn) * share;
      } else if(fn.type==='po' || fn.type==='sub'){
        v += getActual(fn) * (_alloc(w) / 100);
      } else {
        v += getActual(fn);
      }
    });
  }
  _compA[n.id] = false;
  return v;
}

// Read a wire's allocation percent for cost-side fan-out. Defaults to
// 100 when undefined so existing 1-to-1 graphs behave exactly as
// before. The cost engine uses this for PO→phase and sub→phase wires
// so a contract that serves multiple phases is apportioned rather
// than double-summed at every destination.
function _alloc(w){
  if(!w) return 100;
  return (w.allocPct != null) ? Number(w.allocPct) || 0 : 100;
}

// True when a PO has at least one outgoing wire to a t2 phase node.
// When this is the case, the sub the PO sits under MUST NOT include
// that PO in its own actual/accrued rollup — the PO's cost flows
// directly through po→phase wires (with allocPct) and would double-
// count otherwise. POs without direct phase wires keep the legacy
// behavior of routing through the sub.
function _poHasDirectPhaseWires(po){
  if(!po || po.type !== 'po') return false;
  return wires.some(function(w){
    if(w.fromNode !== po.id) return false;
    var t = findNode(w.toNode);
    return t && t.type === 't2';
  });
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
      if(parent.type==='t2'){
        // Prefer wire-level pctComplete (alloc-weighted) when available
        var wp = getT2WeightedPct(parent);
        if(wp != null) results.push({ pct: wp, weight: parent.budget || 0 });
      } else if(parent.type==='t1'){
        var t1p = getT1WeightedPct(parent);
        if(t1p != null) results.push({ pct: t1p, weight: parent.budget || 0 });
      } else if(parent.type==='co'){
        var coWPct = getT2WeightedPct(parent);
        if(coWPct != null) results.push({ pct: coWPct, weight: parent.budget || 0 });
      } else if(parent.type==='sub'){
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

// ── Phase revenue allocation helpers ──
// A T2 (phase) node allocates its revenue across its wired T1 (building) ancestors
// using the allocPct field on each phase→building wire. Allocations are pct values
// (0-100) that should total 100 across all T1 wires from that phase.

// Return wires from T2 phase node to T1 building nodes (outgoing, connecting to Costs port)
function getPhaseAllocWires(t2Id){
  return wires.filter(function(w){
    if(w.fromNode !== t2Id) return false;
    var parent = findNode(w.toNode);
    return parent && parent.type === 't1';
  });
}

// Snap a near-integer allocPct to its exact integer, but only when
// VERY close (within 0.001%). Prevents drift accumulation from
// repeated manual-edit + rebalance cycles where the manual value
// stored at limited UI precision (e.g. 14.286) pollutes the auto
// siblings on the next rebalance. Genuinely fractional shares
// (100/7 = 14.2857…) stay full-precision so sums equal 100 exactly.
// Investigated as part of the allocPct drift task in
// memoized-inventing-mountain.md.
function snapAllocPct(v){
  if (v == null || !isFinite(v)) return v;
  var rounded = Math.round(v);
  if (Math.abs(v - rounded) < 0.001) return rounded;
  return v;
}

// Split freely-available percentage equally across all `_auto` (non-manual) wires.
// Wires the user has explicitly set (_auto=false) keep their pct; auto wires
// absorb the remainder (100 - sum-of-manual) equally.
function rebalancePhaseAllocations(t2Id){
  var aw = getPhaseAllocWires(t2Id);
  if(!aw.length) return;
  // Treat wires without _auto flag as auto by default (new wires start auto)
  aw.forEach(function(w){ if(w._auto == null) w._auto = true; });
  var manualSum = 0, autoWires = [];
  aw.forEach(function(w){
    if(w._auto) autoWires.push(w);
    else manualSum += (w.allocPct || 0);
  });
  if(autoWires.length > 0){
    var each = snapAllocPct(Math.max(0, 100 - manualSum) / autoWires.length);
    autoWires.forEach(function(w){ w.allocPct = each; });
  }
}

// Return outgoing wires from a CO node to any parent (T1/T2/WIP).
function getCOAllocWires(coId){
  return wires.filter(function(w){
    if(w.fromNode !== coId) return false;
    var parent = findNode(w.toNode);
    return parent && (parent.type === 't1' || parent.type === 't2' || parent.type === 'wip');
  });
}

function rebalanceCOAllocations(coId){
  var aw = getCOAllocWires(coId);
  if(!aw.length) return;
  aw.forEach(function(w){ if(w._auto == null) w._auto = true; });
  var manualSum = 0, autoWires = [];
  aw.forEach(function(w){
    if(w._auto) autoWires.push(w);
    else manualSum += (w.allocPct || 0);
  });
  if(autoWires.length > 0){
    // snapAllocPct kills the drift accumulation; see docs above
    // rebalancePhaseAllocations.
    var each = snapAllocPct(Math.max(0, 100 - manualSum) / autoWires.length);
    autoWires.forEach(function(w){ w.allocPct = each; });
  }
}

// Revenue allocated from one T2 phase to a specific T1 building via the wire.
function getPhaseRevenueToBuilding(t2n, t1Id){
  if(!t2n || t2n.type !== 't2') return 0;
  var rev = t2n.revenue || 0;
  var w = wires.find(function(w){ return w.fromNode === t2n.id && w.toNode === t1Id; });
  if(!w) return 0;
  var pct = (w.allocPct != null) ? w.allocPct : 0;
  return rev * (pct / 100);
}

// Income allocated from one CO to a specific parent via the wire.
function getCOIncomeToParent(coNode, parentId){
  if(!coNode || coNode.type !== 'co') return 0;
  _comp = {}; var income = getOutput(coNode, 0);
  var w = wires.find(function(w){ return w.fromNode === coNode.id && w.toNode === parentId; });
  if(!w) return 0;
  var pct = (w.allocPct != null) ? w.allocPct : 0;
  return income * (pct / 100);
}

// Total phase-allocated revenue landing on a T1 building (phases + COs).
// Revenue basis IDENTICAL to jobs.js phaseRevenue(): legacy rows carry a dead
// asSoldRevenue:0 with the real number in asSoldPhaseBudget, so this MUST be a
// truthy chain (not a null-check chain) or the fold silently reads $0.
function matrixPhaseRevenue(p){
  return (p && (p.asSoldRevenue || p.asSoldPhaseBudget || p.phaseBudget)) || 0;
}
// Scopes allocated to a building via the phase-allocation MATRIX (appData.phases
// keyed by buildingId) have NO t2 node and NO wire, so the wire-only rollups miss
// them. Return this T1's matrix phases, DEDUPED against any wired t2 scope on the
// same building (wired t2 node's phase id === node.data.id) so a phase that is
// BOTH wired and matrix-tagged is never counted twice. Engine is a plain global
// script — guard appData like the rest of this file. Join = t1 node's linked appData
// building id (t1n.data.id === phase.buildingId); buildingId is globally unique so
// no jobId filter is needed (and one keyed on currentJobId would wrongly zero
// off-screen recomputes).
function matrixPhasesForT1(t1n){
  if(!t1n || t1n.type !== 't1') return [];
  if(typeof appData === 'undefined' || !appData || !Array.isArray(appData.phases)) return [];
  var bId = (t1n.data && t1n.data.id) || t1n.dataId;
  if(!bId) return [];
  var wiredPh = {};
  wires.forEach(function(w){
    if(w.toNode !== t1n.id) return;
    var src = findNode(w.fromNode);
    if(src && src.type === 't2'){ var pid = (src.data && src.data.id) || src.dataId; if(pid) wiredPh[pid] = 1; }
  });
  return appData.phases.filter(function(p){ return p && p.buildingId === bId && !wiredPh[p.id]; });
}
function getBuildingAllocatedRevenue(t1n){
  if(!t1n || t1n.type !== 't1') return 0;
  var total = 0;
  wires.forEach(function(w){
    if(w.toNode !== t1n.id) return;
    var src = findNode(w.fromNode);
    if(src && src.type === 't2') total += getPhaseRevenueToBuilding(src, t1n.id);
    else if(src && src.type === 'co') total += getCOIncomeToParent(src, t1n.id);
  });
  // + matrix-allocated scopes (no t2 node/wire): full phaseRevenue, allocated 100%
  // to this one building. Deduped vs wired t2 inside matrixPhasesForT1. This is what
  // makes a matrix-built building's Revenue tile stop reading $0. The job's revenue
  // dollars are contract×%, so this only feeds the building tile + rollup WEIGHT —
  // never a second job-level dollar total (no double-count).
  matrixPhasesForT1(t1n).forEach(function(p){ total += matrixPhaseRevenue(p); });
  return total;
}

// Weighted-average pctComplete across a T2/CO node's outgoing T1 wires.
// Each wire can hold its own pctComplete; weights are wire.allocPct.
// Falls back to the node's own pctComplete when NO wires have been set at all.
// Once any wire has a pct, unset wires count as 0% so partial progress
// is reflected proportionally across all allocations.
// A scope (t2) can break its completion into weighted PHASES — node.phases[] =
// [{id,name,weight,pct}] (e.g. a Gutter scope → Demo + Putback). The scope's %
// is the weight-weighted average of its phases' % (weights default equal). When
// a scope has no phase breakdown this returns null and the caller keeps the
// existing units/wire/manual % — so pre-phase jobs are unchanged. This is the
// single source of the phase→scope math (used by the updateT1Progress flush,
// which then carries it up to the building/job/WIP rollups unchanged).
function scopePctFromPhases(n){
  if(!n || n.type !== 't2') return null;
  var ph = n.phases;
  if(!Array.isArray(ph) || !ph.length) return null;
  var wSum = 0, acc = 0, i;
  for(i=0;i<ph.length;i++){
    var w = Number(ph[i].weight); if(!(w > 0)) w = 0;
    var pc = Number(ph[i].pct); if(!(pc >= 0)) pc = 0; if(pc > 100) pc = 100;
    wSum += w; acc += w * pc;
  }
  if(wSum <= 0){ // all weights zero → fall back to a plain average
    var s = 0; for(i=0;i<ph.length;i++){ var p2 = Number(ph[i].pct)||0; s += (p2<0?0:(p2>100?100:p2)); }
    return s / ph.length;
  }
  return acc / wSum;
}

function getT2WeightedPct(t2n){
  if(!t2n || (t2n.type !== 't2' && t2n.type !== 'co')) return (t2n && t2n.pctComplete) || 0;
  // Phase-driven scope: its own phase breakdown is authoritative over wires.
  if(t2n.type === 't2'){ var _sp = scopePctFromPhases(t2n); if(_sp != null) return _sp; }
  var aw = (t2n.type === 'co') ? getCOAllocWires(t2n.id) : getPhaseAllocWires(t2n.id);
  if(!aw.length) return t2n.pctComplete || 0;
  var anyPct = aw.some(function(w){ return w.pctComplete != null; });
  if(!anyPct) return t2n.pctComplete || 0;
  var sumW = 0, sumPct = 0;
  aw.forEach(function(w){
    var ap = (w.allocPct != null) ? w.allocPct : 0;
    var pc = (w.pctComplete != null) ? w.pctComplete : 0;
    sumPct += pc * ap; sumW += ap;
  });
  if(sumW === 0) return 0;
  return sumPct / sumW;
}

// Weighted-average pctComplete for a T1 building from all connected T2/CO wires.
// Each incoming wire carries its own pctComplete; weights are the dollar-amount
// of revenue allocated to this T1 (allocPct × source.revenue for T2, allocPct ×
// CO income for CO). Falls back to the T1's own pctComplete when no wires have
// pct set. Once any wire has a pct, unset wires count as 0%.
// Derived % complete for a UNIT-MODE scope wire = units-done ÷ the target
// building's unit count. Returns null when the wire isn't unit-mode or the
// target building has no units set (caller then falls back to wire.pctComplete).
// Single source of the units→% math (used by the building rollup + the
// updateT1Progress flush that keeps wire.pctComplete in sync for other readers).
function wireUnitPct(w){
  if(!w || w.trackMode !== 'units') return null;
  var b = findNode(w.toNode);
  var cnt = (b && b.units && b.units.length) ? b.units.length : 0;
  if(cnt <= 0) return null;
  var done = Math.max(0, Math.min(Number(w.unitsDone) || 0, cnt));
  return Math.round(done / cnt * 1000) / 10;
}

function getT1WeightedPct(t1n){
  if(!t1n || t1n.type !== 't1') return (t1n && t1n.pctComplete) || 0;
  // When any incoming SCOPE (phase/CO) wire tracks completion by its own units
  // (w.trackMode==='units'), the scopes drive this building's % — skip the
  // building-level unit/level short-circuit and fall through to the
  // revenue-weighted phase/CO branch (each such wire's pctComplete is the
  // derived units-done ÷ building-units, flushed by updateT1Progress). Buildings
  // whose scopes are all percent-mode keep the classic units→levels→wire cascade,
  // so existing jobs are unchanged.
  // SCOPES-FIRST (John's model, 2026-07-19): a building's % is the revenue-weighted
  // average of its SCOPES' % — wired t2/CO scopes PLUS matrix-allocated phases
  // (appData.phases by buildingId, no node/wire). Scopes OUTRANK units/levels: a
  // scope-tracked building rolls up from Stucco/Siding/Paint, not from a floor
  // average (which halved a 20% level to 10% on a 2-floor building). Units/levels
  // remain the fallback ONLY for buildings that have no scopes at all.
  var incoming = [];
  wires.forEach(function(w){
    if(w.toNode !== t1n.id) return;
    var src = findNode(w.fromNode);
    if(src && (src.type === 't2' || src.type === 'co')) incoming.push({w:w, src:src});
  });
  var mxPhases = matrixPhasesForT1(t1n);
  if(incoming.length || mxPhases.length){
    var sumW = 0, sumPct = 0, anyMarked = false;
    incoming.forEach(function(r){
      var ap = (r.w.allocPct != null) ? r.w.allocPct : 100;
      var rev;
      if(r.src.type === 'co'){ _comp = {}; rev = getOutput(r.src, 0); }
      else { rev = (r.src.revenue || 0); }
      var weight = ap * rev;
      // Phase-driven scope → its weighted phase %; else unit-mode wire → units-done ÷
      // building units; else the wire's own pctComplete; else the source's pctComplete.
      var _sp = (r.src.type === 't2') ? scopePctFromPhases(r.src) : null;
      var _uPc = wireUnitPct(r.w);
      var pc = (_sp != null) ? _sp : ((_uPc != null) ? _uPc : ((r.w.pctComplete != null) ? r.w.pctComplete : (r.src.pctComplete || 0)));
      if(pc > 0) anyMarked = true;
      sumPct += pc * weight; sumW += weight;
    });
    // Matrix scopes: 100% allocated to this one building; pct = the phase record's own %.
    mxPhases.forEach(function(p){
      var weight = 100 * matrixPhaseRevenue(p);
      var pc = (p.pctComplete != null) ? Math.max(0, Math.min(100, Number(p.pctComplete))) : 0;
      if(pc > 0) anyMarked = true;
      sumPct += pc * weight; sumW += weight;
    });
    // No-crater transition guard: if NOT ONE scope has been marked yet, the scopes
    // carry no signal — don't force the building to 0% and wipe its prior progress.
    // Fall through to the building's own units/levels/manual % below. The instant any
    // scope is marked (>0), scopes take over and drive the roll-up. Once a scope is
    // marked, an unmarked sibling correctly counts as 0 in the weighted average.
    if(anyMarked){
      if(sumW === 0){
        // Zero-revenue fallback: plain average of every contributing scope pct.
        var sW=0,sP=0;
        incoming.forEach(function(r){
          var ap = (r.w.allocPct != null) ? r.w.allocPct : 100;
          var _sp2 = (r.src.type === 't2') ? scopePctFromPhases(r.src) : null;
          var _uPc2 = wireUnitPct(r.w);
          var pc = (_sp2 != null) ? _sp2 : ((_uPc2 != null) ? _uPc2 : ((r.w.pctComplete != null) ? r.w.pctComplete : (r.src.pctComplete || 0)));
          sP += pc*ap; sW += ap;
        });
        mxPhases.forEach(function(p){ var pc=(p.pctComplete!=null)?Math.max(0,Math.min(100,Number(p.pctComplete))):0; sP += pc*100; sW += 100; });
        return sW === 0 ? 0 : sP/sW;
      }
      return sumPct / sumW;
    }
  }
  // No scopes → the building's own unit/level breakdown drives it, then its manual pct.
  // Each unit/level carries a `pct` (0-100); a bare `done:true` reads as 100.
  function _uPct(u){ var p=(u&&u.pct!=null)?Number(u.pct):(u&&u.done?100:0); return (p>=0)?(p>100?100:p):0; }
  if(t1n.units && t1n.units.length){
    var _us=0; for(var _i=0;_i<t1n.units.length;_i++){ _us+=_uPct(t1n.units[_i]); }
    return _us / t1n.units.length;
  }
  if(t1n.levels && t1n.levels.length){
    var _ls=0; for(var _k=0;_k<t1n.levels.length;_k++){ var _L=t1n.levels[_k]; _ls+=((_L.pct!=null)?Math.max(0,Math.min(100,Number(_L.pct))):(_L.done?100:0)); }
    return _ls / t1n.levels.length;
  }
  return t1n.pctComplete || 0;
}

// Revenue-weighted pctComplete for a WIP node, rolled up from connected
// T1/T2/CO sources. Each source contributes its own weighted pct times its
// allocated revenue dollars. Returns null when no source has any pct data,
// signaling the caller to fall back to the manually-entered WIP pct.
function getWIPWeightedPct(wipn){
  if(!wipn || wipn.type !== 'wip') return null;
  var rollup = [];
  var anySrcPct = false;
  wires.forEach(function(w){
    if(w.toNode !== wipn.id) return;
    var src = findNode(w.fromNode); if(!src) return;
    if(src.type === 't1'){
      var t1Pct = getT1WeightedPct(src);
      var t1Rev = getBuildingAllocatedRevenue(src);
      // Detect whether any T2/CO wire feeding this T1 has a wire-level pct
      var hasAny = wires.some(function(ww){
        if(ww.toNode !== src.id) return false;
        var ss = findNode(ww.fromNode);
        return ss && (ss.type === 't2' || ss.type === 'co') && ww.pctComplete != null;
      });
      if(hasAny) anySrcPct = true;
      else if(src.pctComplete != null && src.pctComplete !== 0) anySrcPct = true;
      rollup.push({pct: t1Pct, rev: t1Rev});
    } else if(src.type === 't2'){
      var t2Pct = getT2WeightedPct(src);
      var aw = getPhaseAllocWires(src.id);
      var hasAny2 = aw.some(function(ww){ return ww.pctComplete != null; });
      if(hasAny2) anySrcPct = true;
      else if(src.pctComplete != null && src.pctComplete !== 0) anySrcPct = true;
      rollup.push({pct: t2Pct, rev: src.revenue || 0});
    } else if(src.type === 'co'){
      _comp = {}; var coInc = getOutput(src, 0);
      var ap = (w.allocPct != null) ? w.allocPct : 100;
      var coPct = getT2WeightedPct(src);
      var coAw = getCOAllocWires(src.id);
      var hasAny3 = coAw.some(function(ww){ return ww.pctComplete != null; });
      if(hasAny3) anySrcPct = true;
      else if(src.pctComplete != null && src.pctComplete !== 0) anySrcPct = true;
      rollup.push({pct: coPct, rev: coInc * (ap / 100)});
    }
  });
  if(!rollup.length || !anySrcPct) return null;
  var sumW = 0, sumPct = 0;
  rollup.forEach(function(r){ sumPct += r.pct * r.rev; sumW += r.rev; });
  if(sumW === 0){
    return rollup.reduce(function(s,r){ return s + r.pct; }, 0) / rollup.length;
  }
  return sumPct / sumW;
}

// Share of a T2/CO node's totals (actual, accrued) attributable to a specific
// parent. Split = (wire.allocPct × wire.pctComplete) / sum(allocPct × pctComplete)
// across all the node's outgoing allocation wires. When no wire has pctComplete
// set, falls back to pure allocPct split. Returns 0..1.
function getT2ShareToT1(t2n, t1Id){
  if(!t2n || (t2n.type !== 't2' && t2n.type !== 'co')) return 0;
  var aw = (t2n.type === 'co') ? getCOAllocWires(t2n.id) : getPhaseAllocWires(t2n.id);
  if(!aw.length) return 0;
  var anyPct = aw.some(function(w){ return w.pctComplete != null; });
  var myW = wires.find(function(w){ return w.fromNode === t2n.id && w.toNode === t1Id; });
  if(!myW) return 0;
  if(anyPct){
    var tot = 0, mine = 0;
    aw.forEach(function(w){
      var ap = (w.allocPct != null) ? w.allocPct : 0;
      var pc = (w.pctComplete != null) ? w.pctComplete : 0;
      var prod = ap * pc;
      tot += prod;
      if(w === myW) mine = prod;
    });
    if(tot === 0) return 0;
    return mine / tot;
  }
  // Fallback: alloc-only split
  var sumA = 0;
  aw.forEach(function(w){ sumA += (w.allocPct != null) ? w.allocPct : 0; });
  if(sumA === 0) return 0;
  return ((myW.allocPct != null) ? myW.allocPct : 0) / sumA;
}

function getAccrued(n){
  if(!n) return 0;
  if(_compAc[n.id]) return 0;
  _compAc[n.id] = true;
  var v = 0, iT = _itemsTotal(n);
  // Cost-leaf types (labor/mat/gc/other/burden) intentionally have NO
  // explicit branch here — they're always 100% actual, never accrued,
  // so they fall through to v=0. T1/T2 rollups recurse via getAccrued
  // and pick up zero from leaves and the real accrued from POs/subs.
  // This is by design; don't add a leaf branch.
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
      if(w.toNode!==n.id) return;
      var fn=findNode(w.fromNode); if(!fn) return;
      // Same skip as getActual — PO with direct phase wires bypasses
      // the sub for cost flow so the dollars aren't counted twice.
      if(fn.type === 'po' && _poHasDirectPhaseWires(fn)) return;
      v += getAccrued(fn);
    });
  }
  else if(n.type==='co'){
    wires.forEach(function(w){
      if(w.toNode===n.id){ var fn=findNode(w.fromNode); if(fn) v += getAccrued(fn); }
    });
  }
  else if(n.type==='t2'){
    wires.forEach(function(w){
      if(w.toNode!==n.id) return;
      var fn=findNode(w.fromNode); if(!fn) return;
      if(fn.type==='co'){
        var share = getT2ShareToT1(fn, n.id);
        v += getAccrued(fn) * share;
      } else if(fn.type==='po' || fn.type==='sub'){
        // Same allocation rule as getActual — a PO or sub wired to
        // multiple phases apportions its accrued by wire.allocPct.
        // Without this, every phase fed by the sub used to see the
        // full sub accrued, which was the double-up the j5 audit
        // surfaced.
        v += getAccrued(fn) * (_alloc(w) / 100);
      } else {
        v += getAccrued(fn);
      }
    });
  }
  else if(n.type==='t1'){
    wires.forEach(function(w){
      if(w.toNode!==n.id) return;
      var fn=findNode(w.fromNode); if(!fn) return;
      if(fn.type==='t2' || fn.type==='co'){
        var share = getT2ShareToT1(fn, n.id);
        v += getAccrued(fn) * share;
      } else if(fn.type==='po' || fn.type==='sub'){
        v += getAccrued(fn) * (_alloc(w) / 100);
      } else {
        v += getAccrued(fn);
      }
    });
  }
  _compAc[n.id] = false;
  return v;
}

// ── Site-plan geo projection (Phase 2-A) ────────────────────────────────
// Local Web-Mercator mapping so a slaved google.maps.Map can be driven one-way
// from the engine camera. One graph unit = SP_M_PER_UNIT meters (fixed), so map
// center + zoom derive consistently from E.pan()/E.zm() and a fixed origin (the
// job geocode). Pure math — never mutates nodes/wires/values.
var SP_M_PER_UNIT = 0.5;        // meters represented by one graph unit
var SP_MERC_C = 156543.03392;   // Web-Mercator meters/pixel at zoom 0, equator
function spMapZoom(engineZoom, lat){
  var mpp = SP_M_PER_UNIT / Math.max(0.0001, engineZoom);          // meters per screen pixel
  return Math.log(SP_MERC_C * Math.cos(lat*Math.PI/180) / mpp) / Math.LN2;
}
function spGraphToLatLng(dxUnits, dyUnits, originLat, originLng){
  var mx = dxUnits * SP_M_PER_UNIT, my = dyUnits * SP_M_PER_UNIT;   // meters east / south of origin
  var lat = originLat - (my / 111320);
  var lng = originLng + (mx / (111320 * Math.cos(originLat*Math.PI/180)));
  return { lat: lat, lng: lng };
}
function spLatLngToGraph(lat, lng, originLat, originLng){
  var my = (originLat - lat) * 111320;
  var mx = (lng - originLng) * 111320 * Math.cos(originLat*Math.PI/180);
  return { x: mx / SP_M_PER_UNIT, y: my / SP_M_PER_UNIT };          // graph units relative to origin
}
// Slice 3: the single guarded write path for a building's geo location. Sets ONLY
// node.geoLatLng (never x/y/value/budget). The caller persists via saveGraph().
function setNodeGeo(id, lat, lng){
  var n = findNode(id); if(!n) return null;
  n.geoLatLng = (isFinite(lat) && isFinite(lng)) ? { lat: lat, lng: lng } : null;
  return n.geoLatLng;
}
// Phase 1 (polygon buildings): the single guarded write for a traced footprint.
// Sets ONLY n.polygon ([{lat,lng},…], ordered ring) — never x/y/value/budget.
// Caller persists via saveGraph(). Geometry only; the cost rollups never read it.
function setNodePolygon(id, verts){
  var n = findNode(id); if(!n) return null;
  n.polygon = (verts && verts.length >= 3)
    ? verts.map(function(v){ return { lat: Number(v.lat), lng: Number(v.lng) }; })
    : null;
  return n.polygon;
}

// ── Formatting ──
function fmtC(v){ return '$'+v.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtP(v){ return v.toFixed(1)+'%'; }
function fmtV(v,t){ return t===PT.P ? fmtP(v) : t===PT.C ? fmtC(v) : v.toLocaleString(); }

// ── Save / Load ──
var GRAPH_VER = 8; // bump to force re-populate on next open
function buildGraphState(){
  return {
    ver: GRAPH_VER,
    nodes: nodes.map(function(n){
      return {
        id:n.id, type:n.type, x:n.x, y:n.y, label:n.label,
        value:n.value, collapsed:n.collapsed, noteText:n.noteText,
        items:n.items, pctComplete:n.pctComplete, budget:n.budget, revenue:n.revenue||0, jobFields:n.jobFields||{},
        _coRevApplied: n._coRevApplied||0,
        allocTarget: n.allocTarget||null,
        attachedTo: n.attachedTo||null,
        geoLatLng: (n.type==='t1' && n.geoLatLng) ? n.geoLatLng : null, // Phase 2-A: building's real lat/lng (additive; old graphs have none)
        polygon: (n.type==='t1' && n.polygon) ? n.polygon : null,       // Phase 1: traced building footprint (additive, no GRAPH_VER bump)
        levels: (n.type==='t1' && n.levels && n.levels.length) ? n.levels : null, // L/U Phase 1: floors (additive; flat buildings have none)
        units:  (n.type==='t1' && n.units  && n.units.length)  ? n.units  : null, // L/U Phase 1: units, each optionally on a level (unit.levelId)
        heightM: (n.type==='t1' && isFinite(n.heightM) && n.heightM>0) ? n.heightM : null, // 3D extrusion override in meters (additive; levels-derived when absent)
        phases: (n.type==='t2' && Array.isArray(n.phases) && n.phases.length) ? n.phases : null, // Scope→nested-phases: per-scope weighted % breakdown (additive; scopes w/o phases have none)
        dataId: n.data ? n.data.id : null
      };
    }),
    wires: wires,
    frames: frames, // NG8: persisted group boxes (additive; old graphs simply have none)
    measurements: measurements, // survey measurements (additive; old graphs simply have none)
    panX:panX, panY:panY, zoom:zoom, nid:nid
  };
}

// ── Migration framework ─────────────────────────────────────────
// Phase B — instead of a blanket reject when state.ver < GRAPH_VER,
// run the saved state through any registered migrations to bring it
// up to the current version. Each entry transforms a state of `key`
// version to one version higher. Add entries here when a future
// commit changes node shape in an incompatible way.
//
// MIGRATIONS[7] = function(state) {
//   // example: drop the unbilled output from WIP nodes (April 24 change)
//   state.nodes.forEach(function(n) { if (n.type === 'wip') delete n._unbilled; });
//   state.ver = 8;
//   return state;
// };
//
// If a migration is missing for a given step, fall back to the old
// blanket-reject behavior (re-populate from defaults).
var MIGRATIONS = {};

function migrateIfNeeded(state){
  if (!state) return null;
  var v = state.ver || 0;
  while (v < GRAPH_VER) {
    var fn = MIGRATIONS[v];
    if (typeof fn !== 'function') return null; // no path → reject (defaults take over)
    try {
      state = fn(state) || state;
      v = state.ver || (v + 1);
    } catch (e) {
      console.warn('[nodegraph] migration ' + v + ' threw:', e);
      return null;
    }
  }
  return state;
}

// ── Cloud sync (Phase A) ────────────────────────────────────────
// localStorage is now a fast offline cache; the canonical store is
// the node_graphs Postgres table behind /api/jobs/:id/graph. saveGraph
// writes both: localStorage immediately (sync), cloud in background
// (fire-and-forget, indicator updates on response). Browser quota
// pressure no longer wipes user layouts since the cloud copy is
// authoritative.
function saveGraphToCloud(state){
  if (!jobId) return;
  try {
    fetch('/api/jobs/' + encodeURIComponent(jobId) + '/graph', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    }).then(function(r){
      if (!r.ok) {
        console.warn('[nodegraph] cloud save failed:', r.status);
        if (typeof window.ngMarkSaved === 'function') window.ngMarkSaved('error');
      }
      // Successful cloud writes don't change indicator state — the
      // local saveGraph already marked it 'saved'. Cloud is the
      // background safety net.
    }).catch(function(err){
      // Offline / network error — local save still landed, so the
      // user's work isn't lost. Don't flash error for this case;
      // the next save will retry.
      console.warn('[nodegraph] cloud save network error:', err && err.message);
    });
  } catch (e) {
    // fetch itself threw (very rare; misconfigured environment)
    console.warn('[nodegraph] cloud save threw:', e && e.message);
  }
}

// Pull cloud state for the current job. Returns a Promise that
// resolves with the deserialized graph state (post-migration), or
// null if the cloud has nothing/the response is malformed.
function loadGraphFromCloud(){
  if (!jobId) return Promise.resolve(null);
  return fetch('/api/jobs/' + encodeURIComponent(jobId) + '/graph', {
    credentials: 'include'
  }).then(function(r){
    if (!r.ok) return null;
    return r.json();
  }).then(function(body){
    if (!body || !body.graph || !body.graph.nodes || !body.graph.nodes.length) return null;
    var migrated = migrateIfNeeded(body.graph);
    return migrated || null;
  }).catch(function(err){
    console.warn('[nodegraph] cloud load failed:', err && err.message);
    return null;
  });
}

// One-shot cloud sync: fetch + apply by re-using the existing
// loadGraph deserializer. Stages the cloud state into localStorage
// (as if it were a fresh save) so loadGraph picks it up, then runs
// loadGraph to populate the engine. ui.js calls this after the
// initial synchronous loadGraph render so cloud catches up if it has
// fresher data. Resolves with true if cloud had data + applied,
// false otherwise (offline / no cloud state / malformed).
function loadGraphFromCloudAndApply(){
  return loadGraphFromCloud().then(function(state){
    if (!state || !jobId) return false;
    try {
      var all = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
      all[jobId] = state;
      localStorage.setItem('agx-nodegraphs', JSON.stringify(all));
    } catch (e) {
      // Cache write failed (probably quota) — loadGraph below will
      // also fail to read, so cloud sync effectively becomes a no-op
      // for this session. The next save attempt will retry the cache
      // or cloud as appropriate.
      console.warn('[nodegraph] cloud-staged state cache write failed:', e && e.message);
      return false;
    }
    return loadGraph();
  });
}

// Set to true while the initial cloud sync is in flight on a fresh
// job-open. Suppresses cloud writes (and ngMarkSaved chrome) during
// that window so the very first render's reflexive saveGraph() call
// can't race ahead of syncFromCloud and overwrite the canonical
// cloud state with the local user's stale localStorage. ui.js flips
// this back to false once syncFromCloud settles. Local-cache writes
// still happen — only the cloud PUT is gated.
var _initialCloudSyncInFlight = false;
function setInitialCloudSyncInFlight(v){ _initialCloudSyncInFlight = !!v; }

function saveGraph(){
  if(!jobId) return;
  try {
    var state = buildGraphState();
    // Local cache write — fast, used as offline fallback + initial-paint
    // source on next open. Wrapped in its own try so a quota-exceeded
    // failure here doesn't block the cloud write.
    try {
      var all = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
      all[jobId] = state;
      localStorage.setItem('agx-nodegraphs', JSON.stringify(all));
    } catch (lsErr) {
      console.warn('[nodegraph] localStorage save failed (likely quota exceeded):', lsErr && lsErr.message);
    }
    // Cloud write — authoritative, fires async. Gated during the
    // initial-open window so the bootstrap render (which fires
    // saveGraph() reflexively at the bottom of render()) doesn't
    // clobber the cloud before syncFromCloud has a chance to load
    // a co-worker's newer layout.
    if (_initialCloudSyncInFlight) return;
    saveGraphToCloud(state);
    if (typeof window.ngMarkSaved === 'function') window.ngMarkSaved();
  } catch (e) {
    if (typeof window.ngMarkSaved === 'function') window.ngMarkSaved('error');
  }
}

// Manual snapshot — separate localStorage key so it survives
// auto-save GRAPH_VER bumps (which wipe agx-nodegraphs). One slot
// per job; calling saveSnapshot again overwrites with a confirm.
function saveSnapshot(){
  if(!jobId) return null;
  var state = buildGraphState();
  state.savedAt = new Date().toISOString();
  var all = JSON.parse(localStorage.getItem('agx-nodegraph-snapshots') || '{}');
  all[jobId] = state;
  localStorage.setItem('agx-nodegraph-snapshots', JSON.stringify(all));
  return state.savedAt;
}

function getSnapshot(){
  if(!jobId) return null;
  var all = JSON.parse(localStorage.getItem('agx-nodegraph-snapshots') || '{}');
  return all[jobId] || null;
}

// Restore a previously-saved snapshot. Replaces nodes/wires/pan/zoom
// in place; the caller is responsible for re-rendering.
function restoreSnapshot(){
  if(!jobId) return false;
  var snap = getSnapshot();
  if(!snap || !snap.nodes) return false;
  // Re-hydrate, mirroring loadGraph's data-pointer logic so node
  // entries that reference appData rows still resolve.
  nodes = []; wires = snap.wires || []; nid = snap.nid || 1;
  frames = snap.frames || []; // guard so pre-frames snapshots restore fine
  measurements = snap.measurements || []; // guard so pre-measurement snapshots restore fine
  panX = snap.panX || 0; panY = snap.panY || 0; zoom = snap.zoom || 1;
  snap.nodes.forEach(function(sn){
    var d = DEFS[sn.type]; if(!d) return;
    var data = {};
    if(sn.dataId && typeof appData !== 'undefined'){
      if(sn.type === 't1') data = appData.buildings.find(function(b){ return b.id === sn.dataId; }) || {};
      else if(sn.type === 't2') data = appData.phases.find(function(p){ return p.id === sn.dataId; }) || {};
      else if(sn.type === 'sub') {
        // Prefer the global directory (Phase A) — that's the
        // canonical sub record. Fall back to the legacy inline
        // appData.subs for graphs saved before the directory
        // existed; the migration tool on the Subs sub-tab moves
        // those into the directory once the user runs it.
        data = (appData.subsDirectory || []).find(function(s){ return s.id === sn.dataId; }) ||
               (appData.subs || []).find(function(s){ return s.id === sn.dataId; }) || {};
      }
      else if(sn.type === 'co') data = appData.changeOrders.find(function(c){ return c.id === sn.dataId; }) || {};
      else if(sn.type === 'po') data = (appData.purchaseOrders||[]).find(function(p){ return p.id === sn.dataId; }) || {};
      else if(sn.type === 'inv') data = (appData.invoices||[]).find(function(i){ return i.id === sn.dataId; }) || {};
    }
    nodes.push({
      id:sn.id, type:sn.type, cat:d.cat,
      x:sn.x, y:sn.y, label:sn.label,
      data:data, value:sn.value||0,
      collapsed:sn.collapsed||false,
      noteText:sn.noteText||'',
      items:sn.items||[],
      pctComplete:sn.pctComplete||0,
      budget:sn.budget||0,
      revenue:sn.revenue||0,
      jobFields:sn.jobFields||{},
      _coRevApplied:sn._coRevApplied||0,
      allocTarget:sn.allocTarget||null,
      attachedTo:sn.attachedTo||null,
      geoLatLng:sn.geoLatLng||null, // Phase 2-A: building's real lat/lng (guard so pre-geo snapshots restore fine)
      polygon:sn.polygon||null, // traced building footprint (guard so pre-polygon snapshots restore fine)
      levels:sn.levels||[], // L/U Phase 1: floors (guard so pre-L/U snapshots restore fine)
      units:sn.units||[],   // L/U Phase 1: units, each optionally on a level (unit.levelId)
      heightM:sn.heightM||null, // 3D extrusion override (guard so pre-height snapshots restore fine)
      phases:sn.phases||null // Scope→nested-phases breakdown (guard so pre-phases snapshots restore fine)
    });
  });
  // Persist the restore as the new auto-save state too, so the user
  // doesn't see the snapshot vanish next open.
  saveGraph();
  return true;
}

function loadGraph(){
  if(!jobId) return false;
  var all = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
  var state = all[jobId];
  if(!state || !state.nodes || !state.nodes.length) return false;
  // Phase B: try migrations before rejecting. If MIGRATIONS doesn't
  // have a path from state.ver up to GRAPH_VER, the function returns
  // null and we fall through to the old "re-populate from defaults"
  // behavior.
  if((state.ver||0) < GRAPH_VER) {
    var migrated = migrateIfNeeded(state);
    if (!migrated) return false;
    state = migrated;
  }

  nodes = []; wires = state.wires || []; nid = state.nid || 1;
  frames = state.frames || []; // NG8: guard so pre-frames graphs load fine
  measurements = state.measurements || []; // guard so pre-measurement graphs load fine
  panX = state.panX || 0; panY = state.panY || 0; zoom = state.zoom || 1;

  state.nodes.forEach(function(sn){
    var d = DEFS[sn.type]; if(!d) return;
    var data = {};
    if(sn.dataId && typeof appData !== 'undefined'){
      if(sn.type === 't1') data = appData.buildings.find(function(b){ return b.id === sn.dataId; }) || {};
      else if(sn.type === 't2') data = appData.phases.find(function(p){ return p.id === sn.dataId; }) || {};
      else if(sn.type === 'sub') {
        // Prefer the global directory (Phase A) — that's the
        // canonical sub record. Fall back to the legacy inline
        // appData.subs for graphs saved before the directory
        // existed; the migration tool on the Subs sub-tab moves
        // those into the directory once the user runs it.
        data = (appData.subsDirectory || []).find(function(s){ return s.id === sn.dataId; }) ||
               (appData.subs || []).find(function(s){ return s.id === sn.dataId; }) || {};
      }
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
      revenue: (sn.revenue!=null ? sn.revenue : (data.asSoldRevenue||0)),
      jobFields:sn.jobFields||{},
      _coRevApplied:sn._coRevApplied||0,
      allocTarget:sn.allocTarget||null,
      attachedTo:sn.attachedTo||null,
      geoLatLng:sn.geoLatLng||null, // Phase 2-A: building's real lat/lng (guard so pre-geo graphs load fine)
      polygon:sn.polygon||null, // traced building footprint (guard so pre-polygon graphs load fine)
      levels:sn.levels||[], // L/U Phase 1: floors (guard so pre-L/U graphs load fine)
      units:sn.units||[],   // L/U Phase 1: units, each optionally on a level (unit.levelId)
      heightM:sn.heightM||null, // 3D extrusion override (guard so pre-height graphs load fine)
      phases:sn.phases||null, // Scope→nested-phases breakdown (guard so pre-phases graphs load fine)
    };
    nodes.push(n);
  });
  // Prune any attachedTo references to nodes that no longer exist.
  var existingIds = {}; nodes.forEach(function(n){ existingIds[n.id]=1; });
  nodes.forEach(function(n){ if(n.attachedTo && !existingIds[n.attachedTo]) n.attachedTo=null; });
  // Self-heal: older wire-creation paths pushed t2/co→parent wires with no
  // allocPct, which the engine computes as 0% — those links contributed
  // nothing to building cost/revenue rollups. When EVERY alloc wire on a
  // source is still null (i.e. the user never set one), run the standard
  // rebalance so existing links start computing. Any user-set value on a
  // source blocks the heal for that source, so real allocations are never
  // overwritten.
  nodes.forEach(function(n){
    if(n.type !== 't2' && n.type !== 'co') return;
    var aw = (n.type === 'co') ? getCOAllocWires(n.id) : getPhaseAllocWires(n.id);
    if(!aw.length) return;
    var allNull = aw.every(function(w){ return w.allocPct == null; });
    if(allNull){
      if(n.type === 'co') rebalanceCOAllocations(n.id);
      else rebalancePhaseAllocations(n.id);
    }
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
    // Site-plan mode: only the building->WIP wires (both endpoints visible) are
    // drawn, so cost flows read as building clusters feeding the central hub.
    if (viewMode === 'siteplan' && (!fn || !tn || !spNodeVisible(fn.type, fn.id) || !spNodeVisible(tn.type, tn.id))) return;
    var col = (fn && SRCCOL[fn.type]) || WCOL[tp] || '#4f8cff';
    // Vertical bottom-port approach: WIP top/bottom (pi 1/2) and Building/Phase
    // Costs input (pi 0) render on the bottom edge → route the wire up into the
    // bottom (n8n sub-node cascade). Render-only; the wire's ports are unchanged.
    var vertIn = tn && ((tn.type==='wip' && (w.toPort===0||w.toPort===1||w.toPort===2)) ||
                        ((tn.type==='t1'||tn.type==='t2') && w.toPort===0));
    // NG-WIRE: collapsed cost/CO chips put their output on the TOP edge, so the
    // connector is a clean vertical drop up to the parent's bottom port.
    var srcChip = fn && fn.collapsed && (fn.cat==='cost' || fn.type==='co');
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y);
    if(vertIn){
      var vy = (w.toPort===1) ? -60 : 60; // approach: top port from above, bottom from below
      if(srcChip){
        var dyc = Math.max(28, Math.min(80, Math.abs(p2.y-p1.y)*0.5));
        ctx.bezierCurveTo(p1.x, p1.y - dyc, p2.x, p2.y + vy, p2.x, p2.y);
      } else {
        ctx.bezierCurveTo(p1.x+60, p1.y, p2.x, p2.y+vy, p2.x, p2.y);
      }
    } else {
      var dx = Math.max(Math.abs(p2.x-p1.x)*0.4, 50);
      ctx.bezierCurveTo(p1.x+dx, p1.y, p2.x-dx, p2.y, p2.x, p2.y);
    }
    // Solid connection line — one consistent colour end-to-end (no breathing-gradient
    // dip in the middle, no clean-mode dashes), like the original wire style.
    ctx.setLineDash([]);
    // The ctx is scaled by zoom, so a fixed lineWidth balloons at high zoom (the
    // "fluffy" wires). Divide by zoom → a constant ~1px on screen, matching the
    // building polygon outline (.ng-poly stroke-width:1, non-scaling). Trim the glow.
    ctx.strokeStyle = hexToRgba(col, 0.9); ctx.lineWidth = 1/zoom;
    ctx.shadowColor = col; ctx.shadowBlur = 1;
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
    ctx.strokeStyle = pcol; ctx.lineWidth = 1.5/zoom;
    ctx.setLineDash([6,4]); ctx.stroke(); ctx.setLineDash([]);
  }

  // Note tethers — visual-only dashed line from each note to its
  // attached node. Not a data wire; never affects calculations.
  nodes.forEach(function(n){
    if(n.type !== 'note' || !n.attachedTo) return;
    var t = findNode(n.attachedTo);
    if(!t) return;
    var nb = nodeBox(n), tb = nodeBox(t);
    var nc = { x: nb.x + nb.w/2, y: nb.y + nb.h/2 };
    var tc = { x: tb.x + tb.w/2, y: tb.y + tb.h/2 };
    // Clip endpoints to each node's bounding box edge so the line
    // appears to start at the box outline rather than passing through.
    var s = clipToBox(nc, tc, nb);
    var e = clipToBox(tc, nc, tb);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
    ctx.strokeStyle = 'rgba(251,191,36,0.65)'; // amber, matches note vibe
    ctx.lineWidth = 1/zoom;   // constant ~1px on screen (ctx is zoom-scaled)
    ctx.setLineDash([5,5]); ctx.stroke(); ctx.setLineDash([]);
    // Small dot at the target end so it reads as "this note is about that"
    ctx.beginPath();
    ctx.arc(e.x, e.y, 3, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(251,191,36,0.85)';
    ctx.fill();
  });

  ctx.restore();
}

// Bounding box of a node in graph coordinates (uses the rendered DOM
// element if available, falls back to a default size).
function nodeBox(n){
  if(_canvasEl){
    var el = _canvasEl.querySelector('[data-id="'+n.id+'"]');
    if(el){
      var r = el.getBoundingClientRect();
      return { x: n.x, y: n.y, w: r.width/zoom, h: r.height/zoom };
    }
  }
  return { x: n.x, y: n.y, w: 200, h: 80 };
}

// Where the line from `from` to `to` exits `box`. Used to make tether
// endpoints sit on the node outline instead of the center.
function clipToBox(from, to, box){
  var cx = box.x + box.w/2, cy = box.y + box.h/2;
  var dx = to.x - from.x, dy = to.y - from.y;
  if(dx === 0 && dy === 0) return { x: cx, y: cy };
  var hw = box.w/2, hh = box.h/2;
  var tX = dx === 0 ? Infinity : Math.abs(hw / dx);
  var tY = dy === 0 ? Infinity : Math.abs(hh / dy);
  var t = Math.min(tX, tY);
  return { x: cx + dx*t, y: cy + dy*t };
}

// ── Port Positions ──
var _canvasEl = null;
function setCanvasEl(el){ _canvasEl = el; }
// Phase 2 (polygon buildings): ui.js owns the geo origin (_spOrigin/_spOriginGraph),
// so it registers a callback that returns a geo-placed building's on-map graph
// position (or null). Render-only; consulted by portPos. Mirrors setCanvasEl — the
// engine receives a ui-owned dependency it cannot compute itself.
var _geoPortAnchor = null;
function setGeoPortAnchor(fn){ _geoPortAnchor = (typeof fn==='function') ? fn : null; }
// Site Plan rework: ui.js owns the _spSatellite flag; it registers a predicate so
// spNodeVisible can hide the WIP hub (+ its direct site-cost chips) on the satellite
// canvas — the WIP totals live in the sidebar metrics panel there. Render-only.
var _satActive = null;
function setSatelliteActive(fn){ _satActive = (typeof fn==='function') ? fn : null; }

function portPos(nid2, pi, dir){
  var n = findNode(nid2); if(!n) return {x:0,y:0};
  // Phase 2: a geo-placed building (traced footprint OR map-placed) anchors BOTH its
  // in/out wires at its on-map visual center, not the abstract n.x/n.y port dot. Gate
  // excludes abstract graph mode (geoLatLng is null there) and every non-t1 node; the
  // ui callback adds the satellite-mode + origin-resolved check the engine can't see,
  // and returns null to fall straight through to the existing logic below.
  if(_geoPortAnchor && viewMode==='siteplan' && n.type==='t1' && n.geoLatLng){
    var _ga=_geoPortAnchor(n);
    if(_ga && isFinite(_ga.x) && isFinite(_ga.y)) return { x:_ga.x, y:_ga.y };
  }
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
// ── NG8: frames (group boxes) ──
function getFrames(){ return frames; }
function setFrames(f){ frames = f || []; return frames; }
function findFrame(id){ for(var i=0;i<frames.length;i++){ if(frames[i].id===id) return frames[i]; } return null; }

// Survey measurements — persisted geometry, never wired, never in cost calcs.
function getMeasurements(){ return measurements; }
function setMeasurements(a){ measurements = a || []; return measurements; }
function addMeasurement(m){ m = m || {}; if(!m.id) m.id = 'ms'+(nid++); measurements.push(m); return m; }
function removeMeasurement(id){ measurements = measurements.filter(function(m){ return m.id!==id; }); }
function findMeasurement(id){ for(var i=0;i<measurements.length;i++){ if(measurements[i].id===id) return measurements[i]; } return null; }
function addFrame(x,y,w,h,label){
  var f={ id:'frm'+(nid++), frame:true, x:Math.round(x), y:Math.round(y),
          w:Math.round(Math.max(160,w)), h:Math.round(Math.max(100,h)),
          label:label||'Group', color:'#4f8cff' };
  frames.push(f); return f;
}
function removeFrame(id){ frames = frames.filter(function(f){ return f.id!==id; }); }

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
  cleanMode:getCleanMode, setCleanMode:setCleanMode, firstCompatPort:firstCompatPort,
  viewMode:getViewMode, setViewMode:setViewMode, sitePlanVisible:sitePlanVisible, budgetFootprint:budgetFootprint, spBuildingFootprint:spBuildingFootprint,
  spNodeVisible:spNodeVisible, setSitePlanFocusSet:setSitePlanFocusSet,
  spMapZoom:spMapZoom, spGraphToLatLng:spGraphToLatLng, spLatLngToGraph:spLatLngToGraph, setNodeGeo:setNodeGeo, setNodePolygon:setNodePolygon,
  getOutput:getOutput, getActual:getActual, getAccrued:getAccrued, resetComp:resetComp,
  getPhaseAllocWires:getPhaseAllocWires, rebalancePhaseAllocations:rebalancePhaseAllocations,
  getCOAllocWires:getCOAllocWires, rebalanceCOAllocations:rebalanceCOAllocations,
  getPhaseRevenueToBuilding:getPhaseRevenueToBuilding, getCOIncomeToParent:getCOIncomeToParent,
  getBuildingAllocatedRevenue:getBuildingAllocatedRevenue,
  getT2WeightedPct:getT2WeightedPct, getT1WeightedPct:getT1WeightedPct, wireUnitPct:wireUnitPct,
  scopePctFromPhases:scopePctFromPhases,
  getWIPWeightedPct:getWIPWeightedPct, getT2ShareToT1:getT2ShareToT1,
  fmtC:fmtC, fmtP:fmtP, fmtV:fmtV,
  saveGraph:saveGraph, loadGraph:loadGraph,
  loadGraphFromCloudAndApply:loadGraphFromCloudAndApply,
  setInitialCloudSyncInFlight:setInitialCloudSyncInFlight,
  saveSnapshot:saveSnapshot, restoreSnapshot:restoreSnapshot, getSnapshot:getSnapshot,
  drawWires:drawWires, drawGrid:drawGrid,
  portPos:portPos, setCanvasEl:setCanvasEl, setGeoPortAnchor:setGeoPortAnchor, setSatelliteActive:setSatelliteActive,
  genId:genId,
  frames:getFrames, setFrames:setFrames, addFrame:addFrame, removeFrame:removeFrame, findFrame:findFrame,
  measurements:getMeasurements, setMeasurements:setMeasurements, addMeasurement:addMeasurement, removeMeasurement:removeMeasurement, findMeasurement:findMeasurement,
};
})();
