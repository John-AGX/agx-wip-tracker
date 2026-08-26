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
const APP_VERSION = '1.22';

const releases = [
  {
    version: '1.22',
    date: '2026-08-25',
    name: 'Answer, or Do Nothing',
    summary: 'Exploding an assembly can no longer act on a record that moved while you were reading the box, it no longer changes what a change order is worth, and nine dialogues that delete things finally look like it.',
    changes: [
      { type: 'fixed', text: 'A confirmation box does not stop the app working behind it, and exploding an assembly could act on a record that had moved on. The app worked out what would happen BEFORE the box appeared and did it AFTER you clicked — and in between, the job’s data could reload. That happens more often than it sounds: any time 86 or the Scribe writes something, a background task finishes, or your phone wakes the tab up. On an estimate it could delete the rollup line and put nothing back, and save that. On a change order it could leave the assembly in place AND add its parts, double-counting the work. If you had opened a second change order while the box was sitting there, that one could receive the first one’s parts. None of it announced itself. The explode now checks that the record is still the one it answered about — not just that the numbers match, but that the rollup line itself is unchanged — and if anything moved it does nothing at all and tells you to click again. Thirty different ways of interfering with it mid-dialog were tried on both editors; every one now refuses and leaves the record byte-for-byte as it was.' },
      { type: 'improved', text: 'Exploding an assembly no longer changes what the change order is worth. It used to: the parts were born without the markup the rollup line was carrying, and they were re-filed into cost-code sections whose own markup then applied instead — so a line you had priced one way came apart into pieces priced another way, and the total moved with no mention of money anywhere on screen. On a rollup carrying a markup you had typed, that moved the total on the large majority of explodes. The parts now carry the price the rollup was carrying, so the total holds. Where it genuinely cannot hold — a section priced in dollars rather than a percentage, a section set to override its lines, a rounding step — the box tells you the total is going to move and what it will move to, before you agree, and that figure matches what you get. Where the total does not move it now says so rather than leaving you to check.' },
      { type: 'fixed', text: 'Nine dialogues that delete things now look like it. There are two confirmation dialogues in the app and only one of them runs — but the one that does NOT run is the one carrying the documentation, so nine places were written against it and the live dialogue quietly ignored every option they passed. The result was a plain blue "Confirm" button on "Delete job permanently" — which takes the job’s buildings, scopes, subcontractors and change orders with it — and on Delete estimate, Delete attachment and six others. They read as routine because nothing told you otherwise. The live dialogue now understands both sets of wording, so a destructive action says what it is and looks the part, and no future one can be missed by spelling an option the wrong way.' },
      { type: 'fixed', text: 'Email you forward with large attachments arrives now. The address that receives your forwarded mail was being held to a 10 MB ceiling set elsewhere in the app, so its own 25 MB allowance never took effect: anything past roughly 18 MB was refused, the gateway retried, and the mailbox that forwards into your dropbox eventually bounced it back. You lost the whole message, not just the files. A plan set from a supplier is exactly the size that hits this. 25 MB now genuinely applies.' },
      { type: 'new', text: 'What is attached to an email, in the app and in 86. Attachments show as chips directly under the message header rather than below the body, so you can see what came with a message without scrolling it. Each chip has a "save to folder" button that copies the file into a job’s Files or your own My Files, into the folder you pick — images get their thumbnails generated on the way in, and the text inside the file is extracted so it is searchable and readable afterwards. And 86 can now read them: ask it about a thread and it reads out what the attachments say, including scans and photographs, which it reads with a cheaper model only when the file has no text layer of its own. Threads carrying attachments are flagged in the list so it can tell there is something to open.' },
      { type: 'fixed', text: 'Correcting this entry, which was published yesterday with two claims that were never true. It said a sold estimate and an approved change order would both let you explode an assembly line on them, that the change order would save the result, and that the control had been deliberately marked to pass through the lock — so it was a decision to make rather than a fault to fix. Wrong on the last two, and the first is now fixed anyway. **The change order never saved it.** The server refuses an approved or applied change order outright and issues no write at all — checked against every combination of status and lock, with the stored record identical before and after. So nothing on a signed-off change order was ever altered on the server. What actually happened was worse to look at than to live with: the editor showed you an exploded change order, under a banner reading read-only, with a chip saying the save had failed — three statements contradicting each other on one screen. **And nothing was deliberately marked to pass through the lock.** That mechanism is not in the change-order editor at all. The real cause was duller: the styling that greys out a locked record only ever covered typed fields — boxes, dropdowns, text areas. A link, a button and a drag handle are none of those, so they stayed live on a record that was supposed to be closed. Explode was the one that got noticed; Reprice, the delete button and the drag handles were all live too, and dragging a row is a money change, because on these records the order of the lines is what decides which scope each one belongs to. **The estimate side was the real one.** There is no server refusing on that path, and the app writes to its own local copy before it checks anything, so a change made to a sold estimate landed in the copy your browser keeps as soon as anything else in the app saved. All of it is fixed. Each editor now asks one question — is this record closed — in front of every action that could change it, so a control added later is covered without anyone remembering to cover it. A closed record refuses and tells you why. Reading one is untouched: you can still open a recipe on a sold estimate and look at what is in it, which is the reason those controls were reachable in the first place. One more thing surfaced on the way: because the lock button never checked a change order’s status, an applied change order could be unlocked — after which it showed no banner and every field looked editable, while the server refused every save. That is closed too.' },
    ],
  },
  {
    version: '1.21',
    date: '2026-08-24',
    name: 'Labels and Columns',
    summary: 'The Site Plan map has street names on it for the first time, and the task board reads like a real grid — and not one number that gets billed, stored or reported moves by a cent this week.',
    changes: [
      { type: 'fixed', text: 'The confirmation box you get when you explode an assembly line on a change order was quoting the wrong total. It had been wrong since 22 August, the day that box first started quoting a total at all — two days. Open a change order, click the ASSEMBLY strip under a line to inspect it, then click "Explode to editable lines": if that line carries a promised Unit Sell, the box tells you the promise it is about to drop and where the change order total lands — "moving the change order total from $14,980.00 to $12,840.00." The first figure was always right; it is the same total the bar at the top of the editor is already showing you. The second was worked out from a rebuilt guess of what the change order would look like afterwards instead of from the real thing, and the guess got three things wrong. It dropped the new lines at the end of the list rather than inside their cost-code section, so on a change order carrying section headers they took the wrong section\'s markup. Where a typed client price and a Round to $ were both set, it applied a round-up that should have stood down. And it priced pieces that exploding never creates: on a credit line — a rollup line carrying a negative quantity — exploding created nothing at all, and the guess priced every piece of it anyway (exploding a credit line is refused outright now — though the refusal published here was not actually reachable until the following day, see below). That third one is the biggest of the three, and it is the one that could reach an otherwise plain change order with no section headers and no client price on it. So the number was wrong on a change order carrying cost-code section headers, on one carrying both a typed client price and a round-up, and on one carrying a credit — and it went both ways, sometimes too high, sometimes too low, with the understatements the larger of the two. A change order with no section headers, no client price and no credit line was quoted correctly the whole time. What did not happen: nothing was billed, invoiced, contracted, reported or stored wrong. The change order you ended up with after clicking Explode is exactly the one you would have ended up with before this fix — the error lived entirely inside the sentence you read before you agreed to it. Nothing is repaired for you, because nothing was ever saved wrong.' },
      { type: 'improved', text: 'Exploding an assembly line no longer destroys it, and this entry has now been corrected twice — both times because it was published while the ground was still moving. What was wrong originally: the box counted every item in the recipe while exploding only creates the items that work out to a real quantity, so it promised more lines than you got; and where nothing qualified at all — a rollup with no quantity, or a credit line carrying a negative one — it removed the rollup and put nothing back. It hid that too: the table did not redraw, and the deletion was not queued, so closing the record left the line intact while touching anything else saved the deletion along with your next edit. Measured on the app’s own test corpus that was 54.7% of explodes, not the "nearly three in ten" published here earlier — that figure came from a test’s minimum threshold rather than a measurement, and the true rate depends entirely on how many of your rollups are credits. Two further corrections to what was published: the credit refusal was described as working when it was not — it only fired once the recipe had already emptied, so a credit whose recipe carried a negative row still exploded and turned a deduction into a charge. And the "one narrow case" left open was understated: the confirmation box does not stop the app working while you read it, so if the job’s data reloaded behind it — which happens whenever 86 or the Scribe writes something, or a background job finishes — an estimate could lose the line entirely, a change order could end up with the assembly AND its parts double-counted, and a second change order opened in the meantime could receive the first one’s parts. All of that is fixed. The count is now the number of lines you will actually get, an explode either replaces the line with its parts or does nothing and says so, credits are refused by name, and if the record changed while you were reading the box it changes nothing and asks you to click again. Nothing is repaired for you: a line destroyed this way before today is gone and needs adding back.' },
      { type: 'fixed', text: 'The Site Plan map has street names on it. It never has. Open a job\'s Site Plan, or open a lead as a pre-sale survey, and what you got was aerial imagery with no text on it anywhere — no road names, no place names, nothing. On a property with no buildings traced yet that is a screen without one word on it, which is what surveying a 30-building apartment complex looked like. The same imagery now carries the map\'s own labels: street names, highway markers and the names of places Google knows. Both surfaces read the same single setting, so a lead survey and a job Site Plan cannot end up showing different maps. Now read the part that keeps you from going hunting: this does not give you building addresses. Google labels the roads and the places it knows; it does not number the individual buildings of an apartment property. And the Site Plan never shows a building\'s address of its own, even though the Add Building form has a field for one — what you type there becomes a small map-pin link on the job\'s building tiles and nothing at all on the map. A building traced on the map is named B1, B2, B3 in the order you traced them, unless you rename it or load an existing job building in under its own name. So an untraced complex now shows you the streets and still nothing that tells building 12 from building 13. The "Map view" button in the Site Plan ribbon is untouched — it still flips to a plain road map for locations with poor satellite coverage, still reads "Satellite" while you are on that road map, and your choice still sticks per browser. No labels toggle was added, and none was ever removed. The labels are painted underneath everything you draw, so one can show faintly through a footprint\'s translucent fill but can never cover a building or block a trace. The job Site Plan had been running without labels since 23 June; the lead survey never had them at all, having shipped that way on 12 August. Nothing moves and nothing is stored differently — this is which picture Google sends.' },
      { type: 'new', text: 'The task board is a grid now. Workspace, then My Tasks — the page headed Tasks & Reminders. What was a flat list of titles with a strip of small chips under each one is a table with columns: Task, Due, Priority, Assignee, Job, Created, and a tick box down the left that marks a task done. Priority is spelled out beside its coloured dot instead of being a bare dot you had to hover to read. Created was never on the list before — you had to open a task to see it. The job a task is linked to is a named chip in a column of its own, trimmed with an ellipsis so a long job name no longer runs across into Created, and a task with photos still shows a small camera count beside its title. Rows are grouped into Overdue, Today, Upcoming, No due date and Completed, each headed with a count, and a section only appears if it has something in it — so a tight filter collapses the whole board to a single heading. Above the grid sits a filter bar that reads like a sentence: Status (All open, Today, Upcoming, Overdue, Done), and on Team Tasks and Punch list an Assignee filter (Everyone, Me, Unassigned, or a person by name), then a "+ Filter" button, a "Clear all" that appears once you change something, and a live count of what you are looking at on the right. "+ Filter" offers exactly one thing, Priority; it arrives set to High and the "+ Filter" button goes away while it is on — change it, or take it off with the x on the chip. New tasks are typed straight into the grid: an "Add a task and press Enter" row sits at the bottom, where the old quick-add box sat at the top. On Team Tasks and on Punch list a task you add there is assigned to you, and on Punch list it is created as a punch item; on My To-Dos it is private to you. Punch list is a fourth tab, and it is the same org-wide board filtered to tasks marked as punch items — not the same thing as the punch list inside a single task, the checklist with the "3 of 8 done" bar, which is unchanged and is a different feature. The page fills the window and is left-aligned instead of sitting in a narrow column down the middle, and on a narrow screen the grid does not fold into cards — it scrolls sideways, so on a phone the task board is a table you swipe across. No money and no due date moves: this is how the same tasks are laid out.' },
      { type: 'improved', text: 'What the new task grid does not show you, and two buttons that behave oddly. The grid has no column for a task\'s kind and none for its status. The old flat row carried both as small chips, so an In progress or Blocked task used to look different from a plain open one and now does not, and outside the Punch list tab you cannot tell a punch item from a to-do without opening it. That is a real loss of information and it is worth knowing rather than discovering. The blue "+ Task" button at the top of the page does not open a form — it drops your cursor into the add row at the bottom of the grid, and on the Reminders tab, which has no such row, it does nothing at all. A row shows a hand cursor across its full width, but only the task\'s title opens it. Two things about what you are reading: the board shows the first 100 tasks the server hands back, not every task in the organisation, and the count on the filter bar counts those; and the Status filter marked Today means due today or earlier, so choosing it still shows you an Overdue section above the Today one. That second one is not new — the filter has always meant that, and the grouping is what makes it visible. The old flat list is still what you get on the task panel inside a job, a lead, a client, a project or an estimate — same rows, ungrouped, same + Add button, though the date and job chips on them were restyled this week along with everything else, and there is no way to switch either layout into the other. Reminders keeps its own list and its own Pending / All pills, and the selected one — a near-black fill that used to disappear into the dark page behind it — is a blue-tinted pill now.' },
      { type: 'new', text: 'Files attached to an email forwarded into your Email dropbox are kept now. They show at the bottom of the message in the reading pane as chips you click to open or download, with the file name and its size; the thread in the message list shows a paperclip; and the "Has attachment" quick view and a has:attachment search return real results, where before they returned nothing at all because no arriving message was ever flagged as carrying one. Until now the mail gateway that receives your forwarded mail read the files and threw them away — they never reached the app. Three things to be clear about. Only mail that arrives from here on: there is nothing to go back and recover, because the files never existed here, so an email already in your hub will never grow an attachment. It does not start on the day this release ships either — the mail gateway is deployed by hand, separately from the app, so attachments keep being dropped until John updates it, and if you forward yourself a test and see no paperclip, that is the first thing to check. And the files live on the message and nowhere else: they are not filed into My Files, a job\'s Files tab, the Explorer or a project, and only the person whose dropbox received the mail can open them. Logos in email signatures and pictures sitting inside the body of a message are skipped, so you do not get a paperclip and a chip on every message for a 4 KB logo — with one honest edge, that the skip goes on how the sender\'s mail program marked the image, so a picture that arrives marked as a real attachment still comes through as one. No money and no job record is touched by any of this.' },
      { type: 'improved', text: 'The size limits published here have been raised, and the worst of them was a bug rather than a limit. The route that receives your forwarded mail was being parsed by a 10 MB ceiling set elsewhere in the app, so its own 25 MB allowance never applied — anything past roughly 18 MB of files was refused, the gateway kept retrying, and the mailbox forwarding into your dropbox eventually got a bounce. You lost the mail, not just the files. That is fixed: 25 MB now genuinely applies, and the server logs how many attachments it received against how many it stored, so a test send tells us the truth rather than leaving it to guesswork. Two things from the original note still stand. Email rules take one condition each, so "Has attachment" fires correctly on its own but cannot be paired with Auto-category, Urgency or Needs a reply. And if storing a file fails the message still arrives — you lose the file, never the mail. That last one is deliberate.' },
      { type: 'improved', text: 'Clients and Subs / Vendors are gone from the left sidebar, and the Directory heading above them went with them. They were duplicates. Both screens have always been, and still are, in the Directory menu behind the people icon in the blue header, the one beside the bell — it holds Internal Users, Subs / Vendors and Client Contacts. Nothing moved and nothing was added; two rows were deleted. One side effect: those two rows were what lit up to show you where you were, so with them gone the sidebar has nothing to highlight while you sit on Clients or Subs — no row there reads as the page you are on. One thing so you do not bounce off it: the row in that menu reads Client Contacts, not Clients. Nothing changed on a phone, where the More sheet keeps its own Clients and Subs tiles. No money, no data, two nav rows.' },
    ],
  },
  {
    version: '1.20',
    date: '2026-08-24',
    name: 'Price and Profit',
    summary: 'Type what the client pays and the change order lands on that number — and sales tax stopped counting as profit, so the margin you read on a taxed change order is lower than it was last week.',
    changes: [
      { type: 'fixed', text: 'Sales tax was being counted as profit on every change order that carries it. Fixing it lowers a number you read, so read this before you open a change order and wonder. The Profit and Margin chips at the top of the change-order editor were worked out against the change order\'s grand total — the marked-up work plus any flat fee, fee percentage, sales tax and round-up. They are worked against the price of the work alone now. On a change order with $27,500 of cost, 20% markup and 7% sales tax, Margin now reads 16.7% where it read 22.1%, and Profit reads $5,500.00 where it read $7,810.00 — overstated by $2,310.00, which is exactly the sales tax. The thinner the markup and the bigger the tax, the bigger the drop: at 7% tax it is at most 6.6 points, at 8.5% at most 7.9, and it shrinks as markup rises. Fees and round-ups were being counted as profit the same way and are not bounded like that — on that same change order a $1,000 flat fee on its own was worth 2.5 points of margin, a 3% fee 2.4. Put together on a change order carrying a $500 flat fee, a 3% fee and 7% tax that totals $34,000 on $27,500 of cost, the two chips read 19.1% and $6,500.00 where the truth is 9.4% and $2,864.76 — a profit figure 2.27 times too big. Which change orders move: only ones carrying tax, a fee or a round-up. A change order with none of the three reads exactly what it read yesterday, to the last decimal. What does not move: nothing is stored differently, no change-order total, contract, estimated cost, actual cost, invoice or pay application changes by a cent, and the change order you print for the owner never showed either figure. Estimates do not move either — the estimate\'s Margin chip was already worked this way, and an estimate has no Profit chip. Two smaller things on the same bar: Markup and Profit now print the same number on every change order, which is correct rather than redundant — gross profit is the markup on the work, and the two only ever differed because one of them was wrong. And a change order with no revenue to divide by now reads "—" for Margin instead of a confident 0.0%, as does a section priced at nothing.' },
      { type: 'improved', text: 'The change-order margin and the job\'s margin are now worked out two different ways, and this release only moved one of them. Everywhere outside the change-order editor — the job screen\'s Revised Margin, the WIP report, backlog, Unbilled, what 86 tells you and what a Live Room shows — a change order\'s income is still its full total with the sales tax in it. So the editor can now say 16.7% on a change order whose tax the job\'s own margin still counts as income. There is no per-change-order margin anywhere on the job page, so you will not catch two percentages for the same change order sitting side by side, but the two figures come from different definitions and reconciling them was deliberately left for a later release. Until then: trust the change-order editor for that change order\'s own margin, and the job screen for the job.' },
      { type: 'new', text: 'You can now price a change order by typing what the client pays. In the panel down the left of the change-order editor, directly above Target Margin %, there is a box marked Client Price $. Type 34000, or $34,000, or 34,000.00 — it reads money the way people type it, and anything it cannot read it refuses on screen, in currency, rather than quietly. Every line that is not carrying a promised Unit Sell is then priced by one shared factor so the rows add up to the number you typed, and a blue band under the chip bar names that factor — "every line that is not promised is priced at ×1.062500 its markup price." A change order costing $28,500, with a passthrough sub at 0%, labor at 30% and materials at 20%, typed to $34,000 comes out sub $15,937.50, labor $11,050.00, materials $7,012.50, Profit $5,500.00, Margin 16.2%, total exactly $34,000.00. The relative pricing you built is preserved on purpose — the zero-margin passthrough is not handed markup it must never carry — and a line carrying its own promised Unit Sell is carved out and never restated, so a permit line quoted at $1,200 stays at exactly $1,200.00. Three controls stand down while a price you typed is being honoured, and each says so where it lives: Target Margin % greys out, because two rules cannot both drive one total; Round to $ greys out, because a round-up is a ceiling and a ceiling cannot land on an exact typed price; and every line\'s Markup % greys out, showing what it worked out to rather than a number you can still edit. If the price cannot be honoured, none of the three moves and the change order prices exactly as it would with the box empty — a red band names the reason and the total the change order actually took. The reasons you are most likely to meet: every line\'s price is already promised, or the unpromised lines all price at $0, so there is nothing to scale; the promised lines alone already come to more than the price you typed; or the fee and the tax on it come to more than the price before a dollar of work is priced. There is one consequence worth expecting. The price is a promise, so correcting a cost afterwards does not move the total — it moves the other lines. Raise materials on that change order from $5,500 to $7,800 and the total stays at $34,000.00 while Profit falls to $3,200.00 and Margin to 9.4%, and the sub line you never touched drops from $15,937.50 to $14,672.04 because the pool it shares got smaller. Push it far enough and the price sits below what the work costs; that is allowed, and an amber band names the loss in dollars rather than leaving you to infer it from a negative percentage. Two limits: this is change orders only, there is no Client Price box on an estimate or a proposal; and a typed price is stored and does move money once that change order is approved or applied, unlike a draft, which still contributes nothing.' },
      { type: 'improved', text: 'One cosmetic wrinkle on a client-priced change order, and it clears itself. Type a cost onto a line while a client price is in force and only that row and its section subtotal repaint, so the sibling rows sit at their old prices for a moment — a section row reading $34,000.00 above three rows visibly summing $36,142.85. Type anything into the Client Price box, or close the change order and open it again, and everything lands where it belongs. With no client price set this does not happen at all. Nothing is billed wrong while it is on screen: the Total chip, the WIP report and pay applications all carry the number the rows will settle on.' },
      { type: 'improved', text: 'A change order that holds its total now says why it is holding, on the screen, in words. Where a line carries a promised Unit Sell, a blue notice under the chip bar reads "1 of 3 lines carry a promised Unit Sell. Typing a cost on one of those lines moves Est. Cost, Profit and Margin — the Change Order Total holds at the price quoted, because that price is the promise and cost is the only free variable." Where every priced line is promised, small notes sit under the chips themselves — "Held by the promised price" on Change Order Total and Tax + Fees, "Moves with cost" on Est. Cost, Profit and Margin. On a change order where only some lines are promised those four notes are deliberately absent and only the Total chip speaks, saying how many lines are promised rather than making a blanket claim that would be a lie about the rest — so do not go hunting for a note that is not there. Unlike the old amber "needs a real cost" badge, this notice does not vanish the moment you type the cost that raised the question. No pricing changed to put any of it on screen. Alongside it, other screens now catch up while the editor is still open: a saved edit refreshes the job\'s change-order tile, the Jobs list and the job\'s money sections as you work, instead of waiting for you to close. A save that fails refreshes nothing, which is the point.' },
      { type: 'fixed', text: 'Change-order lines that came in from a PDF import or were written by 86 could not be edited at all. Not fiddly — inert. Every field on the row took your typing and threw it away: description, quantity, unit, Unit Cost, Markup %, Unit Sell. The delete button removed nothing. The section $/% toggle did nothing. The save pill said "Saved" the whole time. Lines you added yourself with + Add Line or + Section Header were never affected and always worked, which is why this looked like it only happened on certain change orders — it did. It hit change orders built by the bulk PDF importer, which shipped 10 July, and lines written by 86 or the Scribe, which shipped 22 July. This also corrects something the last release published: 1.19 told you that on an imported change order you should "type the real cost into Unit Cost and the badge clears," and that a pasted cost "saves like any other." On an imported line, typing did nothing at all. If you tried that and concluded you had done it wrong, you had not. It is repaired for the change orders you already have, not only new ones: open one and it is editable, and it stays that way from your first real edit onward — simply opening a change order still does not save it. New imports and new agent-written lines arrive editable. Purchase orders and invoices never had this problem and are untouched.' },
      { type: 'fixed', text: 'The same thing could happen to a line on an estimate, and now it cannot. When 86 or the Scribe wrote a new estimate line, the address it stamped on that line was sometimes a plain number where the screen can only ever hold text — and a row whose address does not match is a row nothing can reach. Every field on it was dead, delete did nothing, and the save pill read "No changes" while you typed. The record was otherwise perfectly healthy, which is what made it baffling: one row in the middle of a good estimate, inert. Both sides now agree on what an address is, and an affected line is repaired as the estimate loads. Nothing else about the line is touched — not its position, not its group, not a dollar figure — because in an estimate a line belongs to the section above it by position alone, and anything that reordered the list would move money between scopes.' },
      { type: 'fixed', text: 'Saving a change order was erasing settings the editor has no box for, and this one moves money. Any save out of the change-order editor — including the one that runs when you approve a change order with unsaved edits — rebuilt the record from the fields the editor knows about and dropped everything else. Five things sat in that hole: which scope a change order rides and whether it earns on that scope or on the job\'s overall percentage, how the change order is split across buildings, and which purchase order its cost draws against. Set a rider scope in the allocation window, type one character into a line, and seven-tenths of a second later the change order was back on the job\'s overall clock — pill reading "Saved", nothing on screen to tell you. On a $27,500 change order riding a scope that is 90% done, on a job that is 34% done, earned revenue fell from $24,750 to $9,350. It runs the other way too: ride a scope that is behind the job and the erasure raised the figure. It reaches the WIP report, Unbilled, Live Rooms and what 86 tells you. The change order\'s own total, contract and cost were never touched — only how it earns. Nothing is repaired for you. A change order whose rider was erased still has no rider, so if you set a rider scope, a building split or a cost draw and later edited that change order, open the allocation window and set it again. Riders have been erasable since they shipped on 27 July; the building split longer than that; the cost-draw wiring since it shipped on 20 August.' },
      { type: 'fixed', text: 'One damaged line in one estimate was stopping every save in the app, jobs included, and doing it silently. All estimate lines live in one list, so a single hole in a single estimate broke the shared background save for everything that rides it: job fields, buildings, scopes and scope budgets, and every other estimate. The save died before the pill ever moved to "Saving", and the app is built to swallow that quietly, so nothing appeared on screen and nothing appeared when you closed the tab. Your edit looked saved, stayed on screen and survived a reload, because it is written to your browser first — it was gone the next time the server\'s copy won. Surfaces with their own save, like the change-order editor, purchase orders and invoices, were never affected. The damaged estimate also could not be opened at all: clicking it did nothing, forever, with no message. That is fixed, and so is + Line, which was dead on any estimate with a hole above the line you were adding to. Here is what you will see. The app repairs an affected estimate as it loads, by putting a real, empty, $0 line in the damaged slot rather than removing it — removing a slot would re-section the estimate and move money between scopes. So a blank $0 row may turn up in an estimate you already have. It prices to nothing, and unlike the hole it replaced you can see it and delete it. It holds the right position but arrives with no group, so on a multi-group estimate it can surface under Base rather than where you would expect. Loading the app saves nothing; the repair reaches the server the next time that estimate is saved, and opening it in the editor is enough. The honest limit: what put the hole there is not known and is not fixed. What is fixed is that the app no longer breaks on one.' },
      { type: 'fixed', text: 'Pushing a take-off or an assembly into an estimate that is open in the editor was worse than it looked, and it is fixed. The screen was supposed to refresh itself and never once did — not since 18 July, about five weeks. So the lines you had just pushed did not appear, which was the visible half. The half nobody was told about: every row already on screen was left pointing at the old copy of the estimate, so the whole table went dead behind you. Fields took your typing and dropped it, delete did nothing, and the save pill said nothing was wrong. Anything you typed into that table after a push was lost. The way out was to close the estimate and open it again, or to do something that redrew the table on its own — add a line, delete one, switch group tabs. Both halves are repaired: the pushed lines appear, and the rows stay live. The pushed lines themselves were always safe on the server before the screen was ever asked to show them. One limit that is unchanged: a push replaces the estimate\'s lines with the server\'s copy, so an edit you typed in the second before pushing can still be dropped. Finish typing, then push.' },
      { type: 'fixed', text: 'Two scope groups created in the same instant on one estimate could end up being the same group. A group was named after the clock, so two born in the same millisecond got the same name — a markup typed on one landed on the other, and deleting one header removed both. A person clicking twice was never fast enough to cause this; the way it happened is 86 or the Scribe writing two scope groups in a single turn. Groups are now named against what the estimate already holds, so two born in the same instant can no longer collide, and the duplicated section headers that used to ride along with a collision are repaired as they land. No number moves to fix this: the repair writes a name and nothing else — never the order of your lines, never which group a line belongs to, never a dollar figure. Two honest limits. An estimate that already carries two groups sharing a name is not repaired, so if a markup you type on one group lands on another, tell John. And this class of mistake used to be able to reach an estimate that was not even on screen, because every estimate\'s lines live in one shared list; the editor now only ever writes to the estimate you have open, so that part cannot happen again.' },
      { type: 'new', text: '86 can now read a change order and propose a change to one line of it. Ask what is on CO-3 and it comes back with the lines — description, quantity, unit cost, promised price, markup, whether the cost is still a placeholder, and whether the change order is locked. Then ask it to set the cost on line 3 to $1,650 and it changes that line and leaves the others exactly as they are. You can call a change order what you call it: "CO-3", "co 3", "CO-0003" and "3" all find the right one on that job. Name the job when you ask, though — CO-3 exists on more than one job, and reading is not pinned to one the way a write is. Before this it refused — it could see a change order\'s total on the job but had no way to reach the lines, so it declined rather than guess, which was the right answer to a bad situation. It still cannot slip anything past you: a change-order write always renders an approval card you confirm before it lands, and an approved or applied change order is refused outright, the same as it is for you. Nothing is migrated, repriced or recalculated by this — a change order moves only if you ask for it and approve it. One caveat, and it is a real one: this is built but not yet reachable. The new instructions only reach 86 when a sync runs, and that hand-off is not landing reliably for 86 right now. A deploy may carry it; if 86 still says it cannot do this, it has not been handed the instructions, and John has to chase it.' },
      { type: 'fixed', text: 'Asking 86 to delete one line could delete two. A line is found by an address, and if two lines on the same change order or estimate ended up sharing one — which happened when a line came in from an import or was written by an agent — a request to remove one of them removed every line that shared it. The count it reported back was honest about what it had done, so nothing looked wrong: you asked to drop one line, it said it dropped two, and the second one was work somebody had priced. Separately, a line whose address happened to be zero could never be deleted at all — the request was thrown away before it was looked at, and the answer came back "nothing removed" on a line sitting right there. One request now removes one line, two requests remove two, and a request that matches nothing removes nothing. This only ever affected changes made through 86 or the Scribe; deleting a line yourself in the editor has always removed exactly the line you clicked.' },
      { type: 'new', text: 'Ask 86 — "Clear all chats." Open the sessions list in the chat panel, the ☰ at its top left, and there is a small trash-can button beside "+ New chat". Confirm and every rolling chat leaves the list, you land in a fresh empty one, and a note at the bottom of the screen tells you how many were cleared. Read this before you use it, because the confirmation box only asks "Are you sure?" and does not spell out what happens. The chats are archived rather than deleted — the messages are still in the database and John can get at them — but there is no screen anywhere in the app that lists or restores an archived chat, so from where you are sitting this is one way. It clears the rolling chats you have with 86 and with your Assistant, both, and only yours; deal threads and older per-record threads stay exactly where they are. Clearing resets the conversation, not what 86 knows — your company notes are handed to it on every turn regardless. Nothing here reads or writes a job, an estimate or a dollar figure.' },
      { type: 'fixed', text: 'The "Assistant" chip in the blue header opens the chat now. It never has: clicking it put up "Save the record first to enable the AI assistant" and stopped there, and it had done that since the chip appeared on 1 July. Almost nobody hit it, because the round 86 badge sitting a few slots away in the same header did open the chat, and that is the button people used. That badge is gone in this release — two ways into the same chat is one too many — which makes the chip the way in on a desktop, so it had to actually work. It does. One knock-on worth knowing: the amber badge that counts background work waiting on you moved onto the chip, and the chip\'s rounded edge clips it, so the count is not readable there. The same count is legible inside the chat panel, on the Crew activity button. Nothing changed on a phone — the 86 button in the bottom bar was never affected — and chat opened from inside a record, or from the Help center prompt cards or the Email hub\'s "draft my reply", was never affected either.' },
      { type: 'improved', text: 'Present moved out of the floating strip and into your account menu. The small dark card that used to sit over the top right of the header on every job, carrying a "● Present" pill, is gone while nothing is live. Starting a Live Room is now a "📡 Present this job" row at the top of the account menu — on a desktop that is the name badge at the bottom of the left sidebar, and the menu opens upward from there, not in the top right where the pill used to be. On a phone it is the round initials button in the header. The row appears only when you are on a job with nothing live, exactly as the pill did, and clicking it still mints the room and copies the link in one action. Nothing else about Live Rooms changed: the moment you are live the strip comes back where it has always sat — top right on a desktop, along the bottom of the screen on a phone — carrying the watcher count, Copy link and End, with the roster and the Hide-financials switch one click inside it. The sticky notice after a session ends still appears there too.' },
      { type: 'improved', text: 'The blue header now runs to the edges of the window instead of stopping at a fixed width in the middle. On a laptop this is an 8 pixel trim you will not notice. On a 1920-wide monitor the PROJECT 86 brand moves 144 pixels left, and search, quick-add, the bell, the directory and the chip move the same distance right; on an ultrawide it is several hundred pixels each way. Phones and anything narrower than about 768 pixels are unchanged — the header there has always had its own tighter padding. A tablet wider than that gets the same 8 pixel trim a laptop does.' },
    ],
  },
  {
    version: '1.19',
    date: '2026-08-22',
    name: 'Cost and Price',
    summary: 'A change-order line can finally carry both what the work costs and what you charged for it — and one change-order figure 86 reports really did move.',
    changes: [
      { type: 'new', text: 'A change-order line can finally hold two numbers: what the work costs you, and the price you quoted the owner. Unit Cost keeps meaning cost. A new Unit Sell column holds the promise. Type a price into Unit Sell and that line\'s Amount becomes quantity × that price, its Markup % greys out and shows what the promise works out to over the cost — "52.8% implied" on a line that costs $18,000 and is promised at $27,500 — and a small blue dot marks the Amount as promised rather than derived. Leave Unit Sell blank and the line prices from cost × markup exactly as it always has: blank is not zero, and a 0 you type is a real promise of $0. A change order\'s money still only joins the job once it is approved or applied, so putting a price on a draft moves that change order and nothing else.' },
      { type: 'improved', text: 'No change order changes value because of Unit Sell. There is no migration, no backfill, and no guessing at which change orders had a price typed into the cost box — a line already saved carries no promised price, so the new rule never runs on it. The flip side is the part that matters: a change order that reads $0 profit today still reads $0 profit until someone opens it and types. And the order of the two keystrokes matters. Put the quoted price into Unit Sell FIRST — the Amount does not move — and only then put the real cost into Unit Cost. Do it the other way round and you drop the change order\'s value along with its cost: on a change order carrying no markup, one quoted at $27,500 whose real cost is $18,000 becomes an $18,000 change order. The editor saves about three quarters of a second after you stop typing, so stopping halfway leaves the smaller number saved. An applied change order cannot be edited at all, and an approved one has to be unlocked first.' },
      { type: 'fixed', text: 'A change order that rides a scope was earning two different revenue numbers. Your browser worked it out at the percent complete of the scope the change order rides; the server worked the same change order out at the job\'s overall stored percent — so 86 could quote you one figure while the job screen showed the other. There is one clock now, and the server follows the scope. This one does move money: on a job where a ridden scope is further along, or further behind, than the job as a whole, that change order\'s earned revenue is not the number it was last week. It moves toward what the job screen has been showing you all along, and the job screen itself does not move — it has been on the scope clock the whole time. A change order that was never told how it earns follows the live scope grid too, on any job that has scopes; one pointed at a scope that has since been renamed or deleted now reports $0 earned, which is also what the job screen has been showing. What does not move: contract, change-order total, estimated costs and actual costs are untouched, and no invoice and no pay application changes value — not one billed dollar. Unbilled does move, because the earned side reprices while what you have invoiced stays where it is. Where you will see it: in what 86 tells you, and — for anyone watching a Live Room with financials showing — in the Revenue Earned on their screen and the profit and margin worked from it. And it only lands on jobs whose Site Plan has pushed an earned-revenue figure; on jobs that have not, nothing changes at all.' },
      { type: 'improved', text: 'The change-order line table now shows what a line costs. It reads Description, Qty, Unit, Unit Cost, Markup %, Unit Sell, Ext. Cost, Amount — the first five exactly as the estimate editor reads them, then Unit Sell, which only a change order carries. Ext. Cost (quantity × unit cost) is the number that becomes the change order\'s cost on the job, and it had never been on screen at all; the Unit column shows something the catalog has been filling in all along and nothing displayed. Up in the chip bar, "Subtotal" is now labelled "Est. Cost", because that is what it is, and a Profit chip sits on the same bar — read that chip for what it is, the change order total minus the line cost, so it carries fees and tax as well as margin on the work. Section rows now carry their own cost, amount and a colour-coded GM% chip, so a trade priced at zero margin no longer looks identical to one priced at forty. No number moved to put any of this on screen. On a phone the table now scrolls sideways inside its own frame instead of dragging the page with it.' },
      { type: 'fixed', text: 'The Markup % box on a change order stopped pretending. Set a target margin on a change order and the total is worked back from cost, ignoring every per-line markup — but the box stayed live-looking and took whatever you typed into it. It is greyed now, with a banner under the chip bar saying the target margin is driving the total and naming how many lines carry a promised price and are therefore left out of that back-solve. The same greying applies to any line you have given a promised price: Markup % and Unit Sell are never both in charge, and whichever one is not driving the price shows its worked-out value in grey, as a hint rather than a number you can edit.' },
      { type: 'improved', text: 'If you have typed a promised price onto an assembly line, exploding that line into its parts drops the promise and changes the change order\'s total — the parts are born pricing from cost × markup, because spreading one promise across every part would multiply it. The confirmation now states the promised price and both totals, before and after, so you see the number move before you click rather than after.' },
      { type: 'fixed', text: 'A change order built from an imported PDF now records the number on the page as a price, not as a cost. The importer had been reading a quoted line as if it were what the work costs you, which made every imported change order read as zero profit and pushed the whole quote into the job’s estimated cost. Imported lines now put the price where the price belongs and flag the cost as unknown: an amber COST? badge on the line, an amber Unit Cost, and a banner under the chip bar saying how many lines still need a real cost. Type the real cost into Unit Cost and the badge clears. No dollar moves when this ships — the placeholder cost is deliberately the same number the importer used before, so an import totals exactly what it would have totalled yesterday. Two limits worth knowing: this applies to change orders imported from here on, not to ones already in the system, which carry no badge and no banner. And purchase-order import is untouched — the number on a PO really is a cost.' },
      { type: 'fixed', text: 'A change-order line written by 86 or the Scribe could come out worth $0. If the model wrote a field name in a slightly different style than the app expected — an underscore where the app wanted the words run together — the value landed under a name nothing reads, the line priced at nothing, and the write still reported success. Both spellings are now understood. The shape 86 has always been told to use worked correctly, so this only ever bit when it strayed from it, and the translation applies to lines as they arrive, so no change order already saved is rewritten as a side effect of an unrelated edit.' },
      { type: 'improved', text: 'The Materials Drawer will no longer add an assembly that has unpriced items in it — on a change order or on an estimate. It used to put a warning badge on the row and add the recipe anyway, treating every missing price as $0, so the one door people actually use quietly appended a cost that was too low. Now it stops and names the items that need a price, in a message you can actually see. Nothing already saved changes; this only affects what gets added from here on.' },
      { type: 'new', text: '86 and the Scribe can now put a costed assembly onto a change order whole — one line per cost bucket, with the recipe supplying the cost and the change order\'s own markup supplying the price — instead of hand-writing flat lines with guessed costs. If the recipe has an unpriced item, a broken formula or no quantity, they are stopped outright and told not to work around it by making a cost up. You could already do this yourself from the Materials Drawer; what is new is that the agents can. If 86 says it cannot, it has not picked up the new instructions yet — ask John to run the agent sync.' },
      { type: 'fixed', text: '86 was getting purchase orders wrong, while the job page had them right the whole time. Ask it about a PO and no amount came back at all, so it told you the amount was blank or not set — it had been hunting for a stored total that a purchase order does not have, because a PO\'s total is its line items plus any approved addendums. And it only ever saw an internal id where the subcontractor\'s name should be, so it had nothing to name the vendor from and named the wrong one. It now reads the same total the job page reads, and names the sub off the record. Anything 86 told you about a PO\'s amount or its vendor before this is worth checking again. The numbers are right the moment this ships; the wording that tells 86 the amount is authoritative rather than a blank reaches it on the next agent sync.' },
      { type: 'improved', text: 'The percentage complete 86 quotes still does not match the job screen, and this release does not touch it — 86 reads the stored figure, which can say 51.0% where the job screen reads 73.8%. Revenue earned moved closer: on a job whose Site Plan has pushed a revenue figure, the change-order half now agrees exactly with the job screen. On a job that has scopes but no pushed figure it still does not — there the server works the whole number as total income times the stored percentage, and never runs the change-order clock at all. The base-contract half is worked out differently on each side either way, and was deliberately left alone until it can be checked against real jobs.' },
      { type: 'improved', text: 'One number on screen reads low, and this release names it rather than fixing it. The small Revenue / Cost / Profit / % Complete / Earned strip inside the window where you allocate a change order across buildings and choose how it earns prices that change order from its raw line total, without the markup, fees or tax set on the change order itself. A markup typed on an individual line does travel; anything set on the change order as a whole does not. On a change order whose lines cost $27,500 with 20% markup set on the change order, the strip reads $27,500 revenue and $0 profit while the total at the top of that same window reads $33,000; at a 35% target margin it reads $27,500 against $42,308. Only a change order with no markup on it reconciles. The change order\'s own total, the WIP report and 86 all carry the right number — trust those, not the strip. This has always been true; it matters more now that markup on a change order is routine.' },
      { type: 'improved', text: 'Global search now lives permanently in the blue header bar, at the left end of the icons on the right — always visible and typeable on every page, without expanding anything first. It took the slot the old "Back to Jobs / job name / status" block used to occupy on a job page, which was duplicating the left sidebar: the sidebar still carries "All Jobs" and the job card, and the job\'s name and status are on the Job Information card in the page itself. On a phone, where the sidebar is hidden, the way back is the Jobs button in the bottom bar. Search is a desktop feature — in a window narrower than about 768 pixels the header search is hidden, and there is no global search box on a phone.' },
      { type: 'improved', text: 'Expanding a subcontractor on a job\'s Subs tab now lists the purchase orders behind that sub — the PO number, its title, its total and how much has been billed against it — so the Contract figure on the sub\'s row is broken out into the pieces it is made of. The same breakdown shows in the Subcontractors list in the Site Plan inspector. No number moved: the POs listed add up exactly to the Contract and Billed already on the row, because a sub\'s contract was already the sum of its purchase orders — you just could not see it. Draft, void, cancelled and rejected POs are not listed, and were never in the total either. What this replaced was the old "Site Plan Connections" block, a leftover from the retired node-and-wire model that carried no money and on most jobs read "Not placed on graph yet".' },
      { type: 'new', text: 'A third kind of job. Mid-Tier Service sits between a service call and a renovation — the $10,000 to $50,000 work that is more than a visit and less than a project. Its numbers mint as M0001, M0002 and so on, off the same counter every other type uses, and the coordinator picks the type when the job is created. Nothing already in the system was reclassified and no job was renumbered — a job number is identity here, and it is printed on purchase orders, pay applications and signed change orders. The dollar range is guidance, not a rule: nothing anywhere checks a job\'s amount against its type. A job that is mid-tier in character can be one at $52,000, and a service call that came in under budget stays a service call.' },
      { type: 'fixed', text: 'A picker in the Job Information card can no longer change a value nobody touched. Opening a job to fix its title could quietly change other things about it, because a dropdown that does not contain the record’s value falls back to its first entry and the save wrote that back — with no prompt and nothing on screen to show it. The project manager was the live one: any job whose PM was not one of three names hardcoded into the app — including a job with no PM at all — was reassigned by the act of opening the card. Job type was the same story, and had been reclassifying every job converted from a Service & Repair lead. Two things changed: a dropdown now always offers whatever the record actually holds, even a value you have since renamed or retired, and the save now writes only the fields you actually touched — change nothing and nothing is written at all. The PM list comes from your real people now instead of three names in the code. Nothing already saved was altered to fix this; the repair is that it stops happening. One thing still to sort out: this card shows the PM from the job’s owner but edits an older separate field, so picking a PM here does not yet hand the job over to them.' },
      { type: 'fixed', text: 'A Work Order could never be turned into a job from a lead or an estimate. The convert step accepted two job-number shapes, S and RV, while the settings page has offered three since it shipped — so a Work Order could claim its number and then be refused the job. It now reads the list your organisation actually uses. The app was keeping three separate copies of that list and two had drifted, which is why the Finalize step used to tell you a WO number was not a valid shape. And a job numbered under a type your organisation has since removed now still says what it is, instead of showing a dash on the job card while the Jobs list beside it named the type correctly.' },
      { type: 'fixed', text: 'A cost you pasted into a change order was not saved. Typing the real cost onto a line that came in from a PDF rebuilt the table under your cursor — the box you were typing in was destroyed mid-number and the caret jumped out of it. Worse, that first keystroke did not schedule a save at all, so a cost pasted in one go was never sent to the server while the editor still said Saved. Both are fixed: the cursor stays where it is, and a pasted number saves like any other. If you repaired change orders earlier today, open them and check the cost reads what you meant — some of those edits did not reach the server. Nothing is repaired for you: a change order whose cost was lost still shows cost equal to price until someone types it again.' },
      { type: 'fixed', text: 'Deleting an assembly did nothing at all. The confirmation box came up empty, and whichever button you pressed nothing was deleted — the delete was wired to the dialog the wrong way round, so it was never called. If you tried to delete an assembly and concluded the button was broken, you were right. It works now, and when the server refuses a delete it tells you why instead of failing quietly.' },
      { type: 'fixed', text: 'A job converted from a lead is now given a real job type. It used to copy the wording off the lead, so a job converted from a Service & Repair lead was born carrying words that are not a job type at all — it could never be found by the Jobs list Type filter, and it vanished from the Schedule board the moment any type pill was switched on. The job type is now taken from the job number you picked at conversion, so the two can never disagree. Leads, estimates and jobs now offer the same list of types, drawn from your own settings, which means you can mark a lead as Mid-Tier Service — you could not before. An existing lead reading Service & Repair keeps saying that until someone changes it on purpose, and the Leads filter still offers it so nothing gets lost. One limit: this covers conversion. Creating a job straight from the Add Job button still lets you pick one type and type a number with a different prefix, and the QuickBooks import still creates jobs with no type at all.' },
      { type: 'fixed', text: 'Switching straight from one job to another could leave the wrong job’s name on screen — and send your files to it. Going from job to job by search, by a link, or by a row in the Jobs list left the identity card in the sidebar showing the job you came from, while everything else on the page had already moved on. Since that card is what tells you which job you are looking at, an upload or an edit could land on the previous job without anything looking wrong. If a file of yours is on the wrong job, this is why.' },
      { type: 'improved', text: 'Purchase orders imported from PDFs now come in with the subcontractor attached. The import read the vendor name off the page but never linked it to the sub, so imported POs showed a name with nothing behind it — which broke sub-scoped uploads and reports and left 86 attributing the work to nobody. The review screen now has a Sub picker beside the vendor, pre-filled by matching the name on the document against your real subcontractors, and you can override any row. Purchase orders already imported need their sub set once by hand in the PO editor — they cannot be repaired from the import screen.' },
    ],
  },
  {
    version: '1.18',
    date: '2026-08-18',
    name: 'Live Rooms',
    summary: 'Show a job to someone over a link without giving them an account — and a fix for sheet drawings that were reloading empty.',
    changes: [
      { type: 'fixed', text: 'Sheet drawings were reloading empty. From 12 July until this week, opening a drawing could show a blank canvas — the geometry was still in the record, but the app threw it away when loading, and the next save then wrote the blank version back. If a drawing of yours went missing in that window, it was this, not you. Most affected drawings come back on their own the first time you open them now. For any that stay blank, ask John — there is a recovery tool that can pull the drawing back from a restore point, and it shows exactly what it would restore before restoring anything.' },
      { type: 'fixed', text: 'The drawing editor said "Saved." before the save had actually left the browser, and if it failed nothing tried again. It now says saved when it is saved, retries on its own, and tells you plainly when it cannot reach the server.' },
      { type: 'new', text: 'Live Rooms — a Present button in the job header. One click mints a link; anyone you send it to can watch the job you are showing, with no account and nothing to install. The people watching are listed by name with how long they have been there, and you can remove any of them.' },
      { type: 'new', text: 'What they open is the job itself, read-only — not a video of your screen — so it stays sharp on a phone in the field and costs very little data. When you move between the Overview, WIP Report, Job Costs and Change Orders, their screen follows you. They can break off to read something and come back.' },
      { type: 'new', text: 'On the WIP Report and Change Orders, the person watching now sees your actual screen rather than a rebuilt copy of it — the same tables, the same wording, updating as you scroll and edit. The strip along the top tells you which of the two you are sending and draws a frame around exactly what they can see. Your 86 panel, pop-up windows and the sharing bar itself are never part of it.' },
      { type: 'new', text: 'Hide financials, on by default. With it on, contract, cost, profit and margin are never sent to whoever is watching — not hidden in the page where they could be dug out, but genuinely not sent. Progress, status, client and schedule still show.' },
      { type: 'fixed', text: 'Job Reports had been returning an error to everyone, including admins, since it was built. It works now.' },
      { type: 'fixed', text: 'Company knowledge-base PDFs could not be opened by anyone. Fixed — the file viewer opens them again.' },
      { type: 'fixed', text: 'Deleting an attachment, editing its caption, and Move / Copy in My Files were all unreachable — the buttons were there and did nothing. All working again.' },
      { type: 'new', text: 'Daily Logs, Photos and Files now have their own tabs in the job sidebar, so they are one click from the job instead of somewhere else.' },
      { type: 'improved', text: 'Site Plan unit check-offs read as flat blue tiles when done, which is easier to scan across a building than the old raised green cubes.' },
      { type: 'improved', text: 'Push notifications repair themselves. If the notification keys are ever changed, your device notices on the next page load and re-subscribes on its own instead of going quiet.' },
      { type: 'fixed', text: 'The Email settings panel could get stuck after a refused change and needed a reload to recover.' },
      { type: 'fixed', text: 'Buildings are listed in order everywhere. The change order allocation list showed them in the order they were traced on the map, so B1 could sit below B10 — and different screens on the same job could disagree. One order now, everywhere. The money each building carries is unchanged; only the order you read them in moved.' },
      { type: 'new', text: 'A change order can name the subcontractor doing the work, and record which purchase order its cost draws against — either its own, or the PO already on the scope it rides. The job page shows what each change order draws on. This is a record of where the cost belongs, not a new charge: no job total moves when you set it.' },
      { type: 'improved', text: 'Purchase orders can name the scope they cover. That is what lets a change order riding a scope find the right PO — and renaming a scope now carries its purchase orders and change orders with it instead of quietly orphaning them.' },
      { type: 'fixed', text: 'The QuickBooks cost import used to give one explanation for two different problems, and it led with the wrong one. A project that will not import now says which it is: the QuickBooks name does not start with a job number — fix that in QuickBooks — or the name is fine and no such job exists here yet, in which case it names the number it looked for so you can create it. Where it genuinely cannot tell the two apart, it says that instead of guessing.' },
      { type: 'new', text: 'Admin — a record of who did what. Privileged actions now write an audit row naming the person, the record, the time and where from, including attempts that were refused. Searchable under the Command Center.' },
      { type: 'new', text: 'Admin — two new tools: rotate the push notification keys (with a plain description of what it costs before you confirm), and a Tenant boundary report showing which records are fully stamped to an organization.' },
    ],
  },
  {
    version: '1.17',
    date: '2026-08-17',
    name: 'Say So',
    summary: 'Records called by their names, changes that show up the moment they happen, and an app that tells you when it cannot do something instead of failing quietly.',
    changes: [
      { type: 'fixed', text: 'Subcontractors see the job, not the word "job". The share portal used to head every shared folder with the literal record type; it now reads the real job — "RV2006 Waterside 1 Siding Replacement" — and a shared task names the job it belongs to.' },
      { type: 'improved', text: 'One job name everywhere. Job number and title now render the same way on every screen, export and email: "RV2006 Waterside 1 Siding Replacement", no dash.' },
      { type: 'fixed', text: 'Chat threads are named after the lead or job they are about. Threads that read "Deal · lead_1786497735707_d39nqj" now read "Deal · Uptown - Dumpster Pad Repair", and they follow the record if you rename it. Existing threads fixed themselves — nothing to run.' },
      { type: 'improved', text: 'Search finds a thread by the name you can see. Typing a job or lead name in chat search now finds its thread even when the title is drawn from the record rather than typed by hand.' },
      { type: 'new', text: 'Cowork — a full page for watching the Scribe work. The live diff, a document view of the estimate being changed, and a ledger of everything the Scribe has done, with 86 docked alongside.' },
      { type: 'new', text: 'The Writes ledger records the times the Scribe could not, not only the times it could. A refusal, a failed apply and a write with nothing to show are each their own row with their own reason.' },
      { type: 'improved', text: 'When you are already looking at the estimate, the change animates in the real editor instead of opening a second copy of it beside the one you are reading.' },
      { type: 'fixed', text: 'Scope written by an agent now lands where the app reads it. A scope set through chat was being saved to a field nothing displays — it applied cleanly, reported success, and was invisible on every screen. Text stranded that way comes back on the next save.' },
      { type: 'improved', text: 'An agent that cannot find the scope or section you named now says so by name, listing what does exist, instead of quietly putting the line somewhere else and reporting a success.' },
      { type: 'new', text: 'A change that cannot reach the server is held, not thrown away — and the app says so. During a deploy or a network drop, edits to jobs and estimates are kept and sent when the connection returns, with a banner telling you how many are waiting.' },
      { type: 'fixed', text: 'A job somebody deleted is not put back. If a record is removed while your tab is holding an unsent change to it, the change is refused and you are told by name — the job is not re-created behind you.' },
      { type: 'improved', text: 'A change you make is a change you see. Purchase orders, change orders, bills, invoices, tasks, reminders and calendar entries now update the lists and the money tiles the moment they are saved, from every place they can be saved — including bulk document import.' },
      { type: 'fixed', text: 'The Bills card could only ever show $0 paid. It was asking for open bills only, so "Paid" was always zero and Outstanding always equalled the total.' },
      { type: 'fixed', text: 'Deleting a task and approving a purchase order work in the installed app. Both sat behind a confirmation dialog that does nothing when the app is installed to a home screen — delete silently did nothing, and approval recorded a signature with no name on it.' },
      { type: 'new', text: 'Weekly cost flow on QuickBooks costs — a twelve-week grid of what each bucket cost per week, with the change from the week before, and cost lines groupable by week with a running subtotal.' },
      { type: 'new', text: '86 can put an assembly on an estimate whole. Ask for a recipe and it lands as one priced line that remembers what it is made of, so you can explode it into its parts later if you want to.' },
      { type: 'new', text: 'Send a task to someone without an account. Share a task by email and an outside worker can open it, see the location and photos, and mark it complete from a link that expires and can be revoked.' },
      { type: 'improved', text: 'The task view opens read-first with an edit gate, a mini-map on the location, larger photos, and geo-pinned photos on the map that open full screen.' },
      { type: 'improved', text: 'The share portal sends only what the folder view needs. It was also shipping the full extracted text of every PDF and internal record ids alongside the file list.' },
      { type: 'fixed', text: 'Uploading several photos at once puts them all in the folder you have open, and camera and library are separate buttons instead of one prompt that asked every time.' },
    ],
  },
  {
    version: '1.16',
    date: '2026-08-07',
    name: 'Lead to Job',
    summary: 'A full walkthrough of the lifecycle — intake through billing — and a pass over the rough edges found by actually running one job end to end.',
    changes: [
      { type: 'new', text: 'From lead to sold job — the guided tour now walks the whole lifecycle in twelve steps: starting a lead from its address, building and pricing the estimate, sending the proposal, converting to a job, then how that job bills and collects cost.', tour: 'lead-to-job' },
      { type: 'fixed', text: 'New Lead now has address lookup. Type into Street and pick a suggestion — city, state and zip fill themselves, and the Map and 7-Day Forecast panels come to life instead of sitting on their placeholder.' },
      { type: 'improved', text: 'Address suggestions come off the Street field itself on leads, matching estimates and jobs — no more separate search box stacked above the field it fills.' },
      { type: 'improved', text: 'Market is a dropdown on leads and clients, not a free-text box. It has to match for the market to follow a lead through to its job, and a typo used to drop it silently.' },
      { type: 'fixed', text: 'Creating an estimate from a lead opens the estimate. It used to leave you back on the Leads list with nothing to show for it, which looked like the create had failed.' },
      { type: 'fixed', text: 'A sold estimate reads "Sold". Converted estimates used to show their proposal status as "Draft" forever, directly under the Sold banner.' },
      { type: 'fixed', text: 'Pay applications no longer withhold 10% retainage automatically. Retainage applies when you enter it; existing applications keep whatever rate they were saved with.' },
      { type: 'improved', text: 'Job numbers suggest the next available S and RV number as a chip when you convert, instead of a blank box.' },
      { type: 'improved', text: 'Clearer wording on the job money strip: "On buildings" and "Unassigned" instead of "Allocated" and "Unallocated", which read as a contradiction on a job whose contract had not been split across buildings yet.' },
      { type: 'improved', text: 'Lost Reason only shows on a lead once you mark it Lost — it used to sit on the New Lead form, where it cannot apply.' },
    ],
  },
  {
    version: '1.15',
    date: '2026-07-26',
    name: 'Standard Parts',
    summary: 'Your purchase history, folded into reusable parts — the same product bought under a dozen Home Depot names becomes one standard part priced from what you\'ve actually paid.',
    changes: [
      { type: 'new', text: 'Consolidate — a new view in Assembly Studio that scans your material catalog and groups the "likes" together. A 2x4-8 stud bought as "2x4-96 KD-HT", "2x4-8 Stud", and "2x4-92 5/8 Whitewood Stud" is really one part — review the group, drop anything that doesn\'t belong, name it, and create the standard part in one click.' },
      { type: 'new', text: 'Prices come from your own receipts — each standard part is priced as a blend of what you actually paid, weighted by how often you bought each version, so estimates ground in real numbers instead of guesses.' },
      { type: 'improved', text: 'Creating a part is safe and reversible — the original catalog lines are hidden (never deleted), your purchase history is untouched, and any recipe that used an old line is re-pointed to the new part automatically.' },
    ],
  },
  {
    version: '1.14',
    date: '2026-07-19',
    name: 'Assembly Studio',
    summary: 'Everything about your cost assemblies now lives in one place on the main menu — browse and build recipes, manage codes, and tune with 86, all under Assembly Studio.',
    changes: [
      { type: 'new', text: 'Assembly Studio — a new top-level section in the main menu (under Sales) that gathers every assembly tool into one home: Assemblies, Studio, Codes, and Parametric. No more hunting across Estimates, the Command Center, and Admin.' },
      { type: 'new', text: 'Assemblies — browse and build your costed recipes, grouped in a Trade → System tree with live catalog pricing, right where you\'d expect them.' },
      { type: 'improved', text: 'Assembly Codes moved here — the Trade · System · Variant code manager is now Assembly Studio → Codes (it used to be tucked under Admin → Organization), so any estimator can manage the taxonomy without admin access.' },
      { type: 'new', text: 'Parametric — a dedicated view for formula-driven recipes (the ones that price from geometry), with a shortcut over to Plans & Takeoffs to draw a shape and let its measurements drive the quantity.' },
      { type: 'new', text: 'Studio — the build-and-tune workbench with 86 docked alongside (for platform admins) now lives inside Assembly Studio instead of the Command Center.' },
    ],
  },
  {
    version: '1.13',
    date: '2026-07-19',
    name: 'Payables',
    summary: 'Vendor bills get their own home — recorded against a job and its PO, so what you\'ve been billed and what you still owe is one number everywhere.',
    changes: [
      { type: 'new', text: 'Bills tab — a new page under Jobs (beside Purchase Orders) listing every vendor bill across your jobs: bill #, job, vendor, PO, amount, status, and due date, with filters, search, and saved views.' },
      { type: 'new', text: 'Link a bill to its Purchase Order — pick the job, pick the PO, and the vendor fills in automatically. Attach the invoice PDF right on the bill, and move it through Open → Approved → Paid (or Void).' },
      { type: 'new', text: 'Read an invoice straight into a bill — in Bulk Document Import, the "Invoices" tab now scans a vendor invoice, pulls the amount and line items, matches it to a job, lets you pick the PO it pays against, and creates the bill for you.' },
      { type: 'improved', text: 'One source of truth for "billed" — the Bills tab and a PO\'s "Bills & Lien Waivers" now read and write the same record, so a bill entered in either place instantly updates the PO\'s % billed, the job\'s outstanding, and the accrued-cost rollup. No more two numbers that disagree.' },
      { type: 'improved', text: 'Assembly Codes — assemblies now carry a consistent Trade · System · Variant code (like ROOF-SHNG-612), managed from Admin → Organization → Assembly Codes, so your estimating library stays organized and findable as it grows.' },
    ],
  },
  {
    version: '1.12',
    date: '2026-07-13',
    name: 'Inbox',
    summary: 'Your email comes into the app, tied to the client it\'s from, triaged for what it needs — and the assistant reads it all in context.',
    changes: [
      { type: 'new', text: 'Email Dropbox — forward or redirect a copy of your inbox to a private address (from My Account → Email Dropbox) and it flows into Project 86. No Outlook connection required. Your real inbox is untouched.' },
      { type: 'new', text: 'Email tab — an in-app inbox: conversations on the left, the full thread on the right, search, and a one-click "Ask the assistant about this" that hands the whole thread to 86.' },
      { type: 'new', text: 'Every email is tied to who it\'s from — matched to your clients and subs — so the thread shows a client chip and the assistant reads mail already in context (it can pull that client\'s jobs and leads in one step).' },
      { type: 'new', text: 'Triage — each email is read for what it\'s asking, whether it needs a reply, and any dates or commitments. Threads that need a reply get flagged, and the assistant proactively offers to set a reminder or add a calendar event (you approve before anything is created).' },
      { type: 'new', text: 'My Day now leads with your email — what came in overnight and what needs a reply — so the day starts with your first line of contact.' },
      { type: 'improved', text: 'The assistant can now answer "anything I need to reply to?", summarize a thread, and draft a reply in the context of the client it\'s from.' },
    ],
  },
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
      { type: 'improved', text: 'The pop-out Workspace now fills its window, and the toolbar reads like Excel\'s ribbon — grouped captions, dividers, and crisp line icons in place of emoji.' },
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
