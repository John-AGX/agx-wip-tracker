// Project 86 in-house dialog helpers — replaces native confirm() / alert() /
// prompt() with styled modals that match the rest of the app.
//
// All three return Promises so callers can:
//   const ok = await p86Confirm({ title, message });
//   if (!ok) return;
// or chain:
//   p86Confirm({ ... }).then(ok => { if (!ok) return; ... });
//
// Browser dialogs are bad: they're un-style-able (Chrome shows "wip.up.
// railway.app says ..."), block all JS, and read as old-fashioned. The
// in-house versions:
//   - Match the .modal / .modal-content visual language used by editors
//   - Render at z-index 1100 (above .modal at 1000) so they layer over
//     other open modals when a deletion is confirmed inside one
//   - Respect Esc (= Cancel) and Enter (= confirm) for keyboard flow
//   - Auto-focus the confirm button so Enter just works
//   - Trap clicks on the backdrop as Cancel
//   - Return a Promise so existing `if (!confirm(...)) return;`
//     patterns translate to `if (!await p86Confirm({...})) return;`

(function() {
  'use strict';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Inject scoped CSS once. We piggy-back on the .modal/.modal-content
  // classes already defined globally so the dialog inherits the right
  // backdrop + content styling, then add a few tweaks for our use.
  function ensureStyles() {
    if (document.getElementById('p86-dialogs-styles')) return;
    var s = document.createElement('style');
    s.id = 'p86-dialogs-styles';
    s.textContent = [
      '.p86-dialog { z-index: 1100 !important; }',
      '.p86-dialog .modal-content { max-width: 460px; padding: 18px 20px; }',
      '.p86-dialog .p86-dialog-title {',
      '  font-size: 15px;',
      '  font-weight: 700;',
      '  margin: 0 0 8px 0;',
      '  color: var(--text, #e4e6f0);',
      '}',
      '.p86-dialog .p86-dialog-message {',
      '  font-size: 13px;',
      '  color: var(--text, #d1d5db);',
      '  line-height: 1.5;',
      '  margin: 0 0 16px 0;',
      '  white-space: pre-wrap;',
      '}',
      '.p86-dialog .p86-dialog-input {',
      '  width: 100%;',
      '  background: var(--card-bg, #0f0f1e);',
      '  color: var(--text, #e4e6f0);',
      '  border: 1px solid var(--border, #333);',
      '  border-radius: 6px;',
      '  padding: 8px 10px;',
      '  font-size: 13px;',
      '  margin-bottom: 14px;',
      '  box-sizing: border-box;',
      '}',
      '.p86-dialog .p86-dialog-input:focus {',
      '  outline: none;',
      '  border-color: rgba(79, 140, 255, 0.6);',
      '}',
      '.p86-dialog .p86-dialog-actions {',
      '  display: flex;',
      '  justify-content: flex-end;',
      '  gap: 8px;',
      '}',
      '.p86-dialog-btn {',
      '  background: var(--card-bg, #0f0f1e);',
      '  color: var(--text, #e4e6f0);',
      '  border: 1px solid var(--border, #333);',
      '  border-radius: 6px;',
      '  padding: 7px 14px;',
      '  font-size: 13px;',
      '  cursor: pointer;',
      '  transition: border-color 0.12s, background 0.12s;',
      '}',
      '.p86-dialog-btn:hover {',
      '  border-color: rgba(79, 140, 255, 0.5);',
      '  background: rgba(79, 140, 255, 0.08);',
      '}',
      '.p86-dialog-btn-primary {',
      '  background: linear-gradient(135deg, #4f8cff, #6a76d9);',
      '  border-color: transparent;',
      '  color: #fff;',
      '  font-weight: 600;',
      '}',
      '.p86-dialog-btn-primary:hover { filter: brightness(1.1); }',
      '.p86-dialog-btn-danger {',
      '  background: linear-gradient(135deg, #ef4444, #dc2626);',
      '  border-color: transparent;',
      '  color: #fff;',
      '  font-weight: 600;',
      '}',
      '.p86-dialog-btn-danger:hover { filter: brightness(1.12); }'
    ].join('\n');
    document.head.appendChild(s);
  }

  // Build + attach a modal. Resolves with whatever resolve() is called
  // with by the action handlers. Auto-cleans up the DOM on resolve.
  function showDialog(opts, build) {
    return new Promise(function(resolve) {
      ensureStyles();
      var modal = document.createElement('div');
      modal.className = 'modal active p86-dialog';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      // Build inner content via the caller's build() function. They
      // get a `done(value)` callback to resolve+close from event handlers.
      var done = function(value) {
        document.removeEventListener('keydown', onKey);
        modal.remove();
        resolve(value);
      };
      var inner = build(done);
      modal.appendChild(inner);
      document.body.appendChild(modal);

      // Click on backdrop = Cancel.
      modal.addEventListener('click', function(e) {
        if (e.target === modal) done(opts.cancelValue !== undefined ? opts.cancelValue : null);
      });

      // Esc = Cancel; Enter = primary action (when no <textarea> focused
      // — text inputs let Enter through).
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          done(opts.cancelValue !== undefined ? opts.cancelValue : null);
        } else if (e.key === 'Enter' && !e.shiftKey) {
          var active = document.activeElement;
          if (active && active.tagName === 'TEXTAREA') return;
          var primary = modal.querySelector('[data-p86-primary]');
          if (primary) {
            e.preventDefault();
            primary.click();
          }
        }
      }
      document.addEventListener('keydown', onKey);
    });
  }

  /**
   * p86Confirm — yes/no confirmation modal.
   * @param {object} opts
   * @param {string} [opts.title]            — modal heading. Default: "Confirm"
   * @param {string} opts.message            — body text (newlines allowed)
   * @param {string} [opts.confirmLabel]     — confirm button text. Default: "OK"
   * @param {string} [opts.cancelLabel]      — cancel button. Default: "Cancel"
   * @param {boolean} [opts.danger]          — render confirm in red (delete-style)
   * @returns {Promise<boolean>} true = confirmed, false = canceled
   */
  function p86Confirm(opts) {
    opts = opts || {};
    return showDialog({ cancelValue: false }, function(done) {
      var content = document.createElement('div');
      content.className = 'modal-content';
      content.innerHTML =
        '<div class="p86-dialog-title">' + escapeHTML(opts.title || 'Confirm') + '</div>' +
        '<div class="p86-dialog-message">' + escapeHTML(opts.message || '') + '</div>' +
        '<div class="p86-dialog-actions">' +
          '<button class="p86-dialog-btn" data-p86-cancel>' + escapeHTML(opts.cancelLabel || 'Cancel') + '</button>' +
          '<button class="p86-dialog-btn ' + (opts.danger ? 'p86-dialog-btn-danger' : 'p86-dialog-btn-primary') +
            '" data-p86-primary data-p86-confirm>' + escapeHTML(opts.confirmLabel || 'OK') + '</button>' +
        '</div>';
      content.querySelector('[data-p86-cancel]').addEventListener('click', function() { done(false); });
      content.querySelector('[data-p86-confirm]').addEventListener('click', function() { done(true); });
      setTimeout(function() {
        var btn = content.querySelector('[data-p86-confirm]');
        if (btn) btn.focus();
      }, 0);
      return content;
    });
  }

  /**
   * p86ConfirmTernary — three-way OK / second-option / Cancel.
   * For "OK = send email · Cancel = skip · X = abort" patterns where
   * Cancel needs to be distinguished from "do the action without the
   * extra step." Returns 'primary' | 'secondary' | null.
   *
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} opts.message
   * @param {string} opts.primaryLabel       — main action (does X + extras)
   * @param {string} opts.secondaryLabel     — alternate (does X without extras)
   * @param {string} [opts.cancelLabel]      — full abort. Default: "Cancel"
   */
  function p86ConfirmTernary(opts) {
    opts = opts || {};
    return showDialog({ cancelValue: null }, function(done) {
      var content = document.createElement('div');
      content.className = 'modal-content';
      content.style.maxWidth = '500px';
      content.innerHTML =
        '<div class="p86-dialog-title">' + escapeHTML(opts.title || 'Confirm') + '</div>' +
        '<div class="p86-dialog-message">' + escapeHTML(opts.message || '') + '</div>' +
        '<div class="p86-dialog-actions">' +
          '<button class="p86-dialog-btn" data-p86-action="cancel">' + escapeHTML(opts.cancelLabel || 'Cancel') + '</button>' +
          '<button class="p86-dialog-btn" data-p86-action="secondary">' + escapeHTML(opts.secondaryLabel || 'Skip') + '</button>' +
          '<button class="p86-dialog-btn p86-dialog-btn-primary" data-p86-primary data-p86-action="primary">' + escapeHTML(opts.primaryLabel || 'OK') + '</button>' +
        '</div>';
      content.querySelectorAll('[data-p86-action]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var action = btn.getAttribute('data-p86-action');
          done(action === 'cancel' ? null : action);
        });
      });
      setTimeout(function() {
        var btn = content.querySelector('[data-p86-action="primary"]');
        if (btn) btn.focus();
      }, 0);
      return content;
    });
  }

  /**
   * p86Alert — single-button info modal.
   * @param {object|string} opts             — string treated as message
   * @returns {Promise<void>}
   */
  function p86Alert(opts) {
    if (typeof opts === 'string') opts = { message: opts };
    opts = opts || {};
    return showDialog({ cancelValue: undefined }, function(done) {
      var content = document.createElement('div');
      content.className = 'modal-content';
      content.innerHTML =
        '<div class="p86-dialog-title">' + escapeHTML(opts.title || 'Notice') + '</div>' +
        '<div class="p86-dialog-message">' + escapeHTML(opts.message || '') + '</div>' +
        '<div class="p86-dialog-actions">' +
          '<button class="p86-dialog-btn p86-dialog-btn-primary" data-p86-primary>OK</button>' +
        '</div>';
      content.querySelector('[data-p86-primary]').addEventListener('click', function() { done(); });
      setTimeout(function() {
        var btn = content.querySelector('[data-p86-primary]');
        if (btn) btn.focus();
      }, 0);
      return content;
    });
  }

  /**
   * p86Prompt — text input modal.
   * @param {object} opts
   * @param {string} [opts.title]
   * @param {string} [opts.message]
   * @param {string} [opts.defaultValue]
   * @param {string} [opts.placeholder]
   * @returns {Promise<string|null>} string entered, or null if canceled
   */
  function p86Prompt(opts) {
    opts = opts || {};
    return showDialog({ cancelValue: null }, function(done) {
      var content = document.createElement('div');
      content.className = 'modal-content';
      content.innerHTML =
        '<div class="p86-dialog-title">' + escapeHTML(opts.title || 'Enter value') + '</div>' +
        (opts.message ? '<div class="p86-dialog-message">' + escapeHTML(opts.message) + '</div>' : '') +
        '<input class="p86-dialog-input" type="text" data-p86-input placeholder="' +
          escapeHTML(opts.placeholder || '') + '" value="' + escapeHTML(opts.defaultValue || '') + '" />' +
        '<div class="p86-dialog-actions">' +
          '<button class="p86-dialog-btn" data-p86-cancel>Cancel</button>' +
          '<button class="p86-dialog-btn p86-dialog-btn-primary" data-p86-primary>OK</button>' +
        '</div>';
      var input = content.querySelector('[data-p86-input]');
      content.querySelector('[data-p86-cancel]').addEventListener('click', function() { done(null); });
      content.querySelector('[data-p86-primary]').addEventListener('click', function() {
        done(input.value);
      });
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          done(input.value);
        }
      });
      setTimeout(function() {
        if (input) { input.focus(); input.select(); }
      }, 0);
      return content;
    });
  }

  // Expose globally so non-module call sites can use directly.
  window.p86Confirm = p86Confirm;
  window.p86ConfirmTernary = p86ConfirmTernary;
  window.p86Alert = p86Alert;
  window.p86Prompt = p86Prompt;
})();
