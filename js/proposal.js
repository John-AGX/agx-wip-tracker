// ── AGX Estimate Import/Export & Proposal Generator ──

// ── Function Definitions (global scope) ──

function injectImportBtn() {
      const newEstBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('New Estimate'));
      if (!newEstBtn) { setTimeout(injectImportBtn, 500); return; }
      if (document.getElementById('agx-import-btn')) return;
      
      const importBtn = document.createElement('button');
      importBtn.id = 'agx-import-btn';
      importBtn.innerHTML = '\ud83d\udce5 Import xlsx';
      importBtn.style.cssText = 'margin-left:12px;padding:8px 18px;background:#1B8541;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;';
      
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.xlsx,.xls';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        processImportFile(file);
        fileInput.value = '';
      });
      
      importBtn.addEventListener('click', function() { fileInput.click(); });
      newEstBtn.parentElement.appendChild(fileInput);
      newEstBtn.parentElement.insertBefore(importBtn, newEstBtn.nextSibling);
    }

function injectExportBtns() {
      const estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
      const delBtns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.textContent === 'Delete'; });
      delBtns.forEach(function(delBtn, idx) {
        var td = delBtn.parentElement;
        if (!td || td.querySelector('.agx-export-btn')) return;
        var est = estimates[idx];
        if (!est) return;
        var btn = document.createElement('button');
        btn.className = 'agx-export-btn';
        btn.textContent = 'Generate Proposal';
        btn.style.cssText = 'margin-left:6px;padding:5px 12px;background:#1B3A5C;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;';
        btn.addEventListener('click', function() { exportEstimate(est.id); });
        td.appendChild(btn);
      });
    }

function processImportFile(file) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        var parsed = parseReport(rows);
        if (!parsed) { alert('Could not parse this file as an AGX Lead Report.'); return; }
        
        // Save to localStorage
        var estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
        var allLines = JSON.parse(localStorage.getItem('agx-estimate-lines') || '[]');
        estimates.push(parsed.estimate);
        allLines.push.apply(allLines, parsed.lines);
        localStorage.setItem('agx-estimates', JSON.stringify(estimates));
        localStorage.setItem('agx-estimate-lines', JSON.stringify(allLines));
        
        alert('Imported: ' + parsed.estimate.title + ' (' + parsed.lines.length + ' line items)');
        location.reload();
      };
      reader.readAsArrayBuffer(file);
    }

