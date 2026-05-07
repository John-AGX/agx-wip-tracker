# AGX Branding Inventory

Snapshot taken **before** the Project 86 rebrand. Use this manifest to
restore AGX-branded chrome if the rebrand needs to be reverted later.

## Scope: visible site chrome only

This inventory captures **only user-visible branding** — page title,
header lockup, login screen, accent colors, logo assets. It does **not**
include code-only references to AGX such as:

- AI agent system prompts (`AGENT_SYSTEM_BASELINE` in
  `server/routes/admin-agents-routes.js`) — these contain `"AGX = AG
  Exteriors"` and similar context the AI uses to know what business
  it's working on. The underlying business is still AGX even after the
  site rebrands; do **not** edit these.
- API route names, DB columns, JS variable names (`window.agxAlert`,
  `agxIcons`, etc.) — internal identifiers, never user-visible.
- Storage hostnames (`wip-agxco.com`, `agxco.com`) referenced in
  `server/storage.js`, OAuth, etc.
- Asset directory naming (`assets/icons/agx/`, `js/agx-icons.js`) —
  filesystem paths, not user-visible.

### Intentionally **not** rebranded (visible AGX-the-business strings)

These appear in user-visible places but reference **AGX as the
underlying business** rather than the site's brand. They were
deliberately left alone during the Project 86 rebrand:

| File | Line | String | Why kept |
|---|---|---|---|
| `js/ai-panel.js` | 970 | `'📐 AG · AGX Estimator'` | Labels the AI agent's expertise (AGX-trained estimator); identity, not site brand |
| `js/estimates.js` | 417 | `<h1>AGX Central Florida</h1>` | Estimate-report header on the printed/exported document — that document IS from AGX |
| `js/proposal.js` | 88 | `wb.creator = 'AGX Central Florida'` | XLSX metadata on the generated proposal workbook |
| `js/proposal.js` | 527 | `'AGX Central Florida is pleased to provide…'` | Contractual proposal letter body — AGX is the contracting entity |

If the goal ever shifts to "fully rebrand even AGX-the-business
references," these are the additional touchpoints to handle.

Restoration of AGX = restore the items below + restore the snapshot
files in `./snapshot/` and the logo PNGs in `./images/`.

---

## Files snapshotted (verbatim copies in `./snapshot/`)

| Snapshot path | Original path | What's branded inside |
|---|---|---|
| `snapshot/index.html` | `index.html` | Page title, login screen, header lockup |
| `snapshot/styles.css` | `css/styles.css` | Header gradient + green accent values |
| `images/logo-white.png` | `images/logo-white.png` | AGX wordmark (white-on-dark) |
| `images/logo-color.png` | `images/logo-color.png` | AGX wordmark (color) |

---

## Touchpoints — index.html

### 1. Page title
- **Line:** 13
- **Original:** `<title>AGX Central Florida &mdash; WIP Tracker</title>`
- **Replacement:** `<title>Project 86 &mdash; WIP Tracker</title>`

### 2. Login screen — logo image
- **Line:** 24
- **Original:** `<img src="images/logo-white.png" alt="AGX" style="height:48px;margin-bottom:24px;opacity:0.9;" />`
- **Replacement:** swap to Project 86 logo when ready; keep `alt="Project 86"`.

### 3. Login screen — heading
- **Line:** 25
- **Original:** `<h2 ...>AGX Central Florida</h2>`
- **Replacement:** `<h2 ...>Project 86</h2>`

### 4. Login screen — tagline
- **Line:** 26
- **Original:** `<p ...>Estimating &amp; Project Tracking</p>`
- **Replacement:** keep as-is (generic) OR rephrase per Project 86 voice.

### 5. Header brand — title attribute
- **Line:** 43
- **Original:** `<a class="header-brand" title="AGX &mdash; Estimating &amp; Project Tracking">`
- **Replacement:** `<a class="header-brand" title="Project 86 &mdash; Estimating &amp; Project Tracking">`

### 6. Header brand — logo image
- **Line:** 44
- **Original:** `<img src="images/logo-white.png" alt="AGX" class="header-logo" />`
- **Replacement:** swap to Project 86 logo; keep `alt="Project 86"`.

---

## Touchpoints — css/styles.css

### 7. Header gradient (the dominant visible AGX green)
- **Line:** 213
- **Original:** `background: linear-gradient(135deg, #0d1f12 0%, #14351d 40%, #1B8541 100%);`
  - These three colors are the AGX green: nearly-black-green → mid-green → bright AGX green.
- **Replacement:** swap to the chosen Project 86 palette (charcoal/slate or whatever the user picks).

### 8. Header bottom hairline border
- **Line:** 214
- **Original:** `border-bottom: 1px solid #3B8542;`
- **Replacement:** match the new accent — darker than the gradient end so it reads as a hairline.

### Other green-coded values to leave alone (semantic, not brand)
The following greens encode **semantic meaning**, not AGX brand. Do NOT
rebrand these — they appear next to/beside the brand colors but mean
"success" / "won" / "active":

- `--green` CSS variable — used for "won" status, success chips, etc.
- Status pill colors (NEW / IN PROGRESS / LOST) — these are signal
  semantics for the tracker, not branding.
- Tool-applied green chip backgrounds (`#34d399`, `border-left-color`
  on auto-tier chips) — signal semantics.

---

## Logo assets

Both PNGs are 4-channel transparent. Approximately:

- `logo-white.png` — 9.5 KB, used in the dark header.
- `logo-color.png` — 16.5 KB, color version (currently unused on the
  site; preserved for completeness and future light-mode use).

To restore: copy `archive/branding/agx/images/*` back to `images/`.

---

## Restore checklist

If/when AGX branding needs to come back:

1. Copy `archive/branding/agx/images/logo-white.png` → `images/logo-white.png`
2. Copy `archive/branding/agx/images/logo-color.png` → `images/logo-color.png`
3. In `index.html`:
   - Restore lines 13, 24-26, 43-44 from `archive/branding/agx/snapshot/index.html`.
4. In `css/styles.css`:
   - Restore lines 213-214 from `archive/branding/agx/snapshot/styles.css`.
5. Bump `index.html` cachebust on `css/styles.css?v=…` so browsers reload.
6. Commit + push.

The snapshot files are **full file copies** so a worst-case restore is
just `cp archive/branding/agx/snapshot/index.html index.html` and
likewise for styles.css. The diffs against the rebrand commit will
show exactly what to merge if the file evolved between rebrand and
restore.
