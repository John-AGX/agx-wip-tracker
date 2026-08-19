/* ──────────────────────────────────────────────────────────────────────────
 * PUSH SURVIVES A VAPID KEY ROTATION
 *
 * A rotate button shipped in a491d59. Rotating the platform VAPID pair
 * invalidates EVERY push subscription in existence, because each one was
 * minted by the browser against the OLD public key — and until this change
 * the product had no recovery path at all:
 *
 *   · server/push.js caches the pair (`if (_configured) return true` before
 *     the table read), so the row-delete only lands at the next boot;
 *   · sendPush prunes only on 404/410 and a key mismatch is neither, so the
 *     dead rows survive forever;
 *   · sw.js has no `pushsubscriptionchange` handler;
 *   · the bell reveals itself only when getSubscription() resolves EMPTY, and
 *     after a rotation the browser still holds its unusable subscription — so
 *     the bell stayed hidden and enablePush()'s empty `.catch(function(){})`
 *     swallowed the InvalidStateError that would have named the problem.
 *
 * WHY THIS FILE REQUIRES js/agent-tasks.js DIRECTLY. The decision being
 * tested is the one the browser makes. Mirroring it here would leave a copy
 * passing forever while the shipped one rotted, so the recovery core is
 * exported from the file that ships and required from it.
 *
 * WHAT THESE TESTS ARE ACTUALLY PROTECTING. Not the rotation — the 99.9% of
 * devices that are FINE. A recovery path that fires spuriously would break
 * push for everyone in order to fix it for nobody, so the no-op case is
 * asserted first and asserted by CALL COUNT: a healthy device makes zero
 * network calls and zero subscription changes. Every "I cannot tell" state
 * resolves to that same no-op on purpose.
 *
 * The second thing they protect is the window between the unsubscribe and the
 * re-subscribe. `unsubscribe` is forced to come first (the browser rejects
 * subscribe() with a different applicationServerKey while one is held), so
 * "silently unsubscribed and not re-subscribed" is a reachable physical state
 * — the tests pin that it is never a SILENT or a PERMANENT one.
 * ────────────────────────────────────────────────────────────────────────── */

const R = require('../js/agent-tasks.js');

