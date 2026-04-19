// ============================================================
// AGX Node Graph v5 — UI (render, sidebar, events, populate)
// ============================================================
(function(){
'use strict';

var E = NG; // engine reference
var wrap, canvasEl, wireC, wireCtx, gridC, gridCtx;
var dragN=null, dragOff={x:0,y:0};
var wiringFrom=null, wireMouse=null;
var selN=null, isPan=false, panSt={x:0,y:0};
var editingId=null;

// ── Update T2/Sub labels based on connected T1 / phase data ──
function updateTierLabels(){
  var nodes=E.nodes(), wires=E.wires();
  // Aggregate sub→phase/building connections across all node instances of the same sub data
  var subAgg = {}; // subDataId -> { phaseIds:Set, bldgIds:Set }
  nodes.forEach(function(n){
    if(n.type!=='sub' || !n.data || !n.data.id) return;
    var key = n.data.id;
    if(!subAgg[key]) subAgg[key] = { phaseIds: {}, bldgIds: {} };
    wires.forEach(function(w){
      if(w.fromNode===n.id){
        var target=E.findNode(w.toNode);
        if(target && target.type==='t2' && target.data && target.data.id) subAgg[key].phaseIds[target.data.id] = 1;
        else if(target && target.type==='t1' && target.data && target.data.id) subAgg[key].bldgIds[target.data.id] = 1;
      }
    });
  });
  nodes.forEach(function(n){
    if(n.type==='t2'){
      var baseName = n.label.split(' \u203A ')[0].trim();
      var t1Name = '', t1Data = null;
      wires.forEach(function(w){
        if(w.fromNode===n.id){
          var target=E.findNode(w.toNode);
          if(target&&target.type==='t1'){ t1Name=target.label.split(' \u203A ')[0].trim(); t1Data=target.data; }
        }
      });
      n.label = t1Name ? baseName+' \u203A '+t1Name : baseName;
      if(n.data && n.data.id && typeof appData !== 'undefined'){
        var phase = appData.phases.find(function(p){return p.id===n.data.id;});
        if(phase){
          var newBldgId = t1Data && t1Data.id ? t1Data.id : '';
          if(phase.buildingId !== newBldgId){
            phase.buildingId = newBldgId;
            if(typeof saveData === 'function') saveData();
          }
        }
      }
    } else if(n.type==='sub'){
      var subBase = n.label.split(' \u203A ')[0].trim();
      var suffix = '';
      // Derive label + sync data from wire connections
      var connPhases = [], connBldgs = [];
      var connPhaseIds = [], connBldgIds = [];
      wires.forEach(function(w){
        if(w.fromNode===n.id){
          var target=E.findNode(w.toNode);
          if(target && target.type==='t2'){
            connPhases.push(target.label.split(' \u203A ')[0].trim());
            if(target.data && target.data.id) connPhaseIds.push(target.data.id);
          } else if(target && target.type==='t1'){
            connBldgs.push(target.label.split(' \u203A ')[0].trim());
            if(target.data && target.data.id) connBldgIds.push(target.data.id);
          }
        }
      });
      if(connPhases.length===1) suffix = connPhases[0];
      else if(connPhases.length>1) suffix = connPhases[0]+' +'+connPhases.length;
      else if(connBldgs.length===1) suffix = connBldgs[0];
      else if(connBldgs.length>1) suffix = connBldgs[0]+' +'+connBldgs.length;
      n.label = suffix ? subBase+' \u203A '+suffix : subBase;
    }
  });
  // Sync aggregated sub→phase/building connections back to data
  if(typeof appData !== 'undefined'){
    var anyDirty = false;
    Object.keys(subAgg).forEach(function(subId){
      var sub = appData.subs.find(function(s){return s.id===subId;});
      if(!sub) return;
      var agg = subAgg[subId];
      var pIds = Object.keys(agg.phaseIds);
      var bIds = Object.keys(agg.bldgIds);
      var derivedBldgs = pIds.map(function(pid){
        var ph = appData.phases.find(function(p){return p.id===pid;});
        return ph ? ph.buildingId : null;
      }).filter(Boolean);
      var newLevel = pIds.length>0 ? 'phase' : (bIds.length>0 ? 'building' : (sub.level||'building'));
      var finalBldgs = newLevel==='phase' ? derivedBldgs : bIds;
      finalBldgs = finalBldgs.filter(function(id,i){return finalBldgs.indexOf(id)===i;});
      var sortedNew = pIds.slice().sort().join(',');
      var sortedOld = (sub.phaseIds||[]).slice().sort().join(',');
      var dirty = false;
      if(sortedNew !== sortedOld){ sub.phaseIds = pIds; dirty = true; }
      var sortedNewB = finalBldgs.slice().sort().join(',');
      var sortedOldB = (sub.buildingIds||[]).slice().sort().join(',');
      if(sortedNewB !== sortedOldB){ sub.buildingIds = finalBldgs; dirty = true; }
      if((pIds.length>0 || bIds.length>0) && sub.level !== newLevel){ sub.level = newLevel; dirty = true; }
      if(sub.phaseId){ delete sub.phaseId; dirty = true; }
      if(sub.buildingId){ delete sub.buildingId; dirty = true; }
      if(dirty) anyDirty = true;
    });
    if(anyDirty && typeof saveData === 'function') saveData();
  }
}

// ── Auto-calculate T1 % complete from connected T2s ──
function updateT1Progress(){
  var nodes=E.nodes(), wires=E.wires();
  nodes.forEach(function(n){
    if(n.type!=='t1') return;
    // Find all T2s wired into this T1
    var t2s=[];
    wires.forEach(function(w){
      if(w.toNode===n.id){
        var src=E.findNode(w.fromNode);
        if(src&&src.type==='t2') t2s.push(src);
      }
    });
    if(t2s.length===0) return; // keep manual % if no T2s connected
    // Weighted average by budget, or simple average if no budgets
    var totalBudget=t2s.reduce(function(s,t){return s+(t.budget||0);},0);
    if(totalBudget>0){
      n.pctComplete=t2s.reduce(function(s,t){return s+(t.pctComplete||0)*(t.budget||0);},0)/totalBudget;
    } else {
      n.pctComplete=t2s.reduce(function(s,t){return s+(t.pctComplete||0);},0)/t2s.length;
    }
    n.pctComplete=Math.round(n.pctComplete*10)/10;
  });
}

// ── Resize canvases ──
function resize(){
  wireC.width=wrap.clientWidth; wireC.height=wrap.clientHeight;
  gridC.width=wrap.clientWidth; gridC.height=wrap.clientHeight;
}

// ── Render ──
function getConnectedIds(nid){
  if(!nid) return {};
  var ids={};
  E.wires().forEach(function(w){
    if(w.fromNode===nid) ids[w.toNode]=1;
    if(w.toNode===nid) ids[w.fromNode]=1;
  });
  return ids;
}
function updateConnectedHighlight(){
  if(!canvasEl) return;
  var connected=getConnectedIds(selN);
  canvasEl.querySelectorAll('.ng-node').forEach(function(el){
    var id=el.getAttribute('data-id');
    if(connected[id]) el.classList.add('ng-connected');
    else el.classList.remove('ng-connected');
  });
}
function renderNodes(){
  var nodes=E.nodes(), wires=E.wires();
  canvasEl.querySelectorAll('.ng-node').forEach(function(el){
    if(editingId && el.getAttribute('data-id')===editingId) return;
    el.remove();
  });
  E.resetComp();

  var connectedIds=getConnectedIds(selN);
  nodes.forEach(function(n){
    var d=E.DEFS[n.type]; if(!d) return;
    if(editingId===n.id) return;
    // Watches are never collapsed — always show the flashy KPI
    if(n.type==='watch') n.collapsed=false;
    var div=document.createElement('div');
    div.className='ng-node ng-t-'+n.cat+(selN===n.id?' ng-sel':'')+(connectedIds[n.id]?' ng-connected':'')+(n.collapsed?' ng-coll':'');
    div.setAttribute('data-id',n.id);
    div.style.left=n.x+'px'; div.style.top=n.y+'px';

    var canColl = n.type!=='note' && n.type!=='watch';
    var canEdit = (n.type==='t1'||n.type==='t2'||n.type==='sub'||n.type==='co'||n.type==='po'||n.type==='inv') && n.data && n.data.id;
    var h='<div class="ng-hdr"><span class="ng-hi">'+d.icon+'</span><span class="ng-hdr-name" data-rename="'+n.id+'" title="Double-click to rename">'+n.label+'</span>';
    if(canEdit) h+='<span class="ng-editbtn" data-edit="'+n.id+'" title="Edit details">\u2699</span>';
    if(canColl) h+='<span class="ng-dupbtn" data-dup="'+n.id+'" title="Duplicate node">\u29C9</span>';
    if(canColl) h+='<span class="ng-cbtn" data-coll="'+n.id+'">'+(n.collapsed?'\u25B6':'\u25BC')+'</span>';
    h+='</div>';

    // Ports
    var hasIns=(d.ins&&d.ins.length>0), hasOuts=(d.outs&&d.outs.length>0);
    // WIP's input ports 1 and 2 render vertically (top/bottom) rather than in the left-side grid
    var isWip = n.type==='wip';
    if(hasIns||hasOuts){
      h+='<div class="ng-ports">';
      var mx=Math.max((d.ins||[]).length,(d.outs||[]).length);
      for(var i=0;i<mx;i++){
        h+='<div class="ng-pr">';
        // Input port + label (left side)
        if(hasIns&&i<d.ins.length&&!(isWip&&(i===1||i===2))){
          var ip=d.ins[i], ic=wires.some(function(w){return w.toNode===n.id&&w.toPort===i;});
          h+='<div class="ng-p ng-pi ng-p-'+ip.t+(ic?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="in" data-type="'+ip.t+'"></div>';
          h+='<span class="ng-pl" style="text-align:left">'+ip.n+'</span>';
        } else if(hasIns){
          h+='<span style="width:13px;flex-shrink:0"></span><span class="ng-pl"></span>';
        }
        // Spacer between input and output
        if(hasIns&&hasOuts) h+='<span style="flex:1;min-width:10px"></span>';
        // Output label + value + port (right side)
        if(hasOuts&&i<d.outs.length){
          var op=d.outs[i], oc=wires.some(function(w){return w.fromNode===n.id&&w.fromPort===i;}), ov=E.getOutput(n,i);
          if(!hasIns) h+='<span class="ng-pl" style="text-align:left;flex:1">'+op.n+'</span>';
          else h+='<span class="ng-pl" style="text-align:right;flex:0">'+op.n+'</span>';
          h+='<span class="ng-pv" style="margin-left:4px">'+E.fmtV(ov,op.t)+'</span>';
          h+='<div class="ng-p ng-po ng-p-'+op.t+(oc?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="out" data-type="'+op.t+'"></div>';
        }
        h+='</div>';
      }
      h+='</div>';
    }

    // Progress bar (T1/T2/Sub) — click bar or pct to edit
    if(d.hasProg){
      var pct = n.pctComplete || 0;
      var progColor = pct>=100?'#34d399':pct>=50?'#fbbf24':'#4f8cff';
      h+='<div class="ng-progress-wrap" data-prog-edit="'+n.id+'" title="Click to edit %">';
      h+='<div class="ng-progress"><div class="ng-progress-fill" style="width:'+Math.min(pct,100)+'%;background:'+progColor+'"></div></div>';
      h+='</div>';
      h+='<div class="ng-progress-label" data-prog-edit="'+n.id+'" title="Click to edit %"><span class="ng-pct-val">'+pct.toFixed(0)+'%</span> complete'+(n.budget?' \u00b7 Budget: '+E.fmtC(n.budget):'')+'</div>';
    }

    // Sub-items (type-specific layout)
    if(d.hasItems){
      var iType = d.itemType || '';
      var UNITS = ['each','SF','LF','gal','bag','box','ton','yd\u00B3','roll','hr'];
      // PO: base contract input / Labor: QuickBooks total input
      if(iType==='po') h+='<div class="ng-edit-val"><label style="font-size:9px;color:#6a7090;display:block;text-align:center;">Base Contract</label><input type="number" value="'+(n.value||0)+'" data-node="'+n.id+'" step="0.01" /></div>';
      else if(iType==='labor') h+='<div class="ng-edit-val"><label style="font-size:9px;color:#6a7090;display:block;text-align:center;">QuickBooks Total (used if no weekly entries)</label><input type="number" value="'+(n.value||0)+'" data-node="'+n.id+'" step="0.01" placeholder="0.00" /></div>';
      h+='<div class="ng-subitems">';
      // Header row
      if(iType==='labor') h+='<div class="ng-si-hdr"><span class="hd hd-date">Week Of</span><span class="hd hd-sm">Hrs</span><span class="hd hd-sm">Rate</span><span class="hd hd-sm">Total</span><span class="hd hd-del"></span></div>';
      else if(iType==='mat') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Amount</span><span class="hd hd-del"></span></div>';
      else if(iType==='gc') h+='<div class="ng-si-hdr"><span class="hd hd-date">Week Of</span><span class="hd hd-flex">Vendor</span><span class="hd hd-sm">Amount</span><span class="hd hd-del"></span></div>';
      else if(iType==='other') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-sm">Qty</span><span class="hd hd-sm">$/Unit</span><span class="hd hd-sm">Total</span><span class="hd hd-del"></span></div>';
      else if(iType==='sub') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Description</span><span class="hd hd-sm">Amount</span><span class="hd hd-del"></span></div>';
      else if(iType==='po') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Amendment</span><span class="hd hd-sm">Amount</span><span class="hd hd-del"></span></div>';
      else if(iType==='inv') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Invoice #</span><span class="hd hd-sm">Amount</span><span class="hd hd-del"></span></div>';

      n.items.forEach(function(item,idx){
        var nid3=n.id, pre='data-node="'+nid3+'" data-idx="'+idx+'"';
        h+='<div class="ng-subitem">';
        if(iType==='labor'){
          h+='<input class="ng-si-f ng-si-date" type="date" '+pre+' data-field="date" value="'+(item.date||'')+'" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="hours" value="'+(item.hours||0)+'" step="0.5" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="rate" value="'+(item.rate||65)+'" step="0.01" />';
          h+='<span class="ng-si-val">'+E.fmtC((item.hours||0)*(item.rate||65))+'</span>';
        } else if(iType==='mat'){
          h+='<input class="ng-si-f ng-si-date" type="date" '+pre+' data-field="date" value="'+(item.date||'')+'" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="amount" value="'+(item.amount||0)+'" step="0.01" style="flex:1" />';
        } else if(iType==='gc'){
          h+='<input class="ng-si-f ng-si-date" type="date" '+pre+' data-field="date" value="'+(item.date||'')+'" />';
          h+='<input class="ng-si-f" '+pre+' data-field="vendor" value="'+(item.vendor||'')+'" placeholder="Vendor" style="flex:1" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="amount" value="'+(item.amount||0)+'" step="0.01" />';
        } else if(iType==='other'){
          h+='<input class="ng-si-f ng-si-date" type="date" '+pre+' data-field="date" value="'+(item.date||'')+'" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="qty" value="'+(item.qty||0)+'" step="0.01" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="unitCost" value="'+(item.unitCost||0)+'" step="0.01" />';
          h+='<span class="ng-si-val">'+E.fmtC((item.qty||0)*(item.unitCost||0))+'</span>';
        } else if(iType==='sub'){
          h+='<input class="ng-si-f ng-si-date" type="date" '+pre+' data-field="date" value="'+(item.date||'')+'" />';
          h+='<input class="ng-si-f" '+pre+' data-field="desc" value="'+(item.desc||'')+'" placeholder="Description" style="flex:1" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="amount" value="'+(item.amount||0)+'" step="0.01" />';
        } else if(iType==='po'){
          h+='<input class="ng-si-f ng-si-date" type="date" '+pre+' data-field="date" value="'+(item.date||'')+'" />';
          h+='<input class="ng-si-f" '+pre+' data-field="desc" value="'+(item.desc||'')+'" placeholder="Amendment desc" style="flex:1" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="amount" value="'+(item.amount||0)+'" step="0.01" />';
        } else if(iType==='inv'){
          h+='<input class="ng-si-f ng-si-date" type="date" '+pre+' data-field="date" value="'+(item.date||'')+'" />';
          h+='<input class="ng-si-f" '+pre+' data-field="invNum" value="'+(item.invNum||'')+'" placeholder="Inv #" style="flex:1" />';
          h+='<input class="ng-si-f ng-si-sm" type="number" '+pre+' data-field="amount" value="'+(item.amount||0)+'" step="0.01" />';
        }
        h+='<span class="ng-subitem-del" data-node="'+nid3+'" data-idx="'+idx+'">\u2716</span>';
        h+='</div>';
      });
      h+='<div class="ng-add-sub" data-node="'+n.id+'">+ Add Entry</div>';
      // Total
      var itemTotal=E.getOutput(n,0);
      h+='<div class="ng-sub-total">'+E.fmtC(itemTotal)+'</div>';
      // PO: show contract vs invoiced vs accrued breakdown
      if(iType==='po'){
        E.resetComp();
        E.getOutput(n,0);
        var poContract=n._poContract||0, poInv=n._poInvoiced||0;
        h+='<div style="padding:2px 10px 4px;font-size:10px;border-top:1px solid var(--ng-border2);">';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Contract <span style="color:#8899cc;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(poContract)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Invoiced <span style="color:#34d399;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(poInv)+'</span></div>';
        h+='</div>';
      }
      h+='</div>';
    }

    // Sub: show actual vs accrued from wired cost children
    if(n.type==='sub'){
      E.resetComp();
      var subActual=E.getActual(n);
      var subAccrued=E.getAccrued(n);
      h+='<div style="padding:4px 10px 6px;font-size:10px;">';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Actual (Invoiced) <span style="color:#34d399;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(subActual)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Accrued (Committed) <span style="color:#fbbf24;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(subAccrued)+'</span></div>';
      h+='</div>';
    }

    // T1/T2: show total
    if(n.type==='t1'||n.type==='t2'){
      var tv=E.getOutput(n,0), tcls=tv>0?' ng-vp':'';
      h+='<div class="ng-wv'+tcls+'" style="font-size:16px;margin:2px 8px 6px;padding:4px 8px;">'+E.fmtC(tv)+'</div>';
    }

    // WIP node: editable revenue fields + metrics display
    if(n.type==='wip'){
      var jf=n.jobFields||{};
      h+='<div class="ng-subitems" style="max-height:none;">';
      [{k:'contractAmount',l:'Contract Amount',t:'c'},{k:'coIncome',l:'CO Income',t:'c'},{k:'estimatedCosts',l:'Est. Costs',t:'c'},{k:'coCosts',l:'CO Costs',t:'c'},{k:'revisedCostChanges',l:'Revised Changes',t:'c'},{k:'invoicedToDate',l:'Invoiced to Date',t:'c'},{k:'pctComplete',l:'% Complete',t:'p'}].forEach(function(r){
        var raw=jf[r.k]||0;
        var disp=r.t==='p'?raw.toFixed(1)+'%':E.fmtC(raw);
        h+='<div class="ng-subitem ng-wip-row"><span class="ng-wip-lbl">'+r.l+'</span><span class="ng-wip-chip" data-wip-edit="'+n.id+'" data-wip-key="'+r.k+'" data-wip-type="'+r.t+'" title="Click to edit">'+disp+'</span></div>';
      });
      h+='</div>';
      // Metrics display
      var wipD=E.DEFS.wip;
      h+='<div style="padding:4px 10px 6px;border-top:1px solid var(--ng-border2);">';
      wipD.outs.forEach(function(op,oi){
        var ov=E.getOutput(n,oi);
        var cls=ov>0?' style="color:#34d399"':ov<0?' style="color:#f87171"':'';
        var fmt=op.t===E.PT.P?E.fmtP(ov):E.fmtC(ov);
        h+='<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1a1f30;font-size:11px;">';
        h+='<span style="color:#6a7090;">'+op.n+'</span>';
        h+='<span style="font-family:\'Courier New\',monospace;font-weight:700;"'+cls+'>'+fmt+'</span>';
        h+='</div>';
      });
      h+='</div>';
    }

    // Watch: flashy KPI display
    if(n.type==='watch'){
      var wv=0;
      E.wires().forEach(function(w){if(w.toNode===n.id){var fn=E.findNode(w.fromNode);if(fn)wv+=E.getOutput(fn,w.fromPort);}});
      var wcls=wv>0?' ng-vp':wv<0?' ng-vn':'';
      // Detect if it's a percentage value
      var isPercent=false;
      E.wires().forEach(function(w){if(w.toNode===n.id){var fn=E.findNode(w.fromNode);if(fn){var fd=E.DEFS[fn.type];if(fd&&fd.outs&&fd.outs[w.fromPort]&&fd.outs[w.fromPort].t===E.PT.P)isPercent=true;}}});
      var wvFmt=isPercent?E.fmtP(wv):E.fmtC(wv);
      h+='<div class="ng-watch-kpi'+wcls+'"><span class="ng-watch-kpi-val">'+wvFmt+'</span></div>';
      h+='<div class="ng-wv-label">'+n.label+'</div>';
    }

    // Note
    if(n.type==='note') h+='<div class="ng-note-body"><textarea data-node="'+n.id+'" placeholder="Type a note...">'+(n.noteText||'')+'</textarea></div>';

    // Collapsed row: progress bar + total + port circles — ONLY when collapsed
    if(n.collapsed && (hasIns||hasOuts)){
      var collVal = hasOuts ? E.getOutput(n,0) : 0;
      if(n.type==='watch'){collVal=0;E.wires().forEach(function(w){if(w.toNode===n.id){var fn=E.findNode(w.fromNode);if(fn)collVal+=E.getOutput(fn,w.fromPort);}});}
      // Port circles positioned absolutely on the node
      if(hasIns) h+='<div class="ng-coll-pi ng-p" data-node="'+n.id+'" data-pi="0" data-dir="in" data-type="'+d.ins[0].t+'"></div>';
      if(hasOuts) h+='<div class="ng-coll-po ng-p" data-node="'+n.id+'" data-pi="0" data-dir="out" data-type="'+d.outs[0].t+'"></div>';
      h+='<div class="ng-coll-row">';
      if(d.hasProg){
        var cpct = n.pctComplete||0;
        var cpColor = cpct>=100?'#34d399':cpct>=50?'#fbbf24':'#4f8cff';
        h+='<div class="ng-coll-prog"><div class="ng-coll-prog-fill" style="width:'+Math.min(cpct,100)+'%;background:'+cpColor+'"></div></div>';
        h+='<div class="ng-coll-inline">';
        if(n.budget) h+='<span class="ng-cv-bud">'+E.fmtC(n.budget)+'</span><span class="ng-coll-sep">|</span>';
        h+='<span class="ng-coll-pct">'+cpct.toFixed(0)+'%</span><span class="ng-coll-sep">|</span>';
        h+='<span class="ng-coll-val">'+E.fmtC(collVal)+'</span>';
        h+='</div>';
      } else if(n.type==='po'){
        E.resetComp(); E.getOutput(n,0);
        var poC=n._poContract||0, poI=n._poInvoiced||0;
        h+='<div class="ng-coll-detail"><span class="ng-coll-lbl">Contract</span><span class="ng-coll-val">'+E.fmtC(poC)+'</span></div>';
        h+='<div class="ng-coll-detail"><span class="ng-coll-lbl">Invoiced</span><span class="ng-coll-val ng-cv-grn">'+E.fmtC(poI)+'</span></div>';
      } else if(n.type==='co'){
        var coCost=n.data?n.data.estimatedCosts||0:0;
        h+='<div class="ng-coll-detail"><span class="ng-coll-lbl">Income</span><span class="ng-coll-val ng-cv-grn">'+E.fmtC(collVal)+'</span></div>';
        if(coCost) h+='<div class="ng-coll-detail"><span class="ng-coll-lbl">Est. Cost</span><span class="ng-coll-val ng-cv-yel">'+E.fmtC(coCost)+'</span></div>';
      } else if(n.type==='inv'){
        h+='<div class="ng-coll-detail"><span class="ng-coll-lbl">Amount</span><span class="ng-coll-val">'+E.fmtC(collVal)+'</span></div>';
      } else {
        h+='<span class="ng-coll-val" style="text-align:center;width:100%">'+E.fmtC(collVal)+'</span>';
      }
      h+='</div>';
    }

    // WIP vertical top/bottom input ports (always visible, even collapsed)
    if(n.type==='wip'){
      var ctop=wires.some(function(w){return w.toNode===n.id&&w.toPort===1;});
      var cbot=wires.some(function(w){return w.toNode===n.id&&w.toPort===2;});
      h+='<div class="ng-p ng-pv-top ng-p-currency'+(ctop?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="1" data-dir="in" data-type="currency" title="+ Costs / COs (top)"></div>';
      h+='<div class="ng-p ng-pv-bot ng-p-currency'+(cbot?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="2" data-dir="in" data-type="currency" title="+ Costs / COs (bottom)"></div>';
    }

    div.innerHTML=h;
    canvasEl.appendChild(div);
  });
}

function render(){
  updateTierLabels();
  updateT1Progress();
  pushToJobSilent();
  renderNodes();
  E.drawGrid(gridCtx, gridC.width, gridC.height);
  E.drawWires(wireCtx, wrap, wiringFrom, wireMouse);
  E.saveGraph();
  var z=document.querySelector('.ng-zoom');
  if(z) z.textContent=Math.round(E.zm()*100)+'%';
}

function applyTx(){
  var p=E.pan(), z=E.zm();
  canvasEl.style.transform='translate('+(p.x*z)+'px,'+(p.y*z)+'px) scale('+z+')';
}

// ── Data Picker — select existing job data to load as a node ──
function getJobEntries(type){
  if(typeof appData==='undefined'||!E.job()) return [];
  var jid=E.job();
  if(type==='co') return (appData.changeOrders||[]).filter(function(c){return c.jobId===jid;});
  if(type==='t1') return (appData.buildings||[]).filter(function(b){return b.jobId===jid;});
  if(type==='t2') return (appData.phases||[]).filter(function(p){return p.jobId===jid;});
  if(type==='sub') return (appData.subs||[]).filter(function(s){return s.jobId===jid;});
  if(type==='po') return (appData.purchaseOrders||[]).filter(function(p){return p.jobId===jid;});
  if(type==='inv') return (appData.invoices||[]).filter(function(i){return i.jobId===jid;});
  return [];
}
function entryLabel(type,e){
  if(type==='co') return (e.coNumber||'CO')+' '+(e.description||'').substring(0,40);
  if(type==='t1') return e.name||'Building';
  if(type==='t2') return e.phase||'Phase';
  if(type==='sub') return e.name||'Sub';
  if(type==='po') return (e.poNumber||'PO')+' '+(e.vendor||'').substring(0,40);
  if(type==='inv') return (e.invNumber||'INV')+' '+(e.vendor||'').substring(0,40);
  return e.name||e.id||'';
}
function findLoadedNode(type,entry){
  var nodes=E.nodes();
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i];
    if(n.type===type&&n.data&&n.data.id===entry.id) return n;
  }
  return null;
}
function focusNode(n){
  if(!wrap) return;
  var z=E.zm();
  var cx=-(n.x+85)+wrap.clientWidth/2/z;
  var cy=-(n.y+30)+wrap.clientHeight/2/z;
  E.pan(cx,cy);
  applyTx();
  render();
}
function showDataPicker(type, cb){
  var entries=getJobEntries(type);
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return cb(null);
  // Build picker overlay
  var overlay=document.createElement('div');
  overlay.className='ng-picker-overlay';
  var box=document.createElement('div');
  box.className='ng-picker-box';
  var title=E.DEFS[type]?E.DEFS[type].label:'Node';
  box.innerHTML='<div class="ng-picker-title">Load '+title+' from Job Data</div>';
  var list=document.createElement('div');
  list.className='ng-picker-list';
  entries.forEach(function(e){
    var existing=findLoadedNode(type,e);
    var row=document.createElement('div');
    row.className='ng-picker-item'+(existing?' ng-picker-loaded':'');
    row.textContent=entryLabel(type,e)+(existing?'  (on graph)':'');
    row.addEventListener('click',function(){
      tab.removeChild(overlay);
      if(existing){ focusNode(existing); cb(null,true); }
      else { cb(e); }
    });
    list.appendChild(row);
  });
  // "New" option at the bottom
  var newRow=document.createElement('div');
  newRow.className='ng-picker-item ng-picker-new';
  newRow.textContent='+ Create New '+title;
  newRow.addEventListener('click',function(){ tab.removeChild(overlay); cb(null); });
  list.appendChild(newRow);
  box.appendChild(list);
  // Cancel on overlay click
  overlay.addEventListener('click',function(ev){ if(ev.target===overlay){ tab.removeChild(overlay); } });
  overlay.appendChild(box);
  tab.appendChild(overlay);
}
var PICKABLE_TYPES={co:1,t1:1,t2:1,sub:1,po:1,inv:1};

// ── Sidebar ──
function buildSidebar(){
  var sb=document.querySelector('.ng-sidebar'); if(!sb) return;
  var html='<div class="ng-sidebar-header">Node Library</div>';
  html+='<div class="ng-sidebar-search"><input type="text" placeholder="Search..." id="ngSearch"/></div>';
  E.CATS.forEach(function(cat,ci){
    html+='<div class="ng-cat ng-open">';
    html+='<div class="ng-cat-header"><span class="ng-cat-arrow">\u25B6</span>'+cat.name+'</div>';
    html+='<div class="ng-cat-items">';
    cat.items.forEach(function(k){
      var d=E.DEFS[k]; if(!d) return;
      html+='<div class="ng-cat-item" data-type="'+k+'"><span>'+d.icon+'</span> '+d.label+'</div>';
    });
    html+='</div></div>';
  });
  sb.innerHTML=html;

  sb.addEventListener('click',function(e){
    var hdr=e.target.closest('.ng-cat-header');
    if(hdr){hdr.parentElement.classList.toggle('ng-open');return;}
    var item=e.target.closest('.ng-cat-item');
    if(item){
      var type=item.getAttribute('data-type');
      var d=E.DEFS[type]; if(!d) return;
      var p=E.pan(),z=E.zm();
      var cx=-p.x+wrap.clientWidth/2/z, cy=-p.y+wrap.clientHeight/2/z;
      if(PICKABLE_TYPES[type] && E.job()){
        showDataPicker(type, function(entry, focused){
          if(focused) return;
          if(entry){
            var lbl=entryLabel(type,entry);
            var newNode=E.addNode(type,cx-85,cy-30,lbl,entry);
            if(newNode) autoWireFromData(newNode, entry);
          } else {
            var label=d.label;
            if(d.nameEdit) label=prompt('Name:',label)||label;
            E.addNode(type,cx-85,cy-30,label);
          }
          render();
        });
      } else {
        var label=d.label;
        if(d.nameEdit) label=prompt('Name:',label)||label;
        E.addNode(type,cx-85,cy-30,label);
        render();
      }
    }
  });

  var si=document.getElementById('ngSearch');
  if(si) si.addEventListener('input',function(){
    var q=si.value.toLowerCase();
    sb.querySelectorAll('.ng-cat-item').forEach(function(el){
      el.style.display=el.textContent.toLowerCase().indexOf(q)>-1?'':'none';
    });
    if(q) sb.querySelectorAll('.ng-cat').forEach(function(el){el.classList.add('ng-open');});
  });
}

// ── Events ──
function initEvents(){
  var SN=E.SNAP, z=function(){return E.zm();};

  wrap.addEventListener('mousedown',function(e){
    if(e.target.closest('.ng-p')||e.target.closest('.ng-node')) return;
    isPan=true; wrap.classList.add('ng-panning');
    var p=E.pan();
    panSt={x:e.clientX/z()-p.x, y:e.clientY/z()-p.y};
    if(selN){selN=null;render();}
  });

  wrap.addEventListener('mousemove',function(e){
    if(isPan){
      E.pan(e.clientX/z()-panSt.x, e.clientY/z()-panSt.y);
      applyTx();
      E.drawGrid(gridCtx,gridC.width,gridC.height);
      E.drawWires(wireCtx,wrap,wiringFrom,wireMouse);
    }
    if(dragN){
      var n=E.findNode(dragN); if(!n) return;
      var p=E.pan();
      n.x=Math.round((e.clientX/z()-p.x-dragOff.x)/SN)*SN;
      n.y=Math.round((e.clientY/z()-p.y-dragOff.y)/SN)*SN;
      var el=canvasEl.querySelector('[data-id="'+n.id+'"]');
      if(el){el.style.left=n.x+'px';el.style.top=n.y+'px';}
      E.drawWires(wireCtx,wrap,wiringFrom,wireMouse);
    }
    if(wiringFrom){
      var r=wrap.getBoundingClientRect();
      wireMouse={x:e.clientX-r.left,y:e.clientY-r.top};
      E.drawWires(wireCtx,wrap,wiringFrom,wireMouse);
    }
  });

  wrap.addEventListener('mouseup',function(e){
    isPan=false; wrap.classList.remove('ng-panning'); dragN=null;
    if(wiringFrom){
      var tp=e.target.closest('[data-dir="in"]');
      if(tp){
        var toId=tp.getAttribute('data-node'), toPort=parseInt(tp.getAttribute('data-pi'));
        var toType=tp.getAttribute('data-type');
        var fn=E.findNode(wiringFrom.nid), fd=E.DEFS[fn?fn.type:''];
        var fromType=fd&&fd.outs[wiringFrom.pi]?fd.outs[wiringFrom.pi].t:E.PT.A;
        if(toId!==wiringFrom.nid && E.canConn(fromType,toType)){
          var ws=E.wires();
          var dup=ws.some(function(w){return w.fromNode===wiringFrom.nid&&w.fromPort===wiringFrom.pi&&w.toNode===toId&&w.toPort===toPort;});
          if(!dup) ws.push({fromNode:wiringFrom.nid,fromPort:wiringFrom.pi,toNode:toId,toPort:toPort});
        }
      }
      wiringFrom=null;wireMouse=null;render();
    }
  });

  wrap.addEventListener('wheel',function(e){
    e.preventDefault();
    var f=e.deltaY>0?0.93:1.07, cur=E.zm();
    var nz=Math.max(0.2,Math.min(3,cur*f));
    var r=wrap.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    var p=E.pan();
    E.pan(mx/nz-(mx/cur-p.x), my/nz-(my/cur-p.y));
    E.zm(nz); applyTx(); render();
  },{passive:false});

  canvasEl.addEventListener('mousedown',function(e){
    var port=e.target.closest('[data-dir="out"]');
    if(port){e.stopPropagation();wiringFrom={nid:port.getAttribute('data-node'),pi:parseInt(port.getAttribute('data-pi'))};return;}
    var eb=e.target.closest('.ng-editbtn');
    if(eb){
      e.stopPropagation();
      var en=E.findNode(eb.getAttribute('data-edit'));
      if(en && en.data && en.data.id){
        if(en.type==='t1' && typeof editBuilding==='function') editBuilding(en.data.id);
        else if(en.type==='t2' && typeof editPhase==='function') editPhase(en.data.id);
        else if(en.type==='sub' && typeof editSub==='function') editSub(en.data.id);
        else if(en.type==='co' && typeof editCO==='function') editCO(en.data.id);
        else if(en.type==='po' && typeof editPO==='function') editPO(en.data.id);
        else if(en.type==='inv' && typeof editInvoice==='function') editInvoice(en.data.id);
      }
      return;
    }
    var db=e.target.closest('.ng-dupbtn');
    if(db){e.stopPropagation();duplicateNode(db.getAttribute('data-dup'));return;}
    var cb=e.target.closest('.ng-cbtn');
    if(cb){e.stopPropagation();var cn=E.findNode(cb.getAttribute('data-coll'));if(cn){cn.collapsed=!cn.collapsed;render();}return;}
    // Click progress bar / label to edit %
    var pe=e.target.closest('[data-prog-edit]');
    if(pe && !e.target.closest('input')){
      e.preventDefault();
      e.stopPropagation();
      var pn=E.findNode(pe.getAttribute('data-prog-edit'));
      if(!pn) return;
      var nodeEl=canvasEl.querySelector('[data-id="'+pn.id+'"]');
      var pctSpan=nodeEl?nodeEl.querySelector('.ng-pct-val'):null;
      if(!pctSpan) return;
      editingId=pn.id; // set BEFORE any DOM manipulation that could trigger render
      var inp=document.createElement('input');
      inp.type='number'; inp.min=0; inp.max=100; inp.step=1;
      inp.value=Math.round(pn.pctComplete||0);
      inp.dataset.progInput='1';
      inp.style.cssText='width:54px;font-family:\'Courier New\',monospace;font-weight:700;background:var(--ng-input);border:1px solid #4f8cff;color:#fbbf24;border-radius:3px;padding:1px 4px;outline:none;text-align:right;font-size:11px';
      pctSpan.textContent=''; pctSpan.appendChild(inp);
      // Focus on next tick so the mousedown finishes first and doesn't steal focus
      setTimeout(function(){ inp.focus(); inp.select(); }, 0);
      var done=false;
      function finish(){
        if(done) return; done=true;
        pn.pctComplete=Math.max(0,Math.min(100,parseFloat(inp.value)||0));
        editingId=null; render();
      }
      inp.addEventListener('blur',finish);
      inp.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'){ev.preventDefault();inp.blur();}
        else if(ev.key==='Escape'){ev.preventDefault();done=true;editingId=null;render();}
      });
      // Stop further mousedown propagation on the input itself
      inp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
      return;
    }
    // Click WIP field chip → reveal editable input
    var wc=e.target.closest('[data-wip-edit]');
    if(wc && !e.target.closest('input')){
      e.preventDefault(); e.stopPropagation();
      var wn=E.findNode(wc.getAttribute('data-wip-edit'));
      if(!wn) return;
      var wkey=wc.getAttribute('data-wip-key');
      var wtyp=wc.getAttribute('data-wip-type');
      if(!wn.jobFields) wn.jobFields={};
      editingId=wn.id;
      var winp=document.createElement('input');
      winp.type='number'; winp.step=wtyp==='p'?'0.1':'0.01';
      if(wtyp==='p'){winp.min=0;winp.max=100;}
      winp.value=wn.jobFields[wkey]||0;
      winp.className='ng-wip-chip-input';
      wc.textContent=''; wc.appendChild(winp);
      setTimeout(function(){ winp.focus(); winp.select(); }, 0);
      var wdone=false;
      function wfinish(){
        if(wdone) return; wdone=true;
        var nv=parseFloat(winp.value)||0;
        if(wtyp==='p') nv=Math.max(0,Math.min(100,nv));
        wn.jobFields[wkey]=nv;
        editingId=null; render();
      }
      winp.addEventListener('blur',wfinish);
      winp.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'){ev.preventDefault();winp.blur();}
        else if(ev.key==='Escape'){ev.preventDefault();wdone=true;editingId=null;render();}
      });
      winp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
      return;
    }
    // Add sub-item (inline — just adds a blank row)
    var addSub=e.target.closest('.ng-add-sub');
    if(addSub){
      e.stopPropagation();
      var n=E.findNode(addSub.getAttribute('data-node'));
      if(n){
        var d2=E.DEFS[n.type], iT=d2?d2.itemType:'';
        var newItem={date:''};
        if(iT==='labor'){newItem.hours=0;newItem.rate=65;}
        else if(iT==='mat'){newItem.amount=0;}
        else if(iT==='gc'){newItem.vendor='';newItem.amount=0;}
        else if(iT==='other'){newItem.qty=0;newItem.unitCost=0;}
        else if(iT==='sub'){newItem.desc='';newItem.amount=0;}
        else if(iT==='po'){newItem.desc='';newItem.amount=0;}
        else if(iT==='inv'){newItem.invNum='';newItem.amount=0;}
        else{newItem.amount=0;}
        n.items.push(newItem);
        render();
      }
      return;
    }
    // Delete sub-item
    var delSub=e.target.closest('.ng-subitem-del');
    if(delSub){
      e.stopPropagation();
      var n2=E.findNode(delSub.getAttribute('data-node'));
      var idx=parseInt(delSub.getAttribute('data-idx'));
      if(n2&&!isNaN(idx)){n2.items.splice(idx,1);render();}
      return;
    }
    var nel=e.target.closest('.ng-node');
    if(nel&&!e.target.closest('input')&&!e.target.closest('textarea')&&!e.target.closest('[data-rename]')){
      e.stopPropagation();
      var nid2=nel.getAttribute('data-id'),n3=E.findNode(nid2);if(!n3)return;
      // Deselect old, select new without full re-render
      if(selN&&selN!==nid2){var old=canvasEl.querySelector('[data-id="'+selN+'"]');if(old)old.classList.remove('ng-sel');}
      selN=nid2; dragN=nid2;
      nel.classList.add('ng-sel');
      updateConnectedHighlight();
      var p=E.pan();
      dragOff={x:e.clientX/z()-p.x-n3.x, y:e.clientY/z()-p.y-n3.y};
    }
  });

  // Double-click to rename node
  canvasEl.addEventListener('dblclick',function(e){
    var nameEl=e.target.closest('[data-rename]');
    if(nameEl){
      e.stopPropagation();
      var n=E.findNode(nameEl.getAttribute('data-rename'));
      if(!n) return;
      var inp=document.createElement('input');
      inp.type='text'; inp.value=n.label;
      inp.style.cssText='font-size:10px;font-weight:700;text-transform:uppercase;background:#0d1019;border:1px solid #4f8cff;color:#e4e6f0;border-radius:3px;padding:1px 4px;width:100%;outline:none;letter-spacing:.6px;';
      nameEl.textContent='';
      nameEl.appendChild(inp);
      inp.focus(); inp.select();
      editingId=n.id;
      function finish(){ n.label=inp.value||n.label; editingId=null; render(); }
      inp.addEventListener('blur',finish);
      inp.addEventListener('keydown',function(ev){ if(ev.key==='Enter'){ev.preventDefault();finish();} });
      return;
    }
  });

  canvasEl.addEventListener('focusin',function(e){
    var t=e.target;
    if((t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT')&&t.dataset.node){
      editingId=t.dataset.node;
      if(t.type==='number') setTimeout(function(){ t.select(); },0);
    }
  });
  canvasEl.addEventListener('focusout',function(e){
    var t=e.target;
    if((t.tagName==='INPUT'||t.tagName==='TEXTAREA')&&t.dataset.node){
      var n=E.findNode(t.dataset.node);
      if(n){
        if(t.tagName==='TEXTAREA') n.noteText=t.value;
        else if(t.dataset.idx!=null&&t.dataset.field){
          // Sub-item field edit
          var idx=parseInt(t.dataset.idx);
          if(n.items&&n.items[idx]){
            var f=t.dataset.field;
            if(f==='amount'||f==='hours'||f==='rate'||f==='qty'||f==='unitCost') n.items[idx][f]=parseFloat(t.value)||0;
            else n.items[idx][f]=t.value;
          }
        }
        else if(t.dataset.field==='pctComplete') n.pctComplete=Math.max(0,Math.min(100,parseFloat(t.value)||0));
        else if(t.dataset.jfield){ if(!n.jobFields)n.jobFields={}; n.jobFields[t.dataset.jfield]=parseFloat(t.value)||0; }
        else n.value=parseFloat(t.value)||0;
      }
      editingId=null; render();
    }
  });
  canvasEl.addEventListener('input',function(e){
    var t=e.target;
    if(t.tagName==='INPUT'&&t.dataset.node){
      var n=E.findNode(t.dataset.node);
      if(!n) return;
      if(t.dataset.idx!=null&&t.dataset.field){
        var idx=parseInt(t.dataset.idx);
        if(n.items&&n.items[idx]){
          var f=t.dataset.field;
          if(f==='amount'||f==='hours'||f==='rate'||f==='qty'||f==='unitCost') n.items[idx][f]=parseFloat(t.value)||0;
          else n.items[idx][f]=t.value;
        }
        // Update total display + row total
        E.resetComp();
        var totalEl=canvasEl.querySelector('[data-id="'+n.id+'"] .ng-sub-total');
        if(totalEl) totalEl.textContent=E.fmtC(E.getOutput(n,0));
        // Update inline row totals
        var rowTotals=canvasEl.querySelectorAll('[data-id="'+n.id+'"] .ng-si-val');
        n.items.forEach(function(item,ri){
          if(rowTotals[ri]){
            var d2=E.DEFS[n.type],iT=d2?d2.itemType:'';
            var rv=0;
            if(iT==='labor') rv=(item.hours||0)*(item.rate||65);
            else if(iT==='mat'||iT==='other') rv=(item.qty||0)*(item.unitCost||0);
            rowTotals[ri].textContent=E.fmtC(rv);
          }
        });
      } else if(t.dataset.jfield){
        if(!n.jobFields) n.jobFields={};
        n.jobFields[t.dataset.jfield]=parseFloat(t.value)||0;
      } else if(t.dataset.field==='pctComplete'){
        n.pctComplete=Math.max(0,Math.min(100,parseFloat(t.value)||0));
        var nodeEl=canvasEl.querySelector('[data-id="'+n.id+'"]');
        if(nodeEl){
          var fill=nodeEl.querySelector('.ng-progress-fill');
          var lbl=nodeEl.querySelector('.ng-pct-val');
          var pc=n.pctComplete;
          if(fill){fill.style.width=Math.min(pc,100)+'%';fill.style.background=pc>=100?'#34d399':pc>=50?'#fbbf24':'#4f8cff';}
          if(lbl)lbl.textContent=pc.toFixed(0)+'%';
        }
        E.drawWires(wireCtx,wrap,wiringFrom,wireMouse);
      } else {
        n.value=parseFloat(t.value)||0;
      }
    }
    // Handle select (unit dropdown)
    if(t.tagName==='SELECT'&&t.dataset.node&&t.dataset.idx!=null){
      var ns=E.findNode(t.dataset.node);
      if(ns&&ns.items){var si=parseInt(t.dataset.idx);if(ns.items[si])ns.items[si][t.dataset.field]=t.value;}
    }
    if(t.tagName==='TEXTAREA'&&t.dataset.node){
      var n2=E.findNode(t.dataset.node);
      if(n2) n2.noteText=t.value;
    }
  });

  // Right-click wire to delete
  wrap.addEventListener('contextmenu',function(e){
    e.preventDefault();
    var r=wrap.getBoundingClientRect(),p=E.pan(),z2=E.zm();
    var mx=(e.clientX-r.left)/z2-p.x, my=(e.clientY-r.top)/z2-p.y;
    var ci=-1,cd=40,ws=E.wires();
    ws.forEach(function(w,i){
      var p1=E.portPos(w.fromNode,w.fromPort,'out'),p2=E.portPos(w.toNode,w.toPort,'in');
      for(var t=0;t<=1;t+=0.05){
        var px=p1.x+(p2.x-p1.x)*t,py=p1.y+(p2.y-p1.y)*t;
        var dd=Math.sqrt((mx-px)*(mx-px)+(my-py)*(my-py));
        if(dd<cd){cd=dd;ci=i;}
      }
    });
    if(ci>=0){ws.splice(ci,1);render();}
  });

  document.addEventListener('keydown',function(e){
    if(!document.getElementById('nodeGraphTab').classList.contains('active')) return;
    if(e.key==='Delete'&&selN&&document.activeElement.tagName!=='INPUT'&&document.activeElement.tagName!=='TEXTAREA'){
      e.preventDefault();
      var delNode=E.findNode(selN);
      if(!delNode) return;
      showDeleteDialog(delNode);
    }
  });
}

function showDeleteDialog(delNode){
  var existing=document.getElementById('ng-delete-dialog');
  if(existing) existing.remove();

  var typeLabels={t1:'Building',t2:'Phase',sub:'Sub',co:'Change Order',po:'Purchase Order',inv:'Invoice',wip:'WIP'};
  var typeName=typeLabels[delNode.type]||delNode.type;
  var hasData=delNode.data&&delNode.data.id&&typeof appData!=='undefined';

  var overlay=document.createElement('div');
  overlay.id='ng-delete-dialog';
  overlay.className='ng-del-overlay';

  var box=document.createElement('div');
  box.className='ng-del-box';

  var title=document.createElement('div');
  title.className='ng-del-title';
  title.textContent='Delete "'+delNode.label+'"';
  box.appendChild(title);

  var sub=document.createElement('div');
  sub.className='ng-del-sub';
  sub.textContent=typeName+(hasData?' \u2014 This item has job data attached.':' \u2014 Graph-only node.');
  box.appendChild(sub);

  var btns=document.createElement('div');
  btns.className='ng-del-btns';

  var removeBtn=document.createElement('button');
  removeBtn.className='ng-del-btn ng-del-remove';
  removeBtn.textContent='Remove from Graph';
  removeBtn.title='Removes the node from the graph but keeps the data in the job';
  removeBtn.addEventListener('click',function(){
    var ws=E.wires();
    E.setWires(ws.filter(function(w){return w.fromNode!==delNode.id&&w.toNode!==delNode.id;}));
    E.setNodes(E.nodes().filter(function(n){return n.id!==delNode.id;}));
    selN=null;overlay.remove();render();
  });
  btns.appendChild(removeBtn);

  if(hasData){
    var deleteBtn=document.createElement('button');
    deleteBtn.className='ng-del-btn ng-del-permanent';
    deleteBtn.textContent='Delete from Job';
    deleteBtn.title='Permanently removes the node AND deletes the data from the job';
    deleteBtn.addEventListener('click',function(){
      if(delNode.type==='t1') appData.buildings=appData.buildings.filter(function(b){return b.id!==delNode.data.id;});
      else if(delNode.type==='t2') appData.phases=appData.phases.filter(function(p){return p.id!==delNode.data.id;});
      else if(delNode.type==='sub') appData.subs=appData.subs.filter(function(s){return s.id!==delNode.data.id;});
      else if(delNode.type==='co') appData.changeOrders=appData.changeOrders.filter(function(c){return c.id!==delNode.data.id;});
      if(typeof saveData==='function') saveData();
      var ws=E.wires();
      E.setWires(ws.filter(function(w){return w.fromNode!==delNode.id&&w.toNode!==delNode.id;}));
      E.setNodes(E.nodes().filter(function(n){return n.id!==delNode.id;}));
      selN=null;overlay.remove();render();
    });
    btns.appendChild(deleteBtn);
  }

  var cancelBtn=document.createElement('button');
  cancelBtn.className='ng-del-btn ng-del-cancel';
  cancelBtn.textContent='Cancel';
  cancelBtn.addEventListener('click',function(){overlay.remove();});
  btns.appendChild(cancelBtn);

  box.appendChild(btns);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.remove();});
}

