// Build the PUBLISHED SNAPSHOT of a report — the exact document a share-link
// holder will see, resolved once at publish time and frozen on the share row.
//
// Why a snapshot rather than a live read:
//   * "Finished report" means finished. An edit made next week must not
//     silently rewrite the document you told a client was final.
//   * sections[].photo_ids are bare id references with no foreign key, so a
//     photo deleted from the project would blank a page the client already
//     has. The snapshot keeps what was actually sent.
//   * The guest read becomes one indexed row with NO id-joins, so the public
//     path cannot reach across tenants however it is called.
//
// This is the correct replacement for hydrateSections() in
// server/routes/reports-routes.js, which must NOT be reused here for two
// reasons: it resolves attachment ids with `WHERE id = ANY($1)` and no tenant
// or parent predicate at all (any id from any org would resolve), and its
// zero-photo early return drops layout, text_body and attachment_ids, so a
// text-only or file-list section would come back empty.
//
// buildDocument is PURE — it takes rows and returns an object. Fetching lives
// in loadReportDocument, which is the only part that needs a pool.
'use strict';

const DOC_VERSION = 1;

// Mirrors of the write-side allowlists in reports-routes.js. Duplicated
// deliberately: the snapshot is served to the public internet, so it clamps
// on its OWN terms rather than trusting whatever happens to be in the row.
const TEMPLATE_TYPES = new Set([
  'walkthrough', 'daily-log', 'weekly-progress', 'engineers-report',
  'submittal-package', 'punch-list', 'pre-con-survey', 'change-order'
]);
const STYLE_PACKS = new Set([
  'clean', 'classic-corporate', 'modern-bold', 'field-notebook',
  'inspection-pro', 'blueprint', 'editorial-spread', 'polaroid-journal'
]);
const SECTION_LAYOUTS = new Set([
  'photo-grid', 'single-photo', 'before-after', 'text-block',
  'attachment-list', 'photo-map'
]);
const PHOTO_SIZES = new Set(['small', 'medium', 'large']);
const PIN_STYLES = new Set(['tag', 'numbered', 'lettered', 'photo', 'dot']);

const COVER_PAGE_KEYS = [
  'company_name', 'pm_name', 'date', 'address', 'subtitle',
  'crew', 'weather', 'hours_on_site',
  'week_ending', 'project_phase', 'schedule_status',
  'stamped_by', 'license_number', 'signed_date',
  'submittal_number', 'spec_section', 'supplier', 'approval_block',
  'walkthrough_date', 'walkthrough_with',
  'survey_date', 'surveyed_by', 'building',
  'co_number', 'co_amount', 'requested_by'
];

// Cover fields that state MONEY. Dropped from the snapshot entirely when the
// share hides financials — removed at build time, never hidden with CSS,
// because "not in the payload" is the only kind of hidden that survives a
// reader opening dev tools.
const FINANCIAL_COVER_KEYS = new Set(['co_amount']);

function str(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max || 500);
}

function clampFromSet(v, set, fallback) {
  return (typeof v === 'string' && set.has(v)) ? v : fallback;
}

// Continuous photo numbering across the WHOLE document, skipping ids that no
// longer resolve — the same rule the editor applies, computed ONCE here so the
// number on a tile and the number on a baked map label cannot disagree.
function numberPhotos(sections, resolvable) {
  const nums = Object.create(null);
  let n = 0;
  (sections || []).forEach(function (sec) {
    const ids = (sec && Array.isArray(sec.photo_ids)) ? sec.photo_ids : [];
    ids.forEach(function (pid) {
      if (!pid || nums[pid]) return;
      if (!resolvable(pid)) return;
      nums[pid] = ++n;
    });
  });
  return nums;
}

function coverFor(raw, hideFinancials) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = { enabled: !!src.enabled };
  COVER_PAGE_KEYS.forEach(function (k) {
    if (hideFinancials && FINANCIAL_COVER_KEYS.has(k)) return;
    const v = src[k];
    if (typeof v === 'string' && v.trim()) out[k] = str(v, 300);
  });
  return out;
}

// A photo as the guest sees it. WHITELIST, not a delete-list: a column added
// to attachments later cannot leak into a public document by default.
// shot_at IS included: on a construction report the capture date is part of
// what the document proves, and a client reading a punch list needs it. The
// person who took it is internal, and is not.
// Deliberately absent — uploaded_by, uploader name, entity_type/entity_id,
// folder, extracted_text, thumb_key, size_bytes, original_url.
function publicPhoto(row, caption, num) {
  return {
    id: row.id,
    filename: str(row.filename, 200),
    mime_type: str(row.mime_type, 100),
    thumb_url: row.thumb_url || null,
    web_url: row.web_url || null,
    caption: str(caption != null ? caption : (row.caption || ''), 500),
    shot_at: row.shot_at || row.taken_at || row.uploaded_at || null,
    annotations: Array.isArray(row.annotations) ? row.annotations : null,
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    num: num || null
  };
}

