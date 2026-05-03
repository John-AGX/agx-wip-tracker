// PDF viewer — renders PDF attachment pages to <canvas> elements in a
// full-screen modal. Two purposes:
//
//   1. Human browsing — read RFPs, scope docs, drawings without leaving
//      the app or downloading.
//   2. AI vision input — the "Ask AI about this PDF" button extracts each
//      rendered page as a base64 JPEG and ships them to the AI panel as
//      additional images on the next chat message. Vision is much
//      cheaper than tokenizing extracted PDF text, and Claude reads
//      photos / diagrams / tables in scanned PDFs way better than text
//      extraction would.
//
// Anthropic caps a request at 20 images, and our chat endpoint already
// reserves up to 12 slots for entity photos. We render up to 10 PDF
// pages for AI; pages beyond that show in the viewer but aren't sent.
(function() {
  'use strict';

  var MAX_AI_PAGES = 10;

  function escapeHTMLLocal(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Render every page of the PDF into the given container. Returns an
  // array of canvas elements in page order so callers can later extract
  // base64 images from them without re-rendering.
  function renderAllPages(pdf, container, statusEl) {
    var canvases = [];
    var chain = Promise.resolve();
    for (var i = 1; i <= pdf.numPages; i++) {
      (function(pageNum) {
        chain = chain.then(function() {
          return pdf.getPage(pageNum).then(function(page) {
            // Render at 1.5× device pixel ratio so pages look sharp on
            // retina displays without burning too many pixels.
            var viewport = page.getViewport({ scale: 1.5 });
            var canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.cssText = 'display:block;margin:0 auto 16px;max-width:100%;height:auto;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.4);border-radius:4px;';

            var pageWrap = document.createElement('div');
            pageWrap.style.cssText = 'position:relative;margin-bottom:8px;';
            pageWrap.appendChild(canvas);

            var pageLabel = document.createElement('div');
            pageLabel.style.cssText = 'text-align:center;font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:18px;';
            pageLabel.textContent = 'Page ' + pageNum + ' / ' + pdf.numPages;
            pageWrap.appendChild(pageLabel);

            container.appendChild(pageWrap);
            if (statusEl) statusEl.textContent = 'Rendering page ' + pageNum + ' of ' + pdf.numPages + '…';
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function() {
              canvases.push({ pageNum: pageNum, canvas: canvas });
            });
          });
        });
      })(i);
    }
    return chain.then(function() {
      if (statusEl) statusEl.textContent = pdf.numPages + ' page' + (pdf.numPages === 1 ? '' : 's') + ' rendered';
      return canvases;
    });
  }

  // Open the viewer modal for a given attachment.
  // attachment shape: { id, filename, mime_type, original_url, ... }
  function openPdfViewer(attachment, opts) {
    opts = opts || {};
    if (!window.pdfjsLib) {
      alert('PDF library is still loading — try again in a second.');
      return;
    }
    var entityType = opts.entityType || null; // 'estimate' or 'lead' — for the Ask AI hand-off
    var entityId = opts.entityId || null;

    // Build the modal
    var overlay = document.createElement('div');
    overlay.className = 'agx-pdf-viewer';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9000;display:flex;flex-direction:column;';

    var header = document.createElement('div');
    header.style.cssText = 'flex:0 0 auto;padding:10px 16px;background:#0f0f1e;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;gap:10px;color:#fff;';
    header.innerHTML =
      '<div style="font-size:14px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHTMLLocal(attachment.filename) + '">📕 ' + escapeHTMLLocal(attachment.filename) + '</div>' +
      '<div data-pdf-status style="font-size:11px;color:rgba(255,255,255,0.6);"></div>' +
      (entityId ? '<button data-pdf-ai title="Send rendered pages to the AI assistant" style="background:linear-gradient(135deg,#8b5cf6,#4f8cff);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">✨ Ask AI</button>' : '') +
      '<a data-pdf-download href="' + attachment.original_url + '" download="' + escapeHTMLLocal(attachment.filename) + '" target="_blank" rel="noopener" style="background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px 12px;font-size:12px;text-decoration:none;">⬇ Download</a>' +
      '<button data-pdf-close title="Close (Esc)" style="background:rgba(255,255,255,0.12);color:#fff;border:none;border-radius:6px;width:34px;height:34px;font-size:16px;cursor:pointer;">×</button>';

    var body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:24px 16px;';

    var pageContainer = document.createElement('div');
    pageContainer.style.cssText = 'max-width:1100px;margin:0 auto;';
    pageContainer.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,0.5);padding:40px;font-size:13px;">Loading PDF…</div>';
    body.appendChild(pageContainer);

    overlay.appendChild(header);
    overlay.appendChild(body);
    document.body.appendChild(overlay);

    var statusEl = header.querySelector('[data-pdf-status]');
    var renderedCanvases = []; // populated after render completes

    function close() {
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    overlay.addEventListener('click', function(e) {
      var t = e.target;
      if (t === overlay) { close(); return; }
      if (t.closest && t.closest('[data-pdf-close]')) { close(); return; }
      if (t.closest && t.closest('[data-pdf-ai]')) {
        sendToAI(attachment, renderedCanvases, entityType, entityId);
      }
    });

    // Kick off the render. Fetch the bytes through the same-origin
    // proxy (attachment.original_url points at the R2 CDN — different
    // subdomain, so a direct PDF.js fetch hits CORS and fails). Hand
    // the ArrayBuffer to PDF.js via the {data: ...} form.
    statusEl.textContent = 'Loading PDF…';
    var proxyUrl = '/api/attachments/raw/' + encodeURIComponent(attachment.id) + '?variant=original';
    var headers = {};
    var token = (window.agxAuth && typeof window.agxAuth.getToken === 'function')
      ? window.agxAuth.getToken() : null;
    if (!token) {
      try { token = localStorage.getItem('agx-auth-token'); } catch (e) { /* ignore */ }
    }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    fetch(proxyUrl, { headers: headers, credentials: 'same-origin' })
      .then(function(r) {
        if (!r.ok) {
          return r.text().then(function(body) {
            throw new Error('HTTP ' + r.status + ': ' + (body || r.statusText).slice(0, 200));
          });
        }
        return r.arrayBuffer();
      })
      .then(function(buffer) {
        return window.pdfjsLib.getDocument({ data: buffer }).promise;
      })
      .then(function(pdf) {
        pageContainer.innerHTML = ''; // clear "Loading..." placeholder
        return renderAllPages(pdf, pageContainer, statusEl).then(function(canvases) {
          renderedCanvases = canvases;
        });
      })
      .catch(function(err) {
        console.error('PDF render failed:', err);
        pageContainer.innerHTML = '<div style="text-align:center;color:#f87171;padding:40px;font-size:13px;">Could not render this PDF: ' + escapeHTMLLocal(err.message || err) + '</div>';
        statusEl.textContent = 'Failed';
      });
  }

  // Convert rendered canvases to base64 JPEGs and hand them off to the AI
  // panel. The panel takes care of opening, attaching the images to the
  // next message, and pre-filling a prompt.
  function sendToAI(attachment, canvasEntries, entityType, entityId) {
    if (!entityType || !entityId) {
      alert('No estimate or lead is open — open one and try again.');
      return;
    }
    if (!canvasEntries || !canvasEntries.length) {
      alert('Pages are still rendering — try again in a moment.');
      return;
    }
    if (!window.agxAI || typeof window.agxAI.openWithImages !== 'function') {
      alert('AI panel is not loaded — refresh the page.');
      return;
    }
    // Cap at MAX_AI_PAGES so we stay under Anthropic's per-request image
    // limit. The viewer keeps rendering all pages for the human; only
    // the first N go to vision.
    var capped = canvasEntries.slice(0, MAX_AI_PAGES);
    var images = capped.map(function(e) {
      // toDataURL returns "data:image/jpeg;base64,xxxxx" — strip the
      // prefix so the server can pass just the base64 to Anthropic.
      var dataUrl = e.canvas.toDataURL('image/jpeg', 0.82);
      var idx = dataUrl.indexOf('base64,');
      return idx >= 0 ? dataUrl.slice(idx + 7) : dataUrl;
    });
    var truncationNote = canvasEntries.length > MAX_AI_PAGES
      ? ' (first ' + MAX_AI_PAGES + ' of ' + canvasEntries.length + ' pages — Anthropic\'s per-request image cap)'
      : '';
    var prefill = 'I\'ve attached the document "' + attachment.filename + '"' + truncationNote + '. Read each page and tell me what stands out.';
    window.agxAI.openWithImages({
      entityType: entityType,
      entityId: entityId,
      images: images,
      prefill: prefill
    });
  }

  window.openPdfViewer = openPdfViewer;

  // Headless render — fetches a PDF attachment, rasterizes the first
  // `maxPages` pages off-screen, and returns the page renders as base64
  // JPEGs. No DOM side effects. Used by the AI panel's auto-render path
  // for PDFs whose server-side text extraction came up empty (scanned
  // RFPs, photo-report-style PDFs from CompanyCam, drawing PDFs).
  //
  // Caller is responsible for caching — this function re-renders every
  // call. Default maxPages is intentionally lower than the manual
  // viewer's MAX_AI_PAGES (which is 10) to keep auto-attached images
  // cheap on every-turn cost; raise via the arg if needed.
  function renderForAI(attachment, maxPages, scale) {
    if (!window.pdfjsLib) return Promise.reject(new Error('pdfjsLib not loaded'));
    var cap = Math.max(1, Math.min(20, maxPages || 6));
    var s   = scale || 1.5;
    var proxyUrl = '/api/attachments/raw/' + encodeURIComponent(attachment.id) + '?variant=original';
    var headers = {};
    var token = (window.agxAuth && typeof window.agxAuth.getToken === 'function')
      ? window.agxAuth.getToken() : null;
    if (!token) {
      try { token = localStorage.getItem('agx-auth-token'); } catch (e) { /* ignore */ }
    }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(proxyUrl, { headers: headers, credentials: 'same-origin' })
      .then(function(r) {
        if (!r.ok) throw new Error('PDF fetch HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function(buffer) {
        return window.pdfjsLib.getDocument({ data: buffer }).promise;
      })
      .then(function(pdf) {
        var total = Math.min(pdf.numPages, cap);
        var images = [];
        var chain = Promise.resolve();
        for (var i = 1; i <= total; i++) {
          (function(pageNum) {
            chain = chain.then(function() {
              return pdf.getPage(pageNum).then(function(page) {
                var viewport = page.getViewport({ scale: s });
                var canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function() {
                  var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
                  var idx = dataUrl.indexOf('base64,');
                  images.push(idx >= 0 ? dataUrl.slice(idx + 7) : dataUrl);
                  // Detach immediately so memory frees up on the next tick.
                  canvas.width = 0; canvas.height = 0;
                });
              });
            });
          })(i);
        }
        return chain.then(function() {
          return { images: images, totalPages: pdf.numPages, renderedPages: total };
        });
      });
  }

  window.agxPdfRender = { renderForAI: renderForAI };
})();
