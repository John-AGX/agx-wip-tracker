// Sender identity at the automated send sites the core email module owns:
// campaigns, the reminders cron, the cert-expiry cron and the weekly digests.
//
// Each site is driven through its real exported entry point with the email
// module mocked, so what is asserted is the OPTIONS each site hands to
// sendEmail / sendForEvent:
//   campaigns      senderOrg = the campaign's org; Reply-To = the creator,
//                  re-read FRESH and predicated on the campaign's org — a
//                  creator who moved org or was deactivated gets false, never
//                  someone else's address.
//   reminders      senderOrg = the recipient's own org (from the existing
//                  organizations JOIN); org-less users get the platform
//                  sender; replyTo false everywhere.
//   cert-expiry    __orgId now passed (it was missing, so cert reminders never
//                  got org branding, overrides or metering); Reply-To = that
//                  org's earliest active admin, since the copy says "reply to
//                  this email"; another org's admin is never chosen.
//   weekly digest  org-scope events with __orgId (branded by sendForEvent),
//                  replyTo false. Held at the source because the digest
//                  assembly is a dozen queries deep; the scope rule itself is
//                  held in email-send-identity.test.js.

const fs = require('fs');
const path = require('path');

let mockHandler = null;
let mockQueries = [];
jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      mockQueries.push({ sql: text, params: params || [] });
      return mockHandler ? mockHandler(text, params || []) : { rows: [], rowCount: 0 };
    }
  }
}));

let mockSendEmailCalls = [];
let mockSendForEventCalls = [];
jest.mock('../server/email', () => ({
  sendEmail: async (opts) => { mockSendEmailCalls.push(opts); return { ok: true, id: 'em_1' }; },
  sendForEvent: async (key, params, opts) => { mockSendForEventCalls.push({ key, params, opts }); return { ok: true }; },
  isEnabled: () => true,
  isDryRun: () => false
}));

jest.mock('../server/notify-events', () => ({ sendPushForEvent: async () => {} }));

jest.mock('../server/timezone', () => {
  const actual = jest.requireActual('../server/timezone');
  return Object.assign({}, actual, {
    hourInTz: () => 10,
    localDateInTz: () => '2026-09-14'
  });
});

// One users table, predicates evaluated, shared by the campaign and cert sites.
const USERS = [
  { id: 1, organization_id: 7, active: true, role: 'admin', email: 'owner@agx.com', created_at: 1 },
  { id: 2, organization_id: 7, active: true, role: 'admin', email: 'office@agx.com', created_at: 5 },
  { id: 3, organization_id: 8, active: true, role: 'admin', email: 'boss@other.com', created_at: 0 },
  { id: 4, organization_id: 7, active: false, role: 'pm', email: 'left@agx.com', created_at: 2 }
];
function usersQuery(text, params) {
  if (/^SELECT email FROM users WHERE id = \$1 AND organization_id = \$2 AND active = TRUE$/.test(text)) {
    const u = USERS.find((x) => String(x.id) === String(params[0]) &&
      String(x.organization_id) === String(params[1]) && x.active);
    return { rows: u ? [{ email: u.email }] : [] };
  }
  if (/FROM users WHERE organization_id = \$1 AND active = TRUE AND role IN \('admin', 'system_admin'\)/.test(text)) {
    const rows = USERS.filter((x) => String(x.organization_id) === String(params[0]) && x.active &&
      (x.role === 'admin' || x.role === 'system_admin')).sort((a, b) => a.created_at - b.created_at);
    return { rows: rows.slice(0, 1).map((x) => ({ email: x.email })) };
  }
  return null;
}

beforeEach(() => {
  mockHandler = null;
  mockQueries = [];
  mockSendEmailCalls = [];
  mockSendForEventCalls = [];
});