// ── Duplicate a node ──
function duplicateNode(nodeId){
  var src=E.findNode(nodeId); if(!src) return;
  var d=E.DEFS[src.type]; if(!d) return;
  if(d.master) return; // don't duplicate WIP
  var nn=E.addNode(src.type, src.x+40, src.y+40, src.label);
  if(!nn) return;
  nn.value=src.value;
  nn.budget=src.budget;
  nn.pctComplete=src.pctComplete;
  nn.noteText=src.noteText||'';
  if(src.items&&src.items.length){
    nn.items=JSON.parse(JSON.stringify(src.items));
  }
  if(src.jobFields&&Object.keys(src.jobFields).length){
    nn.jobFields=JSON.parse(JSON.stringify(src.jobFields));
  }
  render();
}

// ── Push node data back to job ──
function pushToJob(){
  if(typeof appData==='undefined') return;
  var jid=E.job(); if(!jid) return;
  var job=appData.jobs.find(function(j){return j.id===jid;});
  if(!job) return;
  var nodes=E.nodes(), wires=E.wires();

  // Job Revenue node → job fields
  nodes.forEach(function(n){
    if(n.type==='job'&&n.jobFields){
      var jf=n.jobFields;
      if(jf.contractAmount!=null) job.contractAmount=jf.contractAmount;
      if(jf.estimatedCosts!=null) job.estimatedCosts=jf.estimatedCosts;
      if(jf.revisedCostChanges!=null) job.revisedCostChanges=jf.revisedCostChanges;
      if(jf.targetMarginPct!=null) job.targetMarginPct=jf.targetMarginPct;
    }
  });

  // T1 nodes → buildings (match by data.id or by label)
  nodes.forEach(function(n){
    if(n.type!=='t1') return;
    var bldg=n.data&&n.data.id?appData.buildings.find(function(b){return b.id===n.data.id;}):null;
    if(!bldg) return;
    // Sync name
    var bName=n.label.split(' \u203A ')[0].trim();
    if(bName) bldg.name=bName;
    // Budget from node
    if(n.budget) bldg.budget=n.budget;
    // % complete
    bldg.pctComplete=n.pctComplete||0;
    // Sum costs from wired cost nodes
    var mat=0,lab=0,equip=0,gc=0;
    wires.forEach(function(w){
      if(w.toNode!==n.id) return;
      var src=E.findNode(w.fromNode);
      if(!src) return;
      // Check what type of cost node is wired in
      if(src.type==='t2'){
        // T2 costs roll into building via the total
      } else {
        var val=E.getOutput(src,w.fromPort);
        if(src.type==='labor') lab+=val;
        else if(src.type==='mat') mat+=val;
        else if(src.type==='gc') gc+=val;
        else if(src.type==='other') equip+=val;
      }
    });
    bldg.materials=mat;
    bldg.labor=lab;
    bldg.equipment=equip;
  });

  // T2 nodes → phases (match by data.id)
  nodes.forEach(function(n){
    if(n.type!=='t2') return;
    var phase=n.data&&n.data.id?appData.phases.find(function(p){return p.id===n.data.id;}):null;
    if(!phase) return;
    var pName=n.label.split(' \u203A ')[0].trim();
    if(pName) phase.phase=pName;
    phase.pctComplete=n.pctComplete||0;
    // Sum costs from wired cost nodes
    var mat=0,lab=0,equip=0;
    wires.forEach(function(w){
      if(w.toNode!==n.id) return;
      var src=E.findNode(w.fromNode);
      if(!src) return;
      var val=E.getOutput(src,w.fromPort);
      if(src.type==='labor') lab+=val;
      else if(src.type==='mat') mat+=val;
      else if(src.type==='other') equip+=val;
    });
    phase.materials=mat;
    phase.labor=lab;
    phase.equipment=equip;
  });

  // Sub nodes → subs (match by data.id)
  // contractAmt = sum of wired costs (PO contracts + direct invoices)
  // billedToDate = actual billed portion (getActual follows invoices only)
  nodes.forEach(function(n){
    if(n.type!=='sub') return;
    var sub=n.data&&n.data.id?appData.subs.find(function(s){return s.id===n.data.id;}):null;
    if(!sub) return;
    if(n.label) sub.name=n.label;
    E.resetComp();
    sub.contractAmt=E.getOutput(n,0);
    sub.billedToDate=E.getActual(n);
  });

  // Job-level costs: sum all cost nodes NOT wired to any T1/T2
  var jobMat=0,jobLab=0,jobEquip=0,jobGC=0;
  nodes.forEach(function(n){
    if(n.type!=='labor'&&n.type!=='mat'&&n.type!=='gc'&&n.type!=='other') return;
    // Check if this cost node is wired to a T1 or T2
    var wiredToTier=wires.some(function(w){
      if(w.fromNode!==n.id) return false;
      var target=E.findNode(w.toNode);
      return target&&(target.type==='t1'||target.type==='t2');
    });
    if(wiredToTier) return; // already counted at building/phase level
    var val=E.getOutput(n,0);
    if(n.type==='labor') jobLab+=val;
    else if(n.type==='mat') jobMat+=val;
    else if(n.type==='gc') jobGC+=val;
    else if(n.type==='other') jobEquip+=val;
  });
  job.materials=jobMat;
  job.labor=jobLab;
  job.equipment=jobEquip;
  job.generalConditions=jobGC;

  // CO nodes → sync income back to appData.changeOrders, and backflow wired CO revenue
  // into the target node's budget field (job.contractAmount / building.budget / phase.phaseBudget).
  // Uses per-target `coRevFromNG` tracking to keep the operation idempotent across repeated saves.
  var coTargets = {}; // targetNodeId -> sum of wired CO income (split across targets)
  nodes.forEach(function(co){
    if(co.type!=='co') return;
    var income = E.getOutput(co, 0);
    // Sync CO income to its appData entry (total, not split)
    if(co.data && co.data.id){
      var entry = appData.changeOrders.find(function(c){return c.id===co.data.id;});
      if(entry) entry.income = income;
    }
    // Find unique T1/T2/WIP targets this CO connects to
    var targetIds = {};
    wires.forEach(function(w){
      if(w.fromNode!==co.id) return;
      var target = E.findNode(w.toNode); if(!target) return;
      if(target.type==='t1' || target.type==='t2' || target.type==='wip'){
        targetIds[target.id] = true;
      }
    });
    var ids = Object.keys(targetIds);
    if(ids.length === 0) return;
    var share = income / ids.length;
    ids.forEach(function(tid){
      coTargets[tid] = (coTargets[tid]||0) + share;
    });
  });
  nodes.forEach(function(n){
    var wiredCO = coTargets[n.id] || 0;
    if(n.type==='t1' && n.data && n.data.id){
      var bldg = appData.buildings.find(function(b){return b.id===n.data.id;});
      if(bldg){
        bldg.coBudget = wiredCO;
        bldg.budget = (bldg.asSoldBudget||0) + bldg.coBudget;
        n.budget = bldg.budget;
        n._coRevApplied = wiredCO;
      }
    } else if(n.type==='t2' && n.data && n.data.id){
      var phase = appData.phases.find(function(p){return p.id===n.data.id;});
      if(phase){
        phase.coPhaseBudget = wiredCO;
        phase.phaseBudget = (phase.asSoldPhaseBudget||0) + phase.coPhaseBudget;
        n.budget = phase.phaseBudget;
        n._coRevApplied = wiredCO;
      }
    } else if(n.type==='wip'){
      var prevApplied = n._coRevApplied || 0;
      if(prevApplied) job.contractAmount = (job.contractAmount||0) - prevApplied;
      n._coRevApplied = 0;
    }
  });

  // Persist WIP node's computed actual + accrued onto the job so the
  // sticky header can display them directly instead of re-deriving.
  var wipNode=nodes.find(function(n){return n.type==='wip';});
  if(wipNode){
    E.resetComp();
    job.ngActualCosts=E.getOutput(wipNode,1);
    job.ngAccruedCosts=E.getOutput(wipNode,6);
  }

  if(typeof recalcSubCosts==='function') recalcSubCosts(jid);
  if(typeof saveData==='function') saveData();
  if(typeof refreshHeaderMetrics==='function') refreshHeaderMetrics();
}

