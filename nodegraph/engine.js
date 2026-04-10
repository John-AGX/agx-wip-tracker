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
  t1:    { cat:'t1',   icon:'\u{1F3D7}', label:'Tier 1',       ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C},{n:'%',t:PT.P},{n:'Revenue',t:PT.C},{n:'Est. Costs',t:PT.C}], hasProg:true, nameEdit:true },
  t2:    { cat:'t2',   icon:'\u{1F4CB}', label:'Tier 2',       ins:[{n:'Costs',t:PT.C}], outs:[{n:'Total',t:PT.C},{n:'%',t:PT.P}], hasProg:true, nameEdit:true },
  labor: { cat:'cost', icon:'\u{1F6E0}', label:'Labor',        ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'labor' },
  mat:   { cat:'cost', icon:'\u{1F9F1}', label:'Materials',    ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'mat' },
  gc:    { cat:'cost', icon:'\u{1F3E2}', label:'Gen. Conditions', ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'gc' },
  other: { cat:'cost', icon:'\u{1F4CC}', label:'Other',        ins:[], outs:[{n:'Total',t:PT.C}], hasItems:true, nameEdit:true, itemType:'other' },
  sub:   { cat:'sub',  icon:'\u{1F477}', label:'Sub',          ins:[{n:'PO Contract',t:PT.C},{n:'Invoiced',t:PT.C}], outs:[{n:'Actual Cost',t:PT.C},{n:'Accrued',t:PT.C}], nameEdit:true, hasProg:true },
  po:    { cat:'sub',  icon:'\u{1F4C4}', label:'Purchase Order', ins:[{n:'Invoiced',t:PT.C}], outs:[{n:'Contract',t:PT.C},{n:'Invoiced',t:PT.C}], hasItems:true, nameEdit:true, itemType:'po' },
  inv:   { cat:'sub',  icon:'\u{1F4B3}', label:'Invoice',       ins:[], outs:[{n:'Invoiced',t:PT.C}], hasItems:true, nameEdit:true, itemType:'inv' },
  co:    { cat:'co',   icon:'\u{1F4DD}', label:'Change Order', ins:[], outs:[{n:'Income',t:PT.C},{n:'Costs',t:PT.C}], nameEdit:true },
  sum:   { cat:'math', icon:'\u2211',    label:'SUM',          ins:[{n:'A',t:PT.A},{n:'B',t:PT.A},{n:'C',t:PT.A},{n:'D',t:PT.A}], outs:[{n:'Result',t:PT.C}] },
  sub2:  { cat:'math', icon:'\u2212',    label:'Subtract',     ins:[{n:'A',t:PT.C},{n:'B',t:PT.C}], outs:[{n:'Result',t:PT.C}] },
  mul:   { cat:'math', icon:'\u00D7',    label:'Multiply',     ins:[{n:'A',t:PT.A},{n:'B',t:PT.N}], outs:[{n:'Result',t:PT.C}] },
  pct:   { cat:'math', icon:'%',         label:'Percent',      ins:[{n:'Val',t:PT.C},{n:'%',t:PT.P}], outs:[{n:'Result',t:PT.C}] },
  // ── Master Nodes ──
  job:   { cat:'job',  icon:'\u{1F4BC}', label:'Job',
    ins:[],
    outs:[{n:'Contract',t:PT.C},{n:'CO Income',t:PT.C},{n:'Total Income',t:PT.C},{n:'Est. Costs',t:PT.C},{n:'CO Costs',t:PT.C},{n:'Rev. Est. Costs',t:PT.C}],
    master:true, hasFields:true,
    fields:['contractAmount','coIncome','totalIncome','estimatedCosts','coCosts','revisedEstCosts','revisedCostChanges','targetMarginPct']
  },
  wip:   { cat:'wip',  icon:'\u{1F4CA}', label:'WIP Metrics',
    ins:[{n:'Total Income',t:PT.C},{n:'Actual Costs',t:PT.C},{n:'% Complete',t:PT.P},{n:'Invoiced',t:PT.C},{n:'Est. Costs (Rev.)',t:PT.C}],
    outs:[{n:'Revenue Earned',t:PT.C},{n:'Gross Profit',t:PT.C},{n:'Margin JTD',t:PT.P},{n:'Remaining Costs',t:PT.C},{n:'Unbilled',t:PT.C},{n:'Backlog',t:PT.C},{n:'Accrued',t:PT.C}],
    master:true
  },
  watch: { cat:'watch',icon:'\u{1F4CA}', label:'Watch',        ins:[{n:'Value',t:PT.A}], outs:[], nameEdit:true },
  note:  { cat:'note', icon:'\u{1F4CC}', label:'Note',         ins:[], outs:[] },
};

