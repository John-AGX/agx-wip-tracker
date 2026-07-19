// Command Center → How it works — Project 86 internal design documentation.
// A data-driven registry of design articles rendered as a left index + reading
// pane inside the (system-admin-only) Console. Add a feature: append to ARTICLES.
// Content is authored HTML (trusted, admin-only surface) — NOT user input.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Small authoring helpers (keep article bodies readable) ──────────
  function callout(kind, title, html) {
    var c = { note: ['#4f8cff', 'rgba(79,140,255,0.10)'], warn: ['#fbbf24', 'rgba(251,191,36,0.10)'],
      key: ['#34d399', 'rgba(52,211,153,0.10)'] }[kind] || ['#8a93a6', 'rgba(255,255,255,0.04)'];
    return '<div class="p86doc-callout" style="border-left:3px solid ' + c[0] + ';background:' + c[1] + ';">' +
      (title ? '<div class="p86doc-callout-t" style="color:' + c[0] + ';">' + esc(title) + '</div>' : '') + html + '</div>';
  }
  function table(headers, rows) {
    return '<div class="p86doc-tablewrap"><table class="p86doc-table"><thead><tr>' +
      headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table></div>';
  }
  function code(s) { return '<code class="p86doc-code">' + esc(s) + '</code>'; }

  // ── The assembly data-flow diagram (inline SVG, theme-neutral) ──────
  function assemblyDiagram() {
    var box = function (x, y, w, title, sub, fill, stroke) {
      return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="46" rx="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1"/>' +
        '<text x="' + (x + w / 2) + '" y="' + (y + 20) + '" text-anchor="middle" font-size="12" font-weight="600" fill="#e8e8ea">' + title + '</text>' +
        '<text x="' + (x + w / 2) + '" y="' + (y + 35) + '" text-anchor="middle" font-size="10" fill="#9a9aa2">' + sub + '</text>';
    };
    var arrow = function (x1, y1, x2, y2) {
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#5b5b66" stroke-width="1.5" marker-end="url(#p86docArr)"/>';
    };
    return '<div class="p86doc-diagram"><svg viewBox="0 0 680 250" width="100%" role="img" aria-label="Assembly data flow">' +
      '<defs><marker id="p86docArr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M2 1L8 5L2 9" fill="none" stroke="#5b5b66" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>' +
      box(20, 20, 150, 'Materials catalog', 'live purchase-history $', 'rgba(52,211,153,0.10)', '#34d399') +
      box(20, 110, 150, 'Code registry', 'Trades + Systems', 'rgba(124,58,237,0.12)', '#a78bfa') +
      box(265, 65, 150, 'Assembly', 'recipe · 1 output unit', 'rgba(79,140,255,0.12)', '#4f8cff') +
      box(510, 20, 150, 'resolveCost()', 'rolled-up $/unit', 'rgba(255,255,255,0.05)', '#5b5b66') +
      box(510, 110, 150, 'flatten()', 'leaf BOM / unit', 'rgba(255,255,255,0.05)', '#5b5b66') +
      box(510, 200, 150, 'Estimate lines', 'routed by cost_code', 'rgba(251,191,36,0.10)', '#fbbf24') +
      arrow(170, 43, 265, 80) + arrow(170, 133, 265, 110) +
      arrow(415, 80, 510, 43) + arrow(415, 95, 510, 133) +
      arrow(585, 156, 585, 200) +
      '</svg></div>';
  }

  // ── The parametric / drawing-driven data-flow diagram ───────────────
  function paramFlowDiagram() {
    var box = function (x, y, w, title, sub, fill, stroke) {
      return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="46" rx="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1"/>' +
        '<text x="' + (x + w / 2) + '" y="' + (y + 20) + '" text-anchor="middle" font-size="12" font-weight="600" fill="#e8e8ea">' + title + '</text>' +
        '<text x="' + (x + w / 2) + '" y="' + (y + 35) + '" text-anchor="middle" font-size="10" fill="#9a9aa2">' + sub + '</text>';
    };
    var arrow = function (x1, y1, x2, y2) {
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#5b5b66" stroke-width="1.5" marker-end="url(#p86docArr2)"/>';
    };
    return '<div class="p86doc-diagram"><svg viewBox="0 0 680 250" width="100%" role="img" aria-label="Parametric assembly data flow">' +
      '<defs><marker id="p86docArr2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M2 1L8 5L2 9" fill="none" stroke="#5b5b66" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>' +
      box(14, 12, 156, 'Draw a shape', 'geometry → Q', 'rgba(79,140,255,0.12)', '#4f8cff') +
      box(14, 100, 156, 'Measure a takeoff', 'LF / SF / count → Q', 'rgba(79,140,255,0.12)', '#4f8cff') +
      box(14, 188, 156, 'Type a quantity', 'Scope Builder → Q', 'rgba(79,140,255,0.12)', '#4f8cff') +
      box(268, 100, 150, 'explode()', 'Q + params + formula', 'rgba(124,58,237,0.14)', '#a78bfa') +
      box(510, 12, 156, 'Priced BOM', 'live catalog $', 'rgba(52,211,153,0.10)', '#34d399') +
      box(510, 100, 156, 'Rollup by bucket', 'materials/labor/gc/sub', 'rgba(255,255,255,0.05)', '#5b5b66') +
      box(510, 188, 156, 'Estimate lines', 'idempotent placementKey', 'rgba(251,191,36,0.10)', '#fbbf24') +
      arrow(170, 35, 268, 112) + arrow(170, 123, 268, 123) + arrow(170, 211, 268, 134) +
      arrow(418, 112, 510, 40) + arrow(418, 123, 510, 123) +
      arrow(588, 146, 588, 188) +
      '</svg></div>';
  }

  // ────────────────────────────────────────────────────────────────────
  var ARTICLES = [
    {
      id: 'assemblies',
      title: 'Assemblies & the code protocol',
      category: 'Estimating',
      icon: '🧩',
      updated: '2026-07-15',
      summary: 'Costed recipes that price one installed unit of work — the estimating backbone and AGX’s proprietary cost intelligence.',
      sections: [
        {
          h: 'What an assembly is',
          html:
            '<p>An <b>assembly</b> is a costed <b>recipe</b> that prices <b>one installed output unit</b> of work as a bill of items. ' +
            '“Exterior repaint — stucco, per SF” resolves to primer + paint + painter-hours + a nested pressure-wash sub-assembly, ' +
            'priced per square foot. On an estimate you supply the takeoff quantity; the assembly supplies everything else.</p>' +
            '<p>This is the heart of AGX’s <b>proprietary cost intelligence</b>: instead of licensing regional cost lists, we price from our own ' +
            'catalog (live purchase history) and our own labor/production rates, and grow the library from real jobs. An assembly ≈ an Xactimate ' +
            'unit-cost line item; nesting ≈ their macros — the difference is the prices are <i>ours</i>.</p>' +
            assemblyDiagram()
        },
        {
          h: 'Anatomy: header + items',
          html:
            '<p>Every assembly has a <b>header</b> (what it is) and a list of <b>items</b> (the bill of materials for one output unit).</p>' +
            '<p><b>Header</b> — ' + code('name') + ', the ' + code('code') + ' (see the protocol below), the output ' + code('unit') +
            ' (SF / LF / SQ / EA — what one unit of the recipe covers), and ' + code('source') + ' (' + code('seed') + ' researched · ' +
            code('manual') + ' hand-built · ' + code('learned') + ' machine-tuned).</p>' +
            '<p><b>Items</b> — each row is one of five <b>kinds</b>:</p>' +
            table(['kind', 'what it is', 'priced by'], [
              [code('material'), 'a catalog material (drywall, paint…)', 'live catalog price when ' + code('unit_cost') + ' is blank'],
              [code('labor'), 'AGX crew time', 'manual rate (e.g. $/HR × hours per unit)'],
              [code('sub'), 'work handed to a subcontractor', 'manual rate'],
              [code('gc'), 'general conditions / overhead', 'manual rate'],
              [code('assembly'), 'a <b>nested sub-assembly</b>', 'the child’s own resolved cost']
            ]) +
            '<p>Each item also carries ' + code('qty_per_unit') + ' (quantity consumed per <b>one output unit</b> of the parent), ' +
            code('waste_pct') + ', a ' + code('cost_code') + ' (which estimate section it routes to), and an optional ' + code('rationale') +
            ' (the written “why” behind a rate — the tuning trail).</p>' +
            callout('key', 'The live-pricing trick',
              '<p>A ' + code('material') + ' row with a <b>blank</b> ' + code('unit_cost') + ' pulls the catalog’s ' + code('last_unit_price') +
              ' at read time. So every Home-Depot purchase-history import <b>reprices every assembly automatically</b> — the library never goes stale on materials. ' +
              'Freeze a price by typing a number instead.</p>')
        },
        {
          h: 'The code protocol — TRADE-SYSTEM-VARIANT',
          html:
            '<p>Codes are a <b>3-tier mnemonic</b>, uppercase, <b>derived from structured fields</b> (never hand-typed) and unique per org:</p>' +
            '<pre class="p86doc-pre">ROOF-SHNG-612     Roofing · Shingle · 6:12 pitch\n' +
            'FENC-WD-PRIV6     Fencing · Wood · 6ft privacy\n' +
            'STUC-STD          Stucco · Standard 3-coat  (variant optional)</pre>' +
            '<p><b>TRADE</b> and <b>SYSTEM</b> come from the controlled registry; <b>VARIANT</b> is a short free spec ' +
            '(' + code('^[A-Z0-9/]{0,10}$') + '). The editor gives you Trade + System dropdowns and a Variant box, then the code ' +
            '<b>auto-derives</b> and the server guarantees it’s unique.</p>' +
            callout('note', 'Why derived, not typed',
              '<p>A hand-typed code drifts (ROOF-SHINGLE vs RF-SHNG vs roof_shg). Deriving it from a controlled Trade + System keeps the whole ' +
              'library consistent and greppable, and lets 86 mint compliant codes without guessing.</p>') +
            callout('warn', 'Lenient by design',
              '<p>Unknown free-text trades are <b>alias-mapped</b> (“Roofing” → ROOF) and truly novel ones save as <b>legacy</b> (kept, ' +
              'shown “unclassified”) rather than blocking the save. Only an unknown <i>system</i> under a <i>known</i> trade hard-errors ' +
              '(so 86 self-corrects). Nothing that worked before the protocol breaks.</p>')
        },
        {
          h: 'The registry (Trades + Systems)',
          html:
            '<p>Two tables hold the controlled vocabulary: ' + code('assembly_trades') + ' and ' + code('assembly_systems') +
            ' (systems reference a trade <i>by code</i>). Rows are either:</p>' +
            '<ul><li><b>Global seed</b> (' + code('organization_id NULL') + ') — shipped, shared by every tenant, read-only in the UI.</li>' +
            '<li><b>Org rows</b> — your own additions; an org row “shadows” a global of the same code.</li></ul>' +
            '<p>Manage them in <b>Admin → Organization → Assembly Codes</b> (add / rename / archive). They drive the /assemblies editor ' +
            'dropdowns and the tree grouping, and 86 reads them via ' + code('read_assembly_taxonomy') + '.</p>' +
            callout('note', 'Seeded taxonomy',
              '<p>17 starter trades ship (Roofing, Fencing, Decking, Stucco, Painting, Carpentry, Concrete, Drywall, Siding, Gutters, Windows, ' +
              'Doors, GC + Electrical/Plumbing/HVAC/Demo), each with a handful of systems.</p>')
        },
        {
          h: 'Two kinds of “expansion”',
          html:
            '<p>The word “expand” means two different things:</p>' +
            '<p><b>1. Cost rollup</b> — ' + code('resolveCost()') + ' walks the recipe and returns the price of one output unit. ' +
            'It recurses into nested sub-assemblies, is <b>cycle-guarded</b> (a per-path visited-set, so a diamond isn’t a false cycle), ' +
            'and rounds to cents at each level. An unpriced item marks the result ' + code('incomplete') + ' — <b>never a silent $0</b>.</p>' +
            '<p><b>2. Bill of materials</b> — ' + code('flatten()') + ' explodes the recipe into <b>leaf rows per one output unit</b> ' +
            '(max nesting depth 4), folding each level’s waste into the effective quantity. The estimate multiplies each leaf by the takeoff qty.</p>' +
            callout('key', 'One math, everywhere',
              '<p>Both live in ' + code('server/services/assemblies.js') + ' and take any query-able handle, so the REST API, the AI read tool, ' +
              'and the payload dispatcher all price identically — there is one source of truth for the math.</p>')
        },
        {
          h: 'Putting an assembly on an estimate',
          html:
            '<p>From an estimate’s <b>Materials drawer → 🧩 Assemblies</b>: search, set the takeoff quantity, and insert. Two modes:</p>' +
            '<ul><li><b>Rollup</b> (default) — <b>one line per cost bucket</b> (Materials / Labor / GC / Subs), each with a collapsible breakdown ' +
            'strip you can refresh or explode.</li>' +
            '<li><b>Exploded</b> — one line per leaf item.</li></ul>' +
            '<p>Every inserted line is routed to its estimate section by its ' + code('cost_code') + ' and stamped with ' + code('source_assembly_id') +
            ' so job actuals can later roll up per assembly.</p>' +
            callout('warn', 'The code is orthogonal to routing',
              '<p>The assembly <i>code</i> organizes the library; the item-level <i>' + code('cost_code') + '</i> (materials/labor/gc/sub) is what ' +
              'routes exploded lines into estimate sections. They are independent — changing the code protocol never touches estimate routing.</p>')
        },
        {
          h: '86 owns this database',
          html:
            '<p>86 (not the Assistant) is the steward of assemblies + materials; the Assistant escalates every pricing question to it.</p>' +
            '<ul>' +
            '<li><b>Reads:</b> ' + code('read_assemblies') + ' (index, or a recipe + flat explode by id) and ' + code('read_assembly_taxonomy') +
            ' (the valid Trade/System codes).</li>' +
            '<li><b>Writes:</b> ' + code('scribe_write') + ' with entity_type ' + code('assembly') + ' — 86 sets trade + system (+ variant) and ' +
            '<b>omits the code</b> (the server derives it); every write is an approval card and is logged.</li>' +
            '<li><b>Assembly Studio</b> (the Console tab next to this one) — a build-and-tune cockpit with 86 docked, a research inbox, and a ' +
            'worst-first tuning queue.</li>' +
            '<li><b>Tuning Center</b> — every component cost shows its derivation chain (price × qty × waste), each factor provable from ' +
            'purchase history or a written rationale; edits log to ' + code('assembly_tuning_log') + ' (the training-flywheel trail).</li>' +
            '</ul>' +
            callout('warn', 'Managed-agent resync',
              '<p>After the tool set or Scribe vocabulary changes, the live 86 agent keeps its old snapshot until you ' +
              code('POST /api/admin/agents/managed/sync-all') + ' <b>and start a new chat</b> (or wait for the ~15-min auto-resync sweep).</p>')
        },
        {
          h: 'Data model reference',
          html:
            table(['table', 'holds', 'key columns'], [
              [code('assemblies'), 'the recipe header', code('trade') + ' ' + code('system') + ' ' + code('variant') + ' → ' + code('code') + ' (unique/org), ' + code('unit') + ', ' + code('source')],
              [code('assembly_items'), 'the bill of items', code('kind') + ', ' + code('material_id') + ' / ' + code('child_assembly_id') + ', ' + code('qty_per_unit') + ', ' + code('unit_cost') + ', ' + code('cost_code') + ', ' + code('waste_pct')],
              [code('assembly_trades'), 'trade registry', code('organization_id') + ' (NULL = seed), ' + code('code') + ', ' + code('name')],
              [code('assembly_systems'), 'system registry', code('trade_code') + ', ' + code('code') + ', ' + code('name') + ', ' + code('default_unit')],
              [code('assembly_tuning_log'), 'every change (flywheel)', 'old→new per field, reason, evidence, source'],
              [code('assembly_research'), 'web-research inbox', 'findings JSONB, status, ' + code('consumed_assembly_id')]
            ]) +
            callout('note', 'The gc ↔ equipment seam',
              '<p>Estimates + catalog + assemblies bucket cost into <b>materials / labor / gc / sub</b>; the phase-allocation matrix uses ' +
              '<b>equipment</b> instead of gc. Per AGX convention, equipment/permits/fuel ride under <b>gc</b> when reconciling.</p>')
        },
        {
          h: 'Where the code lives',
          html:
            table(['area', 'file'], [
              ['Shared math + code protocol + validation', code('server/services/assemblies.js')],
              ['REST API (list / recipe / create / update / items)', code('server/routes/assembly-routes.js')],
              ['Code registry API', code('server/routes/assembly-taxonomy-routes.js')],
              ['Schema + boot backfill + unique index', code('server/db.js')],
              ['/assemblies page (editor + Trade→System tree)', code('js/assemblies.js')],
              ['Explode into an estimate', code('js/materials-drawer.js')],
              ['Assembly Studio + Tuning Center', code('js/console.js')],
              ['Taxonomy manager (Admin→Org→Assembly Codes)', code('js/admin.js')],
              ['86 write path', code('server/services/payload-dispatcher.js → dispatchAssembly')],
              ['86 read tools', code('server/routes/ai-routes.js (read_assemblies, read_assembly_taxonomy)')]
            ])
        }
      ]
    },
    {
      id: 'parametric-assemblies',
      title: 'Parametric assemblies & drawing-driven estimating',
      category: 'Estimating',
      icon: '📐',
      updated: '2026-07-19',
      summary: 'Assemblies whose quantity comes from a formula and a drawing — measure or draw the work, and the parts and price compute themselves.',
      sections: [
        {
          h: 'From “one unit” to “your quantity”',
          html:
            '<p>A base <b>assembly</b> prices <b>one installed output unit</b> of work (see <i>Assemblies &amp; the code protocol</i>). The <b>parametric layer</b> adds the missing half: instead of you supplying the takeoff quantity by hand, a <b>formula</b> computes each item’s quantity from the job’s real dimensions — and those dimensions can come straight off a <b>drawing</b>.</p>' +
            '<p>That is the idea John calls <b>Revit-lite</b>: <b>draw</b> the fence, <b>measure</b> the wall, or <b>type</b> the run — and the parts and price fall out. One pricing engine sits behind all three; only the way you supply the takeoff quantity <code>Q</code> differs.</p>' +
            paramFlowDiagram()
        },
        {
          h: 'Q and the parameters',
          html:
            '<p><b>' + code('Q') + ' is reserved</b> — it is always the <b>takeoff quantity in the assembly’s output unit</b> (100 LF of fence, 850 SF of stucco, 6 EA of posts). Every parametric recipe can rely on it without declaring it.</p>' +
            '<p>On top of Q you declare up to <b>12 parameters</b> — geometry knobs like height, post spacing, or number of coats:</p>' +
            table(['field', 'meaning'], [
              [code('key'), 'the identifier used in formulas (letter-led, ≤16 chars; ' + code('Q') + ' is rejected)'],
              [code('label') + ' / ' + code('unit'), 'human labels for the input'],
              [code('default'), 'the value used when the input is left blank'],
              [code('min') + ' / ' + code('max'), 'optional clamp (an authoring guardrail)']
            ]) +
            '<p>Each recipe item then carries a <b>' + code('qty_formula') + '</b> — an expression that computes that item’s <b>total</b> quantity from Q and the params. The canonical idiom is <code>ceil(Q/S)+1</code> (“a post every S feet, plus the end post”).</p>' +
            callout('note', 'Formula total vs per-unit',
              '<p>A formula computes the <b>absolute total</b> (already scaled by Q). A plain item without a formula keeps ' + code('qty_per_unit') + ' — its quantity <i>per one output unit</i> — and is multiplied by Q at explode time. A recipe can mix both.</p>')
        },
        {
          h: 'One formula engine, both sides',
          html:
            '<p>Formulas run through a single shared evaluator, ' + code('js/assembly-formula.js') + ', loaded <b>both</b> in the browser (' + code('window.p86Formula') + ', for live previews) and on the server (' + code('require') + ', for the real explode). Same code — so a formula can <b>never</b> compute a different number in the two places money is shown.</p>' +
            '<p>It supports <code>+ − × ÷</code>, parentheses, unary minus, and seven functions — <code>ceil floor round abs sqrt min max</code> — over Q and the params. It is a hand-written parser: <b>no</b> ' + code('eval') + ', no ' + code('Function()') + '; unknown names and prototype tricks (' + code('constructor') + ', ' + code('__proto__') + ') resolve to an error, not to code.</p>' +
            callout('key', 'The float-noise snap — the parametric money bug',
              '<p>IEEE math makes <code>0.1×3×10 = 3.0000000000000004</code>, so a naïve <code>ceil()</code> would over-count by one and silently <b>over-order material</b>. Inside <code>ceil</code>/<code>floor</code>/<code>round</code> the engine first <b>snaps</b> any value within 1e-9 of an integer to that integer. Since <code>ceil(Q/S)</code> is the canonical quantity idiom, this guard is load-bearing.</p>') +
            callout('warn', 'Blank is absent, not zero',
              '<p>A blank, null, or boolean input is treated as <b>not supplied</b> (the recipe’s ' + code('default') + ' is used), never coerced to 0. ' + code('Number("")===0') + ' would silently zero-price a cleared dimension — so the engine refuses it instead.</p>')
        },
        {
          h: 'Explode: Q + params → priced parts',
          html:
            '<p>' + code('POST /api/assemblies/:id/explode') + ' with a scope ' + code('{Q, H, …}') + ' returns the final <b>priced leaf rows</b>. The server builds the scope (Q + param defaults, your values overlaid, then clamped), evaluates every formula, applies waste, and recurses into nested sub-assemblies (cycle- and depth-guarded at 4 levels).</p>' +
            '<p>Two shapes come out, chosen by <b>mode</b>:</p>' +
            table(['mode', 'result'], [
              [code('rollup') + ' (default)', 'one line per cost bucket — Materials / Labor / GC / Subs — each carrying its leaf breakdown'],
              [code('exploded'), 'one line per individual leaf item']
            ]) +
            callout('key', 'Never a silent $0',
              '<p>A material row with a blank ' + code('unit_cost') + ' prices from the <b>live catalog</b> (last purchase price). If nothing prices it, the row comes back <b>unpriced</b> and the response is flagged ' + code('incomplete') + ' — surfaced as “no price”, never counted as zero. A formula error omits that one row and reports the error rather than pricing it $0.</p>') +
            callout('note', 'Formulas fire at the root only',
              '<p>A ' + code('qty_formula') + ' drives quantity only when the assembly is inserted <b>directly</b>. The same item reached <i>inside</i> a nested sub-assembly falls back to its linear per-unit quantity (with a warning) — a nested formula is an absolute total that would double-count across the parent’s N copies.</p>')
        },
        {
          h: 'Where you drive it',
          html:
            '<p>Four surfaces feed Q into the same explode. The first three are the desk / field flows; the fourth is Revit-lite (its own section below).</p>' +
            table(['surface', 'where', 'how Q arrives'], [
              ['<b>Recipe preview</b>', '/assemblies editor', 'a sample Q=100 + typed dims — a live “Parametric preview” bar so the author sees exact cost before saving'],
              ['<b>Scope Builder</b>', 'estimate → Materials drawer → 🧩', 'stack recipes and type Q + dimensions; a debounced server reprice shows the true total, then Insert'],
              ['<b>Quantify</b>', 'Plans &amp; Takeoffs / photo markup', 'measure a run (LF), region (SF), or count (EA); the measurement becomes Q'],
              ['<b>Revit-lite</b>', 'CAD sheet editor', 'draw a shape and its own geometry becomes Q']
            ]) +
            callout('note', 'Interim vs true price',
              '<p>Before the first explode returns, a surface may show a quick <b>linear</b> estimate (q × per-unit). It snaps to the exact formula-computed total the moment the server responds. The recipe editor’s header “$/unit” chip is always linear and marks itself with a ' + code('·ƒ') + ' when formulas are present — read the preview bar, not the chip, for the parametric price.</p>')
        },
        {
          h: 'Revit-lite — draw the work',
          html:
            '<p>In the CAD sheet editor, select a drawn object — line, rectangle, polyline, ellipse, hatch, wipeout, or symbol — and a <b>🧩 Assembly</b> picker appears in the Properties inspector. Pick a parametric assembly and its <b>geometry drives Q</b>:</p>' +
            table(['output unit', 'Q comes from'], [
              [code('LF'), 'the object’s length ÷ 12 (model inches → feet)'],
              [code('SF') + ' / ' + code('SQ'), 'the closed shape’s area (shoelace ÷ 144; SQ also ÷ 100 for roofing squares)'],
              [code('EA'), '1 per placement (array-copy for N)'],
              [code('other'), 'SY / CY / CF / HR… → <b>warned, never priced</b> (a 2D drawing can’t supply them)']
            ]) +
            '<p>The binding is a tiny ' + code('{id, name, unit, mode, params}') + ' object stored right on the drawn entity. It <b>persists with the drawing</b>, is <b>undoable</b>, and is carried automatically by duplicate / array / mirror. A priced <b>Bill of Materials</b> renders live under the picker, and reshaping the object with a grip <b>re-prices</b> it from the new size.</p>' +
            callout('key', 'Live price, never frozen on the drawing',
              '<p>Only the lightweight binding is saved — <b>never</b> the dollars. The BOM is re-fetched from the catalog every session (cache-first within a session, with a monotonic token so a stale response can’t paint the wrong assembly’s parts). So a catalog price change always reflects.</p>')
        },
        {
          h: 'Push a drawing into an estimate',
          html:
            '<p>A whole-drawing <b>🧩 Bill of Materials</b> rollup sums every bound object (grouped by assembly), and <b>Push to estimate</b> sends it into an editable estimate. The server <b>re-explodes</b> each placement itself — the client’s numbers are never trusted — under a row lock, refuses a locked (sold) estimate, and refuses to append a partial / unpriced cost.</p>' +
            '<p>The critical property is <b>idempotency</b>. Each placement carries a stable ' + code('placement_key') + ' = ' + code('plan:object:assembly') + '. On the server, a key that is already present <b>deletes that placement’s prior lines before re-inserting</b> — so:</p>' +
            table(['action', 'estimate lines'], [
              ['first push', 'inserted'],
              ['<b>re-push the same drawing</b>', '<b>replaced — never doubled</b>'],
              ['resize an object, push again', 'that placement re-priced in place'],
              ['add a second object, push', 'added alongside; the first untouched']
            ]) +
            callout('key', 'Why this matters',
              '<p>The append endpoint is otherwise append-only, so without the key, pushing a drawing twice would duplicate the entire thing. The ' + code('placement_key') + ' makes a push a <b>clean re-sync</b> — you can push after every edit and the estimate stays correct. (The Quantify / desk flows carry no key, so they stay plain append, unchanged.)</p>') +
            callout('note', 'Offline-safe merge',
              '<p>The app is offline-first — a save ships the whole portfolio. After each append the client splices the server’s fresh lines into its in-memory copy and reconverges, so a pending background save preserves the push instead of clobbering it.</p>')
        },
        {
          h: 'Money-correctness invariants',
          html:
            '<ul>' +
            '<li><b>One math, both sides</b> — the same ' + code('js/assembly-formula.js') + ' runs in the preview and the server explode; the price you see is the price you get.</li>' +
            '<li><b>Never a silent $0</b> — unpriced items surface as ' + code('incomplete') + '; formula errors omit-and-report; a push refuses partial cost.</li>' +
            '<li><b>Blank ≠ 0</b> — a cleared dimension uses the recipe default, never zero.</li>' +
            '<li><b>Live catalog pricing</b> — material rows reprice from purchase history; dollars are never frozen onto a drawing.</li>' +
            '<li><b>Server is the source of truth</b> — on push the server re-explodes, so a stale or tampered client can’t inject a wrong price.</li>' +
            '<li><b>Unknown units warn</b> — a unit a 2D drawing can’t measure (SY / CY / HR…) is refused, never defaulted to 1.</li>' +
            '<li><b>Idempotent push</b> — ' + code('placement_key') + ' makes a re-push a replace, not a duplicate.</li>' +
            '</ul>'
        },
        {
          h: 'Data model & where the code lives',
          html:
            table(['field', 'on', 'holds'], [
              [code('params'), code('assemblies'), 'the ' + code('{key,label,unit,default,min,max}') + ' declaration (JSONB)'],
              [code('qty_formula'), code('assembly_items'), 'the per-item quantity expression (else ' + code('qty_per_unit') + ')'],
              [code('sourceAssemblyId') + ' + ' + code('assemblyParams'), 'estimate line', 'which assembly + the scope it priced at (lets a line re-price and skips the per-unit refresh)'],
              [code('sourcePlacement'), 'estimate line', 'the ' + code('plan:object:assembly') + ' key that makes a re-push replace it']
            ]) +
            table(['layer', 'file'], [
              ['Shared formula engine (browser + server)', code('js/assembly-formula.js')],
              ['Params · explode · pricing', code('server/services/assemblies.js')],
              ['Explode / create / items REST', code('server/routes/assembly-routes.js')],
              ['Estimate line routing + placementKey idempotency', code('server/services/estimate-lines.js')],
              ['append-assembly + bulk-save', code('server/routes/estimate-routes.js')],
              ['Recipe editor + preview bar', code('js/assemblies.js')],
              ['Scope Builder (stack &amp; type Q)', code('js/materials-drawer.js')],
              ['Quantify (measure → Q)', code('js/markup-viewer.js')],
              ['Revit-lite (draw → Q, BOM, push)', code('js/sheet-editor.js')]
            ])
        },
        {
          h: 'Where it goes next',
          html:
            '<p>Shipped today: parametric recipes (S0), Quantify takeoffs (S1 / S1b), and Revit-lite drawing binding + rollup + idempotent push (RL-0…RL-2).</p>' +
            '<ul>' +
            '<li><b>RL-3</b> — a place-first “Place assembly” ribbon tool (draw <i>as</i> the assembly) + on-canvas name / $ badges.</li>' +
            '<li><b>RL-4</b> — a batch-explode endpoint and a running $ summary on the plan list row.</li>' +
            '</ul>' +
            callout('note', 'The tiers above Revit-lite',
              '<p>Tier 2 would be 2.5D (height-aware); Tier 3 is true 3D BIM, which means <b>integrating</b> an existing engine (OpenCascade / web-ifc), never writing one. For estimating, ~95% of the value already lands at this 2D tier — the drawing’s footprint is what prices the work.</p>')
        }
      ]
    }
  ];

  var _sel = ARTICLES.length ? ARTICLES[0].id : null;

  function ensureStyles() {
    if (document.getElementById('p86doc-styles')) return;
    var css =
      '.p86doc-wrap{display:grid;grid-template-columns:230px minmax(0,1fr);gap:16px;align-items:start;}' +
      '.p86doc-index{position:sticky;top:8px;border:1px solid var(--border,#33333a);border-radius:10px;background:var(--panel,#1c1c22);padding:8px;}' +
      '.p86doc-cat{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim,#8a93a6);padding:8px 8px 4px;}' +
      '.p86doc-ilink{display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:7px;cursor:pointer;color:var(--text,#e8e8ea);font-size:13px;}' +
      '.p86doc-ilink:hover{background:rgba(255,255,255,0.04);}' +
      '.p86doc-ilink.active{background:rgba(79,140,255,0.15);color:#8fb6ff;}' +
      '.p86doc{border:1px solid var(--border,#33333a);border-radius:10px;background:var(--panel,#1c1c22);padding:20px 24px;color:var(--text,#e2e2e8);line-height:1.62;font-size:14px;max-width:820px;}' +
      '.p86doc-h1{font-size:20px;font-weight:600;color:var(--text,#fff);margin:0 0 2px;}' +
      '.p86doc-sub{font-size:12.5px;color:var(--text-dim,#9a9aa2);margin:0 0 4px;}' +
      '.p86doc-meta{font-size:11px;color:var(--text-dim,#777);margin:0 0 14px;padding-bottom:14px;border-bottom:1px solid var(--border,#2a2a32);}' +
      '.p86doc h3{font-size:15.5px;font-weight:600;color:var(--text,#fff);margin:26px 0 8px;padding-top:6px;}' +
      '.p86doc p{margin:0 0 11px;}.p86doc ul{margin:0 0 11px;padding-left:20px;}.p86doc li{margin:3px 0;}' +
      '.p86doc-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:rgba(255,255,255,0.06);border:1px solid var(--border,#33333a);border-radius:4px;padding:1px 5px;color:#8fd0ff;white-space:nowrap;}' +
      '.p86doc-pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:rgba(0,0,0,0.28);border:1px solid var(--border,#33333a);border-radius:8px;padding:12px 14px;color:#c9d6e5;overflow-x:auto;margin:0 0 12px;line-height:1.5;}' +
      '.p86doc-callout{border-radius:8px;padding:10px 13px;margin:12px 0;font-size:13px;}' +
      '.p86doc-callout-t{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;}' +
      '.p86doc-callout p{margin:0 0 6px;}.p86doc-callout p:last-child{margin:0;}' +
      '.p86doc-tablewrap{overflow-x:auto;margin:0 0 12px;}' +
      '.p86doc-table{border-collapse:collapse;width:100%;font-size:12.5px;}' +
      '.p86doc-table th{text-align:left;color:var(--text-dim,#9a9aa2);font-weight:600;border-bottom:1px solid var(--border,#3a3a44);padding:6px 10px;}' +
      '.p86doc-table td{border-bottom:1px solid var(--border,#26262e);padding:6px 10px;vertical-align:top;}' +
      '.p86doc-diagram{background:rgba(0,0,0,0.18);border:1px solid var(--border,#2a2a32);border-radius:10px;padding:10px;margin:4px 0 14px;}' +
      '@media(max-width:760px){.p86doc-wrap{grid-template-columns:1fr;}.p86doc-index{position:static;}}';
    var st = document.createElement('style');
    st.id = 'p86doc-styles'; st.textContent = css; document.head.appendChild(st);
  }

  function renderInto(host) {
    if (!host) return;
    ensureStyles();
    if (!ARTICLES.length) { host.innerHTML = '<div style="padding:20px;color:#8a93a6;">No documentation yet.</div>'; return; }
    // Left index, grouped by category.
    var cats = [];
    var byCat = {};
    ARTICLES.forEach(function (a) { if (!byCat[a.category]) { byCat[a.category] = []; cats.push(a.category); } byCat[a.category].push(a); });
    var indexHtml = '<div class="p86doc-cat" style="padding-top:2px;">How Project 86 works</div>' +
      cats.map(function (cat) {
        return '<div class="p86doc-cat">' + esc(cat) + '</div>' +
          byCat[cat].map(function (a) {
            return '<div class="p86doc-ilink' + (a.id === _sel ? ' active' : '') + '" data-doc="' + esc(a.id) + '">' +
              '<span>' + (a.icon || '📄') + '</span><span>' + esc(a.title) + '</span></div>';
          }).join('');
      }).join('');

    var art = ARTICLES.filter(function (a) { return a.id === _sel; })[0] || ARTICLES[0];
    var body =
      '<div class="p86doc-h1">' + (art.icon || '') + ' ' + esc(art.title) + '</div>' +
      (art.summary ? '<div class="p86doc-sub">' + esc(art.summary) + '</div>' : '') +
      '<div class="p86doc-meta">' + esc(art.category) + (art.updated ? ' · updated ' + esc(art.updated) : '') + '</div>' +
      art.sections.map(function (s) { return '<h3>' + esc(s.h) + '</h3>' + s.html; }).join('');

    host.innerHTML = '<div class="p86doc-wrap"><div class="p86doc-index">' + indexHtml + '</div><div class="p86doc">' + body + '</div></div>';
    host.querySelectorAll('[data-doc]').forEach(function (el) {
      el.addEventListener('click', function () { _sel = el.getAttribute('data-doc'); renderInto(host); host.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
    });
  }

  window.p86Docs = { articles: ARTICLES, renderInto: renderInto, select: function (id) { _sel = id; } };
})();
