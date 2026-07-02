// Crew chip (visible-team UI, Wave 3) — a persistent presence for the AI crew in
// the header. Idle: a quiet "Assistant" (or "86") chip so the crew always feels
// present; during a chat turn it narrates the baton-passing live — "Assistant is
// thinking…", "Searching the web…", "Pulling 86 in…", "Scribe is drafting…" — then
// flashes ✓ and settles back. Click = open the chat (window.p86AI.open).
//
// Event contract: ai-panel.js dispatches window CustomEvent 'p86:crew' with
// detail { kind, agent?, name? }; kinds: turn_start · agent · tool · tool_done ·
// replying · turn_end. Fully self-contained (own DOM + CSS); if ai-panel never
// emits, the chip just sits idle — nothing breaks.
(function () {
  'use strict';
  if (window.p86CrewChip) return;

  var ACTORS = {
    assistant: { label: 'Assistant', color: '#4f8cff' },
    job:       { label: '86',        color: '#a78bfa' },
    scribe:    { label: 'Scribe',    color: '#34d399' }
  };
  var _actor = 'assistant';       // last-known host (session_resolved updates it)
  var _escalated = false;         // inside an escalate_to_86 handoff
  var _idleTimer = null;

  function toolLabel(name) {
    if (!name) return null;
    if (name === 'web_search' || name === 'web_fetch') return 'Searching the web…';
    if (name === 'escalate_to_86') return 'Pulling 86 in…';
    if (name === 'scribe_write' || name === 'emit_payload_file') return 'Scribe is drafting…';
    if (name === 'start_background_task') return 'Handing to the crew…';
    if (name === 'bash' || name === 'code_execution' || name === 'write' || name === 'edit') return 'Crunching numbers…';
    if (/^read_|^search_|^find_|^list_|^view_/.test(name)) return 'Checking the books…';
    if (name === 'remember' || name === 'recall' || name === 'forget' || name === 'list_memories') return 'Checking notes…';
    return 'Working…';
  }

  function ensureStyle() {
    if (document.getElementById('p86-crew-css')) return;
    var st = document.createElement('style'); st.id = 'p86-crew-css';
    st.textContent = [
      '#p86CrewChip{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:16px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#cdd3e0;font:600 12px/1 system-ui,sans-serif;cursor:pointer;max-width:230px;white-space:nowrap;overflow:hidden}',
      '#p86CrewChip:hover{background:rgba(255,255,255,.12)}',
      '#p86CrewChip .p86-crew-dot{width:8px;height:8px;border-radius:50%;background:#4f8cff;flex:0 0 auto;transition:background .2s}',
      '#p86CrewChip.p86-crew-active .p86-crew-dot{animation:p86crewpulse 1.1s ease-in-out infinite}',
      '#p86CrewChip .p86-crew-txt{overflow:hidden;text-overflow:ellipsis}',
      '@keyframes p86crewpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.72)}}',
      '@media (max-width:700px){#p86CrewChip .p86-crew-txt{display:none}#p86CrewChip{padding:0 9px}}'
    ].join('');
    document.head.appendChild(st);
  }

  function ensureDom() {
    if (document.getElementById('p86CrewChip')) return;
    ensureStyle();
    var anchor = document.getElementById('header-quickadd-btn');
    if (!anchor || !anchor.parentNode) return;   // header not present (e.g. login page)
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'p86CrewChip';
    b.title = 'Your AI crew — click to chat';
    b.innerHTML = '<span class="p86-crew-dot"></span><span class="p86-crew-txt">Assistant</span>';
    b.addEventListener('click', function () {
      try { if (window.p86AI && window.p86AI.open) window.p86AI.open(); } catch (_) {}
    });
    anchor.parentNode.insertBefore(b, anchor);
  }

  function setChip(text, color, active) {
    ensureDom();
    var b = document.getElementById('p86CrewChip'); if (!b) return;
    var dot = b.querySelector('.p86-crew-dot');
    var txt = b.querySelector('.p86-crew-txt');
    if (dot && color) dot.style.background = color;
    if (txt && text) txt.textContent = text;
    b.classList.toggle('p86-crew-active', !!active);
  }

  function idle() {
    var a = ACTORS[_actor] || ACTORS.assistant;
    setChip(a.label, a.color, false);
  }

  window.addEventListener('p86:crew', function (e) {
    var d = (e && e.detail) || {};
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    var host = ACTORS[_actor] || ACTORS.assistant;
    switch (d.kind) {
      case 'agent':
        if (d.agent && ACTORS[d.agent]) { _actor = d.agent; host = ACTORS[_actor]; }
        setChip(host.label + ' is on it…', host.color, true);
        break;
      case 'turn_start':
        _escalated = false;
        setChip(host.label + ' is thinking…', host.color, true);
        break;
      case 'tool': {
        var lbl = toolLabel(d.name);
        if (d.name === 'escalate_to_86') { _escalated = true; setChip(lbl, ACTORS.job.color, true); }
        else if (d.name === 'scribe_write' || d.name === 'emit_payload_file') setChip(lbl, ACTORS.scribe.color, true);
        else setChip(lbl, _escalated ? ACTORS.job.color : host.color, true);
        break;
      }
      case 'tool_done':
        if (d.name === 'escalate_to_86') { _escalated = false; setChip(host.label + ' is thinking…', host.color, true); }
        break;
      case 'replying':
        setChip((_escalated ? ACTORS.job.label : host.label) + ' is replying…', _escalated ? ACTORS.job.color : host.color, true);
        break;
      case 'turn_end':
        setChip('✓ ' + host.label, host.color, false);
        _idleTimer = setTimeout(idle, 2200);
        break;
    }
  });

  function start() { ensureDom(); idle(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.p86CrewChip = { refresh: idle };
})();
