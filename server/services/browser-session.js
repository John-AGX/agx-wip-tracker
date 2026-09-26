// ─────────────────────────────────────────────────────────────────────────
// Browser sessions — a real Chromium that 86 can hold open across tool calls.
//
// report-pdf.js already proves headless Chromium runs in our container, but it
// opens a browser and closes it inside one `finally`. An agent needs the page
// to SURVIVE between tool calls: open a URL on one turn, read it on the next,
// screenshot it on a third. That persistence is the only thing this file adds
// on top of what report-pdf already does — plus the guards that persistence
// makes necessary.
//
// THE SECURITY PROBLEM THIS FILE EXISTS TO SOLVE
// ----------------------------------------------
// `web_fetch` (WEB_TOOLS in ai-routes) is safe because ANTHROPIC performs the
// fetch — it happens outside our network. This file is the opposite: the
// request leaves OUR container, from inside OUR private network, holding OUR
// egress. A model that can name a URL can therefore reach:
//
//   http://127.0.0.1:PORT/...        our own API, with no auth hop
//   http://169.254.169.254/...       cloud instance metadata (credentials)
//   http://10.x / 172.16.x / 192.168.x   anything else on the private network
//
// That is textbook SSRF, and the "attacker" does not have to be a person: a
// web page we already opened can contain text telling the model to navigate
// somewhere. So the host check below is not advisory — every navigation
// resolves DNS first and refuses any address that is not publicly routable.
//
// Chromium's own sandbox is OFF (--no-sandbox, as in report-pdf: containers do
// not grant the namespaces it needs). The container is therefore the security
// boundary, which is exactly why this service should eventually run as its own
// Railway service with no DATABASE_URL / ANTHROPIC_API_KEY / R2 creds in its
// env. Until it does, treat everything here as running next to those secrets.
// ─────────────────────────────────────────────────────────────────────────

const dns = require('dns').promises;
const net = require('net');

// Chromium is heavy: ~300-500MB resident per instance. Two concurrent sessions
// is a deliberate ceiling, not a placeholder — a browser-happy hour must not
// evict the app that owns the container.
const MAX_SESSIONS = Number(process.env.P86_BROWSER_MAX_SESSIONS || 2);
const IDLE_MS = Number(process.env.P86_BROWSER_IDLE_MS || 5 * 60 * 1000);
const HARD_MS = Number(process.env.P86_BROWSER_HARD_MS || 15 * 60 * 1000);
const NAV_TIMEOUT_MS = 30000;
const MAX_TEXT = 60000;   // one page should not eat an entire context window

// Optional per-deploy allowlist. Empty = any PUBLIC host (private ranges are
// refused regardless — the allowlist narrows, it never widens).
const ALLOWLIST = String(process.env.P86_BROWSER_ALLOWLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

let _puppeteer = null;
let _browser = null;
const _sessions = new Map();   // id -> { page, orgId, userId, url, createdAt, lastUsedAt }
let _seq = 0;

// report-pdf resolves puppeteer the same way and degrades with a clear message
// rather than a stack trace, because the browser binary is supplied by the
// buildpack and is not guaranteed on every deploy.
function puppeteerOrNull() {
  if (_puppeteer !== null) return _puppeteer;
  try { _puppeteer = require('puppeteer'); } catch (e) { _puppeteer = false; }
  return _puppeteer;
}

function available() { return !!puppeteerOrNull(); }

// ── Host safety ──────────────────────────────────────────────────────────

function ipIsPublic(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = p;
    if (a === 0) return false;                       // "this" network
    if (a === 10) return false;                      // private
    if (a === 127) return false;                     // loopback — our own API
    if (a === 169 && b === 254) return false;        // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;          // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false;                      // multicast + reserved
    return true;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 coat. Unwrap it or the
    // v4 rules above never run and every private v4 becomes reachable again.
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return ipIsPublic(m[1]);
    if (s === '::1' || s === '::') return false;     // loopback / unspecified
    if (/^f[cd]/.test(s)) return false;              // fc00::/7 unique-local
    if (/^fe[89ab]/.test(s)) return false;           // fe80::/10 link-local
    if (/^ff/.test(s)) return false;                 // multicast
    return true;
  }
  return false;
}

// Every navigation passes through here. Returns {ok} or {ok:false, error}.
async function assertNavigable(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); }
  catch (e) { return { ok: false, error: 'Not a valid URL.' }; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // file: would read the container's disk; data:/javascript: are injection
    // vectors that never touch the network at all.
    return { ok: false, error: 'Only http:// and https:// URLs can be opened.' };
  }

  const host = u.hostname.toLowerCase();

  if (ALLOWLIST.length) {
    const hit = ALLOWLIST.some(d => host === d || host.endsWith('.' + d));
    if (!hit) return { ok: false, error: 'Host "' + host + '" is not on this deployment\'s browser allowlist.' };
  }

  // A literal IP skips DNS entirely — check it directly, or 127.0.0.1 walks in.
  if (net.isIP(host)) {
    return ipIsPublic(host)
      ? { ok: true, url: u.toString() }
      : { ok: false, error: 'Refused: that address is on a private or loopback network.' };
  }

  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (e) { return { ok: false, error: 'Could not resolve host "' + host + '".' }; }
  if (!addrs.length) return { ok: false, error: 'Host "' + host + '" resolved to no address.' };

  // EVERY resolved address must be public. A name with one public and one
  // private A record is a rebinding attack with extra steps.
  for (const a of addrs) {
    if (!ipIsPublic(a.address)) {
      return { ok: false, error: 'Refused: "' + host + '" resolves to a private or loopback address.' };
    }
  }
  return { ok: true, url: u.toString() };
}

