// SSRF guard (SEC P1-3).
//
// Two server endpoints fetch a URL that an admin supplied: the org-logo
// proxy (org-manifest-routes) and the SharePoint/Google workbook fetcher
// (sharepoint.js). Without a guard, an admin-set URL pointing at an
// internal address (cloud metadata service, localhost, a private host)
// would be fetched by the server and the bytes returned — a classic SSRF.
//
// assertPublicUrl() resolves the host via DNS and rejects if ANY resolved
// address is loopback / link-local / private / reserved. safeFetch()
// follows redirects MANUALLY and re-validates every hop's Location, so a
// public URL that 302s to an internal address is still blocked.
//
// Caveat: this does not fully defeat DNS-rebinding (the address could
// change between the lookup and the socket connect); pinning the
// connection to the validated IP would require a custom agent. This is
// the pragmatic guard the audit asked for and covers the realistic cases.

const dns = require('dns').promises;
const net = require('net');

// Classify an IP literal as private / loopback / link-local / reserved.
// Unknown / unparseable → treated as unsafe (fail closed).
function isPrivateIp(ip) {
  if (!ip) return true;
  let addr = String(ip);
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);              // strip IPv6 zone id
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) addr = mapped[1];                             // IPv4-mapped IPv6

  if (net.isIPv4(addr)) {
    const p = addr.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true;                  // "this" network
    if (a === 10) return true;                 // private
    if (a === 127) return true;                // loopback
    if (a === 169 && b === 254) return true;   // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;   // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                 // multicast / reserved
    return false;
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower === '::1' || lower === '::') return true;          // loopback / unspecified
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    if (lower.startsWith('fe80')) return true;                   // link-local
    if (lower.startsWith('ff')) return true;                     // multicast
    return false;
  }
  return true; // not a recognizable IP → unsafe
}

// Validate that a URL is http(s) to a PUBLIC host. Throws on anything
// unsafe; resolves the host and rejects if any address is private.
async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (_) { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = u.hostname;
  if (!host) throw new Error('URL has no host');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('URL host is not allowed');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) {
    throw new Error('URL host is not allowed');
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (_) { throw new Error('URL host could not be resolved'); }
  if (!addrs || !addrs.length) throw new Error('URL host could not be resolved');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('URL resolves to a private address');
  }
  return addrs;
}

// SSRF-safe fetch: validate the URL, then follow redirects MANUALLY (up
// to maxHops), re-validating each hop before following. Returns the final
// Response — the caller still enforces content-type / size limits.
async function safeFetch(rawUrl, opts = {}, maxHops = 5) {
  let url = String(rawUrl);
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, Object.assign({}, opts, { redirect: 'manual' }));
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      url = new URL(loc, url).toString(); // resolve relative redirects
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

module.exports = { assertPublicUrl, safeFetch, isPrivateIp };
