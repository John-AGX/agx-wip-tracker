/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE LEAD HEAD GETS WHAT THE JOB HEAD GOT, and the job strip stops wasting
 * the space it won.
 *
 * Three things are pinned here:
 *   1. ONE ⋯ menu implementation (js/head-menu.js) now serves both heads. A
 *      second copy is what drifts the first time either page changes.
 *   2. The lead's Delete is capability-gated. The server asks for LEADS_EDIT
 *      (lead-routes.js DELETE /:id) and the button is built in JS after auth's
 *      document-wide [data-cap] sweep, so nothing checked it — the same hole
 *      the job's three had.
 *   3. The job strip carries the facts that were nowhere on the head, and
 *      NONE of the money, which the metrics strip directly above it already
 *      shows seven ways.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ── 1. the shared menu ────────────────────────────────────────────────────
describe('one menu implementation, used by both heads', () => {
  let btn, panel, api;

  beforeEach(() => {
    document.body.innerHTML =
      '<button id="more"></button>' +
      '<div id="panel"><button id="pick">Delete</button></div>' +
      '<div id="elsewhere">page</div>';
    delete window.p86HeadMenu;
    window.eval(fs.readFileSync(path.join(ROOT, 'js', 'head-menu.js'), 'utf8'));
    btn = document.getElementById('more');
    panel = document.getElementById('panel');
    api = window.p86HeadMenu.wire(btn, panel);
  });

  test('the button opens and closes it, and says so', () => {
    expect(api.isOpen()).toBe(false);
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    btn.click();
    expect(api.isOpen()).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    btn.click();
    expect(api.isOpen()).toBe(false);
  });

  test('it drops from the BUTTON, so a page that moves its button says nothing', () => {
    btn.click();
    expect(panel.style.top).toBeTruthy();
    expect(panel.style.right).toBeTruthy();
  });

  test('picking something closes it', () => {
    btn.click();
    document.getElementById('pick').click();
    expect(api.isOpen()).toBe(false);
  });

  test('a click anywhere else closes it — even on a handler that stops propagation', () => {
    btn.click();
    const other = document.getElementById('elsewhere');
    other.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    other.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    expect(api.isOpen()).toBe(false);
  });

  test('Escape closes it', () => {
    btn.click();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(api.isOpen()).toBe(false);
  });

  test('wiring twice does not stack a second set of listeners', () => {
    // Both heads re-run their build on every open.
    const again = window.p86HeadMenu.wire(btn, panel);
    expect(again).toBe(api);
    btn.click();
    expect(api.isOpen()).toBe(true);   // one toggle per click, not two
  });

  test('both heads call it — neither carries its own copy', () => {
    const layout = fs.readFileSync(path.join(ROOT, 'js', 'workspace-layout.js'), 'utf8');
    const leads = fs.readFileSync(path.join(ROOT, 'js', 'leads.js'), 'utf8');
    expect(layout).toMatch(/window\.p86HeadMenu\.wire\(moreBtn, jobActions\)/);
    expect(leads).toMatch(/window\.p86HeadMenu\.wire\(btn, panel\)/);
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(index).toMatch(/js\/head-menu\.js\?v=\d+/);
  });
});

// ── 2. the lead's actions ─────────────────────────────────────────────────
describe('the lead head: actions behind the button, Delete gated', () => {
  const LEADS = fs.readFileSync(path.join(ROOT, 'js', 'leads.js'), 'utf8');
  const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const header = INDEX.slice(INDEX.indexOf('id="ld-header"'), INDEX.indexOf('id="ld-status-msg"'));

  test('Delete asks for LEADS_EDIT — the capability its own endpoint asks for', () => {
    expect(LEADS).toMatch(/hasCapability\('LEADS_EDIT'\);?\s*\r?\n\s*if \(delBtn\) delBtn\.style\.display = \(l && l\.id && canDeleteLead\)/);
    const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'lead-routes.js'), 'utf8');
    expect(route).toMatch(/router\.delete\('\/:id', requireAuth, requireCapability\('LEADS_EDIT'\)/);
  });

  test('the three live in the menu panel, with the button beside it', () => {
    expect(header).toMatch(/class="ld-head-actions p86-head-actions"/);
    expect(header).toMatch(/id="ld-head-more"/);
    // All three inside the panel, in the order the job's menu uses (destructive last).
    const panel = header.slice(header.indexOf('ld-head-actions'), header.indexOf('ld-head-more'));
    ['ld-delete-btn', 'ld-ticket-btn', 'ld-convert-btn'].forEach((id) => {
      expect(panel).toContain(id);
    });
  });

  test('the button is offered only when at least one action is', () => {
    // A ⋯ that opens an empty menu is worse than no ⋯.
    expect(LEADS).toMatch(/btn\.style\.display = any \? '' : 'none';/);
  });

  test('the lead card takes the strip shape in the head, the column in the sidebar', () => {
    const subnav = fs.readFileSync(path.join(ROOT, 'js', 'entity-subnav.js'), 'utf8');
    expect(subnav).toMatch(/\{ compact: true, strip: !!headSlot \}/);
  });

  test('its card spans the header rather than sitting in a 460px box', () => {
    const css = fs.readFileSync(path.join(ROOT, 'css', 'workspace-layout.css'), 'utf8');
    const rule = css.split('\n').find((l) => l.startsWith('.ld-head-card.has-card'));
    expect(rule).toMatch(/flex: 1 1 320px/);
    expect(rule).not.toMatch(/max-width/);
  });
});

// ── 3. what the job strip now says ────────────────────────────────────────
describe('the job strip fills the space with facts, not with money again', () => {
  const UI = fs.readFileSync(path.join(ROOT, 'nodegraph', 'ui.js'), 'utf8');
  const block = UI.slice(UI.indexOf('WHAT THE STRIP SAYS ABOUT THIS JOB'), UI.indexOf('function buildCard'));

  test('schedule, place, type, market, PM', () => {
    expect(block).toMatch(/icon:'calendar'/);
    expect(block).toMatch(/icon:'map-pin'/);
    expect(block).toMatch(/job\.jobType/);
    expect(block).toMatch(/job\.market/);
    expect(block).toMatch(/findUserById\(job\.owner_id\)/);
  });

  test('the dates read as one span, not two chips to reconcile', () => {
    expect(block).toMatch(/_sd\+' → '\+_ed/);
  });

  test("Buildertrend's word, only when it disagrees", () => {
    // Open is the one worth saying beside a P86 status pill; Closed and
    // Warranty are not news.
    expect(block).toMatch(/btStatus\|\|''\)\.trim\(\)\.toLowerCase\(\)==='open'/);
    expect(block).toMatch(/text:'BT Open'/);
  });

  test('and none of the money the metrics strip already carries', () => {
    expect(block).not.toMatch(/contractAmount|totalIncome|displayProfit|displayMargin|pctComplete/);
  });

  test('every fact is conditional, so a thin job stays a thin strip', () => {
    // Count the pushes and the guards: each push sits behind an if.
    const pushes = (block.match(/_facts\.push\(/g) || []).length;
    const guards = (block.match(/if\(/g) || []).length;
    expect(pushes).toBeGreaterThanOrEqual(6);
    expect(guards).toBeGreaterThanOrEqual(pushes);
    expect(block).not.toMatch(/'—'/);
  });
});
