// scripts/generate-pwa-icons.js
//
// One-shot script: rasterize images/project-86-icon.svg into the
// PNG sizes the PWA manifest + iOS need. Run after editing the
// source SVG (rare). Output goes to images/pwa/.
//
//   node scripts/generate-pwa-icons.js
//
// Outputs:
//   images/pwa/icon-192.png       — standard PWA icon (Android etc.)
//   images/pwa/icon-512.png       — high-res PWA icon (splash)
//   images/pwa/icon-maskable-512.png  — maskable variant w/ safe zone
//   images/pwa/apple-touch-icon.png   — 180px for iOS home screen
//   images/pwa/icon-144.png       — Windows tile
//   images/pwa/favicon-32.png     — browser tab fallback
//
// Maskable note: per the W3C maskable-icons spec, the icon must fit
// inside the "safe zone" (the center 80% of the canvas). Anything in
// the outer 10% margin may be cropped by aggressive OS shape masks
// (round, squircle, teardrop, etc.). We scale the SVG to 70% of the
// canvas and pad with the theme background color so it survives
// every mask shape.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'images', 'project-86-icon.svg');
const OUT_DIR = path.join(ROOT, 'images', 'pwa');

// Icon background — solid black (chosen so the cyan cube pops hardest;
// John picked it over navy/white/graphite). Baked into every raster
// icon below (including the "any" 192/512) so the black tile shows on
// every launcher rather than being themed to white/grey by the OS.
const BG = '#000000';

const svgBuffer = fs.readFileSync(SRC);

// Ensure output dir exists.
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function render(name, size, opts) {
  opts = opts || {};
  // Safe-zone padding:
  //   - maskable: 70% (OS-mask shapes can crop the outer 10-15%)
  //   - opaque (iOS / Windows): 90% — modest padding for breathing room
  //   - transparent: 90% — same padding, but compositing on alpha=0
  const safeZone = opts.maskable ? 0.7 : 0.9;
  const innerSize = Math.round(size * safeZone);
  const inner = await sharp(svgBuffer)
    .resize(innerSize, innerSize, { fit: 'contain', background: BG })
    .png()
    .toBuffer();

  // opaque=true bakes in the black background. Used for the OS home-screen
  // icons — apple-touch-icon (iOS draws white behind transparent icons),
  // icon-144 (Windows tile), and the maskable variant (Android/Samsung
  // adaptive icon; needs a solid bg so the OS mask crops cleanly). Samsung
  // One UI uses the maskable, so black here = a black home-screen tile.
  // The 192/512 "any" icons stay TRANSPARENT on purpose: they double as
  // the in-app mobile-nav logo and the email-header logo (brandLockupRow),
  // which sit on light surfaces — a baked black square would wreck those.
  const opaque = !!(opts.maskable || opts.opaqueBg);

  const final = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: opaque ? BG : { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: inner, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  const outPath = path.join(OUT_DIR, name);
  fs.writeFileSync(outPath, final);
  const sizeKb = (final.length / 1024).toFixed(1);
  console.log('  ✓ ' + name + ' (' + size + 'px, ' + sizeKb + ' KB)' +
    (opaque ? ' [opaque bg]' : ''));
}

(async function () {
  console.log('Generating PWA icons from ' + path.relative(ROOT, SRC) + '...');
  await render('favicon-32.png', 32);
  await render('icon-144.png', 144, { opaqueBg: true });        // Windows tile — needs solid bg
  await render('apple-touch-icon.png', 180, { opaqueBg: true }); // iOS — opaque or you get white bg
  await render('icon-192.png', 192);                              // Android "any" — transparent (also in-app/email logo)
  await render('icon-512.png', 512);                              // Android "any" — transparent
  await render('icon-maskable-512.png', 512, { maskable: true }); // Maskable — bg required, 70% safe-zone
  console.log('Done. Output in ' + path.relative(ROOT, OUT_DIR) + '/');
})().catch((e) => {
  console.error('Icon generation failed:', e.message);
  process.exit(1);
});
