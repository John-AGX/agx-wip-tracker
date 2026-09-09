/**
 * test/estimate-lead-link.test.js — the estimate's LEAD control.
 *
 * A lead is the top of the opportunity chain: it carries the pipeline, the map
 * pin and the delete cascade. An estimate with no lead is outside all of it,
 * and until now there was no human way back — the New Estimate modal only sets
 * lead_id when it is launched FROM a lead, and the only other writer was an
 * agent tool.
 *
 * The rule this file exists to pin: ONCE AN ESTIMATE IS SOLD, ITS LEAD IS
 * FIXED. est.lead_id is not a label — it is the INPUT to conversion, so
 * re-pointing a sold estimate lets a second lead be marked Won against the same
 * job, and detaching one strands it with no parent the moment its job is
 * deleted. Both are silent.
 *
 * "Sold" is deliberately tested two different ways, because the two questions
 * are different:
 *   attach/change → job_id (is it a job's cost source right now?)
 *   detach        → job_id OR status sold/accepted (was it EVER sold?), because
 *                   deleting a job clears job_id and sets status 'accepted'
 *                   while leaving lead_id in place.
 */
'use strict';

const H = require('./helpers/estimate-editor-harness');

const EST_ID = 'est_open';

function boot(estOverrides, leads) {
  const h = H.boot();
  const w = h.w;
  w.appData.leads = leads || [
    { id: 'lead_A', title: 'Sabal Palms Ph 2', property_name: 'Sabal Palms', city: 'Clearwater', status: 'new' },
    { id: 'lead_B', title: 'Harbour Oaks Roof', property_name: 'Harbour Oaks', city: 'Largo', status: 'in_progress' },
    { id: 'lead_CONV', title: 'Already Won', property_name: 'Bayview', city: 'Tampa', status: 'sold', job_id: 'job_9' },
  ];
  w.p86Leads = {
    getCached: () => w.appData.leads.slice(),
    cacheLead: (l) => { w.__cached = (w.__cached || []).concat([l]); },
  };
  w.p86Auth = { hasCapability: () => true };
  w.p86Toast = () => {};
  w.p86Alert = (o) => { w.__alerted = (w.__alerted || []).concat([o]); };
  w.p86SaveState = () => ({ writable: true, loading: false });
  w.p86Clients = { getCached: () => [{ id: 'cli_1', name: 'Sunset Ridge' }], ensureLoaded: () => Promise.resolve([]) };
  w.p86Markets = { nameFor: () => 'Tampa' };
  w.p86Refresh = () => {};
  w.__created = [];
  w.p86Api = {
    leads: {
      create: (p) => { w.__created.push(p); return Promise.resolve({ ok: true, id: 'lead_NEW' }); },
      get: (id) => Promise.resolve({ lead: { id, title: 'Created Lead' } }),
    },
  };

  h.hydrate(Object.assign({
    id: EST_ID, title: 'Building 3 Roof', defaultMarkup: 0,
    client_id: 'cli_1', community: 'Sunset Ridge COA', jobType: 'Renovation',
    street_address: '400 Gulf Blvd', city: 'Clearwater', state: 'FL', zip: '33767',
    lines: [],
  }, estOverrides || {}));
  h.open(EST_ID);
  return h;
}

const est = (h) => h.w.appData.estimates.find((e) => e.id === EST_ID);
const detailsHTML = (h) => h.w.document.getElementById('ee-details-form').innerHTML;

// Pick a lead through the real picker by clicking its row.
function pickLead(h, title) {
  const w = h.w;
  const modal = w.document.getElementById('eeLeadPicker');
  if (!modal) throw new Error('picker did not open');
  const rows = Array.from(modal.querySelectorAll('.p86-link-picker-row'));
  const row = rows.find((r) => r.textContent.indexOf(title) >= 0);
  if (!row) throw new Error('lead not in picker: ' + title + ' — saw ' + rows.map((r) => r.textContent).join(' | '));
  row.dispatchEvent(new w.Event('click', { bubbles: true }));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => H.closeAll());

