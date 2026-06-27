// Feature catalog — the discoverability source of truth.
//
// Two ordered arrays:
//   features  — every user-facing capability in the app, grouped by area.
//               Rendered in the Help & What's New overlay (avatar
//               dropdown → "Help & What's New") as the Features matrix
//               (name + blurb + where to find it). When a new feature
//               ships, add an entry here.
//   whats_new — newest-first list of recently shipped things. Drives
//               the What's New section of that same overlay + the
//               "(N new)" badge (badge clears when user opens it).
//
// Both arrays are also exposed via GET /api/org/manifest so any future
// 86 introspection tool could read them without database access.
//
// Conventions:
//   id          unique kebab-case string (used in localStorage keys)
//   label       short, sentence-case title (under ~40 chars)
//   blurb       one-line value prop (under ~120 chars)
//   access_path human-readable navigation path (e.g. "Project detail
//               → Reports tab → + Create"). Tells the user where to
//               find this feature in the UI.
//   area        bucket for grouping: 'Photos' | 'Reports' | 'Schedule'
//               | 'Estimating' | 'Jobs' | 'Org' | 'AI' | 'Mobile'
//   shipped     ISO date string. Drives whats_new ordering.

'use strict';

const features = [
  // ── Photos ──────────────────────────────────────────────────
  {
    id: 'photo-viewer-side-panel',
    label: 'Photo viewer with side panel',
    blurb: 'Click any photo to open a full viewer with tags, description, comments, and annotate-in-place tools.',
    access_path: 'Click any photo tile (project, lead, estimate, or job)',
    area: 'Photos',
    shipped: '2026-05-23',
  },
  {
    id: 'photo-comments',
    label: 'Photo comments',
    blurb: 'Discussion threads on any photo. Teammates can post + reply right next to the image.',
    access_path: 'Open photo → side panel → Comments',
    area: 'Photos',
    shipped: '2026-05-23',
  },
  {
    id: 'photo-tag-picker',
    label: 'Tag picker with Create + Favorites',
    blurb: 'Pick from your org\'s most-used tags or create a new one without leaving the photo viewer.',
    access_path: 'Open photo → side panel → Add Tag',
    area: 'Photos',
    shipped: '2026-05-24',
  },
  {
    id: 'photo-annotate',
    label: 'Annotate any photo',
    blurb: 'Draw arrows, text, measurements directly on a photo. Strokes save alongside the original (no rasterization).',
    access_path: 'Open photo → ✎ Annotate, or pencil icon on the tile',
    area: 'Photos',
    shipped: '2026-05-21',
  },
  {
    id: 'tile-size-picker',
    label: 'Photo tile size picker',
    blurb: 'Toggle Compact / Normal / Spacious tile density on the project photo feed.',
    access_path: 'My Files → Project → tile-size buttons (top-right)',
    area: 'Photos',
    shipped: '2026-05-25',
  },

  // ── Reports ─────────────────────────────────────────────────
  {
    id: 'report-templates',
    label: '8 report templates',
    blurb: 'Walkthrough, Daily Log, Weekly Progress, Engineer\'s, Submittal Package, Punch List, Pre-Con Survey, Change Order Justification.',
    access_path: 'Project → Reports tab → + Create Report → pick a template',
    area: 'Reports',
    shipped: '2026-05-25',
  },
  {
    id: 'report-section-layouts',
    label: 'Section layout variants',
    blurb: 'Each section picks one of five layouts: photo grid, single photo, before / after, text block, attachment list.',
    access_path: 'Report editor → section header → layout dropdown',
    area: 'Reports',
    shipped: '2026-05-25',
  },
  {
    id: 'report-style-packs',
    label: '8 visual style packs',
    blurb: 'Classic Corporate, Modern Bold, Field Notebook, Inspection Pro, Blueprint, Editorial Spread, Polaroid Journal, Clean.',
    access_path: 'Report editor → Design button',
    area: 'Reports',
    shipped: '2026-05-26',
  },
  {
    id: 'report-cover-page',
    label: 'Per-template cover pages',
    blurb: 'Each template has its own cover schema — daily logs get crew + weather + hours, engineer\'s reports get stamp + license, submittals get spec section, etc.',
    access_path: 'Report editor → Include cover page toggle',
    area: 'Reports',
    shipped: '2026-05-25',
  },
  {
    id: 'reports-long-card-list',
    label: 'Long-card reports list with search',
    blurb: 'Browse every report in a long-card list (thumbnail + title + date) with a Find-a-report typeahead.',
    access_path: 'My Files → Reports section',
    area: 'Reports',
    shipped: '2026-05-25',
  },

  // ── Schedule ────────────────────────────────────────────────
  {
    id: 'schedule-mobile-drawer',
    label: 'Schedule mobile drawer',
    blurb: 'On phone, the job sidebar collapses to a slide-out drawer (☰ button) so the calendar takes the full viewport.',
    access_path: 'Schedule tab on phone',
    area: 'Schedule',
    shipped: '2026-05-26',
  },
  {
    id: 'schedule-day-at-glance',
    label: 'Day-at-glance sheet',
    blurb: 'Tap any day to see scheduled jobs + revenue + hours in a sheet.',
    access_path: 'Schedule tab → tap a day',
    area: 'Schedule',
    shipped: '2026-04-12',
  },

  // ── Jobs / Estimating ──────────────────────────────────────
  {
    id: 'change-orders',
    label: 'Change Orders',
    blurb: 'Open + track CO requests on a job. Income + cost + approval status all in one place.',
    access_path: 'Job detail → Change Orders section → + Add',
    area: 'Jobs',
    shipped: '2026-05-26',
  },
  {
    id: 'edit-gate',
    label: 'Edit-gate (pencil to unlock)',
    blurb: 'Forms render as read-only-looking text until you tap the pencil — protects against accidental taps on phone.',
    access_path: 'Lead editor, client editor, estimate line items, phase rows',
    area: 'Estimating',
    shipped: '2026-05-19',
  },
  {
    id: 'estimate-totals-chip',
    label: 'Estimate totals chip strip',
    blurb: 'Live totals (Subtotal / Margin / Total Price) pinned at the top of the editor with target-margin gating.',
    access_path: 'Estimate editor',
    area: 'Estimating',
    shipped: '2026-05-27',
  },

  // ── Org ─────────────────────────────────────────────────────
  {
    id: 'internal-users-directory',
    label: 'Internal Users directory',
    blurb: 'Roster of every user in your org with phone + email — find that PM\'s number without leaving the app.',
    access_path: 'Header → Directory dropdown → Internal Users',
    area: 'Org',
    shipped: '2026-05-22',
  },
  {
    id: 'my-files',
    label: 'My Files (per-user files)',
    blurb: 'Your personal files in a real folder tree — create, drag-and-drop, move, rename. The same Explorer is built into every job, client, project, lead, and estimate.',
    access_path: 'Header → 📁 icon (right cluster)',
    area: 'Org',
    shipped: '2026-04-30',
  },

  // ── AI ──────────────────────────────────────────────────────
  {
    id: 'ask-86',
    label: 'Ask 86 (your AI assistant)',
    blurb: 'Your personal AI assistant — reads your data, runs your calendar / tasks / reminders, finds things near you, and makes changes with a quick review. Escalates deep estimating + job-costing to 86 (the expert) behind the scenes.',
    access_path: 'Header → 86 button (anywhere in the app)',
    area: 'AI',
    shipped: '2026-04-15',
  },
  {
    id: 'voice-input',
    label: 'Voice input',
    blurb: 'Dictate captions + chat messages with the mic button. Shared helper across chat, walkthrough, and caption fields.',
    access_path: 'Mic button next to text inputs',
    area: 'AI',
    shipped: '2026-05-26',
  },

  // ── Field tools ─────────────────────────────────────────────
  {
    id: 'field-tools',
    label: 'Field Tools',
    blurb: 'Self-contained calculators, lookups, and forms the team uses on phones. 86 can spin one up on demand.',
    access_path: 'Field Tools (its own tab, left sidebar)',
    area: 'Mobile',
    shipped: '2026-05-12',
  },
  {
    id: 'field-tool-printouts',
    label: 'Field Tool Printouts',
    blurb: 'Save any field-tool calculation as a receipt-style record. Print or reference from Field Tools → Printouts.',
    access_path: 'Open a field tool → 💾 Save Printout',
    area: 'Mobile',
    shipped: '2026-05-27',
  },

  // ── Leads & Jobs (net-new this cycle) ───────────────────────
  {
    id: 'leads-pipeline',
    label: 'Leads pipeline',
    blurb: 'Track every lead with status, value, salesperson, photos, weather, and a map. Bulk-import from Buildertrend.',
    access_path: 'Leads (left sidebar)',
    area: 'Jobs',
    shipped: '2026-06-02',
  },
  {
    id: 'lead-to-job',
    label: 'Create a job from a lead or estimate',
    blurb: 'One click turns a won lead (or its estimate) into a job — the contract pulls the estimate\'s total, costs flow in, and the job links back to its source.',
    access_path: 'Lead or Estimate → Create Job',
    area: 'Jobs',
    shipped: '2026-06-24',
  },
  {
    id: 'leads-jobs-map',
    label: 'Leads + Jobs map',
    blurb: 'Every geocoded lead and job as a pin, grouped by address — your whole pipeline on one map.',
    access_path: 'Summary map, or Leads → Map view',
    area: 'Jobs',
    shipped: '2026-06-23',
  },
  {
    id: 'address-autocomplete',
    label: 'Address autocomplete',
    blurb: 'Start typing an address and pick the real one — it fills the fields and captures exact coordinates as you go.',
    access_path: 'Any address field (lead, job, estimate, client)',
    area: 'Jobs',
    shipped: '2026-06-24',
  },
  {
    id: 'site-plan',
    label: 'Site Plan view',
    blurb: 'A spatial map of a job — buildings traced on a satellite basemap, photo-GPS pins, and a 3D massing toggle.',
    access_path: 'Job → Site Plan',
    area: 'Jobs',
    shipped: '2026-06-22',
  },

  // ── Projects ────────────────────────────────────────────────
  {
    id: 'projects',
    label: 'Projects',
    blurb: 'Dedicated project workspaces — photo feeds, reports, before/after pairs, tags, a map, and an activity log, linked to a job/lead/client.',
    access_path: 'Projects (left sidebar)',
    area: 'Jobs',
    shipped: '2026-06-08',
  },

  // ── Purchase Orders ─────────────────────────────────────────
  {
    id: 'purchase-orders',
    label: 'Purchase Orders',
    blurb: 'Sub scope-of-work contracts on a job — vendor, scope template, amounts, attachments, bills + lien waivers, and approval.',
    access_path: 'Job detail → Purchase Orders (or the + menu)',
    area: 'Jobs',
    shipped: '2026-06-15',
  },

  // ── Tasks / Day / Comms ─────────────────────────────────────
  {
    id: 'tasks-3tier',
    label: 'Tasks, to-dos & reminders',
    blurb: 'Three levels: assignable org Tasks, your private To-dos, and timed Reminders that email you. Attach any to a job, lead, or client.',
    access_path: 'My Tasks, the header + menu, or any record\'s Tasks panel',
    area: 'Org',
    shipped: '2026-06-12',
  },
  {
    id: 'my-day',
    label: 'My Day',
    blurb: 'One time-ordered view of today — appointments, reminders, and due tasks, each linked to its job or client.',
    access_path: 'My Day (left sidebar)',
    area: 'Org',
    shipped: '2026-06-16',
  },
  {
    id: 'calendar',
    label: 'Personal calendar',
    blurb: 'Appointments + events layered on the schedule, color-coded by status, with optional reminders — separate from production blocks.',
    access_path: 'Schedule → My Events layer / + Event',
    area: 'Schedule',
    shipped: '2026-06-19',
  },
  {
    id: 'messages-dm',
    label: 'Messages (direct messages)',
    blurb: 'Direct-message teammates inside the app, with a recipient picker and unread badges.',
    access_path: 'Messages (left sidebar)',
    area: 'Org',
    shipped: '2026-06-16',
  },

  // ── Files & Plans ───────────────────────────────────────────
  {
    id: 'file-explorer',
    label: 'File system everywhere',
    blurb: 'A real Windows-style Explorer — nested folders, drag-and-drop, move/rename — on My Files and on every job, client, project, lead, and estimate.',
    access_path: 'Files on any record, or the Files tab',
    area: 'Org',
    shipped: '2026-06-05',
  },
  {
    id: 'plans-takeoffs',
    label: 'Plans & Takeoffs',
    blurb: 'Import a plan PDF, calibrate the scale from two points, then measure linear feet, area, counts, and angles — and save the takeoff.',
    access_path: 'Field Tools → Plans & Takeoffs',
    area: 'Mobile',
    shipped: '2026-06-08',
  },
  {
    id: 'drafting-sheets',
    label: 'Drafting sheets (CAD)',
    blurb: 'A precision drawing surface — lines, dimensions, layers, hatch, symbols, titleblock — with snaps, trim/extend/fillet, and DXF/PDF export.',
    access_path: 'Field Tools → Plans & Takeoffs → new sheet',
    area: 'Mobile',
    shipped: '2026-06-12',
  },

  // ── AI ──────────────────────────────────────────────────────
  {
    id: 'location-aware-ai',
    label: 'Location-aware AI',
    blurb: 'Share your location and ask "what jobs or leads are near me" — the assistant answers by distance.',
    access_path: '86 / Assistant chat',
    area: 'AI',
    shipped: '2026-06-24',
  },
  {
    id: 'assistant-quick-adds',
    label: 'Instant AI quick-adds',
    blurb: 'Ask the assistant to add a reminder, to-do, or calendar event and it\'s done immediately — no approval card to click.',
    access_path: '86 / Assistant chat',
    area: 'AI',
    shipped: '2026-06-24',
  },

  // ── Dashboard / Mobile ──────────────────────────────────────
  {
    id: 'summary-command-center',
    label: 'Redesigned Summary dashboard',
    blurb: 'A dense command-center home — an attention ribbon, a money snapshot strip, and a three-column workspace.',
    access_path: 'Summary (home)',
    area: 'Org',
    shipped: '2026-06-20',
  },
  {
    id: 'install-app',
    label: 'Install on your phone',
    blurb: 'Add Project 86 to your home screen — it runs like a native app with a 5-slot bottom nav.',
    access_path: 'Browser menu → Add to Home Screen',
    area: 'Mobile',
    shipped: '2026-06-01',
  },
];

