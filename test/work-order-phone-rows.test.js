// The open work order's sideways rows on a phone, and in a narrow mouse window.
//
// Two review findings against the phone layout, both about the rows that run
// one line and swipe (ticket filter pills, the status stepper, the job's money
// strip). jsdom has no layout and no media queries, so each is asked of the
// stylesheet through a small cascade (test/helpers/css-cascade.js) at the
// sizes the findings measured in a real browser.
//
// 1. THE PANE SCROLLED SIDEWAYS 15px. The phone block drops #wsRightContent's
//    padding, then gave the pills and the stepper `margin: 0 -15px` to run
//    edge to edge past .main-inner's 15px padding. #wsRightContent is
//    overflow:auto, so the rows stuck 15px out of the box that scrolls: at
//    390px scrollWidth 375 against clientWidth 360, and a slightly diagonal
//    swipe slid the whole work order left, cutting the first letter off every
//    card. The page itself never scrolled, so a page-level check missed it.
//    The fix makes the pane carry the bleed as its own padding. Asked here as
//    arithmetic: how far does a row's box stick out of the pane's padding box,
//    and how far does the pane stick out of .main-inner.
//
// 2. A 700px MOUSE WINDOW COULD NOT REACH HALF THE FILTERS. The nowrap row and
//    its hidden scrollbar were gated on width alone. In a narrow mouse window
//    (a high-DPI Windows PWA) "In progress", "Awaiting approval" and "Closed"
//    sat off the edge, a vertical wheel did nothing, and nothing showed the
//    row scrolled; the money strip hid "% Complete" through "Margin %" the same
//    way. The swipe rows are now touch-only, like the section strip, and a
//    mouse gets rows that wrap.
//
// Each check is also run against the exact rules the findings measured,
// copied below, and has to come out wrong there.
//
// 3. INTERNAL NOTES SHOWED UNDER DETAILS AND THE ACTION BAR. On a phone the
//    open work order is one flex column and styles.css sends every
//    .p86-st-detail-main child except the Scope card to order 2, after Details
//    (order 1). The Internal notes card (css/service-ticket-editor.css, linked
//    after styles.css) is a detail-main child too, so it fell to the bottom
//    half, far from the Scope it sits under on a desktop. Asked here of the
//    two stylesheets together, in link order, against the host's markup.
'use strict';

