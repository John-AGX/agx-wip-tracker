// js/api.js — the Work Orders 1.29 client contract (shared contracts 5.1).
//
// The REAL js/api.js is evaluated with a stubbed fetch, and every assertion is
// on what reaches the wire: the URL, the method and the body. What changed:
//
//   * serviceTickets.setStatus(id, status, opts) still takes the old note
//     string, and now also an object whose known keys (and only those, and
//     only when defined) ride in the body — expected_status above all, which
//     is what lets the server refuse a move decided on an old screen.
//   * New serviceTickets wrappers for the 1.29 routes.
//   * jobs.remove(id, { confirmClosedTickets }) for the job delete guard.
//   * handleResponse errors carry retryAfter (seconds or null) next to status
//     and data, so an upload queue can wait as long as the server asked.
//   * attachments.upload(..., opts) passes opts.signal to fetch on BOTH the
//     geolocation path and the plain path, so a stalled upload can be aborted.
//
// Mutants: each guarded behaviour is re-run against a copy of the source with
// that behaviour removed, and must go red.

const fs = require('fs');
const os = require('os');
const path = require('path');

const API_PATH = path.join(__dirname, '..', 'js', 'api.js');
const SRC = fs.readFileSync(API_PATH, 'utf8');

function headersOf(map) {
  return {
    get(name) {
      const k = Object.keys(map || {}).find((h) => h.toLowerCase() === String(name).toLowerCase());
      return k === undefined ? null : map[k];
    },
  };
}

function response(status, body, headers, opts) {
  const r = {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))),
  };
  if (!(opts && opts.noHeaders)) r.headers = headersOf(headers);
  return r;
}

function loadApi(src, env) {
  env = env || {};
  const calls = [];
  const win = Object.assign({ p86Auth: { getToken: () => 'tok_1', isOffline: () => false } }, env.window || {});
  const localStorage = { getItem: () => null, removeItem: () => {} };
  const location = { reload: jest.fn() };
  const fetch = jest.fn((url, init) => {
    calls.push({ url, init: init || {} });
    // Like the real fetch: a failure is a rejected promise, never a throw.
    return Promise.resolve().then(() => (env.respond ? env.respond(url, init) : response(200, { ok: true })));
  });
  // eslint-disable-next-line no-new-func
  new Function('window', 'localStorage', 'location', 'fetch', src)(win, localStorage, location, fetch);
  return { api: win.p86Api, calls, win };
}

function wire(call) {
  const init = call.init || {};
  let body;
  if (typeof init.body === 'string') body = JSON.parse(init.body);
  return { method: init.method || 'GET', url: call.url, body };
}

// R5 mutants: a copy of the source in a temp dir, CRLF-normalised, one exact
// anchor, one change.
function mutant(anchor, replacement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-mutant-'));
  const copy = path.join(dir, 'api.js');
  fs.writeFileSync(copy, SRC);
  const src = fs.readFileSync(copy, 'utf8').replace(/\r\n/g, '\n');
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error('anchor not found');
  const out = src.replace(anchor, replacement);
  // A mutant that no longer parses would go "red" for the wrong reason.
  // eslint-disable-next-line no-new-func
  new Function('window', 'localStorage', 'location', 'fetch', out);
  return out;
}

async function mustFail(check) {
  let threw = false;
  try { await check(); } catch (e) { threw = true; }
  expect(threw).toBe(true);
}

// ── setStatus ────────────────────────────────────────────────────────────
async function checkLegacyNote(src) {
  const { api, calls } = loadApi(src);
  await api.serviceTickets.setStatus('st_1', 'in_progress', 'On my way');
  await api.serviceTickets.setStatus('st_1', 'closed');
  expect(calls.map(wire)).toEqual([
    { method: 'POST', url: '/api/service-tickets/st_1/status', body: { status: 'in_progress', note: 'On my way' } },
    { method: 'POST', url: '/api/service-tickets/st_1/status', body: { status: 'closed', note: '' } },
  ]);
}

