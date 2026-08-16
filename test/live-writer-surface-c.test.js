/**
 * @jest-environment jsdom
 */
// Surface C — the in-editor row flash — and the rule that stops it from
// becoming a SECOND copy of the same document.
//
// The interesting behaviour is not the animation. It is the arbitration:
// when the user is standing on the very estimate that just changed, the
// docked pane would otherwise paint a 560px read-only copy of that estimate
// ON TOP of the real one, while the real one animates the same change
// underneath. Two documents, one of them fake, one of them covering the
// other. C claims the document; B steps down to the op strip, which is where
// the deleted lines and the ops with no row still get named.

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

const L = (id, desc, qty, unitCost) => ({ id, description: desc, qty, unitCost, unit: 'ea' });
const est = (id, lines) => ({ id, title: 'Fairways B4', data: { lines } });

// l1 edited (qty 10→12) · l2 added · l3 deleted.
const estCs = (id, extra) => [{
  entity_type: 'estimate', id,
  before: est(id, [L('l1', 'Framing', 10, 100), L('l3', 'Trim', 4, 20)]),
  after: est(id, [L('l1', 'Framing', 12, 100), L('l2', 'Paint', 1, 10)])
}].concat(extra || []);

function mountEditor(openId) {
  document.body.innerHTML =
    '<div id="estimate-editor-view">' +
      '<div data-line-id="l1"></div><div data-line-id="l2"></div>' +
    '</div>' +
    '<div id="elsewhere"><div data-line-id="l1"></div></div>';
  const view = document.getElementById('estimate-editor-view');
  // jsdom does no layout, so offsetParent is null for every element. The
  // engine uses it as its "is the editor actually on screen" probe, so it has
  // to be stood up explicitly here.
  Object.defineProperty(view, 'offsetParent', { get: () => document.body, configurable: true });
  window.p86EstimateEditorCurrentId = () => openId;
  return view;
}

afterEach(() => {
  LW.dismiss();
  LW.flashEditorRows();            // drain any flash left pending
  delete window.p86EstimateEditorCurrentId;
  document.body.innerHTML = '';
  jest.clearAllTimers();
});

describe('C vs B — who renders the document', () => {
  test('editor open on that estimate: C claims, and B does NOT paint the pane', () => {
    mountEditor('est_c1');
    const entry = LW.ingest(estCs('est_c1'), { payloadId: 'c1', state: 'applied' });

    expect(entry.claimedBy).toContain('editor-flash');
    expect(document.getElementById('p86-live-pane')).toBeNull();
    // The strip still fires: it names the agent, the cost impact, and — the
    // reason it matters most — the DELETED line, which C cannot show because
    // its row no longer exists.
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
    // .p86lw-delete — the op row's class is 'p86lw-' + op.kind, and the kind
    // is the whole word. (The stylesheet spent four rules on `.p86lw-del`,
    // which matched nothing.)
    expect(document.querySelector('#p86-live-writer .p86lw-delete')).not.toBeNull();
  });

  test('editor open on a DIFFERENT estimate: B keeps the document pane', () => {
    mountEditor('est_other');
    const entry = LW.ingest(estCs('est_c2'), { payloadId: 'c2', state: 'applied' });
    expect(entry.claimedBy).not.toContain('editor-flash');
    expect(document.getElementById('p86-live-pane')).not.toBeNull();
  });

  test('no editor mounted at all: B keeps the document pane', () => {
    document.body.innerHTML = '';
    const entry = LW.ingest(estCs('est_c2b'), { payloadId: 'c2b', state: 'applied' });
    expect(entry.claimedBy).not.toContain('editor-flash');
    expect(document.getElementById('p86-live-pane')).not.toBeNull();
  });
});

describe('what C is allowed to claim', () => {
  test('a MULTI-entity changeset still claims — the case meta.entityId cannot see', () => {
    mountEditor('est_c3');
    // With two entries, ingest leaves meta.entityId null. That is an ordinary
    // write ("update the estimate, stamp the lead"), and the old claim — which
    // read meta.entityId — silently refused exactly the case where the user is
    // most obviously watching the estimate.
    const entry = LW.ingest(estCs('est_c3', [{
      entity_type: 'lead', id: 'lead_1',
      before: { id: 'lead_1', status: 'new' }, after: { id: 'lead_1', status: 'quoted' }
    }]), { payloadId: 'c3', state: 'applied' });

    expect(entry.meta.entityId).toBeNull();
    expect(entry.claimedBy).toContain('editor-flash');
  });

  test('a DRAFT never arms C — its line ids came from a rolled-back dry run', () => {
    mountEditor('est_c4');
    const entry = LW.ingest(estCs('est_c4'), { payloadId: 'c4', state: 'proposed' });
    expect(entry.claimedBy).not.toContain('editor-flash');
    expect(LW.flashEditorRows('est_c4')).toBe(0);
  });

  test('a failed write never arms C — nothing changed, so nothing may flash', () => {
    mountEditor('est_c4b');
    const entry = LW.ingest(estCs('est_c4b'), {
      payloadId: 'c4b', state: 'failed', applyError: 'Unresolved ref'
    });
    expect(entry.claimedBy).not.toContain('editor-flash');
  });
});

