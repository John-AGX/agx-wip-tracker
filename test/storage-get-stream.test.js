// A STOPPED DOWNLOAD MUST GIVE ITS STORAGE CONNECTION BACK.
//
// THE FINDING
// @aws-sdk/client-s3 asks for checksum mode on every GetObject by default, and
// when R2 answers with an x-amz-checksum-crc32 header res.Body is not the HTTP
// response. It is @smithy/util-stream's ChecksumStream, a Duplex the response
// is piped into, and it defines no _destroy. The crew link's takeoff door
// destroys the body it was handed whenever a download stops early — a closed
// tab, the size refusal, its `finally` — and destroying the wrapper only
// unpiped: the IncomingMessage underneath was never read to its end and never
// destroyed, so its keep-alive socket stayed out of the agent's pool, paused.
// The agent allows 50. Fifty started-and-cancelled downloads, inside the
// link's rate limit, and the fifty-first R2 call in the process — an upload,
// a getBuffer, another tenant's download — waited forever.
//
// THE FIX, IN TWO HALVES (server/storage.js)
//   clientConfig   responseChecksumValidation 'WHEN_REQUIRED': GetObject is
//                  not wrapped, the body IS the response, and its destroy
//                  closes its socket.
//   tieToResponse  a wrapper that arrives anyway is tied back to the response
//                  it reads: destroying one destroys the other, and a failing
//                  response fails the wrapper instead of leaving its reader
//                  waiting.
// Each half is held on its own below, and the committed shape (neither) is run
// as a mutant to show the count test goes red on it.
//
// THE TRANSPORT IS REAL. The count tests run test/helpers/r2-socket-drive.js
// in a plain node child (it says why): the SDK's own S3Client, built from
// R2Storage.clientConfig, with only the endpoint (a local server that answers
// like R2, checksum header included) and the agent (keepAlive, maxSockets 50)
// swapped, and the server counting the sockets still held. The unit tests use
// a fake S3 client handing back the SDK's real ChecksumStream over a fake
// response, so the socket being destroyed is observed directly.
//
// Also here: the local disk backend gives its file descriptor back however
// the stream stops.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { createChecksumStream } = require('@smithy/util-stream');

const REPO = path.join(__dirname, '..');
const STORAGE = path.join(REPO, 'server', 'storage.js');
const DRIVE = path.join(__dirname, 'helpers', 'r2-socket-drive.js');

const tmpDirs = [];
const mutantPaths = [];

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// storage.js builds a local backend when it loads, and that makes its upload
// directory. Point it at a temp dir so neither the real module nor a mutant
// written to os.tmpdir() creates one anywhere that matters.
function loadStorage(file) {
  const prev = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = tmpDir('_p86_getstream_up_');
  try {
    return jest.requireActual(file);
  } finally {
    if (prev === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = prev;
  }
}

const real = loadStorage(STORAGE);

// storage.js with some of its source replaced, written to os.tmpdir(). Each
// anchor must match exactly once, so a refactor that moves one fails loudly
// here instead of producing a mutant that is not one. Returns the file path.
function mutantFile(pairs) {
  const SOURCE = fs.readFileSync(STORAGE, 'utf8');
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const hits = out.split(f).length - 1;
    if (hits === 0) throw new Error('MUTATION ANCHOR NOT FOUND:\n' + JSON.stringify(f.slice(0, 200)));
    if (hits > 1) throw new Error('MUTATION ANCHOR IS AMBIGUOUS (' + hits + ' matches):\n' + JSON.stringify(f.slice(0, 200)));
    out = out.split(f).join(r);
  }
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(path.dirname(STORAGE), spec))
      : require.resolve(spec, { paths: [path.dirname(STORAGE)] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_storage_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}
const mutant = (pairs) => loadStorage(mutantFile(pairs));

// The two halves of the fix, as mutations.
const NO_CONFIG = [[
  "      },\n      responseChecksumValidation: 'WHEN_REQUIRED'\n    };",
  '      }\n    };',
]];
const NO_TIE = [[
  'function tieToResponse(body) {\n',
  'function tieToResponse(body) {\n  return body; // MUTANT: the wrapper is not tied to the response\n',
]];

afterAll(() => {
  for (const p of mutantPaths) { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* already gone */ } }
});

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms) {
  const deadline = Date.now() + (ms || 20000);
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + what);
    await sleep(10);
  }
}
// Resolves to the value, or to TIMED_OUT when `ms` passes first.
const TIMED_OUT = Symbol('timed out');
function within(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((r) => { t = setTimeout(() => r(TIMED_OUT), ms); })])
    .finally(() => clearTimeout(t));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FINDING, THROUGH THE SDK'S OWN CLIENT AND TRANSPORT
 * ══════════════════════════════════════════════════════════════════════════*/

