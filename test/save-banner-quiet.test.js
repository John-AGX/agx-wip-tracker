/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE BANNER DOES NOT CRY WOLF.
 *
 * js/save-banner.js exempted 'no-good-load' from its own zero-dirty
 * short-circuit, so every Railway swap with the app open and NOTHING unsaved —
 * the common case, roughly twenty pushes in a day — painted a red error banner
 * reading "Not saving to the server — 0 changes on this device only." The
 * push-failed copy had the same shape: "Couldn't save 0 changes".
 *
 * That is not cosmetic. A red banner that fires on every deploy with a nonsense
 * count is precisely how a user learns to ignore the banner — and the
 * deleted-by-someone-else state depends on him reading it.
 *
 * Two rules, asserted at both layers so neither can reintroduce it alone:
 *   1. no unsaved rows ⇒ no banner, in EVERY state
 *   2. describeSaveState never emits a count of 0
 * And the genuine states must all survive, which is the other half of the file.
 * ────────────────────────────────────────────────────────────────────────── */
const path = require('path');

const M = require(path.join(__dirname, '..', 'js', 'save-merge.js'));

const REASONS = [null, 'no-good-load', 'push-failed', 'unpushed-changes',
                 'hydrate-in-flight', 'partial', 'something-unknown'];

function state(over) {
  return Object.assign({
    reason: null, jobs: [], estimates: [], heldMs: 0,
    retryAttempt: 0, escalate: false, quotaFailed: false
  }, over || {});
}

describe('describeSaveState at zero unsaved rows', () => {
  test('paints nothing, whatever the reason, however long it has been held', () => {
    for (const reason of REASONS) {
      for (const heldMs of [0, 5000, M.STILL_DOWN_MS, 600000]) {
        for (const retryAttempt of [0, 1, 9]) {
          const v = M.describeSaveState(state({ reason, heldMs, retryAttempt }));
          expect({ reason, heldMs, retryAttempt, level: v.level }).toEqual(
            { reason, heldMs, retryAttempt, level: 'none' });
        }
      }
    }
  });

  test('never emits the string "0 change"', () => {
    for (const reason of REASONS) {
      for (const quotaFailed of [false, true]) {
        const v = M.describeSaveState(state({ reason, quotaFailed }));
        expect(String(v.title) + ' ' + String(v.detail)).not.toMatch(/\b0 change/);
        expect(v.count).toBe(0);
      }
    }
  });

  test('the exact banner John saw on every deploy is gone', () => {
    const v = M.describeSaveState(state({ reason: 'no-good-load', retryAttempt: 1 }));
    expect(v.level).toBe('none');
    expect(String(v.title)).not.toMatch(/Not saving to the server/);
  });
});