async function checkObjectOpts(src) {
  const { api, calls } = loadApi(src);
  await api.serviceTickets.setStatus('st 1', 'work_complete', {
    reason: 'Bldg 790 rail is loose',
    expected_status: 'in_progress',
    override: true,
    copy_scope: false,
    reopen_tasks: [{ id: 'tk_790', note: 'rail' }, 'tk_784'],
    note: undefined,
    junk: 'never sent',
    price: 1200,
  });
  expect(calls.map(wire)).toEqual([{
    method: 'POST',
    url: '/api/service-tickets/st%201/status',
    body: {
      status: 'work_complete',
      reason: 'Bldg 790 rail is loose',
      expected_status: 'in_progress',
      override: true,
      copy_scope: false,
      reopen_tasks: [{ id: 'tk_790', note: 'rail' }, 'tk_784'],
    },
  }]);
  // A move with no expected_status sends none (not null).
  await api.serviceTickets.setStatus('st_1', 'approved', { reason: 'ok' });
  const second = JSON.parse(calls[1].init.body);
  expect(second).toEqual({ status: 'approved', reason: 'ok' });
  expect(Object.prototype.hasOwnProperty.call(second, 'expected_status')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(second, 'note')).toBe(false);
}

describe('serviceTickets.setStatus', () => {
  test('the legacy note string still sends { status, note }', () => checkLegacyNote(SRC));

  test('an object sends status plus only the known keys that are defined', () => checkObjectOpts(SRC));

  test('the note key is sent when the object carries one', async () => {
    const { api, calls } = loadApi(SRC);
    await api.serviceTickets.setStatus('st_1', 'cancelled', { note: 'dup of WO-0006', expected_status: 'open' });
    expect(wire(calls[0]).body).toEqual({ status: 'cancelled', note: 'dup of WO-0006', expected_status: 'open' });
  });

  test('MUTANT: passing every key of the object through goes red', async () => {
    const src = mutant(
      "['reason', 'note', 'expected_status', 'override', 'override_time', 'copy_scope', 'reopen_tasks'].forEach(function(k) {",
      'Object.keys(opts).forEach(function(k) {');
    await mustFail(() => checkObjectOpts(src));
  });

  test('MUTANT: dropping the legacy string branch goes red', async () => {
    const src = mutant("        body.note = opts || '';\n", '');
    await mustFail(() => checkLegacyNote(src));
  });
});

// ── New wrappers ─────────────────────────────────────────────────────────
describe('serviceTickets 1.29 wrappers reach the documented routes', () => {
  test('each wrapper: method, URL and body', async () => {
    const { api, calls } = loadApi(SRC);
    const st = api.serviceTickets;
    await st.assignees('job', 'job 77');
    await st.assignees('lead', 'ld_9');
    await st.notifyApprovers('st_1');
    await st.resolveFlag('st_1', 'fl/2', 'Gate code was wrong, fixed');
    await st.resolveFlag('st_1', 'fl_3');
    await st.startChangeOrder('st_1', { task_id: 'tk_790', photos: ['att_1'] });
    await st.startChangeOrder('st_1');
    await st.workOrderPrint('st_1');
    await st.completionReport('st_1', { includeNotes: true });
    await st.completionReport('st_1', { includeNotes: false });
    await st.completionReport('st_1');
    await st.sendCompletionReport('st_1', { to: 'pm@example.com', include_notes: true });
    await st.revokeCompletionReport('st_1', 'rs 9');
    expect(calls.map(wire)).toEqual([
      { method: 'GET', url: '/api/service-tickets/assignees/job/job%2077', body: undefined },
      { method: 'GET', url: '/api/service-tickets/assignees/lead/ld_9', body: undefined },
      { method: 'POST', url: '/api/service-tickets/st_1/notify-approvers', body: {} },
      { method: 'POST', url: '/api/service-tickets/st_1/flags/fl%2F2/resolve', body: { note: 'Gate code was wrong, fixed' } },
      { method: 'POST', url: '/api/service-tickets/st_1/flags/fl_3/resolve', body: { note: '' } },
      { method: 'POST', url: '/api/service-tickets/st_1/change-orders', body: { task_id: 'tk_790', photos: ['att_1'] } },
      { method: 'POST', url: '/api/service-tickets/st_1/change-orders', body: {} },
      { method: 'GET', url: '/api/service-tickets/st_1/print/work-order', body: undefined },
      { method: 'GET', url: '/api/service-tickets/st_1/completion-report?include_notes=1', body: undefined },
      { method: 'GET', url: '/api/service-tickets/st_1/completion-report?include_notes=0', body: undefined },
      { method: 'GET', url: '/api/service-tickets/st_1/completion-report?include_notes=0', body: undefined },
      { method: 'POST', url: '/api/service-tickets/st_1/completion-report/send', body: { to: 'pm@example.com', include_notes: true } },
      { method: 'POST', url: '/api/service-tickets/st_1/completion-report/shares/rs%209/revoke', body: {} },
    ]);
  });

  test('list(params) still passes any params through, skipping empty ones', async () => {
    const { api, calls } = loadApi(SRC);
    await api.serviceTickets.list({ board: 1, view: 'my_approvals', q: '', status: null, job_id: 'job 7', flags: undefined });
    expect(calls[0].url).toBe('/api/service-tickets?board=1&view=my_approvals&job_id=job%207');
  });
});

