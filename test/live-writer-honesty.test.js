/**
 * @jest-environment jsdom
 */
// The Live Writer's ONE job is to be the honest surface. These are the four
// ways it was quietly failing at that — every one of them a variant of the
// same defect: a surface that knows something and throws the evidence away,
// or asserts something it cannot know.
//
//   D1  a failed write collapsed into a green pill reading "Scribe wrote"
//   D2  the poller's retry-on-failure was defeated by its own baseline
//   D3  a pre-migration draft was told "this write TYPE records no diff"
//   D4  a draft that landed was reported as a draft that never arrived
//
// The load-bearing assertion in D1 is on the COLLAPSED state. The card was
// always right; it is gone 14 seconds later, and the pill that replaces it —
// which can sit on screen for the rest of the session — was the thing lying.

jest.useFakeTimers();

let LW;

beforeAll(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: [] }) })
  );
  global.localStorage = { getItem: () => null, setItem: () => {} };
  require('../js/live-writer.js');
  LW = window.p86LiveWriter;
});

// Fake timers freeze Date.now(), and the engine's sweep baselines only ever
// move FORWARD — so two tests that both stamp their rows "now" would have the
// second one silently filtered out as stale. Every fixture timestamp comes
// from here, strictly increasing, starting well past the load-time baselines.
let TS = Date.now() + 3600000;
function nextTs() { TS += 60000; return new Date(TS).toISOString(); }

const COLLAPSE_MS = 14000;
const GREEN = /1d9e75|29,\s*158,\s*117/;      // success green, hex or rgb()
const RED = /e24b4a|226,\s*75,\s*74/;
const AMBER = /d98a1f|217,\s*138,\s*31/;

function root() { return document.getElementById('p86-live-writer'); }
function pillText() { return root().querySelector('.p86lw-pilltext').textContent; }
function pillDot() { return root().querySelector('.p86lw-pill .p86lw-dot').style.background; }
function collapse() { jest.advanceTimersByTime(COLLAPSE_MS + 1000); }

afterEach(() => {
  LW.dismiss();
  document.body.innerHTML = '';
  jest.clearAllTimers();
  global.fetch.mockClear();
});

