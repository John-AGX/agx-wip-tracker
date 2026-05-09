// ============================================================
// Project 86 Node Graph v4 — Dynamo-Style with Category Browser
// Unit costs, sticky notes, custom costs, collapsible nodes
// ============================================================
(function(){
'use strict';
var PT={C:'currency',P:'percent',N:'number',A:'any'};
var WCOL={currency:'#34d399',percent:'#fbbf24',number:'#a78bfa',any:'#4f8cff'};
function canConn(a,b){return a===b||a===PT.A||b===PT.A||(a===PT.N&&b===PT.C);}

// ── Node definitions ──
var D={
  building:  {cat:'data',icon:'\u{1F3D7}',label:'Building',  ins:[{n:'Costs',t:PT.C}],outs:[{n:'Total',t:PT.C}], showBudget:true},
  phase:     {cat:'data',icon:'\u{1F4CB}',label:'Phase',     ins:[{n:'Costs',t:PT.C}],outs:[{n:'Total',t:PT.C}]},
  sub:       {cat:'data',icon:'\u{1F477}',label:'Sub',        ins:[],outs:[{n:'Billed',t:PT.C}]},
  co:        {cat:'data',icon:'\u{1F4DD}',label:'Change Order',ins:[],outs:[{n:'Income',t:PT.C},{n:'Est.Costs',t:PT.C}]},
  value:     {cat:'cost',icon:'\u{1F4B2}',label:'Value',      ins:[],outs:[{n:'Value',t:PT.C}],edit:true},
  materials: {cat:'cost',icon:'\u{1F9F1}',label:'Materials',   ins:[],outs:[{n:'$',t:PT.C}],edit:true},
  labor:     {cat:'cost',icon:'\u{1F6E0}',label:'Labor',       ins:[],outs:[{n:'$',t:PT.C}],edit:true},
  equipment: {cat:'cost',icon:'\u2699',   label:'Equipment',   ins:[],outs:[{n:'$',t:PT.C}],edit:true},
  gc:        {cat:'cost',icon:'\u{1F3E2}',label:'Gen.Cond.',    ins:[],outs:[{n:'$',t:PT.C}],edit:true},
  custom:    {cat:'cost',icon:'\u{1F4CC}',label:'Custom Cost',  ins:[],outs:[{n:'$',t:PT.C}],edit:true,nameEdit:true},
  number:    {cat:'cost',icon:'#',        label:'Number',       ins:[],outs:[{n:'#',t:PT.N}],edit:true},
  paint:     {cat:'unit',icon:'\u{1F3A8}',label:'Paint',        unit:'gal'},
  lumber:    {cat:'unit',icon:'\u{1F4D0}',label:'Lumber',       unit:'bd ft'},
  wire:      {cat:'unit',icon:'\u26A1',   label:'Wire/Cable',   unit:'ft'},
  concrete:  {cat:'unit',icon:'\u{1F9F1}',label:'Concrete',     unit:'yd\u00B3'},
  unitCustom:{cat:'unit',icon:'\u{1F4CC}',label:'Custom Unit',  unit:'unit',nameEdit:true},
  sum:       {cat:'math',icon:'\u2211',   label:'SUM',          ins:[{n:'A',t:PT.A},{n:'B',t:PT.A},{n:'C',t:PT.A},{n:'D',t:PT.A}],outs:[{n:'Result',t:PT.C}]},
  subtract:  {cat:'math',icon:'\u2212',   label:'Subtract',     ins:[{n:'A',t:PT.C},{n:'B',t:PT.C}],outs:[{n:'Result',t:PT.C}]},
  multiply:  {cat:'math',icon:'\u00D7',   label:'Multiply',     ins:[{n:'A',t:PT.A},{n:'B',t:PT.N}],outs:[{n:'Result',t:PT.C}]},
  pct:       {cat:'math',icon:'%',        label:'Percent',      ins:[{n:'Val',t:PT.C},{n:'%',t:PT.P}],outs:[{n:'Result',t:PT.C}]},
  total:     {cat:'output',icon:'\u{1F4CA}',label:'Total',      ins:[{n:'Mat',t:PT.C},{n:'Lab',t:PT.C},{n:'Sub',t:PT.C},{n:'Equip',t:PT.C},{n:'GC',t:PT.C}],outs:[{n:'Total',t:PT.C}]},
  profit:    {cat:'output',icon:'\u{1F4B0}',label:'Profit',     ins:[{n:'Revenue',t:PT.C},{n:'Costs',t:PT.C}],outs:[{n:'Profit',t:PT.C},{n:'Margin',t:PT.P}]},
  watch:     {cat:'output',icon:'\u{1F441}',label:'Watch',      ins:[{n:'Value',t:PT.A}],outs:[]},
  note:      {cat:'note',icon:'\u{1F4CC}',label:'Note',         ins:[],outs:[]},
};
// Unit cost nodes: ins=[], outs=[{n:'Total',t:PT.C}], have unitPrice + qty
Object.keys(D).forEach(function(k){var d=D[k];if(d.cat==='unit'){d.ins=[];d.outs=[{n:'Total',t:PT.C}];}});

// ── Category structure for sidebar ──
var CATS=[
  {name:'Structure',items:['building','phase']},
  {name:'Costs',items:['materials','labor','equipment','gc','custom','value','number']},
  {name:'Unit Costs',items:['paint','lumber','wire','concrete','unitCustom']},
  {name:'Subs & COs',items:['sub','co']},
  {name:'Math',items:['sum','subtract','multiply','pct']},
  {name:'Outputs',items:['total','profit','watch']},
  {name:'Notes',items:['note']},
];

// ── State ──
var nodes=[],wires=[],nid=1;
var wrap,canvasEl,wireC,wireCtx,gridC,gridCtx;
var panX=0,panY=0,zoom=1,jobId=null;
var dragN=null,dragOff={x:0,y:0};
var wiringFrom=null,wireMouse=null;
var selN=null,isPan=false,panSt={x:0,y:0};
var editingNodeId=null; // track which node has input focus
var SNAP=15;

function gid(){return 'n'+(nid++);}
function addN(type,x,y,label,data){
  var d=D[type]; if(!d) return null;
  var n={id:gid(),type:type,cat:d.cat,x:Math.round(x/SNAP)*SNAP,y:Math.round(y/SNAP)*SNAP,label:label||d.label,data:data||{},value:0,collapsed:false,noteText:''};
  if(d.cat==='unit'){n.unitPrice=0;n.qty=0;}
  if(data&&data._val!=null) n.value=data._val;
  nodes.push(n); return n;
}
function find(id){return nodes.find(function(n){return n.id===id;});}

// ── Save / Load graph state ──
function saveGraph(){
  if(!jobId) return;
  var state={
    nodes:nodes.map(function(n){return{id:n.id,type:n.type,x:n.x,y:n.y,label:n.label,value:n.value,collapsed:n.collapsed,unitPrice:n.unitPrice,qty:n.qty,noteText:n.noteText,dataId:n.data?n.data.id:null};}),
    wires:wires,
    panX:panX,panY:panY,zoom:zoom,nid:nid
  };
  var all=JSON.parse(localStorage.getItem('p86-nodegraphs')||'{}');
  all[jobId]=state;
  localStorage.setItem('p86-nodegraphs',JSON.stringify(all));
}

function loadGraph(){
  if(!jobId) return false;
  var all=JSON.parse(localStorage.getItem('p86-nodegraphs')||'{}');
  var state=all[jobId];
  if(!state||!state.nodes||!state.nodes.length) return false;
  nodes=[];wires=state.wires||[];nid=state.nid||1;
  panX=state.panX||0;panY=state.panY||0;zoom=state.zoom||1;
  state.nodes.forEach(function(sn){
    var d=D[sn.type];if(!d) return;
    // Reconnect to live job data if available
    var data={};
    if(sn.dataId&&typeof appData!=='undefined'){
      if(sn.type==='building') data=appData.buildings.find(function(b){return b.id===sn.dataId;})||{};
      else if(sn.type==='phase') data=appData.phases.find(function(p){return p.id===sn.dataId;})||{};
      else if(sn.type==='sub') data=appData.subs.find(function(s){return s.id===sn.dataId;})||{};
      else if(sn.type==='co') data=appData.changeOrders.find(function(c){return c.id===sn.dataId;})||{};
    }
    var n={id:sn.id,type:sn.type,cat:d.cat,x:sn.x,y:sn.y,label:sn.label,data:data,value:sn.value||0,collapsed:sn.collapsed||false,noteText:sn.noteText||''};
    if(d.cat==='unit'){n.unitPrice=sn.unitPrice||0;n.qty=sn.qty||0;}
    nodes.push(n);
  });
  return true;
}

// ── Value computation ──
var _comp={};
function getOut(n,pi){
  if(_comp[n.id]) return 0;
  _comp[n.id]=true;
  var d=D[n.type],v=0;
  if(d&&d.edit){v=n.value||0;_comp[n.id]=false;return v;}
  if(d&&d.cat==='unit'){v=(n.unitPrice||0)*(n.qty||0);_comp[n.id]=false;return v;}
  if(n.cat==='data'&&n.data){
    var dd=n.data,outs=d.outs,lbl=outs[pi]?outs[pi].n:'';
    // Building/Phase: output = sum of wired inputs (costs fed in)
    if(n.type==='building'||n.type==='phase'){
      var costIn=0;
      wires.forEach(function(w){if(w.toNode===n.id){var fn=find(w.fromNode);if(fn)costIn+=getOut(fn,w.fromPort);}});
      v=costIn;
      _comp[n.id]=false;return v;
    }
    // Sub: just output billed to date
    if(lbl==='Billed')v=dd.billedToDate||0;
    else if(lbl==='Income')v=dd.income||0;
    else if(lbl==='Est.Costs')v=dd.estimatedCosts||0;
    _comp[n.id]=false;return v;
  }
  var ins=(d.ins||[]).map(function(){return 0;});
  wires.forEach(function(w){if(w.toNode===n.id){var fn=find(w.fromNode);if(fn)ins[w.toPort]=(ins[w.toPort]||0)+getOut(fn,w.fromPort);}});
  if(n.type==='sum'||n.type==='total')v=ins.reduce(function(s,x){return s+x;},0);
  else if(n.type==='subtract')v=(ins[0]||0)-(ins[1]||0);
  else if(n.type==='multiply')v=(ins[0]||0)*(ins[1]||0);
  else if(n.type==='pct')v=(ins[0]||0)*((ins[1]||0)/100);
  else if(n.type==='profit'&&pi===0)v=(ins[0]||0)-(ins[1]||0);
  else if(n.type==='profit'&&pi===1)v=(ins[0]||0)>0?(((ins[0]||0)-(ins[1]||0))/(ins[0]||1)*100):0;
  else if(n.type==='watch')v=ins[0]||0;
  _comp[n.id]=false;return v;
}
function fC(v){return '$'+v.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});}
function fP(v){return v.toFixed(1)+'%';}
function fV(v,t){return t===PT.P?fP(v):t===PT.C?fC(v):v.toLocaleString();}

