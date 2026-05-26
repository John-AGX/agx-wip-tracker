// Report template registry — Wave B. Each template defines:
//   - id              : short string stored in job_reports.template_type
//   - label / icon    : picker UI
//   - description     : short blurb for the picker tile
//   - cover_schema    : ordered list of cover-page fields the editor
//                       surfaces (matches keys in normalizeCoverPage's
//                       whitelist server-side)
//   - cover_defaults  : function(p, user) → initial cover values when
//                       the report is created
//   - seed_sections   : array of { label, layout } that auto-populate
//                       the report on create (only for fresh reports
//                       — existing sections always win)
//
// Layouts referenced by seed_sections come from Wave B3 (see
// js/projects.js sectionHTML). 'photo-grid' is the historical default
// and always available.
//
// The 8 ids here must stay in lockstep with TEMPLATE_TYPES in
// server/routes/reports-routes.js. A mismatch causes the server to
// clamp the type back to 'walkthrough'.
(function () {
  'use strict';

  function today() {
    return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  // Helpers to keep cover_defaults terse.
  function pmName(user) { return (user && user.name) || ''; }
  function projAddr(p) { return (p && p.address_text) || ''; }
  function projName(p) { return (p && p.name) || ''; }

  var TEMPLATES = [
    {
      id: 'walkthrough',
      label: 'Photo Walkthrough',
      icon: 'photos',
      description: 'Sections of photos with captions. The classic field report.',
      cover_schema: ['company_name', 'subtitle', 'pm_name', 'date', 'address'],
      cover_defaults: function (p, u) {
        return {
          company_name: '',
          subtitle: 'Walkthrough Report',
          pm_name: pmName(u),
          date: today(),
          address: projAddr(p)
        };
      },
      seed_sections: [
        { label: 'Exterior', layout: 'photo-grid' },
        { label: 'Roof', layout: 'photo-grid' },
        { label: 'Interior', layout: 'photo-grid' }
      ]
    },
    {
      id: 'daily-log',
      label: 'Daily Log',
      icon: 'daily-logs',
      description: 'Date, weather, crew, hours — narrative + photos from the field.',
      cover_schema: ['date', 'crew', 'weather', 'hours_on_site'],
      cover_defaults: function (p, u) {
        return {
          date: today(),
          crew: '',
          weather: '',
          hours_on_site: ''
        };
      },
      seed_sections: [
        { label: 'Work performed today', layout: 'text-block' },
        { label: 'Photos from the field', layout: 'photo-grid' },
        { label: 'Issues / RFIs', layout: 'text-block' }
      ]
    },
    {
      id: 'weekly-progress',
      label: 'Weekly Progress',
      icon: 'insights',
      description: 'Week summary, work-by-area, schedule status, photo evidence.',
      cover_schema: ['week_ending', 'project_phase', 'schedule_status', 'pm_name'],
      cover_defaults: function (p, u) {
        return {
          week_ending: today(),
          project_phase: '',
          schedule_status: 'On schedule',
          pm_name: pmName(u)
        };
      },
      seed_sections: [
        { label: 'Week summary', layout: 'text-block' },
        { label: 'Work completed', layout: 'photo-grid' },
        { label: 'Looking ahead', layout: 'text-block' }
      ]
    },
    {
      id: 'engineers-report',
      label: "Engineer's Report",
      icon: 'admin',
      description: 'Assessment narrative + observations + recommendations + signed footer.',
      cover_schema: ['stamped_by', 'license_number', 'signed_date', 'address'],
      cover_defaults: function (p, u) {
        return {
          stamped_by: pmName(u),
          license_number: '',
          signed_date: today(),
          address: projAddr(p)
        };
      },
      seed_sections: [
        { label: 'Scope of inspection', layout: 'text-block' },
        { label: 'Observations', layout: 'photo-grid' },
        { label: 'Recommendations', layout: 'text-block' },
        { label: 'Photographic evidence', layout: 'photo-grid' }
      ]
    },
    {
      id: 'submittal-package',
      label: 'Product Submittal',
      icon: 'attachments',
      description: 'Cover sheet + spec PDFs + install-context photos. For owner approval.',
      cover_schema: ['submittal_number', 'spec_section', 'supplier', 'approval_block'],
      cover_defaults: function (p, u) {
        return {
          submittal_number: '',
          spec_section: '',
          supplier: '',
          approval_block: ''
        };
      },
      seed_sections: [
        { label: 'Product information', layout: 'text-block' },
        { label: 'Manufacturer cut sheets', layout: 'attachment-list' },
        { label: 'Installation context', layout: 'photo-grid' }
      ]
    },
    {
      id: 'punch-list',
      label: 'Punch List / QC',
      icon: 'reset',
      description: 'Itemized findings with status, photo, location. Final walkthrough.',
      cover_schema: ['walkthrough_date', 'walkthrough_with', 'pm_name'],
      cover_defaults: function (p, u) {
        return {
          walkthrough_date: today(),
          walkthrough_with: '',
          pm_name: pmName(u)
        };
      },
      seed_sections: [
        { label: 'Exterior items', layout: 'photo-grid' },
        { label: 'Interior items', layout: 'photo-grid' },
        { label: 'Outstanding', layout: 'text-block' }
      ]
    },
    {
      id: 'pre-con-survey',
      label: 'Pre-Construction Survey',
      icon: 'buildings',
      description: 'Building / room sections with before-condition photos. Renovation baseline.',
      cover_schema: ['survey_date', 'surveyed_by', 'building', 'address'],
      cover_defaults: function (p, u) {
        return {
          survey_date: today(),
          surveyed_by: pmName(u),
          building: projName(p),
          address: projAddr(p)
        };
      },
      seed_sections: [
        { label: 'Exterior condition', layout: 'photo-grid' },
        { label: 'Roof condition', layout: 'photo-grid' },
        { label: 'Interior — common areas', layout: 'photo-grid' },
        { label: 'Notes', layout: 'text-block' }
      ]
    },
    {
      id: 'change-order',
      label: 'Change Order Justification',
      icon: 'edit',
      description: 'Narrative + condition photos showing why a CO is needed.',
      cover_schema: ['co_number', 'co_amount', 'requested_by', 'date'],
      cover_defaults: function (p, u) {
        return {
          co_number: '',
          co_amount: '',
          requested_by: pmName(u),
          date: today()
        };
      },
      seed_sections: [
        { label: 'Existing condition', layout: 'photo-grid' },
        { label: 'Justification narrative', layout: 'text-block' },
        { label: 'Proposed scope', layout: 'text-block' }
      ]
    }
  ];

  // Cover-field label + input-type lookup. Drives the editor's
  // dynamic fieldset render in js/projects.js. Defaults to a
  // single-line text input; the few date / longer-text fields are
  // explicit. Labels are sentence-case for the editor; templates
  // pick which subset to show via cover_schema.
  var COVER_FIELD_META = {
    company_name:     { label: 'Company name',       type: 'text',     placeholder: 'Your company (leave blank to use org name)' },
    subtitle:         { label: 'Subtitle',           type: 'text',     placeholder: 'e.g. Walkthrough Report, Damage Assessment' },
    pm_name:          { label: 'Prepared by',        type: 'text',     placeholder: 'PM name' },
    date:             { label: 'Date',               type: 'text',     placeholder: 'Today' },
    address:          { label: 'Address',            type: 'text',     placeholder: 'Site address' },
    crew:             { label: 'Crew on site',       type: 'text',     placeholder: 'Names / count' },
    weather:          { label: 'Weather',            type: 'text',     placeholder: 'Sunny, 78°F' },
    hours_on_site:    { label: 'Hours on site',      type: 'text',     placeholder: '8h' },
    week_ending:      { label: 'Week ending',        type: 'text',     placeholder: 'Friday' },
    project_phase:    { label: 'Project phase',      type: 'text',     placeholder: 'Framing, Drywall, Punch…' },
    schedule_status:  { label: 'Schedule status',    type: 'text',     placeholder: 'On track / 2 days behind / etc.' },
    stamped_by:       { label: 'Stamped by',         type: 'text',     placeholder: 'Engineer name' },
    license_number:   { label: 'License #',          type: 'text',     placeholder: 'P.E. license #' },
    signed_date:      { label: 'Signed date',        type: 'text',     placeholder: 'Today' },
    submittal_number: { label: 'Submittal #',        type: 'text',     placeholder: 'e.g. 03-30-13.01' },
    spec_section:     { label: 'Spec section',       type: 'text',     placeholder: 'Spec division.section' },
    supplier:         { label: 'Supplier / vendor',  type: 'text',     placeholder: 'Manufacturer or distributor' },
    approval_block:   { label: 'Approval notes',     type: 'textarea', placeholder: 'For engineer / owner review' },
    walkthrough_date: { label: 'Walkthrough date',   type: 'text',     placeholder: 'Today' },
    walkthrough_with: { label: 'Walked with',        type: 'text',     placeholder: 'Owner / GC / subs present' },
    survey_date:      { label: 'Survey date',        type: 'text',     placeholder: 'Today' },
    surveyed_by:      { label: 'Surveyed by',        type: 'text',     placeholder: 'Name' },
    building:         { label: 'Building',           type: 'text',     placeholder: 'Bldg name or #' },
    co_number:        { label: 'CO #',               type: 'text',     placeholder: 'CO-001' },
    co_amount:        { label: 'CO amount',          type: 'text',     placeholder: '$' },
    requested_by:     { label: 'Requested by',       type: 'text',     placeholder: 'Owner / GC' }
  };

  function list() { return TEMPLATES.slice(); }
  function get(id) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return TEMPLATES[0]; // walkthrough fallback
  }
  function coverFieldMeta(key) {
    return COVER_FIELD_META[key] || { label: key, type: 'text', placeholder: '' };
  }

  window.p86ReportTemplates = {
    list: list,
    get: get,
    coverFieldMeta: coverFieldMeta
  };
})();
