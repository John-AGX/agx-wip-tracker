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
const FILES = ['server/routes/ai-routes.js'];

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
  'server/routes/ai-routes.js::fn maybeGenerateSessionLabel::ai_messages':
    { n: 1, why: 'WHERE user_id = $1 — the caller\'s own turns, to auto-title their own session.' },
  'server/routes/ai-routes.js::fn seedRecoveredSession::ai_messages':
    { n: 1, why: 'WHERE user_id = $1 — the caller\'s own history, re-seeded into their own recovered session.' },
  'server/routes/ai-routes.js::case self_diagnose::ai_messages':
    { n: 1, why: 'WHERE user_id = $1 AND entity_type = \'86\'. The tool introspects the CALLER\'S own last hour; ctx.userId is required and the handler refuses without it.' },
  'server/routes/ai-routes.js::case search_my_kb::attachments':
    { n: 1, why: 'WHERE uploaded_by = $1 — the personal-KB bucket is BY DEFINITION the caller\'s own uploads.' },
  'server/routes/ai-routes.js::fn buildTodayDigest::tasks':
    { n: 1, why: 'WHERE assignee_user_id = $1 AND scope = \'org\' — tasks assigned to the CALLER. A task assigned to you is in your org by construction.' },
  'server/routes/ai-routes.js::fn buildTurnContext::payloads':
    { n: 2, why: 'WHERE user_id = $1 — the caller\'s own emitted payload files, surfaced back into their own turn.' },
  'server/routes/ai-routes.js::fn buildTurnContext::agent_jobs':
    { n: 1, why: 'WHERE user_id = $1 — the caller\'s own background jobs.' },
  'server/routes/ai-routes.js::fn buildTurnContext::users':
    { n: 1, why: 'WHERE u.id = $1 — the CALLER\'s own identity row, so the model knows who it is assisting. Its only organization_id is on a LEFT JOIN to organizations for the org NAME, which is why it appears here rather than as LITERAL: an outer join\'s ON clause constrains nothing. Correctly classified, correctly exempt.' },
  'server/routes/ai-routes.js::case read_email_inbox::inbound_emails':
    { n: 1, why: 'WHERE user_id = $1 — the Email Dropbox is the CALLER\'S OWN mailbox. Executed cross-tenant and refused: an org-B thread id returns nothing to org A because the thread is not in the caller\'s user_id.' },
  'server/routes/ai-routes.js::case read_email_inbox::email_folders,inbound_emails':
    { n: 1, why: 'Same: WHERE e.user_id = $1 AND e.thread_id = $2. The folder join hangs off the caller\'s own row.' },
  'server/routes/ai-routes.js::case read_email_inbox::email_labels,inbound_emails':
    { n: 1, why: 'Same: WHERE e.user_id = $1 AND e.thread_id = $2. Labels are colour on the caller\'s own thread.' },
  'server/routes/ai-routes.js::GET /86/messages::ai_messages':
    { n: 5, why: 'Every arm is caller-scoped. Three load by session_id AFTER `SELECT … FROM ai_sessions WHERE id = $1 AND user_id = $2` has proved the session belongs to the caller (404 otherwise); the other two carry WHERE user_id = $1 directly.' },
  'server/routes/ai-routes.js::POST /86/chat::attachments':
    { n: 1, why: 'WHERE id = ANY($1) AND uploaded_by = $2 — files the CALLER attached to THIS message, surfaced back into their own turn.' },
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

    out.push({
      file, line: c.line, site: site.name, tenant: tenant.sort().join(','),
      status, ownerAxis,
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
    expect(hosts.sort()).toEqual(FILES.slice().sort());
  });
});