const fs = require('fs');
const path = require('path');
const { rules } = require('./helpers/css-rules');
const { computed, px, mediaMatches, specificity } = require('./helpers/css-cascade');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const STYLES = rules(fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8'));
const LAYOUT = rules(fs.readFileSync(path.join(ROOT, 'css', 'workspace-layout.css'), 'utf8'));

const PANE = '#wsRightContent:has(> #job-service-tickets[style*="block"])';
const ROWS = {
  pills: ['.p86-st-pills', '#job-service-tickets .p86-st-pills', PANE + ' .p86-st-pills'],
  stepper: ['.p86-st-stepper', '#job-service-tickets .p86-st-stepper', PANE + ' .p86-st-stepper'],
};
const STRIP = ['.jh-metrics-strip', '#jh-strip-detached.jh-metrics-strip'];
const STRIP_BAR = ['.jh-metrics-strip::-webkit-scrollbar', '#jh-strip-detached.jh-metrics-strip::-webkit-scrollbar'];

const PHONES = [360, 390, 412].map((w) => ({ width: w, pointer: 'coarse', label: w + 'px touch' }));
const MOUSE_700 = { width: 700, pointer: 'fine', label: '700px mouse window' };
const DESKTOP = { width: 1280, pointer: 'fine', label: '1280px desktop' };

// How far each row sticks out past the pane's padding box, and the pane out
// of .main-inner, on each side. Anything above 0 is something to scroll.
function overhang(sheet, env) {
  const get = (sels, prop) => px(computed(sheet, sels, env, prop));
  const out = {};
  const inner = { left: get(['.main-inner', 'main, .main-inner'], 'padding-left'), right: get(['.main-inner', 'main, .main-inner'], 'padding-right') };
  const pane = {
    marginLeft: get([PANE], 'margin-left'), marginRight: get([PANE], 'margin-right'),
    padLeft: get([PANE], 'padding-left'), padRight: get([PANE], 'padding-right'),
  };
  out.paneOutOfMain = Math.max(0, -pane.marginLeft - inner.left, -pane.marginRight - inner.right);
  for (const [name, sels] of Object.entries(ROWS)) {
    out[name] = Math.max(0, -get(sels, 'margin-left') - pane.padLeft, -get(sels, 'margin-right') - pane.padRight);
  }
  return out;
}

// A row is reachable with a mouse if it wraps, or if it scrolls with a
// scrollbar someone can see and drag.
function mouseReachable(sheet, env, sels, barSels) {
  const wrap = (computed(sheet, sels, env, 'flex-wrap') || {}).value || 'nowrap';
  if (wrap === 'wrap') return { ok: true, wrap };
  const ox = (computed(sheet, sels, env, 'overflow-x') || {}).value || 'visible';
  const sbw = (computed(sheet, sels, env, 'scrollbar-width') || {}).value || 'auto';
  const hiddenBar = ((computed(sheet, barSels, env, 'display') || {}).value || '') === 'none';
  return { ok: (ox === 'auto' || ox === 'scroll') && sbw !== 'none' && !hiddenBar, wrap, ox, sbw, hiddenBar };
}
const barsOf = (sels) => sels.map((s) => s + '::-webkit-scrollbar');

// ── The rules the findings measured, as they shipped (f1721ebc) ────────────
const SHIPPED_PANE_ROWS = rules(`
  .p86-st-pills { display: flex; gap: 4px; flex-wrap: wrap; flex: 1 1 auto; }
  .p86-st-stepper { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 14px; }
  @media (max-width: 768px) { .main-inner { padding: 15px; } }
  @media (max-width: 760px) {
    #wsRightContent:has(> #job-service-tickets[style*="block"]) { padding: 0; border: 0; background: transparent; }
    #job-service-tickets .p86-st-pills {
      grid-column: 1 / -1; flex-wrap: nowrap; gap: 6px; overflow-x: auto; overflow-y: hidden;
      overscroll-behavior-x: contain; scrollbar-width: none; margin: 0 -15px; padding: 0 15px;
    }
    #job-service-tickets .p86-st-pills::-webkit-scrollbar { display: none; }
    #job-service-tickets .p86-st-stepper {
      flex-wrap: nowrap; gap: 5px; margin: 10px -15px 0; padding: 1px 15px;
      overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none;
    }
    #job-service-tickets .p86-st-stepper::-webkit-scrollbar { display: none; }
  }
`);
const SHIPPED_STRIP = rules(`
  .jh-metrics-strip { display: flex; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
  .jh-metrics-strip::-webkit-scrollbar { height: 4px; }
  @media (max-width: 768px) {
    #jh-strip-detached.jh-metrics-strip {
      padding: 8px 12px; gap: 6px; scroll-snap-type: x proximity;
      -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; scrollbar-width: none;
    }
    #jh-strip-detached.jh-metrics-strip::-webkit-scrollbar { display: none; }
    #jh-strip-detached .p86-totals-chip { flex: 0 0 auto; padding: 6px 10px; scroll-snap-align: start; }
  }
`);

describe('the ticket pane has nothing to scroll sideways', () => {
  for (const env of PHONES.concat([MOUSE_700, DESKTOP])) {
    test('at ' + env.label + ' no row sticks out of #wsRightContent and the pane stays inside main', () => {
      expect(overhang(STYLES, env)).toEqual({ paneOutOfMain: 0, pills: 0, stepper: 0 });
    });
  }

  test('on a touch phone the rows still run edge to edge: the bleed moved into the pane, it did not go away', () => {
    const env = PHONES[1];
    expect(px(computed(STYLES, [PANE], env, 'margin-left'))).toBe(-15);
    expect(px(computed(STYLES, [PANE], env, 'padding-left'))).toBe(15);
    expect(px(computed(STYLES, ROWS.pills, env, 'margin-left'))).toBe(-15);
    expect(px(computed(STYLES, ROWS.stepper, env, 'margin-right'))).toBe(-15);
  });

  test('FIRES: the shipped rules stick 15px out of the pane at 390px touch and in the 700px mouse window', () => {
    expect(overhang(SHIPPED_PANE_ROWS, PHONES[1])).toEqual({ paneOutOfMain: 0, pills: 15, stepper: 15 });
    expect(overhang(SHIPPED_PANE_ROWS, MOUSE_700)).toEqual({ paneOutOfMain: 0, pills: 15, stepper: 15 });
  });

  // Row selectors that give a pane row a negative side margin outside the
  // pane's :has(). A browser without :has() keeps the pane's frame (12px
  // padding) and must not get a 15px bleed out of it.
  function bleedsWithoutPane(sheet) {
    const bad = [];
    for (const rule of sheet) {
      const rowSel = rule.selectors.filter((s) => /\.p86-st-(pills|stepper)$/.test(s));
      if (!rowSel.length) continue;
      const neg = rule.decls.some((d) => (d.prop === 'margin-left' || d.prop === 'margin-right') ? /^-/.test(d.value)
        : d.prop === 'margin' && d.value.split(/\s+/).filter((_, i) => i % 2 === 1).some((v) => /^-/.test(v)));
      if (neg) rowSel.filter((s) => !s.startsWith(PANE + ' ')).forEach((s) => bad.push(s));
    }
    return bad;
  }

  test('every negative side margin on a pane row sits behind the same :has() as the pane that carries it', () => {
    expect(bleedsWithoutPane(STYLES)).toEqual([]);
    expect(bleedsWithoutPane(SHIPPED_PANE_ROWS)).toEqual(['#job-service-tickets .p86-st-pills', '#job-service-tickets .p86-st-stepper']);
  });
});

describe('the swipe rows are touch-only; a narrow mouse window can reach every pill and chip', () => {
  for (const [name, sels] of Object.entries(ROWS)) {
    test(name + ': wraps in a 700px mouse window', () => {
      expect(mouseReachable(STYLES, MOUSE_700, sels, barsOf(sels))).toMatchObject({ ok: true, wrap: 'wrap' });
    });
    test(name + ': one row that swipes on a 390px touch phone', () => {
      const env = PHONES[1];
      expect((computed(STYLES, sels, env, 'flex-wrap') || {}).value).toBe('nowrap');
      expect((computed(STYLES, sels, env, 'overflow-x') || {}).value).toBe('auto');
      expect((computed(STYLES, sels, env, 'scrollbar-width') || {}).value).toBe('none');
    });
    test(name + ': the desktop is untouched', () => {
      expect((computed(STYLES, sels, DESKTOP, 'flex-wrap') || {}).value).toBe('wrap');
      expect(computed(STYLES, sels, DESKTOP, 'scrollbar-width')).toBeNull();
    });
  }

  test('money strip: every chip on screen in a 700px mouse window', () => {
    expect(mouseReachable(LAYOUT, MOUSE_700, STRIP, STRIP_BAR)).toMatchObject({ ok: true, wrap: 'wrap' });
  });

  test('money strip: one swipe row with a hidden scrollbar on a 390px touch phone', () => {
    const env = PHONES[1];
    expect((computed(LAYOUT, STRIP, env, 'flex-wrap') || {}).value).toBe('nowrap');
    expect((computed(LAYOUT, STRIP, env, 'overflow-x') || {}).value).toBe('auto');
    expect((computed(LAYOUT, STRIP, env, 'scrollbar-width') || {}).value).toBe('none');
    expect((computed(LAYOUT, STRIP_BAR, env, 'display') || {}).value).toBe('none');
  });

  test('money strip: the desktop row and its thin scrollbar are untouched', () => {
    expect((computed(LAYOUT, STRIP, DESKTOP, 'flex-wrap') || {}).value).toBe('nowrap');
    expect((computed(LAYOUT, STRIP, DESKTOP, 'scrollbar-width') || {}).value).toBe('thin');
  });

  test('FIRES: the shipped pills, stepper and money strip are one row with no scrollbar in the 700px mouse window', () => {
    for (const sels of Object.values(ROWS)) {
      expect(mouseReachable(SHIPPED_PANE_ROWS, MOUSE_700, sels, barsOf(sels))).toMatchObject({ ok: false, wrap: 'nowrap', sbw: 'none' });
    }
    expect(mouseReachable(SHIPPED_STRIP, MOUSE_700, STRIP, STRIP_BAR)).toMatchObject({ ok: false, wrap: 'nowrap', sbw: 'none', hiddenBar: true });
  });
});

// ── 3. Internal notes stays under Scope on a phone ──────────────────────────
const STYLES_TEXT = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const EDITOR_TEXT = fs.readFileSync(path.join(ROOT, 'css', 'service-ticket-editor.css'), 'utf8').replace(/\r\n/g, '\n');
const INTERNAL_RULE = '  #job-service-tickets .p86-st-detail-main > .p86-st-internalcard { order: 0; }\n';

// index.html links styles.css, then service-ticket-editor.css: one sheet, in that order.
function linked(firstText, secondText) {
  const a = rules(firstText);
  const b = rules(secondText).map((r) => Object.assign({}, r, { order: r.order + a.length }));
  return a.concat(b);
}

// The open work order as paintDetail draws it (section roots only).
const DETAIL = new JSDOM(
  '<div id="job-service-tickets" style="display:block"><div class="p86-st-row is-open"><div class="p86-st-detail">' +
    '<div class="p86-st-stepper" data-st-sec="stepper" data-n="stepper"></div>' +
    '<div class="p86-wo-site" data-st-sec="site" data-n="site"></div>' +
    '<div class="p86-st-revs" data-st-sec="revs" data-n="revisions"></div>' +
    '<div class="p86-st-detail-grid">' +
      '<div class="p86-st-detail-main">' +
        '<div class="p86-st-scopecard" data-n="scope"></div>' +
        '<div class="p86-st-internalcard" data-st-sec="internal" data-n="internal notes"></div>' +
        '<div class="p86-wo-mats" data-st-sec="mats" data-n="materials"></div>' +
        '<div class="p86-wo-punch-head" data-st-sec="punchhead" data-n="punch list"></div>' +
        '<div class="p86-wo-subs" data-st-sec="subs" data-n="buildings"></div>' +
        '<div class="p86-st-task-add" data-n="add subtask"></div>' +
      '</div>' +
      '<div class="p86-st-detail-side" data-n="details"></div>' +
    '</div>' +
    '<div class="p86-st-actions" data-n="actions"></div>' +
    '<div class="p86-st-sharewrap" hidden data-n="share"></div>' +
    '<div class="p86-st-parts" data-st-sec="parts" data-n="on this ticket"></div>' +
    '<div class="p86-st-timeline" data-st-sec="timeline" data-n="progress"></div>' +
  '</div></div></div>'
).window.document;

function cmpKey(x, y) {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// The winning value of prop on el at env, over every rule whose selector the
// element matches (pseudo-element selectors never name it).
function valueOn(sheet, el, env, prop) {
  let best = null;
  for (const rule of sheet) {
    if (!mediaMatches(rule.media, env)) continue;
    rule.decls.forEach((d, di) => {
      if (d.prop !== prop) return;
      for (const sel of rule.selectors) {
        if (/::/.test(sel)) continue;
        let hit = false;
        try { hit = el.matches(sel); } catch (e) { continue; }
        if (!hit) continue;
        const sp = specificity(sel);
        const key = [/!important/i.test(d.value) ? 1 : 0, sp[0], sp[1], sp[2], rule.order, di];
        if (!best || cmpKey(key, best.key) >= 0) best = { key, value: d.value.replace(/\s*!important\s*$/i, '') };
      }
    });
  }
  return best ? best.value : null;
}

// The flex column's items top to bottom: display:contents boxes give their
// children to the column, then items sort by order and keep DOM order within.
function columnOrder(sheet, env) {
  const detail = DETAIL.querySelector('.p86-st-detail');
  const items = [];
  (function walk(parent) {
    for (const el of Array.from(parent.children)) {
      if (valueOn(sheet, el, env, 'display') === 'contents') walk(el);
      else items.push(el);
    }
  })(detail);
  return items
    .map((el, i) => ({ name: el.getAttribute('data-n'), order: Number(valueOn(sheet, el, env, 'order') || 0), i }))
    .sort((a, b) => (a.order - b.order) || (a.i - b.i))
    .map((x) => x.name);
}

describe('Internal notes on a phone', () => {
  const PHONE = PHONES[1];
  const SHEET = linked(STYLES_TEXT, EDITOR_TEXT);

  test('the rule is there once, inside the editor stylesheet 760px block', () => {
    expect(EDITOR_TEXT.split(INTERNAL_RULE).length).toBe(2);
    const hits = rules(EDITOR_TEXT).filter((r) => r.selectors.includes('#job-service-tickets .p86-st-detail-main > .p86-st-internalcard') && r.decls.some((d) => d.prop === 'order'));
    expect(hits.map((r) => r.media)).toEqual([['(max-width: 760px)']]);
  });

  test('comes right after Scope and before Details and the action bar, on a touch phone and in a narrow mouse window', () => {
    for (const env of [PHONE, MOUSE_700]) {
      const col = columnOrder(SHEET, env);
      expect([env.label, col.slice(0, 6)]).toEqual([env.label, ['stepper', 'site', 'revisions', 'scope', 'internal notes', 'details']]);
      expect(col.indexOf('internal notes')).toBeLessThan(col.indexOf('actions'));
      expect(col.indexOf('internal notes')).toBeLessThan(col.indexOf('materials'));
    }
  });

  test('the rest of the phone order is as styles.css set it: Details, actions, share, then materials, the punch list and the timeline', () => {
    expect(columnOrder(SHEET, PHONE)).toEqual([
      'stepper', 'site', 'revisions', 'scope', 'internal notes', 'details', 'actions', 'share',
      'materials', 'punch list', 'buildings', 'add subtask', 'on this ticket', 'progress',
    ]);
  });

  test('FIRES: without the rule Internal notes drops below Details and the action bar', () => {
    const broken = linked(STYLES_TEXT, EDITOR_TEXT.replace(INTERNAL_RULE, ''));
    const col = columnOrder(broken, PHONE);
    expect(col.indexOf('internal notes')).toBeGreaterThan(col.indexOf('actions'));
    expect(col.indexOf('internal notes')).toBe(col.indexOf('materials') - 1);
  });

  test('FIRES: the same rule linked BEFORE styles.css loses on source order', () => {
    const early = linked(EDITOR_TEXT, STYLES_TEXT);
    const col = columnOrder(early, PHONE);
    expect(col.indexOf('internal notes')).toBeGreaterThan(col.indexOf('details'));
  });
});
