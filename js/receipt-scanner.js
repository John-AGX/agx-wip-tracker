// Receipt "scanner" — AI-guided crop + flatten. The OCR call (POST
// /api/receipts/ocr) returns the receipt's 4 corner points as 0..1 fractions;
// this module warps the photo so those corners map to a flat rectangle
// (perspective-correct deskew + crop), then does a light contrast cleanup so it
// reads like a scanned document. No external library — a small homography solve
// + per-pixel inverse map on a downscaled canvas. Fully graceful: any failure
// returns null and the caller keeps the original photo.
//
//   window.p86ReceiptScanner.scanFromCorners(file, corners, cb)
//     file    : the picked image File/Blob
//     corners : [[x,y],[x,y],[x,y],[x,y]] fractions (TL, TR, BR, BL), 0..1
//     cb(dataUrl|null) : JPEG data-URL of the cleaned scan, or null to skip
(function () {
  'use strict';

  var MAX_OUT = 1400; // cap the long edge of the output scan (perf + filesize)

  function dist(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }

  // Reject a degenerate / implausible quad so a bad detection never mangles the
  // photo. Corners are in PIXELS here. Requires convex, sensibly large, ordered.
  function quadIsSane(p, w, h) {
    if (!p || p.length !== 4) return false;
    for (var i = 0; i < 4; i++) { if (!isFinite(p[i][0]) || !isFinite(p[i][1])) return false; }
    // shoelace area
    var area = 0;
    for (var j = 0; j < 4; j++) { var k = (j + 1) % 4; area += p[j][0] * p[k][1] - p[k][0] * p[j][1]; }
    area = Math.abs(area) / 2;
    if (area < 0.12 * w * h) return false;       // < ~12% of frame → likely junk
    // convexity: all cross products same sign
    var sign = 0;
    for (var m = 0; m < 4; m++) {
      var a = p[m], b = p[(m + 1) % 4], c = p[(m + 2) % 4];
      var cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cr !== 0) { var s = cr > 0 ? 1 : -1; if (sign === 0) sign = s; else if (s !== sign) return false; }
    }
    return true;
  }

  // Solve the 8x8 system for the homography mapping srcPts -> dstPts (both 4
  // [x,y]). Returns [a,b,c,d,e,f,g,h] for: X=(a x+b y+c)/(g x+h y+1),
  // Y=(d x+e y+f)/(g x+h y+1). null if singular.
  function homography(src, dst) {
    var A = [], B = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], X = dst[i][0], Y = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); B.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); B.push(Y);
    }
    // Gaussian elimination with partial pivoting
    for (var col = 0; col < 8; col++) {
      var piv = col;
      for (var r = col + 1; r < 8; r++) { if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r; }
      if (Math.abs(A[piv][col]) < 1e-9) return null;
      var tA = A[col]; A[col] = A[piv]; A[piv] = tA; var tB = B[col]; B[col] = B[piv]; B[piv] = tB;
      var pv = A[col][col];
      for (var c2 = col; c2 < 8; c2++) A[col][c2] /= pv; B[col] /= pv;
      for (var r2 = 0; r2 < 8; r2++) {
        if (r2 === col) continue;
        var fct = A[r2][col];
        if (fct === 0) continue;
        for (var c3 = col; c3 < 8; c3++) A[r2][c3] -= fct * A[col][c3];
        B[r2] -= fct * B[col];
      }
    }
    return B; // [a..h]
  }

  // Gentle contrast stretch on the warped output so paper goes white and text
  // darkens — without the harsh binary look that can drop faint thermal text.
  function autoLevels(data) {
    var n = data.length, i;
    // luminance histogram
    var hist = new Float64Array(256), total = 0;
    for (i = 0; i < n; i += 4) {
      var l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      hist[l]++; total++;
    }
    if (!total) return;
    var loCut = total * 0.02, hiCut = total * 0.98, acc = 0, lo = 0, hi = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= loCut) { lo = i; break; } }
    acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= hiCut) { hi = i; break; } }
    if (hi - lo < 20) return; // too flat to stretch safely
    var scale = 255 / (hi - lo);
    var lut = new Uint8ClampedArray(256);
    for (i = 0; i < 256; i++) lut[i] = Math.min(255, Math.max(0, (i - lo) * scale));
    for (i = 0; i < n; i += 4) { data[i] = lut[data[i]]; data[i + 1] = lut[data[i + 1]]; data[i + 2] = lut[data[i + 2]]; }
  }

  function warp(img, cornersPx, outW, outH) {
    var sc = document.createElement('canvas'); sc.width = img.width; sc.height = img.height;
    var sctx = sc.getContext('2d'); sctx.drawImage(img, 0, 0);
    var sdata = sctx.getImageData(0, 0, img.width, img.height).data;
    var sw = img.width;

    var rect = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
    var H = homography(rect, cornersPx); // output-rect -> source-quad (inverse map)
    if (!H) return null;
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];

    var oc = document.createElement('canvas'); oc.width = outW; oc.height = outH;
    var octx = oc.getContext('2d');
    var out = octx.createImageData(outW, outH);
    var odata = out.data;
    for (var y = 0; y < outH; y++) {
      for (var x = 0; x < outW; x++) {
        var w = g * x + h * y + 1;
        var sx = (a * x + b * y + c) / w;
        var sy = (d * x + e * y + f) / w;
        var oi = (y * outW + x) * 4;
        if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= img.height - 1) {
          odata[oi] = odata[oi + 1] = odata[oi + 2] = 255; odata[oi + 3] = 255; continue;
        }
        // bilinear sample
        var x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        var i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        for (var ch = 0; ch < 3; ch++) {
          var top = sdata[i00 + ch] * (1 - fx) + sdata[i10 + ch] * fx;
          var bot = sdata[i01 + ch] * (1 - fx) + sdata[i11 + ch] * fx;
          odata[oi + ch] = top * (1 - fy) + bot * fy;
        }
        odata[oi + 3] = 255;
      }
    }
    autoLevels(odata);
    octx.putImageData(out, 0, 0);
    return oc.toDataURL('image/jpeg', 0.85);
  }

  function scanFromCorners(file, corners, cb) {
    try {
      if (!file || !corners || corners.length !== 4) { cb(null); return; }
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        try {
          var iw = img.width, ih = img.height;
          var px = corners.map(function (p) { return [p[0] * iw, p[1] * ih]; });
          if (!quadIsSane(px, iw, ih)) { URL.revokeObjectURL(url); cb(null); return; }
          // output size from the receipt's own edge lengths, capped
          var wTop = dist(px[0], px[1]), wBot = dist(px[3], px[2]);
          var hL = dist(px[0], px[3]), hR = dist(px[1], px[2]);
          var outW = Math.round(Math.max(wTop, wBot)), outH = Math.round(Math.max(hL, hR));
          if (outW < 40 || outH < 40) { URL.revokeObjectURL(url); cb(null); return; }
          var scale = Math.min(1, MAX_OUT / Math.max(outW, outH));
          outW = Math.max(1, Math.round(outW * scale)); outH = Math.max(1, Math.round(outH * scale));
          var dataUrl = warp(img, px, outW, outH);
          URL.revokeObjectURL(url);
          cb(dataUrl || null);
        } catch (e) { try { URL.revokeObjectURL(url); } catch (_) {} cb(null); }
      };
      img.onerror = function () { try { URL.revokeObjectURL(url); } catch (_) {} cb(null); };
      img.src = url;
    } catch (e) { cb(null); }
  }

  window.p86ReceiptScanner = { scanFromCorners: scanFromCorners };
})();
