// Drives R2Storage.getStream through the SDK's OWN S3Client and transport
// against a local server that answers like R2, and reports what the sockets
// did. Used by test/storage-get-stream.test.js.
//
// WHY A CHILD PROCESS. @smithy/node-http-handler loads node:http with a dynamic
// import(), and jest's module sandbox refuses dynamic import without
// --experimental-vm-modules — so inside a jest worker the SDK's plain-http
// path throws before a byte is sent. Swapping in a hand-written transport
// would be testing the swap. Run under plain node, the client, its middleware
// (the checksum wrapper included) and its agent handling are exactly the ones
// production uses; only the endpoint and the agent are local.
//
// Usage: node r2-socket-drive.js '<json>'
//   storage   absolute path of the storage module to load (the real one or a
//             mutant)
//   override  S3Client options laid over R2Storage.clientConfig (optional)
//   rounds    cancelled downloads to attempt (open, one chunk, destroy)
//   hangMs    how long one of the first fifty opens may take before it counts
//             as hung
//   pastPoolMs the same, for the opens past the agent's fifty sockets — where a
//             leaking client hangs for good, so a mutant can use a short wait
//             there without racing a slow machine on the first fifty
//   uploadDir a temp dir for the local backend storage.js builds on load
// Prints one JSON line:
//   hungAt        index of the first open that did not come back, or null
//   wrapped       whether the SDK handed back a wrapper (a body with .source)
//   openAfter     client connections the server still held after the rounds
//   wholeOk       two whole reads afterwards returned the whole body
//   wholeConns    connections those two whole reads opened (1 = reused)
'use strict';

const http = require('http');

const args = JSON.parse(process.argv[2]);
process.env.UPLOAD_DIR = args.uploadDir;

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const mod = require(args.storage);

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 2 MB: bigger than the socket and stream buffers, which is what the leak
// needs — a tiny body is already in memory before the destroy. A takeoff PDF
// of several MB is the real case.
const BODY = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < BODY.length; i++) BODY[i] = i % 251;
const CRC = (() => { const b = Buffer.alloc(4); b.writeUInt32BE(crc32(BODY)); return b.toString('base64'); })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMED_OUT = Symbol('timed out');
function within(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((r) => { t = setTimeout(() => r(TIMED_OUT), ms); })])
    .finally(() => clearTimeout(t));
}

const open = new Set();
let connections = 0;
// The way R2 answers GetObject since it added CRC32: the checksum header on
// the response, which is what makes the SDK wrap the body.
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': String(BODY.length),
    'x-amz-checksum-crc32': CRC,
    etag: '"p86"',
  });
  res.end(BODY);
});
// A reused socket must not be closed out from under the whole reads by the
// server's idle timer on a slow machine.
server.keepAliveTimeout = 120000;
server.on('connection', (s) => {
  connections++;
  open.add(s);
  s.on('close', () => open.delete(s));
});

server.listen(0, '127.0.0.1', async () => {
  const out = { hungAt: null, wrapped: null, openAfter: null, wholeOk: null, wholeConns: null };
  try {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });
    const cfg = Object.assign(
      mod.R2Storage.clientConfig({ accountId: 'acct', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' }),
      args.override || {},
      {
        endpoint: 'http://127.0.0.1:' + server.address().port,
        forcePathStyle: true,
        requestHandler: new NodeHttpHandler({ httpAgent: agent }),
      }
    );
    const r2 = Object.create(mod.R2Storage.prototype);
    r2.bucket = 'project86-attachments';
    r2._GetObjectCommand = GetObjectCommand;
    r2.client = new S3Client(cfg);

    for (let i = 0; i < args.rounds; i++) {
      const got = await within(r2.getStream('orig/plans.pdf'), i < 50 ? args.hangMs : (args.pastPoolMs || args.hangMs));
      if (got === TIMED_OUT) { out.hungAt = i; break; }
      if (i === 0) out.wrapped = !!got.stream.source;
      await new Promise((r) => got.stream.once('data', r));
      got.stream.destroy();
    }

    // Let the closes land. Polled, with a generous ceiling: a local close is
    // milliseconds, and a held socket never closes at all.
    const deadline = Date.now() + (out.hungAt === null ? 20000 : 1000);
    while (open.size && Date.now() < deadline) await sleep(20);
    out.openAfter = open.size;

    if (out.hungAt === null) {
      const before = connections;
      let ok = true;
      for (let k = 0; k < 2; k++) {
        const got = await r2.getStream('orig/plans.pdf');
        const parts = [];
        for await (const c of got.stream) parts.push(c);
        ok = ok && Buffer.concat(parts).equals(BODY);
      }
      out.wholeOk = ok;
      out.wholeConns = connections - before;
    }
  } catch (e) {
    out.error = String(e && (e.stack || e.message) || e);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  // A hung request is still queued on the agent; nothing here waits for it.
  process.exit(0);
});
