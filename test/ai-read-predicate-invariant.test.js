// The tenant predicate on a READ is an INVARIANT OF THE STATEMENT, the same
// way it already is on a write.
//
// WHY THIS FILE EXISTS
// test/org-write-predicate-invariant.test.js holds upserts and the money
// spine. It is WRITE-ONLY. There was no read invariant anywhere in test/, and
// a scan of ONE file — server/routes/ai-routes.js — counted 77 SELECTs on
// tenant tables with no organization predicate in sight. The doors that were
// then executed cross-tenant (a client directory with emails and phones, every
// affiliate's estimate lines with their unit costs and markup, 200,000
// characters of any tenant's document text) were all in that count, and all of
// them shipped green through a 152-suite run.
//
// A read hole is not a smaller write hole. Through an AGENT TOOL it is bigger,
// because the model does not hand back a row — it summarises it, in prose,
// into a chat window that belongs to whoever asked. The leak arrives already
// explained.
//
// ── WHAT IT ASSERTS ───────────────────────────────────────────────────────
//   R1  Every SELECT in the agent read surface that reads a TENANT table
//       carries an organization_id predicate — written in the statement, or
//       assembled into it from a builder this scan can actually resolve — or
//       is named on the reviewed allowlist below with a reason.
//   R2  No statement reaches the tenant through the OWNER'S org. A predicate
//       of the form `JOIN users u ON u.id = <t>.owner_id … u.organization_id`
//       answers a different question from "whose row is this", and it is wrong
//       in BOTH directions: a row owned by an org-less user matches the
//       tolerance arm for every caller on the platform, and a row with a null
//       or dangling owner is dropped by the join and becomes invisible to the
//       tenant that owns it. Four statements carried this shape.
//   R3  THE SCAN IS HONEST. A statement whose text cannot be assembled is
//       reported as UNCHECKED and FAILS. It never drops out of the population
//       and reads as compliant.
//
// ── WHY R3 IS NOT DECORATION ──────────────────────────────────────────────
// The write scanner's FIRST version guessed statement boundaries with
// lastIndexOf over quote characters, found 23 of 40 upserts, and WOULD HAVE
// PASSED AGAINST THE CODE THAT HAD THE HOLE. That is the failure mode to
// design against, and this scan started with its own version of it: an earlier
// pass over this same file, keyed on SQL-looking string literals, MISSED the
// lead door entirely —
//
//     'SELECT l.*, c.name AS client_name '  +
//     'FROM leads l '                       +
//     'WHERE l.id = $1'
//
// — because no single fragment holds both a FROM and a WHERE, so the fragment
// that matched /SELECT / had no table in it and the fragment naming `leads`
// was never returned. The statement was not non-compliant; it was ABSENT. The
// fix is in test/helpers/sql-literals.js: the unit is THE CALL, not the
// literal. `extractQueryCalls` takes the balanced source of every
// `<x>.query(...)`'s first argument, so a statement spread over four
// concatenated fragments is one statement, and an argument that is a bare
// identifier comes back with no SQL and one unresolved ref — which is
// UNCHECKED, not compliant.
//
// ── WHAT IT DOES NOT ASSERT ───────────────────────────────────────────────
// It reads SQL text. It cannot know whether an upstream JS guard is correct,
// only whether the statement defends itself. An allowlist entry is a claim
// that someone READ the guard, and the reason is the reading; each entry also
// records HOW MANY statements it covers, so a new unpredicated statement added
// to an already-exempt handler fails instead of inheriting the exemption.
//
// The real endgame is Postgres row-level security, where the predicate is in
// the POLICY and no handler can be written around it. That needs a per-request
// connection on a pool that is currently shared and untenanted, and it needs
// the `OR organization_id IS NULL` legacy tolerance expressed as policy and
// then retired — which is gated on the un-stamped row count reaching zero.
// This is the affordable half, and it fails at commit time instead of at
// incident time.

'use strict';

const fs = require('fs');
const path = require('path');
const { extractQueryCalls, tokenizeSpans } = require('./helpers/sql-literals');
const { classify } = require('../server/services/org-table-classification');

const REPO = path.resolve(__dirname, '..');

// ── SCOPE ─────────────────────────────────────────────────────────────────
// The AGENT READ SURFACE. This is where a caller-supplied id or search string
// reaches a tenant table through a tool the model can call, which is the blast
// radius this invariant is about. It is deliberately NOT all of server/: the
// human REST doors are held by requireOrgId plus their own per-route tests,
// and widening this scan in the same commit as the fix would mean either a
// hundred rewrites on a live pilot or a hundred unread allowlist entries —
// and an unread entry is what turns a file like this into decoration.
//
// The list is asserted CLOSED below: a new module that hosts agent tool
// executors has to be added here, and the test says so by name.
//
// ── WHY THE LIST GREW, AND EXACTLY WHERE THE LINE IS NOW ──────────────────
// The first version scanned ONE file, and its closure test looked for modules
// in server/routes/ that DEFINE AN EXECUTOR. `server/services/session-search.js`
// is neither in server/routes/ nor an executor — it is a service a tool CALLS —
// so the three statements in it that carried `WHERE s.user_id = $1` and no
// tenant predicate were STRUCTURALLY INVISIBLE to this scan. One of them was
// then executed cross-tenant and returned the verbatim body of an ai_messages
// row belonging to another affiliate.
//
// The prior pass considered widening to ALL human REST doors and declined,
// because that is ~100 rewrites or ~100 unread allowlist entries on a live
// pilot, and an unread entry is what turns a file like this into decoration.
// That judgement stands. The line is drawn at a smaller, sharper set:
//
//   AGENT-REACHABLE SQL THAT CARRIES THE DEFECT SHAPE — a module required by
//   ai-routes.js that contains a SELECT on a tenant table scoped by an
//   AUTHORSHIP column (user_id / uploaded_by / owner_id / created_by /
//   assignee_user_id).
//
// That is where the model narrates rows into a chat window, and it is the
// exact premise this whole wave is about ("a user id implies a tenant" — it
// does not, because org membership is mutable). Computed mechanically by the
// closure test below rather than maintained by hand, so the next service to
// grow such a statement is added by a FAILING TEST and not by memory.
//
// WHAT REMAINS OUTSIDE, said plainly:
//   • every human REST door in server/routes/* other than ai-routes.js — held
//     by requireOrgId plus their own per-route tests;
//   • the other ~15 SQL-bearing modules ai-routes.js requires (assemblies,
//     job-financials, deal-memory, payload-dispatcher, the money services and
//     friends, ~200 statements). They are in scope for the WRITE invariant
//     where they write, and they are outside this READ scan because none of
//     them contains an authorship-scoped tenant SELECT — which is checkable,
//     and is checked, rather than assumed;
//   • server/*-cron.js and the workers.
const FILES = [
  'server/routes/ai-routes.js',
  'server/services/outlook-mail.js',
  'server/services/session-search.js',
];

