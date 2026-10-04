/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE JOB'S TASKS, AS A SECTION.
 *
 * The list itself is not new: tasks.entity_type='job' has existed, and the
 * Overview dashboard mounts the shared panel in its side column. What was
 * missing was a way to GET there — "what is outstanding on this job" meant
 * scrolling someone else's dashboard, and on a phone it meant scrolling it
 * twice.
 *
 * The renderer therefore does one thing and must keep doing it: hand the
 * SHARED panel (p86Tasks.mountEntityPanel) this job, so the section, the
 * dashboard, 86 and the refresh registry are all looking at one list.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'job-media.js'), 'utf8');

const JOB = { id: 'job_7', jobNumber: 'S2453', title: 'Oak Bridge Roof Leak WO' };
let calls;

beforeEach(() => {
  document.body.innerHTML = '<div id="job-tasks"></div>';
  calls = [];
  window.appState = { currentJobId: JOB.id };
  window.appData = { jobs: [JOB] };
  window.p86JobLabel = {
    fromJob: function (j, o) {
      return j ? ((j.jobNumber ? j.jobNumber + ' · ' : '') + (j.title || '')) : (o && o.fallback) || '';
    }
  };
  window.p86Tasks = {
    mountEntityPanel: function (host, type, id, label) {
      calls.push({ host: host && host.id, type: type, id: id, label: label });
      host.innerHTML = '<div class="p86-task-panel">panel</div>';
      return { refresh: function () {} };
    }
  };
  window.eval(SRC);
});

describe('the section mounts the shared panel', () => {
  test('for THIS job, as a job entity', () => {
    window.renderJobTasks(JOB.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe('job-tasks');
    expect(calls[0].type).toBe('job');
    expect(calls[0].id).toBe('job_7');
  });

  test('labelled with the job\'s forward-facing name', () => {
    // Job number + title, the name every client-facing surface prints — not
    // the raw id, which is what a task filed from here would otherwise show.
    window.renderJobTasks(JOB.id);
    expect(calls[0].label).toBe('S2453 · Oak Bridge Roof Leak WO');
  });

  test('with no argument it uses the job that is open', () => {
    window.renderJobTasks();
    expect(calls[0].id).toBe('job_7');
  });

  test('it is published under the name the section registry looks up', () => {
    // js/workspace-layout.js resolves renderers as window[name](jobId).
    expect(typeof window.renderJobTasks).toBe('function');
    const layout = fs.readFileSync(path.join(ROOT, 'js', 'workspace-layout.js'), 'utf8');
    expect(layout).toMatch(/'job-tasks': 'renderJobTasks'/);
    expect((layout.match(/'job-tasks': 'renderJobTasks'/g) || []).length).toBe(2); // both renderer maps
  });

  test('the panel element exists in the page it renders into', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(index).toMatch(/id="job-tasks" class="sub-tab-content-job"/);
  });
});

describe('reopening the section shows the list as it is now', () => {
  test('every visit remounts, so the list is the list as it is NOW', () => {
    // The panel replaces the host contents on mount, which is what makes a
    // task completed in the modal (or by 86) gone when you come back. Caching
    // the first render here would show yesterday.
    window.renderJobTasks(JOB.id);
    window.renderJobTasks(JOB.id);
    expect(calls).toHaveLength(2);
    expect(document.querySelectorAll('#job-tasks .p86-task-panel')).toHaveLength(1);
  });
});

describe('it degrades instead of breaking the page', () => {
  test('no tasks module: it says so rather than throwing', () => {
    delete window.p86Tasks;
    expect(() => window.renderJobTasks(JOB.id)).not.toThrow();
    expect(document.getElementById('job-tasks').textContent).toMatch(/not loaded/i);
  });

  test('no job open: nothing is mounted against the wrong entity', () => {
    window.appState = { currentJobId: null };
    window.renderJobTasks();
    expect(calls).toHaveLength(0);
  });

  test('no panel element: it returns quietly', () => {
    document.body.innerHTML = '';
    expect(() => window.renderJobTasks(JOB.id)).not.toThrow();
    expect(calls).toHaveLength(0);
  });
});
