'use strict';

/* MONEY DECISIONS NOBODY WAS TOLD ABOUT.
 *
 * Project 86 already recorded every one of these and told nobody: a proposal
 * recorded approved or declined, a purchase order approved or finished, a
 * vendor bill waiting for somebody to approve it or decided. The columns were
 * written, the list repainted, and the person waiting on the answer found out
 * by opening the page.
 *
 * WHO HEARS IT. Two people per record, and they come off real columns — no
 * capability fan-out. A capability answers "may this ROLE do this KIND of
 * thing", never "is this person waiting on THIS row", and the capability that
 * gates these routes (ESTIMATES_EDIT) is held by the field-crew role, so
 * addressing a payable to its holders would mail the crew about money.
 *
 *   proposal  the lead's salesperson, else the estimate's owner
 *   PO        the job's PM (jobs.owner_id) + the PO's creator (owner_id)
 *   bill      the job's PM + whoever entered the bill (owner_id)
 *
 * minus the ACTOR, always. Nobody wants a notice about their own click, and
 * under a system-admin act-as session the actor recorded on the row is the real
 * admin, so the caller passes the id it actually stamped.
 *
 * ━━ THE RULE THAT MATTERS MOST: CALL THESE FROM THE ROUTE HANDLER ONLY ━━
 *
 * The Buildertrend sync writes these same tables — it moves a PO to
 * work_complete, it can mint one born there, it marks bills paid, and it
 * refreshes Buildertrend's own proposal word (which includes Approved and
 * Declined) into data.btStatus on EVERY apply and every link. It does all of
 * that through its own SQL on its own transactional client
 * (services/clickr/sync-apply.js), never through Express.
 *
 * So a notice keyed on the ROUTE is unreachable from the sync, and a notice
 * keyed on anything else is a disaster: hang one off a status column, off
 * data.btStatus, off updated_at, off a database trigger, or off a helper the
 * sync shares — grantSubAccessForPO is exactly such a helper — and the first
 * "Run sync now" mails hundreds of notices in one run. There is no actor to
 * test instead: an unattended run has none at all (auto-sync.js passes
 * `user: null`). The route boundary is the discriminator. Keep it.
 *
 * BEST-EFFORT, OFF THE RESPONSE PATH. None of these routes opens a
 * transaction, so by the time a handler calls one of these the row is already
 * committed. Callers hand the promise to services/inflight.js track() so a
 * deploy lets it finish, and nothing here throws: an email provider having a
 * bad minute must not turn a saved approval into a 500.
 *
 * WORDING IS A FACTUAL CLAIM. Three traps, all real:
 *   · The CLIENT never approves a proposal in Project 86. Both routes require a
 *     logged-in ESTIMATES_EDIT user and approved_by is free TEXT typed into an
 *     "Approved by (client name)" box, so the message says "<estimator>
 *     recorded that <name> approved" and never "the client approved".
 *   · A PO reaching 'approved' through the hub's BULK setter carries no
 *     signature — setStatus sends no acceptance — so the message names a
 *     signature only when data.acceptance is actually there.
 *   · A bill has no 'rejected' status. Rejection is 'void', and 'void' is also
 *     how a duplicate or mis-keyed invoice is discarded, so the message says
 *     the bill was voided and does not assert why.
 */

const delivery = require('./notice-delivery');
const text = require('./notice-text');

const KEYS = Object.freeze({
  estimateDecided: 'estimate_decided',
  poStatus: 'po_status',
  billApproval: 'bill_approval',
  billDecided: 'bill_decided',
});

// The hub's bulk status setter fires one request per selected row in parallel
// (js/jobs-hub.js), so forty POs is forty notices. Past this many in one
// process-minute the notices stop and say so in the log rather than mailing a
// page of near-identical messages. Same shape as SEND_BACK_CAP next door.
const BURST_CAP = 12;
const BURST_WINDOW_MS = 60000;
const _burst = new Map();   // key -> [timestamps]

