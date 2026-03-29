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
    var estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
    var delBtns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.textContent === 'Delete'; });
    delBtns.forEach(function(delBtn, idx) {
      if (idx >= estimates.length) return;
      var cell = delBtn.parentNode;
      if (!cell) return;
      if (cell.querySelector('.agx-proposal-btn')) return;
      var estId = estimates[idx].id;
      var propBtn = document.createElement('button');
      propBtn.className = 'agx-proposal-btn';
      propBtn.textContent = 'Generate Proposal';
      propBtn.style.cssText = 'margin-left:6px;padding:4px 10px;background:#1B8541;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.85em;';
      propBtn.onclick = function() { generateProposal(estId); };
      cell.appendChild(propBtn);
      var expBtn = document.createElement('button');
      expBtn.className = 'agx-proposal-btn';
      expBtn.textContent = 'Export Estimate';
      expBtn.style.cssText = 'margin-left:6px;padding:4px 10px;background:#1B3A5C;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.85em;';
      expBtn.onclick = function() { exportEstimate(estId); };
      cell.appendChild(expBtn);
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



function generateProposal(estimateId) {
  var estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
  var lines = JSON.parse(localStorage.getItem('agx-estimate-lines') || '[]');
  var est = estimates.find(function(e) { return e.id === estimateId; });
  if (!est) { alert('Estimate not found'); return; }
  var estLines = lines.filter(function(l) { return l.estimateId === estimateId; });
  
  // Group lines by section
  var sections = [];
  var sectionMap = {};
  estLines.forEach(function(line) {
    var sec = line.section || 'General';
    if (!sectionMap[sec]) {
      sectionMap[sec] = [];
      sections.push(sec);
    }
    sectionMap[sec].push(line);
  });
  
  // Calculate total client price
  var totalPrice = 0;
  estLines.forEach(function(line) {
    var base = (parseFloat(line.qty) || 0) * (parseFloat(line.unitCost) || 0);
    var markup = parseFloat(line.markup) || parseFloat(est.defaultMarkup) || 0;
    totalPrice += base * (1 + markup / 100);
  });
  
  // Format currency
  var priceStr = '$' + totalPrice.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  
  // Build date
  var now = new Date();
  var dateStr = (now.getMonth()+1) + '-' + now.getDate() + '-' + now.getFullYear();
  
  // Derive greeting - use client name first word + "Team"
  var clientFirst = (est.client || 'Team').split(' ')[0].split('-')[0].trim();
  var greeting = 'Dear ' + clientFirst + ' Team,';

  // Build scope sections HTML
  var scopeHtml = '';
  sections.forEach(function(secName, idx) {
    var secLabel = 'A' + (idx + 1) + '. ' + secName;
    scopeHtml += '<p style="margin:18px 0 6px;font-weight:500;">' + secLabel + '</p>';
    sectionMap[secName].forEach(function(line) {
      if (line.description && line.description.trim()) {
        scopeHtml += '<p style="margin:2px 0 2px 20px;">- ' + line.description + '</p>';
      }
    });
  });
  
  // If there's also a scopeOfWork text, add it before the sections
  var scopeIntro = '';
  if (est.scopeOfWork && est.scopeOfWork.trim()) {
    scopeIntro = '<p style="margin:0 0 12px;">' + est.scopeOfWork.replace(/\n/g, '<br>') + '</p>';
  }

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">';
  html += '<title>Proposal for ' + (est.community || '') + ' - ' + (est.title || '') + '</title>';
  html += '<style>';
  html += 'body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#222;max-width:800px;margin:0 auto;padding:40px 50px;line-height:1.5;}';
  html += '.header{text-align:center;margin-bottom:20px;}';
  html += '.logo-text{font-size:32pt;font-weight:900;color:#1a1a2e;letter-spacing:3px;margin:0;}';
  html += '.logo-sub{font-size:9pt;letter-spacing:8px;color:#555;margin:0 0 10px;}';
  html += '.addr-line{text-align:center;font-size:9pt;color:#555;margin:8px 0 20px;}';
  html += '.info-row{display:flex;justify-content:space-between;margin:10px 0;}';
  html += '.info-left{text-align:left;} .info-right{text-align:right;}';
  html += '.proposal-title{font-size:15pt;font-weight:700;margin:24px 0 16px;}';
  html += '.greeting{font-weight:700;margin:16px 0;}';
  html += 'hr{border:none;border-top:1.5px solid #ccc;margin:24px 0;}';
  html += '.scope-heading{font-size:13pt;font-weight:700;margin:20px 0 8px;}';
  html += '.total-price{text-align:right;font-size:15pt;font-weight:700;margin:30px 0 20px;}';
  html += '.assumptions-title{font-weight:700;font-style:italic;text-decoration:underline;margin:20px 0 10px;}';
  html += '.assumptions ol{padding-left:20px;} .assumptions li{margin:8px 0;font-size:10pt;}';
  html += '.assumptions li ul{list-style:disc;margin:6px 0;} .assumptions li ul li{margin:4px 0;}';
  html += '.sig-block{margin-top:40px;font-size:10pt;}';
  html += '.sig-line{display:flex;align-items:center;margin:20px 0;} .sig-label{font-weight:700;width:100px;} .sig-rule{flex:1;border-bottom:1px solid #000;margin-left:10px;}';
  html += '@media print{body{padding:20px 40px;} @page{margin:0.75in;}}';
  html += '</style></head><body>';

  // Logo header
  html += '<div class="header">';
  html += '<p class="logo-text">AGX</p>';
  html += '<p class="logo-sub">A G &nbsp; E X T E R I O R S</p>';
  html += '</div>';
  html += '<p class="addr-line">13191 56th Court, Ste 102 &nbsp;&middot;&nbsp; Clearwater, FL 33760-4030 &nbsp;&middot;&nbsp; Phone: 813-725-5233</p>';
  
  // Client info row
  html += '<div class="info-row"><div class="info-left">';
  html += '<p style="margin:2px 0;">' + (est.client || '') + (est.community ? ' - ' + est.community : '') + '</p>';
  if (est.managerPhone) html += '<p style="margin:2px 0;">Phone: ' + est.managerPhone + '</p>';
  html += '<br>';
  if (est.billingAddr) html += '<p style="margin:2px 0;">' + est.billingAddr.replace(/\n/g, '<br>') + '</p>';
  html += '</div><div class="info-right">';
  if (est.propertyAddr) {
    html += '<p style="margin:2px 0;">Job Address:</p>';
    html += '<p style="margin:2px 0;">' + est.propertyAddr.replace(/\n/g, '<br>') + '</p>';
  }
  html += '<p style="margin:8px 0 2px;"><strong>Print Date:</strong> &nbsp; ' + dateStr + '</p>';
  html += '</div></div>';
  
  // Proposal title
  html += '<p class="proposal-title">Proposal for ' + (est.community || '') + ' - ' + (est.title || '') + '</p>';
  
  // Greeting
  html += '<p class="greeting">' + greeting + '</p>';
  
  // Intro paragraph with bold placeholders
  var issueText = est.title || 'the requested work';
  var communityText = est.community || 'your';
  html += '<p>AG Exteriors is pleased to provide you with a proposal to complete the <strong>' + issueText + '</strong> needed by the <strong>' + communityText + '</strong> community.</p>';
  
  // Boilerplate
  html += '<p>We proudly specialize in a wide range of exterior services, including roofing, siding, painting, deck rebuilding, and more\u2014delivering each with care and attention to detail. Backed by our leadership team with extensive experience in construction, development, and property management. AG Exteriors is committed to bringing a thoughtful, professional approach to every project. With this foundation, we\u2019re committed to providing high-quality work and dependable service on every project.</p>';

  // Scope of Work
  html += '<hr>';
  html += '<p class="scope-heading">Scope of Work</p>';
  html += scopeIntro;
  html += scopeHtml;
  
  // Total Price
  html += '<hr>';
  html += '<p class="total-price">Total Price: &nbsp; ' + priceStr + '</p>';
  
  // Assumptions
  html += '<div class="assumptions">';
  html += '<p class="assumptions-title">Assumptions, Clarifications and Exclusions:</p>';
  html += '<ol>';
  html += '<li>This proposal may be withdrawn by AG Exteriors if not accepted within 30 days.</li>';
  html += '<li>Pricing assumes unfettered access to the property during the project.</li>';
  html += '<li>If AG Exteriors encounters unforeseen conditions that differ from those anticipated or ordinarily found to exist in the construction activities being provided, AG Exteriors retains the right to make an equitable adjustment to the pricing.</li>';
  html += '<li>Client will provide electrical power and water at no charge.</li>';
  html += '<li>Client will provide a location for dumpsters on site for trash and material disposal. AG Exteriors will provide the dumpsters for the entire job. However, if we are required to switch out dumpsters due to residents\u2019 use, AG Exteriors reserves the right to charge the Client accordingly.</li>';
  html += '<li>Mold/Asbestos/Lead Paint: Any detection or remediation of mold, asbestos, and lead paint is specifically excluded from this proposal. Any costs associated with the detection and/or removal of mold, mold spores, asbestos, and lead paint are the responsibility of others.</li>';
  html += '<li>Damage to the physical property that occurred prior to AG Exteriors\u2019 work not specifically called out in the scope of work is excluded.</li>';
  html += '<li>Proposal excludes any engineering and/or permit fees. If any of these are required to complete the project, AG Exteriors will charge the client the cost of these fees plus an additional 10%.</li>';
  html += '<li>Client acknowledges that markets are experiencing significant, industry-wide economic fluctuations, impacting the price of materials to be supplied in conjunction with the agreement. Client acknowledges that materials pricing has the potential to significantly increase between the time of the issuance of the underlying bid and the date of materials purchase for the Project. If the cost of any given material increases above the amount shown in the bid proposal for such material, this quote shall be adjusted upwards, and the Client will be responsible for the increased cost of the materials.';
  html += '<ul><li>In order to mitigate the potential for material-based price increases, the Client has the option to pay for materials in advance of the job. Material costs are guaranteed if materials are paid for at the time the proposal is accepted.</li>';
  html += '<li>Any prepayment of materials will be in addition to the normal deposit of 35%.</li></ul></li>';
  html += '</ol></div>';

  // Signature block
  html += '<div class="sig-block">';
  html += '<p>I confirm that my action here represents my electronic signature and is binding.</p>';
  html += '<div class="sig-line"><span class="sig-label">Signature:</span><span class="sig-rule"></span></div>';
  html += '<div class="sig-line"><span class="sig-label">Date:</span><span class="sig-rule"></span></div>';
  html += '<div class="sig-line"><span class="sig-label">Print Name:</span><span class="sig-rule"></span></div>';
  html += '</div>';
  
  html += '</body></html>';
  
  // Open in new window
  var win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  } else {
    alert('Pop-up blocked. Please allow pop-ups for this site.');
  }
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