/** Silent sync — called on every render, no UI refresh */
function pushToJobSilent(){
  try { pushToJob(); } catch(e){}
}

// Auto-wire a newly added node based on its data relationships,
// mirroring the wiring logic used in populate() — so picker-added
// nodes connect to their parent automatically.
function autoWireFromData(n, entry){
  if(!n || !entry) return;
  var nodes=E.nodes(), wires=E.wires();
  var addWire=function(fromId,fromPort,toId,toPort){
    wires.push({fromNode:fromId,fromPort:fromPort||0,toNode:toId,toPort:toPort||0});
  };
  if(n.type==='t1'){
    // Building → wire to WIP Costs port (0)
    var wipNode=nodes.find(function(nd){return nd.type==='wip';});
    if(wipNode) addWire(n.id,0,wipNode.id,0);
  } else if(n.type==='t2'){
    // Phase → wire to parent T1 (by buildingId)
    if(entry.buildingId){
      var t1=nodes.find(function(nd){return nd.type==='t1'&&nd.data&&nd.data.id===entry.buildingId;});
      if(t1) addWire(n.id,0,t1.id,0);
    }
  } else if(n.type==='sub'){
    // Sub → wire to parent T1(s) (by buildingIds)
    var bids=entry.buildingIds||(entry.buildingId?[entry.buildingId]:[]);
    bids.forEach(function(bid){
      var t1=nodes.find(function(nd){return nd.type==='t1'&&nd.data&&nd.data.id===bid;});
      if(t1) addWire(n.id,0,t1.id,0);
    });
  } else if(n.type==='co'){
    // CO → wire to targets based on allocations
    if(entry.allocationType==='job' || !entry.allocations || !entry.allocations.length){
      var wipNode2=nodes.find(function(nd){return nd.type==='wip';});
      if(wipNode2) addWire(n.id,0,wipNode2.id,1); // top CO port
    } else {
      entry.allocations.forEach(function(a){
        if(a.phaseId){
          var t2=nodes.find(function(nd){return nd.type==='t2'&&nd.data&&nd.data.id===a.phaseId;});
          if(t2) addWire(n.id,0,t2.id,0);
        } else if(a.buildingId){
          var t1=nodes.find(function(nd){return nd.type==='t1'&&nd.data&&nd.data.id===a.buildingId;});
          if(t1) addWire(n.id,0,t1.id,0);
        }
      });
    }
  } else if(n.type==='po'){
    // PO → wire to parent Sub (by subId)
    if(entry.subId){
      var sub=nodes.find(function(nd){return nd.type==='sub'&&nd.data&&nd.data.id===entry.subId;});
      if(sub) addWire(n.id,0,sub.id,0);
    }
  } else if(n.type==='inv'){
    // Invoice → wire to parent PO (by poId)
    if(entry.poId){
      var po=nodes.find(function(nd){return nd.type==='po'&&nd.data&&nd.data.id===entry.poId;});
      if(po) addWire(n.id,0,po.id,0);
    }
  }
}

