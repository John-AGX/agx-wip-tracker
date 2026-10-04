/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE LEAD'S CARD, IN THE LEAD'S HEADER.
 *
 * Same move the job page made: the card carries the title and the status pill
 * — which is exactly why #ld-title and #ld-status-pill are display:none in the
 * markup — so the page header should be showing it, not standing empty with
 * three buttons at the far end.
 *
 * The rule the mount has to keep: a page that offers a head slot gets the card
 * there, and anything that does NOT (the estimate editor, the New Lead modal
 * where the lead has no id yet) keeps the sidebar mount it has always had.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUBNAV = fs.readFileSync(path.join(ROOT, 'js', 'entity-subnav.js'), 'utf8');

const VM = { kind: 'lead', title: 'East Lake — Roof, Gutter and Stair Repairs', status: { label: 'Open' } };

function load(withLeadSlot) {
  document.body.innerHTML =
    '<div id="app-sidebar"><div class="app-nav"></div></div>' +
    '<div id="lead-detail-view">' +
      '<div id="ld-header">' +
        '<button>Back</button>' +
        (withLeadSlot ? '<div id="lead-head-card" class="ld-head-card"></div>' : '') +
        '<button id="ld-delete-btn">Delete</button>' +
      '</div>' +
    '</div>';
  delete window.p86EntitySubnav;
  window.p86EntityCard = {
    render: function (vm, opts) {
      return '<div class="p86-ecard' + (opts && opts.compact ? ' compact' : '') + '">' +
        (vm.title || '') + '<button data-act="addtask">Add follow-up</button></div>';
    }
  };
  window.eval(SUBNAV);
  return window.p86EntitySubnav;
}

const slot = () => document.getElementById('lead-head-card');
const wrap = () => document.getElementById('app-leadnav');

describe('a page with a head slot gets the card in its header', () => {
  test('the card lands in the slot, not above the sidebar nav', () => {
    const S = load(true);
    S.mount('lead', VM);
    expect(wrap()).toBeTruthy();
    expect(wrap().parentElement).toBe(slot());
    expect(document.querySelector('#app-sidebar #app-leadnav')).toBeNull();
    expect(slot().textContent).toMatch(/East Lake/);
  });

  test('the slot only claims width while it holds a card', () => {
    // Otherwise the New Lead form — which never mounts one — would carry a
    // flexible gap in its header for a card that is not coming.
    const S = load(true);
    expect(slot().classList.contains('has-card')).toBe(false);
    S.mount('lead', VM);
    expect(slot().classList.contains('has-card')).toBe(true);
    S.unmount('lead');
    expect(slot().classList.contains('has-card')).toBe(false);
  });

  test('a repaint replaces the card instead of stacking a second one', () => {
    // The card repaints every time follow-ups land.
    const S = load(true);
    S.mount('lead', VM);
    S.mount('lead', VM);
    expect(slot().querySelectorAll('.p86-ecard')).toHaveLength(1);
  });

  test('the card keeps its own controls', () => {
    const S = load(true);
    const acts = [];
    S.mount('lead', VM, function (act) { acts.push(act); });
    slot().querySelector('[data-act="addtask"]').click();
    expect(acts).toEqual(['addtask']);
  });

  test('unmounting removes the card but leaves the page\'s own slot alone', () => {
    const S = load(true);
    S.mount('lead', VM);
    S.unmount('lead');
    expect(wrap()).toBeNull();
    expect(slot()).toBeTruthy();          // it is the page's markup, not ours
  });
});

describe('everything without a slot is untouched', () => {
  test('no slot: the card still mounts above the sidebar nav', () => {
    const S = load(false);
    S.mount('lead', VM);
    expect(wrap()).toBeTruthy();
    expect(wrap().parentElement).toBe(document.querySelector('#app-sidebar'));
    expect(wrap().nextElementSibling.className).toBe('app-nav');
  });

  test('the estimate card has no head slot and keeps the sidebar', () => {
    const S = load(true);                 // lead slot present, estimate slot absent
    S.mount('estimate', { kind: 'estimate', title: 'EST-1042' });
    const est = document.getElementById('app-estimatenav');
    expect(est).toBeTruthy();
    expect(est.parentElement).toBe(document.querySelector('#app-sidebar'));
    expect(slot().children).toHaveLength(0);
  });

  test('one context card at a time, wherever it sits', () => {
    const S = load(true);
    S.mount('estimate', { kind: 'estimate', title: 'EST-1042' });
    S.mount('lead', VM);
    expect(document.getElementById('app-estimatenav')).toBeNull();
    expect(wrap().parentElement).toBe(slot());
  });
});

describe('the page it was built for', () => {
  test('the lead header carries the slot, beside the back button', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const header = index.slice(index.indexOf('id="ld-header"'), index.indexOf('id="ld-status-msg"'));
    expect(header).toMatch(/id="lead-head-card"/);
    // The title and pill stay hidden: the card is what says them now.
    expect(header).toMatch(/id="ld-title" style="display:none;"/);
    expect(header).toMatch(/id="ld-status-pill" style="display:none;"/);
  });
});

describe('the slot is wide enough to actually show the card', () => {
  test('it carries a real flex basis, not auto beside a flexible spacer', () => {
    // Measured on the live page: with `flex: 1 1 auto` the card mounted into
    // the slot correctly and rendered 254px tall and 0px WIDE — #ld-header's
    // row ends with <span style="flex:1;min-width:0"> and that spacer took the
    // free space first, leaving a zero-basis item nothing to grow from.
    const css = fs.readFileSync(path.join(ROOT, 'css', 'workspace-layout.css'), 'utf8');
    const rule = css.split('\n').find((l) => l.includes('.ld-head-card.has-card') && l.includes('flex:'));
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/flex:\s*1\s+1\s+\d+px/);
    expect(rule).toMatch(/min-width:\s*\d+px/);
  });

  test('the header row it sits in really does end with that spacer', () => {
    // If the spacer ever goes, the basis above is harmless; if it stays, the
    // basis is the only thing keeping the card on screen.
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const header = index.slice(index.indexOf('id="ld-header"'), index.indexOf('id="ld-status-msg"'));
    expect(header).toMatch(/<span style="flex:1;min-width:0;"><\/span>/);
  });
});
