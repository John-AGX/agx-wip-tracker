// Org Manifest — the discoverability source of truth at runtime.
//
// One read-only endpoint that returns a snapshot of "what's in this
// org" + "what features the app supports" in a single response. Used
// by the Summary page's System Snapshot block (Today sub-tab) and
// System Map sub-tab. Could later be consumed by a 86 introspection
// tool (deliberately deferred this round).
//
// Mounted at /api/org/manifest.
//
// All counts are organization-scoped. Tables with a direct
// organization_id column use it; tables that join through users
// (jobs, leads, estimates, job_change_orders, schedule_entries) use
// owner_id → users → organization_id.
//
// Capability: any authenticated user in the org can read. No tier
// gating — this is a summary view, not record-level data.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireOrg, requireCapability } = require('../auth');
const { features, whats_new } = require('../feature-catalog');
const entitlements = require('../entitlements');

const router = express.Router();

// Normalize a logos array → [{url, label}], capped + sanitized.
function normLogos(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 16).map(function (l) {
    if (!l || typeof l !== 'object') return null;
    var url = typeof l.url === 'string' ? l.url.trim().slice(0, 2000) : '';
    if (!url) return null;
    return { url: url, label: typeof l.label === 'string' ? l.label.trim().slice(0, 80) : '' };
  }).filter(Boolean);
}

function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  return oid ? Number(oid) : null;
}

// Tiny helper — every count query takes the same shape (returns one
// row with a `c` column). Wraps Promise.allSettled-friendly errors
// so one slow / broken table doesn't 500 the whole manifest.
async function safeCount(sql, params) {
  try {
    const r = await pool.query(sql, params);
    return Number((r.rows[0] && r.rows[0].c) || 0);
  } catch (e) {
    console.warn('[manifest] count query failed:', sql.slice(0, 60), e.message);
    return 0;
  }
}

// Static catalogs — kept in lockstep with the client-side registries
// in js/report-templates.js (templates), js/projects.js (layouts),
// and the server STYLE_PACKS set in reports-routes.js (styles).
// Surfacing these via the manifest lets the System Map "Features"
// section render counts like "8 report templates available" without
// the client having to know the lists itself.
const REPORT_TEMPLATE_IDS = [
  'walkthrough', 'daily-log', 'weekly-progress', 'engineers-report',
  'submittal-package', 'punch-list', 'pre-con-survey', 'change-order',
];
const STYLE_PACK_IDS = [
  'clean', 'classic-corporate', 'modern-bold', 'field-notebook',
  'inspection-pro', 'blueprint', 'editorial-spread', 'polaroid-journal',
];
const SECTION_LAYOUT_IDS = [
  'photo-grid', 'single-photo', 'before-after', 'text-block', 'attachment-list',
];

