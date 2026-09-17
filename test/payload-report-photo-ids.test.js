// A SCRIBE-WRITTEN REPORT CANNOT ATTACH A PHOTO ITS APPROVER MAY NOT READ —
// AND NEVER STRIPS ONE SOMEBODY ELSE ALREADY ATTACHED.
//
// ── THE DEFECT ────────────────────────────────────────────────────────────
// dispatchReport (services/payload-dispatcher.js) ran every section through
// normalizeReportSection, which keeps ANY string as a photo id. A report
// hydrates its section ids into storage URLs, so a report payload could name a
// work-order photo whose read rule is its ticket's PARENT
// (services/attachment-entity-access.js ticketAttachmentAccess) — or another
// tenant's photo — and the approver's report would carry it.
//
// ── THE RULE UNDER TEST (the WRITE half of the report photo rule) ─────────
//   * an id ALREADY stored on the report is kept untouched, whoever writes;
//   * a NEW id is kept only if the attachment's organization_id IS the
//     report's org (no NULL arm) and — only for a service_ticket attachment —
//     the approver passes ticketAttachmentAccess in READ mode;
//   * anything else is dropped, absent and foreign alike, and the drop is
//     COUNTED in the apply summary (a number, never a filename).
// Driven on create, full replace, section_adds and section_updates.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The real applyPayload over node:sqlite through the pg shim, with the real
// role cache. Each check is then removed from a copy of the shipped dispatcher
// and the identical payload is shown to produce the defect. The harness throws
// when an anchor is absent, matches more than once, or moves no bytes (the repo
// is CRLF on disk, so every anchor is normalized to the file's line ending).
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SERVER = path.join(__dirname, '..', 'server');
const SERVICES = path.join(SERVER, 'services');
const REAL = path.join(SERVICES, 'payload-dispatcher.js');
const SOURCE = fs.readFileSync(REAL, 'utf8');

const TABLES = ['organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'projects',
  'service_tickets', 'attachments', 'job_reports'];

const WIDE = { userId: 10, organizationId: 1 };   // every job and lead capability
const CREW = { userId: 20, organizationId: 1 };   // JOBS_VIEW_ASSIGNED + JOBS_EDIT_OWN — owns j1 only
const LEADS = { userId: 30, organizationId: 1 };  // LEADS_VIEW + LEADS_EDIT — fails a JOB ticket

const P = {
  own_project: 'att_p1',     // project p1, org 1
  other_parent: 'att_j2',    // job j2, org 1 — another parent in the SAME org
  job_ticket: 'att_st',      // work order on job j2 — STORED on rpt_p1 already
  job_ticket_new: 'att_st2', // work order on job j2 — on no report
  lead_ticket: 'att_stl',    // work order on lead l1
  foreign: 'att_j9',         // org 2's job
  null_org: 'att_null',      // project p1, organization_id NULL
  absent: 'att_nope',
};

