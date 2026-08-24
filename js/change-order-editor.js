// Promise confirm. Native confirm() returns undefined inside an installed PWA,
// so every `if (!confirm(x)) return` guard silently did nothing there: the
// dialog never appeared and the action never ran. Uses the in-app overlay when
// present, native only as a fallback.
function p86Ask(message, opts) {
  opts = opts || {};
  if (typeof window.p86Confirm === 'function') {
    return window.p86Confirm({
      title: opts.title || 'Confirm', message: message,
      confirmLabel: opts.confirmLabel || 'Confirm', confirmText: opts.confirmLabel || 'Confirm',
      cancelLabel: 'Cancel', cancelText: 'Cancel',
      danger: opts.danger !== false, destructive: opts.danger !== false
    });
  }
  return Promise.resolve(window.confirm(message));
}
// Change Order editor — full-screen overlay for building a job-scoped
// Change Order with line items, target-margin math, and an approval
// lifecycle that gates WIP impact.
//
// Public surface:
//   window.p86ChangeOrders.openNew(jobId)  — create a draft + open editor
//   window.p86ChangeOrders.open(coId)      — load existing + open editor
//   window.p86ChangeOrders.close()         — close any open editor
//
// Save flow: debounced PUT /api/change-orders/:id (700ms) — same
// pattern as estimate-editor. The data blob mirrors the CO record's
// data column (title, scope, targetMargin, lines[], etc.) minus the
// canonical columns the server manages (status, co_number, etc.).
//
// All pricing math goes through window.p86Pricing (js/pricing-pipeline.js)
// — same module the estimate editor uses, so the totals chip bar
// here matches the estimate's PROPOSAL TOTAL bar exactly.
(function() {
  'use strict';

  // ONE implementation of line identity, shared with the estimate editor —
  // js/line-identity.js. It was lifted out of this file unchanged; the
  // functions below keep their names and their call sites so nothing else
  // here moved. The reason for the move is that the estimate editor needed
  // the same two-pass uniqueness walk, and a second copy of it is exactly
  // the thing that drifts silently in this repo.
  //
  // Browser: the module is a <script> tag ahead of this one and lands on
  // window. Node/jest: this file is require()d directly, so it require()s the
  // module directly — the `typeof require` guard short-circuits in the
  // browser, where `require` does not exist.
  var LID = (typeof window !== 'undefined' && window.p86LineIdentity)
    || (typeof require === 'function' ? require('./line-identity.js') : null);

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

  function fmtCurrency(n) {
    if (n == null || isNaN(n)) n = 0;
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // NULL IS NOT ZERO. p86Pricing.grossMarginPct returns null when there is
  // no revenue to divide by, and this used to swallow that into a confident
  // "0.0%" on the one chip people read. An em dash says "there is no answer"
  // — which is the true statement — and it is the same glyph the estimate
  // editor and the Live Rooms margin column already print for it.
  function fmtPct(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(1) + '%';
  }

  // Per-editor state — single CO open at a time. Reset on open() so
  // we never leak data between sessions.
  var _stateCo = null;   // backing store for the _state.co accessor below
  var _state = {
    dirty: false,
    saveTimer: null,
    saving: false,
    lastSavedAt: null,
    saveError: null
  };

  // `co` IS AN ACCESSOR, NOT A FIELD, AND THAT IS THE WHOLE POINT.
  //
  // A line's id is its ADDRESS in this editor (see adoptCo). The editor
  // must be unable to HOLD a line that has no address — whatever handed it
  // one. That invariant used to be enforced at the top of paintLines, which
  // made it a property of what had been RENDERED rather than of what is
  // STORED: true only after a paint, skipped entirely by the
  // `if (!host) return` above it, and invisible to every reader that does
  // not paint first — coApplyAddLineItem's section findIndex, coSectionTotals,
  // flushSave's payload, and any harness that assembles state directly.
  //
  // Enforcing it on the PROPERTY instead means every assignment heals: the
  // two open doors, the test seam, and any door added later that nobody
  // remembers to audit. There is no call site left to leak from.
  //
  // The heal MUTATES the record in place and returns the same object, so
  // `co` keeps its identity and each line keeps its own: an id, once
  // minted, is byte-stable for the life of the session and across every
  // repaint. Deriving one at render time instead would hand each row a new
  // address on every paint, which detaches the caret's row from its line
  // and collapses every open assembly strip.
  Object.defineProperty(_state, 'co', {
    enumerable: true,
    configurable: true,
    get: function () { return _stateCo; },
    set: function (co) { _stateCo = adoptCo(co); }
  });

  // Idempotent random-ish id generator for new lines. Same convention
  // as estimate-editor — short enough to be readable in DevTools, long
  // enough that collision inside one CO is effectively impossible.
  function newLineId() { return LID.newLineId(); }

  // A line's `id` is its ADDRESS in this editor. paintLines writes it into
  // data-line-id, and EVERY handler bound to the row — unit cost, qty,
  // description, unit sell, markup, the blur reconciler, the delete button,
  // the section $/% toggle — resolves the line by matching that attribute
  // back against _state.co.lines[].id.
  //
  // A line with no id renders data-line-id="" (escapeAttr maps undefined to
  // ''), and the lookup then compares String(undefined) === String("") —
  // "undefined" === "", false. The handler finds no line and RETURNS on its
  // first statement. Nothing is written to the record, markDirty() never
  // fires, no autosave is armed, and the save pill goes on reading "Saved".
  // Every chip stays frozen. That is not a pricing bug and not a repaint
  // bug: the row is inert, and it looks exactly like the app refusing to do
  // arithmetic. Delete is worse than dead — its filter KEEPS every line,
  // because "undefined" !== "" is true of all of them.
  //
  // Producers that ship id-less lines: the bulk PDF importer and the
  // agent/Scribe. Both doors stamp server-side now, but records ALREADY
  // STORED id-less do not heal until something writes them, and nothing
  // could write them while the editor was dead. So the editor heals what it
  // is handed — at the STATE boundary, not on the way to the screen.
  //
  // A DUPLICATE id is the same defect wearing a different hat: two rows
  // resolve to the first line, so edits to the second land on the first.
  // Re-mint those as well.
  //
  // Minting does NOT mark the record dirty — opening a change order must
  // not save it. The ids ride along with the first real edit, which is now
  // possible, and the PUT door stores them.

  // Mint an id that is taken by NOTHING on this record. Termination is
  // structural, not probabilistic: the retry suffix strictly increases and
  // the taken set is finite. The previous shape was
  // `do { id = newLineId(); } while (taken[id]);`, which relies on
  // Math.random eventually disagreeing with itself — and spins forever, on
  // the main thread, if it does not.
  function mintLineId(taken) { return LID.mintId(taken); }

  // Two passes, deliberately. Pass 1 claims every id ALREADY on the record,
  // so a minted id cannot collide with one a LATER line is still holding;
  // pass 2 fills the gaps. A single pass would let row 1's new id land on
  // row 9's existing one.
  function ensureLineIds(lines) { return LID.ensureLineIds(lines); }

  // THE STATE BOUNDARY. Everything assigned to _state.co passes through
  // here, so "every line this editor holds has its own address" is a fact
  // about the STATE — true before the first paint, and true whether or not
  // anything ever paints.
  //
  // THE HOLE THIS USED TO LEAVE OPEN. An accessor on _state.co intercepts
  // `_state.co = X`. It does NOT intercept `_state.co.lines = X` or
  // `.lines.push(x)` — both of those read THROUGH the getter and mutate what
  // it returned, so the record-level boundary never saw them. That was
  // demonstrated live: assigning the lines array straight onto an adopted
  // record yielded unhealed lines. guardHostArray moves the boundary down one
  // level onto `lines` itself — the assignment door and the three
  // Array.prototype methods that can INSERT (push/unshift/splice) all heal
  // now, on this record and on every record adopted after it.
  function adoptCo(co) {
    if (co && typeof co === 'object') LID.guardHostArray(co, 'lines');
    return co;
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────
  // Default Terms & Conditions seeded on a NEW change order (fully editable
  // in the rich-text field; existing COs are never overwritten).
  var DEFAULT_CO_TERMS =
    '<p>Please review and approve this Change Order to confirm the adjustment to your original Scope of Work.</p>' +
    '<p>By approving, you acknowledge the updated construction schedule and understand that invoicing will occur either upon approval or at completion of the project. Timely payment helps us keep the project moving smoothly and on schedule.</p>';

  var _onClose = null;      // one-shot: the caller's own surface repaint, fired on close()

  function openNew(jobId, opts) {
    _onClose = (opts && typeof opts.onClose === 'function') ? opts.onClose : null;
    if (!jobId) { console.warn('openNew: jobId required'); return; }
    if (!window.p86Api || !window.p86Api.changeOrders) {
      alert('API not available'); return;
    }
    window.p86Api.changeOrders.create(jobId, {
      title: '',
      scope: '',
      terms: DEFAULT_CO_TERMS,
      targetMargin: '',
      defaultMarkup: '',
      feeFlat: 0, feePct: 0,
      taxPct: 0, roundTo: 0,
      lines: []
    }).then(function(r) {
      var co = r && r.change_order;
      if (!co) throw new Error('Create failed (empty response)');
      _state.co = co;
      mount();
    }).catch(function(e) {
      alert('Could not create change order: ' + (e.message || e));
    });
  }
  function openExisting(coId, opts) {
    _onClose = (opts && typeof opts.onClose === 'function') ? opts.onClose : null;
    if (!coId) { console.warn('open: coId required'); return; }
    if (!window.p86Api || !window.p86Api.changeOrders) {
      alert('API not available'); return;
    }
    window.p86Api.changeOrders.get(coId).then(function(r) {
      var co = r && r.change_order;
      if (!co) throw new Error('Not found');
      _state.co = co;
      mount();
    }).catch(function(e) {
      alert('Could not open change order: ' + (e.message || e));
    });
  }
  function close() {
    // Flush any pending save before tearing down so we don't lose the
    // user's last keystroke.
    if (_state.saveTimer) {
      clearTimeout(_state.saveTimer);
      _state.saveTimer = null;
      if (_state.dirty) flushSave();
    }
    var overlay = document.getElementById('co-editor-overlay');
    if (overlay) overlay.remove();
    document.body.style.overflow = '';
    // Release the drawer target + close the drawer so it doesn't linger
    // pointed at a torn-down CO (falls back to the estimate editor).
    if (window.p86ActiveLineTarget === coLineTarget) {
      try { delete window.p86ActiveLineTarget; } catch (e) { window.p86ActiveLineTarget = null; }
      try {
        if (window.MaterialsDrawer && window.MaterialsDrawer.close) window.MaterialsDrawer.close();
        // Clear any CO-staged scope so it can't bleed into the next estimate.
        if (window.MaterialsDrawer && window.MaterialsDrawer.reset) window.MaterialsDrawer.reset();
      } catch (e) {}
    }
    var _jobId = _state.co && _state.co.job_id;
    _state.co = null;
    _state.dirty = false;
    _state.saving = false;
    _state.saveError = null;
    // The caller's own surface repaint (e.g. a host list the editor was opened
    // from). _onClose is one-shot.
    var _cb = _onClose; _onClose = null;
    if (_cb) { try { _cb(); } catch (_) {} }
    // ONE refresh call: it patches appData.jobChangeOrders and then repaints
    // the jobs-list Total Income (contract + CO) tile, the Jobs Hub list and
    // this job's money sections. This used to call p86JobsHubRefresh() itself
    // as well, so closing the editor ran two hub refetches and two repaints
    // 200ms apart for a single edit.
    if (window.p86Refresh) window.p86Refresh('co', { jobId: _jobId });
  }

  // ──────────────────────────────────────────────────────────────────
  // Save flow — debounced PUT + save-state indicator
  // ──────────────────────────────────────────────────────────────────
  function markDirty() {
    _state.dirty = true;
    paintSaveStatus();
    if (_state.saveTimer) clearTimeout(_state.saveTimer);
    _state.saveTimer = setTimeout(flushSave, 700);
  }
  // THE save payload. One builder, because there are two savers — flushSave
  // (debounced, every keystroke) and flushSaveSync (status transitions, i.e.
  // APPROVE) — and they had hand-copied the same object literal.
  //
  // The PUT replaces `data` wholesale, so a key this builder omits is DELETED
  // from the record. This editor is not the record's only writer: the
  // allocation window sets `completionMode` + `riderScopeName`, the CO→building
  // split writes `buildingAllocations`, and the PO cost-draw wiring writes
  // `costSource`/`costDraws`. None of those has a control in this editor, so
  // none of them was in the literal — and typing one character into a line
  // silently erased whichever the record held. A change order set to ride its
  // scope reverted to the default completion clock on the next keystroke, with
  // nothing on screen to say so, and approving it did the same.
  //
  // Preserve, do not default. A key ABSENT on the record stays absent —
  // writing `costDraws: []` where there was no key is itself a change, and
  // `costDraws` is money wiring. A key present is written back untouched.
  // This editor OWNS the ten fields below and is a CUSTODIAN of the rest.
  var CO_CUSTODIAL_KEYS = ['completionMode', 'riderScopeName',
    'buildingAllocations', 'costSource', 'costDraws'];

  function coSavePayload(co) {
    var data = {
      title: co.title || '',
      scope: co.scope || '',
      terms: co.terms || '',
      // NOT `co.targetPrice || ''` — that idiom is lossy here. A typed "0"
      // is a real (refused) entry a person can see and correct; folding it
      // to '' would blank the field on the next open with no explanation.
      targetPrice: co.targetPrice == null ? '' : co.targetPrice,
      targetMargin: co.targetMargin || '',
      defaultMarkup: co.defaultMarkup || '',
      feeFlat: co.feeFlat || 0,
      feePct: co.feePct || 0,
      taxPct: co.taxPct || 0,
      roundTo: co.roundTo || 0,
      lines: Array.isArray(co.lines) ? co.lines : []
    };
    CO_CUSTODIAL_KEYS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(co, k) && co[k] !== undefined) {
        data[k] = co[k];
      }
    });
    return data;
  }

  function flushSave() {
    if (!_state.co || _state.saving) return;
    var co = _state.co;
    var data = coSavePayload(co);
    _state.saving = true;
    _state.saveError = null;
    paintSaveStatus();
    window.p86Api.changeOrders.update(co.id, data)
      .then(function(r) {
        var fresh = r && r.change_order;
        if (fresh) {
          // Keep server-canonical fields fresh (updated_at, etc.) but
          // don't clobber in-progress local edits to data fields.
          _state.co.updated_at = fresh.updated_at;
          _state.co.status = fresh.status;
        }
        _state.dirty = false;
        _state.saving = false;
        _state.lastSavedAt = new Date();
        paintSaveStatus();
        // THE SAVE LANDED, SO EVERY OTHER SURFACE IS NOW WRONG.
        //
        // Only close() refreshed. The editor is an overlay over the job page,
        // so with it open the CO tile, the Jobs Hub list and this job's money
        // sections went on showing the pre-edit number for as long as the user
        // kept typing — and "I changed the cost and the CO total didn't move"
        // is indistinguishable from that, because a change order's total is
        // read from more than one place.
        //
        // The shared primitive, with the entity's existing registry entry —
        // not a bespoke repaint. It patches appData.jobChangeOrders from the
        // server and repaints the four job-money surfaces.
        //
        // This also closes a race close() has always had: close() fires the
        // pending flush and then refreshes IMMEDIATELY, so the refetch could
        // beat the PUT and repaint the stale row. Refreshing from the save's
        // own success is ordered by construction.
        if (window.p86Refresh) window.p86Refresh('co', { jobId: co.job_id });
      })
      .catch(function(e) {
        _state.saving = false;
        _state.saveError = e && e.message ? e.message : 'Save failed';
        paintSaveStatus();
      });
  }

  // ──────────────────────────────────────────────────────────────────
  // Pricing / totals
  // ──────────────────────────────────────────────────────────────────
  function computeTotals() {
    var co = _state.co;
    if (!co || !window.p86Pricing) return null;
    var lines = Array.isArray(co.lines) ? co.lines : [];
    var per = window.p86Pricing.computeForLines(co, lines);
    var subtotal = per.subtotal;
    // Shared resolver — carries the sell-lock carve-out under an active
    // target margin. Hand-rolling the ternary here is how the editor's
    // total and the server's WIP number drift apart.
    var markedUp = window.p86Pricing.resolveMarkedUp(per, co);
    var fees = window.p86Pricing.applyFeesAndTax(markedUp, co, per);
    // GROSS MARGIN AND GROSS PROFIT, from the shared definition.
    //
    // Both of these used to divide/subtract against `fees.total`, which is
    // markedUp + feeFlat + feePctAmount + taxAmount + rounded — so the
    // numerator carried FOUR non-cost additions, and the biggest of them is
    // sales tax collected on behalf of the state. On a $34,000 change order
    // at 7% tax this strip printed 19.1176% margin and $6,500 of profit
    // where the real figures are 9.4344% and $2,864.76.
    //
    // Markup and Profit now print the same number, and that is correct
    // rather than redundant: gross profit IS the markup on the work. They
    // differed before only because one of them was wrong.
    var marginPct = window.p86Pricing.grossMarginPct(subtotal, markedUp);
    var lineCount = lines.filter(function(l) { return l.section !== '__section_header__'; }).length;
    var lockedCount = lines.filter(function(l) {
      return l.section !== '__section_header__' && window.p86Pricing.sellLocked(l);
    }).length;
    var pendingCount = lines.filter(function(l) {
      return l.section !== '__section_header__' && l.costPending;
    }).length;
    return {
      subtotal: subtotal,
      markupAmount: markedUp - subtotal,
      markedUp: markedUp,
      feeFlat: fees.feeFlat,
      feePctAmount: fees.feePctAmount,
      taxAmount: fees.taxAmount,
      total: fees.total,
      profit: markedUp - subtotal,
      marginPct: marginPct,
      lineCount: lineCount,
      lockedCount: lockedCount,
      pendingCount: pendingCount,
      // null when no client price was asked for. Carries `ok` and, when it
      // is false, the reason the screen has to explain.
      clientPrice: window.p86Pricing.clientPriceState
        ? window.p86Pricing.clientPriceState(co, lines) : null
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Line-target adapter — lets the shared Materials Drawer (catalog +
  // 🧩 assemblies + explode) insert lines into THIS change order exactly
  // as it does for the estimate editor. The drawer already does the
  // assembly explode client-side and hands us line "specs"; we translate
  // each spec into a CO line and route it into a CO section by cost
  // bucket. No server change, no pricing-model change — every added line
  // is still a plain qty×unitCost CO line the shared p86Pricing consumes.
  // ──────────────────────────────────────────────────────────────────
  var CO_BUCKET_SECTION = {
    materials: 'Materials',
    labor: 'Labor',
    gc: 'General Conditions',
    sub: 'Subcontractor Costs'
  };
  function coNum(v) { return (window.p86Pricing && window.p86Pricing.num) ? window.p86Pricing.num(v) : (parseFloat(v) || 0); }
  // Which cost bucket a drawer spec belongs in (materials|labor|gc|sub).
  // Prefer an explicit bucket/cost-code; else infer from the drawer's
  // section_name by keyword (the drawer uses its own section labels like
  // "Direct Labor", so an exact-label match against ours would misroute).
  var CO_BUCKETS = ['materials', 'labor', 'gc', 'sub'];
  function coBucketFor(input) {
    var v = input.bt_category || input.assembly_bucket || input.cost_code;
    if (v) { v = String(v).toLowerCase(); if (CO_BUCKETS.indexOf(v) !== -1) return v; }
    var nm = String(input.section_name || '').toLowerCase();
    if (nm) {
      if (/labor/.test(nm)) return 'labor';
      if (/general\s*cond|\bgc\b/.test(nm)) return 'gc';
      if (/\bsub/.test(nm)) return 'sub';
      if (/material|supplies/.test(nm)) return 'materials';
    }
    return null;
  }
  // Find-or-create the section header for a bucket; returns its line id.
  // CO headers key off `label`; we also stamp `btCategory` so a later
  // add re-uses the same section deterministically (like the estimate).
  function coEnsureSection(bucket) {
    var lines = _state.co.lines = (Array.isArray(_state.co.lines) ? _state.co.lines : []);
    var label = CO_BUCKET_SECTION[bucket] || CO_BUCKET_SECTION.materials;
    var hdr = lines.find(function (l) {
      return l.section === '__section_header__' &&
        (l.btCategory === bucket || String(l.label || '').toLowerCase() === label.toLowerCase());
    });
    if (hdr) { if (!hdr.btCategory) hdr.btCategory = bucket; return hdr.id; }
    var id = newLineId();
    lines.push({ id: id, section: '__section_header__', label: label, btCategory: bucket, markup: '', markupMode: 'percent' });
    return id;
  }
  // Translate one drawer spec → a CO line, inserted inside its section
  // (right before the next section header, mirroring the estimate).
  function coApplyAddLineItem(input) {
    if (!_state.co) throw new Error('No change order open.');
    var lines = _state.co.lines = (Array.isArray(_state.co.lines) ? _state.co.lines : []);
    var bucket = coBucketFor(input) || 'materials';
    var sectionId = coEnsureSection(bucket);
    var line = {
      id: newLineId(),
      qty: coNum(input.qty),
      unitCost: coNum(input.unit_cost),
      description: input.description || '',
      unit: input.unit || 'ea',
      markup: (input.markup_pct == null || input.markup_pct === '') ? '' : Number(input.markup_pct),
      markupMode: 'percent'
    };
    if (input.source_material_id != null) line.sourceMaterialId = input.source_material_id;
    if (input.source_assembly_id != null) line.sourceAssemblyId = input.source_assembly_id;
    if (Array.isArray(input.assembly_breakdown) && input.assembly_breakdown.length) line.assemblyBreakdown = input.assembly_breakdown;
    if (input.assembly_bucket) line.assemblyBucket = String(input.assembly_bucket);
    if (input.assembly_params && typeof input.assembly_params === 'object') line.assemblyParams = input.assembly_params;
    // Insert just before the next section header so the line is "born in"
    // its section (never appended to the array end).
    var startIdx = lines.findIndex(function (l) { return l.id === sectionId; });
    if (startIdx >= 0) {
      var insertAt = lines.length;
      for (var j = startIdx + 1; j < lines.length; j++) {
        if (lines[j].section === '__section_header__') { insertAt = j; break; }
      }
      lines.splice(insertAt, 0, line);
    } else {
      lines.push(line);
    }
    if (!input._silent) { markDirty(); paintLines(); paintTotals(); }
    return 'Added: "' + line.description + '" — qty ' + line.qty + ' @ $' + line.unitCost.toFixed(2);
  }
  function coApplyBulkAddLineItems(specs) {
    if (!Array.isArray(specs) || !specs.length) return [];
    var out = [];
    specs.forEach(function (s) {
      try { out.push(coApplyAddLineItem(Object.assign({ _silent: true }, s || {}))); } catch (e) {}
    });
    markDirty(); paintLines(); paintTotals();
    return out;
  }
  // The 4-method contract the Materials Drawer talks to (targetApi()).
  var coLineTarget = {
    noun: 'change order',
    getOpenId: function () { return _state.co ? _state.co.id : null; },
    activeAlternateName: function () { return _state.co ? (_state.co.title || 'This change order') : null; },
    applyAddLineItem: coApplyAddLineItem,
    applyBulkAddLineItems: coApplyBulkAddLineItems
  };
  // Open the shared catalog/assemblies drawer pointed at THIS change order.
  function openCatalogDrawer() {
    if (!window.MaterialsDrawer || typeof window.MaterialsDrawer.open !== 'function') {
      alert('The catalog is still loading — try again in a moment.'); return;
    }
    // Start from a clean drawer so a scope staged for a prior target (e.g.
    // an estimate) can't bleed into this change order.
    if (typeof window.MaterialsDrawer.reset === 'function') window.MaterialsDrawer.reset();
    window.p86ActiveLineTarget = coLineTarget;
    window.MaterialsDrawer.open();
  }

  // ──────────────────────────────────────────────────────────────────
  // Customer-facing Change Order document (print / Save-as-PDF)
  // ──────────────────────────────────────────────────────────────────
  // Opens a clean, self-contained document in a new window rendering the
  // rich Scope of Work + included-work list + the authoritative Total +
  // rich Terms & Conditions + a signature block. Cost/markup are never
  // shown — only the customer price (Total). Rich fields are sanitized via
  // p86RichText.toDisplayHTML before injection.
  function openCoCustomerDoc() {
    var co = _state.co;
    if (!co) return;
    // Best-effort flush so the persisted CO matches what we print (the doc
    // itself reads the live in-memory record regardless).
    if (_state.dirty) { try { flushSave(); } catch (e) {} }

    var RT = window.p86RichText;
    var toHTML = function (v) { return (RT && RT.toDisplayHTML) ? RT.toDisplayHTML(v) : escapeHTML(v || ''); };
    var money = function (n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var t = computeTotals() || {};
    var job = (window.appData && window.appData.jobs || []).find(function (j) { return j.id === co.job_id; }) || {};
    var jobNo = job.jobNumber || '';
    var jobTitle = job.title || job.name || '';
    var addr = job.address || [job.street_address, job.city, job.state, job.zip].filter(Boolean).join(', ');
    var client = job.client || '';
    var coNo = co.co_number || '';
    var dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Included-work: section headers → group titles, priced lines → bullets
    // (descriptions only — no per-line pricing so cost/margin never leak and
    // the single Total is always the authoritative number).
    var lines = Array.isArray(co.lines) ? co.lines : [];
    var workHTML = '', listOpen = false;
    lines.forEach(function (l) {
      if (l.section === '__section_header__') {
        if (listOpen) { workHTML += '</ul>'; listOpen = false; }
        workHTML += '<h3 class="co-sec">' + escapeHTML(l.label || 'Section') + '</h3>';
      } else {
        var d = (l.description || '').trim();
        if (!d) return;
        if (!listOpen) { workHTML += '<ul class="co-lines">'; listOpen = true; }
        var qty = parseFloat(l.qty);
        var qtyLabel = (qty && qty !== 1) ? ' <span class="co-qty">(&times;' + escapeHTML(String(qty)) + ')</span>' : '';
        workHTML += '<li>' + escapeHTML(d) + qtyLabel + '</li>';
      }
    });
    if (listOpen) workHTML += '</ul>';

    var logoUrl = location.origin + '/images/logo-color.png';
    var doc =
      '<!doctype html><html><head><meta charset="utf-8"><title>Change Order' + (coNo ? ' ' + escapeHTML(coNo) : '') + '</title>' +
      '<style>' +
        '*{box-sizing:border-box;} body{font-family:Georgia,"Times New Roman",serif;color:#1a1a1a;margin:0;padding:32px;line-height:1.5;}' +
        '.doc{max-width:800px;margin:0 auto;}' +
        '.hd{text-align:center;border-bottom:2px solid #1B8541;padding-bottom:14px;margin-bottom:16px;}' +
        '.hd img{height:60px;} .hd .co{font-size:12px;color:#555;letter-spacing:1px;margin-top:6px;}' +
        '.ttl{font-size:24px;font-weight:bold;color:#1B3A5C;text-align:center;margin:6px 0 14px;}' +
        '.meta{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;gap:20px;}' +
        '.meta .lbl{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}' +
        'h2.sec{font-size:15px;color:#1B3A5C;border-bottom:1px solid #ddd;padding-bottom:4px;margin:22px 0 10px;}' +
        'h3.co-sec{font-size:13px;color:#333;margin:12px 0 4px;} ul.co-lines{margin:0 0 8px;padding-left:22px;} ul.co-lines li{margin:2px 0;} .co-qty{color:#888;font-size:12px;}' +
        '.scope,.terms{font-size:13.5px;} .scope p,.terms p{margin:0 0 8px;}' +
        '.total{margin:20px 0 4px;padding:14px 18px;background:#f1f5f9;border-radius:8px;display:flex;justify-content:space-between;align-items:center;}' +
        '.total .l{font-weight:bold;color:#1B3A5C;font-size:15px;} .total .v{font-weight:bold;font-size:22px;color:#1B3A5C;}' +
        '.tax{font-size:12px;color:#666;text-align:right;margin:0 4px 16px;}' +
        '.sig{margin-top:40px;display:flex;gap:40px;} .sig .box{flex:1;} .sig .line{border-bottom:1px solid #333;height:34px;} .sig .cap{font-size:11px;color:#666;margin-top:4px;}' +
        '.bar{position:fixed;top:10px;right:10px;} .bar button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#1B8541;color:#fff;cursor:pointer;font-weight:bold;}' +
        '@media print{.bar{display:none;} body{padding:0;}}' +
      '</style></head><body>' +
      '<div class="bar"><button onclick="window.print()">Print / Save PDF</button></div>' +
      '<div class="doc">' +
        '<div class="hd"><img src="' + escapeAttr(logoUrl) + '" alt="AG Exteriors" onerror="this.style.display=\'none\'"/>' +
          '<div class="co">CHANGE ORDER' + (coNo ? ' ' + escapeHTML(coNo) : '') + '</div></div>' +
        '<div class="ttl">' + escapeHTML(co.title || 'Change Order') + '</div>' +
        '<div class="meta">' +
          '<div><div class="lbl">Job</div>' + escapeHTML(window.p86JobLabel(jobNo, jobTitle, { fallback: '' })) + (addr ? '<br>' + escapeHTML(addr) : '') + '</div>' +
          '<div style="text-align:right;">' + (client ? '<div class="lbl">Client</div>' + escapeHTML(client) + '<br>' : '') + '<span class="lbl">Date</span> ' + escapeHTML(dateStr) + '</div>' +
        '</div>' +
        '<h2 class="sec">Scope of Work</h2><div class="scope">' + toHTML(co.scope) + '</div>' +
        (workHTML ? '<h2 class="sec">Included Work</h2>' + workHTML : '') +
        '<div class="total"><span class="l">Change Order Total</span><span class="v">' + money(t.total) + '</span></div>' +
        ((t.taxAmount && t.taxAmount > 0) ? '<div class="tax">Includes tax ' + money(t.taxAmount) + '</div>' : '') +
        (co.terms ? '<h2 class="sec">Terms &amp; Conditions</h2><div class="terms">' + toHTML(co.terms) + '</div>' : '') +
        '<div class="sig">' +
          '<div class="box"><div class="line"></div><div class="cap">Client signature</div></div>' +
          '<div class="box"><div class="line"></div><div class="cap">Date</div></div>' +
        '</div>' +
      '</div></body></html>';

    var w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups to preview the Change Order PDF.'); return; }
    w.document.open(); w.document.write(doc); w.document.close();
  }

  // ──────────────────────────────────────────────────────────────────
  // Mount + paint
  // ──────────────────────────────────────────────────────────────────
  function mount() {
    var prior = document.getElementById('co-editor-overlay');
    if (prior) prior.remove();
    var overlay = document.createElement('div');
    overlay.id = 'co-editor-overlay';
    overlay.className = 'p86-co-overlay';
    overlay.innerHTML = renderShell();
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    // Claim the shared Materials Drawer's insert target so catalog +
    // assembly adds land in THIS change order (cleared on close()).
    window.p86ActiveLineTarget = coLineTarget;

    overlay.addEventListener('click', function(e) {
      // Close on backdrop click (NOT on inner content)
      if (e.target === overlay) {
        if (_state.dirty || _state.saving) {
          // Save is debounced — flush then close
          if (_state.saveTimer) clearTimeout(_state.saveTimer);
          flushSave();
        }
        close();
      }
    });

    wireHeader(overlay);
    wireSidePanel(overlay);
    wireRichFields(overlay);
    paintLines();
    paintTotals();
    paintStatusPill();
    applyCoLockState();
    paintSaveStatus();

    // Escape closes the editor (same as estimates / reports overlays).
    overlay.tabIndex = -1;
    overlay.focus();
    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  function renderShell() {
    var co = _state.co;
    var coNumber = co.co_number || '';
    return (
      '<div class="p86-co-host">' +
        // ── Top bar: title + status pill + close ────────────────
        '<div class="p86-co-topbar">' +
          '<div class="p86-co-topbar-left">' +
            '<span class="p86-co-conumber">' + escapeHTML(coNumber) + '</span>' +
            '<input class="p86-co-title-input" type="text" placeholder="Change Order title (e.g. Add gable vents)" ' +
              'value="' + escapeAttr(co.title || '') + '" data-field="title" />' +
          '</div>' +
          '<div class="p86-co-topbar-right">' +
            '<span id="p86CoStatusPill" class="p86-co-status-pill"></span>' +
            '<span id="p86CoSaveStatus" class="p86-co-save-status"></span>' +
            '<button class="ee-btn ghost" data-co-close title="Close">&times;</button>' +
          '</div>' +
        '</div>' +
        // ── Totals chip bar ───────────────────────────────────────
        '<div id="p86CoTotals" class="p86-co-totals"></div>' +
        // ── Body: side panel + line table ─────────────────────────
        '<div class="p86-co-body">' +
          // Side panel — title/scope/margins/fees/tax
          '<aside class="p86-co-side">' +
            '<div class="p86-co-field">' +
              '<span>Scope of Work</span>' +
              '<div id="p86CoScopeHost" class="p86-co-rt"></div>' +
            '</div>' +
            '<div class="p86-co-field">' +
              '<span>Terms &amp; Conditions</span>' +
              '<div id="p86CoTermsHost" class="p86-co-rt"></div>' +
            '</div>' +
            // CLIENT PRICE — type what the client pays; markup and margin
            // back-compute from it. It sits directly above Target Margin
            // because the two write the same number and the typed price
            // wins; putting them apart would hide that.
            //
            // type="text", NOT type="number": a person types money as
            // "$34,000.00", and a number input silently discards the whole
            // value the moment a $ or a comma appears. The raw string is
            // stored and p86Pricing.parseMoney reads it — the same parser
            // the server-side pipeline uses, so an agent writing a raw
            // string into the blob gets the same answer this field does.
            '<label class="p86-co-field">' +
              '<span>Client Price $</span>' +
              '<input type="text" inputmode="decimal" autocomplete="off" data-field="targetPrice" placeholder="(optional — what the client pays; markup and margin back-compute)" value="' + escapeAttr(co.targetPrice == null ? '' : co.targetPrice) + '" />' +
            '</label>' +
            '<label class="p86-co-field">' +
              '<span>Target Margin %</span>' +
              '<input type="number" min="0" max="99" step="0.1" data-field="targetMargin" placeholder="(optional — overrides line markups)" value="' + escapeAttr(co.targetMargin == null ? '' : co.targetMargin) + '" />' +
            '</label>' +
            '<label class="p86-co-field">' +
              '<span>Default Markup %</span>' +
              '<input type="number" min="0" step="0.1" data-field="defaultMarkup" placeholder="Fallback when line/section markup is blank" value="' + escapeAttr(co.defaultMarkup == null ? '' : co.defaultMarkup) + '" />' +
            '</label>' +
            '<div class="p86-co-field-row">' +
              '<label class="p86-co-field">' +
                '<span>Flat Fee $</span>' +
                '<input type="number" step="0.01" data-field="feeFlat" value="' + escapeAttr(co.feeFlat || 0) + '" />' +
              '</label>' +
              '<label class="p86-co-field">' +
                '<span>Fee %</span>' +
                '<input type="number" step="0.1" data-field="feePct" value="' + escapeAttr(co.feePct || 0) + '" />' +
              '</label>' +
            '</div>' +
            '<div class="p86-co-field-row">' +
              '<label class="p86-co-field">' +
                '<span>Tax %</span>' +
                '<input type="number" step="0.01" data-field="taxPct" value="' + escapeAttr(co.taxPct || 0) + '" />' +
              '</label>' +
              '<label class="p86-co-field">' +
                '<span>Round to $</span>' +
                '<input type="number" step="1" data-field="roundTo" value="' + escapeAttr(co.roundTo || 0) + '" />' +
              '</label>' +
            '</div>' +
            // Legacy link chip — shown only for old COs still carrying a
            // node link. New COs allocate to buildings (CO→building), so no
            // chip appears; the retired "drop a CO node" guidance is gone.
            '<div class="p86-co-link-chip" id="p86CoLinkChip">' +
              (co.linked_node_id
                ? '<span class="p86-co-link-on">⛓ Linked (legacy)</span>'
                : '') +
            '</div>' +
          '</aside>' +
          // Line table
          '<section class="p86-co-lines">' +
            '<div class="p86-co-lines-toolbar">' +
              '<button class="ee-btn primary" data-co-add-line>+ Add Line</button>' +
              '<button class="ee-btn secondary" data-co-add-catalog title="Add materials from the catalog or explode a costed assembly into lines">+ Catalog / Assemblies</button>' +
              '<button class="ee-btn secondary" data-co-add-section>+ Section Header</button>' +
              '<button class="ee-btn ghost" data-co-preview title="Preview the customer-facing PDF">Preview PDF</button>' +
            '</div>' +
            '<div id="p86CoLineTable" class="p86-co-line-table"></div>' +
          '</section>' +
        '</div>' +
      '</div>'
    );
  }

  // ── Header wiring (title + close + status pill + side panel) ──
  function wireHeader(overlay) {
    var titleInput = overlay.querySelector('[data-field="title"]');
    if (titleInput) titleInput.addEventListener('input', function() {
      _state.co.title = titleInput.value;
      markDirty();
    });
    var closeBtn = overlay.querySelector('[data-co-close]');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Status pill — clicking opens the transition flow
    var pill = overlay.querySelector('#p86CoStatusPill');
    if (pill) pill.addEventListener('click', openStatusTransition);

    // Add line / add section / preview
    var addLine = overlay.querySelector('[data-co-add-line]');
    if (addLine) addLine.addEventListener('click', function() {
      if (!Array.isArray(_state.co.lines)) _state.co.lines = [];
      _state.co.lines.push({
        id: newLineId(),
        // unitSell seeds BLANK, never 0 — blank is "derive my price from
        // cost", 0 is "promised at $0". Same distinction markup: '' has
        // always carried, and the whole reason no existing record needed
        // rewriting. `unit` is finally seeded because it finally has a
        // column; it is never priced.
        qty: 1, unitCost: 0, unit: 'ea', unitSell: '',
        description: '', markup: '', markupMode: 'percent'
      });
      markDirty();
      paintLines();
      paintTotals();
    });
    var addSection = overlay.querySelector('[data-co-add-section]');
    if (addSection) addSection.addEventListener('click', function() {
      // Inline — add a blank section and focus its name field (no popup),
      // matching the estimate editor's flow.
      if (!Array.isArray(_state.co.lines)) _state.co.lines = [];
      var id = newLineId();
      _state.co.lines.push({
        id: id,
        section: '__section_header__',
        label: '',
        markup: '', markupMode: 'percent'
      });
      markDirty();
      paintLines();
      paintTotals();
      var row = document.querySelector('#p86CoLineTable tr[data-line-id="' + id + '"]');
      var nameInput = row && row.querySelector('[data-line-field="label"]');
      if (nameInput) { nameInput.focus(); }
    });
    var addCatalog = overlay.querySelector('[data-co-add-catalog]');
    if (addCatalog) addCatalog.addEventListener('click', openCatalogDrawer);
    var previewBtn = overlay.querySelector('[data-co-preview]');
    if (previewBtn) previewBtn.addEventListener('click', openCoCustomerDoc);
  }

  // ── Rich-text fields (Scope + Terms) ───────────────────────────
  // Mount the shared p86RichText editor onto each host; onChange writes the
  // sanitized HTML straight into the in-memory CO and debounce-saves. Falls
  // back to a plain textarea if the rich-text module didn't load.
  function mountCoRichField(overlay, sel, field, ph) {
    var host = overlay.querySelector(sel);
    if (!host) return;
    if (window.p86RichText && window.p86RichText.mount) {
      _state['rt_' + field] = window.p86RichText.mount(host, {
        value: _state.co[field] || '',
        placeholder: ph,
        minHeight: 110,
        compact: true,
        onChange: function (html) { if (_state.co) { _state.co[field] = html; markDirty(); } }
      });
    } else {
      var ta = document.createElement('textarea');
      ta.rows = 6; ta.placeholder = ph;
      ta.value = (window.p86RichText && window.p86RichText.toPlainText)
        ? window.p86RichText.toPlainText(_state.co[field] || '')
        : (_state.co[field] || '');
      host.appendChild(ta);
      ta.addEventListener('input', function () { if (_state.co) { _state.co[field] = ta.value; markDirty(); } });
    }
  }
  function wireRichFields(overlay) {
    mountCoRichField(overlay, '#p86CoScopeHost', 'scope',
      'Describe the work this change order covers. The customer sees this on the change order.');
    mountCoRichField(overlay, '#p86CoTermsHost', 'terms',
      'Terms the customer agrees to when they approve this change order.');
  }

  // ── Side-panel field wiring ────────────────────────────────────
  function wireSidePanel(overlay) {
    var fields = ['targetPrice', 'targetMargin', 'defaultMarkup', 'feeFlat', 'feePct', 'taxPct', 'roundTo'];
    fields.forEach(function(f) {
      var el = overlay.querySelector('[data-field="' + f + '"]');
      if (!el) return;
      el.addEventListener('input', function() {
        var v = el.value;
        // Numeric fields stay numeric in memory; empty strings stay
        // strings so the editor remembers "the user cleared this on
        // purpose" (vs. "this was never set").
        if (f === 'targetPrice') {
          // THE RAW STRING, DELIBERATELY. Number('34,000.00') is NaN and
          // Number('$34,000') is NaN, so coercing here would throw away
          // exactly the input a person is most likely to type. The pipeline
          // parses it as currency and refuses on screen if it cannot — and
          // it must see what was typed to say so.
          _state.co[f] = v;
        } else if (['targetMargin', 'defaultMarkup'].indexOf(f) !== -1) {
          _state.co[f] = v === '' ? '' : Number(v);
        } else if (['feeFlat', 'feePct', 'taxPct', 'roundTo'].indexOf(f) !== -1) {
          _state.co[f] = v === '' ? 0 : Number(v);
        } else {
          _state.co[f] = v;
        }
        markDirty();
        paintTotals();
        // Line Amounts move with a client price, so the table is stale the
        // moment this field changes. Target Margin never needed this because
        // it leaves the rows alone.
        if (f === 'targetPrice') paintLines();
      });
    });
  }

  // ── Line table ─────────────────────────────────────────────────
  // ── Assembly rollup rows (fused breakdown + reprice / explode) ──────
  // Mirrors the estimate editor: a CO line inserted from an assembly
  // carries sourceAssemblyId + assemblyBreakdown (leaf rows per 1 output
  // unit) + assemblyBucket. The strip below the row is a read-only
  // component view; the totals engine only ever sees the parent line.
  var _coAsmOpen = {};   // lineId → bool (persists across re-paints this session)
  var CO_BUCKET_LABEL = { materials: 'MATERIALS', labor: 'LABOR', gc: 'GENERAL CONDITIONS', sub: 'SUBCONTRACTORS' };
  function isCoAsmLine(l) {
    return !!(l && l.sourceAssemblyId != null && Array.isArray(l.assemblyBreakdown) && l.assemblyBreakdown.length);
  }
  function coAsmStripHTML(line) {
    var open = !!_coAsmOpen[line.id];
    var n = line.assemblyBreakdown.length;
    var head =
      '<div class="p86-co-asm-head" data-asm-toggle="' + escapeAttr(line.id) + '" style="display:flex;align-items:center;gap:7px;padding:3px 8px;font-size:10px;cursor:pointer;color:#7eb0ff;">' +
        '<span style="font-size:8px;transition:transform .12s;' + (open ? 'transform:rotate(90deg);' : '') + '">&#9654;</span>' +
        '<span style="font-weight:700;letter-spacing:.04em;">&#129513; ASSEMBLY' +
          (line.assemblyBucket ? ' &middot; ' + escapeHTML(CO_BUCKET_LABEL[line.assemblyBucket] || String(line.assemblyBucket).toUpperCase()) : '') + '</span>' +
        '<span style="color:var(--text-dim,#8a93a6);">' + n + ' component' + (n === 1 ? '' : 's') + ' inside this price — click to inspect</span>' +
      '</div>';
    if (!open) return head;
    var q = coNum(line.qty);
    var body = '';
    line.assemblyBreakdown.forEach(function (b) {
      var bq = Math.round(q * coNum(b.qty_per_unit) * 100) / 100;
      var uc = b.unit_cost != null ? coNum(b.unit_cost) : 0;
      body +=
        '<div style="display:flex;align-items:center;gap:8px;padding:2px 8px 2px 24px;font-size:10.5px;font-style:italic;color:var(--text-dim,#8a93a6);opacity:.9;">' +
          '<span style="color:#4f8cff;">&#8627;</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(b.description || '(item)') +
            '<span style="font-size:8px;font-style:normal;padding:1px 5px;border-radius:7px;margin-left:6px;background:' + (b.cost_code === 'labor' ? 'rgba(242,165,92,.13);color:#f2a55c' : 'rgba(79,209,197,.13);color:#4fd1c5') + ';">' + escapeHTML(b.cost_code || '') + '</span>' +
          '</span>' +
          '<span style="font-family:monospace;font-style:normal;">' + bq + ' ' + escapeHTML(b.unit || '') + '</span>' +
          '<span style="font-family:monospace;font-style:normal;width:82px;text-align:right;">@ $' + uc.toFixed(2) + '</span>' +
          '<span style="font-family:monospace;font-style:normal;width:82px;text-align:right;">$' + (bq * uc).toFixed(2) + '</span>' +
        '</div>';
    });
    var acts =
      '<div style="display:flex;flex-wrap:wrap;gap:16px;padding:4px 8px 6px 24px;font-size:10px;">' +
        '<span data-asm-refresh="' + escapeAttr(line.id) + '" style="color:#4f8cff;cursor:pointer;">&#10227; Reprice from recipe</span>' +
        '<span data-asm-explode="' + escapeAttr(line.id) + '" style="color:#4f8cff;cursor:pointer;">&#8675; Explode to editable lines</span>' +
        (line.sourceAssemblyId != null ? '<span data-asm-open="' + escapeAttr(line.sourceAssemblyId) + '" style="color:#4f8cff;cursor:pointer;">&#9998; Open assembly</span>' : '') +
      '</div>';
    return head + body + acts;
  }
  // Re-pull the recipe → new resolved unit cost + fresh component snapshot.
  function coAsmRefresh(lineId) {
    var line = (_state.co.lines || []).find(function (x) { return String(x.id) === String(lineId); });
    if (!line || line.sourceAssemblyId == null) return;
    if (line.assemblyParams) {
      alert('This line was quantified from typed dimensions (a parametric assembly), so its quantities come from formulas — per-unit repricing would be wrong.\n\nTo reprice, re-add it from Plans & Takeoffs with the same measurements.');
      return;
    }
    fetch('/api/assemblies/' + encodeURIComponent(line.sourceAssemblyId), { credentials: 'include' })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 404 ? 'That assembly no longer exists.' : 'Could not load recipe (' + r.status + ')'); return r.json(); })
      .then(function (det) {
        var flat = Array.isArray(det.flat) ? det.flat : [];
        if (line.assemblyBucket) {
          var rows = flat.filter(function (f) { return (f.cost_code || 'materials') === line.assemblyBucket; });
          line.unitCost = Math.round(rows.reduce(function (s, f) { return s + coNum(f.qty_per_unit) * coNum(f.unit_cost); }, 0) * 10000) / 10000;
          line.assemblyBreakdown = rows;
          if (!rows.length) alert('The recipe no longer has any ' + (CO_BUCKET_LABEL[line.assemblyBucket] || line.assemblyBucket).toLowerCase() + ' components — this line is now $0.');
        } else {
          line.unitCost = coNum(det.assembly && det.assembly.unit_cost);
          line.assemblyBreakdown = flat.length ? flat : line.assemblyBreakdown;
        }
        markDirty(); paintLines(); paintTotals();
      })
      .catch(function (e) { alert('Reprice failed: ' + (e.message || 'unknown')); });
  }
  // Convert the rollup line into raw editable lines (one per component,
  // routed to the matching cost-code section). One-way — replaces the rollup.
  function coAsmExplode(lineId) {
    var line = (_state.co.lines || []).find(function (x) { return String(x.id) === String(lineId); });
    if (!line || !Array.isArray(line.assemblyBreakdown)) return;
    // ONE LIST OF COMPONENTS, BUILT ONCE.
    // This map used to be written TWICE in this function — here for the
    // mutation, and again thirty lines below as the confirm dialog's own
    // `sim` array — and the two did not agree. The dialog's copy had no
    // `qty > 0` filter, so it kept components doIt() drops.
    var explodeSpecs = function (src) {
      var q = coNum(src.qty);
      return (src.assemblyBreakdown || []).map(function (b) {
        return {
          description: b.description,
          qty: Math.round(q * coNum(b.qty_per_unit) * 100) / 100,
          unit: b.unit || 'ea',
          unit_cost: b.unit_cost != null ? coNum(b.unit_cost) : 0,
          cost_code: b.cost_code || 'materials',
          source_material_id: b.material_id || undefined,
          source_assembly_id: src.sourceAssemblyId
        };
      }).filter(function (s) { return s.qty > 0; });
    };
    var doIt = function () {
      var specs = explodeSpecs(line);
      var idx = _state.co.lines.indexOf(line);
      if (idx >= 0) _state.co.lines.splice(idx, 1);
      delete _coAsmOpen[lineId];
      coApplyBulkAddLineItems(specs);
    };
    // THE SIMULATION RUNS THE REAL MUTATION, ON A CLONE.
    //
    // It used to be a second hand-written model of the post-explode array:
    // the components mapped straight to {qty, unitCost, markup:''} and
    // CONCATENATED AT THE END. The real explode does not do that. It routes
    // every component through coApplyAddLineItem, which finds-or-creates the
    // section header for its cost code and inserts the line INSIDE that
    // section — and section membership on a change order is positional, so
    // where a line lands decides which markup it takes.
    //
    // Measured against the shipped bytes, on ordinary records with no credit
    // lines and no zero-quantity components, the two models disagreed on
    // 44.87% of explode confirms — median $84.96, 90th percentile $754.78,
    // worst $9,702.03. With credits and zero-qty components in the mix it was
    // 53.55% and $46,852.79 at worst. That is a bigger and more common error
    // in this dialog than the round-to pause it was written alongside, and it
    // is the same disease: TWO MODELS OF ONE STATE, thirty lines apart.
    //
    // So there is one model. The clone is a JSON round trip — the same trip
    // this blob makes to the database — and _state.co is swapped for it only
    // for the duration, so coApplyAddLineItem writes into the clone exactly as
    // it would write into the record. Each spec goes through with _silent set,
    // which is what coApplyBulkAddLineItems does; the bulk wrapper itself is
    // NOT called, because its markDirty/paintLines/paintTotals would paint the
    // simulated state onto the screen and mark the record dirty.
    var simulateExplode = function () {
      var live = _state.co;
      var clone = JSON.parse(JSON.stringify(live));
      var target = (clone.lines || []).find(function (x) { return String(x.id) === String(lineId); });
      if (!target) return null;
      _state.co = clone;
      try {
        var specs = explodeSpecs(target);
        var i = clone.lines.indexOf(target);
        if (i >= 0) clone.lines.splice(i, 1);
        specs.forEach(function (s) {
          coApplyAddLineItem(Object.assign({ _silent: true }, s));
        });
        return clone;
      } finally { _state.co = live; }
    };
    // EXPLODING A PROMISED LINE MOVES THE CHANGE ORDER TOTAL, and the
    // human has to see the number before the click, not after it.
    //
    // The components are correctly born without a Unit Sell — spreading
    // one promise across every component would multiply it, which would
    // be far worse. But that means the promise is DROPPED: the line stops
    // being "we said $2,750" and goes back to cost x markup. On contract
    // money, a confirm dialog that lets a total move silently is not a
    // confirm dialog.
    var msg = 'Explode "' + (line.description || 'assembly') + '" into ' +
      line.assemblyBreakdown.length + ' editable lines? The single rollup line is replaced.';
    if (window.p86Pricing.sellLocked(line)) {
      var before = (computeTotals() || {}).total || 0;
      // Price the record as it would be AFTER, without touching it.
      var after = 0;
      try {
        // ONE OBJECT. `simRec` carries both the post-explode lines and the
        // fee/tax/round fields, `perSim` is the decision taken on those very
        // lines, and applyFeesAndTax is handed both. The third argument used
        // to be omitted, which sent the round-to pause back to a fresh walk of
        // the UN-exploded _state.co.lines: measured at +$250.00, +$266.00 and
        // +$654.33 on three fixtures, always exactly the round-up that should
        // have stood down and did not.
        var simRec = simulateExplode();
        var perSim = window.p86Pricing.computeForLines(simRec, simRec.lines);
        after = window.p86Pricing.applyFeesAndTax(
          window.p86Pricing.resolveMarkedUp(perSim, simRec), simRec, perSim).total;
      } catch (e) { after = null; }
      msg = 'This line has a promised sell price of ' + fmtCurrency(coNum(line.qty) * coNum(line.unitSell)) + '.\n\n' +
        'Exploding returns it to markup pricing and drops that promise' +
        (after == null ? '.' : ', moving the change order total from ' + fmtCurrency(before) + ' to ' + fmtCurrency(after) + '.') +
        '\n\n' + msg;
    }
    if (window.p86Confirm) {
      window.p86Confirm({ title: 'Explode assembly', message: msg, confirmText: 'Explode', destructive: true }).then(function (ok) { if (ok) doIt(); });
    } else if (confirm(msg)) doIt();
  }

  // ── Section money, for the header row's cost / amount / GM chip ────
  // Walks the array once and attributes every content line to the header
  // that encloses it. Positional, exactly as the pricing cascade is —
  // array order IS the section on a change order, which is also why the
  // catalog drawer splices a line INSIDE its section rather than at the
  // end. Lines before any header land under the null key and are not
  // shown anywhere; they simply have no section row to report on.
  function coSectionTotals(lines, rec) {
    var map = {};
    var currentId = null;
    // What each entry is WORTH. Normally cost × markup (or a promised
    // price); under a client price, its scaled share. One lookup, so the
    // section amounts, the row amounts and the totals bar cannot disagree
    // about a line the way five copies of gross margin used to.
    var alloc = coAllocation(lines, rec);
    lines.forEach(function (l, i) {
      if (l.section === '__section_header__') {
        currentId = l.id;
        if (!map[currentId]) map[currentId] = { cost: 0, sell: 0, locked: 0, lines: 0 };
        // A $-mode section's flat adder is part of what the section sells
        // for, so it belongs in the section's own amount and margin.
        if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
          map[currentId].sell += alloc ? alloc.sells[i] : coNum(l.markup);
        }
        return;
      }
      if (currentId == null) return;
      var mm = window.p86Pricing.lineMoney(l, lines, rec);
      map[currentId].cost += mm.ext;
      map[currentId].sell += alloc ? alloc.sells[i] : mm.sell;
      map[currentId].lines += 1;
      if (mm.locked) map[currentId].locked += 1;
    });
    return map;
  }

  // The client-price allocation for the record being painted, or null when
  // there is no client price in force — which is every change order that
  // exists today, and every one where the typed price was refused. Callers
  // read `alloc.sells[i]` BY STORED INDEX; see the remainder-walk warning in
  // js/pricing-pipeline.js and the standing rule in js/building-sort.js:39.
  function coAllocation(lines, rec) {
    if (!window.p86Pricing.clientPriceState) return null;
    var st = window.p86Pricing.clientPriceState(rec, lines);
    return (st && st.ok) ? st : null;
  }

  // The markup a locked line IMPLIES — what its promised price works out
  // to as a percentage over its cost. Display only; nothing prices from
  // it. Null when there is no cost to compare against, because "infinite
  // margin on $0 of cost" is a number that would only mislead.
  function coImpliedMarkup(line) {
    var cost = coNum(line.qty) * coNum(line.unitCost);
    if (!cost) return null;
    var sell = coNum(line.qty) * coNum(line.unitSell);
    return ((sell / cost) - 1) * 100;
  }

  // Has a placeholder cost been replaced by a real one? Asked of the value
  // the handler COMMITTED, never of the raw text the user typed, because
  // those two disagree exactly when it matters. A partial entry ("-",
  // "1.2.3") is rejected on commit and leaves the placeholder in place —
  // but Number('-') is NaN, and NaN !== anything, so testing the text
  // dropped the COST? badge for a line that still carried no cost at all.
  // Blank is not a cost either: blank stays blank, and a blank cell is
  // still a cost nobody has supplied.
  //
  // The comparison against Unit Sell is what "placeholder" MEANS here —
  // doc-import seeds unitCost = unitSell = the quoted price. A line whose
  // Unit Sell has since been cleared has no price left to mirror, so any
  // real number entered repairs it; reading that blank as Number('') === 0
  // used to mean such a line could never clear its flag by being costed at
  // zero.
  function costNowReal(line) {
    if (!line || !line.costPending) return false;
    var cost = line.unitCost;
    if (cost === '' || cost == null || isNaN(Number(cost))) return false;
    var sell = line.unitSell;
    if (sell === '' || sell == null) return true;
    return Number(cost) !== Number(sell);
  }

  function paintLines() {
    var host = document.getElementById('p86CoLineTable');
    if (!host) return;
    // No heal here, on purpose. Identity belongs to the _state.co accessor
    // (adoptCo), so it holds for readers that never paint — and the
    // `if (!host) return` two lines up can no longer skip it.
    var lines = Array.isArray(_state.co.lines) ? _state.co.lines : [];
    if (!lines.length) {
      host.innerHTML = '<div class="p86-co-lines-empty">' +
        'No line items yet. Click <strong>+ Add Line</strong> to add the first one, or <strong>+ Section Header</strong> to group lines by trade.' +
      '</div>';
      return;
    }
    // Column ORDER is the estimate editor's, deliberately: the two
    // surfaces price the same way now, so they should read the same way.
    //
    // Two of these have never been on a change order at all. UNIT is a
    // field the catalog drawer has always written and nothing displayed.
    // EXT. COST is qty x unitCost — the number that becomes the change
    // order's `costs` and lands in the job's Total Est. Costs. It being
    // invisible is precisely how a sell price pasted into Unit Cost stayed
    // invisible: cost and price were never on screen at the same time.
    var rec = _state.co;
    var targetOn = window.p86Pricing.targetMarginActive(rec);
    var alloc = coAllocation(lines, rec);
    var secTotals = coSectionTotals(lines, rec);
    var html = '<table class="p86-co-line-tbl"><thead>' +
      '<tr>' +
        '<th class="desc">Description</th>' +
        '<th class="qty">Qty</th>' +
        '<th class="uom">Unit</th>' +
        '<th class="unit">Unit Cost</th>' +
        '<th class="markup">Markup %</th>' +
        '<th class="sell">Unit Sell</th>' +
        '<th class="cost">Ext. Cost</th>' +
        '<th class="ext">Amount</th>' +
        '<th class="del"></th>' +
      '</tr></thead><tbody>';
    lines.forEach(function(l, lineIdx) {
      if (l.section === '__section_header__') {
        // Section header: name + optional $/% markup mode toggle + an
        // "override lines" checkbox (both drive the shared p86Pricing
        // engine, which already understands markupMode/overrideLineMarkups).
        var dollar = l.markupMode === 'dollar';
        // The section's own money. Its Ext. Cost column carried nothing at
        // all before — which meant a whole trade priced at zero margin
        // looked exactly like one priced at forty.
        var st = secTotals[l.id] || { cost: 0, sell: 0, locked: 0, lines: 0 };
        var stGm = window.p86Pricing.grossMarginPct(st.cost, st.sell);
        var gmChip = st.lines
          ? '<span class="p86-co-gm" style="display:inline-block;margin-left:8px;padding:1px 6px;border-radius:8px;font-size:9.5px;font-weight:700;' +
              (stGm == null || stGm <= 0 ? 'background:rgba(248,113,113,.15);color:#f87171;'
                         : stGm < 15 ? 'background:rgba(251,191,36,.15);color:#fbbf24;'
                                     : 'background:rgba(52,211,153,.13);color:#34d399;') +
              '" title="Gross margin on this section">GM ' + escapeHTML(fmtPct(stGm)) + '</span>'
          : '';
        html +=
          '<tr class="p86-co-section-row" data-line-id="' + escapeAttr(l.id) + '">' +
            '<td colspan="4">' +
              '<div style="display:flex;align-items:center;gap:12px;">' +
                '<input class="p86-co-section-label" type="text" data-line-field="label" value="' + escapeAttr(l.label || '') + '" placeholder="Section name" style="flex:1;min-width:0;" />' +
                '<label class="p86-co-sec-override" title="Ignore per-line markups — the section markup drives every line in it (a line with its own Unit Sell keeps its promised price)" style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:400;text-transform:none;letter-spacing:normal;color:var(--text-dim,#8a93a6);white-space:nowrap;cursor:pointer;">' +
                  '<input type="checkbox" data-line-field="overrideLineMarkups"' + (l.overrideLineMarkups ? ' checked' : '') + ' style="margin:0;" />override lines</label>' +
              '</div>' +
            '</td>' +
            '<td class="markup" style="white-space:nowrap;">' +
              '<button type="button" class="p86-co-sec-mode" data-sec-mode="' + escapeAttr(l.id) + '" title="Toggle percent markup / flat dollar add" style="min-width:24px;padding:2px 6px;font-size:11px;font-weight:700;border-radius:5px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.06);color:inherit;cursor:pointer;vertical-align:middle;">' + (dollar ? '$' : '%') + '</button> ' +
              '<input class="p86-co-section-markup" type="text" inputmode="decimal" data-line-field="markup" value="' + escapeAttr(l.markup == null ? '' : l.markup) + '" placeholder="' + (dollar ? 'Section $' : 'Section %') + '" />' +
            '</td>' +
            '<td class="sell"></td>' +
            '<td class="cost">' + (st.lines ? escapeHTML(fmtCurrency(st.cost)) : '') + '</td>' +
            '<td class="ext">' + (st.lines ? escapeHTML(fmtCurrency(st.sell)) + gmChip : '') + '</td>' +
            '<td class="del"><button type="button" class="p86-co-line-del" data-line-del title="Delete section">&times;</button></td>' +
          '</tr>';
      } else {
        // ONE rule for what a line is worth — the same function the totals
        // bar sums. This row used to hand-roll `ext * (1 + m/100)`, which
        // is fine until there are two ways a line can be priced.
        var mm = window.p86Pricing.lineMoney(l, lines, _state.co);
        var locked = mm.locked;
        // The markup a line would derive from if it were not locked — the
        // placeholder on an unlocked cell, and the "what this promise
        // works out to" readout on a locked one.
        var m = locked
          ? window.p86Pricing.effectiveMarkupForLine(l, lines, _state.co)
          : mm.markup;
        var ext = mm.ext;
        // Under a client price the Amount is the line's SCALED share, not
        // cost × markup. The markups still set the proportions between
        // lines; they no longer set the total, and the notice under the chip
        // bar says exactly that.
        var marked = alloc ? alloc.sells[lineIdx] : mm.sell;
        var asm = isCoAsmLine(l);

        // MARKUP % AND UNIT SELL ARE MUTUALLY EXCLUSIVE. Exactly one is
        // authoritative; the other shows its derivation as a PLACEHOLDER,
        // never as a value — so a cell is never both greyed and lying.
        //
        // A target margin already overrode every per-line markup, but the
        // markup cell stayed editable-looking and took keystrokes that
        // changed nothing. The estimate editor greys it. Now so does this.
        //
        // A CLIENT PRICE IS A PROMISE TOO, AND IT GREYS WHAT IT OVERRIDES.
        // This read `locked || targetOn` and knew nothing about a client
        // price, so under one the Markup % cell stayed live and editable
        // while the keystrokes it took no longer set the total — the exact
        // condition the paragraph above forbids. paintSidePanelState already
        // greys Target Margin and Round to under a client price; the row was
        // simply left out of the rule 1.19 established.
        var implied = locked ? coImpliedMarkup(l) : null;
        var priceOn = !!alloc;
        var markupDead = locked || targetOn || priceOn;
        var markupPh = locked
          ? (implied == null ? 'promised' : implied.toFixed(1) + '% implied')
          // A typed price outranks a target margin, so it is named first —
          // the placeholder has to say which rule actually priced the row.
          : (priceOn ? 'client price' : targetOn ? 'target margin' : m.toFixed(1));
        // The per-unit price this line WOULD carry, shown greyed in the
        // Unit Sell cell so the derived answer is always visible next to
        // the field that would override it. Taken from the shared rule and
        // divided back out — the priced amount is never re-derived here.
        // (A zero-qty line has nothing to divide by, so its placeholder is
        // the one place a percentage is applied for display.)
        // ⚠ FROM `marked`, NOT FROM `mm.sell`. `marked` is the amount this
        // row actually paints; mm.sell is the UNSCALED markup price. Under a
        // client price those differ by the allocation factor, so dividing the
        // unscaled one put a placeholder of $15,000.00 under a row priced at
        // $15,987.46 — a cell greyed by the promise above it and lying about
        // the number beside it, which is the pair this rule exists to forbid.
        var derivedSell = coNum(l.qty)
          ? marked / coNum(l.qty)
          : coNum(l.unitCost) * (1 + m / 100) * (alloc && !locked ? alloc.scale : 1);
        var pending = !!l.costPending;

        html +=
          '<tr class="p86-co-line-row' + (asm ? ' p86-co-asm-line' : '') + (locked ? ' p86-co-line-locked' : '') + '" data-line-id="' + escapeAttr(l.id) + '">' +
            '<td>' + (asm ? '<span title="From assembly" style="color:#7eb0ff;margin-right:3px;">&#129513;</span>' : '') +
              '<input type="text" data-line-field="description" value="' + escapeAttr(l.description || '') + '" placeholder="Line description"' + (asm ? ' style="width:calc(100% - 22px);"' : '') + ' />' +
              (pending ? '<span class="p86-co-pending" title="This line&#39;s cost is a placeholder equal to its price — type the real cost into Unit Cost." style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;background:rgba(251,191,36,.15);color:#fbbf24;white-space:nowrap;">COST?</span>' : '') +
            '</td>' +
            '<td><input type="text" inputmode="decimal" data-line-field="qty" value="' + escapeAttr(l.qty == null ? '' : l.qty) + '" /></td>' +
            '<td class="uom"><input type="text" data-line-field="unit" value="' + escapeAttr(l.unit == null ? '' : l.unit) + '" placeholder="ea" /></td>' +
            '<td><input type="text" inputmode="decimal" data-line-field="unitCost" value="' + escapeAttr(l.unitCost == null ? '' : l.unitCost) + '"' + (pending ? ' style="color:#fbbf24;"' : '') + ' /></td>' +
            '<td><input type="text" inputmode="decimal" data-line-field="markup" value="' + escapeAttr(l.markup == null ? '' : l.markup) + '" placeholder="' + escapeAttr(markupPh) + '"' +
              (markupDead ? ' readonly tabindex="-1" style="opacity:.45;cursor:not-allowed;" title="' +
                (locked ? 'This line has a promised Unit Sell, so its markup is implied rather than applied. Clear Unit Sell to price it by markup.'
                        : priceOn ? 'A Client Price is set on this change order. Per-line markups still set the proportions between lines; they no longer set the total.'
                        : 'A target margin is set on this change order, so per-line markups are ignored.') + '"' : '') + ' /></td>' +
            '<td class="sell"><input type="text" inputmode="decimal" data-line-field="unitSell" value="' + escapeAttr(l.unitSell == null ? '' : l.unitSell) + '" placeholder="' + escapeAttr(fmtCurrency(derivedSell).replace('$', '')) + '" title="The price promised to the owner. Leave blank to derive it from cost x markup." /></td>' +
            '<td class="cost">' + escapeHTML(fmtCurrency(ext)) + '</td>' +
            '<td class="ext">' + escapeHTML(fmtCurrency(marked)) + (locked ? '<span class="p86-co-lockdot" title="Promised price — not derived from cost" style="margin-left:5px;color:#7eb0ff;font-size:9px;">&#9679;</span>' : '') + '</td>' +
            '<td class="del"><button type="button" class="p86-co-line-del" data-line-del title="Delete line">&times;</button></td>' +
          '</tr>';
        if (asm) {
          html += '<tr class="p86-co-asm-strip-row" data-asm-strip-for="' + escapeAttr(l.id) + '">' +
            '<td colspan="9" style="padding:0;border-top:1px dashed rgba(79,140,255,.25);background:rgba(79,140,255,.05);">' + coAsmStripHTML(l) + '</td></tr>';
        }
      }
    });
    html += '</tbody></table>';
    host.innerHTML = html;

    // Wire each row's fields + delete. Line edits update surgically (no
    // table rebuild → focus/caret survive); section-header changes that
    // shift multiple child lines' markup re-render the table.
    host.querySelectorAll('tr[data-line-id]').forEach(function(tr) {
      var lineId = tr.getAttribute('data-line-id');
      var isHeaderRow = tr.classList.contains('p86-co-section-row');
      tr.querySelectorAll('[data-line-field]').forEach(function(input) {
        input.addEventListener('input', function() {
          var line = (_state.co.lines || []).find(function(x) { return String(x.id) === String(lineId); });
          if (!line) return;
          var f = input.getAttribute('data-line-field');
          if (input.type === 'checkbox') {
            line[f] = input.checked;
            markDirty(); paintLines(); paintTotals();   // affects every child line's markup
            return;
          }
          var v = input.value;
          if (['qty', 'unitCost', 'markup', 'unitSell'].indexOf(f) !== -1) {
            // inputmode=decimal text field: keep the prior value while a
            // partial entry ("1.", "-") is unparseable, BLANK STAYS BLANK.
            // That last part is load-bearing for unitSell: blank means "no
            // promise, price me from cost" and 0 means "promised at $0".
            // Writing 0 on the user's behalf would lock a line at free.
            var nv = Number(v);
            line[f] = v === '' ? '' : (isNaN(nv) ? line[f] : nv);
          } else {
            line[f] = v;
          }
          // A real cost typed over a placeholder is no longer pending.
          // costPending is DISPLAY ONLY — no pricing code reads it — so
          // clearing it is a display change and must not take an exit of
          // its own. This branch used to call paintLines() and return, and
          // that cost two things at once. The rebuild assigned over the
          // table's innerHTML, detaching the very input the caret sat in,
          // on the FIRST character. And the return jumped the markDirty()
          // below, so the keystroke never armed the autosave — a cost
          // PASTED in one input event (the actual repair workflow) was
          // never saved at all, while the save pill still read "Saved".
          // Typing only appeared to work because the second character no
          // longer matched this branch and fell through.
          //
          // Only two things on screen are pending-only, and paintLines is
          // the only thing that paints either: the COST? badge node in the
          // description cell, and the amber tint on this input. Drop both
          // in place — removing a sibling span and setting a style
          // property move no caret — then fall through to the surgical
          // tail, which arms the save and repaints this row. The notices
          // banner and its count come from paintTotals() there.
          if (f === 'unitCost' && costNowReal(line)) {
            delete line.costPending;
            var badge = tr.querySelector('.p86-co-pending');
            if (badge) badge.remove();
            input.style.color = '';
          }
          markDirty();
          // Section rows: refresh the section's own cost/amount/GM now.
          // Child rows still wait for the next full paint, as they always
          // have — rebuilding the table under a caret mid-keystroke is a
          // UX regression, and it is not this commit's to make.
          if (isHeaderRow) { paintSectionRows(); paintTotals(); }
          else { paintLineRow(tr); paintTotals(); }
        });
        // Decimal fields commit on 'input' but keep the prior value when the
        // text is unparseable. On blur, reconcile the field's display back to
        // the stored value so a malformed entry (e.g. "15.0.0") can't sit
        // there looking edited while the priced value silently stayed old.
        if (['qty', 'unitCost', 'markup', 'unitSell'].indexOf(input.getAttribute('data-line-field')) !== -1) {
          input.addEventListener('blur', function() {
            var line = (_state.co.lines || []).find(function(x) { return String(x.id) === String(lineId); });
            if (!line) return;
            var f = input.getAttribute('data-line-field');
            var stored = line[f];
            input.value = (stored === '' || stored == null) ? '' : String(stored);
          });
        }
      });
      var del = tr.querySelector('[data-line-del]');
      if (del) del.addEventListener('click', function() {
        _state.co.lines = (_state.co.lines || []).filter(function(x) { return String(x.id) !== String(lineId); });
        markDirty();
        paintLines();
        paintTotals();
      });
    });

    // Section $/% mode toggle.
    host.querySelectorAll('[data-sec-mode]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var line = (_state.co.lines || []).find(function(x) { return String(x.id) === String(btn.getAttribute('data-sec-mode')); });
        if (!line) return;
        line.markupMode = (line.markupMode === 'dollar') ? 'percent' : 'dollar';
        markDirty(); paintLines(); paintTotals();
      });
    });
    // Assembly rollup strip: toggle / reprice / explode / open.
    host.querySelectorAll('[data-asm-toggle]').forEach(function(el) {
      el.addEventListener('click', function() { var id = el.getAttribute('data-asm-toggle'); _coAsmOpen[id] = !_coAsmOpen[id]; paintLines(); });
    });
    host.querySelectorAll('[data-asm-refresh]').forEach(function(el) {
      el.addEventListener('click', function() { coAsmRefresh(el.getAttribute('data-asm-refresh')); });
    });
    host.querySelectorAll('[data-asm-explode]').forEach(function(el) {
      el.addEventListener('click', function() { coAsmExplode(el.getAttribute('data-asm-explode')); });
    });
    host.querySelectorAll('[data-asm-open]').forEach(function(el) {
      el.addEventListener('click', function() { var id = Number(el.getAttribute('data-asm-open')); if (window.p86Assemblies && window.p86Assemblies.openEditor) window.p86Assemblies.openEditor(id); });
    });
  }

  // Update ONE row's derived cells without rebuilding the table, so focus
  // and caret survive a keystroke. Three things move: Ext. Cost, Amount,
  // and whether the Markup cell is live — because typing into Unit Sell
  // takes the line out of the markup cascade the instant it has a value,
  // and a cell that has stopped mattering must stop looking editable.
  function paintLineRow(tr) {
    var lineId = tr.getAttribute('data-line-id');
    var lines = _state.co.lines || [];
    var line = lines.find(function(x) { return String(x.id) === String(lineId); });
    if (!line || line.section === '__section_header__') return;
    var mm = window.p86Pricing.lineMoney(line, lines, _state.co);
    // The same allocation the full paint uses, addressed by STORED INDEX.
    // The incremental repaint and the full repaint disagreeing about one
    // row is exactly the class of bug this editor has shipped before.
    var allocRow = coAllocation(lines, _state.co);
    var sellNow = allocRow ? allocRow.sells[lines.indexOf(line)] : mm.sell;
    var costCell = tr.querySelector('td.cost');
    if (costCell) costCell.textContent = fmtCurrency(mm.ext);
    var cell = tr.querySelector('td.ext');
    if (cell) {
      cell.innerHTML = escapeHTML(fmtCurrency(sellNow)) +
        (mm.locked ? '<span class="p86-co-lockdot" title="Promised price — not derived from cost" style="margin-left:5px;color:#7eb0ff;font-size:9px;">&#9679;</span>' : '');
    }
    tr.classList.toggle('p86-co-line-locked', mm.locked);
    var mk = tr.querySelector('[data-line-field="markup"]');
    if (mk && document.activeElement !== mk) {
      var targetOn = window.p86Pricing.targetMarginActive(_state.co);
      // Same three-way as the full paint. This copy knowing only two of the
      // rules is how the incremental repaint and the full repaint come to
      // disagree about one row — the class of bug the comment above names.
      var dead = mm.locked || targetOn || !!allocRow;
      mk.readOnly = dead;
      mk.style.opacity = dead ? '.45' : '';
      mk.style.cursor = dead ? 'not-allowed' : '';
      if (mm.locked) {
        var imp = coImpliedMarkup(line);
        mk.placeholder = (imp == null ? 'promised' : imp.toFixed(1) + '% implied');
      } else if (allocRow) {
        mk.placeholder = 'client price';
      } else if (targetOn) {
        mk.placeholder = 'target margin';
      } else {
        mk.placeholder = window.p86Pricing.effectiveMarkupForLine(line, lines, _state.co).toFixed(1);
      }
    }
    // The Unit Sell placeholder is the DERIVATION of the amount beside it,
    // so it moves whenever that amount moves. The full paint has always set
    // it from the priced amount; this repaint never touched it, so under a
    // client price a keystroke left the old unscaled figure sitting under a
    // freshly scaled row.
    var us = tr.querySelector('[data-line-field="unitSell"]');
    if (us && document.activeElement !== us) {
      var q = coNum(line.qty);
      var perUnit = q
        ? sellNow / q
        : coNum(line.unitCost)
          * (1 + window.p86Pricing.effectiveMarkupForLine(line, lines, _state.co) / 100)
          * (allocRow && !mm.locked ? allocRow.scale : 1);
      us.placeholder = fmtCurrency(perUnit).replace('$', '');
    }
    paintSectionRows();
  }

  // Section header rows carry their own cost / amount / GM chip now, so a
  // keystroke in any line has to move the section it sits in.
  function paintSectionRows() {
    var host = document.getElementById('p86CoLineTable');
    if (!host) return;
    var lines = _state.co.lines || [];
    var totals = coSectionTotals(lines, _state.co);
    host.querySelectorAll('tr.p86-co-section-row').forEach(function (tr) {
      var st = totals[tr.getAttribute('data-line-id')];
      if (!st) return;
      var costCell = tr.querySelector('td.cost');
      var extCell = tr.querySelector('td.ext');
      if (costCell) costCell.textContent = st.lines ? fmtCurrency(st.cost) : '';
      if (!extCell) return;
      if (!st.lines) { extCell.innerHTML = ''; return; }
      var gm = window.p86Pricing.grossMarginPct(st.cost, st.sell);
      extCell.innerHTML = escapeHTML(fmtCurrency(st.sell)) +
        '<span class="p86-co-gm" style="display:inline-block;margin-left:8px;padding:1px 6px;border-radius:8px;font-size:9.5px;font-weight:700;' +
          (gm == null || gm <= 0 ? 'background:rgba(248,113,113,.15);color:#f87171;'
                   : gm < 15 ? 'background:rgba(251,191,36,.15);color:#fbbf24;'
                             : 'background:rgba(52,211,153,.13);color:#34d399;') +
          '" title="Gross margin on this section">GM ' + escapeHTML(fmtPct(gm)) + '</span>';
    });
  }

  // ── Totals chip bar ────────────────────────────────────────────
  function paintTotals() {
    var host = document.getElementById('p86CoTotals');
    if (!host) return;
    var t = computeTotals();
    if (!t) { host.innerHTML = ''; return; }
    function chip(label, value, accent, note) {
      return '<div class="p86-co-chip' + (accent ? ' accent' : '') + '">' +
        '<div class="p86-co-chip-label">' + escapeHTML(label) + '</div>' +
        '<div class="p86-co-chip-value">' + escapeHTML(value) + '</div>' +
        (note
          ? '<div class="p86-co-chip-note" style="margin-top:3px;font-size:9px;font-weight:700;' +
            'letter-spacing:.3px;text-transform:uppercase;line-height:1.3;color:#7eb0ff;">' +
            escapeHTML(note) + '</div>'
          : '') +
      '</div>';
    }
    // A sell-locked change order's total is CORRECT when it does not move,
    // and there was nothing on screen that said so. A person typing a real
    // cost into a promised line watched six numbers move and the seventh —
    // the one they were looking at — hold, with no explanation anywhere but
    // a title attribute on a 9px dot.
    //
    // These notes are only written when the claim is true of the WHOLE
    // record. With every priced line locked, resolveMarkedUp reduces to the
    // promised sell, so Change Order Total and Tax + Fees are provably held
    // and Est. Cost, Profit and Margin provably track cost. In a MIXED change
    // order none of that is true line-for-line, so the Total chip says how
    // many lines are promised and the rest say nothing rather than something
    // false.
    var allLocked = t.lineCount > 0 && t.lockedCount === t.lineCount;
    var HELD = 'Held by the promised price';
    var TRACKS = 'Moves with cost';
    var cpOn = !!(t.clientPrice && t.clientPrice.ok);
    var totalNote = cpOn ? 'The client price you typed'
      : allLocked ? HELD
      : (t.lockedCount ? t.lockedCount + ' of ' + t.lineCount + ' lines priced by promise' : '');
    // "Subtotal" was the single most misleading word in this editor. That
    // chip IS the change order's cost — the number that flows into the
    // job's Total Est. Costs (Revised). Labelling contract cost "Subtotal"
    // is what let a $27,500 sell price sit there looking harmless.
    host.innerHTML =
      chip('Est. Cost', fmtCurrency(t.subtotal), false, allLocked ? TRACKS : '') +
      chip('Markup', fmtCurrency(t.markupAmount)) +
      chip('Tax + Fees', fmtCurrency(t.feeFlat + t.feePctAmount + t.taxAmount), false, allLocked ? HELD : '') +
      chip('Profit', fmtCurrency(t.profit), false, allLocked ? TRACKS : '') +
      chip('Change Order Total', fmtCurrency(t.total), true, totalNote) +
      chip('Margin', fmtPct(t.marginPct), false, allLocked ? TRACKS : '') +
      chip('Lines', String(t.lineCount));
    paintCoNotices(t);
    paintSidePanelState(t);
  }

  // Two things the totals bar cannot say in a chip.
  //
  // 1. A target margin is set — so every per-line markup on screen is
  //    ignored, and any line carrying a promised Unit Sell is carved OUT
  //    of the back-solve rather than restated by it. The estimate editor
  //    has said this for a long time; the CO editor said nothing and left
  //    markup cells looking live.
  // 2. Some line's cost is still a placeholder equal to its price. That
  //    change order reads as zero profit and overstates the job's cost by
  //    the difference, and the repair is one cell.
  // ── The client-price band ──────────────────────────────────────
  //
  // EVERY OUTCOME IS ON SCREEN, IN CURRENCY. A client price that lands says
  // what it did to the lines; one that cannot be honoured says WHY, names
  // the number that blocks it, and says what the change order is priced
  // from instead. A field that is silently ignored is the failure mode this
  // whole feature was written to end, so there is no path through here that
  // produces nothing.
  function coBand(tone, html) {
    var skin = tone === 'bad'
      ? 'background:rgba(248,113,113,.10);border-bottom:1px solid rgba(248,113,113,.28);color:#fca5a5;'
      : tone === 'warn'
      ? 'background:rgba(251,191,36,.08);border-bottom:1px solid rgba(251,191,36,.20);color:#fbbf24;'
      : 'background:rgba(79,140,255,.08);border-bottom:1px solid rgba(79,140,255,.18);color:#9ec1ff;';
    return '<div class="p86-co-notice p86-co-notice-clientprice" style="padding:7px 14px;font-size:11.5px;' + skin + '">' + html + '</div>';
  }
  // A REFUSAL MUST DESCRIBE THE FALLBACK IT ACTUALLY TOOK.
  //
  // This was a constant reading " …priced from its line markups until it
  // is." — and on a record that ALSO carries a Target Margin that sentence
  // is simply untrue: resolveMarkedUp falls through the client price to the
  // target-margin back-solve, not to the line markups. Measured on a
  // refused record with a 30% target margin, the band claimed $12,200.00
  // where the app had actually priced $12,876.92, and two bands then sat on
  // screen contradicting each other — "priced from its line markups" above
  // "the total is back-solved from cost" — while the number on the chip was
  // neither of the things being described.
  //
  // A refusal that misdescribes the fallback is the same defect as a
  // refusal that does not hold: both leave a number on screen that nothing
  // on screen explains. So this names the rule that actually priced the
  // document AND the total it produced, in currency, like every other
  // outcome in this file.
  function coFallbackTail(t) {
    var co = _state.co;
    var amount = ' — <strong>' + escapeHTML(fmtCurrency(t.total)) + '</strong>.';
    if (window.p86Pricing.targetMarginActive(co)) {
      return ' This change order is priced from its Target Margin of ' +
        escapeHTML(fmtPct(coNum(co.targetMargin))) + ' until it is' + amount;
    }
    return ' This change order is priced from its line markups until it is' + amount;
  }
  function coRoundPausedTail(cp) {
    if (!cp.roundToPaused) return '';
    return ' <strong>Round to ' + escapeHTML(fmtCurrency(cp.roundTo)) + ' is paused</strong> while a Client Price is in the field — a round-up is a ceiling, so it cannot land on an exact typed price.';
  }
  function coClientPriceNotice(t) {
    var cp = t && t.clientPrice;
    if (!cp) return '';
    var co = _state.co;
    if (cp.ok) {
      var body = '<strong>Client Price ' + escapeHTML(fmtCurrency(cp.target)) + '</strong> — ' +
        'every line that is not promised is priced at <strong>×' + escapeHTML(cp.scale.toFixed(6)) + '</strong> ' +
        'its markup price, so this change order lands on exactly that total. ' +
        'Per-line markups still set the proportions between lines; they no longer set the total. ' +
        'The cents settle in stored line order, so the same line carries them on every repaint.';
      if (cp.promisedCount) {
        body += ' <strong>' + cp.promisedCount + ' line' + (cp.promisedCount === 1 ? '' : 's') +
          ' with a promised Unit Sell ' + (cp.promisedCount === 1 ? 'is' : 'are') + ' carved out at ' +
          escapeHTML(fmtCurrency(cp.lockedSell)) + ' and ' + (cp.promisedCount === 1 ? 'is' : 'are') +
          ' not scaled</strong> — a promise is not something a document total may restate.';
      }
      if (window.p86Pricing.targetMarginActive(co)) {
        body += ' <strong>Target Margin ' + escapeHTML(fmtPct(coNum(co.targetMargin))) +
          ' is standing down</strong> — a Client Price and a Target Margin both set the same number, and the typed price is the more specific instruction.';
      }
      body += coRoundPausedTail(cp);
      var band = coBand('info', body);
      // A price that lands can still be a price that loses money. That is a
      // legitimate change order and it is not refused — but it is never left
      // to be inferred from a negative percentage.
      if (t.profit < 0) {
        band += coBand('warn',
          '<strong>This Client Price prices the work below its cost.</strong> ' +
          escapeHTML(fmtCurrency(cp.target)) + ' leaves ' + escapeHTML(fmtCurrency(t.markedUp)) +
          ' for work that costs ' + escapeHTML(fmtCurrency(t.subtotal)) + ' — a gross loss of ' +
          escapeHTML(fmtCurrency(-t.profit)) + '. Margin reads negative because it is.');
      }
      return band;
    }
    // ── refusals ────────────────────────────────────────────────
    var typed = co && co.targetPrice != null ? String(co.targetPrice) : '';
    var CP_FALLBACK = coFallbackTail(t);
    var msg;
    switch (cp.reason) {
      case 'unparseable':
        msg = '<strong>Client Price “' + escapeHTML(typed) + '” is not an amount this can read.</strong>' +
          CP_FALLBACK + ' Type it as a plain amount — 34000, 34,000.00 or $34,000.00.';
        break;
      case 'not-positive':
        msg = '<strong>A Client Price must be more than ' + escapeHTML(fmtCurrency(0)) + '.</strong>' +
          CP_FALLBACK;
        break;
      case 'below-floor':
        msg = '<strong>A Client Price of ' + escapeHTML(fmtCurrency(cp.target)) + ' is below this change order’s floor.</strong> ' +
          'The flat fee and the tax on it come to ' + escapeHTML(fmtCurrency(cp.floorTotal)) +
          ' before a dollar of work is priced, so every line would price below zero. ' +
          'Raise the Client Price above ' + escapeHTML(fmtCurrency(cp.floorTotal)) + ', or lower the Flat Fee.' +
          CP_FALLBACK;
        break;
      case 'unreachable':
        msg = '<strong>A Client Price of ' + escapeHTML(fmtCurrency(cp.target)) + ' cannot be produced from these fees and tax.</strong> ' +
          'Check Fee % and Tax %: at −100% every marked-up total collapses to the same number, and no price can be solved for.' +
          CP_FALLBACK;
        break;
      case 'promised-exceeds':
        msg = '<strong>The promised prices already come to more than a Client Price of ' + escapeHTML(fmtCurrency(cp.target)) + '.</strong> ' +
          cp.promisedCount + ' line' + (cp.promisedCount === 1 ? '' : 's') + ' with a promised Unit Sell total' + (cp.promisedCount === 1 ? 's ' : ' ') +
          escapeHTML(fmtCurrency(cp.lockedSell)) + ', and a promise is not something a document total may restate. ' +
          'Raise the Client Price above ' + escapeHTML(fmtCurrency(cp.lockedSell)) + ', or clear a line’s Unit Sell.' +
          CP_FALLBACK;
        break;
      case 'no-free-pool':
        if (!cp.lineCount) {
          msg = '<strong>This change order has no lines, so a Client Price has nothing to scale.</strong> Add a line first.';
        } else if (cp.promisedCount === cp.lineCount) {
          msg = '<strong>Every line’s price is already promised, so a Client Price has nothing to scale.</strong> ' +
            'A promise is not something a document total may restate. Clear a line’s Unit Sell to let it price from cost × markup.' +
            CP_FALLBACK;
        } else {
          msg = '<strong>The lines that are not promised have no price to scale.</strong> ' +
            cp.zeroPriceCount + ' of ' + cp.unpromisedCount + ' unpromised line' +
            (cp.unpromisedCount === 1 ? '' : 's') + ' price at ' + escapeHTML(fmtCurrency(0)) +
            ', and a line at $0 stays at $0 however the document is scaled — so ' +
            escapeHTML(fmtCurrency(cp.target)) + ' cannot be spread over them. ' +
            'Give them a Unit Cost, or promise a Unit Sell.' + CP_FALLBACK;
        }
        break;
      default:
        msg = '<strong>A Client Price of ' + escapeHTML(fmtCurrency(cp.target)) +
          ' could not be allocated to these lines without the rows disagreeing with the total.</strong>' + CP_FALLBACK;
    }
    return coBand('bad', msg + coRoundPausedTail(cp));
  }

  // Two controls that write the same number must not both look live, and a
  // paused control must say it is paused where it lives — not only in a band
  // twelve inches away.
  function paintSidePanelState(t) {
    var cp = t && t.clientPrice;
    var on = !!(cp && cp.ok);
    var tm = document.querySelector('#co-editor-overlay [data-field="targetMargin"]');
    if (tm) {
      tm.readOnly = on;
      tm.style.opacity = on ? '.45' : '';
      tm.style.cursor = on ? 'not-allowed' : '';
      tm.title = on ? 'Standing down — a Client Price is in force and sets this same total.' : '';
    }
    var rt = document.querySelector('#co-editor-overlay [data-field="roundTo"]');
    if (rt) {
      var paused = !!(cp && cp.roundToPaused);
      rt.readOnly = paused;
      rt.style.opacity = paused ? '.45' : '';
      rt.style.cursor = paused ? 'not-allowed' : '';
      rt.title = paused ? 'Paused — a round-up cannot land on an exact typed Client Price.' : '';
    }
  }

  function paintCoNotices(t) {
    var bar = document.getElementById('p86CoTotals');
    if (!bar) return;
    var host = document.getElementById('p86CoNotices');
    if (!host) {
      host = document.createElement('div');
      host.id = 'p86CoNotices';
      bar.parentNode.insertBefore(host, bar.nextSibling);
    }
    var out = '';
    out += coClientPriceNotice(t);
    if (window.p86Pricing.targetMarginActive(_state.co) && !(t.clientPrice && t.clientPrice.ok)) {
      out += '<div class="p86-co-notice" style="padding:7px 14px;font-size:11.5px;background:rgba(79,140,255,.08);border-bottom:1px solid rgba(79,140,255,.18);color:#9ec1ff;">' +
        '<strong>Target margin ' + escapeHTML(fmtPct(coNum(_state.co.targetMargin))) + '</strong> — per-line markups are ignored and the total is back-solved from cost.' +
        (t.lockedCount
          ? ' ' + t.lockedCount + ' line' + (t.lockedCount === 1 ? '' : 's') + ' with a promised Unit Sell ' +
            (t.lockedCount === 1 ? 'is' : 'are') + ' excluded from the back-solve — a promise is not derived from cost, so a margin target may not restate it.'
          : '') +
        '</div>';
    }
    // A PROMISED PRICE HOLDS THE TOTAL, AND SAYS SO.
    //
    // This is the notice that had to exist. The change order's total not
    // moving when a cost changes is the sell lock working — but the only
    // explanation that was ever on screen was the amber "needs a real cost"
    // banner below, and typing a real cost CLEARS costPending, so that banner
    // deleted itself at the exact moment a person started wondering why the
    // total was stuck. This one is keyed to the lock itself, so it is still
    // there afterwards.
    //
    // Deliberately not a tooltip: the question ("why did that not move?")
    // arrives while the caret is in a cell, and nobody hovers a 9px dot to
    // answer it.
    if (t.lockedCount) {
      var everyLine = t.lockedCount === t.lineCount;
      out += '<div class="p86-co-notice p86-co-notice-locked" style="padding:7px 14px;font-size:11.5px;background:rgba(79,140,255,.08);border-bottom:1px solid rgba(79,140,255,.18);color:#9ec1ff;">' +
        '<strong>' + (everyLine
          ? 'Every line’s price is promised.'
          : t.lockedCount + ' of ' + t.lineCount + ' lines carry a promised Unit Sell.') +
        '</strong> ' +
        'Typing a cost on ' + (everyLine ? 'a line' : 'one of those lines') +
        ' moves <strong>Est. Cost</strong>, <strong>Profit</strong> and <strong>Margin</strong> — ' +
        'the <strong>Change Order Total</strong> holds at the price quoted, because that price is ' +
        'the promise and cost is the only free variable. ' +
        (everyLine ? '' : (function () {
          var rest = t.lineCount - t.lockedCount;
          return 'The other ' + rest + (rest === 1 ? ' line still prices' : ' lines still price') +
            ' from cost × markup. ';
        })()) +
        'Promised lines show a blue Amount with a ● marker. Clear a line’s Unit Sell to ' +
        'price it from cost × markup instead.' +
        '</div>';
    }
    if (t.pendingCount) {
      out += '<div class="p86-co-notice" style="padding:7px 14px;font-size:11.5px;background:rgba(251,191,36,.08);border-bottom:1px solid rgba(251,191,36,.20);color:#fbbf24;">' +
        '<strong>' + t.pendingCount + ' line' + (t.pendingCount === 1 ? '' : 's') + ' need' + (t.pendingCount === 1 ? 's' : '') + ' a real cost.</strong> ' +
        'Their Unit Cost is a placeholder equal to the price quoted, so this change order reads as zero profit and the job\'s estimated cost carries the whole quote. Type the real cost into Unit Cost.' +
        '</div>';
    }
    host.innerHTML = out;
  }

  // ── Status pill ────────────────────────────────────────────────
  function paintStatusPill() {
    var pill = document.getElementById('p86CoStatusPill');
    if (!pill) return;
    var s = (_state.co && _state.co.status) || 'draft';
    pill.className = 'p86-co-status-pill status-' + s;
    var label = s === 'draft' ? 'Draft'
              : s === 'approved' ? 'Approved'
              : s === 'applied' ? 'Applied'
              : s;
    pill.innerHTML = '<span class="dot"></span>' + escapeHTML(label) + '<span class="caret">▾</span>';
    pill.title = s === 'applied'
      ? 'Applied — locked. WIP has consumed these costs.'
      : s === 'approved'
      ? 'Approved — locked / read-only. Move back to Draft (or unlock) to edit.'
      : 'Click to change status';
  }

  // Approved/applied COs are locked → read-only. Mirror of the estimate lock:
  // a .co-locked class disables inputs via CSS + a banner with an admin unlock.
  function applyCoLockState() {
    var host = document.querySelector('#co-editor-overlay .p86-co-host');
    if (!host) return;
    var locked = !!(_state.co && _state.co.is_locked);
    host.classList.toggle('co-locked', locked);
    var banner = document.getElementById('co-lock-banner');
    if (!locked) { if (banner) banner.remove(); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'co-lock-banner';
      banner.className = 'co-lock-banner';
      // Place under the topbar (CO #/title/status) so it reads clearly in the
      // editor body — inserting before the topbar tucks it at the clipped top edge.
      var topbar = host.querySelector('.p86-co-topbar');
      if (topbar && topbar.nextSibling) host.insertBefore(banner, topbar.nextSibling);
      else host.appendChild(banner);
    }
    banner.innerHTML =
      '<span><strong>🔒 Approved — locked.</strong> This change order is approved and read-only. ' +
      'Move it back to Draft via the status pill, or unlock it to make corrections.</span>' +
      '<button type="button" id="co-unlock-btn" class="ee-btn small">Unlock to edit</button>';
    var btn = document.getElementById('co-unlock-btn');
    if (btn) btn.onclick = unlockCo;
  }

  async function unlockCo() {
    var co = _state.co;
    if (!co || !window.p86Api.changeOrders.lock) return;
    if (!(await p86Ask('Unlock this approved change order for editing? It stays Approved but becomes editable until re-locked.'))) return;
    window.p86Api.changeOrders.lock(co.id, false).then(function () {
      _state.co.is_locked = false;
      applyCoLockState();
      paintSaveStatus();
    }).catch(function (e) { alert('Unlock failed: ' + (e && e.message || e)); });
  }

  function openStatusTransition() {
    var co = _state.co;
    if (!co) return;
    var current = co.status || 'draft';
    var allowed = {
      draft: ['approved'],
      approved: ['draft', 'applied'],
      applied: []
    }[current] || [];
    if (!allowed.length) {
      alert('Applied change orders cannot be re-transitioned.');
      return;
    }
    var prior = document.getElementById('p86CoStatusMenu');
    if (prior) prior.remove();
    var menu = document.createElement('div');
    menu.id = 'p86CoStatusMenu';
    menu.className = 'p86-co-status-menu';
    menu.innerHTML = allowed.map(function(next) {
      var msg = '';
      if (next === 'approved') msg = '<small>Applies the CO to the job and impacts WIP.</small>';
      else if (next === 'applied') msg = '<small>Marks the CO as consumed by the field. Locks edits.</small>';
      else if (next === 'draft') msg = '<small>Returns to editable state; re-approve to re-apply.</small>';
      var label = next === 'draft' ? 'Move back to Draft'
                : next === 'approved' ? 'Approve (signed by customer)'
                : 'Mark as Applied';
      return '<button data-next="' + next + '">' +
        '<strong>' + escapeHTML(label) + '</strong>' + msg +
      '</button>';
    }).join('');
    document.body.appendChild(menu);

    var pill = document.getElementById('p86CoStatusPill');
    if (pill) {
      var r = pill.getBoundingClientRect();
      menu.style.top = (r.bottom + window.scrollY + 4) + 'px';
      menu.style.left = Math.max(8, r.right - menu.offsetWidth + window.scrollX) + 'px';
    }
    function closeMenu() { menu.remove(); document.removeEventListener('click', onOutside, true); }
    function onOutside(e) { if (!menu.contains(e.target) && !(pill && pill.contains(e.target))) closeMenu(); }
    setTimeout(function() { document.addEventListener('click', onOutside, true); }, 0);

    menu.querySelectorAll('[data-next]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        closeMenu();
        var next = btn.getAttribute('data-next');
        applyStatusChange(next);
      });
    });
  }

  function applyStatusChange(next) {
    var co = _state.co;
    if (!co || !next) return;
    // Flush any pending data save first so the server applies the
    // status to the freshest record, not the previous version.
    if (_state.saveTimer) { clearTimeout(_state.saveTimer); _state.saveTimer = null; }
    var pending = _state.dirty ? flushSaveSync() : Promise.resolve();
    pending.then(function() {
      return window.p86Api.changeOrders.setStatus(co.id, next);
    }).then(function(r) {
      var fresh = r && r.change_order;
      if (fresh) {
        Object.assign(_state.co, fresh);
      }
      paintStatusPill();
      applyCoLockState();
      paintSaveStatus();
      // Approving a CO moves contract income, so the shared store has to be
      // patched before anything repaints from it. A bare p86JobsHubRefresh()
      // repainted the hub off an appData.jobChangeOrders nothing had updated,
      // which left the jobs-list Total Income tile on the pre-approval number
      // until a page reload. One call covers store + hub + jobs list + tabs.
      if (window.p86Refresh) window.p86Refresh('co', { id: co.id, jobId: co.job_id });
    }).catch(function(e) {
      alert('Status change failed: ' + (e.message || e));
    });
  }
  // Synchronous wrapper for the debounced save — flushSave is async
  // internally but the only place that needs to wait for it (status
  // transition) returns the promise directly.
  function flushSaveSync() {
    var co = _state.co;
    if (!co) return Promise.resolve();
    var data = coSavePayload(co);
    _state.saving = true;
    _state.saveError = null;
    paintSaveStatus();
    return window.p86Api.changeOrders.update(co.id, data).then(function(r) {
      var fresh = r && r.change_order;
      if (fresh) {
        _state.co.updated_at = fresh.updated_at;
        _state.co.status = fresh.status;
      }
      _state.dirty = false;
      _state.saving = false;
      _state.lastSavedAt = new Date();
      paintSaveStatus();
    });
  }

  // ── Save-status indicator ──────────────────────────────────────
  function paintSaveStatus() {
    var el = document.getElementById('p86CoSaveStatus');
    if (!el) return;
    if (_state.saveError) {
      el.className = 'p86-co-save-status error';
      el.textContent = '⚠ ' + _state.saveError;
      return;
    }
    if (_state.saving) {
      el.className = 'p86-co-save-status saving';
      el.textContent = 'Saving…';
      return;
    }
    if (_state.dirty) {
      el.className = 'p86-co-save-status dirty';
      el.textContent = 'Unsaved changes';
      return;
    }
    el.className = 'p86-co-save-status saved';
    el.textContent = _state.lastSavedAt ? '✓ Saved' : '';
  }

  // ──────────────────────────────────────────────────────────────────
  // Public surface
  // ──────────────────────────────────────────────────────────────────
  window.p86ChangeOrders = {
    openNew: openNew,
    open: openExisting,
    close: close
  };

  // Node-only test seam. Same dual-target shape js/co-draw.js,
  // js/building-sort.js and js/job-costs-import.js already use, and for
  // the same reason: the line table is where cost and price finally sit
  // side by side, so what it renders is worth asserting against a real
  // DOM rather than a regex over this file. Never reached in the browser
  // — there is no `module` there — and it exposes nothing the editor does
  // not already do to itself.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      __test: {
        // setCo is the REAL door — the same assignment openNew() and
        // openExisting() make, accessor and all. A harness therefore
        // CANNOT build an _state the editor could not hold, which is
        // precisely the drift that let an id-less fixture ship as "proven".
        setCo: function (co) { _state.co = co; },
        // setRawCo is the deliberate BYPASS, and the only way left to
        // observe the unhealed shape. Tests that assert what the heal DOES
        // need it. Nothing else may use it.
        setRawCo: function (co) { _stateCo = co; },
        getCo: function () { return _state.co; },
        paintLines: paintLines,
        paintTotals: paintTotals,
        computeTotals: computeTotals,
        coSectionTotals: coSectionTotals,
        coImpliedMarkup: coImpliedMarkup,
        newLineId: newLineId,
        ensureLineIds: ensureLineIds,
        adoptCo: adoptCo,
        coSavePayload: coSavePayload,
      },
    };
  }
})();
