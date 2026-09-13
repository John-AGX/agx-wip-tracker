// A REPORT NEVER HANDS A WORK ORDER'S PHOTO TO A READER WHO CANNOT SEE THE WORK
// ORDER — AND NEVER LOSES A PHOTO IT ALREADY HELD.
//
// ── THE DEFECT ────────────────────────────────────────────────────────────
// Reports reference photos by bare attachment id in sections[].photo_ids, and
// normalizeSections keeps any string the caller sends. Both report routers then
// hydrated those ids into thumb/web/original URLs on GET:
//
//   * server/routes/report-routes.js (GET /api/jobs/:jobId/reports/:id) scoped
//     the lookup by ORGANIZATION only — so inside the org any id resolved,
//     including a work-order photo whose read rule is its ticket's PARENT
//     (services/attachment-entity-access.js ticketAttachmentAccess);
//   * server/routes/reports-routes.js (GET /api/reports/:type/:id/:rid) had NO
//     predicate at all — `WHERE id = ANY($1)` — so another TENANT's URLs too.
//
// ── THE RULE UNDER TEST (THE REPORT PHOTO RULE, report-routes.js) ─────────
//   READ: a stored id hydrates when the attachment is in the report's org
//   (legacy un-stamped rows included, as always) and — only for a
//   service_ticket attachment — the READER passes ticketAttachmentAccess.
//   Photos from other parents in the same org hydrate exactly as before (an
//   earlier round anchored on the report's own parent and hid real photos).
//   WRITE: ids already stored stay untouched whoever saves; a NEW id is kept
//   only if the WRITER passes the read rule; drops are counted as
//   photos_dropped, absent / foreign / unreadable on one path.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL routers over HTTP — real requireAuth on a signed JWT, the real role
// cache — against node:sqlite through the pg shim, over a schema derived from
// server/db.js. Then each check is removed from a copy of the shipped file and
// the identical drive is shown to produce the defect again; the harness throws
// when an anchor is absent, matches more than once, or moves no bytes (the
// repo is CRLF on disk).
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

let mockEng = null;
jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockEng.pool.query(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockEng.pool.query(sql, params),
      release: () => {},
    }),
  },
}));

const SERVER = path.join(__dirname, '..', 'server');
const JOB_REPORTS_FILE = path.join(SERVER, 'routes', 'report-routes.js');
const REPORTS_FILE = path.join(SERVER, 'routes', 'reports-routes.js');

const auth = require('../server/auth');
const jobReportRouter = require('../server/routes/report-routes');
const reportsRouter = require('../server/routes/reports-routes');

const TABLES = ['organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'projects',
  'service_tickets', 'attachments', 'job_reports'];

const CREW = 20;    // JOBS_VIEW_ASSIGNED + JOBS_EDIT_OWN — owns job j1, nothing on j2
const LEADS = 30;   // LEADS_VIEW + LEADS_EDIT — edits project reports, fails a JOB ticket
const WIDE = 10;    // every job and lead capability — passes the j2 ticket's rule
const USERS = {
  [WIDE]: { role: 'rp_wide', org: 1 },
  [CREW]: { role: 'rp_crew', org: 1 },
  [LEADS]: { role: 'rp_leads', org: 1 },
};

