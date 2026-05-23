// test/slugify.test.js — coverage for the shared slug helper that
// generates Anthropic-Skill `name:` values from arbitrary user text.
// Critical because invalid slugs make beta.skills.create reject the
// whole batch, and we discovered the empty-string fallback case the
// hard way during the section-overlay rip.

const { slugify } = require('../server/util/slugify');

describe('slugify', () => {
  test('passes through lowercase ascii unchanged within cap', () => {
    expect(slugify('foo-bar-baz')).toBe('foo-bar-baz');
  });

  test('lowercases mixed case', () => {
    expect(slugify('FooBarBaz')).toBe('foobarbaz');
  });

  test('replaces runs of non-ASCII with single dash + strips edges', () => {
    expect(slugify('  Foo & Bar / Baz!  ')).toBe('foo-bar-baz');
  });

  test('truncates at 64 chars', () => {
    const long = 'a'.repeat(120);
    expect(slugify(long).length).toBe(64);
  });

  test('falls back to "skill" on empty / whitespace input', () => {
    expect(slugify('')).toBe('skill');
    expect(slugify('   ')).toBe('skill');
    expect(slugify(null)).toBe('skill');
    expect(slugify(undefined)).toBe('skill');
  });

  test('returns "skill" when input strips to nothing', () => {
    // All-special-chars input → empty after replace → fallback.
    expect(slugify('!!!@@@###')).toBe('skill');
  });
});