// ── Populate from job ──
function populate(){
  if(typeof appData==='undefined') return;
  var jid=E.job();
  if(!jid&&typeof appState!=='undefined') jid=appState.currentJobId;
  if(!jid) return;
  var job=appData.jobs.find(function(j){return j.id===jid;});
  if(!job) return;

  var p=E.pan(),z=E.zm();
  var cx=-p.x+(wrap?wrap.clientWidth/2/z:500);
  var cy=-p.y+(wrap?wrap.clientHeight/2/z:300);
  var sx=cx-550, sy=cy-250;

  // Col 1: T1 (buildings)
  var bldgs=appData.buildings.filter(function(b){return b.jobId===jid;});
  bldgs.forEach(function(b,i){
    var n=E.addNode('t1',sx,sy+i*180,b.name||'Building',b);
    if(n){n.budget=b.budget||0; n.pctComplete=b.pctComplete||0;}
  });

  // Col 2: T2 (phases) — wire to their T1
  var phases=appData.phases.filter(function(p2){return p2.jobId===jid;});
  phases.forEach(function(ph,i){
    var bl=appData.buildings.find(function(b){return b.id===ph.buildingId;});
    var n=E.addNode('t2',sx+230,sy+i*140,ph.phase+(bl?' \u203A '+bl.name:''),ph);
    if(n){n.budget=ph.phaseBudget||0; n.pctComplete=ph.pctComplete||0;}
    // Auto-wire T2→T1
    if(bl&&n){
      var t1=E.nodes().find(function(nd){return nd.type==='t1'&&nd.data&&nd.data.id===bl.id;});
      if(t1) E.wires().push({fromNode:n.id,fromPort:0,toNode:t1.id,toPort:0});
    }
  });

  // Col 3: Subs — wire to their T1 via buildingId
  var subs=appData.subs.filter(function(s){return s.jobId===jid;});
  subs.forEach(function(s,i){
    var sn=E.addNode('sub',sx+460,sy+i*110,s.name||'Sub',s);
    if(sn){
      sn.pctComplete=s.pctComplete||0;
      // Auto-wire Sub→T1 (Actual Cost → Costs)
      var bids=s.buildingIds||(s.buildingId?[s.buildingId]:[]);
      if(bids.length>0){
        var t1=E.nodes().find(function(nd){return nd.type==='t1'&&nd.data&&bids.indexOf(nd.data.id)>-1;});
        if(t1) E.wires().push({fromNode:sn.id,fromPort:0,toNode:t1.id,toPort:0});
      }
    }
  });

  // Col 3 (lower): COs
  var cos=appData.changeOrders.filter(function(c){return c.jobId===jid;});
  cos.forEach(function(c,i){
    E.addNode('co',sx+460,sy+subs.length*110+40+i*110,(c.coNumber||'CO')+' '+c.description,c);
  });

  // Col 4: WIP node — T1s wire directly in, revenue fields inside
  var coArr=appData.changeOrders.filter(function(c){return c.jobId===jid;});
  var coInc=coArr.reduce(function(s,c){return s+(c.income||0);},0);
  var coCst=coArr.reduce(function(s,c){return s+(c.estimatedCosts||0);},0);
  var wipNode=E.addNode('wip',sx+700,sy+50,'WIP');
  if(wipNode){
    wipNode.jobFields={
      contractAmount:job.contractAmount||0,
      coIncome:coInc,
      estimatedCosts:job.estimatedCosts||0,
      coCosts:coCst,
      revisedCostChanges:job.revisedCostChanges||0,
      invoicedToDate:job.invoicedToDate||0,
      pctComplete:job.pctComplete||0,
    };
    // Wire all T1s directly into WIP
    E.nodes().forEach(function(nd){
      if(nd.type==='t1') E.wires().push({fromNode:nd.id,fromPort:0,toNode:wipNode.id,toPort:0});
    });
  }

  // Col 5: Watch nodes — one per WIP output, octopus fan to the right
  var wipDef = E.DEFS.wip;
  var wipOuts = wipDef ? wipDef.outs : [];
  var wipCx = sx+700+160;
  var wipCy = sy+50+220;
  var radius = 780;
  var count = wipOuts.length;
  var arcSpan = 170; // total arc degrees — wider so tentacles clear each other
  var arcStart = -arcSpan/2;
  wipOuts.forEach(function(op,i){
    var angleDeg = count>1 ? arcStart + arcSpan*i/(count-1) : 0;
    var a = angleDeg*Math.PI/180;
    var wx = wipCx + Math.cos(a)*radius;
    var wy = wipCy + Math.sin(a)*radius - 70;
    var w = E.addNode('watch',wx,wy,op.n);
    if(w&&wipNode) E.wires().push({fromNode:wipNode.id,fromPort:i,toNode:w.id,toPort:0});
  });
}

