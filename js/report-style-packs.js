// Report style packs — the VISUAL theme picker (orthogonal to the
// content templates in js/report-templates.js). Each pack registers
// its id, label, blurb, and a small preview swatch the gallery modal
// uses to render the choice. The actual CSS lives in
// css/report-style-packs.css scoped to [data-style-pack="<id>"].
//
// Ids must stay in lockstep with STYLE_PACKS in
// server/routes/reports-routes.js — mismatched ids clamp server-side
// to 'clean'.
//
// Surface:
//   window.p86ReportStylePacks.list()        -> [pack, …]
//   window.p86ReportStylePacks.get(id)       -> pack | null
//   window.p86ReportStylePacks.previewHTML(pack) -> string (mini swatch)
(function () {
  'use strict';

  // Each pack's preview is a small (~120×80) abstract rendering of the
  // pack's identity. Pure CSS — no images — so the gallery modal
  // never pulls a separate asset. The previews are deliberately
  // schematic (a "cover" rectangle + a couple of "photo" tiles) so
  // the user reads the THEME, not the content.
  function preview(pack) {
    // pack.preview is a function that returns inline-styled HTML for
    // the swatch. Falls back to a plain palette block.
    if (typeof pack.preview === 'function') return pack.preview();
    return '<div style="width:100%;height:100%;background:' + (pack.palette || '#1a1a2e') + ';border-radius:6px;"></div>';
  }

  var PACKS = [
    {
      id: 'clean',
      label: 'Clean',
      description: 'Sans-serif, no decoration, white background, blue accent. The default look.',
      preview: function () {
        return '' +
          '<div style="width:100%;height:100%;background:#fff;border-radius:6px;padding:8px;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;">' +
            '<div style="height:10px;background:#1a1a2e;border-radius:2px;width:65%;"></div>' +
            '<div style="height:4px;background:#cbd5e1;border-radius:2px;width:45%;"></div>' +
            '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px;">' +
              '<div style="background:#e2e8f0;border-radius:3px;"></div>' +
              '<div style="background:#e2e8f0;border-radius:3px;"></div>' +
            '</div>' +
          '</div>';
      }
    },
    {
      id: 'classic-corporate',
      label: 'Classic Corporate',
      description: 'Serif headings, navy/gold accent lines, letterhead-style cover. Engineer’s report.',
      preview: function () {
        return '' +
          '<div style="width:100%;height:100%;background:#fcfaf5;border-radius:6px;padding:8px;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;border:1px solid #e7e3d6;">' +
            '<div style="height:2px;background:#1e3a5f;width:100%;"></div>' +
            '<div style="height:10px;background:#1e3a5f;border-radius:1px;width:55%;font-family:Georgia,serif;margin-top:4px;"></div>' +
            '<div style="height:3px;background:#b8941f;width:30%;"></div>' +
            '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px;">' +
              '<div style="background:#fff;border:1px solid #d4cfb8;border-radius:1px;"></div>' +
              '<div style="background:#fff;border:1px solid #d4cfb8;border-radius:1px;"></div>' +
            '</div>' +
          '</div>';
      }
    },
    {
      id: 'modern-bold',
      label: 'Modern Bold',
      description: 'Big sans display, color-block section headers, no photo borders. Marketing-grade.',
      preview: function () {
        return '' +
          '<div style="width:100%;height:100%;background:#fff;border-radius:6px;padding:8px;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;">' +
            '<div style="height:16px;background:#0a0e15;border-radius:2px;width:80%;"></div>' +
            '<div style="height:8px;background:#4f8cff;border-radius:2px;width:40%;"></div>' +
            '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr 1fr;gap:3px;margin-top:2px;">' +
              '<div style="background:#0a0e15;border-radius:1px;"></div>' +
              '<div style="background:#0a0e15;border-radius:1px;"></div>' +
              '<div style="background:#0a0e15;border-radius:1px;"></div>' +
            '</div>' +
          '</div>';
      }
    },
    {
      id: 'field-notebook',
      label: 'Field Notebook',
      description: 'Off-white paper, monospace dates, dashed dividers. Reads as field-truth.',
      preview: function () {
        return '' +
          '<div style="width:100%;height:100%;background:#f8f4e8;border-radius:6px;padding:8px;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;">' +
            '<div style="height:10px;background:#3a3528;border-radius:2px;width:60%;"></div>' +
            '<div style="height:0;border-top:1px dashed #8a7f5e;margin:2px 0;"></div>' +
            '<div style="height:3px;background:#8a7f5e;width:25%;font-family:monospace;"></div>' +
            '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:3px;">' +
              '<div style="background:#fff;border:1px dashed #8a7f5e;border-radius:2px;"></div>' +
              '<div style="background:#fff;border:1px dashed #8a7f5e;border-radius:2px;"></div>' +
            '</div>' +
          '</div>';
      }
    },
    {
      id: 'inspection-pro',
      label: 'Inspection Pro',
      description: 'Severity tags (green/yellow/red), data-table feel, gridlined photos.',
      preview: function () {
        return '' +
          '<div style="width:100%;height:100%;background:#fff;border-radius:6px;padding:8px;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;border:1px solid #cbd5e1;">' +
            '<div style="height:8px;background:#0f172a;border-radius:1px;width:60%;"></div>' +
            '<div style="display:flex;gap:3px;margin:2px 0;">' +
              '<div style="height:5px;flex:1;background:#10b981;border-radius:1px;"></div>' +
              '<div style="height:5px;flex:1;background:#f59e0b;border-radius:1px;"></div>' +
              '<div style="height:5px;flex:1;background:#ef4444;border-radius:1px;"></div>' +
            '</div>' +
            '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:2px;border:1px solid #cbd5e1;padding:2px;border-radius:2px;">' +
              '<div style="background:#e2e8f0;"></div>' +
              '<div style="background:#e2e8f0;"></div>' +
            '</div>' +
          '</div>';
      }
    }
  ];

  var BY_ID = {};
  PACKS.forEach(function (p) { BY_ID[p.id] = p; });

  window.p86ReportStylePacks = {
    list: function () { return PACKS.slice(); },
    get: function (id) { return BY_ID[id] || null; },
    previewHTML: preview
  };
})();
