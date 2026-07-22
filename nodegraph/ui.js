// ============================================================
// AGX Node Graph v5 — UI (render, sidebar, events, populate)
// ============================================================
(function(){
'use strict';

var E = NG; // engine reference
// NC-7: the site plan defaults to the clean scope-card view (building = map object, each
// scope/CO = a card wired to it). No legacy fanned nodes/wires. Toggle off via ▤ Cards.
// Only affects siteplan (docks + non-t1 node-skip are both gated on viewMode==='siteplan').
if(typeof window._p86NcDefault==='undefined') window._p86NcDefault=true;
var wrap, canvasEl, wireC, wireCtx, gridC, gridCtx;
var dragN=null, dragOff={x:0,y:0}, _didDragNode=false;
var wiringFrom=null, wireMouse=null;
var selN=null, isPan=false, panSt={x:0,y:0};
var editingId=null;
var _spFocus=null; // site-plan drill-in: focused building id (view-state, not saved)
// Phase 2-A satellite basemap state (view-state / localStorage only — no graph write):
var basemapEl=null, _basemap=null, _basemapReady=false, _spOrigin=null, _spOriginGraph=null, _spOriginJob=null, _satHintEl=null, _geocoding=false, _basemapMounting=false;
var _geoPick=false, _geoPickOverlay=null, _geoPickId=null; // Slice 3: map-picker state (captured building id)
// Phase 1 — building polygons: trace state + the geo-anchored SVG layer
var _tracing=false, _traceId=null, _tracePts=[], _traceOverlay=null, _traceClickTimer=null, _polyLayer=null;
// Measure tool: real distance (ft) + area (sq ft) on the satellite imagery.
// Ephemeral view-state only (no graph write); points cleared when the tool is off.
var _measuring=false, _measureMode='line', _measurePts=[], _measureOverlay=null, _measurePanel=null, _measureRoofPitch=0, _measureKeyHandler=null;
var _SVGNS='http://www.w3.org/2000/svg';
var _spMassing=(function(){ try{ return localStorage.getItem('ngSitePlanMassing')!=='0'; }catch(_){ return true; } })(); // 2.5D building massing — on by default
// Slice 4: photo-GPS pins
var _photoPinsEl=null, _geoPhotos=[], _geoPhotosJob=null, _geoPhotosNoGps=0;
var _spPhotos=(function(){ try{ return localStorage.getItem('ngSitePlanPhotos')==='1'; }catch(_){ return false; } })();
// Geolocated task pins on the satellite map — mirrors the photo-pin layer.
var _taskPinsEl=null, _geoTasks=[], _geoTasksJob=null;
var _spTasks=(function(){ try{ return localStorage.getItem('ngSitePlanTasks')==='1'; }catch(_){ return false; } })();
var _spSatellite=true; // satellite is permanent now (the toggle is retired); never goes false
// Basemap imagery type: 'satellite' (default) or 'roadmap' (street map) — for
// job locations with no/poor satellite coverage. Persisted; switched live via setMapTypeId.
var _spBasemapType=(function(){ try{ return localStorage.getItem('ngSitePlanBasemap')==='roadmap' ? 'roadmap' : 'satellite'; }catch(_){ return 'satellite'; } })();
// 3D Orbit view (Photorealistic 3D Tiles / Google-Earth engine). Rendered in an ISOLATED
// same-origin iframe (/orbit3d.html) that loads Maps on the BETA channel + Map3DElement, so
// the main app's maps stay on the production "weekly" channel, untouched. We feed the iframe
// the job center + building footprints via postMessage; it extrudes/highlights them in 3D.
var _spOrbit=false, _orbitEl=null, _orbitReady=false, _orbitPending=null;
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
      var t1s = [], _seenT1 = {};
      wires.forEach(function(w){
        if(w.fromNode===n.id){
          var target=E.findNode(w.toNode);
          // Count UNIQUE t1 targets, not raw wires - a transient duplicate
          // wire to the same building must not read as "2 buildings" and
          // wipe phase.buildingId below.
          if(target&&target.type==='t1'&&!_seenT1[target.id]){ _seenT1[target.id]=1; t1s.push({ name:target.label.split(' \u203A ')[0].trim(), data:target.data }); }
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
  // Flush unit-mode scope wires: wire.pctComplete = units-done ÷ the building's
  // unit count. Keeps the phase %, building %, WIP %, and earned-revenue rollups
  // all consistent (every one reads wire.pctComplete). No-op for percent-mode
  // wires (E.wireUnitPct returns null unless trackMode==='units' + building units).
  wires.forEach(function(w){
    var uPc = E.wireUnitPct(w);
    if(uPc != null) w.pctComplete = uPc;
  });
  // Phase-driven scopes: a scope with a phases[] breakdown derives its % from the
  // weighted completion of its phases (E.scopePctFromPhases). Flush that onto its
  // outgoing scope→building wires so every wire.pctComplete reader (building %,
  // earned revenue, the scope-row display) stays consistent — overriding any
  // stale unit/manual value left on those wires.
  nodes.forEach(function(n){
    if(n.type!=='t2') return;
    var sp = E.scopePctFromPhases(n);
    if(sp==null) return;
    sp = Math.round(sp*10)/10;
    wires.forEach(function(w){ if(w.fromNode===n.id) w.pctComplete = sp; });
  });
  nodes.forEach(function(n){
    if(n.type==='t1'){
      n.pctComplete = Math.round(E.getT1WeightedPct(n) * 10) / 10;
    } else if(n.type==='t2' || n.type==='co'){
      // Flush the scope (t2/CO) node's own pctComplete from its wire-weighted
      // value too. pushToJob copies n.pctComplete into the appData.phases record,
      // and the record-based rollups (jobs list, job header, building cards via
      // calcBuildingPctComplete / calcJobPctComplete) read that record — so
      // without this, a units-tracked scope (whose completion lives only on the
      // wire) would show the correct % on the Site Map but a stale % in the
      // list/header. Also repairs the same latent gap for percent-mode wires.
      n.pctComplete = Math.round(E.getT2WeightedPct(n) * 10) / 10;
    }
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
// Slice 4: slim at-a-glance node chip for the satellite map — a % ring + name for t2/co,
// an icon badge + name + compact amount for cost/sub/po/inv. Full detail lives in the
// right Inspector; clicking the chip selects the node. Color-coded by type.
var SLIM_COLOR={ t2:'#a78bfa', co:'#f472b6', sub:'#34d399', po:'#fbbf24', inv:'#60a5fa' };
function slimChipHtml(n, d){
  var hasPct = (n.type==='t2' || n.type==='co');
  var color = SLIM_COLOR[n.type] || '#8aa0c0';
  var left;
  if(hasPct){
    var pct = Math.max(0, Math.min(100, E.getT2WeightedPct(n)||0));
    var circ = 2*Math.PI*13;
    var off = circ*(1 - pct/100);
    left = '<svg class="ng-slim-ring" width="30" height="30" viewBox="0 0 30 30">'
      + '<circle cx="15" cy="15" r="13" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="3.4"/>'
      + '<circle cx="15" cy="15" r="13" fill="none" stroke="'+color+'" stroke-width="3.4" stroke-linecap="round" stroke-dasharray="'+circ.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'" transform="rotate(-90 15 15)"/>'
      + '<text x="15" y="18.5" text-anchor="middle" font-size="9" font-weight="700" fill="#e7ecf5" font-family="sans-serif">'+pct.toFixed(0)+'</text></svg>';
  } else {
    left = '<span class="ng-slim-badge" style="background:'+color+'">'+(d.icon||'•')+'</span>';
  }
  var sub = hasPct ? (d.label||n.type) : fmtCompactC(E.getOutput(n,0)||0);
  return left + '<div class="ng-slim-txt"><span class="ng-slim-name">'+luEsc(n.label||d.label||'')+'</span><span class="ng-slim-sub">'+luEsc(sub)+'</span></div>';
}
// NC-5/6: single guarded wire-draw. In docked cost-cards mode on the site plan the
// wire canvas is CLEARED (containment is shown by the cards + their SVG connectors);
// otherwise wires draw normally. Every drawWires call routes through here so pan/drag
// redraws can't resurrect the old wires.
function _drawWires(){
  if(window._p86NcDefault && E.viewMode && E.viewMode()==='siteplan'){ if(wireCtx&&wireC) wireCtx.clearRect(0,0,wireC.width,wireC.height); return; }
  if(E.drawWires && wireCtx && wrap) E.drawWires(wireCtx, wrap, wiringFrom, wireMouse);
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
    var _slim = sitePlan && _spSatellite && n.type!=='t1'; // Slice 4: slim at-a-glance chip on the satellite map
    if(sitePlan && window._p86NcDefault && n.type!=='t1') return; // NC-5: children live in the building's docked card stack, not as fanned nodes
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
      // Slice 4: every NON-building node (phase/sub/PO/cost) renders as a slim
      // at-a-glance chip — natively small (no scaled-down 190px card). The full
      // detail now lives in the right Inspector; clicking the chip selects it.
      div.classList.add('ng-slim');
    }

    var h;
    if(_slim){ h=slimChipHtml(n, d); }
    else {
    var canColl = n.type!=='note' && n.type!=='watch';
    var canEdit = (n.type==='t1'||n.type==='t2'||n.type==='sub'||n.type==='co'||n.type==='po'||n.type==='inv') && n.data && n.data.id;
    h='<div class="ng-hdr"><span class="ng-hi">'+d.icon+'</span><span class="ng-hdr-name" data-rename="'+n.id+'" title="Double-click to rename">'+n.label+'</span>';
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
            // Per-scope completion is tracked by UNITS (check off the building's
            // units for THIS scope) or by PERCENT. Units mode is only offered when
            // the target building has units set.
            var uCnt=(b.units&&b.units.length)?b.units.length:0;
            var isUnits=(w.trackMode==='units')&&uCnt>0;
            var uDone=Math.max(0,Math.min(w.unitsDone||0,uCnt));
            h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;color:#6a7090;font-size:9px;gap:4px;">';
            h+='<span class="ng-alloc-lock" data-lock-co="'+n.id+'" data-lock-wire="'+w.toNode+'" title="'+(isLocked?'Unlock':'Lock')+' this allocation" style="cursor:pointer;font-size:10px;color:'+lockColor+';width:14px;text-align:center;">'+(isLocked?'\uD83D\uDD12':'\uD83D\uDD13')+'</span>';
            h+='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+bname+'</span>';
            h+='<span class="ng-alloc-pct" data-alloc-phase="'+n.id+'" data-alloc-bldg="'+w.toNode+'" title="Click to edit allocation %" style="color:#fbbf24;cursor:pointer;font-family:\'Courier New\',monospace;min-width:42px;text-align:right;">'+pct.toFixed(1)+'%</span>';
            // Units \u21C4 % toggle (only when the building has units).
            if(uCnt>0){
              h+='<span class="ng-scope-mode" data-scope-mode-phase="'+n.id+'" data-scope-mode-bldg="'+w.toNode+'" title="'+(isUnits?'Tracking by units \u2014 switch to percent':'Switch to unit check-off')+'" style="cursor:pointer;color:'+(isUnits?'#34d399':'#8b90a5')+';font-size:11px;line-height:1;width:14px;text-align:center;">'+(isUnits?'\u25A6':'%')+'</span>';
            }
            // % Cmp: editable percent chip, OR a read-only derived % in units mode.
            if(isUnits){
              h+='<span title="Driven by the units checked off below" style="color:'+wpcColor+';font-family:\'Courier New\',monospace;min-width:38px;text-align:right;border-left:1px dotted var(--ng-border2);padding-left:4px;opacity:0.85;">'+wpc.toFixed(0)+'%</span>';
            } else {
              h+='<span class="ng-wire-pct" data-wire-pct-phase="'+n.id+'" data-wire-pct-bldg="'+w.toNode+'" title="Click to edit % complete" style="color:'+wpcColor+';cursor:pointer;font-family:\'Courier New\',monospace;min-width:38px;text-align:right;border-left:1px dotted var(--ng-border2);padding-left:4px;">'+wpc.toFixed(0)+'%</span>';
            }
            h+='<span class="ng-alloc-share" data-share-co="'+n.id+'" data-share-wire="'+w.toNode+'" data-share-income="'+phaseRev+'" title="Click to edit $ share" style="color:#34d399;cursor:pointer;font-family:\'Courier New\',monospace;min-width:64px;text-align:right;">'+E.fmtC(share)+'</span>';
            h+='</div>';
            // Units check-off strip (units mode only): one cube per building unit,
            // filled to unitsDone. Clicking cube #k sets the count to k (or clears
            // the last-filled cube). This is the "check off units through the scope".
            if(isUnits){
              h+='<div class="ng-scope-cubes" style="display:flex;flex-wrap:wrap;align-items:center;gap:3px;padding:0 0 4px 18px;">';
              for(var _c=0;_c<uCnt;_c++){
                h+='<i class="ng-lu-cube ng-scope-cube'+(_c<uDone?' done':'')+'" data-scope-cube-phase="'+n.id+'" data-scope-cube-bldg="'+w.toNode+'" data-scope-cube-idx="'+_c+'" title="'+(_c<uDone?('Unit '+(_c+1)+' done \u2014 tap to set '+(_c+1)+' complete'):('Tap to mark '+(_c+1)+' unit'+(_c===0?'':'s')+' complete'))+'"></i>';
              }
              h+='<span style="margin-left:5px;color:#8b90a5;font-family:\'Courier New\',monospace;font-size:9px;">'+uDone+' / '+uCnt+'</span>';
              h+='</div>';
            }
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

    }
    div.innerHTML=h;
    canvasEl.appendChild(div);
  });
}

function render(){
  // Whole-site Site Plan: fan each building's phases around it (once per building, via
  // _fannedSet) so phase nodes show near their buildings on the map — not at abstract
  // layout positions. Skipped while drilled into one building (that path fans on click).
  if(E.viewMode && E.viewMode()==='siteplan' && !_spFocus && _spOrigin && _spOriginGraph) fanAllBuildings();
  updateTierLabels();
  updateT1Progress();
  pushToJobSilent();
  renderFrames();
  renderNodes();
  renderPolygons();                 // geo-anchored building footprints (satellite only)
  renderSidebarMetrics();           // live WIP totals in the sidebar (satellite only, via CSS)
  renderBuildingMetrics();          // S2: selected building's cost breakdown
  renderInspector();                // right-hand Inspector: WIP / building / node detail
  E.drawGrid(gridCtx, gridC.width, gridC.height);
  _drawWires();  // NC-5/6: clears the wire canvas in docked mode, draws wires otherwise
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
  renderNestedOverlay();   // NC-1: nested-cards overlay (shown only when toggled on)
}

// ── NC-1: Nested-cards view (containment instead of wires) ─────────────────
// A SEPARATE overlay renderer that draws the wire tree as cards-inside-cards, so
// the hierarchy reads by containment with no drawn wires. Lives over .ng-canvas-area,
// toggled by window._p86Nested. The wires stay in the data (all rollups read them) —
// this only changes how the canvas looks. NC-2..5 add the outline toggle, in-card
// editing/spawn, satellite anchoring, then make it the default + retire wire drawing.
function getNestedChildren(id){
  var ks=[], seen={};
  E.wires().forEach(function(w){ if(w.toNode!==id) return; var k=E.findNode(w.fromNode); if(k && !seen[k.id]){ seen[k.id]=1; ks.push(k); } });
  return ks;
}
function ncNodePct(n){
  if(n.type==='t1') return (E.getT1WeightedPct?E.getT1WeightedPct(n):(n.pctComplete||0));
  var d=E.DEFS[n.type]||{}; return d.hasProg ? (n.pctComplete||0) : null;
}
function ncNodeVal(n){ try{ return (typeof E.getOutput==='function') ? E.getOutput(n,0) : null; }catch(e){ return null; } }
function nestedCardHtml(n, depth, seen){
  if(seen[n.id]) return ''; seen[n.id]=1;    // cycle guard
  var d=E.DEFS[n.type]||{}, kids=getNestedChildren(n.id);
  var typ=(d.cat==='cost')?'cost':n.type, coll=!!n._ncColl, pct=ncNodePct(n), val=ncNodeVal(n);
  var h='<div class="ng-ncard ng-nc-'+typ+(coll?' ng-nc-coll':'')+(n.type!=='t1'?' ng-nc-drag':'')+'" data-nc="'+n.id+'"'+(n.type!=='t1'?' draggable="true"':'')+'>';
  h+='<div class="ng-nc-h" data-nc-sel="'+n.id+'">';
  h+= kids.length ? '<button class="ng-nc-caret" data-nc-coll="'+n.id+'" aria-label="Collapse">'+(coll?'▸':'▾')+'</button>' : '<span class="ng-nc-caret ng-nc-leaf"></span>';
  h+='<span class="ng-nc-dot"></span><span class="ng-nc-nm">'+luEsc(n.label||d.label||n.type)+'</span><span class="ng-nc-ty">'+luEsc(d.label||n.type)+'</span>';
  var meta='';
  if(val!=null && !isNaN(val)) meta+='<span class="ng-nc-val">'+E.fmtC(val)+'</span>';
  if(pct!=null && !isNaN(pct)) meta+='<span class="ng-nc-pct">'+Math.round(pct)+'%</span>';
  if(meta) h+='<span class="ng-nc-meta">'+meta+'</span>';
  if(n.type!=='t1') h+='<span class="ng-nc-actions"><button class="ng-nc-xbtn" data-nc-del="'+n.id+'" title="Delete" aria-label="Delete">×</button></span>';
  h+='</div>';
  if(kids.length && !coll) h+='<div class="ng-nc-kids">'+kids.map(function(k){ return nestedCardHtml(k, depth+1, seen); }).join('')+'</div>';
  h+='</div>';
  return h;
}
function renderNestedCards(){
  var host=document.getElementById('ngNestedView'); if(!host) return;
  var roots=E.nodes().filter(function(n){ return n.type==='t1'; });
  if(!roots.length){ host.innerHTML='<div class="ng-nc-empty">No buildings yet — add one to start the cost tree.</div>'; return; }
  var seen={};
  host.innerHTML='<div class="ng-ncv-inner">'+roots.map(function(r){ return nestedCardHtml(r,0,seen); }).join('')+'</div>';
}
// NC-4: one building's nested tree as a floating panel over the satellite map (no wires),
// opened from the building inspector's "Cards" button. Reuses the same cards + drag/delete/collapse.
function renderBldgPanel(bId){
  var b=E.findNode(bId); if(!b) return;
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  var area=tab.querySelector('.ng-canvas-area')||tab;
  var p=document.getElementById('ngBldgCards');
  if(!p){
    p=document.createElement('div'); p.id='ngBldgCards'; p.className='ng-bcards';
    p.style.cssText='position:absolute;left:20px;top:64px;width:360px;max-height:72%;z-index:60;overflow:auto;background:#0e1626;border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);';
    area.appendChild(p); ncAttachDnd(p);
  }
  p._bId=bId; p.style.display='block';
  var seen={};
  p.innerHTML='<div class="ng-bcards-hd"><span class="ng-bcards-ttl">'+luEsc(b.label||'Building')+'</span>'
    +'<button class="ng-bcards-x" onclick="var e=document.getElementById(\'ngBldgCards\');if(e)e.style.display=\'none\';" aria-label="Close">×</button></div>'
    +'<div class="ng-bcards-body">'+nestedCardHtml(b,0,seen)+'</div>';
}
window.p86NcBldgToggle=function(bId){
  var p=document.getElementById('ngBldgCards');
  if(p && p.style.display!=='none' && p._bId===bId){ p.style.display='none'; return; }
  renderBldgPanel(bId);
};
// Re-render whichever nested surfaces are open (full overlay, floating panel, docks).
function ncRefreshOpen(){
  if(window._p86Nested) renderNestedCards();
  var p=document.getElementById('ngBldgCards'); if(p && p.style.display!=='none' && p._bId) renderBldgPanel(p._bId);
  if(window._p86NcDefault) renderBldgDocks();
}
// NC-7: each building's DIRECT children (scopes, change orders, any direct cost) dock as their
// OWN card wired to the building — the cards "start at the scope tier". The building itself is
// the map object (click it for building info); adding a scope/CO to a building pops its card
// onto the canvas wired to the building. Deeper children (subs/POs/costs) nest inside the card.
// renderBldgDocks builds/refreshes the cards; layoutBldgDocks keeps each pinned to its building.
function renderBldgDocks(){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  var area=tab.querySelector('.ng-canvas-area')||tab;
  var sitePlan=E.viewMode && E.viewMode()==='siteplan';
  if(!window._p86NcDefault || !sitePlan){ [].forEach.call(area.querySelectorAll('.ng-dock'), function(e){ e.remove(); }); var _sv=document.getElementById('ngDockWires'); if(_sv) _sv.innerHTML=''; return; }
  var t1s=E.nodes().filter(function(n){ return n.type==='t1'; }), live={};
  t1s.forEach(function(b){
    getNestedChildren(b.id).forEach(function(k, idx){   // one card per scope / CO / direct cost
      live[k.id]=1;
      var el=document.getElementById('ngDock-'+k.id);
      if(!el){ el=document.createElement('div'); el.id='ngDock-'+k.id; area.appendChild(el); ncAttachDnd(el); }
      el._bldg=b.id;                                     // the building this card wires to (for layout)
      if(!k._ncDockOff) k._ncDockOff={x:88, y:-72+idx*66};  // spawn near the building, then placeable
      var d=E.DEFS[k.type]||{}, typ=(d.cat==='cost')?'cost':k.type;
      var open=!!k._ncDockOpen, subs=getNestedChildren(k.id), seen={}, pct=ncNodePct(k), val=ncNodeVal(k);
      el.className='ng-dock ng-nc-'+typ+(open?' ng-dock-open':'');
      var sum='';
      if(val!=null && !isNaN(val)) sum+=E.fmtC(val);
      if(pct!=null && !isNaN(pct)) sum+=(sum?' · ':'')+Math.round(pct)+'%';
      if(!sum) sum=subs.length+' item'+(subs.length===1?'':'s');
      el.innerHTML='<div class="ng-dock-hd" title="Drag to move · click ▸ to expand">'
          +(subs.length ? '<button class="ng-dock-caret" data-nc-dock-toggle="'+k.id+'" aria-label="Expand or collapse">'+(open?'▾':'▸')+'</button>' : '<span class="ng-dock-caret ng-nc-leaf"></span>')
          +'<span class="ng-dock-dot"></span>'
          +'<span class="ng-dock-ttl" data-nc-sel="'+k.id+'">'+luEsc(k.label||d.label||k.type)+'</span>'
          +'<span class="ng-dock-ty">'+luEsc(d.label||k.type)+'</span>'
          +'<span class="ng-dock-sum">'+sum+'</span>'
          +'<button class="ng-dock-x" data-nc-del="'+k.id+'" title="Delete" aria-label="Delete">×</button>'
        +'</div>'
        +(open ? ('<div class="ng-dock-body">'+(subs.length ? subs.map(function(s){ return nestedCardHtml(s,0,seen); }).join('') : '<div class="ng-dock-empty">No items yet — add from the inspector</div>')+'</div>') : '');
      attachDockDrag(el.querySelector('.ng-dock-hd'), k, el);   // pointer-capture drag (per header)
    });
  });
  [].forEach.call(area.querySelectorAll('.ng-dock'), function(e){ var id=e.id.replace('ngDock-',''); if(!live[id]) e.remove(); });
  layoutBldgDocks();
}
function layoutBldgDocks(){
  var tab=document.getElementById('nodeGraphTab'); if(!tab || !window._p86NcDefault) return;
  var area=tab.querySelector('.ng-canvas-area')||tab, z=E.zm(), p=E.pan();
  var svg=document.getElementById('ngDockWires');
  if(!svg){ svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.id='ngDockWires'; svg.setAttribute('class','ng-dock-wires'); area.insertBefore(svg, area.firstChild); }
  [].forEach.call(area.querySelectorAll('.ng-dock'), function(el){
    var k=E.findNode(el.id.replace('ngDock-','')); if(!k) return;
    var b=E.findNode(el._bldg||''); if(!b) return;                          // the building this card wires to
    var off=k._ncDockOff||{x:88,y:-72};
    var c=(b.geoLatLng)?geoRenderPos(b):{x:b.x,y:b.y};
    var bx=Math.round((p.x+c.x)*z), by=Math.round((p.y+c.y)*z);              // building CENTER (screen)
    var cx=Math.round((p.x+c.x+off.x)*z), cy=Math.round((p.y+c.y+off.y)*z);  // card top-left (screen)
    el.style.left=cx+'px'; el.style.top=cy+'px';
    var ln=document.getElementById('ngDockWire-'+k.id);
    if(!ln){ ln=document.createElementNS('http://www.w3.org/2000/svg','line'); ln.id='ngDockWire-'+k.id; ln.setAttribute('class','ng-dock-wire'); svg.appendChild(ln); }
    // Dynamic anchors: the wire exits the building toward the card and lands on the
    // card BORDER facing the building — so the anchor point slides around as you drag
    // the card, keeping the fan clean and never folding under the building or the card.
    var cw=el.offsetWidth||180, ch=el.offsetHeight||40;
    var ccx=cx+cw/2, ccy=cy+ch/2;                                            // card center (screen)
    var ddx=ccx-bx, ddy=ccy-by, dl=Math.sqrt(ddx*ddx+ddy*ddy)||1;
    var ux=ddx/dl, uy=ddy/dl;                                               // building -> card unit vector
    var BR=Math.min(30, dl*0.4);                                            // building-side lift-off the center
    var x1=Math.round(bx+ux*BR), y1=Math.round(by+uy*BR);
    // Card-border point where the (card-center -> building) ray exits the card rect.
    var sx=ux!==0?(cw/2)/Math.abs(ux):Infinity, sy=uy!==0?(ch/2)/Math.abs(uy):Infinity, s=Math.min(sx,sy);
    var x2=Math.round(ccx-ux*s), y2=Math.round(ccy-uy*s);
    ln.setAttribute('x1',x1); ln.setAttribute('y1',y1); ln.setAttribute('x2',x2); ln.setAttribute('y2',y2);
  });
  [].forEach.call(svg.querySelectorAll('line'), function(l){ var id=l.id.replace('ngDockWire-',''); if(!document.getElementById('ngDock-'+id)) l.remove(); });
}
// Drag a scope card by its header to place it where you want (offset from the building, in
// graph units so it tracks pan/zoom); persists on release. Bound PER-HEADER with Pointer
// Events + setPointerCapture + stopPropagation so the drag can't leak to the satellite
// basemap pan underneath (which made the card feel "inverted" / not move). node = the child
// node the dock represents; dockEl = its .ng-dock element.
function attachDockDrag(hd, node, dockEl){
  if(!hd || !node || !dockEl || hd._ncDragBound) return;
  hd._ncDragBound=1;
  hd.addEventListener('pointerdown', function(e){
    if(e.button!==0) return;
    if(e.target.closest('[data-nc-dock-toggle],[data-nc-del]')) return;   // caret=collapse, ×=delete — not drag
    e.preventDefault(); e.stopPropagation();
    var z=E.zm()||1, sx=e.clientX, sy=e.clientY;
    var off0=node._ncDockOff?{x:node._ncDockOff.x,y:node._ncDockOff.y}:{x:88,y:-72};
    dockEl.classList.add('ng-dock-dragging');
    try{ hd.setPointerCapture(e.pointerId); }catch(_){}
    function mv(ev){ ev.preventDefault(); node._ncDockOff={x:off0.x+(ev.clientX-sx)/z, y:off0.y+(ev.clientY-sy)/z}; layoutBldgDocks(); }
    function up(){ hd.removeEventListener('pointermove',mv); hd.removeEventListener('pointerup',up); hd.removeEventListener('pointercancel',up); dockEl.classList.remove('ng-dock-dragging'); try{ hd.releasePointerCapture(e.pointerId); }catch(_){}; if(E.saveGraph) E.saveGraph(); }
    hd.addEventListener('pointermove',mv); hd.addEventListener('pointerup',up); hd.addEventListener('pointercancel',up);
  });
}
function renderNestedOverlay(){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  var area=tab.querySelector('.ng-canvas-area')||tab;
  var host=document.getElementById('ngNestedView');
  if(!host){ host=document.createElement('div'); host.id='ngNestedView'; host.className='ng-ncv';
    // Critical layout is set inline (not just via .ng-ncv) so the overlay still stacks
    // above the canvas even if a stale service-worker cache hasn't picked up the CSS yet.
    host.style.cssText='position:absolute;left:0;top:0;right:0;bottom:0;z-index:500;overflow:auto;background:#0e1626;padding:20px 18px;';
    area.appendChild(host);
    ncAttachDnd(host);   // NC-3: drag-a-card-into-another to re-parent
  }
  var btn=document.getElementById('ngNestedToggle');
  if(!btn){
    btn=document.createElement('button'); btn.id='ngNestedToggle'; btn.className='ng-nc-toggle';
    btn.style.cssText='position:absolute;top:10px;right:12px;z-index:501;';
    btn.innerHTML='<span class="ng-nc-tgi">▤</span> Cards'; btn.title='Toggle cost cards on the map';
    btn.addEventListener('click', function(){ window._p86NcDefault=!window._p86NcDefault; if(typeof render==='function') render(); else renderNestedOverlay(); });
    area.appendChild(btn);
  }
  var obtn=document.getElementById('ngOutlineToggle');
  if(!obtn){
    obtn=document.createElement('button'); obtn.id='ngOutlineToggle'; obtn.className='ng-nc-toggle';
    obtn.style.cssText='position:absolute;top:10px;right:96px;z-index:501;';
    obtn.innerHTML='<span class="ng-nc-tgi">≡</span> Outline'; obtn.title='Switch between cards and a compact outline';
    obtn.addEventListener('click', function(){ window._p86NcOutline=!window._p86NcOutline; renderNestedOverlay(); });
    area.appendChild(obtn);
  }
  var on=!!window._p86Nested;
  btn.classList.toggle('ng-nc-on', !!window._p86NcDefault);   // "Cards" now toggles the docked cost-cards-on-map mode
  obtn.style.display = on ? '' : 'none';
  obtn.classList.toggle('ng-nc-on', !!window._p86NcOutline);
  host.classList.toggle('ng-outline', !!window._p86NcOutline);
  host.style.display = on ? 'block' : 'none';
  if(on) renderNestedCards();
  var bp=document.getElementById('ngBldgCards'); if(bp && bp.style.display!=='none' && bp._bId) renderBldgPanel(bp._bId);
  renderBldgDocks();   // NC-5: keep the per-building docked card stacks in sync
}
window.p86NestedRefresh=renderNestedOverlay;
// Nested-card interactions (collapse / delete / select) — delegated once at module load.
document.addEventListener('click', function(e){
  var cb=e.target.closest('[data-nc-coll]');
  if(cb){ e.stopPropagation(); var n=E.findNode(cb.getAttribute('data-nc-coll')); if(n){ n._ncColl=!n._ncColl; ncRefreshOpen(); } return; }
  var dtg=e.target.closest('[data-nc-dock-toggle]');
  if(dtg){ e.stopPropagation(); var db=E.findNode(dtg.getAttribute('data-nc-dock-toggle')); if(db){ db._ncDockOpen=!db._ncDockOpen; renderBldgDocks(); if(E.saveGraph) E.saveGraph(); } return; }
  var del=e.target.closest('[data-nc-del]');
  if(del){ e.stopPropagation(); var dn=E.findNode(del.getAttribute('data-nc-del')); if(dn && typeof showDeleteDialog==='function') showDeleteDialog(dn); return; }
  var sel=e.target.closest('[data-nc-sel]');
  if(sel){ selN=sel.getAttribute('data-nc-sel'); if(typeof renderInspector==='function') renderInspector(); }
});

// NC-3: drag-a-card-into-another to re-parent (re-wire) — the replacement for dragging wires.
var _ncDragId=null, _ncDragParent=null;
function ncCanReparent(childId, parentId){
  if(!childId || !parentId || childId===parentId) return false;
  var c=E.findNode(childId), p=E.findNode(parentId); if(!c||!p) return false;
  var d=E.DEFS[c.type]||{}, grp=(d.cat==='cost')?'cost':c.type;
  if((SPAWN_CHILDREN[p.type]||[]).indexOf(grp)<0) return false;   // parent must accept this child type
  var stack=[childId], seen={};                                    // parent must not be the child's own descendant (cycle guard)
  while(stack.length){ var id=stack.pop(); if(seen[id]) continue; seen[id]=1; getNestedChildren(id).forEach(function(k){ stack.push(k.id); }); }
  return !seen[parentId];
}
function ncReparent(childId, newParentId, oldParentId){
  if(!ncCanReparent(childId, newParentId)) return false;
  var ws=E.wires();
  for(var i=ws.length-1;i>=0;i--){ if(ws[i].fromNode===childId && (!oldParentId || ws[i].toNode===oldParentId)) ws.splice(i,1); }
  var c=E.findNode(childId), p=E.findNode(newParentId);
  var toPort=E.firstCompatPort(E.DEFS[p.type], c.type, 'in');
  ws.push({ fromNode:childId, fromPort:0, toNode:newParentId, toPort:toPort||0 });
  try{
    if(c.type==='t2' && E.rebalancePhaseAllocations) E.rebalancePhaseAllocations(childId);
    else if(c.type==='co' && E.rebalanceCOAllocations) E.rebalanceCOAllocations(childId);
  }catch(e){}
  try{ delete c.spOff; }catch(e){}   // drop stale offset so it re-fans under its new parent's building on the canvas
  if(E.saveGraph) E.saveGraph();
  if(typeof render==='function') render(); else renderNestedCards();
  return true;
}
function ncAttachDnd(host){
  host.addEventListener('dragstart', function(e){
    var card=e.target.closest('.ng-ncard'); if(!card) return;
    var n=E.findNode(card.getAttribute('data-nc'));
    if(!n || n.type==='t1'){ e.preventDefault(); return; }   // buildings are roots — not draggable
    _ncDragId=n.id;
    var pc=card.parentElement && card.parentElement.closest('.ng-ncard');
    _ncDragParent=pc?pc.getAttribute('data-nc'):null;
    try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', n.id); }catch(_){}
    card.classList.add('ng-nc-dragging');
  });
  host.addEventListener('dragover', function(e){
    if(!_ncDragId) return;
    [].forEach.call(host.querySelectorAll('.ng-nc-drop'), function(el){ el.classList.remove('ng-nc-drop'); });
    var card=e.target.closest('.ng-ncard');
    if(card && ncCanReparent(_ncDragId, card.getAttribute('data-nc'))){ e.preventDefault(); try{ e.dataTransfer.dropEffect='move'; }catch(_){} card.classList.add('ng-nc-drop'); }
  });
  host.addEventListener('drop', function(e){
    if(!_ncDragId) return;
    var card=e.target.closest('.ng-ncard');
    if(card){ e.preventDefault(); ncReparent(_ncDragId, card.getAttribute('data-nc'), _ncDragParent); }
    _ncDragId=null; _ncDragParent=null;
  });
  host.addEventListener('dragend', function(){
    _ncDragId=null; _ncDragParent=null;
    [].forEach.call(host.querySelectorAll('.ng-nc-drop'), function(el){ el.classList.remove('ng-nc-drop'); });
    [].forEach.call(host.querySelectorAll('.ng-nc-dragging'), function(el){ el.classList.remove('ng-nc-dragging'); });
  });
}

function applyTx(){
  var p=E.pan(), z=E.zm();
  canvasEl.style.transform='translate('+(p.x*z)+'px,'+(p.y*z)+'px) scale('+z+')';
  if(_spSatellite){
    // Self-heal: the first mount on open can miss (tab not yet sized, or the job/origin
    // not loaded) and leave the user on the "add an address" hint even though the job IS
    // geocoded. Once jobOrigin() resolves, mount it (guarded against re-entry); a no-coords
    // job keeps jobOrigin() null so this never fires — the on-demand geocode path stands.
    if(!_basemap && !_basemapMounting && E.viewMode && E.viewMode()==='siteplan' && jobOrigin()) mountBasemap();
    syncBasemapCamera();   // keep the slaved basemap under the camera
  }
  if(_spPhotos) layoutPhotoPins();        // keep photo pins on their spots
  if(_spTasks) layoutTaskPins();          // keep task pins on their spots
  if(window._p86NcDefault) layoutBldgDocks();  // NC-5: keep each building's docked card stack on its spot
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
  if(!bId) return;
  // On satellite, re-fan EVERY render so children track their building's real geo
  // spot. The old one-shot _fannedSet lock stranded children when the first fan ran
  // before the geo origin was ready (they kept their abstract saved x/y, far off).
  // Off-satellite keeps the once-only behavior so manual moves stick.
  if(!_spSatellite && _fannedSet[bId]) return;
  var b=E.findNode(bId); if(!b) return;
  // Geo origin not resolved yet → skip (don't fan around the tree fallback); retry next render.
  if(b.geoLatLng && !(_spOrigin && _spOriginGraph)) return;
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
  // Slice 4: on satellite the kids are now native-small slim chips (~100x36px), so the
  // ring sits a fixed graph-unit distance off the building (not the old scaled-card math).
  var R = _sat ? Math.max(55, 18*kids.length) : Math.max(220, 56*kids.length);
  var _ox=_sat?23:85, _oy=_sat?5:30;                   // half the scale(0.28) chip, to centre it on the ring point
  var arc=Math.min(330, Math.max(110, kids.length*46));
  var start=270-arc/2;                                  // 270° = above the building (y grows down)
  kids.forEach(function(k,i){
    // Respect a manually-set / spawned offset: keep the node anchored to the building
    // (so it still tracks the building's geo spot) but at the user's chosen position —
    // the per-render re-fan re-applies this instead of clobbering it.
    if(k.spOff){ k.x=Math.round(center.x+k.spOff.x); k.y=Math.round(center.y+k.spOff.y); return; }
    var deg=kids.length>1 ? start+arc*i/(kids.length-1) : 270;
    var a=deg*Math.PI/180;
    k.x=Math.round(center.x + Math.cos(a)*R - _ox);
    k.y=Math.round(center.y + Math.sin(a)*R - _oy);
    k.spOff={x:k.x-center.x, y:k.y-center.y};   // freeze the initial fan spot: stops re-jitter + lets manual moves stick
  });
  _fannedSet[bId]=true;
}
// Whole-site: fan every building's phases/costs around it (each fans once via _fannedSet,
// so manual moves stick). Phases (t2) are visible whole-site now; the costs it also
// positions stay hidden until drill-in, then appear at the same fanned spots.
function fanAllBuildings(){
  E.nodes().forEach(function(n){ if(n.type==='t1') fanFocusNodes(n.id); });
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
      if(_spSatellite && E.viewMode && E.viewMode()==='siteplan'){ mountBasemap(); updatePhotoLayer(); updateTaskLayer(); }
    } else {
      showSatHint(true, 'Add a street address to this job to enable the satellite map.');
    }
  }).catch(function(){ _geocoding=false; showSatHint(true, 'Could not locate the job address.'); });
}
function mountBasemap(){
  if(!basemapEl) return;
  // Stamp the geo origin ONCE per job and FREEZE it. mountBasemap is called on every re-mount
  // (resize → updateBasemapVisibility → mountBasemap), and _spOriginGraph = siteplanCentroid()
  // is the AVERAGE of live node positions — re-deriving it each time made the anchor follow the
  // nodes, so moving a node (or dragging a rail, which triggers resize) snapped every geo-anchored
  // building. Keep the cached anchor for the current job; only (re)stamp on a job change or cold cache.
  if(_spOriginJob!==E.job() || !_spOrigin || !_spOriginGraph){
    _spOrigin=jobOrigin(); _spOriginGraph=siteplanCentroid(); _spOriginJob=E.job();
  }
  if(!_spOrigin){ tryGeocodeJobThenMount(); return; } // no coords yet — geocode on demand, then retry
  showSatHint(false);
  if(_basemap){ _basemapReady=true; syncBasemapCamera(); return; }
  if(_basemapMounting) return;                             // a mount is already in flight (the self-heal can re-call this)
  if(!window.p86Maps){ showSatHint(true, 'Google Maps is not available.'); return; }
  _basemapMounting=true;
  window.p86Maps.ready().then(function(maps){
    _basemapMounting=false;
    if(!_spSatellite) return;                              // toggled off while the SDK loaded
    _basemap=new maps.Map(basemapEl, {
      center:{ lat:_spOrigin.lat, lng:_spOrigin.lng }, zoom:19,
      mapTypeId:(_spBasemapType==='roadmap' ? maps.MapTypeId.ROADMAP : maps.MapTypeId.SATELLITE), tilt:0,
      disableDefaultUI:true, gestureHandling:'none', keyboardShortcuts:false,
      clickableIcons:false, backgroundColor:'#0b0e16', isFractionalZoomEnabled:false
    });
    _basemapReady=true; syncBasemapCamera();
  }).catch(function(e){ _basemapMounting=false; showSatHint(true, (e&&e.message) || 'Satellite basemap unavailable.'); });
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
  // .ng-sat now means "satellite Site Plan is active" (satellite is permanent), NOT
  // "the basemap is painted". Set it for ANY siteplan job — even one with no geocode /
  // no mounted basemap — so the building-card-blanking CSS always fires and buildings
  // render as map polygons (imagery when geocoded, outlines when not), never the old
  // abstract WIP cards. Done before the basemapEl null-check so it can't be skipped.
  var sitePlan = E.viewMode && E.viewMode()==='siteplan';
  var t=document.getElementById('nodeGraphTab');
  if(t) t.classList.toggle('ng-sat', !!sitePlan);
  if(!basemapEl) return;
  var show=_spSatellite && sitePlan;   // _spSatellite is always true now → show === sitePlan
  basemapEl.style.display = show ? 'block' : 'none';
  if(show){ mountBasemap(); } else { showSatHint(false); exitGeoPick(); exitTrace(); exitMeasure(); }
  updatePhotoLayer(); // photos ride on top of satellite — show/hide together
  updateTaskLayer();  // task pins ride alongside photos
  renderPolygons();   // show/hide the building footprint layer with satellite
}

// ── 3D Orbit view (real Google 3D buildings) ───────────────────────────────
// John's "use the view with the buildings on" 3D feel. Tilting the WORKING basemap
// would float its flat node overlay off the buildings (the overlay is screen-space,
// slaved to a 2D projection — see syncBasemapCamera). So instead we drop a SEPARATE,
// fully-interactive vector map OVER the canvas area, centered on the job and tilted
// into Google's 3D buildings. The working map underneath is untouched; Exit just
// hides this layer. Site-plan only + needs a geocoded job.
function toggleOrbit3D(){
  if(_spOrbit){ exitOrbit3D(); return; }
  var o=jobOrigin();
  if(!o){ showSatHint(true,'Add a job address to use the 3D orbit view.'); setTimeout(function(){ showSatHint(false); },2400); return; }
  if(_measuring){ try{ exitMeasure(); }catch(_){} }
  try{ exitGeoPick(); }catch(_){}
  try{ exitTrace(); }catch(_){}
  _spOrbit=true;
  var tab=document.getElementById('nodeGraphTab');
  if(tab) tab.classList.add('ng-orbit-on');
  var ob=tab&&tab.querySelector('.ng-orbit-btn'); if(ob) ob.classList.add('ng-on');
  ensureOrbit3D(o);
  // Re-assert the iframe's inner viewport on every orbit entry — the frame
  // is created once and reused, so if it was last laid out at a stale size
  // (e.g. created during a mid-relaunch small window) this heals it.
  reflowGraphSurfaces();
}
function exitOrbit3D(){
  _spOrbit=false;
  var tab=document.getElementById('nodeGraphTab');
  if(tab) tab.classList.remove('ng-orbit-on');
  var ob=tab&&tab.querySelector('.ng-orbit-btn'); if(ob) ob.classList.remove('ng-on');
}
function ensureOrbit3D(o){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  if(!_orbitEl){
    _orbitEl=document.createElement('div'); _orbitEl.className='ng-orbit-3d';
    // Photorealistic 3D runs in an isolated same-origin iframe (loads Maps beta + Map3DElement).
    var frame=document.createElement('iframe'); frame.className='ng-orbit-3d-frame';
    frame.src='/orbit3d.html?v=9'; frame.setAttribute('title','3D site view'); frame.setAttribute('allow','fullscreen');
    _orbitEl.appendChild(frame); _orbitEl.__frame=frame;
    var exitB=document.createElement('button'); exitB.type='button'; exitB.className='ng-orbit-exit';
    exitB.innerHTML='&#x2715; Exit 3D'; exitB.addEventListener('click', exitOrbit3D); _orbitEl.appendChild(exitB);
    var hint=document.createElement('div'); hint.className='ng-orbit-hint';
    hint.textContent='Photorealistic 3D — drag to look around · scroll to zoom · tap a building’s % pin for its phases & numbers · Exit to return to the working map.';
    _orbitEl.appendChild(hint);
    (tab.querySelector('.ng-canvas-area')||tab).appendChild(_orbitEl);
    // The 3D page posts "ready" once its Maps SDK + tiles are loaded; then we (re)feed it.
    // It also posts "setheight" when the user adjusts a building's 3D elevation
    // from the docked card — persist it on the node and re-feed the scene.
    window.addEventListener('message', function(ev){
      if(ev.origin!==location.origin) return;               // only trust the parent-origin iframe
      if(!ev.data) return;
      if(ev.data.type==='p86-orbit3d-ready'){
        _orbitReady=true;
        if(_spOrbit) postOrbitData();
        return;
      }
      if(ev.data.type==='p86-orbit3d-setheight'){
        var hn=E.nodes().find(function(x){ return x.id===ev.data.nodeId; });
        var hv=Number(ev.data.heightM);
        if(!hn || hn.type!=='t1' || !isFinite(hv)) return;
        hn.heightM=Math.max(1.2, Math.min(120, hv));        // 4ft..~400ft sanity clamp
        try{ if(E.saveGraph) E.saveGraph(); }catch(_){}
        postOrbitData();
        return;
      }
    });
  }
  _orbitPending=o;                    // remember the job origin for postOrbitData
  if(_orbitReady) postOrbitData();    // frame already loaded → (re)feed it now
}
// Feed the 3D iframe the job center + building footprints (t1 node.polygon = lat/lng corners,
// height estimated from stories). The iframe extrudes each as a highlighted 3D block AND
// floats an interactive data pin above it (% complete), with a docked info card on click —
// so the 3D view carries the same working data as the flat map, not just scenery. The
// per-building phases/financials are computed HERE (the iframe never holds app data).
function postOrbitData(){
  var f=_orbitEl && _orbitEl.__frame; if(!f || !f.contentWindow) return;
  var o=_orbitPending || jobOrigin(); if(!o) return;
  var buildings=[];
  E.nodes().forEach(function(n){
    if(n.type!=='t1' || !n.polygon || n.polygon.length<3) return;
    // Phases + change orders wired into this building, with their own %.
    var phases=[];
    try{
      E.wires().forEach(function(w){
        if(w.toNode!==n.id) return;
        var s=E.findNode(w.fromNode);
        if(!s || (s.type!=='t2' && s.type!=='co')) return;
        var nm=(s.data && (s.data.phase || s.data.name || s.data.title)) || s.label || (s.type==='co'?'Change order':'Phase');
        phases.push({ name:String(nm), pct:Math.round(s.pctComplete||0), co:s.type==='co' });
      });
    }catch(_){}
    var total=0, actual=0;
    try{ E.resetComp(); total=E.getOutput(n,0)||0; }catch(_){}
    try{ E.resetComp(); actual=E.getActual(n)||0; }catch(_){}
    buildings.push({
      nodeId: n.id,
      path: n.polygon.map(function(v){ return { lat:Number(v.lat), lng:Number(v.lng) }; }),
      label: n.label||'Building',
      pct: Math.round(n.pctComplete||0),
      // Per-building 3D height: an explicit override (set from the 3D card's
      // stepper, persisted on the node) wins over the levels-derived estimate.
      heightM: (isFinite(n.heightM) && n.heightM>0) ? n.heightM : ((n.levels && n.levels.length) ? n.levels.length*3.2 : 8),
      levels: (n.levels && n.levels.length) || 0,
      units: (function(){ var u=0; try{ (n.levels||[]).forEach(function(l){ u += (l.units && l.units.length) || (Number(l.unitCount)||0); }); }catch(_){} return u; })(),
      total: total,
      actual: actual,
      phases: phases
    });
  });
  try{ f.contentWindow.postMessage({ type:'p86-orbit3d-render', center:{ lat:o.lat, lng:o.lng }, buildings:buildings }, location.origin); }catch(_){}
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
  if(_measuring) exitMeasure();
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
      // A saved-measurement label/✕ mousedown must NOT bubble to the wrap-level
      // handler (which would deselect the current building + arm pan before our
      // click handler runs). Swallow it here; the 'click' listener does the work.
      if(e.target.closest && e.target.closest('[data-mdel],[data-mrename]')){ e.stopPropagation(); return; }
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
    // Saved-measurement management: ✕ deletes, label renames. (Only reachable when
    // not actively measuring — the measure overlay sits above and eats clicks then.)
    _polyLayer.addEventListener('click',function(e){
      var del=e.target.closest && e.target.closest('[data-mdel]');
      if(del){ e.stopPropagation(); e.preventDefault(); var mid=del.getAttribute('data-mdel');
        if(E.removeMeasurement) E.removeMeasurement(mid); if(E.saveGraph) E.saveGraph(); renderPolygons(); return; }
      var rn=e.target.closest && e.target.closest('[data-mrename]');
      if(rn){ e.stopPropagation(); var rid=rn.getAttribute('data-mrename'); var mm=E.findMeasurement&&E.findMeasurement(rid); if(!mm) return;
        var nv=prompt('Rename measurement', mm.label||''); if(nv!=null){ mm.label=String(nv).trim(); if(E.saveGraph) E.saveGraph(); renderPolygons(); } return; }
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
    // Footprint area (sq ft) under the % — computed from the traced lat/lng path.
    var _fa=measureStats(n.polygon);
    if(_fa.areaSqft>0){
      var sq=document.createElementNS(_SVGNS,'text');
      sq.setAttribute('x', cx); sq.setAttribute('y', cy+16); sq.setAttribute('class','ng-poly-sqft');
      sq.textContent=fmtSqft(_fa.areaSqft);
      _polyLayer.appendChild(sq);
    }
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
  // Saved survey measurements — persisted distance/area shapes with labels. Drawn
  // whenever the satellite site plan is up (independent of an active measure session)
  // so they re-project every pan/zoom. Each label is clickable to rename and carries
  // a ✕ to delete; both routed by the _polyLayer click listener above.
  (E.measurements ? E.measurements() : []).forEach(function(m){
    if(!m || !m.pts || m.pts.length<2) return;
    var sIsArea=(m.mode==='area');
    var spts=m.pts.map(function(v){ return gp(v); });
    var sstr=spts.map(function(p){ return p.x+','+p.y; }).join(' ');
    if(sIsArea && spts.length>=3){
      var spg=document.createElementNS(_SVGNS,'polygon');
      spg.setAttribute('points', sstr); spg.setAttribute('class','ng-measure-poly ng-msaved');
      _polyLayer.appendChild(spg);
    } else {
      var spl=document.createElementNS(_SVGNS,'polyline');
      spl.setAttribute('points', sstr); spl.setAttribute('class','ng-measure-line ng-msaved');
      _polyLayer.appendChild(spl);
    }
    spts.forEach(function(p){
      var sc=document.createElementNS(_SVGNS,'circle');
      sc.setAttribute('cx',p.x); sc.setAttribute('cy',p.y); sc.setAttribute('r',2.6);
      sc.setAttribute('class','ng-measure-vert ng-msaved-vert');
      _polyLayer.appendChild(sc);
    });
    var sst=measureStats(m.pts);
    var pf=(sIsArea && m.pitch>0) ? Math.sqrt(1+(m.pitch/12)*(m.pitch/12)) : 1;
    var val=sIsArea ? fmtSqft(sst.areaSqft*pf) : fmtFt(sst.lengthFt);
    var lx, ly;
    if(sIsArea && spts.length>=3){ var scx=0,scy=0; spts.forEach(function(p){ scx+=p.x; scy+=p.y; }); lx=scx/spts.length; ly=scy/spts.length; }
    else { var lp=spts[spts.length-1]; lx=lp.x+6; ly=lp.y-6; }
    var lbl=document.createElementNS(_SVGNS,'text');
    lbl.setAttribute('x', lx); lbl.setAttribute('y', ly);
    lbl.setAttribute('class','ng-msaved-lbl'+(sIsArea?' ng-msaved-lbl-area':''));
    lbl.setAttribute('data-mrename', m.id);
    lbl.textContent=(m.label? m.label+': ':'')+val;
    _polyLayer.appendChild(lbl);
    var del=document.createElementNS(_SVGNS,'text');
    del.setAttribute('x', lx); del.setAttribute('y', ly-11);
    del.setAttribute('class','ng-msaved-del'+(sIsArea?' ng-msaved-lbl-area':''));
    del.setAttribute('data-mdel', m.id);
    del.textContent='✕';
    _polyLayer.appendChild(del);
  });
  // Measure overlay graphics — distance polyline (per-segment ft) or area polygon
  // (sq ft at centroid). Drawn here so it re-projects with every pan/zoom render.
  if(_measuring && _measurePts.length){
    var mpts=_measurePts.map(function(v){ return gp(v); });
    var mIsArea=(_measureMode==='area');
    var mstr=mpts.map(function(p){ return p.x+','+p.y; }).join(' ');
    if(mIsArea && mpts.length>=3){
      var mpg=document.createElementNS(_SVGNS,'polygon');
      mpg.setAttribute('points', mstr); mpg.setAttribute('class','ng-measure-poly');
      _polyLayer.appendChild(mpg);
    } else if(mpts.length>=2){
      var mpl=document.createElementNS(_SVGNS,'polyline');
      mpl.setAttribute('points', mstr); mpl.setAttribute('class','ng-measure-line');
      _polyLayer.appendChild(mpl);
    }
    var mstat=measureStats(_measurePts);
    if(!mIsArea){
      for(var msi=1;msi<mpts.length;msi++){
        var aMid=mpts[msi-1], bMid=mpts[msi];
        var tx=document.createElementNS(_SVGNS,'text');
        tx.setAttribute('x',(aMid.x+bMid.x)/2); tx.setAttribute('y',(aMid.y+bMid.y)/2-2);
        tx.setAttribute('class','ng-measure-seglbl'); tx.textContent=fmtFt(mstat.segFt[msi-1]);
        _polyLayer.appendChild(tx);
      }
    }
    mpts.forEach(function(p,i){
      var mc=document.createElementNS(_SVGNS,'circle');
      mc.setAttribute('cx',p.x); mc.setAttribute('cy',p.y); mc.setAttribute('r',3.2);
      mc.setAttribute('class','ng-measure-vert'+(i===0?' ng-measure-vert0':''));
      _polyLayer.appendChild(mc);
    });
    if(mIsArea && mpts.length>=3){
      var mcx=0,mcy=0; mpts.forEach(function(p){ mcx+=p.x; mcy+=p.y; }); mcx/=mpts.length; mcy/=mpts.length;
      var atx=document.createElementNS(_SVGNS,'text');
      atx.setAttribute('x',mcx); atx.setAttribute('y',mcy); atx.setAttribute('class','ng-measure-arealbl');
      atx.textContent=fmtSqft(mstat.areaSqft*_pitchFactor());
      _polyLayer.appendChild(atx);
    } else if(!mIsArea && mpts.length>=2){
      var lp=mpts[mpts.length-1];
      var ltx=document.createElementNS(_SVGNS,'text');
      ltx.setAttribute('x',lp.x+6); ltx.setAttribute('y',lp.y-6); ltx.setAttribute('class','ng-measure-totlbl');
      ltx.textContent=fmtFt(mstat.lengthFt);
      _polyLayer.appendChild(ltx);
    }
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
  if(_measuring) exitMeasure();
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

// ── Measure tool: real distance + area on the satellite imagery ──────────
// Computes in the SAME equirectangular meter frame the renderer/engine use, so a
// measured length matches the drawn line exactly at any zoom. Points are captured
// as lat/lng (pickLatLngFromEvent), drawn into _polyLayer each renderPolygons(),
// and read out live in a floating panel. Ephemeral — nothing is persisted.
function _llMeters(lat,lng,oLat,oLng){
  var my=(oLat-lat)*111320;
  var mx=(lng-oLng)*111320*Math.cos(oLat*Math.PI/180);
  return { mx:mx, my:my };
}
function measureStats(pts){
  var out={ lengthFt:0, closedFt:0, areaSqft:0, segFt:[] };
  if(!pts || pts.length<2) return out;
  var o=pts[0];
  var m=pts.map(function(v){ return _llMeters(Number(v.lat), Number(v.lng), o.lat, o.lng); });
  for(var i=1;i<m.length;i++){
    var d=Math.hypot(m[i].mx-m[i-1].mx, m[i].my-m[i-1].my)*3.28084;
    out.lengthFt+=d; out.segFt.push(d);
  }
  if(m.length>=3){
    var a=0;
    for(var j=0;j<m.length;j++){ var p=m[j], q=m[(j+1)%m.length]; a+=(p.mx*q.my - q.mx*p.my); }
    out.areaSqft=Math.abs(a)/2*10.7639;
    var last=m[m.length-1];
    out.closedFt=out.lengthFt + Math.hypot(last.mx-m[0].mx, last.my-m[0].my)*3.28084;
  }
  return out;
}
function _pitchFactor(){ var r=Number(_measureRoofPitch)||0; return r>0 ? Math.sqrt(1+(r/12)*(r/12)) : 1; }
function fmtFt(ft){ ft=Number(ft)||0; if(ft>=5280) return (ft/5280).toFixed(2)+' mi'; return (ft<100?ft.toFixed(1):Math.round(ft).toLocaleString())+' ft'; }
function fmtSqft(a){ a=Number(a)||0; if(a>=43560) return (a/43560).toFixed(2)+' ac'; return Math.round(a).toLocaleString()+' sq ft'; }

function ensureMeasureOverlay(){
  if(_measureOverlay) return _measureOverlay;
  _measureOverlay=document.createElement('div');
  _measureOverlay.className='ng-geopick-overlay';            // reuse the crosshair overlay styling
  _measureOverlay.addEventListener('mousedown',function(e){ e.stopPropagation(); });
  _measureOverlay.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
  _measureOverlay.addEventListener('mouseup',function(e){ e.stopPropagation(); });
  _measureOverlay.addEventListener('click',function(e){
    if(!_measuring || !_spOrigin || !_spOriginGraph) return;
    _measurePts.push(pickLatLngFromEvent(e));
    // Line mode = discrete point-to-point: the 2nd click closes ONE segment,
    // which auto-saves and starts a fresh, disconnected measurement for the
    // next two clicks. Poly/Area chain points until Save/Done/Esc.
    if(_measureMode==='line' && _measurePts.length>=2){ commitMeasurement(false); return; }
    renderPolygons(); updateMeasurePanel();
  });
  _measureOverlay.addEventListener('dblclick',function(e){
    e.preventDefault();
    if(_measurePts.length>=2) _measurePts.pop();             // drop the dup the dblclick just added
    renderPolygons(); updateMeasurePanel();
  });
  wrap.appendChild(_measureOverlay);
  return _measureOverlay;
}
function buildMeasurePanel(){
  if(_measurePanel) return _measurePanel;
  var d=document.createElement('div'); d.className='ng-measure-panel';
  d.innerHTML=
    '<div class="ng-measure-modes">'+
      '<button type="button" data-mmode="line" class="ng-on">Line</button>'+
      '<button type="button" data-mmode="poly">Poly</button>'+
      '<button type="button" data-mmode="area">Area</button>'+
    '</div>'+
    '<div class="ng-measure-pitchrow" style="display:none;">'+
      '<label>Roof pitch</label>'+
      '<select class="ng-measure-pitch">'+
        '<option value="0">Flat / ground</option>'+
        '<option value="4">4 / 12</option>'+
        '<option value="6">6 / 12</option>'+
        '<option value="8">8 / 12</option>'+
        '<option value="10">10 / 12</option>'+
        '<option value="12">12 / 12</option>'+
      '</select>'+
    '</div>'+
    '<div class="ng-measure-readout">Tap points on the map…</div>'+
    '<div class="ng-measure-actions">'+
      '<button type="button" data-mact="undo">Undo</button>'+
      '<button type="button" data-mact="clear">Clear</button>'+
      '<button type="button" data-mact="save">Save</button>'+
      '<button type="button" data-mact="done">Done</button>'+
    '</div>';
  // Keep clicks on the panel from reaching the engine canvas behind it.
  d.addEventListener('mousedown',function(e){ e.stopPropagation(); });
  d.addEventListener('click',function(e){ e.stopPropagation(); });
  d.querySelectorAll('[data-mmode]').forEach(function(b){
    b.addEventListener('click',function(){
      _measureMode=b.getAttribute('data-mmode');
      _measurePts=[];   // switching styles starts a fresh measurement
      d.querySelectorAll('[data-mmode]').forEach(function(x){ x.classList.toggle('ng-on', x===b); });
      var pr=d.querySelector('.ng-measure-pitchrow'); if(pr) pr.style.display=(_measureMode==='area')?'flex':'none';
      renderPolygons(); updateMeasurePanel();
    });
  });
  var ps=d.querySelector('.ng-measure-pitch');
  if(ps) ps.addEventListener('change',function(){ _measureRoofPitch=Number(ps.value)||0; renderPolygons(); updateMeasurePanel(); });
  d.querySelector('[data-mact="undo"]').addEventListener('click',function(){ _measurePts.pop(); renderPolygons(); updateMeasurePanel(); });
  d.querySelector('[data-mact="clear"]').addEventListener('click',function(){ _measurePts=[]; renderPolygons(); updateMeasurePanel(); });
  d.querySelector('[data-mact="save"]').addEventListener('click',function(){ commitMeasurement(false); }); // save & keep measuring
  d.querySelector('[data-mact="done"]').addEventListener('click',function(){ commitMeasurement(true); });  // save (if valid) & close
  wrap.appendChild(d);
  _measurePanel=d;
  return d;
}
function updateMeasurePanel(){
  if(!_measurePanel) return;
  var ro=_measurePanel.querySelector('.ng-measure-readout'); if(!ro) return;
  var s=measureStats(_measurePts);
  if(_measureMode==='area'){
    if(_measurePts.length<3){ ro.textContent='Tap 3+ points to enclose an area…'; return; }
    var pf=_pitchFactor();
    var txt='Area: '+fmtSqft(s.areaSqft)+'  ·  Perimeter: '+fmtFt(s.closedFt);
    ro.innerHTML = txt + (pf>1 ? ('<br><span class="ng-measure-roof">Roof @ '+_measureRoofPitch+'/12: '+fmtSqft(s.areaSqft*pf)+'</span>') : '');
  } else if(_measureMode==='line'){
    if(_measurePts.length<1){ ro.textContent='Tap 2 points — each pair is its own measurement…'; return; }
    ro.textContent='Tap the second point…';
  } else { // poly — connected path, total length across all points
    if(_measurePts.length<2){ ro.textContent='Tap points to trace a path (Esc / Done ends it)…'; return; }
    ro.textContent='Length: '+fmtFt(s.lengthFt)+'   ('+_measurePts.length+' pts)';
  }
}
// Commit the active measure draft into the persisted measurements[] (survives reload
// via the graph blob + carries into the job). exit=true also leaves measure mode
// ("Done" = save & close); exit=false keeps measuring so several can be captured in a
// row ("Save"). An invalid/partial draft is a no-op on Save; Done still just closes it.
function commitMeasurement(exit){
  var isArea = (_measureMode==='area');
  var valid = isArea ? _measurePts.length>=3 : _measurePts.length>=2;
  if(!valid){ if(exit){ exitMeasure(); renderPolygons(); } return; }
  if(E.addMeasurement){
    // Line + Poly both persist as a 'distance' measurement (open path); Area as
    // 'area'. The saved-measurement renderer keys on 'distance'|'area', so the
    // draw-mode split (line vs poly) is purely an input style.
    var storedMode = isArea ? 'area' : 'distance';
    var existing = E.measurements ? E.measurements() : [];
    var n = existing.filter(function(x){ return x.mode===storedMode; }).length + 1;
    E.addMeasurement({
      mode:storedMode,
      pts:_measurePts.map(function(v){ return { lat:Number(v.lat), lng:Number(v.lng) }; }),
      pitch:(isArea ? (Number(_measureRoofPitch)||0) : 0),
      label:(isArea?'Area ':'Distance ')+n
    });
    if(E.saveGraph) E.saveGraph();
  }
  _measurePts=[];
  if(exit){ exitMeasure(); }
  renderPolygons();
  if(!exit && _measurePanel) updateMeasurePanel();
}
function exitMeasure(){
  _measuring=false; _measurePts=[];
  var mb=document.getElementById('ngMeasureBtn'); if(mb) mb.classList.remove('ng-on');
  if(_measureOverlay) _measureOverlay.style.display='none';
  if(_measurePanel){ _measurePanel.remove(); _measurePanel=null; }
  if(_measureKeyHandler){ document.removeEventListener('keydown', _measureKeyHandler, true); _measureKeyHandler=null; }
}
function toggleMeasure(){
  if(!_spSatellite) return;
  if(_measuring){ exitMeasure(); renderPolygons(); return; }
  if(_tracing) exitTrace();
  if(_geoPick) exitGeoPick();
  _spOrigin=_spOrigin||jobOrigin(); _spOriginGraph=_spOriginGraph||siteplanCentroid();
  if(!_spOrigin){ showSatHint(true); return; }
  _measuring=true; _measureMode='line'; _measurePts=[];
  var mb=document.getElementById('ngMeasureBtn'); if(mb) mb.classList.add('ng-on');
  ensureMeasureOverlay().style.display='block';
  buildMeasurePanel(); updateMeasurePanel();
  // Esc ENDS the in-progress shape: a valid poly/area (or 2-pt line) commits and
  // a fresh one begins; with nothing drawn, Esc exits the tool. Capture-phase so
  // it wins before other handlers; removed in exitMeasure.
  _measureKeyHandler=function(e){
    if(e.key!=='Escape') return;
    e.preventDefault(); e.stopPropagation();
    var need=(_measureMode==='area')?3:2;
    if(_measurePts.length>=need){ commitMeasurement(false); }   // end (commit) the current shape, keep measuring
    else { exitMeasure(); renderPolygons(); }                   // nothing to end → leave the tool
  };
  document.addEventListener('keydown', _measureKeyHandler, true);
  renderPolygons();
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
// ── Geolocated task pins (filterable) — same projection + lifecycle as photo pins.
function taskScreenPos(t){
  // Use the DISPLAY coords (_dlat/_dlng) — own pin when set, else the job's
  // location (assigned in loadGeoTasks). Falls back to raw lat/lng defensively.
  var la=(t._dlat!=null)?t._dlat:t.lat, ln=(t._dlng!=null)?t._dlng:t.lng;
  var g=E.spLatLngToGraph(Number(la), Number(ln), _spOrigin.lat, _spOrigin.lng);
  var z=E.zm(), p=E.pan();
  return { x:(p.x + _spOriginGraph.x + g.x)*z, y:(p.y + _spOriginGraph.y + g.y)*z };
}
function ensureTaskPinsLayer(){
  if(_taskPinsEl) return _taskPinsEl;
  _taskPinsEl=document.createElement('div');
  _taskPinsEl.className='ng-taskpins';
  wrap.appendChild(_taskPinsEl);
  return _taskPinsEl;
}
function layoutTaskPins(){
  if(!_taskPinsEl || !_spTasks || !_spOrigin || !_spOriginGraph) return;
  if(!_spSatellite || (E.viewMode && E.viewMode()!=='siteplan')) return;
  var pins=_taskPinsEl.children;
  for(var i=0;i<pins.length && i<_geoTasks.length;i++){
    var s=taskScreenPos(_geoTasks[i]);
    pins[i].style.left=s.x+'px'; pins[i].style.top=s.y+'px';
  }
}
function renderTaskPins(){
  var layer=ensureTaskPinsLayer();
  layer.innerHTML='';
  _geoTasks.forEach(function(t){
    var done=t.status==='done';
    var hot=!done && (t.priority==='urgent'||t.priority==='high');
    var pin=document.createElement('div');
    pin.className='ng-taskpin '+(done?'ng-taskpin-done':(hot?'ng-taskpin-hot':'ng-taskpin-open'))+(t._defaultLoc?' ng-taskpin-default':'');
    pin.title=(t.title||'Task')+(t._defaultLoc?' · at job (default location)':'')+(t.due_date?(' · due '+String(t.due_date).slice(0,10)):'');
    pin.innerHTML='<span class="ng-taskpin-dot"></span>';
    pin.addEventListener('click', function(e){
      e.stopPropagation();
      if(window.p86Tasks && window.p86Tasks.openDetail) window.p86Tasks.openDetail(t.id);
    });
    layer.appendChild(pin);
  });
  layoutTaskPins();
}
function loadGeoTasks(cb){
  var jid=E.job();
  if(!jid || typeof p86Api==='undefined' || !p86Api.tasks){ _geoTasks=[]; if(cb)cb(); return; }
  if(_geoTasksJob===jid){ if(cb)cb(); return; } // cached per job
  p86Api.tasks.list({ entity_type:'job', entity_id:jid, limit:200 }).then(function(resp){
    var rows=(resp && resp.tasks) || [], ok=[], dflt=0;
    var origin=_spOrigin; // the job's geocoded location — the default when a task has no pin
    rows.forEach(function(t){
      var lat=Number(t.lat), lng=Number(t.lng);
      var own=isFinite(lat)&&isFinite(lng)&&!(lat===0&&lng===0)&&lat>=-90&&lat<=90&&lng>=-180&&lng<=180;
      if(own){ t._dlat=lat; t._dlng=lng; t._defaultLoc=false; ok.push(t); return; }
      // No pin of its own → fall back to the job's location (the editor default),
      // scattered slightly by index so multiple unpinned tasks don't stack.
      if(origin){
        var k=dflt++, ring=1+Math.floor(k/8), ang=(k%8)*(Math.PI/4), r=0.00004*ring;
        t._dlat=origin.lat + r*Math.cos(ang);
        t._dlng=origin.lng + r*Math.sin(ang);
        t._defaultLoc=true; ok.push(t);
      }
    });
    _geoTasks=ok; _geoTasksJob=jid; if(cb)cb();
  }).catch(function(){ _geoTasks=[]; if(cb)cb(); });
}
function updateTaskLayer(){
  var show=_spTasks && _spSatellite && E.viewMode && E.viewMode()==='siteplan';
  if(!show){ if(_taskPinsEl) _taskPinsEl.style.display='none'; return; }
  if(_spOriginJob!==E.job()){ _spOrigin=jobOrigin(); _spOriginGraph=siteplanCentroid(); _spOriginJob=E.job(); }
  if(!_spOrigin){ return; }
  if(_taskPinsEl) _taskPinsEl.style.display='block';
  loadGeoTasks(function(){ renderTaskPins(); });
}
// Force a re-fetch of task pins next updateTaskLayer (after a task pin is edited).
function invalidateGeoTasks(){ _geoTasksJob=null; if(_spTasks) updateTaskLayer(); }
window.p86NGTasksRefresh = invalidateGeoTasks;

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
  var hasGeo=isFinite(lat)&&isFinite(lng);
  var loc=hasGeo ? (' at '+lat.toFixed(5)+', '+lng.toFixed(5)) : '';
  var notes='Created from a geotagged field photo'+loc+'.'+(ph.thumb_url?('\nPhoto: '+ph.thumb_url):'');
  // Carry the photo's GPS onto the task so it drops a pin on the map too.
  var payload={ title:title, notes:notes, entity_type:'job', entity_id:jid };
  if(hasGeo){ payload.lat=lat; payload.lng=lng; if(ph.geo_accuracy!=null) payload.geo_accuracy=Number(ph.geo_accuracy); }
  p86Api.tasks.create(payload)
    .then(function(){ showSatHint(true, '✓ Task created: '+title); invalidateGeoTasks(); })
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
function openEntityCreateModal(type, cb, preselectId){
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
  // PO + CO are server-backed entities now (appData.jobPurchaseOrders /
  // jobChangeOrders) with dedicated full-screen editors — NOT the legacy
  // inline addPOModal/addCOModal that wrote to the dead appData.purchaseOrders
  // /changeOrders stores. Route "+ Create New" to the modern editor; the new
  // record lands in the right-panel list (the source of truth). We don't
  // auto-create a wired cost node here (the editor is async/full-screen) —
  // wiring an existing PO/CO as a canvas node is the picker path, a separate
  // follow-up. cb(null) so pickNodeType doesn't spawn an orphan node.
  if(type==='po' && window.p86PurchaseOrders && typeof window.p86PurchaseOrders.openNew==='function'){
    window.p86PurchaseOrders.openNew(E.job()); return cb(null);
  }
  if(type==='co' && window.p86ChangeOrders && typeof window.p86ChangeOrders.openNew==='function'){
    window.p86ChangeOrders.openNew(E.job()); return cb(null);
  }
  var spec=CREATE_MODAL[type]; if(!spec) return cb(null);
  var fn=window[spec.opener];
  var modalEl=document.getElementById(spec.modal);
  if(typeof fn!=='function' || !modalEl) return cb(null);
  // Snapshot existing IDs so we can detect the new entry after save
  var before={};
  getJobEntries(type).forEach(function(e){ before[e.id]=1; });
  // Preselect the building the scope is being spawned under, so the "Create New
  // Scope" modal doesn't open on "-- Select Building --" and save a scope with
  // no building link (the "added scope doesn't show under the building" bug).
  // Openers that don't take a preselect simply ignore the arg.
  fn(preselectId);
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
// Add a node of the given type — shared by the ribbon "+ Add" menu (and formerly the
// left palette). Building (t1) initiates a footprint trace in satellite Site Plan;
// data-backed types (PICKABLE_TYPES) open the entity picker; others drop at view center.
function pickNodeType(type){
  var d=E.DEFS[type]; if(!d) return;
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

function buildSidebar(){
  var sb=document.querySelector('.ng-sidebar'); if(!sb) return;
  var html='<div class="ng-sidebar-header">' +
    '<span class="ng-sidebar-header-text">Overview</span>' +
    '<button class="ng-sidebar-toggle" id="ngSidebarToggle" title="Collapse">◀</button>' +
    '</div>';
  // Slice 2: live job-overview card atop the rail (reuses p86EntityCard, painted by renderSidebarJobCard()).
  html+='<div class="ng-sidebar-jobcard"></div>';
  // Site Plan rework: live WIP-metrics panel (shown only in satellite Site Plan via
  // CSS). Body is filled by renderSidebarMetrics() on every render; chips inside are
  // click-to-edit (same data-wip-edit path as the old WIP card).
  html+='<div class="ng-sp-metrics"><div class="ng-sp-metrics-head">Project WIP</div><div class="ng-sp-metrics-body"></div></div>';
  // Per-building cost panel (S2) — shown when a building polygon is selected.
  html+='<div class="ng-sp-bldg"><div class="ng-sp-metrics-head">Building · <span class="ng-sp-bldg-name"></span></div><div class="ng-sp-bldg-body"></div><button class="ng-sp-addcost">+ Add Cost</button><div class="ng-sp-struct"></div></div>';
  // Node library moved to the ribbon "+ Add" menu (pickNodeType); this rail is now the
  // job-overview surface (WIP + per-building panels today; full job overview in Slice 2).
  sb.innerHTML=html;

  // Restore collapsed state from previous session.
  try { if (localStorage.getItem('ngSidebarCollapsed')==='1') sb.classList.add('ng-collapsed'); } catch(e){}
  var tog=document.getElementById('ngSidebarToggle');
  function syncToggle(){
    var c=sb.classList.contains('ng-collapsed');
    if(tog){ tog.innerHTML=c?'▶':'◀'; tog.title=c?'Expand':'Collapse'; }
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
      _drawWires();
    }
  });

  sb.addEventListener('click',function(e){
    // WIP-panel financial chip → inline-edit the JOB field (WIP lives on the job now).
    var jchip=e.target.closest('[data-job-edit]');
    if(jchip && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); jobFieldEdit(jchip); return; }
    // Legacy WIP-node chip (still used by the on-canvas WIP card in non-satellite mode).
    var wchip=e.target.closest('[data-wip-edit]');
    if(wchip && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); wipChipEdit(wchip); return; }
    // Slice 4: left job-card "Edit details" → classic job editor (job meta: name/client/address/dates/notes).
    var jact=e.target.closest('[data-jobact]');
    if(jact){ e.preventDefault(); e.stopPropagation();
      if(jact.getAttribute('data-jobact')==='edit' && typeof window.openJobClassicEditor==='function') window.openJobClassicEditor(E.job());
      return;
    }
    // S4: "+ Add Cost" on the selected-building panel → cost-type picker wired to it.
    var addc=e.target.closest('.ng-sp-addcost');
    if(addc){ e.preventDefault(); e.stopPropagation(); var sn=selN&&E.findNode(selN); if(sn&&sn.type==='t1'){ var br=addc.getBoundingClientRect(); addCostToBuilding(sn.id, br.left, br.bottom+4); } return; }
    // L/U Phase 1: levels & units controls on the building panel.
    var luEl=e.target.closest('[data-lu-act]');
    if(luEl){
      e.preventDefault(); e.stopPropagation();
      var bn=selN&&E.findNode(selN); if(!bn||bn.type!=='t1') return;
      var _act=luEl.getAttribute('data-lu-act'), _lid=luEl.getAttribute('data-id');
      // Percent editing is read-first: a cube / level-% opens a small % popover;
      // a segment click on a unit-less level jumps it straight to seg×20.
      if(_act==='unit-pop'){ openLuPctPop(bn,'unit',_lid,luEl); return; }
      if(_act==='lvl-pop'){ openLuPctPop(bn,'level',_lid,luEl); return; }
      if(_act==='lvl-seg'){ luSetPct(bn,'level',_lid,(parseInt(luEl.getAttribute('data-seg'),10)||0)*20); if(E.saveGraph) E.saveGraph(); luRefresh(); return; }
      luApply(bn, _act, _lid);
      if(E.saveGraph) E.saveGraph(); luRefresh();
      return;
    }
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
// WIP now lives on the JOB (getJobWIP), not a node-graph WIP hub — so the panel reads
// job-level WIP and shows real numbers even on a graph that has no WIP node (e.g. a
// freshly-traced Site Plan). The financial inputs edit the job fields directly.
var _jobChipEditing=false;
// Slice 2: paint the live job-overview card at the top of the left rail — same
// p86EntityCard view-model the app subnav uses (paintJobSubnavCard), fed by getJobWIP.
function renderSidebarJobCard(){
  var host=document.querySelector('.ng-sidebar-jobcard'); if(!host) return;
  var jid=E.job();
  var job=(typeof appData!=='undefined' && appData.jobs) ? appData.jobs.find(function(j){return j.id===jid;}) : null;
  if(!job || !window.p86EntityCard){ host.innerHTML=''; return; }
  var w=(typeof window.getJobWIP==='function') ? (window.getJobWIP(jid)||{}) : {};
  var sm=function(n){ n=Number(n)||0; var a=Math.abs(n), s=n<0?'-':''; if(a>=1e6) return s+'$'+(a/1e6).toFixed(1).replace(/\.0$/,'')+'M'; if(a>=1e3) return s+'$'+Math.round(a/1e3)+'k'; return s+'$'+Math.round(a); };
  var statusCol=window.p86EntityCard.jobStatusColor?window.p86EntityCard.jobStatusColor(job.status):'#8aa0c0';
  var accentCol=(window.p86EntityCard.pinColor?window.p86EntityCard.pinColor(job,'job'):null)||statusCol;
  var profit=(w.displayProfit!=null)?w.displayProfit:0;
  var contract=(w.contractIncome!=null)?w.contractIncome:(w.totalIncome!=null)?w.totalIncome:(Number(job.contractAmount)||0);
  host.innerHTML=window.p86EntityCard.render({
    kind:'job', accent:accentCol, status:{label:job.status||'In Progress', color:statusCol},
    number:job.jobNumber||'', title:job.title||job.name||'', subtitle:job.client||'',
    ring:{pct:(w.pctComplete||0)},
    stats:[
      {label:'Contract', value:sm(contract)},
      {label:'Profit', value:(profit<0?'-':'+')+sm(Math.abs(profit)), tone:profit<0?'neg':'pos'}
    ]
  }, {compact:true})+
    '<div class="ng-jobcard-actions"><button class="ng-jobcard-btn" data-jobact="edit" title="Edit job details — name, client, address, dates, notes">Edit details</button></div>';
}
function renderSidebarMetrics(){
  if(!(E.viewMode && E.viewMode()==='siteplan')) return; // Site Plan only (the left rail is the job overview there)
  renderSidebarJobCard();                                 // Slice 2: live job-overview card atop the rail
  var body=document.querySelector('.ng-sp-metrics-body'); if(!body) return;
  if(_jobChipEditing && body.querySelector('input')) return;             // mid-edit: don't clobber the focused input
  var h=wipPanelHtml();
  body.innerHTML = (h!=null) ? h : '<div class="ng-sp-metrics-empty">No job loaded</div>';
}
// Project WIP panel HTML — editable job-financial inputs + KPI tiles from getJobWIP.
// Extracted so the legacy left sidebar AND the new right Inspector render the same WIP.
function wipPanelHtml(){
  var jid=E.job();
  var job=(typeof appData!=='undefined' && appData.jobs) ? appData.jobs.find(function(j){return j.id===jid;}) : null;
  if(!job || typeof window.getJobWIP!=='function') return null;
  var w=window.getJobWIP(jid)||{};
  // Editable job-financial inputs (write straight to the job; CO totals are derived).
  var h='<div class="ng-subitems" style="max-height:none;">';
  [
    {f:'contractAmount',     l:'Contract Amount', t:'c', edit:true},
    {f:'coIncome',           l:'CO Income',       t:'c', edit:false, val:w.coIncome},
    {f:'estimatedCosts',     l:'Est. Costs',      t:'c', edit:true},
    {f:'coCosts',            l:'CO Costs',        t:'c', edit:false, val:w.coCosts},
    {f:'revisedCostChanges', l:'Revised Changes', t:'c', edit:true},
    {f:'invoicedToDate',     l:'Invoiced to Date',t:'c', edit:true},
    {f:'pctComplete',        l:'% Complete',      t:'p', edit:true}
  ].forEach(function(r){
    var raw=(r.val!=null)?r.val:(job[r.f]||0);
    var disp=r.t==='p'?(Number(raw)||0).toFixed(1)+'%':E.fmtC(Number(raw)||0);
    if(r.edit){
      h+='<div class="ng-subitem ng-wip-row"><span class="ng-wip-lbl">'+r.l+'</span><span class="ng-wip-chip" data-job-edit="'+r.f+'" data-job-type="'+r.t+'" title="Click to edit">'+disp+'</span></div>';
    } else {
      h+='<div class="ng-subitem ng-wip-row"><span class="ng-wip-lbl">'+r.l+'</span><span class="ng-wip-chip" title="From change orders" style="cursor:default;opacity:0.85;">'+disp+'</span></div>';
    }
  });
  h+='</div>';
  // KPI tiles straight from getJobWIP — job-level WIP, independent of any WIP node.
  function _c(v){ return v>0?'ng-ov-pos':v<0?'ng-ov-neg':'ng-ov-zero'; }
  var tiles=[
    {n:'Total Income',  v:E.fmtC(w.totalIncome||0),     c:_c(w.totalIncome||0),     hero:true},
    {n:'Revised Costs', v:E.fmtC(w.revisedEstCosts||0), c:_c(-(w.revisedEstCosts||0))},
    {n:'Actual Costs',  v:E.fmtC(w.actualCosts||0),     c:_c(-(w.actualCosts||0))},
    {n:'Revenue Earned',v:E.fmtC(w.revenueEarned||0),   c:_c(w.revenueEarned||0)},
    {n:'Gross Profit',  v:E.fmtC(w.displayProfit||0),       c:_c(w.displayProfit||0),       hero:true},
    {n:'Margin JTD',    v:(Number(w.jtdMargin)||0).toFixed(1)+'%', c:_c(w.jtdMargin||0)},
    {n:'Invoiced',      v:E.fmtC(w.invoiced||0),        c:_c(w.invoiced||0)},
    {n:'Backlog',       v:E.fmtC(w.backlog||0),         c:_c(w.backlog||0)}
  ];
  h+='<div class="ng-ov-head">Overview</div><div class="ng-wip-ov">';
  tiles.forEach(function(t){
    h+='<div class="ng-wip-ov-kpi'+(t.hero?' ng-ov-hero':'')+'"><span class="ng-ov-lbl">'+t.n+'</span><span class="ng-ov-val '+t.c+'">'+t.v+'</span></div>';
  });
  h+='</div>';
  return h;
}
// Inline-edit a job financial field from the WIP panel → write the job + persist via
// saveData (the same path the WIP report uses); getJobWIP then recomputes on render.
function jobFieldEdit(chip){
  var jid=E.job();
  var job=(typeof appData!=='undefined' && appData.jobs) ? appData.jobs.find(function(j){return j.id===jid;}) : null;
  if(!job) return;
  var field=chip.getAttribute('data-job-edit'), typ=chip.getAttribute('data-job-type');
  _jobChipEditing=true;
  var inp=document.createElement('input');
  inp.type='number'; inp.step=typ==='p'?'0.1':'0.01';
  if(typ==='p'){ inp.min=0; inp.max=100; }
  inp.value=Number(job[field])||0;
  inp.className='ng-wip-chip-input';
  chip.textContent=''; chip.appendChild(inp);
  setTimeout(function(){ inp.focus(); inp.select(); }, 0);
  var done=false;
  function finish(){
    if(done) return; done=true; _jobChipEditing=false;
    var nv=parseFloat(inp.value)||0;
    if(typ==='p') nv=Math.max(0,Math.min(100,nv));
    job[field]=nv;
    if(typeof window.saveData==='function') saveData();   // persist the job financial change
    render();
  }
  inp.addEventListener('blur',finish);
  inp.addEventListener('keydown',function(ev){
    if(ev.key==='Enter'){ ev.preventDefault(); inp.blur(); }
    else if(ev.key==='Escape'){ ev.preventDefault(); done=true; _jobChipEditing=false; render(); }
  });
  inp.addEventListener('mousedown',function(ev){ ev.stopPropagation(); });
}

// S2: per-building cost panel. Shown only when a building polygon is selected in
// satellite Site Plan; reuses the same KPI tiles + engine helpers the building card
// body uses, so the numbers match. display:'block' (not '') — CSS default is none.
function renderBuildingMetrics(){
  var panel=document.querySelector('.ng-sp-bldg'); if(!panel) return;
  var on=E.viewMode && E.viewMode()==='siteplan'; // per-building panel works in all Site Plan modes
  var sel=(on && selN) ? E.findNode(selN) : null;
  if(!sel || sel.type!=='t1'){ panel.style.display='none'; return; }
  panel.style.display='block';
  var nameEl=panel.querySelector('.ng-sp-bldg-name'); if(nameEl) nameEl.textContent=sel.label||'Building';
  var bodyEl=panel.querySelector('.ng-sp-bldg-body'); if(bodyEl) bodyEl.innerHTML=buildingKpiGridHtml(sel);
  renderBuildingStructure(panel, sel);   // L/U Phase 1: levels + units breakdown
}

// ── Right-hand Inspector (Slice 1+2) ───────────────────────────────────────
// Persistent right panel: project WIP by default, building detail (KPIs +
// levels/units) when a building is selected, a light header for other node types
// (full per-type editing lands in Slice 3). Pure function of selN + getJobWIP,
// re-rendered every render() pass so edits reflect immediately.
// ── Left-sidebar SECTION → right Inspector (map-as-job-page) ─────────────────────────────
// With the map open, clicking a section tab in the app sidebar routes that section into the
// right Inspector (instead of activateTab closing the map). We MOVE the real section panel
// (#job-overview etc.) into the inspector body + call its global renderer, and move it back
// to #wsRightContent on node-select or map close.
var _inspSection=null, _inspSectionPanel=null;
var WS_SECTION_RENDERERS={'job-overview':'renderJobOverview','job-wip-report':'renderWipTab','job-details':'renderJobDetails','job-estimates':'renderJobEstimates','job-qb-costs':'renderJobQBCosts','job-subs':'renderJobSubs','job-changeorders':'renderChangeOrders','job-purchaseorders':'renderPurchaseOrders','job-invoices':'renderInvoices','job-payapps':'renderPayApps','job-reports':'renderJobReports'};
function restoreSectionPanel(){
  if(_inspSectionPanel){
    var rc=document.getElementById('wsRightContent');
    _inspSectionPanel.style.display='none';
    if(rc) rc.appendChild(_inspSectionPanel);   // return the panel to the classic right-content host
  }
  _inspSection=null; _inspSectionPanel=null;
}
function showSectionInInspector(pid, tabBtn){
  var insp=document.querySelector('.ng-inspector'); if(!insp) return;
  var body=insp.querySelector('.ng-inspector-body'); if(!body) return;
  // 'job-overview' is no longer a classic section — it routes to the Site
  // Plan's NATIVE overview (renderInspectorJobDetail via renderInspector).
  // Keeps stale /jobs/:id/job-overview deep links + the "‹ Overview" home
  // chip working without ever surfacing the retired classic overview page.
  if(pid==='job-overview'){
    restoreSectionPanel(); selN=null; _inspSection=null;
    document.querySelectorAll('.ws-right-tab').forEach(function(x){ x.classList.remove('active'); });
    var _oj=E.job();
    try{ if(_oj && window.history && history.replaceState){ history.replaceState(null,'','/jobs/'+encodeURIComponent(_oj)+'/job-overview'); } }catch(e){}
    renderInspector();
    return;
  }
  restoreSectionPanel();                 // return any prior section panel first
  selN=null;
  document.querySelectorAll('.ws-right-tab').forEach(function(x){ x.classList.toggle('active', x===tabBtn); });
  var hdr=insp.querySelector('.ng-inspector-hdr');
  var lbl=tabBtn ? (tabBtn.getAttribute('aria-label')||tabBtn.textContent||'Section').trim() : 'Section';
  if(hdr) hdr.innerHTML='<span class="ng-insp-ic">▤</span> '+luEsc(lbl)+'<span class="ng-insp-type">Section</span>';
  var panel=document.getElementById(pid);
  if(!panel && WS_SECTION_RENDERERS[pid]){
    // Lazily-built sections have no pane until their renderer runs
    // (#job-qb-costs is created by renderJobQBCosts/ensurePanel; #job-subs
    // only ever had an inner cards div). Create the expected container here
    // so the renderer call below can populate it — same lifecycle as the
    // pre-existing panes (moved into the inspector, restored on close).
    panel=document.createElement('div');
    panel.id=pid; panel.className='sub-tab-content-job';
    if(pid==='job-subs') panel.innerHTML='<div id="job-subs-cards"></div>';
  }
  if(!panel){ _inspSection=pid; body.innerHTML='<div class="ng-insp-empty">Section unavailable.</div>'; return; }
  _inspSection=pid; _inspSectionPanel=panel;
  body.innerHTML='';
  // Home affordance: with no Overview tab, a section needs a way back to
  // the Site Plan's native overview.
  var homeChip=document.createElement('button');
  homeChip.type='button'; homeChip.className='ng-insp-home';
  homeChip.innerHTML='&#x2039; Overview';
  homeChip.onclick=function(){ if(window.p86NgShowOverview) window.p86NgShowOverview(); };
  body.appendChild(homeChip);
  panel.style.display='block'; body.appendChild(panel);
  var jid=E.job(), fn=WS_SECTION_RENDERERS[pid];
  if(fn && typeof window[fn]==='function'){ try{ window[fn](jid); }catch(err){ if(window.console) console.warn('section render '+pid, err); } }
  // Keep the URL on the section actually being viewed. replaceState (not
  // push) — section flips inside the map shouldn't stack history entries.
  try{
    if(jid && window.history && history.replaceState){
      history.replaceState(null, '', '/jobs/'+encodeURIComponent(jid)+'/'+pid);
    }
  }catch(e){}
}
// Called by workspace-layout.js activateTab when the map is open: route the section into the
// right Inspector (keeping the map open) instead of activateTab's tear-down + center render.
window.p86NgShowSection=function(pid){
  // Sections are no longer hosted inside the map inspector — they're full-width
  // panes (the map is a dedicated "Site Map" tab). Route the request out to the
  // normal tab handler, which closes the Site Map overlay and shows the
  // full-width pane. Kept as a shim so any residual caller behaves correctly.
  if(typeof window.switchJobSubTab==='function'){ window.switchJobSubTab(pid); return; }
  var btn=document.querySelector('.ws-right-tab[data-panel="'+pid+'"]');
  showSectionInInspector(pid, btn);
};
// Return the right Inspector to the Site Plan's native job overview
// (used by the "‹ Overview" home chip + stale job-overview deep links).
window.p86NgShowOverview=function(){ showSectionInInspector('job-overview', null); };
// The job's live overview card (same p86EntityCard view-model as the left-rail card) for
// the top of the right Inspector — the Site Plan is the job page, so the card is the
// persistent job context. Contract + Profit + % ring from getJobWIP.
function inspectorJobCardHtml(){
  var jid=E.job();
  var job=(typeof appData!=='undefined' && appData.jobs) ? appData.jobs.find(function(j){return j.id===jid;}) : null;
  if(!job || !window.p86EntityCard) return '';
  var w=(typeof window.getJobWIP==='function') ? (window.getJobWIP(jid)||{}) : {};
  var sm=function(n){ n=Number(n)||0; var a=Math.abs(n), s=n<0?'-':''; if(a>=1e6) return s+'$'+(a/1e6).toFixed(1).replace(/\.0$/,'')+'M'; if(a>=1e3) return s+'$'+Math.round(a/1e3)+'k'; return s+'$'+Math.round(a); };
  var statusCol=window.p86EntityCard.jobStatusColor?window.p86EntityCard.jobStatusColor(job.status):'#8aa0c0';
  var accentCol=(window.p86EntityCard.pinColor?window.p86EntityCard.pinColor(job,'job'):null)||statusCol;
  var profit=(w.displayProfit!=null)?w.displayProfit:0;
  var contract=(w.contractIncome!=null)?w.contractIncome:(w.totalIncome!=null)?w.totalIncome:(Number(job.contractAmount)||0);
  return '<div class="ng-insp-jobcard">'+window.p86EntityCard.render({
    kind:'job', accent:accentCol, status:{label:job.status||'In Progress', color:statusCol},
    number:job.jobNumber||'', title:job.title||job.name||'', subtitle:job.client||'',
    ring:{pct:(w.pctComplete||0)},
    stats:[
      {label:'Contract', value:sm(contract)},
      {label:'Profit', value:(profit<0?'-':'+')+sm(Math.abs(profit)), tone:profit<0?'neg':'pos'}
    ]
  }, {compact:true})+'</div>';
}
function renderInspector(){
  var panel=document.querySelector('.ng-inspector'); if(!panel) return;
  if(!(E.viewMode && E.viewMode()==='siteplan')) return;
  // Self-heal the canvas size: the inspector shrinks .ng-canvas-area, so the grid/wire
  // buffers must match the (now narrower) wrap width or they clip on the right edge.
  if(wireC && wrap && wrap.clientWidth>0 && wireC.width!==wrap.clientWidth) resize();
  var hdr=panel.querySelector('.ng-inspector-hdr');
  var body=panel.querySelector('.ng-inspector-body'); if(!body) return;
  if((_jobChipEditing || editingId) && body.querySelector('input')) return; // mid-edit: don't clobber a focused WIP chip OR inline node/alloc input
  var sel=selN ? E.findNode(selN) : null;
  // A left-sidebar SECTION is showing in this panel (routed here when the map is open) — keep it
  // unless a node is now selected; selecting a node drops the section view to show node detail.
  if(sel && _inspSectionPanel){ restoreSectionPanel(); }
  else if(!sel && _inspSection){ return; }
  if(sel && sel.type==='t1'){
    if(hdr) hdr.innerHTML='<span class="ng-insp-ic">'+ngIco('buildings')+'</span> '+luEsc(sel.label||'Building')+'<span class="ng-insp-type">Building</span>'
      +'<button class="ng-insp-cards" onclick="event.stopPropagation();window.p86NcBldgToggle&&window.p86NcBldgToggle(\''+sel.id+'\')" title="Open this building as nested cards on the map">Cards</button>';
    body.innerHTML='<div class="ng-insp-sec">'+buildingKpiGridHtml(sel)+'</div>'+buildingRevBreakdownHtml(sel)+'<div class="ng-sp-struct"></div>';
    renderBuildingStructure(body, sel);
  } else if(sel && sel.type!=='wip'){
    var d=E.DEFS[sel.type]||{}, iType=d.itemType||'';
    if(hdr) hdr.innerHTML='<span class="ng-insp-ic">'+ngTypeIco(sel.type)+'</span> '+luEsc(sel.label||d.label||'Node')+'<span class="ng-insp-type">'+luEsc(d.label||sel.type)+'</span>';
    var LI_TYPES={labor:1,mat:1,gc:1,other:1,burden:1,inv:1}; // line-item nodes
    body.innerHTML=(sel.type==='t2'||sel.type==='co') ? inspectorAllocHtml(sel)
                  : iType==='po' ? inspectorPOHtml(sel)
                  : iType==='sub' ? inspectorSubHtml(sel)
                  : LI_TYPES[iType] ? inspectorLineItemHtml(sel)
                  : inspectorGenericHtml(sel, d);
  } else {
    var _jb=(typeof appData!=='undefined'&&appData.jobs)?appData.jobs.find(function(j){return j.id===E.job();}):null;
    if(hdr) hdr.innerHTML='<span class="ng-insp-ic">'+ngIco('wip')+'</span> '+luEsc((_jb&&(_jb.title||_jb.name))||'Job Detail')+'<span class="ng-insp-type">Job</span>';
    renderInspectorJobDetail(body);
    refreshInspMetrics();   // always repaint tiles (job-detail build is keyed; numbers settle late)
    refreshInspKpis();      // + KPI ribbon / attention band (same late-settle reason)
    refreshInspAccSums();   // + section rollup summaries
    refreshInspContractAlloc();  // + the scope×building contract matrix (AIA SOV shape)
  }
  // Hybrid inline-spawn (RS-A + RS-B): a single "+ Add" button (prepended) + per-type
  // grouped child lists (appended) so children can be spawned + browsed inline.
  if(sel && sel.type!=='wip'){ injectSpawnRow(body, sel); body.insertAdjacentHTML('beforeend', childGroupsHtml(sel)); }
  // The job's live overview card leads the right panel — the map IS the job page, so the
  // job card is the persistent context above whatever node is selected. Remove any prior
  // card first: the no-node job-detail branch is build-once and doesn't clear the body, so
  // without this the card was re-prepended on every render and stacked up (multiplying cards).
  if(body && !_inspSection){
    var _oldCard=body.querySelector('.ng-insp-jobcard');
    if(_oldCard) _oldCard.remove();
    body.insertAdjacentHTML('afterbegin', inspectorJobCardHtml());
  }
}
// Slice 3: the no-node Inspector hosts the JOB detail — reuses the classic job-overview
// renderers (buildings / phases / subs). Built ONCE per job-detail entry: these mount
// synchronous appData renderers that own their expand state, so rebuilding every render()
// would thrash them. A selected node takes over the panel (branches above); clearing the
// selection (body no longer has .ng-insp-jobdetail) rebuilds this with fresh numbers.
var _inspJobKey=null, _inspFilesHandle=null;
// Fill the #ng-insp-metrics tiles from getJobWIP. Called on every inspector
// render (not gated by the job-detail build key) so late-settling node-graph
// numbers (pctComplete / revenue / profit) land instead of freezing at $0.
function refreshInspMetrics(){
  var host=document.getElementById('ng-insp-metrics'); if(!host) return;
  var jid=E.job();
  var w=(typeof window.getJobWIP==='function')?(window.getJobWIP(jid)||{}):{};
  function m(n){ n=(n==null||isNaN(n))?0:n; return (n<0?'-$':'$')+Math.round(Math.abs(n)).toLocaleString(); }
  function p(n){ return ((n==null||isNaN(n))?0:n).toFixed(0)+'%'; }
  var tiles=[
    {k:'Income',v:m(w.totalIncome),c:'inc'},
    {k:'Costs',v:m(w.actualCosts),c:'cost'},
    {k:'% Complete',v:p(w.pctComplete),c:''},
    {k:'Revenue',v:m(w.revenueEarned),c:'inc'},
    {k:'Profit',v:m(w.displayProfit),c:((w.displayProfit||0)>=0?'gain':'neg')},
    {k:'Margin',v:p(w.displayMargin),c:''}
  ];
  host.innerHTML=tiles.map(function(t){ return '<div class="ng-im '+t.c+'"><span class="ng-im-k">'+t.k+'</span><span class="ng-im-v">'+t.v+'</span></div>'; }).join('');
}
// Exposed so jobs.js can repaint the tiles after an inline card edit
// changes the underlying WIP numbers.
window.refreshInspMetrics = refreshInspMetrics;
// Command Center KPI ribbon (Cost · Margin · Billed · AR) + a conditional
// attention band. The leading job card already carries Contract + Profit + %,
// so the ribbon adds the operational spread and flags trouble (negative margin,
// unbilled earned work). Called every inspector render so late-settling
// node-graph numbers land instead of freezing at the build-time snapshot.
function refreshInspKpis(){
  var host=document.getElementById('ng-insp-kpis'); if(!host) return;
  var jid=E.job();
  var w=(typeof window.getJobWIP==='function')?(window.getJobWIP(jid)||{}):{};
  function sm(n){ n=Number(n)||0; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e6)return s+'$'+(a/1e6).toFixed(1).replace(/\.0$/,'')+'M'; if(a>=1e3)return s+'$'+Math.round(a/1e3)+'k'; return s+'$'+Math.round(a); }
  var cost=w.actualCosts||0;
  var margin=(w.displayMargin!=null&&!isNaN(w.displayMargin))?w.displayMargin:0;
  var earned=w.revenueEarned||0;
  var billed=0, paid=0;
  (appData.invoices||[]).forEach(function(iv){
    if((iv.job_id||iv.jobId)!==jid) return;
    var st=String(iv.status||'').toLowerCase();
    if(st==='void'||st==='draft'||st==='cancelled') return;
    billed+=Number(iv.total||iv.amount||0)||0;
    paid+=Number(iv.amount_paid||iv.amountPaid||iv.paid||0)||0;
  });
  var ar=Math.max(0, billed-paid);
  var tiles=[
    {k:'Cost',v:sm(cost),c:'o'},
    {k:'Margin',v:margin.toFixed(1)+'%',c:(margin<0?'r':'g')},
    {k:'Billed',v:sm(billed),c:''},
    {k:'AR',v:sm(ar),c:'b'}
  ];
  host.innerHTML=tiles.map(function(t){ return '<div class="ng-kpi"><span class="k">'+t.k+'</span><span class="v '+t.c+'">'+t.v+'</span></div>'; }).join('');
  var attn=document.getElementById('ng-insp-attn-host'); if(attn){
    var flags=[], subs=[];
    if(margin<0){ flags.push('Margin negative'); subs.push('MARGIN '+margin.toFixed(1)+'%'); }
    var unbilled=earned-billed;
    if(unbilled>1000){ flags.push('Unbilled '+sm(unbilled)); subs.push('EARNED '+sm(earned)+' · BILLED '+sm(billed)); }
    attn.innerHTML=flags.length
      ? '<div class="ng-insp-attn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg><div><div class="at">'+flags.join(' · ')+'</div><div class="as">'+subs.join(' · ')+'</div></div></div>'
      : '';
  }
}
window.refreshInspKpis = refreshInspKpis;
// Fill each self-summarizing section header with its rollup. Synchronous from
// appData + getJobWIP, refreshed on every inspector render.
function refreshInspAccSums(){
  var jid=E.job();
  function set(id,txt){ var el=document.getElementById(id); if(el) el.textContent=txt; }
  function sm(n){ n=Number(n)||0; var a=Math.abs(n),s=n<0?'-':''; if(a>=1e6)return s+'$'+(a/1e6).toFixed(1).replace(/\.0$/,'')+'M'; if(a>=1e3)return s+'$'+Math.round(a/1e3)+'k'; return s+'$'+Math.round(a); }
  var pd=function(r){ return r?(r.asSoldRevenue||r.asSoldPhaseBudget||r.phaseBudget||0):0; };
  var phasesJob=(appData.phases||[]).filter(function(p){ return p.jobId===jid; });
  var nB=(appData.buildings||[]).filter(function(b){ return b.jobId===jid; }).length;
  var pnames={}; phasesJob.forEach(function(p){ pnames[p.phase||'Unnamed']=1; });
  var nPh=Object.keys(pnames).length;
  var alloc=phasesJob.reduce(function(s,r){ return s+pd(r); },0);
  var w=(typeof window.getJobWIP==='function')?(window.getJobWIP(jid)||{}):{};
  var nSubs=(appData.subs||[]).filter(function(s){ return s.jobId===jid; }).length;
  set('accsum-buildings', nB+' building'+(nB===1?'':'s'));
  set('accsum-phases', nPh+(nPh?' · '+sm(alloc)+' allocated':' phases'));
  set('accsum-jobcosts', sm(w.actualCosts||0)+' linked');
  set('accsum-subs', nSubs+' sub'+(nSubs===1?'':'s'));
  // CO / PO / Invoices — counts from the server stores (may fill in after their
  // async section fetch lands; refreshed on the next inspector render either way).
  var cos=(appData.jobChangeOrders||[]).filter(function(c){ return (c.jobId||c.job_id)===jid; });
  var pos=(appData.jobPurchaseOrders||[]).filter(function(p){ return (p.jobId||p.job_id)===jid; });
  var invs=(appData.invoices||[]).filter(function(i){ return i.jobId===jid; });
  var invBilled=0; invs.forEach(function(i){ var st=String(i.status||'').toLowerCase(); if(st!=='void'&&st!=='draft') invBilled+=Number(i.amount||0)||0; });
  set('accsum-cos', cos.length+' CO'+(cos.length===1?'':'s'));
  set('accsum-pos', pos.length+' PO'+(pos.length===1?'':'s'));
  set('accsum-invoices', invs.length? (invs.length+' · '+sm(invBilled)) : '0');
}
window.refreshInspAccSums = refreshInspAccSums;
function renderInspectorJobDetail(body){
  var jid=E.job(); var jk='job:'+(jid||'');
  if(_inspJobKey===jk && body.querySelector('.ng-insp-jobdetail')) return;
  _inspJobKey=jk;
  // Slice 3c: tear down a previously-mounted file explorer before the panel rebuilds.
  if(_inspFilesHandle && _inspFilesHandle.destroy){ try{ _inspFilesHandle.destroy(); }catch(e){} } _inspFilesHandle=null;
  var job=(typeof appData!=='undefined'&&appData.jobs)?appData.jobs.find(function(j){return j.id===jid;}):null;
  if(!job){ body.innerHTML='<div class="ng-insp-empty">No job loaded.</div>'; return; }
  // Top-line metrics lead the panel; the actual numbers fill in via
  // refreshInspMetrics() so they track late-settling node-graph values
  // (pctComplete / ngRevenueEarned land after ensureNGComputed + cloud
  // sync) instead of freezing at the build-time snapshot.
  body.innerHTML='<div class="ng-insp-jobdetail">'+
    // (job headline now lives in the leading job card — inspectorJobCardHtml)
    // Command Center: a financial KPI ribbon + a conditional attention band lead
    // the body; both filled by refreshInspKpis() so late-settling numbers land.
    '<div class="ng-insp-kpis" id="ng-insp-kpis"></div>'+
    '<div id="ng-insp-attn-host"></div>'+
    // Self-summarizing sections: each header carries its own rollup (filled by
    // refreshInspAccSums) and collapses. Buildings + Phases lead open; Job Costs
    // + Subs start collapsed (their number is in the header). The #insp-* ids stay
    // INSIDE each body so the existing section renderers keep targeting them.
    '<div class="ng-insp-acc ng-open" id="acc-buildings"><button class="ng-insp-acc-hdr" data-acc-toggle="buildings"><span class="acc-dot" style="background:#4f8cff"></span><span class="acc-t">Buildings</span><span class="acc-sum" id="accsum-buildings"></span><span class="acc-chev"></span></button><div class="ng-insp-acc-body"><div class="ng-insp-sec" id="insp-buildings"></div></div></div>'+
    // Contract allocation matrix (scopes × buildings) — the source of truth the
    // AIA G703 bills from; filled by refreshInspContractAlloc().
    '<div class="ng-insp-acc ng-open" id="acc-contract-alloc"><button class="ng-insp-acc-hdr" data-acc-toggle="contract-alloc"><span class="acc-dot" style="background:#34d399"></span><span class="acc-t">Contract allocation</span><span class="acc-sum" id="accsum-contract-alloc"></span><span class="acc-chev"></span></button><div class="ng-insp-acc-body"><div class="ng-insp-sec" id="ng-insp-contract-alloc"></div></div></div>'+
    '<div class="ng-insp-acc ng-open" id="acc-phases"><button class="ng-insp-acc-hdr" data-acc-toggle="phases"><span class="acc-dot" style="background:#a78bfa"></span><span class="acc-t">Phases</span><span class="acc-sum" id="accsum-phases"></span><span class="acc-chev"></span></button><div class="ng-insp-acc-body"><div class="ng-insp-sec" id="insp-phases"></div></div></div>'+
    '<div class="ng-insp-acc" id="acc-jobcosts"><button class="ng-insp-acc-hdr" data-acc-toggle="jobcosts"><span class="acc-dot" style="background:#f2a55c"></span><span class="acc-t">Job Costs</span><span class="acc-sum" id="accsum-jobcosts"></span><span class="acc-chev"></span></button><div class="ng-insp-acc-body"><div class="ng-insp-sec" id="insp-jobcosts"></div></div></div>'+
    '<div class="ng-insp-acc" id="acc-subs"><button class="ng-insp-acc-hdr" data-acc-toggle="subs"><span class="acc-dot" style="background:#35d0a5"></span><span class="acc-t">Subcontractors</span><span class="acc-sum" id="accsum-subs"></span><span class="acc-chev"></span></button><div class="ng-insp-acc-body"><div class="ng-insp-sec" id="insp-subs"></div><div id="insp-subs-totals"></div></div></div>'+
    // Change Orders / Purchase Orders / Invoices — same self-summarizing accordion
    // treatment, collapsed by default. The section renderers still target the same
    // #insp-cos / #insp-pos ids nested inside; invoices are synchronous HTML.
    '<div class="ng-insp-acc" id="acc-cos"><button class="ng-insp-acc-hdr" data-acc-toggle="cos"><span class="acc-dot" style="background:#e879a6"></span><span class="acc-t">Change Orders</span><span class="acc-sum" id="accsum-cos"></span><span class="acc-chev"></span></button><div class="ng-insp-acc-body"><div class="ng-insp-sec" id="insp-cos"></div></div></div>'+
    '<div class="ng-insp-acc" id="acc-pos"><button class="ng-insp-acc-hdr" data-acc-toggle="pos"><span class="acc-dot" style="background:#f4c152"></span><span class="acc-t">Purchase Orders</span><span class="acc-sum" id="accsum-pos"></span><span class="acc-chev"></span></button><div class="ng-insp-acc-body"><div class="ng-insp-sec" id="insp-pos"></div></div></div>'+
    '<div class="ng-insp-acc" id="acc-invoices"><button class="ng-insp-acc-hdr" data-acc-toggle="invoices"><span class="acc-dot" style="background:#7fb0ff"></span><span class="acc-t">Invoices</span><span class="acc-sum" id="accsum-invoices"></span><span class="acc-chev"></span></button><div class="ng-insp-acc-body">'+inspectorInvoicesHtml(jid)+'</div></div>'+
    // Slice 3c: Tasks + Files — collapsed by default, lazy-mounted on first expand (heavy mounts).
    '<div class="ng-insp-coll"><div class="ng-insp-coll-hdr" data-coll-toggle="tasks">Tasks</div><div class="ng-insp-coll-body" id="insp-tasks" style="display:none"></div></div>'+
    '<div class="ng-insp-coll"><div class="ng-insp-coll-hdr" data-coll-toggle="files">Files</div><div class="ng-insp-coll-body" id="insp-files" style="display:none"></div></div>'+
  '</div>';
  try{
    var phases=(appData.phases||[]).filter(function(p){return p.jobId===jid;});
    var subs=(appData.subs||[]).filter(function(s){return s.jobId===jid;});
    if(typeof window.renderJobBuildings==='function') window.renderJobBuildings(jid,'insp-buildings');
    if(typeof window.renderOverviewPhasesInto==='function') window.renderOverviewPhasesInto(document.getElementById('insp-phases'),jid,phases);
    renderJobLevelCostsInto(document.getElementById('insp-jobcosts'));
    if(typeof window.renderOverviewSubsInto==='function') window.renderOverviewSubsInto(document.getElementById('insp-subs'),jid,subs);
    if(typeof window.renderJobChangeOrdersInto==='function') window.renderJobChangeOrdersInto(document.getElementById('insp-cos'),jid,'insp-co');
    if(typeof window.renderJobPurchaseOrdersInto==='function') window.renderJobPurchaseOrdersInto(document.getElementById('insp-pos'),jid,'insp-po');
  }catch(e){ if(window.console) console.warn('inspector job-detail render failed', e); }
  refreshInspMetrics();   // first-paint fill
  refreshInspKpis();      // first-paint KPI ribbon + attention band
  refreshInspAccSums();   // first-paint section rollups
}

// ── Job-Level Costs (overview panel) ───────────────────────────────
// Add a category cost node — Materials / Labor / Equipment / GC / Burden —
// straight at the JOB level from the overview. It drops a free-floating
// (unwired) cost node, which counts on the job's total until you wire it
// down to a building/phase/CO, and recomputes immediately. Link QuickBooks
// costs to it in the Detailed sub-tab and they flow into Actual Costs.
var JOB_COST_CATS = [
  { t:'mat',    label:'Materials' },
  { t:'labor',  label:'Labor' },
  { t:'other',  label:'Equipment' },
  { t:'gc',     label:'Gen Conditions' },
  { t:'burden', label:'Burden' }
];
function _jlcEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Cost nodes NOT wired up to any building/phase/WIP = job-level costs.
function jobLevelCostNodes(){
  return E.nodes().filter(function(n){
    if(n.type!=='labor'&&n.type!=='mat'&&n.type!=='gc'&&n.type!=='other'&&n.type!=='burden') return false;
    return !E.wires().some(function(w){
      if(w.fromNode!==n.id) return false;
      var tgt=E.findNode(w.toNode);
      return tgt&&(tgt.type==='t1'||tgt.type==='t2'||tgt.type==='wip');
    });
  });
}

function renderJobLevelCostsInto(host){
  if(!host) return;
  var list=jobLevelCostNodes();
  if(E.resetComp) E.resetComp();
  // Linked QuickBooks costs for THIS job (qb_cost_lines.linked_node_id set).
  // Surfaced here so the overview shows real QB spend once it's linked: a job-
  // wide total (which also catches QB linked to a building/phase node, since
  // those don't appear in the job-level node list), plus a per-node fold-in
  // below. Filtered by job_id — node ids like "n2" are per-graph, not global,
  // so an unfiltered match would cross-contaminate jobs. Display-only; the job
  // Actual-cost metric already counts these once via getJobWIP.
  var _jid=null; try{ _jid = E.job && E.job(); }catch(e){}
  var _qbByNode={}, _qbTotal=0, _qbCount=0;
  if(_jid){
    ((window.appData&&window.appData.qbCostLines)||[]).forEach(function(l){
      if(l.linked_node_id==null) return;
      if(((l.job_id||l.jobId))!==_jid) return;
      var a=Number(l.amount||0);
      _qbByNode[l.linked_node_id]=(_qbByNode[l.linked_node_id]||0)+a;
      _qbTotal+=a; _qbCount++;
    });
  }
  var h='<div class="ng-insp-sublabel" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'+
    '<span>Job-Level Costs</span>'+
    '<span style="font-size:9px;color:#6a7090;font-weight:500;text-transform:none;letter-spacing:0;">counts on the job total</span>'+
  '</div>';
  if(_qbTotal>0){
    h+='<div title="QuickBooks cost lines linked to this job’s cost nodes — they count as actual cost" '+
      'style="display:flex;align-items:center;gap:6px;margin:2px 0 8px;padding:5px 8px;border:1px solid #26406a;border-radius:6px;background:rgba(79,140,255,0.08);">'+
      '<span style="font-size:11px;">🔗</span>'+
      '<span style="font-size:11px;color:#bcd2ff;">QuickBooks: <b style="font-family:monospace;">'+(E.fmtC?E.fmtC(_qbTotal):('$'+Math.round(_qbTotal)))+'</b> linked · '+_qbCount+' line'+(_qbCount===1?'':'s')+'</span>'+
    '</div>';
  }
  h+='<div style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px;">';
  JOB_COST_CATS.forEach(function(c){
    h+='<button data-jlc-add="'+c.t+'" title="Add a job-level '+_jlcEsc(c.label)+' cost node" '+
      'style="font-size:10px;padding:3px 8px;border:1px solid #2e3350;border-radius:5px;background:#171a2e;color:#c9cee8;cursor:pointer;">+ '+_jlcEsc(c.label)+'</button>';
  });
  h+='</div>';
  if(list.length){
    list.forEach(function(n){
      var d=E.DEFS[n.type]||{};
      var manual=E.getOutput?E.getOutput(n,0):(n.value||0);
      var linkedQb=_qbByNode[n.id]||0;   // QB lines linked straight to this node
      var total=manual+linkedQb;
      h+='<div data-jlc-sel="'+n.id+'" title="Show on the graph" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;border:1px solid #23273f;border-radius:5px;margin-bottom:4px;cursor:pointer;">'+
        '<span style="font-size:11px;color:#dfe3f5;">'+(d.icon||'')+' '+_jlcEsc(n.label||d.label||'Cost')+
          (linkedQb>0?' <span title="Includes '+(E.fmtC?E.fmtC(linkedQb):('$'+Math.round(linkedQb)))+' in linked QuickBooks costs" style="font-size:9px;">🔗</span>':'')+
        '</span>'+
        '<span style="font-size:11px;font-weight:600;color:#8fb8ff;font-family:monospace;">'+(E.fmtC?E.fmtC(total):('$'+Math.round(total)))+'</span>'+
      '</div>';
    });
  } else {
    h+='<div style="font-size:10px;color:#6a7090;padding:2px 2px 4px;line-height:1.4;">None yet. Add one above, then link QuickBooks costs to it in the job’s Detailed sub-tab.</div>';
  }
  host.innerHTML=h;
  host.querySelectorAll('[data-jlc-add]').forEach(function(b){
    b.addEventListener('click', function(e){ e.stopPropagation(); addJobLevelCostNode(b.getAttribute('data-jlc-add')); });
  });
  host.querySelectorAll('[data-jlc-sel]').forEach(function(r){
    r.addEventListener('click', function(e){ e.stopPropagation(); selN=r.getAttribute('data-jlc-sel'); render(); });
  });
}

function addJobLevelCostNode(cat){
  var d=E.DEFS[cat]; if(!d) return;
  var p=E.pan(), z=E.zm();
  var cx=-p.x+(wrap?wrap.clientWidth:800)/2/z, cy=-p.y+(wrap?wrap.clientHeight:600)/2/z;
  var nn=E.addNode(cat, Math.round(cx-85), Math.round(cy-30), d.label);
  if(!nn) return;
  selN=nn.id;
  try{ pushToJobSilent(); }catch(e){}
  if(E.saveGraph) E.saveGraph();
  render();
  try{ refreshInspMetrics(); }catch(e){}
  var host=document.getElementById('insp-jobcosts');
  if(host) renderJobLevelCostsInto(host);
}

// Recompute a job's WIP from its live graph IF that graph is the one
// currently loaded — lets other surfaces (e.g. linking a QB cost in the
// Detailed sub-tab) refresh Actual Costs without opening the Site Plan.
window.ngRecomputeIfJob=function(jid){
  try{
    if(!jid || !E.job || E.job()!==jid) return false;
    pushToJobSilent();
    if(E.saveGraph) E.saveGraph();
    if(typeof refreshInspMetrics==='function') refreshInspMetrics();
    var host=document.getElementById('insp-jobcosts');
    if(host) renderJobLevelCostsInto(host);
    return true;
  }catch(e){ return false; }
};

// Slice 3c: expand/collapse a Tasks/Files section and lazy-mount its heavy panel on first
// open (p86Tasks / p86Explorer fetch on mount — don't pay that on every job open).
function inspToggleCollapse(key, hdrEl){
  var box=document.getElementById('insp-'+key); if(!box) return;
  var open=box.style.display!=='none';
  box.style.display=open?'none':'block';
  if(hdrEl) hdrEl.classList.toggle('ng-open', !open);
  if(open || box.getAttribute('data-mounted')) return;   // collapsing, or already mounted
  box.setAttribute('data-mounted','1');
  var jid=E.job();
  var job=(typeof appData!=='undefined'&&appData.jobs)?appData.jobs.find(function(j){return j.id===jid;}):null;
  try{
    if(key==='tasks' && window.p86Tasks && window.p86Tasks.mountEntityPanel){
      var lbl=job?((job.jobNumber?job.jobNumber+' — ':'')+(job.title||'')):('Job '+jid);
      window.p86Tasks.mountEntityPanel(box,'job',jid,lbl);
    } else if(key==='files' && window.p86Explorer && window.p86Explorer.mount){
      _inspFilesHandle=window.p86Explorer.mount(box,{entityType:'job',entityId:String(jid),canEdit:true,embedded:true});
    }
  }catch(e){ if(window.console) console.warn('inspector lazy-mount '+key, e); box.removeAttribute('data-mounted'); }
}
// Compact invoice table for the Inspector (appData.invoices for this job). Narrower than
// the classic 7-col overview table to fit the 340px panel; rows open the invoice editor.
function inspectorInvoicesHtml(jid){
  var invs=(typeof appData!=='undefined'&&appData.invoices)?appData.invoices.filter(function(i){return i.jobId===jid;}):[];
  if(!invs.length) return '';
  var total=0, paid=0;
  invs.forEach(function(i){ total+=i.amount||0; if(i.status==='Paid') paid+=i.amount||0; });
  var rows=invs.map(function(i){
    var sc=i.status==='Paid'?'#34d399':i.status==='Sent'?'#fbbf24':'#8aa0c0';
    return '<tr style="cursor:pointer;border-top:1px solid rgba(255,255,255,.05);" onclick="editInvoice(\''+luEsc(i.id)+'\')" title="Edit invoice">'+
      '<td style="padding:5px 8px;font-weight:600;white-space:nowrap;">'+luEsc(i.invNumber||'INV')+'</td>'+
      '<td style="padding:5px 8px;color:#aab;">'+luEsc(i.vendor||'')+'</td>'+
      '<td style="padding:5px 8px;text-align:right;font-weight:600;white-space:nowrap;">'+E.fmtC(i.amount||0)+'</td>'+
      '<td style="padding:5px 8px;"><span style="font-size:10px;padding:2px 7px;border-radius:9px;background:rgba(255,255,255,.06);color:'+sc+';">'+luEsc(i.status||'Draft')+'</span></td>'+
    '</tr>';
  }).join('');
  return '<div class="ng-insp-sec"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">'+
    '<b style="font-size:12px;">Invoices ('+invs.length+')</b>'+
    '<span style="font-size:11px;color:#8aa0c0;">Outstanding '+E.fmtC(total-paid)+'</span></div>'+
    '<div style="overflow-x:auto;border:1px solid rgba(255,255,255,.08);border-radius:8px;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><tbody>'+rows+'</tbody></table></div></div>';
}
// Minimal detail for non-building node types until Slice 3 wires full per-type editing.
function inspectorGenericHtml(sel, d){
  var rows=[];
  if(sel.value) rows.push({l:'Amount', v:E.fmtC(sel.value||0), c:'ng-ov-zero'});
  if(sel.revenue) rows.push({l:'Revenue', v:E.fmtC(sel.revenue||0), c:'ng-ov-pos'});
  if((sel.type==='t2'||sel.type==='co') && sel.pctComplete!=null) rows.push({l:'% Complete', v:(Number(sel.pctComplete)||0).toFixed(1)+'%', c:'ng-ov-pos'});
  var h='';
  if(rows.length){
    h+='<div class="ng-insp-sec"><div class="ng-wip-ov">';
    rows.forEach(function(r){ h+='<div class="ng-wip-ov-kpi"><span class="ng-ov-lbl">'+r.l+'</span><span class="ng-ov-val '+r.c+'">'+r.v+'</span></div>'; });
    h+='</div></div>';
  }
  h+='<div class="ng-insp-empty">Full detail &amp; editing for '+luEsc(d.label||sel.type)+' nodes lands in the next slice.</div>';
  return h;
}
// Scope(t2) + change-order(co) Inspector detail: editable revenue (t2) + the full
// allocation table (lock / alloc% / per-wire % / $ share), using the SAME data-*
// contract as the cards so the shared inline-edit handlers drive it. Mirrors the card
// income/pct getters exactly (coIncome=E.getOutput, phaseRev=n.revenue, getT2WeightedPct).
function inspectorAllocHtml(sel){
  var isCO=sel.type==='co';
  var income=isCO ? E.getOutput(sel,0) : (sel.revenue||0);
  var pct=E.getT2WeightedPct(sel);                 // getT2WeightedPct handles co too
  var wires=isCO ? E.getCOAllocWires(sel.id) : E.getPhaseAllocWires(sel.id);
  var revCell=isCO ? E.fmtC(income)
    : '<span class="ng-phase-rev" data-phase-rev="'+sel.id+'" style="cursor:pointer" title="Click to edit">'+E.fmtC(income)+'</span>';
  var h='<div class="ng-insp-sec"><div class="ng-wip-ov">';
  h+='<div class="ng-wip-ov-kpi ng-ov-hero"><span class="ng-ov-lbl">'+(isCO?'CO Income':'Revenue')+'</span><span class="ng-ov-val ng-ov-pos">'+revCell+'</span></div>';
  h+='<div class="ng-wip-ov-kpi"><span class="ng-ov-lbl">% Complete</span><span class="ng-ov-val '+(pct>0?'ng-ov-pos':'ng-ov-zero')+'">'+pct.toFixed(1)+'%</span></div>';
  h+='</div></div>';
  if(wires.length){
    h+='<div class="ng-insp-sec"><div class="ng-insp-sublabel">Allocation</div>';
    h+='<table class="ng-alloc-tbl"><thead><tr><th></th><th>Target</th><th>Alloc</th><th>%&nbsp;Cmp</th><th>Share</th></tr></thead><tbody>';
    wires.forEach(function(w){
      var tgt=E.findNode(w.toNode);
      var pctA=(w.allocPct==null?0:w.allocPct); // null = unallocated: engine computes 0% — display must match the math (was shown as 100%)
      var wpc=(w.pctComplete!=null)?w.pctComplete:0;
      var share=income*(pctA/100);
      var locked=!w._auto;
      h+='<tr>'
        +'<td><span class="ng-alloc-lock" data-lock-co="'+sel.id+'" data-lock-wire="'+w.toNode+'" title="'+(locked?'Unlock':'Lock')+' this allocation" style="cursor:pointer">'+(locked?'🔒':'🔓')+'</span></td>'
        +'<td class="ng-alloc-tgt">'+luEsc(tgt?(tgt.label||tgt.type).split(' › ')[0].trim():w.toNode)+'</td>'
        +'<td><span class="ng-alloc-pct" data-alloc-phase="'+sel.id+'" data-alloc-bldg="'+w.toNode+'" style="cursor:pointer" title="Click to edit allocation %">'+pctA.toFixed(1)+'%</span></td>'
        +'<td><span class="ng-wire-pct" data-wire-pct-phase="'+sel.id+'" data-wire-pct-bldg="'+w.toNode+'" style="cursor:pointer" title="Click to edit % complete">'+Number(wpc).toFixed(0)+'%</span></td>'
        +'<td><span class="ng-alloc-share" data-share-co="'+sel.id+'" data-share-wire="'+w.toNode+'" data-share-income="'+income+'" style="cursor:pointer" title="Click to edit $ share">'+E.fmtC(share)+'</span></td>'
        +'</tr>';
    });
    h+='</tbody></table></div>';
  } else {
    h+='<div class="ng-insp-empty">No allocations yet. Wire this '+(isCO?'change order':'scope')+' to a building on the map to allocate revenue + costs.</div>';
  }
  return h;
}
// Line-item table HTML for any n.items-bearing node (cost/sub/po/inv), keyed off
// E.DEFS[type].itemType. Same ng-si-f / data-node / data-idx / data-field markup the
// card uses, so the input/add/delete handlers resolve the same node + item.
function lineItemsHtml(n){
  var d=E.DEFS[n.type]||{}, iType=d.itemType||'';
  if(!iType) return '';
  var items=n.items||[];
  var h='<div class="ng-subitems">';
  if(iType==='labor') h+='<div class="ng-si-hdr"><span class="hd hd-date">Week Of</span><span class="hd hd-sm">Hrs</span><span class="hd hd-sm">Rate</span><span class="hd hd-sm">Total</span><span class="hd hd-del"></span></div>';
  else if(iType==='mat') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Amount</span><span class="hd hd-del"></span></div>';
  else if(iType==='burden') h+='<div class="ng-si-hdr"><span class="hd hd-date">Period</span><span class="hd hd-flex">Amount</span><span class="hd hd-del"></span></div>';
  else if(iType==='gc') h+='<div class="ng-si-hdr"><span class="hd hd-date">Week Of</span><span class="hd hd-flex">Vendor</span><span class="hd hd-sm">Amount</span><span class="hd hd-del"></span></div>';
  else if(iType==='other') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-sm">Qty</span><span class="hd hd-sm">$/Unit</span><span class="hd hd-sm">Total</span><span class="hd hd-del"></span></div>';
  else if(iType==='sub') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Description</span><span class="hd hd-sm">Amount</span><span class="hd hd-del"></span></div>';
  else if(iType==='po') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Amendment</span><span class="hd hd-sm">Amount</span><span class="hd hd-del"></span></div>';
  else if(iType==='inv') h+='<div class="ng-si-hdr"><span class="hd hd-date">Date</span><span class="hd hd-flex">Invoice #</span><span class="hd hd-sm">Amount</span><span class="hd hd-del"></span></div>';
  items.forEach(function(item,idx){
    var pre='data-node="'+n.id+'" data-idx="'+idx+'"';
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
    h+='<span class="ng-subitem-del" data-node="'+n.id+'" data-idx="'+idx+'">✖</span>';
    h+='</div>';
  });
  h+='<div class="ng-add-sub" data-node="'+n.id+'">+ Add Entry</div>';
  h+='<div class="ng-sub-total">'+E.fmtC(E.getOutput(n,0))+'</div>';
  h+='</div>';
  return h;
}
// Append a new blank line item with type-specific default fields. Extracted from the
// canvas add handler so the on-card AND inspector "+ Add Entry" share one builder.
function lineItemAdd(n){
  if(!n) return;
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
  if(!n.items) n.items=[];
  n.items.push(newItem);
}
// Cost/invoice Inspector detail (Slice 3b): total KPI + manual-total fallback (cost
// types only) + the full editable line-item table.
function inspectorLineItemHtml(sel){
  var d=E.DEFS[sel.type]||{}, iType=d.itemType||'';
  var total=E.getOutput(sel,0);
  var h='<div class="ng-insp-sec"><div class="ng-wip-ov"><div class="ng-wip-ov-kpi ng-ov-hero"><span class="ng-ov-lbl">'+(iType==='inv'?'Invoiced':'Actual Cost')+'</span><span class="ng-ov-val '+(total>0?(iType==='inv'?'ng-ov-pos':'ng-ov-neg'):'ng-ov-zero')+'">'+E.fmtC(total)+'</span></div></div></div>';
  if(iType!=='inv' && iType!=='po'){
    var linkedTotal=0, linkedCount=0;
    try { var qbLines=(window.appData && window.appData.qbCostLines)||[]; qbLines.forEach(function(l){ if((l.linked_node_id||l.linkedNodeId)===sel.id){ linkedTotal+=Number(l.amount||0); linkedCount++; } }); } catch(e){}
    h+='<div class="ng-insp-sec"><label class="ng-insp-sublabel">Manual Total</label>'
      +'<input class="ng-insp-num" type="number" value="'+(sel.value||0)+'" data-node="'+sel.id+'" step="0.01" placeholder="0.00" />';
    if(linkedCount>0) h+='<div class="ng-insp-qblink">↳ Linked QB lines: '+E.fmtC(linkedTotal)+' ('+linkedCount+')</div>';
    h+='</div>';
  }
  h+='<div class="ng-insp-sec"><div class="ng-insp-sublabel">Line Items</div>'+lineItemsHtml(sel)+'</div>';
  return h;
}
// ── Slice 3c: PO + Sub shared action handlers (extracted from the canvas click
// delegate so the on-card AND inspector controls call one path) ────────────────
function poUnlinkPhase(fromId, toId){
  var ws=E.wires();
  for(var wi=ws.length-1; wi>=0; wi--){ if(ws[wi].fromNode===fromId && ws[wi].toNode===toId) ws.splice(wi,1); }
}
// Open the "+ Link phase" picker next to the trigger button. Body-level picker so the
// canvas transform/overflow can not clip it; works from card or inspector.
function poLinkAddOpen(btn){
  var poId=btn.getAttribute('data-po-node');
  var poN=E.findNode(poId);
  if(!poN) return;
  var alreadyWired={};
  E.wires().forEach(function(w){ if(w.fromNode===poId){ var tgt=E.findNode(w.toNode); if(tgt && tgt.type==='t2') alreadyWired[tgt.id]=true; } });
  var candidates=E.nodes().filter(function(nd){ return nd.type==='t2' && !alreadyWired[nd.id]; }).sort(function(a,b){ return (a.label||'').localeCompare(b.label||''); });
  if(!candidates.length){ alert('No more phases to link — every phase on this job is already wired from this PO. Drop a new phase onto the graph first if you need to.'); return; }
  var prev=document.getElementById('ng-po-link-picker'); if(prev) prev.remove();
  var pick=document.createElement('div'); pick.id='ng-po-link-picker';
  var rect=btn.getBoundingClientRect();
  var pickW=240, pickMaxH=320;
  var pickLeft=Math.max(8, Math.min(window.innerWidth-pickW-8, Math.round(rect.left)));
  var pickTop=Math.round(rect.bottom+4);
  if(pickTop+pickMaxH > window.innerHeight-8){ pickTop=Math.max(8, Math.round(rect.top-pickMaxH-4)); }
  pick.style.cssText='position:fixed;left:'+pickLeft+'px;top:'+pickTop+'px;background:#0f172a;border:1px solid rgba(255,255,255,0.22);border-radius:8px;padding:6px;z-index:99999;max-height:'+pickMaxH+'px;overflow-y:auto;width:'+pickW+'px;box-shadow:0 12px 28px rgba(0,0,0,0.6);font-family:inherit;';
  var hdr=document.createElement('div');
  hdr.style.cssText='font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#8b90a5;font-weight:600;padding:2px 6px 6px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:4px;';
  hdr.textContent='Pick a phase to link';
  pick.appendChild(hdr);
  candidates.forEach(function(c){
    var b=document.createElement('div');
    b.textContent=(c.label||c.type).split(' › ')[0];
    b.style.cssText='padding:7px 10px;cursor:pointer;color:#e6e6e6;font-size:12px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    b.onmouseenter=function(){ b.style.background='rgba(255,255,255,0.06)'; };
    b.onmouseleave=function(){ b.style.background='transparent'; };
    b.onmousedown=function(ev){
      ev.preventDefault(); ev.stopPropagation();
      var existing=E.wires().filter(function(w){ if(w.fromNode!==poId) return false; var t=E.findNode(w.toNode); return t && t.type==='t2'; });
      var defaultPct=100;
      if(existing.length){ var share=100/(existing.length+1); existing.forEach(function(w){ w.allocPct=share; }); defaultPct=share; }
      E.wires().push({ fromNode:poId, fromPort:0, toNode:c.id, toPort:0, allocPct:defaultPct });
      cleanup(); render();
    };
    pick.appendChild(b);
  });
  pick.addEventListener('mousedown', function(ev){ ev.stopPropagation(); });
  document.body.appendChild(pick);
  function cleanup(){ try{ pick.remove(); }catch(_){} document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); }
  function onDoc(ev){ if(pick.contains(ev.target)) return; cleanup(); }
  function onKey(ev){ if(ev.key==='Escape'){ ev.preventDefault(); cleanup(); } }
  setTimeout(function(){ document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
}
// Create a PO scoped to a sub's target phase/CO/T1 via the entity-create modal.
function subCreatePO(btn){
  var subNodeId=btn.getAttribute('data-sub-node');
  var tgtType=btn.getAttribute('data-target-type');
  var tgtId=btn.getAttribute('data-target-id');
  var subNode=E.findNode(subNodeId);
  if(!subNode) return;
  var subName=(subNode.data && subNode.data.name) || subNode.label || '';
  openEntityCreateModal('po', function(newEntry){
    if(!newEntry) return;
    newEntry.allocTarget={type:tgtType, id:tgtId};
    newEntry.subId=subNode.data&&subNode.data.id?subNode.data.id:'';
    if(!newEntry.vendor && subName) newEntry.vendor=subName;
    if(typeof saveData==='function') saveData();
    var pcx=subNode.x-300, pcy=subNode.y+80;
    var lbl=entryLabel('po',newEntry);
    var poNode=E.addNode('po',pcx,pcy,lbl,newEntry);
    if(poNode){ poNode.allocTarget={type:tgtType, id:tgtId}; E.wires().push({fromNode:poNode.id,fromPort:0,toNode:subNode.id,toPort:0}); E.saveGraph(); }
    render();
  });
  if(subName){
    setTimeout(function(){
      var vEl=document.getElementById('poVendor'); if(vEl && !vEl.value) vEl.value=subName;
      var dEl=document.getElementById('poDescription');
      if(dEl && !dEl.value){ var tgtNode=E.findNode(btn.getAttribute('data-target-node')); if(tgtNode) dEl.value=subName+' — '+(tgtNode.label||tgtNode.type); }
    }, 0);
  }
}
// PO Inspector detail (Slice 3c): Contract/Invoiced KPIs + editable Base Contract +
// linked-phase allocation (alloc% / unlink / link) + amendment line items.
function inspectorPOHtml(sel){
  E.resetComp(); E.getOutput(sel,0);
  var poContract=sel._poContract||0, poInv=sel._poInvoiced||0;
  var h='<div class="ng-insp-sec"><div class="ng-wip-ov">'
    +'<div class="ng-wip-ov-kpi"><span class="ng-ov-lbl">Contract</span><span class="ng-ov-val">'+E.fmtC(poContract)+'</span></div>'
    +'<div class="ng-wip-ov-kpi"><span class="ng-ov-lbl">Invoiced</span><span class="ng-ov-val ng-ov-pos">'+E.fmtC(poInv)+'</span></div>'
    +'</div></div>';
  h+='<div class="ng-insp-sec"><label class="ng-insp-sublabel">Base Contract</label><input class="ng-insp-num" type="number" value="'+(sel.value||0)+'" data-node="'+sel.id+'" step="0.01" placeholder="0.00" /></div>';
  var phaseWires=[];
  E.wires().forEach(function(w){ if(w.fromNode!==sel.id) return; var tgt=E.findNode(w.toNode); if(tgt && tgt.type==='t2') phaseWires.push({wire:w, phase:tgt}); });
  var totalAlloc=phaseWires.reduce(function(s,pw){ return s+(pw.wire.allocPct!=null?Number(pw.wire.allocPct)||0:100); },0);
  var allocOk=phaseWires.length===0 || Math.abs(totalAlloc-100)<0.5;
  h+='<div class="ng-insp-sec ng-po-linked-section"><div class="ng-insp-sublabel ng-po-linked-head">Linked Phases';
  if(phaseWires.length) h+='<span class="ng-po-alloc-badge'+(allocOk?'':' ng-warn')+'" title="'+(allocOk?'Allocation totals 100%':'Allocation does not sum to 100% — phase rollups will under/over count')+'">'+totalAlloc.toFixed(0)+'%</span>';
  h+='</div>';
  if(!phaseWires.length){
    h+='<div class="ng-insp-empty">No phases linked yet. Cost flows via the sub. Link a phase to split this PO across phases.</div>';
  } else {
    phaseWires.forEach(function(pw){
      var pname=(pw.phase.label||pw.phase.type).split(' › ')[0].trim();
      var pa=pw.wire.allocPct!=null?Number(pw.wire.allocPct):100;
      h+='<div class="ng-po-row"><span class="ng-po-row-name">▤ '+luEsc(pname)+'</span>'
        +'<input class="ng-po-alloc" type="number" min="0" max="100" step="1" value="'+pa.toFixed(0)+'" data-from="'+sel.id+'" data-to="'+pw.phase.id+'" title="Allocation % to this phase" />'
        +'<span class="ng-po-pct">%</span>'
        +'<span class="ng-po-unlink" data-from="'+sel.id+'" data-to="'+pw.phase.id+'" title="Unlink phase">✖</span></div>';
    });
  }
  h+='<button class="ng-po-link-add" type="button" data-po-node="'+sel.id+'" title="Link this PO to a phase">+ Link phase</button></div>';
  h+='<div class="ng-insp-sec"><div class="ng-insp-sublabel">Amendments</div>'+lineItemsHtml(sel)+'</div>';
  return h;
}
// Sub Inspector detail (Slice 3c): Actual/Accrued + editable Manual Total + the scope
// breakdown (per target, with Create-PO) + line items.
function inspectorSubHtml(sel){
  E.resetComp();
  var subActual=E.getActual(sel), subAccrued=E.getAccrued(sel);
  var h='<div class="ng-insp-sec"><div class="ng-wip-ov">'
    +'<div class="ng-wip-ov-kpi"><span class="ng-ov-lbl">Actual</span><span class="ng-ov-val ng-ov-pos">'+E.fmtC(subActual)+'</span></div>'
    +'<div class="ng-wip-ov-kpi"><span class="ng-ov-lbl">Accrued</span><span class="ng-ov-val ng-ov-neg">'+E.fmtC(subAccrued)+'</span></div>'
    +'</div></div>';
  h+='<div class="ng-insp-sec"><label class="ng-insp-sublabel">Manual Total</label><input class="ng-insp-num" type="number" value="'+(sel.value||0)+'" data-node="'+sel.id+'" step="0.01" placeholder="0.00" /></div>';
  var subTargets=[];
  E.wires().forEach(function(w){ if(w.fromNode!==sel.id) return; var tgt=E.findNode(w.toNode); if(tgt && (tgt.type==='t2'||tgt.type==='t1'||tgt.type==='co')) subTargets.push(tgt); });
  if(subTargets.length){
    var poNodes=[];
    E.wires().forEach(function(w){ if(w.toNode!==sel.id) return; var src=E.findNode(w.fromNode); if(src && src.type==='po') poNodes.push(src); });
    h+='<div class="ng-insp-sec"><div class="ng-insp-sublabel">Scope Breakdown</div>';
    subTargets.forEach(function(tgt){
      var tname=(tgt.label||tgt.type).split(' › ')[0].trim();
      var tIcon=tgt.type==='t2'?'📋':tgt.type==='t1'?'🏗':'📄';
      var tDataId=tgt.data&&tgt.data.id?tgt.data.id:'';
      var poAmt=0, poCount=0;
      poNodes.forEach(function(po){ var at=po.allocTarget; if(at && at.type===tgt.type && at.id===tDataId){ var poEntry=(typeof appData!=='undefined' && appData.purchaseOrders)?appData.purchaseOrders.find(function(p){return p.id===(po.data&&po.data.id);}):null; if(poEntry){ poAmt+=(poEntry.amount||0); poCount++; } } });
      h+='<div class="ng-po-row"><span class="ng-po-row-name">'+tIcon+' '+luEsc(tname)+'</span>';
      if(poCount>0) h+='<span class="ng-po-pocount">'+poCount+' PO '+E.fmtC(poAmt)+'</span>';
      h+='<span class="ng-sub-add-po" data-sub-node="'+sel.id+'" data-target-type="'+tgt.type+'" data-target-id="'+tDataId+'" data-target-node="'+tgt.id+'" title="Create PO for '+luEsc(tname)+'">+</span></div>';
    });
    h+='</div>';
  }
  h+='<div class="ng-insp-sec"><div class="ng-insp-sublabel">Line Items</div>'+lineItemsHtml(sel)+'</div>';
  return h;
}
// Building KPI grid HTML — shared by the legacy left panel + the right Inspector.
// Condensed, professional building metric strip: a lead % Complete (editable) with a
// progress bar, then a tight 4-cell row (Revenue · Cost · Profit · Margin). Replaces the
// old 8-tile sprawl; Rev.Earned/Accrued/Budget fold into Cost (act+acc) + the drill-downs.
function buildingKpiGridHtml(sel){
  var bRev=E.getBuildingAllocatedRevenue(sel);
  var pct=E.getT1WeightedPct(sel);
  var revEarned=bRev*(pct/100);
  var act=E.getActual(sel), acc=E.getAccrued(sel), cost=act+acc;
  var gp=revEarned-cost;
  var margin=bRev>0?(gp/bRev*100):0;
  function cls(n){ return n>0?'ng-ov-pos':n<0?'ng-ov-neg':'ng-ov-zero'; }
  var pw=Math.max(0,Math.min(100,pct));
  return '<div class="ng-kpi">'
    +'<div class="ng-kpi-lead">'
      +'<div class="ng-kpi-lead-top"><span class="ng-kpi-lead-l">% Complete</span>'
        +'<span class="ng-pct-val '+(pct>0?'ng-ov-pos':'ng-ov-zero')+'" data-prog-edit="'+sel.id+'" style="cursor:pointer" title="Click to edit %">'+pct.toFixed(1)+'%</span></div>'
      +'<div class="ng-kpi-bar"><span style="width:'+pw+'%"></span></div>'
    +'</div>'
    +'<div class="ng-kpi-row">'
      +'<div class="ng-kpi-cell"><span class="ng-kpi-k">Revenue</span><span class="ng-kpi-v '+cls(bRev)+'">'+E.fmtC(bRev)+'</span></div>'
      +'<div class="ng-kpi-cell"><span class="ng-kpi-k">Cost</span><span class="ng-kpi-v '+(cost>0?'ng-ov-neg':'ng-ov-zero')+'">'+E.fmtC(cost)+'</span></div>'
      +'<div class="ng-kpi-cell"><span class="ng-kpi-k">Profit</span><span class="ng-kpi-v '+cls(gp)+'">'+E.fmtC(gp)+'</span></div>'
      +'<div class="ng-kpi-cell"><span class="ng-kpi-k">Margin</span><span class="ng-kpi-v '+cls(margin)+'">'+margin.toFixed(0)+'%</span></div>'
    +'</div></div>';
}

// Split a building's allocated revenue into ORIGINAL CONTRACT (connected scopes/
// phases, incl. wireless matrix scopes) vs CHANGE ORDERS (connected COs), so a
// building reads its as-sold revenue separately from its CO revenue. DISPLAY-ONLY:
// coRev = Σ getCOIncomeToParent (exact), contractRev = total − coRev (so the split
// always reconciles to the Revenue tile / getBuildingAllocatedRevenue). Contract
// detail rows come from the same summands the engine adds; any residual (e.g. a
// matrix-formula nuance) folds into an "Other contract allocation" reconciling row.
function buildingRevSources(sel){
  var contract=[], cos=[], coRev=0, wiredPh={};
  E.wires().forEach(function(w){
    if(w.toNode!==sel.id) return;
    var src=E.findNode(w.fromNode); if(!src) return;
    if(src.type==='t2'){
      if(src.data && src.data.id) wiredPh[src.data.id]=1;
      contract.push({ name:(src.label||'Scope').split(' › ')[0].trim(), rev:E.getPhaseRevenueToBuilding(src, sel.id), pct:src.pctComplete||0 });
    } else if(src.type==='co'){
      var cr=E.getCOIncomeToParent(src, sel.id); coRev+=cr;
      cos.push({ name:(src.label||'CO').split(' › ')[0].trim(), rev:cr, pct:src.pctComplete||0 });
    }
  });
  // Wireless matrix-allocated scopes (contract revenue with no t2 node/wire) —
  // same union getBuildingAllocatedRevenue sums; mirror childGroupsHtml's filter.
  if(sel.data && sel.data.id && window.appData && Array.isArray(window.appData.phases)){
    var bId=sel.data.id, jid=(window.appState&&window.appState.currentJobId)||null;
    window.appData.phases.forEach(function(p){
      if(!p || p.jobId!==jid || p.buildingId!==bId || wiredPh[p.id]) return;
      contract.push({ name:(p.phase||'Scope'), rev:(p.asSoldRevenue||p.asSoldPhaseBudget||p.phaseBudget||0), pct:Math.max(0,Math.min(100,p.pctComplete||0)), matrix:true });
    });
  }
  var totalRev=E.getBuildingAllocatedRevenue(sel);
  var contractRev=totalRev-coRev;
  // ALLOCATION MODE (contractPct set): this building's contract is its SHARE of the
  // one job-level contract — the engine no longer counts its scope rows toward the
  // contract — so show a single clear allocation row instead of scope rows.
  if(sel.contractPct!=null){
    var hadScopes=contract.length>0;
    return {
      contract:[{ name:'Contract allocation ('+Number(sel.contractPct).toFixed(1)+'% of job)', rev:contractRev, pct:0, alloc:true }],
      cos:cos, contractRev:contractRev, coRev:coRev, totalRev:totalRev,
      allocMode:true, scopesPresent:hadScopes
    };
  }
  var cSum=contract.reduce(function(a,c){ return a+(c.rev||0); }, 0);
  var gap=contractRev-cSum;
  if(Math.round(gap)>=1 || Math.round(gap)<=-1){ contract.push({ name:'Other contract allocation', rev:gap, pct:0, other:true }); }
  return { contract:contract, cos:cos, contractRev:contractRev, coRev:coRev, totalRev:totalRev };
}

// Two-section revenue breakdown for the building inspector: Original contract on
// top, a SEPARATE Change Orders block below it (only when a CO is allocated to
// this building). Returns '' when nothing is allocated yet.
function buildingRevBreakdownHtml(sel){
  if(!sel || sel.type!=='t1') return '';
  var s=buildingRevSources(sel);
  if(!s.contract.length && !s.cos.length) return '';
  var row=function(c, color){
    return '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 2px 8px;font-size:11px;color:var(--ng-textdim,#8b90a5);">'
      +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+luEsc(c.name)+(c.matrix?' <span style="font-size:8px;color:#6b6f82;">matrix</span>':'')+'</span>'
      +'<span style="font-family:\'Courier New\',monospace;color:'+(color||'#4f8cff')+';">'+E.fmtC(c.rev)+'</span>'
      +'</div>';
  };
  var secHdr=function(title, amount, color){
    return '<div style="display:flex;align-items:center;padding:3px 0 1px;font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:'+(color||'#6a7090')+';font-weight:700;">'
      +'<span style="flex:1;">'+title+'</span>'
      +'<span style="font-family:\'Courier New\',monospace;">'+E.fmtC(amount)+'</span></div>';
  };
  // Allocation-mode row carries click-to-edit % and $ chips so a building can be
  // re-shared without leaving its inspector (the job-level panel allocates the set).
  var jc=ngJobContract();
  var allocRow=function(c){
    return '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 2px 8px;font-size:11px;color:var(--ng-textdim,#8b90a5);">'
      +'<span style="flex:1;">Share of job contract</span>'
      +'<span class="ng-contract-pct" data-contract-bldg="'+luEsc(sel.id)+'" title="Click to edit this building’s % of the job contract" style="cursor:pointer;font-family:\'Courier New\',monospace;color:#fbbf24;min-width:46px;text-align:right;">'+Number(sel.contractPct).toFixed(1)+'%</span>'
      +'<span class="ng-contract-share" data-contract-bldg="'+luEsc(sel.id)+'" data-contract-total="'+jc+'" title="Click to enter this building’s contract dollars" style="cursor:pointer;font-family:\'Courier New\',monospace;color:#4f8cff;min-width:66px;text-align:right;">'+E.fmtC(c.rev)+'</span>'
      +'</div>';
  };
  var h='<div class="ng-insp-sec ng-bld-revbreak" style="padding-top:4px;">';
  h+='<div style="display:flex;align-items:center;font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#8b90a5;font-weight:600;margin-bottom:1px;">'
    +'<span style="flex:1;">Revenue allocation</span>'
    + (s.allocMode ? '' : (jc>0 ? '<span class="ng-contract-start" data-contract-bldg="'+luEsc(sel.id)+'" title="Give this building a share of the job contract" style="cursor:pointer;color:#4f8cff;font-weight:700;">+ allocate share</span>' : ''))
    +'</div>';
  h+=secHdr('Original contract', s.contractRev, '#4f8cff');
  h+=s.allocMode ? s.contract.map(allocRow).join('') : s.contract.map(function(c){ return row(c, '#4f8cff'); }).join('');
  if(s.allocMode && s.scopesPresent){
    h+='<div style="padding:1px 0 2px 8px;font-size:9px;font-style:italic;color:#6b6f82;">Contract set by allocation — scopes drive % complete only.</div>';
  }
  if(s.cos.length){
    h+='<div style="margin-top:3px;padding-top:3px;border-top:1px dashed var(--ng-border2);">';
    h+=secHdr('Change Orders', s.coRev, '#fbbf24');
    h+=s.cos.map(function(c){ return row(c, '#fbbf24'); }).join('');
    h+='</div>';
  }
  h+='<div style="display:flex;align-items:center;padding:4px 0 1px;margin-top:3px;border-top:1px solid var(--ng-border2);font-size:11px;font-weight:700;color:#c8cbe0;">'
    +'<span style="flex:1;">Total revenue</span>'
    +'<span style="font-family:\'Courier New\',monospace;color:#34d399;">'+E.fmtC(s.totalRev)+'</span></div>';
  h+='</div>';
  return h;
}

// ── L/U Phase 1: building Levels & Units ───────────────────────────────────
// A building (t1) optionally breaks into levels (floors) and/or units. A unit
// sits on a level (unit.levelId) or is building-wide (levelId null). Stored on
// the node + persisted in the graph blob. Revenue allocation + assigning scope
// nodes to a level/unit come in the next phases — this slice is the structure.
function luEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function luUid(p){ return p+'_'+Math.random().toString(36).slice(2,7)+(Date.now()%100000).toString(36); }
function luById(arr,id){ if(!arr) return null; for(var i=0;i<arr.length;i++){ if(arr[i].id===id) return arr[i]; } return null; }
// Mutate a building's levels/units (add/rename/remove). Shared by the legacy left
// panel + the right Inspector; callers persist (saveGraph) + re-render after.
// L/U rework (ST-1): counts + completion. Levels/units are count-based (name
// optional) and each carries a `done` flag. Levels are set by total; units by a
// building-wide total OR per-level count. Marking off toggles `done`; a level with
// units auto-completes when all its units are done.
// Set a unit's or level's completion %. `done` is kept in sync (100 = done) so
// legacy readers + the checkmark controls still agree.
function luSetPct(bn, kind, id, pct){
  pct=Math.max(0,Math.min(100,Math.round(Number(pct)||0)));
  if(kind==='unit'){ var U=luById(bn.units,id); if(U){ U.pct=pct; U.done=pct>=100; } }
  else if(kind==='level'){ var L=luById(bn.levels,id); if(L){ L.pct=pct; L.done=pct>=100; } }
}
// The building card renders in two places — the floating .ng-sp-bldg panel and the
// right Inspector. Refresh whichever is mounted so an L/U edit is reflected wherever
// the user is looking. (Both are idempotent re-renders; neither calls the other.)
function luRefresh(){ if(typeof renderBuildingMetrics==='function') renderBuildingMetrics(); if(typeof renderInspector==='function') renderInspector(); if(typeof renderSidebarMetrics==='function') renderSidebarMetrics(); }
// Read-first % editor — a small popover of quick chips + a type-in, anchored to
// the cube / level the user tapped. Replaces prompt() so the card stays calm.
var _luPop=null;
function _luPopOutside(ev){ if(_luPop && !_luPop.contains(ev.target)) closeLuPop(); }
function closeLuPop(){ if(_luPop){ _luPop.remove(); _luPop=null; document.removeEventListener('mousedown', _luPopOutside, true); } }
function openLuPctPop(bn, kind, id, anchorEl){
  closeLuPop();
  var node = kind==='unit' ? luById(bn.units,id) : luById(bn.levels,id);
  if(!node) return;
  var cur=Math.round((node.pct!=null)?node.pct:(node.done?100:0));
  var p=document.createElement('div'); p.className='ng-lu-pop';
  var chips=[0,25,50,75,100].map(function(v){ return '<button class="ng-lu-pchip'+(v===cur?' on':'')+'" data-v="'+v+'">'+v+'</button>'; }).join('');
  p.innerHTML='<div class="ng-lu-pchips">'+chips+'</div>'
    +'<div class="ng-lu-prow"><input class="ng-lu-pin" type="number" min="0" max="100" step="5" value="'+cur+'" aria-label="Percent complete"/><span>%</span><button class="ng-lu-pset">Set</button></div>';
  document.body.appendChild(p); _luPop=p;
  var r=anchorEl.getBoundingClientRect();
  p.style.left=Math.max(8,Math.min(r.left, window.innerWidth-184))+'px';
  p.style.top=Math.min(r.bottom+6, window.innerHeight-120)+'px';
  function apply(v){ luSetPct(bn, kind, id, v); if(E.saveGraph) E.saveGraph(); closeLuPop(); luRefresh(); }
  p.querySelectorAll('.ng-lu-pchip').forEach(function(b){ b.onclick=function(){ apply(+b.getAttribute('data-v')); }; });
  var inp=p.querySelector('.ng-lu-pin');
  p.querySelector('.ng-lu-pset').onclick=function(){ apply(parseFloat(inp.value)); };
  inp.onkeydown=function(ev){ if(ev.key==='Enter'){ apply(parseFloat(inp.value)); } };
  setTimeout(function(){ document.addEventListener('mousedown', _luPopOutside, true); inp.focus(); inp.select(); }, 0);
}
// Set a matrix-allocated scope's % complete from the building card. Writes the
// appData.phases record's pctComplete, persists appData (saveData) + flushes the
// graph rollup (updateT1Progress carries the new scope % up to the building %/job),
// persists the graph, then re-renders whichever card is showing.
function applyScopePct(p, v){
  if(!p) return;
  p.pctComplete = Math.max(0, Math.min(100, Math.round(Number(v)||0)));
  if(typeof updateT1Progress==='function') updateT1Progress();       // flush building %
  if(typeof pushToJobSilent==='function') pushToJobSilent();          // flush job pct/revenue cache
  if(typeof window.saveData==='function') window.saveData();          // persist appData (phase pct + job cache)
  if(E.saveGraph) E.saveGraph();                                      // persist graph nodes
  luRefresh();                                                        // repaint card + inspector + top strip
}
window.p86NgScopePct = function(phaseId, anchorEl){
  var p = (window.appData && Array.isArray(window.appData.phases)) ? window.appData.phases.find(function(x){ return x && x.id===phaseId; }) : null;
  if(p) openScopePctPop(p, anchorEl);
};
// Reuses the read-first % popover (same .ng-lu-pop chrome as the level/unit editor).
function openScopePctPop(p, anchorEl){
  closeLuPop();
  var cur=Math.round(Number(p.pctComplete)||0);
  var el=document.createElement('div'); el.className='ng-lu-pop';
  var chips=[0,25,50,75,100].map(function(v){ return '<button class="ng-lu-pchip'+(v===cur?' on':'')+'" data-v="'+v+'">'+v+'</button>'; }).join('');
  el.innerHTML='<div class="ng-lu-pchips">'+chips+'</div>'
    +'<div class="ng-lu-prow"><input class="ng-lu-pin" type="number" min="0" max="100" step="5" value="'+cur+'" aria-label="Scope percent complete"/><span>%</span><button class="ng-lu-pset">Set</button></div>';
  document.body.appendChild(el); _luPop=el;
  var r=anchorEl.getBoundingClientRect();
  el.style.left=Math.max(8,Math.min(r.left-120, window.innerWidth-184))+'px';
  el.style.top=Math.min(r.bottom+6, window.innerHeight-120)+'px';
  function ap(v){ closeLuPop(); applyScopePct(p, v); }
  el.querySelectorAll('.ng-lu-pchip').forEach(function(b){ b.onclick=function(){ ap(+b.getAttribute('data-v')); }; });
  var inp=el.querySelector('.ng-lu-pin');
  el.querySelector('.ng-lu-pset').onclick=function(){ ap(parseFloat(inp.value)); };
  inp.onkeydown=function(ev){ if(ev.key==='Enter'){ ap(parseFloat(inp.value)); } };
  setTimeout(function(){ document.addEventListener('mousedown', _luPopOutside, true); inp.focus(); inp.select(); }, 0);
}
function luApply(bn, act, id){
  if(!bn.levels) bn.levels=[]; if(!bn.units) bn.units=[];
  var nm, n, L, U;
  function lUnits(lid){ return bn.units.filter(function(u){ return u.levelId===lid; }); }
  function bwUnits(){ return bn.units.filter(function(u){ return u.levelId==null; }); }
  function addUnit(lid){ bn.units.push({id:luUid('un'), name:'Unit '+(bn.units.length+1), levelId:lid, done:false, pct:0}); }
  function setLevels(cnt){ cnt=Math.max(0, cnt|0);
    while(bn.levels.length<cnt) bn.levels.push({id:luUid('lv'), name:'Level '+(bn.levels.length+1), done:false, pct:0});
    while(bn.levels.length>cnt){ var last=bn.levels.pop(); bn.units.forEach(function(u){ if(u.levelId===last.id) u.levelId=null; }); } }
  function setCount(lid, cnt){ cnt=Math.max(0, cnt|0); var cur=lUnits(lid).length;
    while(cur<cnt){ addUnit(lid); cur++; }
    while(cur>cnt){ for(var i=bn.units.length-1;i>=0;i--){ if(bn.units[i].levelId===lid){ bn.units.splice(i,1); break; } } cur--; } }
  function setBW(cnt){ cnt=Math.max(0, cnt|0); var cur=bwUnits().length;
    while(cur<cnt){ addUnit(null); cur++; }
    while(cur>cnt){ for(var i=bn.units.length-1;i>=0;i--){ if(bn.units[i].levelId==null){ bn.units.splice(i,1); break; } } cur--; } }
  // ── Levels ──
  if(act==='lvl-inc') setLevels(bn.levels.length+1);
  else if(act==='lvl-dec') setLevels(bn.levels.length-1);
  else if(act==='lvl-set'){ n=parseInt(prompt('How many levels (floors)?', bn.levels.length||1),10); if(!isNaN(n)) setLevels(n); }
  else if(act==='rename-level'){ L=luById(bn.levels,id); if(L){ nm=prompt('Level name:', L.name); if(nm&&nm.trim()) L.name=nm.trim(); } }
  else if(act==='lvl-done'){ L=luById(bn.levels,id); if(L){ var lu=lUnits(id); if(lu.length){ var allD=lu.every(function(u){return u.done;}); lu.forEach(function(u){ u.done=!allD; u.pct=u.done?100:0; }); } else { L.done=!L.done; L.pct=L.done?100:0; } } }
  // ── Units ──
  else if(act==='unit-inc') addUnit(null);
  else if(act==='unit-dec') setBW(bwUnits().length-1);
  else if(act==='unit-set'){ n=parseInt(prompt('How many building-wide units?', bwUnits().length),10); if(!isNaN(n)) setBW(n); }
  else if(act==='lvl-unit-set'){ n=parseInt(prompt('How many units on this level?', lUnits(id).length),10); if(!isNaN(n)) setCount(id, n); }
  else if(act==='unit-done'){ U=luById(bn.units,id); if(U){ U.done=!U.done; U.pct=U.done?100:0; } }
  else if(act==='del-unit'){ U=luById(bn.units,id); if(U) bn.units=bn.units.filter(function(x){ return x.id!==id; }); }
}

// ── Scope → PHASES (nested completion breakdown) ─────────────────────────────
// A scope (t2) can be broken into weighted phases (Demo, Putback, …). Each phase
// carries a weight (share of the scope, default 1 = equal) and a % complete; the
// scope's % = E.scopePctFromPhases(node) rolls up to the building/job unchanged.
// Which scopes are expanded on the building card (transient — NOT persisted).
var ngOpenScopes={};
function scopePhasesHtml(k){
  var ph=Array.isArray(k.phases)?k.phases:[];
  var h='<div class="ng-ph-editor" style="padding:2px 0 8px 26px;">';
  if(!ph.length){
    h+='<div style="color:#8b90a5;font-size:11px;line-height:1.5;padding:2px 0 6px;">Break this scope into steps (e.g. Demo, Putback). Each carries a weight and a % that roll up to the scope — and up to the building.</div>';
  } else {
    ph.forEach(function(p){
      var pc=Number(p.pct); pc=(!(pc>=0))?0:(pc>100?100:pc);
      var col=pc>=100?'#34d399':pc>=50?'#fbbf24':'#4f8cff';
      var wt=(Number(p.weight)>0)?Number(p.weight):1;
      h+='<div class="ng-ph-row" style="display:flex;align-items:center;gap:6px;padding:2px 0;">'
        +'<button data-ph-act="ph-done" data-scope="'+k.id+'" data-ph="'+p.id+'" title="'+(pc>=100?'Complete — tap to clear':'Mark complete')+'" style="flex:0 0 auto;border:0;background:transparent;cursor:pointer;color:'+(pc>=100?'#34d399':'#8b90a5')+';font-size:13px;width:16px;line-height:1;">'+(pc>=100?'✓':'○')+'</button>'
        +'<span data-ph-act="ph-rename" data-scope="'+k.id+'" data-ph="'+p.id+'" title="Rename" style="flex:1 1 auto;min-width:0;cursor:pointer;font-size:12px;color:#d6d9e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+luEsc(p.name||'Phase')+'</span>'
        +'<span data-ph-act="ph-weight" data-scope="'+k.id+'" data-ph="'+p.id+'" title="Weight — this phase’s share of the scope" style="cursor:pointer;flex:0 0 auto;color:#8b90a5;font-size:9px;font-family:\'Courier New\',monospace;">w'+wt+'</span>'
        +'<span data-ph-act="ph-pct" data-scope="'+k.id+'" data-ph="'+p.id+'" title="Set % complete" style="cursor:pointer;flex:0 0 auto;color:'+col+';font-family:\'Courier New\',monospace;font-size:11px;min-width:34px;text-align:right;">'+Math.round(pc)+'%</span>'
        +'<button data-ph-act="ph-del" data-scope="'+k.id+'" data-ph="'+p.id+'" title="Remove phase" style="flex:0 0 auto;border:0;background:transparent;cursor:pointer;color:#6b6f82;font-size:12px;width:14px;line-height:1;">×</button>'
        +'</div>';
    });
  }
  h+='<button data-ph-act="ph-add" data-scope="'+k.id+'" style="margin-top:4px;border:1px dashed #3a3f52;background:transparent;color:#a78bfa;border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;">+ Add phase</button>';
  h+='</div>';
  return h;
}
function phApply(sc, act, phId){
  if(!sc) return;
  if(!Array.isArray(sc.phases)) sc.phases=[];
  var ph=sc.phases, p, nm, v;
  function byId(id){ return ph.filter(function(x){ return x.id===id; })[0]; }
  if(act==='ph-toggle'){ ngOpenScopes[sc.id]=!ngOpenScopes[sc.id]; return; }
  if(act==='ph-add'){
    nm=prompt('Phase name (e.g. Demo, Putback):',''); if(nm==null) return;
    nm=nm.trim()||('Phase '+(ph.length+1));
    ph.push({ id:luUid('ph'), name:nm, weight:1, pct:0 });
    ngOpenScopes[sc.id]=true;
    // A scope with phases is phase-driven — take its wire off unit-mode so the
    // phase math (not building units) drives its %.
    E.wires().forEach(function(w){ if(w.fromNode===sc.id && w.trackMode==='units') w.trackMode='percent'; });
    return;
  }
  p=byId(phId); if(!p) return;
  if(act==='ph-done'){ p.pct=(Number(p.pct)>=100)?0:100; }
  else if(act==='ph-pct'){ v=prompt('% complete for "'+(p.name||'phase')+'" (0–100):', Math.round(Number(p.pct)||0)); if(v==null) return; v=parseFloat(v); if(!isNaN(v)) p.pct=Math.max(0,Math.min(100,v)); }
  else if(act==='ph-weight'){ v=prompt('Weight for "'+(p.name||'phase')+'" (relative share of the scope; default 1):', (Number(p.weight)>0?Number(p.weight):1)); if(v==null) return; v=parseFloat(v); if(!isNaN(v)&&v>0) p.weight=v; } // reject 0/negative — a 0 would render as 'w1' but contribute nothing (displayed≠effective)
  else if(act==='ph-rename'){ nm=prompt('Phase name:', p.name||''); if(nm&&nm.trim()) p.name=nm.trim(); }
  else if(act==='ph-del'){ sc.phases=ph.filter(function(x){ return x.id!==phId; }); }
}

// Instrument-panel building structure (read-first): levels render as a boombox
// graphic-EQ stack (segmented bars, click a segment or the % to set completion);
// units render as thermometer cubes (bottom-up fill = %, tap to set). All the
// same data + rollup as before — just a calmer, at-a-glance look.
function renderBuildingStructure(panel, sel){
  var el=panel.querySelector('.ng-sp-struct'); if(!el) return;
  if(!sel.levels) sel.levels=[]; if(!sel.units) sel.units=[];
  var lv=sel.levels, un=sel.units;
  function uPct(u){ var p=(u&&u.pct!=null)?Number(u.pct):(u&&u.done?100:0); return (p>=0)?(p>100?100:Math.round(p)):0; }
  function lUnits(lid){ return un.filter(function(u){ return u.levelId===lid; }); }
  function bwUnits(){ return un.filter(function(u){ return !luById(lv, u.levelId); }); } // null OR orphaned level
  // A level's % is the average of its units', or its own typed pct when it has none.
  function lPct(L){ var lu=lUnits(L.id); if(lu.length){ var s=0; lu.forEach(function(u){ s+=uPct(u); }); return Math.round(s/lu.length); } return (L.pct!=null)?Math.max(0,Math.min(100,Math.round(L.pct))):(L.done?100:0); }
  function col(p){ return p>=70?'#1e9e75':p>=40?'#e0a13a':p>0?'#d1594a':''; } // green / amber / red / empty
  // When a SCOPE (phase) tracks THIS building by its own units, the building's
  // cubes are just the count (the denominator) — completion is set per scope, so
  // render them read-only + neutral so they aren't mistaken for editable progress.
  var scopesDrive = E.wires().some(function(w){ return w.toNode===sel.id && w.trackMode==='units' && sel.units && sel.units.length; });
  var totalUnits=un.length; var uSum=0; un.forEach(function(u){ uSum+=uPct(u); }); var bldPct=totalUnits?Math.round(uSum/totalUnits):0;

  // A segmented EQ bar. `editable` levels get per-segment quick-set (seg×20).
  function eqBar(p, editable, lid){
    var c=col(p), lit=Math.round(p/20), seg='';
    for(var s=1;s<=5;s++){ var on=s<=lit;
      seg+='<i class="ng-eq-seg'+(on?' on':'')+'"'+(editable?' data-lu-act="lvl-seg" data-id="'+lid+'" data-seg="'+s+'"':'')
         +(on&&c?(' style="background:'+c+';"'):'')+'></i>';
    }
    return '<div class="ng-eq-bar'+(editable?' ed':'')+'">'+seg+'</div>';
  }
  // A thermometer cube — fill height = pct. Tap opens the % popover.
  function cubes(list){ return list.map(function(u){ var p=uPct(u), c=col(p);
    if(scopesDrive) return '<span class="ng-th-cube ng-lu-cube-ro" title="Completion is tracked per scope"></span>';
    return '<span class="ng-th-cube" data-lu-act="unit-pop" data-id="'+u.id+'" title="'+p+'% — tap to set">'
      +'<i style="height:'+p+'%;'+(c?('background:'+c+';'):'')+'"></i></span>';
  }).join(''); }

  var h='<div class="ng-sp-struct-head"><span class="ng-sp-struct-ttl">Structure</span>'
      +'<span class="ng-lu-sum">'+lv.length+' level'+(lv.length===1?'':'s')+' · '+totalUnits+' unit'+(totalUnits===1?'':'s')+'</span></div>';

  // ── Levels (boombox EQ stack) ──
  h+='<div class="ng-lu-sec-head"><span class="ng-lu-sec-lbl">Levels</span>'
    +'<span class="ng-lu-stepper"><button class="ng-lu-step" data-lu-act="lvl-dec" title="Remove top level">−</button>'
    +'<button class="ng-lu-num" data-lu-act="lvl-set" title="Set number of levels">'+lv.length+'</button>'
    +'<button class="ng-lu-step" data-lu-act="lvl-inc" title="Add a level">+</button></span></div>';
  if(!lv.length){
    h+='<div class="ng-sp-struct-empty">No floors yet. Set how many levels this building has.</div>';
  } else {
    h+='<div class="ng-eq-stack">';
    lv.slice().reverse().forEach(function(L){ var lu=lUnits(L.id), hasU=lu.length>0, p=lPct(L);
      h+='<div class="ng-eq-row">'
        +'<span class="ng-eq-nm" data-lu-act="rename-level" data-id="'+L.id+'" title="Rename">'+luEsc(L.name)+'</span>'
        + eqBar(p, !hasU && !scopesDrive, L.id)
        +(hasU
          ? '<span class="ng-eq-pct">'+lu.filter(function(u){return uPct(u)>=100;}).length+'/'+lu.length+'</span>'
          : '<span class="ng-eq-pct'+(scopesDrive?'':' ed')+'"'+(scopesDrive?'':' data-lu-act="lvl-pop" data-id="'+L.id+'" title="Set exact %"')+'>'+p+'%</span>')
        +'</div>';
    });
    h+='</div>';
  }

  // ── Units (thermometer cubes) ──
  var bwu=bwUnits();
  h+='<div class="ng-lu-sec-head" style="margin-top:14px"><span class="ng-lu-sec-lbl">Units</span>'
    +'<span class="ng-lu-stepper"><button class="ng-lu-step" data-lu-act="unit-dec" title="Remove a building-wide unit">−</button>'
    +'<button class="ng-lu-num" data-lu-act="unit-set" title="Set building-wide unit count">'+bwu.length+'</button>'
    +'<button class="ng-lu-step" data-lu-act="unit-inc" title="Add a building-wide unit">+</button></span></div>';
  if(!totalUnits){
    h+='<div class="ng-sp-struct-empty">No units yet. Set a building-wide total, or add units to a level.</div>';
  } else {
    lv.forEach(function(L){ var lu=lUnits(L.id);
      h+='<div class="ng-lu-ugroup"><div class="ng-lu-ghead"><span>'+luEsc(L.name)+' · '+lu.length+' unit'+(lu.length===1?'':'s')+'</span>'
        +'<button class="ng-lu-mini" data-lu-act="lvl-unit-set" data-id="'+L.id+'" title="Set units on this level">+ units</button></div>'
        +'<div class="ng-th-cubes">'+(lu.length?cubes(lu):'<span class="ng-lu-none">none</span>')+'</div></div>';
    });
    if(bwu.length){
      h+='<div class="ng-lu-ugroup"><div class="ng-lu-ghead"><span>'+(lv.length?'Building-wide':'Units')+' · '+bwu.length+' unit'+(bwu.length===1?'':'s')+'</span></div>'
        +'<div class="ng-th-cubes">'+cubes(bwu)+'</div></div>';
    }
    if(scopesDrive){
      var sdPct=Math.round(E.getT1WeightedPct(sel)*10)/10;
      h+='<div class="ng-lu-barrow"><div class="ng-lu-bar"><i style="width:'+sdPct+'%"></i></div><span class="ng-lu-barlbl">'+sdPct+'% · driven by scopes</span></div>';
    } else {
      h+='<div class="ng-lu-barrow"><div class="ng-lu-bar"><i style="width:'+bldPct+'%;'+(col(bldPct)?('background:'+col(bldPct)+';'):'')+'"></i></div>'
        +'<span class="ng-lu-barlbl"'+(col(bldPct)?(' style="color:'+col(bldPct)+';"'):'')+'>'+bldPct+'% complete</span></div>';
    }
  }
  h+='<div class="ng-lu-legend">'+(scopesDrive
    ? '<span class="ng-lu-hint">Completion is tracked per scope — set % on each scope.</span>'
    : '<span class="ng-lu-hint"><i class="ng-th-mini"><i style="height:100%;background:#1e9e75;"></i></i>tap a unit or level to set its %</span>')+'</div>';
  el.innerHTML=h;
}

// S4: "+ Add Cost" on a selected building — a small cost-type picker that creates the
// node near the building and wires it into the building's Costs input. Reuses the
// module-level data picker so a Sub/PO/Phase can be chosen from the directory.
function addCostToBuilding(bId, clientX, clientY){
  var b=E.findNode(bId); if(!b) return;
  var existing=document.querySelector('.ng-add-menu.ng-addcost'); if(existing) existing.remove();
  var menu=document.createElement('div'); menu.className='ng-add-menu ng-addcost';
  var h='<div class="ng-add-cat">Add to '+(b.label||'building')+'</div>';
  ['t2','sub','po','co','mat','labor','gc','burden','other'].forEach(function(t){ var d=E.DEFS[t]; if(d) h+='<div class="ng-add-item" data-type="'+t+'"><span class="ng-add-ic">'+d.icon+'</span>'+(d.label||t)+'</div>'; });
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
    spawnChildNode(bId, type);   // RS-A: unified spawn-and-wire (also drills into the owning building)
  });
}

// ── Hybrid inline node-spawning (RS-A) ─────────────────────────────────────
// "Spawn from the node's own surface": the right-Inspector carries a header row of
// quick-add chips for whatever child types the SELECTED node accepts, and each chip
// spawns + wires the child straight in — no floating node library needed. This
// generalizes addCostToBuilding to ANY parent node.
// What each parent type may spawn. 'cost' is a group → the concrete cost buckets.
var SPAWN_CHILDREN={
  t1:['t2','sub','po','cost','co'],   // Building
  t2:['sub','po','cost','co'],        // Scope / Phase
  sub:['po','cost'],
  po:['inv'],
  co:['cost']
};
var COST_BUCKETS=['mat','labor','gc','burden','other'];
var SPAWN_LABEL={ t2:'Scope', sub:'Sub', po:'PO', co:'CO', inv:'Invoice', mat:'Materials', labor:'Labor', gc:'Gen Cond', burden:'Burden', other:'Other' };
// Heroicon (window.p86Icon) concept per node type — always heroicons here, never emoji.
var SPAWN_ICON={ t1:'buildings', t2:'wip', sub:'subs', po:'estimates', cost:'banknotes', co:'edit', inv:'banknotes', mat:'materials', labor:'wrench', gc:'briefcase', burden:'scale', other:'banknotes' };
function ngIco(name){ return (typeof window.p86Icon==='function' && name) ? window.p86Icon(name) : ''; }
function ngTypeIco(type){ var d=E.DEFS[type]||{}; var cat=(d.cat==='cost')?'cost':type; return ngIco(SPAWN_ICON[type]||SPAWN_ICON[cat]||'cube'); }

// Follow out-wires (child.Total → parent.Costs) up to the owning Building (t1) so a
// freshly-spawned deep child can be revealed by drilling into its building.
function owningBuildingId(nodeId){
  var seen={}, stack=[nodeId];
  while(stack.length){
    var id=stack.pop(); if(seen[id]) continue; seen[id]=1;
    var n=E.findNode(id); if(!n) continue;
    if(n.type==='t1') return id;
    E.wires().forEach(function(w){ if(w.fromNode===id && !seen[w.toNode]) stack.push(w.toNode); });
  }
  return null;
}

// Spawn a child of childType under parentId, wire it in, drill into the owning
// building, and select it. Mirrors addCostToBuilding's wire+reveal, generalized to
// any parent (Building / Scope / Sub / PO / CO).
function spawnChildNode(parentId, childType){
  var p=E.findNode(parentId); if(!p) return;
  var bId=(p.type==='t1')?parentId:owningBuildingId(parentId);
  var center=(p.geoLatLng)?geoRenderPos(p):{x:p.x, y:p.y};
  var _sat=!!_spSatellite && E.viewMode && E.viewMode()==='siteplan';
  // Spawn just above the parent, staggered by how many children it already has so
  // repeated adds don't stack on one spot. The user can then drag them (position sticks).
  var _sibs=E.wires().filter(function(w){ return w.toNode===p.id; }).length;
  var px=Math.round(center.x + ((_sibs%4)-1.5)*(_sat?34:120));
  var py=Math.round(center.y - (_sat?46:200) - Math.floor(_sibs/4)*(_sat?30:70));
  function wireToParent(nn){
    if(!nn) return;
    var toPort=E.firstCompatPort(E.DEFS[p.type], nn.type, 'in');
    // Dedupe: autoWireFromData may already have wired this node to the same parent
    // (duplicate wires double-count costs and can clear buildingId links).
    var _ws=E.wires();
    var _dup=_ws.some(function(w){ return w.fromNode===nn.id && w.toNode===p.id; });
    if(!_dup) _ws.push({ fromNode:nn.id, fromPort:0, toNode:p.id, toPort:toPort||0 });
    // Fresh wires carry no allocPct — rebalance so the new link contributes now.
    try{
      if(nn.type==='t2' && E.rebalancePhaseAllocations) E.rebalancePhaseAllocations(nn.id);
      else if(nn.type==='co' && E.rebalanceCOAllocations) E.rebalanceCOAllocations(nn.id);
    }catch(e){}
    // Anchor the new node near its parent via a building-relative offset so the geo
    // re-fan keeps it where it spawned (not arced away) and it survives reload.
    if(bId && nn.type!=='t1'){
      var _b2=E.findNode(bId), _bc=_b2?((_b2.geoLatLng)?geoRenderPos(_b2):{x:_b2.x,y:_b2.y}):null;
      if(_bc) nn.spOff={x:nn.x-_bc.x, y:nn.y-_bc.y};
    }
    // Reveal the new node by drilling into its owning building (its subgraph is
    // hidden on the whole-site view). No building (free node) → skip the drill.
    if(bId){ delete _fannedSet[bId]; if(_spFocus!==bId){ _spFocus=bId; applySpFocus(); } fanFocusNodes(bId); }
    selN=nn.id; if(E.saveGraph) E.saveGraph(); render();
    if(E.viewMode && E.viewMode()==='siteplan') fitSiteplan();
  }
  if(PICKABLE_TYPES[childType] && E.job()){
    showDataPicker(childType, function(entry, focused){
      if(focused) return;
      if(entry){ var nn=E.addNode(childType, px, py, entryLabel(childType,entry), entry); if(nn){ autoWireFromData(nn, entry); wireToParent(nn); } }
      else { var _bn=bId?E.findNode(bId):null, _preBId=(_bn&&_bn.data&&_bn.data.id)||null; // preselect the owning building (appData id, NOT graph node id) so a scope spawned from a building attaches to it
        openEntityCreateModal(childType, function(ne){ if(ne){ var n2=E.addNode(childType, px, py, entryLabel(childType,ne), ne); if(n2){ autoWireFromData(n2, ne); wireToParent(n2); } } }, _preBId); }
    });
  } else {
    var d=E.DEFS[childType]||{}, label=d.label||childType;
    if(d.nameEdit){ label=prompt('Name for this '+(d.label||childType)+':', label)||label; }
    wireToParent(E.addNode(childType, px, py, label));
  }
}
window.p86NgSpawn=function(pid,type){ try{ spawnChildNode(pid,type); }catch(e){ if(window.console) console.warn('spawn failed',e); } };

// Prepend a single "+ Add" button to the selected node's inspector; it opens a dropdown of
// the spawnable child types (Scope / Sub / PO / Cost / CO) — heroicons, no emoji.
function injectSpawnRow(body, sel){
  if(!body || !sel) return;
  var kids=SPAWN_CHILDREN[sel.type]; if(!kids || !kids.length) return;
  body.insertAdjacentHTML('afterbegin',
    '<div class="ng-addbar"><button class="ng-addbtn" title="Add to '+luEsc(sel.label||sel.type)+'" onclick="event.stopPropagation();window.p86NgAddMenu&&window.p86NgAddMenu(\''+sel.id+'\',this)">'
    +'<span class="ng-addbtn-ic">'+ngIco('plus')+'</span><span>Add</span><span class="ng-addbtn-caret">▾</span></button></div>');
}
// The "+ Add" dropdown — one row per spawnable child type. 'Cost' opens the bucket submenu.
window.p86NgAddMenu=function(pid, anchor){
  var p=E.findNode(pid); if(!p) return;
  var kids=SPAWN_CHILDREN[p.type]||[]; if(!kids.length) return;
  var ex=document.querySelector('.ng-add-menu.ng-addmenu'); if(ex){ ex.remove(); return; }   // toggle off
  var menu=document.createElement('div'); menu.className='ng-add-menu ng-addmenu';
  var h='<div class="ng-add-cat">Add to '+luEsc(p.label||p.type)+'</div>';
  kids.forEach(function(k){
    var lbl=(k==='cost')?'Cost':(SPAWN_LABEL[k]||((E.DEFS[k]||{}).label)||k);
    var ic=(k==='cost')?ngIco('banknotes'):ngTypeIco(k);
    h+='<div class="ng-add-item" data-type="'+k+'"><span class="ng-add-ic">'+ic+'</span><span class="ng-add-lbl">'+luEsc(lbl)+'</span>'+(k==='cost'?'<span class="ng-add-sub">&#9656;</span>':'')+'</div>';
  });
  menu.innerHTML=h; document.body.appendChild(menu);
  var r=anchor.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(r.left, window.innerWidth-248))+'px';
  menu.style.top=Math.min(r.bottom+4, window.innerHeight-300)+'px';
  function close(){ if(menu){ menu.remove(); menu=null; document.removeEventListener('mousedown', outside, true); } }
  function outside(ev){ if(menu && !menu.contains(ev.target)) close(); }
  setTimeout(function(){ document.addEventListener('mousedown', outside, true); }, 0);
  menu.addEventListener('click',function(ev){ var it=ev.target.closest('.ng-add-item'); if(!it) return; var t=it.getAttribute('data-type');
    close();
    if(t==='cost'){ window.p86NgCostMenu && window.p86NgCostMenu(pid, anchor); return; }
    spawnChildNode(pid, t);
  });
};

// The 'Cost ▾' chip → a small bucket popover (reuses .ng-add-menu chrome).
window.p86NgCostMenu=function(pid, anchor){
  var ex=document.querySelector('.ng-add-menu.ng-costmenu'); if(ex) ex.remove();
  var menu=document.createElement('div'); menu.className='ng-add-menu ng-costmenu';
  var h='<div class="ng-add-cat">Add cost</div>';
  COST_BUCKETS.forEach(function(t){ var d=E.DEFS[t]; if(d) h+='<div class="ng-add-item" data-type="'+t+'"><span class="ng-add-ic">'+ngTypeIco(t)+'</span><span class="ng-add-lbl">'+(d.label||t)+'</span></div>'; });
  menu.innerHTML=h; document.body.appendChild(menu);
  var r=anchor.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(r.left, window.innerWidth-248))+'px';
  menu.style.top=Math.min(r.bottom+4, window.innerHeight-260)+'px';
  function close(){ if(menu){ menu.remove(); menu=null; document.removeEventListener('mousedown', outside, true); } }
  function outside(ev){ if(menu && !menu.contains(ev.target)) close(); }
  setTimeout(function(){ document.addEventListener('mousedown', outside, true); }, 0);
  menu.addEventListener('click',function(ev){ var it=ev.target.closest('.ng-add-item'); if(!it) return; var t=it.getAttribute('data-type'); close(); spawnChildNode(pid, t); });
};

// ── RS-B: per-type grouped child lists in the inspector ────────────────────
// Complements the header quick-add chips: shows what's already attached to the
// selected node, grouped by type, each group with its own inline "+" that spawns
// into that bucket. Rows select + reveal the child on the canvas.
function childGroupsHtml(sel){
  var kids=SPAWN_CHILDREN[sel.type]; if(!kids || !kids.length) return '';
  var wired={};
  E.wires().forEach(function(w){ if(w.toNode!==sel.id) return; var k=E.findNode(w.fromNode); if(!k) return;
    var key=((E.DEFS[k.type]||{}).cat==='cost')?'cost':k.type;
    (wired[key]=wired[key]||[]).push(k);
  });
  // Scopes allocated to THIS building via the phase matrix (appData.phases keyed
  // by buildingId) have no t2 node/wire, so the wire-only list above misses them
  // (this is the "SCOPES · 0 but the matrix shows phases" bug). Surface them next
  // to wired scopes — DISPLAY only, deduped by phase-record id. The building's
  // revenue/budget rollup (buildingEffectiveBudget) already sums this exact union,
  // so showing the list double-counts nothing. Join: the t1 node's linked appData
  // building id (sel.data.id) === phase.buildingId.
  var mxScopes=[];
  if(sel.type==='t1' && sel.data && sel.data.id && window.appData && Array.isArray(window.appData.phases)){
    var _bId=sel.data.id, _jid=(window.appState&&window.appState.currentJobId)||null;
    var _wiredPh={}; (wired['t2']||[]).forEach(function(k){ if(k&&k.data&&k.data.id) _wiredPh[k.data.id]=1; });
    mxScopes=window.appData.phases.filter(function(p){ return p && p.jobId===_jid && p.buildingId===_bId && !_wiredPh[p.id]; });
  }
  var groups=kids.map(function(t){
    var list=wired[t]||[];
    var label=(t==='cost')?'Costs':((SPAWN_LABEL[t]||t)+'s');
    var add=(t==='cost')
      ? "window.p86NgCostMenu&&window.p86NgCostMenu('"+sel.id+"',this)"
      : "window.p86NgSpawn&&window.p86NgSpawn('"+sel.id+"','"+t+"')";
    var rows;
    if(t==='t2' && sel.type==='t1' && (list.length || mxScopes.length)){
      // Scope rows on a BUILDING inspector carry inline completion controls: a
      // Units ⇄ % toggle + (units mode) a check-off cube strip against THIS
      // building's unit count — so you set units on the building AND check them
      // off per scope without leaving the map. Reuses the shared scope handlers
      // (data-scope-mode-* / data-scope-cube-* resolve the scope→building wire).
      var bUnits=(sel.units&&sel.units.length)?sel.units.length:0;
      rows=list.map(function(k){
        var w=E.wires().find(function(x){ return x.fromNode===k.id && x.toNode===sel.id; });
        var phList=Array.isArray(k.phases)?k.phases:[];
        var hasPh=phList.length>0;
        var isUnits=!hasPh && !!(w && w.trackMode==='units' && bUnits>0);
        var uDone=w?Math.max(0,Math.min(w.unitsDone||0,bUnits)):0;
        var wpc=hasPh ? (E.scopePctFromPhases(k)||0) : (w?(w.pctComplete||0):0);
        var wpcColor=wpc>=100?'#34d399':wpc>=50?'#fbbf24':'#4f8cff';
        var sel1="event.stopPropagation();window.p86NgSelect&&window.p86NgSelect('"+k.id+"')";
        var open=!!ngOpenScopes[k.id];
        var r='<div class="ng-cg-row ng-cg-scope">'
          +'<span class="ng-cg-cvt" data-ph-act="ph-toggle" data-scope="'+k.id+'" title="'+(hasPh?(phList.length+' phase'+(phList.length===1?'':'s')+' — expand'):'Break into phases')+'" style="cursor:pointer;flex:0 0 auto;width:14px;text-align:center;color:'+(hasPh?'#a78bfa':'#6b6f82')+';font-size:10px;">'+(open?'▾':'▸')+'</span>'
          +'<span class="ng-cg-ic" onclick="'+sel1+'">'+ngTypeIco(k.type)+'</span>'
          +'<span class="ng-cg-nm" onclick="'+sel1+'" title="Open on canvas">'+luEsc(k.label||k.type)+'</span>';
        if(hasPh){
          r+='<span title="Rolled up from '+phList.length+' weighted phase'+(phList.length===1?'':'s')+'" style="flex:0 0 auto;color:'+wpcColor+';font-family:\'Courier New\',monospace;font-size:11px;min-width:34px;text-align:right;">'+Math.round(wpc)+'%</span>';
        } else {
          if(bUnits>0){
            r+='<span class="ng-scope-mode" data-scope-mode-phase="'+k.id+'" data-scope-mode-bldg="'+sel.id+'" title="'+(isUnits?'Tracking by units — switch to percent':'Switch to unit check-off')+'" style="cursor:pointer;flex:0 0 auto;color:'+(isUnits?'#34d399':'#8b90a5')+';font-size:12px;width:16px;text-align:center;">'+(isUnits?'▦':'%')+'</span>';
          }
          if(isUnits){
            r+='<span title="Driven by the units checked off" style="flex:0 0 auto;color:'+wpcColor+';font-family:\'Courier New\',monospace;font-size:11px;min-width:34px;text-align:right;">'+Math.round(wpc)+'%</span>';
          } else if(w){
            r+='<span class="ng-wire-pct" data-wire-pct-phase="'+k.id+'" data-wire-pct-bldg="'+sel.id+'" title="Click to edit % complete" style="cursor:pointer;flex:0 0 auto;color:'+wpcColor+';font-family:\'Courier New\',monospace;font-size:11px;min-width:34px;text-align:right;">'+Math.round(wpc)+'%</span>';
          }
        }
        r+='</div>';
        if(isUnits){
          r+='<div class="ng-scope-cubes" style="display:flex;flex-wrap:wrap;align-items:center;gap:3px;padding:2px 0 6px 26px;">';
          for(var _c=0;_c<bUnits;_c++){
            r+='<i class="ng-lu-cube ng-scope-cube'+(_c<uDone?' done':'')+'" data-scope-cube-phase="'+k.id+'" data-scope-cube-bldg="'+sel.id+'" data-scope-cube-idx="'+_c+'" title="'+(_c<uDone?('Unit '+(_c+1)+' done — tap to set '+(_c+1)):('Tap to mark '+(_c+1)+' unit'+(_c===0?'':'s')+' complete'))+'"></i>';
          }
          r+='<span style="margin-left:5px;color:#8b90a5;font-family:\'Courier New\',monospace;font-size:9px;">'+uDone+' / '+bUnits+'</span>';
          r+='</div>';
        }
        if(open) r+=scopePhasesHtml(k);
        return r;
      }).join('');
      // Matrix-allocated scopes (no node/wire) appended as read-only rows; tap
      // opens the existing phase editor. No inline unit/% controls — there is no
      // wire to mutate, and these are display-only here.
      rows+=mxScopes.map(function(p){
        var _rev=(p.asSoldRevenue||p.asSoldPhaseBudget||p.phaseBudget||0);
        var _pc=Math.max(0,Math.min(100,Math.round(p.pctComplete||0)));
        var _pcc=_pc>=100?'#34d399':_pc>=50?'#fbbf24':'#4f8cff';
        var _eid=luEsc(p.id);
        var _edit="event.stopPropagation();window.editPhase&&window.editPhase('"+_eid+"')";
        return '<div class="ng-cg-row ng-cg-scope ng-cg-matrix" title="Allocated via the phase matrix">'
          +'<span class="ng-cg-cvt" style="flex:0 0 auto;width:14px;"></span>'
          +'<span class="ng-cg-ic" onclick="'+_edit+'">'+ngTypeIco('t2')+'</span>'
          +'<span class="ng-cg-nm" onclick="'+_edit+'" title="Edit scope">'+luEsc(p.phase||'Scope')+'</span>'
          +'<span class="ng-cg-mx-badge">matrix</span>'
          +(_rev?'<span style="flex:0 0 auto;color:#8b90a5;font-family:\'Courier New\',monospace;font-size:10px;">$'+Math.round(_rev).toLocaleString()+'</span>':'')
          +'<span class="ng-mx-pct" onclick="event.stopPropagation();window.p86NgScopePct&&window.p86NgScopePct(\''+_eid+'\',this)" title="Tap to set % complete" style="cursor:pointer;flex:0 0 auto;color:'+_pcc+';font-family:\'Courier New\',monospace;font-size:11px;min-width:34px;text-align:right;">'+_pc+'%</span>'
          +'</div>';
      }).join('');
    } else {
      rows=list.length ? list.map(function(k){
        return '<div class="ng-cg-row" onclick="event.stopPropagation();window.p86NgSelect&&window.p86NgSelect(\''+k.id+'\')" title="Open on canvas">'
          +'<span class="ng-cg-ic">'+ngTypeIco(k.type)+'</span><span class="ng-cg-nm">'+luEsc(k.label||k.type)+'</span></div>';
      }).join('') : '<div class="ng-cg-empty">None yet</div>';
    }
    return '<div class="ng-cg-group"><div class="ng-cg-head"><span class="ng-cg-lbl">'+label+' · '+(list.length+(t==='t2'?mxScopes.length:0))+'</span>'
      +'<button class="ng-cg-add" aria-label="Add '+label+'" onclick="event.stopPropagation();'+add+'">+</button></div>'+rows+'</div>';
  }).join('');
  return '<div class="ng-cg">'+groups+'</div>';
}
// Select + reveal a node from an inspector list row (drills into its owning building).
window.p86NgSelect=function(id){
  var n=E.findNode(id); if(!n) return;
  selN=id;
  var b=owningBuildingId(id)||(n.type==='t1'?id:null);
  if(b){ if(_spFocus!==b){ _spFocus=b; applySpFocus(); } fanFocusNodes(b); }
  render(); renderInspector();
  if(E.viewMode && E.viewMode()==='siteplan') fitSiteplan();
};

// ── Events ──
// ── Inline-edit handlers (Slice 3a) ────────────────────────────────────────
// Shared by the on-card canvas delegate AND the right-Inspector delegate. Each
// resolves its target node/wire from the CLICKED element's data-* attributes and
// writes the edit input INTO that element, so it works whether the element is on
// a card or in the inspector. The closing render() persists (engine render calls
// saveGraph) and re-renders both surfaces; each sets editingId so an interim
// render won't clobber the focused input (guarded in renderNodes + renderInspector).
function progChipEdit(pe){
  var pn=E.findNode(pe.getAttribute('data-prog-edit'));
  if(!pn) return;
  // Find the % span relative to the CLICKED element so this works from the inspector
  // too: on a card pe is the wrap/label (descendant span); in the inspector pe IS the span.
  var pctSpan=(pe.classList && pe.classList.contains('ng-pct-val')) ? pe
            : (pe.querySelector && pe.querySelector('.ng-pct-val'))
            || (function(){ var ne=canvasEl.querySelector('[data-id="'+pn.id+'"]'); return ne?ne.querySelector('.ng-pct-val'):null; })();
  if(!pctSpan) return;
  editingId=pn.id; // set BEFORE any DOM manipulation that could trigger render
  var inp=document.createElement('input');
  inp.type='number'; inp.min=0; inp.max=100; inp.step=1;
  inp.value=Math.round(pn.pctComplete||0);
  inp.dataset.progInput='1';
  inp.style.cssText='width:54px;font-family:\'Courier New\',monospace;font-weight:700;background:var(--ng-input);border:1px solid #4f8cff;color:#fbbf24;border-radius:3px;padding:1px 4px;outline:none;text-align:right;font-size:11px';
  pctSpan.textContent=''; pctSpan.appendChild(inp);
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
  inp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
}
function phaseRevEdit(prc){
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
}
function allocPctEdit(apc){
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
}
function allocLockToggle(lockEl){
  var lCoId=lockEl.getAttribute('data-lock-co');
  var lWireId=lockEl.getAttribute('data-lock-wire');
  var lWire=E.wires().find(function(w){ return w.fromNode===lCoId && w.toNode===lWireId; });
  if(!lWire) return;
  lWire._auto=!lWire._auto;
  var lSrc=E.findNode(lCoId);
  if(lSrc && lSrc.type==='co') E.rebalanceCOAllocations(lCoId);
  else E.rebalancePhaseAllocations(lCoId);
  render();
}
function allocShareEdit(shareEl){
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
}

// ── Job contract → per-building allocation ──────────────────────────────────
// The job's contract is ONE job-level number (the WIP node's contractAmount).
// A building's share of it lives on the building node as contractPct (%), which
// the engine turns into that building's contract revenue (replacing its scope
// sum) — see getBuildingAllocatedRevenue. These mirror allocPctEdit/allocShareEdit
// but resolve a NODE instead of a wire (there is no job→building contract wire).
function ngJobContract(){
  var w=(E.nodes()||[]).find(function(n){ return n.type==='wip'; });
  return (w && w.jobFields && Number(w.jobFields.contractAmount)) || 0;
}
function ngBuildings(){ return (E.nodes()||[]).filter(function(n){ return n.type==='t1'; }); }
function contractPctEdit(el){
  var bId=el.getAttribute('data-contract-bldg');
  var b=E.findNode(bId); if(!b || b.type!=='t1') return;
  editingId=bId;
  var inp=document.createElement('input');
  inp.type='number'; inp.step='0.1'; inp.min=0; inp.max=100;
  inp.value=Number(b.contractPct||0).toFixed(1);
  inp.className='ng-wip-chip-input';
  el.textContent=''; el.appendChild(inp);
  setTimeout(function(){ inp.focus(); inp.select(); }, 0);
  var done=false;
  function finish(){
    if(done) return; done=true;
    b.contractPct=Math.max(0,Math.min(100,parseFloat(inp.value)||0));
    editingId=null;
    if(E.saveGraph) E.saveGraph();
    render();
  }
  inp.addEventListener('blur',finish);
  inp.addEventListener('keydown',function(ev){
    if(ev.key==='Enter'){ev.preventDefault();inp.blur();}
    else if(ev.key==='Escape'){ev.preventDefault();done=true;editingId=null;render();}
  });
  inp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
}
function contractShareEdit(el){
  var bId=el.getAttribute('data-contract-bldg');
  var jc=parseFloat(el.getAttribute('data-contract-total'))||0;
  var b=E.findNode(bId); if(!b || b.type!=='t1' || jc<=0) return;   // no contract → nothing to share
  editingId=bId;
  var inp=document.createElement('input');
  inp.type='number'; inp.step='0.01'; inp.min=0;
  inp.value=((Number(b.contractPct||0))/100*jc).toFixed(2);
  inp.className='ng-wip-chip-input';
  el.textContent=''; el.appendChild(inp);
  setTimeout(function(){ inp.focus(); inp.select(); }, 0);
  var done=false;
  function finish(){
    if(done) return; done=true;
    var dollarVal=Math.max(0,parseFloat(inp.value)||0);
    b.contractPct=Math.min(100,(dollarVal/jc)*100);   // $ → % against the job contract
    editingId=null;
    if(E.saveGraph) E.saveGraph();
    render();
  }
  inp.addEventListener('blur',finish);
  inp.addEventListener('keydown',function(ev){
    if(ev.key==='Enter'){ev.preventDefault();inp.blur();}
    else if(ev.key==='Escape'){ev.preventDefault();done=true;editingId=null;render();}
  });
  inp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
}
// Put a building INTO allocation mode (0% to start), then open its % editor.
function contractStart(el){
  var b=E.findNode(el.getAttribute('data-contract-bldg'));
  if(!b || b.type!=='t1') return;
  if(b.contractPct==null) b.contractPct=0;
  if(E.saveGraph) E.saveGraph();
  render();
}
// Seed / rebalance the whole set. 'even' = 100/n · 'units' = by unit count
// (falls back to even when no units) · 'rebalance' = scale to sum 100 ·
// 'clear' = back to legacy scope-driven revenue.
function contractSeed(mode, opts){
  var bs=ngBuildings(); if(!bs.length) return;
  var onlyBlank=!!(opts && opts.onlyBlank);
  var targets=onlyBlank ? bs.filter(function(b){ return b.contractPct==null; }) : bs;
  if(mode==='clear'){ bs.forEach(function(b){ b.contractPct=null; }); }
  else if(mode==='rebalance'){
    var cur=bs.filter(function(b){ return b.contractPct!=null; });
    var sum=cur.reduce(function(a,b){ return a+(Number(b.contractPct)||0); },0);
    if(sum>0) cur.forEach(function(b){ b.contractPct=(Number(b.contractPct)||0)*100/sum; });
  } else if(mode==='units'){
    var tot=bs.reduce(function(a,b){ return a+((b.units&&b.units.length)||0); },0);
    if(tot>0) targets.forEach(function(b){ b.contractPct=((b.units&&b.units.length)||0)/tot*100; });
    else targets.forEach(function(b){ b.contractPct=100/bs.length; });   // no units → even
  } else { // 'even'
    targets.forEach(function(b){ b.contractPct=100/bs.length; });
  }
  if(E.saveGraph) E.saveGraph();
  render();
}

// ── Contract allocation MATRIX — scopes × buildings ─────────────────────────
// This is the shape the AIA G703 bills from. deriveSOV (js/pay-applications.js)
// emits ONE schedule-of-values line per scope×building that carries revenue, so
// "Building 5 - Exterior Painting" and "Building 5 - Vinyl siding replacement"
// come out as separate scheduled-value rows — the Waterside G703 format. A cell
// is that scope's allocation % to that building (the existing t2→t1 wire
// allocPct); the row total is the scope's revenue. A building's revenue is the
// sum of its cells, so the Site Plan and the AIA read from ONE source of truth.
function ensureScopeWire(scopeId, bldgId){
  var w=E.wires().find(function(x){ return x.fromNode===scopeId && x.toNode===bldgId; });
  if(w) return w;
  w={ fromNode:scopeId, fromPort:0, toNode:bldgId, toPort:0, allocPct:0 };
  E.wires().push(w);
  return w;
}
// Cell edit = make sure the scope→building wire exists, then reuse the existing
// wire %-editor verbatim.
function matrixCellEdit(el){
  ensureScopeWire(el.getAttribute('data-alloc-phase'), el.getAttribute('data-alloc-bldg'));
  allocPctEdit(el);
}
function matrixEvenSplit(){
  var blds=ngBuildings(); if(!blds.length) return;
  (E.nodes()||[]).filter(function(n){ return n.type==='t2'; }).forEach(function(s){
    blds.forEach(function(b){ ensureScopeWire(s.id,b.id).allocPct=100/blds.length; });
  });
  if(E.saveGraph) E.saveGraph();
  render();
}
function contractMatrixHtml(){
  var jc=ngJobContract(), blds=ngBuildings();
  var scopes=(E.nodes()||[]).filter(function(n){ return n.type==='t2'; });
  if(!blds.length) return '<div style="padding:8px 0;font-size:11px;color:#8b90a5;">Add buildings on the Site Plan to allocate the contract.</div>';
  var h='<div style="font-size:10.5px;color:#8b90a5;margin-bottom:6px;line-height:1.45;">Split the contract into scopes, then allocate each scope across the buildings. Every cell becomes one AIA schedule-of-values line (“Building 5 - Exterior Painting”).</div>';
  h+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px;"><span style="flex:1;color:#8b90a5;">Job contract</span>'
    +'<span style="font-family:\'Courier New\',monospace;color:#34d399;font-weight:700;">'+E.fmtC(jc)+'</span></div>';
  if(!scopes.length) h+='<div style="padding:6px 0;font-size:11px;color:#fbbf24;">No scopes yet — add one (Exterior Painting, Vinyl siding…) with “+ Add” on the Site Plan, then set its revenue here.</div>';
  h+='<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:11px;">'
    +'<thead><tr style="color:#8b90a5;font-size:9px;text-transform:uppercase;letter-spacing:.5px;">'
    +'<th style="text-align:left;padding:3px 4px;">Scope</th><th style="text-align:right;padding:3px 4px;">Revenue</th>';
  blds.forEach(function(b){ h+='<th style="text-align:right;padding:3px 4px;">'+luEsc(String(b.label||'Bldg').split(' › ')[0])+'</th>'; });
  h+='<th style="text-align:right;padding:3px 4px;">Σ</th></tr></thead><tbody>';
  var colTot={}; blds.forEach(function(b){ colTot[b.id]=0; });
  var revTot=0;
  scopes.forEach(function(s){
    var sRev=Number(s.revenue||0); revTot+=sRev;
    h+='<tr style="border-top:1px solid var(--ng-border2);">'
      +'<td style="padding:3px 4px;color:var(--ng-text,#c8cbe0);">'+luEsc(String(s.label||'Scope').split(' › ')[0])+'</td>'
      +'<td style="padding:3px 4px;text-align:right;"><span class="ng-phase-rev" data-phase-rev="'+luEsc(s.id)+'" title="Click to edit this scope’s revenue" style="cursor:pointer;font-family:\'Courier New\',monospace;color:#34d399;">'+E.fmtC(sRev)+'</span></td>';
    var rowPct=0;
    blds.forEach(function(b){
      var w=E.wires().find(function(x){ return x.fromNode===s.id && x.toNode===b.id; });
      var pct=(w && w.allocPct!=null)?Number(w.allocPct):0; rowPct+=pct;
      var cell=sRev*pct/100; colTot[b.id]+=cell;
      h+='<td style="padding:3px 4px;text-align:right;">'
        +'<span class="ng-mx-cell" data-alloc-phase="'+luEsc(s.id)+'" data-alloc-bldg="'+luEsc(b.id)+'" title="Click to set this scope’s % to this building" style="cursor:pointer;font-family:\'Courier New\',monospace;color:#fbbf24;">'+pct.toFixed(1)+'%</span>'
        +'<div style="font-size:9px;color:#6b6f82;font-family:\'Courier New\',monospace;">'+E.fmtC(cell)+'</div></td>';
    });
    var rOk=Math.abs(rowPct-100)<0.01;
    h+='<td style="padding:3px 4px;text-align:right;font-family:\'Courier New\',monospace;color:'+(rOk?'#34d399':'#f87171')+';">'+rowPct.toFixed(0)+'%'+(rOk?' ✓':' ⚠')+'</td></tr>';
  });
  var tOk=Math.abs(revTot-jc)<0.01;
  h+='<tr style="border-top:2px solid var(--ng-border2);font-weight:700;color:#c8cbe0;">'
    +'<td style="padding:4px;">Total</td>'
    +'<td style="padding:4px;text-align:right;font-family:\'Courier New\',monospace;color:'+(tOk?'#34d399':'#f87171')+';">'+E.fmtC(revTot)+(tOk?' ✓':' ⚠')+'</td>';
  blds.forEach(function(b){ h+='<td style="padding:4px;text-align:right;font-family:\'Courier New\',monospace;color:#4f8cff;">'+E.fmtC(colTot[b.id])+'</td>'; });
  h+='<td></td></tr></tbody></table></div>';
  if(!tOk) h+='<div style="font-size:10px;color:#f87171;padding:3px 0;">Scope revenue '+E.fmtC(revTot)+' doesn’t match the job contract '+E.fmtC(jc)+'.</div>';
  var fixed=blds.filter(function(b){ return b.contractPct!=null; });
  if(fixed.length) h+='<div style="font-size:10px;color:#fbbf24;padding:3px 0;">'+fixed.length+' building(s) are on a fixed % share, which overrides this matrix — the AIA and the Site Plan would disagree. <span data-contract-seed="clear" style="cursor:pointer;text-decoration:underline;">Clear fixed shares</span></div>';
  h+='<div style="display:flex;gap:6px;justify-content:flex-end;padding-top:6px;"><button class="ee-btn ghost" style="font-size:11px;" data-mx-act="even">Even split</button></div>';
  return h;
}
function refreshInspContractAlloc(){
  var host=document.getElementById('ng-insp-contract-alloc');
  if(host) host.innerHTML=contractMatrixHtml();
}
function wirePctEdit(wpc){
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
}

// Toggle a scope→building wire between UNITS check-off and PERCENT tracking.
// Switching to units seeds unitsDone from the current % so no progress is lost.
function scopeModeToggle(el){
  var ph=el.getAttribute('data-scope-mode-phase'), bd=el.getAttribute('data-scope-mode-bldg');
  var w=E.wires().find(function(x){ return x.fromNode===ph && x.toNode===bd; });
  if(!w) return;
  if(w.trackMode==='units'){
    w.trackMode='pct';
  } else {
    var b=E.findNode(bd); var cnt=(b&&b.units&&b.units.length)?b.units.length:0;
    if(cnt<=0) return; // no units to track against
    w.trackMode='units';
    if(w.unitsDone==null) w.unitsDone=Math.round((w.pctComplete||0)/100*cnt);
  }
  if(E.saveGraph) E.saveGraph(); render(); if(typeof renderInspector==='function') renderInspector();
}

// Click cube #idx on a unit-mode scope wire → set unitsDone. Clicking the
// last-filled cube clears it (decrement); any other sets the count to idx+1.
function scopeUnitCubeSet(el){
  var ph=el.getAttribute('data-scope-cube-phase'), bd=el.getAttribute('data-scope-cube-bldg');
  var idx=parseInt(el.getAttribute('data-scope-cube-idx'),10);
  var w=E.wires().find(function(x){ return x.fromNode===ph && x.toNode===bd; });
  if(!w || isNaN(idx)) return;
  var b=E.findNode(bd); var cnt=(b&&b.units&&b.units.length)?b.units.length:0;
  var cur=Math.max(0,Math.min(w.unitsDone||0,cnt));
  w.unitsDone=(idx===cur-1)?idx:Math.min(idx+1,cnt);
  if(E.saveGraph) E.saveGraph(); render(); if(typeof renderInspector==='function') renderInspector();
}

var ngOpenAddMenuFn=null;   // set inside initEvents (where openAddMenu is defined); used by the ribbon "+ Add" button wired in init()
function initEvents(){
  var SN=E.SNAP, z=function(){return E.zm();};

  // Right-hand Inspector: its WIP chips + levels/units controls + per-node-type
  // editors (Slice 3a) all reuse the existing edit/persist paths — the same shared
  // inline-edit handlers the on-card canvas delegate uses, resolving their target
  // from the element's data-* attributes (so they work off-card here).
  var insp=document.querySelector('.ng-inspector');
  if(insp) insp.addEventListener('click', function(e){
    // Slice 3c — Tasks/Files collapsible headers (lazy-mount the heavy panel on first open).
    var ict=e.target.closest('[data-coll-toggle]');
    if(ict){ e.preventDefault(); e.stopPropagation(); inspToggleCollapse(ict.getAttribute('data-coll-toggle'), ict); return; }
    // Command Center self-summarizing sections — toggle open/closed (no lazy-mount).
    var iac=e.target.closest('[data-acc-toggle]');
    if(iac){ e.preventDefault(); e.stopPropagation(); var acc=iac.closest('.ng-insp-acc'); if(acc) acc.classList.toggle('ng-open'); return; }
    var jchip=e.target.closest('[data-job-edit]');
    if(jchip && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); jobFieldEdit(jchip); return; }
    var luEl=e.target.closest('[data-lu-act]');
    if(luEl){ e.preventDefault(); e.stopPropagation(); var bn=selN&&E.findNode(selN); if(!bn||bn.type!=='t1') return;
      var _a=luEl.getAttribute('data-lu-act'), _i=luEl.getAttribute('data-id');
      if(_a==='unit-pop'){ openLuPctPop(bn,'unit',_i,luEl); return; }
      if(_a==='lvl-pop'){ openLuPctPop(bn,'level',_i,luEl); return; }
      if(_a==='lvl-seg'){ luSetPct(bn,'level',_i,(parseInt(luEl.getAttribute('data-seg'),10)||0)*20); if(E.saveGraph) E.saveGraph(); luRefresh(); return; }
      luApply(bn, _a, _i); if(E.saveGraph) E.saveGraph(); luRefresh(); return; }
    // Scope → nested phases (Demo/Putback…): mark off / weight / add from the
    // building card. updateT1Progress flushes the phase-derived % up to the
    // scope, building, and job before we re-render.
    var phEl=e.target.closest('[data-ph-act]');
    if(phEl){ e.preventDefault(); e.stopPropagation(); var scN=E.findNode(phEl.getAttribute('data-scope')); if(scN){ phApply(scN, phEl.getAttribute('data-ph-act'), phEl.getAttribute('data-ph')); updateT1Progress(); if(E.saveGraph) E.saveGraph(); } renderInspector(); return; }
    var ipe=e.target.closest('[data-prog-edit]');
    if(ipe && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); progChipEdit(ipe); return; }
    var iprc=e.target.closest('[data-phase-rev]');
    if(iprc && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); phaseRevEdit(iprc); return; }
    // Contract matrix cell — must precede the generic [data-alloc-phase] case
    // below, since a matrix cell carries the same attrs but may have no wire yet.
    var imx=e.target.closest('.ng-mx-cell');
    if(imx && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); matrixCellEdit(imx); return; }
    var imxa=e.target.closest('[data-mx-act]');
    if(imxa){ e.preventDefault(); e.stopPropagation(); matrixEvenSplit(); return; }
    var iapc=e.target.closest('[data-alloc-phase]');
    if(iapc && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); allocPctEdit(iapc); return; }
    var ismode=e.target.closest('[data-scope-mode-phase]');
    if(ismode){ e.preventDefault(); e.stopPropagation(); scopeModeToggle(ismode); return; }
    var iscube=e.target.closest('[data-scope-cube-phase]');
    if(iscube){ e.preventDefault(); e.stopPropagation(); scopeUnitCubeSet(iscube); return; }
    var iwpc=e.target.closest('[data-wire-pct-phase]');
    if(iwpc && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); wirePctEdit(iwpc); return; }
    var ishareEl=e.target.closest('.ng-alloc-share');
    if(ishareEl && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); allocShareEdit(ishareEl); return; }
    var ilockEl=e.target.closest('.ng-alloc-lock');
    if(ilockEl){ e.preventDefault(); e.stopPropagation(); allocLockToggle(ilockEl); return; }
    // Job contract → building allocation (node-scoped, not wire-scoped).
    var icpct=e.target.closest('.ng-contract-pct');
    if(icpct && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); contractPctEdit(icpct); return; }
    var icsh=e.target.closest('.ng-contract-share');
    if(icsh && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); contractShareEdit(icsh); return; }
    var icst=e.target.closest('.ng-contract-start');
    if(icst){ e.preventDefault(); e.stopPropagation(); contractStart(icst); return; }
    var icseed=e.target.closest('[data-contract-seed]');
    if(icseed){ e.preventDefault(); e.stopPropagation(); contractSeed(icseed.getAttribute('data-contract-seed')); return; }
    // Slice 3b — line-item add / delete (cost/invoice). render() rebuilds the table.
    var iadd=e.target.closest('.ng-add-sub');
    if(iadd){ e.preventDefault(); e.stopPropagation(); lineItemAdd(E.findNode(iadd.getAttribute('data-node'))); render(); return; }
    var idel=e.target.closest('.ng-subitem-del');
    if(idel){ e.preventDefault(); e.stopPropagation(); var dn=E.findNode(idel.getAttribute('data-node')); var di=parseInt(idel.getAttribute('data-idx')); if(dn&&dn.items&&!isNaN(di)){ dn.items.splice(di,1); if(E.saveGraph) E.saveGraph(); render(); } return; }
    // Slice 3c — PO/Sub actions (shared with the canvas handlers).
    var ipu=e.target.closest('.ng-po-unlink');
    if(ipu){ e.preventDefault(); e.stopPropagation(); poUnlinkPhase(ipu.getAttribute('data-from'), ipu.getAttribute('data-to')); render(); return; }
    var ipl=e.target.closest('.ng-po-link-add');
    if(ipl){ e.preventDefault(); e.stopPropagation(); poLinkAddOpen(ipl); return; }
    var isp=e.target.closest('.ng-sub-add-po');
    if(isp){ e.preventDefault(); e.stopPropagation(); subCreatePO(isp); return; }
  });
  // Slice 3b — line-item field inputs (ng-si-f) + the manual-total input persist LIVE
  // without a full render (so the caret survives), with a focus-preserving total refresh.
  if(insp) insp.addEventListener('input', function(e){
    var t=e.target;
    // Slice 3c — PO→phase allocation %: write the wire + refresh the inspector badge live.
    if(t.tagName==='INPUT' && t.classList && t.classList.contains('ng-po-alloc')){
      var aw=E.wires().find(function(w){ return w.fromNode===t.getAttribute('data-from') && w.toNode===t.getAttribute('data-to'); });
      if(aw){ var raw=parseFloat(t.value); if(!isFinite(raw)) raw=0; aw.allocPct=Math.max(0,Math.min(100,raw)); E.resetComp(); if(E.saveGraph) E.saveGraph();
        var ib=insp.querySelector('.ng-inspector-body'), pbadge=ib&&ib.querySelector('.ng-po-alloc-badge');
        if(pbadge){ var psum=0; ib.querySelectorAll('.ng-po-alloc').forEach(function(inp){ psum+=parseFloat(inp.value)||0; }); pbadge.textContent=psum.toFixed(0)+'%'; pbadge.classList.toggle('ng-warn', Math.abs(psum-100)>=0.5); }
      }
      return;
    }
    if(t.tagName!=='INPUT' || t.dataset.node==null) return;
    var n=E.findNode(t.dataset.node); if(!n) return;
    if(t.dataset.idx!=null && t.dataset.field){
      var idx=parseInt(t.dataset.idx), f=t.dataset.field;
      if(n.items && n.items[idx]){
        if(f==='amount'||f==='hours'||f==='rate'||f==='qty'||f==='unitCost') n.items[idx][f]=parseFloat(t.value)||0;
        else n.items[idx][f]=t.value;
      }
    } else { n.value=parseFloat(t.value)||0; }   // manual-total fallback input
    E.resetComp(); if(E.saveGraph) E.saveGraph();
    var body=insp.querySelector('.ng-inspector-body'); if(!body) return;
    var totalEl=body.querySelector('.ng-sub-total'); if(totalEl) totalEl.textContent=E.fmtC(E.getOutput(n,0));
    if(n.items){
      var d2=E.DEFS[n.type], iT=d2?d2.itemType:'', rowTotals=body.querySelectorAll('.ng-si-val');
      n.items.forEach(function(item,ri){ if(rowTotals[ri]){ var rv=0; if(iT==='labor') rv=(item.hours||0)*(item.rate||65); else if(iT==='other') rv=(item.qty||0)*(item.unitCost||0); rowTotals[ri].textContent=E.fmtC(rv); } });
    }
  });
  // Focus on a line-item / manual-total input stamps editingId so an external interim
  // render won't clobber the field mid-type; cleared on blur WITHOUT a render so tabbing
  // between cells keeps the live inputs (the input handler already persisted each keystroke).
  if(insp){
    insp.addEventListener('focusin', function(e){ var t=e.target; if(t.tagName==='INPUT' && !t.classList.contains('ng-wip-chip-input') && (t.dataset.node!=null||t.dataset.from!=null)) editingId=t.dataset.node||t.dataset.from; });
    insp.addEventListener('focusout', function(e){ var t=e.target; if(t.tagName==='INPUT' && !t.classList.contains('ng-wip-chip-input') && (t.dataset.node!=null||t.dataset.from!=null)) editingId=null; });
  }

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
      _drawWires();
    }
    if(dragN){
      var n=E.findNode(dragN); if(!n) return;
      _didDragNode=true;
      var p=E.pan();
      n.x=Math.round((e.clientX/z()-p.x-dragOff.x)/SN)*SN;
      n.y=Math.round((e.clientY/z()-p.y-dragOff.y)/SN)*SN;
      var el=canvasEl.querySelector('[data-id="'+n.id+'"]');
      if(el){el.style.left=n.x+'px';el.style.top=n.y+'px';}
      _drawWires();
    }
    if(wiringFrom){
      var r=wrap.getBoundingClientRect();
      wireMouse={x:e.clientX-r.left,y:e.clientY-r.top};
      _drawWires();
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
        _drawWires();
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
    if(E.viewMode && E.viewMode()==='siteplan'){ if(addFabEl) addFabEl.style.display='none'; addFabArm=null; return; } // Site Plan: no on-wire/port "+" FAB — add via the building +Add menu / Inspector
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
    addMenuEl.innerHTML='<input class="ng-add-search" placeholder="Add building or utility…" /><div class="ng-add-list"></div>';
    document.body.appendChild(addMenuEl);
    addMenuEl.style.left=Math.max(8,Math.min(clientX, window.innerWidth-248))+'px';
    addMenuEl.style.top=Math.max(8,Math.min(clientY, window.innerHeight-340))+'px';
    var listEl=addMenuEl.querySelector('.ng-add-list'), inp=addMenuEl.querySelector('.ng-add-search');
    function build(filter){
      var f=(filter||'').toLowerCase(), out='';
      // RS-C: the node "library" is retired — attachable nodes (scope/sub/PO/cost/CO)
      // now spawn inline from a node's inspector. This menu keeps only what doesn't
      // attach to a parent: the Building (map-placed) + the Math/Note/Watch utilities.
      var LIB_KEEP={t1:1,sum:1,sub2:1,mul:1,pct:1,note:1,watch:1};
      E.CATS.forEach(function(c){
        var items=c.items.filter(function(t){ if(!LIB_KEEP[t]) return false; var d=E.DEFS[t]; return d && ((d.label||t).toLowerCase().indexOf(f)>=0 || c.name.toLowerCase().indexOf(f)>=0); });
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
  ngOpenAddMenuFn=openAddMenu;   // expose to init()'s ribbon "+ Add" wiring (openAddMenu is otherwise out of that scope)

  wrap.addEventListener('mouseup',function(e){
    var _wasDrag=dragN, _moved=_didDragNode; _didDragNode=false;
    isPan=false; wrap.classList.remove('ng-panning'); dragN=null;
    if(_wasDrag && _moved){
      // A node was actually dragged (not just clicked) → persist it. On the Site Plan,
      // anchor a dragged child to its building via a stored offset so the per-render geo
      // re-fan re-applies it (instead of clobbering) and it survives reload.
      var _dn=E.findNode(_wasDrag);
      if(_dn){
        if(_dn.type!=='t1'){
          var _bId=owningBuildingId(_wasDrag), _b=_bId&&E.findNode(_bId);
          if(_b){ var _c=(_b.geoLatLng)?geoRenderPos(_b):{x:_b.x,y:_b.y}; _dn.spOff={x:_dn.x-_c.x, y:_dn.y-_c.y}; }
        }
        if(E.saveGraph) E.saveGraph();
      }
    }
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
    if(pe && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); progChipEdit(pe); return; }
    // Click WIP field chip → reveal editable input
    var wc=e.target.closest('[data-wip-edit]');
    if(wc && !e.target.closest('input')){
      e.preventDefault(); e.stopPropagation();
      wipChipEdit(wc);     // shared with the sidebar metrics panel
      return;
    }
    // Click phase revenue → edit
    var prc=e.target.closest('[data-phase-rev]');
    if(prc && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); phaseRevEdit(prc); return; }
    // Click allocation % → edit (marks wire as manual, rebalances auto wires)
    var apc=e.target.closest('[data-alloc-phase]');
    if(apc && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); allocPctEdit(apc); return; }
    // Click lock icon → toggle locked/unlocked
    var lockEl=e.target.closest('.ng-alloc-lock');
    if(lockEl){ e.stopPropagation(); allocLockToggle(lockEl); return; }
    // Click share $ → edit dollar amount, recalc % from it
    var shareEl=e.target.closest('.ng-alloc-share');
    if(shareEl && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); allocShareEdit(shareEl); return; }
    // Click per-wire % complete → edit
    var csmode=e.target.closest('[data-scope-mode-phase]');
    if(csmode){ e.preventDefault(); e.stopPropagation(); scopeModeToggle(csmode); return; }
    var cscube=e.target.closest('[data-scope-cube-phase]');
    if(cscube){ e.preventDefault(); e.stopPropagation(); scopeUnitCubeSet(cscube); return; }
    var wpc=e.target.closest('[data-wire-pct-phase]');
    if(wpc && !e.target.closest('input')){ e.preventDefault(); e.stopPropagation(); wirePctEdit(wpc); return; }
    // PO → phase: unlink one phase from a PO. Removes the wire and
    // re-renders so the Linked Phases section + the canvas update.
    var poUnlink = e.target.closest('.ng-po-unlink');
    if(poUnlink){ e.stopPropagation(); poUnlinkPhase(poUnlink.getAttribute('data-from'), poUnlink.getAttribute('data-to')); render(); return; }
    // PO → phase: open the "+ Link phase" picker. Shows phases on
    // this job that aren't already linked from this PO.
    var poLinkAdd = e.target.closest('.ng-po-link-add');
    if(poLinkAdd){ e.preventDefault(); e.stopPropagation(); poLinkAddOpen(poLinkAdd); return; }
    // Create PO scoped to a sub's target phase/CO/T1
    var subAddPO=e.target.closest('.ng-sub-add-po');
    if(subAddPO){ e.stopPropagation(); subCreatePO(subAddPO); return; }
    // Add sub-item (inline — just adds a blank row)
    var addSub=e.target.closest('.ng-add-sub');
    if(addSub){ e.stopPropagation(); lineItemAdd(E.findNode(addSub.getAttribute('data-node'))); render(); return; }
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
      renderInspector();   // populate the right Inspector with the clicked node (cost/scope/sub/PO/CO/invoice) — every type, same behavior
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
        _drawWires();
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

  // Heal legacy phase nodes whose revenue is stuck at 0 (entered via the old
  // budget-only Buildings×Phases matrix). This is the single compute chokepoint
  // (overview, jobs list, and Site Map all reach the roll-up through here), so
  // pulling revenue up from the phase record's fallback here — rather than only
  // in syncFromData (Sync button) — makes the % + revenue total on every surface
  // without the user re-touching cells. Records are source of truth; never
  // clobber a node that already carries a revenue value.
  nodes.forEach(function(n){
    if(n.type==='t2' && n.data && n.data.id && !(n.revenue>0)){
      var ph=appData.phases.find(function(p){return p.id===n.data.id;});
      if(ph){ var rr=ph.asSoldRevenue||ph.asSoldPhaseBudget||ph.phaseBudget||0; if(rr>0) n.revenue=rr; }
    }
  });

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
    // Fall back to a name match when the node's data.id is stale/missing.
    var _bnm=n.label.split(' › ')[0].trim();
    if(!bldg && _bnm) bldg=appData.buildings.find(function(b){return b.jobId===jid&&(b.name||'')===_bnm;});
    if(!bldg){
      // ORPHAN building node: its appData.buildings record was lost (graph/appData
      // divergence — the graph kept the node, the job data dropped the record), so
      // the building vanished from the Buildings list (renderJobBuildings reads
      // appData.buildings) even though it still carries wired scopes on the map.
      // Recreate the record from the node so it reappears. Reuse the node's own
      // data.id when present; the name-match above keeps this idempotent across
      // reloads (saveData persists the record, so the next run finds it by name).
      // Carry over the node's units/levels for the by-units/levels allocation split.
      bldg={ id:(n.data&&n.data.id)||('b'+Date.now()+Math.floor(Math.random()*1000)),
             jobId:jid, name:_bnm||'Building', address:'', budget:0, budgetPct:0,
             materials:0, labor:0, sub:0, equipment:0, hoursWeek:0, hoursTotal:0,
             rate:40, workScope:'in-house', locked:false, excludeFromSubDist:false,
             units:Array.isArray(n.units)?n.units.slice():[], levels:Array.isArray(n.levels)?n.levels.slice():[] };
      appData.buildings.push(bldg);
      if(!n.data||!n.data.id) n.data=bldg;   // re-link the node to the fresh record
    }
    // Sync name
    var bName=n.label.split(' \u203A ')[0].trim();
    if(bName) bldg.name=bName;
    // Budget from node
    if(n.budget) bldg.budget=n.budget;
    // % complete
    bldg.pctComplete=n.pctComplete||0;
    // Mirror the node's units/levels onto the record — they live on the graph
    // node, but jobs.js reads appData.buildings for the Buildings list AND the
    // phase-allocation split (phasePctShares weights by units/levels).
    bldg.units=Array.isArray(n.units)?n.units.slice():[];
    bldg.levels=Array.isArray(n.levels)?n.levels.slice():[];
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
      // Wired to a building/phase (counted there) OR straight to WIP (counted
      // in the WIP node's own actual-cost sum). Either way it is NOT a
      // standalone job-level node, so keep it OUT of the job-level bucket —
      // otherwise folding that bucket into ngActualCosts would double-count it.
      return target&&(target.type==='t1'||target.type==='t2'||target.type==='wip');
    });
    if(wiredToTier) return; // already counted at building/phase/WIP level
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
    // % complete drives revenue-earned. Use the budget-weighted value from the
    // phases/buildings; when there's NO progress signal, fall back to a MANUAL
    // override only — never a stale auto-synced value. Otherwise, once a job's
    // phases are removed (or were never seeded), an old pctComplete keeps
    // inflating revenue-earned / profit forever (the "New job stuck at 99%,
    // 100% margin, +$47k profit on $0 cost" bug). Push the effective % onto the
    // WIP node's jobFields BEFORE computing the ng* rollups so they use it.
    E.resetComp();
    var _wipPct=E.getWIPWeightedPct(wipNode);
    var _effPct=(_wipPct!=null) ? _wipPct : (job.pctCompleteManual ? (job.pctComplete||0) : 0);
    if(wipNode.jobFields) wipNode.jobFields.pctComplete=_effPct;
    E.resetComp();
    job.ngTotalIncome=E.getOutput(wipNode,0);
    E.resetComp();
    // Standalone job-level cost nodes (not wired to any building/phase/WIP) are
    // NOT summed by the WIP node itself, so add the disjoint job-level bucket
    // (jobMat/Lab/Equip/GC, computed above — manual entries only now) onto the
    // actual-cost track. QB import is folded in at the job level by getJobWIP
    // (stateless, so the jobs list + unopened jobs reflect it too), NOT here —
    // ngActualCosts stays the graph's MANUAL/wired cost so getJobWIP can add QB
    // on top exactly once.
    job.ngActualCosts=E.getOutput(wipNode,1) + jobMat + jobLab + jobEquip + jobGC;
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
    // Sync the effective % back — including 0 when there's no progress, so a
    // stale value can't survive the phases that produced it being removed.
    if(!job.pctCompleteManual){
      job.pctComplete=_effPct;
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
    // No-op when an identical link already exists — addCostToBuilding runs
    // both autoWireFromData and wireToBuilding, and duplicate wires
    // double-count costs + wipe phase.buildingId in updateTierLabels.
    var dup=wires.some(function(w){ return w.fromNode===fromId && w.toNode===toId; });
    if(dup) return;
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
  // New wires carry no allocPct (the engine computes null as 0%, so the link
  // would contribute nothing) — run the standard rebalance so fresh phase/CO
  // links immediately carry their share.
  try{
    if(n.type==='t2' && E.rebalancePhaseAllocations) E.rebalancePhaseAllocations(n.id);
    else if(n.type==='co' && E.rebalanceCOAllocations) E.rebalanceCOAllocations(n.id);
  }catch(e){}
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
    if(t2Map[ph.id]){
      // Heal legacy nodes: the old Buildings×Phases matrix wrote asSoldPhaseBudget
      // only (revenue stayed 0), and this sync is otherwise create-only — so an
      // existing phase node keeps a stale revenue=0 and drops out of the revenue-
      // weighted WIP % roll-up. If the node has no revenue but the record carries
      // a budget, pull it up (same truthy fallback as jobs.js phaseRevenue()).
      // Never clobber a node that already has a revenue value.
      var exist=t2Map[ph.id];
      if(exist && !(exist.revenue>0)){
        var recRev=ph.asSoldRevenue||ph.asSoldPhaseBudget||ph.phaseBudget||0;
        if(recRev>0) exist.revenue=recRev;
      }
      return;
    }
    var bl=appData.buildings.find(function(b){return b.id===ph.buildingId;});
    var pos=nextPos();
    var n=E.addNode('t2',pos.x,pos.y,ph.phase+(bl?' › '+bl.name:''),ph);
    if(n){
      n.budget=ph.phaseBudget||0; n.pctComplete=ph.pctComplete||0; n.revenue=ph.asSoldRevenue||ph.asSoldPhaseBudget||ph.phaseBudget||0;
      if(bl&&t1Map[bl.id]){
        wires.push({fromNode:n.id,fromPort:0,toNode:t1Map[bl.id].id,toPort:0});
        // Assign allocPct at creation — a null allocPct computes as 0%.
        try{ if(E.rebalancePhaseAllocations) E.rebalancePhaseAllocations(n.id); }catch(e){}
      }
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

  // "+ Add" ribbon button → searchable node-type menu (replaces the old left palette)
  var addNodeBtn=tab.querySelector('.ng-add-node-btn');
  if(addNodeBtn) addNodeBtn.addEventListener('click',function(e){
    e.stopPropagation();
    var r=addNodeBtn.getBoundingClientRect();
    if(ngOpenAddMenuFn) ngOpenAddMenuFn(r.left, r.bottom+4, pickNodeType);
  });

  // (Section-click routing is handled at the source in workspace-layout.js's activateTab via
  //  window.p86NgShowSection — a capture listener here was racy against the tab's own onclick.)

  // Drag-to-resize the right Inspector (drag its LEFT edge) — mirrors the app sidebar resizer.
  // Inspector is right-aligned, so dragging the handle left WIDENS it (invert dx). The map
  // canvas re-syncs to the new center width on release.
  (function(){
    var insp=tab.querySelector('.ng-inspector'), handle=insp&&insp.querySelector('.ng-inspector-resize');
    if(!insp||!handle) return;
    var MINW=260, MAXW=680, WKEY='p86-ng-insp-w';
    try{ var sv=parseInt(localStorage.getItem(WKEY),10); if(sv>=MINW&&sv<=MAXW) insp.style.setProperty('--ng-insp-w', sv+'px'); }catch(_){}
    var dragging=false, startX=0, startW=0;
    handle.addEventListener('mousedown', function(e){
      dragging=true; startX=e.clientX; startW=insp.getBoundingClientRect().width;
      insp.classList.add('resizing'); document.body.style.cursor='col-resize'; document.body.style.userSelect='none';
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', function(e){
      if(!dragging) return;
      var w=Math.max(MINW, Math.min(MAXW, startW - (e.clientX-startX)));
      insp.style.setProperty('--ng-insp-w', w+'px');
    });
    window.addEventListener('mouseup', function(){
      if(!dragging) return; dragging=false;
      insp.classList.remove('resizing'); document.body.style.cursor=''; document.body.style.userSelect='';
      try{ localStorage.setItem(WKEY, String(Math.round(insp.getBoundingClientRect().width))); }catch(_){}
      if(typeof resize==='function') resize();
      if(typeof render==='function') render();
    });
  })();

  // Collapse / expand the right Inspector (RS-B). Collapsed = width 0 so the Site
  // Map runs full-bleed for building/phase node work; a slim right-edge "Details"
  // tab brings it back. State persists per-browser. The map canvas re-fits after
  // the CSS width transition settles so grid/wire buffers match the new width.
  (function(){
    var cbtn=tab.querySelector('.ng-insp-collapse'), rbtn=tab.querySelector('.ng-insp-reopen');
    var CKEY='p86-ng-insp-collapsed';
    function apply(on){
      tab.classList.toggle('ng-insp-collapsed', on);
      try{ localStorage.setItem(CKEY, on?'1':'0'); }catch(_){}
      setTimeout(function(){ if(typeof resize==='function') resize(); if(typeof render==='function') render(); }, 230);
    }
    try{ if(localStorage.getItem(CKEY)==='1') tab.classList.add('ng-insp-collapsed'); }catch(_){}
    if(cbtn) cbtn.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); apply(true); });
    if(rbtn) rbtn.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); apply(false); });
    // The re-open "Details" tab lives INSIDE .ng-canvas-area, whose pan handler
    // starts a drag on mousedown/pointerdown and pre-empts the click — so a real
    // mouse press never fires the click (only a synthetic .click() would). Every
    // other in-canvas control (zoom ctrl, add-FAB, tool overlays) guards the same
    // way. Without this, the tab renders but "won't open" on click.
    ['mousedown','pointerdown','touchstart'].forEach(function(ev){
      if(cbtn) cbtn.addEventListener(ev, function(e){ e.stopPropagation(); });
      if(rbtn) rbtn.addEventListener(ev, function(e){ e.stopPropagation(); });
    });
  })();

  // Mobile segmented control: Map (default) / Overview / Detail — the left + right panels
  // become slide-up bottom sheets <768px so the map stays full-bleed and touch-pannable.
  var mseg=tab.querySelector('.ng-mobile-seg');
  if(mseg) mseg.addEventListener('click',function(e){
    var b=e.target.closest('[data-mseg]'); if(!b) return;
    var m=b.getAttribute('data-mseg');
    tab.classList.remove('ng-m-overview','ng-m-detail');
    if(m==='overview') tab.classList.add('ng-m-overview');
    else if(m==='detail') tab.classList.add('ng-m-detail');
    mseg.querySelectorAll('.ng-mseg-btn').forEach(function(x){ x.classList.toggle('ng-on', x===b); });
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
      E.setNodes([]); E.setWires([]); E.setNid(1); if(E.setFrames) E.setFrames([]); if(E.setMeasurements) E.setMeasurements([]);
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
    if(!on && _spOrbit) exitOrbit3D();    // the 3D orbit view is a site-plan layer — leave it with the mode
  });

  // Satellite is PERMANENT now (the toggle button is retired/hidden). The handler is
  // intentionally gone so nothing can flip _spSatellite false — that was the only path
  // that dropped .ng-sat and brought the old abstract building cards back. Keep the var
  // ref so any later querySelector('.ng-sat-btn') still resolves harmlessly.
  var satBtn=tab.querySelector('.ng-sat-btn');

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

  // 3D Orbit — Google's real tilted 3D buildings in an isolated look-around layer.
  var orbitBtn=tab.querySelector('.ng-orbit-btn');
  if(orbitBtn) orbitBtn.addEventListener('click', toggleOrbit3D);

  // Photo-GPS pins (Slice 4) — plot the job's geotagged photos on the imagery.
  var photosBtn=tab.querySelector('.ng-photos-btn');
  if(photosBtn) photosBtn.addEventListener('click', function(){
    _spPhotos=!_spPhotos;
    try{ localStorage.setItem('ngSitePlanPhotos', _spPhotos?'1':'0'); }catch(_){}
    photosBtn.classList.toggle('ng-on', _spPhotos);
    updatePhotoLayer();
  });

  // Task pins — plot the job's geolocated tasks on the imagery (filterable on/off).
  var tasksBtn=tab.querySelector('.ng-tasks-btn');
  if(tasksBtn){
    tasksBtn.classList.toggle('ng-on', _spTasks);
    tasksBtn.addEventListener('click', function(){
      _spTasks=!_spTasks;
      try{ localStorage.setItem('ngSitePlanTasks', _spTasks?'1':'0'); }catch(_){}
      tasksBtn.classList.toggle('ng-on', _spTasks);
      updateTaskLayer();
    });
  }

  // Basemap type — flip the imagery between satellite and a street/road map
  // (for locations with no/poor satellite coverage). setMapTypeId is instant, no
  // remount; the building footprints + geo overlays ride on top either way, so you
  // can still place/trace buildings on the map view.
  var basemapBtn=tab.querySelector('.ng-basemap-btn');
  if(basemapBtn){
    var _syncBasemapBtn=function(){
      var on = _spBasemapType==='roadmap';
      basemapBtn.classList.toggle('ng-on', on);
      // Label reflects the CURRENT basemap so the button reads as a live toggle:
      // showing satellite → "Map view" (click to switch to roadmap); showing the
      // road map → "Satellite" (click to switch back).
      var _lbl = basemapBtn.querySelector('.ng-ribbon-label');
      if(_lbl) _lbl.textContent = on ? 'Satellite' : 'Map view';
    };
    _syncBasemapBtn();
    basemapBtn.addEventListener('click', function(){
      _spBasemapType = (_spBasemapType==='roadmap') ? 'satellite' : 'roadmap';
      try{ localStorage.setItem('ngSitePlanBasemap', _spBasemapType); }catch(_){}
      _syncBasemapBtn();
      if(_basemap && _basemapReady){ try{ _basemap.setMapTypeId(_spBasemapType); }catch(_){} syncBasemapCamera(); }
      else if(E.viewMode && E.viewMode()==='siteplan'){ mountBasemap(); }
    });
  }

  // Workspace — open the spreadsheet workspace as a floating window OVER the
  // map (toggle) instead of as a node anchored inside the canvas. Wired to
  // workspace-layout.js's window.p86WorkspaceToggle.
  var wsBtn=tab.querySelector('.ng-workspace-btn');
  if(wsBtn) wsBtn.addEventListener('click', function(){
    if(typeof window.p86WorkspaceToggle==='function') window.p86WorkspaceToggle();
  });

  // Measure (distance + area) — tap points on the imagery for real ft / sq ft.
  var measureBtn=tab.querySelector('.ng-measure-btn');
  if(measureBtn) measureBtn.addEventListener('click', toggleMeasure);

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
  try { restoreSectionPanel(); } catch(e){}   // return any inspector-held section panel to #wsRightContent
  try { exitOrbit3D(); } catch(e){}           // drop the 3D orbit layer on close
  if(typeof window.E !== 'undefined' && window.E && typeof window.E.saveGraph === 'function'){
    try { window.E.saveGraph(); } catch(e){ /* defensive */ }
  } else if(typeof NG !== 'undefined' && NG.saveGraph){
    try { NG.saveGraph(); } catch(e){ /* defensive */ }
  }
  tab.classList.remove('active');
  // Re-activate the highlighted section tab so the pane restoreSectionPanel
  // just returned (display:none) actually shows — otherwise the job detail
  // under the closed map renders with every section pane hidden. Must run
  // AFTER the overlay's .active is removed so activateTab takes its normal
  // (non-map) path instead of routing back into p86NgShowSection.
  try {
    var _secTab=document.querySelector('.ws-right-tab[data-panel].active') ||
                document.querySelector('.ws-right-tab[data-panel="job-overview"]') ||
                document.querySelector('.ws-right-tab[data-panel]');
    if(_secTab) _secTab.click();
  } catch(e){}
  // If the user maximized the graph (hid the AGX nav header), restore
  // the header so they're not stuck in fullscreen on the job detail.
  if(document.body.classList.contains('ng-graph-fullscreen')){
    document.body.classList.remove('ng-graph-fullscreen');
    var maxBtn=document.getElementById('ngFullscreenGraphBtn');
    if(maxBtn) maxBtn.innerHTML='\u{1F5D6} Maximize';
  }
};

