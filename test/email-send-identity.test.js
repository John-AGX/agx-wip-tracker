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
//   - A provider refusal OF THE BRANDED FROM retries ONCE on the plain From,
//     so an odd company name can never cost a notification. A refusal of the
//     Reply-To resends once without it, keeping the branded From. Any other
//     refusal is logged exactly as returned: one call, no From note.
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
    // Before the classification fix this used a bare 'nope' message, which the
    // old any-validation-error rule retried; a From retry now needs a refusal
    // that names the from field.
    mockSendImpl = () => ({ data: null, error: { statusCode: 422, name: 'validation_error', message: 'Invalid `from` field.' } });
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 } }));
    warn.mockRestore();
    expect(r.ok).toBe(false);
    expect(mockSends).toHaveLength(2);
    expect(logRows()[0].error).toMatch(/retry failed/);
  });
});

// ── which refusal earns a resend ────────────────────────────────────────
//
// WHAT WAS WRONG
// The retry fired on ANY 422 or any error named validation_error, and Resend
// files a bad reply_to, a bad recipient, bad tags and even the 403s for an
// unverified domain or testing mode under that one name. A refused Reply-To
// (pm@agx.com. passes the shape check) was resent with the same Reply-To on
// the platform From, failed again, and email_log blamed the org name:
// "branded From rejected by provider (...); retry failed". Every other
// refusal on branded mail cost a second API call and the same false note.
//
// WHAT IS NOW HELD, per branch: the number of calls Resend sees, what each
// call carried, and the email_log row.
const BRANDED = '"AG Exteriors via Project 86" <notifications@project86.net>';
// The shapes resend@4 hands back: the provider's JSON error body as-is.
const RESEND_ERRORS = {
  from: { statusCode: 422, name: 'validation_error', message: 'Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.' },
  fromNamed: { statusCode: 403, name: 'invalid_from_address', message: 'Invalid address.' },
  replyTo: { statusCode: 422, name: 'validation_error', message: 'Invalid `reply_to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.' },
  to: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.' },
  tags: { statusCode: 422, name: 'validation_error', message: 'Tags should only contain ASCII letters, numbers, underscores, or dashes.' },
  domain: { statusCode: 403, name: 'validation_error', message: 'The agx.com domain is not verified. Please, add and verify your domain on https://resend.com/domains' },
  testingMode: { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address (owner@agx.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.' },
  bare422: { statusCode: 422, name: 'validation_error', message: 'nope' },
};
const refuseFirst = (error) => (payload, n) => (n === 1 ? { data: null, error } : { data: { id: 'prov_retry' }, error: null });

describe('provider refusals — only the refused header is taken back', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  test.each(['from', 'fromNamed'])('a %s refusal on a branded send resends once on the platform From, Reply-To kept', async (key) => {
    mockSendImpl = refuseFirst(RESEND_ERRORS[key]);
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 }, replyTo: 'pm@agx.com' }));
    expect(r.ok).toBe(true);
    expect(mockSends).toHaveLength(2);
    expect(mockSends.map((p) => p.from)).toEqual([BRANDED, PLAIN_FROM]);
    expect(mockSends.map((p) => p.replyTo)).toEqual(['pm@agx.com', 'pm@agx.com']);
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', from: PLAIN_FROM, replyTo: 'pm@agx.com' });
    expect(rows[0].error).toBe('branded From rejected by provider (' + RESEND_ERRORS[key].message + '); resent with platform From');
  });

  test('a reply_to refusal resends once WITHOUT the Reply-To and keeps the branded From', async () => {
    mockSendImpl = refuseFirst(RESEND_ERRORS.replyTo);
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 }, replyTo: 'pm@agx.com.' }));
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('prov_retry');
    expect(mockSends).toHaveLength(2);
    expect(mockSends.map((p) => p.from)).toEqual([BRANDED, BRANDED]);
    expect(mockSends[0].replyTo).toBe('pm@agx.com.');
    expect(mockSends[1]).not.toHaveProperty('replyTo');
    expect(mockSends[1]).not.toHaveProperty('reply_to');
    // Nothing else about the mail changed on the resend.
    expect(Object.assign({}, mockSends[1], { replyTo: 'pm@agx.com.' })).toEqual(mockSends[0]);
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', from: BRANDED, replyTo: null });
    expect(rows[0].error).toBe('Reply-To pm@agx.com. rejected by provider (' + RESEND_ERRORS.replyTo.message + '); resent without Reply-To');
    expect(rows[0].error).not.toMatch(/branded From/);
  });

  test('a reply_to refusal on platform mail also resends without the Reply-To', async () => {
    mockSendImpl = refuseFirst(RESEND_ERRORS.replyTo);
    const r = await email.sendEmail(Object.assign({}, BASE, { replyTo: 'pm@agx.com.' }));
    expect(r.ok).toBe(true);
    expect(mockSends.map((p) => p.from)).toEqual([PLAIN_FROM, PLAIN_FROM]);
    expect(mockSends[1]).not.toHaveProperty('replyTo');
    expect(logRows()[0]).toMatchObject({ status: 'sent', from: PLAIN_FROM, replyTo: null });
  });

  test('a reply_to resend that fails too is logged once, naming both, with no From note', async () => {
    mockSendImpl = (payload, n) => (n === 1
      ? { data: null, error: RESEND_ERRORS.replyTo }
      : { data: null, error: RESEND_ERRORS.domain });
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 }, replyTo: 'pm@agx.com.' }));
    expect(r.ok).toBe(false);
    expect(mockSends).toHaveLength(2);
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', from: BRANDED, replyTo: null });
    expect(rows[0].error).toBe('Reply-To pm@agx.com. rejected by provider (' + RESEND_ERRORS.replyTo.message +
      '); resent without Reply-To; retry failed: ' + RESEND_ERRORS.domain.message);
  });

  test('a reply_to refusal on a send that carried no Reply-To is not resent', async () => {
    mockSendImpl = refuseFirst(RESEND_ERRORS.replyTo);
    const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 } }));
    expect(r.ok).toBe(false);
    expect(mockSends).toHaveLength(1);
    expect(logRows()[0].error).toBe(RESEND_ERRORS.replyTo.message);
  });

  test.each(['to', 'tags', 'domain', 'testingMode', 'bare422'])(
    'a %s refusal on a branded send: one call, logged exactly as returned', async (key) => {
      mockSendImpl = () => ({ data: null, error: RESEND_ERRORS[key] });
      const r = await email.sendEmail(Object.assign({}, BASE, { senderOrg: { id: 7 }, replyTo: 'pm@agx.com' }));
      expect(r.ok).toBe(false);
      expect(r.error).toBe(RESEND_ERRORS[key].message);
      expect(mockSends).toHaveLength(1);
      expect(mockSends[0].from).toBe(BRANDED);
      const rows = logRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', from: BRANDED, replyTo: 'pm@agx.com', error: RESEND_ERRORS[key].message });
      expect(warn).not.toHaveBeenCalled();
    });

  test('a from refusal on an UNbranded send is not resent (there is no plainer From)', async () => {
    mockSendImpl = refuseFirst(RESEND_ERRORS.from);
    const r = await email.sendEmail(Object.assign({}, BASE, { replyTo: 'pm@agx.com' }));
    expect(r.ok).toBe(false);
    expect(mockSends).toHaveLength(1);
    expect(logRows()[0].error).toBe(RESEND_ERRORS.from.message);
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