// ── THE REVIEWED ALLOWLIST ────────────────────────────────────────────────
// Key: '<file>::<handler>::<tables>'. Value: { n, why }.
//   n    how many statements the entry covers TODAY. A mismatch fails — an
//        exemption is granted to statements someone read, not to a handler.
//   why  the reading. Adding an entry without doing it is how this stops
//        being worth anything.
//
// Handler names come from the enclosing `case '<tool>':`, `if (name ===
// '<tool>')`, `function <name>` or `router.<verb>('<path>')`, so an entry
// survives the statement moving lines.
const EXEMPT = {
  // ── Keyed on THE CALLER'S OWN user id. A cross-tenant read is impossible
  // because the only id in the statement is the one the JWT resolved.
  'server/routes/ai-routes.js::fn resolveHostKeyForUser::users':
    { n: 1, why: 'WHERE id = $1 where $1 is the CALLER. Reads their own role + host agent key.' },
  'server/routes/ai-routes.js::fn buildIntakeContext::users':
    { n: 1, why: 'WHERE id = $1 where $1 is the caller, to greet them by name in the intake context.' },
  // ── ELEVEN ENTRIES HAVE NOW BEEN REMOVED FROM HERE, NOT REWRITTEN ─────
  // Round four took search_my_kb::attachments, buildTodayDigest::tasks and
  // buildTurnContext::payloads / ::agent_jobs. THIS round took
  // maybeGenerateSessionLabel::ai_messages, seedRecoveredSession::ai_messages,
  // self_diagnose::ai_messages, read_email_inbox::{inbound_emails,
  // email_folders+…, email_labels+…}, POST /86/chat::attachments, and half of
  // GET /86/messages.
  //
  // Every one carried a reason of the form "keyed on the caller's own user id,
  // so there is no tenant to cross". That is the false premise R4 below is
  // named after — users.organization_id is mutable — and read_email_inbox's
  // version of it went further and cited a cross-tenant VERIFICATION that had
  // varied the user and the org together, which can only ever prove "another
  // user's mail is not yours". Vacuous for the property it claimed, and
  // R4 could never catch it because R4 read this very list.
  //
  // All eleven statements now carry a tenant predicate, so they need no
  // exemption and have none. An exemption whose reason has been disproved is
  // deleted with the defect, never edited to say something else.
  'server/routes/ai-routes.js::fn buildTurnContext::users':
    { n: 1, why: 'WHERE u.id = $1 — the CALLER\'s own identity row, so the model knows who it is assisting. Its only organization_id is on a LEFT JOIN to organizations for the org NAME, which is why it appears here rather than as LITERAL: an outer join\'s ON clause constrains nothing. Correctly classified, correctly exempt.' },
  'server/routes/ai-routes.js::GET /86/messages::ai_messages':
    { n: 3, why: 'THREE arms, each loading by session_id AFTER `SELECT entity_type, entity_id, session_kind FROM ai_sessions WHERE id = $1 AND user_id = $2` has proved the session belongs to the caller (404 otherwise), or off a deal thread that same probe returned. This entry used to say FIVE and call all five "caller-scoped": the other two carried the legacy entity tuple / `entity_type=\'86\' AND user_id=$1` and NOTHING ELSE, and painted a mover\'s former tenant\'s turns into their current tenant\'s chat pane. Those two now carry the predicate and have left this count — which is what the count is for.' },
  'server/routes/ai-routes.js::case read_receipts::receipts':
    { n: 3, why: 'All three share the `W` clause built directly above them, which opens `r.organization_id = $1`. The builder is a plain string rather than an array so the resolver cannot follow it; the predicate is present and strict (no tolerance arm).' },

  // ── PARENT PROVED IN-ORG IMMEDIATELY ABOVE, and the child id comes off the
  // parent row rather than off the request.
  'server/routes/ai-routes.js::fn buildEstimateContext::clients':
    { n: 1, why: 'The estimate is org-checked at the top of the function (`WHERE e.id = $1 AND (e.organization_id = $2 OR …)`, throws "Estimate not found"). clientId is read out of THAT row\'s blob — a caller cannot supply it.' },
  'server/routes/ai-routes.js::fn buildEstimateContext::leads,users':
    { n: 1, why: 'Same org-checked estimate; the lead id comes off its blob, not off the request.' },
  'server/routes/ai-routes.js::fn buildEstimateContext::attachments':
    { n: 2, why: 'entity_id is the org-checked estimate id (and the lead id off its blob). See services/attachment-org-scope.js: the parent entity IS the anchor for an attachment.' },
  'server/routes/ai-routes.js::fn buildJobContext::attachments':
    { n: 3, why: 'entity_id is the org-checked job id, and the lead/estimate ids read off that job\'s own rows. Parent-anchored, per attachment-org-scope.js.' },
  'server/routes/ai-routes.js::fn buildJobContext::qb_cost_lines':
    { n: 1, why: 'WHERE job_id = $1 on the job already proved in-org at the top of buildJobContext.' },
  'server/routes/ai-routes.js::fn buildLeadContext::attachments':
    { n: 1, why: 'entity_id is the org-checked lead id from the top of buildLeadContext.' },
  'server/routes/ai-routes.js::tool read_project_photos::attachments,users':
    { n: 1, why: 'The project is proved first: `SELECT id, name FROM projects WHERE id = $1 AND organization_id = $2`, refusing with "No project … in your organization". The photo read is then keyed on that proved entity_id.' },
  'server/routes/ai-routes.js::fn attachBase64PhotosToEntity::attachments':
    { n: 1, why: 'SELECT COALESCE(MAX(position), -1) — returns a position integer, no tenant data, on an entity the caller already reached through a checked door.' },

  // ── NO REQUEST, NO CALLER. Server-derived ids only.
  'server/routes/ai-routes.js::fn driveScribeWrite::payloads':
    { n: 1, why: 'WHERE id = $1 where $1 is `res.meta.payload_id` — the row this same turn just INSERTed. Not caller-supplied.' },
  'server/routes/ai-routes.js::fn execScribeWrite::payloads':
    { n: 1, why: 'WHERE id = $1 where $1 is `result.payloadId` from the write this turn just performed.' },
  'server/routes/ai-routes.js::fn execScribeWrite::users':
    { n: 1, why: 'WHERE id = $1 where $1 is the ORIGINATING user id, loaded to run the capability gate as them.' },
  'server/routes/ai-routes.js::fn runAgentJob::agent_jobs':
    { n: 1, why: 'Called only by server/agent-jobs-worker.js with a job id it just claimed off the queue. No request reaches this.' },
  'server/routes/ai-routes.js::fn resumeAgentJob::agent_jobs':
    { n: 1, why: 'Same worker, same claimed id.' },
  'server/routes/ai-routes.js::fn notifyAgentJobNeedsInput::users':
    { n: 1, why: 'WHERE id = $1 — the job\'s own user, to email them. Reached only from the worker.' },
  'server/routes/ai-routes.js::fn notifyAgentJobDone::users':
    { n: 1, why: 'Same.' },
};

