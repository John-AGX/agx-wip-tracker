// Service ticket fields — the one check every office write runs (1.29).
//
// server/services/service-ticket-fields.js is pure, so its rules run here with
// no database and no JWT_SECRET: what a date, a phone number, a priority and a
// pasted scope must look like, which error wins when a body has several, and
// when a value the page loaded counts as "the same" as the stored one (the
// PATCH conflict check depends on it). Each load-bearing rule is then removed
// from a temp copy of the module and shown to go red.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../server/services/service-ticket-fields');

const SRC = path.join(__dirname, '..', 'server', 'services', 'service-ticket-fields.js');
const made = [];
afterAll(() => { for (const p of made) { try { fs.unlinkSync(p); } catch (_) {} } });

function mutant(find, replace) {
  const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(find).length !== 2) throw new Error('anchor not found');
  const p = path.join(os.tmpdir(), '_p86_stf_' + process.pid + '_' + Math.random().toString(36).slice(2, 9) + '.js');
  fs.writeFileSync(p, src.replace(find, replace), 'utf8');
  made.push(p);
  return require(p);
}

const upd = (body) => F.validateTicketFields(body, { mode: 'update' });
const create = (body) => F.validateTicketFields(body, { mode: 'create' });

describe('the module stays pure', () => {
  test('it requires nothing', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).not.toMatch(/require\(/);
    expect(src).not.toMatch(/process\.env/);
  });
});

describe('text', () => {
  test("trims, and turns '' and null into null", () => {
    expect(upd({ scope_proposed: '  Replace post  ', access_notes: '', internal_notes: null }))
      .toEqual({ ok: true, values: { scope_proposed: 'Replace post', access_notes: null, internal_notes: null } });
    expect(upd({ city: '   ' })).toEqual({ ok: true, values: { city: null } });
  });

  test('a number or a boolean is kept as text; an object or a list is refused by name', () => {
    expect(upd({ zip: 32701 }).values.zip).toBe('32701');
    expect(upd({ requested_by: true }).values.requested_by).toBe('true');
    expect(upd({ scope_proposed: { a: 1 } })).toEqual({ ok: false, field: 'scope_proposed', error: 'Scope must be text.' });
    expect(upd({ city: ['Orlando'] })).toEqual({ ok: false, field: 'city', error: 'City must be text.' });
  });

  test('a NUL byte is stripped, not handed to Postgres', () => {
    const r = upd({ scope_proposed: 'Bldg 784\u0000 post' });
    expect(r).toEqual({ ok: true, values: { scope_proposed: 'Bldg 784 post' } });
    expect(r.values.scope_proposed.indexOf('\u0000')).toBe(-1);
  });

  test('over the cap names the field and the cap', () => {
    expect(upd({ access_notes: 'x'.repeat(1001) }))
      .toEqual({ ok: false, field: 'access_notes', error: 'Gate code / access is too long — 1000 characters at most.' });
    expect(upd({ access_notes: 'x'.repeat(1000) }).ok).toBe(true);
    expect(upd({ title: 't'.repeat(301) }).error).toBe('Title is too long — 300 characters at most.');
    expect(upd({ scope_approved: 's'.repeat(20001) }).error).toBe('Approved scope is too long — 20000 characters at most.');
    expect(upd({ internal_notes: 'n'.repeat(10001) }).error).toBe('Internal notes is too long — 10000 characters at most.');
  });

  test('a title is required on create, and cannot be blanked on update', () => {
    const refusal = { ok: false, field: 'title', error: 'Give the ticket a title.' };
    expect(create({ scope_proposed: 'x' })).toEqual(refusal);
    expect(create({ title: '   ' })).toEqual(refusal);
    expect(upd({ title: '' })).toEqual(refusal);
    expect(upd({ title: null })).toEqual(refusal);
    expect(upd({ title: '\u0000 ' })).toEqual(refusal);
    // An update that does not send the title leaves it alone.
    expect(upd({ city: 'Orlando' })).toEqual({ ok: true, values: { city: 'Orlando' } });
    expect(create({ title: ' Latitude 28 punch list ' }).values.title).toBe('Latitude 28 punch list');
  });
});

