/* THE TASK DETAIL SCREEN, OPENED ON A BUILDING (js/tasks.js) — 1.35.
 * ═══════════════════════════════════════════════════════════════════════════
 * The owner's rule: "i dont want assignments to individual buildings like
 * that, whoever is assigned to the ticket, task or work order is evenly
 * responsible." A building on a work order's punch list is NEVER assigned to
 * a person. Responsibility sits on the RECORD — service_tickets.assignee_user_id
 * — and everyone on it is equally responsible for every building on it.
 *
 * WHY THIS SCREEN IS THE ONE THAT MATTERS. 1.33 took buildings off every task
 * list, so openDetail(id) is now the ONLY way into one: the My work view
 * (js/work-orders-board.js) and the My Day work-orders strip (js/my-day.js)
 * both call it, and it is how the person a work order is assigned to reaches
 * a building to tick it off — often on a job they cannot open at all. So this
 * screen has to do two things at once:
 *
 *   1. SAY THE RULE INSTEAD OF BREAKING IT. No per-building owner line, no
 *      per-building picker — one short line naming the work order's Assigned
 *      to as the responsible one, in the SERVER'S OWN WORDS (MSG.notAssignable
 *      in server/services/service-ticket-subtask-door.js, required here and
 *      compared byte-for-byte, so the two can never drift apart).
 *
 *   2. KEEP WORKING. assignee_user_id must be ABSENT from a building's PATCH,
 *      not null and not the old value: the server refuses any WRITE of that
 *      field on a building with 409 building_not_assignable, and the notes,
 *      photo, due date, status, pin and checklist in the same request die with
 *      it. The nastiest case is a LEGACY building still carrying an assignee
 *      the picker cannot show (inactive user, or users.list() failed and the
 *      cache fell back to []): the select read back '', which sent null, which
 *      IS a change — so an ordinary save of a legacy row wrote nothing at all.
 *
 * Controls prove the rule is about BUILDINGS and nothing else: an ordinary
 * task keeps its owner line, its picker and its assignee_user_id, and so does
 * a personal to-do that happens to hang off a ticket. The mutants at the end
 * break one guard in a copy of the source and show the same drive fail.
 *
 * test/work-order-task-doors.test.js drives the real PATCH route this screen
 * saves through, including the payload captured here.
 */
'use strict';

// JSDOM’s first boot in a cold worker is slow; every test here mounts one.
jest.setTimeout(30000);

const fs = require('fs');
const path = require('path');

const TASKS_JS = path.join(__dirname, '..', 'js', 'tasks.js');
const SRC = fs.readFileSync(TASKS_JS, 'utf8');
const { MSG } = require('../server/services/service-ticket-subtask-door');

const settle = () => new Promise((r) => setTimeout(r, 30));

// The sentence, said once here, so a reader of this file sees what is pinned.
const RULE = 'A building on a work order is never assigned to one person. ' +
  "Set the work order's Assigned to instead — everyone on it is equally responsible for every building on its punch list.";
const RESPONSIBLE = "The work order's Assigned to is responsible";

function mutate(src, from, to) {
  const s = src.replace(/\r\n/g, '\n');
  if (s.split(from).length !== 2) throw new Error('anchor not found: ' + JSON.stringify(from.slice(0, 60)));
  const out = s.split(from).join(to);
  if (out === s) throw new Error('MUTATION CHANGED NO BYTES');
  return out;
}

// A building: an ORG task carrying a work order's id. This one is the legacy
// shape — it still names Carl from before 1.35, which nothing may show.
function building(over) {
  return Object.assign({
    id: 'k1',
    title: 'Bldg 1 — Side A',
    notes: 'Gate is on the north side.',
    status: 'open',
    priority: 'normal',
    kind: 'punch',
    scope: 'org',
    service_ticket_id: 'st_ip',
    assignee_user_id: 20,
    assignee_name: 'Carl Crew',
    entity_type: 'job',
    entity_id: 'j1',
    linked_label: '[RV2001] Waterside 1',
    due_date: '2026-09-22',
    checklist: [{ text: 'Rehang the gate', done: false }],
    directions: 'Park by the dumpster',
    created_at: '2026-09-01T10:00:00Z',
  }, over || {});
}

