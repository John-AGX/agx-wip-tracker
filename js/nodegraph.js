// ============================================================
// AGX Node Graph v3 — Dynamo-Style Visual Programming
// Multi-port nodes, type matching, collapsible, groups, search
// ============================================================
(function(){
'use strict';

// ── Port types for type matching ──
var PT = { CURRENCY:'currency', PERCENT:'percent', NUMBER:'number', ANY:'any' };
var PORT_WIRE_COLORS = { currency:'#34d399', percent:'#fbbf24', number:'#a78bfa', any:'#4f8cff' };
function canConnect(outType,inType){ return outType===inType||outType===PT.ANY||inType===PT.ANY||outType===PT.NUMBER&&inType===PT.CURRENCY; }

// ── Node definitions ──
var DEFS={
  building:  {cat:'data',  icon:'\u{1F3D7}', label:'Building',  inputs:[], outputs:[{n:'Budget',t:PT.CURRENCY},{n:'Materials',t:PT.CURRENCY},{n:'Labor',t:PT.CURRENCY},{n:'Equipment',t:PT.CURRENCY},{n:'Sub',t:PT.CURRENCY},{n:'Total',t:PT.CURRENCY}]},
  phase:     {cat:'data',  icon:'\u{1F4CB}', label:'Phase',     inputs:[], outputs:[{n:'Materials',t:PT.CURRENCY},{n:'Labor',t:PT.CURRENCY},{n:'Equipment',t:PT.CURRENCY},{n:'Sub',t:PT.CURRENCY},{n:'Total',t:PT.CURRENCY},{n:'% Complete',t:PT.PERCENT}]},
  sub:       {cat:'data',  icon:'\u{1F477}', label:'Sub',       inputs:[], outputs:[{n:'Contract',t:PT.CURRENCY},{n:'Billed',t:PT.CURRENCY},{n:'Remaining',t:PT.CURRENCY}]},
  co:        {cat:'data',  icon:'\u{1F4DD}', label:'Change Order',inputs:[],outputs:[{n:'Income',t:PT.CURRENCY},{n:'Est. Costs',t:PT.CURRENCY}]},
  value:     {cat:'cost',  icon:'\u{1F4B2}', label:'Value',     inputs:[], outputs:[{n:'Value',t:PT.CURRENCY}], editable:true},
  materials: {cat:'cost',  icon:'\u{1F9F1}', label:'Materials',  inputs:[], outputs:[{n:'Amount',t:PT.CURRENCY}], editable:true},
  labor:     {cat:'cost',  icon:'\u{1F6E0}', label:'Labor',      inputs:[], outputs:[{n:'Amount',t:PT.CURRENCY}], editable:true},
  equipment: {cat:'cost',  icon:'\u2699',    label:'Equipment',  inputs:[], outputs:[{n:'Amount',t:PT.CURRENCY}], editable:true},
  gc:        {cat:'cost',  icon:'\u{1F3E2}', label:'Gen. Cond.',  inputs:[], outputs:[{n:'Amount',t:PT.CURRENCY}], editable:true},
  number:    {cat:'cost',  icon:'#',         label:'Number',     inputs:[], outputs:[{n:'Value',t:PT.NUMBER}], editable:true},
  sum:       {cat:'math',  icon:'\u2211',    label:'SUM',        inputs:[{n:'A',t:PT.ANY},{n:'B',t:PT.ANY},{n:'C',t:PT.ANY},{n:'D',t:PT.ANY}], outputs:[{n:'Result',t:PT.CURRENCY}]},
  subtract:  {cat:'math',  icon:'\u2212',    label:'Subtract',   inputs:[{n:'A',t:PT.CURRENCY},{n:'B',t:PT.CURRENCY}], outputs:[{n:'Result',t:PT.CURRENCY}]},
  multiply:  {cat:'math',  icon:'\u00D7',    label:'Multiply',   inputs:[{n:'A',t:PT.ANY},{n:'B',t:PT.NUMBER}], outputs:[{n:'Result',t:PT.CURRENCY}]},
  pct:       {cat:'math',  icon:'%',         label:'Percent',    inputs:[{n:'Value',t:PT.CURRENCY},{n:'Pct',t:PT.PERCENT}], outputs:[{n:'Result',t:PT.CURRENCY}]},
  total:     {cat:'output',icon:'\u{1F4CA}', label:'Total',      inputs:[{n:'Mat',t:PT.CURRENCY},{n:'Lab',t:PT.CURRENCY},{n:'Sub',t:PT.CURRENCY},{n:'Equip',t:PT.CURRENCY},{n:'GC',t:PT.CURRENCY}], outputs:[{n:'Total',t:PT.CURRENCY}]},
  profit:    {cat:'output',icon:'\u{1F4B0}', label:'Profit',     inputs:[{n:'Revenue',t:PT.CURRENCY},{n:'Costs',t:PT.CURRENCY}], outputs:[{n:'Profit',t:PT.CURRENCY},{n:'Margin',t:PT.PERCENT}]},
  watch:     {cat:'watch', icon:'\u{1F441}', label:'Watch',      inputs:[{n:'Value',t:PT.ANY}], outputs:[]},
};

// ── State ──
var nodes=[],wires=[],groups=[],nid=1;
var wrap,canvasEl,wireC,wireCtx,gridC,gridCtx;
var panX=0,panY=0,zoom=1,currentJobId=null;
var dragNode=null,dragOff={x:0,y:0};
var wiringFrom=null,wireMouse=null;
var selNode=null,isPan=false,panSt={x:0,y:0};
var SNAP=15;

function id(){return 'n'+(nid++);}

function addNode(type,x,y,label,data){
  var d=DEFS[type]; if(!d) return null;
  var n={id:id(),type:type,cat:d.cat,x:Math.round(x/SNAP)*SNAP,y:Math.round(y/SNAP)*SNAP,label:label||d.label,data:data||{},value:0,collapsed:false};
  if(data&&data._val!=null) n.value=data._val;
  nodes.push(n); return n;
}

function find(nid){return nodes.find(function(n){return n.id===nid;});}

// ── Value propagation ──
var _computing={};
function getOut(n,pi){
  if(_computing[n.id]) return 0;
  _computing[n.id]=true;
  var d=DEFS[n.type],v=0;
  if(d.editable){v=n.value||0; _computing[n.id]=false; return v;}
  if(n.cat==='data'&&n.data){
    var dd=n.data,outs=d.outputs,lbl=outs[pi]?outs[pi].n:'';
    if(lbl==='Budget')v=dd.budget||0;
    else if(lbl==='Materials')v=dd.materials||0;
    else if(lbl==='Labor')v=dd.labor||0;
    else if(lbl==='Equipment')v=dd.equipment||0;
    else if(lbl==='Sub')v=dd.sub||0;
    else if(lbl==='Contract')v=dd.contractAmt||0;
    else if(lbl==='Billed')v=dd.billedToDate||0;
    else if(lbl==='Remaining')v=(dd.contractAmt||0)-(dd.billedToDate||0);
    else if(lbl==='Income')v=dd.income||0;
    else if(lbl==='Est. Costs')v=dd.estimatedCosts||0;
    else if(lbl==='% Complete')v=dd.pctComplete||0;
    else if(lbl==='Total')v=(dd.materials||0)+(dd.labor||0)+(dd.sub||0)+(dd.equipment||0);
    _computing[n.id]=false; return v;
  }
  // Collect inputs
  var d2=DEFS[n.type],ins=(d2.inputs||[]).map(function(){return 0;});
  wires.forEach(function(w){
    if(w.toNode===n.id){var fn=find(w.fromNode); if(fn) ins[w.toPort]=(ins[w.toPort]||0)+getOut(fn,w.fromPort);}
  });
  if(n.type==='sum'||n.type==='total')v=ins.reduce(function(s,x){return s+x;},0);
  else if(n.type==='subtract')v=(ins[0]||0)-(ins[1]||0);
  else if(n.type==='multiply')v=(ins[0]||0)*(ins[1]||0);
  else if(n.type==='pct')v=(ins[0]||0)*((ins[1]||0)/100);
  else if(n.type==='profit'&&pi===0)v=(ins[0]||0)-(ins[1]||0);
  else if(n.type==='profit'&&pi===1)v=(ins[0]||0)>0?(((ins[0]||0)-(ins[1]||0))/(ins[0]||1)*100):0;
  else if(n.type==='watch')v=ins[0]||0;
  _computing[n.id]=false; return v;
}

function fmtCur(v){return '$'+v.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});}
function fmtPct(v){return v.toFixed(1)+'%';}
function fmtNum(v){return typeof v==='number'?v.toLocaleString():'0';}
function fmtPort(v,t){if(t===PT.PERCENT)return fmtPct(v);if(t===PT.CURRENCY)return fmtCur(v);return fmtNum(v);}

