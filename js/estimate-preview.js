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

  function sectionHeaderFor(line, allLines) {
    var idx = allLines.indexOf(line);
    if (idx < 0) idx = allLines.length;
    for (var i = idx - 1; i >= 0; i--) {
      var L = allLines[i];
      if (L && L.section === '__section_header__') return L;
    }
    return null;
  }

  // Walk back from a line to find its enclosing section header's markup.
  // Honors the section's markupMode (percent/dollar) and overrideLineMarkups
  // flag. Returns the percent value to multiply line ext by; for dollar-mode
  // sections the function returns 0 (the flat amount is added at section
  // level by the caller).
  function effectiveMarkup(line, allLines, estimate) {
    var section = sectionHeaderFor(line, allLines);
    var inDollar = section && section.markupMode === 'dollar';
    if (section && section.overrideLineMarkups) {
      // Override on: ignore per-line markup. $ mode → 0. % mode → section's %.
      if (inDollar) return 0;
      if (section.markup !== '' && section.markup != null) return parseFloat(section.markup) || 0;
      if (estimate && estimate.defaultMarkup != null && estimate.defaultMarkup !== '') return parseFloat(estimate.defaultMarkup) || 0;
      return 0;
    }
    // Override off: per-line markup wins.
    if (line && line.markup !== '' && line.markup != null) return parseFloat(line.markup) || 0;
    // No per-line value: $ mode supplies no per-line default; % mode falls
    // back to the section then est.defaultMarkup.
    if (inDollar) return 0;
    if (section && section.markup !== '' && section.markup != null) return parseFloat(section.markup) || 0;
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
        if (l.section === '__section_header__') {
          // Dollar-mode section: flat $ added once.
          if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
            markedUp += parseFloat(l.markup) || 0;
          }
          return;
        }
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
  function buildProposalHTML(estimate, template, ctx) {
    var clientLineLeft = '';
    if (estimate.client) clientLineLeft += '<div style="font-weight:700;">' + escapeHTMLLocal(estimate.client) + '</div>';
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
        scopeHTML += '<h4 style="margin:' + (idx === 0 ? '0' : '14px') + ' 0 6px;color:#333;font-size:13pt;">' +
          escapeHTMLLocal(alt.name) +
          escapeHTMLLocal(groupTotalSuffix(alt)) +
          '</h4>';
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
      '<div class="p86-proposal">' +
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

    // Per included group: scope (h2) → line table grouped by section.
    // Section headers come from line.section === '__section_header__'
    // rows; everything between two section headers belongs to the
    // earlier section. We rebuild that grouping here instead of
    // assuming the editor's render order survived the data model.
    var includedIds = includedGroupIds(estimate);
    var includedAlts = (estimate.alternates || []).filter(function(a) { return includedIds.indexOf(a.id) >= 0; });

    var groupsHTML = '';
    if (!includedAlts.length) {
      groupsHTML = '<p style="color:#999;font-style:italic;">No groups included for this takeoff. Toggle at least one group on in the Line Items tab.</p>';
    } else {
      includedAlts.forEach(function(alt, gIdx) {
        var altLines = (window.appData.estimateLines || []).filter(function(l) {
          return l.estimateId === estimate.id && l.alternateId === alt.id;
        });
        // Group lines into { sectionName: [items] } in the order the
        // editor showed them. A section header without follow-on
        // lines still surfaces as an empty subsection so the field
        // team knows the bucket exists but has nothing in it.
        var sections = [];
        var currentSection = null;
        altLines.forEach(function(l) {
          if (l.section === '__section_header__') {
            currentSection = { name: l.description || 'Section', items: [] };
            sections.push(currentSection);
            return;
          }
          if (!currentSection) {
            // Edge case: lines exist before any header — slot them
            // into a synthetic "(uncategorized)" section.
            currentSection = { name: '(uncategorized)', items: [] };
            sections.push(currentSection);
          }
          currentSection.items.push(l);
        });

        // Per-group title + scope + line table
        var scopeText = (alt.scope || '').trim();
        groupsHTML += '<section class="takeoff-group" style="' + (gIdx === 0 ? '' : 'page-break-before:always;') + '">';
        if (includedAlts.length > 1) {
          groupsHTML += '<h2 class="section-heading" style="margin-top:18px;">' + escapeHTMLLocal(alt.name || ('Group ' + (gIdx + 1))) + '</h2>';
        }
        // Scope of work
        groupsHTML += '<h3 class="takeoff-subheading">Scope of Work</h3>';
        if (scopeText) {
          groupsHTML += '<div class="scope-text">' +
            scopeText.split(/\n+/).map(function(p) { return '<p>' + escapeHTMLLocal(p) + '</p>'; }).join('') +
          '</div>';
        } else {
          groupsHTML += '<p style="color:#999;font-style:italic;">Scope not entered for this group.</p>';
        }

        // Line items grouped by section. Three columns: description,
        // qty, unit. No prices on this document — that's the whole
        // point of the takeoff vs the proposal.
        groupsHTML += '<h3 class="takeoff-subheading">Line Items</h3>';
        if (!sections.length || !sections.some(function(s) { return s.items.length > 0; })) {
          groupsHTML += '<p style="color:#999;font-style:italic;">No line items entered for this group.</p>';
        } else {
          sections.forEach(function(sec) {
            if (!sec.items.length) return;
            groupsHTML += '<div class="takeoff-section">' +
              '<div class="takeoff-section-name">' + escapeHTMLLocal(sec.name) + '</div>' +
              '<table class="takeoff-table">' +
                '<thead><tr>' +
                  '<th class="col-desc">Description</th>' +
                  '<th class="col-qty">Qty</th>' +
                  '<th class="col-unit">Unit</th>' +
                '</tr></thead>' +
                '<tbody>';
            sec.items.forEach(function(l) {
              var qty = l.qty != null && l.qty !== '' ? l.qty : '';
              groupsHTML += '<tr>' +
                '<td class="col-desc">' + escapeHTMLLocal(l.description || '') + '</td>' +
                '<td class="col-qty">' + escapeHTMLLocal(String(qty)) + '</td>' +
                '<td class="col-unit">' + escapeHTMLLocal(l.unit || '') + '</td>' +
              '</tr>';
            });
            groupsHTML += '</tbody></table></div>';
          });
        }
        groupsHTML += '</section>';
      });
    }

    return (
      '<div class="p86-proposal p86-takeoff">' +
        '<div class="proposal-header">' +
          '<img src="images/logo-color.png" alt="' + escapeAttrLocal(template.company_header || '') + '" style="height:64px;display:block;margin:0 auto 8px;" />' +
          '<div class="company-line">' + escapeHTMLLocal(template.company_header || '') + '</div>' +
        '</div>' +
        '<div class="proposal-meta">' +
          '<div class="meta-left">' + clientLineLeft + '</div>' +
          '<div class="meta-right">' +
            (jobAddrRight ? '<div class="meta-label">Job Address:</div>' + jobAddrRight : '') +
            '<div class="meta-print-date"><span class="meta-label">Print Date:</span> ' + escapeHTMLLocal(ctx.date) + '</div>' +
          '</div>' +
        '</div>' +
        '<h1 class="proposal-title">Material Takeoff &amp; Scope Report' +
          (estimate.title ? ' &mdash; ' + escapeHTMLLocal(estimate.title) : '') +
        '</h1>' +
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
      '.p86-proposal { font-family: Arial, sans-serif; color: #222; font-size: 11pt; line-height: 1.45; max-width: 8.5in; margin: 0 auto; padding: 0.5in 0.6in; background: #fff; box-shadow: 0 2px 18px rgba(0,0,0,0.4); }' +
      '.p86-proposal .proposal-header { text-align: center; margin-bottom: 18px; }' +
      '.p86-proposal .company-line { font-size: 9pt; color: #444; letter-spacing: 0.2px; }' +
      '.p86-proposal .proposal-meta { display: flex; justify-content: space-between; gap: 30px; margin-bottom: 18px; font-size: 10pt; }' +
      '.p86-proposal .meta-left { flex: 1; }' +
      '.p86-proposal .meta-right { text-align: right; flex: 0 0 auto; min-width: 220px; font-size: 10pt; }' +
      '.p86-proposal .meta-label { font-weight: 700; color: #333; }' +
      '.p86-proposal .meta-print-date { margin-top: 6px; }' +
      '.p86-proposal .proposal-title { font-size: 17pt; font-weight: 700; color: #222; margin: 14px 0 14px; line-height: 1.25; }' +
      '.p86-proposal .greeting { margin: 8px 0 14px; font-size: 11pt; }' +
      '.p86-proposal .intro, .p86-proposal .about { margin: 10px 0; text-align: left; font-size: 11pt; }' +
      '.p86-proposal .divider { border: none; border-top: 1px solid #ccc; margin: 18px 0; }' +
      '.p86-proposal .section-heading { font-size: 13pt; font-weight: 700; color: #222; margin: 16px 0 8px; }' +
      '.p86-proposal .italic-heading { font-style: italic; font-size: 11pt; }' +
      '.p86-proposal .scope-text p { margin: 4px 0; font-size: 11pt; }' +
      '.p86-proposal .total-block { text-align: right; font-size: 16pt; font-weight: 700; color: #222; margin: 22px 0 16px; padding-top: 10px; border-top: 1px solid #ddd; }' +
      '.p86-proposal .total-block .total-label { color: #222; margin-right: 10px; }' +
      '.p86-proposal .exclusions { padding-left: 26px; margin: 8px 0 18px; }' +
      '.p86-proposal .exclusions li { margin: 6px 0; font-size: 10pt; text-align: left; line-height: 1.4; }' +
      '.p86-proposal .sig-intro { margin-top: 22px; font-size: 10pt; }' +
      '.p86-proposal .sig-block { margin-top: 14px; }' +
      '.p86-proposal .sig-row { display: flex; align-items: center; gap: 10px; margin: 12px 0; font-size: 10pt; }' +
      '.p86-proposal .sig-label { font-weight: 700; min-width: 80px; }' +
      '.p86-proposal .sig-line { flex: 1; border-bottom: 1px solid #333; height: 0; }' +
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
    function sectionHeaderForIdx(idx) {
      for (var i = idx - 1; i >= 0; i--) {
        var L = lines[i];
        if (L && L.section === '__section_header__') return L;
      }
      return null;
    }
    var markedUp = 0;
    lines.forEach(function(l, idx) {
      if (l.section === '__section_header__') {
        if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
          markedUp += Number(l.markup) || 0;
        }
        return;
      }
      var ext = (l.qty || 0) * (l.unitCost || 0);
      var section = sectionHeaderForIdx(idx);
      var inDollar = section && section.markupMode === 'dollar';
      var m;
      if (section && section.overrideLineMarkups) {
        m = inDollar ? 0 : ((section.markup === '' || section.markup == null) ? null : Number(section.markup));
      } else {
        m = (l.markup === '' || l.markup == null) ? null : Number(l.markup);
        if (m == null && !inDollar && section && section.markup !== '' && section.markup != null) m = Number(section.markup);
      }
      if (m == null && !inDollar && estimate.defaultMarkup != null && estimate.defaultMarkup !== '') m = Number(estimate.defaultMarkup);
      if (m == null) m = 0;
      markedUp += ext * (1 + m / 100);
    });
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
        'onclick="window.setEstimatePreviewMode(\'' + key + '\')" ' +
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

    pane.innerHTML =
      '<style>' + getProposalCSS() + '</style>' +
      '<div class="no-print" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 16px;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#333);position:sticky;top:0;z-index:5;">' +
        '<div style="margin-right:auto;display:flex;gap:4px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:3px;">' +
          modeBtn('proposal', '📄 Proposal') +
          modeBtn('takeoff',  '📋 Takeoff &amp; Scope') +
        '</div>' +
        groupTotalsToggle +
        '<button class="ghost small" onclick="window.invalidateProposalTemplateCache(); renderEstimatePreview();" title="Re-fetch the latest template from the server">&#x21BB; Refresh Template</button>' +
        printBtn +
      '</div>' +
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
  window.invalidateProposalTemplateCache = invalidateTemplateCache;
})();