/**
 * @param {object} a
 * @param {object} a.report        job_reports row (sections_raw, title, summary, …)
 * @param {Array}  a.photoRows     attachment rows, ALREADY parent-scoped
 * @param {Array}  a.fileRows      non-image attachment rows, already parent-scoped
 * @param {object} a.project       { name, address_text }
 * @param {string} a.orgName       display only
 * @param {boolean} a.hideFinancials
 */
function buildDocument(a) {
  const report = a.report || {};
  const hideFinancials = a.hideFinancials !== false;   // default HIDE
  const rawSections = Array.isArray(report.sections_raw) ? report.sections_raw : [];

  const photoById = new Map();
  (a.photoRows || []).forEach(function (r) { photoById.set(r.id, r); });
  const fileById = new Map();
  (a.fileRows || []).forEach(function (r) { fileById.set(r.id, r); });

  const nums = numberPhotos(rawSections, function (pid) { return photoById.has(pid); });

  const sections = rawSections.map(function (s) {
    const src = (s && typeof s === 'object') ? s : {};
    const captions = (src.captions && typeof src.captions === 'object') ? src.captions : {};
    const ids = Array.isArray(src.photo_ids) ? src.photo_ids : [];
    const attIds = Array.isArray(src.attachment_ids) ? src.attachment_ids : [];

    // Unresolvable ids are DROPPED, not rendered as a placeholder. A
    // "(photo deleted)" card must never reach a client's copy.
    const photos = ids
      .filter(function (pid) { return photoById.has(pid); })
      .map(function (pid) { return publicPhoto(photoById.get(pid), captions[pid], nums[pid]); });

    const files = attIds
      .filter(function (aid) { return fileById.has(aid); })
      .map(function (aid) {
        return { id: aid, filename: str(fileById.get(aid).filename, 200) };
      });

    return {
      id: str(src.id, 80),
      label: str(src.label, 200),
      layout: clampFromSet(src.layout, SECTION_LAYOUTS, 'photo-grid'),
      photoSize: clampFromSet(src.photoSize, PHOTO_SIZES, 'small'),
      descSide: (src.descSide === 'left' ? 'left' : 'right'),
      descSides: (src.descSides && typeof src.descSides === 'object') ? src.descSides : {},
      pin_style: clampFromSet(src.pin_style, PIN_STYLES, 'photo'),
      text_body: str(src.text_body, 20000),
      photos: photos,
      files: files
    };
  });

  return {
    v: DOC_VERSION,
    title: str(report.title, 300),
    summary: str(report.summary, 5000),
    template_type: clampFromSet(report.template_type, TEMPLATE_TYPES, 'walkthrough'),
    style_pack: clampFromSet(report.style_pack, STYLE_PACKS, 'clean'),
    cover_page: coverFor(report.cover_page, hideFinancials),
    sections: sections,
    org_name: str(a.orgName, 200),
    project_name: str(a.project && a.project.name, 200),
    project_address: str(a.project && a.project.address_text, 300),
    built_at: new Date().toISOString()
  };
}

/**
 * Fetch everything the snapshot needs and build it.
 *
 * The attachment query is PARENT-SCOPED — `entity_type` and `entity_id` are in
 * the WHERE clause, not merely assumed. hydrateSections() in reports-routes.js
 * omits them, so an id belonging to another organization's project would
 * resolve there. A public document builder is the last place that should
 * inherit that.
 */
async function loadReportDocument(pool, opts) {
  const report = opts.report;
  const entityType = opts.entityType;
  const entityId = opts.entityId;

  const rawSections = Array.isArray(report.sections_raw) ? report.sections_raw : [];
  const ids = [];
  rawSections.forEach(function (s) {
    (Array.isArray(s && s.photo_ids) ? s.photo_ids : []).forEach(function (p) { if (p) ids.push(p); });
    (Array.isArray(s && s.attachment_ids) ? s.attachment_ids : []).forEach(function (p) { if (p) ids.push(p); });
  });

  let rows = [];
  if (ids.length) {
    const r = await pool.query(
      `SELECT id, filename, mime_type, thumb_url, web_url, caption, annotations, lat, lng,
              COALESCE(taken_at, uploaded_at) AS shot_at
         FROM attachments
        WHERE id = ANY($1::text[])
          AND entity_type = $2
          AND entity_id = $3`,
      [Array.from(new Set(ids)), entityType, entityId]
    );
    rows = r.rows;
  }

  const photoRows = rows.filter(function (r) { return r.mime_type && /^image\//.test(r.mime_type); });
  const fileRows = rows.filter(function (r) { return !(r.mime_type && /^image\//.test(r.mime_type)); });

  return buildDocument({
    report: report,
    photoRows: photoRows,
    fileRows: fileRows,
    project: opts.project,
    orgName: opts.orgName,
    hideFinancials: opts.hideFinancials
  });
}

module.exports = {
  DOC_VERSION,
  COVER_PAGE_KEYS,
  FINANCIAL_COVER_KEYS,
  numberPhotos,
  buildDocument,
  loadReportDocument
};