// The same row with no work order on it: an ordinary assignable task.
const plain = (over) => building(Object.assign({ id: 'plain', title: 'Order the latch', service_ticket_id: null, kind: 'todo' }, over || {}));

const USERS = [{ id: 10, name: 'Wendy Wide' }, { id: 20, name: 'Carl Crew' }];

function boot(o) {
  o = o || {};
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="host"></div><div id="my-tasks"></div></body>',
    { runScripts: 'outside-only', url: 'https://project86.test/' });
  const w = dom.window;
  const saves = [];
  const gets = [];
  const toasts = [];
  w.p86Toast = function (m, k) { toasts.push([m, k]); };
  w.p86Toast.show = w.p86Toast;
  w.p86Api = {
    isAuthenticated: () => true,
    users: { list: async () => ({ users: o.users === undefined ? USERS : o.users }) },
    attachments: { list: async () => ({ attachments: [] }), upload: async () => ({}) },
    tasks: {
      list: async () => ({ tasks: o.listTasks || [] }),
      get: async (id) => { gets.push(id); return { task: o.task || building() }; },
      update: async (id, payload) => { saves.push({ id, payload }); return { task: {} }; },
      remove: async () => ({}),
    },
  };
  w.eval(o.src || SRC);
  return { w, saves, gets, toasts, host: w.document.getElementById('host') };
}

async function open(o) {
  const ctx = boot(o);
  const id = ((o && o.task) || building()).id;
  ctx.w.p86Tasks.openDetail(id);
  await settle();
  const modal = ctx.w.document.getElementById('p86TaskDetailModal');
  if (!modal) throw new Error('the detail modal did not render');
  const q = (sel) => modal.querySelector(sel);
  return Object.assign(ctx, {
    modal,
    q,
    view: q('#tdView'),
    edit: q('#tdEdit'),
    // Click Edit the way a person does, then save.
    startEdit() { q('#tdEditBtn').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true })); },
    save() { q('#tdSave').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true })); },
  });
}

const flat = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE READ-ONLY VIEW — no owner, one line that says who is responsible
 * ══════════════════════════════════════════════════════════════════════════*/
