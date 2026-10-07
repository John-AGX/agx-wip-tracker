/**
 * @jest-environment jsdom
 */
/* ═══════════════════════════════════════════════════════════════════════════
 * THE 401 HANDLER CLEARED THE WRONG CREDENTIAL AND RELOADED FOREVER.
 *
 * server/auth.js:267 reads the credential COOKIE FIRST:
 *
 *     const token = req.cookies?.token || req.headers.authorization?.replace(...)
 *
 * and that cookie is set httpOnly (server/routes/auth-routes.js:94), so no
 * amount of client-side work can remove it. The 401 branch in js/api.js
 * removed `p86-auth-token` from localStorage — the credential the server reads
 * SECOND, and only when the cookie is absent — and then called
 * location.reload(). The reload sent the same untouched cookie, got the same
 * 401, and reloaded again. The login screen never rendered, because nothing in
 * the boot path ever ran far enough to show it.
 *
 * Rotating JWT_SECRET on 2026-10-07 did this to every open session at once:
 * every cookie in every browser was signed with the previous secret, so every
 * user hit the loop simultaneously, and the only escape was clearing site data
 * by hand — which nobody knows to do.
 *
 * THE FIX, AND WHY EACH HALF IS LOAD-BEARING:
 *
 *   POST /api/auth/logout clears the cookie. It carries no auth middleware,
 *   deliberately — its own comment in auth-routes.js explains the route "must
 *   not" verify the token — which is precisely what lets a dead credential
 *   clear itself. Without this call, the reload is the bug.
 *
 *   A ONE-SHOT sessionStorage guard. If the clear does not take — the request
 *   fails, a proxy eats it, the route moves — the page must stop reloading and
 *   let the error reach the caller. Without this, the fix merely moves the loop
 *   behind a network call.
 *
 * Both halves are driven below. The function under test is LIFTED OUT OF THE
 * SHIPPED FILE, because a model of buggy code stays green exactly as long as
 * the bug lives.
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn.js');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const API_SRC = read('js/api.js');
const AUTH_SRC = read('js/auth.js');
const SERVER_AUTH = read('server/auth.js');
const AUTH_ROUTES = read('server/routes/auth-routes.js');

/* A tab: its storages, its location, and what it asked the network for. */
function makeTab(opts) {
  opts = opts || {};
  const rec = { reloads: 0, fetches: [], removed: [] };
  const local = { 'p86-auth-token': 'stale.jwt.value' };
  const session = Object.assign({}, opts.session || {});

  const localStorage = {
    getItem: (k) => (k in local ? local[k] : null),
    setItem: (k, v) => { local[k] = String(v); },
    removeItem: (k) => { rec.removed.push(k); delete local[k]; },
  };
  const sessionStorage = {
    getItem: (k) => (k in session ? session[k] : null),
    setItem: (k, v) => { session[k] = String(v); },
    removeItem: (k) => { delete session[k]; },
  };
  const location = { reload: () => { rec.reloads++; } };
  const fetch = (url, init) => {
    rec.fetches.push({ url, method: (init && init.method) || 'GET', credentials: init && init.credentials });
    return opts.logoutFails ? Promise.reject(new Error('network')) : Promise.resolve({ ok: true });
  };

  const handleResponse = compile(
    [extractFunction(API_SRC, 'handleResponse')],
    ['localStorage', 'sessionStorage', 'location', 'fetch', 'retryAfterOf'],
    [localStorage, sessionStorage, location, fetch, () => null],
    'handleResponse'
  );

  return { rec, local, session, handleResponse };
}

const unauthorized = () => ({ status: 401 });

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE PREMISE — the cookie is what the server reads, and JS cannot touch it
 * ══════════════════════════════════════════════════════════════════════════*/
