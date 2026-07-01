// Sort state for the estimates list. Click a column header to toggle
// direction; clicking a different header switches to it (descending for
// numerics/dates, ascending for text — same convention as the Leads
// list so the two sub-tabs feel consistent).
var _estimatesSort = { key: 'updated_at', dir: 'desc' };

// Pre-compute the totals + line count once per estimate. Used both by
// the row renderer and the sort comparator so sorting by Base Cost /
// Client Price doesn't recalculate on every comparison.
//
// IMPORTANT: this needs to MATCH the math in estimate-editor.js'
// computeTotals(), so the number a user sees in the editor matches
// the number on the list. The editor honors:
//   - Per-alternate (group) inclusion via alt.excludeFromTotal
//   - Target-margin override (est.targetMargin > 0 back-computes the
//     marked-up subtotal: markedUp = subtotal / (1 - target/100))
//   - Flat + percentage fees
//   - Tax %
//   - Round-up to nearest est.roundTo
// Earlier this helper only summed line markups and ignored everything
// else, so a user who set a target margin or had excluded alternates
// saw drifted numbers between the list and the editor.
function computeEstimateTotals(est) {
    var num = function(v) { var n = Number(v); return isFinite(n) ? n : 0; };
    var lineCount = 0;
    var sectionCount = 0;
    var allLines = (appData.estimateLines || []).filter(function(l) { return l.estimateId === est.id; });

    // Same helpers the editor uses, scoped to a single alternate.
    function sectionHeaderForIdx(lines, idx) {
        for (var i = idx - 1; i >= 0; i--) {
            var L = lines[i];
            if (L && L.section === '__section_header__') return L;
        }
        return null;
    }
    function markedUpForGroup(alt) {
        if (!alt) return { subtotal: 0, markedUp: 0 };
        var lines = allLines.filter(function(l) { return l.alternateId === alt.id; });
        var subtotal = 0, markedUp = 0;
        lines.forEach(function(l, idx) {
            if (l.section === '__section_header__') {
                sectionCount++;
                if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
                    markedUp += num(l.markup);
                }
                return;
            }
            lineCount++;
            var ext = num(l.qty) * num(l.unitCost);
            subtotal += ext;
            var section = sectionHeaderForIdx(lines, idx);
            var inDollar = section && section.markupMode === 'dollar';
            var m;
            if (section && section.overrideLineMarkups) {
                m = inDollar ? 0 : ((section.markup === '' || section.markup == null) ? null : num(section.markup));
            } else {
                m = (l.markup === '' || l.markup == null) ? null : num(l.markup);
                if (m == null && !inDollar && section && section.markup !== '' && section.markup != null) m = num(section.markup);
            }
            if (m == null && !inDollar && est.defaultMarkup != null && est.defaultMarkup !== '') m = num(est.defaultMarkup);
            if (m == null) m = 0;
            markedUp += ext * (1 + m / 100);
        });
        return { subtotal: subtotal, markedUp: markedUp };
    }

    // Sum across every INCLUDED alternate. Legacy estimates without an
    // alternates[] array effectively have one implicit group containing
    // all lines — handled by the fallback below.
    var targetActive = (num(est.targetMargin) > 0 && num(est.targetMargin) < 100);
    var subtotal = 0;
    var markedUp = 0;
    var alts = Array.isArray(est.alternates) ? est.alternates : [];
    if (alts.length) {
        alts.forEach(function(alt) {
            var per = markedUpForGroup(alt);
            if (alt.excludeFromTotal) return;
            if (targetActive) {
                per = { subtotal: per.subtotal, markedUp: per.subtotal / (1 - num(est.targetMargin) / 100) };
            }
            subtotal += per.subtotal;
            markedUp += per.markedUp;
        });
    } else {
        // No alternates array — treat ALL lines as one group. Lines
        // would have undefined alternateId so the alt-id filter above
        // wouldn't match; do a quick one-pass straight over allLines.
        allLines.forEach(function(l, idx) {
            if (l.section === '__section_header__') {
                sectionCount++;
                if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
                    markedUp += num(l.markup);
                }
                return;
            }
            lineCount++;
            var ext = num(l.qty) * num(l.unitCost);
            subtotal += ext;
            var section = sectionHeaderForIdx(allLines, idx);
            var inDollar = section && section.markupMode === 'dollar';
            var m;
            if (section && section.overrideLineMarkups) {
                m = inDollar ? 0 : ((section.markup === '' || section.markup == null) ? null : num(section.markup));
            } else {
                m = (l.markup === '' || l.markup == null) ? null : num(l.markup);
                if (m == null && !inDollar && section && section.markup !== '' && section.markup != null) m = num(section.markup);
            }
            if (m == null && !inDollar && est.defaultMarkup != null && est.defaultMarkup !== '') m = num(est.defaultMarkup);
            if (m == null) m = 0;
            markedUp += ext * (1 + m / 100);
        });
        if (targetActive && subtotal > 0) {
            markedUp = subtotal / (1 - num(est.targetMargin) / 100);
        }
    }

    var feeFlat = num(est.feeFlat);
    var feePctAmount = markedUp * num(est.feePct) / 100;
    var preTax = markedUp + feeFlat + feePctAmount;
    var taxAmount = preTax * num(est.taxPct) / 100;
    var beforeRound = preTax + taxAmount;
    var roundTo = num(est.roundTo);
    var total = beforeRound;
    if (roundTo > 0) total = Math.ceil(beforeRound / roundTo) * roundTo;

    var blendedMarkup = subtotal > 0 ? (markedUp / subtotal - 1) * 100 : 0;
    return {
        baseCost: subtotal,
        markedUp: markedUp,
        blendedMarkup: blendedMarkup,
        clientPrice: total,            // matches Proposal Total in the editor
        proposalTotal: total,
        feeFlat: feeFlat,
        feePctAmount: feePctAmount,
        taxAmount: taxAmount,
        lineCount: lineCount,
        sectionCount: sectionCount,
        targetMarginActive: targetActive
    };
}

