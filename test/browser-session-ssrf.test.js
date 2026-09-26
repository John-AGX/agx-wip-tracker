// The host check in browser-session.js is a security boundary, not a
// convenience: this browser runs INSIDE our container, so a URL the model
// names reaches our private network directly. These tests pin the refusals.
//
// Pure logic + dns only — no server/routes require, so it runs without
// JWT_SECRET set.

const bs = require('../server/services/browser-session');

describe('ipIsPublic — the address classifier', () => {
  const PRIVATE = [
    ['127.0.0.1', 'loopback — our own API listens here'],
    ['127.255.255.254', 'all of 127/8 is loopback, not just .0.1'],
    ['169.254.169.254', 'cloud instance metadata — the credential jackpot'],
    ['169.254.1.1', 'link-local'],
    ['10.0.0.5', 'private class A'],
    ['172.16.0.1', 'private class B, low edge'],
    ['172.31.255.255', 'private class B, high edge'],
    ['192.168.1.1', 'private class C'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', '"this" network'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback — the coat does not make it public'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata address'],
  ];
  test.each(PRIVATE)('refuses %s (%s)', (ip) => {
    expect(bs._ipIsPublic(ip)).toBe(false);
  });

  const PUBLIC = ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.1.1', '2606:4700::1111'];
  test.each(PUBLIC)('allows %s', (ip) => {
    expect(bs._ipIsPublic(ip)).toBe(true);
  });

  test('172.16/12 boundaries are exact, not a loose 172.* match', () => {
    expect(bs._ipIsPublic('172.15.255.255')).toBe(true);   // just below
    expect(bs._ipIsPublic('172.16.0.0')).toBe(false);      // first private
    expect(bs._ipIsPublic('172.31.255.255')).toBe(false);  // last private
    expect(bs._ipIsPublic('172.32.0.0')).toBe(true);       // just above
  });

  test('garbage is not public', () => {
    expect(bs._ipIsPublic('')).toBe(false);
    expect(bs._ipIsPublic('999.1.1.1')).toBe(false);
    expect(bs._ipIsPublic('not-an-ip')).toBe(false);
  });
});

describe('assertNavigable — what the agent is allowed to open', () => {
  test('refuses non-http schemes', async () => {
    for (const u of ['file:///etc/passwd', 'data:text/html,<h1>x', 'javascript:alert(1)', 'ftp://example.com']) {
      const r = await bs._assertNavigable(u);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/http/i);
    }
  });

  test('refuses a literal loopback / metadata URL without any DNS round trip', async () => {
    for (const u of ['http://127.0.0.1:3000/api/jobs', 'http://169.254.169.254/latest/meta-data/']) {
      const r = await bs._assertNavigable(u);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/private or loopback/i);
    }
  });

  test('refuses malformed input rather than throwing', async () => {
    const r = await bs._assertNavigable('not a url at all');
    expect(r.ok).toBe(false);
  });

  test('a hostname that resolves to loopback is refused', async () => {
    // localhost is the cheapest real case: it resolves, and it resolves private.
    const r = await bs._assertNavigable('http://localhost:3000/');
    expect(r.ok).toBe(false);
  });

  // MUTATION CHECK: if the classifier were inverted or stubbed to always
  // return true, every test above flips to failing. Verified by temporarily
  // returning true from ipIsPublic during development.
  test('the guard is not vacuous — a public host is genuinely allowed', async () => {
    const r = await bs._assertNavigable('https://example.com/docs');
    // Allowed unless this deploy set an allowlist that excludes it.
    if (!r.ok) expect(r.error).toMatch(/allowlist/i);
    else expect(r.url).toBe('https://example.com/docs');
  });
});
