// ============================================================
// AGX WIP Tracker — Workspace Spreadsheet Engine
// Embedded Excel-style grid with formulas & cell->job linking
// ============================================================
(function(){
'use strict';
const MIN_ROWS=8,MIN_COLS=8,EXPAND_BUFFER=2,COL_DEFAULT_WIDTH=100;
let grid={rows:MIN_ROWS,cols:MIN_COLS,cells:{},colWidths:{},selection:null,editing:null,links:{},jobId:null,dirty:false};
let wsContainer=null,wsTable=null,formulaBar=null;

function colLetter(c){let s='',n=c;while(n>=0){s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26)-1;}return s;}
function letterToCol(l){let n=0;for(let i=0;i<l.length;i++){n=n*26+(l.charCodeAt(i)-64);}return n-1;}
function addr(r,c){return colLetter(c)+(r+1);}
function parseAddr(a){const m=a.match(/^([A-Z]+)(\d+)$/i);if(!m)return null;return{r:parseInt(m[2],10)-1,c:letterToCol(m[1].toUpperCase())};}
function getCell(r,c){const key=addr(r,c);if(!grid.cells[key])grid.cells[key]={raw:'',value:'',fmt:null};return grid.cells[key];}

function displayVal(cell){
  if(cell.value===''||cell.value===null||cell.value===undefined)return'';
  if(cell.error)return cell.error;
  if(typeof cell.value==='number'){
    if(cell.fmt==='currency')return'$'+cell.value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    if(cell.fmt==='percent')return(cell.value*100).toFixed(1)+'%';
    if(Number.isFinite(cell.value)&&!Number.isInteger(cell.value))return cell.value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    return cell.value.toLocaleString('en-US');
  }
  return String(cell.value);
}

function evaluate(raw){
  if(typeof raw!=='string'||!raw.startsWith('='))
  {if(raw===''||raw===null||raw===undefined)return'';const n=Number(raw);return isNaN(n)?raw:n;}
  const expr=raw.substring(1);
  try{
    let r2=expr.replace(/SUM\(([A-Z]+\d+):([A-Z]+\d+)\)/gi,(m,s1,e1)=>{
      const s=parseAddr(s1.toUpperCase()),e=parseAddr(e1.toUpperCase());if(!s||!e)return'0';
      let t=0;for(let r=Math.min(s.r,e.r);r<=Math.max(s.r,e.r);r++)for(let c=Math.min(s.c,e.c);c<=Math.max(s.c,e.c);c++){const v=getCell(r,c).value;if(typeof v==='number')t+=v;}return t;
    });
    r2=r2.replace(/AVERAGE\(([A-Z]+\d+):([A-Z]+\d+)\)/gi,(m,s1,e1)=>{
      const s=parseAddr(s1.toUpperCase()),e=parseAddr(e1.toUpperCase());if(!s||!e)return'0';
      let t=0,cnt=0;for(let r=Math.min(s.r,e.r);r<=Math.max(s.r,e.r);r++)for(let c=Math.min(s.c,e.c);c<=Math.max(s.c,e.c);c++){const v=getCell(r,c).value;if(typeof v==='number'){t+=v;cnt++;}}return cnt>0?t/cnt:0;
    });
    r2=r2.replace(/MAX\(([A-Z]+\d+):([A-Z]+\d+)\)/gi,(m,s1,e1)=>{
      const s=parseAddr(s1.toUpperCase()),e=parseAddr(e1.toUpperCase());if(!s||!e)return'0';
      let mx=-Infinity;for(let r=Math.min(s.r,e.r);r<=Math.max(s.r,e.r);r++)for(let c=Math.min(s.c,e.c);c<=Math.max(s.c,e.c);c++){const v=getCell(r,c).value;if(typeof v==='number'&&v>mx)mx=v;}return mx===-Infinity?0:mx;
    });
    r2=r2.replace(/MIN\(([A-Z]+\d+):([A-Z]+\d+)\)/gi,(m,s1,e1)=>{
      const s=parseAddr(s1.toUpperCase()),e=parseAddr(e1.toUpperCase());if(!s||!e)return'0';
      let mn=Infinity;for(let r=Math.min(s.r,e.r);r<=Math.max(s.r,e.r);r++)for(let c=Math.min(s.c,e.c);c<=Math.max(s.c,e.c);c++){const v=getCell(r,c).value;if(typeof v==='number'&&v<mn)mn=v;}return mn===Infinity?0:mn;
    });
    r2=r2.replace(/COUNT\(([A-Z]+\d+):([A-Z]+\d+)\)/gi,(m,s1,e1)=>{
      const s=parseAddr(s1.toUpperCase()),e=parseAddr(e1.toUpperCase());if(!s||!e)return'0';
      let cnt=0;for(let r=Math.min(s.r,e.r);r<=Math.max(s.r,e.r);r++)for(let c=Math.min(s.c,e.c);c<=Math.max(s.c,e.c);c++){const v=getCell(r,c).value;if(typeof v==='number')cnt++;}return cnt;
    });
    r2=r2.replace(/IF\((.+?),(.+?),(.+?)\)/gi,(m,cond,tV,fV)=>{
      try{return Function('"use strict";return('+cond.trim()+')?('+tV.trim()+'):('+fV.trim()+')')();}catch(e){return'#ERR';}
    });
    r2=r2.replace(/\b([A-Z]+)(\d+)\b/gi,(match)=>{
      const ref=parseAddr(match.toUpperCase());if(!ref)return'0';const v=getCell(ref.r,ref.c).value;
      return(typeof v==='number')?v:(v===''?'0':JSON.stringify(v));
    });
    const result=Function('"use strict";return('+r2+')')();
    return(typeof result==='number'&&!isFinite(result))?'#DIV/0!':result;
  }catch(e){return'#ERR';}
}

function recalcAll(){for(let p=0;p<3;p++)Object.keys(grid.cells).forEach(k=>{const c=grid.cells[k],r=evaluate(c.raw);if(typeof r==='string'&&(r==='#ERR'||r==='#DIV/0!')){c.value=r;c.error=r;}else{c.value=r;c.error=null;}});}

const LINKABLE_FIELDS=[
  {key:'contractAmount',label:'Contract (As Sold)',fmt:'currency'},
  {key:'estimatedCosts',label:'Est. Costs (As Sold)',fmt:'currency'},
  {key:'targetMarginPct',label:'Target Margin %',fmt:'percent'},
  {key:'pctComplete',label:'% Complete',fmt:'percent'},
  {key:'invoicedToDate',label:'Invoiced to Date',fmt:'currency'},
  {key:'revisedCostChanges',label:'Revised Cost Changes',fmt:'currency'}
];

function pushLinkedValues(){
  if(!grid.jobId||typeof appData==='undefined')return;
  const job=appData.jobs.find(j=>j.id===grid.jobId);if(!job)return;
  let changed=false;
  Object.entries(grid.links).forEach(([ca,fk])=>{
    const ref=parseAddr(ca);if(!ref)return;
    const cell=getCell(ref.r,ref.c);
    if(typeof cell.value==='number'){job[fk]=cell.value;changed=true;}
  });
  if(changed&&typeof saveData==='function')saveData();
}

function saveWorkspace(){
  if(!grid.jobId)return;
  const d={rows:grid.rows,cols:grid.cols,cells:grid.cells,colWidths:grid.colWidths,links:grid.links};
  const all=JSON.parse(localStorage.getItem('agx-workspaces')||'{}');
  all[grid.jobId]=d;localStorage.setItem('agx-workspaces',JSON.stringify(all));grid.dirty=false;
}

function loadWorkspace(jobId){
  const all=JSON.parse(localStorage.getItem('agx-workspaces')||'{}');const s=all[jobId];
  if(s){grid.rows=Math.max(s.rows||MIN_ROWS,MIN_ROWS);grid.cols=Math.max(s.cols||MIN_COLS,MIN_COLS);grid.cells=s.cells||{};grid.colWidths=s.colWidths||{};grid.links=s.links||{};}
  else{grid.rows=MIN_ROWS;grid.cols=MIN_COLS;grid.cells={};grid.colWidths={};grid.links={};}
  grid.jobId=jobId;grid.selection=null;grid.editing=null;grid.dirty=false;recalcAll();
}

function renderGrid(){
  if(!wsTable)return;
  let h='<thead><tr><th class="ws-corner"></th>';
  for(let c=0;c<grid.cols;c++){const w=grid.colWidths[c]||COL_DEFAULT_WIDTH;h+='<th class="ws-col-header" data-col="'+c+'" style="width:'+w+'px;min-width:'+w+'px;">'+colLetter(c)+'</th>';}
  h+='</tr></thead><tbody>';
  for(let r=0;r<grid.rows;r++){
    h+='<tr><td class="ws-row-header">'+(r+1)+'</td>';
    for(let c=0;c<grid.cols;c++){
      const key=addr(r,c),cell=grid.cells[key]||{raw:'',value:'',fmt:null},val=displayVal(cell);
      let cls='ws-cell';
      if(grid.selection&&grid.selection.r===r&&grid.selection.c===c)cls+=' ws-selected';
      if(grid.links[key])cls+=' ws-linked';
      if(cell.error)cls+=' ws-error';
      if(typeof cell.value==='number')cls+=' ws-number';
      const w=grid.colWidths[c]||COL_DEFAULT_WIDTH;
      h+='<td class="'+cls+'" data-r="'+r+'" data-c="'+c+'" style="width:'+w+'px;min-width:'+w+'px;">'+val+'</td>';
    }h+='</tr>';
  }h+='</tbody>';wsTable.innerHTML=h;
}

function selectCell(r,c){
  const prev=grid.selection;grid.selection={r,c};
  if(prev){const pt=wsTable.querySelector('td[data-r="'+prev.r+'"][data-c="'+prev.c+'"]');if(pt)pt.classList.remove('ws-selected');}
  const td=wsTable.querySelector('td[data-r="'+r+'"][data-c="'+c+'"]');if(td)td.classList.add('ws-selected');
  const key=addr(r,c);
  if(formulaBar)formulaBar.value=getCell(r,c).raw||'';
  const re=document.getElementById('wsCellRef');if(re)re.textContent=key;
  const el=document.getElementById('wsQuickCalc');
  if(el){const nums=[];Object.values(grid.cells).forEach(c=>{if(typeof c.value==='number')nums.push(c.value);});
  if(nums.length>1){const sum=nums.reduce((a,b)=>a+b,0);el.textContent='SUM: '+sum.toFixed(2)+' | AVG: '+(sum/nums.length).toFixed(2)+' | COUNT: '+nums.length;}else el.textContent='';}
  updateLinkPanel(key);
}

function updateLinkPanel(cellAddr){
  const panel=document.getElementById('wsLinkPanel'),cellLabel=document.getElementById('wsLinkCell'),activeEl=document.getElementById('wsLinkActive'),unlinkBtn=document.getElementById('wsUnlinkBtn');
  if(!panel)return;if(cellLabel)cellLabel.textContent=cellAddr;
  const currentLink=grid.links[cellAddr];
  if(currentLink){const field=LINKABLE_FIELDS.find(f=>f.key===currentLink);
    if(activeEl){activeEl.innerHTML='<span class="ws-link-badge">-> '+(field?field.label:currentLink)+'</span>';activeEl.style.display='block';}
    if(unlinkBtn)unlinkBtn.style.display='inline-block';
  }else{if(activeEl)activeEl.style.display='none';if(unlinkBtn)unlinkBtn.style.display='none';}
}

function startEditing(r,c){
  grid.editing={r,c};const td=wsTable.querySelector('td[data-r="'+r+'"][data-c="'+c+'"]');if(!td)return;
  const cell=getCell(r,c);td.classList.add('ws-editing');td.contentEditable=true;td.textContent=cell.raw||'';td.focus();
  const range=document.createRange(),sel=window.getSelection();range.selectNodeContents(td);range.collapse(false);sel.removeAllRanges();sel.addRange(range);
}

function commitEdit(r,c){
  const td=wsTable.querySelector('td[data-r="'+r+'"][data-c="'+c+'"]');if(!td)return;
  getCell(r,c).raw=td.textContent.trim();td.contentEditable=false;td.classList.remove('ws-editing');
  grid.editing=null;grid.dirty=true;recalcAll();renderGrid();selectCell(r,c);pushLinkedValues();
  if(r>=grid.rows-1){grid.rows+=EXPAND_BUFFER;renderGrid();}
  if(c>=grid.cols-1){grid.cols+=EXPAND_BUFFER;renderGrid();}
  saveWorkspace();
}

function cancelEdit(){
  if(!grid.editing)return;const{r,c}=grid.editing;
  const td=wsTable.querySelector('td[data-r="'+r+'"][data-c="'+c+'"]');
  if(td){td.contentEditable=false;td.classList.remove('ws-editing');td.textContent=displayVal(getCell(r,c));}grid.editing=null;
}

let resizing=null;
function handleColResizeStart(e){
  if(!e.target.classList.contains('ws-col-header'))return;
  const rect=e.target.getBoundingClientRect();
  if(e.clientX>rect.right-6){e.preventDefault();
    resizing={col:parseInt(e.target.dataset.col),startX:e.clientX,startWidth:grid.colWidths[e.target.dataset.col]||COL_DEFAULT_WIDTH};
    document.body.style.cursor='col-resize';}
}
function handleColResizeMove(e){
  if(!resizing)return;const nw=Math.max(40,resizing.startWidth+(e.clientX-resizing.startX));grid.colWidths[resizing.col]=nw;
  const th=wsTable.querySelector('th[data-col="'+resizing.col+'"]');if(th){th.style.width=nw+'px';th.style.minWidth=nw+'px';}
  wsTable.querySelectorAll('td[data-c="'+resizing.col+'"]').forEach(td=>{td.style.width=nw+'px';td.style.minWidth=nw+'px';});
}
function handleColResizeEnd(){if(resizing){resizing=null;document.body.style.cursor='';saveWorkspace();}}

window.initWorkspace=function(containerId,jobId){
  wsContainer=document.getElementById(containerId);if(!wsContainer)return;loadWorkspace(jobId);
  wsContainer.innerHTML='<div class="ws-toolbar"><div class="ws-cell-ref" id="wsCellRef">A1</div><input type="text" class="ws-formula-bar" id="wsFormulaBar" placeholder="Enter value or formula (e.g. =A1+B1)" spellcheck="false"/><div class="ws-toolbar-actions"><button class="ws-btn ws-btn-fmt" data-fmt="currency" title="Currency">$</button><button class="ws-btn ws-btn-fmt" data-fmt="percent" title="Percent">%</button><button class="ws-btn ws-btn-fmt" data-fmt="null" title="Clear format">x</button><span class="ws-separator"></span><button class="ws-btn" id="wsLinkBtn" title="Link cell to job field">Link</button><button class="ws-btn" id="wsClearBtn" title="Clear workspace">Clear</button><button class="ws-btn ws-btn-save" id="wsSaveBtn" title="Save">Save</button></div></div><div class="ws-link-panel" id="wsLinkPanel" style="display:none;"><div class="ws-link-title">Link <span id="wsLinkCell">A1</span> -> Job Field</div><div class="ws-link-options" id="wsLinkOptions"></div><div class="ws-link-active" id="wsLinkActive"></div><button class="ws-btn" id="wsUnlinkBtn" style="display:none;color:#f87171;">Unlink</button></div><div class="ws-grid-wrapper" id="wsGridWrapper"><table class="ws-grid" id="wsGrid"></table></div><div class="ws-statusbar"><span id="wsStatus">Ready</span><span id="wsQuickCalc"></span></div>';
  wsTable=document.getElementById('wsGrid');formulaBar=document.getElementById('wsFormulaBar');renderGrid();selectCell(0,0);
  wsTable.addEventListener('click',e=>{const td=e.target.closest('td.ws-cell');if(!td)return;if(grid.editing)commitEdit(grid.editing.r,grid.editing.c);selectCell(parseInt(td.dataset.r),parseInt(td.dataset.c));});
  wsTable.addEventListener('dblclick',e=>{const td=e.target.closest('td.ws-cell');if(!td)return;startEditing(parseInt(td.dataset.r),parseInt(td.dataset.c));});
  wsTable.addEventListener('mousedown',handleColResizeStart);document.addEventListener('mousemove',handleColResizeMove);document.addEventListener('mouseup',handleColResizeEnd);
  wsContainer.addEventListener('keydown',e=>{
    if(grid.editing){if(e.key==='Enter'){e.preventDefault();commitEdit(grid.editing.r,grid.editing.c);if(grid.selection.r<grid.rows-1)selectCell(grid.selection.r+1,grid.selection.c);}else if(e.key==='Tab'){e.preventDefault();commitEdit(grid.editing.r,grid.editing.c);if(grid.selection.c<grid.cols-1)selectCell(grid.selection.r,grid.selection.c+1);}else if(e.key==='Escape'){e.preventDefault();cancelEdit();}return;}
    if(document.activeElement===formulaBar){if(e.key==='Enter'){e.preventDefault();if(grid.selection){getCell(grid.selection.r,grid.selection.c).raw=formulaBar.value.trim();grid.dirty=true;recalcAll();renderGrid();selectCell(grid.selection.r,grid.selection.c);pushLinkedValues();saveWorkspace();}}return;}
    if(!grid.selection)return;const{r,c}=grid.selection;
    if(e.key==='ArrowUp'){e.preventDefault();if(r>0)selectCell(r-1,c);}
    else if(e.key==='ArrowDown'){e.preventDefault();if(r<grid.rows-1)selectCell(r+1,c);else{grid.rows+=EXPAND_BUFFER;renderGrid();selectCell(r+1,c);}}
    else if(e.key==='ArrowLeft'){e.preventDefault();if(c>0)selectCell(r,c-1);}
    else if(e.key==='ArrowRight'){e.preventDefault();if(c<grid.cols-1)selectCell(r,c+1);else{grid.cols+=EXPAND_BUFFER;renderGrid();selectCell(r,c+1);}}
    else if(e.key==='Enter'||e.key==='F2'){e.preventDefault();startEditing(r,c);}
    else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();const cl=getCell(r,c);cl.raw='';cl.value='';cl.error=null;recalcAll();renderGrid();selectCell(r,c);pushLinkedValues();saveWorkspace();}
    else if(e.key==='Tab'){e.preventDefault();if(e.shiftKey){if(c>0)selectCell(r,c-1);}else{if(c<grid.cols-1)selectCell(r,c+1);else{grid.cols+=EXPAND_BUFFER;renderGrid();selectCell(r,c+1);}}}
    else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){startEditing(r,c);const td=wsTable.querySelector('td[data-r="'+r+'"][data-c="'+c+'"]');if(td)td.textContent=e.key;}
  });
  document.getElementById('wsSaveBtn').addEventListener('click',()=>{saveWorkspace();const s=document.getElementById('wsStatus');if(s){s.textContent='Saved';setTimeout(()=>s.textContent='Ready',2000);}});
  document.getElementById('wsClearBtn').addEventListener('click',()=>{if(confirm('Clear all workspace data? This cannot be undone.')){grid.cells={};grid.links={};grid.rows=MIN_ROWS;grid.cols=MIN_COLS;grid.colWidths={};saveWorkspace();renderGrid();selectCell(0,0);}});
  document.getElementById('wsLinkBtn').addEventListener('click',()=>{const p=document.getElementById('wsLinkPanel');if(p.style.display==='none'){p.style.display='flex';const ca=addr(grid.selection.r,grid.selection.c);document.getElementById('wsLinkCell').textContent=ca;let h='';LINKABLE_FIELDS.forEach(f=>{const a=grid.links[ca]===f.key;h+='<button class="ws-link-opt '+(a?'active':'')+'" data-field="'+f.key+'">'+f.label+'</button>';});document.getElementById('wsLinkOptions').innerHTML=h;}else p.style.display='none';});
  document.getElementById('wsLinkOptions').addEventListener('click',e=>{const b=e.target.closest('.ws-link-opt');if(!b||!grid.selection)return;const fk=b.dataset.field,ca=addr(grid.selection.r,grid.selection.c);Object.entries(grid.links).forEach(([k,v])=>{if(v===fk)delete grid.links[k];});grid.links[ca]=fk;const f=LINKABLE_FIELDS.find(x=>x.key===fk);if(f)getCell(grid.selection.r,grid.selection.c).fmt=f.fmt;saveWorkspace();recalcAll();renderGrid();selectCell(grid.selection.r,grid.selection.c);pushLinkedValues();});
  document.getElementById('wsUnlinkBtn').addEventListener('click',()=>{if(!grid.selection)return;delete grid.links[addr(grid.selection.r,grid.selection.c)];saveWorkspace();renderGrid();selectCell(grid.selection.r,grid.selection.c);});
  wsContainer.querySelectorAll('.ws-btn-fmt').forEach(b=>{b.addEventListener('click',()=>{if(!grid.selection)return;const cell=getCell(grid.selection.r,grid.selection.c);cell.fmt=b.dataset.fmt==='null'?null:b.dataset.fmt;recalcAll();renderGrid();selectCell(grid.selection.r,grid.selection.c);saveWorkspace();});});
  wsContainer.addEventListener('paste',e=>{if(!grid.selection||grid.editing)return;e.preventDefault();const t=e.clipboardData.getData('text/plain');if(!t)return;const rows=t.split('\n').map(r=>r.split('\t'));const sR=grid.selection.r,sC=grid.selection.c;rows.forEach((row,ri)=>{row.forEach((val,ci)=>{const r=sR+ri,c=sC+ci;if(r>=grid.rows)grid.rows=r+EXPAND_BUFFER;if(c>=grid.cols)grid.cols=c+EXPAND_BUFFER;getCell(r,c).raw=val.trim();});});recalcAll();renderGrid();selectCell(sR,sC);pushLinkedValues();saveWorkspace();});
};
window.workspaceGrid=grid;
})();