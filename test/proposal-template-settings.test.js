/**
 * The proposal template SETTING — the saved text the AGX Standard document
 * prints, and the two places it can be silently destroyed.
 *
 * 1. THE SEED'S MERGE DIRECTION. The layout prints fields that did not exist
 *    before it (licence line, payment schedule, signer, acceptance text,
 *    standard sections), so boot has to fill them into an existing row. It does
 *    that with `$1::jsonb || value` — stored value on the RIGHT, so it wins.
 *    Reversed, every edited paragraph in the document is replaced by the seed
 *    on the next deploy, and nothing would ever say so.
 *
 * 2. THE ADMIN EDITOR'S TEXT ROUND TRIP. The payment schedule is rows and the
 *    standard sections are title + items, but both are EDITED as plain text.
 *    A lossy round trip silently rewrites the terms of a signed document, so
 *    parse(format(x)) === x is pinned here on the real functions.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DB = fs.readFileSync(path.join(ROOT, 'server/db.js'), 'utf8');

// The seed object, lifted out of server/db.js and evaluated, so these assert
// what boot would actually write rather than what a comment claims.
function seedTemplate() {
  const i = DB.indexOf('const DEFAULT_PROPOSAL_TEMPLATE = {');
  expect(i).toBeGreaterThan(-1);
  const open = DB.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < DB.length; j++) {
    if (DB[j] === '{') depth++;
    else if (DB[j] === '}' && --depth === 0) {
      return new Function('return ' + DB.slice(open, j + 1) + ';')();
    }
  }
  throw new Error('DEFAULT_PROPOSAL_TEMPLATE: unbalanced braces');
}

describe('the seed carries every field the document prints', () => {
  const T = seedTemplate();

  test('the letterhead, including the licence numbers', () => {
    expect(T.company_name).toBeTruthy();
    expect(T.company_header).toMatch(/Clearwater/);
    expect(T.contact_line).toMatch(/813-725-5233/);
    expect(T.license_line).toMatch(/CCC1336582/);
    expect(T.license_line).toMatch(/CGC1538588/);
    // Licence is its own value, never the address again.
    expect(T.license_line).not.toBe(T.company_header);
  });

  test('terms, as rows the document can tabulate', () => {
    expect(Array.isArray(T.payment_schedule)).toBe(true);
    expect(T.payment_schedule[0]).toEqual({ term: '35%', detail: expect.stringMatching(/Deposit upon acceptance/) });
    expect(T.payment_schedule.some((r) => /Balance/i.test(r.term))).toBe(true);
    expect(T.payment_note).toMatch(/1\.5% per month/);
    expect(T.pricing_note).toMatch(/plus an additional 10%/);
  });

  test('the acceptance block has words and a named signer', () => {
    expect(T.acceptance_text).toMatch(/hereby accepted/);
    expect(T.signature_text).toMatch(/electronic signature/);
    expect(T.signer_name).toBeTruthy();
    expect(T.signer_title).toBeTruthy();
  });

  test('the standard closing sections, each with items', () => {
    expect(Array.isArray(T.standard_sections)).toBe(true);
    const titles = T.standard_sections.map((s) => s.title);
    expect(titles).toContain('Jobsite Management');
    expect(titles).toContain('Resident / Construction Schedule');
    T.standard_sections.forEach((s) => expect(String(s.body).trim().length).toBeGreaterThan(10));
  });

  test('the assumptions are the formalized list, not the old short one', () => {
    expect(T.exclusions.length).toBeGreaterThanOrEqual(12);
    const all = T.exclusions.join(' ');
    expect(all).toMatch(/field verified before work begins/);
    expect(all).toMatch(/landscaping obstructing/);
    expect(all).toMatch(/unfettered and uninterrupted access/);
    // ...and it does not say the same thing twice.
    expect(T.exclusions.filter((e) => /electrical power/i.test(e)).length).toBe(1);
  });
});

describe('boot fills missing fields and NEVER overwrites saved text', () => {
  test('the merge puts the STORED value on the right, where it wins', () => {
    const stmt = DB.slice(DB.indexOf("SET value = $1::jsonb || value"), DB.indexOf("WHERE key = 'proposal_template'", DB.indexOf("SET value = $1::jsonb || value")) + 40);
    expect(stmt).toMatch(/SET value = \$1::jsonb \|\| value/);
    // The reverse (`value || $1::jsonb`) is the destructive one: in jsonb the
    // RIGHT operand wins, so that form replaces every admin-edited paragraph.
    expect(DB).not.toMatch(/value \|\| \$1::jsonb/);
  });

  test('jsonb merge semantics are what that direction relies on', () => {
    // The behaviour being trusted, stated as the assertion: right wins per key,
    // absent keys are added. (Modelled here; the SQL form is asserted above.)
    const merge = (seed, stored) => Object.assign({}, seed, stored);
    const stored = { intro_template: 'MY OWN INTRO', exclusions: ['mine'] };
    const seed = { intro_template: 'seed intro', license_line: 'CCC1336582', exclusions: ['seed'] };
    expect(merge(seed, stored)).toEqual({
      intro_template: 'MY OWN INTRO',
      license_line: 'CCC1336582',
      exclusions: ['mine']
    });
  });

  test('the insert still refuses to clobber an existing row', () => {
    expect(DB).toMatch(/VALUES \('proposal_template', \$1::jsonb\)\s*\r?\n?\s*ON CONFLICT \(key\) DO NOTHING/);
  });
});

describe('the admin editor round-trips the structured fields', () => {
  // The two formatter/parser pairs, loaded from the shipped admin bundle.
  const T = (() => {
    const sandbox = {
      window: {}, document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
      console: { log() {}, warn() {}, error() {} },
      JSON, Math, Date, Object, Array, String, Number, parseInt, parseFloat, isNaN, setTimeout, Promise
    };
    sandbox.window.window = sandbox.window;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try {
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/admin.js'), 'utf8'), sandbox, { filename: 'js/admin.js' });
    } catch (e) { /* admin.js touches plenty of DOM at load; the helpers still attach */ }
    return sandbox.window.p86ProposalTemplateText;
  })();

  test('the helpers are exposed from the shipped file', () => {
    expect(T && typeof T.paymentScheduleFromText).toBe('function');
    expect(T && typeof T.standardSectionsFromText).toBe('function');
  });

  test('payment rows survive format -> parse unchanged', () => {
    const rows = [
      { term: '35%', detail: 'Deposit upon acceptance of proposal' },
      { term: 'Balance', detail: 'Progress billing as work is completed' }
    ];
    expect(T.paymentScheduleFromText(T.paymentScheduleToText(rows))).toEqual(rows);
  });

  test('a row with no term keeps its text instead of vanishing', () => {
    expect(T.paymentScheduleFromText('Net 30 from invoice')).toEqual([{ term: '', detail: 'Net 30 from invoice' }]);
  });

  test('a detail containing a pipe keeps everything after the FIRST one', () => {
    expect(T.paymentScheduleFromText('50% | on delivery | then balance'))
      .toEqual([{ term: '50%', detail: 'on delivery | then balance' }]);
  });

  test('blank lines are not rows', () => {
    expect(T.paymentScheduleFromText('\n\n35% | Deposit\n\n')).toEqual([{ term: '35%', detail: 'Deposit' }]);
  });

  test('standard sections survive format -> parse unchanged', () => {
    const secs = [
      { title: 'Jobsite Management', body: 'Temporary fencing.\nScaffold as required.' },
      { title: 'Resident / Construction Schedule', body: 'Advance notice to management.' }
    ];
    expect(T.standardSectionsFromText(T.standardSectionsToText(secs))).toEqual(secs);
  });

  test('a section with no items is still a section', () => {
    expect(T.standardSectionsFromText('Warranty')).toEqual([{ title: 'Warranty', body: '' }]);
  });

  test('an item before any title is dropped, not given an invented title', () => {
    expect(T.standardSectionsFromText('- orphan item\nWarranty\n- one year'))
      .toEqual([{ title: 'Warranty', body: 'one year' }]);
  });

  test('an empty editor means no sections, not one blank section', () => {
    expect(T.standardSectionsFromText('   \n  ')).toEqual([]);
    expect(T.paymentScheduleFromText('')).toEqual([]);
  });

  test('every new field the form edits is actually saved', () => {
    const ADMIN = fs.readFileSync(path.join(ROOT, 'js/admin.js'), 'utf8');
    const synced = ADMIN.slice(ADMIN.indexOf('function syncTopLevelDraftFromInputs'),
                               ADMIN.indexOf('syncBTMappingFromInputs();', ADMIN.indexOf('function syncTopLevelDraftFromInputs')));
    ['company_name', 'contact_line', 'license_line', 'acceptance_text', 'signer_name',
     'signer_title', 'pricing_note', 'payment_note'].forEach((k) => {
      // The input exists in the form AND the key is read back into the draft.
      expect(ADMIN).toMatch(new RegExp('id="tpl-' + k + '"'));
      expect(synced).toMatch(new RegExp("'" + k + "'"));
    });
    expect(synced).toMatch(/payment_schedule = paymentScheduleFromText/);
    expect(synced).toMatch(/standard_sections = standardSectionsFromText/);
  });
});
