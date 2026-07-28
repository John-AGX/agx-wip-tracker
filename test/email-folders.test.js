// test/email-folders.test.js — coverage for the Premium Email Hub E1
// folder spine (server/services/email-folders.js). These are the pure
// helpers + the shape of the system-folder spec; the DB-touching
// functions are exercised by the live verification against Railway.
//
// Why the spec-integrity block matters: SYSTEM_FOLDERS drives the seed,
// and the seed is idempotent only because slugs are unique and every
// child's `parent` resolves to an earlier entry. A careless edit there
// (a duplicate slug, a child listed above its parent) would silently
// drop folders on every mailbox, which is exactly the kind of thing
// nobody notices until the rail is missing a bucket.

const ef = require('../server/services/email-folders');

describe('slugify', () => {
  test('lowercases and dashes a plain name', () => {
    expect(ef.slugify('Client Mail')).toBe('client-mail');
  });

  test('collapses punctuation runs into one dash', () => {
    expect(ef.slugify('Bids / RFQs')).toBe('bids-rfqs');
    expect(ef.slugify('Insurance / Legal')).toBe('insurance-legal');
  });

  test('spells out & so R&D and R D do not collide', () => {
    expect(ef.slugify('Subs & Vendors')).toBe('subs-and-vendors');
    expect(ef.slugify('R&D')).toBe('r-and-d');
  });

  test('strips leading and trailing dashes', () => {
    expect(ef.slugify('  !!Punch List!!  ')).toBe('punch-list');
  });

  test('caps length and never ends in a dash', () => {
    const s = ef.slugify('a b '.repeat(60));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('-')).toBe(false);
  });

  test('falls back to "folder" on empty / non-string input', () => {
    expect(ef.slugify('')).toBe('folder');
    expect(ef.slugify('   ')).toBe('folder');
    expect(ef.slugify(null)).toBe('folder');
    expect(ef.slugify(undefined)).toBe('folder');
    expect(ef.slugify('!!!')).toBe('folder');
  });
});

describe('sanitizeName', () => {
  // The whole reason email folders have their OWN name sanitizer instead
  // of reusing file-folders' sanitizeSegment: '/' and '&' must survive,
  // because the materialized path is built from slugs, not names.
  test('keeps slashes, ampersands and hyphens verbatim', () => {
    expect(ef.sanitizeName('Bids / RFQs')).toBe('Bids / RFQs');
    expect(ef.sanitizeName('Subs & Vendors')).toBe('Subs & Vendors');
    expect(ef.sanitizeName('Pre-Con Notes')).toBe('Pre-Con Notes');
  });

  test('turns control characters into spaces and collapses whitespace', () => {
    // Built from char codes rather than literals so this source file
    // carries no raw control bytes of its own.
    const TAB = String.fromCharCode(9), BEL = String.fromCharCode(7), LF = String.fromCharCode(10);
    expect(ef.sanitizeName('a' + TAB + 'b' + BEL + 'c')).toBe('a b c');
    expect(ef.sanitizeName('line' + LF + 'break')).toBe('line break');
    expect(ef.sanitizeName('  spaced    out  ')).toBe('spaced out');
  });

  test('caps at 80 characters', () => {
    expect(ef.sanitizeName('x'.repeat(200)).length).toBe(80);
  });

  test('never returns empty', () => {
    expect(ef.sanitizeName('')).toBe('Untitled');
    expect(ef.sanitizeName('   ')).toBe('Untitled');
    expect(ef.sanitizeName(null)).toBe('Untitled');
    expect(ef.sanitizeName(undefined)).toBe('Untitled');
  });
});

describe('normColor', () => {
  // The value lands in a style attribute, so anything that isn't a plain
  // hex triplet is rejected rather than stored.
  test('accepts 3- and 6-digit hex, normalized to lowercase', () => {
    expect(ef.normColor('#A1B2C3')).toBe('#a1b2c3');
    expect(ef.normColor('#abc')).toBe('#abc');
    expect(ef.normColor('  #FFF  ')).toBe('#fff');
  });

  test('rejects names, functions and injection attempts', () => {
    expect(ef.normColor('red')).toBeNull();
    expect(ef.normColor('rgb(1,2,3)')).toBeNull();
    expect(ef.normColor('#abc; background:url(x)')).toBeNull();
    expect(ef.normColor('javascript:alert(1)')).toBeNull();
    expect(ef.normColor('#12345')).toBeNull();
  });

  test('treats empty / null / non-string as "clear it"', () => {
    expect(ef.normColor('')).toBeNull();
    expect(ef.normColor(null)).toBeNull();
    expect(ef.normColor(undefined)).toBeNull();
    expect(ef.normColor(123)).toBeNull();
  });
});

