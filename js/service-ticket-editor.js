// ============================================================
// Project 86 — Service ticket office editor kit (window.p86StEditor)
// ------------------------------------------------------------
// The pieces js/service-tickets.js needs to edit an open work order without
// losing what the PM typed:
//
//   - the field markup (Title, Internal notes, and the Details side panel:
//     Assigned to, Priority, Scheduled, Due, Site contact, Site phone,
//     Gate code / access, the work order's own address, and the save notes);
//   - dirty tracking against the SERVER's values, and a patch that carries only
//     the fields that changed plus what they were when loaded (`expected`), so
//     the server can refuse a save that would overwrite someone else's change;
//   - the "Save your changes first?" question before anything that would redraw
//     the fields, the bad-field highlight and the edit-conflict banner;
//   - the Assigned to picker (only people who can open the job or lead);
//   - section swapping and scroll keeping for in-place updates.
//
// It holds no ticket state and makes no writes. The pure helpers are also on
// module.exports, the same pattern as js/job-label.js, so tests can require
// the shipped file.
//
// Reason dialogs for Move to… are NOT here — js/work-order-review.js owns them.
// Loaded before js/service-tickets.js.
// ============================================================
(function () {
  'use strict';

  function win() { return typeof window !== 'undefined' ? window : {}; }

  // ── Fields ─────────────────────────────────────────────────────────────
  // Labels are what the office reads in "You changed Scope and Due". The caps
  // mirror the server's field check (server/services/service-ticket-fields.js),
  // which is the one that actually refuses; these only stop a box accepting
  // text the server would turn away.
  var FIELDS = [
    { key: 'title', label: 'Title', kind: 'text', max: 300 },
    { key: 'scope_proposed', label: 'Scope', kind: 'text', max: 20000 },
    { key: 'internal_notes', label: 'Internal notes', kind: 'text', max: 10000 },
    { key: 'priority', label: 'Priority', kind: 'priority', max: null },
    { key: 'assignee_user_id', label: 'Assigned to', kind: 'user', max: null },
    { key: 'scheduled_for', label: 'Scheduled', kind: 'date', max: null },
    { key: 'due_date', label: 'Due', kind: 'date', max: null },
    { key: 'site_contact_name', label: 'Site contact', kind: 'text', max: 200 },
    { key: 'site_contact_phone', label: 'Site phone', kind: 'phone', max: 40 },
    { key: 'access_notes', label: 'Gate code / access', kind: 'text', max: 1000 },
    // The work order's own address. Four boxes, one thing to the reader.
    { key: 'street_address', label: 'Address', kind: 'text', max: 300 },
    { key: 'city', label: 'Address', kind: 'text', max: 120 },
    { key: 'state', label: 'Address', kind: 'text', max: 60 },
    { key: 'zip', label: 'Address', kind: 'text', max: 20 }
  ];
  FIELDS.forEach(function (f) { Object.freeze(f); });
  Object.freeze(FIELDS);

  var FIELD_BY_KEY = {};
  FIELDS.forEach(function (f) { FIELD_BY_KEY[f.key] = f; });

  var ADDRESS_KEYS = { street_address: true, city: true, state: true, zip: true };

  // Keys the server can name that have no box here (an edit conflict or a 400
  // can still mention them).
  var OTHER_LABELS = {
    scope_approved: 'Approved scope', requested_by: 'Requested by',
    lat: 'Map pin', lng: 'Map pin', materials: 'Materials', checklist: 'Checklist'
  };

  var PRIORITIES = ['low', 'normal', 'high', 'urgent'];
  var PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

  var MSG = {
    stay: 'Save or undo your changes first.',
    saveFirstTitle: 'Save your changes first?',
    discardTitle: 'Discard unsaved changes?',
    useTheirs: 'Use their version',
    internalPlaceholder: 'Notes for the office. The crew never sees these.',
    internalHelp: 'Never shown on the crew link.',
    internalEmpty: 'No internal notes.'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Keys reach selectors, so only plain field-shaped keys are looked up.
  function safeKey(key) {
    return typeof key === 'string' && /^[A-Za-z0-9_-]+$/.test(key);
  }

  function kindOf(key) {
    var f = FIELD_BY_KEY[key];
    if (f) return f.kind;
    if (key === 'lat' || key === 'lng') return 'coord';
    return 'text';
  }

  function labelOf(key) {
    if (FIELD_BY_KEY[key]) return FIELD_BY_KEY[key].label;
    if (OTHER_LABELS[key]) return OTHER_LABELS[key];
    var s = String(key == null ? '' : key).replace(/_/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  // ── Values ─────────────────────────────────────────────────────────────
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // A calendar day as 'YYYY-MM-DD'. A Date object is read in local time (pg
  // parses a DATE at local midnight); a string gives its leading day, which
  // covers both '2026-09-20' and the '2026-09-20T00:00:00.000Z' a DATE column
  // serializes to.
  function dateOnly(v) {
    if (v == null) return null;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return null;
      return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    var m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  }

  // A user id as its digits, or '' for none / not an id.
  function userId(v) {
    if (v == null || v === '') return '';
    var n;
    if (typeof v === 'number') n = v;
    else if (/^\s*\d+\s*$/.test(String(v))) n = Number(String(v).trim());
    else return '';
    return (isFinite(n) && n > 0 && Math.floor(n) === n && n <= 9007199254740991) ? String(n) : '';
  }

  // The same comparison the server makes (ticketFieldComparable), so the
  // office's "changed" and the server's "changed" never disagree. A textarea
  // turns CR and CRLF into LF and a DATE comes back with a time on it; neither
  // is an edit. A date that can't be read compares as its trimmed text, as on
  // the server.
  function norm(key, v) {
    if (v === null || v === undefined) return '';
    var kind = kindOf(key);
    if (kind === 'date') {
      var d = dateOnly(v);
      return d != null ? d : String(v).trim();
    }
    if (kind === 'user') return userId(v);
    if (kind === 'coord') {
      var s = String(v).trim();
      if (!s) return '';
      var n = Number(s);
      return isFinite(n) ? String(n) : s;
    }
    if (kind === 'priority') return String(v).trim().toLowerCase();
    return String(v).replace(/\r\n?/g, '\n').trim();
  }

  // What the base looks like once a box has shown it. A one-line <input>
  // drops CR and LF from anything put in it, so a stored line break in the
  // title, the contact or the address is not an edit; a textarea keeps them.
  function shownBase(c, key, v) {
    var kind = kindOf(key);
    if (v == null || !c || String(c.tagName).toUpperCase() !== 'INPUT' || (kind !== 'text' && kind !== 'phone')) return v;
    return String(v).replace(/[\r\n]/g, '');
  }

  // What a box shows for a server value.
  function displayValue(key, v) {
    var kind = kindOf(key);
    if (kind === 'date') return dateOnly(v) || '';
    if (kind === 'user') return userId(v);
    if (kind === 'priority') {
      var p = v == null ? '' : String(v).trim().toLowerCase();
      return PRIORITIES.indexOf(p) >= 0 ? p : 'normal';
    }
    return v == null ? '' : String(v);
  }

  // What a box sends. Dates and the assignee send null for empty; the assignee
  // goes as a Number. Text goes as typed — the server trims.
  function sendValue(key, v) {
    var kind = kindOf(key);
    if (kind === 'date') return v === '' || v == null ? null : v;
    if (kind === 'user') {
      if (v === '' || v == null) return null;
      return /^\d+$/.test(String(v)) ? Number(v) : v;
    }
    return v;
  }

  // The base is the SERVER's JSON, never the DOM: a textarea has already
  // rewritten its line endings by the time anything could read it back.
  function baseOf(ticket) {
    var t = ticket || {};
    var out = {};
    FIELDS.forEach(function (f) {
      out[f.key] = (Object.prototype.hasOwnProperty.call(t, f.key) && t[f.key] !== undefined) ? t[f.key] : null;
    });
    return out;
  }

  function controlOf(root, key) {
    if (!root || !root.querySelector || !safeKey(key)) return null;
    return root.querySelector('[data-st-field="' + key + '"]');
  }

  // Fields whose box differs from where it started, in FIELDS order.
  function dirtyKeys(root, base) {
    var out = [];
    if (!root) return out;
    var b = base || {};
    FIELDS.forEach(function (f) {
      var c = controlOf(root, f.key);
      if (!c) return;
      if (norm(f.key, c.value) !== norm(f.key, shownBase(c, f.key, b[f.key]))) out.push(f.key);
    });
    return out;
  }

  // { <changed field>: value, …, expected: { <changed field>: value as loaded } }.
  // Only changed fields go, so a save can never put back a value someone else
  // changed in a field this PM did not touch.
  function buildPatch(root, base, keys) {
    var b = base || {};
    var list = Array.isArray(keys) ? keys : dirtyKeys(root, b);
    var patch = {};
    var expected = {};
    list.forEach(function (k) {
      var c = controlOf(root, k);
      if (!c) return;
      patch[k] = sendValue(k, c.value);
      expected[k] = b[k] === undefined ? null : b[k];
    });
    patch.expected = expected;
    return patch;
  }

  // 'A' / 'A and B' / 'A, B and C', repeats dropped.
  function joinList(items) {
    var seen = {};
    var a = [];
    (Array.isArray(items) ? items : []).forEach(function (s) {
      if (s == null || s === '') return;
      var k = String(s);
      if (seen[k]) return;
      seen[k] = true;
      a.push(k);
    });
    if (!a.length) return '';
    if (a.length === 1) return a[0];
    return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }

  function labelList(keys) {
    return joinList((Array.isArray(keys) ? keys : []).map(labelOf));
  }

  // Work a full redraw would lose that is not a ticket field. A share link
  // just minted is deliberately not on this list: collapsing the ticket is how
  // that panel is dismissed.
  function unsavedExtras(root) {
    var out = [];
    if (!root || !root.querySelectorAll) return out;

    var mats = false;
    Array.prototype.forEach.call(root.querySelectorAll('.p86-wo-mats-form'), function (form) {
      if (mats) return;
      if (form.hasAttribute('data-filling')) { mats = true; return; }
      if (form.hidden) return;
      Array.prototype.forEach.call(form.querySelectorAll('input, textarea'), function (f) {
        if (f.type === 'checkbox' || f.type === 'radio') { if (f.checked !== f.defaultChecked) mats = true; return; }
        if (f.value !== f.defaultValue) mats = true;
      });
    });
    if (mats) out.push('the materials list you were editing');

    var notes = 0;
    Array.prototype.forEach.call(root.querySelectorAll('.p86-wo-note-in'), function (n) {
      if (String(n.value || '').trim()) notes++;
    });
    if (notes === 1) out.push('the building note you typed');
    else if (notes > 1) out.push('the ' + notes + ' building notes you typed');

    var adding = root.querySelector('.p86-st-task-new');
    if (adding && String(adding.value || '').trim()) out.push('the building you were adding');
    return out;
  }

  function toast(msg, kind) {
    var w = win();
    if (typeof w.p86Toast === 'function') {
      try { w.p86Toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (typeof console !== 'undefined' && console.warn) console.warn('[p86StEditor] ' + msg);
  }

  // Resolves 'saved' | 'discard' | 'stay'. Never rejects. With no dialog
  // helper to ask with, it refuses to go on: losing typed work silently is the
  // one outcome this exists to prevent.
  function confirmUnsaved(opts) {
    var o = opts || {};
    var w = win();
    var keys = (Array.isArray(o.keys) ? o.keys : []).filter(Boolean);
    var extras = (Array.isArray(o.extras) ? o.extras : []).filter(Boolean);
    if (!keys.length && !extras.length) return Promise.resolve('discard');

    function stay() {
      toast(MSG.stay, 'error');
      return Promise.resolve('stay');
    }

    if (keys.length) {
      if (typeof w.p86ConfirmTernary !== 'function') return stay();
      var message = 'You changed ' + labelList(keys) + " and haven't saved." +
        (extras.length ? ' Continuing also loses ' + joinList(extras) + '.' : '');
      var asked;
      try {
        asked = w.p86ConfirmTernary({
          title: MSG.saveFirstTitle,
          message: message,
          primaryLabel: 'Save changes',
          secondaryLabel: 'Discard changes',
          cancelLabel: 'Keep editing'
        });
      } catch (e) {
        return stay();
      }
      return Promise.resolve(asked).then(function (answer) {
        if (answer === 'secondary') return 'discard';
        if (answer !== 'primary' || typeof o.save !== 'function') return 'stay';
        return Promise.resolve().then(function () { return o.save(); }).then(function (ok) {
          return ok === true ? 'saved' : 'stay';
        }, function () { return 'stay'; });
      }, function () { return 'stay'; });
    }

    if (typeof w.p86Confirm !== 'function') return stay();
    var yes;
    try {
      // Both option spellings: two dialog implementations ship (js/app.js
      // reads confirmText/destructive/cancelText, js/dialogs.js the others).
      yes = w.p86Confirm({
        title: MSG.discardTitle,
        message: 'Continuing loses ' + joinList(extras) + '.',
        confirmText: 'Discard',
        confirmLabel: 'Discard',
        cancelText: 'Keep editing',
        cancelLabel: 'Keep editing',
        destructive: true,
        danger: true
      });
    } catch (e) {
      return stay();
    }
    return Promise.resolve(yes).then(function (v) { return v === true ? 'discard' : 'stay'; }, function () { return 'stay'; });
  }

  // ── Save notes ─────────────────────────────────────────────────────────
  function clearOne(c) {
    c.removeAttribute('aria-invalid');
    c.classList.remove('is-invalid');
  }

  function markInvalid(root, field, message) {
    if (!root || !root.querySelector) return null;
    var c = controlOf(root, field);
    if (c) {
      // The address boxes sit inside a closed details on most tickets; a
      // highlight nobody can see is no highlight.
      if (ADDRESS_KEYS[field] && c.closest) {
        var det = c.closest('details');
        if (det) det.open = true;
      }
      c.setAttribute('aria-invalid', 'true');
      c.classList.add('is-invalid');
      if (!c._p86StInvalidWired) {
        c._p86StInvalidWired = true;
        c.addEventListener('input', function () {
          if (c.getAttribute('aria-invalid') !== 'true') return;
          clearOne(c);
          if (!root.querySelector('.is-invalid')) {
            var e = root.querySelector('.p86-st-save-err');
            if (e) { e.textContent = ''; e.hidden = true; }
          }
        });
      }
    }
    var err = root.querySelector('.p86-st-save-err');
    if (err) {
      err.textContent = message ? String(message) : '';
      err.hidden = !message;
    }
    if (c) {
      try { c.focus(); } catch (e) { /* not focusable */ }
      if (typeof c.scrollIntoView === 'function') {
        try { c.scrollIntoView({ block: 'center' }); } catch (e) { /* old engine */ }
      }
    }
    return c;
  }

  function clearInvalid(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[aria-invalid="true"], .is-invalid'), clearOne);
    var err = root.querySelector('.p86-st-save-err');
    if (err) { err.textContent = ''; err.hidden = true; }
  }

  function findOption(select, value) {
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) return select.options[i];
    }
    return null;
  }

  // Put a server value into a box as its new starting point: value AND
  // defaultValue (for a select, the option's defaultSelected), so the box
  // reads as unchanged to every dirty check.
  function setControl(root, key, v) {
    var c = controlOf(root, key);
    if (!c) return null;
    var shown = displayValue(key, v);
    if (c.tagName === 'SELECT') {
      if (!findOption(c, shown)) {
        var o = c.ownerDocument.createElement('option');
        o.value = shown;
        var nm = nameOf(shown) || 'Someone';
        o.textContent = nm;
        if (shown) o.setAttribute('data-st-name', nm);
        c.appendChild(o);
      }
      for (var i = 0; i < c.options.length; i++) c.options[i].defaultSelected = c.options[i].value === shown;
      c.value = shown;
    } else {
      c.value = shown;
      c.defaultValue = shown;
    }
    return c;
  }

  function conflictMessage(fields) {
    return 'Someone else changed ' + labelList(fields) + ' while you were editing. ' +
      'Your version is still in the box — press Save to replace theirs, or use their version.';
  }

  // The 409 edit_conflict banner. The typed text stays where it is; "Use their
  // version" puts the other person's value in the box and hands the caller the
  // fields so it can move its base.
  function showConflict(root, fields, theirs, onUseTheirs) {
    var box = root && root.querySelector ? root.querySelector('.p86-st-conflict') : null;
    if (!box) return null;
    var keys = (Array.isArray(fields) ? fields : []).filter(function (k) { return typeof k === 'string'; });
    var src = theirs || {};
    box.innerHTML = '<span class="p86-st-conflict-msg">' + esc(conflictMessage(keys)) + '</span> ' +
      '<button type="button" class="p86-st-conflict-use">' + esc(MSG.useTheirs) + '</button>';
    box.hidden = false;
    box.querySelector('.p86-st-conflict-use').addEventListener('click', function () {
      var written = [];
      keys.forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) return;
        var c = setControl(root, k, src[k]);
        if (c) written.push(c);
      });
      box.hidden = true;
      box.innerHTML = '';
      if (typeof onUseTheirs === 'function') onUseTheirs(keys, src);
      // After the caller has moved its base, so a dirty-note listener counts
      // these boxes as saved.
      written.forEach(function (c) {
        try { c.dispatchEvent(new c.ownerDocument.defaultView.Event('input', { bubbles: true })); } catch (e) { /* no events */ }
      });
    });
    return box;
  }

  // 'Unsaved: Scope, Due' — or hidden when nothing is.
  function showDirty(root, keys) {
    var el = root && root.querySelector ? root.querySelector('.p86-st-dirty') : null;
    var list = Array.isArray(keys) ? keys : [];
    if (!el) return list;
    var labels = [];
    list.forEach(function (k) { var l = labelOf(k); if (labels.indexOf(l) === -1) labels.push(l); });
    el.textContent = labels.length ? 'Unsaved: ' + labels.join(', ') : '';
    el.hidden = !labels.length;
    return list;
  }

  function draftNoteHTML(keys) {
    return '<div class="p86-st-draftnote" role="status">Your unsaved changes to ' + esc(labelList(keys)) +
      ' are back in the boxes. <button type="button" class="p86-st-draftnote-discard">Discard them</button></div>';
  }

  // ── People ─────────────────────────────────────────────────────────────
  var _dir = { promise: null, names: {} };
  var ASSIGNEE_TTL_MS = 60000;
  var _eligible = {};

  // The org's staff directory, read once. A failed read is not kept, so the
  // next caller tries again.
  function directory() {
    if (_dir.promise) return _dir.promise;
    var w = win();
    var users = w.p86Api && w.p86Api.users;
    if (!users || typeof users.list !== 'function') return Promise.resolve([]);
    var p = Promise.resolve().then(function () { return users.list(); }).then(function (r) {
      var list = (r && (r.users || r)) || [];
      if (!Array.isArray(list)) list = [];
      var out = [];
      list.forEach(function (u) {
        var id = userId(u && u.id);
        if (!id) return;
        var name = String(u.name || u.email || '').trim();
        if (name) _dir.names[id] = name;
        out.push({ id: Number(id), name: name });
      });
      return out;
    }, function () {
      if (_dir.promise === p) _dir.promise = null;
      return [];
    });
    _dir.promise = p;
    return p;
  }

  function nameOf(id) {
    var k = userId(id);
    return (k && _dir.names[k]) || '';
  }

  function initials(name) {
    var s = String(name == null ? '' : name).trim();
    if (s.indexOf('@') > 0 && !/\s/.test(s)) s = s.slice(0, s.indexOf('@'));
    var LETTER = /[A-Za-z0-9\u00C0-\uD7FF\uE000-\uFFFF]/;
    var words = s.split(/[\s._-]+/).filter(function (x) { return LETTER.test(x); });
    if (!words.length) return '?';
    var first = LETTER.exec(words[0])[0];
    var last = words.length > 1 ? LETTER.exec(words[words.length - 1])[0] : '';
    return (first + last).toUpperCase();
  }

  function parentOf(parent) {
    if (!parent) return null;
    var kind = parent.kind;
    var id = parent.id;
    if (!kind) {
      if (parent.job_id) { kind = 'job'; id = parent.job_id; }
      else if (parent.lead_id) { kind = 'lead'; id = parent.lead_id; }
    }
    if ((kind !== 'job' && kind !== 'lead') || id == null || id === '') return null;
    return { kind: kind, id: String(id) };
  }

  // People who can open this job or lead, cached for a minute per parent. A
  // failed read is dropped from the cache at once.
  function eligibleFor(p) {
    var w = win();
    var st = w.p86Api && w.p86Api.serviceTickets;
    if (!p || !st || typeof st.assignees !== 'function') return Promise.reject(new Error('unavailable'));
    var key = p.kind + ':' + p.id;
    var now = Date.now();
    var hit = _eligible[key];
    if (hit && now - hit.at < ASSIGNEE_TTL_MS) return hit.promise;
    var promise = Promise.resolve().then(function () { return st.assignees(p.kind, p.id); }).then(function (r) {
      var list = (r && (r.users || r)) || [];
      if (!Array.isArray(list)) throw new Error('unreadable');
      var out = [];
      list.forEach(function (u) {
        var id = userId(u && u.id);
        if (id) out.push({ id: id, name: String((u && u.name) || '').trim() });
      });
      return out;
    });
    var entry = { at: now, promise: promise };
    _eligible[key] = entry;
    promise.catch(function () { if (_eligible[key] === entry) delete _eligible[key]; });
    return promise;
  }

  // Rebuilds the Assigned to options: Unassigned, then the current assignee
  // if they are no longer someone who can open the parent, then everyone who
  // can. The current assignee stays the default (so the box reads unchanged)
  // and a choice made while the list was loading is kept. With no list to
  // read, it keeps Unassigned and the current assignee only.
  function fillAssignees(select, parent, currentId) {
    if (!select) return Promise.resolve({ ok: false, users: [] });
    var p = parentOf(parent);
    var word = p && p.kind === 'lead' ? 'lead' : 'job';
    var cur = userId(currentId);
    var listed = eligibleFor(p).then(function (users) {
      return { ok: true, users: users };
    }, function () {
      return { ok: false, users: [] };
    });
    return Promise.all([listed, directory()]).then(function (got) {
      var res = got[0];
      var doc = select.ownerDocument;
      var chosen = select.value;
      var curOpt = cur ? findOption(select, cur) : null;
      var byId = {};
      res.users.forEach(function (u) { byId[u.id] = u; });

      var rows = [{ value: '', text: 'Unassigned', name: '' }];
      if (cur && !(res.ok && byId[cur])) {
        var nm = nameOf(cur) || (curOpt && curOpt.getAttribute('data-st-name')) || 'Someone';
        rows.push({ value: cur, text: res.ok ? nm + " — can't open this " + word : nm, name: nm });
      }
      res.users.forEach(function (u) {
        var name = u.name || nameOf(u.id) || ('User ' + u.id);
        rows.push({ value: u.id, text: name, name: name });
      });

      while (select.options.length) select.remove(0);
      rows.forEach(function (row) {
        var o = doc.createElement('option');
        o.value = row.value;
        o.textContent = row.text;
        if (row.value) o.setAttribute('data-st-name', row.name);
        o.defaultSelected = row.value === cur;
        select.appendChild(o);
      });
      select.value = findOption(select, chosen) ? chosen : cur;
      return { ok: res.ok, users: res.users };
    });
  }

  // Read-only names that were not known when the markup was built. Once the
  // directory has answered (or could not be read), a name it does not have
  // reads 'Someone' rather than loading forever.
  function fillNames(root) {
    return directory().then(function () {
      if (!root || !root.querySelectorAll) return;
      Array.prototype.forEach.call(root.querySelectorAll('[data-st-user][data-st-pending]'), function (el) {
        var name = nameOf(el.getAttribute('data-st-user'));
        el.textContent = name || 'Someone';
        el.removeAttribute('data-st-pending');
      });
    });
  }

  // ── Markup ─────────────────────────────────────────────────────────────
  // A calendar day for reading ('Sep 20, 2026'), never shifted by timezone.
  function dayLabel(v) {
    var d = dateOnly(v);
    if (!d) return '';
    var p = d.split('-');
    var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function metaRow(key, label, html, block) {
    var tag = block ? 'div' : 'span';
    return '<div class="p86-st-meta" data-for="' + esc(key) + '"><span class="p86-st-meta-k">' + esc(label) + '</span>' +
      '<' + tag + ' class="p86-st-meta-v">' + (html == null ? '' : html) + '</' + tag + '></div>';
  }

  function textInput(key, cls, max, placeholder, value, type) {
    return '<input type="' + (type || 'text') + '"' + (type === 'tel' ? ' inputmode="tel"' : '') +
      ' class="' + cls + '" data-st-field="' + key + '"' +
      (max ? ' maxlength="' + max + '"' : '') +
      ' aria-label="' + esc(placeholderLabel(key)) + '"' +
      (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') +
      ' value="' + esc(value == null ? '' : value) + '" />';
  }

  function placeholderLabel(key) {
    return { street_address: 'Street address', city: 'City', state: 'State', zip: 'ZIP' }[key] || labelOf(key);
  }

  function titleFieldHTML(t, canEdit) {
    var tk = t || {};
    return '<label class="p86-st-lbl">Title</label>' +
      (canEdit
        ? textInput('title', 'p86-st-title-in', 300, '', tk.title || '')
        : '<div class="p86-st-ro p86-st-title-ro">' + (tk.title ? esc(tk.title) : '<em>Untitled ticket</em>') + '</div>');
  }

  // Office only. internal_notes is not a crew-link key on the server either;
  // the chip and the help line say so where it is typed.
  function internalNotesHTML(t, canEdit) {
    var tk = t || {};
    return '<div class="p86-st-internalcard">' +
      '<label class="p86-st-lbl">Internal notes <span class="p86-st-office-chip">Office only</span></label>' +
      (canEdit
        ? '<textarea class="p86-st-internal" data-st-field="internal_notes" rows="3" maxlength="10000" aria-label="Internal notes" ' +
            'placeholder="' + esc(MSG.internalPlaceholder) + '">' + esc(tk.internal_notes || '') + '</textarea>' +
          '<div class="p86-st-help">' + esc(MSG.internalHelp) + '</div>'
        : '<div class="p86-st-ro">' + (tk.internal_notes ? esc(tk.internal_notes) : '<em>' + esc(MSG.internalEmpty) + '</em>') + '</div>') +
    '</div>';
  }

  function assigneeHTML(t, canEdit) {
    var cur = userId(t.assignee_user_id);
    var name = cur ? (String(t.assignee_name || '').trim() || nameOf(cur)) : '';
    if (!canEdit) {
      if (!cur) return 'Unassigned';
      return '<span class="p86-st-assignee-ro" data-st-user="' + cur + '"' + (name ? '' : ' data-st-pending="1"') + '>' +
        esc(name || 'Loading name…') + '</span>';
    }
    return '<select class="p86-st-assignee" data-st-field="assignee_user_id" aria-label="Assigned to">' +
      '<option value=""' + (cur ? '' : ' selected') + '>Unassigned</option>' +
      (cur
        ? '<option value="' + cur + '" selected' + (name ? ' data-st-name="' + esc(name) + '"' : '') + '>' + esc(name || 'Loading name…') + '</option>'
        : '') +
    '</select>';
  }

  function priorityHTML(t, canEdit) {
    var cur = displayValue('priority', t.priority);
    if (!canEdit) return esc(PRIORITY_LABEL[cur] || 'Normal');
    return '<select class="p86-st-prio-sel" data-st-field="priority" aria-label="Priority">' +
      PRIORITIES.map(function (p) {
        return '<option value="' + p + '"' + (p === cur ? ' selected' : '') + '>' + esc(PRIORITY_LABEL[p]) + '</option>';
      }).join('') +
    '</select>';
  }

  function dateHTML(t, canEdit, key, cls) {
    if (!canEdit) return esc(dayLabel(t[key]) || '—');
    return '<input type="date" class="' + cls + '" data-st-field="' + key + '" aria-label="' + esc(labelOf(key)) + '"' +
      ' value="' + esc(dateOnly(t[key]) || '') + '" />';
  }

  // A tel: link on the digits before any extension; the text as typed.
  function phoneHTML(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '—';
    var dial = s.split(/\s*(?:ext\.?|x|#|,|;)\s*/i)[0].replace(/[^0-9+]/g, '');
    if (dial.replace(/\D/g, '').length < 7) return esc(s);
    return '<a class="p86-st-tel" href="tel:' + esc(dial) + '">' + esc(s) + '</a>';
  }

  function ownStreet(t) { return !!String((t && t.street_address) || '').trim(); }

  function composeAddress(t) {
    var cityLine = [t.state, t.zip].filter(function (x) { return x && String(x).trim(); }).join(' ');
    return [t.street_address, t.city, cityLine].filter(function (x) { return x && String(x).trim(); }).join(', ');
  }

  // Where the crew link and Navigate send people, and where it comes from.
  function addressLineHTML(t, site, parentWord) {
    var tk = t || {};
    var own = ownStreet(tk);
    var addr = (site && site.address) || (own ? composeAddress(tk) : '');
    var from = own ? 'This work order' : (parentWord === 'lead' ? 'From the lead' : 'From the job');
    return '<div class="p86-st-addr-eff"><span class="p86-st-addr-text">' + esc(addr || '—') + '</span> ' +
      '<small class="p86-st-addr-src">' + from + '</small></div>';
  }

  function addressHTML(t, canEdit, site, word) {
    var own = ownStreet(t);
    var line = sec('addreff', addressLineHTML(t, site, word));
    if (!canEdit) return line;
    return line +
      '<details class="p86-st-addr-edit"' + (own ? ' open' : '') + '>' +
        '<summary>' + (own ? 'Edit the work order address' : 'Use a different address for this work order') + '</summary>' +
        '<div class="p86-st-addr-fields">' +
          textInput('street_address', 'p86-st-addr-in p86-st-addr-street', 300, 'Street address', t.street_address) +
          '<div class="p86-st-addr-row">' +
            textInput('city', 'p86-st-addr-in p86-st-addr-city', 120, 'City', t.city) +
            textInput('state', 'p86-st-addr-in p86-st-addr-state', 60, 'State', t.state) +
            textInput('zip', 'p86-st-addr-in p86-st-addr-zip', 20, 'ZIP', t.zip) +
          '</div>' +
        '</div>' +
        '<div class="p86-st-help">Leave these blank to use the ' + word + '\'s address. ' +
          'The crew link and Navigate use this address.</div>' +
      '</details>';
  }

  function saveAreaHTML() {
    return '<div class="p86-st-savearea">' +
      '<span class="p86-st-dirty" role="status" hidden></span>' +
      '<div class="p86-st-save-err" role="alert" hidden></div>' +
      '<div class="p86-st-conflict" role="alert" hidden></div>' +
    '</div>';
  }

  // The Details panel. Every row carries data-for so the phone grid can place
  // it (css/service-ticket-editor.css). opts.statusHTML, when given, renders
  // the Status row first; otherwise the caller renders it.
  function sideFieldsHTML(t, canEdit, site, parentWord, opts) {
    var tk = t || {};
    var o = opts || {};
    var word = parentWord === 'lead' || parentWord === 'job'
      ? parentWord
      : ((tk.lead_id && !tk.job_id) ? 'lead' : 'job');
    var rows = [];
    if (o.statusHTML != null) rows.push(metaRow('status', 'Status', o.statusHTML));
    rows.push(metaRow('assignee_user_id', 'Assigned to', assigneeHTML(tk, canEdit)));
    rows.push(metaRow('priority', 'Priority', priorityHTML(tk, canEdit)));
    rows.push(metaRow('scheduled_for', 'Scheduled', dateHTML(tk, canEdit, 'scheduled_for', 'p86-st-sched')));
    rows.push(metaRow('due_date', 'Due', dateHTML(tk, canEdit, 'due_date', 'p86-st-due')));
    rows.push(metaRow('site_contact_name', 'Site contact', canEdit
      ? textInput('site_contact_name', 'p86-st-contact', 200, 'Name', tk.site_contact_name)
      : esc(tk.site_contact_name || '—')));
    rows.push(metaRow('site_contact_phone', 'Site phone', canEdit
      ? textInput('site_contact_phone', 'p86-st-phone', 40, '(407) 555-0123', tk.site_contact_phone, 'tel')
      : phoneHTML(tk.site_contact_phone)));
    rows.push(metaRow('access_notes', 'Gate code / access', canEdit
      ? '<textarea class="p86-st-access" data-st-field="access_notes" rows="2" maxlength="1000" aria-label="Gate code / access" ' +
          'placeholder="Gate code, lockbox, where to park">' + esc(tk.access_notes || '') + '</textarea>'
      : (tk.access_notes ? '<div class="p86-st-ro">' + esc(tk.access_notes) + '</div>' : '—'), true));
    rows.push(metaRow('address', 'Address', addressHTML(tk, canEdit, site, word), true));
    return rows.join('') + (canEdit ? saveAreaHTML() : '');
  }

  // ── Sections and scroll ────────────────────────────────────────────────
  function attrValue(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Tags the section's root with data-st-sec. An empty section is an empty
  // <template>: display:none and matched by no class rule, so it leaves no gap
  // in the phone's flex column, and it is still there to be swapped later.
  function sec(key, html) {
    var k = esc(key);
    var s = html == null ? '' : String(html);
    if (!/\S/.test(s)) return '<template data-st-sec="' + k + '"></template>';
    var tagged = false;
    var out = s.replace(/^(\s*<[A-Za-z][A-Za-z0-9-]*)/, function (m) {
      tagged = true;
      return m + ' data-st-sec="' + k + '"';
    });
    return tagged ? out : '<div data-st-sec="' + k + '">' + s + '</div>';
  }

  function findSec(root, key) {
    if (!root || !root.querySelector) return null;
    return root.querySelector('[data-st-sec="' + attrValue(key) + '"]');
  }

  // Replaces one section only when its html changed, then wires the new node.
  // Returns the new node, or null when nothing was swapped.
  function swapSection(root, key, html, cache, wire) {
    var s = html == null ? '' : String(html);
    var c = cache || {};
    if (Object.prototype.hasOwnProperty.call(c, key) && c[key] === s) return null;
    var node = findSec(root, key);
    if (!node || !node.parentNode) return null;
    var tpl = node.ownerDocument.createElement('template');
    tpl.innerHTML = sec(key, s);
    var fresh = tpl.content.firstElementChild;
    if (!fresh) return null;
    node.parentNode.replaceChild(fresh, node);
    c[key] = s;
    if (typeof wire === 'function') {
      try { wire(fresh); } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[p86StEditor] wire ' + key, e);
      }
    }
    return fresh;
  }

  function scrollerOf(el) {
    var doc = el.ownerDocument;
    var view = doc.defaultView;
    var n = el.parentElement;
    while (n && n !== doc.body && n !== doc.documentElement) {
      var oy = '';
      try { oy = view.getComputedStyle(n).overflowY; } catch (e) { oy = ''; }
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return doc.scrollingElement || doc.documentElement;
  }

  function rectOf(el) {
    try { return el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (e) { return null; }
  }

  // The first child still on screen, looking inside a wrapper that has no box
  // of its own (display: contents on the phone layout measures all zero).
  function shownChild(root) {
    var kids = root && root.children;
    if (!kids) return null;
    for (var i = 0; i < kids.length; i++) {
      var r = rectOf(kids[i]);
      if (!r) continue;
      if (!(r.width > 0) && !(r.height > 0)) {
        var inner = shownChild(kids[i]);
        if (inner) return inner;
        continue;
      }
      if (r.bottom > 0) return kids[i];
    }
    return null;
  }

  // With no anchor: the keyed card or section (data-task / data-st-sec) whose
  // top is nearest the top of the screen, among those still on screen. A card
  // is a finer anchor than the grid holding it, whose top does not move when a
  // card above the fold grows; at equal distance the inner one wins. With no
  // keyed box showing, the first child on screen.
  function firstShown(root) {
    if (!root || !root.querySelectorAll) return null;
    var best = null;
    var bestDist = Infinity;
    Array.prototype.forEach.call(root.querySelectorAll('[data-task],[data-st-sec]'), function (el) {
      var r = rectOf(el);
      if (!r || !(r.height > 0) || !(r.bottom > 0)) return;
      var dist = Math.abs(r.top);
      if (dist <= bestDist) { best = el; bestDist = dist; }
    });
    return best || shownChild(root);
  }

  // Runs fn and keeps the anchor where it was on screen. The anchor is
  // re-found by its data-task or data-st-sec key when fn replaced it. With no
  // anchor, the keyed card nearest the top of the screen is used (firstShown).
  // fn may return a promise; the scroll is corrected when it settles.
  function keepScroll(anchor, fn, root) {
    var run = typeof fn === 'function' ? fn : function () {};
    var doc = typeof document !== 'undefined' ? document : null;
    var detail = root || (doc ? doc.querySelector('.p86-st-row.is-open .p86-st-detail') : null);
    var a = (anchor && anchor.nodeType === 1) ? anchor : firstShown(detail);
    if (!a || !a.getBoundingClientRect || !a.ownerDocument) return run();

    var scroller = scrollerOf(a);
    var keyed = a.closest ? a.closest('[data-task],[data-st-sec]') : null;
    var keyAttr = keyed ? (keyed.hasAttribute('data-task') ? 'data-task' : 'data-st-sec') : null;
    var keyVal = keyed ? keyed.getAttribute(keyAttr) : null;
    var topA = a.getBoundingClientRect().top;
    var topK = keyed ? keyed.getBoundingClientRect().top : 0;
    var ownerDoc = a.ownerDocument;

    function settle() {
      var delta = null;
      if (a.isConnected) {
        delta = a.getBoundingClientRect().top - topA;
      } else if (keyed) {
        var again = keyed.isConnected ? keyed : null;
        if (!again) {
          var scope = (detail && detail.isConnected) ? detail : ownerDoc;
          again = scope.querySelector('[' + keyAttr + '="' + attrValue(keyVal) + '"]');
        }
        if (again) delta = again.getBoundingClientRect().top - topK;
      }
      if (delta && isFinite(delta) && scroller) scroller.scrollTop += delta;
    }

    var out = run();
    if (out && typeof out.then === 'function') {
      return out.then(function (v) { settle(); return v; });
    }
    settle();
    return out;
  }

  function _reset() {
    _dir.promise = null;
    _dir.names = {};
    _eligible = {};
  }

  var api = {
    FIELDS: FIELDS,
    PRIORITY_LABEL: PRIORITY_LABEL,
    ASSIGNEE_TTL_MS: ASSIGNEE_TTL_MS,
    titleFieldHTML: titleFieldHTML,
    internalNotesHTML: internalNotesHTML,
    sideFieldsHTML: sideFieldsHTML,
    addressLineHTML: addressLineHTML,
    metaRow: metaRow,
    baseOf: baseOf,
    norm: norm,
    dirtyKeys: dirtyKeys,
    buildPatch: buildPatch,
    labelOf: labelOf,
    labelList: labelList,
    joinList: joinList,
    unsavedExtras: unsavedExtras,
    confirmUnsaved: confirmUnsaved,
    markInvalid: markInvalid,
    clearInvalid: clearInvalid,
    controlOf: controlOf,
    setControl: setControl,
    conflictMessage: conflictMessage,
    showConflict: showConflict,
    showDirty: showDirty,
    draftNoteHTML: draftNoteHTML,
    fillAssignees: fillAssignees,
    fillNames: fillNames,
    directory: directory,
    nameOf: nameOf,
    initials: initials,
    sec: sec,
    swapSection: swapSection,
    keepScroll: keepScroll,
    _reset: _reset
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.p86StEditor = api;
})();