// ── Port positions (handles collapsed state) ──
function pPos(nid2,pi,dir){
  var n=find(nid2);if(!n)return{x:0,y:0};
  var el=canvasEl.querySelector('[data-id="'+nid2+'"]');
  if(!el)return{x:n.x,y:n.y+20};
  var nr=el.getBoundingClientRect();
  // Find the correct port: match data-pi and data-dir, prefer visible ones
  var allPorts=el.querySelectorAll('.ng-p[data-dir="'+dir+'"]');
  var port=null;
  allPorts.forEach(function(p){
    var ppi=parseInt(p.getAttribute('data-pi'));
    // Exact match
    if(ppi===pi&&p.getBoundingClientRect().width>0) port=p;
    // Collapsed: only pi=0 is visible, use it for all port indices
    if(n.collapsed&&p.getBoundingClientRect().width>0&&!port) port=p;
  });
  if(port){
    var pr=port.getBoundingClientRect();
    return{x:n.x+(pr.left+pr.width/2-nr.left)/zoom,y:n.y+(pr.top+pr.height/2-nr.top)/zoom};
  }
  // Fallback: edge center
  var w=nr.width/zoom,h=nr.height/zoom;
  return dir==='out'?{x:n.x+w,y:n.y+h/2}:{x:n.x,y:n.y+h/2};
}

