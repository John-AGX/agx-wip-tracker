// Tiny static-file server for the workspace ribbon preview.
// No dependencies — uses only Node built-ins so `node serve.js` works
// out of the box. Serves files from this directory + the parent
// project so the preview HTML can pull workspace.css directly from
// css/ without copying.
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 8765;
const ROOT_PROJECT = path.resolve(__dirname, '..');
const ROOT_PREVIEW = __dirname;

const MIME = {
  html: 'text/html; charset=utf-8',
  css:  'text/css; charset=utf-8',
  js:   'application/javascript; charset=utf-8',
  json: 'application/json',
  svg:  'image/svg+xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  ico:  'image/x-icon'
};

function tryFile(rel) {
  // Try preview directory first, then project root.
  const a = path.join(ROOT_PREVIEW, rel);
  if (fs.existsSync(a) && fs.statSync(a).isFile()) return a;
  const b = path.join(ROOT_PROJECT, rel);
  if (fs.existsSync(b) && fs.statSync(b).isFile()) return b;
  return null;
}

http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const decoded = decodeURIComponent(url.replace(/^\/+/, ''));
  // Defense — block parent traversal.
  if (decoded.includes('..')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  // ── HARNESS FIXTURES ────────────────────────────────────────────────
  // A shipped page that fetches its own data cannot be exercised by patching
  // fetch from a parent frame: the page navigates, the patch goes with the old
  // window, and the real request races it. So the harness answers the real
  // request instead. Any JSON under preview/fixtures/ is served at the path
  // named by its filename, with slashes written as double underscores:
  //   preview/fixtures/api__preview__sub-portal__me.json
  //     -> GET /api/preview/sub-portal/<anything>/me
  // The last path segment is matched, so the id in the URL is free.
  if (url.indexOf('/api/') === 0) {
    const tail = url.split('/').filter(Boolean).pop();
    const fx = path.join(ROOT_PREVIEW, 'fixtures', tail + '.json');
    if (fs.existsSync(fx)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(fs.readFileSync(fx));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'no fixture for ' + url }));
  }

  const found = tryFile(decoded);
  if (!found) {
    res.writeHead(404);
    return res.end('Not found: ' + url);
  }
  const ext = path.extname(found).slice(1).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(found).pipe(res);
}).listen(PORT, () => {
  console.log('Workspace ribbon preview running at http://localhost:' + PORT);
});
