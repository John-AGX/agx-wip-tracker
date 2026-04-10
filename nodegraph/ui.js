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

// ── Update T2 labels based on connected T1 ──
function updateTierLabels(){
  var nodes=E.nodes(), wires=E.wires();
  nodes.forEach(function(n){
    if(n.type!=='t2') return;
    // Get base name (strip any existing " › ..." suffix)
    var baseName = n.label.split(' \u203A ')[0].trim();
    // Find if this T2's output is wired to a T1
    var t1Name = '';
    wires.forEach(function(w){
      if(w.fromNode===n.id){
        var target=E.findNode(w.toNode);
        if(target&&target.type==='t1') t1Name=target.label;
      }
    });
    n.label = t1Name ? baseName+' \u203A '+t1Name : baseName;
  });
}

// ── Resize canvases ──
function resize(){
  wireC.width=wrap.clientWidth; wireC.height=wrap.clientHeight;
  gridC.width=wrap.clientWidth; gridC.height=wrap.clientHeight;
}

// ── Render ──
function renderNodes(){
  var nodes=E.nodes(), wires=E.wires();
  canvasEl.querySelectorAll('.ng-node').forEach(function(el){
    if(editingId && el.getAttribute('data-id')===editingId) return;
    el.remove();
  });
  E.resetComp();

  nodes.forEach(function(n){
    var d=E.DEFS[n.type]; if(!d) return;
    if(editingId===n.id) return;
    var div=document.createElement('div');
    div.className='ng-node ng-t-'+n.cat+(selN===n.id?' ng-sel':'')+(n.collapsed?' ng-coll':'');
    div.setAttribute('data-id',n.id);
    div.style.left=n.x+'px'; div.style.top=n.y+'px';

    var canColl = n.type!=='note';
    var h='<div class="ng-hdr"><span class="ng-hi">'+d.icon+'</span><span class="ng-hdr-name" data-rename="'+n.id+'" title="Double-click to rename">'+n.label+'</span>';
    if(canColl) h+='<span class="ng-cbtn" data-coll="'+n.id+'">'+(n.collapsed?'\u25B6':'\u25BC')+'</span>';
    h+='</div>';

    // Ports
    var hasIns=(d.ins&&d.ins.length>0), hasOuts=(d.outs&&d.outs.length>0);
    if(hasIns||hasOuts){
      h+='<div class="ng-ports">';
      var mx=Math.max((d.ins||[]).length,(d.outs||[]).length);
      for(var i=0;i<mx;i++){
        h+='<div class="ng-pr">';
        // Input port + label (left side)
        if(hasIns&&i<d.ins.length){
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

    // Progress bar (T1/T2)
    if(d.hasProg){
      var pct = n.pctComplete || 0;
      var progColor = pct>=100?'#34d399':pct>=50?'#fbbf24':'#4f8cff';
      h+='<div class="ng-progress-wrap">';
      h+='<div class="ng-progress"><div class="ng-progress-fill" style="width:'+Math.min(pct,100)+'%;background:'+progColor+'"></div></div>';
      h+='<input type="range" class="ng-pct-slider" data-node="'+n.id+'" data-field="pctComplete" value="'+pct+'" min="0" max="100" step="1" />';
      h+='</div>';
      h+='<div class="ng-progress-label"><span class="ng-pct-val">'+pct.toFixed(0)+'%</span> complete'+(n.budget?' \u00b7 Budget: '+E.fmtC(n.budget):'')+'</div>';
    }

    // Sub-items (type-specific layout)
    if(d.hasItems){
      var iType = d.itemType || '';
      var UNITS = ['each','SF','LF','gal','bag','box','ton','yd\u00B3','roll','hr'];
      // PO: base contract input
      if(iType==='po') h+='<div class="ng-edit-val"><label style="font-size:9px;color:#6a7090;display:block;text-align:center;">Base Contract</label><input type="number" value="'+(n.value||0)+'" data-node="'+n.id+'" step="0.01" /></div>';
      h+='<div class="ng-subitems">';
      // Header row
      if(iType==='labor') h+='<div class="ng-si-hdr"><span>Week Of</span><span>Hrs</span><span>Rate</span><span>Total</span><span></span></div>';
      else if(iType==='mat') h+='<div class="ng-si-hdr"><span>Date</span><span>Amount</span><span></span></div>';
      else if(iType==='gc') h+='<div class="ng-si-hdr"><span>Week Of</span><span>Vendor</span><span>Amount</span><span></span></div>';
      else if(iType==='other') h+='<div class="ng-si-hdr"><span>Date</span><span>Qty</span><span>$/Unit</span><span>Total</span><span></span></div>';
      else if(iType==='sub') h+='<div class="ng-si-hdr"><span>Date</span><span>Description</span><span>Amount</span><span></span></div>';
      else if(iType==='po') h+='<div class="ng-si-hdr"><span>Date</span><span>Amendment</span><span>Amount</span><span></span></div>';
      else if(iType==='inv') h+='<div class="ng-si-hdr"><span>Date</span><span>Invoice #</span><span>Amount</span><span></span></div>';

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
      // PO: show base contract + amendments
      if(iType==='po'){
        var amendTotal=n.items.reduce(function(s,i){return s+(i.amount||0);},0);
        var poInvoiced=E.getOutput(n,1);
        h+='<div style="font-size:9px;color:#6a7090;text-align:center;padding:0 0 2px;">Base: '+E.fmtC(n.value||0)+' + Amendments: '+E.fmtC(amendTotal)+' = '+E.fmtC((n.value||0)+amendTotal)+'</div>';
        if(poInvoiced>0) h+='<div style="font-size:9px;color:#34d399;text-align:center;padding:0 0 4px;">Invoiced: '+E.fmtC(poInvoiced)+' \u2192 Actual Cost</div>';
      }
      h+='</div>';
    }

    // Sub: show PO contract, invoiced, accrued from wired inputs
    if(n.type==='sub'){
      E.resetComp();
      var subIns=[0,0];
      E.wires().forEach(function(w){if(w.toNode===n.id){var fn=E.findNode(w.fromNode);if(fn)subIns[w.toPort]=(subIns[w.toPort]||0)+E.getOutput(fn,w.fromPort);}});
      var poAmt=subIns[0],invAmt=subIns[1];
      var accrued=E.getOutput(n,1);
      // Find what % the accrual is using (from connected T1/T2)
      var subPct = n.pctComplete || 0;
      var pctSource = 'manual';
      E.wires().forEach(function(w){
        if(w.fromNode===n.id){
          var tgt=E.findNode(w.toNode);
          if(tgt&&(tgt.type==='t1'||tgt.type==='t2')&&tgt.pctComplete>0){subPct=tgt.pctComplete;pctSource=tgt.label;}
          if(tgt&&tgt.type==='sum'){
            E.wires().forEach(function(w2){if(w2.fromNode===tgt.id){var t2=E.findNode(w2.toNode);if(t2&&(t2.type==='t1'||t2.type==='t2')&&t2.pctComplete>0){subPct=t2.pctComplete;pctSource=t2.label;}}});
          }
        }
      });
      var actualCost=E.getOutput(n,0);
      h+='<div style="padding:4px 10px 6px;font-size:10px;">';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">PO Contract <span style="color:#8899cc;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(poAmt)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">Invoiced (Actual) <span style="color:#34d399;font-weight:600;font-family:\'Courier New\',monospace;">'+E.fmtC(invAmt)+'</span></div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;">% Complete <span style="color:#fbbf24;font-weight:600;font-family:\'Courier New\',monospace;">'+subPct.toFixed(1)+'%</span></div>';
      if(pctSource!=='manual') h+='<div style="font-size:8px;color:#4a5068;text-align:right;padding:0 0 2px;">from '+pctSource+'</div>';
      h+='<div style="display:flex;justify-content:space-between;padding:2px 0;color:#6a7090;border-top:1px solid #1a1f30;margin-top:2px;">Accrued <span style="color:#fbbf24;font-weight:700;font-family:\'Courier New\',monospace;">'+E.fmtC(accrued)+'</span></div>';
      h+='</div>';
    }

    // T1/T2: show total
    if(n.type==='t1'||n.type==='t2'){
      var tv=E.getOutput(n,0), tcls=tv>0?' ng-vp':'';
      h+='<div class="ng-wv'+tcls+'" style="font-size:16px;margin:2px 8px 6px;padding:4px 8px;">'+E.fmtC(tv)+'</div>';
    }

    // Job node: show editable revenue fields
    if(n.type==='job'){
      var jf=n.jobFields||{};
      h+='<div class="ng-subitems" style="max-height:none;">';
      var jobRows=[
        {k:'contractAmount',l:'Contract Amount'},
        {k:'estimatedCosts',l:'Est. Costs (As Sold)'},
        {k:'revisedCostChanges',l:'Revised Cost Changes'},
        {k:'targetMarginPct',l:'Target Margin %'},
      ];
      jobRows.forEach(function(r){
        h+='<div class="ng-subitem">';
        h+='<span class="ng-si-date" style="width:auto;flex:1;background:none;border:none;color:#6a7090;">'+r.l+'</span>';
        h+='<input class="ng-si-amt" data-node="'+n.id+'" data-jfield="'+r.k+'" value="'+(jf[r.k]||n.data[r.k]||0)+'" step="0.01" />';
        h+='</div>';
      });
      h+='</div>';
    }

    // WIP node: show metric outputs as large values
    if(n.type==='wip'){
      var wipD=E.DEFS.wip;
      h+='<div style="padding:4px 10px 6px;">';
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

    // Watch: large display
    if(n.type==='watch'){
      var wv=0;
      E.wires().forEach(function(w){if(w.toNode===n.id){var fn=E.findNode(w.fromNode);if(fn)wv+=E.getOutput(fn,w.fromPort);}});
      var wcls=wv>0?' ng-vp':wv<0?' ng-vn':'';
      h+='<div class="ng-wv'+wcls+'">'+E.fmtC(wv)+'</div>';
      h+='<div class="ng-wv-label">'+n.label+'</div>';
    }

    // Note
    if(n.type==='note') h+='<div class="ng-note-body"><textarea data-node="'+n.id+'" placeholder="Type a note...">'+(n.noteText||'')+'</textarea></div>';

    // Collapsed row with ports + mini total
    if(hasIns||hasOuts){
      var collVal = hasOuts ? E.getOutput(n,0) : 0;
      if(n.type==='watch'){collVal=0;E.wires().forEach(function(w){if(w.toNode===n.id){var fn=E.findNode(w.fromNode);if(fn)collVal+=E.getOutput(fn,w.fromPort);}});}
      h+='<div class="ng-coll-row">';
      if(hasIns) h+='<div class="ng-p ng-pi ng-pc ng-p-'+d.ins[0].t+'" data-node="'+n.id+'" data-pi="0" data-dir="in" data-type="'+d.ins[0].t+'"></div>';
      else h+='<span style="width:12px"></span>';
      h+='<span class="ng-coll-val">'+E.fmtC(collVal)+'</span>';
      if(hasOuts) h+='<div class="ng-p ng-po ng-pc ng-p-'+d.outs[0].t+'" data-node="'+n.id+'" data-pi="0" data-dir="out" data-type="'+d.outs[0].t+'"></div>';
      else h+='<span style="width:12px"></span>';
      h+='</div>';
    }

    div.innerHTML=h;
    canvasEl.appendChild(div);
  });
}

function render(){
  updateTierLabels();
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
      var label=d.label;
      if(d.nameEdit) label=prompt('Name:',label)||label;
      var p=E.pan(),z=E.zm();
      var cx=-p.x+wrap.clientWidth/2/z, cy=-p.y+wrap.clientHeight/2/z;
      E.addNode(type,cx-85,cy-30,label);
      render();
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
      var tp=e.target.closest('.ng-pi');
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
    var port=e.target.closest('.ng-po');
    if(port){e.stopPropagation();wiringFrom={nid:port.getAttribute('data-node'),pi:parseInt(port.getAttribute('data-pi'))};return;}
    var cb=e.target.closest('.ng-cbtn');
    if(cb){e.stopPropagation();var cn=E.findNode(cb.getAttribute('data-coll'));if(cn){cn.collapsed=!cn.collapsed;render();}return;}
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
    if((t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT')&&t.dataset.node) editingId=t.dataset.node;
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
      var ws=E.wires();
      E.setWires(ws.filter(function(w){return w.fromNode!==selN&&w.toNode!==selN;}));
      E.setNodes(E.nodes().filter(function(n){return n.id!==selN;}));
      selN=null;render();
    }
  });
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
    if(n){n.budget=b.budget||0; n.pctComplete=0;}
  });

  // Col 2: T2 (phases) — wire to their T1
  var phases=appData.phases.filter(function(p2){return p2.jobId===jid;});
  phases.forEach(function(ph,i){
    var bl=appData.buildings.find(function(b){return b.id===ph.buildingId;});
    var n=E.addNode('t2',sx+230,sy+i*140,ph.phase+(bl?' \u203A '+bl.name:''),ph);
    if(n) n.pctComplete=ph.pctComplete||0;
    // Auto-wire T2→T1
    if(bl&&n){
      var t1=E.nodes().find(function(nd){return nd.type==='t1'&&nd.data&&nd.data.id===bl.id;});
      if(t1) E.wires().push({fromNode:n.id,fromPort:0,toNode:t1.id,toPort:0});
    }
  });

  // Col 3: Subs
  var subs=appData.subs.filter(function(s){return s.jobId===jid;});
  subs.forEach(function(s,i){E.addNode('sub',sx+460,sy+i*110,s.name||'Sub',s);});

  // Col 3 (lower): COs
  var cos=appData.changeOrders.filter(function(c){return c.jobId===jid;});
  cos.forEach(function(c,i){
    E.addNode('co',sx+460,sy+subs.length*110+40+i*110,(c.coNumber||'CO')+' '+c.description,c);
  });

  // Col 4: SUM node — auto-wire all T1s into it
  var sumNode=E.addNode('sum',sx+700,sy+50,'Total Costs');
  if(sumNode){
    var portIdx=0;
    E.nodes().forEach(function(nd){
      if(nd.type==='t1'&&portIdx<4){
        E.wires().push({fromNode:nd.id,fromPort:0,toNode:sumNode.id,toPort:portIdx});
        portIdx++;
      }
    });
  }

  // Col 5: Job node (revenue lines) — pre-fill from job data
  var co=appData.changeOrders.filter(function(c){return c.jobId===jid;});
  var coInc=co.reduce(function(s,c){return s+(c.income||0);},0);
  var coCst=co.reduce(function(s,c){return s+(c.estimatedCosts||0);},0);
  var jobNode=E.addNode('job',sx+700,sy+300,'Job Revenue',job);
  if(jobNode){
    jobNode.jobFields={
      contractAmount:job.contractAmount||0,
      estimatedCosts:job.estimatedCosts||0,
      revisedCostChanges:job.revisedCostChanges||0,
      targetMarginPct:job.targetMarginPct||0,
      coIncome:coInc,
      coCosts:coCst,
    };
  }

  // Col 6: WIP Metrics node — pre-wire from Job + SUM
  var wipNode=E.addNode('wip',sx+1000,sy+50,'WIP Metrics');
  if(wipNode&&jobNode){
    // Wire: Job.Total Income → WIP.Total Income (in port 0)
    E.wires().push({fromNode:jobNode.id,fromPort:2,toNode:wipNode.id,toPort:0});
    // Wire: SUM.Result → WIP.Actual Costs (in port 1)
    if(sumNode) E.wires().push({fromNode:sumNode.id,fromPort:0,toNode:wipNode.id,toPort:1});
    // Wire: Job.Rev. Est. Costs → WIP.Est. Costs (in port 4)
    E.wires().push({fromNode:jobNode.id,fromPort:5,toNode:wipNode.id,toPort:4});
  }
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
}

// ── Public ──
window.openNodeGraph=function(jid){
  var tab=document.getElementById('nodeGraphTab'); if(!tab) return;
  tab.classList.add('active');
  if(!wrap) init();
  resize();
  if(jid && jid!==E.job()){
    E.job(jid);
    E.setNodes([]); E.setWires([]); E.setNid(1);
    if(!E.loadGraph()){ populate(); }
    applyTx(); render();
  } else if(E.nodes().length===0){
    E.job(jid||(typeof appState!=='undefined'?appState.currentJobId:null));
    if(!E.loadGraph()){ populate(); }
    applyTx(); render();
  } else {
    render();
  }
};
})();
