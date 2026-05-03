// AGX Estimate Preview — Phase C.
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
    intro_template: 'AG Exteriors is pleased to provide you with a proposal to complete the {issue} needed by the {community} community.',
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
    if (!window.agxApi || !window.agxApi.isAuthenticated()) {
      _templateCache = FALLBACK_TEMPLATE;
      return Promise.resolve(_templateCache);
    }
    _templateLoadPromise = window.agxApi.settings.get('proposal_template')
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

  // Walk back from a line to find its enclosing section header's markup.
  // Per-line markup overrides; section header markup is the baseline.
  // Falls back to legacy est.defaultMarkup so estimates from before the
  // section-markup change still price the same.
  function effectiveMarkup(line, allLines, estimate) {
    if (line && line.markup !== '' && line.markup != null) return parseFloat(line.markup) || 0;
    var idx = allLines.indexOf(line);
    if (idx < 0) idx = allLines.length;
    for (var i = idx - 1; i >= 0; i--) {
      var L = allLines[i];
      if (L && L.section === '__section_header__') {
        if (L.markup !== '' && L.markup != null) return parseFloat(L.markup) || 0;
        break;
      }
    }
    if (estimate && estimate.defaultMarkup != null && estimate.defaultMarkup !== '') return parseFloat(estimate.defaultMarkup) || 0;
    return 0;
  }

  // Mirrors estimate-editor's pricing pipeline. Subtotal -> per-line markup
  // -> + flat fee -> + percent fee -> + tax -> round-up -> total.
  // Sums across every INCLUDED group so a multi-group estimate's proposal
  // total reflects the union of every group whose toggle is on.
  function computeTotal(estimate) {
    if (!estimate) return 0;
    var includedIds = includedGroupIds(estimate);
    var subtotal = 0;
    var markedUp = 0;
    includedIds.forEach(function(gid) {
      var groupLines = (window.appData.estimateLines || []).filter(function(l) {
        return l.estimateId === estimate.id && l.alternateId === gid;
      });
      groupLines.forEach(function(l) {
        if (l.section === '__section_header__') return;
        var ext = (parseFloat(l.qty) || 0) * (parseFloat(l.unitCost) || 0);
        subtotal += ext;
        var m = effectiveMarkup(l, groupLines, estimate);
        markedUp += ext * (1 + m / 100);
      });
    });
    var feeFlat = parseFloat(estimate.feeFlat) || 0;
    var feePct = (parseFloat(estimate.feePct) || 0) / 100;
    var taxPct = (parseFloat(estimate.taxPct) || 0) / 100;
    var roundTo = parseFloat(estimate.roundTo) || 0;
    var preTax = markedUp + feeFlat + (markedUp * feePct);
    var total = preTax + (preTax * taxPct);
    if (roundTo > 0) total = Math.ceil(total / roundTo) * roundTo;
    return total;
  }

  // Build a context object the placeholder-filler reads from. Salutation +
  // community + issue have multiple potential sources (estimate field ->
  // linked client field -> sensible default). Total + date are derived.
  function buildContext(estimate) {
    var clients = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
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
  function buildProposalHTML(estimate, template, ctx) {
    var clientLineLeft = '';
    if (estimate.client) clientLineLeft += '<div style="font-weight:700;">' + escapeHTMLLocal(estimate.client) + '</div>';
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
    var scopeHTML;
    if (!includedAlts.length || (includedAlts.length === 1 && !includedAlts[0].scope && estimate.scopeOfWork)) {
      // Legacy path
      var legacyScope = ((includedAlts[0] && includedAlts[0].scope) || estimate.scopeOfWork || '').trim();
      scopeHTML = legacyScope
        ? '<div class="scope-text">' + legacyScope.split(/\n+/).map(function(p) { return '<p>' + escapeHTMLLocal(p) + '</p>'; }).join('') + '</div>'
        : '<p style="color:#999;font-style:italic;">Scope of work not yet entered.</p>';
    } else if (includedAlts.length === 1) {
      var soloScope = (includedAlts[0].scope || '').trim();
      scopeHTML = soloScope
        ? '<div class="scope-text">' + soloScope.split(/\n+/).map(function(p) { return '<p>' + escapeHTMLLocal(p) + '</p>'; }).join('') + '</div>'
        : '<p style="color:#999;font-style:italic;">Scope of work not yet entered.</p>';
    } else {
      scopeHTML = '<div class="scope-text">';
      includedAlts.forEach(function(alt, idx) {
        var s = (alt.scope || '').trim();
        scopeHTML += '<h4 style="margin:' + (idx === 0 ? '0' : '14px') + ' 0 6px;color:#333;font-size:13pt;">' + escapeHTMLLocal(alt.name) + '</h4>';
        if (s) scopeHTML += s.split(/\n+/).map(function(p) { return '<p>' + escapeHTMLLocal(p) + '</p>'; }).join('');
        else scopeHTML += '<p style="color:#999;font-style:italic;">Scope not entered for this group.</p>';
      });
      scopeHTML += '</div>';
    }

    var exclusionsHTML = '';
    (template.exclusions || []).forEach(function(item, idx) {
      exclusionsHTML += '<li>' + escapeHTMLLocal(item) + '</li>';
    });

    var html =
      '<div class="agx-proposal">' +
        '<div class="proposal-header">' +
          '<img src="images/logo-color.png" alt="AG Exteriors" style="height:64px;display:block;margin:0 auto 8px;" />' +
          '<div class="company-line">' + escapeHTMLLocal(template.company_header || '') + '</div>' +
        '</div>' +

        '<div class="proposal-meta">' +
          '<div class="meta-left">' + clientLineLeft + '</div>' +
          '<div class="meta-right">' +
            (jobAddrRight ? '<div class="meta-label">Job Address:</div>' + jobAddrRight : '') +
            '<div class="meta-print-date"><span class="meta-label">Print Date:</span> ' + escapeHTMLLocal(ctx.date) + '</div>' +
          '</div>' +
        '</div>' +

        '<h1 class="proposal-title">Proposal for ' + escapeHTMLLocal(estimate.title || 'Untitled') + '</h1>' +

        '<p class="greeting">Dear <strong>' + escapeHTMLLocal(ctx.salutation) + '</strong>,</p>' +

        '<p class="intro">' + introHTML + '</p>' +

        '<p class="about">' + escapeHTMLLocal(template.about_paragraph || '') + '</p>' +

        '<hr class="divider" />' +

        '<h2 class="section-heading">Scope of Work' +
          (estimate.issue ? ': ' + escapeHTMLLocal(String(estimate.issue).toUpperCase()) : '') +
        '</h2>' +
        scopeHTML +

        '<div class="total-block">' +
          '<span class="total-label">Total Price:</span> ' +
          '<span class="total-amount">' + escapeHTMLLocal(ctx.total) + '</span>' +
        '</div>' +

        '<h2 class="section-heading italic-heading">Assumptions, Clarifications and Exclusions:</h2>' +
        '<ol class="exclusions">' + exclusionsHTML + '</ol>' +

        // Attached photos / documents — every attachment with
        // include_in_proposal=true on either the estimate itself or the
        // originating lead. Photos render as a 2-up grid; PDFs/docs
        // appear as a small bulleted list with a download note.
        renderAttachmentsBlock(ctx.proposalAttachments) +

        '<p class="sig-intro">' + escapeHTMLLocal(template.signature_text || '') + '</p>' +

        '<div class="sig-block">' +
          '<div class="sig-row"><span class="sig-label">Signature:</span> <span class="sig-line"></span></div>' +
          '<div class="sig-row"><span class="sig-label">Date:</span> <span class="sig-line"></span></div>' +
          '<div class="sig-row"><span class="sig-label">Print Name:</span> <span class="sig-line"></span></div>' +
        '</div>' +
      '</div>';

    return html;
  }

  // Stylesheet shared between the in-tab preview and the print window. The
  // print window grabs its own copy via window-open + document.write.
  //
  // Sizes track the actual AGX proposal PDFs (which are letter-paper, Arial,
  // ~11pt body). Using pt rather than px so the screen preview lines up with
  // the printed PDF rather than rendering everything ~30% larger.
  function getProposalCSS() {
    return (
      '.agx-proposal { font-family: Arial, sans-serif; color: #222; font-size: 11pt; line-height: 1.45; max-width: 8.5in; margin: 0 auto; padding: 0.5in 0.6in; background: #fff; box-shadow: 0 2px 18px rgba(0,0,0,0.4); }' +
      '.agx-proposal .proposal-header { text-align: center; margin-bottom: 18px; }' +
      '.agx-proposal .company-line { font-size: 9pt; color: #444; letter-spacing: 0.2px; }' +
      '.agx-proposal .proposal-meta { display: flex; justify-content: space-between; gap: 30px; margin-bottom: 18px; font-size: 10pt; }' +
      '.agx-proposal .meta-left { flex: 1; }' +
      '.agx-proposal .meta-right { text-align: right; flex: 0 0 auto; min-width: 220px; font-size: 10pt; }' +
      '.agx-proposal .meta-label { font-weight: 700; color: #333; }' +
      '.agx-proposal .meta-print-date { margin-top: 6px; }' +
      '.agx-proposal .proposal-title { font-size: 17pt; font-weight: 700; color: #222; margin: 14px 0 14px; line-height: 1.25; }' +
      '.agx-proposal .greeting { margin: 8px 0 14px; font-size: 11pt; }' +
      '.agx-proposal .intro, .agx-proposal .about { margin: 10px 0; text-align: left; font-size: 11pt; }' +
      '.agx-proposal .divider { border: none; border-top: 1px solid #ccc; margin: 18px 0; }' +
      '.agx-proposal .section-heading { font-size: 13pt; font-weight: 700; color: #222; margin: 16px 0 8px; }' +
      '.agx-proposal .italic-heading { font-style: italic; font-size: 11pt; }' +
      '.agx-proposal .scope-text p { margin: 4px 0; font-size: 11pt; }' +
      '.agx-proposal .total-block { text-align: right; font-size: 16pt; font-weight: 700; color: #222; margin: 22px 0 16px; padding-top: 10px; border-top: 1px solid #ddd; }' +
      '.agx-proposal .total-block .total-label { color: #222; margin-right: 10px; }' +
      '.agx-proposal .exclusions { padding-left: 26px; margin: 8px 0 18px; }' +
      '.agx-proposal .exclusions li { margin: 6px 0; font-size: 10pt; text-align: left; line-height: 1.4; }' +
      '.agx-proposal .sig-intro { margin-top: 22px; font-size: 10pt; }' +
      '.agx-proposal .sig-block { margin-top: 14px; }' +
      '.agx-proposal .sig-row { display: flex; align-items: center; gap: 10px; margin: 12px 0; font-size: 10pt; }' +
      '.agx-proposal .sig-label { font-weight: 700; min-width: 80px; }' +
      '.agx-proposal .sig-line { flex: 1; border-bottom: 1px solid #333; height: 0; }' +
      '.agx-proposal .attached-photos { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 10px 0 18px; }' +
      '.agx-proposal .attached-photo { margin: 0; border: 1px solid #ddd; border-radius: 4px; overflow: hidden; background: #fafafa; page-break-inside: avoid; }' +
      '.agx-proposal .attached-photo img { width: 100%; height: auto; display: block; }' +
      '.agx-proposal .attached-photo figcaption { padding: 4px 8px; font-size: 9pt; color: #555; background: #f3f4f6; border-top: 1px solid #e5e7eb; word-break: break-all; }' +
      '.agx-proposal .attached-docs { padding-left: 22px; margin: 6px 0 18px; font-size: 10pt; }' +
      '.agx-proposal .attached-docs li { margin: 4px 0; }' +
      '.agx-proposal .attached-docs a { color: #0b5fff; text-decoration: underline; }' +
      ''
    );
  }

  // Print stylesheet — page setup + chrome hide. Used by the popup window.
  function getPrintCSS() {
    return (
      '@page { size: letter; margin: 0.6in; }' +
      'body { margin: 0; padding: 0; background: #fff; }' +
      '.agx-proposal { box-shadow: none; padding: 0; max-width: 100%; }' +
      '.no-print { display: none !important; }'
    );
  }

  // Fetch attachments where include_in_proposal=true for the estimate
  // (and for the originating lead if linked). Used by both the in-tab
  // preview and the print window. Resolves with [] on any failure so
  // a missing attachment server doesn't break the preview itself.
  function fetchProposalAttachments(estimate) {
    if (!estimate || !window.agxApi || !window.agxApi.attachments) return Promise.resolve([]);
    var calls = [
      window.agxApi.attachments.list('estimate', estimate.id).catch(function() { return { attachments: [] }; })
    ];
    if (estimate.lead_id) {
      calls.push(window.agxApi.attachments.list('lead', estimate.lead_id).catch(function() { return { attachments: [] }; }));
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

    pane.innerHTML =
      '<style>' + getProposalCSS() + '</style>' +
      '<div class="no-print" style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#333);position:sticky;top:0;z-index:5;">' +
        '<button class="ghost small" onclick="window.invalidateProposalTemplateCache(); renderEstimatePreview();" title="Re-fetch the latest template from the server">&#x21BB; Refresh Template</button>' +
        '<button class="primary small" onclick="printEstimateProposal()">&#x1F5A8; Print to PDF</button>' +
      '</div>' +
      '<div id="ee-preview-render" style="padding:20px;background:#1a1a2e;min-height:600px;"><div style="text-align:center;color:#888;padding:40px;">Loading template…</div></div>';

    Promise.all([getTemplate(), fetchProposalAttachments(estimate)]).then(function(both) {
      var template = both[0];
      var atts = both[1];
      var ctx = buildContext(estimate);
      ctx.proposalAttachments = atts;
      var html = buildProposalHTML(estimate, template, ctx);
      var target = document.getElementById('ee-preview-render');
      if (target) target.innerHTML = html;
    });
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

      w.document.write(
        '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + escapeHTMLLocal(title) + '</title>' +
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
  window.invalidateProposalTemplateCache = invalidateTemplateCache;
})();
