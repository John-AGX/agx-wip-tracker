// AI estimating-assistant panel — slide-in right rail attached to the
// estimate editor. Read-only Q&A: it knows the estimate's full context
// (server-side) but cannot modify the estimate. Per-user chat history.
//
// Wire-up:
//   - Estimate editor calls window.p86AI.toggle() / .open(estimateId)
//   - On open, we GET /api/ai/estimates/:id/messages to load history
//   - User submits → POST /api/ai/estimates/:id/chat (SSE), we stream the
//     assistant's reply into a live message bubble
(function() {
  'use strict';

  var _open = false;
  // Generalized entity binding — the panel works against estimates today
  // and jobs as of Phase 2B. _entityType decides which API base path the
  // chat hits ('estimate' → /api/ai/estimates/:id, 'job' → /api/ai/jobs/:id)
  // and which features are available (estimate has photos + write tools,
  // job is read-only / no photos for now).
  var _entityType = 'estimate';
  var _entityId = null;
  var _estimateId = null; // legacy alias kept so existing call sites keep working
  var _messages = [];           // {role, content, ...}
  var _streaming = false;
  var _includePhotos = true;    // default-on with toggle, per the user
  var _abortController = null;

  // Auto-rendered PDF page images for the current estimate. Populated
  // lazily on panel open so by the time the user sends a turn, scanned
  // PDFs (no extracted text layer) have already been rasterized client-
  // side and are ready to attach as additional_images. Keyed by
  // attachment id so each PDF is rendered at most once per session.
  //
  // _autoPdfCache:    id → { images: [base64], totalPages, renderedPages, filename }
  // _autoPdfPromises: id → Promise (in-flight render, awaited on send)
  // _autoPdfBudget:   per-turn cap on how many auto-render images we
  //                   actually attach (Anthropic per-request image cap
  //                   minus reserved photos slots minus composer slots).
  var _autoPdfCache = {};
  var _autoPdfPromises = {};
  var _autoPdfBudget = 12;
  // Lead-intake: set true every time the panel opens in intake mode;
  // cleared after the first /chat call. Triggers server-side
  // archive of the prior intake session so each panel-open is a
  // fresh conversation. Subsequent turns within the same open keep
  // full session context.
  var _intakeFreshPending = false;

  // AG phase icons. No Unicode emoji exists for the elaborate blueprint
  // / drafting-tools look — the closest emoji is 📐 (just a triangular
  // ruler), so we hand-craft inline SVGs. currentColor stroke lets
  // the icons inherit the surrounding header\'s text color, and the
  // transparent fill keeps them readable on the panel\'s dark gradient.
  //
  // Plan → blueprint sheet with a curled left edge, a drafting compass
  //         at the top (pivot + two legs), and a small floor-plan
  //         layout inside. Mirrors the construction-document
  //         iconography the user shared.
  // Build → hammer (head + diagonal handle) crossed with a carpenter\'s
  //         L-square at the bottom — the two tools you\'d pick up
  //         when you stop drafting and start swinging.
  var SVG_PLAN_ICON =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      // Sheet rectangle + rolled left edge (the "blueprint paper" cue)
      '<path d="M7 3 H20 V21 H7 Z"/>' +
      '<path d="M7 3 C5 3 4 4 4 6 V18 C4 20 5 21 7 21"/>' +
      // Drafting compass at top: pivot circle + two diverging legs
      '<circle cx="13.5" cy="6.3" r="0.75" fill="currentColor"/>' +
      '<line x1="13" y1="7" x2="11" y2="10.5"/>' +
      '<line x1="14" y1="7" x2="16" y2="10.5"/>' +
      // Floor-plan rectangles below the compass
      '<rect x="8.5" y="13" width="3.5" height="2.3"/>' +
      '<rect x="12.5" y="13" width="2.8" height="2.3"/>' +
      '<rect x="8.5" y="16" width="6.8" height="2.5"/>' +
    '</svg>';
  var SVG_BUILD_ICON =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      // Hammer head (top-left rectangle)
      '<rect x="2.5" y="2.5" width="8" height="4" rx="0.4"/>' +
      // Hammer handle going diagonally down-right
      '<line x1="10.5" y1="6.5" x2="20" y2="16"/>' +
      // Carpenter\'s L-square along the bottom + left
      '<path d="M3 18 V21 H19 V18 H6 V13 H3 Z"/>' +
      // Hash marks along the square (suggests measurement)
      '<line x1="9" y1="19.5" x2="9" y2="20.5"/>' +
      '<line x1="12" y1="19.5" x2="12" y2="20.5"/>' +
      '<line x1="15" y1="19.5" x2="15" y2="20.5"/>' +
    '</svg>';

  // Phase 1b/1c — when the server flips AGENT_MODE_47=agents, the AG
  // estimating chat routes to the Sessions-backed /v2 endpoint. The
  // server adapts the SSE shape to match v1 so this single switch is
  // the entire client-side change. Falls back to legacy when the flag
  // is missing (e.g. fresh login before /me hydrates feature_flags).
  function isAgAgentMode() {
    var u = (window.p86Auth && window.p86Auth.getUser) ? window.p86Auth.getUser() : null;
    return !!(u && u.feature_flags && u.feature_flags.agent_mode_ag === 'agents');
  }
  // Phase 2 — same gating for 86 (jobs), HR (clients), and CoS
  // (staff). Independent flags so each agent ramps separately on its
  // own telemetry before flipping.
  function isJobAgentMode() {
    var u = (window.p86Auth && window.p86Auth.getUser) ? window.p86Auth.getUser() : null;
    return !!(u && u.feature_flags && u.feature_flags.agent_mode_job === 'agents');
  }
  // isCraAgentMode / isStaffAgentMode removed — the cra and staff
  // managed agents were archived; every surface uses the unified
  // 'job' agent now, so per-agent feature-flag gating is moot.
  function apiBase() {
    // UNIFIED 86 — every surface routes to /api/ai/86. The endpoint
    // accepts current_context describing which entity is open;
    // server-side it loads the appropriate per-turn snapshot (estimate,
    // job WIP, intake bucket, client directory, admin/CoS metrics). ONE
    // conversation thread per user persists across pages.
    return '/api/ai/86';
  }
  function isEstimateMode() { return _entityType === 'estimate'; }
  function isJobMode() { return _entityType === 'job'; }
  function isClientMode() { return _entityType === 'client'; }
  function isStaffMode() { return _entityType === 'staff'; }
  function isIntakeMode() { return _entityType === 'intake'; }
  function isAsk86Mode() { return _entityType === 'ask86'; }

  // Build the per-turn page-context payload for the unified 86
  // surface. Tells 86 "where is the user, what are they looking at."
  // Best-effort — every signal is optional; the server treats the
  // whole object as nullable. Lives in this module because the panel
  // is the only call site, and it has the cleanest read of the SPA's
  // current state via the existing `_entityType` / `_entityId` slots
  // when a per-entity panel is also mounted plus `window.appState`
  // for the legacy job-shell state.
  function getCurrentPageContext() {
    var ctx = {};
    // Active top-level tab — read from the navbar's .active button.
    try {
      var activeBtn = document.querySelector('.tab-btn.active');
      if (activeBtn) {
        var tab = activeBtn.getAttribute('data-tab') || activeBtn.textContent || '';
        tab = String(tab).trim();
        if (tab) ctx.page = tab;
      }
    } catch (e) { /* best-effort */ }

    // Active URL — handy for cross-checking ctx.page when the SPA
    // routes via hash / path. Keep relative to avoid leaking the
    // deployment host.
    try {
      var url = (window.location.pathname || '') + (window.location.search || '') + (window.location.hash || '');
      if (url) ctx.url = url;
    } catch (e) { /* best-effort */ }

    // Open job — the most common entity the user has selected. The
    // jobs tab + workspace + WIP all surface a job via appState.
    var openJobId = (window.appState && window.appState.currentJobId) || null;
    if (openJobId) {
      ctx.entity_type = 'job';
      ctx.entity_id = String(openJobId);
      // Label from the loaded jobs array if available.
      try {
        var job = (window.appData && Array.isArray(window.appData.jobs))
          ? window.appData.jobs.find(function(j) { return j && j.id === openJobId; })
          : null;
        if (job) ctx.entity_label = job.name || job.jobNumber || job.id;
      } catch (e) { /* best-effort */ }
    }

    // Open estimate — overrides the job entity if the estimate editor
    // is open (the user is actively editing an estimate, even if it's
    // linked to a job).
    try {
      if (window.estimateEditorAPI && typeof window.estimateEditorAPI.getCurrentEstimateId === 'function') {
        var eid = window.estimateEditorAPI.getCurrentEstimateId();
        if (eid) {
          ctx.entity_type = 'estimate';
          ctx.entity_id = String(eid);
          ctx.entity_label = null;
        }
      }
    } catch (e) { /* best-effort */ }

    // URL-based fallback. The editor API can return null when the
    // editor's open-event hasn't fired yet OR when the user landed
    // here via a direct URL/deep link and the API isn't initialized.
    // The URL itself carries the entity id; pull it from there when
    // the API didn't. Pattern: /estimates/edit/<id>, /leads/<id>,
    // /jobs/<id>, /clients/<id>. Only fills in when entity_type
    // wasn't already set by a stronger signal above.
    if (!ctx.entity_type) {
      try {
        var path = window.location.pathname || '';
        var m;
        if ((m = path.match(/\/estimates\/(?:edit\/)?([\w-]+)/))) {
          ctx.entity_type = 'estimate';
          ctx.entity_id = m[1];
        } else if ((m = path.match(/\/leads\/(?:edit\/)?([\w-]+)/))) {
          ctx.entity_type = 'lead';
          ctx.entity_id = m[1];
        } else if ((m = path.match(/\/jobs\/(?:edit\/)?([\w-]+)/))) {
          ctx.entity_type = 'job';
          ctx.entity_id = m[1];
        } else if ((m = path.match(/\/clients\/(?:edit\/)?([\w-]+)/))) {
          ctx.entity_type = 'client';
          ctx.entity_id = m[1];
        }
      } catch (e) { /* best-effort */ }
    }

    return Object.keys(ctx).length ? ctx : null;
  }

  // History reads + clear always hit the v1 messages paths regardless
  // of which chat version is active. ai_messages is shared (same DB
  // rows whether v1 or v2 produced them), so there's no /v2/.../messages
  // route — re-using v1 avoids a duplicate route per agent and means
  // closing + reopening a job's chat panel always loads the prior
  // conversation, even when AGENT_MODE_86=agents.
  function messagesApiBase() {
    // Unified 86 — every surface reads from the same conversation
    // thread (entity_type='86' in ai_messages). One rolling history
    // across estimate / job / intake / client / admin / ask86.
    return '/api/ai/86';
  }

  // ── 86 (job-mode) Plan/Build phase ───────────────────────────────
  // Per-job, per-user state stored in localStorage. Default = 'plan' so
  // 86 starts as an analyst (no surprise mutations) — the PM grants
  // write access by approving a request_build_mode card or flipping
  // the phase pill manually.
  function getJobPhaseKey(jobId) { return 'p86-elle-phase-' + (jobId || ''); }
  function getJobAIPhase(jobId) {
    if (!jobId) return 'plan';
    try {
      var v = localStorage.getItem(getJobPhaseKey(jobId));
      return v === 'build' ? 'build' : 'plan';
    } catch (e) { return 'plan'; }
  }
  function setJobAIPhase(jobId, phase) {
    if (!jobId) return;
    var p = phase === 'build' ? 'build' : 'plan';
    try { localStorage.setItem(getJobPhaseKey(jobId), p); } catch (e) { /* private mode etc. */ }
    refreshModeSpecificUI();
  }

  // ────────────────────────────────────────────────────────────────────
  // Auto-render PDF pages for AG. PDFs without a text layer (scanned
  // RFPs, photo reports, drawing-only PDFs) are invisible to the
  // server-side text extractor, so AG would otherwise just see a
  // filename. We rasterize the first 6 pages client-side via PDF.js
  // and ship them as additional_images on every chat turn — vision
  // is dramatically better than no content at all.
  //
  // Rendered once per session, cached in _autoPdfCache. Fired in the
  // background when the panel opens so the cache is warm by the time
  // the user hits send.
  // ────────────────────────────────────────────────────────────────────

  // Async-safe: kicks off rendering for every PDF in the estimate that
  // lacks extracted_text. Records the in-flight promise per attachment
  // id so a concurrent gather can await the same promise instead of
  // racing a second render.
  function kickoffAutoPdfRender(estimateId) {
    if (!window.p86Api || !window.p86Api.attachments || !window.p86PdfRender) return;
    if (!estimateId) return;
    window.p86Api.attachments.list('estimate', estimateId)
      .then(function(resp) {
        var atts = (resp && resp.attachments) || [];
        atts.forEach(function(att) {
          if (!att) return;
          if (att.mime_type !== 'application/pdf') return;
          if (att.extracted_text && att.extracted_text.length > 0) return; // text-layer PDF, server-side already covers it
          if (_autoPdfCache[att.id] || _autoPdfPromises[att.id]) return;
          _autoPdfPromises[att.id] = window.p86PdfRender.renderForAI(att, 6, 1.5)
            .then(function(result) {
              _autoPdfCache[att.id] = {
                images: result.images,
                totalPages: result.totalPages,
                renderedPages: result.renderedPages,
                filename: att.filename
              };
              delete _autoPdfPromises[att.id];
              return _autoPdfCache[att.id];
            })
            .catch(function(err) {
              console.warn('[ai-panel] auto-PDF render failed for ' + att.filename + ':', err && err.message);
              delete _autoPdfPromises[att.id];
              // Stash an empty result so we don't keep retrying on every send.
              _autoPdfCache[att.id] = { images: [], totalPages: 0, renderedPages: 0, filename: att.filename };
              return _autoPdfCache[att.id];
            });
        });
      })
      .catch(function(err) {
        console.warn('[ai-panel] could not list attachments for auto-PDF render:', err && err.message);
      });
  }

  // Awaited by sendMessage right before posting. Resolves all in-flight
  // renders (if the user clicked send before kickoff finished) and
  // returns a flat, capped array of base64 image strings to ship as
  // additional_images. If the panel hasn't kicked off rendering for the
  // current estimate yet (e.g. AG opened without going through the
  // editor's Ask AI button), this triggers it now and waits.
  function gatherAutoPdfImages() {
    if (!isEstimateMode() || !_estimateId) return Promise.resolve([]);
    // If nothing has been kicked off yet, do it now and wait. Common when
    // the panel was opened via a non-editor entry point.
    if (!Object.keys(_autoPdfCache).length && !Object.keys(_autoPdfPromises).length) {
      kickoffAutoPdfRender(_estimateId);
    }
    var inFlight = Object.values(_autoPdfPromises);
    var settled = inFlight.length ? Promise.all(inFlight) : Promise.resolve([]);
    return settled.then(function() {
      var out = [];
      var entries = Object.keys(_autoPdfCache).map(function(k) { return _autoPdfCache[k]; });
      // Distribute the budget evenly so a single huge PDF doesn't crowd
      // out a small one. Round-robin pages across PDFs until the budget
      // is exhausted.
      var perPdf = entries.map(function(e) { return (e.images || []).slice(); });
      var idx = 0;
      while (out.length < _autoPdfBudget && perPdf.some(function(p) { return p.length; })) {
        var slot = perPdf[idx % perPdf.length];
        if (slot.length) out.push(slot.shift());
        idx++;
      }
      return out;
    });
  }

  // Preset prompts surfaced as quick-tap buttons. Different presets per
  // entity — estimates focus on scope/materials, jobs on margin/billing.
  var ESTIMATE_PRESETS = [
    { label: 'Draft scope from photos', prompt: 'Look at the photos attached and draft a tight, bulleted scope of work for this estimate. Focus on the work Project 86 would actually be doing.' },
    { label: "What am I missing?",      prompt: 'Review the estimate as it stands. What line items, prep work, or costs am I likely missing? Propose the additions as line items so I can approve them in batch.' },
    { label: 'Build my line items',     prompt: 'Propose the cost-side line items I should add for this scope. Use realistic Project 86 prices for Central Florida and slot each one under the right standard section. Make multiple parallel proposals so I can approve them in batch.' },
    { label: 'Tighten this estimate',   prompt: 'Audit my line items for duplicates, overlapping descriptions, lines that should be split into materials + labor, and lines under the wrong section. Propose updates / deletes / moves where you\'re confident.' },
    { label: 'Adjust margin',           prompt: 'I want this estimate at roughly 28% blended GP. Walk through each section and propose new section markup percentages to get there, calling out which lines drove the change.' }
  ];
  var JOB_PRESETS = [
    { label: 'Audit this job',        prompt: 'Run a full audit of this job. Walk through:\n1. **Node graph connectivity** — list any orphan or disconnected cost nodes, and any phases/buildings that should be wired but aren\'t.\n2. **Missing inputs** — phases without %complete set, buildings without phases, cost nodes without budgets.\n3. **Cost coverage** — compare the QB cost categories against the cost-side nodes in the graph. Call out QB categories with significant spend ($1K+) that don\'t have a matching node, and nodes that have no recorded actual costs.\n4. **Billing posture** — revenue earned vs invoiced; flag under-billing.\n5. **Margin** — as-sold vs revised vs JTD; flag drift > 2 points.\nFormat as a checklist grouped by severity (🔴 needs action, 🟡 worth checking, 🟢 looks fine). Be specific — include node labels, dollar amounts, and category names.' },
    { label: 'Health check',          prompt: 'Run a quick WIP health check on this job. Margin trend, cost-to-complete sanity, any red flags I should look at first.' },
    { label: 'Am I underbilled?',     prompt: 'Compare revenue earned vs. invoiced to date. Am I behind on billing? If so, by how much, and what should I send next?' },
    { label: 'Missing change orders?', prompt: 'Look at the cost lines vs. the original estimated costs. Anything that looks like out-of-scope work that should have been captured as a change order?' },
    { label: 'Margin drift',          prompt: 'Compare as-sold margin, revised margin, and JTD margin. Is the job drifting? What\'s driving the change?' },
    { label: 'Uncategorized QB costs', prompt: 'Look at the QuickBooks cost data. Which categories have significant spend that don\'t map cleanly to a node in the graph? Group by Distribution Account and tell me which I should create nodes for or assign to existing ones.' }
  ];
  var CLIENT_PRESETS = [
    { label: 'Run full audit',           prompt: 'Run a full audit of the customer directory. Work in this order, using your tools to actually fix things — do not just describe them:\n1. Split any flat clients whose name encodes both a parent management company and a property/community (e.g., "PAC - Solace Tampa", "Associa | Wimbledon Greens", names with " - ", " | ", " / " separators followed by a property name). Reuse existing parents (existing_parent_id) when they already exist in the directory.\n2. Link any unparented properties to their existing parent management company when the company_name field, address, or context makes it obvious.\n3. Merge clear duplicates (typo variants, "Inc."/"LLC" mismatches, same property_address, same CAM email).\n4. Normalize parent-company name spelling to the canonical form across all children.\n5. At the end, in chat, list ambiguous cases that need my judgment — do not act on them.\nChain auto-tier tools efficiently (no preamble), and group approval-tier proposals so I can bulk-approve them.' },
    { label: 'Find duplicates',          prompt: 'Scan the directory for likely duplicate clients (typo variants, abbreviations vs full names, same CAM/email on different rows, same property_address). For each pair you are confident about, propose a merge — pick the row with more data as keep. List ambiguous pairs in chat for me to decide.' },
    { label: 'Organize flat clients',    prompt: 'Look at the unparented entries. For each one, decide: (a) is the name a parent+property compound that needs split_client_into_parent_and_property? (b) does it match an existing parent\'s company_name and just need link_property_to_parent? (c) is it a legitimate top-level parent? Apply auto-tier fixes; propose splits for me to approve.' },
    { label: 'Audit incomplete records', prompt: 'Show me properties missing key fields (no CAM contact, no property_address, no parent linkage, no market). Group by what\'s missing so I can fill them in efficiently. If you can fill anything from context (e.g., copying market from siblings under the same parent), do it via update_client_field.' },
    { label: 'Add a property',           prompt: 'Walk me through adding a new property. Ask which parent management company first (search existing parents in the directory). Then collect property name, property_address, on-site CAM name + email + phone, market, and gate code if any. Use create_property to apply.' }
  ];
  var STAFF_PRESETS = [
    { label: 'How is 86 doing this week?',   prompt: 'Pull last 7d metrics for 86 and HR and tell me what stands out. Then surface the 3 most active conversations so I can spot-check.' },
    { label: 'Audit 86 search usage',        prompt: 'Of 86\'s recent conversations, how often did web_search get invoked? Pull a few examples and summarize what 86 was searching for. If a pattern emerges (e.g., the same product specs over and over), propose a new skill pack that bakes in the answer so 86 stops searching.' },
    { label: 'Audit & clean skill packs',    prompt: 'Read all skill packs. For each, tell me whether the wording is tight, whether it overlaps with another, and whether it\'s being applied to the right agents. If anything is stale, propose a skill_pack_edit or skill_pack_delete with rationale.' },
    { label: 'Most expensive conversations', prompt: 'Show me the 5 most token-expensive conversations in the last 30 days across all agents. For the top one, drill in and summarize what happened. If you spot a recurring waste pattern (e.g., 86 re-asking the same thing every turn), propose a skill pack that fixes it.' },
    { label: 'Where is HR being used?',      prompt: 'How is HR being used? Is it actually getting traction or is it sitting idle? Pull recent HR (entity_type=client) conversations and characterize the work. If a pattern emerges that could shift from per-turn instruction to a skill pack, propose it.' }
  ];
  // Ask 86 (global, no entity) — general-purpose prompts the user
  // might run from anywhere in the app. Deliberately broad: no
  // estimate-specific or job-specific presets here since this
  // surface has no entity attached. For per-entity work the user
  // opens that entity's AI panel.
  var ASK86_PRESETS = [
    { label: 'Look up a job number',  prompt: 'Look up [paste a job number or short name] in the live reference sheets and tell me everything we know about it — full QB name, client, address, status.' },
    { label: 'Search material price', prompt: 'Use web_search to find current pricing on [paste material / SKU]. Compare a couple of suppliers and tell me the typical Central-FL range.' },
    { label: 'WIP snapshot',          prompt: 'Pull the WIP report from the live reference sheets and summarize what\'s under contract right now — total value, top 5 jobs by remaining backlog, anything that looks behind schedule.' },
    { label: 'Brainstorm scope',      prompt: 'I\'m thinking through a [scope] at [property type / size / age]. Walk me through the line items, gotchas, and questions I should ask the property manager before I quote.' },
    { label: 'How does X work here?', prompt: 'Explain how [feature / process — e.g., "the node graph", "lead intake", "change orders"] works in Project 86. Reference the live reference sheets if relevant.' }
  ];
  function getActivePresets() {
    if (isJobMode())    return JOB_PRESETS;
    if (isClientMode()) return CLIENT_PRESETS;
    if (isStaffMode())  return STAFF_PRESETS;
    if (isAsk86Mode())  return ASK86_PRESETS;
    return ESTIMATE_PRESETS;
  }

  function escapeHTMLLocal(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Client context for Job mode ──────────────────────────────
  // Bundles the node-graph snapshot (localStorage) plus an aggregated
  // QB cost summary (parsed from workspace sheets named
  // "QB Costs YYYY-MM-DD") so 86 can reason about
  // wiring + uncategorized costs. Returns null if no useful data is
  // available — the server tolerates a missing clientContext.
  function buildJobClientContext() {
    var jobId = _entityId;
    if (!jobId) return null;
    var ctx = {};

    // Node graph
    try {
      var allGraphs = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
      var g = allGraphs[jobId];
      if (g && Array.isArray(g.nodes)) {
        ctx.nodeGraph = {
          nodes: g.nodes.map(function(n) {
            return {
              id: n.id, type: n.type, label: n.label,
              value: n.value, pctComplete: n.pctComplete,
              budget: n.budget, revenue: n.revenue,
              dataId: n.dataId, attachedTo: n.attachedTo
            };
          }),
          wires: (g.wires || []).map(function(w) {
            return { fromNode: w.fromNode, fromPort: w.fromPort, toNode: w.toNode, toPort: w.toPort };
          })
        };
      }
    } catch (e) { /* defensive */ }

    // QB cost data — Phase 2 made this server-persisted, so the
    // canonical source is appData.qbCostLines (hydrated from the
    // qb_cost_lines table on every login). Workspace "QB Costs"
    // sheets are now a secondary view, only used as a fallback if
    // no server lines exist for this job (e.g. a fresh browser
    // session that hasn't hydrated yet, or pre-Phase-2 data that
    // never made it to the server).
    try {
      var serverLines = (window.appData && Array.isArray(appData.qbCostLines))
        ? appData.qbCostLines.filter(function(l) {
            return (l.job_id || l.jobId) === jobId;
          })
        : [];

      var allLines = [];
      var mostRecent = '';
      var source = null;

      if (serverLines.length) {
        source = 'server';
        serverLines.forEach(function(l) {
          var amt = Number(l.amount || 0);
          if (!isFinite(amt) || amt === 0) return;
          var date = l.txn_date || l.date || '';
          if (typeof date === 'string' && date.length > 10) date = date.slice(0, 10);
          allLines.push({
            id: l.id || null,
            vendor: l.vendor || '',
            date: String(date || ''),
            amount: amt,
            account: l.account || '',
            klass: l.klass || '',
            memo: l.memo || '',
            linkedNodeId: l.linked_node_id || l.linkedNodeId || null
          });
          var rd = l.report_date || l.reportDate || '';
          if (typeof rd === 'string') {
            var rdNorm = rd.length > 10 ? rd.slice(0, 10) : rd;
            if (rdNorm > mostRecent) mostRecent = rdNorm;
          }
        });
      } else {
        // Fallback: parse the workspace sheets the same way Phase 1
        // did. Marked source='sheets' so the prompt can warn the AI
        // that the data is localStorage-only and may be partial.
        var allWs = JSON.parse(localStorage.getItem('p86-workspaces') || '{}');
        var wb = allWs[jobId];
        if (wb && Array.isArray(wb.sheets)) {
          var qbSheets = wb.sheets.filter(function(s) { return /^QB Costs /.test(s.name || ''); });
          if (qbSheets.length) {
            source = 'sheets';
            qbSheets.forEach(function(s) {
              var cells = s.cells || {};
              var headerCells = {};
              Object.keys(cells).forEach(function(k) {
                var m = k.match(/^(\d+),(\d+)$/);
                if (!m) return;
                var r = parseInt(m[1], 10), c = parseInt(m[2], 10);
                if (r === 3) headerCells[c] = String(cells[k].value || '').trim();
              });
              var col = {};
              Object.keys(headerCells).forEach(function(c) {
                var name = headerCells[c].toLowerCase();
                if (name === 'vendor') col.vendor = +c;
                else if (name === 'date') col.date = +c;
                else if (name === 'amount') col.amount = +c;
                else if (name === 'account') col.account = +c;
                else if (name === 'class') col.klass = +c;
                else if (name === 'memo') col.memo = +c;
              });
              var dateMatch = (s.name || '').match(/QB Costs (\d{4}-\d{2}-\d{2})/);
              if (dateMatch && dateMatch[1] > mostRecent) mostRecent = dateMatch[1];
              var rowKeys = {};
              Object.keys(cells).forEach(function(k) {
                var m = k.match(/^(\d+),(\d+)$/);
                if (!m) return;
                var r = parseInt(m[1], 10);
                if (r >= 4) rowKeys[r] = true;
              });
              Object.keys(rowKeys).forEach(function(r) {
                var ri = parseInt(r, 10);
                var cellAt = function(c) { var v = cells[ri + ',' + c]; return v ? v.value : null; };
                var amt = col.amount != null ? Number(cellAt(col.amount)) : 0;
                if (!isFinite(amt) || amt === 0) return;
                var labelCell = col.amount != null ? cells[ri + ',' + (col.amount - 1)] : null;
                if (labelCell && /^TOTAL$/i.test(String(labelCell.value || '').trim())) return;
                allLines.push({
                  vendor: col.vendor != null ? String(cellAt(col.vendor) || '') : '',
                  date: col.date != null ? String(cellAt(col.date) || '') : '',
                  amount: amt,
                  account: col.account != null ? String(cellAt(col.account) || '') : '',
                  klass: col.klass != null ? String(cellAt(col.klass) || '') : '',
                  memo: col.memo != null ? String(cellAt(col.memo) || '') : ''
                });
              });
            });
          }
        }
      }

      if (allLines.length) {
        var total = allLines.reduce(function(s, l) { return s + l.amount; }, 0);
        var byCategory = {};
        var unlinkedCount = 0;
        allLines.forEach(function(l) {
          var key = l.account || '(uncategorized)';
          byCategory[key] = (byCategory[key] || 0) + l.amount;
          if (!l.linkedNodeId) unlinkedCount++;
        });
        var samples = allLines.slice().sort(function(a, b) { return b.amount - a.amount; }).slice(0, 20);
        ctx.qbCosts = {
          source: source,
          total: total,
          byCategory: byCategory,
          lineCount: allLines.length,
          unlinkedCount: unlinkedCount,
          mostRecentImport: mostRecent || null,
          samples: samples
        };
      }
    } catch (e) { /* defensive */ }

    // Workspace sheets (the in-app spreadsheet). Includes anything the
    // user has typed — phase lists, scope notes, custom tables, etc.
    // We send a compact snapshot per sheet so the assistant can read
    // it and answer "what phases do I have in my workspace?" or
    // "extract the line items from sheet 2." QB Costs sheets are
    // skipped (their data already rolls up via ctx.qbCosts).
    try {
      var allWs2 = JSON.parse(localStorage.getItem('p86-workspaces') || '{}');
      var wb2 = allWs2[jobId];
      if (wb2 && Array.isArray(wb2.sheets)) {
        var nonQB = wb2.sheets.filter(function(s) { return !/^QB Costs /.test(s.name || ''); });
        if (nonQB.length) {
          // Index EVERY sheet by name first — even empty ones — so
          // the assistant can list available tabs and ask the user
          // which one to read. Without this, an AI suggestion to
          // "look at the bottom tab bar in your workspace" feels
          // useless when the assistant has the names right in scope.
          ctx.workspaceSheetIndex = nonQB.map(function(s) { return s.name || '(unnamed)'; });
          ctx.workspaceSheets = nonQB.slice(0, 5).map(function(s) {
            // Default preview: first 100 rows × 26 cols (A–Z). Covers
            // virtually every real-world Project 86 sheet. If something deeper
            // is needed, the assistant calls read_workspace_sheet_full
            // (an auto-applying read tool) to fetch the entire sheet
            // on demand without burning tokens preemptively.
            var cells = s.cells || {};
            var maxR = 0, maxC = 0;
            var trueMaxR = 0, trueMaxC = 0;
            var grid = {};
            Object.keys(cells).forEach(function(k) {
              var m = k.match(/^(\d+),(\d+)$/);
              if (!m) return;
              var r = parseInt(m[1], 10), c = parseInt(m[2], 10);
              var val = cells[k];
              if (val == null) return;
              var raw = (typeof val === 'object' && 'value' in val) ? val.value : val;
              if (raw == null || raw === '') return;
              if (r > trueMaxR) trueMaxR = r;
              if (c > trueMaxC) trueMaxC = c;
              if (r > 100 || c > 26) return; // outside preview window
              if (!grid[r]) grid[r] = {};
              grid[r][c] = String(raw);
              if (r > maxR) maxR = r;
              if (c > maxC) maxC = c;
            });
            // Render preview window as text table.
            var rows = [];
            for (var r = 0; r <= maxR; r++) {
              if (!grid[r]) continue;
              var parts = [];
              for (var c = 0; c <= maxC; c++) {
                if (grid[r][c] != null) {
                  var label = String.fromCharCode(65 + c);
                  parts.push(label + '=' + String(grid[r][c]).replace(/\s+/g, ' ').slice(0, 120));
                }
              }
              if (parts.length) rows.push((r + 1) + ': ' + parts.join(' · '));
            }
            var truncated = (trueMaxR > 100) || (trueMaxC > 26);
            return {
              name: s.name || '(unnamed)',
              cellCount: rows.length,
              preview: rows.join('\n'),
              totalRows: trueMaxR + 1,
              totalCols: trueMaxC + 1,
              truncated: truncated
            };
          });
          // Drop the heavy preview block when no sheet has content,
          // but keep the index so the assistant can still surface
          // sheet names.
          if (!ctx.workspaceSheets.some(function(s) { return s.cellCount > 0; })) {
            delete ctx.workspaceSheets;
          }
        }
      }
    } catch (e) { /* defensive */ }

    return (ctx.nodeGraph || ctx.qbCosts || ctx.workspaceSheets || (ctx.workspaceSheetIndex && ctx.workspaceSheetIndex.length)) ? ctx : null;
  }

  // Lightweight markdown — bold, italic, inline code, lists, paragraphs.
  // Safer than pulling in marked.js for this scale; trades feature breadth
  // for zero dependencies.
  function renderMarkdown(text) {
    if (!text) return '';
    var html = escapeHTMLLocal(text);
    // Code blocks (triple backtick)
    html = html.replace(/```([\s\S]*?)```/g, function(_, code) {
      return '<pre style="background:rgba(255,255,255,0.06);padding:8px 10px;border-radius:6px;overflow-x:auto;font-size:11px;font-family:SF Mono,Consolas,monospace;margin:6px 0;max-width:100%;box-sizing:border-box;">' + code.trim() + '</pre>';
    });
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-family:SF Mono,Consolas,monospace;font-size:0.9em;">$1</code>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // Bulleted lists — group consecutive lines starting with - or *
    var lines = html.split('\n');
    var out = [];
    var inList = false;
    lines.forEach(function(line) {
      var bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
      var numberedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
      // Headings — match #, ##, ### at line start. Keeps the model's
      // common "### Skill pack proposal" markdown from rendering as
      // raw `### Skill pack proposal` text, which on flex containers
      // can collapse to single-word-per-line when the browser
      // shrink-wraps the line.
      var headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (bulletMatch) {
        if (!inList) { out.push('<ul style="margin:6px 0;padding-left:20px;">'); inList = 'ul'; }
        out.push('<li>' + bulletMatch[1] + '</li>');
      } else if (numberedMatch) {
        if (!inList) { out.push('<ol style="margin:6px 0;padding-left:22px;">'); inList = 'ol'; }
        out.push('<li>' + numberedMatch[2] + '</li>');
      } else if (headingMatch) {
        if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        var level = headingMatch[1].length;
        // Sizes scale: h1 16px down to h3+ 13px. Bold + tighter
        // margins so headings read as section markers without
        // dominating the chat bubble.
        var sizes = { 1: 16, 2: 15, 3: 14, 4: 13, 5: 13, 6: 13 };
        out.push('<div style="font-weight:700;font-size:' + (sizes[level] || 13) + 'px;margin:8px 0 4px;color:var(--text,#fff);">' + headingMatch[2] + '</div>');
      } else {
        if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        if (line.trim()) out.push('<p style="margin:4px 0;">' + line + '</p>');
      }
    });
    if (inList) out.push(inList === 'ul' ? '</ul>' : '</ol>');
    var rendered = out.join('');
    // Auto-linkify bare URLs. Runs LAST so it doesn't re-wrap URLs the
    // model emitted as markdown links (which we don't currently parse
    // — future enhancement). Conservative regex: requires http(s)://
    // and stops at whitespace, closing punctuation, or angle bracket.
    // The negative lookbehind avoids re-wrapping anything already
    // inside an href= attribute (defensive — at this point our html
    // doesn't contain anchors yet, but cheap insurance).
    rendered = rendered.replace(
      /(^|[\s>("])((?:https?:\/\/)[^\s<>")]+)/g,
      function(_, prefix, url) {
        // Strip a single trailing punctuation char so "see https://x.com." renders cleanly.
        var trail = '';
        var m = url.match(/^(.*?)([.,;:!?)\]]+)$/);
        if (m) { url = m[1]; trail = m[2]; }
        return prefix +
          '<a href="' + url + '" target="_blank" rel="noopener" style="color:#4f8cff;text-decoration:underline;">' +
          url + '</a>' + trail;
      }
    );
    return rendered;
  }

  // ──────────────────────────────────────────────────────────────────
  // Panel DOM lazy-init. We create the side rail once on first open and
  // toggle visibility from there.
  // ──────────────────────────────────────────────────────────────────

  // Persist the user's preferred panel width across sessions. Min/max
  // protect against the user pulling it off-screen or shrinking past
  // a usable width — the chat UI breaks below ~320px.
  var AI_PANEL_WIDTH_KEY = 'p86-ai-panel-width';
  var AI_PANEL_WIDTH_MIN = 320;
  var AI_PANEL_WIDTH_MAX_FRAC = 0.92; // 92% of viewport width
  function loadAIPanelWidth() {
    try {
      var v = parseInt(localStorage.getItem(AI_PANEL_WIDTH_KEY), 10);
      if (Number.isFinite(v) && v >= AI_PANEL_WIDTH_MIN) return v;
    } catch (e) {}
    return 420; // default
  }
  function saveAIPanelWidth(px) {
    try { localStorage.setItem(AI_PANEL_WIDTH_KEY, String(px)); } catch (e) {}
  }
  function clampAIPanelWidth(px) {
    var max = Math.floor(window.innerWidth * AI_PANEL_WIDTH_MAX_FRAC);
    return Math.max(AI_PANEL_WIDTH_MIN, Math.min(max, px));
  }

  function ensurePanel() {
    var panel = document.getElementById('p86-ai-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'p86-ai-panel';
    // z-index 200 sits above the node graph (#nodeGraphTab z-index:99)
    // so 86 slides in over the graph rather than being
    // covered by it. Modals (.modal z:1000) still trump the panel.
    var initialWidth = clampAIPanelWidth(loadAIPanelWidth());
    panel.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:' + initialWidth + 'px;max-width:92vw;min-width:' + AI_PANEL_WIDTH_MIN + 'px;background:var(--surface,#0f0f1e);border-left:1px solid var(--border,#333);box-shadow:-4px 0 22px rgba(0,0,0,0.6);z-index:200;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.22s ease;';
    panel.innerHTML =
      // Left-edge resize grabber. Wider than it looks (12px hit area)
      // for easy targeting, but visually only a thin 2px line that
      // brightens on hover. While dragging we toggle a class that
      // disables the panel's slide transition so the resize feels
      // direct instead of laggy.
      '<div id="ai-panel-resizer" title="Drag to resize" aria-label="Resize panel" ' +
        'style="position:absolute;top:0;left:-6px;bottom:0;width:12px;cursor:ew-resize;z-index:1;display:flex;align-items:center;justify-content:center;">' +
        '<div style="width:2px;height:100%;background:rgba(79,140,255,0.18);transition:background 0.15s;"></div>' +
      '</div>' +
      // Header — close button is the most prominent control on the left
      // (mirrors a typical drawer/sidebar UX) so it's never missed.
      // Project 86-themed header — was old AGX dark green
      // (#0d1f12 → #14351d). Charcoal gradient with a thin cyan
       // hairline matches the main site header. Trimmed vertical
       // padding 12px → 7px so the header sits ~10px shorter.
      '<div style="padding:7px 14px;border-bottom:1px solid rgba(34,211,238,0.35);background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);display:flex;align-items:center;gap:10px;">' +
        '<button id="ai-close" title="Close (Esc)" style="background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;">&rarr; Close</button>' +
        '<div class="p86-ai-title" style="font-size:14px;font-weight:700;color:#fff;flex:1;text-align:right;">&#x2728; AI Assistant</div>' +
        // AG phase pill — single-icon dropdown. Visible only in estimate
        // mode. The visible icon reflects the active phase (📐 for Plan,
        // 🛠️ for Build); clicking opens a tiny popover with the *other*
        // option, so only one pill is on screen at any moment. Lives in
        // the panel header so the toggle is right next to AG\'s identity.
        '<div id="p86-ai-phase-pill" role="group" aria-label="AG phase" style="display:none;position:relative;">' +
          // Transparent button — no fill, no border. Hover gives a faint
          // overlay so the user knows it\'s clickable. The SVG icon uses
          // currentColor so it inherits the surrounding header\'s white
          // text color, and "active" mode is conveyed by full opacity.
          '<button id="p86-ai-phase-toggle" type="button" aria-haspopup="menu" aria-expanded="false" title="" ' +
            'style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:5px 9px;line-height:0;cursor:pointer;display:inline-flex;align-items:center;gap:5px;border-radius:6px;font-size:22px;transition:background 0.12s, border-color 0.12s;" ' +
            'onmouseenter="this.style.background=\'rgba(255,255,255,0.14)\'" ' +
            'onmouseleave="this.style.background=\'rgba(255,255,255,0.08)\'">' +
            '<span data-phase-icon style="display:inline-flex;align-items:center;"></span>' +
            '<span style="font-size:10px;opacity:0.7;line-height:1;">&#x25BE;</span>' +
          '</button>' +
          '<div id="p86-ai-phase-menu" role="menu" style="display:none;position:absolute;top:100%;right:0;margin-top:4px;background:#1a2230;border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:4px;font-size:12px;white-space:nowrap;z-index:10;box-shadow:0 6px 16px rgba(0,0,0,0.4);min-width:160px;">' +
            // Body filled in by refreshModeSpecificUI based on current phase.
          '</div>' +
        '</div>' +
        // Standalone trust gear — superseded by the trust section that
        // now lives inside the phase pill's Build-mode dropdown. Kept
        // in the DOM (display:none, never re-shown) so any code that
        // queries #ai-trust by id stays stable.
        '<button id="ai-trust" title="Trust settings (now in the phase pill dropdown)" style="display:none;">&#x2699;</button>' +
        '<button id="ai-clear" title="Clear conversation" style="background:rgba(255,255,255,0.08);color:#ccc;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;">Clear</button>' +
      '</div>' +
      // Notice strip
      '<div id="ai-notice" style="padding:8px 14px;background:rgba(79,140,255,0.08);border-bottom:1px solid var(--border,#333);font-size:11px;color:var(--text-dim,#aaa);">' +
        'Read-only — I see your estimate and photos but cannot change anything. Apply suggestions by hand.' +
      '</div>' +
      // Messages scroll area — dotted background for a Claude-style canvas feel.
      // overflow-x:hidden + min-width:0 are critical: without them, a
      // child with intrinsic min-content wider than the panel (e.g. a
      // <pre> overflow:auto block, or a long unbreakable token) makes
      // every flex child collapse to single-character width — the
      // browser tries to find a feasible layout and fails ugly.
      '<div id="ai-messages" style="flex:1;overflow-y:auto;overflow-x:hidden;min-width:0;padding:18px 18px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--text,#e6e6e6);background-image:radial-gradient(circle, rgba(255,140,80,0.18) 1px, transparent 1px);background-size:14px 14px;"></div>' +
      // Preset prompts
      '<div id="ai-presets" style="padding:8px 12px;border-top:1px solid var(--border,#333);display:flex;flex-wrap:wrap;gap:6px;background:rgba(255,255,255,0.02);"></div>' +
      // Input row. Photos are auto-included via the entity's attachments
      // and inline uploads via the + composer button — no separate toggle
      // needed.
      '<div style="padding:10px 12px 12px;border-top:1px solid var(--border,#333);background:var(--card-bg,#0c0c14);">' +
        // Pill-style input container — borderless textarea with attach,
        // camera, mic and send icons docked at the bottom-right. Grows
        // up as the user types so long prompts stay readable; capped at
        // 320px before internal scrolling (no visible scrollbar).
        '<div id="ai-input-pill" style="background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-radius:14px;padding:10px 12px 8px;transition:border-color 0.15s, background 0.15s;">' +
          '<div id="ai-attachments-strip" style="display:none;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>' +
          '<textarea id="ai-input" rows="1" placeholder="Ask anything about this estimate…" style="width:100%;resize:none;overflow-y:auto;min-height:22px;max-height:320px;background:transparent;border:none;outline:none;padding:0;color:var(--text,#fff);font-size:13px;line-height:1.5;font-family:inherit;box-sizing:border-box;display:block;"></textarea>' +
          // Toolbar — all action icons on the left, send on the right.
          // Buttons share a uniform compact style; circular hover-fill
          // gives a sleek Claude-style feel without per-button bespoke
          // styling. Send is the only one that's accent-colored at rest.
          '<div style="display:flex;align-items:center;gap:2px;margin-top:6px;">' +
            '<button id="ai-attach" type="button" title="Attach file (image or PDF)" aria-label="Attach file" class="ai-tool-btn" style="font-size:18px;">' + (typeof p86Icon === 'function' ? p86Icon('composer-attach') : '&#x002B;') + '</button>' +
            '<button id="ai-camera" type="button" title="Take a photo" aria-label="Take a photo" class="ai-tool-btn" style="font-size:18px;">' + (typeof p86Icon === 'function' ? p86Icon('composer-camera') : '&#x1F4F7;') + '</button>' +
            '<button id="ai-mic" type="button" title="Dictate (voice → text)" aria-label="Dictate" class="ai-tool-btn" style="font-size:18px;">' + (typeof p86Icon === 'function' ? p86Icon('composer-mic') : '&#x1F3A4;') + '</button>' +
            '<input id="ai-file-input" type="file" accept="image/*,application/pdf" multiple style="display:none;" />' +
            '<input id="ai-camera-input" type="file" accept="image/*" capture="environment" style="display:none;" />' +
            '<div style="flex:1;"></div>' +
            '<button id="ai-send" type="button" title="Send (Enter)" aria-label="Send" style="background:linear-gradient(135deg,#4f8cff,#34d399);border:0;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:15px;padding:0;transition:transform 0.12s, opacity 0.12s;">' + (typeof p86Icon === 'function' ? p86Icon('composer-send') : '&#x2191;') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    // Wire interactions
    panel.querySelector('#ai-close').onclick = close;
    panel.querySelector('#ai-clear').onclick = clearConversation;
    panel.querySelector('#ai-send').onclick = onSend;
    wireAIPanelResizer(panel);
    var trustBtn = panel.querySelector('#ai-trust');
    if (trustBtn) trustBtn.onclick = function(e) {
      e.stopPropagation();
      if (typeof window._p86AiPanelOpenTrust === 'function') {
        window._p86AiPanelOpenTrust(trustBtn);
      }
    };
    // AG phase dropdown — toggle on click; outside click closes the
    // popover. The body of the menu (single alternate option) is
    // populated inside refreshModeSpecificUI so it always reflects
    // the current phase.
    var phaseToggle = panel.querySelector('#p86-ai-phase-toggle');
    if (phaseToggle) {
      phaseToggle.onclick = function(e) {
        e.stopPropagation();
        var menu = panel.querySelector('#p86-ai-phase-menu');
        if (!menu) return;
        var isOpen = menu.style.display === 'block';
        if (isOpen) {
          menu.style.display = 'none';
          phaseToggle.setAttribute('aria-expanded', 'false');
        } else {
          menu.style.display = 'block';
          phaseToggle.setAttribute('aria-expanded', 'true');
        }
      };
    }
    document.addEventListener('click', function(e) {
      var menu = panel.querySelector('#p86-ai-phase-menu');
      var pillEl = panel.querySelector('#p86-ai-phase-pill');
      if (!menu || !pillEl) return;
      if (menu.style.display !== 'block') return;
      if (pillEl.contains(e.target)) return;
      menu.style.display = 'none';
      var t = panel.querySelector('#p86-ai-phase-toggle');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
    var input = panel.querySelector('#ai-input');
    var pill = panel.querySelector('#ai-input-pill');
    // Auto-grow: textarea expands as the user types, capped at max-height
    // (set in the inline style above). Reset to scrollHeight on each input.
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 320) + 'px';
    }
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });
    // Pill focus ring — gives visual feedback that the borderless textarea
    // is the active input target.
    input.addEventListener('focus', function() {
      if (pill) {
        pill.style.borderColor = 'rgba(79,140,255,0.5)';
        pill.style.background = 'rgba(255,255,255,0.06)';
      }
    });
    input.addEventListener('blur', function() {
      if (pill) {
        pill.style.borderColor = 'var(--border,#333)';
        pill.style.background = 'rgba(255,255,255,0.04)';
      }
    });
    setupVoiceInput(panel);
    setupFileAttachments(panel);

    // Initial preset render — refreshed on every open() to switch
    // between estimate and job preset sets when the entity changes.
    renderPresets();

    // Esc-to-close while focus is in the panel
    panel.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') close();
    });

    return panel;
  }

  // Bind drag-resize behavior to the panel's left-edge handle. The
  // panel sits flush-right (right:0), so dragging left = wider, drag
  // right = narrower. Width snaps within [320 .. 92vw]; pulled below
  // 320 it stays at 320, pulled past 92vw clamps so the panel can't
  // hide the close button. The handle's hit area is 12px wide for
  // easy targeting; the visible line is 2px and brightens during drag.
  function wireAIPanelResizer(panel) {
    var handle = panel.querySelector('#ai-panel-resizer');
    if (!handle) return;
    var line = handle.firstElementChild;
    var dragging = null;

    handle.addEventListener('mouseenter', function() {
      if (!dragging && line) line.style.background = 'rgba(79,140,255,0.55)';
    });
    handle.addEventListener('mouseleave', function() {
      if (!dragging && line) line.style.background = 'rgba(79,140,255,0.18)';
    });

    handle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dragging = {
        startX: e.clientX,
        startW: panel.getBoundingClientRect().width
      };
      // Disable the slide transition mid-drag so the panel tracks
      // the cursor 1:1; restore it after.
      panel.dataset._priorTransition = panel.style.transition || '';
      panel.style.transition = 'none';
      if (line) line.style.background = '#4f8cff';
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    function onMove(e) {
      if (!dragging) return;
      // Panel grows to the LEFT — moving cursor left should widen.
      var delta = dragging.startX - e.clientX;
      var w = clampAIPanelWidth(dragging.startW + delta);
      panel.style.width = w + 'px';
    }
    function onUp() {
      if (!dragging) return;
      var w = parseInt(panel.style.width, 10);
      if (Number.isFinite(w)) saveAIPanelWidth(w);
      panel.style.transition = panel.dataset._priorTransition || 'transform 0.22s ease';
      delete panel.dataset._priorTransition;
      if (line) line.style.background = 'rgba(79,140,255,0.18)';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      dragging = null;
    }

    // Re-clamp on viewport resize so a saved 1500px width doesn't
    // leave the panel wider than the new (smaller) screen.
    window.addEventListener('resize', function() {
      var cur = panel.getBoundingClientRect().width;
      var next = clampAIPanelWidth(cur);
      if (next !== cur) panel.style.width = next + 'px';
    });
  }

  // open() accepts either:
  //   open(estimateId)                       — legacy: opens for an estimate
  //   open({ entityType, entityId })         — explicit polymorphic form
  function open(arg) {
    var entityType, entityId;
    if (typeof arg === 'string') {
      entityType = 'estimate';
      entityId = arg;
    } else if (arg && typeof arg === 'object') {
      entityType = arg.entityType || 'estimate';
      entityId = arg.entityId;
    }
    // Client / staff / intake modes are global to the user — no entity
    // ID needed (the directory / agent observability surface / fresh
    // intake conversation IS the context). Other modes still require
    // an entity.
    var requiresEntity = entityType !== 'client' && entityType !== 'staff' && entityType !== 'intake' && entityType !== 'ask86';
    if (requiresEntity && !entityId) {
      alert('Save the ' + (entityType || 'record') + ' first to enable the AI assistant.');
      return;
    }
    if (!requiresEntity) entityId = '__global__';
    var panel = ensurePanel();
    // Lead-intake mode forces a fresh conversation EVERY open. The
    // server-side already archives any prior intake session on the
    // first /chat call; we mirror that on the client so any leftover
    // bubbles from a previous lead don't carry over visually.
    var forceReinit = entityType === 'intake';
    if (forceReinit || _entityId !== entityId || _entityType !== entityType) {
      _entityType = entityType;
      _entityId = entityId;
      _estimateId = entityType === 'estimate' ? entityId : null;
      _messages = [];
      // Drop the auto-PDF cache when switching entities so we don't
      // accidentally surface another estimate's renders.
      _autoPdfCache = {};
      _autoPdfPromises = {};
      // Intake = no history (fresh session every open). Other modes
      // load their conversation from ai_messages so close + reopen
      // keeps the thread.
      if (entityType === 'intake') {
        // Arm the start_new flag — first /chat after this open will
        // tell the server to archive the prior intake session and
        // create a brand-new one. Cleared after that first send so
        // subsequent turns reuse the session.
        _intakeFreshPending = true;
        renderMessages();
      } else {
        loadHistory();
      }
      // Fire-and-forget: pre-render scanned PDFs in the background so
      // the cache is warm by the time the user hits send. No awaits — if
      // the user types fast we'll catch the in-flight promise on send.
      if (_estimateId) kickoffAutoPdfRender(_estimateId);
    }
    // Slide the panel in lockstep with the body padding shift.
    // Force a layout commit on the off-screen state first (the initial
    // panel cssText sets transform:translateX(100%)) so the browser has
    // a starting frame to animate FROM. Without this, on first open
    // some browsers fold the create + open into one paint and the
    // panel pops in instantly while the body smoothly slides — feels
    // disconnected, like the panel and page aren't attached.
    void panel.offsetWidth; // force reflow on the off-screen state
    requestAnimationFrame(function() {
      panel.style.transform = 'translateX(0)';
      document.body.classList.add('p86-ai-open');
    });
    _open = true;
    // Photos toggle and proposal cards only make sense on the estimate
    // side. Hide / disable them when running against a job.
    refreshModeSpecificUI();
    setTimeout(function() {
      var inp = document.getElementById('ai-input');
      if (inp) inp.focus();
    }, 240);
  }

  function closeAIPhaseMenu() {
    var menu = document.getElementById('p86-ai-phase-menu');
    if (menu) menu.style.display = 'none';
    var toggle = document.getElementById('p86-ai-phase-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  function refreshModeSpecificUI() {
    var headerEl = document.querySelector('#p86-ai-panel .p86-ai-title');
    if (headerEl) {
      // Build title with an inline SVG icon when p86Icon is loaded;
      // gracefully fall back to the legacy emoji if not. The icon
      // span gets a small right-margin so the text reads cleanly.
      var hasIcons = typeof p86Icon === 'function';
      function withIcon(iconName, emojiFallback, text) {
        var ic = hasIcons
          ? '<span class="p86-icon" style="display:inline-flex;width:1em;height:1em;vertical-align:-0.15em;margin-right:6px;">' + p86Icon(iconName) + '</span>'
          : (emojiFallback + ' ');
        return ic + text;
      }
      if (isJobMode())            headerEl.innerHTML = withIcon('dna',       '📊', '86 · Lead Agent');
      else if (isClientMode())    headerEl.innerHTML = withIcon('chart-pie', '🤝', '86 · Client Directory');
      else if (isStaffMode())     headerEl.innerHTML = withIcon('briefcase', '🎩', '86 · Admin');
      else if (isIntakeMode())    headerEl.innerHTML = withIcon('dna',       '📊', '86 · Intake');
      else if (isAsk86Mode())     headerEl.innerHTML = withIcon('dna',       '🧬', 'Ask 86');
      else                        headerEl.innerHTML = withIcon('dna', '🎯', '86 · Estimator');
    }
    // Plan/Build pill — visible only in estimate mode. Single-icon
    // dropdown: visible icon shows active phase, click opens a popover
    // with the *other* option. Pulled fresh from the editor API so
    // flips mid-conversation update immediately when refreshPhaseChip()
    // fires from the editor side.
    var pill = document.getElementById('p86-ai-phase-pill');
    if (pill) {
      // Phase pill is dual-purpose now — visible in BOTH estimate (AG)
      // and job (Elle) mode. The visible icon and dropdown menu adapt
      // based on which agent owns the phase. Estimate mode reads/writes
      // the estimate's persisted aiPhase via estimateEditorAPI; job
      // mode reads/writes Elle's per-job phase from localStorage.
      var pillVisible = isEstimateMode() || isJobMode();
      if (pillVisible) {
        pill.style.display = 'inline-block';
        var phase, agentLabel, planDesc, buildDesc;
        if (isEstimateMode()) {
          phase = (window.estimateEditorAPI && window.estimateEditorAPI.getAIPhase)
            ? window.estimateEditorAPI.getAIPhase() : 'build';
          agentLabel = '86';
          planDesc = '86 discusses scope without proposing line items';
          buildDesc = '86 proposes line items + edits';
        } else {
          phase = getJobAIPhase(_entityId);
          agentLabel = '86';
          planDesc = '86 analyzes WIP without writing changes';
          buildDesc = 'Elle proposes edits to WIP, phases, and graph';
        }
        var toggleBtn = document.getElementById('p86-ai-phase-toggle');
        var iconEl = pill.querySelector('[data-phase-icon]');
        if (toggleBtn && iconEl) {
          iconEl.innerHTML = (typeof p86Icon === 'function')
            ? p86Icon(phase === 'plan' ? 'plan-mode' : 'build-mode')
            : (phase === 'plan' ? SVG_PLAN_ICON : SVG_BUILD_ICON);
          toggleBtn.title = phase === 'plan'
            ? 'Plan mode — ' + planDesc + '. Click to switch to Build.'
            : 'Build mode — ' + buildDesc + '. Click to switch to Plan.';
        }
        var menu = document.getElementById('p86-ai-phase-menu');
        if (menu) {
          var planSvg  = (typeof p86Icon === 'function') ? p86Icon('plan-mode')  : SVG_PLAN_ICON;
          var buildSvg = (typeof p86Icon === 'function') ? p86Icon('build-mode') : SVG_BUILD_ICON;
          var alt = phase === 'plan'
            ? { key: 'build', svg: buildSvg, label: 'Build', desc: buildDesc }
            : { key: 'plan',  svg: planSvg,  label: 'Plan',  desc: planDesc };
          // Trust toggles section — visible only in job mode + Build
          // phase. (Plan mode never auto-applies anything; estimate
          // mode has no trust toggles since AG only proposes
          // line-items, never silently mutates.) The trust map lives
          // in localStorage under p86-ai-trust:job, so changes here
          // persist across reloads.
          var trustSectionHtml = '';
          var showTrust = isJobMode() && phase === 'build';
          if (showTrust) {
            trustSectionHtml =
              '<div style="margin:6px 6px 4px;border-top:1px solid rgba(255,255,255,0.08);padding-top:8px;">' +
                '<div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.5px;padding:0 4px 4px;">Trust auto-apply</div>' +
                '<div style="font-size:10px;color:rgba(255,255,255,0.45);padding:0 4px 6px;line-height:1.35;white-space:normal;max-width:260px;">Trusted tools still show a card, but auto-apply after a 5s countdown. Cancel during the countdown to override.</div>' +
                TRUSTABLE_TOOLS.map(function(t) {
                  var on = isTrusted(t.name);
                  // Grid layout: auto column for the checkbox, 1fr for
                  // the label text. Grid handles long unbreakable text
                  // (e.g. "(t1/t2/cost-bucket/etc.)") cleanly — flex
                  // collapsed the text column to ~74px because the
                  // intrinsic min-width of the unbreakable token kept
                  // overflowing the row in flex layout.
                  return '<label style="display:grid;grid-template-columns:auto 1fr;align-items:start;column-gap:8px;padding:5px 6px;font-size:11px;color:#e6e6e6;cursor:pointer;border-radius:4px;line-height:1.4;" ' +
                    'onmouseenter="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
                    'onmouseleave="this.style.background=\'transparent\'">' +
                    '<input type="checkbox" data-trust-tool="' + t.name + '"' + (on ? ' checked' : '') + ' style="margin-top:2px;" />' +
                    '<span style="word-break:break-word;overflow-wrap:anywhere;">' + t.label + '</span>' +
                  '</label>';
                }).join('') +
              '</div>';
          }
          // Reset menu width: narrow for AG / plan mode, wider for the
          // trust toggles so the labels don't wrap awkwardly.
          menu.style.minWidth = showTrust ? '280px' : '160px';
          menu.style.whiteSpace = showTrust ? 'normal' : 'nowrap';
          menu.innerHTML =
            '<button type="button" data-ai-phase-pick="' + alt.key + '" ' +
              'style="display:flex;align-items:center;gap:10px;width:100%;background:transparent;border:none;color:#fff;padding:8px 10px;border-radius:6px;cursor:pointer;text-align:left;font-family:inherit;font-size:12px;box-sizing:border-box;" ' +
              'onmouseenter="this.style.background=\'rgba(255,255,255,0.08)\'" ' +
              'onmouseleave="this.style.background=\'transparent\'">' +
              '<span style="display:inline-flex;align-items:center;line-height:0;">' + alt.svg + '</span>' +
              '<span style="display:flex;flex-direction:column;gap:1px;">' +
                '<span style="font-weight:600;">Switch to ' + alt.label + '</span>' +
                '<span style="font-size:10px;color:rgba(255,255,255,0.55);font-weight:400;">' + alt.desc + '</span>' +
              '</span>' +
            '</button>' +
            trustSectionHtml;
          var pickBtn = menu.querySelector('[data-ai-phase-pick]');
          if (pickBtn) {
            pickBtn.onclick = function(e) {
              // Don't close-on-click for trust checkboxes inside the menu
              if (e.target && e.target.closest && e.target.closest('[data-trust-tool]')) return;
              var key = pickBtn.getAttribute('data-ai-phase-pick');
              if (isEstimateMode() && window.setEstimateAIPhase) {
                window.setEstimateAIPhase(key);
              } else if (isJobMode()) {
                setJobAIPhase(_entityId, key);
              }
              closeAIPhaseMenu();
            };
          }
          // Wire trust checkboxes — stop propagation so clicking a
          // checkbox doesn't bubble up and trigger the "Switch to X"
          // button's click handler.
          menu.querySelectorAll('input[data-trust-tool]').forEach(function(box) {
            box.addEventListener('click', function(e) { e.stopPropagation(); });
            box.addEventListener('change', function() {
              setTrusted(box.getAttribute('data-trust-tool'), box.checked);
            });
          });
        }
      } else {
        pill.style.display = 'none';
        closeAIPhaseMenu();
      }
    }
    // Trust toggles moved into the phase pill's Build-mode dropdown.
    // The standalone gear button stays in the DOM (so any code holding
    // a ref to #ai-trust keeps working) but is permanently hidden.
    var trustBtn = document.getElementById('ai-trust');
    if (trustBtn) trustBtn.style.display = 'none';
    var noticeEl = document.querySelector('#p86-ai-panel #ai-notice');
    if (noticeEl) {
      if (isJobMode()) noticeEl.textContent = 'I\'m 86 — Project 86\'s operator. Estimating, scope, line items, leads, WIP, margin, schedule, the node graph — I do all of it. HR keeps the rolodex (clients, jobs, subs, users) clean for me. I propose changes; you approve before they land.';
      else if (isClientMode()) noticeEl.textContent = 'Client directory mode — I can split parent+property compounds, link unparented properties, capture durable client notes, propose mutations. Same brain as everywhere else, scoped to your directory snapshot.';
      else if (isStaffMode()) noticeEl.textContent = 'Admin mode — I see cross-agent metrics, recent conversations, and your skill packs. I can propose skill-pack edits when a workflow should be standardized. Same brain as everywhere else, scoped to the admin snapshot.';
      else if (isIntakeMode()) noticeEl.textContent = 'New lead intake — I\'m 86. Tell me what the lead is (property name, scope, salesperson) and drop any photos. I\'ll dedupe against existing clients/leads, propose the new lead for your approval, and tee up the estimate.';
      else if (isAsk86Mode()) noticeEl.textContent = 'I\'m 86 — global mode. Ask me anything. I have web search, the live reference sheets, and can create leads / update clients / propose skill-pack changes inline. For per-line-item edits on a specific estimate or job, open that entity\'s AI panel.';
      else {
        // 86's notice changes wording in Plan mode so the user sees a
        // clear cue that 86 won't propose line items right now.
        var phaseN = (window.estimateEditorAPI && window.estimateEditorAPI.getAIPhase)
          ? window.estimateEditorAPI.getAIPhase() : 'build';
        if (phaseN === 'plan') {
          noticeEl.textContent = '🗺️ Plan mode — I\'ll think through scope with you and ask questions, but I won\'t propose line items until you flip to 🔨 Build.';
        } else {
          noticeEl.textContent = 'I\'m 86 — your operator. I draft scopes, add/edit/delete line items and sections, run pricing math, and pull from photos / catalogs / web search as needed. Every change shows as a card with Approve / Reject before it lands.';
        }
      }
    }
    var inputEl = document.getElementById('ai-input');
    if (inputEl) {
      if (isClientMode()) inputEl.placeholder = 'Describe a change, ask a question, or tap "Run full audit" below…';
      else if (isJobMode()) inputEl.placeholder = 'Ask anything about this job…';
      else if (isStaffMode()) inputEl.placeholder = 'Ask about agent usage, audit a conversation, review skill packs…';
      else if (isAsk86Mode()) inputEl.placeholder = 'Ask 86 anything — pricing, a job number, a process question, a search…';
      else inputEl.placeholder = 'Ask 86 to draft, edit, or clean up the estimate…';
    }
    renderPresets();
  }

  function renderPresets() {
    var presetWrap = document.getElementById('ai-presets');
    if (!presetWrap) return;
    presetWrap.innerHTML = '';
    getActivePresets().forEach(function(p) {
      var btn = document.createElement('button');
      btn.className = 'ee-btn ghost';
      btn.textContent = p.label;
      btn.onclick = function() {
        if (_streaming) return;
        var ta = document.getElementById('ai-input');
        if (ta) { ta.value = p.prompt; ta.focus(); }
      };
      presetWrap.appendChild(btn);
    });
  }

  function close() {
    var panel = document.getElementById('p86-ai-panel');
    if (panel) panel.style.transform = 'translateX(100%)';
    document.body.classList.remove('p86-ai-open');
    _open = false;
    if (_abortController) {
      try { _abortController.abort(); } catch (e) { /* ignore */ }
      _abortController = null;
    }
  }

  function toggle(estimateId) {
    if (_open) close();
    else open(estimateId);
  }

  // ──────────────────────────────────────────────────────────────────
  // Conversation rendering
  // ──────────────────────────────────────────────────────────────────

  function loadHistory() {
    if (!_entityId || !window.p86Api) return;
    var box = document.getElementById('ai-messages');
    if (box) box.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;">Loading…</div>';
    fetch(messagesApiBase() + '/messages', {
      headers: authHeaders()
    }).then(function(r) { return r.json(); }).then(function(res) {
      _messages = res.messages || [];
      renderMessages();
    }).catch(function() {
      _messages = [];
      renderMessages();
    });
  }

  function clearConversation() {
    if (!_entityId) return;
    var go = (typeof window.p86Confirm === 'function')
      ? window.p86Confirm({
          title: 'Clear conversation',
          message: 'Clear this conversation? Your messages on this ' + _entityType + ' will be deleted.',
          confirmLabel: 'Clear',
          danger: true
        })
      : Promise.resolve(window.confirm('Clear this conversation?'));
    go.then(function(ok) {
      if (!ok) return;
      fetch(messagesApiBase() + '/messages', {
        method: 'DELETE',
        headers: authHeaders()
      }).then(function() {
        _messages = [];
        renderMessages();
      }).catch(function(err) {
        if (typeof window.p86Alert === 'function') {
          window.p86Alert({ title: 'Clear failed', message: err.message || String(err) });
        } else {
          alert('Clear failed: ' + (err.message || err));
        }
      });
    });
  }

  function renderMessages() {
    var box = document.getElementById('ai-messages');
    if (!box) return;
    if (!_messages.length) {
      var hint;
      // Inline-icon helper so the hint text matches the agent
      // identity (dna glyph for 86) without falling back to emoji
      // glyphs that the page-wide swapper would otherwise replace
      // anyway.
      var hintIcon = function(name) {
        return (typeof p86Icon === 'function')
          ? '<span class="p86-icon" style="display:inline-flex;width:1em;height:1em;vertical-align:-0.15em;margin-right:6px;">' + p86Icon(name) + '</span>'
          : '';
      };
      if (isAsk86Mode()) hint = '<strong style="color:var(--text,#fff);">' + hintIcon('dna') + 'Ask 86</strong><br>Talk to 86 directly. I can create leads, update clients, audit conversations, push skill-pack changes, and search the web — and I have the live reference sheets (job numbers, WIP, etc.).<br><span style="font-size:11px;opacity:0.7;">For per-line edits on a specific estimate or job, open that entity\'s AI panel.</span>';
      else if (isJobMode()) hint = '<strong style="color:var(--text,#fff);">' + hintIcon('dna') + '86 · Lead Agent</strong><br>Pick a preset below or ask anything about this job.<br><span style="font-size:11px;opacity:0.7;">I see contract, costs, COs, %complete, billing — plus the node graph wiring and QuickBooks cost lines.</span>';
      else if (isClientMode()) hint = '<strong style="color:var(--text,#fff);">' + hintIcon('chart-pie') + '86 · Client Directory</strong><br>Tap <strong>Run full audit</strong> to clean up the directory in one pass — I\'ll split parent+property compounds, link unparented entries, merge dupes, and surface anything ambiguous for you.<br><span style="font-size:11px;opacity:0.7;">Hierarchy: parent management company → property/community → CAM contact.</span>';
      else if (isStaffMode()) hint = '<strong style="color:var(--text,#fff);">' + hintIcon('briefcase') + '86 · Admin</strong><br>Cross-agent metrics, recent conversations, skill-pack curation. Ask about usage patterns or propose skill-pack edits.<br><span style="font-size:11px;opacity:0.7;">Same brain as the rest of 86 — admin context just narrows the snapshot.</span>';
      else hint = '<strong style="color:var(--text,#fff);">' + hintIcon('dna') + '86 · Estimator</strong><br>Pick a preset or describe what you need. I can read the estimate, scope, client, and photos — and propose adds, edits, deletes, and pricing changes for you to approve.<br><span style="font-size:11px;opacity:0.7;">Try "tighten this estimate" or "build my line items".</span>';
      box.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:20px 0;text-align:center;line-height:1.6;">' + hint + '</div>';
      return;
    }
    var html = '';
    _messages.forEach(function(m) {
      html += renderBubble(m);
    });
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  // Message rendering — Claude-style:
  //  - User: small right-aligned bubble (rounded, subtle bg). Like a chat
  //    message — fast to read, clearly user-authored.
  //  - Assistant: unboxed, full-width markdown flow with a small cloud
  //    avatar on the left. Reads as long-form output rather than a
  //    chat reply.
  function renderBubble(m) {
    if (m.role === 'user') {
      var photoNote = m.photos_included
        ? '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;text-align:right;">' + m.photos_included + ' photo' + (m.photos_included === 1 ? '' : 's') + ' attached</div>'
        : '';
      return '<div style="display:flex;justify-content:flex-end;">' +
        '<div style="max-width:78%;background:rgba(255,255,255,0.08);color:var(--text,#fff);border-radius:14px;padding:8px 14px;font-size:13px;line-height:1.5;white-space:pre-wrap;">' +
          escapeHTMLLocal(m.content) +
          photoNote +
        '</div>' +
      '</div>';
    }
    // Stacked layout matches appendStreamingBubble — avatar + role
    // header on top, content takes full panel width below. See
    // appendStreamingBubble for why stacked beats avatar-beside-
    // content for this kind of free-form chat output.
    var usageFooter = '';
    if (m.usage) {
      var ut = formatUsage(m.usage);
      if (ut) {
        usageFooter = '<div style="margin-top:6px;font-size:10px;color:var(--text-dim,#666);opacity:0.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.2px;">' + escapeHTMLLocal(ut) + '</div>';
      }
    }
    return '<div style="width:100%;display:block;">' +
      '<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">' +
        '<span style="font-size:14px;line-height:1;">☁️</span>' +
      '</div>' +
      '<div class="ai-content" style="width:100%;overflow-x:hidden;font-size:13px;line-height:1.55;overflow-wrap:anywhere;word-break:normal;">' + renderMarkdown(m.content) + '</div>' +
      usageFooter +
    '</div>';
  }

  // Brain-yoga rotation — cycle the streaming bubble's caption every
  // few seconds so the user has continuous proof-of-life during long
  // turns (server-side compaction, auto-tier tool reads, model
  // thinking). Mix of generic playful phrases + a few that nod at the
  // agent's likely activities so it feels less like a screensaver.
  var BRAIN_YOGA_PHRASES = [
    'Doing brain yoga…',
    'Sharpening pencils…',
    'Reticulating splines…',
    'Consulting the manual…',
    'Sniffing around…',
    'Crunching numbers…',
    'Reading the room…',
    'Squinting at receipts…',
    'Poking the WIP…',
    'Triangulating…',
    'Asking the catalog…',
    'Cross-referencing…',
    'Counting twice, cutting once…',
    'Cracking knuckles…',
    'Re-reading the brief…',
    'Untangling wires…',
    'Whiteboarding…',
    'Rummaging in the toolbox…',
    'Doing the math…',
    'Stretching neurons…',
    'Lining things up…',
    'Tying loose ends…'
  ];
  // Tool name → friendlier verb fragment for the caption when a tool
  // is mid-flight. Used both for auto-tier (HR/CoS/AG read tools that
  // execute server-side and resume the stream) and for approval-tier
  // proposals (the moment the model emits the tool_use, before the
  // approval card lands). Falls back to the raw tool name when no
  // friendly verb is registered.
  var TOOL_VERBS = {
    // Built-in agent_toolset_20260401 tools (Anthropic runs them
    // server-side in the session container)
    web_search:                   'Searching the web…',
    web_fetch:                    'Fetching that page…',
    bash:                         'Running a script…',
    read:                         'Opening a file…',
    write:                        'Writing a file…',
    edit:                         'Editing a file…',
    glob:                         'Searching for files…',
    grep:                         'Searching file contents…',
    // Read tools (auto-execute server-side mid-stream)
    read_metrics:                 'Pulling metrics…',
    read_recent_conversations:    'Scanning conversations…',
    read_conversation_detail:     'Reading conversation…',
    read_skill_packs:             'Loading skill packs…',
    read_materials:               'Searching the catalog…',
    read_purchase_history:        'Checking purchase history…',
    read_subs:                    'Looking up subs…',
    read_lead_pipeline:           'Pulling the pipeline…',
    read_clients:                 'Reading the directory…',
    read_leads:                   'Reading leads…',
    read_past_estimates:          'Reading past estimates…',
    read_past_estimate_lines:     'Reading past line items…',
    read_workspace_sheet_full:    'Opening the sheet…',
    read_job_pct_audit:           'Auditing % complete…',
    read_jobs:                    'Looking up jobs…',
    read_users:                   'Looking up users…',
    read_existing_clients:        'Checking existing clients…',
    read_existing_leads:          'Checking existing leads…',
    read_field_tools:             'Checking existing tools…',
    load_skill_pack:              'Loading skill pack…',
    navigate:                     'Navigating…',
    propose_create_field_tool:    'Drafting field tool…',
    propose_update_field_tool:    'Editing field tool…',
    propose_delete_field_tool:    'Removing field tool…',
    // Estimate proposals (line items / sections / groups / scope / pricing)
    propose_add_line_item:        'Drafting line item…',
    propose_update_line_item:     'Drafting line edit…',
    propose_delete_line_item:     'Drafting line removal…',
    propose_bulk_update_lines:    'Drafting bulk edit…',
    propose_add_section:          'Drafting section…',
    propose_update_section:       'Drafting section edit…',
    propose_delete_section:       'Drafting section removal…',
    propose_add_group:            'Drafting new group…',
    propose_rename_group:         'Drafting group rename…',
    propose_delete_group:         'Drafting group removal…',
    propose_switch_active_group:  'Switching active group…',
    propose_toggle_group_include: 'Drafting group toggle…',
    propose_link_to_client:       'Drafting client link…',
    propose_link_to_lead:         'Drafting lead link…',
    propose_update_estimate_field:'Drafting estimate edit…',
    propose_add_client_note:      'Drafting client note…',
    // Job / 86 proposals
    set_phase_pct_complete:       'Drafting % complete update…',
    set_phase_field:              'Drafting phase edit…',
    set_phase_buildingId:         'Drafting phase relink…',
    request_build_mode:           'Requesting Build mode…',
    // Client / HR proposals
    create_parent_company:        'Drafting parent company…',
    rename_client:                'Drafting client rename…',
    change_property_parent:       'Drafting parent change…',
    merge_clients:                'Drafting client merge…',
    split_client_into_parent_and_property: 'Drafting client split…',
    delete_client:                'Drafting client deletion…',
    attach_business_card_to_client: 'Drafting business card attach…',
    add_client_note:              'Drafting client note…',
    // Staff / CoS proposals
    propose_skill_pack_add:       'Drafting skill pack…',
    propose_skill_pack_edit:      'Drafting skill pack edit…',
    propose_skill_pack_delete:    'Drafting skill pack removal…',
    // Phase 3 — sub-agent fan-out
    spawn_subtask:                'Spawning helper agent…',
    await_subtasks:               'Waiting on helper agents…',
    subtask_status:               'Checking helper status…',
    // Phase 4 — long-term memory
    remember:                     'Saving to memory…',
    recall:                       'Searching memory…',
    list_memories:                'Listing memories…',
    forget:                       'Archiving memory…',
    // Phase 5 — proactive watching
    propose_watch_create:         'Drafting new watch…',
    list_watches:                 'Listing watches…',
    read_recent_watch_runs:       'Reading watch runs…',
    propose_watch_archive:        'Drafting watch removal…'
  };

  function appendStreamingBubble() {
    var box = document.getElementById('ai-messages');
    if (!box) return null;
    var div = document.createElement('div');
    div.className = 'ai-streaming';
    // Stacked layout — avatar + role badge on top as a small header,
    // content takes the full panel width below. Same pattern Claude.ai
    // and ChatGPT use. Replaces the avatar-beside-content row, which
    // was fragile to deep-content min-content shenanigans (single-char
    // wraps, sibling-bubble overlaps) regardless of flex / grid choice
    // on the row. Block layout sidesteps all of that.
    div.style.cssText = 'width:100%;display:block;';
    var startPhrase = BRAIN_YOGA_PHRASES[Math.floor(Math.random() * BRAIN_YOGA_PHRASES.length)];
    div.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">' +
        '<span class="p86-cloud-anim" data-stream-cloud style="font-size:14px;line-height:1;">☁️</span>' +
        '<span data-stream-phrase class="p86-phrase" style="font-style:italic;">' + startPhrase + '</span>' +
      '</div>' +
      // Content lives in its own block at full panel width. overflow
      // safety pins remain so a long unbreakable string can\'t push
      // the panel wider than the parent.
      '<div class="ai-content" data-stream-content style="width:100%;overflow-x:hidden;font-size:13px;line-height:1.55;overflow-wrap:anywhere;word-break:normal;"></div>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  // Set / restore the brain-yoga rotation interval on a streaming
  // bubble. Returns a stop() handle the caller invokes on done/error.
  // override(text, sticky=false) lets callers set a tool-specific
  // caption (e.g. "Pulling metrics…") that pauses the rotation; when
  // sticky=false the rotation auto-resumes after one cycle.
  function startBrainYoga(streamDiv) {
    if (!streamDiv) return { stop: function() {}, override: function() {} };
    var phraseEl = streamDiv.querySelector('[data-stream-phrase]');
    if (!phraseEl) return { stop: function() {}, override: function() {} };
    var idx = Math.floor(Math.random() * BRAIN_YOGA_PHRASES.length);
    var paused = false;
    var iv = setInterval(function() {
      if (paused) return;
      idx = (idx + 1) % BRAIN_YOGA_PHRASES.length;
      // Re-trigger the fade animation by toggling the class.
      phraseEl.classList.remove('p86-phrase');
      // Force reflow so the animation can replay.
      void phraseEl.offsetWidth;
      phraseEl.textContent = BRAIN_YOGA_PHRASES[idx];
      phraseEl.classList.add('p86-phrase');
    }, 3500);
    return {
      stop: function() { clearInterval(iv); },
      override: function(text, sticky) {
        paused = !!sticky;
        phraseEl.classList.remove('p86-phrase');
        void phraseEl.offsetWidth;
        phraseEl.textContent = text;
        phraseEl.classList.add('p86-phrase');
        if (!sticky) {
          // Resume rotation after a short hold so the user can read it.
          setTimeout(function() { paused = false; }, 1500);
        }
      }
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Send / stream
  // ──────────────────────────────────────────────────────────────────

  function authHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) || localStorage.getItem('p86-auth-token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  }

  function onSend() {
    if (_streaming) return;
    var input = document.getElementById('ai-input');
    var text = (input && input.value || '').trim();
    if (!text) return;
    if (!_entityId) { alert('No ' + _entityType + ' is open.'); return; }
    // Stop dictation if the user clicked send mid-utterance. Without
    // this the recognition keeps running with a stale `baseValue`
    // pointing at the pre-send text, so the next interim result
    // echoes the just-sent message back into the input.
    _stopDictation();
    input.value = '';
    // Reset auto-grow height after clearing the value, so the textarea
    // collapses back to one row on submit instead of staying tall.
    input.style.height = 'auto';
    sendMessage(text);
  }

  // Per-user-turn safety net: count how many CONSECUTIVE round-trips
  // we've made where the only tool calls were auto-tier reads
  // (read_materials, read_purchase_history, etc.). If the model never
  // progresses to a propose_* or final text, abort the chain so it
  // can't loop forever. Reset on each new user message.
  var _autoHopCount = 0;
  var MAX_AUTO_HOPS = 8;

  function sendMessage(text) {
    _autoHopCount = 0;
    // Pull any base64 images from the composer chips (uploads or PDF
    // renders) for one-shot vision on this turn. The same images are
    // ALSO persisted to the entity's attachments via processFile, so
    // subsequent turns will see them via the system-prompt context.
    var composerImages = [];
    var composerNotes = [];
    _pendingComposer.forEach(function(e) {
      if (e.status !== 'ready') return;
      composerImages = composerImages.concat(e.base64Images || []);
      composerNotes.push((e.kind === 'pdf' ? 'PDF: ' : 'Image: ') + e.filename + (e.viewUrl ? ' [stored]' : ''));
    });

    var photoCount = countCurrentPhotos();
    var inlineImageCount = (_pendingImages && _pendingImages.images ? _pendingImages.images.length : 0) + composerImages.length;
    _messages.push({
      role: 'user', content: text,
      photos_included: (_includePhotos ? photoCount : 0) + inlineImageCount
    });
    renderMessages();
    var body = isEstimateMode()
      ? { message: text, includePhotos: _includePhotos }
      : { message: text };
    // Lead-intake: tell the server to archive the prior session ONLY
    // on the first message of this panel-open. Subsequent turns reuse
    // the session so the agent keeps full conversation context. The
    // flag lives on _intakeFreshPending which open() sets every time
    // the panel opens against entity_type='intake'.
    if (isIntakeMode() && _intakeFreshPending) {
      body.start_new = true;
      _intakeFreshPending = false;
    }
    // Job mode: send a snapshot of the node graph + an aggregated
    // QB cost summary so the assistant can reason about wiring and
    // uncategorized expenses. Both currently live client-side
    // (graph in localStorage, QB lines in workspace sheets); when
    // Phase 2 lands the server can pull them from DB and this
    // attachment becomes redundant.
    // Unified 86 — for every 86 surface (estimate / job / intake /
    // ask86), pack current_context so the server can build the same
    // per-turn snapshot the legacy per-entity endpoints used to
    // assemble. The session is shared per-user; the per-entity block
    // is a one-turn hint to 86 about which entity is open.
    if (isJobMode() || isEstimateMode() || isIntakeMode() || isAsk86Mode()) {
      var pageCtx = getCurrentPageContext() || {};
      // Pin the active entity even when the page-context heuristic
      // missed it (e.g. an estimate editor opened via deep link).
      if (isJobMode() || isEstimateMode()) {
        pageCtx.entity_type = _entityType;
        pageCtx.entity_id = _entityId;
      } else if (isIntakeMode()) {
        pageCtx.entity_type = 'intake';
      } else if (isAsk86Mode() && !pageCtx.entity_type) {
        // Ask 86 stays as-is from getCurrentPageContext (page name
        // only, or whatever entity is incidentally open).
      }
      if (isJobMode()) {
        var clientCtx = buildJobClientContext();
        if (clientCtx) pageCtx.clientContext = clientCtx;
        // Per-job plan/build phase — server uses it for both system
        // prompt shaping AND the tool gate (write tools off in plan).
        pageCtx.aiPhase = getJobAIPhase(_entityId);
      }
      body.current_context = pageCtx;
    }
    // Combine one-shot images: pre-existing handoff (PDF viewer) + composer.
    var bodyImages = [];
    if (_pendingImages && _pendingImages.images && _pendingImages.images.length) {
      bodyImages = bodyImages.concat(_pendingImages.images);
      _pendingImages = null;
    }
    if (composerImages.length) bodyImages = bodyImages.concat(composerImages);

    _pendingComposer = [];
    renderAttachmentsStrip();

    // Auto-rendered PDF page images. Gather AFTER the explicit images
    // (pdf-viewer handoff, composer paste) so those keep priority — the
    // user's explicit attachment outranks an auto-render of the same PDF.
    gatherAutoPdfImages().then(function(autoImages) {
      if (autoImages && autoImages.length) {
        // Cap the combined payload at 18 (Anthropic's per-request image
        // ceiling minus a small buffer), matching the prior behavior
        // for explicit images.
        bodyImages = bodyImages.concat(autoImages);
      }
      if (bodyImages.length) body.additional_images = bodyImages.slice(0, 18);
      streamFromEndpoint(apiBase() + '/chat', body);
    });
  }

  // Shared streaming runner — used by sendMessage (initial turn) and by
  // continueAfterProposals (tool-use continuation). Handles all SSE event
  // shapes: text deltas, tool_use proposals, awaiting_approval, errors,
  // and end-of-turn.
  function streamFromEndpoint(endpoint, body) {
    var streamDiv = appendStreamingBubble();
    var contentEl = streamDiv && streamDiv.querySelector('[data-stream-content]');
    var assistantText = '';
    var pendingToolUses = [];     // tool_use blocks captured this turn
    var pendingAssistantContent = null; // full content array for echo-back
    var brainYoga = startBrainYoga(streamDiv);
    var chipsAppended = 0; // tracks tool_applied/tool_failed/tool_rejected count
    var turnUsage = null;  // captured from `done` event; rendered as a dim footer
    // Phase 3b — subtask fan-out. Map of subtask_id → DOM card so
    // spawn_subtask renders the card once, and await_subtasks /
    // status reuse the existing element on resolution. pollCtx drives
    // the live-poll loop; stopped on terminal-all or abort.
    var subtaskCtx = { cards: {}, timer: null, stop: null };
    _streaming = true;
    setSendDisabled(true);

    _abortController = new AbortController();
    return fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: _abortController.signal
    }).then(function(r) {
      if (!r.ok) {
        return r.json().then(function(err) { throw new Error(err.error || 'HTTP ' + r.status); });
      }
      return readSSEStream(r, function(payload) {
        if (payload.delta) {
          assistantText += payload.delta;
          if (contentEl) contentEl.innerHTML = renderMarkdown(assistantText) +
            '<span style="display:inline-block;width:7px;height:13px;background:#34d399;margin-left:2px;animation:p86-blink 0.9s step-end infinite;"></span>';
          scrollToBottom();
        } else if (payload.tool_use) {
          pendingToolUses.push(payload.tool_use);
        } else if (payload.tool_started) {
          // v2 auto-tier tool kicked off server-side. Override the
          // brain-yoga caption with a tool-specific verb until the
          // matching tool_applied / tool_failed lands.
          var label = TOOL_VERBS[payload.tool_started.name] || (payload.tool_started.name + '…');
          brainYoga.override(label, true);
        } else if (payload.tool_applied) {
          // Phase 3b — subtask tools render a dedicated live-polling
          // card instead of the generic chip. spawn_subtask creates
          // the card; await_subtasks / subtask_status update the
          // matching cards in place using the resolved rows.
          var meta = payload.tool_applied.meta;
          if (meta && meta.kind === 'subtask_spawned' && meta.subtask_id) {
            appendSubtaskCard(streamDiv, meta.subtask_id, meta.title, subtaskCtx.cards);
            startSubtaskPolling(subtaskCtx);
            chipsAppended++;
            brainYoga.override('Got it. Thinking…', false);
            scrollToBottom();
            return; // skip the default chip render
          }
          if (meta && meta.kind === 'subtask_resolved' && Array.isArray(meta.subtask_ids)) {
            // Pull the freshly resolved rows so cards reflect the
            // final state without waiting for the next poll tick.
            fetch('/api/ai/subtasks?ids=' + encodeURIComponent(meta.subtask_ids.join(',')), {
              headers: authHeaders()
            }).then(function(r) { return r.ok ? r.json() : null; })
              .then(function(data) {
                if (!data || !Array.isArray(data.subtasks)) return;
                data.subtasks.forEach(function(row) {
                  var card = subtaskCtx.cards[row.id];
                  if (card) updateSubtaskCard(card, row);
                });
              }).catch(function() {});
            chipsAppended++;
            brainYoga.override('Got it. Thinking…', false);
            scrollToBottom();
            return;
          }
          // Server-side auto-tier tool already executed. Render inline
          // in Claude-Code style: small dim tool-invocation header,
          // output text collapsible if long. No card chrome.
          appendToolBlock(streamDiv, '▸', payload.tool_applied.name || 'tool',
            payload.tool_applied.summary || '', '#34d399');
          chipsAppended++;
          // Resume rotation once the tool lands.
          brainYoga.override('Got it. Thinking…', false);
          if (isClientMode() && typeof window.refreshClientsAfterAI === 'function') {
            window.refreshClientsAfterAI();
          }
          // Lead-intake success: propose_create_lead came back applied.
          // Refresh the leads list (so the new lead appears) and queue
          // a panel auto-close — the conversation is one-shot, no need
          // to keep it around once the lead is created.
          if (isIntakeMode() && payload.tool_applied.name === 'propose_create_lead') {
            if (typeof window.refreshLeadsAfterAI === 'function') {
              try { window.refreshLeadsAfterAI(); } catch (e) {}
            }
            // 4-second hold so the user sees the success chip + any
            // post-create text from the agent, then close.
            setTimeout(function() { if (typeof close === 'function') close(); }, 4000);
          }
          scrollToBottom();
        } else if (payload.tool_failed) {
          appendToolBlock(streamDiv, '✗', payload.tool_failed.name || 'tool',
            payload.tool_failed.error || 'failed', '#f87171');
          chipsAppended++;
          brainYoga.override('Hit a snag. Recovering…', false);
          scrollToBottom();
        } else if (payload.tool_rejected) {
          appendToolBlock(streamDiv, '⊘', payload.tool_rejected.name || 'tool',
            'rejected', '#a3a3a3');
          chipsAppended++;
          scrollToBottom();
        } else if (payload.awaiting_approval) {
          pendingAssistantContent = payload.pending_assistant_content;
          if (payload.usage) turnUsage = payload.usage;
        } else if (payload.done) {
          if (payload.usage) turnUsage = payload.usage;
          if (isClientMode() && typeof window.refreshClientsAfterAI === 'function') {
            window.refreshClientsAfterAI();
          }
        } else if (payload.error) {
          if (contentEl) contentEl.innerHTML = '<span style="color:#f87171;">' + escapeHTMLLocal(payload.error) + '</span>';
        }
      });
    }).then(function() {
      brainYoga.stop();
      _streaming = false;
      setSendDisabled(false);
      _abortController = null;

      if (pendingToolUses.length) {
        // Tool-use turn — render approval cards inline. The streamDiv
        // stays as the assistant bubble; cards get appended below the
        // text. No history persistence on this turn — the conversation
        // gets persisted only after the final text response of the
        // multi-step exchange.
        //
        // pendingAssistantContent is non-null on v1 (the server echoes
        // the assistant's full content array so /chat/continue can
        // replay it) and null on v2 (the Anthropic Session holds it
        // server-side; client doesn't need to echo). Either way, the
        // tool cards still need to render — earlier this gate also
        // required pendingAssistantContent which silently dropped v2
        // tool turns to "(no response)".
        finalizeProposalBubble(streamDiv, assistantText, pendingToolUses, pendingAssistantContent);
      } else if (assistantText) {
        // Plain text response — drop the streaming placeholder and add
        // a permanent bubble (history already persisted server-side).
        if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
        _messages.push({ role: 'assistant', content: assistantText, usage: turnUsage });
        renderMessages();
      } else if (chipsAppended > 0) {
        // No final narration but built-in tools (web_search /
        // web_fetch / etc.) DID fire — keep the streaming bubble in
        // place so the user can see the chips that already rendered.
        // Replace the rotating "Doing brain yoga…" caption with a
        // hint about what just happened. Don't push to _messages
        // history (no text to record); a follow-up turn will
        // continue from the session context naturally.
        var phraseEl = streamDiv && streamDiv.querySelector('[data-stream-phrase]');
        if (phraseEl) {
          phraseEl.textContent = 'Used ' + chipsAppended + ' tool' + (chipsAppended === 1 ? '' : 's') +
            ' but didn\'t produce a summary — ask again or rephrase.';
          phraseEl.style.fontStyle = 'normal';
          phraseEl.style.color = 'var(--text-dim,#888)';
        }
        var cloudEl = streamDiv && streamDiv.querySelector('[data-stream-cloud]');
        if (cloudEl) cloudEl.classList.remove('p86-cloud-anim');
        // Tools-only turn — attach usage footer to the live bubble that
        // sticks around so the user still sees token counts.
        if (turnUsage) {
          var contentEl2 = streamDiv && streamDiv.querySelector('[data-stream-content]');
          if (contentEl2) appendUsageFooter(contentEl2, turnUsage);
        }
      } else {
        // No text and no chips — true "(no response)" empty turn.
        if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
        _messages.push({ role: 'assistant', content: '(no response)' });
        renderMessages();
      }
    }).catch(function(err) {
      brainYoga.stop();
      _streaming = false;
      setSendDisabled(false);
      _abortController = null;
      if (err && err.name === 'AbortError') {
        if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
      } else {
        if (contentEl) contentEl.innerHTML = '<span style="color:#f87171;">Error: ' + escapeHTMLLocal(err.message || 'unknown') + '</span>';
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Approval cards — for each tool_use block from Claude, render a card
  // with Approve / Reject. When all are answered, continue the
  // conversation with /chat/continue passing the assembled tool_results.
  // ──────────────────────────────────────────────────────────────────
  // Read-only tools — no approval friction. The card is replaced by
  // a small "Reading…" chip; the tool runs immediately and feeds its
  // result back to the assistant via the same /chat/continue flow.
  // Auto-tier read tools — server emits these as tool_use, the panel
  // executes them inline (rendered as a small "Reading…" chip rather
  // than an approval card) and feeds the result back via /chat/continue
  // along with any user-approved propose_* tools.
  // read_materials is async: it hits /api/materials over the network,
  // unlike read_workspace_sheet_full which reads from localStorage.
  // The chip handler awaits the applier so both shapes work.
  // Tools that auto-apply on the client (render as a chip, run
  // immediately, feed the result back via /chat/continue without an
  // approval card). Pure reads + the client-side navigation action.
  // If a tool emits a side effect on data, it does NOT belong here.
  var AUTO_READ_TOOLS = {
    // 86's job-side reads
    read_workspace_sheet_full: true,
    read_qb_cost_lines: true,
    read_materials: true,
    read_purchase_history: true,
    read_subs: true,
    read_lead_pipeline: true,
    read_building_breakdown: true,
    read_job_pct_audit: true,
    // Estimate-side reads
    read_past_estimates: true,
    read_past_estimate_lines: true,
    // HR / cross-agent reads (now exposed on Ask 86 too)
    read_clients: true,
    read_leads: true,
    read_jobs: true,
    read_users: true,
    // CoS introspection reads
    read_metrics: true,
    read_recent_conversations: true,
    read_conversation_detail: true,
    read_skill_packs: true,
    load_skill_pack: true,
    // Intake dedup — fires before propose_create_lead so the model
    // can match the new lead against existing clients / leads.
    read_existing_clients: true,
    read_existing_leads: true,
    // Field tools listing — fires before propose_create_field_tool
    // so the model can check for duplicate names / see what exists.
    read_field_tools: true,
    // Navigation action — client-side DOM dispatch.
    navigate: true
  };

  function finalizeProposalBubble(streamDiv, assistantText, toolUses, pendingContent) {
    var contentEl = streamDiv && streamDiv.querySelector('[data-stream-content]');
    if (contentEl) contentEl.innerHTML = renderMarkdown(assistantText || '');

    var propContainer = document.createElement('div');
    // width:100% + box-sizing keeps the cards stretched across the
    // content column. Without an explicit width the flex parent
    // sometimes collapses to min-content (each word on its own line)
    // — most reliably reproduced when the assistant text contains a
    // bare `### heading` line, which our markdown renderer leaves as
    // raw text and the browser then wraps oddly inside the implicit
    // shrink-wrap context.
    propContainer.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;';
    // Append into the content column (not the streamDiv flex parent),
    // otherwise the proposal cards become a horizontal flex sibling
    // of the cloud avatar and the markdown text — which squashes the
    // markdown into a narrow column and overlaps the cards on top.
    (contentEl || streamDiv).appendChild(propContainer);

    var responses = [];
    var totalCount = toolUses.length;
    var bulkButtons = null;

    function answer(idx, approved, card) {
      var tu = toolUses[idx];
      var summary = '';
      var applyError = null;
      if (approved) {
        try {
          summary = applyTool(tu);
        } catch (e) {
          // Previously this branch alerted the user and silently
          // RETURNED without pushing a response into `responses[]`.
          // Effect: the server-side session stayed in requires_action
          // forever (one tool_use_id with no result), the next /86/chat
          // either hit stuck-session recovery or 400'd "waiting on
          // responses to events", and self_diagnose flagged the tool
          // as orphaned. Now we push an explicit is_error tool_result
          // back to the agent so it can adapt — typically by surfacing
          // the error to the user and trying a different approach.
          applyError = e && (e.message || String(e)) || 'apply failed';
          if (typeof window.p86Alert === 'function') {
            window.p86Alert({ title: 'Could not apply', message: applyError });
          }
          markCardDone(card, false, 'apply error: ' + applyError);
        }
      }
      // name + input are echoed back so the v2 (Sessions) /chat/continue
      // path can execute the tool server-side without needing
      // pending_assistant_content. v1 ignores these fields. apply_error
      // signals to the server that the client-side apply threw — server
      // converts that to an is_error=true tool_result so the agent sees
      // a real error rather than a user-driven rejection (different
      // remediation: retry vs. ask follow-up).
      var resp = { tool_use_id: tu.id, name: tu.name, input: tu.input, approved: approved && !applyError, applied_summary: summary };
      if (applyError) resp.apply_error = applyError;
      responses.push(resp);
      if (!applyError) markCardDone(card, approved, summary);

      // Refresh bulk-action button count
      if (bulkButtons) {
        var remaining = totalCount - responses.length;
        if (remaining <= 0) bulkButtons.remove();
        else bulkButtons.querySelector('[data-bulk-info]').textContent = remaining + ' awaiting review';
      }

      if (responses.length === totalCount) {
        continueAfterProposals(pendingContent, responses);
      }
    }

    // ── Trust countdown — for tool types the user has marked as
    //    "auto-apply." Card still renders so the user sees what
    //    happened, but a 5s countdown ticks down and applies on
    //    completion. Click Cancel during the countdown to fall
    //    back to manual approval.
    function attachTrustCountdown(card, idx, tu) {
      if (!isJobMode()) return;          // trust scoped to job tools only
      if (!isTrusted(tu.name)) return;
      var actionsRow = card.querySelector('[data-card-actions]');
      if (!actionsRow) return;
      actionsRow.innerHTML = '';
      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;font-size:11px;color:var(--text-dim,#aaa);';
      bar.innerHTML =
        '<span style="display:inline-block;padding:2px 8px;border-radius:9px;background:rgba(52,211,153,0.12);color:#34d399;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">&#x2713; Trusted</span>' +
        '<span data-countdown style="color:var(--text-dim,#888);">auto-applying in 5s…</span>' +
        '<button data-cancel class="ghost small" style="padding:4px 10px;font-size:10px;margin-left:auto;">Cancel &amp; review</button>';
      actionsRow.appendChild(bar);
      var seconds = 5;
      var iv = setInterval(function() {
        seconds--;
        var span = bar.querySelector('[data-countdown]');
        if (span) span.textContent = seconds > 0 ? 'auto-applying in ' + seconds + 's…' : 'applying…';
        if (seconds <= 0) {
          clearInterval(iv);
          answer(idx, true, card);
        }
      }, 1000);
      bar.querySelector('[data-cancel]').onclick = function() {
        clearInterval(iv);
        // Restore the manual buttons in the same shape renderProposalCard
        // emits, so the visual treatment stays consistent after cancel.
        actionsRow.innerHTML =
          '<button data-card-approve class="success small" style="padding:3px 12px;font-size:11px;font-weight:600;">&check; Approve</button>' +
          '<button data-card-reject class="ghost small" style="padding:3px 12px;font-size:11px;">&times; Reject</button>';
        actionsRow.querySelector('[data-card-approve]').onclick = function() { answer(idx, true, card); };
        actionsRow.querySelector('[data-card-reject]').onclick = function() { answer(idx, false, card); };
      };
    }

    // Bulk-action bar when there are 2+ proposals
    if (totalCount >= 2) {
      bulkButtons = document.createElement('div');
      bulkButtons.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(79,140,255,0.06);border:1px solid rgba(79,140,255,0.25);border-radius:8px;font-size:12px;color:var(--text,#fff);';
      bulkButtons.innerHTML =
        '<span style="font-size:14px;">&#x1F4DD;</span>' +
        '<span data-bulk-info style="font-weight:600;">' + totalCount + ' proposals awaiting review</span>' +
        '<button data-bulk-approve class="success small" style="padding:5px 12px;font-size:11px;font-weight:600;margin-left:auto;">&check; Approve all</button>' +
        '<button data-bulk-reject class="ghost small" style="padding:5px 12px;font-size:11px;">&times; Reject all</button>';
      propContainer.appendChild(bulkButtons);
      bulkButtons.querySelector('[data-bulk-approve]').onclick = function() {
        cards.forEach(function(card, i) {
          if (!isCardAnswered(card)) answer(i, true, card);
        });
      };
      bulkButtons.querySelector('[data-bulk-reject]').onclick = function() {
        cards.forEach(function(card, i) {
          if (!isCardAnswered(card)) answer(i, false, card);
        });
      };
    }

    // Group same-named proposals into a compact tile grid when 3+ of
    // the same tool come back in one batch (e.g. five identical
    // "Assign QB line" warnings stacking up). Tiles still expose the
    // same `[data-card-*]` selectors so answer/markCardDone work
    // unchanged. Maps tool name → grid container element so all
    // siblings drop into the same grid.
    var GROUP_THRESHOLD = 3;
    var GROUPABLE = { assign_qb_line: 1, set_node_value: 1, create_node: 1, wire_nodes: 1 };
    var nameCounts = {};
    toolUses.forEach(function(tu) { nameCounts[tu.name] = (nameCounts[tu.name] || 0) + 1; });
    var groupGrids = {};   // name -> grid div
    var groupHeaders = {}; // name -> header div (for count refresh + bulk buttons)
    function shouldGroup(tu) {
      return GROUPABLE[tu.name] && nameCounts[tu.name] >= GROUP_THRESHOLD;
    }
    function groupHeadingFor(name) {
      // Mirror the heading text used in renderProposalCard so the
      // grouped header reads the same as the individual cards would.
      switch (name) {
        case 'assign_qb_line':  return '&#x1F517; Assign QB line';
        case 'set_node_value':  return '&#x1F4B5; Set node value';
        case 'create_node':     return '&#x2795; Create node';
        case 'wire_nodes':      return '&#x1F50C; Wire nodes';
        default: return name;
      }
    }
    function ensureGroup(name) {
      if (groupGrids[name]) return groupGrids[name];
      var box = document.createElement('div');
      box.style.cssText = 'border:1px solid var(--border,#2e3346);border-left:3px solid #4f8cff;border-radius:6px;background:rgba(79,140,255,0.04);padding:8px 10px;display:flex;flex-direction:column;gap:8px;';
      var header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-dim,#aaa);flex-wrap:wrap;';
      header.innerHTML =
        '<span style="font-weight:700;color:#4f8cff;">' + groupHeadingFor(name) + '</span>' +
        '<span data-group-count style="background:rgba(79,140,255,0.18);color:#4f8cff;padding:1px 7px;border-radius:9px;font-weight:700;font-size:10px;">× ' + nameCounts[name] + '</span>' +
        '<button data-group-approve class="success small" style="padding:3px 10px;font-size:10px;margin-left:auto;">&check; Approve all</button>' +
        '<button data-group-reject class="ghost small" style="padding:3px 10px;font-size:10px;">&times; Reject all</button>';
      box.appendChild(header);
      var grid = document.createElement('div');
      // Tile grid — Google-apps-launcher style. Auto-fills as wide as
      // the panel allows; tiles wrap onto new rows. min 150px keeps the
      // smallest summary readable.
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;';
      box.appendChild(grid);
      propContainer.appendChild(box);
      groupGrids[name] = grid;
      groupHeaders[name] = header;
      return grid;
    }

    var cards = [];
    toolUses.forEach(function(tu, i) {
      // Read-only / auto-apply tools render as a tight chip and run
      // immediately. No approval card, no Trust countdown — the
      // result feeds back via /chat/continue with the rest.
      // applyTool may return a sync string OR a Promise<string>
      // (read_materials hits /api/materials over the network); both
      // shapes are handled by the Promise.resolve wrapper below.
      if (AUTO_READ_TOOLS[tu.name]) {
        var chipLabel = tu.input?.sheet_name || tu.name;
        var chip = document.createElement('div');
        chip.style.cssText = 'background:rgba(79,140,255,0.06);border:1px solid rgba(79,140,255,0.25);border-left:3px solid #4f8cff;border-radius:6px;padding:6px 10px;font-size:11px;color:var(--text-dim,#aaa);display:flex;align-items:center;gap:8px;';
        chip.innerHTML =
          '<span style="color:#4f8cff;font-weight:700;">📖</span>' +
          '<span data-chip-text style="flex:1;">Reading <strong>' + escapeHTMLLocal(chipLabel) + '</strong>…</span>';
        propContainer.appendChild(chip);
        cards.push(chip);
        Promise.resolve().then(function() { return applyTool(tu); })
          .then(function(summary) {
            var t = chip.querySelector('[data-chip-text]');
            if (t) t.innerHTML = '✓ Read <strong>' + escapeHTMLLocal(chipLabel) + '</strong>';
            chip.style.borderLeftColor = '#34d399';
            finishAutoRead(tu, summary);
          })
          .catch(function(e) {
            var summary = 'Read failed: ' + (e.message || String(e));
            var t2 = chip.querySelector('[data-chip-text]');
            if (t2) t2.textContent = summary;
            chip.style.borderLeftColor = '#f87171';
            finishAutoRead(tu, summary);
          });

        function finishAutoRead(tu, summary) {
          responses.push({ tool_use_id: tu.id, name: tu.name, input: tu.input, approved: true, applied_summary: summary });
          if (bulkButtons) {
            var remaining = totalCount - responses.length;
            if (remaining <= 0) bulkButtons.remove();
            else bulkButtons.querySelector('[data-bulk-info]').textContent = remaining + ' remaining';
          }
          if (responses.length === totalCount) {
            continueAfterProposals(pendingContent, responses);
          }
        }
        return; // skip the approval-card path entirely
      }
      var card;
      if (shouldGroup(tu)) {
        card = renderProposalTile(tu);
        ensureGroup(tu.name).appendChild(card);
      } else {
        card = renderProposalCard(tu);
        propContainer.appendChild(card);
      }
      card.querySelector('[data-card-approve]').onclick = function() { answer(i, true, card); };
      card.querySelector('[data-card-reject]').onclick = function() { answer(i, false, card); };
      cards.push(card);
      attachTrustCountdown(card, i, tu);
    });

    // Wire group-level Approve/Reject — fires answer() for every
    // pending tile in this group only. (The top-level "Approve all"
    // at totalCount level still applies across the whole batch.)
    Object.keys(groupHeaders).forEach(function(name) {
      var hdr = groupHeaders[name];
      function refreshGroupCount() {
        var span = hdr.querySelector('[data-group-count]');
        if (!span) return;
        var pending = 0;
        cards.forEach(function(c, j) {
          if (toolUses[j].name === name && !isCardAnswered(c)) pending++;
        });
        if (pending <= 0) {
          // Hide group buttons when nothing left to act on; keep the
          // header label so the user still sees what got done.
          var apr = hdr.querySelector('[data-group-approve]');
          var rjr = hdr.querySelector('[data-group-reject]');
          if (apr) apr.remove();
          if (rjr) rjr.remove();
          span.textContent = 'all answered';
        } else {
          span.textContent = pending + ' pending';
        }
      }
      hdr.querySelector('[data-group-approve]').onclick = function() {
        cards.forEach(function(c, j) {
          if (toolUses[j].name === name && !isCardAnswered(c)) answer(j, true, c);
        });
        refreshGroupCount();
      };
      hdr.querySelector('[data-group-reject]').onclick = function() {
        cards.forEach(function(c, j) {
          if (toolUses[j].name === name && !isCardAnswered(c)) answer(j, false, c);
        });
        refreshGroupCount();
      };
      // Update the count when tiles get answered individually too.
      groupGrids[name].addEventListener('click', function(e) {
        if (e.target.matches('[data-card-approve],[data-card-reject]')) {
          // Defer to after answer() runs (it removes the actions row).
          setTimeout(refreshGroupCount, 0);
        }
      });
    });
    scrollToBottom();
  }

  // ── Trust toggles ────────────────────────────────────────────
  // localStorage map of job-side tool names → true|false. Default
  // false (always preview). Toggle via the gear in the panel header.
  function isTrusted(toolName) {
    try {
      var raw = localStorage.getItem('p86-ai-trust:job') || '{}';
      var map = JSON.parse(raw);
      return !!map[toolName];
    } catch (e) { return false; }
  }
  function setTrusted(toolName, val) {
    try {
      var raw = localStorage.getItem('p86-ai-trust:job') || '{}';
      var map = JSON.parse(raw);
      if (val) map[toolName] = true; else delete map[toolName];
      localStorage.setItem('p86-ai-trust:job', JSON.stringify(map));
    } catch (e) {}
  }
  // The four job-side tools available for trust toggling, with friendly
  // labels for the popover.
  var TRUSTABLE_TOOLS = [
    { name: 'create_node',            label: 'Create a new graph node (t1/t2/cost-bucket/etc.)' },
    { name: 'delete_node',            label: 'Remove a graph node + its wires (data preserved)' },
    { name: 'set_phase_pct_complete', label: 'Set phase % complete' },
    { name: 'set_phase_field',        label: 'Set phase $ field (materials/labor/sub/equip)' },
    { name: 'set_node_value',         label: 'Set cost node value (mat/labor/gc/other/sub)' },
    { name: 'wire_nodes',             label: 'Wire two graph nodes' },
    { name: 'assign_qb_line',         label: 'Assign QB line to a node' }
  ];

  function openTrustPopover(anchorBtn) {
    var existing = document.getElementById('p86-ai-trust-popover');
    if (existing) { existing.remove(); return; }
    var pop = document.createElement('div');
    pop.id = 'p86-ai-trust-popover';
    var rect = anchorBtn.getBoundingClientRect();
    pop.style.cssText =
      'position:fixed;top:' + (rect.bottom + 4) + 'px;right:' + Math.max(8, window.innerWidth - rect.right) + 'px;' +
      'background:var(--surface,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.6);padding:10px 12px;z-index:1100;width:300px;';
    pop.innerHTML =
      '<div style="font-size:11px;font-weight:700;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Trust auto-apply</div>' +
      '<div style="font-size:11px;color:var(--text-dim,#888);margin-bottom:8px;line-height:1.4;">Trusted tools still show a card, but auto-apply after a 5s countdown. Cancel &amp; review during the countdown to override.</div>' +
      TRUSTABLE_TOOLS.map(function(t) {
        var on = isTrusted(t.name);
        return '<label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px;color:var(--text,#e6e6e6);cursor:pointer;">' +
          '<input type="checkbox" data-tool="' + t.name + '"' + (on ? ' checked' : '') + ' />' +
          '<span>' + t.label + '</span>' +
        '</label>';
      }).join('');
    document.body.appendChild(pop);
    pop.querySelectorAll('input[data-tool]').forEach(function(box) {
      box.addEventListener('change', function() {
        setTrusted(box.getAttribute('data-tool'), box.checked);
      });
    });
    // Click-outside dismiss
    setTimeout(function() {
      document.addEventListener('click', function dismissOnce(e) {
        if (pop.contains(e.target) || anchorBtn.contains(e.target)) return;
        pop.remove();
        document.removeEventListener('click', dismissOnce);
      });
    }, 0);
  }
  // Public for the panel header button
  window._p86AiPanelOpenTrust = openTrustPopover;

  // Navigation tool — purely client-side DOM dispatch. The model
  // emits a `navigate` tool_use; we route to the right top-level
  // switchTab / sub-tab / entity-open helper and return a summary
  // string that gets fed back to the model as the tool_result. No
  // server round-trip; the server never sees this executor.
  function _navigate(input) {
    input = input || {};
    var dest = String(input.destination || '').toLowerCase();
    var entityId = input.entity_id || null;
    function go(top) { if (typeof window.switchTab === 'function') window.switchTab(top); }
    function sub(name) { if (typeof window.switchEstimatesSubTab === 'function') window.switchEstimatesSubTab(name); }
    function mark(v) { if (typeof window.markVirtualTabActive === 'function') window.markVirtualTabActive(v); }
    switch (dest) {
      case 'home':
      case 'summary':
        go('summary');
        return 'Navigated to the home dashboard.';
      case 'leads':
        go('estimates'); sub('leads'); mark('leads');
        return 'Switched to the Leads list.';
      case 'estimates':
        go('estimates'); sub('list'); mark('estimates');
        return 'Switched to the Estimates list.';
      case 'clients':
        go('estimates'); sub('clients'); mark('clients');
        return 'Switched to the Clients directory.';
      case 'subs':
        go('estimates'); sub('subs'); mark('subs');
        return 'Switched to the Subs directory.';
      case 'schedule': go('schedule'); return 'Switched to the Schedule.';
      case 'wip':      go('wip');      return 'Switched to the WIP list.';
      case 'insights': go('insights'); return 'Switched to Insights.';
      case 'tools':
        // Field tools live inside My Files as a virtual "Tools"
        // folder. Switch to the my-files tab, then ask my-files to
        // activate the Tools section.
        go('my-files');
        try {
          if (window.myFiles && typeof window.myFiles.selectFolder === 'function') {
            window.myFiles.selectFolder('__tools__');
          }
        } catch (e) {}
        return 'Switched to Field Tools.';
      case 'admin':    go('admin');    return 'Switched to Admin.';
      case 'job':
        if (!entityId) return 'navigate: entity_id is required for destination=job.';
        go('wip');
        if (typeof window.editJob === 'function') window.editJob(entityId);
        return 'Opened job ' + entityId + '.';
      case 'estimate':
        if (!entityId) return 'navigate: entity_id is required for destination=estimate.';
        go('estimates'); sub('list'); mark('estimates');
        if (typeof window.editEstimate === 'function') window.editEstimate(entityId);
        return 'Opened estimate ' + entityId + '.';
      case 'lead':
        if (!entityId) return 'navigate: entity_id is required for destination=lead.';
        go('estimates'); sub('leads'); mark('leads');
        if (typeof window.openEditLeadModal === 'function') window.openEditLeadModal(entityId);
        return 'Opened lead ' + entityId + '.';
      default:
        return 'navigate: unknown destination "' + dest + '". Valid destinations: home, leads, estimates, clients, subs, schedule, wip, insights, admin, job, estimate, lead.';
    }
  }

  // Estimate-side propose_* tools — these are NOT auto-applied by
  // the server; the client has to mutate the open estimate editor's
  // blob directly via estimateEditorAPI. Used to detect when a tool
  // approved from the Ask 86 surface should fall through to the
  // estimate dispatcher (below) rather than no-op'ing.
  var ESTIMATE_SIDE_PROPOSE_TOOLS = {
    propose_add_line_item: true,
    propose_add_section: true,
    propose_update_scope: true,
    propose_delete_line_item: true,
    propose_update_line_item: true,
    propose_delete_section: true,
    propose_update_section: true,
    propose_switch_active_group: true,
    propose_add_group: true,
    propose_rename_group: true,
    propose_delete_group: true,
    propose_toggle_group_include: true,
    propose_link_to_client: true,
    propose_link_to_lead: true,
    propose_update_estimate_field: true,
    propose_bulk_update_lines: true,
    propose_bulk_delete_lines: true
  };

  function applyTool(tu) {
    // Navigation is a pure client-side side effect — handle before
    // entity-mode dispatch so it works the same from Ask 86, job,
    // estimate, intake, etc. The return string flows back as the
    // tool_result via the regular auto-apply chip handler.
    if (tu.name === 'navigate') {
      return Promise.resolve(_navigate(tu.input));
    }
    if (isClientMode() || isStaffMode() || isIntakeMode() || isAsk86Mode()) {
      // Ask 86 special-case: when the user has the estimate editor
      // open and 86 proposes a line-item / section / group edit, the
      // approval has to mutate the editor blob client-side — the
      // server doesn't auto-apply these tools the way it does
      // propose_create_lead. Detect that and fall through to the
      // estimate dispatcher below.
      if (isAsk86Mode()
          && ESTIMATE_SIDE_PROPOSE_TOOLS[tu.name]
          && window.estimateEditorAPI
          && typeof window.estimateEditorAPI.applyAddLineItem === 'function') {
        // Fall through — the switch below uses estimateEditorAPI which
        // operates on whatever estimate is currently loaded in the
        // editor, so we don't need _estimateId tracked in ask86 mode.
      } else {
        // Server applies these tools on /chat/continue. Just signal
        // approval — there's no client-side mutation to perform.
        // - Intake & Ask 86: propose_create_lead runs via
        //   execProposeCreateLead on the matching /chat/continue.
        // - Ask 86: also dispatches HR client mutations
        //   (create_property, update_client_field, etc.) through
        //   execClientToolWithCtx in /ask86/chat/continue.
        // - Client mode (HR) + Staff (CoS): same shape.
        return '';
      }
    }
    if (isJobMode()) {
      return applyJobTool(tu);
    }
    // Auto-tier read tools that hit the server-side /api/ai/exec-tool
    // endpoint. None of these need the estimate editor open — they\'re
    // pure data lookups against the Project 86 database. Handled before the
    // editor checks so AG can run them from any context.
    if (SERVER_AUTO_TIER_TOOLS[tu.name]) {
      return execAutoTierTool(tu.name, tu.input || {});
    }
    if (!window.estimateEditorAPI) {
      throw new Error('Estimate editor not loaded — refresh the page.');
    }
    // In ask86 mode, _estimateId is null (the global widget doesn't
    // track a specific estimate). Verify *some* estimate is open
    // instead — the apply* methods operate on whichever estimate is
    // currently loaded in the editor.
    if (isAsk86Mode()) {
      var openId = typeof window.estimateEditorAPI.getOpenId === 'function'
        ? window.estimateEditorAPI.getOpenId()
        : null;
      if (!openId) {
        throw new Error('Open the estimate in the editor before approving changes.');
      }
    } else if (!window.estimateEditorAPI.isOpenFor(_estimateId)) {
      throw new Error('Open the estimate in the editor before approving changes.');
    }
    switch (tu.name) {
      case 'propose_add_line_item':    return window.estimateEditorAPI.applyAddLineItem(tu.input);
      case 'propose_add_section':      return window.estimateEditorAPI.applyAddSection(tu.input);
      case 'propose_update_scope':     return window.estimateEditorAPI.applyUpdateScope(tu.input);
      case 'propose_delete_line_item': return window.estimateEditorAPI.applyDeleteLine(tu.input);
      case 'propose_update_line_item': return window.estimateEditorAPI.applyUpdateLine(tu.input);
      case 'propose_delete_section':   return window.estimateEditorAPI.applyDeleteSection(tu.input);
      case 'propose_update_section':   return window.estimateEditorAPI.applyUpdateSection(tu.input);
      case 'propose_add_client_note':  return applyAddClientNote(tu.input);
      // Group / alternate management
      case 'propose_switch_active_group': return window.estimateEditorAPI.applySwitchActiveGroup(tu.input);
      case 'propose_add_group':           return window.estimateEditorAPI.applyAddGroup(tu.input);
      case 'propose_rename_group':        return window.estimateEditorAPI.applyRenameGroup(tu.input);
      case 'propose_delete_group':        return window.estimateEditorAPI.applyDeleteGroup(tu.input);
      case 'propose_toggle_group_include':return window.estimateEditorAPI.applyToggleGroupInclude(tu.input);
      // Linking + metadata
      case 'propose_link_to_client':      return window.estimateEditorAPI.applyLinkToClient(tu.input);
      case 'propose_link_to_lead':        return window.estimateEditorAPI.applyLinkToLead(tu.input);
      case 'propose_update_estimate_field': return window.estimateEditorAPI.applyUpdateEstimateField(tu.input);
      // Bulk line operations
      case 'propose_bulk_update_lines':   return window.estimateEditorAPI.applyBulkUpdateLines(tu.input);
      case 'propose_bulk_delete_lines':   return window.estimateEditorAPI.applyBulkDeleteLines(tu.input);
      default: throw new Error('Unknown tool: ' + tu.name);
    }
  }

  // AG\'s auto-tier read tools that hit the unified server-side
  // executor at /api/ai/exec-tool. The server formats the result
  // (same code path the chief of staff uses) and returns a string;
  // we pass it straight back as the tool_result so the model sees
  // identical output regardless of which agent invokes the tool.
  var SERVER_AUTO_TIER_TOOLS = {
    read_materials: true,
    read_purchase_history: true,
    read_subs: true,
    read_lead_pipeline: true,
    read_clients: true,
    read_leads: true,
    read_past_estimate_lines: true,
    read_past_estimates: true,
    // Cross-agent reads (CoS introspection + HR directory lookups) —
    // server routes them to execStaffTool / execClientTool as needed.
    read_metrics: true,
    read_recent_conversations: true,
    read_conversation_detail: true,
    read_skill_packs: true,
    read_jobs: true,
    read_users: true,
    load_skill_pack: true,
    // Intake dedup lookups — pure reads of existing clients/leads to
    // help the model spot duplicates before creating a new record.
    read_existing_clients: true,
    read_existing_leads: true,
    // Field tools index — pure read, server dispatches to
    // execFieldToolRead via FIELD_TOOLS_EXECUTOR_TOOLS in /exec-tool.
    read_field_tools: true,
    // Self-diagnosis — when 86 calls this, server pulls his own
    // recent proposals + cross-checks the live estimate state.
    // Chip-style so the user sees one inline summary instead of an
    // approval card for a pure read.
    self_diagnose: true,
    // Lazy attachment body fetch — manifest now ships preview only,
    // 86 pulls full body via this when he actually needs to quote.
    read_attachment_text: true,
    // Lazy line-item detail — turn_context shows compact roll-ups for
    // estimates with >12 cost-side lines; 86 calls this for full
    // line_ids when proposing edits.
    read_active_lines: true
  };
  function execAutoTierTool(name, input) {
    return window.p86Api.post('/api/ai/exec-tool', { name: name, input: input || {} })
      .then(function(resp) {
        if (resp && typeof resp.summary === 'string') return resp.summary;
        return '(empty result)';
      });
  }

  // propose_add_client_note — POSTs to the linked client's notes endpoint.
  // Reads the linked client_id off the editor's open estimate so the AG
  // agent doesn't have to know it. Errors surface back as tool_result
  // is_error so the model can apologize / retry.
  async function applyAddClientNote(input) {
    if (!window.estimateEditorAPI || !window.estimateEditorAPI.getLinkedClientId) {
      throw new Error('Estimate editor API not ready.');
    }
    var clientId = window.estimateEditorAPI.getLinkedClientId();
    if (!clientId) throw new Error('This estimate is not linked to a client — link a client first, then add the note.');
    var body = (input && input.body || '').trim();
    if (!body) throw new Error('Note body is empty.');
    await window.p86Api.clients.addNote(clientId, body, 'job');
    return 'Saved note on linked client: "' + body.slice(0, 80) + (body.length > 80 ? '…' : '') + '"';
  }

  // Resolve a t1 (building) graph node to its underlying building
  // record. Tries three approaches in order:
  //   1. Explicit buildingId field on the node (newer graphs).
  //   2. Node id directly matches a building record id — this is the
  //      case for graph-created t1 nodes where engine.js uses the
  //      same id for both the node and the building.
  //   3. Label match (case-insensitive, exact then contains either
  //      direction) against the job's building names — handles older
  //      graphs where the t1 nodes were imported with arbitrary ids
  //      ("n1", "n2") and the buildings array was populated
  //      separately. This is the RV2001 case.
  function findBuildingForT1Node(node, jobId) {
    if (!node || !window.appData) return null;
    var buildings = (appData.buildings || []).filter(function(b) {
      return !jobId || b.jobId === jobId;
    });
    if (!buildings.length) return null;
    if (node.buildingId) {
      var byField = buildings.find(function(b) { return b.id === node.buildingId; });
      if (byField) return byField;
    }
    var byNodeId = buildings.find(function(b) { return b.id === node.id; });
    if (byNodeId) return byNodeId;
    var label = String(node.label || '').trim().toLowerCase();
    if (!label) return null;
    var exact = buildings.find(function(b) { return (b.name || '').trim().toLowerCase() === label; });
    if (exact) return exact;
    var fuzzy = buildings.find(function(b) {
      var n = (b.name || '').trim().toLowerCase();
      return n && (n.indexOf(label) !== -1 || label.indexOf(n) !== -1);
    });
    return fuzzy || null;
  }

  // Cascade a building-level % complete update to its dependents.
  //
  // Per user's rule: t1's own pctComplete is only set when there are
  // NO t2 (phase) or t3/co (change order) nodes wired into it. When
  // there ARE wired-in children, the t1's value is a budget-weighted
  // rollup driven by:
  //   • each wire's pctComplete (wire-level allocation override), or
  //   • the source node's pctComplete as a fallback.
  // So "set building B to 100%" cascades to the WIRE-level pct on
  // every incoming t2/co wire (one entry per source × this building),
  // which lets a phase that's wired into multiple buildings show 100%
  // for one and a different number for another.
  //
  // Also cascades to phase records linked by buildingId — that's what
  // the legacy WIP rollup (wip.js) reads.
  //
  // Returns a one-line summary string for the approval card.
  function applyBuildingPctCascade(building, newPct, optionalNode) {
    var jobId = building.jobId;
    var bldgId = building.id;

    // (a) Phases linked by buildingId — for the legacy WIP rollup.
    var phases = (window.appData && (appData.phases || []).filter(function(p) {
      return p.jobId === jobId && p.buildingId === bldgId;
    })) || [];

    // (b) Graph wires INTO the t1 node from t2/co sources — for the
    //     graph rollup. We need the t1 node id to filter wires;
    //     prefer optionalNode if we already have it, else look it up
    //     in the saved graph by buildingId or label.
    var graphsAll = {};
    try { graphsAll = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}'); } catch (e) {}
    var graphData = graphsAll[jobId] || { nodes: [], wires: [] };
    var graphNodes = graphData.nodes || [];
    var graphWires = graphData.wires || [];
    var t1Node = optionalNode;
    if (!t1Node) {
      t1Node = graphNodes.find(function(n) { return n.type === 't1' && n.buildingId === bldgId; });
      if (!t1Node) {
        var bldgName = (building.name || '').trim().toLowerCase();
        t1Node = graphNodes.find(function(n) {
          return n.type === 't1' && bldgName && (n.label || '').trim().toLowerCase() === bldgName;
        });
      }
    }
    var incomingWires = [];
    if (t1Node) {
      incomingWires = graphWires.filter(function(w) {
        if (w.toNode !== t1Node.id) return false;
        var src = graphNodes.find(function(n) { return n.id === w.fromNode; });
        return src && (src.type === 't2' || src.type === 'co');
      });
    }

    // No children at all — fall back to setting t1.pctComplete directly.
    if (!phases.length && !incomingWires.length) {
      if (t1Node) {
        var oldT1 = Number(t1Node.pctComplete || 0);
        t1Node.pctComplete = newPct;
        graphsAll[jobId] = graphData;
        try { localStorage.setItem('p86-nodegraphs', JSON.stringify(graphsAll)); } catch (e) {}
        if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph();
        if (typeof window.ngRender === 'function') { try { window.ngRender(); } catch (e) {} }
        return 'No phases or wires under "' + (building.name || bldgId) + '" — set t1 directly: ' +
          Math.round(oldT1) + '% → ' + Math.round(newPct) + '%.';
      }
      throw new Error('Building "' + (building.name || bldgId) + '" has no phases, no graph wires, and no t1 node — nothing to update.');
    }

    // Children exist — cascade to them, leave t1.pctComplete untouched.
    if (phases.length) {
      phases.forEach(function(p) { p.pctComplete = newPct; });
      if (typeof window.saveData === 'function') window.saveData();
    }
    if (incomingWires.length) {
      incomingWires.forEach(function(w) { w.pctComplete = newPct; });
      // Persist graph changes back to localStorage so the engine
      // re-reads them. NG.saveGraph also fires for an in-memory sync.
      graphsAll[jobId] = graphData;
      try { localStorage.setItem('p86-nodegraphs', JSON.stringify(graphsAll)); } catch (e) {}
      if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph();
    }
    if (typeof window.ngRender === 'function') { try { window.ngRender(); } catch (e) {} }
    if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
      try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
    }

    var parts = [];
    if (phases.length) parts.push(phases.length + ' phase record' + (phases.length === 1 ? '' : 's') + ' (by buildingId)');
    if (incomingWires.length) parts.push(incomingWires.length + ' incoming wire' + (incomingWires.length === 1 ? '' : 's') + ' from t2/co');
    return 'Set ' + parts.join(' + ') + ' under "' + (building.name || bldgId) + '" to ' +
      Math.round(newPct) + '% (t1 pctComplete left to its weighted rollup).';
  }

  // Job-side tool application. All writes go through appData + the
  // existing CRUD APIs so the rest of the app picks up changes via
  // the standard saveData() persistence path.
  function applyJobTool(tu) {
    var input = tu.input || {};
    // 86 in job context can call propose_create_lead (intake tool
    // merged into JOB_TOOLS). Server-side execProposeCreateLead runs
    // on /chat/continue, mirroring intake — return '' here so the
    // approve flow signals success without attempting a client-side
    // mutation.
    if (tu.name === 'propose_create_lead') return '';
    switch (tu.name) {
      case 'request_build_mode': {
        // Special tool: not a write to job data, just a phase flip.
        // Approval = the PM grants 86 Build mode for this job. The
        // next chat turn (and the /chat/continue right after this
        // approval) will send aiPhase='build', re-opening the full
        // tool list. Returns a summary the model receives so it knows
        // it can now run its planned actions.
        var actions = Array.isArray(input.planned_actions) ? input.planned_actions : [];
        setJobAIPhase(_entityId, 'build');
        return 'Build mode granted by the PM. You may now run the ' +
          (actions.length ? actions.length + ' planned action' + (actions.length === 1 ? '' : 's') : 'requested writes') +
          '. Each one still goes through its own approval card.';
      }

      case 'set_phase_pct_complete': {
        // Resolves four possible IDs in order:
        //   1. Phase record id  ("ph_...")  → set that one phase's pct
        //   2. Building record id ("b1")    → cascade to every phase under that building
        //   3. Graph t1 node id ("n3")      → resolve to the building record, then cascade
        //   4. Graph t2 node id ("n2")      → set the t2 node's pct (the engine syncs to the phase record)
        // The previous behavior set t1 node's pctComplete only — a no-op
        // for the WIP rollup, which reads from per-phase records. Now t1
        // updates cascade to phases so the building actually reflects the
        // requested value (Elle gap report #1).
        var newPct = Math.max(0, Math.min(100, Number(input.pct_complete || 0)));

        // (1) Phase record id
        var phase = (window.appData && (appData.phases || []).find(function(p) { return p.id === input.phase_id; }));
        if (phase) {
          var oldPct = Number(phase.pctComplete || 0);
          phase.pctComplete = newPct;
          if (typeof window.saveData === 'function') window.saveData();
          if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
            try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
          }
          if (typeof window.ngRender === 'function') { try { window.ngRender(); } catch (e) {} }
          return Math.round(oldPct) + '% → ' + Math.round(phase.pctComplete) + '% on phase "' + (phase.phase || phase.name || phase.id) + '"';
        }

        // (2) Building record id — cascade to every phase under it
        var bldgDirect = (window.appData && (appData.buildings || []).find(function(b) { return b.id === input.phase_id; }));
        if (bldgDirect) {
          return applyBuildingPctCascade(bldgDirect, newPct, null);
        }

        // (3) / (4) Graph node id
        var liveNodesP = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
        var nodeP = liveNodesP.find(function(n) { return n.id === input.phase_id; });
        if (!nodeP) throw new Error('Phase id "' + input.phase_id + '" not found as a phase record, building record, or graph node.');
        if (nodeP.type !== 't2' && nodeP.type !== 't1') {
          throw new Error('Node "' + input.phase_id + '" is type "' + nodeP.type + '" — set_phase_pct_complete only works on t2 (phase) or t1 (building) nodes. For cost-bucket nodes use set_node_value.');
        }

        if (nodeP.type === 't1') {
          // Resolve t1 → building record. The resolver tries (in
          // order): explicit buildingId field, node-id-matches-
          // building-record-id (graph-created buildings), and
          // case-insensitive label match. Last one is the RV2001
          // path — older graphs where t1 nodes have arbitrary ids
          // ("n1", "n2") but their labels match a building name.
          var jidT1 = (window.appState && appState.currentJobId) || nodeP.jobId || null;
          var bldg = findBuildingForT1Node(nodeP, jidT1);
          if (bldg) return applyBuildingPctCascade(bldg, newPct, nodeP);
          // No linked building record AND no label match — at least
          // set the node's own pct so the visual reflects the request,
          // even though the WIP rollup can't see it.
          var oldT1 = Number(nodeP.pctComplete || 0);
          nodeP.pctComplete = newPct;
          if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph();
          if (typeof window.ngRender === 'function') { try { window.ngRender(); } catch (e) {} }
          return Math.round(oldT1) + '% → ' + Math.round(newPct) + '% on t1 node "' + (nodeP.label || nodeP.id) + '" (no matching building record by id or label — node-only update; WIP rollup unchanged).';
        }

        // t2 node
        var oldT2Pct = Number(nodeP.pctComplete || 0);
        nodeP.pctComplete = newPct;
        if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph();
        if (typeof window.ngRender === 'function') { try { window.ngRender(); } catch (e) {} }
        return Math.round(oldT2Pct) + '% → ' + Math.round(newPct) + '% on t2 node "' + (nodeP.label || nodeP.id) + '"';
      }

      case 'create_node': {
        // Spawn a new node on the graph. The engine's createDataEntry
        // path automatically creates the underlying data record for
        // structural types (t1=building, t2=phase, co=change order,
        // po, inv, sub) so the AI doesn't have to plumb ids manually.
        // Position is auto-cascaded near the WIP master node so the
        // graph stays tidy on bulk creates.
        var jidCN = (window.appState && appState.currentJobId) || null;
        if (!jidCN) throw new Error('No job is open.');
        if (typeof NG === 'undefined' || !NG.addNode) {
          throw new Error('Node graph is not loaded — open the Workspace tab on this job first so the engine is initialized.');
        }
        // Schema field is `node_type` (renamed from `type` to dodge a
        // JSON Schema keyword collision that was silently dropping the
        // value). Accept the legacy `type` for any in-flight tool_uses
        // queued before this rollout.
        var t = String(input.node_type || input.type || '').toLowerCase();
        var allowedTypes = { t1:1, t2:1, labor:1, mat:1, gc:1, other:1, burden:1, sub:1, po:1, inv:1, co:1, watch:1, note:1 };
        if (!allowedTypes[t]) throw new Error('Unsupported node type "' + t + '". Pick one of: ' + Object.keys(allowedTypes).join(', '));
        var lbl = String(input.label || '').trim();
        if (!lbl && t !== 'note') throw new Error('label required for ' + t + ' nodes.');

        // Compute a tidy position. Cascade newly-created nodes in a
        // grid so a bulk-create doesn't pile every node on top of the
        // last one — base off the highest-x existing node + offset.
        var existingNodes = NG.nodes() || [];
        var baseX = 80, baseY = 80;
        if (existingNodes.length) {
          // Find rightmost x, place 220px to its right; wrap to next
          // row every 6 nodes so big restructures stay readable.
          var maxX = 0, maxY = 0;
          existingNodes.forEach(function(n) {
            if ((n.x || 0) > maxX) maxX = n.x || 0;
            if ((n.y || 0) > maxY) maxY = n.y || 0;
          });
          // Count nodes recently created (no data.id yet, or just created
          // in this turn). We use a tiny per-call offset to space them.
          var spawnOffset = (window._p86AiSpawnCounter = ((window._p86AiSpawnCounter || 0) + 1));
          baseX = maxX + 220;
          baseY = 80 + ((spawnOffset - 1) % 6) * 140;
          if (spawnOffset > 6) baseX = baseX - 220 * Math.floor((spawnOffset - 1) / 6);
        }

        var newNode = NG.addNode(t, baseX, baseY, lbl);
        if (!newNode) throw new Error('addNode returned null — type may not support auto-creation.');

        // Optional initial values.
        if (typeof input.value === 'number' && isFinite(input.value)) {
          newNode.value = Math.max(0, input.value);
        }
        if (typeof input.budget === 'number' && isFinite(input.budget)) {
          newNode.budget = Math.max(0, input.budget);
          // Mirror to the underlying data record for t1/t2 so the WIP
          // page reads the budget correctly.
          if (newNode.data && (t === 't1' || t === 't2')) {
            newNode.data.budget = newNode.budget;
            if (t === 't2') newNode.data.phaseBudget = newNode.budget;
          }
        }
        if (typeof input.pct_complete === 'number' && isFinite(input.pct_complete)) {
          newNode.pctComplete = Math.max(0, Math.min(100, input.pct_complete));
          if (newNode.data && (t === 't1' || t === 't2')) {
            newNode.data.pctComplete = newNode.pctComplete;
          }
        }

        // Optional auto-wire to an existing target.
        var wiredTo = null;
        if (input.attach_to_node_id) {
          var liveWiresCN = NG.wires();
          var attachId = String(input.attach_to_node_id);
          var attachTarget = existingNodes.find(function(n) { return n.id === attachId; });
          if (!attachTarget) {
            // Try label match as a courtesy — same pattern as wire_nodes.
            var lower = attachId.trim().toLowerCase();
            attachTarget = existingNodes.find(function(n) { return (n.label || '').trim().toLowerCase() === lower; });
          }
          if (attachTarget) {
            liveWiresCN.push({
              fromNode: newNode.id,
              fromPort: 0,
              toNode: attachTarget.id,
              toPort: 0
            });
            wiredTo = attachTarget;
          }
        }

        if (typeof NG.saveGraph === 'function') NG.saveGraph();
        if (typeof window.saveData === 'function') window.saveData();
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }

        var summary = 'Created ' + t + ' node "' + (newNode.label || newNode.id) + '" (id=' + newNode.id + ')';
        if (wiredTo) summary += ' → wired to ' + (wiredTo.label || wiredTo.id);
        return summary;
      }

      case 'set_phase_field': {
        // Same id-fallback pattern as set_phase_pct_complete — accept
        // a graph node id and route through it when no matching phase
        // record exists. T2 nodes don't store materials/labor/sub/
        // equipment as direct fields — those flow up from wired cost
        // children — so falling back to a node id only makes sense
        // when the user passed a phase record id by accident.
        var allowed = ['materials', 'labor', 'sub', 'equipment'];
        if (allowed.indexOf(input.field) === -1) throw new Error('Field "' + input.field + '" not allowed.');
        var ph = (window.appData && (appData.phases || []).find(function(p) { return p.id === input.phase_id; }));
        if (ph) {
          var oldAmt = Number(ph[input.field] || 0);
          ph[input.field] = Math.max(0, Number(input.amount || 0));
          if (typeof window.saveData === 'function') window.saveData();
          if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
            try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
          }
          return input.field + ': $' + oldAmt.toFixed(0) + ' → $' + Number(ph[input.field]).toFixed(0) + ' on phase "' + (ph.phase || ph.name || ph.id) + '"';
        }
        // Helpful error: redirect the AI to the right tool when the
        // id looks like a node.
        var liveNodesF = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
        var nodeF = liveNodesF.find(function(n) { return n.id === input.phase_id; });
        if (nodeF) {
          throw new Error('"' + input.phase_id + '" is a graph node (type "' + nodeF.type + '"), not a phase record. Use set_node_value for cost-bucket nodes (labor/mat/gc/other/sub/burden), or set_phase_pct_complete for t2 % complete.');
        }
        throw new Error('Phase id "' + input.phase_id + '" not found.');
      }

      case 'delete_node': {
        // Remove a node from the graph + all its incoming/outgoing
        // wires. Underlying data record is intentionally LEFT IN
        // PLACE — same semantics as the "Remove from Graph" right-
        // click action in the node menu (vs "Delete from Job" which
        // also wipes data). Mirrors wire_nodes' live-engine-first
        // persistence so direct edits survive saveGraph.
        var jidDN = (window.appState && appState.currentJobId) || null;
        if (!jidDN) throw new Error('No job is open.');
        if (typeof NG === 'undefined' || !NG.nodes || !NG.wires) {
          throw new Error('Node graph is not loaded — open the Workspace tab on this job first.');
        }
        var liveNodesD = NG.nodes();
        var liveWiresD = NG.wires();
        var idOrLabelD = String(input.node_id || '');
        if (!idOrLabelD) throw new Error('node_id required.');
        // id-or-label fallback (same as wire_nodes / set_node_value)
        var nodeD = liveNodesD.find(function(n) { return n.id === idOrLabelD; });
        if (!nodeD) {
          var lowerD = idOrLabelD.trim().toLowerCase();
          nodeD = liveNodesD.find(function(n) { return (n.label || '').trim().toLowerCase() === lowerD; });
        }
        if (!nodeD) throw new Error('Node "' + idOrLabelD + '" not in graph.');

        // Block deleting the WIP master node — it's the graph's root
        // output and removing it leaves no place for costs to flow
        // upward. Re-deletable manually if the user really wants it,
        // but the AI shouldn't decide that on its own.
        if (nodeD.type === 'wip') {
          throw new Error('Refusing to delete the WIP master node — that\'s the graph\'s root output. The user can remove it manually if needed.');
        }

        // Count wires before removing for the summary line.
        var attachedWireCount = 0;
        for (var iD = 0; iD < liveWiresD.length; iD++) {
          var wD = liveWiresD[iD];
          if (wD.fromNode === nodeD.id || wD.toNode === nodeD.id) attachedWireCount++;
        }

        // Mutate live arrays via NG setters when available; fall back
        // to in-place splice so older builds without setters still
        // work.
        var keptWires = liveWiresD.filter(function(w) {
          return w.fromNode !== nodeD.id && w.toNode !== nodeD.id;
        });
        var keptNodes = liveNodesD.filter(function(n) { return n.id !== nodeD.id; });
        if (NG.setWires) NG.setWires(keptWires);
        else { liveWiresD.length = 0; Array.prototype.push.apply(liveWiresD, keptWires); }
        if (NG.setNodes) NG.setNodes(keptNodes);
        else { liveNodesD.length = 0; Array.prototype.push.apply(liveNodesD, keptNodes); }

        if (typeof NG.saveGraph === 'function') NG.saveGraph();
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }

        return 'Removed ' + nodeD.type + ' node "' + (nodeD.label || nodeD.id) + '" and ' +
          attachedWireCount + ' wire' + (attachedWireCount === 1 ? '' : 's') +
          '. Underlying job data preserved.';
      }

      case 'wire_nodes': {
        // Push directly to the engine's live wires array. Mutating
        // localStorage alone doesn't work — ngRender() ends with
        // E.saveGraph() which writes the engine's IN-MEMORY state
        // back to localStorage, overwriting any direct edits. So
        // we read/write through NG.* and let saveGraph persist.
        // Falls back to a localStorage-only path when the engine
        // isn't loaded (rare — graph would have to be uninitialized).
        var jid = (window.appState && appState.currentJobId) || null;
        if (!jid) throw new Error('No job is open.');

        var liveNodes = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : null;
        var liveWires = (typeof NG !== 'undefined' && NG.wires) ? NG.wires() : null;
        var nodesArr, wiresArr, persistDirect = false, graphsBlob = null, gBlob = null;
        if (Array.isArray(liveNodes) && Array.isArray(liveWires) && liveNodes.length) {
          nodesArr = liveNodes;
          wiresArr = liveWires;
        } else {
          // Engine hasn't loaded this job's graph yet — fall back to
          // the localStorage blob and persist directly.
          persistDirect = true;
          graphsBlob = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
          gBlob = graphsBlob[jid];
          if (!gBlob || !Array.isArray(gBlob.nodes)) throw new Error('Job has no node graph yet.');
          nodesArr = gBlob.nodes;
          wiresArr = Array.isArray(gBlob.wires) ? gBlob.wires : (gBlob.wires = []);
        }

        // Resolve id → fallback to label match if the AI sent a label.
        var resolveNode = function(idOrLabel) {
          if (!idOrLabel) return null;
          var byId = nodesArr.find(function(n) { return n.id === idOrLabel; });
          if (byId) return byId;
          var lower = String(idOrLabel).trim().toLowerCase();
          var byLabel = nodesArr.find(function(n) { return (n.label || '').trim().toLowerCase() === lower; });
          return byLabel || null;
        };
        var fromN = resolveNode(input.from_node_id);
        var toN = resolveNode(input.to_node_id);
        if (!fromN) throw new Error('from_node_id "' + input.from_node_id + '" not in graph.');
        if (!toN) throw new Error('to_node_id "' + input.to_node_id + '" not in graph.');

        var dup = wiresArr.some(function(w) {
          return w.fromNode === fromN.id && w.toNode === toN.id &&
                 w.fromPort === (input.from_port || 0) && w.toPort === (input.to_port || 0);
        });
        if (dup) return 'Wire ' + fromN.id + ' → ' + toN.id + ' already existed; no change.';

        wiresArr.push({
          fromNode: fromN.id,
          fromPort: input.from_port || 0,
          toNode: toN.id,
          toPort: input.to_port || 0
        });

        if (persistDirect) {
          graphsBlob[jid] = gBlob;
          localStorage.setItem('p86-nodegraphs', JSON.stringify(graphsBlob));
        } else if (typeof NG !== 'undefined' && NG.saveGraph) {
          // Write the now-updated in-memory state through the engine.
          NG.saveGraph();
        }
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }
        return 'Wired ' + (fromN.label || fromN.id) + ' → ' + (toN.label || toN.id);
      }

      case 'set_node_value': {
        // Set a cost-bucket node's `value` (the QB Total field rendered
        // on labor/mat/gc/other/sub nodes). Mutates the live engine
        // nodes array so the graph re-renders / pushes to job. Mirrors
        // wire_nodes' "live array first, localStorage fallback" pattern
        // so direct edits aren't overwritten by saveGraph on next render.
        var jidNV = (window.appState && appState.currentJobId) || null;
        if (!jidNV) throw new Error('No job is open.');

        var liveNodesV = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : null;
        var nodesArrV, persistDirectV = false, graphsBlobV = null, gBlobV = null;
        if (Array.isArray(liveNodesV) && liveNodesV.length) {
          nodesArrV = liveNodesV;
        } else {
          persistDirectV = true;
          graphsBlobV = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
          gBlobV = graphsBlobV[jidNV];
          if (!gBlobV || !Array.isArray(gBlobV.nodes)) throw new Error('Job has no node graph yet.');
          nodesArrV = gBlobV.nodes;
        }

        // id → label fallback (same pattern as wire_nodes / assign_qb_line)
        var idOrLabel = String(input.node_id || '');
        var node = nodesArrV.find(function(n) { return n.id === idOrLabel; });
        if (!node) {
          var lowerL = idOrLabel.trim().toLowerCase();
          node = nodesArrV.find(function(n) { return (n.label || '').trim().toLowerCase() === lowerL; });
        }
        if (!node) throw new Error('Node "' + idOrLabel + '" not in graph. Use a node id from the # Node graph block (not a phase id).');

        var allowedTypes = { labor: 1, mat: 1, gc: 1, other: 1, sub: 1, burden: 1 };
        if (!allowedTypes[node.type]) {
          throw new Error('set_node_value only works on cost-bucket nodes (labor/mat/gc/other/sub/burden). Node "' + (node.label || node.id) + '" is type "' + node.type + '". For phase fields use set_phase_field.');
        }

        var amt = Number(input.amount);
        if (!isFinite(amt) || amt < 0) throw new Error('amount must be a non-negative number.');

        var prior = Number(node.value || 0);
        node.value = amt;

        if (persistDirectV) {
          graphsBlobV[jidNV] = gBlobV;
          localStorage.setItem('p86-nodegraphs', JSON.stringify(graphsBlobV));
        } else if (typeof NG !== 'undefined' && NG.saveGraph) {
          NG.saveGraph();
        }
        if (typeof window.ngRender === 'function') {
          try { window.ngRender(); } catch (e) {}
        }
        return 'Set ' + (node.label || node.id) + ' (' + node.type + ') value: $' +
          prior.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) +
          ' → $' + amt.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      }

      case 'read_workspace_sheet_full': {
        // Return the entire sheet's contents as the tool_result so
        // the assistant can analyze data past the default 100×26
        // preview window. Sheet name lookup is fuzzy: exact →
        // case-insensitive → trimmed-whitespace. Empty sheets return
        // a diagnostic message naming nearby tabs so the assistant
        // can suggest alternatives instead of saying "0 rows."
        var jid = (window.appState && appState.currentJobId) || null;
        if (!jid) throw new Error('No job is open.');
        var allWs = JSON.parse(localStorage.getItem('p86-workspaces') || '{}');
        var wb = allWs[jid];
        if (!wb || !Array.isArray(wb.sheets)) throw new Error('No workspace for this job.');
        var requested = String(input.sheet_name || '');
        // Hard-block legacy QB Costs import snapshots — the AI was
        // looping through these (one tool call per import date) when
        // the user just wants to know about QB spend. The canonical,
        // deduplicated, server-persisted data is already in the
        // qbCosts block of every prompt; reading these sheets is
        // never the right move.
        if (/^QB Costs /i.test(requested)) {
          return 'STOP — do not read individual "QB Costs YYYY-MM-DD" sheets. ' +
            'Those are legacy per-import snapshots. The consolidated, deduplicated, ' +
            'server-persisted QuickBooks data for this job is in the # QuickBooks cost data ' +
            'block of the system prompt (with totals, by-category breakdown, top lines, and ' +
            'most-recent-import date). Answer from that block instead. If you need a specific ' +
            'line by id, it\'s in the Top-N samples list there.';
        }
        var norm = function(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
        var rNorm = norm(requested);
        var sheet = wb.sheets.find(function(s) { return s.name === requested; }) ||
                    wb.sheets.find(function(s) { return norm(s.name) === rNorm; });
        if (!sheet) {
          // Tell the assistant which sheets DO exist so it can
          // re-prompt the user with valid options. QB Costs sheets
          // and the embedded "Detailed Costs" view are excluded
          // since they aren't user-readable via this tool.
          var available = wb.sheets
            .filter(function(s) {
              return !/^QB Costs /i.test(s.name || '') && s.kind !== 'qb-costs';
            })
            .map(function(s) { return s.name || '(unnamed)'; });
          throw new Error('Sheet "' + requested + '" not found. Available tabs: ' + (available.length ? available.join(' · ') : '(none)'));
        }
        // Same guard for the embedded Detailed Costs view (kind=qb-costs)
        // — its data is the qbCosts block, not cells.
        if (sheet.kind === 'qb-costs') {
          return 'STOP — the "Detailed Costs" tab is a live view of the # QuickBooks cost data block ' +
            'in the system prompt, not a grid sheet. Use that block to answer.';
        }
        var cells = sheet.cells || {};
        var grid = {};
        var maxR = 0, maxC = 0;
        Object.keys(cells).forEach(function(k) {
          var m = k.match(/^(\d+),(\d+)$/);
          if (!m) return;
          var r = parseInt(m[1], 10), c = parseInt(m[2], 10);
          if (r > 1000 || c > 26) return;
          var v = cells[k];
          if (v == null) return;
          var raw = (typeof v === 'object' && 'value' in v) ? v.value : v;
          if (raw == null || raw === '') return;
          if (!grid[r]) grid[r] = {};
          grid[r][c] = String(raw);
          if (r > maxR) maxR = r;
          if (c > maxC) maxC = c;
        });
        var rows = [];
        for (var r = 0; r <= maxR; r++) {
          if (!grid[r]) continue;
          var parts = [];
          for (var c = 0; c <= maxC; c++) {
            if (grid[r][c] != null) {
              var label = String.fromCharCode(65 + c);
              parts.push(label + '=' + String(grid[r][c]).replace(/\s+/g, ' '));
            }
          }
          if (parts.length) rows.push((r + 1) + ': ' + parts.join(' · '));
        }
        if (!rows.length) {
          // Empty sheet — be explicit so the assistant doesn't claim
          // "0 rows" generically. Includes the matched name + an
          // explanation that workspace sheets are localStorage-only
          // (so cross-device sync hasn't happened yet).
          var siblings = wb.sheets.map(function(s) { return s.name || '(unnamed)'; }).filter(function(n) { return n !== sheet.name; });
          return 'Sheet "' + sheet.name + '" exists but has no populated cells in this browser session. ' +
            'Workspace sheets are localStorage-only right now — cells aren\'t synced across devices/sessions, ' +
            'so if the user expects data here they may need to open the Workspace tab and Save it on this machine. ' +
            (siblings.length ? 'Other tabs in this job: ' + siblings.join(' · ') + '.' : '');
        }
        var header = 'Sheet "' + sheet.name + '" — ' + rows.length + ' populated rows × ' + (maxC + 1) + ' cols\n\n';
        return header + rows.join('\n');
      }

      case 'read_qb_cost_lines': {
        // Pull from appData.qbCostLines (server-hydrated). Returns the
        // full filtered list as a compact text block so the model can
        // reason over individual transactions without us having to
        // pre-stuff hundreds of lines into every system prompt.
        var jidQ = (window.appState && appState.currentJobId) || null;
        if (!jidQ) throw new Error('No job is open.');
        var allQB = (window.appData && Array.isArray(appData.qbCostLines))
          ? appData.qbCostLines.filter(function(l) { return (l.job_id || l.jobId) === jidQ; })
          : [];
        if (!allQB.length) {
          return 'No QuickBooks cost lines for this job. The user may not have imported QB data yet, or the import is on another device and the qb_cost_lines server table is empty for this job.';
        }
        var iLower = function(s) { return String(s == null ? '' : s).toLowerCase(); };
        var fAccount = iLower(input.account || '');
        var fVendor  = iLower(input.vendor  || '');
        var fSearch  = iLower(input.search  || '');
        var fStatus  = String(input.status  || 'all').toLowerCase();
        var lim      = Math.max(1, Math.min(1000, parseInt(input.limit, 10) || 200));
        var filtered = allQB.filter(function(l) {
          if (fAccount && iLower(l.account).indexOf(fAccount) === -1) return false;
          if (fVendor  && iLower(l.vendor).indexOf(fVendor) === -1) return false;
          if (fSearch) {
            var hay = iLower(l.vendor) + ' ' + iLower(l.memo) + ' ' + iLower(l.account) + ' ' + iLower(l.klass);
            if (hay.indexOf(fSearch) === -1) return false;
          }
          var linked = !!(l.linked_node_id || l.linkedNodeId);
          if (fStatus === 'linked' && !linked) return false;
          if (fStatus === 'unlinked' && linked) return false;
          return true;
        });
        // Sort newest first, biggest amount first as tiebreak.
        filtered.sort(function(a, b) {
          var da = String(a.txn_date || a.date || '');
          var db = String(b.txn_date || b.date || '');
          if (da !== db) return db.localeCompare(da);
          return Number(b.amount || 0) - Number(a.amount || 0);
        });
        var truncated = filtered.length > lim;
        var slice = filtered.slice(0, lim);
        var totalShown = slice.reduce(function(s, l) { return s + Number(l.amount || 0); }, 0);
        var totalAll   = filtered.reduce(function(s, l) { return s + Number(l.amount || 0); }, 0);
        var header = 'QB cost lines for this job — ' +
          'matched: ' + filtered.length + ' (showing ' + slice.length + (truncated ? ', truncated by limit' : '') + '), ' +
          'matched total: $' + totalAll.toFixed(2) + (truncated ? ', shown total: $' + totalShown.toFixed(2) : '') +
          '\n';
        if (fAccount || fVendor || fSearch || fStatus !== 'all') {
          var fparts = [];
          if (fAccount) fparts.push('account~"' + input.account + '"');
          if (fVendor)  fparts.push('vendor~"'  + input.vendor  + '"');
          if (fSearch)  fparts.push('search~"'  + input.search  + '"');
          if (fStatus !== 'all') fparts.push('status=' + fStatus);
          header += 'Filters: ' + fparts.join(', ') + '\n';
        }
        var body = slice.map(function(l) {
          var d = String(l.txn_date || l.date || '');
          if (d.length > 10) d = d.slice(0, 10);
          var amt = Number(l.amount || 0);
          var linked = (l.linked_node_id || l.linkedNodeId) ? ' →node:' + (l.linked_node_id || l.linkedNodeId) : ' →UNLINKED';
          var memo = l.memo ? ' — ' + String(l.memo).slice(0, 80) : '';
          return '- [id=' + (l.id || '?') + '] ' + d + ' $' + amt.toFixed(2) +
                 ' ' + (l.vendor || '(no vendor)') +
                 ' | ' + (l.account || '(no account)') +
                 (l.klass ? ' | ' + l.klass : '') +
                 memo + linked;
        }).join('\n');
        return header + '\n' + body;
      }

      case 'assign_qb_line': {
        // Server is the source of truth for QB lines (Phase 2 schema).
        // Optimistic local update + PATCH; the next hydration on /chat
        // /continue rebuild reflects the canonical state.
        // Same id-or-label fallback as wire_nodes for the node side.
        var jid2 = (window.appState && appState.currentJobId) || null;
        var graphs2 = jid2 ? JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}') : {};
        var nodes2 = (jid2 && graphs2[jid2] && graphs2[jid2].nodes) || [];
        var resolvedNodeId = input.node_id;
        var nMatch = nodes2.find(function(n) { return n.id === input.node_id; });
        if (!nMatch) {
          var lower2 = String(input.node_id || '').trim().toLowerCase();
          var byLabel = nodes2.find(function(n) { return (n.label || '').trim().toLowerCase() === lower2; });
          if (byLabel) resolvedNodeId = byLabel.id;
        }
        var lines = (window.appData && appData.qbCostLines) || [];
        var line = lines.find(function(l) { return l.id === input.line_id; });
        if (line) line.linked_node_id = resolvedNodeId;
        if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated()) {
          window.p86Api.qbCosts.update(input.line_id, { linkedNodeId: resolvedNodeId }).catch(function(err) {
            console.warn('[ai] assign_qb_line server patch failed:', err && err.message);
          });
        }
        return 'Linked QB line ' + input.line_id + ' → node ' + resolvedNodeId;
      }

      case 'set_co_field': {
        // Update one field on a change order. Whitelisted fields only.
        // Numeric coercion for income / estimatedCosts; everything else
        // is stored as a trimmed string. saveData() persists to the
        // server; renderJobOverview() refreshes the visible WIP rollup.
        var ALLOWED_CO_FIELDS = { income: 'number', estimatedCosts: 'number', description: 'string', notes: 'string', coNumber: 'string', date: 'string' };
        var field = String(input.field || '');
        var fieldType = ALLOWED_CO_FIELDS[field];
        if (!fieldType) {
          throw new Error('set_co_field: field "' + field + '" not allowed. Allowed: ' + Object.keys(ALLOWED_CO_FIELDS).join(', '));
        }
        var co = (window.appData && (appData.changeOrders || []).find(function(c) { return c.id === input.co_id; }));
        if (!co) throw new Error('set_co_field: change order "' + input.co_id + '" not found.');
        var oldVal = co[field];
        var newVal;
        if (fieldType === 'number') {
          newVal = Number(input.value) || 0;
        } else {
          newVal = String(input.value == null ? '' : input.value).trim();
        }
        co[field] = newVal;
        if (typeof window.saveData === 'function') window.saveData();
        if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
          try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
        }
        if (typeof window.ngRender === 'function') { try { window.ngRender(); } catch (e) {} }
        // Format the summary based on field type — currency for $ fields, raw for text.
        var fmtOld = (fieldType === 'number') ? ('$' + (Number(oldVal) || 0).toLocaleString()) : ('"' + (oldVal || '') + '"');
        var fmtNew = (fieldType === 'number') ? ('$' + (Number(newVal) || 0).toLocaleString()) : ('"' + (newVal || '') + '"');
        return 'CO ' + (co.coNumber || co.id) + ' ' + field + ': ' + fmtOld + ' → ' + fmtNew;
      }

      case 'create_po': {
        // New purchase order on the active job. vendor + amount required;
        // everything else falls back to sensible defaults. subId is auto-
        // resolved from vendor when the name matches a row in subsDirectory
        // (case-insensitive) so PMs can keep the existing chain link.
        var jidPo = (window.appState && appState.currentJobId) || null;
        if (!jidPo) throw new Error('create_po: no active job.');
        var vendorPo = String(input.vendor || '').trim();
        if (!vendorPo) throw new Error('create_po: vendor is required.');
        var amountPo = Number(input.amount) || 0;
        var subDir = (window.appData && Array.isArray(appData.subsDirectory)) ? appData.subsDirectory : [];
        var subMatch = subDir.find(function(s) { return (s.name || '').toLowerCase() === vendorPo.toLowerCase(); });
        var newPo = {
          id: 'po' + Date.now(),
          jobId: jidPo,
          poNumber: String(input.poNumber || '').trim(),
          vendor: vendorPo,
          subId: subMatch ? subMatch.id : null,
          description: String(input.description || '').trim(),
          amount: amountPo,
          billedToDate: Number(input.billedToDate) || 0,
          date: String(input.date || '').trim() || new Date().toISOString().slice(0, 10),
          status: ['Open', 'Closed', 'Pending'].indexOf(input.status) >= 0 ? input.status : 'Open',
          notes: String(input.notes || '').trim()
        };
        if (!Array.isArray(window.appData.purchaseOrders)) window.appData.purchaseOrders = [];
        window.appData.purchaseOrders.push(newPo);
        if (typeof window.saveData === 'function') window.saveData();
        if (typeof window.renderJobOverview === 'function') {
          try { window.renderJobOverview(jidPo); } catch (e) {}
        }
        return 'Created PO ' + (newPo.poNumber || newPo.id) + ' — ' + newPo.vendor + ' $' + amountPo.toLocaleString() + ' (' + newPo.status + ')';
      }

      case 'set_po_field': {
        var ALLOWED_PO_FIELDS = { vendor: 'string', amount: 'number', poNumber: 'string', description: 'string', billedToDate: 'number', date: 'string', status: 'string', notes: 'string' };
        var poField = String(input.field || '');
        var poFieldType = ALLOWED_PO_FIELDS[poField];
        if (!poFieldType) {
          throw new Error('set_po_field: field "' + poField + '" not allowed. Allowed: ' + Object.keys(ALLOWED_PO_FIELDS).join(', '));
        }
        var poRec = (window.appData && (appData.purchaseOrders || []).find(function(p) { return p.id === input.po_id; }));
        if (!poRec) throw new Error('set_po_field: PO "' + input.po_id + '" not found.');
        var poOldVal = poRec[poField];
        var poNewVal;
        if (poFieldType === 'number') poNewVal = Number(input.value) || 0;
        else poNewVal = String(input.value == null ? '' : input.value).trim();
        poRec[poField] = poNewVal;
        if (typeof window.saveData === 'function') window.saveData();
        if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
          try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
        }
        var poFmtOld = (poFieldType === 'number') ? ('$' + (Number(poOldVal) || 0).toLocaleString()) : ('"' + (poOldVal || '') + '"');
        var poFmtNew = (poFieldType === 'number') ? ('$' + (Number(poNewVal) || 0).toLocaleString()) : ('"' + (poNewVal || '') + '"');
        return 'PO ' + (poRec.poNumber || poRec.id) + ' ' + poField + ': ' + poFmtOld + ' → ' + poFmtNew;
      }

      case 'create_invoice': {
        var jidInv = (window.appState && appState.currentJobId) || null;
        if (!jidInv) throw new Error('create_invoice: no active job.');
        var vendorInv = String(input.vendor || '').trim();
        if (!vendorInv) throw new Error('create_invoice: vendor is required.');
        var amountInv = Number(input.amount) || 0;
        var dateInv = String(input.date || '').trim() || new Date().toISOString().slice(0, 10);
        // Default due = date + 30 days
        var dueDateInv = String(input.dueDate || '').trim();
        if (!dueDateInv && dateInv) {
          try {
            var d = new Date(dateInv);
            d.setDate(d.getDate() + 30);
            dueDateInv = d.toISOString().slice(0, 10);
          } catch (e) { dueDateInv = ''; }
        }
        var newInv = {
          id: 'inv' + Date.now(),
          jobId: jidInv,
          invNumber: String(input.invNumber || '').trim(),
          vendor: vendorInv,
          description: String(input.description || '').trim(),
          amount: amountInv,
          date: dateInv,
          dueDate: dueDateInv,
          status: ['Draft', 'Pending', 'Paid', 'Overdue'].indexOf(input.status) >= 0 ? input.status : 'Draft',
          notes: String(input.notes || '').trim()
        };
        if (!Array.isArray(window.appData.invoices)) window.appData.invoices = [];
        window.appData.invoices.push(newInv);
        if (typeof window.saveData === 'function') window.saveData();
        if (typeof window.renderJobOverview === 'function') {
          try { window.renderJobOverview(jidInv); } catch (e) {}
        }
        return 'Created invoice ' + (newInv.invNumber || newInv.id) + ' — ' + newInv.vendor + ' $' + amountInv.toLocaleString() + ' (' + newInv.status + ')';
      }

      case 'set_invoice_field': {
        var ALLOWED_INV_FIELDS = { vendor: 'string', amount: 'number', invNumber: 'string', description: 'string', date: 'string', dueDate: 'string', status: 'string', notes: 'string' };
        var invField = String(input.field || '');
        var invFieldType = ALLOWED_INV_FIELDS[invField];
        if (!invFieldType) {
          throw new Error('set_invoice_field: field "' + invField + '" not allowed. Allowed: ' + Object.keys(ALLOWED_INV_FIELDS).join(', '));
        }
        var invRec = (window.appData && (appData.invoices || []).find(function(i) { return i.id === input.inv_id; }));
        if (!invRec) throw new Error('set_invoice_field: invoice "' + input.inv_id + '" not found.');
        var invOldVal = invRec[invField];
        var invNewVal;
        if (invFieldType === 'number') invNewVal = Number(input.value) || 0;
        else invNewVal = String(input.value == null ? '' : input.value).trim();
        invRec[invField] = invNewVal;
        if (typeof window.saveData === 'function') window.saveData();
        if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
          try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
        }
        var invFmtOld = (invFieldType === 'number') ? ('$' + (Number(invOldVal) || 0).toLocaleString()) : ('"' + (invOldVal || '') + '"');
        var invFmtNew = (invFieldType === 'number') ? ('$' + (Number(invNewVal) || 0).toLocaleString()) : ('"' + (invNewVal || '') + '"');
        return 'Invoice ' + (invRec.invNumber || invRec.id) + ' ' + invField + ': ' + invFmtOld + ' → ' + invFmtNew;
      }

      case 'assign_qb_lines_bulk': {
        // Same logic as assign_qb_line, looped over an array of pairs.
        // Returns a multi-line summary so the model sees per-pair
        // outcomes (success / node-not-found / line-not-found). One
        // server PATCH per pair fires concurrently — they're idempotent
        // and order-independent.
        var pairs = Array.isArray(input.pairs) ? input.pairs : [];
        if (!pairs.length) throw new Error('assign_qb_lines_bulk: pairs array is empty');
        var jidB = (window.appState && appState.currentJobId) || null;
        var graphsB = jidB ? JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}') : {};
        var nodesB = (jidB && graphsB[jidB] && graphsB[jidB].nodes) || [];
        var qbLinesB = (window.appData && appData.qbCostLines) || [];
        var ok = 0, missingNode = 0, missingLine = 0;
        var perNode = {};
        var serverPatches = [];
        var apiAvail = window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated();
        pairs.forEach(function(p) {
          var nMatchB = nodesB.find(function(n) { return n.id === p.node_id; });
          var resolvedB = nMatchB ? p.node_id : null;
          if (!resolvedB) {
            var lowerB = String(p.node_id || '').trim().toLowerCase();
            var byLabelB = nodesB.find(function(n) { return (n.label || '').trim().toLowerCase() === lowerB; });
            if (byLabelB) resolvedB = byLabelB.id;
          }
          if (!resolvedB) { missingNode++; return; }
          var lineB = qbLinesB.find(function(l) { return l.id === p.line_id; });
          if (!lineB) { missingLine++; return; }
          lineB.linked_node_id = resolvedB;
          ok++;
          perNode[resolvedB] = (perNode[resolvedB] || 0) + 1;
          if (apiAvail) {
            serverPatches.push(
              window.p86Api.qbCosts.update(p.line_id, { linkedNodeId: resolvedB }).catch(function(err) {
                console.warn('[ai] assign_qb_lines_bulk patch failed for ' + p.line_id + ':', err && err.message);
              })
            );
          }
        });
        // We don't await the server patches — they run in the background.
        // The optimistic local updates are already in place for the next
        // /chat/continue context build.
        var perNodeLines = Object.keys(perNode).map(function(nid) {
          return '  • ' + nid + ': ' + perNode[nid] + ' line' + (perNode[nid] === 1 ? '' : 's');
        }).join('\n');
        var summary = 'Linked ' + ok + ' of ' + pairs.length + ' QB line' + (pairs.length === 1 ? '' : 's') + '.';
        if (missingNode || missingLine) {
          summary += ' Skipped: ' + missingNode + ' missing-node, ' + missingLine + ' missing-line.';
        }
        if (perNodeLines) summary += '\nPer node:\n' + perNodeLines;
        return summary;
      }

      // ── Diagnostic + surgical tools (Elle robustness pass) ────
      case 'read_building_breakdown': {
        var rbJobId = (window.appState && appState.currentJobId) || null;
        if (!rbJobId) throw new Error('read_building_breakdown: no active job.');
        var rbInput = String(input.building_id || '').trim();
        if (!rbInput) throw new Error('read_building_breakdown: building_id is required.');
        // Resolve to a building record. Try direct id, then t1 node label match.
        var rbBuildings = (window.appData && (appData.buildings || []).filter(function(b) { return b.jobId === rbJobId; })) || [];
        var rbBldg = rbBuildings.find(function(b) { return b.id === rbInput; });
        if (!rbBldg) {
          var rbGraphsForId = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
          var rbNodesForId = (rbGraphsForId[rbJobId] && rbGraphsForId[rbJobId].nodes) || [];
          var rbT1ById = rbNodesForId.find(function(n) { return n.type === 't1' && n.id === rbInput; });
          if (rbT1ById) {
            rbBldg = findBuildingForT1Node(rbT1ById, rbJobId);
          }
        }
        if (!rbBldg) {
          // Last try: case-insensitive label match on building name
          var rbLower = rbInput.toLowerCase();
          rbBldg = rbBuildings.find(function(b) { return (b.name || '').trim().toLowerCase() === rbLower; });
        }
        if (!rbBldg) {
          return 'Building "' + rbInput + '" not found. Buildings on this job: ' +
            rbBuildings.map(function(b) { return b.name + ' [' + b.id + ']'; }).join(', ');
        }
        var rbPhases = (window.appData && (appData.phases || []).filter(function(p) {
          return p.jobId === rbJobId && p.buildingId === rbBldg.id;
        })) || [];
        var rbTotalBudget = rbPhases.reduce(function(s, p) { return s + (Number(p.phaseBudget) || 0); }, 0);
        var rbWeightedPct = 0;
        if (rbPhases.length) {
          if (rbTotalBudget > 0) {
            rbWeightedPct = rbPhases.reduce(function(s, p) {
              return s + (Number(p.pctComplete) || 0) * (Number(p.phaseBudget) || 0);
            }, 0) / rbTotalBudget;
          } else {
            rbWeightedPct = rbPhases.reduce(function(s, p) { return s + (Number(p.pctComplete) || 0); }, 0) / rbPhases.length;
          }
        }
        var rbGraphs = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
        var rbNodes = (rbGraphs[rbJobId] && rbGraphs[rbJobId].nodes) || [];
        var rbWires = (rbGraphs[rbJobId] && rbGraphs[rbJobId].wires) || [];
        var rbT1 = rbNodes.find(function(n) { return n.type === 't1' && n.buildingId === rbBldg.id; })
          || rbNodes.find(function(n) {
              return n.type === 't1' && (n.label || '').trim().toLowerCase() === (rbBldg.name || '').trim().toLowerCase();
            })
          || null;
        var rbIncoming = [];
        if (rbT1) {
          rbWires.forEach(function(w) {
            if (w.toNode !== rbT1.id) return;
            var src = rbNodes.find(function(n) { return n.id === w.fromNode; });
            if (src && (src.type === 't2' || src.type === 'co')) {
              rbIncoming.push({ wire: w, src: src });
            }
          });
        }
        var rbOut = [];
        rbOut.push('Building: ' + (rbBldg.name || rbBldg.id) + ' [' + rbBldg.id + ']' +
          (rbBldg.budget ? ' · budget $' + Number(rbBldg.budget).toLocaleString() : ''));
        rbOut.push('');
        rbOut.push('## Phase records (' + rbPhases.length + ' linked by buildingId)');
        if (!rbPhases.length) {
          rbOut.push('  (none — legacy WIP rollup will read 0% for this building)');
        } else {
          rbPhases.forEach(function(p) {
            var w = (rbTotalBudget > 0)
              ? Math.round(((Number(p.phaseBudget) || 0) / rbTotalBudget) * 100) + '% weight'
              : 'equal weight';
            rbOut.push('  • [' + p.id + '] ' + (p.phase || '(unnamed)') +
              ' · pct=' + Math.round(Number(p.pctComplete) || 0) + '%' +
              ' · budget=$' + Number(p.phaseBudget || 0).toLocaleString() +
              ' · ' + w);
          });
          rbOut.push('  → Computed legacy WIP pct (budget-weighted): ' + Math.round(rbWeightedPct) + '%');
        }
        rbOut.push('');
        rbOut.push('## Graph wires INTO t1 (' + rbIncoming.length + ' from t2/co sources)');
        if (!rbT1) {
          rbOut.push('  (no t1 node found for this building — graph rollup unavailable)');
        } else if (!rbIncoming.length) {
          rbOut.push('  (none — graph rollup will read 0% for this building)');
        } else {
          rbIncoming.forEach(function(r) {
            var srcLabel = r.src.label || r.src.id;
            var ap = (r.wire.allocPct != null) ? r.wire.allocPct : 100;
            var pc = (r.wire.pctComplete != null) ? r.wire.pctComplete : (r.src.pctComplete || 0);
            var pcSrc = (r.wire.pctComplete != null) ? '(wire override)' : '(falls back to source)';
            rbOut.push('  • [from=' + r.src.id + ' to=' + rbT1.id + '] ' + r.src.type + ' "' + srcLabel + '"' +
              ' · allocPct=' + ap + '%' +
              ' · pctComplete=' + Math.round(pc) + '% ' + pcSrc);
          });
          rbOut.push('  → t1 node id is ' + rbT1.id + '; t1.pctComplete=' + Math.round(Number(rbT1.pctComplete) || 0) + '% (ignored when wires exist)');
        }
        return rbOut.join('\n');
      }

      case 'read_job_pct_audit': {
        var auJobId = (window.appState && appState.currentJobId) || null;
        if (!auJobId) throw new Error('read_job_pct_audit: no active job.');
        var auBuildings = (window.appData && (appData.buildings || []).filter(function(b) { return b.jobId === auJobId; })) || [];
        var auPhases = (window.appData && (appData.phases || []).filter(function(p) { return p.jobId === auJobId; })) || [];
        var auGraphs = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
        var auNodes = (auGraphs[auJobId] && auGraphs[auJobId].nodes) || [];
        var auWires = (auGraphs[auJobId] && auGraphs[auJobId].wires) || [];

        var auBldgIds = {};
        auBuildings.forEach(function(b) { auBldgIds[b.id] = true; });

        // 1. Orphan phases
        var orphans = auPhases.filter(function(p) { return !p.buildingId || !auBldgIds[p.buildingId]; });
        // 2. Dangling t1 (graph t1 with no matching building record)
        var dangling = auNodes.filter(function(n) {
          if (n.type !== 't1') return false;
          if (n.buildingId && auBldgIds[n.buildingId]) return false;
          if (auBldgIds[n.id]) return false; // graph-created t1 where node id IS building id
          // Also try label match
          var label = (n.label || '').trim().toLowerCase();
          if (label && auBuildings.some(function(b) { return (b.name || '').trim().toLowerCase() === label; })) return false;
          return true;
        });
        // 3. Stale t1.pctComplete with wired children
        var staleT1 = auNodes.filter(function(n) {
          if (n.type !== 't1') return false;
          if (!Number(n.pctComplete)) return false;
          var hasWired = auWires.some(function(w) {
            if (w.toNode !== n.id) return false;
            var src = auNodes.find(function(s) { return s.id === w.fromNode; });
            return src && (src.type === 't2' || src.type === 'co');
          });
          return hasWired;
        });
        // 4. Wires with allocPct = 0
        var zeroAlloc = auWires.filter(function(w) {
          if (w.allocPct == null) return false;
          if (Number(w.allocPct) !== 0) return false;
          var src = auNodes.find(function(n) { return n.id === w.fromNode; });
          var tgt = auNodes.find(function(n) { return n.id === w.toNode; });
          return src && tgt && tgt.type === 't1' && (src.type === 't2' || src.type === 'co');
        });
        // 5. Buildings with no phases
        var emptyBldgs = auBuildings.filter(function(b) {
          return !auPhases.some(function(p) { return p.buildingId === b.id; });
        });
        // 6. Phases with no budget
        var noBudget = auPhases.filter(function(p) { return !Number(p.phaseBudget); });

        var ao = [];
        ao.push('Job audit (' + auJobId + ') — ' + auBuildings.length + ' buildings, ' + auPhases.length + ' phases, ' + auNodes.length + ' nodes, ' + auWires.length + ' wires.');
        ao.push('');
        function fmtList(label, items, fmtFn) {
          if (!items.length) {
            ao.push('✓ ' + label + ': none');
            return;
          }
          ao.push('⚠ ' + label + ' (' + items.length + '):');
          items.slice(0, 10).forEach(function(it) {
            ao.push('  • ' + fmtFn(it));
          });
          if (items.length > 10) ao.push('  …and ' + (items.length - 10) + ' more.');
        }
        fmtList('Orphan phases (no buildingId or dangling)', orphans, function(p) {
          return '[' + p.id + '] ' + (p.phase || '(unnamed)') + ' — buildingId=' + (p.buildingId || '∅');
        });
        fmtList('Dangling t1 nodes (no matching building record)', dangling, function(n) {
          return '[' + n.id + '] "' + (n.label || '(unnamed)') + '"' + (n.buildingId ? ' buildingId=' + n.buildingId + ' (deleted?)' : '');
        });
        fmtList('Stale t1.pctComplete (ignored when wires exist)', staleT1, function(n) {
          return '[' + n.id + '] "' + (n.label || '(unnamed)') + '" pct=' + Math.round(n.pctComplete) + '%';
        });
        fmtList('Wires with allocPct=0 (contribute nothing)', zeroAlloc, function(w) {
          return 'from=' + w.fromNode + ' to=' + w.toNode;
        });
        fmtList('Buildings with no phases (will read 0%)', emptyBldgs, function(b) {
          return '[' + b.id + '] ' + (b.name || '(unnamed)');
        });
        fmtList('Phases with no budget (equal-weighted in rollup)', noBudget, function(p) {
          return '[' + p.id + '] ' + (p.phase || '(unnamed)') + ' (buildingId=' + (p.buildingId || '∅') + ')';
        });
        return ao.join('\n');
      }

      case 'set_phase_buildingId': {
        var spbPhaseId = String(input.phase_id || '').trim();
        var spbBldgId = String(input.building_id == null ? '' : input.building_id).trim();
        if (!spbPhaseId) throw new Error('set_phase_buildingId: phase_id is required.');
        var spbPhase = (window.appData && (appData.phases || []).find(function(p) { return p.id === spbPhaseId; }));
        if (!spbPhase) throw new Error('set_phase_buildingId: phase "' + spbPhaseId + '" not found.');
        // Validate building exists if non-empty
        if (spbBldgId) {
          var spbBldg = (window.appData && (appData.buildings || []).find(function(b) { return b.id === spbBldgId; }));
          if (!spbBldg) throw new Error('set_phase_buildingId: building "' + spbBldgId + '" not found.');
        }
        var spbOld = spbPhase.buildingId || '∅';
        spbPhase.buildingId = spbBldgId || '';
        if (typeof window.saveData === 'function') window.saveData();
        if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
          try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
        }
        if (typeof window.ngRender === 'function') { try { window.ngRender(); } catch (e) {} }
        return 'Phase "' + (spbPhase.phase || spbPhaseId) + '" buildingId: ' + spbOld + ' → ' + (spbBldgId || '∅ (unlinked)');
      }

      case 'set_wire_pct_complete':
      case 'set_wire_alloc_pct': {
        var swJobId = (window.appState && appState.currentJobId) || null;
        if (!swJobId) throw new Error(tu.name + ': no active job.');
        var swGraphs = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
        if (!swGraphs[swJobId]) throw new Error(tu.name + ': no graph for this job.');
        var swWires = swGraphs[swJobId].wires || [];
        var swFrom = String(input.from_node_id || '').trim();
        var swTo = String(input.to_node_id || '').trim();
        var swWire = swWires.find(function(w) { return w.fromNode === swFrom && w.toNode === swTo; });
        if (!swWire) throw new Error(tu.name + ': no wire from "' + swFrom + '" to "' + swTo + '".');
        var swField = (tu.name === 'set_wire_pct_complete') ? 'pctComplete' : 'allocPct';
        var swPayloadKey = (tu.name === 'set_wire_pct_complete') ? 'pct_complete' : 'alloc_pct';
        var swOld = swWire[swField];
        var swNew;
        if (input[swPayloadKey] == null) {
          // Clearing the override
          delete swWire[swField];
          swNew = '∅ (cleared — falls back to source)';
        } else {
          swNew = Math.max(0, Math.min(100, Number(input[swPayloadKey]) || 0));
          swWire[swField] = swNew;
        }
        try { localStorage.setItem('p86-nodegraphs', JSON.stringify(swGraphs)); } catch (e) {}
        if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph();
        if (typeof window.ngRender === 'function') { try { window.ngRender(); } catch (e) {} }
        if (typeof window.renderJobOverview === 'function' && window.appState && appState.currentJobId) {
          try { window.renderJobOverview(appState.currentJobId); } catch (e) {}
        }
        var swFmtOld = (swOld == null) ? '∅ (was source-fallback)' : Math.round(swOld) + '%';
        var swFmtNew = (typeof swNew === 'number') ? Math.round(swNew) + '%' : swNew;
        return 'Wire ' + swFrom + '→' + swTo + ' ' + swField + ': ' + swFmtOld + ' → ' + swFmtNew;
      }

      default:
        throw new Error('Unknown job tool: ' + tu.name);
    }
  }

  // Inline tool-invocation block — Claude Code style. No card chrome:
  // tiny dim header ("▸ tool_name") followed by the output text. When
  // the output is long (>3 lines or >200 chars), wrap it in a
  // <details> so the conversation stays scannable but the user can
  // expand to read the full result. Used for server-side auto-tier
  // tools that already executed during the stream (read_*,
  // self_diagnose, etc.) so the user sees what fired without
  // needing an approval card.
  // Phase 3b — dedicated subtask card. Rendered when 86 calls
  // spawn_subtask; the card lives under the parent's stream and
  // live-polls /api/ai/subtasks until the child reaches a terminal
  // state. cards is a {id: element} map kept across spawns within
  // one parent turn so await_subtasks doesn't make duplicates.
  function appendSubtaskCard(streamDiv, subtaskId, title, cardsMap) {
    if (!streamDiv) return null;
    if (cardsMap && cardsMap[subtaskId]) return cardsMap[subtaskId];
    var content = streamDiv.querySelector('[data-stream-content]') || streamDiv;
    var card = document.createElement('div');
    card.setAttribute('data-subtask-id', subtaskId);
    card.style.cssText =
      'margin-top:8px;padding:8px 10px;border:1px solid rgba(99,102,241,0.25);' +
      'background:rgba(99,102,241,0.06);border-radius:6px;font-size:11.5px;line-height:1.5;' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
    card.innerHTML =
      '<div style="display:flex;align-items:baseline;gap:6px;">' +
        '<span data-st-glyph style="color:#a5b4fc;flex-shrink:0;">⏳</span>' +
        '<span style="color:#818cf8;font-weight:600;">subtask</span>' +
        '<span style="color:var(--text-dim,#888);">' + escapeHTMLLocal(subtaskId) + '</span>' +
        '<span data-st-status style="color:var(--text-dim,#777);margin-left:auto;font-size:10px;">pending</span>' +
      '</div>' +
      '<div style="margin-left:14px;margin-top:2px;color:var(--text,#cbd5e1);">' + escapeHTMLLocal(title || '(no title)') + '</div>' +
      '<div data-st-meta style="margin-left:14px;margin-top:2px;color:var(--text-dim,#777);font-size:10px;display:none;"></div>' +
      '<div data-st-result style="display:none;margin-left:14px;margin-top:6px;"></div>';
    content.appendChild(card);
    if (cardsMap) cardsMap[subtaskId] = card;
    return card;
  }

  // Update one subtask card with a row from /api/ai/subtasks. Idempotent —
  // safe to call repeatedly with the same row. Once status is terminal,
  // the card body is populated with the result/error and the status badge
  // freezes.
  function updateSubtaskCard(card, row) {
    if (!card || !row) return;
    var glyphEl = card.querySelector('[data-st-glyph]');
    var statusEl = card.querySelector('[data-st-status]');
    var metaEl = card.querySelector('[data-st-meta]');
    var resultEl = card.querySelector('[data-st-result]');
    var s = row.status;
    if (statusEl) statusEl.textContent = s;
    if (glyphEl) {
      if (s === 'pending') { glyphEl.textContent = '⏳'; glyphEl.style.color = '#a5b4fc'; }
      else if (s === 'running') { glyphEl.textContent = '⟳'; glyphEl.style.color = '#fbbf24'; }
      else if (s === 'completed') { glyphEl.textContent = '✓'; glyphEl.style.color = '#34d399'; }
      else if (s === 'failed') { glyphEl.textContent = '✗'; glyphEl.style.color = '#f87171'; }
      else if (s === 'canceled') { glyphEl.textContent = '⊘'; glyphEl.style.color = '#a3a3a3'; }
    }
    var tokens = (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0);
    if (metaEl) {
      if (tokens > 0) {
        metaEl.style.display = '';
        metaEl.textContent = (tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens)) + ' tokens';
      } else {
        metaEl.style.display = 'none';
      }
    }
    if (resultEl) {
      var body = '';
      if (s === 'completed') body = row.result || '';
      else if (s === 'failed') body = row.error || 'Failed.';
      else if (s === 'canceled') body = row.error || 'Canceled.';
      if (body) {
        resultEl.style.display = '';
        // Collapse long bodies inside <details>; mirror the appendToolBlock
        // pattern so the chat panel stays readable.
        if (body.length > 200 || body.split('\n').length > 3) {
          var det = document.createElement('details');
          var sum = document.createElement('summary');
          sum.style.cssText = 'cursor:pointer;color:var(--text-dim,#777);font-size:10.5px;list-style:none;';
          var firstLine = body.split('\n').find(function(l) { return l.trim(); }) || '';
          sum.textContent = firstLine.replace(/^#+\s*/, '').slice(0, 90) + (body.length > 90 ? '  …' : '');
          var pre = document.createElement('div');
          pre.style.cssText = 'white-space:pre-wrap;color:var(--text-dim,#9aa0a6);margin-top:4px;padding:6px 8px;background:rgba(0,0,0,0.15);border-left:2px solid rgba(99,102,241,0.3);border-radius:2px;';
          pre.textContent = body;
          det.appendChild(sum);
          det.appendChild(pre);
          resultEl.innerHTML = '';
          resultEl.appendChild(det);
        } else {
          resultEl.innerHTML = '';
          var inline = document.createElement('div');
          inline.style.cssText = 'white-space:pre-wrap;color:var(--text-dim,#9aa0a6);font-size:11px;';
          inline.textContent = body;
          resultEl.appendChild(inline);
        }
      }
    }
  }

  // Live-poll the subtasks endpoint every 2s while at least one tracked
  // card is non-terminal. Auto-stops when all tracked subtasks reach a
  // terminal state. ctx.cards is the {id: element} map populated by
  // appendSubtaskCard. ctx.timer is the setInterval handle, kept on the
  // ctx so the caller can clear() from outside (e.g. on abort).
  function startSubtaskPolling(ctx) {
    if (ctx.timer) return;
    var TERMINAL = { completed: 1, failed: 1, canceled: 1 };
    function tick() {
      var ids = Object.keys(ctx.cards || {});
      if (!ids.length) { stop(); return; }
      var pending = ids.filter(function(id) {
        var c = ctx.cards[id];
        var statusEl = c && c.querySelector('[data-st-status]');
        var s = statusEl ? statusEl.textContent : 'pending';
        return !TERMINAL[s];
      });
      if (!pending.length) { stop(); return; }
      fetch('/api/ai/subtasks?ids=' + encodeURIComponent(pending.join(',')), {
        headers: authHeaders()
      }).then(function(r) {
        if (!r.ok) return null;
        return r.json();
      }).then(function(data) {
        if (!data || !Array.isArray(data.subtasks)) return;
        data.subtasks.forEach(function(row) {
          var card = ctx.cards[row.id];
          if (card) updateSubtaskCard(card, row);
        });
      }).catch(function() { /* poll best-effort */ });
    }
    function stop() { clearInterval(ctx.timer); ctx.timer = null; }
    ctx.stop = stop;
    ctx.timer = setInterval(tick, 2000);
    setTimeout(tick, 100); // First tick fast so pending → running flips quickly.
  }

  function appendToolBlock(streamDiv, glyph, name, text, color) {
    if (!streamDiv) return;
    var content = streamDiv.querySelector('[data-stream-content]') || streamDiv;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:8px;font-size:11.5px;line-height:1.55;color:var(--text-dim,#9aa0a6);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';

    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:baseline;gap:6px;';
    hdr.innerHTML =
      '<span style="color:' + color + ';flex-shrink:0;">' + escapeHTMLLocal(glyph) + '</span>' +
      '<span style="color:var(--text-dim,#aaa);">' + escapeHTMLLocal(name) + '</span>';
    wrap.appendChild(hdr);

    var body = String(text || '');
    if (body) {
      var isLong = body.length > 200 || body.split('\n').length > 3;
      if (isLong) {
        var det = document.createElement('details');
        det.style.cssText = 'margin-left:14px;margin-top:1px;';
        var sum = document.createElement('summary');
        sum.style.cssText = 'cursor:pointer;color:var(--text-dim,#777);font-size:10.5px;list-style:none;';
        var firstLine = body.split('\n').find(function(l) { return l.trim(); }) || '';
        sum.textContent = firstLine.replace(/^#+\s*/, '').slice(0, 90) + (body.length > 90 ? '  …' : '');
        det.appendChild(sum);
        var pre = document.createElement('div');
        pre.style.cssText = 'white-space:pre-wrap;color:var(--text-dim,#7d8590);margin-top:4px;padding:6px 8px;background:rgba(255,255,255,0.025);border-left:2px solid rgba(255,255,255,0.08);border-radius:2px;';
        pre.textContent = body;
        det.appendChild(pre);
        wrap.appendChild(det);
      } else {
        var inline = document.createElement('div');
        inline.style.cssText = 'margin-left:14px;color:var(--text-dim,#8a8f96);white-space:pre-wrap;';
        inline.textContent = body;
        wrap.appendChild(inline);
      }
    }

    content.appendChild(wrap);
  }

  // Compact usage footer rendered after the assistant's reply ends.
  // Format: "↑ 1.2k · ↓ 432 · cache 15.8k" — tiny, dim, single line.
  // Skipped when usage is missing or all-zero.
  function formatUsage(u) {
    if (!u) return '';
    function k(n) {
      n = Number(n) || 0;
      if (n < 1000) return String(n);
      if (n < 10000) return (n / 1000).toFixed(1) + 'k';
      return Math.round(n / 1000) + 'k';
    }
    var inT = Number(u.input_tokens) || 0;
    var outT = Number(u.output_tokens) || 0;
    var cacheR = Number(u.cache_read_input_tokens) || 0;
    var cacheW = Number(u.cache_creation_input_tokens) || 0;
    if (!inT && !outT && !cacheR && !cacheW) return '';
    var parts = [];
    parts.push('↑ ' + k(inT));
    parts.push('↓ ' + k(outT));
    if (cacheR) parts.push('cache ' + k(cacheR));
    if (cacheW) parts.push('+' + k(cacheW) + ' new');
    return parts.join(' · ');
  }

  function appendUsageFooter(target, usage) {
    if (!target || !usage) return;
    var txt = formatUsage(usage);
    if (!txt) return;
    var footer = document.createElement('div');
    footer.style.cssText = 'margin-top:6px;font-size:10px;color:var(--text-dim,#666);opacity:0.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.2px;';
    footer.textContent = txt;
    target.appendChild(footer);
  }

  function continueAfterProposals(pendingContent, responses) {
    // Loop guard: if every tool_use this turn was an auto-tier read
    // tool, bump the consecutive-research counter. Once the model has
    // done MAX_AUTO_HOPS straight rounds of research without
    // progressing to a propose_* or to a final text answer, we abort
    // — the model is almost certainly stuck retrying narrower
    // queries against an empty/sparse catalog.
    var toolUseBlocks = (Array.isArray(pendingContent) ? pendingContent : [])
      .filter(function(b) { return b && b.type === 'tool_use'; });
    var allAutoReads = toolUseBlocks.length > 0 && toolUseBlocks.every(function(b) {
      return AUTO_READ_TOOLS[b.name];
    });
    if (allAutoReads) {
      _autoHopCount++;
      if (_autoHopCount > MAX_AUTO_HOPS) {
        var lastBubble = appendStreamingBubble();
        var ce = lastBubble && lastBubble.querySelector('[data-stream-content]');
        if (ce) {
          ce.innerHTML = '<span style="color:#fbbf24;">' +
            'I kept calling the same read tools without producing line items, ' +
            'so I stopped to avoid a runaway loop. Try giving me a more specific ' +
            'instruction — e.g., "draft the materials list using whatever\'s in the catalog, ' +
            'flag missing SKUs as TBD" — or restart the conversation.' +
            '</span>';
        }
        _streaming = false;
        setSendDisabled(false);
        return;
      }
    } else {
      // Productive turn (manual approval or mixed) — reset the counter
      // so a follow-up research burst gets its own budget.
      _autoHopCount = 0;
    }
    var body = { pending_assistant_content: pendingContent, tool_results: responses };
    // Job mode: re-attach the latest clientContext so the assistant
    // sees fresh state after the user-applied changes (e.g. updated
    // pctComplete reflects in the next reply).
    if (isJobMode()) {
      var ctx = buildJobClientContext();
      if (ctx) body.clientContext = ctx;
      // Reflect the current phase — picks up a phase flip caused by
      // the user just approving a request_build_mode card.
      body.aiPhase = getJobAIPhase(_entityId);
    }
    streamFromEndpoint(apiBase() + '/chat/continue', body);
  }

  // Card rendering — one per tool_use block, formatted by tool type.
  // Categorize a tool name into one of three action kinds so the card
  // can color-shift accordingly: green-leaning for additions, blue
  // for edits, red for destructive operations. Defaults to 'edit'.
  function cardKindFor(toolName) {
    var n = String(toolName || '');
    if (/^(propose_add|create_|attach_|wire_)/i.test(n)) return 'add';
    if (/^(propose_delete|delete_|merge_|split_|unsync)/i.test(n)) return 'remove';
    if (/^(request_build_mode|propose_link|propose_toggle|propose_switch)/i.test(n)) return 'flow';
    return 'edit';
  }
  function cardChromeFor(kind) {
    if (kind === 'add')    return { accent: '#34d399', tint: 'rgba(52,211,153,0.06)',  border: 'rgba(52,211,153,0.25)' };
    if (kind === 'remove') return { accent: '#f87171', tint: 'rgba(248,113,113,0.06)', border: 'rgba(248,113,113,0.25)' };
    if (kind === 'flow')   return { accent: '#a78bfa', tint: 'rgba(167,139,250,0.06)', border: 'rgba(167,139,250,0.25)' };
    return                       { accent: '#4f8cff', tint: 'rgba(79,140,255,0.06)',  border: 'rgba(79,140,255,0.25)' };
  }

  function renderProposalCard(tu) {
    var card = document.createElement('div');
    var chrome = cardChromeFor(cardKindFor(tu.name));
    // width:100% + box-sizing belt-and-suspenders so the card always
    // takes the column width even when the flex parent gets confused
    // (e.g. when the assistant text contains long unbroken strings or
    // a `<pre>` body that browsers shrink-wrap by default).
    // Restyled to match the newer admin look (Prompt Preview / Anthropic
    // resources / Batch detail): tinted bg + matching thin border +
    // accent left strip colored by action kind (add/edit/remove/flow).
    // Tightened from 12/14 padding to 8/10 + 6px radius so the card
    // reads as compact admin chrome, not a hero panel. The card itself
    // is a flex column with max-height; the middle detail row gets
    // flex:1 + min-height:0 so it can shrink + scroll, while header
    // and action footer stay pinned at top/bottom.
    card.style.cssText = 'background:' + chrome.tint + ';border:1px solid ' + chrome.border + ';border-left:3px solid ' + chrome.accent + ';border-radius:6px;padding:8px 10px;width:100%;box-sizing:border-box;min-width:0;display:flex;flex-direction:column;max-height:340px;overflow:hidden;';

    var heading = '';
    var detail = '';
    var input = tu.input || {};

    if (tu.name === 'propose_add_line_item') {
      heading = '&#x2795; Add line item';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.description || '') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;font-family:\'SF Mono\',monospace;">' +
          'qty ' + escapeHTMLLocal(String(input.qty)) + ' ' + escapeHTMLLocal(input.unit || 'ea') +
          ' @ $' + Number(input.unit_cost || 0).toFixed(2) +
          (input.markup_pct != null ? ' &middot; markup ' + input.markup_pct + '%' : '') +
        '</div>' +
        (input.section_name ? '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:3px;">section: ' + escapeHTMLLocal(input.section_name) + '</div>' : '');
    } else if (tu.name === 'propose_add_section') {
      heading = '&#x2795; Add section';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        (input.bt_category ? '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:3px;">BT category: ' + escapeHTMLLocal(input.bt_category) + '</div>' : '');
    } else if (tu.name === 'propose_update_scope') {
      heading = '&#x270F; Update scope (' + (input.mode || 'replace') + ')';
      var preview = (input.scope_text || '').slice(0, 280);
      if ((input.scope_text || '').length > 280) preview += '…';
      detail = '<pre style="white-space:pre-wrap;font-family:inherit;font-size:12px;margin:4px 0 0;color:var(--text,#ccc);background:rgba(0,0,0,0.2);padding:8px;border-radius:4px;max-height:160px;overflow-y:auto;">' + escapeHTMLLocal(preview) + '</pre>';
    } else if (tu.name === 'propose_delete_line_item') {
      heading = '&#x1F5D1; Delete line';
      detail = '<div style="font-size:10px;color:var(--text-dim,#888);font-family:monospace;">line: ' + escapeHTMLLocal(input.line_id || '') + '</div>';
    } else if (tu.name === 'propose_update_line_item') {
      heading = '&#x270F; Update line';
      var changes = [];
      if (input.description != null) changes.push('description → "' + input.description + '"');
      if (input.qty != null) changes.push('qty → ' + input.qty);
      if (input.unit != null) changes.push('unit → ' + input.unit);
      if (input.unit_cost != null) changes.push('unit cost → $' + Number(input.unit_cost).toFixed(2));
      if (input.markup_pct != null) changes.push('markup → ' + input.markup_pct + '%');
      else if (Object.prototype.hasOwnProperty.call(input, 'markup_pct')) changes.push('clear markup override');
      if (input.section_name) changes.push('move to section "' + input.section_name + '"');
      detail = (changes.length
        ? '<div style="font-size:12px;color:var(--text,#ccc);">' + escapeHTMLLocal(changes.join(' · ')) + '</div>'
        : '<div style="font-size:11px;color:var(--text-dim,#888);font-style:italic;">no fields specified</div>') +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;font-family:monospace;">line: ' + escapeHTMLLocal(input.line_id || '') + '</div>';
    } else if (tu.name === 'propose_delete_section') {
      heading = '&#x1F5D1; Delete section';
      detail = '<div style="font-size:11px;color:var(--text-dim,#aaa);">Lines under this section stay; they fall under whichever header now precedes them.</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;font-family:monospace;">section: ' + escapeHTMLLocal(input.section_id || '') + '</div>';
    } else if (tu.name === 'propose_update_section') {
      heading = '&#x270F; Update section';
      var sChanges = [];
      if (input.name != null) sChanges.push('rename → "' + input.name + '"');
      if (input.bt_category != null) sChanges.push('BT category → ' + input.bt_category);
      if (input.markup_pct != null) sChanges.push('markup → ' + input.markup_pct + '%');
      else if (Object.prototype.hasOwnProperty.call(input, 'markup_pct')) sChanges.push('clear markup');
      detail = (sChanges.length
        ? '<div style="font-size:12px;color:var(--text,#ccc);">' + escapeHTMLLocal(sChanges.join(' · ')) + '</div>'
        : '<div style="font-size:11px;color:var(--text-dim,#888);font-style:italic;">no fields specified</div>') +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;font-family:monospace;">section: ' + escapeHTMLLocal(input.section_id || '') + '</div>';
    } else if (tu.name === 'create_parent_company') {
      heading = '&#x1F3E2; New parent company';
      detail = '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        (input.notes ? '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">' + escapeHTMLLocal(input.notes) + '</div>' : '');
    } else if (tu.name === 'rename_client') {
      heading = '&#x270F; Rename client';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">→ <strong>' + escapeHTMLLocal(input.new_name || '') + '</strong></div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">id: ' + escapeHTMLLocal(input.client_id || '') + '</div>';
    } else if (tu.name === 'change_property_parent') {
      heading = '&#x21B7; Change parent';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">' +
        (input.new_parent_client_id ? 'New parent id: <code>' + escapeHTMLLocal(input.new_parent_client_id) + '</code>' : 'Detach (no parent)') +
        '</div><div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">property: ' + escapeHTMLLocal(input.property_client_id || '') + '</div>';
    } else if (tu.name === 'merge_clients') {
      heading = '&#x1F500; Merge duplicates';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Keep <code>' + escapeHTMLLocal(input.keep_client_id || '') + '</code></div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);">Fold in <code>' + escapeHTMLLocal(input.merge_from_client_id || '') + '</code></div>';
    } else if (tu.name === 'split_client_into_parent_and_property') {
      heading = '&#x2702; Split client';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Parent: <strong>' + escapeHTMLLocal(input.new_parent_name || '') + '</strong>' +
        (input.existing_parent_id ? ' <span style="color:var(--text-dim,#888);">(reuse existing)</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);">Property: <strong>' + escapeHTMLLocal(input.new_property_name || '') + '</strong></div>';
    } else if (tu.name === 'delete_client') {
      heading = '&#x1F5D1; Delete client';
      detail = '<div style="font-size:12px;color:#f87171;font-family:monospace;">id: ' + escapeHTMLLocal(input.client_id || '') + '</div>';
    } else if (tu.name === 'attach_business_card_to_client') {
      heading = '&#x1F4CE; Attach business card';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Save the most recent uploaded photo to this client\'s attachments.</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">client: ' + escapeHTMLLocal(input.client_id || '') + '</div>' +
        (input.caption ? '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">Caption: ' + escapeHTMLLocal(input.caption) + '</div>' : '');
    } else if (tu.name === 'propose_add_client_note' || tu.name === 'add_client_note') {
      heading = '&#x1F4DD; Save client note';
      detail = '<div style="font-size:13px;color:var(--text,#fff);background:rgba(255,255,255,0.04);padding:8px 10px;border-radius:4px;border-left:2px solid #fbbf24;">' +
          escapeHTMLLocal(input.body || '') +
        '</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:6px;">Auto-injects into AG and HR system prompts on every future turn touching this client.</div>' +
        (input.client_id ? '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">client: ' + escapeHTMLLocal(input.client_id) + '</div>' : '');
    } else if (tu.name === 'propose_skill_pack_add') {
      heading = '&#x1F9E0; Add skill pack';
      var spaAgents = Array.isArray(input.agents) ? input.agents.join(', ') : '(none)';
      var spaCtxs = Array.isArray(input.contexts) ? input.contexts.join(', ') : '(none)';
      detail = '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;">agents: ' + escapeHTMLLocal(spaAgents) + ' · contexts: ' + escapeHTMLLocal(spaCtxs) + '</div>' +
        '<pre style="white-space:pre-wrap;font-size:11px;color:var(--text-dim,#ccc);background:rgba(0,0,0,0.2);padding:8px;border-radius:4px;margin:6px 0 0;max-height:180px;overflow:auto;font-family:inherit;">' + escapeHTMLLocal(input.body || '') + '</pre>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:6px;">On-demand only: the agent loads this pack by calling load_skill_pack({name}) when relevant. Listed in the per-turn manifest by name + description.</div>';
    } else if (tu.name === 'propose_skill_pack_edit') {
      heading = '&#x270F; Edit skill pack';
      var speChanges = [];
      if (input.new_name) speChanges.push('rename → "' + input.new_name + '"');
      if (input.new_body != null) speChanges.push('body (' + (input.new_body.length || 0) + ' chars)');
      if (Array.isArray(input.agents)) speChanges.push('agents → ' + input.agents.join(','));
      if (Array.isArray(input.contexts)) speChanges.push('contexts → ' + input.contexts.join(','));
      detail = '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        (speChanges.length
          ? '<div style="font-size:12px;color:var(--text,#ccc);margin-top:4px;">' + escapeHTMLLocal(speChanges.join(' · ')) + '</div>'
          : '<div style="font-size:11px;color:var(--text-dim,#888);font-style:italic;margin-top:4px;">No fields specified.</div>') +
        (input.new_body
          ? '<pre style="white-space:pre-wrap;font-size:11px;color:var(--text-dim,#ccc);background:rgba(0,0,0,0.2);padding:8px;border-radius:4px;margin:6px 0 0;max-height:180px;overflow:auto;font-family:inherit;">' + escapeHTMLLocal(input.new_body) + '</pre>'
          : '');
    } else if (tu.name === 'propose_skill_pack_delete') {
      heading = '&#x1F5D1; Delete skill pack';
      detail = '<div style="font-size:13px;color:#f87171;font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:4px;">This pack will be removed entirely. Cannot be undone (re-add via propose_skill_pack_add).</div>';
    } else if (tu.name === 'read_workspace_sheet_full') {
      // Read-only — the auto-apply intercept normally renders this as
      // a chip without a card. This case is a safety net for older
      // cached clients that miss the intercept; user can still click
      // Approve and the apply path returns the sheet content.
      heading = '&#x1F4D6; Read full sheet';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.sheet_name || '(unspecified)') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:3px;">Read-only — returns the full sheet contents to the assistant for analysis.</div>';
    } else if (tu.name === 'set_phase_pct_complete') {
      // Look up the target locally so the card shows where the change
      // is going + the prior pct. Try phase records first (preferred)
      // then fall back to a graph node lookup since the apply path
      // accepts both ids — keeps the preview in sync with reality.
      var ph = (window.appData && (appData.phases || []).find(function(p) { return p.id === input.phase_id; })) || null;
      var bldg = ph ? (appData.buildings || []).find(function(b) { return b.id === ph.buildingId; }) : null;
      var location, oldPct;
      if (ph) {
        location = (bldg ? bldg.name + ' › ' : '') + (ph.phase || ph.name || '(unnamed)');
        oldPct = Number(ph.pctComplete || 0);
      } else {
        var pcNodes = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
        var pcNode = pcNodes.find(function(n) { return n.id === input.phase_id; });
        if (pcNode) {
          location = escapeHTMLLocal(pcNode.label || pcNode.id) +
            ' <span style="font-size:11px;color:var(--text-dim,#888);font-weight:400;">(' + escapeHTMLLocal(pcNode.type) + ' node)</span>';
          oldPct = Number(pcNode.pctComplete || 0);
        } else {
          location = '<em style="color:#fbbf24;">id ' + escapeHTMLLocal(input.phase_id) + ' (not found locally)</em>';
          oldPct = null;
        }
      }
      heading = '&#x270F; Set phase % complete';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + location + '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);margin-top:3px;">' +
          (oldPct != null ? Math.round(oldPct) + '% &rarr; ' : '') +
          '<strong style="color:#34d399;">' + Math.round(Number(input.pct_complete || 0)) + '%</strong>' +
        '</div>';
    } else if (tu.name === 'set_phase_field') {
      var ph2 = (window.appData && (appData.phases || []).find(function(p) { return p.id === input.phase_id; })) || null;
      var bldg2 = ph2 ? (appData.buildings || []).find(function(b) { return b.id === ph2.buildingId; }) : null;
      var loc2 = ph2 ? ((bldg2 ? bldg2.name + ' › ' : '') + (ph2.phase || ph2.name || '(unnamed)')) : '<em style="color:#fbbf24;">phase id ' + escapeHTMLLocal(input.phase_id) + '</em>';
      var oldVal = ph2 ? Number(ph2[input.field] || 0) : null;
      var fmt = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
      heading = '&#x270F; Set phase ' + escapeHTMLLocal(input.field);
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + loc2 + '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);margin-top:3px;">' +
          escapeHTMLLocal(input.field) + ': ' +
          (oldVal != null ? fmt(oldVal) + ' &rarr; ' : '') +
          '<strong style="color:#34d399;">' + fmt(input.amount) + '</strong>' +
        '</div>';
    } else if (tu.name === 'set_node_value') {
      // Mirror the set_phase_field card so the user sees old → new
      // before approving. Look the node up in the same place the
      // applier will (live engine first, then localStorage).
      var liveNV = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : null;
      var nvJid = (window.appState && appState.currentJobId) || null;
      var nvNodes = (Array.isArray(liveNV) && liveNV.length)
        ? liveNV
        : (function() {
            try {
              var g = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
              return (nvJid && g[nvJid] && g[nvJid].nodes) || [];
            } catch (e) { return []; }
          })();
      var nvNode = nvNodes.find(function(n) { return n.id === input.node_id; });
      if (!nvNode) {
        var lowerNV = String(input.node_id || '').trim().toLowerCase();
        nvNode = nvNodes.find(function(n) { return (n.label || '').trim().toLowerCase() === lowerNV; });
      }
      var nvOld = nvNode ? Number(nvNode.value || 0) : null;
      var fmtNV = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
      heading = '&#x1F4B5; Set node value';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' +
          escapeHTMLLocal(nvNode ? (nvNode.label || nvNode.type) : input.node_id) +
          (nvNode ? ' <span style="font-size:11px;color:var(--text-dim,#888);font-weight:400;">(' + escapeHTMLLocal(nvNode.type) + ')</span>' : '') +
        '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);margin-top:3px;">' +
          'value: ' +
          (nvOld != null ? fmtNV(nvOld) + ' &rarr; ' : '') +
          '<strong style="color:#34d399;">' + fmtNV(input.amount) + '</strong>' +
        '</div>';
    } else if (tu.name === 'create_node') {
      var typeLabels = {
        t1: 'Building (T1)', t2: 'Phase (T2)',
        labor: 'Labor', mat: 'Materials', gc: 'Gen. Conditions',
        other: 'Other', burden: 'Direct Burden',
        sub: 'Subcontractor', po: 'Purchase Order', inv: 'Invoice',
        co: 'Change Order', watch: 'Watch', note: 'Note'
      };
      // Schema renamed `type` → `node_type`; legacy fallback kept.
      var cnType = input.node_type || input.type || '?';
      var cnFmt = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); };
      var meta = [];
      if (input.value != null) meta.push('value: ' + cnFmt(input.value));
      if (input.budget != null) meta.push('budget: ' + cnFmt(input.budget));
      if (input.pct_complete != null) meta.push('% complete: ' + Math.round(Number(input.pct_complete)) + '%');
      var attachInfo = '';
      if (input.attach_to_node_id) {
        var liveCN = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
        var attachN = liveCN.find(function(n) { return n.id === input.attach_to_node_id; });
        attachInfo = '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:4px;">' +
          '&rarr; wires to <strong>' + escapeHTMLLocal(attachN ? (attachN.label || attachN.id) : input.attach_to_node_id) + '</strong>' +
        '</div>';
      }
      heading = '&#x2795; Create node';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' +
          escapeHTMLLocal(input.label || '(unnamed)') +
          ' <span style="font-size:11px;color:var(--text-dim,#888);font-weight:400;">(' +
          escapeHTMLLocal(typeLabels[cnType] || cnType) + ')</span>' +
        '</div>' +
        (meta.length
          ? '<div style="font-size:12px;color:var(--text,#ccc);margin-top:3px;">' + escapeHTMLLocal(meta.join(' · ')) + '</div>'
          : '') +
        attachInfo;
    } else if (tu.name === 'delete_node') {
      // Look up the node so the card shows what's actually being
      // removed (label + type + wire count) instead of just the
      // raw id. Falls back to label-match like the apply path.
      var liveDel = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
      var liveDelW = (typeof NG !== 'undefined' && NG.wires) ? NG.wires() : [];
      var idDel = String(input.node_id || '');
      var nodeDel = liveDel.find(function(n) { return n.id === idDel; });
      if (!nodeDel) {
        var lowDel = idDel.trim().toLowerCase();
        nodeDel = liveDel.find(function(n) { return (n.label || '').trim().toLowerCase() === lowDel; });
      }
      var wireCount = 0;
      if (nodeDel) {
        liveDelW.forEach(function(w) {
          if (w.fromNode === nodeDel.id || w.toNode === nodeDel.id) wireCount++;
        });
      }
      heading = '&#x1F5D1; Delete node';
      detail = nodeDel
        ? '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' +
            escapeHTMLLocal(nodeDel.label || nodeDel.id) +
            ' <span style="font-size:11px;color:var(--text-dim,#888);font-weight:400;">(' + escapeHTMLLocal(nodeDel.type) + ')</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:4px;">' +
            wireCount + ' attached wire' + (wireCount === 1 ? '' : 's') +
            ' will be removed. Underlying job data preserved.' +
          '</div>'
        : '<div style="font-size:12px;color:#fbbf24;">Node "' + escapeHTMLLocal(idDel) + '" not found in current graph.</div>';
    } else if (tu.name === 'wire_nodes') {
      var graphs = {};
      try { graphs = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}'); } catch (e) {}
      var jid = (window.appState && appState.currentJobId) || null;
      var nodes = (jid && graphs[jid] && graphs[jid].nodes) || [];
      var fromN = nodes.find(function(n) { return n.id === input.from_node_id; });
      var toN = nodes.find(function(n) { return n.id === input.to_node_id; });
      heading = '&#x1F50C; Wire nodes';
      detail =
        '<div style="font-size:12px;color:var(--text,#ccc);">' +
          '<strong>' + escapeHTMLLocal(fromN ? (fromN.label || fromN.type) : input.from_node_id) + '</strong>' +
          ' &rarr; ' +
          '<strong>' + escapeHTMLLocal(toN ? (toN.label || toN.type) : input.to_node_id) + '</strong>' +
        '</div>';
    } else if (tu.name === 'assign_qb_line') {
      var lines = (window.appData && appData.qbCostLines) || [];
      var line = lines.find(function(l) { return l.id === input.line_id; });
      var graphs2 = {};
      try { graphs2 = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}'); } catch (e) {}
      var jid2 = (window.appState && appState.currentJobId) || null;
      var nodes2 = (jid2 && graphs2[jid2] && graphs2[jid2].nodes) || [];
      var nodeT = nodes2.find(function(n) { return n.id === input.node_id; });
      var fmt2 = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
      heading = '&#x1F517; Assign QB line';
      detail = line
        ? '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(line.vendor || '(no vendor)') + ' &middot; ' + fmt2(line.amount) + '</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:2px;">' + escapeHTMLLocal(line.account || '') + (line.memo ? ' &middot; ' + escapeHTMLLocal(String(line.memo).slice(0, 60)) : '') + '</div>' +
          '<div style="font-size:12px;color:var(--text,#ccc);margin-top:6px;">&rarr; <strong>' + escapeHTMLLocal(nodeT ? (nodeT.label || nodeT.type) : input.node_id) + '</strong></div>'
        : '<div style="font-size:12px;color:#fbbf24;">QB line not found locally — server still has it.</div>';
    } else if (tu.name === 'propose_delete_group') {
      heading = '&#x1F5D1; Delete group';
      detail = '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.group_id || input.group_name || '') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">Group + every line under it is removed. The active group flips to the next remaining group automatically.</div>';
    } else if (tu.name === 'propose_add_group') {
      heading = '&#x271A; Add group';
      detail = '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        (input.copy_from_active ? '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">Cloning sections + line items from the currently-active group.</div>' : '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">Empty group — add line items after creation.</div>');
    } else if (tu.name === 'propose_rename_group') {
      heading = '&#x270F; Rename group';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">' +
          '<code>' + escapeHTMLLocal(input.group_id || '') + '</code> &rarr; <strong>' + escapeHTMLLocal(input.new_name || '') + '</strong>' +
        '</div>';
    } else if (tu.name === 'propose_switch_active_group') {
      heading = '&#x21B7; Switch active group';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Make <strong>' + escapeHTMLLocal(input.group_id || '') + '</strong> the active group (the one shown in totals).</div>';
    } else if (tu.name === 'propose_toggle_group_include') {
      heading = '&#x2611; Toggle group include';
      var inc = input.include === false ? 'EXCLUDE' : 'INCLUDE';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);"><strong>' + inc + '</strong> <code>' + escapeHTMLLocal(input.group_id || '') + '</code> in totals.</div>';
    } else if (tu.name === 'propose_create_lead') {
      heading = '&#x2728; Create lead';
      var titleStr = input.title || '(no title)';
      var clientStr = input.existing_client_id
        ? 'existing client <code>' + escapeHTMLLocal(input.existing_client_id) + '</code>'
        : (input.new_client && input.new_client.name
            ? 'new client <strong>' + escapeHTMLLocal(input.new_client.name) + '</strong>'
            : 'no client');
      var locStr = [input.city, input.state].filter(Boolean).join(', ');
      var notesStr = input.notes || '';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(titleStr) + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">' +
          escapeHTMLLocal(input.project_type || 'Service & Repair') +
          (locStr ? ' &middot; ' + escapeHTMLLocal(locStr) : '') +
          ' &middot; ' + clientStr +
        '</div>' +
        (notesStr ? '<div style="font-size:11px;color:var(--text,#ccc);margin-top:6px;padding:6px 8px;background:rgba(0,0,0,0.15);border-radius:4px;line-height:1.4;white-space:pre-wrap;max-height:120px;overflow-y:auto;">' + escapeHTMLLocal(notesStr) + '</div>' : '');
    } else {
      heading = '? Unknown tool: ' + tu.name;
      detail = '<pre style="font-size:11px;">' + escapeHTMLLocal(JSON.stringify(input, null, 2)) + '</pre>';
    }

    var rationale = input.rationale
      ? '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:6px;padding:6px 8px;background:rgba(0,0,0,0.18);border-radius:4px;line-height:1.4;">' +
          '<span style="display:inline-block;font-size:9px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;margin-right:6px;">Why</span>' +
          escapeHTMLLocal(input.rationale) +
        '</div>'
      : '';

    // Single-row header: action label + tool name + status pill, all in
    // one flex line so cards stay tight. The detail block below caps
    // at 220px with overflow-y so a long scope / rationale scrolls
    // inside the card instead of stretching it.
    // Keeping `data-card-status` and `data-card-actions` so existing
    // wiring + auto-apply countdown logic in the answer/timer flows
    // continue to work without changes.
    var toolPill =
      '<span style="display:inline-block;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-dim,#888);font-family:\'SF Mono\',Menlo,monospace;font-size:9px;letter-spacing:0.2px;white-space:nowrap;">' +
        escapeHTMLLocal(tu.name || '') +
      '</span>';
    var proposedPill =
      '<span style="display:inline-block;padding:1px 7px;border-radius:8px;background:' + chrome.tint + ';color:' + chrome.accent + ';font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;border:1px solid ' + chrome.border + ';white-space:nowrap;">Proposed</span>';

    card.innerHTML =
      // Header: flex-shrink:0 so it stays pinned even when middle scrolls.
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;flex-shrink:0;">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text,#fff);flex:1;min-width:0;line-height:1.25;">' + heading + '</div>' +
        proposedPill +
        toolPill +
        '<div data-card-status style="font-size:10px;font-weight:600;"></div>' +
      '</div>' +
      // Middle: flex:1 + min-height:0 lets it shrink-and-scroll inside
      // the bounded card. Without min-height:0 the flex algorithm
      // refuses to size below content height and the card stretches.
      '<div data-card-body style="flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:4px;">' +
        detail +
        rationale +
      '</div>' +
      // Footer: flex-shrink:0 so the buttons stay visible even with
      // long content above.
      '<div data-card-actions style="display:flex;gap:6px;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;">' +
        '<button data-card-approve class="success small" style="padding:3px 12px;font-size:11px;font-weight:600;">&check; Approve</button>' +
        '<button data-card-reject class="ghost small" style="padding:3px 12px;font-size:11px;">&times; Reject</button>' +
      '</div>';

    return card;
  }

  // Compact tile variant of the approval card. Used when 3+ proposals
  // of the same tool name come back in a single batch (e.g. five
  // identical "Assign QB line — server still has it" warnings). The
  // tile keeps the same `[data-card-*]` selectors so the existing
  // answer/markCardDone/isCardAnswered logic works unchanged — just a
  // tighter render. One- or two-line summary + small ✓/× buttons.
  function renderProposalTile(tu) {
    var tile = document.createElement('div');
    var tChrome = cardChromeFor(cardKindFor(tu.name));
    tile.style.cssText = 'background:' + tChrome.tint + ';border:1px solid ' + tChrome.border + ';border-left:3px solid ' + tChrome.accent + ';border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:5px;min-width:0;';

    var input = tu.input || {};
    var summary = '';
    var fmtMoney = function(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };

    if (tu.name === 'assign_qb_line') {
      var lines = (window.appData && appData.qbCostLines) || [];
      var line = lines.find(function(l) { return l.id === input.line_id; });
      var graphsT = {};
      try { graphsT = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}'); } catch (e) {}
      var jidT = (window.appState && appState.currentJobId) || null;
      var nodesT = (jidT && graphsT[jidT] && graphsT[jidT].nodes) || [];
      var nodeT = nodesT.find(function(n) { return n.id === input.node_id; });
      var nodeLabel = nodeT ? (nodeT.label || nodeT.type) : input.node_id;
      if (line) {
        summary =
          '<div style="font-size:11px;color:var(--text,#fff);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
            escapeHTMLLocal(line.vendor || '(no vendor)') + ' &middot; ' + fmtMoney(line.amount) +
          '</div>' +
          '<div style="font-size:10px;color:var(--text-dim,#aaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
            '&rarr; ' + escapeHTMLLocal(nodeLabel) +
          '</div>';
      } else {
        summary =
          '<div style="font-size:11px;color:#fbbf24;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">QB line not found locally</div>' +
          '<div style="font-size:10px;color:var(--text-dim,#aaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
            '&rarr; ' + escapeHTMLLocal(nodeLabel) +
          '</div>';
      }
    } else if (tu.name === 'set_node_value') {
      var nv = (typeof NG !== 'undefined' && NG.nodes) ? NG.nodes() : [];
      var nvN = nv.find(function(n) { return n.id === input.node_id; });
      summary =
        '<div style="font-size:11px;color:var(--text,#fff);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          escapeHTMLLocal(nvN ? (nvN.label || nvN.type) : input.node_id) +
        '</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#aaa);">' +
          (nvN ? fmtMoney(nvN.value || 0) + ' &rarr; ' : '') +
          '<strong style="color:#34d399;">' + fmtMoney(input.amount) + '</strong>' +
        '</div>';
    } else if (tu.name === 'create_node') {
      var cnType2 = input.node_type || input.type || '?';
      summary =
        '<div style="font-size:11px;color:var(--text,#fff);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          escapeHTMLLocal(input.label || '(unnamed)') +
        '</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#aaa);">' +
          escapeHTMLLocal(cnType2) +
          (input.value != null ? ' &middot; ' + fmtMoney(input.value) : '') +
        '</div>';
    } else if (tu.name === 'wire_nodes') {
      var graphsW = {};
      try { graphsW = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}'); } catch (e) {}
      var jidW = (window.appState && appState.currentJobId) || null;
      var nodesW = (jidW && graphsW[jidW] && graphsW[jidW].nodes) || [];
      var fromW = nodesW.find(function(n) { return n.id === input.from_node_id; });
      var toW = nodesW.find(function(n) { return n.id === input.to_node_id; });
      summary =
        '<div style="font-size:11px;color:var(--text,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          '<strong>' + escapeHTMLLocal(fromW ? (fromW.label || fromW.type) : input.from_node_id) + '</strong>' +
          ' &rarr; <strong>' + escapeHTMLLocal(toW ? (toW.label || toW.type) : input.to_node_id) + '</strong>' +
        '</div>';
    } else {
      // Fallback for any other groupable tool — show name + a small
      // signature so the user can at least tell tiles apart.
      var sig = input.label || input.name || input.id || JSON.stringify(input).slice(0, 40);
      summary =
        '<div style="font-size:11px;color:var(--text,#fff);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          escapeHTMLLocal(String(sig)) +
        '</div>';
    }

    tile.innerHTML =
      '<div data-card-status style="font-size:10px;font-weight:600;min-height:0;"></div>' +
      summary +
      '<div data-card-actions style="display:flex;gap:4px;margin-top:2px;">' +
        '<button data-card-approve class="success small" title="Approve" style="padding:2px 8px;font-size:11px;flex:1;">&check;</button>' +
        '<button data-card-reject class="ghost small" title="Reject" style="padding:2px 8px;font-size:11px;flex:1;">&times;</button>' +
      '</div>';
    return tile;
  }

  function markCardDone(card, approved, summary) {
    var status = card.querySelector('[data-card-status]');
    var actions = card.querySelector('[data-card-actions]');
    if (actions) actions.remove();
    if (status) {
      status.style.color = approved ? '#34d399' : '#f87171';
      status.textContent = approved ? '✓ Applied' : '✗ Rejected';
    }
    card.style.opacity = approved ? '1' : '0.55';
    card.style.borderLeftColor = approved ? '#34d399' : '#f87171';
  }

  function isCardAnswered(card) {
    return !card.querySelector('[data-card-actions]');
  }

  function scrollToBottom() {
    var box = document.getElementById('ai-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  // Read SSE chunks from a fetch response. Delegates to onChunk for each
  // `data: ...\n\n` payload until `[DONE]`. SSE in JS without EventSource
  // is just newline-delimited parsing.
  function readSSEStream(response, onChunk) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function(result) {
        if (result.done) return;
        buffer += decoder.decode(result.value, { stream: true });
        var parts = buffer.split('\n\n');
        buffer = parts.pop(); // last is incomplete
        parts.forEach(function(part) {
          var line = part.replace(/^data: /, '').trim();
          if (!line || line === '[DONE]') return;
          try {
            var payload = JSON.parse(line);
            onChunk(payload);
          } catch (e) { /* ignore malformed chunk */ }
        });
        return pump();
      });
    }
    return pump();
  }

  function setSendDisabled(disabled) {
    var btn = document.getElementById('ai-send');
    if (btn) {
      btn.disabled = disabled;
      // Dim the paper-plane while a request is in flight.
      btn.style.opacity = disabled ? '0.45' : '1';
    }
    var input = document.getElementById('ai-input');
    if (input) input.disabled = disabled;
  }

  // ──────────────────────────────────────────────────────────────────
  // File attachments composer — + and 📷 buttons.
  //
  // Flow per mode:
  //   estimate / job / lead
  //     image  → upload to that entity's attachments (real persistence),
  //              chip in pill with view link, AI sees it via context
  //     pdf    → upload to entity attachments AND render pages client-side
  //              into _pendingImages so the AI can read them as vision
  //   client (HR — customer relations)
  //     image  → no persistence (no client_id chosen yet); send as
  //              one-shot inline vision image so the AI can read e.g.
  //              a business card. Future tool will let the agent attach
  //              the staged image to the client it identifies.
  //     pdf    → render pages, attach as one-shot vision images
  //
  // Pending uploads are cleared on send.
  // ──────────────────────────────────────────────────────────────────
  // Tracks pending composer attachments — the chips currently visible in
  // the pill. Each entry: {id, kind:'image'|'pdf', filename, attachmentId?,
  // viewUrl?, base64Images:[]}
  var _pendingComposer = [];

  // Live camera capture modal. On desktop with a webcam (or mobile
  // through HTTPS with permission), opens a video preview overlay
  // with Capture / Cancel buttons. The captured frame is wrapped in
  // a File and routed through the existing handleSelectedFiles
  // pipeline so the AI sees it the same as any other photo.
  // Falls back to the native file input with capture="environment"
  // on environments where getUserMedia is unavailable or denied —
  // that path still launches the system camera UI on iOS / Android.
  function openCameraCapture(cameraInput) {
    var nav = (typeof navigator !== 'undefined') ? navigator : null;
    var hasMediaDevices = nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function';
    if (!hasMediaDevices) {
      // No getUserMedia at all — try the native input.
      cameraInput.value = '';
      cameraInput.click();
      return;
    }

    // Build the modal up front so even a denied / errored stream
    // gives the user something to dismiss instead of a flicker.
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.85);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'padding:20px;box-sizing:border-box;';

    var frame = document.createElement('div');
    frame.style.cssText =
      'background:#0f0f12;border:1px solid #2a2a30;border-radius:8px;padding:14px;' +
      'max-width:min(720px,calc(100vw - 40px));width:100%;display:flex;' +
      'flex-direction:column;gap:12px;align-items:stretch;';

    var heading = document.createElement('div');
    heading.textContent = 'Take a photo';
    heading.style.cssText =
      'font-size:14px;font-weight:600;color:#fff;display:flex;align-items:center;gap:8px;';

    var status = document.createElement('div');
    status.textContent = 'Connecting to camera…';
    status.style.cssText = 'font-size:12px;color:#9aa;';

    var video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.cssText =
      'width:100%;max-height:60vh;border-radius:6px;background:#000;display:none;';

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'ee-btn secondary';

    var captureBtn = document.createElement('button');
    captureBtn.type = 'button';
    captureBtn.textContent = '● Capture';
    captureBtn.className = 'ee-btn';
    captureBtn.style.cssText = 'background:#34d399;color:#0a0a0a;font-weight:600;border:none;';
    captureBtn.disabled = true;

    actions.appendChild(cancelBtn);
    actions.appendChild(captureBtn);
    frame.appendChild(heading);
    frame.appendChild(status);
    frame.appendChild(video);
    frame.appendChild(actions);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    var stream = null;
    function teardown() {
      if (stream) {
        try { stream.getTracks().forEach(function(t) { t.stop(); }); }
        catch (e) { /* ignore */ }
        stream = null;
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    cancelBtn.onclick = teardown;

    // Esc to dismiss — track and clean up so we don't leak listeners
    // or fight other modals that bind global keys.
    function onKey(e) {
      if (e.key === 'Escape') { teardown(); document.removeEventListener('keydown', onKey, true); }
    }
    document.addEventListener('keydown', onKey, true);

    captureBtn.onclick = function() {
      if (!stream || !video.videoWidth || !video.videoHeight) return;
      var canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function(blob) {
        if (!blob) { teardown(); return; }
        var d = new Date();
        var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
        var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
        var name = 'photo-' + stamp + '.jpg';
        var file;
        try { file = new File([blob], name, { type: blob.type || 'image/jpeg' }); }
        catch (err) { blob.name = name; file = blob; }
        // Mimic FileList for handleSelectedFiles which iterates by index.
        handleSelectedFiles([file]);
        teardown();
        document.removeEventListener('keydown', onKey, true);
      }, 'image/jpeg', 0.92);
    };

    // Prefer the rear camera when one exists (most useful for Project 86 —
    // PMs photographing buildings / SOWs / receipts in the field),
    // but accept any camera the device offers.
    var constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
    nav.mediaDevices.getUserMedia(constraints).then(function(s) {
      stream = s;
      video.srcObject = s;
      video.style.display = 'block';
      status.style.display = 'none';
      captureBtn.disabled = false;
    }).catch(function(err) {
      // Common reasons: permission denied, no camera, insecure
      // context. Fall back to the native input which on mobile still
      // launches the system camera, and on desktop opens a file
      // picker (better than nothing).
      console.warn('Camera access denied or unavailable:', err && err.message);
      teardown();
      document.removeEventListener('keydown', onKey, true);
      cameraInput.value = '';
      cameraInput.click();
    });
  }

  function setupFileAttachments(panel) {
    var attachBtn = panel.querySelector('#ai-attach');
    var cameraBtn = panel.querySelector('#ai-camera');
    var fileInput = panel.querySelector('#ai-file-input');
    var cameraInput = panel.querySelector('#ai-camera-input');
    var textInput = panel.querySelector('#ai-input');
    var pill = panel.querySelector('#ai-input-pill');
    if (!attachBtn || !fileInput) return;

    attachBtn.onclick = function() { fileInput.value = ''; fileInput.click(); };
    if (cameraBtn && cameraInput) {
      // Camera button now opens a live camera preview via getUserMedia
      // when available (desktop with webcam, modern mobile browsers
      // through HTTPS). Fall back to the native file input with
      // capture="environment" if getUserMedia fails — that path still
      // launches the system camera UI on iOS / Android.
      cameraBtn.onclick = function() { openCameraCapture(cameraInput); };
      cameraInput.onchange = function(e) { handleSelectedFiles(e.target.files); };
    }
    fileInput.onchange = function(e) { handleSelectedFiles(e.target.files); };

    // Clipboard paste — pull image data out of paste events and route
    // through the same handleSelectedFiles pipeline as the + button.
    // Clipboard images come in with an empty/generic filename ("image.png"),
    // so we rename them to "pasted-YYYY-MM-DD_HH-MM-SS.<ext>" before
    // upload — that way the attachment list reads as a meaningful audit
    // trail of when each screenshot was dropped in.
    function handlePaste(e) {
      if (!e || !e.clipboardData) return;
      var items = e.clipboardData.items;
      if (!items || !items.length) return;
      var pastedFiles = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
          var blob = item.getAsFile();
          if (!blob) continue;
          var ext = (item.type.split('/')[1] || 'png').toLowerCase();
          if (ext === 'jpeg') ext = 'jpg';
          var d = new Date();
          var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
          var stamp =
            d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
          var name = 'pasted-' + stamp + '.' + ext;
          // File constructor lets us rename a blob in one shot. Falls back
          // to assigning the renamed blob through the original path if File
          // isn't constructible (very old browsers — Chrome / Edge / Safari
          // / Firefox have all supported it for years).
          try {
            pastedFiles.push(new File([blob], name, { type: blob.type || item.type }));
          } catch (err) {
            // Fallback: tag the blob with a name property so handleSelectedFiles
            // can read it. handleSelectedFiles uses file.name and file.type.
            blob.name = name;
            pastedFiles.push(blob);
          }
        }
      }
      if (pastedFiles.length) {
        // Suppress the textarea's default paste handling so a "Pasted image"
        // placeholder string doesn't end up inside the message body.
        e.preventDefault();
        // Stop the event from bubbling up to the pill listener — without
        // this, both handlers would fire and the same image would be
        // attached twice (the AI then sees doubles and sometimes returns
        // an empty response).
        e.stopPropagation();
        handleSelectedFiles(pastedFiles);
      }
      // If no images were on the clipboard we let the default text-paste
      // run normally — typical Ctrl+V of copied text is unaffected.
    }

    if (textInput) textInput.addEventListener('paste', handlePaste);
    // Also listen on the pill container so a click anywhere inside the
    // input area + Ctrl+V works even when the textarea isn't focused.
    // Paste events from the textarea call stopPropagation above, so this
    // only fires when the focus target is the pill itself.
    if (pill) pill.addEventListener('paste', handlePaste);
  }

  function handleSelectedFiles(fileList) {
    if (!fileList || !fileList.length) return;
    var files = Array.from(fileList);
    files.forEach(function(file) {
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      var isPdf = file.type === 'application/pdf' || ext === 'pdf';
      var isImage = !!(file.type && file.type.indexOf('image/') === 0) || /^(jpe?g|png|gif|webp|heic)$/.test(ext);
      if (!isPdf && !isImage) {
        alert('Unsupported file type: ' + file.name + '. Use an image or PDF.');
        return;
      }
      var entry = {
        id: 'pa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        kind: isPdf ? 'pdf' : 'image',
        filename: file.name,
        sizeBytes: file.size,
        status: 'processing',
        attachmentId: null,
        viewUrl: null,
        base64Images: []
      };
      _pendingComposer.push(entry);
      renderAttachmentsStrip();
      processFile(entry, file);
    });
  }

  function processFile(entry, file) {
    var supportsAttach = (_entityType === 'estimate' || _entityType === 'job' || _entityType === 'lead') && _entityId && _entityId !== '__global__';
    var jobs = [];
    // 1. Persist to entity attachments where it makes sense.
    if (supportsAttach && window.p86Api && window.p86Api.attachments) {
      jobs.push(
        window.p86Api.attachments.upload(_entityType, _entityId, file).then(function(res) {
          var att = res.attachment || res;
          entry.attachmentId = att.id;
          entry.viewUrl = att.web_url || att.original_url || null;
        }).catch(function(err) {
          entry.uploadError = err.message || 'Upload failed';
        })
      );
    }
    // 2. For PDFs, render pages client-side so the AI can see them this turn.
    if (entry.kind === 'pdf') {
      jobs.push(renderPdfFileToBase64(file).then(function(images) {
        entry.base64Images = images;
      }).catch(function(err) {
        entry.uploadError = err.message || 'PDF render failed';
      }));
    } else if (entry.kind === 'image') {
      // For images we ALSO push the raw bytes inline as one-shot vision so
      // the AI sees the just-uploaded photo without waiting for the next
      // round of context loading. (For estimate/job/lead it'll also come
      // in via the entity context; for client mode it's the only path.)
      jobs.push(fileToBase64(file).then(function(b64) {
        entry.base64Images = [b64];
      }).catch(function(err) {
        entry.uploadError = err.message || 'Image read failed';
      }));
    }
    Promise.all(jobs).then(function() {
      entry.status = entry.uploadError ? 'error' : 'ready';
      renderAttachmentsStrip();
    });
  }

  function fileToBase64(file) {
    return new Promise(function(resolve, reject) {
      var fr = new FileReader();
      fr.onload = function() {
        var s = String(fr.result || '');
        var i = s.indexOf('base64,');
        resolve(i >= 0 ? s.slice(i + 7) : s);
      };
      fr.onerror = function() { reject(new Error('Could not read file')); };
      fr.readAsDataURL(file);
    });
  }

  function renderPdfFileToBase64(file) {
    if (!window.pdfjsLib) return Promise.reject(new Error('PDF library not loaded'));
    return file.arrayBuffer().then(function(buf) {
      return window.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function(pdf) {
      var pageCount = Math.min(pdf.numPages, 10);
      var promises = [];
      for (var i = 1; i <= pageCount; i++) {
        promises.push(pdf.getPage(i).then(function(page) {
          var viewport = page.getViewport({ scale: 1.5 });
          var canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          var ctx = canvas.getContext('2d');
          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function() {
            var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            return dataUrl.slice(dataUrl.indexOf('base64,') + 7);
          });
        }));
      }
      return Promise.all(promises);
    });
  }

  function renderAttachmentsStrip() {
    var strip = document.getElementById('ai-attachments-strip');
    if (!strip) return;
    if (!_pendingComposer.length) {
      strip.style.display = 'none';
      strip.innerHTML = '';
      return;
    }
    strip.style.display = 'flex';
    strip.innerHTML = '';
    _pendingComposer.forEach(function(e) {
      var glyph = e.kind === 'pdf' ? '📄' : '🖼';
      var status = e.status === 'processing'
        ? '<span style="color:var(--text-dim,#888);font-size:10px;">processing…</span>'
        : (e.status === 'error'
          ? '<span style="color:#f87171;font-size:10px;">' + escapeHTMLLocal(e.uploadError || 'failed') + '</span>'
          : '<span style="color:#34d399;font-size:10px;">ready</span>');
      var chip = document.createElement('div');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-radius:12px;font-size:11px;color:var(--text,#ddd);';
      chip.innerHTML =
        '<span style="font-size:13px;">' + glyph + '</span>' +
        '<span style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTMLLocal(e.filename) + '</span>' +
        status +
        (e.viewUrl ? '<a href="' + e.viewUrl + '" target="_blank" rel="noopener" title="Open" style="color:#4f8cff;text-decoration:none;font-size:11px;">↗</a>' : '') +
        '<button data-remove="' + e.id + '" title="Remove" style="background:transparent;border:none;color:var(--text-dim,#888);cursor:pointer;font-size:13px;padding:0 2px;line-height:1;">×</button>';
      strip.appendChild(chip);
    });
    strip.querySelectorAll('[data-remove]').forEach(function(b) {
      b.onclick = function() {
        var id = b.getAttribute('data-remove');
        _pendingComposer = _pendingComposer.filter(function(e) { return e.id !== id; });
        renderAttachmentsStrip();
      };
    });
  }

  // Web Speech API mic wiring. Toggles dictation on/off; appends each
  // final transcript chunk to the textarea so the user can see what the
  // browser heard before sending. Hides the mic button on browsers that
  // don't support SpeechRecognition (Firefox without flags).
  //
  // Three operational rules (matching Claude.ai's mic UX):
  //   1. Auto-stop after a brief silence so the mic doesn't keep
  //      listening forever after the user finishes.
  //   2. Stop on send — clicking ▲ Send (or hitting Enter) ends
  //      dictation so the next utterance starts fresh, not appended.
  //   3. Reset transcript baseline on each fresh start. Without this,
  //      a partial transcript from the prior dictation can echo back
  //      because baseValue still references the pre-send input text.
  var _recognition = null;
  var _isListening = false;
  // Module-level handle so onSend can stop dictation without poking
  // into setupVoiceInput's closure. Defaults to a no-op so callers
  // don't have to null-check.
  var _stopDictation = function() {};
  // Auto-stop on silence — Web Speech API's `continuous: true` keeps
  // listening across pauses, but UX-wise we want the mic to stop
  // after ~3s of no new transcripts so the user doesn't have to
  // remember to toggle it off.
  var SILENCE_TIMEOUT_MS = 3000;
  function setupVoiceInput(panel) {
    var micBtn = panel.querySelector('#ai-mic');
    if (!micBtn) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtn.style.display = 'none';
      return;
    }
    micBtn.onclick = function() {
      if (_isListening) { stopListening(); return; }
      startListening();
    };
    var silenceTimer = null;
    var lastResultTs = 0;
    function startListening() {
      try {
        _recognition = new SR();
        _recognition.continuous = true;
        _recognition.interimResults = true;
        _recognition.lang = navigator.language || 'en-US';
        var baseValue = '';
        _recognition.onstart = function() {
          _isListening = true;
          var input = document.getElementById('ai-input');
          // Capture FRESH baseline on each start. If the input was
          // cleared by send between dictations, baseValue is empty —
          // fixing the "old transcript echoes back" bug.
          baseValue = input ? input.value : '';
          if (baseValue && !/\s$/.test(baseValue)) baseValue += ' ';
          micBtn.style.background = 'rgba(248,113,113,0.18)';
          micBtn.style.color = '#f87171';
          micBtn.title = 'Stop dictation';
          // Start the silence watchdog. Polls every 500ms; if no new
          // result events have landed in SILENCE_TIMEOUT_MS, we stop.
          lastResultTs = Date.now();
          if (silenceTimer) clearInterval(silenceTimer);
          silenceTimer = setInterval(function() {
            if (!_isListening) return;
            if (Date.now() - lastResultTs > SILENCE_TIMEOUT_MS) {
              stopListening();
            }
          }, 500);
        };
        _recognition.onresult = function(e) {
          // Reset the silence countdown on every result (interim too)
          // so as long as the user is mid-sentence the mic stays open.
          lastResultTs = Date.now();
          var final = '';
          var interim = '';
          for (var i = e.resultIndex; i < e.results.length; i++) {
            var t = e.results[i][0].transcript;
            if (e.results[i].isFinal) final += t;
            else interim += t;
          }
          var input = document.getElementById('ai-input');
          if (input) {
            input.value = baseValue + final + interim;
            input.dispatchEvent(new Event('input'));
            if (final) baseValue += final;
          }
        };
        _recognition.onerror = function(ev) {
          stopListening();
          if (ev && ev.error === 'not-allowed') {
            alert('Microphone access denied. Allow it in your browser settings to dictate.');
          }
        };
        _recognition.onend = function() { stopListening(); };
        _recognition.start();
      } catch (e) {
        alert('Could not start dictation: ' + (e.message || e));
        stopListening();
      }
    }
    function stopListening() {
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
      if (_recognition) {
        try { _recognition.stop(); } catch (e) { /* ignore */ }
        _recognition = null;
      }
      _isListening = false;
      micBtn.style.background = 'transparent';
      micBtn.style.color = 'var(--text-dim,#888)';
      micBtn.title = 'Dictate (voice → text)';
    }
    // Expose the stop function so onSend can shut dictation off when
    // the user submits — prevents the next utterance from echoing the
    // pre-send transcript via stale baseValue.
    _stopDictation = stopListening;
  }

  function countCurrentPhotos() {
    // Best effort — we don't track photo state here, but we can read it
    // off the editor's currently-open list. The server is authoritative.
    if (!_estimateId) return 0;
    return 0; // placeholder; the count chip is informational only
  }

  // CSS for the cursor blink + body shift — appended once
  if (!document.getElementById('p86-ai-css')) {
    var style = document.createElement('style');
    style.id = 'p86-ai-css';
    style.textContent =
      '@keyframes p86-blink { from, to { opacity: 1; } 50% { opacity: 0; } } ' +
      '@keyframes p86-mic-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } } ' +
      // Cloud emoji bobs gently up + down while the agent is thinking,
      // and the phrase caption fades when it rotates so the user has
      // continuous proof-of-life even when an auto-tier tool is taking
      // a few seconds. Pure CSS — no GIF, no extra asset, dark-mode safe.
      '@keyframes p86-cloud-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } } ' +
      '@keyframes p86-phrase-fade { 0% { opacity: 0; transform: translateY(2px); } 20%, 100% { opacity: 1; transform: translateY(0); } } ' +
      '.p86-cloud-anim { display: inline-block; animation: p86-cloud-bob 2.4s ease-in-out infinite; } ' +
      '.p86-phrase { display: inline-block; animation: p86-phrase-fade 0.45s ease-out; } ' +
      '.ai-content p:first-child { margin-top: 0; } ' +
      '.ai-content p:last-child { margin-bottom: 0; } ' +
      // Hide scrollbar entirely on the input textarea — it grows up to its
      // cap, beyond which arrow keys still navigate. No visible chrome.
      '#ai-input { scrollbar-width: none; -ms-overflow-style: none; } ' +
      '#ai-input::-webkit-scrollbar { display: none; width: 0; height: 0; } ' +
      // Ghost scrollbars on the messages area + presets — dark, narrow,
      // only visible while actively scrolling.
      '#p86-ai-panel ::-webkit-scrollbar { width: 6px; height: 6px; } ' +
      '#p86-ai-panel ::-webkit-scrollbar-track { background: transparent; } ' +
      '#p86-ai-panel ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 3px; transition: background 0.2s; } ' +
      '#p86-ai-panel ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.14); } ' +
      '#p86-ai-panel { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.06) transparent; } ' +
      // Shared style for the input toolbar action buttons (attach,
      // camera, mic). Compact + transparent at rest, subtle fill on
      // hover. Per-button font-size set inline since each glyph wants
      // a different size.
      '.ai-tool-btn { background: transparent; border: 0; color: var(--text-dim,#888); ' +
        'width: 28px; height: 28px; border-radius: 8px; cursor: pointer; ' +
        'display: inline-flex; align-items: center; justify-content: center; ' +
        'padding: 0; transition: background 0.12s, color 0.12s; } ' +
      '.ai-tool-btn:hover { background: rgba(79,140,255,0.10); color: var(--text,#fff); } ' +
      '#ai-send { transition: transform 0.12s, opacity 0.12s; } ' +
      '#ai-send:hover:not(:disabled) { transform: translateY(-1px); opacity: 0.92; } ' +
      '#ai-send:disabled { opacity: 0.5; cursor: not-allowed; } ' +
      // When the panel is open, push the page content over so the
      // editor + sticky totals stay fully visible alongside the panel
      // (otherwise the rightmost totals chips get hidden behind the
      // 420px-wide overlay). Smooth transition keeps the shift from
      // feeling jarring.
      'body.p86-ai-open { padding-right: 420px; transition: padding-right 0.22s ease; } ' +
      // On narrow screens fall back to the overlay behavior — no point
      // shoving a tablet's content into a 200px column.
      '@media (max-width: 1100px) { body.p86-ai-open { padding-right: 0; } }';
    document.head.appendChild(style);
  }

  // One-shot inline images attached to the next message. Set by
  // openWithImages(); cleared after the next sendMessage so the images
  // don't ride along on every subsequent turn.
  var _pendingImages = null;

  // Open the panel for an entity AND attach a one-shot batch of images
  // (e.g., rendered PDF pages from the viewer) to the next outgoing
  // message. Used by the PDF viewer's "Ask AI" button.
  function openWithImages(opts) {
    opts = opts || {};
    if (!opts.entityType || !opts.entityId) {
      alert('Open an estimate or lead first.');
      return;
    }
    if (Array.isArray(opts.images) && opts.images.length) {
      _pendingImages = {
        images: opts.images.slice(0, 12), // hard cap matches Anthropic per-request limit
        note: opts.imagesNote || null
      };
    }
    open({ entityType: opts.entityType, entityId: opts.entityId });
    if (opts.prefill) {
      setTimeout(function() {
        var input = document.getElementById('ai-input');
        if (input) {
          input.value = opts.prefill;
          // Trigger auto-grow by dispatching an input event
          input.dispatchEvent(new Event('input'));
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }, 260);
    }
  }

  window.p86AI = {
    open: open,
    openWithImages: openWithImages,
    close: close,
    toggle: toggle,
    isOpen: function() { return _open; },
    // Re-render the AG header + notice when the editor's Plan/Build
    // pill flips. Cheap call (just two DOM text writes).
    refreshPhaseChip: function() { try { refreshModeSpecificUI(); } catch (e) {} }
  };

  // Sticky-header shim mirroring openEstimateAI() — finds the active job id
  // from the workspace state and opens the panel against it. Lives here so
  // wip.js doesn't need to know about p86AI's internals.
  window.openJobAI = function() {
    var jobId = (window.appState && window.appState.currentJobId) || null;
    if (!jobId) { alert('Open a job first.'); return; }
    open({ entityType: 'job', entityId: jobId });
  };

  // Client-directory entry point. No entity ID — the directory IS the
  // context. Pages that want a refresh after the assistant changes things
  // can register window.refreshClientsAfterAI.
  window.openClientAI = function() {
    open({ entityType: 'client' });
  };

  // Lead Intake entry point. Singleton (no entity id) but
  // forceReinit'd on every open so each panel-open is a fresh
  // conversation. Pages that want the leads list to refresh after a
  // new lead lands can register window.refreshLeadsAfterAI.
  window.openIntakeAI = function() {
    // Intake runs through 86 now — gate on agent_mode_job, not
    // a separate intake flag. The /v2/intake/* routes still exist
    // for this entry point but they call into 86's managed agent.
    var u = (window.p86Auth && window.p86Auth.getUser) ? window.p86Auth.getUser() : null;
    var enabled = !!(u && u.feature_flags && u.feature_flags.agent_mode_job === 'agents');
    if (!enabled) {
      alert('Lead Intake AI is disabled. Set AGENT_MODE_86=agents in the server env to enable (intake runs through 86).');
      return;
    }
    open({ entityType: 'intake' });
  };
})();
