// test/email-rules-match.test.js — the E4 rule matcher.
//
// This decides whether someone's mail gets moved, labelled, or hidden from
// their Inbox automatically. The failure modes are quiet: a rule that
// matches too much files a whole mailbox, and one that matches nothing
// looks identical to a rule that is simply waiting. Both are pinned here.

const m = require('../server/services/email-rules-match');

const rule = (over) => Object.assign({
  name: 'r', enabled: true, match_all: true,
  conditions: [], actions: [{ type: 'star' }],
}, over || {});

const MSG = {
  from_email: 'tracy@acme.com',
  orig_from_email: null,
  from_name: 'Tracy Webb',
  to_email: 'john-46bbee@project86.net',
  subject: 'Invoice 4021 — due Friday',
  body_text: 'Please remit $4,021 by Friday.',
  has_attachments: true,
  entity_type: 'client',
  direction: 'inbound',
  ai_category: null,
  triage_urgency: null,
  needs_reply: null,
};

describe('matchesRule — the guards against matching everything', () => {
  test('a rule with NO conditions never matches', () => {
    // An empty rule that fired on everything would file an entire mailbox
    // the moment it was saved.
    expect(m.matchesRule(rule({ conditions: [] }), MSG)).toBe(false);
  });

  test('an empty match value matches nothing, not everything', () => {
    expect(m.matchesRule(rule({
      conditions: [{ field: 'subject', op: 'contains', value: '' }],
    }), MSG)).toBe(false);
  });

  test('a disabled rule never matches', () => {
    expect(m.matchesRule(rule({
      enabled: false,
      conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
    }), MSG)).toBe(false);
  });
});

describe('matchesRule — operators', () => {
  const c = (field, op, value) => rule({ conditions: [{ field, op, value }] });

  test('contains is case-insensitive', () => {
    expect(m.matchesRule(c('subject', 'contains', 'INVOICE'), MSG)).toBe(true);
  });

  test('equals is exact, not substring', () => {
    expect(m.matchesRule(c('from', 'equals', 'tracy@acme.com'), MSG)).toBe(true);
    expect(m.matchesRule(c('from', 'equals', 'acme.com'), MSG)).toBe(false);
  });

  test('starts_with / ends_with', () => {
    expect(m.matchesRule(c('subject', 'starts_with', 'invoice'), MSG)).toBe(true);
    expect(m.matchesRule(c('subject', 'ends_with', 'friday'), MSG)).toBe(true);
    expect(m.matchesRule(c('subject', 'starts_with', 'due'), MSG)).toBe(false);
  });

  test('not_contains inverts', () => {
    expect(m.matchesRule(c('subject', 'not_contains', 'refund'), MSG)).toBe(true);
    expect(m.matchesRule(c('subject', 'not_contains', 'invoice'), MSG)).toBe(false);
  });

  // The reason `domain` exists as its own operator rather than telling
  // people to use contains.
  test('domain matches the real domain and REFUSES a lookalike', () => {
    expect(m.matchesRule(c('from', 'domain', 'acme.com'), MSG)).toBe(true);
    expect(m.matchesRule(c('from', 'domain', '@acme.com'), MSG)).toBe(true);
    expect(m.matchesRule(c('from', 'domain', 'acme.com'),
      { from_email: 'billing@evil-acme.com.attacker.net' })).toBe(false);
    expect(m.matchesRule(c('from', 'domain', 'acme.com'),
      { from_email: 'billing@notacme.com' })).toBe(false);
  });

  test('from also matches the ORIGINAL sender of a forwarded message', () => {
    // Mail John forwards in himself shows him as from_email; a client rule
    // must still fire on who actually sent it.
    expect(m.matchesRule(c('from', 'domain', 'client.com'), {
      from_email: 'john@agxco.com', orig_from_email: 'pm@client.com',
    })).toBe(true);
  });

  test('boolean fields only answer to `is`', () => {
    expect(m.matchesRule(c('has_attachment', 'is', true), MSG)).toBe(true);
    expect(m.matchesRule(c('has_attachment', 'is', 'true'), MSG)).toBe(true);
    expect(m.matchesRule(c('has_attachment', 'is', false), MSG)).toBe(false);
    expect(m.matchesRule(c('has_attachment', 'contains', 'true'), MSG)).toBe(false);
  });
});

describe('matchesRule — AND vs OR', () => {
  const two = [
    { field: 'from', op: 'domain', value: 'acme.com' },
    { field: 'subject', op: 'contains', value: 'refund' },
  ];

  test('match_all requires every condition', () => {
    expect(m.matchesRule(rule({ match_all: true, conditions: two }), MSG)).toBe(false);
  });

  test('match_all=false needs only one', () => {
    expect(m.matchesRule(rule({ match_all: false, conditions: two }), MSG)).toBe(true);
  });
});

