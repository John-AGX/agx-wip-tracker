/**
 * @jest-environment jsdom
 */
/* WHAT THE HEAD STRIP SAYS, AND WHAT IT COSTS TO SAY IT.
 *
 * Three things moved at once here and they are all the same idea — the head is
 * a fixed width and every pixel spent on chrome is a pixel not spent on the
 * job:
 *
 *   1. the status pill and the % ring STACK instead of sitting side by side,
 *   2. a fact's icon finally draws something instead of an empty box,
 *   3. "← Back" becomes the arrow alone, on all three drill-ins.
 *
 * Plus the two facts Buildertrend now feeds (actual dates, owner balance) and
 * the address becoming the property's own rather than the city it is in.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('the head costs less chrome', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete window.p86EntityCard;
    delete window.p86Icon;
  });

  const VM = {
    kind: 'job', status: { label: 'In Progress', color: '#34d399' },
    title: 'RV2019 · Lakeside Village', subtitle: 'Vanguard', ring: { pct: 62 },
    facts: [{ icon: 'map-pin', text: '5020 Mill Pond Rd, Tampa, FL' }]
  };
  const load = () => window.eval(read('js', 'entity-card.js'));
  const css = () => Array.from(document.head.querySelectorAll('style')).map((s) => s.textContent).join('');

  test('the pill and the ring stack, so the head costs the pill alone', () => {
    load();
    window.p86EntityCard.render(VM, { compact: true, strip: true });
    // A ~120px pill beside a 34px ring costs the width of both and leaves the
    // ring's row half empty. Stacked, the head is as wide as the pill.
    expect(css()).toMatch(/\.p86-ecard\.strip \.p86-ecard-head\{[^}]*flex-direction:column/);
    expect(css()).toMatch(/\.p86-ecard\.strip \.p86-ecard-head\{[^}]*align-items:center/);
  });

  test('and only in the strip — the sidebar column keeps its own head', () => {
    load();
    window.p86EntityCard.render(VM, { compact: true });
    // The compact rule puts the ring top-RIGHT of a full-width title. If the
    // stack leaked out of .strip it would move the ring under the pill there.
    expect(css()).toMatch(/\.p86-ecard\.compact \.p86-ecard-head\{align-items:flex-start;\}/);
    expect(css()).not.toMatch(/\.p86-ecard\.compact \.p86-ecard-head\{[^}]*flex-direction:column/);
  });

  test('and they UNSTACK on the phone fold, where height is the scarce thing', () => {
    load();
    window.p86EntityCard.render(VM, { compact: true, strip: true });
    // Stacking buys width. Below 820px the body is a block and the head is a
    // full-width row with width to spare, so stacking there only spends 61px
    // of phone screen to say what 34 says.
    expect(css()).toMatch(/@media \(max-width:820px\)\{[^]*\.p86-ecard\.strip \.p86-ecard-head\{flex-direction:row/);
  });

  test('a stat tile sizes to its content on a strip, not to 1,100px of row', () => {
    load();
    window.p86EntityCard.render(VM, { compact: true, strip: true });
    // .p86-ecard-stat is flex:1 so two or three share a 520px sidebar column
    // evenly. On a strip one tile took the whole middle and the lead head
    // grew a long empty box with "AGE 31d" alone at the left end of it.
    expect(css()).toMatch(/\.p86-ecard\.strip \.p86-ecard-stat\{flex:0 0 auto/);
    expect(css()).toMatch(/\.p86-ecard-stat\{flex:1/); // the column keeps the old rule
  });

  // ── the icons that never drew ──────────────────────────────────────────
  test('a fact icon is a real SVG from the app’s own icon set', () => {
    window.p86Icon = (name) => '<svg data-icon="' + name + '"></svg>';
    load();
    const html = window.p86EntityCard.render(VM, { compact: true, strip: true });
    expect(html).toContain('<svg data-icon="map-pin"></svg>');
    // The Tabler class it used to emit is gone: no Tabler font is loaded in
    // this app, so every one of those was an empty box plus a 5px gap.
    expect(html).not.toContain('class="ti ti-');
  });

  test('an icon the set does not hold draws NOTHING, and warns nobody', () => {
    const asked = [];
    window.p86Icon = (name) => { asked.push(name); return '<svg></svg>'; };
    load();
    // 'sparkleburst' is not in the map; p86Icon must not even be consulted,
    // because it console.warns on a name it does not hold and a card with
    // eight facts would warn eight times on every paint.
    const html = window.p86EntityCard.render(
      { kind: 'job', title: 'X', facts: [{ icon: 'sparkleburst', text: 'Something' }] },
      { compact: true, strip: true });
    expect(asked).toEqual([]);
    expect(html).toContain('Something');
    expect(html).not.toContain('<svg');
  });

  test('and with no icon set loaded at all the card still renders its facts', () => {
    load();
    const html = window.p86EntityCard.render(VM, { compact: true, strip: true });
    expect(html).toContain('5020 Mill Pond Rd, Tampa, FL');
  });
});

// ── what the job strip now says ────────────────────────────────────────────
describe('the job strip: the address you drive to, the dates that happened, the money owed', () => {
  const UI = read('nodegraph', 'ui.js');
  const block = UI.slice(UI.indexOf('WHAT THE STRIP SAYS ABOUT THIS JOB'), UI.indexOf('function buildCard'));

  test('the place is the PROPERTY’s address, not the city it is in', () => {
    // "Tampa, FL" is true of a hundred jobs and no use to anyone in a truck.
    expect(block).toMatch(/_addrShort=\[job\.street_address,job\.city,job\.state\]/);
    expect(block).toMatch(/text:\(_addrShort\|\|_place\)/);
    // The zip is left off the LABEL and kept in the map TARGET: it never
    // disambiguates a line that already has a street, a city and a state.
    expect(block).toMatch(/address:\(_addr\|\|_place\)/);
    expect(block).toMatch(/_addr=\[job\.street_address,job\.city,job\.state,job\.zip\]/);
  });

  test('the actual dates read as actual, never as the plan', () => {
    expect(block).toMatch(/_as=_fmtDay\(job\.btActualStart\), _ac=_fmtDay\(job\.btActualCompletion\)/);
    // Each wording says which end it is, so neither can be mistaken for the
    // projected span sitting next to it.
    expect(block).toMatch(/'Actual '\+_as\+' → '\+_ac/);
    expect(block).toMatch(/'Completed '\+_ac/);
    expect(block).toMatch(/'Started '\+_as/);
    // And the plan is still its own fact.
    expect(block).toMatch(/icon:'calendar'/);
  });

  test('owner balance is the one money fact, exact, and never zero', () => {
    expect(block).toMatch(/_bal=Number\(job\.btOwnerBalance\)/);
    // Exact dollars and cents — a balance is read out loud on a phone call,
    // and "$12k" is not a number anyone can pay.
    expect(block).toMatch(/minimumFractionDigits:2,maximumFractionDigits:2/);
    // Zero is not news on a closed job, and most jobs are closed.
    expect(block).toMatch(/Math\.abs\(_bal\)>=0\.005/);
    // Still none of the seven figures the metrics strip above already carries.
    expect(block).not.toMatch(/contractAmount|totalIncome|displayProfit|displayMargin|pctComplete/);
  });

  test('every fact is still conditional, so a thin job stays a thin strip', () => {
    const pushes = (block.match(/_facts\.push\(/g) || []).length;
    const guards = (block.match(/if\(/g) || []).length;
    expect(pushes).toBeGreaterThanOrEqual(9);
    expect(guards).toBeGreaterThanOrEqual(pushes - 2); // the two else-ifs on the actual span
    expect(block).not.toMatch(/'—'/);
  });
});

describe('the lead strip gets the same address', () => {
  const LEADS = read('js', 'leads.js');
  const card = LEADS.slice(LEADS.indexOf('function mountLeadCard'), LEADS.indexOf('function onAct'));

  test('street first, city only as the fallback', () => {
    expect(card).toMatch(/var addr = \[l\.street_address, l\.city, l\.state\]/);
    expect(card).toMatch(/text: \(addr \|\| place\)/);
  });
});

// ── the back control ───────────────────────────────────────────────────────
describe('one back control, three drill-ins, and it is just the arrow', () => {
  const INDEX = read('index.html');
  const CSS = read('css', 'workspace-layout.css');

  test('all three wear it, and none of them spends 90px saying "Back"', () => {
    const backs = INDEX.match(/class="p86-head-back"|class="p86-head-back /g) || [];
    expect(backs.length).toBe(3);
    // The word is gone from the button and lives in the tooltip and the label,
    // so a screen reader still hears where it goes.
    expect(INDEX).not.toMatch(/&larr; Back/);
    expect(INDEX).toMatch(/aria-label="Back to jobs list"/);
    expect(INDEX).toMatch(/aria-label="Back to leads list"/);
    expect(INDEX).toMatch(/aria-label="Back to estimates list"/);
  });

  test('it is a 28px square, which is what the card gets back', () => {
    const rule = CSS.slice(CSS.indexOf('.p86-head-back {'), CSS.indexOf('.p86-head-back:hover'));
    expect(rule).toMatch(/width: 28px/);
    expect(rule).toMatch(/flex: 0 0 auto/);
  });

  test('it is still THERE — an installed PWA has no browser back button', () => {
    // Removing it was the other option and it would have stranded the phone.
    expect(INDEX).toMatch(/onclick="closeLeadDetail\(\)"/);
    expect(INDEX).toMatch(/onclick="backToJobsMain\(\)"/);
    expect(INDEX).toMatch(/onclick="closeEstimateEditor\(\)"/);
  });

  test('and the class it replaced styles nothing any more', () => {
    // A rule with no element is the shape this repo keeps rediscovering.
    expect(INDEX).not.toContain('ee-header-back');
    expect(read('css', 'styles.css')).not.toMatch(/^\s*\.ee-header-back\s*\{/m);
  });
});
