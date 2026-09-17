/**
 * @jest-environment jsdom
 */
// test/work-orders-1-29-wiring.test.js — the Work Orders release is wired into
// the page, the release notes and the change order editor.
//
// The Work Orders work was planned as 1.29 (hence this file's name) and ships
// as 1.30, because main shipped the Service Tickets page as 1.29 first.
//
// What is proved:
//   * index.html tags every Work Orders module exactly once, every file it tags
//     exists, and the modules load in the order they depend on: the extension
//     registry, the status mover, the upload queue, the office uploads and the
//     editor kit BEFORE js/service-tickets.js; the Work Orders page, Review &
//     approve, the notice banners, flags, change order and print AFTER it. The
//     registry loads before EVERY module that registers with it, found by
//     scanning js/ rather than by a list, so a new registrant is covered.
//   * the stylesheets come after css/styles.css and css/workspace-layout.css,
//     so they win at equal specificity.
//   * each Work Orders file's ?v tells the truth (test/helpers/cache-buster.js),
//     and so do js/jobs.js and js/change-order-editor.js.
//   * APP_VERSION is the newest release, versions are unique and newest first,
//     the Work Orders release sits above the Service Tickets page release, its
//     rows are grouped new / improved / fixed, and its feature entries exist.
//   * the change order editor: fromWorkOrder is custodial, defaultTerms is the
//     terms a new change order starts with, and the From work order card and
//     the customer document's Photos section draw what the link holds —
//     escaped, capped, no money — with Open work order going back to the ticket.
//
// Each order and catalog check is a function run against the real file AND a
// mutant of it that must fail, so none of them can pass by matching nothing.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const INDEX = read('index.html');
const cacheBuster = require('./helpers/cache-buster.js');

// ── the Work Orders files, in the order index.html must load them ─────────
const BEFORE_HOST = [
  'js/service-ticket-ext.js',
  'js/service-ticket-status-move.js',
  'js/photo-upload-queue.js',
  'js/work-order-uploads.js',
  'js/service-ticket-editor.js',
];
const HOST = 'js/service-tickets.js';
const AFTER_HOST = [
  'js/work-orders-board.js',
  'js/work-order-review.js',
  'js/work-order-notices.js',
  'js/service-ticket-flags.js',
  'js/service-ticket-co.js',
  'js/service-ticket-print.js',
];
const STYLES = [
  'css/service-ticket-editor.css',
  'css/work-order-review.css',
  'css/service-ticket-flags.css',
  'css/service-ticket-co-print.css',
  'css/work-orders-board.css',
];
const NEW_FILES = BEFORE_HOST.concat(AFTER_HOST, STYLES);

// Local js/css references in document order, comments stripped (a commented-
// out tag is not a load), cache-buster dropped.
function refsIn(html, attr) {
  const live = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const re = attr === 'src'
    ? /<script\b[^>]*\bsrc="((?:js|css)\/[^"?]+)(?:\?v=[0-9]+[a-z]?)?"/g
    : /<link\b[^>]*\bhref="((?:js|css)\/[^"?]+)(?:\?v=[0-9]+[a-z]?)?"/g;
  return [...live.matchAll(re)].map((m) => m[1]);
}

function countTags(html, file) {
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (String(html).replace(/<!--[\s\S]*?-->/g, '').match(new RegExp('(?:src|href)="' + esc + '\\?v=[0-9]+[a-z]?"', 'g')) || []).length;
}