// Sixty cancelled downloads against one agent of fifty sockets.
function drive(storageFile, opts) {
  const o = opts || {};
  const args = JSON.stringify({
    storage: storageFile,
    override: o.override || null,
    rounds: 60,
    // Generous for every open a working client makes: a local open is
    // milliseconds. Past the agent's fifty sockets a leaking client never
    // answers at all, so the mutants look there for 3 s only.
    hangMs: 20000,
    pastPoolMs: o.pastPoolMs || 20000,
    uploadDir: tmpDir('_p86_getstream_child_'),
  });
  // The SDK's default checksum mode is what the mutants reproduce, so a
  // machine that sets its own (an AWS_* variable, a ~/.aws/config line) must
  // not change it under the child.
  const env = Object.assign({}, process.env, {
    AWS_CONFIG_FILE: path.join(tmpDir('_p86_getstream_aws_'), 'config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(tmpDir('_p86_getstream_aws_'), 'credentials'),
  });
  delete env.AWS_RESPONSE_CHECKSUM_VALIDATION;
  delete env.AWS_REQUEST_CHECKSUM_CALCULATION;
  delete env.AWS_PROFILE;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [DRIVE, args], { cwd: REPO, env, timeout: 110000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error('drive failed: ' + err.message + '\n' + stderr));
      const line = String(stdout).trim().split(/\r?\n/).pop();
      try { resolve(JSON.parse(line)); } catch (e) { reject(new Error('drive printed: ' + stdout + '\n' + stderr)); }
    });
  });
}

describe('sixty cancelled downloads do not take the agent\'s fifty sockets', () => {
  const LONG = 120000;

  test('the production client: the body is the response itself, and every cancelled socket closes', async () => {
    const r = await drive(STORAGE);
    expect(r).toEqual({ hungAt: null, wrapped: false, openAfter: 0, wholeOk: true, wholeConns: 1 });
  }, LONG);

  test('checksum mode forced back on: the SDK wraps the body, and the tie still closes every socket', async () => {
    // wrapped: true is what makes this a test of the tie at all. A whole read
    // still gives its keep-alive socket back — two reads, one connection.
    const r = await drive(STORAGE, { override: { responseChecksumValidation: 'WHEN_SUPPORTED' } });
    expect(r).toEqual({ hungAt: null, wrapped: true, openAfter: 0, wholeOk: true, wholeConns: 1 });
  }, LONG);

  test('the configuration alone holds, without the tie', async () => {
    const r = await drive(mutantFile(NO_TIE));
    expect(r).toEqual({ hungAt: null, wrapped: false, openAfter: 0, wholeOk: true, wholeConns: 1 });
  }, LONG);

  test('the tie alone holds, without the configuration', async () => {
    const r = await drive(mutantFile(NO_CONFIG));
    expect(r).toEqual({ hungAt: null, wrapped: true, openAfter: 0, wholeOk: true, wholeConns: 1 });
  }, LONG);

  test('MUTANT — the committed shape (no configuration, no tie): fifty sockets held and the fifty-first call hangs', async () => {
    const r = await drive(mutantFile(NO_CONFIG.concat(NO_TIE)), { pastPoolMs: 3000 });
    expect(r).toMatchObject({ hungAt: 50, wrapped: true, openAfter: 50 });
  }, LONG);

  test('MUTANT — the tie removed with checksum mode on: the wrapper leaks exactly as found', async () => {
    const r = await drive(mutantFile(NO_TIE), { override: { responseChecksumValidation: 'WHEN_SUPPORTED' }, pastPoolMs: 3000 });
    expect(r).toMatchObject({ hungAt: 50, wrapped: true, openAfter: 50 });
  }, LONG);
});

