// THE PRINTABLES FOR A WORK ORDER — WHAT THEY MAY SAY, PURE.
//
// server/services/service-ticket-print.js builds two documents on the server:
//   * the paper work order a crew or sub works from, and
//   * the completion report sent to a property manager (the report share
//     portal's document shape).
// Both go outside the office, so the property that matters is NO MONEY:
// scope_approved (where a priced, signed-off scope lands), internal_notes,
// guest_log and crew_takeoff are never on either, materials carry quantity,
// unit and material only, and the report's layouts are only the ones
// js/report-document.js already renders.
//
// Each rule is driven through the real builders, then a copy of the module
// with the rule removed is shown to fail the same assertion.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVICES = path.join(__dirname, '..', 'server', 'services');
const PRINT = path.join(SERVICES, 'service-ticket-print.js');
const print = require(PRINT);

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* gone */ } }
});

function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

// A copy of the print module with ONE change. The anchor must occur exactly
// once in the CRLF-normalised source.
function mutant(anchor, replacement) {
  const src = fs.readFileSync(PRINT, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  const out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-st-print-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'service-ticket-print.js');
  fs.writeFileSync(p, absolutizeRequires(out, SERVICES), 'utf8');
  return require(p);
}

const POISON = ['4,500', '900', 'do not tell crew', 'scope_approved', 'internal_notes', 'crew_takeoff', 'SECRET-LOG', 'unitCost', '$12.50'];

function poisonTicket(extra) {
  return Object.assign({
    id: 'st_1',
    organization_id: 1,
    ticket_number: 'WO-1001',
    title: 'Latitude 28 stair repairs',
    job_id: 'j1',
    status: 'in_progress',
    priority: 'high',
    scope_proposed: 'Replace rotten treads and rail posts on the listed buildings.',
    scope_approved: 'Approved at $4,500',
    internal_notes: 'PM approved extra $900 — do not tell crew',
    guest_log: '\n\n— SECRET-LOG (via shared link): hello',
    crew_takeoff: { copy: { lines: [{ description: 'PT 2x12', qty: 4, unitCost: 12.5, total: '$12.50' }] } },
    requested_by: 'Owner Olga',
    checklist: [{ text: 'Photos before and after', done: true }, { text: 'Haul debris', done: false }],
    materials: [
      { description: 'PT 2x12 x 16', qty: 4, unit: 'ea', unitCost: 12.5, total: 50, supplier: 'Lumber Co' },
      { description: 'Rail post', qty: '2', unit: 'ea', price: 900 },
    ],
    site_contact_name: 'Sam Super',
    site_contact_phone: '555-0101',
    scheduled_for: '2026-09-18',
    due_date: '2026-09-20',
    assignee_user_id: 11,
    created_by: 10,
    completed_at: null,
  }, extra || {});
}

const SITE = { kind: 'job', job_number: 'M1001', name: 'BH Latitude 28', address: '1 Main St, Orlando, FL', gate_code: '#4321', lat: 1, lng: 2 };
const TASKS = [
  { id: 'k1', title: 'Bldg 784 — Side A: rail post; tread 3 · Side D: stringer', status: 'done' },
  { id: 'k2', title: 'Bldg 12', status: 'open' },
];

function workOrderDoc(ticketExtra, printModule) {
  return (printModule || print).buildWorkOrderPrint({
    ticket: poisonTicket(ticketExtra),
    site: SITE,
    contact: { name: 'Paula PM', phone: '555-0199', id: 11 },
    tasks: TASKS,
    orgName: 'AG Exteriors',
    tz: 'America/New_York',
    now: new Date('2026-09-15T19:10:00Z'),
  });
}