// ── Port positions ──
function portPos(nid2,pi,dir){
  var n=find(nid2); if(!n) return {x:0,y:0};
  var el=canvasEl.querySelector('[data-id="'+nid2+'"]');
  var port=el?el.querySelector('.ng-port[data-pi="'+pi+'"][data-dir="'+dir+'"]'):null;
  if(port&&el){
    var nr=el.getBoundingClientRect(),pr=port.getBoundingClientRect();
    var ox=(pr.left+pr.width/2-nr.left)/zoom, oy=(pr.top+pr.height/2-nr.top)/zoom;
    return {x:n.x+ox,y:n.y+oy};
  }
  // Fallback estimate
  var d=DEFS[n.type],rowH=22,headerH=30;
  if(dir==='out'){
    var elW=el?el.offsetWidth/zoom:180;
    return {x:n.x+elW,y:n.y+headerH+pi*rowH+11};
  }
  return {x:n.x,y:n.y+headerH+pi*rowH+11};
}

// ── Drawing ──
function resizeCanvases(){
  wireC.width=wrap.clientWidth; wireC.height=wrap.clientHeight;
  gridC.width=wrap.clientWidth; gridC.height=wrap.clientHeight;
}

function drawGrid(){
  gridCtx.clearRect(0,0,gridC.width,gridC.height);
  var step=SNAP*2*zoom,ox=(panX*zoom)%step,oy=(panY*zoom)%step;
  gridCtx.fillStyle='#161b2a';
  for(var x=ox;x<gridC.width;x+=step)for(var y=oy;y<gridC.height;y+=step)gridCtx.fillRect(x-0.5,y-0.5,1,1);
  // Major grid
  var major=step*5;
  gridCtx.strokeStyle='#141828'; gridCtx.lineWidth=1;
  var omx=(panX*zoom)%major,omy=(panY*zoom)%major;
  gridCtx.beginPath();
  for(var x2=omx;x2<gridC.width;x2+=major){gridCtx.moveTo(x2,0);gridCtx.lineTo(x2,gridC.height);}
  for(var y2=omy;y2<gridC.height;y2+=major){gridCtx.moveTo(0,y2);gridCtx.lineTo(gridC.width,y2);}
  gridCtx.stroke();
}