describe('email-campaigns drainCampaign', () => {
  const campaigns = require('../server/email-campaigns');

  function handlerFor(recipients) {
    return (text, params) => {
      const u = usersQuery(text, params);
      if (u) return u;
      if (/FROM email_campaign_recipients WHERE campaign_id = \$1 AND status = 'queued' ORDER BY/.test(text)) {
        return { rows: recipients };
      }
      if (/SELECT COUNT\(\*\)::int AS c FROM email_campaign_recipients/.test(text)) return { rows: [{ c: 0 }] };
      return { rows: [], rowCount: 1 };
    };
  }
  const RECIPS = [{ id: 11, email: 'mike@summit.com', name: 'Mike', params: {} }];

  test('branded with the campaign org; Reply-To is the in-org creator', async () => {
    mockHandler = handlerFor(RECIPS);
    await campaigns.drainCampaign({ id: 'camp_1', organization_id: 7, created_by: 2, subject: 'Hi', body: '<p>x</p>' });
    expect(mockSendEmailCalls).toHaveLength(1);
    const o = mockSendEmailCalls[0];
    expect(o.senderOrg).toEqual({ id: 7 });
    expect(o.replyTo).toBe('office@agx.com');
    expect(o.organizationId).toBe(7);
    const lookup = mockQueries.find((q) => /FROM users WHERE id = \$1 AND organization_id = \$2/.test(q.sql));
    expect(lookup.params).toEqual([2, 7]);
  });

  test('a creator from ANOTHER org never becomes the Reply-To', async () => {
    mockHandler = handlerFor(RECIPS);
    await campaigns.drainCampaign({ id: 'camp_2', organization_id: 7, created_by: 3, subject: 'Hi', body: '<p>x</p>' });
    expect(mockSendEmailCalls[0].replyTo).toBe(false);
    expect(JSON.stringify(mockSendEmailCalls)).not.toContain('boss@other.com');
  });

  test('a deactivated or deleted creator gives no Reply-To', async () => {
    mockHandler = handlerFor(RECIPS);
    await campaigns.drainCampaign({ id: 'camp_3', organization_id: 7, created_by: 4, subject: 'Hi', body: '<p>x</p>' });
    await campaigns.drainCampaign({ id: 'camp_4', organization_id: 7, created_by: null, subject: 'Hi', body: '<p>x</p>' });
    expect(mockSendEmailCalls.map((o) => o.replyTo)).toEqual([false, false]);
  });

  test('an empty drain does no identity lookups', async () => {
    mockHandler = handlerFor([]);
    await campaigns.drainCampaign({ id: 'camp_5', organization_id: 7, created_by: 2, subject: 'Hi', body: '<p>x</p>' });
    expect(mockQueries.some((q) => /FROM users/.test(q.sql))).toBe(false);
  });
});

