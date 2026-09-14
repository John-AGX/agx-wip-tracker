// sendEmail / sendForEvent — the From and Reply-To that actually reach Resend.
//
// WHAT WAS WRONG
// email.js set payload.reply_to. resend@4 builds its API body from
// payload.replyTo (camelCase) and silently drops a snake_case key, so no
// Reply-To — not EMAIL_REPLY_TO, not any caller's — ever left the app. Nothing
// failed; replies just went to the no-reply sender address and died there.
//
// WHAT IS NOW HELD, AT THE PAYLOAD RESEND RECEIVES
//   - replyTo is camelCase; reply_to is never set.
//   - Branding is an EXPLICIT opt-in (opts.senderOrg). opts.organizationId is
//     metering and never brands a send on its own.
//   - Branded From is exactly '"<Org> via Project 86" <EMAIL_FROM address>';
//     platform mail keeps EMAIL_FROM verbatim.
//   - Org mail never inherits the platform EMAIL_REPLY_TO (a sub's reply to
//     their GC must not land in platform support); replyTo:false suppresses it
//     on platform mail too.
//   - A provider validation error on a branded From retries ONCE on the plain
//     From, so an odd company name can never cost a notification.
//   - Dry-run and every other exit log the From / Reply-To they would carry.
//   - sendForEvent brands only org-scope events: org_invite / user_invite /
//     password_reset stay on the platform sender even with an org id, and the
//     org name rides on render()'s existing organizations read.

process.env.RESEND_API_KEY = 're_test_key';
process.env.EMAIL_FROM = 'Project 86 <notifications@project86.net>';
delete process.env.EMAIL_DRY_RUN;
delete process.env.EMAIL_REPLY_TO;
delete process.env.EMAIL_PLATFORM_NAME;

const PLAIN_FROM = 'Project 86 <notifications@project86.net>';

let mockSends = [];
let mockSendImpl = null;
jest.mock('resend', () => ({
  Resend: class {
    constructor() {
      this.emails = {
        send: async (payload) => {
          mockSends.push(JSON.parse(JSON.stringify(payload)));
          return mockSendImpl ? mockSendImpl(payload, mockSends.length) : { data: { id: 'prov_' + mockSends.length }, error: null };
        }
      };
    }
  }
}));

let mockQueries = [];
let mockOrgs = {};
let mockEmailSettings = null;
jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      mockQueries.push({ sql: text, params: params || [] });
      if (/^SELECT name FROM organizations WHERE id = \$1$/.test(text)) {
        const name = mockOrgs[String(params[0])];
        return { rows: name ? [{ name }] : [] };
      }
      if (/^SELECT name, branding FROM organizations WHERE id = \$1$/.test(text)) {
        const name = mockOrgs[String(params[0])];
        return { rows: name ? [{ name, branding: null }] : [] };
      }
      if (/SELECT value FROM app_settings WHERE key = 'email'/.test(text)) {
        return { rows: mockEmailSettings ? [{ value: mockEmailSettings }] : [] };
      }
      if (/FROM email_template_overrides/.test(text)) return { rows: [] };
      if (/^INSERT INTO email_log/.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  }
}));

jest.mock('../server/usage-meter', () => ({ recordUsage: jest.fn(async () => {}) }));

const email = require('../server/email');
const emailSender = require('../server/email-sender');

function logRows() {
  // logSend params: [id, to, subject, tag, status, provider_id, error, dry_run, from_header, reply_to]
  return mockQueries.filter((q) => /^INSERT INTO email_log/.test(q.sql)).map((q) => ({
    id: q.params[0], to: q.params[1], status: q.params[4], error: q.params[6],
    dryRun: q.params[7], from: q.params[8], replyTo: q.params[9]
  }));
}
function orgQueries() {
  return mockQueries.filter((q) => /FROM organizations/.test(q.sql));
}

