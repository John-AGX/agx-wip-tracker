// Sender identity helpers — server/email-sender.js.
//
// WHAT IS BEING HELD
// Org mail now says who it is from: "AG Exteriors via Project 86"
// <notifications@...>. The org name in that header is TENANT-CONTROLLED free
// text — an org admin can rename the org to anything — so this file pins the
// sanitiser against the ways a display name gets abused:
//   - CR/LF            header injection (a second header, a Bcc)
//   - " \ < > @        breaking out of the quoted display name, or a name
//                      that reads as an address ("billing@chase.com")
//   - U+202E, U+200B   bidi overrides and zero-width characters: text that
//                      renders differently from what it is
//   - "Project 86 ..." a tenant wearing the platform's own name
// and pins the Reply-To validator and the org-predicated address lookups
// (a Reply-To is a users row re-read FRESH and predicated on the org being
// mailed — never the JWT's email, never a platform admin acting as a tenant).

const sender = require('../server/email-sender');

const ENV_FROM = 'Project 86 <notifications@project86.net>';

describe('PLATFORM_NAME', () => {
  test('defaults to Project 86', () => {
    expect(sender.PLATFORM_NAME).toBe('Project 86');
  });
});

describe('parseFromEnv', () => {
  test('"Name <addr>"', () => {
    expect(sender.parseFromEnv(ENV_FROM)).toEqual({ name: 'Project 86', address: 'notifications@project86.net' });
  });
  test('a quoted display name with a comma and an escaped quote', () => {
    expect(sender.parseFromEnv('"Project 86, \\"Inc\\"" <n@p86.net>'))
      .toEqual({ name: 'Project 86, "Inc"', address: 'n@p86.net' });
  });
  test('a bare address and an angle-only address', () => {
    expect(sender.parseFromEnv('n@p86.net')).toEqual({ name: null, address: 'n@p86.net' });
    expect(sender.parseFromEnv('<n@p86.net>')).toEqual({ name: null, address: 'n@p86.net' });
  });
  test('garbage, CR/LF and non-strings parse to nothing', () => {
    expect(sender.parseFromEnv('not an address')).toEqual({ name: null, address: null });
    expect(sender.parseFromEnv('A <n@p86.net>\r\nBcc: x@y.com')).toEqual({ name: null, address: null });
    expect(sender.parseFromEnv(undefined)).toEqual({ name: null, address: null });
    expect(sender.parseFromEnv('')).toEqual({ name: null, address: null });
  });
});