// ── Init ──
function init(){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  wrap=tab.querySelector('.ng-canvas-area');
  canvasEl=tab.querySelector('.ng-canvas');
  wireC=tab.querySelector('.ng-wire-canvas'); wireCtx=wireC.getContext('2d');
  gridC=tab.querySelector('.ng-grid-canvas'); gridCtx=gridC.getContext('2d');
  E.setCanvasEl(canvasEl);
  buildSidebar(); initEvents(); applyTx();

  tab.querySelector('.ng-tbtn-close').addEventListener('click',function(){
    E.saveGraph(); tab.classList.remove('active');
  });
  var pb=tab.querySelector('.ng-populate-btn');
  if(pb) pb.addEventListener('click',function(){
    E.setNodes([]); E.setWires([]); E.setNid(1);
    populate(); render();
  });

  // Push to job
  // Collapse all
  var cab=tab.querySelector('.ng-collapse-all-btn');
  if(cab) cab.addEventListener('click',function(){
    E.nodes().forEach(function(n){ if(n.type!=='note') n.collapsed=true; });
    render();
  });

  // Expand all
  var eab=tab.querySelector('.ng-expand-all-btn');
  if(eab) eab.addEventListener('click',function(){
    E.nodes().forEach(function(n){ n.collapsed=false; });
    render();
  });

  // Auto arrange
  var aab=tab.querySelector('.ng-arrange-btn');
  if(aab) aab.addEventListener('click',function(){ autoArrange(selN); render(); });

  // Redraw grid when theme changes so new colors take effect
  document.addEventListener('agx-theme-change', function(){
    if(gridC && gridCtx) E.drawGrid(gridCtx, gridC.width, gridC.height);
  });
}

