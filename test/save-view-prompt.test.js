/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * "Save current filters as view" did nothing in the installed app.
 *
 * Five lists (Jobs, Leads, Estimates, Subs, and the job hub's CO/PO/RFI
 * lists) asked for the view's name with the NATIVE prompt(). In the installed
 * PWA that returns undefined without showing anything; the `name == null`
 * guard read undefined as Cancel; nothing was saved and nothing was said.
 * They now ask through window.p86Prompt (js/dialogs.js), closing their
 * popover FIRST — the popover sits at z-index 100000, the dialog at 1100, so
 * an open popover would cover the name box.
 *
 * test/native-dialogs-in-the-pwa.test.js counts the native calls; this proves
 * the feature works: the real jobsOpenViews, driven end to end.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lf = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => lf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('the Jobs list, end to end', () => {
  let created, toasts, prompts, answer, nativePrompts;
  beforeAll(() => {
    const src = read('js/jobs.js');
    const i = src.indexOf('        window.jobsOpenViews = function(anchor) {');
    const j = src.indexOf('\n        };\n', i);
    expect(i).toBeGreaterThan(-1);
    window.escapeHTML = (s) => String(s == null ? '' : s);
    window._jobsViews = [];
    window._jobsActiveViewId = null;
    window._jobsDrawer = { status: ['In Progress'] };
    window.rememberJobsView = () => {};
    window.applyJobsView = () => {};
    window.p86Ask = async () => true;
    window.jobsLoadViews = () => Promise.resolve();
    window.p86Toast = (m, k) => toasts.push([k, m]);
    window.p86Prompt = (opts) => { prompts.push({ opts, popoverOpen: !!document.getElementById('jobs-views-pop') }); return Promise.resolve(answer); };
    window.prompt = () => { nativePrompts++; return 'native'; };
    window.p86Api = { listViews: { create: (body) => { created.push(body); return Promise.resolve({ view: { id: 'v1' } }); } } };
    // eslint-disable-next-line no-eval
    window.eval(src.slice(i, j + '\n        };\n'.length));
  });
  beforeEach(() => {
    created = []; toasts = []; prompts = []; nativePrompts = 0;
    document.body.innerHTML = '<button id="views-btn">Views</button>';
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const pressSave = async () => {
    window.jobsOpenViews(document.getElementById('views-btn'));
    document.getElementById('jobs-save-view').click();
    for (let k = 0; k < 5; k++) await flush();
  };

  test('asks in the app\'s own dialog — never the native one — with the popover already gone', async () => {
    answer = 'Orlando in progress';
    await pressSave();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].opts.title).toBe('Save this view');
    expect(prompts[0].popoverOpen).toBe(false);
    expect(nativePrompts).toBe(0);
  });

  test('saves the typed name with the current filters, and says so', async () => {
    answer = '  Orlando in progress  ';
    await pressSave();
    expect(created).toEqual([{ page: 'jobs', name: 'Orlando in progress', config: { filters: { status: ['In Progress'] } }, is_default: false }]);
    expect(toasts).toEqual([['success', 'View saved']]);
  });

  test('Cancel (null) and a blank name save nothing', async () => {
    for (answer of [null, '   ']) {
      await pressSave();
    }
    expect(created).toEqual([]);
  });
});

describe('every list with a Save view button asks the same way', () => {
  const FILES = ['js/jobs.js', 'js/leads.js', 'js/estimates.js', 'js/subs.js', 'js/jobs-hub.js'];

  test.each(FILES)('%s: popover closed, then p86Prompt, then the save', (file) => {
    const src = read(file);
    const ask = src.indexOf("window.p86Prompt({ title: 'Save this view'");
    expect(ask).toBeGreaterThan(-1);
    // The handler's own lines, from the comment that opens it to the save.
    const start = src.lastIndexOf("// p86Prompt, not the native prompt()", ask);
    const save = src.indexOf('window.p86Api.listViews.create(', ask);
    expect(start).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(ask);
    const block = src.slice(start, save);
    expect(block.indexOf('close();')).toBeGreaterThan(-1);
    expect(block.indexOf('close();')).toBeLessThan(block.indexOf('window.p86Prompt('));
    // The native prompt survives only as the fallback when dialogs.js is absent.
    expect(block).toContain("typeof window.p86Prompt === 'function'");
    expect(src).not.toMatch(/var name = prompt\('Name this view:'\)/);
  });

  test('js/dialogs.js loads before all five, so p86Prompt is there when they run', () => {
    const index = read('index.html');
    const at = (f) => index.search(new RegExp('<script src="' + f.replace(/[.]/g, '\\.') + '\\?v='));
    const dialogs = at('js/dialogs.js');
    expect(dialogs).toBeGreaterThan(-1);
    for (const f of FILES) expect(at(f)).toBeGreaterThan(dialogs);
  });
});