// ── R4'S OWN LIST, AND WHY IT IS NOT THIS ONE ─────────────────────────────
// R4 exists to REFUTE exemptions of a particular shape: "this statement is
// scoped by an authorship column, therefore it is scoped to a tenant". Until
// this commit R4's test read
//
//     ALL.filter(ownerScoped).filter(r => !EXEMPT[r.key])
//
// — so a statement was excused from the rule by the very list the rule was
// written to audit, and the entries doing the excusing gave THE FALSE PREMISE
// ITSELF as their reason. The rule could not fire on its own subject matter.
//
// The interaction is now decided rather than left implicit, and it is decided
// the strict way: **R1's allowlist has no authority over an authorship-scoped
// statement at all.** That class has its own list, below, admission to which
// requires something an English sentence cannot fake — a NAMED TEST that
// varies ONLY the org. The two lists are asserted DISJOINT over this class, so
// an author cannot re-open the door by writing a persuasive `why` in EXEMPT.
//
// It is currently EMPTY, and that is the substantive result of this round: all
// eight authorship-scoped unpredicated statements were fixed rather than
// excused. An entry here would be shaped:
//
//   '<file>::<handler>::<tables>': {
//     n: 1,
//     why: '…',
//     provedBy: { file: 'test/xyz.test.js', test: 'a sentence from the test name' },
//   }
//
// and `validateOwnerExemption` below decides whether it is admissible: the
// named file must exist, must contain a test whose name contains that string,
// and must run it through `test/helpers/org-only.js`'s `proveOrgOnly` — the
// one helper in this repo that CANNOT vary the caller, because it derives both
// arms from a single caller record. A reason without a passing proof of that
// shape is not an exemption; it is an open door wearing one.
const OWNER_SCOPED_PROVEN = {};

// The admissibility test, as a function so it can be exercised against
// deliberately-bad entries below. A validator nobody has seen reject anything
// is the same kind of decoration as a scan that matches nothing.
function validateOwnerExemption(key, entry, readFile) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['no entry'];
  if (typeof entry.n !== 'number') problems.push(key + ': n must be a number');
  if (typeof entry.why !== 'string' || entry.why.length < 40) {
    problems.push(key + ': why must be a real reading, not a label');
  }
  const p = entry.provedBy;
  if (!p || typeof p.file !== 'string' || typeof p.test !== 'string') {
    problems.push(key + ': provedBy { file, test } is REQUIRED — an authorship-scoped ' +
      'exemption needs a named behavioural proof, not a sentence');
    return problems;
  }
  let src;
  try { src = readFile(p.file); } catch (e) { src = null; }
  if (src == null) { problems.push(key + ': provedBy.file ' + p.file + ' does not exist'); return problems; }
  if (src.indexOf(p.test) === -1) {
    problems.push(key + ': ' + p.file + ' contains no test named "' + p.test + '"');
  }
  if (!/\bproveOrgOnly\s*\(/.test(src)) {
    problems.push(key + ': ' + p.file + ' does not use proveOrgOnly — a cross-tenant claim ' +
      'proved by varying the user AND the org proves nothing about the tenant');
  }
  return problems;
}

// Column names that mean "who made this", i.e. an axis that is NOT the row's
// tenant. R2 flags a statement that reaches the org through one of these.
const OWNER_COLUMNS = 'owner_id|created_by|created_by_user_id|uploaded_by|user_id';

