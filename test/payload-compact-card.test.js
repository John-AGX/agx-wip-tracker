/**
 * @jest-environment jsdom
 */
// THE ONE-LINE APPROVAL CARD SHOWS THE OPS, NEVER THE MODEL'S TITLE.
//
// John, 2026-09-12: "a simplified card, minimal description and an approve
// button, that comes on faster." js/payload-artifact.js renderCompact draws
// that card from a lean list row. The line is draft_summary — built server-side
// from the ops (services/payload-describe.js). The model's title is not used,
// because the 2026-08-09 payload TITLED "Convert estimate to job" carried
// only status:'sold'. With no draft_summary there is no honest one-liner, so
// renderCompact refuses and the strip draws the full card.
//
// The real script runs in jsdom; fetch is scripted. Approve must go through
// the same POST /apply door as the full card, Details must hydrate the full
// card in place, and the strip's poll must not rebuild an unchanged list.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'payload-artifact.js'), 'utf8');
let calls;
let responses;

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  delete window.PayloadArtifact;
  calls = [];
  responses = {};
  window.fetch = jest.fn(async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET' });
    const body = responses[(opts && opts.method || 'GET') + ' ' + url] || {};
    return { ok: true, status: 200, json: async () => body };
  });
  // eslint-disable-next-line no-eval
  window.eval(SRC);
});

const ROW = {
  id: 'pl_1', status: 'ready', title: 'Convert estimate to job',
  draft_summary: 'Estimate · Harbor Point — status → sold', draft_risk: 'high',
};
const host = () => document.getElementById('host');
const buttons = (el) => Array.from(el.querySelectorAll('button')).map((b) => b.textContent);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('renderCompact', () => {
  test('THE FINDING: the card says what the ops do, not what the model titled it', () => {
    const card = window.PayloadArtifact.renderCompact(ROW, host());
    expect(card.textContent).toContain('Estimate · Harbor Point — status → sold');
    expect(card.textContent).not.toContain('Convert estimate to job');
    expect(buttons(card)).toEqual(['✓ Approve', 'Details', 'Reject']);
  });

  test('no draft_summary → no compact card (the caller draws the full one)', () => {
    expect(window.PayloadArtifact.renderCompact(Object.assign({}, ROW, { draft_summary: null }), host())).toBeNull();
    expect(host().children).toHaveLength(0);
  });

  test('Approve applies through POST /api/payloads/:id/apply and announces it', async () => {
    responses['POST /api/payloads/pl_1/apply'] = { apply_summary: 'Estimate updated', apply_changeset: [] };
    const heard = [];
    document.addEventListener('p86:payload-applied', (e) => heard.push(e.detail.payload_id));
    const card = window.PayloadArtifact.renderCompact(ROW, host());
    card.querySelector('button').click();
    await flush(); await flush();
    expect(calls).toEqual([{ url: '/api/payloads/pl_1/apply', method: 'POST' }]);
    expect(heard).toEqual(['pl_1']);
    expect(card.dataset.status).toBe('applied');
    expect(buttons(card)).toEqual([]);
  });

  test('Details swaps in the full card, hydrated from GET /api/payloads/:id', async () => {
    responses['GET /api/payloads/pl_1'] = { payload: Object.assign({}, ROW, { filename: 'Estimate.p86.json', targets: [{}] }) };
    const card = window.PayloadArtifact.renderCompact(ROW, host());
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Details').click();
    await flush(); await flush();
    expect(host().querySelector('.p86-payload-compact')).toBeNull();
    expect(host().querySelector('.p86-payload-artifact').textContent).toContain('Estimate.p86.json');
  });
});

describe('the pending-approvals strip (js/ai-panel.js)', () => {
  // The repo is CRLF on disk; normalize before searching for "\n  }\n".
  const PANEL = fs.readFileSync(path.join(__dirname, '..', 'js', 'ai-panel.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = PANEL.indexOf('  var _pendingApprovalsBusy = false;');
  const fnAt = PANEL.indexOf('function refreshPendingApprovals()');
  const endAt = PANEL.indexOf('\n  }\n', fnAt);
  const body = PANEL.slice(start, endAt + 4);

  function strip(mutate) {
    let src = body;
    if (mutate) {
      const [find, replace] = mutate;
      if (src.split(find).length !== 2) throw new Error('MUTATION ANCHOR not found exactly once: ' + find);
      src = src.replace(find, replace);
    }
    // eslint-disable-next-line no-new-func
    return new Function('authHeaders', src + '\nreturn refreshPendingApprovals;')(() => ({}));
  }

  test('MUTANT: without the unchanged-list check, every 5s poll rebuilds the card under the user', async () => {
    document.body.innerHTML = '<div id="ai-pending-approvals"></div>';
    responses['GET /api/payloads?limit=30&status=ready'] = { payloads: [ROW] };
    const refresh = strip(['if (sig === _pendingApprovalsSig && host.children.length) return;', '']);
    refresh();
    for (let i = 0; i < 5; i++) await flush();
    const first = document.querySelector('.p86-payload-compact');
    refresh();
    for (let i = 0; i < 5; i++) await flush();
    expect(document.querySelector('.p86-payload-compact')).not.toBe(first);
  });

  test('MUTANT: without the compact shortcut, every row costs a second fetch again', async () => {
    document.body.innerHTML = '<div id="ai-pending-approvals"></div>';
    responses['GET /api/payloads?limit=30&status=ready'] = { payloads: [ROW] };
    const refresh = strip(['if (p.draft_summary && window.PayloadArtifact.renderCompact) return Promise.resolve(p);', '']);
    refresh();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls.map((c) => c.url)).toEqual(['/api/payloads?limit=30&status=ready', '/api/payloads/pl_1']);
  });

  test('the lifted strip is the real function (anchors found)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(fnAt).toBeGreaterThan(start);
    expect(endAt).toBeGreaterThan(fnAt);
    expect(body).toContain('renderCompact');
  });

  test('a row with a draft_summary is drawn compact with NO per-row fetch; a row without one is hydrated', async () => {
    document.body.innerHTML = '<div id="ai-pending-approvals"></div>';
    responses['GET /api/payloads?limit=30&status=ready'] = { payloads: [ROW, { id: 'pl_2', status: 'ready', title: 'Old draft' }] };
    responses['GET /api/payloads/pl_2'] = { payload: { id: 'pl_2', status: 'ready', title: 'Old draft', targets: [] } };
    const refresh = strip();
    refresh();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls.map((c) => c.url)).toEqual(['/api/payloads?limit=30&status=ready', '/api/payloads/pl_2']);
    const hostEl = document.getElementById('ai-pending-approvals');
    expect(hostEl.querySelectorAll('.p86-payload-compact')).toHaveLength(1);
    expect(hostEl.textContent).toContain('status → sold');
  });

  test('an unchanged list is not rebuilt — an open Details view survives the poll', async () => {
    document.body.innerHTML = '<div id="ai-pending-approvals"></div>';
    responses['GET /api/payloads?limit=30&status=ready'] = { payloads: [ROW] };
    const refresh = strip();
    refresh();
    for (let i = 0; i < 5; i++) await flush();
    const first = document.querySelector('.p86-payload-compact');
    refresh();
    for (let i = 0; i < 5; i++) await flush();
    expect(document.querySelector('.p86-payload-compact')).toBe(first);
  });
});
