// Feature catalog — the discoverability source of truth.
//
// Exports:
//   features    — every user-facing capability in the app, grouped by
//                 area. Rendered in the Help center (avatar dropdown →
//                 "Help & What's New" → Features) as the searchable
//                 atlas (name + blurb + where to find it). When a new
//                 feature ships, add an entry here.
//   releases    — versioned patch notes, newest first (see the block
//                 comment above the array). Drives the Help center's
//                 What's New timeline + the "N new" badge (badge
//                 clears when the user opens the Help center).
//   APP_VERSION — the current version string; mirrors releases[0].
//
// All three are exposed via GET /api/org/manifest so any future 86
// introspection tool could read them without database access.
//
// Feature conventions:
//   id          unique kebab-case string (used in localStorage keys)
//   label       short, sentence-case title (under ~40 chars)
//   blurb       one-line value prop (under ~120 chars)
//   access_path human-readable navigation path (e.g. "Project detail
//               → Reports tab → + Create"). Tells the user where to
//               find this feature in the UI.
//   area        bucket for grouping: 'Photos' | 'Reports' | 'Schedule'
//               | 'Estimating' | 'Jobs' | 'Org' | 'AI' | 'Mobile'
//   shipped     ISO date string.

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

  // ── Cost Inbox / Comms / AI crew (late-June wave) ───────────
  {
    id: 'cost-inbox',
    label: 'Cost Inbox (receipt capture)',
    blurb: 'Snap a receipt, AI reads the vendor + total, tag it to a cost code and job — costs roll up on the job automatically.',
    access_path: 'Cost Inbox (left sidebar), or header + → Scan Receipt',
    area: 'Jobs',
    shipped: '2026-06-30',
  },
  {
    id: 'schedule-calendar-view',
    label: 'Schedule Calendar view',
    blurb: 'Flip the schedule between Production bars and a Calendar that paints events, tasks, to-dos, and reminders as per-day cards.',
    access_path: 'Schedule → Production / Calendar switch',
    area: 'Schedule',
    shipped: '2026-06-29',
  },
  {
    id: 'email-template-studio',
    label: 'Email template studio',
    blurb: 'Block-based email editor with drag-to-reorder, org branding kit, open/click tracking, weekly digests, and bulk sends.',
    access_path: 'Admin → Organization → Templates → Email',
    area: 'Org',
    shipped: '2026-06-28',
  },
  {
    id: 'background-ai-tasks',
    label: 'Background AI tasks',
    blurb: 'Hand the crew a big job and close the app — it runs in the background, pauses to ask when it needs you, and the results land back in your chat.',
    access_path: 'Ask 86 / Assistant → "do this in the background"',
    area: 'AI',
    shipped: '2026-07-01',
  },
  {
    id: 'crew-activity',
    label: 'Crew activity panel',
    blurb: 'Every background task and Scribe draft in one panel — answer questions, approve drafts, and watch live progress.',
    access_path: 'Crew activity button — in the 86 chat header',
    area: 'AI',
    shipped: '2026-07-01',
  },
  {
    id: 'push-notifications',
    label: 'Push notifications',
    blurb: 'Phone + desktop pings for finished AI tasks, Scribe drafts, DMs, reminders, and assignments — each channel toggleable per event.',
    access_path: 'Avatar → My Account & Notifications → Notifications',
    area: 'Org',
    shipped: '2026-07-01',
  },
  {
    id: 'guided-tours',
    label: 'Guided tours',
    blurb: 'Interactive walkthroughs that spotlight the actual buttons on your screen, step by step.',
    access_path: 'Avatar → Help & What\'s New → Guides',
    area: 'Org',
    shipped: '2026-07-02',
  },
];

// ── Releases (patch notes) ─────────────────────────────────────
// Newest first — the order this array appears IS the order the Help
// center's What's New timeline renders. Curated versions, not every
// deploy: when a meaningful wave ships, cut a new release at the top,
// bump APP_VERSION to match, and list the changes.
//
// Shape:
//   version   'major.minor' string ('1.8'). APP_VERSION mirrors the
//             newest entry.
//   date      ISO date the release was cut.
//   name      short codename shown next to the version chip.
//   summary   one-liner for the release header.
//   changes   [{ type, text, tour? }] where type is one of
//             'new' | 'improved' | 'fixed' and `tour` (optional) is a
//             client-side guided-tour id (js/guide.js registry) that
//             renders a "Show me" button on that row.
const APP_VERSION = '1.11';

