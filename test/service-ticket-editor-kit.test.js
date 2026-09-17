/**
 * @jest-environment jsdom
 */
// The office editor kit, js/service-ticket-editor.js (window.p86StEditor).
//
// Every drive runs the SHIPPED file in jsdom: field markup, dirty tracking
// against the server's JSON, the changed-only patch with `expected`, the
// unsaved-changes question, the refused-field highlight, the edit-conflict
// banner, the Assigned to picker, section swaps and scroll keeping.
//
// Mutants: the source is copied to a temp dir with CRLF normalised, the anchor
// must occur exactly once, and the named behaviour must go red on the copy.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'js', 'service-ticket-editor.js');
const RAW = fs.readFileSync(SRC_PATH, 'utf8');
const SRC = RAW.replace(/\r\n/g, '\n');
const E = require('../js/service-ticket-editor.js');

let seq = 0;
function loadFrom(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-st-editor-'));
  const file = path.join(dir, 'service-ticket-editor-' + (++seq) + '.js');
  fs.writeFileSync(file, src);
  let mod;
  jest.isolateModules(() => { mod = require(file); });
  window.p86StEditor = E;
  return mod;
}

function mutant(from, to) {
  return mutantAll([[from, to]]);
}

function mutantAll(pairs) {
  let out = SRC;
  pairs.forEach(([from, to]) => {
    const at = out.indexOf(from);
    if (at === -1 || out.indexOf(from, at + from.length) !== -1) throw new Error('anchor not found');
    const next = out.slice(0, at) + to + out.slice(at + from.length);
    if (next === out) throw new Error('anchor not found');
    out = next;
  });
  return loadFrom(out);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 6; i++) await tick(); }

const TICKET = (over) => Object.assign({
  id: 'st_1', ticket_number: 'ST-0007', title: 'Gate will not latch', status: 'open',
  job_id: 'job_7', lead_id: null,
  scope_proposed: 'Rehang the gate\r\nCheck the latch', internal_notes: 'Owner is slow to pay\r\n',
  priority: 'normal', assignee_user_id: 12,
  scheduled_for: '2026-09-20T00:00:00.000Z', due_date: null,
  site_contact_name: 'Rosa', site_contact_phone: '407-555-0123 ext 4', access_notes: 'Gate 1234',
  street_address: null, city: null, state: null, zip: null,
}, over || {});

// A detail laid out the way the office screen lays it out: the scope textarea
// is the host's (it carries data-st-field), the rest is the kit's markup.
function mount(t, opts) {
  const o = Object.assign({ canEdit: true, site: { address: '12 Bay St, Tampa, FL 33602' }, word: 'job', mod: E }, opts || {});
  const K = o.mod;
  document.body.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'p86-st-detail';
  d.innerHTML =
    '<div class="p86-st-scopecard">' + K.titleFieldHTML(t, o.canEdit) +
      '<label class="p86-st-lbl">Proposed scope</label>' +
      (o.canEdit ? '<textarea class="p86-st-scope" data-st-field="scope_proposed">' + esc(t.scope_proposed) + '</textarea>' : '') +
    '</div>' +
    K.internalNotesHTML(t, o.canEdit) +
    '<div class="p86-st-detail-side">' + K.sideFieldsHTML(t, o.canEdit, o.site, o.word, o.side) + '</div>';
  document.body.appendChild(d);
  return d;
}

function setVal(root, key, v) {
  const c = root.querySelector('[data-st-field="' + key + '"]');
  c.value = v;
  return c;
}

beforeEach(() => {
  E._reset();
  delete window.p86ConfirmTernary;
  delete window.p86Confirm;
  delete window.p86Toast;
  delete window.p86Api;
  document.body.innerHTML = '';
});

