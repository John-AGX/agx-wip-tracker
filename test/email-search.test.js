// test/email-search.test.js — the E3 search-operator parser
// (server/services/email-search.js).
//
// Two things must hold, and both are easy to break silently:
//   1. PARSING. A query like `from:tracy subject:"pressure wash" -spam`
//      has to split the same way every time. When an operator is
//      mistyped ("form:tracy") the parser must REPORT it rather than
//      quietly matching it as free text — a search that pretends to have
//      filtered is worse than one that refuses.
//   2. PARAMETERIZATION. Every user-supplied value must leave as a $n
//      placeholder. If a value ever reaches the SQL string, that is a
//      SQL-injection hole in a query that runs against the mail table.

const search = require('../server/services/email-search');

describe('tokenize', () => {
  test('splits on whitespace', () => {
    expect(search.tokenize('a b  c')).toEqual(['a', 'b', 'c']);
  });

  test('keeps quoted phrases whole', () => {
    expect(search.tokenize('subject:"pressure wash" tracy'))
      .toEqual(['subject:pressure wash', 'tracy']);
  });

  test('tolerates an unbalanced trailing quote', () => {
    expect(search.tokenize('subject:"unterminated here')).toEqual(['subject:unterminated here']);
  });

  test('returns nothing for empty / null input', () => {
    expect(search.tokenize('')).toEqual([]);
    expect(search.tokenize(null)).toEqual([]);
    expect(search.tokenize('    ')).toEqual([]);
  });
});

describe('durationMs', () => {
  const DAY = 24 * 60 * 60 * 1000;
  test('understands d / w / m / y', () => {
    expect(search.durationMs('7d')).toBe(7 * DAY);
    expect(search.durationMs('2w')).toBe(14 * DAY);
    expect(search.durationMs('3m')).toBe(90 * DAY);
    expect(search.durationMs('1y')).toBe(365 * DAY);
  });
  test('is case-insensitive and tolerates a space', () => {
    expect(search.durationMs('7D')).toBe(7 * DAY);
    expect(search.durationMs('7 d')).toBe(7 * DAY);
  });
  test('rejects nonsense rather than guessing', () => {
    ['', 'd', '7x', '-3d', '0d', 'abc', null].forEach((bad) => {
      expect(search.durationMs(bad)).toBeNull();
    });
  });
});

describe('parseQuery', () => {
  test('separates operators from free text', () => {
    const p = search.parseQuery('from:tracy has:attachment pressure wash');
    expect(p.ops.from).toEqual(['tracy']);
    expect(p.ops.has).toEqual(['attachment']);
    expect(p.terms).toEqual(['pressure', 'wash']);
  });

  test('collects a repeated operator instead of overwriting it', () => {
    const p = search.parseQuery('label:urgent label:money');
    expect(p.ops.label).toEqual(['urgent', 'money']);
  });

  test('handles negation of both terms and operators', () => {
    const p = search.parseQuery('-newsletter -from:noreply roof');
    expect(p.negTerms).toEqual(['newsletter']);
    expect(p.ops['from!']).toEqual(['noreply']);
    expect(p.terms).toEqual(['roof']);
  });

  test('reports operator-shaped tokens it does not know', () => {
    const p = search.parseQuery('form:tracy sndr:bob roof');
    expect(p.unknown).toContain('form');
    expect(p.unknown).toContain('sndr');
    // …and still searches them as text rather than dropping them.
    expect(p.terms).toEqual(['form:tracy', 'sndr:bob', 'roof']);
  });

  test('does not mistake a URL or a "Re:" prefix for an operator', () => {
    const p = search.parseQuery('https://ok.test/x re: roofing');
    expect(p.unknown).toEqual([]);
    expect(p.terms).toContain('https://ok.test/x');
  });

  test('ignores a valueless operator', () => {
    const p = search.parseQuery('from: roof');
    expect(p.ops.from).toBeUndefined();
    expect(p.terms).toEqual(['roof']);
  });

  test('is case-insensitive on operator names', () => {
    const p = search.parseQuery('FROM:tracy Is:Unread');
    expect(p.ops.from).toEqual(['tracy']);
    expect(p.ops.is).toEqual(['Unread']);
  });

  test('an empty query yields nothing to filter on', () => {
    const p = search.parseQuery('');
    expect(p.terms).toEqual([]);
    expect(p.ops).toEqual({});
  });
});

