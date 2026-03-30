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
    if (!grouped[section]) { grouped[section] = []; }
    grouped[section].push(line);
  });
  return grouped;
}

function formatDateShort(date) {
  if (!date) return '';
  const d = new Date(date);
  return (d.getMonth() + 1).toString().padStart(2, '0') + '/' +
    d.getDate().toString().padStart(2, '0') + '/' + d.getFullYear();
}

function formatDateLong(date) {
  if (!date) return '';
  const d = new Date(date);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function extractIssueFromTitle(title, community) {
  if (!title) return 'Work';
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
  if (!estimate) { alert('Estimate not found'); return; }

  const lines = getEstimateLines(estId);
  const grouped = groupLinesBySection(lines);
  const sections = Object.keys(grouped);

  // Ensure ExcelJS is loaded
  if (typeof ExcelJS === 'undefined') {
    alert('ExcelJS is still loading. Please try again in a moment.');
    return;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'AGX Central Florida';
  const ws = wb.addWorksheet('Lead Report');

  // === AGX Brand Colors ===
  const GREEN = '1B8541';
  const DARK_TEAL = '1B3A5C';
  const LABEL_BG = 'E8F5E9';
  const ALT_ROW = 'F1F8F2';
  const SECTION_BG = 'D5E8D9';
  const BORDER_COLOR = 'CCCCCC';
  const WHITE = 'FFFFFF';

  // === Helpers ===
  const greenFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + GREEN } };
  const labelFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + LABEL_BG } };
  const altFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ALT_ROW } };
  const sectionFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + SECTION_BG } };
  const thinBorder = {
    top: { style: 'thin', color: { argb: 'FF' + BORDER_COLOR } },
    left: { style: 'thin', color: { argb: 'FF' + BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: 'FF' + BORDER_COLOR } },
    right: { style: 'thin', color: { argb: 'FF' + BORDER_COLOR } }
  };
  const whiteFont = (size, bold) => ({ name: 'Arial', size: size, bold: !!bold, color: { argb: 'FF' + WHITE } });
  const darkTealFont = (size, bold) => ({ name: 'Arial', size: size, bold: !!bold, color: { argb: 'FF' + DARK_TEAL } });
  const bodyFont = { name: 'Arial', size: 10 };
  const currencyFmt = '$#,##0.00';
  const pctFmt = '0%';

  function mergeAndStyle(r, c1, c2, value, font, fill, alignment) {
    ws.mergeCells(r, c1, r, c2);
    const cell = ws.getCell(r, c1);
    cell.value = value;
    if (font) cell.font = font;
    if (fill) cell.fill = fill;
    if (alignment) cell.alignment = alignment;
  }

  function setInfoRow(r, label, value) {
    ws.mergeCells(r, 1, r, 3);
    ws.mergeCells(r, 4, r, 7);
    const labelCell = ws.getCell(r, 1);
    labelCell.value = label;
    labelCell.font = { name: 'Arial', size: 10, bold: true };
    labelCell.fill = labelFill;
    labelCell.border = thinBorder;
    const valCell = ws.getCell(r, 4);
    valCell.value = value || '\u2014';
    valCell.font = bodyFont;
    valCell.border = thinBorder;
  }

  // === Column Widths ===
  ws.getColumn(1).width = 8;   // A - Item #
  ws.getColumn(2).width = 45;  // B - Description
  ws.getColumn(3).width = 8;   // C - Qty
  ws.getColumn(4).width = 8;   // D - Unit
  ws.getColumn(5).width = 14;  // E - Unit Cost
  ws.getColumn(6).width = 10;  // F - Markup %
  ws.getColumn(7).width = 16;  // G - Total

  // === ROW 1: AGX CENTRAL FLORIDA ===
  mergeAndStyle(1, 1, 7, 'AGX CENTRAL FLORIDA', whiteFont(16, true), greenFill, { horizontal: 'center', vertical: 'middle' });
  ws.getRow(1).height = 30;

  // === ROW 2: Subtitle ===
  mergeAndStyle(2, 1, 7, 'Lead Report & Preliminary Estimate', { name: 'Arial', size: 12, bold: true, color: { argb: 'FF' + DARK_TEAL } }, null, { horizontal: 'center' });

  // === ROW 3: Lead Title ===
  const projectTitle = estimate.title || 'Untitled Estimate';
  const row3Text = projectTitle;
  mergeAndStyle(3, 1, 7, row3Text, { name: 'Arial', size: 11, color: { argb: 'FF444444' } }, null, { horizontal: 'center' });

  // === ROW 4: Green accent line ===
  mergeAndStyle(4, 1, 7, '', null, greenFill, null);
  ws.getRow(4).height = 4;

  // === ROW 5: Empty ===
  let row = 5;

  // === ROW 6: Lead Information Header ===
  row = 6;
  mergeAndStyle(row, 1, 7, 'Lead Information', whiteFont(13, true), greenFill, { horizontal: 'left', vertical: 'middle' });

  // === ROWS 7-13: Lead Info Fields (7 fields, no Nick Name) ===
  const leadFields = [
    { row: 7, label: 'Title', value: estimate.title || '\u2014' },
    { row: 8, label: 'Project Type', value: estimate.jobType || '\u2014' },
    { row: 9, label: 'Status', value: estimate.status || '\u2014' },
    { row: 10, label: 'Created Date', value: estimate.created ? formatDateShort(estimate.created) : '\u2014' },
    { row: 11, label: 'Salesperson', value: '\u2014' },
    { row: 12, label: 'Market', value: '\u2014' },
    { row: 13, label: 'Estimate ID', value: estId }
  ];
  leadFields.forEach(f => setInfoRow(f.row, f.label, f.value));

  // === ROW 14: Empty ===
  row = 14;

  // === ROW 15: Property Information Header ===
  row = 15;
  mergeAndStyle(row, 1, 7, 'Property Information', whiteFont(13, true), greenFill, { horizontal: 'left', vertical: 'middle' });

  // === ROWS 16-24: Property Info Fields (9 fields, Nick Name first) ===
  const nickNameEl = document.querySelector('[data-field="nickName"]');
  const nickNameVal = (nickNameEl && nickNameEl.value) ? nickNameEl.value : (estimate.nickName || '\u2014');

  const propFields = [
    { row: 16, label: 'Nick Name', value: nickNameVal },
    { row: 17, label: 'Community', value: estimate.community || '\u2014' },
    { row: 18, label: 'Property Address', value: estimate.propertyAddr || '\u2014' },
    { row: 19, label: 'Management Co.', value: estimate.client || '\u2014' },
    { row: 20, label: 'CAM', value: '\u2014' },
    { row: 21, label: 'CAM Email', value: '\u2014' },
    { row: 22, label: 'On-Site Contact', value: estimate.managerName || '\u2014' },
    { row: 23, label: 'POC Phone', value: estimate.managerPhone || '\u2014' },
    { row: 24, label: 'POC Email', value: estimate.managerEmail || '\u2014' }
  ];
  propFields.forEach(f => setInfoRow(f.row, f.label, f.value));

  // === ROW 25: Empty ===
  row = 25;

  // === ROW 26: Scope of Work Header ===
  row = 26;
  mergeAndStyle(row, 1, 7, 'Scope of Work', whiteFont(13, true), greenFill, { horizontal: 'left', vertical: 'middle' });

  // === ROW 27: SOW Text ===
  row = 27;
  ws.mergeCells(row, 1, row, 7);
  const sowCell = ws.getCell(row, 1);
  sowCell.value = estimate.scopeOfWork || 'Scope TBD \u2014 pending site visit';
  sowCell.font = bodyFont;
  sowCell.alignment = { wrapText: true, vertical: 'top' };

  // === ROW 28: Empty ===
  row = 29;

  // === SCOPE SECTIONS ===
  const scopeData = [];
  let scopeIndex = 1;

  sections.forEach(sectionName => {
    const sectionLines = grouped[sectionName];

    // Scope header row
    const scopeHeaderText = 'SCOPE ' + scopeIndex + ': ' + (sectionName || 'General').toUpperCase();
    mergeAndStyle(row, 1, 7, scopeHeaderText, whiteFont(13, true), greenFill, { horizontal: 'left', vertical: 'middle' });
    row++;

    // Column headers
    const colHeaders = ['Item #', 'Description', 'Qty', 'Unit', 'Unit Cost', 'Markup %', 'Total'];
    colHeaders.forEach((h, ci) => {
      const cell = ws.getCell(row, ci + 1);
      cell.value = h;
      cell.font = whiteFont(10, true);
      cell.fill = greenFill;
      cell.border = thinBorder;
      cell.alignment = { horizontal: 'center' };
    });
    const colHeaderRow = row;
    row++;

    // Line items
    const lineStartRow = row;
    let lineIndex = 1;
    sectionLines.forEach((line, li) => {
      const itemNum = scopeIndex + '.' + lineIndex;
      const isAlt = li % 2 === 1;

      const cellA = ws.getCell(row, 1);
      cellA.value = itemNum;
      cellA.font = bodyFont;
      cellA.border = thinBorder;
      cellA.alignment = { horizontal: 'center' };
      if (isAlt) cellA.fill = altFill;

      const cellB = ws.getCell(row, 2);
      cellB.value = line.description || '';
      cellB.font = bodyFont;
      cellB.border = thinBorder;
      if (isAlt) cellB.fill = altFill;

      const cellC = ws.getCell(row, 3);
      cellC.value = line.qty || 0;
      cellC.font = bodyFont;
      cellC.border = thinBorder;
      cellC.alignment = { horizontal: 'center' };
      if (isAlt) cellC.fill = altFill;

      const cellD = ws.getCell(row, 4);
      cellD.value = line.unit || 'ea';
      cellD.font = bodyFont;
      cellD.border = thinBorder;
      cellD.alignment = { horizontal: 'center' };
      if (isAlt) cellD.fill = altFill;

      const cellE = ws.getCell(row, 5);
      cellE.value = line.unitCost || 0;
      cellE.font = bodyFont;
      cellE.border = thinBorder;
      cellE.numFmt = currencyFmt;
      if (isAlt) cellE.fill = altFill;

      const cellF = ws.getCell(row, 6);
      cellF.value = (line.markup || 100) / 100;
      cellF.font = bodyFont;
      cellF.border = thinBorder;
      cellF.numFmt = pctFmt;
      cellF.alignment = { horizontal: 'center' };
      if (isAlt) cellF.fill = altFill;

      const cellG = ws.getCell(row, 7);
      cellG.value = { formula: 'C' + row + '*E' + row + '*(1+F' + row + ')' };
      cellG.font = bodyFont;
      cellG.border = thinBorder;
      cellG.numFmt = currencyFmt;
      if (isAlt) cellG.fill = altFill;

      lineIndex++;
      row++;
    });
    const lineEndRow = row - 1;

    // Subtotal Base row
    ws.mergeCells(row, 1, row, 5);
    const baseLabel = ws.getCell(row, 6);
    baseLabel.value = 'Base:';
    baseLabel.font = { name: 'Arial', size: 10, bold: true };
    baseLabel.fill = labelFill;
    baseLabel.border = thinBorder;
    baseLabel.alignment = { horizontal: 'right' };
    const baseVal = ws.getCell(row, 7);
    baseVal.value = { formula: 'SUMPRODUCT(C' + lineStartRow + ':C' + lineEndRow + ',E' + lineStartRow + ':E' + lineEndRow + ')' };
    baseVal.font = { name: 'Arial', size: 10, bold: true };
    baseVal.fill = labelFill;
    baseVal.border = thinBorder;
    baseVal.numFmt = currencyFmt;
    const subtotalBaseRow = row;
    row++;

    // Subtotal Client row
    ws.mergeCells(row, 1, row, 5);
    const clientLabel = ws.getCell(row, 6);
    clientLabel.value = 'Client:';
    clientLabel.font = whiteFont(10, true);
    clientLabel.fill = greenFill;
    clientLabel.border = thinBorder;
    clientLabel.alignment = { horizontal: 'right' };
    const clientVal = ws.getCell(row, 7);
    clientVal.value = { formula: 'SUM(G' + lineStartRow + ':G' + lineEndRow + ')' };
    clientVal.font = whiteFont(10, true);
    clientVal.fill = greenFill;
    clientVal.border = thinBorder;
    clientVal.numFmt = currencyFmt;
    const subtotalClientRow = row;

    scopeData.push({
      name: sectionName || 'General',
      subtotalBaseRow: subtotalBaseRow,
      subtotalClientRow: subtotalClientRow
    });

    row += 2;
    scopeIndex++;
  });

  // === PROJECT SUMMARY SECTION ===
  row++;
  mergeAndStyle(row, 1, 7, 'PROJECT SUMMARY', whiteFont(13, true), greenFill, { horizontal: 'left', vertical: 'middle' });
  row++;

  // Summary column headers
  const sumHeaders = ['Scope', '', '', '', '', 'Base Cost', 'Client Price'];
  sumHeaders.forEach((h, ci) => {
    const cell = ws.getCell(row, ci + 1);
    cell.value = h;
    cell.font = whiteFont(10, true);
    cell.fill = greenFill;
    cell.border = thinBorder;
    cell.alignment = { horizontal: 'center' };
  });
  ws.mergeCells(row, 1, row, 5);
  row++;

  // Scope rows in summary
  let grandTotalBaseFormula = '';
  let grandTotalClientFormula = '';
  scopeData.forEach(scope => {
    ws.mergeCells(row, 1, row, 5);
    const nameCell = ws.getCell(row, 1);
    nameCell.value = scope.name;
    nameCell.font = bodyFont;
    nameCell.border = thinBorder;

    const baseSumCell = ws.getCell(row, 6);
    baseSumCell.value = { formula: 'G' + scope.subtotalBaseRow };
    baseSumCell.font = bodyFont;
    baseSumCell.border = thinBorder;
    baseSumCell.numFmt = currencyFmt;

    const clientSumCell = ws.getCell(row, 7);
    clientSumCell.value = { formula: 'G' + scope.subtotalClientRow };
    clientSumCell.font = bodyFont;
    clientSumCell.border = thinBorder;
    clientSumCell.numFmt = currencyFmt;

    grandTotalBaseFormula += (grandTotalBaseFormula ? '+' : '') + 'F' + row;
    grandTotalClientFormula += (grandEotalClientFormula ? '+' : '') + 'G' + row;
    row++;
  });

  // Grand Total row
  ws.mergeCells(row, 1, row, 5);
  const gtLabel = ws.getCell(row, 1);
  gtLabel.value = 'GRAND TOTAL';
  gtLabel.font = darkTealFont(11, true);
  gtLabel.fill = labelFill;
  gtLabel.border = thinBorder;

  const gtBase = ws.getCell(row, 6);
  gtBase.value = { formula: grandTotalBaseFormula };
  gtBase.font = darkTealFont(10, true);
  gtBase.fill = labelFill;
  gtBase.border = thinBorder;
  gtBase.numFmt = currencyFmt;

  const gtClient = ws.getCell(row, 7);
  gtClient.value = { formula: grandTotalClientFormula };
  gtClient.font = whiteFont(10, true);
  gtClient.fill = greenFill;
  gtClient.border = thinBorder;
  gtClient.numFmt = currencyFmt;

  // === Generate and download ===
  wb.xlsx.writeBuffer().then(function(buffer) {
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (estimate.title || 'AGX_Estimate') + ' - Lead Report.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

function downloadBlankTemplate() {
  const url = 'https://john-agx.github.io/agx-wip-tracker/templates/AGX_Blank_Template.xlsx';
  fetch(url)
    .then(function(r) { return r.blob(); })
    .then(function(blob) {
      var blobUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'AGX_Blank_Template.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    })
    .catch(function(err) { alert('Failed to download template: ' + err.message); });
}

// ============================================================================
// GENERATE PROPOSAL FUNCTION
// ============================================================================

function generateProposal(estId) {
  const estimate = getEstimateData(estId);
  if (!estimate) { alert('Estimate not found'); return; }

  const lines = getEstimateLines(estId);
  const grouped = groupLinesBySection(lines);

  const issue = extractIssueFromTitle(estimate.title, estimate.community);
  const nickName = estimate.nickName || estimate.client;
  const community = estimate.community || 'the property';

  let grandTotal = 0;
  lines.forEach(line => {
    const lineTotal = line.qty * line.unitCost * (1 + line.markup / 100);
    grandTotal += lineTotal;
  });

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Proposal - ${estimate.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; padding: 20px; background: white; }
    .header { background-color: #1B8541; color: white; padding: 30px; text-align: center; margin-bottom: 30px; }
    .header h1 { font-size: 28px; margin: 0; font-weight: bold; }
    .date-line { text-align: right; margin-bottom: 20px; color: #666; font-size: 14px; }
    .intro { margin-bottom: 30px; text-align: justify; }
    .intro p { margin-bottom: 10px; }
    .scope-section { margin-bottom: 30px; page-break-inside: avoid; }
    .scope-title { font-size: 16px; font-weight: bold; color: #1B3A5C; margin-bottom: 10px; border-bottom: 2px solid #1B8541; padding-bottom: 5px; }
    .scope-description { margin-bottom: 15px; color: #666; font-size: 14px; }
    .line-items { margin-left: 20px; margin-bottom: 15px; }
    .line-item { margin-bottom: 8px; font-size: 14px; }
    .line-item:before { content: "\u2022 "; color: #1B8541; font-weight: bold; margin-right: 8px; }
    .total-section { margin-bottom: 40px; page-break-inside: avoid; }
    .total-price { background-color: #E8F5E9; padding: 20px; border-left: 4px solid #1B8541; text-align: right; }
    .total-price p { font-size: 14px; margin-bottom: 10px; }
    .total-price .amount { font-size: 32px; font-weight: bold; color: #1B8541; }
    .assumptions { margin-bottom: 30px; page-break-inside: avoid; }
    .assumptions h3 { font-size: 16px; font-weight: bold; color: #1B3A5C; margin-bottom: 15px; border-bottom: 2px solid #1B8541; padding-bottom: 5px; }
    .assumption-item { margin-left: 20px; margin-bottom: 12px; font-size: 13px; text-align: justify; }
    .assumption-item:before { content: counter(assumption) ". "; counter-increment: assumption; font-weight: bold; color: #1B8541; margin-right: 8px; }
    .signature-block { margin-top: 50px; display: flex; justify-content: space-between; page-break-inside: avoid; }
    .sig-column { width: 45%; border-top: 1px solid #333; padding-top: 10px; text-align: center; font-size: 12px; }
    .sig-label { font-weight: bold; margin-top: 5px; }
    .date-line-sig { margin-top: 20px; font-size: 12px; }
    .print-button { margin-bottom: 20px; text-align: center; }
    .print-button button { background-color: #1B8541; color: white; padding: 10px 30px; border: none; font-size: 16px; cursor: pointer; border-radius: 4px; }
    .print-button button:hover { background-color: #156e35; }
    @media print { .print-button { display: none; } body { padding: 0; } .container { padding: 0; max-width: 100%; } }
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
      const scopeLetter = String.fromCharCode(65 + idx);
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
  setTimeout(() => { newWindow.print(); }, 500);
}

// ============================================================================
// PARSE REPORT FUNCTION (Import)
// ============================================================================

function parseReport(data) {
  const aoa = XLSX.utils.sheet_to_json(data, { header: 1 });

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

  function getFieldValue(label) {
    for (let i = 0; i < aoa.length; i++) {
      const col0 = aoa[i][0] ? aoa[i][0].toString().trim() : '';
      if (col0.toLowerCase() === label.toLowerCase()) {
        return (aoa[i][3] || '').toString().trim();
      }
    }
    return '';
  }

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
    nickName: getFieldValue('Nick Name'),
    defaultMarkup: 100,
    scopeOfWork: '',
    created: new Date().toISOString()
  };

  for (let i = 0; i < aoa.length; i++) {
    const col0 = (aoa[i][0] || '').toString().trim();
    if (col0.toLowerCase() === 'scope of work' && i + 1 < aoa.length) {
      estimate.scopeOfWork = (aoa[i + 1][0] || '').toString().trim();
      break;
    }
  }

  const lines = [];
  let currentSection = 'General';

  for (let i = 0; i < aoa.length; i++) {
    const col0 = (aoa[i][0] || '').toString().trim();

    const scopeHeaderMatch = col0.match(/^SCOPE\s+\d+:\s+(.+)$/i);
    if (scopeHeaderMatch) {
      currentSection = scopeHeaderMatch[1].trim();
      continue;
    }

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
        markup: (parseFloat(aoa[i][5]) || 0) * 100
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

      const estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
      estimates.push(estimate);
      localStorage.setItem('agx-estimates', JSON.stringify(estimates));

      const estimateLines = JSON.parse(localStorage.getItem('agx-estimate-lines') || '[]');
      estimateLines.push(...lines);
      localStorage.setItem('agx-estimate-lines', JSON.stringify(estimateLines));

      alert(`Estimate "${estimate.title}" imported successfully`);

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
  const actionButtons = document.querySelector('#estimates-list-view .action-buttons');
  if (!actionButtons) {
    if (!injectionTimeout) {
      injectionTimeout = setTimeout(() => { injectionTimeout = null; injectImportBtn(); }, 500);
    }
    return;
  }

  if (document.getElementById('agx-import-btn')) { return; }

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

  button.addEventListener('click', () => { fileInput.click(); });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) { processImportFile(e.target.files[0]); }
  });

  actionButtons.appendChild(button);
  actionButtons.appendChild(fileInput);
}

function injectTemplateBtn() {
  const actionButtons = document.querySelector('#estimates-list-view .action-buttons');
  if (!actionButtons) {
    if (!injectionTimeout) {
      injectionTimeout = setTimeout(() => { injectionTimeout = null; injectTemplateBtn(); }, 500);
    }
    return;
  }

  if (document.getElementById('agx-template-btn')) { return; }

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

  const rows = document.querySelectorAll('#estimates-table tbody tr');
  rows.forEach(row => {
    if (row.querySelector('.agx-export-btn, .agx-proposal-btn')) { return; }

    const editBtn = row.querySelector('button[onclick*="editEstimate"]');
    if (!editBtn) return;

    const match = editBtn.getAttribute('onclick').match(/editEstimate\(['"]([^'"]+)['"]\)/);
    if (!match) return;

    const estId = match[1];
    const lastTd = row.cells[row.cells.length - 1];
    if (!lastTd) return;

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
    proposalBtn.addEventListener('click', (e) => { e.stopPropagation(); generateProposal(estId); });

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
    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportEstimate(estId); });

    lastTd.appendChild(proposalBtn);
    lastTd.appendChild(exportBtn);
  });
}

// ============================================================================
// NICK NAME FIELD INJECTION
// ============================================================================

function injectNickNameField() {
  var clientInput = document.getElementById('editEst_client');
  if (!clientInput || document.getElementById('editEst_nickName')) return;

  var clientGroup = clientInput.closest('.form-group');
  if (!clientGroup) return;

  var nickGroup = document.createElement('div');
  nickGroup.className = 'form-group';

  var label = document.createElement('label');
  label.textContent = 'Nick Name';

  var input = document.createElement('input');
  input.type = 'text';
  input.id = 'editEst_nickName';
  input.placeholder = 'Short name for proposals (e.g. Jane)';
  input.className = clientInput.className;
  input.style.cssText = clientInput.style.cssText;

  nickGroup.appendChild(label);
  nickGroup.appendChild(input);

  clientGroup.parentNode.insertBefore(nickGroup, clientGroup.nextSibling);
}

var _origEditEstimate = null;
function patchEditEstimate() {
  if (_origEditEstimate) return;
  if (typeof editEstimate !== 'function') return;
  _origEditEstimate = editEstimate;
  window.editEstimate = function(estId) {
    _origEditEstimate(estId);
    setTimeout(function() {
      injectNickNameField();
      var estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
      var est = estimates.find(function(e) { return e.id === estId; });
      var nickInput = document.getElementById('editEst_nickName');
      if (est && nickInput) { nickInput.value = est.nickName || ''; }
    }, 50);
  };
}

var _origSaveEstimateEdits = null;
function patchSaveEstimateEdits() {
  if (_origSaveEstimateEdits) return;
  if (typeof saveEstimateEdits !== 'function') return;
  _origSaveEstimateEdits = saveEstimateEdits;
  window.saveEstimateEdits = function() {
    var nickInput = document.getElementById('editEst_nickName');
    var nickVal = nickInput ? nickInput.value.trim() : '';
    _origSaveEstimateEdits();
    var estimates = JSON.parse(localStorage.getItem('agx-estimates') || '[]');
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
  // Load SheetJS
  if (typeof XLSX !== 'undefined') {
    console.log('SheetJS already loaded');
    patchEditEstimate();
    patchSaveEstimateEdits();
    if (typeof injectImportBtn === 'function') {
      injectImportBtn();
      injectExportBtns();
      injectTemplateBtn();
      injectNickNameField();
    }
  } else {
    const script = document.createElement('script');
    script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    script.onload = function() {
      console.log('SheetJS loaded');
      patchEditEstimate();
      patchSaveEstimateEdits();
      if (typeof injectImportBtn === 'function') {
        injectImportBtn();
        injectExportBtns();
        injectTemplateBtn();
        injectNickNameField();
      }
    };
    document.head.appendChild(script);
  }
  // Load ExcelJS for styled exports
  if (typeof ExcelJS === 'undefined') {
    const ejs = document.createElement('script');
    ejs.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    ejs.onload = function() { console.log('ExcelJS loaded'); };
    document.head.appendChild(ejs);
  }
})();

if (typeof XLSX !== 'undefined') {
  setTimeout(() => {
    patchEditEstimate();
    patchSaveEstimateEdits();
    injectImportBtn();
    injectExportBtns();
    injectTemplateBtn();
  }, 100);
}

setTimeout(function() {
  patchEditEstimate();
  patchSaveEstimateEdits();
}, 200);


// === Auto-inject buttons when estimates table changes ===
(function watchEstimatesTable() {
  function tryInject() {
    var table = document.getElementById('estimates-table');
    if (!table) return;
    var tbody = table.querySelector('tbody');
    if (!tbody || tbody.rows.length === 0) return;
    lastExportInjectTime = 0;
    injectExportBtns();
    injectTemplateBtn();
    injectNickNameField();
  }
  var observer = new MutationObserver(function() {
    setTimeout(tryInject, 100);
  });
  function startObserving() {
    var table = document.getElementById('estimates-table');
    if (table) {
      var tbody = table.querySelector('tbody');
      if (tbody) {
        observer.observe(tbody, { childList: true, subtree: true });
        tryInject();
        return;
      }
    }
    setTimeout(startObserving, 500);
  }
  if (document.readyState === 'complete') {
    startObserving();
  } else {
    window.addEventListener('load', startObserving);
  }
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (t && (t.getAttribute('data-tab') === 'estimates' || (t.textContent || '').trim() === 'Estimates')) {
      setTimeout(tryInject, 300);
    }
  });
})();