describe('buildWorkOrderPrint: the paper work order has no money on it', () => {
  test('its keys are exactly the committed whitelist', () => {
    const doc = workOrderDoc();
    expect(Object.keys(doc)).toEqual([
      'v', 'kind', 'org_name', 'ticket_number', 'title', 'status_label', 'priority_label',
      'scheduled_label', 'due_label', 'site', 'site_contact', 'office_contact', 'scope',
      'checklist', 'materials', 'buildings', 'money_mentions', 'printed_label',
    ]);
    expect(Object.keys(doc.site)).toEqual(['job_number', 'name', 'address', 'gate_code']);
    expect(doc.office_contact).toEqual({ name: 'Paula PM', phone: '555-0199' });
    expect(doc.site_contact).toEqual({ name: 'Sam Super', phone: '555-0101' });
    expect([doc.kind, doc.v, doc.status_label, doc.priority_label]).toEqual(['work_order', 1, 'In progress', 'High']);
  });

  test('the approved scope, internal notes, guest log and crew takeoff never reach it', () => {
    const json = JSON.stringify(workOrderDoc());
    for (const p of POISON) expect([p, json.indexOf(p)]).toEqual([p, -1]);
    expect(workOrderDoc().scope).toBe('Replace rotten treads and rail posts on the listed buildings.');
    expect(json).not.toContain('Owner Olga');
    expect(json).not.toContain('"st_1"');
  });

  test('with no proposed scope the scope is empty, never the approved one', () => {
    const doc = workOrderDoc({ scope_proposed: '' });
    expect(doc.scope).toBe('');
    expect(JSON.stringify(doc)).not.toContain('4,500');
  });

  test('materials are description, quantity and unit only, even when rows carry prices', () => {
    const doc = workOrderDoc();
    expect(doc.materials).toEqual([
      { description: 'PT 2x12 x 16', qty: '4', unit: 'ea' },
      { description: 'Rail post', qty: '2', unit: 'ea' },
    ]);
    // A driver that hands the jsonb back as text is read the same way.
    const asText = workOrderDoc({ materials: JSON.stringify(poisonTicket().materials), checklist: JSON.stringify(poisonTicket().checklist) });
    expect(asText.materials).toEqual(doc.materials);
    expect(asText.checklist).toEqual([{ text: 'Photos before and after', done: true }, { text: 'Haul debris', done: false }]);
  });

  test('each building is parsed into its head and sides, with its done flag', () => {
    expect(workOrderDoc().buildings).toEqual([
      { head: 'Bldg 784', sides: [{ label: 'Side A', items: ['rail post', 'tread 3'] }, { label: 'Side D', items: ['stringer'] }], done: true },
      { head: 'Bldg 12', sides: [], done: false },
    ]);
  });

  test('calendar days are not shifted into a zone; the printed stamp is in the org zone', () => {
    const doc = workOrderDoc();
    expect(doc.due_label).toBe('Sep 20, 2026');
    expect(doc.scheduled_label).toBe('Sep 18, 2026');
    // node-postgres hands a DATE back as local midnight.
    expect(print.calendarDayLabel(new Date(2026, 8, 20))).toBe('Sep 20, 2026');
    expect(doc.printed_label).toMatch(/^Sep 15, 2026 at 3:10\sPM$/);
  });

  test('money_mentions names a scope that mentions a dollar amount, and nothing when none does', () => {
    expect(workOrderDoc().money_mentions).toEqual([]);
    expect(workOrderDoc({ scope_proposed: 'Replace 3 treads, about $300 of wood' }).money_mentions).toEqual(['Scope of work']);
    expect(print.moneyMentions([{ label: 'A', text: '40 dollars' }, { label: 'B', text: 'Bldg 784' }, { label: 'C', text: ['x', '$ 5'] }])).toEqual(['A', 'C']);
  });

  test('MUTANT: a builder that appends internal notes to the scope fails the poison assertion', () => {
    const mut = mutant(
      "const scope = nonBlank(t.scope_proposed) ? String(t.scope_proposed) : '';\n  const checklist = checklistOf(t);",
      "const scope = (nonBlank(t.scope_proposed) ? String(t.scope_proposed) : '') + String(t.internal_notes);\n  const checklist = checklistOf(t);");
    const json = JSON.stringify(workOrderDoc(null, mut));
    expect(json).toContain('do not tell crew');
    expect(json).toContain('900');
  });

  test('MUTANT: materials read raw instead of through normalizeMaterials carry the price', () => {
    const mut = mutant('const materials = materialsOf(t);', 'const materials = parseJson(t.materials, []);');
    expect(JSON.stringify(workOrderDoc(null, mut))).toContain('unitCost');
  });
});

