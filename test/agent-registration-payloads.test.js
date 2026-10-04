'use strict';

// WHY THIS FILE EXISTS
//
// beta.agents exposes create / retrieve / update / list / archive and NO
// DELETE. Every update mints a new immutable version from the payload it is
// handed. Put together, a create or update that omits a field is not a missed
// optimisation — it is an irreversible one, and the field most often omitted
// was mcp_servers, which is where the org's MCP connectors live.
//
// Three sites were omitting it, and the worst was not the obvious one. The
// archived-recreate inside /managed/sync-all was the finding everyone repeated,
// but the UPDATE branch beside it — the branch that runs on the ROUTINE path,
// every time anyone syncs after a tool, baseline or skill change — omitted it
// too. And POST /managed/reregister, the "force a fresh agent" button, omitted
// it alongside three other defects: the global default model instead of the
// per-agent one (silently promoting the scribe onto 86's model), the platform
// baseline instead of the composed system (so a reregistered 86 lost
// org.identity_body, org_memory and the reference index), and a hardcoded name
// instead of managedAgentName.
//
// This is a SOURCE-LEVEL assertion, which is a weak form — see
// test/vacuous-assertions-style guards elsewhere in this suite. It is used here
// because the alternative is calling Anthropic, and the whole point is the
// calls that must never be made wrong. So it is written to fail loudly if the
// surface it inspects changes shape: the site count is pinned, the exemption is
// named individually, and a regex that stops matching fails rather than
// reporting zero problems.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server', 'routes', 'admin-agents-routes.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const LINES = SRC.split(/\r?\n/);

