// Background Tasks — the user-facing surface for agent_jobs (background-tasks plan).
//
// A small floating launcher (appears only when there are active or unseen tasks)
// opens a panel listing the user's background tasks with status + result. Polls
// /api/agent-jobs for the badge. Fully self-contained (injects its own DOM + CSS),
// so it touches nothing in the header/nav layout. Answering a needs_input task from
// here lands in S5; for now the panel points the user at their 86 chat.
(function () {
  'use strict';
  if (window.p86AgentTasks) return;

  var POLL_MS = 20000;
  var _jobs = [];
  var _attention = 0;
  var _timer = null;
  var _panelOpen = false;

  function apiGet(path) {
    if (window.p86Api && window.p86Api.get) return window.p86Api.get('/api/agent-jobs' + path);
    return fetch('/api/agent-jobs' + path, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }
  function apiPost(path, body) {
    if (window.p86Api && window.p86Api.post) return window.p86Api.post('/api/agent-jobs' + path, body || {});
    return fetch('/api/agent-jobs' + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }

  function statusMeta(s) {
    switch (s) {
      case 'queued':      return { label: 'Queued',    color: '#8b90a5' };
      case 'running':     return { label: 'Working…',  color: '#4f8cff' };
      case 'needs_input': return { label: 'Needs you', color: '#fbbf24' };
      case 'done':        return { label: 'Done',      color: '#34d399' };
      case 'failed':      return { label: 'Failed',    color: '#f87171' };
      case 'canceled':    return { label: 'Canceled',  color: '#8b90a5' };
      default:            return { label: s || '—',    color: '#8b90a5' };
    }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById('p86-agent-tasks-css')) return;
    var st = document.createElement('style'); st.id = 'p86-agent-tasks-css';
    st.textContent = [
      '.p86-bgt-launch{position:fixed;right:18px;bottom:90px;z-index:9000;display:none;align-items:center;gap:8px;background:#141824;color:#e6e9f0;border:1px solid rgba(255,255,255,.16);border-radius:22px;padding:9px 14px;font:600 13px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.45)}',
      '.p86-bgt-launch:hover{background:#1c2130}',
      '.p86-bgt-launch.on{display:inline-flex}',
      '.p86-bgt-dot{width:8px;height:8px;border-radius:50%;background:#4f8cff}',
      '.p86-bgt-badge{background:#fbbf24;color:#1a1400;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:800}',
      '.p86-bgt-overlay{position:fixed;inset:0;z-index:9001;background:rgba(4,6,12,.5);display:none;align-items:flex-end;justify-content:flex-end}',
      '.p86-bgt-overlay.on{display:flex}',
      '.p86-bgt-panel{margin:0 16px 16px 0;width:min(440px,calc(100vw - 32px));max-height:min(72vh,660px);display:flex;flex-direction:column;background:#0f1320;border:1px solid rgba(255,255,255,.14);border-radius:14px;overflow:hidden;box-shadow:0 12px 44px rgba(0,0,0,.6)}',
      '.p86-bgt-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid rgba(255,255,255,.08);color:#e6e9f0;font:700 14px/1 system-ui,sans-serif}',
      '.p86-bgt-x{background:none;border:none;color:#9aa0b2;font-size:18px;cursor:pointer;line-height:1}',
      '.p86-bgt-list{overflow:auto;padding:8px}',
      '.p86-bgt-item{border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:11px 12px;margin-bottom:8px;background:#141824}',
      '.p86-bgt-t{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#e6e9f0;font:600 13px/1.3 system-ui,sans-serif}',
      '.p86-bgt-pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;white-space:nowrap}',
      '.p86-bgt-body{margin-top:7px;color:#aeb4c4;font:400 12px/1.5 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word}',
      '.p86-bgt-q{margin-top:7px;color:#fbbf24;font:600 12px/1.5 system-ui,sans-serif}',
      '.p86-bgt-empty{color:#8b90a5;text-align:center;padding:30px 14px;font:400 13px/1.6 system-ui,sans-serif}'
    ].join('');
    document.head.appendChild(st);
  }

  function ensureDom() {
    ensureStyle();
    if (document.querySelector('.p86-bgt-launch')) return;
    var b = document.createElement('button');
    b.className = 'p86-bgt-launch';
    b.innerHTML = '<span class="p86-bgt-dot"></span><span class="p86-bgt-txt">Background tasks</span><span class="p86-bgt-badge" style="display:none"></span>';
    b.addEventListener('click', open);
    document.body.appendChild(b);
    var ov = document.createElement('div');
    ov.className = 'p86-bgt-overlay';
    ov.innerHTML = '<div class="p86-bgt-panel"><div class="p86-bgt-head"><span>Background tasks</span><button class="p86-bgt-x" title="Close">✕</button></div><div class="p86-bgt-list"></div></div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('.p86-bgt-x').addEventListener('click', close);
    document.body.appendChild(ov);
  }

  function renderLauncher() {
    var b = document.querySelector('.p86-bgt-launch'); if (!b) return;
    var active = _jobs.filter(function (j) { return j.status === 'running' || j.status === 'queued' || j.status === 'needs_input'; }).length;
    b.classList.toggle('on', active > 0 || _attention > 0);
    var badge = b.querySelector('.p86-bgt-badge');
    if (_attention > 0) { badge.style.display = ''; badge.textContent = _attention; }
    else { badge.style.display = 'none'; }
    var running = _jobs.filter(function (j) { return j.status === 'running'; }).length;
    b.querySelector('.p86-bgt-txt').textContent = running ? (running + ' running…') : 'Background tasks';
  }

  function renderPanel() {
    var list = document.querySelector('.p86-bgt-list'); if (!list) return;
    if (!_jobs.length) {
      list.innerHTML = '<div class="p86-bgt-empty">No background tasks yet.<br>Ask 86 or the assistant to take on something bigger, or say “do this in the background.”</div>';
      return;
    }
    list.innerHTML = _jobs.map(function (j) {
      var m = statusMeta(j.status);
      var pill = '<span class="p86-bgt-pill" style="background:' + m.color + '22;color:' + m.color + '">' + esc(m.label) + '</span>';
      var body = '';
      if (j.status === 'needs_input' && j.pause_question) {
        body = '<div class="p86-bgt-q">❓ ' + esc(j.pause_question) +
          '<br><span style="color:#8b90a5;font-weight:400">Answering from here is coming shortly — for now, reply in your 86 chat.</span></div>';
      } else if (j.status === 'done' && j.result) {
        body = '<div class="p86-bgt-body">' + esc(j.result) + '</div>';
      } else if (j.status === 'failed' && j.error) {
        body = '<div class="p86-bgt-body" style="color:#f87171">' + esc(j.error) + '</div>';
      } else if (j.status === 'running' || j.status === 'queued') {
        body = '<div class="p86-bgt-body">' + esc((j.prompt || '').slice(0, 160)) + '</div>';
      }
      return '<div class="p86-bgt-item"><div class="p86-bgt-t"><span>' + esc(j.title || 'Task') + '</span>' + pill + '</div>' + body + '</div>';
    }).join('');
  }

  function refresh() {
    if (document.hidden) return Promise.resolve();
    return apiGet('?limit=30').then(function (d) {
      _jobs = (d && d.jobs) || [];
      _attention = (d && d.attention) || 0;
      ensureDom();
      renderLauncher();
      if (_panelOpen) renderPanel();
    }).catch(function () { /* not authed / offline — stay quiet */ });
  }

  function markAllSeen() {
    _jobs.filter(function (j) { return !j.seen_at && (j.status === 'done' || j.status === 'needs_input' || j.status === 'failed'); })
      .forEach(function (j) { apiPost('/' + encodeURIComponent(j.id) + '/seen', {}).catch(function () {}); });
    _attention = 0; renderLauncher();
  }

  function open() {
    ensureDom();
    _panelOpen = true;
    document.querySelector('.p86-bgt-overlay').classList.add('on');
    renderPanel();
    markAllSeen();
    refresh();
  }
  function close() {
    _panelOpen = false;
    var ov = document.querySelector('.p86-bgt-overlay'); if (ov) ov.classList.remove('on');
  }

  function start() {
    if (_timer) return;
    refresh();
    _timer = setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  }

  window.p86AgentTasks = { open: open, close: close, refresh: refresh };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