function compareEstimates(a, b, key, dir) {
    var av, bv;
    var ta = a.__totals || {};
    var tb = b.__totals || {};
    if (key === 'baseCost') { av = ta.baseCost || 0; bv = tb.baseCost || 0; }
    else if (key === 'markup') { av = ta.blendedMarkup || 0; bv = tb.blendedMarkup || 0; }
    else if (key === 'clientPrice') { av = ta.clientPrice || 0; bv = tb.clientPrice || 0; }
    else if (key === 'margin') {
        // Gross margin = (markedUp - baseCost) / markedUp — same
        // formula the editor's Margin chip uses (BEFORE fees + tax,
        // since those are pass-throughs to the customer).
        av = (ta.markedUp || 0) > 0 ? ((ta.markedUp - ta.baseCost) / ta.markedUp) : 0;
        bv = (tb.markedUp || 0) > 0 ? ((tb.markedUp - tb.baseCost) / tb.markedUp) : 0;
    }
    else if (key === 'lines') { av = ta.lineCount || 0; bv = tb.lineCount || 0; }
    else if (key === 'updated_at') {
        av = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        bv = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    } else if (key === 'sent_at') {
        av = a.sent_at ? new Date(a.sent_at).getTime() : 0;
        bv = b.sent_at ? new Date(b.sent_at).getTime() : 0;
    } else if (key === 'status') {
        av = estStatusRank(a); bv = estStatusRank(b);
    } else if (key === 'client') {
        av = (a.client || a.community || '').toLowerCase();
        bv = (b.client || b.community || '').toLowerCase();
    } else { // title
        av = (a.title || '').toLowerCase(); bv = (b.title || '').toLowerCase();
    }
    if (av < bv) return dir === 'desc' ? 1 : -1;
    if (av > bv) return dir === 'desc' ? -1 : 1;
    return 0;
}

function sortEstimatesBy(key) {
    if (_estimatesSort.key === key) {
        _estimatesSort.dir = _estimatesSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        _estimatesSort.key = key;
        // Numerics + dates default to descending so "biggest/newest first"
        // matches how a user usually wants to scan the list.
        _estimatesSort.dir = (key === 'baseCost' || key === 'markup' || key === 'clientPrice' ||
                              key === 'margin' || key === 'lines' || key === 'updated_at' ||
                              key === 'sent_at' || key === 'status') ? 'desc' : 'asc';
    }
    renderEstimatesList();
}
window.sortEstimatesBy = sortEstimatesBy;

