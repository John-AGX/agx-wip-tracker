'use strict';
// ── BUILDERTREND TO-DOS → PROJECT 86 ORG TASKS ────────────────────────────
//
// Step 7 of the reconcile, and the first one with NO MONEY IN IT. Nothing here
// touches a contract, a cost, a price or a payable: a Buildertrend to-do becomes
// a Project 86 ORG TASK (tasks.scope = 'org') on the job its Buildertrend job is
// linked to, and that is the whole of it.
//
// That does not make it safe to be careless. A task is a COMMITMENT somebody
// acts on: it shows up on their My Day, it leaves the open list when it is
// finished, and a person who archived one had a reason. So what a money sync
// protects with "never applied" this one protects with "never rewritten" — see
// WHAT PROTECTS A TASK A PERSON HAS TOUCHED, below.
//
// ── THE RUNGS ─────────────────────────────────────────────────────────────
//   0. tasks.bt_task_id — the saved link;
//   1. the job PLUS the title.
// There is no third rung, and rung 1 is weaker here than a bill number is on a
// bill. THE MEASUREMENT: 578 Buildertrend tasks carry 153 DISTINCT TITLES over
// 64 jobs. The same checklist item ("Final walkthrough", "Pull permit") exists
// on job after job, so a title is not an identity — it is a label. Two
// consequences, both enforced below and both proved by test:
//   * a title NEVER matches across jobs. The rung only ever looks inside
//     byJob.get(job.id), so a P86 task on another job is not a candidate at all;
//   * even inside one job a title can repeat, and two P86 tasks that could both
//     be the row are AMBIGUOUS — listed as candidates, nothing proposed. A
//     person links one; this module never guesses between them.
//
// ── COMPLETION: isCompleted, AND NOTHING ELSE ─────────────────────────────
// Clickr sends two fields that both look like completion and DISAGREE:
// isCompleted says 88 of 578 are done; status says 544 are "Completed".
// completedAt is carried by exactly the 88 isCompleted calls done, so
// isCompleted is the per-task flag and status is measuring something else —
// almost certainly the state of the Buildertrend to-do LIST the task hangs on.
// This module therefore reads isCompleted for completion and reads status ONLY
// as a word to carry across (tasks.bt_task_status), beside the P86 status and
// never as one. Trusting status instead would mark 456 OPEN tasks finished in a
// single press. See the registry entry in field-map.js for the full figures.
//
// P86 also has 'in_progress' and 'blocked'. BUILDERTREND HAS NO WORD FOR
// EITHER, so nothing maps to them: a Buildertrend to-do is done or it is not.
// A P86 task sitting in one of those two is NOT DONE, which is what
// isCompleted: false says, so the two agree and no completion item is raised.
//
// ── THE ASSIGNEE, WHICH IS THE PART MOST LIKELY TO GO WRONG ───────────────
// assignedUsers is filled on 340 of 578 records and names 18 distinct people.
// P86's assignee_user_id is a real foreign key to users(id). A wrongly assigned
// task is worse than an unassigned one — it is a commitment put on somebody who
// does not know they have it, and it hides the real owner — so resolveAssignee
// resolves a name to a P86 user ONLY when it is unambiguous and otherwise sets
// NOBODY, saying why on the row. Every refusal is enumerated there.
//
// ── WHAT PROTECTS A TASK A PERSON HAS TOUCHED ─────────────────────────────
// Three locks, weakest to strongest:
//
//   1. A FILL IS NOT A REWRITE. Where P86 holds nothing (no notes, no due date,
//      no assignee) Buildertrend's value is an ordinary correction: it destroys
//      nothing. Where P86 holds something DIFFERENT, it is never a correction —
//      it is a held-back item a person ticks by name, so no "apply everything"
//      press and no safe sweep can reach it.
//
//   2. AN EDIT A PERSON MADE IS NOT OVERWRITTEN AT ALL. tasks.bt_synced_at is
//      stamped by every write this sync makes, in the same statement as
//      updated_at. A task whose updated_at has moved PAST its bt_synced_at is a
//      task somebody changed after the sync last wrote it, and one with
//      bt_synced_at NULL is a task the sync never wrote — a person's, from the
//      first keystroke. On either, a differing value is shown with
//      applicable: false and there is no door that applies it. personEdited()
//      fails CLOSED: a timestamp it cannot read counts as a person's.
//
//   3. DONE AND ARCHIVED ARE SETTLED. A sync never re-opens a task somebody
//      finished, never un-archives one, and writes nothing but the link onto
//      either. An archived task is still READ and still MATCHED, deliberately:
//      hiding it would make its Buildertrend twin look new and create a second
//      copy of the thing a person put away.
//
// ── WHAT IS NEVER READ AT ALL ─────────────────────────────────────────────
//   * a PERSONAL to-do (scope 'personal'). It is private to its owner, it is
//     not an org task, and this sync neither reads nor writes one.
//   * a WORK-ORDER BUILDING (a task carrying service_ticket_id). It is not a
//     to-do: it lives on its service ticket, it is finished there under the
//     photo rule, and marking one done moves the TICKET — through
//     services/service-ticket-subtask-door.js, which a write from here would
//     walk straight past. Both exclusions live in the preview's SELECT, so a
//     building can never be a candidate, a match or a write target.
//
// A P86 task is never deleted, never archived and never un-assigned by a sync.