describe('dates', () => {
  test('only a real calendar date between 2000 and 2100 is accepted', () => {
    for (const bad of ['2026-02-30', '09/20/2026', 'next tuesday', '1999-01-01', '2101-01-01', '2026-13-01',
      '2026-9-20', '2026-09-20T12:00:00.000Z', 20260920]) {
      expect(upd({ due_date: bad })).toEqual({ ok: false, field: 'due_date', error: 'Due date must be a real date (YYYY-MM-DD).' });
    }
    expect(upd({ scheduled_for: '2026-02-30' }).error).toBe('Scheduled date must be a real date (YYYY-MM-DD).');
  });

  test('a date the server itself serialized round-trips to YYYY-MM-DD', () => {
    expect(upd({ due_date: '2026-09-20' }).values.due_date).toBe('2026-09-20');
    expect(upd({ due_date: '2026-09-20T00:00:00.000Z' }).values.due_date).toBe('2026-09-20');
    expect(upd({ due_date: '2026-09-20T00:00:00Z' }).values.due_date).toBe('2026-09-20');
    expect(upd({ due_date: '2028-02-29' }).values.due_date).toBe('2028-02-29');
    expect(upd({ due_date: '', scheduled_for: null }).values).toEqual({ due_date: null, scheduled_for: null });
  });
});

describe('priority', () => {
  test('trimmed and lower-cased; anything else is refused', () => {
    expect(upd({ priority: ' HIGH ' }).values.priority).toBe('high');
    expect(upd({ priority: 'ASAP' })).toEqual({ ok: false, field: 'priority', error: 'Priority must be Low, Normal, High or Urgent.' });
    expect(upd({ priority: 3 }).ok).toBe(false);
  });

  test('blank is left to the database default on create, and refused on update', () => {
    expect(create({ title: 'x', priority: '' })).toEqual({ ok: true, values: { title: 'x' } });
    expect(create({ title: 'x', priority: null })).toEqual({ ok: true, values: { title: 'x' } });
    expect(upd({ priority: null })).toEqual({ ok: false, field: 'priority', error: 'Priority must be Low, Normal, High or Urgent.' });
    expect(upd({ priority: '  ' }).ok).toBe(false);
  });
});

describe('site phone', () => {
  test('a typed phone number keeps its formatting', () => {
    expect(upd({ site_contact_phone: ' 407-555-0123 ext 4 ' }).values.site_contact_phone).toBe('407-555-0123 ext 4');
    expect(upd({ site_contact_phone: '(407) 555-0123 Ext. 12' }).values.site_contact_phone).toBe('(407) 555-0123 Ext. 12');
    expect(upd({ site_contact_phone: '+1 407.555.0123' }).ok).toBe(true);
    expect(upd({ site_contact_phone: '' }).values.site_contact_phone).toBeNull();
  });

  test('words and too few digits are refused', () => {
    const refusal = { ok: false, field: 'site_contact_phone', error: "Site phone doesn't look like a phone number." };
    expect(upd({ site_contact_phone: 'call Jose' })).toEqual(refusal);
    expect(upd({ site_contact_phone: '12345' })).toEqual(refusal);
    expect(upd({ site_contact_phone: '1'.repeat(21) })).toEqual(refusal);
    expect(upd({ site_contact_phone: '407-555-0123 $50' })).toEqual(refusal);
  });
});