// ── Browser + session lifecycle ──────────────────────────────────────────

async function browser() {
  if (_browser && _browser.connected !== false) return _browser;
  const pup = puppeteerOrNull();
  if (!pup) throw new Error('No browser engine is installed on this server.');
  // Same flags report-pdf.js uses, for the same container reasons: no sandbox
  // namespaces available, and /dev/shm is typically 64MB.
  _browser = await pup.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  _browser.on('disconnected', () => { _browser = null; _sessions.clear(); });
  return _browser;
}

// Close anything idle past IDLE_MS or alive past HARD_MS. Called on every
// open() so a forgotten session cannot hold 500MB until the dyno restarts.
async function reap(now) {
  const t = now || Date.now();
  for (const [id, s] of [..._sessions.entries()]) {
    if (t - s.lastUsedAt > IDLE_MS || t - s.createdAt > HARD_MS) {
      await closeSession(id).catch(() => {});
    }
  }
}

function sessionOr(id, ctx) {
  const s = _sessions.get(String(id || ''));
  if (!s) return null;
  // Sessions are org-scoped: one tenant's agent must never read another's page.
  if (ctx && ctx.orgId != null && s.orgId != null && String(s.orgId) !== String(ctx.orgId)) return null;
  return s;
}

async function openPage(rawUrl, ctx) {
  if (!available()) return { ok: false, error: 'No browser engine is installed on this server.' };
  const check = await assertNavigable(rawUrl);
  if (!check.ok) return { ok: false, error: check.error };

  await reap();
  if (_sessions.size >= MAX_SESSIONS) {
    return { ok: false, error: 'All ' + MAX_SESSIONS + ' browser sessions are in use. Close one first.' };
  }

  const b = await browser();
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  // A redirect is a second navigation the caller never named, so re-run the
  // host check on every main-frame request rather than only the first URL.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.resourceType() !== 'document' || req.frame() !== page.mainFrame()) return req.continue().catch(() => {});
    assertNavigable(req.url())
      .then(r => (r.ok ? req.continue() : req.abort('blockedbyclient')))
      .catch(() => req.abort('failed'))
      .catch(() => {});
  });

  try {
    const resp = await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const id = 'bs_' + (++_seq) + '_' + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    _sessions.set(id, {
      page,
      orgId: ctx && ctx.orgId != null ? ctx.orgId : null,
      userId: ctx && ctx.userId != null ? ctx.userId : null,
      url: page.url(),
      createdAt: now,
      lastUsedAt: now
    });
    return {
      ok: true,
      session_id: id,
      url: page.url(),
      status: resp ? resp.status() : null,
      title: await page.title().catch(() => ''),
      sessions_open: _sessions.size
    };
  } catch (e) {
    await page.close().catch(() => {});
    return { ok: false, error: 'Could not open that page: ' + (e && e.message ? e.message : 'navigation failed') };
  }
}

async function readPage(id, ctx) {
  const s = sessionOr(id, ctx);
  if (!s) return { ok: false, error: 'No open browser session with that id.' };
  s.lastUsedAt = Date.now();
  try {
    const out = await s.page.evaluate(() => {
      const pick = document.querySelector('main, article, [role=main]') || document.body;
      return {
        title: document.title || '',
        text: (pick && pick.innerText) || '',
        links: Array.from(document.querySelectorAll('a[href]')).slice(0, 80)
          .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
          .filter(l => l.text)
      };
    });
    const text = String(out.text || '').replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEXT);
    return {
      ok: true,
      session_id: String(id),
      url: s.page.url(),
      title: out.title,
      truncated: String(out.text || '').length > MAX_TEXT,
      text,
      links: out.links
    };
  } catch (e) {
    return { ok: false, error: 'Could not read that page: ' + (e && e.message ? e.message : 'read failed') };
  }
}

async function screenshot(id, ctx, opts) {
  const s = sessionOr(id, ctx);
  if (!s) return { ok: false, error: 'No open browser session with that id.' };
  s.lastUsedAt = Date.now();
  try {
    const buf = await s.page.screenshot({
      type: 'jpeg',
      quality: 70,
      fullPage: !!(opts && opts.full_page)
    });
    return { ok: true, session_id: String(id), url: s.page.url(), mime: 'image/jpeg', base64: buf.toString('base64') };
  } catch (e) {
    return { ok: false, error: 'Could not screenshot that page: ' + (e && e.message ? e.message : 'capture failed') };
  }
}

async function closeSession(id) {
  const s = _sessions.get(String(id || ''));
  if (!s) return { ok: true, closed: false };
  _sessions.delete(String(id));
  try { await s.page.close(); } catch (e) { /* best effort */ }
  // Last one out turns off the lights — an idle Chromium is pure overhead.
  if (!_sessions.size && _browser) {
    const b = _browser; _browser = null;
    try { await b.close(); } catch (e) { /* best effort */ }
  }
  return { ok: true, closed: true };
}

function listSessions(ctx) {
  const out = [];
  for (const [id, s] of _sessions.entries()) {
    if (ctx && ctx.orgId != null && s.orgId != null && String(s.orgId) !== String(ctx.orgId)) continue;
    out.push({ session_id: id, url: s.url, age_ms: Date.now() - s.createdAt, idle_ms: Date.now() - s.lastUsedAt });
  }
  return out;
}

module.exports = {
  available, openPage, readPage, screenshot, closeSession, listSessions, reap,
  // exported for tests — the host check is the security boundary, so it is
  // tested directly rather than only through a live navigation.
  _assertNavigable: assertNavigable,
  _ipIsPublic: ipIsPublic,
  MAX_SESSIONS
};
