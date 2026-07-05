// Guided tours — window.p86Guide.
//
// An interactive walkthrough engine: each tour is an ordered list of
// steps; a step can navigate (switchTab etc.), then spotlights a real
// element on screen with a dimmed backdrop + a tooltip card (title,
// body, Back / Next). Steps whose anchor never becomes visible are
// SKIPPED silently — that's what makes one tour definition work on
// both desktop (sidebar anchors) and mobile (bottom-nav anchors):
// list both selectors and whichever is visible wins.
//
// Registry shape:
//   TOURS[id] = {
//     title, blurb, icon,        // shown on Help center Guides cards
//     steps: [{
//       go:    optional fn run before locating the anchor (navigation)
//       sel:   optional CSS selector (comma list OK — first VISIBLE
//              match wins). Omit for a centered text-only step.
//       title, body
//     }]
//   }
//
// Launched from the Help center ("Show me" on patch notes + Guides
// tab) via p86Guide.start(id). Esc or ✕ exits at any point.

(function () {
  'use strict';

  var TOURS = {
    'welcome': {
      title: 'Get your bearings',
      blurb: 'The 2-minute lap: home base, navigation, and the buttons you\'ll press every day.',
      icon: 'map-pin',
      steps: [
        {
          title: 'Welcome to Project 86',
          body: 'This quick lap shows you home base and the everyday controls. Use Next / Back, or Esc to bail anytime.'
        },
        {
          go: function () { if (typeof window.switchTab === 'function') window.switchTab('summary'); },
          sel: '#summary-root',
          title: 'The Summary is home',
          body: 'Everything that needs your attention lands here — overdue money, open leads, pending estimates, and the live map of your whole pipeline.'
        },
        {
          sel: '.app-nav, #p86-mobile-nav',
          title: 'The nav is the map of the app',
          body: 'Sales up top (Leads, Estimates), Operations in the middle (Jobs, Schedule, Cost Inbox), and Directory below. On a phone, the bottom bar covers the big five.'
        },
        {
          sel: '#header-quickadd-btn, #p86-mobile-nav',
          title: 'Create anything from anywhere',
          body: 'The + button opens quick-create: new lead, task, reminder, event, or scan a receipt — without leaving the page you\'re on.'
        },
        {
          sel: '#header-notif-btn',
          title: 'Notifications live here',
          body: 'Mentions, assignments, reminders, and finished AI work. You can also get these on your phone — see My Account → Notifications.'
        },
        {
          sel: '#header-ask86-btn, #p86-mobile-nav [data-mobile-nav="ask86"]',
          title: 'And this is the big one',
          body: 'Ask 86 — your AI crew. Ask questions in plain English, have it make changes, or hand it a whole background job. There\'s a separate guide just for the crew.'
        }
      ]
    },

    'ai-crew': {
      title: 'Meet your AI crew',
      blurb: 'Assistant, 86, and the Scribe — who does what, and how background work comes back to you.',
      icon: 'dna-86',
      steps: [
        {
          title: 'You have a crew, not a chatbot',
          body: 'Three teammates: your Assistant hosts the conversation, 86 is the deep expert it escalates to, and the Scribe writes the actual records. They hand work between each other automatically.'
        },
        {
          sel: '#header-ask86-btn, #p86-mobile-nav [data-mobile-nav="ask86"]',
          title: 'One door for everything',
          body: 'Open the chat and just talk: "what\'s slipping this week?", "draft a PO for the fence sub", "remind me Friday at 7". Reads are instant; anything that writes data shows you a card to approve first.'
        },
        {
          sel: '#p86CrewChip',
          title: 'The crew chip shows who\'s working',
          body: 'Watch it narrate in real time — Assistant thinking, 86 digging, Scribe drafting. Idle means everyone\'s ready.'
        },
        {
          sel: '#ai-crew-activity, #header-ask86-btn, #p86-mobile-nav [data-mobile-nav="ask86"]',
          title: 'Background work lives in Crew activity',
          body: 'Hand off something big ("audit all my job costs in the background") and close the app. Open the 86 chat and tap the Crew activity button in its header — running tasks, questions waiting on you, and Scribe drafts to approve.'
        },
        {
          title: 'It pings you when it matters',
          body: 'Finished tasks, questions, and ready drafts land in your chat AND as phone/desktop pushes. Turn channels on per event under My Account → Notifications.'
        }
      ]
    },

    'lead-to-job': {
      title: 'From lead to sold job',
      blurb: 'Track a lead, estimate it, and convert the win into a job with one click.',
      icon: 'leads',
      steps: [
        {
          go: function () {
            if (typeof window.switchTab === 'function') window.switchTab('estimates');
            if (typeof window.switchEstimatesSubTab === 'function') window.switchEstimatesSubTab('leads');
            if (typeof window.markVirtualTabActive === 'function') window.markVirtualTabActive('leads');
          },
          sel: '#leads-list-view',
          title: 'The pipeline lives in Leads',
          body: 'Every opportunity with status, value, confidence, and follow-up date. Filter, save views, bulk-update, or see them all on the map.'
        },
        {
          sel: '.leads-row, .leads-list-row, #leads-list-view',
          title: 'Open a lead to work it',
          body: 'Inside: the full sales pipeline (confidence, projected sale date), site details, photos, weather, and attached estimates under the Proposals tab.'
        },
        {
          title: 'Estimates attach to the lead',
          body: 'Draft estimates from the lead\'s Estimates tab. When one\'s accepted, mark it — the lead\'s value tracks the highest attached estimate automatically.'
        },
        {
          title: 'Win it? One click makes the job',
          body: 'The "Create Job" button on the lead converts it: the contract pulls the estimate total, pre-sale costs carry forward, the estimate locks as sold, and the job links back to its source.'
        }
      ]
    },

    'receipts': {
      title: 'Capture a receipt',
      blurb: 'Snap it, let AI read it, and watch the cost roll up on the job.',
      icon: 'materials',
      steps: [
        {
          go: function () { if (typeof window.switchTab === 'function') window.switchTab('cost-inbox'); },
          sel: '#cost-inbox',
          title: 'The Cost Inbox catches field spend',
          body: 'Every receipt in one filterable list — vendor, amount, cost code, and the job or lead it belongs to.'
        },
        {
          title: 'Capture is camera-first',
          body: 'Tap capture (or header + → Scan Receipt), point at the receipt, and the AI reads the vendor and total for you — you just confirm and pick the cost code. It flags anything it wasn\'t sure about.'
        },
        {
          title: 'Costs flow to the job on their own',
          body: 'Tagged receipts roll up on the job\'s WIP tab by cost code — and receipts captured on a lead carry forward when it converts to a job.'
        }
      ]
    },

    'map-cards': {
      title: 'Work the map',
      blurb: 'Pins, cards, and the magnifier — the same language on every map in the app.',
      icon: 'globe',
      steps: [
        {
          go: function () {
            if (typeof window.switchTab === 'function') window.switchTab('summary');
            // On phones the Command-center workspace defaults to the Today
            // segment — the map lives in Money, so flip to it.
            if (typeof window.p86CmdSeg === 'function') { try { window.p86CmdSeg('money'); } catch (e) {} }
          },
          sel: '#summaryMapHost',
          title: 'Your pipeline on one map',
          body: 'Every geocoded lead and job is a pin; multiple records at one property group into a numbered pin. The chips toggle leads and jobs layers.'
        },
        {
          title: 'First tap opens the card',
          body: 'Tapping a pin opens its info card — status, value, address, and actions. The map holds still; nothing zooms until you ask.'
        },
        {
          title: 'The magnifier is the zoom',
          body: 'Every card has a 🔍 button — that\'s the deliberate fly-in when you want a closer look. "Open" jumps to the actual record, "Maps" launches Google Maps for directions.'
        }
      ]
    }
  };

  // ── Engine ─────────────────────────────────────────────────────
  var _active = null; // { tour, idx, token, els: {layer, spot, tip}, onKey, onReflow }
  var _token = 0;     // run epoch — invalidates in-flight waitFor polls on stop/start

  function ensureStyle() {
    if (document.getElementById('p86-guide-css')) return;
    var st = document.createElement('style');
    st.id = 'p86-guide-css';
    st.textContent =
      '.p86-guide-layer{position:fixed;inset:0;z-index:1200;}' +
      '.p86-guide-block{position:absolute;inset:0;}' + // eats clicks outside the tip
      '.p86-guide-spot{position:absolute;border-radius:10px;pointer-events:none;' +
        'box-shadow:0 0 0 200vmax rgba(5,8,14,.74);border:1.5px solid rgba(96,165,250,.85);' +
        'transition:top .28s ease,left .28s ease,width .28s ease,height .28s ease,opacity .2s ease;}' +
      '.p86-guide-spot.p86-guide-none{opacity:0;box-shadow:0 0 0 200vmax rgba(5,8,14,.74);}' +
      '.p86-guide-tip{position:absolute;width:min(340px,calc(100vw - 28px));background:#11151f;' +
        'border:1px solid rgba(255,255,255,.14);border-radius:13px;box-shadow:0 14px 40px rgba(0,0,0,.6);' +
        'padding:14px 16px 12px;color:#e5e9f2;font-size:13px;line-height:1.5;transition:top .28s ease,left .28s ease;}' +
      '.p86-guide-tip-step{font-size:10px;font-weight:800;letter-spacing:.08em;color:#60a5fa;text-transform:uppercase;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;}' +
      '.p86-guide-tip-x{background:none;border:none;color:#8b93a7;font-size:15px;cursor:pointer;padding:0 2px;line-height:1;}' +
      '.p86-guide-tip-title{font-size:14.5px;font-weight:700;color:#fff;margin-bottom:5px;}' +
      '.p86-guide-tip-body{font-size:12.5px;color:#b6bdcd;}' +
      '.p86-guide-tip-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;}' +
      '.p86-guide-btn{border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;' +
        'background:none;border:1px solid rgba(255,255,255,.18);color:#aeb6c5;}' +
      '.p86-guide-btn.primary{background:#2f6fed;border-color:#2f6fed;color:#fff;}';
    document.head.appendChild(st);
  }

  // "Visible" = rendered with real size (display:none collapses to a zero
  // rect — that's how one selector list serves desktop + mobile variants).
  // Deliberately NOT viewport-bound: a below-the-fold anchor is fine,
  // position() scrolls it into view.
  function firstVisible(sel) {
    if (!sel) return null;
    var parts = sel.split(',');
    for (var i = 0; i < parts.length; i++) {
      var els;
      try { els = document.querySelectorAll(parts[i].trim()); } catch (e) { continue; }
      for (var j = 0; j < els.length; j++) {
        var r = els[j].getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return els[j];
      }
    }
    return null;
  }

  function waitFor(sel, cb) {
    var tries = 0;
    (function poll() {
      var el = firstVisible(sel);
      if (el) return cb(el);
      if (++tries > 20) return cb(null); // ~3s then give up (step skips)
      setTimeout(poll, 150);
    })();
  }

  function position(el, scroll) {
    if (!_active) return;
    var spot = _active.els.spot, tip = _active.els.tip;
    var pad = 6;
    if (el) {
      // Only scroll on the step's first paint — reflow repositions (user
      // scroll / resize) must not fight the user's own scrolling.
      if (scroll) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }
      var r = el.getBoundingClientRect();
      spot.classList.remove('p86-guide-none');
      spot.style.top = (r.top - pad) + 'px';
      spot.style.left = (r.left - pad) + 'px';
      spot.style.width = (r.width + pad * 2) + 'px';
      spot.style.height = (r.height + pad * 2) + 'px';
      // Tooltip below the target if there's room, else above, else centered.
      var th = tip.offsetHeight || 150, tw = tip.offsetWidth || 340;
      var top = r.bottom + 14;
      if (top + th > window.innerHeight - 12) top = r.top - th - 14;
      if (top < 12) top = Math.max(12, (window.innerHeight - th) / 2);
      var left = r.left + r.width / 2 - tw / 2;
      left = Math.max(14, Math.min(left, window.innerWidth - tw - 14));
      tip.style.top = top + 'px';
      tip.style.left = left + 'px';
    } else {
      spot.classList.add('p86-guide-none');
      spot.style.top = '50%'; spot.style.left = '50%'; spot.style.width = '0px'; spot.style.height = '0px';
      var th2 = tip.offsetHeight || 150, tw2 = tip.offsetWidth || 340;
      tip.style.top = Math.max(12, (window.innerHeight - th2) / 2) + 'px';
      tip.style.left = Math.max(14, (window.innerWidth - tw2) / 2) + 'px';
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderStep(el) {
    if (!_active) return;
    var t = _active.tour, i = _active.idx, step = t.steps[i];
    var tip = _active.els.tip;
    tip.innerHTML =
      '<div class="p86-guide-tip-step"><span>' + esc(t.title) + ' · ' + (i + 1) + ' / ' + t.steps.length + '</span>' +
        '<button type="button" class="p86-guide-tip-x" aria-label="End tour">✕</button></div>' +
      '<div class="p86-guide-tip-title">' + esc(step.title) + '</div>' +
      '<div class="p86-guide-tip-body">' + esc(step.body) + '</div>' +
      '<div class="p86-guide-tip-btns">' +
        (i > 0 ? '<button type="button" class="p86-guide-btn" data-nav="back">Back</button>' : '') +
        '<button type="button" class="p86-guide-btn primary" data-nav="next">' + (i === t.steps.length - 1 ? 'Done' : 'Next') + '</button>' +
      '</div>';
    tip.querySelector('.p86-guide-tip-x').addEventListener('click', stop);
    var back = tip.querySelector('[data-nav="back"]');
    if (back) back.addEventListener('click', function () { show(i - 1, -1); });
    tip.querySelector('[data-nav="next"]').addEventListener('click', function () {
      if (i === t.steps.length - 1) stop(); else show(i + 1, 1);
    });
    _active.anchor = el || null;
    position(el, true);
  }

  // dir: +1 forward, -1 back — a step whose anchor is missing skips in
  // the SAME direction so Back never bounces you forward again.
  function show(idx, dir) {
    if (!_active) return;
    var t = _active.tour, token = _active.token;
    if (idx < 0) idx = 0;
    if (idx >= t.steps.length) return stop();
    _active.idx = idx;
    var step = t.steps[idx];
    try { if (typeof step.go === 'function') step.go(); } catch (e) {}
    if (!step.sel) return renderStep(null);
    waitFor(step.sel, function (el) {
      // token guards against a stale wait surviving a stop()+start() of a
      // DIFFERENT tour that happens to sit on the same step index.
      if (!_active || _active.token !== token || _active.idx !== idx) return;
      if (el) return renderStep(el);
      // Anchor never showed (hidden on this device / not built) → skip.
      var next = idx + (dir || 1);
      if (next < 0 || next >= t.steps.length) return stop();
      show(next, dir || 1);
    });
  }

  function start(id) {
    var tour = TOURS[id];
    if (!tour) return false;
    stop();
    ensureStyle();
    var layer = document.createElement('div');
    layer.className = 'p86-guide-layer';
    layer.innerHTML = '<div class="p86-guide-block"></div><div class="p86-guide-spot p86-guide-none"></div><div class="p86-guide-tip"></div>';
    document.body.appendChild(layer);
    var onKey = function (e) { if (e.key === 'Escape') stop(); };
    var onReflow = function () { if (_active) position(_active.anchor || null); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    _active = {
      tour: tour, idx: 0, anchor: null, token: ++_token,
      els: { layer: layer, spot: layer.querySelector('.p86-guide-spot'), tip: layer.querySelector('.p86-guide-tip') },
      onKey: onKey, onReflow: onReflow
    };
    show(0, 1);
    try { localStorage.setItem('p86-tour-seen-' + id, new Date().toISOString()); } catch (e) {}
    return true;
  }

  function stop() {
    if (!_active) return;
    document.removeEventListener('keydown', _active.onKey);
    window.removeEventListener('resize', _active.onReflow);
    window.removeEventListener('scroll', _active.onReflow, true);
    if (_active.els.layer.parentNode) _active.els.layer.parentNode.removeChild(_active.els.layer);
    _active = null;
  }

  function list() {
    return Object.keys(TOURS).map(function (id) {
      var t = TOURS[id];
      return { id: id, title: t.title, blurb: t.blurb, icon: t.icon || 'map-pin', steps: t.steps.length };
    });
  }

  window.p86Guide = { start: start, stop: stop, list: list, has: function (id) { return !!TOURS[id]; } };
})();