// ══════════════════════════════════════════════════════════════════════
describe('the kit surface', () => {
  test('every contract name is on module.exports and window.p86StEditor', () => {
    const NAMES = ['FIELDS', 'titleFieldHTML', 'internalNotesHTML', 'sideFieldsHTML', 'baseOf', 'norm', 'dirtyKeys',
      'buildPatch', 'labelList', 'unsavedExtras', 'confirmUnsaved', 'markInvalid', 'clearInvalid', 'showConflict',
      'fillAssignees', 'directory', 'nameOf', 'initials', 'sec', 'swapSection', 'keepScroll'];
    NAMES.forEach((n) => {
      expect([n, n === 'FIELDS' ? Array.isArray(E[n]) : typeof E[n]]).toEqual([n, n === 'FIELDS' ? true : 'function']);
    });
    expect(window.p86StEditor).toBe(E);
    // Reason dialogs belong to js/work-order-review.js, not here.
    expect(E.reasonFor).toBeUndefined();
    expect(E.askReason).toBeUndefined();
  });

  test('the file is CRLF, defines no date-helper names, and uses no native dialogs', () => {
    expect(RAW.indexOf('\r\n')).toBeGreaterThan(-1);
    expect(RAW.replace(/\r\n/g, '')).not.toMatch(/\n/);
    expect(SRC).not.toMatch(/function\s+(fmtDate\w*|fmtDay\w*|formatDate\w*|todayISO)\s*\(/);
    expect(SRC).not.toMatch(/(^|[^\w.])(window\.)?(confirm|prompt|alert)\s*\(/);
  });

  test('every p86Confirm call passes confirmText, destructive and cancelText', () => {
    const sites = [];
    let i = 0;
    while ((i = SRC.indexOf('p86Confirm(', i)) !== -1) {
      let depth = 0; let end = -1;
      for (let j = i + 10; j < SRC.length; j++) {
        if (SRC[j] === '(') depth++;
        else if (SRC[j] === ')') { depth--; if (depth === 0) { end = j; break; } }
      }
      sites.push(SRC.slice(i + 10, end + 1));
      i = end;
    }
    expect(sites.length).toBeGreaterThan(0);
    sites.forEach((arg) => {
      expect([/\bconfirmText\s*:/.test(arg), /\bdestructive\s*:/.test(arg), /\bcancelText\s*:/.test(arg)]).toEqual([true, true, true]);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('FIELDS, labels and comparison', () => {
  test('labels and caps', () => {
    const byKey = {};
    E.FIELDS.forEach((f) => { byKey[f.key] = [f.label, f.max]; });
    expect(byKey).toEqual({
      title: ['Title', 300], scope_proposed: ['Scope', 20000], internal_notes: ['Internal notes', 10000],
      priority: ['Priority', null], assignee_user_id: ['Assigned to', null],
      scheduled_for: ['Scheduled', null], due_date: ['Due', null],
      site_contact_name: ['Site contact', 200], site_contact_phone: ['Site phone', 40],
      access_notes: ['Gate code / access', 1000],
      street_address: ['Address', 300], city: ['Address', 120], state: ['Address', 60], zip: ['Address', 20],
    });
    expect(Object.isFrozen(E.FIELDS)).toBe(true);
  });

  test('labelList joins and de-duplicates the address', () => {
    expect(E.labelList(['scope_proposed'])).toBe('Scope');
    expect(E.labelList(['scope_proposed', 'due_date'])).toBe('Scope and Due');
    expect(E.labelList(['title', 'scope_proposed', 'due_date'])).toBe('Title, Scope and Due');
    expect(E.labelList(['street_address', 'city', 'zip'])).toBe('Address');
    expect(E.labelList(['street_address', 'city', 'due_date'])).toBe('Address and Due');
  });

  test('norm matches the server comparison', () => {
    expect(E.norm('due_date', '2026-09-20T00:00:00.000Z')).toBe('2026-09-20');
    expect(E.norm('due_date', '2026-09-20')).toBe('2026-09-20');
    expect(E.norm('due_date', null)).toBe('');
    expect(E.norm('due_date', '')).toBe('');
    expect(E.norm('assignee_user_id', 12)).toBe('12');
    expect(E.norm('assignee_user_id', '12')).toBe('12');
    expect(E.norm('assignee_user_id', '0')).toBe('');
    expect(E.norm('assignee_user_id', 'abc')).toBe('');
    expect(E.norm('priority', ' HIGH ')).toBe('high');
    expect(E.norm('scope_proposed', 'a\r\nb  ')).toBe(E.norm('scope_proposed', 'a\nb'));
    expect(E.norm('title', undefined)).toBe('');
  });

  test('norm matches the server on a lone CR, an unreadable date and an odd pin', () => {
    const S = require('../server/services/service-ticket-fields.js');
    const cases = [
      ['internal_notes', 'x\ry'], ['internal_notes', 'x\r\n\ry '], ['scope_proposed', 'a\nb'],
      ['due_date', 'soon'], ['due_date', ' 2026-09-20'], ['due_date', '2026-09-20T00:00:00.000Z'],
      ['due_date', ''], ['scheduled_for', new Date(2026, 8, 20)],
      ['lat', ' 28.5 '], ['lat', 'north'], ['lat', '  '],
      ['assignee_user_id', ' 012 '], ['assignee_user_id', 7], ['priority', ' Urgent'],
    ];
    cases.forEach(([k, v]) => expect([k, v, E.norm(k, v)]).toEqual([k, v, S.ticketFieldComparable(k, v)]));
    expect(E.norm('internal_notes', 'x\ry')).toBe(E.norm('internal_notes', 'x\ny'));
    expect(E.norm('due_date', 'soon')).toBe('soon');
  });

  test('baseOf takes the raw server values, null for missing', () => {
    const base = E.baseOf({ scope_proposed: 'x\r\ny', due_date: '2026-09-20T00:00:00.000Z' });
    expect(base.scope_proposed).toBe('x\r\ny');
    expect(base.due_date).toBe('2026-09-20T00:00:00.000Z');
    expect(base.title).toBeNull();
    expect(Object.keys(base)).toEqual(E.FIELDS.map((f) => f.key));
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('field markup', () => {
  test('title box', () => {
    const d = mount(TICKET({ title: 'Bldg "7" <b>gate</b> & rail' }));
    const inp = d.querySelector('input.p86-st-title-in');
    expect(inp.getAttribute('data-st-field')).toBe('title');
    expect(inp.getAttribute('maxlength')).toBe('300');
    expect(inp.value).toBe('Bldg "7" <b>gate</b> & rail');
    expect(d.querySelector('.p86-st-scopecard b')).toBeNull();
    expect(d.querySelector('.p86-st-scopecard > .p86-st-lbl').textContent).toBe('Title');
  });

  test('internal notes card, editable and read-only', () => {
    let d = mount(TICKET());
    const card = d.querySelector('.p86-st-internalcard');
    expect(card.querySelector('.p86-st-lbl').textContent).toBe('Internal notes Office only');
    expect(card.querySelector('.p86-st-office-chip').textContent).toBe('Office only');
    const ta = card.querySelector('textarea.p86-st-internal');
    expect([ta.getAttribute('rows'), ta.getAttribute('maxlength'), ta.getAttribute('placeholder'), ta.getAttribute('data-st-field')])
      .toEqual(['3', '10000', 'Notes for the office. The crew never sees these.', 'internal_notes']);
    expect(card.querySelector('.p86-st-help').textContent).toBe('Never shown on the crew link.');

    d = mount(TICKET({ internal_notes: null }), { canEdit: false });
    expect(d.querySelector('.p86-st-internalcard .p86-st-ro').textContent).toBe('No internal notes.');
    expect(d.querySelector('textarea')).toBeNull();
    d = mount(TICKET({ internal_notes: 'Pay <late>' }), { canEdit: false });
    expect(d.querySelector('.p86-st-internalcard .p86-st-ro').textContent).toBe('Pay <late>');
  });

  test('Details rows, controls and kept classes', () => {
    const d = mount(TICKET(), { side: { statusHTML: '<span class="p86-st-status st-open">Open</span>' } });
    const side = d.querySelector('.p86-st-detail-side');
    expect(Array.from(side.querySelectorAll('.p86-st-meta')).map((m) => m.getAttribute('data-for'))).toEqual([
      'status', 'assignee_user_id', 'priority', 'scheduled_for', 'due_date',
      'site_contact_name', 'site_contact_phone', 'access_notes', 'address',
    ]);
    expect(Array.from(side.querySelectorAll('.p86-st-meta-k')).map((k) => k.textContent)).toEqual([
      'Status', 'Assigned to', 'Priority', 'Scheduled', 'Due', 'Site contact', 'Site phone', 'Gate code / access', 'Address',
    ]);

    const who = side.querySelector('select.p86-st-assignee[data-st-field="assignee_user_id"]');
    expect(who.options[0].value).toBe('');
    expect(who.options[0].textContent).toBe('Unassigned');
    expect(who.value).toBe('12');

    expect(side.querySelector('select.p86-st-prio-sel[data-st-field="priority"]').value).toBe('normal');
    expect(side.querySelector('input.p86-st-sched[data-st-field="scheduled_for"]').value).toBe('2026-09-20');
    expect(side.querySelector('input.p86-st-due[data-st-field="due_date"]').value).toBe('');
    const contact = side.querySelector('input.p86-st-contact[data-st-field="site_contact_name"]');
    expect([contact.value, contact.getAttribute('maxlength')]).toEqual(['Rosa', '200']);

    const phone = side.querySelector('input.p86-st-phone[data-st-field="site_contact_phone"]');
    expect([phone.getAttribute('type'), phone.getAttribute('inputmode'), phone.getAttribute('maxlength'), phone.getAttribute('placeholder'), phone.value])
      .toEqual(['tel', 'tel', '40', '(407) 555-0123', '407-555-0123 ext 4']);

    const access = side.querySelector('textarea.p86-st-access[data-st-field="access_notes"]');
    expect([access.getAttribute('rows'), access.getAttribute('maxlength'), access.getAttribute('placeholder'), access.value])
      .toEqual(['2', '1000', 'Gate code, lockbox, where to park', 'Gate 1234']);

    const dirty = side.querySelector('span.p86-st-dirty');
    const err = side.querySelector('div.p86-st-save-err');
    const conflict = side.querySelector('div.p86-st-conflict');
    expect([dirty.getAttribute('role'), dirty.hidden, err.getAttribute('role'), err.hidden, conflict.getAttribute('role'), conflict.hidden])
      .toEqual(['status', true, 'alert', true, 'alert', true]);
  });

  test('address: effective line, override details, job and lead wording', () => {
    let d = mount(TICKET());
    let eff = d.querySelector('[data-for="address"] .p86-st-addr-eff');
    expect(eff.getAttribute('data-st-sec')).toBe('addreff');
    expect(eff.querySelector('.p86-st-addr-text').textContent).toBe('12 Bay St, Tampa, FL 33602');
    expect(eff.querySelector('.p86-st-addr-src').textContent).toBe('From the job');
    let det = d.querySelector('details.p86-st-addr-edit');
    expect(det.open).toBe(false);
    expect(det.querySelector('summary').textContent).toBe('Use a different address for this work order');
    expect(det.querySelector('.p86-st-help').textContent)
      .toBe("Leave these blank to use the job's address. The crew link and Navigate use this address.");
    expect(['street_address', 'city', 'state', 'zip'].map((k) => det.querySelector('[data-st-field="' + k + '"]').getAttribute('maxlength')))
      .toEqual(['300', '120', '60', '20']);

    d = mount(TICKET({ street_address: '90 Pier Rd', city: 'Clearwater', state: 'FL', zip: '33767' }),
      { site: { address: '90 Pier Rd, Clearwater, FL 33767' } });
    det = d.querySelector('details.p86-st-addr-edit');
    expect(det.open).toBe(true);
    expect(det.querySelector('summary').textContent).toBe('Edit the work order address');
    expect(d.querySelector('.p86-st-addr-src').textContent).toBe('This work order');

    d = mount(TICKET({ job_id: null, lead_id: 'lead_3' }), { word: 'lead', site: null });
    expect(d.querySelector('.p86-st-addr-src').textContent).toBe('From the lead');
    expect(d.querySelector('.p86-st-addr-text').textContent).toBe('—');
    expect(d.querySelector('details.p86-st-addr-edit .p86-st-help').textContent)
      .toBe("Leave these blank to use the lead's address. The crew link and Navigate use this address.");
  });

  test('read-only Details: tel link, names, no controls, no save area', () => {
    const d = mount(TICKET({ assignee_user_id: null }), { canEdit: false });
    const side = d.querySelector('.p86-st-detail-side');
    expect(side.querySelector('[data-st-field]')).toBeNull();
    expect(side.querySelector('.p86-st-savearea')).toBeNull();
    expect(side.querySelector('details')).toBeNull();
    expect(side.querySelector('[data-for="assignee_user_id"] .p86-st-meta-v').textContent).toBe('Unassigned');
    const tel = side.querySelector('[data-for="site_contact_phone"] a');
    expect([tel.getAttribute('href'), tel.textContent]).toEqual(['tel:4075550123', '407-555-0123 ext 4']);
    expect(side.querySelector('[data-for="due_date"] .p86-st-meta-v').textContent).toBe('—');
    expect(side.querySelector('[data-for="scheduled_for"] .p86-st-meta-v').textContent).toMatch(/20/);
  });

  test('typed text cannot become markup', () => {
    const evil = '</textarea><img src=x onerror="window.__pwned=1">';
    const d = mount(TICKET({ access_notes: evil, internal_notes: evil, site_contact_name: '"><img src=x>' }),
      { site: { address: '<img src=x>' } });
    expect(d.querySelector('img')).toBeNull();
    expect(d.querySelector('.p86-st-access').value).toBe(evil);
    const ro = mount(TICKET({ access_notes: evil, site_contact_name: '<img src=x>', assignee_name: '<img src=x>' }), { canEdit: false });
    expect(ro.querySelector('img')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('dirtyKeys and buildPatch', () => {
  test('a freshly painted ticket is clean (CRLF, T00:00 dates and numeric ids are not edits)', () => {
    const t = TICKET();
    const d = mount(t);
    expect(E.dirtyKeys(d, E.baseOf(t))).toEqual([]);
    expect(E.buildPatch(d, E.baseOf(t))).toEqual({ expected: {} });
  });

  test('a line break stored in a one-line box is not an edit, and Save leaves that field alone', () => {
    const t = TICKET({
      title: 'Gate\nlatch', street_address: '12 Bay St\r\nSuite 4', city: 'Tampa\r', state: 'FL', zip: '33602',
      site_contact_name: 'Rosa\nLee', site_contact_phone: '407\r\n555', internal_notes: 'x\ry',
    });
    const d = mount(t);
    const base = E.baseOf(t);
    expect(d.querySelector('[data-st-field="title"]').value).toBe('Gatelatch');
    expect(E.dirtyKeys(d, base)).toEqual([]);
    expect(E.buildPatch(d, base)).toEqual({ expected: {} });
    setVal(d, 'due_date', '2026-10-01');
    expect(E.buildPatch(d, base)).toEqual({ due_date: '2026-10-01', expected: { due_date: null } });
    setVal(d, 'title', 'Gate latch');
    expect(E.dirtyKeys(d, base)).toEqual(['title', 'due_date']);
    expect(E.buildPatch(d, base)).toEqual({
      title: 'Gate latch', due_date: '2026-10-01', expected: { title: 'Gate\nlatch', due_date: null },
    });
  });

  test('MUTANT: comparing a one-line box with the raw base reads a stored line break as an edit', () => {
    const M = mutant('norm(f.key, shownBase(c, f.key, b[f.key]))', 'norm(f.key, b[f.key])');
    const t = TICKET({ title: 'Gate\nlatch', street_address: '12 Bay St\r\nSuite 4', city: 'Tampa', state: 'FL', zip: '33602' });
    const d = mount(t, { mod: M });
    expect(M.dirtyKeys(d, M.baseOf(t))).toEqual(['title', 'street_address']);
  });

  test('changing only Due sends only Due, with what it was', () => {
    const t = TICKET();
    const d = mount(t);
    const base = E.baseOf(t);
    setVal(d, 'due_date', '2026-10-01');
    expect(E.dirtyKeys(d, base)).toEqual(['due_date']);
    expect(E.buildPatch(d, base)).toEqual({ due_date: '2026-10-01', expected: { due_date: null } });
  });

  test('empty dates and assignee send null; the assignee goes as a Number; text goes raw', () => {
    const t = TICKET();
    const d = mount(t);
    const base = E.baseOf(t);
    setVal(d, 'scheduled_for', '');
    setVal(d, 'title', '  New title  ');
    const sel = d.querySelector('.p86-st-assignee');
    sel.insertAdjacentHTML('beforeend', '<option value="15">Ana</option>');
    sel.value = '15';
    expect(E.dirtyKeys(d, base)).toEqual(['title', 'assignee_user_id', 'scheduled_for']);
    expect(E.buildPatch(d, base)).toEqual({
      title: '  New title  ', assignee_user_id: 15, scheduled_for: null,
      expected: { title: 'Gate will not latch', assignee_user_id: 12, scheduled_for: '2026-09-20T00:00:00.000Z' },
    });
    sel.value = '';
    expect(E.buildPatch(d, base, ['assignee_user_id'])).toEqual({ assignee_user_id: null, expected: { assignee_user_id: 12 } });
  });

  test('typing the same value back is not a change; the address reads as Address', () => {
    const t = TICKET();
    const d = mount(t);
    const base = E.baseOf(t);
    setVal(d, 'scope_proposed', 'Rehang the gate\nCheck the latch  ');
    setVal(d, 'street_address', '5 Dock St');
    setVal(d, 'city', 'Tampa');
    expect(E.dirtyKeys(d, base)).toEqual(['street_address', 'city']);
    expect(E.labelList(E.dirtyKeys(d, base))).toBe('Address');
  });

  test('MUTANT: buildPatch over all FIELDS puts unchanged keys in the patch', () => {
    const M = mutant(': dirtyKeys(root, b);', ': FIELDS.map(function (f) { return f.key; });');
    const t = TICKET();
    const d = mount(t, { mod: M });
    setVal(d, 'due_date', '2026-10-01');
    const patch = M.buildPatch(d, M.baseOf(t));
    expect(patch).not.toEqual({ due_date: '2026-10-01', expected: { due_date: null } });
    expect(Object.keys(patch)).toContain('scope_proposed');
  });

  test('showDirty names the unsaved fields once each', () => {
    const d = mount(TICKET());
    E.showDirty(d, ['scope_proposed', 'street_address', 'city', 'due_date']);
    const el = d.querySelector('.p86-st-dirty');
    expect([el.textContent, el.hidden]).toEqual(['Unsaved: Scope, Address, Due', false]);
    E.showDirty(d, []);
    expect(el.hidden).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('unsavedExtras', () => {
  function extrasRoot() {
    document.body.innerHTML =
      '<div class="p86-st-detail">' +
        '<div class="p86-wo-mats"><div class="p86-wo-mats-form">' +
          '<div class="p86-wo-mat-rows"><div class="p86-wo-mat-row">' +
            '<input type="text" class="p86-wo-mat-q" value="2" /><input type="text" class="p86-wo-mat-d" value="Hinge" />' +
          '</div></div></div></div>' +
        '<div class="p86-wo-sub" data-task="a"><input type="text" class="p86-wo-note-in" /></div>' +
        '<div class="p86-wo-sub" data-task="b"><input type="text" class="p86-wo-note-in" /></div>' +
        '<input type="text" class="p86-st-task-new" />' +
        '<div class="p86-st-share-out"><input readonly /></div>' +
      '</div>';
    return document.querySelector('.p86-st-detail');
  }

  test('nothing typed, nothing listed; a minted share link is not an extra', () => {
    const d = extrasRoot();
    d.querySelector('.p86-st-share-out input').value = 'https://project86.net/st/abc';
    expect(E.unsavedExtras(d)).toEqual([]);
  });

  test('each phrase', () => {
    const d = extrasRoot();
    d.querySelector('.p86-wo-mat-q').value = '3';
    d.querySelectorAll('.p86-wo-note-in')[0].value = 'Post is loose';
    d.querySelector('.p86-st-task-new').value = 'Bldg 9';
    expect(E.unsavedExtras(d)).toEqual([
      'the materials list you were editing', 'the building note you typed', 'the building you were adding',
    ]);
    d.querySelectorAll('.p86-wo-note-in')[1].value = 'Needs paint';
    expect(E.unsavedExtras(d)[1]).toBe('the 2 building notes you typed');
  });

  test('a closed materials form is not an extra unless a file is being read into it', () => {
    const d = extrasRoot();
    const form = d.querySelector('.p86-wo-mats-form');
    d.querySelector('.p86-wo-mat-q').value = '3';
    form.hidden = true;
    expect(E.unsavedExtras(d)).toEqual([]);
    form.setAttribute('data-filling', '1');
    expect(E.unsavedExtras(d)).toEqual(['the materials list you were editing']);
    d.querySelectorAll('.p86-wo-note-in')[0].value = '   ';
    expect(E.unsavedExtras(d)).toEqual(['the materials list you were editing']);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('confirmUnsaved', () => {
  test('dirty fields: the three-way question, and Save changes waits for the save', async () => {
    window.p86ConfirmTernary = jest.fn(() => Promise.resolve('primary'));
    const save = jest.fn(() => Promise.resolve(true));
    await expect(E.confirmUnsaved({ keys: ['scope_proposed', 'due_date'], extras: [], save })).resolves.toBe('saved');
    expect(save).toHaveBeenCalledTimes(1);
    expect(window.p86ConfirmTernary).toHaveBeenCalledWith({
      title: 'Save your changes first?',
      message: "You changed Scope and Due and haven't saved.",
      primaryLabel: 'Save changes',
      secondaryLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
    });
  });

  test('extras are named after the fields', async () => {
    window.p86ConfirmTernary = jest.fn(() => Promise.resolve(null));
    await E.confirmUnsaved({
      keys: ['scope_proposed'], extras: ['the building note you typed', 'the building you were adding'], save: () => true,
    });
    expect(window.p86ConfirmTernary.mock.calls[0][0].message).toBe(
      "You changed Scope and haven't saved. Continuing also loses the building note you typed and the building you were adding.");
  });

  test('a failed save stays; Discard changes discards without saving; Keep editing stays', async () => {
    const save = jest.fn(() => Promise.resolve(false));
    window.p86ConfirmTernary = jest.fn(() => Promise.resolve('primary'));
    await expect(E.confirmUnsaved({ keys: ['title'], save })).resolves.toBe('stay');
    window.p86ConfirmTernary = jest.fn(() => Promise.resolve('primary'));
    await expect(E.confirmUnsaved({ keys: ['title'], save: () => Promise.reject(new Error('x')) })).resolves.toBe('stay');

    save.mockClear();
    window.p86ConfirmTernary = jest.fn(() => Promise.resolve('secondary'));
    await expect(E.confirmUnsaved({ keys: ['title'], save })).resolves.toBe('discard');
    expect(save).not.toHaveBeenCalled();

    window.p86ConfirmTernary = jest.fn(() => Promise.resolve(null));
    await expect(E.confirmUnsaved({ keys: ['title'], save })).resolves.toBe('stay');
    expect(save).not.toHaveBeenCalled();
  });

  test('extras only: a destructive Discard dialog in both spellings', async () => {
    window.p86ConfirmTernary = jest.fn();
    window.p86Confirm = jest.fn(() => Promise.resolve(true));
    await expect(E.confirmUnsaved({ keys: [], extras: ['the materials list you were editing'] })).resolves.toBe('discard');
    expect(window.p86ConfirmTernary).not.toHaveBeenCalled();
    expect(window.p86Confirm).toHaveBeenCalledWith({
      title: 'Discard unsaved changes?',
      message: 'Continuing loses the materials list you were editing.',
      confirmText: 'Discard', confirmLabel: 'Discard',
      cancelText: 'Keep editing', cancelLabel: 'Keep editing',
      destructive: true, danger: true,
    });
    window.p86Confirm = jest.fn(() => Promise.resolve(false));
    await expect(E.confirmUnsaved({ extras: ['the building you were adding'] })).resolves.toBe('stay');
  });

  test('no dialog helper: it refuses with a toast instead of losing work', async () => {
    window.p86Toast = jest.fn();
    await expect(E.confirmUnsaved({ keys: ['title'], save: () => true })).resolves.toBe('stay');
    await expect(E.confirmUnsaved({ extras: ['the building you were adding'] })).resolves.toBe('stay');
    expect(window.p86Toast.mock.calls.map((c) => c[0])).toEqual(['Save or undo your changes first.', 'Save or undo your changes first.']);
  });

  test('nothing unsaved: no question', async () => {
    window.p86ConfirmTernary = jest.fn();
    window.p86Confirm = jest.fn();
    await expect(E.confirmUnsaved({ keys: [], extras: [] })).resolves.toBe('discard');
    expect(window.p86ConfirmTernary).not.toHaveBeenCalled();
    expect(window.p86Confirm).not.toHaveBeenCalled();
  });

  test('MUTANT: Save changes that ignores the save result reports saved after a failed save', async () => {
    const M = mutant("return ok === true ? 'saved' : 'stay';", "return 'saved';");
    window.p86ConfirmTernary = jest.fn(() => Promise.resolve('primary'));
    await expect(M.confirmUnsaved({ keys: ['title'], save: () => Promise.resolve(false) })).resolves.toBe('saved');
    await expect(E.confirmUnsaved({ keys: ['title'], save: () => Promise.resolve(false) })).resolves.toBe('stay');
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('markInvalid and clearInvalid', () => {
  beforeEach(() => { window.HTMLElement.prototype.scrollIntoView = jest.fn(); });
  afterEach(() => { delete window.HTMLElement.prototype.scrollIntoView; });

  test('the refused field is marked, focused, centred and explained', () => {
    const d = mount(TICKET());
    const c = E.markInvalid(d, 'due_date', 'Due date must be a real date (YYYY-MM-DD).');
    const due = d.querySelector('.p86-st-due');
    expect(c).toBe(due);
    expect(due.getAttribute('aria-invalid')).toBe('true');
    expect(due.classList.contains('is-invalid')).toBe(true);
    expect(document.activeElement).toBe(due);
    expect(due.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    const err = d.querySelector('.p86-st-save-err');
    expect([err.textContent, err.hidden]).toEqual(['Due date must be a real date (YYYY-MM-DD).', false]);
  });

  test('an address field opens the address details', () => {
    const d = mount(TICKET());
    const det = d.querySelector('details.p86-st-addr-edit');
    expect(det.open).toBe(false);
    E.markInvalid(d, 'street_address', 'Add a street address, or clear City, State and ZIP.');
    expect(det.open).toBe(true);
    expect(document.activeElement).toBe(d.querySelector('[data-st-field="street_address"]'));
  });

  test('typing in the field, or clearInvalid, clears it', () => {
    const d = mount(TICKET());
    E.markInvalid(d, 'title', 'Give the ticket a title.');
    const title = d.querySelector('.p86-st-title-in');
    title.value = 'Back';
    title.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(title.hasAttribute('aria-invalid')).toBe(false);
    expect(d.querySelector('.p86-st-save-err').hidden).toBe(true);

    E.markInvalid(d, 'site_contact_phone', "Site phone doesn't look like a phone number.");
    E.markInvalid(d, 'due_date', 'Due date must be a real date (YYYY-MM-DD).');
    E.clearInvalid(d);
    expect(d.querySelectorAll('[aria-invalid], .is-invalid').length).toBe(0);
    const err = d.querySelector('.p86-st-save-err');
    expect([err.textContent, err.hidden]).toEqual(['', true]);
  });

  test('a field with no box still shows the message', () => {
    const d = mount(TICKET());
    expect(E.markInvalid(d, 'lat', 'Latitude must be a number between -90 and 90.')).toBeNull();
    expect(d.querySelector('.p86-st-save-err').textContent).toBe('Latitude must be a number between -90 and 90.');
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('showConflict', () => {
  test('the banner names the field, keeps the typed text, and Use their version takes theirs', () => {
    const t = TICKET();
    const d = mount(t);
    const base = E.baseOf(t);
    setVal(d, 'scope_proposed', 'Mine');
    const seen = [];
    d.addEventListener('input', () => { seen.push(E.dirtyKeys(d, base)); });
    const cb = jest.fn((fields, theirs) => { fields.forEach((k) => { base[k] = theirs[k]; }); });

    E.showConflict(d, ['scope_proposed'], { scope_proposed: 'X', title: 'ignored' }, cb);
    const box = d.querySelector('.p86-st-conflict');
    expect(box.hidden).toBe(false);
    expect(box.querySelector('.p86-st-conflict-msg').textContent).toBe(
      'Someone else changed Scope while you were editing. Your version is still in the box — press Save to replace theirs, or use their version.');
    const use = box.querySelector('button');
    expect(use.textContent).toBe('Use their version');
    expect(d.querySelector('.p86-st-scope').value).toBe('Mine');

    use.click();
    const scope = d.querySelector('.p86-st-scope');
    expect([scope.value, scope.defaultValue]).toEqual(['X', 'X']);
    expect(d.querySelector('.p86-st-title-in').value).toBe('Gate will not latch');
    expect(cb).toHaveBeenCalledWith(['scope_proposed'], { scope_proposed: 'X', title: 'ignored' });
    expect(box.hidden).toBe(true);
    expect(E.dirtyKeys(d, base)).toEqual([]);
    // The input event fires after the caller moved its base.
    expect(seen).toEqual([[]]);
  });

  test('several fields, a date and an assignee who is not in the list', () => {
    const t = TICKET();
    const d = mount(t);
    E.showConflict(d, ['due_date', 'assignee_user_id', 'street_address'], { due_date: '2026-11-02T00:00:00.000Z', assignee_user_id: 99, street_address: '1 Main' });
    expect(d.querySelector('.p86-st-conflict-msg').textContent).toMatch(/^Someone else changed Due, Assigned to and Address while you were editing\./);
    d.querySelector('.p86-st-conflict-use').click();
    expect(d.querySelector('.p86-st-due').value).toBe('2026-11-02');
    const sel = d.querySelector('.p86-st-assignee');
    expect(sel.value).toBe('99');
    expect(Array.from(sel.options).filter((o) => o.defaultSelected).map((o) => o.value)).toEqual(['99']);
    expect(d.querySelector('[data-st-field="street_address"]').value).toBe('1 Main');
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('fillAssignees, directory, nameOf, initials', () => {
  function api(over) {
    const o = over || {};
    window.p86Api = {
      serviceTickets: {
        assignees: o.assignees || jest.fn(() => Promise.resolve({ users: [{ id: 15, name: 'Ana Diaz' }, { id: 12, name: 'Rosa Lee' }] })),
      },
      users: { list: o.list || jest.fn(() => Promise.resolve({ users: [{ id: 12, name: 'Rosa Lee' }, { id: 15, name: 'Ana Diaz' }, { id: 40, name: 'Old Timer' }] })) },
    };
    return window.p86Api;
  }
  const opts = (sel) => Array.from(sel.options).map((o) => [o.value, o.textContent]);
  const defaults = (sel) => Array.from(sel.options).filter((o) => o.defaultSelected).map((o) => o.value);

  test('eligible people in the list, the current one kept as the default', async () => {
    const A = api();
    const t = TICKET();
    const d = mount(t);
    const sel = d.querySelector('.p86-st-assignee');
    const res = await E.fillAssignees(sel, { kind: 'job', id: 'job_7' }, 12);
    expect(res.ok).toBe(true);
    expect(A.serviceTickets.assignees).toHaveBeenCalledWith('job', 'job_7');
    expect(opts(sel)).toEqual([['', 'Unassigned'], ['15', 'Ana Diaz'], ['12', 'Rosa Lee']]);
    expect(sel.value).toBe('12');
    expect(defaults(sel)).toEqual(['12']);
    expect(E.dirtyKeys(d, E.baseOf(t))).toEqual([]);
  });

  test("a current assignee who can't open the parent says so", async () => {
    api();
    let sel = mount(TICKET({ assignee_user_id: 40 })).querySelector('.p86-st-assignee');
    await E.fillAssignees(sel, { job_id: 'job_7' }, 40);
    expect(opts(sel)).toEqual([['', 'Unassigned'], ['40', "Old Timer — can't open this job"], ['15', 'Ana Diaz'], ['12', 'Rosa Lee']]);
    expect(sel.value).toBe('40');
    sel = mount(TICKET({ assignee_user_id: 40, job_id: null, lead_id: 'lead_3' }), { word: 'lead' }).querySelector('.p86-st-assignee');
    await E.fillAssignees(sel, { kind: 'lead', id: 'lead_3' }, 40);
    expect(sel.options[1].textContent).toBe("Old Timer — can't open this lead");
  });

  test('cached for 60 seconds per parent', async () => {
    const A = api();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000000);
    try {
      const sel = mount(TICKET()).querySelector('.p86-st-assignee');
      await E.fillAssignees(sel, { kind: 'job', id: 'job_7' }, 12);
      await E.fillAssignees(sel, { kind: 'job', id: 'job_7' }, 12);
      expect(A.serviceTickets.assignees).toHaveBeenCalledTimes(1);
      await E.fillAssignees(sel, { kind: 'job', id: 'job_8' }, 12);
      expect(A.serviceTickets.assignees).toHaveBeenCalledTimes(2);
      now.mockReturnValue(1000000 + 59000);
      await E.fillAssignees(sel, { kind: 'job', id: 'job_7' }, 12);
      expect(A.serviceTickets.assignees).toHaveBeenCalledTimes(2);
      now.mockReturnValue(1000000 + 61000);
      await E.fillAssignees(sel, { kind: 'job', id: 'job_7' }, 12);
      expect(A.serviceTickets.assignees).toHaveBeenCalledTimes(3);
      expect(A.users.list).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  test('a failed or missing list keeps only the current assignee, and a failure is not cached', async () => {
    const failing = jest.fn(() => Promise.reject(new Error('503')));
    api({ assignees: failing });
    const sel = mount(TICKET({ assignee_user_id: 40 })).querySelector('.p86-st-assignee');
    const res = await E.fillAssignees(sel, { kind: 'job', id: 'job_7' }, 40);
    expect(res.ok).toBe(false);
    expect(opts(sel)).toEqual([['', 'Unassigned'], ['40', 'Old Timer']]);
    await E.fillAssignees(sel, { kind: 'job', id: 'job_7' }, 40);
    expect(failing).toHaveBeenCalledTimes(2);

    window.p86Api.serviceTickets = {};
    const sel2 = mount(TICKET()).querySelector('.p86-st-assignee');
    await E.fillAssignees(sel2, { kind: 'job', id: 'job_7' }, 12);
    expect(opts(sel2)).toEqual([['', 'Unassigned'], ['12', 'Rosa Lee']]);
  });

  test('a choice made while loading is kept, and a loading placeholder goes away', async () => {
    let answer;
    api({
      assignees: jest.fn(() => Promise.resolve({ users: [{ id: 15, name: 'Ana Diaz' }, { id: 12, name: 'Rosa Lee' }] }))
        .mockImplementationOnce(() => new Promise((r) => { answer = r; })),
    });
    const sel = mount(TICKET()).querySelector('.p86-st-assignee');
    const p = E.fillAssignees(sel, { kind: 'job', id: 'job_7' }, 12);
    sel.value = '';
    await flush();
    answer({ users: [{ id: 15, name: 'Ana Diaz' }, { id: 12, name: 'Rosa Lee' }] });
    await p;
    expect(sel.value).toBe('');
    expect(defaults(sel)).toEqual(['12']);

    document.body.innerHTML = '<select id="p86StAssignee"><option value="">Unassigned</option><option value="" disabled>Loading people…</option></select>';
    const create = document.getElementById('p86StAssignee');
    await E.fillAssignees(create, { kind: 'job', id: 'job_9' }, null);
    expect(opts(create)).toEqual([['', 'Unassigned'], ['15', 'Ana Diaz'], ['12', 'Rosa Lee']]);
    expect(create.value).toBe('');
  });

  test('directory is read once; nameOf; a failed read is retried', async () => {
    const A = api();
    await E.directory();
    const list = await E.directory();
    expect(A.users.list).toHaveBeenCalledTimes(1);
    expect(list).toEqual([{ id: 12, name: 'Rosa Lee' }, { id: 15, name: 'Ana Diaz' }, { id: 40, name: 'Old Timer' }]);
    expect([E.nameOf(12), E.nameOf('15'), E.nameOf(999), E.nameOf(null)]).toEqual(['Rosa Lee', 'Ana Diaz', '', '']);

    E._reset();
    const flaky = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([{ id: 7, name: 'Kim Park' }]);
    api({ list: flaky });
    await expect(E.directory()).resolves.toEqual([]);
    await expect(E.directory()).resolves.toEqual([{ id: 7, name: 'Kim Park' }]);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  test('read-only names fill in when the directory arrives', async () => {
    api();
    const d = mount(TICKET({ assignee_user_id: 40 }), { canEdit: false });
    const span = d.querySelector('[data-st-user="40"]');
    expect(span.textContent).toBe('Loading name…');
    await E.fillNames(d);
    expect(span.textContent).toBe('Old Timer');
    expect(span.hasAttribute('data-st-pending')).toBe(false);
  });

  test('a name the directory cannot give reads Someone instead of loading forever', async () => {
    api();
    let d = mount(TICKET({ assignee_user_id: 99 }), { canEdit: false });
    await E.fillNames(d);
    expect(d.querySelector('[data-st-user="99"]').textContent).toBe('Someone');
    expect(d.querySelector('[data-st-user="99"]').hasAttribute('data-st-pending')).toBe(false);

    E._reset();
    api({ list: jest.fn().mockRejectedValue(new Error('503')) });
    d = mount(TICKET({ assignee_user_id: 12 }), { canEdit: false });
    await E.fillNames(d);
    expect(d.querySelector('[data-st-user="12"]').textContent).toBe('Someone');

    E._reset();
    delete window.p86Api;
    d = mount(TICKET({ assignee_user_id: 12 }), { canEdit: false });
    expect(d.querySelector('[data-st-user="12"]').textContent).toBe('Loading name…');
    await E.fillNames(d);
    expect(d.querySelector('[data-st-user="12"]').textContent).toBe('Someone');
  });

  test('initials', () => {
    expect(E.initials('Élodie Ñúñez')).toBe('ÉÑ');
    expect(E.initials('Rosa Lee')).toBe('RL');
    expect(E.initials('rosa')).toBe('R');
    expect(E.initials('Mary Jane van Dyke')).toBe('MD');
    expect(E.initials('ana.diaz@example.com')).toBe('AD');
    expect(E.initials('  ')).toBe('?');
    expect(E.initials(null)).toBe('?');
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('sec and swapSection', () => {
  test('sec tags the first tag, or leaves an empty template', () => {
    expect(E.sec('site', '<div class="p86-wo-site">a</div>')).toBe('<div data-st-sec="site" class="p86-wo-site">a</div>');
    expect(E.sec('site', '')).toBe('<template data-st-sec="site"></template>');
    expect(E.sec('site', '   ')).toBe('<template data-st-sec="site"></template>');
    expect(E.sec('status', '<span class="p86-st-status">Open</span>')).toBe('<span data-st-sec="status" class="p86-st-status">Open</span>');
  });

  function sectionRoot(html) {
    document.body.innerHTML = '<div class="p86-st-detail">' + E.sec('stepper', html) + '<div class="static">keep</div></div>';
    return document.querySelector('.p86-st-detail');
  }

  test('unchanged html is not swapped or re-wired; changed html is', () => {
    const one = '<div class="p86-st-stepper">Open</div>';
    const two = '<div class="p86-st-stepper">Scheduled</div>';
    const root = sectionRoot(one);
    const cache = { stepper: one };
    const wire = jest.fn();
    const before = root.querySelector('[data-st-sec="stepper"]');

    expect(E.swapSection(root, 'stepper', one, cache, wire)).toBeNull();
    expect(root.querySelector('[data-st-sec="stepper"]')).toBe(before);
    expect(wire).not.toHaveBeenCalled();

    const fresh = E.swapSection(root, 'stepper', two, cache, wire);
    expect(fresh).toBe(root.querySelector('[data-st-sec="stepper"]'));
    expect(before.isConnected).toBe(false);
    expect(fresh.textContent).toBe('Scheduled');
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledWith(fresh);
    expect(cache.stepper).toBe(two);
    expect(root.firstElementChild).toBe(fresh);

    expect(E.swapSection(root, 'stepper', two, cache, wire)).toBeNull();
    expect(wire).toHaveBeenCalledTimes(1);
  });

  test('a section can empty to a template and come back', () => {
    const root = sectionRoot('<div class="p86-st-revs">1 suggestion</div>');
    const cache = { stepper: '<div class="p86-st-revs">1 suggestion</div>' };
    const gone = E.swapSection(root, 'stepper', '', cache);
    expect(gone.tagName).toBe('TEMPLATE');
    const back = E.swapSection(root, 'stepper', '<div class="p86-st-revs">2 suggestions</div>', cache);
    expect(back.className).toBe('p86-st-revs');
    expect(root.querySelector('.static').textContent).toBe('keep');
  });

  test('MUTANT: without the cache check an unchanged section is re-wired', () => {
    const M = mutant('if (Object.prototype.hasOwnProperty.call(c, key) && c[key] === s) return null;', '');
    const html = '<div class="p86-st-stepper">Open</div>';
    const root = sectionRoot(html);
    const wire = jest.fn();
    M.swapSection(root, 'stepper', html, { stepper: html }, wire);
    expect(wire).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('keepScroll', () => {
  function rect(el, top) {
    el.getBoundingClientRect = () => ({ top: top(), bottom: top() + 40, left: 0, right: 100, width: 100, height: 40 });
  }
  function scrollHost(start) {
    document.body.innerHTML = '<div id="pane" style="overflow-y: auto; height: 500px"><div class="p86-st-row is-open"><div class="p86-st-detail"></div></div></div>';
    const pane = document.getElementById('pane');
    let st = start;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => st, set: (v) => { st = v; } });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => 3000 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 500 });
    return { pane, detail: pane.querySelector('.p86-st-detail') };
  }

  test('a replaced card is re-found by data-task and the scroller moves by its delta', () => {
    const { pane, detail } = scrollHost(300);
    detail.innerHTML = '<div class="p86-wo-subs"><div class="p86-wo-sub" data-task="t1"><button class="p86-wo-check"></button></div></div>';
    const card = detail.querySelector('[data-task="t1"]');
    rect(card, () => 100);
    const out = E.keepScroll(card.querySelector('button'), () => {
      const fresh = document.createElement('div');
      fresh.className = 'p86-wo-sub is-done';
      fresh.setAttribute('data-task', 't1');
      rect(fresh, () => 220);
      card.parentNode.replaceChild(fresh, card);
      return 'done';
    }, detail);
    expect(out).toBe('done');
    expect(pane.scrollTop).toBe(420);
  });

  test('an anchor that stays put is measured directly', () => {
    const { pane, detail } = scrollHost(500);
    detail.innerHTML = '<div data-st-sec="side"><button class="p86-st-save">Save</button></div>';
    const btn = detail.querySelector('button');
    let top = 50;
    rect(btn, () => top);
    E.keepScroll(btn, () => { top = 20; });
    expect(pane.scrollTop).toBe(470);
  });

  test('with no anchor the first child still on screen is used; a promise is waited for', async () => {
    const { pane, detail } = scrollHost(100);
    detail.innerHTML = '<div data-st-sec="stepper"></div><div data-st-sec="site"></div>';
    const [gone, shown] = detail.children;
    rect(gone, () => -80);
    let top = 5;
    rect(shown, () => top);
    const p = E.keepScroll(null, () => new Promise((r) => setTimeout(() => { top = 65; r('ok'); }, 0)));
    expect(pane.scrollTop).toBe(100);
    await expect(p).resolves.toBe('ok');
    expect(pane.scrollTop).toBe(160);
  });

  // The office detail as laid out: a grid holding the scope card and the
  // building cards, then the parts list below it. Heights change in fn.
  function detailLayout(detail, gridHasBox) {
    detail.innerHTML =
      '<div class="p86-st-detail-grid"><div class="p86-st-detail-main">' +
        '<div data-st-sec="b1"></div><div data-st-sec="b2"></div><div data-st-sec="b3"></div><div data-st-sec="b4"></div>' +
      '</div></div>' +
      '<div class="p86-st-parts" data-st-sec="parts"></div>';
    const h = { b1: 300, b2: 300, b3: 400, b4: 300, parts: 300 };
    const order = ['b1', 'b2', 'b3', 'b4', 'parts'];
    const START = -700;
    const topOf = (key) => {
      let top = START;
      for (const k of order) { if (k === key) return top; top += h[k]; }
      return top;
    };
    const stub = (el, get) => {
      el.getBoundingClientRect = () => {
        const [top, height] = get();
        return { top, bottom: top + height, height, width: 100, left: 0, right: 100 };
      };
    };
    order.forEach((k) => stub(detail.querySelector('[data-st-sec="' + k + '"]'), () => [topOf(k), h[k]]));
    if (gridHasBox) stub(detail.querySelector('.p86-st-detail-grid'), () => [START, h.b1 + h.b2 + h.b3 + h.b4]);
    return h;
  }

  test('phone layout: with no anchor, the card being read stays put (the display: contents grid is looked into)', () => {
    const { pane, detail } = scrollHost(1000);
    const h = detailLayout(detail, false);
    expect(detail.querySelector('.p86-st-detail-grid').getBoundingClientRect().height).toBe(0);
    E.keepScroll(null, () => { h.b4 += 120; });
    expect(pane.scrollTop).toBe(1000);
    E.keepScroll(null, () => { h.b2 += 120; });
    expect(pane.scrollTop).toBe(1120);
  });

  test('desktop layout: with no anchor, a card above the fold growing is corrected (the grid is too coarse)', () => {
    const { pane, detail } = scrollHost(1000);
    const h = detailLayout(detail, true);
    E.keepScroll(null, () => { h.b2 += 120; });
    expect(pane.scrollTop).toBe(1120);
    E.keepScroll(null, () => { h.b4 += 50; });
    expect(pane.scrollTop).toBe(1120);
  });

  test('MUTANT: the old first-child walk anchors the phone layout on the parts list', () => {
    const M = mutantAll([
      ['return best || shownChild(root);', 'return shownChild(root);'],
      ['var inner = shownChild(kids[i]);\n        if (inner) return inner;\n', ''],
    ]);
    const { pane, detail } = scrollHost(1000);
    const h = detailLayout(detail, false);
    M.keepScroll(null, () => { h.b4 += 120; });
    expect(pane.scrollTop).toBe(1120);
  });

  test('MUTANT: without the keyed search the desktop grid is the anchor and nothing is corrected', () => {
    const M = mutant('return best || shownChild(root);', 'return shownChild(root);');
    const { pane, detail } = scrollHost(1000);
    const h = detailLayout(detail, true);
    M.keepScroll(null, () => { h.b2 += 120; });
    expect(pane.scrollTop).toBe(1000);
  });

  test('MUTANT: subtracting the delta scrolls the wrong way', () => {
    const M = mutant('scroller.scrollTop += delta;', 'scroller.scrollTop -= delta;');
    const { pane, detail } = scrollHost(300);
    detail.innerHTML = '<div class="p86-wo-sub" data-task="t1"></div>';
    const card = detail.firstElementChild;
    let top = 100;
    rect(card, () => top);
    M.keepScroll(card, () => { top = 220; }, detail);
    expect(pane.scrollTop).not.toBe(420);
    expect(pane.scrollTop).toBe(180);
  });
});

describe('stylesheet', () => {
  test('a hidden save note stays hidden even though the note sets its own display', () => {
    const css = fs.readFileSync(path.join(ROOT, 'css', 'service-ticket-editor.css'), 'utf8');
    expect(css).toMatch(/\.p86-st-dirty\s*\{[^}]*display:\s*inline-block/);
    expect(css).toMatch(/\.p86-st-savearea \[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  });

  test('the initials regex spells its ranges as escapes', () => {
    const line = SRC.split('\n').find((l) => l.indexOf('var LETTER =') >= 0);
    expect(line).toBeDefined();
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
  });
});

describe('draftNoteHTML', () => {
  test('names the restored fields and offers to discard them', () => {
    document.body.innerHTML = E.draftNoteHTML(['scope_proposed', 'city']);
    const note = document.querySelector('.p86-st-draftnote');
    expect(note.textContent).toBe('Your unsaved changes to Scope and Address are back in the boxes. Discard them');
    expect(note.querySelector('button').textContent).toBe('Discard them');
  });
});