router.get('/manifest', requireAuth, async (req, res) => {
  const orgId = callerOrgId(req);
  if (!orgId) return res.status(403).json({ error: 'Caller has no organization' });

  try {
    // Run all counts in parallel — they're independent.
    // Jobs / leads / estimates / change_orders / schedule_entries
    // join through users (owner_id → users.organization_id).
    // Projects / job_reports / attachments either have direct
    // organization_id or join via the entity's owning user.
    const [
      orgRow,
      jobsActive, jobsCompleted, jobsArchived, jobsLast7d,
      leadsByStatus, leadsLast7d,
      estsByStatus, estsLast7d,
      projectsTotal, projectsWithPhotos, projectsLast7d,
      reportsTotal, reportsLast7d, reportsByTemplate,
      cosByStatus, cosLast7d,
      photosTotal, photosWithAnnos, photosWithTags, photosLast7dUploaded,
      scheduleThisWeek, scheduleNextWeek,
    ] = await Promise.all([
      pool.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]),

      // ── Jobs ─────────────────────────────────────────────────
      safeCount(
        "SELECT COUNT(*)::int c FROM jobs j JOIN users u ON u.id = j.owner_id " +
        " WHERE u.organization_id = $1 " +
        "   AND COALESCE(j.data->>'status','') NOT IN ('Completed','Archived')",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM jobs j JOIN users u ON u.id = j.owner_id " +
        " WHERE u.organization_id = $1 AND j.data->>'status' = 'Completed'",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM jobs j JOIN users u ON u.id = j.owner_id " +
        " WHERE u.organization_id = $1 AND j.data->>'status' = 'Archived'",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM jobs j JOIN users u ON u.id = j.owner_id " +
        " WHERE u.organization_id = $1 AND j.created_at >= NOW() - INTERVAL '7 days'",
        [orgId]
      ),

      // ── Leads (status histogram) ─────────────────────────────
      pool.query(
        "SELECT COALESCE(l.data->>'status','new') AS status, COUNT(*)::int AS c " +
        "  FROM leads l JOIN users u ON u.id = l.owner_id " +
        " WHERE u.organization_id = $1 " +
        " GROUP BY 1",
        [orgId]
      ).catch(() => ({ rows: [] })),
      safeCount(
        "SELECT COUNT(*)::int c FROM leads l JOIN users u ON u.id = l.owner_id " +
        " WHERE u.organization_id = $1 AND l.created_at >= NOW() - INTERVAL '7 days'",
        [orgId]
      ),

      // ── Estimates (BT export status histogram) ───────────────
      pool.query(
        "SELECT COALESCE(e.data->>'bt_export_status','pending') AS status, COUNT(*)::int AS c " +
        "  FROM estimates e JOIN users u ON u.id = e.owner_id " +
        " WHERE u.organization_id = $1 " +
        " GROUP BY 1",
        [orgId]
      ).catch(() => ({ rows: [] })),
      safeCount(
        "SELECT COUNT(*)::int c FROM estimates e JOIN users u ON u.id = e.owner_id " +
        " WHERE u.organization_id = $1 AND e.created_at >= NOW() - INTERVAL '7 days'",
        [orgId]
      ),

      // ── Projects ─────────────────────────────────────────────
      safeCount(
        'SELECT COUNT(*)::int c FROM projects WHERE organization_id = $1 AND archived_at IS NULL',
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(DISTINCT p.id)::int c " +
        "  FROM projects p " +
        "  JOIN attachments a ON a.entity_type = 'project' AND a.entity_id = p.id " +
        " WHERE p.organization_id = $1 AND p.archived_at IS NULL " +
        "   AND a.mime_type LIKE 'image/%'",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM projects " +
        " WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '7 days'",
        [orgId]
      ),

      // ── Reports (job_reports) — entity-polymorphic; project
      //    reports join through projects.organization_id; job-
      //    scoped reports join through job.owner via users. ───
      safeCount(
        "SELECT COUNT(*)::int c FROM job_reports r " +
        " WHERE (r.entity_type = 'project' AND r.entity_id IN ( " +
        "          SELECT id FROM projects WHERE organization_id = $1 ) " +
        "       ) OR ( r.entity_type IS NULL AND r.job_id IN ( " +
        "          SELECT j.id FROM jobs j JOIN users u ON u.id = j.owner_id " +
        "           WHERE u.organization_id = $1 ) " +
        "       )",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM job_reports r " +
        " WHERE r.created_at >= NOW() - INTERVAL '7 days' " +
        "   AND ( (r.entity_type = 'project' AND r.entity_id IN ( " +
        "            SELECT id FROM projects WHERE organization_id = $1)) " +
        "      OR (r.entity_type IS NULL AND r.job_id IN ( " +
        "            SELECT j.id FROM jobs j JOIN users u ON u.id = j.owner_id " +
        "             WHERE u.organization_id = $1)) " +
        "       )",
        [orgId]
      ),
      pool.query(
        "SELECT COALESCE(template_type,'walkthrough') AS template, COUNT(*)::int AS c " +
        "  FROM job_reports r " +
        " WHERE (r.entity_type = 'project' AND r.entity_id IN ( " +
        "         SELECT id FROM projects WHERE organization_id = $1)) " +
        "    OR (r.entity_type IS NULL AND r.job_id IN ( " +
        "         SELECT j.id FROM jobs j JOIN users u ON u.id = j.owner_id " +
        "          WHERE u.organization_id = $1)) " +
        " GROUP BY 1",
        [orgId]
      ).catch(() => ({ rows: [] })),

      // ── Change Orders ────────────────────────────────────────
      pool.query(
        "SELECT co.status, COUNT(*)::int AS c " +
        "  FROM job_change_orders co " +
        "  JOIN jobs j ON j.id = co.job_id " +
        "  JOIN users u ON u.id = j.owner_id " +
        " WHERE u.organization_id = $1 " +
        " GROUP BY 1",
        [orgId]
      ).catch(() => ({ rows: [] })),
      safeCount(
        "SELECT COUNT(*)::int c FROM job_change_orders co " +
        "  JOIN jobs j ON j.id = co.job_id " +
        "  JOIN users u ON u.id = j.owner_id " +
        " WHERE u.organization_id = $1 AND co.created_at >= NOW() - INTERVAL '7 days'",
        [orgId]
      ),

      // ── Photos (attachments where mime_type LIKE 'image/%') ──
      safeCount(
        "SELECT COUNT(*)::int c FROM attachments a " +
        " WHERE a.mime_type LIKE 'image/%' " +
        "   AND a.entity_id IN ( " +
        "     SELECT id::text FROM projects WHERE organization_id = $1 " +
        "     UNION ALL SELECT id FROM leads l JOIN users u ON u.id = l.owner_id WHERE u.organization_id = $1 " +
        "     UNION ALL SELECT id FROM jobs j JOIN users u ON u.id = j.owner_id WHERE u.organization_id = $1 " +
        "   )",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM attachments a " +
        " WHERE a.mime_type LIKE 'image/%' " +
        "   AND jsonb_array_length(COALESCE(a.annotations, '[]'::jsonb)) > 0 " +
        "   AND a.entity_id IN ( " +
        "     SELECT id::text FROM projects WHERE organization_id = $1 " +
        "     UNION ALL SELECT id FROM leads l JOIN users u ON u.id = l.owner_id WHERE u.organization_id = $1 " +
        "     UNION ALL SELECT id FROM jobs j JOIN users u ON u.id = j.owner_id WHERE u.organization_id = $1 " +
        "   )",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM attachments a " +
        " WHERE a.mime_type LIKE 'image/%' " +
        "   AND jsonb_array_length(COALESCE(a.tags, '[]'::jsonb)) > 0 " +
        "   AND a.entity_id IN ( " +
        "     SELECT id::text FROM projects WHERE organization_id = $1 " +
        "     UNION ALL SELECT id FROM leads l JOIN users u ON u.id = l.owner_id WHERE u.organization_id = $1 " +
        "     UNION ALL SELECT id FROM jobs j JOIN users u ON u.id = j.owner_id WHERE u.organization_id = $1 " +
        "   )",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM attachments a " +
        " WHERE a.mime_type LIKE 'image/%' " +
        "   AND a.uploaded_at >= NOW() - INTERVAL '7 days' " +
        "   AND a.entity_id IN ( " +
        "     SELECT id::text FROM projects WHERE organization_id = $1 " +
        "     UNION ALL SELECT id FROM leads l JOIN users u ON u.id = l.owner_id WHERE u.organization_id = $1 " +
        "     UNION ALL SELECT id FROM jobs j JOIN users u ON u.id = j.owner_id WHERE u.organization_id = $1 " +
        "   )",
        [orgId]
      ),

      // ── Schedule entries this week / next week ───────────────
      safeCount(
        "SELECT COUNT(*)::int c FROM schedule_entries s " +
        "  JOIN jobs j ON j.id = s.job_id " +
        "  JOIN users u ON u.id = j.owner_id " +
        " WHERE u.organization_id = $1 " +
        "   AND s.start_date >= date_trunc('week', CURRENT_DATE) " +
        "   AND s.start_date <  date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'",
        [orgId]
      ),
      safeCount(
        "SELECT COUNT(*)::int c FROM schedule_entries s " +
        "  JOIN jobs j ON j.id = s.job_id " +
        "  JOIN users u ON u.id = j.owner_id " +
        " WHERE u.organization_id = $1 " +
        "   AND s.start_date >= date_trunc('week', CURRENT_DATE) + INTERVAL '7 days' " +
        "   AND s.start_date <  date_trunc('week', CURRENT_DATE) + INTERVAL '14 days'",
        [orgId]
      ),
    ]);

    // ── Recent activity ────────────────────────────────────────
    // Pull the 20 most-recent events across reports / change orders
    // / projects / photos. Each row maps into a unified shape so the
    // client can render without knowing the source table.
    let recentActivity = [];
    try {
      const r = await pool.query(
        `(SELECT 'report_created'::text AS kind,
                 ('Report created: ' || COALESCE(title, 'Untitled')) AS summary,
                 created_at AS at, id::text AS link_id
            FROM job_reports r
           WHERE r.created_at >= NOW() - INTERVAL '14 days'
             AND ( (r.entity_type = 'project' AND r.entity_id IN (
                       SELECT id FROM projects WHERE organization_id = $1))
                OR (r.entity_type IS NULL AND r.job_id IN (
                       SELECT j.id FROM jobs j JOIN users u ON u.id = j.owner_id
                        WHERE u.organization_id = $1)))
           ORDER BY created_at DESC LIMIT 10)
         UNION ALL
         (SELECT 'change_order_opened'::text AS kind,
                 ('CO opened: ' || COALESCE(co_number, id)) AS summary,
                 co.created_at AS at, co.id::text AS link_id
            FROM job_change_orders co
            JOIN jobs j ON j.id = co.job_id
            JOIN users u ON u.id = j.owner_id
           WHERE u.organization_id = $1 AND co.created_at >= NOW() - INTERVAL '14 days'
           ORDER BY co.created_at DESC LIMIT 10)
         UNION ALL
         (SELECT 'project_created'::text AS kind,
                 ('Project created: ' || name) AS summary,
                 created_at AS at, id::text AS link_id
            FROM projects
           WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
           ORDER BY created_at DESC LIMIT 10)
         ORDER BY at DESC LIMIT 20`,
        [orgId]
      );
      recentActivity = r.rows.map(function (x) {
        return { kind: x.kind, summary: x.summary, when: x.at, link_id: x.link_id };
      });
    } catch (e) {
      console.warn('[manifest] recent activity query failed:', e.message);
    }

    // ── Histogram → object helpers ─────────────────────────────
    function histToObj(rows) {
      const out = {};
      (rows || []).forEach(function (r) { out[r.status || r.template || 'unknown'] = Number(r.c) || 0; });
      return out;
    }

    // Plan entitlements (SaaS scaffold). The client can read this to
    // hide/disable surfaces a plan doesn't include — though today AGX
    // is 'internal' (unlimited) so `unlimited:true` and the client
    // should gate nothing. Resolved + cached in entitlements.js; a
    // lookup blip falls back to the default (unlimited) plan.
    let ent;
    try {
      ent = await entitlements.entitlementsFor(orgId);
    } catch (e) {
      console.warn('[manifest] entitlements lookup failed:', e.message);
      ent = { plan_key: 'internal', plan_name: 'Internal', plan_status: 'active', unlimited: true, limits: {}, features: {} };
    }

    res.json({
      org: orgRow.rows[0] || { id: orgId, name: null },
      generated_at: new Date().toISOString(),
      entitlements: ent,
      entities: {
        jobs: {
          active: jobsActive,
          completed: jobsCompleted,
          archived: jobsArchived,
          last_7d_created: jobsLast7d,
        },
        leads: Object.assign(
          { last_7d_created: leadsLast7d },
          histToObj(leadsByStatus.rows)
        ),
        estimates: Object.assign(
          { last_7d_created: estsLast7d },
          histToObj(estsByStatus.rows)
        ),
        projects: {
          total: projectsTotal,
          with_photos: projectsWithPhotos,
          last_7d_created: projectsLast7d,
        },
        reports: {
          total: reportsTotal,
          last_7d_created: reportsLast7d,
          by_template: histToObj(reportsByTemplate.rows),
        },
        change_orders: Object.assign(
          { last_7d_created: cosLast7d },
          histToObj(cosByStatus.rows)
        ),
        photos: {
          total: photosTotal,
          with_annotations: photosWithAnnos,
          with_tags: photosWithTags,
          last_7d_uploaded: photosLast7dUploaded,
        },
        schedule: {
          entries_this_week: scheduleThisWeek,
          entries_next_week: scheduleNextWeek,
        },
      },
      catalog: {
        report_templates: REPORT_TEMPLATE_IDS,
        style_packs: STYLE_PACK_IDS,
        section_layouts: SECTION_LAYOUT_IDS,
      },
      features: features,
      whats_new: whats_new,
      recent_activity: recentActivity,
    });
  } catch (e) {
    console.error('GET /api/org/manifest error:', e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

// GET /api/org/logo — streams the org's branding logo bytes SAME-ORIGIN so
// the shop-drawing titleblock can draw it on a canvas and still export to
// PNG/PDF without tainting (R2 logo URLs are cross-origin). Bounded: only
// the org's own admin-set logo_url, http(s) only, image content-types only.
router.get('/logo', requireAuth, async (req, res) => {
  const orgId = callerOrgId(req);
  if (!orgId) return res.status(403).end();
  try {
    const r = await pool.query('SELECT branding FROM organizations WHERE id = $1', [orgId]);
    const b = (r.rows[0] && r.rows[0].branding) || {};
    let url = typeof b.logo_url === 'string' ? b.logo_url.trim() : '';
    // ?i=N streams a specific logo from the logos[] library (titleblock picker).
    if (req.query.i != null && Array.isArray(b.logos)) {
      const li = b.logos[parseInt(req.query.i, 10)];
      if (li && typeof li.url === 'string') url = li.url.trim();
    }
    if (!url || !/^https?:\/\//i.test(url)) return res.status(404).end();
    if (typeof fetch !== 'function') return res.status(501).end();
    const upstream = await fetch(url, { redirect: 'follow' });
    if (!upstream.ok) return res.status(502).end();
    const ct = upstream.headers.get('content-type') || 'image/png';
    if (!/^image\//i.test(ct)) return res.status(415).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (e) {
    console.error('GET /api/org/logo error:', e);
    return res.status(500).end();
  }
});

// GET /api/org/branding — the caller's org name + branding kit (logo URL,
// colors, footer line). Any authenticated user in the org may read it; this
// is surface metadata, not record data. Powers the shop-drawing titleblock
// logo (and any future branded surface). The admin *write* path lives in
// admin-organizations-routes.js and is intentionally not touched here.
router.get('/branding', requireAuth, async (req, res) => {
  const orgId = callerOrgId(req);
  if (!orgId) return res.status(403).json({ error: 'Caller has no organization' });
  try {
    const r = await pool.query('SELECT name, branding FROM organizations WHERE id = $1', [orgId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Organization not found' });
    const row = r.rows[0];
    const b = (row.branding && typeof row.branding === 'object') ? row.branding : {};
    res.json({
      name: row.name || '',
      branding: {
        logo_url: typeof b.logo_url === 'string' ? b.logo_url : '',
        logos: normLogos(b.logos),
        primary_color: typeof b.primary_color === 'string' ? b.primary_color : '',
        accent_color: typeof b.accent_color === 'string' ? b.accent_color : '',
        footer_address: typeof b.footer_address === 'string' ? b.footer_address : '',
      },
    });
  } catch (e) {
    console.error('GET /api/org/branding error:', e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

// PUT /api/org/branding — admin-gated write of the FULL branding kit incl. a
// multi-logo library (logos[]). Merges into the caller's org branding so the
// colors/footer + logos persist together. (The locked admin route only keeps
// 4 whitelisted fields and would drop logos, so branding saves route here.)
router.put('/branding', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  const orgId = callerOrgId(req);
  if (!orgId) return res.status(403).json({ error: 'Caller has no organization' });
  try {
    const cur = (await pool.query('SELECT branding FROM organizations WHERE id = $1', [orgId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Organization not found' });
    const b = (cur.branding && typeof cur.branding === 'object') ? Object.assign({}, cur.branding) : {};
    const body = req.body || {};
    if (typeof body.logo_url === 'string') b.logo_url = body.logo_url.slice(0, 2000);
    if (Array.isArray(body.logos)) b.logos = normLogos(body.logos);
    if (typeof body.primary_color === 'string' && /^#[0-9a-f]{3,8}$/i.test(body.primary_color)) b.primary_color = body.primary_color;
    if (typeof body.accent_color === 'string' && /^#[0-9a-f]{3,8}$/i.test(body.accent_color)) b.accent_color = body.accent_color;
    if (typeof body.footer_address === 'string') b.footer_address = body.footer_address.slice(0, 500);
    // Keep the primary logo_url consistent with the library so the titleblock
    // + email (which read logo_url) always resolve to a real logo.
    if (Array.isArray(b.logos) && b.logos.length) {
      const has = b.logo_url && b.logos.some(function (l) { return l.url === b.logo_url; });
      if (!has) b.logo_url = b.logos[0].url;
    }
    await pool.query('UPDATE organizations SET branding = $2::jsonb, updated_at = NOW() WHERE id = $1', [orgId, JSON.stringify(b)]);
    res.json({ ok: true, branding: b });
  } catch (e) {
    console.error('PUT /api/org/branding error:', e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

module.exports = router;