describe('the paint', () => {
  test('flashes the changed rows, scoped INSIDE the editor', () => {
    const view = mountEditor('est_c5');
    LW.ingest(estCs('est_c5'), { payloadId: 'c5', state: 'applied' });

    const n = LW.flashEditorRows('est_c5');
    // Past the 180ms stagger, well short of the 1800ms self-removal — the
    // flash is a decoration that cleans itself up, so a longer advance would
    // assert on the state AFTER it is meant to be gone.
    jest.advanceTimersByTime(500);

    expect(n).toBe(2);                          // l1 edit + l2 add; l3 has no row
    expect(view.querySelector('[data-line-id="l1"]').className).toContain('p86lw-flash-edit');
    expect(view.querySelector('[data-line-id="l2"]').className).toContain('p86lw-flash-add');
    // A bare document.querySelector would have found this one first and
    // decorated a row the user is not looking at.
    expect(document.querySelector('#elsewhere [data-line-id="l1"]').className).toBe('');
  });

  test('the flash is consumed once — a second hydrate paints nothing', () => {
    mountEditor('est_c6');
    LW.ingest(estCs('est_c6'), { payloadId: 'c6', state: 'applied' });
    expect(LW.flashEditorRows('est_c6')).toBe(2);
    expect(LW.flashEditorRows('est_c6')).toBe(0);
  });

  test('two writes between one hydrate MERGE instead of clobbering', () => {
    mountEditor('est_c7');
    LW.ingest([{
      entity_type: 'estimate', id: 'est_c7',
      before: est('est_c7', [L('l1', 'Framing', 10, 100)]),
      after: est('est_c7', [L('l1', 'Framing', 11, 100)])
    }], { payloadId: 'c7a', state: 'applied' });
    LW.ingest([{
      entity_type: 'estimate', id: 'est_c7',
      before: est('est_c7', [L('l1', 'Framing', 11, 100)]),
      after: est('est_c7', [L('l1', 'Framing', 11, 100), L('l2', 'Paint', 1, 10)])
    }], { payloadId: 'c7b', state: 'applied' });

    // One hydrate follows both. A single-slot pending flash would have let the
    // second write discard the first, and l1's edit would never have shown.
    expect(LW.flashEditorRows('est_c7')).toBe(2);
  });

  test('a flash held for another estimate is not painted into the one on screen', () => {
    mountEditor('est_c8');
    LW.ingest(estCs('est_c8'), { payloadId: 'c8', state: 'applied' });
    expect(LW.flashEditorRows('est_somethingelse')).toBe(0);
  });

  test('the paint stops if the editor swaps estimates mid-stagger', () => {
    const view = mountEditor('est_c9');
    LW.ingest(estCs('est_c9'), { payloadId: 'c9', state: 'applied' });
    LW.flashEditorRows('est_c9');               // paints op 0 synchronously
    window.p86EstimateEditorCurrentId = () => 'est_walked_away';
    jest.advanceTimersByTime(500);
    // Ops come out of the differ adds-then-edits, so op 0 is l2 and it was
    // already decorated before the user left. l1 is the one that must not be
    // painted into whatever estimate is on screen now.
    expect(view.querySelector('[data-line-id="l2"]').className).toContain('p86lw-flash-add');
    expect(view.querySelector('[data-line-id="l1"]').className).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// A refusal is not an apply failure. Both are status 'failed'; only one of
// them ever had a payload.
// ────────────────────────────────────────────────────────────────────────────
describe('refusal vs failed apply', () => {
  test('an empty targets array marks the row as never-drafted', () => {
    const meta = LW._metaFromRow({
      id: 'pl_r1', status: 'failed', targets: [],
      apply_error: 'Assembly refused: unpriced item'
    }, 'failed');
    expect(meta.neverDrafted).toBe(true);
  });

  test('a failed APPLY had a real payload, so it is not flagged as a refusal', () => {
    const meta = LW._metaFromRow({
      id: 'pl_r2', status: 'failed',
      targets: [{ entity_type: 'estimate', entity_id: 'est_1' }],
      apply_error: 'Unresolved ref $new_id:line_2'
    }, 'failed');
    expect(meta.neverDrafted).toBe(false);
  });

  // The lean LIST row carries no targets at all. "Don't know" must not read as
  // "never drafted" — that would relabel every failed apply in the feed.
  test('a row with no targets FIELD is not guessed at', () => {
    const meta = LW._metaFromRow({ id: 'pl_r3', status: 'failed' }, 'failed');
    expect(meta.neverDrafted).toBe(false);
  });

  test('the strip says "couldn\'t draft" for a refusal, not "couldn\'t apply"', () => {
    LW.ingest([], {
      payloadId: 'r4', state: 'failed', title: 'Set the scope',
      applyError: 'The Scribe did not produce a valid payload.', neverDrafted: true
    });
    const txt = document.getElementById('p86-live-writer').textContent;
    expect(txt).toContain("couldn't draft that");
    expect(txt).not.toContain("couldn't apply that");
  });

  test('a genuine apply failure still says "couldn\'t apply"', () => {
    LW.ingest([], {
      payloadId: 'r5', state: 'failed', title: 'Add framing',
      applyError: 'Unresolved ref $new_id:line_2'
    });
    expect(document.getElementById('p86-live-writer').textContent).toContain("couldn't apply that");
  });
});