// Newest first — the order this array appears IS the order What's New
// renders. Drop the bottom entries once they age out (>30 days) but
// keep the feature in the `features` array above forever.
const whats_new = [
  {
    id: 'location-aware-ai',
    label: 'Location-aware AI',
    blurb: 'Share your location and ask "what jobs or leads are near me" — answered by distance.',
    shipped: '2026-06-24',
  },
  {
    id: 'assistant-quick-adds',
    label: 'Instant AI quick-adds',
    blurb: 'Reminders, to-dos, and calendar events the assistant adds now commit instantly — no approval card.',
    shipped: '2026-06-24',
  },
  {
    id: 'lead-to-job',
    label: 'Create a job from a lead or estimate',
    blurb: 'One click; the contract pulls the estimate total and the job links back to its source.',
    shipped: '2026-06-24',
  },
  {
    id: 'site-plan',
    label: 'Site Plan view',
    blurb: 'Trace a job\'s buildings on a satellite map with photo-GPS pins and a 3D toggle.',
    shipped: '2026-06-22',
  },
  {
    id: 'summary-command-center',
    label: 'Redesigned Summary dashboard',
    blurb: 'A dense command-center home: attention ribbon + money snapshot + workspace.',
    shipped: '2026-06-20',
  },
  {
    id: 'calendar',
    label: 'Personal calendar',
    blurb: 'Appointments + events on the schedule, color-coded, with reminders.',
    shipped: '2026-06-19',
  },
  {
    id: 'my-day',
    label: 'My Day',
    blurb: 'Today\'s events, reminders, and due tasks in one time-ordered view.',
    shipped: '2026-06-16',
  },
  {
    id: 'messages-dm',
    label: 'Messages (DMs)',
    blurb: 'Direct-message teammates inside the app, with unread badges.',
    shipped: '2026-06-16',
  },
  {
    id: 'purchase-orders',
    label: 'Purchase Orders',
    blurb: 'Sub scope-of-work contracts on a job — amounts, attachments, approval.',
    shipped: '2026-06-15',
  },
  {
    id: 'tasks-3tier',
    label: 'Tasks, to-dos & reminders',
    blurb: 'Assignable org tasks, your private to-dos, and timed reminders.',
    shipped: '2026-06-12',
  },
  {
    id: 'drafting-sheets',
    label: 'Drafting sheets (CAD)',
    blurb: 'Precision plan drawing — dimensions, layers, hatch, snaps, DXF/PDF export.',
    shipped: '2026-06-12',
  },
  {
    id: 'projects',
    label: 'Projects',
    blurb: 'Project workspaces with photo feeds, reports, before/after pairs, and a map.',
    shipped: '2026-06-08',
  },
  {
    id: 'plans-takeoffs',
    label: 'Plans & Takeoffs',
    blurb: 'Import a plan, calibrate scale, and measure LF / SF / counts / angles.',
    shipped: '2026-06-08',
  },
  {
    id: 'file-explorer',
    label: 'File system everywhere',
    blurb: 'Windows-style folders on every job, client, project, lead, and estimate.',
    shipped: '2026-06-05',
  },
];

module.exports = { features, whats_new };