// The modules that register with window.p86StExt, found by what they do.
function registrants() {
  return fs.readdirSync(path.join(ROOT, 'js'))
    .filter((f) => f.endsWith('.js') && f !== 'service-ticket-ext.js')
    .filter((f) => {
      const src = read('js/' + f);
      return /p86StExt/.test(src) && /\.register\(\s*'[a-z0-9-]+'/.test(src);
    })
    .map((f) => 'js/' + f);
}

// Every problem with the script order, as sentences; [] when it is right.
function scriptOrderProblems(html) {
  const scripts = refsIn(html, 'src');
  const at = (f) => scripts.indexOf(f);
  const out = [];
  const chain = BEFORE_HOST.concat([HOST], AFTER_HOST);
  chain.forEach((f) => { if (at(f) < 0) out.push(f + ' is not loaded'); });
  for (let i = 1; i < chain.length; i++) {
    if (at(chain[i - 1]) >= 0 && at(chain[i]) >= 0 && at(chain[i - 1]) > at(chain[i])) {
      out.push(chain[i - 1] + ' loads after ' + chain[i]);
    }
  }
  registrants().forEach((f) => {
    if (at(f) < 0) out.push(f + ' registers with p86StExt but is not loaded');
    else if (at(f) < at('js/service-ticket-ext.js')) out.push(f + ' loads before the registry');
  });
  // What they all call through.
  ['js/api.js', 'js/refresh.js'].forEach((f) => {
    if (at(f) < 0 || at(f) > at(chain[0])) out.push(f + ' must load before the Work Orders modules');
  });
  return out;
}

function styleOrderProblems(html) {
  const links = refsIn(html, 'href');
  const at = (f) => links.indexOf(f);
  const out = [];
  STYLES.forEach((f) => {
    if (at(f) < 0) out.push(f + ' is not linked');
    else ['css/styles.css', 'css/workspace-layout.css'].forEach((base) => {
      if (at(base) < 0 || at(base) > at(f)) out.push(f + ' is linked before ' + base);
    });
  });
  return out;
}

function mutateIndex(find, replace) {
  if (INDEX.split(find).length !== 2) throw new Error('anchor not found: ' + find);
  return INDEX.split(find).join(replace);
}
const tagOf = (file) => {
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = INDEX.match(new RegExp('<script src="' + esc + '\\?v=[0-9]+[a-z]?"></script>'));
  if (!m) throw new Error('no script tag for ' + file);
  return m[0];
};

describe('index.html loads the Work Orders modules', () => {
  test.each(NEW_FILES)('%s is tagged exactly once, with a ?v', (f) => {
    expect(countTags(INDEX, f)).toBe(1);
  });

  test('every js/css file index.html tags exists', () => {
    const tagged = cacheBuster.taggedFiles(INDEX);
    expect(tagged.length).toBeGreaterThan(100);
    expect(tagged.filter((f) => !fs.existsSync(path.join(ROOT, f)))).toEqual([]);
    // And the host plus the Work Orders set are among them.
    expect(NEW_FILES.concat([HOST]).filter((f) => tagged.indexOf(f) < 0)).toEqual([]);
  });

  test('the scripts load in dependency order, and the registry before every registrant', () => {
    // The scan is not vacuous: it finds the six registrants this release adds.
    expect(registrants()).toEqual(expect.arrayContaining([
      'js/work-order-uploads.js', 'js/work-order-review.js', 'js/work-order-notices.js',
      'js/service-ticket-flags.js', 'js/service-ticket-co.js', 'js/service-ticket-print.js',
    ]));
    expect(scriptOrderProblems(INDEX)).toEqual([]);
  });

  test('mutant: the registry moved below the host is caught', () => {
    const ext = tagOf('js/service-ticket-ext.js');
    const host = tagOf(HOST);
    const moved = mutateIndex(ext, '').split(host).join(host + '\n    ' + ext);
    expect(scriptOrderProblems(moved)).toEqual(expect.arrayContaining([
      'js/service-ticket-ext.js loads after js/service-ticket-status-move.js',
    ]));
  });

  test('mutant: the change order module loaded before the host is caught', () => {
    const co = tagOf('js/service-ticket-co.js');
    const host = tagOf(HOST);
    const moved = mutateIndex(co, '').split(host).join(co + '\n    ' + host);
    expect(scriptOrderProblems(moved).length).toBeGreaterThan(0);
  });

  test('mutant: a commented-out tag does not count as a load', () => {
    const print = tagOf('js/service-ticket-print.js');
    const gone = mutateIndex(print, '<!-- ' + print + ' -->');
    expect(scriptOrderProblems(gone)).toEqual(expect.arrayContaining(['js/service-ticket-print.js is not loaded']));
    expect(countTags(gone, 'js/service-ticket-print.js')).toBe(0);
  });

  test('the stylesheets come after styles.css and workspace-layout.css', () => {
    expect(styleOrderProblems(INDEX)).toEqual([]);
  });

  test('mutant: a stylesheet linked above styles.css is caught', () => {
    const link = INDEX.match(/<link rel="stylesheet" href="css\/service-ticket-co-print\.css\?v=[0-9]+">/)[0];
    const styles = INDEX.match(/<link rel="stylesheet" href="css\/styles\.css\?v=[0-9]+">/)[0];
    const moved = mutateIndex(link, '').split(styles).join(link + '\n    ' + styles);
    expect(styleOrderProblems(moved)).toEqual(expect.arrayContaining([
      'css/service-ticket-co-print.css is linked before css/styles.css',
    ]));
  });

  test.each(NEW_FILES.concat(['js/jobs.js', 'js/change-order-editor.js']))('%s: the ?v tells the truth', (f) => {
    expect(cacheBuster.report(f)).toMatchObject(cacheBuster.healthy(f));
  });
});

// ── the release notes ─────────────────────────────────────────────────────
const catalog = require('../server/feature-catalog.js');

function versionKey(v) {
  const m = /^(\d+)\.(\d+)$/.exec(String(v));
  return m ? Number(m[1]) * 100000 + Number(m[2]) : NaN;
}

function catalogProblems(c) {
  const out = [];
  const rel = c.releases || [];
  if (!rel.length) return ['no releases'];
  if (c.APP_VERSION !== rel[0].version) out.push('APP_VERSION ' + c.APP_VERSION + ' is not the newest release ' + rel[0].version);
  const seen = new Set();
  rel.forEach((r, i) => {
    if (Number.isNaN(versionKey(r.version))) out.push('bad version ' + r.version);
    if (seen.has(r.version)) out.push('duplicate version ' + r.version);
    seen.add(r.version);
    if (i > 0 && !(versionKey(rel[i - 1].version) > versionKey(r.version))) {
      out.push(rel[i - 1].version + ' is listed above ' + r.version + ' but is not newer');
    }
  });
  const wo = rel.findIndex((r) => r.name === 'Work Orders');
  const stp = rel.findIndex((r) => r.name === 'Service Tickets page');
  if (wo < 0) out.push('no Work Orders release');
  if (stp < 0) out.push('the Service Tickets page release is gone');
  if (wo >= 0 && stp >= 0 && wo !== stp - 1) out.push('Work Orders is not directly above the Service Tickets page release');
  if (wo >= 0) {
    const r = rel[wo];
    const rank = { new: 0, improved: 1, fixed: 2 };
    let last = -1;
    (r.changes || []).forEach((ch) => {
      if (!(ch.type in rank)) out.push('unknown change type ' + ch.type);
      else if (rank[ch.type] < last) out.push('rows are not grouped new, improved, fixed');
      else last = rank[ch.type];
      if (!ch.text || typeof ch.text !== 'string') out.push('a row with no text');
    });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) out.push('bad date ' + r.date);
  }
  return out;
}