// ── Auto Arrange ──
// Inverse octopus fan: source nodes radiate outward from their downstream
// targets, mirroring how watch nodes fan from WIP outputs but in reverse.
// Each sub-fan follows the outward direction of its branch so fans don't overlap.
function autoArrange(selectedId){
  var allNodes=E.nodes(), wires=E.wires();
  if(!allNodes.length) return;

  var nodes=allNodes.filter(function(n){return n.type!=='watch'&&n.type!=='note';});
  if(!nodes.length) return;

  var p=E.pan(),z=E.zm();
  var cx=-p.x+(wrap?wrap.clientWidth/2/z:500);
  var cy=-p.y+(wrap?wrap.clientHeight/2/z:300);
  var SNAP=E.SNAP;
  var placed={};

  function inputsOf(targetId){
    var tgt=E.findNode(targetId);
    var isWip=tgt && tgt.type==='wip';
    var srcs=[], seen={};
    wires.forEach(function(w){
      if(w.toNode===targetId){
        // For WIP: exclude top/bottom gill connections; they're placed separately
        if(isWip && (w.toPort===1 || w.toPort===2)) return;
        var s=E.findNode(w.fromNode);
        if(s&&!seen[s.id]&&s.type!=='watch'&&s.type!=='note'){
          seen[s.id]=true; srcs.push(s);
        }
      }
    });
    // Fan order: T1/T2 first (primary hierarchy), then sub/po/inv; COs excluded
    var typeRank={t1:1, t2:2, sub:3, po:4, inv:5, labor:6, mat:7, gc:8, other:9, sum:10, sub2:10, mul:10, pct:10, job:11};
    srcs=srcs.filter(function(s){return s.type!=='co';});
    srcs.sort(function(a,b){return (typeRank[a.type]||99)-(typeRank[b.type]||99);});
    return srcs;
  }

  // Fan inputs — elliptical layout, yScale compresses vertically.
  function fanInputs(target, radius, arcSpan, outAngle, yScale, skipTypes){
    var srcs=inputsOf(target.id).filter(function(s){
      if(placed[s.id]) return false;
      if(skipTypes && skipTypes[s.type]) return false;
      return true;
    });
    if(!srcs.length) return [];
    var tcx=target.x+160, tcy=target.y+(target.type==='wip'?220:100);
    var count=srcs.length;
    var arcStart=-arcSpan/2;
    var result=[];
    srcs.forEach(function(s,i){
      placed[s.id]=true;
      var angleDeg=count>1?arcStart+arcSpan*i/(count-1):0;
      var a=(outAngle+angleDeg)*Math.PI/180;
      s.x=Math.round((tcx+Math.cos(a)*radius-160)/SNAP)*SNAP;
      s.y=Math.round((tcy+Math.sin(a)*radius*yScale-100)/SNAP)*SNAP;
      var childAngle=Math.atan2(s.y+100-tcy, s.x+160-tcx)*180/Math.PI;
      result.push({node:s, angle:childAngle});
    });
    return result;
  }

  // Trail placement — SUBs cascade outward along the parent's angle (rocket trail)
  function trailInputs(target, spacing, outAngle, onlySubs){
    var allSrcs=inputsOf(target.id).filter(function(s){return !placed[s.id];});
    var srcs=onlySubs ? allSrcs.filter(function(s){return s.type==='sub';}) : allSrcs;
    if(!srcs.length) return [];
    var tcx=target.x+160, tcy=target.y+100;
    var a=outAngle*Math.PI/180;
    var result=[];
    srcs.forEach(function(s,i){
      placed[s.id]=true;
      var dist=spacing*(i+1);
      s.x=Math.round((tcx+Math.cos(a)*dist-160)/SNAP)*SNAP;
      s.y=Math.round((tcy+Math.sin(a)*dist-100)/SNAP)*SNAP;
      result.push({node:s, angle:outAngle});
    });
    return result;
  }

  function fanParams(t){
    if(t==='wip')  return {r:950, arc:150, y:0.4};
    if(t==='t1')   return {r:700, arc:80, y:0.5};
    if(t==='sum')  return {r:550, arc:45, y:0.5};
    if(t==='job')  return {r:550, arc:45, y:0.5};
    if(t==='t2')   return {r:520, arc:45, y:0.5};
    if(t==='sub')  return {r:460, arc:50, y:0.5};
    return {r:400, arc:35, y:0.6};
  }

  var wipNode=nodes.find(function(n){return n.type==='wip';});

  // Place gills (WIP top/bottom port connections) for a given WIP-like target
  function placeGillsForTarget(target){
    var topGills=[], botGills=[], gillSeen={};
    wires.forEach(function(w){
      if(w.toNode===target.id && (w.toPort===1 || w.toPort===2)){
        var s=E.findNode(w.fromNode);
        if(s && !gillSeen[s.id] && s.type!=='watch' && s.type!=='note' && !placed[s.id]){
          gillSeen[s.id]=true;
          (w.toPort===1 ? topGills : botGills).push(s);
        }
      }
    });
    var NW=340;
    function doPlace(arr, yPos){
      var n=arr.length;
      arr.forEach(function(g,i){
        placed[g.id]=true;
        var offset=(i-(n-1)/2)*NW;
        g.x=Math.round((target.x+offset)/SNAP)*SNAP;
        g.y=Math.round(yPos/SNAP)*SNAP;
      });
    }
    if(topGills.length) doPlace(topGills, target.y-220);
    if(botGills.length) doPlace(botGills, target.y+420);
  }

  // Weave an array of CO nodes into open spots near their wire targets
  function weaveCOsAmong(coNodes){
    if(!coNodes.length) return;
    var occupied=[];
    nodes.forEach(function(n){
      if(placed[n.id]) occupied.push({x:n.x, y:n.y, w:320, h:estNodeHeight(n)});
    });
    var GAP=40;
    function isOpen(x,y,w,h){
      for(var k=0;k<occupied.length;k++){
        var o=occupied[k];
        if(x<o.x+o.w+GAP && x+w>o.x-GAP && y<o.y+o.h+GAP && y+h>o.y-GAP) return false;
      }
      return true;
    }
    coNodes.forEach(function(c){
      var target=null;
      wires.forEach(function(w){
        if(w.fromNode===c.id){
          var t=E.findNode(w.toNode);
          if(t && placed[t.id]) target=t;
        }
      });
      if(!target) target=wipNode||nodes[0];
      var ch=estNodeHeight(c);
      var bx=target.x-360, by=target.y;
      var found=false;
      for(var ring=0;ring<25&&!found;ring++){
        var step=180;
        for(var dy=-ring;dy<=ring&&!found;dy++){
          for(var dx=-ring;dx<=ring&&!found;dx++){
            if(Math.abs(dx)!==ring&&Math.abs(dy)!==ring) continue;
            var tx=bx+dx*step, ty=by+dy*step;
            if(isOpen(tx,ty,320,ch)){
              c.x=Math.round(tx/SNAP)*SNAP;
              c.y=Math.round(ty/SNAP)*SNAP;
              placed[c.id]=true;
              occupied.push({x:c.x, y:c.y, w:320, h:ch});
              found=true;
            }
          }
        }
      }
      if(!found){
        c.x=Math.round((target.x-360)/SNAP)*SNAP;
        c.y=Math.round((target.y+200)/SNAP)*SNAP;
        placed[c.id]=true;
        occupied.push({x:c.x, y:c.y, w:320, h:ch});
      }
    });
  }

  // ── Scoped mode: arrange only the selected node's direct inputs ──
  if(selectedId){
    var target=E.findNode(selectedId);
    if(!target || target.type==='watch' || target.type==='note') return;

    // Lock everything in place first, then unlock the direct children we'll move
    nodes.forEach(function(n){ placed[n.id]=true; });

    // Outward angle: from WIP center to target center (extending away from WIP).
    // For WIP itself, use 180 (fan left). Other standalone roots default to 180.
    var outAngle=180;
    if(target.type!=='wip' && wipNode && wipNode.id!==target.id){
      var tcx=target.x+160, tcy=target.y+100;
      var wcx=wipNode.x+160, wcy=wipNode.y+220;
      outAngle=Math.atan2(tcy-wcy, tcx-wcx)*180/Math.PI;
    }

    // Collect direct children — split into fan/trail/gill/CO groups
    var fanChildren=[], coChildren=[], topGills=[], botGills=[];
    var seenCh={};
    wires.forEach(function(w){
      if(w.toNode!==target.id) return;
      var s=E.findNode(w.fromNode);
      if(!s || seenCh[s.id] || s.type==='watch' || s.type==='note') return;
      seenCh[s.id]=true;
      if(s.type==='co'){ coChildren.push(s); return; }
      if(target.type==='wip' && w.toPort===1){ topGills.push(s); return; }
      if(target.type==='wip' && w.toPort===2){ botGills.push(s); return; }
      fanChildren.push(s);
    });

    // Unmark the children we intend to place so fanInputs will accept them
    fanChildren.forEach(function(s){ placed[s.id]=false; });
    topGills.concat(botGills).forEach(function(s){ placed[s.id]=false; });
    coChildren.forEach(function(s){ placed[s.id]=false; });

    // Fan arrangement based on target type
    if(target.type==='wip'){
      var fp=fanParams('wip');
      fanInputs(target, fp.r, fp.arc, 180, fp.y);
      placeGillsForTarget(target);
    } else if(target.type==='t2'){
      var fp=fanParams('t2');
      fanInputs(target, fp.r, fp.arc, outAngle, fp.y, {sub:true});
      trailInputs(target, 380, outAngle, true);
    } else {
      var fp=fanParams(target.type);
      fanInputs(target, fp.r, fp.arc, outAngle, fp.y);
    }

    // Weave CO children into open spots
    weaveCOsAmong(coChildren);

    // Resolve overlaps — only allow the just-placed children to move
    var movedSet={};
    fanChildren.forEach(function(s){ movedSet[s.id]=true; });
    topGills.concat(botGills).forEach(function(s){ movedSet[s.id]=true; });
    coChildren.forEach(function(s){ movedSet[s.id]=true; });
    resolveOverlaps(nodes, null, movedSet);

    refanWatches();
    return;
  }

  // ── Full-tree mode ──
  if(wipNode){
    placed[wipNode.id]=true;
    wipNode.x=Math.round(cx/SNAP)*SNAP;
    wipNode.y=Math.round((cy-200)/SNAP)*SNAP;

    // BFS backwards from WIP — each child carries its outward angle
    // T2s: fan non-SUB children normally, then trail SUBs outward
    var queue=[{node:wipNode, angle:180}];
    var guard=0;
    while(queue.length && guard++ < 200){
      var item=queue.shift();
      var children;
      if(item.node.type==='t2'){
        // Fan non-SUB children (labor, mat, gc, etc.) normally; SUBs reserved for trail
        var fp=fanParams('t2');
        children=fanInputs(item.node, fp.r, fp.arc, item.angle, fp.y, {sub:true});
        // Trail SUBs outward like a rocket trail
        var trailed=trailInputs(item.node, 380, item.angle, true);
        for(var ti=0;ti<trailed.length;ti++) children.push(trailed[ti]);
      } else {
        var fp2=fanParams(item.node.type);
        children=fanInputs(item.node, fp2.r, fp2.arc, item.angle, fp2.y);
      }
      for(var ci=0;ci<children.length;ci++) queue.push(children[ci]);
    }
  }

  // Gills: nodes feeding into WIP's + Top / + Bottom ports go directly above/below WIP
  if(wipNode) placeGillsForTarget(wipNode);

  // Change Orders: weave into open spaces near their wire targets
  var cos=nodes.filter(function(n){return n.type==='co';});
  weaveCOsAmong(cos);

  // Orphans: place in bottom-left corner of the fan spread
  var orphans=nodes.filter(function(n){return !placed[n.id];});
  if(orphans.length){
    var minX=Infinity, maxY=-Infinity;
    nodes.forEach(function(n){
      if(placed[n.id]){ if(n.x<minX) minX=n.x; if(n.y>maxY) maxY=n.y; }
    });
    if(minX===Infinity){ minX=cx-600; maxY=cy; }
    var ox=minX, oy=maxY+120;
    orphans.forEach(function(n,i){
      n.x=Math.round((ox+(i%4)*340)/SNAP)*SNAP;
      n.y=Math.round((oy+Math.floor(i/4)*120)/SNAP)*SNAP;
    });
  }

  // Resolve overlaps — push colliding nodes apart. WIP stays anchored.
  resolveOverlaps(nodes, wipNode);

  refanWatches();
}