describe('coordinates and the assignee', () => {
  test('latitude and longitude must be finite and in range', () => {
    expect(upd({ lat: 91 })).toEqual({ ok: false, field: 'lat', error: 'Latitude must be a number between -90 and 90.' });
    expect(upd({ lng: '-181' })).toEqual({ ok: false, field: 'lng', error: 'Longitude must be a number between -180 and 180.' });
    expect(upd({ lat: 'north' }).field).toBe('lat');
    expect(upd({ lat: [28.5] }).field).toBe('lat');
    expect(upd({ lat: '28.5' }).values.lat).toBe(28.5);
    expect(upd({ lat: 28.66121, lng: -81.3618 }).values).toEqual({ lat: 28.66121, lng: -81.3618 });
    expect(upd({ lat: '', lng: null }).values).toEqual({ lat: null, lng: null });
  });

  test('an assignee is a positive whole number, or nobody', () => {
    expect(upd({ assignee_user_id: 7 }).values.assignee_user_id).toBe(7);
    expect(upd({ assignee_user_id: '12' }).values.assignee_user_id).toBe(12);
    expect(upd({ assignee_user_id: '' }).values.assignee_user_id).toBeNull();
    expect(upd({ assignee_user_id: null }).values.assignee_user_id).toBeNull();
    for (const bad of [0, -3, 1.5, '7abc', 'Jose', {}, true, Number.MAX_SAFE_INTEGER + 1]) {
      expect(upd({ assignee_user_id: bad })).toEqual({ ok: false, field: 'assignee_user_id', error: F.ASSIGNEE_REFUSAL });
    }
    expect(F.ASSIGNEE_REFUSAL).toBe('Assignee is not a user in this organization');
  });
});

describe('the walk', () => {
  test('rule order decides the first error, not body order', () => {
    const body = { assignee_user_id: 'x', due_date: 'soon', lat: 200, site_contact_phone: 'nope', title: '' };
    expect(upd(body).field).toBe('title');
    delete body.title;
    expect(upd(body).field).toBe('site_contact_phone');
    delete body.site_contact_phone;
    expect(upd(body).field).toBe('lat');
    delete body.lat;
    expect(upd(body).field).toBe('due_date');
    delete body.due_date;
    expect(upd(body).field).toBe('assignee_user_id');
  });

  test('the rule table is the order the office-editing spec lists', () => {
    expect(F.TICKET_FIELD_RULES.map((r) => r.key)).toEqual([
      'title', 'scope_proposed', 'scope_approved', 'internal_notes', 'requested_by', 'site_contact_name',
      'site_contact_phone', 'access_notes', 'street_address', 'city', 'state', 'zip', 'lat', 'lng',
      'priority', 'scheduled_for', 'due_date', 'assignee_user_id',
    ]);
    expect(Object.isFrozen(F.TICKET_FIELD_RULES)).toBe(true);
    expect(F.TICKET_FIELD_LABELS.access_notes).toBe('Gate code / access');
  });

  test('unknown keys and undefined values are ignored', () => {
    expect(upd({ status: 'approved', organization_id: 2, contract_value: 1, city: undefined, zip: '32701' }))
      .toEqual({ ok: true, values: { zip: '32701' } });
    expect(upd(null)).toEqual({ ok: true, values: {} });
  });
});

