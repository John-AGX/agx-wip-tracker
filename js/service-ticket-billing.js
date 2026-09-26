// Billing a work order — the office side (Phase 4).
//
// The panel below the time-and-materials card on an open work order. Where
// that card is about WHAT WAS DONE, this one is about what it is worth, and
// it is the only screen in the app where a work order's money appears. The
// crew link never sees any of it: the server's publicLine projects a crew
// answer by inclusion and none of these keys is on that list.
//
// The four decisions it renders (John, 2026-09-26):
//
//   ONE RATE for the whole ticket, offered from the market and then STAMPED.
//   The panel shows what the market has on offer next to what this ticket is
//   actually using, so a rate somebody set in August is visibly not the rate
//   the market moved to in September — rather than silently re-pricing.
//
//   A MATERIAL'S COST is typed. When the catalogue knows the description it
//   offers the price as a chip you press; it never fills the box for you,
//   and the receipt photos sit on the same row so the number can be checked
//   against the piece of paper it came from.
//
//   MARKUP IS PER LINE, with a ticket-wide default behind it. A line showing
//   the default says so in grey; type over it and it goes solid, because
//   "inherited 15" and "someone chose 15" are different facts.
//
//   OVER CONTRACT IS REFUSED. On a contract ticket the amount box will not
//   accept more than the contract price, and the panel says what the road
//   past it is — a change order — instead of offering a tick-box.
//
// EVERY WRITE ANSWERS THE WHOLE SHEET, so this never recomputes money in the
// browser: the totals on screen are the server's, from the same functions
// the bill itself is built with. The only arithmetic here is formatting.
(function () {
  'use strict';

  var BLOCKER_TONE = {
    already_billed: 'done', written_off: 'done',
    not_approved: 'wait', waiting: 'wait',
    no_rate: 'todo', no_cost: 'todo', nothing: 'todo', no_contract: 'todo',
    archived: 'no', cancelled: 'no', no_parent: 'no', not_billable: 'no'
  };
  var DEST_WORD = {
    change_order: { verb: 'Raise draft change order', what: 'a draft change order on this job' },
    invoice: { verb: 'Raise draft invoice', what: 'a draft invoice' }
  };
  // Half-typed boxes, per ticket, so a repaint from another module does not
  // eat a rate somebody is in the middle of typing.
  var _typed = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api() {
    return (window.p86Api && window.p86Api.serviceTickets) || null;
  }

  function toast(msg, kind) {
    if (typeof window.p86Toast === 'function') {
      try { window.p86Toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (kind === 'error' && typeof console !== 'undefined') console.error('[billing] ' + msg);
  }

  // Money, always to the cent. A blank is a blank, never $0.00 — the whole
  // point of an un-costed line is that nobody has said what it costs.
  function money(v) {
    if (v == null || v === '') return '';
    var n = Number(v);
    if (!isFinite(n)) return '';
    return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function qty(v) {
    if (v == null || v === '') return '';
    var n = Number(v);
    if (!isFinite(n)) return '';
    return String(Math.round(n * 100) / 100);
  }

  function pct(v) {
    if (v == null || v === '') return '';
    var n = Number(v);
    return isFinite(n) ? String(Math.round(n * 1000) / 1000) : '';
  }

  function typedFor(ticketId) {
    if (!_typed[ticketId]) _typed[ticketId] = {};
    return _typed[ticketId];
  }

  // ── the head: what state this ticket's money is in ──────────────────────
  function billedHTML(b) {
    if (!b) return '';
    if (b.kind === 'written_off') {
      return '<div class="p86-bl-state is-off"><strong>Written off.</strong> ' +
        esc(b.reason || '') + '</div>';
    }
    var what = b.kind === 'change_order' ? 'change order' : 'invoice';
    return '<div class="p86-bl-state is-done"><strong>Billed.</strong> This work order became a draft ' +
      what + (b.number ? ' — <span class="p86-bl-num">' + esc(b.number) + '</span>' : '') +
      '. <button type="button" class="p86-bl-open" data-open="' + esc(b.kind) + '" data-id="' +
      esc(b.id || '') + '">Open it</button></div>';
  }

  function rateHTML(s, canEdit) {
    var r = s.rate || {};
    var offer = r.market_default;
    var stale = offer != null && r.value != null && Number(offer) !== Number(r.value);
    return '<div class="p86-bl-row p86-bl-rate">' +
      '<label><span>Labour rate</span>' +
        '<span class="p86-bl-money-in">' +
          '<i>$</i><input type="number" step="0.01" min="0" class="p86-bl-in" data-f="labor_rate" ' +
            'value="' + esc(r.value == null ? '' : r.value) + '"' + (canEdit ? '' : ' disabled') + ' />' +
          '<em>/hr</em>' +
        '</span>' +
      '</label>' +
      '<label><span>Markup behind every line</span>' +
        '<span class="p86-bl-money-in">' +
          '<input type="number" step="0.001" min="0" class="p86-bl-in" data-f="default_markup_pct" ' +
            'value="' + esc(s.default_markup_pct == null ? '' : s.default_markup_pct) + '"' +
            (canEdit ? '' : ' disabled') + ' /><em>%</em>' +
        '</span>' +
      '</label>' +
      (offer == null ? '' :
        '<div class="p86-bl-offer">' +
          (r.value == null
            ? 'This market bills at ' + money(offer) + '/hr.'
            : (stale ? 'This market now bills at ' + money(offer) + '/hr; this work order is using ' +
                       money(r.value) + '.'
                     : 'From the market default.')) +
          (canEdit && (r.value == null || stale)
            ? ' <button type="button" class="p86-bl-usemarket">Use ' + money(offer) + '</button>'
            : '') +
        '</div>') +
      '</div>';
  }

  // ── one priced line ─────────────────────────────────────────────────────
  function lineHTML(l, s, canEdit) {
    var isLabour = l.kind === 'labor';
    var isContract = l.kind === 'contract';
    var inherited = l.markup_pct == null && !isContract;
    var cells = [];

    cells.push('<td class="p86-bl-desc">' +
      (isContract ? '' : '<span class="p86-bl-kind">' + (isLabour ? 'Labour' : 'Material') + '</span> ') +
      esc(l.description || '') +
      (l.work_date ? '<span class="p86-bl-when">' + esc(l.work_date) + '</span>' : '') +
      (l.task_title ? '<span class="p86-bl-where">' + esc(l.task_title) + '</span>' : '') +
      '</td>');

    cells.push('<td class="p86-bl-qty">' + esc(qty(l.qty)) +
      (l.unit ? ' <em>' + esc(l.unit) + '</em>' : '') + '</td>');

    // Labour's unit cost IS the ticket's rate and is not editable here —
    // there is one rate, and it is set once above.
    if (isLabour || isContract) {
      cells.push('<td class="p86-bl-cost is-fixed">' + esc(money(l.unit_cost)) + '</td>');
    } else {
      cells.push('<td class="p86-bl-cost">' +
        '<span class="p86-bl-money-in"><i>$</i>' +
          '<input type="number" step="0.01" min="0" class="p86-bl-lin" data-f="unit_cost" ' +
            'data-kind="material" data-line="' + esc(l.id) + '" ' +
            'value="' + esc(l.unit_cost == null ? '' : l.unit_cost) + '"' +
            (canEdit ? '' : ' disabled') + ' /></span>' +
        (l.catalog && l.unit_cost == null && canEdit
          ? '<button type="button" class="p86-bl-cat" data-line="' + esc(l.id) + '" ' +
            'data-cost="' + esc(l.catalog.unit_cost) + '" ' +
            'title="Last bought at this price. Check it against the receipt.">' +
            'Bought at ' + money(l.catalog.unit_cost) + '</button>'
          : '') +
        (l.receipts ? '<button type="button" class="p86-bl-shot" data-line="' + esc(l.id) + '">' +
            l.receipts + ' receipt' + (l.receipts === 1 ? '' : 's') + '</button>' : '') +
        '</td>');
    }

    if (isContract) {
      cells.push('<td class="p86-bl-markup is-fixed">—</td>');
    } else {
      cells.push('<td class="p86-bl-markup' + (inherited ? ' is-inherited' : '') + '">' +
        '<span class="p86-bl-money-in">' +
          '<input type="number" step="0.001" min="0" class="p86-bl-lin" data-f="markup_pct" ' +
            'data-kind="' + (isLabour ? 'labor' : 'material') + '" data-line="' + esc(l.id) + '" ' +
            'value="' + esc(l.markup_pct == null ? '' : l.markup_pct) + '" ' +
            'placeholder="' + esc(pct(l.effective_markup_pct)) + '"' +
            (canEdit ? '' : ' disabled') + ' /><em>%</em>' +
        '</span></td>');
    }

    cells.push('<td class="p86-bl-total">' +
      (l.ready ? esc(money(l.total)) : '<span class="p86-bl-missing">needs a cost</span>') + '</td>');

    return '<tr class="p86-bl-line" data-kind="' + esc(l.kind) + '" data-line="' + esc(l.id) + '">' +
      cells.join('') + '</tr>';
  }

  function gridHTML(s, canEdit) {
    if (!s.lines.length) {
      return '<p class="p86-bl-empty">Nothing accepted to bill yet.</p>';
    }
    return '<table class="p86-bl-grid"><thead><tr>' +
      '<th>What</th><th class="p86-bl-qty">Qty</th><th>Cost</th><th>Markup</th><th class="p86-bl-total">Price</th>' +
      '</tr></thead><tbody>' +
      s.lines.map(function (l) { return lineHTML(l, s, canEdit); }).join('') +
      '</tbody><tfoot><tr>' +
        '<td colspan="2">Totals</td>' +
        '<td class="p86-bl-cost">' + esc(money(s.totals.cost)) + '</td>' +
        '<td class="p86-bl-markup">' + esc(money(s.totals.markup)) + '</td>' +
        '<td class="p86-bl-total">' + esc(money(s.totals.price)) + '</td>' +
      '</tr></tfoot></table>';
  }

  function contractHTML(s, canEdit) {
    if (!s.contract) return '';
    var t = typedFor('x');
    return '<div class="p86-bl-contract">' +
      '<div>Contract price <strong>' + esc(money(s.contract.amount)) + '</strong></div>' +
      '<label><span>Bill this much</span>' +
        '<span class="p86-bl-money-in"><i>$</i>' +
          '<input type="number" step="0.01" min="0" max="' + esc(s.contract.amount) + '" ' +
            'class="p86-bl-in" data-f="amount" value="' + esc(s.contract.amount) + '"' +
            (canEdit ? '' : ' disabled') + ' /></span>' +
      '</label>' +
      '<p class="p86-bl-cap">A contract price is the price. Anything above ' +
        esc(money(s.contract.amount)) + ' is extra work, and extra work is a change order.</p>' +
      '</div>';
  }

  function blockersHTML(s) {
    if (!s.blockers.length) return '';
    return '<ul class="p86-bl-blockers">' + s.blockers.map(function (b) {
      return '<li class="is-' + esc(BLOCKER_TONE[b.code] || 'todo') + '">' + esc(b.message) + '</li>';
    }).join('') + '</ul>';
  }

  function actionsHTML(s, canEdit) {
    if (!canEdit || s.billed) return '';
    var dest = s.destination ? DEST_WORD[s.destination.kind] : null;
    var ready = !s.blockers.length && !!dest;
    return '<div class="p86-bl-actions">' +
      '<button type="button" class="p86-bl-writeoff">Write off…</button>' +
      '<button type="button" class="primary p86-bl-bill"' + (ready ? '' : ' disabled') + '>' +
        esc(dest ? dest.verb : 'Bill') + '</button>' +
      (ready ? '<span class="p86-bl-note">Makes ' + esc(dest.what) +
        '. Nothing is sent.</span>' : '') +
      '</div>';
  }

  function panelHTML(s, t, ctx) {
    if (!s || !s.enabled) return '';
    var canEdit = !!(ctx && ctx.canEdit);
    return '<div class="p86-bl" data-ticket="' + esc(t.id) + '">' +
      '<div class="p86-bl-head"><h4>Billing</h4>' +
        (s.waiting ? '<span class="p86-bl-wait">' + s.waiting + ' still waiting on you</span>' : '') +
      '</div>' +
      billedHTML(s.billed) +
      // The rate and the ticket-wide markup belong to a work order billed
      // FROM THE FIELD. A contract ticket has no labour lines and nothing to
      // mark up — its price was agreed before anyone went out — so a rate box
      // there is a control that changes nothing.
      (s.billed || s.bill_as !== 'time_materials' ? '' : rateHTML(s, canEdit)) +
      gridHTML(s, canEdit) +
      contractHTML(s, canEdit) +
      blockersHTML(s) +
      actionsHTML(s, canEdit) +
      '</div>';
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  function wire(node, ctx) {
    var t = (ctx && ctx.t) || {};
    var tid = String(t.id);
    var st = api();
    var panel = node && node.querySelector
      ? (node.classList && node.classList.contains('p86-bl') ? node : node.querySelector('.p86-bl'))
      : null;
    if (!panel || !st) return;
    var repaint = function () { return ctx && typeof ctx.refresh === 'function' ? ctx.refresh() : undefined; };
    var busy = false;

    function run(p, ok) {
      if (busy) return undefined;
      busy = true;
      return p.then(function (res) {
        busy = false;
        if (ok) ok(res);
        return repaint();
      }, function (e) {
        busy = false;
        toast((e && e.message) || 'That did not save.', 'error');
        return repaint();
      });
    }

    // Half-typed boxes survive a repaint from another module.
    Array.prototype.forEach.call(panel.querySelectorAll('.p86-bl-in, .p86-bl-lin'), function (el) {
      el.addEventListener('input', function () {
        typedFor(tid)[(el.getAttribute('data-line') || '') + ':' + el.getAttribute('data-f')] = el.value;
      });
    });

    // A box commits when it loses focus or on Enter — not on every keystroke,
    // which would fire a write per digit and repaint under the cursor.
    Array.prototype.forEach.call(panel.querySelectorAll('.p86-bl-in[data-f="labor_rate"], .p86-bl-in[data-f="default_markup_pct"]'), function (el) {
      var commit = function () {
        var body = {};
        body[el.getAttribute('data-f')] = el.value === '' ? null : el.value;
        run(st.setBilling(tid, body));
      };
      el.addEventListener('change', commit);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    });

    Array.prototype.forEach.call(panel.querySelectorAll('.p86-bl-lin'), function (el) {
      var commit = function () {
        var body = {};
        body[el.getAttribute('data-f')] = el.value === '' ? null : el.value;
        run(st.setBillingLine(tid, el.getAttribute('data-kind'), el.getAttribute('data-line'), body));
      };
      el.addEventListener('change', commit);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    });

    panel.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || !panel.contains(b) || b.disabled) return undefined;

      if (b.classList.contains('p86-bl-usemarket')) {
        return run(st.setBilling(tid, { use_market_rate: true }));
      }

      // The catalogue's price is PRESSED, never pre-filled. cost_source
      // records that it came from the catalogue rather than a receipt.
      if (b.classList.contains('p86-bl-cat')) {
        return run(st.setBillingLine(tid, 'material', b.getAttribute('data-line'),
          { unit_cost: b.getAttribute('data-cost'), cost_source: 'catalog' }));
      }

      if (b.classList.contains('p86-bl-shot')) {
        var line = (ctx.r && ctx.r.field_log && ctx.r.field_log.materials || [])
          .filter(function (m) { return String(m.id) === b.getAttribute('data-line'); })[0];
        var shots = (line && Array.isArray(line.receipts)) ? line.receipts : [];
        var viewer = window.p86Attachments;
        if (shots.length && viewer && typeof viewer.openLightbox === 'function') {
          viewer.openLightbox(shots, 0, { parentLabel: 'Receipt · ' + ((line && line.description) || '') });
        }
        return undefined;
      }

      if (b.classList.contains('p86-bl-open')) {
        var where = b.getAttribute('data-open') === 'change_order'
          ? '#/jobs/' + encodeURIComponent(t.job_id || '') + '/change-orders/' + encodeURIComponent(b.getAttribute('data-id'))
          : '#/invoices/' + encodeURIComponent(b.getAttribute('data-id'));
        window.location.hash = where;
        return undefined;
      }

      if (b.classList.contains('p86-bl-writeoff')) {
        return askWriteOff().then(function (reason) {
          if (!reason) return undefined;
          return run(st.writeOffBilling(tid, reason));
        });
      }

      if (b.classList.contains('p86-bl-bill')) {
        var amountEl = panel.querySelector('.p86-bl-in[data-f="amount"]');
        var body = amountEl ? { amount: amountEl.value } : {};
        return confirmBill(panel, amountEl).then(function (go) {
          if (!go) return undefined;
          return run(st.bill(tid, body), function (res) {
            var n = res && res.billed && res.billed.number;
            toast(n ? 'Draft ' + n + ' is ready to read.' : 'The draft is ready to read.', 'success');
          });
        });
      }
      return undefined;
    });
  }

  // Raising a document is worth one question, and the question names the
  // total — the number is the thing somebody should be checking.
  function confirmBill(panel, amountEl) {
    var total = amountEl
      ? amountEl.value
      : (panel.querySelector('.p86-bl-grid tfoot .p86-bl-total') || {}).textContent;
    var shown = amountEl ? money(amountEl.value) : String(total || '').trim();
    var ask = window.p86Confirm;
    var text = 'Raise the draft for ' + shown + '? It is a draft — nothing is sent.';
    if (typeof ask === 'function') return Promise.resolve(ask(text)).then(function (v) { return !!v; });
    return Promise.resolve(window.confirm(text));
  }

  function askWriteOff() {
    var ask = window.p86Prompt;
    var text = 'Why is this work order not being charged?';
    if (typeof ask === 'function') {
      return Promise.resolve(ask(text)).then(function (v) { return v && String(v).trim(); });
    }
    var v = window.prompt(text);
    return Promise.resolve(v && String(v).trim());
  }

  // ── the timeline's words for what this panel does ───────────────────────
  function eventWhat(event) {
    var e = event || {};
    var d = e.detail || {};
    if (e.kind === 'billed') {
      var what = d.destination === 'change_order' ? 'change order' : 'invoice';
      return 'Billed — draft ' + what + (d.document_number ? ' ' + d.document_number : '') +
        (d.price != null ? ', ' + money(d.price) : '');
    }
    if (e.kind === 'written_off') {
      return 'Written off' + (d.reason ? ' — ' + d.reason : '');
    }
    return null;
  }

  var extension = {
    order: 40,
    detailSections: function (ctx) {
      var c = ctx || {};
      var r = c.r || {};
      if (!r.billing || !r.billing.enabled) return [];
      return [{
        key: 'billing',
        slot: 'afterSite',
        html: panelHTML(r.billing, c.t || {}, c),
        wire: function (node, live) { wire(node, live || c); }
      }];
    },
    eventWhat: function (event) {
      var text = eventWhat(event);
      return text == null ? null : esc(text);
    }
  };

  window.p86TicketBilling = { panelHTML: panelHTML, eventWhat: eventWhat, money: money, extension: extension };

  function registerWithTicketScreen() {
    if (!window.p86StExt || typeof window.p86StExt.register !== 'function') return false;
    return window.p86StExt.register('billing', extension);
  }
  if (!registerWithTicketScreen() && typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerWithTicketScreen);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = window.p86TicketBilling;
})();
