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

  test('the shape is CSS, and it lays the body out as a row', () => {
    window.p86EntityCard.render(VM, { compact: true, strip: true });
    const css = Array.from(document.head.querySelectorAll('style')).map((s) => s.textContent).join('');
    expect(css).toMatch(/\.p86-ecard\.strip \.p86-ecard-body\{[^}]*display:flex/);
    // the title block takes the slack, the follow-ups are divided off the side
    expect(css).toMatch(/\.p86-ecard\.strip \.p86-ecard-main\{[^}]*flex:1 1/);
    expect(css).toMatch(/\.p86-ecard\.strip \.p86-ecard-tasks\{[^}]*border-left/);
  });

  test('it folds back into a card on a narrow screen', () => {
    // A strip that wraps onto four lines is just a card with a strip's spacing.
    window.p86EntityCard.render(VM, { compact: true, strip: true });
    const css = Array.from(document.head.querySelectorAll('style')).map((s) => s.textContent).join('');
    expect(css).toMatch(/@media \(max-width:820px\)\{[^]*\.p86-ecard\.strip \.p86-ecard-body\{display:block/);
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