const match = require('./bt-match');

const { isBtBlank, isP86Blank, textKey, compareField } = match;

const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim().replace(/\s+/g, ' ');

// P86's four task states. Buildertrend reaches exactly two of them (see the
// header): 'done' and 'open'. 'in_progress' and 'blocked' appear here only so a
// P86 task sitting in one PRINTS properly.
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
// Not done, in P86's vocabulary. All three are what Buildertrend's
// isCompleted: false asserts, so all three AGREE with it and none is corrected.
const NOT_DONE = new Set(['open', 'in_progress', 'blocked']);

// A P86 DATE column as a calendar day. node-pg parses type 1082 into a Date at
// LOCAL midnight, so the local Y-M-D IS the stored day; toISOString() would
// shift it a day west of UTC. Text (the test engine, and a plain string) goes
// through bt-match's dateKey, which is written-Y-M-D and never shifts. Same
// function, and for the same reason, as bill-match's dayKey.
function dayKey(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
  }
  return match.dateKey(v);
}

// A TIMESTAMPTZ as milliseconds, or NaN. A Date from node-pg and an ISO string
// from the test engine both land here; anything else is NaN, which personEdited
// reads as "cannot tell".
function tsMs(v) {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

function p86TaskView(r) {
  return {
    id: r.id,
    // A task reaches its job through the POLYMORPHIC entity_type/entity_id pair,
    // not a job_id column. The preview's SELECT pins entity_type = 'job' and
    // aliases entity_id, so this IS the job id and nothing else can be.
    jobId: r.job_id == null ? null : String(r.job_id),
    title: str(r.title),
    notes: str(r.notes),
    status: str(r.status),
    priority: str(r.priority),
    kind: str(r.kind),
    dueDate: dayKey(r.due_date),
    completedAt: r.completed_at || null,
    archived: r.archived_at != null,
    assigneeId: r.assignee_user_id == null ? null : r.assignee_user_id,
    assigneeName: str(r.assignee_name),
    btId: norm(r.bt_task_id),
    btStatus: norm(r.bt_task_status),
    btSyncedAt: r.bt_synced_at || null,
    updatedAt: r.updated_at || null,
  };
}

// HAS A PERSON CHANGED THIS TASK SINCE THE SYNC LAST WROTE IT?
//
// FAIL CLOSED. Every answer this cannot prove is "yes, a person's": a task the
// sync never wrote (bt_synced_at NULL) is a person's from the first keystroke,
// and a stamp that will not parse is not evidence of anything. Only the one
// case it can prove — the sync wrote this row and updated_at has not moved
// since — answers false.
function personEdited(v) {
  if (!v.btSyncedAt) return true;
  const synced = tsMs(v.btSyncedAt);
  if (!Number.isFinite(synced)) return true;
  const updated = tsMs(v.updatedAt);
  // The sync wrote it and nothing recorded a later edit.
  if (!Number.isFinite(updated)) return false;
  return updated > synced;
}

// ── THE ASSIGNEE ──────────────────────────────────────────────────────────
//
// Buildertrend's assignedUsers (a LIST of names) against P86's users. Exactly
// one P86 user of THIS organization, or NOBODY. Every arm that answers "nobody"
// says so in `why`, because an unassigned imported task with no explanation
// reads as a task nobody was ever meant to own.
//
// The four refusals, and why each one is a refusal rather than a guess:
//   * NAMES NOBODY — the list is empty, or every name in it is blank. Nothing
//     to resolve; no note either, because "Buildertrend assigned nobody" is not
//     a failure. (assignedUsers is empty on 238 of the 578 live records.)
//   * NAMES SEVERAL — the key is PLURAL and a P86 task has exactly ONE
//     assignee. Picking the first would hand one person a job three people
//     share, and would do it silently. Nobody is set and all the names are
//     printed, so a person can assign it in P86.
//   * MATCHES NOBODY — the name is not a P86 user (a Buildertrend-only
//     account, someone who left, a spelling P86 does not use). Never invented:
//     assignee_user_id is a real foreign key and there is no user to point it
//     at.
//   * MATCHES TWO — two active users of this organization normalize to the same
//     name (two "Mike Smith"). This is the case a guess gets wrong roughly half
//     the time and nobody ever notices, so it is the one that most needs the
//     refusal.
// Every candidate comes from a list the caller read WHERE organization_id = the
// caller's, so a user of another organisation can never be returned.
function nameKey(v) {
  return textKey(v);
}

function resolveAssignee(users, btNames) {
  const list = (Array.isArray(btNames) ? btNames : []).map(norm).filter((n) => n && !isBtBlank(n));
  if (!list.length) return { user: null, why: null, names: [] };
  if (list.length > 1) {
    return { user: null, names: list,
      why: 'Buildertrend has ' + list.length + ' people on this task (' + list.join(', ')
        + '). A P86 task has exactly one assignee, so none is set — assign it in P86.' };
  }
  const k = nameKey(list[0]);
  if (!k) return { user: null, why: null, names: list };
  const hits = (users || []).filter((u) => nameKey(u.name) === k);
  if (hits.length === 1) return { user: hits[0], why: null, names: list };
  return { user: null, names: list,
    why: hits.length
      ? 'Buildertrend assignee "' + list[0] + '" matches ' + hits.length + ' P86 users, so none is set — assign it in P86.'
      : 'Buildertrend assignee "' + list[0] + '" is not a P86 user, so the task is imported unassigned.' };
}

// Buildertrend's completion flag as a P86 status, or null for "Buildertrend did
// not say". field-map's readTask is three-state on purpose (see its comment):
// a value that is not a boolean is not a completion answer, and reading it as
// one would mark finished tasks open in silence.
function btTaskStatus(isCompleted) {
  if (isCompleted === true) return 'done';
  if (isCompleted === false) return 'open';
  return null;
}

function taskCand(v, rungs) {
  return { id: v.id, title: v.title,
    status: (STATUS_LABEL[v.status] || v.status) + (v.archived ? ' · archived' : '') + (v.assigneeName ? ' · ' + v.assigneeName : ''),
    rungs: rungs.slice() };
}

function p86Out(v) {
  return { id: v.id, title: v.title, status: STATUS_LABEL[v.status] || v.status,
    archived: v.archived, dueDate: v.dueDate, assigneeName: v.assigneeName,
    notes: v.notes ? v.notes.slice(0, 200) : '', edited: personEdited(v) };
}

// THE ONE PLACE A LOCK IS DECIDED, so the note a person reads and the refusal
// the apply enforces cannot drift apart.
function lockOf(v) {
  if (v.archived) {
    return 'A person archived this task in P86. A sync never un-archives one and writes nothing on it but the link — restore it in P86 first if Buildertrend is right.';
  }
  if (v.status === 'done') {
    return 'A person has completed this task in P86. A sync never re-opens a finished task and never rewrites one — re-open it in P86 first if Buildertrend is right.';
  }
  return null;
}

function taskProposals(bt, v, ctx) {
  const acc = { corrections: [], btBlank: [], heldBack: [], flags: [] };
  const notes = [];
  const locked = lockOf(v);
  const edited = personEdited(v);
  const p86StatusLabel = STATUS_LABEL[v.status] || v.status;
  // The sentence that explains every applicable: false on a value the person
  // could otherwise have ticked. Said once, here, so it says the same thing
  // everywhere it appears.
  const editedWhy = 'P86 already holds a different value and a person wrote it — a sync rewrites nothing somebody typed. Change it in P86 if Buildertrend is right.';

  // ── COMPLETION. isCompleted, never status. ──────────────────────────────
  const want = btTaskStatus(bt.isCompleted);
  if (want == null) {
    acc.heldBack.push({ field: 'status', label: 'Completed', reason: 'review',
      bt: '(not a yes/no)', p86: p86StatusLabel, applicable: false,
      note: 'Buildertrend sent a completion flag that is not true or false, so nothing is proposed about whether this task is done. '
        + 'Buildertrend’s own status word for it is "' + (isBtBlank(bt.statusText) ? 'blank' : norm(bt.statusText)) + '", which is NOT completion — '
        + 'it describes the Buildertrend to-do list, not the task.' });
  } else if (want === 'done' && v.status !== 'done') {
    if (locked) {
      acc.heldBack.push({ field: 'status', label: 'Completed', reason: 'locked', bt: 'Done', p86: p86StatusLabel, applicable: false, note: locked });
    } else {
      // NEVER a correction. Completing a task is an EVENT — it leaves every
      // open list, it moves off My Day, and somebody may have been about to do
      // it. It is ticked by name or it does not happen.
      acc.heldBack.push({ field: 'status', label: 'Completed', reason: 'review',
        bt: 'Done' + (ctx.completedDay(bt) ? ' on ' + ctx.completedDay(bt) : ''), p86: p86StatusLabel,
        value: 'done', p86Value: v.status, applicable: true,
        note: 'Buildertrend has this task finished. Tick it to complete it in P86'
          + (ctx.completedDay(bt) ? ', dated ' + ctx.completedDay(bt) + ' as Buildertrend recorded it' : '')
          + '. Completing a task takes it off every open list, so it is never applied by "Link confident matches".' });
    }
  } else if (want === 'open' && v.status === 'done') {
    acc.heldBack.push({ field: 'status', label: 'Completed', reason: 'locked', bt: 'Not done', p86: p86StatusLabel, applicable: false,
      note: 'A sync never re-opens a task a person finished in P86. Re-open it in P86 if Buildertrend is right.' });
  }
  // want === 'open' against open / in_progress / blocked: they AGREE (all three
  // are "not done"), so nothing is raised. See NOT_DONE at the top.

  if (locked) {
    // Everything below is content, and a settled task takes none of it. The
    // differences are still SHOWN, so the row says what Buildertrend holds.
    if (!isBtBlank(bt.title) && textKey(bt.title) !== textKey(v.title)) {
      acc.heldBack.push({ field: 'title', label: 'Title', reason: 'locked', bt: norm(bt.title), p86: v.title, applicable: false, note: locked });
    }
    if (!isBtBlank(bt.notes) && textKey(bt.notes) !== textKey(v.notes)) {
      acc.heldBack.push({ field: 'notes', label: 'Notes', reason: 'locked', bt: norm(bt.notes), p86: v.notes, applicable: false, note: locked });
    }
    const d = match.dateKey(bt.dueDate);
    if (d && d !== v.dueDate) {
      acc.heldBack.push({ field: 'dueDate', label: 'Due date', reason: 'locked', bt: d, p86: v.dueDate, applicable: false, note: locked });
    }
    return { acc, notes };
  }

  // ── TITLE — the rung-1 MATCH KEY, so it is never corrected. ─────────────
  // Offered, ticked on purpose, only where P86 holds nothing, which means "no
  // title recorded" rather than a different one. Exactly the rule bill-match
  // applies to a vendor invoice number, and for the same reason: correcting the
  // key you matched on re-points the record you matched.
  const btTitle = isBtBlank(bt.title) ? '' : norm(bt.title);
  if (btTitle && textKey(btTitle) !== textKey(v.title)) {
    if (isP86Blank(v.title)) {
      acc.heldBack.push({ field: 'title', label: 'Title', reason: 'review', bt: btTitle, p86: '', value: btTitle, p86Value: v.title, applicable: true,
        note: 'P86 has no title on this task. Tick it to take Buildertrend’s. A title is a match key, so it is offered rather than corrected.' });
    } else {
      acc.heldBack.push({ field: 'title', label: 'Title', reason: 'review', bt: btTitle, p86: v.title, applicable: false,
        note: 'P86 and Buildertrend carry different titles. A title is a MATCH KEY, never something a sync corrects — '
          + 'if they are the same task, fix the title on whichever side is wrong.' });
    }
  }

  // ── NOTES ───────────────────────────────────────────────────────────────
  // A FILL is an ordinary correction: P86 holds nothing, so nothing is
  // destroyed. A DIFFERENT value is held back — and applicable only where the
  // sync itself wrote what is there and nobody has touched it since.
  if (!isBtBlank(bt.notes)) {
    const btNotes = norm(bt.notes);
    if (isP86Blank(v.notes)) {
      compareField(acc, { field: 'notes', label: 'Notes', bt: btNotes, p86: v.notes, same: (a, b) => textKey(a) === textKey(b) });
    } else if (textKey(btNotes) !== textKey(v.notes)) {
      acc.heldBack.push({ field: 'notes', label: 'Notes', reason: 'review', bt: btNotes, p86: v.notes,
        value: btNotes, p86Value: v.notes, applicable: !edited,
        note: edited ? editedWhy
          : 'This task’s notes were last written by the sync and nobody has changed them since, so Buildertrend’s are safe to take. Tick it.' });
    }
  } else if (!isP86Blank(v.notes)) {
    acc.btBlank.push({ field: 'notes', label: 'Notes', p86: v.notes });
  }

  // ── DUE DATE ────────────────────────────────────────────────────────────
  // Same shape as notes. A blank Buildertrend due date NEVER clears a P86 one
  // (128 of 578 records carry one at all), so it lands in btBlank — shown,
  // never applied.
  const due = match.dateKey(bt.dueDate);
  if (due) {
    if (!v.dueDate) {
      compareField(acc, { field: 'dueDate', label: 'Due date', bt: due, p86: v.dueDate, same: (a, b) => dayKey(a) === dayKey(b), literal: () => true });
    } else if (due !== v.dueDate) {
      acc.heldBack.push({ field: 'dueDate', label: 'Due date', reason: 'review', bt: due, p86: v.dueDate,
        value: due, p86Value: v.dueDate, applicable: !edited,
        note: edited ? editedWhy
          : 'This task’s due date was last set by the sync and nobody has changed it since, so Buildertrend’s is safe to take. Tick it.' });
    }
  } else if (v.dueDate) {
    acc.btBlank.push({ field: 'dueDate', label: 'Due date', p86: v.dueDate });
  }

  // ── ASSIGNEE ────────────────────────────────────────────────────────────
  // A FILL only. A P86 task that already names somebody is never re-assigned by
  // a sync: moving a commitment off one person and onto another is a decision,
  // and one of them stops looking at it without being told.
  const ra = resolveAssignee(ctx.users, bt.assignedUsers);
  if (ra.why && !(v.assigneeId && ra.names.length === 1 && nameKey(v.assigneeName) === nameKey(ra.names[0]))) notes.push(ra.why);
  if (ra.user) {
    if (!v.assigneeId) {
      acc.corrections.push({ field: 'assignee', label: 'Assignee', kind: 'fill', from: '', to: ra.user.name, value: ra.user.id, p86Value: null,
        note: 'Buildertrend’s assignee is exactly one P86 user of this organisation, so the match is unambiguous. P86 has nobody on this task.' });
    } else if (String(v.assigneeId) !== String(ra.user.id)) {
      acc.heldBack.push({ field: 'assignee', label: 'Assignee', reason: 'review', bt: ra.user.name, p86: v.assigneeName || String(v.assigneeId), applicable: false,
        note: 'A sync never re-assigns a task: the person it is on now would stop seeing it without being told. Change it in P86 if Buildertrend is right.' });
    }
  }

  return { acc, notes };
}

// Buildertrend's OWN status word against what P86 last recorded beside the task
// (tasks.bt_task_status). Two sides that AGREE raise nothing at all, so without
// this a linked task could never record the word — and the word is the whole
// point of carrying it: it is what tells a person that Buildertrend calls this
// to-do list "Completed" while the task itself is open. Never a P86 status.
function btStatusDue(bt, v) {
  const word = isBtBlank(bt.statusText) ? '' : norm(bt.statusText);
  return !!word && norm(v.btStatus) !== word;
}

function row(bt, cls, extra) {
  return Object.assign({ bt, class: cls, rung: null, p86: null, corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [] }, extra || {});
}

function jobLabel(j) {
  return [j.jobNumber, j.title].filter((x) => !isP86Blank(x)).join(' ') || j.id;
}

// btValues: readTask() records. p86: { jobs, taskRows, users }.
function matchTasks(btValues, p86) {
  const jobByBt = new Map();
  for (const j of p86.jobs || []) {
    const k = norm(j.bt_job_id);
    if (k) jobByBt.set(k, { id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)) });
  }
  const ctx = {
    users: p86.users || [],
    completedDay: (b) => match.dateKey(b.completedAt),
  };

  const views = (p86.taskRows || []).map(p86TaskView);
  const byJob = new Map();
  const byBtId = new Map();
  for (const v of views) {
    if (!byJob.has(v.jobId)) byJob.set(v.jobId, []);
    byJob.get(v.jobId).push(v);
    if (v.btId) byBtId.set(v.btId, v);
  }

  const rows = btValues.map((b, index) => {
    const ra = resolveAssignee(ctx.users, b.assignedUsers);
    const bt = Object.assign({ index, scope: 'open',
      raw: isBtBlank(b.title) ? '' : norm(b.title),
      // WHAT THE ROW PRINTS ABOUT COMPLETION, and it prints BOTH: the flag that
      // decides it and the word that does not. A page that showed only
      // "Completed" would be showing the field this whole dataset is braced
      // against.
      doneText: b.isCompleted === true ? 'Done' : b.isCompleted === false ? 'Not done' : '(not a yes/no)',
      completedDay: match.dateKey(b.completedAt),
      dueDay: match.dateKey(b.dueDate),
      assigneeNames: ra.names,
      state86: btTaskStatus(b.isCompleted) }, b);
    const btId = norm(b.btId);
    if (!btId) return row(bt, 'refused', { notes: ['Buildertrend sent this task without an id.'] });
    const job = jobByBt.get(norm(b.jobId));
    if (!job) {
      return row(bt, 'refused', { waitingOnJob: true,
        notes: ['Its Buildertrend job' + (isBtBlank(b.jobName) ? '' : ' "' + norm(b.jobName) + '"') + ' is not linked to a P86 job yet. Link or create the job on the Jobs tab, then refresh.'] });
    }
    const jobInfo = { id: job.id, label: jobLabel(job) };
    const onJob = byJob.get(job.id) || [];

    const linked = byBtId.get(btId);
    if (linked) {
      if (linked.jobId !== job.id) {
        return row(bt, 'refused', { job: jobInfo,
          notes: ['The P86 task linked to this one (' + (linked.title || linked.id) + ') is on a different P86 job than Buildertrend’s job, so nothing is proposed.'] });
      }
      const { acc, notes } = taskProposals(b, linked, ctx);
      return row(bt, acc.corrections.length ? 'conflict' : 'matched',
        Object.assign({ rung: 'Buildertrend ID', job: jobInfo, notes, p86: p86Out(linked), btStatusDue: btStatusDue(b, linked) }, acc));
    }

    // RUNG 1 — THE JOB PLUS THE TITLE, and the scope of `onJob` is the whole
    // guarantee that a title never travels between jobs.
    const open = onJob.filter((v) => !v.btId);
    const key = textKey(b.title);
    const byTitle = key ? open.filter((v) => textKey(v.title) === key) : [];
    if (byTitle.length === 1) {
      const { acc, notes } = taskProposals(b, byTitle[0], ctx);
      return row(bt, acc.corrections.length ? 'conflict' : 'matched',
        Object.assign({ rung: 'Title on this job', job: jobInfo, notes, p86: p86Out(byTitle[0]), btStatusDue: btStatusDue(b, byTitle[0]) }, acc));
    }
    if (byTitle.length) {
      return row(bt, 'ambiguous', { job: jobInfo, candidates: byTitle.map((v) => taskCand(v, ['title on this job'])),
        notes: [byTitle.length + ' P86 tasks on this job carry this title, so none is matched and nothing is proposed. '
          + 'Link the right one, or tell them apart in P86 — 578 Buildertrend tasks share 153 titles, so a repeat is ordinary rather than a mistake.'] });
    }

    const out = row(bt, 'new', { job: jobInfo });
    if (isBtBlank(b.title)) {
      out.class = 'refused';
      out.notes.push('Buildertrend sent this task without a title, and a P86 task must have one, so it is not created.');
      return out;
    }
    if (ra.why) out.notes.push(ra.why);
    if (btTaskStatus(b.isCompleted) == null) {
      out.notes.push('Buildertrend’s completion flag on this task is not true or false, so it would be created OPEN. '
        + 'Its status word "' + (isBtBlank(b.statusText) ? 'blank' : norm(b.statusText)) + '" is not completion and is never read as one.');
    }
    return out;
  });

  // Two Buildertrend tasks landing on ONE P86 task: neither is matched. With
  // 153 titles over 578 records this is the ordinary shape of a repeat, not a
  // rarity, so it refuses rather than letting the second one win.
  const claims = new Map();
  for (const r of rows) {
    if ((r.class === 'matched' || r.class === 'conflict') && r.p86) {
      if (!claims.has(r.p86.id)) claims.set(r.p86.id, []);
      claims.get(r.p86.id).push(r);
    }
  }
  for (const group of claims.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      r.candidates = [taskCand(views.find((v) => v.id === r.p86.id), [r.rung])];
      r.notes.push(group.length + ' Buildertrend tasks land on this same P86 task, so none is matched and nothing is proposed.');
      r.class = 'ambiguous';
      r.rung = null;
      r.p86 = null;
      r.btStatusDue = false;
      r.corrections = []; r.btBlank = []; r.heldBack = []; r.flags = [];
    }
  }
  return rows;
}