const releases = [
  {
    version: '1.11',
    date: '2026-07-12',
    name: 'Fidelity',
    summary: 'Excel files come into the Workspace looking exactly like Excel — and go back out identical.',
    changes: [
      { type: 'new', text: 'Full-fidelity Excel import — drop in an .xlsx and every fill, border, font, theme color, merged header, and exact column width arrives intact, including formatting on blank cells.' },
      { type: 'new', text: 'Round-trip exports — export a workspace and the .xlsx matches the original file cell-for-cell: values, formulas with live results, styles, and bit-exact column widths.' },
      { type: 'new', text: 'Hidden sheets now import as hidden tabs, so formulas and named ranges that read from them keep working.' },
      { type: 'improved', text: 'Formulas filled down a column (shared formulas) now import with the right references on every row, and Excel\'s cached results display instantly while the grid recalculates.' },
      { type: 'fixed', text: 'SUM, AVERAGE, COUNT and every other range formula computed 0 over same-sheet ranges — the engine now reads ranges correctly everywhere, including ranges from named ranges.' },
      { type: 'fixed', text: 'Frozen panes silently un-froze after a reload; freeze state now survives.' },
      { type: 'fixed', text: 'Duplicating a sheet dropped its row heights.' },
    ],
  },
  {
    version: '1.10',
    date: '2026-07-11',
    name: 'Command',
    summary: 'The Site Plan panel becomes a command center, phases link across buildings in one move, and paperwork imports itself.',
    changes: [
      { type: 'new', text: 'Link a scope across buildings in one move — tick the phases, tick the buildings, and Link; the budget splits automatically by units or levels.' },
      { type: 'new', text: 'Command Center job panel — the Site Plan\'s right panel opens with your live numbers (Cost · Margin · Billed · AR), flags trouble at the top, and folds every section (Buildings, Phases, Costs, Subs, COs, POs, Invoices) into a header that shows its own total.' },
      { type: 'new', text: 'Bulk Document Import — drop in a stack of PO / CO / Invoice files, or a Buildertrend export, and it reads each one, pulls the line items, matches it to a job, and lets you review before creating.' },
      { type: 'new', text: 'Status chips in the job sidebar — each section shows a live figure beside it (buildings, WIP margin, open POs, AR), with an alert when a job\'s margin goes negative.' },
      { type: 'improved', text: 'Change orders now roll into the contract and the job\'s metrics automatically.' },
      { type: 'improved', text: 'Truer costs & progress — actual costs come only from linked QuickBooks lines, building levels and units drive % complete, and open POs accrue by progress instead of only what\'s been billed.' },
      { type: 'improved', text: 'QuickBooks cost links now show right on the job overview.' },
      { type: 'fixed', text: 'A building could show $0 while its money sat on a hidden duplicate record — cleaned up, and future duplicates self-heal.' },
      { type: 'fixed', text: 'The Buildings × Phases table no longer renders twice on the Site Plan.' },
    ],
  },
  {
    version: '1.9',
    date: '2026-07-04',
    name: 'Direct',
    summary: 'Say yes in chat and it\'s done — plus measuring on the Site Plan and columns you can shape.',
    changes: [
      { type: 'new', text: 'Approve in chat — confirm a change in the conversation and the Scribe applies it on the spot. Only deletes, system changes, and outbound sends still show the approval card.' },
      { type: 'new', text: 'Measure tool on the Site Plan — Line / Poly / Area modes with real-world units, saved with the plan.' },
      { type: 'new', text: 'Resizable columns on every list — drag the divider on Leads, Estimates, Jobs, Subs, Cost Inbox, and the Jobs hub.' },
      { type: 'improved', text: 'The Assistant hands business questions to 86 sooner — escalating is now her normal move, not a last resort.' },
      { type: 'improved', text: 'Sidebar restyle — Console-style neutral black with brighter labels, plus your org logo lockup and a per-org light/dark logo picker.' },
      { type: 'improved', text: 'Light-mode sweep — white main panel, tinted chips, and panels/dropdowns that used to open dark.' },
      { type: 'improved', text: 'Admin agent metrics now show actuals — background runs, cache-aware costs, escalations, and a usage-forensics view.' },
      { type: 'fixed', text: 'Bulk-action bars work in the installed app — confirm dialogs silently no-op\'d in the PWA.' },
      { type: 'fixed', text: 'Sub portal sign-out could trap you in a redirect loop, and login could wrongly say "Too many requests."' },
      { type: 'fixed', text: 'Site Plan / Orbit 3D no longer render torn after a PWA update relaunch.' },
    ],
  },
  {
    version: '1.8',
    date: '2026-07-02',
    name: 'Guided',
    summary: 'One card language across every map, and a Help center that can walk you through the app.',
    changes: [
      { type: 'new', text: 'Patch notes + versioning — this page. Every release is now logged here, newest first.' },
      { type: 'new', text: 'Guided tours — interactive walkthroughs that spotlight the real buttons on your screen.', tour: 'welcome' },
      { type: 'new', text: 'The Help center got a full rework: release timeline, searchable feature atlas, and guides.' },
      { type: 'improved', text: 'Every map pin now opens the same dark info card — first tap opens the card, the magnifier zooms in.', tour: 'map-cards' },
      { type: 'improved', text: 'Map cards auto-pan into view so pins near the top edge don\'t open half-hidden.' },
      { type: 'fixed', text: '"Open lead" / "Open WIP" on map cards now actually leaves the map and opens the record.' },
    ],
  },
  {
    version: '1.7',
    date: '2026-07-01',
    name: 'The AI crew',
    summary: 'Your assistant, 86, and the Scribe now work like a real crew — in the background, with pings.',
    changes: [
      { type: 'new', text: 'Background AI tasks — hand off a big job and close the app; it keeps working and pings you.', tour: 'ai-crew' },
      { type: 'new', text: 'Pause-and-ask — a background task that needs a decision stops and asks, then resumes on your answer.' },
      { type: 'new', text: 'Crew activity panel — every task and Scribe draft in one place (open the 86 chat and tap the Crew activity button in its header).', tour: 'ai-crew' },
      { type: 'new', text: 'Push notifications on phone + desktop, with per-event Email / Push toggles under My Account.' },
      { type: 'new', text: 'Crew chip in the header shows who\'s working — Assistant, 86, or Scribe — in real time.' },
      { type: 'improved', text: 'The Scribe always drafts in the background now and pushes you when the draft is ready.' },
      { type: 'improved', text: 'Close the app mid-question and nothing is lost — the turn finishes and the answer is waiting.' },
      { type: 'improved', text: 'Dark mode is now the default everywhere (light mode stays if you saved it).' },
    ],
  },
  {
    version: '1.6',
    date: '2026-06-29',
    name: 'Org polish',
    summary: 'Receipts, richer lists, branded email, and admin tooling.',
    changes: [
      { type: 'new', text: 'Cost Inbox — snap receipts, AI reads the total, costs roll up on the job.', tour: 'receipts' },
      { type: 'new', text: 'Email template studio — block editor, org branding, open/click tracking, weekly digests.' },
      { type: 'new', text: 'Schedule Calendar view — events, tasks, to-dos, and reminders painted per day.' },
      { type: 'new', text: 'Filters, saved views, column chooser, Excel export, and bulk-action bars on every list page.' },
      { type: 'new', text: 'Admin act-as mode — support a teammate by seeing the app exactly as they do (fully audited).' },
      { type: 'improved', text: 'My Account is self-serve now — name, title, phone, password, and notification prefs.' },
      { type: 'improved', text: 'Every lead geocoded — the whole pipeline shows up on the map.' },
    ],
  },
  {
    version: '1.5',
    date: '2026-06-24',
    name: 'Command center',
    summary: 'The Summary became a command center and the pipeline went spatial.',
    changes: [
      { type: 'new', text: 'Redesigned Summary — attention ribbon, money snapshot, three-column workspace.' },
      { type: 'new', text: 'Site Plan view — trace buildings on satellite, photo-GPS pins, 3D massing toggle.' },
      { type: 'new', text: 'Leads + Jobs map with address grouping.', tour: 'map-cards' },
      { type: 'new', text: 'Create a job from a lead or estimate in one click — contract + costs flow automatically.', tour: 'lead-to-job' },
      { type: 'new', text: 'Address autocomplete on every address field, capturing exact coordinates.' },
      { type: 'new', text: 'Personal calendar layered on the schedule.' },
      { type: 'improved', text: 'The assistant knows where you are — "what\'s near me" answered by distance.' },
      { type: 'improved', text: 'Quick-adds (reminders, to-dos, events) commit instantly — no approval card.' },
    ],
  },
  {
    version: '1.4',
    date: '2026-06-16',
    name: 'Operations pack',
    summary: 'The day-to-day layer: tasks, messages, purchase orders, and your day.',
    changes: [
      { type: 'new', text: 'Tasks, To-dos & Reminders — org-assignable, private, and timed, attachable to any record.' },
      { type: 'new', text: 'Purchase Orders — sub scope-of-work contracts with amounts, attachments, and approval.' },
      { type: 'new', text: 'Messages — direct-message teammates inside the app.' },
      { type: 'new', text: 'My Day — today\'s appointments, reminders, and due tasks in one time-ordered view.' },
      { type: 'new', text: 'Drafting sheets — CAD-style precision drawing with dimensions, layers, and DXF/PDF export.' },
    ],
  },
  {
    version: '1.3',
    date: '2026-06-08',
    name: 'Pipeline & Projects',
    summary: 'Sales pipeline, project workspaces, and files that behave like files.',
    changes: [
      { type: 'new', text: 'Leads pipeline with statuses, values, photos, weather, and Buildertrend import.', tour: 'lead-to-job' },
      { type: 'new', text: 'Projects — dedicated workspaces with photo feeds, reports, and before/after pairs.' },
      { type: 'new', text: 'A real folder tree on every job, client, project, lead, and estimate.' },
      { type: 'new', text: 'Plans & Takeoffs — calibrate a plan PDF and measure LF / SF / counts / angles.' },
      { type: 'improved', text: 'Install on your phone — full PWA with a native-feeling bottom nav.' },
    ],
  },
  {
    version: '1.2',
    date: '2026-05-27',
    name: 'Photos & Reports',
    summary: 'The documentation wave — capture it, mark it up, report it.',
    changes: [
      { type: 'new', text: 'Photo viewer with tags, comments, and annotate-in-place.' },
      { type: 'new', text: 'Eight report templates with five section layouts and eight visual style packs.' },
      { type: 'new', text: 'Change Orders on jobs.' },
      { type: 'new', text: 'Voice input on chat + caption fields.' },
      { type: 'improved', text: 'Edit-gate — forms lock until you tap the pencil, so stray taps can\'t mutate data.' },
      { type: 'improved', text: 'Schedule works one-handed on a phone (drawer sidebar + day-at-glance).' },
    ],
  },
  {
    version: '1.1',
    date: '2026-05-12',
    name: 'Field kit',
    summary: 'Tools the crew actually opens on site.',
    changes: [
      { type: 'new', text: 'Field Tools — calculators, lookups, and forms built for phones; 86 can spin one up on demand.' },
      { type: 'new', text: 'Printouts — save any calculation as a receipt-style record.' },
    ],
  },
  {
    version: '1.0',
    date: '2026-04-15',
    name: 'Foundation',
    summary: 'Where it started: WIP tracking with an AI that knows your jobs.',
    changes: [
      { type: 'new', text: 'Job WIP tracking — contracts, costs, billings, percent-complete.' },
      { type: 'new', text: 'Ask 86 — an AI that reads your real data and works your calendar, tasks, and records.', tour: 'ai-crew' },
      { type: 'new', text: 'My Files, the schedule, and the day-at-glance sheet.' },
    ],
  },
];


module.exports = { features, releases, APP_VERSION };
