/* ──────────────────────────────────────────────────────────────────────────
 * js/bt-badge.js — WHERE A RECORD LIVES, as one mark.
 *
 * Project 86 and Buildertrend both hold jobs, leads, estimates and purchase
 * orders, and until now nothing on screen said which of them a given record
 * came from. You had to open the Buildertrend sync page to find out. This is
 * that answer, inline, beside the record's name.
 *
 * THREE STATES, ONE FOOTPRINT — every badge is the same square, so a column
 * of them scans as a column:
 *
 *   local   — Project 86 only. The Project 86 cube, in our cyan. Nothing in
 *             Buildertrend knows this record exists.
 *   synced  — In both, and it came FROM Buildertrend. Buildertrend's own
 *             mark, unaltered.
 *   pushed  — In both, and it STARTED HERE. Buildertrend's mark with the
 *             Project 86 cube pinned to its corner: "that Buildertrend
 *             record is one of ours."
 *
 * THE BUILDERTREND MARK IS THEIR FILE, NOT A DRAWING OF IT.
 * images/buildertrend-mark.png is their own app icon, fetched from
 * buildertrend.com. A hand-drawn lookalike was tried first and was not close
 * enough to be worth having. For `pushed` the mark is never redrawn or
 * recoloured either — the cube is laid OVER it, the way a platform badges an
 * app icon, so their trademark is always shown as they publish it.
 *
 * ── HOW A STATE IS DECIDED ───────────────────────────────────────────────
 * A record is in Buildertrend if it carries that entity's Buildertrend id
 * (jobs.bt_job_id, leads.bt_lead_id, estimates.bt_worksheet_id,
 * job_purchase_orders.bt_po_id — see BT_ID_KEYS). WHICH SYSTEM IT STARTED IN
 * is a separate question, answered by `bt_origin`.
 *
 * `pushed` IS NOT REACHABLE TODAY, on purpose. The integration currently only
 * reads: services/clickr/sync-apply.js pulls Buildertrend into Project 86 and
 * never writes back, so every record holding a Buildertrend id got it from
 * Buildertrend, and `bt_origin` has no writer yet. A record with an id and no
 * origin is therefore `synced` — true of 100% of today's rows. When push-back
 * lands it stamps bt_origin = 'project86' on what it creates over there and
 * these badges light up on their own, with no change to this file. The state
 * exists now so the visual language is decided once, rather than bolted onto
 * a shipped two-state badge later.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var BT_MARK_SRC = 'images/buildertrend-mark.png';

  // Every entity's Buildertrend id column, under both the snake_case the API
  // returns and the camelCase a few client stores use. A record is matched
  // against ALL of them, so one renderer serves every list without callers
  // having to say which kind of record they are holding.
  var BT_ID_KEYS = [
    'bt_job_id', 'btJobId',
    'bt_lead_id', 'btLeadId',
    'bt_worksheet_id', 'btWorksheetId',
    'bt_po_id', 'btPoId',
    'bt_co_id', 'btCoId',
    'bt_bill_id', 'btBillId',
    'bt_task_id', 'btTaskId',
    'bt_contact_id', 'btContactId',
    'bt_id', 'btId'                 // escape hatch for an already-resolved id
  ];

  function firstBtId(rec) {
    if (!rec) return null;
    for (var i = 0; i < BT_ID_KEYS.length; i++) {
      var v = rec[BT_ID_KEYS[i]];
      if (v == null) continue;
      v = String(v).trim();
      if (v) return v;
    }
    return null;
  }

  // 'local' | 'synced' | 'pushed'
  function state(rec) {
    if (!firstBtId(rec)) return 'local';
    var origin = rec && (rec.bt_origin || rec.btOrigin);
    return String(origin || '').toLowerCase() === 'project86' ? 'pushed' : 'synced';
  }

  var LABEL = {
    local:  'Project 86 only',
    synced: 'In Buildertrend',
    pushed: 'Sent to Buildertrend'
  };

  // The sentence behind the mark. Says what is true AND what follows from it —
  // "in Buildertrend" alone does not tell you who wins when the two disagree.
  // WHAT `local` IS ALLOWED TO CLAIM.
  //
  // For a job, lead, estimate, change order, purchase order or bill, the sync
  // actively MATCHES against Buildertrend, so a record with no id really has
  // no counterpart there — "this is not in Buildertrend" is a fact.
  //
  // For a record type nothing syncs, it is not. AR invoices are the case that
  // forced this: the `invoices` table has no bt_* column and there is no
  // invoice matcher in services/clickr/, so nobody has ever looked. And
  // Buildertrend is the client-facing side of the operating model, so it very
  // likely DOES hold an invoice for the same job. Painting the plain `local`
  // sentence there would assert something we cannot support.
  //
  // Pass `unsyncedKind` on those surfaces and the mark says why it is blank
  // instead. The day a matcher exists and stamps an id, the record shows
  // Buildertrend's mark like everything else, with no change to the caller.
  function localTitle(unsyncedKind) {
    if (!unsyncedKind) return TITLE.local;
    return 'Project 86 only — ' + unsyncedKind + ' are not synced with ' +
           'Buildertrend, so nothing here has been matched against it.';
  }

  var TITLE = {
    local:  'Project 86 only — this is not in Buildertrend.',
    synced: 'In Buildertrend — it came from there, and a sync can overwrite it here.',
    pushed: 'Started in Project 86 and sent to Buildertrend — this is the original.'
  };

  // The isometric cube from images/project-86-icon.svg, reduced to the outline
  // that survives at 14px. The "--/86" lettering on the full mark does not, so
  // it is dropped rather than rendered as a smudge.
  function cubeSvg(size, stroke, strokeW, extra) {
    return '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" ' +
             'aria-hidden="true" focusable="false"' + (extra || '') + '>' +
             '<polygon points="10,2.6 16.4,6.3 16.4,13.7 10,17.4 3.6,13.7 3.6,6.3" ' +
               'fill="none" stroke="' + stroke + '" stroke-width="' + strokeW + '" stroke-linejoin="round"/>' +
             '<path d="M10 10 L16.4 6.3 M10 10 L3.6 6.3 M10 10 L10 17.4" ' +
               'fill="none" stroke="' + stroke + '" stroke-width="' + strokeW + '" stroke-linecap="round"/>' +
           '</svg>';
  }

  function btImg(size) {
    return '<img src="' + BT_MARK_SRC + '" width="' + size + '" height="' + size + '" ' +
             'alt="" aria-hidden="true" draggable="false" class="p86-bt-mark">';
  }

  /**
   * render(rec, opts) → markup string, or '' when there is nothing to say.
   *
   * opts.size   px (default 15, tuned to sit on a 13px table row)
   * opts.state  force a state, for a legend or a preview
   * opts.unsyncedKind  the plural name of a record type nothing syncs
   *   ('Invoices'). Changes only what the `local` mark SAYS — see localTitle.
   * opts.hideLocal  true → render nothing for a Project 86-only record.
   *   Use where almost everything is local and the badge would be noise; leave
   *   it OFF on any list where both kinds appear, because a missing badge and
   *   "not in Buildertrend" must never look the same.
   */
  function render(rec, opts) {
    opts = opts || {};
    var st = opts.state || state(rec);
    if (st === 'local' && opts.hideLocal) return '';
    var size = Number(opts.size) || 15;
    var inner;
    if (st === 'local') {
      inner = cubeSvg(size, 'var(--p86-bt-mine,#22d3ee)', 1.5);
    } else if (st === 'pushed') {
      // Their mark, untouched, with our cube pinned to the corner. The cube
      // carries a background-coloured halo so it stays legible over the navy.
      var pin = Math.max(8, Math.round(size * 0.62));
      inner = btImg(size) +
        '<span class="p86-bt-pin" style="width:' + pin + 'px;height:' + pin + 'px;">' +
          cubeSvg(pin, 'var(--p86-bt-mine,#22d3ee)', 2.1) +
        '</span>';
    } else {
      inner = btImg(size);
    }
    var title = st === 'local' ? localTitle(opts.unsyncedKind) : TITLE[st];
    return '<span class="p86-bt-badge is-' + st + '" role="img" ' +
             'aria-label="' + LABEL[st] + '" title="' + title + '">' + inner + '</span>';
  }

  var CSS =
    '.p86-bt-badge { position:relative; display:inline-flex; align-items:center;' +
      ' vertical-align:-0.2em; margin-left:6px; line-height:0; flex-shrink:0; }' +
    '.p86-bt-badge svg, .p86-bt-badge img { display:block; }' +
    '.p86-bt-mark { border-radius:22%; }' +
    // The corner pin on `pushed`. Sits outside the tile's lower-left so it
    // never covers the b, and takes the page background so it reads as applied
    // TO the icon rather than drawn INTO it.
    '.p86-bt-badge .p86-bt-pin { position:absolute; left:-22%; bottom:-18%;' +
      ' display:block; border-radius:50%; background:var(--card-bg,#141419);' +
      ' box-shadow:0 0 0 1.5px var(--card-bg,#141419); }' +
    'body.light-mode .p86-bt-badge .p86-bt-pin { background:#fff; box-shadow:0 0 0 1.5px #fff; }' +
    'body.light-mode .p86-bt-badge { --p86-bt-mine:#0e7490; }' +
    // A "what do these mean" strip, for the sync page.
    '.p86-bt-legend { display:flex; flex-wrap:wrap; gap:16px; align-items:center;' +
      ' font-size:11.5px; color:var(--text-dim,#8b90a5); }' +
    '.p86-bt-legend > span { display:inline-flex; align-items:center; gap:6px; }' +
    '.p86-bt-legend .p86-bt-badge { margin-left:0; }';

  function injectCSS() {
    if (document.getElementById('p86-bt-badge-css')) return;
    var el = document.createElement('style');
    el.id = 'p86-bt-badge-css';
    el.textContent = CSS;
    document.head.appendChild(el);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectCSS);
  } else {
    injectCSS();
  }

  // The three marks with their names. A symbol nobody can look up is a puzzle,
  // so any surface leaning on the badge should be able to show this.
  function legend() {
    return '<div class="p86-bt-legend">' +
      ['local', 'synced', 'pushed'].map(function (st) {
        return '<span>' + render(null, { state: st, size: 15 }) + LABEL[st] + '</span>';
      }).join('') +
    '</div>';
  }

  /* WHEN THE RECORD WAS MADE, and when we pulled it.
   *
   * A record imported from Buildertrend has a created_at of the SYNC, not of
   * the work: on the live org 609 of 687 jobs carried one day, because that is
   * when the import ran. Sorting a list by age therefore ranked records by
   * when we happened to fetch them. bt_created_at is Buildertrend’s own date,
   * and it is what a list should order and show.
   *
   * The fallback is NOT cosmetic: a record made in Project 86 has no
   * Buildertrend date and its created_at IS its true creation, so the two
   * kinds sort together correctly in one list. A record synced before these
   * columns existed also has none yet, and falls back until the next sync
   * heals it — which is why this must never invent a date of its own.
   */
  function createdInstant(rec) {
    if (!rec) return null;
    return rec.bt_created_at || rec.btCreatedAt || rec.created_at || rec.createdAt || null;
  }

  // When Buildertrend’s copy first reached us. Null for a record that has
  // never been synced, which is the honest answer — not its creation date.
  function syncedInstant(rec) {
    if (!rec) return null;
    return rec.bt_synced_at || rec.btSyncedAt || null;
  }

  // Sort key: an unknown date sorts LAST in either direction rather than
  // pretending to be 1970, which would pin every unknown to one end.
  function createdSortKey(rec) {
    const v = createdInstant(rec);
    const t = v ? Date.parse(v) : NaN;
    return isFinite(t) ? t : null;
  }

  // How a provenance date PRINTS, in one place, so the jobs list and the
  // leads list cannot drift apart on it. These three columns are always
  // TIMESTAMPTZ instants, so they go through new Date() and land in the
  // viewer’s own zone — unlike a DATE column, which must not shift (see
  // fmtDate in js/leads.js, which handles both kinds for its own feed).
  function fmtDateInstant(v) {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  }

  window.p86BtBadge = {
    createdInstant: createdInstant,
    fmtDateInstant: fmtDateInstant,
    syncedInstant: syncedInstant,
    createdSortKey: createdSortKey,
    state: state,
    localTitle: localTitle,
    render: render,
    legend: legend,
    btId: firstBtId,
    LABEL: LABEL,
    TITLE: TITLE,
    BT_ID_KEYS: BT_ID_KEYS,
    MARK_SRC: BT_MARK_SRC,
    _css: CSS
  };
})();