// ── fixtures ──────────────────────────────────────────────────────────────
// Two well-formed P-256 public keys: 65 bytes, leading 0x04 (uncompressed).
function makeKeyBytes(seed) {
  const b = new Uint8Array(65);
  b[0] = 0x04;
  for (let i = 1; i < 65; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const KEY_A = makeKeyBytes(1);
const KEY_B = makeKeyBytes(2);
const KEY_A_B64 = b64url(KEY_A);
const KEY_B_B64 = b64url(KEY_B);

// A real PushSubscription hands back an ArrayBuffer, not a Uint8Array.
function toArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
function makeSub(keyBytes, endpoint) {
  return {
    endpoint: endpoint || 'https://push.example/old',
    options: keyBytes === 'no-options' ? undefined
      : { userVisibleOnly: true, applicationServerKey: keyBytes === null ? null : toArrayBuffer(keyBytes) },
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }
  };
}

// The io harness. Every effect is counted and every call is appended to one
// ordered log, so "did anything happen at all" and "in what order" are both
// directly assertable.
function harness(opts) {
  const o = opts || {};
  const calls = [];
  const logs = [];
  let pending = !!o.pending;
  const io = {
    permission: o.permission === undefined ? 'granted' : o.permission,
    configured: o.configured === undefined ? true : o.configured,
    serverKey: o.serverKey === undefined ? KEY_A_B64 : o.serverKey,
    isPending() { return pending; },
    setPending(v) { calls.push('setPending:' + !!v); pending = !!v; },
    getSubscription() { calls.push('getSubscription'); return Promise.resolve(o.sub === undefined ? null : o.sub); },
    subscribe(bytes) {
      calls.push('subscribe');
      io.subscribedWith = bytes;
      if (o.subscribeFails && calls.filter(c => c === 'subscribe').length <= o.subscribeFails) {
        return Promise.reject(Object.assign(new Error('nope'), { name: 'InvalidStateError' }));
      }
      if (o.subscribeEmpty) return Promise.resolve(null);
      return Promise.resolve(makeSub(KEY_B, 'https://push.example/new'));
    },
    unsubscribe(s) {
      calls.push('unsubscribe:' + s.endpoint);
      return o.unsubscribeFails ? Promise.reject(new Error('unsub failed')) : Promise.resolve(true);
    },
    saveSubscription(json) {
      calls.push('saveSubscription:' + json.endpoint);
      return o.saveFails ? Promise.reject(new Error('HTTP 500')) : Promise.resolve();
    },
    dropSubscription(ep) {
      calls.push('dropSubscription:' + ep);
      return o.dropFails ? Promise.reject(new Error('HTTP 500')) : Promise.resolve();
    },
    log(level, msg, err) { logs.push({ level, msg, err }); }
  };
  return {
    io, calls, logs,
    pending: () => pending,
    run: () => R.reconcile(io),
    errors: () => logs.filter(l => l.level === 'error')
  };
}

// Every effect that mutates something. Used by the no-op assertions.
const MUTATING = c =>
  c.startsWith('subscribe') || c.startsWith('unsubscribe') ||
  c.startsWith('saveSubscription') || c.startsWith('dropSubscription') ||
  c.startsWith('setPending');

// ══════════════════════════════════════════════════════════════════════════
// 1. THE NO-OP. This is the test that protects everyone who is fine today.
// ══════════════════════════════════════════════════════════════════════════
describe('a device whose key already matches is left completely alone', () => {
  test('matching key → zero network calls, zero subscription changes', async () => {
    const h = harness({ sub: makeSub(KEY_A) });
    const r = await h.run();
    expect(r.action).toBe('noop');
    // The whole point: nothing but the read it was already going to do.
    expect(h.calls).toEqual(['getSubscription']);
    expect(h.calls.filter(MUTATING)).toEqual([]);
    expect(h.pending()).toBe(false);
    expect(h.errors()).toEqual([]);
  });

  // The comparison runs on raw bytes precisely so these two cannot diverge.
  // Re-encoding the ArrayBuffer to a string would make padding and alphabet
  // load-bearing, and a wrong guess there is a SILENT false mismatch that
  // unsubscribes a healthy fleet.
  test('padding and the URL-safe alphabet do not manufacture a mismatch', async () => {
    const padded = Buffer.from(KEY_A).toString('base64');          // '+', '/', '='
    expect(padded).toMatch(/[+/=]/);                                // fixture is meaningful
    expect(R.keyState({ applicationServerKey: toArrayBuffer(KEY_A) }, padded)).toBe('match');
    expect(R.keyState({ applicationServerKey: toArrayBuffer(KEY_A) }, KEY_A_B64)).toBe('match');
    // and the same key must never read as matching a different one
    expect(R.keyState({ applicationServerKey: toArrayBuffer(KEY_A) }, KEY_B_B64)).toBe('mismatch');
  });

  test('a Uint8Array-valued applicationServerKey compares the same as an ArrayBuffer', () => {
    expect(R.keyState({ applicationServerKey: KEY_A }, KEY_A_B64)).toBe('match');
  });

  // One garbled /api/push/public-key response must not be able to unsubscribe
  // every device at once. A key that is not a well-formed P-256 point is
  // "cannot tell", never "mismatch".
  test('a malformed server key reads as unknown, not mismatch', () => {
    for (const bad of ['', 'not base64 !!!', b64url(new Uint8Array(10)), b64url(new Uint8Array(200))]) {
      expect(R.keyState({ applicationServerKey: toArrayBuffer(KEY_A) }, bad)).not.toBe('mismatch');
    }
  });

  test('a truncated server key changes nothing on the device', async () => {
    const h = harness({ sub: makeSub(KEY_A), serverKey: b64url(new Uint8Array(10)) });
    const r = await h.run();
    expect(r.action).toBe('unknown');
    expect(h.calls.filter(MUTATING)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. THE HEALING CASE.
// ══════════════════════════════════════════════════════════════════════════
describe('a rotated key is detected and repaired', () => {
  test('mismatch → unsubscribe, re-subscribe, new row saved, old row dropped', async () => {
    const h = harness({ sub: makeSub(KEY_A, 'https://push.example/old'), serverKey: KEY_B_B64 });
    const r = await h.run();
    expect(r.action).toBe('healed');
    expect(r.oldEndpoint).toBe('https://push.example/old');
    expect(r.endpoint).toBe('https://push.example/new');
    expect(h.calls).toEqual([
      'getSubscription',
      'setPending:true',                                  // marker BEFORE the destructive step
      'unsubscribe:https://push.example/old',             // forced first by the browser
      'subscribe',
      'saveSubscription:https://push.example/new',        // new row first…
      'setPending:false',
      'dropSubscription:https://push.example/old'         // …stale row second
    ]);
    expect(h.pending()).toBe(false);
  });

  test('it re-subscribes with the NEW key, not the old one', async () => {
    const h = harness({ sub: makeSub(KEY_A), serverKey: KEY_B_B64 });
    await h.run();
    expect(Array.from(h.io.subscribedWith)).toEqual(Array.from(KEY_B));
  });

  // Point 3: sendPush prunes only on 404/410, so nothing else ever removes
  // this row. The existing POST /api/push/unsubscribe is what removes it, and
  // it has to be called with the OLD endpoint — the subscribe upsert keys on
  // `endpoint`, and a re-subscribe mints a NEW endpoint, so the upsert cannot
  // replace the dead row on its own.
  test('the stale server row is dropped by endpoint, and only after the new one is safe', async () => {
    const h = harness({ sub: makeSub(KEY_A, 'https://push.example/old'), serverKey: KEY_B_B64 });
    await h.run();
    const save = h.calls.indexOf('saveSubscription:https://push.example/new');
    const drop = h.calls.indexOf('dropSubscription:https://push.example/old');
    expect(save).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(save);
  });

  test('a failure to drop the stale row still leaves the device healed', async () => {
    const h = harness({ sub: makeSub(KEY_A), serverKey: KEY_B_B64, dropFails: true });
    const r = await h.run();
    expect(r.action).toBe('healed');       // a dead row is cosmetic; a dead device is not
    expect(h.pending()).toBe(false);
  });

  test('a transient subscribe failure is retried once and then heals', async () => {
    const h = harness({ sub: makeSub(KEY_A), serverKey: KEY_B_B64, subscribeFails: 1 });
    const r = await h.run();
    expect(r.action).toBe('healed');
    expect(h.calls.filter(c => c === 'subscribe')).toHaveLength(2);
  });

  test('a failed unsubscribe does not stop the re-subscribe', async () => {
    const h = harness({ sub: makeSub(KEY_A), serverKey: KEY_B_B64, unsubscribeFails: true });
    const r = await h.run();
    expect(r.action).toBe('healed');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. ABSENT `options` — defined, safe, non-looping.
// ══════════════════════════════════════════════════════════════════════════
describe('when the browser will not say which key the subscription used', () => {
  test('missing options → no-op, and it says so instead of guessing', async () => {
    const h = harness({ sub: makeSub('no-options'), serverKey: KEY_B_B64 });
    const r = await h.run();
    expect(r.action).toBe('unknown');
    expect(h.calls.filter(MUTATING)).toEqual([]);          // never unsubscribe blindly
    expect(h.logs).toHaveLength(1);                        // visible, once
    expect(h.logs[0].msg).toMatch(/applicationServerKey/);
  });

  test('a null applicationServerKey is also unknown, not mismatch', async () => {
    const h = harness({ sub: makeSub(null), serverKey: KEY_B_B64 });
    const r = await h.run();
    expect(r.action).toBe('unknown');
    expect(h.calls.filter(MUTATING)).toEqual([]);
  });

  test('non-buffer junk in applicationServerKey is unknown, not mismatch', () => {
    for (const junk of ['BEl_abc', 12345, {}, [], true]) {
      expect(R.keyState({ applicationServerKey: junk }, KEY_A_B64)).toBe('unknown');
    }
  });

  // Non-looping: running it repeatedly stays in the same state, does not
  // escalate to a destructive branch, and does not accumulate server calls.
  test('repeating it never escalates and never calls the server', async () => {
    for (let i = 0; i < 5; i++) {
      const h = harness({ sub: makeSub('no-options'), serverKey: KEY_B_B64 });
      const r = await h.run();
      expect(r.action).toBe('unknown');
      expect(h.calls).toEqual(['getSubscription']);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. NEVER LEAVE A DEVICE WORSE OFF.
// ══════════════════════════════════════════════════════════════════════════
describe('a device cannot end up silently unsubscribed and not re-subscribed', () => {
  test('a failed re-subscribe is loud and leaves the marker set for the retry', async () => {
    const h = harness({ sub: makeSub(KEY_A), serverKey: KEY_B_B64, subscribeFails: 99 });
    const r = await h.run();
    expect(r.action).toBe('resubscribe-failed');
    expect(r.recoverable).toBe(true);
    // LOUD: an error a developer can find. The empty .catch() is the bug.
    expect(h.errors().length).toBeGreaterThan(0);
    expect(h.errors()[0].msg).toMatch(/RE-SUBSCRIBE FAILED/);
    // NOT PERMANENT: the marker survives so the next load repairs it.
    expect(h.pending()).toBe(true);
  });

  test('a browser that resolves subscribe() empty is treated as a failure too', async () => {
    const h = harness({ sub: makeSub(KEY_A), serverKey: KEY_B_B64, subscribeEmpty: true });
    const r = await h.run();
    expect(r.action).toBe('resubscribe-failed');
    expect(h.pending()).toBe(true);
    expect(h.errors().length).toBeGreaterThan(0);
  });

  // The self-correction, from the state the previous test leaves behind: the
  // page reloads, the browser now reports NO subscription, and the marker is
  // what distinguishes this device from someone who simply never opted in.
  test('the next page load repairs a device that was left unsubscribed', async () => {
    const h = harness({ sub: null, pending: true, serverKey: KEY_B_B64 });
    const r = await h.run();
    expect(r.action).toBe('healed');
    expect(h.calls).toContain('subscribe');
    expect(h.calls).not.toContain('unsubscribe');   // nothing left to unsubscribe
    expect(h.pending()).toBe(false);
  });

  // …and the same state for someone who simply never enabled push must NOT
  // subscribe them behind their back.
  test('no subscription and no marker means leave them alone', async () => {
    const h = harness({ sub: null, pending: false });
    const r = await h.run();
    expect(r.action).toBe('no-subscription');
    expect(h.calls).toEqual(['getSubscription']);
  });

  // The other partial failure: the browser re-subscribed but the POST failed,
  // so the device holds a good subscription the server has never heard of.
  test('a failed save keeps the marker so the row lands on the next load', async () => {
    const h = harness({ sub: makeSub(KEY_A), serverKey: KEY_B_B64, saveFails: true });
    const r = await h.run();
    expect(r.action).toBe('save-failed');
    expect(r.recoverable).toBe(true);
    expect(h.pending()).toBe(true);
    expect(h.errors().length).toBeGreaterThan(0);
  });

  test('and the next load re-posts it even though the key now matches', async () => {
    // KEY_B is now both the server key and the subscription's key: a "match"
    // that would otherwise be an unconditional no-op.
    const h = harness({ sub: makeSub(KEY_B, 'https://push.example/new'), serverKey: KEY_B_B64, pending: true });
    const r = await h.run();
    expect(r.action).toBe('server-row-repaired');
    expect(h.calls).toContain('saveSubscription:https://push.example/new');
    expect(h.calls).not.toContain('unsubscribe');   // still nothing destructive
    expect(h.pending()).toBe(false);
  });

  test('a rejected reconcile is reported, never swallowed', async () => {
    const h = harness({ sub: makeSub(KEY_A) });
    h.io.getSubscription = () => Promise.reject(new Error('boom'));
    const r = await h.run();
    expect(r.action).toBe('error');
    expect(r.recoverable).toBe(true);
    expect(h.errors().length).toBeGreaterThan(0);
  });

  // Sweep: across every failure permutation, the device is either fine or the
  // repair is still pending. "Quietly broken forever" must be unreachable.
  test('across every failure permutation the device is fine or still pending', async () => {
    const flags = ['subscribeFails', 'unsubscribeFails', 'saveFails', 'dropFails', 'subscribeEmpty'];
    for (let mask = 0; mask < (1 << flags.length); mask++) {
      const opts = { sub: makeSub(KEY_A), serverKey: KEY_B_B64 };
      flags.forEach((f, i) => { if (mask & (1 << i)) opts[f] = (f === 'subscribeFails' ? 99 : true); });
      const h = harness(opts);
      const r = await h.run();
      const settled = (r.action === 'healed' && !h.pending());
      const retryable = (h.pending() && h.errors().length > 0);
      expect(settled || retryable).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. USERS WITH PUSH DISABLED.
// ══════════════════════════════════════════════════════════════════════════
describe('nothing at all happens for a user who has not enabled push', () => {
  test('permission "default" → not even a subscription read, and no prompt', async () => {
    const h = harness({ permission: 'default', sub: makeSub(KEY_A), serverKey: KEY_B_B64 });
    const r = await h.run();
    expect(r.action).toBe('skipped-permission');
    expect(h.calls).toEqual([]);
  });

  test('permission "denied" → the same nothing', async () => {
    const h = harness({ permission: 'denied', sub: makeSub(KEY_A), serverKey: KEY_B_B64 });
    const r = await h.run();
    expect(r.action).toBe('skipped-permission');
    expect(h.calls).toEqual([]);
  });

  // A pending marker must not override the permission gate — a device whose
  // user revoked notifications is not a device to silently re-subscribe.
  test('a pending marker does not override revoked permission', async () => {
    const h = harness({ permission: 'denied', sub: null, pending: true, serverKey: KEY_B_B64 });
    const r = await h.run();
    expect(r.action).toBe('skipped-permission');
    expect(h.calls).toEqual([]);
    expect(h.pending()).toBe(true);
  });

  test('a server with VAPID unconfigured is a no-op', async () => {
    for (const opts of [{ configured: false }, { serverKey: null }]) {
      const h = harness(Object.assign({ sub: makeSub(KEY_A) }, opts));
      const r = await h.run();
      expect(r.action).toBe('skipped-unconfigured');
      expect(h.calls).toEqual([]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. SAFE TO SHIP BEFORE THE BUTTON IS PRESSED.
// ══════════════════════════════════════════════════════════════════════════
describe('on a tree where nothing has rotated this is a strict no-op', () => {
  test('every device in the fleet matches, so the fleet is untouched', async () => {
    // 50 devices, all healthy, all on the current key: not one mutating call.
    const all = [];
    for (let i = 0; i < 50; i++) {
      const h = harness({ sub: makeSub(KEY_A, 'https://push.example/dev' + i) });
      const r = await h.run();
      all.push({ r, mutating: h.calls.filter(MUTATING), errs: h.errors() });
    }
    expect(all.every(x => x.r.action === 'noop')).toBe(true);
    expect(all.flatMap(x => x.mutating)).toEqual([]);
    expect(all.flatMap(x => x.errs)).toEqual([]);
  });
});