// ── A PREDICATE IN AN OUTER JOIN'S ON CLAUSE CONSTRAINS NOTHING ───────────
// Found by mutating this scanner. Deleting the tenant predicate from
// read_clients' unfiltered arm left the invariant GREEN, because the arm also
// carries
//
//     LEFT JOIN clients p ON p.id = c.parent_client_id
//                        AND (p.organization_id = $2 OR p.organization_id IS NULL)
//
// and a token-presence check answered TRUE on it. An OUTER join's ON clause
// decides which rows of the JOINED table are attached, never which rows of the
// driving table survive: with the WHERE gone, every client in every tenant came
// back, each simply missing its parent's name. That is the same defect shape
// the write invariant's header describes — a statement that NAMES
// organization_id while PREDICATING on nothing — wearing different clothes.
//
// So the token is looked for in the CONSTRAINING part of the statement: the
// text with every LEFT / RIGHT / FULL join's ON clause blanked out. INNER joins
// keep theirs, because an inner join's ON clause does restrict the result.
function constrainingSql(sql) {
  // Blank from each outer JOIN keyword up to the next clause boundary.
  return sql.replace(
    /\b(?:LEFT|RIGHT|FULL)\s+(?:OUTER\s+)?JOIN\b[\s\S]*?(?=\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|JOIN)\b|$)/gi,
    ' '
  );
}

// ── AND NEITHER DOES A PREDICATE IN THE SELECT LIST ───────────────────────
// The other half of the same mistake, and the one this round would have
// shipped: `SELECT organization_id FROM users WHERE id = $1` NAMES the column
// and predicates on nothing, so a token-presence check over the whole statement
// answers LITERAL. Harmless there — it is the caller's-own-org lookup that
// every door in this file starts with — but it means an author could satisfy
// this invariant on an authorship-scoped read by adding the column to the
// projection and nothing else. R5 closes that; this is the blanking it needs.
// Every SELECT's projection is blanked, so it works on subqueries too.
function predicatingSql(sql) {
  return constrainingSql(sql)
    .replace(/\bSELECT\b(?:\s+DISTINCT\b)?[\s\S]*?(?=\bFROM\b|$)/gi, ' SELECT ');
}