function drawWires(){
  wireCtx.clearRect(0,0,wireC.width,wireC.height);
  wireCtx.save();
  wireCtx.translate(panX*zoom,panY*zoom);
  wireCtx.scale(zoom,zoom);

  wires.forEach(function(w){
    var fn=find(w.fromNode);
    var p1=portPos(w.fromNode,w.fromPort,'out'),p2=portPos(w.toNode,w.toPort,'in');
    var tn=find(w.toNode),td=DEFS[tn?tn.type:''],tp=td&&td.inputs&&td.inputs[w.toPort]?td.inputs[w.toPort].t:PT.ANY;
    var color=PORT_WIRE_COLORS[tp]||'#4f8cff';
    var dx=Math.max(Math.abs(p2.x-p1.x)*0.4,50);
    wireCtx.beginPath();
    wireCtx.moveTo(p1.x,p1.y);
    wireCtx.bezierCurveTo(p1.x+dx,p1.y,p2.x-dx,p2.y,p2.x,p2.y);
    wireCtx.strokeStyle=color; wireCtx.lineWidth=2.5;
    wireCtx.shadowColor=color; wireCtx.shadowBlur=4;
    wireCtx.stroke(); wireCtx.shadowBlur=0;
  });

  // Preview wire
  if(wiringFrom&&wireMouse){
    var p1=portPos(wiringFrom.nodeId,wiringFrom.portIndex,'out');
    var mx=(wireMouse.x)/zoom-panX, my=(wireMouse.y)/zoom-panY;
    var dx=Math.max(Math.abs(mx-p1.x)*0.4,50);
    wireCtx.beginPath();
    wireCtx.moveTo(p1.x,p1.y);
    wireCtx.bezierCurveTo(p1.x+dx,p1.y,mx-dx,my,mx,my);
    wireCtx.strokeStyle='#4f8cff'; wireCtx.lineWidth=2; wireCtx.setLineDash([6,4]);
    wireCtx.stroke(); wireCtx.setLineDash([]);
  }
  wireCtx.restore();
}

