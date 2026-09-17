// js/service-ticket-ext.js — the work-order detail extension registry
// (window.p86StExt, shared contracts 5.2).
//
// js/service-tickets.js asks this registry for banners, sections, badges,
// timeline wording and move confirmations; every 1.29 office module answers
// by registering. So its semantics are the contract between six modules:
//
//   * list order is `order` (default 100), then registration; re-registering
//     a name replaces that module and keeps its place;
//   * one module throwing is logged as '[p86StExt] <name>.<hook>' and skipped,
//     and every other module still runs;
//   * collect keeps every non-null result, first returns the first result that
//     is not undefined (null is an answer), html joins the string results.
//
// The shipped file is required as a module (createRegistry) AND evaluated as
// a browser script (window.p86StExt), because the page uses the latter.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.join(__dirname, '..', 'js', 'service-ticket-ext.js');
const SRC = fs.readFileSync(EXT_PATH, 'utf8');
const { createRegistry } = require('../js/service-ticket-ext.js');

function fromSource(src) {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'window', src)(mod, undefined);
  return mod.exports.createRegistry;
}

function mutant(anchor, replacement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ext-mutant-'));
  const copy = path.join(dir, 'service-ticket-ext.js');
  fs.writeFileSync(copy, SRC);
  const src = fs.readFileSync(copy, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length - 1 !== 1) throw new Error('anchor not found');
  return fromSource(src.replace(anchor, replacement));
}

let warn;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

// ── Checks, reused by the mutants ────────────────────────────────────────
function checkOrder(create) {
  const reg = create();
  reg.register('ticket-print', { order: 60 });
  reg.register('work-order-review', { order: 10 });
  reg.register('late-default', {});
  reg.register('ticket-flags', { order: 30 });
  reg.register('early-default', {});
  reg.register('work-order-notices', { order: 20 });
  expect(reg.list().map((e) => [e.name, e.order])).toEqual([
    ['work-order-review', 10],
    ['work-order-notices', 20],
    ['ticket-flags', 30],
    ['ticket-print', 60],
    ['late-default', 100],
    ['early-default', 100],
  ]);
}

function checkIsolation(create) {
  const reg = create();
  const seen = [];
  reg.register('a', { order: 1, rowBadges: () => { seen.push('a'); return '<span class="a"></span>'; } });
  reg.register('broken', { order: 2, rowBadges: () => { seen.push('broken'); throw new Error('boom'); } });
  reg.register('c', { order: 3, rowBadges: (row) => { seen.push('c'); return '<span class="c">' + row.id + '</span>'; } });
  expect(reg.html('rowBadges', { id: 'st_1' })).toBe('<span class="a"></span><span class="c">st_1</span>');
  expect(seen).toEqual(['a', 'broken', 'c']);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toBe('[p86StExt] broken.rowBadges');
}