function analyse(file) {
  const text = fs.readFileSync(path.join(REPO, file), 'utf8');

  // A comment-free copy for the builder resolver, so a predicate NAMED IN A
  // COMMENT is never mistaken for one that is in the WHERE clause. Line
  // offsets are preserved (comments are blanked, not removed) so the handler
  // windows below still line up with the source.
  const { comments } = tokenizeSpans(text);
  const chars = text.split('');
  for (const [a, b] of comments) for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' ';
  const code = chars.join('');

  const lines = text.split('\n');
  const anchors = [];
  lines.forEach((l, i) => {
    let m;
    if ((m = l.match(/^\s*case\s+'([^']+)'\s*:/))) anchors.push({ line: i + 1, name: 'case ' + m[1] });
    else if ((m = l.match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)/))) anchors.push({ line: i + 1, name: 'fn ' + m[1] });
    else if ((m = l.match(/^\s*if\s*\(\s*name\s*===\s*'([^']+)'/))) anchors.push({ line: i + 1, name: 'tool ' + m[1] });
    else if ((m = l.match(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/))) anchors.push({ line: i + 1, name: m[1].toUpperCase() + ' ' + m[2] });
  });
  anchors.sort((a, b) => a.line - b.line);
  const off = [0];
  for (let i = 0; i < lines.length; i++) off.push(off[i] + lines[i].length + 1);
  const siteFor = (line) => {
    let best = null;
    for (const a of anchors) { if (a.line > line) break; best = a; }
    return best || { line: 1, name: '(file scope)' };
  };

  // Resolve a statement's unresolved references against its own handler block.
  // Only the three shapes this file actually uses are followed —
  // `X.push(<literal>)`, `const/let X = <initialiser>`, `X = / X += <literal>`
  // — and only inside the enclosing handler. Anything else stays unresolved,
  // which is UNCHECKED, which fails.
  // TRANSITIVELY. `const sql = 'SELECT … FROM users ' + (where.length ? 'WHERE '
  // + where.join(' AND ') : '')` resolves `sql` to text that mentions `where`,
  // and the predicate is two hops away in `where.push('(organization_id = …)')`.
  // Stopping at one hop reported read_users, read_tasks and
  // resolveTaskEntityLabel as unpredicated when all three are correctly scoped
  // — a scan that cries wolf gets an allowlist entry written for it, and that
  // entry is then a real exemption on a real door. Depth is capped and the
  // visited set stops cycles.
  function resolve(refs, blockStart, blockEnd) {
    const win = code.slice(blockStart, blockEnd);
    let found = '';
    let touched = false;
    const seen = new Set();
    let frontier = refs.slice();
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next = [];
      for (const r of frontier) {
        if (seen.has(r) || !/^[A-Za-z_$][\w$]*$/.test(r)) continue;
        seen.add(r);
        const pats = [
          new RegExp('\\b' + r + '\\s*\\.\\s*push\\s*\\(', 'g'),
          new RegExp('\\b(?:const|let|var)\\s+' + r + '\\s*=', 'g'),
          new RegExp('\\b' + r + '\\s*\\+?=', 'g'),
        ];
        for (const p of pats) {
          let mm;
          while ((mm = p.exec(win))) {
            touched = true;
            const chunk = win.slice(mm.index, Math.min(win.length, mm.index + 400));
            found += ' ' + chunk;
            for (const w of (chunk.match(/[A-Za-z_$][\w$]*/g) || [])) next.push(w);
          }
        }
      }
      frontier = next;
    }
    return { touched, found };
  }

  const out = [];
  for (const c of extractQueryCalls(text)) {
    const site = siteFor(c.line);
    const { touched, found } = resolve(c.refs, off[site.line - 1], c.argEnd);

    // ── OPAQUE CALLS ARE NOT A HIDING PLACE ──────────────────────────────
    // `pool.query(sql, args)` — the statement's text was assembled into a
    // variable above. Its argument holds no SQL at all, so a scan that keyed
    // on the argument would see no tables, find no tenant, and drop it from
    // the population: a statement could be exempted from this invariant by
    // hoisting one line. Seven calls in this file are that shape (read_users,
    // read_metrics, read_qb_cost_lines and friends), and they are exactly the
    // handlers whose predicates live in a `where` array. So an opaque call is
    // resolved against its handler block, and judged on what it resolves to.
    // A call whose text CANNOT be reached is UNCHECKED, which fails.
    const opaque = !/\S/.test(c.sql);
    const body = opaque ? found : c.sql;
    if (opaque && !touched) {
      out.push({
        file, line: c.line, site: site.name, tenant: '(opaque)',
        status: 'UNCHECKED', ownerAxis: false,
        key: file + '::' + site.name + '::(opaque)',
        head: 'query(' + c.argSource.replace(/\s+/g, ' ').trim().slice(0, 40) + ', …) — statement text not reachable from the call site',
      });
      continue;
    }
    if (!/\bSELECT\b/i.test(body)) continue;
    const tables = new Set();
    const re = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
    let m;
    while ((m = re.exec(body))) tables.add(m[1].toLowerCase());
    const tenant = [...tables].filter((t) => {
      const k = classify(t);
      return k === 'direct' || k === 'parent' || k === 'mixed_shared';
    });
    if (!tenant.length) continue;

    let status;
    if (/organization_id/i.test(constrainingSql(body))) status = 'LITERAL';
    else if (/organization_id/i.test(found)) status = 'BUILDER';
    else if (c.refs.length && !touched) status = 'UNCHECKED';
    else status = 'NONE';

    // R2 — the owner axis. Flagged only when the ONLY organization_id in the
    // statement is on a users alias joined through an authorship column. A
    // statement that also predicates on the row's own stamp (read_tasks joins
    // users twice for display names and still keys on t.organization_id) is
    // not this defect and is not flagged.
    let ownerAxis = false;
    const joinRe = new RegExp('JOIN\\s+users\\s+(?:AS\\s+)?([a-z_]\\w*)\\s+ON\\s+\\1\\s*\\.\\s*id\\s*=\\s*[a-z_]\\w*\\s*\\.\\s*(?:' + OWNER_COLUMNS + ')', 'gi');
    const userAliases = [...body.matchAll(joinRe)].map((x) => x[1]);
    if (userAliases.length) {
      const orgQualifiers = [...c.sql.matchAll(/([a-z_]\w*)\s*\.\s*organization_id/gi)].map((x) => x[1]);
      const bare = /(^|[^.\w])organization_id/i.test(c.sql);
      if (orgQualifiers.length && !bare &&
          orgQualifiers.every((q) => userAliases.indexOf(q) !== -1)) ownerAxis = true;
    }

    // R4 — is this statement scoped by an AUTHORSHIP column? Recorded on every
    // row rather than only on the offenders, so the detector itself can be
    // asserted to still see the shape.
    const ownerHit = body.match(
      new RegExp('\\b(?:[a-z_]\\w*\\.)?(' + OWNER_COLUMNS + '|assignee_user_id)\\s*=\\s*\\$\\d', 'i'));
    const ownerScoped = ownerHit ? ownerHit[1].toLowerCase() : null;

    // R5 — does organization_id appear ONLY in the projection? Recorded on
    // every row, same reason as ownerScoped.
    //
    // NOT COMPUTED FOR AN OPAQUE CALL. When the statement text came out of the
    // builder resolver, `body` is a slice of JAVASCRIPT (`conds.push(...)`,
    // `params.push(...)`), not SQL — blanking "the SELECT list" of that is
    // meaningless, and read_recent_conversations (correctly predicated through
    // a `conds` array) was reported as a projection-only scan the first time
    // this ran. An opaque call's predicate is judged by R1's BUILDER status;
    // R5 is a claim about statement TEXT and only text can carry it.
    const projectionOnly = !opaque &&
      /organization_id/i.test(constrainingSql(body)) &&
      !/organization_id/i.test(predicatingSql(body));
    // A single-row primary-key lookup: the caller gets ONE row back and has to
    // prove it in JS (attachmentInOrg's ladder) or is simply reading their own
    // identity. A scan hands back a SET, which is a different thing entirely.
    const cons = constrainingSql(body);
    const byPrimaryId = /(^|[^.\w])(?:[a-z_]\w*\s*\.\s*)?id\s*=\s*\$\d/i.test(cons);
    const scanShaped = /\bILIKE\b|=\s*ANY\s*\(/i.test(cons);

    out.push({
      file, line: c.line, site: site.name, tenant: tenant.sort().join(','),
      status, ownerAxis, ownerScoped, projectionOnly, byPrimaryId, scanShaped,
      key: file + '::' + site.name + '::' + tenant.sort().join(','),
      head: c.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
    });
  }
  return out;
}

const ALL = FILES.reduce((acc, f) => acc.concat(analyse(f)), []);

// ── R0 — the scan itself must be working ──────────────────────────────────
// A scanner that returns nothing passes every assertion below. These are the
// cheap sanity checks that would have caught the write scanner's first version
// (23 of 40 statements found, reported green).
describe('R0 — the scan sees what it claims to', () => {
  test('the population is the size the source says it is', () => {
    // Not an exact number (that would fail on any harmless edit) but a floor
    // that the literal-only scan could not reach. The pre-fix literal scan
    // found 159 SELECT literals touching tenant tables in this file; the
    // call-anchored scan must be in that neighbourhood, not near zero.
    expect(ALL.length).toBeGreaterThan(120);
  });

  test('it sees a statement that is CONCATENATED across four fragments', () => {
    // The lead door. Written as one template now, but the property being
    // asserted is that the scanner can see a statement spread over `+`-joined
    // fragments at all, so this is checked on a statement whose FROM and WHERE
    // are provably in the population together.
    const lead = ALL.find((r) => /FROM leads l/i.test(r.head) && /read_entity|execConsolidatedRead|fn /.test(r.site));
    expect(lead).toBeTruthy();
  });

  test('it sees a statement whose predicate is BUILT in an array', () => {
    const built = ALL.filter((r) => r.status === 'BUILDER');
    expect(built.length).toBeGreaterThan(5);
  });

  test('every allowlist entry names a handler that still exists', () => {
    // A stale entry is an exemption nobody can see is stale.
    const live = new Set(ALL.map((r) => r.key));
    const stale = Object.keys(EXEMPT).filter((k) => !live.has(k));
    expect(stale).toEqual([]);
  });
});

// ── R1 — the predicate ────────────────────────────────────────────────────
describe('R1 — every tenant read in the agent surface defends itself', () => {
  test('no unpredicated tenant SELECT outside the reviewed allowlist', () => {
    const bad = ALL.filter((r) => r.status === 'NONE' || r.status === 'UNCHECKED');
    const byKey = {};
    bad.forEach((r) => { (byKey[r.key] = byKey[r.key] || []).push(r); });

    const offenders = [];
    for (const key of Object.keys(byKey)) {
      const rows = byKey[key];
      const entry = EXEMPT[key];
      if (!entry) {
        offenders.push('NOT EXEMPT  ' + key + '  (' + rows.length + ' statement(s), line(s) ' +
          rows.map((r) => r.line).join(', ') + ')\n              ' + rows[0].head);
        continue;
      }
      if (entry.n !== rows.length) {
        offenders.push('COUNT MOVED ' + key + '  allowlist says ' + entry.n +
          ', found ' + rows.length + ' (line(s) ' + rows.map((r) => r.line).join(', ') + ').\n' +
          '              A new unpredicated statement in an already-exempt handler must not inherit the exemption.');
      }
    }
    expect(offenders).toEqual([]);
  });

  test('nothing is UNCHECKED — an unparsed statement fails, it does not vanish', () => {
    const unchecked = ALL.filter((r) => r.status === 'UNCHECKED');
    expect(unchecked.map((r) => r.file + ':' + r.line + ' <' + r.site + '> ' + r.head)).toEqual([]);
  });
});

// ── R4 — A USER ID IS NOT A TENANT ────────────────────────────────────────
// R1 asks whether a statement carries a tenant predicate at all. R4 asks the
// question that actually let two doors stay open through three commits: does
// the statement scope by an AUTHORSHIP column and then treat that as the
// boundary?
//
// Both open doors rested on one premise, written down in both places as a
// comment asserting a security property:
//
//   "Cross-tenant access is blocked implicitly because uploads outside the
//    user's org would never have uploaded_by set to them."
//
// `users.organization_id` is MUTABLE. `PUT /api/auth/users/:id` writes it, and
// moving a person between organisations is a documented one-click admin action
// (services/user-org-scope.js calls it "the adoption door"). A user who moves
// keeps `uploaded_by` / `user_id` on every row they ever authored for their
// former tenant. The premise is false in exactly the case multi-tenancy exists
// for, and R1 could not see it because R1's allowlist is where the premise was
// recorded as a reason.
//
// So the rule is stated on the STATEMENT CLASS rather than left to the next
// author to remember: a SELECT on a tenant table whose only scoping is an
// authorship column FAILS.
//
// ── AND THE RULE USED TO EXEMPT EXACTLY WHAT IT EXISTS TO CATCH ───────────
// The first version of the test below was, in substance,
//
//     ALL.filter(ownerScoped).filter(r => !EXEMPT[r.key])
//
// which GRANDFATHERED R1's allowlist — and the allowlist entries for
// read_email_inbox (three of them) and self_diagnose gave THE FALSE PREMISE
// ABOVE as their reason. R4 could therefore never fire on the statements it was
// written for, by construction, and it did not: three doors stayed open through
// a further commit that was about this exact class.
//
// The interaction is now decided, and decided strictly. R1's allowlist has NO
// authority over this class: an authorship-scoped unpredicated statement must
// be on OWNER_SCOPED_PROVEN, whose admission test is a NAMED BEHAVIOURAL PROOF
// that varies only the org. The lists are asserted disjoint over the class, so
// an entry in EXEMPT can neither excuse one of these nor hide one.
describe('R4 — an authorship column is not a tenant boundary', () => {
  const readFile = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
  const bad = ALL.filter((r) => r.ownerScoped && (r.status === 'NONE' || r.status === 'UNCHECKED'));

  test('no authorship-scoped tenant read is unpredicated', () => {
    // The whole class, with no reference to EXEMPT. Anything here must be on
    // R4's OWN list, and this round that list is empty because all eight were
    // fixed instead of excused.
    const byKey = {};
    bad.forEach((r) => { (byKey[r.key] = byKey[r.key] || []).push(r); });
    const offenders = [];
    for (const key of Object.keys(byKey)) {
      const rows = byKey[key];
      const entry = OWNER_SCOPED_PROVEN[key];
      if (!entry) {
        offenders.push('NOT PROVEN  ' + key + '  (' + rows.length + ' statement(s), line(s) ' +
          rows.map((r) => r.line).join(', ') + ') scoped by ' + rows[0].ownerScoped +
          '\n              ' + rows[0].head +
          '\n              An entry in EXEMPT does NOT cover this — see OWNER_SCOPED_PROVEN.');
        continue;
      }
      if (entry.n !== rows.length) {
        offenders.push('COUNT MOVED ' + key + '  list says ' + entry.n + ', found ' + rows.length);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('R1\'s allowlist has no authority over this class — the lists are disjoint', () => {
    // The grandfathering, asserted gone. If somebody re-opens one of these
    // doors and writes a persuasive `why` in EXEMPT, this fails and names it.
    const smuggled = bad
      .filter((r) => EXEMPT[r.key])
      .map((r) => r.file + ':' + r.line + ' <' + r.site + '> is authorship-scoped and unpredicated, ' +
        'and EXEMPT claims: ' + EXEMPT[r.key].why.slice(0, 120));
    expect(smuggled).toEqual([]);
  });

  test('every OWNER_SCOPED_PROVEN entry names a proof that varies ONLY the org', () => {
    const problems = [];
    for (const [key, entry] of Object.entries(OWNER_SCOPED_PROVEN)) {
      problems.push(...validateOwnerExemption(key, entry, readFile));
    }
    expect(problems).toEqual([]);
  });

  test('and the validator REJECTS the four ways an entry could be decoration', () => {
    // R0's lesson applied to the admission test itself. The list is empty
    // today, so without this the validator is a function nobody has watched
    // say no — which is how the last two "invariants" turned out to be
    // decoration when they were finally mutated.
    const ok = { n: 1, why: 'x'.repeat(50), provedBy: { file: 'test/helpers/org-only.js', test: 'proveOrgOnly' } };
    expect(validateOwnerExemption('k', ok, readFile)).toEqual([]);

    // 1. no proof at all — the shape every deleted entry had.
    expect(validateOwnerExemption('k', { n: 1, why: 'x'.repeat(50) }, readFile).join(' '))
      .toMatch(/provedBy .* is REQUIRED/);
    // 2. a proof file that does not exist.
    expect(validateOwnerExemption('k', Object.assign({}, ok, {
      provedBy: { file: 'test/does-not-exist.test.js', test: 'anything' } }), readFile).join(' '))
      .toMatch(/does not exist/);
    // 3. a real file that contains no such test.
    expect(validateOwnerExemption('k', Object.assign({}, ok, {
      provedBy: { file: 'test/helpers/org-only.js', test: 'a test nobody wrote' } }), readFile).join(' '))
      .toMatch(/contains no test named/);
    // 4. a real test in a file that does NOT go through proveOrgOnly — i.e.
    //    one free to vary the user and the org together, which is the exact
    //    mistake the read_email_inbox entry was wearing.
    expect(validateOwnerExemption('k', Object.assign({}, ok, {
      provedBy: { file: 'test/helpers/sql-literals.js', test: 'extractQueryCalls' } }), readFile).join(' '))
      .toMatch(/does not use proveOrgOnly/);
  });

  test('the scan can still SEE the shape it is asserting about', () => {
    // R0's lesson, applied to R4: a rule that matches nothing passes forever.
    // The agent surface has many caller-scoped reads; if this drops to zero the
    // detector broke, not the code.
    expect(ALL.filter((r) => r.ownerScoped).length).toBeGreaterThan(8);
  });
});

// ── R5 — NAMING THE COLUMN IS NOT PREDICATING ON IT ───────────────────────
// R1 answers LITERAL when `organization_id` appears anywhere outside an outer
// join's ON clause — which includes the SELECT LIST. That is how
// `SELECT organization_id FROM users WHERE id = $1` reads as compliant, and it
// is benign there (31 statements in this surface are that idiom or its
// attachment twin, all single-row primary-key lookups whose verdict is then
// reached in JS by services/attachment-org-scope.js). But it is also a way to
// satisfy R1 and R4 on an authorship-scoped read by adding the column to the
// projection and changing nothing that constrains anything — the same "NAMES
// organization_id while PREDICATING on nothing" shape R2's header describes,
// one clause to the left.
//
// So the projection-only population is bounded rather than trusted: none of it
// may be authorship-scoped, and all of it must key on a primary id rather than
// scan. A statement that hands back a SET on a projection-only "predicate" is
// not this idiom and has to say so by failing.
describe('R5 — organization_id in the SELECT list predicates nothing', () => {
  const projectionOnly = ALL.filter((r) => r.projectionOnly);

  test('the detector sees the shape (it is 31 statements, not zero)', () => {
    expect(projectionOnly.length).toBeGreaterThan(20);
  });

  test('no authorship-scoped read is compliant only by naming the column', () => {
    const offenders = projectionOnly
      .filter((r) => r.ownerScoped)
      .map((r) => r.file + ':' + r.line + ' <' + r.site + '> scoped by ' + r.ownerScoped +
        ' with organization_id in the PROJECTION only — ' + r.head);
    expect(offenders).toEqual([]);
  });

  test('every projection-only statement is a single-row lookup, never a scan', () => {
    const offenders = projectionOnly
      .filter((r) => !r.byPrimaryId || r.scanShaped)
      .map((r) => r.file + ':' + r.line + ' <' + r.site + '> returns a SET on a projection-only ' +
        'tenant reference — ' + r.head);
    expect(offenders).toEqual([]);
  });
});

// ── R2 — the axis ─────────────────────────────────────────────────────────
describe('R2 — the tenant is the ROW\'s org, never the owner\'s', () => {
  test('no tenant read reaches its org through a users row joined on authorship', () => {
    const axis = ALL.filter((r) => r.ownerAxis);
    expect(axis.map((r) => r.file + ':' + r.line + ' <' + r.site + '> ' + r.head)).toEqual([]);
  });
});

// ── the scope of this file, asserted rather than assumed ──────────────────
describe('the scanned surface is closed', () => {
  test('every module that hosts an agent tool executor is scanned', () => {
    // If a new file starts exporting `execStaffTool`-style executors, it must
    // be added to FILES. Detected by looking for the shape rather than by
    // trusting the list.
    const hosts = [];
    const dir = path.join(REPO, 'server', 'routes');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/async function exec[A-Za-z]*Tool\s*\(|async function exec[A-Za-z]*Read\s*\(/.test(src)) {
        hosts.push('server/routes/' + f);
      }
    }
    expect(hosts.every((h) => FILES.indexOf(h) !== -1)).toBe(true);
  });

  // THE HOLE THAT LET #3 THROUGH. The test above finds files that DEFINE an
  // executor. session-search.js is a file an executor CALLS, so no shape it
  // looks for existed there and its three unpredicated statements could never
  // have been reported. This computes the other half of the surface the same
  // way — by the shape, not by the list — and it is deliberately narrow: a
  // module ai-routes.js reaches, that runs a SELECT on a tenant table scoped
  // by an AUTHORSHIP column AND CARRIES NO TENANT PREDICATE. That is the
  // statement class this whole wave is about, and it is where the model reads
  // rows out loud.
  //
  // ── TWO THINGS WERE WRONG WITH IT, AND BOTH ARE PATH ASSUMPTIONS ────────
  // 1. The require pattern was `require('../…')` ONLY, so a SIBLING ROUTE
  //    module — `require('./payload-routes')`, `require('./admin-agents-routes')`,
  //    seven call sites between them — was structurally invisible. That is the
  //    same shape as the miss it was written to fix, one directory across.
  //    admin-agents-routes.js was hiding TWO authorship-scoped ai_messages
  //    reads behind it: GET /conversations/:key returns 16KB of every turn's
  //    CONTENT, and POST /conversations/:key/replay re-runs the model over the
  //    transcript. Both were guarded — by a `SELECT 1 FROM users WHERE id = $1
  //    AND organization_id = $2` on the line above, which is R2's owner axis
  //    written in JavaScript instead of SQL, and false for exactly the same
  //    reason. Both now carry the row's own predicate.
  // 2. It walked ONE hop. A module required by a required module could host
  //    the class and answer to nothing. The walk is transitive now (depth
  //    capped, visited set), which reaches 68 modules instead of 31.
  //
  // ── AND THE CRITERION IS THE DEFECT, NOT THE SHAPE ─────────────────────
  // It used to demand FILES contain every module hosting an authorship-scoped
  // tenant SELECT at all, predicated or not. Held literally that is ~24 unread
  // allowlist entries for two admin route files whose statements are correct —
  // and an unread entry is what turns a file like this into decoration, which
  // is the reason this scan is scoped to three files in the first place. The
  // criterion is now "hosts an UNPREDICATED one". Nothing is weakened: a module
  // whose predicates are all present stays outside, and the day one of them is
  // removed the module hosts the defect and this fails by name — which is the
  // property the old criterion was reaching for.
  test('every agent-reachable module hosting an UNPREDICATED authorship-scoped tenant SELECT is scanned', () => {
    // Transitive require walk from ai-routes.js, relative paths resolved so a
    // './sibling' is followed exactly like a '../services/x'.
    const reached = new Set();
    (function walk(rel, depth) {
      if (reached.has(rel) || depth > 6) return;
      reached.add(rel);
      const p = path.join(REPO, rel);
      if (!fs.existsSync(p)) return;
      const dir = path.posix.dirname(rel.replace(/\\/g, '/'));
      const re = /require\((['"])(\.\.?\/[A-Za-z0-9_\-./]+)\1\)/g;
      const s = fs.readFileSync(p, 'utf8');
      let mm;
      while ((mm = re.exec(s))) {
        let t = path.posix.normalize(path.posix.join(dir, mm[2]));
        if (!t.endsWith('.js')) t += '.js';
        walk(t, depth + 1);
      }
    })('server/routes/ai-routes.js', 0);
    const required = reached;
    // The walk has to actually go somewhere. Before the './' fix it reached 31
    // modules; a regression to a one-hop or '../'-only walk shows up here
    // rather than as a silent green.
    expect(required.size).toBeGreaterThan(60);

    const ownerScoped = new RegExp(
      '\\b(?:[a-z_]\\w*\\.)?(?:' + OWNER_COLUMNS + '|assignee_user_id)\\s*=\\s*\\$\\d', 'i');
    const hosts = [];
    for (const rel of [...required].sort()) {
      const p = path.join(REPO, rel);
      if (rel === 'server/db.js' || !fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      let calls = [];
      try { calls = extractQueryCalls(text); } catch (e) { continue; }
      const hit = calls.some((c) => {
        const sql = c.sql || '';
        // Predicated is not this class. Judged on the CONSTRAINING text, so an
        // outer join's ON clause cannot launder it, and on the PREDICATING
        // text, so naming the column in the projection cannot either.
        if (/organization_id/i.test(predicatingSql(sql))) return false;
        if (!/\bSELECT\b/i.test(sql) || !ownerScoped.test(sql)) return false;
        const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((x) => x[1].toLowerCase());
        return tables.some((t) => ['direct', 'parent', 'mixed_shared'].indexOf(classify(t)) !== -1);
      });
      if (hit) hosts.push(rel);
    }
    // Every such module must be in FILES. Reported as a list so a new one
    // names itself in the failure.
    expect(hosts.filter((h) => FILES.indexOf(h) === -1)).toEqual([]);
  });

  test('the widened walk really does reach the siblings the old one could not', () => {
    // R0's lesson applied to the walk itself: the fix above is a path change,
    // and a path change that quietly stopped matching would leave this test
    // passing by reaching nothing. These two are required as `./sibling` from
    // ai-routes.js — the exact form the old pattern could not see — and both
    // host authorship-scoped tenant SELECTs (predicated ones, now).
    const src = fs.readFileSync(path.join(REPO, 'server', 'routes', 'ai-routes.js'), 'utf8');
    expect(src).toMatch(/require\('\.\/admin-agents-routes'\)/);
    expect(src).toMatch(/require\('\.\/payload-routes'\)/);
    const old = /require\((['"])\.\.\/(services\/[a-zA-Z0-9_\-/]+|[a-zA-Z0-9_\-]+)\1\)/g;
    const oldReach = new Set();
    let m;
    while ((m = old.exec(src))) oldReach.add('server/' + m[2] + '.js');
    expect(oldReach.has('server/routes/admin-agents-routes.js')).toBe(false);
    expect(oldReach.has('server/routes/payload-routes.js')).toBe(false);
  });

  test('and the two statements it was hiding now carry the row\'s own tenant', () => {
    // Behaviourally these sit behind ROLES_MANAGE on an admin console, so they
    // are held here at the statement rather than by driving the route — named
    // explicitly instead of left to the reader to infer from a scan that is
    // now, correctly, silent about them.
    const src = fs.readFileSync(path.join(REPO, 'server', 'routes', 'admin-agents-routes.js'), 'utf8');
    const stmts = extractQueryCalls(src).filter((c) =>
      /FROM ai_messages/i.test(c.sql || '') && /user_id\s*=\s*\$\d/i.test(c.sql || ''));
    expect(stmts.length).toBe(2);                                  // both doors found
    stmts.forEach((c) => {
      expect(predicatingSql(c.sql)).toMatch(/organization_id\s*=\s*\$\d/);
      expect(c.sql).toMatch(/organization_id IS NULL/);            // and the legacy tolerance
    });
  });
});
