// test/email-triage-buckets.test.js — the triage category ↔ folder contract.
//
// ai_category holds a triage-bucket SLUG, and the nine matching folders are
// seeded into every user's rail. Those two lists MUST stay identical: a
// category with no folder is a heading nothing can be filed under, and a
// folder no category ever names is a bucket that stays empty forever. E4
// files mail into these by slug, so a mismatch there moves real mail to the
// wrong place.
//
// email-triage derives its enum from email-folders rather than restating
// it. This pins that the derivation still produces the expected set — so
// renaming a slug in the spine fails HERE, loudly, instead of silently
// producing a category the folder tree cannot render.

const { TRIAGE_BUCKETS } = require('../server/services/email-folders');

// Intentionally hardcoded. The point of this list is to be a second,
// independent statement of the contract — if it and the spine ever
// disagree, one of them changed and a human should decide which.
const EXPECTED = [
  'clients',
  'subs-vendors',
  'bids-rfqs',
  'invoices-bills',
  'scheduling',
  'permits-inspections',
  'insurance-legal',
  'internal',
  'newsletters',
];

describe('TRIAGE_BUCKETS', () => {
  test('is exactly the nine seeded triage-bucket slugs, in spine order', () => {
    expect(TRIAGE_BUCKETS).toEqual(EXPECTED);
  });

  test('contains no duplicates', () => {
    expect(new Set(TRIAGE_BUCKETS).size).toBe(TRIAGE_BUCKETS.length);
  });

  // Three slugs deliberately differ from slugify(name) output —
  // 'subs-vendors' not 'subs-and-vendors'. The spine comment says do not
  // "fix" them; this makes an accidental fix fail.
  test('keeps the deliberately non-slugified forms', () => {
    expect(TRIAGE_BUCKETS).toContain('subs-vendors');
    expect(TRIAGE_BUCKETS).toContain('bids-rfqs');
    expect(TRIAGE_BUCKETS).toContain('invoices-bills');
    expect(TRIAGE_BUCKETS).not.toContain('subs-and-vendors');
  });

  test('every slug is URL/query safe — they ride the `folder:` search operator', () => {
    TRIAGE_BUCKETS.forEach(function (s) {
      expect(s).toMatch(/^[a-z0-9-]+$/);
    });
  });
});

// The validation email-triage applies to the model's answer. Reproduced
// here rather than imported because it is one expression inside
// classifyEmail — the behaviour is what matters: anything outside the set
// becomes null, so a hallucinated or injected category can never be stored.
describe('category validation', () => {
  const normalize = (v) => (TRIAGE_BUCKETS.includes(v) ? v : null);

  test('accepts a real bucket', () => {
    expect(normalize('invoices-bills')).toBe('invoices-bills');
  });

  test('rejects a display name instead of a slug', () => {
    expect(normalize('Invoices & Bills')).toBeNull();
  });

  test('rejects a hallucinated bucket', () => {
    expect(normalize('urgent')).toBeNull();
    expect(normalize('clients-vip')).toBeNull();
  });

  test('rejects the empty / missing / non-string cases', () => {
    expect(normalize('')).toBeNull();
    expect(normalize(undefined)).toBeNull();
    expect(normalize(null)).toBeNull();
    expect(normalize(42)).toBeNull();
    expect(normalize({ category: 'clients' })).toBeNull();
  });

  // Case matters: the folder lookup is by exact slug.
  test('rejects a differently-cased slug rather than coercing it', () => {
    expect(normalize('Clients')).toBeNull();
  });
});
