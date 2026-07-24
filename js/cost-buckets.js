/* ============================================================================
 * Cost Buckets — the canonical cost containers a job's actual costs roll into.
 *
 * John's model: a jobsite has default cost buckets that costs "drop into," and
 * each building gets its own default set for QB costs to link to. The buckets
 * are the same five categories the whole system already speaks in — the QB
 * account names, the building.materials/labor/sub/equipment fields, and the
 * estimate's cost-category sections all collapse to this one set:
 *
 *   Materials · Labor · Subcontractors · Equipment · General Conditions (+ Other)
 *
 * This module is READ-ONLY aggregation. It re-presents cost that already exists
 * (QB cost lines, vendor bills, receipts) grouped by bucket; it computes and
 * persists no new money and does NOT touch getJobWIP. Its grand total should
 * reconcile to the job's actual-cost figure because it reads the same sources.
 *
 * Per-building buckets are the same set; QB→building linking is a follow-up
 * (QB lines carry job_id today, not building_id), so a building's buckets show
 * what's explicitly attributed to it plus its manual cost fields.
 * ========================================================================== */
(function () {
  'use strict';

  // Canonical buckets, in display order. `code` is the stable key; `label` is
  // shown. `manualField` maps to the building/phase cost columns so manual cost
  // entry rolls into the same bucket as imported cost.
  var CANON = [
    { code: 'materials', label: 'Materials & Supplies', manualField: 'materials', color: '#4f8cff' },
    { code: 'labor',     label: 'Labor',                 manualField: 'labor',     color: '#e0a458' },
    { code: 'subs',      label: 'Subcontractors',        manualField: 'sub',       color: '#35d0a5' },
    { code: 'equipment', label: 'Equipment',             manualField: 'equipment', color: '#a78bfa' },
    { code: 'gc',        label: 'General Conditions',    manualField: null,        color: '#e879a6' },
    { code: 'other',     label: 'Other',                 manualField: null,        color: '#8b90a5' }
  ];
  var CODES = CANON.map(function (b) { return b.code; });

  // Map a free-text cost category (QB account, receipt cost_code, BT category)
  // to a canonical bucket. Order matters: subs before materials so a
  // "Subcontractor materials" line lands in subs; labor/equipment/gc before the
  // materials catch so their keywords win.
  function bucketFor(raw) {
    var s = String(raw == null ? '' : raw).toLowerCase();
    if (!s) return 'other';
    if (/\bsub|subcontract/.test(s)) return 'subs';
    if (/labor|labour|hourly|burden|payroll|wage/.test(s)) return 'labor';
    if (/equip|rental|machine/.test(s)) return 'equipment';
    if (/general\s*condition|permit|engineering|overhead|insurance|\bbond\b|\bfee\b/.test(s)) return 'gc';
    if (/material|supplies|cogs|lumber|hardware/.test(s)) return 'materials';
    return 'other';
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(n) {
    n = Math.round(num(n));
    return '$' + n.toLocaleString('en-US');
  }

  // Roll up every actual-cost source for a job into the canonical buckets.
  // Returns { buckets: [{code,label,color,total,qb,bills,receipts,manual,lines}], grand }.
  function getJobCostBuckets(jobId) {
    var app = window.appData || {};
    var acc = {};
    CANON.forEach(function (b) {
      acc[b.code] = { code: b.code, label: b.label, color: b.color,
                      total: 0, qb: 0, bills: 0, receipts: 0, manual: 0, lines: 0 };
    });

    // QuickBooks cost lines — the actual-cost source of truth. Grouped by the
    // QB `account` name (e.g. "Direct Labor", "Materials & Supplies - COGS").
    (app.qbCostLines || []).forEach(function (l) {
      if (!l || (l.job_id || l.jobId) !== jobId) return;
      var b = acc[bucketFor(l.account || l.account_type)];
      var a = num(l.amount);
      b.qb += a; b.total += a; b.lines++;
    });

    // Vendor / subcontractor bills (AP). These are sub/vendor spend; bucket by
    // any category the bill carries, else Subcontractors.
    (app.jobVendorBills || []).forEach(function (bl) {
      if (!bl || (bl.job_id || bl.jobId) !== jobId) return;
      var st = String(bl.status || '').toLowerCase();
      if (st === 'void' || st === 'draft') return;
      var code = bl.cost_code ? bucketFor(bl.cost_code) : 'subs';
      var b = acc[code];
      var a = num(bl.amount || bl.total);
      b.bills += a; b.total += a; b.lines++;
    });

    // Cost Inbox receipts — bucket by cost_code.
    (app.receipts || []).forEach(function (r) {
      if (!r || (r.job_id || r.jobId) !== jobId) return;
      var b = acc[bucketFor(r.cost_code || r.costCode || r.category)];
      var a = num(r.amount || r.total);
      b.receipts += a; b.total += a; b.lines++;
    });

    // Manual cost entered on the job's buildings (materials/labor/sub/equipment).
    (app.buildings || []).filter(function (bd) { return bd && bd.jobId === jobId; })
      .forEach(function (bd) {
        CANON.forEach(function (cb) {
          if (!cb.manualField) return;
          var a = num(bd[cb.manualField]);
          if (a) { acc[cb.code].manual += a; acc[cb.code].total += a; }
        });
      });

    var buckets = CANON.map(function (b) { return acc[b.code]; });
    var grand = buckets.reduce(function (s, b) { return s + b.total; }, 0);
    return { buckets: buckets, grand: grand };
  }

  // Cost attributed to ONE building: its manual cost fields, plus any QB line /
  // bill / receipt that carries this building_id (none do yet — that linking is
  // the follow-up — so today this is the manual set, shown as the default
  // buckets available on the building).
  function getBuildingCostBuckets(buildingId, jobId) {
    var app = window.appData || {};
    var acc = {};
    CANON.forEach(function (b) {
      acc[b.code] = { code: b.code, label: b.label, color: b.color, total: 0, lines: 0 };
    });
    var bd = (app.buildings || []).find(function (x) { return x && x.id === buildingId; });
    if (bd) {
      CANON.forEach(function (cb) {
        if (!cb.manualField) return;
        var a = num(bd[cb.manualField]);
        if (a) { acc[cb.code].total += a; }
      });
    }
    var linkMatch = function (r) { return r && (r.building_id || r.buildingId) === buildingId; };
    (app.qbCostLines || []).filter(linkMatch).forEach(function (l) { var b = acc[bucketFor(l.account)]; b.total += num(l.amount); b.lines++; });
    (app.receipts || []).filter(linkMatch).forEach(function (r) { var b = acc[bucketFor(r.cost_code || r.category)]; b.total += num(r.amount || r.total); b.lines++; });
    var buckets = CANON.map(function (b) { return acc[b.code]; });
    return { buckets: buckets, grand: buckets.reduce(function (s, b) { return s + b.total; }, 0) };
  }

  // Compact bucket grid for the job inspector's Job Costs section. Read-only.
  function renderJobInto(host, jobId) {
    if (!host) return;
    var roll = getJobCostBuckets(jobId);
    var active = roll.buckets.filter(function (b) { return b.total !== 0 || b.lines; });
    var h = '<div style="font-size:10px;color:#8b90a5;text-transform:uppercase;letter-spacing:.5px;margin:2px 0 6px;">Cost buckets</div>';
    if (!roll.grand && !active.length) {
      h += '<div style="font-size:11px;color:#8b90a5;padding:4px 0;">No costs yet. QuickBooks imports, vendor bills, and receipts roll up here by bucket.</div>';
      host.innerHTML = h;
      return;
    }
    h += '<div style="display:flex;flex-direction:column;gap:3px;">';
    roll.buckets.forEach(function (b) {
      var faint = b.total === 0;
      var src = [];
      if (b.qb) src.push('QB ' + fmt(b.qb));
      if (b.bills) src.push('Bills ' + fmt(b.bills));
      if (b.receipts) src.push('Rcpt ' + fmt(b.receipts));
      if (b.manual) src.push('Manual ' + fmt(b.manual));
      h += '<div style="display:flex;align-items:center;gap:7px;padding:3px 0;border-top:1px solid var(--ng-border2,#222);">' +
        '<span style="width:7px;height:7px;border-radius:2px;background:' + b.color + ';opacity:' + (faint ? '0.35' : '1') + ';flex:none;"></span>' +
        '<span style="flex:1;font-size:11.5px;color:' + (faint ? '#6a7090' : 'var(--ng-text,#c8cbe0)') + ';">' + b.label + '</span>' +
        (src.length ? '<span style="font-size:9px;color:#6a7090;font-family:monospace;">' + src.join(' · ') + '</span>' : '') +
        '<span style="min-width:76px;text-align:right;font-family:monospace;font-size:12px;color:' + (faint ? '#4a4f63' : b.color) + ';">' + fmt(b.total) + '</span>' +
        '</div>';
    });
    h += '<div style="display:flex;align-items:center;gap:7px;padding:4px 0 2px;border-top:2px solid var(--ng-border2,#333);font-weight:700;">' +
      '<span style="flex:1;font-size:11.5px;color:#c8cbe0;">Total actual cost</span>' +
      '<span style="min-width:76px;text-align:right;font-family:monospace;font-size:12.5px;color:#e0a458;">' + fmt(roll.grand) + '</span>' +
      '</div></div>';
    host.innerHTML = h;
  }

  window.p86CostBuckets = {
    CANON: CANON, CODES: CODES,
    bucketFor: bucketFor,
    getJobCostBuckets: getJobCostBuckets,
    getBuildingCostBuckets: getBuildingCostBuckets,
    renderJobInto: renderJobInto
  };
})();