describe('comparing a loaded value with the stored one', () => {
  test('a Date and YYYY-MM-DD, CRLF and LF, null and "" are the same value', () => {
    expect(F.sameTicketFieldValue('due_date', new Date(2026, 8, 20), '2026-09-20')).toBe(true);
    expect(F.sameTicketFieldValue('due_date', '2026-09-20T00:00:00.000Z', '2026-09-20')).toBe(true);
    expect(F.sameTicketFieldValue('scope_proposed', 'line one\r\nline two', 'line one\nline two ')).toBe(true);
    expect(F.sameTicketFieldValue('internal_notes', null, '')).toBe(true);
    expect(F.sameTicketFieldValue('city', undefined, null)).toBe(true);
    expect(F.sameTicketFieldValue('assignee_user_id', 7, '7')).toBe(true);
    expect(F.sameTicketFieldValue('priority', 'HIGH', 'high')).toBe(true);
    expect(F.sameTicketFieldValue('lat', '28.50', 28.5)).toBe(true);
  });

  test('a real change is a change', () => {
    expect(F.sameTicketFieldValue('due_date', new Date(2026, 8, 20), '2026-09-21')).toBe(false);
    expect(F.sameTicketFieldValue('scope_proposed', 'a', 'b')).toBe(false);
    expect(F.sameTicketFieldValue('assignee_user_id', 7, 8)).toBe(false);
    expect(F.sameTicketFieldValue('assignee_user_id', 7, null)).toBe(false);
    expect(F.sameTicketFieldValue('internal_notes', null, 'x')).toBe(false);
  });

  test('ticketFieldDateOnly reads a Date locally and a string by its leading date', () => {
    expect(F.ticketFieldDateOnly(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(F.ticketFieldDateOnly('2026-09-20T04:00:00.000Z')).toBe('2026-09-20');
    expect(F.ticketFieldDateOnly('soon')).toBeNull();
    expect(F.ticketFieldDateOnly(null)).toBeNull();
    expect(F.ticketFieldDateOnly(new Date('nope'))).toBeNull();
    expect(F.ticketFieldComparable('assignee_user_id', 'Jose')).toBe('');
  });
});

describe('address and labels', () => {
  test('City, State or ZIP without a street is a problem; a full address or none is not', () => {
    const problem = { field: 'street_address', error: 'Add a street address, or clear City, State and ZIP.' };
    expect(F.ticketAddressProblem({ city: 'Altamonte Springs' })).toEqual(problem);
    expect(F.ticketAddressProblem({ street_address: '  ', zip: '32701' })).toEqual(problem);
    expect(F.ticketAddressProblem({ street_address: '828 Orienta Ave', city: 'Altamonte Springs' })).toBeNull();
    expect(F.ticketAddressProblem({})).toBeNull();
    expect(F.ticketAddressProblem(null)).toBeNull();
  });

  test("labelList reads 'A', 'A and B', 'A, B and C'", () => {
    expect(F.labelList(['scope_proposed'])).toBe('Scope');
    expect(F.labelList(['scope_proposed', 'due_date'])).toBe('Scope and Due date');
    expect(F.labelList(['title', 'scope_proposed', 'due_date'])).toBe('Title, Scope and Due date');
    expect(F.labelList(['title', 'title', 'Materials'])).toBe('Title and Materials');
    expect(F.labelList([])).toBe('');
  });
});

describe('MUTANTS: each rule, removed, goes red', () => {
  test('without the calendar round trip, February 30th is stored', () => {
    const M = mutant(
      '  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return bad;\n', '');
    expect(M.validateTicketFields({ due_date: '2026-02-30' }, { mode: 'update' }).ok).toBe(true);
    expect(upd({ due_date: '2026-02-30' }).ok).toBe(false);
  });

  test('without the NUL strip, a pasted NUL reaches the database', () => {
    const M = mutant("  s = s.replace(NUL_RE, '').trim();\n", '  s = s.trim();\n');
    expect(M.validateTicketFields({ scope_proposed: 'a\u0000b' }, { mode: 'update' }).values.scope_proposed).toBe('a\u0000b');
    expect(upd({ scope_proposed: 'a\u0000b' }).values.scope_proposed).toBe('ab');
  });

  test('without the create check, a ticket with no title gets through', () => {
    const M = mutant('      if (r.required && mode === \'create\') return refuse(r.key, TITLE_REFUSAL);\n', '');
    expect(M.validateTicketFields({ scope_proposed: 'x' }, { mode: 'create' }).ok).toBe(true);
    expect(create({ scope_proposed: 'x' }).ok).toBe(false);
  });

  test('without the priority update refusal, a blank priority reaches NOT NULL', () => {
    const M = mutant("    return mode === 'create' ? { omit: true } : { error: PRIORITY_REFUSAL };\n",
      '    return { omit: true };\n');
    expect(M.validateTicketFields({ priority: null }, { mode: 'update' }).ok).toBe(true);
    expect(upd({ priority: null }).ok).toBe(false);
  });

  test('without CRLF folding, a textarea round trip reads as someone else\'s change', () => {
    const M = mutant("  return String(v).replace(/\\r\\n?/g, '\\n').trim();\n", '  return String(v).trim();\n');
    expect(M.sameTicketFieldValue('scope_proposed', 'a\r\nb', 'a\nb')).toBe(false);
    expect(F.sameTicketFieldValue('scope_proposed', 'a\r\nb', 'a\nb')).toBe(true);
  });

  test('without the digit count, "12345" is a phone number', () => {
    const M = mutant('  if (digits < 7 || digits > 20) return bad;\n', '');
    expect(M.validateTicketFields({ site_contact_phone: '12345' }, { mode: 'update' }).ok).toBe(true);
    expect(upd({ site_contact_phone: '12345' }).ok).toBe(false);
  });
});
