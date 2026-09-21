// Shared "What is this becoming?" screen — the three-way convert.
//
// A won lead turns into ONE of three records, and until this shipped the only
// door was Create Job. So a two-day service call somebody sold had to be born
// as a JOB — a job number, a schedule, POs, a workbook — or as a work order
// raised by hand with nothing tying it back to the pursuit it came from.
//
// John, 2026-09-19: "work orders are mainly for urgent issues, a go and do
// this, it's approved type of call... service tickets are for our smaller
// service jobs 10k and below, these would already have a contract price and
// estimate to work from... we need to make the convert to screen to WO,
// Service ticket or JOB more robust as well."
//
//   window.p86ConvertPicker.open({ leadTitle, estimate, estimateTotal, hasEstimate })
//     -> Promise<{ target, contractAmount } | null>      (null = cancelled)
//
// target is 'job' | 'service_ticket' | 'work_order'. The CALLER does the
// converting: Create Job keeps its existing road (the Finalize Job modal and
// POST /api/jobs/convert), and the two ticket choices go to
// POST /api/service-tickets/convert. This file only asks the question.
//
// Self-contained inline themed styles, like js/job-finalize.js, so leads.js
// and estimate-editor.js can both call it with no stylesheet to keep in step.
(function () {
  'use strict';

  // John's line is "10k and below". It is how the company works, not a rule
  // about the data — so nothing here refuses a bigger one. Over it, the screen
  // says the number out loud and lets a person decide. The server does not
  // enforce it either (services/service-ticket-convert.js says so in as many
  // words), and the two must not drift into disagreeing.
  var SOFT_CEILING = 10000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(n) {
    return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // A price typed with a dollar sign and commas is still a price. Returns a
  // number, or null when there is nothing usable — deliberately the same rule
  // the server's MONEY_RE applies, so the screen cannot accept what the door
  // will refuse.
  function readMoney(raw) {
    var text = String(raw == null ? '' : raw).trim().replace(/[$,]/g, '');
    if (!text) return null;
    if (!/^[-+]?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null;
    var n = Number(text);
    return isFinite(n) && n >= 0 ? n : null;
  }

  // The nudge, and ONLY a nudge: a service ticket priced over the line gets a
  // sentence saying so. It never blocks, and it never appears on a work order
  // (which has no price) or on a job (which is the thing being nudged towards).
  function nudgeFor(target, amount) {
    if (target !== 'service_ticket') return '';
    var n = Number(amount);
    if (!isFinite(n) || n <= SOFT_CEILING) return '';
    return 'That is ' + money(n) + ' — over the ' + money(SOFT_CEILING).replace('.00', '') +
      ' line where this is usually a job. Still your call.';
  }

  // What a service ticket would be priced at: what the screen typed, else the
  // estimate's own total. Null means "not priced yet", which is what disables
  // Continue — a service ticket must arrive priced, and finding that out from
  // a 400 after the click is worse than not offering it.
  function priceFor(target, typed, estimateTotal) {
    if (target !== 'service_ticket') return null;
    var t = readMoney(typed);
    if (t != null) return t;
    var e = Number(estimateTotal);
    return isFinite(e) && e > 0 ? e : null;
  }

  // The three cards, in the order somebody reads them: the biggest record
  // first, because that is the one this screen replaced.
  var CHOICES = [
    {
      key: 'job',
      name: 'Job',
      number: 'S#### / RV####',
      what: 'A full project: schedule, purchase orders, billing, change orders and a workbook.',
      carries: 'Carries the estimate’s contract amount, the workbook, the site plan survey and the lead’s receipts.'
    },
    {
      key: 'service_ticket',
      name: 'Service ticket',
      number: 'ST-####',
      what: 'A sold service job, usually ' + money(SOFT_CEILING).replace('.00', '') +
        ' or under, with a contract price agreed up front.',
      carries: 'Takes its price and its scope from the estimate, and the client and address from the lead.'
    },
    {
      key: 'work_order',
      name: 'Work order',
      number: 'WO-####',
      what: 'An urgent call — go and do this, it’s approved. Billed afterwards from labour, materials and markup.',
      carries: 'No price up front. Carries the client and the address from the lead.'
    }
  ];

  function open(opts) {
    opts = opts || {};
    var estimateTotal = Number(opts.estimateTotal) || 0;
    var hasEstimate = !!opts.hasEstimate && estimateTotal > 0;

    return new Promise(function (resolve) {
      var modal = document.createElement('div');
      modal.className = 'p86-convert-modal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:9200;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto;';
      var card = 'background:var(--surface,#17171c);border:1px solid var(--border,#2a2a32);border-radius:14px;width:100%;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,.5);';
      var lbl = 'font-size:12px;font-weight:600;color:var(--text-dim,#b4b4bf);display:block;margin-bottom:5px;';
      var inp = 'appearance:none;width:100%;box-sizing:border-box;background:var(--input-bg,#101014);border:1px solid var(--border,#2a2a32);color:var(--text,#eef0f6);border-radius:8px;padding:9px 10px;font-size:14px;';
      var btn = 'appearance:none;border:1px solid var(--border,#2a2a32);background:var(--surface,#17171c);color:var(--text,#eef0f6);border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;';
      var btnPri = 'appearance:none;border:1px solid var(--accent,#4f8cff);background:var(--accent,#4f8cff);color:#fff;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;';
      var choiceBtn = 'appearance:none;display:block;width:100%;text-align:left;box-sizing:border-box;background:var(--input-bg,#101014);border:1px solid var(--border,#2a2a32);border-radius:10px;padding:11px 12px;margin-bottom:8px;cursor:pointer;color:var(--text,#eef0f6);font-family:inherit;';

      modal.innerHTML =
        '<div style="' + card + '">' +
          '<div style="padding:16px;">' +
            '<div style="font-size:16px;font-weight:700;color:var(--text,#eef0f6);margin-bottom:4px;">What is this becoming?</div>' +
            '<div style="font-size:12px;color:var(--text-dim,#b4b4bf);margin-bottom:14px;line-height:1.5;">' +
              esc(opts.leadTitle || 'This lead') +
              (hasEstimate
                ? ' &middot; estimate at <strong>' + esc(money(estimateTotal)) + '</strong>'
                : ' &middot; no estimate attached') +
            '</div>' +
            '<div id="p86cvChoices">' +
              CHOICES.map(function (c) {
                return '<button type="button" data-cv="' + esc(c.key) + '" style="' + choiceBtn + '">' +
                  '<div style="display:flex;align-items:baseline;gap:8px;">' +
                    '<span style="font-size:14px;font-weight:700;">' + esc(c.name) + '</span>' +
                    '<span style="font-size:11px;color:var(--text-dim,#b4b4bf);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">' + esc(c.number) + '</span>' +
                  '</div>' +
                  '<div style="font-size:12px;color:var(--text,#eef0f6);opacity:.85;margin-top:3px;line-height:1.45;">' + esc(c.what) + '</div>' +
                  '<div style="font-size:11px;color:var(--text-dim,#b4b4bf);margin-top:3px;line-height:1.45;">' + esc(c.carries) + '</div>' +
                '</button>';
              }).join('') +
            '</div>' +
            '<div id="p86cvPrice" style="display:none;margin:12px 0 0;">' +
              '<label style="' + lbl + '">Contract price</label>' +
              '<input id="p86cvAmount" style="' + inp + '" placeholder="' + (hasEstimate ? esc(money(estimateTotal)) : '0.00') + '" autocomplete="off" inputmode="decimal" />' +
              '<div id="p86cvPriceHint" style="font-size:11px;color:var(--text-dim,#b4b4bf);margin-top:5px;line-height:1.45;"></div>' +
            '</div>' +
            '<div id="p86cvNudge" style="display:none;font-size:11px;color:#f0a020;margin-top:8px;line-height:1.45;"></div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' +
              '<button id="p86cvCancel" style="' + btn + '">Cancel</button>' +
              '<button id="p86cvOk" style="' + btnPri + '" disabled>Continue</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      var amountEl = modal.querySelector('#p86cvAmount');
      var priceBox = modal.querySelector('#p86cvPrice');
      var priceHint = modal.querySelector('#p86cvPriceHint');
      var nudgeEl = modal.querySelector('#p86cvNudge');
      var okEl = modal.querySelector('#p86cvOk');
      var chosen = null;

      function paint() {
        Array.prototype.forEach.call(modal.querySelectorAll('[data-cv]'), function (b) {
          var on = b.getAttribute('data-cv') === chosen;
          b.style.borderColor = on ? 'var(--accent,#4f8cff)' : 'var(--border,#2a2a32)';
          b.style.boxShadow = on ? '0 0 0 1px var(--accent,#4f8cff) inset' : 'none';
        });
        priceBox.style.display = chosen === 'service_ticket' ? '' : 'none';
        var price = priceFor(chosen, amountEl.value, estimateTotal);
        if (chosen === 'service_ticket') {
          priceHint.textContent = hasEstimate
            ? 'Leave it blank to use the estimate’s ' + money(estimateTotal) + '.'
            : 'A service ticket is sold at a price. Type it, or go back and attach the estimate.';
        }
        var nudge = nudgeFor(chosen, price);
        nudgeEl.textContent = nudge;
        nudgeEl.style.display = nudge ? '' : 'none';
        // A service ticket with no price cannot be created, so it is not
        // offered: the refusal would otherwise arrive as a 400 after the click.
        okEl.disabled = !chosen || (chosen === 'service_ticket' && price == null);
        okEl.style.opacity = okEl.disabled ? '.5' : '1';
        okEl.style.cursor = okEl.disabled ? 'not-allowed' : 'pointer';
      }

      var done = false;
      function close(result) { if (done) return; done = true; modal.remove(); resolve(result || null); }
      function submit() {
        if (!chosen) return;
        var price = priceFor(chosen, amountEl.value, estimateTotal);
        if (chosen === 'service_ticket' && price == null) return;
        close({
          target: chosen,
          // Only when the screen TYPED one. A blank box means "the estimate's
          // number", and the server reads that from the estimate itself — so
          // the ticket and the proposal cannot disagree about it.
          contractAmount: (chosen === 'service_ticket' && readMoney(amountEl.value) != null)
            ? readMoney(amountEl.value) : null
        });
      }

      Array.prototype.forEach.call(modal.querySelectorAll('[data-cv]'), function (b) {
        b.addEventListener('click', function () {
          chosen = b.getAttribute('data-cv');
          paint();
          if (chosen === 'service_ticket') setTimeout(function () { amountEl.focus(); }, 20);
        });
      });
      amountEl.addEventListener('input', paint);
      amountEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      okEl.addEventListener('click', submit);
      modal.querySelector('#p86cvCancel').addEventListener('click', function () { close(null); });
      modal.addEventListener('click', function (e) { if (e.target === modal) close(null); });
      modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(null); });
      paint();
    });
  }

  var API = {
    open: open,
    SOFT_CEILING: SOFT_CEILING,
    CHOICES: CHOICES,
    readMoney: readMoney,
    nudgeFor: nudgeFor,
    priceFor: priceFor
  };
  if (typeof window !== 'undefined') window.p86ConvertPicker = API;
  // Test seam, like js/job-finalize.js: a browser script re-exported under
  // jest so the decisions that are not about the DOM — what counts as a price,
  // when the nudge appears, when Continue is offered — can be driven directly.
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