describe('normIcon', () => {
  test('accepts an agx-icons.js style name slug', () => {
    expect(ef.normIcon('composer-send')).toBe('composer-send');
    expect(ef.normIcon('envelope')).toBe('envelope');
  });

  test('rejects anything with path or markup characters', () => {
    expect(ef.normIcon('../../etc/passwd')).toBeNull();
    expect(ef.normIcon('<svg onload=1>')).toBeNull();
    expect(ef.normIcon('icon name')).toBeNull();
  });

  test('treats empty / null as "clear it"', () => {
    expect(ef.normIcon('')).toBeNull();
    expect(ef.normIcon(null)).toBeNull();
  });
});

describe('SYSTEM_FOLDERS spec integrity', () => {
  const bySlug = {};
  ef.SYSTEM_FOLDERS.forEach((f) => { bySlug[f.slug] = f; });

  test('carries every folder the spec names', () => {
    // docs/email-hub-premium.md §1: the top-level spine…
    ['inbox', 'triaged', 'sent', 'drafts', 'scheduled', 'snoozed', 'archive', 'spam', 'trash']
      .forEach((slug) => {
        expect(bySlug[slug]).toBeDefined();
        expect(bySlug[slug].parent).toBeUndefined();
      });
    // …and the nine auto-children under Triaged.
    ['clients', 'subs-vendors', 'bids-rfqs', 'invoices-bills', 'scheduling',
     'permits-inspections', 'insurance-legal', 'internal', 'newsletters']
      .forEach((slug) => {
        expect(bySlug[slug]).toBeDefined();
        expect(bySlug[slug].parent).toBe('triaged');
      });
    expect(ef.SYSTEM_FOLDERS.length).toBe(18);
  });

  test('slugs are unique — the seed dedupes on (owner, slug)', () => {
    const slugs = ef.SYSTEM_FOLDERS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('display names are unique — uq_email_folders_name would reject a clash', () => {
    const names = ef.SYSTEM_FOLDERS.map((f) => f.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  test('every child is listed AFTER its parent so one seed pass resolves parent_id', () => {
    const seen = new Set();
    ef.SYSTEM_FOLDERS.forEach((f) => {
      if (f.parent) expect(seen.has(f.parent)).toBe(true);
      seen.add(f.slug);
    });
  });

  test('every entry has a name, a kind and a sort', () => {
    ef.SYSTEM_FOLDERS.forEach((f) => {
      expect(typeof f.name).toBe('string');
      expect(f.name.length).toBeGreaterThan(0);
      expect(ef.SYSTEM_KINDS).toContain(f.kind);
      expect(Number.isFinite(f.sort)).toBe(true);
    });
  });

  test("'custom' is not a system kind — a POSTed folder can never claim a spine role", () => {
    expect(ef.SYSTEM_KINDS).not.toContain('custom');
  });

  test('the nine Triaged children all share the triage_bucket kind', () => {
    const kids = ef.SYSTEM_FOLDERS.filter((f) => f.parent === 'triaged');
    expect(kids.length).toBe(9);
    kids.forEach((f) => expect(f.kind).toBe('triage_bucket'));
  });

  test('the two folders the backfill targets by slug exist and are top-level', () => {
    // services/email-folders.backfill() files direction='outbound' into
    // 'sent' and everything else into 'inbox' by slug lookup. If either
    // slug were renamed, every message would silently stay orphaned.
    expect(bySlug.inbox.kind).toBe('inbox');
    expect(bySlug.sent.kind).toBe('sent');
  });

  test('names sanitize to themselves — the seed stores what the spec says', () => {
    ef.SYSTEM_FOLDERS.forEach((f) => {
      expect(ef.sanitizeName(f.name)).toBe(f.name);
    });
  });

  test('slugs are already slug-shaped (stable ids, not slugify output)', () => {
    // Three deliberately differ from slugify(name) — 'subs-vendors' not
    // 'subs-and-vendors', etc. They are fixed constants; this only
    // asserts they are legal, addressable slugs.
    ef.SYSTEM_FOLDERS.forEach((f) => {
      expect(f.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ef.slugify(f.slug)).toBe(f.slug);
    });
  });

  test('icons are valid icon slugs', () => {
    ef.SYSTEM_FOLDERS.forEach((f) => {
      expect(ef.normIcon(f.icon)).toBe(f.icon);
    });
  });
});
