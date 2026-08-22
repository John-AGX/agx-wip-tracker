/**
 * @jest-environment jsdom
 */
// test/qb-costs-receipt.test.js — the QB cost import RESULT SCREEN.
//
// The importer's old result was `alert('Imported 25 jobs — $368,057.80
// total.')`, built from client-side spreadsheet math, fired outside the
// auth gate and before the network request resolved. It printed the same
// sentence whether 697 rows landed or zero did — which is why two dead
// imports of the 08.13.26 export cost a day to find. (It was also a
// native alert(), a no-op inside the installed PWA, so on a phone it
// printed nothing at all.)
//
// So the receipt is load-bearing, and these are its contract:
//   * every number it shows comes from the SERVER's response;
//   * a write that stored nothing reads as a FAILURE, including the
//     nastiest shape — HTTP 200 with everything skipped;
//   * every rejected row carries the server's reason, on screen.

const { renderCommitReceipt } = require('../js/job-costs-import');

const CITI_LAKES = 'j1785987106996_n9rp';

function mountModal() {
  document.body.innerHTML =
    '<div id="qbCostsImportModal" class="modal">' +
      '<div class="modal-content">' +
        '<div id="qbCostsImport_body"></div>' +
        '<div class="modal-footer">' +
          '<button class="secondary">Cancel</button>' +
          '<button class="primary" id="qbCostsImport_confirmBtn">Import</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  return {
    body: document.getElementById('qbCostsImport_body'),
    confirm: document.getElementById('qbCostsImport_confirmBtn'),
    cancel: document.querySelector('#qbCostsImportModal .modal-footer .secondary')
  };
}

// One matched job carrying 222 lines — the RV2004 Citi Lakes shape.
function matchedJob(lines) {
  return [{
    job: { id: CITI_LAKES, jobNumber: 'RV2004', title: 'Citi Lakes Repaint and Repairs' },
    parsed: { name: 'Citi Lakes Repaint and Repairs', lines: new Array(lines).fill({}), computedTotal: 368057.80 }
  }];
}

function receipt(overrides) {
  return Object.assign({
    fileName: '08.13.26 - Project Costs.xlsx',
    reportDate: '2026-08-13',
    parsedProjects: 330,
    parsedLines: 3109,
    matched: matchedJob(222),
    unmatched: [],
    sentLines: 222,
    srv: null,
    srvErr: null,
    sheetCacheFailed: null
  }, overrides || {});
}

// The five numbers the receipt promises, read back off the rendered tiles.
function tiles(body) {
  const out = {};
  body.querySelectorAll('div').forEach(el => {
    const label = el.querySelector(':scope > div:first-child');
    const value = el.querySelector(':scope > div:last-child');
    if (label && value && label !== value && /^[A-Z][a-z]/.test(label.textContent || '')) {
      out[label.textContent.trim()] = (value.textContent || '').trim();
    }
  });
  return out;
}

describe('the receipt reports the SERVER, not the spreadsheet', () => {
  test('a good import shows the server’s written count', () => {
    const dom = mountModal();
    renderCommitReceipt(receipt({
      srv: { ok: true, received: 222, inserted: 222, updated: 0, skipped: 0, cleaned: 0, rejected: [], byJob: {} }
    }));

    const t = tiles(dom.body);
    expect(t.Parsed).toBe('3109');
    expect(t.Matched).toBe('222');
    expect(t.Written).toBe('222');
    expect(t.Rejected).toBe('0');
    expect(dom.body.textContent).toMatch(/Confirmed by the server/i);
    expect(dom.confirm.textContent).toBe('Done');
  });

  test('when the server writes FEWER rows than the client matched, the server wins', () => {
    // The old alert() would have claimed all 222. This is the exact class
    // of lie the receipt exists to prevent.
    const dom = mountModal();
    renderCommitReceipt(receipt({
      srv: { ok: true, received: 222, inserted: 5, updated: 0, skipped: 217, cleaned: 0,
        rejected: [{ jobId: CITI_LAKES, lines: 217, reason: 'amount is not a number ("n/a")' }],
        byJob: { [CITI_LAKES]: { inserted: 5, updated: 0, skipped: 217 } } }
    }));

    const t = tiles(dom.body);
    expect(t.Written).toBe('5');
    expect(t.Written).not.toBe('222');
    expect(t.Rejected).toBe('217');
    expect(dom.body.textContent).toMatch(/Imported with rejections/i);
  });

  test('re-sent rows read as "already on file", not as new writes', () => {
    // The QB report is cumulative, so this is the normal weekly shape:
    // most rows update in place. It must not read as a double-count, and
    // it must not read as 222 fresh writes either.
    const dom = mountModal();
    renderCommitReceipt(receipt({
      srv: { ok: true, received: 222, inserted: 22, updated: 200, skipped: 0, cleaned: 0, rejected: [],
        byJob: { [CITI_LAKES]: { inserted: 22, updated: 200, skipped: 0 } } }
    }));

    const t = tiles(dom.body);
    expect(t.Written).toBe('22');
    expect(t['Already on file']).toBe('200');
    expect(dom.body.textContent).toMatch(/not.*a double-count/i);
  });
});

