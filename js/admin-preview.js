// Project 86 — Admin › Their view ("see what they see")
// ------------------------------------------------------------
// John, 2026-10-03: "can you make me a sub view, client view, crew view,
// portal so i can see what they see when they log in? buildertrend has this" —
// and, on how far it should go: "i want this to just be something i can look
// at to see what they are seeing on their end."
//
// So this is a WINDOW, not a session. Nothing on this page signs you in as
// anybody, and nothing on it can write.
//
// IT SHOWS THE REAL PAGE, NOT A DRAWING OF IT. The sub preview is portal.html
// itself in an iframe with ?preview=<subId> — the same markup, the same
// grouping, the same empty states, reading the same projection through
// /api/preview/*. A second page that redrew the portal would drift from it,
// and a preview that quietly differs from the real thing is worse than none:
// the office chases a document the sub already has, or stops chasing one they
// do not.
//
// IT IS ALSO HONEST ABOUT WHAT CANNOT BE SHOWN. Two of the four audiences the
// request named have no login at all — a client never signs in to Project 86,
// and a crew member opens a link with a token in it. The catalogue comes from
// GET /api/preview/audiences and says so on the page rather than offering a
// "client portal" that does not exist.
(function () {
  'use strict';

  var state = { audiences: null, subs: null, chosen: null };

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function get(path) {
    return fetch(path, { credentials: 'include' }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) {
        throw new Error(d.error || ('Request failed (' + r.status + ')'));
      });
      return r.json();
    });
  }

  function audienceCard(a) {
    var ready = a.ready;
    return ''
      + '<div class="p86-prev-aud" data-aud="' + esc(a.key) + '" style="'
      + 'border:1px solid var(--border,#2a2a3a);border-radius:10px;padding:14px;'
      + 'background:var(--card-bg,#141419);' + (ready ? '' : 'opacity:.72;') + '">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">'
      + '<strong style="font-size:14px;">' + esc(a.label) + '</strong>'
      + '<span style="font-size:10px;text-transform:uppercase;letter-spacing:.4px;'
      + 'padding:2px 6px;border-radius:4px;background:rgba(128,128,128,.18);'
      + 'color:var(--text-dim,#888);">' + esc(a.how) + '</span>'
      + (ready ? '' : '<span style="font-size:11px;color:var(--text-dim,#888);">not yet</span>')
      + '</div>'
      + '<div style="font-size:12px;line-height:1.5;color:var(--text-dim,#999);">'
      + esc(a.note) + '</div>'
      + '</div>';
  }

  function subRow(s) {
    // "No portal yet" is the most useful thing this list can say: a sub nobody
    // has invited has nothing to look at, and that is usually the answer to
    // "why can't they see the file I shared".
    var badge = s.hasPortal
      ? '<span style="color:var(--success,#34d399);font-size:11px;">invited</span>'
      : '<span style="color:var(--warning,#d97706);font-size:11px;">no portal yet</span>';
    return ''
      + '<tr data-sub="' + esc(s.id) + '" style="border-bottom:1px solid var(--border,#23232e);">'
      + '<td style="padding:7px 10px 7px 0;font-size:13px;">' + esc(s.name || s.id) + '</td>'
      + '<td style="padding:7px 10px;font-size:12px;color:var(--text-dim,#888);">' + esc(s.trade || '') + '</td>'
      + '<td style="padding:7px 10px;font-size:12px;color:var(--text-dim,#888);white-space:nowrap;">'
      + s.folders + ' folder' + (s.folders === 1 ? '' : 's') + '</td>'
      + '<td style="padding:7px 10px;white-space:nowrap;">' + badge + '</td>'
      + '<td style="padding:7px 0;text-align:right;">'
      + '<button class="secondary" data-prev-sub="' + esc(s.id) + '" style="font-size:12px;padding:4px 10px;">See their portal</button>'
      + '</td></tr>';
  }

  function render() {
    var pane = el('admin-subtab-preview');
    if (!pane) return;

    var auds = state.audiences || [];
    var subs = state.subs || [];

    pane.innerHTML = ''
      + '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;line-height:1.6;">'
      + 'What the people outside your company actually see. This is a window, not a sign-in: '
      + 'you are still yourself, nothing here can be changed, and nobody is notified that you looked.'
      + '</p>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:20px;">'
      + auds.map(audienceCard).join('')
      + '</div>'
      + '<h3 style="font-size:13px;margin:0 0 8px;">Subcontractors</h3>'
      + (subs.length
        ? '<table style="width:100%;border-collapse:collapse;"><tbody>' + subs.map(subRow).join('') + '</tbody></table>'
        : '<div style="color:var(--text-dim,#888);font-size:12px;">No subcontractors yet.</div>')
      + '<div id="p86-prev-stage" style="margin-top:18px;"></div>';

    Array.prototype.forEach.call(pane.querySelectorAll('[data-prev-sub]'), function (b) {
      b.addEventListener('click', function () { openSub(b.getAttribute('data-prev-sub')); });
    });
  }

  // The real portal, framed. Not a redraw of it — see the header.
  function openSub(subId) {
    var stage = el('p86-prev-stage');
    if (!stage) return;
    state.chosen = subId;
    var src = '/portal.html?preview=' + encodeURIComponent(subId);
    stage.innerHTML = ''
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">'
      + '<strong style="font-size:13px;">Their portal</strong>'
      + '<a href="' + esc(src) + '" target="_blank" rel="noopener" '
      + 'style="font-size:12px;color:var(--accent,#22d3ee);">open in a new tab</a>'
      + '<button class="secondary" id="p86-prev-close" style="font-size:12px;padding:3px 9px;margin-left:auto;">Close</button>'
      + '</div>'
      + '<iframe id="p86-prev-frame" src="' + esc(src) + '" '
      + 'style="width:100%;height:620px;border:1px solid var(--border,#2a2a3a);border-radius:10px;background:#fff;"></iframe>';
    var c = el('p86-prev-close');
    if (c) c.addEventListener('click', function () { stage.innerHTML = ''; state.chosen = null; });
    stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderAdminPreview() {
    var pane = el('admin-subtab-preview');
    if (!pane) return;
    pane.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);font-size:13px;">Loading…</div>';
    Promise.all([get('/api/preview/audiences'), get('/api/preview/subs')])
      .then(function (res) {
        state.audiences = (res[0] && res[0].audiences) || [];
        state.subs = (res[1] && res[1].subs) || [];
        render();
      })
      .catch(function (err) {
        pane.innerHTML = '<div style="padding:20px;color:var(--danger,#f87171);font-size:13px;">'
          + 'Could not load: ' + esc(err.message || 'error') + '</div>';
      });
  }

  window.renderAdminPreview = renderAdminPreview;
})();