// ── Drawing ──
function resize(){wireC.width=wrap.clientWidth;wireC.height=wrap.clientHeight;gridC.width=wrap.clientWidth;gridC.height=wrap.clientHeight;}

function drawGrid(){
  gridCtx.clearRect(0,0,gridC.width,gridC.height);
  var s=SNAP*2*zoom,ox=(panX*zoom)%s,oy=(panY*zoom)%s;
  gridCtx.fillStyle='#161b2a';
  for(var x=ox;x<gridC.width;x+=s)for(var y=oy;y<gridC.height;y+=s)gridCtx.fillRect(x-0.5,y-0.5,1,1);
  var m=s*5,omx=(panX*zoom)%m,omy=(panY*zoom)%m;
  gridCtx.strokeStyle='#141828';gridCtx.lineWidth=1;gridCtx.beginPath();
  for(var x2=omx;x2<gridC.width;x2+=m){gridCtx.moveTo(x2,0);gridCtx.lineTo(x2,gridC.height);}
  for(var y2=omy;y2<gridC.height;y2+=m){gridCtx.moveTo(0,y2);gridCtx.lineTo(gridC.width,y2);}
  gridCtx.stroke();
}

function drawWires(){
  wireCtx.clearRect(0,0,wireC.width,wireC.height);
  wireCtx.save();wireCtx.translate(panX*zoom,panY*zoom);wireCtx.scale(zoom,zoom);
  wires.forEach(function(w){
    var p1=pPos(w.fromNode,w.fromPort,'out'),p2=pPos(w.toNode,w.toPort,'in');
    var tn=find(w.toNode),td=D[tn?tn.type:''],tp=td&&td.ins&&td.ins[w.toPort]?td.ins[w.toPort].t:PT.A;
    var col=WCOL[tp]||'#4f8cff',dx=Math.max(Math.abs(p2.x-p1.x)*0.4,50);
    wireCtx.beginPath();wireCtx.moveTo(p1.x,p1.y);
    wireCtx.bezierCurveTo(p1.x+dx,p1.y,p2.x-dx,p2.y,p2.x,p2.y);
    wireCtx.strokeStyle=col;wireCtx.lineWidth=2.5;wireCtx.shadowColor=col;wireCtx.shadowBlur=4;
    wireCtx.stroke();wireCtx.shadowBlur=0;
  });
  if(wiringFrom&&wireMouse){
    var p1=pPos(wiringFrom.nid,wiringFrom.pi,'out');
    var mx=wireMouse.x/zoom-panX,my=wireMouse.y/zoom-panY;
    var dx=Math.max(Math.abs(mx-p1.x)*0.4,50);
    wireCtx.beginPath();wireCtx.moveTo(p1.x,p1.y);
    wireCtx.bezierCurveTo(p1.x+dx,p1.y,mx-dx,my,mx,my);
    wireCtx.strokeStyle='#4f8cff';wireCtx.lineWidth=2;wireCtx.setLineDash([6,4]);
    wireCtx.stroke();wireCtx.setLineDash([]);
  }
  wireCtx.restore();
}