function renderNodes(){
  canvasEl.querySelectorAll('.ng-node').forEach(function(el){el.remove();});
  _computing={};
  nodes.forEach(function(n){
    var d=DEFS[n.type]; if(!d) return;
    var div=document.createElement('div');
    div.className='ng-node ng-t-'+n.cat+(selNode===n.id?' ng-selected':'')+(n.collapsed?' ng-collapsed':'');
    div.setAttribute('data-id',n.id);
    div.style.left=n.x+'px'; div.style.top=n.y+'px';
    var h='<div class="ng-node-header"><span class="ng-icon">'+d.icon+'</span>'+n.label;
    if(d.inputs.length||d.outputs.length>1) h+='<span class="ng-collapse-btn" data-collapse="'+n.id+'">'+(n.collapsed?'\u25B6':'\u25BC')+'</span>';
    h+='</div>';
    // Ports
    h+='<div class="ng-node-ports">';
    var maxP=Math.max(d.inputs.length,d.outputs.length);
    for(var i=0;i<maxP;i++){
      h+='<div class="ng-port-row">';
      if(i<d.inputs.length){
        var ip=d.inputs[i],ic=wires.some(function(w){return w.toNode===n.id&&w.toPort===i;});
        h+='<div class="ng-port ng-port-in ng-port-'+ip.t+(ic?' ng-connected':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="in" data-type="'+ip.t+'"></div>';
        h+='<span class="ng-port-label">'+ip.n+'</span>';
      } else { h+='<span></span><span></span>'; }
      if(i<d.outputs.length){
        var op=d.outputs[i],oc=wires.some(function(w){return w.fromNode===n.id&&w.fromPort===i;}),ov=getOut(n,i);
        h+='<span class="ng-port-val">'+fmtPort(ov,op.t)+'</span>';
        h+='<div class="ng-port ng-port-out ng-port-'+op.t+(oc?' ng-connected':'')+'" data-node="'+n.id+'" data-pi="'+i+'" data-dir="out" data-type="'+op.t+'"></div>';
      }
      h+='</div>';
    }
    h+='</div>';
    // Editable
    if(d.editable) h+='<div class="ng-edit-val"><input type="number" value="'+(n.value||0)+'" data-node="'+n.id+'"/></div>';
    // Watch display
    if(n.type==='watch'){
      var wv=getOut(n,0),cls=wv>0?' ng-val-pos':wv<0?' ng-val-neg':'';
      h+='<div class="ng-watch-value'+cls+'">'+fmtCur(wv)+'</div>';
    }
    div.innerHTML=h;
    canvasEl.appendChild(div);
  });
}

function render(){renderNodes();drawGrid();drawWires();var z=document.querySelector('.ng-zoom');if(z)z.textContent=Math.round(zoom*100)+'%';}
function applyTx(){canvasEl.style.transform='translate('+(panX*zoom)+'px,'+(panY*zoom)+'px) scale('+zoom+')';}

// ── Events ──
function initEvents(){
  wrap.addEventListener('mousedown',function(e){
    if(e.target.closest('.ng-port')||e.target.closest('.ng-node')) return;
    isPan=true; wrap.classList.add('ng-panning');
    panSt={x:e.clientX/zoom-panX,y:e.clientY/zoom-panY};
    if(selNode){selNode=null;render();}
  });
  wrap.addEventListener('mousemove',function(e){
    if(isPan){panX=e.clientX/zoom-panSt.x;panY=e.clientY/zoom-panSt.y;applyTx();drawGrid();drawWires();}
    if(dragNode){
      var n=find(dragNode); if(!n) return;
      n.x=Math.round((e.clientX/zoom-panX-dragOff.x)/SNAP)*SNAP;
      n.y=Math.round((e.clientY/zoom-panY-dragOff.y)/SNAP)*SNAP;
      var el=canvasEl.querySelector('[data-id="'+n.id+'"]');
      if(el){el.style.left=n.x+'px';el.style.top=n.y+'px';}
      drawWires();
    }
    if(wiringFrom){
      var r=wrap.getBoundingClientRect();
      wireMouse={x:e.clientX-r.left,y:e.clientY-r.top};
      drawWires();
    }
  });
  wrap.addEventListener('mouseup',function(e){
    isPan=false; wrap.classList.remove('ng-panning'); dragNode=null;
    if(wiringFrom){
      var tp=e.target.closest('.ng-port-in');
      if(tp){
        var toId=tp.getAttribute('data-node'),toPort=parseInt(tp.getAttribute('data-pi')),toType=tp.getAttribute('data-type');
        var fromNode=find(wiringFrom.nodeId),fd=DEFS[fromNode?fromNode.type:''],fromType=fd&&fd.outputs[wiringFrom.portIndex]?fd.outputs[wiringFrom.portIndex].t:PT.ANY;
        if(toId!==wiringFrom.nodeId&&canConnect(fromType,toType)){
          var dup=wires.some(function(w){return w.fromNode===wiringFrom.nodeId&&w.fromPort===wiringFrom.portIndex&&w.toNode===toId&&w.toPort===toPort;});
          if(!dup) wires.push({fromNode:wiringFrom.nodeId,fromPort:wiringFrom.portIndex,toNode:toId,toPort:toPort});
        }
      }
      wiringFrom=null;wireMouse=null;render();
    }
  });
  wrap.addEventListener('wheel',function(e){
    e.preventDefault();
    var f=e.deltaY>0?0.93:1.07,nz=Math.max(0.2,Math.min(3,zoom*f));
    var r=wrap.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    panX=mx/nz-(mx/zoom-panX); panY=my/nz-(my/zoom-panY);
    zoom=nz; applyTx(); render();
  },{passive:false});

  canvasEl.addEventListener('mousedown',function(e){
    var port=e.target.closest('.ng-port-out');
    if(port){e.stopPropagation();wiringFrom={nodeId:port.getAttribute('data-node'),portIndex:parseInt(port.getAttribute('data-pi'))};return;}
    var col=e.target.closest('.ng-collapse-btn');
    if(col){e.stopPropagation();var cn=find(col.getAttribute('data-collapse'));if(cn){cn.collapsed=!cn.collapsed;render();}return;}
    var nel=e.target.closest('.ng-node');
    if(nel&&!e.target.closest('input')){
      e.stopPropagation();var nid2=nel.getAttribute('data-id'),n=find(nid2);if(!n)return;
      selNode=nid2;dragNode=nid2;
      dragOff={x:e.clientX/zoom-panX-n.x,y:e.clientY/zoom-panY-n.y};
      render();
    }
  });
  canvasEl.addEventListener('input',function(e){
    if(e.target.tagName==='INPUT'&&e.target.dataset.node){var n=find(e.target.dataset.node);if(n){n.value=parseFloat(e.target.value)||0;render();}}
  });
  wrap.addEventListener('contextmenu',function(e){
    e.preventDefault();
    var r=wrap.getBoundingClientRect(),mx=(e.clientX-r.left)/zoom-panX,my=(e.clientY-r.top)/zoom-panY;
    var ci=-1,cd=40;
    wires.forEach(function(w,i){
      var p1=portPos(w.fromNode,w.fromPort,'out'),p2=portPos(w.toNode,w.toPort,'in');
      for(var t=0;t<=1;t+=0.1){var px=p1.x+(p2.x-p1.x)*t,py=p1.y+(p2.y-p1.y)*t;var dd=Math.sqrt((mx-px)*(mx-px)+(my-py)*(my-py));if(dd<cd){cd=dd;ci=i;}}
    });
    if(ci>=0){wires.splice(ci,1);render();}
  });
  document.addEventListener('keydown',function(e){
    if(!document.getElementById('nodeGraphTab').classList.contains('active'))return;
    if(e.key==='Delete'&&selNode&&document.activeElement.tagName!=='INPUT'){
      wires=wires.filter(function(w){return w.fromNode!==selNode&&w.toNode!==selNode;});
      nodes=nodes.filter(function(n){return n.id!==selNode;});
      selNode=null;render();
    }
  });
}

// ── Search ──
function initSearch(){
  var inp=document.querySelector('.ng-search input');
  var res=document.querySelector('.ng-search-results');
  if(!inp||!res) return;
  inp.addEventListener('input',function(){
    var q=inp.value.toLowerCase().trim();
    if(!q){res.classList.remove('active');return;}
    res.innerHTML='';res.classList.add('active');
    Object.keys(DEFS).forEach(function(k){
      var d=DEFS[k];
      if(d.label.toLowerCase().indexOf(q)===-1&&k.indexOf(q)===-1) return;
      var item=document.createElement('div');item.className='ng-search-item';
      item.innerHTML='<span class="ng-search-cat ng-cat-'+d.cat+'">'+d.cat+'</span>'+d.icon+' '+d.label;
      item.addEventListener('click',function(){
        var cx=-panX+wrap.clientWidth/2/zoom,cy=-panY+wrap.clientHeight/2/zoom;
        addNode(k,cx-90,cy-30);render();
        inp.value='';res.classList.remove('active');
      });
      res.appendChild(item);
    });
    if(!res.children.length){res.innerHTML='<div class="ng-search-item" style="color:#4a5068;">No results</div>';}
  });
  inp.addEventListener('focus',function(){if(inp.value.trim())res.classList.add('active');});
  document.addEventListener('click',function(e){if(!e.target.closest('.ng-search'))res.classList.remove('active');});
}

// ── Populate from job ──
function populate(){
  if(typeof appData==='undefined')return;
  var jid=currentJobId||(typeof appState!=='undefined'?appState.currentJobId:null);
  if(!jid)return;
  var job=appData.jobs.find(function(j){return j.id===jid;});
  if(!job)return;
  var cx=-panX+(wrap?wrap.clientWidth/2/zoom:500),cy=-panY+(wrap?wrap.clientHeight/2/zoom:300);
  var sx=cx-500,sy=cy-200,col1=sx,col2=sx+220,col3=sx+440,col4=sx+700,col5=sx+920;

  // Col 1: Buildings
  var bldgs=appData.buildings.filter(function(b){return b.jobId===jid;});
  bldgs.forEach(function(b,i){addNode('building',col1,sy+i*160,b.name||'Building',b);});

  // Col 2: Phases
  var phases=appData.phases.filter(function(p){return p.jobId===jid;});
  phases.forEach(function(p,i){
    var bl=appData.buildings.find(function(b){return b.id===p.buildingId;});
    addNode('phase',col2,sy+i*160,(bl?bl.name+' \u203A ':'')+p.phase,p);
  });

  // Col 3: Subs & COs
  var subs=appData.subs.filter(function(s){return s.jobId===jid;});
  subs.forEach(function(s,i){addNode('sub',col3,sy+i*120,s.name||'Sub',s);});
  var cos=appData.changeOrders.filter(function(c){return c.jobId===jid;});
  cos.forEach(function(c,i){addNode('co',col3,sy+subs.length*120+40+i*120,(c.coNumber||'CO')+' '+c.description,c);});

  // Col 4: Math
  addNode('sum',col4,sy,'SUM Costs');
  addNode('sum',col4,sy+180,'SUM Revenue');

  // Col 5: Outputs
  addNode('total',col5,sy,'Job Total');
  addNode('profit',col5,sy+180,'Profit');
  addNode('watch',col5,sy+360,'Watch');
}

// ── Init ──
function init(){
  var tab=document.getElementById('nodeGraphTab'); if(!tab)return;
  wrap=tab.querySelector('.ng-canvas-wrap');
  canvasEl=tab.querySelector('.ng-canvas');
  wireC=tab.querySelector('.ng-wire-canvas');
  wireCtx=wireC.getContext('2d');
  gridC=tab.querySelector('.ng-grid-canvas');
  gridCtx=gridC.getContext('2d');
  initEvents();initSearch();applyTx();
  tab.querySelector('.ng-close-btn').addEventListener('click',function(){tab.classList.remove('active');});
  var popBtn=tab.querySelector('.ng-populate-btn');
  if(popBtn) popBtn.addEventListener('click',function(){nodes=[];wires=[];nid=1;populate();render();});
}

window.openNodeGraph=function(jobId){
  var tab=document.getElementById('nodeGraphTab'); if(!tab)return;
  tab.classList.add('active');
  if(!wrap) init();
  resizeCanvases();
  if(jobId&&jobId!==currentJobId){currentJobId=jobId;nodes=[];wires=[];nid=1;populate();render();}
  else if(nodes.length===0){currentJobId=jobId||(typeof appState!=='undefined'?appState.currentJobId:null);populate();render();}
  else render();
};
})();
