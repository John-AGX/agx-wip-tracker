// WHAT THE AGENTS ARE TOLD ABOUT SERVICE TICKETS — AND THAT IT IS TRUE.
//
// Each sentence pinned here replaced one that was false or silent, and each
// is checked against the code it describes rather than only against itself:
//
//   * 86 and the Assistant were told tickets can be read, and nothing said they
//     cannot be LISTED. No job read and no lead read lists a record's tickets
//     and search_entities has no ticket type, so a model asked "any tickets on
//     this job?" saw none and said none. They must say they cannot list them.
//   * "by its id or its ticket number" — nothing mints ticket_number, so a
//     lookup by number is a confident not-found.
//   * the Scribe was told job_id may be a $new_ ref to a job created in the same
//     payload. No payload creates a job.
//   * the Scribe's refusal list did not name `condition` or either side of
//     op:"move", both of which the dispatcher refuses for tickets as terminal.
//   * the payload title/summary become push titles and chat headers, and the
//     Scribe writes them freely — so they name the ticket by its title only.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

// admin-agents-routes.js (and ai-routes.js) arm timers AT MODULE LOAD whose
// handles are not stored; left real, a background refresh fires after the last
// test and logs into a finished run. Faking the clock across the require drops
// them — the same treatment agent-instruction-honesty.test.js uses.
jest.useFakeTimers();
const { AGENT_SYSTEM_BASELINE: B } = require('../server/routes/admin-agents-routes');
const dispatcher = require('../server/services/payload-dispatcher');
const internals = require('../server/routes/ai-routes-internals');
jest.useRealTimers();

// The Scribe's service_ticket bullet, and nothing after it — so a word found
// here is a word said ABOUT TICKETS, not somewhere else in a long prompt.
function scribeTicketBullet() {
  const s = B.scribe;
  const at = s.indexOf('  • service_ticket:');
  expect(at).toBeGreaterThan(-1);
  const end = s.indexOf('\n  • ', at + 5);
  return s.slice(at, end === -1 ? undefined : end);
}

function refusal(target) {
  try { dispatcher.validateTarget(target, 0); } catch (e) { return e; }
  return null;
}
const upd = (ops) => ({ entity_type: 'service_ticket', entity_id: 'st_1', ops: Object.assign({ op: 'update' }, ops) });

describe('86 and the Assistant: tickets cannot be listed, and they say so', () => {
  test.each(['job', 'assistant'])('%s is told it cannot list a record\'s tickets, never to say there are none, and where to send the user', (key) => {
    const t = B[key];
    expect(t).toMatch(/NEVER say a job or lead has no tickets/);
    expect(t).toMatch(/cannot list/i);
    expect(t).toMatch(/Service Tickets tab/);
    expect(t).toMatch(/by its id only/);
  });

  test.each(['job', 'assistant'])('%s is never offered a ticket number as a way in', (key) => {
    expect(B[key]).not.toMatch(/ticket number/i);
  });

  test('the claim is TRUE: search_entities offers no ticket type, and read_entity reads one by id', () => {
    const tools = internals.readTools();
    const search = tools.find((t) => t.name === 'search_entities');
    const read = tools.find((t) => t.name === 'read_entity');
    expect(search.description).not.toMatch(/service_ticket/);
    expect(JSON.stringify(search.input_schema)).not.toMatch(/service_ticket/);
    expect(read.input_schema.properties.entity_type.enum).toContain('service_ticket');
    expect(read.description).not.toMatch(/ticket number/i);
  });
});

describe('the Scribe\'s service_ticket bullet', () => {
  test('job_id is a real job, never a $new_ ref — and it is TRUE that no payload creates a job', () => {
    const b = scribeTicketBullet();
    expect(b).toMatch(/never a `\$new_` ref, because no payload creates a job/);
    expect(b).not.toMatch(/`\$new_<name>` ref to a job/);
    expect(b).toMatch(/lead_id is a real lead id or a `\$new_<name>` ref to a lead created earlier in the same payload/);
    // No job op creates a row: the job grammar has no `op` key at all.
    expect([...dispatcher.PAYLOAD_OPS_SCHEMAS.job.allowedTopKeys]).not.toContain('op');
  });

  test('condition and either side of op:"move" are named as refused — and the dispatcher refuses both, terminally', () => {
    const b = scribeTicketBullet();
    const refused = b.slice(b.indexOf('- REFUSED'));
    expect(refused).toMatch(/a `condition` on a service_ticket target/);
    expect(refused).toMatch(/EITHER side \(source or dest\) of an `op:'move'`/);

    const cond = refusal(Object.assign(upd({ fields: { title: 'x' } }), { condition: 'upsert' }));
    expect(cond && cond.detail && cond.detail.retryable).toBe(false);
    for (const side of ['source', 'dest']) {
      const other = side === 'source' ? 'dest' : 'source';
      const mv = refusal({ op: 'move', [side]: upd({ fields: { title: 'a' } }),
        [other]: { entity_type: 'lead', entity_id: 'l1', ops: { op: 'update', fields: { title: 'b' } } } });
      expect(mv && mv.message).toMatch(new RegExp('move\\.' + side + ' cannot be a service_ticket target'));
      expect(mv.detail.retryable).toBe(false);
    }
  });

  test('the payload title and summary name the ticket by its title only', () => {
    const b = scribeTicketBullet();
    expect(b).toMatch(/payload `title` and `summary`[^\n]*TITLE ONLY — never its scope, its notes, the site contact's name or phone, or the address/);
  });
});