// The phase split is the core design decision — these fields do not exist
// yet when mail lands, so a rule testing them at 'inbound' would never
// match and would look like a bug in the engine.
describe('matchesRule — post-triage fields are absent at inbound', () => {
  test('category does not match while ai_category is still NULL', () => {
    expect(m.matchesRule(rule({
      conditions: [{ field: 'category', op: 'equals', value: 'invoices-bills' }],
    }), MSG)).toBe(false);
  });

  test('the same rule matches once triage has filled it', () => {
    expect(m.matchesRule(rule({
      conditions: [{ field: 'category', op: 'equals', value: 'invoices-bills' }],
    }), Object.assign({}, MSG, { ai_category: 'invoices-bills' }))).toBe(true);
  });

  test('needs_reply=false is a real answer, not a missing one', () => {
    expect(m.matchesRule(rule({
      conditions: [{ field: 'needs_reply', op: 'is', value: false }],
    }), Object.assign({}, MSG, { needs_reply: false }))).toBe(true);
  });

  test('an unknown field never matches', () => {
    expect(m.matchesRule(rule({
      conditions: [{ field: 'wingspan', op: 'equals', value: 'wide' }],
    }), MSG)).toBe(false);
  });
});

describe('validateRule', () => {
  const ok = {
    name: 'Acme invoices',
    run_phase: 'inbound',
    conditions: [{ field: 'from', op: 'domain', value: 'acme.com' }],
    actions: [{ type: 'move', folder: 'invoices-bills' }],
  };

  test('accepts a well-formed rule', () => {
    expect(m.validateRule(ok)).toEqual([]);
  });

  // The check that earns its keep: this rule is syntactically fine and
  // would simply never fire.
  test('REFUSES a post-triage field on an inbound rule', () => {
    const errs = m.validateRule(Object.assign({}, ok, {
      conditions: [{ field: 'category', op: 'equals', value: 'clients' }],
    }));
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/only known after triage/);
  });

  test('accepts that same field once the phase is post_triage', () => {
    expect(m.validateRule(Object.assign({}, ok, {
      run_phase: 'post_triage',
      conditions: [{ field: 'category', op: 'equals', value: 'clients' }],
    }))).toEqual([]);
  });

  test('refuses forward / auto_reply while there is no send path', () => {
    ['forward', 'auto_reply'].forEach((t) => {
      const errs = m.validateRule(Object.assign({}, ok, { actions: [{ type: t }] }));
      expect(errs.length).toBe(1);
      expect(errs[0]).toMatch(/cannot send mail yet/);
    });
  });

  test('refuses an empty rule, a nameless rule, and a rule with no action', () => {
    expect(m.validateRule(Object.assign({}, ok, { conditions: [] }))[0]).toMatch(/at least one condition/);
    expect(m.validateRule(Object.assign({}, ok, { name: '  ' }))[0]).toMatch(/needs a name/);
    expect(m.validateRule(Object.assign({}, ok, { actions: [] }))[0]).toMatch(/at least one action/);
  });

  test('refuses a move with no folder and a label with no name', () => {
    expect(m.validateRule(Object.assign({}, ok, { actions: [{ type: 'move' }] }))[0]).toMatch(/move needs a folder/);
    expect(m.validateRule(Object.assign({}, ok, { actions: [{ type: 'label' }] }))[0]).toMatch(/label needs a label/);
  });

  test('refuses an unknown field, comparison, or action', () => {
    expect(m.validateRule(Object.assign({}, ok, {
      conditions: [{ field: 'wingspan', op: 'equals', value: 'x' }],
    }))[0]).toMatch(/not a field/);
    expect(m.validateRule(Object.assign({}, ok, {
      conditions: [{ field: 'from', op: 'sounds_like', value: 'x' }],
    }))[0]).toMatch(/not a comparison/);
    expect(m.validateRule(Object.assign({}, ok, {
      actions: [{ type: 'delete_forever' }],
    }))[0]).toMatch(/not an action/);
  });

  test('a value-less condition is refused, but a boolean field needs none', () => {
    expect(m.validateRule(Object.assign({}, ok, {
      conditions: [{ field: 'subject', op: 'contains', value: '' }],
    }))[0]).toMatch(/no value to match/);
    expect(m.validateRule(Object.assign({}, ok, {
      conditions: [{ field: 'has_attachment', op: 'is', value: true }],
    }))).toEqual([]);
  });
});
