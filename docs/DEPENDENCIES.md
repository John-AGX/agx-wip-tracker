# Project 86 — Dependency & License Inventory (SBOM)

**Generated:** 2026-07-27 · **Scope:** production dependencies (`npm --production`)
**Regenerate:** `npx license-checker --production --summary` (detail: `--json`)

> Purpose: confirm the licensing position of everything shipped in the running product. Relevant to distribution and to any commercial licensing of the platform. Development-only dependencies are excluded — they are not distributed.

## Summary — license distribution (production tree)

| License | Packages |
|---|---|
| MIT | 210 |
| Apache-2.0 | 98 |
| ISC | 18 |
| BSD-2-Clause | 8 |
| BSD-3-Clause | 7 |
| MIT* (inferred from README, no LICENSE file) | 2 |
| Apache-2.0 AND LGPL-3.0-or-later | 1 |
| Unlicense | 1 |
| BSD* (inferred) | 1 |
| (MIT OR GPL-3.0-or-later) — dual-licensed | 1 |
| (MIT AND Zlib) | 1 |
| 0BSD | 1 |
| Custom (URL-referenced) | 1 |

**Position: clean.** The tree is overwhelmingly permissive (MIT / Apache-2.0 / ISC / BSD). **No package imposes a strong-copyleft (GPL/AGPL) obligation on the platform.** The four items worth naming are reviewed below.

## Direct production dependencies

| Package | Purpose | License |
|---|---|---|
| `@anthropic-ai/sdk` | AI models / agent runtime (Claude) | MIT |
| `@aws-sdk/client-s3` | S3-compatible client for Cloudflare R2 | Apache-2.0 |
| `@azure/msal-node` | Microsoft 365 mailbox auth | *to confirm — see note* |
| `bcryptjs` | Password hashing | MIT |
| `cookie-parser` | Cookie parsing | MIT |
| `exceljs` | Excel import/export (Workspace) | MIT |
| `exifr` | Photo EXIF/GPS extraction | MIT |
| `express` | HTTP server | MIT |
| `express-rate-limit` | Rate limiting | MIT |
| `jsonwebtoken` | Auth tokens | MIT |
| `mammoth` | .docx text extraction | BSD-2-Clause |
| `multer` | File uploads | MIT |
| `pdf-parse` | PDF text extraction | MIT |
| `pg` | PostgreSQL client | MIT |
| `resend` | Outbound transactional email | MIT |
| `sharp` | Image processing / thumbnails | Apache-2.0 |
| `twilio` | SMS | MIT |
| `web-push` | Web push notifications | *to confirm — see note* |

## Items reviewed

- **`@img/sharp-win32-x64` — Apache-2.0 AND LGPL-3.0-or-later.** The platform-specific `sharp` binary bundling libvips. LGPL is *weak* copyleft: obligations attach to modifying the library itself, not to an application that merely calls it. `sharp` is used unmodified as a dependency, and this is the **Windows dev-machine** binary — production on Railway (Linux) resolves the corresponding Linux binary. No obligation on Project 86's own source. *No action.*
- **`jszip` — (MIT OR GPL-3.0-or-later).** Dual-licensed; the licensee elects. **Project 86 elects MIT.** *No action beyond recording the election here.*
- **`MIT*` / `BSD*` (`chainsaw`, `traverse`, `duck`).** The asterisk means the license was inferred from the README because the package ships no `LICENSE` file. All are permissive; these are transitive, low-level utilities. *No action.*
- **`buffers@0.1.1` — "Custom" (license field points to a repository URL).** A very old transitive utility. Permissive in practice, but it carries no machine-readable license. *Low priority: confirm or eliminate at the next dependency cleanup.*
- **`@azure/msal-node`, `web-push` — license not resolved by this scan** because they were not present in the locally-installed tree at scan time. Both are widely-used permissive-licensed packages, but this document does not assert a license it did not verify. *Action: re-run the scan after a full `npm install --production` and record the result.*

## Third-party service terms (not npm packages)

Licensing of the code is separate from the terms of the hosted services the platform calls. Each is governed by its provider's commercial terms:

| Service | Terms consideration |
|---|---|
| Anthropic (Claude) | Commercial API terms; API inputs are not used to train the provider's models; zero-retention available on request |
| Google Maps Platform | Maps/Places/Geocoding ToS — governs display, caching, and derived-data limits (relevant to storing geocoded coordinates) |
| Railway · Cloudflare (R2, DNS, Email Worker) · Resend · Twilio · Microsoft 365 | Standard provider terms |

## Notes

- **Regenerate** this inventory whenever dependencies change materially, and record it as a version bump in the deployment report.
- The **satellite/aerial imagery** shown in Site Plan comes from the Google Maps Platform under its ToS — it is displayed, not redistributed.
- No dependency requires publishing Project 86's source.