function parseReport(rows) {
      // Verify AGX header
      if (!rows[0] || !String(rows[0][0]).includes('AGX')) return null;
      
      var est = {
        id: 'est_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        title: '', jobType: '', client: '', community: '', propertyAddr: '',
        billingAddr: '', managerName: '', managerEmail: '', managerPhone: '',
        defaultMarkup: 100, scopeOfWork: '', status: 'draft',
        created: new Date().toISOString()
      };
      
      var lines = [];
      var inScope = false;
      var currentSection = '';
      var scopeText = [];
      var foundLineItems = false;
      
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || row.length === 0) continue;
        var a = String(row[0] || '').trim();
        var d = String(row[3] || '').trim();
        
        // Lead info fields
        if (a === 'Title' && d) est.title = d;
        if (a === 'Project Type' && d) est.jobType = d;
        if (a === 'Community' && d) est.community = d;
        if (a === 'Property Address' && d) est.propertyAddr = d;
        if (a === 'Management Co.' && d) est.client = d;
        if (a === 'CAM' && d) est.managerName = d;
        if (a === 'CAM Email' && d) est.managerEmail = d;
        if (a === 'Manager Phone' && d) est.managerPhone = d;
        if (a === 'Billing Address' && d) est.billingAddr = d;
        
        // Scope of work text
        if (a === 'Scope of Work') { inScope = true; continue; }
        if (inScope && a && !a.match(/^SCOPE\s+\d/i) && !a.match(/^Item\s*#/i)) {
          scopeText.push(a);
          continue;
        }
        if (inScope && (a.match(/^SCOPE\s+\d/i) || a.match(/^Item\s*#/i))) {
          inScope = false;
          est.scopeOfWork = scopeText.join('\n');
        }
        
        // Scope/section headers
        if (a.match(/^SCOPE\s+\d/i)) {
          foundLineItems = true;
          continue;
        }
        
        // Column header row - skip
        if (a === 'Item #' || a === 'Item') continue;
        
        // Section headers (text in col A, nothing meaningful in other cols)
        if (foundLineItems && a && !a.match(/^\d/) && (row[2] === '' || row[2] === 0) && (row[4] === '' || row[4] === 0)) {
          // Check if this looks like a section name (not a subtotal row)
          if (!a.match(/subtotal|total|grand|base|client/i)) {
            currentSection = a;
            // Add a section marker line
            lines.push({
              id: 'ln_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
              estimateId: est.id, section: currentSection,
              description: '', qty: 0, unit: 'sqft', unitCost: 0, markup: est.defaultMarkup
            });
            continue;
          }
        }
        
        // Line items (start with number like 1.1, 1.2 etc)
        if (foundLineItems && a.match(/^\d+\.\d+/)) {
          var desc = String(row[1] || '');
          var qty = parseFloat(row[2]) || 0;
          var unit = String(row[3] || 'ea');
          var unitCost = parseFloat(row[4]) || 0;
          var markup = parseFloat(row[5]);
          if (markup > 0 && markup < 1) markup = markup * 100;
          else if (isNaN(markup)) markup = est.defaultMarkup;
          
          lines.push({
            id: 'ln_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            estimateId: est.id, section: currentSection,
            description: desc, qty: qty, unit: unit, unitCost: unitCost, markup: markup
          });
        }
      }
      
      if (!est.title && rows[2]) est.title = String(rows[2][0] || 'Imported Estimate');
      return { estimate: est, lines: lines };
    }

function exportEstimate(estimateId) {
      var estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
      var allLines = JSON.parse(localStorage.getItem('agx-estimate-lines') || '[]');
      var est = estimates.find(function(e) { return e.id === estimateId; });
      if (!est) { alert('Estimate not found'); return; }
      var estLines = allLines.filter(function(l) { return l.estimateId === estimateId; });
      
      var wb = XLSX.utils.book_new();
      var wsData = [];
      
      // Header rows
      wsData.push(['AGX CENTRAL FLORIDA','','','','','','']);
      wsData.push(['Lead Report & Preliminary Estimate','','','','','','']);
      wsData.push([est.title || '','','','','','','']);
      wsData.push(['','','','','','','']);
      wsData.push([]);
      
      // Lead Information
      wsData.push(['Lead Information','','','','','','']);
      wsData.push(['Title','','',est.title || '','','','']);
      wsData.push(['Project Type','','',est.jobType || 'Service & Repair','','','']);
      wsData.push(['Status','','',est.status || 'Open','','','']);
      wsData.push(['Created Date','','',est.created ? new Date(est.created).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : '','','','']);
      wsData.push([]);
      
      // Property Information
      wsData.push(['Property Information','','','','','','']);
      wsData.push(['Community','','',est.community || '','','','']);
      wsData.push(['Property Address','','',est.propertyAddr || '','','','']);
      wsData.push(['Management Co.','','',est.client || '','','','']);
      wsData.push(['CAM','','',est.managerName || '','','','']);
      wsData.push(['CAM Email','','',est.managerEmail || '','','','']);
      wsData.push(['Manager Phone','','',est.managerPhone || '','','','']);
      wsData.push(['Billing Address','','',est.billingAddr || '','','','']);
      wsData.push([]);
      
      // Scope of Work
      wsData.push(['Scope of Work','','','','','','']);
      wsData.push([est.scopeOfWork || '','','','','','','']);
      wsData.push([]);
      
      // Group lines by section
      var sections = [];
      var curSec = null;
      estLines.forEach(function(line) {
        if (line.section && (!curSec || line.section !== curSec.name)) {
          curSec = { name: line.section, items: [] };
          sections.push(curSec);
        }
        if (curSec && line.description) curSec.items.push(line);
      });
      if (sections.length === 0 && estLines.length > 0) {
        sections.push({ name: 'Scope', items: estLines.filter(function(l) { return l.description; }) });
      }
      
      var grandBase = 0, grandClient = 0;
      sections.forEach(function(sec, sIdx) {
        wsData.push(['SCOPE ' + (sIdx+1) + ': ' + sec.name,'','','','','','']);
        wsData.push(['Item #','Description','Qty','Unit','Unit Cost','Markup','Total']);
        var secBase = 0, secClient = 0;
        sec.items.forEach(function(line, lIdx) {
          var mkp = (line.markup != null ? line.markup : 100) / 100;
          var lineBase = (line.qty||0) * (line.unitCost||0);
          var lineTotal = lineBase * (1 + mkp);
          secBase += lineBase;
          secClient += lineTotal;
          wsData.push([(sIdx+1)+'.'+(lIdx+1), line.description, line.qty||0, line.unit||'ea', line.unitCost||0, mkp, lineTotal]);
        });
        wsData.push([]);
        wsData.push(['','','','','','Subtotal (Base):', secBase]);
        wsData.push(['','','','','','Subtotal (Client):', secClient]);
        wsData.push([]);
        grandBase += secBase;
        grandClient += secClient;
      });
      
      wsData.push(['','','','','','GRAND TOTAL (Base):', grandBase]);
      wsData.push(['','','','','','GRAND TOTAL (Client):', grandClient]);
      
      var ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols'] = [{wch:10},{wch:50},{wch:8},{wch:8},{wch:14},{wch:20},{wch:18}];
      ws['!merges'] = [
        {s:{r:0,c:0},e:{r:0,c:6}},{s:{r:1,c:0},e:{r:1,c:6}},
        {s:{r:2,c:0},e:{r:2,c:6}},{s:{r:3,c:0},e:{r:3,c:6}}
      ];
      
      XLSX.utils.book_append_sheet(wb, ws, 'Lead Report');
      XLSX.writeFile(wb, (est.title || 'Estimate') + ' - Lead Report.xlsx');
    }


function downloadBlankTemplate() {
  if (typeof XLSX === 'undefined') { alert('SheetJS still loading, try again in a moment.'); return; }
  
  var wb = XLSX.utils.book_new();
  var rows = [];
  
  // Header
  rows.push(['AGX CENTRAL FLORIDA']);
  rows.push(['Lead Report & Preliminary Estimate']);
  rows.push(['']);
  rows.push(['']);
  
  // Lead Information
  rows.push(['LEAD INFORMATION']);
  rows.push(['Title:', '', '', '']);
  rows.push(['Project Type:', '', '', '']);
  rows.push(['Community:', '', '', '']);
  rows.push(['Lead Source:', '', '', '']);
  rows.push(['']);
  
  // Property Information
  rows.push(['PROPERTY INFORMATION']);
  rows.push(['Property Address:', '', '', '']);
  rows.push(['Billing Address:', '', '', '']);
  rows.push(['Manager Name:', '', '', '']);
  rows.push(['Manager Email:', '', '', '']);
  rows.push(['Manager Phone:', '', '', '']);
  rows.push(['']);
  
  // Scope of Work
  rows.push(['SCOPE OF WORK']);
  rows.push(['']);
  rows.push(['']);
  
  // Line Items Header
  rows.push(['SCOPE / LINE ITEMS']);
  rows.push(['Item #', 'Description', 'Qty', 'Unit', 'Unit Cost', 'Markup %', 'Base Cost', 'Client Cost']);
  
  // Example section with blank rows
  rows.push(['SECTION: General Work']);
  rows.push(['1.1', '', '', '', '', '', '', '']);
  rows.push(['1.2', '', '', '', '', '', '', '']);
  rows.push(['1.3', '', '', '', '', '', '', '']);
  rows.push(['', '', '', '', '', 'Subtotal (Base):', '', '']);
  rows.push(['', '', '', '', '', 'Subtotal (Client):', '', '']);
  rows.push(['']);
  
  // Second blank section
  rows.push(['SECTION: Additional Work']);
  rows.push(['2.1', '', '', '', '', '', '', '']);
  rows.push(['2.2', '', '', '', '', '', '', '']);
  rows.push(['2.3', '', '', '', '', '', '', '']);
  rows.push(['', '', '', '', '', 'Subtotal (Base):', '', '']);
  rows.push(['', '', '', '', '', 'Subtotal (Client):', '', '']);
  rows.push(['']);
  
  // Grand totals
  rows.push(['', '', '', '', '', 'Grand Total (Base):', '', '']);
  rows.push(['', '', '', '', '', 'Grand Total (Client):', '', '']);
  
  var ws = XLSX.utils.aoa_to_sheet(rows);
  
  // Column widths
  ws['!cols'] = [
    {wch: 12}, {wch: 40}, {wch: 8}, {wch: 10}, {wch: 12}, {wch: 18}, {wch: 14}, {wch: 14}
  ];
  
  // Merge header cells
  ws['!merges'] = [
    {s:{r:0,c:0}, e:{r:0,c:7}},
    {s:{r:1,c:0}, e:{r:1,c:7}},
    {s:{r:4,c:0}, e:{r:4,c:7}},
    {s:{r:10,c:0}, e:{r:10,c:7}},
    {s:{r:17,c:0}, e:{r:17,c:7}},
    {s:{r:20,c:0}, e:{r:20,c:7}},
  ];
  
  XLSX.utils.book_append_sheet(wb, ws, 'Lead Report');
  XLSX.writeFile(wb, 'AGX_Blank_Lead_Report_Template.xlsx');
}

function injectTemplateBtn() {
  if (document.getElementById('agx-template-btn')) return;
  var importBtn = document.getElementById('agx-import-btn');
  if (!importBtn) return;
  
  var btn = document.createElement('button');
  btn.id = 'agx-template-btn';
  btn.textContent = '\u{1f4cb} Blank Template';
  btn.style.cssText = 'margin-left:8px;padding:6px 14px;background:#2c5282;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.95em;';
  btn.onclick = function() { downloadBlankTemplate(); };
  importBtn.parentNode.insertBefore(btn, importBtn.nextSibling);
}


// ── SheetJS Loader + Initialization ──
var sheetScript = document.createElement('script');
sheetScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
sheetScript.onload = function() {

    
    // MutationObserver to re-inject export buttons on DOM changes
    var exportObserver = new MutationObserver(function() {
      clearTimeout(window._exportBtnTimer);
      window._exportBtnTimer = setTimeout(injectExportBtns, 200);
    });
    exportObserver.observe(document.body, { childList: true, subtree: true });
    
    injectImportBtn();
  injectTemplateBtn();
    injectExportBtns();

    // ── IMPORT LOGIC ──
    
};
document.head.appendChild(sheetScript);
