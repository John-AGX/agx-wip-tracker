function renderWIPMain() {
            renderJobsTable();
            calculateWIPSummary();
        }

        // Calculate sub costs from the Subcontractors tab entries
        function getSubCostForPhase(phaseId) {
            // Sum billedToDate of all subs assigned to this phase (supports multi-phase assignment)
            let total = 0;
            appData.subs.filter(s => s.level === 'phase').forEach(s => {
                var pIds = s.phaseIds || (s.phaseId ? [s.phaseId] : []);
                if (pIds.includes(phaseId)) {
                    total += (s.billedToDate || 0) / pIds.length; // split equally among assigned phases
                }
            });
            return total;
        }

        function getSubCostForBuilding(buildingId, jobId) {
            // 1. Subs assigned directly to this building (supports multi-building assignment)
            let total = 0;
            appData.subs.filter(s => s.level === 'building').forEach(s => {
                var bIds = s.buildingIds || (s.buildingId ? [s.buildingId] : []);
                if (bIds.includes(buildingId)) {
                    total += (s.billedToDate || 0) / bIds.length;
                }
            });
            // 2. Job-level subs distributed by building budget %
            const jobSubs = appData.subs.filter(s => s.level === 'job' && s.jobId === jobId);
            if (jobSubs.length > 0) {
                const thisBldg = appData.buildings.find(b => b.id === buildingId);
                // Skip if building is excluded from distribution
                if (thisBldg && thisBldg.excludeFromSubDist) return total;
                const buildings = appData.buildings.filter(b => b.jobId === jobId && !b.excludeFromSubDist);
                if (buildings.length === 0) return total;
                const totalBudget = buildings.reduce((sum, b) => sum + (b.budget || 0), 0);
                const jobSubTotal = jobSubs.reduce((sum, s) => sum + (s.billedToDate || 0), 0);
                if (totalBudget > 0) {
                    const bldgPct = (thisBldg?.budget || 0) / totalBudget;
                    total += jobSubTotal * bldgPct;
                } else {
                    // Equal distribution when no budgets set
                    total += jobSubTotal / buildings.length;
                }
            }
            return total;
        }

        function getSubCostForJob(jobId) {
            // All subs for this job, summed by billedToDate
            return appData.subs.filter(s => s.jobId === jobId)
                .reduce((sum, s) => sum + (s.billedToDate || 0), 0);
        }

        function getSubContractForPhase(phaseId) {
            let total = 0;
            appData.subs.filter(s => s.level === 'phase').forEach(s => {
                var pIds = s.phaseIds || (s.phaseId ? [s.phaseId] : []);
                if (pIds.includes(phaseId)) {
                    total += (s.contractAmt || 0) / pIds.length;
                }
            });
            return total;
        }

        function getSubContractForBuilding(buildingId, jobId) {
            let total = 0;
            appData.subs.filter(s => s.level === 'building').forEach(s => {
                var bIds = s.buildingIds || (s.buildingId ? [s.buildingId] : []);
                if (bIds.includes(buildingId)) {
                    total += (s.contractAmt || 0) / bIds.length;
                }
            });
            const jobSubs = appData.subs.filter(s => s.level === 'job' && s.jobId === jobId);
            if (jobSubs.length > 0) {
                const thisBldg = appData.buildings.find(b => b.id === buildingId);
                if (thisBldg && thisBldg.excludeFromSubDist) return total;
                const buildings = appData.buildings.filter(b => b.jobId === jobId && !b.excludeFromSubDist);
                if (buildings.length === 0) return total;
                const totalBudget = buildings.reduce((sum, b) => sum + (b.budget || 0), 0);
                const jobSubTotal = jobSubs.reduce((sum, s) => sum + (s.contractAmt || 0), 0);
                if (totalBudget > 0) {
                    const bldgPct = (thisBldg?.budget || 0) / totalBudget;
                    total += jobSubTotal * bldgPct;
                } else {
                    total += jobSubTotal / buildings.length;
                }
            }
            return total;
        }

        // Auto-calculate building % complete from its phases (weighted by phaseBudget)
        function calcBuildingPctComplete(buildingId, jobId) {
            const bldgPhases = appData.phases.filter(p => p.jobId === jobId && p.buildingId === buildingId);
            if (bldgPhases.length === 0) return 0;
            const totalBudget = bldgPhases.reduce((s, p) => s + (p.phaseBudget || 0), 0);
            if (totalBudget > 0) {
                return bldgPhases.reduce((s, p) => s + (p.pctComplete || 0) * (p.phaseBudget || 0), 0) / totalBudget;
            }
            // Equal weight if no budgets set
            return bldgPhases.reduce((s, p) => s + (p.pctComplete || 0), 0) / bldgPhases.length;
        }

        // Auto-calculate job % complete. Order of preference:
        //   1. Building-weighted (when buildings exist AND phases are linked to them)
        //   2. Phase-weighted directly (when phases exist but aren't all building-linked)
        //   3. Stored job.pctComplete as last-resort fallback
        // The middle case caught a real bug: jobs with buildings + unlinked
        // phases were rolling up to 0%, then overwriting the correct stored
        // value on every WIP main render because pctCompleteManual was false.
        function calcJobPctComplete(jobId) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const phases = appData.phases.filter(p => p.jobId === jobId);
            const linkedPhases = phases.filter(p => p.buildingId);

            // 1. Building-weighted, but only if phases are actually attached
            if (buildings.length > 0 && linkedPhases.length > 0) {
                const bldgData = buildings.map(b => ({
                    budget: b.budget || 0,
                    pct: calcBuildingPctComplete(b.id, jobId)
                }));
                const totalBudget = bldgData.reduce((s, d) => s + d.budget, 0);
                if (totalBudget > 0) {
                    return bldgData.reduce((s, d) => s + d.pct * d.budget, 0) / totalBudget;
                }
                return bldgData.reduce((s, d) => s + d.pct, 0) / bldgData.length;
            }

            // 2. Phase-weighted directly (covers both no-buildings and
            //    buildings-but-phases-not-linked cases)
            if (phases.length > 0) {
                const totalBudget = phases.reduce((s, p) => s + (p.phaseBudget || 0), 0);
                if (totalBudget > 0) {
                    return phases.reduce((s, p) => s + (p.pctComplete || 0) * (p.phaseBudget || 0), 0) / totalBudget;
                }
                return phases.reduce((s, p) => s + (p.pctComplete || 0), 0) / phases.length;
            }

            return appData.jobs.find(j => j.id === jobId)?.pctComplete || 0;
        }

        // Recalculate all sub $ fields on phases and buildings from subs entries
        function recalcSubCosts(jobId) {
            // Update phases
            appData.phases.filter(p => p.jobId === jobId).forEach(p => {
                p.sub = getSubCostForPhase(p.id);
            });
            // Update buildings
            appData.buildings.filter(b => b.jobId === jobId).forEach(b => {
                b.sub = getSubCostForBuilding(b.id, jobId);
            });
            // Update job-level sub cost
            const job = appData.jobs.find(j => j.id === jobId);
            if (job) {
                // Job-level sub = sum of all job-level subs' billedToDate
                job.sub = appData.subs.filter(s => s.level === 'job' && s.jobId === jobId)
                    .reduce((sum, s) => sum + (s.billedToDate || 0), 0);
            }
        }

        function getJobAccruedCosts(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (job && job.ngAccruedCosts != null) return job.ngAccruedCosts;

            // Fallback: % complete-weighted accrual from subs tab
            let totalAccrued = 0;
            const jobSubs = appData.subs.filter(s => s.jobId === jobId);

            jobSubs.forEach(sub => {
                let pctComplete = 0;
                var phaseIds = sub.phaseIds || (sub.phaseId ? [sub.phaseId] : []);
                var buildingIds = sub.buildingIds || (sub.buildingId ? [sub.buildingId] : []);

                if (sub.level === 'phase' && phaseIds.length > 0) {
                    let totalPct = 0;
                    phaseIds.forEach(pid => {
                        const phase = appData.phases.find(p => p.id === pid);
                        totalPct += phase ? (phase.pctComplete || 0) : 0;
                    });
                    pctComplete = totalPct / phaseIds.length;
                } else if (sub.level === 'building' && buildingIds.length > 0) {
                    let totalPct = 0;
                    buildingIds.forEach(bid => {
                        totalPct += calcBuildingPctComplete(bid, jobId);
                    });
                    pctComplete = totalPct / buildingIds.length;
                } else {
                    pctComplete = job ? (job.pctComplete || 0) : 0;
                }

                const earned = (sub.contractAmt || 0) * (pctComplete / 100);
                const accrued = Math.max(0, earned - (sub.billedToDate || 0));
                totalAccrued += accrued;
            });

            return totalAccrued;
        }

        function getJobTotalCost(jobId) {
            // Phase-level costs (tracked per phase)
            let phaseCost = 0;
            appData.phases.filter(p => p.jobId === jobId).forEach(p => {
                phaseCost += (p.materials || 0) + (p.labor || 0) + (p.sub || 0) + (p.equipment || 0);
            });
            // Building-level direct costs (overhead/general NOT covered by phases).
            // Node graph writes costs wired directly to T1 here; costs wired to T2 go to phases.
            let buildingCost = 0;
            const jobBuildings = appData.buildings.filter(b => b.jobId === jobId);
            jobBuildings.forEach(b => {
                buildingCost += (b.materials || 0) + (b.labor || 0) + (b.sub || 0) + (b.equipment || 0);
            });
            // Job-level costs (exclude sub if buildings exist — already distributed)
            const job = appData.jobs.find(j => j.id === jobId);
            let jobCost = 0;
            if (job) {
                const jobSub = (jobBuildings.length > 0) ? 0 : (job.sub || 0);
                jobCost = (job.materials || 0) + (job.labor || 0) + jobSub + (job.equipment || 0) + (job.generalConditions || 0);
            }
            return { phaseCost, buildingCost, jobCost, total: phaseCost + buildingCost + jobCost };
        }

        // ==================== WIP CALCULATIONS ====================
        function getJobCOTotals(jobId) {
            const cos = appData.changeOrders.filter(co => co.jobId === jobId);
            return {
                income: cos.reduce((sum, co) => sum + (co.income || 0), 0),
                costs: cos.reduce((sum, co) => sum + (co.estimatedCosts || 0), 0),
                count: cos.length
            };
        }

        function getJobWIP(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return {};
            const co = getJobCOTotals(jobId);
            const actualCosts = (job.ngActualCosts != null) ? job.ngActualCosts : getJobTotalCost(jobId).total;
            const contractIncome = job.contractAmount || 0;
            const estimatedCosts = job.estimatedCosts || 0;
            const totalIncome = contractIncome + co.income;
            const totalEstCosts = estimatedCosts + co.costs;
            const revisedCostChanges = job.revisedCostChanges || 0;
            const revisedEstCosts = totalEstCosts + revisedCostChanges;
            const asSoldProfit = contractIncome - estimatedCosts;
            const asSoldMargin = contractIncome > 0 ? (asSoldProfit / contractIncome * 100) : 0;
            // "Revised" profit/margin = the as-sold + change-orders plan
            // (income vs revised cost). Distinct from JTD.
            const revisedProfit = totalIncome - revisedEstCosts;
            const revisedMargin = totalIncome > 0 ? (revisedProfit / totalIncome * 100) : 0;
            const pctComplete = job.pctComplete || 0;
            // Prefer the engine's computed values when the node graph has
            // already pushed them — they use unrounded weighted pct and
            // match the watch-node displays. Fall back to local formula
            // when the graph hasn't run yet (job has no graph state).
            const revenueEarned = (job.ngRevenueEarned != null)
                ? job.ngRevenueEarned
                : totalIncome * (pctComplete / 100);
            const jtdProfit = (job.ngJtdProfit != null)
                ? job.ngJtdProfit
                : revenueEarned - actualCosts;
            const jtdMargin = (job.ngJtdMargin != null)
                ? job.ngJtdMargin
                : (revenueEarned > 0 ? (jtdProfit / revenueEarned * 100) : 0);
            const invoiced = job.invoicedToDate || 0;
            const unbilled = revenueEarned - invoiced;
            const backlog = (job.ngBacklog != null)
                ? job.ngBacklog
                : totalIncome - revenueEarned;
            const remainingCosts = revisedEstCosts - actualCosts;
            return {
                contractIncome, estimatedCosts, coIncome: co.income, coCosts: co.costs,
                totalIncome, totalEstCosts, revisedCostChanges, revisedEstCosts,
                asSoldProfit, asSoldMargin, revisedProfit, revisedMargin,
                pctComplete, revenueEarned, actualCosts, jtdProfit, jtdMargin,
                invoiced, unbilled, backlog, remainingCosts
            };
        }

        function renderWipTab(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            const w = getJobWIP(jobId);
            document.getElementById('wipPctComplete').value = job.pctComplete || '';
            document.getElementById('wipPctManual').checked = job.pctCompleteManual || false;
            document.getElementById('wipInvoicedToDate').value = job.invoicedToDate || '';
            document.getElementById('wipRevisedCostChanges').value = job.revisedCostChanges || '';
            document.getElementById('wipNotes').value = job.notes || '';

            document.getElementById('wip-contract-income').textContent = formatCurrency(w.contractIncome);
            document.getElementById('wip-co-income').textContent = formatCurrency(w.coIncome);
            document.getElementById('wip-total-income').textContent = formatCurrency(w.totalIncome);
            document.getElementById('wip-est-costs').textContent = formatCurrency(w.estimatedCosts);
            document.getElementById('wip-co-costs').textContent = formatCurrency(w.coCosts);
            document.getElementById('wip-revised-changes').textContent = formatCurrency(w.revisedCostChanges);
            document.getElementById('wip-total-est-costs').textContent = formatCurrency(w.revisedEstCosts);
            document.getElementById('wip-assold-profit').textContent = formatCurrency(w.asSoldProfit);
            document.getElementById('wip-assold-profit').style.color = w.asSoldProfit >= 0 ? 'var(--green)' : 'var(--red)';
            document.getElementById('wip-assold-margin').textContent = w.asSoldMargin.toFixed(1) + '%';
            document.getElementById('wip-revised-profit').textContent = formatCurrency(w.revisedProfit);
            document.getElementById('wip-revised-profit').style.color = w.revisedProfit >= 0 ? 'var(--green)' : 'var(--red)';
            document.getElementById('wip-revised-margin').textContent = w.revisedMargin.toFixed(1) + '%';
            document.getElementById('wip-pct-complete').textContent = w.pctComplete.toFixed(1) + '%';
            document.getElementById('wip-revenue-earned').textContent = formatCurrency(w.revenueEarned);
            document.getElementById('wip-jtd-profit').textContent = formatCurrency(w.jtdProfit);
            document.getElementById('wip-jtd-profit').style.color = w.jtdProfit >= 0 ? 'var(--green)' : 'var(--red)';
            document.getElementById('wip-jtd-margin').textContent = w.jtdMargin.toFixed(1) + '%';
            document.getElementById('wip-invoiced').textContent = formatCurrency(w.invoiced);
            document.getElementById('wip-unbilled').textContent = formatCurrency(w.unbilled);
            document.getElementById('wip-unbilled').style.color = w.unbilled >= 0 ? 'var(--yellow)' : 'var(--red)';
            document.getElementById('wip-backlog').textContent = formatCurrency(w.backlog);
            document.getElementById('wip-actual-costs').textContent = formatCurrency(w.actualCosts);
            document.getElementById('wip-revised-est-costs2').textContent = formatCurrency(w.revisedEstCosts);
            document.getElementById('wip-remaining-costs').textContent = formatCurrency(w.remainingCosts);
            document.getElementById('wip-remaining-costs').style.color = w.remainingCosts >= 0 ? 'var(--text)' : 'var(--red)';
        }

        function saveWipInputs() {
            const job = appData.jobs.find(j => j.id === appState.currentJobId);
            if (!job) return;
            const newPct = parseFloat(document.getElementById('wipPctComplete').value) || 0;
            const isManual = document.getElementById('wipPctManual').checked;
            job.pctCompleteManual = isManual;

            // If manual override and % increased, auto-distribute to buildings/phases
            if (isManual && newPct > (job.pctComplete || 0)) {
                distributeJobPctComplete(appState.currentJobId, newPct);
            }

            job.pctComplete = newPct;
            job.invoicedToDate = parseFloat(document.getElementById('wipInvoicedToDate').value) || 0;
            job.revisedCostChanges = parseFloat(document.getElementById('wipRevisedCostChanges').value) || 0;
            job.notes = document.getElementById('wipNotes').value.trim();
            job.updatedAt = new Date().toISOString();
            saveData();
            renderJobDetail(appState.currentJobId);
        }

        /** Distribute job-level % complete down to buildings and phases proportionally */
        function distributeJobPctComplete(jobId, targetPct) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const phases = appData.phases.filter(p => p.jobId === jobId);

            if (buildings.length > 0) {
                // Distribute to buildings, then each building distributes to its phases
                buildings.forEach(b => {
                    const bldgPhases = phases.filter(p => p.buildingId === b.id);
                    if (bldgPhases.length > 0) {
                        bldgPhases.forEach(p => {
                            p.pctComplete = Math.min(100, Math.max(p.pctComplete || 0, targetPct));
                        });
                    }
                });
            } else if (phases.length > 0) {
                phases.forEach(p => {
                    p.pctComplete = Math.min(100, Math.max(p.pctComplete || 0, targetPct));
                });
            }
        }

        // ==================== CHANGE ORDERS ====================
        // ── CO Allocation Helpers ──
        function getCOAllocations(co) {
            if (co.allocations) return co.allocations;
            if (co.buildingAllocations && co.buildingAllocations.length > 0) {
                return co.buildingAllocations.map(a => ({ buildingId: a.buildingId, income: a.amount || 0, costs: 0 }));
            }
            return [];
        }

        function reverseCOBudgetImpact(co) {
            var allocs = getCOAllocations(co);
            var level = co.allocationType || (allocs.length > 0 ? 'building' : 'job');
            allocs.forEach(function(alloc) {
                if (level === 'phase' && alloc.phaseId) {
                    var phase = appData.phases.find(p => p.id === alloc.phaseId);
                    if (phase) phase.phaseBudget = (phase.phaseBudget || 0) - (alloc.income || 0);
                }
                if ((level === 'building' || level === 'phase') && alloc.buildingId) {
                    var bldg = appData.buildings.find(b => b.id === alloc.buildingId);
                    if (bldg) bldg.budget = (bldg.budget || 0) - (alloc.income || 0);
                }
            });
        }

        function applyCOBudgetImpact(co) {
            var allocs = getCOAllocations(co);
            var level = co.allocationType || 'job';
            allocs.forEach(function(alloc) {
                if (level === 'phase' && alloc.phaseId) {
                    var phase = appData.phases.find(p => p.id === alloc.phaseId);
                    if (phase) phase.phaseBudget = (phase.phaseBudget || 0) + (alloc.income || 0);
                }
                if ((level === 'building' || level === 'phase') && alloc.buildingId) {
                    var bldg = appData.buildings.find(b => b.id === alloc.buildingId);
                    if (bldg) bldg.budget = (bldg.budget || 0) + (alloc.income || 0);
                }
            });
        }

        // ── CO Modal Functions ──
        function openAddChangeOrderModal() {
            document.getElementById('coModalHeader').textContent = 'Add Change Order';
            document.getElementById('coSaveBtn').innerHTML = '&#x1F4DD; Add Change Order';
            document.getElementById('coNumber').value = '';
            document.getElementById('coDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('coDescription').value = '';
            document.getElementById('coIncome').value = '';
            document.getElementById('coCosts').value = '';
            document.getElementById('coNotes').value = '';
            appState.editCOId = null;
            openModal('addCOModal');
        }

        function saveCO() {
            const desc = document.getElementById('coDescription').value.trim();
            if (!desc) { alert('Enter a description'); return; }
            const coData = {
                jobId: appState.currentJobId,
                coNumber: document.getElementById('coNumber').value.trim(),
                description: desc,
                income: parseFloat(document.getElementById('coIncome').value) || 0,
                estimatedCosts: parseFloat(document.getElementById('coCosts').value) || 0,
                date: document.getElementById('coDate').value,
                notes: document.getElementById('coNotes').value.trim(),
                allocationType: 'job',
                allocations: []
            };
            // Reverse old budget impact when editing
            if (appState.editCOId) {
                var oldCO = appData.changeOrders.find(co => co.id === appState.editCOId);
                if (oldCO) reverseCOBudgetImpact(oldCO);
                const idx = appData.changeOrders.findIndex(co => co.id === appState.editCOId);
                if (idx >= 0) Object.assign(appData.changeOrders[idx], coData);
            } else {
                coData.id = 'co' + Date.now();
                appData.changeOrders.push(coData);
            }
            // Apply new budget impact
            applyCOBudgetImpact(coData);
            saveData();
            closeModal('addCOModal');
            renderJobDetail(appState.currentJobId);
        }

        function editCO(coId) {
            const co = appData.changeOrders.find(c => c.id === coId);
            if (!co) return;
            appState.editCOId = coId;
            document.getElementById('coModalHeader').textContent = 'Edit Change Order';
            document.getElementById('coSaveBtn').innerHTML = '&#x1F4BE; Update Change Order';
            document.getElementById('coNumber').value = co.coNumber || '';
            document.getElementById('coDate').value = co.date || '';
            document.getElementById('coDescription').value = co.description || '';
            document.getElementById('coIncome').value = co.income || '';
            document.getElementById('coCosts').value = co.estimatedCosts || '';
            document.getElementById('coNotes').value = co.notes || '';
            openModal('addCOModal');
        }

        function deleteCO(coId) {
            if (!confirm('Delete this change order?')) return;
            var co = appData.changeOrders.find(c => c.id === coId);
            if (co) reverseCOBudgetImpact(co);
            appData.changeOrders = appData.changeOrders.filter(c => c.id !== coId);
            saveData();
            renderJobDetail(appState.currentJobId);
        }

        function renderChangeOrders(jobId) {
            const cos = appData.changeOrders.filter(co => co.jobId === jobId);
            const tbody = document.querySelector('#co-table tbody');
            tbody.innerHTML = '';
            let totalInc = 0, totalCost = 0;
            cos.forEach((co, idx) => {
                const profit = (co.income || 0) - (co.estimatedCosts || 0);
                totalInc += co.income || 0;
                totalCost += co.estimatedCosts || 0;
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHTML(co.coNumber) || 'CO-' + (idx + 1)}</td>
                    <td>${escapeHTML(co.description)}${co.notes ? '<br><span style="font-size: 11px; color: var(--text-dim);">' + escapeHTML(co.notes) + '</span>' : ''}</td>
                    <td style="text-align: right;">${formatCurrency(co.income)}</td>
                    <td style="text-align: right;">${formatCurrency(co.estimatedCosts)}</td>
                    <td style="text-align: right; color: ${profit >= 0 ? 'var(--green)' : 'var(--red)'};">${formatCurrency(profit)}</td>
                    <td>${escapeHTML(co.date) || '—'}</td>
                    <td>
                        <button class="ee-btn secondary" onclick="event.stopPropagation(); editCO('${escapeHTML(co.id)}')">&#x270F;&#xFE0F; Edit</button>
                        <button class="ee-btn ee-icon-btn danger" onclick="event.stopPropagation(); deleteCO('${escapeHTML(co.id)}')" title="Delete">&#x1F5D1;</button>
                    </td>`;
                tbody.appendChild(row);
            });
            document.getElementById('co-total-income').textContent = formatCurrency(totalInc);
            document.getElementById('co-total-costs').textContent = formatCurrency(totalCost);
            document.getElementById('co-total-profit').textContent = formatCurrency(totalInc - totalCost);
            document.getElementById('co-total-profit').style.color = (totalInc - totalCost) >= 0 ? 'var(--green)' : 'var(--red)';
        }

        // ==================== PURCHASE ORDERS ====================
        function getJobPOTotals(jobId) {
            const pos = appData.purchaseOrders.filter(po => po.jobId === jobId);
            return {
                amount: pos.reduce((sum, po) => sum + (po.amount || 0), 0),
                billed: pos.reduce((sum, po) => sum + (po.billedToDate || 0), 0),
                count: pos.length
            };
        }

        // Populate the <datalist> the poVendor input reads from with
        // every active sub in appData.subsDirectory. Called every time
        // the modal opens (Add or Edit) so newly-added subs show up
        // without a page reload.
        function populatePOVendorDatalist() {
            var dl = document.getElementById('poVendorSubsList');
            if (!dl) return;
            var subs = (appData && Array.isArray(appData.subsDirectory))
                ? appData.subsDirectory.filter(function(s) {
                    return (s.status || 'active') !== 'closed';
                  })
                : [];
            subs.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
            dl.innerHTML = subs.map(function(s) {
                // value is what gets typed into the input on selection;
                // label hint surfaces trade if present so duplicates
                // (e.g. two "Smith Drywall" companies) are distinguishable.
                var hint = s.trade ? ' · ' + s.trade : '';
                return '<option value="' + escapeHTML(s.name || '') + '">' +
                       escapeHTML((s.name || '') + hint) + '</option>';
            }).join('');
        }

        function openAddPOModal() {
            document.getElementById('poModalHeader').textContent = 'Add Purchase Order';
            document.getElementById('poSaveBtn').innerHTML = '&#x1F4C4; Add Purchase Order';
            document.getElementById('poNumber').value = '';
            document.getElementById('poDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('poVendor').value = '';
            document.getElementById('poDescription').value = '';
            document.getElementById('poAmount').value = '';
            document.getElementById('poBilled').value = '';
            document.getElementById('poStatus').value = 'Open';
            document.getElementById('poNotes').value = '';
            appState.editPOId = null;
            populatePOVendorDatalist();
            openModal('addPOModal');
        }

        function savePO() {
            const vendor = document.getElementById('poVendor').value.trim();
            if (!vendor) { alert('Enter a vendor name'); return; }
            // Resolve the typed/selected vendor name back to a directory
            // id so the PO record links into the canonical subs dataset.
            // Match is case-insensitive so the user doesn't have to nail
            // the exact casing the directory stores.
            var matchedSubId = null;
            try {
                var dir = (appData && Array.isArray(appData.subsDirectory)) ? appData.subsDirectory : [];
                var lower = vendor.toLowerCase();
                var match = dir.find(function(s) { return (s.name || '').toLowerCase() === lower; });
                if (match) matchedSubId = match.id;
            } catch (e) { /* defensive */ }
            const poData = {
                jobId: appState.currentJobId,
                poNumber: document.getElementById('poNumber').value.trim(),
                vendor: vendor,
                subId: matchedSubId,
                description: document.getElementById('poDescription').value.trim(),
                amount: parseFloat(document.getElementById('poAmount').value) || 0,
                billedToDate: parseFloat(document.getElementById('poBilled').value) || 0,
                date: document.getElementById('poDate').value,
                status: document.getElementById('poStatus').value,
                notes: document.getElementById('poNotes').value.trim()
            };
            if (appState.editPOId) {
                const idx = appData.purchaseOrders.findIndex(po => po.id === appState.editPOId);
                if (idx >= 0) Object.assign(appData.purchaseOrders[idx], poData);
            } else {
                poData.id = 'po' + Date.now();
                appData.purchaseOrders.push(poData);
            }
            saveData();
            closeModal('addPOModal');
            renderJobDetail(appState.currentJobId);
        }

        function editPO(poId) {
            const po = appData.purchaseOrders.find(p => p.id === poId);
            if (!po) return;
            appState.editPOId = poId;
            document.getElementById('poModalHeader').textContent = 'Edit Purchase Order';
            document.getElementById('poSaveBtn').innerHTML = '&#x1F4BE; Update Purchase Order';
            document.getElementById('poNumber').value = po.poNumber || '';
            document.getElementById('poDate').value = po.date || '';
            document.getElementById('poVendor').value = po.vendor || '';
            document.getElementById('poDescription').value = po.description || '';
            document.getElementById('poAmount').value = po.amount || '';
            document.getElementById('poBilled').value = po.billedToDate || '';
            document.getElementById('poStatus').value = po.status || 'Open';
            document.getElementById('poNotes').value = po.notes || '';
            populatePOVendorDatalist();
            openModal('addPOModal');
        }

        function deletePO(poId) {
            if (!confirm('Delete this purchase order?')) return;
            appData.purchaseOrders = appData.purchaseOrders.filter(p => p.id !== poId);
            saveData();
            renderJobDetail(appState.currentJobId);
        }

        function renderPurchaseOrders(jobId) {
            const pos = appData.purchaseOrders.filter(po => po.jobId === jobId);
            const tbody = document.querySelector('#po-table tbody');
            tbody.innerHTML = '';
            let totalAmt = 0, totalBilled = 0;
            pos.forEach((po, idx) => {
                const remaining = (po.amount || 0) - (po.billedToDate || 0);
                totalAmt += po.amount || 0;
                totalBilled += po.billedToDate || 0;
                const statusColor = po.status === 'Closed' ? 'var(--green)' : po.status === 'Partial' ? 'var(--yellow)' : 'var(--accent)';
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHTML(po.poNumber) || 'PO-' + (idx + 1)}</td>
                    <td>${escapeHTML(po.vendor)}</td>
                    <td>${escapeHTML(po.description)}${po.notes ? '<br><span style="font-size: 11px; color: var(--text-dim);">' + escapeHTML(po.notes) + '</span>' : ''}</td>
                    <td style="text-align: right;">${formatCurrency(po.amount)}</td>
                    <td style="text-align: right;">${formatCurrency(po.billedToDate)}</td>
                    <td style="text-align: right; color: ${remaining > 0 ? 'var(--yellow)' : 'var(--green)'};">${formatCurrency(remaining)}</td>
                    <td><span style="color: ${statusColor}; font-weight: 600; font-size: 12px;">${escapeHTML(po.status)}</span></td>
                    <td>${escapeHTML(po.date) || '—'}</td>
                    <td>
                        <button class="ee-btn secondary" onclick="event.stopPropagation(); editPO('${escapeHTML(po.id)}')">&#x270F;&#xFE0F; Edit</button>
                        <button class="ee-btn ee-icon-btn danger" onclick="event.stopPropagation(); deletePO('${escapeHTML(po.id)}')" title="Delete">&#x1F5D1;</button>
                    </td>`;
                tbody.appendChild(row);
            });
            document.getElementById('po-total-amount').textContent = formatCurrency(totalAmt);
            document.getElementById('po-total-billed').textContent = formatCurrency(totalBilled);
            document.getElementById('po-total-remaining').textContent = formatCurrency(totalAmt - totalBilled);
            document.getElementById('po-total-remaining').style.color = (totalAmt - totalBilled) > 0 ? 'var(--yellow)' : 'var(--green)';
        }

        // ==================== INVOICES ====================
        function getJobInvTotals(jobId) {
            const invs = appData.invoices.filter(inv => inv.jobId === jobId);
            return {
                amount: invs.reduce((sum, inv) => sum + (inv.amount || 0), 0),
                paid: invs.filter(inv => inv.status === 'Paid').reduce((sum, inv) => sum + (inv.amount || 0), 0),
                count: invs.length
            };
        }

        function openAddInvoiceModal() {
            document.getElementById('invModalHeader').textContent = 'Add Invoice';
            document.getElementById('invSaveBtn').innerHTML = '&#x1F4B3; Add Invoice';
            document.getElementById('invNumber').value = '';
            document.getElementById('invDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('invDueDate').value = '';
            document.getElementById('invVendor').value = '';
            document.getElementById('invDescription').value = '';
            document.getElementById('invAmount').value = '';
            document.getElementById('invStatus').value = 'Draft';
            document.getElementById('invNotes').value = '';
            appState.editInvId = null;
            openModal('addInvModal');
        }

        function saveInvoice() {
            const vendor = document.getElementById('invVendor').value.trim();
            if (!vendor) { alert('Enter a vendor name'); return; }
            const invData = {
                jobId: appState.currentJobId,
                invNumber: document.getElementById('invNumber').value.trim(),
                vendor: vendor,
                description: document.getElementById('invDescription').value.trim(),
                amount: parseFloat(document.getElementById('invAmount').value) || 0,
                date: document.getElementById('invDate').value,
                dueDate: document.getElementById('invDueDate').value,
                status: document.getElementById('invStatus').value,
                notes: document.getElementById('invNotes').value.trim()
            };
            if (appState.editInvId) {
                const idx = appData.invoices.findIndex(inv => inv.id === appState.editInvId);
                if (idx >= 0) Object.assign(appData.invoices[idx], invData);
            } else {
                invData.id = 'inv' + Date.now();
                appData.invoices.push(invData);
            }
            saveData();
            closeModal('addInvModal');
            renderJobDetail(appState.currentJobId);
        }

        function editInvoice(invId) {
            const inv = appData.invoices.find(i => i.id === invId);
            if (!inv) return;
            appState.editInvId = invId;
            document.getElementById('invModalHeader').textContent = 'Edit Invoice';
            document.getElementById('invSaveBtn').innerHTML = '&#x1F4BE; Update Invoice';
            document.getElementById('invNumber').value = inv.invNumber || '';
            document.getElementById('invDate').value = inv.date || '';
            document.getElementById('invDueDate').value = inv.dueDate || '';
            document.getElementById('invVendor').value = inv.vendor || '';
            document.getElementById('invDescription').value = inv.description || '';
            document.getElementById('invAmount').value = inv.amount || '';
            document.getElementById('invStatus').value = inv.status || 'Draft';
            document.getElementById('invNotes').value = inv.notes || '';
            openModal('addInvModal');
        }

        function deleteInvoice(invId) {
            if (!confirm('Delete this invoice?')) return;
            appData.invoices = appData.invoices.filter(i => i.id !== invId);
            saveData();
            renderJobDetail(appState.currentJobId);
        }

        function renderInvoices(jobId) {
            const invs = appData.invoices.filter(inv => inv.jobId === jobId);
            const tbody = document.querySelector('#inv-table tbody');
            tbody.innerHTML = '';
            let totalAmt = 0;
            invs.forEach((inv, idx) => {
                totalAmt += inv.amount || 0;
                const statusColor = inv.status === 'Paid' ? 'var(--green)' : inv.status === 'Sent' ? 'var(--yellow)' : 'var(--text-dim)';
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHTML(inv.invNumber) || 'INV-' + (idx + 1)}</td>
                    <td>${escapeHTML(inv.vendor)}</td>
                    <td>${escapeHTML(inv.description)}${inv.notes ? '<br><span style="font-size: 11px; color: var(--text-dim);">' + escapeHTML(inv.notes) + '</span>' : ''}</td>
                    <td style="text-align: right;">${formatCurrency(inv.amount)}</td>
                    <td><span style="color: ${statusColor}; font-weight: 600; font-size: 12px;">${escapeHTML(inv.status)}</span></td>
                    <td>${escapeHTML(inv.date) || '—'}</td>
                    <td>${escapeHTML(inv.dueDate) || '—'}</td>
                    <td>
                        <button class="ee-btn secondary" onclick="event.stopPropagation(); editInvoice('${escapeHTML(inv.id)}')">&#x270F;&#xFE0F; Edit</button>
                        <button class="ee-btn ee-icon-btn danger" onclick="event.stopPropagation(); deleteInvoice('${escapeHTML(inv.id)}')" title="Delete">&#x1F5D1;</button>
                    </td>`;
                tbody.appendChild(row);
            });
            document.getElementById('inv-total-amount').textContent = formatCurrency(totalAmt);
        }

        function calculateWIPSummary() {
            let totalIncome = 0;
            let totalCost = 0;
            let activeJobs = appData.jobs.filter(j => ['New', 'In Progress', 'On Hold'].includes(j.status)).length;

            appData.jobs.forEach(j => {
                const w = getJobWIP(j.id);
                totalIncome += w.totalIncome;
                totalCost += w.actualCosts;
            });

            let totalProfit = totalIncome - totalCost;

            document.getElementById('total-pipeline').textContent = formatCurrency(totalIncome);
            document.getElementById('active-jobs').textContent = activeJobs;
            document.getElementById('total-cost').textContent = formatCurrency(totalCost);
            document.getElementById('total-profit').textContent = formatCurrency(totalProfit);
        }

        function getJobType(jobNumber) {
            if (!jobNumber) return '';
            const num = jobNumber.toUpperCase().trim();
            if (num.startsWith('RV')) return 'RV';
            if (num.startsWith('WO')) return 'WO';
            if (num.startsWith('S')) return 'S';
            return '';
        }

        function getJobTypeLabel(type) {
            if (type === 'S') return 'Service';
            if (type === 'RV') return 'Renovation';
            if (type === 'WO') return 'Work Order';
            return '';
        }

        function renderJobsTable() {
            const tbody = document.querySelector('#jobs-table tbody');
            tbody.innerHTML = '';

            let jobs = appData.jobs;
            const filter = appState.currentStatusFilter;
            if (filter) {
                jobs = jobs.filter(j => j.status === filter);
            } else {
                // "All Active" = hide Archived by default
                jobs = jobs.filter(j => j.status !== 'Archived');
            }

            // Apply type filter
            const typeFilter = appState.currentTypeFilter;
            if (typeFilter) {
                jobs = jobs.filter(j => (j.jobType || getJobTypeLabel(getJobType(j.jobNumber))) === typeFilter);
            }

            // Apply sorting
            if (appState.sortColumn) {
                const col = appState.sortColumn;
                const dir = appState.sortDirection === 'asc' ? 1 : -1;
                jobs = [...jobs].sort((a, b) => {
                    let va, vb;
                    switch(col) {
                        case 'name':
                            va = ((a.jobNumber || '') + ' ' + (a.title || '')).toLowerCase();
                            vb = ((b.jobNumber || '') + ' ' + (b.title || '')).toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'market':
                            va = (a.market || '').toLowerCase();
                            vb = (b.market || '').toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'status':
                            va = (a.status || '').toLowerCase();
                            vb = (b.status || '').toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'client':
                            va = (a.client || '').toLowerCase();
                            vb = (b.client || '').toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'pm':
                            va = (a.pm || '').toLowerCase();
                            vb = (b.pm || '').toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'contract':
                            return (getJobWIP(a.id).totalIncome - getJobWIP(b.id).totalIncome) * dir;
                        case 'pctcomplete':
                            return ((a.pctComplete || 0) - (b.pctComplete || 0)) * dir;
                        case 'profit':
                            return (getJobWIP(a.id).jtdProfit - getJobWIP(b.id).jtdProfit) * dir;
                        case 'margin':
                            return (getJobWIP(a.id).jtdMargin - getJobWIP(b.id).jtdMargin) * dir;
                        default:
                            return 0;
                    }
                });
            }

            // Update sort indicator classes on headers
            document.querySelectorAll('#jobs-table th.sortable').forEach(th => {
                th.classList.remove('sort-asc', 'sort-desc');
                if (th.dataset.sort === appState.sortColumn) {
                    th.classList.add(appState.sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
                }
            });

            jobs.forEach((job, index) => {
                // The WIP main row used to auto-recalc pctComplete here, but
                // that runs without the node-graph compute step the detail
                // view uses, so it produced different values than the metric
                // strip and would clobber the correct stored value. Now we
                // just read what's stored — the detail view (renderJobDetail)
                // is the single source of truth for keeping job.pctComplete
                // fresh. recalcSubCosts is still cheap and useful here for
                // dollar columns.
                if (appData.phases.some(p => p.jobId === job.id) || appData.buildings.some(b => b.jobId === job.id)) {
                    recalcSubCosts(job.id);
                }
                const w = getJobWIP(job.id);
                const statusClass = job.status === 'On Hold' ? 'at-risk' : job.status === 'Completed' ? 'on-track' : job.status === 'Archived' ? 'not-started' : 'on-track';
                const typeLabel = job.jobType ? `<span style="font-size: 11px; color: var(--text-dim); font-weight: normal; margin-left: 6px;">${escapeHTML(job.jobType)}${job.market ? ' - ' + escapeHTML(job.market) : ''}</span>` : '';

                const row = document.createElement('tr');
                row.style.cursor = 'pointer';
                row.onclick = function() { editJob(job.id); };
                // Subtle read-only indicator for PMs viewing jobs they don't own.
                // The row is still clickable (they can view detail), just visually muted.
                var readOnly = job._canEdit === false;
                if (readOnly) {
                    row.style.opacity = '0.6';
                    row.title = 'View only — assigned to ' + (job.pm || 'another PM');
                }
                var pmCell = escapeHTML(getJobOwnerName(job));
                if (readOnly) pmCell += ' <span style="font-size:9px;color:var(--text-dim,#888);margin-left:4px;">view only</span>';
                row.innerHTML = `
                    <td>${index + 1}</td>
                    <td><strong>${job.jobNumber ? escapeHTML(job.jobNumber) + ' — ' : ''}${escapeHTML(job.title)}</strong>${typeLabel}</td>
                    <td>${escapeHTML(job.client) || '—'}</td>
                    <td>${pmCell}</td>
                    <td><span class="badge ${statusClass}">${escapeHTML(job.status)}</span></td>
                    <td style="text-align: right;">${formatCurrency(w.totalIncome)}</td>
                    <td style="text-align: right;"><div class="progress-bar" style="margin-bottom: 2px; height: 6px;"><div class="progress-fill" style="width: ${w.pctComplete}%"></div></div><span style="font-size: 12px;">${w.pctComplete.toFixed(1)}%</span></td>
                    <td style="text-align: right; color: ${w.jtdProfit >= 0 ? 'var(--green)' : 'var(--red)'};">${formatCurrency(w.jtdProfit)}</td>
                    <td style="text-align: right;">${w.jtdMargin.toFixed(1)}%</td>
                `;
                tbody.appendChild(row);
            });
        }

        function sortJobsTable(column) {
            if (appState.sortColumn === column) {
                // Toggle direction, or clear if already desc
                if (appState.sortDirection === 'asc') {
                    appState.sortDirection = 'desc';
                } else {
                    appState.sortColumn = null;
                    appState.sortDirection = null;
                }
            } else {
                appState.sortColumn = column;
                appState.sortDirection = 'asc';
            }
            renderJobsTable();
        }

        function filterJobs() {
            appState.currentStatusFilter = document.getElementById('statusFilter').value;
            appState.currentTypeFilter = document.getElementById('typeFilter').value;
            renderJobsTable();
        }

        function openAddJobModal() {
            document.getElementById('jobNumber').value = '';
            document.getElementById('jobTitle').value = '';
            document.getElementById('jobClient').value = '';
            document.getElementById('jobType').value = '';
            document.getElementById('jobWorkType').value = '';
            document.getElementById('jobMarket').value = '';
            document.getElementById('jobContractAmount').value = '';
            document.getElementById('jobEstimatedCosts').value = '';
            document.getElementById('jobTargetMargin').value = '50';
            // Schedule page reads totalProductionDays for daily-revenue math.
            var prodDaysEl = document.getElementById('jobTotalProductionDays');
            if (prodDaysEl) prodDaysEl.value = '';
            document.getElementById('jobStatus').value = 'New';
            document.getElementById('jobNotes').value = '';
            populateJobPMSelect();
            openModal('addJobModal');
        }

        // Populate the PM <select> from cached users when authenticated. For admins,
        // any active PM/admin can be assigned. For PMs themselves, lock the field
        // to their own user. Falls back to the legacy hardcoded list when offline.
        function populateJobPMSelect() {
            var sel = document.getElementById('jobPM');
            if (!sel) return;
            var auth = window.agxAuth;
            var admin = window.agxAdmin;
            if (!auth || auth.isOffline() || !admin) {
                // Legacy / offline mode — keep the static dropdown as-is
                sel.value = '';
                sel.disabled = false;
                return;
            }
            var me = auth.getUser();
            var users = admin.getActivePMs();
            // If the cache hasn't loaded yet, kick off a refresh and at least seed self
            if (!users.length && me) {
                users = [{ id: me.id, name: me.name, role: me.role, active: true }];
                if (admin.refreshUsers) admin.refreshUsers();
            }
            var html = '<option value="">-- Select PM --</option>';
            users.forEach(function(u) {
                html += '<option value="' + u.id + '" data-name="' + escapeHTML(u.name) + '">' +
                        escapeHTML(u.name) + (u.role === 'admin' ? ' (admin)' : '') + '</option>';
            });
            sel.innerHTML = html;

            if (auth.isAdmin()) {
                sel.disabled = false;
                sel.value = me ? String(me.id) : '';
            } else {
                // PMs always own jobs they create — lock to self
                sel.value = me ? String(me.id) : '';
                sel.disabled = true;
            }
        }

        function saveJob() {
            const title = document.getElementById('jobTitle').value.trim();
            if (!title) { alert('Enter a job name'); return; }
            const pmSelect = document.getElementById('jobPM');
            const pmOpt = pmSelect.options[pmSelect.selectedIndex];
            const pmName = (pmOpt && pmOpt.dataset && pmOpt.dataset.name) ? pmOpt.dataset.name : pmSelect.value;
            const ownerIdRaw = parseInt(pmSelect.value, 10);
            const job = {
                id: 'j' + Date.now(),
                jobNumber: document.getElementById('jobNumber').value.trim(),
                title: title,
                client: document.getElementById('jobClient').value.trim(),
                pm: pmName,
                owner_id: isNaN(ownerIdRaw) ? null : ownerIdRaw,
                jobType: document.getElementById('jobType').value,
                workType: document.getElementById('jobWorkType').value,
                market: document.getElementById('jobMarket').value,
                status: document.getElementById('jobStatus').value,
                contractAmount: parseFloat(document.getElementById('jobContractAmount').value) || 0,
                estimatedCosts: parseFloat(document.getElementById('jobEstimatedCosts').value) || 0,
                targetMarginPct: parseFloat(document.getElementById('jobTargetMargin').value) || 50,
                totalProductionDays: parseInt(document.getElementById('jobTotalProductionDays') ? document.getElementById('jobTotalProductionDays').value : '', 10) || 0,
                notes: document.getElementById('jobNotes').value.trim(),
                pctComplete: 0,
                invoicedToDate: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            appData.jobs.push(job);
            saveData();
            closeModal('addJobModal');
            renderWIPMain();
        }

        function editJob(jobId) {
            appState.currentJobId = jobId;
            renderJobDetail(jobId);
            document.getElementById('wip-main-view').style.display = 'none';
            document.getElementById('wip-job-detail-view').style.display = 'block';
        }

        function backToWIPMain() {
            document.getElementById('wip-main-view').style.display = 'block';
            document.getElementById('wip-job-detail-view').style.display = 'none';
            appState.currentJobId = null;
            renderWIPMain();
        }

        function archiveCurrentJob() {
            const job = appData.jobs.find(j => j.id === appState.currentJobId);
            if (!job) return;
            if (job.status === 'Archived') {
                job.status = 'Completed';
            } else {
                if (!confirm('Archive this job? It will be hidden from the active list.')) return;
                job.status = 'Archived';
                job.archivedAt = new Date().toISOString();
            }
            job.updatedAt = new Date().toISOString();
            saveData();
            renderJobDetail(job.id);
        }

        function deleteCurrentJob() {
            const jobId = appState.currentJobId;
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            if (!confirm('Permanently delete "' + (job.title || 'this job') + '" and all its buildings, phases, subs, and change orders? This cannot be undone.')) return;
            // Remove all related data locally
            appData.buildings = appData.buildings.filter(b => b.jobId !== jobId);
            appData.phases = appData.phases.filter(p => p.jobId !== jobId);
            appData.subs = appData.subs.filter(s => s.jobId !== jobId);
            appData.changeOrders = appData.changeOrders.filter(c => c.jobId !== jobId);
            appData.purchaseOrders = (appData.purchaseOrders || []).filter(p => p.jobId !== jobId);
            appData.invoices = (appData.invoices || []).filter(i => i.jobId !== jobId);
            appData.jobs = appData.jobs.filter(j => j.id !== jobId);
            // Remove workspace data
            var allWs = safeLoadJSON('agx-workspaces', {});
            delete allWs[jobId];
            localStorage.setItem('agx-workspaces', JSON.stringify(allWs));
            // Persist locally + push to server. The bulk-save endpoint only
            // upserts present jobs, so we also need an explicit DELETE
            // /api/jobs/:id call — without this the server keeps the job
            // and it reappears on the next page reload.
            saveData();
            if (window.agxApi && window.agxApi.isAuthenticated()) {
                window.agxApi.jobs.remove(jobId).catch(function(err) {
                    console.warn('Server delete failed for ' + jobId + ':', err.message);
                });
            }
            backToWIPMain();
        }

        function toggleEditJobInfo() {
            const jobId = appState.currentJobId;
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            const btn = document.getElementById('edit-job-info-btn');
            const card = document.getElementById('job-info-card');
            const isEditing = btn.textContent.includes('Save');
            if (isEditing) {
                // Save mode - read inputs and save
                job.jobNumber = document.getElementById('edit-jobNumber').value.trim();
                job.title = document.getElementById('edit-jobTitle').value.trim();
                job.client = document.getElementById('edit-jobClient').value.trim();
                job.pm = document.getElementById('edit-jobPM').value;
                const typeVal = document.getElementById('edit-jobType').value;
                job.jobType = typeVal;
                job.workType = document.getElementById('edit-jobWorkType').value;
                job.market = document.getElementById('edit-jobMarket').value;
                job.contractAmount = parseFloat(document.getElementById('edit-jobContract').value) || 0;
                job.estimatedCosts = parseFloat(document.getElementById('edit-jobEstCosts').value) || 0;
                job.targetMarginPct = parseFloat(document.getElementById('edit-jobMargin').value) || 50;
                // Schedule page reads totalProductionDays for daily-revenue math.
                var prodEl = document.getElementById('edit-jobProductionDays');
                if (prodEl) job.totalProductionDays = parseInt(prodEl.value, 10) || 0;
                job.status = document.getElementById('edit-jobStatus').value;
                job.notes = document.getElementById('edit-jobNotes').value.trim();
                job.updatedAt = new Date().toISOString();
                saveData();
                // Restore the original grid HTML so renderJobDetail can populate it
                const grid = document.getElementById('job-info-card').querySelector('div[style*="grid-template-columns"]');
                if (grid) {
                    const mkDiv = (lbl, id, extraStyle) => {
                        const lt = String.fromCharCode(60);
                        const gt = String.fromCharCode(62);
                        return lt + 'div' + gt + lt + 'label style="font-size: 12px; color: var(--text-dim);"' + gt + lbl + lt + '/label' + gt + lt + 'div style="font-size: 14px; color: ' + (extraStyle || 'var(--text)') + ';" id="' + id + '"' + gt + lt + '/div' + gt + lt + '/div' + gt;
                    };
                    grid.innerHTML = mkDiv('Job Number','job-info-number') + mkDiv('Job Name','job-info-title') + mkDiv('Client','job-info-client') + mkDiv('PM','job-info-pm') + mkDiv('Type','job-info-type') + mkDiv('Work Type','job-info-worktype') + mkDiv('Market','job-info-market') + mkDiv('Contract (As Sold)','job-info-contract','var(--accent); font-weight: 700') + mkDiv('Est. Costs (As Sold)','job-info-estcosts') + mkDiv('Target Margin %','job-info-margin') + mkDiv('Production Days','job-info-prod-days') + mkDiv('Status','job-info-status') + mkDiv('Notes','job-info-notes');
                }
                btn.innerHTML = '&#x270F;&#xFE0F; Edit Job';
                btn.className = 'ee-btn primary';
                renderJobDetail(jobId);
            } else {
                // Enter edit mode - replace displays with inputs
                btn.innerHTML = '&#x1F4BE; Save';
                btn.className = 'ee-btn success';
                const grid = card.querySelector('div[style*="grid-template-columns"]');
                if (!grid) return;
                const pmOpts = ['John','Noah','Henry'].map(p => 
                    String.fromCharCode(60) + 'option' + (p === job.pm ? ' selected' : '') + String.fromCharCode(62) + p + String.fromCharCode(60) + '/option' + String.fromCharCode(62)
                ).join('');
                const typeOpts = ['Service','Renovation','Work Order'].map(t =>
                    String.fromCharCode(60) + 'option' + (t === job.jobType ? ' selected' : '') + String.fromCharCode(62) + t + String.fromCharCode(60) + '/option' + String.fromCharCode(62)
                ).join('');
                const statusOpts = ['New','Backlog','In Progress','On Hold','Completed','Archived'].map(s =>
                    String.fromCharCode(60) + 'option' + (s === job.status ? ' selected' : '') + String.fromCharCode(62) + s + String.fromCharCode(60) + '/option' + String.fromCharCode(62)
                ).join('');
                const marketOpts = ['Tampa','Orlando'].map(m =>
                    String.fromCharCode(60) + 'option' + (m === job.market ? ' selected' : '') + String.fromCharCode(62) + m + String.fromCharCode(60) + '/option' + String.fromCharCode(62)
                ).join('');
                const inp = (id, val, type) => {
                    type = type || 'text';
                    return String.fromCharCode(60) + 'input id="' + id + '" type="' + type + '" value="' + escapeHTML(val || '') + '" style="width:100%;background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px;"' + String.fromCharCode(62);
                };
                const sel = (id, opts) => String.fromCharCode(60) + 'select id="' + id + '" style="width:100%;background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px;"' + String.fromCharCode(62) + opts + String.fromCharCode(60) + '/select' + String.fromCharCode(62);
                const lbl = (txt) => String.fromCharCode(60) + 'label style="font-size:12px;color:var(--text-dim);"' + String.fromCharCode(62) + txt + String.fromCharCode(60) + '/label' + String.fromCharCode(62);
                const d = (inner) => String.fromCharCode(60) + 'div' + String.fromCharCode(62) + inner + String.fromCharCode(60) + '/div' + String.fromCharCode(62);
                grid.innerHTML = 
                    d(lbl('Job Number') + inp('edit-jobNumber', job.jobNumber)) +
                    d(lbl('Job Name') + inp('edit-jobTitle', job.title)) +
                    d(lbl('Client') + inp('edit-jobClient', job.client)) +
                    d(lbl('PM') + sel('edit-jobPM', pmOpts)) +
                    d(lbl('Type') + sel('edit-jobType', typeOpts)) +
                    d(lbl('Work Type') + inp('edit-jobWorkType', job.workType)) +
                    d(lbl('Market') + sel('edit-jobMarket', marketOpts)) +
                    d(lbl('Contract (As Sold)') + inp('edit-jobContract', job.contractAmount, 'number')) +
                    d(lbl('Est. Costs (As Sold)') + inp('edit-jobEstCosts', job.estimatedCosts, 'number')) +
                    d(lbl('Target Margin %') + inp('edit-jobMargin', job.targetMarginPct || 50, 'number')) +
                    d(lbl('Production Days') + inp('edit-jobProductionDays', job.totalProductionDays || '', 'number')) +
                    d(lbl('Status') + sel('edit-jobStatus', statusOpts)) +
                    d(lbl('Notes') + inp('edit-jobNotes', job.notes));
            }
        }

        // Resolve a job's PM display name from owner_id via the users cache,
        // falling back to the legacy job.pm string for old jobs / offline mode.
        function getJobOwnerName(job) {
            if (!job) return '—';
            if (window.agxAdmin && window.agxAdmin.findUserById) {
                var u = window.agxAdmin.findUserById(job.owner_id);
                if (u && u.name) return u.name;
            }
            return job.pm || '—';
        }

        function renderJobDetail(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;

            // Read-only enforcement: when the current user can't edit this job,
            // toggle a CSS class on the detail container that disables form
            // controls and edit-action buttons, and show the explanatory banner.
            // Also skip auto-calc + saveData below since those would attempt
            // server writes that the user isn't allowed to make.
            const detailEl = document.getElementById('wip-job-detail-view');
            const readOnly = job._canEdit === false;
            if (detailEl) detailEl.classList.toggle('read-only-mode', readOnly);
            const banner = document.getElementById('job-detail-readonly-banner');
            const bannerMsg = document.getElementById('job-detail-readonly-msg');
            if (banner) banner.style.display = readOnly ? '' : 'none';
            if (bannerMsg && readOnly) {
                bannerMsg.textContent = 'This job is assigned to ' + (job.pm || 'another PM') +
                                         '. You can review the data but changes won’t save.';
            }

            if (!readOnly) {
                // Recalculate sub costs from Subcontractors tab entries
                recalcSubCosts(jobId);

                // Auto-calculate % complete from phases/buildings (unless manual override)
                if (!job.pctCompleteManual) {
                    const hasPhases = appData.phases.filter(p => p.jobId === jobId).length > 0;
                    const hasBuildings = appData.buildings.filter(b => b.jobId === jobId).length > 0;
                    if (hasPhases || hasBuildings) {
                        job.pctComplete = Math.round(calcJobPctComplete(jobId) * 10) / 10;
                    }
                }
                saveData();
            }

            // Defensive: re-apply the read-only button guard after the rest of
            // the detail finishes rendering (workspace-layout.js may rebuild
            // panels asynchronously). setTimeout 0 lets all synchronous
            // sub-renders complete before we walk the DOM.
            if (typeof applyReadOnlyButtonGuard === 'function') {
                setTimeout(applyReadOnlyButtonGuard, 0);
            }

            const w = getJobWIP(jobId);

            document.getElementById('job-detail-title').textContent = (job.jobNumber ? job.jobNumber + ' — ' : '') + job.title;
            const detailStatusClass = job.status === 'On Hold' ? 'at-risk' : job.status === 'Completed' ? 'on-track' : job.status === 'Archived' ? 'not-started' : 'on-track';
            document.getElementById('job-detail-status').innerHTML = `<span class="badge ${detailStatusClass}">${escapeHTML(job.status)}</span>`;
            document.getElementById('job-detail-contract').textContent = `Total Income: ${formatCurrency(w.totalIncome)}`;

            document.getElementById('job-info-number').textContent = job.jobNumber || '—';
            document.getElementById('job-info-title').textContent = job.title;
            document.getElementById('job-info-client').textContent = job.client || '—';
            document.getElementById('job-info-pm').textContent = getJobOwnerName(job);
            document.getElementById('job-info-type').textContent = job.jobType ? (job.jobType + (job.market ? ' - ' + job.market : '')) : '—';
            document.getElementById('job-info-worktype').textContent = job.workType || '—';
            document.getElementById('job-info-market').textContent = job.market || '—';
            document.getElementById('job-info-contract').textContent = formatCurrency(job.contractAmount);
            document.getElementById('job-info-estcosts').textContent = formatCurrency(job.estimatedCosts);
            document.getElementById('job-info-margin').textContent = (job.targetMarginPct || 50) + '%';
            // Production days — read by Schedule page for daily-revenue math.
            var prodDaysCell = document.getElementById('job-info-prod-days');
            if (prodDaysCell) prodDaysCell.textContent = job.totalProductionDays ? (job.totalProductionDays + ' days') : '—';
            const statusClass = job.status === 'On Hold' ? 'at-risk' : job.status === 'Completed' ? 'on-track' : job.status === 'Archived' ? 'not-started' : 'on-track';
            document.getElementById('job-info-status').innerHTML = `<span class="badge ${statusClass}">${escapeHTML(job.status)}</span>`;
            document.getElementById('job-info-notes').textContent = job.notes || '—';
            document.getElementById('archive-job-btn').textContent = job.status === 'Archived' ? 'Unarchive Job' : 'Archive Job';

            // Summary cards — WIP-based
            const coInfo = w.coIncome > 0 ? `Contract: ${formatCurrency(w.contractIncome)} + CO: ${formatCurrency(w.coIncome)}` : '';
            document.getElementById('job-summary-totalincome').textContent = formatCurrency(w.totalIncome);
            document.getElementById('job-summary-income-breakdown').textContent = coInfo;
            document.getElementById('job-summary-cost').textContent = formatCurrency(w.actualCosts);
            const accruedCosts = getJobAccruedCosts(jobId);
            document.getElementById('job-summary-accrued').textContent = formatCurrency(accruedCosts);
            document.getElementById('job-summary-accrued-note').textContent = accruedCosts > 0 ? 'Earned but unbilled' : '';
            document.getElementById('job-summary-pctcomplete').textContent = w.pctComplete.toFixed(1) + '%';
            document.getElementById('job-summary-revenue').textContent = formatCurrency(w.revenueEarned);
            document.getElementById('job-summary-profit').textContent = formatCurrency(w.jtdProfit);
            document.getElementById('job-summary-profit').style.color = w.jtdProfit >= 0 ? 'var(--green)' : 'var(--red)';
            const jtdMarginStr = w.jtdMargin.toFixed(1) + '%';
            document.getElementById('job-summary-margin').textContent = jtdMarginStr;

            // Re-render the currently active subtab
            const activeSubTab = document.querySelector('.sub-tab-btn-job.active');
            const activeTabName = activeSubTab ? activeSubTab.getAttribute('data-subtab') : 'job-overview';
            switchJobSubTab(activeTabName);
            renderWipTab(jobId);
            renderChangeOrders(jobId);
            renderPurchaseOrders(jobId);
            renderInvoices(jobId);

            // Refresh sticky header metrics strip
            if (typeof refreshHeaderMetrics === 'function') refreshHeaderMetrics();
        }

        function renderJobOverview(jobId) {
            const container = document.getElementById('job-overview');
            if (!container) return;
            // Recompute node graph values (job.ngActualCosts, per-phase costs)
            // so cards display allocation-weighted totals reflecting current wires.
            ensureNGComputed(jobId);
            container.innerHTML = '';

            // ── Action buttons ──
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;';
            // Note: Close Week was retired in favor of automatic daily
            // snapshots (3 AM EST) plus a manual Capture Now on the Admin →
            // Metrics tab. The legacy weekly snapshots remain visible in
            // Insights history but no new ones get captured here.
            btnRow.innerHTML = '<button class="ee-btn secondary" onclick="openAddBuildingToJobModal()">&#x1F3D7; Building</button>' +
                '<button class="ee-btn secondary" onclick="openAddPhaseToJobModal()">&#x1F4CB; Phase</button>' +
                '<button class="ee-btn secondary" onclick="openAddSubToJobModal()">&#x1F477; Sub</button>' +
                '<button class="ee-btn secondary" onclick="openAddChangeOrderModal()">&#x1F4DD; Change Order</button>' +
                '<button class="ee-btn secondary" onclick="openAddPOModal()">&#x1F4C4; Purchase Order</button>' +
                '<button class="ee-btn secondary" onclick="openAddInvoiceModal()">&#x1F4B3; Invoice</button>';

            // Sharing button — visible only to admin or the job owner. Renders
            // a tiny inline indicator with the share count, and opens the
            // existing manage-sharing modal on click.
            var auth = window.agxAuth;
            var me = auth && auth.getUser && auth.getUser();
            var jobObj = appData.jobs.find(function(j) { return j.id === jobId; });
            var canManageSharing = me && jobObj && (me.role === 'admin' || me.id === jobObj.owner_id);
            if (canManageSharing && window.agxApi && window.agxApi.isAuthenticated()) {
                btnRow.insertAdjacentHTML('beforeend',
                    '<button class="ee-btn primary" onclick="openJobShareManager(\'' + escapeHTML(jobId) + '\')" ' +
                    'data-readonly-allowed ' +
                    'id="job-overview-share-btn">&#x1F517; Sharing <span id="job-overview-share-count" style="opacity:0.7;font-size:10px;"></span></button>'
                );
                // Async fetch the share count so the button shows '(n)' if any
                window.agxApi.jobs.listAccess(jobId).then(function(res) {
                    var n = (res.shares || []).length;
                    var countEl = document.getElementById('job-overview-share-count');
                    if (countEl && n > 0) countEl.textContent = '(' + n + ')';
                }).catch(function() { /* ignore — button still works without count */ });
            }
            container.appendChild(btnRow);

            // ── Building cards ──
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            if (buildings.length > 0) {
                const bldgSection = document.createElement('div');
                bldgSection.id = 'job-buildings-content';
                container.appendChild(bldgSection);
                renderJobBuildings(jobId);
            }

            if (buildings.length === 0) {
                container.innerHTML += '<div style="text-align:center;padding:30px;color:var(--text-dim);font-size:13px;">No buildings or phases yet. Use the buttons above to get started.</div>';
            }

            // ── Phases summary (grouped, expandable, with node connections) ──
            const jobPhases = appData.phases.filter(p => p.jobId === jobId);
            const phSection = document.createElement('div');
            phSection.style.cssText = 'margin-top:14px;';
            phSection.id = 'job-overview-phases';
            renderOverviewPhasesInto(phSection, jobId, jobPhases);
            container.appendChild(phSection);

            // ── Subcontractors summary (cards with expandable connections) ──
            const jobSubs = appData.subs.filter(s => s.jobId === jobId);
            if (jobSubs.length > 0) {
                const subsSection = document.createElement('div');
                subsSection.style.cssText = 'margin-top:14px;';
                subsSection.id = 'job-overview-subs';
                renderOverviewSubsInto(subsSection, jobId, jobSubs);
                container.appendChild(subsSection);
            }

            // ── Change Orders summary ──
            const cos = appData.changeOrders.filter(c => c.jobId === jobId);
            if (cos.length > 0) {
                const coSection = document.createElement('div');
                coSection.style.cssText = 'margin-top:14px;';
                let coTotalInc = 0, coTotalCost = 0;
                cos.forEach(c => { coTotalInc += c.income || 0; coTotalCost += c.estimatedCosts || 0; });
                var coRows = cos.map(c => {
                    const profit = (c.income || 0) - (c.estimatedCosts || 0);
                    return `<div class="card" style="cursor:pointer;padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:12px;" onclick="editCO('${escapeHTML(c.id)}')" title="Click to edit">
                        <div style="min-width:0;flex:1;">
                            <div style="font-size:13px;font-weight:600;">${escapeHTML(c.coNumber || 'CO')} — ${escapeHTML(c.description || '')}</div>
                            ${c.date ? '<div style="font-size:10px;color:var(--text-dim);">' + escapeHTML(c.date) + '</div>' : ''}
                        </div>
                        <div style="display:flex;gap:14px;font-size:12px;flex-shrink:0;">
                            <div><span style="color:var(--text-dim);">Inc</span> <b style="color:var(--green);">${formatCurrency(c.income)}</b></div>
                            <div><span style="color:var(--text-dim);">Cost</span> <b>${formatCurrency(c.estimatedCosts)}</b></div>
                            <div><span style="color:var(--text-dim);">Profit</span> <b style="color:${profit >= 0 ? 'var(--green)' : 'var(--red)'};">${formatCurrency(profit)}</b></div>
                        </div>
                    </div>`;
                }).join('');
                coSection.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <h3 style="font-size:13px;margin:0;">&#x1F4DD; Change Orders (${cos.length})</h3>
                        <div style="font-size:12px;color:var(--text-dim);">Total Inc: <b style="color:var(--green);">${formatCurrency(coTotalInc)}</b> &nbsp; Profit: <b style="color:${(coTotalInc-coTotalCost)>=0?'var(--green)':'var(--red)'};">${formatCurrency(coTotalInc-coTotalCost)}</b></div>
                    </div>
                    ${coRows}`;
                container.appendChild(coSection);
            }

            // ── Purchase Orders summary ──
            const pos = appData.purchaseOrders.filter(p => p.jobId === jobId);
            if (pos.length > 0) {
                const poSection = document.createElement('div');
                poSection.style.cssText = 'margin-top:14px;';
                let poTotalAmt = 0, poTotalBilled = 0;
                pos.forEach(p => { poTotalAmt += p.amount || 0; poTotalBilled += p.billedToDate || 0; });
                var poRows = pos.map(p => {
                    const remaining = (p.amount || 0) - (p.billedToDate || 0);
                    const statusColor = p.status === 'Closed' ? 'var(--green)' : p.status === 'Partial' ? 'var(--yellow)' : 'var(--accent)';
                    return `<div class="card" style="cursor:pointer;padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:12px;" onclick="editPO('${escapeHTML(p.id)}')" title="Click to edit">
                        <div style="min-width:0;flex:1;">
                            <div style="font-size:13px;font-weight:600;">${escapeHTML(p.poNumber || 'PO')} — ${escapeHTML(p.vendor || '')}</div>
                            ${p.description ? '<div style="font-size:11px;color:var(--text-dim);">' + escapeHTML(p.description) + '</div>' : ''}
                        </div>
                        <div style="display:flex;gap:14px;font-size:12px;align-items:center;flex-shrink:0;">
                            <div><span style="color:var(--text-dim);">Amt</span> <b>${formatCurrency(p.amount)}</b></div>
                            <div><span style="color:var(--text-dim);">Billed</span> <b>${formatCurrency(p.billedToDate)}</b></div>
                            <div><span style="color:var(--text-dim);">Rem</span> <b style="color:${remaining > 0 ? 'var(--yellow)' : 'var(--green)'};">${formatCurrency(remaining)}</b></div>
                            <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(79,140,255,0.1);color:${statusColor};font-weight:600;">${escapeHTML(p.status || 'Open')}</span>
                        </div>
                    </div>`;
                }).join('');
                poSection.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <h3 style="font-size:13px;margin:0;">&#x1F4C4; Purchase Orders (${pos.length})</h3>
                        <div style="font-size:12px;color:var(--text-dim);">Total: <b>${formatCurrency(poTotalAmt)}</b> &nbsp; Billed: <b>${formatCurrency(poTotalBilled)}</b> &nbsp; Rem: <b style="color:${(poTotalAmt-poTotalBilled)>0?'var(--yellow)':'var(--green)'};">${formatCurrency(poTotalAmt-poTotalBilled)}</b></div>
                    </div>
                    ${poRows}`;
                container.appendChild(poSection);
            }

            // ── Invoices summary ──
            const invs = appData.invoices.filter(i => i.jobId === jobId);
            if (invs.length > 0) {
                const invSection = document.createElement('div');
                invSection.style.cssText = 'margin-top:14px;';
                let invTotalAmt = 0, invTotalPaid = 0;
                invs.forEach(i => { invTotalAmt += i.amount || 0; if (i.status === 'Paid') invTotalPaid += i.amount || 0; });
                var invRows = invs.map(i => {
                    const statusColor = i.status === 'Paid' ? 'var(--green)' : i.status === 'Sent' ? 'var(--yellow)' : 'var(--text-dim)';
                    return `<div class="card" style="cursor:pointer;padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:12px;" onclick="editInvoice('${escapeHTML(i.id)}')" title="Click to edit">
                        <div style="min-width:0;flex:1;">
                            <div style="font-size:13px;font-weight:600;">${escapeHTML(i.invNumber || 'INV')} — ${escapeHTML(i.vendor || '')}</div>
                            ${i.description ? '<div style="font-size:11px;color:var(--text-dim);">' + escapeHTML(i.description) + '</div>' : ''}
                        </div>
                        <div style="display:flex;gap:14px;font-size:12px;align-items:center;flex-shrink:0;">
                            <div><span style="color:var(--text-dim);">Amt</span> <b>${formatCurrency(i.amount)}</b></div>
                            ${i.date ? '<div><span style="color:var(--text-dim);">Date</span> <b>' + escapeHTML(i.date) + '</b></div>' : ''}
                            ${i.dueDate ? '<div><span style="color:var(--text-dim);">Due</span> <b>' + escapeHTML(i.dueDate) + '</b></div>' : ''}
                            <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(79,140,255,0.1);color:${statusColor};font-weight:600;">${escapeHTML(i.status || 'Draft')}</span>
                        </div>
                    </div>`;
                }).join('');
                invSection.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <h3 style="font-size:13px;margin:0;">&#x1F4B3; Invoices (${invs.length})</h3>
                        <div style="font-size:12px;color:var(--text-dim);">Total: <b>${formatCurrency(invTotalAmt)}</b> &nbsp; Paid: <b style="color:var(--green);">${formatCurrency(invTotalPaid)}</b> &nbsp; Outstanding: <b style="color:var(--yellow);">${formatCurrency(invTotalAmt-invTotalPaid)}</b></div>
                    </div>
                    ${invRows}`;
                container.appendChild(invSection);
            }

            // ── Weekly WIP History ──
            renderWeeklyBreakdown(container, jobId);
        }

        // ==================== WEEKLY SNAPSHOT / CLOSE WEEK ====================
        // Returns a YYYY-MM-DD string for the given Date in America/New_York
        // (business timezone, used for dating all daily snapshots regardless
        // of where the user's browser actually is).
        function dateKeyEST(d) {
            d = d || new Date();
            return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        }

        // Builds the snapshot blob from current job state. Shared by both daily
        // and weekly capture paths so they record the same fields.
        function buildSnapshotPayload(jobId, dateTag) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return null;
            ensureNGComputed(jobId);
            const w = getJobWIP(jobId);
            const accrued = getJobAccruedCosts(jobId);
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const phases = appData.phases.filter(p => p.jobId === jobId);
            const cos = appData.changeOrders.filter(c => c.jobId === jobId);
            const subs = appData.subs.filter(s => s.jobId === jobId);
            const pos = (appData.purchaseOrders || []).filter(p => p.jobId === jobId);

            return {
                weekOf: dateTag,
                dateKey: dateTag,
                closedAt: new Date().toISOString(),
                job: {
                    pctComplete: w.pctComplete,
                    totalIncome: w.totalIncome,
                    contractIncome: w.contractIncome,
                    estimatedCosts: w.estimatedCosts,
                    revisedEstCosts: w.revisedEstCosts,
                    actualCosts: w.actualCosts,
                    accrued: accrued,
                    revEarned: w.revenueEarned,
                    invoiced: w.invoiced,
                    coIncome: w.coIncome,
                    grossProfit: w.revisedProfit,
                    backlog: w.backlog
                },
                buildings: buildings.map(function(b) {
                    var bPct = calcBuildingPctComplete(b.id, jobId);
                    var bCost = (b.materials||0)+(b.labor||0)+(b.sub||0)+(b.equipment||0);
                    return { id:b.id, name:b.name, pctComplete:bPct, budget:b.budget||0, cost:bCost };
                }),
                phases: phases.map(function(p) {
                    var pCost = (p.materials||0)+(p.labor||0)+(p.sub||0)+(p.equipment||0);
                    return { id:p.id, name:p.phase, pctComplete:p.pctComplete||0, revenue:p.asSoldRevenue||0, cost:pCost, buildingId:p.buildingId };
                }),
                changeOrders: cos.map(function(c) {
                    return { id:c.id, coNumber:c.coNumber, income:c.income||0, estimatedCosts:c.estimatedCosts||0, pctComplete:c.pctComplete||0 };
                }),
                subs: subs.map(function(s) {
                    return { id:s.id, name:s.name, contractAmt:s.contractAmt||0, billedToDate:s.billedToDate||0, accruedAmt:s.accruedAmt||0 };
                }),
                purchaseOrders: pos.map(function(p) {
                    return { id:p.id, vendor:p.vendor, amount:p.amount||0, billedToDate:p.billedToDate||0 };
                })
            };
        }

        // Capture (or refresh) today's daily snapshot for a single job. Only
        // snapshots Live jobs unless `force` is true (used by the manual
        // "Capture Now" button on the Metrics tab). Auto-prunes dailySnapshots
        // older than 90 days.
        function captureDailySnapshot(jobId, force) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return false;
            if (!force && job.liveStatus !== 'live') return false;
            if (!job.dailySnapshots) job.dailySnapshots = [];
            var today = dateKeyEST();
            var payload = buildSnapshotPayload(jobId, today);
            if (!payload) return false;
            var existingIdx = job.dailySnapshots.findIndex(function(s) { return s.dateKey === today; });
            if (existingIdx >= 0) {
                job.dailySnapshots[existingIdx] = payload;
            } else {
                job.dailySnapshots.push(payload);
            }
            // Sort ascending and prune anything older than 90 days
            job.dailySnapshots.sort(function(a, b) { return a.dateKey < b.dateKey ? -1 : 1; });
            var cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 90);
            var cutoffKey = cutoff.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            job.dailySnapshots = job.dailySnapshots.filter(function(s) { return s.dateKey >= cutoffKey; });
            return true;
        }

        // Capture daily snapshots for every Live job that's missing today's
        // entry. Saves once at the end if anything was captured. Returns the
        // number of jobs captured.
        function captureDailySnapshotsForAllLiveJobs() {
            var today = dateKeyEST();
            var captured = 0;
            (appData.jobs || []).forEach(function(j) {
                if (j.liveStatus !== 'live') return;
                var has = (j.dailySnapshots || []).some(function(s) { return s.dateKey === today; });
                if (has) return;
                if (captureDailySnapshot(j.id)) captured++;
            });
            if (captured > 0) saveData();
            return captured;
        }

        // Returns ms until next 3 AM America/New_York. Used by the scheduler
        // to fire one snapshot pass per day if the app stays open across
        // 3 AM EST/EDT. NY DST shifts are handled automatically by the
        // toLocaleString conversion — we don't have to track EDT vs EST.
        function msUntilNext3AmEst() {
            var now = new Date();
            // Build a Date that represents "now" in NY timezone as a string,
            // then parse it back. Lose the timezone offset so math is local.
            var nyNowStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
            var nyNow = new Date(nyNowStr);
            var target = new Date(nyNow);
            target.setHours(3, 0, 5, 0); // 3:00:05 AM, slight buffer past the hour
            if (target <= nyNow) target.setDate(target.getDate() + 1);
            var diffMs = target.getTime() - nyNow.getTime();
            // Floor at 60s to avoid tight loops if the math goes weird
            return Math.max(60000, diffMs);
        }

        function captureWeekSnapshot(jobId, weekOf) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return null;
            ensureNGComputed(jobId);
            const w = getJobWIP(jobId);
            const accrued = getJobAccruedCosts(jobId);
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const phases = appData.phases.filter(p => p.jobId === jobId);
            const cos = appData.changeOrders.filter(c => c.jobId === jobId);
            const subs = appData.subs.filter(s => s.jobId === jobId);
            const pos = (appData.purchaseOrders || []).filter(p => p.jobId === jobId);

            return {
                weekOf: weekOf,
                closedAt: new Date().toISOString(),
                job: {
                    pctComplete: w.pctComplete,
                    totalIncome: w.totalIncome,
                    contractIncome: w.contractIncome,
                    estimatedCosts: w.estimatedCosts,
                    revisedEstCosts: w.revisedEstCosts,
                    actualCosts: w.actualCosts,
                    accrued: accrued,
                    revEarned: w.revenueEarned,
                    invoiced: w.invoiced,
                    coIncome: w.coIncome,
                    grossProfit: w.revisedProfit,
                    backlog: w.backlog
                },
                buildings: buildings.map(function(b) {
                    var bPct = calcBuildingPctComplete(b.id, jobId);
                    var bCost = (b.materials||0)+(b.labor||0)+(b.sub||0)+(b.equipment||0);
                    return { id:b.id, name:b.name, pctComplete:bPct, budget:b.budget||0, cost:bCost };
                }),
                phases: phases.map(function(p) {
                    var pCost = (p.materials||0)+(p.labor||0)+(p.sub||0)+(p.equipment||0);
                    return { id:p.id, name:p.phase, pctComplete:p.pctComplete||0, revenue:p.asSoldRevenue||0, cost:pCost, buildingId:p.buildingId };
                }),
                changeOrders: cos.map(function(c) {
                    return { id:c.id, coNumber:c.coNumber, income:c.income||0, estimatedCosts:c.estimatedCosts||0, pctComplete:c.pctComplete||0 };
                }),
                subs: subs.map(function(s) {
                    return { id:s.id, name:s.name, contractAmt:s.contractAmt||0, billedToDate:s.billedToDate||0, accruedAmt:s.accruedAmt||0 };
                }),
                purchaseOrders: pos.map(function(p) {
                    return { id:p.id, vendor:p.vendor, amount:p.amount||0, billedToDate:p.billedToDate||0 };
                })
            };
        }

        function closeWeek(jobId, weekOf) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            if (!job.weeklySnapshots) job.weeklySnapshots = [];
            var existing = job.weeklySnapshots.findIndex(function(s) { return s.weekOf === weekOf; });
            if (existing >= 0) {
                if (!confirm('A snapshot for week ' + weekOf + ' already exists. Overwrite?')) return;
                job.weeklySnapshots[existing] = captureWeekSnapshot(jobId, weekOf);
            } else {
                job.weeklySnapshots.push(captureWeekSnapshot(jobId, weekOf));
            }
            job.weeklySnapshots.sort(function(a, b) { return a.weekOf < b.weekOf ? -1 : 1; });
            saveData();
            renderJobDetail(jobId);
        }

        function openCloseWeekModal(jobId) {
            var today = new Date();
            var dayOfWeek = today.getDay();
            var friday = new Date(today);
            friday.setDate(today.getDate() + (5 - dayOfWeek + 7) % 7);
            if (dayOfWeek > 5) friday.setDate(friday.getDate() - 7);
            var defaultDate = friday.toISOString().split('T')[0];

            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
            var box = document.createElement('div');
            box.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;min-width:320px;max-width:400px;';
            box.innerHTML = '<h3 style="margin:0 0 12px;font-size:15px;">Close Week</h3>' +
                '<p style="font-size:12px;color:var(--text-dim);margin:0 0 12px;">Captures a snapshot of all WIP data for this period. This records current % complete, revenue earned, costs, and change order status.</p>' +
                '<label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:4px;">Week Ending</label>' +
                '<input type="date" id="closeWeekDate" value="' + defaultDate + '" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;margin-bottom:16px;" />' +
                '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                '<button onclick="this.closest(\'div\').closest(\'div\').closest(\'div\').remove()" style="padding:6px 16px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);cursor:pointer;">Cancel</button>' +
                '<button id="closeWeekBtn" style="padding:6px 16px;border-radius:6px;background:var(--accent);border:none;color:#fff;cursor:pointer;font-weight:600;">Close Week</button>' +
                '</div>';
            overlay.appendChild(box);
            overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);
            document.getElementById('closeWeekBtn').addEventListener('click', function() {
                var dt = document.getElementById('closeWeekDate').value;
                if (!dt) { alert('Select a week ending date'); return; }
                closeWeek(jobId, dt);
                overlay.remove();
            });
        }

        function renderWeeklyBreakdown(container, jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job || !job.weeklySnapshots || !job.weeklySnapshots.length) return;
            var snaps = job.weeklySnapshots;

            var section = document.createElement('div');
            section.style.cssText = 'margin-top:14px;';

            var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
                '<h3 style="font-size:13px;margin:0;">&#x1F4C5; Weekly WIP Insights (' + snaps.length + ' weeks)</h3></div>';

            html += '<div class="card" style="padding:14px;">';

            // ─── Section 1: Timeline Cards (horizontal scroll strip) ───
            html += '<div style="margin-bottom:16px;">';
            html += '<div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Period Summary</div>';
            html += '<div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;">';
            snaps.forEach(function(snap, i) {
                var prev = i > 0 ? snaps[i - 1] : null;
                var dRev = snap.job.revEarned - (prev ? prev.job.revEarned : 0);
                var dCost = snap.job.actualCosts - (prev ? prev.job.actualCosts : 0);
                var dProfit = dRev - dCost;
                var isLatest = i === snaps.length - 1;
                var borderColor = isLatest ? 'var(--accent)' : 'var(--border)';
                var scale = isLatest ? '1' : '0.95';
                html += '<div style="flex:0 0 auto;min-width:140px;padding:10px 12px;border-radius:8px;background:var(--surface2);border:1px solid ' + borderColor + ';transform:scale(' + scale + ');">';
                html += '<div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;">' + escapeHTML(snap.weekOf) + '</div>';
                html += '<div style="font-size:18px;font-weight:700;color:var(--green);margin-bottom:2px;">' + (dRev >= 0 ? '+' : '') + formatCurrency(dRev) + '</div>';
                html += '<div style="font-size:9px;color:var(--text-dim);">rev earned</div>';
                html += '<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;">';
                html += '<span style="color:var(--text-dim);">Cost <b style="color:var(--red);">' + (dCost >= 0 ? '+' : '') + formatCurrency(dCost) + '</b></span>';
                html += '</div>';
                html += '<div style="display:flex;justify-content:space-between;font-size:10px;">';
                html += '<span style="color:var(--text-dim);">Profit <b style="color:' + (dProfit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + (dProfit >= 0 ? '+' : '') + formatCurrency(dProfit) + '</b></span>';
                html += '</div>';
                html += '<div style="margin-top:6px;height:4px;border-radius:2px;background:var(--border);overflow:hidden;">';
                html += '<div style="height:100%;width:' + Math.min(snap.job.pctComplete, 100) + '%;background:' + (snap.job.pctComplete >= 100 ? 'var(--green)' : 'var(--accent)') + ';border-radius:2px;"></div></div>';
                html += '<div style="font-size:9px;color:var(--text-dim);text-align:right;margin-top:2px;">' + snap.job.pctComplete.toFixed(1) + '%</div>';
                html += '</div>';
            });
            html += '</div></div>';

            // ─── Section 2: Waterfall Chart (revenue vs costs cumulative) ───
            html += '<div style="margin-bottom:16px;border-top:1px solid var(--border);padding-top:12px;">';
            html += '<div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Revenue vs Costs</div>';
            var wfId = 'wf-chart-' + jobId.replace(/\W/g, '_');
            html += '<canvas id="' + wfId + '" width="600" height="180" style="width:100%;height:180px;"></canvas>';
            html += '</div>';

            // ─── Section 3: Phase Heat Map ───
            var allPhaseIds = {};
            snaps.forEach(function(s) { (s.phases || []).forEach(function(p) { allPhaseIds[p.id] = p.name; }); });
            var phaseKeys = Object.keys(allPhaseIds);
            if (phaseKeys.length > 0) {
                html += '<div style="margin-bottom:16px;border-top:1px solid var(--border);padding-top:12px;">';
                html += '<div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Phase Progress Heat Map</div>';
                html += '<div style="overflow-x:auto;">';
                html += '<table style="border-collapse:collapse;font-size:10px;width:100%;">';
                html += '<thead><tr><th style="padding:4px 6px;text-align:left;border-bottom:1px solid var(--border);color:var(--text-dim);white-space:nowrap;">Phase</th>';
                snaps.forEach(function(s) {
                    var label = s.weekOf.substring(5);
                    html += '<th style="padding:4px 4px;text-align:center;border-bottom:1px solid var(--border);color:var(--text-dim);white-space:nowrap;min-width:40px;">' + label + '</th>';
                });
                html += '</tr></thead><tbody>';
                phaseKeys.forEach(function(pid) {
                    html += '<tr>';
                    html += '<td style="padding:3px 6px;border-bottom:1px solid var(--border);white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;">' + escapeHTML(allPhaseIds[pid]) + '</td>';
                    var prevPct = 0;
                    snaps.forEach(function(s, si) {
                        var ph = (s.phases || []).find(function(p) { return p.id === pid; });
                        var pct = ph ? ph.pctComplete : 0;
                        var delta = pct - prevPct;
                        prevPct = pct;
                        var bg, fg;
                        if (pct >= 100) { bg = 'rgba(52,211,153,0.3)'; fg = 'var(--green)'; }
                        else if (delta > 10) { bg = 'rgba(52,211,153,0.2)'; fg = 'var(--green)'; }
                        else if (delta > 0) { bg = 'rgba(251,191,36,0.15)'; fg = '#f59e0b'; }
                        else if (pct > 0) { bg = 'rgba(139,144,165,0.1)'; fg = 'var(--text-dim)'; }
                        else { bg = 'transparent'; fg = 'var(--text-dim)'; }
                        html += '<td style="padding:3px 4px;text-align:center;border-bottom:1px solid var(--border);background:' + bg + ';color:' + fg + ';font-weight:' + (delta > 0 ? '600' : '400') + ';">' + (pct > 0 ? pct.toFixed(0) + '%' : '—') + '</td>';
                    });
                    html += '</tr>';
                });
                html += '</tbody></table></div></div>';
            }

            // ─── Section 4: Burn-Down / Backlog Projection ───
            html += '<div style="border-top:1px solid var(--border);padding-top:12px;">';
            html += '<div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Backlog Burn-Down</div>';
            var bdId = 'bd-chart-' + jobId.replace(/\W/g, '_');
            html += '<canvas id="' + bdId + '" width="600" height="140" style="width:100%;height:140px;"></canvas>';
            // Projected completion
            if (snaps.length >= 2) {
                var lastSnap = snaps[snaps.length - 1];
                var prevSnap = snaps[snaps.length - 2];
                var weeklyRevRate = lastSnap.job.revEarned - prevSnap.job.revEarned;
                var backlog = lastSnap.job.backlog;
                if (weeklyRevRate > 0 && backlog > 0) {
                    var weeksLeft = Math.ceil(backlog / weeklyRevRate);
                    var projDate = new Date(lastSnap.weekOf);
                    projDate.setDate(projDate.getDate() + weeksLeft * 7);
                    var projStr = projDate.toISOString().split('T')[0];
                    html += '<div style="font-size:11px;color:var(--text-dim);margin-top:6px;">At current pace (<b style="color:var(--green);">' + formatCurrency(weeklyRevRate) + '/wk</b>), projected completion: <b style="color:var(--accent);">' + projStr + '</b> (~' + weeksLeft + ' weeks)</div>';
                }
            }
            html += '</div>';

            html += '</div>'; // close card

            // ─── Detail Table (collapsible rows, kept from before) ───
            html += '<div style="margin-top:10px;">';
            html += '<div class="card" style="padding:0;overflow-x:auto;">';
            html += '<table style="width:100%;border-collapse:collapse;font-size:11px;">';
            html += '<thead><tr style="background:var(--surface2);">';
            html += '<th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);">Week</th>';
            html += '<th style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);">% Cmp</th>';
            html += '<th style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);">Rev Earned</th>';
            html += '<th style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--green);">&#916; Rev</th>';
            html += '<th style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);">Actual Costs</th>';
            html += '<th style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--red);">&#916; Costs</th>';
            html += '<th style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);">Gross Profit</th>';
            html += '<th style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);">Backlog</th>';
            html += '</tr></thead><tbody>';
            snaps.forEach(function(snap, i) {
                var prev = i > 0 ? snaps[i - 1] : null;
                var dRev = snap.job.revEarned - (prev ? prev.job.revEarned : 0);
                var dCost = snap.job.actualCosts - (prev ? prev.job.actualCosts : 0);
                var uid = 'wk-detail-' + jobId.replace(/\W/g, '_') + '-' + i;
                html += '<tr style="cursor:pointer;border-bottom:1px solid var(--border);" onclick="var d=document.getElementById(\'' + uid + '\');d.style.display=d.style.display===\'none\'?\'table-row\':\'none\';">';
                html += '<td style="padding:6px 8px;font-weight:600;">' + escapeHTML(snap.weekOf) + '</td>';
                html += '<td style="padding:6px 8px;text-align:right;">' + snap.job.pctComplete.toFixed(1) + '%</td>';
                html += '<td style="padding:6px 8px;text-align:right;">' + formatCurrency(snap.job.revEarned) + '</td>';
                html += '<td style="padding:6px 8px;text-align:right;color:var(--green);font-weight:600;">' + (dRev >= 0 ? '+' : '') + formatCurrency(dRev) + '</td>';
                html += '<td style="padding:6px 8px;text-align:right;">' + formatCurrency(snap.job.actualCosts) + '</td>';
                html += '<td style="padding:6px 8px;text-align:right;color:var(--red);font-weight:600;">' + (dCost >= 0 ? '+' : '') + formatCurrency(dCost) + '</td>';
                html += '<td style="padding:6px 8px;text-align:right;color:' + (snap.job.grossProfit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(snap.job.grossProfit) + '</td>';
                html += '<td style="padding:6px 8px;text-align:right;">' + formatCurrency(snap.job.backlog) + '</td>';
                html += '</tr>';
                // Expandable detail
                html += '<tr id="' + uid + '" style="display:none;"><td colspan="8" style="padding:8px 12px;background:var(--surface2);">';
                if (snap.phases && snap.phases.length) {
                    html += '<div style="font-size:10px;font-weight:600;color:var(--text-dim);margin-bottom:4px;">PHASES</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">';
                    snap.phases.forEach(function(p) {
                        html += '<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:var(--surface);border:1px solid var(--border);">' + escapeHTML(p.name) + ' <b>' + p.pctComplete.toFixed(0) + '%</b> Rev:' + formatCurrency(p.revenue) + ' Cost:' + formatCurrency(p.cost) + '</span>';
                    });
                    html += '</div>';
                }
                if (snap.buildings && snap.buildings.length) {
                    html += '<div style="font-size:10px;font-weight:600;color:var(--text-dim);margin-bottom:4px;">BUILDINGS</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">';
                    snap.buildings.forEach(function(b) {
                        html += '<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:var(--surface);border:1px solid var(--border);">' + escapeHTML(b.name) + ' ' + b.pctComplete.toFixed(0) + '% Budget:' + formatCurrency(b.budget) + '</span>';
                    });
                    html += '</div>';
                }
                if (snap.changeOrders && snap.changeOrders.length) {
                    html += '<div style="font-size:10px;font-weight:600;color:var(--text-dim);margin-bottom:4px;">CHANGE ORDERS</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">';
                    snap.changeOrders.forEach(function(c) {
                        html += '<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:var(--surface);border:1px solid var(--border);">' + escapeHTML(c.coNumber || 'CO') + ' Inc:' + formatCurrency(c.income) + '</span>';
                    });
                    html += '</div>';
                }
                html += '</td></tr>';
            });
            html += '</tbody></table></div></div>';

            section.innerHTML = html;
            container.appendChild(section);

            // ─── Draw Waterfall Chart (canvas) ───
            setTimeout(function() {
                var wfCanvas = document.getElementById(wfId);
                if (!wfCanvas) return;
                var ctx = wfCanvas.getContext('2d');
                var W = wfCanvas.width = wfCanvas.offsetWidth * 2;
                var H = wfCanvas.height = 360;
                ctx.scale(2, 2);
                var w = W / 2, h = H / 2;
                var pad = { t: 20, r: 14, b: 28, l: 56 };
                var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;

                var maxVal = 0;
                snaps.forEach(function(s) { maxVal = Math.max(maxVal, s.job.revEarned, s.job.actualCosts); });
                if (maxVal === 0) maxVal = 1;
                var barW = Math.min(30, (cw / snaps.length - 6) / 2);

                ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim') || '#8b90a5';
                ctx.font = '9px system-ui';
                ctx.textAlign = 'right';
                for (var gi = 0; gi <= 4; gi++) {
                    var gy = pad.t + ch - (ch * gi / 4);
                    var gv = maxVal * gi / 4;
                    ctx.fillText(gv >= 1000 ? '$' + (gv / 1000).toFixed(0) + 'k' : '$' + gv.toFixed(0), pad.l - 6, gy + 3);
                    ctx.strokeStyle = 'rgba(140,145,165,0.15)';
                    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + cw, gy); ctx.stroke();
                }

                snaps.forEach(function(s, i) {
                    var x = pad.l + (i + 0.5) * (cw / snaps.length);
                    var revH = (s.job.revEarned / maxVal) * ch;
                    var costH = (s.job.actualCosts / maxVal) * ch;

                    ctx.fillStyle = 'rgba(79,140,255,0.7)';
                    ctx.fillRect(x - barW - 1, pad.t + ch - revH, barW, revH);
                    ctx.fillStyle = 'rgba(248,113,113,0.7)';
                    ctx.fillRect(x + 1, pad.t + ch - costH, barW, costH);

                    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim') || '#8b90a5';
                    ctx.font = '8px system-ui';
                    ctx.textAlign = 'center';
                    ctx.fillText(s.weekOf.substring(5), x, h - pad.b + 12);
                });

                // Legend
                ctx.font = '9px system-ui';
                ctx.fillStyle = 'rgba(79,140,255,0.9)';
                ctx.fillRect(pad.l, 4, 8, 8);
                ctx.fillText('Rev Earned', pad.l + 56, 12);
                ctx.fillStyle = 'rgba(248,113,113,0.9)';
                ctx.fillRect(pad.l + 70, 4, 8, 8);
                ctx.textAlign = 'left';
                ctx.fillText('Actual Costs', pad.l + 82, 12);

                // ─── Draw Burn-Down Chart ───
                var bdCanvas = document.getElementById(bdId);
                if (!bdCanvas) return;
                var bCtx = bdCanvas.getContext('2d');
                var bW = bdCanvas.width = bdCanvas.offsetWidth * 2;
                var bH = bdCanvas.height = 280;
                bCtx.scale(2, 2);
                var bw = bW / 2, bh = bH / 2;
                var bp = { t: 16, r: 14, b: 28, l: 56 };
                var bcw = bw - bp.l - bp.r, bch = bh - bp.t - bp.b;

                var maxBacklog = 0;
                snaps.forEach(function(s) { maxBacklog = Math.max(maxBacklog, s.job.backlog, s.job.totalIncome); });
                if (maxBacklog === 0) maxBacklog = 1;

                // Grid
                bCtx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim') || '#8b90a5';
                bCtx.font = '9px system-ui';
                bCtx.textAlign = 'right';
                for (var bi = 0; bi <= 4; bi++) {
                    var by = bp.t + bch - (bch * bi / 4);
                    var bv = maxBacklog * bi / 4;
                    bCtx.fillText(bv >= 1000 ? '$' + (bv / 1000).toFixed(0) + 'k' : '$' + bv.toFixed(0), bp.l - 6, by + 3);
                    bCtx.strokeStyle = 'rgba(140,145,165,0.15)';
                    bCtx.beginPath(); bCtx.moveTo(bp.l, by); bCtx.lineTo(bp.l + bcw, by); bCtx.stroke();
                }

                // Backlog line
                bCtx.beginPath();
                bCtx.strokeStyle = '#fbbf24';
                bCtx.lineWidth = 2;
                snaps.forEach(function(s, i) {
                    var bx = bp.l + (i + 0.5) * (bcw / snaps.length);
                    var by2 = bp.t + bch - (s.job.backlog / maxBacklog) * bch;
                    if (i === 0) bCtx.moveTo(bx, by2);
                    else bCtx.lineTo(bx, by2);
                });
                bCtx.stroke();

                // Backlog fill
                bCtx.lineTo(bp.l + (snaps.length - 0.5) * (bcw / snaps.length), bp.t + bch);
                bCtx.lineTo(bp.l + 0.5 * (bcw / snaps.length), bp.t + bch);
                bCtx.closePath();
                bCtx.fillStyle = 'rgba(251,191,36,0.1)';
                bCtx.fill();

                // Rev earned line (overlay)
                bCtx.beginPath();
                bCtx.strokeStyle = 'var(--green)';
                bCtx.lineWidth = 2;
                snaps.forEach(function(s, i) {
                    var bx = bp.l + (i + 0.5) * (bcw / snaps.length);
                    var by2 = bp.t + bch - (s.job.revEarned / maxBacklog) * bch;
                    if (i === 0) bCtx.moveTo(bx, by2);
                    else bCtx.lineTo(bx, by2);
                });
                bCtx.stroke();

                // Dots + labels
                snaps.forEach(function(s, i) {
                    var bx = bp.l + (i + 0.5) * (bcw / snaps.length);
                    var byB = bp.t + bch - (s.job.backlog / maxBacklog) * bch;
                    bCtx.fillStyle = '#fbbf24';
                    bCtx.beginPath(); bCtx.arc(bx, byB, 3, 0, Math.PI * 2); bCtx.fill();
                    bCtx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim') || '#8b90a5';
                    bCtx.font = '8px system-ui';
                    bCtx.textAlign = 'center';
                    bCtx.fillText(s.weekOf.substring(5), bx, bh - bp.b + 12);
                });

                // Legend
                bCtx.font = '9px system-ui';
                bCtx.textAlign = 'left';
                bCtx.strokeStyle = '#fbbf24'; bCtx.lineWidth = 2;
                bCtx.beginPath(); bCtx.moveTo(bp.l, 4); bCtx.lineTo(bp.l + 16, 4); bCtx.stroke();
                bCtx.fillStyle = '#fbbf24';
                bCtx.fillText('Backlog', bp.l + 20, 8);
                bCtx.strokeStyle = '#34d399';
                bCtx.beginPath(); bCtx.moveTo(bp.l + 70, 4); bCtx.lineTo(bp.l + 86, 4); bCtx.stroke();
                bCtx.fillStyle = '#34d399';
                bCtx.fillText('Rev Earned', bp.l + 90, 8);
            }, 50);
        }

        function renderJobBuildings(jobId) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const container = document.getElementById('job-buildings-content');
            container.innerHTML = '';

            buildings.forEach(building => {
                const wiredPhases = getPhasesWiredToBuilding(building.id);
                const phases = wiredPhases.map(function(wp) { return wp.phase; });
                let phaseCost = 0;
                wiredPhases.forEach(wp => {
                    var p = wp.phase;
                    var pct = (wp.allocPct != null ? wp.allocPct : 100) / 100;
                    phaseCost += ((p.materials || 0) + (p.labor || 0) + (p.sub || 0) + (p.equipment || 0)) * pct;
                });
                const bMat = building.materials || 0, bLab = building.labor || 0, bSub = building.sub || 0, bEquip = building.equipment || 0;
                const bldgDirectCost = bMat + bLab + bSub + bEquip;
                const buildingCost = phaseCost + bldgDirectCost;
                const variance = (building.budget || 0) - buildingCost;

                const allBldgs = appData.buildings.filter(b => b.jobId === jobId);
                const totalBudget = allBldgs.reduce((s, b) => s + (b.budget || 0), 0);
                const bldgPct = totalBudget > 0 ? ((building.budget || 0) / totalBudget * 100).toFixed(1) : '—';
                const pctComplete = calcBuildingPctComplete(building.id, jobId).toFixed(1);
                const scope = building.workScope || 'in-house';
                const scopeColor = scope === 'sub' ? 'var(--purple)' : scope === 'both' ? '#f59e0b' : 'var(--accent)';

                const cosWired = getCOsConnectedTo('t1', building.id);
                const uid = 'bldg-grp-' + building.id.replace(/\W/g, '_');

                const card = document.createElement('div');
                card.className = 'card';
                card.style.cssText = 'padding:0;margin-bottom:8px;overflow:hidden;';

                const header = `
                    <div style="padding:10px 12px;cursor:pointer;user-select:none;" onclick="var d=document.getElementById('${uid}');d.style.display=d.style.display==='none'?'block':'none';this.querySelector('.bldg-arrow').textContent=d.style.display==='none'?'\u25B6':'\u25BC';">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                            <div style="min-width:0;flex:1;display:flex;align-items:center;gap:8px;">
                                <span class="bldg-arrow" style="font-size:10px;color:var(--text-dim);">&#x25B6;</span>
                                <span style="font-size:14px;font-weight:700;">${escapeHTML(building.name)}</span>
                                ${building.address ? '<span style="font-size:11px;color:var(--text-dim);">' + escapeHTML(building.address) + '</span>' : ''}
                            </div>
                            <div style="text-align:right;flex-shrink:0;margin-left:8px;display:flex;align-items:center;gap:8px;">
                                <span style="font-size:13px;font-weight:700;color:var(--green);">${pctComplete}%</span>
                                <span style="font-size:10px;color:var(--text-dim);">${bldgPct}% of job</span>
                                <button class="ee-btn ghost" onclick="event.stopPropagation();editBuilding('${escapeHTML(building.id)}')">&#x270F;&#xFE0F; Edit</button>
                            </div>
                        </div>
                        <div style="display:flex;gap:12px;font-size:12px;margin-bottom:6px;">
                            <div><span style="color:var(--text-dim);">Budget</span> <span style="font-weight:600;color:var(--accent);">${formatCurrency(building.budget)}</span>${(building.coBudget ? ' <span style="font-size:10px;color:var(--green);">(+' + formatCurrency(building.coBudget) + ' CO)</span>' : '')}</div>
                            <div><span style="color:var(--text-dim);">Spent</span> <span style="font-weight:600;color:var(--accent);">${formatCurrency(buildingCost)}</span></div>
                            <div><span style="color:var(--text-dim);">Var</span> <span style="font-weight:600;color:${variance >= 0 ? 'var(--green)' : 'var(--red)'};">${formatCurrency(variance)}</span></div>
                            <div style="margin-left:auto;"><span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(79,140,255,0.1);color:${scopeColor};font-weight:600;text-transform:capitalize;">${escapeHTML(scope)}</span></div>
                        </div>
                    </div>`;

                let body = `<div id="${uid}" style="display:none;border-top:1px solid var(--border);padding:10px 12px;background:var(--surface2);">`;

                // Cost breakdown
                body += '<div style="display:flex;gap:10px;font-size:11px;color:var(--text-dim);margin-bottom:8px;flex-wrap:wrap;">' +
                    '<span>Mat: <b style="color:var(--text);">' + formatCurrency(bMat) + '</b></span>' +
                    '<span>Lab: <b style="color:var(--text);">' + formatCurrency(bLab) + '</b></span>' +
                    '<span>Sub: <b style="color:var(--text);">' + formatCurrency(bSub) + '</b></span>' +
                    '<span>Equip: <b style="color:var(--text);">' + formatCurrency(bEquip) + '</b></span>' +
                    ((building.hoursTotal || building.rate) ? '<span style="margin-left:auto;">' + (building.hoursTotal || 0) + 'hrs' + (building.hoursWeek ? ' (' + building.hoursWeek + '/wk)' : '') + ' @ ' + formatCurrency(building.rate || 40) + '/hr</span>' : '') +
                    '</div>';

                // Phases (from node graph wiring)
                body += '<div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-top:8px;margin-bottom:4px;">PHASES (' + wiredPhases.length + ')</div>';
                if (wiredPhases.length === 0) {
                    body += '<div style="font-size:11px;color:var(--text-dim);font-style:italic;margin-bottom:6px;">No phases wired to this building in the node graph</div>';
                } else {
                    body += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">';
                    wiredPhases.forEach(function(wp) {
                        var p = wp.phase;
                        var pCost = ((p.materials || 0) + (p.labor || 0) + (p.sub || 0) + (p.equipment || 0)) * wp.allocPct / 100;
                        var pColor = p.pctComplete >= 100 ? 'var(--green)' : p.pctComplete >= 50 ? '#f59e0b' : 'var(--text-dim)';
                        var allocStr = wp.allocPct !== 100 ? ' (' + wp.allocPct + '%)' : '';
                        body += '<button onclick="event.stopPropagation();editPhase(\'' + escapeHTML(p.id) + '\')" style="font-size:10px;padding:3px 8px;border-radius:6px;background:var(--surface);border:1px solid var(--border);white-space:nowrap;cursor:pointer;color:var(--text);">' +
                            escapeHTML(p.phase) + allocStr + ' <b style="color:' + pColor + ';">' + (p.pctComplete || 0) + '%</b> ' + formatCurrency(pCost) + '</button>';
                    });
                    body += '</div>';
                }
                body += '<button onclick="event.stopPropagation();openAddPhaseToJobModal(\'' + escapeHTML(building.id) + '\')" style="font-size:10px;padding:3px 8px;border-radius:6px;background:var(--surface);border:1px dashed var(--border);cursor:pointer;color:var(--text-dim);margin-bottom:8px;">+ Phase</button>';

                // Change Orders wired to this building
                body += '<div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-top:8px;margin-bottom:4px;">CHANGE ORDERS (' + cosWired.length + ')</div>';
                if (cosWired.length === 0) {
                    body += '<div style="font-size:11px;color:var(--text-dim);font-style:italic;margin-bottom:6px;">No COs wired to this building</div>';
                } else {
                    body += '<div style="display:flex;flex-direction:column;gap:3px;margin-bottom:6px;">';
                    cosWired.forEach(function(item) {
                        const c = item.co;
                        body += '<div onclick="event.stopPropagation();editCO(\'' + escapeHTML(c.id) + '\')" style="cursor:pointer;font-size:11px;padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;display:flex;justify-content:space-between;gap:8px;">' +
                            '<span><b>' + escapeHTML(c.coNumber || 'CO') + '</b> ' + escapeHTML((c.description || '').substring(0, 60)) + '</span>' +
                            '<span style="color:var(--text-dim);">Inc: <b style="color:var(--green);">' + formatCurrency((c.income || 0) * item.allocPct / 100) + '</b> (' + item.allocPct + '%)</span>' +
                            '</div>';
                    });
                    body += '</div>';
                }

                body += '</div>';
                card.innerHTML = header + body;
                container.appendChild(card);
            });
        }

        function lookupConnDetails(item) {
            var d = item.data;
            if (!d || !d.id) return '';
            var type = item.nodeType;
            if (type === 't2') {
                var ph = appData.phases.find(function(p) { return p.id === d.id; });
                if (!ph) return '';
                var cost = (ph.materials || 0) + (ph.labor || 0) + (ph.sub || 0) + (ph.equipment || 0);
                var pColor = ph.pctComplete >= 100 ? 'var(--green)' : ph.pctComplete >= 50 ? '#f59e0b' : 'var(--text-dim)';
                return '<span style="color:var(--text-dim);font-size:10px;">Rev: <b style="color:var(--green);">' + formatCurrency(ph.asSoldRevenue || 0) + '</b> Cost: <b>' + formatCurrency(cost) + '</b> <b style="color:' + pColor + ';">' + (ph.pctComplete || 0) + '%</b></span>';
            }
            if (type === 't1') {
                var bldg = appData.buildings.find(function(b) { return b.id === d.id; });
                if (!bldg) return '';
                return '<span style="color:var(--text-dim);font-size:10px;">Budget: <b style="color:var(--accent);">' + formatCurrency(bldg.budget || 0) + '</b></span>';
            }
            if (type === 'sub') {
                var sub = appData.subs.find(function(s) { return s.id === d.id; });
                if (!sub) return '';
                return '<span style="color:var(--text-dim);font-size:10px;">Contract: <b style="color:var(--accent);">' + formatCurrency(sub.contractAmt || 0) + '</b> Billed: <b style="color:var(--green);">' + formatCurrency(sub.billedToDate || 0) + '</b></span>';
            }
            if (type === 'co') {
                var co = appData.changeOrders.find(function(c) { return c.id === d.id; });
                if (!co) return '';
                var allocStr = item.allocPct != null && item.allocPct !== 100 ? ' (' + item.allocPct + '%)' : '';
                return '<span style="color:var(--text-dim);font-size:10px;">Inc: <b style="color:var(--green);">' + formatCurrency(co.income || 0) + '</b>' + allocStr + ' Cost: <b>' + formatCurrency(co.estimatedCosts || 0) + '</b></span>';
            }
            if (type === 'po') {
                var po = appData.purchaseOrders.find(function(p) { return p.id === d.id; });
                if (!po) return '';
                return '<span style="color:var(--text-dim);font-size:10px;">Amt: <b>' + formatCurrency(po.amount || 0) + '</b> Billed: <b style="color:var(--green);">' + formatCurrency(po.billedToDate || 0) + '</b></span>';
            }
            if (type === 'inv') {
                var inv = appData.invoices.find(function(iv) { return iv.id === d.id; });
                if (!inv) return '';
                return '<span style="color:var(--text-dim);font-size:10px;">Amt: <b>' + formatCurrency(inv.amount || 0) + '</b></span>';
            }
            return '';
        }

        function connTypeIcon(type) {
            var icons = { t1: '&#x1F3D7;', t2: '&#x1F4CB;', sub: '&#x1F477;', co: '&#x1F4DD;', po: '&#x1F4C4;', inv: '&#x1F4B3;', wip: '&#x1F4CA;', watch: '&#x1F4CA;' };
            return icons[type] || '';
        }

        function renderConnectionList(conns) {
            if (!conns.length) return '<div style="font-size:11px;color:var(--text-dim);font-style:italic;">Not placed on graph yet</div>';
            var html = '<div style="display:flex;flex-direction:column;gap:3px;">';
            conns.forEach(function(c, ci) {
                // Collect all connected items (targets and sources)
                var items = [];
                c.targets.forEach(function(t) { items.push({ dir: 'out', item: t }); });
                c.sources.forEach(function(s) { items.push({ dir: 'in', item: s }); });
                if (items.length === 0) {
                    html += '<div style="font-size:11px;padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text-dim);">' +
                        '<span style="color:var(--purple);font-weight:600;">#' + (ci + 1) + '</span> Unconnected</div>';
                    return;
                }
                items.forEach(function(entry) {
                    var it = entry.item;
                    var arrow = entry.dir === 'out' ? '&rarr;' : '&larr;';
                    var arrowColor = entry.dir === 'out' ? 'var(--green)' : 'var(--accent)';
                    var details = lookupConnDetails(it);
                    html += '<div style="font-size:11px;padding:5px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
                        '<div style="display:flex;align-items:center;gap:6px;">' +
                        '<span style="color:' + arrowColor + ';">' + arrow + '</span>' +
                        '<span>' + connTypeIcon(it.nodeType) + '</span>' +
                        '<span style="font-weight:600;color:var(--text);">' + escapeHTML(it.label) + '</span>' +
                        '</div>' +
                        (details ? '<div>' + details + '</div>' : '') +
                        '</div>';
                });
            });
            html += '</div>';
            return html;
        }

        function ensureNGLoaded(jobId) {
            if (typeof NG === 'undefined' || !jobId) return false;
            if (NG.job() === jobId && NG.nodes().length > 0) return true;
            NG.job(jobId);
            NG.setNodes([]); NG.setWires([]); NG.setNid(1);
            return NG.loadGraph();
        }

        // Loads the graph AND runs a silent compute so job.ngActualCosts /
        // ngAccruedCosts / phase costs are current before overview + sticky
        // metrics read them. Safe to call repeatedly.
        function ensureNGComputed(jobId) {
            if (!ensureNGLoaded(jobId)) return false;
            if (typeof window.ngPushToJob === 'function') {
                try { window.ngPushToJob(); } catch (e) {}
            }
            return true;
        }

        function getNodeGraphConnections(type, dataId) {
            if (typeof NG === 'undefined') return [];
            ensureNGLoaded(appState.currentJobId);
            var nodes = NG.nodes(), wires = NG.wires();
            var instances = nodes.filter(function(n) { return n.type === type && n.data && n.data.id === dataId; });
            var conns = [];
            instances.forEach(function(n) {
                var outWires = wires.filter(function(w) { return w.fromNode === n.id; });
                var inWires = wires.filter(function(w) { return w.toNode === n.id; });
                var targets = outWires.map(function(w) {
                    var tn = NG.findNode(w.toNode);
                    return tn ? { label: tn.label, type: tn.type, port: w.toPort, data: tn.data, nodeType: tn.type } : null;
                }).filter(Boolean);
                var sources = inWires.map(function(w) {
                    var fn = NG.findNode(w.fromNode);
                    return fn ? { label: fn.label, type: fn.type, port: w.fromPort, data: fn.data, nodeType: fn.type, allocPct: w.allocPct } : null;
                }).filter(Boolean);
                conns.push({ nodeId: n.id, label: n.label, targets: targets, sources: sources });
            });
            return conns;
        }

        // Find COs that wire (in node graph) to a particular T1/T2 by data.id.
        // Returns array of { co (appData entry), wireAllocPct }.
        function getCOsConnectedTo(targetType, targetDataId) {
            if (typeof NG === 'undefined') return [];
            ensureNGLoaded(appState.currentJobId);
            var nodes = NG.nodes(), wires = NG.wires();
            var targetNodes = nodes.filter(function(n) { return n.type === targetType && n.data && n.data.id === targetDataId; });
            var targetIds = {};
            targetNodes.forEach(function(n) { targetIds[n.id] = 1; });
            var results = [];
            wires.forEach(function(w) {
                if (!targetIds[w.toNode]) return;
                var src = NG.findNode(w.fromNode);
                if (!src || src.type !== 'co' || !src.data || !src.data.id) return;
                var coEntry = appData.changeOrders.find(function(c) { return c.id === src.data.id; });
                if (!coEntry) return;
                results.push({ co: coEntry, allocPct: w.allocPct != null ? w.allocPct : 100 });
            });
            return results;
        }

        // Find phases (T2 nodes) wired to a particular building (T1 node) in the node graph.
        // Returns array of { phase (appData entry), allocPct, t2NodeId }, deduplicated by phase.id.
        function getPhasesWiredToBuilding(buildingId) {
            if (typeof NG === 'undefined') return [];
            ensureNGLoaded(appState.currentJobId);
            var nodes = NG.nodes(), wires = NG.wires();
            var t1Nodes = nodes.filter(function(n) { return n.type === 't1' && n.data && n.data.id === buildingId; });
            var t1Ids = {};
            t1Nodes.forEach(function(n) { t1Ids[n.id] = 1; });
            var seen = {};
            var results = [];
            wires.forEach(function(w) {
                if (!t1Ids[w.toNode]) return;
                var src = NG.findNode(w.fromNode);
                if (!src || src.type !== 't2' || !src.data || !src.data.id) return;
                var phEntry = appData.phases.find(function(p) { return p.id === src.data.id; });
                if (!phEntry) return;
                var key = phEntry.id + '|' + src.id;
                if (seen[key]) return;
                seen[key] = 1;
                results.push({ phase: phEntry, allocPct: w.allocPct != null ? w.allocPct : 100, t2NodeId: src.id });
            });
            return results;
        }

        function renderConnectionBadges(conns) {
            return renderConnectionList(conns);
        }

        function renderOverviewPhasesInto(container, jobId, phases) {
            container.innerHTML = '';
            const phaseGroups = {};
            phases.forEach(p => {
                var key = p.phase || 'Unnamed';
                if (!phaseGroups[key]) phaseGroups[key] = [];
                phaseGroups[key].push(p);
            });

            const groupKeys = Object.keys(phaseGroups).sort();
            let totalRev = 0, totalCost = 0;
            groupKeys.forEach(k => {
                phaseGroups[k].forEach(r => {
                    totalRev += r.asSoldRevenue || 0;
                    totalCost += (r.materials || 0) + (r.labor || 0) + (r.sub || 0) + (r.equipment || 0);
                });
            });
            const totalProfit = totalRev - totalCost;

            const headerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
                    '<h3 style="font-size:13px;margin:0;">&#x1F4CB; Phases (' + groupKeys.length + ')</h3>' +
                    '<div style="font-size:12px;color:var(--text-dim);">Rev: <b style="color:var(--green);">' + formatCurrency(totalRev) + '</b> &nbsp; Cost: <b>' + formatCurrency(totalCost) + '</b> &nbsp; Profit: <b style="color:' + (totalProfit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(totalProfit) + '</b></div>' +
                '</div>';
            container.innerHTML = headerHTML;

            if (groupKeys.length === 0) {
                container.innerHTML += '<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:12px;">No phases yet. Click + Phase above to add one.</div>';
                return;
            }

            groupKeys.forEach(phaseName => {
                const phaseList = phaseGroups[phaseName];
                const revTotal = phaseList.reduce((s, p) => s + (p.asSoldRevenue || 0), 0);
                const matTotal = phaseList.reduce((s, p) => s + (p.materials || 0), 0);
                const labTotal = phaseList.reduce((s, p) => s + (p.labor || 0), 0);
                const subTotal = phaseList.reduce((s, p) => s + (p.sub || 0), 0);
                const equipTotal = phaseList.reduce((s, p) => s + (p.equipment || 0), 0);
                const costTotal = matTotal + labTotal + subTotal + equipTotal;
                const avgPct = Math.round(phaseList.reduce((s, p) => s + (p.pctComplete || 0), 0) / phaseList.length);
                const uid = 'ph-grp-' + phaseName.replace(/\W/g, '_');

                var card = document.createElement('div');
                card.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:6px;overflow:hidden;';

                var hdr = '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:pointer;user-select:none;" onclick="var d=document.getElementById(\'' + uid + '\');d.style.display=d.style.display===\'none\'?\'block\':\'none\';this.querySelector(\'.ph-arrow\').textContent=d.style.display===\'none\'?\'\\u25B6\':\'\\u25BC\';">' +
                    '<div style="display:flex;align-items:center;gap:10px;">' +
                    '<span class="ph-arrow" style="font-size:10px;color:var(--text-dim);">&#x25B6;</span>' +
                    '<span style="font-weight:700;font-size:14px;color:var(--text);">' + escapeHTML(phaseName) + '</span>' +
                    '<span style="font-size:11px;color:var(--text-dim);">' + phaseList.length + ' instance' + (phaseList.length > 1 ? 's' : '') + '</span>' +
                    '</div>' +
                    '<div style="display:flex;gap:14px;font-size:12px;">' +
                    '<span style="color:var(--text-dim);">Rev: <strong style="color:var(--green);">' + formatCurrency(revTotal) + '</strong></span>' +
                    '<span style="color:var(--text-dim);">Cost: <strong style="color:var(--orange);">' + formatCurrency(costTotal) + '</strong></span>' +
                    '<span style="color:var(--text-dim);">Avg: <strong style="color:var(--accent);">' + avgPct + '%</strong></span>' +
                    '</div></div>';

                var body = '<div id="' + uid + '" style="display:none;border-top:1px solid var(--border);padding:8px 12px;background:var(--surface2);">';
                phaseList.forEach(function(p) {
                    var bldg = appData.buildings.find(function(b) { return b.id === p.buildingId; });
                    var bldgName = bldg ? bldg.name : '?';
                    var conns = getNodeGraphConnections('t2', p.id);
                    body += '<div style="padding:6px 0;border-bottom:1px solid var(--border);">' +
                        '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">' +
                        '<div>' +
                        '<span style="font-size:13px;font-weight:600;color:var(--text);">' + escapeHTML(bldgName) + '</span>' +
                        '<span style="font-size:11px;color:var(--text-dim);margin-left:8px;">Rev: ' + formatCurrency(p.asSoldRevenue || 0) + ' | Mat: ' + formatCurrency(p.materials || 0) + ' | Lab: ' + formatCurrency(p.labor || 0) + ' | Sub: ' + formatCurrency(p.sub || 0) + ' | Equip: ' + formatCurrency(p.equipment || 0) + '</span>' +
                        '</div>' +
                        '<button class="ee-btn ghost" onclick="editPhase(\'' + escapeHTML(p.id) + '\')">&#x270F;&#xFE0F; Edit</button>' +
                        '</div>' +
                        '<div style="margin-top:4px;">' + renderConnectionList(conns) + '</div>' +
                        '</div>';
                });
                body += '</div>';
                card.innerHTML = hdr + body;
                container.appendChild(card);
            });
        }

        function renderJobPhases(jobId) {
            const phases = appData.phases.filter(p => p.jobId === jobId);
            const container = document.getElementById('job-phases-cards');
            if (container) renderOverviewPhasesInto(container, jobId, phases);
        }

        function renderOverviewSubsInto(container, jobId, subs) {
            container.innerHTML = '';
            let totalContract = 0, totalBilled = 0;

            const headerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
                '<h3 style="font-size:13px;margin:0;">&#x1F477; Subcontractors (' + subs.length + ')</h3>' +
                '<div id="' + container.id + '-totals" style="font-size:12px;color:var(--text-dim);"></div>' +
                '</div>';
            container.innerHTML = headerHTML;

            if (subs.length === 0) {
                container.innerHTML += '<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:12px;">No subcontractors yet.</div>';
                return;
            }

            subs.forEach(sub => {
                const contract = sub.contractAmt || 0;
                const billed = sub.billedToDate || 0;
                const remaining = contract - billed;
                const pctBilled = contract > 0 ? ((billed / contract) * 100).toFixed(1) : '0.0';
                totalContract += contract;
                totalBilled += billed;

                const conns = getNodeGraphConnections('sub', sub.id);
                const uid = 'sub-grp-' + sub.id.replace(/\W/g, '_');

                var card = document.createElement('div');
                card.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden;';

                var hdr = '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:pointer;user-select:none;" onclick="var d=document.getElementById(\'' + uid + '\');d.style.display=d.style.display===\'none\'?\'block\':\'none\';this.querySelector(\'.ph-arrow\').textContent=d.style.display===\'none\'?\'\\u25B6\':\'\\u25BC\';">' +
                    '<div style="display:flex;align-items:center;gap:10px;">' +
                    '<span class="ph-arrow" style="font-size:10px;color:var(--text-dim);">&#x25B6;</span>' +
                    '<span style="font-weight:700;font-size:14px;color:var(--text);">' + escapeHTML(sub.name) + '</span>' +
                    '<span style="font-size:11px;color:var(--text-dim);">' + escapeHTML(sub.trade || '') + '</span>' +
                    (conns.length > 0 ? '<span style="font-size:10px;padding:1px 6px;border-radius:10px;background:var(--accent-dim);color:var(--accent);">' + conns.length + ' node' + (conns.length > 1 ? 's' : '') + '</span>' : '') +
                    '</div>' +
                    '<div style="display:flex;gap:16px;font-size:12px;align-items:center;">' +
                    '<span style="color:var(--text-dim);">Contract: <strong style="color:var(--accent);">' + formatCurrency(contract) + '</strong></span>' +
                    '<span style="color:var(--text-dim);">Billed: <strong style="color:var(--green);">' + formatCurrency(billed) + '</strong></span>' +
                    '<span style="color:var(--text-dim);">Rem: <strong style="color:var(--orange);">' + formatCurrency(remaining) + '</strong></span>' +
                    '<span style="color:var(--text-dim);">' + pctBilled + '%</span>' +
                    '<button class="ee-btn ghost" onclick="event.stopPropagation();editSub(\'' + escapeHTML(sub.id) + '\')">&#x270F;&#xFE0F; Edit</button>' +
                    '</div></div>';

                var body = '<div id="' + uid + '" style="display:none;border-top:1px solid var(--border);padding:10px 14px;">';
                if (sub.notes) {
                    body += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">' + escapeHTML(sub.notes) + '</div>';
                }
                body += '<div style="font-size:12px;font-weight:600;color:var(--text-dim);margin-bottom:6px;">Node Graph Connections</div>';
                if (conns.length === 0) {
                    body += '<div style="font-size:11px;color:var(--text-dim);font-style:italic;">Not placed on graph yet</div>';
                } else {
                    conns.forEach(function(c, i) {
                        var wireDesc = [];
                        c.targets.forEach(function(t) { wireDesc.push('<span style="color:var(--green);">&rarr; ' + escapeHTML(t.label) + '</span>'); });
                        c.sources.forEach(function(s) { wireDesc.push('<span style="color:var(--accent);">' + escapeHTML(s.label) + ' &rarr;</span>'); });
                        body += '<div style="padding:4px 8px;margin:3px 0;background:var(--surface2);border-radius:4px;font-size:11px;display:flex;align-items:center;gap:8px;">' +
                            '<span style="color:var(--purple);font-weight:600;">Instance #' + (i + 1) + '</span>' +
                            (wireDesc.length ? wireDesc.join(' ') : '<span style="color:var(--text-dim);">Unconnected</span>') +
                            '</div>';
                    });
                }
                body += '</div>';
                card.innerHTML = hdr + body;
                container.appendChild(card);
            });

            // Inline totals in section header
            const totalRemaining = totalContract - totalBilled;
            const totalsEl = document.getElementById(container.id + '-totals');
            if (totalsEl) {
                totalsEl.innerHTML = 'Contract: <b style="color:var(--accent);">' + formatCurrency(totalContract) +
                    '</b> &nbsp; Billed: <b style="color:var(--green);">' + formatCurrency(totalBilled) +
                    '</b> &nbsp; Rem: <b style="color:var(--orange);">' + formatCurrency(totalRemaining) + '</b>';
            }
        }

        function renderJobSubs(jobId) {
            const subs = appData.subs.filter(s => s.jobId === jobId);
            const container = document.getElementById('job-subs-cards');
            if (container) renderOverviewSubsInto(container, jobId, subs);
        }

        function renderJobLabor(jobId) {
            const phases = appData.phases.filter(p => p.jobId === jobId);
            const tbody = document.querySelector('#job-labor-table tbody');
            tbody.innerHTML = '';

            phases.forEach(p => {
                const building = appData.buildings.find(b => b.id === p.buildingId);
                const laborCost = p.labor || 0;
                const computedLabor = (p.hoursTotal || 0) * (p.rate || 40);

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHTML(building?.name) || ''}</td>
                    <td>${escapeHTML(p.phase)}</td>
                    <td style="text-align: right;">${p.hoursWeek || 0}</td>
                    <td style="text-align: right;">${p.hoursTotal || 0}</td>
                    <td style="text-align: right;">${formatCurrency(p.rate || 40)}</td>
                    <td style="text-align: right;">${formatCurrency(laborCost)}</td>
                    <td style="text-align: right;">${formatCurrency(computedLabor)}</td>
                `;
                tbody.appendChild(row);
            });
        }

        // renderJobWeekly retired — Thursday WIP Meeting Accruals were a manual
        // weekly capture workflow. Daily auto-snapshots (3 AM EST) replace the
        // need for it. Per-phase weeklyMat/weeklyLabor/weeklySub/weeklyEquip
        // fields are no longer set on new phases.

        function renderJobCosts(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            document.getElementById('jobCostMaterials').value = job.materials || '';
            document.getElementById('jobCostLabor').value = job.labor || '';
            document.getElementById('jobCostSub').value = (job.sub || 0).toFixed(2);
            document.getElementById('jobCostEquipment').value = job.equipment || '';
            document.getElementById('jobCostGC').value = job.generalConditions || '';
            document.getElementById('jobCostHoursWeek').value = job.hoursWeek || '';
            document.getElementById('jobCostHoursTotal').value = job.hoursTotal || '';
            document.getElementById('jobCostRate').value = job.rate || 40;
            updateJobCostSummary(jobId);
        }

        function saveJobCosts() {
            const job = appData.jobs.find(j => j.id === appState.currentJobId);
            if (!job) return;
            job.materials = parseFloat(document.getElementById('jobCostMaterials').value) || 0;
            job.labor = parseFloat(document.getElementById('jobCostLabor').value) || 0;
            // job.sub is auto-calculated from Subs tab by recalcSubCosts — don't overwrite
            job.equipment = parseFloat(document.getElementById('jobCostEquipment').value) || 0;
            job.generalConditions = parseFloat(document.getElementById('jobCostGC').value) || 0;
            job.hoursWeek = parseFloat(document.getElementById('jobCostHoursWeek').value) || 0;
            job.hoursTotal = (parseFloat(document.getElementById('jobCostHoursTotal').value) || 0) + job.hoursWeek;
            job.rate = parseFloat(document.getElementById('jobCostRate').value) || 40;
            // Update total hours display and reset weekly hours
            document.getElementById('jobCostHoursTotal').value = job.hoursTotal;
            document.getElementById('jobCostHoursWeek').value = '';
            saveData();
            updateJobCostSummary(appState.currentJobId);
            // Update the summary cards using WIP
            renderJobDetail(appState.currentJobId);
            // Show save confirmation
            const statusEl = document.getElementById('jobCostSaveStatus');
            if (statusEl) {
                statusEl.textContent = 'Saved!';
                statusEl.style.opacity = '1';
                clearTimeout(statusEl._timer);
                statusEl._timer = setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);
            }
        }

        function updateJobCostSummary(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            const jobLevelTotal = (job.materials || 0) + (job.labor || 0) + (job.sub || 0) + (job.equipment || 0);
            const computedLabor = (job.hoursTotal || 0) * (job.rate || 40);
            const costs = getJobTotalCost(jobId);
            const phaseBuildingCost = costs.phaseCost + costs.buildingCost;
            document.getElementById('jobCostTotal').textContent = formatCurrency(jobLevelTotal);
            document.getElementById('jobCostLaborBurden').textContent = formatCurrency(computedLabor);
            document.getElementById('jobCostFromPhases').textContent = formatCurrency(phaseBuildingCost);
        }

        function getJobContractAmount() {
            const job = appData.jobs.find(j => j.id === appState.currentJobId);
            return job ? (job.contractAmount || 0) : 0;
        }

        function syncBuildingBudgetFromPct() {
            syncBuildingBudgetFromDollar();
        }

        function syncBuildingBudgetFromDollar() {
            const dollars = parseFloat(document.getElementById('buildingBudget').value) || 0;
            const allBldgs = appData.buildings.filter(b => b.jobId === appState.currentJobId);
            const editId = appState.editBuildingId;
            const otherBudget = allBldgs.reduce(function(s, b) {
                return s + (b.id === editId ? 0 : (b.budget || 0));
            }, 0);
            const total = otherBudget + dollars;
            const pct = total > 0 ? (dollars / total * 100) : 0;
            document.getElementById('buildingBudgetPct').value = pct.toFixed(1);
            const coBudget = editId ? (allBldgs.find(b => b.id === editId)?.coBudget || 0) : 0;
            var hint = pct.toFixed(1) + '% of job (' + formatCurrency(total) + ' total)';
            if (coBudget) hint += ' \u00b7 includes ' + formatCurrency(coBudget) + ' from COs';
            document.getElementById('buildingBudgetHint').textContent = hint;
            updatePhaseBreakdownRemaining();
        }

        function openAddBuildingToJobModal() {
            appState.editBuildingId = null;
            document.getElementById('buildingModalHeader').textContent = 'Add Building';
            document.getElementById('saveBuildingBtn').innerHTML = '&#x1F3D7; Add Building';
            document.getElementById('deleteBuildingBtn').style.display = 'none';
            document.getElementById('buildingName').value = '';
            document.getElementById('buildingBudgetPct').value = '';
            document.getElementById('buildingBudget').value = '';
            document.getElementById('buildingBudgetHint').textContent = 'Contract: ' + formatCurrency(getJobContractAmount());
            document.getElementById('buildingAddress').value = '';
            document.getElementById('buildingMaterials').value = '';
            document.getElementById('buildingLabor').value = '';
            document.getElementById('buildingSub').value = '0.00';
            document.getElementById('buildingEquipment').value = '';
            document.getElementById('buildingHoursWeek').value = '';
            document.getElementById('buildingHoursTotal').value = '';
            document.getElementById('buildingRate').value = '40';
            document.getElementById('buildingWorkScope').value = 'in-house';
            document.getElementById('buildingLocked').checked = false;
            document.getElementById('buildingExcludeSubDist').checked = false;
            document.getElementById('buildingPhaseBreakdown').style.display = 'none';
            openModal('addBuildingModal');
        }

        function editBuilding(buildingId) {
            const building = appData.buildings.find(b => b.id === buildingId);
            if (!building) return;

            appState.editBuildingId = buildingId;
            document.getElementById('buildingModalHeader').textContent = 'Edit Building';
            document.getElementById('saveBuildingBtn').innerHTML = '&#x1F4BE; Save Changes';
            document.getElementById('deleteBuildingBtn').style.display = 'inline-block';
            document.getElementById('buildingName').value = building.name || '';
            document.getElementById('buildingBudget').value = building.asSoldBudget || building.budget || '';
            document.getElementById('buildingAddress').value = building.address || '';
            document.getElementById('buildingMaterials').value = building.materials || '';
            document.getElementById('buildingLabor').value = building.labor || '';
            document.getElementById('buildingSub').value = getSubCostForBuilding(building.id, building.jobId || appState.currentJobId).toFixed(2);
            document.getElementById('buildingEquipment').value = building.equipment || '';
            document.getElementById('buildingHoursWeek').value = '';
            document.getElementById('buildingHoursTotal').value = building.hoursTotal || '';
            document.getElementById('buildingRate').value = building.rate || 40;

            syncBuildingBudgetFromDollar();
            document.getElementById('buildingWorkScope').value = building.workScope || 'in-house';
            document.getElementById('buildingLocked').checked = building.locked || false;
            document.getElementById('buildingExcludeSubDist').checked = building.excludeFromSubDist || false;
            renderBuildingPhaseBreakdown(buildingId);
            renderBuildingCOBreakdown(buildingId);
            openModal('addBuildingModal');
        }

        function renderBuildingPhaseBreakdown(buildingId) {
            const wrap = document.getElementById('buildingPhaseBreakdown');
            const rowsEl = document.getElementById('bldgPhaseRows');
            if (!buildingId) { wrap.style.display = 'none'; return; }
            const phases = appData.phases.filter(p => p.buildingId === buildingId);
            if (phases.length === 0 && !appState.editBuildingId) { wrap.style.display = 'none'; return; }
            wrap.style.display = 'block';
            rowsEl.innerHTML = '';

            phases.forEach(function(p) {
                const asSold = p.asSoldPhaseBudget || p.phaseBudget || 0;
                const co = p.coPhaseBudget || 0;
                const total = asSold + co;
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);';
                row.innerHTML =
                    '<span style="flex:1;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(p.phase) +
                    ' <span style="font-size:10px;color:' + (p.pctComplete >= 100 ? 'var(--green)' : p.pctComplete >= 50 ? '#f59e0b' : 'var(--text-dim)') + ';">' + (p.pctComplete||0) + '%</span></span>' +
                    '<input type="number" data-phase-id="' + p.id + '" value="' + asSold + '" step="0.01" style="width:110px;font-size:12px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);text-align:right;" oninput="onPhaseBreakdownInput(this)">' +
                    (co ? '<span style="font-size:10px;color:var(--green);white-space:nowrap;">+' + formatCurrency(co) + ' CO</span>' : '') +
                    '<span style="font-size:12px;font-weight:600;color:var(--accent);width:90px;text-align:right;">' + formatCurrency(total) + '</span>' +
                    '<button type="button" onclick="removePhaseFromBreakdown(\'' + p.id + '\')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;padding:2px 4px;" title="Delete phase">&times;</button>';
                rowsEl.appendChild(row);
            });

            updatePhaseBreakdownRemaining();
        }

        function onPhaseBreakdownInput(input) {
            const phaseId = input.getAttribute('data-phase-id');
            const phase = appData.phases.find(p => p.id === phaseId);
            if (!phase) return;
            const val = parseFloat(input.value) || 0;
            phase.asSoldPhaseBudget = val;
            phase.phaseBudget = val + (phase.coPhaseBudget || 0);
            const totalSpan = input.parentElement.querySelector('span[style*="width:90px"]');
            if (totalSpan) totalSpan.textContent = formatCurrency(phase.phaseBudget);
            updatePhaseBreakdownRemaining();
        }

        function updatePhaseBreakdownRemaining() {
            const el = document.getElementById('bldgPhaseRemaining');
            if (!el || !appState.editBuildingId) return;
            const bldgBudget = parseFloat(document.getElementById('buildingBudget').value) || 0;
            const phases = appData.phases.filter(p => p.buildingId === appState.editBuildingId);
            const allocated = phases.reduce((s, p) => s + (p.asSoldPhaseBudget || p.phaseBudget || 0), 0);
            const remaining = bldgBudget - allocated;
            el.textContent = 'Allocated: ' + formatCurrency(allocated) + ' · Remaining: ' + formatCurrency(remaining);
            el.style.color = remaining < 0 ? 'var(--red)' : remaining === 0 ? 'var(--green)' : 'var(--yellow)';
        }

        function addPhaseFromBuildingModal() {
            if (!appState.editBuildingId) return;
            const phaseName = prompt('Phase name (e.g., Electrical, Plumbing):');
            if (!phaseName || !phaseName.trim()) return;
            const phase = {
                id: 'p' + Date.now(),
                jobId: appState.currentJobId,
                buildingId: appState.editBuildingId,
                phase: phaseName.trim(),
                workScope: 'in-house',
                locked: false,
                pctComplete: 0,
                materials: 0, labor: 0, sub: 0, equipment: 0,
                asSoldPhaseBudget: 0,
                coPhaseBudget: 0,
                phaseBudget: 0,
                hoursWeek: 0, hoursTotal: 0, rate: 40,
                notes: ''
            };
            appData.phases.push(phase);
            renderBuildingPhaseBreakdown(appState.editBuildingId);
        }

        function removePhaseFromBreakdown(phaseId) {
            if (!confirm('Delete this phase?')) return;
            appData.phases = appData.phases.filter(p => p.id !== phaseId);
            renderBuildingPhaseBreakdown(appState.editBuildingId);
        }

        function cosForBuilding(buildingId) {
            if (!buildingId) return [];
            const phaseIds = appData.phases.filter(p => p.buildingId === buildingId).map(p => p.id);
            return appData.changeOrders.filter(function(c) {
                if (!c.allocations || !c.allocations.length) return false;
                return c.allocations.some(function(a) {
                    return a.buildingId === buildingId || (a.phaseId && phaseIds.indexOf(a.phaseId) > -1);
                });
            });
        }

        function renderBuildingCOBreakdown(buildingId) {
            const wrap = document.getElementById('buildingCOBreakdown');
            const rowsEl = document.getElementById('bldgCORows');
            if (!wrap || !rowsEl) return;
            if (!buildingId) { wrap.style.display = 'none'; return; }
            wrap.style.display = 'block';
            rowsEl.innerHTML = '';
            const cos = cosForBuilding(buildingId);
            if (cos.length === 0) {
                rowsEl.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:6px 2px;">No change orders linked to this building yet.</div>';
            }
            cos.forEach(function(co) {
                const inc = co.income || 0;
                const cost = co.estimatedCosts || 0;
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);';
                row.innerHTML =
                    '<span style="flex:1;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                    (co.coNumber ? '<span style="font-size:10px;color:var(--text-dim);margin-right:4px;">' + escapeHTML(co.coNumber) + '</span>' : '') +
                    escapeHTML(co.description || 'CO') + '</span>' +
                    '<input type="number" data-co-id="' + co.id + '" data-field="income" value="' + inc + '" step="0.01" title="Income (budget add)" style="width:100px;font-size:12px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--green);text-align:right;" oninput="onCOBreakdownInput(this)">' +
                    '<input type="number" data-co-id="' + co.id + '" data-field="estimatedCosts" value="' + cost + '" step="0.01" title="Estimated cost" style="width:100px;font-size:12px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--yellow);text-align:right;" oninput="onCOBreakdownInput(this)">' +
                    '<button type="button" onclick="removeCOFromBreakdown(\'' + co.id + '\')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;padding:2px 4px;" title="Delete CO">&times;</button>';
                rowsEl.appendChild(row);
            });
            updateCOBreakdownTotals(buildingId);
        }

        function updateCOBreakdownTotals(buildingId) {
            const el = document.getElementById('bldgCOTotals');
            if (!el) return;
            const cos = cosForBuilding(buildingId);
            const inc = cos.reduce((s, c) => s + (c.income || 0), 0);
            const cost = cos.reduce((s, c) => s + (c.estimatedCosts || 0), 0);
            el.textContent = 'Income: ' + formatCurrency(inc) + ' · Cost: ' + formatCurrency(cost);
            el.style.color = 'var(--text-dim)';
        }

        function onCOBreakdownInput(input) {
            const coId = input.getAttribute('data-co-id');
            const field = input.getAttribute('data-field');
            const co = appData.changeOrders.find(c => c.id === coId);
            if (!co) return;
            const val = parseFloat(input.value) || 0;
            co[field] = val;
            updateCOBreakdownTotals(appState.editBuildingId);
        }

        function addCOFromBuildingModal() {
            if (!appState.editBuildingId) return;
            const desc = prompt('CO description:');
            if (!desc || !desc.trim()) return;
            const incomeStr = prompt('Income (budget addition) $:', '0');
            const costStr = prompt('Estimated cost $:', '0');
            const co = {
                id: 'co' + Date.now(),
                jobId: appState.currentJobId,
                coNumber: '',
                description: desc.trim(),
                income: parseFloat(incomeStr) || 0,
                estimatedCosts: parseFloat(costStr) || 0,
                date: new Date().toISOString().split('T')[0],
                notes: '',
                allocationType: 'building',
                allocations: [{
                    buildingId: appState.editBuildingId,
                    income: parseFloat(incomeStr) || 0,
                    estimatedCosts: parseFloat(costStr) || 0
                }]
            };
            appData.changeOrders.push(co);
            if (typeof saveData === 'function') saveData();
            renderBuildingCOBreakdown(appState.editBuildingId);
        }

        function removeCOFromBreakdown(coId) {
            if (!confirm('Delete this change order?')) return;
            appData.changeOrders = appData.changeOrders.filter(c => c.id !== coId);
            if (typeof saveData === 'function') saveData();
            renderBuildingCOBreakdown(appState.editBuildingId);
        }

        function deleteBuilding() {
            if (!appState.editBuildingId) return;
            const phases = appData.phases.filter(p => p.buildingId === appState.editBuildingId);
            if (phases.length > 0) {
                if (!confirm('This building has ' + phases.length + ' phase(s). Delete the building AND all its phases?')) return;
                appData.phases = appData.phases.filter(p => p.buildingId !== appState.editBuildingId);
            } else {
                if (!confirm('Delete this building?')) return;
            }
            appData.buildings = appData.buildings.filter(b => b.id !== appState.editBuildingId);
            appState.editBuildingId = null;
            saveData();
            closeModal('addBuildingModal');
            renderJobDetail(appState.currentJobId);
        }

        function autoBalancePhasePcts() {
            const jobId = appState.currentJobId;
            const buildingId = document.getElementById('phaseBuilding').value;
            if (!buildingId) { alert('Select a building first'); return; }
            const bldg = appData.buildings.find(b => b.id === buildingId);
            if (!bldg || !bldg.budget) { alert('Building has no budget set'); return; }
            const phases = appData.phases.filter(p => p.jobId === jobId && p.buildingId === buildingId);
            const lockedBudget = phases.filter(p => p.locked).reduce((sum, p) => sum + (p.phaseBudget || 0), 0);
            const unlocked = phases.filter(p => !p.locked);
            if (unlocked.length === 0) return;
            const remaining = Math.max(0, bldg.budget - lockedBudget);
            const each = remaining / unlocked.length;
            unlocked.forEach(p => {
                p.phaseBudget = Math.round(each * 100) / 100;
            });
            saveData();
            renderJobDetail(jobId);
        }

        function autoBalanceOnPhaseAdd(jobId, buildingId) {
            if (!buildingId) return;
            const bldg = appData.buildings.find(b => b.id === buildingId);
            if (!bldg || !bldg.budget) return;
            const phases = appData.phases.filter(p => p.jobId === jobId && p.buildingId === buildingId);
            const lockedBudget = phases.filter(p => p.locked).reduce((sum, p) => sum + (p.phaseBudget || 0), 0);
            const unlocked = phases.filter(p => !p.locked);
            if (unlocked.length === 0) return;
            const remaining = Math.max(0, bldg.budget - lockedBudget);
            const each = Math.round(remaining / unlocked.length * 100) / 100;
            unlocked.forEach(p => {
                p.phaseBudget = each;
            });
        }

        function autoBalanceBuildingPcts() {
            const jobId = appState.currentJobId;
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const lockedPct = buildings.filter(b => b.locked).reduce((sum, b) => sum + (b.budgetPct || 0), 0);
            const unlocked = buildings.filter(b => !b.locked);
            if (unlocked.length === 0) return;
            const remaining = Math.max(0, 100 - lockedPct);
            const each = remaining / unlocked.length;
            const contractAmt = appData.jobs.find(j => j.id === jobId)?.contractAmount || 0;
            unlocked.forEach(b => {
                b.budgetPct = Math.round(each * 10) / 10;
                b.budget = contractAmt > 0 ? Math.round(contractAmt * b.budgetPct / 100 * 100) / 100 : b.budget;
            });
            saveData();
            renderJobDetail(jobId);
        }

        function autoBalanceOnBuildingAdd(jobId) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const lockedPct = buildings.filter(b => b.locked).reduce((sum, b) => sum + (b.budgetPct || 0), 0);
            const unlocked = buildings.filter(b => !b.locked);
            if (unlocked.length === 0) return;
            const remaining = Math.max(0, 100 - lockedPct);
            const each = Math.round(remaining / unlocked.length * 10) / 10;
            const contractAmt = appData.jobs.find(j => j.id === jobId)?.contractAmount || 0;
            unlocked.forEach(b => {
                b.budgetPct = each;
                b.budget = contractAmt > 0 ? Math.round(contractAmt * each / 100 * 100) / 100 : b.budget;
            });
        }

        function saveBuilding() {
            const hoursWeek = parseFloat(document.getElementById('buildingHoursWeek').value) || 0;
            const hoursTotal = (parseFloat(document.getElementById('buildingHoursTotal').value) || 0) + hoursWeek;
            const rate = parseFloat(document.getElementById('buildingRate').value) || 40;
            const asSoldVal = parseFloat(document.getElementById('buildingBudget').value) || 0;
            const existingCO = appState.editBuildingId
                ? (appData.buildings.find(b => b.id === appState.editBuildingId)?.coBudget || 0) : 0;
            const formData = {
                name: document.getElementById('buildingName').value,
                asSoldBudget: asSoldVal,
                coBudget: existingCO,
                budget: asSoldVal + existingCO,
                address: document.getElementById('buildingAddress').value,
                workScope: document.getElementById('buildingWorkScope').value || 'in-house',
                locked: document.getElementById('buildingLocked').checked,
                excludeFromSubDist: document.getElementById('buildingExcludeSubDist').checked,
                materials: parseFloat(document.getElementById('buildingMaterials').value) || 0,
                labor: hoursTotal * rate,
                sub: 0, // auto-calculated from Subs tab by recalcSubCosts
                equipment: parseFloat(document.getElementById('buildingEquipment').value) || 0,
                hoursWeek: hoursWeek,
                hoursTotal: hoursTotal,
                rate: rate
            };

            if (appState.editBuildingId) {
                const idx = appData.buildings.findIndex(b => b.id === appState.editBuildingId);
                if (idx !== -1) {
                    Object.assign(appData.buildings[idx], formData);
                }
                appState.editBuildingId = null;
            } else {
                const building = Object.assign({
                    id: 'b' + Date.now(),
                    jobId: appState.currentJobId
                }, formData);
                appData.buildings.push(building);
            }
            saveData();
            closeModal('addBuildingModal');
            renderJobDetail(appState.currentJobId);
        }

        function getSelectedBuildingBudget() {
            const buildingId = document.getElementById('phaseBuilding').value;
            const building = appData.buildings.find(b => b.id === buildingId);
            return building ? (building.budget || 0) : 0;
        }

        function syncBudgetFromPct() {
            syncBudgetFromDollar();
        }

        function syncBudgetFromDollar() {
            const dollars = parseFloat(document.getElementById('phaseBudget').value) || 0;
            const bldgBudget = getSelectedBuildingBudget();
            const pct = bldgBudget > 0 ? (dollars / bldgBudget * 100) : 0;
            document.getElementById('phaseBudgetPct').value = pct.toFixed(1);
        }

        function openAddPhaseToJobModal(preselectedBuildingId) {
            appState.editPhaseId = null;
            document.getElementById('phaseModalHeader').textContent = 'Add Phase Entry';
            document.getElementById('savePhaseBtn').innerHTML = '&#x1F4CB; Add Phase';
            document.getElementById('deletePhaseBtn').style.display = 'none';

            const buildings = appData.buildings.filter(b => b.jobId === appState.currentJobId);
            const select = document.getElementById('phaseBuilding');
            select.innerHTML = '<option value="">-- Select Building --</option>';
            buildings.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.id;
                opt.textContent = b.name;
                if (preselectedBuildingId && b.id === preselectedBuildingId) opt.selected = true;
                select.appendChild(opt);
            });

            populatePhaseTypeSelect();
            document.getElementById('phaseType').value = '';
            document.getElementById('phaseAsSoldRevenue').value = '';
            document.getElementById('phasePercent').value = '0';
            document.getElementById('phaseMaterials').value = '';
            document.getElementById('phaseLabor').value = '';
            document.getElementById('phaseSub').value = '0.00';
            document.getElementById('phaseEquipment').value = '';
            document.getElementById('phaseBudgetPct').value = '';
            document.getElementById('phaseBudget').value = '';
            document.getElementById('phaseHoursWeek').value = '';
            document.getElementById('phaseHoursTotal').value = '';
            document.getElementById('phaseRate').value = '40';
            document.getElementById('phaseNotes').value = '';
            document.getElementById('phaseWorkScope').value = 'in-house';
            document.getElementById('phaseLocked').checked = false;
            document.getElementById('phaseBuildingWrap').style.display = '';
            document.getElementById('phaseConnectedWrap').style.display = 'none';
            openModal('addPhaseModal');
        }

        function editPhase(phaseId) {
            const phase = appData.phases.find(p => p.id === phaseId);
            if (!phase) return;

            appState.editPhaseId = phaseId;
            document.getElementById('phaseModalHeader').textContent = 'Edit Phase Entry';
            document.getElementById('savePhaseBtn').innerHTML = '&#x1F4BE; Save Changes';
            document.getElementById('deletePhaseBtn').style.display = 'inline-block';

            const buildings = appData.buildings.filter(b => b.jobId === phase.jobId);
            const select = document.getElementById('phaseBuilding');
            select.innerHTML = '<option value="">-- Select Building --</option>';
            buildings.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.id;
                opt.textContent = b.name;
                select.appendChild(opt);
            });
            select.value = phase.buildingId || '';

            // Determine graph wire connections. If the phase has multiple wired
            // buildings, show the connection list and hide the single-building
            // selector — connections are managed in the node graph.
            let wiredBldgs = [];
            if (typeof NG !== 'undefined') {
                try {
                    const ngNodes = NG.nodes();
                    const ngWires = NG.wires();
                    const t2 = ngNodes.find(n => n.type === 't2' && n.data && n.data.id === phase.id);
                    if (t2) {
                        ngWires.forEach(w => {
                            if (w.fromNode === t2.id) {
                                const t1 = ngNodes.find(n => n.id === w.toNode && n.type === 't1');
                                if (t1 && t1.data) {
                                    wiredBldgs.push({ name: (t1.data.name || 'Building'), pct: w.allocPct != null ? w.allocPct : 0 });
                                }
                            }
                        });
                    }
                } catch(e) {}
            }
            const hasMulti = wiredBldgs.length > 1;
            document.getElementById('phaseBuildingWrap').style.display = hasMulti ? 'none' : '';
            const connWrap = document.getElementById('phaseConnectedWrap');
            if (wiredBldgs.length > 0) {
                connWrap.style.display = '';
                const totalPct = wiredBldgs.reduce((s, b) => s + b.pct, 0);
                const pctOk = Math.abs(totalPct - 100) < 0.1 || totalPct === 0;
                document.getElementById('phaseConnectedList').innerHTML =
                    wiredBldgs.map(b =>
                        '<div style="display:flex;justify-content:space-between;padding:3px 0;">' +
                        '<span>' + escapeHTML(b.name) + '</span>' +
                        '<span style="color:var(--yellow);font-family:\'Courier New\',monospace;">' + b.pct.toFixed(1) + '%</span>' +
                        '</div>'
                    ).join('') +
                    '<div style="display:flex;justify-content:space-between;padding:4px 0 0;border-top:1px solid var(--border);margin-top:4px;font-weight:600;">' +
                        '<span>Total</span>' +
                        '<span style="color:' + (pctOk ? 'var(--green)' : 'var(--red)') + ';font-family:\'Courier New\',monospace;">' + totalPct.toFixed(1) + '% ' + (pctOk ? '\u2713' : '\u26A0') + '</span>' +
                    '</div>';
            } else {
                connWrap.style.display = 'none';
            }

            populatePhaseTypeSelect();
            if (phase.phase && !Array.from(document.getElementById('phaseType').options).some(o => o.value === phase.phase)) {
                const c = getCustomItems('agx-wip-custom-phases');
                if (!c.includes(phase.phase)) { c.push(phase.phase); saveCustomItems('agx-wip-custom-phases', c); populatePhaseTypeSelect(); }
            }
            document.getElementById('phaseType').value = phase.phase || '';
            document.getElementById('phaseAsSoldRevenue').value = phase.asSoldRevenue || '';
            document.getElementById('phasePercent').value = phase.pctComplete || 0;
            document.getElementById('phaseMaterials').value = phase.materials || '';
            document.getElementById('phaseLabor').value = phase.labor || '';
            document.getElementById('phaseSub').value = getSubCostForPhase(phase.id).toFixed(2);
            document.getElementById('phaseEquipment').value = phase.equipment || '';
            document.getElementById('phaseBudget').value = phase.asSoldPhaseBudget || phase.phaseBudget || '';
            syncBudgetFromDollar();
            document.getElementById('phaseHoursWeek').value = '';
            document.getElementById('phaseHoursTotal').value = phase.hoursTotal || '';
            document.getElementById('phaseRate').value = phase.rate || 40;
            document.getElementById('phaseNotes').value = phase.notes || '';
            document.getElementById('phaseWorkScope').value = phase.workScope || 'in-house';
            document.getElementById('phaseLocked').checked = phase.locked || false;
            openModal('addPhaseModal');
        }

        function deletePhase() {
            if (!appState.editPhaseId) return;
            if (!confirm('Delete this phase entry? This cannot be undone.')) return;
            appData.phases = appData.phases.filter(p => p.id !== appState.editPhaseId);
            appState.editPhaseId = null;
            saveData();
            closeModal('addPhaseModal');
            renderJobDetail(appState.currentJobId);
        }

        // ── Manage Phases Modal ──
        function openManagePhasesModal() {
            renderManagePhasesList();
            document.getElementById('managePhasesModal').classList.add('active');
        }

        function renderManagePhasesList() {
            const jobId = appState.currentJobId;
            const list = document.getElementById('managePhasesList');
            const phases = (appData.phases || []).filter(p => p.jobId === jobId);
            if (!phases.length) {
                list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);">No phases for this job yet.</div>';
                return;
            }
            // Group by phase name (case-insensitive)
            const groups = {};
            phases.forEach(p => {
                const key = (p.phase || 'Unnamed').trim().toLowerCase();
                if (!groups[key]) groups[key] = { name: p.phase || 'Unnamed', records: [] };
                groups[key].records.push(p);
            });
            let html = '';
            Object.keys(groups).sort().forEach(key => {
                const g = groups[key];
                const count = g.records.length;
                const totalRev = g.records.reduce((s, r) => s + (r.asSoldRevenue || 0), 0);
                const isDup = count > 1;
                const bldgNames = g.records.map(r => {
                    const b = appData.buildings.find(bb => bb.id === r.buildingId);
                    return b ? b.name : '(no building)';
                });
                html += '<div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:8px;background:var(--surface);">';
                html += '<div style="display:flex;gap:10px;align-items:center;">';
                html += '<input type="text" data-mp-name="' + key + '" value="' + escapeHTML(g.name) + '" style="flex:1;padding:6px 8px;background:var(--input-bg,#0f1117);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:13px;font-weight:600;" />';
                html += '<div style="font-size:11px;color:var(--text-dim);white-space:nowrap;">' + count + ' record' + (count > 1 ? 's' : '') + '</div>';
                html += '<input type="number" data-mp-rev="' + key + '" value="' + totalRev.toFixed(2) + '" step="0.01" style="width:120px;padding:6px 8px;background:var(--input-bg,#0f1117);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:13px;text-align:right;" title="Total revenue" />';
                if (isDup) {
                    html += '<button class="btn btn-primary small" style="padding:5px 10px;font-size:11px;" onclick="mergePhaseGroup(\'' + key + '\')">Merge</button>';
                } else {
                    html += '<button class="btn btn-secondary small" style="padding:5px 10px;font-size:11px;" onclick="saveManagedPhase(\'' + key + '\')">Save</button>';
                }
                html += '<button class="btn danger small" style="padding:5px 10px;font-size:11px;" onclick="deletePhaseGroup(\'' + key + '\')">&#x1F5D1;</button>';
                html += '</div>';
                if (isDup) {
                    html += '<div style="font-size:10px;color:var(--text-dim);margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);">';
                    html += '<span style="color:var(--yellow);">&#9888; Duplicate</span> &mdash; Buildings: ' + escapeHTML(bldgNames.join(', '));
                    html += '<br>Merging creates 1 record and auto-wires to all ' + count + ' buildings at ' + (100/count).toFixed(1) + '% allocation each.';
                    html += '</div>';
                }
                html += '</div>';
            });
            list.innerHTML = html;
        }

        function mergePhaseGroup(key) {
            const jobId = appState.currentJobId;
            const phases = (appData.phases || []).filter(p => p.jobId === jobId && (p.phase || 'Unnamed').trim().toLowerCase() === key);
            if (phases.length < 2) return;
            const nameInput = document.querySelector('[data-mp-name="' + key + '"]');
            const revInput = document.querySelector('[data-mp-rev="' + key + '"]');
            const newName = nameInput ? nameInput.value.trim() : phases[0].phase;
            const newRev = revInput ? (parseFloat(revInput.value) || 0) : phases.reduce((s, r) => s + (r.asSoldRevenue || 0), 0);
            // Keep the first record, absorb the rest
            const keeper = phases[0];
            const absorbed = phases.slice(1);
            keeper.phase = newName;
            keeper.asSoldRevenue = newRev;
            keeper.materials = phases.reduce((s, r) => s + (r.materials || 0), 0);
            keeper.labor = phases.reduce((s, r) => s + (r.labor || 0), 0);
            keeper.sub = phases.reduce((s, r) => s + (r.sub || 0), 0);
            keeper.equipment = phases.reduce((s, r) => s + (r.equipment || 0), 0);
            keeper.buildingId = ''; // phase now spans buildings via graph wires
            // Collect all building IDs from the absorbed records to auto-wire later
            const bldgIds = phases.map(p => p.buildingId).filter(Boolean);
            // Redirect any subs/POs referencing absorbed phase IDs to the keeper
            const absorbedIds = absorbed.map(a => a.id);
            (appData.subs || []).forEach(s => {
                if (s.phaseId && absorbedIds.indexOf(s.phaseId) !== -1) s.phaseId = keeper.id;
                if (s.phaseIds) s.phaseIds = s.phaseIds.map(pid => absorbedIds.indexOf(pid) !== -1 ? keeper.id : pid);
            });
            // Remove absorbed phases
            appData.phases = appData.phases.filter(p => absorbedIds.indexOf(p.id) === -1);
            saveData();
            // Rewire graph if it exists
            mergeUpdateGraph(keeper.id, absorbedIds, bldgIds);
            renderManagePhasesList();
            renderJobDetail(jobId);
        }

        function saveManagedPhase(key) {
            const jobId = appState.currentJobId;
            const phase = (appData.phases || []).find(p => p.jobId === jobId && (p.phase || 'Unnamed').trim().toLowerCase() === key);
            if (!phase) return;
            const nameInput = document.querySelector('[data-mp-name="' + key + '"]');
            const revInput = document.querySelector('[data-mp-rev="' + key + '"]');
            if (nameInput) phase.phase = nameInput.value.trim();
            if (revInput) phase.asSoldRevenue = parseFloat(revInput.value) || 0;
            saveData();
            // Sync revenue to node graph if present
            if (typeof NG !== 'undefined') {
                try {
                    const ngNodes = NG.nodes();
                    ngNodes.forEach(n => {
                        if (n.type === 't2' && n.data && n.data.id === phase.id) {
                            n.revenue = phase.asSoldRevenue;
                            n.label = phase.phase;
                        }
                    });
                    NG.saveGraph();
                } catch(e) {}
            }
            renderManagePhasesList();
            renderJobDetail(jobId);
        }

        function deletePhaseGroup(key) {
            const jobId = appState.currentJobId;
            const phases = (appData.phases || []).filter(p => p.jobId === jobId && (p.phase || 'Unnamed').trim().toLowerCase() === key);
            if (!phases.length) return;
            if (!confirm('Delete ' + phases.length + ' phase record(s) in this group? This cannot be undone.')) return;
            const ids = phases.map(p => p.id);
            appData.phases = appData.phases.filter(p => ids.indexOf(p.id) === -1);
            saveData();
            // Remove corresponding nodes from graph
            if (typeof NG !== 'undefined') {
                try {
                    const ngNodes = NG.nodes();
                    const ngWires = NG.wires();
                    const nodeIdsToRemove = ngNodes.filter(n => n.type === 't2' && n.data && ids.indexOf(n.data.id) !== -1).map(n => n.id);
                    NG.setNodes(ngNodes.filter(n => nodeIdsToRemove.indexOf(n.id) === -1));
                    NG.setWires(ngWires.filter(w => nodeIdsToRemove.indexOf(w.fromNode) === -1 && nodeIdsToRemove.indexOf(w.toNode) === -1));
                    NG.saveGraph();
                } catch(e) {}
            }
            renderManagePhasesList();
            renderJobDetail(jobId);
        }

        // After merging phase records in appData, consolidate matching graph nodes
        // and auto-create allocation wires to the original buildings.
        function mergeUpdateGraph(keeperId, absorbedIds, bldgIds) {
            if (typeof NG === 'undefined') return;
            try {
                const ngNodes = NG.nodes();
                const ngWires = NG.wires();
                // Find all T2 nodes that were for any of the phase records
                const allIds = [keeperId].concat(absorbedIds);
                const t2Nodes = ngNodes.filter(n => n.type === 't2' && n.data && allIds.indexOf(n.data.id) !== -1);
                if (!t2Nodes.length) return;
                // Keep the first T2 node, redirect wires from others, then delete others
                const keeperNode = t2Nodes[0];
                keeperNode.data.id = keeperId;
                // Pull revenue from the keeper phase record
                const keeperPhase = appData.phases.find(p => p.id === keeperId);
                if (keeperPhase) {
                    keeperNode.revenue = keeperPhase.asSoldRevenue || 0;
                    keeperNode.label = keeperPhase.phase || keeperNode.label;
                }
                const removeIds = t2Nodes.slice(1).map(n => n.id);
                // Redirect any wires pointing to/from absorbed t2 nodes to the keeper
                ngWires.forEach(w => {
                    if (removeIds.indexOf(w.fromNode) !== -1) w.fromNode = keeperNode.id;
                    if (removeIds.indexOf(w.toNode) !== -1) w.toNode = keeperNode.id;
                });
                // Dedupe wires
                const seen = {};
                const deduped = [];
                ngWires.forEach(w => {
                    const k = w.fromNode + '|' + w.fromPort + '|' + w.toNode + '|' + w.toPort;
                    if (!seen[k]) { seen[k] = true; deduped.push(w); }
                });
                NG.setWires(deduped);
                NG.setNodes(ngNodes.filter(n => removeIds.indexOf(n.id) === -1));
                // Ensure the keeper is wired to each original building (T1 node)
                const finalWires = NG.wires();
                (bldgIds || []).forEach(bid => {
                    const t1 = NG.nodes().find(n => n.type === 't1' && n.data && n.data.id === bid);
                    if (!t1) return;
                    const exists = finalWires.some(w => w.fromNode === keeperNode.id && w.toNode === t1.id);
                    if (!exists) finalWires.push({ fromNode: keeperNode.id, fromPort: 0, toNode: t1.id, toPort: 0 });
                });
                NG.rebalancePhaseAllocations(keeperNode.id);
                NG.saveGraph();
            } catch(e) { console.error('mergeUpdateGraph failed', e); }
        }

        function savePhase() {
            // Validate phase budget doesn't exceed building budget
            const selectedBuildingId = document.getElementById('phaseBuilding').value;
            if (selectedBuildingId) {
                const bldg = appData.buildings.find(b => b.id === selectedBuildingId);
                if (bldg && bldg.budget > 0) {
                    const newPhaseBudget = parseFloat(document.getElementById('phaseBudget').value) || 0;
                    const bldgPhases = appData.phases.filter(p => p.jobId === appState.currentJobId && p.buildingId === selectedBuildingId);
                    let existingBudgetTotal = bldgPhases.reduce((sum, p) => sum + (p.phaseBudget || 0), 0);
                    if (appState.editPhaseId) {
                        const editP = bldgPhases.find(p => p.id === appState.editPhaseId);
                        if (editP) existingBudgetTotal -= (editP.phaseBudget || 0);
                    }
                    if (existingBudgetTotal + newPhaseBudget > bldg.budget * 1.001) {
                        const remaining = bldg.budget - existingBudgetTotal;
                        alert('Phase budgets cannot exceed building budget (' + formatCurrency(bldg.budget) + '). Currently ' + formatCurrency(existingBudgetTotal) + ' allocated. Remaining: ' + formatCurrency(remaining));
                        return;
                    }
                }
            }
            const hoursWeek = parseFloat(document.getElementById('phaseHoursWeek').value) || 0;
            const hoursTotal = (parseFloat(document.getElementById('phaseHoursTotal').value) || 0) + hoursWeek;
            const rate = parseFloat(document.getElementById('phaseRate').value) || 40;
            const asSoldVal = parseFloat(document.getElementById('phaseBudget').value) || 0;
            const existingCO = appState.editPhaseId
                ? (appData.phases.find(p => p.id === appState.editPhaseId)?.coPhaseBudget || 0) : 0;
            const asSoldRevenue = parseFloat(document.getElementById('phaseAsSoldRevenue').value) || 0;
            // If phase is wired to multiple buildings in the graph, keep buildingId empty.
            const isMultiWired = document.getElementById('phaseConnectedWrap').style.display !== 'none'
                && document.getElementById('phaseBuildingWrap').style.display === 'none';
            const formData = {
                buildingId: isMultiWired ? '' : document.getElementById('phaseBuilding').value,
                phase: document.getElementById('phaseType').value,
                workScope: document.getElementById('phaseWorkScope').value || 'in-house',
                locked: document.getElementById('phaseLocked').checked,
                pctComplete: parseFloat(document.getElementById('phasePercent').value) || 0,
                materials: parseFloat(document.getElementById('phaseMaterials').value) || 0,
                labor: hoursTotal * rate,
                sub: 0,
                equipment: parseFloat(document.getElementById('phaseEquipment').value) || 0,
                asSoldRevenue: asSoldRevenue,
                asSoldPhaseBudget: asSoldVal,
                coPhaseBudget: existingCO,
                phaseBudget: asSoldVal + existingCO,
                hoursWeek: hoursWeek,
                hoursTotal: hoursTotal,
                rate: rate,
                notes: document.getElementById('phaseNotes').value
            };

            if (appState.editPhaseId) {
                const idx = appData.phases.findIndex(p => p.id === appState.editPhaseId);
                if (idx !== -1) {
                    Object.assign(appData.phases[idx], formData);
                    // Sync revenue + name to graph T2 node if present
                    if (typeof NG !== 'undefined') {
                        try {
                            const ngNodes = NG.nodes();
                            ngNodes.forEach(n => {
                                if (n.type === 't2' && n.data && n.data.id === appState.editPhaseId) {
                                    n.revenue = asSoldRevenue;
                                    n.pctComplete = formData.pctComplete;
                                    // Preserve the " › Building" / " +N" suffix by keeping whatever label updateTierLabels derived
                                }
                            });
                            NG.saveGraph();
                        } catch(e) {}
                    }
                }
                appState.editPhaseId = null;
            } else {
                const phase = Object.assign({
                    id: 'p' + Date.now(),
                    jobId: appState.currentJobId,
                    dateAdded: new Date().toISOString()
                }, formData);
                appData.phases.push(phase);
                autoBalanceOnPhaseAdd(appState.currentJobId, phase.buildingId);
            }
            saveData();
            closeModal('addPhaseModal');
            renderJobDetail(appState.currentJobId);
        }

        function openAddSubToJobModal() {
            appState.editSubId = null;
            document.getElementById('subModalHeader').textContent = 'Add Subcontractor';
            document.getElementById('subSaveBtn').innerHTML = '&#x1F477; Add Subcontractor';
            populateSubBuildingChecks();
            document.getElementById('subName').value = '';
            populateSubTradeSelect();
            document.getElementById('subTrade').value = '';
            document.getElementById('subLevel').value = 'job';
            document.getElementById('subContract').value = '';
            document.getElementById('subBilled').value = '';
            document.getElementById('subNotes').value = '';
            populateSubDirectoryList();
            updateSubDirectoryHint();
            subLevelChanged();
            openModal('addSubModal');
        }

        // Phase C: feed the datalist from appData.subsDirectory so the
        // user gets typeahead-style autocomplete over existing subs.
        // Picking a directory match also auto-fills the trade and
        // surfaces a hint that links to the directory record.
        function populateSubDirectoryList() {
            const dl = document.getElementById('subDirectoryList');
            if (!dl) return;
            const dir = (window.appData && appData.subsDirectory) || [];
            dl.innerHTML = dir
                .filter(s => s.status !== 'closed')
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                .map(s => '<option value="' + escapeHTML(s.name) + '">' +
                    escapeHTML(s.trade || '') + (s.contact_name ? ' · ' + escapeHTML(s.contact_name) : '') +
                '</option>')
                .join('');
        }

        function updateSubDirectoryHint() {
            const nameEl = document.getElementById('subName');
            const tradeEl = document.getElementById('subTrade');
            const hintEl = document.getElementById('subDirectoryHint');
            if (!nameEl || !hintEl) return;
            const typed = nameEl.value.trim();
            if (!typed) {
                hintEl.innerHTML = (appData.subsDirectory && appData.subsDirectory.length)
                    ? '<span style="color:var(--text-dim,#888);">Pick from ' + appData.subsDirectory.length + ' directory entries — or type a new name to create one.</span>'
                    : '';
                return;
            }
            const dir = (appData.subsDirectory || []);
            const match = dir.find(s => (s.name || '').toLowerCase() === typed.toLowerCase());
            if (match) {
                hintEl.innerHTML = '<span style="color:#34d399;">&#x2713; Linked to directory: <strong>' + escapeHTML(match.name) + '</strong>' +
                    (match.trade ? ' (' + escapeHTML(match.trade) + ')' : '') + '</span>';
                // Auto-fill trade from directory if user hasn't set one
                if (tradeEl && !tradeEl.value && match.trade) {
                    // Only set if the option exists; otherwise add it
                    const exists = [...tradeEl.options].some(o => o.value === match.trade);
                    if (!exists) {
                        const opt = document.createElement('option');
                        opt.value = match.trade; opt.textContent = match.trade;
                        tradeEl.appendChild(opt);
                    }
                    tradeEl.value = match.trade;
                }
            } else {
                hintEl.innerHTML = '<span style="color:#fbbf24;">New sub — will create a directory record on save.</span>';
            }
        }
        // Wire the input change so the hint stays current as the user types/picks
        document.addEventListener('DOMContentLoaded', function() {
            const el = document.getElementById('subName');
            if (el) el.addEventListener('input', updateSubDirectoryHint);
        });

        function populateSubBuildingChecks(selectedIds) {
            const buildings = appData.buildings.filter(b => b.jobId === appState.currentJobId);
            const container = document.getElementById('subBuildingChecks');
            if (!container) return;
            container.innerHTML = '';
            buildings.forEach(b => {
                var checked = selectedIds && selectedIds.includes(b.id) ? ' checked' : '';
                container.innerHTML += '<label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;padding:2px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface2);">' +
                    '<input type="checkbox" class="sub-bldg-chk" value="' + b.id + '"' + checked + ' style="width:13px;height:13px;" onchange="subBuildingCheckChanged()">' + escapeHTML(b.name) + '</label>';
            });
        }

        function subLevelChanged() {
            const level = document.getElementById('subLevel').value;
            document.getElementById('subBuildingGroup').style.display = (level === 'building' || level === 'phase') ? '' : 'none';
            document.getElementById('subPhaseGroup').style.display = level === 'phase' ? '' : 'none';
            if (level === 'building' || level === 'phase') {
                populateSubBuildingChecks();
                if (level === 'phase') subBuildingCheckChanged();
            }
        }

        function subBuildingCheckChanged() {
            const level = document.getElementById('subLevel').value;
            if (level !== 'phase') return;
            const checkedBldgs = Array.from(document.querySelectorAll('.sub-bldg-chk:checked')).map(c => c.value);
            const container = document.getElementById('subPhaseChecks');
            if (!container) return;
            container.innerHTML = '';
            checkedBldgs.forEach(bId => {
                const bldg = appData.buildings.find(b => b.id === bId);
                const phases = appData.phases.filter(p => p.jobId === appState.currentJobId && p.buildingId === bId);
                phases.forEach(p => {
                    container.innerHTML += '<label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;padding:2px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface2);">' +
                        '<input type="checkbox" class="sub-phase-chk" value="' + p.id + '" style="width:13px;height:13px;">' +
                        (bldg ? escapeHTML(bldg.name) + ' \u203A ' : '') + escapeHTML(p.phase) + '</label>';
                });
            });
        }

        function saveSub() {
            const level = document.getElementById('subLevel').value;
            const buildingIds = (level === 'building' || level === 'phase')
                ? Array.from(document.querySelectorAll('.sub-bldg-chk:checked')).map(c => c.value) : [];
            const phaseIds = level === 'phase'
                ? Array.from(document.querySelectorAll('.sub-phase-chk:checked')).map(c => c.value) : [];
            const subData = {
                jobId: appState.currentJobId,
                name: document.getElementById('subName').value,
                trade: document.getElementById('subTrade').value,
                level: level,
                buildingId: buildingIds[0] || '',
                buildingIds: buildingIds,
                phaseId: phaseIds[0] || '',
                phaseIds: phaseIds,
                contractAmt: parseFloat(document.getElementById('subContract').value) || 0,
                billedToDate: parseFloat(document.getElementById('subBilled').value) || 0,
                notes: document.getElementById('subNotes').value
            };

            if (appState.editSubId) {
                const idx = appData.subs.findIndex(s => s.id === appState.editSubId);
                if (idx >= 0) {
                    subData.id = appState.editSubId;
                    appData.subs[idx] = subData;
                }
            } else {
                subData.id = 's' + Date.now();
                appData.subs.push(subData);
            }
            saveData();
            closeModal('addSubModal');
            renderJobDetail(appState.currentJobId);
        }

        function editSub(subId) {
            const sub = appData.subs.find(s => s.id === subId);
            if (!sub) return;
            appState.editSubId = subId;
            document.getElementById('subModalHeader').textContent = 'Edit Subcontractor';
            document.getElementById('subSaveBtn').innerHTML = '&#x1F4BE; Save Changes';
            populateSubDirectoryList();
            document.getElementById('subName').value = sub.name || '';
            updateSubDirectoryHint();
            populateSubTradeSelect();
            if (sub.trade && !Array.from(document.getElementById('subTrade').options).some(o => o.value === sub.trade)) {
                const c = getCustomItems('agx-wip-custom-trades');
                if (!c.includes(sub.trade)) { c.push(sub.trade); saveCustomItems('agx-wip-custom-trades', c); populateSubTradeSelect(); }
            }
            document.getElementById('subTrade').value = sub.trade || '';
            document.getElementById('subLevel').value = sub.level || 'building';
            document.getElementById('subContract').value = sub.contractAmt || '';
            document.getElementById('subBilled').value = sub.billedToDate || '';
            document.getElementById('subNotes').value = sub.notes || '';
            // Restore building/phase checkboxes
            var bldgIds = sub.buildingIds || (sub.buildingId ? [sub.buildingId] : []);
            var phaseIds = sub.phaseIds || (sub.phaseId ? [sub.phaseId] : []);
            populateSubBuildingChecks(bldgIds);
            subLevelChanged();
            // Re-check the buildings after subLevelChanged rebuilt them
            setTimeout(function () {
                bldgIds.forEach(function (id) {
                    var chk = document.querySelector('.sub-bldg-chk[value="' + id + '"]');
                    if (chk) chk.checked = true;
                });
                if (sub.level === 'phase') {
                    subBuildingCheckChanged();
                    setTimeout(function () {
                        phaseIds.forEach(function (id) {
                            var chk = document.querySelector('.sub-phase-chk[value="' + id + '"]');
                            if (chk) chk.checked = true;
                        });
                    }, 30);
                }
            }, 30);
            openModal('addSubModal');
        }

        function deleteSub(subId) {
            if (!confirm('Delete this subcontractor?')) return;
            appData.subs = appData.subs.filter(s => s.id !== subId);
            saveData();
            renderJobDetail(appState.currentJobId);
        }

        // ==================== CLOSE WEEK ALL JOBS ====================
        function closeWeekAllJobs() {
            var today = new Date();
            var dayOfWeek = today.getDay();
            var friday = new Date(today);
            friday.setDate(today.getDate() + (5 - dayOfWeek + 7) % 7);
            if (dayOfWeek > 5) friday.setDate(friday.getDate() - 7);
            var defaultDate = friday.toISOString().split('T')[0];

            var activeJobs = appData.jobs.filter(function(j) { return j.status !== 'Archived' && j.status !== 'Completed'; });

            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
            var box = document.createElement('div');
            box.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;min-width:360px;max-width:460px;';
            box.innerHTML = '<h3 style="margin:0 0 12px;font-size:15px;">Close Week — All Active Jobs</h3>' +
                '<p style="font-size:12px;color:var(--text-dim);margin:0 0 12px;">This will capture a WIP snapshot for <b>' + activeJobs.length + ' active job' + (activeJobs.length !== 1 ? 's' : '') + '</b> at their current state.</p>' +
                '<label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:4px;">Week Ending</label>' +
                '<input type="date" id="closeWeekAllDate" value="' + defaultDate + '" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;margin-bottom:12px;" />' +
                '<div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:6px;margin-bottom:16px;">';
            activeJobs.forEach(function(j) {
                var hasSnap = j.weeklySnapshots && j.weeklySnapshots.some(function(s) { return s.weekOf === defaultDate; });
                box.innerHTML += '<div style="font-size:11px;padding:3px 0;display:flex;justify-content:space-between;">' +
                    '<span>' + escapeHTML((j.jobNumber ? j.jobNumber + ' — ' : '') + (j.title || 'Untitled')) + '</span>' +
                    (hasSnap ? '<span style="color:var(--yellow);font-size:10px;">exists</span>' : '') +
                    '</div>';
            });
            box.innerHTML += '</div>' +
                '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                '<button onclick="this.closest(\'div\').closest(\'div\').closest(\'div\').remove()" style="padding:6px 16px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);cursor:pointer;">Cancel</button>' +
                '<button id="closeWeekAllBtn" style="padding:6px 16px;border-radius:6px;background:var(--green);border:none;color:#fff;cursor:pointer;font-weight:600;">Close Week for All</button>' +
                '</div>';
            overlay.appendChild(box);
            overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);

            document.getElementById('closeWeekAllBtn').addEventListener('click', function() {
                var dt = document.getElementById('closeWeekAllDate').value;
                if (!dt) { alert('Select a week ending date'); return; }
                var count = 0;
                activeJobs.forEach(function(j) {
                    if (!j.weeklySnapshots) j.weeklySnapshots = [];
                    var existing = j.weeklySnapshots.findIndex(function(s) { return s.weekOf === dt; });
                    var snap = captureWeekSnapshot(j.id, dt);
                    if (existing >= 0) j.weeklySnapshots[existing] = snap;
                    else j.weeklySnapshots.push(snap);
                    j.weeklySnapshots.sort(function(a, b) { return a.weekOf < b.weekOf ? -1 : 1; });
                    count++;
                });
                saveData();
                overlay.remove();
                alert('Closed week ' + dt + ' for ' + count + ' jobs.');
                renderWIPMain();
            });
        }

        function showArchivedJobs() {
            var mainView = document.getElementById('wip-main-view');
            var archiveView = document.getElementById('archived-jobs-list');
            if (!mainView || !archiveView) return;
            var showing = archiveView.style.display !== 'none';
            if (showing) {
                archiveView.style.display = 'none';
                mainView.style.display = '';
                document.querySelectorAll('.wip-action-tab').forEach(function(t) { t.classList.remove('active'); });
            } else {
                mainView.style.display = 'none';
                archiveView.style.display = '';
                document.querySelectorAll('.wip-action-tab').forEach(function(t) {
                    t.classList.toggle('active', t.textContent.trim() === 'Archived');
                });
                renderArchivedJobs();
            }
        }

        // ==================== ARCHIVED JOBS ====================
        function renderArchivedJobs() {
            var container = document.getElementById('archived-jobs-list');
            if (!container) return;
            container.innerHTML = '';

            var archived = appData.jobs.filter(function(j) { return j.status === 'Archived'; });

            var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
                '<h2 style="font-size:18px;margin:0;">Archived Jobs (' + archived.length + ')</h2>' +
                '<button class="wip-action-tab" onclick="showArchivedJobs()" style="font-size:12px;">&larr; Back to WIP</button></div>';

            if (archived.length === 0) {
                html += '<div class="card" style="padding:30px;text-align:center;color:var(--text-dim);">No archived jobs. Archive a job by setting its status to "Archived" in the job editor.</div>';
                container.innerHTML = html;
                return;
            }

            archived.forEach(function(job) {
                var w = getJobWIP(job.id);
                var profit = (w.revenueEarned || 0) - (w.actualCosts || 0);
                var margin = w.revenueEarned > 0 ? (profit / w.revenueEarned * 100) : 0;
                var snapCount = (job.weeklySnapshots || []).length;
                var marginColor = margin >= 15 ? 'var(--green)' : margin >= 0 ? 'var(--yellow)' : 'var(--red)';

                html += '<div class="card" style="padding:12px 14px;margin-bottom:8px;">';
                html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">';

                // Left: job info
                html += '<div style="flex:1;min-width:0;">';
                html += '<div style="font-size:14px;font-weight:600;margin-bottom:2px;">' + escapeHTML((job.jobNumber ? job.jobNumber + ' — ' : '') + (job.title || 'Untitled')) + '</div>';
                html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">' +
                    (job.client ? escapeHTML(job.client) + ' &middot; ' : '') +
                    (job.pm ? 'PM: ' + escapeHTML(job.pm) + ' &middot; ' : '') +
                    snapCount + ' weekly snapshots</div>';

                // KPIs row
                html += '<div style="display:flex;gap:14px;font-size:11px;flex-wrap:wrap;">';
                html += '<div><span style="color:var(--text-dim);">Income</span> <b>' + formatCurrency(w.totalIncome) + '</b></div>';
                html += '<div><span style="color:var(--text-dim);">Rev Earned</span> <b style="color:var(--green);">' + formatCurrency(w.revenueEarned) + '</b></div>';
                html += '<div><span style="color:var(--text-dim);">Costs</span> <b style="color:var(--red);">' + formatCurrency(w.actualCosts) + '</b></div>';
                html += '<div><span style="color:var(--text-dim);">Profit</span> <b style="color:' + (profit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(profit) + '</b></div>';
                html += '<div><span style="color:var(--text-dim);">Margin</span> <b style="color:' + marginColor + ';">' + margin.toFixed(1) + '%</b></div>';
                html += '<div><span style="color:var(--text-dim);">Complete</span> <b>' + (w.pctComplete || 0).toFixed(1) + '%</b></div>';
                html += '</div>';
                html += '</div>';

                // Right: action buttons
                html += '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">';
                html += '<button onclick="editJob(\'' + escapeHTML(job.id) + '\')" class="ee-btn secondary">Edit</button>';
                html += '<button onclick="restoreJob(\'' + escapeHTML(job.id) + '\')" class="ee-btn success">Restore</button>';
                html += '<button onclick="deleteArchivedJob(\'' + escapeHTML(job.id) + '\')" class="ee-btn danger">Delete</button>';
                html += '</div>';

                html += '</div></div>';
            });

            container.innerHTML = html;
        }

        function restoreJob(jobId) {
            var job = appData.jobs.find(function(j) { return j.id === jobId; });
            if (!job) return;
            job.status = 'In Progress';
            saveData();
            renderArchivedJobs();
        }

        function deleteArchivedJob(jobId) {
            if (!confirm('Permanently delete this job and all its data? This cannot be undone.')) return;
            appData.jobs = appData.jobs.filter(function(j) { return j.id !== jobId; });
            appData.buildings = appData.buildings.filter(function(b) { return b.jobId !== jobId; });
            appData.phases = appData.phases.filter(function(p) { return p.jobId !== jobId; });
            appData.changeOrders = appData.changeOrders.filter(function(c) { return c.jobId !== jobId; });
            appData.subs = appData.subs.filter(function(s) { return s.jobId !== jobId; });
            appData.purchaseOrders = (appData.purchaseOrders || []).filter(function(p) { return p.jobId !== jobId; });
            appData.invoices = (appData.invoices || []).filter(function(i) { return i.jobId !== jobId; });
            // Remove node graph
            try {
                var all = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
                delete all[jobId];
                localStorage.setItem('agx-nodegraphs', JSON.stringify(all));
            } catch (e) {}
            saveData();
            // Server-side delete (bulk-save only upserts; without this the
            // job comes back on next page reload).
            if (window.agxApi && window.agxApi.isAuthenticated()) {
                window.agxApi.jobs.remove(jobId).catch(function(err) {
                    console.warn('Server delete failed for ' + jobId + ':', err.message);
                });
            }
            renderArchivedJobs();
        }


        // ==================== ESTIMATES FUNCTIONS (FROM ORIGINAL FILE) ====================
        