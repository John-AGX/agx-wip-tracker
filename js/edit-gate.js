// edit-gate.js — wires the accidental-edit protection layer.
//
// Two helpers on window.p86EditGate:
//
//   attachSection(fieldsetEl, { startUnlocked })
//       Finds the <legend>, appends a small pencil button, and toggles
//       data-edit-gate="locked"|"unlocked" on the fieldset when clicked.
//       Idempotent — re-calling on the same fieldset re-uses the
//       existing pencil. Pass startUnlocked: true for "new record"
//       editors (no need to tap 5 pencils just to fill in a new lead).
//
//   attachRowContainer(containerEl, rowSelector)
//       Delegates click handling on containerEl. Clicking a row that
//       matches rowSelector flips data-editing="true" on that row and
//       "false" on its siblings. Clicking outside the container
//       re-locks everything. Idempotent — second call no-ops.
//
// CSS gating lives in css/edit-gate.css. Inputs stay in the DOM in
// both states, so programmatic value= writes from cloud-sync payloads
// still land normally (the gate is purely a UX shield over user taps).
//
// Depends on window.p86Icon from js/agx-icons.js for the pencil SVG.

(function() {
    'use strict';

    // Cache the pencil SVG once. agx-icons.js loads before this file
    // per the index.html script order, so window.p86Icon is defined.
    // If it isn't (defensive), fall back to a unicode pencil so we
    // never render a totally blank button.
    function pencilHTML() {
        if (typeof window.p86Icon === 'function') {
            return window.p86Icon('edit');
        }
        return '✏️';
    }

    // ------------------------------------------------------------------
    // Section gate
    // ------------------------------------------------------------------

    // attachSection — gate one fieldset with a pencil-toggle in its
    // legend. Returns the button element so callers can wire extra
    // handlers if needed (currently nothing does).
    function attachSection(fieldsetEl, opts) {
        if (!fieldsetEl || fieldsetEl.tagName !== 'FIELDSET') return null;
        opts = opts || {};

        // Idempotency — if we've already decorated this fieldset, just
        // sync the lock state to the requested startUnlocked value and
        // return the existing button.
        var existingBtn = fieldsetEl.querySelector(':scope > legend .edit-gate-toggle');
        if (existingBtn) {
            setLocked(fieldsetEl, !opts.startUnlocked);
            return existingBtn;
        }

        var legend = fieldsetEl.querySelector(':scope > legend');
        if (!legend) {
            // Fieldset with no legend — bail rather than guess where the
            // pencil should live. Callers should add a legend first.
            return null;
        }

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'edit-gate-toggle';
        btn.setAttribute('aria-pressed', opts.startUnlocked ? 'true' : 'false');
        btn.setAttribute('aria-label', 'Toggle edit mode for this section');
        btn.title = opts.startUnlocked ? 'Lock section' : 'Edit section';
        btn.innerHTML = pencilHTML();
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            var currentlyLocked = fieldsetEl.getAttribute('data-edit-gate') !== 'unlocked';
            setLocked(fieldsetEl, !currentlyLocked);
        });

        legend.appendChild(btn);
        setLocked(fieldsetEl, !opts.startUnlocked);
        return btn;
    }

    function setLocked(fieldsetEl, locked) {
        fieldsetEl.setAttribute('data-edit-gate', locked ? 'locked' : 'unlocked');
        var btn = fieldsetEl.querySelector(':scope > legend .edit-gate-toggle');
        if (btn) {
            btn.setAttribute('aria-pressed', locked ? 'false' : 'true');
            btn.title = locked ? 'Edit section' : 'Lock section';
        }
    }

    // ------------------------------------------------------------------
    // Row gate
    // ------------------------------------------------------------------

    // Track which containers we've already wired so attachRowContainer
    // is idempotent across re-renders. Containers persist across
    // renderLineItems calls (the renderer only swaps innerHTML), so
    // the delegated listener stays valid — we just don't want to
    // double-bind it.
    var WIRED = new WeakSet();

    function attachRowContainer(containerEl, rowSelector) {
        if (!containerEl || WIRED.has(containerEl)) return;
        WIRED.add(containerEl);

        // Click inside container — unlock the matching row, lock the
        // others. Ignored if the click landed on a passthrough element
        // (drag handle, delete button) since those work in locked mode.
        containerEl.addEventListener('click', function(e) {
            // Passthrough? Let the underlying handler run, don't change
            // edit state.
            if (e.target.closest('[data-edit-gate-passthrough]')) return;

            var row = e.target.closest(rowSelector);
            if (!row || !containerEl.contains(row)) return;

            // If the user clicked an input inside an already-unlocked
            // row, leave it alone — that's normal editing.
            if (row.getAttribute('data-editing') === 'true') return;

            unlockRow(containerEl, row, rowSelector);
        });

        // Click anywhere on the document — if it's outside this
        // container, lock everything. Mousedown (not click) so the
        // re-lock happens before the next row's focus event.
        document.addEventListener('mousedown', function(e) {
            if (!containerEl.isConnected) return;
            if (containerEl.contains(e.target)) return;
            lockAll(containerEl, rowSelector);
        });
    }

    function unlockRow(containerEl, row, rowSelector) {
        // Lock every sibling first so only one row is armed at a time.
        var rows = containerEl.querySelectorAll(rowSelector);
        for (var i = 0; i < rows.length; i++) {
            if (rows[i] !== row) rows[i].setAttribute('data-editing', 'false');
        }
        row.setAttribute('data-editing', 'true');
        // Auto-focus the first input so the user can start typing
        // immediately — saves a second tap. Skips if focus moved to an
        // input directly via the click (e.g. clicking a button).
        var firstInput = row.querySelector('input:not([type=hidden]), textarea, select');
        if (firstInput && document.activeElement !== firstInput) {
            try { firstInput.focus({ preventScroll: true }); } catch (_) { firstInput.focus(); }
        }
    }

    function lockAll(containerEl, rowSelector) {
        var rows = containerEl.querySelectorAll(rowSelector + '[data-editing="true"]');
        for (var i = 0; i < rows.length; i++) {
            rows[i].setAttribute('data-editing', 'false');
        }
    }

    // ------------------------------------------------------------------
    // Export
    // ------------------------------------------------------------------

    window.p86EditGate = {
        attachSection: attachSection,
        attachRowContainer: attachRowContainer,
        // Manual lock/unlock — handy from console or for the "Cancel"
        // button on a future row-edit toolbar.
        lockSection: function(fieldsetEl) { setLocked(fieldsetEl, true); },
        unlockSection: function(fieldsetEl) { setLocked(fieldsetEl, false); }
    };
})();
