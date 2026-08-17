
    let currentEditEstimateId = null;

        // ==================== THEME TOGGLE ====================
        (function() {
            // DARK is the default for everyone — first visit, new users, and
            // regardless of the OS/browser color-scheme preference. Light mode
            // applies ONLY when the user explicitly chose it via the toggle
            // (saved as p86-theme='light'). The old prefers-color-scheme
            // fallback made light-OS users land in light mode uninvited.
            var saved = localStorage.getItem('p86-theme');
            if (saved === 'light') document.body.classList.add('light-mode');
            // The toggle now lives inside the user-avatar dropdown as a
            // menu item, so we update both the label text and prepend a
            // small icon. Light mode -> moon glyph + "Switch to dark
            // mode". Dark mode -> sun glyph + "Switch to light mode".
            // The p86Icon decorator only auto-fires once per element,
            // so we re-render the icon-slot manually each time.
            function updateIcon() {
                var btn = document.getElementById('theme-toggle');
                if (!btn) return;
                var isLight = document.body.classList.contains('light-mode');
                var iconName = isLight ? 'moon' : 'sun';
                var labelText = isLight ? 'Switch to dark mode' : 'Switch to light mode';
                btn.dataset.p86Icon = iconName;
                btn.dataset.p86IconDecorated = '0'; // invalidate so we can re-decorate
                var labelSpan = btn.querySelector('#theme-toggle-label');
                if (labelSpan) labelSpan.textContent = labelText;
                // Drop any previous slot, then prepend the new SVG.
                var oldSlot = btn.querySelector('.p86-icon-slot');
                if (oldSlot) oldSlot.remove();
                if (typeof window.p86Icon === 'function') {
                    var slot = document.createElement('span');
                    slot.className = 'p86-icon-slot';
                    slot.innerHTML = window.p86Icon(iconName);
                    btn.insertBefore(slot, btn.firstChild);
                    btn.dataset.p86IconDecorated = '1';
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
                    localStorage.setItem('p86-theme', isLight ? 'light' : 'dark');
                    updateIcon();
                    document.dispatchEvent(new CustomEvent('p86-theme-change', { detail: { isLight: isLight } }));
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
            // putCache, not a bare setItem — same reason as writeToLocalStorage:
            // a full quota must not throw out of a UI handler.
            putCache(key, JSON.stringify(items));
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
                    lt + 'button onclick="deleteCustomItem(\''+storageKey+'\','+i+',\''+selectId+'\',\''+placeholder+'\')" style="background:var(--red,#e74c3c);color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;"' + gt + 'Delete' + lt + '/button' + gt +
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
            populateCustomSelect('phaseType', DEFAULT_PHASE_TYPES, 'p86-jobs-custom-phases', '-- Select Scope --');
        }
        function populateSubTradeSelect() {
            populateCustomSelect('subTrade', DEFAULT_SUB_TRADES, 'p86-jobs-custom-trades', '-- Select Trade --');
        }

        function initializeApp() {
            loadData();
            setupEventListeners();
            seedDataIfNeeded();
            backfillSampleData();
            migrateBudgetFields();
            renderJobsMain();
            // Daily snapshot scheduler RETIRED 2026-08-09 — Insights is now 100%
            // live (no dailySnapshots / liveStatus gate). No auto-capture to arm.
        }

        // Expose loadData globally so cross-module reload triggers (e.g.
        // the payload-applied handler in ai-panel.js) can re-hydrate
        // jobs + estimates + qb cost lines + subs from the server in
        // one call. Returns a Promise that resolves once the re-render
        // cycle completes.
        window.p86ReloadAllData = loadData;

        // RETIRED 2026-08-09 (Insights live rework): the daily-snapshot capture
        // is gone — Insights now computes 100% live from getJobWIP() for every
        // active job, with no `liveStatus` gate. The old capture was a browser
        // setTimeout that only fired if a tab happened to be open at 3 AM (it
        // silently lost days and capped history at 90). Kept as a no-op so any
        // stray caller stays harmless; the snapshot helpers in jobs.js are now
        // dead code.
        function startDailySnapshotScheduler() { /* retired — no-op */ }

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
            if (window.p86Api && window.p86Api.isAuthenticated()) return;
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
                    // Expand-on-click accordion parents (Leads / Estimates /
                    // Jobs) carry data-accordion-toggle and NO data-tab —
                    // clicking the row just toggles its section open/closed;
                    // the actual list lives in a child row ("Leads List" etc).
                    // This differs from the Admin / Command Center / My Files
                    // parents, which navigate AND open. Handle + bail before
                    // any tab switch so switchTab(null) is never called.
                    if (btn.hasAttribute('data-accordion-toggle')) {
                        const tp = btn.closest('.app-nav-parent');
                        if (tp) setSidebarAccordionExpanded(tp, !tp.classList.contains('expanded'));
                        return;
                    }
                    const tabName = btn.getAttribute('data-tab');
                    const estSub = btn.getAttribute('data-est-subtab');
                    const adminSub = btn.getAttribute('data-admin-subtab');
                    const consoleSub = btn.getAttribute('data-console-subtab');
                    const virtual = btn.getAttribute('data-virtual-tab');
                    switchTab(tabName);
                    if (estSub && typeof window.switchEstimatesSubTab === 'function') {
                        window.switchEstimatesSubTab(estSub);
                    }
                    // Leads dropdown children carry data-leads-view (list|map)
                    // so "Leads List" / "Leads Map" each land on a known view
                    // (vs the toolbar 🗺 flip-toggle which just inverts).
                    const leadsView = btn.getAttribute('data-leads-view');
                    if (leadsView && typeof window.setLeadsView === 'function') {
                        window.setLeadsView(leadsView);
                    }
                    // Estimates dropdown children carry data-estimates-view
                    // (list|map) so "Estimate List" / "Estimates Map" land on a
                    // known view — same pattern as data-leads-view.
                    const estView = btn.getAttribute('data-estimates-view');
                    if (estView && typeof window.setEstimatesView === 'function') {
                        window.setEstimatesView(estView);
                    }
                    // Admin accordion children carry data-admin-subtab so the
                    // sidebar can drive the in-page admin sub-view directly
                    // (mirrors the data-est-subtab path for Estimates).
                    if (adminSub && typeof window.switchAdminSubTab === 'function') {
                        window.switchAdminSubTab(adminSub);
                    }
                    // Level-3 admin children (sidebar-deep) carry data-admin-view —
                    // the inner view inside Agents (metrics/skills/…) or
                    // Organization (identity/kb/…). Routed after the sub-tab
                    // switch so the pane exists before the view swaps.
                    const adminView = btn.getAttribute('data-admin-view');
                    if (adminSub && adminView && typeof window.p86AdminOpenView === 'function') {
                        window.p86AdminOpenView(adminSub, adminView);
                    }
                    // Command Center accordion children carry data-console-subtab
                    // so the sidebar dropdown drives which platform section shows
                    // (Overview / Metrics / Tenants / Audit / Anthropic / Email /
                    // BT Mapping / Settings) — same pattern as data-admin-subtab.
                    if (consoleSub && typeof window.switchConsoleSubTab === 'function') {
                        window.switchConsoleSubTab(consoleSub);
                    }
                    // Jobs hub accordion children carry data-jobshub-subtab
                    // (purchase-orders / bills / change-orders / rfis /
                    // submittals) — same pattern as data-console-subtab.
                    const jobshubSub = btn.getAttribute('data-jobshub-subtab');
                    if (jobshubSub && typeof window.switchJobsHubSubTab === 'function') {
                        window.switchJobsHubSubTab(jobshubSub);
                    }
                    // Assembly Studio accordion children carry
                    // data-asmstudio-subtab (assemblies / studio / codes /
                    // parametric) — same pattern as data-jobshub-subtab.
                    const asmStudioSub = btn.getAttribute('data-asmstudio-subtab');
                    if (asmStudioSub && typeof window.switchAsmStudioSubTab === 'function') {
                        window.switchAsmStudioSubTab(asmStudioSub);
                    }
                    // My Files accordion children carry data-myfiles-folder
                    // (e.g. __projects__, __tools__, __printouts__) — same
                    // pattern as data-admin-subtab. After switchTab routes us
                    // into the my-files pane, hand the virtual folder name
                    // to window.myFiles.selectFolder so the right View renders.
                    const mfFolder = btn.getAttribute('data-myfiles-folder');
                    if (mfFolder && window.myFiles && typeof window.myFiles.selectFolder === 'function') {
                        window.myFiles.selectFolder(mfFolder);
                    }
                    if (virtual) markVirtualTabActive(virtual);
                    // Clicking an accordion PARENT row navigates AND ensures
                    // its section is open (the caret handles collapsing); a
                    // child click leaves the already-open section as-is.
                    const accParent = btn.closest('.app-nav-parent');
                    if (accParent && btn.classList.contains('app-nav-parent-btn')) {
                        setSidebarAccordionExpanded(accParent, true);
                    }
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

            // Quick-add "+" menu (header). Mirrors the directory toggle:
            // opens #header-quickadd-menu, closing every other popover, and
            // syncs aria-expanded for a11y. Each item carries its own
            // create-flow onclick; we just close the menu on any item click
            // so the modal opens against a clean header. The menu rows are
            // role-gated via data-cap (applyRoleVisibility trims them), so
            // a limited user simply sees fewer options here.
            const quickAddBtn = document.getElementById('header-quickadd-btn');
            const quickAddMenu = document.getElementById('header-quickadd-menu');
            if (quickAddBtn && quickAddMenu) {
                quickAddBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const open = !quickAddMenu.hasAttribute('hidden');
                    closeAllPopovers({ except: 'quickadd' });
                    if (open) {
                        quickAddMenu.setAttribute('hidden', '');
                        quickAddBtn.setAttribute('aria-expanded', 'false');
                    } else {
                        quickAddMenu.removeAttribute('hidden');
                        quickAddBtn.setAttribute('aria-expanded', 'true');
                    }
                });
                quickAddMenu.addEventListener('click', (e) => {
                    // Let the item's own onclick create flow run, then close.
                    if (e.target.closest('.header-popover-item')) {
                        quickAddMenu.setAttribute('hidden', '');
                        quickAddBtn.setAttribute('aria-expanded', 'false');
                    }
                    e.stopPropagation();
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
                    // Header avatar (mobile) → default top-right anchoring.
                    avatarMenu.classList.remove('from-sidebar');
                    if (open) avatarMenu.setAttribute('hidden', '');
                    else avatarMenu.removeAttribute('hidden');
                });
                avatarMenu.addEventListener('click', (e) => e.stopPropagation());
            }

            // Sidebar footer account button (desktop). Opens the SAME
            // #user-avatar-menu popover, but flagged `from-sidebar` so CSS
            // repositions it to pop UP from the footer (fixed, bottom-left).
            const sidebarAccountBtn = document.getElementById('sidebar-account-btn');
            if (sidebarAccountBtn && avatarMenu) {
                sidebarAccountBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const open = !avatarMenu.hasAttribute('hidden');
                    closeAllPopovers({ except: 'avatar' });
                    if (open) {
                        avatarMenu.setAttribute('hidden', '');
                        avatarMenu.classList.remove('from-sidebar');
                    } else {
                        avatarMenu.classList.add('from-sidebar');
                        avatarMenu.removeAttribute('hidden');
                    }
                });
            }

            // The sidebar "+ New" button was removed — create actions live in the
            // sticky header's quick-add ("+") menu instead.

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

            // Sidebar accordion sub-nav (Estimates / Admin expandable
            // sections). Wires caret toggles + restores saved expanded state.
            initSidebarAccordion();
        }

        // Several tab-btns share data-tab="estimates" but each shows a
        // different sub-page (Leads / Estimates / Clients / Subs). The
        // CSS .active class drives the visual highlight, but we can't
        // rely on a single `[data-tab="estimates"]` selector — that
        // would highlight the FIRST one (Leads) every time. Use
        // data-virtual-tab as the per-button identity instead.
        function markVirtualTabActive(virtual) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            // A virtual-tab id can appear on MORE THAN ONE nav surface — the
            // sidebar accordion child, the header directory-menu item, and the
            // legacy hidden #estimates-main-tabs row all share e.g.
            // data-virtual-tab="clients". querySelector would light only the
            // FIRST in DOM order (often a hidden menu item), leaving the
            // visible sidebar child un-highlighted. Light EVERY match so the
            // sidebar accordion child always reflects the current page.
            document.querySelectorAll('[data-virtual-tab="' + virtual + '"]').forEach(function(el) { el.classList.add('active'); });
            // Reflect active descendants on accordion parents so a section
            // whose child is the current page reads as "you are here" even
            // when collapsed.
            document.querySelectorAll('.app-nav-parent').forEach(function(parent) {
                parent.classList.toggle('has-active-child', !!parent.querySelector('.app-nav-child.active'));
            });
        }
        // Expose so the URL router (js/router.js) can drive the virtual-
        // tab highlight on deep-link / refresh — switchTab() alone always
        // lights up the FIRST [data-tab="estimates"] sibling (Leads),
        // which is wrong when the user refreshed on Estimates / Clients /
        // Subs. Click handlers already call this; the router didn't.
        window.markVirtualTabActive = markVirtualTabActive;

        // ── Sidebar accordion (expandable page sub-nav) ────────────────
        // Page-level sub-tabs (Estimates → Leads/Clients/Subs/Users; Admin
        // → Users/Roles/…/System) live as nested children under an
        // expandable parent row. The parent row is itself a real
        // destination (it routes via the delegated .tab-btn handler); a
        // caret <span> toggles the children open/closed without navigating.
        // Expanded/collapsed state persists per-section to localStorage so
        // the sidebar reopens the way the user left it. Entity-detail
        // sub-tabs (open job → #app-jobnav, My Files → #app-filesnav) keep
        // their existing contextual-swap and are NOT touched here.
        var ACCORDION_LS_KEY = 'p86-sidebar-accordions';
        function loadAccordionState() {
            try { return JSON.parse(localStorage.getItem(ACCORDION_LS_KEY)) || {}; }
            catch (e) { return {}; }
        }
        function saveAccordionState(state) {
            try { localStorage.setItem(ACCORDION_LS_KEY, JSON.stringify(state)); }
            catch (e) { /* localStorage unavailable — degrade silently */ }
        }
        // Some accordion sections have their children filled in by another
        // module rather than by markup. Expanding one has to ASK for its
        // content: My Files used to expand an EMPTY container on every tab
        // except My Files itself (its list was only built when that page
        // painted), which read as a broken dropdown.
        function primeAccordionChildren(parent, key) {
            if (!parent) return;
            var slot = parent.querySelector('.app-nav-children');
            if (!slot || slot.children.length) return;   // already populated
            if (key === 'myfiles' && window.myFiles && window.myFiles.syncSidebarFolders) {
                // Never let a fetch failure block the toggle itself.
                try { window.myFiles.syncSidebarFolders(); } catch (e) { /* no-op */ }
            }
        }
        function setSidebarAccordionExpanded(parent, expanded) {
            if (!parent) return;
            parent.classList.toggle('expanded', !!expanded);
            var caret = parent.querySelector('.app-nav-caret');
            if (caret) caret.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            var key = parent.getAttribute('data-accordion');
            if (expanded) primeAccordionChildren(parent, key);
            if (key) {
                var st = loadAccordionState();
                st[key] = !!expanded;
                saveAccordionState(st);
            }
        }
        window.setSidebarAccordionExpanded = setSidebarAccordionExpanded;
        function initSidebarAccordion() {
            var saved = loadAccordionState();
            // Default open/closed when the user has no saved preference yet.
            var defaults = { admin: false };
            document.querySelectorAll('.app-nav-parent').forEach(function(parent) {
                var key = parent.getAttribute('data-accordion');
                var expanded = (key && key in saved) ? saved[key]
                             : (key && key in defaults) ? defaults[key]
                             : false;
                parent.classList.toggle('expanded', expanded);
                // Restored-from-localStorage sections need priming too —
                // otherwise a section the user left open comes back empty.
                if (expanded) primeAccordionChildren(parent, key);
                var caret = parent.querySelector('.app-nav-caret');
                if (!caret) return;
                caret.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                // The caret toggles the section WITHOUT navigating — stop the
                // click from bubbling to the parent button's tab-switch
                // handler. (Guard against double-binding if init re-runs.)
                if (caret.dataset.accWired === '1') return;
                caret.dataset.accWired = '1';
                caret.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSidebarAccordionExpanded(parent, !parent.classList.contains('expanded'));
                });
                caret.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        setSidebarAccordionExpanded(parent, !parent.classList.contains('expanded'));
                    }
                });
            });
        }
        window.initSidebarAccordion = initSidebarAccordion;

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
            if (opts.except !== 'quickadd') {
                const qa = document.getElementById('header-quickadd-menu');
                if (qa) {
                    qa.setAttribute('hidden', '');
                    const qb = document.getElementById('header-quickadd-btn');
                    if (qb) qb.setAttribute('aria-expanded', 'false');
                }
            }
        }

        // Browser-tab title format: "{Page name} | Project 86" (matches the
        // Buildertrend convention the user pointed at). Falls back to bare
        // "Project 86" when no specific page is loaded (login screen, etc.).
        // Sub-modules (estimate editor, job detail, etc.) call this with
        // their own labels when entities open; switchTab() calls it with
        // tab-level labels.
        // Summary landing page — Project 86's "what needs my attention
        // today" page. Layout shape mirrors Buildertrend's Summary minus
        // the bloat (no clock-in, no Files/Messaging/Reports mega-menus,
        // no saved-filter chrome). Three zones:
        //   1. Greeting + quick actions (top)
        //   2. Needs-Attention counter row (overdue invoices, open leads,
        //      pending estimates, schedule items this week)
        //   3. 2-col main grid: Recent Activity feed (left, 2/3) +
        //      This Week's Agenda rail (right, 1/3)
        // Counters + activity sourced synchronously from window.appData;
        // schedule rail loads async via p86Api.schedule and replaces a
        // placeholder when ready so the page never blocks on the network.
        // Shared manifest fetch + 60s cache. Powers the Today pane's
        // System Snapshot row AND the Help overlay (opened from the
        // avatar dropdown). Returns a Promise resolving to the
        // manifest JSON; failure resolves to null so callers degrade
        // gracefully.
        //
        // The old System Map sub-tab on the Summary page (and its
        // entity-card grid) was retired — that surface was clutter
        // for the day-to-day workflow. The Features catalog + What's
        // New list it carried now live in the Help overlay
        // (openHelpOverlay), reached from the avatar dropdown's
        // "Help & What's New" item.
        var _manifestCache = { data: null, at: 0 };
        function fetchManifest() {
            var TTL = 60 * 1000;
            if (_manifestCache.data && (Date.now() - _manifestCache.at) < TTL) {
                return Promise.resolve(_manifestCache.data);
            }
            var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) || null;
            var headers = token ? { Authorization: 'Bearer ' + token } : {};
            return fetch('/api/org/manifest', { headers: headers, credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    if (j) { _manifestCache.data = j; _manifestCache.at = Date.now(); }
                    return j;
                })
                .catch(function () { return null; });
        }

        // Summary page entry point. Used to host a sub-tab strip
        // (Today | System Map); collapsed back to a single Today pane
        // since the System Map content moved to the Help overlay.
        function renderSummaryDashboard() {
            var root = document.getElementById('summary-root');
            if (!root) return;
            paintSummaryToday(root);
        }
        window.renderSummaryDashboard = renderSummaryDashboard;

        // ── Help center ───────────────────────────────────────────────
        // The Help & What's New overlay moved to js/help-center.js
        // (window.p86HelpCenter / window.openHelpOverlay) — versioned
        // patch notes, guided tours, and the searchable feature atlas.
        // It reuses this module's manifest fetch + cache:
        window.p86FetchManifest = fetchManifest;

        function paintSummaryToday(root) {
            if (!root) return;

            var d = window.appData || {};
            var name = (window.p86Auth && window.p86Auth.getUser && (window.p86Auth.getUser() || {}).name) || '';
            var firstName = name ? String(name).split(/\s+/)[0] : '';
            var hour = new Date().getHours();
            var greet = hour < 12 ? 'Good morning' : (hour < 18 ? 'Good afternoon' : 'Good evening');

            // ── Needs Attention counters ───────────────────────────────
            // Pull live from appData. Each card has a click target that
            // takes the user to the matching tab so the count is
            // actionable — clicking it lands on the actual list.
            var now = Date.now();
            var DAY = 24 * 60 * 60 * 1000;

            // Overdue invoices: invoices with a due date in the past and
            // status that isn't paid/closed.
            var overdueInv = (d.invoices || []).filter(function(i) {
                if (!i || !i.dueDate) return false;
                var s = (i.status || '').toLowerCase();
                if (s === 'paid' || s === 'closed' || s === 'voided') return false;
                var due = new Date(i.dueDate).getTime();
                return isFinite(due) && due < now;
            }).length;

            // Open leads (new + working). Lost / closed / archived dropped.
            var openLeads = (d.leads || []).filter(function(l) {
                var s = (l && l.status || '').toLowerCase();
                return s !== 'closed' && s !== 'lost' && s !== 'archived' && s !== 'won';
            }).length;

            // Pending estimates: estimates whose bt_export_status is unset
            // or 'pending' (i.e., haven't been sent / accepted yet).
            var pendingEsts = (d.estimates || []).filter(function(e) {
                var s = (e && e.bt_export_status || '').toLowerCase();
                return !s || s === 'pending' || s === 'draft';
            }).length;

            // Active jobs (open + in-progress, not closed/completed).
            var activeJobs = (d.jobs || []).filter(function(j) {
                var s = (j && j.status || '').toLowerCase();
                return s !== 'closed' && s !== 'archived' && s !== 'completed';
            }).length;

            function attentionCard(label, count, color, onClick, subtitle) {
                var clickAttr = onClick ? ' onclick="' + onClick + '"' : '';
                var subHtml = subtitle ? '<div class="p86-attn-tile-sub">' + subtitle + '</div>' : '';
                // count is a literal number for the 4 sync cards and an HTML
                // <span> placeholder for the 3 async cards — only grey-out a
                // literal zero; never coerce the span to a Number.
                var isLiteral = (typeof count === 'number');
                var countColor = (isLiteral && count <= 0) ? 'var(--text-dim,#888)' : color;
                return '<button type="button" class="p86-attn-tile ee-btn"' + clickAttr +
                    ' style="--attn-accent:' + color + ';">' +
                    '<div class="p86-attn-tile-label">' + label + '</div>' +
                    '<div class="p86-attn-tile-count" style="color:' + countColor + ';">' + count + '</div>' +
                    subHtml +
                '</button>';
            }

            var leadsClick = "window.switchTab('estimates'); if (typeof window.switchEstimatesSubTab === 'function') window.switchEstimatesSubTab('leads');";
            var estsClick  = "window.switchTab('estimates'); if (typeof window.switchEstimatesSubTab === 'function') window.switchEstimatesSubTab('list');";

            // ── Page composition ────────────────────────────────────────
            // The agenda rail is a placeholder until the schedule fetch
            // resolves below. Greeting + quick actions land synchronously.
            root.innerHTML =
                // Header zone
                '<div class="p86-cmd-header">' +
                    '<div class="p86-cmd-greet">' +
                        '<h1>' +
                            greet + (firstName ? ', ' + escapeHTML(firstName) : '') + '.' +
                        '</h1>' +
                        '<p>Pick up where the team is.</p>' +
                    '</div>' +
                    '<div class="p86-cmd-actions">' +
                        '<button type="button" class="p86-cmd-search" onclick="if(window.p86Search)window.p86Search.open();" aria-label="Search" title="Search jobs, leads, estimates, clients">' +
                            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>' +
                            '<span>Search&hellip;</span>' +
                        '</button>' +
                        // Global Ask 86 badge in the dashboard header.
                        '<span class="p86-ask86-mount"></span>' +
                        // Step 1: a new lead is the entry to the whole
                        // pipeline. Uses the in-house .ee-btn.primary
                        // styling (subtle blue outline, no chunky fill)
                        // so it reads as part of the dashboard chrome
                        // rather than a marketing CTA.
                        '<button class="ee-btn primary" data-p86-icon="plus" onclick="if(typeof openNewLeadModal===\'function\')openNewLeadModal();" title="Start a new lead — step 1 of the pipeline">New Lead</button>' +
                        // "New Report" — opens the report-template picker
                        // (Photo Walkthrough / Daily Log / etc.), then the
                        // new-project modal pre-filled with the template
                        // label so the user can link it to a lead / job /
                        // client at creation time. After save the user
                        // lands directly in the report editor ready to
                        // take photos.
                        '<button class="ee-btn success" data-p86-icon="reports" onclick="if(window.p86Projects&amp;&amp;window.p86Projects.openCreateReport)window.p86Projects.openCreateReport();" title="Start a new report — Walkthrough, Daily Log, etc.">New Report</button>' +
                    '</div>' +
                '</div>' +

                // ── "Needs you now" lane — the actionable, ranked at-a-glance
                // list (what to DO right now), fused across sources by
                // renderSummaryNeedsYou(). Sits ABOVE the count tiles, which
                // answer "how many" rather than "which ones, act now".
                '<div class="p86-cmd-sectlabel">Needs you now</div>' +
                '<div id="summary-needs" class="p86-needs">' +
                    '<div class="p86-needs-loading">Checking what needs you…</div>' +
                '</div>' +

                // Count tiles — the "by the numbers" strip.
                '<div class="p86-cmd-sectlabel">By the numbers</div>' +
                '<div class="p86-cmd-attention">' +
                    attentionCard('Overdue Invoices', overdueInv,  '#f87171', "window.switchTab('jobs');",   'Past due, unpaid') +
                    attentionCard('Open Leads',       openLeads,   '#22d3ee', leadsClick,                   'New + working') +
                    attentionCard('Pending Estimates', pendingEsts,'#fbbf24', estsClick,                    'Draft / not sent') +
                    attentionCard('Active Jobs',      activeJobs,  '#34d399', "window.switchTab('jobs');",   'Open + in progress') +
                    // Wave 3 — workflow items card. Counts hydrate async
                    // after first paint via fetchWorkflowAttentionCounts;
                    // the placeholders render as 0 so the card lays out
                    // immediately. Click → routes to the user's jobs.
                    '<div data-summary-workflow-card>' +
                      attentionCard('My Open RFIs/Subs', '<span data-workflow-mine-count>0</span>', '#fbbf24', "window.switchTab('jobs');", '<span data-workflow-mine-sub>Loading…</span>') +
                    '</div>' +
                    // Wave 3 — compliance expiring card. Click opens the
                    // dedicated compliance review drawer
                    // (window.p86ComplianceReview.open). Falls back to a
                    // no-op if the script hasn't loaded yet.
                    '<div data-summary-compliance-card>' +
                      attentionCard('Certs Expiring', '<span data-compliance-expiring-count>0</span>', '#f87171', "if(window.p86ComplianceReview)window.p86ComplianceReview.open();", '<span data-compliance-expiring-sub>Loading…</span>') +
                    '</div>' +
                    // CO Phase 6 — open change orders quick-count card.
                    // Hydrates from /api/change-orders/summary after
                    // first paint. Click routes to the jobs tab where
                    // CO management lives.
                    '<div data-summary-co-card>' +
                      attentionCard('Open Change Orders', '<span data-co-open-count>0</span>', '#22d3ee', "window.switchTab('jobs');", '<span data-co-open-sub>Loading…</span>') +
                    '</div>' +
                '</div>' +

                // ── Per-market P&L (multi-market M3) ───────────────
                // Comparison table under "All markets", single-market
                // figures when the sidebar switcher is set. Rendered by
                // js/market-pnl.js, which SUMS getJobWIP() and derives
                // nothing of its own; it hides itself entirely when the
                // org has fewer than two markets (same test the switcher
                // uses), so single-market orgs see no empty section
                // label. The label lives inside the host for that reason.
                '<div id="summary-market-pnl" class="p86-mktpnl"></div>' +

                // ── System Snapshot (Wave M3) ──────────────────────
                // Manifest-driven org-wide pulse. Fetched async after
                // first paint via fetchManifest(); the placeholder
                // below renders synchronously so the rest of Today
                // can paint without waiting on the network.
                '<div class="p86-cmd-sectlabel">System Snapshot</div>' +
                '<div id="summary-snapshot-row" class="p86-cmd-snapshot">' +
                    '<div class="p86-snapshot-placeholder">Loading snapshot…</div>' +
                '</div>' +

                // Two-col main grid:
                //   Left  — Recent Activity (single tall column)
                //   Right — Stacked rail with Agenda, Sales Pipeline,
                //           Recent Files, Inbox. Each rail widget has
                //           its own header + body card so they read
                //           as discrete sections in the column.
                // Mobile-only segmented control (Today / Money / Comms) —
                // toggles which workspace column group shows on phones.
                // Hidden on desktop via CSS; the hide-rules live inside the
                // 768px media query so all three columns show on desktop.
                '<div class="p86-cmd-seg" role="tablist" aria-label="Dashboard sections">' +
                    '<button type="button" class="p86-cmd-seg-btn active" data-seg="today" onclick="window.p86CmdSeg(\'today\')">Today</button>' +
                    '<button type="button" class="p86-cmd-seg-btn" data-seg="money" onclick="window.p86CmdSeg(\'money\')">Money</button>' +
                    '<button type="button" class="p86-cmd-seg-btn" data-seg="comms" onclick="window.p86CmdSeg(\'comms\')">Comms</button>' +
                '</div>' +
                // 3-column workspace. Each host id + data-attribute + onclick
                // is preserved from the prior layout so hydration is unchanged.
                '<div class="p86-cmd-workspace" data-seg="today">' +
                    // Col 1 (money) — combined leads + jobs map + sales pipeline.
                    '<div class="p86-cmd-col" data-seg-group="money">' +
                        // Half-height map (no --fill so the desktop flex-grow
                        // doesn't re-expand it back to full column height).
                        '<div class="p86-cmd-mod">' +
                            '<div class="p86-cmd-modhead"><span>Map</span></div>' +
                            '<div id="summaryMapHost" class="p86-cmd-modbody" style="padding:0;height:210px;min-height:210px;overflow:hidden;position:relative;"></div>' +
                        '</div>' +
                        // Sales pipeline renders its own header + card, so it
                        // sits as a bare host (no .p86-cmd-mod wrapper).
                        '<div id="summary-sales-host">' + renderSalesPipelineHTML(d, leadsClick, estsClick) + '</div>' +
                    '</div>' +
                    // Col 2 (today) — the "Today" itinerary (assistant snapshot +
                    // My Day timeline) + this-week agenda.
                    '<div class="p86-cmd-col" data-seg-group="today">' +
                        '<div class="p86-cmd-mod p86-cmd-mod--fill">' +
                            '<div class="p86-cmd-modhead"><span>Today</span>' +
                                '<button class="ee-btn ghost small" onclick="if(window.p86AI&amp;&amp;window.p86AI.open)window.p86AI.open({entityType:\'ask86\'});" style="font-size:11px;padding:2px 8px;">Ask 86 &rarr;</button>' +
                            '</div>' +
                            '<div class="p86-cmd-modbody">' +
                                // Assistant snapshot — task count-pills + reminders + quick-add
                                // (renderSummaryAssistant, trimmed of its own task LIST / next-up,
                                // which the itinerary below now owns).
                                '<div id="summary-assistant">Loading your day&hellip;</div>' +
                                // Today's itinerary — timed events + all-day/field work + tasks
                                // due, ported from My Day via window.p86MyDay.renderInto().
                                '<div id="summary-today-itinerary" style="margin-top:12px;"></div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="p86-cmd-mod">' +
                            '<div class="p86-cmd-modhead"><span>This Week’s Agenda</span>' +
                                '<button class="ee-btn ghost small" onclick="window.switchTab(\'schedule\')" style="font-size:11px;padding:2px 8px;">View schedule &rarr;</button>' +
                            '</div>' +
                            '<div id="summary-agenda" class="p86-cmd-modbody" style="text-align:center;">Loading agenda&hellip;</div>' +
                        '</div>' +
                    '</div>' +
                    // Col 3 (comms) — inbox + recent files + my notes.
                    '<div class="p86-cmd-col" data-seg-group="comms">' +
                        '<div class="p86-cmd-mod">' +
                            '<div class="p86-cmd-modhead"><span>Inbox</span>' +
                                '<button class="ee-btn ghost small" onclick="if (window.p86Messaging) window.p86Messaging.openInbox();" style="font-size:11px;padding:2px 8px;">Open inbox &rarr;</button>' +
                            '</div>' +
                            '<div id="summary-inbox" class="p86-cmd-modbody" style="text-align:center;">Loading inbox&hellip;</div>' +
                        '</div>' +
                        '<div class="p86-cmd-mod">' +
                            '<div class="p86-cmd-modhead"><span>Recent Files</span></div>' +
                            '<div id="summary-files" class="p86-cmd-modbody" style="text-align:center;">Loading recent files&hellip;</div>' +
                        '</div>' +
                        '<div class="p86-cmd-mod p86-cmd-mod--fill">' +
                            '<div class="p86-cmd-modhead"><span>My Notes</span></div>' +
                            '<div id="summary-notes" class="p86-cmd-modbody">Loading notes&hellip;</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';

            // Async-fetch + render the agenda. Failures degrade to a
            // "no schedule entries" empty state — the rest of the page
            // is already painted.
            renderSummaryAgenda();
            renderSummaryRecentFiles();
            renderSummaryInbox();
            // Phase 1 — combined leads+jobs map (D2), Assistant hub (D4),
            // My Notes (D3). Each is guarded for its host + deps existing
            // so a missing module degrades to its loading/empty state.
            renderSummaryMap();
            renderSummaryAssistant();
            renderSummaryTodayItinerary();
            renderSummaryNeedsYou();
            renderSummaryNotes();
            // Per-market P&L. Self-hides on a single-market org and
            // repaints itself on p86:market-changed (js/markets.js calls
            // p86MarketPnlRender), so it never needs a full Summary
            // repaint just to follow the switcher.
            if (window.p86MarketPnl) window.p86MarketPnl.render();
            paintSnapshotRow();
            fetchWorkflowAttentionCounts();
            fetchComplianceAttentionCounts();
            fetchChangeOrderAttentionCounts();
        }
        window.renderSummaryDashboard = renderSummaryDashboard;

        // Command-center mobile segmented control — swaps which workspace
        // column group is visible on phones (Today / Money / Comms). Inert
        // on desktop: the column hide-rules live inside the 768px media
        // query, so all three columns render regardless of data-seg. The
        // hidden columns' hosts are already hydrated, so switching tabs
        // never triggers a re-fetch.
        window.p86CmdSeg = function (seg) {
            var ws = document.querySelector('#summary-root .p86-cmd-workspace');
            if (!ws) return;
            ws.setAttribute('data-seg', seg);
            var b = document.querySelectorAll('#summary-root .p86-cmd-seg-btn');
            for (var i = 0; i < b.length; i++) {
                b[i].classList.toggle('active', b[i].getAttribute('data-seg') === seg);
            }
        };

        // Wave 3 — hydrate the "My Open RFIs/Subs" attention card after
        // first paint. Two parallel fetches (mine + overdue) feed:
        //   • The big number in the card (count of items where I'm the
        //     responsible party with status still open)
        //   • The subtitle text (e.g. "3 overdue org-wide" if any, else
        //     "All caught up" when zero of both)
        // No-op if the user has no /api/workflow-items endpoints
        // available (e.g. pre-deploy of the Wave 3 backend).
        function fetchWorkflowAttentionCounts() {
            var card = document.querySelector('[data-summary-workflow-card]');
            if (!card || !window.p86Api) return;
            Promise.all([
                window.p86Api.get('/api/workflow-items/mine').catch(function() { return { items: [] }; }),
                window.p86Api.get('/api/workflow-items/overdue').catch(function() { return { items: [] }; })
            ]).then(function (results) {
                if (!card.isConnected) return;
                var mine = (results[0] && results[0].items) || [];
                var overdue = (results[1] && results[1].items) || [];
                var countEl = card.querySelector('[data-workflow-mine-count]');
                var subEl = card.querySelector('[data-workflow-mine-sub]');
                if (countEl) countEl.textContent = String(mine.length);
                if (subEl) {
                    if (overdue.length) {
                        subEl.textContent = overdue.length + ' overdue org-wide';
                    } else if (mine.length) {
                        subEl.textContent = 'Open items needing your action';
                    } else {
                        subEl.textContent = 'All caught up';
                    }
                }
            }).catch(function() { /* silent — non-critical */ });
        }

        // Wave 3 — hydrate the "Certs Expiring" attention card. Same
        // shape as fetchWorkflowAttentionCounts but reads
        // /api/compliance-items/expiring (30-day default) +
        // /api/compliance-items/expired. The big number is
        // expiring-soon; the subtitle escalates to "N already expired"
        // when anything is past-due (red text auto-applies because
        // the attentionCard color is already #f87171).
        // CO Phase 6 — hydrate the "Open Change Orders" card. Single
        // org-wide aggregate from /api/change-orders/summary returns
        // {draft_count, approved_count, open_count}. Big number is the
        // total open; subtitle breaks down draft vs approved so the
        // user sees the pipeline split at a glance.
        function fetchChangeOrderAttentionCounts() {
            var card = document.querySelector('[data-summary-co-card]');
            if (!card || !window.p86Api) return;
            window.p86Api.get('/api/change-orders/summary').then(function (sum) {
                if (!card.isConnected) return;
                var draft = (sum && sum.draft_count) || 0;
                var approved = (sum && sum.approved_count) || 0;
                var open = (sum && sum.open_count) || 0;
                var countEl = card.querySelector('[data-co-open-count]');
                var subEl = card.querySelector('[data-co-open-sub]');
                if (countEl) countEl.textContent = String(open);
                if (subEl) {
                    if (open === 0) subEl.textContent = 'No COs in flight';
                    else subEl.textContent = draft + ' draft · ' + approved + ' approved';
                }
            }).catch(function() { /* silent */ });
        }

        function fetchComplianceAttentionCounts() {
            var card = document.querySelector('[data-summary-compliance-card]');
            if (!card || !window.p86Api) return;
            Promise.all([
                window.p86Api.get('/api/compliance-items/expiring?days=30').catch(function() { return { items: [] }; }),
                window.p86Api.get('/api/compliance-items/expired').catch(function() { return { items: [] }; })
            ]).then(function (results) {
                if (!card.isConnected) return;
                var expiring = (results[0] && results[0].items) || [];
                var expired = (results[1] && results[1].items) || [];
                var countEl = card.querySelector('[data-compliance-expiring-count]');
                var subEl = card.querySelector('[data-compliance-expiring-sub]');
                if (countEl) countEl.textContent = String(expiring.length);
                if (subEl) {
                    if (expired.length) {
                        subEl.textContent = '⚠ ' + expired.length + ' already expired';
                    } else if (expiring.length) {
                        subEl.textContent = 'Within next 30 days';
                    } else {
                        subEl.textContent = 'All current';
                    }
                }
            }).catch(function() { /* silent — non-critical */ });
        }

        // ── System Snapshot row (Wave M3) ────────────────────────────
        // Lightweight 4-counter row on the Today pane: Active Jobs,
        // Open COs, Reports, Photos This Week. Reads from the shared
        // manifest cache so opening Summary + flipping to System Map
        // doesn't trigger a second round-trip.
        function paintSnapshotRow() {
            var host = document.getElementById('summary-snapshot-row');
            if (!host) return;
            fetchManifest().then(function (m) {
                if (!host.isConnected) return; // user navigated away
                if (!m) { host.innerHTML = ''; return; }
                var ent = m.entities || {};
                var jobs = (ent.jobs && ent.jobs.active) || 0;
                var openCOs = 0;
                if (ent.change_orders) {
                    openCOs = (ent.change_orders.draft || 0) + (ent.change_orders.approved || 0);
                }
                var reports = (ent.reports && ent.reports.total) || 0;
                var photosWeek = (ent.photos && ent.photos.last_7d_uploaded) || 0;
                function snap(label, count, color, sub, onClick) {
                    return '<button class="p86-snapshot-card" onclick="' + onClick + '" type="button">' +
                        '<div class="p86-snapshot-card-label">' + label + '</div>' +
                        '<div class="p86-snapshot-card-count" style="color:' + (count > 0 ? color : 'var(--text-dim,#888)') + ';">' + count + '</div>' +
                        '<div class="p86-snapshot-card-sub">' + sub + '</div>' +
                    '</button>';
                }
                host.innerHTML =
                    snap('Active Jobs', jobs, '#34d399', 'All open work', "window.switchTab('jobs');") +
                    snap('Open COs', openCOs, '#fbbf24', 'Draft + approved', "window.switchTab('jobs');") +
                    snap('Reports', reports, '#22d3ee', 'Across all projects', "window.switchTab('my-files');") +
                    snap('Photos / 7d', photosWeek, '#a78bfa', 'Uploaded this week', "window.switchTab('my-files');");
            });
        }

        // ── Sales pipeline widget ─────────────────────────────────────
        // Open leads + pending estimates rolled up into a small
        // pipeline view. Uses appData entirely; no backend changes.
        function renderSalesPipelineHTML(d, leadsClick, estsClick) {
            var leads = (d.leads || []);
            var openLeads = leads.filter(function(l) {
                var s = (l && l.status || '').toLowerCase();
                return s !== 'closed' && s !== 'lost' && s !== 'archived' && s !== 'won';
            });
            var pipelineValue = openLeads.reduce(function(sum, l) {
                return sum + Number(l.estimatedValue || l.estimated_value || l.value || 0);
            }, 0);
            var proposalsOut = (d.estimates || []).filter(function(e) {
                var s = (e && e.bt_export_status || '').toLowerCase();
                return s === 'sent' || s === 'submitted' || s === 'pending';
            }).length;
            var thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
            var wonRecent = leads.filter(function(l) {
                if (!l) return false;
                var s = (l.status || '').toLowerCase();
                if (s !== 'won' && s !== 'sold') return false;
                var ts = new Date(l.updatedAt || l.updated_at || l.dateAdded || 0).getTime();
                return isFinite(ts) && ts >= thirtyDaysAgo;
            }).length;

            // Hot leads — recently-touched open leads, top 5.
            var hotLeads = openLeads.slice().sort(function(a, b) {
                var ta = new Date(a.updatedAt || a.updated_at || a.dateAdded || 0).getTime();
                var tb = new Date(b.updatedAt || b.updated_at || b.dateAdded || 0).getTime();
                return tb - ta;
            }).slice(0, 5);

            function fmtMoney(v) {
                if (!v || !isFinite(v)) return '—';
                if (v >= 1000) return '$' + (Math.round(v / 100) / 10).toLocaleString() + 'k';
                return '$' + Math.round(v).toLocaleString();
            }

            var rows = '';
            if (!hotLeads.length) {
                rows = '<div style="padding:18px;text-align:center;color:var(--text-dim,#888);font-size:12px;">No open leads in the pipeline.</div>';
            } else {
                hotLeads.forEach(function(l) {
                    var title = l.title || l.name || 'Lead';
                    var sub = l.client || l.community || (l.status ? 'status: ' + l.status : '');
                    var val = Number(l.estimatedValue || l.estimated_value || l.value || 0);
                    rows += '<button class="ee-btn" onclick="' + leadsClick + '" style="text-align:left;padding:8px 12px;background:transparent;border:none;border-bottom:1px solid var(--border,#222);cursor:pointer;display:flex;align-items:center;gap:10px;width:100%;">' +
                        '<div style="flex:1;min-width:0;">' +
                            '<div style="font-size:12px;color:var(--text,#fff);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(title) + '</div>' +
                            (sub ? '<div style="font-size:10px;color:var(--text-dim,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(sub) + '</div>' : '') +
                        '</div>' +
                        '<span style="font-size:11px;color:var(--accent,#22d3ee);font-variant-numeric:tabular-nums;flex-shrink:0;">' + fmtMoney(val) + '</span>' +
                    '</button>';
                });
            }

            return '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
                    '<div style="font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Sales Pipeline</div>' +
                    '<button class="ee-btn ghost small" onclick="' + leadsClick + '" style="font-size:11px;padding:2px 8px;">All leads &rarr;</button>' +
                '</div>' +
                '<div style="border:1px solid var(--border,#333);border-radius:10px;background:var(--card-bg,#141419);overflow:hidden;">' +
                    // Stat strip
                    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border,#222);">' +
                        salesStat('Pipeline',     fmtMoney(pipelineValue), '#22d3ee') +
                        salesStat('Proposals out', proposalsOut,           '#fbbf24') +
                        salesStat('Won 30d',       wonRecent,              '#34d399') +
                    '</div>' +
                    '<div style="padding-top:1px;background:var(--border,#222);"></div>' +
                    rows +
                '</div>';
        }
        function salesStat(label, value, color) {
            return '<div style="background:var(--card-bg,#141419);padding:10px 12px;text-align:center;">' +
                '<div style="font-size:9px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;margin-bottom:2px;">' + label + '</div>' +
                '<div style="font-size:18px;font-weight:700;color:' + color + ';font-variant-numeric:tabular-nums;line-height:1;">' + value + '</div>' +
            '</div>';
        }

        // ── Recent Files widget ───────────────────────────────────────
        // Cross-entity recent uploads, fetched from /api/attachments/
        // recent. Image attachments render with their thumb_url; non-
        // image docs render with a colored kind chip + filename.
        function renderSummaryRecentFiles() {
            var host = document.getElementById('summary-files');
            if (!host) return;
            if (!window.p86Api || !window.p86Api.attachments || typeof window.p86Api.attachments.recent !== 'function') {
                host.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim,#888);font-size:12px;">Files not available offline.</div>';
                return;
            }
            window.p86Api.attachments.recent(8).then(function(res) {
                var atts = (res && res.attachments) || [];
                if (!atts.length) {
                    host.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text-dim,#888);font-size:12px;">No files uploaded yet.</div>';
                    return;
                }
                var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;padding:8px;">';
                atts.forEach(function(a) {
                    var isImg = a.mime_type && /^image\//i.test(a.mime_type) && a.thumb_url;
                    var fname = (a.filename || '').replace(/"/g, '&quot;');
                    var entity = a.entity_type ? (a.entity_type.charAt(0).toUpperCase() + a.entity_type.slice(1)) : '';
                    var title = entity ? (entity + ' · ' + fname) : fname;
                    var inner;
                    if (isImg) {
                        inner = '<img src="' + a.thumb_url + '" alt="" style="width:100%;height:64px;object-fit:cover;display:block;" />';
                    } else {
                        var ext = (fname.split('.').pop() || '').slice(0, 4).toUpperCase() || 'DOC';
                        inner = '<div style="height:64px;display:flex;align-items:center;justify-content:center;background:rgba(34,211,238,0.06);font-size:10px;font-weight:700;color:var(--accent,#22d3ee);letter-spacing:0.4px;">' + escapeHTML(ext) + '</div>';
                    }
                    html += '<a href="' + (a.original_url || a.web_url || '#') + '" target="_blank" rel="noopener" title="' + escapeHTML(title) + '" style="display:block;border:1px solid var(--border,#333);border-radius:6px;overflow:hidden;background:var(--card-bg,#141419);text-decoration:none;">' +
                        inner +
                        '<div style="padding:4px 6px;font-size:9px;color:var(--text-dim,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(fname) + '</div>' +
                    '</a>';
                });
                html += '</div>';
                host.innerHTML = html;
            }).catch(function() {
                host.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim,#888);font-size:12px;">Could not load recent files.</div>';
            });
        }

        // ── Combined map (Phase 1 — D2) ───────────────────────────────
        // Plot leads + jobs together into #summaryMapHost via the
        // self-contained entities-map renderer. Guarded for the host +
        // both the entities-map module and the Maps loader existing, so a
        // key-less / module-missing deploy degrades to a clean message
        // rather than a console error.
        function renderSummaryMap() {
            var host = document.getElementById('summaryMapHost');
            if (!host) return;
            if (window.p86EntitiesMap && typeof window.p86EntitiesMap.render === 'function' &&
                window.p86Maps && typeof window.p86Maps.ready === 'function') {
                window.p86EntitiesMap.render('summaryMapHost');
            } else {
                host.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:210px;color:var(--text-dim,#888);font-size:13px;text-align:center;padding:18px;">Map module not loaded.</div>';
            }
        }

        // ── Today itinerary — ports My Day (events + field work + tasks due)
        // into the Summary "Today" column via the reused p86MyDay.renderInto.
        // Email is omitted here (it's promoted to the Needs-you lane below).
        function renderSummaryTodayItinerary() {
            var host = document.getElementById('summary-today-itinerary');
            if (!host) return;
            if (window.p86MyDay && typeof window.p86MyDay.renderInto === 'function') {
                window.p86MyDay.renderInto(host, { showEmail: false });
            } else {
                host.innerHTML = '';
            }
        }

        // ── "Needs you now" lane ──────────────────────────────────────
        // The at-a-glance "what am I missing / act on these" list. Fuses the
        // most time-sensitive actionable items across sources into one ranked
        // list with per-row one-tap actions + an urgency signal (red = act
        // now + pulse, amber = due soon). Each source degrades to empty.
        function ensureNeedsStyles() {
            if (document.getElementById('p86-needs-styles')) return;
            var css =
                '.p86-needs{display:flex;flex-direction:column;gap:6px;margin:0 0 6px;}' +
                '.p86-needs-loading,.p86-needs-empty{font-size:12.5px;color:var(--text-dim,#8a8a9a);padding:10px 12px;border:1px dashed var(--border,#2a2a3a);border-radius:9px;}' +
                '.p86-needs-empty{color:#34d399;border-style:solid;border-color:rgba(52,211,153,0.3);background:rgba(52,211,153,0.05);}' +
                '.p86-needs-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border,#2a2a3a);border-left:3px solid var(--needs-c,#fbbf24);border-radius:9px;background:var(--card-bg,#141419);cursor:pointer;transition:background .12s,border-color .12s;}' +
                '.p86-needs-row:hover{background:rgba(255,255,255,0.03);border-color:var(--needs-c,#fbbf24);}' +
                '.p86-needs-crit{animation:p86NeedsPulse 2.2s ease-in-out infinite;}' +
                '@keyframes p86NeedsPulse{0%,100%{box-shadow:0 0 0 0 rgba(248,113,113,0);}50%{box-shadow:0 0 11px 0 rgba(248,113,113,0.45);}}' +
                '@media (prefers-reduced-motion:reduce){.p86-needs-crit{animation:none;}}' +
                '.p86-needs-ico{display:inline-flex;width:16px;height:16px;color:var(--needs-c,#fbbf24);flex-shrink:0;}' +
                '.p86-needs-ico svg{width:16px;height:16px;}' +
                '.p86-needs-body{flex:1;min-width:0;display:flex;flex-direction:column;}' +
                '.p86-needs-title{font-size:13px;font-weight:600;color:var(--text,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
                '.p86-needs-sub{font-size:11.5px;color:var(--text-dim,#8a8a9a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
                // Was a non-interactive div that merely counted the overflow —
                // it looked like a link and did nothing. It is a real toggle now.
                '.p86-needs-more{display:block;width:100%;text-align:left;font-size:11.5px;color:var(--accent,#22d3ee);' +
                  'padding:6px 12px;cursor:pointer;background:none;border:1px solid transparent;border-radius:8px;font-family:inherit;}' +
                '.p86-needs-more:hover{background:rgba(255,255,255,0.04);border-color:var(--border,#2a2a3a);}' +
                '.p86-needs-more:focus-visible{outline:2px solid var(--accent,#22d3ee);outline-offset:1px;}' +
                '.p86-needs-note{font-size:11px;color:var(--text-dim,#8a8a9a);padding:2px 12px 0;}';
            var st = document.createElement('style');
            st.id = 'p86-needs-styles';
            st.textContent = css;
            document.head.appendChild(st);
        }
        function renderSummaryNeedsYou() {
            var host = document.getElementById('summary-needs');
            if (!host) return;
            ensureNeedsStyles();
            var todayStr = (function () {
                var dt = new Date(); dt.setHours(0, 0, 0, 0);
                var m = String(dt.getMonth() + 1).padStart(2, '0');
                var d = String(dt.getDate()).padStart(2, '0');
                return dt.getFullYear() + '-' + m + '-' + d;
            })();
            var api = window.p86Api;
            var emailP = fetch('/api/email-inbox/threads?limit=50', { credentials: 'include' })
                .then(function (r) { return r.ok ? r.json() : { threads: [] }; })
                .catch(function () { return { threads: [] }; });
            var tasksP = (api && api.tasks && api.tasks.list)
                ? api.tasks.list({ assignee: 'me', exclude_done: 1, limit: 200 })
                    .then(function (r) { return (r && r.tasks) || []; }).catch(function () { return []; })
                : Promise.resolve([]);
            Promise.all([emailP, tasksP]).then(function (out) {
                var threads = (out[0] && out[0].threads) || [];
                var tasks = out[1] || [];
                var items = [];
                function q(s) { return String(s == null ? '' : s).replace(/'/g, "\\'"); }
                // 1) Emails needing a reply (urgency from triage).
                //
                // needs_reply is written ONCE by the Haiku triage pass on the
                // newest inbound message and nothing ever clears it — so on its
                // own this lane grows forever and keeps nagging about threads
                // already dealt with. The thread payload does carry the answer
                // (last_direction: "'outbound' means I replied last", plus
                // replied_at from email_thread_state); this lane simply wasn't
                // consulting it. Suppress anything already answered.
                //
                // Read state is deliberately NOT used: having opened a mail is
                // not the same as having handled it, and dropping rows on read
                // would hide work rather than complete it.
                threads.forEach(function (t) {
                    if (!t.needs_reply) return;
                    if (t.last_direction === 'outbound' || t.replied_at) return;
                    var hi = (t.triage_urgency === 'high');
                    items.push({
                        sev: hi ? 2 : 1, color: hi ? '#f87171' : '#fbbf24', icon: 'at-symbol',
                        title: t.entity_label || t.last_from || 'Email',
                        sub: 'Needs a reply — ' + (t.subject || '(no subject)'),
                        onclick: "window.switchTab('email-hub')"
                    });
                });
                // 2) Overdue lead follow-ups (from appData; skip terminal statuses).
                var leads = (window.appData && window.appData.leads) || [];
                var TERMINAL = { sold: 1, lost: 1, no_opportunity: 1 };
                leads.forEach(function (l) {
                    if (!l || !l.next_followup_at || TERMINAL[l.status]) return;
                    var d = String(l.next_followup_at).slice(0, 10);
                    if (d >= todayStr) return;
                    var days = Math.max(1, Math.round((new Date(todayStr) - new Date(d)) / 864e5));
                    var hi = days >= 7;
                    items.push({
                        sev: hi ? 2 : 1, color: hi ? '#f87171' : '#fbbf24', icon: 'clients',
                        title: l.title || l.property_name || 'Lead',
                        sub: 'Follow-up ' + days + 'd overdue',
                        onclick: "if(window.openEditLeadModal)window.openEditLeadModal('" + q(l.id) + "')"
                    });
                });
                // 3) Overdue tasks.
                tasks.forEach(function (t) {
                    if (!t.due_date) return;
                    var d = String(t.due_date).slice(0, 10);
                    if (d >= todayStr) return;
                    items.push({
                        sev: 2, color: '#f87171', icon: 'reports',
                        title: t.title || '(untitled task)', sub: 'Task overdue',
                        onclick: "if(window.p86Tasks&&window.p86Tasks.openDetail)window.p86Tasks.openDetail('" + q(t.id) + "')"
                    });
                });
                items.sort(function (a, b) { return b.sev - a.sev; });
                if (!items.length) {
                    host.innerHTML = '<div class="p86-needs-empty">&#10003; You\'re all caught up — nothing needs you right now.</div>';
                    return;
                }
                // Collapsed by default: the single most urgent item, everything
                // else behind a toggle. At 7 rows this card ate the fold and
                // pushed the actual dashboard off screen — a "what needs me"
                // lane that buries the page is self-defeating. items is already
                // sorted by severity, so slice(0,1) IS the most urgent.
                function rowHTML(it) {
                    var ic = (window.p86Icon && window.p86Icon(it.icon)) || '';
                    return '<div class="p86-needs-row' + (it.sev === 2 ? ' p86-needs-crit' : '') + '" style="--needs-c:' + it.color + ';" onclick="' + it.onclick + '">' +
                        '<span class="p86-needs-ico">' + ic + '</span>' +
                        '<span class="p86-needs-body">' +
                            '<span class="p86-needs-title">' + escapeHTML(it.title) + '</span>' +
                            '<span class="p86-needs-sub">' + escapeHTML(it.sub) + '</span>' +
                        '</span>' +
                    '</div>';
                }
                var CAP = 12;                       // ceiling once expanded
                var shown = items.slice(0, CAP);
                function paint(expanded) {
                    var html = (expanded ? shown : shown.slice(0, 1)).map(rowHTML).join('');
                    var hidden = shown.length - 1;
                    if (hidden > 0) {
                        html += '<button type="button" class="p86-needs-more" data-needs-toggle>' +
                            (expanded ? '&minus; Show less' : '+' + hidden + ' more') + '</button>';
                    }
                    if (!expanded && items.length > CAP) {
                        html += '<div class="p86-needs-note">' + (items.length - CAP) + ' beyond the first ' + CAP + ' not listed</div>';
                    }
                    host.innerHTML = html;
                    var tg = host.querySelector('[data-needs-toggle]');
                    if (tg) tg.addEventListener('click', function () { paint(!expanded); });
                }
                paint(false);
            }).catch(function () {
                host.innerHTML = '<div class="p86-needs-empty">Could not load your action items.</div>';
            });
        }

        // ── AI Assistant Hub (Phase 1 — D4) ───────────────────────────
        // READ-ONLY over the existing tasks system (no new store). Shows
        // a one-line daily summary, Today / Overdue / Upcoming counts +
        // a short list of the caller's own open tasks, and a quick-add
        // that reuses window.p86Tasks.openQuickAdd. The Ask 86 entry lives
        // in the card header (wired to window.p86AI.open).
        function renderSummaryAssistant() {
            var host = document.getElementById('summary-assistant');
            if (!host) return;
            if (!window.p86Api || !window.p86Api.tasks || typeof window.p86Api.tasks.list !== 'function') {
                host.innerHTML = '<div style="text-align:center;color:var(--text-dim,#888);font-size:12px;padding:8px;">Tasks not available offline.</div>';
                return;
            }
            // Personal hub: my open tasks + pending reminders + next
            // appointment, fetched in parallel. Each feed degrades to [] so a
            // missing/erroring endpoint never blanks the whole card.
            var nowD = new Date();
            var tasksP = window.p86Api.tasks.list({ assignee: 'me', exclude_done: 1, limit: 100 })
                .then(function(r) { return (r && r.tasks) || []; }).catch(function() { return []; });
            var remP = (window.p86Api.reminders && window.p86Api.reminders.list)
                ? window.p86Api.reminders.list().then(function(r) { return (r && r.reminders) || []; }).catch(function() { return []; })
                : Promise.resolve([]);
            var calP = (window.p86Api.calendar && window.p86Api.calendar.list)
                ? window.p86Api.calendar.list({ from: nowD.toISOString(), to: new Date(nowD.getTime() + 14 * 864e5).toISOString() })
                    .then(function(r) { return (r && r.events) || []; }).catch(function() { return []; })
                : Promise.resolve([]);

            // Compact "Today 3:00 PM" / "Tmrw 9:00 AM" / "Tue Jun 24 8:00 AM".
            function fmtWhenShort(iso) {
                var d = new Date(iso);
                if (isNaN(d.getTime())) return '';
                var t = '';
                try { t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (e) {}
                var nd = new Date(); var tm = new Date(); tm.setDate(nd.getDate() + 1);
                if (d.toDateString() === nd.toDateString()) return 'Today' + (t ? ' ' + t : '');
                if (d.toDateString() === tm.toDateString()) return 'Tmrw' + (t ? ' ' + t : '');
                var ds = '';
                try { ds = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { ds = String(iso).slice(0, 10); }
                return ds + (t ? ' ' + t : '');
            }
            function sectionLabel(txt) {
                return '<div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);margin:0 0 6px;">' + escapeHTML(txt) + '</div>';
            }

            Promise.all([tasksP, remP, calP]).then(function(out) {
                var tasks = out[0], reminders = out[1], events = out[2];
                var todayStr = (function() {
                    var dt = new Date(); dt.setHours(0, 0, 0, 0);
                    var m = String(dt.getMonth() + 1).padStart(2, '0');
                    var d = String(dt.getDate()).padStart(2, '0');
                    return dt.getFullYear() + '-' + m + '-' + d;
                })();
                function dueYmd(t) {
                    if (!t.due_date) return null;
                    return String(t.due_date).slice(0, 10);
                }
                var overdue = [], today = [], upcoming = [];
                tasks.forEach(function(t) {
                    var y = dueYmd(t);
                    if (!y) { upcoming.push(t); return; }
                    if (y < todayStr) overdue.push(t);
                    else if (y === todayStr) today.push(t);
                    else upcoming.push(t);
                });

                var pendRems = reminders.filter(function(r) { return (r.status || 'pending') === 'pending'; })
                    .sort(function(a, b) { return new Date(a.remind_at) - new Date(b.remind_at); });
                var nextEv = events[0] || null; // server returns starts_at ASC, windowed to now+14d

                // One-line summary spanning all three feeds.
                var bits = [];
                if (overdue.length) bits.push(overdue.length + ' overdue');
                if (today.length) bits.push(today.length + ' due today');
                if (pendRems.length) bits.push(pendRems.length + ' reminder' + (pendRems.length === 1 ? '' : 's'));
                var summaryLine = bits.length
                    ? bits.join(' · ')
                    : (tasks.length ? tasks.length + ' open task' + (tasks.length === 1 ? '' : 's') + ', none overdue.' : 'All caught up — nothing needs you right now.');

                function countPill(label, n, color) {
                    var c = (n > 0) ? color : 'var(--text-dim,#888)';
                    return '<div style="flex:1;text-align:center;padding:6px 4px;background:rgba(255,255,255,0.02);border:1px solid var(--border,#333);border-radius:8px;">' +
                        '<div style="font-size:18px;font-weight:700;line-height:1;color:' + c + ';font-variant-numeric:tabular-nums;">' + n + '</div>' +
                        '<div style="font-size:9px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-dim,#888);margin-top:3px;">' + label + '</div>' +
                    '</div>';
                }

                var html =
                    '<div style="font-size:12px;color:var(--text,#fff);margin-bottom:10px;line-height:1.4;">' + escapeHTML(summaryLine) + '</div>' +
                    '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
                        countPill('Today', today.length, '#22d3ee') +
                        countPill('Overdue', overdue.length, '#f87171') +
                        countPill('Upcoming', upcoming.length, '#34d399') +
                    '</div>';

                // NEXT UP + MY TASKS moved to the Today itinerary below (which
                // lists today's events/field work/tasks). The snapshot keeps just
                // the summary + count pills + reminders + quick-add so the Today
                // column doesn't double-list the same tasks/appointments.

                // REMINDERS — pending, soonest first (top 3).
                if (pendRems.length) {
                    html += sectionLabel(pendRems.length > 3 ? 'Reminders · ' + pendRems.length : 'Reminders');
                    html += '<div style="display:flex;flex-direction:column;gap:1px;background:var(--border,#222);border-radius:8px;overflow:hidden;margin-bottom:12px;">';
                    pendRems.slice(0, 3).forEach(function(r) {
                        var rOver = new Date(r.remind_at).getTime() < nowD.getTime();
                        html += '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--card-bg,#141419);">' +
                            '<span style="color:#a855f7;font-size:11px;flex-shrink:0;">&#9200;</span>' +
                            '<span style="flex:1;font-size:12px;color:var(--text,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(r.title || '(untitled)') + '</span>' +
                            '<span style="font-size:10px;font-weight:600;flex-shrink:0;color:' + (rOver ? '#f87171' : 'var(--text-dim,#888)') + ';">' + escapeHTML(fmtWhenShort(r.remind_at)) + '</span>' +
                        '</div>';
                    });
                    html += '</div>';
                }

                // MY TASKS list moved to the Today itinerary below (renders the
                // actual overdue/today tasks as time-ordered cards).

                // Quick-add — reuses the tasks quick-capture modal.
                html += '<button class="ee-btn primary" onclick="if(window.p86Tasks&amp;&amp;window.p86Tasks.openQuickAdd)window.p86Tasks.openQuickAdd()" style="width:100%;font-size:12px;padding:7px;">+ Quick add task</button>';

                host.innerHTML = html;
            }).catch(function(err) {
                host.innerHTML = '<div style="text-align:center;color:var(--text-dim,#888);font-size:12px;padding:8px;">Could not load hub: ' + escapeHTML((err && err.message) || 'error') + '</div>';
            });
        }
        // Public hook so other surfaces (e.g. after creating a task) can
        // ask the Assistant hub to refresh.
        window.refreshSummaryAssistant = function() {
            var summaryDiv = document.getElementById('summary');
            if (summaryDiv && summaryDiv.classList.contains('active')) renderSummaryAssistant();
        };

        // ── My Notes (Phase 1 — D3) ───────────────────────────────────
        // Personal, private notes. Pinned first; single-line quick-add;
        // click a note to edit (inline); pin toggle; delete. All four ops
        // route through p86Api.notes (server scopes every call to the
        // caller's own org+user — a second user never sees these).
        function renderSummaryNotes() {
            var host = document.getElementById('summary-notes');
            if (!host) return;
            if (!window.p86Api || !window.p86Api.notes || typeof window.p86Api.notes.list !== 'function') {
                host.innerHTML = '<div style="text-align:center;color:var(--text-dim,#888);font-size:12px;padding:8px;">Notes not available offline.</div>';
                return;
            }
            window.p86Api.notes.list().then(function(res) {
                var notes = (res && res.notes) || [];
                var html = '';

                // Quick-add — single-line input + Enter / button to create.
                html += '<div style="display:flex;gap:6px;margin-bottom:10px;">' +
                    '<input id="summary-note-add" type="text" placeholder="Jot a note…" ' +
                        'style="flex:1;font-size:12px;padding:7px 9px;background:var(--input-bg,#1a1a2e);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);" />' +
                    '<button class="ee-btn primary" data-note-add-btn style="font-size:12px;padding:7px 10px;flex-shrink:0;">Add</button>' +
                '</div>';

                if (!notes.length) {
                    html += '<div style="text-align:center;color:var(--text-dim,#888);font-size:12px;padding:10px;">No notes yet. Type above to start.</div>';
                } else {
                    html += '<div style="display:flex;flex-direction:column;gap:1px;background:var(--border,#222);border-radius:8px;overflow:hidden;">';
                    notes.forEach(function(n) {
                        var label = (n.title && n.title.trim()) || (n.body && n.body.trim()) || '(empty note)';
                        var oneLine = String(label).replace(/\s+/g, ' ').slice(0, 80);
                        html += '<div data-note-row data-note-id="' + escapeHTML(String(n.id)) + '" style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--card-bg,#141419);">' +
                            '<button data-note-pin title="' + (n.pinned ? 'Unpin' : 'Pin') + '" style="background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;padding:0;line-height:1;" >' + (n.pinned ? '\u{1F4CC}' : '\u{1F4CD}') + '</button>' +
                            '<span data-note-open style="flex:1;font-size:12px;color:var(--text,#fff);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="Click to edit">' + escapeHTML(oneLine) + '</span>' +
                            '<button data-note-del title="Delete" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-dim,#888);flex-shrink:0;padding:0;line-height:1;">✕</button>' +
                        '</div>';
                    });
                    html += '</div>';
                }
                host.innerHTML = html;
                wireSummaryNotes(host, notes);
            }).catch(function(err) {
                host.innerHTML = '<div style="text-align:center;color:var(--text-dim,#888);font-size:12px;padding:8px;">Could not load notes: ' + escapeHTML((err && err.message) || 'error') + '</div>';
            });
        }

        // Attach handlers for quick-add / pin / delete / edit. Each op
        // calls p86Api.notes then re-renders so the list stays in sync.
        function wireSummaryNotes(host, notes) {
            function refresh() { renderSummaryNotes(); }

            var input = host.querySelector('#summary-note-add');
            var addBtn = host.querySelector('[data-note-add-btn]');
            function doAdd() {
                var val = (input && input.value || '').trim();
                if (!val) { if (input) input.focus(); return; }
                if (addBtn) addBtn.disabled = true;
                window.p86Api.notes.create({ title: val }).then(refresh).catch(function(err) {
                    if (addBtn) addBtn.disabled = false;
                    if (window.p86Toast) window.p86Toast((err && err.message) || 'Could not add note', 'error');
                });
            }
            if (addBtn) addBtn.addEventListener('click', doAdd);
            if (input) input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
            });

            var byId = {};
            (notes || []).forEach(function(n) { byId[String(n.id)] = n; });

            host.querySelectorAll('[data-note-row]').forEach(function(row) {
                var id = row.getAttribute('data-note-id');
                var note = byId[id] || {};

                var pinBtn = row.querySelector('[data-note-pin]');
                if (pinBtn) pinBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    window.p86Api.notes.update(id, { pinned: !note.pinned }).then(refresh).catch(function(err) {
                        if (window.p86Toast) window.p86Toast((err && err.message) || 'Could not update note', 'error');
                    });
                });

                var delBtn = row.querySelector('[data-note-del]');
                if (delBtn) delBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    window.p86Api.notes.remove(id).then(refresh).catch(function(err) {
                        if (window.p86Toast) window.p86Toast((err && err.message) || 'Could not delete note', 'error');
                    });
                });

                var openEl = row.querySelector('[data-note-open]');
                if (openEl) openEl.addEventListener('click', function() {
                    openNoteEditor(id, note, refresh);
                });
            });
        }

        // Inline note editor — a small prompt-style modal via the shared
        // dialogs helper when present, else a plain editable replacement.
        function openNoteEditor(id, note, onSaved) {
            // Prefer the app's dialog helper if it exposes a text prompt.
            var current = (note.title || '') + (note.body ? ('\n' + note.body) : '');
            var next = window.prompt('Edit note (first line = title):', current);
            if (next == null) return; // cancelled
            var lines = String(next).split('\n');
            var title = (lines.shift() || '').trim();
            var body = lines.join('\n');
            window.p86Api.notes.update(id, { title: title, body: body }).then(onSaved).catch(function(err) {
                if (window.p86Toast) window.p86Toast((err && err.message) || 'Could not save note', 'error');
            });
        }

        // ── Inbox widget ──────────────────────────────────────────────
        // Pulls /api/messages/recent and surfaces top 4 threads with
        // unread badges; clicking a row opens the inbox modal directly
        // on that thread. Empty state guides the user to start a thread
        // from a job/lead/estimate. Total unread roll-up is shown in
        // the row header so the user has a single number to glance at.
        function renderSummaryInbox() {
            var host = document.getElementById('summary-inbox');
            if (!host) return;
            if (!window.p86Api || !window.p86Api.messages) {
                host.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--text-dim,#888);">Messaging not available.</div>';
                return;
            }
            window.p86Api.messages.recent().then(function(res) {
                var threads = (res && res.threads) || [];
                var totalUnread = Number((res && res.total_unread) || 0);
                if (!threads.length) {
                    host.innerHTML =
                        '<div style="font-size:24px;margin-bottom:6px;">\u{1F4ED}</div>' +
                        '<div style="font-weight:600;color:var(--text,#fff);margin-bottom:2px;">No conversations yet</div>' +
                        '<div style="font-size:11px;">Open a job, lead, or estimate and start a thread.</div>';
                    return;
                }
                var top = threads.slice(0, 4);
                var html = '';
                if (totalUnread > 0) {
                    html += '<div style="text-align:left;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:8px;">' +
                        '<strong style="color:#f87171;font-size:13px;">' + totalUnread + '</strong> unread across ' + threads.length + ' thread' + (threads.length === 1 ? '' : 's') +
                    '</div>';
                }
                html += '<div style="display:flex;flex-direction:column;gap:1px;text-align:left;background:var(--border,#222);border-radius:8px;overflow:hidden;">';
                top.forEach(function(t) {
                    var unread = Number(t.unread_count || 0);
                    var preview = (t.last_body || '').replace(/\s+/g, ' ').slice(0, 60);
                    var who = t.last_user_name || 'Someone';
                    html += '<button class="ee-btn" onclick="if (window.p86Messaging) window.p86Messaging.openInbox();" style="text-align:left;padding:8px 10px;background:var(--card-bg,#141419);border:none;cursor:pointer;display:flex;flex-direction:column;gap:2px;">' +
                        '<div style="display:flex;align-items:center;gap:6px;">' +
                            '<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:var(--accent,#22d3ee);">' + escapeHTML(t.kind || 'thread') + '</span>' +
                            (unread ? '<span style="margin-left:auto;background:#f87171;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;line-height:1.4;">' + unread + '</span>'
                                    : '<span style="margin-left:auto;font-size:10px;color:var(--text-dim,#888);">' + escapeHTML(t.last_created_at ? timeAgoLocal(t.last_created_at) : '') + '</span>') +
                        '</div>' +
                        '<div style="font-size:12px;color:var(--text,#fff);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(t.label || t.thread_key) + '</div>' +
                        '<div style="font-size:11px;color:var(--text-dim,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(who) + ': ' + escapeHTML(preview) + '</div>' +
                    '</button>';
                });
                html += '</div>';
                host.innerHTML = html;
            }).catch(function(err) {
                host.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--text-dim,#888);">Could not load: ' + escapeHTML(err.message || 'error') + '</div>';
            });
        }
        // Public hook so the messaging module can ask the summary to
        // refresh its unread badge after a post.
        window.refreshSummaryUnreadBadge = function() {
            // Only re-render if the user is currently looking at summary.
            var summaryDiv = document.getElementById('summary');
            if (summaryDiv && summaryDiv.classList.contains('active')) {
                renderSummaryInbox();
            }
        };

        // Local time-ago helper for the inbox card. Mirror of the one
        // inside renderSummaryDashboard so this function isn't coupled
        // to the closure scope of that one.
        function timeAgoLocal(ts) {
            var t = ts ? new Date(ts).getTime() : NaN;
            if (!isFinite(t)) return '';
            var diff = Math.max(0, Date.now() - t);
            if (diff < 60 * 1000) return 'just now';
            if (diff < 60 * 60 * 1000) return Math.floor(diff / (60 * 1000)) + 'm ago';
            if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / (60 * 60 * 1000)) + 'h ago';
            if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / (24 * 60 * 60 * 1000)) + 'd ago';
            return new Date(ts).toLocaleDateString();
        }

        // Pull schedule entries for the next 7 days, group by date, and
        // paint into #summary-agenda. Side-effect-free with respect to
        // the calendar view's own state.
        function renderSummaryAgenda() {
            var host = document.getElementById('summary-agenda');
            if (!host) return;
            if (!window.p86Api || !window.p86Api.schedule || typeof window.p86Api.schedule.list !== 'function') {
                host.innerHTML = '<div style="text-align:center;color:var(--text-dim,#888);font-size:12px;">Schedule not available offline.</div>';
                return;
            }
            var today = new Date();
            today.setHours(0, 0, 0, 0);
            var weekAhead = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
            function ymd(dt) {
                var m = String(dt.getMonth() + 1).padStart(2, '0');
                var d = String(dt.getDate()).padStart(2, '0');
                return dt.getFullYear() + '-' + m + '-' + d;
            }
            window.p86Api.schedule.list({ from: ymd(today), to: ymd(weekAhead) })
                .then(function(res) {
                    var entries = (res && res.entries) || [];
                    if (!entries.length) {
                        host.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim,#888);font-size:12px;">No schedule entries this week.</div>';
                        return;
                    }
                    // Group by start_date.
                    var byDay = {};
                    entries.forEach(function(e) {
                        var k = (e.start_date || e.startDate || '').slice(0, 10);
                        if (!k) return;
                        if (!byDay[k]) byDay[k] = [];
                        byDay[k].push(e);
                    });
                    var html = '<div style="display:flex;flex-direction:column;gap:6px;">';
                    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    // Start at tomorrow (i=1): today lives in the "Today" itinerary
                    // module above, so the week agenda avoids re-listing it.
                    for (var i = 1; i < 7; i++) {
                        var dt = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
                        var k = ymd(dt);
                        var dayEntries = byDay[k] || [];
                        var isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
                        var isToday = i === 0;
                        var headerBg = isToday ? 'rgba(34,211,238,0.10)' : (isWeekend ? 'rgba(255,255,255,0.02)' : 'transparent');
                        html += '<div style="border-bottom:1px solid var(--border,#222);padding:6px 8px;background:' + headerBg + ';border-radius:4px;">' +
                            '<div style="display:flex;align-items:center;justify-content:space-between;font-size:10px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.4px;font-weight:700;margin-bottom:' + (dayEntries.length ? '4' : '0') + 'px;">' +
                                '<span>' + DOW[dt.getDay()] + ' ' + (dt.getMonth() + 1) + '/' + dt.getDate() + (isToday ? ' &middot; Today' : '') + '</span>' +
                                (dayEntries.length ? '<span style="color:var(--accent,#22d3ee);">' + dayEntries.length + '</span>' : '') +
                            '</div>';
                        if (dayEntries.length) {
                            dayEntries.forEach(function(e) {
                                var jobLabel = '';
                                if (e.job_id || e.jobId) {
                                    var jid = e.job_id || e.jobId;
                                    var job = (window.appData && window.appData.jobs || []).find(function(j) { return j.id === jid; });
                                    if (job) jobLabel = window.p86JobLabel.fromJob(job, { fallback: '' });
                                }
                                html += '<div style="font-size:12px;color:var(--text,#fff);padding:3px 0;display:flex;align-items:flex-start;gap:6px;">' +
                                    '<span style="color:var(--accent,#22d3ee);flex-shrink:0;">&#9679;</span>' +
                                    '<div style="min-width:0;">' +
                                        '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(e.title || e.label || 'Item') + '</div>' +
                                        (jobLabel ? '<div style="font-size:10px;color:var(--text-dim,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(jobLabel) + '</div>' : '') +
                                    '</div>' +
                                '</div>';
                            });
                        } else if (!isWeekend) {
                            html += '<div style="font-size:11px;color:var(--text-dim,#666);font-style:italic;">No entries</div>';
                        }
                        html += '</div>';
                    }
                    html += '</div>';
                    host.innerHTML = html;
                })
                .catch(function() {
                    host.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim,#888);font-size:12px;">Could not load schedule.</div>';
                });
        }

        function setPageTitle(pageName) {
            document.title = (pageName && String(pageName).trim())
                ? String(pageName).trim() + ' | Project 86'
                : 'Project 86';
        }
        window.setPageTitle = setPageTitle;

        var TAB_TITLES = {
            summary:    'Summary',
            estimates:  'Estimates',  // gets refined by switchEstimatesSubTab
            schedule:   'Schedule',
            jobs:       'Jobs',
            'my-files': 'Files',
            'field-tools': 'Field Tools',
            'my-tasks': 'Tasks',
            'my-day':   'My Day',
            messages:   'Messages',
            plans:      'Plans & Takeoffs',
            'assembly-studio': 'Assembly Studio',
            insights:   'Insights',
            admin:      'Admin',
            projects:   'Projects',
            'cost-inbox': 'Cost Inbox',
            'invoices': 'Invoices',
            orgmap:     'Job Map',
            orgleadsmap: 'Leads Map',
            jobshub:    'Jobs',
            cowork:     'Cowork',
            console:    'Command Center'
        };

        // Stale-nav threshold. After this long without activity, the
        // saved nav state is treated as expired and the user lands on
        // the Summary tab on next return (login or new browser tab)
        // instead of being dumped back into whatever they were looking
        // at last week. Activity = any switchTab/saveNavState call.
        var STALE_NAV_MS = 60 * 60 * 1000; // 1 hour

        // Job Map drill-in: open a job's node-graph Site Plan in satellite mode.
        // openNodeGraph only RESTORES the (global) view-mode + satellite localStorage
        // keys — it doesn't force them — so after the overlay is sized + its toolbar
        // buttons are wired, we click Site Plan / Satellite ON if not already on (read
        // via the button's .ng-on class, since _spSatellite is module-private). The
        // node graph's own Back button (closeNodeGraph) then reveals this Map tab.
        // Map-as-job-page: open a job from the Job Map the SAME way as the Jobs list — via editJob,
        // so the workspace-layout job subnav mounts in the left sidebar. editJob shows
        // #jobs-job-detail-view (the observer mounts the subnav) then opens the map, which already
        // forces Site Plan + Satellite. (The old open-then-click-the-toggle dance skipped editJob,
        // so the subnav never mounted and the global nav stayed.)
        window.openJobSitePlan = function (jobId) {
            if (!jobId) return;
            if (typeof window.editJob === 'function') { window.editJob(jobId); return; }
            if (typeof window.openNodeGraph === 'function') window.openNodeGraph(jobId);
        };

        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            // Clear accordion parent "contains active page" cues; the
            // virtual-tab pass (if any) recomputes them for the new page.
            document.querySelectorAll('.app-nav-parent.has-active-child').forEach(p => p.classList.remove('has-active-child'));

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

            // Leaving the Jobs tab: tear down any sticky job-detail header
            // (metrics strip + back button) that workspace-layout.js may have
            // injected, so the Insights/Admin/Estimates pages don't show a
            // stale header from a job the user was just viewing.
            if (tabName !== 'jobs') {
                var detail = document.getElementById('jobs-job-detail-view');
                if (detail) detail.style.display = 'none';
                var mainView = document.getElementById('jobs-main-view');
                if (mainView) mainView.style.display = '';
                appState.currentJobId = null;
                if (typeof window.workspaceLayoutCleanup === 'function') {
                    try { window.workspaceLayoutCleanup(); } catch (e) { /* defensive */ }
                }
            }

            // Leaving My Files: tear down the contextual folder rail that
            // my-files.js relocates into #app-sidebar, so other pages don't
            // show a stale Files section in the sidebar.
            if (tabName !== 'my-files') {
                if (typeof window.myFilesSidebarCleanup === 'function') {
                    try { window.myFilesSidebarCleanup(); } catch (e) { /* defensive */ }
                }
            }

            // Leaving the Command Center: clear its host. The console mounts
            // platform System views (Anthropic resources, BT mapping) that
            // create globally-unique element ids (#managed-agents-panel,
            // #tpl-tab-content) ALSO used by the Agents and Organization →
            // Templates admin sub-tabs. The console pane sits earlier in the
            // document, so a lingering console copy would shadow those
            // sub-tabs' getElementById lookups and break their load/save.
            // Clearing on exit guarantees at most one live copy; the console
            // re-renders fresh whenever its tab is reopened.
            if (tabName !== 'console') {
                // Rescue the docked 86 panel (Assembly Studio) back to its
                // drawer home BEFORE wiping the host, or the singleton dies
                // with the console DOM. No-op unless currently docked.
                if (window.p86AI && typeof window.p86AI.undock === 'function' && window.p86AI.isDocked && window.p86AI.isDocked()) {
                    try { window.p86AI.undock(); } catch (e) {}
                }
                var ccHost = document.getElementById('consolePageHost');
                if (ccHost && ccHost.firstChild) ccHost.innerHTML = '';
            }

            // Leaving the Assembly Studio: the build/tune Studio sub-tab docks
            // the singleton 86 panel; pop it back to its drawer before the
            // pane re-renders on re-entry, same rescue as the Command Center.
            if (tabName !== 'assembly-studio') {
                if (window.p86AI && typeof window.p86AI.undock === 'function' && window.p86AI.isDocked && window.p86AI.isDocked()) {
                    try { window.p86AI.undock(); } catch (e) {}
                }
            }

            // Leaving Cowork: same rescue. Deliberately a THIRD independent
            // block rather than a shared "is this a dock host?" predicate —
            // independent blocks compose correctly for N hosts (a non-host
            // destination trips every block, a host destination trips all but
            // its own), while a predicate that skips the undock on
            // host→host would let the console's `ccHost.innerHTML = ''`
            // teardown run with the singleton panel still inside it. That is
            // the exact disaster the comment above the console block exists
            // to prevent.
            if (tabName !== 'cowork') {
                if (window.p86AI && typeof window.p86AI.undock === 'function' && window.p86AI.isDocked && window.p86AI.isDocked()) {
                    try { window.p86AI.undock(); } catch (e) {}
                }
                if (window.p86Cowork && window.p86Cowork.onLeave) {
                    try { window.p86Cowork.onLeave(); } catch (e) {}
                }
            }

            if (tabName === 'summary') {
                renderSummaryDashboard();
            } else if (tabName === 'my-files') {
                if (typeof window.renderMyFilesTab === 'function') window.renderMyFilesTab();
            } else if (tabName === 'field-tools') {
                if (typeof window.renderFieldToolsTab === 'function') window.renderFieldToolsTab();
            } else if (tabName === 'my-tasks') {
                if (typeof window.renderMyTasksTab === 'function') window.renderMyTasksTab();
            } else if (tabName === 'my-day') {
                // My Day merged into the Summary dashboard — send there instead.
                if (typeof window.switchTab === 'function') { window.switchTab('summary'); return; }
            } else if (tabName === 'messages') {
                if (typeof window.renderMessagesTab === 'function') window.renderMessagesTab();
            } else if (tabName === 'email-hub') {
                if (typeof window.renderEmailHubTab === 'function') window.renderEmailHubTab();
            } else if (tabName === 'plans') {
                if (typeof window.renderPlansTab === 'function') window.renderPlansTab();
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
            } else if (tabName === 'projects') {
                // IA-B: Projects is a true top-level page — mount the same
                // list renderer the My Files __projects__ virtual folder used.
                var projHost = document.getElementById('projectsPageHost');
                if (projHost && typeof window.renderProjectsInto === 'function') {
                    window.renderProjectsInto(projHost);
                } else if (projHost) {
                    projHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Projects module not loaded.</div>';
                }
            } else if (tabName === 'cost-inbox') {
                // Cost Inbox — receipt capture + filterable list (js/cost-inbox.js).
                var ciHost = document.getElementById('costInboxHost');
                if (ciHost && window.p86CostInbox && typeof window.p86CostInbox.render === 'function') {
                    window.p86CostInbox.render(ciHost);
                } else if (ciHost) {
                    ciHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Cost Inbox module not loaded.</div>';
                }
            } else if (tabName === 'invoices') {
                // Invoices / AR — list + aging + editor (js/invoices.js).
                var invHost = document.getElementById('invoicesHost');
                if (invHost && window.p86Invoices && typeof window.p86Invoices.render === 'function') {
                    window.p86Invoices.render(invHost);
                } else if (invHost) {
                    invHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Invoices module not loaded.</div>';
                }
            } else if (tabName === 'orgmap') {
                // Job Map (org "Google Earth") — every geocoded JOB on satellite;
                // a pin's Open drills into that job's Site Plan via openJobSitePlan.
                if (window.p86EntitiesMap && typeof window.p86EntitiesMap.render === 'function') {
                    window.p86EntitiesMap.render('orgMapHost', { satellite: true, onJob: window.openJobSitePlan, jobsSidebar: true, warmGeocode: true, only: 'job' });
                }
            } else if (tabName === 'orgleadsmap') {
                // Leads Map — the same "Google Earth" treatment, LEADS only. A pin/row's
                // Open opens the lead (via openEntity → openEditLeadModal). Leads are
                // already geocoded, so no warm-up.
                if (window.p86EntitiesMap && typeof window.p86EntitiesMap.render === 'function') {
                    window.p86EntitiesMap.render('orgLeadsMapHost', { satellite: true, jobsSidebar: true, warmGeocode: false, only: 'lead' });
                }
            } else if (tabName === 'cowork') {
                // Cowork — the Live Writer's home. Docks the singleton 86
                // panel alongside the ledger + the write being read.
                if (window.p86Cowork && typeof window.p86Cowork.render === 'function') {
                    window.p86Cowork.render();
                }
            } else if (tabName === 'console') {
                // Project 86 Command Center — platform-owner surface.
                var consoleHost = document.getElementById('consolePageHost');
                if (consoleHost && typeof window.renderConsoleInto === 'function') {
                    window.renderConsoleInto(consoleHost);
                } else if (consoleHost) {
                    consoleHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Command Center module not loaded.</div>';
                }
            } else if (tabName === 'jobshub') {
                // Jobs Hub — cross-job index pages (Purchase Orders / Change
                // Orders / RFIs / Submittals) reached from the Jobs dropdown.
                var jhHost = document.getElementById('jobshubPageHost');
                if (jhHost && window.p86JobsHub && typeof window.p86JobsHub.renderJobsHubInto === 'function') {
                    window.p86JobsHub.renderJobsHubInto(jhHost);
                } else if (jhHost) {
                    jhHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Jobs hub module not loaded.</div>';
                }
            } else if (tabName === 'assembly-studio') {
                // Assembly Studio — the consolidated cost-assembly home
                // (Assemblies / Studio / Codes / Parametric). Same bootstrap
                // as jobshub: build the pane on open, sub-tabs via sidebar.
                var asHost = document.getElementById('asmStudioPageHost');
                if (asHost && window.p86AsmStudio && typeof window.p86AsmStudio.render === 'function') {
                    window.p86AsmStudio.render(asHost);
                } else if (asHost) {
                    asHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Assembly Studio module not loaded.</div>';
                }
            } else if (tabName === 'schedule') {
                if (typeof window.renderSchedule === 'function') window.renderSchedule();
            } else if (tabName === 'insights') {
                if (typeof renderInsightsDashboard === 'function') renderInsightsDashboard();
            } else if (tabName === 'admin') {
                // Land on the DASHBOARD, not on a sub-tab. Admin used to open
                // on Users, which meant the first thing you saw was one list
                // out of eight destinations with no sense of the rest.
                // switchAdminSubTab handles the render so we don't double-fire.
                // Falls back to the old Users landing if the dashboard module
                // failed to load — never leave the tab blank.
                if (typeof switchAdminSubTab === 'function') {
                    switchAdminSubTab(window.renderAdminDashboard ? 'dashboard' : 'users');
                } else if (typeof renderAdminUsers === 'function') renderAdminUsers();
            } else {
                // Returning to Jobs from another tab: force back to the main job
                // list, even if a job detail was previously open. Without this
                // reset the detail view stays layered on top and steals clicks.
                renderJobsMain();
                var archiveView = document.getElementById('archived-jobs-list');
                if (archiveView) archiveView.style.display = 'none';
                var mainView = document.getElementById('jobs-main-view');
                if (mainView) mainView.style.display = '';
                var detailView = document.getElementById('jobs-job-detail-view');
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
            } else if (top === 'jobs') {
                var dv = document.getElementById('jobs-job-detail-view');
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
                localStorage.setItem('p86-nav-state', JSON.stringify(st));
            } catch (e) { /* localStorage may be unavailable — degrade silently */ }
        }

        function loadNavState() {
            try {
                var raw = localStorage.getItem('p86-nav-state');
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
            // server" alert path. Polls p86DataLoading every 200ms with
            // a hard ceiling so we don't loop forever if the fetch
            // hangs.
            function whenLoaded(cb, attempts) {
                attempts = attempts || 0;
                var stillLoading = (typeof window.p86DataLoading === 'function') && window.p86DataLoading();
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
                        var virtualMap = { leads: 'leads', list: 'estimates', clients: 'clients', subs: 'subs', users: 'users' };
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
                    } else if ((st.top === 'jobs' || st.top === 'wip') && st.jobId && typeof window.editJob === 'function') {
                        window.editJob(st.jobId);
                    }
                } catch (e) { console.warn('[nav] entity restore failed:', e); }
            });

            return true;
        }

        // Public hooks — called from auth.js (restore) and from other
        // navigation paths (job detail, estimate editor open) so the
        // saved state always reflects the latest position.
        window.p86NavSave = saveNavState;
        window.p86NavRestore = restoreNavState;

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
            var detail = document.getElementById('jobs-job-detail-view');
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

        // Six job subtabs had no renderer in switchJobSubTab. renderJobDetail
        // papers over it on FIRST open by also calling several of them
        // directly, but a later switch through switchJobSubTab — the path deep
        // links, the Back button and Jobs-hub row clicks all take — left
        // whatever was painted last. job-wip-report matters most: the
        // captured-costs receipts rollup only re-mounts inside renderWipTab.
        //
        // Names come from workspace-layout.js's TAB_RENDERERS, which is the
        // authoritative map; resolving off window keeps the two in step
        // rather than duplicating the dispatch.
        const _LATE_JOB_SUBTAB_RENDERERS = {
            'job-wip-report':   'renderWipTab',
            'job-changeorders': 'renderChangeOrders',
            'job-qb-costs':     'renderJobQBCosts',
            'job-details':      'renderJobDetails',
            'job-estimates':    'renderJobEstimates',
            'job-reports':      'renderJobReports'
        };
        function switchJobSubTab(subtabName) {
            const currentJobId = appState.currentJobId;

            // "Site Map" is a dedicated tab that OPENS the node-graph overlay
            // (#nodeGraphTab, a position:fixed layer over the full-width panes).
            var ngTab = document.getElementById('nodeGraphTab');
            if (subtabName === 'job-site-map') {
                document.querySelectorAll('.sub-tab-btn-job').forEach(btn => btn.classList.remove('active'));
                document.querySelector(`.sub-tab-btn-job[data-subtab="job-site-map"]`)?.classList.add('active');
                if (typeof window.openNodeGraph === 'function') window.openNodeGraph(currentJobId);
                setTimeout(applyReadOnlyButtonGuard, 0);
                return;
            }
            // Every other section is a FULL-WIDTH pane. If the Site Map overlay
            // is open it covers the panes, so close it first (hub row clicks,
            // /jobs/:id/:sub deep links and popstate all land full-width).
            if (ngTab && ngTab.classList.contains('active')) {
                try { if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph(); } catch (e) {}
                ngTab.classList.remove('active');
            }

            document.querySelectorAll('.sub-tab-content-job').forEach(stc => stc.classList.remove('active'));
            document.querySelectorAll('.sub-tab-btn-job').forEach(btn => btn.classList.remove('active'));

            document.getElementById(subtabName)?.classList.add('active');
            document.querySelector(`[data-subtab="${subtabName}"]`)?.classList.add('active');
            // The section panes live in #wsRightContent (workspace layout), which
            // controls visibility via INLINE display — that overrides the .active
            // class above. Reconcile it here so the activated pane actually shows
            // (mirrors workspace-layout activateTab's hide-all / show-target).
            var _rc = document.getElementById('wsRightContent');
            if (_rc) {
                Array.prototype.forEach.call(_rc.children, function (p) {
                    if (!(p.classList && p.classList.contains('ws-job-info-details'))) p.style.display = 'none';
                });
                var _tgt = document.getElementById(subtabName);
                if (_tgt) _tgt.style.display = 'block';
            }
            if (subtabName === 'job-overview') renderJobOverview(currentJobId);
            else if (subtabName === 'job-buildings') renderJobBuildings(currentJobId);
            else if (subtabName === 'job-phases') renderJobPhases(currentJobId);
            else if (subtabName === 'job-subs') renderJobSubs(currentJobId);
            else if (subtabName === 'job-purchaseorders') renderPurchaseOrders(currentJobId);
            else if (subtabName === 'job-invoices') renderInvoices(currentJobId);
            else if (subtabName === 'job-payapps' && typeof renderPayApps === 'function') renderPayApps(currentJobId);
            else if (subtabName === 'job-labor') renderJobLabor(currentJobId);
            // Wave 3 — RFI / submittal / transmittal pane.
            else if (subtabName === 'job-workflow' && window.p86JobWorkflowUI) {
                window.p86JobWorkflowUI.mount(currentJobId);
            }
            else {
                var _late = _LATE_JOB_SUBTAB_RENDERERS[subtabName];
                if (_late && typeof window[_late] === 'function') {
                    try { window[_late](currentJobId); }
                    catch (e) { console.warn('[job subtab] ' + _late + ' failed:', e && e.message); }
                }
            }

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
        //   await p86Confirm({
        //     title: 'Delete this line?',
        //     message: 'This cannot be undone.',
        //     confirmText: 'Delete',
        //     destructive: true
        //   });
        // ──────────────────────────────────────────────────────────────
        window.p86Confirm = function(opts) {
            opts = opts || {};
            var title = opts.title || 'Are you sure?';
            var message = opts.message || '';
            var confirmText = opts.confirmText || 'Confirm';
            var cancelText = opts.cancelText || 'Cancel';
            var destructive = !!opts.destructive;

            return new Promise(function(resolve) {
                var overlay = document.createElement('div');
                overlay.className = 'p86-confirm-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px);';

                var box = document.createElement('div');
                box.style.cssText = 'background:var(--card-bg,#141419);border:1px solid var(--border,#333);border-radius:12px;padding:24px 26px;max-width:420px;width:100%;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
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
            appData.jobs = safeLoadJSON('p86-jobs-jobs', []);
            appData.buildings = safeLoadJSON('p86-jobs-buildings', []);
            appData.phases = safeLoadJSON('p86-jobs-phases', []);
            appData.subs = safeLoadJSON('p86-jobs-subs', []);
            appData.changeOrders = safeLoadJSON('p86-jobs-changeorders', []);
            appData.purchaseOrders = safeLoadJSON('p86-jobs-purchaseorders', []);
            // The REAL per-job PO store (server-backed job_purchase_orders). Cached
            // so ACCRUED cost paints its true value on the first synchronous render
            // after a hard reload — before the boot PO fetch resolves — no $0 flash.
            appData.jobPurchaseOrders = safeLoadJSON('p86-jobs-jobpurchaseorders', []);
            // The REAL per-job CO store (server-backed job_change_orders). Cached
            // like POs so approved/applied CO income folds into Total Income + the
            // metrics on the first synchronous render after a hard reload, before
            // the boot CO fetch resolves — no "contract only" flash.
            appData.jobChangeOrders = safeLoadJSON('p86-jobs-jobchangeorders', []);
            appData.invoices = safeLoadJSON('p86-jobs-invoices', []);
            appData.estimates = safeLoadJSON('p86-estimates', []);
            appData.estimateLines = safeLoadJSON('p86-estimate-lines', []);
            // estimateAlternates is no longer a flat top-level array — alternates
            // live INLINE on each estimate (est.alternates) since the full-page
            // editor reads/writes them there directly. Keeping a parallel flat
            // copy was creating dual-source-of-truth corruption on offline
            // edits. Initialize empty so any old code that reads it sees [],
            // never undefined.
            appData.estimateAlternates = [];
        }

        // localStorage here is a CACHE — the server is the source of truth. A
        // failed write must therefore never propagate: these bare setItem calls
        // used to throw QuotaExceededError straight up through saveData() into
        // renderJobDetail(), which aborted mid-render and left jobs unable to
        // open at all. Losing the offline cache is a nuisance; losing the app
        // is not acceptable.
        //
        // Deliberately does NOT evict anything to make room. The obvious
        // candidate (p86-workspaces, by far the largest key) is the ONLY copy
        // of the user's workbooks — there is no workspace CRUD API — so
        // "freeing space" there would destroy real data.
        var _cacheWarned = false;
        function putCache(key, value) {
            try {
                localStorage.setItem(key, value);
                return true;
            } catch (e) {
                // Surface it, don't just warn. A full store means the edit has
                // no server copy AND no durable local copy — the one state
                // where "keep this tab open" is not enough advice. The banner
                // reads this flag.
                try { appData._cacheWriteFailed = true; } catch (e2) {}
                if (!_cacheWarned) {
                    _cacheWarned = true;
                    console.warn('[p86] Local cache write failed (' + key + '): ' + ((e && e.name) || e) +
                        '. Browser storage is full — the app keeps working from the server, ' +
                        'but the offline cache is now stale.');
                }
                return false;
            }
        }

        function writeToLocalStorage() {
            putCache('p86-jobs-jobs', JSON.stringify(appData.jobs));
            putCache('p86-jobs-buildings', JSON.stringify(appData.buildings));
            putCache('p86-jobs-phases', JSON.stringify(appData.phases));
            putCache('p86-jobs-subs', JSON.stringify(appData.subs));
            putCache('p86-jobs-changeorders', JSON.stringify(appData.changeOrders));
            putCache('p86-jobs-purchaseorders', JSON.stringify(appData.purchaseOrders));
            putCache('p86-jobs-jobpurchaseorders', JSON.stringify(appData.jobPurchaseOrders || []));
            putCache('p86-jobs-jobchangeorders', JSON.stringify(appData.jobChangeOrders || []));
            putCache('p86-jobs-invoices', JSON.stringify(appData.invoices));
            putCache('p86-estimates', JSON.stringify(appData.estimates));
            putCache('p86-estimate-lines', JSON.stringify(appData.estimateLines));
            // estimateAlternates flat array dropped — see loadFromLocalStorage.
            // Clean up the legacy key so stale data can't reappear after a
            // future schema change.
            try { localStorage.removeItem('p86-estimate-alternates'); } catch (e) {}
        }

        // Reconstruct flat appData arrays from server response. The server stores
        // each job's nested entities (buildings/phases/subs/etc.) inside its JSONB
        // blob; this fans them back out into the top-level arrays the UI expects.
        function hydrateFromServerJobs(serverJobs) {
            appData.jobs = [];
            appData.buildings = [];
            appData.phases = [];
            appData.changeOrders = [];
            // Phase 4 — server-side job_change_orders rows live here.
            // Loaded lazily on job-detail open via loadChangeOrdersForJob(jobId).
            // Indexed by job_id; the legacy appData.changeOrders array is
            // kept for backwards-compat with the old localStorage scalars
            // until the migration phase runs.
            appData.jobChangeOrders = appData.jobChangeOrders || [];
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
        // Distinct from _serverLoadComplete: TRUE only after a GET that actually
        // succeeded. Complete-but-not-ok means we are running on the localStorage
        // cache, which must never be pushed back as authoritative.
        var _serverLoadOk = false;
        // Per-job signature of what we last LOADED or successfully PUSHED, so a
        // save can ship only the jobs this client actually changed instead of
        // rewriting every job from its cache. See the dirty filter in
        // pushToServer for why that mattered.
        var _jobBaseline = {};
        // Per-ESTIMATE baseline, the same shape as _jobBaseline. This used to
        // be one portfolio-wide signature, which meant a single line edit on a
        // single estimate marked every estimate dirty and shipped the WHOLE
        // portfolio to an endpoint that has no version guard at all — a plain
        // last-writer-wins upsert. That is the widest silent-clobber surface in
        // the save path (it can overwrite an agent's write, and re-create an
        // estimate another session deleted), and scoping the push to the rows
        // this client actually touched is what closes it.
        var _estimateBaseline = {};
        // Where the current baselines came from: null (none yet), 'cache' (read
        // off localStorage at boot, before/without a good GET) or 'server'.
        // Provenance matters because a cache baseline is what lets a session
        // whose boot GET failed still name exactly which rows the user changed
        // — and still push them with a real base version, because the cache was
        // itself written from a previous successful load and carries _updatedAt.
        var _baselineSource = null;
        // Per-job server version (updated_at ISO) this client last loaded or
        // pushed — the BASE for optimistic concurrency. Sent with each save; the
        // server rejects (conflicts) any job whose row is newer, so a second
        // user's concurrent edit is never silently overwritten.
        var _jobVersion = {};
        // ── which job ids the SERVER last said it has ────────────────────────
        // Recorded off every GET that resolved, INCLUDING one the hold refused
        // to apply — existence is server truth even when the row's contents are
        // not ours to take. It exists to answer one question at push time that
        // nothing else can: "does this row already exist over there?"
        //
        // That question is what stops the version guard from being opt-in. The
        // guard only ever fired `if (base)`, and the only thing supplying a base
        // was `if (j._updatedAt)`, so a copy that had lost its _updatedAt went
        // out with baseVersions {} and force-overwrote whatever was there. But
        // "no version" cannot simply mean "refuse", because a job this client
        // just CREATED has no version either and must be allowed to insert.
        //
        // The server's own list separates the two with no guessing:
        //   in the list, no version  → it exists and we cannot prove we are
        //                              current → send UNVERSIONED_BASE, which
        //                              the server cannot match, so it conflicts
        //   not in the list          → it does not exist over there → a create
        // A push is only ever possible after a GET has resolved, so this map is
        // always populated by the time it is read.
        //
        // The one case it cannot resolve: a row deleted on the server whose
        // local copy never carried an _updatedAt at all. It reads as a create.
        // That needs a cache written before _updatedAt was ever handed to the
        // client, and it self-heals on the first good load; the alternative —
        // refusing every unversioned row — would destroy genuinely new jobs,
        // which is the bug this whole path exists to stop, pointed the other way.
        var _serverJobIds = {};
        // The estimate half of both maps. Estimates now have a real server-side
        // version guard (PUT /api/estimates/bulk/save), so they get the same
        // referee jobs have had: a base per row, a conflict when it does not
        // match, and no INSERT for a row the client expected to find.
        var _estimateVersion = {};
        var _serverEstimateIds = {};
        // The sentinel. Deliberately not a timestamp and deliberately not
        // absent: absent means "create", a non-comparable value means "this
        // must already exist and I cannot prove I am current". The server
        // refuses it, which is the point — including an OLD server mid-swap,
        // which compares it against an ISO string and conflicts anyway.
        var UNVERSIONED_BASE = 'unversioned';
        // Drop server-injected/per-save hints so they can't register as changes.
        function _stripPrivate(o) {
            if (!o || typeof o !== 'object') return o;
            var out = {};
            Object.keys(o).forEach(function(k) { if (k.charAt(0) !== '_') out[k] = o[k]; });
            return out;
        }
        function jobSliceSig(jobId) {
            var j = (appData.jobs || []).find(function(x) { return x.id === jobId; });
            if (!j) return '';
            var pick = function(arr) {
                return (arr || []).filter(function(r) { return r && r.jobId === jobId; });
            };
            try {
                return JSON.stringify([
                    _stripPrivate(j), pick(appData.buildings), pick(appData.phases),
                    pick(appData.changeOrders), pick(appData.subs),
                    pick(appData.purchaseOrders), pick(appData.invoices)
                ]);
            } catch (e) {
                // Never let a serialize failure mark a job CLEAN and skip its save.
                return 'unserializable:' + Date.now() + ':' + Math.random();
            }
        }
        function estimateSliceSig(estId) {
            var e = (appData.estimates || []).find(function(x) { return x.id === estId; });
            if (!e) return '';
            try {
                return JSON.stringify([
                    _stripPrivate(e),
                    (appData.estimateLines || []).filter(function(l) { return l.estimateId === estId; })
                ]);
            } catch (err) {
                // Same rule as jobSliceSig: a serialize failure must never mark a
                // row CLEAN and skip its save.
                return 'unserializable:' + Date.now() + ':' + Math.random();
            }
        }
        // ── the dirty set ───────────────────────────────────────────────────
        // ONE definition of "this client is holding a change the server does not
        // have", derived from state rather than accumulated by call sites.
        //
        // Everything downstream keys on this: what gets pushed, whether a
        // hydrate is held, what the banner counts, and what "Show what's
        // unsaved" lists. The alternative — a counter incremented wherever a
        // save was refused — cannot work here, because saveData() is also
        // called on VIEW (renderJobDetail writes derived pctComplete +
        // recalcSubCosts; migrateBudgetFields fires during the boot window with
        // no auth guard). Such a counter is pinned high by merely opening a job
        // and never comes down. A recomputed set is immune: a derived write
        // that lands on the same values is not dirty, and a successful push
        // clears the set by construction.
        //
        // "Lands on the same values" is load-bearing, and it was not free: an
        // unconditional `p.sub = 0` onto a phase that had no `sub` key at all
        // is DIFFERENT JSON, so the recompute dirtied the job. js/jobs.js now
        // assigns the derived values only when they actually change, which is
        // what makes the sentence above true rather than merely intended.
        function dirtyJobIds() {
            return (appData.jobs || [])
                .filter(function(j) { return j && j._canEdit !== false; })
                .filter(function(j) { return _jobBaseline[j.id] !== jobSliceSig(j.id); })
                .map(function(j) { return j.id; });
        }
        function dirtyEstimateIds() {
            return (appData.estimates || [])
                .filter(function(e) { return e && _estimateBaseline[e.id] !== estimateSliceSig(e.id); })
                .map(function(e) { return e.id; });
        }
        function _estimatesDirty() { return dirtyEstimateIds().length > 0; }
        function rebuildBaselines() {
            _jobBaseline = {};
            (appData.jobs || []).forEach(function(j) {
                _jobBaseline[j.id] = jobSliceSig(j.id);
                // Capture the server version the moment we're in sync with it.
                if (j._updatedAt) _jobVersion[j.id] = j._updatedAt;
            });
            _estimateBaseline = {};
            (appData.estimates || []).forEach(function(e) {
                _estimateBaseline[e.id] = estimateSliceSig(e.id);
                if (e.updated_at) _estimateVersion[e.id] = e.updated_at;
            });
            _baselineSource = 'server';
        }
        // Baseline the localStorage cache as it stood at BOOT, once, before any
        // server answer. Two things depend on this and neither works without it:
        //
        //  - A session whose boot GET failed has no server baseline, so under
        //    the old code EVERY job read dirty. The dirty set would then name
        //    the whole portfolio instead of the one row the user edited, and
        //    anything keyed on it (the hydrate hold, the banner count) would be
        //    both useless and alarming.
        //  - The cache was written by a PREVIOUS successful load, so its job
        //    objects still carry `_updatedAt`. Capturing those gives the failed
        //    boot real base versions — which is what lets its edits be pushed
        //    later with the server's FOR UPDATE + baseVersions check as referee
        //    instead of as an unguarded bulk replace.
        //
        // ONCE, deliberately. loadFromLocalStorage() runs at the top of EVERY
        // load and re-seeds appData from a cache that saveData keeps in step
        // with memory — so re-baselining here on a later load would compare
        // memory against itself, report CLEAN, and erase the very signal the
        // hold depends on.
        function captureCacheBaselines() {
            if (_baselineSource !== null) return;
            (appData.jobs || []).forEach(function(j) {
                _jobBaseline[j.id] = jobSliceSig(j.id);
                if (j._updatedAt) _jobVersion[j.id] = j._updatedAt;
            });
            (appData.estimates || []).forEach(function(e) {
                _estimateBaseline[e.id] = estimateSliceSig(e.id);
                // Same reason as the job side: the cache was written by a
                // previous SUCCESSFUL load, so its rows still carry the
                // server's updated_at — which is what gives a failed boot a
                // real base instead of a forced write.
                if (e.updated_at) _estimateVersion[e.id] = e.updated_at;
            });
            _baselineSource = 'cache';
        }
        window.p86DataReady = function() { return _serverLoadComplete; };
        // p86DataLoading gates three editor-entry points and the refresh
        // registry's never-concurrent-hydrate rule. js/api.js has no timeout and
        // no AbortController, so a hung fetch leaves _serverLoadInFlight true
        // forever — and a permanently-true flag turns those gates into a
        // permanent lockout ("Still loading from server — try again in a
        // moment", indefinitely). Treat a load that has been in flight past the
        // ceiling as not-in-flight; js/refresh.js already carries the same
        // escape hatch (HYDRATE_MAX_WAIT) for the same flag.
        var _loadStartedAt = 0;
        var LOAD_WEDGE_MS = 60000;
        window.p86DataLoading = function() {
            if (!_serverLoadInFlight) return false;
            if (_loadStartedAt && (Date.now() - _loadStartedAt) > LOAD_WEDGE_MS) return false;
            return true;
        };

        // loadData is called once at startup. We paint the localStorage
        // cache immediately so first paint is instant, then fetch fresh
        // data from the server. The data-loss risk during the in-flight
        // window (user opens editor with stale data → server fetch
        // overwrites their unsaved edits) is now closed by gating
        // editor opens on p86DataReady() — see openNewEstimateForm /
        // editEstimate / etc.
        // One post-hydrate renderer, isolated. A throw in any single surface
        // must never take the rest of the fan-out down with it.
        function fanOut(name, run) {
            if (typeof run !== 'function') return;
            try { run(); }
            catch (e) { console.warn('[hydrate fan-out] ' + name + ' failed:', e && e.message); }
        }

        // How many hydrates in a row we have held because this client was
        // holding an unpushed change. Drives the banner's escalation only —
        // never the decision, and never a timer.
        var _consecutiveHolds = 0;
        var _holdRetryArmed = false;

        function loadData(opts) {
            opts = opts || {};
            var authed = window.p86Api && window.p86Api.isAuthenticated();
            if (!authed) {
                loadFromLocalStorage(); // fast first paint
                captureCacheBaselines();
                _serverLoadComplete = true;
                _serverLoadOk = true;   // local-only mode: no server state to clobber
                return Promise.resolve();
            }
            // ── flush BEFORE hydrating ───────────────────────────────────────
            // The in-flight class in one line: an edit made while a GET is on
            // the wire used to be blocked by saveData's guard, never scheduled,
            // and then destroyed by the hydrate. Pushing first turns that
            // sequence into push-then-hydrate.
            //
            // JOBS ONLY, and that restriction is not an oversight. This runs
            // immediately before every hydrate — including the hydrate that
            // follows an agent write, i.e. at the exact moment we have positive
            // evidence the server just changed. Jobs have a referee for that:
            // PUT /api/jobs/bulk/save re-reads each row FOR UPDATE and rejects
            // a stale base. Estimates have none — their bulk save is a plain
            // upsert with no version check — so force-pushing estimates here
            // would deterministically overwrite the newer server copy we are
            // about to read. Dirty estimates are carried by the hold below
            // instead, and go out on the normal (now row-scoped) push.
            //
            // _serverLoadInFlight is set BEFORE the await, not after. It is the
            // only signal p86DataLoading() has, and js/refresh.js's
            // never-concurrent-hydrate rule plus the three editor-entry gates
            // all read it. Leaving it false across a network round trip would
            // reopen both windows this whole change exists to close.
            var preflush = Promise.resolve();
            var canPreflush = !opts.fromConflict && _serverLoadOk && !_serverLoadInFlight;
            if (canPreflush && dirtyJobIds().length) {
                _serverLoadInFlight = true;
                _loadStartedAt = Date.now();
                if (_serverPushTimer) { clearTimeout(_serverPushTimer); _serverPushTimer = null; }
                preflush = pushToServer({ jobsOnly: true }).catch(function() {});
            }
            return preflush.then(function() { return _loadDataFromServer(opts); });
        }

        var _everSeeded = false;
        function _loadDataFromServer(opts) {
            // Seed from the cache ONLY on the very first load of the session.
            //
            // This line used to run on every load, and on a reload it is a pure
            // liability: it replaces live memory — which by then includes edits
            // the user has made and any hold this client is carrying — with the
            // cache, and swaps every object identity while it does so. That is
            // the mechanism behind both the boot-push clobber (a stale cache
            // re-seeded and then pushed back over newer server rows) and the
            // orphaned-reference class js/refresh.js documents. Its one real
            // job is a fast first paint before the boot GET returns; after that
            // memory is strictly better than the cache.
            if (!_everSeeded) { _everSeeded = true; loadFromLocalStorage(); }
            captureCacheBaselines();
            _serverLoadInFlight = true;
            _loadStartedAt = Date.now();
            return Promise.all([
                window.p86Api.jobs.list(),
                window.p86Api.estimates.list(),
                // QB cost lines now persist server-side. Read all of
                // them at boot so Job Costs / Audit / 86 (WIP analyst)
                // can reason about them without per-tab fetches.
                window.p86Api.qbCosts.list().catch(function() { return { lines: [] }; }),
                // Subs directory (Phase A) — global sub records.
                window.p86Api.subs.list().catch(function() { return { subs: [], trades: [] }; }),
                // All POs at boot so ACCRUED (committed) cost is a live metric on
                // the jobs list + job tiles without waiting for a per-job fetch —
                // and so the accrued tile paints its real value on first render
                // (no $0 flash). getJobPOAccrued reads appData.jobPurchaseOrders.
                window.p86Api.purchaseOrders.listAll().catch(function() { return { purchase_orders: [] }; }),
                // All change orders at boot so approved/applied CO income adds to
                // Total Income (contract + CO) on the jobs list + job tiles without
                // waiting for a per-job fetch — no "contract only" flash. Rows carry
                // data.lines, so getJobCOTotals can price each from its line items.
                window.p86Api.changeOrders.listAll().catch(function() { return { change_orders: [] }; }),
                // All vendor bills at boot so the PO %-billed / outstanding and
                // ACCRUED (earned − billed) net out live on the jobs list + tiles
                // without a per-job fetch. poRowBilled reads appData.jobVendorBills
                // once appData._billsAllLoaded is set (Bills S3).
                window.p86Api.bills.listAll({ status: 'all', limit: 50000 }).catch(function() { return { bills: [], _failed: true }; }),
                // All AR (customer) invoices at boot so getJobWIP computes the real
                // "Invoiced / Unbilled" figures per job (billed statuses = sent/
                // partial/paid/overdue) instead of the stale job.invoicedToDate scalar.
                window.p86Api.invoices.list().catch(function() { return { invoices: [] }; })
            ]).then(function(results) {
                appData.qbCostLines = (results[2] && results[2].lines) || [];
                appData.subsDirectory = (results[3] && results[3].subs) || [];
                appData.knownTrades = (results[3] && results[3].trades) || [];
                appData.jobPurchaseOrders = (results[4] && results[4].purchase_orders) || [];
                appData.jobChangeOrders = (results[5] && results[5].change_orders) || [];
                appData.arInvoices = (results[7] && results[7].invoices) || [];
                // Hydrate the org-wide bills snapshot into the cost-rollup store.
                // Trust it globally only if the fetch SUCCEEDED and was NOT
                // truncated by the server row cap (50000). On failure/truncation
                // keep per-job loads authoritative — poRowBilled then falls back
                // to each PO's embedded (migrated) bills rather than zeroing
                // billed and over-stating ACCRUED (accrued = earned − billed).
                var _billsRes = results[6] || {};
                var _billsList = (_billsRes && _billsRes.bills) || [];
                var _billsOk = !_billsRes._failed && _billsList.length < 50000;
                if (typeof window.hydrateBillsStore === 'function') {
                    window.hydrateBillsStore(_billsList, _billsOk);
                } else {
                    appData.jobVendorBills = _billsList;
                    appData._billsAllLoaded = _billsOk;
                }
                _serverLoadComplete = true;
                _serverLoadInFlight = false;
                // A real GET landed. Set this UNCONDITIONALLY, and before the
                // hold decision below — it is the flag that authorises a push,
                // and the first draft of the hold left it inside the block it
                // skipped. That version could never become pushable again: the
                // recovery load would land, hold, and leave pushes disabled, so
                // the retry loop "succeeded" forever while nothing reached
                // Postgres and the only exit was to discard the work.
                _serverLoadOk = true;
                _pushRetryCount = 0;    // a reachable server re-arms the push ladder
                // Existence, and ONLY existence, from this response. Recorded
                // before the hold decision so the held branch's own push can
                // use it.
                //
                // It must NOT also adopt these rows' _updatedAt as our base.
                // The base has to describe the version OUR copy came from; a
                // base copied out of a response we just refused to apply would
                // claim we are current when we are exactly not, and would turn
                // the guard into a rubber stamp on the newer row.
                _serverJobIds = {};
                (results[0].jobs || []).forEach(function(j) { if (j && j.id) _serverJobIds[j.id] = true; });
                _serverEstimateIds = {};
                (results[1].estimates || []).forEach(function(e) { if (e && e.id) _serverEstimateIds[e.id] = true; });

                // ── the hold ────────────────────────────────────────────────
                // Everything above this line is direct-REST state (QB costs,
                // subs, POs, COs, AR invoices, bills). Those stores are NOT on
                // the appData+saveData path, are never dirty on this client, and
                // are what the money tiles read — holding them back would put
                // wrong money on screen with nothing to explain it. So they
                // hydrate either way, and only the four job/estimate lines
                // below are subject to the hold.
                var _held = window.p86SaveMerge.shouldVetoHydrate({
                    dirtyJobIds: dirtyJobIds(),
                    dirtyEstimateIds: dirtyEstimateIds(),
                    fromConflict: !!(opts && opts.fromConflict),
                    consecutiveVetoes: _consecutiveHolds
                });
                if (_held.veto) {
                    _consecutiveHolds++;
                    // Mirror the held memory into the cache. The cache is a
                    // mirror of memory for these two stores, and after a hold
                    // it is the only durable copy of the change — a tab closed
                    // here has to be able to come back to it. It is safe in a
                    // way the hydrate is not: this writes THIS CLIENT'S intent,
                    // not server truth, and it leaves the baselines (the
                    // evidence of what is dirty) completely untouched.
                    writeToLocalStorage();
                    notifyPushStatus('blocked', {
                        reason: 'unpushed-changes', escalate: _held.escalate,
                        jobs: _held.jobs, estimates: _held.estimates
                    });
                    // Push DIRECTLY. Re-firing p86Refresh('job') from here would
                    // resolve to p86ReloadAllData → loadData: a reload loop, not
                    // a handoff, and one that re-seeds appData from localStorage
                    // on every turn. One push, then at most ONE follow-up load,
                    // and only once the push has actually cleared the dirty set.
                    if (!_activePush && !_holdRetryArmed) {
                        _holdRetryArmed = true;
                        pushToServer().then(function() {
                            _holdRetryArmed = false;
                            if (!dirtyJobIds().length && !dirtyEstimateIds().length) {
                                loadData({ fromHold: true });
                            }
                        }).catch(function() { _holdRetryArmed = false; });
                    }
                    fanOutRenderers();
                    return;
                }
                _consecutiveHolds = 0;
                hydrateFromServerJobs(results[0].jobs);
                hydrateFromServerEstimates(results[1].estimates);
                writeToLocalStorage();
                rebuildBaselines();     // this IS the server's state — nothing is dirty yet
                notifyPushStatus('idle');
                fanOutRenderers();
            }).catch(function(err) {
                _serverLoadInFlight = false;
                _serverLoadComplete = true; // mark complete so UI doesn't hang waiting
                // ...but do NOT set _serverLoadOk. "Complete" only unblocks
                // rendering; it must never authorize a push. When the boot GET
                // fails (a 502 mid-deploy, a network blip) memory is the stale
                // localStorage cache, and pushing it as a full bulk replace
                // overwrites whatever is actually on the server. That is exactly
                // how a corrected Fairways scope split got reverted during a
                // deploy window.
                console.warn('Server load failed, staying on localStorage cache (pushes disabled until a good load):', err.message);
                // 'load-failed', NOT 'failed'. They are different events with
                // different truths: a failed GET has saved nothing and lost
                // nothing, while 'failed' means a PUSH was refused after its
                // retries. Emitting one for the other is why the estimate
                // editor showed "Save failed — will retry on next edit" at boot,
                // before the user had typed a character.
                notifyPushStatus('load-failed', err);
                armLoadRecovery();
            });

            function fanOutRenderers() {
                // Re-render whatever's visible. Each renderer no-ops if
                // its DOM target isn't present, so calling them all is
                // safe regardless of which tab the user is on.
                // Each is isolated: this is an unguarded SEQUENCE otherwise, so
                // one renderer throwing on a missing element would silently
                // skip every renderer after it — including the two post-write
                // editor refreshes at the end, which would then latch forever
                // with no user-visible signal.
                fanOut('renderJobsMain',          function() { renderJobsMain(); });
                fanOut('renderEstimatesList',     function() { renderEstimatesList(); });
                fanOut('renderInsightsDashboard', function() { renderInsightsDashboard(); });
                fanOut('renderAdminMetrics',      function() { renderAdminMetrics(); });
                fanOut('renderAdminJobs',         function() { renderAdminJobs(); });
                // The OPEN job page. p86ReloadAllData's fan-out was list views
                // only, so an agent write to the job on screen left its money
                // tiles (Total Income, ACCRUED, header strip, WIP) reading the
                // pre-write numbers indefinitely. Like the estimate editor it
                // is latch-driven — it no-ops unless a write is actually
                // pending — and it must run HERE, post-hydrate, so it paints
                // the objects this load just installed instead of racing them.
                if (typeof window.p86JobDetailRefresh === 'function') {
                    fanOut('p86JobDetailRefresh', function() { window.p86JobDetailRefresh(); });
                }
                // The open estimate editor is NOT in this list by accident —
                // it re-renders only when an agent write is pending, and it
                // must run here (post-hydrate) rather than off the
                // p86:payload-applied event, so it repaints against the
                // objects this load just installed instead of racing them.
                if (typeof window.p86EstimateEditorRefresh === 'function') {
                    fanOut('p86EstimateEditorRefresh', function() { window.p86EstimateEditorRefresh(); });
                }
            }
        }

        // saveData writes to localStorage immediately (cheap, synchronous) so the
        // existing call sites stay correct, and schedules a debounced push to the
        // server when authenticated. Offline mode is localStorage-only.
        //
        // Push pipeline: each saveData() coalesces into a single in-flight push.
        // On failure we retry with exponential backoff (1s, 2s, 4s) up to 3
        // attempts, then surface the failure via the p86PushStatus listener so
        // the estimate editor (and anything else interested) can show an
        // "unsaved — retrying" badge instead of a silent dropped commit.
        var _serverPushTimer = null;
        var _activePush = null;          // Promise of the in-flight push
        var _pushRetryCount = 0;
        // Push retry ladder, in ms. Sized to outlast a Railway deploy swap
        // (~2-3 min) rather than the ~7 seconds the old 1s/2s/4s ladder covered.
        var PUSH_BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000, 45000];
        var _pushStatusListeners = [];
        function notifyPushStatus(status, err) {
            _pushStatusListeners.forEach(function(fn) {
                try { fn(status, err); } catch (e) { /* defensive */ }
            });
        }
        window.p86PushStatus = {
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
            if (!window.p86Api || !window.p86Api.isAuthenticated()) return;
            // NEVER push before the server load has landed. Boot seeds appData
            // from localStorage for a fast first paint, so until the GET returns,
            // memory is a CACHE — not user intent. Pushing in that window sends a
            // stale snapshot as a full bulk replace and silently overwrites newer
            // server data: a hand-entered Gutters budget on Fairways was reverted
            // to an even split repeatedly by exactly this, because a boot pushed
            // localStorage's old copy back over it. The server is the source of
            // truth; localStorage is only a paint accelerator.
            if (!_serverLoadOk || _serverLoadInFlight) {
                // NOT a silent return any more. This branch is where every
                // dropped write went: no push scheduled, no retry armed, no
                // signal, and then the next hydrate overwrote both memory AND
                // the localStorage cache that was the edit's last copy.
                //
                // Nothing is queued here on purpose. The edit is already in
                // appData and in the cache; what the rest of the machinery
                // guarantees is that a hydrate cannot destroy it (the hold in
                // loadData) and that the server becomes reachable again (the
                // recovery loop below). A queue of row snapshots would be a
                // second source of truth and, replayed naively, the documented
                // way to resurrect a row somebody deleted.
                var _reason = _serverLoadOk ? 'hydrate-in-flight' : 'no-good-load';
                if (!_blockedSince) _blockedSince = Date.now();
                notifyPushStatus('blocked', {
                    reason: _reason,
                    jobs: dirtyJobIds(), estimates: dirtyEstimateIds(),
                    heldMs: Date.now() - _blockedSince
                });
                // ...and then 'retrying', which is true in BOTH blocked states
                // (a load-recovery probe is armed, or the post-hydrate push is).
                // The estimate editor's indicator predates 'blocked' and ignores
                // statuses it does not know, which is how a save that was never
                // scheduled left it reading "Saving…" indefinitely. This makes
                // that surface honest without this change having to edit a file
                // another workstream is currently holding.
                notifyPushStatus('retrying', { reason: _reason });
                if (!_serverLoadOk) armLoadRecovery();
                return;
            }
            _blockedSince = 0;
            // New user intent re-arms the push ladder. _pushRetryCount was only
            // ever reset in the success branch, so after one terminal failure
            // every later push in the session — including one the user asks for
            // by hand — got zero retries and failed instantly.
            _pushRetryCount = 0;
            if (_serverPushTimer) clearTimeout(_serverPushTimer);
            _serverPushTimer = setTimeout(function() { pushToServer(); }, 600);
        }
        var _blockedSince = 0;

        /* ── the recovery loop ───────────────────────────────────────────────
         * There was none. pushToServer backs off and retries; loadData's catch
         * cleared its flags, logged a warning, and stopped forever — so a 502
         * during a ~2-3 minute Railway swap disabled every job and estimate
         * push for the REST OF THE SESSION, and the only signal was a
         * console.warn.
         *
         * It probes /api/health rather than speculatively re-running loadData,
         * because loadData's first act is loadFromLocalStorage(), which
         * re-seeds appData and swaps every object identity — a background
         * reload every few seconds would repeatedly orphan an open editor's
         * captured references. Health is cheap and runs none of that.
         *
         * Bounded by STATE, not by an attempt cap: it stops when a load
         * succeeds. What is capped is the noise — the banner escalates its
         * wording, the timer does not escalate its rate. Paused while the tab
         * is hidden, and fired immediately on `online` and on regaining
         * visibility, because a closed laptop needs the focus trigger and a
         * deploy window needs the timer. */
        var _recoveryTimer = null, _recoveryAttempt = 0, _recoveryInFlight = false;
        var RECOVERY_BACKOFF = [2000, 5000, 10000, 20000, 30000];
        function armLoadRecovery() {
            if (_serverLoadOk || _recoveryTimer) return;
            var wait = RECOVERY_BACKOFF[Math.min(_recoveryAttempt, RECOVERY_BACKOFF.length - 1)];
            _recoveryTimer = setTimeout(function() {
                _recoveryTimer = null;
                runLoadRecovery();
            }, wait);
        }
        function runLoadRecovery() {
            if (_serverLoadOk) return;
            if (_recoveryInFlight || _serverLoadInFlight) { armLoadRecovery(); return; }
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                // Paused, not abandoned: the visibilitychange listener re-arms.
                return;
            }
            if (!window.p86Api || !window.p86Api.isAuthenticated()) return;
            _recoveryInFlight = true;
            _recoveryAttempt++;
            notifyPushStatus('blocked', {
                reason: 'no-good-load', retryAttempt: _recoveryAttempt,
                jobs: dirtyJobIds(), estimates: dirtyEstimateIds(),
                heldMs: _blockedSince ? (Date.now() - _blockedSince) : 0
            });
            fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' })
                .then(function(r) { if (!r.ok) throw new Error('health ' + r.status); })
                .then(function() {
                    _recoveryInFlight = false;
                    // The server answered. Route the real load through the
                    // refresh registry when it is present so it serialises
                    // behind js/refresh.js's never-concurrent-hydrate rule
                    // instead of racing whatever else is reloading.
                    if (typeof window.p86Refresh === 'function') return window.p86Refresh('job');
                    return loadData();
                })
                .catch(function() { _recoveryInFlight = false; })
                .then(function() { if (!_serverLoadOk) armLoadRecovery(); });
        }
        window.p86TryReconnect = function() {
            _recoveryAttempt = 0;
            if (_recoveryTimer) { clearTimeout(_recoveryTimer); _recoveryTimer = null; }
            runLoadRecovery();
        };
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('online', function() { if (!_serverLoadOk) window.p86TryReconnect(); });
            document.addEventListener('visibilitychange', function() {
                if (document.visibilityState === 'visible' && !_serverLoadOk) armLoadRecovery();
            });
        }

        /* ── the one public read of "where are my bytes" ─────────────────────
         * Counts are ENTITY counts off the dirty set, never a count of blocked
         * saveData() calls — one edit fires many, and "your last 47 changes are
         * on this device only" for one edited field is both alarming and false.
         * Names come from the same set, which is why "Show what's unsaved" can
         * list actual rows instead of a number. */
        window.p86SaveState = function() {
            var jobIds = [], estIds = [];
            try { jobIds = dirtyJobIds(); estIds = dirtyEstimateIds(); } catch (e) {}
            var name = function(arr, id, fb) {
                var r = (arr || []).find(function(x) { return x.id === id; });
                return (r && (r.title || r.name || r.jobNumber)) || fb || id;
            };
            return {
                writable: !!_serverLoadOk,
                loading: !!_serverLoadInFlight,
                baselineSource: _baselineSource,
                since: _blockedSince || 0,
                heldMs: _blockedSince ? (Date.now() - _blockedSince) : 0,
                retryAttempt: _recoveryAttempt,
                holds: _consecutiveHolds,
                jobs: jobIds.map(function(id) { return name(appData.jobs, id); }),
                estimates: estIds.map(function(id) { return name(appData.estimates, id); }),
                jobIds: jobIds, estimateIds: estIds
            };
        };

        // A save conflict = the server rejected our write because someone else
        // changed that job since we loaded it. We must NOT overwrite (that is the
        // silent cross-user clobber this whole mechanism prevents). Tell the user
        // plainly, then converge on the server's version so the client stops
        // resending a stale base. Debounced so a burst reloads once.
        var _conflictReloadPending = false;
        // Rows already announced as deleted, so a reload that cannot land does
        // not re-announce the same row on every retry. Said once, per row, per
        // session — the convergence keeps trying, the dialog does not.
        var _announcedDeleted = {};
        // Conflicts waiting on the one debounced reload, from BOTH stores.
        var _pendingConflicts = [];
        // Jobs and estimates are the same story with different nouns, and the
        // copy has to name the right one — "2 jobs were deleted" for two
        // estimates is the kind of wrong that makes a user distrust the rest.
        function _conflictKind(kind) {
            if (kind === 'estimate') {
                return {
                    one: 'estimate', many: 'estimates',
                    sig: estimateSliceSig,
                    row: function(id) { return (appData.estimates || []).find(function(x) { return x.id === id; }); }
                };
            }
            return {
                one: 'job', many: 'jobs',
                sig: jobSliceSig,
                row: function(id) { return (appData.jobs || []).find(function(x) { return x.id === id; }); }
            };
        }
        function handleSaveConflicts(conflicts, kind) {
            try {
                kind = kind === 'estimate' ? 'estimate' : 'job';
                var K = _conflictKind(kind);
                // Snapshot what THIS client was holding for each rejected row so
                // we can tell, after the reload, whether anything the user
                // actually typed was lost.
                //
                // NAMES ARE CAPTURED HERE, before the reload. A row the server
                // reports as DELETED is not in appData once the hydrate lands,
                // and "your change to j17f3b was not saved" is not a sentence a
                // person can act on.
                var beforeSig = {}, nameOf = {};
                conflicts.forEach(function(c) {
                    beforeSig[c.id] = K.sig(c.id);
                    var rec = K.row(c.id);
                    nameOf[c.id] = (rec && (rec.title || rec.name)) || c.id;
                });
                // Two different events wear the word "conflict" and they need
                // different sentences. STALE means the row moved on and the
                // current version is being loaded — recoverable, often not even
                // a real loss. DELETED means somebody removed the row while this
                // client was holding a change to it: the server refused to
                // re-create it (that refusal is the whole point), the row is
                // about to disappear from the screen, and the change to it is
                // gone. Announcing that as "changed by someone else" would be
                // false about the one fact that matters.
                var names = conflicts.map(function(c) { return nameOf[c.id]; });
                console.warn('[save-conflict][' + kind + ']', names.join(', '));

                // QUEUE, don't drop. The old shape did the announcement inside
                // `if (!_conflictReloadPending)`, so a second burst arriving
                // inside the 1.2s window was debounced away entirely — the
                // reload covered it, nothing ever said what happened. That is
                // now reachable on every push, because jobs and estimates can
                // both conflict in the same response.
                conflicts.forEach(function(c) {
                    _pendingConflicts.push({
                        kind: kind, id: c.id, reason: c.reason,
                        name: nameOf[c.id], beforeSig: beforeSig[c.id]
                    });
                });
                if (!_conflictReloadPending) {
                    _conflictReloadPending = true;
                    setTimeout(function() {
                        _conflictReloadPending = false;
                        var batch = _pendingConflicts;
                        _pendingConflicts = [];
                        var deleted = batch.filter(function(c) { return c.reason === 'deleted'; });
                        var stale = batch.filter(function(c) { return c.reason !== 'deleted'; });
                        // fromConflict is a HARD override of the hydrate hold.
                        // The rows in `batch` are rows the server has
                        // already refused at this base — holding the hydrate to
                        // push them again would re-conflict and re-hold, on a
                        // loop. The server's version has to land, and the
                        // before/after comparison below is what says out loud
                        // whether anything the user typed was actually lost.
                        Promise.resolve().then(function() { return loadData({ fromConflict: true }); }).then(function() {
                            // ── deleted rows ────────────────────────────────
                            // Not a toast. A toast is a moment, it can fire while
                            // the tab is in the background, and this is the one
                            // outcome in the whole save path that is not
                            // recoverable by waiting: the record is gone, the
                            // change to it is gone with it, and the row is
                            // vanishing from the screen as the dialog opens.
                            // p86Alert is also the only one of the three that
                            // actually renders inside the installed PWA.
                            var fresh = deleted.filter(function(c) { return !_announcedDeleted[c.kind + ':' + c.id]; });
                            if (fresh.length) {
                                fresh.forEach(function(c) { _announcedDeleted[c.kind + ':' + c.id] = 1; });
                                var dn = fresh.map(function(c) { return c.name; });
                                var dk = _conflictKind(fresh[0].kind);
                                var noun = fresh.every(function(c) { return c.kind === fresh[0].kind; })
                                    ? (dn.length === 1 ? dk.one : dk.many) : 'records';
                                var dmsg = (dn.length === 1
                                        ? ('“' + dn[0] + '” was deleted by someone else while you had an unsaved change to it.')
                                        : (dn.length + ' ' + noun + ' were deleted by someone else while you had unsaved changes to them: ' + dn.join(', ') + '.')) +
                                    ' That change could not be saved, and ' +
                                    (dn.length === 1 ? ('the ' + noun + ' was') : ('the ' + noun + ' were')) +
                                    ' NOT re-created. If ' + (dn.length === 1 ? 'it' : 'they') +
                                    ' should still exist, re-create ' + (dn.length === 1 ? 'it' : 'them') + ' from scratch.';
                                if (typeof window.p86Alert === 'function') {
                                    try { window.p86Alert({ title: 'Deleted by someone else', message: dmsg }); } catch (e) {}
                                } else if (window.p86Toast) {
                                    try { window.p86Toast(dmsg, 'error'); } catch (e) {}
                                }
                                console.warn('[save-conflict] deleted on the server, not resurrected:', dn.join(', '));
                            }
                            if (!stale.length) return;
                            // Only NOW do we know whether the user lost anything.
                            //
                            // A rejected push is not automatically a lost edit. The
                            // common case by far is a second session (or the QB
                            // import, which stamps qbCosts* + updatedAt on every
                            // matched job) making ~20 jobs dirty with values that
                            // already match the server. Announcing "22 jobs were
                            // changed by someone else — your latest edit was NOT
                            // saved" for that is both false and alarming: the user
                            // edited nothing and lost nothing.
                            //
                            // Compare the slice we were holding against the server's
                            // truth. Same → silent converge. Different → the user
                            // really did lose something and must be told.
                            var lost = stale.filter(function(c) {
                                return c.beforeSig !== _conflictKind(c.kind).sig(c.id);
                            });
                            if (!lost.length) {
                                console.log('[save-conflict] ' + stale.length +
                                    ' row(s) rejected but identical to the server after reload — nothing was lost, converged silently.');
                                return;
                            }
                            // Three refusals, three facts, three sentences.
                            //   stale        — the row moved on under us
                            //   unverifiable — nobody necessarily touched it; this
                            //                  device could not prove which version
                            //                  it held, so the server refused
                            //   locked       — the estimate is SOLD and immutable,
                            //                  which is not a race at all
                            // Collapsing them into "changed by someone else" would
                            // be a guess in two of the three, and a guess in this
                            // sentence is how a user learns to ignore the rest.
                            var say = function(msg) {
                                if (window.p86Toast) { try { window.p86Toast(msg, 'error'); } catch (e) {} }
                            };
                            var pick = function(fn) {
                                return lost.filter(fn).map(function(c) { return c.name; });
                            };
                            var nounFor = function(rows) {
                                var ks = lost.filter(rows);
                                if (!ks.length) return 'records';
                                var k = _conflictKind(ks[0].kind);
                                return ks.every(function(c) { return c.kind === ks[0].kind; })
                                    ? (ks.length === 1 ? k.one : k.many) : 'records';
                            };
                            var isLocked = function(c) { return c.reason === 'locked'; };
                            var isUnver = function(c) { return c.reason === 'unverifiable'; };
                            // Two refusals that are NOT races and were both
                            // landing in the isStale bucket — which says "changed
                            // by someone else", a sentence that is false about
                            // both of them and sends the user looking for a
                            // colleague who did nothing.
                            //   not_in_org    — the row belongs to another
                            //                   organization. Nothing of this
                            //                   user's was overwritten or lost.
                            //   invalid_owner — the owner named for this row is
                            //                   not in this organization. The
                            //                   fix is a different owner, not a
                            //                   reload.
                            var isNotInOrg = function(c) { return c.reason === 'not_in_org'; };
                            var isBadOwner = function(c) { return c.reason === 'invalid_owner'; };
                            var isStale = function(c) {
                                return !isLocked(c) && !isUnver(c) && !isNotInOrg(c) && !isBadOwner(c);
                            };

                            var lostChanged = pick(isStale);
                            if (lostChanged.length) {
                                say((lostChanged.length === 1
                                        ? ('“' + lostChanged[0] + '” was changed by someone else — your edit to it was NOT saved.')
                                        : (lostChanged.length + ' ' + nounFor(isStale) + ' were changed by someone else — your edits to them were NOT saved.')) +
                                    ' The current version has been loaded.');
                            }
                            var lostUnver = pick(isUnver);
                            if (lostUnver.length) {
                                say((lostUnver.length === 1
                                        ? ('“' + lostUnver[0] + '” was not saved: this device could not tell which version it was editing.')
                                        : (lostUnver.length + ' ' + nounFor(isUnver) + ' were not saved: this device could not tell which version it was editing.')) +
                                    ' They were refused rather than risk overwriting newer work. The current version has been loaded.');
                            }
                            var lostLocked = pick(isLocked);
                            if (lostLocked.length) {
                                say((lostLocked.length === 1
                                        ? ('“' + lostLocked[0] + '” is locked — it was sold on a job and cannot be changed.')
                                        : (lostLocked.length + ' ' + nounFor(isLocked) + ' are locked — they were sold on a job and cannot be changed.')) +
                                    ' Your edit was NOT saved. An admin can unlock it.');
                            }
                            var lostForeign = pick(isNotInOrg);
                            if (lostForeign.length) {
                                say((lostForeign.length === 1
                                        ? ('“' + lostForeign[0] + '” is not in your organization — it was not saved.')
                                        : (lostForeign.length + ' ' + nounFor(isNotInOrg) + ' are not in your organization — they were not saved.')) +
                                    ' Nothing about ' + (lostForeign.length === 1 ? 'it' : 'them') + ' was changed.');
                            }
                            var lostOwner = pick(isBadOwner);
                            if (lostOwner.length) {
                                say((lostOwner.length === 1
                                        ? ('“' + lostOwner[0] + '” was not saved: the owner it names is not in your organization.')
                                        : (lostOwner.length + ' ' + nounFor(isBadOwner) + ' were not saved: the owners they name are not in your organization.')) +
                                    ' Assign an owner from your own team and save again.');
                            }
                            console.warn('[save-conflict] genuinely lost edits on:',
                                lostChanged.concat(lostUnver).concat(lostLocked)
                                    .concat(lostForeign).concat(lostOwner).join(', '));
                        }).catch(function () {});
                    }, 1200);
                }
            } catch (e) {}
        }

        function pushToServer(opts) {
            opts = opts || {};
            if (!window.p86Api || !window.p86Api.isAuthenticated()) return Promise.resolve();
            // THE guard lives here, at the single chokepoint, not only in
            // saveData(). flushPendingSave() (pagehide/beforeunload/visibility)
            // and p86Data.pushToServer() in markup-viewer.js / sheet-editor.js
            // all call this directly, so a guard in saveData alone left three
            // ways to push the stale localStorage cache over good server data.
            // Until a GET has actually succeeded, memory is a cache, and this
            // is a FULL BULK REPLACE across jobs/buildings/phases/COs/subs/POs/
            // invoices — one stale push reverts every one of them.
            if (!_serverLoadOk) {
                console.warn('pushToServer skipped: no successful server load yet (memory is the localStorage cache).');
                return Promise.resolve();
            }
            // Only push jobs the current user can edit. _canEdit comes from the
            // server on each GET. Read-only jobs (e.g. another PM's job that this
            // user can view but not modify) are filtered out so PMs scrolling the
            // list don't accidentally overwrite each other's data.
            var editableJobs = appData.jobs.filter(function(j) { return j._canEdit !== false; });
            // ...and of those, only the ones THIS client actually changed.
            //
            // Every save used to ship every editable job, so a session that had
            // merely opened the app would rewrite all 22 jobs from its cache on
            // its next save — clobbering another user's work on jobs it never
            // touched. That is how a corrected scope split and a deleted building
            // kept coming back while this client's own memory was clean: a second
            // session, editing nothing, was replaying its stale snapshot.
            //
            // A job is dirty when its slice differs from what we last loaded or
            // successfully pushed. New jobs have no baseline and always count.
            var dirty = editableJobs.filter(function(j) {
                return _jobBaseline[j.id] !== jobSliceSig(j.id);
            });
            if (!dirty.length && !_estimatesDirty()) return Promise.resolve();
            editableJobs = dirty;
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
            // Estimates: ONLY the rows this client actually changed.
            //
            // This used to be `estimates: appData.estimates` — every estimate,
            // every time, gated on one portfolio-wide signature, against an
            // endpoint that had no version guard at all. Scoping is still right
            // (a row you never touched has no business on the wire) but it was
            // never sufficient: it controls WHICH rows are at risk, never what
            // happens to a row that IS sent. The route now referees each one
            // against a base version, same as jobs.
            //
            // Alternates ride INLINE on each estimate now; legacy
            // `estimateAlternates: []` stays empty for back-compat with older
            // server builds that read it as a fallback.
            var dirtyEstIds = opts.jobsOnly ? [] : dirtyEstimateIds();
            var estIdSet = {};
            dirtyEstIds.forEach(function(id) { estIdSet[id] = true; });
            var estimatesPayload = {
                estimates: appData.estimates.filter(function(e) { return estIdSet[e.id]; }),
                estimateLines: appData.estimateLines.filter(function(l) { return estIdSet[l.estimateId]; }),
                estimateAlternates: []
            };

            notifyPushStatus('saving');
            var pushedIds = editableJobs.map(function(j) { return j.id; });
            // Base version per pushed job for optimistic concurrency.
            // Every row that EXISTS on the server carries one, so the guard is
            // no longer opt-in: a real version when we have one, the sentinel
            // when we know the row is there but cannot say which version we
            // hold. Only a row the server does not have goes out bare — that
            // absence is what says "create", and it is the only thing that may.
            var baseVersions = {};
            pushedIds.forEach(function(id) {
                if (_jobVersion[id]) baseVersions[id] = _jobVersion[id];
                else if (_serverJobIds[id]) baseVersions[id] = UNVERSIONED_BASE;
            });
            // …and the same base per estimate. Identical rule to the job side:
            // a real version when we have one, the sentinel when the server's
            // list says the row exists but we cannot say which version we hold,
            // nothing at all for a row the server does not have (a create).
            var estBaseVersions = {};
            dirtyEstIds.forEach(function(id) {
                if (_estimateVersion[id]) estBaseVersions[id] = _estimateVersion[id];
                else if (_serverEstimateIds[id]) estBaseVersions[id] = UNVERSIONED_BASE;
            });
            var estimatesGo = dirtyEstIds.length > 0;
            // Snapshot the signature of what we are ABOUT TO SEND, per row.
            // The re-baseline below must advance to THIS, not to whatever
            // memory holds when the response lands — reading live memory at
            // completion marks a keystroke that arrived mid-flight as already
            // saved, so it is never pushed and is dropped by the next hydrate.
            // That is the same "lost an edit it claimed to have saved" defect
            // this whole path exists to kill, one level down.
            var sentJobSig = {}, sentEstSig = {};
            pushedIds.forEach(function(id) { sentJobSig[id] = jobSliceSig(id); });
            dirtyEstIds.forEach(function(id) { sentEstSig[id] = estimateSliceSig(id); });
            _activePush = Promise.all([
                editableJobs.length ? window.p86Api.jobs.bulkSave(jobsPayload, baseVersions) : Promise.resolve(),
                estimatesGo ? window.p86Api.estimates.bulkSave(estimatesPayload, estBaseVersions) : Promise.resolve()
            ]).then(function(r) {
                _pushRetryCount = 0;
                _activePush = null;
                var jobsResp = (r && r[0]) || {};
                var conflicts = (jobsResp.conflicts && jobsResp.conflicts.length) ? jobsResp.conflicts : null;
                // Advance the base version for every job the server actually
                // accepted, so this client doesn't false-conflict on its next save.
                if (jobsResp.versions) {
                    Object.keys(jobsResp.versions).forEach(function(id) { _jobVersion[id] = jobsResp.versions[id]; });
                }
                // Re-baseline the jobs we pushed EXCEPT any the server rejected as
                // conflicts — those weren't written, so they stay dirty and their
                // base version stays put (a conflict never advances the version).
                var rejected = {};
                if (conflicts) conflicts.forEach(function(c) { rejected[c.id] = 1; });
                pushedIds.forEach(function(id) { if (!rejected[id]) _jobBaseline[id] = sentJobSig[id]; });
                // The estimate side of the same rule. It used to re-baseline
                // every pushed estimate unconditionally, because the endpoint
                // could not refuse anything — so a row the route SKIPPED (a
                // locked, sold estimate) was marked saved and the edit was gone.
                var estResp = (r && r[1]) || {};
                var estConflicts = (estResp.conflicts && estResp.conflicts.length) ? estResp.conflicts : null;
                if (estResp.versions) {
                    Object.keys(estResp.versions).forEach(function(id) { _estimateVersion[id] = estResp.versions[id]; });
                }
                var estRejected = {};
                if (estConflicts) estConflicts.forEach(function(c) { estRejected[c.id] = 1; });
                dirtyEstIds.forEach(function(id) { if (!estRejected[id]) _estimateBaseline[id] = sentEstSig[id]; });

                if (conflicts) handleSaveConflicts(conflicts, 'job');
                if (estConflicts) handleSaveConflicts(estConflicts, 'estimate');
                if (conflicts || estConflicts) {
                    // NOT 'saved'. A partial-conflict response used to emit
                    // 'saved' — a green ✓ in the estimate editor and no banner —
                    // for rows the server had just REFUSED to write. The
                    // sentence handleSaveConflicts eventually shows is correct;
                    // the status fired 1200ms earlier was not.
                    var _all = (conflicts || []).concat(estConflicts || []);
                    notifyPushStatus('partial', {
                        ids: _all.map(function(c) { return c.id; }),
                        // The banner covers the ~1.2s between the refusal and the
                        // conflict reload, and "another session changed a record
                        // you were editing" is false when the record was DELETED.
                        deleted: _all.filter(function(c) { return c.reason === 'deleted'; })
                                     .map(function(c) { return c.id; })
                    });
                } else {
                    _blockedSince = 0;
                    notifyPushStatus('saved');
                }
                return r;
            }).catch(function(err) {
                console.warn('Server push failed (attempt ' + (_pushRetryCount + 1) + '):', err.message);
                _activePush = null;
                // Six attempts ≈ 60s of coverage, not ~7s. A Railway swap is a
                // 2-3 minute window, and a ladder that gave up inside ten
                // seconds meant the push retry was decorative during exactly
                // the failure it was written for. saveData() re-arms the count
                // on new user intent, so this is a per-burst bound.
                if (_pushRetryCount < PUSH_BACKOFF.length) {
                    var backoff = PUSH_BACKOFF[_pushRetryCount];
                    _pushRetryCount++;
                    notifyPushStatus('retrying', err);
                    setTimeout(function() { pushToServer(); }, backoff);
                } else {
                    if (!_blockedSince) _blockedSince = Date.now();
                    notifyPushStatus('failed', {
                        reason: 'push-failed', error: err,
                        jobs: dirtyJobIds(), estimates: dirtyEstimateIds()
                    });
                }
                throw err;
            });
            return _activePush;
        }

        // Send any debounced push NOW instead of waiting out the 600ms window.
        //
        // saveData() writes localStorage immediately but defers the server push.
        // A navigation inside that window dropped the push silently: localStorage
        // (and therefore the UI, which is seeded from it on boot) kept showing the
        // edit, so it looked saved and even survived a reload — until the server
        // copy won and the change vanished. That is how a hand-entered scope
        // budget on Fairways reverted to an even split more than once.
        function flushPendingSave() {
            // The `if (!_serverPushTimer) return` that used to open this
            // function made all three listeners below permanent no-ops in the
            // case that mattered: when saveData's guard was shut the timer was
            // never armed, so pagehide / beforeunload / visibilitychange had
            // nothing to flush and the edit went away with the tab. Ask the
            // dirty set instead of a timer. pushToServer's own guards make this
            // a cheap no-op when there is genuinely nothing to send.
            if (_serverPushTimer) { clearTimeout(_serverPushTimer); _serverPushTimer = null; }
            if (!_serverLoadOk || _serverLoadInFlight) return _activePush || Promise.resolve();
            if (!dirtyJobIds().length && !_estimatesDirty()) return _activePush || Promise.resolve();
            return pushToServer();
        }
        // Cover every way a page can go away: pagehide fires on navigation and
        // bfcache, visibilitychange catches mobile backgrounding (where pagehide
        // is unreliable), and beforeunload catches desktop close. Firing the same
        // flush from all three is harmless — with no timer pending it is a no-op.
        window.addEventListener('pagehide', function() { try { flushPendingSave(); } catch (e) {} });
        window.addEventListener('beforeunload', function() { try { flushPendingSave(); } catch (e) {} });
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'hidden') { try { flushPendingSave(); } catch (e) {} }
        });

        // Expose for explicit triggers (e.g. the import-from-browser button)
        window.p86Data = {
            pushToServer: pushToServer,
            flushPendingSave: flushPendingSave,
            reloadFromServer: loadData
        };
        window.p86FlushSave = flushPendingSave;

        // ==================== SEED DATA ====================
        function seedDataIfNeeded() {
            // Server is source of truth when authenticated — never seed demo data
            if (window.p86Api && window.p86Api.isAuthenticated()) return;
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

        // ==================== JOBS MAIN VIEW ====================

function exportJobsToCSV() {
            alert('Export to CSV');
        }

        // ==================== START APP ====================
        document.addEventListener('DOMContentLoaded', initializeApp);
    

// ── AGX Estimate Import/Export ──────────────────────────────────
