// Project 86 — estimate document layouts + takeoff levels.
//
// The DECLARATIVE half of the proposal/takeoff document system. A layout is a
// named ORDERED LIST OF SECTION KEYS plus a pricing-disclosure config; the
// renderer (js/estimate-preview.js) owns one builder per section key and simply
// walks the list. That split is the whole point: adding, reordering or removing
// a layout is a data edit HERE, never new rendering code — the same lesson the
// photo-report style packs already paid for ("packs = tokens + STRUCTURE").
//
// Layout picks the SKELETON. (A style pack picks the SKIN; the two are kept
// orthogonal so N layouts x M looks never becomes N*M hand-built documents.)
//
// PRICING DISCLOSURE is a per-layout object, not a boolean, because the same
// estimate has to emit a fully-priced board copy AND a subtotal-only courtesy
// copy without re-keying:
//   lines:     'none' | 'extended' | 'unit+extended'
//   subtotals: show a subtotal row per scope group
//   total:     show the contract total
//   perTier:   one price per option card (Options layout)
//   cost:      expose unit COST / markup / margin (internal renders only)
//
// NOTE: suppression here is RENDER-TIME. That is safe today because estimate
// documents are only ever printed from the operator's own browser. The moment a
// public share link exists, suppressed fields must be DELETED server-side (see
// FINANCIAL_COVER_KEYS in server/services/report-document.js for the shape) —
// hiding at render leaks margin to anyone who opens dev tools.
(function () {
  'use strict';

  var PROPOSAL_LAYOUTS = [
    {
      id: 'letterhead',
      label: 'Letterhead',
      desc: 'The classic AGX proposal — logo, prose, scope, one total. Small single-scope repairs.',
      sections: ['header', 'meta', 'title', 'intro', 'about', 'divider',
                 'scopeHeading', 'scope', 'total', 'exclusions', 'attachments',
                 'sigIntro', 'signature'],
      pricing: { lines: 'none', subtotals: false, total: true }
    },
    {
      id: 'sov',
      label: 'Schedule of Values',
      desc: 'Numbered, grouped rows a board can compare against other bids — and the line identity a pay application bills against.',
      sections: ['bandHeader', 'projectBlock', 'scopeStatement', 'sovTable',
                 'exclusions', 'paymentSchedule', 'warrantyCO', 'attachments',
                 'signatureTitled'],
      pricing: { lines: 'unit+extended', subtotals: true, total: true }
    },
    {
      id: 'board',
      label: 'Board Presentation',
      desc: 'Cover, narrative and an investment summary at group level. For a vote, when you are not the low bid.',
      sections: ['cover', 'understanding', 'about', 'scopeNarrative',
                 'investmentSummary', 'schedulePhasing', 'exclusions',
                 'qualifications', 'attachments', 'signatureTitled'],
      pricing: { lines: 'none', subtotals: true, total: true }
    },
    {
      id: 'rfp',
      label: 'Base Bid + Alternates',
      desc: 'RFP-responsive: base scope priced as asked, extras quarantined as add/deduct alternates, plus published unit prices.',
      sections: ['rfpCover', 'scopeStatement', 'baseBidTable', 'alternatesTable',
                 'unitPriceTable', 'exclusions', 'schedulePhasing',
                 'qualifications', 'signatureTitled'],
      pricing: { lines: 'unit+extended', subtotals: true, total: true }
    },
    {
      id: 'options',
      label: 'Options (Good / Better / Best)',
      desc: 'Side-by-side tier cards over one job. Moves the conversation from "who is cheapest" to "which level".',
      sections: ['compactHeader', 'problemStatement', 'tierCards',
                 'includedInEvery', 'exclusions', 'selectionLine', 'signature'],
      pricing: { lines: 'none', subtotals: false, total: false, perTier: true }
    },
    {
      id: 'service',
      label: 'Service Quote',
      desc: 'One page. Line totals plus checkbox "while we are on site" add-ons pulled from your excluded groups.',
      sections: ['compactHeader', 'serviceMeta', 'lineTable', 'optionalRows',
                 'totalsBlock', 'shortTerms', 'signatureSingle'],
      pricing: { lines: 'extended', subtotals: false, total: true }
    }
  ];

  // Takeoff LEVELS are render settings over the SAME estimate, not separate
  // documents — the Xactimate model (one estimate, several named reports that
  // differ only in column set and grouping).
  //
  //   audience : who it is for; drives whether money may appear at all
  //   columns  : ordered column keys the renderer knows how to emit
  //   grouping : 'group' | 'group-section' | 'assembly' | 'matrix'
  //   status   : 'ready' | 'partial' — honest feasibility against the CURRENT
  //              data model. A level marked partial renders a banner naming
  //              what is missing rather than quietly producing a document that
  //              looks complete when it isn't.
  var TAKEOFF_LEVELS = [
    {
      id: 't1',
      label: 'T1 — Scope Summary',
      desc: 'One row per scope group. No line items.',
      audience: 'client',
      columns: ['scope', 'description', 'qty', 'unit', 'price'],
      grouping: 'group',
      pricing: { lines: 'none', subtotals: true, total: true },
      status: 'ready'
    },
    {
      id: 't2',
      label: 'T2 — Building / Area Matrix',
      desc: 'Scope down the side, areas across the top.',
      audience: 'client',
      columns: ['scope', 'perColumn', 'rowTotal'],
      grouping: 'matrix',
      pricing: { lines: 'none', subtotals: true, total: true },
      status: 'partial',
      caveat: 'Estimates have no building dimension yet — the building/footprint model lives on JOBS, not estimates. This pivots on SCOPE GROUPS, so it is a true per-building matrix only if the groups are named per building. A real building axis on the estimate line is the prerequisite.'
    },
    {
      id: 't3',
      label: 'T3 — Assembly Detail',
      desc: 'Each assembly expanded into its components.',
      audience: 'internal',
      columns: ['item', 'location', 'qty', 'unit', 'unitSell', 'extended'],
      grouping: 'assembly',
      pricing: { lines: 'unit+extended', subtotals: true, total: true },
      status: 'ready',
      caveat: 'Components come from the assemblyBreakdown persisted on rollup-mode lines. Exploded-mode lines are already leaves, and hand-typed catalog lines have no assembly — both render flat.'
    },
    {
      id: 't4',
      label: 'T4 — Full Line-Item Cost',
      desc: 'Every line with cost, markup and margin.',
      audience: 'internal',
      columns: ['section', 'item', 'qty', 'unit', 'unitCost', 'markup', 'unitSell', 'extCost', 'extSell', 'margin'],
      grouping: 'group-section',
      pricing: { lines: 'unit+extended', subtotals: true, total: true, cost: true },
      status: 'partial',
      caveat: 'INTERNAL ONLY — exposes unit cost, markup and margin. Waste % and net-vs-ordered quantity are not separable today: waste is applied inside the parametric explode and baked into qty, so it is never stored as its own field.'
    },
    {
      id: 't5',
      label: 'T5 — Field Pull Sheet',
      desc: 'Materials to buy and load. No pricing.',
      audience: 'field',
      columns: ['material', 'spec', 'qty', 'unit', 'location', 'notes', 'received'],
      grouping: 'group-section',
      pricing: { lines: 'none', subtotals: false, total: false },
      status: 'partial',
      caveat: 'Built from priced rows, so it can ship a crew short: consumables (sealant, tape, blades, fasteners) are never estimate lines, material IDs are not carried on the line itself, and there is no purchase-unit rounding — quantities are net, not bundles/squares/pails.'
    }
  ];

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return null;
  }

  window.p86EstimateDocLayouts = {
    listProposals: function () { return PROPOSAL_LAYOUTS.slice(); },
    listTakeoffs: function () { return TAKEOFF_LEVELS.slice(); },
    // Unknown ids clamp to the safe default rather than rendering nothing —
    // 'letterhead' is to proposals what 'clean' is to report style packs.
    getProposal: function (id) { return byId(PROPOSAL_LAYOUTS, id) || PROPOSAL_LAYOUTS[0]; },
    getTakeoff: function (id) { return byId(TAKEOFF_LEVELS, id) || TAKEOFF_LEVELS[0]; }
  };
})();