function checkFirst(create) {
  const reg = create();
  reg.register('no-answer', { order: 1, confirmMove: () => undefined });
  reg.register('thrower', { order: 2, confirmMove: () => { throw new Error('x'); } });
  reg.register('review', { order: 3, confirmMove: (ctx, to) => (to === 'cancelled' ? null : { reason: 'r' }) });
  reg.register('never-reached', { order: 4, confirmMove: () => ({ reason: 'later' }) });
  expect(reg.first('confirmMove', {}, 'cancelled')).toBe(null);
  expect(reg.first('confirmMove', {}, 'approved')).toEqual({ reason: 'r' });
  expect(reg.first('nobodyHasThis', {})).toBeUndefined();
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('register / list order', () => {
  test('sorted by order, then by registration; order defaults to 100', () => checkOrder(createRegistry));

  test('re-registering a name replaces it and keeps its place', () => {
    const reg = createRegistry();
    const v1 = { order: 50, cardMeta: () => 'v1' };
    const v2 = { order: 50, cardMeta: () => 'v2' };
    reg.register('ticket-co', v1);
    reg.register('ticket-print', { order: 50, cardMeta: () => 'print' });
    reg.register('ticket-co', v2);
    expect(reg.list().map((e) => e.name)).toEqual(['ticket-co', 'ticket-print']);
    expect(reg.list()[0].ext).toBe(v2);
    expect(reg.html('cardMeta', {}, {})).toBe('v2print');
  });

  test('a replacement with a new order moves to where that order puts it', () => {
    const reg = createRegistry();
    reg.register('a', { order: 10 });
    reg.register('b', { order: 20 });
    reg.register('a', { order: 30 });
    expect(reg.list().map((e) => e.name)).toEqual(['b', 'a']);
  });

  test('a non-number order is the default 100', () => {
    const reg = createRegistry();
    reg.register('str', { order: '5' });
    reg.register('nan', { order: NaN });
    reg.register('ten', { order: 10 });
    expect(reg.list().map((e) => [e.name, e.order])).toEqual([['ten', 10], ['str', 100], ['nan', 100]]);
  });

  test('unregister removes; unknown names and bad registrations are harmless', () => {
    const reg = createRegistry();
    expect(reg.register('a', { rowBadges: () => 'A' })).toBe(true);
    expect(reg.register('', { rowBadges: () => 'X' })).toBe(false);
    expect(reg.register('nothing', null)).toBe(false);
    expect(reg.unregister('a')).toBe(true);
    expect(reg.unregister('a')).toBe(false);
    expect(reg.list()).toEqual([]);
    expect(reg.html('rowBadges', {})).toBe('');
  });

  test('list() hands back copies: mutating them does not reorder the registry', () => {
    const reg = createRegistry();
    reg.register('a', { order: 1 });
    reg.register('b', { order: 2 });
    const l = reg.list();
    l.reverse();
    l[0].order = -5;
    expect(reg.list().map((e) => [e.name, e.order])).toEqual([['a', 1], ['b', 2]]);
  });

  test('MUTANT: ignoring order (registration only) goes red', () => {
    const create = mutant('return (a.order - b.order) || (a.seq - b.seq);', 'return a.seq - b.seq;');
    expect(() => checkOrder(create)).toThrow();
  });
});

describe('hooks run isolated from each other', () => {
  test('a throwing module is warned by name.hook and skipped; the rest still run', () => checkIsolation(createRegistry));

  test('MUTANT: no try/catch around a hook call goes red', () => {
    const create = mutant(
      '        try {\n          out = fn.apply(e.ext, args);\n        } catch (err) {\n          warn(e.name, hook, err);\n          continue;\n        }\n',
      '        out = fn.apply(e.ext, args);\n');
    expect(() => checkIsolation(create)).toThrow();
  });

  test('hooks receive every argument, with the module as this', () => {
    const reg = createRegistry();
    const ext = {
      order: 1,
      eventWhat(event, helpers) { return this === ext ? helpers.esc(event.kind) : null; },
    };
    reg.register('work-order-notices', ext);
    expect(reg.first('eventWhat', { kind: 'flag<raised>' }, { esc: (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;') }))
      .toBe('flag&lt;raised&gt;');
  });
});

describe('collect / first / html semantics', () => {
  test('collect keeps every non-null result, in list order', () => {
    const reg = createRegistry();
    const secA = [{ key: 'wor-bar', slot: 'banner', html: '<div></div>' }];
    reg.register('b', { order: 20, detailSections: () => null });
    reg.register('a', { order: 10, detailSections: () => secA });
    reg.register('c', { order: 30, detailSections: () => undefined });
    reg.register('d', { order: 40, detailSections: () => [] });
    reg.register('e', { order: 50, detailSections: () => { throw new Error('no'); } });
    reg.register('f', { order: 60, afterStatus: () => 'not asked' });
    reg.register('g', { order: 70, detailSections: () => 0 });
    expect(reg.collect('detailSections', { ticketId: 'st_1' })).toEqual([secA, [], 0]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['[p86StExt] e.detailSections']);
  });

  test('first returns the first result that is not undefined — null counts', () => checkFirst(createRegistry));

  test('MUTANT: first skipping null (treating it like undefined) goes red', () => {
    const create = mutant('if (out !== undefined) { found = out; return true; }', 'if (out != null) { found = out; return true; }');
    expect(() => checkFirst(create)).toThrow();
  });

  test('html joins only string results', () => {
    const reg = createRegistry();
    reg.register('a', { order: 1, noteActions: () => '<button>A</button>' });
    reg.register('b', { order: 2, noteActions: () => null });
    reg.register('c', { order: 3, noteActions: () => 42 });
    reg.register('d', { order: 4, noteActions: () => '' });
    reg.register('e', { order: 5, noteActions: () => '<button>E</button>' });
    reg.register('f', { order: 6, noteActions: 'not a function' });
    expect(reg.html('noteActions', {}, {}, {})).toBe('<button>A</button><button>E</button>');
  });

  test('a module registered while hooks run is not called in that same pass', () => {
    const reg = createRegistry();
    const late = jest.fn(() => 'late');
    reg.register('a', { order: 1, onListPainted: () => { reg.register('z', { order: 2, onListPainted: late }); return 'a'; } });
    expect(reg.collect('onListPainted', {}, {})).toEqual(['a']);
    expect(late).not.toHaveBeenCalled();
    expect(reg.collect('onListPainted', {}, {})).toEqual(['a', 'late']);
  });
});

describe('the browser global', () => {
  function boot(win) {
    // eslint-disable-next-line no-new-func
    new Function('window', 'module', SRC)(win, undefined);
    return win;
  }

  test('window.p86StExt is a registry with exactly the contract methods', () => {
    const win = boot({});
    expect(Object.keys(win.p86StExt).sort()).toEqual(['collect', 'first', 'html', 'list', 'register', 'unregister']);
    win.p86StExt.register('ticket-flags', { order: 30, rowBadges: () => '<i></i>' });
    expect(win.p86StExt.html('rowBadges', {})).toBe('<i></i>');
  });

  test('loading the file a second time keeps what modules already registered', () => {
    const win = boot({});
    win.p86StExt.register('ticket-flags', { order: 30 });
    const first = win.p86StExt;
    boot(win);
    expect(win.p86StExt).toBe(first);
    expect(win.p86StExt.list().map((e) => e.name)).toEqual(['ticket-flags']);
  });

  test('two registries do not share state', () => {
    const a = createRegistry();
    const b = createRegistry();
    a.register('x', {});
    expect(b.list()).toEqual([]);
  });
});
