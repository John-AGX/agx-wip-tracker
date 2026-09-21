// Time and materials on a work order — the office side (Phase 3).
//
// John, 2026-09-19: work orders are "billed based on work performed and
// materials and mark-up after the job is done", and the time comes from the
// people who did it — "tech optional, office can enter".
//
// This registers a panel on the open work order (window.p86StExt, slot
// afterSite, after the crew's problems) that is only there when the ticket
// bills after the work: the detail read carries field_log only then, and this
// module draws nothing without it. It shows:
//
//   * every line the crew sent, waiting ones first, with Accept, Change and
//     Reject. Change writes the office's number BESIDE the tech's — the claim
//     stays on the line, so "the tech said 8, it was 6" stays readable;
//   * Add time / Add material, for work phoned in or written on paper. Those
//     lines are born accepted and say the office entered them;
//   * the totals, counted from ACCEPTED lines only, with the waiting ones
//     counted apart, so a number nobody has looked at never reads as settled.
//
// No price, rate or cost appears here: that is the billing phase. The crew
// link never sees anything this panel shows except its own line and a word.
(function () {
  'use strict';

  var STATUS = {
    submitted: { text: 'Waiting on you', cls: 'wait' },
    accepted: { text: 'Accepted', cls: 'ok' },
    rejected: { text: 'Rejected', cls: 'no' }
  };
  var PATH_KIND = { labor: 'labor', material: 'material' };
  // Which inline form is open, per ticket: 'add:labor', 'add:material',
  // 'change:<kind>:<line id>'. Kept across repaints so a refresh from another
  // module does not close a half-typed correction.
  var _open = {};
  // Half-typed office entries, per ticket and form.
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
    if (kind === 'error' && typeof console !== 'undefined') console.error('[field-log] ' + msg);
  }

  // A calendar day, read the way the rest of the work order reads one: a
  // DATE is a day, never an instant shifted into the previous one.
  function fmtDay(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function num(v) {
    var n = Number(v);
    if (!isFinite(n)) return '';
    return (Math.round(n * 100) / 100).toString();
  }

  function today() {
    var n = new Date();
    return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2);
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function whoLine(l) {
    if (l.source === 'office') {
      var who = l.author_label || '';
      var by = l.entered_by_name ? 'entered in the office by ' + l.entered_by_name : 'entered in the office';
      return who && who !== l.entered_by_name ? who + ' · ' + by : by.charAt(0).toUpperCase() + by.slice(1);
    }
    return (l.author_label || 'Crew link') + ' · crew link' + (l.via_revoked_link ? ' (since turned off)' : '');
  }

  function statusChip(l) {
    var s = STATUS[l.status] || STATUS.submitted;
    return '<span class="p86-fl-st ' + s.cls + '">' + esc(s.text) + '</span>';
  }

  // "6.5 h" or "6.5 h → 6 h" when the office changed it. The claim is always
  // shown: it is the record of what the tech said.
  function claimed(claim, office, unit) {
    var c = num(claim) + (unit ? ' ' + unit : '');
    if (office == null || office === '') return esc(c);
    return '<s class="p86-fl-claim">' + esc(c) + '</s> <strong>' + esc(num(office) + (unit ? ' ' + unit : '')) + '</strong>';
  }

  function laborHead(l) {
    var people = l.office_crew_size != null
      ? claimed(l.crew_size, l.office_crew_size, '') + ' people'
      : esc(plural(Number(l.crew_size), 'person', 'people'));
    return esc(fmtDay(l.work_date)) + ' · ' + people + ' · ' + claimed(l.hours, l.office_hours, 'h') + ' on site' +
      (l.person_hours != null && l.status !== 'rejected' ? ' · <span class="p86-fl-ph">' + esc(num(l.person_hours)) + ' person-hours</span>' : '');
  }

  function materialHead(l) {
    return '<strong>' + esc(l.description || '') + '</strong> · ' + claimed(l.quantity, l.office_quantity, l.unit || '');
  }

  function lineHTML(kind, l, t, canEdit) {
    var key = 'change:' + kind + ':' + l.id;
    var editing = canEdit && _open[String(t.id)] === key;
    var where = l.task_title ? l.task_title : 'Whole work order';
    var html = '<div class="p86-fl-line' + (l.status === 'submitted' ? ' is-waiting' : '') + '" data-kind="' + esc(kind) + '" data-line="' + esc(l.id) + '">' +
      '<div class="p86-fl-line-h"><span>' + (kind === 'labor' ? laborHead(l) : materialHead(l)) + '</span>' + statusChip(l) + '</div>' +
      (kind === 'labor' && l.work_performed ? '<div class="p86-fl-what">' + esc(l.work_performed) + '</div>' : '') +
      '<div class="p86-fl-meta">' + esc(where) + ' · ' + esc(whoLine(l)) +
        (l.office_note ? ' · <em>' + esc(l.office_note) + '</em>' : '') + '</div>';
    if (canEdit && !editing) {
      html += '<div class="p86-fl-acts">' +
        (l.status !== 'accepted' || l.office_hours != null || l.office_crew_size != null || l.office_quantity != null
          ? '<button type="button" class="ee-btn secondary p86-fl-accept">Accept' + (l.status === 'accepted' ? ' as sent' : '') + '</button>' : '') +
        '<button type="button" class="ee-btn secondary p86-fl-change">Change…</button>' +
        (l.status !== 'rejected' ? '<button type="button" class="ee-btn secondary p86-fl-reject">Reject</button>' : '') +
      '</div>';
    }
    if (editing) {
      html += '<div class="p86-fl-form p86-fl-changeform">' +
        (kind === 'labor'
          ? '<label>People<input type="number" min="1" max="50" step="1" class="p86-fl-in" data-f="crew_size" value="' + esc(l.office_crew_size != null ? l.office_crew_size : l.crew_size) + '" /></label>' +
            '<label>Hours on site<input type="text" inputmode="decimal" class="p86-fl-in" data-f="hours" value="' + esc(num(l.office_hours != null ? l.office_hours : l.hours)) + '" /></label>'
          : '<label>How many<input type="text" inputmode="decimal" class="p86-fl-in" data-f="quantity" value="' + esc(num(l.office_quantity != null ? l.office_quantity : l.quantity)) + '" /></label>') +
        '<label class="wide">Note (office only)<input type="text" maxlength="1000" class="p86-fl-in" data-f="note" value="' + esc(l.office_note || '') + '" placeholder="Why it changed — the crew never sees this" /></label>' +
        '<div class="p86-fl-formacts"><button type="button" class="ee-btn primary p86-fl-save-change">Accept with this</button>' +
        '<button type="button" class="ee-btn secondary p86-fl-cancel">Cancel</button></div>' +
      '</div>';
    }
    return html + '</div>';
  }

  function typedFor(t, kind) {
    var k = String(t.id) + ':' + kind;
    if (!_typed[k]) _typed[k] = kind === 'labor' ? { work_date: today(), crew_size: '1' } : {};
    return _typed[k];
  }

  function buildingOptions(ctx, current) {
    var tasks = (ctx && ctx.r && Array.isArray(ctx.r.tasks)) ? ctx.r.tasks : [];
    if (!tasks.length) return '';
    var head = function (k) {
      var p = ctx && typeof ctx.parseSubtaskTitle === 'function' ? ctx.parseSubtaskTitle(k.title || '') : null;
      return (p && p.head) || k.title || '';
    };
    return '<label>Building<select class="p86-fl-in" data-f="task_id">' +
      '<option value="">The whole work order</option>' +
      tasks.map(function (k) {
        return '<option value="' + esc(k.id) + '"' + (String(current || '') === String(k.id) ? ' selected' : '') + '>' + esc(head(k)) + '</option>';
      }).join('') + '</select></label>';
  }

  function addFormHTML(kind, t, ctx) {
    var v = typedFor(t, kind);
    if (kind === 'labor') {
      return '<div class="p86-fl-form p86-fl-addform" data-kind="labor">' +
        '<label>Day<input type="date" class="p86-fl-in" data-f="work_date" value="' + esc(v.work_date || '') + '" /></label>' +
        '<label>People<input type="number" min="1" max="50" step="1" class="p86-fl-in" data-f="crew_size" value="' + esc(v.crew_size || '') + '" /></label>' +
        '<label>Hours on site<input type="text" inputmode="decimal" placeholder="6.5" class="p86-fl-in" data-f="hours" value="' + esc(v.hours || '') + '" /></label>' +
        buildingOptions(ctx, v.task_id) +
        '<label class="wide">What was done<textarea rows="2" maxlength="2000" class="p86-fl-in" data-f="work_performed" placeholder="What the crew did — this is what gets billed">' + esc(v.work_performed || '') + '</textarea></label>' +
        '<label class="wide">Who did it<input type="text" maxlength="120" class="p86-fl-in" data-f="by" placeholder="For example: Marco, phoned in" value="' + esc(v.by || '') + '" /></label>' +
        '<div class="p86-fl-formacts"><button type="button" class="ee-btn primary p86-fl-save-add">Add time</button>' +
        '<button type="button" class="ee-btn secondary p86-fl-cancel">Cancel</button></div>' +
      '</div>';
    }
    return '<div class="p86-fl-form p86-fl-addform" data-kind="material">' +
      '<label class="wide">What was it<input type="text" maxlength="200" class="p86-fl-in" data-f="description" value="' + esc(v.description || '') + '" /></label>' +
      '<label>How many<input type="text" inputmode="decimal" class="p86-fl-in" data-f="quantity" value="' + esc(v.quantity || '') + '" /></label>' +
      '<label>Unit<input type="text" maxlength="30" placeholder="ea, ft, gal" class="p86-fl-in" data-f="unit" value="' + esc(v.unit || '') + '" /></label>' +
      buildingOptions(ctx, v.task_id) +
      '<label class="wide">Who used it<input type="text" maxlength="120" class="p86-fl-in" data-f="by" value="' + esc(v.by || '') + '" /></label>' +
      '<div class="p86-fl-formacts"><button type="button" class="ee-btn primary p86-fl-save-add">Add material</button>' +
      '<button type="button" class="ee-btn secondary p86-fl-cancel">Cancel</button></div>' +
    '</div>';
  }

  function summaryHTML(log) {
    var s = (log && log.summary) || {};
    var parts = [];
    parts.push('<strong>' + esc(num(s.accepted_person_hours || 0)) + '</strong> person-hours accepted');
    parts.push(esc(plural(Number(s.accepted_materials || 0), 'material', 'materials')) + ' accepted');
    if (s.waiting) parts.push('<span class="p86-fl-waiting">' + esc(plural(Number(s.waiting), 'line', 'lines')) + ' waiting on you</span>');
    return '<div class="p86-fl-sum">' + parts.join(' · ') + '</div>';
  }

  function panelHTML(log, t, ctx) {
    if (!log) return '';
    var canEdit = !!(ctx && ctx.canEdit);
    var labor = Array.isArray(log.labor) ? log.labor : [];
    var mats = Array.isArray(log.materials) ? log.materials : [];
    var open = _open[String(t.id)] || '';
    var html = '<div class="p86-fl" data-fl-ticket="' + esc(t.id) + '">' +
      '<label class="p86-st-lbl">Time and materials' +
        (log.summary && log.summary.waiting ? ' <span class="p86-fl-badge">' + esc(log.summary.waiting) + ' to review</span>' : '') +
      '</label>' +
      (log.failed ? '<div class="p86-fl-empty">The time and materials could not be loaded. Reload to try again.</div>' : summaryHTML(log));

    html += '<div class="p86-fl-group"><div class="p86-fl-gh">Time</div>' +
      (labor.length ? labor.map(function (l) { return lineHTML('labor', l, t, canEdit); }).join('')
        : '<div class="p86-fl-empty">No time yet. The crew sends it from their link, or add it here.</div>') +
      (canEdit ? (open === 'add:labor' ? addFormHTML('labor', t, ctx)
        : '<button type="button" class="ee-btn secondary p86-fl-open-add" data-kind="labor">+ Add time</button>') : '') +
      '</div>';
    html += '<div class="p86-fl-group"><div class="p86-fl-gh">Materials used</div>' +
      (mats.length ? mats.map(function (l) { return lineHTML('material', l, t, canEdit); }).join('')
        : '<div class="p86-fl-empty">No materials yet.</div>') +
      (canEdit ? (open === 'add:material' ? addFormHTML('material', t, ctx)
        : '<button type="button" class="ee-btn secondary p86-fl-open-add" data-kind="material">+ Add material</button>') : '') +
      '</div>';
    return html + '</div>';
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  function formValues(form) {
    var out = {};
    Array.prototype.forEach.call(form.querySelectorAll('.p86-fl-in'), function (el) {
      out[el.getAttribute('data-f')] = el.value;
    });
    return out;
  }

  function busy(node, on) {
    Array.prototype.forEach.call(node.querySelectorAll('button, .p86-fl-in'), function (el) { el.disabled = !!on; });
  }

  function wire(node, ctx) {
    var t = (ctx && ctx.t) || {};
    var tid = String(t.id);
    var st = api();
    var repaint = function () { return ctx && typeof ctx.refresh === 'function' ? ctx.refresh() : undefined; };
    var panel = node.querySelector ? (node.classList && node.classList.contains('p86-fl') ? node : node.querySelector('.p86-fl')) : null;
    if (!panel) return;

    // Half-typed office entries survive a repaint.
    Array.prototype.forEach.call(panel.querySelectorAll('.p86-fl-addform .p86-fl-in'), function (el) {
      var kind = el.closest('.p86-fl-addform').getAttribute('data-kind');
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
        typedFor(t, kind)[el.getAttribute('data-f')] = el.value;
      });
    });

    panel.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || !panel.contains(b) || b.disabled) return;
      var line = b.closest('.p86-fl-line');
      var kind = line ? line.getAttribute('data-kind') : b.getAttribute('data-kind') ||
        (b.closest('.p86-fl-addform') && b.closest('.p86-fl-addform').getAttribute('data-kind'));
      var lineId = line ? line.getAttribute('data-line') : null;

      if (b.classList.contains('p86-fl-open-add')) { _open[tid] = 'add:' + kind; return repaint(); }
      if (b.classList.contains('p86-fl-change')) { _open[tid] = 'change:' + kind + ':' + lineId; return repaint(); }
      if (b.classList.contains('p86-fl-cancel')) { delete _open[tid]; return repaint(); }
      if (!st) { toast('Reload the page to do that.', 'error'); return; }

      var decide = function (body, okText) {
        busy(line || panel, true);
        return st.decideFieldLine(t.id, PATH_KIND[kind], lineId, body).then(function () {
          delete _open[tid];
          toast(okText, 'success');
          return repaint();
        }, function (err) {
          busy(line || panel, false);
          toast((err && err.message) || 'That did not save.', 'error');
        });
      };

      if (b.classList.contains('p86-fl-accept')) return decide({ decision: 'accept' }, 'Accepted');
      if (b.classList.contains('p86-fl-reject')) return decide({ decision: 'reject' }, 'Rejected — it will not be billed');
      if (b.classList.contains('p86-fl-save-change')) {
        var vals = formValues(b.closest('.p86-fl-changeform'));
        var body = { decision: 'accept', note: vals.note };
        if (kind === 'labor') { body.hours = vals.hours; body.crew_size = vals.crew_size; }
        else body.quantity = vals.quantity;
        return decide(body, 'Saved — the crew line is kept beside it');
      }
      if (b.classList.contains('p86-fl-save-add')) {
        var form = b.closest('.p86-fl-addform');
        var v = formValues(form);
        if (!v.task_id) v.task_id = null;
        if (kind === 'labor') v.crew_size = Number(v.crew_size);
        busy(form, true);
        var call = kind === 'labor' ? st.addLabor(t.id, v) : st.addMaterial(t.id, v);
        return call.then(function () {
          delete _open[tid];
          delete _typed[tid + ':' + kind];
          toast(kind === 'labor' ? 'Time added' : 'Material added', 'success');
          return repaint();
        }, function (err) {
          busy(form, false);
          toast((err && err.message) || 'That did not save.', 'error');
        });
      }
    });
  }

  // The timeline's words for the new events. Shape only — the words the crew
  // typed live on the line, not in the event.
  function eventWhat(event) {
    var d = event && event.detail;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
    d = d || {};
    switch (event && event.kind) {
      case 'labor_sent': return 'sent their time';
      case 'material_sent': return 'sent a material used';
      case 'labor_entered': return 'entered time for the crew';
      case 'material_entered': return 'entered a material used';
      case 'field_line_decided':
        return (d.decision === 'rejected' ? 'rejected ' : d.corrected ? 'corrected and accepted ' : 'accepted ') +
          (d.kind === 'material' ? 'a material line' : 'a time line');
      default: return null;
    }
  }

  var extension = {
    order: 35,
    detailSections: function (ctx) {
      var c = ctx || {};
      var r = c.r || {};
      if (!r.field_log) return [];
      return [{
        key: 'field-log',
        slot: 'afterSite',
        html: panelHTML(r.field_log, c.t || {}, c),
        wire: function (node, live) { wire(node, live || c); }
      }];
    },
    eventWhat: function (event) {
      var text = eventWhat(event);
      return text == null ? null : esc(text);
    }
  };

  window.p86TicketFieldLog = { panelHTML: panelHTML, eventWhat: eventWhat, extension: extension };

  function registerWithTicketScreen() {
    if (!window.p86StExt || typeof window.p86StExt.register !== 'function') return false;
    return window.p86StExt.register('field-log', extension);
  }
  if (!registerWithTicketScreen() && typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerWithTicketScreen);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = window.p86TicketFieldLog;
})();