describe('buildWhere — parameterization', () => {
  // The security property: no user value may ever appear in the SQL text.
  test('every value leaves as a placeholder, never inlined', () => {
    // Quoted, so the whole injection string survives tokenizing as ONE
    // operator value — that is the case that would actually be dangerous
    // if it were interpolated.
    const evil = "x' OR 1=1 --";
    const built = search.compile(
      'from:"' + evil + '" subject:"' + evil + '" label:"' + evil + '"',
      { alias: 'e', startIndex: 2 }
    );
    expect(built.sql).not.toContain('OR 1=1');
    expect(built.sql).not.toContain(evil);
    // …and the value IS present in params, so it still actually searches.
    expect(built.params.some((p) => String(p).indexOf("OR 1=1") !== -1)).toBe(true);
  });

  test('an unquoted injection attempt is split into harmless terms, still parameterized', () => {
    const built = search.compile("from:x' OR 1=1 --", { alias: 'e', startIndex: 2 });
    expect(built.sql).not.toContain('OR 1=1');
    expect(built.sql).not.toContain("1=1");
    // "OR", "1=1" and "--" become free-text terms, each its own placeholder.
    expect(built.params.some((p) => String(p).indexOf('1=1') !== -1)).toBe(true);
  });

  test('placeholders start where the caller says and stay contiguous', () => {
    const built = search.compile('from:a subject:b', { alias: 'e', startIndex: 5 });
    // from: emits 3 placeholders, subject: 1 → $5..$8, next free is $9.
    expect(built.nextIndex).toBe(5 + built.params.length);
    const nums = (built.sql.match(/\$\d+/g) || []).map((s) => Number(s.slice(1)));
    expect(Math.min.apply(null, nums)).toBe(5);
    expect(Math.max.apply(null, nums)).toBe(4 + built.params.length);
  });

  test('an empty query compiles to no predicates at all', () => {
    const built = search.compile('', { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(0);
    expect(built.sql).toBe('');
    expect(built.params).toEqual([]);
  });

  test('boolean flags compile to literals with no placeholder', () => {
    const built = search.compile('is:unread is:starred has:attachment', { alias: 'e', startIndex: 2 });
    expect(built.params).toEqual([]);
    expect(built.sql).toContain('e.is_read = FALSE');
    expect(built.sql).toContain('e.is_starred = TRUE');
    expect(built.sql).toContain('e.has_attachments = TRUE');
  });

  test('an unrecognized is:/has: value adds no predicate rather than matching everything', () => {
    const built = search.compile('is:banana has:banana', { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(0);
  });

  test('label filters use EXISTS so a multi-label message stays one row', () => {
    const built = search.compile('label:urgent', { alias: 'e', startIndex: 2 });
    expect(built.sql).toContain('EXISTS');
    expect(built.sql).not.toMatch(/JOIN email_message_labels[^)]*$/);
  });

  test('a bad duration drops the filter instead of matching all mail', () => {
    const built = search.compile('older_than:banana', { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(0);
  });

  test('a valid duration produces a real date bound', () => {
    const built = search.compile('older_than:7d', { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(1);
    expect(built.params[0] instanceof Date).toBe(true);
    expect(built.params[0].getTime()).toBeLessThan(Date.now());
  });

  test('respects the caller-supplied table alias', () => {
    const built = search.compile('is:unread', { alias: 'zz', startIndex: 1 });
    expect(built.sql).toContain('zz.is_read');
  });

  test('free-text terms search subject, body and sender together', () => {
    const built = search.compile('roof', { alias: 'e', startIndex: 2 });
    expect(built.sql).toContain('e.subject');
    expect(built.sql).toContain('e.body_text');
    expect(built.sql).toContain('e.from_email');
    // One placeholder reused across the OR branches.
    expect(built.params.length).toBe(1);
  });

  test('multiple terms AND together', () => {
    const built = search.compile('roof gutter', { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(2);
    expect(built.sql).toContain(' AND ');
  });
});

// Negation on is:/has:. parseQuery has always bucketed `-is:replied` as
// 'is!', but buildWhere had no arm for it, so the term was parsed, DROPPED,
// and never warned about — `is` is a real operator, so it doesn't trip the
// unknown-operator path either. "-is:replied" quietly returned replied
// mail. This is the failure the smart folders depend on not happening.
describe('negated is: / has: operators', () => {
  test('-is:replied emits a NOT predicate, not nothing', () => {
    const built = search.compile('-is:replied', { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(1);
    expect(built.sql).toContain('NOT (');
    expect(built.sql).toContain('replied_at IS NOT NULL');
  });

  test('is:replied and -is:replied compile to opposite predicates', () => {
    const pos = search.compile('is:replied', { alias: 'e', startIndex: 2 });
    const neg = search.compile('-is:replied', { alias: 'e', startIndex: 2 });
    expect(neg.sql).toBe('NOT (' + pos.sql + ')');
  });

  test('-has:attachment emits a NOT predicate', () => {
    const built = search.compile('-has:attachment', { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(1);
    expect(built.sql).toBe('NOT (e.has_attachments = TRUE)');
  });

  test('-is:unread negates the unread predicate', () => {
    const built = search.compile('-is:unread', { alias: 'e', startIndex: 2 });
    expect(built.sql).toBe('NOT (e.is_read = FALSE)');
  });

  test('an unknown is: value still emits nothing rather than broken SQL', () => {
    const built = search.compile('-is:banana', { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(0);
  });

  // The composite the "Unanswered > 24h" smart folder is built from.
  test('the unanswered-thread query compiles all three predicates', () => {
    const built = search.compile('is:inbound -is:replied older_than:1d',
      { alias: 'e', startIndex: 2 });
    expect(built.count).toBe(3);
    expect(built.sql).toContain("e.direction = 'inbound'");
    expect(built.sql).toContain('NOT (');
    expect(built.sql).toContain('received_at');
  });
});