// ── jobs.remove ──────────────────────────────────────────────────────────
describe('jobs.remove(id, opts)', () => {
  test('confirm_closed_tickets is appended only when confirmClosedTickets is given', async () => {
    const { api, calls } = loadApi(SRC);
    await api.jobs.remove('job_1');
    await api.jobs.remove('job_1', {});
    await api.jobs.remove('job 1', { confirmClosedTickets: 3 });
    await api.jobs.remove('job_1', { confirmClosedTickets: 0 });
    await api.jobs.remove('job_1', { confirmClosedTickets: null });
    expect(calls.map(wire)).toEqual([
      { method: 'DELETE', url: '/api/jobs/job_1', body: undefined },
      { method: 'DELETE', url: '/api/jobs/job_1', body: undefined },
      { method: 'DELETE', url: '/api/jobs/job%201?confirm_closed_tickets=3', body: undefined },
      { method: 'DELETE', url: '/api/jobs/job_1?confirm_closed_tickets=0', body: undefined },
      { method: 'DELETE', url: '/api/jobs/job_1', body: undefined },
    ]);
  });
});

// ── handleResponse: status, data, retryAfter ─────────────────────────────
async function errorFor(src, res) {
  const { api } = loadApi(src, { respond: () => res });
  try {
    await api.get('/api/anything');
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

async function checkRetryAfter(src) {
  const a = await errorFor(src, response(429, { error: 'Too many uploads. Wait a moment.', retryAfter: 99 }, { 'Retry-After': '12' }));
  expect([a.message, a.status, a.data, a.retryAfter]).toEqual(['Too many uploads. Wait a moment.', 429, { error: 'Too many uploads. Wait a moment.', retryAfter: 99 }, 12]);
  const b = await errorFor(src, response(429, { error: 'Slow down', retryAfter: 7 }, {}));
  expect([b.status, b.retryAfter]).toEqual([429, 7]);
}

describe('handleResponse errors carry status, data and retryAfter', () => {
  test('the Retry-After header wins; the body retryAfter is the fallback', () => checkRetryAfter(SRC));

  test('no hint at all is null, and status/data are still there', async () => {
    const e = await errorFor(SRC, response(500, { error: 'Something went wrong uploading that.' }, {}));
    expect([e.message, e.status, e.data, e.retryAfter]).toEqual(['Something went wrong uploading that.', 500, { error: 'Something went wrong uploading that.' }, null]);
  });

  test('an unreadable 503 body still carries the header', async () => {
    const e = await errorFor(SRC, response(503, '<html>Service Unavailable</html>', { 'retry-after': '5' }));
    expect([e.message, e.status, e.retryAfter]).toEqual(['HTTP 503', 503, 5]);
  });

  test('an HTTP-date Retry-After becomes seconds from now', async () => {
    const when = new Date(Date.now() + 20000).toUTCString();
    const e = await errorFor(SRC, response(429, { error: 'Busy' }, { 'Retry-After': when }));
    expect(e.retryAfter).toBeGreaterThanOrEqual(18);
    expect(e.retryAfter).toBeLessThanOrEqual(21);
  });

  test('a response with no headers object (older test doubles) does not throw', async () => {
    const e = await errorFor(SRC, response(410, { error: 'This link has been turned off.' }, null, { noHeaders: true }));
    expect([e.message, e.status, e.retryAfter]).toEqual(['This link has been turned off.', 410, null]);
  });

  test('a success still resolves the body', async () => {
    const { api } = loadApi(SRC, { respond: () => response(200, { ok: true, ticket: { id: 'st_1' } }, { 'Retry-After': '9' }) });
    await expect(api.get('/api/x')).resolves.toEqual({ ok: true, ticket: { id: 'st_1' } });
  });

  test('the status and data lines test/org-divergence-count.test.js reads are kept', () => {
    expect(SRC).toMatch(/err\.status = r\.status;/);
    expect(SRC).toMatch(/err\.data = data;/);
  });

  test('MUTANT: not stamping retryAfter goes red', async () => {
    const src = mutant('        err.retryAfter = retryAfterOf(r, data);\n', '');
    await mustFail(() => checkRetryAfter(src));
  });
});

// ── Upload abort signal ──────────────────────────────────────────────────
function formFields(fd) {
  const out = {};
  for (const [k, v] of fd.entries()) out[k] = typeof v === 'string' ? v : '[file:' + v.name + ']';
  return out;
}

async function checkSignalPlain(src) {
  const { api, calls } = loadApi(src);
  const ctrl = new AbortController();
  const file = new File(['abc'], 'IMG_1.jpg', { type: 'image/jpeg' });
  await api.attachments.upload('task', 'tk_784', file, { tags: 'before', upload_id: 'u0123456789abcdef' }, { signal: ctrl.signal });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('/api/attachments/task/tk_784');
  expect(calls[0].init.method).toBe('POST');
  expect(calls[0].init.signal).toBe(ctrl.signal);
  expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer tok_1' });
  expect(formFields(calls[0].init.body)).toEqual({ file: '[file:IMG_1.jpg]', tags: 'before', upload_id: 'u0123456789abcdef' });
}

async function checkSignalGeo(src) {
  const { api, calls } = loadApi(src, {
    window: { p86Geo: { get: jest.fn(() => Promise.resolve({ lat: 28.5, lng: -81.4, accuracy: 12 })) } },
  });
  const ctrl = new AbortController();
  const file = new File(['abc'], 'IMG_2.jpg', { type: 'image/jpeg' });
  await api.attachments.upload('task', 'tk_790', file, { tags: 'completion', upload_id: 'ufedcba9876543210' }, { signal: ctrl.signal });
  expect(calls).toHaveLength(1);
  expect(calls[0].init.signal).toBe(ctrl.signal);
  expect(formFields(calls[0].init.body)).toEqual({
    file: '[file:IMG_2.jpg]', tags: 'completion', upload_id: 'ufedcba9876543210', lat: '28.5', lng: '-81.4', geo_accuracy: '12',
  });
}

describe('attachments.upload forwards opts.signal to fetch', () => {
  test('the plain path (no geolocation helper)', () => checkSignalPlain(SRC));

  test('the geolocation path', () => checkSignalGeo(SRC));

  test('no opts means no signal key, exactly as before', async () => {
    const { api, calls } = loadApi(SRC);
    await api.attachments.upload('job', 'job_1', new File(['x'], 'a.pdf', { type: 'application/pdf' }), { folder: 'Docs' });
    expect(Object.prototype.hasOwnProperty.call(calls[0].init, 'signal')).toBe(false);
  });

  test('an aborted signal really stops the request', async () => {
    const { api } = loadApi(SRC, {
      respond: (url, init) => {
        if (init.signal && init.signal.aborted) {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          throw e;
        }
        return response(200, { ok: true });
      },
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(api.attachments.upload('task', 'tk_1', new File(['x'], 'b.jpg', { type: 'image/jpeg' }), {}, { signal: ctrl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  test('MUTANT: uploadFile not setting the signal goes red', async () => {
    const src = mutant('    if (opts && opts.signal) init.signal = opts.signal;\n', '');
    await mustFail(() => checkSignalPlain(src));
  });

  test('MUTANT: the geolocation path dropping opts goes red', async () => {
    const src = mutant(
      '        delete extra.geo;\n        return uploadFile(path, file, extra, opts);\n      });',
      '        delete extra.geo;\n        return uploadFile(path, file, extra);\n      });');
    await mustFail(() => checkSignalGeo(src));
  });
});