// Every photo id a section might name, and where each one lives.
const PHOTOS = {
  own_job: 'att_j1',        // job j1 — the job report's own photo
  other_job: 'att_j2',      // job j2, same org — attachable, as it always was
  ticket: 'att_st',         // work order on job j2, uploaded by the guest door
  legacy: 'att_old',        // job j1, organization_id NULL — pre-stamping upload
  foreign_job: 'att_j9',    // org 2's job
  own_project: 'att_p1',    // project p1 — the project report's own photo
  foreign_project: 'att_p9',
  absent: 'att_nope',
};
const ALL_IDS = Object.values(PHOTOS);
// What an org-1 reader who cannot see the j2 ticket is shown, in stored order.
const SAME_ORG_NO_TICKET = ['att_j1', 'att_j2', 'att_old', 'att_p1'];
const SAME_ORG_WITH_TICKET = ['att_j1', 'att_j2', 'att_st', 'att_old', 'att_p1'];

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const sec = (ids) => "'" + JSON.stringify([{
    id: 's1', label: 'Before', photo_ids: ids,
    captions: Object.fromEntries(ids.map((i) => [i, 'CAP-' + i])),
  }]) + "'";
  mockEng.db.exec(`
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
    INSERT INTO projects (id, organization_id, name) VALUES ('p1', 1, 'Maple'), ('p9', 2, 'Rival');
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist) VALUES
      ('st_j2', 1, 'Gate on j2', 'j2', NULL, 'open', '[]');

    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes,
                             thumb_url, web_url, original_url, original_key, tags, organization_id, uploaded_by, position) VALUES
      ('att_j1', 'job', 'j1', 'OWN-JOB.jpg', 'image/jpeg', 10, 'https://cdn.test/OWNJOB-T', 'https://cdn.test/OWNJOB-W', 'https://cdn.test/OWNJOB-O', 'k/1', '[]', 1, 20, 0),
      ('att_j2', 'job', 'j2', 'OTHER-JOB.jpg', 'image/jpeg', 10, 'https://cdn.test/OTHERJOB-T', 'https://cdn.test/OTHERJOB-W', 'https://cdn.test/OTHERJOB-O', 'k/2', '[]', 1, 10, 0),
      ('att_st', 'service_ticket', 'st_j2', 'CREW.jpg', 'image/jpeg', 10, 'https://cdn.test/TICKET-T', 'https://cdn.test/TICKET-W', 'https://cdn.test/TICKET-O', 'k/3', '[]', 1, NULL, 0),
      ('att_old', 'job', 'j1', 'LEGACY.jpg', 'image/jpeg', 10, 'https://cdn.test/LEGACY-T', 'https://cdn.test/LEGACY-W', 'https://cdn.test/LEGACY-O', 'k/0', '[]', NULL, 20, 0),
      ('att_j9', 'job', 'j9', 'RIVAL-JOB.jpg', 'image/jpeg', 10, 'https://cdn.test/RIVALJOB-T', 'https://cdn.test/RIVALJOB-W', 'https://cdn.test/RIVALJOB-O', 'k/4', '[]', 2, 50, 0),
      ('att_p1', 'project', 'p1', 'OWN-PROJECT.jpg', 'image/jpeg', 10, 'https://cdn.test/OWNPROJ-T', 'https://cdn.test/OWNPROJ-W', 'https://cdn.test/OWNPROJ-O', 'k/5', '[]', 1, 30, 0),
      ('att_p9', 'project', 'p9', 'RIVAL-PROJECT.jpg', 'image/jpeg', 10, 'https://cdn.test/RIVALPROJ-T', 'https://cdn.test/RIVALPROJ-W', 'https://cdn.test/RIVALPROJ-O', 'k/6', '[]', 2, 50, 0);

    -- Reports ALREADY holding every id, the way a save before this fix stored them,
    -- and clean reports holding only their own photo (every other id is NEW to them).
    INSERT INTO job_reports (id, job_id, entity_type, entity_id, title, summary, sections, cover_page, template_type, style_pack, created_by) VALUES
      ('rpt_j1', 'j1', 'job', 'j1', 'Crew walk', '', ${sec(ALL_IDS)}, '{}', 'walkthrough', 'clean', 20),
      ('rpt_j1c', 'j1', 'job', 'j1', 'Clean walk', '', ${sec(['att_j1'])}, '{}', 'walkthrough', 'clean', 20),
      ('rpt_p1', NULL, 'project', 'p1', 'Maple walk', '', ${sec(ALL_IDS)}, '{}', 'walkthrough', 'clean', 30),
      ('rpt_p1c', NULL, 'project', 'p1', 'Maple clean', '', ${sec(['att_p1'])}, '{}', 'walkthrough', 'clean', 30);
  `);
}

beforeAll(async () => {
  mockEng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'data', 'tags', 'annotations', 'sections', 'cover_page'],
  });
  auth.setRolePool(mockEng.pool);
  seed();
  await auth.refreshRoleCache();
});
beforeEach(() => seed());

let servers = [];
let mutantPaths = [];
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});
afterAll(() => {
  const eng = mockEng;
  mockEng = { pool: { query: async () => ({ rows: [], rowCount: 0 }) } };
  if (eng) eng.close();
});

async function serve(jobRouter, polyRouter) {
  const app = express();
  app.use(express.json());
  app.use('/api/jobs/:jobId/reports', jobRouter || jobReportRouter);
  app.use('/api/reports', polyRouter || reportsRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}

async function call(base, uid, method, url, json) {
  const u = USERS[uid];
  const token = auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
  const headers = { authorization: 'Bearer ' + token, connection: 'close' };
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + url, { method, headers, body });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, body: parsed, text };
}