beforeEach(() => {
  mockSends = [];
  mockSendImpl = null;
  mockQueries = [];
  mockOrgs = { 7: 'AG Exteriors', 8: 'Project 86 Security', 9: 'Acme\r\nBcc: spy@evil.com' };
  const events = {};
  require('../server/email-events').EVENTS.forEach((e) => { events[e.key] = { enabled: true, bcc: [] }; });
  mockEmailSettings = { events, globalBcc: '' };
  delete process.env.EMAIL_DRY_RUN;
  delete process.env.EMAIL_REPLY_TO;
  process.env.EMAIL_FROM = PLAIN_FROM;
  process.env.RESEND_API_KEY = 're_test_key';
  emailSender._clearOrgNameCache();
});

const BASE = { to: 'sub@example.com', subject: 'Hello', html: '<p>Hi</p>', tag: 't' };

describe('the Resend payload', () => {
  test('replyTo is camelCase and reply_to is never set', async () => {
    const r = await email.sendEmail(Object.assign({}, BASE, { replyTo: 'pm@agx.com' }));
    expect(r.ok).toBe(true);
    expect(mockSends).toHaveLength(1);
    expect(mockSends[0].replyTo).toBe('pm@agx.com');
    expect(mockSends[0]).not.toHaveProperty('reply_to');
  });

  test('a branded send carries the exact branded From', async () => {
    await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7, name: 'AG Exteriors' } }));
    expect(mockSends[0].from).toBe('"AG Exteriors via Project 86" <notifications@project86.net>');
    expect(orgQueries()).toHaveLength(0);          // name given: no lookup
  });

  test('senderOrg with only an id looks the name up once and caches it', async () => {
    await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 } }));
    await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 } }));
    expect(mockSends.map((p) => p.from)).toEqual([
      '"AG Exteriors via Project 86" <notifications@project86.net>',
      '"AG Exteriors via Project 86" <notifications@project86.net>'
    ]);
    expect(orgQueries()).toHaveLength(1);
    expect(orgQueries()[0].params).toEqual([7]);
  });

  test('an unbranded send keeps EMAIL_FROM verbatim', async () => {
    await email.sendEmail(BASE);
    expect(mockSends[0].from).toBe(PLAIN_FROM);
  });

  test('organizationId alone (metering) never brands and never reads the org', async () => {
    await email.sendEmail(Object.assign({}, BASE, { organizationId: 7 }));
    expect(mockSends[0].from).toBe(PLAIN_FROM);
    expect(orgQueries()).toHaveLength(0);
  });

  test('a refused org name falls back to the plain From', async () => {
    await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 8 } }));
    expect(mockSends[0].from).toBe(PLAIN_FROM);
  });

  test('CR/LF in the org name never reaches the header', async () => {
    await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 9 } }));
    expect(mockSends[0].from).not.toMatch(/[\r\n]/);
    expect(mockSends[0].from).toBe('"Acme Bcc: spy evil.com via Project 86" <notifications@project86.net>');
    expect(mockSends[0]).not.toHaveProperty('bcc');
  });
});

describe('Reply-To fallback rules', () => {
  test('platform mail with no replyTo inherits EMAIL_REPLY_TO', async () => {
    process.env.EMAIL_REPLY_TO = 'support@project86.net';
    await email.sendEmail(BASE);
    expect(mockSends[0].replyTo).toBe('support@project86.net');
  });

  test('branded mail never inherits the platform EMAIL_REPLY_TO', async () => {
    process.env.EMAIL_REPLY_TO = 'support@project86.net';
    await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7, name: 'AG Exteriors' } }));
    expect(mockSends[0]).not.toHaveProperty('replyTo');
  });

  test('org mail whose name was refused still does not inherit EMAIL_REPLY_TO', async () => {
    process.env.EMAIL_REPLY_TO = 'support@project86.net';
    await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 8 } }));
    expect(mockSends[0].from).toBe(PLAIN_FROM);
    expect(mockSends[0]).not.toHaveProperty('replyTo');
  });

  test('replyTo:false suppresses the fallback on platform mail', async () => {
    process.env.EMAIL_REPLY_TO = 'support@project86.net';
    await email.sendEmail(Object.assign({}, BASE, { replyTo: false }));
    expect(mockSends[0]).not.toHaveProperty('replyTo');
  });

  test('a malformed or recipient-equal replyTo is dropped', async () => {
    await email.sendEmail(Object.assign({}, BASE, { replyTo: 'pm@agx.com\r\nBcc: spy@evil.com' }));
    await email.sendEmail(Object.assign({}, BASE, { replyTo: 'SUB@example.com' }));
    expect(mockSends[0]).not.toHaveProperty('replyTo');
    expect(mockSends[1]).not.toHaveProperty('replyTo');
  });

  test('branded mail with an explicit replyTo carries it', async () => {
    await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 }, replyTo: 'pm@agx.com' }));
    expect(mockSends[0].replyTo).toBe('pm@agx.com');
  });
});

