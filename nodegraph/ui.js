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
// When set to a note's id, the next click on a node attaches the note
// to that node. Click the attach button again (or the canvas) to cancel.
var attachingFromNoteId=null;

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
      // Strip ' › Building' suffix OR all accumulated ' +N' suffixes from prior labels
      var baseName = n.label.split(' \u203A ')[0].trim().replace(/(\s+\+\d+)+$/g, '').trim();
      var t1s = [];
      wires.forEach(function(w){
        if(w.fromNode===n.id){
          var target=E.findNode(w.toNode);
          if(target&&target.type==='t1'){ t1s.push({ name:target.label.split(' \u203A ')[0].trim(), data:target.data }); }
        }
      });
      // 0 or 2+ connections → just name; 1 connection → name › bldg
      if(t1s.length===1) n.label = baseName+' \u203A '+t1s[0].name;
      else n.label = baseName;
      if(n.data && n.data.id && typeof appData !== 'undefined'){
        var phase = appData.phases.find(function(p){return p.id===n.data.id;});
        if(phase){
          // Only track a single buildingId when exactly one T1 is connected;
          // clear it when the phase spans multiple buildings via the graph.
          var newBldgId = t1s.length===1 && t1s[0].data && t1s[0].data.id ? t1s[0].data.id : '';
          if(phase.buildingId !== newBldgId){
            phase.buildingId = newBldgId;
            if(typeof saveData === 'function') saveData();
          }
        }
      }
    } else if(n.type==='sub'){
      var subBase = n.label.split(' \u203A ')[0].trim().replace(/(\s+\+\d+)+$/g, '').trim();
      var suffix = '';
      // Derive label + sync data from wire connections
      var connPhases = [], connBldgs = [];
      var connPhaseIds = [], connBldgIds = [];
      var cleanName = function(lbl){ return lbl.split(' \u203A ')[0].trim().replace(/(\s+\+\d+)+$/g, '').trim(); };
      wires.forEach(function(w){
        if(w.fromNode===n.id){
          var target=E.findNode(w.toNode);
          if(target && target.type==='t2'){
            connPhases.push(cleanName(target.label));
            if(target.data && target.data.id) connPhaseIds.push(target.data.id);
          } else if(target && target.type==='t1'){
            connBldgs.push(cleanName(target.label));
            if(target.data && target.data.id) connBldgIds.push(target.data.id);
          }
        }
      });
      if(connPhases.length===1) suffix = connPhases[0];
      else if(connBldgs.length===1) suffix = connBldgs[0];
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
    n.pctComplete = Math.round(E.getT1WeightedPct(n) * 10) / 10;
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
    div.className='ng-node ng-t-'+n.cat+' ng-tt-'+n.type+(selN===n.id?' ng-sel':'')+(connectedIds[n.id]?' ng-connected':'')+(n.collapsed?' ng-coll':'');
    div.setAttribute('data-id',n.id);
    div.style.left=n.x+'px'; div.style.top=n.y+'px';

    var canColl = n.type!=='note' && n.type!=='watch';
    var canEdit = (n.type==='t1'||n.type==='t2'||n.type==='sub'||n.type==='co'||n.type==='po'||n.type==='inv') && n.data && n.data.id;
    var h='<div class="ng-hdr"><span class="ng-hi">'+d.icon+'</span><span class="ng-hdr-name" data-rename="'+n.id+'" title="Double-click to rename">'+n.label+'</span>';
    if(canEdit) h+='<span class="ng-editbtn" data-edit="'+n.id+'" title="Edit details">\u2699</span>';
    if(n.type==='note'){
      var _att = !!n.attachedTo;
      var _attTitle = _att ? 'Detach from node' : (attachingFromNoteId===n.id ? 'Click a node to attach (click again to cancel)' : 'Attach to a node');
      h+='<span class="ng-attachbtn'+(_att?' ng-attached':'')+(attachingFromNoteId===n.id?' ng-attaching':'')+'" data-attach="'+n.id+'" title="'+_attTitle+'">\ud83d\udd17</span>';
    }
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

    // Progress bar (T1/T2/CO/Sub) — click bar or pct to edit
    if(d.hasProg){
      var _computed=false, pct;
      if(n.type==='t2'){
        var _aw=E.getPhaseAllocWires(n.id);
        var _hasWirePct=_aw.some(function(w){ return w.pctComplete!=null; });
        if(_aw.length && _hasWirePct){ pct=E.getT2WeightedPct(n); _computed=true; }
        else pct=n.pctComplete||0;
      } else if(n.type==='t1'){
        // T1 computes from connected T2/CO wire pcts
        var _t1w=[]; E.wires().forEach(function(w){ if(w.toNode===n.id){ var s=E.findNode(w.fromNode); if(s&&(s.type==='t2'||s.type==='co')) _t1w.push(w); }});
        if(_t1w.length){ pct=E.getT1WeightedPct(n); _computed=true; }
        else pct=n.pctComplete||0;
      } else if(n.type==='co'){
        var _coAw=E.getCOAllocWires(n.id);
        var _hasCoWirePct=_coAw.some(function(w){ return w.pctComplete!=null; });
        if(_coAw.length && _hasCoWirePct){ pct=E.getT2WeightedPct(n); _computed=true; }
        else pct=n.pctComplete||0;
      } else {
        pct=n.pctComplete||0;
      }
      var progColor = pct>=100?'#34d399':pct>=50?'#fbbf24':'#4f8cff';
      var progTitle = _computed?'Averaged from phase % complete':'Click to edit %';
      var progAttr = _computed?'':' data-prog-edit="'+n.id+'"';
      h+='<div class="ng-progress-wrap"'+progAttr+' title="'+progTitle+'">';
      h+='<div class="ng-progress"><div class="ng-progress-fill" style="width:'+Math.min(pct,100)+'%;background:'+progColor+'"></div></div>';
      h+='</div>';
      h+='<div class="ng-progress-label"'+progAttr+' title="'+progTitle+'"><span class="ng-pct-val">'+pct.toFixed(0)+'%</span> '+(_computed?'avg':'complete')+(n.budget?' \u00b7 Budget: '+E.fmtC(n.budget):'')+'</div>';
    }

    // Sub-items (type-specific layout)
    if(d.hasItems){
      var iType = d.itemType || '';
      var UNITS = ['each','SF','LF','gal','bag','box','ton','yd\u00B3','roll','hr'];
      // PO: base contract input / Labor + Mat + GC + Other + Sub:
      // QuickBooks total fallback. Used when the user wants to point
      // at a single QB rollup number instead of entering every line
      // by hand. getOutput already does `itemsTotal || n.value` for
      // labor/mat/gc/other; sub's getOutput falls back to n.value
      // when no wired cost inputs exist (added below).
      if(iType==='po') h+='<div class="ng-edit-val"><label style="font-size:9px;color:#6a7090;display:block;text-align:center;">Base Contract</label><input type="number" value="'+(n.value||0)+'" data-node="'+n.id+'" step="0.01" /></div>';
      else if(iType==='labor' || iType==='mat' || iType==='gc' || iType==='other' || iType==='sub' || iType==='burden') {
        var labels = {
          labor:  'QuickBooks Total (used if no weekly entries)',
          mat:    'QuickBooks Total (used if no line entries)',
          gc:     'QuickBooks Total (used if no line entries)',
          other:  'QuickBooks Total (used if no line entries)',
          burden: 'QuickBooks Total (used if no line entries)',
          sub:    'QuickBooks Total (used if no wired costs)'
        };
        // Compute linked QB lines for this node — show the sum so
        // the user can verify the manual QB Total they typed against
        // the actual lines linked via the Detailed sub-tab.
        var linkedTotal = 0, linkedCount = 0;
        try {
          var qbLines = (window.appData && window.appData.qbCostLines) || [];
          qbLines.forEach(function(l) {
            if ((l.linked_node_id || l.linkedNodeId) === n.id) {
              linkedTotal += Number(l.amount || 0);
              linkedCount++;
            }
          });
        } catch (e) {}
        h += '<div class="ng-edit-val">' +
          '<label style="font-size:9px;color:#6a7090;display:block;text-align:center;">' + labels[iType] + '</label>' +
          '<input type="number" value="'+(n.value||0)+'" data-node="'+n.id+'" step="0.01" placeholder="0.00" />';
        if (linkedCount > 0) {
          h += '<div style="font-size:9px;color:#34d399;text-align:center;margin-top:3px;">' +
            '↳ Linked QB lines: ' + E.fmtC(linkedTotal) + ' (' + linkedCount + ')' +
          '</div>';
        }
        h += '</div>';
      }
      h+='<div class="ng-subitems">';
      // Header row
      if(iType==='labor') h+='<div class="ng-si-hdr"><span class="hd hd-date">Week Of</span><span class="hd hd-sm">Hrs</span><span class="hd hd-sm">Rate</span><span class="hd hd-sm">Total</span><span class="hd hd-del"></span></div>';
      else if(iType==='mat') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Amount</span><span class="hd hd-del"></span></div>';
      else if(iType==='burden') h+='<div class="ng-si-hdr"><span class="hd hd-date">Period</span><span class="hd hd-flex">Amount</span><span class="hd hd-del"></span></div>';
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
        } else if(iType==='burden'){
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
        h+='<div style="padding:2px 10px 4px;font-size:12px;border-top:1px solid var(--ng-border2);">';
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
      h+='<div style="padding:4px 10px 6px;font-size:12px;">';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Actual <span style="color:#34d399;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(subActual)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Accrued <span style="color:#fbbf24;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(subAccrued)+'</span></div>';
      h+='</div>';
      // Scope breakdown — show each wired target with PO totals and + button
      if(!n.collapsed){
        var subTargets=[];
        E.wires().forEach(function(w){
          if(w.fromNode!==n.id) return;
          var tgt=E.findNode(w.toNode);
          if(tgt && (tgt.type==='t2'||tgt.type==='t1'||tgt.type==='co')){
            subTargets.push(tgt);
          }
        });
        if(subTargets.length){
          // Sum POs by allocTarget for each target
          var poNodes=[];
          E.wires().forEach(function(w){
            if(w.toNode!==n.id) return;
            var src=E.findNode(w.fromNode);
            if(src && src.type==='po') poNodes.push(src);
          });
          h+='<div style="padding:4px 10px 6px;border-top:1px solid var(--ng-border2);">';
          h+='<div style="font-size:8px;text-transform:uppercase;letter-spacing:0.5px;color:#8b90a5;margin-bottom:4px;">Scope Breakdown</div>';
          subTargets.forEach(function(tgt){
            var tname=(tgt.label||tgt.type).split(' › ')[0].trim();
            var tIcon=tgt.type==='t2'?'📋':tgt.type==='t1'?'🏗':'📄';
            var tDataId=tgt.data&&tgt.data.id?tgt.data.id:'';
            // Sum POs targeting this specific scope
            var poAmt=0, poBilled=0, poCount=0;
            poNodes.forEach(function(po){
              var at=po.allocTarget;
              if(at && at.type===tgt.type && at.id===tDataId){
                var poEntry=(typeof appData!=='undefined')? appData.purchaseOrders.find(function(p){return p.id===(po.data&&po.data.id);}):null;
                if(poEntry){ poAmt+=(poEntry.amount||0); poBilled+=(poEntry.billedToDate||0); poCount++; }
              }
            });
            h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:10px;color:#c4c9db;">';
            h+='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+tIcon+' '+tname+'</span>';
            if(poCount>0){
              h+='<span style="color:#6a7090;font-size:9px;font-family:\'Courier New\',monospace;margin-right:6px;">'+poCount+' PO '+E.fmtC(poAmt)+'</span>';
            }
            h+='<span class="ng-sub-add-po" data-sub-node="'+n.id+'" data-target-type="'+tgt.type+'" data-target-id="'+tDataId+'" data-target-node="'+tgt.id+'" title="Create PO for '+tname+'" style="cursor:pointer;color:#4f8cff;font-size:14px;font-weight:700;line-height:1;">+</span>';
            h+='</div>';
          });
          h+='</div>';
        }
      }
    }

    // CO: mini P&L — income vs actual/accrued costs + allocation table
    if(n.type==='co' && !n.collapsed){
      E.resetComp();
      var coIncome=E.getOutput(n,0);
      E.resetComp();
      var coActual=E.getActual(n);
      var coAccrued=E.getAccrued(n);
      var coPctComp=E.getT2WeightedPct(n);
      var coRevEarned=coIncome*(coPctComp/100);
      var coGP=coRevEarned-(coActual+coAccrued);
      var gpColor=coGP>=0?'#34d399':'#f87171';
      var coPctColor=coPctComp>=100?'#34d399':coPctComp>=50?'#fbbf24':'#4f8cff';
      h+='<div style="padding:4px 10px 6px;font-size:12px;">';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Income <span style="color:#34d399;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(coIncome)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">% Complete <span style="color:'+coPctColor+';font-weight:600;font-family:\'Courier New\',monospace;">'+coPctComp.toFixed(1)+'%</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Rev. Earned <span style="color:#4f8cff;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(coRevEarned)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Actual <span style="color:#f87171;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(coActual)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Accrued <span style="color:#fbbf24;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(coAccrued)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:3px 0 2px;border-top:1px solid var(--ng-border2);margin-top:2px;color:#6a7090;font-weight:600;">Gross Profit <span style="color:'+gpColor+';font-weight:700;font-family:\'Courier New\',monospace;">'+E.fmtC(coGP)+'</span></div>';
      // CO allocation breakdown per connected target (T1/T2/WIP)
      var coAw=E.getCOAllocWires(n.id);
      if(coAw.length){
        E.rebalanceCOAllocations(n.id);
        var coTotalPct=0;
        h+='<div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--ng-border2);">';
        h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:1px 0 3px;color:#8b90a5;font-size:8px;text-transform:uppercase;letter-spacing:0.5px;gap:4px;">';
        h+='<span style="width:14px;"></span>';
        h+='<span style="flex:1;">Target</span>';
        h+='<span style="min-width:42px;text-align:right;">Alloc</span>';
        h+='<span style="min-width:38px;text-align:right;padding-left:4px;">% Cmp</span>';
        h+='<span style="min-width:64px;text-align:right;">Share</span>';
        h+='</div>';
        coAw.forEach(function(w){
          var tgt=E.findNode(w.toNode); if(!tgt) return;
          var tname=(tgt.label||tgt.type).split(' \u203A ')[0].trim();
          var pct=w.allocPct||0; coTotalPct+=pct;
          var share=coIncome*(pct/100);
          var wpc=(w.pctComplete!=null)?w.pctComplete:0;
          var wpcColor=wpc>=100?'#34d399':wpc>=50?'#fbbf24':'#4f8cff';
          var isLocked=!w._auto;
          var lockColor=isLocked?'#fbbf24':'#3a4570';
          h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;color:#6a7090;font-size:9px;gap:4px;">';
          h+='<span class="ng-alloc-lock" data-lock-co="'+n.id+'" data-lock-wire="'+w.toNode+'" title="'+(isLocked?'Unlock':'Lock')+' this allocation" style="cursor:pointer;font-size:10px;color:'+lockColor+';width:14px;text-align:center;">'+(isLocked?'\uD83D\uDD12':'\uD83D\uDD13')+'</span>';
          h+='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+tname+'</span>';
          h+='<span class="ng-alloc-pct" data-alloc-phase="'+n.id+'" data-alloc-bldg="'+w.toNode+'" title="Click to edit allocation %" style="color:#fbbf24;cursor:pointer;font-family:\'Courier New\',monospace;min-width:42px;text-align:right;">'+pct.toFixed(1)+'%</span>';
          h+='<span class="ng-wire-pct" data-wire-pct-phase="'+n.id+'" data-wire-pct-bldg="'+w.toNode+'" title="Click to edit % complete" style="color:'+wpcColor+';cursor:pointer;font-family:\'Courier New\',monospace;min-width:38px;text-align:right;border-left:1px dotted var(--ng-border2);padding-left:4px;">'+wpc.toFixed(0)+'%</span>';
          h+='<span class="ng-alloc-share" data-share-co="'+n.id+'" data-share-wire="'+w.toNode+'" data-share-income="'+coIncome+'" title="Click to edit $ share" style="color:#34d399;cursor:pointer;font-family:\'Courier New\',monospace;min-width:64px;text-align:right;">'+E.fmtC(share)+'</span>';
          h+='</div>';
        });
        var coPctOk=Math.abs(coTotalPct-100)<0.01;
        var coWarnColor=coPctOk?'#34d399':'#f87171';
        h+='<div style="display:flex;justify-content:space-between;padding:3px 0 1px;border-top:1px solid var(--ng-border2);margin-top:2px;color:#6a7090;font-size:9px;font-weight:600;">';
        h+='<span>Total</span>';
        h+='<span style="color:'+coWarnColor+';font-family:\'Courier New\',monospace;">'+coTotalPct.toFixed(1)+'% '+(coPctOk?'\u2713':'\u26a0')+'</span>';
        h+='</div></div>';
      }
      h+='</div>';
    }

    // T1/T2: show actual + accrued (expanded only)
    if((n.type==='t1'||n.type==='t2') && !n.collapsed){
      E.resetComp();
      var tActual=E.getActual(n);
      var tAccrued=E.getAccrued(n);
      h+='<div style="padding:4px 10px 6px;font-size:12px;">';
      // T2 (Phase): editable revenue + per-building allocation breakdown
      if(n.type==='t2'){
        var phaseRev=n.revenue||0;
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Revenue <span class="ng-phase-rev" data-phase-rev="'+n.id+'" title="Click to edit" style="color:#4f8cff;font-weight:600;font-family:\'Courier New\',monospace;cursor:pointer;">'+E.fmtC(phaseRev)+'</span></div>';
        // Allocation breakdown per connected building
        var aw=E.getPhaseAllocWires(n.id);
        if(aw.length){
          E.rebalancePhaseAllocations(n.id);
          var totalPct=0;
          h+='<div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--ng-border2);">';
          h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:1px 0 3px;color:#8b90a5;font-size:8px;text-transform:uppercase;letter-spacing:0.5px;gap:4px;">';
          h+='<span style="width:14px;"></span>';
          h+='<span style="flex:1;">Building</span>';
          h+='<span style="min-width:42px;text-align:right;">Alloc</span>';
          h+='<span style="min-width:38px;text-align:right;padding-left:4px;">% Cmp</span>';
          h+='<span style="min-width:64px;text-align:right;">Share</span>';
          h+='</div>';
          aw.forEach(function(w){
            var b=E.findNode(w.toNode); if(!b) return;
            var bname=(b.label||'Building').split(' \u203A ')[0].trim();
            var pct=w.allocPct||0; totalPct+=pct;
            var share=phaseRev*(pct/100);
            var wpc=(w.pctComplete!=null)?w.pctComplete:0;
            var wpcColor=wpc>=100?'#34d399':wpc>=50?'#fbbf24':'#4f8cff';
            var isLocked=!w._auto;
            var lockColor=isLocked?'#fbbf24':'#3a4570';
            h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;color:#6a7090;font-size:9px;gap:4px;">';
            h+='<span class="ng-alloc-lock" data-lock-co="'+n.id+'" data-lock-wire="'+w.toNode+'" title="'+(isLocked?'Unlock':'Lock')+' this allocation" style="cursor:pointer;font-size:10px;color:'+lockColor+';width:14px;text-align:center;">'+(isLocked?'\uD83D\uDD12':'\uD83D\uDD13')+'</span>';
            h+='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+bname+'</span>';
            h+='<span class="ng-alloc-pct" data-alloc-phase="'+n.id+'" data-alloc-bldg="'+w.toNode+'" title="Click to edit allocation %" style="color:#fbbf24;cursor:pointer;font-family:\'Courier New\',monospace;min-width:42px;text-align:right;">'+pct.toFixed(1)+'%</span>';
            h+='<span class="ng-wire-pct" data-wire-pct-phase="'+n.id+'" data-wire-pct-bldg="'+w.toNode+'" title="Click to edit % complete" style="color:'+wpcColor+';cursor:pointer;font-family:\'Courier New\',monospace;min-width:38px;text-align:right;border-left:1px dotted var(--ng-border2);padding-left:4px;">'+wpc.toFixed(0)+'%</span>';
            h+='<span class="ng-alloc-share" data-share-co="'+n.id+'" data-share-wire="'+w.toNode+'" data-share-income="'+phaseRev+'" title="Click to edit $ share" style="color:#34d399;cursor:pointer;font-family:\'Courier New\',monospace;min-width:64px;text-align:right;">'+E.fmtC(share)+'</span>';
            h+='</div>';
          });
          var pctOk=Math.abs(totalPct-100)<0.01;
          var warnColor=pctOk?'#34d399':'#f87171';
          h+='<div style="display:flex;justify-content:space-between;padding:3px 0 1px;border-top:1px solid var(--ng-border2);margin-top:2px;color:#6a7090;font-size:9px;font-weight:600;">';
          h+='<span>Total</span>';
          h+='<span style="color:'+warnColor+';font-family:\'Courier New\',monospace;">'+totalPct.toFixed(1)+'% '+(pctOk?'\u2713':'\u26a0')+'</span>';
          h+='</div></div>';
        }
        h+='<div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--ng-border2);">';
      }
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Actual <span style="color:#34d399;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(tActual)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Accrued <span style="color:#fbbf24;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(tAccrued)+'</span></div>';
      // T1 (Building): show allocated revenue from connected phases
      if(n.type==='t1'){
        var bRev=E.getBuildingAllocatedRevenue(n);
        if(bRev>0){
          h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Rev Allocated <span style="color:#4f8cff;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(bRev)+'</span></div>';
        }
        // Connected phases + COs breakdown
        var t1Conns=[];
        E.wires().forEach(function(w){
          if(w.toNode!==n.id) return;
          var src=E.findNode(w.fromNode);
          if(!src) return;
          if(src.type==='t2'){
            var pRev=E.getPhaseRevenueToBuilding(src, n.id);
            E.resetComp();
            var pActual=E.getActual(src);
            var pAccrued=E.getAccrued(src);
            var ap=(w.allocPct!=null)?w.allocPct:100;
            t1Conns.push({type:'t2', icon:'📋', name:(src.label||'Phase').split(' › ')[0].trim(), rev:pRev, actual:pActual, accrued:pAccrued, pct:src.pctComplete||0, alloc:ap});
          } else if(src.type==='co'){
            E.resetComp();
            var coInc=E.getCOIncomeToParent(src, n.id);
            E.resetComp();
            var coAct=E.getActual(src);
            var coAcc=E.getAccrued(src);
            t1Conns.push({type:'co', icon:'📄', name:(src.label||'CO').split(' › ')[0].trim(), rev:coInc, actual:coAct, accrued:coAcc, pct:0, alloc:(w.allocPct!=null)?w.allocPct:100});
          }
        });
        if(t1Conns.length){
          h+='<div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--ng-border2);">';
          h+='<div style="display:flex;align-items:center;padding:1px 0 3px;color:#8b90a5;font-size:8px;text-transform:uppercase;letter-spacing:0.5px;gap:4px;">';
          h+='<span style="flex:1;">Connected</span>';
          h+='<span style="min-width:58px;text-align:right;">Rev</span>';
          h+='<span style="min-width:58px;text-align:right;">Cost</span>';
          h+='<span style="min-width:36px;text-align:right;">Alloc</span>';
          h+='</div>';
          var totRev=0, totCost=0;
          t1Conns.forEach(function(c){
            var cost=c.actual+c.accrued;
            totRev+=c.rev; totCost+=cost;
            var pColor=c.pct>=100?'#34d399':c.pct>=50?'#fbbf24':'#4f8cff';
            h+='<div style="display:flex;align-items:center;padding:2px 0;color:#6a7090;font-size:9px;gap:4px;">';
            h+='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+c.icon+' '+c.name+(c.pct?' <span style="color:'+pColor+';font-weight:600;">'+c.pct.toFixed(0)+'%</span>':'')+'</span>';
            h+='<span style="color:#4f8cff;font-family:\'Courier New\',monospace;min-width:58px;text-align:right;">'+E.fmtC(c.rev)+'</span>';
            h+='<span style="color:#f87171;font-family:\'Courier New\',monospace;min-width:58px;text-align:right;">'+E.fmtC(cost)+'</span>';
            h+='<span style="color:#fbbf24;font-family:\'Courier New\',monospace;min-width:36px;text-align:right;">'+c.alloc.toFixed(0)+'%</span>';
            h+='</div>';
          });
          h+='<div style="display:flex;align-items:center;padding:3px 0 1px;border-top:1px solid var(--ng-border2);margin-top:2px;color:#6a7090;font-size:9px;font-weight:600;gap:4px;">';
          h+='<span style="flex:1;">Total</span>';
          h+='<span style="color:#4f8cff;font-family:\'Courier New\',monospace;min-width:58px;text-align:right;">'+E.fmtC(totRev)+'</span>';
          h+='<span style="color:#f87171;font-family:\'Courier New\',monospace;min-width:58px;text-align:right;">'+E.fmtC(totCost)+'</span>';
          h+='<span style="min-width:36px;"></span>';
          h+='</div></div>';
        }
      }
      if(n.type==='t2') h+='</div>';
      h+='</div>';
    }

    // WIP node: editable revenue fields + metrics display
    if(n.type==='wip'){
      var jf=n.jobFields||{};
      var wipComputedPct=E.getWIPWeightedPct(n);
      h+='<div class="ng-subitems" style="max-height:none;">';
      [{k:'contractAmount',l:'Contract Amount',t:'c'},{k:'coIncome',l:'CO Income',t:'c'},{k:'estimatedCosts',l:'Est. Costs',t:'c'},{k:'coCosts',l:'CO Costs',t:'c'},{k:'revisedCostChanges',l:'Revised Changes',t:'c'},{k:'invoicedToDate',l:'Invoiced to Date',t:'c'},{k:'pctComplete',l:'% Complete',t:'p'}].forEach(function(r){
        var raw=jf[r.k]||0;
        if(r.k==='pctComplete' && wipComputedPct!=null){
          var dispC=wipComputedPct.toFixed(1)+'% avg';
          h+='<div class="ng-subitem ng-wip-row"><span class="ng-wip-lbl">'+r.l+'</span><span class="ng-wip-chip" title="Averaged from connected phases/buildings/COs" style="cursor:default;opacity:0.85;">'+dispC+'</span></div>';
        } else {
          var disp=r.t==='p'?raw.toFixed(1)+'%':E.fmtC(raw);
          h+='<div class="ng-subitem ng-wip-row"><span class="ng-wip-lbl">'+r.l+'</span><span class="ng-wip-chip" data-wip-edit="'+n.id+'" data-wip-key="'+r.k+'" data-wip-type="'+r.t+'" title="Click to edit">'+disp+'</span></div>';
        }
      });
      h+='</div>';
      // Metrics display
      var wipD=E.DEFS.wip;
      h+='<div style="padding:4px 10px 6px;border-top:1px solid var(--ng-border2);">';
      wipD.outs.forEach(function(op,oi){
        var ov=E.getOutput(n,oi);
        var cls=ov>0?' style="color:#34d399"':ov<0?' style="color:#f87171"':'';
        var fmt=op.t===E.PT.P?E.fmtP(ov):E.fmtC(ov);
        h+='<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1f30;font-size:14px;">';
        h+='<span style="color:#6a7090;">'+op.n+'</span>';
        h+='<span style="font-family:\'Courier New\',monospace;font-weight:700;font-size:15px;"'+cls+'>'+fmt+'</span>';
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
      // For T1/T2 collapsed, show actual costs
      if(n.type==='t1'||n.type==='t2'){
        E.resetComp();
        collVal = E.getActual(n);
      }
      // Port circles positioned absolutely on the node
      if(hasIns) h+='<div class="ng-coll-pi ng-p" data-node="'+n.id+'" data-pi="0" data-dir="in" data-type="'+d.ins[0].t+'"></div>';
      if(hasOuts) h+='<div class="ng-coll-po ng-p" data-node="'+n.id+'" data-pi="0" data-dir="out" data-type="'+d.outs[0].t+'"></div>';
      h+='<div class="ng-coll-row">';
      if(n.type==='t1'||n.type==='t2'){
        // Use same computed pct as expanded view
        var cpct;
        if(n.type==='t2'){
          var _caw=E.getPhaseAllocWires(n.id);
          var _chp=_caw.some(function(w){ return w.pctComplete!=null; });
          cpct=(_caw.length && _chp) ? E.getT2WeightedPct(n) : (n.pctComplete||0);
        } else {
          var _ctw=[]; E.wires().forEach(function(w){ if(w.toNode===n.id){ var s=E.findNode(w.fromNode); if(s&&(s.type==='t2'||s.type==='co')) _ctw.push(w); }});
          var _cthp=_ctw.some(function(w){ return w.pctComplete!=null; });
          cpct=(_ctw.length && _cthp) ? E.getT1WeightedPct(n) : (n.pctComplete||0);
        }
        var cpColor = cpct>=100?'#34d399':cpct>=50?'#fbbf24':'#4f8cff';
        E.resetComp(); var tAct=E.getActual(n);
        var tAcc=E.getAccrued(n);
        var tRev = (n.type==='t2') ? (n.revenue||0) : E.getBuildingAllocatedRevenue(n);
        var tRevEarned = tRev * (cpct/100);
        h+='<div class="ng-coll-t12">';
        h+='<div class="ng-coll-prog"><div class="ng-coll-prog-fill" style="width:'+Math.min(cpct,100)+'%;background:'+cpColor+'"></div></div>';
        h+='<div class="ng-coll-pctrow"><span class="ng-coll-pct">'+cpct.toFixed(0)+'%</span></div>';
        h+='<div class="ng-coll-kv"><span class="ng-coll-lbl">Actual</span><span class="ng-coll-val ng-cv-grn">'+E.fmtC(tAct)+'</span></div>';
        h+='<div class="ng-coll-kv"><span class="ng-coll-lbl">Accrued</span><span class="ng-coll-val ng-cv-yel">'+E.fmtC(tAcc)+'</span></div>';
        h+='<div class="ng-coll-kv"><span class="ng-coll-lbl">Alloc. Rev</span><span class="ng-coll-val ng-cv-blu">'+E.fmtC(tRev)+'</span></div>';
        h+='<div class="ng-coll-kv"><span class="ng-coll-lbl">Rev. Earned</span><span class="ng-coll-val ng-cv-blu">'+E.fmtC(tRevEarned)+'</span></div>';
        h+='</div>';
      } else if(n.type==='co'){
        // CO collapsed: show income, actual, accrued, GP — like a mini P&L
        var _coAw2=E.getCOAllocWires(n.id);
        var _coHp=_coAw2.some(function(w){ return w.pctComplete!=null; });
        var coPct=(_coAw2.length && _coHp) ? E.getT2WeightedPct(n) : (n.pctComplete||0);
        var coPColor = coPct>=100?'#34d399':coPct>=50?'#fbbf24':'#4f8cff';
        E.resetComp(); var coInc=E.getOutput(n,0);
        E.resetComp(); var coAct2=E.getActual(n);
        var coAcc2=E.getAccrued(n);
        var coGP2=coInc-(coAct2+coAcc2);
        var gpC2=coGP2>=0?'#34d399':'#f87171';
        h+='<div class="ng-coll-t12">';
        h+='<div class="ng-coll-prog"><div class="ng-coll-prog-fill" style="width:'+Math.min(coPct,100)+'%;background:'+coPColor+'"></div></div>';
        h+='<div class="ng-coll-pctrow"><span class="ng-coll-pct">'+coPct.toFixed(0)+'%</span></div>';
        h+='<div class="ng-coll-kv"><span class="ng-coll-lbl">Income</span><span class="ng-coll-val ng-cv-grn">'+E.fmtC(coInc)+'</span></div>';
        h+='<div class="ng-coll-kv"><span class="ng-coll-lbl">Actual</span><span class="ng-coll-val ng-cv-grn">'+E.fmtC(coAct2)+'</span></div>';
        h+='<div class="ng-coll-kv"><span class="ng-coll-lbl">Accrued</span><span class="ng-coll-val ng-cv-yel">'+E.fmtC(coAcc2)+'</span></div>';
        h+='<div class="ng-coll-kv"><span class="ng-coll-lbl">Gross Profit</span><span class="ng-coll-val" style="color:'+gpC2+'">'+E.fmtC(coGP2)+'</span></div>';
        h+='</div>';
      } else if(d.hasProg){
        var cpct2 = n.pctComplete||0;
        var cpColor2 = cpct2>=100?'#34d399':cpct2>=50?'#fbbf24':'#4f8cff';
        h+='<div class="ng-coll-prog"><div class="ng-coll-prog-fill" style="width:'+Math.min(cpct2,100)+'%;background:'+cpColor2+'"></div></div>';
        h+='<div class="ng-coll-inline">';
        if(n.budget) h+='<span class="ng-cv-bud">'+E.fmtC(n.budget)+'</span><span class="ng-coll-sep">|</span>';
        h+='<span class="ng-coll-pct">'+cpct2.toFixed(0)+'%</span><span class="ng-coll-sep">|</span>';
        h+='<span class="ng-coll-val">'+E.fmtC(collVal)+'</span>';
        h+='</div>';
      } else if(n.type==='po'){
        E.resetComp(); E.getOutput(n,0);
        var poC=n._poContract||0, poI=n._poInvoiced||0;
        h+='<div class="ng-coll-detail"><span class="ng-coll-lbl">Contract</span><span class="ng-coll-val">'+E.fmtC(poC)+'</span></div>';
        h+='<div class="ng-coll-detail"><span class="ng-coll-lbl">Invoiced</span><span class="ng-coll-val ng-cv-grn">'+E.fmtC(poI)+'</span></div>';
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
  if(wrap){
    if(attachingFromNoteId) wrap.classList.add('ng-attaching');
    else wrap.classList.remove('ng-attaching');
  }
  // Audit badge — recompute high+med findings count after every
  // graph state change (workspace-layout.js exposes this hook).
  if (typeof window._wsRefreshAuditBadge === 'function') {
    try { window._wsRefreshAuditBadge(); } catch(e) {}
  }
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
  if(type==='sub'){
    // Subs are first-class (Phase A) — pull from the global
    // directory rather than per-job inline records. The directory
    // entry is the canonical sub; any job can reference it via a
    // node without duplicating the company profile.
    var dir = (appData.subsDirectory || []).filter(function(s) {
      return (s.status || 'active') !== 'closed';
    });
    if (dir.length) {
      // Map to picker shape: id is the directory id, name is the
      // company name. Sorted alphabetically for predictable UI.
      return dir.slice().sort(function(a, b) {
        return (a.name || '').localeCompare(b.name || '');
      });
    }
    // Legacy fallback: when the directory hasn't been populated
    // yet, fall back to the inline per-job records so existing
    // jobs don't lose their picker. The migration tool on the
    // Subs sub-tab rolls these into the directory.
    return (appData.subs||[]).filter(function(s){return s.jobId===jid;});
  }
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
// Pan (and optionally zoom) so the node sits centered in the viewport.
// targetZoom is optional — when supplied, we ramp to it before computing
// the centering pan so the math uses the post-zoom scale.
function focusNode(n, opts){
  if(!wrap) return;
  opts = opts || {};
  if (typeof opts.zoom === 'number' && isFinite(opts.zoom)) {
    var nz = Math.max(0.2, Math.min(3, opts.zoom));
    E.zm(nz);
  }
  var z=E.zm();
  var cx=-(n.x+85)+wrap.clientWidth/2/z;
  var cy=-(n.y+30)+wrap.clientHeight/2/z;
  E.pan(cx,cy);
  applyTx();
  render();
  // Brief highlight pulse so the user sees which node was focused —
  // helpful when Ctrl+Clicking from a busy area of the graph.
  setTimeout(function() {
    var el = canvasEl && canvasEl.querySelector('[data-id="' + n.id + '"]');
    if (!el) return;
    el.classList.add('ng-focus-pulse');
    setTimeout(function() { el.classList.remove('ng-focus-pulse'); }, 900);
  }, 0);
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
// Map node type → app modal id + opener function (defined in js/wip.js, on window)
var CREATE_MODAL={
  co:  {modal:'addCOModal',       opener:'openAddChangeOrderModal'},
  t1:  {modal:'addBuildingModal', opener:'openAddBuildingToJobModal'},
  t2:  {modal:'addPhaseModal',    opener:'openAddPhaseToJobModal'},
  sub: {modal:'addSubModal',      opener:'openAddSubToJobModal'},
  po:  {modal:'addPOModal',       opener:'openAddPOModal'},
  inv: {modal:'addInvModal',      opener:'openAddInvoiceModal'}
};
// Open the same overview-panel modal used to create entities; on save (modal closes
// with a new entry present), invoke cb(newEntry). On cancel, cb(null).
function openEntityCreateModal(type, cb){
  // Sub gets a special path: open the GLOBAL directory modal
  // (agxSubs.openNew) so the new sub lives in appData.subsDirectory
  // (and is server-persisted) instead of being duplicated as an
  // inline appData.subs record. The directory modal is created
  // dynamically and removes itself from the DOM on close, so we
  // detect "saved" by polling for new directory entries instead
  // of watching a static modal element.
  if(type==='sub' && window.agxSubs && typeof window.agxSubs.openNew==='function'){
    var beforeIds={};
    (window.appData && appData.subsDirectory ? appData.subsDirectory : []).forEach(function(s){ beforeIds[s.id]=1; });
    window.agxSubs.openNew();
    var checkInterval = setInterval(function(){
      var stillOpen = !!document.getElementById('subDirModal');
      if(stillOpen) return;
      clearInterval(checkInterval);
      // Directory may have been refreshed by saveFromModal — find
      // the new entry by id diff.
      var dir = (window.appData && appData.subsDirectory) || [];
      var newOnes = dir.filter(function(s){ return !beforeIds[s.id]; });
      cb(newOnes[0] || null);
    }, 200);
    return;
  }
  var spec=CREATE_MODAL[type]; if(!spec) return cb(null);
  var fn=window[spec.opener];
  var modalEl=document.getElementById(spec.modal);
  if(typeof fn!=='function' || !modalEl) return cb(null);
  // Snapshot existing IDs so we can detect the new entry after save
  var before={};
  getJobEntries(type).forEach(function(e){ before[e.id]=1; });
  fn();
  // Watch for the modal to close (display: none)
  var obs=new MutationObserver(function(){
    var disp=modalEl.style.display;
    if(disp==='none' || disp===''){
      obs.disconnect();
      var newOnes=getJobEntries(type).filter(function(e){ return !before[e.id]; });
      cb(newOnes[0]||null);
    }
  });
  obs.observe(modalEl, {attributes:true, attributeFilter:['style','class']});
}

// ── Sidebar ──
function buildSidebar(){
  var sb=document.querySelector('.ng-sidebar'); if(!sb) return;
  var html='<div class="ng-sidebar-header">' +
    '<span class="ng-sidebar-header-text">Node Library</span>' +
    '<button class="ng-sidebar-toggle" id="ngSidebarToggle" title="Collapse library">◀</button>' +
    '</div>';
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

  // Restore collapsed state from previous session.
  try { if (localStorage.getItem('ngSidebarCollapsed')==='1') sb.classList.add('ng-collapsed'); } catch(e){}
  var tog=document.getElementById('ngSidebarToggle');
  function syncToggle(){
    var c=sb.classList.contains('ng-collapsed');
    if(tog){ tog.innerHTML=c?'▶':'◀'; tog.title=c?'Expand library':'Collapse library'; }
  }
  syncToggle();

  sb.addEventListener('click',function(e){
    if(e.target.closest('.ng-sidebar-toggle')){
      e.stopPropagation();
      sb.classList.toggle('ng-collapsed');
      try { localStorage.setItem('ngSidebarCollapsed', sb.classList.contains('ng-collapsed')?'1':'0'); } catch(_){}
      syncToggle();
      return;
    }
    // Click anywhere on a collapsed sidebar expands it.
    if(sb.classList.contains('ng-collapsed')){
      sb.classList.remove('ng-collapsed');
      try { localStorage.setItem('ngSidebarCollapsed','0'); } catch(_){}
      syncToggle();
      return;
    }
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
            render();
          } else {
            // "+ Create New" — open the same overview-panel modal
            openEntityCreateModal(type, function(newEntry){
              if(newEntry){
                var lbl=entryLabel(type,newEntry);
                var newNode=E.addNode(type,cx-85,cy-30,lbl,newEntry);
                if(newNode) autoWireFromData(newNode, newEntry);
                render();
              }
            });
          }
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
    // Empty-canvas click cancels any pending note-attach.
    if(attachingFromNoteId){ attachingFromNoteId=null; render(); }
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
          if(!dup){
            ws.push({fromNode:wiringFrom.nid,fromPort:wiringFrom.pi,toNode:toId,toPort:toPort});
            // If this is a phase→building wire, rebalance revenue allocations
            var tn=E.findNode(toId);
            if(fn&&fn.type==='t2'&&tn&&tn.type==='t1') E.rebalancePhaseAllocations(fn.id);
          }
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
    var ab=e.target.closest('.ng-attachbtn');
    if(ab){
      e.stopPropagation();
      var an=E.findNode(ab.getAttribute('data-attach'));
      if(an){
        if(an.attachedTo){
          // Already attached → detach
          an.attachedTo=null;
          attachingFromNoteId=null;
          render();
        } else if(attachingFromNoteId===an.id){
          // Cancel attach mode
          attachingFromNoteId=null;
          render();
        } else {
          // Enter attach mode for this note
          attachingFromNoteId=an.id;
          render();
        }
      }
      return;
    }
    // While in attach-mode, clicking any other node attaches the note.
    if(attachingFromNoteId){
      var hitNode=e.target.closest('.ng-node');
      if(hitNode){
        var targetId=hitNode.getAttribute('data-id');
        if(targetId && targetId!==attachingFromNoteId){
          var note=E.findNode(attachingFromNoteId);
          if(note){
            note.attachedTo=targetId;
            attachingFromNoteId=null;
            e.stopPropagation();
            render();
            return;
          }
        }
      }
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
    // Click phase revenue → edit
    var prc=e.target.closest('[data-phase-rev]');
    if(prc && !e.target.closest('input')){
      e.preventDefault(); e.stopPropagation();
      var prn=E.findNode(prc.getAttribute('data-phase-rev'));
      if(!prn) return;
      editingId=prn.id;
      var prInp=document.createElement('input');
      prInp.type='number'; prInp.step='0.01'; prInp.min=0;
      prInp.value=prn.revenue||0;
      prInp.className='ng-wip-chip-input';
      prc.textContent=''; prc.appendChild(prInp);
      setTimeout(function(){ prInp.focus(); prInp.select(); }, 0);
      var prDone=false;
      function prFinish(){
        if(prDone) return; prDone=true;
        prn.revenue=Math.max(0,parseFloat(prInp.value)||0);
        editingId=null; render();
      }
      prInp.addEventListener('blur',prFinish);
      prInp.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'){ev.preventDefault();prInp.blur();}
        else if(ev.key==='Escape'){ev.preventDefault();prDone=true;editingId=null;render();}
      });
      prInp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
      return;
    }
    // Click allocation % → edit (marks wire as manual, rebalances auto wires)
    var apc=e.target.closest('[data-alloc-phase]');
    if(apc && !e.target.closest('input')){
      e.preventDefault(); e.stopPropagation();
      var aphId=apc.getAttribute('data-alloc-phase');
      var abId=apc.getAttribute('data-alloc-bldg');
      var aWire=E.wires().find(function(w){ return w.fromNode===aphId && w.toNode===abId; });
      if(!aWire) return;
      editingId=aphId;
      var apInp=document.createElement('input');
      apInp.type='number'; apInp.step='0.1'; apInp.min=0; apInp.max=100;
      apInp.value=(aWire.allocPct||0).toFixed(1);
      apInp.className='ng-wip-chip-input';
      apc.textContent=''; apc.appendChild(apInp);
      setTimeout(function(){ apInp.focus(); apInp.select(); }, 0);
      var apDone=false;
      function apFinish(){
        if(apDone) return; apDone=true;
        var nv=Math.max(0,Math.min(100,parseFloat(apInp.value)||0));
        aWire.allocPct=nv;
        aWire._auto=false;
        var _apSrc=E.findNode(aphId);
        if(_apSrc && _apSrc.type==='co') E.rebalanceCOAllocations(aphId);
        else E.rebalancePhaseAllocations(aphId);
        editingId=null; render();
      }
      apInp.addEventListener('blur',apFinish);
      apInp.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'){ev.preventDefault();apInp.blur();}
        else if(ev.key==='Escape'){ev.preventDefault();apDone=true;editingId=null;render();}
      });
      apInp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
      return;
    }
    // Click lock icon → toggle locked/unlocked
    var lockEl=e.target.closest('.ng-alloc-lock');
    if(lockEl){
      e.stopPropagation();
      var lCoId=lockEl.getAttribute('data-lock-co');
      var lWireId=lockEl.getAttribute('data-lock-wire');
      var lWire=E.wires().find(function(w){ return w.fromNode===lCoId && w.toNode===lWireId; });
      if(lWire){
        lWire._auto=!lWire._auto;
        var lSrc=E.findNode(lCoId);
        if(lSrc && lSrc.type==='co') E.rebalanceCOAllocations(lCoId);
        else E.rebalancePhaseAllocations(lCoId);
        render();
      }
      return;
    }
    // Click share $ → edit dollar amount, recalc % from it
    var shareEl=e.target.closest('.ng-alloc-share');
    if(shareEl && !e.target.closest('input')){
      e.preventDefault(); e.stopPropagation();
      var shCoId=shareEl.getAttribute('data-share-co');
      var shWireId=shareEl.getAttribute('data-share-wire');
      var shIncome=parseFloat(shareEl.getAttribute('data-share-income'))||0;
      var shWire=E.wires().find(function(w){ return w.fromNode===shCoId && w.toNode===shWireId; });
      if(!shWire || shIncome<=0) return;
      editingId=shCoId;
      var shInp=document.createElement('input');
      shInp.type='number'; shInp.step='0.01'; shInp.min=0;
      shInp.value=((shWire.allocPct||0)/100*shIncome).toFixed(2);
      shInp.className='ng-wip-chip-input';
      shareEl.textContent=''; shareEl.appendChild(shInp);
      setTimeout(function(){ shInp.focus(); shInp.select(); }, 0);
      var shDone=false;
      function shFinish(){
        if(shDone) return; shDone=true;
        var dollarVal=Math.max(0,parseFloat(shInp.value)||0);
        shWire.allocPct=Math.min(100,(dollarVal/shIncome)*100);
        shWire._auto=false;
        var shSrc=E.findNode(shCoId);
        if(shSrc && shSrc.type==='co') E.rebalanceCOAllocations(shCoId);
        else E.rebalancePhaseAllocations(shCoId);
        editingId=null; render();
      }
      shInp.addEventListener('blur',shFinish);
      shInp.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'){ev.preventDefault();shInp.blur();}
        else if(ev.key==='Escape'){ev.preventDefault();shDone=true;editingId=null;render();}
      });
      shInp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
      return;
    }
    // Click per-wire % complete → edit
    var wpc=e.target.closest('[data-wire-pct-phase]');
    if(wpc && !e.target.closest('input')){
      e.preventDefault(); e.stopPropagation();
      var wpPhId=wpc.getAttribute('data-wire-pct-phase');
      var wpBId=wpc.getAttribute('data-wire-pct-bldg');
      var wpWire=E.wires().find(function(w){ return w.fromNode===wpPhId && w.toNode===wpBId; });
      if(!wpWire) return;
      editingId=wpPhId;
      var wpInp=document.createElement('input');
      wpInp.type='number'; wpInp.step='1'; wpInp.min=0; wpInp.max=100;
      wpInp.value=Math.round(wpWire.pctComplete||0);
      wpInp.className='ng-wip-chip-input';
      wpc.textContent=''; wpc.appendChild(wpInp);
      setTimeout(function(){ wpInp.focus(); wpInp.select(); }, 0);
      var wpDone=false;
      function wpFinish(){
        if(wpDone) return; wpDone=true;
        wpWire.pctComplete=Math.max(0,Math.min(100,parseFloat(wpInp.value)||0));
        editingId=null; render();
      }
      wpInp.addEventListener('blur',wpFinish);
      wpInp.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'){ev.preventDefault();wpInp.blur();}
        else if(ev.key==='Escape'){ev.preventDefault();wpDone=true;editingId=null;render();}
      });
      wpInp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
      return;
    }
    // Create PO scoped to a sub's target phase/CO/T1
    var subAddPO=e.target.closest('.ng-sub-add-po');
    if(subAddPO){
      e.stopPropagation();
      var subNodeId=subAddPO.getAttribute('data-sub-node');
      var tgtType=subAddPO.getAttribute('data-target-type');
      var tgtId=subAddPO.getAttribute('data-target-id');
      var subNode=E.findNode(subNodeId);
      if(!subNode) return;
      // Resolve the sub's directory name so we can pre-fill the PO
      // modal's vendor input — this is the user's "pull the sub from
      // the sub list" expectation. subNode.data is the directory entry
      // (Phase A wires sub nodes through appData.subsDirectory).
      var subName = (subNode.data && subNode.data.name) ||
                    subNode.label ||
                    '';
      openEntityCreateModal('po', function(newEntry){
        if(!newEntry) return;
        // Store allocTarget on the PO appData entry
        newEntry.allocTarget={type:tgtType, id:tgtId};
        newEntry.subId=subNode.data&&subNode.data.id?subNode.data.id:'';
        // Make sure the PO record carries the sub's name as the vendor
        // when the user accepted our pre-fill (or typed nothing else).
        if(!newEntry.vendor && subName) newEntry.vendor = subName;
        if(typeof saveData==='function') saveData();
        // Create PO node wired to this sub
        var p2=E.pan(),z2=E.zm();
        var pcx=subNode.x-300, pcy=subNode.y+80;
        var lbl=entryLabel('po',newEntry);
        var poNode=E.addNode('po',pcx,pcy,lbl,newEntry);
        if(poNode){
          poNode.allocTarget={type:tgtType, id:tgtId};
          E.wires().push({fromNode:poNode.id,fromPort:0,toNode:subNode.id,toPort:0});
          E.saveGraph();
        }
        render();
      });
      // Pre-fill the vendor input AFTER openAddPOModal has cleared it
      // (synchronous .value = '' inside the opener). Microtask is
      // enough — the modal element is already in the DOM by then.
      if (subName) {
        setTimeout(function() {
          var vEl = document.getElementById('poVendor');
          if (vEl && !vEl.value) vEl.value = subName;
          // If the description is empty, suggest the target's name as
          // a starting hint — most POs are "scope on phase X".
          var dEl = document.getElementById('poDescription');
          if (dEl && !dEl.value) {
            var tgtNode = E.findNode(subAddPO.getAttribute('data-target-node'));
            if (tgtNode) dEl.value = subName + ' — ' + (tgtNode.label || tgtNode.type);
          }
        }, 0);
      }
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
        else if(iT==='burden'){newItem.amount=0;}
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
      // Ctrl+Click (or Cmd+Click on Mac) → focus + zoom on this node.
      // Doubles as a quick "find" for any node anywhere on the graph
      // — works on any node type, no need to hunt for it after wiring
      // / dragging beyond the viewport.
      if (e.ctrlKey || e.metaKey) {
        e.stopPropagation();
        e.preventDefault();
        var nidF = nel.getAttribute('data-id');
        var nF = E.findNode(nidF);
        if (!nF) return;
        // Select the focused node so the highlight stays visible.
        if (selN && selN !== nidF) {
          var oldF = canvasEl.querySelector('[data-id="' + selN + '"]');
          if (oldF) oldF.classList.remove('ng-sel');
        }
        selN = nidF;
        nel.classList.add('ng-sel');
        updateConnectedHighlight();
        // Zoom target: 1.4 if currently zoomed out, otherwise nudge
        // to 1.6 so a second Ctrl+Click on the same node zooms in
        // a bit more before plateauing. Keeps repeat-clicking useful.
        var curZ = E.zm();
        var targetZ = curZ < 1.2 ? 1.4 : Math.min(2.0, curZ + 0.2);
        focusNode(nF, { zoom: targetZ });
        return;
      }
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
    if(ci>=0){
      var removed=ws[ci];
      ws.splice(ci,1);
      // If a phase→building wire was removed, rebalance remaining allocations
      var rfn=E.findNode(removed.fromNode), rtn=E.findNode(removed.toNode);
      if(rfn&&rfn.type==='t2'&&rtn&&rtn.type==='t1') E.rebalancePhaseAllocations(rfn.id);
      render();
    }
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

  // Sync WIP node's jobFields from current appData before computing outputs,
  // so the engine always uses the latest values the user entered on the WIP tab.
  var wipNode0=nodes.find(function(n){return n.type==='wip';});
  if(wipNode0){
    var coArr0=appData.changeOrders.filter(function(c){return c.jobId===jid;});
    var coInc0=coArr0.reduce(function(s,c){return s+(c.income||0);},0);
    var coCst0=coArr0.reduce(function(s,c){return s+(c.estimatedCosts||0);},0);
    if(!wipNode0.jobFields) wipNode0.jobFields={};
    wipNode0.jobFields.contractAmount=job.contractAmount||0;
    wipNode0.jobFields.coIncome=coInc0;
    wipNode0.jobFields.estimatedCosts=job.estimatedCosts||0;
    wipNode0.jobFields.coCosts=coCst0;
    wipNode0.jobFields.revisedCostChanges=job.revisedCostChanges||0;
    wipNode0.jobFields.invoicedToDate=job.invoicedToDate||0;
    wipNode0.jobFields.pctComplete=job.pctComplete||0;
  }

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
        // Direct Burden rolls into the labor bucket — payroll burden
        // (taxes/insurance/benefits) is a labor cost in standard WIP
        // reporting and the AGX QB accounts treat it that way.
        if(src.type==='labor' || src.type==='burden') lab+=val;
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
    phase.asSoldRevenue=n.revenue||0;
    // Sum costs from wired cost nodes
    var mat=0,lab=0,equip=0;
    wires.forEach(function(w){
      if(w.toNode!==n.id) return;
      var src=E.findNode(w.fromNode);
      if(!src) return;
      var val=E.getOutput(src,w.fromPort);
      if(src.type==='labor' || src.type==='burden') lab+=val;
      else if(src.type==='mat') mat+=val;
      else if(src.type==='other') equip+=val;
    });
    phase.materials=mat;
    phase.labor=lab;
    phase.equipment=equip;
  });

  // Sub nodes → subs: aggregate across all node instances of the same sub
  // contractAmt = sum of PO contract values; billedToDate = sum of invoiced amounts
  var subTotals = {};
  nodes.forEach(function(n){
    if(n.type!=='sub' || !n.data || !n.data.id) return;
    var key = n.data.id;
    if(!subTotals[key]) subTotals[key] = { contract: 0, billed: 0, accrued: 0, name: n.label.split(' \u203A ')[0].trim() };
    E.resetComp();
    wires.forEach(function(w){
      if(w.toNode !== n.id) return;
      var src = E.findNode(w.fromNode);
      if(!src) return;
      if(src.type === 'po'){
        E.resetComp();
        E.getOutput(src, 0);
        subTotals[key].contract += src._poContract || 0;
        subTotals[key].billed += src._poInvoiced || 0;
      }
    });
    E.resetComp();
    subTotals[key].accrued += E.getAccrued(n);
  });
  Object.keys(subTotals).forEach(function(subId){
    var sub = appData.subs.find(function(s){ return s.id === subId; });
    if(!sub) return;
    sub.name = subTotals[subId].name;
    sub.contractAmt = subTotals[subId].contract;
    sub.billedToDate = subTotals[subId].billed;
    sub.accruedAmt = subTotals[subId].accrued;
  });

  // Job-level costs: sum all cost nodes NOT wired to any T1/T2
  // Job-level cost nodes — only overwrite appData if at least one
  // job-level cost node exists in the graph. Otherwise preserve
  // manually-entered values from the WIP tab.
  var jobMat=0,jobLab=0,jobEquip=0,jobGC=0;
  var hasJobCostNodes=false;
  nodes.forEach(function(n){
    if(n.type!=='labor'&&n.type!=='mat'&&n.type!=='gc'&&n.type!=='other'&&n.type!=='burden') return;
    // Check if this cost node is wired to a T1 or T2
    var wiredToTier=wires.some(function(w){
      if(w.fromNode!==n.id) return false;
      var target=E.findNode(w.toNode);
      return target&&(target.type==='t1'||target.type==='t2');
    });
    if(wiredToTier) return; // already counted at building/phase level
    hasJobCostNodes=true;
    var val=E.getOutput(n,0);
    if(n.type==='labor' || n.type==='burden') jobLab+=val;
    else if(n.type==='mat') jobMat+=val;
    else if(n.type==='gc') jobGC+=val;
    else if(n.type==='other') jobEquip+=val;
  });
  if(hasJobCostNodes){
    job.materials=jobMat;
    job.labor=jobLab;
    job.equipment=jobEquip;
    job.generalConditions=jobGC;
  }

  // CO nodes → sync income back to appData.changeOrders, and backflow wired CO revenue
  // into the target node's budget field (job.contractAmount / building.budget / phase.phaseBudget).
  // Uses per-target `coRevFromNG` tracking to keep the operation idempotent across repeated saves.
  var coTargets = {}; // targetNodeId -> sum of wired CO income (split across targets)
  nodes.forEach(function(co){
    if(co.type!=='co') return;
    var income = E.getOutput(co, 0);
    // Sync CO income + actual/accrued costs back to its appData entry
    if(co.data && co.data.id){
      var entry = appData.changeOrders.find(function(c){return c.id===co.data.id;});
      if(entry){
        entry.income = income;
        E.resetComp();
        entry.actualCost = E.getActual(co);
        entry.accruedCost = E.getAccrued(co);
      }
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

  // Persist WIP node's computed values onto the job so the sticky
  // header / metrics strip can display them directly instead of
  // re-deriving with rounded inputs (which produced ~$98 gaps
  // between the strip and the watch nodes).
  var wipNode=nodes.find(function(n){return n.type==='wip';});
  if(wipNode){
    E.resetComp();
    job.ngTotalIncome=E.getOutput(wipNode,0);
    E.resetComp();
    job.ngActualCosts=E.getOutput(wipNode,1);
    E.resetComp();
    job.ngRevenueEarned=E.getOutput(wipNode,2);
    E.resetComp();
    job.ngAccruedCosts=E.getOutput(wipNode,6);
    // Derived JTD numbers — pushed so getJobWIP can use them
    // directly and the strip lands on the same dollar figures the
    // watch nodes display.
    job.ngJtdProfit=(job.ngRevenueEarned||0)-(job.ngActualCosts||0);
    job.ngJtdMargin=(job.ngRevenueEarned>0)?(job.ngJtdProfit/job.ngRevenueEarned*100):0;
    job.ngBacklog=(job.ngTotalIncome||0)-(job.ngRevenueEarned||0);
    // Sync computed % complete (budget-weighted from phases/buildings)
    // back to the job unless user is overriding manually. Keep FULL
    // precision in storage — display rounds to 1 decimal where shown.
    if(!job.pctCompleteManual){
      var wipPct=E.getWIPWeightedPct(wipNode);
      if(wipPct!=null){
        job.pctComplete=wipPct;
      }
    }
  }

  if(typeof recalcSubCosts==='function') recalcSubCosts(jid);
  if(typeof saveData==='function') saveData();
  if(typeof refreshHeaderMetrics==='function') refreshHeaderMetrics();
}

/** Silent sync — called on every render, no UI refresh */
function pushToJobSilent(){
  try { pushToJob(); } catch(e){}
}

// Expose so wip.js can trigger a recompute when showing overview/metrics
// without the user needing to open the node graph tab first.
window.ngPushToJob = pushToJobSilent;

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
// Sync: add missing nodes from appData without moving existing ones.
// Scans buildings, phases, subs, COs, POs, invoices, job-level costs.
function syncFromData(){
  if(typeof appData==='undefined') return;
  var jid=E.job();
  if(!jid&&typeof appState!=='undefined') jid=appState.currentJobId;
  if(!jid) return;
  var job=appData.jobs.find(function(j){return j.id===jid;});
  if(!job) return;
  var nodes=E.nodes(), wires=E.wires();

  // Index existing node data IDs by type
  function existingIds(type){
    var ids={};
    nodes.forEach(function(n){ if(n.type===type&&n.data&&n.data.id) ids[n.data.id]=n; });
    return ids;
  }
  var t1Map=existingIds('t1'), t2Map=existingIds('t2'), subMap=existingIds('sub');
  var coMap=existingIds('co'), poMap=existingIds('po'), invMap=existingIds('inv');

  var wipNode=nodes.find(function(n){return n.type==='wip';});
  // If no WIP node, populate from scratch
  if(!wipNode){ populate(); return; }

  // Placement: find bottom-right edge of existing nodes
  var maxX=-Infinity, maxY=-Infinity;
  nodes.forEach(function(n){ if(n.x>maxX) maxX=n.x; if(n.y>maxY) maxY=n.y; });
  var newX=maxX+400, newY=100;
  var addCount=0;
  function nextPos(){ var pos={x:newX, y:newY+addCount*140}; addCount++; return pos; }

  // Buildings
  appData.buildings.filter(function(b){return b.jobId===jid;}).forEach(function(b){
    if(t1Map[b.id]) return;
    var pos=nextPos();
    var n=E.addNode('t1',pos.x,pos.y,b.name||'Building',b);
    if(n){ n.budget=b.budget||0; n.pctComplete=b.pctComplete||0; wires.push({fromNode:n.id,fromPort:0,toNode:wipNode.id,toPort:0}); t1Map[b.id]=n; }
  });

  // Phases
  appData.phases.filter(function(p){return p.jobId===jid;}).forEach(function(ph){
    if(t2Map[ph.id]) return;
    var bl=appData.buildings.find(function(b){return b.id===ph.buildingId;});
    var pos=nextPos();
    var n=E.addNode('t2',pos.x,pos.y,ph.phase+(bl?' › '+bl.name:''),ph);
    if(n){
      n.budget=ph.phaseBudget||0; n.pctComplete=ph.pctComplete||0; n.revenue=ph.asSoldRevenue||0;
      if(bl&&t1Map[bl.id]) wires.push({fromNode:n.id,fromPort:0,toNode:t1Map[bl.id].id,toPort:0});
      t2Map[ph.id]=n;
    }
  });

  // Subs
  appData.subs.filter(function(s){return s.jobId===jid;}).forEach(function(s){
    if(subMap[s.id]) return;
    var pos=nextPos();
    var sn=E.addNode('sub',pos.x,pos.y,s.name||'Sub',s);
    if(sn){
      sn.pctComplete=s.pctComplete||0;
      var bids=s.buildingIds||(s.buildingId?[s.buildingId]:[]);
      if(bids.length>0){
        var t1=null;
        bids.forEach(function(bid){ if(t1Map[bid]) t1=t1Map[bid]; });
        if(t1) wires.push({fromNode:sn.id,fromPort:0,toNode:t1.id,toPort:0});
      } else {
        wires.push({fromNode:sn.id,fromPort:0,toNode:wipNode.id,toPort:0});
      }
      subMap[s.id]=sn;
    }
  });

  // Change Orders
  appData.changeOrders.filter(function(c){return c.jobId===jid;}).forEach(function(c){
    if(coMap[c.id]) return;
    var pos=nextPos();
    E.addNode('co',pos.x,pos.y,(c.coNumber||'CO')+' '+(c.description||''),c);
  });

  // Purchase Orders
  (appData.purchaseOrders||[]).filter(function(p){return p.jobId===jid;}).forEach(function(p){
    if(poMap[p.id]) return;
    var pos=nextPos();
    var pn=E.addNode('po',pos.x,pos.y,p.vendor||'PO',p);
    if(pn){
      pn.value=p.amount||0;
      if(p.subId&&subMap[p.subId]) wires.push({fromNode:pn.id,fromPort:0,toNode:subMap[p.subId].id,toPort:0});
    }
  });

  // Invoices
  (appData.invoices||[]).filter(function(i){return i.jobId===jid;}).forEach(function(i){
    if(invMap[i.id]) return;
    var pos=nextPos();
    var inv=E.addNode('inv',pos.x,pos.y,i.invNumber||'Invoice',i);
    if(inv&&i.poId&&poMap[i.poId]) wires.push({fromNode:inv.id,fromPort:0,toNode:poMap[i.poId].id,toPort:0});
  });

  // Sync WIP jobFields
  var coArr=appData.changeOrders.filter(function(c){return c.jobId===jid;});
  wipNode.jobFields=wipNode.jobFields||{};
  wipNode.jobFields.contractAmount=job.contractAmount||0;
  wipNode.jobFields.coIncome=coArr.reduce(function(s,c){return s+(c.income||0);},0);
  wipNode.jobFields.estimatedCosts=job.estimatedCosts||0;
  wipNode.jobFields.coCosts=coArr.reduce(function(s,c){return s+(c.estimatedCosts||0);},0);
  wipNode.jobFields.revisedCostChanges=job.revisedCostChanges||0;
  wipNode.jobFields.invoicedToDate=job.invoicedToDate||0;
  wipNode.jobFields.pctComplete=job.pctComplete||0;

  ensureWatchFan();
  E.saveGraph();
}

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

    // Job-level cost nodes — create Labor/Material/GC/Equipment nodes
    // for any job-level costs that exist, wired directly to WIP.
    var jcx=sx+460, jcy=sy+subs.length*110+cos.length*110+80;
    var jcIdx=0;
    if(job.labor||job.hoursTotal){
      var ln=E.addNode('labor',jcx,jcy+jcIdx*120,'Job Labor');
      if(ln){ ln.value=job.labor||0; E.wires().push({fromNode:ln.id,fromPort:0,toNode:wipNode.id,toPort:0}); }
      jcIdx++;
    }
    if(job.materials){
      var mn=E.addNode('mat',jcx,jcy+jcIdx*120,'Job Materials');
      if(mn){ mn.value=job.materials; E.wires().push({fromNode:mn.id,fromPort:0,toNode:wipNode.id,toPort:0}); }
      jcIdx++;
    }
    if(job.equipment){
      var en=E.addNode('other',jcx,jcy+jcIdx*120,'Job Equipment');
      if(en){ en.value=job.equipment; E.wires().push({fromNode:en.id,fromPort:0,toNode:wipNode.id,toPort:0}); }
      jcIdx++;
    }
    if(job.generalConditions){
      var gn=E.addNode('gc',jcx,jcy+jcIdx*120,'Job General Conditions');
      if(gn){ gn.value=job.generalConditions; E.wires().push({fromNode:gn.id,fromPort:0,toNode:wipNode.id,toPort:0}); }
      jcIdx++;
    }
    // Job-level sub costs — create a Sub node + PO for each job-level sub
    var jobSubs=appData.subs.filter(function(s){return s.jobId===jid && s.level==='job';});
    jobSubs.forEach(function(s,i){
      var existingSub=E.nodes().find(function(nd){return nd.type==='sub'&&nd.data&&nd.data.id===s.id;});
      if(existingSub) return; // already added in the subs section above
      var sn=E.addNode('sub',jcx,jcy+jcIdx*120,s.name||'Sub',s);
      if(sn){
        E.wires().push({fromNode:sn.id,fromPort:0,toNode:wipNode.id,toPort:0});
        // Create a PO node for this sub with the contract amount
        if(s.contractAmt){
          var pn=E.addNode('po',jcx-280,jcy+jcIdx*120,(s.name||'Sub')+' PO',{id:'po_auto_'+s.id,jobId:jid,vendor:s.name||'',amount:s.contractAmt||0,billedToDate:s.billedToDate||0});
          if(pn){ pn.value=s.contractAmt||0; E.wires().push({fromNode:pn.id,fromPort:0,toNode:sn.id,toPort:0}); }
        }
      }
      jcIdx++;
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

  // Sync from data — add missing nodes without moving existing ones
  var syncBtn=tab.querySelector('.ng-sync-btn');
  if(syncBtn) syncBtn.addEventListener('click',function(){ syncFromData(); render(); });

  // Reset graph — wipe and rebuild
  var resetBtn=tab.querySelector('.ng-reset-btn');
  if(resetBtn) resetBtn.addEventListener('click',function(){
    if(!confirm('Reset graph? This will delete all node positions and rebuild from job data.')) return;
    E.setNodes([]); E.setWires([]); E.setNid(1);
    populate(); ensureWatchFan(); render();
  });

  // Auto arrange
  var aab=tab.querySelector('.ng-arrange-btn');
  if(aab) aab.addEventListener('click',function(){ autoArrange(selN); render(); });

  // Save Layout — checkpoint the current node graph to a separate
  // localStorage slot (independent of auto-save) so the user can
  // recover from accidental edits or auto-save wipes after a
  // GRAPH_VER bump.
  var snapSaveBtn=tab.querySelector('.ng-snapshot-save-btn');
  if(snapSaveBtn) snapSaveBtn.addEventListener('click',function(){
    var existing = E.getSnapshot ? E.getSnapshot() : null;
    if(existing && existing.savedAt){
      if(!confirm('Replace the previously saved layout (from ' + new Date(existing.savedAt).toLocaleString() + ')?')) return;
    }
    var savedAt = E.saveSnapshot();
    if(savedAt){
      flashSaveIndicator('saved', 'Layout saved');
      snapSaveBtn.title = 'Last saved: ' + new Date(savedAt).toLocaleString();
    } else {
      flashSaveIndicator('error', 'Save failed');
    }
  });

  // Restore Layout — replace the live graph with the last saved
  // snapshot. Confirms because it's destructive to anything edited
  // since the snapshot was taken.
  var snapRestoreBtn=tab.querySelector('.ng-snapshot-restore-btn');
  if(snapRestoreBtn) snapRestoreBtn.addEventListener('click',function(){
    var snap = E.getSnapshot ? E.getSnapshot() : null;
    if(!snap){
      alert('No saved layout to restore. Click Save Layout first.');
      return;
    }
    var when = snap.savedAt ? new Date(snap.savedAt).toLocaleString() : 'unknown time';
    if(!confirm('Restore layout saved at ' + when + '? Anything you\'ve edited since will be replaced.')) return;
    if(E.restoreSnapshot()){
      applyTx();
      render();
      flashSaveIndicator('saved', 'Layout restored');
    } else {
      flashSaveIndicator('error', 'Restore failed');
    }
  });

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
  if(!selectedId) return; // Only arrange nodes connected to the selected node
  var allNodes=E.nodes(), wires=E.wires();
  if(!allNodes.length) return;

  var nodes=allNodes.filter(function(n){return n.type!=='watch'&&n.type!=='note';});
  if(!nodes.length) return;

  var p=E.pan(),z=E.zm();
  var cx=-p.x+(wrap?wrap.clientWidth/2/z:500);
  var cy=-p.y+(wrap?wrap.clientHeight/2/z:300);
  var SNAP=E.SNAP;
  var placed={};

  // Measure how deep a sub-tree is below a given node (for middle-out ordering).
  function chainDepth(nodeId, visited){
    if(!visited) visited={};
    if(visited[nodeId]) return 0;
    visited[nodeId]=true;
    var maxD=0;
    wires.forEach(function(w){
      if(w.toNode===nodeId){
        var s=E.findNode(w.fromNode);
        if(s && s.type!=='watch' && s.type!=='note'){
          var d=1+chainDepth(s.id, visited);
          if(d>maxD) maxD=d;
        }
      }
    });
    return maxD;
  }

  // Reorder an array so the first item is in the center, then alternate L/R.
  function middleOut(arr){
    if(arr.length<=2) return arr;
    var result=new Array(arr.length);
    var mid=Math.floor(arr.length/2);
    var li=mid-1, ri=mid+1;
    result[mid]=arr[0];
    for(var k=1;k<arr.length;k++){
      if(k%2===1 && ri<arr.length) result[ri++]=arr[k];
      else if(li>=0) result[li--]=arr[k];
      else result[ri++]=arr[k];
    }
    return result;
  }

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
    var typeRank={t1:1, t2:2, sub:3, po:4, inv:5, labor:6, burden:6.5, mat:7, gc:8, other:9, sum:10, sub2:10, mul:10, pct:10, job:11};
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
    // Sort by chain depth (deepest first), then reorder middle-out
    srcs.sort(function(a,b){ return chainDepth(b.id) - chainDepth(a.id); });
    srcs = middleOut(srcs);
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
    if(t==='wip')  return {r:950, arc:120, y:0.55};
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
    return;
  }

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
  if(n.type==='t1') h+=50;
  if(n.type==='sub') h+=80;
  if(n.type==='co') h+=90;
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
  var radius=1100, count=wipOuts.length, arcSpan=210, arcStart=-arcSpan/2;
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
  var radius=1100, count=wipOuts.length, arcSpan=210, arcStart=-arcSpan/2;
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

// Exposed so the floating workspace panel's Focus button can request a
// re-render after it pans / zooms via NG.pan() / NG.zm().
window.ngApplyTx = applyTx;
window.ngRender = render;

// Save indicator state machine. Engine's saveGraph() calls
// window.ngMarkSaved() on every persist; we flash "Saved" briefly
// then return to idle. Snapshot save / restore reuse the same flash.
var _saveIndTimer = null;
function flashSaveIndicator(state, label){
  var ind = document.getElementById('ngSaveIndicator');
  if(!ind) return;
  ind.classList.remove('ng-save-saving','ng-save-saved','ng-save-error');
  var dot = '○', text = label || 'Saved';
  if(state === 'saving'){ ind.classList.add('ng-save-saving'); dot = '●'; text = label || 'Saving…'; }
  else if(state === 'saved'){ ind.classList.add('ng-save-saved'); dot = '✓'; text = label || 'Saved'; }
  else if(state === 'error'){ ind.classList.add('ng-save-error'); dot = '!'; text = label || 'Save failed'; }
  var dotEl = ind.querySelector('.ng-save-dot'), labelEl = ind.querySelector('.ng-save-label');
  if(dotEl) dotEl.innerHTML = dot;
  if(labelEl) labelEl.textContent = text;
  if(_saveIndTimer) clearTimeout(_saveIndTimer);
  if(state !== 'error'){
    _saveIndTimer = setTimeout(function(){
      ind.classList.remove('ng-save-saving','ng-save-saved');
      if(dotEl) dotEl.innerHTML = '○';
      if(labelEl) labelEl.textContent = 'Saved';
    }, 1500);
  }
}
window.ngMarkSaved = function(state){ flashSaveIndicator(state || 'saved'); };

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
