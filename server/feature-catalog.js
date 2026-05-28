// Feature catalog — the discoverability source of truth.
//
// Two ordered arrays:
//   features  — every user-facing capability in the app, grouped by area.
//               Consumed by the Summary page's "System Map" sub-tab to
//               render the Features matrix (name + blurb + where to find
//               it). When a new feature ships, add an entry here.
//   whats_new — newest-first list of recently shipped things. Drives
//               the What's New panel + the "(N new)" badge on the
//               System Map sub-tab (badge clears when user opens it).
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
    blurb: 'Personal file folder for everything that doesn\'t belong on a specific lead or job. Upload + send-to-entity.',
    access_path: 'Header → 📁 icon (right cluster)',
    area: 'Org',
    shipped: '2026-04-30',
  },

  // ── AI ──────────────────────────────────────────────────────
  {
    id: 'ask-86',
    label: 'Ask 86 (your AI assistant)',
    blurb: 'Context-aware AI that can read your data + write changes via reviewable payload files.',
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
];

// Newest first — the order this array appears IS the order What's New
// renders. Drop the bottom entries once they age out (>30 days) but
// keep the feature in the `features` array above forever.
const whats_new = [
  {
    id: 'report-style-packs',
    label: 'Report style packs',
    blurb: '8 visual styles you can apply to any report — from Field Notebook to Blueprint to Polaroid Journal.',
    shipped: '2026-05-26',
  },
  {
    id: 'schedule-mobile-drawer',
    label: 'Schedule works on phone',
    blurb: 'Sidebar collapses to a drawer; calendar takes the full viewport. Day cells fit iPhone SE widths.',
    shipped: '2026-05-26',
  },
  {
    id: 'change-orders',
    label: 'Change Orders',
    blurb: 'Track CO requests on jobs with full income + cost + approval flow.',
    shipped: '2026-05-26',
  },
  {
    id: 'report-templates',
    label: '8 report templates',
    blurb: 'Daily Log, Weekly Progress, Engineer\'s Report, Submittal Package, Punch List, and more.',
    shipped: '2026-05-25',
  },
  {
    id: 'photo-viewer-side-panel',
    label: 'Photo viewer with side panel',
    blurb: 'Click any photo to see tags, description, and comments in a dedicated side panel.',
    shipped: '2026-05-23',
  },
  {
    id: 'internal-users-directory',
    label: 'Internal Users directory',
    blurb: 'Roster of every user in your org with phone + email.',
    shipped: '2026-05-22',
  },
  {
    id: 'edit-gate',
    label: 'Edit-gate (pencil to unlock)',
    blurb: 'Forms now lock by default; tap the pencil to edit. Protects against accidental phone taps.',
    shipped: '2026-05-19',
  },
];

module.exports = { features, whats_new };
