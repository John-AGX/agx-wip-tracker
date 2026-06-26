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
var _spFocus=null; // site-plan drill-in: focused building id (view-state, not saved)
// Phase 2-A satellite basemap state (view-state / localStorage only — no graph write):
var basemapEl=null, _basemap=null, _basemapReady=false, _spOrigin=null, _spOriginGraph=null, _spOriginJob=null, _satHintEl=null, _geocoding=false;
var _geoPick=false, _geoPickOverlay=null, _geoPickId=null; // Slice 3: map-picker state (captured building id)
// Phase 1 — building polygons: trace state + the geo-anchored SVG layer
var _tracing=false, _traceId=null, _tracePts=[], _traceOverlay=null, _traceClickTimer=null, _polyLayer=null;
var _SVGNS='http://www.w3.org/2000/svg';
var _spMassing=(function(){ try{ return localStorage.getItem('ngSitePlanMassing')!=='0'; }catch(_){ return true; } })(); // 2.5D building massing — on by default
// Slice 4: photo-GPS pins
var _photoPinsEl=null, _geoPhotos=[], _geoPhotosJob=null, _geoPhotosNoGps=0;
var _spPhotos=(function(){ try{ return localStorage.getItem('ngSitePlanPhotos')==='1'; }catch(_){ return false; } })();
var _spSatellite=(function(){ try{ return localStorage.getItem('ngSitePlanSatellite')==='1'; }catch(_){ return false; } })();
// NG8: frames (group boxes) interaction state
var selFrame=null, dragFrame=null, frameDragOff=null, frameMembers=null, resizeFrame=null, resizeStart=null;
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
  // Sync aggregated sub→phase/building connections back to data.
  // Phase A introduced appData.subsDirectory (global) alongside the
  // legacy appData.subs (per-job inline). A sub node may reference
  // either — when wired into the graph it's the same data record
  // logically, but it physically lives in only ONE of the two
  // arrays. Look in both so directory subs get their connection
  // metadata synced too (was a Phase-A regression).
  if(typeof appData !== 'undefined'){
    var anyDirty = false;
    var findSubAny = function(id) {
      var fromInline = appData.subs && appData.subs.find(function(s){return s.id===id;});
      if (fromInline) return fromInline;
      return appData.subsDirectory && appData.subsDirectory.find(function(s){return s.id===id;});
    };
    Object.keys(subAgg).forEach(function(subId){
      var sub = findSubAny(subId);
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
  // Re-honor a persisted satellite state once the tab is actually visible.
  // NOTE: #nodeGraphTab is position:fixed, so offsetParent is ALWAYS null —
  // use offsetWidth (0 when display:none, >0 once shown) to detect visibility.
  var _t=document.getElementById('nodeGraphTab');
  if(_t && _t.offsetWidth>0 && _spSatellite) updateBasemapVisibility();
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
  var sitePlan = E.viewMode && E.viewMode()==='siteplan';
  nodes.forEach(function(n){
    var d=E.DEFS[n.type]; if(!d) return;
    if(sitePlan && !E.spNodeVisible(n.type, n.id)) return; // site-plan: buildings + WIP hub, or a drilled-in building's subgraph
    if(editingId===n.id) return;
    // Watches are never collapsed — always show the flashy KPI
    if(n.type==='watch') n.collapsed=false;
    var div=document.createElement('div');
    div.className='ng-node ng-t-'+n.cat+' ng-tt-'+n.type+(selN===n.id?' ng-sel':'')+(connectedIds[n.id]?' ng-connected':'')+(n.collapsed?' ng-coll':'');
    div.setAttribute('data-id',n.id);
    var _rx=n.x, _ry=n.y;
    if(sitePlan && _spSatellite && n.geoLatLng){ var _gp=geoRenderPos(n); _rx=_gp.x; _ry=_gp.y; } // Slice 2: render geo-bound buildings on their real spot (n.x/y never overwritten)
    div.style.left=_rx+'px'; div.style.top=_ry+'px';
    // Site-plan: size a building into a footprint block (budget-proportional,
    // or its saved footprint) and tag a status class so CSS tints it by
    // progress. Render-only — n.footprint is read, never written here.
    if(sitePlan && n.type==='t1'){
      // On satellite, a geo-bound building is sized to a REAL-world footprint
      // (meters via E.spBuildingFootprint) so it matches building scale on the
      // imagery instead of the oversized budget pixel-card. Render-only.
      var _fp = (_spSatellite && n.geoLatLng)
        ? E.spBuildingFootprint(n.budget)
        : (n.footprint || E.budgetFootprint(n.budget));
      div.style.width=_fp.w+'px'; div.style.minHeight=_fp.h+'px';
      var _pc = n.pctComplete||0;
      div.classList.add(_pc>=100?'ng-sp-done':(_pc>0?'ng-sp-prog':'ng-sp-todo'));
      // On satellite, a geo-bound building renders as a real 3D MASSING BLOCK
      // (clean roof + extruded walls, data card stripped — drill in for numbers)
      // rather than a data card floating on the map. CSS does the roof; the
      // extrusion below does the walls (a lighter building grey, not dark depth).
      var _geoBldg = _spSatellite && n.geoLatLng;
      if(_geoBldg) div.classList.add('ng-sp-building');
      // Phase 4: a TRACED geo building is represented by its polygon (label + % drawn
      // on it, clicks handled there) — demote this card to a click-through shell.
      if(_geoBldg && n.polygon && n.polygon.length>=3) div.classList.add('ng-has-poly');
      // 2.5D massing: extrude the block with a budget-proportional depth so it
      // reads as solid mass (bigger budget = taller). Render-only; gated behind
      // the "3D" toggle (status stays on the border, so off reverts to flat).
      if(_spMassing){
        var _mb=Number(n.budget)||0, _mf=_mb>0?Math.min(1,Math.sqrt(_mb)/Math.sqrt(150000)):0.18, _md=Math.round(5+_mf*13);
        var _wall=_geoBldg?'#8a8f9c':'#0d1019';   // building wall vs abstract-canvas depth
        var _msh=''; for(var _mi=1;_mi<=_md;_mi++){ _msh+=(_msh?',':'')+_mi+'px '+_mi+'px 0 '+_wall; }
        _msh+=','+(_md+2)+'px '+(_md+6)+'px '+(_md+5)+'px rgba(0,0,0,.5)';
        div.style.boxShadow=_msh;
        div.classList.add('ng-sp-massing');
      }
    } else if(sitePlan && _spSatellite){
      // Every NON-building node (phase/sub/PO/materials/labor) is graph-unit sized;
      // on the ~0.5 m/unit satellite basemap a ~190px card reads ~95m — dwarfing the
      // building footprints. Scale it down so it sits proportional to them. transform
      // keeps getBoundingClientRect (→ wire port anchors) consistent, and top-left
      // origin keeps n.x/n.y the anchor. Reverts when satellite toggles off.
      div.style.transformOrigin='top left';
      div.style.transform='scale(0.16)';
    }

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
    // WIP's input ports 1 and 2 render vertically; Building (t1) / Phase (t2)
    // render their Costs input (port 0) as a square BOTTOM port instead of the
    // left grid (n8n sub-node look). Both are drawn below the node body.
    var isWip = n.type==='wip';
    var isTier = (n.type==='t1' || n.type==='t2');
    if(hasIns||hasOuts){
      h+='<div class="ng-ports">';
      var mx=Math.max((d.ins||[]).length,(d.outs||[]).length);
      for(var i=0;i<mx;i++){
        h+='<div class="ng-pr">';
        // Input port + label (left side)
        if(hasIns&&i<d.ins.length&&!(isWip&&(i===0||i===1||i===2))&&!(isTier&&i===0)){
          var ip=d.ins[i], ic=wires.some(function(w){return w.toNode===n.id&&w.toPort===i;});
          h+='<div class="ng-p ng-pi ng-p-'+ip.t+(ic?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="in" data-type="'+ip.t+'" title="'+ip.n+' → input ('+ip.t+')"></div>';
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
          // WIP: values live in the overview KPI grid below, so the output
          // ports stay as clean connection nubs (name + dot) — no inline value.
          if(!isWip) h+='<span class="ng-pv" style="margin-left:4px">'+E.fmtV(ov,op.t)+'</span>';
          h+='<div class="ng-p ng-po ng-p-'+op.t+(oc?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="out" data-type="'+op.t+'" title="'+op.n+' → output ('+op.t+') · drag to connect, or click ⊕ to add"></div>';
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
      // Project 86 progress bars: uniform blue→indigo gradient
      // matching the WIP table's % Complete column (which uses
      // linear-gradient(90deg, var(--accent), var(--purple))). The
      // tri-color tier (green=100%, amber=50%+, blue=<50%) was
      // semantic but visually clashed with the new chrome — the
      // bar fill width plus the % label still convey progress.
      var progColor = 'linear-gradient(90deg, #4f8cff, #a78bfa)';
      var progTitle = _computed?'Averaged from phase % complete':'Click to edit %';
      var progAttr = _computed?'':' data-prog-edit="'+n.id+'"';
      h+='<div class="ng-progress-wrap"'+progAttr+' title="'+progTitle+'">';
      h+='<div class="ng-progress"><div class="ng-progress-fill" style="width:'+Math.min(pct,100)+'%;background:'+progColor+'"></div></div>';
      h+='</div>';
      h+='<div class="ng-progress-label"'+progAttr+' title="'+progTitle+'"><span class="ng-pct-val">'+pct.toFixed(0)+'%</span> '+(_computed?'avg':'complete')+(n.budget?' \u00b7 Budget: '+E.fmtC(n.budget):'')+'</div>';
      // NG9: status-colored % pill (top-right corner). % complete, tinted by
      // budget health (actual vs n.budget). Neutral when there's no budget.
      var _chipCls='ng-stat-neutral', _chipAct=null;
      if(n.budget && n.budget>0){
        E.resetComp(); _chipAct=E.getActual(n);
        var _chipR=_chipAct/n.budget;
        _chipCls = _chipR>1 ? 'ng-stat-over' : (_chipR>=0.9 ? 'ng-stat-warn' : 'ng-stat-ok');
      }
      var _chipTitle = pct.toFixed(0)+'% complete'+(_chipAct!=null?' \u00b7 '+E.fmtC(_chipAct)+' of '+E.fmtC(n.budget)+(_chipCls==='ng-stat-over'?' (over budget)':''):'');
      h+='<div class="ng-pct-chip '+_chipCls+'" title="'+_chipTitle+'">'+pct.toFixed(0)+'%</div>';
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

        // Linked phases — direct po→phase wires with allocPct split.
        // This is the new cost-routing pattern: the PO stays attached
        // to its sub (relationship), and the cost is apportioned to
        // one or more phases here. Sums across rows should equal 100.
        if(!n.collapsed){
          var phaseWires=[];
          E.wires().forEach(function(w){
            if(w.fromNode!==n.id) return;
            var tgt=E.findNode(w.toNode);
            if(tgt && tgt.type==='t2') phaseWires.push({wire:w, phase:tgt});
          });
          var totalAlloc=phaseWires.reduce(function(s,pw){
            return s + (pw.wire.allocPct!=null?Number(pw.wire.allocPct)||0:100);
          }, 0);
          h+='<div class="ng-po-linked-section" style="padding:6px 10px 8px;border-top:1px solid var(--ng-border2);">';
          h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
          h+='<span style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#8b90a5;font-weight:600;">Linked Phases</span>';
          var allocOk = phaseWires.length===0 || Math.abs(totalAlloc-100)<0.5;
          if(phaseWires.length){
            h+='<span class="ng-po-alloc-badge" style="font-size:10px;color:'+(allocOk?'#6a7090':'#fbbf24')+';font-family:\'Courier New\',monospace;font-weight:600;" title="'+(allocOk?'Allocation totals 100%':'Allocation does not sum to 100% — phase rollups will under/over count')+'">'+totalAlloc.toFixed(0)+'%</span>';
          }
          h+='</div>';
          if(!phaseWires.length){
            h+='<div style="font-size:11px;color:#6a7090;font-style:italic;padding:2px 0 6px;line-height:1.4;">No phases linked yet. Cost still flows via the sub. Add a phase to split this PO across phases.</div>';
          } else {
            // Scroll the rows when many phases get linked so the
            // node body doesn\'t grow off-screen. ~5 rows visible at
            // once; user scrolls inside the section for the rest.
            h+='<div class="ng-po-linked-rows" style="max-height:160px;overflow-y:auto;margin:0 -2px;padding:0 2px;">';
            phaseWires.forEach(function(pw){
              var pname=(pw.phase.label||pw.phase.type).split(' › ')[0].trim().slice(0,40);
              var pa=pw.wire.allocPct!=null?Number(pw.wire.allocPct):100;
              h+='<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;color:#c4c9db;">';
              h+='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\u{1F4CB} '+pname+'</span>';
              h+='<input class="ng-po-alloc" type="number" min="0" max="100" step="1" value="'+pa.toFixed(0)+'" data-from="'+n.id+'" data-to="'+pw.phase.id+'" style="width:48px;background:rgba(255,255,255,0.04);border:1px solid var(--ng-border2);color:#fff;border-radius:3px;padding:2px 4px;font-family:\'Courier New\',monospace;font-size:11px;text-align:right;" title="Allocation % to this phase" />';
              h+='<span style="color:#6a7090;font-size:10px;">%</span>';
              h+='<span class="ng-po-unlink" data-from="'+n.id+'" data-to="'+pw.phase.id+'" title="Unlink phase" style="cursor:pointer;color:#f87171;padding:2px 6px;border-radius:3px;font-size:11px;">✖</span>';
              h+='</div>';
            });
            h+='</div>';
          }
          // "+ Link phase" affordance — now a real button so it\'s
          // obviously clickable at any zoom level. Sits below the
          // (potentially scrolling) rows.
          h+='<button class="ng-po-link-add" type="button" data-po-node="'+n.id+'" title="Link this PO to a phase" style="margin-top:6px;cursor:pointer;background:rgba(79,140,255,0.12);color:#7da8ff;border:1px dashed rgba(79,140,255,0.4);border-radius:4px;padding:4px 10px;font-size:11px;font-weight:500;font-family:inherit;">+ Link phase</button>';
          h+='</div>';
        }
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
      // T2 (Phase): full mini P&L mirroring the CO node — revenue,
      // % complete, revenue earned, actual, accrued, gross profit,
      // followed by the per-building allocation table. Phase doesn't
      // carry an items[] array like CO does, so we skip CO's bottom
      // line-item table; the allocation table fills the same
      // orientation role ("where does this phase's money go").
      //
      // All numbers use the same colors as the CO block so a phase
      // and a CO node paint identically when they sit side-by-side
      // on the graph. Helpers (getT2WeightedPct, getActual, getAccrued)
      // already work on t2 — see comments in engine.js.
      if(n.type==='t2'){
        var phaseRev=n.revenue||0;
        var phasePctComp=E.getT2WeightedPct(n);
        var phaseRevEarned=phaseRev*(phasePctComp/100);
        var phaseGP=phaseRevEarned-(tActual+tAccrued);
        var gpColor=phaseGP>=0?'#34d399':'#f87171';
        var phasePctColor=phasePctComp>=100?'#34d399':phasePctComp>=50?'#fbbf24':'#4f8cff';
        // Metric stack — same row shape and color coding as the CO
        // metric stack above so the two read identically.
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Revenue <span class="ng-phase-rev" data-phase-rev="'+n.id+'" title="Click to edit" style="color:#34d399;font-weight:600;font-family:\'Courier New\',monospace;cursor:pointer;">'+E.fmtC(phaseRev)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">% Complete <span style="color:'+phasePctColor+';font-weight:600;font-family:\'Courier New\',monospace;">'+phasePctComp.toFixed(1)+'%</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Rev. Earned <span style="color:#4f8cff;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(phaseRevEarned)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Actual <span style="color:#f87171;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(tActual)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Accrued <span style="color:#fbbf24;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(tAccrued)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:3px 0 2px;border-top:1px solid var(--ng-border2);margin-top:2px;color:#6a7090;font-weight:600;">Gross Profit <span style="color:'+gpColor+';font-weight:700;font-family:\'Courier New\',monospace;">'+E.fmtC(phaseGP)+'</span></div>';
        // Allocation breakdown per connected building (unchanged)
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
      }
      // T1 (Building): full mini P&L matching the CO and t2 node
      // metric stacks, with one conceptual twist — every value on
      // this node is DERIVED (rolled up from connected phases/COs)
      // rather than entered. Revenue isn't click-to-edit, and the
      // ∑ glyph beside its label cues "this is a sum, not a field".
      // The Connected breakdown table below the stack stays as the
      // source-of-truth detail ("here's where this revenue came
      // from"); the standalone "Rev Allocated" row that used to
      // render here is dropped — Revenue in the stack is the same
      // number.
      if(n.type==='t1'){
        var bRev=E.getBuildingAllocatedRevenue(n);
        var bldgPctComp=E.getT1WeightedPct(n);
        var bldgRevEarned=bRev*(bldgPctComp/100);
        var bldgGP=bldgRevEarned-(tActual+tAccrued);
        var bldgGpColor=bldgGP>=0?'#34d399':'#f87171';
        var bldgPctColor=bldgPctComp>=100?'#34d399':bldgPctComp>=50?'#fbbf24':'#4f8cff';
        // Metric stack — same row shape and color coding as the CO
        // and t2 stacks. Revenue/% Complete intentionally have NO
        // cursor:pointer because both are rollups; the small "∑"
        // glyph in the label tells the user this value is summed
        // from the connected sources below, not editable here.
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;" title="Sum of revenue allocated from connected phases and COs">∑ Revenue <span style="color:#34d399;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(bRev)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;" title="Income-weighted % complete across connected sources">∑ % Complete <span style="color:'+bldgPctColor+';font-weight:600;font-family:\'Courier New\',monospace;">'+bldgPctComp.toFixed(1)+'%</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Rev. Earned <span style="color:#4f8cff;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(bldgRevEarned)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Actual <span style="color:#f87171;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(tActual)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Accrued <span style="color:#fbbf24;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(tAccrued)+'</span></div>';
        h+='<div style="display:flex;justify-content:space-between;padding:3px 0 2px;border-top:1px solid var(--ng-border2);margin-top:2px;color:#6a7090;font-weight:600;">Gross Profit <span style="color:'+bldgGpColor+';font-weight:700;font-family:\'Courier New\',monospace;">'+E.fmtC(bldgGP)+'</span></div>';
        // Connected phases + COs breakdown — source-of-truth detail
        // for where the Revenue + Actual + Accrued numbers above
        // came from. Unchanged from the previous implementation.
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
          // Two-pass render: first pass tallies totRev / totCost so the
          // second pass can derive each source's share of total revenue.
          // ALLOC shifts from "manually-set allocPct on the wire" (which
          // was confusing because phases set their OWN allocation %)
          // to "this source's share of the building's total income"
          // (rev_i / totRev × 100). The building's %complete still
          // weights by income contribution under the hood — see
          // engine.getT1WeightedPct, which uses ap × rev = the same
          // dollar weight this column now displays. Recomputed every
          // render, so attaching a new node or editing income flows
          // through immediately.
          var totRev=0, totCost=0;
          t1Conns.forEach(function(c){ totRev += c.rev; totCost += (c.actual + c.accrued); });

          h+='<div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--ng-border2);">';
          h+='<div style="display:flex;align-items:center;padding:1px 0 3px;color:#8b90a5;font-size:8px;text-transform:uppercase;letter-spacing:0.5px;gap:4px;">';
          h+='<span style="flex:1;">Connected</span>';
          h+='<span style="min-width:58px;text-align:right;">Rev</span>';
          h+='<span style="min-width:58px;text-align:right;">Cost</span>';
          h+='<span style="min-width:36px;text-align:right;">Alloc</span>';
          h+='</div>';
          t1Conns.forEach(function(c){
            var cost=c.actual+c.accrued;
            // %complete styling — bright green + bold once a source
            // hits 100%, otherwise rendered as quiet italic note text
            // (one px smaller than the row body, weight 300, ~28%
            // alpha white). Always shown so the user sees ANY in-flight
            // source has a value; the bold green jumps off the page
            // only when a source is actually done.
            var pctDone = c.pct >= 100;
            var pctStyle = pctDone
              ? 'color:#34d399;font-weight:600;'
              : 'color:rgba(255,255,255,0.28);font-weight:300;font-size:8px;font-style:italic;';
            // Income share — protected against division-by-zero when no
            // source has revenue yet (e.g. just-attached phase before
            // the user enters revenue). Falls back to 0% rather than NaN.
            var incomeShare = (totRev > 0) ? (c.rev / totRev * 100) : 0;
            h+='<div style="display:flex;align-items:center;padding:2px 0;color:#6a7090;font-size:9px;gap:4px;">';
            h+='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+c.icon+' '+c.name+' <span style="'+pctStyle+'">'+c.pct.toFixed(0)+'%</span></span>';
            h+='<span style="color:#4f8cff;font-family:\'Courier New\',monospace;min-width:58px;text-align:right;">'+E.fmtC(c.rev)+'</span>';
            h+='<span style="color:#f87171;font-family:\'Courier New\',monospace;min-width:58px;text-align:right;">'+E.fmtC(cost)+'</span>';
            h+='<span title="Share of building total revenue ('+E.fmtC(c.rev)+' of '+E.fmtC(totRev)+')" style="color:#fbbf24;font-family:\'Courier New\',monospace;min-width:36px;text-align:right;">'+incomeShare.toFixed(1)+'%</span>';
            h+='</div>';
          });
          h+='<div style="display:flex;align-items:center;padding:3px 0 1px;border-top:1px solid var(--ng-border2);margin-top:2px;color:#6a7090;font-size:9px;font-weight:600;gap:4px;">';
          h+='<span style="flex:1;">Total</span>';
          h+='<span style="color:#4f8cff;font-family:\'Courier New\',monospace;min-width:58px;text-align:right;">'+E.fmtC(totRev)+'</span>';
          h+='<span style="color:#f87171;font-family:\'Courier New\',monospace;min-width:58px;text-align:right;">'+E.fmtC(totCost)+'</span>';
          h+='<span style="color:#fbbf24;font-family:\'Courier New\',monospace;min-width:36px;text-align:right;">'+(totRev > 0 ? '100%' : '—')+'</span>';
          h+='</div></div>';
        }
      }
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
      // NG-WIP: overview dashboard — computed metrics as a KPI tile grid.
      // (Replaces the old per-output Watch fan; Watch nodes no longer echo
      // these.) Total Income + Gross Profit are featured as full-width hero
      // tiles; the rest fill a 2-column grid. Display-only — calc-safe.
      var wipD=E.DEFS.wip;
      h+='<div class="ng-ov-head">Overview</div>';
      h+='<div class="ng-wip-ov">';
      wipD.outs.forEach(function(op,oi){
        var ov=E.getOutput(n,oi);
        var fmt=op.t===E.PT.P?E.fmtP(ov):E.fmtC(ov);
        var vc=ov>0?'ng-ov-pos':ov<0?'ng-ov-neg':'ng-ov-zero';
        var hero=(op.n==='Total Income'||op.n==='Gross Profit')?' ng-ov-hero':'';
        h+='<div class="ng-wip-ov-kpi'+hero+'">';
        h+='<span class="ng-ov-lbl">'+op.n+'</span>';
        h+='<span class="ng-ov-val '+vc+'">'+fmt+'</span>';
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
        // Project 86 uniform blue→indigo bar; see expanded-render comment.
        var cpColor = 'linear-gradient(90deg, #4f8cff, #a78bfa)';
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
        // NG-SHAPE: CO collapses to a simple triangle chip — icon + income $
        // at a glance (full P&L is on the expanded card). Compact $ so it fits.
        E.resetComp(); var coInc=E.getOutput(n,0);
        h+='<span class="ng-coll-val ng-coll-val-big" style="text-align:center;width:100%" title="Income '+E.fmtC(coInc)+'">'+fmtCompactC(coInc)+'</span>';
      } else if(d.hasProg){
        var cpct2 = n.pctComplete||0;
        var cpColor2 = 'linear-gradient(90deg, #4f8cff, #a78bfa)';
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
        // NG-R3: round cost chips show compact $ at a glance; others full $.
        var _cvDisp = (n.cat==='cost') ? fmtCompactC(collVal) : E.fmtC(collVal);
        h+='<span class="ng-coll-val'+(n.cat==='cost'?' ng-coll-val-big':'')+'" style="text-align:center;width:100%" title="'+E.fmtC(collVal)+'">'+_cvDisp+'</span>';
      }
      h+='</div>';
    }

    // WIP ports: main child input (port 0) on the bottom-center; the two extra
    // cost/CO ports on top + bottom-right (always visible, even collapsed).
    if(n.type==='wip'){
      var cmain=wires.some(function(w){return w.toNode===n.id&&w.toPort===0;});
      var ctop=wires.some(function(w){return w.toNode===n.id&&w.toPort===1;});
      var cbot=wires.some(function(w){return w.toNode===n.id&&w.toPort===2;});
      h+='<div class="ng-p ng-pv-bot ng-p-currency'+(cmain?' ng-pc':'')+'" style="left:50%" data-node="'+n.id+'" data-pi="0" data-dir="in" data-type="currency" title="Buildings / costs"></div>';
      h+='<div class="ng-p ng-pv-top ng-p-currency'+(ctop?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="1" data-dir="in" data-type="currency" title="+ Costs / COs (top)"></div>';
      h+='<div class="ng-p ng-pv-bot ng-p-currency'+(cbot?' ng-pc':'')+'" style="left:76%" data-node="'+n.id+'" data-pi="2" data-dir="in" data-type="currency" title="+ Costs / COs (extra)"></div>';
    }
    // Building (t1) / Phase (t2): Costs input (port 0) as a square BOTTOM port.
    if(n.type==='t1' || n.type==='t2'){
      var cb0=wires.some(function(w){return w.toNode===n.id&&w.toPort===0;});
      h+='<div class="ng-p ng-pv-bot ng-p-currency'+(cb0?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="0" data-dir="in" data-type="currency" title="Costs / phases (drag a cost here, or click ⊕)"></div>';
    }

    // NG4a: floating hover toolbar (above the tile) + name-below caption.
    // Rendered for every node but only shown in Clean Mode (CSS-gated).
    h+='<div class="ng-node-tools">';
    if(canEdit) h+='<span class="ng-nt-btn" data-edit="'+n.id+'" title="Edit details">⚙</span>';
    if(canColl) h+='<span class="ng-nt-btn" data-coll="'+n.id+'" title="Collapse / expand">'+(n.collapsed?'▶':'▼')+'</span>';
    if(canColl) h+='<span class="ng-nt-btn" data-dup="'+n.id+'" title="Duplicate">⧉</span>';
    h+='<span class="ng-nt-btn ng-nt-del" data-del="'+n.id+'" title="Delete">✕</span>';
    h+='</div>';
    h+='<div class="ng-node-cap" data-rename="'+n.id+'" title="Double-click to rename">'+n.label+'</div>';

    div.innerHTML=h;
    canvasEl.appendChild(div);
  });
}

function render(){
  updateTierLabels();
  updateT1Progress();
  pushToJobSilent();
  renderFrames();
  renderNodes();
  renderPolygons();                 // geo-anchored building footprints (satellite only)
  renderSidebarMetrics();           // live WIP totals in the sidebar (satellite only, via CSS)
  renderBuildingMetrics();          // S2: selected building's cost breakdown
  E.drawGrid(gridCtx, gridC.width, gridC.height);
  E.drawWires(wireCtx, wrap, wiringFrom, wireMouse);
  E.saveGraph();
  drawMinimap();
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
  if(_spSatellite) syncBasemapCamera();   // keep the slaved basemap under the camera
  if(_spPhotos) layoutPhotoPins();        // keep photo pins on their spots
}

// ── NG-R3: compact currency ($120k / $1.3M) for at-a-glance round cost chips ──
function fmtCompactC(v){
  v=+v||0; var a=Math.abs(v), s=v<0?'-':'';
  if(a>=1e6){ var m=a/1e6; return s+'$'+(m>=10?Math.round(m):m.toFixed(1).replace(/\.0$/,''))+'M'; }
  if(a>=1e3){ var k=a/1e3; return s+'$'+(k>=100?Math.round(k):k.toFixed(1).replace(/\.0$/,''))+'k'; }
  return s+'$'+Math.round(a);
}

// ── NG8: frames (group boxes) ──
function ngHexA(hex,a){ var h=(hex||'#4f8cff').replace('#',''); if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; var r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16); return 'rgba('+r+','+g+','+b+','+a+')'; }
// Nodes whose center falls inside the frame rect — captured at drag-start so
// the frame carries them when moved.
function ngFrameMembers(f){
  return E.nodes().filter(function(n){
    var fp=ngNodeFootprint(n); var cx=n.x+fp.w/2, cy=n.y+fp.h/2;
    return cx>=f.x && cx<=f.x+f.w && cy>=f.y && cy<=f.y+f.h;
  });
}
// Render frame boxes behind the nodes (separate from .ng-node rebuild).
function renderFrames(){
  if(!canvasEl) return;
  canvasEl.querySelectorAll('.ng-frame').forEach(function(el){ el.remove(); });
  var fr=(E.frames && E.frames())||[];
  fr.forEach(function(f){
    var div=document.createElement('div');
    div.className='ng-frame'+(selFrame===f.id?' ng-frame-sel':'');
    div.setAttribute('data-frame', f.id);
    div.style.left=f.x+'px'; div.style.top=f.y+'px'; div.style.width=f.w+'px'; div.style.height=f.h+'px';
    var col=f.color||'#4f8cff';
    div.style.borderColor=ngHexA(col,0.55); div.style.background=ngHexA(col,0.06);
    div.innerHTML='<div class="ng-frame-title" data-frame-drag="'+f.id+'" style="color:'+col+'"><span class="ng-frame-label" data-frame-rename="'+f.id+'" title="Double-click to rename"></span><span class="ng-frame-del" data-frame-del="'+f.id+'" title="Delete frame">×</span></div><div class="ng-frame-resize" data-frame-resize="'+f.id+'" title="Drag to resize"></div>';
    div.querySelector('.ng-frame-label').textContent=f.label||'Group';
    canvasEl.appendChild(div);
  });
}

// ── NG7: node footprint (true layout box) ──
// offsetWidth/offsetHeight are graph-unit values (unaffected by the canvas
// zoom transform) and exclude the overflowing port nubs — the right size for
// minimap + fit math. Falls back to estNodeHeight when a node isn't rendered.
function ngNodeFootprint(n){
  var el=canvasEl?canvasEl.querySelector('.ng-node[data-id="'+n.id+'"]'):null;
  if(el && el.offsetHeight) return {w:el.offsetWidth||210, h:el.offsetHeight};
  return {w:210, h:(typeof estNodeHeight==='function'?estNodeHeight(n):120)};
}

// ── NG7: overview minimap ──
// Draws every node scaled into the corner canvas + a rectangle marking the
// current viewport. _ngMmTx caches the graph->minimap transform so the click/
// drag navigation handler can invert a minimap point back to graph space.
var _ngMmTx=null;
var NG_MM_COL={wip:'#4f8cff',t1:'#5b8def',t2:'#6aa9ef',cost:'#e0a23c',sub:'#9b7ed8',co:'#e8806a',math:'#7a8699',watch:'#4bbf9a',note:'#cdbb6a'};
function drawMinimap(){
  if(!wrap) return;
  var mm=wrap.querySelector('.ng-minimap');
  var cv=wrap.querySelector('.ng-minimap-cv');
  var vp=wrap.querySelector('.ng-minimap-vp');
  if(!mm||!cv||!vp) return;
  var ns=E.nodes();
  if(!ns.length){ mm.style.display='none'; _ngMmTx=null; return; }
  mm.style.display='';
  var ctx=cv.getContext('2d'); if(!ctx) return;
  var W=cv.width, H=cv.height;
  ctx.clearRect(0,0,W,H);
  var p=E.pan(), z=E.zm()||1;
  // viewport rect in graph coords (screen 0..client maps to gx = sx/z - p)
  var vx0=-p.x, vy0=-p.y, vw=wrap.clientWidth/z, vh=wrap.clientHeight/z;
  // graph bounds — include the viewport so the vp marker is always on-map
  var minX=vx0,minY=vy0,maxX=vx0+vw,maxY=vy0+vh;
  var boxes=ns.map(function(n){
    var f=ngNodeFootprint(n);
    if(n.x<minX)minX=n.x; if(n.y<minY)minY=n.y;
    if(n.x+f.w>maxX)maxX=n.x+f.w; if(n.y+f.h>maxY)maxY=n.y+f.h;
    return {x:n.x,y:n.y,w:f.w,h:f.h,type:n.type};
  });
  var gw=Math.max(1,maxX-minX), gh=Math.max(1,maxY-minY), pad=8;
  var scale=Math.min((W-pad*2)/gw,(H-pad*2)/gh);
  var offX=(W-gw*scale)/2 - minX*scale;
  var offY=(H-gh*scale)/2 - minY*scale;
  _ngMmTx={scale:scale, offX:offX, offY:offY};
  boxes.forEach(function(b){
    var d=null; try{ d=E.DEFS[b.type]; }catch(e){}
    var col=NG_MM_COL[b.type]||(d&&NG_MM_COL[d.cat])||'#6b7689';
    ctx.fillStyle=col; ctx.globalAlpha=0.85;
    ctx.fillRect(b.x*scale+offX, b.y*scale+offY, Math.max(2,b.w*scale), Math.max(2,b.h*scale));
  });
  ctx.globalAlpha=1;
  // viewport marker (clamped to the minimap)
  var rx=vx0*scale+offX, ry=vy0*scale+offY, rw=vw*scale, rh=vh*scale;
  var lx=Math.max(0,rx), ty=Math.max(0,ry);
  vp.style.left=lx+'px';
  vp.style.top=ty+'px';
  vp.style.width=Math.max(4,Math.min(W,rx+rw)-lx)+'px';
  vp.style.height=Math.max(4,Math.min(H,ry+rh)-ty)+'px';
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
//
// Centering math: applyTx renders as `translate(p.x*z, p.y*z) scale(z)`,
// so a graph point (n.x + ox, n.y + oy) lands at viewport pixel
// `(p.x + n.x + ox) * z`. We want that to equal viewport center:
//   (p.x + n.x + ox) * z = wrap.clientWidth / 2
//   p.x = wrap.clientWidth / (2*z) - n.x - ox
// (ox, oy) is the node's geometric center offset. Reading the live
// DOM size beats the old hardcoded (85, 30) — large nodes (expanded
// subs / wip / collapsed-but-tall watch) were drifting noticeably to
// the upper-left.
// ── Site-plan drill-in (Slice 3) ──────────────────────────────────────
// Recompute the engine focus-set from _spFocus: the building + its directly
// wired phases/costs (the WIP hub is always shown). null = whole-site view.
function applySpFocus(){
  if(_spFocus){
    var set=getConnectedIds(_spFocus); set[_spFocus]=1;
    E.setSitePlanFocusSet(set);
  } else {
    E.setSitePlanFocusSet(null);
  }
  var t=document.getElementById('nodeGraphTab');
  if(t) t.classList.toggle('ng-sp-focused', !!_spFocus);
}
// S3: on first drill-in, fan a building's directly-connected phase/cost nodes in an
// arc around its polygon (geo) centre — so the cost graph reads spatially on the map.
// Fans once per session per building (manual moves stick after). Mutates child x/y
// only; financial rollups never read x/y, so this is calc-safe.
var _fannedSet={};
function fanFocusNodes(bId){
  if(!bId || _fannedSet[bId]) return;
  var b=E.findNode(bId); if(!b) return;
  var center=(b.geoLatLng)?geoRenderPos(b):{x:b.x, y:b.y};
  var seen={}, kids=[];
  E.wires().forEach(function(w){
    if(w.toNode!==bId) return;
    var k=E.findNode(w.fromNode);
    if(k && !seen[k.id]){ seen[k.id]=true; kids.push(k); }
  });
  if(!kids.length) return;
  kids.sort(function(a,c){ return (a.type==='t2'?0:1)-(c.type==='t2'?0:1); }); // phases first
  // On satellite the cost cards are scale(0.16) and 1 graph unit ≈ 0.5m, so the ring
  // + card-centre offsets shrink to match (else the nodes fly hundreds of metres off).
  var _sat=!!_spSatellite && E.viewMode && E.viewMode()==='siteplan';
  var R=Math.max(220, 56*kids.length) * (_sat?0.14:1);
  var _ox=_sat?15:85, _oy=_sat?5:30;                    // half the (scaled) card, to centre it on the ring point
  var arc=Math.min(330, Math.max(110, kids.length*46));
  var start=270-arc/2;                                  // 270° = above the building (y grows down)
  kids.forEach(function(k,i){
    var deg=kids.length>1 ? start+arc*i/(kids.length-1) : 270;
    var a=deg*Math.PI/180;
    k.x=Math.round(center.x + Math.cos(a)*R - _ox);
    k.y=Math.round(center.y + Math.sin(a)*R - _oy);
  });
  _fannedSet[bId]=true;
}
// Frame the currently-visible site-plan nodes — mirrors zoomFitAll but scoped
// via E.spNodeVisible (so it fits the whole site, or a drilled-in subgraph).
function fitSiteplan(){
  if(!wrap) return;
  var ns=E.nodes().filter(function(n){ return E.spNodeVisible(n.type, n.id); });
  if(!ns.length){ applyTx(); render(); return; }
  var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  ns.forEach(function(n){ var f=ngNodeFootprint(n); if(n.x<minX)minX=n.x; if(n.y<minY)minY=n.y; if(n.x+f.w>maxX)maxX=n.x+f.w; if(n.y+f.h>maxY)maxY=n.y+f.h; });
  var bw=Math.max(1,maxX-minX), bh=Math.max(1,maxY-minY), pad=90;
  var vw=Math.max(1,wrap.clientWidth-pad*2), vh=Math.max(1,wrap.clientHeight-pad*2);
  var fz=Math.max(0.2,Math.min(2,Math.min(vw/bw,vh/bh)));
  E.zm(fz);
  var bcx=(minX+maxX)/2, bcy=(minY+maxY)/2;
  E.pan(wrap.clientWidth/2/fz-bcx, wrap.clientHeight/2/fz-bcy);
  applyTx(); render();
}

// ── Site-plan satellite basemap (Phase 2-A, Slice 1) ───────────────────
// A real google.maps.Map mounted BEHIND the node canvas (pointer-events:none),
// driven ONE-WAY from the engine camera: on every pan/zoom we derive the map's
// center + zoom from E.pan()/E.zm() and a fixed origin (the job geocode). The
// engine stays the sole input authority, so wires/drag/drill are untouched and
// this layer is render-only. Satellite on/off rides localStorage (like the
// view-mode toggle) — no graph write, no GRAPH_VER concern.

// The job's geocoded lat/lng = the map origin (validated like projects-map's projectCoords).
function jobOrigin(){
  if(typeof appData==='undefined' || !appData.jobs) return null;
  var jid=E.job(); if(!jid) return null;
  var job=appData.jobs.find(function(j){ return j.id===jid; }); if(!job) return null;
  var lat=Number(job.geocode_lat), lng=Number(job.geocode_lng);
  if(!isFinite(lat)||!isFinite(lng)) return null;
  if(lat===0&&lng===0) return null;                       // Null Island = never geocoded
  if(Math.abs(lat)>85.05||lng<-180||lng>180) return null; // Mercator clip band — keeps cos(lat) well-conditioned
  return { lat:lat, lng:lng };
}
// Graph-space anchor for the origin: centroid of the visible site-plan nodes, so
// the imagery sits centered under the building blocks (Slice 1 — nodes aren't
// geo-bound yet; true per-building placement comes in Slice 2).
function siteplanCentroid(){
  var ns=E.nodes().filter(function(n){ return E.spNodeVisible(n.type, n.id); });
  if(!ns.length) return { x:0, y:0 };
  var sx=0, sy=0; ns.forEach(function(n){ sx+=n.x; sy+=n.y; });
  return { x:sx/ns.length, y:sy/ns.length };
}
// Slice 2: a geo-bound building's render position = the origin's graph anchor
// (_spOriginGraph) + its projected offset from the origin lat/lng. Derived only —
// n.x/n.y are never mutated, so toggling satellite off restores the layout.
function geoRenderPos(n){
  if(!n.geoLatLng) return { x:n.x, y:n.y };
  // Use the cached origin when it belongs to the current job; otherwise recompute
  // it on the spot (jobOrigin/siteplanCentroid are pure reads + deterministic).
  // This keeps a geo-bound building anchored even if the cache was transiently
  // nulled — rather than snapping it to its off-screen abstract x/y.
  var _sameJob=_spOriginJob===E.job();
  var o=(_spOrigin && _sameJob) ? _spOrigin : jobOrigin();
  var og=(_spOriginGraph && _sameJob) ? _spOriginGraph : siteplanCentroid();
  if(!o || !og) return { x:n.x, y:n.y };
  var g=E.spLatLngToGraph(n.geoLatLng.lat, n.geoLatLng.lng, o.lat, o.lng);
  return { x:og.x + g.x, y:og.y + g.y };
}
function showSatHint(show, msg){
  if(!wrap) return;
  if(!_satHintEl){ _satHintEl=document.createElement('div'); _satHintEl.className='ng-sat-hint'; wrap.appendChild(_satHintEl); }
  _satHintEl.textContent = msg || 'Add a geocoded job address to enable the satellite basemap.';
  _satHintEl.style.display = show ? 'block' : 'none';
}
// On-demand geocode: when a job has no coords yet, the weather endpoint geocodes
// its address server-side (cached on the job row) AND returns the coords — so we
// light up the basemap immediately instead of stranding the user on the hint.
function tryGeocodeJobThenMount(){
  var jid=E.job();
  if(_geocoding) return;
  if(!jid || typeof p86Api==='undefined' || !p86Api.weather){ showSatHint(true); return; }
  _geocoding=true;
  showSatHint(true, 'Locating the job address…');
  p86Api.weather.jobs([jid]).then(function(resp){
    _geocoding=false;
    var w=resp && resp.weather && resp.weather[jid];
    var lat=w?Number(w.lat):NaN, lng=w?Number(w.lng):NaN;
    if(isFinite(lat)&&isFinite(lng)&&!(lat===0&&lng===0)){
      var job=(typeof appData!=='undefined'&&appData.jobs)?appData.jobs.find(function(j){return j.id===jid;}):null;
      if(job){ job.geocode_lat=lat; job.geocode_lng=lng; }   // so jobOrigin() resolves on retry
      showSatHint(false);
      if(_spSatellite && E.viewMode && E.viewMode()==='siteplan'){ mountBasemap(); updatePhotoLayer(); }
    } else {
      showSatHint(true, 'Add a street address to this job to enable the satellite map.');
    }
  }).catch(function(){ _geocoding=false; showSatHint(true, 'Could not locate the job address.'); });
}
function mountBasemap(){
  if(!basemapEl) return;
  _spOrigin=jobOrigin(); _spOriginGraph=siteplanCentroid(); _spOriginJob=E.job(); // stamp origin with its job
  if(!_spOrigin){ tryGeocodeJobThenMount(); return; } // no coords yet — geocode on demand, then retry
  showSatHint(false);
  if(_basemap){ _basemapReady=true; syncBasemapCamera(); return; }
  if(!window.p86Maps){ showSatHint(true, 'Google Maps is not available.'); return; }
  window.p86Maps.ready().then(function(maps){
    if(!_spSatellite) return;                              // toggled off while the SDK loaded
    _basemap=new maps.Map(basemapEl, {
      center:{ lat:_spOrigin.lat, lng:_spOrigin.lng }, zoom:19,
      mapTypeId:maps.MapTypeId.SATELLITE, tilt:0,
      disableDefaultUI:true, gestureHandling:'none', keyboardShortcuts:false,
      clickableIcons:false, backgroundColor:'#0b0e16', isFractionalZoomEnabled:false
    });
    _basemapReady=true; syncBasemapCamera();
  }).catch(function(e){ showSatHint(true, (e&&e.message) || 'Satellite basemap unavailable.'); });
}
// One-way camera sync. Raster satellite tiles exist only at integer zoom, so we
// floor to an integer map zoom and CSS-scale the basemap div by the fractional
// remainder (>=1, so it always fills the viewport) to track the engine's
// continuous zoom smoothly. Pure read of E.pan()/E.zm() — no writeback.
function syncBasemapCamera(){
  if(!_basemap || !_basemapReady || !_spOrigin || !_spOriginGraph) return;
  if(!_spSatellite || (E.viewMode && E.viewMode()!=='siteplan')) return;
  var z=E.zm(), p=E.pan();
  var gcx=(wrap.clientWidth/2)/z - p.x, gcy=(wrap.clientHeight/2)/z - p.y;   // screen-centre in graph coords
  var c=E.spGraphToLatLng(gcx-_spOriginGraph.x, gcy-_spOriginGraph.y, _spOrigin.lat, _spOrigin.lng);
  var mz=E.spMapZoom(z, _spOrigin.lat), iz=Math.max(0, Math.min(21, Math.floor(mz))); // clamp to Google's zoom range
  if(_basemap.getZoom()!==iz) _basemap.setZoom(iz);   // only re-tile on a real integer-zoom boundary cross
  _basemap.setCenter(c);
  // Scale by the delta between the engine's continuous map-zoom and the basemap's
  // CURRENTLY-rendered integer zoom (not the freshly-floored target). A setZoom
  // re-tile is async, so getZoom() can lag iz for a frame at the boundary; scaling
  // off the rendered zoom keeps the transform exact across 100%/200% instead of
  // snapping the div back to 1.0 a frame before the sharper tiles arrive (the bump).
  var rz=_basemap.getZoom();
  if(typeof rz!=='number' || !isFinite(rz)) rz=iz;
  basemapEl.style.transformOrigin='center center';
  basemapEl.style.transform='scale('+Math.pow(2, mz-rz)+')';
}
function updateBasemapVisibility(){
  if(!basemapEl) return;
  var show=_spSatellite && E.viewMode && E.viewMode()==='siteplan';
  var t=document.getElementById('nodeGraphTab');
  if(t) t.classList.toggle('ng-sat', !!show);
  basemapEl.style.display = show ? 'block' : 'none';
  if(show){ mountBasemap(); } else { showSatHint(false); exitGeoPick(); exitTrace(); }
  updatePhotoLayer(); // photos ride on top of satellite — show/hide together
  renderPolygons();   // show/hide the building footprint layer with satellite
}

// ── Map-picker (Slice 3): the ONLY building-geo write path ──────────────
// Convert a click in the canvas area to a lat/lng using the SAME projection the
// renderer uses, so a placed building lands exactly where it was clicked.
function pickLatLngFromEvent(e){
  var r=wrap.getBoundingClientRect();
  var cx=e.clientX-r.left, cy=e.clientY-r.top;
  var z=E.zm(), p=E.pan();
  var gx=cx/z - p.x, gy=cy/z - p.y;                          // click point in graph coords
  return E.spGraphToLatLng(gx-_spOriginGraph.x, gy-_spOriginGraph.y, _spOrigin.lat, _spOrigin.lng);
}
// A transparent crosshair overlay captures the placement click ABOVE the engine,
// so the engine never sees it (no event-ordering fight, no pan/select side-effects).
function ensureGeoPickOverlay(){
  if(_geoPickOverlay) return _geoPickOverlay;
  _geoPickOverlay=document.createElement('div');
  _geoPickOverlay.className='ng-geopick-overlay';
  // Swallow the gesture so the engine's wrap-level mousedown never pans/deselects.
  _geoPickOverlay.addEventListener('mousedown',function(e){ e.stopPropagation(); });
  _geoPickOverlay.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
  _geoPickOverlay.addEventListener('mouseup',function(e){ e.stopPropagation(); });
  _geoPickOverlay.addEventListener('click',function(e){
    var sel=_geoPickId && E.findNode(_geoPickId);            // captured at Place time — not live selN
    if(sel && sel.type==='t1' && _spOrigin && _spOriginGraph){
      var ll=pickLatLngFromEvent(e);
      E.setNodeGeo(sel.id, ll.lat, ll.lng);
      if(E.saveGraph) E.saveGraph();
      render();
      exitGeoPick();
    } else {
      exitGeoPick();
      showSatHint(true, 'Selection lost — pick a building, then click Place again.');
    }
  });
  wrap.appendChild(_geoPickOverlay);
  return _geoPickOverlay;
}
function exitGeoPick(){
  _geoPick=false; _geoPickId=null;
  var pb=document.getElementById('ngGeoPlaceBtn'); if(pb) pb.classList.remove('ng-on');
  if(_geoPickOverlay) _geoPickOverlay.style.display='none';
}
function toggleGeoPick(){
  if(!_spSatellite){ return; }
  if(_geoPick){ exitGeoPick(); showSatHint(false); return; }
  if(_tracing) exitTrace();                                   // don't run both picker modes at once
  var sel=selN && E.findNode(selN);
  if(!sel || sel.type!=='t1'){ showSatHint(true, 'Select a building first, then click Place and tap its spot on the map.'); return; }
  if(!_spOrigin){ showSatHint(true); return; }
  _geoPick=true; _geoPickId=sel.id;                          // capture the building now (don't depend on selN surviving)
  var pb=document.getElementById('ngGeoPlaceBtn'); if(pb) pb.classList.add('ng-on');
  ensureGeoPickOverlay().style.display='block';
  showSatHint(true, 'Click the map to place “'+(sel.label||'building')+'”.');
}

// ── Building polygons (Phase 1): trace a footprint on the basemap ────────
// Same coordinate pipeline as the map-picker (pickLatLngFromEvent) + the
// renderer, so a traced corner lands exactly where clicked at any zoom. Stores
// lat/lng vertices on n.polygon; renders as a geo-anchored SVG <polygon>.
function _geoOriginNow(){
  var sameJob=_spOriginJob===E.job();
  return {
    o:(_spOrigin && sameJob)?_spOrigin:jobOrigin(),
    og:(_spOriginGraph && sameJob)?_spOriginGraph:siteplanCentroid()
  };
}
function renderPolygons(){
  if(!canvasEl) return;
  if(!_polyLayer){
    _polyLayer=document.createElementNS(_SVGNS,'svg');
    _polyLayer.setAttribute('class','ng-polygon-layer');
    // Polygon-as-node: a traced building polygon IS the interactive node (its card is
    // demoted to a click-through shell), so these handlers own select + drill-in for
    // traced buildings. mousedown→select (stop the canvas pan/deselect); dblclick→
    // drill in via the same _spFocus path the card uses.
    _polyLayer.addEventListener('mousedown',function(e){
      if(_tracing) return;
      var pe=e.target.closest('[data-id]'); if(!pe) return;
      e.stopPropagation();
      var id=pe.getAttribute('data-id');
      if(selN!==id){ selN=id; render(); }
    });
    _polyLayer.addEventListener('dblclick',function(e){
      if(_tracing) return;
      var pe=e.target.closest('[data-id]'); if(!pe) return;
      e.stopPropagation(); e.preventDefault();
      var id=pe.getAttribute('data-id');
      _spFocus=(id && id!==_spFocus) ? id : null; applySpFocus(); if(_spFocus) fanFocusNodes(_spFocus); fitSiteplan();
    });
  }
  if(_polyLayer.parentNode!==canvasEl) canvasEl.insertBefore(_polyLayer, canvasEl.firstChild); // behind nodes; re-attach if renderNodes cleared the canvas
  while(_polyLayer.firstChild) _polyLayer.removeChild(_polyLayer.firstChild);
  var sitePlan=E.viewMode && E.viewMode()==='siteplan';
  if(!(sitePlan && _spSatellite)){ _polyLayer.style.display='none'; return; }
  _polyLayer.style.display='block';   // NOT '' — the CSS default is display:none, so '' would leave it hidden
  var or=_geoOriginNow(), o=or.o, og=or.og;
  if(!o || !og) return;
  function gp(v){ var g=E.spLatLngToGraph(Number(v.lat), Number(v.lng), o.lat, o.lng); return { x:og.x+g.x, y:og.y+g.y }; }
  var _connP = selN ? getConnectedIds(selN) : {};
  E.nodes().forEach(function(n){
    if(n.type!=='t1' || !n.polygon || n.polygon.length<3) return;
    var pts=n.polygon.map(function(v){ return gp(v); });
    var poly=document.createElementNS(_SVGNS,'polygon');
    poly.setAttribute('points', pts.map(function(p){ return p.x+','+p.y; }).join(' '));
    poly.setAttribute('class','ng-poly'+(selN===n.id?' ng-sel':'')+(_connP[n.id]?' ng-connected':''));
    poly.setAttribute('data-id', n.id);
    _polyLayer.appendChild(poly);
    // The building reads as its polygon: label + % complete drawn at the centroid.
    var cx=0, cy=0; pts.forEach(function(p){ cx+=p.x; cy+=p.y; }); cx/=pts.length; cy/=pts.length;
    var lbl=document.createElementNS(_SVGNS,'text');
    lbl.setAttribute('x', cx); lbl.setAttribute('y', cy-3); lbl.setAttribute('class','ng-poly-label');
    lbl.textContent=n.label||'Building';
    _polyLayer.appendChild(lbl);
    var kpi=document.createElementNS(_SVGNS,'text');
    kpi.setAttribute('x', cx); kpi.setAttribute('y', cy+7); kpi.setAttribute('class','ng-poly-kpi');
    kpi.textContent=Math.round(n.pctComplete||0)+'% complete';
    _polyLayer.appendChild(kpi);
  });
  if(_tracing && _tracePts.length){
    var pstr=_tracePts.map(function(v){ var p=gp(v); return p.x+','+p.y; }).join(' ');
    if(_tracePts.length>=3){
      // ≥3 corners → show the forming footprint as a filled, highlighted polygon
      // (closes back to the first corner) so it reads as the building taking shape.
      var pg=document.createElementNS(_SVGNS,'polygon');
      pg.setAttribute('points', pstr);
      pg.setAttribute('class','ng-poly-preview-fill');
      _polyLayer.appendChild(pg);
    } else if(_tracePts.length===2){
      var pl=document.createElementNS(_SVGNS,'polyline');
      pl.setAttribute('points', pstr);
      pl.setAttribute('class','ng-poly-preview');
      _polyLayer.appendChild(pl);
    }
    _tracePts.forEach(function(v,i){
      var p=gp(v), c=document.createElementNS(_SVGNS,'circle');
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 3);
      c.setAttribute('class','ng-poly-vert'+(i===0?' ng-poly-vert0':''));
      _polyLayer.appendChild(c);
    });
  }
}
function ensureTraceOverlay(){
  if(_traceOverlay) return _traceOverlay;
  _traceOverlay=document.createElement('div');
  _traceOverlay.className='ng-geopick-overlay';                  // reuse the crosshair overlay styling
  _traceOverlay.addEventListener('mousedown',function(e){ e.stopPropagation(); });
  _traceOverlay.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
  _traceOverlay.addEventListener('mouseup',function(e){ e.stopPropagation(); });
  _traceOverlay.addEventListener('click',function(e){
    if(!_tracing || !_spOrigin || !_spOriginGraph) return;
    _tracePts.push(pickLatLngFromEvent(e));                     // add the corner NOW + draw it immediately
    renderPolygons();
  });
  _traceOverlay.addEventListener('dblclick',function(e){
    if(!_tracing) return;
    e.preventDefault();
    // A dblclick fires as click + click + dblclick, so two near-identical corners
    // were just pushed at the finish spot — drop the duplicate, then close the ring.
    if(_tracePts.length>=2) _tracePts.pop();
    finishTrace();
  });
  wrap.appendChild(_traceOverlay);
  return _traceOverlay;
}
function exitTrace(){
  _tracing=false; _traceId=null; _tracePts=[];
  if(_traceClickTimer){ clearTimeout(_traceClickTimer); _traceClickTimer=null; }
  var tb=document.getElementById('ngTraceBtn'); if(tb) tb.classList.remove('ng-on');
  if(_traceOverlay) _traceOverlay.style.display='none';
}
function finishTrace(){
  var pts=_tracePts.slice(), id=_traceId;
  exitTrace();
  if(pts.length<3 || !E.setNodePolygon){
    showSatHint(true, 'Need at least 3 corners — Trace again.');
    renderPolygons();
    return;
  }
  // Footprint centroid → the building's geo anchor (block/label/wires sit on it).
  var clat=0, clng=0; pts.forEach(function(v){ clat+=v.lat; clng+=v.lng; }); clat/=pts.length; clng/=pts.length;
  if(!id){
    // Trace-to-create: the drawn footprint IS a new building node, auto-wired to WIP.
    var or=_geoOriginNow(), gx=0, gy=0;
    if(or && or.o && or.og){ var g=E.spLatLngToGraph(clat, clng, or.o.lat, or.o.lng); gx=or.og.x+g.x; gy=or.og.y+g.y; }
    var cnt=E.nodes().filter(function(x){ return x.type==='t1'; }).length;
    var nn=E.addNode('t1', Math.round(gx), Math.round(gy), 'B'+(cnt+1));
    if(!nn){ showSatHint(true, 'Could not create the building — try again.'); renderPolygons(); return; }
    id=nn.id;
    var wip=E.nodes().find(function(x){ return x.type==='wip'; });
    if(wip) E.wires().push({ fromNode:nn.id, fromPort:0, toNode:wip.id, toPort:0 }); // auto-connect to the WIP hub
    selN=nn.id;
  }
  E.setNodePolygon(id, pts);
  if(E.setNodeGeo) E.setNodeGeo(id, clat, clng);
  if(E.saveGraph) E.saveGraph();
  showSatHint(false);
  render();
}
function toggleTraceMode(){
  if(!_spSatellite) return;
  if(_tracing){ exitTrace(); showSatHint(false); renderPolygons(); return; }
  if(_geoPick) exitGeoPick();                                   // don't run both picker modes at once
  // A selected building → re-trace its footprint; otherwise draw a NEW building.
  var sel=selN && E.findNode(selN);
  var existing=(sel && sel.type==='t1') ? sel : null;
  _spOrigin=_spOrigin||jobOrigin(); _spOriginGraph=_spOriginGraph||siteplanCentroid();
  if(!_spOrigin){ showSatHint(true); return; }
  _tracing=true; _traceId=existing?existing.id:null; _tracePts=[];
  var tb=document.getElementById('ngTraceBtn'); if(tb) tb.classList.add('ng-on');
  ensureTraceOverlay().style.display='block';
  showSatHint(true, existing
    ? ('Re-trace “'+(existing.label||'building')+'” — click each corner, double-click to finish.')
    : 'Draw the new building — click each corner of its roof, double-click to finish.');
}

// ── Photo-GPS pins (Slice 4) ───────────────────────────────────────────
// Plot the job's geotagged field photos on the imagery as thumbnail pins. Pins
// live in a screen-space overlay (repositioned every applyTx); read-only.
function photoScreenPos(ph){
  var g=E.spLatLngToGraph(Number(ph.lat), Number(ph.lng), _spOrigin.lat, _spOrigin.lng);
  var z=E.zm(), p=E.pan();
  return { x:(p.x + _spOriginGraph.x + g.x)*z, y:(p.y + _spOriginGraph.y + g.y)*z };
}
function ensurePhotoPinsLayer(){
  if(_photoPinsEl) return _photoPinsEl;
  _photoPinsEl=document.createElement('div');
  _photoPinsEl.className='ng-photopins';
  wrap.appendChild(_photoPinsEl);
  return _photoPinsEl;
}
function layoutPhotoPins(){
  if(!_photoPinsEl || !_spPhotos || !_spOrigin || !_spOriginGraph) return;
  if(!_spSatellite || (E.viewMode && E.viewMode()!=='siteplan')) return;
  var pins=_photoPinsEl.children;
  for(var i=0;i<pins.length && i<_geoPhotos.length;i++){
    var s=photoScreenPos(_geoPhotos[i]);
    pins[i].style.left=s.x+'px'; pins[i].style.top=s.y+'px';
  }
}
function renderPhotoPins(){
  var layer=ensurePhotoPinsLayer();
  layer.innerHTML='';
  _geoPhotos.forEach(function(ph, idx){
    var pin=document.createElement('div');
    pin.className='ng-photopin';
    pin.title=ph.filename||'Photo';
    if(ph.thumb_url){ var im=document.createElement('img'); im.src=ph.thumb_url; im.alt=''; im.loading='lazy'; pin.appendChild(im); }
    pin.addEventListener('click', function(e){
      e.stopPropagation();
      if(window.p86Attachments && window.p86Attachments.openLightbox) window.p86Attachments.openLightbox(_geoPhotos, idx);
    });
    var tbtn=document.createElement('button');                       // Slice 5: create a task from this photo
    tbtn.className='ng-photopin-task'; tbtn.type='button'; tbtn.textContent='+'; tbtn.title='Create a task from this photo';
    tbtn.addEventListener('click', function(e){ e.stopPropagation(); createTaskFromPhoto(ph); });
    pin.appendChild(tbtn);
    layer.appendChild(pin);
  });
  layoutPhotoPins();
}
function loadGeoPhotos(cb){
  var jid=E.job();
  if(!jid || typeof p86Api==='undefined' || !p86Api.attachments){ _geoPhotos=[]; if(cb)cb(); return; }
  if(_geoPhotosJob===jid){ if(cb)cb(); return; } // cached per job (incl. confirmed-empty)
  p86Api.attachments.list('job', jid).then(function(resp){
    var rows=(resp && resp.attachments) || []; var ok=[], noGps=0; // endpoint returns an {attachments:[…]} envelope
    rows.forEach(function(a){
      if(!(a.mime_type && a.mime_type.indexOf('image/')===0)) return;
      var lat=Number(a.lat), lng=Number(a.lng);
      if(isFinite(lat)&&isFinite(lng)&&!(lat===0&&lng===0)&&lat>=-90&&lat<=90&&lng>=-180&&lng<=180) ok.push(a);
      else noGps++;
    });
    _geoPhotos=ok; _geoPhotosNoGps=noGps; _geoPhotosJob=jid;
    if(cb)cb();
  }).catch(function(){ _geoPhotos=[]; if(cb)cb(); });
}
function updatePhotoLayer(){
  var show=_spPhotos && _spSatellite && E.viewMode && E.viewMode()==='siteplan';
  if(!show){ if(_photoPinsEl) _photoPinsEl.style.display='none'; return; }
  if(_spOriginJob!==E.job()){ _spOrigin=jobOrigin(); _spOriginGraph=siteplanCentroid(); _spOriginJob=E.job(); } // recompute for the current job
  if(!_spOrigin){ showSatHint(true); return; }
  if(_photoPinsEl) _photoPinsEl.style.display='block';
  loadGeoPhotos(function(){
    renderPhotoPins();
    if(_geoPhotosNoGps) showSatHint(true, _geoPhotosNoGps+' photo'+(_geoPhotosNoGps===1?'':'s')+' have no GPS and aren’t shown.');
  });
}
// Slice 5: create an org task FROM a geotagged photo. The task is linked to the
// job and its notes capture the photo + its real location, so the field photo on
// the map turns into an action item in one tap. Uses the well-tested tasks.create
// path only — no server/DB change. (Attaching the photo FILE to the task is a
// verified follow-up: it needs the attachments CHECK constraint + the copy
// endpoint's allowlist/geo-preservation + a writeCapForEntity('task') case.)
function createTaskFromPhoto(ph){
  var jid=E.job();
  if(!jid || typeof p86Api==='undefined' || !p86Api.tasks){ showSatHint(true, 'Open a job to create tasks.'); return; }
  var base=(ph.filename||'field photo').replace(/\.[a-z0-9]+$/i,'');
  var def='Follow up: '+base;
  var title = (typeof window.prompt==='function') ? window.prompt('New task from this photo:', def) : def;
  if(title===null) return;                                          // cancelled
  title=(title||'').trim()||def;
  var lat=Number(ph.lat), lng=Number(ph.lng);
  var loc=(isFinite(lat)&&isFinite(lng)) ? (' at '+lat.toFixed(5)+', '+lng.toFixed(5)) : '';
  var notes='Created from a geotagged field photo'+loc+'.'+(ph.thumb_url?('\nPhoto: '+ph.thumb_url):'');
  p86Api.tasks.create({ title:title, notes:notes, entity_type:'job', entity_id:jid })
    .then(function(){ showSatHint(true, '✓ Task created: '+title); })
    .catch(function(e){ showSatHint(true, 'Could not create task: '+((e&&e.message)||'error')); });
}

function focusNode(n, opts){
  if(!wrap) return;
  opts = opts || {};
  if (typeof opts.zoom === 'number' && isFinite(opts.zoom)) {
    var nz = Math.max(0.2, Math.min(3, opts.zoom));
    E.zm(nz);
  }
  var z=E.zm();
  // Measure the actual rendered node size — offsetWidth/offsetHeight
  // are pre-transform, exactly what we want to compute the offset
  // in graph coords.
  var ox = 85, oy = 30; // fallback to the old defaults if DOM not ready
  var domNode = canvasEl && canvasEl.querySelector('[data-id="' + n.id + '"]');
  if (domNode && domNode.offsetWidth) {
    ox = domNode.offsetWidth / 2;
    oy = domNode.offsetHeight / 2;
  }
  var cx = wrap.clientWidth / (2 * z) - n.x - ox;
  var cy = wrap.clientHeight / (2 * z) - n.y - oy;
  E.pan(cx, cy);
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
  // The app toggles modals via the .active CLASS (openModal/closeModal), NOT inline
  // style.display — so detect the real OPEN→CLOSE transition on class changes. fn()
  // opens synchronously, so seed wasOpen from the current (already-open) state; the
  // callback then fires once .active is removed (Save or Cancel), diffing for the
  // new entry. (The old style.display check fired immediately on open → cb(null).)
  var wasOpen=modalEl.classList.contains('active');
  var obs=new MutationObserver(function(){
    if(modalEl.classList.contains('active')){ wasOpen=true; return; }
    if(!wasOpen) return;
    obs.disconnect();
    var newOnes=getJobEntries(type).filter(function(e){ return !before[e.id]; });
    cb(newOnes[0]||null);
  });
  obs.observe(modalEl, {attributes:true, attributeFilter:['class']});
}

// ── Sidebar ──
function buildSidebar(){
  var sb=document.querySelector('.ng-sidebar'); if(!sb) return;
  var html='<div class="ng-sidebar-header">' +
    '<span class="ng-sidebar-header-text">Node Library</span>' +
    '<button class="ng-sidebar-toggle" id="ngSidebarToggle" title="Collapse library">◀</button>' +
    '</div>';
  // Site Plan rework: live WIP-metrics panel (shown only in satellite Site Plan via
  // CSS). Body is filled by renderSidebarMetrics() on every render; chips inside are
  // click-to-edit (same data-wip-edit path as the old WIP card).
  html+='<div class="ng-sp-metrics"><div class="ng-sp-metrics-head">Project WIP</div><div class="ng-sp-metrics-body"></div></div>';
  // Per-building cost panel (S2) — shown when a building polygon is selected.
  html+='<div class="ng-sp-bldg"><div class="ng-sp-metrics-head">Building · <span class="ng-sp-bldg-name"></span></div><div class="ng-sp-bldg-body"></div><button class="ng-sp-addcost">+ Add Cost</button></div>';
  html+='<div class="ng-sidebar-search"><input type="text" placeholder="Search..." id="ngSearch"/></div>';
  E.CATS.forEach(function(cat,ci){
    var isWipCat=(cat.items||[]).indexOf('wip')>-1;   // hidden in satellite (the WIP node lives in the sidebar there)
    html+='<div class="ng-cat ng-open'+(isWipCat?' ng-cat-wip':'')+'">';
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

  // The sidebar's CSS `width` is animated; canvas pixel buffers don't
  // grow/shrink on their own, so the wire + grid layers clip on the
  // right when the sidebar collapses. After the transition lands,
  // re-size the canvases and redraw so they fill the new flex area.
  sb.addEventListener('transitionend', function(e) {
    if (e.propertyName !== 'width') return;
    if (typeof resize === 'function') resize();
    if (typeof E !== 'undefined' && E.drawGrid && gridCtx && gridC) {
      E.drawGrid(gridCtx, gridC.width, gridC.height);
    }
    if (typeof E !== 'undefined' && E.drawWires && wireCtx && wrap) {
      E.drawWires(wireCtx, wrap, null, null);
    }
  });

  sb.addEventListener('click',function(e){
    // WIP-metrics chip → inline-edit the job financial field (mirrors the card path).
    var wchip=e.target.closest('[data-wip-edit]');
    if(wchip && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); wipChipEdit(wchip); return; }
    // S4: "+ Add Cost" on the selected-building panel → cost-type picker wired to it.
    var addc=e.target.closest('.ng-sp-addcost');
    if(addc){ e.preventDefault(); e.stopPropagation(); var sn=selN&&E.findNode(selN); if(sn&&sn.type==='t1'){ var br=addc.getBoundingClientRect(); addCostToBuilding(sn.id, br.left, br.bottom+4); } return; }
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
      // In satellite Site Plan, the Building (t1) item INITIATES a footprint trace
      // (trace-to-create) rather than dropping an abstract card — the polygon you
      // draw becomes the new building node.
      if(type==='t1' && _spSatellite && E.viewMode && E.viewMode()==='siteplan'){
        selN=null; toggleTraceMode(); return;
      }
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

// Inline-edit a WIP job-financial chip (Contract Amount, CO Income, …). Shared by
// the canvas WIP card and the sidebar metrics panel so both behave identically.
function wipChipEdit(wc){
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
}

// Site Plan rework: fill the sidebar WIP-metrics panel from the (still-alive) wip
// node — same jobField chips + 8-KPI Overview grid as the old card, identical math
// via E.getOutput. Called every render(); the panel is shown only in satellite via
// CSS, so this is a cheap no-op repaint otherwise.
function renderSidebarMetrics(){
  var body=document.querySelector('.ng-sp-metrics-body'); if(!body) return;
  if(!(_spSatellite && E.viewMode && E.viewMode()==='siteplan')) return; // panel hidden off-satellite — skip the work
  var wn=E.nodes().find(function(n){return n.type==='wip';});
  if(!wn){ body.innerHTML='<div class="ng-sp-metrics-empty">No WIP data</div>'; return; }
  if(editingId===wn.id && body.querySelector('input')) return; // mid-edit in this panel: don't clobber the focused input
  var jf=wn.jobFields||{};
  var wipComputedPct=E.getWIPWeightedPct(wn);
  var h='<div class="ng-subitems" style="max-height:none;">';
  [{k:'contractAmount',l:'Contract Amount',t:'c'},{k:'coIncome',l:'CO Income',t:'c'},{k:'estimatedCosts',l:'Est. Costs',t:'c'},{k:'coCosts',l:'CO Costs',t:'c'},{k:'revisedCostChanges',l:'Revised Changes',t:'c'},{k:'invoicedToDate',l:'Invoiced to Date',t:'c'},{k:'pctComplete',l:'% Complete',t:'p'}].forEach(function(r){
    var raw=jf[r.k]||0;
    if(r.k==='pctComplete' && wipComputedPct!=null){
      h+='<div class="ng-subitem ng-wip-row"><span class="ng-wip-lbl">'+r.l+'</span><span class="ng-wip-chip" title="Averaged from connected phases/buildings/COs" style="cursor:default;opacity:0.85;">'+wipComputedPct.toFixed(1)+'% avg</span></div>';
    } else {
      var disp=r.t==='p'?raw.toFixed(1)+'%':E.fmtC(raw);
      h+='<div class="ng-subitem ng-wip-row"><span class="ng-wip-lbl">'+r.l+'</span><span class="ng-wip-chip" data-wip-edit="'+wn.id+'" data-wip-key="'+r.k+'" data-wip-type="'+r.t+'" title="Click to edit">'+disp+'</span></div>';
    }
  });
  h+='</div>';
  var wipD=E.DEFS.wip;
  h+='<div class="ng-ov-head">Overview</div><div class="ng-wip-ov">';
  wipD.outs.forEach(function(op,oi){
    var ov=E.getOutput(wn,oi);
    var fmt=op.t===E.PT.P?E.fmtP(ov):E.fmtC(ov);
    var vc=ov>0?'ng-ov-pos':ov<0?'ng-ov-neg':'ng-ov-zero';
    var hero=(op.n==='Total Income'||op.n==='Gross Profit')?' ng-ov-hero':'';
    h+='<div class="ng-wip-ov-kpi'+hero+'"><span class="ng-ov-lbl">'+op.n+'</span><span class="ng-ov-val '+vc+'">'+fmt+'</span></div>';
  });
  h+='</div>';
  body.innerHTML=h;
}

// S2: per-building cost panel. Shown only when a building polygon is selected in
// satellite Site Plan; reuses the same KPI tiles + engine helpers the building card
// body uses, so the numbers match. display:'block' (not '') — CSS default is none.
function renderBuildingMetrics(){
  var panel=document.querySelector('.ng-sp-bldg'); if(!panel) return;
  var on=_spSatellite && E.viewMode && E.viewMode()==='siteplan';
  var sel=(on && selN) ? E.findNode(selN) : null;
  if(!sel || sel.type!=='t1'){ panel.style.display='none'; return; }
  panel.style.display='block';
  var nameEl=panel.querySelector('.ng-sp-bldg-name'); if(nameEl) nameEl.textContent=sel.label||'Building';
  var bRev=E.getBuildingAllocatedRevenue(sel);
  var pct=E.getT1WeightedPct(sel);
  var revEarned=bRev*(pct/100);
  var act=E.getActual(sel), acc=E.getAccrued(sel);
  var gp=revEarned-(act+acc);
  var margin=bRev>0?(gp/bRev*100):0;
  var rows=[
    {l:'% Complete', v:pct.toFixed(1)+'%', c:pct>0?'ng-ov-pos':'ng-ov-zero', hero:true},
    {l:'Revenue', v:E.fmtC(bRev), c:bRev>0?'ng-ov-pos':'ng-ov-zero'},
    {l:'Rev. Earned', v:E.fmtC(revEarned), c:revEarned>0?'ng-ov-pos':'ng-ov-zero'},
    {l:'Actual Cost', v:E.fmtC(act), c:act>0?'ng-ov-neg':'ng-ov-zero'},
    {l:'Accrued', v:E.fmtC(acc), c:acc>0?'ng-ov-neg':'ng-ov-zero'},
    {l:'Gross Profit', v:E.fmtC(gp), c:gp>0?'ng-ov-pos':gp<0?'ng-ov-neg':'ng-ov-zero', hero:true},
    {l:'Margin', v:margin.toFixed(1)+'%', c:margin>0?'ng-ov-pos':margin<0?'ng-ov-neg':'ng-ov-zero'},
    {l:'Budget', v:E.fmtC(sel.budget||0), c:'ng-ov-zero'}
  ];
  var h='<div class="ng-wip-ov">';
  rows.forEach(function(r){
    h+='<div class="ng-wip-ov-kpi'+(r.hero?' ng-ov-hero':'')+'"><span class="ng-ov-lbl">'+r.l+'</span><span class="ng-ov-val '+r.c+'">'+r.v+'</span></div>';
  });
  h+='</div>';
  var bodyEl=panel.querySelector('.ng-sp-bldg-body'); if(bodyEl) bodyEl.innerHTML=h;
}

// S4: "+ Add Cost" on a selected building — a small cost-type picker that creates the
// node near the building and wires it into the building's Costs input. Reuses the
// module-level data picker so a Sub/PO/Phase can be chosen from the directory.
function addCostToBuilding(bId, clientX, clientY){
  var b=E.findNode(bId); if(!b) return;
  var existing=document.querySelector('.ng-add-menu.ng-addcost'); if(existing) existing.remove();
  var menu=document.createElement('div'); menu.className='ng-add-menu ng-addcost';
  var h='<div class="ng-add-cat">Add to '+(b.label||'building')+'</div>';
  ['t2','sub','po','mat','labor'].forEach(function(t){ var d=E.DEFS[t]; if(d) h+='<div class="ng-add-item" data-type="'+t+'"><span class="ng-add-ic">'+d.icon+'</span>'+(d.label||t)+'</div>'; });
  menu.innerHTML=h;
  document.body.appendChild(menu);
  menu.style.left=Math.max(8,Math.min(clientX, window.innerWidth-248))+'px';
  menu.style.top=Math.max(8,Math.min(clientY, window.innerHeight-300))+'px';
  function close(){ if(menu){ menu.remove(); menu=null; document.removeEventListener('mousedown', outside, true); } }
  function outside(ev){ if(menu && !menu.contains(ev.target)) close(); }
  setTimeout(function(){ document.addEventListener('mousedown', outside, true); }, 0);
  menu.addEventListener('click',function(ev){
    var it=ev.target.closest('.ng-add-item'); if(!it) return;
    var type=it.getAttribute('data-type'); close();
    var center=(b.geoLatLng)?geoRenderPos(b):{x:b.x, y:b.y};
    var _satAdd=!!_spSatellite && E.viewMode && E.viewMode()==='siteplan';
    var px=Math.round(center.x), py=Math.round(center.y-(_satAdd?40:220)); // sit it just above the building (scaled on satellite)
    function wireToBuilding(nn){
      if(!nn) return;
      var toPort=E.firstCompatPort(E.DEFS[b.type], nn.type, 'in');
      E.wires().push({ fromNode:nn.id, fromPort:0, toNode:b.id, toPort:toPort||0 });
      delete _fannedSet[bId];                                   // re-fan to include the new cost
      if(_spFocus===bId){ applySpFocus(); fanFocusNodes(bId); } // already drilled in → place it now
      selN=nn.id; if(E.saveGraph) E.saveGraph(); render();
    }
    if(PICKABLE_TYPES[type] && E.job()){
      showDataPicker(type, function(entry, focused){
        if(focused) return;
        if(entry){ var nn=E.addNode(type, px, py, entryLabel(type,entry), entry); if(nn){ autoWireFromData(nn, entry); wireToBuilding(nn); } }
        else openEntityCreateModal(type, function(ne){ if(ne){ var n2=E.addNode(type, px, py, entryLabel(type,ne), ne); if(n2){ autoWireFromData(n2, ne); wireToBuilding(n2); } } });
      });
    } else {
      var d=E.DEFS[type], label=d.label;
      if(d.nameEdit){ label=prompt('Name for this '+(d.label||type)+':', label)||label; }
      wireToBuilding(E.addNode(type, px, py, label));
    }
  });
}

// ── Events ──
function initEvents(){
  var SN=E.SNAP, z=function(){return E.zm();};

  wrap.addEventListener('mousedown',function(e){
    if(_geoPick) return; // map-picker active: the overlay handles the placement click
    if(e.target.closest('.ng-p')||e.target.closest('.ng-node')) return;
    // NG8: frame interactions (delete handled on click; drag/resize start here)
    if(e.target.closest('[data-frame-del]')){ e.stopPropagation(); return; }
    var _fr=e.target.closest('[data-frame-resize]');
    if(_fr){ e.stopPropagation(); resizeFrame=_fr.getAttribute('data-frame-resize'); var rf=E.findFrame(resizeFrame);
      if(rf){ resizeStart={mx:e.clientX/z(), my:e.clientY/z(), w:rf.w, h:rf.h}; selFrame=resizeFrame; renderFrames(); } return; }
    var _fd=e.target.closest('[data-frame-drag]');
    if(_fd){ e.stopPropagation(); dragFrame=_fd.getAttribute('data-frame-drag'); var df=E.findFrame(dragFrame);
      if(df){ var dp=E.pan(); frameDragOff={x:e.clientX/z()-dp.x-df.x, y:e.clientY/z()-dp.y-df.y};
        frameMembers=ngFrameMembers(df).map(function(mn){return {id:mn.id, ox:mn.x-df.x, oy:mn.y-df.y};});
        selFrame=dragFrame; if(selN) selN=null; renderFrames(); } return; }
    // Empty-canvas click cancels any pending note-attach.
    if(attachingFromNoteId){ attachingFromNoteId=null; render(); }
    if(selFrame){ selFrame=null; renderFrames(); }
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
    if(dragFrame){
      var f=E.findFrame(dragFrame); if(f){
        var p=E.pan();
        f.x=Math.round((e.clientX/z()-p.x-frameDragOff.x)/SN)*SN;
        f.y=Math.round((e.clientY/z()-p.y-frameDragOff.y)/SN)*SN;
        var fel=canvasEl.querySelector('.ng-frame[data-frame="'+f.id+'"]');
        if(fel){ fel.style.left=f.x+'px'; fel.style.top=f.y+'px'; }
        (frameMembers||[]).forEach(function(m){
          var mn=E.findNode(m.id); if(!mn) return;
          mn.x=f.x+m.ox; mn.y=f.y+m.oy;
          var mel=canvasEl.querySelector('.ng-node[data-id="'+mn.id+'"]');
          if(mel){ mel.style.left=mn.x+'px'; mel.style.top=mn.y+'px'; }
        });
        E.drawWires(wireCtx,wrap,wiringFrom,wireMouse);
      }
      return;
    }
    if(resizeFrame){
      var rf2=E.findFrame(resizeFrame); if(rf2 && resizeStart){
        rf2.w=Math.max(160, Math.round((resizeStart.w + (e.clientX/z()-resizeStart.mx))/SN)*SN);
        rf2.h=Math.max(100, Math.round((resizeStart.h + (e.clientY/z()-resizeStart.my))/SN)*SN);
        var rel=canvasEl.querySelector('.ng-frame[data-frame="'+rf2.id+'"]');
        if(rel){ rel.style.width=rf2.w+'px'; rel.style.height=rf2.h+'px'; }
      }
      return;
    }
    // NG3: when idle, show the floating "+" over a hovered output port or wire.
    if(!isPan && !dragN && !wiringFrom) updateAddFab(e);
  });

  // ── NG8: frame delete (click ×) + rename (double-click the label) ──
  canvasEl.addEventListener('click',function(e){
    var del=e.target.closest('[data-frame-del]'); if(!del) return;
    e.stopPropagation();
    var fid=del.getAttribute('data-frame-del');
    var go=(typeof window.agxConfirm==='function')
      ? window.agxConfirm({title:'Delete frame', message:'Remove this group box? The nodes inside are kept.', confirmLabel:'Delete', danger:true})
      : Promise.resolve(window.confirm('Delete this frame? (Nodes inside are kept.)'));
    go.then(function(ok){ if(!ok) return; E.removeFrame(fid); if(selFrame===fid) selFrame=null; render(); E.saveGraph(); });
  });
  canvasEl.addEventListener('dblclick',function(e){
    var lbl=e.target.closest('[data-frame-rename]'); if(!lbl) return;
    e.stopPropagation();
    var f=E.findFrame(lbl.getAttribute('data-frame-rename')); if(!f) return;
    var nv=prompt('Frame name:', f.label||'Group');
    if(nv!=null){ f.label=nv.trim()||'Group'; render(); E.saveGraph(); }
  });

  // ── NG3: floating "+" add-node affordance (port-hover + wire-hover) ──
  var addFabEl=null, addFabArm=null, addMenuEl=null, addFabHideTimer=null;
  function ensureAddFab(){
    if(addFabEl) return addFabEl;
    addFabEl=document.createElement('div');
    addFabEl.className='ng-add-fab'; addFabEl.textContent='+';
    addFabEl.title='Add a node here';
    addFabEl.addEventListener('mouseenter',function(){ clearTimeout(addFabHideTimer); });
    addFabEl.addEventListener('mousedown',function(ev){ ev.stopPropagation(); });
    addFabEl.addEventListener('click',function(ev){
      ev.stopPropagation();
      if(!addFabArm) return;
      var r=addFabEl.getBoundingClientRect();
      openAddMenu(r.left, r.bottom+4, onAddPick);
    });
    wrap.appendChild(addFabEl);
    return addFabEl;
  }
  function showAddFabAt(sx, sy){ ensureAddFab(); clearTimeout(addFabHideTimer); addFabEl.style.display='flex'; addFabEl.style.left=sx+'px'; addFabEl.style.top=sy+'px'; }
  function hideAddFab(){ clearTimeout(addFabHideTimer); addFabHideTimer=setTimeout(function(){ if(addFabEl) addFabEl.style.display='none'; addFabArm=null; },150); }
  function bez(p1,c1,c2,p2,t){ var u=1-t; return { x:u*u*u*p1.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*p2.x, y:u*u*u*p1.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*p2.y }; }
  function wireHitTest(gx,gy){
    var best=null, bestD=14/z();
    E.wires().forEach(function(w){
      var p1=E.portPos(w.fromNode,w.fromPort,'out'), p2=E.portPos(w.toNode,w.toPort,'in');
      var dx=Math.max(Math.abs(p2.x-p1.x)*0.4,50), c1={x:p1.x+dx,y:p1.y}, c2={x:p2.x-dx,y:p2.y};
      for(var t=0;t<=1.0001;t+=0.08){ var pt=bez(p1,c1,c2,p2,t); var d=Math.hypot(pt.x-gx,pt.y-gy); if(d<bestD){ bestD=d; best={w:w, mid:bez(p1,c1,c2,p2,0.5)}; } }
    });
    return best;
  }
  function updateAddFab(e){
    if(addMenuEl) return;                                   // menu open — leave fab
    if(addFabEl && (e.target===addFabEl)) return;           // hovering the fab itself
    var p=E.pan(), zz=z();
    var outPort=e.target.closest && e.target.closest('[data-dir="out"]');
    if(outPort){
      var nid=outPort.getAttribute('data-node'), pi=parseInt(outPort.getAttribute('data-pi'));
      var pp=E.portPos(nid,pi,'out');
      showAddFabAt((pp.x+p.x)*zz+15, (pp.y+p.y)*zz-9);
      addFabArm={kind:'port', nid:nid, pi:pi};
      return;
    }
    var r=wrap.getBoundingClientRect();
    var hit=wireHitTest((e.clientX-r.left)/zz - p.x, (e.clientY-r.top)/zz - p.y);
    if(hit){ showAddFabAt((hit.mid.x+p.x)*zz-11, (hit.mid.y+p.y)*zz-11); addFabArm={kind:'wire', wire:hit.w}; return; }
    hideAddFab();
  }
  function onAddPick(type){
    var arm=addFabArm; hideAddFab();
    if(!arm) return;
    if(arm.kind==='port'){
      var src=E.findNode(arm.nid); if(!src) return;
      var fd=E.DEFS[src.type], fromType=(fd&&fd.outs[arm.pi])?fd.outs[arm.pi].t:E.PT.A;
      spawnNodeAt(type, src.x+260, src.y, function(nn){
        if(!nn) return;
        E.wires().push({fromNode:arm.nid, fromPort:arm.pi, toNode:nn.id, toPort:E.firstCompatPort(E.DEFS[type], fromType, 'in')});
        render();
      });
    } else if(arm.kind==='wire'){
      var w=arm.wire, s=E.findNode(w.fromNode), dt=E.findNode(w.toNode); if(!s||!dt) return;
      var sFromType=(E.DEFS[s.type].outs[w.fromPort]||{}).t||E.PT.A;
      var dInType=(E.DEFS[dt.type].ins[w.toPort]||{}).t||E.PT.A;
      var mp=E.portPos(w.fromNode,w.fromPort,'out'), mp2=E.portPos(w.toNode,w.toPort,'in');
      spawnNodeAt(type, (mp.x+mp2.x)/2-90, (mp.y+mp2.y)/2-20, function(nn){
        if(!nn) return;
        var nd=E.DEFS[type], hasIn=nd.ins&&nd.ins.length, hasOut=nd.outs&&nd.outs.length, ws=E.wires();
        if(hasIn&&hasOut){
          var idx=ws.indexOf(w); if(idx>=0) ws.splice(idx,1);
          ws.push({fromNode:w.fromNode,fromPort:w.fromPort,toNode:nn.id,toPort:E.firstCompatPort(nd,sFromType,'in')});
          ws.push({fromNode:nn.id,fromPort:E.firstCompatPort(nd,dInType,'out'),toNode:w.toNode,toPort:w.toPort});
        } else if(hasIn){
          ws.push({fromNode:w.fromNode,fromPort:w.fromPort,toNode:nn.id,toPort:E.firstCompatPort(nd,sFromType,'in')});
        }
        render();
      });
    }
  }
  // Create a node of `type` at (x,y); data-backed types route through the same
  // picker the sidebar uses. Calls cb(node|null).
  function spawnNodeAt(type, x, y, cb){
    var d=E.DEFS[type]; if(!d){ cb(null); return; }
    if(PICKABLE_TYPES[type] && E.job()){
      showDataPicker(type, function(entry, focused){
        if(focused){ cb(null); return; }
        if(entry){ var nn=E.addNode(type,x,y,entryLabel(type,entry),entry); if(nn) autoWireFromData(nn,entry); cb(nn); }
        else openEntityCreateModal(type, function(ne){ if(ne){ var n2=E.addNode(type,x,y,entryLabel(type,ne),ne); if(n2) autoWireFromData(n2,ne); cb(n2); } else cb(null); });
      });
    } else {
      var label=d.label; if(d.nameEdit){ var pr=prompt('Name:',label); label=pr||label; }
      var nn=E.addNode(type,x,y,label);
      if(nn && (nn.cat==='cost'||nn.cat==='co')) nn.collapsed=true; // NG-R2/SHAPE: cost→round, CO→triangle chip
      cb(nn);
    }
  }
  // Searchable node-type menu anchored at a viewport point.
  function openAddMenu(clientX, clientY, onPick){
    closeAddMenu();
    addMenuEl=document.createElement('div'); addMenuEl.className='ng-add-menu';
    addMenuEl.innerHTML='<input class="ng-add-search" placeholder="Add node…" /><div class="ng-add-list"></div>';
    document.body.appendChild(addMenuEl);
    addMenuEl.style.left=Math.max(8,Math.min(clientX, window.innerWidth-248))+'px';
    addMenuEl.style.top=Math.max(8,Math.min(clientY, window.innerHeight-340))+'px';
    var listEl=addMenuEl.querySelector('.ng-add-list'), inp=addMenuEl.querySelector('.ng-add-search');
    function build(filter){
      var f=(filter||'').toLowerCase(), out='';
      E.CATS.forEach(function(c){
        var items=c.items.filter(function(t){ var d=E.DEFS[t]; return d && ((d.label||t).toLowerCase().indexOf(f)>=0 || c.name.toLowerCase().indexOf(f)>=0); });
        if(!items.length) return;
        out+='<div class="ng-add-cat">'+c.name+'</div>';
        items.forEach(function(t){ var d=E.DEFS[t]; out+='<div class="ng-add-item" data-type="'+t+'"><span class="ng-add-ic">'+d.icon+'</span>'+(d.label||t)+'</div>'; });
      });
      listEl.innerHTML=out||'<div class="ng-add-empty">No matches</div>';
    }
    build('');
    inp.addEventListener('input',function(){ build(inp.value); });
    inp.addEventListener('keydown',function(ev){
      if(ev.key==='Escape'){ closeAddMenu(); }
      else if(ev.key==='Enter'){ var first=listEl.querySelector('.ng-add-item'); if(first){ var t=first.getAttribute('data-type'); closeAddMenu(); onPick(t); } }
    });
    listEl.addEventListener('click',function(ev){ var it=ev.target.closest('.ng-add-item'); if(!it) return; var t=it.getAttribute('data-type'); closeAddMenu(); onPick(t); });
    setTimeout(function(){ try{ inp.focus(); }catch(_){} },0);
    setTimeout(function(){ document.addEventListener('mousedown', outsideAddMenu); },0);
  }
  function outsideAddMenu(ev){ if(addMenuEl && !addMenuEl.contains(ev.target)) closeAddMenu(); }
  function closeAddMenu(){ if(addMenuEl){ addMenuEl.remove(); addMenuEl=null; document.removeEventListener('mousedown', outsideAddMenu); } }

  wrap.addEventListener('mouseup',function(e){
    isPan=false; wrap.classList.remove('ng-panning'); dragN=null;
    if(dragFrame || resizeFrame){ dragFrame=null; resizeFrame=null; frameMembers=null; frameDragOff=null; resizeStart=null; E.saveGraph(); }
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
      wiringFrom=null;wireMouse=null;clearCompatPorts();render();
    }
  });

  // Zoom factor per scroll-wheel tick. Bumped from 1.07/0.93 (~7%)
  // to 1.15/0.87 (~15%) for snappier feel. Anchored at the cursor
  // position so the point under the mouse stays put while the rest
  // scales around it.
  var ZOOM_IN_FACTOR  = 1.15;
  var ZOOM_OUT_FACTOR = 0.87;
  function zoomAt(clientX, clientY, factor){
    var cur = E.zm();
    var nz = Math.max(0.2, Math.min(3, cur * factor));
    if (nz === cur) return;
    var r = wrap.getBoundingClientRect();
    var mx = clientX - r.left, my = clientY - r.top;
    var p = E.pan();
    E.pan(mx/nz - (mx/cur - p.x), my/nz - (my/cur - p.y));
    E.zm(nz);
    applyTx();
    render();
  }

  // Zoom out to fit ALL nodes in the viewport, with padding.
  // Used by Ctrl+right-click as an "overview mode" gesture.
  // Calculates the bounding box of every node, picks a zoom that
  // fits the box inside the viewport (clamped to engine bounds),
  // then pans so the box is centered.
  function zoomFitAll(){
    var ns = E.nodes();
    if (!ns.length) {
      E.zm(0.2);
      applyTx(); render();
      return;
    }
    // Measure each node's true footprint (NG7) so tall data-rich cards and
    // the deep top-down tree fit fully instead of being clipped.
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ns.forEach(function(n){
      var f = ngNodeFootprint(n);
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + f.w > maxX) maxX = n.x + f.w;
      if (n.y + f.h > maxY) maxY = n.y + f.h;
    });
    var bw = maxX - minX, bh = maxY - minY;
    var pad = 80;
    var vw = Math.max(1, wrap.clientWidth - pad * 2);
    var vh = Math.max(1, wrap.clientHeight - pad * 2);
    var fitZ = Math.min(vw / bw, vh / bh);
    fitZ = Math.max(0.2, Math.min(3, fitZ));
    E.zm(fitZ);
    // Center the bounding box in the viewport.
    var bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;
    E.pan(wrap.clientWidth / 2 / fitZ - bcx, wrap.clientHeight / 2 / fitZ - bcy);
    applyTx(); render();
  }
  wrap.addEventListener('wheel',function(e){
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? ZOOM_OUT_FACTOR : ZOOM_IN_FACTOR);
  },{passive:false});

  // ── NG7: zoom control buttons (+ / − / fit) ──
  var zcWrap=wrap.querySelector('.ng-zoomctl');
  if(zcWrap){
    // swallow mousedown so a button press doesn't start a canvas pan
    zcWrap.addEventListener('mousedown',function(e){ e.stopPropagation(); });
    zcWrap.addEventListener('click',function(e){
      var btn=e.target.closest('.ng-zc-btn'); if(!btn) return;
      var act=btn.getAttribute('data-zc');
      var r=wrap.getBoundingClientRect(), cx=r.left+r.width/2, cy=r.top+r.height/2;
      if(act==='in') zoomAt(cx,cy,1.25);
      else if(act==='out') zoomAt(cx,cy,0.8);
      else if(act==='fit') zoomFitAll();
    });
  }

  // ── NG7: minimap navigation (click / drag to recenter the viewport) ──
  var mm=wrap.querySelector('.ng-minimap');
  if(mm){
    var mmDragging=false;
    function mmNavTo(e){
      if(!_ngMmTx) return;
      var r=mm.getBoundingClientRect();
      var gx=(e.clientX-r.left-_ngMmTx.offX)/_ngMmTx.scale;
      var gy=(e.clientY-r.top -_ngMmTx.offY)/_ngMmTx.scale;
      var z=E.zm()||1;
      E.pan(wrap.clientWidth/2/z - gx, wrap.clientHeight/2/z - gy);
      applyTx(); render();
    }
    mm.addEventListener('mousedown',function(e){ e.stopPropagation(); e.preventDefault(); mmDragging=true; mmNavTo(e); });
    window.addEventListener('mousemove',function(e){ if(mmDragging) mmNavTo(e); });
    window.addEventListener('mouseup',function(){ mmDragging=false; });
  }

  // Smart-ports: while dragging a wire, light up compatible input ports and
  // dim incompatible ones (reuses the engine's canConn type rules).
  function markCompatPorts(fromType){
    var tabEl=document.getElementById('nodeGraphTab'); if(tabEl) tabEl.classList.add('ng-wiring');
    canvasEl.querySelectorAll('.ng-p[data-dir="in"]').forEach(function(p){
      if(E.canConn(fromType, p.getAttribute('data-type'))) p.classList.add('ng-p-ok');
      else p.classList.remove('ng-p-ok');
    });
  }
  function clearCompatPorts(){
    var tabEl=document.getElementById('nodeGraphTab'); if(tabEl) tabEl.classList.remove('ng-wiring');
    canvasEl.querySelectorAll('.ng-p.ng-p-ok').forEach(function(p){ p.classList.remove('ng-p-ok'); });
  }
  canvasEl.addEventListener('mousedown',function(e){
    var port=e.target.closest('[data-dir="out"]');
    if(port){
      e.stopPropagation();
      var _pi=parseInt(port.getAttribute('data-pi'));
      var _fn=E.findNode(port.getAttribute('data-node')), _fd=E.DEFS[_fn?_fn.type:''];
      wiringFrom={nid:port.getAttribute('data-node'),pi:_pi};
      markCompatPorts((_fd&&_fd.outs[_pi])?_fd.outs[_pi].t:E.PT.A);
      return;
    }
    var eb=e.target.closest('[data-edit]');
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
    var db=e.target.closest('[data-dup]');
    if(db){e.stopPropagation();duplicateNode(db.getAttribute('data-dup'));return;}
    var xb=e.target.closest('[data-del]');
    if(xb){e.stopPropagation();var xn=E.findNode(xb.getAttribute('data-del'));if(xn) showDeleteDialog(xn);return;}
    var cb=e.target.closest('[data-coll]');
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
      wipChipEdit(wc);     // shared with the sidebar metrics panel
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
    // PO → phase: unlink one phase from a PO. Removes the wire and
    // re-renders so the Linked Phases section + the canvas update.
    var poUnlink = e.target.closest('.ng-po-unlink');
    if(poUnlink){
      e.stopPropagation();
      var fromId = poUnlink.getAttribute('data-from');
      var toId   = poUnlink.getAttribute('data-to');
      var ws = E.wires();
      for(var wi = ws.length - 1; wi >= 0; wi--){
        if(ws[wi].fromNode === fromId && ws[wi].toNode === toId) ws.splice(wi, 1);
      }
      render();
      return;
    }
    // PO → phase: open the "+ Link phase" picker. Shows phases on
    // this job that aren't already linked from this PO.
    var poLinkAdd = e.target.closest('.ng-po-link-add');
    if(poLinkAdd){
      e.preventDefault();
      e.stopPropagation();
      var poId = poLinkAdd.getAttribute('data-po-node');
      var poN  = E.findNode(poId);
      if(!poN) return;
      var alreadyWired = {};
      E.wires().forEach(function(w){
        if(w.fromNode === poId){
          var tgt = E.findNode(w.toNode);
          if(tgt && tgt.type === 't2') alreadyWired[tgt.id] = true;
        }
      });
      var candidates = E.nodes().filter(function(nd){
        return nd.type === 't2' && !alreadyWired[nd.id];
      }).sort(function(a, b){ return (a.label || '').localeCompare(b.label || ''); });
      if(!candidates.length){
        alert('No more phases to link — every phase on this job is already wired from this PO. Drop a new phase onto the graph first if you need to.');
        return;
      }
      // Tiny dropdown picker rendered next to the click target. Lives
      // in document.body so the canvas's transform / overflow:hidden
      // doesn\'t clip it. Position is computed in viewport coords from
      // getBoundingClientRect (already post-transform).
      var prev = document.getElementById('ng-po-link-picker');
      if(prev) prev.remove();
      var pick = document.createElement('div');
      pick.id = 'ng-po-link-picker';
      // Clamp to the viewport so the picker doesn\'t spill off-screen
      // when the user opens it near the right or bottom edge.
      var rect = poLinkAdd.getBoundingClientRect();
      var pickW = 240, pickMaxH = 320;
      var pickLeft = Math.max(8, Math.min(window.innerWidth - pickW - 8, Math.round(rect.left)));
      var pickTop  = Math.round(rect.bottom + 4);
      if(pickTop + pickMaxH > window.innerHeight - 8){
        // Flip above the trigger when there\'s no room below.
        pickTop = Math.max(8, Math.round(rect.top - pickMaxH - 4));
      }
      pick.style.cssText =
        'position:fixed;left:' + pickLeft + 'px;top:' + pickTop + 'px;' +
        'background:#0f172a;border:1px solid rgba(255,255,255,0.22);border-radius:8px;' +
        'padding:6px;z-index:99999;max-height:' + pickMaxH + 'px;overflow-y:auto;width:' + pickW + 'px;' +
        'box-shadow:0 12px 28px rgba(0,0,0,0.6);font-family:inherit;';
      // Heading row so the picker reads as a UI element, not a stray
      // floating list.
      var hdr = document.createElement('div');
      hdr.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#8b90a5;font-weight:600;padding:2px 6px 6px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:4px;';
      hdr.textContent = 'Pick a phase to link';
      pick.appendChild(hdr);
      candidates.forEach(function(c){
        var btn = document.createElement('div');
        btn.textContent = (c.label || c.type).split(' › ')[0];
        btn.style.cssText = 'padding:7px 10px;cursor:pointer;color:#e6e6e6;font-size:12px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        btn.onmouseenter = function(){ btn.style.background = 'rgba(255,255,255,0.06)'; };
        btn.onmouseleave = function(){ btn.style.background = 'transparent'; };
        // Bind on mousedown — the canvas\'s mousedown handler does a
        // pan-start; using mousedown here with stopPropagation makes
        // the pick fire BEFORE the canvas can intercept. Click would
        // race with the outside-click dismiss (it fires after a
        // mousedown→mouseup pair, by which time the dismiss handler
        // could have already removed the picker on the closing
        // mousedown).
        btn.onmousedown = function(ev){
          ev.preventDefault();
          ev.stopPropagation();
          var existing = E.wires().filter(function(w){
            if(w.fromNode !== poId) return false;
            var t = E.findNode(w.toNode);
            return t && t.type === 't2';
          });
          var defaultPct = 100;
          if(existing.length){
            var share = 100 / (existing.length + 1);
            existing.forEach(function(w){ w.allocPct = share; });
            defaultPct = share;
          }
          E.wires().push({ fromNode: poId, fromPort: 0, toNode: c.id, toPort: 0, allocPct: defaultPct });
          cleanup();
          render();
        };
        pick.appendChild(btn);
      });
      // Swallow mousedown anywhere INSIDE the picker so the outside-
      // close handler doesn\'t fire when the user scrolls or clicks
      // the heading.
      pick.addEventListener('mousedown', function(ev){ ev.stopPropagation(); });
      document.body.appendChild(pick);
      // Outside-click dismiss + ESC. mousedown beats click so the
      // canvas pan doesn\'t start before we close, and ESC works
      // even when focus is elsewhere.
      function cleanup(){
        try { pick.remove(); } catch(_) {}
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
      }
      function onDoc(ev){
        if(pick.contains(ev.target)) return;
        cleanup();
      }
      function onKey(ev){
        if(ev.key === 'Escape'){ ev.preventDefault(); cleanup(); }
      }
      // Use capture so the listener fires before the canvas handlers
      // and we can dismiss without the canvas seeing the click.
      setTimeout(function(){
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
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
      // Ctrl+LEFT-click (or Cmd+left-click on Mac) → focus + zoom on
      // this node. Restricted to left-button (e.button === 0) so a
      // Ctrl+right-click doesn't accidentally trigger this AND the
      // contextmenu fit-all gesture both — which would zoom in then
      // immediately back out, looking glitchy.
      if ((e.ctrlKey || e.metaKey) && e.button === 0) {
        e.stopPropagation();
        e.preventDefault();
        var nidF = nel.getAttribute('data-id');
        var nF = E.findNode(nidF);
        if (!nF) return;
        // Capture this BEFORE we mutate selN so we know whether
        // this is a repeat focus on the same node (= drill-in zoom)
        // or a fresh focus on a different node (= jump to 100%).
        var alreadyFocused = (selN === nidF);
        // Select the focused node so the highlight stays visible.
        if (selN && selN !== nidF) {
          var oldF = canvasEl.querySelector('[data-id="' + selN + '"]');
          if (oldF) oldF.classList.remove('ng-sel');
        }
        selN = nidF;
        nel.classList.add('ng-sel');
        updateConnectedHighlight();
        // Zoom target: snap to 1.0 (100%) on first hit so the user
        // sees the node at native size, centered. Repeat-clicks on
        // the SAME node drill in by +0.15 each press, capped at 1.8.
        var curZ = E.zm();
        var targetZ = alreadyFocused
          ? Math.min(1.8, curZ + 0.15)
          : 1.0;
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

  // Site-plan drill-in (Slice 3): dbl-click a building to enter it (reveal its
  // phases/costs + fit), dbl-click the same building or empty canvas to back
  // out to the whole site. Rename targets are skipped so name dbl-click still
  // renames; body dbl-clicks are inert in the handlers above, so no collision.
  canvasEl.addEventListener('dblclick',function(e){
    if(!(E.viewMode && E.viewMode()==='siteplan')) return;
    if(e.target.closest('[data-rename]') || e.target.closest('[data-frame-rename]')) return;
    var bEl=e.target.closest('.ng-node.ng-tt-t1');
    var bid=bEl ? bEl.getAttribute('data-id') : null;
    _spFocus = (bid && bid!==_spFocus) ? bid : null;
    applySpFocus();
    if(_spFocus) fanFocusNodes(_spFocus);
    fitSiteplan();
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
    // PO → phase allocation slider: write back to the wire and
    // re-render so the rollup numbers + the "totals 100%" badge
    // update live as the user types.
    if(t.tagName==='INPUT' && t.classList && t.classList.contains('ng-po-alloc')){
      var fromId = t.getAttribute('data-from');
      var toId   = t.getAttribute('data-to');
      var w = E.wires().find(function(w){ return w.fromNode === fromId && w.toNode === toId; });
      if(w){
        var raw = parseFloat(t.value);
        if(!Number.isFinite(raw)) raw = 0;
        w.allocPct = Math.max(0, Math.min(100, raw));
        E.resetComp();
        E.saveGraph();
        // Update the percent badge in this PO's section without a
        // full render — re-rendering every keystroke would lose
        // input focus.
        var section = t.closest('div[style*="border-top"]');
        if(section){
          var sumPct = 0;
          var inputs = section.querySelectorAll('.ng-po-alloc');
          inputs.forEach(function(inp){ sumPct += parseFloat(inp.value) || 0; });
          var badge = section.parentElement && section.parentElement.querySelector('span[title*="Allocation"]');
          if(badge){
            badge.textContent = sumPct.toFixed(0) + '%';
            var ok = Math.abs(sumPct - 100) < 0.5;
            badge.style.color = ok ? '#6a7090' : '#fbbf24';
            badge.title = ok ? 'Allocation totals 100%' : 'Allocation does not sum to 100% — phase rollups will under/over count';
          }
        }
      }
      return;
    }
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
          if(fill){fill.style.width=Math.min(pc,100)+'%';fill.style.background='linear-gradient(90deg, #4f8cff, #a78bfa)';}
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

  // Right-click handlers:
  //   - Ctrl/Cmd + right-click ANYWHERE (including on a node):
  //     fit-all overview. Now restricted to button === 2 in the
  //     mousedown path, so Ctrl+left-click on a node still focuses
  //     the node and Ctrl+right-click always overrides to fit-all.
  //   - Plain right-click on a node: no-op (browser context menu
  //     still suppressed by preventDefault).
  //   - Plain right-click on empty canvas: delete the wire under
  //     the cursor (existing behavior).
  wrap.addEventListener('contextmenu',function(e){
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomFitAll();
      return;
    }
    if (e.target.closest('.ng-node')) return;
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
      else if(delNode.type==='sub') {
        // Phase A: subs in the global directory (appData.subsDirectory)
        // are SHARED across jobs — deleting them here would silently
        // delete from every job. Only the legacy inline appData.subs
        // gets the per-job removal. Directory entries are managed via
        // the Subs admin page only; here we just unlink the node.
        var inInline = appData.subs && appData.subs.some(function(s){return s.id===delNode.data.id;});
        if (inInline) {
          appData.subs = appData.subs.filter(function(s){return s.id!==delNode.data.id;});
        }
        // Either way we drop the node + its wires below — directory
        // subs survive, inline subs get hard-deleted.
      }
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
    // Phase A: subs may live in the global directory rather than the
    // legacy per-job inline array. Update whichever record exists so
    // the contractAmt/billedToDate reflects the current graph state.
    var sub = appData.subs && appData.subs.find(function(s){ return s.id === subId; });
    if (!sub) sub = appData.subsDirectory && appData.subsDirectory.find(function(s){ return s.id === subId; });
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
    // Sub costs — create a Sub node + PO for each sub on this job.
    // Sub assignments are job-level only; the node graph itself
    // distributes sub spend across buildings/phases via wires.
    var jobSubs=appData.subs.filter(function(s){return s.jobId===jid;});
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

  // NG-WIP: no Watch fan. WIP metrics render inside the WIP overview card;
  // the octopus fan of per-output Watch nodes is retired (see ensureWatchFan
  // / pruneWipWatches). Manual Watch nodes can still be added from the library
  // to watch a specific building/phase value out on the canvas.

  // NG-R2/NG-SHAPE: cost nodes default to the round chip, COs to the triangle
  // chip ($ at a glance); expand from the hover toolbar for the full card.
  E.nodes().forEach(function(n){ if(n.cat==='cost'||n.cat==='co') n.collapsed=true; });
}

// ── Init ──
function init(){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  wrap=tab.querySelector('.ng-canvas-area');
  canvasEl=tab.querySelector('.ng-canvas');
  wireC=tab.querySelector('.ng-wire-canvas'); wireCtx=wireC.getContext('2d');
  gridC=tab.querySelector('.ng-grid-canvas'); gridCtx=gridC.getContext('2d');
  basemapEl=tab.querySelector('.ng-basemap');
  E.setCanvasEl(canvasEl);
  // Phase 2: anchor a geo-placed building's graph wires at its on-map visual center
  // (instead of the abstract n.x/n.y port), so phase/cost nodes feed into the footprint
  // the user sees. Same origin pipeline as the polygon layer + card, so the endpoint
  // stays pixel-consistent at every zoom. Render-only; returns null (→ engine falls
  // back to the abstract port) when off-satellite, no geo, or the origin is unresolved.
  E.setGeoPortAnchor(function(n){
    if(!(E.viewMode && E.viewMode()==='siteplan' && _spSatellite)) return null;
    if(!n || !n.geoLatLng) return null;
    var or=_geoOriginNow(); if(!or || !or.o || !or.og) return null;   // origin not ready → skip, don't guess
    var g=E.spLatLngToGraph(n.geoLatLng.lat, n.geoLatLng.lng, or.o.lat, or.o.lng);
    var cx=or.og.x + g.x, cy=or.og.y + g.y;        // geoLatLng projected: polygon centroid (traced) or placed point
    if(n.polygon && n.polygon.length>=3) return { x:cx, y:cy };       // traced: the drawn polygon is centered here
    var fp=E.spBuildingFootprint(n.budget);        // placed-only: block top-left sits here → shift to its center
    return { x:cx + fp.w/2, y:cy + fp.h/2 };
  });
  // Site Plan rework: tell the engine when satellite Site Plan is active, so
  // spNodeVisible hides the WIP hub (its totals live in the sidebar panel).
  E.setSatelliteActive(function(){ return !!_spSatellite && E.viewMode && E.viewMode()==='siteplan'; });
  buildSidebar(); initEvents(); applyTx();

  // Close-graph button removed — the back-to-WIP nav and top-level
  // tab switch both save + close the graph automatically, so the
  // explicit Close button was redundant clutter on the topbar.
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
    var go = (typeof window.agxConfirm === 'function')
      ? window.agxConfirm({
          title: 'Reset graph',
          message: 'Reset graph? This will delete all node positions and rebuild from job data.',
          confirmLabel: 'Reset',
          danger: true
        })
      : Promise.resolve(window.confirm('Reset graph?'));
    go.then(function(ok) {
      if (!ok) return;
      E.setNodes([]); E.setWires([]); E.setNid(1); if(E.setFrames) E.setFrames([]);
      populate(); ensureWatchFan(); render();
    });
  });

  // Auto arrange
  var aab=tab.querySelector('.ng-arrange-btn');
  if(aab) aab.addEventListener('click',function(){ autoArrange(selN); render(); });

  // NG8: Frame — wrap the selected node in a labeled group box, or drop an
  // empty one in the middle of the current view. Drag its title to move the
  // frame + the nodes inside it; drag the corner to resize; ×/double-click
  // the label to delete/rename.
  var frameBtn=tab.querySelector('.ng-frame-btn');
  if(frameBtn) frameBtn.addEventListener('click',function(){
    var sel = selN ? E.findNode(selN) : null, f;
    if(sel){
      var fp=ngNodeFootprint(sel), pad=40;
      f=E.addFrame(sel.x-pad, sel.y-pad-22, fp.w+pad*2, fp.h+pad*2+22, 'Group');
    } else {
      var p=E.pan(), zz=E.zm();
      f=E.addFrame(wrap.clientWidth/2/zz-p.x-180, wrap.clientHeight/2/zz-p.y-120, 360, 240, 'Group');
    }
    selFrame=f.id; selN=null; render(); E.saveGraph();
  });

  // Clean Mode — n8n-style flat look (toggle, persisted in engine).
  var cleanBtn=tab.querySelector('.ng-clean-btn');
  if(cleanBtn) cleanBtn.addEventListener('click',function(){
    var on = E.setCleanMode(!E.cleanMode());
    tab.classList.toggle('ng-clean', on);
    cleanBtn.classList.toggle('ng-on', on);
    render();   // re-stroke wires flat/gradient
  });

  // Site Plan (beta) — spatial view of the SAME graph (render-only toggle).
  var spBtn=tab.querySelector('.ng-siteplan-btn');
  if(spBtn) spBtn.addEventListener('click',function(){
    var on = E.setViewMode(E.viewMode()==='siteplan' ? 'graph' : 'siteplan')==='siteplan';
    tab.classList.toggle('ng-siteplan', on);
    spBtn.classList.toggle('ng-on', on);
    _spFocus=null; applySpFocus();        // always start at the whole-site view
    if(on) fitSiteplan(); else render();  // auto-fit to the buildings on enter
    updateBasemapVisibility();            // show/hide the satellite basemap with the mode
  });

  // Satellite basemap sub-toggle (Phase 2-A) — only meaningful in site-plan mode.
  var satBtn=tab.querySelector('.ng-sat-btn');
  if(satBtn) satBtn.addEventListener('click',function(){
    _spSatellite=!_spSatellite;
    try{ localStorage.setItem('ngSitePlanSatellite', _spSatellite?'1':'0'); }catch(_){}
    satBtn.classList.toggle('ng-on', _spSatellite);
    // If the WIP node was selected, drop the selection before it gets hidden in
    // satellite — otherwise its connected buildings keep an orphan amber highlight.
    if(selN){ var _sn=E.findNode(selN); if(_sn && _sn.type==='wip') selN=null; }
    updateBasemapVisibility();
    render();   // re-run renderNodes/drawWires so the wip card+wires hide/show with satellite
  });

  // 3D massing sub-toggle — extrude buildings into solid blocks (site-plan only).
  var massBtn=tab.querySelector('.ng-3d-btn');
  if(massBtn) massBtn.addEventListener('click',function(){
    _spMassing=!_spMassing;
    try{ localStorage.setItem('ngSitePlanMassing', _spMassing?'1':'0'); }catch(_){}
    massBtn.classList.toggle('ng-on', _spMassing);
    render();
  });

  // Place-on-map (Slice 3) — select a building, then click its real spot.
  var placeBtn=tab.querySelector('.ng-geoplace-btn');
  if(placeBtn) placeBtn.addEventListener('click', toggleGeoPick);

  // Trace Building (Phase 1) — select a building, then click its footprint corners.
  var traceBtn=tab.querySelector('.ng-trace-btn');
  if(traceBtn) traceBtn.addEventListener('click', toggleTraceMode);

  // Photo-GPS pins (Slice 4) — plot the job's geotagged photos on the imagery.
  var photosBtn=tab.querySelector('.ng-photos-btn');
  if(photosBtn) photosBtn.addEventListener('click', function(){
    _spPhotos=!_spPhotos;
    try{ localStorage.setItem('ngSitePlanPhotos', _spPhotos?'1':'0'); }catch(_){}
    photosBtn.classList.toggle('ng-on', _spPhotos);
    updatePhotoLayer();
  });

  // Save Layout — checkpoint the current node graph to a separate
  // localStorage slot (independent of auto-save) so the user can
  // recover from accidental edits or auto-save wipes after a
  // GRAPH_VER bump.
  var snapSaveBtn=tab.querySelector('.ng-snapshot-save-btn');
  if(snapSaveBtn) snapSaveBtn.addEventListener('click',function(){
    var existing = E.getSnapshot ? E.getSnapshot() : null;
    var doSave = function() {
      var savedAt = E.saveSnapshot();
      if(savedAt){
        flashSaveIndicator('saved', 'Layout saved');
        snapSaveBtn.title = 'Last saved: ' + new Date(savedAt).toLocaleString();
      } else {
        flashSaveIndicator('error', 'Save failed');
      }
    };
    if(existing && existing.savedAt){
      var go = (typeof window.agxConfirm === 'function')
        ? window.agxConfirm({
            title: 'Replace saved layout',
            message: 'Replace the previously saved layout (from ' + new Date(existing.savedAt).toLocaleString() + ')?',
            confirmLabel: 'Replace'
          })
        : Promise.resolve(window.confirm('Replace the previously saved layout?'));
      go.then(function(ok) { if (ok) doSave(); });
    } else {
      doSave();
    }
  });

  // Restore Layout — replace the live graph with the last saved
  // snapshot. Confirms because it's destructive to anything edited
  // since the snapshot was taken.
  var snapRestoreBtn=tab.querySelector('.ng-snapshot-restore-btn');
  if(snapRestoreBtn) snapRestoreBtn.addEventListener('click',function(){
    var snap = E.getSnapshot ? E.getSnapshot() : null;
    if(!snap){
      if (typeof window.agxAlert === 'function') {
        window.agxAlert({ title: 'No saved layout', message: 'No saved layout to restore. Click Save Layout first.' });
      } else {
        alert('No saved layout to restore. Click Save Layout first.');
      }
      return;
    }
    var when = snap.savedAt ? new Date(snap.savedAt).toLocaleString() : 'unknown time';
    var go = (typeof window.agxConfirm === 'function')
      ? window.agxConfirm({
          title: 'Restore saved layout',
          message: 'Restore layout saved at ' + when + '?\n\nAnything you\'ve edited since will be replaced.',
          confirmLabel: 'Restore',
          danger: true
        })
      : Promise.resolve(window.confirm('Restore layout saved at ' + when + '?'));
    go.then(function(ok) {
      if (!ok) return;
      if(E.restoreSnapshot()){
        applyTx();
        render();
        flashSaveIndicator('saved', 'Layout restored');
      } else {
        flashSaveIndicator('error', 'Restore failed');
      }
    });
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
  var allNodes=E.nodes(), wires=E.wires();
  if(!allNodes.length) return;
  var SNAP=E.SNAP;
  // ── Top-down tidy-tree (n8n cascade): parent on top, its inputs/children
  // hang below. Root = selected node, or the WIP master when nothing's selected.
  // Reingold–Tilford-style: leaves take slots left→right; parents center over
  // their children. Anchored so the root stays put. Only moves x/y (calc-safe).
  var rootNode = selectedId ? E.findNode(selectedId) : allNodes.find(function(n){return n.type==='wip';});
  if(!rootNode) rootNode = allNodes[0];
  if(!rootNode || rootNode.type==='watch' || rootNode.type==='note') return;
  var H_GAP=80, V_PAD=80, visited={}, cursorX=0, levelMaxH={};
  var TYPE_RANK={t1:1,t2:2,sub:3,po:4,inv:5,co:6,labor:7,burden:7.5,mat:8,gc:9,other:10,sum:11,sub2:11,mul:11,pct:11,job:12};
  // Measure each node's true layout box from the DOM. offsetWidth/offsetHeight
  // are in graph units (unaffected by the canvas zoom transform) and exclude
  // the overflowing port nubs, so they're the right footprint for spacing.
  // Falls back to estNodeHeight when a node isn't currently rendered.
  function nodeDim(n){
    var el=document.querySelector('.ng-node[data-id="'+n.id+'"]');
    if(el && el.offsetHeight) return {w:el.offsetWidth||210, h:el.offsetHeight};
    return {w:210, h:estNodeHeight(n)};
  }
  function childrenOf(id){
    var seen={}, out=[];
    wires.forEach(function(w){
      if(w.toNode!==id) return;
      var s=E.findNode(w.fromNode);
      if(!s||seen[s.id]||s.type==='watch'||s.type==='note'||visited[s.id]) return;
      seen[s.id]=true; out.push(s);
    });
    out.sort(function(a,b){return (TYPE_RANK[a.type]||99)-(TYPE_RANK[b.type]||99);});
    return out;
  }
  // Pass 1: tidy-tree X — leaves slot left→right by their real width; each
  // parent centers over its children. Also record each node's depth and the
  // tallest node found at each depth (for the height-aware vertical pass).
  function tdLayout(id, depth){
    if(visited[id]) return null; visited[id]=true;
    var node=E.findNode(id); if(!node) return null;
    var dim=nodeDim(node); node._depth=depth;
    if(levelMaxH[depth]==null||dim.h>levelMaxH[depth]) levelMaxH[depth]=dim.h;
    var kids=childrenOf(id), spans=[];
    kids.forEach(function(k){ var s=tdLayout(k.id, depth+1); if(s) spans.push(s); });
    if(!spans.length){ var lx=cursorX; cursorX+=dim.w+H_GAP; node._tx=lx; return {cx:lx+dim.w/2, min:lx, max:lx+dim.w}; }
    var cxc=(spans[0].cx+spans[spans.length-1].cx)/2;
    node._tx=cxc-dim.w/2;
    return {cx:cxc, min:Math.min(node._tx, spans[0].min), max:Math.max(node._tx+dim.w, spans[spans.length-1].max)};
  }
  tdLayout(rootNode.id, 0);
  // Pass 2: stack levels by measured row heights so a tall parent (e.g. the
  // data-rich WIP master, ~900px) never overlaps the level hanging below it.
  var levelY={}, accY=0, dpt=0;
  while(levelMaxH[dpt]!=null){ levelY[dpt]=accY; accY+=levelMaxH[dpt]+V_PAD; dpt++; }
  allNodes.forEach(function(n){ if(n._tx==null) return; n._ty=levelY[n._depth!=null?n._depth:0]||0; });
  var offX=rootNode.x - (rootNode._tx||0), offY=rootNode.y - (rootNode._ty||0);
  allNodes.forEach(function(n){
    if(n._tx==null) return;
    n.x=Math.round((n._tx+offX)/SNAP)*SNAP;
    n.y=Math.round((n._ty+offY)/SNAP)*SNAP;
    delete n._tx; delete n._ty; delete n._depth;
  });
  return;
  /* ── legacy radial arrange (retained, unreachable) ── */
  var nodes=allNodes.filter(function(n){return n.type!=='watch'&&n.type!=='note';});
  if(!nodes.length) return;
  var p=E.pan(),z=E.zm();
  var cx=-p.x+(wrap?wrap.clientWidth/2/z:500);
  var cy=-p.y+(wrap?wrap.clientHeight/2/z:300);
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
// WIP metrics now live inside the WIP overview card (NG-WIP). The old octopus
// fan of Watch nodes echoing each WIP output is retired. This function used to
// CREATE that fan; it now PRUNES it instead, so the change applies to existing
// graphs (local + cloud) the moment they're opened or synced. All the former
// "ensure" call sites (open / sync / reset) therefore self-heal. Manual Watch
// nodes wired to a building/phase value are left intact. Watch nodes are
// output-less display leaves, so removing them is calc-safe.
function ensureWatchFan(){ return pruneWipWatches(); }

// Remove every Watch node wired FROM a WIP output (plus its wire). Returns
// true if anything was removed (so callers can re-render).
function pruneWipWatches(){
  var wipNode=E.nodes().find(function(n){return n.type==='wip';});
  if(!wipNode) return false;
  var rm={};
  E.wires().forEach(function(w){
    if(w.fromNode===wipNode.id){
      var t=E.findNode(w.toNode);
      if(t && t.type==='watch') rm[t.id]=true;
    }
  });
  if(!Object.keys(rm).length) return false;
  E.setNodes(E.nodes().filter(function(n){ return !rm[n.id]; }));
  E.setWires(E.wires().filter(function(w){ return !rm[w.fromNode] && !rm[w.toNode]; }));
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

// Exit the node graph overlay back to the job detail underneath. Saves
// graph state first so the user doesn't lose unsaved edits, and clears
// the maximize-graph body class if it was on (otherwise the AGX header
// stays hidden after exit).
window.closeNodeGraph=function(){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  if(typeof window.E !== 'undefined' && window.E && typeof window.E.saveGraph === 'function'){
    try { window.E.saveGraph(); } catch(e){ /* defensive */ }
  } else if(typeof NG !== 'undefined' && NG.saveGraph){
    try { NG.saveGraph(); } catch(e){ /* defensive */ }
  }
  tab.classList.remove('active');
  // If the user maximized the graph (hid the AGX nav header), restore
  // the header so they're not stuck in fullscreen on the job detail.
  if(document.body.classList.contains('ng-graph-fullscreen')){
    document.body.classList.remove('ng-graph-fullscreen');
    var maxBtn=document.getElementById('ngFullscreenGraphBtn');
    if(maxBtn) maxBtn.innerHTML='\u{1F5D6} Maximize';
  }
};

window.openNodeGraph=function(jid){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  // Position below the sticky header
  var header=document.querySelector('header');
  if(header) tab.style.top=header.offsetHeight+'px';
  tab.classList.add('active');
  // Restore the persisted Clean Mode look + sync the toggle button.
  try {
    var _clean = E && E.cleanMode && E.cleanMode();
    tab.classList.toggle('ng-clean', !!_clean);
    var _cb = document.getElementById('ngCleanBtn'); if(_cb) _cb.classList.toggle('ng-on', !!_clean);
  } catch(_){}
  // Restore the persisted Site Plan view mode + sync its toggle button.
  try {
    var _sp = E && E.viewMode && E.viewMode()==='siteplan';
    tab.classList.toggle('ng-siteplan', !!_sp);
    var _spb = document.getElementById('ngSitePlanBtn'); if(_spb) _spb.classList.toggle('ng-on', !!_sp);
    // Restore the satellite sub-toggle; mount the basemap only if the tab is
    // already visible (avoid sizing a google.maps.Map inside a hidden overlay).
    // offsetWidth (not offsetParent — the tab is position:fixed) detects visibility.
    var _satb = document.getElementById('ngSatelliteBtn'); if(_satb) _satb.classList.toggle('ng-on', _spSatellite);
    var _3db = document.getElementById('ng3dBtn'); if(_3db) _3db.classList.toggle('ng-on', _spMassing);
    var _phb = document.getElementById('ngPhotosBtn'); if(_phb) _phb.classList.toggle('ng-on', _spPhotos);
    if(tab && tab.offsetWidth>0) updateBasemapVisibility();
  } catch(_){}
  if(!wrap) init();
  resize();
  // Initial render off the synchronous localStorage cache for instant
  // paint; cloud sync runs underneath and re-renders if it returns
  // newer data. Avoids the dead-air pause of awaiting a network call
  // before showing anything.
  //
  // CRITICAL: gate cloud writes during the initial-open window. The
  // bootstrap render() at the bottom of this branch unconditionally
  // calls saveGraph() (engine.js render does so on every render).
  // Without the gate, that first save races ahead of syncFromCloud
  // and overwrites the canonical cloud state with the current user's
  // stale localStorage — meaning every viewer's first paint clobbers
  // whatever their teammates last saved. Flipping it back in
  // syncFromCloud's settle handler restores normal save behavior.
  if (E && typeof E.setInitialCloudSyncInFlight === 'function') {
    E.setInitialCloudSyncInFlight(true);
  }
  if(jid && jid!==E.job()){
    E.job(jid);
    _spOrigin=null; _spOriginGraph=null; _spOriginJob=null; _geoPhotos=[]; _geoPhotosJob=null; _geocoding=false; // drop geo caches: avoid cross-job staleness
    E.setNodes([]); E.setWires([]); E.setNid(1);
    if(!E.loadGraph()){ populate(); }
    ensureWatchFan();
    applyTx(); render();
    syncFromCloud();
  } else if(E.nodes().length===0){
    E.job(jid||(typeof appState!=='undefined'?appState.currentJobId:null));
    if(!E.loadGraph()){ populate(); }
    ensureWatchFan();
    applyTx(); render();
    syncFromCloud();
  } else {
    ensureWatchFan();
    render();
    syncFromCloud();
  }
};

// Cloud sync — fires after the initial local-cache render. If cloud
// has newer/different state, replaces local state and re-renders. If
// cloud has nothing (first time using cloud sync for this job), the
// next save will write up the current local state. Failures are
// silent (offline-tolerant); the user keeps working with their cache.
function syncFromCloud(){
  if (!E || typeof E.loadGraphFromCloudAndApply !== 'function') return;
  E.loadGraphFromCloudAndApply().then(function(applied){
    if (applied) {
      ensureWatchFan();
      applyTx();
      render();
    }
    // Initial-open cloud write gate is released only AFTER cloud
    // sync settles. From here on, saveGraph() can write to cloud
    // normally — at this point the engine's in-memory state matches
    // whatever cloud had (or local cache, if cloud was empty), so
    // any subsequent user edit is on top of the canonical state.
    if (E && typeof E.setInitialCloudSyncInFlight === 'function') {
      E.setInitialCloudSyncInFlight(false);
    }
    // If cloud applied (state changed under us), persist the now-
    // current state up to localStorage so the next session boots
    // off the freshest cache. saveGraph also pushes to cloud, but
    // since it's already what cloud has, that PUT is a no-op
    // overwrite — cheap and idempotent.
    if (applied && typeof E.saveGraph === 'function') {
      try { E.saveGraph(); } catch (e) {}
    }
    // Always refresh the audit badge after we've settled on the
    // graph state (whether cloud or local cache won) — the user
    // may have edited things on other tabs (WIP %, QB lines) that
    // don't trigger the engine's render path. render() above
    // already refreshes the badge if cloud applied; this catches
    // the cloud-no-op case too.
    if (typeof window._wsRefreshAuditBadge === 'function') {
      try { window._wsRefreshAuditBadge(); } catch (e) {}
    }
  }).catch(function() {
    // Network/parse failure — release the gate so the user isn't
    // stuck in a state where their saves never reach cloud. They'll
    // just continue with their local cache as the source of truth.
    if (E && typeof E.setInitialCloudSyncInFlight === 'function') {
      E.setInitialCloudSyncInFlight(false);
    }
  });
}
})();