function notInBuildertrend(rows, btValues, p86) {
  const reached = new Set();
  for (const r of rows) {
    if (r.p86) reached.add(r.p86.id);
    for (const c of r.candidates || []) reached.add(c.id);
  }
  const btJobs = new Set(btValues.map((b) => norm(b.jobId)).filter(Boolean));
  const jobs = new Map();
  for (const j of p86.jobs || []) {
    if (norm(j.bt_job_id) && btJobs.has(norm(j.bt_job_id))) {
      jobs.set(j.id, jobLabel({ id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)) }));
    }
  }
  const btIds = new Set(btValues.map((b) => norm(b.btId)).filter(Boolean));
  const listed = [];
  let notListed = 0;
  for (const v of (p86.taskRows || []).map(p86TaskView)) {
    if (reached.has(v.id)) continue;
    if (!jobs.has(v.jobId)) { notListed++; continue; }
    listed.push({ id: v.id, title: v.title,
      status: (STATUS_LABEL[v.status] || v.status) + (v.archived ? ' · archived' : '') + (v.assigneeName ? ' · ' + v.assigneeName : ''),
      jobLabel: jobs.get(v.jobId), linkedGone: v.btId && !btIds.has(v.btId) ? true : undefined });
  }
  return { rows: listed, notListed };
}

module.exports = { matchTasks, notInBuildertrend, btTaskStatus, btStatusDue, resolveAssignee,
  personEdited, p86TaskView, lockOf, dayKey, tsMs, nameKey, STATUS_LABEL, NOT_DONE };