describe('cleanOrgName', () => {
  test('an ordinary company name survives, comma and period included', () => {
    expect(sender.cleanOrgName('AG Exteriors, LLC')).toBe('AG Exteriors, LLC');
    expect(sender.cleanOrgName("O'Brien & Sons, Inc.")).toBe("O'Brien & Sons, Inc.");
  });

  test('CR/LF and other controls never survive (header injection)', () => {
    const out = sender.cleanOrgName('AG Exteriors\r\nBcc: victim@example.com');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).not.toMatch(/@/);
    expect(sender.cleanOrgName('AG\tExteriors\u0000\u007f\u0085')).toBe('AG Exteriors');
  });

  test('quotes, backslashes, angle brackets and @ are removed', () => {
    const out = sender.cleanOrgName('"Evil" <ceo@bank.com> \\ x');
    expect(out).not.toMatch(/["\\<>@]/);
    expect(out).toBe('Evil ceo bank.com x');
  });

  test('bidi override and zero-width characters are stripped', () => {
    expect(sender.cleanOrgName('Acme\u202Efdp.exe')).toBe('Acmefdp.exe');
    expect(sender.cleanOrgName('Ac\u200Bme\u200D Roofing\uFEFF')).toBe('Acme Roofing');
    expect(sender.cleanOrgName('\u2066Acme\u2069')).toBe('Acme');
  });

  test('fullwidth lookalikes are folded (NFKC) before stripping', () => {
    expect(sender.cleanOrgName('ＡＧ＜Ｘ＞＠')).toBe('AG X');
  });

  test('a tenant calling itself Project 86 is refused, however spelled', () => {
    expect(sender.cleanOrgName('Project 86 Security')).toBeNull();
    expect(sender.cleanOrgName('project86')).toBeNull();
    expect(sender.cleanOrgName('PROJECT-86 billing')).toBeNull();
    expect(sender.cleanOrgName('Pro\u200Bject 86')).toBeNull();
    expect(sender.cleanOrgName('Ｐｒｏｊｅｃｔ ８６')).toBeNull();
  });

  test('empty, whitespace-only and letterless names are refused', () => {
    expect(sender.cleanOrgName('')).toBeNull();
    expect(sender.cleanOrgName('   ')).toBeNull();
    expect(sender.cleanOrgName(null)).toBeNull();
    expect(sender.cleanOrgName('12345')).toBeNull();
    expect(sender.cleanOrgName('"<>@\\')).toBeNull();
    expect(sender.cleanOrgName('\u202E\u200B')).toBeNull();
  });

  test('long unicode names are capped at 60 code points without splitting a pair', () => {
    const out = sender.cleanOrgName('Café Ñandú 🏠 '.repeat(20));
    expect(Array.from(out).length).toBeLessThanOrEqual(60);
    expect(out).toBe(out.trim());
    // No lone surrogate left behind by the cut.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });
});

describe('fromHeader', () => {
  test('a clean org name brands the display name and keeps the EMAIL_FROM address', () => {
    expect(sender.fromHeader(ENV_FROM, 'AG Exteriors'))
      .toBe('"AG Exteriors via Project 86" <notifications@project86.net>');
    expect(sender.fromHeader('notifications@project86.net', 'AG Exteriors, LLC'))
      .toBe('"AG Exteriors, LLC via Project 86" <notifications@project86.net>');
  });

  test('an injection attempt yields one header line with one address', () => {
    const h = sender.fromHeader(ENV_FROM, 'Acme"\r\nBcc: x@evil.com <attacker@evil.com>');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.match(/</g).length).toBe(1);
    expect(h.endsWith('<notifications@project86.net>')).toBe(true);
    expect(h.match(/@/g).length).toBe(1);
    // Exactly the two quotes that delimit the display name.
    expect(h.match(/"/g).length).toBe(2);
  });

  test('a refused name falls back to EMAIL_FROM verbatim', () => {
    expect(sender.fromHeader(ENV_FROM, 'Project 86 Security')).toBe(ENV_FROM);
    expect(sender.fromHeader(ENV_FROM, '')).toBe(ENV_FROM);
    expect(sender.fromHeader(ENV_FROM, null)).toBe(ENV_FROM);
  });

  test('an unparseable EMAIL_FROM is never rewritten', () => {
    expect(sender.fromHeader('weird value', 'AG Exteriors')).toBe('weird value');
  });
});

describe('cleanReplyTo', () => {
  test('a plain address passes, trimmed', () => {
    expect(sender.cleanReplyTo(' pm@agx.com ', ['sub@example.com'])).toBe('pm@agx.com');
  });
  test('CR/LF, display names, lists and specials are refused', () => {
    expect(sender.cleanReplyTo('pm@agx.com\r\nBcc: x@y.com', [])).toBeNull();
    expect(sender.cleanReplyTo('pm@agx.com\n', [])).toBeNull();
    expect(sender.cleanReplyTo('PM <pm@agx.com>', [])).toBeNull();
    expect(sender.cleanReplyTo('a@agx.com, b@agx.com', [])).toBeNull();
    expect(sender.cleanReplyTo('a@agx.com;b@agx.com', [])).toBeNull();
    expect(sender.cleanReplyTo('no-at-sign', [])).toBeNull();
    expect(sender.cleanReplyTo('a@localhost', [])).toBeNull();
    expect(sender.cleanReplyTo('', [])).toBeNull();
    expect(sender.cleanReplyTo(false, [])).toBeNull();
    expect(sender.cleanReplyTo('a'.repeat(250) + '@x.com', [])).toBeNull();
  });
  test('an address equal to any recipient is dropped, case-insensitively', () => {
    expect(sender.cleanReplyTo('PM@AGX.com', ['other@x.com', 'pm@agx.com'])).toBeNull();
    expect(sender.cleanReplyTo('pm@agx.com', 'PM@agx.com')).toBeNull();
    expect(sender.cleanReplyTo('pm@agx.com', ['Pat <PM@agx.com>'])).toBeNull();
  });
});

// A users/organizations table with the predicates actually evaluated, so a
// lookup that dropped its org predicate would return the wrong row here.
function fakeDb(state) {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: text, params });
      if (state.throws) throw new Error('db down');
      if (/^SELECT name FROM organizations WHERE id = \$1$/.test(text)) {
        const o = state.orgs.find((x) => String(x.id) === String(params[0]));
        return { rows: o ? [{ name: o.name }] : [] };
      }
      if (/^SELECT email FROM users WHERE id = \$1 AND organization_id = \$2 AND active = TRUE$/.test(text)) {
        const u = state.users.find((x) => String(x.id) === String(params[0]) &&
          String(x.organization_id) === String(params[1]) && x.active);
        return { rows: u ? [{ email: u.email }] : [] };
      }
      if (/FROM users WHERE organization_id = \$1 AND active = TRUE AND role IN \('admin', 'system_admin'\)/.test(text)) {
        const rows = state.users
          .filter((x) => String(x.organization_id) === String(params[0]) && x.active &&
            (x.role === 'admin' || x.role === 'system_admin') && x.email)
          .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
        return { rows: rows.slice(0, 1).map((x) => ({ email: x.email })) };
      }
      throw new Error('unexpected SQL: ' + text);
    }
  };
}

