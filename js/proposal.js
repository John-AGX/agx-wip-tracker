// AGX WIP Tracker - Proposal & Export Module
// Handles export of estimates, proposal generation, and import of lead reports

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getEstimateData(estId) {
  const estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
  return estimates.find(e => e.id === estId);
}

function getEstimateLines(estId) {
  const lines = JSON.parse(localStorage.getItem('agx-estimate-lines') || '[]');
  return lines.filter(l => l.estimateId === estId);
}

function groupLinesBySection(lines) {
  const grouped = {};
  lines.forEach(line => {
    const section = line.section || 'General';
    if (!grouped[section]) {
      grouped[section] = [];
    }
    grouped[section].push(line);
  });
  return grouped;
}

function formatDateShort(date) {
  if (!date) return '';
  const d = new Date(date);
  return (d.getMonth() + 1).toString().padStart(2, '0') + '/' +
         d.getDate().toString().padStart(2, '0') + '/' +
         d.getFullYear();
}

function formatDateLong(date) {
  if (!date) return '';
  const d = new Date(date);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function extractIssueFromTitle(title, community) {
  if (!title) return 'Work';
  // If community is in title, remove it
  if (community && title.includes(community)) {
    return title.replace(community + ' - ', '').replace(community, '').trim();
  }
  return title;
}

// ============================================================================
// CELL STYLING & FORMATTING HELPERS
// ============================================================================

const COLORS = {
  agxGreen: '#1B8541',
  agxDarkBlue: '#1B3A5C',
  lightGreen: '#D5E8D9',
  veryLightGreen: '#E8F5E9',
  white: '#FFFFFF',
  grayText: '#444444'
};

function cellValue(v, type = 's') {
  if (type === 'n') return { t: 'n', v: v };
  if (type === 'f') return { t: 'n', v: 0, f: v };
  return { t: 's', v: v || '' };
}

// ============================================================================
// EXPORT ESTIMATE FUNCTION
// ============================================================================

function exportEstimate(estId) {
  const estimate = getEstimateData(estId);
  if (!estimate) {
    alert('Estimate not found');
    return;
  }

  const lines = getEstimateLines(estId);
  const grouped = groupLinesBySection(lines);
  const sections = Object.keys(grouped);

  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = {};

  let row = 1;

  // ========== ROW 1: Title Header ==========
  ws['A1'] = cellValue('AGX CENTRAL FLORIDA', 's');
  const merges = [];
  merges.push('A1:G1');
  // Note: styling not applied in community edition

  // ========== ROW 2: Subtitle ==========
  row = 2;
  ws['A2'] = cellValue('Lead Report & Preliminary Estimate', 's');
  merges.push('A2:G2');

  // ========== ROW 3: Project Name ==========
  row = 3;
  const projectTitle = estimate.community && estimate.title.includes(estimate.community)
    ? estimate.title.replace(estimate.community + ' - ', '').replace(' - ' + estimate.community, '')
    : estimate.title;
  const row3Text = `${estimate.client || ''} - ${estimate.community || ''} - ${projectTitle}`;
  ws['A3'] = cellValue(row3Text, 's');
  merges.push('A3:G3');

  // ========== ROWS 4-5: Empty ==========
  row = 4;

  // ========== ROW 6: Lead Information Header ==========
  row = 6;
  ws['A6'] = cellValue('Lead Information', 's');
  merges.push('A6:G6');

  // ========== ROWS 7-13: Lead Information Fields ==========
  const leadFields = [
    { row: 7, label: 'Title', value: estimate.title },
    { row: 8, label: 'Project Type', value: estimate.jobType },
    { row: 9, label: 'Status', value: estimate.status || 'Open' },
    { row: 10, label: 'Created Date', value: formatDateLong(estimate.created) },
    { row: 11, label: 'Salesperson', value: 'Scott Ryan' },
    { row: 12, label: 'Market', value: 'Tampa' },
    { row: 13, label: 'Estimate ID', value: estimate.id || '—' }
  ];

  leadFields.forEach(field => {
    ws['A' + field.row] = cellValue(field.label, 's');
    merges.push('A' + field.row + ':C' + field.row);
    ws['D' + field.row] = cellValue(field.value, 's');
    merges.push('D' + field.row + ':G' + field.row);
  });

  // ========== ROW 14: Empty ==========
  row = 14;

  // ========== ROW 15: Property Information Header ==========
  row = 15;
  ws['A15'] = cellValue('Property Information', 's');
  merges.push('A15:G15');

  // ========== ROWS 16-24: Property Information Fields ==========
  const propFields = [
    { row: 16, label: 'Community', value: estimate.community },
    { row: 17, label: 'Property Address', value: estimate.propertyAddr },
    { row: 18, label: 'Management Co.', value: estimate.client },
    { row: 19, label: 'CAM', value: estimate.managerName },
    { row: 20, label: 'CAM Email', value: estimate.managerEmail },
    { row: 21, label: 'On-Site Contact', value: '—' },
    { row: 22, label: 'POC Phone', value: estimate.managerPhone || '—' },
    { row: 23, label: 'POC Email', value: '—' },
    { row: 24, label: 'Additional POC', value: '—' }
  ];

  propFields.forEach(field => {
    ws['A' + field.row] = cellValue(field.label, 's');
    merges.push('A' + field.row + ':C' + field.row);
    ws['D' + field.row] = cellValue(field.value, 's');
    merges.push('D' + field.row + ':G' + field.row);
  });

  // ========== ROW 25: Empty ==========
  row = 25;

  // ========== ROW 26: Scope of Work Header ==========
  row = 26;
  ws['A26'] = cellValue('Scope of Work', 's');
  merges.push('A26:G26');

  // ========== ROW 27: Scope of Work Content ==========
  row = 27;
  ws['A27'] = cellValue(estimate.scopeOfWork || '—', 's');
  merges.push('A27:G27');

  // ========== ROWS 28-29: Empty ==========
  row = 28;

  // ========== SCOPES SECTION ==========
  const scopeTotals = [];
  let scopeIndex = 1;

  sections.forEach(sectionName => {
    const sectionLines = grouped[sectionName];

    // Scope header row
    row++;
    const scopeHeaderText = `SCOPE ${scopeIndex}: ${sectionName.toUpperCase()}`;
    ws['A' + row] = cellValue(scopeHeaderText, 's');
    merges.push('A' + row + ':G' + row);
    const scopeHeaderRow = row;

    row++;
    // Column headers: A="Item #", B="Description", C="Qty", D="Unit", E="Unit Cost", F="Markup %", G="Total"
    ws['A' + row] = cellValue('Item #', 's');
    ws['B' + row] = cellValue('Description', 's');
    ws['C' + row] = cellValue('Qty', 's');
    ws['D' + row] = cellValue('Unit', 's');
    ws['E' + row] = cellValue('Unit Cost', 's');
    ws['F' + row] = cellValue('Markup %', 's');
    ws['G' + row] = cellValue('Total', 's');
    const columnHeaderRow = row;

    // Line items
    const lineStartRow = row + 1;
    let lineIndex = 1;
    sectionLines.forEach(line => {
      row++;
      const itemNum = `${scopeIndex}.${lineIndex}`;
      ws['A' + row] = cellValue(itemNum, 's');
      ws['B' + row] = cellValue(line.description, 's');
      ws['C' + row] = cellValue(line.qty, 'n');
      ws['D' + row] = cellValue(line.unit, 's');
      ws['E' + row] = cellValue(line.unitCost, 'n');
      ws['F' + row] = cellValue(line.markup / 100, 'n');
      // Formula: C*E*(1+F)
      ws['G' + row] = cellValue(`C${row}*E${row}*(1+F${row})`, 'f');
      lineIndex++;
    });
    const lineEndRow = row;

    // Subtotal Base row
    row++;
    merges.push('A' + row + ':E' + row);
    ws['F' + row] = cellValue(`${sectionName} Base:`, 's');
    // Base = sum of (qty * unitCost) for all lines
    let baseFormula = '';
    for (let r = lineStartRow; r <= lineEndRow; r++) {
      baseFormula += (baseFormula ? '+' : '') + `C${r}*E${r}`;
    }
    ws['G' + row] = cellValue(baseFormula || '0', 'f');
    const subtotalBaseRow = row;

    // Subtotal Client row
    row++;
    merges.push('A' + row + ':E' + row);
    ws['F' + row] = cellValue(`${sectionName} Client:`, 's');
    ws['G' + row] = cellValue(`SUM(G${lineStartRow}:G${lineEndRow})`, 'f');

    scopeTotals.push({
      scopeIndex: scopeIndex,
      sectionName: sectionName,
      lineStartRow: lineStartRow,
      lineEndRow: lineEndRow,
      subtotalClientRow: row
    });

    row += 2; // 2 empty rows between scopes
    scopeIndex++;
  });

  // ========== PROJECT SUMMARY SECTION ==========
  row++;
  const summaryHeaderRow = row;
  ws['A' + row] = cellValue('PROJECT SUMMARY', 's');
  merges.push('A' + row + ':G' + row);

  row++;
  const summaryColHeaderRow = row;
  ws['A' + row] = cellValue('Scope', 's');
  merges.push('A' + row + ':E' + row);
  ws['F' + row] = cellValue('Base Cost', 's');
  ws['G' + row] = cellValue('Client Price', 's');

  row++;
  let grandTotalBaseFormula = '';
  let grandTotalClientFormula = '';
  scopeTotals.forEach((scope, idx) => {
    ws['A' + row] = cellValue(`Scope ${scope.scopeIndex}: ${scope.sectionName}`, 's');
    merges.push('A' + row + ':E' + row);
    // Base cost formula
    let baseCostFormula = '';
    for (let r = scope.lineStartRow; r <= scope.lineEndRow; r++) {
      baseCostFormula += (baseCostFormula ? '+' : '') + `C${r}*E${r}`;
    }
    ws['F' + row] = cellValue(baseCostFormula || '0', 'f');
    ws['G' + row] = cellValue(`G${scope.subtotalClientRow}`, 'f');

    grandTotalBaseFormula += (grandTotalBaseFormula ? '+' : '') + `F${row}`;
    grandTotalClientFormula += (grandTotalClientFormula ? '+' : '') + `G${row}`;

    row++;
  });

  // Grand total row
  ws['A' + row] = cellValue('GRAND TOTAL', 's');
  merges.push('A' + row + ':E' + row);
  ws['F' + row] = cellValue(grandTotalBaseFormula || '0', 'f');
  ws['G' + row] = cellValue(grandTotalClientFormula || '0', 'f');

  // ========== SET WORKSHEET PROPERTIES ==========
  ws['!ref'] = `A1:G${row}`;
  ws['!merges'] = merges.map(m => XLSX.utils.decode_range(m));
  ws['!cols'] = [
    { wch: 8 },   // A
    { wch: 45 },  // B
    { wch: 8 },   // C
    { wch: 8 },   // D
    { wch: 14 },  // E
    { wch: 10 },  // F
    { wch: 16 }   // G
  ];

  // ========== CREATE WORKBOOK AND DOWNLOAD ==========
  XLSX.utils.book_append_sheet(wb, ws, 'Lead Report');
  const filename = `${estimate.title} - Lead Report.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ============================================================================
// DOWNLOAD BLANK TEMPLATE FUNCTION
// ============================================================================

function downloadBlankTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = {};
  const merges = [];

  let row = 1;

  // ========== ROW 1: Title Header ==========
  ws['A1'] = cellValue('AGX CENTRAL FLORIDA', 's');
  merges.push('A1:G1');

  // ========== ROW 2: Subtitle ==========
  row = 2;
  ws['A2'] = cellValue('Lead Report & Preliminary Estimate', 's');
  merges.push('A2:G2');

  // ========== ROW 3: Project Name Placeholder ==========
  row = 3;
  ws['A3'] = cellValue('[Client] - [Community] - [Title]', 's');
  merges.push('A3:G3');

  // ========== ROWS 4-5: Empty ==========
  row = 4;

  // ========== ROW 6: Lead Information Header ==========
  row = 6;
  ws['A6'] = cellValue('Lead Information', 's');
  merges.push('A6:G6');

  // ========== ROWS 7-13: Lead Information Fields ==========
  const leadFields = [
    { row: 7, label: 'Title', value: '[Project Title]' },
    { row: 8, label: 'Project Type', value: '[Type]' },
    { row: 9, label: 'Status', value: 'Open' },
    { row: 10, label: 'Created Date', value: '' },
    { row: 11, label: 'Salesperson', value: 'Scott Ryan' },
    { row: 12, label: 'Market', value: 'Tampa' },
    { row: 13, label: 'Estimate ID', value: '—' }
  ];

  leadFields.forEach(field => {
    ws['A' + field.row] = cellValue(field.label, 's');
    merges.push('A' + field.row + ':C' + field.row);
    ws['D' + field.row] = cellValue(field.value, 's');
    merges.push('D' + field.row + ':G' + field.row);
  });

  // ========== ROW 14: Empty ==========
  row = 14;

  // ========== ROW 15: Property Information Header ==========
  row = 15;
  ws['A15'] = cellValue('Property Information', 's');
  merges.push('A15:G15');

  // ========== ROWS 16-24: Property Information Fields ==========
  const propFields = [
    { row: 16, label: 'Community', value: '' },
    { row: 17, label: 'Property Address', value: '' },
    { row: 18, label: 'Management Co.', value: '' },
    { row: 19, label: 'CAM', value: '' },
    { row: 20, label: 'CAM Email', value: '' },
    { row: 21, label: 'On-Site Contact', value: '—' },
    { row: 22, label: 'POC Phone', value: '' },
    { row: 23, label: 'POC Email', value: '—' },
    { row: 24, label: 'Additional POC', value: '—' }
  ];

  propFields.forEach(field => {
    ws['A' + field.row] = cellValue(field.label, 's');
    merges.push('A' + field.row + ':C' + field.row);
    ws['D' + field.row] = cellValue(field.value, 's');
    merges.push('D' + field.row + ':G' + field.row);
  });

  // ========== ROW 25: Empty ==========
  row = 25;

  // ========== ROW 26: Scope of Work Header ==========
  row = 26;
  ws['A26'] = cellValue('Scope of Work', 's');
  merges.push('A26:G26');

  // ========== ROW 27: Scope of Work Content ==========
  row = 27;
  ws['A27'] = cellValue('', 's');
  merges.push('A27:G27');

  // ========== ROWS 28-29: Empty ==========
  row = 28;

  // ========== SAMPLE SCOPE 1 ==========
  row++;
  ws['A' + row] = cellValue('SCOPE 1: [SCOPE NAME]', 's');
  merges.push('A' + row + ':G' + row);
  const scopeHeaderRow = row;

  row++;
  // Column headers
  ws['A' + row] = cellValue('Item #', 's');
  ws['B' + row] = cellValue('Description', 's');
  ws['C' + row] = cellValue('Qty', 's');
  ws['D' + row] = cellValue('Unit', 's');
  ws['E' + row] = cellValue('Unit Cost', 's');
  ws['F' + row] = cellValue('Markup %', 's');
  ws['G' + row] = cellValue('Total', 's');
  const columnHeaderRow = row;

  // 5 sample line items
  const lineStartRow = row + 1;
  for (let i = 1; i <= 5; i++) {
    row++;
    ws['A' + row] = cellValue(`1.${i}`, 's');
    ws['B' + row] = cellValue('', 's');
    ws['C' + row] = cellValue('', 'n');
    ws['D' + row] = cellValue('', 's');
    ws['E' + row] = cellValue('', 'n');
    ws['F' + row] = cellValue('', 'n');
    ws['G' + row] = cellValue(`C${row}*E${row}*(1+F${row})`, 'f');
  }
  const lineEndRow = row;

  // Subtotal Base row
  row++;
  merges.push('A' + row + ':E' + row);
  ws['F' + row] = cellValue('[SCOPE NAME] Base:', 's');
  let baseFormula = '';
  for (let r = lineStartRow; r <= lineEndRow; r++) {
    baseFormula += (baseFormula ? '+' : '') + `C${r}*E${r}`;
  }
  ws['G' + row] = cellValue(baseFormula || '0', 'f');
  const subtotalBaseRow = row;

  // Subtotal Client row
  row++;
  merges.push('A' + row + ':E' + row);
  ws['F' + row] = cellValue('[SCOPE NAME] Client:', 's');
  ws['G' + row] = cellValue(`SUM(G${lineStartRow}:G${lineEndRow})`, 'f');
  const subtotalClientRow = row;

  row += 2;

  // ========== PROJECT SUMMARY SECTION ==========
  row++;
  ws['A' + row] = cellValue('PROJECT SUMMARY', 's');
  merges.push('A' + row + ':G' + row);

  row++;
  ws['A' + row] = cellValue('Scope', 's');
  merges.push('A' + row + ':E' + row);
  ws['F' + row] = cellValue('Base Cost', 's');
  ws['G' + row] = cellValue('Client Price', 's');

  row++;
  ws['A' + row] = cellValue('Scope 1: [SCOPE NAME]', 's');
  merges.push('A' + row + ':E' + row);
  let baseCostFormula = '';
  for (let r = lineStartRow; r <= lineEndRow; r++) {
    baseCostFormula += (baseCostFormula ? '+' : '') + `C${r}*E${r}`;
  }
  ws['F' + row] = cellValue(baseCostFormula || '0', 'f');
  ws['G' + row] = cellValue(`G${subtotalClientRow}`, 'f');
  const summaryRowNum = row;

  row++;
  ws['A' + row] = cellValue('GRAND TOTAL', 's');
  merges.push('A' + row + ':E' + row);
  ws['F' + row] = cellValue(`F${summaryRowNum}`, 'f');
  ws['G' + row] = cellValue(`G${summaryRowNum}`, 'f');

  // ========== SET WORKSHEET PROPERTIES ==========
  ws['!ref'] = `A1:G${row}`;
  ws['!merges'] = merges.map(m => XLSX.utils.decode_range(m));
  ws['!cols'] = [
    { wch: 8 },   // A
    { wch: 45 },  // B
    { wch: 8 },   // C
    { wch: 8 },   // D
    { wch: 14 },  // E
    { wch: 10 },  // F
    { wch: 16 }   // G
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Lead Report');
  XLSX.writeFile(wb, 'AGX_Blank_Template.xlsx');
}

// ============================================================================
// GENERATE PROPOSAL FUNCTION
// ============================================================================

function generateProposal(estId) {
  const estimate = getEstimateData(estId);
  if (!estimate) {
    alert('Estimate not found');
    return;
  }

  const lines = getEstimateLines(estId);
  const grouped = groupLinesBySection(lines);

  // Extract issue from title
  const issue = extractIssueFromTitle(estimate.title, estimate.community);
  const nickName = estimate.nickName || estimate.client;
  const community = estimate.community || 'the property';

  // Calculate totals
  let grandTotal = 0;
  lines.forEach(line => {
    const lineTotal = line.qty * line.unitCost * (1 + line.markup / 100);
    grandTotal += lineTotal;
  });

  // Build HTML proposal
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Proposal - ${estimate.title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: Arial, sans-serif;
      color: #333;
      line-height: 1.6;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background: white;
    }
    .header {
      background-color: #1B8541;
      color: white;
      padding: 30px;
      text-align: center;
      margin-bottom: 30px;
    }
    .header h1 {
      font-size: 28px;
      margin: 0;
      font-weight: bold;
    }
    .date-line {
      text-align: right;
      margin-bottom: 20px;
      color: #666;
      font-size: 14px;
    }
    .intro {
      margin-bottom: 30px;
      text-align: justify;
    }
    .intro p {
      margin-bottom: 10px;
    }
    .scope-section {
      margin-bottom: 30px;
      page-break-inside: avoid;
    }
    .scope-title {
      font-size: 16px;
      font-weight: bold;
      color: #1B3A5C;
      margin-bottom: 10px;
      border-bottom: 2px solid #1B8541;
      padding-bottom: 5px;
    }
    .scope-description {
      margin-bottom: 15px;
      color: #666;
      font-size: 14px;
    }
    .line-items {
      margin-left: 20px;
      margin-bottom: 15px;
    }
    .line-item {
      margin-bottom: 8px;
      font-size: 14px;
    }
    .line-item:before {
      content: "• ";
      color: #1B8541;
      font-weight: bold;
      margin-right: 8px;
    }
    .total-section {
      margin-bottom: 40px;
      page-break-inside: avoid;
    }
    .total-price {
      background-color: #E8F5E9;
      padding: 20px;
      border-left: 4px solid #1B8541;
      text-align: right;
    }
    .total-price p {
      font-size: 14px;
      margin-bottom: 10px;
    }
    .total-price .amount {
      font-size: 32px;
      font-weight: bold;
      color: #1B8541;
    }
    .assumptions {
      margin-bottom: 30px;
      page-break-inside: avoid;
    }
    .assumptions h3 {
      font-size: 16px;
      font-weight: bold;
      color: #1B3A5C;
      margin-bottom: 15px;
      border-bottom: 2px solid #1B8541;
      padding-bottom: 5px;
    }
    .assumption-item {
      margin-left: 20px;
      margin-bottom: 12px;
      font-size: 13px;
      text-align: justify;
    }
    .assumption-item:before {
      content: counter(assumption) ". ";
      counter-increment: assumption;
      font-weight: bold;
      color: #1B8541;
      margin-right: 8px;
    }
    .signature-block {
      margin-top: 50px;
      display: flex;
      justify-content: space-between;
      page-break-inside: avoid;
    }
    .sig-column {
      width: 45%;
      border-top: 1px solid #333;
      padding-top: 10px;
      text-align: center;
      font-size: 12px;
    }
    .sig-label {
      font-weight: bold;
      margin-top: 5px;
    }
    .date-line-sig {
      margin-top: 20px;
      font-size: 12px;
    }
    .print-button {
      margin-bottom: 20px;
      text-align: center;
    }
    .print-button button {
      background-color: #1B8541;
      color: white;
      padding: 10px 30px;
      border: none;
      font-size: 16px;
      cursor: pointer;
      border-radius: 4px;
    }
    .print-button button:hover {
      background-color: #156e35;
    }
    @media print {
      .print-button {
        display: none;
      }
      body {
        padding: 0;
      }
      .container {
        padding: 0;
        max-width: 100%;
      }
    }
    counter-reset: assumption;
  </style>
</head>
<body>
  <div class="container">
    <div class="print-button">
      <button onclick="window.print()">Print Proposal</button>
    </div>

    <div class="header">
      <h1>AGX CENTRAL FLORIDA</h1>
    </div>

    <div class="date-line">
      Date: ${formatDateShort(new Date())}
    </div>

    <div class="intro">
      <p>Dear <strong>${nickName}</strong>,</p>
      <p>AGX Central Florida is pleased to provide the following proposal for <strong>${issue}</strong> at <strong>${community}</strong>.</p>
    </div>

    ${Object.entries(grouped).map((entry, idx) => {
      const [sectionName, sectionLines] = entry;
      const scopeLetter = String.fromCharCode(65 + idx); // A, B, C, etc.
      const scopeNum = idx + 1;
      return `
    <div class="scope-section">
      <div class="scope-title">SCOPE ${scopeLetter}${scopeNum}: ${sectionName}</div>
      <div class="line-items">
        ${sectionLines.map(line => `
        <div class="line-item">${line.description}</div>
        `).join('')}
      </div>
    </div>
      `;
    }).join('')}

    <div class="total-section">
      <div class="total-price">
        <p>TOTAL PRICE:</p>
        <div class="amount">$${grandTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
      </div>
    </div>

    <div class="assumptions">
      <h3>Assumptions</h3>
      <div class="assumption-item">All work to be completed during normal business hours</div>
      <div class="assumption-item">Price is valid for 30 days</div>
      <div class="assumption-item">Payment terms: 50% upon acceptance, 50% upon completion</div>
      <div class="assumption-item">Any additional work beyond the agreed scope will be quoted separately</div>
      <div class="assumption-item">Client to provide reasonable access to work areas</div>
      <div class="assumption-item">AGX is not responsible for pre-existing conditions not included in scope</div>
      <div class="assumption-item">Permits, if required, are the responsibility of the client unless otherwise noted</div>
      <div class="assumption-item">Material colors and styles to match existing as closely as possible</div>
      <div class="assumption-item">Warranty: 1-year workmanship warranty from date of completion</div>
    </div>

    <div class="signature-block">
      <div class="sig-column">
        <div style="height: 40px;"></div>
        <div class="sig-label">Client Signature</div>
        <div class="date-line-sig">Date: _________________</div>
      </div>
      <div class="sig-column">
        <div style="height: 40px;"></div>
        <div class="sig-label">AGX Representative</div>
        <div class="date-line-sig">Date: _________________</div>
      </div>
    </div>
  </div>
</body>
</html>
  `;

  const newWindow = window.open('', '_blank');
  newWindow.document.write(html);
  newWindow.document.close();
  setTimeout(() => {
    newWindow.print();
  }, 500);
}

// ============================================================================
// PARSE REPORT FUNCTION (Import)
// ============================================================================

function parseReport(data) {
  // Convert worksheet to array of arrays
  const aoa = XLSX.utils.sheet_to_json(data, { header: 1 });

  // Verify it's an AGX report
  let isAgxReport = false;
  for (let i = 0; i < Math.min(5, aoa.length); i++) {
    if (aoa[i][0] && aoa[i][0].toString().toUpperCase().includes('AGX')) {
      isAgxReport = true;
      break;
    }
  }

  if (!isAgxReport) {
    alert('This does not appear to be an AGX Lead Report');
    return null;
  }

  // Helper to get field value from label
  function getFieldValue(label) {
    for (let i = 0; i < aoa.length; i++) {
      const col0 = aoa[i][0] ? aoa[i][0].toString().trim() : '';
      if (col0.toLowerCase() === label.toLowerCase()) {
        return (aoa[i][3] || '').toString().trim();
      }
    }
    return '';
  }

  // Parse basic fields
  const estimate = {
    id: generateId(),
    title: getFieldValue('Title'),
    jobType: getFieldValue('Project Type'),
    status: getFieldValue('Status') || 'Open',
    client: getFieldValue('Management Co.'),
    community: getFieldValue('Community'),
    propertyAddr: getFieldValue('Property Address'),
    billingAddr: '',
    managerName: getFieldValue('CAM'),
    managerEmail: getFieldValue('CAM Email'),
    managerPhone: getFieldValue('POC Phone'),
    nickName: '',
    defaultMarkup: 100,
    scopeOfWork: '',
    created: new Date().toISOString()
  };

  // Find and parse scope of work
  for (let i = 0; i < aoa.length; i++) {
    const col0 = (aoa[i][0] || '').toString().trim();
    if (col0.toLowerCase() === 'scope of work' && i + 1 < aoa.length) {
      estimate.scopeOfWork = (aoa[i + 1][0] || '').toString().trim();
      break;
    }
  }

  // Parse line items - look for rows matching pattern like "1.1", "2.3", etc.
  const lines = [];
  let currentSection = 'General';

  for (let i = 0; i < aoa.length; i++) {
    const col0 = (aoa[i][0] || '').toString().trim();

    // Check for scope header pattern (SCOPE N: NAME)
    const scopeHeaderMatch = col0.match(/^SCOPE\s\d+:\s\(.+)$/i);
    if (scopeHeaderMatch) {
      currentSection = scopeHeaderMatch[1].trim();
      continue;
    }

    // Check for line item pattern (e.g., "1.1", "2.3")
    const lineMatch = col0.match(/^(\d+\.\d+)$/);
    if (lineMatch) {
      const lineItem = {
        id: generateId(),
        estimateId: estimate.id,
        section: currentSection,
        description: (aoa[i][1] || '').toString().trim(),
        qty: parseFloat(aoa[i][2]) || 0,
        unit: (aoa[i][3] || '').toString().trim(),
        unitCost: parseFloat(aoa[i][4]) || 0,
        markup: (parseFloat(aoa[i][5]) || 0) * 100 // Convert from ratio to percentage
      };
      lines.push(lineItem);
    }
  }

  return { estimate, lines };
}

function generateId() {
  return 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// ============================================================================
// IMPORT FILE PROCESSING
// ============================================================================

function processImportFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      const parsed = parseReport(worksheet);
      if (!parsed) return;

      const { estimate, lines } = parsed;

      // Save to localStorage
      const estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
      estimates.push(estimate);
      localStorage.setItem('agx-estimates', JSON.stringify(estimates));

      const estimateLines = JSON.parse(localStorage.getItem('agx-estimate-lines') || '[]');
      estimateLines.push(...lines);
      localStorage.setItem('agx-estimate-lines', JSON.stringify(estimateLines));

      alert(`Estimate "${estimate.title}" imported successfully`);

      // Redirect to estimate editor if available
      if (window.location.hash && window.location.hash.includes('estimates')) {
        location.hash = `#estimate/${estimate.id}`;
      } else {
        location.reload();
      }
    } catch (err) {
      console.error('Import error:', err);
      alert('Error importing file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ============================================================================
// DOM INJECTION FUNCTIONS
// ============================================================================

let injectionTimeout;

function injectImportBtn() {
  // Target the action-buttons div inside the estimates list view
  const actionButtons = document.querySelector('#estimates-list-view .action-buttons');

  if (!actionButtons) {
    if (!injectionTimeout) {
      injectionTimeout = setTimeout(() => {
        injectionTimeout = null;
        injectImportBtn();
      }, 500);
    }
    return;
  }

  // Check if already injected
  if (document.getElementById('agx-import-btn')) {
    return;
  }

  const button = document.createElement('button');
  button.id = 'agx-import-btn';
  button.textContent = 'Import Lead Report';
  button.style.cssText = `
    background-color: #1B8541;
    color: white;
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    margin-left: 8px;
  `;

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.xlsx';
  fileInput.style.display = 'none';
  fileInput.id = 'agx-import-input';

  button.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) {
      processImportFile(e.target.files[0]);
    }
  });

  actionButtons.appendChild(button);
  actionButtons.appendChild(fileInput);
}

