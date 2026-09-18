// test/job-status-vocabulary.test.js — ONE job-status vocabulary, six lists.
//
// P86's job status is a free string in a JSONB blob: nothing validates it, so
// the "vocabulary" is whatever the lists that OFFER and READ it happen to
// contain. They are six separate literals in five files, and they have already
// drifted once — `Backlog` was a real, settable, filterable status that was
// missing from BOTH <select>s in index.html for three releases, so a Backlog
// job was reachable only through "All Active".
//
// This is the test that would have caught that. It is deliberately a
// source-reading test, because the lists it compares live in HTML, in a browser
// script with no module boundary, and in a Node service — there is no runtime
// where all six are loaded at once, and the load-order between js/schedule.js
// and js/entity-card.js rules out a shared constant.
//
// Per reference_vacuous_assertions: every extractor below asserts it found
// something before it compares anything, so a renamed anchor fails loudly
// instead of comparing two empty lists.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The vocabulary, in lifecycle order. Anything here must be offered everywhere
// a status can be SET and must be understood everywhere a status is MAPPED.
const VOCAB = ['New', 'Backlog', 'In Progress', 'On Hold', 'Warranty', 'Completed', 'Archived'];

function jsArrayAfter(src, anchor, where) {
  const i = src.indexOf(anchor);
  expect([where + ' anchor found', i >= 0]).toEqual([where + ' anchor found', true]);
  const open = src.indexOf('[', i);
  const close = src.indexOf(']', open);
  expect([where + ' array found', open > 0 && close > open]).toEqual([where + ' array found', true]);
  const out = src.slice(open + 1, close).split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  expect([where + ' is not empty', out.length > 0]).toEqual([where + ' is not empty', true]);
  return out;
}

function selectOptions(html, selectAnchor, where) {
  const i = html.indexOf(selectAnchor);
  expect([where + ' <select> found', i >= 0]).toEqual([where + ' <select> found', true]);
  const end = html.indexOf('</select>', i);
  expect([where + ' </select> found', end > i]).toEqual([where + ' </select> found', true]);
  const block = html.slice(i, end);
  const out = [];
  const re = /<option value="([^"]*)"/g;
  let m;
  while ((m = re.exec(block))) if (m[1]) out.push(m[1]);
  expect([where + ' has options', out.length > 0]).toEqual([where + ' has options', true]);
  return out;
}

describe('every list that OFFERS a job status offers the whole vocabulary', () => {
  test('index.html — the Jobs list filter', () => {
    // A status missing here is settable and unfilterable: its jobs are reachable
    // only through "All Active".
    expect(selectOptions(read('index.html'), 'id="statusFilter"', 'jobs filter')).toEqual(VOCAB);
  });

  test('index.html — the New Job modal (a WRITE path: js/jobs.js reads #jobStatus)', () => {
    expect(selectOptions(read('index.html'), 'id="jobStatus"', 'new job')).toEqual(VOCAB);
  });

  test('js/jobs.js — the Job Information edit card', () => {
    const got = jsArrayAfter(read('js/jobs.js'), "opts(['New', 'Backlog'", 'edit card');
    expect(got).toEqual(VOCAB);
  });

  test('js/jobs.js — the bulk "Set status" menu', () => {
    // This one is a SUBSET by design: it is the lifecycle set a bulk action
    // offers, unioned at runtime with whatever statuses jobs actually carry.
    // It must not offer a status the vocabulary does not have.
    const got = jsArrayAfter(read('js/jobs.js'), 'var std = [', 'bulk bar');
    expect(got.filter((s) => VOCAB.indexOf(s) === -1)).toEqual([]);
    expect(got).toContain('Warranty');
  });

  test('js/schedule.js — the Schedule status pill bar', () => {
    const sched = read('js/schedule.js');
    // Set equality, not order: the order of the pills is a UI choice (this bar
    // has read New / In Progress / Backlog since it shipped) and reshuffling it
    // would move every user's pills for no reason.
    expect(jsArrayAfter(sched, 'var STATUS_FILTERS = [', 'schedule pills').slice().sort())
      .toEqual(VOCAB.slice().sort());
    // Its default set must be a subset of the bar, or a pill defaults to a key
    // the bar never renders.
    const dflt = sched.slice(sched.indexOf('var DEFAULT_STATUS_SET = {'));
    const keys = (dflt.slice(0, dflt.indexOf('}')).match(/'([^']+)'\s*:/g) || [])
      .map((s) => s.replace(/^'|'\s*:$/g, ''));
    expect([keys.length > 0, keys.filter((k) => VOCAB.indexOf(k) === -1)]).toEqual([true, []]);
  });
});