describe('an import that stored nothing reads as a failure', () => {
  test('a transport error names the reason and refuses to claim success', () => {
    const dom = mountModal();
    renderCommitReceipt(receipt({ srvErr: 'HTTP 403 — Forbidden' }));

    expect(dom.body.textContent).toMatch(/Nothing was written to the database/i);
    expect(dom.body.textContent).toContain('HTTP 403 — Forbidden');
    expect(dom.body.textContent).not.toMatch(/Confirmed by the server/i);
    expect(tiles(dom.body).Written).toBe('0');
    expect(dom.confirm.textContent).toMatch(/nothing imported/i);
  });

  test('HTTP 200 with every row skipped is a FAILURE, not a success', () => {
    // The nastiest shape, and the one the old code celebrated: the server
    // answers 200 OK and stores none of it.
    const dom = mountModal();
    renderCommitReceipt(receipt({
      srv: { ok: true, received: 222, inserted: 0, updated: 0, skipped: 222, cleaned: 0,
        rejected: [{ jobId: CITI_LAKES, lines: 222, reason: 'no job with this id exists' }], byJob: {} }
    }));

    expect(dom.body.textContent).toMatch(/Nothing was written to the database/i);
    expect(dom.body.textContent).not.toMatch(/Confirmed by the server/i);
    expect(dom.body.textContent).toContain('no job with this id exists');
  });

  test('a truncated request is caught by comparing sent against received', () => {
    const dom = mountModal();
    renderCommitReceipt(receipt({
      sentLines: 222,
      srv: { ok: true, received: 180, inserted: 180, updated: 0, skipped: 0, cleaned: 0, rejected: [], byJob: {} }
    }));

    expect(dom.body.textContent).toMatch(/truncated in transit/i);
  });
});

describe('every row that did not land says why', () => {
  test('the server’s rejection reason is printed verbatim', () => {
    const dom = mountModal();
    renderCommitReceipt(receipt({
      srv: { ok: true, received: 225, inserted: 222, updated: 0, skipped: 3, cleaned: 0,
        rejected: [{ jobId: 'j_gone', lines: 3, reason: 'no job with this id exists — it was deleted, or the browser is holding a stale copy of the jobs list' }],
        byJob: {} }
    }));

    expect(dom.body.textContent).toContain('no job with this id exists');
    expect(dom.body.textContent).toMatch(/stale copy of the jobs list/i);
  });

  // The count here is the contract; the sentence is pinned in detail in
  // test/qb-costs-unmatched-cause.test.js. It used to read "the
  // QuickBooks project code doesn't match any Project 86 job number —
  // fix the project name in QB", which is one of TWO causes and sent
  // readers to the wrong application for the other one.
  test('unmatched QB projects are counted as rejected, with the fix spelled out', () => {
    const dom = mountModal();
    renderCommitReceipt(receipt({
      unmatched: [{ code: '437775', name: 'Solace Exterior Paint', lines: new Array(40).fill({}), computedTotal: 12500 }],
      jobNumbers: ['RV2004', 'S2205', 'S2222'],
      srv: { ok: true, received: 222, inserted: 222, updated: 0, skipped: 0, cleaned: 0, rejected: [], byJob: {} }
    }));

    // 0 server-side + 40 never-sent.
    expect(tiles(dom.body).Rejected).toBe('40');
    expect(dom.body.textContent).toContain('437775');
    // An all-numeric code against an org that letters its job numbers is
    // a QB auto-number — named specifically, with the fix in QuickBooks.
    expect(dom.body.textContent).toMatch(/QuickBooks auto-number/);
    expect(dom.body.textContent).toMatch(/Rename the project in QuickBooks/);
  });

  test('a failed local sheet cache is reported without being mistaken for a money failure', () => {
    const dom = mountModal();
    renderCommitReceipt(receipt({
      sheetCacheFailed: 'QuotaExceededError',
      srv: { ok: true, received: 222, inserted: 222, updated: 0, skipped: 0, cleaned: 0, rejected: [], byJob: {} }
    }));

    expect(dom.body.textContent).toMatch(/Confirmed by the server/i);
    expect(dom.body.textContent).toContain('QuotaExceededError');
    expect(dom.body.textContent).toMatch(/Job cost figures are unaffected/i);
  });
});

describe('the receipt never falls through to a native dialog', () => {
  test('with no modal to paint into it uses the in-app alert, not window.alert', () => {
    document.body.innerHTML = ''; // no #qbCostsImport_body
    const p86Alert = jest.fn();
    window.p86Alert = p86Alert;
    const nativeAlert = jest.fn();
    window.alert = nativeAlert;

    renderCommitReceipt(receipt({ srvErr: 'network error' }));

    expect(p86Alert).toHaveBeenCalledTimes(1);
    expect(p86Alert.mock.calls[0][0].message).toMatch(/FAILED/);
    // Native alert() is a silent no-op in the installed PWA.
    expect(nativeAlert).not.toHaveBeenCalled();
    delete window.p86Alert;
  });
});