describe('provider validation error on a branded From', () => {
  test('retries once with the plain EMAIL_FROM and logs it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSendImpl = (payload, n) => n === 1
      ? { data: null, error: { statusCode: 422, name: 'validation_error', message: 'Invalid `from` field.' } }
      : { data: { id: 'prov_retry' }, error: null };
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 }, replyTo: 'pm@agx.com' }));
    warn.mockRestore();
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('prov_retry');
    expect(mockSends).toHaveLength(2);
    expect(mockSends[0].from).toBe('"AG Exteriors via Project 86" <notifications@project86.net>');
    expect(mockSends[1].from).toBe(PLAIN_FROM);
    expect(mockSends[1].replyTo).toBe('pm@agx.com');
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
    expect(rows[0].from).toBe(PLAIN_FROM);
    expect(rows[0].error).toMatch(/branded From rejected/);
  });

  test('a validation error on an UNbranded send is not retried', async () => {
    mockSendImpl = () => ({ data: null, error: { statusCode: 422, name: 'validation_error', message: 'bad' } });
    const r = await email.sendEmail(BASE);
    expect(r.ok).toBe(false);
    expect(mockSends).toHaveLength(1);
  });

  test('a non-validation error on a branded send is not retried', async () => {
    mockSendImpl = () => ({ data: null, error: { statusCode: 429, name: 'rate_limit_exceeded', message: 'slow down' } });
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 } }));
    expect(r.ok).toBe(false);
    expect(mockSends).toHaveLength(1);
  });

  test('a retry that also fails reports both', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSendImpl = () => ({ data: null, error: { statusCode: 422, name: 'validation_error', message: 'nope' } });
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 } }));
    warn.mockRestore();
    expect(r.ok).toBe(false);
    expect(mockSends).toHaveLength(2);
    expect(logRows()[0].error).toMatch(/retry failed/);
  });
});

describe('logging the identity', () => {
  test('dry-run sends nothing and logs the From and Reply-To it would carry', async () => {
    process.env.EMAIL_DRY_RUN = 'true';
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 }, replyTo: 'pm@agx.com' }));
    log.mockRestore();
    expect(r.dryRun).toBe(true);
    expect(mockSends).toHaveLength(0);
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('dry-run');
    expect(rows[0].from).toBe('"AG Exteriors via Project 86" <notifications@project86.net>');
    expect(rows[0].replyTo).toBe('pm@agx.com');
  });

  test('a real send logs from_header and reply_to', async () => {
    await email.sendEmail(Object.assign({}, BASE, { replyTo: 'pm@agx.com' }));
    const rows = logRows();
    expect(rows[0].status).toBe('sent');
    expect(rows[0].from).toBe(PLAIN_FROM);
    expect(rows[0].replyTo).toBe('pm@agx.com');
  });

  test('a thrown send logs under the tracking id the pixel already carries', async () => {
    mockSendImpl = () => { throw new Error('socket hang up'); };
    const r = await email.sendEmail(BASE);
    expect(r.ok).toBe(false);
    const rows = logRows();
    expect(rows[0].status).toBe('failed');
    expect(mockSends[0].html).toContain(encodeURIComponent(rows[0].id));
  });
});

