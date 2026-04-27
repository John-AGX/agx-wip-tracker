function renderEstimatesList() {
            const tbody = document.querySelector('#estimates-table tbody');
            tbody.innerHTML = '';

            appData.estimates.forEach(est => {
                const lines = appData.estimateLines.filter(l => l.estimateId === est.id);
                let baseCost = 0;
                lines.forEach(l => {
                    baseCost += (l.qty || 0) * (l.unitCost || 0);
                });

                const clientPrice = baseCost * (1 + (est.defaultMarkup || 0) / 100);

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td><strong>${escapeHTML(est.title)}</strong></td>
                    <td>${escapeHTML(est.client)} - ${escapeHTML(est.community)}</td>
                    <td style="text-align: right;">${formatCurrency(baseCost)}</td>
                    <td style="text-align: right;">${est.defaultMarkup}%</td>
                    <td style="text-align: right;">${formatCurrency(clientPrice)}</td>
                    <td style="text-align: center;">
                        <button class="small" onclick="editEstimate('${escapeHTML(est.id)}')">Edit</button>
                        <button class="small" onclick="previewEstimate('${escapeHTML(est.id)}')">Preview</button>
                        <button class="small danger" onclick="deleteEstimate('${escapeHTML(est.id)}')">Delete</button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }

        function openNewEstimateForm() {
            document.getElementById('estTitle').value = '';
            document.getElementById('estJobType').value = '';
            document.getElementById('estClient').value = '';
            document.getElementById('estCommunity').value = '';
            document.getElementById('estPropertyAddr').value = '';
            document.getElementById('estBillingAddr').value = '';
            document.getElementById('estManagerName').value = '';
            document.getElementById('estManagerEmail').value = '';
            document.getElementById('estManagerPhone').value = '';
            document.getElementById('estDefaultMarkup').value = '100';
            var idEl = document.getElementById('estClientId');
            if (idEl) idEl.value = '';
            var leadEl = document.getElementById('estLeadId');
            if (leadEl) leadEl.value = '';
            // Populate the client picker from the directory cache so users
            // can auto-fill the form by selecting a client.
            if (typeof populateEstimateClientPicker === 'function') {
                populateEstimateClientPicker('estClientPicker', '');
            }
            openModal('newEstimateModal');
        }

        function createNewEstimate() {
            const est = {
                id: 'e' + Date.now(),
                title: document.getElementById('estTitle').value,
                jobType: document.getElementById('estJobType').value,
                client: document.getElementById('estClient').value,
                community: document.getElementById('estCommunity').value,
                client_id: (document.getElementById('estClientId') || {}).value || null,
                lead_id: (document.getElementById('estLeadId') || {}).value || null,
                propertyAddr: document.getElementById('estPropertyAddr').value,
                billingAddr: document.getElementById('estBillingAddr').value,
                managerName: document.getElementById('estManagerName').value,
                managerEmail: document.getElementById('estManagerEmail').value,
                managerPhone: document.getElementById('estManagerPhone').value,
                defaultMarkup: parseFloat(document.getElementById('estDefaultMarkup').value) || 100,
                scopeOfWork: document.getElementById('estScopeOfWork').value || ''
            };
            appData.estimates.push(est);
            saveData();
            closeModal('newEstimateModal');
            renderEstimatesList();
        }

        function editEstimate(estId) {
    const estimate = appData.estimates.find(e => e.id === estId);
    if (!estimate) { alert('Estimate not found'); return; }
    currentEditEstimateId = estId;
    document.getElementById('editEst_title').value = estimate.title || '';
    document.getElementById('editEst_jobType').value = estimate.jobType || '';
    document.getElementById('editEst_client').value = estimate.client || '';
    document.getElementById('editEst_community').value = estimate.community || '';
    document.getElementById('editEst_propertyAddr').value = estimate.propertyAddr || '';
    document.getElementById('editEst_billingAddr').value = estimate.billingAddr || '';
    document.getElementById('editEst_managerName').value = estimate.managerName || '';
    document.getElementById('editEst_managerEmail').value = estimate.managerEmail || '';
    document.getElementById('editEst_managerPhone').value = estimate.managerPhone || '';
    document.getElementById('editEst_scopeOfWork').value = estimate.scopeOfWork || '';
    document.getElementById('editEst_defaultMarkup').value = estimate.defaultMarkup || 0;
    var idEl = document.getElementById('editEst_clientId');
    if (idEl) idEl.value = estimate.client_id || '';
    if (typeof populateEstimateClientPicker === 'function') {
        populateEstimateClientPicker('editEstClientPicker', estimate.client_id || '');
    }
    const lineItems = appData.estimateLines.filter(line => line.estimateId === estId);
    renderEditEstimateLineItems(lineItems);
    recalcEstimateTotals();
    openModal('editEstimateModal');
    }

    function deleteEstimate(estId) {
            if (confirm('Delete this estimate?')) {
                appData.estimates = appData.estimates.filter(e => e.id !== estId);
                appData.estimateLines = appData.estimateLines.filter(l => l.estimateId !== estId);
                saveData();
                renderEstimatesList();
            }
        }

        function previewEstimate(estId) {
    const estimate = appData.estimates.find(e => e.id === estId);
    if (!estimate) { alert('Estimate not found'); return; }

    const lineItems = appData.estimateLines.filter(line => line.estimateId === estId);
    const sections = {};
    let unsectionedItems = [];
    lineItems.forEach(line => {
      if (line.section) { if (!sections[line.section]) sections[line.section] = []; sections[line.section].push(line); }
      else unsectionedItems.push(line);
    });
    let totalBaseCost = 0, totalClientPrice = 0;
    lineItems.forEach(line => {
      const base = (line.qty || 0) * (line.unitCost || 0);
      totalBaseCost += base;
      totalClientPrice += base * (1 + (line.markup || 0) / 100);
    });
    let h = '';
    h += '<div style="text-align:center;margin-bottom:30px;border-bottom:2px solid #ddd;padding-bottom:15px;">';
    h += '<h1 style="margin:0 0 5px 0;font-size:24px;">AGX Central Florida</h1>';
    h += '<p style="margin:0;color:#666;font-size:14px;">Estimating & Project Tracking</p></div>';
    h += '<div style="margin-bottom:20px;font-size:14px;">';
    h += '<div><strong>Estimate:</strong> ' + (estimate.title || '') + '</div>';
    h += '<div><strong>Client:</strong> ' + (estimate.client || '') + '</div>';
    h += '<div><strong>Community:</strong> ' + (estimate.community || '') + '</div>';
    h += '<div><strong>Property:</strong> ' + (estimate.propertyAddr || '') + '</div>';
    h += '<div><strong>Date:</strong> ' + new Date().toLocaleDateString() + '</div></div>';
    h += '<table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">';
    // Scope of Work display
    if (estimate.scopeOfWork) {
      h += '<div style="margin-bottom:16px;"><h4 style="color:var(--text);margin-bottom:8px;">Scope of Work</h4>' +
        '<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:13px;padding:12px;background:var(--surface2);border-radius:4px;border:1px solid var(--border);">' +
        estimate.scopeOfWork.replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</pre></div>';
    }
    h += '<thead><tr style="background:#f5f5f5;"><th style="border:1px solid #ccc;padding:8px;text-align:left;">Description</th>';
    h += '<th style="border:1px solid #ccc;padding:8px;text-align:center;width:70px;">Qty</th>';
    h += '<th style="border:1px solid #ccc;padding:8px;text-align:center;width:70px;">Unit</th>';
    h += '<th style="border:1px solid #ccc;padding:8px;text-align:right;width:100px;">Unit Price</th>';
    h += '<th style="border:1px solid #ccc;padding:8px;text-align:right;width:110px;">Total</th></tr></thead><tbody>';
    const renderLine = (line) => {
      const base = (line.qty || 0) * (line.unitCost || 0);
      const client = base * (1 + (line.markup || 0) / 100);
      return '<tr><td style="border:1px solid #ccc;padding:8px;">' + escapeHTML(line.description || '') + '</td>' +
        '<td style="border:1px solid #ccc;padding:8px;text-align:center;">' + (line.qty || 0) + '</td>' +
        '<td style="border:1px solid #ccc;padding:8px;text-align:center;">' + (line.unit || '') + '</td>' +
        '<td style="border:1px solid #ccc;padding:8px;text-align:right;">' + formatCurrency(line.unitCost || 0) + '</td>' +
        '<td style="border:1px solid #ccc;padding:8px;text-align:right;">' + formatCurrency(client) + '</td></tr>';
    };
    unsectionedItems.forEach(l => { h += renderLine(l); });
    Object.keys(sections).forEach(name => {
      h += '<tr style="background:#f9f9f9;font-weight:bold;"><td colspan="5" style="border:1px solid #ccc;padding:10px 8px;">' + name + '</td></tr>';
      let secTotal = 0;
      sections[name].forEach(l => { h += renderLine(l); const b = (l.qty||0)*(l.unitCost||0); secTotal += b*(1+(l.markup||0)/100); });
      h += '<tr style="background:#f0f0f0;font-weight:bold;"><td colspan="4" style="border:1px solid #ccc;padding:8px;text-align:right;">Section Subtotal:</td>';
      h += '<td style="border:1px solid #ccc;padding:8px;text-align:right;">' + formatCurrency(secTotal) + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<div style="text-align:right;margin-top:20px;">';
    h += '<div style="margin-bottom:10px;">Base Cost: <span style="margin-left:50px;">' + formatCurrency(totalBaseCost) + '</span></div>';
    h += '<div style="font-size:16pt;color:#2ecc71;font-weight:bold;">Client Price: <span style="margin-left:30px;">' + formatCurrency(totalClientPrice) + '</span></div></div>';
    document.getElementById('estimatePreview_content').innerHTML = h;
    openModal('estimatePreviewModal');
    }

    function saveEstimateEdits() {
    const estId = currentEditEstimateId;
    const estimate = appData.estimates.find(e => e.id === estId);
    if (!estimate) { alert('Estimate not found'); return; }
    estimate.title = document.getElementById('editEst_title').value;
    estimate.jobType = document.getElementById('editEst_jobType').value;
    estimate.client = document.getElementById('editEst_client').value;
    estimate.community = document.getElementById('editEst_community').value;
    var clientIdEl = document.getElementById('editEst_clientId');
    estimate.client_id = clientIdEl ? (clientIdEl.value || null) : (estimate.client_id || null);
    estimate.propertyAddr = document.getElementById('editEst_propertyAddr').value;
    estimate.billingAddr = document.getElementById('editEst_billingAddr').value;
    estimate.managerName = document.getElementById('editEst_managerName').value;
    estimate.managerEmail = document.getElementById('editEst_managerEmail').value;
    estimate.managerPhone = document.getElementById('editEst_managerPhone').value;
    estimate.scopeOfWork = document.getElementById('editEst_scopeOfWork').value;
    estimate.defaultMarkup = parseFloat(document.getElementById('editEst_defaultMarkup').value) || 0;
    const rows = document.querySelectorAll('#editEstimate_lineItemsBody tr[data-line-id]');
    const updatedIds = new Set();
    rows.forEach(row => {
      const lineId = row.dataset.lineId;
      if (!lineId) return;
      updatedIds.add(lineId);
      const line = appData.estimateLines.find(l => l.id === lineId);
      if (line) {
        line.description = row.querySelector('[data-field="description"]').value;
        line.qty = parseFloat(row.querySelector('[data-field="qty"]').value) || 0;
        line.unit = row.querySelector('[data-field="unit"]').value;
        line.unitCost = parseFloat(row.querySelector('[data-field="unitCost"]').value) || 0;
        line.markup = parseFloat(row.querySelector('[data-field="markup"]').value) || estimate.defaultMarkup;
      }
    });
    appData.estimateLines = appData.estimateLines.filter(l => l.estimateId !== estId || updatedIds.has(l.id));
    saveData();
    closeModal('editEstimateModal');
    renderEstimatesList();
    }

    function addEstimateLineRow(estimateId, section) {
    section = section || '';
    const est = appData.estimates.find(e => e.id === estimateId);
    const newLine = {
      id: 'el_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      estimateId: estimateId, section: section, description: '',
      qty: 1, unit: 'ea', unitCost: 0, markup: est ? est.defaultMarkup : 0
    };
    appData.estimateLines.push(newLine);
    const lineItems = appData.estimateLines.filter(l => l.estimateId === estimateId);
    renderEditEstimateLineItems(lineItems);
    recalcEstimateTotals();
    }

    function removeEstimateLineRow(lineId) {
    appData.estimateLines = appData.estimateLines.filter(l => l.id !== lineId);
    const lineItems = appData.estimateLines.filter(l => l.estimateId === currentEditEstimateId);
    renderEditEstimateLineItems(lineItems);
    recalcEstimateTotals();
    }

    function addEstimateSection() {
    const name = prompt('Enter section name (e.g., Demo, Repairs, Paint):');
    if (!name || !name.trim()) return;
    addEstimateLineRow(currentEditEstimateId, name.trim());
    }

    function recalcEstimateTotals() {
    let totalBase = 0, totalClient = 0;
    const rows = document.querySelectorAll('#editEstimate_lineItemsBody tr[data-line-id]');
    rows.forEach(row => {
      const qty = parseFloat(row.querySelector('[data-field="qty"]')?.value) || 0;
      const cost = parseFloat(row.querySelector('[data-field="unitCost"]')?.value) || 0;
      const markup = parseFloat(row.querySelector('[data-field="markup"]')?.value) || 0;
      const base = qty * cost;
      const client = base * (1 + markup / 100);
      totalBase += base;
      totalClient += client;
      const totalCell = row.querySelector('[data-field="lineTotal"]');
      if (totalCell) totalCell.textContent = formatCurrency(client);
    });
    const bc = document.getElementById('editEstimate_baseCost');
    const cp = document.getElementById('editEstimate_clientPrice');
    if (bc) bc.textContent = formatCurrency(totalBase);
    if (cp) cp.textContent = formatCurrency(totalClient);
    }

    function renderEditEstimateLineItems(lineItems) {
    const tbody = document.getElementById('editEstimate_lineItemsBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const sections = {};
    let unsectioned = [];
    lineItems.forEach(l => {
      if (l.section) { if (!sections[l.section]) sections[l.section] = []; sections[l.section].push(l); }
      else unsectioned.push(l);
    });
    unsectioned.forEach(l => tbody.appendChild(createEditLineItemRow(l)));
    Object.keys(sections).forEach(name => {
      const hdr = document.createElement('tr');
      hdr.className = 'section-header';
      hdr.innerHTML = '<td colspan="5" style="padding:10px 8px;">' + escapeHTML(name) + '</td><td colspan="2" style="padding:10px 8px;text-align:right;"><button class="secondary small" onclick="addEstimateLineRow(currentEditEstimateId, \'' + escapeHTML(name).replace(/'/g, "\\'") + '\')" style="font-size:11px;padding:3px 8px;">+ Line Item</button></td>';
      tbody.appendChild(hdr);
      sections[name].forEach(l => tbody.appendChild(createEditLineItemRow(l)));
    });
    }

    function createEditLineItemRow(line) {
    const row = document.createElement('tr');
    row.dataset.lineId = line.id;
    const base = (line.qty || 0) * (line.unitCost || 0);
    const client = base * (1 + (line.markup || 0) / 100);
    const units = ['sqft','lf','ea','hr','ls','sf','sy','cf','cy','gal'];
    let unitOpts = '';
    units.forEach(u => { unitOpts += '<option value="' + u + '"' + (line.unit === u ? ' selected' : '') + '>' + u + '</option>'; });
    row.innerHTML = '<td style="padding:8px;"><input type="text" data-field="description" value="' + escapeHTML(line.description || '') + '" placeholder="Item description" oninput="recalcEstimateTotals()" style="width:100%;"></td>' +
      '<td style="padding:8px;"><input type="number" data-field="qty" value="' + (line.qty || 1) + '" min="0" step="0.01" oninput="recalcEstimateTotals()" style="width:100%;text-align:center;"></td>' +
      '<td style="padding:8px;"><select data-field="unit" style="width:100%;">' + unitOpts + '</select></td>' +
      '<td style="padding:8px;"><input type="number" data-field="unitCost" value="' + (line.unitCost || 0) + '" min="0" step="0.01" oninput="recalcEstimateTotals()" style="width:100%;text-align:right;"></td>' +
      '<td style="padding:8px;"><input type="number" data-field="markup" value="' + (line.markup || 0) + '" min="0" step="1" oninput="recalcEstimateTotals()" style="width:100%;text-align:center;"></td>' +
      '<td style="padding:8px;text-align:right;color:var(--green);font-weight:bold;"><span data-field="lineTotal">' + formatCurrency(client) + '</span></td>' +
      '<td style="padding:8px;text-align:center;"><button class="estimate-line-delete" onclick="removeEstimateLineRow(\'' + line.id + '\')">X</button></td>';
    return row;
    }

    