describe('the Work Orders release', () => {
  test('APP_VERSION is the newest release, versions run newest first, Work Orders sits above 1.29', () => {
    expect(catalogProblems(catalog)).toEqual([]);
  });

  test('mutant: APP_VERSION left on the previous release is caught', () => {
    const stale = Object.assign({}, catalog, { APP_VERSION: catalog.releases[1].version });
    expect(catalogProblems(stale)).toEqual(expect.arrayContaining([
      'APP_VERSION ' + catalog.releases[1].version + ' is not the newest release ' + catalog.releases[0].version,
    ]));
  });

  test('mutant: a release added BELOW an older one is caught', () => {
    const swapped = Object.assign({}, catalog, {
      releases: [catalog.releases[1], catalog.releases[0]].concat(catalog.releases.slice(2)),
      APP_VERSION: catalog.releases[1].version,
    });
    expect(catalogProblems(swapped).length).toBeGreaterThan(0);
  });

  test('mutant: rows out of group are caught', () => {
    const wo = catalog.releases.find((r) => r.name === 'Work Orders');
    const mixed = Object.assign({}, wo, { changes: wo.changes.slice().reverse() });
    const releases = catalog.releases.map((r) => (r === wo ? mixed : r));
    expect(catalogProblems(Object.assign({}, catalog, { releases })))
      .toEqual(expect.arrayContaining(['rows are not grouped new, improved, fixed']));
  });

  test('its feature entries exist, ship on the release date, and every feature id is unique', () => {
    const wo = catalog.releases.find((r) => r.name === 'Work Orders');
    const ids = catalog.features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['work-order-review', 'work-order-flag-problem', 'work-orders-board',
      'work-order-notices', 'service-ticket-change-order', 'service-ticket-print']) {
      const f = catalog.features.find((x) => x.id === id);
      expect(f).toBeTruthy();
      expect(f.shipped).toBe(wo.date);
      expect(f.area).toBe('Jobs');
      for (const k of ['label', 'blurb', 'access_path']) expect(typeof f[k] === 'string' && f[k].length > 0).toBe(true);
    }
  });
});

