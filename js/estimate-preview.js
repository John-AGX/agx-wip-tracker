// Project 86 Estimate Preview — Phase C.
//
// Live, in-tab render of the active estimate as a finished proposal letter.
// Matches the existing AGX PDF format: logo header, client/job/date block,
// big "Proposal for ..." title, greeting, intro template (with placeholders
// substituted), about paragraph, Scope of Work, Total Price, numbered
// exclusions, signature block.
//
// Data sources:
//   - estimate (title, client/community/addresses, salutation, issue,
//     scopeOfWork) from appData.estimates
//   - active-alternate lines + pricing pipeline from estimate-editor (we
//     reuse its math by reading the totals it already computes)
//   - proposal_template (company header line, intro text, about paragraph,
//     exclusions list, signature line) loaded from /api/settings, cached.
//
// Editing happens via the inputs on the Details tab + the Admin Templates
// tab. This module just renders.
(function() {
  'use strict';

  var _templateCache = null;
  var _templateLoadPromise = null;

  // Hardcoded fallback so the preview stays functional even if the API call
  // fails (offline mode, network glitch). Mirrors the seed in server/db.js so
  // an admin who hasn't yet edited templates still gets the canonical text.
  var FALLBACK_TEMPLATE = {
    company_header: '13191 56th Court, Ste 102 · Clearwater, FL 33760-4030 · Phone: 813-725-5233',
    intro_template: 'AG Exteriors is pleased to provide you with this proposal to complete the work outlined below.',
    about_paragraph: 'We proudly specialize in a wide range of exterior services, including roofing, siding, painting, deck rebuilding, and more—delivering each with care and attention to detail. Backed by our leadership team with extensive experience in construction, development, and property management. AG Exteriors is committed to bringing a thoughtful, professional approach to every project. With this foundation, we’re committed to providing high-quality work and dependable service on every project.',
    exclusions: [
      'This proposal may be withdrawn by AG Exteriors if not accepted within 30 days.',
      'Pricing assumes unfettered access to the property during the project.'
    ],
    signature_text: 'I confirm that my action here represents my electronic signature and is binding.'
  };

  function getTemplate() {
    if (_templateCache) return Promise.resolve(_templateCache);
    if (_templateLoadPromise) return _templateLoadPromise;
    if (!window.p86Api || !window.p86Api.isAuthenticated()) {
      _templateCache = FALLBACK_TEMPLATE;
      return Promise.resolve(_templateCache);
    }
    _templateLoadPromise = window.p86Api.settings.get('proposal_template')
      .then(function(res) {
        _templateCache = (res && res.setting && res.setting.value) || FALLBACK_TEMPLATE;
        return _templateCache;
      })
      .catch(function() {
        _templateCache = FALLBACK_TEMPLATE;
        return _templateCache;
      });
    return _templateLoadPromise;
  }

  // Force a reload — called by the Admin Templates UI after a save so the
  // preview picks up the new text without a page refresh.
  function invalidateTemplateCache() {
    _templateCache = null;
    _templateLoadPromise = null;
  }

  function fmtCurrency(v) {
    if (v == null || isNaN(v)) v = 0;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
  }

  // Only ever handed an INSTANT — the `new Date()` behind ctx.date, printed as the
  // proposal's "Print Date:" line — so the local accessors below are the right read.
  // A calendar day would land a day early here; it needs service-tickets.js fmtDate.
  function fmtDateShort(d) {
    if (!d) d = new Date();
    if (typeof d === 'string') d = new Date(d);
    return (d.getMonth() + 1) + '-' + d.getDate() + '-' + d.getFullYear();
  }

  function escapeHTMLLocal(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Replace {salutation}, {issue}, {community}, {date}, {total} tokens. Keep
  // unmatched placeholders visible (rendered as e.g. [issue]) so authors can
  // tell at a glance what's still empty.
  function fillPlaceholders(text, ctx) {
    if (!text) return '';
    return text.replace(/\{(\w+)\}/g, function(match, key) {
      if (ctx[key] != null && ctx[key] !== '') return String(ctx[key]);
      return '[' + key + ']';
    });
  }

  function getCurrentEstimate() {
    if (typeof window.getActiveEstimateForPreview === 'function') {
      return window.getActiveEstimateForPreview();
    }
    return null;
  }

  function getActiveAlternateLines(estimate) {
    if (!estimate || !window.appData) return [];
    var altId = estimate.activeAlternateId;
    return (window.appData.estimateLines || []).filter(function(l) {
      return l.estimateId === estimate.id && l.alternateId === altId;
    });
  }

  // Returns the ids of every group that's marked included in the proposal.
  // Legacy estimates with no toggles set: all groups included.
  function includedGroupIds(estimate) {
    var alts = (estimate && estimate.alternates) || [];
    var included = alts.filter(function(a) { return !a.excludeFromTotal; });
    if (!included.length) return alts.map(function(a) { return a.id; });
    return included.map(function(a) { return a.id; });
  }

  // Pricing helpers — delegated to window.p86Pricing. Same module
  // the estimate editor uses; ensures the preview's printed total
  // matches the editor's PROPOSAL TOTAL chip exactly (the bug behind
  // last week's $1,433 vs $2,605.45 mismatch was these two files
  // drifting apart). See js/pricing-pipeline.js for the math.
  var _P = window.p86Pricing;
  function sectionHeaderFor(line, allLines)        { return _P.sectionHeaderFor(line, allLines); }
  function effectiveMarkup(line, allLines, est)    { return _P.effectiveMarkupForLine(line, allLines, est); }
  function targetMarginActive(est)                 { return _P.targetMarginActive(est); }
  function applyTargetMargin(subtotal, est)        { return _P.applyTargetMargin(subtotal, est); }

  function computeTotal(estimate) {
    if (!estimate) return 0;
    var includedIds = includedGroupIds(estimate);
    var targetMode = targetMarginActive(estimate);
    var markedUp = 0;
    // Every priced set summed into this total — applyFeesAndTax's decision
    // comes from these, not from a second walk of estimate.lines. Twin of the
    // note in js/estimate-editor.js computeTotals.
    var parts = [];
    includedIds.forEach(function(gid) {
      var groupLines = (window.appData.estimateLines || []).filter(function(l) {
        return l.estimateId === estimate.id && l.alternateId === gid;
      });
      var per = _P.computeForLines(estimate, groupLines);
      parts.push(per);
      var groupMarkedUp = per.markedUp;
      // Target-margin override: back-compute this group's marked-up
      // total off its own subtotal so the per-group sum still equals
      // the override total. Mirrors estimate-editor exactly.
      if (targetMode) groupMarkedUp = applyTargetMargin(per.subtotal, estimate);
      markedUp += groupMarkedUp;
    });
    var fees = _P.applyFeesAndTax(markedUp, estimate, _P.sumOfPriced(parts));
    return fees.total;
  }

  // Build a context object the placeholder-filler reads from. Salutation +
  // community + issue have multiple potential sources (estimate field ->
  // linked client field -> sensible default). Total + date are derived.
  function buildContext(estimate) {
    var clients = (window.p86Clients && window.p86Clients.getCached && window.p86Clients.getCached()) || [];
    var client = estimate.client_id ? clients.find(function(x) { return x.id === estimate.client_id; }) : null;

    var salutation = estimate.salutation
      || (client && client.salutation)
      || (client && [client.first_name, client.last_name].filter(Boolean).join(' '))
      || (client && client.community_manager)
      || estimate.managerName
      || (client && client.name)
      || estimate.client
      || 'Client';

    var community = estimate.community
      || (client && client.community_name)
      || (client && client.name)
      || 'the property';

    var issue = estimate.issue || estimate.title || 'the requested work';

    return {
      salutation: salutation,
      community: community,
      issue: issue,
      total: fmtCurrency(computeTotal(estimate)),
      date: fmtDateShort(new Date()),
      client: client
    };
  }

  // Build the "Attached Photos / Documents" block for the proposal —
  // pulls from ctx.proposalAttachments which is populated by
  // renderEstimatePreview / printEstimateProposal before render. Photos
  // get a 2-column responsive grid; non-image docs get a list.
  function renderAttachmentsBlock(atts) {
    if (!atts || !atts.length) return '';
    var photos = atts.filter(function(a) {
      return a && a.mime_type && /^image\//i.test(a.mime_type);
    });
    var docs = atts.filter(function(a) {
      return !(a && a.mime_type && /^image\//i.test(a.mime_type));
    });
    if (!photos.length && !docs.length) return '';
    var html = '<h2 class="section-heading">Attached Photos &amp; Documents</h2>';
    if (photos.length) {
      html += '<div class="attached-photos">';
      photos.forEach(function(p) {
        // Prefer the web variant (smaller, faster); fall back to the
        // original. The original_url is used for href so the print PDF
        // links to the full-resolution copy.
        var src = p.web_url || p.original_url;
        if (!src) return;
        html += '<figure class="attached-photo">' +
          '<img src="' + escapeAttrLocal(src) + '" alt="' + escapeAttrLocal(p.filename || '') + '" />' +
          (p.filename ? '<figcaption>' + escapeHTMLLocal(p.filename) + '</figcaption>' : '') +
        '</figure>';
      });
      html += '</div>';
    }
    if (docs.length) {
      html += '<ul class="attached-docs">';
      docs.forEach(function(d) {
        html += '<li>' + escapeHTMLLocal(d.filename || 'Document') +
          (d.original_url ? ' &mdash; <a href="' + escapeAttrLocal(d.original_url) + '" target="_blank" rel="noopener">View</a>' : '') +
        '</li>';
      });
      html += '</ul>';
    }
    return html;
  }

  function escapeAttrLocal(s) {
    return escapeHTMLLocal(s).replace(/"/g, '&quot;');
  }

  // Build the proposal HTML for in-tab render. Print stylesheet (below) hides
  // any chrome that shouldn't appear in the PDF.
  // ──────────────────────────────────────────────────────────────────
  // Document layout machinery
  //
  // A layout (js/estimate-doc-layouts.js) is an ordered list of SECTION KEYS.
  // Everything below is either a shared data helper or one builder per key.
  // buildProposalHTML then just walks the list — so a new layout is a data
  // edit in the registry, not new rendering code here.
  // ──────────────────────────────────────────────────────────────────

  // Org branding logo, falling back to the AGX mark. Mirrors how the email
  // block editor resolves it (branding.logo_url || org logo || P86 default) so
  // a tenant that uploaded a logo stops printing AG Exteriors' one.
  function docLogoSrc() {
    try {
      var b = (window.p86Org && window.p86Org.branding) || (window.appData && window.appData.orgBranding) || null;
      var url = b && (b.logo_url || b.logoUrl || (b.logos && b.logos[0] && (b.logos[0].url || b.logos[0].logo_url)));
      if (url) return url;
    } catch (e) { /* fall through to the packaged mark */ }
    return 'images/logo-color.png';
  }

  // Split one group's lines into the editor's visual sections. Section headers
  // are themselves rows (section === '__section_header__'), so this walks in
  // order and buckets. Same shape the takeoff already used.
  function groupSections(estimate, altId) {
    var lines = (window.appData && window.appData.estimateLines || []).filter(function (l) {
      return l.estimateId === estimate.id && l.alternateId === altId;
    });
    var out = [];
    var cur = null;
    lines.forEach(function (l) {
      if (l.section === '__section_header__') {
        cur = { name: l.description || 'Section', items: [] };
        out.push(cur);
        return;
      }
      if (!cur) { cur = { name: '(uncategorized)', items: [] }; out.push(cur); }
      cur.items.push(l);
    });
    return out;
  }

  // Per-line SELL money. Delegates the markup to the pricing pipeline rather
  // than re-deriving it — the same rule that keeps the preview total equal to
  // the editor's PROPOSAL TOTAL chip. Row extensions are therefore consistent
  // with the group subtotal; fees and tax are added once at the bottom, which
  // is exactly how a schedule of values reconciles.
  function lineMoney(estimate, line, allLines) {
    var qty = Number(line.qty) || 0;
    var cost = Number(line.unitCost) || 0;
    var mk = 0;
    try { mk = Number(effectiveMarkup(line, allLines, estimate)) || 0; } catch (e) { mk = 0; }
    var unitSell = (typeof line.unitSell === 'number' && !isNaN(line.unitSell))
      ? Number(line.unitSell)
      : cost * (1 + mk / 100);
    return { qty: qty, unitCost: cost, unitSell: unitSell, extCost: qty * cost, extSell: qty * unitSell, markup: mk };
  }

  function moneyCell(n) { return escapeHTMLLocal(fmtProposalCurrency(n)); }

  // The priced groups, in estimate order.
  function includedAltsOf(estimate) {
    var ids = includedGroupIds(estimate);
    return (estimate.alternates || []).filter(function (a) { return ids.indexOf(a.id) >= 0; });
  }
  // The groups deliberately left OUT of the total — these are what become
  // "alternates" on an RFP and "while we're on site" options on a service quote.
  function excludedAltsOf(estimate) {
    var ids = includedGroupIds(estimate);
    return (estimate.alternates || []).filter(function (a) { return ids.indexOf(a.id) < 0; });
  }

  function scopeBodyHTML(s) {
    s = (s || '').trim();
    if (!s) return '';
    if (window.p86RichText && window.p86RichText.toDisplayHTML) return window.p86RichText.toDisplayHTML(s);
    return s.split(/\n+/).map(function (p) { return '<p>' + escapeHTMLLocal(p) + '</p>'; }).join('');
  }

  // A priced line table. `cfg.lines` decides how much money is exposed:
  // 'none' (description + qty only), 'extended' (extension only) or
  // 'unit+extended'. Item numbers are stable across the document so an SOV row
  // can be billed against later.
  function pricedTable(estimate, alts, cfg, opts) {
    opts = opts || {};
    var showUnit = cfg.lines === 'unit+extended';
    var showExt = cfg.lines === 'extended' || cfg.lines === 'unit+extended';
    var allLines = (window.appData && window.appData.estimateLines) || [];
    var itemNo = 0;
    var grand = 0;
    var html = '<table class="doc-table sov-table"><thead><tr>' +
      '<th class="c-no">Item</th>' +
      '<th class="c-desc">Description</th>' +
      '<th class="c-qty">Qty</th>' +
      '<th class="c-unit">Unit</th>' +
      (showUnit ? '<th class="c-money">Unit Price</th>' : '') +
      (showExt ? '<th class="c-money">' + (opts.valueLabel || 'Scheduled Value') + '</th>' : '') +
      '</tr></thead><tbody>';

    if (!alts.length) {
      html += '<tr><td colspan="6" class="doc-empty">No priced groups — toggle at least one group on in the Line Items tab.</td></tr>';
    }
    alts.forEach(function (alt) {
      var secs = groupSections(estimate, alt.id);
      var groupHasRows = secs.some(function (s) { return s.items.length; });
      html += '<tr class="grp-row"><td colspan="' + (4 + (showUnit ? 1 : 0) + (showExt ? 1 : 0)) + '">' +
        escapeHTMLLocal(alt.name || 'Scope') + '</td></tr>';
      if (!groupHasRows) {
        html += '<tr><td colspan="' + (4 + (showUnit ? 1 : 0) + (showExt ? 1 : 0)) + '" class="doc-empty">No line items entered.</td></tr>';
      }
      secs.forEach(function (sec) {
        if (!sec.items.length) return;
        html += '<tr class="sec-row"><td></td><td colspan="' + (3 + (showUnit ? 1 : 0) + (showExt ? 1 : 0)) + '">' +
          escapeHTMLLocal(sec.name) + '</td></tr>';
        sec.items.forEach(function (l) {
          var m = lineMoney(estimate, l, allLines);
          itemNo++;
          html += '<tr>' +
            '<td class="c-no">' + itemNo + '</td>' +
            '<td class="c-desc">' + escapeHTMLLocal(l.description || '') + '</td>' +
            '<td class="c-qty">' + escapeHTMLLocal(l.qty != null ? String(l.qty) : '') + '</td>' +
            '<td class="c-unit">' + escapeHTMLLocal(l.unit || '') + '</td>' +
            (showUnit ? '<td class="c-money">' + moneyCell(m.unitSell) + '</td>' : '') +
            (showExt ? '<td class="c-money">' + moneyCell(m.extSell) + '</td>' : '') +
            '</tr>';
        });
      });
      if (cfg.subtotals) {
        var sub = computeGroupTotal(estimate, alt.id);
        if (sub != null) {
          grand += sub;
          html += '<tr class="sub-row"><td></td><td colspan="' + (2 + (showUnit ? 1 : 0)) + '">Subtotal — ' +
            escapeHTMLLocal(alt.name || 'Scope') + '</td>' +
            '<td class="c-money"' + (showExt ? '' : ' colspan="2"') + '>' + moneyCell(sub) + '</td></tr>';
        }
      }
    });
    html += '</tbody></table>';
    return html;
  }

  // Build every section this document system knows how to draw. Returns a map
  // of key -> function; the layout decides which are called and in what order.
  function buildSections(estimate, template, ctx, cfg, prep) {
    var includedAlts = prep.includedAlts;
    var excluded = excludedAltsOf(estimate);
    var licence = (template.license_line || template.company_header || '');
    var validDays = 30;

    function heading(t) { return '<h2 class="section-heading">' + escapeHTMLLocal(t) + '</h2>'; }
    function para(t) { return t ? '<p class="doc-para">' + escapeHTMLLocal(t) + '</p>' : ''; }

    function sigRows(withTitle) {
      return '<div class="sig-block">' +
        '<div class="sig-row"><span class="sig-label">Signature:</span> <span class="sig-line"></span></div>' +
        (withTitle ? '<div class="sig-row"><span class="sig-label">Printed Name:</span> <span class="sig-line"></span></div>' +
                     '<div class="sig-row"><span class="sig-label">Title:</span> <span class="sig-line"></span></div>'
                   : '<div class="sig-row"><span class="sig-label">Print Name:</span> <span class="sig-line"></span></div>') +
        '<div class="sig-row"><span class="sig-label">Date:</span> <span class="sig-line"></span></div>' +
      '</div>';
    }

    return {
      header: function () {
        return '<div class="proposal-header">' +
          '<img src="' + escapeAttrLocal(docLogoSrc()) + '" alt="' + escapeAttrLocal(template.company_header || 'Logo') + '" style="height:64px;display:block;margin:0 auto 8px;" />' +
          '<div class="company-line">' + escapeHTMLLocal(template.company_header || '') + '</div>' +
        '</div>';
      },
      compactHeader: function () {
        return '<div class="doc-band">' +
          '<img class="band-logo" src="' + escapeAttrLocal(docLogoSrc()) + '" alt="Logo" />' +
          '<div class="band-meta">' +
            '<div><span class="doc-label">Date</span> ' + escapeHTMLLocal(ctx.date) + '</div>' +
            '<div><span class="doc-label">Valid</span> ' + validDays + ' days</div>' +
          '</div>' +
        '</div>';
      },
      bandHeader: function () {
        return '<div class="doc-band">' +
          '<img class="band-logo" src="' + escapeAttrLocal(docLogoSrc()) + '" alt="Logo" />' +
          '<div class="band-meta">' +
            '<div><span class="doc-label">Proposal</span> ' + escapeHTMLLocal(estimate.estimateNumber || estimate.number || '—') + '</div>' +
            '<div><span class="doc-label">Date</span> ' + escapeHTMLLocal(ctx.date) + '</div>' +
            '<div><span class="doc-label">Valid for</span> ' + validDays + ' days</div>' +
          '</div>' +
        '</div>' +
        (licence ? '<div class="doc-licence">' + escapeHTMLLocal(licence) + '</div>' : '');
      },
      cover: function () {
        var hero = (ctx.proposalAttachments || []).filter(function (a) {
          return /^image\//.test(a.mime_type || '');
        })[0];
        var img = hero ? (hero.web_url || hero.original_url) : '';
        return '<section class="doc-cover"' + (img ? ' style="background-image:linear-gradient(180deg,rgba(15,35,70,.55),rgba(15,35,70,.88)),url(\'' + escapeAttrLocal(img) + '\');"' : '') + '>' +
          '<img class="cover-logo" src="' + escapeAttrLocal(docLogoSrc()) + '" alt="Logo" />' +
          '<h1 class="cover-title">' + escapeHTMLLocal(estimate.community || estimate.title || 'Proposal') + '</h1>' +
          '<div class="cover-sub">' + escapeHTMLLocal(estimate.title || '') + '</div>' +
          '<div class="cover-meta">' +
            '<span>' + escapeHTMLLocal(ctx.date) + '</span>' +
            '<span>Valid ' + validDays + ' days</span>' +
            (licence ? '<span>' + escapeHTMLLocal(licence) + '</span>' : '') +
          '</div>' +
        '</section>';
      },
      rfpCover: function () {
        return '<section class="doc-rfp-cover">' +
          '<img class="band-logo" src="' + escapeAttrLocal(docLogoSrc()) + '" alt="Logo" />' +
          '<h1 class="proposal-title">Bid Proposal — ' + escapeHTMLLocal(estimate.title || 'Untitled') + '</h1>' +
          '<table class="doc-kv"><tbody>' +
            '<tr><td>Association / Owner</td><td>' + escapeHTMLLocal(estimate.community || ctx.community || '—') + '</td></tr>' +
            '<tr><td>Project</td><td>' + escapeHTMLLocal(estimate.issue || estimate.title || '—') + '</td></tr>' +
            '<tr><td>Submitted</td><td>' + escapeHTMLLocal(ctx.date) + '</td></tr>' +
            '<tr><td>Bid valid for</td><td>' + validDays + ' days</td></tr>' +
          '</tbody></table>' +
        '</section>';
      },
      meta: function () {
        return '<div class="proposal-meta">' +
          '<div class="meta-left">' + prep.clientLineLeft + '</div>' +
          '<div class="meta-right">' +
            (prep.jobAddrRight ? '<div class="meta-label">Job Address:</div>' + prep.jobAddrRight : '') +
            '<div class="meta-print-date"><span class="meta-label">Print Date:</span> ' + escapeHTMLLocal(ctx.date) + '</div>' +
          '</div>' +
        '</div>';
      },
      projectBlock: function () {
        return '<table class="doc-kv"><tbody>' +
          '<tr><td>Prepared for</td><td>' + escapeHTMLLocal(estimate.community || ctx.community || '—') + '</td></tr>' +
          '<tr><td>Project</td><td>' + escapeHTMLLocal(estimate.title || '') + '</td></tr>' +
          (estimate.propertyAddr ? '<tr><td>Property</td><td>' + escapeHTMLLocal(estimate.propertyAddr) + '</td></tr>' : '') +
        '</tbody></table>';
      },
      serviceMeta: function () {
        return '<div class="doc-servicemeta">' +
          '<div><span class="doc-label">Client</span> ' + escapeHTMLLocal(estimate.community || ctx.community || '—') + '</div>' +
          (estimate.propertyAddr ? '<div><span class="doc-label">Service address</span> ' + escapeHTMLLocal(estimate.propertyAddr) + '</div>' : '') +
        '</div>';
      },
      title: function () {
        return '<h1 class="proposal-title">Proposal for ' + escapeHTMLLocal(estimate.title || 'Untitled') + '</h1>';
      },
      intro: function () { return '<p class="intro">' + prep.introHTML + '</p>'; },
      about: function () { return '<p class="about">' + escapeHTMLLocal(template.about_paragraph || '') + '</p>'; },
      divider: function () { return '<hr class="divider" />'; },
      scopeHeading: function () {
        return '<h2 class="section-heading">Scope of Work' +
          (estimate.issue ? ' &mdash; ' + escapeHTMLLocal(estimate.issue) : '') + '</h2>';
      },
      scope: function () { return prep.scopeHTML; },
      scopeStatement: function () {
        var first = includedAlts[0];
        var s = (first && first.scope) || estimate.scopeOfWork || '';
        var txt = String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (txt.length > 420) txt = txt.slice(0, 417) + '…';
        return heading('Scope') + (txt ? '<p class="doc-para">' + escapeHTMLLocal(txt) + '</p>' : '');
      },
      understanding: function () {
        return heading('Understanding of the Work') + '<p class="intro">' + prep.introHTML + '</p>';
      },
      problemStatement: function () {
        return '<p class="doc-para doc-lead">' + prep.introHTML + '</p>';
      },
      scopeNarrative: function () {
        var out = heading('Scope of Work');
        includedAlts.forEach(function (alt) {
          out += '<h4 class="doc-subhead">' + escapeHTMLLocal(alt.name || 'Scope') + '</h4>' +
            (scopeBodyHTML(alt.scope) || '<p class="doc-muted">Scope not entered for this group.</p>');
        });
        return out;
      },
      sovTable: function () {
        return heading('Schedule of Values') + pricedTable(estimate, includedAlts, cfg, {}) + this.contractTotal();
      },
      baseBidTable: function () {
        return heading('Base Bid') + pricedTable(estimate, includedAlts, cfg, { valueLabel: 'Amount' }) +
          '<div class="total-block"><span class="total-label">Base Bid Total:</span> ' +
          '<span class="total-amount">' + escapeHTMLLocal(ctx.total) + '</span></div>';
      },
      lineTable: function () {
        return pricedTable(estimate, includedAlts, cfg, { valueLabel: 'Price' });
      },
      alternatesTable: function () {
        if (!excluded.length) {
          return heading('Alternates') + '<p class="doc-muted">No alternates offered with this bid.</p>';
        }
        var rows = '';
        excluded.forEach(function (alt, i) {
          var t = computeGroupTotal(estimate, alt.id);
          rows += '<tr>' +
            '<td class="c-no">' + String.fromCharCode(65 + i) + '</td>' +
            '<td class="c-desc">' + escapeHTMLLocal(alt.name || 'Alternate') + '</td>' +
            '<td class="c-unit">ADD</td>' +
            '<td class="c-money">' + moneyCell(t || 0) + '</td>' +
          '</tr>';
        });
        return heading('Alternates') +
          '<p class="doc-muted doc-small">Priced separately and not included in the base bid. The owner may accept any, all, or none.</p>' +
          '<table class="doc-table"><thead><tr><th class="c-no">Alt</th><th class="c-desc">Description</th>' +
          '<th class="c-unit">Add / Deduct</th><th class="c-money">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>';
      },
      unitPriceTable: function () {
        // Unit prices published for comparison. Derived from the priced lines
        // that carry a unit — boards may deem a bid non-responsive if unit
        // pricing can't be produced on request.
        var allLines = (window.appData && window.appData.estimateLines) || [];
        var seen = {};
        var rows = '';
        includedAlts.forEach(function (alt) {
          groupSections(estimate, alt.id).forEach(function (sec) {
            sec.items.forEach(function (l) {
              var u = (l.unit || '').trim();
              if (!u || !l.description) return;
              var key = (l.description + '|' + u).toLowerCase();
              if (seen[key]) return;
              seen[key] = 1;
              var m = lineMoney(estimate, l, allLines);
              if (!m.unitSell) return;
              rows += '<tr><td class="c-desc">' + escapeHTMLLocal(l.description) + '</td>' +
                '<td class="c-unit">' + escapeHTMLLocal(u) + '</td>' +
                '<td class="c-money">' + moneyCell(m.unitSell) + '</td></tr>';
            });
          });
        });
        if (!rows) return '';
        return heading('Unit Prices') +
          '<p class="doc-muted doc-small">Applied to additive or deductive work authorized in writing.</p>' +
          '<table class="doc-table"><thead><tr><th class="c-desc">Item</th><th class="c-unit">Unit</th>' +
          '<th class="c-money">Unit Price</th></tr></thead><tbody>' + rows + '</tbody></table>';
      },
      tierCards: function () {
        var tiers = includedAlts.concat(excluded);
        if (!tiers.length) return '<p class="doc-muted">Add a scope group per option to build tiers.</p>';
        var mid = tiers.length >= 3 ? 1 : (tiers.length === 2 ? 1 : 0);
        var cards = '';
        tiers.forEach(function (alt, i) {
          var t = computeGroupTotal(estimate, alt.id);
          cards += '<div class="tier' + (i === mid ? ' tier-rec' : '') + '">' +
            (i === mid ? '<div class="tier-badge">AGX Recommends</div>' : '') +
            '<div class="tier-name">' + escapeHTMLLocal(alt.name || ('Option ' + (i + 1))) + '</div>' +
            '<div class="tier-price">' + moneyCell(t || 0) + '</div>' +
            '<div class="tier-body">' + (scopeBodyHTML(alt.scope) || '<p class="doc-muted">Scope not entered.</p>') + '</div>' +
          '</div>';
        });
        return '<div class="tier-grid">' + cards + '</div>';
      },
      includedInEvery: function () {
        return heading('Included with every option') +
          '<ul class="doc-list">' +
            '<li>Full workmanship warranty</li>' +
            '<li>Licensed and insured crews; certificate provided on request</li>' +
            '<li>Daily cleanup and debris removal</li>' +
            '<li>Resident notification and a single point of contact</li>' +
          '</ul>';
      },
      selectionLine: function () {
        return '<div class="doc-select"><span class="doc-label">Selected option:</span> <span class="sig-line"></span></div>';
      },
      investmentSummary: function () {
        var rows = '';
        includedAlts.forEach(function (alt) {
          var t = computeGroupTotal(estimate, alt.id);
          rows += '<tr><td class="c-desc">' + escapeHTMLLocal(alt.name || 'Scope') + '</td>' +
            '<td class="c-money">' + moneyCell(t || 0) + '</td></tr>';
        });
        return heading('Investment Summary') +
          '<table class="doc-table"><tbody>' + rows +
          '<tr class="tot-row"><td class="c-desc">Contract Total</td><td class="c-money">' +
          escapeHTMLLocal(ctx.total) + '</td></tr></tbody></table>';
      },
      contractTotal: function () {
        return '<div class="total-block"><span class="total-label">Contract Total:</span> ' +
          '<span class="total-amount">' + escapeHTMLLocal(ctx.total) + '</span></div>';
      },
      total: function () {
        return '<div class="total-block"><span class="total-label">Total Price:</span> ' +
          '<span class="total-amount">' + escapeHTMLLocal(ctx.total) + '</span></div>';
      },
      totalsBlock: function () {
        return '<div class="total-block"><span class="total-label">Total:</span> ' +
          '<span class="total-amount">' + escapeHTMLLocal(ctx.total) + '</span></div>';
      },
      optionalRows: function () {
        if (!excluded.length) return '';
        var rows = '';
        excluded.forEach(function (alt) {
          var t = computeGroupTotal(estimate, alt.id);
          rows += '<tr>' +
            '<td class="c-check"><span class="doc-box"></span></td>' +
            '<td class="c-desc">' + escapeHTMLLocal(alt.name || 'Additional work') + '</td>' +
            '<td class="c-money">' + moneyCell(t || 0) + '</td></tr>';
        });
        return heading('Optional — while we are on site') +
          '<p class="doc-muted doc-small">Check any you would like added; the total adjusts accordingly.</p>' +
          '<table class="doc-table"><tbody>' + rows + '</tbody></table>';
      },
      paymentSchedule: function () {
        return heading('Payment Schedule') +
          '<p class="doc-para">Progress billing against the schedule of values above, invoiced monthly on work completed to date. ' +
          'Retainage of 10% is held on each draw and released at final acceptance.</p>';
      },
      warrantyCO: function () {
        return heading('Warranty &amp; Changes') +
          '<p class="doc-para">All workmanship is warranted for one year from substantial completion. Manufacturer warranties on ' +
          'materials pass through to the association. Any change in scope, quantity, or conditions discovered after start will be ' +
          'priced and authorized in writing as a change order before the work proceeds.</p>';
      },
      schedulePhasing: function () {
        return heading('Schedule &amp; Access') +
          '<p class="doc-para">Work is phased to keep buildings and walkways in service. Residents receive written notice before ' +
          'work reaches their building, and a single AGX point of contact is available to management for the duration of the project.</p>';
      },
      qualifications: function () {
        return heading('Qualifications') +
          '<ul class="doc-list">' +
            '<li>Licensed and insured in the State of Florida' + (licence ? ' — ' + escapeHTMLLocal(licence) : '') + '</li>' +
            '<li>Certificate of insurance naming the association as additional insured, on request</li>' +
            '<li>References from comparable HOA and property-management projects, on request</li>' +
          '</ul>';
      },
      exclusions: function () {
        if (!prep.exclusionsHTML) return '';
        return '<h2 class="section-heading italic-heading">Assumptions, Clarifications and Exclusions:</h2>' +
          '<ol class="exclusions">' + prep.exclusionsHTML + '</ol>';
      },
      shortTerms: function () {
        return '<p class="doc-small doc-muted">' + escapeHTMLLocal(template.signature_text || '') + '</p>';
      },
      attachments: function () { return renderAttachmentsBlock(ctx.proposalAttachments); },
      sigIntro: function () { return '<p class="sig-intro">' + escapeHTMLLocal(template.signature_text || '') + '</p>'; },
      signature: function () { return sigRows(false); },
      signatureSingle: function () {
        return '<div class="sig-block"><div class="sig-row"><span class="sig-label">Approved by:</span> <span class="sig-line"></span></div></div>';
      },
      // Boards sign by officer TITLE — a signature line without one is a
      // document their attorney sends back.
      signatureTitled: function () {
        return '<p class="sig-intro">' + escapeHTMLLocal(template.signature_text || '') + '</p>' + sigRows(true);
      }
    };
  }

  function buildProposalHTML(estimate, template, ctx) {
    var clientLineLeft = '';
    // Client / community / address lines all render at the same
    // regular weight in the AGX reference proposal. No bold on the
    // first line — keeps the left column reading as one address
    // block instead of a heading-with-subtitle.
    if (estimate.client) clientLineLeft += '<div>' + escapeHTMLLocal(estimate.client) + '</div>';
    // When the picker resolves a child property under a parent firm,
    // estimate.client stores the parent firm name and estimate.community
    // stores the child property name. Show the community as a secondary
    // line in the header so the property is visible at a glance — used
    // to live only in the intro paragraph, which made it look like the
    // child pick wasn't saving.
    if (estimate.community && estimate.community !== estimate.client) {
      clientLineLeft += '<div style="font-size:12px;color:#333;">' + escapeHTMLLocal(estimate.community) + '</div>';
    }
    if (ctx.client && (ctx.client.cell || ctx.client.phone)) {
      clientLineLeft += '<div style="font-size:11px;color:#555;">Cell: ' + escapeHTMLLocal(ctx.client.cell || ctx.client.phone) + '</div>';
    }
    if (estimate.billingAddr) {
      var billingLines = String(estimate.billingAddr).split(/,\s*/);
      billingLines.forEach(function(l) {
        if (l) clientLineLeft += '<div style="font-size:11px;">' + escapeHTMLLocal(l) + '</div>';
      });
    }

    var jobAddrRight = '';
    if (estimate.propertyAddr) {
      var jobLines = String(estimate.propertyAddr).split(/,\s*/);
      jobAddrRight = jobLines.map(function(l) { return '<div>' + escapeHTMLLocal(l) + '</div>'; }).join('');
    }

    // Escape the template body first so an admin can't inject markup; the
    // placeholder substitution then injects already-safe HTML built above.
    // {name} survives HTML escaping since the brace chars aren't escaped.
    var safeIntroTemplate = escapeHTMLLocal(template.intro_template || '');
    var introHTML = fillPlaceholders(safeIntroTemplate, {
      issue: '<strong>' + escapeHTMLLocal(ctx.issue) + '</strong>',
      community: '<strong>' + escapeHTMLLocal(ctx.community) + '</strong>',
      salutation: escapeHTMLLocal(ctx.salutation),
      total: escapeHTMLLocal(ctx.total),
      date: escapeHTMLLocal(ctx.date)
    });

    // Multi-group proposal: render each INCLUDED group's scope as its own
    // titled block so the client sees what each priced scope covers. If
    // there's only one group, drop the title to keep simple jobs simple.
    // Legacy estimate.scopeOfWork is the pre-migration fallback for old
    // records that haven't been opened in the new editor yet.
    var includedIds = includedGroupIds(estimate);
    var includedAlts = (estimate.alternates || []).filter(function(a) { return includedIds.indexOf(a.id) >= 0; });
    // Optional per-group price suffix — driven by the preview toolbar
    // toggle (_showGroupTotals). Off by default so proposals stay
    // clean; admins flip it on when the client wants to see each
    // scope priced separately.
    function groupTotalSuffix(alt) {
      if (!_showGroupTotals) return '';
      var total = computeGroupTotal(estimate, alt.id);
      if (total == null) return '';
      return ' (' + fmtProposalCurrency(total) + ')';
    }
    // Render a scope narrative body. New scopes are sanitized rich-text HTML
    // (p86RichText.toDisplayHTML re-sanitizes); legacy plain-text scopes fall
    // back to newline→paragraph splitting so old records still read correctly.
    function scopeBody(s) {
      s = (s || '').trim();
      if (!s) return '';
      if (window.p86RichText && window.p86RichText.toDisplayHTML) return window.p86RichText.toDisplayHTML(s);
      return s.split(/\n+/).map(function(p) { return '<p>' + escapeHTMLLocal(p) + '</p>'; }).join('');
    }
    var scopeHTML;
    if (!includedAlts.length || (includedAlts.length === 1 && !includedAlts[0].scope && estimate.scopeOfWork)) {
      // Legacy path
      var legacyScope = ((includedAlts[0] && includedAlts[0].scope) || estimate.scopeOfWork || '').trim();
      scopeHTML = legacyScope
        ? '<div class="scope-text">' + scopeBody(legacyScope) + '</div>'
        : '<p style="color:#999;font-style:italic;">Scope of work not yet entered.</p>';
    } else if (includedAlts.length === 1) {
      var soloScope = (includedAlts[0].scope || '').trim();
      scopeHTML = soloScope
        ? '<div class="scope-text">' + scopeBody(soloScope) + '</div>'
        : '<p style="color:#999;font-style:italic;">Scope of work not yet entered.</p>';
    } else {
      scopeHTML = '<div class="scope-text">';
      includedAlts.forEach(function(alt, idx) {
        var s = (alt.scope || '').trim();
        scopeHTML += '<h4 style="margin:' + (idx === 0 ? '0' : '14px') + ' 0 6px;color:#333;font-size:13pt;">' +
          escapeHTMLLocal(alt.name) +
          escapeHTMLLocal(groupTotalSuffix(alt)) +
          '</h4>';
        if (s) scopeHTML += scopeBody(s);
        else scopeHTML += '<p style="color:#999;font-style:italic;">Scope not entered for this group.</p>';
      });
      scopeHTML += '</div>';
    }

    var exclusionsHTML = '';
    (template.exclusions || []).forEach(function(item, idx) {
      exclusionsHTML += '<li>' + escapeHTMLLocal(item) + '</li>';
    });

    // Everything above is PREP — the same data the original single-layout
    // proposal computed. What follows is the layout WALK: the chosen layout
    // names its sections in order, and each one is drawn by the matching
    // builder. 'letterhead' lists exactly the sections the hardcoded document
    // used to emit, in the same order, so the default output is unchanged.
    var layout = currentProposalLayout();
    var cfg = layout.pricing || {};
    var prep = {
      clientLineLeft: clientLineLeft,
      jobAddrRight: jobAddrRight,
      introHTML: introHTML,
      scopeHTML: scopeHTML,
      exclusionsHTML: exclusionsHTML,
      includedAlts: includedAlts
    };
    var sections = buildSections(estimate, template, ctx, cfg, prep);

    var body = '';
    (layout.sections || []).forEach(function (key) {
      var fn = sections[key];
      // An unknown key is a REGISTRY BUG, and it must be loud. Skipping it
      // silently is the worst available behaviour: a one-character typo in a
      // layout's section list would drop the pricing table out of a proposal
      // and still produce a document that reads as complete. Same treatment as
      // a builder that throws — say so on the page and in the console.
      if (typeof fn !== 'function') {
        console.error('[preview] layout "' + layout.id + '" names unknown section "' + key + '"');
        body += '<p class="doc-muted doc-small">[' + escapeHTMLLocal(key) + ' could not be rendered]</p>';
        return;
      }
      try {
        body += fn.call(sections) || '';
      } catch (e) {
        console.error('[preview] section "' + key + '" failed', e);
        body += '<p class="doc-muted doc-small">[' + escapeHTMLLocal(key) + ' could not be rendered]</p>';
      }
    });

    return '<div class="p86-proposal layout-' + escapeAttrLocal(layout.id) + '">' + body + '</div>';
  }

  // ──────────────────────────────────────────────────────────────────
  // Material Takeoff & Scope Report
  //
  // Sibling document to the proposal. Lists every line item by section
  // (subgroup) with description, qty, and unit — NO prices. Includes
  // the scope of work for each included group and an explicit
  // "ESTIMATED QUANTITIES" disclaimer at the top so the field crew /
  // sub knows the numbers are planning estimates, not measured-cut
  // quantities.
  //
  // Same CSS as the proposal so the takeoff reads as a matched
  // sibling document when printed back-to-back. Only one extra
  // class — .takeoff-table — defined in the takeoff-specific CSS
  // additions below.
  // ──────────────────────────────────────────────────────────────────
  function buildTakeoffHTML(estimate, template, ctx) {
    // Match the proposal's client / job-address header
    var clientLineLeft = '';
    if (estimate.client) clientLineLeft += '<div style="font-weight:700;">' + escapeHTMLLocal(estimate.client) + '</div>';
    if (estimate.community && estimate.community !== estimate.client) {
      clientLineLeft += '<div style="font-size:12px;color:#333;">' + escapeHTMLLocal(estimate.community) + '</div>';
    }
    if (estimate.billingAddr) {
      String(estimate.billingAddr).split(/,\s*/).forEach(function(l) {
        if (l) clientLineLeft += '<div style="font-size:11px;">' + escapeHTMLLocal(l) + '</div>';
      });
    }
    var jobAddrRight = '';
    if (estimate.propertyAddr) {
      jobAddrRight = String(estimate.propertyAddr).split(/,\s*/).map(function(l) {
        return '<div>' + escapeHTMLLocal(l) + '</div>';
      }).join('');
    }

    // ── Takeoff LEVEL ──────────────────────────────────────────────
    // One estimate, several reports. The level (js/estimate-doc-layouts.js)
    // picks the column set and the grouping; nothing below re-derives
    // quantities, so every level is the SAME numbers at a different
    // resolution. A level marked `partial` prints a banner naming exactly what
    // the data model cannot supply — a takeoff that looks complete while
    // silently omitting half a pull sheet is worse than one that says so.
    var level = currentTakeoffLevel();
    var lcfg = level.pricing || {};
    var includedAlts = includedAltsOf(estimate);
    var allLines = (window.appData && window.appData.estimateLines) || [];

    function money(n) { return escapeHTMLLocal(fmtProposalCurrency(n)); }
    function pct(n) { return (Math.round(n * 10) / 10) + '%'; }

    // Column registry. Each `cell(v)` receives {line, money, groupName, sectionName}.
    // Columns a level asks for but the model cannot fill render as WRITE-IN
    // cells (spec, notes) rather than fabricated values.
    var COLS = {
      scope:       { label: 'Scope',       cls: 'c-desc',  cell: function (v) { return escapeHTMLLocal(v.groupName || ''); } },
      section:     { label: 'Section',     cls: 'c-sec',   cell: function (v) { return escapeHTMLLocal(v.sectionName || ''); } },
      item:        { label: 'Item',        cls: 'c-desc',  cell: function (v) { return escapeHTMLLocal(v.line.description || ''); } },
      description: { label: 'Description', cls: 'c-desc',  cell: function (v) { return escapeHTMLLocal(v.line.description || ''); } },
      material:    { label: 'Material',    cls: 'c-desc',  cell: function (v) { return escapeHTMLLocal(v.line.description || ''); } },
      spec:        { label: 'Spec / Size', cls: 'c-write', cell: function () { return ''; } },
      location:    { label: 'Location',    cls: 'c-sec',   cell: function (v) { return escapeHTMLLocal(v.groupName || ''); } },
      qty:         { label: 'Qty',         cls: 'c-qty',   cell: function (v) { return escapeHTMLLocal(v.line.qty != null ? String(v.line.qty) : ''); } },
      unit:        { label: 'Unit',        cls: 'c-unit',  cell: function (v) { return escapeHTMLLocal(v.line.unit || ''); } },
      unitCost:    { label: 'Unit Cost',   cls: 'c-money', cell: function (v) { return money(v.money.unitCost); } },
      markup:      { label: 'Markup',      cls: 'c-qty',   cell: function (v) { return escapeHTMLLocal(pct(v.money.markup)); } },
      unitSell:    { label: 'Unit Price',  cls: 'c-money', cell: function (v) { return money(v.money.unitSell); } },
      extCost:     { label: 'Ext. Cost',   cls: 'c-money', cell: function (v) { return money(v.money.extCost); } },
      extSell:     { label: 'Ext. Price',  cls: 'c-money', cell: function (v) { return money(v.money.extSell); } },
      extended:    { label: 'Extended',    cls: 'c-money', cell: function (v) { return money(v.money.extSell); } },
      price:       { label: 'Price',       cls: 'c-money', cell: function (v) { return money(v.money.extSell); } },
      margin:      { label: 'Margin',      cls: 'c-qty',   cell: function (v) {
                       var s = v.money.extSell;
                       return s ? escapeHTMLLocal(pct(((s - v.money.extCost) / s) * 100)) : '—';
                     } },
      notes:       { label: 'Notes',       cls: 'c-write', cell: function () { return ''; } },
      received:    { label: '✓',           cls: 'c-check', cell: function () { return '<span class="doc-box"></span>'; } }
    };

    function colDefs(keys) {
      return (keys || []).map(function (k) { return COLS[k] ? { key: k, def: COLS[k] } : null; }).filter(Boolean);
    }
    function headRow(defs) {
      return '<thead><tr>' + defs.map(function (d) {
        return '<th class="' + d.def.cls + '">' + escapeHTMLLocal(d.def.label) + '</th>';
      }).join('') + '</tr></thead>';
    }
    function dataRow(defs, v, extraCls) {
      return '<tr' + (extraCls ? ' class="' + extraCls + '"' : '') + '>' + defs.map(function (d) {
        return '<td class="' + d.def.cls + '">' + d.def.cell(v) + '</td>';
      }).join('') + '</tr>';
    }
    function spanRow(defs, text, cls) {
      return '<tr class="' + cls + '"><td colspan="' + defs.length + '">' + escapeHTMLLocal(text) + '</td></tr>';
    }
    // Land a subtotal under the LAST money column so it never prints in a text
    // column — the levels do not share a column count.
    function moneyFootRow(defs, label, amount) {
      var lastMoney = -1;
      defs.forEach(function (d, i) { if (d.def.cls === 'c-money') lastMoney = i; });
      if (lastMoney < 0) return '';
      var post = defs.length - lastMoney - 1;
      return '<tr class="sub-row">' +
        (lastMoney ? '<td colspan="' + lastMoney + '">' + escapeHTMLLocal(label) + '</td>' : '') +
        '<td class="c-money">' + money(amount) + '</td>' +
        (post ? '<td colspan="' + post + '"></td>' : '') +
      '</tr>';
    }

    var defs = colDefs(level.columns);
    if (!defs.length) defs = colDefs(['description', 'qty', 'unit']);

    // ── Level bodies ───────────────────────────────────────────────
    function bodyGroupSection() {
      var out = '';
      includedAlts.forEach(function (alt, gIdx) {
        var secs = groupSections(estimate, alt.id);
        out += '<section class="takeoff-group"' + (gIdx ? ' style="page-break-before:always;"' : '') + '>';
        out += '<h2 class="section-heading">' + escapeHTMLLocal(alt.name || ('Group ' + (gIdx + 1))) + '</h2>';
        var sc = (alt.scope || '').trim();
        if (sc) out += '<h3 class="takeoff-subheading">Scope of Work</h3><div class="scope-text">' + scopeBodyHTML(sc) + '</div>';
        out += '<h3 class="takeoff-subheading">' + (level.id === 't5' ? 'Materials' : 'Line Items') + '</h3>';
        if (!secs.some(function (s) { return s.items.length; })) {
          out += '<p class="doc-muted">No line items entered for this group.</p></section>';
          return;
        }
        out += '<table class="doc-table takeoff-table">' + headRow(defs) + '<tbody>';
        secs.forEach(function (sec) {
          if (!sec.items.length) return;
          out += spanRow(defs, sec.name, 'sec-row');
          sec.items.forEach(function (l) {
            out += dataRow(defs, { line: l, money: lineMoney(estimate, l, allLines), groupName: alt.name, sectionName: sec.name });
          });
        });
        if (lcfg.subtotals) {
          var sub = computeGroupTotal(estimate, alt.id);
          if (sub != null) out += moneyFootRow(defs, 'Subtotal — ' + (alt.name || 'Scope'), sub);
        }
        out += '</tbody></table></section>';
      });
      return out;
    }

    // T1: one row per scope group. Qty deliberately collapses to "lot" — a
    // group is not a countable thing, and summing SF + EA + LF would print a
    // number that means nothing.
    function bodyGroup() {
      var out = '<table class="doc-table takeoff-table"><thead><tr>' +
        '<th class="c-desc">Scope</th><th class="c-desc">Covers</th>' +
        '<th class="c-qty">Lines</th><th class="c-unit">Unit</th>' +
        (lcfg.subtotals ? '<th class="c-money">Price</th>' : '') +
      '</tr></thead><tbody>';
      includedAlts.forEach(function (alt) {
        var secs = groupSections(estimate, alt.id);
        var count = 0;
        secs.forEach(function (s) { count += s.items.length; });
        var sub = computeGroupTotal(estimate, alt.id);
        var names = secs.filter(function (s) { return s.items.length; }).map(function (s) { return s.name; });
        out += '<tr>' +
          '<td class="c-desc">' + escapeHTMLLocal(alt.name || 'Scope') + '</td>' +
          '<td class="c-desc">' + (names.length ? escapeHTMLLocal(names.join(' · ')) : '<span class="doc-muted">—</span>') + '</td>' +
          '<td class="c-qty">' + count + '</td>' +
          '<td class="c-unit">lot</td>' +
          (lcfg.subtotals ? '<td class="c-money">' + money(sub || 0) + '</td>' : '') +
        '</tr>';
      });
      out += '</tbody></table>';
      if (lcfg.total) out += '<div class="total-block"><span class="total-label">Total:</span> <span class="total-amount">' + escapeHTMLLocal(ctx.total) + '</span></div>';
      return out;
    }

    // T2: scope groups down the side, SECTIONS across the top. Sections are the
    // only repeating axis an estimate actually has today — see the level's
    // caveat banner, which prints above this table.
    function bodyMatrix() {
      var colNames = [];
      includedAlts.forEach(function (alt) {
        groupSections(estimate, alt.id).forEach(function (s) {
          if (s.items.length && colNames.indexOf(s.name) < 0) colNames.push(s.name);
        });
      });
      if (!colNames.length) return '<p class="doc-muted">Nothing to pivot — no section carries line items.</p>';
      var out = '<table class="doc-table matrix-table"><thead><tr><th class="c-desc">Scope</th>' +
        colNames.map(function (n) { return '<th class="c-qty">' + escapeHTMLLocal(n) + '</th>'; }).join('') +
        '<th class="c-money">Row Total</th></tr></thead><tbody>';
      includedAlts.forEach(function (alt) {
        var byName = {};
        groupSections(estimate, alt.id).forEach(function (s) {
          var t = 0;
          s.items.forEach(function (l) { t += lineMoney(estimate, l, allLines).extSell; });
          byName[s.name] = (byName[s.name] || 0) + t;
        });
        var sub = computeGroupTotal(estimate, alt.id);
        out += '<tr><td class="c-desc">' + escapeHTMLLocal(alt.name || 'Scope') + '</td>' +
          colNames.map(function (n) {
            return '<td class="c-qty">' + (byName[n] ? money(byName[n]) : '<span class="doc-muted">—</span>') + '</td>';
          }).join('') +
          '<td class="c-money">' + money(sub || 0) + '</td></tr>';
      });
      out += '</tbody></table>';
      if (lcfg.total) out += '<div class="total-block"><span class="total-label">Total:</span> <span class="total-amount">' + escapeHTMLLocal(ctx.total) + '</span></div>';
      return out;
    }

    // T3: rollup lines carry an assemblyBreakdown snapshot — leaf rows per ONE
    // output unit. Component qty = line.qty x qty_per_unit, the same math the
    // editor's breakdown strip prints, so the two documents never disagree.
    // A line with no breakdown (already exploded, or hand-typed) renders flat.
    function bodyAssembly() {
      var out = '';
      includedAlts.forEach(function (alt, gIdx) {
        out += '<section class="takeoff-group"' + (gIdx ? ' style="page-break-before:always;"' : '') + '>';
        out += '<h2 class="section-heading">' + escapeHTMLLocal(alt.name || ('Group ' + (gIdx + 1))) + '</h2>';
        var secs = groupSections(estimate, alt.id);
        if (!secs.some(function (s) { return s.items.length; })) {
          out += '<p class="doc-muted">No line items entered for this group.</p></section>';
          return;
        }
        out += '<table class="doc-table takeoff-table">' + headRow(defs) + '<tbody>';
        secs.forEach(function (sec) {
          if (!sec.items.length) return;
          out += spanRow(defs, sec.name, 'sec-row');
          sec.items.forEach(function (l) {
            out += dataRow(defs, { line: l, money: lineMoney(estimate, l, allLines), groupName: alt.name, sectionName: sec.name }, 'asm-parent');
            var parts = Array.isArray(l.assemblyBreakdown) ? l.assemblyBreakdown : [];
            parts.forEach(function (b) {
              if (!b || typeof b !== 'object') return;
              var q = Math.round((Number(l.qty) || 0) * (Number(b.qty_per_unit) || 0) * 100) / 100;
              var uc = Number(b.unit_cost) || 0;
              out += dataRow(defs, {
                line: { description: '↳ ' + (b.description || '(item)'), qty: q, unit: b.unit || '' },
                money: { unitCost: uc, unitSell: uc, extCost: q * uc, extSell: q * uc, markup: 0 },
                groupName: alt.name,
                sectionName: b.cost_code || sec.name
              }, 'asm-child');
            });
          });
        });
        if (lcfg.subtotals) {
          var sub = computeGroupTotal(estimate, alt.id);
          if (sub != null) out += moneyFootRow(defs, 'Subtotal — ' + (alt.name || 'Scope'), sub);
        }
        out += '</tbody></table></section>';
      });
      return out;
    }

    var groupsHTML;
    if (!includedAlts.length) {
      groupsHTML = '<p class="doc-muted">No groups included for this takeoff. Toggle at least one group on in the Line Items tab.</p>';
    } else if (level.grouping === 'group') {
      groupsHTML = bodyGroup();
    } else if (level.grouping === 'matrix') {
      groupsHTML = bodyMatrix();
    } else if (level.grouping === 'assembly') {
      groupsHTML = bodyAssembly();
    } else {
      groupsHTML = bodyGroupSection();
    }

    var audienceBadge = level.audience === 'internal'
      ? '<div class="doc-flag doc-flag-internal">INTERNAL — contains cost and margin. Not for the client.</div>'
      : (level.audience === 'field' ? '<div class="doc-flag doc-flag-field">FIELD COPY — no pricing.</div>' : '');

    var caveatBanner = (level.status === 'partial' && level.caveat)
      ? '<div class="doc-flag doc-flag-caveat"><strong>Known gap:</strong> ' + escapeHTMLLocal(level.caveat) + '</div>'
      : '';

    return (
      '<div class="p86-proposal p86-takeoff takeoff-' + escapeAttrLocal(level.id) + '">' +
        '<div class="proposal-header">' +
          '<img src="' + escapeAttrLocal(docLogoSrc()) + '" alt="' + escapeAttrLocal(template.company_header || '') + '" style="height:64px;display:block;margin:0 auto 8px;" />' +
          '<div class="company-line">' + escapeHTMLLocal(template.company_header || '') + '</div>' +
        '</div>' +
        '<div class="proposal-meta">' +
          '<div class="meta-left">' + clientLineLeft + '</div>' +
          '<div class="meta-right">' +
            (jobAddrRight ? '<div class="meta-label">Job Address:</div>' + jobAddrRight : '') +
            '<div class="meta-print-date"><span class="meta-label">Print Date:</span> ' + escapeHTMLLocal(ctx.date) + '</div>' +
          '</div>' +
        '</div>' +
        '<h1 class="proposal-title">' + escapeHTMLLocal(String(level.label).replace(/^T\d+\s*—\s*/, '')) +
          (estimate.title ? ' &mdash; ' + escapeHTMLLocal(estimate.title) : '') +
        '</h1>' +
        audienceBadge +
        caveatBanner +
        '<div class="takeoff-disclaimer">' +
          '<strong>ESTIMATED QUANTITIES.</strong> The quantities listed on this report are planning estimates derived from scope review and reference photographs. Field-measured counts may vary based on actual site conditions, finish selections, waste factors, and code-driven attachment requirements. Verify each line at jobsite walkthrough before procurement.' +
        '</div>' +
        '<hr class="divider" />' +
        groupsHTML +
        '<hr class="divider" />' +
        '<p class="sig-intro">Reviewed by:</p>' +
        '<div class="sig-block">' +
          '<div class="sig-row"><span class="sig-label">Signature:</span> <span class="sig-line"></span></div>' +
          '<div class="sig-row"><span class="sig-label">Date:</span> <span class="sig-line"></span></div>' +
          '<div class="sig-row"><span class="sig-label">Print Name:</span> <span class="sig-line"></span></div>' +
        '</div>' +
      '</div>'
    );
  }

  // Stylesheet shared between the in-tab preview and the print window. The
  // print window grabs its own copy via window-open + document.write.
  //
  // Sizes track the actual AGX proposal PDFs (which are letter-paper, Arial,
  // ~11pt body). Using pt rather than px so the screen preview lines up with
  // the printed PDF rather than rendering everything ~30% larger.
  function getProposalCSS() {
    return (
      // Tuned to mirror the AGX print-from-Buildertrend proposal:
      // Arial 11pt body, generous breathing room between the header
      // contact line and the client/job meta block, larger gap before
      // the title, and right-aligned Total Price on its own visual
      // line (no top border — the divider above the heading carries
      // the separation).
      '.p86-proposal { font-family: Arial, Helvetica, sans-serif; color: #222; font-size: 11pt; line-height: 1.5; max-width: 8.5in; margin: 0 auto; padding: 0.55in 0.6in 0.6in; background: #fff; box-shadow: 0 2px 18px rgba(0,0,0,0.4); }' +
      '.p86-proposal .proposal-header { text-align: center; margin-bottom: 6px; }' +
      '.p86-proposal .proposal-header img { height: 70px; display: block; margin: 0 auto 4px; }' +
      '.p86-proposal .company-line { font-size: 10pt; color: #222; letter-spacing: 0.2px; margin-top: 4px; }' +
      '.p86-proposal .proposal-meta { display: flex; justify-content: space-between; gap: 30px; margin: 28px 0 8px; font-size: 10pt; }' +
      '.p86-proposal .meta-left { flex: 1; line-height: 1.45; }' +
      '.p86-proposal .meta-left > div { margin: 0; }' +
      '.p86-proposal .meta-right { text-align: right; flex: 0 0 auto; min-width: 200px; font-size: 10pt; line-height: 1.45; }' +
      '.p86-proposal .meta-right > div { margin: 0; }' +
      '.p86-proposal .meta-label { font-weight: 700; color: #222; }' +
      '.p86-proposal .meta-print-date { margin-top: 4px; }' +
      '.p86-proposal .proposal-title { font-size: 18pt; font-weight: 700; color: #222; margin: 26px 0 18px; line-height: 1.2; }' +
      '.p86-proposal .intro, .p86-proposal .about { margin: 14px 0; text-align: left; font-size: 11pt; line-height: 1.55; }' +
      '.p86-proposal .about { margin-bottom: 22px; }' +
      '.p86-proposal .divider { border: none; border-top: 1px solid #c8c8c8; margin: 18px 0 22px; }' +
      '.p86-proposal .section-heading { font-size: 13pt; font-weight: 700; color: #222; margin: 18px 0 10px; }' +
      '.p86-proposal .italic-heading { font-style: italic; font-size: 11pt; margin: 18px 0 10px; }' +
      '.p86-proposal .scope-text { margin: 6px 0 10px; }' +
      '.p86-proposal .scope-text p { margin: 2px 0; font-size: 10.5pt; line-height: 1.5; }' +
      // Total block — right-aligned on its own visual row. The
      // divider above the Assumptions heading handles the rule, so
      // no border on the total itself.
      '.p86-proposal .total-block { text-align: right; font-size: 15pt; font-weight: 700; color: #222; margin: 8px 0 22px; }' +
      '.p86-proposal .total-block .total-label { color: #222; margin-right: 8px; }' +
      // Numbered exclusions: indented list, items spaced out so the
      // wrapped lines read as paragraphs rather than dense bullets.
      '.p86-proposal .exclusions { padding-left: 26px; margin: 10px 0 22px; }' +
      '.p86-proposal .exclusions li { margin: 10px 0; font-size: 10.5pt; text-align: left; line-height: 1.5; padding-left: 4px; }' +
      '.p86-proposal .exclusions li ul { padding-left: 20px; margin: 6px 0; }' +
      '.p86-proposal .exclusions li ul li { margin: 6px 0; font-size: 10.5pt; }' +
      '.p86-proposal .sig-intro { margin-top: 26px; font-size: 10pt; }' +
      '.p86-proposal .sig-block { margin-top: 18px; }' +
      '.p86-proposal .sig-row { display: flex; align-items: center; gap: 14px; margin: 22px 0; font-size: 10pt; }' +
      '.p86-proposal .sig-label { font-weight: 700; min-width: 90px; }' +
      '.p86-proposal .sig-line { flex: 1; border-bottom: 1.5px solid #333; height: 0; }' +
      '.p86-proposal .attached-photos { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 10px 0 18px; }' +
      '.p86-proposal .attached-photo { margin: 0; border: 1px solid #ddd; border-radius: 4px; overflow: hidden; background: #fafafa; page-break-inside: avoid; }' +
      '.p86-proposal .attached-photo img { width: 100%; height: auto; display: block; }' +
      '.p86-proposal .attached-photo figcaption { padding: 4px 8px; font-size: 9pt; color: #555; background: #f3f4f6; border-top: 1px solid #e5e7eb; word-break: break-all; }' +
      '.p86-proposal .attached-docs { padding-left: 22px; margin: 6px 0 18px; font-size: 10pt; }' +
      '.p86-proposal .attached-docs li { margin: 4px 0; }' +
      '.p86-proposal .attached-docs a { color: #0b5fff; text-decoration: underline; }' +
      // ── Takeoff additions ────────────────────────────────────────────
      // Reuses .p86-proposal as the wrapper so header / meta / scope
      // styling carries over. Only the takeoff-specific bits — table,
      // section labels, disclaimer — get unique selectors.
      '.p86-proposal.p86-takeoff .takeoff-disclaimer { background: #fff8e1; border-left: 3px solid #d97706; padding: 10px 12px; margin: 12px 0 14px; font-size: 10pt; line-height: 1.45; color: #4a3500; }' +
      '.p86-proposal.p86-takeoff .takeoff-disclaimer strong { color: #b45309; letter-spacing: 0.3px; }' +
      '.p86-proposal.p86-takeoff .takeoff-subheading { font-size: 11pt; font-weight: 700; color: #333; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0.4px; }' +
      '.p86-proposal.p86-takeoff .takeoff-section { margin: 8px 0 14px; page-break-inside: avoid; }' +
      '.p86-proposal.p86-takeoff .takeoff-section-name { font-size: 10.5pt; font-weight: 700; color: #222; margin: 10px 0 4px; padding: 4px 8px; background: #f3f4f6; border-left: 3px solid #4f8cff; }' +
      '.p86-proposal.p86-takeoff .takeoff-table { width: 100%; border-collapse: collapse; margin-bottom: 6px; font-size: 10pt; }' +
      '.p86-proposal.p86-takeoff .takeoff-table th, .p86-proposal.p86-takeoff .takeoff-table td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }' +
      '.p86-proposal.p86-takeoff .takeoff-table th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.5px; color: #555; background: #fafafa; border-bottom: 1px solid #d1d5db; }' +
      '.p86-proposal.p86-takeoff .takeoff-table .col-desc { width: auto; }' +
      '.p86-proposal.p86-takeoff .takeoff-table .col-qty { width: 80px; text-align: right; font-family: "SF Mono", Consolas, monospace; }' +
      '.p86-proposal.p86-takeoff .takeoff-table .col-unit { width: 80px; text-align: left; color: #555; }' +
      '.p86-proposal.p86-takeoff .takeoff-group { margin-bottom: 18px; }' +
      // ── Layout structure ─────────────────────────────────────────────
      // Structural CSS for the section builders. Everything here is scoped
      // under .p86-proposal so it inherits the same Arial/11pt/letter-paper
      // body as the original document — a layout changes the SKELETON, never
      // the AGX look. Colors stay in the existing palette (#0f2346 navy,
      // #4f8cff accent, #d97706 warning) so any layout prints as one family.
      '.p86-proposal .doc-band { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 2px solid #0f2346; padding-bottom: 10px; margin-bottom: 6px; }' +
      '.p86-proposal .doc-band .band-logo { height: 52px; width: auto; }' +
      '.p86-proposal .doc-band .band-meta { text-align: right; font-size: 9.5pt; line-height: 1.6; color: #333; }' +
      '.p86-proposal .doc-label { display: inline-block; min-width: 62px; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.6px; color: #6b7280; }' +
      '.p86-proposal .doc-licence { font-size: 9pt; color: #6b7280; margin: 0 0 14px; }' +

      // Cover page — the hero image is a background so a missing or slow
      // attachment degrades to flat navy instead of a broken <img>.
      '.p86-proposal .doc-cover { background: #0f2346; color: #fff; background-size: cover; background-position: center; padding: 54px 40px 44px; margin: -0.55in -0.6in 26px; text-align: center; page-break-after: avoid; }' +
      '.p86-proposal .doc-cover .cover-logo { height: 60px; margin: 0 auto 22px; display: block; filter: brightness(0) invert(1); }' +
      '.p86-proposal .doc-cover .cover-title { font-size: 24pt; font-weight: 700; line-height: 1.2; margin: 0 0 8px; color: #fff; border: 0; padding: 0; }' +
      '.p86-proposal .doc-cover .cover-sub { font-size: 12pt; color: rgba(255,255,255,0.86); margin-bottom: 22px; }' +
      '.p86-proposal .doc-cover .cover-meta { display: flex; justify-content: center; flex-wrap: wrap; gap: 18px; font-size: 9.5pt; color: rgba(255,255,255,0.75); border-top: 1px solid rgba(255,255,255,0.25); padding-top: 14px; }' +
      '.p86-proposal .doc-rfp-cover { border-bottom: 2px solid #0f2346; padding-bottom: 14px; margin-bottom: 18px; }' +
      '.p86-proposal .doc-rfp-cover .band-logo { height: 52px; margin-bottom: 12px; }' +

      // Key/value project block — the "who and what" table every bid carries.
      '.p86-proposal .doc-kv { width: 100%; border-collapse: collapse; margin: 0 0 18px; font-size: 10pt; }' +
      '.p86-proposal .doc-kv td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }' +
      '.p86-proposal .doc-kv td:first-child { width: 170px; color: #6b7280; text-transform: uppercase; font-size: 8.5pt; letter-spacing: 0.5px; }' +
      '.p86-proposal .doc-servicemeta { font-size: 10pt; line-height: 1.7; margin-bottom: 14px; }' +

      // Shared priced table — SOV, base bid, alternates, unit prices and every
      // takeoff level all render through this one chassis so a client reading
      // two AGX documents side by side sees one table, not two.
      '.p86-proposal .doc-table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 10pt; }' +
      '.p86-proposal .doc-table th, .p86-proposal .doc-table td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }' +
      '.p86-proposal .doc-table th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.5px; color: #555; background: #fafafa; border-bottom: 1px solid #d1d5db; }' +
      '.p86-proposal .doc-table .c-no { width: 46px; color: #6b7280; font-family: "SF Mono", Consolas, monospace; }' +
      '.p86-proposal .doc-table .c-desc { width: auto; }' +
      '.p86-proposal .doc-table .c-sec { width: 130px; color: #555; }' +
      '.p86-proposal .doc-table .c-qty { width: 74px; text-align: right; font-family: "SF Mono", Consolas, monospace; }' +
      '.p86-proposal .doc-table .c-unit { width: 74px; color: #555; }' +
      '.p86-proposal .doc-table .c-money { width: 108px; text-align: right; font-family: "SF Mono", Consolas, monospace; white-space: nowrap; }' +
      '.p86-proposal .doc-table .c-check { width: 34px; text-align: center; }' +
      // Write-in columns the estimate model cannot fill (spec, notes). A ruled
      // blank cell tells the reader it is theirs to complete; an empty one just
      // looks like missing data.
      '.p86-proposal .doc-table .c-write { width: 118px; border-bottom: 1px solid #e5e7eb; background: repeating-linear-gradient(180deg, transparent, transparent 90%, #e5e7eb 90%, #e5e7eb 100%); }' +
      '.p86-proposal .doc-table .grp-row td { background: #0f2346; color: #fff; font-weight: 700; font-size: 9.5pt; letter-spacing: 0.4px; padding: 6px 8px; }' +
      '.p86-proposal .doc-table .sec-row td { background: #f3f4f6; font-weight: 700; font-size: 9pt; color: #333; border-left: 3px solid #4f8cff; }' +
      '.p86-proposal .doc-table .sub-row td { font-weight: 700; background: #fafafa; border-top: 1px solid #d1d5db; border-bottom: 1px solid #d1d5db; }' +
      '.p86-proposal .doc-table .tot-row td { font-weight: 700; font-size: 11pt; border-top: 2px solid #0f2346; border-bottom: none; }' +
      '.p86-proposal .doc-table .asm-child td { color: #555; font-style: italic; background: #fcfcfd; }' +
      '.p86-proposal .doc-table .asm-parent td { font-weight: 600; }' +
      '.p86-proposal .doc-table .doc-empty { color: #9ca3af; font-style: italic; text-align: center; padding: 12px 8px; }' +
      '.p86-proposal .matrix-table th { text-align: right; }' +
      '.p86-proposal .matrix-table th:first-child { text-align: left; }' +
      '.p86-proposal .doc-box { display: inline-block; width: 11px; height: 11px; border: 1px solid #6b7280; border-radius: 2px; vertical-align: middle; }' +

      // Option tiers — three cards across, one flagged as the recommendation.
      // Grid so 2, 3 or 4 options all lay out without a per-count rule.
      '.p86-proposal .tier-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 18px 0 22px; }' +
      '.p86-proposal .tier { border: 1px solid #d1d5db; border-radius: 8px; padding: 16px 14px; page-break-inside: avoid; position: relative; }' +
      '.p86-proposal .tier-rec { border: 2px solid #0f2346; box-shadow: 0 2px 10px rgba(15,35,70,0.12); }' +
      '.p86-proposal .tier-badge { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #0f2346; color: #fff; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.7px; text-transform: uppercase; padding: 3px 10px; border-radius: 10px; white-space: nowrap; }' +
      '.p86-proposal .tier-name { font-size: 12pt; font-weight: 700; color: #0f2346; margin-bottom: 4px; }' +
      '.p86-proposal .tier-price { font-size: 17pt; font-weight: 700; color: #222; font-family: "SF Mono", Consolas, monospace; margin-bottom: 10px; }' +
      '.p86-proposal .tier-body { font-size: 9.5pt; line-height: 1.5; color: #444; }' +
      '.p86-proposal .tier-body p { margin: 0 0 6px; }' +
      '.p86-proposal .doc-select { margin: 16px 0 10px; font-size: 10.5pt; }' +

      // Shared prose bits used across layouts.
      '.p86-proposal .doc-para { font-size: 10.5pt; line-height: 1.55; margin: 0 0 12px; }' +
      '.p86-proposal .doc-lead { font-size: 11.5pt; line-height: 1.6; }' +
      '.p86-proposal .doc-subhead { font-size: 11pt; font-weight: 700; color: #0f2346; margin: 14px 0 5px; }' +
      '.p86-proposal .doc-list { padding-left: 20px; margin: 6px 0 16px; font-size: 10pt; line-height: 1.6; }' +
      '.p86-proposal .doc-muted { color: #9ca3af; font-style: italic; }' +
      '.p86-proposal .doc-small { font-size: 9pt; }' +
      '.p86-proposal .sig-block .sig-row { margin: 12px 0; }' +

      // Honest flags. The internal one is deliberately loud: a T4 cost sheet
      // that reaches a client is the expensive mistake this whole document
      // system could otherwise make easy.
      '.p86-proposal .doc-flag { padding: 8px 12px; margin: 10px 0 14px; font-size: 9.5pt; line-height: 1.45; border-radius: 4px; }' +
      '.p86-proposal .doc-flag-internal { background: #fee2e2; border-left: 4px solid #b91c1c; color: #7f1d1d; font-weight: 700; letter-spacing: 0.3px; }' +
      '.p86-proposal .doc-flag-field { background: #e0f2fe; border-left: 4px solid #0369a1; color: #0c4a6e; font-weight: 700; letter-spacing: 0.3px; }' +
      '.p86-proposal .doc-flag-caveat { background: #fff8e1; border-left: 4px solid #d97706; color: #4a3500; }' +
      ''
    );
  }

  // Print stylesheet — page setup + chrome hide. Used by the popup window.
  function getPrintCSS() {
    return (
      '@page { size: letter; margin: 0.6in; }' +
      'body { margin: 0; padding: 0; background: #fff; }' +
      '.p86-proposal { box-shadow: none; padding: 0; max-width: 100%; }' +
      '.no-print { display: none !important; }'
    );
  }

  // Fetch attachments where include_in_proposal=true for the estimate
  // (and for the originating lead if linked). Used by both the in-tab
  // preview and the print window. Resolves with [] on any failure so
  // a missing attachment server doesn't break the preview itself.
  function fetchProposalAttachments(estimate) {
    if (!estimate || !window.p86Api || !window.p86Api.attachments) return Promise.resolve([]);
    var calls = [
      window.p86Api.attachments.list('estimate', estimate.id).catch(function() { return { attachments: [] }; })
    ];
    if (estimate.lead_id) {
      calls.push(window.p86Api.attachments.list('lead', estimate.lead_id).catch(function() { return { attachments: [] }; }));
    }
    return Promise.all(calls).then(function(results) {
      var all = [];
      results.forEach(function(r) {
        (r && r.attachments || []).forEach(function(a) {
          if (a && a.include_in_proposal) all.push(a);
        });
      });
      return all;
    });
  }

  // Per-session preference for which document the Preview tab is
  // showing. Survives tab toggles within a session; resets to
  // 'proposal' on hard refresh.
  var _previewMode = 'proposal'; // 'proposal' | 'takeoff'

  // Which document skeleton the proposal and takeoff render as. Persisted per
  // browser, exactly like _showGroupTotals — an estimator who works one kind of
  // job shouldn't re-pick their layout on every estimate. Both getters resolve
  // through the registry, which clamps an unknown id (a retired layout still in
  // someone's localStorage) to the safe default rather than rendering nothing.
  var _docLayoutId = (function () {
    try { return localStorage.getItem('p86-preview-doc-layout') || 'letterhead'; }
    catch (e) { return 'letterhead'; }
  })();
  var _takeoffLevelId = (function () {
    try { return localStorage.getItem('p86-preview-takeoff-level') || 't4'; }
    catch (e) { return 't4'; }
  })();

  function docRegistry() { return window.p86EstimateDocLayouts || null; }
  function currentProposalLayout() {
    var reg = docRegistry();
    // Registry missing (script not loaded) → the letterhead skeleton inline, so
    // the preview degrades to the pre-layout document instead of a blank pane.
    if (!reg) {
      return {
        id: 'letterhead',
        sections: ['header', 'meta', 'title', 'intro', 'about', 'divider',
                   'scopeHeading', 'scope', 'total', 'exclusions', 'attachments',
                   'sigIntro', 'signature'],
        pricing: { lines: 'none', subtotals: false, total: true }
      };
    }
    return reg.getProposal(_docLayoutId);
  }
  function currentTakeoffLevel() {
    var reg = docRegistry();
    if (!reg) {
      return {
        id: 't4', label: 'Full Line-Item Cost', audience: 'internal',
        columns: ['section', 'item', 'qty', 'unit', 'unitCost', 'markup', 'unitSell', 'extCost', 'extSell', 'margin'],
        grouping: 'group-section',
        pricing: { lines: 'unit+extended', subtotals: true, total: true, cost: true },
        status: 'ready'
      };
    }
    return reg.getTakeoff(_takeoffLevelId);
  }

  // Show per-group totals next to each group heading in the proposal
  // preview ("Exterior Paint ($142,500.00)"). Off by default —
  // proposals stay clean; client only sees the grand Total Price
  // unless the user opts in via the toolbar toggle. Persisted in
  // localStorage so the preference sticks across sessions.
  var _showGroupTotals = (function() {
    try { return localStorage.getItem('p86-preview-show-group-totals') === '1'; }
    catch (e) { return false; }
  })();

  // Full-precision currency formatter for proposal output. Matches
  // the leads-list formatter (dollars + cents, no rounding-to-k/M).
  function fmtProposalCurrency(n) {
    if (n == null || isNaN(n)) return '';
    n = Number(n);
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Per-group total = sum of marked-up line extensions for one
  // alternate. Mirrors the markup math in computeEstimateTotals
  // (estimates.js) but filtered to a single alternateId so each
  // group can show its own price suffix. Section-level dollar
  // markups are added once per section header — same as the
  // full-estimate version.
  function computeGroupTotal(estimate, alternateId) {
    if (!estimate || !alternateId) return null;
    if (!window.appData || !Array.isArray(window.appData.estimateLines)) return null;
    var lines = window.appData.estimateLines.filter(function(l) {
      return l.estimateId === estimate.id && l.alternateId === alternateId;
    });
    if (!lines.length) return 0;
    // If this group is excluded from the proposal total, don't apply
    // the target-margin override to it — its standalone marked-up
    // total stays line-driven (matches estimate-editor.js behavior).
    var alt = (estimate.alternates || []).find(function(a) { return a.id === alternateId; });
    var thisAltExcluded = !!(alt && alt.excludeFromTotal);
    var per = _P.computeForLines(estimate, lines);
    var markedUp = per.markedUp;
    if (targetMarginActive(estimate) && !thisAltExcluded) {
      markedUp = applyTargetMargin(per.subtotal, estimate);
    }
    return markedUp;
  }

  // Render into the Preview tab pane. Called by the editor when the user
  // switches to the Preview tab.
  function renderEstimatePreview() {
    var pane = document.getElementById('ee-tab-preview');
    if (!pane) return;
    var estimate = getCurrentEstimate();
    if (!estimate) {
      pane.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);">Open an estimate to see its preview.</div>';
      return;
    }

    var mode = _previewMode === 'takeoff' ? 'takeoff' : 'proposal';
    var modeBtn = function(key, label) {
      var active = mode === key;
      return '<button class="' + (active ? 'primary' : 'ghost') + ' small" ' +
        'onclick="window.setEstimatePreviewMode(p86Dec(\'' + p86Enc(key) + '\'))" ' +
        'style="' + (active ? '' : 'opacity:0.85;') + '">' +
        label + '</button>';
    };
    var printBtn = mode === 'takeoff'
      ? '<button class="primary small" onclick="printEstimateTakeoff()">&#x1F5A8; Print Takeoff</button>'
      : '<button class="primary small" onclick="printEstimateProposal()">&#x1F5A8; Print Proposal</button>';

    // Group-totals toggle — proposal mode only. When on, each group
    // heading in the Scope of Work section gets a "($142,500.00)"
    // suffix. Hidden on takeoff (the takeoff is no-prices by design).
    var groupTotalsToggle = mode === 'proposal'
      ? '<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim,#aaa);cursor:pointer;user-select:none;">' +
          '<input type="checkbox" id="ee-preview-show-group-totals" ' + (_showGroupTotals ? 'checked' : '') +
            ' onchange="window.toggleProposalGroupTotals(this.checked)" style="margin:0;cursor:pointer;" />' +
          'Show group totals' +
        '</label>'
      : '';

    // Document picker — the layout list in proposal mode, the takeoff levels in
    // takeoff mode. Both read the registry (js/estimate-doc-layouts.js), so a
    // layout added or retired there shows up here with no change to this file.
    // The <option> titles carry each layout's one-line "when to use it".
    var reg = docRegistry();
    var picker = '';
    var pickerCaption = '';
    if (reg) {
      var opts = (mode === 'takeoff') ? reg.listTakeoffs() : reg.listProposals();
      var cur = (mode === 'takeoff') ? currentTakeoffLevel() : currentProposalLayout();
      var setter = (mode === 'takeoff') ? 'setEstimateTakeoffLevel' : 'setEstimateDocLayout';
      picker =
        '<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim,#aaa);">' +
          (mode === 'takeoff' ? 'Detail' : 'Layout') +
          '<select onchange="window.' + setter + '(this.value)" ' +
            'style="background:var(--bg-soft,#1a1a2e);color:var(--text,#e8e8ef);border:1px solid var(--border,#333);border-radius:6px;padding:4px 8px;font-size:12px;max-width:230px;">' +
            opts.map(function (o) {
              return '<option value="' + escapeAttrLocal(o.id) + '"' + (o.id === cur.id ? ' selected' : '') +
                ' title="' + escapeAttrLocal(o.desc || '') + '">' + escapeHTMLLocal(o.label) + '</option>';
            }).join('') +
          '</select>' +
        '</label>';
      // The selected document says what it is for in plain language, and an
      // honest one-line flag when the model can't fully back it.
      pickerCaption =
        '<div class="no-print" style="padding:6px 16px;font-size:11.5px;color:var(--text-dim,#8a93a6);border-bottom:1px solid var(--border,#333);background:rgba(255,255,255,0.01);">' +
          escapeHTMLLocal(cur.desc || '') +
          (cur.status === 'partial'
            ? ' <span style="color:#f2a55c;">· Known gap — see the banner on the document.</span>'
            : '') +
        '</div>';
    }

    pane.innerHTML =
      '<style>' + getProposalCSS() + '</style>' +
      '<div class="no-print" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 16px;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#333);position:sticky;top:0;z-index:5;flex-wrap:wrap;">' +
        '<div style="margin-right:auto;display:flex;gap:4px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:3px;">' +
          modeBtn('proposal', '📄 Proposal') +
          modeBtn('takeoff',  '📋 Takeoff &amp; Scope') +
        '</div>' +
        picker +
        groupTotalsToggle +
        '<button class="ghost small" onclick="window.invalidateProposalTemplateCache(); renderEstimatePreview();" title="Re-fetch the latest template from the server">&#x21BB; Refresh Template</button>' +
        printBtn +
      '</div>' +
      pickerCaption +
      '<div id="ee-preview-render" style="padding:20px;background:#1a1a2e;min-height:600px;"><div style="text-align:center;color:#888;padding:40px;">Loading template…</div></div>';

    Promise.all([getTemplate(), fetchProposalAttachments(estimate)]).then(function(both) {
      var template = both[0];
      var atts = both[1];
      var ctx = buildContext(estimate);
      ctx.proposalAttachments = atts;
      var html = (mode === 'takeoff')
        ? buildTakeoffHTML(estimate, template, ctx)
        : buildProposalHTML(estimate, template, ctx);
      var target = document.getElementById('ee-preview-render');
      if (target) target.innerHTML = html;
    });
  }

  // Public toggle hook — flips the preview mode and re-renders.
  function setEstimatePreviewMode(mode) {
    _previewMode = (mode === 'takeoff') ? 'takeoff' : 'proposal';
    renderEstimatePreview();
  }

  // Public hooks for the document pickers. Both persist so the estimator's
  // usual document is what opens next time. The id is stored verbatim and
  // clamped on READ (registry getters), so a retired layout id sitting in
  // localStorage degrades to the default instead of breaking the preview.
  function setEstimateDocLayout(id) {
    _docLayoutId = String(id || 'letterhead');
    try { localStorage.setItem('p86-preview-doc-layout', _docLayoutId); }
    catch (e) { /* private mode, no-op */ }
    renderEstimatePreview();
  }
  function setEstimateTakeoffLevel(id) {
    _takeoffLevelId = String(id || 't4');
    try { localStorage.setItem('p86-preview-takeoff-level', _takeoffLevelId); }
    catch (e) { /* private mode, no-op */ }
    renderEstimatePreview();
  }

  // Public toggle hook for the "Show group totals" checkbox.
  // Persists the choice in localStorage so it sticks across
  // sessions, then re-renders.
  function toggleProposalGroupTotals(on) {
    _showGroupTotals = !!on;
    try {
      localStorage.setItem('p86-preview-show-group-totals', _showGroupTotals ? '1' : '0');
    } catch (e) { /* private mode, no-op */ }
    renderEstimatePreview();
  }

  // Open the proposal in a new window styled for printing, then trigger the
  // browser's print dialog. User picks "Save as PDF" to export. We let the
  // window stay open so they can re-print or close themselves.
  function printEstimateProposal() {
    var estimate = getCurrentEstimate();
    if (!estimate) { alert('No estimate is currently open.'); return; }

    Promise.all([getTemplate(), fetchProposalAttachments(estimate)]).then(function(both) {
      var template = both[0];
      var atts = both[1];
      var ctx = buildContext(estimate);
      ctx.proposalAttachments = atts;
      var html = buildProposalHTML(estimate, template, ctx);
      var title = 'Proposal - ' + (estimate.title || 'AGX').replace(/[^\w \-]+/g, '');

      var w = window.open('', '_blank');
      if (!w) { alert('Pop-up blocked. Allow pop-ups for this site to export the PDF.'); return; }

      // The print window opens to about:blank, which has no origin —
      // any relative URL in the proposal HTML (logo image, attached
      // photos served from /uploads, etc.) would resolve against
      // about:blank and 404. Pin the base to the main site's origin
      // so all relative refs resolve cleanly.
      var baseHref = (window.location && window.location.origin) ? window.location.origin + '/' : '/';
      w.document.write(
        '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<base href="' + escapeAttrLocal(baseHref) + '">' +
        '<title>' + escapeHTMLLocal(title) + '</title>' +
        '<style>' + getProposalCSS() + getPrintCSS() + '</style>' +
        '</head><body>' +
        html +
        '<script>window.addEventListener("load", function() { setTimeout(function() { window.print(); }, 300); });</' + 'script>' +
        '</body></html>'
      );
      w.document.close();
    });
  }

  // Sibling of printEstimateProposal — opens the takeoff & scope
  // report in a new window for Print-to-PDF. Same window-bootstrap
  // pattern (base href pinned to the main origin so logo + image
  // assets resolve), same CSS, only the body builder differs.
  function printEstimateTakeoff() {
    var estimate = getCurrentEstimate();
    if (!estimate) { alert('No estimate is currently open.'); return; }

    Promise.all([getTemplate(), fetchProposalAttachments(estimate)]).then(function(both) {
      var template = both[0];
      var atts = both[1];
      var ctx = buildContext(estimate);
      ctx.proposalAttachments = atts;
      var html = buildTakeoffHTML(estimate, template, ctx);
      var title = 'Takeoff - ' + (estimate.title || 'Project 86').replace(/[^\w \-]+/g, '');

      var w = window.open('', '_blank');
      if (!w) { alert('Pop-up blocked. Allow pop-ups for this site to export the PDF.'); return; }

      var baseHref = (window.location && window.location.origin) ? window.location.origin + '/' : '/';
      w.document.write(
        '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<base href="' + escapeAttrLocal(baseHref) + '">' +
        '<title>' + escapeHTMLLocal(title) + '</title>' +
        '<style>' + getProposalCSS() + getPrintCSS() + '</style>' +
        '</head><body>' +
        html +
        '<script>window.addEventListener("load", function() { setTimeout(function() { window.print(); }, 300); });</' + 'script>' +
        '</body></html>'
      );
      w.document.close();
    });
  }

  window.renderEstimatePreview = renderEstimatePreview;
  window.printEstimateProposal = printEstimateProposal;
  window.printEstimateTakeoff = printEstimateTakeoff;
  window.setEstimatePreviewMode = setEstimatePreviewMode;
  window.toggleProposalGroupTotals = toggleProposalGroupTotals;
  window.setEstimateDocLayout = setEstimateDocLayout;
  window.setEstimateTakeoffLevel = setEstimateTakeoffLevel;
  window.invalidateProposalTemplateCache = invalidateTemplateCache;
})();