describe('sendForEvent — branding follows the event scope', () => {
  test('an org-scope event with __orgId is branded, with no second organizations read', async () => {
    const r = await email.sendForEvent('lead_status_sold', {
      lead: { title: 'Roof' }, salesperson: { name: 'Jane' }, changedBy: { name: 'Pat' }, __orgId: 7
    }, { to: 'jane@agx.com', replyTo: 'pat@agx.com' });
    expect(r.ok).toBe(true);
    expect(mockSends[0].from).toBe('"AG Exteriors via Project 86" <notifications@project86.net>');
    expect(mockSends[0].replyTo).toBe('pat@agx.com');
    expect(orgQueries()).toHaveLength(1);
    expect(orgQueries()[0].sql).toBe('SELECT name, branding FROM organizations WHERE id = $1');
  });

  test('opts.organizationId also counts as the org for an org-scope event', async () => {
    await email.sendForEvent('cert_expiring', {
      sub: { name: 'Summit' }, cert: { type: 'GL', expirationDate: '2026-10-01', daysUntilExpiry: 18 }
    }, { to: 'mike@summit.com', organizationId: 7 });
    expect(mockSends[0].from).toBe('"AG Exteriors via Project 86" <notifications@project86.net>');
  });

  test('an org-scope event with no org id stays on the platform sender', async () => {
    await email.sendForEvent('job_assigned', {
      recipientName: 'Jane', job: { title: 'Roof' }, assignedBy: 'Pat', action: 'assigned'
    }, { to: 'jane@agx.com' });
    expect(mockSends[0].from).toBe(PLAIN_FROM);
  });

  test.each(['org_invite', 'user_invite', 'password_reset'])(
    'system-scope %s is never branded, even with an org id', async (key) => {
      process.env.EMAIL_REPLY_TO = 'support@project86.net';
      await email.sendForEvent(key, { name: 'Jane', email: 'jane@x.com', password: 'p', __orgId: 7 },
        { to: 'jane@x.com' });
      expect(mockSends[0].from).toBe(PLAIN_FROM);
      // Platform mail: the platform reply address still applies.
      expect(mockSends[0].replyTo).toBe('support@project86.net');
    });

  test('replyTo:false passes through and suppresses the fallback', async () => {
    process.env.EMAIL_REPLY_TO = 'support@project86.net';
    await email.sendForEvent('org_invite', { org_name: 'Acme' }, { to: 'owner@acme.com', replyTo: false });
    expect(mockSends[0]).not.toHaveProperty('replyTo');
  });

  test('a weekly digest (org scope, __orgId, replyTo:false) is branded with no Reply-To', async () => {
    process.env.EMAIL_REPLY_TO = 'support@project86.net';
    await email.sendForEvent('weekly_digest_ops', { recipientName: 'Admin', week_label: 'W', __orgId: 7 },
      { to: 'admin@agx.com', replyTo: false });
    expect(mockSends[0].from).toBe('"AG Exteriors via Project 86" <notifications@project86.net>');
    expect(mockSends[0]).not.toHaveProperty('replyTo');
  });
});

describe('render() surfaces the org name from its existing branding read', () => {
  test('orgName is present with an org id and absent without', async () => {
    const templates = require('../server/email-templates');
    const withOrg = await templates.render('job_assigned', { recipientName: 'J', job: { title: 'T' }, __orgId: 7 });
    expect(withOrg.orgName).toBe('AG Exteriors');
    const without = await templates.render('job_assigned', { recipientName: 'J', job: { title: 'T' } });
    expect(without).not.toHaveProperty('orgName');
  });

  test('renderSample passes opts.orgId through so a test send previews the org', async () => {
    const templates = require('../server/email-templates');
    const sample = await templates.renderSample('job_assigned', {}, { orgId: 7 });
    expect(sample.orgName).toBe('AG Exteriors');
    expect(orgQueries()[0].params).toEqual([7]);
  });
});
