/**
 * @jest-environment jsdom
 */
/* The card has two shapes. Down a sidebar it is a column; along a page head it
 * is a STRIP — one line, read left to right, so a 1,600px header is used
 * across instead of a 520px column with the rest of the row empty.
 *
 * The markup is identical in both; only a class and the CSS differ. That is
 * the point: every other caller (map popups, the inspector, the estimate
 * sidebar) keeps rendering exactly what it rendered before. */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete window.p86EntityCard;
  window.eval(fs.readFileSync(path.join(ROOT, 'js', 'entity-card.js'), 'utf8'));
});

const VM = {
  kind: 'job', status: { label: 'In Progress', color: '#34d399' },
  number: 'S2453', title: 'Oak Bridge Roof Leak WO', subtitle: 'Vanguard',
  ring: { pct: 40 },
  facts: [{ icon: 'calendar', text: 'Oct 2' }, { icon: 'map-pin', text: 'Tampa, FL' }],
  canAddTask: true
};

describe('the strip is the same card, shaped differently', () => {
  test('it carries the strip class; the sidebar card does not', () => {
    const strip = window.p86EntityCard.render(VM, { compact: true, strip: true });
    const column = window.p86EntityCard.render(VM, { compact: true });
    expect(strip).toMatch(/class="p86-ecard compact strip"/);
    expect(column).toMatch(/class="p86-ecard compact"/);
  });

  test('and the SAME content — nothing is dropped to make it fit', () => {
    const strip = window.p86EntityCard.render(VM, { compact: true, strip: true });
    const column = window.p86EntityCard.render(VM, { compact: true });
    const strippedOfClass = (h) => h.replace('p86-ecard compact strip', 'p86-ecard compact');
    expect(strippedOfClass(strip)).toBe(column);
  });

  test('the shape is CSS: name on top, detail underneath, follow-ups beside', () => {
    window.p86EntityCard.render(VM, { compact: true, strip: true });
    const css = Array.from(document.head.querySelectorAll('style')).map((s) => s.textContent).join('');
    // A GRID, not one flex row. A row puts the name beside the facts, which is
    // what made a job number compete with five chips for the eye.
    expect(css).toMatch(/\.p86-ecard\.strip \.p86-ecard-body\{[^}]*display:grid/);
    // The areas ARE the layout: the name has a line to itself, the facts run
    // under it, and the status ring and the follow-ups each span both lines.
    expect(css).toMatch(/grid-template-areas:'head name tasks' 'head facts tasks' 'head stats tasks'/);
    // The name is the headline - bigger and heavier than any chip beneath it.
    expect(css).toMatch(/\.p86-ecard\.strip \.p86-ecard-title\{font-size:15\.5px;font-weight:700/);
    // Follow-ups stay on the RIGHT, divided off vertically (a horizontal rule
    // would read as 'below') and stretched to the height of what they sit beside.
    expect(css).toMatch(/\.p86-ecard\.strip \.p86-ecard-tasks\{grid-area:tasks;\}/);
    expect(css).toMatch(/\.p86-ecard\.strip \.p86-ecard-tasks\{[^}]*border-left[^}]*align-self:stretch/);
  });

  // An address you can read but not tap is an address somebody retypes into
  // a phone. A fact carrying `map` renders through the SAME deep-link builder
  // the map pins and the chat use, so the app has one maps link, not three.
  test('a fact with a map target is a place you can drive to', () => {
    window.eval(fs.readFileSync(path.join(ROOT, 'js', 'maps-link.js'), 'utf8'));
    const html = window.p86EntityCard.render({
      kind: 'job', number: 'S2453', title: 'Oak Bridge',
      facts: [{ icon: 'map-pin', text: 'Tampa, FL',
        map: { address: '101 Mill Pond Rd, Tampa, FL', lat: 27.95, lng: -82.46 } }]
    }, { compact: true, strip: true });
    expect(html).toContain('https://www.google.com/maps/search/?api=1&amp;query=');
    // coords win over the address string when both are usable
    expect(html).toContain(encodeURIComponent('27.95,-82.46'));
    expect(html).toContain('>Tampa, FL<');
  });

  test('and a fact without one is still plain escaped text', () => {
    window.eval(fs.readFileSync(path.join(ROOT, 'js', 'maps-link.js'), 'utf8'));
    const html = window.p86EntityCard.render({
      kind: 'job', number: 'S2453', title: 'Oak Bridge',
      facts: [{ icon: 'briefcase', text: 'Renovation <b>' }]
    }, { compact: true, strip: true });
    expect(html).not.toContain('google.com/maps');
    expect(html).toContain('Renovation &lt;b&gt;');
  });

  test('it folds back into a card on a narrow screen', () => {
    // A strip that wraps onto four lines is just a card with a strip's spacing.
    window.p86EntityCard.render(VM, { compact: true, strip: true });
    const css = Array.from(document.head.querySelectorAll('style')).map((s) => s.textContent).join('');
    expect(css).toMatch(/@media \(max-width:820px\)\{[^]*\.p86-ecard\.strip \.p86-ecard-body\{display:block/);
    // The headline comes down a notch and is allowed to WRAP: on a phone a
    // nowrap job name is a job name cut off at the third word.
    expect(css).toMatch(/@media \(max-width:820px\)\{[^]*\.p86-ecard\.strip \.p86-ecard-title\{font-size:14\.5px;white-space:normal/);
  });
});

describe('the job head asks for the strip, the rail does not', () => {
  const UI = fs.readFileSync(path.join(ROOT, 'nodegraph', 'ui.js'), 'utf8');

  test('the shape is decided by WHERE the card is going', () => {
    expect(UI).toMatch(/buildCard\(_jobCardTasks\[jid\]\|\|null, !!_headSlotEarly\)/);
    expect(UI).toMatch(/\{compact:true, strip:!!asStrip\}/);
  });

  test('the slot is resolved once, before the card is built', () => {
    // Resolving it twice is how the card and its host end up disagreeing.
    expect(UI).toMatch(/var _headSlotEarly=document\.getElementById\('jh-job-card'\)/);
    expect(UI).toMatch(/var headSlot=_headSlotEarly;/);
  });
});