// ── the completion report ────────────────────────────────────────────────

const REPORT_LAYOUTS = ['text-block', 'photo-grid', 'single-photo', 'attachment-list', 'photo-map'];

function photo(id, taskId, tags, extra) {
  return Object.assign({
    id, entity_id: taskId, filename: id + '.jpg', mime_type: 'image/jpeg',
    thumb_url: 'https://cdn.test/' + id + '_t.jpg', web_url: 'https://cdn.test/' + id + '_w.jpg',
    caption: null, annotations: null, lat: null, lng: null, tags: JSON.stringify(tags || []),
    shot_at: '2026-09-10 14:00:00', uploaded_by: 99, uploader_name: 'Office Olly',
  }, extra || {});
}

function reportInput(extra) {
  const activity = new Map();
  activity.set('k1', {
    notes: [{ note: 'Found more rot, see https://evil.example/pay', by: 'Jose https://evil.example', at: '2026-09-11 15:00:00' }],
    completed_by: 'Jose https://evil.example',
    completed_at: '2026-09-12 18:30:00',
  });
  activity.set('k2', { notes: [], completed_by: null, completed_at: null });
  activity.set('k3', { notes: [{ note: 'Gate was locked', by: 'Shared link', at: '2026-09-12 12:00:00' }], completed_by: 'Maria', completed_at: '2026-09-13 16:00:00' });
  return Object.assign({
    ticket: poisonTicket({ status: 'approved', completed_at: '2026-09-13 16:05:00' }),
    site: SITE,
    tasks: [
      { id: 'k1', title: 'Bldg 784 — Side A: rail post', status: 'done' },
      { id: 'k2', title: 'Bldg 12', status: 'open' },
      { id: 'k3', title: 'Bldg 14', status: 'done' },
    ],
    photoRows: [
      photo('a_c1', 'k1', [], { caption: 'Post set' }),
      photo('a_b1', 'k1', ['before']),
      photo('a_c3', 'k3', ['after']),
      photo('a_b2', 'k2', ['before']),
    ],
    activity,
    approval: { name: 'Paula PM', at: '2026-09-15T19:10:00Z' },
    orgName: 'AG Exteriors',
    tz: 'America/New_York',
    includeNotes: true,
    preparedBy: 'Wendy Wide',
    now: new Date('2026-09-16T12:00:00Z'),
  }, extra || {});
}