describe('reminders-cron runOnce', () => {
  const reminders = require('../server/reminders-cron');

  test('each send carries the recipient org (or the platform sender) and replyTo false', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    mockHandler = (text) => {
      if (/FROM tasks t JOIN users u/.test(text)) {
        expect(text).toContain('o.id AS org_id, o.name AS org_name');
        return { rows: [
          { uid: 1, email: 'owner@agx.com', name: 'Owner', notification_prefs: {}, org_id: 7, org_name: 'AG Exteriors',
            id: 100, title: 'Call HOA', priority: 'normal', due_iso: '2026-09-13' },
          { uid: 50, email: 'solo@nowhere.com', name: 'Solo', notification_prefs: {}, org_id: null, org_name: null,
            id: 101, title: 'Solo task', priority: 'normal', due_iso: '2026-09-14' }
        ] };
      }
      if (/FROM calendar_events ce JOIN users u/.test(text)) {
        expect(text).toContain('o.id AS org_id, o.name AS org_name');
        return { rows: [{ id: 200, title: 'Walkthrough', starts_at: future, reminder_minutes: 30, all_day: false,
          uid: 2, email: 'office@agx.com', name: 'Office', notification_prefs: {}, org_id: 7, org_name: 'AG Exteriors' }] };
      }
      if (/FROM reminders r JOIN users u/.test(text)) {
        expect(text).toContain('o.id AS org_id, o.name AS org_name');
        return { rows: [{ id: 300, title: 'Follow up', notes: '', remind_at: new Date().toISOString(),
          uid: 3, email: 'boss@other.com', name: 'Boss', notification_prefs: {}, org_id: 8, org_name: 'Other Co' }] };
      }
      if (/^UPDATE reminders SET fired_at/.test(text)) return { rows: [{ id: 300 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const out = await reminders.runOnce({});
    log.mockRestore();
    expect(out.tasks.sent).toBe(2);
    const byTag = {};
    mockSendEmailCalls.forEach((o) => { (byTag[o.tag] = byTag[o.tag] || []).push(o); });

    const agxTask = byTag.task_due.find((o) => o.to === 'owner@agx.com');
    expect(agxTask.senderOrg).toEqual({ id: 7, name: 'AG Exteriors' });
    expect(agxTask.replyTo).toBe(false);
    expect(agxTask.organizationId).toBe(7);

    const soloTask = byTag.task_due.find((o) => o.to === 'solo@nowhere.com');
    expect(soloTask.senderOrg).toBeUndefined();
    expect(soloTask.replyTo).toBe(false);

    expect(byTag.event_reminder[0].senderOrg).toEqual({ id: 7, name: 'AG Exteriors' });
    expect(byTag.event_reminder[0].replyTo).toBe(false);
    // Each recipient gets THEIR org, not whichever org came first.
    expect(byTag.reminder[0].senderOrg).toEqual({ id: 8, name: 'Other Co' });
    expect(byTag.reminder[0].replyTo).toBe(false);
  });
});

describe('cert-expiry-cron runOnce', () => {
  const certCron = require('../server/cert-expiry-cron');

  function handler(orgs, certsByOrg) {
    return (text, params) => {
      const u = usersQuery(text, params);
      if (u) return u;
      if (/^SELECT id, name, timezone FROM organizations WHERE archived_at IS NULL$/.test(text)) return { rows: orgs };
      if (/FROM sub_certificates sc JOIN subs s/.test(text)) return { rows: certsByOrg[String(params[0])] || [] };
      return { rows: [], rowCount: 0 };
    };
  }
  const cert = (id, email) => ({ cert_id: id, cert_type: 'gl', expiration_date: '2026-10-01', reminder_days: 30,
    reminder_direction: 'before', days_until: 17, sub_id: id, sub_name: 'Summit', sub_email: email, primary_contact_first: 'Mike' });

  test('passes __orgId and the org\'s own earliest active admin as Reply-To', async () => {
    mockHandler = handler(
      [{ id: 7, name: 'AG Exteriors', timezone: 'America/New_York' }, { id: 8, name: 'Other', timezone: 'America/New_York' }],
      { 7: [cert(1, 'mike@summit.com')], 8: [cert(2, 'jo@roofers.com')] }
    );
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await certCron.runOnce({ force: true });
    log.mockRestore();
    expect(mockSendForEventCalls).toHaveLength(2);
    const agx = mockSendForEventCalls.find((c) => c.opts.to === 'mike@summit.com');
    expect(agx.key).toBe('cert_expiring');
    expect(agx.params.__orgId).toBe(7);
    expect(agx.opts.replyTo).toBe('owner@agx.com');
    const other = mockSendForEventCalls.find((c) => c.opts.to === 'jo@roofers.com');
    expect(other.params.__orgId).toBe(8);
    expect(other.opts.replyTo).toBe('boss@other.com');
    const adminLookups = mockQueries.filter((q) => /role IN \('admin', 'system_admin'\)/.test(q.sql));
    expect(adminLookups.map((q) => q.params)).toEqual([[7], [8]]);
  });

  test('an org with no active admin gets replyTo false — never another org\'s admin', async () => {
    mockHandler = handler([{ id: 9, name: 'No Admin Co', timezone: 'America/New_York' }], { 9: [cert(3, 'x@sub.com')] });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await certCron.runOnce({ force: true });
    log.mockRestore();
    expect(mockSendForEventCalls[0].params.__orgId).toBe(9);
    expect(mockSendForEventCalls[0].opts.replyTo).toBe(false);
  });

  test('an org with no expiring certs does no admin lookup', async () => {
    mockHandler = handler([{ id: 7, name: 'AG', timezone: 'America/New_York' }], {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await certCron.runOnce({ force: true });
    log.mockRestore();
    expect(mockQueries.some((q) => /FROM users/.test(q.sql))).toBe(false);
  });
});

describe('weekly-digest-cron sends (source)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'weekly-digest-cron.js'), 'utf8');

  test.each(['weekly_digest_pm', 'weekly_digest_sales', 'weekly_digest_ops'])(
    '%s passes __orgId and replyTo:false', (key) => {
      const line = src.split(/\r?\n/).find((l) => l.indexOf("sendForEvent('" + key + "'") !== -1);
      expect(line).toBeDefined();
      expect(line).toContain('__orgId: org.id');
      expect(line).toMatch(/\{ to: u\.email, replyTo: false \}\);\s*$/);
    });

  test('the tenant-plants anchors are still present exactly once', () => {
    expect(src.split('async function runOnce(opts) {').length - 1).toBe(1);
    expect(src.split('  const plan = [];').length - 1).toBe(1);
  });
});
