// test/work-order-responsibility-release.test.js — release 1.37 is cut, and
// every claim its note makes is a thing the code actually does.
//
// THE OWNER, 2026-09-20, overriding every earlier answer on the subject:
// "i dont want assignments to individual buildings like that, whoever is
// assigned to the ticket, task or work order is evenly responsible."
//
// 1.34 shipped five surfaces keyed on a BUILDING's own assignee_user_id — a
// column no screen has ever offered to set — so on an ordinary job they
// answered nothing, while the Assigned to the office really does set fed none
// of them. 1.37 moves responsibility onto the RECORD: the work order's own
// Assigned to, everyone on it equally responsible for every building on its
// punch list, and a building that can no longer be assigned from any door.
//
// WHY THIS FILE EXISTS. A release note is the one artefact nobody tests and
// everybody reads, and this one makes four checkable promises. So every test
// below is a CROSS-CHECK — the note's own sentence on one side, the shipped
// function on the other — and where a check could pass by matching nothing,
// a mutant beside it must fail. It deliberately does not restate the unit
// suites: the door, the route, the refusals and the digest are proved in
// test/work-order-building-responsibility.test.js, test/work-order-my-
// buildings-door.test.js, test/work-order-task-doors.test.js and
// test/work-order-attention.test.js. What is proved HERE is that the note and
// those suites are describing the same app.
'use strict';

const catalog = require('../server/feature-catalog.js');
const subtaskDoor = require('../server/services/service-ticket-subtask-door.js');
const notifyText = require('../server/services/work-order-notify-text.js');
const dispatcher = require('../server/services/payload-dispatcher.js');

const VERSION = '1.37';
const RANK = { new: 0, improved: 1, fixed: 2 };

const rel = () => catalog.releases.find((r) => r.version === VERSION);
const rowsOf = (r) => (r.changes || []).map((c) => c.text);
const allText = (r) => [r.name, r.summary].concat(rowsOf(r)).join('\n');

// The same shape rules test/work-orders-1-34-release.test.js applies to 1.34,
// restated here rather than imported: that file is a suite, and requiring it
// would run it a second time inside this one.
function releaseProblems(r) {
  const out = [];
  if (!r) return ['no release'];
  if (!/^\d+\.\d+$/.test(String(r.version))) out.push('bad version ' + r.version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) out.push('bad date ' + r.date);
  for (const k of ['name', 'summary']) {
    if (typeof r[k] !== 'string' || !r[k].trim()) out.push('a release with no ' + k);
  }
  const changes = r.changes || [];
  if (!changes.length) out.push('a release with no changes');
  let last = -1;
  changes.forEach((ch) => {
    if (!(ch.type in RANK)) out.push('unknown change type ' + ch.type);
    else if (RANK[ch.type] < last) out.push('rows are not grouped new, improved, fixed');
    else last = RANK[ch.type];
    if (typeof ch.text !== 'string' || !ch.text.trim()) out.push('a row with no text');
  });
  return out;
}

// THE THREE SPELLINGS THAT MEAN "a person owns this building". The office and
// My Day suites scan rendered HTML for exactly these; the note is read by the
// same crews, so it is held to the same words.
const OWNED = [/your\s+buildings?/i, /my\s+buildings?/i, /buildings?\s+(?:is|are)?\s*assigned/i];
const hits = (text) => OWNED.filter((re) => re.test(text)).map(String);

// ── 1. the release is cut ─────────────────────────────────────────────────
describe('release ' + VERSION + ' is cut', () => {
  test('APP_VERSION and the newest release are both ' + VERSION + ', dated the day the owner said it', () => {
    expect(catalog.APP_VERSION).toBe(VERSION);
    expect(catalog.releases[0].version).toBe(VERSION);
    expect(catalog.releases[0].date).toBe('2026-09-20');
    // It corrects 1.34 rather than replacing it. Other branches shipped 1.35
    // and 1.36 the same day, so 1.34 is below this entry but not adjacent to
    // it — what must hold is that both are in the list, newest first.
    const at = catalog.releases.findIndex((r) => r.version === '1.34');
    expect(at).toBeGreaterThan(0);
  });

  test('mutant: APP_VERSION left on 1.34, or the entry filed below it, is caught', () => {
    const stale = Object.assign({}, catalog, { APP_VERSION: '1.34' });
    expect(() => { expect(stale.APP_VERSION).toBe(stale.releases[0].version); }).toThrow();
    // And filed in the wrong place: a note under the release it corrects.
    const below = [catalog.releases[1], catalog.releases[0]].concat(catalog.releases.slice(2));
    expect(below[0].version).not.toBe(VERSION);
  });

  test('its rows are grouped new, improved, fixed, and every row has text', () => {
    expect(releaseProblems(rel())).toEqual([]);
    // Not vacuous: it really does carry rows, and they really are typed.
    expect(rel().changes.length).toBeGreaterThan(3);
    expect(new Set(rel().changes.map((c) => c.type))).toEqual(new Set(['improved', 'fixed']));
  });

  test('mutant: rows out of group, and a row with no text, are caught', () => {
    const r = rel();
    const reversed = Object.assign({}, r, { changes: r.changes.slice().reverse() });
    expect(releaseProblems(reversed)).toEqual(
      expect.arrayContaining(['rows are not grouped new, improved, fixed']),
    );
    const blank = Object.assign({}, r, { changes: r.changes.concat([{ type: 'fixed', text: '  ' }]) });
    expect(releaseProblems(blank)).toEqual(expect.arrayContaining(['a row with no text']));
  });

  test('no dollar figure, price or rate appears anywhere in it', () => {
    // The note reaches crews, who are never shown money on these surfaces.
    expect(allText(rel())).not.toMatch(/[$£€]\s?\d|\b\d+\.\d{2}\b/);
    expect('a $40 fee and a 1.25 rate').toMatch(/[$£€]\s?\d|\b\d+\.\d{2}\b/);
  });
});