// ────────────────────────────────────────────────────────────────────────────
// D1 — the pill is a CLAIM, and it must carry the state.
// ────────────────────────────────────────────────────────────────────────────
describe('D1 · the collapsed pill says what actually happened', () => {
  test('a REFUSAL does not collapse into "Scribe wrote" on a green dot', () => {
    LW.ingest([], {
      payloadId: 'd1a', state: 'failed', title: 'Set the scope',
      applyError: 'The Scribe did not produce a valid payload. Nothing was written.',
      neverDrafted: true
    });
    collapse();

    expect(root().className).toContain('p86lw-collapsed');   // the card is gone
    expect(pillText()).toContain("couldn't draft");
    expect(pillText()).not.toContain('wrote');
    expect(pillDot()).toMatch(RED);
    expect(pillDot()).not.toMatch(GREEN);
  });

  test('a FAILED APPLY collapses to "couldn\'t apply that", also not green', () => {
    LW.ingest([], {
      payloadId: 'd1b', state: 'failed', title: 'Add framing',
      applyError: 'Unresolved ref $new_id:line_2'
    });
    collapse();
    expect(pillText()).toContain("couldn't apply that");
    expect(pillDot()).not.toMatch(GREEN);
  });

  test('a NO-DIFF notice collapses to the same words the card used', () => {
    // Applied with an empty changeset: real write, nothing this view can list.
    // Green is honest here — it applied — but the TEXT must not claim a diff.
    LW.ingest([], { payloadId: 'd1c', state: 'applied', title: 'Reschedule crew' });
    collapse();
    expect(pillText()).toContain("can't break down");
    expect(pillDot()).toMatch(GREEN);
  });

  test('a PROPOSAL collapses amber and says it needs approval — not "wrote"', () => {
    LW.ingest([{
      entity_type: 'estimate', id: 'est_d1d',
      before: { id: 'est_d1d', title: 'B4', data: { lines: [] } },
      after: { id: 'est_d1d', title: 'B4', data: { lines: [{ id: 'l1', description: 'Framing', qty: 2, unitCost: 100 }] } }
    }], { payloadId: 'd1d', state: 'proposed' });
    jest.advanceTimersByTime(1000);   // let the staggered reveal finish
    collapse();

    expect(pillText()).toContain('needs approval');
    expect(pillText()).toContain('to add');       // "to add", not "added"
    expect(pillDot()).toMatch(AMBER);
    expect(pillDot()).not.toMatch(GREEN);
  });

  test('an APPLIED write still earns the green pill — the fix is not "never green"', () => {
    // A lead, not an estimate: a single-estimate apply is claimed by the
    // document pane, which has no pill of its own.
    LW.ingest([{
      entity_type: 'lead', id: 'lead_d1e',
      before: { id: 'lead_d1e', title: 'Fairways', status: 'new' },
      after: { id: 'lead_d1e', title: 'Fairways', status: 'quoted' }
    }], { payloadId: 'd1e', state: 'applied' });
    jest.advanceTimersByTime(1000);
    collapse();
    expect(pillText()).toContain('wrote');
    expect(pillDot()).toMatch(GREEN);
  });

  test('the handoff placeholder is not collapsed by the PREVIOUS card\'s timer', () => {
    // A write lands (arms a 14s collapse), then 3s later the user asks for
    // another. Without clearing that timer the drafting card would vanish
    // behind a pill describing a write that is already history.
    LW.ingest([], { payloadId: 'd1f', state: 'applied', title: 'Earlier write' });
    jest.advanceTimersByTime(3000);
    LW.startComposing('Set the scope on B4', {});
    jest.advanceTimersByTime(COLLAPSE_MS);

    expect(root().className).not.toContain('p86lw-collapsed');
    expect(pillText()).toContain('drafting');
    LW.clearComposing();
  });

  test('work IN PROGRESS never collapses to a completed-write claim', () => {
    LW.startComposing('Set the scope on B4', { tool: 'emit_payload_file' });
    expect(pillText()).toContain('is writing the change');
    expect(pillText()).not.toContain('wrote');
    expect(pillDot()).not.toMatch(GREEN);
    LW.clearComposing();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D2 — one transient 500 on the detail fetch must not make a write invisible.
// ────────────────────────────────────────────────────────────────────────────
describe('D2 · the poller retries a detail fetch it could not read', () => {
  const listRow = (id, appliedAt) => ({
    id, status: 'applied', title: 'Scope write', applied_at: appliedAt,
    activity_at: appliedAt, created_at: appliedAt, has_diff: true
  });
  // A LEAD, not an estimate: a single-estimate apply is claimed by the
  // document pane (#p86-live-pane), and what is under test here is that the
  // write is reported AT ALL, not which chrome reports it.
  const detail = (id) => ({
    payload: {
      id, status: 'applied', title: 'Scope write',
      apply_changeset: [{
        entity_type: 'lead', id: 'lead_' + id,
        before: { id: 'lead_' + id, title: 'Fairways', status: 'new' },
        after: { id: 'lead_' + id, title: 'Fairways', status: 'quoted' }
      }]
    }
  });

  function mockFeed(rows, detailImpl) {
    global.fetch.mockImplementation((url) => {
      if (String(url).indexOf('/api/payloads/?') === 0 || /\/api\/payloads\/\?/.test(String(url))) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: rows }) });
      }
      return detailImpl(String(url));
    });
  }

  test('a 500 on /api/payloads/:id is retried on the NEXT sweep, not swallowed', async () => {
    const now = nextTs();
    let detailCalls = 0;
    mockFeed([listRow('d2a', now)], () => {
      detailCalls++;
      if (detailCalls === 1) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(detail('d2a')) });
    });

    await LW._pollOnce(true);
    // Nothing rendered — the detail could not be read.
    expect(detailCalls).toBe(1);
    expect(document.getElementById('p86-live-writer')).toBeNull();

    // THE BUG: the baseline used to advance BEFORE the ingest, so applied_at
    // now equalled it, and the sweep filter is strictly-greater. This sweep
    // would have skipped the row entirely and it would have stayed invisible
    // until a page reload.
    await LW._pollOnce(true);
    expect(detailCalls).toBe(2);
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
  });

  test('a NEWER sibling in the same batch cannot push the baseline past the failed row', async () => {
    // Rows sweep oldest-first. Holding the baseline back for the failed row is
    // not enough on its own — the newer row's applied_at advances it anyway —
    // so the failed row is re-offered by an explicit retry list instead.
    const older = nextTs();
    const newer = nextTs();
    let sawRetryOfOlder = false;
    mockFeed([listRow('d2b_old', older), listRow('d2b_new', newer)], (url) => {
      if (url.indexOf('d2b_old') >= 0) {
        if (sawRetryOfOlder) return Promise.resolve({ ok: true, json: () => Promise.resolve(detail('d2b_old')) });
        sawRetryOfOlder = true;
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(detail('d2b_new')) });
    });

    await LW._pollOnce(true);            // old fails, new succeeds and advances the baseline
    const calls = global.fetch.mock.calls.length;
    await LW._pollOnce(true);            // the old row must still be offered

    const retried = global.fetch.mock.calls.slice(calls)
      .some((c) => String(c[0]).indexOf('d2b_old') >= 0);
    expect(retried).toBe(true);
  });

  test('the retry is BOUNDED, and the give-up still tells the user something true', async () => {
    const now = nextTs();
    let detailCalls = 0;
    mockFeed([listRow('d2c', now)], () => {
      detailCalls++;
      return Promise.resolve({ ok: false, status: 500 });
    });

    await LW._pollOnce(true);
    await LW._pollOnce(true);
    await LW._pollOnce(true);
    expect(detailCalls).toBe(3);

    // Stops asking...
    await LW._pollOnce(true);
    await LW._pollOnce(true);
    expect(detailCalls).toBe(3);

    // ...but does NOT go quiet. The list row proves the write reached
    // 'applied'; what it changed is unknown, and the copy says exactly that
    // rather than defaulting to the cheerful branch.
    const txt = root().textContent;
    expect(txt).toContain('could not read');
    expect(txt).toContain('not known here');
    // Amber, not green. The write did land, but this is a degraded report of
    // it, and a green pill would read at a glance as "nothing to see here".
    collapse();
    expect(pillDot()).toMatch(AMBER);
    expect(pillDot()).not.toMatch(GREEN);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D3 — a pre-migration draft and a genuinely diff-less write type are
// DIFFERENT FACTS. They must not collapse into one sentence.
// ────────────────────────────────────────────────────────────────────────────
describe('D3 · why a draft has no before/after', () => {
  test('a row that predates the recorder is told so, plainly', () => {
    // The 14 drafts in the approval queue: newest is 2026-06-19, and the
    // draft_changeset column shipped 2026-08-16.
    const why = LW.draftNoDiffWhy('2026-06-19T14:02:00Z');
    expect(why).toContain('before the app started recording');
    // And it must NOT make the claim the old copy made about the write TYPE.
    expect(why).not.toMatch(/kind of write|write type/);
  });

  test('it says the diff cannot be backfilled, and why', () => {
    // Re-simulating now would describe TODAY's data. Presenting that as the
    // record is the exact lie this feature exists to end, so the copy has to
    // close the door rather than leave "why not just re-run it?" open.
    const why = LW.draftNoDiffWhy('2026-06-19T14:02:00Z');
    expect(why).toMatch(/rolled back/);
    expect(why).toMatch(/today’s data|today's data/);
  });

  test('a row from AFTER the recorder shipped is not guessed at', () => {
    const why = LW.draftNoDiffWhy(new Date().toISOString());
    expect(why).toMatch(/can’t tell|can't tell/);
    expect(why).toContain('isn’t going to guess');
    // Crucially it does not assert the pre-migration story either.
    expect(why).not.toContain('before the app started recording');
  });

  test('a missing created_at falls to the honest branch, never the provable one', () => {
    const why = LW.draftNoDiffWhy(null);
    expect(why).not.toContain('before the app started recording');
    expect(why).toMatch(/can’t tell|can't tell/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D4 — a draft that landed must not be reported as a draft that never arrived.
// ────────────────────────────────────────────────────────────────────────────
describe('D4 · a diff-less draft still counts as arriving', () => {
  test('the poller ingests a ready row with NO draft_changeset', async () => {
    const soon = nextTs();
    global.fetch.mockImplementation((url) => {
      if (/\/api\/payloads\/\?/.test(String(url))) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: [{
          id: 'd4a', status: 'ready', title: 'Move the crew to Tuesday',
          created_at: soon, activity_at: soon, has_draft: false, has_diff: false
        }] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ payload: {
        id: 'd4a', status: 'ready', title: 'Move the crew to Tuesday',
        created_at: soon, draft_changeset: null, targets: [{ entity_type: 'schedule', entity_id: 's1' }]
      } }) });
    });

    // THE BUG: the `proposed` arm required (has_draft || has_diff), so this
    // row was never ingested, clearComposing() never fired, and the handoff
    // card ran its full 180s and concluded the draft never landed.
    LW.startComposing('Move the crew to Tuesday', {});
    await LW._pollOnce(true);              // first sighting — inside the settle window
    jest.advanceTimersByTime(21000);       // recorder had its chance
    await LW._pollOnce(true);

    const txt = root().textContent;
    expect(txt).toContain('drafted — needs approval');
    expect(txt).not.toContain('drafting');

    // And the backstop must now stay silent: the draft DID land.
    await jest.advanceTimersByTimeAsync(190000);
    expect(root().textContent).not.toContain("hasn't come back");
  });

  test('a draft still being dry-run is NOT reported as having no diff', async () => {
    // driveScribeWrite INSERTS the payload row and only then dry-runs it;
    // persistDraftChangeset runs after that. So every draft is momentarily a
    // draft with no recorded before/after. Announcing that on sight would be
    // false AND self-sealing — the announcement marks the row seen for this
    // state, so the diff that lands a second later would never be shown.
    const soon = nextTs();
    let hasDraft = false;
    global.fetch.mockImplementation((url) => {
      if (/\/api\/payloads\/\?/.test(String(url))) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: [{
          id: 'd4c', status: 'ready', title: 'Add framing to B4',
          created_at: soon, activity_at: soon, has_draft: hasDraft
        }] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ payload: {
        id: 'd4c', status: 'ready', title: 'Add framing to B4', created_at: soon,
        targets: [{ entity_type: 'estimate', entity_id: 'est_1' }],
        draft_changeset: hasDraft ? [{
          entity_type: 'estimate', id: 'est_1',
          before: { id: 'est_1', title: 'B4', data: { lines: [] } },
          after: { id: 'est_1', title: 'B4', data: { lines: [{ id: 'l1', description: 'Framing', qty: 4, unitCost: 120 }] } }
        }] : null
      } }) });
    });

    await LW._pollOnce(true);
    expect(document.getElementById('p86-live-writer')).toBeNull();   // held, not announced

    // The recorder finishes; the very next sweep shows the real diff.
    hasDraft = true;
    await LW._pollOnce(true);
    const txt = root().textContent;
    expect(txt).toContain('Framing');
    expect(txt).not.toContain('No before/after was recorded');
  });

  test('a diff-less draft is explained, not just announced', async () => {
    const soon = nextTs();
    global.fetch.mockImplementation((url) => {
      if (/\/api\/payloads\/\?/.test(String(url))) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: [{
          id: 'd4b', status: 'ready', title: 'Old draft', created_at: soon, activity_at: soon, has_draft: false
        }] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ payload: {
        id: 'd4b', status: 'ready', title: 'Old draft',
        created_at: '2026-06-19T14:02:00Z', draft_changeset: null, targets: [{ entity_type: 'estimate', entity_id: 'e1' }]
      } }) });
    });
    await LW._pollOnce(true);
    jest.advanceTimersByTime(21000);
    await LW._pollOnce(true);
    // created_at on the DETAIL row is what the copy reasons about, and it is
    // pre-migration — so the provable sentence, not the hedge.
    expect(root().textContent).toContain('before the app started recording');
  });

  test('when the backstop DOES fire, it distinguishes "checked" from "couldn\'t check"', async () => {
    global.fetch.mockImplementation(() => Promise.reject(new Error('offline')));
    LW.startComposing('Something that never lands', {});
    await jest.advanceTimersByTimeAsync(190000);
    const txt = root().textContent;
    expect(txt).toContain("hasn't come back");
    // The old copy asserted "No draft has landed in three minutes" even when
    // nothing had looked. It cannot know that if the feed was unreachable.
    expect(txt).toContain('could not be checked');
    expect(txt).not.toContain('was just checked');
  });
});