let eng;
function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const sections = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM projects;
    DELETE FROM service_tickets; DELETE FROM attachments; DELETE FROM job_reports;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('rp_wide',  ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('rp_crew',  ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('rp_leads', ${caps(['LEADS_VIEW', 'LEADS_EDIT'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy', 'w@agx.test', 'rp_wide', 1),
      (20, 'Carl', 'c@agx.test', 'rp_crew', 1),
      (30, 'Lena', 'l@agx.test', 'rp_leads', 1),
      (50, 'Ray', 'r@rival.test', 'rp_wide', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 20, '{}', 1), ('j2', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO leads (id, title, organization_id, status) VALUES ('l1', 'Roof lead', 1, 'new');
    INSERT INTO projects (id, organization_id, name) VALUES ('p1', 1, 'Maple'), ('p9', 2, 'Rival');
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist) VALUES
      ('st_j2', 1, 'Gate on j2', 'j2', NULL, 'open', '[]'),
      ('st_l1', 1, 'Lead survey', NULL, 'l1', 'open', '[]');

    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes,
                             thumb_url, web_url, original_url, original_key, tags, organization_id, uploaded_by, position) VALUES
      ('att_p1',   'project',        'p1',    'OWN-PROJECT.jpg', 'image/jpeg', 10, 't', 'w', 'o', 'k/1', '[]', 1,    30, 0),
      ('att_j2',   'job',            'j2',    'OTHER-JOB.jpg',   'image/jpeg', 10, 't', 'w', 'o', 'k/2', '[]', 1,    10, 0),
      ('att_st',   'service_ticket', 'st_j2', 'CREW-A.jpg',      'image/jpeg', 10, 't', 'w', 'o', 'k/3', '[]', 1,    NULL, 0),
      ('att_st2',  'service_ticket', 'st_j2', 'CREW-B.jpg',      'image/jpeg', 10, 't', 'w', 'o', 'k/4', '[]', 1,    NULL, 0),
      ('att_stl',  'service_ticket', 'st_l1', 'LEAD-CREW.jpg',   'image/jpeg', 10, 't', 'w', 'o', 'k/5', '[]', 1,    NULL, 0),
      ('att_j9',   'job',            'j9',    'RIVAL-JOB.jpg',   'image/jpeg', 10, 't', 'w', 'o', 'k/6', '[]', 2,    50, 0),
      ('att_null', 'project',        'p1',    'NO-ORG.jpg',      'image/jpeg', 10, 't', 'w', 'o', 'k/7', '[]', NULL, NULL, 0);

    -- rpt_p1 already holds a JOB work-order photo, attached by a user who could read it.
    INSERT INTO job_reports (id, job_id, entity_type, entity_id, title, summary, sections, cover_page, template_type, style_pack, created_by) VALUES
      ('rpt_p1', NULL, 'project', 'p1', 'Maple walk', '', ${sections([
        { id: 's1', label: 'Before', layout: 'photo-grid', photo_ids: ['att_st', 'att_p1'],
          captions: { att_st: 'CAP-st', att_p1: 'CAP-p1' }, text_body: '', attachment_ids: [] },
        { id: 's2', label: 'After', layout: 'photo-grid', photo_ids: ['att_p1'],
          captions: {}, text_body: 'kept as stored', attachment_ids: [] },
      ])}, '{}', 'walkthrough', 'clean', 10),
      ('rpt_j1', 'j1', 'job', 'j1', 'Crew walk', '', '[]', '{}', 'walkthrough', 'clean', 20);
  `);
}

const hashtext = (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; };

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'data', 'tags', 'sections', 'cover_page'],
  });
  eng.db.function('hashtext', hashtext);
  eng.db.function('pg_advisory_xact_lock', (_k) => 1);
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  const auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
});
beforeEach(() => seed());

let mutantPaths = [];
const abs = (p) => p.split(path.sep).join('/');
function absolutizeRequires(src) {
  return src
    .replace(/require\('\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVICES)}/${p}')`)
    .replace(/require\('\.\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVER)}/${p}')`);
}
function mutatePairs(pairs) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const at = out.indexOf(f);
    if (at === -1) throw new Error('MUTATION ANCHOR NOT FOUND. Anchor:\n' + JSON.stringify(f.slice(0, 240)));
    if (out.indexOf(f, at + 1) !== -1) {
      throw new Error('MUTATION ANCHOR AMBIGUOUS (matches more than once). Anchor:\n' + JSON.stringify(f.slice(0, 240)));
    }
    const next = out.split(f).join(String(replace).replace(/\r?\n/g, eol));
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + f.slice(0, 80));
    out = next;
  }
  const p = path.join(os.tmpdir(), '_p86_rptmutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out), 'utf8');
  mutantPaths.push(p);
  return require(p);
}
const mutate = (find, replace) => mutatePairs([[find, replace]]);

const flush = () => new Promise((r) => setTimeout(r, 25));
afterEach(async () => {
  await flush();
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});
afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

const REAL_MOD = () => require('../server/services/payload-dispatcher');
const clone = (x) => JSON.parse(JSON.stringify(x));

async function apply(mod, target, ctx, opts) {
  return mod.applyPayload({ id: 'pl_rpt', targets: [clone(target)] },
    { userId: ctx.userId, organizationId: ctx.organizationId, dryRun: !!(opts && opts.dryRun) });
}

const section = (ids, extra) => Object.assign({
  label: 'Photos', layout: 'photo-grid', photo_ids: ids,
  captions: Object.fromEntries(ids.map((i) => [i, 'CAP-' + i])),
}, extra || {});
const createTarget = (ids) => ({ entity_type: 'report',
  ops: { op: 'create', template_type: 'walkthrough', parent_id: 'p1', title: 'Scribe walk', sections: [section(ids)] } });
const updateTarget = (id, ops) => ({ entity_type: 'report', entity_id: id, ops: Object.assign({ op: 'update' }, ops) });

const reports = () => eng.all('SELECT id, sections FROM job_reports ORDER BY id');
const storedOf = (id) => eng.all('SELECT sections FROM job_reports WHERE id = ?', id)[0].sections;
const newReport = () => eng.all("SELECT id, sections FROM job_reports WHERE id NOT IN ('rpt_p1','rpt_j1')")[0];
const ids = (sections) => sections.map((s) => s.photo_ids);
const FILENAMES = /OWN-PROJECT|OTHER-JOB|CREW-|LEAD-CREW|RIVAL-JOB|NO-ORG|att_/;
const attachmentReads = (t0) => eng.log.slice(t0).filter((e) => /\bFROM attachments\b/.test(e.sql));

/* ═══════════════════════════════════════════════════════════════════════════ */
describe('the mutation harness is not the thing being fooled', () => {
  test('absent, repeated and no-op anchors all THROW; an LF multi-line anchor matches the CRLF file', () => {
    expect(() => mutate('nowhere in the dispatcher at all', 'x')).toThrow(/ANCHOR NOT FOUND/);
    expect(() => mutate("entity_type: 'report',", 'x')).toThrow(/ANCHOR AMBIGUOUS/);
    const a = 'function reportPhotoIdsOf(sections) {';
    expect(() => mutate(a, a)).toThrow(/CHANGED NO BYTES/);
    expect(() => mutate('function reportPhotoIdsOf(sections) {\n  const out = new Set();',
      'function reportPhotoIdsOf(sections) {\n  const out = new Set([]);')).not.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe('create: every id is new, and only what the approver may read in the report\'s org is stored', () => {
  const ALL = [P.own_project, P.other_parent, P.job_ticket_new, P.lead_ticket, P.foreign, P.absent, P.null_org];

  test('a LEADS_EDIT approver: own and other-parent photos and the LEAD ticket\'s photo stay; the rest drop, counted', async () => {
    const r = await apply(REAL_MOD(), createTarget(ALL), LEADS);
    const row = newReport();
    expect(ids(row.sections)).toEqual([[P.own_project, P.other_parent, P.lead_ticket]]);
    expect(Object.keys(row.sections[0].captions)).toEqual([P.own_project, P.other_parent, P.lead_ticket]);
    expect(r.affected_targets[0].photos_dropped).toBe(4);
    expect(r.apply_summary).toBe('Report created (template=walkthrough, 1 section(s), 4 photo(s) not attached — not visible to the approver)');
    expect(r.apply_summary).not.toMatch(FILENAMES);
  });

  test('a JOBS_VIEW_ALL approver may read the JOB ticket, so that photo stays too', async () => {
    const r = await apply(REAL_MOD(), createTarget(ALL), WIDE);
    expect(ids(newReport().sections)).toEqual([[P.own_project, P.other_parent, P.job_ticket_new, P.lead_ticket]]);
    expect(r.affected_targets[0].photos_dropped).toBe(3);
  });

  test('a foreign id and an absent id answer IDENTICALLY — stored sections, summary and count', async () => {
    const foreign = await apply(REAL_MOD(), createTarget([P.foreign]), WIDE);
    const foreignRow = newReport();
    seed();
    const absent = await apply(REAL_MOD(), createTarget([P.absent]), WIDE);
    const absentRow = newReport();
    const strip = (s) => s.map((x) => Object.assign({}, x, { id: '<sec>' }));
    expect(strip(foreignRow.sections)).toEqual(strip(absentRow.sections));
    expect(ids(foreignRow.sections)).toEqual([[]]);
    expect(foreign.apply_summary).toBe(absent.apply_summary);
    expect(foreign.affected_targets[0].photos_dropped).toBe(absent.affected_targets[0].photos_dropped);
  });

  test('nothing dropped: the summary and the receipt are exactly what they were before this rule', async () => {
    const r = await apply(REAL_MOD(), createTarget([P.own_project]), LEADS);
    expect(r.apply_summary).toBe('Report created (template=walkthrough, 1 section(s))');
    expect(Object.prototype.hasOwnProperty.call(r.affected_targets[0], 'photos_dropped')).toBe(false);
  });

  test('a dry run reports the same count and stores nothing', async () => {
    const r = await apply(REAL_MOD(), createTarget([P.foreign, P.own_project]), LEADS, { dryRun: true });
    expect(r.apply_summary).toMatch(/1 photo\(s\) not attached/);
    expect(reports().map((x) => x.id)).toEqual(['rpt_j1', 'rpt_p1']);
  });

  test('MUTANT: store the normalized sections unfiltered and a foreign photo lands on the report', async () => {
    const mut = mutate('    const sections = kept.sections;\n',
      '    const sections = Array.isArray(ops.sections) ? ops.sections.map(normalizeReportSection).filter(Boolean).slice(0, 50) : [];\n');
    await apply(mut, createTarget([P.own_project, P.foreign]), LEADS);
    expect(ids(newReport().sections)).toEqual([[P.own_project, P.foreign]]);
  });

  test('MUTANT: skip the ticket check and a LEADS_EDIT approver attaches a JOB work-order photo', async () => {
    const mut = mutate('      const wo = await ticketOf(att);\n      if (!wo) { readable.add(String(att.id)); continue; }',
      '      if (true) { readable.add(String(att.id)); continue; }');
    await apply(mut, createTarget([P.job_ticket_new]), LEADS);
    expect(ids(newReport().sections)).toEqual([[P.job_ticket_new]]);
  });

  test('MUTANT: drop the org predicate and another tenant\'s photo is attached', async () => {
    const mut = mutate('FROM attachments WHERE id = ANY($1::text[]) AND organization_id = $2\'',
      'FROM attachments WHERE id = ANY($1::text[]) AND (organization_id = $2 OR 1 = 1)\'');
    await apply(mut, createTarget([P.foreign]), WIDE);
    expect(ids(newReport().sections)).toEqual([[P.foreign]]);
  });

  test('MUTANT: add the NULL tolerance arm and an org-less photo is attached — the predicate is strict', async () => {
    const mut = mutate('FROM attachments WHERE id = ANY($1::text[]) AND organization_id = $2\'',
      'FROM attachments WHERE id = ANY($1::text[]) AND (organization_id = $2 OR organization_id IS NULL)\'');
    await apply(mut, createTarget([P.null_org]), WIDE);
    expect(ids(newReport().sections)).toEqual([[P.null_org]]);
  });

  test('MUTANT: keep the captions of dropped ids and the stored report still names them', async () => {
    const mut = mutate('      return Object.assign({}, s, { photo_ids: photoIds, captions });',
      '      return Object.assign({}, s, { photo_ids: photoIds });');
    await apply(mut, createTarget([P.own_project, P.foreign]), LEADS);
    expect(Object.keys(newReport().sections[0].captions)).toEqual([P.own_project, P.foreign]);
  });

  test('MUTANT: leave the count out of the create summary and the approver is never told', async () => {
    const mut = mutate(
      "        (kept.dropped ? `, ${kept.dropped} photo(s) not attached — not visible to the approver` : '') + ')',",
      "        '' + ')',");
    const r = await apply(mut, createTarget([P.own_project, P.foreign]), LEADS);
    expect(r.apply_summary).toBe('Report created (template=walkthrough, 1 section(s))');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe('update: stored ids are kept whoever writes; only new ids are proved', () => {
  test('FULL REPLACE by a LEADS_EDIT approver keeps the stored JOB ticket photo (even moved), drops the new unreadable ones', async () => {
    const r = await apply(REAL_MOD(), updateTarget('rpt_p1', { sections: [
      Object.assign(section([P.own_project, P.other_parent, P.absent]), { id: 's1' }),
      Object.assign(section([P.job_ticket, P.job_ticket_new, P.foreign]), { id: 's3' }),
    ] }), LEADS);
    expect(ids(storedOf('rpt_p1'))).toEqual([[P.own_project, P.other_parent], [P.job_ticket]]);
    expect(Object.keys(storedOf('rpt_p1')[1].captions)).toEqual([P.job_ticket]);
    expect(r.affected_targets[0].photos_dropped).toBe(3);
    expect(r.apply_summary).toBe('Report rpt_p1 updated (2 section(s), 3 photo(s) not attached — not visible to the approver)');
    expect(r.apply_summary).not.toMatch(/OWN-PROJECT|OTHER-JOB|CREW-|RIVAL-JOB|NO-ORG/);
  });

  test('SECTION_ADDS: a new section may re-use a stored ticket photo; a new JOB ticket photo needs a reader of that job', async () => {
    const add = updateTarget('rpt_p1', { section_adds: [section([P.job_ticket, P.job_ticket_new, P.lead_ticket, P.foreign])] });
    const r = await apply(REAL_MOD(), add, LEADS);
    const s = storedOf('rpt_p1');
    expect(ids(s)).toEqual([[P.job_ticket, P.own_project], [P.own_project], [P.job_ticket, P.lead_ticket]]);
    expect(r.affected_targets[0].photos_dropped).toBe(2);
    expect(r.apply_summary).toMatch(/3 section\(s\), 2 photo\(s\) not attached/);

    seed();
    const w = await apply(REAL_MOD(), add, WIDE);
    expect(ids(storedOf('rpt_p1'))[2]).toEqual([P.job_ticket, P.job_ticket_new, P.lead_ticket]);
    expect(w.affected_targets[0].photos_dropped).toBe(1);
  });

  test('SECTION_UPDATES: the updated section keeps its stored ids and drops a new unreadable one; the untouched section is byte-identical', async () => {
    const before = storedOf('rpt_p1');
    const r = await apply(REAL_MOD(), updateTarget('rpt_p1', { section_updates: [
      { id: 's1', photo_ids: [P.job_ticket, P.own_project, P.job_ticket_new, P.other_parent] },
    ] }), LEADS);
    const after = storedOf('rpt_p1');
    expect(after[0].photo_ids).toEqual([P.job_ticket, P.own_project, P.other_parent]);
    expect(after[0].captions).toEqual({ att_st: 'CAP-st', att_p1: 'CAP-p1' });
    expect(after[1]).toEqual(before[1]);
    expect(r.affected_targets[0].photos_dropped).toBe(1);
  });

  test('the NARROW tier asks READ: a crew lead with a VIEW grant on the ticket\'s job may attach its photo; without one he may not', async () => {
    const add = updateTarget('rpt_p1', { section_adds: [section([P.job_ticket_new])] });
    const denied = await apply(REAL_MOD(), add, CREW);
    expect(ids(storedOf('rpt_p1'))[2]).toEqual([]);
    expect(denied.affected_targets[0].photos_dropped).toBe(1);

    seed();
    eng.db.exec("INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j2', 20, 'view')");
    const granted = await apply(REAL_MOD(), add, CREW);
    expect(ids(storedOf('rpt_p1'))[2]).toEqual([P.job_ticket_new]);
    expect(granted.affected_targets[0].photos_dropped).toBeUndefined();
  });

  test('a JOB report\'s org is its job\'s: another parent\'s photo in that org is attachable, a foreign one is not', async () => {
    const r = await apply(REAL_MOD(), updateTarget('rpt_j1', { section_adds: [section([P.other_parent, P.foreign])] }), WIDE);
    expect(ids(storedOf('rpt_j1'))).toEqual([[P.other_parent]]);
    expect(r.affected_targets[0].photos_dropped).toBe(1);
  });

  test('a write that introduces NO new photo id runs no attachment statement and reports no count', async () => {
    const t0 = eng.log.length;
    const r = await apply(REAL_MOD(), updateTarget('rpt_p1', { title: 'Renamed', section_updates: [
      { id: 's2', label: 'After (final)' },
    ] }), LEADS);
    expect(attachmentReads(t0)).toHaveLength(0);
    expect(r.apply_summary).toBe('Report rpt_p1 updated (title, 2 section(s))');
    expect(ids(storedOf('rpt_p1'))).toEqual([[P.job_ticket, P.own_project], [P.own_project]]);
  });

  test('MUTANT: treat nothing as stored and a LEADS_EDIT autosave strips the ticket photo another user attached', async () => {
    const mut = mutate('      storedIds: reportPhotoIdsOf(row.sections),', '      storedIds: new Set(),');
    await apply(mut, updateTarget('rpt_p1', { sections: [
      Object.assign(section([P.job_ticket, P.own_project]), { id: 's1' }),
    ] }), LEADS);
    expect(ids(storedOf('rpt_p1'))).toEqual([[P.own_project]]);
  });

  test('MUTANT: skip the filter on update and section_adds attaches a foreign photo', async () => {
    const mut = mutate('    nextSections = kept.sections;\n', '');
    await apply(mut, updateTarget('rpt_p1', { section_adds: [section([P.foreign])] }), LEADS);
    expect(ids(storedOf('rpt_p1'))[2]).toEqual([P.foreign]);
  });

  test('MUTANT: ask WRITE instead of READ and a view grant no longer lets the crew lead attach the photo', async () => {
    const mut = mutate(
      "          orgId: (opts.ctx && opts.ctx.organizationId) != null ? opts.ctx.organizationId : null,\n          mode: 'read',",
      "          orgId: (opts.ctx && opts.ctx.organizationId) != null ? opts.ctx.organizationId : null,\n          mode: 'write',");
    eng.db.exec("INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j2', 20, 'view')");
    await apply(mut, updateTarget('rpt_p1', { section_adds: [section([P.job_ticket_new])] }), CREW);
    expect(ids(storedOf('rpt_p1'))[2]).toEqual([]);
  });

  test('MUTANT: lose the job arm of the report-org lookup and a job report drops its own org\'s photo', async () => {
    const mut = mutate("(entityType === 'job' ? 'jobs' : null)", 'null');
    await apply(mut, updateTarget('rpt_j1', { section_adds: [section([P.other_parent])] }), WIDE);
    expect(ids(storedOf('rpt_j1'))).toEqual([[]]);
  });

  test('MUTANT: leave the count out of the update summary and the approver is never told', async () => {
    const mut = mutate(
      '  if (photosDropped) summaryBits.push(`${photosDropped} photo(s) not attached — not visible to the approver`);\n', '');
    const r = await apply(mut, updateTarget('rpt_p1', { section_adds: [section([P.foreign])] }), LEADS);
    expect(r.apply_summary).toBe('Report rpt_p1 updated (3 section(s))');
  });

  test('MUTANT: drop the no-new-ids short-circuit and a plain rename reaches the attachments table', async () => {
    const mut = mutate('  if (!fresh.size) return { sections, dropped: 0 };\n', '');
    const t0 = eng.log.length;
    await apply(mut, updateTarget('rpt_p1', { section_updates: [{ id: 's2', label: 'After (final)' }] }), LEADS);
    expect(attachmentReads(t0).length).toBeGreaterThan(0);
  });
});
