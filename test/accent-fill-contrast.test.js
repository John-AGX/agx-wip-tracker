// Text on the filled buttons and pills of the work order reads at 4.5:1.
//
// The phone pass put white text on the accent fill and called it readable on
// both accents. In light mode it is; in dark mode — the crew link's default —
// white on #2f81f7 is 3.75:1, and in the office's phone block white on #4f8cff
// is 3.22:1. None of that text is "large" under WCAG (it runs 10px to 15px at
// weight 600), so AA wants 4.5:1, and these are the crew's main buttons, read
// outdoors: Navigate, Download the takeoff, the current step, Save report,
// Send revision, and the green Mark ... complete buttons beside them.
//
// Asked of the stylesheets: for each control, the colour and fill it gets in
// each theme (tokens resolved, cascade applied at a 390px phone, a 700px
// mouse window and the desktop), and the ratio between them. The rules the
// finding measured are checked the same way and must come out under 4.5:1.
'use strict';

const fs = require('fs');
const path = require('path');
const { rules, styleOf, contrast, resolveColor } = require('./helpers/css-rules');
const { computed, mediaMatches } = require('./helpers/css-cascade');

const ROOT = path.join(__dirname, '..');
const AA = 4.5;

function tokensOf(sheet, selector, env) {
  const out = {};
  for (const r of sheet) {
    if (!r.selectors.includes(selector)) continue;
    if (env && !mediaMatches(r.media, env)) continue;
    if (!env && r.media.length) continue;
    for (const d of r.decls) if (d.prop.startsWith('--')) out[d.prop] = d.value;
  }
  return out;
}

// The colour and fill one control gets, and their ratio.
function pairOf(sheet, selectors, env, tokens) {
  const color = computed(sheet, selectors, env, 'color');
  const fill = computed(sheet, selectors, env, 'background-color') || computed(sheet, selectors, env, 'background');
  if (!color || !fill) throw new Error('no colour or fill for ' + selectors.join(' | ') + ' at ' + JSON.stringify(env));
  const fg = resolveColor(color.value, tokens);
  const bg = resolveColor(fill.value, tokens);
  return { fg, bg, ratio: Math.round(contrast(fg, bg) * 100) / 100 };
}

// ── The office app (css/styles.css): body.light-mode swaps the tokens ─────
const OFFICE = rules(fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8'));
const OFFICE_DARK = tokensOf(OFFICE, ':root');
const OFFICE_LIGHT = Object.assign({}, OFFICE_DARK, tokensOf(OFFICE, 'body.light-mode'));
const withLight = (sels) => sels.concat(sels.map((s) => 'body.light-mode ' + s));

const OFFICE_CONTROLS = {
  'current step': withLight(['.p86-st-step', '.p86-st-step.at', '#job-service-tickets .p86-st-step', '#job-service-tickets .p86-st-step.at']),
  'selected filter pill': withLight(['.p86-st-pill', '.p86-st-pill.active', '#job-service-tickets .p86-st-pill', '#job-service-tickets .p86-st-pill.active']),
  'Navigate': withLight(['#job-service-tickets .p86-wo-nav']),
};
const OFFICE_ENVS = [
  { width: 390, pointer: 'coarse', label: '390px touch' },
  { width: 700, pointer: 'fine', label: '700px mouse window' },
];

describe('office work order: text on the accent fill', () => {
  test('the token maps are the ones the finding measured', () => {
    expect(resolveColor('var(--accent)', OFFICE_DARK)).toBe('#4f8cff');
    expect(resolveColor('var(--accent)', OFFICE_LIGHT)).toBe('#2563eb');
  });

  for (const env of OFFICE_ENVS) {
    for (const [name, sels] of Object.entries(OFFICE_CONTROLS)) {
      for (const [theme, tokens] of [['dark', OFFICE_DARK], ['light', OFFICE_LIGHT]]) {
        test(name + ' at ' + env.label + ', ' + theme + ': at least 4.5:1', () => {
          const p = pairOf(OFFICE, sels, env, tokens);
          expect(p.ratio).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  }

  test('the desktop step and pill keep the colours they had', () => {
    const desk = { width: 1280, pointer: 'fine' };
    expect(pairOf(OFFICE, OFFICE_CONTROLS['current step'], desk, OFFICE_DARK)).toEqual({ fg: '#101014', bg: '#4f8cff', ratio: 5.9 });
    expect(pairOf(OFFICE, OFFICE_CONTROLS['current step'], desk, OFFICE_LIGHT)).toEqual({ fg: '#ffffff', bg: '#2563eb', ratio: 5.17 });
  });

  test('FIRES: the shipped phone rules read 3.22:1 in dark mode', () => {
    const shipped = rules(`
      :root { --bg: #101014; --accent: #4f8cff; }
      .p86-st-step.at { background: var(--accent, #4f8cff); color: var(--bg, #0a0a14); border-color: var(--accent, #4f8cff); font-weight: 700; }
      @media (max-width: 760px) {
        #job-service-tickets .p86-st-step.at { color: #fff; }
        #job-service-tickets .p86-wo-nav { order: 2; background: var(--accent, #4f8cff); color: #fff; }
      }
    `);
    const tokens = tokensOf(shipped, ':root');
    const env = OFFICE_ENVS[0];
    expect(pairOf(shipped, ['.p86-st-step.at', '#job-service-tickets .p86-st-step.at'], env, tokens).ratio).toBe(3.22);
    expect(pairOf(shipped, ['#job-service-tickets .p86-wo-nav'], env, tokens).ratio).toBe(3.22);
  });
});

// ── The crew link (service-ticket-share.html): prefers-color-scheme ───────
const CREW = rules(styleOf(fs.readFileSync(path.join(ROOT, 'service-ticket-share.html'), 'utf8')));
const CREW_CONTROLS = {
  'current step': ['.step', '.step.at'],
  'Navigate / Download the takeoff': ['.btn', '.btn.primary'],
  'Mark Bldg complete': ['.btn', '.btn.go'],
  'Save report': ['#report button'],
  'Mark work complete': ['#report button', '#report button.big'],
  'Send revision': ['#propose'],
};

describe('crew link: text on the accent and green fills', () => {
  for (const scheme of ['dark', 'light']) {
    const env = { width: 390, pointer: 'coarse', scheme };
    const tokens = Object.assign({}, tokensOf(CREW, ':root'), scheme === 'light' ? tokensOf(CREW, ':root', env) : {});

    test(scheme + ': the fills are the ones the finding measured', () => {
      expect(resolveColor('var(--accent)', tokens)).toBe(scheme === 'dark' ? '#2f81f7' : '#0969da');
    });

    for (const [name, sels] of Object.entries(CREW_CONTROLS)) {
      test(name + ', ' + scheme + ': at least 4.5:1', () => {
        expect(pairOf(CREW, sels, env, tokens).ratio).toBeGreaterThanOrEqual(AA);
      });
    }
  }

  test('FIRES: white on the dark accent, as shipped, is 3.75:1', () => {
    const shipped = rules(`
      :root { --bg: #0e1116; --accent: #2f81f7; --green: #2ea043; }
      .btn { background: transparent; color: var(--text); }
      .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      .step.at { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
    `);
    const tokens = tokensOf(shipped, ':root');
    const env = { width: 390, pointer: 'coarse', scheme: 'dark' };
    expect(pairOf(shipped, ['.btn', '.btn.primary'], env, tokens).ratio).toBe(3.75);
    expect(pairOf(shipped, ['.step', '.step.at'], env, tokens).ratio).toBe(3.75);
  });
});