describe('openDetail on a building — the read-only view', () => {
  test('no owner line; one short line names the work order\'s Assigned to, in the server\'s words', async () => {
    const r = await open();

    const resp = r.view.querySelector('[data-building-responsible]');
    expect(resp).not.toBeNull();
    expect(flat(resp)).toBe('👥 ' + RESPONSIBLE);
    // The rule itself rides along, as the office punch list does it (title=).
    expect(resp.getAttribute('title')).toBe(RULE);

    // THE SENTENCE IS THE SERVER'S, byte for byte. If MSG.notAssignable is
    // ever reworded, this fails rather than shipping two spellings.
    expect(resp.getAttribute('title')).toBe(MSG.notAssignable);

    // Nothing on the screen names a person as this building's owner — not the
    // legacy assignee the row still carries, and not "Unassigned" either,
    // which would read as "nobody has picked this up yet".
    expect(r.view.innerHTML).not.toMatch(/&#x1F464;|\u{1F464}/u);
    expect(r.view.textContent).not.toContain('Carl Crew');
    expect(r.view.textContent).not.toContain('Unassigned');
  });

  test('everything else a crew lead came for is still on the screen', async () => {
    const r = await open();
    expect(r.view.textContent).toContain('Bldg 1 — Side A');
    expect(r.view.textContent).toContain('Gate is on the north side.');       // notes
    expect(r.view.textContent).toContain('2026-09-22');                        // due date
    expect(r.view.textContent).toContain('Open');                              // status chip
    expect(r.q('#tdViewChecklist')).not.toBeNull();                            // punch items
    expect(r.q('#tdViewTake')).not.toBeNull();                                 // photos
    expect(r.q('#tdViewUpload')).not.toBeNull();
    expect(r.q('#tdViewDir').textContent).toBe('Park by the dumpster');
    expect(r.q('#tdEditBtn')).not.toBeNull();
  });

  test('it is still the way IN: one read by id, no list door, no ticket door', async () => {
    const r = await open();
    // My work and the My Day strip hand it an id and nothing else.
    expect(r.gets).toEqual(['k1']);
    // It never reaches for the ticket — the person opening this may not be
    // able to read it (the whole reason the my-buildings door exists).
    expect(r.w.p86Api.serviceTickets).toBeUndefined();
    expect(r.toasts).toEqual([]);
  });

  test('CONTROL: an ordinary task still shows its owner', async () => {
    const r = await open({ task: plain() });
    expect(r.view.querySelector('[data-building-responsible]')).toBeNull();
    expect(r.view.textContent).toContain('Carl Crew');
  });

  test('CONTROL: an unassigned ordinary task still says Unassigned', async () => {
    const r = await open({ task: plain({ assignee_user_id: null, assignee_name: null }) });
    expect(r.view.textContent).toContain('Unassigned');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. THE EDIT FORM — no picker, the rule in its place
 * ══════════════════════════════════════════════════════════════════════════*/
describe('openDetail on a building — the edit form', () => {
  test('there is no Assignee picker at all, and the rule stands where it was', async () => {
    const r = await open();
    r.startEdit();

    expect(r.q('#tdAssignee')).toBeNull();
    expect(r.modal.querySelectorAll('select#tdAssignee')).toHaveLength(0);
    expect(r.edit.textContent).not.toContain('Assignee');

    const field = r.edit.querySelector('[data-building-responsible]');
    expect(field).not.toBeNull();
    expect(flat(field.querySelector('.p86-td-resp-lbl'))).toBe('Responsible');
    expect(flat(field.querySelector('.p86-td-resp-who'))).toBe('👥 ' + RESPONSIBLE);
    // Said in full where the picker used to be — this is where somebody goes
    // looking for it, so this is where the sentence has to be readable.
    expect(flat(field.querySelector('.p86-td-resp-note'))).toBe(MSG.notAssignable);

    // The edit pane really is showing.
    expect(r.edit.style.display).toBe('');
    expect(r.view.style.display).toBe('none');
  });

  test('every other field a building can carry is still editable', async () => {
    const r = await open();
    r.startEdit();
    for (const sel of ['#tdTitle', '#tdNotes', '#tdStatus', '#tdPriority', '#tdKind', '#tdDue',
      '#tdDirections', '#tdLat', '#tdLng', '#tdChecklist', '#tdAddCl', '#tdAddPhoto', '#tdSave', '#tdDelete']) {
      expect([sel, r.q(sel) !== null]).toEqual([sel, true]);
    }
    expect(r.q('#tdTitle').value).toBe('Bldg 1 — Side A');
    expect(r.q('#tdDue').value).toBe('2026-09-22');
  });

  test('CONTROL: an ordinary task keeps the picker, selecting its own assignee', async () => {
    const r = await open({ task: plain() });
    r.startEdit();
    const sel = r.q('#tdAssignee');
    expect(sel).not.toBeNull();
    expect(sel.value).toBe('20');
    expect(r.edit.querySelector('[data-building-responsible]')).toBeNull();
  });

  test('CONTROL: a personal to-do that hangs off a work order is NOT a building', async () => {
    // tasks-routes accepts service_ticket_id on a personal row. It is a
    // private to-do, not a punch-list building, and nothing about it changed.
    const r = await open({ task: plain({ scope: 'personal', service_ticket_id: 'st_ip' }) });
    r.startEdit();
    expect(r.q('#tdAssignee')).not.toBeNull();
    expect(r.modal.querySelector('[data-building-responsible]')).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. THE SAVE — the field is ABSENT, and everything else lands
 * ══════════════════════════════════════════════════════════════════════════*/
describe('saving a building', () => {
  async function saveEdited(o) {
    const r = await open(o);
    r.startEdit();
    r.q('#tdNotes').value = 'Gate rehung, photo added.';
    r.q('#tdStatus').value = 'in_progress';
    r.q('#tdDue').value = '2026-09-25';
    r.q('#tdDirections').value = 'Park by the gate';
    r.save();
    await settle();
    return r;
  }

  test('assignee_user_id is not in the payload — absent, not null', async () => {
    const r = await saveEdited();
    expect(r.saves).toHaveLength(1);
    const { id, payload } = r.saves[0];
    expect(id).toBe('k1');
    // ABSENT. `null` would be a write of the field, which the server refuses.
    expect(Object.prototype.hasOwnProperty.call(payload, 'assignee_user_id')).toBe(false);
    expect(Object.keys(payload)).not.toContain('assignee_user_id');
    expect(JSON.stringify(payload)).not.toContain('assignee');
  });

  test('…and everything the person actually came to change is in it', async () => {
    const r = await saveEdited();
    const p = r.saves[0].payload;
    expect(p.title).toBe('Bldg 1 — Side A');
    expect(p.notes).toBe('Gate rehung, photo added.');
    expect(p.status).toBe('in_progress');
    expect(p.due_date).toBe('2026-09-25');
    expect(p.directions).toBe('Park by the gate');
    expect(p.checklist).toEqual([{ text: 'Rehang the gate', done: false }]);
    expect(r.toasts).toContainEqual(['Saved', 'success']);
    // The modal closed, so the save really did go through.
    expect(r.w.document.getElementById('p86TaskDetailModal')).toBeNull();
  });

  test('THE LEGACY ROW: an assignee the picker could never have shown is left alone', async () => {
    // users.list() failed, so the cache is []. Before the fix the select read
    // '' and the save sent null — a CHANGE — and the whole edit was refused
    // with 409 building_not_assignable and nothing was written.
    const r = await saveEdited({ users: [] });
    expect(r.saves).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(r.saves[0].payload, 'assignee_user_id')).toBe(false);
    expect(r.saves[0].payload.notes).toBe('Gate rehung, photo added.');
    // And the name is nowhere on the screen either.
    expect(r.modal.textContent).not.toContain('Carl Crew');
  });

  test('CONTROL: an ordinary task still sends its assignee, and still clears it', async () => {
    const keep = await open({ task: plain() });
    keep.startEdit();
    keep.save();
    await settle();
    expect(keep.saves[0].payload.assignee_user_id).toBe(20);

    const clear = await open({ task: plain() });
    clear.startEdit();
    clear.q('#tdAssignee').value = '';
    clear.save();
    await settle();
    expect(clear.saves[0].payload.assignee_user_id).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. NO PER-BUILDING OWNER ON A LIST ROW EITHER
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a building never shows an owner on a list row', () => {
  async function list(tasks, opts) {
    const ctx = boot({ listTasks: tasks });
    ctx.w.p86Tasks.mountList(ctx.host, {}, opts || {});
    await settle();
    return ctx;
  }

  test('the plain row: a building gets no avatar, an ordinary task still does', async () => {
    const r = await list([building(), plain()]);
    const avatars = Array.from(r.host.querySelectorAll('.p86-task-avatar'));
    expect(avatars).toHaveLength(1);
    expect(avatars[0].closest('.p86-task-item').getAttribute('data-task-id')).toBe('plain');
    // Both rows rendered — the building is on the screen, just ownerless.
    expect(r.host.querySelectorAll('.p86-task-item')).toHaveLength(2);
  });

  test('the columnar row: a building gets the dash, not a name', async () => {
    const r = await list([building()], { grouped: true });
    expect(r.host.querySelectorAll('.p86-task-avatar')).toHaveLength(0);
    expect(r.host.textContent).not.toContain('Carl Crew');
    expect(r.host.querySelector('.p86-tg-dash')).not.toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. THE PUNCH LIST TAB SAYS WHO IS RESPONSIBLE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the My Tasks Punch list tab note', () => {
  test('it says where buildings live AND who is responsible for one', async () => {
    const ctx = boot({});
    ctx.w.p86Tasks.renderMyTasksTab();
    await settle();
    const pane = ctx.w.document.getElementById('my-tasks');
    pane.querySelector('[data-tab="punch"]').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
    await settle();

    const note = pane.querySelector('.p86-punch-wo-note');
    expect(note).not.toBeNull();
    expect(flat(note)).toBe(
      'Buildings on a work order are on the work order — see Service Tickets → My work. ' +
      'No building is assigned to one person: everyone the work order is assigned to is equally ' +
      'responsible for every building on its punch list.');
    // Same rule as the refusal, not a softer one: nobody is named, the record is.
    expect(flat(note)).toContain('No building is assigned to one person');
    expect(flat(note)).toContain('equally responsible for every building');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. MUTANTS — each guard, removed, and the failure it lets through
 * ══════════════════════════════════════════════════════════════════════════*/
describe('MUTANTS', () => {
  test('an anchor that is not in the file throws', () => {
    expect(() => mutate(SRC, 'this string is nowhere', 'x')).toThrow('anchor not found');
  });

  test('without the payload guard, a building\'s save carries assignee_user_id again', async () => {
    const src = mutate(SRC,
      "      if (!_isBldg) payload.assignee_user_id = (asgEl && asgEl.value) ? Number(asgEl.value) : null;\n",
      "      payload.assignee_user_id = (asgEl && asgEl.value) ? Number(asgEl.value) : null;\n");
    const r = await open({ src });
    r.startEdit();
    r.q('#tdNotes').value = 'Gate rehung.';
    r.save();
    await settle();
    // There is no picker to read, so it sends null — which IS a write of the
    // field, so the server answers 409 building_not_assignable and the note
    // above is never written. This is the shipped 1.34 bug, exactly.
    expect(r.saves[0].payload.assignee_user_id).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(r.saves[0].payload, 'assignee_user_id')).toBe(true);
  });

  test('without the building test, the owner line and the picker come straight back', async () => {
    const src = mutate(SRC,
      '    var _isBldg = isWorkOrderBuilding(task);\n',
      '    var _isBldg = false;\n');
    const r = await open({ src });
    expect(r.view.textContent).toContain('Carl Crew');
    expect(r.view.querySelector('[data-building-responsible]')).toBeNull();
    r.startEdit();
    expect(r.q('#tdAssignee')).not.toBeNull();
    r.save();
    await settle();
    expect(r.saves[0].payload.assignee_user_id).toBe(20);
  });

  test('without the scope term, a private to-do on a work order loses its picker', async () => {
    const src = mutate(SRC,
      "    return !!t && t.scope === 'org' && t.service_ticket_id != null && t.service_ticket_id !== '';\n",
      "    return !!t && t.service_ticket_id != null && t.service_ticket_id !== '';\n");
    const task = plain({ scope: 'personal', service_ticket_id: 'st_ip' });
    const mutated = await open({ src, task });
    mutated.startEdit();
    expect(mutated.q('#tdAssignee')).toBeNull();
    // The shipped source leaves it alone.
    const shipped = await open({ task });
    shipped.startEdit();
    expect(shipped.q('#tdAssignee')).not.toBeNull();
  });

  test('without the list guard, a building on a list wears an owner\'s initials', async () => {
    const src = mutate(SRC,
      '      if (t.assignee_user_id && !isWorkOrderBuilding(t)) {\n        var nm = t.assignee_name || userName(t.assignee_user_id);\n        meta.push(',
      '      if (t.assignee_user_id) {\n        var nm = t.assignee_name || userName(t.assignee_user_id);\n        meta.push(');
    const ctx = boot({ src, listTasks: [building()] });
    ctx.w.p86Tasks.mountList(ctx.host, {}, {});
    await settle();
    expect(ctx.host.querySelectorAll('.p86-task-avatar')).toHaveLength(1);
    expect(ctx.host.querySelector('.p86-task-avatar').getAttribute('title')).toBe('Carl Crew');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. THE SOURCE ITSELF — one sentence, and no picker left anywhere
 * ══════════════════════════════════════════════════════════════════════════*/
describe('js/tasks.js as shipped', () => {
  test('it is CRLF on disk, so the mutants\' normalisation is load-bearing', () => {
    expect(SRC.indexOf('\r\n')).toBeGreaterThan(-1);
  });

  test('the file carries the server\'s sentence verbatim and builds only one picker', () => {
    expect(SRC.replace(/\r\n/g, '\n')).toContain(MSG.notAssignable.split(' — ')[1]);
    // assigneeSelectHTML is built in exactly two places: quick-add (which can
    // never create a building — it sends no service_ticket_id) and the task
    // editor, where it is now behind the building test.
    expect(SRC.split('assigneeSelectHTML(').length - 1).toBe(3); // 1 definition + 2 uses
  });
});
