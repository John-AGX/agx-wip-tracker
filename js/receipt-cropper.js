// Receipt crop REVIEW — the adjustable 4-corner box on top of the existing
// auto-scan. The receipts OCR already returns the paper's corners and
// p86ReceiptScanner auto-deskews to a flat page; this module lets the user SEE
// those corners and drag them when the AI got it wrong ("four points we can move
// if we need to"). It reuses p86ReceiptScanner for the actual warp/cleanup — one
// perspective engine, not two. No external libraries.
//
//   window.p86ReceiptCrop.open(file, opts, onDone)
//     file    the ORIGINAL photo File/Blob (warped at full res)
//     opts    { seedCorners: [[x,y]…]|null }  normalized 0..1 TL,TR,BR,BL — pass
//             the AI corners so the box opens where the auto-scan put it; null →
//             a quick client-side edge guess.
//     onDone  fn(result) — { dataUrl, corners } on use (corners normalized), or
//             null if cancelled (caller keeps whatever it had).
(function () {
  if (window.p86ReceiptCrop) return;

  function injectStyles() {
    if (document.getElementById('p86-rc-styles')) return;
    var s = document.createElement('style');
    s.id = 'p86-rc-styles';
    s.textContent = [
      '.rc-ovl{position:fixed;inset:0;z-index:100000;background:#0b0d12;display:flex;flex-direction:column;',
        'touch-action:none;user-select:none;-webkit-user-select:none;}',
      '.rc-top{padding:14px 16px 8px;color:#e8ebf2;text-align:center;flex:0 0 auto;}',
      '.rc-top b{font-size:15px;font-weight:700;display:block;}',
      '.rc-top span{font-size:12px;color:#9aa4b8;}',
      '.rc-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:6px 10px;}',
      '.rc-frame{position:relative;display:inline-block;max-width:100%;max-height:100%;line-height:0;}',
      '.rc-img{display:block;max-width:100%;max-height:78vh;object-fit:contain;border-radius:4px;}',
      '.rc-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}',
      '.rc-quad{fill:rgba(79,140,255,.14);stroke:#5b9dff;stroke-width:2;vector-effect:non-scaling-stroke;}',
      '.rc-h{fill:#fff;stroke:#4f8cff;stroke-width:2.5;vector-effect:non-scaling-stroke;cursor:grab;}',
      '.rc-h:active{cursor:grabbing;}',
      '.rc-bar{flex:0 0 auto;display:flex;gap:8px;padding:12px 12px calc(12px + env(safe-area-inset-bottom,0px));',
        'background:#11141c;border-top:1px solid rgba(255,255,255,.08);align-items:center;flex-wrap:wrap;justify-content:center;}',
      '.rc-btn{flex:1 1 auto;min-width:66px;padding:11px 10px;font-size:13px;font-weight:600;border-radius:9px;cursor:pointer;',
        'background:#1b2130;border:1px solid rgba(255,255,255,.16);color:#e8ebf2;}',
      '.rc-btn:hover{border-color:#4f8cff;}',
      '.rc-btn.primary{flex:1.4 1 auto;background:#4f8cff;border-color:#4f8cff;color:#fff;}',
      '.rc-btn.primary:hover{background:#3d7bef;}',
      '.rc-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
        'background:rgba(11,13,18,.72);color:#e8ebf2;font-size:14px;z-index:5;}'
    ].join('');
    document.head.appendChild(s);
  }

  // Load a File into a downscaled canvas for the editor (display + drag only —
  // the real warp runs full-res on the original file via p86ReceiptScanner).
  function fileToCanvas(file, maxDim, cb) {
    try {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        try {
          var sc = Math.min(1, maxDim / Math.max(img.width, img.height));
          var cw = Math.max(1, Math.round(img.width * sc));
          var ch = Math.max(1, Math.round(img.height * sc));
          var c = document.createElement('canvas'); c.width = cw; c.height = ch;
          c.getContext('2d').drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url); cb(c);
        } catch (e) { URL.revokeObjectURL(url); cb(null); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
      img.src = url;
    } catch (e) { cb(null); }
  }

  // Rough client-side edge guess for when the AI didn't return corners: bounding
  // box of high-gradient content (the receipt vs a plainer background) via a
  // cheap Sobel on a tiny copy. Axis-aligned — a starting quad the user drags.
  // Returns normalized [TL,TR,BR,BL] (0..1).
  function autoGuess(canvas) {
    var inset = [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]];
    try {
      var w = canvas.width, h = canvas.height;
      var sw = 180, sh = Math.max(1, Math.round(h * sw / w));
      var t = document.createElement('canvas'); t.width = sw; t.height = sh;
      t.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
      var d = t.getContext('2d').getImageData(0, 0, sw, sh).data;
      var g = new Float32Array(sw * sh), i;
      for (i = 0; i < sw * sh; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      var xs = [], ys = [], x, y;
      for (y = 1; y < sh - 1; y++) for (x = 1; x < sw - 1; x++) {
        var gx = g[y * sw + x + 1] - g[y * sw + x - 1];
        var gy = g[(y + 1) * sw + x] - g[(y - 1) * sw + x];
        if (Math.abs(gx) + Math.abs(gy) > 42) { xs.push(x); ys.push(y); }
      }
      if (xs.length < 25) return inset;
      xs.sort(function (a, b) { return a - b; }); ys.sort(function (a, b) { return a - b; });
      var pc = function (a, p) { return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))]; };
      var X0 = pc(xs, 0.02) / sw, X1 = pc(xs, 0.98) / sw, Y0 = pc(ys, 0.02) / sh, Y1 = pc(ys, 0.98) / sh;
      if (X1 - X0 < 0.25 || Y1 - Y0 < 0.25) return inset;
      var px = (X1 - X0) * 0.02, py = (Y1 - Y0) * 0.02;
      X0 = Math.max(0, X0 - px); X1 = Math.min(1, X1 + px); Y0 = Math.max(0, Y0 - py); Y1 = Math.min(1, Y1 + py);
      return [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]];
    } catch (e) { return inset; }
  }

  // Fallback deskew when p86ReceiptScanner isn't loaded — an axis-aligned crop to
  // the quad's bounding box (no perspective). The scanner is the normal path.
  function bboxCrop(canvas, normQuad) {
    var w = canvas.width, h = canvas.height;
    var xs = normQuad.map(function (p) { return p[0] * w; }), ys = normQuad.map(function (p) { return p[1] * h; });
    var x0 = Math.max(0, Math.floor(Math.min.apply(null, xs))), x1 = Math.min(w, Math.ceil(Math.max.apply(null, xs)));
    var y0 = Math.max(0, Math.floor(Math.min.apply(null, ys))), y1 = Math.min(h, Math.ceil(Math.max.apply(null, ys)));
    var cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
    var o = document.createElement('canvas'); o.width = cw; o.height = ch;
    o.getContext('2d').drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
    return o.toDataURL('image/jpeg', 0.85);
  }

  function open(file, opts, onDone) {
    if (typeof opts === 'function') { onDone = opts; opts = {}; }
    opts = opts || {}; onDone = onDone || function () {};
    injectStyles();
    fileToCanvas(file, 1400, function (canvas) {
      if (!canvas) { onDone(null); return; }
      var seed = (opts.seedCorners && opts.seedCorners.length === 4) ? opts.seedCorners : autoGuess(canvas);
      // corners kept in canvas px (source of truth); seed is normalized 0..1.
      var corners = seed.map(function (p) { return { x: p[0] * canvas.width, y: p[1] * canvas.height }; });

      var ovl = document.createElement('div'); ovl.className = 'rc-ovl';
      ovl.innerHTML =
        '<div class="rc-top"><b>Adjust the crop</b><span>Drag the corners to the receipt’s edges — we’ll straighten it</span></div>' +
        '<div class="rc-stage"><div class="rc-frame">' +
          '<img class="rc-img" alt="receipt" />' +
          '<svg class="rc-svg" preserveAspectRatio="none">' +
            '<polygon class="rc-quad"></polygon>' +
            '<circle class="rc-h" data-i="0"></circle><circle class="rc-h" data-i="1"></circle>' +
            '<circle class="rc-h" data-i="2"></circle><circle class="rc-h" data-i="3"></circle>' +
          '</svg>' +
        '</div></div>' +
        '<div class="rc-bar">' +
          '<button class="rc-btn" data-act="auto">Reset</button>' +
          '<button class="rc-btn" data-act="full">Full photo</button>' +
          '<button class="rc-btn" data-act="cancel">Cancel</button>' +
          '<button class="rc-btn primary" data-act="use">Use this crop</button>' +
        '</div>';
      document.body.appendChild(ovl);

      var img = ovl.querySelector('.rc-img');
      var svg = ovl.querySelector('.rc-svg');
      var poly = ovl.querySelector('.rc-quad');
      var handles = [].slice.call(ovl.querySelectorAll('.rc-h'));
      img.src = canvas.toDataURL('image/jpeg', 0.9);
      svg.setAttribute('viewBox', '0 0 ' + canvas.width + ' ' + canvas.height);

      function render() {
        poly.setAttribute('points', corners.map(function (p) { return p.x + ',' + p.y; }).join(' '));
        var r = Math.max(13, Math.round(Math.max(canvas.width, canvas.height) * 0.028));
        handles.forEach(function (hEl, i) { hEl.setAttribute('cx', corners[i].x); hEl.setAttribute('cy', corners[i].y); hEl.setAttribute('r', r); });
      }
      render();

      function toCanvas(evt) {
        var pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
        var m = svg.getScreenCTM(); if (!m) return null;
        var loc = pt.matrixTransform(m.inverse());
        return { x: Math.max(0, Math.min(canvas.width, loc.x)), y: Math.max(0, Math.min(canvas.height, loc.y)) };
      }
      var dragIdx = -1;
      handles.forEach(function (hEl) {
        hEl.addEventListener('pointerdown', function (e) { e.preventDefault(); dragIdx = +hEl.getAttribute('data-i'); try { hEl.setPointerCapture(e.pointerId); } catch (er) {} });
        hEl.addEventListener('pointermove', function (e) { if (dragIdx < 0) return; e.preventDefault(); var c = toCanvas(e); if (c) { corners[dragIdx] = c; render(); } });
        var end = function () { dragIdx = -1; };
        hEl.addEventListener('pointerup', end); hEl.addEventListener('pointercancel', end);
      });

      function close() { if (ovl.parentNode) ovl.parentNode.removeChild(ovl); }
      function norm() { return corners.map(function (p) { return [p.x / canvas.width, p.y / canvas.height]; }); }

      ovl.querySelector('.rc-bar').addEventListener('click', function (e) {
        var btn = e.target.closest('.rc-btn'); if (!btn) return;
        var act = btn.getAttribute('data-act');
        if (act === 'cancel') { close(); onDone(null); return; }
        if (act === 'auto') {
          var s = (opts.seedCorners && opts.seedCorners.length === 4) ? opts.seedCorners : autoGuess(canvas);
          corners = s.map(function (p) { return { x: p[0] * canvas.width, y: p[1] * canvas.height }; }); render(); return;
        }
        if (act === 'full') { close(); onDone({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), corners: null }); return; }
        if (act === 'use') {
          var busy = document.createElement('div'); busy.className = 'rc-busy'; busy.textContent = 'Straightening…';
          ovl.querySelector('.rc-frame').appendChild(busy);
          var nc = norm();
          var finish = function (url) { close(); onDone({ dataUrl: url || bboxCrop(canvas, nc), corners: nc }); };
          if (window.p86ReceiptScanner && window.p86ReceiptScanner.scanFromCorners) {
            // Reuse the existing warp+cleanup on the FULL-RES original file.
            // nc is [[x,y]…] normalized — the shape scanFromCorners expects.
            try { window.p86ReceiptScanner.scanFromCorners(file, nc, finish); }
            catch (er) { finish(null); }
          } else { setTimeout(function () { finish(null); }, 20); }
        }
      });
    });
  }

  window.p86ReceiptCrop = { open: open };
})();