// Size the fixed graph overlay around the app chrome: below the sticky
// header, right of the left job-subnav sidebar (or full-bleed at left:0
// when the sidebar is hidden, e.g. mobile <768px). Measured LIVE — not
// once at open — because a cold deep-link boot (PWA update relaunch) can
// open the graph while the shell is still hidden behind the auth check:
// header/sidebar measure 0 and the overlay paints over both until the
// user exits and re-enters the job. wireGraphTabPositioning() re-runs
// this when the sidebar lays out late, gets drag-resized, or collapses.
function positionGraphTab(){
  var tab=document.getElementById('nodeGraphTab');
  if(!tab||!tab.classList.contains('active')) return;
  var header=document.querySelector('header');
  var top=(header&&header.offsetHeight>0)?header.offsetHeight:0;
  // Keep the job metrics strip (#jh-strip-detached — the Total Income / Costs /
  // % Complete / Revenue / Profit / Margin chips that sit just below the header
  // in the page flow) VISIBLE above the Site Map, instead of being covered by
  // this fixed overlay. Start the map at the strip's bottom edge. Only while the
  // header is showing — Maximize hides the header for a full-bleed map, and the
  // strip goes with it.
  if(top>0){
    var strip=document.getElementById('jh-strip-detached');
    if(strip && strip.offsetParent!==null && strip.offsetHeight>0){
      var sb=strip.getBoundingClientRect().bottom;
      if(sb>top) top=sb;
    }
  }
  tab.style.top=Math.round(top)+'px';
  var _appSb=document.getElementById('app-sidebar');
  tab.style.left=(_appSb&&_appSb.offsetParent!==null&&_appSb.offsetWidth>0)?(_appSb.offsetWidth+'px'):'0';
}
// Re-assert the size of EVERY graph surface that latches a pixel/tile
// dimension: the fixed overlay position, the wire/grid canvas bitmaps, the
// google.maps satellite raster, and the 3D orbit iframe's inner viewport.
// The graph used to react only to window WIDTH (the sidebar RO) but was
// blind to window HEIGHT — a PWA update-relaunch opens the overlay while
// the window is mid-restore at a transient small size; the two Google
// surfaces latch that size and nothing ever re-measured them once the
// window settled, so the map paints short with a black band below (torn
// layout). Debounced so a resize-drag / relaunch storm collapses to one.
var _reflowT=null;
function reflowGraphSurfaces(){
  clearTimeout(_reflowT);
  _reflowT=setTimeout(function(){
    var tab=document.getElementById('nodeGraphTab');
    if(!tab||!tab.classList.contains('active')) return;
    positionGraphTab();
    if(wrap && typeof resize==='function'){ try{ resize(); }catch(_){} } // wire/grid canvas bitmaps + basemap visibility
    // 2D satellite raster: force Google to re-measure its container, then
    // re-center. Modern Maps auto-detects container resize, but a settle
    // after a mid-restore latch can miss it — trigger explicitly.
    if(_basemap && _basemapReady){
      try{ if(window.google && google.maps && google.maps.event) google.maps.event.trigger(_basemap,'resize'); }catch(_){}
      try{ syncBasemapCamera(); }catch(_){}
    }
    // 3D orbit iframe: nudge the element so its inner page receives a resize
    // event (orbit3d.html's own self-heal restores the 3D layout), then
    // re-feed data. The parent can't reach the iframe's inner viewport.
    if(_spOrbit && _orbitEl && _orbitEl.__frame){
      var f=_orbitEl.__frame;
      try{ f.style.height='calc(100% - 1px)'; requestAnimationFrame(function(){ f.style.height=''; }); }catch(_){}
      try{ postOrbitData(); }catch(_){}
    }
  }, 120);
}
var _tabPosWired=false;
function wireGraphTabPositioning(){
  if(_tabPosWired) return; _tabPosWired=true;
  window.addEventListener('resize', reflowGraphSurfaces);
  if(typeof ResizeObserver==='undefined') return;
  // Core height-blindness fix: watch the canvas area itself. Fires on
  // window HEIGHT changes and display:none→flex transitions that the
  // width-gated sidebar observer below never sees. The size guard breaks
  // the position→resize→observe feedback loop (positionGraphTab is
  // idempotent, so a settled size re-fires nothing).
  var _ca=document.querySelector('#nodeGraphTab .ng-canvas-area');
  if(_ca){
    var _lastCAW=-1,_lastCAH=-1;
    new ResizeObserver(function(){
      var tab=document.getElementById('nodeGraphTab');
      if(!tab||!tab.classList.contains('active')) return;
      var r=_ca.getBoundingClientRect(), w=Math.round(r.width), h=Math.round(r.height);
      if(w===_lastCAW && h===_lastCAH) return;
      _lastCAW=w; _lastCAH=h;
      reflowGraphSurfaces();
    }).observe(_ca);
  }
  var _sb=document.getElementById('app-sidebar');
  if(_sb){
    var _lastW=-1;
    new ResizeObserver(function(){
      var tab=document.getElementById('nodeGraphTab');
      if(!tab||!tab.classList.contains('active')) return;
      var w=_sb.offsetWidth;
      if(w===_lastW) return;
      _lastW=w;
      reflowGraphSurfaces();
    }).observe(_sb);
  }
}