describe('the Lead row reflects the estimate state', () => {
  test('unattached draft offers Attach and Create', () => {
    const h = boot();
    const html = detailsHTML(h);
    expect(html).toMatch(/Not attached to a lead/);
    expect(html).toMatch(/eeAttachLead\(\)/);
    expect(html).toMatch(/eeCreateLeadFromEstimate\(\)/);
  });

  test('attached draft offers Change and Detach, and names the lead — never the raw id', () => {
    const h = boot({ lead_id: 'lead_A' });
    const html = detailsHTML(h);
    expect(html).toMatch(/Sabal Palms Ph 2/);
    expect(html).toMatch(/eeChangeLead\(\)/);
    expect(html).toMatch(/eeDetachLead\(\)/);
    expect(html).not.toMatch(/eeCreateLeadFromEstimate\(\)/);
  });

  test('a SOLD estimate offers nothing — the lead is read-only', () => {
    const h = boot({ lead_id: 'lead_A', job_id: 'job_1', status: 'sold' });
    const html = detailsHTML(h);
    expect(html).toMatch(/Sold — the lead is fixed/);
    expect(html).not.toMatch(/eeAttachLead\(\)/);
    expect(html).not.toMatch(/eeChangeLead\(\)/);
    expect(html).not.toMatch(/eeDetachLead\(\)/);
  });

  test('without ESTIMATES_EDIT the state shows but no verbs are painted', () => {
    const h = H.boot();
    h.w.p86Auth = { hasCapability: (c) => c !== 'ESTIMATES_EDIT' };
    h.w.appData.leads = [];
    h.w.p86Leads = { getCached: () => [], cacheLead: () => {} };
    h.hydrate({ id: EST_ID, title: 'T', defaultMarkup: 0, lines: [] });
    h.open(EST_ID);
    const html = detailsHTML(h);
    expect(html).toMatch(/Not attached to a lead/);
    expect(html).not.toMatch(/eeAttachLead\(\)/);
  });

  test('without LEADS_EDIT the Create button is not painted', () => {
    const h = H.boot();
    h.w.p86Auth = { hasCapability: (c) => c !== 'LEADS_EDIT' };
    h.w.appData.leads = [];
    h.w.p86Leads = { getCached: () => [], cacheLead: () => {} };
    h.hydrate({ id: EST_ID, title: 'T', defaultMarkup: 0, lines: [] });
    h.open(EST_ID);
    const html = detailsHTML(h);
    expect(html).toMatch(/eeAttachLead\(\)/);
    expect(html).not.toMatch(/eeCreateLeadFromEstimate\(\)/);
  });
});

describe('attach', () => {
  test('writes lead_id and actually persists it', async () => {
    const h = boot();
    const before = h.saves();
    const p = h.w.eeAttachLead();
    await tick();
    pickLead(h, 'Harbour Oaks Roof');
    await p;
    expect(est(h).lead_id).toBe('lead_B');
    // eeMutate routes through debouncedSave (400ms). A write that never
    // reaches saveData is the whole failure class here, so wait for it.
    await new Promise((r) => setTimeout(r, 500));
    expect(h.saves()).toBeGreaterThan(before);
  });

  test('cancelling the picker writes nothing', async () => {
    const h = boot();
    const p = h.w.eeAttachLead();
    await tick();
    h.w.document.getElementById('eeLeadPicker').querySelector('[data-close]')
      .dispatchEvent(new h.w.Event('click', { bubbles: true }));
    await p;
    expect(est(h).lead_id).toBeUndefined();
  });

  test('declining the confirm writes nothing', async () => {
    const h = boot();
    h.w.__confirm = false;
    const p = h.w.eeAttachLead();
    await tick();
    pickLead(h, 'Harbour Oaks Roof');
    await p;
    expect(est(h).lead_id).toBeUndefined();
  });

  test('an estimate SOLD while the picker was open is not attached', async () => {
    // The picker is a DOM overlay and does not block JavaScript. A convert can
    // land underneath it.
    const h = boot();
    const p = h.w.eeAttachLead();
    await tick();
    est(h).job_id = 'job_LANDED';        // converted mid-flight
    pickLead(h, 'Harbour Oaks Roof');
    await p;
    expect(est(h).lead_id).toBeUndefined();
  });

  test('refuses outright on a SOLD estimate', async () => {
    const h = boot({ job_id: 'job_1' });
    await h.w.eeAttachLead();
    expect(est(h).lead_id).toBeUndefined();
  });

  test('the already-converted target lead is flagged in the picker', async () => {
    const h = boot();
    const p = h.w.eeAttachLead();
    await tick();
    const modal = h.w.document.getElementById('eeLeadPicker');
    const row = Array.from(modal.querySelectorAll('.p86-link-picker-row'))
      .find((r) => r.textContent.indexOf('Already Won') >= 0);
    expect(row.textContent).toMatch(/converted/);
    modal.querySelector('[data-close]').dispatchEvent(new h.w.Event('click', { bubbles: true }));
    await p;
  });

  test('the picker never offers the lead already attached', async () => {
    const h = boot({ lead_id: 'lead_A' });
    const p = h.w.eeChangeLead();
    await tick();
    const modal = h.w.document.getElementById('eeLeadPicker');
    expect(modal.innerHTML).not.toMatch(/Sabal Palms Ph 2/);
    modal.querySelector('[data-close]').dispatchEvent(new h.w.Event('click', { bubbles: true }));
    await p;
  });
});

describe('detach', () => {
  test('clears lead_id on a clean draft', async () => {
    const h = boot({ lead_id: 'lead_A' });
    await h.w.eeDetachLead();
    expect(est(h).lead_id).toBeUndefined();
  });

  test('REFUSES on an estimate that was sold but whose job was deleted', async () => {
    // job delete scrubs job_id and sets status 'accepted' while leaving lead_id.
    // Gating on job_id alone would let a won estimate lose its last parent.
    const h = boot({ lead_id: 'lead_A', status: 'accepted' });
    await h.w.eeDetachLead();
    expect(est(h).lead_id).toBe('lead_A');
  });

  test('refuses while still sold', async () => {
    const h = boot({ lead_id: 'lead_A', job_id: 'job_1', status: 'sold' });
    await h.w.eeDetachLead();
    expect(est(h).lead_id).toBe('lead_A');
  });

  test('declining the confirm keeps the lead', async () => {
    const h = boot({ lead_id: 'lead_A' });
    h.w.__confirm = false;
    await h.w.eeDetachLead();
    expect(est(h).lead_id).toBe('lead_A');
  });
});

