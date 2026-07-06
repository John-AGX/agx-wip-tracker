// Purchase Order importer — AI-vision OCR of a Buildertrend Purchase Order
// PDF export. Mirrors the lead PDF importer (js/leads.js handlePdfDrop):
// render the PDF pages to JPEG images in the browser, POST them to
// /api/ai/extract-purchase-order, and hand the structured result back to
// the PO editor to prefill for review. pdf.js (pdfjsLib) is loaded globally
// in index.html, so we just use it.
//
//   window.p86POImport.pickAndExtract({ onStatus }) -> Promise<parsedPO|null>
//     Opens a file picker; resolves with the extracted PO object, or null
//     if the user cancelled. Rejects on a real error (bad file / AI error).
(function () {
  'use strict';

  // Render up to 12 pages to base64 JPEG data URLs. The server strips the
  // data-URL prefix. 12 matches the server cap; a Buildertrend PO's job
  // scope + line items live in the first pages, and the long standard T&C
  // tail (which we intentionally skip) is what gets dropped past the cap.
  function renderPdfToImages(pdf) {
    var max = Math.min(pdf.numPages, 12);
    var chain = Promise.resolve();
    var images = [];
    for (var i = 1; i <= max; i++) {
      (function (pageNum) {
        chain = chain.then(function () {
          return pdf.getPage(pageNum).then(function (page) {
            var viewport = page.getViewport({ scale: 1.7 });
            var canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function () {
              images.push(canvas.toDataURL('image/jpeg', 0.82));
            });
          });
        });
      })(i);
    }
    return chain.then(function () { return images; });
  }

  function pickFile() {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.pdf,application/pdf';
      inp.style.display = 'none';
      inp.onchange = function () {
        var f = (inp.files && inp.files[0]) || null;
        resolve(f);
        if (inp.parentNode) inp.parentNode.removeChild(inp);
      };
      document.body.appendChild(inp);
      inp.click();
    });
  }

  function pickAndExtract(opts) {
    opts = opts || {};
    var status = (typeof opts.onStatus === 'function') ? opts.onStatus : function () {};
    return pickFile().then(function (file) {
      if (!file) return null; // cancelled
      var name = (file.name || '').toLowerCase();
      if (file.type !== 'application/pdf' && !name.endsWith('.pdf')) {
        throw new Error('Not a PDF — export the Purchase Order from Buildertrend as a PDF.');
      }
      if (!window.pdfjsLib) {
        throw new Error('PDF library not loaded — refresh the page and try again.');
      }
      if (!(window.p86Api && window.p86Api.ai && window.p86Api.ai.extractPurchaseOrder)) {
        throw new Error('PO extraction API not available.');
      }
      status('Reading PDF…');
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function (e) {
          var arr = new Uint8Array(e.target.result);
          window.pdfjsLib.getDocument({ data: arr }).promise.then(function (pdf) {
            return renderPdfToImages(pdf);
          }).then(function (images) {
            if (!images.length) throw new Error('No pages found in the PDF.');
            status('Reading the purchase order with AI… (' + images.length + ' page' + (images.length === 1 ? '' : 's') + ')');
            return window.p86Api.ai.extractPurchaseOrder(images);
          }).then(function (res) {
            if (!res || !res.purchase_order) throw new Error('Empty response from the extractor.');
            resolve(res.purchase_order);
          }).catch(reject);
        };
        reader.onerror = function () { reject(new Error('Could not read the file.')); };
        reader.readAsArrayBuffer(file);
      });
    });
  }

  window.p86POImport = { pickAndExtract: pickAndExtract };
})();