// Estimate lifecycle status, derived from the linked job + sent_at timestamp:
//   Won  = converted to a job (job_id set)
//   Sent = proposal marked sent (sent_at) but not yet won
//   Draft = not sent yet
function estStatusMeta(est) {
    if (est && est.job_id) return { key: 'won',  label: 'Won',   color: '#34d399', bg: 'rgba(52,211,153,.14)' };
    if (est && est.sent_at) return { key: 'sent', label: 'Sent',  color: '#60a5fa', bg: 'rgba(96,165,250,.14)' };
    return { key: 'draft', label: 'Draft', color: '#94a3b8', bg: 'rgba(148,163,184,.14)' };
}
function estStatusRank(est) { var k = estStatusMeta(est).key; return k === 'won' ? 2 : k === 'sent' ? 1 : 0; }

// Mark an estimate Sent (or clear it). Optimistic: stamp locally + re-render,
// then persist. sent=false undoes a misclick.
function markEstimateSent(id, sent) {
    var est = (appData.estimates || []).find(function(e) { return e.id === id; });
    if (!est) return;
    var api = window.p86Api;
    if (!api || !api.estimates || !api.estimates.markSent) return;
    api.estimates.markSent(id, sent).then(function(r) {
        est.sent_at = (r && 'sent_at' in r) ? r.sent_at : (sent ? new Date().toISOString() : null);
        if (r && 'sent_count' in r) est.sent_count = r.sent_count;
        renderEstimatesList();
        if (window.p86Toast) window.p86Toast(sent ? 'Marked sent.' : 'Sent status cleared.', 'success');
    }).catch(function() {
        if (window.p86Toast) window.p86Toast('Could not update sent status.', 'error');
    });
}
window.markEstimateSent = markEstimateSent;
// Exposed so the lead-side "Create Job" flow can compute a chosen estimate's
// proposal total (the bid) without opening the estimate editor.
window.computeEstimateTotals = computeEstimateTotals;

// Mirrors the Jobs-list header pattern (and the new leadsHeaderCell):
// a `.sortable` th picks up its chevron + accent color from the global
// `th.sortable.sort-asc/desc` rules in styles.css. No inline arrows or
// label-color overrides here.
function estimatesHeaderCell(label, key, opts) {
    opts = opts || {};
    var active = _estimatesSort.key === key;
    var classes = 'sortable';
    if (active) classes += (_estimatesSort.dir === 'asc' ? ' sort-asc' : ' sort-desc');
    if (opts.num) classes += ' num';
    var alignAttr = opts.num ? ' style="text-align:right;"' : '';
    return '<th class="' + classes + '" data-col="' + key + '" data-sort="' + key + '"' + alignAttr +
        ' onclick="sortEstimatesBy(\'' + key + '\')">' + label + '</th>';
}

function fmtRelativeDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    var diffMs = Date.now() - d.getTime();
    var days = Math.floor(diffMs / 86400000);
    if (days < 1) return 'today';
    if (days < 7) return days + 'd ago';
    if (days < 30) return Math.floor(days / 7) + 'w ago';
    return d.toLocaleDateString();
}

// ── Estimates map view ─────────────────────────────────────────────
// Estimates carry no geocoded coords of their own, but every estimate
// links to a lead (lead_id), and leads ARE geocoded server-side — so we
// resolve each estimate's pin from its linked lead. The split map+list
// pane is the same p86ProjectsMap the Leads / Projects maps use. The
// sidebar "Estimate List" / "Estimates Map" children flip _estimatesView
// via setEstimatesView().
var _estimatesView = 'list';   // 'list' | 'map'
var _estMapStatus = 'active';  // 'all' | 'active' (no job yet) | 'won' (has job)
var _estLeadCoords = null;     // { leadId: {lat,lng,address} } — loaded once

function setEstimatesView(v) {
    _estimatesView = (v === 'map') ? 'map' : 'list';
    renderEstimatesList();
}
window.setEstimatesView = setEstimatesView;