function injectTemplateBtn() {
  const actionButtons = document.querySelector('#estimates-list-view .action-buttons');

  if (!actionButtons) {
    if (!injectionTimeout) {
      injectionTimeout = setTimeout(() => {
        injectionTimeout = null;
        injectTemplateBtn();
      }, 500);
    }
    return;
  }

  // Check if already injected
  if (document.getElementById('agx-template-btn')) {
    return;
  }

  const button = document.createElement('button');
  button.id = 'agx-template-btn';
  button.textContent = 'Blank Template';
  button.style.cssText = `
    background-color: white;
    color: #1B3A5C;
    padding: 8px 16px;
    border: 2px solid #1B3A5C;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    margin-left: 8px;
  `;

  button.addEventListener('click', downloadBlankTemplate);
  actionButtons.appendChild(button);
}

let exportInjectTimeout;
let lastExportInjectTime = 0;
const EXPORT_INJECT_DEBOUNCE = 200;

function injectExportBtns() {
  const now = Date.now();
  if (now - lastExportInjectTime < EXPORT_INJECT_DEBOUNCE) {
    clearTimeout(exportInjectTimeout);
    exportInjectTimeout = setTimeout(injectExportBtns, EXPORT_INJECT_DEBOUNCE);
    return;
  }
  lastExportInjectTime = now;

  // Target table rows in the estimates table
  const rows = document.querySelectorAll('#estimates-table tbody tr');

  rows.forEach(row => {
    // Skip if buttons already injected
    if (row.querySelector('.agx-export-btn, .agx-proposal-btn')) {
      return;
    }

    // Extract estimate ID from the Edit button onclick: editEstimate('eXXXXX')
    const editBtn = row.querySelector('button[onclick*="editEstimate"]');
    if (!editBtn) return;
    const match = editBtn.getAttribute('onclick').match(/editEstimate\(['"]([^'"]+)['"]\)/);
    if (!match) return;
    const estId = match[1];

    // Find the last td (actions cell)
    const lastTd = row.cells[row.cells.length - 1];
    if (!lastTd) return;

    // Create Generate Proposal button
    const proposalBtn = document.createElement('button');
    proposalBtn.className = 'agx-proposal-btn small';
    proposalBtn.textContent = 'Generate Proposal';
    proposalBtn.style.cssText = `
      background-color: #1B8541;
      color: white;
      padding: 4px 10px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      margin-left: 4px;
    `;
    proposalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      generateProposal(estId);
    });

    // Create export button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'agx-export-btn small';
    exportBtn.textContent = 'Export';
    exportBtn.style.cssText = `
      background-color: #1B3A5C;
      color: white;
      padding: 4px 10px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      margin-left: 4px;
    `;
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportEstimate(estId);
    });

    lastTd.appendChild(proposalBtn);
    lastTd.appendChild(exportBtn);
  });
}

