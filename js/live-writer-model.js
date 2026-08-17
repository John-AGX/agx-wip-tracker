/* ────────────────────────────────────────────────────────────────────────
 * live-writer-model.js — the Live Writer's DECISION layer.
 *
 * PURE. No DOM, no timers, no globals, no fetch. Given a broadcast entry and
 * a little context, it returns the complete honest claim about that write —
 * every word and every colour — and the engine draws it.
 *
 * WHY THIS FILE EXISTS. Three rounds of the same defect, each one fixed by
 * adding a call at the site where it hurt:
 *
 *   round 1  showNotice() armed the collapse but never updated the pill, so a
 *            refusal collapsed into a green "Scribe wrote".
 *   round 2  setPill() was introduced and called from all three chromes, with
 *            the invariant "every path that fills this card calls setPill."
 *   round 3  six more places said something untrue anyway, because the
 *            invariant was about LEAVES — and leaves are exactly what gets
 *            added. showEstimatePane was a fourth chrome and it called
 *            nothing; the applied-no-listable-ops notice picked its dot from
 *            one branch and its pill from another and disagreed with itself.
 *
 * So the invariant moved up a level. There are two jobs — deciding what is
 * true, and drawing it — and they are now in two files. describe() is the ONLY
 * thing that decides. A chrome cannot disagree with the pill because a chrome
 * cannot reach the pill, and cannot decide to stay silent because silence is
 * a `kind` describe returns.
 *
 * The second export is makeOwner(). Every visible defect in round 3 was an
 * async continuation writing to DOM it no longer owned: a stagger loop that
 * repainted a failure card to "wrote" three seconds later, a collapse timer
 * re-armed by that same orphan, a 180-second backstop that overwrote a
 * truthful notice. The engine already contained four hand-rolled, one-off
 * versions of the same idea (_composing, _selectedId, _pendingFlash.estimateId,
 * _detailRetry). The two written as IDENTITY checks were correct and never
 * produced a defect; the one written as a BOOLEAN produced two. makeOwner is
 * the generalization of the two that work.
 *
 * The third export is makeWriteLedger(), and it exists because makeOwner was
 * the right idea at the wrong altitude. Epochs are PER-REGION; a write is
 * GLOBAL. Measured live on the deployed round-3 build: the strip pill said
 * "Scribe wrote · 3 edited" about write one while Cowork showed write two.
 * The strip's region had never been superseded — nothing had written to it —
 * so it was still, correctly by its own rules, asserting the wrong write. The
 * ledger is the epoch above the region: any write anyone puts on screen
 * supersedes every region that is not displaying it. See makeWriteLedger for
 * the three remedies and for why a PINNED document is stamped, not cleared.
 *
 * Round 4 moved WHICH write is current into the ledger and left WHETHER A
 * WRITE HAPPENED with the surfaces — report() fired whenever some surface's
 * render() had not returned null. That held only because the ONE surface that
 * consults describe() declined the rows describe() calls silent. Mount a
 * surface that does not (Cowork: `claims` is isActive(), `render` returns
 * undefined) and a REJECTED row moved the generation, became subject(), and
 * destroyed an unrelated drafting card. So isReportable() is the fourth
 * export: a ctx-free, surface-free property of the ROW, asked by the ledger
 * itself before it reads a single claim. Reportability and renderability are
 * deliberately two predicates — see isReportable for the rows that separate
 * them.
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // The one palette. Every colour any surface paints comes from here, so a
  // "which green?" question can only ever have one answer.
  var GREEN = '#1d9e75';   // a clean, committed apply — and NOTHING else
  var AMBER = '#d98a1f';   // real, but degraded: it happened, we can't fully read it
  var RED   = '#e24b4a';   // it did not happen
  var BLUE  = '#378add';   // in flight
  var GREY  = '#9a9aa5';   // claims nothing
  var PILL_NEUTRAL = GREY;

  /* The recorder that stores a draft's before/after (payloads.draft_changeset)
   * shipped in commit 369553a, authored 2026-08-16T21:49:41Z. A fixed
   * historical fact, not configuration. Deliberately the COMMIT time: the
   * deploy is necessarily later, so a row created before this instant is
   * CERTAINLY older than the recorder, while a row in the commit→deploy gap
   * falls through to the "can't tell" wording instead of being asserted about. */
  var DRAFT_RECORDER_SINCE = Date.parse('2026-08-16T21:49:41Z');

  // ── ownership ───────────────────────────────────────────────────────────
  /* A region of shared mutable DOM, and a generation counter over it.
   *
   * Every entry that TAKES OVER a region claims a new epoch before its first
   * write. Every async continuation the entry schedules captures the epoch it
   * was born under and no-ops once it has been superseded — checked at every
   * tick, not once at entry, because the loops reschedule themselves.
   *
   * Superseded continuations abandon SILENTLY and deliberately: the successor
   * already owns the region and has already painted it, so "cleaning up" would
   * mean writing to DOM you no longer own, which is the defect itself. The
   * exceptions are continuations holding a NON-DOM commitment (bookkeeping, a
   * re-emitted event, a baseline advance) — for those the guard goes at the
   * paint call, never at the top of the promise chain. */
  var _dev = false;
  var _paints = [];   // dev-mode ledger: every guarded paint attempt
  var _claims = [];   // dev-mode ledger: every currency claim + supersession

  function setDev(on) { _dev = !!on; if (!_dev) { _paints = []; _claims = []; } }
  function paintLog() { return _paints.slice(); }
  function resetPaintLog() { _paints = []; }
  function claimLog() { return _claims.slice(); }
  function resetClaimLog() { _claims = []; }

  function makeOwner(name) {
    var gen = 0;
    var self = {
      name: name,
      claim: function () { return ++gen; },
      current: function () { return gen; },
      holds: function (e) { return e === gen; },
      /* The one guard. Returns true when the caller still owns the region.
       * In dev mode every call is logged, so a test can assert that no paint
       * ever landed from a superseded epoch — which is the property, rather
       * than "function X calls function Y". */
      guard: function (e, what) {
        var held = (e === gen);
        if (_dev) _paints.push({ owner: name, epoch: e, current: gen, held: held, what: what || '' });
        return held;
      },
      after: function (e, ms, fn) {
        return setTimeout(function () { if (!self.guard(e, 'timer')) return; fn(); }, ms);
      },
      frame: function (e, fn) {
        var raf = (typeof requestAnimationFrame === 'function')
          ? requestAnimationFrame : function (f) { return setTimeout(f, 16); };
        return raf(function () { if (!self.guard(e, 'frame')) return; fn(); });
      }
    };
    return self;
  }

  // ── currency ────────────────────────────────────────────────────────────
  /* THE WRITE LEDGER — the epoch ABOVE the region.
   *
   * makeOwner answers "am I still the one painting this region?". It cannot
   * answer "is the write I am asserting still the current one?", because a
   * region is only ever superseded by a write that lands IN it — and a write
   * is GLOBAL. Measured on the live build after round 3: the strip's pill read
   * "Scribe wrote · 3 edited" about write one while Cowork's document showed
   * write two. Nothing was broken at the region level. Every region correctly
   * owned its own continuations; nothing owned the STATEMENT ABOUT WHICH WRITE
   * IS CURRENT, so the strip went on faithfully asserting a write that was no
   * longer the news.
   *
   * A CLAIMANT is a region that renders a report's WORDS — a pill, a verb, a
   * colour-coded dot. Surface C is deliberately not one: it tints a row for
   * 1.8 seconds and says nothing about any write being the latest.
   *
   * Every claimant is superseded by every reported write it is not currently
   * displaying. NO EXEMPTIONS — only the REMEDY varies, and the remedy is a
   * property of what the region physically contains:
   *
   *   revert  an element that carries CURRENCY AND NO CONTENT — the strip's
   *           pill is a bare status line with no record name and no timestamp,
   *           which is exactly why it reads as "the latest thing that
   *           happened" — goes back to the neutral default that claims nothing
   *   stamp   ANCHORED CONTENT the user may be mid-read of — the strip card, a
   *           Cowork document pinned to a row the user picked — is KEPT and
   *           marked no-longer-current
   *   clear   a TRANSIENT OVERLAY whose content is losslessly available
   *           elsewhere — the estimate pane, the handoff placeholder
   *
   * PINNING CHANGES THE REMEDY, NEVER THE OBLIGATION. A Cowork document pinned
   * to a row is showing an older write ON PURPOSE and must not be yanked out
   * from under the reader — but it must not be captioned as the latest either.
   * There is no "pinned" flag here for that: a claimant is current iff it is
   * DISPLAYING THE WRITE THAT WAS JUST REPORTED, which a pinned document by
   * definition is not. "Showing an old write on purpose" and "asserting an old
   * write is the latest" differ by exactly one thing — the stamp.
   *
   * report() is called by the engine's FAN-OUT with the list of surfaces that
   * reported, never by the surfaces themselves. That is the round-3 lesson
   * applied one level up: an invariant a leaf has to remember is an invariant
   * the next leaf will not.
   *
   * ROUND 5 — and it is the same lesson a THIRD time, one level further out.
   * Round 4 took WHICH write is current away from the surfaces. It left
   * WHETHER A WRITE HAPPENED AT ALL with them: report() moved a generation
   * whenever the participant list was non-empty, and a surface got onto that
   * list by not returning null from render(). So "a rejection is not news"
   * held only because the ONE surface that consults describe() declined it.
   * Measured live: with Cowork mounted (its `claims` is isActive(), which
   * never reads entry.meta.state, and its render() returns undefined on every
   * branch) an ingested REJECTED row moved the generation, made a rejection
   * the subject(), and destroyed an unrelated in-flight drafting card.
   *
   * So report() now asks isReportable(entry) FIRST, before it looks at a
   * single claim, and it asks the model rather than being told: the caller
   * hands over the ENTRY, not a verdict and not a subject id. A row the model
   * does not call news moves no generation and sets no subject no matter which
   * surfaces are mounted or what they return.
   */
  /* REPORTABILITY — a property of the ROW, and NOT the same property as
   * renderability. It is tempting to read it off describe()'s `kind === silent`
   * and that would be wrong in both directions:
   *
   *   renderable but not news  a REJECTED row is a real ledger row. Cowork
   *                            lists it, and selecting it renders a perfectly
   *                            good document. It is still not news, and it must
   *                            not demote a drafting card or a pinned document.
   *                            The handoff placeholder is the second case: a
   *                            real moment, drawn on the strip, about a write
   *                            that has not landed (P7).
   *   news but not silent-free `kind` depends on CTX — the same rejected row
   *                            comes back as a 'notice' when its detail fetch
   *                            failed (ctx.unreadable), and as 'silent'
   *                            otherwise. Currency must not depend on whose
   *                            fetch broke or on which surface is asking.
   *
   * So it is its own predicate over meta alone, ctx-free and surface-free: a
   * row is news iff there is an identified row to BE the subject and its state
   * is one that actually happened. Nothing here can be reached by a surface. */
  var NOT_NEWS = { rejected: true };
  function isReportable(entry) {
    var meta = (entry && entry.meta) || {};
    if (!meta.payloadId) return false;     // nothing that could be the subject
    return !NOT_NEWS[meta.state || 'applied'];
  }

  function makeWriteLedger() {
    var gen = 0;
    var subject = null;          // payloadId of the newest REPORTED write
    var claimants = [];

    function note(event, name) {
      if (_dev) _claims.push({ event: event, claimant: name, gen: gen, subject: subject });
    }

    var self = {
      current: function () { return gen; },
      /* The newest write anyone put on screen this session, or null. Null is
       * not "nothing is stale" — it is "this view has not seen a write", and
       * a surface must not stamp anything on the strength of it. */
      subject: function () { return subject; },

      /* spec: { name, owner, keeps(by, subject), supersede(gen, subject) }
       *
       * `owner` is the SURFACE whose reports keep this region current, and the
       * default `keeps` is exactly that. A region overrides `keeps` only when
       * its surface can report a write WITHOUT displaying it in that region —
       * true of the estimate pane (its surface may report into the op strip
       * instead) and of the Cowork document (pinned). */
      register: function (spec) {
        if (!spec || typeof spec.supersede !== 'function') return function () {};
        var c = {
          name: spec.name,
          owner: spec.owner || spec.name,
          keeps: typeof spec.keeps === 'function' ? spec.keeps : null,
          supersede: spec.supersede
        };
        claimants = claimants.filter(function (x) { return x.name !== c.name; }).concat([c]);
        return function () { claimants = claimants.filter(function (x) { return x !== c; }); };
      },

      /* THE predicate, exposed so nobody has to re-derive it. Callers may ask;
       * they may not answer — report() re-asks it below regardless. */
      reportable: isReportable,

      /* An ENTRY reached the surfaces in `reporters`. Takes the entry and not
       * a (subjectId, verdict) pair on purpose: the two questions are
       *
       *   WHETHER a write happened   — a property of the row. Decided HERE, by
       *                                the model, before any claim is read.
       *   WHO is displaying it       — a property of the fan-out. That is the
       *                                only half a surface is competent to
       *                                answer, and the only half it is asked.
       *
       * Two ways this does nothing at all, and they are different facts:
       *
       *   not reportable  the row is not news (a dismissal; an unidentified
       *                   row). No generation, no subject, no supersession —
       *                   however many surfaces drew it and whatever they
       *                   returned. This is the round-5 fix, and it is why
       *                   `subject` can only ever be a reportable payloadId:
       *                   there is exactly one assignment to it and it sits
       *                   below this gate.
       *   unwitnessed     real news that nobody put on screen. A write no
       *                   surface displayed must not demote what one did. This
       *                   check used to sit in the CALLER as well; it lives
       *                   here only now — two mechanisms for one invariant is
       *                   how round 3 became necessary. */
      report: function (entry, reporters) {
        if (!isReportable(entry)) { note('not-news', null); return gen; }
        reporters = reporters || [];
        if (!reporters.length) { note('unwitnessed', null); return gen; }
        var by = Object.create(null);
        reporters.forEach(function (n) { by[n] = true; });
        gen++;
        subject = entry.meta.payloadId;
        note('report', reporters.join('+'));
        claimants.slice().forEach(function (c) {
          var kept = c.keeps ? !!c.keeps(by, subject) : !!by[c.owner];
          if (kept) { note('keep', c.name); return; }
          note('supersede', c.name);
          try { c.supersede(gen, subject); }
          catch (e) { console.warn('[live-writer] supersede "' + c.name + '" failed:', e); }
        });
        return gen;
      },

      _claimants: function () { return claimants.map(function (c) { return c.name; }); }
    };
    return self;
  }

  // ── who ─────────────────────────────────────────────────────────────────
  function agentLabel(k) {
    if (!k) return 'Scribe';
    if (k === 'scribe') return 'Scribe';
    if (k === 'job' || k === '86') return '86';
    if (k === 'assistant') return 'Assistant';
    return String(k);
  }

  // ── "why is there no diff" — ONE branch tree, five call sites ────────────
  /* Does this row predate the draft recorder?
   *
   * SCOPE, and it matters: DRAFT_RECORDER_SINCE governs draft_changeset ONLY.
   * An APPLIED row with no apply_changeset is a different fact — the
   * bookkeeping-UPDATE failure path — and dating it against the draft recorder
   * would be a brand-new false claim. So this predicate applies exactly when
   * the column being displayed is draft_changeset, i.e. every state except
   * 'applied': ready, applying, failed, rejected. */
  function predatesDraftRecorder(o) {
    var raw = o && (o.createdAt || o.created_at);
    var ct = Date.parse(raw || '');
    return isFinite(ct) && ct < DRAFT_RECORDER_SINCE;
  }

  var COPY = {
    /* Provable. The recorder was not deployed yet — and say that it cannot be
     * backfilled: the dry run was rolled back, so re-simulating now would
     * describe TODAY's data, not what the Scribe saw. A reconstructed "before"
     * here would be a simulation presented as a record, the precise lie this
     * whole feature exists to end. */
    preRecorder:
      'This draft was made before the app started recording what a draft proposes ' +
      '(16 Aug 2026), so there is no before/after to show. It can’t be reconstructed either — ' +
      'the dry run it came from was rolled back, and re-running it now would describe today’s ' +
      'data rather than what the Scribe saw.',
    /* NOT provable. Could be a write type the recorder doesn't snapshot, a
     * persist that failed, or a row from the commit→deploy gap. Say that it
     * isn't known rather than picking the likeliest cause and asserting it. */
    draftUnknown:
      'No before/after was recorded for this draft. This view can’t tell whether the write type is ' +
      'one the recorder doesn’t snapshot or whether recording it failed, so it isn’t going to guess.',
    /* A changeset exists and breaks into no listable ops. Saying "this write
     * type doesn't record a diff" here would be false, and once was: a live
     * scope write hit exactly this path. */
    unlistable:
      'The server did record a before/after for this write, but nothing in it comes out as a ' +
      'change this view can list. Only what it says it did is shown.',
    /* Applied, nothing recorded at all. Deliberately NOT dated against the
     * draft recorder, and deliberately not the "can't tell" hedge — this is a
     * different column and a different failure. */
    appliedNoRecord:
      'The server recorded no before/after for this write, so what it changed is not known here.',
    /* Applied, no apply_changeset, but a draft_changeset exists. The tempting
     * fallback is the whole bug: it would paint a rolled-back simulation under
     * an "Applied" header. */
    appliedSimulationOnly:
      'This write applied, but the server didn’t record a before/after for it, so what you’d ' +
      'see here would be the Scribe’s draft — a simulation that was rolled back, not what ' +
      'actually landed. It isn’t shown for that reason.'
  };

  /* THE explanation. o: { state, createdAt, hasChangeset, appliedNoDiffWithDraft }
   *
   * Both files call only this. It used to be a branch inside one status arm in
   * each of them, which is why production's ten REJECTED pre-recorder rows were
   * told "this view can't tell" about a fact their created_at proves.
   *
   * Returns the WHY only — no call to action. Each surface appends its own
   * ("Open it in Cowork" is nonsense when you are already on Cowork). */
  function noDiffExplanation(o) {
    o = o || {};
    var isDraft = (o.state !== 'applied');
    if (o.appliedNoDiffWithDraft) return COPY.appliedSimulationOnly;
    if (o.hasChangeset) return COPY.unlistable;
    if (isDraft) return predatesDraftRecorder(o) ? COPY.preRecorder : COPY.draftUnknown;
    return COPY.appliedNoRecord;
  }

  /* Back-compat shim for the one public entry point Cowork already imports.
   * A draft is any non-applied state, so 'proposed' is the right default. */
  function draftNoDiffWhy(createdAt) {
    return noDiffExplanation({ state: 'proposed', createdAt: createdAt, hasChangeset: false });
  }

  // ── per-state chrome ────────────────────────────────────────────────────
  /* Every one of these is a real row state backed by a column, not a mood.
   *
   * There is deliberately NO `settle` field here any more. `settle:'wrote'`
   * hung off the applied DEFAULT arm, and it was the exact wire the green
   * leaked down: showNotice picked the header dot from `chrome.dot` and the
   * pill colour from `chrome.settle ? GREEN : chrome.dot`, so one card could
   * paint a blue header dot over a green pill about a write nobody could read.
   * Whether a report settles is a function of the state AND its degradation,
   * and it is computed in exactly one place — describe(). */
  function stateChrome(state) {
    switch (state) {
      case 'proposed': return { verb: 'drafted — needs approval', dot: AMBER, pulse: false };
      case 'applying': return { verb: 'is applying…',             dot: BLUE,  pulse: true };
      case 'failed':   return { verb: "couldn't apply that",      dot: RED,   pulse: false };
      case 'rejected': return { verb: 'draft dismissed',          dot: GREY,  pulse: false };
      default:         return { verb: 'is writing',               dot: BLUE,  pulse: true };
    }
  }

  function linesOf(snap) {
    if (!snap) return [];
    if (snap.data && Array.isArray(snap.data.lines)) return snap.data.lines;
    if (Array.isArray(snap.lines)) return snap.lines;
    return [];
  }

  // ── describe ────────────────────────────────────────────────────────────
  /* entry → the complete claim. The ONLY decision point.
   *
   * ctx: { inEditor, unreadable:{message,tries}, composing:{label,viaScribe} }
   *
   * kinds:
   *   silent     nothing to report; claim nothing, disturb nothing
   *   ops        the op list (the compact strip)
   *   pane       the committed estimate as a document
   *   notice     a headline + a sentence: refusals, failures, no-diff outcomes
   *   composing  the handoff placeholder — a real moment, not a spinner
   */
  function describe(entry, ctx) {
    ctx = ctx || {};
    entry = entry || {};
    var meta = entry.meta || {};
    var state = meta.state || 'applied';
    var groups = entry.groups || [];
    var changeset = entry.changeset || [];
    var totalOps = groups.reduce(function (n, g) { return n + ((g && g.ops) ? g.ops.length : 0); }, 0);
    var who = agentLabel(meta.emittingAgentKey);

    // The handoff placeholder is declared by its caller, not derived from a
    // row — there is no row yet. It is still a report, so it still goes
    // through here and still gets a pill.
    if (ctx.composing) {
      var viaScribe = ctx.composing.viaScribe !== false;
      return finish({
        kind: 'composing',
        state: 'composing',
        who: viaScribe ? 'Scribe' : '86',
        avatar: viaScribe ? 'S' : '8',
        viaScribe: viaScribe,
        label: ctx.composing.label || 'drafting your change',
        headline: viaScribe ? 'Handed to the Scribe — drafting' : '86 is writing the change',
        verb: viaScribe ? 'Handed to the Scribe — drafting' : '86 is writing the change',
        dot: BLUE, pulse: true, settles: false, degraded: false,
        name: ctx.composing.label || '',
        bodyText: viaScribe
          ? 'The Scribe drafts in the background — usually under a minute. The diff appears here the moment the draft lands.'
          : 'The diff appears here the moment the change lands.'
      });
    }

    /* The handoff placeholder's failure backstop: three minutes and nothing
     * came back. AMBER, not the failed-state red — red means "it did not
     * happen", and the copy itself says this view does not know whether it
     * landed. Claiming a failure here would be the same over-assertion in the
     * opposite direction. */
    if (ctx.backstop) {
      var bViaScribe = ctx.backstop.viaScribe !== false;
      return finish({
        kind: 'notice', state: 'failed', who: bViaScribe ? 'Scribe' : '86',
        headline: "hasn't come back",
        bodyText: 'Nothing has landed here in three minutes. ' +
          (ctx.backstop.swept
            ? 'The writes feed was just checked and this write is not in it — it may still be running.'
            : 'The writes feed could not be checked just now, so this view does not know whether it landed.') +
          ' Check Pending approvals above the chat box, or the Cowork page.',
        dot: AMBER, pulse: false, settles: false, degraded: true,
        name: ctx.backstop.label || ''
      });
    }

    // A write we can see the EXISTENCE of but not the content of. The list row
    // is thin but it is not nothing: it proves the write reached this state.
    // Amber, never the state's own green — the write did land, but this is a
    // degraded report of it and a glance at a green pill would read as
    // "nothing to see here".
    if (ctx.unreadable) {
      return finish({
        kind: 'notice', state: state, who: who,
        headline: state === 'applied' ? 'wrote something this view could not read'
                                      : 'left a write this view could not read',
        bodyText: (meta.title ? '“' + meta.title + '” — ' : '') +
          'the server would not return its details (' + (ctx.unreadable.message || 'fetch failed') +
          ') after ' + (ctx.unreadable.tries || 3) + ' tries, so what it changed is not known here. ' +
          'Open it in Cowork, which fetches it again.',
        dot: AMBER, pulse: false, settles: false, degraded: true,
        name: meta.title || ''
      });
    }

    // A dismissal is not news.
    if (state === 'rejected') return { kind: 'silent', state: state, who: who, degraded: false, settles: false };

    if (state === 'failed') {
      // A REFUSAL and a failed APPLY are different claims. "Couldn't apply
      // that" on a write that never got as far as a draft would send the user
      // hunting for a card that does not exist.
      var refusal = !!meta.neverDrafted;
      return finish({
        kind: 'notice', state: state, who: who,
        headline: refusal ? "couldn't draft that" : "couldn't apply that",
        bodyText: refusal
          ? ((meta.applyError || 'The Scribe did not produce a usable change.') +
             ' Nothing was written — re-ask with the exact record and fields.')
          : (meta.applyError || 'The write failed and nothing was changed.'),
        dot: RED, pulse: false, settles: false, degraded: false,
        name: meta.title || ''
      });
    }

    if (!totalOps) {
      // A DRAFT with nothing to render is still a draft that landed.
      if (state === 'proposed' && meta.payloadId) {
        return finish({
          kind: 'notice', state: state, who: who,
          headline: 'drafted — needs approval',
          bodyText: noDiffExplanation({ state: state, createdAt: meta.createdAt, hasChangeset: changeset.length > 0 }) +
                    ' Open it in Cowork to read the change itself.',
          dot: AMBER, pulse: false, settles: false, degraded: false,
          name: meta.title || ''
        });
      }
      // Applied, and nothing this view can list. It DID apply — but this is a
      // degraded report of it, and it gets exactly the amber that
      // noticeUnreadable already gets. Before, this branch fell through
      // stateChrome's applied default: blue header dot, GREEN pill, one card
      // wearing three colours and none of them agreeing.
      if (state === 'applied' && meta.payloadId) {
        return finish({
          kind: 'notice', state: state, who: who,
          headline: 'wrote something this view can\'t break down',
          bodyText: (meta.summary || meta.title || 'The change was applied.') + ' — ' +
                    noDiffExplanation({ state: state, createdAt: meta.createdAt, hasChangeset: changeset.length > 0 }),
          dot: AMBER, pulse: false, settles: false, degraded: true,
          name: meta.title || ''
        });
      }
      return { kind: 'silent', state: state, who: who, degraded: false, settles: false };
    }

    // ── there are ops ──
    var chrome = stateChrome(state);
    var counts = { add: 0, edit: 0, delete: 0 };
    groups.forEach(function (g) { (g.ops || []).forEach(function (o) { if (counts[o.kind] != null) counts[o.kind]++; }); });
    var summary = [];
    if (counts.add) summary.push('+' + counts.add + ' added');
    if (counts.edit) summary.push(counts.edit + ' edited');
    if (counts.delete) summary.push('−' + counts.delete + ' removed');
    // A proposal has not happened yet, so it must not be phrased as if it had.
    if (state === 'proposed') {
      summary = summary.map(function (s) {
        return s.replace(' added', ' to add').replace(' edited', ' to edit').replace(' removed', ' to remove');
      });
    }

    // Only a COMMITTED single-estimate write earns the document pane — and
    // only when surface C did not already claim the editor, or the pane would
    // be a 560px read-only copy of the estimate painted on top of the real one.
    var first = changeset.length === 1 ? changeset[0] : null;
    var pane = !ctx.inEditor && state === 'applied' && !meta.isDraft &&
               !!first && first.entity_type === 'estimate' && !!first.after &&
               linesOf(first.after).length > 0;

    return finish({
      kind: pane ? 'pane' : 'ops',
      state: state, who: who,
      verb: chrome.verb, dot: chrome.dot, pulse: chrome.pulse,
      // Only a state that actually COMMITTED settles. A pane settles too — its
      // own header goes green when the reveal finishes, and a blue pill sitting
      // over a green pane is the same disagreement in miniature.
      settles: state === 'applied',
      settleVerb: state === 'applied' ? 'wrote' : null,
      degraded: false,
      name: (groups.length === 1) ? groups[0].name : (groups.length + ' records'),
      summary: summary, counts: counts, totalOps: totalOps,
      impact: groups.reduce(function (s, g) { return s + (g.impact || 0); }, 0)
    });
  }

  /* The last word on every report, applied in ONE place so the pill, the
   * header dot and the verb cannot disagree.
   *
   *   settles  ⟺  a clean, committed apply with something to show
   *   green    ⟺  settles
   *
   * Both directions matter. "Never green" would be just as dishonest as the
   * bug — a successful write has to look successful. */
  function finish(r) {
    r.summary = r.summary || [];
    r.degraded = !!r.degraded;
    r.settles = !!r.settles && !r.degraded && r.state === 'applied' &&
                (r.kind === 'ops' || r.kind === 'pane');
    r.settleVerb = r.settles ? (r.settleVerb || 'wrote') : null;
    r.settleDot = r.settles ? GREEN : null;
    if (!r.pillText) {
      if (r.kind === 'composing') r.pillText = r.headline;
      else if (r.kind === 'notice') r.pillText = r.who + ' ' + r.headline;
      else r.pillText = r.who + ' ' + (r.settleVerb || r.verb) +
                        (r.summary.length ? ' · ' + r.summary.join(', ') : '');
    }
    r.pillColor = r.settles ? GREEN : r.dot;
    return r;
  }

  var API = {
    GREEN: GREEN, AMBER: AMBER, RED: RED, BLUE: BLUE, GREY: GREY,
    PILL_NEUTRAL: PILL_NEUTRAL,
    DRAFT_RECORDER_SINCE: DRAFT_RECORDER_SINCE,
    makeOwner: makeOwner,
    makeWriteLedger: makeWriteLedger,
    isReportable: isReportable,
    setDev: setDev, paintLog: paintLog, resetPaintLog: resetPaintLog,
    claimLog: claimLog, resetClaimLog: resetClaimLog,
    agentLabel: agentLabel,
    predatesDraftRecorder: predatesDraftRecorder,
    noDiffExplanation: noDiffExplanation,
    draftNoDiffWhy: draftNoDiffWhy,
    stateChrome: stateChrome,
    describe: describe,
    _COPY: COPY
  };

  if (typeof module === 'object' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.p86LiveWriterModel = API;
})();