describe('create a lead from the estimate', () => {
  test('POSTs a mapped payload and attaches the new lead', async () => {
    const h = boot();
    h.w.__promptValue = 'Sunset Ridge — B3 Roof';
    await h.w.eeCreateLeadFromEstimate();
    expect(h.w.__created).toHaveLength(1);
    const p = h.w.__created[0];
    expect(p.title).toBe('Sunset Ridge — B3 Roof');
    expect(p.client_id).toBe('cli_1');
    expect(p.property_name).toBe('Sunset Ridge COA');
    expect(p.project_type).toBe('Renovation');
    expect(p.street_address).toBe('400 Gulf Blvd');
    expect(p.city).toBe('Clearwater');
    expect(p.zip).toBe('33767');
    // market is a NAME on a lead; the FK is unreachable from POST /api/leads.
    expect(p.market).toBe('Tampa');
    // status is NOT sent — the server defaults it, and pickEditable silently
    // DELETES an invalid one rather than erroring.
    expect('status' in p).toBe(false);
    expect(est(h).lead_id).toBe('lead_NEW');
  });

  test('trims the title and refuses an empty one', async () => {
    const h = boot();
    h.w.__promptValue = '   ';
    await h.w.eeCreateLeadFromEstimate();
    expect(h.w.__created).toHaveLength(0);
    expect(est(h).lead_id).toBeUndefined();
  });

  test('omits client_id when it does not resolve in this org', async () => {
    const h = boot({ client_id: 'cli_DELETED' });
    h.w.__promptValue = 'X';
    await h.w.eeCreateLeadFromEstimate();
    // leads.client_id is a real FK — a dangling id is a 500 carrying raw
    // Postgres text, so it must be dropped rather than sent.
    expect('client_id' in h.w.__created[0]).toBe(false);
  });

  test('sends geocode coordinates only when BOTH are present', async () => {
    const h1 = boot({ geocode_lat: 27.9 });
    h1.w.__promptValue = 'X';
    await h1.w.eeCreateLeadFromEstimate();
    expect('geocode_lat' in h1.w.__created[0]).toBe(false);

    const h2 = boot({ geocode_lat: 27.9, geocode_lng: -82.8 });
    h2.w.__promptValue = 'X';
    await h2.w.eeCreateLeadFromEstimate();
    expect(h2.w.__created[0].geocode_lat).toBe(27.9);
    expect(h2.w.__created[0].geocode_lng).toBe(-82.8);
  });

  test('refuses while the save pipeline is blocked', async () => {
    // POST /api/leads commits immediately; est.lead_id rides the debounced save
    // that queues nothing in this branch. Firing anyway leaves a real,
    // geocoded opportunity no estimate points at.
    const h = boot();
    h.w.p86SaveState = () => ({ writable: true, loading: true });
    h.w.__promptValue = 'X';
    await h.w.eeCreateLeadFromEstimate();
    expect(h.w.__created).toHaveLength(0);
  });

  test('refuses when the server load never succeeded', async () => {
    const h = boot();
    h.w.p86SaveState = () => ({ writable: false, loading: false });
    h.w.__promptValue = 'X';
    await h.w.eeCreateLeadFromEstimate();
    expect(h.w.__created).toHaveLength(0);
  });

  test('is not offered on an estimate that already has a lead', async () => {
    const h = boot({ lead_id: 'lead_A' });
    h.w.__promptValue = 'X';
    await h.w.eeCreateLeadFromEstimate();
    expect(h.w.__created).toHaveLength(0);
  });

  test('refuses on a SOLD estimate', async () => {
    const h = boot({ job_id: 'job_1' });
    h.w.__promptValue = 'X';
    await h.w.eeCreateLeadFromEstimate();
    expect(h.w.__created).toHaveLength(0);
  });

});

describe('the agent door carries the same guards', () => {
  test('refuses to re-point a SOLD estimate', () => {
    const h = boot({ lead_id: 'lead_A', job_id: 'job_1' });
    expect(() => h.w.estimateEditorAPI.applyLinkToLead({ lead_id: 'lead_B' }))
      .toThrow(/sold/i);
    expect(est(h).lead_id).toBe('lead_A');
  });

  test('refuses a lead id that does not exist in this org', () => {
    const h = boot();
    expect(() => h.w.estimateEditorAPI.applyLinkToLead({ lead_id: 'lead_FROM_ANOTHER_ORG' }))
      .toThrow(/No lead with id/);
    expect(est(h).lead_id).toBeUndefined();
  });

  test('still links a valid lead', () => {
    const h = boot();
    h.w.estimateEditorAPI.applyLinkToLead({ lead_id: 'lead_B' });
    expect(est(h).lead_id).toBe('lead_B');
  });
});