function renderNodes(){
  // Remove all nodes EXCEPT the one being edited
  canvasEl.querySelectorAll('.ng-node').forEach(function(el){
    if(editingNodeId && el.getAttribute('data-id')===editingNodeId) return;
    el.remove();
  });
  _comp={};
  nodes.forEach(function(n){
    var d=D[n.type];if(!d)return;
    // Skip re-rendering the node being edited
    if(editingNodeId===n.id) return;
    var div=document.createElement('div');
    div.className='ng-node ng-t-'+n.cat+(selN===n.id?' ng-sel':'')+(n.collapsed?' ng-coll':'');
    div.setAttribute('data-id',n.id);
    div.style.left=n.x+'px';div.style.top=n.y+'px';
    var canCollapse=n.type!=='note'&&((d.ins&&d.ins.length)||(d.outs&&d.outs.length>1)||d.edit||d.cat==='unit');
    var h='<div class="ng-hdr"><span class="ng-hi">'+d.icon+'</span><span class="ng-hdr-name">'+n.label+'</span>';
    if(canCollapse)h+='<span class="ng-cbtn" data-coll="'+n.id+'">'+(n.collapsed?'\u25B6':'\u25BC')+'</span>';
    h+='</div>';
    // Ports — inputs on left, outputs on right
    var hasIns=(d.ins&&d.ins.length>0), hasOuts=(d.outs&&d.outs.length>0);
    if(hasIns||hasOuts){
      h+='<div class="ng-ports">';
      var mx=Math.max((d.ins||[]).length,(d.outs||[]).length);
      for(var i=0;i<mx;i++){
        h+='<div class="ng-pr">';
        // Left side: input port
        if(hasIns&&i<d.ins.length){
          var ip=d.ins[i],ic=wires.some(function(w){return w.toNode===n.id&&w.toPort===i;});
          h+='<div class="ng-p ng-pi ng-p-'+ip.t+(ic?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="in" data-type="'+ip.t+'"></div>';
          h+='<span class="ng-pl">'+ip.n+'</span>';
        } else if(hasIns) {
          h+='<span style="width:12px"></span><span></span>';
        }
        // Right side: output port — push to right when no inputs
        if(hasOuts&&i<d.outs.length){
          var op=d.outs[i],oc=wires.some(function(w){return w.fromNode===n.id&&w.fromPort===i;}),ov=getOut(n,i);
          if(!hasIns) h+='<span class="ng-pl" style="flex:1">'+op.n+'</span>';
          h+='<span class="ng-pv">'+fV(ov,op.t)+'</span>';
          h+='<div class="ng-p ng-po ng-p-'+op.t+(oc?' ng-pc':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="out" data-type="'+op.t+'"></div>';
        }
        h+='</div>';
      }
      h+='</div>';
    }
    // Editable value
    if(d.edit)h+='<div class="ng-edit-val"><input type="number" value="'+(n.value||0)+'" data-node="'+n.id+'"/></div>';
    // Building/Phase: show budget and total
    if((n.type==='building'||n.type==='phase')&&n.data){
      var bTotal=getOut(n,0);
      var bCls=bTotal>0?' ng-vp':'';
      h+='<div class="ng-wv'+bCls+'">'+fC(bTotal)+'</div>';
      if(d.showBudget&&n.data.budget)h+='<div style="text-align:center;font-size:9px;color:#5a6078;padding:0 10px 6px;">Budget: '+fC(n.data.budget)+'</div>';
    }
    // Unit cost body
    if(d.cat==='unit')h+='<div class="ng-unit-body"><label>$/'+d.unit+'</label><label>Qty</label><input type="number" value="'+(n.unitPrice||0)+'" data-node="'+n.id+'" data-field="unitPrice" step="0.01"/><input type="number" value="'+(n.qty||0)+'" data-node="'+n.id+'" data-field="qty" step="0.01"/><div class="ng-unit-total">'+fC((n.unitPrice||0)*(n.qty||0))+'</div></div>';
    // Watch display
    if(n.type==='watch'){var wv=getOut(n,0),cls=wv>0?' ng-vp':wv<0?' ng-vn':'';h+='<div class="ng-wv'+cls+'">'+fC(wv)+'</div>';}
    // Sub: show contract and billed
    if(n.type==='sub'&&n.data){h+='<div style="text-align:center;font-size:9px;color:#5a6078;padding:0 10px 6px;">Contract: '+fC(n.data.contractAmt||0)+'</div>';}
    // Sticky note
    if(n.type==='note')h+='<div class="ng-note-body"><textarea data-node="'+n.id+'" placeholder="Type a note...">'+(n.noteText||'')+'</textarea></div>';
    // Collapsed row: port indicators + mini total value
    var hasIns2=(d.ins&&d.ins.length>0),hasOuts2=(d.outs&&d.outs.length>0);
    if(hasIns2||hasOuts2){
      var collVal=hasOuts2?getOut(n,0):0;
      // For watch nodes, get the input value
      if(n.type==='watch'){var wvx=0;wires.forEach(function(w){if(w.toNode===n.id){var fn=find(w.fromNode);if(fn)wvx+=getOut(fn,w.fromPort);}});collVal=wvx;}
      h+='<div class="ng-coll-row">';
      if(hasIns2) h+='<div class="ng-p ng-pi ng-pc ng-p-'+d.ins[0].t+'" data-node="'+n.id+'" data-pi="0" data-dir="in" data-type="'+d.ins[0].t+'"></div>';
      else h+='<span style="width:12px"></span>';
      h+='<span class="ng-coll-val">'+fC(collVal)+'</span>';
      if(hasOuts2) h+='<div class="ng-p ng-po ng-pc ng-p-'+d.outs[0].t+'" data-node="'+n.id+'" data-pi="0" data-dir="out" data-type="'+d.outs[0].t+'"></div>';
      else h+='<span style="width:12px"></span>';
      h+='</div>';
    }
    div.innerHTML=h;
    canvasEl.appendChild(div);
  });
}

function render(){renderNodes();drawGrid();drawWires();saveGraph();var z=document.querySelector('.ng-zoom');if(z)z.textContent=Math.round(zoom*100)+'%';}
function applyTx(){canvasEl.style.transform='translate('+(panX*zoom)+'px,'+(panY*zoom)+'px) scale('+zoom+')';}

// ── Sidebar ──
function buildSidebar(){
  var sb=document.querySelector('.ng-sidebar');if(!sb)return;
  var html='<div class="ng-sidebar-header">Node Library</div>';
  html+='<div class="ng-sidebar-search"><input type="text" placeholder="Search nodes..." id="ngSideSearch"/></div>';
  CATS.forEach(function(cat,ci){
    html+='<div class="ng-cat ng-open" data-cat="'+ci+'">';
    html+='<div class="ng-cat-header"><span class="ng-cat-arrow">\u25B6</span>'+cat.name+'</div>';
    html+='<div class="ng-cat-items">';
    cat.items.forEach(function(k){
      var d=D[k];if(!d)return;
      html+='<div class="ng-cat-item" data-type="'+k+'"><span class="ng-ci-icon">'+d.icon+'</span>'+d.label+'<span class="ng-cat-badge ng-cb-'+d.cat+'">'+d.cat+'</span></div>';
    });
    html+='</div></div>';
  });
  sb.innerHTML=html;
  // Toggle categories
  sb.addEventListener('click',function(e){
    var hdr=e.target.closest('.ng-cat-header');
    if(hdr){hdr.parentElement.classList.toggle('ng-open');return;}
    var item=e.target.closest('.ng-cat-item');
    if(item){
      var type=item.getAttribute('data-type');
      var cx=-panX+wrap.clientWidth/2/zoom,cy=-panY+wrap.clientHeight/2/zoom;
      var label=D[type]?D[type].label:type;
      if(D[type]&&D[type].nameEdit)label=prompt('Name:',label)||label;
      addN(type,cx-85,cy-30,label);render();
    }
  });
  // Search filter
  var searchInp=document.getElementById('ngSideSearch');
  if(searchInp){searchInp.addEventListener('input',function(){
    var q=searchInp.value.toLowerCase();
    sb.querySelectorAll('.ng-cat-item').forEach(function(el){
      var match=el.textContent.toLowerCase().indexOf(q)>-1;
      el.style.display=match?'':'none';
    });
    sb.querySelectorAll('.ng-cat').forEach(function(el){
      var vis=el.querySelectorAll('.ng-cat-item[style=""],.ng-cat-item:not([style])');
      if(q)el.classList.add('ng-open');
    });
  });}
}

// ── Events ──
function initEvents(){
  wrap.addEventListener('mousedown',function(e){
    if(e.target.closest('.ng-p')||e.target.closest('.ng-node'))return;
    isPan=true;wrap.classList.add('ng-panning');
    panSt={x:e.clientX/zoom-panX,y:e.clientY/zoom-panY};
    if(selN){selN=null;render();}
  });
  wrap.addEventListener('mousemove',function(e){
    if(isPan){panX=e.clientX/zoom-panSt.x;panY=e.clientY/zoom-panSt.y;applyTx();drawGrid();drawWires();}
    if(dragN){var n=find(dragN);if(n){n.x=Math.round((e.clientX/zoom-panX-dragOff.x)/SNAP)*SNAP;n.y=Math.round((e.clientY/zoom-panY-dragOff.y)/SNAP)*SNAP;var el=canvasEl.querySelector('[data-id="'+n.id+'"]');if(el){el.style.left=n.x+'px';el.style.top=n.y+'px';}drawWires();}}
    if(wiringFrom){var r=wrap.getBoundingClientRect();wireMouse={x:e.clientX-r.left,y:e.clientY-r.top};drawWires();}
  });
  wrap.addEventListener('mouseup',function(e){
    isPan=false;wrap.classList.remove('ng-panning');dragN=null;
    if(wiringFrom){
      var tp=e.target.closest('.ng-pi');
      if(tp){
        var toId=tp.getAttribute('data-node'),toPort=parseInt(tp.getAttribute('data-pi')),toType=tp.getAttribute('data-type');
        var fn=find(wiringFrom.nid),fd=D[fn?fn.type:''],fromType=fd&&fd.outs[wiringFrom.pi]?fd.outs[wiringFrom.pi].t:PT.A;
        if(toId!==wiringFrom.nid&&canConn(fromType,toType)){
          var dup=wires.some(function(w){return w.fromNode===wiringFrom.nid&&w.fromPort===wiringFrom.pi&&w.toNode===toId&&w.toPort===toPort;});
          if(!dup)wires.push({fromNode:wiringFrom.nid,fromPort:wiringFrom.pi,toNode:toId,toPort:toPort});
        }
      }
      wiringFrom=null;wireMouse=null;render();
    }
  });
  wrap.addEventListener('wheel',function(e){
    e.preventDefault();var f=e.deltaY>0?0.93:1.07,nz=Math.max(0.2,Math.min(3,zoom*f));
    var r=wrap.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    panX=mx/nz-(mx/zoom-panX);panY=my/nz-(my/zoom-panY);zoom=nz;applyTx();render();
  },{passive:false});

  canvasEl.addEventListener('mousedown',function(e){
    var port=e.target.closest('.ng-po');
    if(port){e.stopPropagation();wiringFrom={nid:port.getAttribute('data-node'),pi:parseInt(port.getAttribute('data-pi'))};return;}
    var cb=e.target.closest('.ng-cbtn');
    if(cb){e.stopPropagation();var cn=find(cb.getAttribute('data-coll'));if(cn){cn.collapsed=!cn.collapsed;render();}return;}
    var nel=e.target.closest('.ng-node');
    if(nel&&!e.target.closest('input')&&!e.target.closest('textarea')){
      e.stopPropagation();var nid2=nel.getAttribute('data-id'),n=find(nid2);if(!n)return;
      selN=nid2;dragN=nid2;dragOff={x:e.clientX/zoom-panX-n.x,y:e.clientY/zoom-panY-n.y};render();
    }
  });
  // Track focus for editing — prevents re-render from stealing input
  canvasEl.addEventListener('focusin',function(e){
    var t=e.target;
    if((t.tagName==='INPUT'||t.tagName==='TEXTAREA')&&t.dataset.node) editingNodeId=t.dataset.node;
  });
  canvasEl.addEventListener('focusout',function(e){
    var t=e.target;
    if((t.tagName==='INPUT'||t.tagName==='TEXTAREA')&&t.dataset.node){
      var n=find(t.dataset.node);
      if(n){
        if(t.dataset.field==='unitPrice')n.unitPrice=parseFloat(t.value)||0;
        else if(t.dataset.field==='qty')n.qty=parseFloat(t.value)||0;
        else if(t.tagName==='TEXTAREA')n.noteText=t.value;
        else n.value=parseFloat(t.value)||0;
      }
      editingNodeId=null;
      render();
    }
  });
  // Live update for unit cost totals without full re-render
  canvasEl.addEventListener('input',function(e){
    var t=e.target;
    if(t.tagName==='INPUT'&&t.dataset.node){
      var n=find(t.dataset.node);if(!n)return;
      if(t.dataset.field==='unitPrice')n.unitPrice=parseFloat(t.value)||0;
      else if(t.dataset.field==='qty')n.qty=parseFloat(t.value)||0;
      else n.value=parseFloat(t.value)||0;
      // Update just the unit total display and wires without full re-render
      var el=canvasEl.querySelector('[data-id="'+n.id+'"] .ng-unit-total');
      if(el)el.textContent=fC((n.unitPrice||0)*(n.qty||0));
      drawWires();
    }
    if(t.tagName==='TEXTAREA'&&t.dataset.node){var n2=find(t.dataset.node);if(n2)n2.noteText=t.value;}
  });
  wrap.addEventListener('contextmenu',function(e){
    e.preventDefault();var r=wrap.getBoundingClientRect(),mx=(e.clientX-r.left)/zoom-panX,my=(e.clientY-r.top)/zoom-panY;
    var ci=-1,cd=40;
    wires.forEach(function(w,i){var p1=pPos(w.fromNode,w.fromPort,'out'),p2=pPos(w.toNode,w.toPort,'in');
      for(var t=0;t<=1;t+=0.05){var px=p1.x+(p2.x-p1.x)*t,py=p1.y+(p2.y-p1.y)*t;var dd=Math.sqrt((mx-px)*(mx-px)+(my-py)*(my-py));if(dd<cd){cd=dd;ci=i;}}
    });
    if(ci>=0){wires.splice(ci,1);render();}
  });
  document.addEventListener('keydown',function(e){
    if(!document.getElementById('nodeGraphTab').classList.contains('active'))return;
    if(e.key==='Delete'&&selN&&document.activeElement.tagName!=='INPUT'&&document.activeElement.tagName!=='TEXTAREA'){
      wires=wires.filter(function(w){return w.fromNode!==selN&&w.toNode!==selN;});
      nodes=nodes.filter(function(n){return n.id!==selN;});selN=null;render();
    }
  });
}

// ── Populate job ──
function populate(){
  if(typeof appData==='undefined')return;
  var jid=jobId||(typeof appState!=='undefined'?appState.currentJobId:null);if(!jid)return;
  var job=appData.jobs.find(function(j){return j.id===jid;});if(!job)return;
  var cx=-panX+(wrap?wrap.clientWidth/2/zoom:500),cy=-panY+(wrap?wrap.clientHeight/2/zoom:300);
  var sx=cx-500,sy=cy-200;
  var bldgs=appData.buildings.filter(function(b){return b.jobId===jid;});
  bldgs.forEach(function(b,i){addN('building',sx,sy+i*160,b.name||'Building',b);});
  var phases=appData.phases.filter(function(p){return p.jobId===jid;});
  phases.forEach(function(p,i){var bl=appData.buildings.find(function(b){return b.id===p.buildingId;});addN('phase',sx+220,sy+i*160,(bl?bl.name+'\u203A':'')+p.phase,p);});
  var subs=appData.subs.filter(function(s){return s.jobId===jid;});
  subs.forEach(function(s,i){addN('sub',sx+440,sy+i*120,s.name||'Sub',s);});
  var cos=appData.changeOrders.filter(function(c){return c.jobId===jid;});
  cos.forEach(function(c,i){addN('co',sx+440,sy+subs.length*120+40+i*120,(c.coNumber||'CO')+' '+c.description,c);});
  addN('sum',sx+680,sy,'SUM Costs');
  addN('total',sx+900,sy,'Job Total');
  addN('profit',sx+900,sy+180,'Profit');
  addN('watch',sx+900,sy+360,'Watch');
}

// ── Init ──
function init(){
  var tab=document.getElementById('nodeGraphTab');if(!tab)return;
  wrap=tab.querySelector('.ng-canvas-area');
  canvasEl=tab.querySelector('.ng-canvas');
  wireC=tab.querySelector('.ng-wire-canvas');wireCtx=wireC.getContext('2d');
  gridC=tab.querySelector('.ng-grid-canvas');gridCtx=gridC.getContext('2d');
  buildSidebar();initEvents();applyTx();
  tab.querySelector('.ng-tbtn-close').addEventListener('click',function(){saveGraph();tab.classList.remove('active');});
  var pb=tab.querySelector('.ng-populate-btn');
  if(pb)pb.addEventListener('click',function(){nodes=[];wires=[];nid=1;populate();render();});
}

window.openNodeGraph=function(jid){
  var tab=document.getElementById('nodeGraphTab');if(!tab)return;
  tab.classList.add('active');if(!wrap)init();resize();
  if(jid&&jid!==jobId){
    jobId=jid;nodes=[];wires=[];nid=1;
    if(!loadGraph()){populate();}
    applyTx();render();
  } else if(nodes.length===0){
    jobId=jid||(typeof appState!=='undefined'?appState.currentJobId:null);
    if(!loadGraph()){populate();}
    applyTx();render();
  } else render();
};
})();
