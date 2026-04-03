// ============================================================
// AGX WIP Tracker — Workspace Tab Injector
// Dynamically adds the "Workspace" sub-tab to the job detail
// view and initializes the spreadsheet grid when activated.
// Load AFTER app.js + wip.js + workspace.js
// ============================================================
(function(){
'use strict';
let injected=false,wsStylesLoaded=false;

function loadWorkspaceStyles(){
  if(wsStylesLoaded)return;
  const existing=document.querySelector('link[href*="workspace.css"]');
  if(existing){wsStylesLoaded=true;return;}
  const link=document.createElement('link');link.rel='stylesheet';link.href='css/workspace.css';
  document.head.appendChild(link);wsStylesLoaded=true;
}

function injectWorkspaceTab(){
  const subTabBtns=document.querySelectorAll('.sub-tab-btn-job');
  if(subTabBtns.length===0)return false;
  const existing=document.querySelector('.sub-tab-btn-job[data-subtab="job-workspace"]');
  if(existing)return true;
  const btnContainer=subTabBtns[0].parentElement;if(!btnContainer)return false;

  const wsBtn=document.createElement('button');
  wsBtn.className='sub-tab-btn-job';wsBtn.setAttribute('data-subtab','job-workspace');
  wsBtn.innerHTML='Workspace <span style="display:inline-block;width:6px;height:6px;background:#1B8541;border-radius:50%;margin-left:5px;vertical-align:middle;"></span>';
  btnContainer.appendChild(wsBtn);

  const subTabContents=document.querySelectorAll('.sub-tab-content-job');
  if(subTabContents.length===0)return false;
  const contentParent=subTabContents[0].parentElement;if(!contentParent)return false;

  const wsContent=document.createElement('div');
  wsContent.className='sub-tab-content-job';wsContent.id='job-workspace';wsContent.style.display='none';
  wsContent.innerHTML='<div class="card" style="padding:16px;"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;"><div><h3 style="margin:0;color:var(--text,#e4e6f0);font-size:15px;">Workspace <span style="font-size:11px;color:var(--text-dim,#8b90a5);font-weight:400;margin-left:8px;">Excel-style grid &middot; Formulas &middot; Cell&rarr;Job linking</span></h3></div><div style="display:flex;gap:6px;align-items:center;"><span style="font-size:11px;color:var(--text-dim,#8b90a5);cursor:help;" title="Enter: edit cell | Tab: move right | Arrow keys: navigate | =formula (SUM, AVERAGE, MAX, MIN, IF) | Paste from Excel supported">&#9432; Shortcuts</span></div></div><div id="wsWorkspaceContainer" tabindex="0"></div></div>';
  contentParent.appendChild(wsContent);

  wsBtn.addEventListener('click',function(){
    document.querySelectorAll('.sub-tab-btn-job').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.sub-tab-content-job').forEach(p=>p.style.display='none');
    wsBtn.classList.add('active');wsContent.style.display='block';
    const jobId=(typeof appState!=='undefined'&&appState.currentJobId)?appState.currentJobId:null;
    if(jobId&&typeof initWorkspace==='function'){
      initWorkspace('wsWorkspaceContainer',jobId);
      setTimeout(()=>{const c=document.getElementById('wsWorkspaceContainer');if(c)c.focus();},100);
    }
  });
  return true;
}

function observe(){
  loadWorkspaceStyles();
  const observer=new MutationObserver(()=>{
    const subTabs=document.querySelectorAll('.sub-tab-btn-job');
    if(subTabs.length>0&&!injected){injected=injectWorkspaceTab();}
    if(subTabs.length>0){
      const existing=document.querySelector('.sub-tab-btn-job[data-subtab="job-workspace"]');
      if(!existing){injected=false;injectWorkspaceTab();}
    }
  });
  observer.observe(document.body,{childList:true,subtree:true});
  if(document.querySelectorAll('.sub-tab-btn-job').length>0){injected=injectWorkspaceTab();}
}

if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',observe);}else{observe();}
})();