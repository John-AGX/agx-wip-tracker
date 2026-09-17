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
//   work orders    work-order-notify-cron: the crew-activity batch and the
//                  morning digest carry senderOrg / organizationId of the
//                  TICKET's org; the digest has replyTo false; the crew batch's
//                  Reply-To is the one link's recipient_email re-read by share
//                  id WITH the org predicate, and false for two links. (The
//                  standalone waiting reminder's replyTo false is driven in
//                  work-order-notify-cron.test.js, where business days are
//                  real — the clock is pinned here.)

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

describe('work-order-notify-cron runOnce', () => {
  const workOrderCron = require('../server/work-order-notify-cron');
  const ORG = { id: 7, name: 'AG Exteriors', timezone: 'America/New_York', settings: {} };
  const TICKET = {
    id: 'c1', organization_id: 7, title: 'Gate punch list', job_id: 'j1', lead_id: null, status: 'in_progress',
    created_by: 1, assignee_user_id: null, completed_at: null, updated_at: null,
  };
  const OWNER = { id: 1, name: 'Owner', email: 'owner@agx.com', role: 'admin', timezone: null, notification_prefs: {} };
  const WAITING = Object.assign({}, TICKET, {
    id: 'w1', title: 'Waiting punch list', status: 'work_complete', completed_at: '2026-09-10 12:00:00',
    scheduled_iso: null, due_iso: null, waited_a_day: 1,
  });

  function handler(shares) {
    return (text, params) => {
      if (/^SELECT id, name, timezone, settings FROM organizations WHERE archived_at IS NULL/.test(text)) return { rows: [ORG] };
      if (/^SELECT name FROM organizations WHERE id = \$1$/.test(text)) {
        return { rows: String(params[0]) === '7' ? [{ name: 'AG Exteriors' }] : [] };
      }
      // Step A: nothing stale, nothing due.
      if (/FROM service_tickets t WHERE t\.organization_id = \$1 AND t\.status = 'work_complete'/.test(text)) return { rows: [] };
      if (/FROM service_tickets WHERE organization_id = \$1 AND status = 'work_complete' AND archived_at IS NULL AND approval_notified_at IS NULL/.test(text)) return { rows: [] };
      // Step C: one work order with crew activity.
      if (/FROM service_tickets t JOIN service_ticket_events e/.test(text)) return { rows: [{ id: 'c1', organization_id: 7 }] };
      if (/^UPDATE service_tickets SET crew_activity_prev_notified_at/.test(text)) return { rows: [TICKET], rowCount: 1 };
      if (/FROM service_ticket_events e JOIN service_tickets t/.test(text)) {
        return { rows: shares.map((s, i) => ({
          id: 'e' + i, kind: 'subtask_completed', actor_kind: 'share', share_id: s.id, actor_label: 'Marco',
          detail: { task_id: 't1', title: 'Bldg 1' }, created_at: '2026-09-14 13:00:00',
        })) };
      }
      if (/^SELECT id, created_by, recipient_email FROM service_ticket_shares WHERE id = ANY\(\$1::text\[\]\) AND organization_id = \$2$/.test(text)) {
        return { rows: shares.filter((s) => params[0].includes(s.id) && String(params[1]) === '7') };
      }
      if (/^SELECT owner_id FROM jobs WHERE id = \$1 AND organization_id = \$2$/.test(text)) return { rows: [{ owner_id: 1 }] };
      if (/FROM users WHERE id = ANY\(\$1::int\[\]\) AND organization_id = \$2 AND active = TRUE/.test(text)) return { rows: [OWNER] };
      if (/data->>'jobNumber' AS job_number, data->>'title' AS title, data->>'address'/.test(text)) return { rows: [{ job_number: 'M1', title: 'Gate job' }] };
      // Step D: one person in their morning, one work order waiting on them.
      if (/^SELECT id, timezone FROM users WHERE organization_id = \$1 AND active = TRUE/.test(text)) return { rows: [{ id: 1, timezone: null }] };
      if (/CAST\(scheduled_for AS TEXT\) AS scheduled_iso/.test(text)) return { rows: [WAITING] };
      if (/^SELECT id, owner_id, data->>'jobNumber' AS job_number, data->>'title' AS title FROM jobs/.test(text)) {
        return { rows: [{ id: 'j1', owner_id: 1, job_number: 'M1', title: 'Gate job' }] };
      }
      if (/^SELECT id, name, email, role, timezone, notification_prefs FROM users WHERE organization_id = \$1 AND active = TRUE ORDER BY id ASC$/.test(text)) {
        return { rows: String(params[0]) === '7' ? [OWNER] : [] };
      }
      return { rows: [], rowCount: 0 };
    };
  }

  async function run(shares) {
    mockHandler = handler(shares);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Monday 10:00 in New York (the clock mock above pins the hour and day).
      return await workOrderCron.runOnce({ now: new Date('2026-09-14T14:00:00Z'), deps: { hasCapability: () => true } });
    } finally {
      log.mockRestore();
    }
  }

  test('the crew batch is sent as the ticket’s org; Reply-To is the one link’s address, re-read in that org', async () => {
    const out = await run([{ id: 'sh1', created_by: 1, recipient_email: 'marco@crew.test' }]);
    expect(out.crew.batches).toBe(1);
    const crew = mockSendEmailCalls.filter((o) => o.tag === 'ticket_crew_activity');
    expect(crew).toHaveLength(1);
    expect(crew[0].senderOrg).toEqual({ id: 7, name: 'AG Exteriors' });
    expect(crew[0].organizationId).toBe(7);
    expect(crew[0].replyTo).toBe('marco@crew.test');
    const lookup = mockQueries.find((q) => /FROM service_ticket_shares WHERE id = ANY/.test(q.sql));
    expect(lookup.sql).toContain('AND organization_id = $2');
    expect(lookup.params).toEqual([['sh1'], 7]);
  });

  test('two crew links in one batch: no Reply-To', async () => {
    await run([
      { id: 'sh1', created_by: 1, recipient_email: 'marco@crew.test' },
      { id: 'sh2', created_by: 1, recipient_email: 'jose@crew.test' },
    ]);
    const crew = mockSendEmailCalls.filter((o) => o.tag === 'ticket_crew_activity');
    expect(crew.map((o) => o.replyTo)).toEqual([false]);
  });

  test('the morning digest is sent as the org, metered to it, with replyTo false', async () => {
    const out = await run([]);
    expect(out.digest.digests).toBe(1);
    const digest = mockSendEmailCalls.filter((o) => o.tag === 'work_order_digest');
    expect(digest).toHaveLength(1);
    expect(digest[0].to).toBe('owner@agx.com');
    expect(digest[0].senderOrg).toEqual({ id: 7, name: 'AG Exteriors' });
    expect(digest[0].organizationId).toBe(7);
    expect(digest[0].replyTo).toBe(false);
    expect(digest[0].subject).toBe('[1 to approve] Work orders needing you today (1)');
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
