// Map data — combined leads + jobs feed for the Summary page's
// "combined map" (Phase 1 / Deliverable 2).
//
// ONE read-only endpoint: GET /api/map/entities returns every lead and
// job in the caller's org that has a usable geocoded position, shaped
// for the client-side entities map (js/entities-map.js):
//   { leads:[{id,title,lat,lng,kind}], jobs:[{id,title,lat,lng,kind}] }
//
// Org scoping: both the `leads` and `jobs` tables carry a direct
// organization_id column (filled by the Wave 1.A org backfill). We scope
// on it the SAME way the list endpoints do — including NULL-org legacy
// rows so unbackfilled data stays visible to its own org until the NOT
// NULL tightening. Coordinates come from the shared geocode_lat /
// geocode_lng columns the Jobs + Leads maps already plot from.
//
// Null-island guard: a row whose coords are missing, non-finite, exactly
// 0,0, or outside real lat/lng ranges is dropped (mirrors projectCoords()
// in js/projects-map.js so the two surfaces agree on what's "mapped").
//
// Capability: requireAuth only. The Summary map is a glanceable overview;
// any authed user in the org may see their org's pins, matching the
// org-manifest snapshot posture. (LEADS_VIEW/JOBS_* gate the full list
// surfaces; this returns only id/title/coords, no record-level detail.)

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const jobTypes = require('../services/job-types');

const router = express.Router();

// Accept a row's geocode columns only if they describe a real-world
// point. Mirrors projectCoords() in js/projects-map.js exactly so the
// combined map and the per-entity maps never disagree on plottability.
function usableCoords(lat, lng) {
  const a = Number(lat);
  const o = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(o)) return null;
  if (a === 0 && o === 0) return null;            // Null Island
  if (a < -90 || a > 90 || o < -180 || o > 180) return null;
  return { lat: a, lng: o };
}

// GET /api/map/entities — org-scoped leads + jobs with plottable coords.
router.get('/entities', requireAuth, async (req, res) => {
  try {
    const orgId = req.user && req.user.organization_id;
    // No org → nothing to plot (defensive; shouldn't happen post-backfill).
    if (!orgId) return res.json({ leads: [], jobs: [] });

    // Leads: title is a first-class column; coords from geocode_*.
    // Org filter matches GET /api/leads (NULL-org legacy rows included).
    // project_type + next_followup_at feed the Leads map's filters; neither is
    // financial, which matters because this endpoint is requireAuth-only.
    const leadsQ = pool.query(
      `SELECT l.id, l.title, l.status, l.street_address, l.city, l.state, l.zip,
              l.geocode_lat, l.geocode_lng, l.project_type, l.next_followup_at
         FROM leads l
        WHERE (l.organization_id = $1 OR l.organization_id IS NULL)
          AND l.bt_archived_at IS NULL
          AND l.geocode_lat IS NOT NULL AND l.geocode_lng IS NOT NULL`,
      [orgId]
    );

    // Jobs: display title + jobNumber live in the `data` JSONB; coords
    // are real columns. Org filter matches GET /api/jobs.
    const jobsQ = pool.query(
      `SELECT j.id, j.data, j.geocode_address, j.geocode_lat, j.geocode_lng
         FROM jobs j
        WHERE (j.organization_id = $1 OR j.organization_id IS NULL)
          AND j.geocode_lat IS NOT NULL AND j.geocode_lng IS NOT NULL`,
      [orgId]
    );

    // The org's job-type registry, so TYPE comes from the job number's prefix
    // the same way POST /api/jobs/convert derives it. A job's type must agree
    // with its number (the converted-job-type invariant); reading data.jobType
    // instead would let the map filter disagree with the job itself.
    const brandQ = pool.query('SELECT branding FROM organizations WHERE id = $1', [orgId])
      .catch(function () { return { rows: [] }; });

    const [leadsR, jobsR, brandR] = await Promise.all([leadsQ, jobsQ, brandQ]);
    const orgJobTypes = (brandR.rows[0] && brandR.rows[0].branding && brandR.rows[0].branding.job_types) || null;

    const leads = [];
    for (const r of leadsR.rows) {
      const c = usableCoords(r.geocode_lat, r.geocode_lng);
      if (!c) continue;
      leads.push({
        id: r.id,
        title: r.title || 'Untitled lead',
        lat: c.lat,
        lng: c.lng,
        kind: 'lead',
        status: r.status || '',
        projectType: r.project_type || '',
        followupAt: r.next_followup_at || null,
        // Assembled one-line address for the "Open in Google Maps" link
        // (coords are preferred client-side; this is the fallback label).
        address: [r.street_address, [r.city, r.state, r.zip].filter(Boolean).join(', ')]
          .filter(Boolean).join(', ')
      });
    }

    const jobs = [];
    for (const r of jobsR.rows) {
      const c = usableCoords(r.geocode_lat, r.geocode_lng);
      if (!c) continue;
      const data = r.data || {};
      const num = data.jobNumber || data.job_number || '';
      const name = data.title || data.name || 'Untitled job';
      jobs.push({
        id: r.id,
        title: num ? (num + ' — ' + name) : name,
        lat: c.lat,
        lng: c.lng,
        // Carry the job-number prefix so the client's typeForEntity()
        // can classify reno/wo/service vs generic job for the pin icon.
        kind: 'job',
        jobNumber: num,
        status: (typeof data.status === 'string' ? data.status : ''),
        // From the number's prefix via the org registry — the canonical
        // derivation. Falls back to the stored label only for a job whose
        // number carries no recognised prefix (hand-typed legacy numbers).
        jobType: (num && jobTypes.labelForNumber(num, orgJobTypes)) ||
          (typeof data.jobType === 'string' ? data.jobType : ''),
        // CREW ON SITE — the hook for time clocks, deliberately null today.
        // There is no clock-in data anywhere in the system yet, and a map that
        // guessed "running" from job status would teach people to trust a
        // signal that isn't there. When time clocks land, this becomes one
        // join (open clock-ins for this job) and the map's Crew-on-site filter
        // and pin marker light up with no client change.
        crewOnSite: null,
        // Address label for the "Open in Google Maps" link (coords win
        // client-side). Prefer the exact geocoded string, then the canonical
        // data.address, then the first building's address.
        address: (r.geocode_address && String(r.geocode_address).trim()) ||
          (data.address && String(data.address).trim()) ||
          ((Array.isArray(data.buildings) && data.buildings[0] && data.buildings[0].address) || '')
      });
    }

    res.json({ leads, jobs });
  } catch (e) {
    console.error('GET /api/map/entities error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