describe('buildCompletionReport: the property manager’s report', () => {
  test('sections run scope, then each building in created order, then approval — only renderable layouts', () => {
    const { document } = print.buildCompletionReport(reportInput());
    expect(document.sections.map((s) => s.label.replace(/\s·\s.*$/, ''))).toEqual([
      'Scope of work',
      'Bldg 784 — finished by Jose',
      'Bldg 784 — crew notes',
      'Bldg 12 — not finished',
      'Bldg 14 — finished by Maria',
      'Bldg 14 — crew notes',
      'Approval',
    ]);
    for (const s of document.sections) expect(REPORT_LAYOUTS).toContain(s.layout);
    expect(document.sections[1].photoSize).toBe('medium');
    expect([document.template_type, document.style_pack]).toEqual(['punch-list', 'clean']);
    expect(document.sections[0].text_body).toBe('Replace rotten treads and rail posts on the listed buildings.');
  });

  test('before photos come first, then completion photos, captioned', () => {
    const { document } = print.buildCompletionReport(reportInput());
    const bldg = document.sections[1];
    expect(bldg.photos.map((p) => [p.id, p.caption])).toEqual([['a_b1', 'Before'], ['a_c1', 'Completion — Post set']]);
    expect(bldg.label).toMatch(/^Bldg 784 — finished by Jose · Sep 12, 2026 at 2:30\sPM$/);
  });

  test('a crew name that carries a link prints as the name alone; crew notes lose their links', () => {
    const { document } = print.buildCompletionReport(reportInput());
    const json = JSON.stringify(document);
    expect(json).not.toContain('evil.example');
    expect(document.sections[2].text_body).toMatch(/^Jose · Sep 11, 2026 at 11:00\sAM: Found more rot, see \[link removed\]$/);
    expect(document.sections[5].text_body).toMatch(/^Crew · .*: Gate was locked$/);
    expect(document.cover_page.crew).toBe('Jose, Maria');
  });

  test('the approved scope and internal notes are never on it; photos carry no uploader', () => {
    const json = JSON.stringify(print.buildCompletionReport(reportInput()));
    for (const p of POISON) expect([p, json.indexOf(p)]).toEqual([p, -1]);
    expect(json).not.toContain('uploaded_by');
    expect(json).not.toContain('Office Olly');
    // No proposed scope: no scope section at all, never the approved one.
    const bare = print.buildCompletionReport(reportInput({ ticket: poisonTicket({ status: 'approved', scope_proposed: null }) }));
    expect(bare.document.sections[0].label).not.toMatch(/scope/i);
    expect(JSON.stringify(bare)).not.toContain('4,500');
  });

  test('include notes off emits no notes sections', () => {
    const { document, summary } = print.buildCompletionReport(reportInput({ includeNotes: false }));
    expect(document.sections.filter((s) => /crew notes/.test(s.label))).toEqual([]);
    expect(summary.notes_included).toBe(false);
  });

  test('approved: the approval section, cover and summary say who and when', () => {
    const { document, summary } = print.buildCompletionReport(reportInput());
    const approval = document.sections[document.sections.length - 1];
    expect(approval.text_body).toMatch(/^Approved by Paula PM on Sep 15, 2026 at 3:10\sPM\.\nWork completed Sep 13, 2026 at 12:05\sPM\.$/);
    expect(document.cover_page.subtitle).toBe('Work order WO-1001');
    expect(document.cover_page.date).toBe('Sep 15, 2026');
    expect(document.cover_page.pm_name).toBe('Wendy Wide');
    expect(summary.sendable).toBe(true);
    expect(summary.approved.name).toBe('Paula PM');
    expect(summary.approved.at_label).toMatch(/^Sep 15, 2026 at 3:10\sPM$/);
  });

  test('not approved: a draft cover, "Not approved yet." and not sendable', () => {
    const { document, summary } = print.buildCompletionReport(reportInput({
      ticket: poisonTicket({ status: 'work_complete' }),
    }));
    expect(document.cover_page.subtitle).toBe('Work order WO-1001 — Draft, not approved yet');
    expect(document.sections[document.sections.length - 1].text_body).toBe('Not approved yet.');
    expect(document.cover_page.date).toBe('Sep 16, 2026');
    expect([summary.sendable, summary.approved]).toEqual([false, null]);
  });

  test('summary counts buildings and photos and names the buildings with no completion photo', () => {
    const { document, summary } = print.buildCompletionReport(reportInput());
    expect(summary).toMatchObject({
      buildings_total: 3, buildings_done: 2, before_photos: 2, completion_photos: 2,
      missing_completion: ['Bldg 12'], money_mentions: [], notes_included: true,
    });
    expect(document.summary).toBe('2 of 3 buildings finished · 2 completion photos');
    expect(document.project_name).toBe('M1001 · BH Latitude 28');
    expect(document.project_address).toBe('1 Main St, Orlando, FL');
  });

  test('money in a crew note or a caption is named in money_mentions', () => {
    const input = reportInput();
    input.activity.get('k3').notes.push({ note: 'Extra board was $40', by: 'Maria', at: '2026-09-12 13:00:00' });
    const { summary } = print.buildCompletionReport(input);
    expect(summary.money_mentions).toEqual(['Bldg 14 — crew notes']);
  });

  test('the document is the report portal’s clamped shape (buildDocument ran)', () => {
    const { document } = print.buildCompletionReport(reportInput());
    expect(Object.keys(document).sort()).toEqual(['built_at', 'cover_page', 'org_name', 'project_address', 'project_name', 'sections', 'style_pack', 'summary', 'template_type', 'title', 'v'].sort());
    expect(document.title).toBe('Completion report — Latitude 28 stair repairs');
    const p = document.sections[1].photos[0];
    expect(Object.keys(p).sort()).toEqual(['annotations', 'caption', 'filename', 'id', 'lat', 'lng', 'mime_type', 'num', 'shot_at', 'thumb_url', 'web_url'].sort());
    expect(p.num).toBe(1);
  });

  test('MUTANT: a report that prints the approved scope fails the poison assertion', () => {
    const mut = mutant(
      "const scope = nonBlank(t.scope_proposed) ? String(t.scope_proposed) : '';\n  if (scope) {",
      "const scope = String(t.scope_approved || '');\n  if (scope) {");
    const json = JSON.stringify(mut.buildCompletionReport(reportInput()));
    expect(json).toContain('4,500');
  });

  test('MUTANT: finisher names not passed through crewName leak the link', () => {
    const mut = mutant('  return text.crewName(raw);', '  return raw;');
    expect(JSON.stringify(mut.buildCompletionReport(reportInput()))).toContain('evil.example');
  });

  test('a building finished from a crew link with no printable name is the crew’s, never the office’s', () => {
    const input = reportInput();
    input.activity.set('k1', { notes: [], completed_by: 'Shared link', completed_at: '2026-09-12 18:30:00' });
    input.activity.set('k3', { notes: [], completed_by: 'crew@x.test', completed_at: '2026-09-13 16:00:00', completed_via_share: true });
    let labels = print.buildCompletionReport(input).document.sections.map((s) => s.label.replace(/\s·\s.*$/, ''));
    expect(labels).toContain('Bldg 784 — finished by the crew');
    expect(labels).toContain('Bldg 14 — finished by the crew');
    expect(JSON.stringify(print.buildCompletionReport(input))).not.toContain('crew@x.test');

    // An email-like label with no share flag is still a crew link's label.
    input.activity.set('k3', { notes: [], completed_by: 'crew@x.test', completed_at: '2026-09-13 16:00:00' });
    labels = print.buildCompletionReport(input).document.sections.map((s) => s.label.replace(/\s·\s.*$/, ''));
    expect(labels).toContain('Bldg 14 — finished by the crew');

    // The office, unlabelled, is the office.
    input.activity.set('k3', { notes: [], completed_by: null, completed_at: '2026-09-13 16:00:00', completed_via_share: false });
    labels = print.buildCompletionReport(input).document.sections.map((s) => s.label.replace(/\s·\s.*$/, ''));
    expect(labels).toContain('Bldg 14 — finished by the office');
  });

  test('MUTANT: a fallback that ignores the crew link calls the crew "the office"', () => {
    const mut = mutant("  if (act.completed_via_share) return 'the crew';\n", '');
    const input = reportInput();
    input.activity.set('k3', { notes: [], completed_by: null, completed_at: '2026-09-13 16:00:00', completed_via_share: true });
    const labels = mut.buildCompletionReport(input).document.sections.map((s) => s.label.replace(/\s·\s.*$/, ''));
    expect(labels).toContain('Bldg 14 — finished by the office');
    const real = print.buildCompletionReport(input).document.sections.map((s) => s.label.replace(/\s·\s.*$/, ''));
    expect(real).toContain('Bldg 14 — finished by the crew');
  });
});