// ============================================================================
// NICK NAME FIELD INJECTION
// ============================================================================

function injectNickNameField() {
  // Only inject if the client field exists and nickName field doesn't
  var clientInput = document.getElementById('editEst_client');
  if (!clientInput || document.getElementById('editEst_nickName')) return;

  var clientGroup = clientInput.closest('.form-group');
  if (!clientGroup) return;

  // Create the nickName form group matching existing structure
  var nickGroup = document.createElement('div');
  nickGroup.className = 'form-group';
  var label = document.createElement('label');
  label.textContent = 'Nick Name';
  var input = document.createElement('input');
  input.type = 'text';
  input.id = 'editEst_nickName';
  input.placeholder = 'Short name for proposals (e.g. Jane)';
  // Copy styling from client input
  input.className = clientInput.className;
  input.style.cssText = clientInput.style.cssText;
  nickGroup.appendChild(label);
  nickGroup.appendChild(input);

  // Insert after client group
  clientGroup.parentNode.insertBefore(nickGroup, clientGroup.nextSibling);
}

// Patch editEstimate to populate nickName
var _origEditEstimate = null;
function patchEditEstimate() {
  if (_origEditEstimate) return; // already patched
  if (typeof editEstimate !== 'function') return;
  _origEditEstimate = editEstimate;
  window.editEstimate = function(estId) {
    _origEditEstimate(estId);
    // After original runs, inject nickName field and populate it
    setTimeout(function() {
      injectNickNameField();
      var estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
      var est = estimates.find(function(e) { return e.id === estId; });
      var nickInput = document.getElementById('editEst_nickName');
      if (est && nickInput) {
        nickInput.value = est.nickName || '';
      }
    }, 50);
  };
}

