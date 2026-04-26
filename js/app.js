
    let currentEditEstimateId = null;

        // ==================== THEME TOGGLE ====================
        (function() {
            var saved = localStorage.getItem('agx-theme');
            if (saved === 'light') document.body.classList.add('light-mode');
            else if (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
                document.body.classList.add('light-mode');
            }
            function updateIcon() {
                var btn = document.getElementById('theme-toggle');
                if (btn) btn.textContent = document.body.classList.contains('light-mode') ? '\u263E' : '\u2600';
            }
            updateIcon();
            document.addEventListener('DOMContentLoaded', function() {
                updateIcon();
                var btn = document.getElementById('theme-toggle');
                if (!btn) return;
                btn.addEventListener('click', function() {
                    document.body.classList.toggle('light-mode');
                    var isLight = document.body.classList.contains('light-mode');
                    localStorage.setItem('agx-theme', isLight ? 'light' : 'dark');
                    updateIcon();
                    document.dispatchEvent(new CustomEvent('agx-theme-change', { detail: { isLight: isLight } }));
                });
            });
        })();

        // ==================== UTILITIES ====================
        const formatCurrency = (val) => {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);
        };

        function safeLoadJSON(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                if (raw === null) return fallback;
                return JSON.parse(raw);
            } catch (e) {
                console.warn('Corrupted localStorage key:', key, e);
                return fallback;
            }
        }

        function escapeHTML(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        const getStatus = (spent, budget) => {
            if (budget <= 0) return 'on-track';
            const pct = (spent / budget) * 100;
            if (pct > 100) return 'over-budget';
            if (pct >= 85) return 'at-risk';
            return 'on-track';
        };

        const openModal = (id) => document.getElementById(id).classList.add('active');
        const closeModal = (id) => document.getElementById(id).classList.remove('active');

        // ==================== INITIALIZATION ====================
        // === Customizable Dropdown System ===
        const DEFAULT_PHASE_TYPES = [
            'Site Work', 'Foundation', 'Framing/Structural', 'Rough-In MEP', 'Insulation',
            'Drywall', 'Roofing', 'Exterior Finishes', 'Interior Finishes', 'Flooring',
            'Painting', 'Cabinets & Millwork', 'Plumbing Fixtures', 'Electrical Fixtures',
            'HVAC', 'Fire Protection', 'Landscaping', 'Paving/Concrete Flatwork', 'Punch List/Closeout'
        ];
        const DEFAULT_SUB_TRADES = [
            'General', 'Electrical', 'Plumbing', 'HVAC', 'Roofing', 'Painting', 'Framing',
            'Concrete', 'Drywall', 'Flooring', 'Landscaping', 'Fire Protection', 'Insulation',
            'Demolition', 'Waterproofing', 'Glass/Glazing', 'Masonry', 'Steel/Iron'
        ];

        function getCustomItems(key) {
            return safeLoadJSON(key, []);
        }
        function saveCustomItems(key, items) {
            localStorage.setItem(key, JSON.stringify(items));
        }

        function populateCustomSelect(selectId, defaults, storageKey, placeholder) {
            const sel = document.getElementById(selectId);
            if (!sel) return;
            const currentVal = sel.value;
            const custom = getCustomItems(storageKey);
            const lt = String.fromCharCode(60);
            const gt = String.fromCharCode(62);
            let html = lt + 'option value=""' + gt + (placeholder || '-- Select --') + lt + '/option' + gt;
            // Default options
            defaults.forEach(item => {
                html += lt + 'option value="' + item + '"' + gt + item + lt + '/option' + gt;
            });
            // Custom options (with marker)
            if (custom.length > 0) {
                html += lt + 'option disabled' + gt + '── Custom ──' + lt + '/option' + gt;
                custom.forEach(item => {
                    html += lt + 'option value="' + item + '"' + gt + item + lt + '/option' + gt;
                });
            }
            // Action items
            html += lt + 'option disabled' + gt + '──────────────' + lt + '/option' + gt;
            html += lt + 'option value="__add_new__"' + gt + '+ Add New...' + lt + '/option' + gt;
            if (custom.length > 0) {
                html += lt + 'option value="__manage__"' + gt + '✎ Manage List...' + lt + '/option' + gt;
            }
            sel.innerHTML = html;
            // Restore previous value if it exists
            if (currentVal) {
                // Check if value exists in options
                const optExists = Array.from(sel.options).some(o => o.value === currentVal);
                if (optExists) {
                    sel.value = currentVal;
                } else if (currentVal && currentVal !== '__add_new__' && currentVal !== '__manage__') {
                    // Value was custom but not saved yet - add it
                    sel.value = currentVal;
                }
            }
        }

        function handleCustomSelectChange(selectId, defaults, storageKey, placeholder) {
            const sel = document.getElementById(selectId);
            if (!sel) return;
            const val = sel.value;
            if (val === '__add_new__') {
                sel.value = '';
                const newItem = prompt('Enter new item name:');
                if (newItem && newItem.trim()) {
                    const trimmed = newItem.trim();
                    // Check if already exists
                    if (!defaults.includes(trimmed) && !getCustomItems(storageKey).includes(trimmed)) {
                        const custom = getCustomItems(storageKey);
                        custom.push(trimmed);
                        saveCustomItems(storageKey, custom);
                    }
                    populateCustomSelect(selectId, defaults, storageKey, placeholder);
                    sel.value = trimmed;
                }
            } else if (val === '__manage__') {
                sel.value = '';
                openManageListModal(selectId, defaults, storageKey, placeholder);
            }
        }

        function openManageListModal(selectId, defaults, storageKey, placeholder) {
            const custom = getCustomItems(storageKey);
            if (custom.length === 0) return;
            const lt = String.fromCharCode(60);
            const gt = String.fromCharCode(62);
            // Create a simple modal overlay for managing items
            let overlay = document.getElementById('manageListOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'manageListOverlay';
                overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
                document.body.appendChild(overlay);
            }
            let listHtml = '';
            custom.forEach((item, i) => {
                listHtml += lt + 'div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border,#333);"' + gt +
                    lt + 'span style="color:var(--text,#fff);"' + gt + item + lt + '/span' + gt +
                    lt + 'button onclick="deleteCustomItem(\''+storageKey+'\','+i+',\''+selectId+'\',\''+placeholder+'\')" style="background:#e74c3c;color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;"' + gt + 'Delete' + lt + '/button' + gt +
                    lt + '/div' + gt;
            });
            overlay.innerHTML = lt + 'div style="background:var(--card-bg,#1a1a2e);border-radius:12px;padding:20px;min-width:300px;max-width:400px;border:1px solid var(--border,#333);"' + gt +
                lt + 'div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;"' + gt +
                lt + 'h3 style="margin:0;color:var(--text,#fff);"' + gt + 'Manage Custom Items' + lt + '/h3' + gt +
                lt + 'button onclick="closeManageList()" style="background:none;border:none;color:var(--text-dim,#888);font-size:20px;cursor:pointer;"' + gt + '×' + lt + '/button' + gt +
                lt + '/div' + gt +
                lt + 'div style="max-height:300px;overflow-y:auto;"' + gt + listHtml + lt + '/div' + gt +
                lt + '/div' + gt;
            overlay.style.display = 'flex';
            // Store context for delete function
            window._manageListCtx = {selectId, defaults, storageKey, placeholder};
        }

        function closeManageList() {
            const overlay = document.getElementById('manageListOverlay');
            if (overlay) overlay.style.display = 'none';
        }

        function deleteCustomItem(storageKey, index, selectId, placeholder) {
            const custom = getCustomItems(storageKey);
            custom.splice(index, 1);
            saveCustomItems(storageKey, custom);
            const ctx = window._manageListCtx;
            if (ctx) {
                populateCustomSelect(ctx.selectId, ctx.defaults, ctx.storageKey, ctx.placeholder);
                if (custom.length > 0) {
                    openManageListModal(ctx.selectId, ctx.defaults, ctx.storageKey, ctx.placeholder);
                } else {
                    closeManageList();
                }
            }
        }

        function populatePhaseTypeSelect() {
            populateCustomSelect('phaseType', DEFAULT_PHASE_TYPES, 'agx-wip-custom-phases', '-- Select Phase --');
        }
        function populateSubTradeSelect() {
            populateCustomSelect('subTrade', DEFAULT_SUB_TRADES, 'agx-wip-custom-trades', '-- Select Trade --');
        }

        function initializeApp() {
            loadData();
            setupEventListeners();
            seedDataIfNeeded();
            backfillSampleData();
            migrateBudgetFields();
            renderWIPMain();
        }

        function migrateBudgetFields() {
            var changed = false;
            appData.buildings.forEach(function(b) {
                if (b.asSoldBudget == null && b.budget) {
                    b.asSoldBudget = b.budget;
                    b.coBudget = 0;
                    changed = true;
                }
            });
            appData.phases.forEach(function(p) {
                if (p.asSoldPhaseBudget == null && p.phaseBudget) {
                    p.asSoldPhaseBudget = p.phaseBudget;
                    p.coPhaseBudget = 0;
                    changed = true;
                }
            });
            if (changed) saveData();
        }

        function backfillSampleData() {
            // Server is source of truth when authenticated — never inject demo data
            if (window.agxApi && window.agxApi.isAuthenticated()) return;
            var changed = false;
            if (appData.jobs.some(j => j.id === 'j1') && appData.purchaseOrders.length === 0) {
                appData.purchaseOrders = [
                    { id: 'po1', jobId: 'j1', poNumber: 'PO-001', vendor: 'Apex Electrical', description: 'Main electrical panel + conduit', amount: 145000, billedToDate: 72500, date: '2026-01-20', status: 'Open', notes: 'Net 30' },
                    { id: 'po2', jobId: 'j1', poNumber: 'PO-002', vendor: 'Summit Plumbing', description: 'Plumbing rough-in materials', amount: 89000, billedToDate: 89000, date: '2026-02-05', status: 'Closed', notes: '' },
                    { id: 'po3', jobId: 'j1', poNumber: 'PO-003', vendor: 'CoolAir Mechanical', description: 'HVAC units - Building B', amount: 210000, billedToDate: 63000, date: '2026-03-10', status: 'Open', notes: 'Partial shipment received' }
                ];
                changed = true;
            }
            if (appData.jobs.some(j => j.id === 'j1') && appData.invoices.length === 0) {
                appData.invoices = [
                    { id: 'inv1', jobId: 'j1', invNumber: 'INV-001', vendor: 'Apex Electrical', description: 'Electrical rough-in progress billing', amount: 72500, date: '2026-02-20', dueDate: '2026-03-22', status: 'Paid', notes: '' },
                    { id: 'inv2', jobId: 'j1', invNumber: 'INV-002', vendor: 'CoolAir Mechanical', description: 'HVAC unit delivery - partial', amount: 63000, date: '2026-03-15', dueDate: '2026-04-14', status: 'Sent', notes: 'Awaiting approval' },
                    { id: 'inv3', jobId: 'j1', invNumber: 'INV-003', vendor: 'IronWorks Steel', description: 'Structural steel fabrication', amount: 156000, date: '2026-04-01', dueDate: '2026-05-01', status: 'Draft', notes: '' }
                ];
                changed = true;
            }
            if (changed) saveData();
        }

        function setupEventListeners() {
            // Top-level tabs
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const tabName = btn.getAttribute('data-tab');
                    switchTab(tabName);
                });
            });

            // Job detail sub-tabs
            document.querySelectorAll('.sub-tab-btn-job').forEach(btn => {
                btn.addEventListener('click', () => {
                    const subtabName = btn.getAttribute('data-subtab');
                    switchJobSubTab(subtabName);
                });
            });

            // Modal closes on background click
            document.querySelectorAll('.modal').forEach(modal => {
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) {
                        closeModal(modal.id);
                    }
                });
            });
        }

        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

            document.getElementById(tabName)?.classList.add('active');
            document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');

            if (tabName === 'estimates') {
                renderEstimatesList();
            } else if (tabName === 'insights') {
                if (typeof renderInsightsDashboard === 'function') renderInsightsDashboard();
            } else if (tabName === 'admin') {
                if (typeof renderAdminUsers === 'function') renderAdminUsers();
            } else {
                // Returning to WIP from another tab: force back to the main job
                // list, even if a job detail was previously open. Without this
                // reset the detail view stays layered on top and steals clicks.
                renderWIPMain();
                var archiveView = document.getElementById('archived-jobs-list');
                if (archiveView) archiveView.style.display = 'none';
                var mainView = document.getElementById('wip-main-view');
                if (mainView) mainView.style.display = '';
                var detailView = document.getElementById('wip-job-detail-view');
                if (detailView) detailView.style.display = 'none';
                appState.currentJobId = null;
            }
        }

        // Hardening for read-only mode: walks every button in the detail view
        // and sets the native HTML `disabled` attribute on anything that's not
        // in the navigation whitelist. CSS pointer-events does most of the
        // work, but inline-styled buttons (or workspace internals rebuilt by
        // js/workspace-layout.js) can defeat the cascade. The disabled
        // attribute is a hard browser-level block. Safe to call repeatedly.
        function applyReadOnlyButtonGuard() {
            var detail = document.getElementById('wip-job-detail-view');
            if (!detail) return;
            var readOnly = detail.classList.contains('read-only-mode');
            // Selector for buttons that should remain interactive in read-only mode.
            var allowed = '.job-detail-header button, .sub-tab-btn-job, .ws-right-tab, .card-toggle, [data-readonly-allowed], .modal button';
            detail.querySelectorAll('button').forEach(function(btn) {
                if (!readOnly) {
                    if (btn.dataset.readonlyDisabled === '1') {
                        btn.removeAttribute('disabled');
                        delete btn.dataset.readonlyDisabled;
                    }
                    return;
                }
                if (btn.matches(allowed)) {
                    if (btn.dataset.readonlyDisabled === '1') {
                        btn.removeAttribute('disabled');
                        delete btn.dataset.readonlyDisabled;
                    }
                } else if (!btn.disabled) {
                    btn.setAttribute('disabled', 'true');
                    btn.dataset.readonlyDisabled = '1';
                }
            });
        }
        window.applyReadOnlyButtonGuard = applyReadOnlyButtonGuard;

        function switchJobSubTab(subtabName) {
            document.querySelectorAll('.sub-tab-content-job').forEach(stc => stc.classList.remove('active'));
            document.querySelectorAll('.sub-tab-btn-job').forEach(btn => btn.classList.remove('active'));

            document.getElementById(subtabName)?.classList.add('active');
            document.querySelector(`[data-subtab="${subtabName}"]`)?.classList.add('active');

            const currentJobId = appState.currentJobId;
            if (subtabName === 'job-overview') renderJobOverview(currentJobId);
            else if (subtabName === 'job-costs') renderJobCosts(currentJobId);
            else if (subtabName === 'job-buildings') renderJobBuildings(currentJobId);
            else if (subtabName === 'job-phases') renderJobPhases(currentJobId);
            else if (subtabName === 'job-subs') renderJobSubs(currentJobId);
            else if (subtabName === 'job-purchaseorders') renderPurchaseOrders(currentJobId);
            else if (subtabName === 'job-invoices') renderInvoices(currentJobId);
            else if (subtabName === 'job-labor') renderJobLabor(currentJobId);
            else if (subtabName === 'job-weekly') renderJobWeekly(currentJobId);

            // Re-apply read-only button guard after the new sub-tab content renders.
            // setTimeout 0 lets the synchronous render finish first.
            setTimeout(applyReadOnlyButtonGuard, 0);
        }

        // ==================== DATA STORAGE ====================
        let appData = {
            jobs: [],
            buildings: [],
            phases: [],
            subs: [],
            changeOrders: [],
            purchaseOrders: [],
            invoices: [],
            estimates: [],
            estimateLines: [],
            estimateAlternates: []
        };

        let appState = {
            currentJobId: null,
            currentStatusFilter: '',
            currentTypeFilter: '',
            sortColumn: null,
            sortDirection: null,
            editPhaseId: null,
            editBuildingId: null,
            editSubId: null,
            editCOId: null,
            editPOId: null,
            editInvId: null
        };

        // Read all appData sections from localStorage. Used as the offline path
        // and as the fast first-paint cache while the server fetch is in flight.
        function loadFromLocalStorage() {
            appData.jobs = safeLoadJSON('agx-wip-jobs', []);
            appData.buildings = safeLoadJSON('agx-wip-buildings', []);
            appData.phases = safeLoadJSON('agx-wip-phases', []);
            appData.subs = safeLoadJSON('agx-wip-subs', []);
            appData.changeOrders = safeLoadJSON('agx-wip-changeorders', []);
            appData.purchaseOrders = safeLoadJSON('agx-wip-purchaseorders', []);
            appData.invoices = safeLoadJSON('agx-wip-invoices', []);
            appData.estimates = safeLoadJSON('agx-estimates', []);
            appData.estimateLines = safeLoadJSON('agx-estimate-lines', []);
            appData.estimateAlternates = safeLoadJSON('agx-estimate-alternates', []);
        }

        function writeToLocalStorage() {
            localStorage.setItem('agx-wip-jobs', JSON.stringify(appData.jobs));
            localStorage.setItem('agx-wip-buildings', JSON.stringify(appData.buildings));
            localStorage.setItem('agx-wip-phases', JSON.stringify(appData.phases));
            localStorage.setItem('agx-wip-subs', JSON.stringify(appData.subs));
            localStorage.setItem('agx-wip-changeorders', JSON.stringify(appData.changeOrders));
            localStorage.setItem('agx-wip-purchaseorders', JSON.stringify(appData.purchaseOrders));
            localStorage.setItem('agx-wip-invoices', JSON.stringify(appData.invoices));
            localStorage.setItem('agx-estimates', JSON.stringify(appData.estimates));
            localStorage.setItem('agx-estimate-lines', JSON.stringify(appData.estimateLines));
            localStorage.setItem('agx-estimate-alternates', JSON.stringify(appData.estimateAlternates));
        }

        // Reconstruct flat appData arrays from server response. The server stores
        // each job's nested entities (buildings/phases/subs/etc.) inside its JSONB
        // blob; this fans them back out into the top-level arrays the UI expects.
        function hydrateFromServerJobs(serverJobs) {
            appData.jobs = [];
            appData.buildings = [];
            appData.phases = [];
            appData.changeOrders = [];
            appData.subs = [];
            appData.purchaseOrders = [];
            appData.invoices = [];
            (serverJobs || []).forEach(function(j) {
                var buildings = j.buildings || [];
                var phases = j.phases || [];
                var changeOrders = j.changeOrders || [];
                var subs = j.subs || [];
                var purchaseOrders = j.purchaseOrders || [];
                var invoices = j.invoices || [];
                var jobMeta = Object.assign({}, j);
                delete jobMeta.buildings;
                delete jobMeta.phases;
                delete jobMeta.changeOrders;
                delete jobMeta.subs;
                delete jobMeta.purchaseOrders;
                delete jobMeta.invoices;
                appData.jobs.push(jobMeta);
                Array.prototype.push.apply(appData.buildings, buildings);
                Array.prototype.push.apply(appData.phases, phases);
                Array.prototype.push.apply(appData.changeOrders, changeOrders);
                Array.prototype.push.apply(appData.subs, subs);
                Array.prototype.push.apply(appData.purchaseOrders, purchaseOrders);
                Array.prototype.push.apply(appData.invoices, invoices);
            });
        }

        function hydrateFromServerEstimates(serverEstimates) {
            appData.estimates = [];
            appData.estimateLines = [];
            appData.estimateAlternates = [];
            (serverEstimates || []).forEach(function(e) {
                var lines = e.lines || [];
                var alternates = e.alternates || [];
                var meta = Object.assign({}, e);
                delete meta.lines;
                delete meta.alternates;
                appData.estimates.push(meta);
                Array.prototype.push.apply(appData.estimateLines, lines);
                Array.prototype.push.apply(appData.estimateAlternates, alternates);
            });
        }

        // loadData is called once at startup. When authenticated, fetch from the
        // server and replace local state with the authoritative copy. Offline mode
        // (or no token) keeps the localStorage-only behavior.
        function loadData() {
            loadFromLocalStorage();
            if (window.agxApi && window.agxApi.isAuthenticated()) {
                Promise.all([
                    window.agxApi.jobs.list(),
                    window.agxApi.estimates.list()
                ]).then(function(results) {
                    hydrateFromServerJobs(results[0].jobs);
                    hydrateFromServerEstimates(results[1].estimates);
                    writeToLocalStorage();
                    if (typeof renderWIPMain === 'function') renderWIPMain();
                    if (typeof renderEstimatesList === 'function') renderEstimatesList();
                }).catch(function(err) {
                    console.warn('Server load failed, staying on localStorage cache:', err.message);
                });
            }
        }

        // saveData writes to localStorage immediately (cheap, synchronous) so the
        // existing call sites stay correct, and schedules a debounced push to the
        // server when authenticated. Offline mode is localStorage-only.
        var _serverPushTimer = null;
        function saveData() {
            writeToLocalStorage();
            if (!window.agxApi || !window.agxApi.isAuthenticated()) return;
            if (_serverPushTimer) clearTimeout(_serverPushTimer);
            _serverPushTimer = setTimeout(pushToServer, 600);
        }

        function pushToServer() {
            if (!window.agxApi || !window.agxApi.isAuthenticated()) return Promise.resolve();
            // Only push jobs the current user can edit. _canEdit comes from the
            // server on each GET. Read-only jobs (e.g. another PM's job that this
            // user can view but not modify) are filtered out so PMs scrolling the
            // list don't accidentally overwrite each other's data.
            var editableJobs = appData.jobs.filter(function(j) { return j._canEdit !== false; });
            var editableIds = {};
            editableJobs.forEach(function(j) { editableIds[j.id] = true; });

            var jobsPayload = {
                jobs: editableJobs,
                buildings: appData.buildings.filter(function(b) { return editableIds[b.jobId]; }),
                phases: appData.phases.filter(function(p) { return editableIds[p.jobId]; }),
                changeOrders: appData.changeOrders.filter(function(c) { return editableIds[c.jobId]; }),
                subs: appData.subs.filter(function(s) { return editableIds[s.jobId]; }),
                purchaseOrders: appData.purchaseOrders.filter(function(p) { return editableIds[p.jobId]; }),
                invoices: appData.invoices.filter(function(i) { return editableIds[i.jobId]; })
            };
            var estimatesPayload = {
                estimates: appData.estimates,
                estimateLines: appData.estimateLines,
                estimateAlternates: appData.estimateAlternates
            };
            return Promise.all([
                editableJobs.length ? window.agxApi.jobs.bulkSave(jobsPayload) : Promise.resolve(),
                appData.estimates.length ? window.agxApi.estimates.bulkSave(estimatesPayload) : Promise.resolve()
            ]).catch(function(err) {
                console.warn('Server push failed:', err.message);
            });
        }

        // Expose for explicit triggers (e.g. the import-from-browser button)
        window.agxData = {
            pushToServer: pushToServer,
            reloadFromServer: loadData
        };

        // ==================== IMPORT FROM BROWSER ====================
        // One-time migration UI: read jobs/estimates from this browser's localStorage,
        // OR from JSON pasted in from another origin (e.g. the GitHub Pages deploy),
        // and push selected ones to the server.

        // Holds the current import source — either pulled from localStorage on this
        // origin or parsed from a JSON paste. Has the same shape as appData.
        var _importSource = null;

        function readLocalStorageAsImportSource() {
            return {
                jobs: safeLoadJSON('agx-wip-jobs', []),
                buildings: safeLoadJSON('agx-wip-buildings', []),
                phases: safeLoadJSON('agx-wip-phases', []),
                subs: safeLoadJSON('agx-wip-subs', []),
                changeOrders: safeLoadJSON('agx-wip-changeorders', []),
                purchaseOrders: safeLoadJSON('agx-wip-purchaseorders', []),
                invoices: safeLoadJSON('agx-wip-invoices', []),
                estimates: safeLoadJSON('agx-estimates', []),
                estimateLines: safeLoadJSON('agx-estimate-lines', []),
                estimateAlternates: safeLoadJSON('agx-estimate-alternates', [])
            };
        }

        function renderImportJobsList() {
            var listEl = document.getElementById('importBrowser_jobsList');
            var src = _importSource || { jobs: [], estimates: [] };
            if (!src.jobs.length) {
                listEl.innerHTML = '<div style="padding:15px;color:var(--text-dim,#888);">No jobs in source.</div>';
            } else {
                var html = '';
                src.jobs.forEach(function(j) {
                    var label = (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.id) +
                                (j.client ? ' — ' + j.client : '');
                    html += '<label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border,#333);cursor:pointer;">' +
                            '<input type="checkbox" class="importBrowser_jobChk" data-job-id="' + escapeHTML(j.id) + '" />' +
                            '<span style="font-size:13px;color:var(--text,#fff);">' + escapeHTML(label) + '</span>' +
                            '</label>';
                });
                listEl.innerHTML = html;
            }
            document.getElementById('importBrowser_estimatesLabel').textContent =
                'Also push estimates (' + (src.estimates ? src.estimates.length : 0) + ' in source)';
        }

        function openImportFromBrowserModal() {
            if (!window.agxApi || !window.agxApi.isAuthenticated()) {
                alert('Log in to the server first. Offline mode has no server to push to.');
                return;
            }
            switchImportSource('local');
            document.getElementById('importBrowser_estimatesChk').checked = false;
            document.getElementById('importBrowser_status').textContent = '';
            document.getElementById('importBrowser_runBtn').disabled = false;
            openModal('importBrowserModal');
        }

        function switchImportSource(source) {
            var localTab = document.getElementById('importBrowser_tabLocal');
            var pasteTab = document.getElementById('importBrowser_tabPaste');
            var pasteSection = document.getElementById('importBrowser_pasteSection');

            if (source === 'paste') {
                localTab.style.borderBottomColor = 'transparent';
                localTab.style.color = 'var(--text-dim,#888)';
                pasteTab.style.borderBottomColor = '#4f8cff';
                pasteTab.style.color = 'var(--text,#fff)';
                pasteSection.style.display = '';
                // Don't replace _importSource yet — wait for parseImportJSON
                if (!_importSource || _importSource.__source !== 'paste') {
                    _importSource = { jobs: [], estimates: [], __source: 'paste' };
                    renderImportJobsList();
                }
            } else {
                pasteTab.style.borderBottomColor = 'transparent';
                pasteTab.style.color = 'var(--text-dim,#888)';
                localTab.style.borderBottomColor = '#4f8cff';
                localTab.style.color = 'var(--text,#fff)';
                pasteSection.style.display = 'none';
                _importSource = readLocalStorageAsImportSource();
                _importSource.__source = 'local';
                renderImportJobsList();
            }
        }

        function parseImportJSON() {
            var statusEl = document.getElementById('importBrowser_status');
            var raw = document.getElementById('importBrowser_pasteText').value.trim();
            if (!raw) {
                statusEl.style.color = '#fbbf24';
                statusEl.textContent = 'Paste the JSON output first.';
                return;
            }
            try {
                var parsed = JSON.parse(raw);
                _importSource = {
                    jobs: parsed.jobs || [],
                    buildings: parsed.buildings || [],
                    phases: parsed.phases || [],
                    subs: parsed.subs || [],
                    changeOrders: parsed.changeOrders || [],
                    purchaseOrders: parsed.purchaseOrders || [],
                    invoices: parsed.invoices || [],
                    estimates: parsed.estimates || [],
                    estimateLines: parsed.estimateLines || [],
                    estimateAlternates: parsed.estimateAlternates || [],
                    __source: 'paste'
                };
                renderImportJobsList();
                statusEl.style.color = '#34d399';
                statusEl.textContent = 'Parsed: ' + _importSource.jobs.length + ' job(s), ' +
                                       _importSource.estimates.length + ' estimate(s). Pick which to import below.';
            } catch (e) {
                statusEl.style.color = '#e74c3c';
                statusEl.textContent = 'Could not parse JSON: ' + e.message;
            }
        }

        function runImportFromBrowser() {
            var statusEl = document.getElementById('importBrowser_status');
            var btn = document.getElementById('importBrowser_runBtn');
            if (!_importSource) {
                statusEl.style.color = '#fbbf24';
                statusEl.textContent = 'No source selected.';
                return;
            }
            var picked = {};
            document.querySelectorAll('.importBrowser_jobChk:checked').forEach(function(chk) {
                picked[chk.getAttribute('data-job-id')] = true;
            });
            var includeEstimates = document.getElementById('importBrowser_estimatesChk').checked;
            var jobIds = Object.keys(picked);
            if (!jobIds.length && !includeEstimates) {
                statusEl.style.color = '#fbbf24';
                statusEl.textContent = 'Pick at least one job, or check the estimates box.';
                return;
            }

            var src = _importSource;
            var jobsPayload = {
                jobs: src.jobs.filter(function(j) { return picked[j.id]; }),
                buildings: (src.buildings || []).filter(function(b) { return picked[b.jobId]; }),
                phases: (src.phases || []).filter(function(p) { return picked[p.jobId]; }),
                subs: (src.subs || []).filter(function(s) { return picked[s.jobId]; }),
                changeOrders: (src.changeOrders || []).filter(function(c) { return picked[c.jobId]; }),
                purchaseOrders: (src.purchaseOrders || []).filter(function(p) { return picked[p.jobId]; }),
                invoices: (src.invoices || []).filter(function(i) { return picked[i.jobId]; })
            };

            var estimatesPayload = null;
            if (includeEstimates) {
                estimatesPayload = {
                    estimates: src.estimates || [],
                    estimateLines: src.estimateLines || [],
                    estimateAlternates: src.estimateAlternates || []
                };
            }

            btn.disabled = true;
            statusEl.style.color = 'var(--text-dim,#888)';
            statusEl.textContent = 'Pushing to server…';

            var jobs = jobsPayload.jobs.length
                ? window.agxApi.jobs.bulkSave(jobsPayload)
                : Promise.resolve({ count: 0 });
            var ests = (estimatesPayload && estimatesPayload.estimates.length)
                ? window.agxApi.estimates.bulkSave(estimatesPayload)
                : Promise.resolve({ count: 0 });

            Promise.all([jobs, ests]).then(function(res) {
                statusEl.style.color = '#34d399';
                statusEl.textContent = 'Imported ' + (res[0].count || 0) + ' job(s) and ' +
                                       (res[1].count || 0) + ' estimate(s). Reloading from server…';
                setTimeout(function() {
                    closeModal('importBrowserModal');
                    if (window.agxData) window.agxData.reloadFromServer();
                }, 800);
            }).catch(function(err) {
                statusEl.style.color = '#e74c3c';
                statusEl.textContent = 'Import failed: ' + (err.message || 'unknown error');
                btn.disabled = false;
            });
        }

        window.openImportFromBrowserModal = openImportFromBrowserModal;
        window.runImportFromBrowser = runImportFromBrowser;
        window.switchImportSource = switchImportSource;
        window.parseImportJSON = parseImportJSON;

        // ==================== SEED DATA ====================
        function seedDataIfNeeded() {
            // Server is source of truth when authenticated — never seed demo data
            if (window.agxApi && window.agxApi.isAuthenticated()) return;
            if (appData.jobs.length > 0) return;

            // Job 1: Commerce Park Phase 2
            const job1 = {
                id: 'j1',
                jobNumber: 'S2062',
                title: 'Commerce Park Phase 2',
                client: 'RPM',
                pm: 'John',
                jobType: 'Service',
                workType: 'In-house',
                market: 'Orlando',
                status: 'In Progress',
                contractAmount: 5250000,
                estimatedCosts: 2625000,
                targetMarginPct: 50,
                pctComplete: 55,
                invoicedToDate: 2800000,
                revisedCostChanges: 0,
                notes: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            const job2 = {
                id: 'j2',
                jobNumber: 'S2078',
                title: 'Sunset Ridge HOA Repairs',
                client: 'PAC',
                pm: 'Noah',
                jobType: 'Service',
                workType: 'Sub',
                market: 'Tampa',
                status: 'In Progress',
                contractAmount: 380000,
                estimatedCosts: 228000,
                targetMarginPct: 50,
                pctComplete: 30,
                invoicedToDate: 100000,
                revisedCostChanges: 0,
                notes: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            appData.jobs = [job1, job2];

            // Buildings
            appData.buildings = [
                { id: 'b1', jobId: 'j1', name: 'Building A - Main Office', budget: 2500000, address: '123 Business Ave, Orlando, FL 32801' },
                { id: 'b2', jobId: 'j1', name: 'Building B - Warehouse', budget: 1800000, address: '456 Industrial Blvd, Orlando, FL 32806' },
                { id: 'b3', jobId: 'j1', name: 'Building C - Retail Front', budget: 950000, address: '789 Commerce Dr, Orlando, FL 32803' },
                { id: 'b4', jobId: 'j2', name: 'Clubhouse & Pool Area', budget: 380000, address: '456 Sunset Ridge Lane, Tampa, FL 33612' }
            ];

            // Phases for Job 1 (Commerce Park)
            appData.phases = [
                // Building A
                { id: 'p1', jobId: 'j1', buildingId: 'b1', phase: 'Site Work', pctComplete: 100, materials: 150000, labor: 75000, sub: 45000, equipment: 28000, phaseBudget: 300000, hoursWeek: 0, hoursTotal: 240, rate: 65, burden: 35, notes: 'Completed', weeklyMat: 0, weeklyLabor: 0, weeklySub: 0, weeklyEquip: 0, dateAdded: new Date().toISOString() },
                { id: 'p2', jobId: 'j1', buildingId: 'b1', phase: 'Foundation', pctComplete: 95, materials: 280000, labor: 165000, sub: 95000, equipment: 52000, phaseBudget: 600000, hoursWeek: 120, hoursTotal: 2000, rate: 65, burden: 35, notes: 'Concrete pour next week', weeklyMat: 15000, weeklyLabor: 8000, weeklySub: 5000, weeklyEquip: 2000, dateAdded: new Date().toISOString() },
                { id: 'p3', jobId: 'j1', buildingId: 'b1', phase: 'Framing/Structural', pctComplete: 45, materials: 320000, labor: 210000, sub: 128000, equipment: 68000, phaseBudget: 750000, hoursWeek: 200, hoursTotal: 1200, rate: 75, burden: 35, notes: 'Steel delivery on schedule', weeklyMat: 20000, weeklyLabor: 15000, weeklySub: 10000, weeklyEquip: 5000, dateAdded: new Date().toISOString() },
                { id: 'p4', jobId: 'j1', buildingId: 'b1', phase: 'Rough-In MEP', pctComplete: 20, materials: 180000, labor: 95000, sub: 145000, equipment: 35000, phaseBudget: 480000, hoursWeek: 80, hoursTotal: 400, rate: 60, burden: 35, notes: '', weeklyMat: 10000, weeklyLabor: 5000, weeklySub: 8000, weeklyEquip: 2000, dateAdded: new Date().toISOString() },
                // Building B
                { id: 'p5', jobId: 'j1', buildingId: 'b2', phase: 'Site Work', pctComplete: 100, materials: 110000, labor: 55000, sub: 35000, equipment: 22000, phaseBudget: 220000, hoursWeek: 0, hoursTotal: 180, rate: 65, burden: 35, notes: 'Complete', weeklyMat: 0, weeklyLabor: 0, weeklySub: 0, weeklyEquip: 0, dateAdded: new Date().toISOString() },
                { id: 'p6', jobId: 'j1', buildingId: 'b2', phase: 'Foundation', pctComplete: 75, materials: 210000, labor: 125000, sub: 72000, equipment: 40000, phaseBudget: 460000, hoursWeek: 100, hoursTotal: 1600, rate: 65, burden: 35, notes: 'On track', weeklyMat: 12000, weeklyLabor: 7500, weeklySub: 4000, weeklyEquip: 2000, dateAdded: new Date().toISOString() },
                { id: 'p7', jobId: 'j1', buildingId: 'b2', phase: 'Framing/Structural', pctComplete: 25, materials: 240000, labor: 160000, sub: 95000, equipment: 55000, phaseBudget: 560000, hoursWeek: 160, hoursTotal: 800, rate: 75, burden: 35, notes: 'Crew working 6 days/week', weeklyMat: 18000, weeklyLabor: 12000, weeklySub: 7000, weeklyEquip: 4000, dateAdded: new Date().toISOString() },
                // Building C
                { id: 'p8', jobId: 'j1', buildingId: 'b3', phase: 'Site Work', pctComplete: 100, materials: 65000, labor: 32000, sub: 20000, equipment: 12000, phaseBudget: 130000, hoursWeek: 0, hoursTotal: 100, rate: 65, burden: 35, notes: '', weeklyMat: 0, weeklyLabor: 0, weeklySub: 0, weeklyEquip: 0, dateAdded: new Date().toISOString() },
                { id: 'p9', jobId: 'j1', buildingId: 'b3', phase: 'Foundation', pctComplete: 85, materials: 125000, labor: 75000, sub: 45000, equipment: 25000, phaseBudget: 275000, hoursWeek: 60, hoursTotal: 900, rate: 65, burden: 35, notes: 'Final inspection passed', weeklyMat: 8000, weeklyLabor: 4500, weeklySub: 2000, weeklyEquip: 1000, dateAdded: new Date().toISOString() },
                { id: 'p10', jobId: 'j1', buildingId: 'b3', phase: 'Framing/Structural', pctComplete: 40, materials: 145000, labor: 95000, sub: 58000, equipment: 32000, phaseBudget: 340000, hoursWeek: 120, hoursTotal: 600, rate: 75, burden: 35, notes: 'Ahead of schedule', weeklyMat: 10000, weeklyLabor: 7000, weeklySub: 4000, weeklyEquip: 2000, dateAdded: new Date().toISOString() },
                // Job 2 phases
                { id: 'p11', jobId: 'j2', buildingId: 'b4', phase: 'Site Work', pctComplete: 60, materials: 45000, labor: 25000, sub: 15000, equipment: 10000, phaseBudget: 95000, hoursWeek: 40, hoursTotal: 400, rate: 65, burden: 35, notes: 'Demolition phase', weeklyMat: 3000, weeklyLabor: 1500, weeklySub: 1000, weeklyEquip: 500, dateAdded: new Date().toISOString() },
                { id: 'p12', jobId: 'j2', buildingId: 'b4', phase: 'Exterior Finishes', pctComplete: 25, materials: 95000, labor: 55000, sub: 75000, equipment: 30000, phaseBudget: 255000, hoursWeek: 80, hoursTotal: 600, rate: 65, burden: 35, notes: 'Painting scheduled', weeklyMat: 8000, weeklyLabor: 4000, weeklySub: 5000, weeklyEquip: 2000, dateAdded: new Date().toISOString() },
                { id: 'p13', jobId: 'j2', buildingId: 'b4', phase: 'Roofing', pctComplete: 10, materials: 65000, labor: 35000, sub: 25000, equipment: 15000, phaseBudget: 140000, hoursWeek: 30, hoursTotal: 150, rate: 75, burden: 35, notes: 'Pending material delivery', weeklyMat: 4000, weeklyLabor: 2000, weeklySub: 1500, weeklyEquip: 1000, dateAdded: new Date().toISOString() }
            ];

            // Subcontractors for Job 1
            appData.subs = [
                { id: 's1', jobId: 'j1', name: 'Apex Electrical', trade: 'Electrical', level: 'building', buildingId: 'b1', phaseId: '', contractAmt: 450000, billedToDate: 225000, notes: '' },
                { id: 's2', jobId: 'j1', name: 'Summit Plumbing', trade: 'Plumbing', level: 'building', buildingId: 'b1', phaseId: '', contractAmt: 320000, billedToDate: 160000, notes: '' },
                { id: 's3', jobId: 'j1', name: 'CoolAir Mechanical', trade: 'HVAC', level: 'building', buildingId: 'b2', phaseId: '', contractAmt: 380000, billedToDate: 190000, notes: '' },
                { id: 's4', jobId: 'j1', name: 'IronWorks Steel', trade: 'Structural Steel', level: 'job', buildingId: '', phaseId: '', contractAmt: 520000, billedToDate: 312000, notes: 'Supplies all buildings' },
                { id: 's5', jobId: 'j1', name: 'FastPave Concrete', trade: 'Concrete', level: 'building', buildingId: 'b3', phaseId: '', contractAmt: 225000, billedToDate: 180000, notes: '' },
                { id: 's6', jobId: 'j1', name: 'PrecisionPlumb Inc', trade: 'Plumbing', level: 'phase', buildingId: 'b2', phaseId: 'p6', contractAmt: 290000, billedToDate: 145000, notes: 'Foundation plumbing only' },
                // Job 2 subs
                { id: 's7', jobId: 'j2', name: 'Sunset Painters LLC', trade: 'Painting', level: 'phase', buildingId: 'b4', phaseId: 'p12', contractAmt: 85000, billedToDate: 25000, notes: '' },
                { id: 's8', jobId: 'j2', name: 'Rapid Roofing', trade: 'Roofing', level: 'phase', buildingId: 'b4', phaseId: 'p13', contractAmt: 95000, billedToDate: 0, notes: '' }
            ];

            // Sample Change Orders
            appData.changeOrders = [
                { id: 'co1', jobId: 'j1', coNumber: 'CO-001', description: 'Additional waterproofing - Building A', income: 85000, estimatedCosts: 52000, date: '2026-02-15', notes: 'Client approved' },
                { id: 'co2', jobId: 'j1', coNumber: 'CO-002', description: 'Extended parking lot scope', income: 125000, estimatedCosts: 78000, date: '2026-03-01', notes: '' }
            ];

            // Sample Purchase Orders
            appData.purchaseOrders = [
                { id: 'po1', jobId: 'j1', poNumber: 'PO-001', vendor: 'Apex Electrical', description: 'Main electrical panel + conduit', amount: 145000, billedToDate: 72500, date: '2026-01-20', status: 'Open', notes: 'Net 30' },
                { id: 'po2', jobId: 'j1', poNumber: 'PO-002', vendor: 'Summit Plumbing', description: 'Plumbing rough-in materials', amount: 89000, billedToDate: 89000, date: '2026-02-05', status: 'Closed', notes: '' },
                { id: 'po3', jobId: 'j1', poNumber: 'PO-003', vendor: 'CoolAir Mechanical', description: 'HVAC units - Building B', amount: 210000, billedToDate: 63000, date: '2026-03-10', status: 'Open', notes: 'Partial shipment received' }
            ];

            // Sample Invoices
            appData.invoices = [
                { id: 'inv1', jobId: 'j1', invNumber: 'INV-001', vendor: 'Apex Electrical', description: 'Electrical rough-in progress billing', amount: 72500, date: '2026-02-20', dueDate: '2026-03-22', status: 'Paid', notes: '' },
                { id: 'inv2', jobId: 'j1', invNumber: 'INV-002', vendor: 'CoolAir Mechanical', description: 'HVAC unit delivery - partial', amount: 63000, date: '2026-03-15', dueDate: '2026-04-14', status: 'Sent', notes: 'Awaiting approval' },
                { id: 'inv3', jobId: 'j1', invNumber: 'INV-003', vendor: 'IronWorks Steel', description: 'Structural steel fabrication', amount: 156000, date: '2026-04-01', dueDate: '2026-05-01', status: 'Draft', notes: '' }
            ];

            saveData();
        }

        // ==================== WIP MAIN VIEW ====================
        
function exportWIPToCSV() {
            alert('Export to CSV');
        }

        // ==================== START APP ====================
        document.addEventListener('DOMContentLoaded', initializeApp);
    

// ── AGX Estimate Import/Export ──────────────────────────────────