// ── the report's own read of the building events ─────────────────────────

describe('loadBuildingActivity: send-back reasons never reach the completion report', () => {
  const EVENTS = [
    { id: 'e1', kind: 'subtask_note', actor_kind: 'share', actor_label: 'Jose', detail: '{"task_id":"k1","note":"Tread 3 was split"}', created_at: '2026-09-11 15:00:00' },
    { id: 'e2', kind: 'subtask_completed', actor_kind: 'share', actor_label: 'Jose', detail: { task_id: 'k1' }, created_at: '2026-09-11 16:00:00' },
    { id: 'e3', kind: 'subtask_note', actor_kind: 'user', actor_label: 'Paula PM', detail: { task_id: 'k1', note: 'Rail is still loose, redo it - we will not pay for this twice', sent_back: true }, created_at: '2026-09-11 17:00:00' },
    { id: 'e4', kind: 'subtask_reopened', actor_kind: 'user', actor_label: 'Paula PM', detail: { task_id: 'k1' }, created_at: '2026-09-11 17:00:00' },
    { id: 'e5', kind: 'subtask_completed', actor_kind: 'share', actor_label: null, detail: { task_id: 'k1' }, created_at: '2026-09-12 18:30:00' },
    { id: 'e6', kind: 'subtask_note', actor_kind: 'user', actor_label: null, detail: { task_id: 'k3', note: 'Gate code changed' }, created_at: '2026-09-12 10:00:00' },
    { id: 'e7', kind: 'subtask_completed', actor_kind: 'user', actor_label: 'Wendy Wide', detail: { task_id: 'k3' }, created_at: '2026-09-13 16:00:00' },
  ];

  function fakeDb(rows) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => { calls.push([sql, params]); return { rows }; },
    };
  }

  async function loadWith(mod) {
    const db = fakeDb(EVENTS);
    const activity = await mod.loaders.loadBuildingActivity(db, 1, 'st_1');
    return { db, activity };
  }

  test('its one read carries the org predicate; a missing org reads nothing', async () => {
    const { db } = await loadWith(print);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0][0]).toMatch(/ticket_id = \$1 AND organization_id = \$2/);
    expect(db.calls[0][1]).toEqual(['st_1', 1]);
    const none = fakeDb(EVENTS);
    expect((await print.loadBuildingActivity(none, null, 'st_1')).size).toBe(0);
    expect(none.calls).toHaveLength(0);
  });

  test('a sent_back note is dropped; crew and office notes stay; a crew-link finish is flagged', async () => {
    const { activity } = await loadWith(print);
    expect(activity.get('k1')).toEqual({
      notes: [{ note: 'Tread 3 was split', by: 'Jose', at: '2026-09-11 15:00:00' }],
      completed_by: null, completed_at: '2026-09-12 18:30:00', completed_via_share: true,
    });
    expect(activity.get('k3')).toEqual({
      notes: [{ note: 'Gate code changed', by: 'Office', at: '2026-09-12 10:00:00' }],
      completed_by: 'Wendy Wide', completed_at: '2026-09-13 16:00:00', completed_via_share: false,
    });

    const { document } = print.buildCompletionReport(reportInput({ activity }));
    const json = JSON.stringify(document);
    expect(json).not.toContain('redo it');
    expect(json).not.toContain('Paula PM ·');
    expect(document.sections.map((s) => s.label.replace(/\s·\s.*$/, ''))).toContain('Bldg 784 — finished by the crew');
  });

  test('MUTANT: without the sent_back filter the office’s reason is printed as a crew note', async () => {
    const mut = mutant("      if (d.sent_back === true || d.sent_back === 'true') continue;\n", '');
    const { activity } = await loadWith(mut);
    const json = JSON.stringify(mut.buildCompletionReport(reportInput({ activity })).document);
    expect(json).toContain('Rail is still loose, redo it');
  });
});