describe('the genuine states, all of which must survive', () => {
  test('one real held edit still says so, and still offers a way out', () => {
    const v = M.describeSaveState(state({ reason: 'no-good-load', jobs: ['Fairways'], retryAttempt: 2 }));
    expect(v.level).toBe('error');
    expect(v.title).toBe('Not saving to the server');
    expect(v.detail).toContain('1 change on this device only');
    expect(v.detail).toContain('attempt 2');
    expect(v.actions).toContain('try-now');
    expect(v.actions).toContain('show-unsaved');
  });

  test('after two minutes down the copy escalates rather than repeating itself', () => {
    const v = M.describeSaveState(state({
      reason: 'no-good-load', jobs: ['Fairways'], heldMs: M.STILL_DOWN_MS
    }));
    expect(v.title).toMatch(/Still can't reach the server/);
    expect(v.detail).toMatch(/do not close this tab/);
  });

  test('a failed push with real rows still names them', () => {
    const v = M.describeSaveState(state({ reason: 'push-failed', jobs: ['A'], estimates: ['B'] }));
    expect(v.level).toBe('error');
    expect(v.title).toMatch(/2 changes/);
    expect(v.actions).toContain('retry-now');
  });

  test('the held hydrate is still a warning, not an error, and claims no loss', () => {
    const v = M.describeSaveState(state({ reason: 'unpushed-changes', jobs: ['Fairways'] }));
    expect(v.level).toBe('warn');
    expect(v.detail).toMatch(/paused on your copy/);
  });

  test('a deleted-row rejection is still the loudest thing in the file', () => {
    const v = M.describeSaveState(state({ reason: 'partial', jobs: ['Fairways'], deleted: ['j1'] }));
    expect(v.level).toBe('error');
    expect(v.title).toMatch(/Deleted by someone else/);
  });

  test('a routine refresh stays quiet for its first few seconds', () => {
    expect(M.describeSaveState(state({ reason: 'hydrate-in-flight', jobs: ['A'], heldMs: 300 })).level)
      .toBe('none');
    expect(M.describeSaveState(state({ reason: 'hydrate-in-flight', jobs: ['A'], heldMs: M.HYDRATE_QUIET_MS })).level)
      .toBe('warn');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * The DOM half. The pure function above is only half the decision — the
 * exemption that produced the wolf-cry lived in the banner module itself.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('js/save-banner.js in the DOM', () => {
  const EL = '#p86-save-banner';

  function mount(saveState) {
    jest.resetModules();
    document.body.innerHTML = '';
    const css = document.getElementById('p86-save-banner-css');
    if (css) css.remove();
    window.p86SaveState = () => Object.assign({ jobs: [], estimates: [], retryAttempt: 0 }, saveState());
    delete window.p86PushStatus;
    require(path.join(__dirname, '..', 'js', 'save-merge.js'));
    require(path.join(__dirname, '..', 'js', 'save-banner.js'));
    return window.p86SaveBanner;
  }
  function quiet(banner) {
    // stops the 1s repaint interval so it cannot leak into the next test
    banner._onStatus('idle');
  }

  test('a deploy window with nothing unsaved paints NO banner', () => {
    const banner = mount(() => ({ jobs: [], estimates: [] }));
    banner._onStatus('load-failed', { reason: 'no-good-load' });
    expect(document.querySelector(EL)).toBeNull();
    banner._onStatus('blocked', { reason: 'no-good-load', retryAttempt: 3 });
    expect(document.querySelector(EL)).toBeNull();
    quiet(banner);
  });

  test('…and no other status paints one either while the dirty set is empty', () => {
    const banner = mount(() => ({ jobs: [], estimates: [] }));
    for (const s of ['load-failed', 'failed', 'partial', 'blocked', 'saving', 'retrying']) {
      banner._onStatus(s, { reason: 'no-good-load' });
      expect(document.querySelector(EL)).toBeNull();
    }
    quiet(banner);
  });

  test("the banner's own zero-dirty rule stands on its own", () => {
    // describeSaveState now refuses to speak at zero too, which would mask a
    // regression here. So: hand the banner a copy-writer that ALWAYS wants to
    // paint. The only thing left that can keep it quiet is the module's own
    // short-circuit — the one that used to carry a 'no-good-load' exemption.
    let dirty = [];
    const banner = mount(() => ({ jobs: dirty, estimates: [] }));
    window.p86SaveMerge = {
      describeSaveState: () => ({
        level: 'error', title: 'ALWAYS', detail: 'PAINTS', actions: [], count: 0
      })
    };
    banner._onStatus('load-failed', { reason: 'no-good-load' });
    expect(document.querySelector(EL)).toBeNull();

    dirty = ['Fairways'];
    banner.refresh();
    expect(document.querySelector(EL)).not.toBeNull();
    quiet(banner);
  });

  test('the SAME deploy window with one real held edit paints, and reads correctly', () => {
    let dirty = [];
    const banner = mount(() => ({ jobs: dirty, estimates: [] }));
    banner._onStatus('load-failed', { reason: 'no-good-load' });
    expect(document.querySelector(EL)).toBeNull();

    dirty = ['Fairways'];                 // John types
    banner.refresh();
    const el = document.querySelector(EL);
    expect(el).not.toBeNull();
    expect(el.className).toContain('is-error');
    expect(el.textContent).toContain('1 change on this device only');
    expect(el.textContent).not.toContain('0 change');

    dirty = [];                           // the push lands
    banner.refresh();
    expect(document.querySelector(EL)).toBeNull();
    quiet(banner);
  });
});
