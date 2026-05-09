
    let currentEditEstimateId = null;

        // ==================== THEME TOGGLE ====================
        (function() {
            var saved = localStorage.getItem('agx-theme');
            if (saved === 'light') document.body.classList.add('light-mode');
            else if (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
                document.body.classList.add('light-mode');
            }
            // Swap the SVG glyph based on current mode. Light mode \u2192
            // moon (click to go dark). Dark mode \u2192 sun (click to go
            // light). The agxIcon decorator only auto-fires once per
            // element and bails if data-agx-icon-decorated is set, so
            // we have to re-render the icon-slot manually each time.
            function updateIcon() {
                var btn = document.getElementById('theme-toggle');
                if (!btn) return;
                var iconName = document.body.classList.contains('light-mode') ? 'moon' : 'sun';
                btn.dataset.agxIcon = iconName;
                btn.dataset.agxIconDecorated = '0'; // invalidate so we can re-decorate
                // Drop any previous slot, then ask the helper to
                // re-prepend the new SVG.
                var oldSlot = btn.querySelector('.agx-icon-slot');
                if (oldSlot) oldSlot.remove();
                if (typeof window.agxIcon === 'function') {
                    var slot = document.createElement('span');
                    slot.className = 'agx-icon-slot';
                    slot.innerHTML = window.agxIcon(iconName);
                    btn.insertBefore(slot, btn.firstChild);
                    btn.dataset.agxIconDecorated = '1';
                }
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
            startDailySnapshotScheduler();
        }

        // Fires daily snapshots for every Live job. Two trigger paths:
        //   1) On app load — catch-up if today's snapshot is missing for any
        //      Live job. Runs after a small delay to let async loadData finish.
        //   2) setTimeout to next 3 AM America/New_York — re-arms itself each
        //      time it fires, so the app captures automatically across midnight
        //      if it stays open (or catches up the next time it loads).
        function startDailySnapshotScheduler() {
            // Catch-up: run shortly after load when server data has arrived
            setTimeout(function() {
                if (typeof captureDailySnapshotsForAllLiveJobs === 'function') {
                    captureDailySnapshotsForAllLiveJobs();
                }
            }, 5000);

            function tickAndReschedule() {
                if (typeof captureDailySnapshotsForAllLiveJobs === 'function') {
                    captureDailySnapshotsForAllLiveJobs();
                }
                if (typeof msUntilNext3AmEst === 'function') {
                    setTimeout(tickAndReschedule, msUntilNext3AmEst());
                }
            }

            if (typeof msUntilNext3AmEst === 'function') {
                setTimeout(tickAndReschedule, msUntilNext3AmEst());
            }
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
            // Top-level tabs. Some tab-btns are "virtual" — they share
            // data-tab="estimates" (so the underlying DOM is one
            // tab-content) but each represents a different sub-page
            // (Leads / Estimates / Clients / Subs). The data-est-subtab
            // attribute tells us which sub-tab to switch to, and
            // data-virtual-tab is the visual identity used for the
            // .active highlight (so e.g. clicking "Leads" highlights
            // the Leads button, not the Estimates one).
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const tabName = btn.getAttribute('data-tab');
                    const estSub = btn.getAttribute('data-est-subtab');
                    const virtual = btn.getAttribute('data-virtual-tab');
                    switchTab(tabName);
                    if (estSub && typeof window.switchEstimatesSubTab === 'function') {
                        window.switchEstimatesSubTab(estSub);
                    }
                    if (virtual) markVirtualTabActive(virtual);
                });
            });

            // Directory dropdown — now a right-cluster icon button
            // (people glyph) sitting next to the bell, NOT a tab in
            // nav.tabs. Toggle uses the same hidden-attribute pattern
            // as #user-avatar-menu and #notifications-panel; menu
            // items still route through switchTab + switchEstimatesSubTab
            // + markVirtualTabActive so the underlying Estimates →
            // Clients/Subs sub-tabs render exactly as before.
            const dirBtn = document.getElementById('header-directory-btn');
            const dirMenu = document.getElementById('directory-menu');
            if (dirBtn && dirMenu) {
                dirBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const open = !dirMenu.hasAttribute('hidden');
                    closeAllPopovers({ except: 'directory' });
                    if (open) dirMenu.setAttribute('hidden', '');
                    else dirMenu.removeAttribute('hidden');
                });
                dirMenu.addEventListener('click', (e) => e.stopPropagation());
                dirMenu.querySelectorAll('button[data-tab]').forEach(item => {
                    item.addEventListener('click', () => {
                        const tabName = item.getAttribute('data-tab');
                        const estSub = item.getAttribute('data-est-subtab');
                        const virtual = item.getAttribute('data-virtual-tab');
                        switchTab(tabName);
                        if (estSub && typeof window.switchEstimatesSubTab === 'function') {
                            window.switchEstimatesSubTab(estSub);
                        }
                        if (virtual) markVirtualTabActive(virtual);
                        dirMenu.setAttribute('hidden', '');
                    });
                });
            }

            // Avatar dropdown (Account / Logout). The actual click
            // handlers on Account and Logout are wired elsewhere
            // (auth.js wires #logout-btn; admin code wires #account-btn).
            const avatarBtn = document.getElementById('user-avatar');
            const avatarMenu = document.getElementById('user-avatar-menu');
            if (avatarBtn && avatarMenu) {
                avatarBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const open = !avatarMenu.hasAttribute('hidden');
                    closeAllPopovers({ except: 'avatar' });
                    if (open) avatarMenu.setAttribute('hidden', '');
                    else avatarMenu.removeAttribute('hidden');
                });
                avatarMenu.addEventListener('click', (e) => e.stopPropagation());
            }

            // Notifications bell. Panel is empty by default; future
            // hook will populate from server-side notifications source.
            const notifBtn = document.getElementById('header-notif-btn');
            const notifPanel = document.getElementById('notifications-panel');
            if (notifBtn && notifPanel) {
                notifBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const open = !notifPanel.hasAttribute('hidden');
                    closeAllPopovers({ except: 'notif' });
                    if (open) notifPanel.setAttribute('hidden', '');
                    else notifPanel.removeAttribute('hidden');
                });
                notifPanel.addEventListener('click', (e) => e.stopPropagation());
            }

            // Click anywhere outside any open popover dismisses all.
            document.addEventListener('click', () => closeAllPopovers());
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeAllPopovers();
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

        // Several tab-btns share data-tab="estimates" but each shows a
        // different sub-page (Leads / Estimates / Clients / Subs). The
        // CSS .active class drives the visual highlight, but we can't
        // rely on a single `[data-tab="estimates"]` selector — that
        // would highlight the FIRST one (Leads) every time. Use
        // data-virtual-tab as the per-button identity instead.
        function markVirtualTabActive(virtual) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            const target = document.querySelector('[data-virtual-tab="' + virtual + '"]');
            if (target) target.classList.add('active');
        }

        // Dismiss any open header popover. `except` keeps one open
        // (used when toggling so the click that just opened it isn't
        // immediately closed by the document-level click handler).
        function closeAllPopovers(opts) {
            opts = opts || {};
            if (opts.except !== 'directory') {
                const dm = document.getElementById('directory-menu');
                if (dm) dm.setAttribute('hidden', '');
            }
            if (opts.except !== 'avatar') {
                const am = document.getElementById('user-avatar-menu');
                if (am) am.setAttribute('hidden', '');
            }
            if (opts.except !== 'notif') {
                const np = document.getElementById('notifications-panel');
                if (np) np.setAttribute('hidden', '');
            }
        }

        // Browser-tab title format: "{Page name} | Project 86" (matches the
        // Buildertrend convention the user pointed at). Falls back to bare
        // "Project 86" when no specific page is loaded (login screen, etc.).
        // Sub-modules (estimate editor, job detail, etc.) call this with
        // their own labels when entities open; switchTab() calls it with
        // tab-level labels.
        // Summary landing page — minimal dashboard reachable via the 86
        // brand icon and as the auto-fallback when nav state is stale.
        // Renders a greeting + clickable cards to each major area so the
        // user has one obvious next click after a long break. Stats stay
        // light (counts only) so the render is synchronous and predictable;
        // heavier rollups stay on Insights.
        function renderSummaryDashboard() {
            var root = document.getElementById('summary-root');
            if (!root) return;
            var name = (window.agxAuth && window.agxAuth.getUser && (window.agxAuth.getUser() || {}).name) || '';
            var firstName = name ? String(name).split(/\s+/)[0] : '';

            // Counts off appData if it's loaded; otherwise placeholders.
            var d = window.appData || {};
            var leadsCt = (d.leads || []).filter(function(l) {
                var s = (l && l.status || '').toLowerCase();
                return s !== 'closed' && s !== 'lost' && s !== 'archived';
            }).length;
            var estsCt = (d.estimates || []).length;
            var jobsCt = (d.jobs || []).filter(function(j) {
                var s = (j && j.status || '').toLowerCase();
                return s !== 'closed' && s !== 'archived' && s !== 'completed';
            }).length;
            var subsCt = (d.subsDirectory || []).filter(function(s) {
                return (s.status || 'active') !== 'closed';
            }).length;

            // Card factory — each one routes via switchTab so the click is
            // identical to clicking the top-nav button.
            function card(label, count, target, onClick, subtitle) {
                var clickAttr = onClick
                    ? 'onclick="' + onClick + '"'
                    : 'onclick="window.switchTab(\'' + target + '\')"';
                var sub = subtitle ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:4px;">' + subtitle + '</div>' : '';
                return '<button class="ee-btn" ' + clickAttr +
                    ' style="text-align:left;padding:18px 20px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:10px;cursor:pointer;display:flex;flex-direction:column;gap:6px;align-items:flex-start;min-height:96px;">' +
                    '<div style="font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">' + label + '</div>' +
                    '<div style="font-size:28px;font-weight:700;color:var(--text,#fff);font-variant-numeric:tabular-nums;">' + count + '</div>' +
                    sub +
                '</button>';
            }

            // Open-leads card routes through the Estimates → Leads sub-tab
            // so the active highlight and content stay in sync.
            var leadsClick = 'window.switchTab(\'estimates\'); if (typeof window.switchEstimatesSubTab === \'function\') window.switchEstimatesSubTab(\'leads\');';

            root.innerHTML =
                '<div style="margin-bottom:24px;">' +
                    '<h1 style="font-size:24px;margin:0 0 4px 0;font-weight:700;color:var(--text,#fff);">' +
                        (firstName ? 'Welcome back, ' + escapeHTML(firstName) + '.' : 'Welcome back.') +
                    '</h1>' +
                    '<p style="margin:0;color:var(--text-dim,#888);font-size:13px;">Pick up where the team is.</p>' +
                '</div>' +
                '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">' +
                    card('Open Leads',     leadsCt, 'estimates', leadsClick, 'New + working') +
                    card('Estimates',      estsCt,  'estimates') +
                    card('Active Jobs',    jobsCt,  'wip',       null, 'Open + in progress') +
                    card('Subs Directory', subsCt,  'estimates', 'window.switchTab(\'estimates\'); if (typeof window.switchEstimatesSubTab === \'function\') window.switchEstimatesSubTab(\'subs\');') +
                '</div>' +
                '<div style="margin-top:32px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">' +
                    card('Schedule',  '\u{1F4C5}', 'schedule',  null, 'Production calendar') +
                    card('Insights',  '\u{1F4CA}', 'insights',  null, 'Cross-job analytics') +
                '</div>';
        }
        window.renderSummaryDashboard = renderSummaryDashboard;

        function setPageTitle(pageName) {
            document.title = (pageName && String(pageName).trim())
                ? String(pageName).trim() + ' | Project 86'
                : 'Project 86';
        }
        window.setPageTitle = setPageTitle;

        var TAB_TITLES = {
            summary:   'Summary',
            estimates: 'Estimates',  // gets refined by switchEstimatesSubTab
            schedule:  'Schedule',
            wip:       'WIP',
            insights:  'Insights',
            admin:     'Admin'
        };

        // Stale-nav threshold. After this long without activity, the
        // saved nav state is treated as expired and the user lands on
        // the Summary tab on next return (login or new browser tab)
        // instead of being dumped back into whatever they were looking
        // at last week. Activity = any switchTab/saveNavState call.
        var STALE_NAV_MS = 60 * 60 * 1000; // 1 hour

        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

            document.getElementById(tabName)?.classList.add('active');
            // Highlight the FIRST tab-btn matching this data-tab — the
            // virtual-tab system overwrites this when a more specific
            // identity (Leads / Clients / Subs) was clicked.
            document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');

            // Page title: defaults to the tab label. Sub-renderers (the
            // estimates-subtab switch + the job detail + the estimate
            // editor) refine it once the inner state is known.
            setPageTitle(TAB_TITLES[tabName] || null);

            // Tear down the node graph if it's open. #nodeGraphTab is a
            // position:fixed overlay (z:99) that lives outside the
            // tab-content system, so navigating away from WIP would
            // otherwise leave it floating over Estimates/Insights/Admin.
            // The MutationObserver in workspace-layout.js detaches the
            // floating workspace panel automatically on this class drop.
            var ngTab = document.getElementById('nodeGraphTab');
            if (ngTab && ngTab.classList.contains('active')) {
                if (typeof NG !== 'undefined' && NG.saveGraph) {
                    try { NG.saveGraph(); } catch (e) { /* defensive */ }
                }
                ngTab.classList.remove('active');
            }

            // Leaving the WIP tab: tear down any sticky job-detail header
            // (metrics strip + back button) that workspace-layout.js may have
            // injected, so the Insights/Admin/Estimates pages don't show a
            // stale header from a job the user was just viewing.
            if (tabName !== 'wip') {
                var detail = document.getElementById('wip-job-detail-view');
                if (detail) detail.style.display = 'none';
                var mainView = document.getElementById('wip-main-view');
                if (mainView) mainView.style.display = '';
                appState.currentJobId = null;
                if (typeof window.workspaceLayoutCleanup === 'function') {
                    try { window.workspaceLayoutCleanup(); } catch (e) { /* defensive */ }
                }
            }

            if (tabName === 'summary') {
                renderSummaryDashboard();
            } else if (tabName === 'estimates') {
                // Pick the currently-active sub-tab and route through
                // switchEstimatesSubTab so its render fires. Without
                // this the user lands on the Leads sub-tab (active by
                // default in markup) but nothing has rendered the
                // leads list yet — the page looks broken until they
                // click Refresh or another sub-tab.
                var activeSub = document.querySelector('#estimates [data-estimates-subtab].active');
                var subName = activeSub ? activeSub.dataset.estimatesSubtab : 'list';
                if (typeof window.switchEstimatesSubTab === 'function') {
                    window.switchEstimatesSubTab(subName);
                } else {
                    renderEstimatesList();
                }
            } else if (tabName === 'schedule') {
                if (typeof window.renderSchedule === 'function') window.renderSchedule();
            } else if (tabName === 'insights') {
                if (typeof renderInsightsDashboard === 'function') renderInsightsDashboard();
            } else if (tabName === 'admin') {
                // Default to the Users sub-tab; switchAdminSubTab handles the
                // initial render so we don't double-fire API calls.
                if (typeof switchAdminSubTab === 'function') switchAdminSubTab('users');
                else if (typeof renderAdminUsers === 'function') renderAdminUsers();
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
            // Persist navigation state on every tab switch so a refresh
            // lands the user back where they were.
            saveNavState();
        }

        // ── Nav state persistence ──────────────────────────────────────
        // Page refresh used to dump the user back on their role's landing
        // tab regardless of what they were doing. saveNavState() captures
        // the current tab + sub-tab + active job/estimate to localStorage;
        // restoreNavState() (called from auth.js showApp) walks it back
        // before the landing-tab fallback fires. beforeunload is a safety
        // net so a refresh during an in-flight nav still saves.
        function captureNavState() {
            var topBtn = document.querySelector('.tab-btn.active');
            var top = topBtn ? topBtn.getAttribute('data-tab') : null;
            if (!top) return null;
            var st = { top: top };

            if (top === 'estimates') {
                var subEl = document.querySelector('#estimates [data-estimates-subtab].active');
                if (subEl) st.estSub = subEl.getAttribute('data-estimates-subtab');
                // Estimate editor open? Only count it as open if we're
                // ACTUALLY on the list sub-tab — the editor's parent
                // container is hidden when on Clients/Leads/Subs, but
                // the editor's own inline style still says display:'',
                // which would falsely tag every cross-sub-tab navigate
                // as "editor open" and force a re-open on restore.
                if (st.estSub === 'list') {
                    var editorView = document.getElementById('estimate-editor-view');
                    var editorOpen = editorView && editorView.style.display !== 'none';
                    if (editorOpen && window.estimateEditorAPI && typeof window.estimateEditorAPI.getOpenId === 'function') {
                        var eid = window.estimateEditorAPI.getOpenId();
                        if (eid) st.estId = eid;
                    }
                }
            } else if (top === 'wip') {
                var dv = document.getElementById('wip-job-detail-view');
                if (dv && dv.style.display === 'block' && appState.currentJobId) {
                    st.jobId = appState.currentJobId;
                }
            } else if (top === 'admin') {
                var adEl = document.querySelector('[data-admin-subtab].active');
                if (adEl) st.adSub = adEl.getAttribute('data-admin-subtab');
            }
            return st;
        }

        function saveNavState() {
            try {
                var st = captureNavState();
                if (!st) return;
                // Activity timestamp so restoreNavState can age out stale
                // sessions and dump idle returners onto the Summary page.
                st.at = Date.now();
                localStorage.setItem('agx-nav-state', JSON.stringify(st));
            } catch (e) { /* localStorage may be unavailable — degrade silently */ }
        }

        function loadNavState() {
            try {
                var raw = localStorage.getItem('agx-nav-state');
                return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
        }

        function restoreNavState() {
            var st = loadNavState();
            if (!st || !st.top) return false;
            // Stale-session guard. After STALE_NAV_MS without activity, fall
            // through (returning false routes the caller to the summary
            // landing). Saved state stays in localStorage so we can still
            // surface "you were last on …" hints on the summary page if we
            // ever want them.
            if (st.at && (Date.now() - st.at > STALE_NAV_MS)) return false;
            // Validate the saved tab is still accessible. If the user lost
            // the role / capability that owned it, the tab button is
            // hidden via display:none — fall back to landing in that case.
            // Summary is universal — short-circuit the visibility check.
            if (st.top !== 'summary') {
                var btn = document.querySelector('.tab-btn[data-tab="' + st.top + '"]');
                if (!btn || btn.offsetParent === null) return false;
            }

            switchTab(st.top);

            // Wait for the initial server data fetch to settle before
            // opening entity views — opening editEstimate / editJob
            // while data is still loading hits the "Still loading from
            // server" alert path. Polls agxDataLoading every 200ms with
            // a hard ceiling so we don't loop forever if the fetch
            // hangs.
            function whenLoaded(cb, attempts) {
                attempts = attempts || 0;
                var stillLoading = (typeof window.agxDataLoading === 'function') && window.agxDataLoading();
                if (stillLoading && attempts < 30) {
                    setTimeout(function() { whenLoaded(cb, attempts + 1); }, 200);
                } else {
                    cb();
                }
            }

            // Sub-tab routing happens immediately (cheap DOM work, no
            // server dependency). Entity-open routing waits for data
            // to settle. Each step is try-wrapped so a stale id
            // (deleted job, deleted estimate) can't bork the rest.
            setTimeout(function() {
                try {
                    if (st.top === 'estimates') {
                        if (st.estSub && typeof window.switchEstimatesSubTab === 'function') {
                            window.switchEstimatesSubTab(st.estSub);
                        }
                        // Restore the visual identity of the active
                        // top-level virtual tab. Saved estSub maps to:
                        //   leads   → Leads virtual tab
                        //   list    → Estimates virtual tab
                        //   clients → Clients virtual tab
                        //   subs    → Subs virtual tab
                        var virtualMap = { leads: 'leads', list: 'estimates', clients: 'clients', subs: 'subs' };
                        var vTab = virtualMap[st.estSub] || 'estimates';
                        if (typeof markVirtualTabActive === 'function') markVirtualTabActive(vTab);
                    } else if (st.top === 'admin' && st.adSub && typeof window.switchAdminSubTab === 'function') {
                        window.switchAdminSubTab(st.adSub);
                    }
                } catch (e) { console.warn('[nav] sub-tab restore failed:', e); }
            }, 80);

            // Defer entity-opens until data is loaded.
            whenLoaded(function() {
                try {
                    if (st.top === 'estimates' && st.estId && typeof window.editEstimate === 'function') {
                        // Editor view lives inside the list sub-tab;
                        // override the saved sub-tab to put us there.
                        if (typeof window.switchEstimatesSubTab === 'function') {
                            window.switchEstimatesSubTab('list');
                        }
                        window.editEstimate(st.estId);
                    } else if (st.top === 'wip' && st.jobId && typeof window.editJob === 'function') {
                        window.editJob(st.jobId);
                    }
                } catch (e) { console.warn('[nav] entity restore failed:', e); }
            });

            return true;
        }

        // Public hooks — called from auth.js (restore) and from other
        // navigation paths (job detail, estimate editor open) so the
        // saved state always reflects the latest position.
        window.agxNavSave = saveNavState;
        window.agxNavRestore = restoreNavState;

        // Refresh-during-nav safety net.
        window.addEventListener('beforeunload', function() {
            try { saveNavState(); } catch (e) { /* ignore */ }
        });

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

            // Re-apply read-only button guard after the new sub-tab content renders.
            // setTimeout 0 lets the synchronous render finish first.
            setTimeout(applyReadOnlyButtonGuard, 0);
        }

        // ==================== DATA STORAGE ====================
        let appData = {
            jobs: [],
            buildings: [],
            phases: [],
            subs: [],              // legacy per-job inline subs (read-only post-migration)
            changeOrders: [],
            purchaseOrders: [],
            invoices: [],
            estimates: [],
            estimateLines: [],
            estimateAlternates: [],
            qbCostLines: [],
            subsDirectory: [],     // global sub directory (Phase A)
            knownTrades: []        // curated trade dropdown
        };
        // Expose on window so other modules (admin.js, insights.js) that
        // use `window.appData` can read the live state. Top-level `let` in a
        // classic script doesn't auto-attach to window, so we do it manually.
        window.appData = appData;

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
        // Expose to other modules — the AI panel needs currentJobId to know
        // which job to open the WIP assistant against.
        window.appState = appState;

        // ──────────────────────────────────────────────────────────────
        // Custom confirm modal — replaces window.confirm() so destructive
        // actions get a centered, themed "Are you sure?" instead of the
        // jarring native dialog. Returns a Promise<boolean>.
        //
        // Usage:
        //   await agxConfirm({
        //     title: 'Delete this line?',
        //     message: 'This cannot be undone.',
        //     confirmText: 'Delete',
        //     destructive: true
        //   });
        // ──────────────────────────────────────────────────────────────
        window.agxConfirm = function(opts) {
            opts = opts || {};
            var title = opts.title || 'Are you sure?';
            var message = opts.message || '';
            var confirmText = opts.confirmText || 'Confirm';
            var cancelText = opts.cancelText || 'Cancel';
            var destructive = !!opts.destructive;

            return new Promise(function(resolve) {
                var overlay = document.createElement('div');
                overlay.className = 'agx-confirm-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px);';

                var box = document.createElement('div');
                box.style.cssText = 'background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:12px;padding:24px 26px;max-width:420px;width:100%;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
                box.innerHTML =
                    '<div style="font-size:16px;font-weight:700;color:var(--text,#fff);margin-bottom:' + (message ? '10px' : '20px') + ';">' +
                        (typeof window.escapeHTML === 'function' ? window.escapeHTML(title) : title) +
                    '</div>' +
                    (message
                        ? '<div style="font-size:13px;color:var(--text-dim,#aaa);line-height:1.5;margin-bottom:20px;white-space:pre-wrap;">' +
                              (typeof window.escapeHTML === 'function' ? window.escapeHTML(message) : message) +
                          '</div>'
                        : ''
                    ) +
                    '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
                        '<button data-confirm-cancel class="secondary small" style="padding:8px 16px;">' + (typeof window.escapeHTML === 'function' ? window.escapeHTML(cancelText) : cancelText) + '</button>' +
                        '<button data-confirm-ok class="' + (destructive ? 'danger' : 'primary') + ' small" style="padding:8px 16px;">' + (typeof window.escapeHTML === 'function' ? window.escapeHTML(confirmText) : confirmText) + '</button>' +
                    '</div>';

                overlay.appendChild(box);
                document.body.appendChild(overlay);

                function cleanup(answer) {
                    document.removeEventListener('keydown', onKey);
                    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                    resolve(answer);
                }
                function onKey(e) {
                    if (e.key === 'Escape') cleanup(false);
                    else if (e.key === 'Enter') cleanup(true);
                }
                box.querySelector('[data-confirm-cancel]').onclick = function() { cleanup(false); };
                box.querySelector('[data-confirm-ok]').onclick = function() { cleanup(true); };
                overlay.addEventListener('click', function(e) {
                    if (e.target === overlay) cleanup(false);
                });
                document.addEventListener('keydown', onKey);

                // Focus the confirm button on next tick so Enter / Escape work
                setTimeout(function() {
                    var btn = box.querySelector('[data-confirm-ok]');
                    if (btn) btn.focus();
                }, 0);
            });
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
            // estimateAlternates is no longer a flat top-level array — alternates
            // live INLINE on each estimate (est.alternates) since the full-page
            // editor reads/writes them there directly. Keeping a parallel flat
            // copy was creating dual-source-of-truth corruption on offline
            // edits. Initialize empty so any old code that reads it sees [],
            // never undefined.
            appData.estimateAlternates = [];
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
            // estimateAlternates flat array dropped — see loadFromLocalStorage.
            // Clean up the legacy key so stale data can't reappear after a
            // future schema change.
            try { localStorage.removeItem('agx-estimate-alternates'); } catch (e) {}
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
            // Flat estimateAlternates array kept empty for legacy reads —
            // alternates live INLINE on est.alternates now. Pushing them
            // both places was the dual-source-of-truth bug that caused
            // "scope didn't save" on offline edits.
            appData.estimateAlternates = [];
            (serverEstimates || []).forEach(function(e) {
                var lines = e.lines || [];
                var meta = Object.assign({}, e);
                // Strip lines from the estimate object — the editor always
                // reads them from appData.estimateLines (a flat array) so
                // keeping them inline would just duplicate state. Alternates
                // STAY inline (meta.alternates) — the editor reads them
                // directly from there.
                delete meta.lines;
                appData.estimates.push(meta);
                Array.prototype.push.apply(appData.estimateLines, lines);
            });
        }

        // Tracks whether the initial server fetch has completed. Editors
        // and other long-lived UI surfaces consult this so they don't
        // paint a stale localStorage snapshot if the user opens an
        // editor during the ~100ms server-load window.
        var _serverLoadInFlight = false;
        var _serverLoadComplete = false;
        window.agxDataReady = function() { return _serverLoadComplete; };
        window.agxDataLoading = function() { return _serverLoadInFlight; };

        // loadData is called once at startup. We paint the localStorage
        // cache immediately so first paint is instant, then fetch fresh
        // data from the server. The data-loss risk during the in-flight
        // window (user opens editor with stale data → server fetch
        // overwrites their unsaved edits) is now closed by gating
        // editor opens on agxDataReady() — see openNewEstimateForm /
        // editEstimate / etc.
        function loadData() {
            loadFromLocalStorage(); // fast first paint
            var authed = window.agxApi && window.agxApi.isAuthenticated();
            if (!authed) {
                _serverLoadComplete = true;
                return;
            }
            _serverLoadInFlight = true;
            Promise.all([
                window.agxApi.jobs.list(),
                window.agxApi.estimates.list(),
                // QB cost lines now persist server-side. Read all of
                // them at boot so Job Costs / Audit / 86 (WIP analyst)
                // can reason about them without per-tab fetches.
                window.agxApi.qbCosts.list().catch(function() { return { lines: [] }; }),
                // Subs directory (Phase A) — global sub records.
                window.agxApi.subs.list().catch(function() { return { subs: [], trades: [] }; })
            ]).then(function(results) {
                hydrateFromServerJobs(results[0].jobs);
                hydrateFromServerEstimates(results[1].estimates);
                appData.qbCostLines = (results[2] && results[2].lines) || [];
                appData.subsDirectory = (results[3] && results[3].subs) || [];
                appData.knownTrades = (results[3] && results[3].trades) || [];
                writeToLocalStorage();
                _serverLoadComplete = true;
                _serverLoadInFlight = false;
                // Re-render whatever's visible. Each renderer no-ops if
                // its DOM target isn't present, so calling them all is
                // safe regardless of which tab the user is on.
                if (typeof renderWIPMain === 'function') renderWIPMain();
                if (typeof renderEstimatesList === 'function') renderEstimatesList();
                if (typeof renderInsightsDashboard === 'function') renderInsightsDashboard();
                if (typeof renderAdminMetrics === 'function') renderAdminMetrics();
                if (typeof renderAdminJobs === 'function') renderAdminJobs();
            }).catch(function(err) {
                _serverLoadInFlight = false;
                _serverLoadComplete = true; // mark complete so UI doesn't hang waiting
                console.warn('Server load failed, staying on localStorage cache:', err.message);
            });
        }

        // saveData writes to localStorage immediately (cheap, synchronous) so the
        // existing call sites stay correct, and schedules a debounced push to the
        // server when authenticated. Offline mode is localStorage-only.
        //
        // Push pipeline: each saveData() coalesces into a single in-flight push.
        // On failure we retry with exponential backoff (1s, 2s, 4s) up to 3
        // attempts, then surface the failure via the agxPushStatus listener so
        // the estimate editor (and anything else interested) can show an
        // "unsaved — retrying" badge instead of a silent dropped commit.
        var _serverPushTimer = null;
        var _activePush = null;          // Promise of the in-flight push
        var _pushRetryCount = 0;
        var _pushStatusListeners = [];
        function notifyPushStatus(status, err) {
            _pushStatusListeners.forEach(function(fn) {
                try { fn(status, err); } catch (e) { /* defensive */ }
            });
        }
        window.agxPushStatus = {
            subscribe: function(fn) {
                _pushStatusListeners.push(fn);
                return function() {
                    _pushStatusListeners = _pushStatusListeners.filter(function(x) { return x !== fn; });
                };
            },
            // Resolves with the current in-flight push (or immediately if none).
            // Used by editor close to wait for any pending save before unmounting.
            inFlight: function() { return _activePush || Promise.resolve(); }
        };

        function saveData() {
            writeToLocalStorage();
            if (!window.agxApi || !window.agxApi.isAuthenticated()) return;
            if (_serverPushTimer) clearTimeout(_serverPushTimer);
            _serverPushTimer = setTimeout(function() { pushToServer(); }, 600);
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
            // Estimates: alternates ride INLINE on each estimate now;
            // legacy `estimateAlternates: []` stays empty for back-compat
            // with older server builds that read it as a fallback.
            var estimatesPayload = {
                estimates: appData.estimates,
                estimateLines: appData.estimateLines,
                estimateAlternates: []
            };

            notifyPushStatus('saving');
            _activePush = Promise.all([
                editableJobs.length ? window.agxApi.jobs.bulkSave(jobsPayload) : Promise.resolve(),
                appData.estimates.length ? window.agxApi.estimates.bulkSave(estimatesPayload) : Promise.resolve()
            ]).then(function(r) {
                _pushRetryCount = 0;
                _activePush = null;
                notifyPushStatus('saved');
                return r;
            }).catch(function(err) {
                console.warn('Server push failed (attempt ' + (_pushRetryCount + 1) + '):', err.message);
                _activePush = null;
                if (_pushRetryCount < 3) {
                    _pushRetryCount++;
                    var backoff = Math.pow(2, _pushRetryCount - 1) * 1000; // 1s, 2s, 4s
                    notifyPushStatus('retrying', err);
                    setTimeout(function() { pushToServer(); }, backoff);
                } else {
                    notifyPushStatus('failed', err);
                }
                throw err;
            });
            return _activePush;
        }

        // Expose for explicit triggers (e.g. the import-from-browser button)
        window.agxData = {
            pushToServer: pushToServer,
            reloadFromServer: loadData
        };

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