// ── Category tree for sidebar ──
var CATS = [
  { name:'Master',    items:['job','wip'] },
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

function addNode(type, x, y, label, data){
  var d = DEFS[type]; if(!d) return null;
  var n = {
    id: genId(), type: type, cat: d.cat,
    x: Math.round(x/SNAP)*SNAP, y: Math.round(y/SNAP)*SNAP,
    label: label || d.label,
    data: data || {},
    value: 0,
    collapsed: false,
    noteText: '',
    items: [],        // sub-items for cost nodes [{date:'',amount:0}]
    pctComplete: 0,   // for T1/T2 progress bar
    budget: 0,        // for T1/T2
    jobFields: {},    // for job node editable fields
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

  // Sub: receives PO Contract (in 0) and Invoiced (in 1)
  // Output 0 = Actual Cost (invoiced amount — work that's been billed)
  // Output 1 = Accrued (earned based on % but not yet invoiced)
  if(n.type === 'sub'){
    var subIns = [0,0];
    wires.forEach(function(w){
      if(w.toNode === n.id){
        var fn = findNode(w.fromNode);
        if(fn) subIns[w.toPort] = (subIns[w.toPort]||0) + getOutput(fn, w.fromPort);
      }
    });
    var poContract = subIns[0] || 0;
    var invoiced = subIns[1] || 0;
    if(pi === 0) v = invoiced; // Actual Cost = invoiced (billed work becomes actual cost)
    else if(pi === 1){
      // Accrued = (contract × % complete of connected scope) - invoiced
      // Find % complete from connected T1/T2 (trace Sub output wires → find T1/T2 target)
      var pctComp = n.pctComplete || 0;
      wires.forEach(function(w){
        if(w.fromNode === n.id){
          var target = findNode(w.toNode);
          if(target && (target.type === 't1' || target.type === 't2') && target.pctComplete > 0){
            pctComp = target.pctComplete;
          }
        }
      });
      // Also check if Sub is wired into a SUM that's wired into a T1/T2
      if(pctComp === 0){
        wires.forEach(function(w){
          if(w.fromNode === n.id){
            var mid = findNode(w.toNode);
            if(mid && mid.type === 'sum'){
              wires.forEach(function(w2){
                if(w2.fromNode === mid.id){
                  var t = findNode(w2.toNode);
                  if(t && (t.type === 't1' || t.type === 't2') && t.pctComplete > 0){
                    pctComp = t.pctComplete;
                  }
                }
              });
            }
          }
        });
      }
      var earned = poContract * (pctComp / 100);
      v = Math.max(0, earned - invoiced);
    }
    _comp[n.id] = false; return v;
  }

  // CO: items feed into first output (Income), second uses data
  if(n.type === 'co'){
    if(pi === 0) v = itemsTotal || (n.data ? n.data.income || 0 : 0);
    else v = n.data ? n.data.estimatedCosts || 0 : 0;
    _comp[n.id] = false; return v;
  }

  // T1: output 0=total costs, 1=% complete, 2=allocated revenue, 3=allocated est costs
  // T2: output 0=total costs, 1=% complete
  if(n.type === 't1' || n.type === 't2'){
    if(pi === 0){
      v = itemsTotal;
      wires.forEach(function(w){
        if(w.toNode === n.id){
          var fn = findNode(w.fromNode);
          if(fn) v += getOutput(fn, w.fromPort);
        }
      });
    } else if(pi === 1){
      v = n.pctComplete || 0;
    } else if(n.type === 't1' && (pi === 2 || pi === 3)){
      // Find the Job node by tracing downstream: T1 → SUM → Job or T1 → Job
      var jobNode = null;
      var allT1s = nodes.filter(function(nd){ return nd.type === 't1'; });
      // Find Job node connected downstream
      nodes.forEach(function(nd){ if(nd.type === 'job') jobNode = nd; });
      if(jobNode){
        var totalBudget = allT1s.reduce(function(s,t){ return s + (t.budget || 0); }, 0);
        var myPct = totalBudget > 0 ? (n.budget || 0) / totalBudget : (allT1s.length > 0 ? 1 / allT1s.length : 0);
        if(pi === 2){
          // Allocated Revenue = Total Income × budget %
          var totalIncome = getOutput(jobNode, 2); // Job output 2 = Total Income
          v = totalIncome * myPct;
        } else if(pi === 3){
          // Allocated Est. Costs = Rev. Est. Costs × budget %
          var revEstCosts = getOutput(jobNode, 5); // Job output 5 = Rev. Est. Costs
          v = revEstCosts * myPct;
        }
      }
    }
    _comp[n.id] = false; return v;
  }

  // Job node: outputs revenue lines from stored job data
  if(n.type === 'job' && n.data){
    var jd = n.data;
    var contract = jd.contractAmount || n.jobFields.contractAmount || 0;
    var coInc = n.jobFields.coIncome || 0;
    var estCosts = jd.estimatedCosts || n.jobFields.estimatedCosts || 0;
    var coCosts = n.jobFields.coCosts || 0;
    var revChanges = jd.revisedCostChanges || n.jobFields.revisedCostChanges || 0;
    var totalIncome = contract + coInc;
    var revEstCosts = estCosts + coCosts + revChanges;
    // Outputs: Contract, CO Income, Total Income, Est. Costs, CO Costs, Rev. Est. Costs
    var jobOuts = [contract, coInc, totalIncome, estCosts, coCosts, revEstCosts];
    v = jobOuts[pi] || 0;
    _comp[n.id] = false; return v;
  }

  // WIP node: computes all metrics from inputs
  if(n.type === 'wip'){
    // Collect wired inputs: Total Income, Actual Costs, % Complete, Invoiced, Est. Costs (Rev.)
    var wipIns = [0,0,0,0,0];
    wires.forEach(function(w){
      if(w.toNode === n.id){
        var fn = findNode(w.fromNode);
        if(fn) wipIns[w.toPort] = (wipIns[w.toPort]||0) + getOutput(fn, w.fromPort);
      }
    });
    var totalInc = wipIns[0], actualCosts = wipIns[1], pctComp = wipIns[2];
    var invoiced = wipIns[3], estCostsRev = wipIns[4];
    var revEarned = totalInc * (pctComp / 100);
    var grossProfit = revEarned - actualCosts;
    var marginJTD = revEarned > 0 ? (grossProfit / revEarned * 100) : 0;
    var remaining = estCostsRev - actualCosts;
    var unbilled = revEarned - invoiced;
    var backlog = totalInc - revEarned;
    var accrued = Math.max(0, revEarned - invoiced);
    // Outputs: Revenue Earned, Gross Profit, Margin JTD, Remaining Costs, Unbilled, Backlog, Accrued
    var wipOuts = [revEarned, grossProfit, marginJTD, remaining, unbilled, backlog, accrued];
    v = wipOuts[pi] || 0;
    _comp[n.id] = false; return v;
  }

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
function saveGraph(){
  if(!jobId) return;
  var state = {
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

  nodes = []; wires = state.wires || []; nid = state.nid || 1;
  panX = state.panX || 0; panY = state.panY || 0; zoom = state.zoom || 1;

  state.nodes.forEach(function(sn){
    var d = DEFS[sn.type]; if(!d) return;
    var data = {};
    if(sn.dataId && typeof appData !== 'undefined'){
      if(sn.type === 'sub') data = appData.subs.find(function(s){ return s.id === sn.dataId; }) || {};
      else if(sn.type === 'co') data = appData.changeOrders.find(function(c){ return c.id === sn.dataId; }) || {};
    }
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
