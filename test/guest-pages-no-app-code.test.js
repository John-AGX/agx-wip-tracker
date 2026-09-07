// THE GUEST-SURFACE RULE, enforced for every guest page at once.
//
//   A guest surface COPIES the app's markup, classes and tokens and NEVER
//   links the app's code — because every real renderer in the SPA takes an id
//   and reaches for app state itself, so loading one onto a page outside the
//   app drags the whole app in behind it, along with its auth assumptions.
//
// Until now that rule was stated in prose in report-document-render.test.js
// and enforced COMPREHENSIVELY for exactly one page (live.html, in
// test/live-guest-shell.test.js). task-share.html and portal.html were
// compliant but unguarded, which is a slow leak: each new compliant-but-
// unguarded page makes the rule a little more of a convention and a little
// less of a fact. service-ticket-share.html would have been the fifth.
//
// The assertions here are EQUALITIES, not subsets. A subset check ("no app
// file is linked") passes forever while the next script quietly arrives; an
// equality fails the moment the set changes, which is the point — the failure
// is a prompt to think, not a bug.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Every guest page in the repo. live.html has its own dedicated, deeper suite
// (test/live-guest-shell.test.js) covering its three-script contract and DOM
// bleed; it is listed here so the ROSTER assertion below can be an equality.
// `token: true` means the page's own URL carries a CREDENTIAL in its path
// (/t/, /r/, /st/). Those get the extra no-index / no-referrer assertions —
// portal.html is reached at a plain /portal and authenticates normally, so the
// credential argument does not apply to it and asserting it there would be
// cargo-culting the rule rather than applying it.
const GUEST_PAGES = [
  { file: 'task-share.html', scripts: [], token: true },
  { file: 'portal.html', scripts: [], token: false },
  // The ONE sanctioned exception in the repo: js/report-document.js is loaded
  // by a guest page because it is provably pure — one global, no ambient
  // reads — and test/report-document-render.test.js enforces that in a bare
  // vm sandbox. Leaflet is a vendored third-party map library, not app code.
  { file: 'report-share.html', scripts: ['/js/report-document.js', '/js/vendor/leaflet.js'], token: true },
  // Read-only work order. Self-contained: zero scripts of any kind.
  { file: 'service-ticket-share.html', scripts: [], token: true },
];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// Every <script src="..."> on the page, query strings stripped so a ?v bump
// cannot silently change the set.
function scriptSrcs(html) {
  const out = [];
  const re = /<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) out.push(String(m[1]).split('?')[0]);
  return out;
}

describe('the guest-page roster is closed', () => {
  test('these are ALL the guest pages — a new one must be added here deliberately', () => {
    // Derived from disk, not typed: any *-share / portal / live page at the
    // repo root is a guest surface by construction.
    const found = fs.readdirSync(ROOT)
      .filter((f) => /\.html$/.test(f))
      .filter((f) => /share|portal|live/i.test(f))
      .sort();
    const declared = GUEST_PAGES.map((p) => p.file).concat(['live.html']).sort();
    expect(found).toEqual(declared);
  });
});

describe.each(GUEST_PAGES)('$file links no app code', ({ file, scripts, token }) => {
  const html = read(file);

  test('the script set is EXACTLY what is declared — an equality, not a subset', () => {
    expect(scriptSrcs(html).sort()).toEqual(scripts.slice().sort());
  });

  test('no SPA file is NAMED anywhere on the page', () => {
    // Asserted on the whole file, not just on <script src>: a guest page that
    // merely mentions an app path is one copy-paste away from loading it.
    for (const bad of ['js/app.js', 'js/api.js', 'js/jobs.js', 'js/auth.js',
                       'js/leads.js', 'js/projects.js', 'js/workspace-layout.js',
                       'js/service-tickets.js', 'js/tasks.js', 'nodegraph/']) {
      expect(html).not.toContain(bad);
    }
  });

  test('the app stylesheet is not linked', () => {
    expect(html).not.toContain('css/styles.css');
  });

  // Only for pages whose URL IS the credential. This found a real gap:
  // task-share.html carried the robots meta but no referrer meta, and its
  // route set NO headers at all while /live/, /r/ and /st/ all set three — so
  // a task-share token rode the Referer header to whatever the guest clicked
  // next. Both fixed rather than exempted.
  (token ? test : test.skip)('a credential-bearing page repels crawlers and referrers', () => {
    expect(html).toMatch(/name=["']robots["']/i);
    expect(html).toMatch(/noindex/i);
    expect(html).toMatch(/name=["']referrer["'][^>]*no-referrer/i);
  });
});

describe('every credential-bearing page route sets the three headers', () => {
  // The meta tags above are the page-level twin; THESE are the ones that
  // actually apply on a normal navigation. Asserted on the route table rather
  // than the pages, because the header is the server's job.
  const idx = read('server/index.js');
  test.each([['/t/:token'], ['/r/:token'], ['/st/:token']])('%s', (route) => {
    const at = idx.indexOf("app.get('" + route + "'");
    expect(at).toBeGreaterThan(-1);
    const block = idx.slice(at, at + 500);
    expect(block).toContain("res.set('Referrer-Policy', 'no-referrer')");
    expect(block).toContain("res.set('X-Robots-Tag', 'noindex, nofollow')");
    expect(block).toContain("res.set('Cache-Control', 'no-store, no-cache, must-revalidate')");
  });
});

describe('service-ticket-share.html is read-only in S4', () => {
  const html = read('service-ticket-share.html');

  test('the token is read from the PATH, never a query string', () => {
    // A query string is far more likely to be logged by a proxy or kept in an
    // analytics payload than a path segment is.
    expect(html).toContain('location.pathname');
    expect(html).not.toMatch(/URLSearchParams|location\.search/);
  });

  test('a malformed token is refused BEFORE any network call', () => {
    const gate = html.indexOf('/^[a-f0-9]{64}$/');
    const call = html.indexOf("fetch('/api/service-ticket-share/");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    // The gate is the last statement in the file, after load() is defined —
    // so compare against the CALL SITE, which must be inside load().
    expect(html).toMatch(/if \(!\/\^\[a-f0-9\]\{64\}\$\/\.test\(token\)\) fatal\(/);
  });

  test('it reaches exactly ONE endpoint', () => {
    const urls = (html.match(/\/api\/[a-z0-9\-\/]+/gi) || [])
      .map((u) => u.replace(/\/$/, ''));
    expect([...new Set(urls)]).toEqual(['/api/service-ticket-share/']
      .map((u) => u.replace(/\/$/, '')));
  });

  test('S4 ships NO write control — not a hidden one, an absent one', () => {
    // A page that offers a control the server would refuse is worse than one
    // that offers nothing. The write scopes arrive with their doors in S5/S6.
    for (const control of ['<input type="checkbox"', '<textarea', 'method: \'PATCH\'',
                           'method: \'POST\'', 'FormData']) {
      expect(html).not.toContain(control);
    }
  });
});