function setEstimatesMapStatus(s) {
    _estMapStatus = (s === 'all' || s === 'won') ? s : 'active';
    renderEstimatesList();
}
window.setEstimatesMapStatus = setEstimatesMapStatus;

function loadEstimateLeadCoords(cb) {
    if (_estLeadCoords) { cb(); return; }
    if (!window.p86Api || !window.p86Api.leads || !window.p86Api.isAuthenticated()) { _estLeadCoords = {}; cb(); return; }
    window.p86Api.leads.list().then(function(res) {
        var m = {};
        ((res && res.leads) || []).forEach(function(l) {
            m[l.id] = {
                lat: l.geocode_lat, lng: l.geocode_lng,
                address: [l.street_address, l.city, l.state, l.zip].filter(Boolean).join(', ')
            };
        });
        _estLeadCoords = m; cb();
    }).catch(function() { _estLeadCoords = {}; cb(); });
}

function renderEstimatesMap(listEl, filtered) {
    // Lazy-load the lead coord lookup, then re-render with pins resolved.
    if (!_estLeadCoords) {
        listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading map…</div>';
        loadEstimateLeadCoords(function() { if (_estimatesView === 'map') renderEstimatesList(); });
        return;
    }
    // Derived status filter — estimates have no status column; a linked
    // job_id means "won/converted", otherwise "active/open".
    var byStatus = filtered.filter(function(e) {
        if (_estMapStatus === 'won') return !!e.job_id;
        if (_estMapStatus === 'active') return !e.job_id;
        return true;
    });
    // Resolve coords for p86ProjectsMap (which reads geocode_lat/lng):
    // prefer the estimate's OWN server-geocoded coords (from propertyAddr),
    // fall back to the linked lead's coords. Copy so we never mutate the
    // cached estimate objects.
    var items = byStatus.map(function(e) {
        var lat = (e.geocode_lat != null) ? Number(e.geocode_lat) : null;
        var lng = (e.geocode_lng != null) ? Number(e.geocode_lng) : null;
        if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
            var c = e.lead_id ? _estLeadCoords[e.lead_id] : null;
            if (c) { lat = c.lat; lng = c.lng; }
        }
        return Object.assign({}, e, { geocode_lat: lat, geocode_lng: lng });
    });
    var mapped = items.filter(function(i) { return i.geocode_lat && i.geocode_lng; }).length;
    listEl.innerHTML =
        '<div class="est-map-filterbar">' +
            '<div class="est-map-filterbtns">' +
                ['active', 'all', 'won'].map(function(s) {
                    var label = s === 'active' ? 'Active' : (s === 'won' ? 'Won' : 'All');
                    return '<button type="button" class="est-map-fbtn' + (_estMapStatus === s ? ' active' : '') + '" onclick="setEstimatesMapStatus(\'' + s + '\')">' + label + '</button>';
                }).join('') +
            '</div>' +
            '<span class="est-map-count">' + mapped + ' of ' + items.length + ' plotted</span>' +
        '</div>' +
        '<div id="p86EstimatesMapHost" class="p86-projects-map-host"></div>';
    var host = document.getElementById('p86EstimatesMapHost');
    if (host && window.p86ProjectsMap && typeof window.p86ProjectsMap.render === 'function') {
        window.p86ProjectsMap.render(host, items, {
            entityLabel: 'estimates',
            showThumb: false,
            getName: function(e) { return e.title || '(untitled estimate)'; },
            getAddress: function(e) {
                if (e.propertyAddr) return e.propertyAddr;
                var c = e.lead_id ? _estLeadCoords[e.lead_id] : null;
                return c ? c.address : '';
            },
            getMeta: function(e) { return [e.client, e.community].filter(Boolean).join(' · ') || ''; },
            onPin: function(id) { if (typeof window.editEstimate === 'function') window.editEstimate(id); }
        });
    } else if (host) {
        host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Map module not loaded.</div>';
    }
}