window.openNodeGraph=function(jid){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  tab.classList.add('active');
  wireGraphTabPositioning();
  positionGraphTab();
  // Fresh start for the right Inspector on every open: clear any stale section view (which would
  // make renderInspector bail) and reset the build-once key so the job detail rebuilds. Fixes the
  // "right bar empty on the first try" race after a prior job/section was open.
  try { restoreSectionPanel(); } catch(e){}
  _inspJobKey=null;
  try { exitOrbit3D(); } catch(e){}           // never reopen stuck in the 3D orbit layer
  // Restore the persisted Clean Mode look + sync the toggle button.
  try {
    var _clean = E && E.cleanMode && E.cleanMode();
    tab.classList.toggle('ng-clean', !!_clean);
    var _cb = document.getElementById('ngCleanBtn'); if(_cb) _cb.classList.toggle('ng-on', !!_clean);
  } catch(_){}
  // The node graph is satellite-mapping-only now — the old abstract card/wire
  // graph is retired. Force Site Plan + the satellite basemap ON on every open,
  // overriding any persisted localStorage, so a job never lands on the abstract graph.
  try {
    if(E && E.setViewMode) E.setViewMode('siteplan');
    _spSatellite = true;
    try { localStorage.setItem('ngSitePlanSatellite','1'); } catch(_){}
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
    _spOrigin=null; _spOriginGraph=null; _spOriginJob=null; _geoPhotos=[]; _geoPhotosJob=null; _geocoding=false; _fannedSet={}; ngOpenScopes={}; // drop geo caches + fan state + scope-expand state: avoid cross-job staleness (node ids collide across jobs)
    E.setNodes([]); E.setWires([]); E.setNid(1);
    if(E.setMeasurements) E.setMeasurements([]); // drop survey measurements too, so a fresh job (populate path) never inherits the previous job's
    if(!E.loadGraph()){ populate(); }
    // First-open fix: the early basemap mount stamped the geo origin over an empty node
    // set (loadGraph runs AFTER it), then the cache was reset to null above — so
    // syncBasemapCamera bailed and the map sat off-position/scale until a re-open. Now
    // that the graph is loaded, re-stamp the origin before the first render.
    _spOrigin=jobOrigin(); _spOriginGraph=siteplanCentroid(); _spOriginJob=E.job();
    ensureWatchFan();
    applyTx(); render();
    syncFromCloud();
  } else if(E.nodes().length===0){
    E.job(jid||(typeof appState!=='undefined'?appState.currentJobId:null));
    if(!E.loadGraph()){ populate(); }
    _spOrigin=jobOrigin(); _spOriginGraph=siteplanCentroid(); _spOriginJob=E.job(); // re-stamp origin post-load (first-open fix)
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
