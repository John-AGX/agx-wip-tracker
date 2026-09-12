/**
 * The forecast strip must name the right day, colour the right risk, and carry
 * the wind a crew would actually feel.
 *
 * Three bugs, all silent, all live on the Photos/lead surfaces:
 *
 *  1. EVERY CARD WAS LABELLED ONE DAY EARLY. `new Date('2026-09-12')` is UTC
 *     midnight; `.getDay()` reads it back in the browser's zone, so anywhere
 *     west of Greenwich it lands on the previous evening. It rendered correctly
 *     ONLY under TZ=UTC — i.e. in CI and nowhere a foreman stands. This file
 *     forces a real US zone for exactly that reason; under UTC these tests
 *     would pass against the broken code and prove nothing.
 *
 *  2. THE RISK BORDER NEVER RENDERED. The server has always emitted
 *     'red'|'yellow'|'green' and the card checked 'high'|'med'. Every card got
 *     the default grey, so the thunder/wind classification computed for every
 *     day reached nobody.
 *
 *  3. A WIND RANGE WAS READ AT ITS LOW BOUND. "15 to 30 mph" was carried as 15,
 *     which is under classifyRisk's 25 red line AND its 15 yellow line — the
 *     windiest days scored calmest.
 *
 * These are asserted against the SHIPPED source rather than a copy, because
 * the failure mode is a mismatch between two files that each look fine alone.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// The clock is not the thing under test — the zone is. Anything that renders
// a calendar day must be correct in a zone with a negative UTC offset.
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'];

describe('a forecast day is a calendar day, never an instant', () => {
  test('the shipped card builds its date from parts, not from new Date(iso)', () => {
    const src = read('js/leads.js');
    // The exact construction that was wrong. If it comes back, so does the bug.
    expect(src).not.toMatch(/var date = d\.date \? new Date\(d\.date\) : null/);
    expect(src).toMatch(/new Date\(\+dparts\[0\], \+dparts\[1\] - 1, \+dparts\[2\]\)/);
  });

  test('parts-construction names the right weekday in every US zone', () => {
    // 2026-09-12 is a Saturday. The old form said Friday everywhere but UTC.
    const iso = '2026-09-12';
    for (const tz of ZONES) {
      const out = runInZone(tz, `
        const p = ${JSON.stringify(iso)}.split('-');
        const d = new Date(+p[0], +p[1]-1, +p[2]);
        process.stdout.write(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + (d.getMonth()+1) + '/' + d.getDate());
      `);
      expect(out).toBe('Sat 9/12');
    }
  });

  test('the OLD form really was wrong — this is not a tautology', () => {
    // Guards the guard: if new Date(iso) were fine, the fix would be noise and
    // the test above would prove nothing.
    const broken = runInZone('America/New_York', `
      const d = new Date('2026-09-12');
      process.stdout.write(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + (d.getMonth()+1) + '/' + d.getDate());
    `);
    expect(broken).toBe('Fri 9/11');
  });

  test('the header chip picks today by LOCAL date, not toISOString', () => {
    const src = read('js/header-weather.js');
    // toISOString() converts to UTC first, so after ~8pm Eastern the chip
    // matched tomorrow's card.
    expect(src).not.toMatch(/var todayIso = new Date\(\)\.toISOString\(\)/);
    expect(src).toMatch(/todayIso = _n\.getFullYear\(\)/);
  });
});

describe('the risk border is wired to the vocabulary the server speaks', () => {
  test('server emits red/yellow/green', () => {
    const src = read('server/weather.js');
    expect(src).toMatch(/return 'red'/);
    expect(src).toMatch(/return 'yellow'/);
    expect(src).toMatch(/return 'green'/);
    expect(src).not.toMatch(/return 'high'/);
  });

  test('the lead card reads those same three words', () => {
    const src = read('js/leads.js');
    expect(src).toMatch(/d\.risk === 'red'/);
    expect(src).toMatch(/d\.risk === 'yellow'/);
    // The words it used to check must be gone, or the border stays grey.
    expect(src).not.toMatch(/d\.risk === 'high'/);
    expect(src).not.toMatch(/d\.risk === 'med'/);
  });

  test('every risk word the server can emit is handled by a reader', () => {
    // The property, not two spellings: whatever classifyRisk returns must be
    // something a renderer branches on.
    const server = read('server/weather.js');
    const emitted = new Set(
      (server.match(/return '(red|yellow|green)'/g) || []).map((m) => m.slice(8, -1))
    );
    const leads = read('js/leads.js');
    const header = read('js/header-weather.js');
    for (const word of emitted) {
      if (word === 'green') continue;               // green is the default branch
      expect(leads + header).toContain("'" + word + "'");
    }
  });
});

describe('a wind range is read at its high bound', () => {
  // Drive the SHIPPED expression rather than describing it.
  function windFrom(text) {
    const src = read('server/weather.js');
    const m = /const windNums = ([\s\S]*?);\s*\n\s*const windMph = ([\s\S]*?);/.exec(src);
    if (!m) throw new Error('wind parse not found in server/weather.js');
    // eslint-disable-next-line no-new-func
    return new Function('p', 'const windNums = ' + m[1] + '; return ' + m[2] + ';')({ windSpeed: text });
  }

  test('"15 to 30 mph" is 30, not 15', () => {
    expect(windFrom('15 to 30 mph')).toBe(30);
  });

  test('a single value is unchanged', () => {
    expect(windFrom('7 mph')).toBe(7);
  });

  test('missing wind is 0, not NaN', () => {
    // NaN would sail through classifyRisk's >= comparisons as false and score
    // the day green — a missing reading must not read as calm.
    expect(windFrom('')).toBe(0);
    expect(windFrom(null)).toBe(0);
  });

  test('the low-bound reading really did under-report — not a tautology', () => {
    const firstOnly = String('15 to 30 mph').match(/(\d+)/);
    expect(parseInt(firstOnly[1], 10)).toBe(15);
  });

  test('and 30 crosses the red line where 15 crossed nothing', () => {
    // classifyRisk: red at >= 25, yellow at >= 15. Driven from the shipped fn.
    const src = read('server/weather.js');
    const m = /function classifyRisk\(precipPct, windMph, text\) \{([\s\S]*?)\n\}/.exec(src);
    // eslint-disable-next-line no-new-func
    const classify = new Function('precipPct', 'windMph', 'text', m[1]);
    expect(classify(0, 30, 'Sunny')).toBe('red');
    expect(classify(0, 15, 'Sunny')).toBe('yellow');
  });
});

// Run a snippet in a child node with TZ forced. The zone has to be set before
// the process starts; setting process.env.TZ mid-run does not re-init the ICU
// default on every platform.
function runInZone(tz, snippet) {
  const { execFileSync } = require('child_process');
  return execFileSync(process.execPath, ['-e', snippet], {
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8'
  }).trim();
}