describe('why clearing localStorage alone could never work', () => {
  test('the server reads the COOKIE first, the header only as a fallback', () => {
    expect(SERVER_AUTH).toContain("req.cookies?.token || req.headers.authorization?.replace('Bearer ', '')");
  });

  test('and that cookie is httpOnly, so no client code can remove it', () => {
    expect(AUTH_ROUTES).toMatch(/res\.cookie\('token', token, \{ httpOnly: true/);
  });

  test('the logout route clears it and requires no auth — the only way out', () => {
    // If this route ever grows an auth middleware, the fix silently dies: a
    // dead credential could no longer clear itself and the loop returns.
    const i = AUTH_ROUTES.indexOf("router.post('/logout'");
    expect(i).toBeGreaterThan(-1);
    const decl = AUTH_ROUTES.slice(i, i + 120);
    expect(decl).toContain("router.post('/logout', (req, res)");
    expect(decl).not.toContain('requireAuth');
    expect(AUTH_ROUTES.slice(i, i + 200)).toContain("res.clearCookie('token')");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. THE FIRST 401 — clear both credentials, then reload
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the first 401 in a tab', () => {
  test('throws a readable error rather than returning a broken body', () => {
    const t = makeTab();
    expect(() => t.handleResponse(unauthorized())).toThrow('Session expired');
  });

  test('removes the stored token', () => {
    const t = makeTab();
    try { t.handleResponse(unauthorized()); } catch (_) {}
    expect(t.rec.removed).toContain('p86-auth-token');
    expect(t.local['p86-auth-token']).toBeUndefined();
  });

  test('ASKS THE SERVER TO CLEAR THE COOKIE — the half that was missing', async () => {
    const t = makeTab();
    try { t.handleResponse(unauthorized()); } catch (_) {}
    await Promise.resolve(); await Promise.resolve();
    expect(t.rec.fetches).toHaveLength(1);
    expect(t.rec.fetches[0].url).toBe('/api/auth/logout');
    expect(t.rec.fetches[0].method).toBe('POST');
    // without credentials:'include' the cookie is not sent, so the server has
    // nothing to clear and the loop survives the fix
    expect(t.rec.fetches[0].credentials).toBe('include');
  });

  test('reloads only AFTER the clear has been attempted, never before', async () => {
    const t = makeTab();
    try { t.handleResponse(unauthorized()); } catch (_) {}
    expect(t.rec.reloads).toBe(0);                 // not synchronously
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(t.rec.reloads).toBe(1);
  });

  test('still reloads when the clear request fails — best effort, not a gate', async () => {
    const t = makeTab({ logoutFails: true });
    try { t.handleResponse(unauthorized()); } catch (_) {}
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(t.rec.reloads).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. THE SECOND 401 — the loop is capped
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a tab that has already reloaded once', () => {
  test('DOES NOT RELOAD AGAIN — this is the loop guard', async () => {
    const t = makeTab({ session: { 'p86-401-reloaded': '1' } });
    try { t.handleResponse(unauthorized()); } catch (_) {}
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(t.rec.reloads).toBe(0);
  });

  test('and does not re-ask the server either', async () => {
    const t = makeTab({ session: { 'p86-401-reloaded': '1' } });
    try { t.handleResponse(unauthorized()); } catch (_) {}
    await Promise.resolve(); await Promise.resolve();
    expect(t.rec.fetches).toEqual([]);
  });

  test('but still clears the token and still throws, so the caller can react', () => {
    const t = makeTab({ session: { 'p86-401-reloaded': '1' } });
    expect(() => t.handleResponse(unauthorized())).toThrow('Session expired');
    expect(t.rec.removed).toContain('p86-auth-token');
  });

  test('the flag is set on the FIRST 401, which is what makes it one-shot', () => {
    const t = makeTab();
    try { t.handleResponse(unauthorized()); } catch (_) {}
    expect(t.session['p86-401-reloaded']).toBe('1');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. A FRESH LOGIN RE-ARMS IT
 * ══════════════════════════════════════════════════════════════════════════*/
describe('signing in clears the guard', () => {
  test('so a later expiry still bounces to login exactly once', () => {
    // Otherwise the first expiry of a long session is treated as the loop this
    // tab already survived, and the user sits on a dead page.
    const doLogin = extractFunction(AUTH_SRC, 'doLogin');
    expect(doLogin).toContain("sessionStorage.removeItem('p86-401-reloaded')");
    // and it happens where the token is stored, not somewhere it can drift from
    const at = doLogin.indexOf("localStorage.setItem('p86-auth-token'");
    const clear = doLogin.indexOf("sessionStorage.removeItem('p86-401-reloaded')");
    expect(at).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(at);
    expect(clear - at).toBeLessThan(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. EVERY STORAGE CALL IS GUARDED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('storage that throws cannot break the bounce', () => {
  // sessionStorage throws outright in some privacy modes. If that propagated,
  // a 401 would take the page down instead of returning the user to login.
  function hostileTab() {
    const rec = { reloads: 0, fetches: [] };
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    const handleResponse = compile(
      [extractFunction(API_SRC, 'handleResponse')],
      ['localStorage', 'sessionStorage', 'location', 'fetch', 'retryAfterOf'],
      [
        { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        throwing,
        { reload: () => { rec.reloads++; } },
        (u, i) => { rec.fetches.push(u); return Promise.resolve({ ok: true }); },
        () => null,
      ],
      'handleResponse'
    );
    return { rec, handleResponse };
  }

  test('a throwing sessionStorage still produces the session-expired error', () => {
    const t = hostileTab();
    expect(() => t.handleResponse(unauthorized())).toThrow('Session expired');
  });

  test('and still reloads — a private window must not be stranded', async () => {
    const t = hostileTab();
    try { t.handleResponse(unauthorized()); } catch (_) {}
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(t.rec.reloads).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. NON-401 RESPONSES ARE UNTOUCHED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the rest of handleResponse is unchanged', () => {
  test('a success still parses its body', async () => {
    const t = makeTab();
    const r = { status: 200, ok: true, text: () => Promise.resolve('{"a":1}') };
    await expect(t.handleResponse(r)).resolves.toEqual({ a: 1 });
    expect(t.rec.reloads).toBe(0);
    expect(t.rec.fetches).toEqual([]);
  });

  test('a 500 does not clear credentials or reload', async () => {
    const t = makeTab();
    const r = { status: 500, ok: false, headers: { get: () => null }, text: () => Promise.resolve('') };
    await expect(t.handleResponse(r)).rejects.toThrow();
    expect(t.rec.reloads).toBe(0);
    expect(t.rec.removed).toEqual([]);
  });

  test('a 403 is not treated as a session problem', async () => {
    const t = makeTab();
    const r = { status: 403, ok: false, headers: { get: () => null }, text: () => Promise.resolve('{"error":"nope"}') };
    await expect(t.handleResponse(r)).rejects.toThrow();
    expect(t.rec.reloads).toBe(0);
    expect(t.rec.removed).toEqual([]);
  });
});