// Patch saveEstimateEdits to save nickName
var _origSaveEstimateEdits = null;
function patchSaveEstimateEdits() {
  if (_origSaveEstimateEdits) return;
  if (typeof saveEstimateEdits !== 'function') return;
  _origSaveEstimateEdits = saveEstimateEdits;
  window.saveEstimateEdits = function() {
    // Before saving, ensure nickName gets into the estimate object
    var nickInput = document.getElementById('editEst_nickName');
    var nickVal = nickInput ? nickInput.value.trim() : '';

    // Call original save
    _origSaveEstimateEdits();

    // Now patch the saved estimate to include nickName
    // Find which estimate was just saved (the one currently open)
    var estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
    // The most recently modified estimate - check by matching title from the form
    var titleVal = document.getElementById('editEst_title')?.value;
    if (titleVal) {
      var est = estimates.find(function(e) { return e.title === titleVal; });
      if (est) {
        est.nickName = nickVal;
        localStorage.setItem('agx-estimates', JSON.stringify(estimates));
      }
    }
  };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

(function loadSheetJS() {
  if (typeof XLSX !== 'undefined') {
    console.log('SheetJS already loaded');
    patchEditEstimate();
    patchSaveEstimateEdits();
    if (typeof injectImportBtn === 'function') {
      injectImportBtn();
      injectExportBtns();
      injectTemplateBtn();
    }
    return;
  }

  const s = document.createElement('script');
  s.src = 'https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js';
  s.onload = function() {
    console.log('SheetJS loaded from CDN');
    patchEditEstimate();
    patchSaveEstimateEdits();
    injectImportBtn();
    injectExportBtns();
    injectTemplateBtn();

    // Set up observer to reinject buttons when DOM changes
    const observer = new MutationObserver(() => {
      injectImportBtn();
      injectExportBtns();
      injectTemplateBtn();
      injectNickNameField();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false
    });
  };
  s.onerror = function() {
    console.error('Failed to load SheetJS');
  };
  document.head.appendChild(s);
})();

// Also set up immediate injection if XLSX is already available
if (typeof XLSX !== 'undefined') {
  setTimeout(() => {
    patchEditEstimate();
    patchSaveEstimateEdits();
    injectImportBtn();
    injectExportBtns();
    injectTemplateBtn();
  }, 100);
}

// Also patch functions even before XLSX loads
setTimeout(function() {
  patchEditEstimate();
  patchSaveEstimateEdits();
}, 200);