function burstAllowed(key, now) {
  const t = Number(now) || Date.now();
  const seen = (_burst.get(key) || []).filter((x) => t - x < BURST_WINDOW_MS);
  seen.push(t);
  _burst.set(key, seen);
  return seen.length <= BURST_CAP;
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function appLink(path) {
  return text.appUrl() + path;
}

/* The recipients, as users rows, already filtered to this organization and to
 * people who can still be reached on at least one channel. Ids are read in the
 * order given and de-duplicated; the actor is dropped. */
async function recipients(db, orgId, ids, actorId, key) {
  const want = [];
  const seen = new Set();
  const skip = positiveInt(actorId);
  for (const raw of ids || []) {
    const id = positiveInt(raw);
    if (!id || id === skip || seen.has(id)) continue;
    seen.add(id);
    want.push(id);
  }
  if (!want.length) return [];
  const r = await db.query(
    'SELECT id, name, email, role, notification_prefs FROM users'
    + ' WHERE id = ANY($1::int[]) AND organization_id = $2 AND active = TRUE',
    [want, orgId]
  );
  // ANY() does not preserve order, and the first recipient is the one the log
  // names, so put them back in the order the caller asked for.
  const byId = new Map(r.rows.map((u) => [Number(u.id), u]));
  return want.map((id) => byId.get(id)).filter(Boolean).filter((u) => delivery.reachable(u, key));
}

async function sendAll(db, orgId, users, key, message, opts) {
  const d = delivery.resolveDeps((opts || {}).deps);
  const senderOrg = await delivery.senderOrgFor(db, orgId);
  let sent = 0;
  for (const u of users) {
    const reached = await delivery.deliver(d, u, key, message, {
      orgId: orgId, senderOrg: senderOrg, replyTo: (opts || {}).replyTo,
    });
    if (reached) sent++;
  }
  return { sent: sent };
}

// ── the proposal was recorded approved or declined ───────────────────────
//
// opts: { estimate: {id, data, owner_id, organization_id}, decision: 'approved'
//         | 'declined', actorId, actorName, approvedBy, reason, deps }
async function notifyEstimateDecided(db, opts) {
  try {
    const o = opts || {};
    const est = o.estimate;
    const decision = String(o.decision || '');
    if (!est || est.id == null) return { sent: 0, skipped: 'error' };
    if (decision !== 'approved' && decision !== 'declined') return { sent: 0, skipped: 'bad_decision' };
    const orgId = est.organization_id;
    if (orgId == null) return { sent: 0, skipped: 'no_org' };
    if (!burstAllowed('estimate', o.now)) return { sent: 0, skipped: 'burst' };

    const data = (est.data && typeof est.data === 'object') ? est.data : {};
    const title = text.oneLine(data.title, 160) || 'Estimate ' + est.id;

    // THE LEAD LINK IS A JSONB STRING, not a column, and it can outlive the
    // lead it names — so the join is org-predicated and a miss falls through
    // to the estimate's own owner rather than to nobody.
    const ids = [];
    const leadId = data.lead_id == null ? '' : String(data.lead_id);
    if (leadId) {
      const lr = await db.query(
        'SELECT l.salesperson_id FROM leads l WHERE l.id = $1 AND (l.organization_id = $2 OR l.organization_id IS NULL)',
        [leadId, orgId]
      );
      if (lr.rows.length) ids.push(lr.rows[0].salesperson_id);
    }
    ids.push(est.owner_id);

    const key = KEYS.estimateDecided;
    const to = await recipients(db, orgId, ids, o.actorId, key);
    if (!to.length) return { sent: 0, skipped: 'nobody' };

    const who = text.oneLine(o.actorName, 80) || 'A teammate';
    const client = text.oneLine(o.approvedBy, 120);
    const reason = text.oneLine(o.reason, 300);
    const link = appLink('/estimates?open=' + encodeURIComponent(est.id));
    const approved = decision === 'approved';

    const rows = [
      ['Proposal', title],
      [approved ? 'Approved by' : 'Declined by', client],
      ['Recorded by', who],
      ['Reason', approved ? '' : reason],
    ];
    const headline = approved ? 'A proposal was recorded as approved' : 'A proposal was recorded as declined';
    // "recorded that" and not "the client approved": a staff member typed this,
    // and the name in the box is free text.
    const sentence = who + ' recorded that ' + (client || 'the client')
      + (approved ? ' approved ' : ' declined ') + '"' + title + '".';
    const footer = text.footerSentence(approved
      ? "You're receiving this because you sell this work."
      : "You're receiving this because you sell this work.");

    const message = {
      subject: (approved ? 'Approved: ' : 'Declined: ') + title,
      html: text.emailShell({
        heading: headline,
        bodyHtml: '<p>Hi ' + text.escHtml(text.greetingName(to[0])) + ',</p>'
          + '<p>' + text.escHtml(sentence) + '</p>' + text.rowsHtml(rows),
        button: { label: 'Open the estimate', href: link },
        footerHtml: footer.html,
      }),
      text: 'Hi ' + text.greetingName(to[0]) + ',\n\n' + sentence + '\n'
        + (text.rowsText(rows) ? '\n' + text.rowsText(rows) + '\n' : '')
        + '\nOpen the estimate: ' + link + '\n\n' + footer.text,
      push: {
        title: approved ? '✅ Proposal approved' : '✖ Proposal declined',
        body: text.pushBody(client, title, 'recorded by ' + who + '.'),
        url: link,
        tag: key + ':' + est.id,
      },
    };
    return await sendAll(db, orgId, to, key, message, { deps: o.deps, replyTo: o.replyTo });
  } catch (e) {
    console.warn('[money-notices] estimate decision notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

// ── a purchase order was approved, or its work finished ──────────────────
//
// opts: { po: {id, job_id, owner_id, po_number, data}, orgId, from, to (status),
//         actorId, actorName, job: {owner_id, data}, subName, deps }
async function notifyPoStatus(db, opts) {
  try {
    const o = opts || {};
    const po = o.po;
    const next = String(o.to || '');
    if (!po || po.id == null) return { sent: 0, skipped: 'error' };
    if (next !== 'approved' && next !== 'work_complete') return { sent: 0, skipped: 'not_notable' };
    const orgId = o.orgId;
    if (orgId == null) return { sent: 0, skipped: 'no_org' };
    if (!burstAllowed('po', o.now)) return { sent: 0, skipped: 'burst' };

    const job = o.job || {};
    const jobData = (job.data && typeof job.data === 'object') ? job.data : {};
    const key = KEYS.poStatus;
    const to = await recipients(db, orgId, [job.owner_id, po.owner_id], o.actorId, key);
    if (!to.length) return { sent: 0, skipped: 'nobody' };

    const data = (po.data && typeof po.data === 'object') ? po.data : {};
    const number = text.oneLine(po.po_number, 40) || po.id;
    const label = 'PO ' + number;
    const jobLine = text.jobLineOf
      ? text.oneLine([jobData.jobNumber, jobData.title || jobData.name].filter(Boolean).join(' · '), 200)
      : '';
    const sub = text.oneLine(o.subName || data.vendorName, 120);
    const who = text.oneLine(o.actorName, 80) || 'A teammate';
    const link = appLink('/jobs/' + encodeURIComponent(po.job_id) + '/job-purchase-orders?po=' + encodeURIComponent(po.id));

    // A signature is named only when one is actually on the row: the hub's
    // bulk setter reaches 'approved' with no acceptance at all.
    const acc = (data.acceptance && typeof data.acceptance === 'object') ? data.acceptance : null;
    const signed = acc && acc.accepted === true ? text.oneLine(acc.name, 120) : '';
    const approved = next === 'approved';

    const rows = [
      ['Job', jobLine],
      ['Sub', sub],
      ['Title', text.oneLine(data.title, 160)],
      ['Total', money(data.total != null ? data.total : data.amount)],
      ['Signed by', signed],
      ['Moved by', who],
    ];
    const sentence = approved
      ? who + ' approved ' + label + (signed ? ', signed by ' + signed : '') + '.'
      : who + ' marked the work on ' + label + ' complete.';
    const footer = text.footerSentence("You're receiving this because you run this job or raised this purchase order.");

    const message = {
      subject: (approved ? 'Approved: ' : 'Work complete: ') + label + (jobLine ? ' — ' + jobLine : ''),
      html: text.emailShell({
        heading: approved ? 'A purchase order was approved' : 'Work on a purchase order is complete',
        bodyHtml: '<p>Hi ' + text.escHtml(text.greetingName(to[0])) + ',</p>'
          + '<p>' + text.escHtml(sentence) + '</p>' + text.rowsHtml(rows),
        button: { label: 'Open the purchase order', href: link },
        footerHtml: footer.html,
      }),
      text: 'Hi ' + text.greetingName(to[0]) + ',\n\n' + sentence + '\n'
        + (text.rowsText(rows) ? '\n' + text.rowsText(rows) + '\n' : '')
        + '\nOpen the purchase order: ' + link + '\n\n' + footer.text,
      push: {
        title: approved ? '🧾 Purchase order approved' : '🛠 PO work complete',
        body: text.pushBody(jobLine, label, approved ? 'approved by ' + who + '.' : 'finished, per ' + who + '.'),
        url: link,
        tag: key + ':' + po.id,
      },
    };
    return await sendAll(db, orgId, to, key, message, { deps: o.deps, replyTo: o.replyTo });
  } catch (e) {
    console.warn('[money-notices] purchase-order notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

/* ── a vendor bill is waiting for approval ────────────────────────────────
 *
 * CLAIMED ONCE PER WAIT, not once per write. A bill can go open → approved →
 * open again, and bill-routes.js re-enters 'open' from approved, paid and void,
 * so without a claim the same bill asks to be approved on every round trip.
 * job_vendor_bills.approval_notified_at is the claim and the UPDATE is the
 * lock: `WHERE approval_notified_at IS NULL` means two concurrent writers
 * cannot both send, exactly as service_tickets.approval_notified_at does for a
 * work order. Every transition back to 'open' clears it (the route does that),
 * so the next genuine wait notices again.
 *
 * opts: { bill, orgId, job, actorId, actorName, deps }
 */
async function notifyBillAwaitingApproval(db, opts) {
  try {
    const o = opts || {};
    const bill = o.bill;
    if (!bill || bill.id == null) return { sent: 0, skipped: 'error' };
    const orgId = o.orgId;
    if (orgId == null) return { sent: 0, skipped: 'no_org' };
    if (!burstAllowed('bill', o.now)) return { sent: 0, skipped: 'burst' };

    // The org term is ON THE STATEMENT, not inherited from the caller's read.
    // test/org-write-predicate-invariant.test.js refuses an unpredicated write
    // to the money spine, and it is right to: the id reaches here as an
    // argument, and a future caller that had not scoped its own read would
    // make this the hole. The job's organization is the anchor a bill carries
    // (job_vendor_bills.organization_id is nullable), so the predicate goes
    // through the job, with the NULL tolerance every read here has.
    const claim = await db.query(
      'UPDATE job_vendor_bills b SET approval_notified_at = NOW()'
      + ' FROM jobs j WHERE b.id = $1 AND b.job_id = j.id AND b.status = $2'
      + ' AND b.approval_notified_at IS NULL'
      + ' AND (j.organization_id = $3 OR j.organization_id IS NULL)',
      [bill.id, 'open', orgId]
    );
    if (!claim.rowCount) return { sent: 0, skipped: 'already_claimed' };

    const key = KEYS.billApproval;
    const job = o.job || {};
    const to = await recipients(db, orgId, [job.owner_id, bill.owner_id], o.actorId, key);
    if (!to.length) return { sent: 0, skipped: 'nobody' };

    const message = billMessage(key, bill, job, o, {
      heading: 'A vendor bill is waiting for approval',
      pushTitle: '💵 Bill to approve',
      sentence: (text.oneLine(o.actorName, 80) || 'A teammate') + ' entered a bill that needs approving.',
      footer: "You're receiving this because you run this job or entered this bill.",
    });
    return await sendAll(db, orgId, to, key, message, { deps: o.deps, replyTo: o.replyTo });
  } catch (e) {
    console.warn('[money-notices] bill approval notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

// ── a vendor bill was approved, paid or voided ───────────────────────────
//
// opts: { bill, orgId, job, to (status), actorId, actorName, deps }
async function notifyBillDecided(db, opts) {
  try {
    const o = opts || {};
    const bill = o.bill;
    const next = String(o.to || '');
    if (!bill || bill.id == null) return { sent: 0, skipped: 'error' };
    if (next !== 'approved' && next !== 'void') return { sent: 0, skipped: 'not_notable' };
    const orgId = o.orgId;
    if (orgId == null) return { sent: 0, skipped: 'no_org' };
    if (!burstAllowed('bill', o.now)) return { sent: 0, skipped: 'burst' };

    const key = KEYS.billDecided;
    const job = o.job || {};
    const to = await recipients(db, orgId, [job.owner_id, bill.owner_id], o.actorId, key);
    if (!to.length) return { sent: 0, skipped: 'nobody' };

    const who = text.oneLine(o.actorName, 80) || 'A teammate';
    const approved = next === 'approved';
    const message = billMessage(key, bill, job, o, {
      heading: approved ? 'A vendor bill was approved' : 'A vendor bill was voided',
      pushTitle: approved ? '✅ Bill approved' : '✖ Bill voided',
      // 'void' is how a rejection AND a duplicate are both discarded, so this
      // says what happened and does not guess why.
      sentence: approved ? who + ' approved this bill for payment.' : who + ' voided this bill.',
      footer: "You're receiving this because you run this job or entered this bill.",
    });
    return await sendAll(db, orgId, to, key, message, { deps: o.deps, replyTo: o.replyTo });
  } catch (e) {
    console.warn('[money-notices] bill decision notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

// One body for the three bill notices — they differ by a heading, a sentence
// and a push title, and nothing else.
function billMessage(key, bill, job, o, words) {
  const jobData = (job.data && typeof job.data === 'object') ? job.data : {};
  const jobLine = text.oneLine([jobData.jobNumber, jobData.title || jobData.name].filter(Boolean).join(' · '), 200);
  const number = text.oneLine(bill.bill_number, 60) || bill.id;
  const label = 'Bill ' + number;
  const link = appLink('/jobs/' + encodeURIComponent(bill.job_id) + '/job-bills?bill=' + encodeURIComponent(bill.id));
  const rows = [
    ['Job', jobLine],
    ['Vendor', text.oneLine(o.subName, 120)],
    ['Amount', money(bill.amount)],
    ['Due', text.calendarDayLabel(bill.due_date)],
    ['Purchase order', text.oneLine(o.poNumber, 40)],
  ];
  const footer = text.footerSentence(words.footer);
  return {
    subject: words.heading.replace(/^A vendor bill /, label + ' ') + (jobLine ? ' — ' + jobLine : ''),
    html: text.emailShell({
      heading: words.heading,
      bodyHtml: '<p>' + text.escHtml(words.sentence) + '</p>' + text.rowsHtml(rows),
      button: { label: 'Open the bill', href: link },
      footerHtml: footer.html,
    }),
    text: words.sentence + '\n'
      + (text.rowsText(rows) ? '\n' + text.rowsText(rows) + '\n' : '')
      + '\nOpen the bill: ' + link + '\n\n' + footer.text,
    push: {
      title: words.pushTitle,
      body: text.pushBody(jobLine, label, money(bill.amount) || 'opened'),
      url: link,
      tag: key + ':' + bill.id,
    },
  };
}

module.exports = {
  KEYS,
  BURST_CAP,
  recipients,
  notifyEstimateDecided,
  notifyPoStatus,
  notifyBillAwaitingApproval,
  notifyBillDecided,
  _resetBurst: function () { _burst.clear(); },
};
