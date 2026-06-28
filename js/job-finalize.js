// Shared "Finalize Job" modal — collects the REQUIRED job number (S#### Service
// or RV#### Renovation) and the title before a job is created from a lead or an
// estimate. The title is pre-filled "{client short name} {proposal name}" and is
// editable; the job number is required + format-validated. Self-contained (inline
// themed styles) so leads.js / estimate-editor.js can both call it.
//
//   window.p86JobFinalize.open({ title, subtitle })
//     -> Promise<{ jobNumber, title } | null>   (null = cancelled)
//   window.p86JobFinalize.normalizeNumber(str)  -> 'S0000' | 'RV0000' | null
(function () {
  'use strict';

  // Valid = S or RV prefix + digits. Returns the normalized (upper-prefix) value
  // or null if it doesn't match.
  function normalizeNumber(v) {
    var m = String(v == null ? '' : v).trim().match(/^(s|rv)\s*0*?(\d{1,6})$/i);
    if (!m) {
      var m2 = String(v == null ? '' : v).trim().match(/^(s|rv)(\d{1,6})$/i);
      if (!m2) return null;
      return m2[1].toUpperCase() + m2[2];
    }
    return m[1].toUpperCase() + m[2];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function open(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var modal = document.createElement('div');
      modal.className = 'p86-jobfin-modal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:9200;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto;';
      var card = 'background:var(--surface,#1a1d27);border:1px solid var(--border,#2e3346);border-radius:14px;width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.5);';
      var lbl = 'font-size:12px;font-weight:600;color:var(--text-dim,#c4c8d8);display:block;margin-bottom:5px;';
      var inp = 'appearance:none;width:100%;box-sizing:border-box;background:var(--input-bg,#0f1117);border:1px solid var(--border,#2e3346);color:var(--text,#eef0f6);border-radius:8px;padding:9px 10px;font-size:14px;';
      var btn = 'appearance:none;border:1px solid var(--border,#2e3346);background:var(--surface,#1a1d27);color:var(--text,#eef0f6);border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;';
      var btnPri = 'appearance:none;border:1px solid var(--accent,#4f8cff);background:var(--accent,#4f8cff);color:#fff;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;';
      modal.innerHTML =
        '<div style="' + card + '">' +
          '<div style="padding:16px;">' +
            '<div style="font-size:16px;font-weight:700;color:var(--text,#eef0f6);margin-bottom:' + (opts.subtitle ? '4px' : '14px') + ';">Finalize Job</div>' +
            (opts.subtitle ? '<div style="font-size:12px;color:var(--text-dim,#c4c8d8);margin-bottom:14px;line-height:1.5;">' + esc(opts.subtitle) + '</div>' : '') +
            '<div style="margin-bottom:14px;">' +
              '<label style="' + lbl + '">Job Number <span style="color:#f0a020;">*</span></label>' +
              '<input id="p86jfNum" style="' + inp + '" placeholder="S0000 or RV0000" autocomplete="off" />' +
              '<div style="font-size:11px;color:var(--text-dim,#c4c8d8);margin-top:5px;">Required — <strong>S####</strong> for Service or <strong>RV####</strong> for Renovation. Editable.</div>' +
              '<div id="p86jfErr" style="font-size:11px;color:#ff6b6b;margin-top:5px;display:none;">Enter a valid job number: S#### (Service) or RV#### (Renovation).</div>' +
            '</div>' +
            '<div style="margin-bottom:18px;">' +
              '<label style="' + lbl + '">Job Title</label>' +
              '<input id="p86jfTitle" style="' + inp + '" placeholder="Client — proposal name" autocomplete="off" />' +
            '</div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
              '<button id="p86jfCancel" style="' + btn + '">Cancel</button>' +
              '<button id="p86jfOk" style="' + btnPri + '">Create Job</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      var numEl = modal.querySelector('#p86jfNum');
      var titleEl = modal.querySelector('#p86jfTitle');
      var errEl = modal.querySelector('#p86jfErr');
      titleEl.value = opts.title || '';
      setTimeout(function () { numEl.focus(); }, 30);

      var done = false;
      function close(result) { if (done) return; done = true; modal.remove(); resolve(result || null); }
      function submit() {
        var n = normalizeNumber(numEl.value);
        if (!n) { errEl.style.display = ''; numEl.style.borderColor = '#ff6b6b'; numEl.focus(); return; }
        close({ jobNumber: n, title: (titleEl.value || '').trim() });
      }
      numEl.addEventListener('input', function () { errEl.style.display = 'none'; numEl.style.borderColor = ''; });
      numEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      titleEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      modal.querySelector('#p86jfOk').addEventListener('click', submit);
      modal.querySelector('#p86jfCancel').addEventListener('click', function () { close(null); });
      modal.addEventListener('click', function (e) { if (e.target === modal) close(null); });
    });
  }

  window.p86JobFinalize = { open: open, normalizeNumber: normalizeNumber };
})();