// Every create/update call, with the line it is on.
function callSites() {
  const out = [];
  LINES.forEach((text, i) => {
    const trimmed = text.trim();
    // Prose mentions the API constantly — "Anthropic's beta.agents.update()
    // lets us push…" matched and then resolved to no payload, which surfaced
    // as eighteen unreadable sites rather than as a filter I had forgotten.
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const m = text.match(/anthropic\.beta\.agents\.(create|update)\(/);
    if (m) out.push({ line: i + 1, verb: m[1], text: trimmed });
  });
  return out;
}

// A route's body, bounded by the NEXT router declaration. Slicing a fixed
// number of characters instead let a later route's text answer for this one:
// the reregister window ran past its own end and found defaultModel() in the
// route below, so the assertion failed against code that was already fixed.
function routeBody(declaration) {
  const at = SRC.indexOf(declaration);
  if (at === -1) return '';
  const rest = SRC.slice(at + declaration.length);
  const next = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

// Comment lines removed, because these assertions are about CODE.
//
// Without this, "the route must not contain aiInternals.defaultModel" failed
// against the comment that explains why aiInternals.defaultModel was removed —
// a guard that cannot tell a defect from its own post-mortem will block every
// future commit that documents what it fixed. Whole-line comments only: a
// trailing-comment stripper would have to understand strings, and there is no
// `//` inside a string literal in the bodies this inspects.
function codeOnly(text) {
  return String(text).split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

// The text a call site's payload could plausibly be built from: the lines just
// above it (where a named payload is assembled) plus its own (where an inline
// literal lives).
//
// This is deliberately a WINDOW rather than a parser. The first version
// resolved `const X = {` and inline literals only, and reported four sites as
// unreadable — because real payloads here are also built with
// `Object.assign({ tools }, baseUpdate)` and by a helper
// (`probe.buildProbePayload(set, parts)`). Writing an expression resolver to
// police four call sites is more code than the thing it polices, and every line
// of it is a new way for the guard to be wrong. The window is coarse; the
// per-route assertions further down carry the precision.
const WINDOW_ABOVE = 45;
const WINDOW_BELOW = 25;

function payloadWindow(site) {
  const from = Math.max(0, site.line - 1 - WINDOW_ABOVE);
  const to = Math.min(LINES.length, site.line + WINDOW_BELOW);
  return LINES.slice(from, to).join('\n');
}

describe('the registration surface is actually being inspected', () => {
  // Vacuity guards. Every assertion below is worthless against an empty or
  // renamed surface, and renaming is exactly what a refactor does.
  test('the scan finds the call sites it is meant to police', () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(sites.filter(s => s.verb === 'create').length).toBeGreaterThanOrEqual(4);
    expect(sites.filter(s => s.verb === 'update').length).toBeGreaterThanOrEqual(4);
  });

  test('every site has a readable window around it', () => {
    // Not a parser check — just that the file is long enough around each call
    // for the window to mean anything. A one-line window would make the
    // mcp_servers test below pass by accident.
    for (const s of callSites()) {
      expect(payloadWindow(s).split('\n').length).toBeGreaterThan(20);
    }
  });

  test('collectMcpServersFor still exists and is what supplies the field', () => {
    expect(SRC).toContain('async function collectMcpServersFor(');
    expect(SRC).toContain('FROM org_mcp_servers');
  });
});

describe('no agent is registered without its MCP connectors', () => {
  // THE ONE EXEMPTION, named explicitly rather than pattern-matched.
  //
  // The prefix probe (services/prefix-probe.js, driven from /managed/prefix-
  // probe) registers THROWAWAY agents carrying a deliberately known subset of
  // components and measures the difference between sets. Adding the org's MCP
  // servers to those payloads would add an unmeasured component to every set
  // and corrupt the one instrument in this repo that can weigh the registered
  // prefix. It also never touches a live registry row, and it archives what it
  // creates.
  const EXEMPT_REASON = 'prefix probe — throwaway agent, deliberately a known subset';

  function isProbeSite(site) {
    const window = LINES.slice(Math.max(0, site.line - 30), site.line).join('\n');
    return /buildProbePayload|PROBE_SETS|probe\./.test(window);
  }

  test('every create and update carries mcp_servers, or is the probe', () => {
    const offenders = [];
    for (const site of callSites()) {
      if (isProbeSite(site)) continue;
      if (!/mcp_servers/.test(payloadWindow(site))) {
        offenders.push(site.verb + ' at :' + site.line + ' — ' + site.text.slice(0, 70));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the probe really is exempt for the stated reason, and is the only one', () => {
    const exempt = callSites().filter(isProbeSite);
    expect(exempt.length).toBeGreaterThanOrEqual(1);
    expect(EXEMPT_REASON).toContain('throwaway');
    // The probe's own payload builder must NOT have grown mcp_servers, or the
    // measurement it exists to take is no longer apples-to-apples.
    const probeSrc = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'prefix-probe.js'), 'utf8');
    expect(probeSrc).not.toContain('mcp_servers');
  });
});

describe('reregister builds the same agent the canonical path builds', () => {
  // The four defects, each pinned by the thing that fixes it. These are
  // separate assertions on purpose: a single "the route is correct now" test
  // would go green on three of four.
  const ROUTE = codeOnly(routeBody("router.post('/managed/reregister'"));

  test('the route body was actually located', () => {
    expect(ROUTE.length).toBeGreaterThan(500);
    expect(ROUTE).toContain('agents.create');
  });

  test('the per-agent model, not the global default', () => {
    expect(ROUTE).toContain('modelForAgentKey(key)');
    // defaultModel() here is what promoted the scribe onto 86's model.
    expect(ROUTE).not.toContain('aiInternals.defaultModel');
  });

  test('the composed system, not the bare platform baseline', () => {
    expect(ROUTE).toContain('composedAgentSystem(key, baseline, organization)');
  });

  test('the per-tenant agent name', () => {
    expect(ROUTE).toContain('managedAgentName(key, organization)');
    expect(ROUTE).not.toContain("'Project 86 ' + key.toUpperCase()");
  });

  test('the MCP connectors', () => {
    expect(ROUTE).toContain('collectMcpServersFor(organization)');
    expect(ROUTE).toContain('createPayload.mcp_servers = mcpServers');
  });

  test('it loads the organization, because the route only has an org id', () => {
    // requireOrgId populates req.orgId and NOT req.organization, so every
    // per-tenant field above needs the row.
    expect(ROUTE).toContain('require(\'../auth\').requireOrgId');
    expect(ROUTE).toContain('FROM organizations WHERE id = $1');
    expect(ROUTE).toContain('identity_body');
  });
});

describe('sync-all carries connectors on BOTH branches', () => {
  const LOOP = (() => {
    const at = SRC.indexOf("router.post('/managed/sync-all'");
    expect(at).toBeGreaterThan(-1);
    return codeOnly(SRC.slice(at));
  })();

  test('the archived-recreate branch', () => {
    expect(LOOP).toContain('if (mcpServers.length) createPayload.mcp_servers = mcpServers;');
  });

  test('the routine update branch — the one that actually runs', () => {
    expect(LOOP).toContain('if (mcpServers.length) updatePayload.mcp_servers = mcpServers;');
  });

  test('the servers are fetched once per org inside the loop, not per branch', () => {
    // Two fetches could disagree, and the branches share the result.
    const fetches = (LOOP.match(/collectMcpServersFor\(org\)/g) || []).length;
    expect(fetches).toBe(1);
  });
});
