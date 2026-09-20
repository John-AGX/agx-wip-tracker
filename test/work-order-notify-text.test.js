// WHAT A WORK-ORDER NOTICE SAYS, PINNED.
//
// services/work-order-notify-text.js is pure, so every builder is called with
// plain objects and its subject, text and push are asserted word for word:
//   * assignment, flag, crew activity, digest and waiting reminder (office);
//   * the send-back email to the crew link's address (crew-facing: no link, no
//     money, one-line subject);
//   * crewText takes link-like words out of crew-typed text and keeps the rest;
//   * business days and the reminder setting;
//   * no builder reads a money field — each is handed a site and a ticket that
//     carry one, and it never appears.
// Rules are then removed from a copy of the module and shown to fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL = path.join(__dirname, '..', 'server', 'services', 'work-order-notify-text.js');
const T = require(REAL);
const tmpDirs = [];

function mutant(anchor, replacement) {
  const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  let out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  const dir = path.dirname(REAL);
  out = out.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_m, _q, rel) => 'require(' + JSON.stringify(path.resolve(dir, rel).split(path.sep).join('/')) + ')');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-wont-'));
  tmpDirs.push(tmp);
  const p = path.join(tmp, 'work-order-notify-text.js');
  fs.writeFileSync(p, out, 'utf8');
  return require(p);
}
afterAll(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

const MONEY = /24000|24,000|contract|\$|price|cost|total:/i;

const TICKET = {
  id: 'st1', organization_id: 1, title: 'Latitude 28 punch list', job_id: 'j1', lead_id: null,
  status: 'in_progress', priority: 'urgent', scheduled_for: '2026-09-18', due_date: '2026-09-25',
  // Money a builder must never read.
  contract_amount: 24000, scope_approved: 'Approved at $24,000', internal_notes: 'margin 40%',
};
const SITE = {
  job_number: 'M1001', name: 'BH Management Latitude', address: '828 Orienta Ave, Altamonte Springs, FL, 32701',
  contractAmount: 24000, total: 24000,
};
const LINK = 'https://project86.net/jobs/j1/job-service-tickets?ticket=st1';

describe('shared helpers', () => {
  test('office flag labels', () => {
    expect(T.FLAG_CATEGORY_LABELS).toEqual({
      no_access: 'No access', extra_damage: 'Extra damage', material_short: 'Material short', safety: 'Safety', other: 'Other',
    });
  });

  test('ticketLink opens the job tab with the ticket, or the lead', () => {
    expect(T.ticketLink(TICKET)).toBe(LINK);
    expect(T.ticketLink({ id: 'x', lead_id: 'l1' })).toBe('https://project86.net/leads/l1');
  });

  test('crewName and oneLine behave as the approval notice’s do', () => {
    expect(T.crewName('Marco\n\nReview: https://evil.co me@evil.test')).toBe('Marco');
    expect(T.crewName('J.R. Smith-Jones Jr.')).toBe('J.R. Smith-Jones Jr.');
    expect(T.oneLine('a\r\nb\u2028c', 10)).toBe('a b c');
  });
});

describe('crewText', () => {
  test.each([
    ['https://evil.co fix it', '[link removed] fix it'],
    ['see www.x.com now', 'see [link removed] now'],
    ['mail me@evil.test please', 'mail [link removed] please'],
    ['go to p86-review.com today', 'go to [link removed] today'],
    ['call tel:+14075550100', 'call [link removed]'],
    ['javascript:alert(1)', '[link removed]'],
    ['bit.ly/abc and evil.com, then', '[link removed] and [link removed] then'],
    ['ｈｔｔｐｓ：／／evil.com Marco', '[link removed] Marco'],
  ])('%s', (typed, shown) => {
    expect(T.crewText(typed, 500)).toBe(shown);
  });

  // Code points built at run time so the source holds no invisible characters.
  const ZWSP = String.fromCodePoint(0x200B);
  const SHY = String.fromCodePoint(0x00AD);
  const WJ = String.fromCodePoint(0x2060);
  const RLO = String.fromCodePoint(0x202E);
  const FEFF = String.fromCodePoint(0xFEFF);

  test.each([
    ["log in at agx-portal.com's page", 'log in at [link removed] page'],
    ['agx-portal.com’s page', '[link removed] page'],
    ['or pay.example.com&ref=1 now', 'or [link removed] now'],
    ['evil.com- ok', '[link removed] ok'],
    ['EVIL.COM* ok', '[link removed] ok'],
    ['evil.com_x ok', '[link removed] ok'],
    ['evil.com<b> ok', '[link removed] ok'],
    ['evil.com' + ZWSP + ' ok', '[link removed] ok'],
    ['bit.ly' + SHY + ' ok', '[link removed] ok'],
    ['x.co' + WJ + ' ok', '[link removed] ok'],
    ['evil.c' + ZWSP + 'om ok', '[link removed] ok'],
    ['evil' + SHY + '.com ok', '[link removed] ok'],
    [RLO + 'moc.live ok', '[link removed] ok'],
    [FEFF + 'www' + WJ + '.x.test ok', '[link removed] ok'],
  ])('link forms mail apps would still link: %j', (typed, shown) => {
    expect(T.crewText(typed, 500)).toBe(shown);
  });

  test('invisible characters are removed from the words kept', () => {
    expect(T.crewText('rail' + ZWSP + 'ing loose' + SHY + ', Bldg.784' + WJ + ' side A', 500))
      .toBe('railing loose, Bldg.784 side A');
    expect(T.crewText('Unit 4B, i.e. the corner; 3.5 in. gap (approx.)', 500))
      .toBe('Unit 4B, i.e. the corner; 3.5 in. gap (approx.)');
  });

  test('a flag note with a disguised domain reaches neither the email nor the push', () => {
    const m = T.flagMessage({
      ticket: TICKET, site: SITE, crewLabel: 'Marco',
      flag: { id: 'f', category: 'other', note: "log in at agx-portal.com's page or pay.example.com&ref=1" },
    });
    expect(m.text).toContain('Note: log in at [link removed] page or [link removed]\n');
    for (const s of [m.subject, m.text, m.html, m.push.title, m.push.body]) {
      expect(String(s)).not.toMatch(/agx-portal|pay\.example/);
    }
  });

  test('a run of link-like words becomes one marker', () => {
    expect(T.crewText('a https://x.co www.y.com z@q.io b', 500)).toBe('a [link removed] b');
  });

  test('keeps building numbers, labels ending in a colon, decimals and plain punctuation', () => {
    expect(T.crewText('Note: Bldg.784 railing loose, 2.5 ft. Data: none. e.g. done.', 500))
      .toBe('Note: Bldg.784 railing loose, 2.5 ft. Data: none. e.g. done.');
  });

  test('one line, cut by code point, never through a character', () => {
    expect(T.crewText('line one\nline two', 500)).toBe('line one line two');
    const out = T.crewText('a'.repeat(9) + '\u{20000}bc', 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
  });
});

describe('business days and the reminder setting', () => {
  const Z = 'America/New_York';
  // Friday Sep 11 2026, 4:55 pm Eastern.
  const FRI = '2026-09-11T20:55:00Z';
  test.each([
    ['2026-09-12T15:00:00Z', 0],   // Saturday
    ['2026-09-14T15:00:00Z', 1],   // Monday
    ['2026-09-15T15:00:00Z', 2],   // Tuesday
    ['2026-09-16T15:00:00Z', 3],   // Wednesday
  ])('Friday 4:55 pm finish, now %s -> %i', (now, n) => {
    expect(T.businessDaysSince(FRI, now, Z)).toBe(n);
  });

  test('a Saturday finish is 1 on Monday; the day is the zone’s, not UTC’s', () => {
    expect(T.businessDaysSince('2026-09-12T15:00:00Z', '2026-09-14T15:00:00Z', Z)).toBe(1);
    // 9:30 pm Friday Eastern is already Saturday in UTC: still Friday here.
    expect(T.businessDaysSince('2026-09-12T01:30:00Z', '2026-09-14T15:00:00Z', Z)).toBe(1);
    expect(T.businessDaysSince('2026-09-12 01:30:00', '2026-09-15T15:00:00Z', Z)).toBe(2);
  });

  test('nothing to count', () => {
    expect(T.businessDaysSince(null, new Date(), Z)).toBe(0);
    expect(T.businessDaysSince('2026-09-16T15:00:00Z', '2026-09-14T15:00:00Z', Z)).toBe(0);
  });

  test.each([
    [undefined, 2], [null, 2], [{}, 2], [{ work_orders: {} }, 2],
    [{ work_orders: { approval_reminder_business_days: 'x' } }, 2],
    [{ work_orders: { approval_reminder_business_days: 0 } }, 1],
    [{ work_orders: { approval_reminder_business_days: 99 } }, 10],
    [{ work_orders: { approval_reminder_business_days: 3 } }, 3],
    [{ work_orders: { approval_reminder_business_days: '4' } }, 4],
    ['{"work_orders":{"approval_reminder_business_days":5}}', 5],
  ])('reminderBusinessDays(%j) -> %i', (settings, n) => {
    expect(T.reminderBusinessDays(settings)).toBe(n);
  });

  test('asDate reads a sqlite timestamp as UTC', () => {
    expect(T.asDate('2026-09-14 12:00:00').toISOString()).toBe('2026-09-14T12:00:00.000Z');
    expect(T.asDate('nope')).toBeNull();
  });

  test('a calendar day is never shifted', () => {
    expect(T.calendarDayLabel('2026-09-12')).toBe('Sat Sep 12');
    expect(T.calendarDayLabel(new Date(2026, 8, 12))).toBe('Sat Sep 12');
  });
});

describe('assignment', () => {
  test('exact wording', () => {
    const m = T.assignmentMessage({
      ticket: TICKET, site: SITE, assigner: 'Sam Sender', recipient: { name: 'Paula PM' }, tally: { total: 2, done: 1 },
    });
    expect(m.subject).toBe('Assigned to you: Latitude 28 punch list — M1001 · BH Management Latitude');
    expect(m.text).toBe(
      'Hi Paula PM,\n\n' +
      'Sam Sender assigned you "Latitude 28 punch list".\n\n' +
      'Job: M1001 · BH Management Latitude\n' +
      'Address: 828 Orienta Ave, Altamonte Springs, FL, 32701\n' +
      'Scheduled: Fri Sep 18\n' +
      'Due: Fri Sep 25\n' +
      'Priority: Urgent\n' +
      'Punch list: 1 of 2 buildings done\n\n' +
      'Open work order: ' + LINK + '\n\n' +
      "You're receiving this because a work order was assigned to you. Toggle notifications in My Account → Notifications."
    );
    expect(m.html).toContain('A work order was assigned to you');
    expect(m.html).toContain('>Open work order</a>');
    expect(m.push).toEqual({
      title: '📋 Assigned to you',
      body: 'M1001 · BH Management Latitude — Latitude 28 punch list: assigned by Sam Sender.',
      url: LINK,
      tag: 'ticket_assignment:st1',
    });
    expect(m.subject + m.text + m.html + JSON.stringify(m.push)).not.toMatch(MONEY);
  });

  test('a normal-priority lead ticket with no punch list leaves those rows out', () => {
    const m = T.assignmentMessage({
      ticket: { id: 'stl', lead_id: 'l1', title: 'Lead ticket', priority: 'normal' },
      site: { name: 'Latitude lead' }, assigner: '', recipient: {}, tally: { total: 0, done: 0 },
    });
    expect(m.text).toContain('Hi there,');
    expect(m.text).toContain('A teammate assigned you "Lead ticket".');
    expect(m.text).toContain('\nLead: Latitude lead\n');
    expect(m.text).not.toMatch(/Priority|Punch list|Scheduled|Due:/);
  });
});

describe('send back (crew-facing)', () => {
  const sendBack = {
    note: 'Railing at the stairs is loose.\nPhotos were blurry.',
    buildings: [
      { task_id: 't782', title: 'Bldg 782 — Side A: railing', note: 'Retighten the posts', reopened: true },
      { task_id: 't784', title: 'Bldg 784 — Side A: post', note: null, reopened: true },
    ],
  };

  test('exact wording, no link, no money', () => {
    const m = T.sentBackCrewEmail({ orgName: 'AGX', title: 'Latitude 28 punch list', site: SITE, sendBack, recipientName: 'Marco' });
    expect(m.subject).toBe('Sent back for more work: Latitude 28 punch list — BH Management Latitude');
    expect(m.text).toBe(
      'Hi Marco,\n\n' +
      'AGX sent this work order back for more work: "Latitude 28 punch list".\n\n' +
      'What needs fixing:\nRailing at the stairs is loose.\nPhotos were blurry.\n\n' +
      'Buildings to redo:\n- Bldg 782 — Retighten the posts\n- Bldg 784\n\n' +
      'Address: 828 Orienta Ave, Altamonte Springs, FL, 32701\n\n' +
      'Open the work order from the link AGX sent you earlier. Add a new completion photo to each building you redo and mark it complete again. The office is told when every building is done.\n\n' +
      "You're receiving this because a work order was shared with you at this address."
    );
    expect(m.html).toContain('Railing at the stairs is loose.<br>Photos were blurry.');
    expect(m.html).toContain('<li>Bldg 782 — Retighten the posts</li>');
    const all = m.subject + m.text + m.html;
    expect(all).not.toMatch(/https?:\/\/(?!project86\.net\/images)|\/st\//);
    expect(all).not.toMatch(MONEY);
    expect(m.push).toBeUndefined();
  });

  test('no org name, no recipient name, no buildings, no address; a title cannot forge a subject line', () => {
    const m = T.sentBackCrewEmail({ title: 'Punch\r\nBcc: x', site: {}, sendBack: { note: 'Fix it' } });
    expect(m.subject).toBe('Sent back for more work: Punch Bcc: x');
    expect(m.text).toBe(
      'Hi there,\n\n' +
      'The office sent this work order back for more work: "Punch Bcc: x".\n\n' +
      'What needs fixing:\nFix it\n\n' +
      'Open the work order from the link the office sent you earlier. Add a new completion photo to each building you redo and mark it complete again. The office is told when every building is done.\n\n' +
      "You're receiving this because a work order was shared with you at this address."
    );
  });

  test('HTML in the reason is escaped', () => {
    const m = T.sentBackCrewEmail({ title: 'T', site: {}, sendBack: { note: '<script>x</script>' } });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
});

describe('flag', () => {
  test('exact wording', () => {
    const m = T.flagMessage({
      ticket: TICKET, site: SITE, crewLabel: 'Marco',
      recipient: { name: 'Paula PM' },
      flag: { id: 'stflag1', category: 'extra_damage', note: 'Rot behind the siding, see https://evil.co', task_title: 'Bldg 784 — Side A: post', photo_count: 2 },
    });
    expect(m.subject).toBe('Problem flagged: Extra damage — Latitude 28 punch list — M1001 · BH Management Latitude');
    expect(m.text).toBe(
      'Hi Paula PM,\n\n' +
      'Marco (via the crew link) flagged a problem on "Latitude 28 punch list" at Bldg 784 — Side A: post.\n\n' +
      'Problem: Extra damage\n' +
      'Note: Rot behind the siding, see [link removed]\n' +
      'Photos: 2\n' +
      'Job: M1001 · BH Management Latitude\n' +
      'Address: 828 Orienta Ave, Altamonte Springs, FL, 32701\n\n' +
      'Open work order: ' + LINK + '\n\n' +
      "You're receiving this because you run this job, sent its crew link, are assigned to this work order or are watching it. Toggle notifications in My Account → Notifications."
    );
    expect(m.html).toContain('A crew flagged a problem');
    expect(m.push).toEqual({
      title: '⚠️ Problem flagged: Extra damage',
      body: 'M1001 · BH Management Latitude — Latitude 28 punch list: Rot behind the siding, see [link removed]',
      url: LINK,
      tag: 'ticket_problem:stflag1',
    });
    expect(m.subject + m.text + m.html).not.toMatch(MONEY);
    expect(m.text + m.html + m.push.body).not.toContain('evil');
  });

  test('admins told as the fallback get their own footer; an unknown category reads Other', () => {
    const m = T.flagMessage({ ticket: TICKET, site: SITE, flag: { id: 'f', category: 'weird', note: 'x' }, fallback: 'admins' });
    expect(m.subject.startsWith('Problem flagged: Other — ')).toBe(true);
    expect(m.text).toContain('The crew link flagged a problem on "Latitude 28 punch list".');
    expect(m.text).toContain("because you're an admin and nobody on this work order can open it.");
  });

  test('the push body is one line and at most 120 characters of the note', () => {
    const m = T.flagMessage({ ticket: TICKET, site: SITE, flag: { id: 'f', category: 'safety', note: 'x\n'.repeat(200) } });
    expect(m.push.body).not.toMatch(/[\r\n]/);
    const note = m.push.body.split(': ').slice(1).join(': ');
    expect(Array.from(note).length).toBeLessThanOrEqual(120);
  });
});

describe('crew activity', () => {
  const ev = (kind, detail, extra) => Object.assign({ kind, actor_kind: 'share', share_id: 'sh1', actor_label: 'Marco', detail }, extra || {});
  const titles = new Map([['t782', 'Bldg 782 — Side A: railing'], ['t784', 'Bldg 784 — Side A: post']]);

  test('summary lines in order, with plurals and quoted notes', () => {
    const s = T.crewActivitySummary([
      ev('share_opened', {}),
      ev('status_changed', { from: 'scheduled', to: 'in_progress' }),
      ev('subtask_completed', { task_id: 't782', title: 'Bldg 782 — Side A: railing' }),
      ev('subtask_completed', { task_id: 't784', title: 'Bldg 784 — Side A: post' }),
      ev('subtask_completed', { task_id: 't784', title: 'Bldg 784 — Side A: post' }),
      ev('subtask_reopened', { task_id: 't782', title: 'Bldg 782 — Side A: railing' }),
      ev('photo_added', { task_id: 't782', kind: 'completion' }),
      ev('photo_added', { task_id: 't782', kind: 'completion' }),
      ev('photo_added', { task_id: 't784', kind: 'before' }),
      ev('photo_added', { mime: 'image/jpeg' }),
      ev('subtask_note', { task_id: 't782', note: 'Loose rail, see www.evil.test' }),
      ev('note_added', { fields: ['note', 'checklist'] }),
      ev('revision_proposed', {}),
      ev('revision_proposed', {}),
    ], { taskTitles: titles, pendingSuggestions: 1 });
    expect(s.lines).toEqual([
      'Opened the work order for the first time',
      'Started work',
      'Finished 2 buildings: Bldg 782 — Side A: railing, Bldg 784 — Side A: post',
      'Reopened 1 building: Bldg 782 — Side A: railing',
      'Added 4 photos (2 completion, 1 before, 1 site)',
      'Left 1 note',
      'Added a field report note',
      'Updated the checklist',
      'Suggested 2 changes — 1 waiting for you',
    ]);
    expect(s.quotes).toEqual(['“Loose rail, see [link removed]” — Bldg 782 — Side A: railing']);
    expect(s.who).toBe('Marco (via the crew link)');
  });

  test('the crew taking back Mark work complete is said as that, never "Started work"', () => {
    expect(T.crewActivitySummary([
      ev('status_changed', { from: 'work_complete', to: 'in_progress', reason: 'crew_undid_finish' }),
    ], {}).lines).toEqual(['Took back Mark work complete — the work order is in progress again']);
    // A building reopened at Work complete moves the status too; the Reopened line says it.
    expect(T.crewActivitySummary([
      ev('status_changed', { from: 'work_complete', to: 'in_progress', reason: 'subtask_reopened' }),
      ev('subtask_reopened', { task_id: 't782', title: 'Bldg 782 — Side A: railing' }),
    ], {}).lines).toEqual(['Reopened 1 building: Bldg 782 — Side A: railing']);
    expect(T.crewActivitySummary([
      ev('status_changed', { from: 'scheduled', to: 'in_progress' }),
      ev('status_changed', { from: 'work_complete', to: 'in_progress', reason: 'crew_undid_finish' }),
    ], {}).lines).toEqual(['Started work', 'Took back Mark work complete — the work order is in progress again']);
  });

  test('five titles at most, then "and N more"', () => {
    const events = [1, 2, 3, 4, 5, 6, 7].map((n) => ev('subtask_completed', { task_id: 't' + n, title: 'B' + n }));
    expect(T.crewActivitySummary(events, {}).lines).toEqual(['Finished 7 buildings: B1, B2, B3, B4, B5 and 2 more']);
  });

  test.each([
    [['Marco'], 'Marco (via the crew link)'],
    [['Marco', 'Jose'], 'Marco and Jose (via crew links)'],
    [['Marco', 'Jose', 'Ana'], 'Marco and 2 others (via crew links)'],
    [['https://evil.co'], 'The crew (via the crew link)'],
  ])('who: %j', (labels, who) => {
    const events = labels.map((l) => ev('note_added', { fields: ['note'] }, { actor_label: l }));
    expect(T.crewActivitySummary(events, {}).who).toBe(who);
  });

  test('exact message wording', () => {
    const summary = T.crewActivitySummary([
      ev('share_opened', {}),
      ev('subtask_note', { task_id: 't782', note: 'Railing loose' }),
    ], { taskTitles: titles });
    const m = T.crewActivityMessage({ ticket: TICKET, site: SITE, summary, recipient: { name: 'Paula PM' } });
    expect(m.subject).toBe('Crew update: Latitude 28 punch list — M1001 · BH Management Latitude');
    expect(m.text).toBe(
      'Hi Paula PM,\n\n' +
      'Marco (via the crew link) on "Latitude 28 punch list":\n' +
      '- Opened the work order for the first time\n' +
      '- Left 1 note\n' +
      '  “Railing loose” — Bldg 782 — Side A: railing\n\n' +
      'Job: M1001 · BH Management Latitude\n' +
      'Address: 828 Orienta Ave, Altamonte Springs, FL, 32701\n\n' +
      'Open work order: ' + LINK + '\n\n' +
      "At most one of these per work order every 30 minutes. You're receiving this because you run this job, sent its crew link, are assigned to this work order or are watching it. Toggle notifications in My Account → Notifications."
    );
    expect(m.push).toEqual({
      title: '🛠 Crew update',
      body: 'M1001 · BH Management Latitude — Latitude 28 punch list: Opened the work order for the first time; Left 1 note',
      url: LINK,
      tag: 'ticket_crew_activity:st1',
    });
    expect(m.subject + m.text + m.html).not.toMatch(MONEY);
  });
});

describe('digest and waiting reminder', () => {
  const t2 = { id: 'st2', job_id: 'j2', title: 'Second job punch' };
  const sections = {
    your_buildings: [{ ticket: t2, jobLine: 'M1002 · Pines', count: 3, nextDue: '2026-09-21' }],
    approvals: [{ ticket: TICKET, site: SITE, daysWaiting: 3, over: true }],
    flags: [{ ticket: t2, jobLine: 'M1002 · Pines', category: 'no_access', flaggedAt: '2026-09-14T15:00:00Z' }],
    overdue: [{ ticket: t2, jobLine: 'M1002 · Pines', dueDate: '2026-09-12', done: 1, total: 3 }],
    unopened: [{ ticket: TICKET, site: SITE, when: 'tomorrow', linkSent: true }],
    expiring: [{ ticket: t2, jobLine: 'M1002 · Pines', crewName: 'Jose', expiresAt: '2026-09-18T14:00:00Z' }],
    suggestions: [{ ticket: TICKET, site: SITE, count: 1 }],
  };

  test('digest exact wording', () => {
    const m = T.digestMessage({ recipient: { name: 'Paula PM' }, sections, overDays: 2, zone: 'America/New_York' });
    expect(m.subject).toBe('[1 to approve] Work orders needing you today (2)');
    const L2 = 'https://project86.net/jobs/j2/job-service-tickets?ticket=st2';
    expect(m.text).toBe([
      'Good morning, Paula',
      '2 work orders need your attention.',
      // FIRST: since 1.33 a building is on no task list, so for the person it
      // is assigned to this row is the only place the work is named.
      'Buildings assigned to you (1)\n- Second job punch\n  M1002 · Pines · 3 buildings still open · next due Mon Sep 21\n  ' + L2,
      'Ready for your approval (1)\n- Latitude 28 punch list\n  M1001 · BH Management Latitude · waiting 3 days · over 2 business days\n  ' + LINK,
      'Problems flagged by crews (1)\n- Second job punch\n  M1002 · Pines · No access · flagged Mon Sep 14\n  ' + L2,
      'Overdue (1)\n- Second job punch\n  M1002 · Pines · due Sat Sep 12 · 1 of 3 buildings done\n  ' + L2,
      'Crew scheduled soon, link not opened (1)\n- Latitude 28 punch list\n  M1001 · BH Management Latitude · scheduled tomorrow · link sent, not opened yet\n  ' + LINK,
      'Crew links expiring soon (1)\n- Second job punch\n  M1002 · Pines · link to Jose expires Fri Sep 18\n  ' + L2,
      'Suggestions waiting over a day (1)\n- Latitude 28 punch list\n  M1001 · BH Management Latitude · 1 suggestion from the crew\n  ' + LINK,
      'Open Service Tickets: https://project86.net/service-tickets',
      "You're receiving this because work orders you're on need attention. Toggle notifications in My Account → Notifications.",
    ].join('\n\n'));
    expect(m.html).toContain('color:#b91c1c;"> · over 2 business days');
    expect(m.html).toContain('>Open Service Tickets</a>');
    expect(m.push).toEqual({
      title: '🛠 Work orders need you',
      body: '1 work order with your buildings · 1 to approve · 1 problem flagged · 1 overdue · 1 link not opened · 1 link expiring · 1 suggestion waiting',
      url: 'https://project86.net/service-tickets',
      tag: 'work_order_digest',
    });
    expect(m.subject + m.text + m.html).not.toMatch(MONEY);
  });

  test('buildings assigned to you: the heading, the count, the day, the push fragment, and nothing priced', () => {
    const m = T.digestMessage({
      recipient: { name: 'Carl Crew' }, zone: 'America/New_York',
      sections: {
        your_buildings: [
          { ticket: TICKET, site: SITE, count: 1, nextDue: '2026-09-18' },
          { ticket: t2, jobLine: 'M1002 · Pines', count: 4, nextDue: null },
        ],
      },
    });
    // A crew lead with nothing but buildings still gets a digest, and no
    // "[N to approve]" prefix: the subject keys on approvals alone.
    expect(m.subject).toBe('Work orders needing you today (2)');
    expect(m.text).toContain('Buildings assigned to you (2)');
    expect(m.text).toContain('M1001 · BH Management Latitude · 1 building still open · next due Fri Sep 18');
    // No due date on any of them: the count alone, never "next due " with nothing after it.
    expect(m.text).toContain('M1002 · Pines · 4 buildings still open\n');
    expect(m.text).not.toContain('next due \n');
    expect(m.html).toContain('Buildings assigned to you (2)');
    expect(m.html).toContain('4 buildings still open');
    expect(m.push.body).toBe('2 work orders with your buildings');
    // The widening is the job line and the title, and stops there.
    expect(m.subject + m.text + m.html).not.toMatch(MONEY);
    expect(m.subject + m.text + m.html).not.toMatch(/[$£€]\s?\d|\b\d+\.\d{2}\b/);
  });

  test('no approvals: no prefix; one ticket reads singular; no link sent', () => {
    const m = T.digestMessage({
      recipient: {}, sections: { unopened: [{ ticket: TICKET, site: SITE, when: 'today', linkSent: false }] },
    });
    expect(m.subject).toBe('Work orders needing you today (1)');
    expect(m.text.startsWith('Good morning\n\n1 work order needs your attention.')).toBe(true);
    expect(m.text).toContain('scheduled today · no crew link sent');
    expect(m.push.body).toBe('1 link not opened');
  });

  test('waiting reminder exact wording', () => {
    const m = T.waitingReminderMessage({
      recipient: { name: 'Paula PM' }, overDays: 2,
      items: [{ ticket: TICKET, site: SITE, businessDays: 3 }, { ticket: t2, jobLine: 'M1002 · Pines', businessDays: 4 }],
    });
    expect(m.subject).toBe('Still waiting for approval: 2 work orders');
    expect(m.text).toContain('These work orders have waited more than 2 business days:\n- Latitude 28 punch list\n  M1001 · BH Management Latitude · waiting 3 business days\n  ' + LINK);
    expect(m.html).toContain('Still waiting for approval');
    expect(m.push).toEqual({
      title: '⏳ Still waiting for approval',
      body: '2 work orders have waited more than 2 business days.',
      url: 'https://project86.net/service-tickets',
      tag: 'ticket_waiting',
    });
    const one = T.waitingReminderMessage({ items: [{ ticket: TICKET, site: SITE, businessDays: 3 }], overDays: 1 });
    expect(one.subject).toBe('Still waiting for approval: 1 work order');
    expect(one.push.body).toBe('1 work order has waited more than 1 business day.');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SETTINGS ROW DESCRIBES WHAT THE DIGEST ACTUALLY SENDS.
 *
 * server/notify-events.js work_order_digest carries an EXHAUSTIVE trigger list
 * ("only when a work order needs you: …"), and it is the row people land on to
 * turn the digest off — the 1.33 release note sends them there by name. When
 * DIGEST_SECTIONS gained `your_buildings`, the digest started reaching people
 * it had never reached (a crew lead on none of the other six, holding no job
 * grant), and the row they land on still listed six things.
 *
 * So: every key in DIGEST_SECTIONS must be named in that sentence, and the map
 * below must cover exactly those keys — a new section with no phrase fails
 * here, in the file that added it, instead of shipping a description of
 * something other than what people receive.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the work_order_digest settings description', () => {
  // DIGEST_SECTIONS is module-private (it is render order, not API), so its
  // keys are read from the source rather than re-typed here.
  const digestSectionKeys = () => {
    const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('const DIGEST_SECTIONS = Object.freeze([');
    expect(a).toBeGreaterThan(-1);
    const block = src.slice(a, src.indexOf(']);', a));
    return (block.match(/key: '([a-z_]+)'/g) || []).map((s) => s.slice(6, -1));
  };

  // What each section's trigger is CALLED in the settings sentence. Plain
  // words, because the sentence is read by the person deciding whether to
  // keep the email — not by a developer.
  const PHRASES = {
    your_buildings: 'a building on it assigned to you and still open',
    approvals: 'waiting for your approval',
    flags: 'flagged problems waiting',
    overdue: 'overdue',
    unopened: 'scheduled today or tomorrow with the crew link not opened',
    expiring: 'a crew link about to expire',
    suggestions: 'suggestions',
  };

  const descOf = (key) => {
    const { NOTIFY_EVENTS } = require('../server/notify-events');
    const row = NOTIFY_EVENTS.find((e) => e.key === key);
    expect(row).toBeDefined();
    return row.desc;
  };

  test('the phrase map covers exactly the sections the digest renders', () => {
    expect(digestSectionKeys().slice().sort()).toEqual(Object.keys(PHRASES).sort());
  });

  test('every section the digest can hold is named in the settings row', () => {
    const desc = descOf('work_order_digest');
    for (const key of digestSectionKeys()) {
      expect([key, desc]).toEqual([key, expect.stringContaining(PHRASES[key])]);
    }
  });

  test("MUTANT: drop the buildings phrase and the row describes something the digest isn't", () => {
    const desc = descOf('work_order_digest').replace(PHRASES.your_buildings + ', ', '');
    expect(desc).not.toContain(PHRASES.your_buildings);
    // Red exactly where 1.33 was: six of the seven still named.
    const named = digestSectionKeys().filter((k) => desc.indexOf(PHRASES[k]) !== -1);
    expect(named).not.toContain('your_buildings');
    expect(named).toHaveLength(digestSectionKeys().length - 1);
  });
});

describe('the builders read no money', () => {
  test('no builder source mentions a money field', () => {
    const src = fs.readFileSync(REAL, 'utf8');
    const body = src.slice(src.indexOf('const tz = require'));
    expect(body).not.toMatch(/\.(price|cost|total_cost|unitCost|contract\w*|amount|scope_approved|internal_notes|guest_log|crew_takeoff|materials)\b/);
  });
});

describe('mutants', () => {
  test('MUTANT: stop treating a domain as a link and "p86-review.com" reaches the office verbatim', () => {
    const mod = mutant('  return DOMAIN_RUN_RE.test(w);', '  return false;');
    expect(mod.crewText('go to p86-review.com today', 500)).toBe('go to p86-review.com today');
  });

  test('MUTANT: go back to a domain only before / : ? # or the end and "agx-portal.com\'s" reaches the office verbatim', () => {
    const mod = mutant('const DOMAIN_RUN_RE = /\\.\\p{L}{2,}(?![\\p{L}\\p{N}])/u;', 'const DOMAIN_RUN_RE = /\\.\\p{L}{2,}(?:[/:?#]|$)/u;');
    expect(mod.crewText("log in at agx-portal.com's page", 500)).toBe("log in at agx-portal.com's page");
    expect(mod.crewText('pay.example.com&ref=1', 500)).toBe('pay.example.com&ref=1');
    expect(T.crewText("log in at agx-portal.com's page", 500)).toBe('log in at [link removed] page');
  });

  test('MUTANT: keep invisible characters and a zero-width space hides "evil.com"', () => {
    const typed = 'evil.c' + String.fromCodePoint(0x200B) + 'om ok';
    const mod = mutant("  text = text.replace(INVISIBLE_RE, '');\n", '');
    expect(mod.crewText(typed, 500)).toBe(typed);
    expect(T.crewText(typed, 500)).toBe('[link removed] ok');
  });

  test('MUTANT: every move to In progress is "Started work" and a crew undo is misreported', () => {
    const mod = mutant("return e.detail.from !== 'work_complete' && e.detail.reason !== 'crew_undid_finish'; })) lines.push('Started work');",
      "return true; })) lines.push('Started work');");
    const undo = [{ kind: 'status_changed', actor_kind: 'share', detail: { from: 'work_complete', to: 'in_progress', reason: 'crew_undid_finish' } }];
    expect(mod.crewActivitySummary(undo, {}).lines).toContain('Started work');
    expect(T.crewActivitySummary(undo, {}).lines).not.toContain('Started work');
  });

  test('MUTANT: count weekends and a Friday finish is "over 2 business days" by Sunday', () => {
    const mod = mutant('    if (wd !== 0 && wd !== 6) count++;', '    count++;');
    expect(mod.businessDaysSince('2026-09-11T20:55:00Z', '2026-09-13T15:00:00Z', 'America/New_York')).toBe(2);
    expect(T.businessDaysSince('2026-09-11T20:55:00Z', '2026-09-13T15:00:00Z', 'America/New_York')).toBe(0);
  });

  test('MUTANT: drop the clamp and 99 business days is honoured', () => {
    const mod = mutant('  return Math.min(10, Math.max(1, Math.floor(n)));', '  return Math.floor(n);');
    expect(mod.reminderBusinessDays({ work_orders: { approval_reminder_business_days: 99 } })).toBe(99);
  });

  test('MUTANT: forget the scheme rule and tel: links survive', () => {
    const mod = mutant('  if (LINK_SCHEME_RE.test(w)) return true;\n', '');
    expect(mod.crewText('call tel:+14075550100', 500)).toBe('call tel:+14075550100');
  });
});