describe('the production client configuration', () => {
  test('response checksums only when required; the upload checksum keeps its default', () => {
    const cfg = real.R2Storage.clientConfig({ accountId: 'acct', accessKeyId: 'id', secretAccessKey: 's' });
    expect(cfg.responseChecksumValidation).toBe('WHEN_REQUIRED');
    expect(cfg).not.toHaveProperty('requestChecksumCalculation');
    expect(cfg.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
  });

  test('the constructor builds its client from that configuration', async () => {
    const r2 = new real.R2Storage({
      accountId: 'acct', accessKeyId: 'id', secretAccessKey: 's', bucket: 'b', publicBase: 'files.example.test',
    });
    expect(await r2.client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE TIE, OBSERVED DIRECTLY — a fake S3 client, the SDK's real wrapper
 * ══════════════════════════════════════════════════════════════════════════*/

// Stands in for http.IncomingMessage: a readable with a socket, whose destroy
// closes that socket only when the message was not read to its end — Node's
// own rule, which is what lets a finished response keep its connection.
class FakeResponse extends Readable {
  constructor(chunks) {
    super({ autoDestroy: false });
    this.chunks = chunks.slice();
    this.complete = false;
    this.holdOpen = false;
    this.socket = { destroyed: false, destroy() { this.destroyed = true; } };
  }
  _read() {
    if (this.chunks.length) { this.push(this.chunks.shift()); return; }
    if (this.holdOpen) return;
    this.complete = true;
    this.push(null);
  }
  _destroy(err, cb) {
    if (!this.readableEnded || !this.complete) this.socket.destroy();
    cb(err);
  }
}

// The fake client: GetObject answers with the SDK's ChecksumStream over a
// FakeResponse, the shape middleware-flexible-checksums produces.
function wrappedStorage(mod, response) {
  const r2 = Object.create(mod.R2Storage.prototype);
  r2.bucket = 'bucket';
  r2._GetObjectCommand = function GetObjectCommand(input) { this.input = input; };
  r2.client = {
    send: async () => ({
      Body: createChecksumStream({
        expectedChecksum: 'AAAAAA==',
        checksumSourceLocation: 'x-amz-checksum-crc32',
        checksum: { update() {}, digest: async () => new Uint8Array(4) },
        source: response,
      }),
      ContentLength: 64 * 1024,
    }),
  };
  return r2;
}

const chunks = (n) => Array.from({ length: n }, () => Buffer.alloc(16 * 1024, 1));

describe('a wrapped body is tied to the response it reads', () => {
  test('destroyed after one chunk: the response and its socket are destroyed with it', async () => {
    const response = new FakeResponse(chunks(4));
    response.holdOpen = true;
    const got = await wrappedStorage(real, response).getStream('k');
    expect(got.stream.source).toBe(response);
    await new Promise((r) => got.stream.once('data', r));
    got.stream.destroy();
    await until(() => response.destroyed, 'response destroyed');
    expect(response.socket.destroyed).toBe(true);
  });

  test('destroyed before it was read — the size refusal: the socket is destroyed too', async () => {
    const response = new FakeResponse(chunks(4));
    const got = await wrappedStorage(real, response).getStream('k');
    got.stream.destroy();
    await until(() => response.destroyed, 'response destroyed');
    expect(response.socket.destroyed).toBe(true);
  });

  test('read to its end: the socket is left to the agent', async () => {
    const response = new FakeResponse(chunks(4));
    const got = await wrappedStorage(real, response).getStream('k');
    let n = 0;
    for await (const c of got.stream) n += c.length;
    expect(n).toBe(64 * 1024);
    await until(() => got.stream.destroyed, 'wrapper closed');
    for (let i = 0; i < 20; i++) await tick();
    expect(response.socket.destroyed).toBe(false);
  });

  test('the response fails mid-read: the reader sees the error instead of waiting forever', async () => {
    const response = new FakeResponse(chunks(1));
    response.holdOpen = true;
    const got = await wrappedStorage(real, response).getStream('k');
    const reading = (async () => { for await (const c of got.stream) void c; })();
    await until(() => !response.chunks.length, 'first chunk taken');
    response.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await expect(within(reading, 10000)).rejects.toThrow(/ECONNRESET/);
  });

  test('getBuffer is tied the same way: a failing response rejects it', async () => {
    const response = new FakeResponse(chunks(1));
    response.holdOpen = true;
    const pending = wrappedStorage(real, response).getBuffer('k');
    await until(() => !response.chunks.length, 'first chunk taken');
    response.destroy(new Error('socket hang up'));
    await expect(within(pending, 10000)).rejects.toThrow(/socket hang up/);
  });

  test('a plain body is handed back untouched', async () => {
    const body = Readable.from([Buffer.from('bytes')]);
    const r2 = Object.create(real.R2Storage.prototype);
    r2.bucket = 'bucket';
    r2._GetObjectCommand = function GetObjectCommand(input) { this.input = input; };
    r2.client = { send: async () => ({ Body: body, ContentLength: 5 }) };
    expect((await r2.getStream('k')).stream).toBe(body);
  });

  test('MUTANT — no tie: the destroyed wrapper leaves the socket open, and a failing response hangs its reader', async () => {
    const mod = mutant(NO_TIE);
    const response = new FakeResponse(chunks(4));
    response.holdOpen = true;
    const got = await wrappedStorage(mod, response).getStream('k');
    await new Promise((r) => got.stream.once('data', r));
    got.stream.destroy();
    for (let i = 0; i < 200; i++) await tick();
    expect(response.destroyed).toBe(false);
    expect(response.socket.destroyed).toBe(false);

    const failing = new FakeResponse(chunks(1));
    failing.holdOpen = true;
    // Nothing else listens for the response's error once the tie is gone.
    failing.on('error', () => {});
    const got2 = await wrappedStorage(mod, failing).getStream('k');
    const reading = (async () => { for await (const c of got2.stream) void c; })();
    reading.catch(() => {});
    await until(() => !failing.chunks.length, 'first chunk taken');
    failing.destroy(new Error('read ECONNRESET'));
    // A hang is a hang; 1.5 s only bounds how long the test looks at it.
    expect(await within(reading, 1500)).toBe(TIMED_OUT);
    got2.stream.destroy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE LOCAL DISK BACKEND GIVES ITS DESCRIPTOR BACK
 * ══════════════════════════════════════════════════════════════════════════*/
describe('local disk: the file handle is closed however the stream stops', () => {
  let dir;
  let handles;
  let realOpen;
  beforeAll(() => { dir = tmpDir('_p86_getstream_disk_'); });
  // Every FileHandle getStream opens, so its descriptor can be read afterwards.
  beforeEach(() => {
    handles = [];
    realOpen = fs.promises.open;
    fs.promises.open = async (...args) => { const h = await realOpen.apply(fs.promises, args); handles.push(h); return h; };
  });
  afterEach(async () => {
    fs.promises.open = realOpen;
    for (const h of handles) { if (h.fd !== -1) await h.close().catch(() => {}); }
  });

  const FILE = Buffer.alloc(4 * 1024 * 1024, 3);
  const settle = (stream) => new Promise((r) => (stream.closed ? r() : stream.once('close', r)));

  async function stop(mod, how) {
    const disk = new mod.LocalDiskStorage(dir, '/uploads');
    await disk.put(path.join('orig', 'big.pdf'), FILE);
    const got = await disk.getStream(path.join('orig', 'big.pdf'));
    expect(handles.length).toBe(1);
    const handle = handles[0];
    got.stream.on('error', () => {});
    if (how === 'one chunk') await new Promise((r) => got.stream.once('data', r));
    if (how === 'whole') { for await (const c of got.stream) void c; }
    else if (how === 'error') got.stream.destroy(new Error('reader went away'));
    else got.stream.destroy();
    await settle(got.stream);
    return handle;
  }

  for (const how of ['never read', 'one chunk', 'whole', 'error']) {
    test('stopped: ' + how, async () => {
      const handle = await stop(real, how);
      await until(() => handle.fd === -1, 'descriptor closed', 10000);
    });
  }

  test('MUTANT — the stream read from the path instead of the handle: the stat\'s descriptor is never given back', async () => {
    const mod = mutant([[
      'return { stream: handle.createReadStream(), size: st.size };',
      'return { stream: fs.createReadStream(this._full(key)), size: st.size };',
    ]]);
    const handle = await stop(mod, 'one chunk');
    await sleep(200);
    expect(handle.fd).not.toBe(-1);
  });
});