// ── the change order editor ───────────────────────────────────────────────
describe('the change order editor carries the work order link', () => {
  const EDITOR_SRC = read('js/change-order-editor.js');
  const CO_PRINT_CSS = read('css/service-ticket-co-print.css');
  let T;

  const photo = (i, extra) => Object.assign({
    attachment_id: 'att_' + i, filename: 'p' + i + '.jpg', kind: 'completion', building: 'Bldg 78' + i,
    thumb_url: '/t/' + i + '.jpg', web_url: '/w/' + i + '.jpg', entity_type: 'task', entity_id: 'k' + i,
  }, extra || {});
  const baseCo = (link) => ({
    id: 'co_1', job_id: 'job_9', co_number: 'CO-4', title: 'Extra rail', scope: '', terms: '',
    targetMargin: '', defaultMarkup: '', feeFlat: 0, feePct: 0, taxPct: 0, roundTo: 0,
    lines: [{ id: 'l1', description: 'Rail', qty: 1, unitCost: 400, unitSell: 900 }],
    fromWorkOrder: link,
  });

  beforeAll(() => {
    T = require('../js/change-order-editor.js').__test;
  });

  test('fromWorkOrder is a custodial key, written back as it was', () => {
    expect(EDITOR_SRC).toMatch(/var CO_CUSTODIAL_KEYS = \[[^\]]*'fromWorkOrder'[^\]]*\]/);
    const link = { v: 1, ticketId: 'st_1', ticketTitle: 'Gate', source: { kind: 'ticket' }, photos: [photo(1)] };
    expect(T.coSavePayload(baseCo(link)).fromWorkOrder).toEqual(link);
  });

  test('defaultTerms is the terms + New Change Order starts with', () => {
    const terms = window.p86ChangeOrders && window.p86ChangeOrders.defaultTerms;
    expect(typeof terms).toBe('string');
    expect(terms.length).toBeGreaterThan(20);
    expect(EDITOR_SRC).toMatch(/defaultTerms: DEFAULT_CO_TERMS/);
    expect(EDITOR_SRC).toMatch(/terms: DEFAULT_CO_TERMS,/);
  });

  test('no link, a malformed link or one without a ticket draws nothing', () => {
    expect(T.fromWorkOrderCardHTML(baseCo(undefined))).toBe('');
    expect(T.fromWorkOrderCardHTML(baseCo('not json'))).toBe('');
    expect(T.fromWorkOrderCardHTML(baseCo([1, 2]))).toBe('');
    expect(T.fromWorkOrderCardHTML(baseCo({ ticketTitle: 'No id' }))).toBe('');
    expect(T.coDocPhotosHTML(baseCo(undefined))).toBe('');
  });

  test('the card names the work order and building, escaped, with the stylesheet\'s classes', () => {
    const link = JSON.stringify({ v: 1, ticketId: 'st_1', ticketTitle: '<b>Gate</b> repair', source: { kind: 'building_note', building: 'Bldg "784"' }, photos: [photo(1)] });
    const host = document.createElement('div');
    host.innerHTML = T.fromWorkOrderCardHTML(baseCo(link));
    const card = host.querySelector('#p86CoFromWorkOrder');
    expect(card).toBeTruthy();
    expect(card.querySelector('.p86-co-from-wo-lbl').textContent).toBe('From work order');
    expect(card.querySelector('.p86-co-from-wo-title').textContent).toBe('<b>Gate</b> repair · Bldg "784"');
    expect(card.querySelector('b')).toBeNull();
    expect(card.querySelectorAll('.p86-co-from-wo-thumbs button img')).toHaveLength(1);
    expect(card.querySelector('[data-co-open-wo]')).toBeTruthy();
    for (const cls of ['p86-co-from-wo', 'p86-co-from-wo-lbl', 'p86-co-from-wo-title', 'p86-co-from-wo-thumbs', 'p86-co-from-wo-more']) {
      expect(CO_PRINT_CSS).toContain('.' + cls + ' ');
    }
  });

  test('eight thumbnails at most, then +N; photos with nothing to show are skipped; no money', () => {
    const photos = [];
    for (let i = 0; i < 11; i++) photos.push(photo(i));
    photos.push({ attachment_id: 'att_blank', kind: 'before' });
    const host = document.createElement('div');
    host.innerHTML = T.fromWorkOrderCardHTML(baseCo({ v: 1, ticketId: 'st_1', ticketTitle: 'Gate', photos }));
    expect(host.querySelectorAll('[data-co-wo-photo]')).toHaveLength(8);
    expect(host.querySelector('.p86-co-from-wo-more').textContent).toBe('+3');
    expect(host.innerHTML).not.toMatch(/\$|900|400/);
  });

  test('without a job there is no Open work order button', () => {
    const co = baseCo({ v: 1, ticketId: 'st_1', ticketTitle: 'Gate', photos: [] });
    co.job_id = null;
    const host = document.createElement('div');
    host.innerHTML = T.fromWorkOrderCardHTML(co);
    expect(host.querySelector('#p86CoFromWorkOrder')).toBeTruthy();
    expect(host.querySelector('[data-co-open-wo]')).toBeNull();
    expect(host.querySelector('.p86-co-from-wo-thumbs')).toBeNull();
  });

  test('the customer document gets a Photos section with building and kind, and no price', () => {
    const html = T.coDocPhotosHTML(baseCo({ v: 1, ticketId: 'st_1', ticketTitle: 'Gate', photos: [photo(1), photo(2, { kind: 'before' })] }));
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('h2.sec').textContent).toBe('Photos');
    expect(Array.from(host.querySelectorAll('figcaption')).map((c) => c.textContent)).toEqual(['Bldg 781 · Completion', 'Bldg 782 · Before']);
    expect(host.querySelectorAll('img')).toHaveLength(2);
    expect(html).not.toMatch(/\$|900|400/);
  });

  describe('Open work order', () => {
    let went;
    beforeEach(() => {
      went = [];
      T.setNavigate((href) => went.push(href));
      delete window.p86ServiceTickets;
      window.appData = { jobs: [] };
    });

    test('a job not loaded in this page goes to the job tab deep link for that ticket', () => {
      T.setCo(baseCo({ v: 1, ticketId: 'st 1', ticketTitle: 'Gate', photos: [] }));
      T.openFromWorkOrder();
      expect(went).toEqual(['/jobs/job_9/job-service-tickets?ticket=st%201']);
      // The editor closed on the way out.
      expect(T.getCo()).toBeNull();
    });

    test('a job already loaded opens the ticket in place and does not reload the page', () => {
      const opened = [];
      window.appData = { jobs: [{ id: 'job_9' }] };
      window.p86ServiceTickets = { openTicket: (jobId, ticketId) => { opened.push([jobId, ticketId]); return true; } };
      T.setCo(baseCo({ v: 1, ticketId: 'st_1', ticketTitle: 'Gate', photos: [] }));
      T.openFromWorkOrder();
      expect(opened).toEqual([['job_9', 'st_1']]);
      expect(went).toEqual([]);
    });

    test('a change order with no link goes nowhere', () => {
      T.setCo(baseCo(undefined));
      T.openFromWorkOrder();
      expect(went).toEqual([]);
      expect(T.getCo()).not.toBeNull();
    });
  });
});

describe('the job\'s Change Orders list names the work order', () => {
  const JOBS_SRC = read('js/jobs.js');

  test('each change order row runs fromWorkOrderLine under its title, and that line shows no money', () => {
    expect(JOBS_SRC).toContain("escapeHTML(c.title || '(untitled)') + fromWorkOrderLine(c) + '</td>'");
    const at = JOBS_SRC.indexOf('function fromWorkOrderLine(c)');
    expect(at).toBeGreaterThan(-1);
    const body = JOBS_SRC.slice(at, JOBS_SRC.indexOf('\n            }', at));
    expect(body).toContain("'From work order: '");
    expect(body).not.toMatch(/formatCurrency|coTotal|unitSell|amount/);
  });
});
