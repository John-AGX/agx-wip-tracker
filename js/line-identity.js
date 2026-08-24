// js/line-identity.js — ONE implementation of "a document line's `id` is its
// ADDRESS", shared by the change-order editor and the estimate editor.
//
// WHY THIS FILE EXISTS AT ALL. Both editors render every row as
// data-line-id="<line.id>" and resolve the line back out of storage by
// matching that attribute. That makes `id` load-bearing in a way the customer
// facing documents are not: a proposal PDF and the P86 estimate preview
// iterate by ARRAY ORDER and print perfectly whether or not any line has an
// id, so an identity defect is invisible on the artifact and total on the
// screen. The change-order editor lost a day to exactly that — a bulk import
// produced id-less lines, every handler returned on its first statement, and
// the save pill went on reading "Saved" while the work was discarded.
//
// The fix that shipped there was correct in shape and lived in ONE file. This
// repo's recurring defect is the second copy that drifts, and a second copy of
// a two-pass uniqueness walk is precisely the kind of thing that drifts
// silently — so the walk lives here and both editors call it.
//
// WHAT IS **NOT** SHARED, deliberately: the STATE BOUNDARY. The two editors
// do not have the same kind of state. The CO editor owns its record — one
// object, one `_state.co` accessor. The estimate editor owns nothing: its
// lines live in `window.appData.estimateLines`, a flat global array belonging
// to js/app.js, shared across EVERY estimate in the portfolio and mutated by
// eight files. There is no single record to intercept. `guardHostArray` below
// is the piece that lets each editor install the boundary at its own altitude
// against a shape neither of them owns.
//
// THREE INVARIANTS, and all three are load-bearing:
//
//   1. IN PLACE, ORDER PRESERVED, `id` ONLY. Section membership in an
//      estimate is POSITIONAL — sections are delimited by `__section_header__`
//      rows and a line belongs to the nearest header ABOVE it in the array
//      (js/pricing-pipeline.js sectionHeaderFor does allLines.indexOf(line)
//      then walks backward). Nothing else records it. A heal that sorts,
//      filters, de-duplicates or re-creates the array therefore RE-SECTIONS
//      the estimate and moves money between scopes while the cost total sits
//      still. Measured on a real record with sections at 10/20/30/40%:
//      re-ordering the array moved $870.16 of client price. So: never remove
//      an element, never move one, never touch a key that is not `id`.
//
//   2. BYTE-STABLE ONCE MINTED. An id is minted into the STORED object and
//      never re-derived. Deriving one at render time would hand each row a
//      new address on every repaint, which detaches the caret from its row
//      mid-edit and collapses every open assembly strip.
//
//   3. PROGRESS BY CONSTRUCTION. `do { id = mint(); } while (seen[id]);`
//      relies on Math.random eventually disagreeing with itself and has no
//      progress guarantee; the client-side version of that loop was measured
//      exhausting the heap in 39 seconds. mintId's retry suffix strictly
//      increases and the taken set is finite, so it terminates on the shape
//      of the code rather than on luck.
//
// Ids are RANDOM, not derived from content. That is a decision, not an
// oversight: content-derived ids collide by construction on a duplicated
// alternate (identical content, different group) and index-derived ids break
// invariant 2 the first time a line is spliced in above them.
(function () {
  'use strict';

  // Prefix defaults to the change-order/estimate `line_` convention. Estimates
  // pass a prefixFor so a healed header still reads `s…` and a healed content
  // line still reads `l…`, matching everything around it in DevTools.
  function newLineId(prefix) {
    return (prefix == null ? 'line_' : prefix) +
      Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // Mint an id that is taken by NOTHING on the record. See invariant 3.
  // `taken` is a null-prototype map so an id of "constructor" or "toString"
  // cannot masquerade as already-claimed.
  function mintId(taken, prefix) {
    var base = newLineId(prefix), id = base, n = 0;
    while (taken[id]) { id = base + '_' + (++n); }
    return id;
  }

  function idOf(l) {
    if (!l || typeof l !== 'object') return '';
    return (l.id == null) ? '' : String(l.id);
  }

  // TWO PASSES, DELIBERATELY. Pass 1 claims every id ALREADY on the record so
  // a minted id cannot land on one a LATER row is still holding; pass 2 fills
  // the gaps. A single pass would let row 1's new id collide with row 9's
  // existing one.
  //
  // A DUPLICATE is the same defect wearing a different hat and is re-minted
  // too: two rows that resolve to the same line mean a keystroke aimed at the
  // second lands on the first, and a delete aimed at one removes both. On the
  // estimate side that is worse than a missing id, because the array is
  // portfolio-wide and no handler filters by estimateId — a duplicate writes
  // silently into an estimate that is not on screen.
  //
  // Non-objects (a stray `null` the server stored verbatim) are SKIPPED, not
  // removed: removing one would violate invariant 1.
  //
  // Returns the number of ids minted. Idempotent — a second call over a
  // healed array mints nothing and changes nothing.
  function ensureLineIds(lines, opts) {
    if (!Array.isArray(lines)) return 0;
    var prefixFor = (opts && typeof opts.prefixFor === 'function') ? opts.prefixFor : null;
    var taken = Object.create(null), used = Object.create(null), minted = 0;
    var i, l, id;
    for (i = 0; i < lines.length; i++) {
      id = idOf(lines[i]);
      if (id !== '') taken[id] = true;
    }
    for (i = 0; i < lines.length; i++) {
      l = lines[i];
      if (!l || typeof l !== 'object') continue;
      id = idOf(l);
      if (id !== '' && !used[id]) { used[id] = true; continue; }
      // Blank, or the SECOND row to claim this address.
      id = mintId(taken, prefixFor ? prefixFor(l) : null);
      l.id = id;
      taken[id] = true;
      used[id] = true;
      minted++;
    }
    return minted;
  }

  // ── the array hole ────────────────────────────────────────────────────
  // A property accessor on the RECORD intercepts `rec.lines = X`. It does NOT
  // intercept `rec.lines.push(x)` — that reads through the getter and mutates
  // what it returned. That hole was left open by the change-order fix and
  // demonstrated live; this closes it by giving the array itself own
  // properties that shadow the three Array.prototype methods that can INSERT.
  //
  // Non-enumerable so `for…in` and Object.keys are unchanged, and invisible to
  // JSON.stringify, which serialises index properties only.
  //
  // NOT closed, and stated rather than hidden: `arr[i] = obj`, `arr.length = n`
  // and `Array.prototype.push.apply(arr, xs)` (which invokes the prototype
  // method directly, stepping over the own property). The one live caller of
  // the last form — js/app.js's estimate hydrate — was rewritten to assign
  // through the boundary instead.
  var INSERTERS = ['push', 'unshift', 'splice'];

  function guardLineArray(arr, opts) {
    if (!Array.isArray(arr)) return arr;
    if (arr.__p86Guarded) return arr;
    INSERTERS.forEach(function (name) {
      var native = Array.prototype[name];
      Object.defineProperty(arr, name, {
        enumerable: false, configurable: true, writable: true,
        value: function () {
          var out = native.apply(this, arguments);
          ensureLineIds(this, opts);
          return out;
        }
      });
    });
    Object.defineProperty(arr, '__p86Guarded', {
      enumerable: false, configurable: true, writable: true, value: true
    });
    return arr;
  }

  // Install the boundary on `host[prop]`: every wholesale assignment is
  // healed and re-guarded on the way in, and the array that is already there
  // is healed and guarded now. The accessor is enumerable so the host object
  // still serialises exactly as it did.
  function guardHostArray(host, prop, opts) {
    if (!host || typeof host !== 'object') return host;
    var backing = host[prop];
    var d = Object.getOwnPropertyDescriptor(host, prop);
    if (d && d.get && d.get.__p86LineIdentity) { adopt(backing); return host; }
    function adopt(v) {
      if (Array.isArray(v)) { ensureLineIds(v, opts); guardLineArray(v, opts); }
      return v;
    }
    adopt(backing);
    var get = function () { return backing; };
    get.__p86LineIdentity = true;
    Object.defineProperty(host, prop, {
      enumerable: true, configurable: true,
      get: get,
      set: function (v) { backing = adopt(v); }
    });
    return host;
  }

  var API = {
    newLineId: newLineId,
    mintId: mintId,
    ensureLineIds: ensureLineIds,
    guardLineArray: guardLineArray,
    guardHostArray: guardHostArray
  };

  if (typeof window !== 'undefined') window.p86LineIdentity = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