function estNodeHeight(n){
  var d=E.DEFS[n.type]; if(!d) return 100;
  if(d.master) return 280;
  if(n.collapsed){
    if(d.hasProg) return 68;
    if(n.type==='po'||n.type==='co') return 70;
    return 55;
  }
  var h=80;
  var numPorts=Math.max((d.ins?d.ins.length:0),(d.outs?d.outs.length:0));
  h+=numPorts*26;
  if(d.hasProg) h+=50;
  if(d.hasItems) h+=40+(n.items?n.items.length*30:0);
  if(n.type==='t1') h+=60;
  if(n.type==='sub') h+=80;
  return h;
}

function resolveOverlaps(ns, anchor, movedSet){
  var NW=320, MARGIN=32;
  var SNAP=E.SNAP;
  for(var iter=0; iter<200; iter++){
    var moved=false;
    for(var i=0;i<ns.length;i++){
      for(var j=i+1;j<ns.length;j++){
        var a=ns[i], b=ns[j];
        var ah=estNodeHeight(a), bh=estNodeHeight(b);
        var acx=a.x+NW/2, acy=a.y+ah/2;
        var bcx=b.x+NW/2, bcy=b.y+bh/2;
        var dx=bcx-acx, dy=bcy-acy;
        var minDx=NW+MARGIN;
        var minDy=(ah+bh)/2+MARGIN;
        var adx=Math.abs(dx), ady=Math.abs(dy);
        if(adx<minDx && ady<minDy){
          var overlapX=minDx-adx;
          var overlapY=minDy-ady;
          var aFixed, bFixed;
          if(movedSet){
            // Scoped mode: everything that wasn't just moved is anchored
            aFixed=!movedSet[a.id];
            bFixed=!movedSet[b.id];
          } else {
            aFixed=(anchor&&a.id===anchor.id);
            bFixed=(anchor&&b.id===anchor.id);
          }
          if(overlapY<=overlapX){
            var sy=dy<0?-1:(dy>0?1:1);
            if(!aFixed && !bFixed){ a.y-=sy*overlapY/2; b.y+=sy*overlapY/2; }
            else if(aFixed){ b.y+=sy*overlapY; }
            else { a.y-=sy*overlapY; }
          } else {
            var sx=dx<0?-1:(dx>0?1:1);
            if(!aFixed && !bFixed){ a.x-=sx*overlapX/2; b.x+=sx*overlapX/2; }
            else if(aFixed){ b.x+=sx*overlapX; }
            else { a.x-=sx*overlapX; }
          }
          moved=true;
        }
      }
    }
    if(!moved) break;
  }
  // Re-snap to grid
  ns.forEach(function(n){
    n.x=Math.round(n.x/SNAP)*SNAP;
    n.y=Math.round(n.y/SNAP)*SNAP;
  });
}

