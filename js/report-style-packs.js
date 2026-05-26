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
    },
    {
      id: 'blueprint',
      label: 'Blueprint',
      description: 'Navy + cyan accents, faint grid, condensed sans. Technical drawing feel.',
      preview: function () {
        return '' +
          '<div style="width:100%;height:100%;background:#0e2a4a;border-radius:6px;padding:8px;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;background-image:linear-gradient(rgba(255,255,255,0.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.08) 1px,transparent 1px);background-size:10px 10px;">' +
            '<div style="height:9px;background:#67e8f9;border-radius:1px;width:65%;"></div>' +
            '<div style="height:3px;background:#67e8f9;width:40%;opacity:0.6;"></div>' +
            '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:3px;">' +
              '<div style="background:rgba(255,255,255,0.1);border:1px solid #67e8f9;"></div>' +
              '<div style="background:rgba(255,255,255,0.1);border:1px solid #67e8f9;"></div>' +
            '</div>' +
          '</div>';
      }
    },
    {
      id: 'editorial-spread',
      label: 'Editorial Spread',
      description: 'Magazine layout — huge display title, generous whitespace, numbered sections.',
      preview: function () {
        return '' +
          '<div style="width:100%;height:100%;background:#fff;border-radius:6px;padding:10px 6px;box-sizing:border-box;display:flex;flex-direction:column;gap:3px;">' +
            '<div style="height:18px;background:#000;width:90%;letter-spacing:-1px;"></div>' +
            '<div style="display:flex;gap:5px;margin-top:4px;align-items:flex-start;">' +
              '<div style="font-size:18px;font-weight:900;color:#000;line-height:1;">01</div>' +
              '<div style="flex:1;display:flex;flex-direction:column;gap:2px;">' +
                '<div style="height:3px;background:#000;width:80%;"></div>' +
                '<div style="height:3px;background:#888;width:60%;"></div>' +
              '</div>' +
            '</div>' +
            '<div style="flex:1;background:#e2e8f0;border-radius:2px;margin-top:3px;"></div>' +
          '</div>';
      }
    },
    {
      id: 'polaroid-journal',
      label: 'Polaroid Journal',
      description: 'Kraft paper, slightly rotated photos, handwritten-style captions.',
      preview: function () {
        return '' +
          '<div style="width:100%;height:100%;background:#d6c5a3;border-radius:6px;padding:8px;box-sizing:border-box;display:flex;flex-direction:column;gap:3px;">' +
            '<div style="height:10px;background:#3a2817;border-radius:1px;width:55%;font-family:cursive;"></div>' +
            '<div style="flex:1;display:flex;gap:4px;margin-top:3px;">' +
              '<div style="flex:1;background:#fff;padding:3px 3px 8px;transform:rotate(-2deg);box-shadow:1px 1px 3px rgba(0,0,0,0.2);">' +
                '<div style="background:#94a3b8;width:100%;height:80%;"></div>' +
              '</div>' +
              '<div style="flex:1;background:#fff;padding:3px 3px 8px;transform:rotate(1.5deg);box-shadow:1px 1px 3px rgba(0,0,0,0.2);">' +
                '<div style="background:#94a3b8;width:100%;height:80%;"></div>' +
              '</div>' +
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
