// Office photo uploads on a work order — window.p86WorkOrderUploads.
//
// The office side of the Work Orders 1.29 upload queue (js/photo-upload-queue.js,
// the same engine the crew link runs). js/service-tickets.js hands every photo
// picked on a building card to addPhotos; this module sends them one at a time
// and shows how it is going on the card itself:
//
//   addPhotos(card, input, files, ctx{ ticketId, taskId, kind, onLanded, onSettled })
//       Puts the photos in the page's one queue, which sends each through
//       p86Api.attachments.upload('task', taskId, blob, { tags: kind, upload_id }, { signal }).
//       The control that was tapped (card._p86LastTap, set by the host's tile
//       and label clicks, else the input's own label) is marked busy until the
//       building settles. A status line under the photos ("Uploading 2 of 6…",
//       "4 of 6 added. 2 didn't go through." with Retry and Clear) and a head
//       chip ("Uploading 2/6", seen while the card is collapsed) follow each
//       photo; a photo that lands shows as a thumbnail straight away. When the
//       building settles a failure is toasted once and ctx.onSettled() runs
//       once (the host re-reads the work order).
//   decorate(root, ticketId)
//       After any repaint (the host's afterPaint), puts the busy marks, the
//       status line, the chip and not-yet-read thumbnails back on the cards
//       that still have photos in the queue.
//   sitePhotosHTML(photos, esc) / wireSitePhotos(root, photos, ticket)
//       The read-only "Site photos · N" strip in the Scope card: the photos the
//       crew added with their field report. A thumbnail opens the lightbox.
//
// Leaving the page while photos are still going, or failed and not cleared,
// asks first (beforeunload).
//
// It registers with window.p86StExt as 'work-order-uploads' (order 40):
// detailSections gives the 'sitephotos' section in the scopeCard slot and
// afterPaint calls decorate. It writes no app data and fires no hub refresh;
// the only re-read is the host's own, through ctx.onSettled.
(function () {
  'use strict';

  var ONE = 'photo';
  var MANY = 'photos';

  var _queue = null;
  // taskId -> { taskId, ticketId, label, armed, settled, taps: [], onSettled, onLanded }
  var _targets = {};
  var _unloadWired = false;

  function noop() {}

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cssStr(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function warn(what, err) {
    try { console.warn('[work-order-uploads] ' + what, err); } catch (e) { /* nothing */ }
  }

  function toast(msg, kind) {
    var t = window.p86Toast;
    try {
      if (typeof t === 'function') { t(msg, kind); return; }
      if (t && typeof t.show === 'function') { t.show(msg, kind); return; }
    } catch (e) { /* fall through */ }
    if (kind === 'error') warn(msg);
  }

  // An instant (uploaded_at) in the viewer's own zone, with the year only when
  // it is not this year.
  function fmtWhen(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    var o = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    try { return d.toLocaleString(undefined, o); } catch (e) { return ''; }
  }

  function core() {
    var c = window.p86PhotoQueue;
    return (c && typeof c.createQueue === 'function') ? c : null;
  }

  function kindOf(kind) { return kind === 'before' ? 'before' : 'completion'; }
  function keyFor(taskId, kind) { return 'task:' + taskId + ':' + kindOf(kind); }

  // ── The page queue ──────────────────────────────────────────────────────
  function send(item, signal) {
    var t = item.target || {};
    var a = window.p86Api;
    if (!a || !a.attachments || typeof a.attachments.upload !== 'function') {
      var gone = new Error('Reload the page to upload photos.');
      gone.status = 400;
      return Promise.reject(gone);
    }
    return a.attachments.upload('task', t.taskId, item.blob || item.file,
      { tags: t.kind, upload_id: item.uploadId }, { signal: signal }).then(function (json) {
      // A 200 that is not the server's answer (a Wi-Fi sign-in page) did not
      // store anything: retry it under the same upload id.
      if (!json || json.ok !== true) {
        var odd = new Error("That photo didn't reach the server.");
        odd.status = 0;
        throw odd;
      }
      return json;
    }, function (err) {
      if (err && err.status === 200) err.status = 0;
      throw err;
    });
  }

  function queue() {
    if (_queue) return _queue;
    var c = core();
    if (!c) return null;
    _queue = c.createQueue({
      send: send,
      onChange: function (item) { changed(item); },
      onIdle: noop
    });
    wireUnload();
    return _queue;
  }

  function wireUnload() {
    if (_unloadWired || typeof window.addEventListener !== 'function') return;
    _unloadWired = true;
    window.addEventListener('beforeunload', function (e) {
      if (!_queue || !_queue.unsettled()) return undefined;
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  function seqOf(item) {
    return Number(String(item && item.id).replace(/\D/g, '')) || 0;
  }

  // Both kinds of one building in this round, in the order the queue sends
  // them. A round starts when photos are added to a building with nothing
  // going and nothing failed, so "2 photos added." counts the new ones, not
  // the completion photos that settled before a before photo was taken.
  function itemsOf(taskId) {
    if (!_queue) return [];
    var rec = _targets[taskId];
    var floor = (rec && rec.floor) || 0;
    var list = _queue.items(keyFor(taskId, 'completion')).concat(_queue.items(keyFor(taskId, 'before')));
    return list.filter(function (it) { return seqOf(it) > floor; }).sort(function (a, b) {
      return seqOf(a) - seqOf(b);
    });
  }

  // The queue's summary shape, over one building's items.
  function summarize(list) {
    var all = _queue ? _queue.summary() : {};
    var s = {
      total: list.length, done: 0, active: 0, waiting: 0, retrying: 0, failed: 0, refused: 0,
      pausedUntil: all.pausedUntil || 0, offline: !!all.offline, index: 0, refusals: [], skipped: 0
    };
    var activeAt = 0;
    var waitingAt = 0;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.state === 'done') s.done++;
      else if (it.state === 'preparing' || it.state === 'uploading') { s.active++; if (!activeAt) activeAt = i + 1; }
      else if (it.state === 'waiting') { s.waiting++; if (it.attempts > 0) s.retrying++; if (!waitingAt) waitingAt = i + 1; }
      else if (it.state === 'failed') s.failed++;
      else if (it.state === 'refused') {
        s.refused++;
        s.refusals.push({ name: String((it.file && it.file.name) || it.name || 'photo'), message: it.error || '' });
      }
    }
    s.index = activeAt || waitingAt || s.total;
    return s;
  }

  function photoOf(item) {
    var r = item && item.result;
    var att = r && (r.attachment || r.photo);
    if (!att || att.id == null) return null;
    return {
      id: att.id,
      filename: att.filename,
      mime_type: att.mime_type,
      thumb_url: att.thumb_url || att.web_url || '',
      web_url: att.web_url || att.thumb_url || '',
      original_url: att.original_url || att.web_url || '',
      kind: kindOf(item.target && item.target.kind)
    };
  }

  function changed(item) {
    var t = item && item.target;
    if (!t || t.taskId == null) return;
    var taskId = String(t.taskId);
    var rec = _targets[taskId];
    if (!rec) return;
    if (item.state === 'preparing' || item.state === 'waiting' || item.state === 'uploading') {
      // A retry (the button, the signal coming back) is a new round to settle.
      rec.armed = true;
      rec.settled = false;
      rec.repainted = false;
    }
    paintTask(taskId);
    if (item.state === 'done' && typeof rec.onLanded === 'function') {
      var photo = photoOf(item);
      if (photo) { try { rec.onLanded(photo); } catch (e) { warn('onLanded failed', e); } }
    }
    settleIfDone(taskId);
  }

  function failureText(s, label) {
    var bad = s.failed + s.refused;
    var where = label ? ' on ' + label : ' on this building';
    return plural(bad, ONE, MANY) + where + " didn't upload. " +
      (s.failed ? 'Tap Retry on the card.' : 'The card says why.');
  }

  function settleIfDone(taskId) {
    var rec = _targets[taskId];
    if (!rec || !rec.armed) return;
    var s = summarize(itemsOf(taskId));
    if (s.active + s.waiting > 0) return;
    rec.armed = false;
    rec.settled = true;
    rec.taps = [];
    paintTask(taskId);
    if (s.failed + s.refused > 0) toast(failureText(s, rec.label), 'error');
    if (typeof rec.onSettled === 'function') {
      try {
        var p = rec.onSettled();
        if (p && typeof p.then === 'function') p.then(null, function (e) { warn('refresh after upload failed', e); });
      } catch (e) {
        warn('onSettled failed', e);
      }
    }
  }

  // ── Painting a card ─────────────────────────────────────────────────────
  function cardsFor(root, taskId) {
    if (!root || !root.querySelectorAll) return [];
    return Array.prototype.slice.call(root.querySelectorAll('.p86-wo-sub[data-task="' + cssStr(taskId) + '"]'));
  }

  function paintTask(taskId) {
    if (typeof document === 'undefined') return;
    cardsFor(document, taskId).forEach(function (card) { paintCard(card, taskId); });
  }

  // The ids the host already drew on this card from its last read, or null
  // when that read is not reachable from here.
  function serverPhotoIds(card, taskId) {
    var d = card.closest ? card.closest('.p86-st-detail') : null;
    var ctx = d && d._st;
    var task = ctx && ctx.tasksById && ctx.tasksById[taskId];
    if (!task) return null;
    var ids = {};
    (task.photos || []).forEach(function (p) { if (p && p.id != null) ids[String(p.id)] = true; });
    return ids;
  }

  function tapElement(card, tap) {
    if (tap.el && tap.el.isConnected && card.contains(tap.el)) return tap.el;
    var found = null;
    if (tap.tile) {
      Array.prototype.forEach.call(card.querySelectorAll('.p86-wo-addtile'), function (b) {
        if (!found && b.classList.contains('p86-wo-camtile') === (tap.tile === 'cam')) found = b;
      });
    } else if (tap.label) {
      Array.prototype.forEach.call(card.querySelectorAll('.p86-wo-up'), function (l) {
        var inp = l.querySelector('input[type=file]');
        if (!found && inp && inp.getAttribute('data-kind') === tap.label && l.classList.contains('p86-wo-cam') === !!tap.cam) found = l;
      });
    }
    return found;
  }

  function paintBusy(card, rec, busy) {
    var marked = [];
    if (busy && rec) {
      (rec.taps || []).forEach(function (tap) {
        var el = tapElement(card, tap);
        if (el) {
          el.classList.add('is-busy');
          el.setAttribute('aria-busy', 'true');
          marked.push(el);
        }
      });
    }
    Array.prototype.forEach.call(card.querySelectorAll('.p86-wo-addtile.is-busy, .p86-wo-up.is-busy'), function (el) {
      if (marked.indexOf(el) !== -1) return;
      el.classList.remove('is-busy');
      el.removeAttribute('aria-busy');
    });
  }

  function statusHTML(s, busy) {
    var c = core();
    var shown = {};
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) shown[k] = s[k];
    shown.skipped = 0;
    var text = c && typeof c.statusText === 'function' ? c.statusText(shown, { one: ONE, many: MANY }) : '';
    return String(text).split('\n').filter(Boolean).map(function (line) {
      return '<span class="p86-wo-upq-line">' + esc(line) + '</span>';
    }).join('') +
      (s.failed ?'<button type="button" class="p86-wo-upq-btn" data-upq="retry">Retry</button>' : '') +
      ((s.failed + s.refused) ? '<button type="button" class="p86-wo-upq-btn" data-upq="clear">Clear</button>' : '');
  }

  function paintStatus(card, taskId, s, busy, quiet) {
    var body = card.querySelector('.p86-wo-sub-body');
    var line = card.querySelector('.p86-wo-upq');
    if (!body || !s.total || quiet) {
      if (line && line.parentNode) line.parentNode.removeChild(line);
      return;
    }
    if (!line) {
      line = document.createElement('div');
      line.className = 'p86-wo-upq';
      line.setAttribute('role', 'status');
      line.setAttribute('aria-live', 'polite');
      var photos = body.querySelector('.p86-wo-photos');
      if (photos && photos.parentNode === body) body.insertBefore(line, photos.nextSibling);
      else body.insertBefore(line, body.firstChild);
      line.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-upq]') : null;
        if (!b || !_queue) return;
        var what = b.getAttribute('data-upq');
        var keys = [keyFor(taskId, 'completion'), keyFor(taskId, 'before')];
        if (what === 'retry') keys.forEach(function (key) { _queue.retry(key); });
        else if (what === 'clear') keys.forEach(function (key) { _queue.discard(key); });
        paintTask(taskId);
      });
    }
    var bad = !busy && (s.failed + s.refused) > 0;
    line.classList.toggle('is-bad', bad);
    var html = statusHTML(s, busy);
    if (line._p86Html !== html) {
      line._p86Html = html;
      line.innerHTML = html;
    }
  }

  function paintChip(card, s, busy) {
    var meta = card.querySelector('.p86-wo-sub-meta');
    var chip = card.querySelector('.p86-wo-upchip');
    var bad = s.failed + s.refused;
    var text = busy ? 'Uploading ' + s.index + '/' + s.total : (bad ? bad + " didn't upload" : '');
    if (!meta || !text) {
      if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
      return;
    }
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'p86-wo-upchip';
      meta.insertBefore(chip, meta.firstChild);
    }
    chip.classList.toggle('is-bad', !busy && bad > 0);
    if (chip.textContent !== text) chip.textContent = text;
  }

  function thumbFor(photo) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'p86-wo-thumb is-new';
    b.setAttribute('data-landed', String(photo.id));
    b.title = (photo.kind === 'before' ? 'Before' : 'Completion') + ' photo, just added';
    b.innerHTML = '<img src="' + esc(photo.thumb_url) + '" alt="" loading="lazy" />' +
      '<span class="p86-wo-kind k-' + (photo.kind === 'before' ? 'before' : 'after') + '">' +
      (photo.kind === 'before' ? 'Before' : 'Done') + '</span>';
    b.addEventListener('click', function () {
      var lb = window.p86Attachments;
      if (lb && typeof lb.openLightbox === 'function') lb.openLightbox([photo], 0, { parentLabel: 'Just added' });
    });
    return b;
  }

  function paintLanded(card, taskId, list, rec) {
    var grid = card.querySelector('.p86-wo-photos');
    if (!grid) return;
    var server = serverPhotoIds(card, taskId);
    // Once the building has settled and nothing on the card can say whether the
    // host has read these photos back, the host's own thumbnails are trusted.
    if (!server && rec && rec.settled) return;
    list.forEach(function (item) {
      if (item.state !== 'done') return;
      var photo = photoOf(item);
      if (!photo) return;
      if (server && server[String(photo.id)]) return;
      if (grid.querySelector('[data-landed="' + cssStr(photo.id) + '"]')) return;
      var none = grid.querySelector('.p86-wo-nophotos');
      if (none && none.parentNode) none.parentNode.removeChild(none);
      var tile = grid.querySelector('.p86-wo-addtile');
      grid.insertBefore(thumbFor(photo), tile && tile.parentNode === grid ? tile : null);
    });
  }

  function paintCard(card, taskId) {
    var rec = _targets[taskId];
    var list = itemsOf(taskId);
    var s = summarize(list);
    var busy = s.active + s.waiting > 0;
    // After a building settles with nothing wrong and the host has drawn it
    // again, its photos are on the card from the server: the line has said
    // what it had to.
    var quiet = !busy && (s.failed + s.refused) === 0 && !!(rec && rec.settled && rec.repainted);
    paintBusy(card, rec, busy);
    paintStatus(card, taskId, s, busy, quiet);
    paintChip(card, s, busy);
    paintLanded(card, taskId, list, rec);
  }

  // ── Public ──────────────────────────────────────────────────────────────
  function labelOf(card) {
    var n = card && card.querySelector ? card.querySelector('.p86-wo-sub-name') : null;
    return n ? String(n.textContent || '').trim() : '';
  }

  function tapOf(card, input, kind) {
    var el = card && card._p86LastTap;
    if (el && el.classList && card.contains(el)) {
      if (el.classList.contains('p86-wo-addtile')) {
        if (kind === 'completion') return { el: el, tile: el.classList.contains('p86-wo-camtile') ? 'cam' : 'lib' };
      } else if (el.classList.contains('p86-wo-up')) {
        var own = el.querySelector('input[type=file]');
        if (!input || own === input) return labelTap(el);
      }
    }
    var lab = input && input.parentNode;
    if (lab && lab.nodeType === 1) {
      return lab.classList.contains('p86-wo-up') ? labelTap(lab) : { el: lab };
    }
    return null;
  }

  function labelTap(lab) {
    var inp = lab.querySelector('input[type=file]');
    return { el: lab, label: inp ? inp.getAttribute('data-kind') : '', cam: lab.classList.contains('p86-wo-cam') };
  }

  function addPhotos(card, input, files, ctx) {
    var c = ctx || {};
    var list = Array.prototype.slice.call(files || []).filter(Boolean);
    if (!list.length) return { added: 0, skipped: 0 };
    var q = queue();
    if (!q) {
      toast('Reload the page to upload photos.', 'error');
      return { added: 0, skipped: 0 };
    }
    var taskId = c.taskId != null ? String(c.taskId) : String((card && card.getAttribute && card.getAttribute('data-task')) || '');
    var kind = kindOf(c.kind || (input && input.getAttribute && input.getAttribute('data-kind')));
    var rec = _targets[taskId] || (_targets[taskId] = { taskId: taskId, taps: [] });
    if (c.ticketId != null) rec.ticketId = String(c.ticketId);
    rec.label = labelOf(card) || rec.label || '';
    if (typeof c.onSettled === 'function') rec.onSettled = c.onSettled;
    if (typeof c.onLanded === 'function') rec.onLanded = c.onLanded;
    var tap = tapOf(card, input, kind);
    if (card) card._p86LastTap = null;
    var tapsBefore = rec.taps.slice();
    var floorBefore = rec.floor || 0;
    var now = itemsOf(taskId);
    var was = summarize(now);
    if (now.length && was.active + was.waiting + was.failed === 0) {
      rec.floor = Math.max.apply(null, now.map(seqOf));
    }
    if (tap) rec.taps.push(tap);
    var repaintedBefore = rec.repainted;
    rec.repainted = false;
    var res = q.add(list, { key: keyFor(taskId, kind), ticketId: rec.ticketId, taskId: taskId, kind: kind });
    if (!res.added) {
      rec.taps = tapsBefore;
      rec.floor = floorBefore;
      rec.repainted = repaintedBefore;
      paintTask(taskId);
    }
    if (res.skipped) toast('Skipped ' + plural(res.skipped, ONE, MANY) + ' already uploaded.');
    return res;
  }

  function decorate(root, ticketId) {
    if (!_queue || !root || !root.querySelectorAll) return;
    Object.keys(_targets).forEach(function (taskId) {
      var rec = _targets[taskId];
      if (ticketId != null && rec.ticketId != null && String(rec.ticketId) !== String(ticketId)) return;
      var cards = cardsFor(root, taskId);
      if (!cards.length) return;
      if (rec.settled) rec.repainted = true;
      cards.forEach(function (card) { paintCard(card, taskId); });
    });
  }

  function sitePhotosHTML(photos, escFn) {
    var e = typeof escFn === 'function' ? escFn : esc;
    var list = Array.isArray(photos) ? photos : [];
    if (!list.length) return '';
    return '<div class="p86-wo-sitephotos-sec">' +
      '<label class="p86-st-lbl">' + e('Site photos · ' + list.length) + '</label>' +
      '<div class="p86-wo-photos p86-wo-sitephotos">' +
        list.map(function (p, i) {
          var ph = p || {};
          var by = ph.by ? String(ph.by) : '';
          var when = fmtWhen(ph.uploaded_at);
          var title = [by, when].filter(Boolean).join(' · ');
          var alt = 'Photo' + (by ? ' by ' + by : '') + (when ? ', ' + when : '');
          return '<button type="button" class="p86-wo-thumb" data-idx="' + i + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
            '<img src="' + esc(ph.thumb_url || ph.web_url || '') + '" alt="' + esc(alt) + '" loading="lazy" />' +
          '</button>';
        }).join('') +
      '</div>' +
    '</div>';
  }

  function wireSitePhotos(root, photos, ticket) {
    if (!root || typeof root.addEventListener !== 'function') return;
    root._p86SitePhotos = Array.isArray(photos) ? photos : [];
    root._p86SiteTicket = ticket || null;
    if (root._p86SiteWired) return;
    root._p86SiteWired = true;
    root.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.p86-wo-sitephotos [data-idx]') : null;
      if (!b || !root.contains(b)) return;
      var list = root._p86SitePhotos || [];
      var lb = window.p86Attachments;
      if (!list.length || !lb || typeof lb.openLightbox !== 'function') return;
      var t = root._p86SiteTicket || {};
      lb.openLightbox(list, Number(b.getAttribute('data-idx')) || 0, {
        parentLabel: 'Site photos',
        parentSubtitle: t.title || ''
      });
    });
  }

  function sitePhotosOf(ctx) {
    return (ctx && ctx.r && Array.isArray(ctx.r.site_photos)) ? ctx.r.site_photos : [];
  }

  var extension = {
    order: 40,
    detailSections: function (ctx) {
      return [{
        key: 'sitephotos',
        slot: 'scopeCard',
        html: sitePhotosHTML(sitePhotosOf(ctx), esc),
        wire: function (node, c) {
          var cx = c || ctx;
          wireSitePhotos(node, sitePhotosOf(cx), cx && cx.t);
        }
      }];
    },
    afterPaint: function (d, ctx) {
      decorate(d, ctx && ctx.ticketId);
      // A read that draws the same strip keeps its node: give it the new list.
      var node = d && d.querySelector ? d.querySelector('[data-st-sec="sitephotos"]') : null;
      if (node && node._p86SiteWired) {
        node._p86SitePhotos = sitePhotosOf(ctx);
        node._p86SiteTicket = (ctx && ctx.t) || node._p86SiteTicket;
      }
    }
  };

  window.p86WorkOrderUploads = {
    addPhotos: addPhotos,
    decorate: decorate,
    sitePhotosHTML: sitePhotosHTML,
    wireSitePhotos: wireSitePhotos,
    extension: extension
  };

  // The registry normally loads first. If this tag ever lands ahead of it,
  // try again once the page has parsed (registering twice replaces).
  function register() {
    var ext = window.p86StExt;
    if (!ext || typeof ext.register !== 'function') return false;
    return ext.register('work-order-uploads', extension);
  }
  if (!register() && typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', register);
  }
})();