// Reposition all watches wired to WIP into the octopus fan around WIP's current spot.
function refanWatches(){
  var nodes=E.nodes();
  var wipNode=nodes.find(function(n){return n.type==='wip';});
  if(!wipNode) return;
  var wipDef=E.DEFS.wip; if(!wipDef||!wipDef.outs) return;
  var wipOuts=wipDef.outs;
  var portWatch={};
  E.wires().forEach(function(w){
    if(w.fromNode===wipNode.id){
      var t=E.findNode(w.toNode);
      if(t&&t.type==='watch') portWatch[w.fromPort]=t;
    }
  });
  var wipCx=wipNode.x+160, wipCy=wipNode.y+220;
  var radius=780, count=wipOuts.length, arcSpan=170, arcStart=-arcSpan/2;
  var SNAP=E.SNAP;
  wipOuts.forEach(function(op,i){
    var w=portWatch[i]; if(!w) return;
    var angleDeg=count>1?arcStart+arcSpan*i/(count-1):0;
    var a=angleDeg*Math.PI/180;
    w.x=Math.round((wipCx+Math.cos(a)*radius)/SNAP)*SNAP;
    w.y=Math.round((wipCy+Math.sin(a)*radius-70)/SNAP)*SNAP;
  });
}

// ── Public ──
function ensureWatchFan(){
  // For any WIP output port without a Watch already wired, add one in the octopus fan.
  var nodes=E.nodes();
  var wipNode=nodes.find(function(n){return n.type==='wip';});
  if(!wipNode) return false;
  var wipDef=E.DEFS.wip;
  if(!wipDef||!wipDef.outs) return false;
  var wipOuts=wipDef.outs;
  var wired={};
  E.wires().forEach(function(w){
    if(w.fromNode===wipNode.id){
      var t=E.findNode(w.toNode);
      if(t&&t.type==='watch') wired[w.fromPort]=true;
    }
  });
  var missing=[];
  wipOuts.forEach(function(_,i){ if(!wired[i]) missing.push(i); });
  if(missing.length===0) return false;
  var wipCx=wipNode.x+160, wipCy=wipNode.y+220;
  var radius=780, count=wipOuts.length, arcSpan=170, arcStart=-arcSpan/2;
  missing.forEach(function(portIdx){
    var angleDeg=count>1?arcStart+arcSpan*portIdx/(count-1):0;
    var a=angleDeg*Math.PI/180;
    var wx=wipCx+Math.cos(a)*radius;
    var wy=wipCy+Math.sin(a)*radius-70;
    var w=E.addNode('watch',wx,wy,wipOuts[portIdx].n);
    if(w) E.wires().push({fromNode:wipNode.id,fromPort:portIdx,toNode:w.id,toPort:0});
  });
  return true;
}

window.openNodeGraph=function(jid){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  // Position below the sticky header
  var header=document.querySelector('header');
  if(header) tab.style.top=header.offsetHeight+'px';
  tab.classList.add('active');
  if(!wrap) init();
  resize();
  if(jid && jid!==E.job()){
    E.job(jid);
    E.setNodes([]); E.setWires([]); E.setNid(1);
    if(!E.loadGraph()){ populate(); }
    ensureWatchFan();
    applyTx(); render();
  } else if(E.nodes().length===0){
    E.job(jid||(typeof appState!=='undefined'?appState.currentJobId:null));
    if(!E.loadGraph()){ populate(); }
    ensureWatchFan();
    applyTx(); render();
  } else {
    ensureWatchFan();
    render();
  }
};
})();
