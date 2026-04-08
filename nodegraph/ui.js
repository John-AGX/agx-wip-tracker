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
    var h='<div class="ng-hdr"><span class="ng-hi">'+d.icon+'</span><span class="ng-hdr-name">'+n.label+'</span>';
    if(canColl) h+='<span class="ng-cbtn" data-coll="'+n.id+'">'+(n.collapsed?'\u25B6':'\u25BC')+'</span>';
    h+='</div>';

    // Ports
    var hasIns=(d.ins&&d.ins.length>0), hasOuts=(d.outs&&d.outs.length>0);
    if(hasIns||hasOuts){
      h+='<div class="ng-ports">';
      var mx=Math.max((d.ins||[]).length,(d.outs||[]).length);
      for(var i=0;i<mx;i++){
        h+='<div class="ng-pr">';
        if(hasIns&&i<d.ins.length){
          var ip=d.ins[i], ic=wires.some(function(w){return w.toNode===n.id&&w.toPort===i;});
          h+='<div class="ng-p ng-pi ng-p-'+ip.t+(ic?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="in" data-type="'+ip.t+'"></div>';
          h+='<span class="ng-pl">'+ip.n+'</span>';
        } else if(hasIns){
          h+='<span style="width:12px"></span><span></span>';
        }
        if(hasOuts&&i<d.outs.length){
          var op=d.outs[i], oc=wires.some(function(w){return w.fromNode===n.id&&w.fromPort===i;}), ov=E.getOutput(n,i);
          if(!hasIns) h+='<span class="ng-pl" style="flex:1">'+op.n+'</span>';
          h+='<span class="ng-pv">'+E.fmtV(ov,op.t)+'</span>';
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
      h+='<div class="ng-progress"><div class="ng-progress-fill" style="width:'+pct+'%;background:'+progColor+'"></div></div>';
      h+='<div class="ng-progress-label">'+pct.toFixed(0)+'% complete'+(n.budget?' \u00b7 Budget: '+E.fmtC(n.budget):'')+'</div>';
    }

    // Cost sub-items
    if(d.hasItems){
      h+='<div class="ng-subitems">';
      n.items.forEach(function(item,idx){
        h+='<div class="ng-subitem">';
        h+='<span class="ng-subitem-date">'+(item.date||'—')+'</span>';
        h+='<span class="ng-subitem-val">'+E.fmtC(item.amount||0)+'</span>';
        h+='<span class="ng-subitem-del" data-node="'+n.id+'" data-idx="'+idx+'">\u2716</span>';
        h+='</div>';
      });
      h+='<div class="ng-add-sub" data-node="'+n.id+'">+ Add Entry</div>';
      var itemTotal = n.items.reduce(function(s,i){return s+(i.amount||0);},0);
      if(n.items.length>0) h+='<div class="ng-sub-total">'+E.fmtC(itemTotal)+'</div>';
      h+='</div>';
      // Fallback editable value if no items
      if(n.items.length===0) h+='<div class="ng-edit-val"><input type="number" value="'+(n.value||0)+'" data-node="'+n.id+'"/></div>';
    }

    // Sub: show contract info
    if(n.type==='sub'&&n.data){
      h+='<div class="ng-progress-label">Contract: '+E.fmtC(n.data.contractAmt||0)+'</div>';
    }

    // T1/T2: show total
    if(n.type==='t1'||n.type==='t2'){
      var tv=E.getOutput(n,0), tcls=tv>0?' ng-vp':'';
      h+='<div class="ng-wv'+tcls+'" style="font-size:16px;margin:2px 8px 6px;padding:4px 8px;">'+E.fmtC(tv)+'</div>';
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
    // Add sub-item
    var addSub=e.target.closest('.ng-add-sub');
    if(addSub){
      e.stopPropagation();
      var n=E.findNode(addSub.getAttribute('data-node'));
      if(n){
        var date=prompt('Date (e.g. 4/7):','');
        var amt=parseFloat(prompt('Amount:','0'))||0;
        if(date!==null) n.items.push({date:date,amount:amt});
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
    if(nel&&!e.target.closest('input')&&!e.target.closest('textarea')){
      e.stopPropagation();
      var nid2=nel.getAttribute('data-id'),n3=E.findNode(nid2);if(!n3)return;
      selN=nid2;dragN=nid2;
      var p=E.pan();
      dragOff={x:e.clientX/z()-p.x-n3.x, y:e.clientY/z()-p.y-n3.y};
      render();
    }
  });

  canvasEl.addEventListener('focusin',function(e){
    var t=e.target;
    if((t.tagName==='INPUT'||t.tagName==='TEXTAREA')&&t.dataset.node) editingId=t.dataset.node;
  });
  canvasEl.addEventListener('focusout',function(e){
    var t=e.target;
    if((t.tagName==='INPUT'||t.tagName==='TEXTAREA')&&t.dataset.node){
      var n=E.findNode(t.dataset.node);
      if(n){
        if(t.tagName==='TEXTAREA') n.noteText=t.value;
        else n.value=parseFloat(t.value)||0;
      }
      editingId=null; render();
    }
  });
  canvasEl.addEventListener('input',function(e){
    var t=e.target;
    if(t.tagName==='INPUT'&&t.dataset.node){
      var n=E.findNode(t.dataset.node);
      if(n) n.value=parseFloat(t.value)||0;
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
    var n=E.addNode('t2',sx+230,sy+i*140,(bl?bl.name+' \u203A ':'')+ph.phase,ph);
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

  // Col 5: Watch nodes (pre-wired metrics)
  var metrics=[
    {label:'Total Cost',src:sumNode},
    {label:'Revenue',src:null},
    {label:'Profit',src:null},
    {label:'Margin %',src:null},
  ];
  metrics.forEach(function(m,i){
    var w=E.addNode('watch',sx+950,sy+i*130,m.label);
    if(w&&m.src){
      E.wires().push({fromNode:m.src.id,fromPort:0,toNode:w.id,toPort:0});
    }
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