const stored = (rid) => mockEng.all('SELECT sections FROM job_reports WHERE id = ?', rid)[0].sections;
const storedIds = (rid) => stored(rid).flatMap((s) => s.photo_ids);
const section = (ids) => [{
  id: 's1', label: 'Before', photo_ids: ids,
  captions: Object.fromEntries(ids.map((i) => [i, 'CAP-' + i])),
  descSides: Object.fromEntries(ids.map((i) => [i, 'left'])),
}];
const photoIds = (r) => r.body.report.sections.flatMap((s) => s.photos.map((p) => p.id));
const FOREIGN_URL = /RIVALJOB-|RIVALPROJ-/;
// New ids a writer tries to add to a clean report: one of each kind.
const NEW_IDS_JOB = ['att_j1', 'att_j2', 'att_st', 'att_j9', 'att_p9', 'att_nope'];

// ═══════════════════════════════════════════════════════════════════════════
describe('the mutation harness is not the thing being fooled', () => {
  test('absent, repeated and no-op anchors all THROW; LF anchors apply to the CRLF file', () => {
    expect(() => mutantFile(JOB_REPORTS_FILE, [['nowhere in this file', 'x']])).toThrow(/ANCHOR NOT FOUND/);
    expect(() => mutantFile(JOB_REPORTS_FILE, [['const { rows } = await pool.query(', 'x']])).toThrow(/MATCHED \d+ TIMES/);
    expect(() => mutantFile(JOB_REPORTS_FILE, [['async function readableReportPhotoRows(', 'async function readableReportPhotoRows(']])).toThrow(/CHANGED NO BYTES/);
    expect(fs.readFileSync(JOB_REPORTS_FILE, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
    expect(() => mutantFile(JOB_REPORTS_FILE, [["  if (!idList.length) return [];\n  const { rows } = await pool.query(",
      "  if (!idList.length) return [];\n  /* moved */ const { rows } = await pool.query("]])).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('JOB report (report-routes.js) — READ', () => {
  test('THE FINDING: a ticket photo already saved does not hydrate for a reader who cannot see the ticket', async () => {
    const b = await serve();
    const r = await call(b, CREW, 'GET', '/api/jobs/j1/reports/rpt_j1');
    expect(r.status).toBe(200);
    expect(photoIds(r)).toEqual(SAME_ORG_NO_TICKET);
    expect(r.text).not.toContain('TICKET-');
  });

  test('another tenant\'s and absent ids never hydrate, for anyone', async () => {
    const b = await serve();
    for (const uid of [CREW, WIDE]) {
      const r = await call(b, uid, 'GET', '/api/jobs/j1/reports/rpt_j1');
      expect(r.text).not.toMatch(FOREIGN_URL);
      expect(photoIds(r)).not.toEqual(expect.arrayContaining(['att_j9']));
    }
  });

  test('a reader who passes the ticket\'s parent rule still sees the ticket photo — per reader, not a ban', async () => {
    const b = await serve();
    const r = await call(b, WIDE, 'GET', '/api/jobs/j1/reports/rpt_j1');
    expect(photoIds(r)).toEqual(SAME_ORG_WITH_TICKET);
    expect(r.text).toContain('https://cdn.test/TICKET-W');
  });

  test('NO REGRESSION: another job\'s photo, a project photo and a legacy un-stamped photo still hydrate', async () => {
    const b = await serve();
    const r = await call(b, CREW, 'GET', '/api/jobs/j1/reports/rpt_j1');
    expect(r.text).toContain('https://cdn.test/OTHERJOB-W');
    expect(r.text).toContain('https://cdn.test/LEGACY-W');
    expect(r.text).toContain('https://cdn.test/OWNPROJ-W');
  });

  test('the job\'s own photo still hydrates, URLs and caption intact', async () => {
    const b = await serve();
    const r = await call(b, CREW, 'GET', '/api/jobs/j1/reports/rpt_j1c');
    expect(r.body.report.sections[0].photos).toEqual([{
      id: 'att_j1', filename: 'OWN-JOB.jpg', mime_type: 'image/jpeg',
      thumb_url: 'https://cdn.test/OWNJOB-T', web_url: 'https://cdn.test/OWNJOB-W',
      original_url: 'https://cdn.test/OWNJOB-O', caption: 'CAP-att_j1',
    }]);
  });
});

describe('JOB report (report-routes.js) — WRITE', () => {
  test('a save that echoes the stored sections keeps EVERY stored id — even ones this writer cannot read', async () => {
    const b = await serve();
    const r = await call(b, CREW, 'PATCH', '/api/jobs/j1/reports/rpt_j1', { sections: section(ALL_IDS) });
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    expect(storedIds('rpt_j1')).toEqual(ALL_IDS);
  });

  test('THE FINDING: a NEW unreadable id is dropped on PATCH, captions/descSides with it, and counted', async () => {
    const b = await serve();
    const r = await call(b, CREW, 'PATCH', '/api/jobs/j1/reports/rpt_j1c', { sections: section(NEW_IDS_JOB) });
    expect([r.status, r.body]).toEqual([200, { ok: true, photos_dropped: 4 }]);
    expect(storedIds('rpt_j1c')).toEqual(['att_j1', 'att_j2']);
    expect(stored('rpt_j1c')[0].captions).toEqual({ att_j1: 'CAP-att_j1', att_j2: 'CAP-att_j2' });
  });

  test('a ticket photo, another tenant\'s and an absent id are INDISTINGUISHABLE on PATCH', async () => {
    const b = await serve();
    const outcome = async (id) => {
      seed();
      const r = await call(b, CREW, 'PATCH', '/api/jobs/j1/reports/rpt_j1c', { sections: section(['att_j1', id]) });
      return [r.status, r.body, stored('rpt_j1c')];
    };
    const absent = await outcome(PHOTOS.absent);
    expect(absent[1]).toEqual({ ok: true, photos_dropped: 1 });
    expect(absent[2][0].photo_ids).toEqual(['att_j1']);
    for (const id of [PHOTOS.ticket, PHOTOS.foreign_job, PHOTOS.foreign_project]) {
      expect(await outcome(id)).toEqual(absent);
    }
  });

  test('a writer who can read the ticket may attach its photo', async () => {
    const b = await serve();
    const r = await call(b, WIDE, 'PATCH', '/api/jobs/j1/reports/rpt_j1c', { sections: section(['att_j1', 'att_st']) });
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    expect(storedIds('rpt_j1c')).toEqual(['att_j1', 'att_st']);
  });

  test('POST drops every unreadable id and counts them', async () => {
    const b = await serve();
    const r = await call(b, CREW, 'POST', '/api/jobs/j1/reports', { title: 'New', sections: section(NEW_IDS_JOB) });
    expect(r.status).toBe(200);
    expect(r.body.photos_dropped).toBe(4);
    expect(storedIds(r.body.report.id)).toEqual(['att_j1', 'att_j2']);
    expect(r.text).not.toContain('att_st');
  });

  test('a PATCH without photo ids runs no attachment lookup and still saves', async () => {
    const b = await serve();
    const before = mockEng.log.length;
    const r = await call(b, CREW, 'PATCH', '/api/jobs/j1/reports/rpt_j1', { sections: [{ id: 's1', label: 'Empty' }] });
    expect(r.status).toBe(200);
    expect(mockEng.log.slice(before).some((e) => /FROM attachments/.test(e.sql))).toBe(false);
    expect(stored('rpt_j1')[0].label).toBe('Empty');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('PROJECT report (reports-routes.js)', () => {
  test('THE FINDING: the ticket photo and another tenant\'s photo no longer hydrate (there was NO predicate)', async () => {
    const b = await serve();
    const r = await call(b, LEADS, 'GET', '/api/reports/project/p1/rpt_p1');
    expect(r.status).toBe(200);
    expect(photoIds(r)).toEqual(SAME_ORG_NO_TICKET);
    expect(r.text).not.toContain('TICKET-');
    expect(r.text).not.toMatch(FOREIGN_URL);
  });

  test('a reader who passes the ticket\'s rule sees it; linked job photos hydrate as they always did', async () => {
    const b = await serve();
    const r = await call(b, WIDE, 'GET', '/api/reports/project/p1/rpt_p1');
    expect(photoIds(r)).toEqual(SAME_ORG_WITH_TICKET);
  });

  test('the project\'s own photo still hydrates, URLs, annotations and caption intact', async () => {
    const b = await serve();
    const r = await call(b, LEADS, 'GET', '/api/reports/project/p1/rpt_p1c');
    expect(r.body.report.sections[0].photos).toEqual([{
      id: 'att_p1', filename: 'OWN-PROJECT.jpg', mime_type: 'image/jpeg',
      thumb_url: 'https://cdn.test/OWNPROJ-T', web_url: 'https://cdn.test/OWNPROJ-W',
      original_url: 'https://cdn.test/OWNPROJ-O', annotations: [], caption: 'CAP-att_p1',
    }]);
  });

  test('PATCH keeps stored ids, drops a NEW unreadable one with its caption and descSide, and counts it', async () => {
    const b = await serve();
    const echo = await call(b, LEADS, 'PATCH', '/api/reports/project/p1/rpt_p1', { sections: section(ALL_IDS) });
    expect([echo.status, echo.body]).toEqual([200, { ok: true }]);
    expect(storedIds('rpt_p1')).toEqual(ALL_IDS);

    const r = await call(b, LEADS, 'PATCH', '/api/reports/project/p1/rpt_p1c', { sections: section(['att_p1', 'att_st', 'att_p9']) });
    expect([r.status, r.body]).toEqual([200, { ok: true, photos_dropped: 2 }]);
    expect(storedIds('rpt_p1c')).toEqual(['att_p1']);
    expect(stored('rpt_p1c')[0].captions).toEqual({ att_p1: 'CAP-att_p1' });
    expect(stored('rpt_p1c')[0].descSides).toEqual({ att_p1: 'left' });
  });

  test('POST drops unreadable ids and counts them', async () => {
    const b = await serve();
    const r = await call(b, LEADS, 'POST', '/api/reports/project/p1', { title: 'New', sections: section(['att_p1', 'att_st', 'att_nope']) });
    expect(r.status).toBe(200);
    expect(r.body.photos_dropped).toBe(2);
    expect(storedIds(r.body.report.id)).toEqual(['att_p1']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTANTS
// ═══════════════════════════════════════════════════════════════════════════
function mutantFile(file, pairs) {
  const SOURCE = fs.readFileSync(file, 'utf8');
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const hits = out.split(f).length - 1;
    if (hits === 0) {
      throw new Error('MUTATION ANCHOR NOT FOUND — the guard moved or the line endings differ. Anchor:\n'
        + JSON.stringify(f.slice(0, 200)));
    }
    if (hits > 1) throw new Error('MUTATION ANCHOR MATCHED ' + hits + ' TIMES: ' + JSON.stringify(f.slice(0, 120)));
    const next = out.split(f).join(r);
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + JSON.stringify(f.slice(0, 120)));
    out = next;
  }
  const fromDir = path.dirname(file);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
    let resolved;
    try {
      resolved = spec.charAt(0) === '.'
        ? require.resolve(path.resolve(fromDir, spec))
        : require.resolve(spec, { paths: [fromDir] });
    } catch (e) {
      return m;
    }
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_rpt_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}
const serveJobMutant = (pairs) => serve(require(mutantFile(JOB_REPORTS_FILE, pairs)), null);
const servePolyMutant = (pairs) => serve(null, require(mutantFile(REPORTS_FILE, pairs)));

describe('MUTANT: report-routes.js', () => {
  test('harness: a copy with no change to the checks still refuses the ticket photo', async () => {
    const b = await serveJobMutant([['async function readableReportPhotoRows(', 'async function readableReportPhotoRows /* copy */(']]);
    expect(photoIds(await call(b, CREW, 'GET', '/api/jobs/j1/reports/rpt_j1'))).toEqual(SAME_ORG_NO_TICKET);
  });

  test('the TICKET clause removed: the ticket photo\'s URLs come back to a reader who cannot see the ticket', async () => {
    const b = await serveJobMutant([['      if (!ticketVerdicts.get(ticketId)) continue;', '      /* ticket clause removed */']]);
    const r = await call(b, CREW, 'GET', '/api/jobs/j1/reports/rpt_j1');
    expect(photoIds(r)).toContain('att_st');
    expect(r.text).toContain('https://cdn.test/TICKET-W');
  });

  test('the ORG predicate removed: another tenant\'s URLs come back', async () => {
    const b = await serveJobMutant([["    '   AND (organization_id = $2 OR organization_id IS NULL)',", "    '   AND ($2 = $2)',"]]);
    const r = await call(b, CREW, 'GET', '/api/jobs/j1/reports/rpt_j1');
    expect(r.text).toContain('https://cdn.test/RIVALJOB-W');
  });

  test('the legacy arm removed: an older un-stamped photo VANISHES from an existing report', async () => {
    const b = await serveJobMutant([["    '   AND (organization_id = $2 OR organization_id IS NULL)',", "    '   AND (organization_id = $2)',"]]);
    const r = await call(b, CREW, 'GET', '/api/jobs/j1/reports/rpt_j1');
    expect(photoIds(r)).not.toContain('att_old');
  });

  test('the stored-id exemption removed: an echo save STRIPS photos the writer cannot read', async () => {
    const b = await serveJobMutant([['    if (!storedIds.has(pid)) fresh.add(pid);', '    fresh.add(pid);']]);
    await call(b, CREW, 'PATCH', '/api/jobs/j1/reports/rpt_j1', { sections: section(ALL_IDS) });
    expect(storedIds('rpt_j1')).not.toContain('att_st');
  });

  test('the PATCH filter removed: a new ticket id is stored', async () => {
    const b = await serveJobMutant([[
      'const kept = await keepReportPhotoIds(nextSections, reportPhotoIdsOf(cur.rows[0].sections), req.orgId, req.user);',
      'const kept = { sections: nextSections, dropped: 0 };']]);
    await call(b, CREW, 'PATCH', '/api/jobs/j1/reports/rpt_j1c', { sections: section(['att_j1', 'att_st']) });
    expect(storedIds('rpt_j1c')).toEqual(['att_j1', 'att_st']);
  });

  test('the POST filter removed: the ticket id is stored', async () => {
    const b = await serveJobMutant([[
      'const kept = await keepReportPhotoIds(normalizeSections(req.body && req.body.sections), new Set(), req.orgId, req.user);',
      'const kept = { sections: normalizeSections(req.body && req.body.sections), dropped: 0 };']]);
    const r = await call(b, CREW, 'POST', '/api/jobs/j1/reports', { title: 'x', sections: section(['att_st']) });
    expect(storedIds(r.body.report.id)).toEqual(['att_st']);
  });
});

describe('MUTANT: reports-routes.js', () => {
  test('harness: a copy with no change to the checks still refuses the ticket photo', async () => {
    const b = await servePolyMutant([['function reportOrgId(req) {', 'function reportOrgId /* copy */(req) {']]);
    expect(photoIds(await call(b, LEADS, 'GET', '/api/reports/project/p1/rpt_p1'))).toEqual(SAME_ORG_NO_TICKET);
  });

  test('the shared rule bypassed on read (the old bare lookup): the ticket photo and the other tenant\'s hydrate', async () => {
    const b = await servePolyMutant([[
      '  const rows = await readableReportPhotoRows(idList, orgId, user);',
      "  const { rows } = await pool.query('SELECT id, filename, mime_type, thumb_url, web_url, original_url, annotations FROM attachments WHERE id = ANY($1::text[])', [idList]);"]]);
    const r = await call(b, LEADS, 'GET', '/api/reports/project/p1/rpt_p1');
    expect(photoIds(r)).toEqual(expect.arrayContaining(['att_st', 'att_p9']));
    expect(r.text).toContain('https://cdn.test/TICKET-W');
  });

  test('the PATCH filter removed: a new ticket id is stored', async () => {
    const b = await servePolyMutant([[
      'const kept = await keepReportPhotoIds(nextSections, reportPhotoIdsOf(cur.rows[0].sections), reportOrgId(req), req.user);',
      'const kept = { sections: nextSections, dropped: 0 };']]);
    await call(b, LEADS, 'PATCH', '/api/reports/project/p1/rpt_p1c', { sections: section(['att_p1', 'att_st']) });
    expect(storedIds('rpt_p1c')).toEqual(['att_p1', 'att_st']);
  });

  test('the POST filter removed: the ticket id is stored', async () => {
    const b = await servePolyMutant([[
      'const kept = await keepReportPhotoIds(normalizeSections(req.body && req.body.sections), new Set(), reportOrgId(req), req.user);',
      'const kept = { sections: normalizeSections(req.body && req.body.sections), dropped: 0 };']]);
    const r = await call(b, LEADS, 'POST', '/api/reports/project/p1', { title: 'x', sections: section(['att_st']) });
    expect(storedIds(r.body.report.id)).toEqual(['att_st']);
  });
});