describe('every list that MAPS a job status knows the whole vocabulary', () => {
  test('server/services/clickr/bt-match.js — a status outside p86JobState stops ALL comparison', () => {
    // Not a source grep for its own sake: this function is the gate. A P86 job
    // whose status it does not recognise has status comparison skipped
    // entirely, silently, so a Buildertrend Closed against it proposes nothing.
    const match = require('../server/services/clickr/bt-match');
    const unknown = VOCAB.filter((s) => match.p86JobState(s) == null);
    expect(unknown).toEqual([]);
    // And each one lands somewhere sensible, not all in one bucket.
    expect(VOCAB.map((s) => [s, match.p86JobState(s)])).toEqual([
      ['New', 'active'], ['Backlog', 'active'], ['In Progress', 'active'], ['On Hold', 'active'],
      ['Warranty', 'warranty'], ['Completed', 'completed'], ['Archived', 'archived'],
    ]);
  });

  test('js/jobs.js — every status has its own badge class, none silently falls through', () => {
    // Three byte-identical ternaries used to carry this, ~1,500 lines apart. A
    // status added to two of them rendered as .badge on-track — indistinguishable
    // from In Progress — on whichever surface was missed.
    const src = read('js/jobs.js');
    expect(src.indexOf('function jobStatusBadgeClass(')).toBeGreaterThan(-1);
    // The three old ternaries are gone: one writer, called three times.
    expect(src.match(/job\.status === 'On Hold' \? 'at-risk'/g)).toBe(null);
    expect((src.match(/jobStatusBadgeClass\(job\.status\)/g) || []).length).toBe(3);
    // Warranty is named in the helper, and in the stylesheet, in BOTH themes.
    expect(src).toMatch(/if \(s === 'Warranty'\) return 'warranty';/);
    const css = read('css/styles.css');
    expect(css).toMatch(/\.badge\.warranty\s*\{/);
    expect(css).toMatch(/body\.light-mode \.badge\.warranty/);
  });

  test('js/entity-card.js — jobStatusColor, the one colour four other surfaces read', () => {
    const src = read('js/entity-card.js');
    expect(src).toMatch(/if \(s === 'warranty'\) return '#[0-9a-fA-F]{6}';/);
  });

  test("server/routes/ai-routes.js — the model is told the vocabulary in words", () => {
    // These are free-text descriptions, not JSON-schema enums: the filters work
    // the day a job carries the status, but the model only ever sees this list.
    const src = read('server/routes/ai-routes.js');
    const lists = src.match(/New[^\n]{0,40}In Progress[^\n]{0,80}Archived/g) || [];
    expect(lists.length).toBeGreaterThanOrEqual(3);
    expect(lists.filter((l) => l.indexOf('Warranty') === -1)).toEqual([]);
  });
});

describe('the status literals that are NOT pickers, named so they are not forgotten', () => {
  test('js/job-costs-import.js mints QB stub jobs at a hardcoded In Progress', () => {
    // EXEMPT, on purpose: it is a minting default for a stub job the importer
    // creates, not a list a person chooses from. It must still be a status in
    // the vocabulary, or the stub is born outside it.
    const src = read('js/job-costs-import.js');
    const m = src.match(/status: '([^']+)',\r?\n\s+contractAmount: 0,/);
    expect([m && m[1], VOCAB.indexOf(m && m[1]) !== -1]).toEqual(['In Progress', true]);
  });

  test('server/services/clickr/sync-apply.js maps a Buildertrend status into the vocabulary', () => {
    const src = read('server/services/clickr/sync-apply.js');
    const m = src.match(/function p86JobStatus\(btStatus\)[\s\S]{0,400}?\n\}/);
    expect(m).not.toBe(null);
    const minted = (m[0].match(/return '([^']+)';/g) || []).map((s) => s.slice(8, -2));
    expect(minted.length).toBeGreaterThan(0);
    expect(minted.filter((s) => VOCAB.indexOf(s) === -1)).toEqual([]);
    expect(minted).toContain('Warranty');
  });
});