function renderEstimatesList() {
            const listEl = document.getElementById('estimates-list');
            const searchEl = document.getElementById('estimates-search');
            const summaryEl = document.getElementById('estimates-summary');
            if (!listEl) return;

            // Search across title + client + community + addresses so the
            // user can filter by any visible piece of info.
            const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
            const all = appData.estimates || [];
            const filtered = !q ? all : all.filter(function(e) {
                return [e.title, e.client, e.community, e.propertyAddr, e.jobType, e.nickName]
                    .filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1;
            });

            if (summaryEl) {
                if (q) summaryEl.textContent = 'Showing ' + filtered.length + ' of ' + all.length + ' estimates';
                else summaryEl.textContent = all.length + ' estimate' + (all.length === 1 ? '' : 's');
            }

            // Map view — split map+list pane, pins resolved from each
            // estimate's linked lead. Search still applies; the derived
            // status filter is rendered inside the map view itself.
            if (_estimatesView === 'map') {
                renderEstimatesMap(listEl, filtered);
                return;
            }

            // Compute totals once per estimate, store on the object so the
            // sort comparator can use them without repeat work.
            const enriched = filtered.map(function(est) {
                est.__totals = computeEstimateTotals(est);
                return est;
            });

            const headerRow =
                estimatesHeaderCell('Title',         'title') +
                estimatesHeaderCell('Client / Community', 'client') +
                estimatesHeaderCell('Status',        'status') +
                estimatesHeaderCell('Lines',         'lines',       { num: true }) +
                estimatesHeaderCell('Base Cost',     'baseCost',    { num: true }) +
                estimatesHeaderCell('Markup %',      'markup',      { num: true }) +
                estimatesHeaderCell('Client Price',  'clientPrice', { num: true }) +
                estimatesHeaderCell('Margin %',      'margin',      { num: true }) +
                estimatesHeaderCell('Sent',          'sent_at') +
                estimatesHeaderCell('Updated',       'updated_at');

            if (!enriched.length) {
                const msg = q
                    ? 'No estimates match.'
                    : 'No estimates yet. Click ' + '“' + 'New Estimate' + '”' + ' to create your first.';
                listEl.innerHTML =
                    '<div class="p86-tbl-scroll">' +
                        '<table id="estimates-table" class="dense-table">' +
                            '<thead><tr>' + headerRow + '</tr></thead>' +
                            '<tbody><tr><td colspan="10" style="padding:24px;text-align:center;color:var(--text-dim,#888);">' + msg + '</td></tr></tbody>' +
                        '</table>' +
                    '</div>';
                return;
            }

            const sorted = enriched.slice().sort(function(a, b) {
                return compareEstimates(a, b, _estimatesSort.key, _estimatesSort.dir);
            });

            // Row markup mirrors the Jobs-list shape: minimal inline
            // styling, defer cell padding + font + hover to the global
            // `.dense-table` / `td` rules in styles.css. Money columns
            // get colored emphasis (price=green, markup=yellow); margin
            // gets the same progress-bar treatment Jobs uses for
            // "% Complete" so the visual at a glance matches.
            const rowsHtml = sorted.map(function(est) {
                const t = est.__totals;
                const clientLabel = [est.client, est.community].filter(Boolean).join(' &middot; ') ||
                    '<span style="color:var(--text-dim,#666);font-style:italic;">no client</span>';
                const titleSubBits = [];
                if (est.jobType) titleSubBits.push(escapeHTML(est.jobType));
                if (est.nickName) titleSubBits.push(escapeHTML(est.nickName));
                const titleSuffix = titleSubBits.length
                    ? '<span style="font-size:11px;color:var(--text-dim,#888);font-weight:normal;margin-left:6px;">' + titleSubBits.join(' · ') + '</span>'
                    : '';
                // Gross margin % — (markedUp − baseCost) / markedUp × 100.
                // Plain colored text matching the Jobs list's Margin %
                // column. (Tried a progress-bar here but p86Tables.enhance
                // clips block children in the narrow MARGIN column.)
                const margin = t.markedUp > 0 ? ((t.markedUp - t.baseCost) / t.markedUp) * 100 : 0;
                const marginColor = margin >= 30 ? '#34d399' : margin >= 15 ? '#fbbf24' : '#f87171';
                const marginCell = margin > 0
                    ? '<span style="color:' + marginColor + ';font-weight:600;">' + margin.toFixed(1) + '%</span>'
                    : '<span style="color:var(--text-dim,#888);">—</span>';
                var sm = estStatusMeta(est);
                var statusAction = sm.key === 'draft'
                    ? ' <button type="button" class="est-mark-sent" onclick="event.stopPropagation();markEstimateSent(\'' + est.id + '\',true)" title="Record that this proposal was sent">Mark sent</button>'
                    : (sm.key === 'sent'
                        ? ' <button type="button" class="est-mark-sent est-unsend" onclick="event.stopPropagation();markEstimateSent(\'' + est.id + '\',false)" title="Clear the sent status">undo</button>'
                        : '');
                var sentCell = est.sent_at
                    ? escapeHTML(fmtRelativeDate(est.sent_at)) + (est.sent_count > 1 ? '<span style="color:var(--text-dim,#888);"> ·' + est.sent_count + '×</span>' : '')
                    : '<span style="color:var(--text-dim,#666);">—</span>';
                return '<tr style="cursor:pointer;" onclick="editEstimate(\'' + est.id + '\')">' +
                    '<td data-col="title"><strong>' + escapeHTML(est.title || '(untitled)') + '</strong>' + titleSuffix + '</td>' +
                    '<td data-col="client">' + clientLabel + '</td>' +
                    '<td data-col="status" style="white-space:nowrap;"><span class="est-status-badge" style="color:' + sm.color + ';background:' + sm.bg + ';">' + sm.label + '</span>' + statusAction + '</td>' +
                    '<td data-col="lines" class="num">' + t.lineCount + '</td>' +
                    '<td data-col="baseCost" class="num">' + formatCurrency(t.baseCost) + '</td>' +
                    '<td data-col="markup" class="num" style="color:#fbbf24;">' + t.blendedMarkup.toFixed(1) + '%</td>' +
                    '<td data-col="clientPrice" class="num" style="color:#34d399;font-weight:600;">' + formatCurrency(t.clientPrice) + '</td>' +
                    '<td data-col="margin" class="num">' + marginCell + '</td>' +
                    '<td data-col="sent_at" style="white-space:nowrap;color:var(--text-dim,#888);" title="' + escapeHTML(est.sent_at || '') + '">' + sentCell + '</td>' +
                    '<td data-col="updated_at" style="white-space:nowrap;color:var(--text-dim,#888);" title="' + escapeHTML(est.updated_at || '') + '">' +
                        escapeHTML(fmtRelativeDate(est.updated_at)) +
                    '</td>' +
                '</tr>';
            }).join('');

            // Outer wrapper drops the heavy inline border / bg / radius
            // overrides — `.dense-table` already carries the look. This
            // matches how the Jobs list renders.
            listEl.innerHTML =
                '<div class="p86-tbl-scroll">' +
                    '<table id="estimates-table" class="dense-table">' +
                        '<thead><tr>' + headerRow + '</tr></thead>' +
                        '<tbody>' + rowsHtml + '</tbody>' +
                    '</table>' +
                '</div>';

            // Reorderable / resizable / freezable columns + internal scroll.
            if (window.p86Tables) window.p86Tables.enhance('estimates');
        }

        function openNewEstimateForm() {
            // Block editor open while the initial server fetch is still
            // landing — otherwise a user clicking through during the
            // load gap could see stale localStorage data, type edits,
            // and have them silently overwritten when the fetch
            // resolves. p86DataReady() returns true once loadData has
            // settled (success or fail).
            if (typeof window.p86DataLoading === 'function' && window.p86DataLoading()) {
                alert('Still loading from server — try again in a moment.');
                return;
            }
            document.getElementById('estTitle').value = '';
            document.getElementById('estJobType').value = '';
            document.getElementById('estClient').value = '';
            document.getElementById('estCommunity').value = '';
            document.getElementById('estPropertyAddr').value = '';
            document.getElementById('estBillingAddr').value = '';
            if (window.p86AddressAutocomplete) window.p86AddressAutocomplete.attachToField(document.getElementById('estPropertyAddr'), { placeholder: 'Search property address…' });
            document.getElementById('estManagerName').value = '';
            document.getElementById('estManagerEmail').value = '';
            document.getElementById('estManagerPhone').value = '';
            var idEl = document.getElementById('estClientId');
            if (idEl) idEl.value = '';
            var leadEl = document.getElementById('estLeadId');
            if (leadEl) leadEl.value = '';
            // Reset the lead-prefill banner — the form is being opened
            // standalone, not from a lead. createEstimateFromLead will
            // re-show it after this runs.
            window._estimateLeadPrefillSource = null;
            var banner = document.getElementById('estLeadPrefillBanner');
            if (banner) banner.style.display = 'none';
            // Populate the client picker from the directory cache so users
            // can auto-fill the form by selecting a client.
            if (typeof populateEstimateClientPicker === 'function') {
                populateEstimateClientPicker('estClientPicker', '');
            }
            openModal('newEstimateModal');
        }

        // Standard cost-side sections seeded into every new estimate so the
        // line-item table starts pre-organized to match Buildertrend's
        // proposal worksheet categories. The btCategory tag is what the
        // Phase C BT export will use to map each line into the correct
        // BT cost row (Subs / Materials / GC / Labor) and the Service &
        // Repair Income row (= total client price) is injected by the
        // export, not stored as a section.
        // Default per-section markup mirrors Project 86's typical pricing — see
        // estimate-editor.js for the rationale. Markup can be dialed per
        // job via the slider/number input on each section header.
        const ESTIMATE_STANDARD_SECTIONS = [
            { name: 'Materials & Supplies Costs', btCategory: 'materials', markup: 0 },
            { name: 'Direct Labor',               btCategory: 'labor',     markup: 0 },
            { name: 'General Conditions',         btCategory: 'gc',        markup: 0 },
            { name: 'Subcontractors Costs',       btCategory: 'sub',       markup: 0 }
        ];

        function createNewEstimate() {
            const estId = 'e' + Date.now();
            const defaultAlternateId = 'alt_default';
            // Scope no longer lives in the new-estimate modal — the user
            // adds it on the editor's right panel after creation. Keep the
            // safe lookup so legacy callers / the lead-prefill flow that
            // still has the field can pass through any seeded text.
            const scopeEl = document.getElementById('estScopeOfWork');
            const seededScope = scopeEl ? (scopeEl.value || '') : '';
            const est = {
                id: estId,
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
                scopeOfWork: seededScope,
                // Pre-wire alternates so the editor opens straight into the
                // standard structure without the migration shuffle. Scope is
                // per-alternate so Good/Better/Best can each carry their own.
                alternates: [{ id: defaultAlternateId, name: 'Base', isDefault: true, scope: seededScope }],
                activeAlternateId: defaultAlternateId
            };
            appData.estimates.push(est);
            // Seed the standard sections under the default alternate.
            ESTIMATE_STANDARD_SECTIONS.forEach(function(s, idx) {
                appData.estimateLines.push({
                    id: 's' + Date.now() + '_' + idx,
                    estimateId: estId,
                    alternateId: defaultAlternateId,
                    section: '__section_header__',
                    description: s.name,
                    btCategory: s.btCategory,
                    markup: s.markup
                });
            });
            saveData();
            closeModal('newEstimateModal');
            renderEstimatesList();
        }

        function editEstimate(estId) {
    // Block editor open while the initial server fetch is in-flight.
    // See openNewEstimateForm comment for rationale.
    if (typeof window.p86DataLoading === 'function' && window.p86DataLoading()) {
        alert('Still loading from server — try again in a moment.');
        return;
    }
    const estimate = appData.estimates.find(e => e.id === estId);
    if (!estimate) { alert('Estimate not found'); return; }
    currentEditEstimateId = estId;
    document.getElementById('editEst_title').value = estimate.title || '';
    document.getElementById('editEst_jobType').value = estimate.jobType || '';
    document.getElementById('editEst_client').value = estimate.client || '';
    document.getElementById('editEst_community').value = estimate.community || '';
    document.getElementById('editEst_propertyAddr').value = estimate.propertyAddr || '';
    document.getElementById('editEst_billingAddr').value = estimate.billingAddr || '';
    if (window.p86AddressAutocomplete) window.p86AddressAutocomplete.attachToField(document.getElementById('editEst_propertyAddr'), { placeholder: 'Search property address…' });
    document.getElementById('editEst_managerName').value = estimate.managerName || '';
    document.getElementById('editEst_managerEmail').value = estimate.managerEmail || '';
    document.getElementById('editEst_managerPhone').value = estimate.managerPhone || '';
    document.getElementById('editEst_scopeOfWork').value = estimate.scopeOfWork || '';
    var legacyMarkupEl = document.getElementById('editEst_defaultMarkup');
    if (legacyMarkupEl) legacyMarkupEl.value = estimate.defaultMarkup || 0;
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
            var go = (typeof window.p86Confirm === 'function')
              ? window.p86Confirm({
                  title: 'Delete estimate',
                  message: 'Delete this estimate? This cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true
                })
              : Promise.resolve(window.confirm('Delete this estimate?'));
            go.then(function(ok) {
              if (!ok) return;
              // Delete on the server first — bulk-save is upsert-only, so just
              // dropping from appData and re-saving leaves the row in Postgres
              // and it reappears on the next reload. Optimistically remove from
              // local state after the server confirms.
              function removeLocal() {
                  appData.estimates = appData.estimates.filter(e => e.id !== estId);
                  appData.estimateLines = appData.estimateLines.filter(l => l.estimateId !== estId);
                  saveData();
                  renderEstimatesList();
              }
              if (window.p86Api && window.p86Api.isAuthenticated()) {
                  window.p86Api.estimates.remove(estId)
                      .then(removeLocal)
                      .catch(function(err) {
                          if (err && err.status === 404) { removeLocal(); return; }
                          var msg = (err && err.message) ? err.message : 'unknown error';
                          if (typeof window.p86Alert === 'function') {
                            window.p86Alert({ title: 'Delete failed', message: msg });
                          } else {
                            alert('Delete failed: ' + msg);
                          }
                      });
              } else {
                  removeLocal();
              }
            });
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
    h += '<h1 style="margin:0 0 5px 0;font-size:24px;">Project 86 Central Florida</h1>';
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
    var legacyMarkupSaveEl = document.getElementById('editEst_defaultMarkup');
    if (legacyMarkupSaveEl) estimate.defaultMarkup = parseFloat(legacyMarkupSaveEl.value) || 0;
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
    // Numeric inputs use type="text" inputmode="decimal" (not
    // type="number"). The native number input has documented UX
    // problems: wheel-scroll silently changes the value mid-edit,
    // mobile Safari jumps the cursor when reformatting, step
    // validation rejects partial decimals like "12.", some browsers
    // strip leading zeros. inputmode="decimal" still triggers the
    // mobile numeric keypad. recalcEstimateTotals parses via parseFloat.
    row.innerHTML = '<td style="padding:8px;"><input type="text" data-field="description" value="' + escapeHTML(line.description || '') + '" placeholder="Item description" oninput="recalcEstimateTotals()" style="width:100%;"></td>' +
      '<td style="padding:8px;"><input type="text" inputmode="decimal" data-field="qty" value="' + (line.qty || 1) + '" oninput="recalcEstimateTotals()" style="width:100%;text-align:center;"></td>' +
      '<td style="padding:8px;"><select data-field="unit" style="width:100%;">' + unitOpts + '</select></td>' +
      '<td style="padding:8px;"><input type="text" inputmode="decimal" data-field="unitCost" value="' + (line.unitCost || 0) + '" oninput="recalcEstimateTotals()" style="width:100%;text-align:right;"></td>' +
      '<td style="padding:8px;"><input type="text" inputmode="decimal" data-field="markup" value="' + (line.markup || 0) + '" oninput="recalcEstimateTotals()" style="width:100%;text-align:center;"></td>' +
      '<td style="padding:8px;text-align:right;color:var(--green);font-weight:bold;"><span data-field="lineTotal">' + formatCurrency(client) + '</span></td>' +
      '<td style="padding:8px;text-align:center;"><button class="estimate-line-delete" onclick="removeEstimateLineRow(\'' + line.id + '\')">X</button></td>';
    return row;
    }

    