// ── 2. the note's claims are the code's behaviour ─────────────────────────
describe('what the ' + VERSION + ' note promises is what the code does', () => {
  test('"never assigned to one person" — the door refuses, always, and says the same sentence', () => {
    const text = allText(rel());
    expect(text).toMatch(/never assigned to one person/i);
    expect(text).toMatch(/Assigned to/);

    // The shipped door, with no arguments and no database.
    const v = subtaskDoor.assignVerdict();
    expect(v.ok).toBe(false);
    expect(v.status).toBe(409);
    expect(v.code).toBe('building_not_assignable');
    expect(v.error).toBe(subtaskDoor.MSG.notAssignable);
    // The note and the refusal are the same rule in the same words.
    expect(subtaskDoor.MSG.notAssignable).toMatch(/never assigned to one person/i);
    expect(subtaskDoor.MSG.notAssignable).toMatch(/equally responsible for every building/i);

    // "Wherever it comes from": a caller still passing the old arguments is
    // refused identically, so no door can accidentally opt out of the rule.
    const old = subtaskDoor.assignVerdict({}, { user: { id: 7 }, orgId: 1, ticket: { id: 's1' } });
    expect(old).toEqual(v);
  });

  test('"lists the work orders assigned to you" — the door is keyed on the RECORD', () => {
    const sql = subtaskDoor.myOpenBuildingSql('t', '$2');
    // The caller is matched on the work order…
    expect(sql).toContain('t.assignee_user_id = $2');
    // …and never on a building of its own.
    expect(sql).not.toMatch(/wob\.assignee_user_id/);
    // The building arm is still there, and still org-pinned and still live —
    // "assigned to you AND still has a building open", not "assigned to you".
    expect(sql).toContain('wob.organization_id = t.organization_id');
    expect(sql).toContain("wob.status <> 'done'");
  });

  test('mutant: the 1.34 predicate fails both halves of that check', () => {
    // What shipped in 1.34, which is what the note says was wrong: the EXISTS
    // arm keyed on the BUILDING's own assignee and nothing keyed on the ticket.
    const shipped134 = "EXISTS (SELECT 1 FROM tasks wob WHERE wob.service_ticket_id = t.id"
      + " AND wob.organization_id = t.organization_id AND wob.archived_at IS NULL"
      + " AND wob.scope = 'org' AND wob.status <> 'done' AND wob.assignee_user_id = $2)";
    expect(shipped134).not.toContain('t.assignee_user_id = $2');
    expect(shipped134).toMatch(/wob\.assignee_user_id/);
  });

  test('the digest heading the note QUOTES is the heading the digest renders', () => {
    const row = rowsOf(rel()).find((t) => /digest/i.test(t) && /\u201c/.test(t));
    expect(row).toBeTruthy();
    const quoted = /\u201c([^\u201d]+)\u201d/.exec(row)[1];
    // Not a tautology: the note is quoting a real section heading, so the
    // quote has to be long enough to be one.
    expect(quoted.length).toBeGreaterThan(20);

    const msg = notifyText.digestMessage({
      recipient: { name: 'Carl Reyes' },
      sections: { your_buildings: [{
        ticket: { id: 's1', ticket_number: 'M1002', title: 'Pines' },
        jobLine: 'M1002 · Pines', count: 3, nextDue: '2026-09-21',
      }] },
    });
    expect(msg.text).toContain(quoted);
    expect(msg.html).toContain(quoted);
    // And the digest itself owns no building. Same three spellings the office
    // screens are scanned for.
    expect(hits(msg.text + msg.html + msg.push.body)).toEqual([]);
    // Not vacuous: the 1.34 heading these replaced would be caught.
    expect(hits('Buildings assigned to you (2)').length).toBeGreaterThan(0);
  });

  test('"including from 86" — the payload is refused by name, before the unknown-key sweep', () => {
    expect(allText(rel())).toMatch(/\b86\b/);

    let err = null;
    try {
      dispatcher.validateOps('service_ticket', {
        fields: { title: 'WO', job_id: 'j1' },
        task_adds: [{ title: 'Building 4', assignee_user_id: 9 }],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(dispatcher.PayloadValidationError);
    expect(err.detail).toMatchObject({
      code: 'building_not_assignable',
      field_path: 'service_ticket.ops.task_adds[0].assignee_user_id',
      retryable: false,
    });
    // "nothing is saved and nothing half-lands" — this is emit-time, so no
    // client, no transaction and no row was ever asked for.
    expect(err.message).toContain(subtaskDoor.MSG.notAssignable);

    // BY NAME, NOT BY SWEEP: a genuine typo still answers 'unknown_field', so
    // the refusal above is the rule being stated rather than a key falling off
    // the whitelist.
    let typo = null;
    try {
      dispatcher.validateOps('service_ticket', {
        fields: { title: 'WO', job_id: 'j1' },
        task_adds: [{ title: 'Building 4', assignee_usr_id: 9 }],
      });
    } catch (e) { typo = e; }
    expect(typo.detail.code).toBe('unknown_field');
  });

  test('"set the work order\'s Assigned to instead" is a thing 86 can actually do', () => {
    // The note sends the reader somewhere. If that door were shut too, the
    // sentence would be advice that cannot be taken — so it is exercised.
    expect(() => dispatcher.validateOps('service_ticket', {
      fields: { title: 'WO', job_id: 'j1', assignee_user_id: 9 },
      task_adds: [{ title: 'Building 4' }],
    })).not.toThrow();
  });
});

// ── 3. the rule binds what ships FROM HERE, not what already shipped ────
//
// The scan below is scoped to the release being cut, on purpose. A patch note
// is dated: it says what a version did. 1.34 really did put the person on the
// building, so rewriting its entry to describe THIS release’s behaviour made
// the Help center contradict itself on one screen — two notes dated the same
// day, the older one claiming to have shipped what the newer one is billed as
// fixing. So history stays, the entry being cut is held to the rule, and 1.37
// carries the explanation in its own rows.
describe('the catalog says a building belongs to nobody from here on', () => {
  test('the release being cut claims no per-building owner', () => {
    expect(hits(allText(rel()))).toEqual([]);
    // Not vacuous: the same scan over the sentence it replaced does fire…
    expect(hits('A new Buildings assigned to you section says how many of yours are open.').length)
      .toBeGreaterThan(0);
    // …and the sentence that replaced it is clean, so the scan is not simply
    // rejecting any sentence with the word "assigned" in it.
    expect(hits('every one of them following who the work order is assigned to'
      + ' rather than who can open the job.')).toEqual([]);
  });

  test('every feature blurb is held to it too — those describe the app as it is now', () => {
    const dirty = (catalog.features || [])
      .filter((f) => hits([f.label, f.blurb, f.access_path].join('\n')).length);
    expect(dirty.map((f) => f.id)).toEqual([]);
    expect((catalog.features || []).length).toBeGreaterThan(10);
  });

  test('1.34 is exempt BECAUSE it is history, and it still reads as history', () => {
    const r134 = catalog.releases.find((r) => r.version === '1.34');
    // The exemption is not theoretical: the shipped entry does carry the old
    // spellings. Scoping the scan to the newest entry is the decision, not an
    // oversight, and this is the line that says so out loud.
    expect(hits(allText(r134)).length).toBeGreaterThan(0);
    // And what is under the scan is the newest entry, not merely some entry.
    expect(rel()).toBe(catalog.releases[0]);
  });

  test(VERSION + ' says in its own rows why the note below it disagrees', () => {
    const row = rowsOf(rel()).find((t) => /directly below/i.test(t) && /shipped/i.test(t));
    expect(row).toBeTruthy();
    expect(row).toMatch(/left exactly as it was written/i);
    expect(row).toMatch(/quietly rewritten/i);
    // Mutant: a row that merely contradicts the older entry, without telling
    // the reader that entry is the record, does not satisfy it.
    const bare = ['My work now lists the work orders assigned to you.'];
    expect(bare.filter((t) => /directly below/i.test(t) && /shipped/i.test(t))).toEqual([]);
  });
});