describe('orgNameFor', () => {
  beforeEach(() => sender._clearOrgNameCache());

  test('reads the name by primary key and caches it', async () => {
    const db = fakeDb({ orgs: [{ id: 7, name: 'AG Exteriors' }], users: [] });
    expect(await sender.orgNameFor(db, 7)).toBe('AG Exteriors');
    expect(await sender.orgNameFor(db, 7)).toBe('AG Exteriors');
    expect(db.log.length).toBe(1);
    expect(db.log[0].params).toEqual([7]);
  });

  test('a miss, a null id and a throwing db all resolve to null', async () => {
    const db = fakeDb({ orgs: [], users: [] });
    expect(await sender.orgNameFor(db, 99)).toBeNull();
    expect(await sender.orgNameFor(db, null)).toBeNull();
    expect(await sender.orgNameFor(fakeDb({ throws: true, orgs: [], users: [] }), 7)).toBeNull();
    expect(await sender.orgNameFor(null, 7)).toBeNull();
  });
});

describe('replyToForUser', () => {
  const state = {
    orgs: [],
    users: [
      { id: 1, organization_id: 7, active: true, email: 'pm@agx.com', role: 'pm' },
      { id: 2, organization_id: 8, active: true, email: 'staff@platform.com', role: 'system_admin' },
      { id: 3, organization_id: 7, active: false, email: 'gone@agx.com', role: 'pm' },
      { id: 4, organization_id: 7, active: true, email: 'bad\r\n@agx.com', role: 'pm' }
    ]
  };

  test('the in-org active user resolves to their fresh address', async () => {
    const db = fakeDb(state);
    expect(await sender.replyToForUser(db, 1, 7)).toBe('pm@agx.com');
    expect(db.log[0].params).toEqual([1, 7]);
  });

  test('a user from another org (platform staff acting as the tenant) resolves to null', async () => {
    expect(await sender.replyToForUser(fakeDb(state), 2, 7)).toBeNull();
  });

  test('deactivated, malformed, missing ids and db errors resolve to null', async () => {
    expect(await sender.replyToForUser(fakeDb(state), 3, 7)).toBeNull();
    expect(await sender.replyToForUser(fakeDb(state), 4, 7)).toBeNull();
    expect(await sender.replyToForUser(fakeDb(state), null, 7)).toBeNull();
    expect(await sender.replyToForUser(fakeDb(state), 1, null)).toBeNull();
    expect(await sender.replyToForUser(fakeDb({ throws: true }), 1, 7)).toBeNull();
  });
});

describe('replyToForOrgAdmin', () => {
  test('the earliest-created active admin of THAT org', async () => {
    const db = fakeDb({
      orgs: [],
      users: [
        { id: 10, organization_id: 8, active: true, email: 'other-org-admin@x.com', role: 'admin', created_at: 1 },
        { id: 11, organization_id: 7, active: false, email: 'old-owner@agx.com', role: 'admin', created_at: 2 },
        { id: 12, organization_id: 7, active: true, email: 'owner@agx.com', role: 'system_admin', created_at: 3 },
        { id: 13, organization_id: 7, active: true, email: 'office@agx.com', role: 'admin', created_at: 4 },
        { id: 14, organization_id: 7, active: true, email: 'pm@agx.com', role: 'pm', created_at: 0 }
      ]
    });
    expect(await sender.replyToForOrgAdmin(db, 7)).toBe('owner@agx.com');
    expect(db.log[0].params).toEqual([7]);
  });

  test('no admin, no org id, or a db error -> null', async () => {
    expect(await sender.replyToForOrgAdmin(fakeDb({ orgs: [], users: [] }), 7)).toBeNull();
    expect(await sender.replyToForOrgAdmin(fakeDb({ orgs: [], users: [] }), null)).toBeNull();
    expect(await sender.replyToForOrgAdmin(fakeDb({ throws: true }), 7)).toBeNull();
  });
});
