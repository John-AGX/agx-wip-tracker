/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE QUEUE — slice 1: one producer, one verb.
 *
 * A page for the decisions something is waiting on you for. The first (and so
 * far only) producer is a background agent task that called ask_user and
 * parked: agent_jobs goes status='needs_input' with the question, and the
 * worker resumes the SAME live Anthropic session once pause_answer is set.
 *
 * THE REASON THIS PAGE CAN EXIST AT ALL is that resumption is driven by the
 * worker polling the row — POST /answer writes pause_answer and nothing else —
 * so answering from a new page is the same act as answering in the chat the
 * task came from. That property is load-bearing and is pinned below.
 *
 * Adding a second answer surface is also what made two of the server fixes
 * necessary, and those are pinned here beside the page that caused them.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const INDEX = read('index.html');
const APP = read('js/app.js');
const ROUTER = read('js/router.js');
const QUEUE_SRC = read('js/queue.js');
const PANEL = read('js/agent-tasks.js');
const JOB_ROUTES = read('server/routes/agent-jobs-routes.js');
const AI = read('server/routes/ai-routes.js');

describe('the page is wired into every registry that decides it exists', () => {
  // Each of these is a separate switch, and missing any one fails quietly:
  // no sidebar row, a pane that never shows, a URL that will not round-trip,
  // or a page titled "Project 86".
  test('a sidebar row carries the tab and its badge', () => {
    expect(INDEX).toMatch(/<button class="tab-btn" data-tab="queue"[^>]*>/);
    expect(INDEX).toContain('id="navQueueBadge"');
  });

  test('the pane id equals the data-tab value, or switchTab cannot show it', () => {
    expect(INDEX).toContain('<div id="queue" class="tab-content">');
    expect(INDEX).toContain('<div id="queueHost"></div>');
  });

  test('the module is loaded, and after the api it calls', () => {
    const q = INDEX.search(/<script src="js\/queue\.js\?v=\d+"><\/script>/);
    const api = INDEX.search(/<script src="js\/api\.js\?v=\d+"><\/script>/);
    expect(q).toBeGreaterThan(-1);
    expect(api).toBeGreaterThan(-1);
    expect(q).toBeGreaterThan(api);
  });

  test('the route round-trips: /queue is a known top tab', () => {
    const m = ROUTER.match(/var KNOWN_TOP_TABS = \[[^\]]*\]/);
    expect(m).not.toBeNull();
    expect(m[0]).toContain("'queue'");
  });

  test('it has a page title, and a switchTab branch that renders it', () => {
    expect(APP).toMatch(/queue:\s*'Queue',/);
    const i = APP.indexOf("} else if (tabName === 'queue') {");
    expect(i).toBeGreaterThan(-1);
    const branch = APP.slice(i, APP.indexOf("} else if (tabName === 'cost-inbox')", i));
    expect(branch).toContain("document.getElementById('queueHost')");
    expect(branch).toContain('window.p86Queue');
    expect(branch).toContain('Queue module not loaded.');
  });
});

describe('what the page treats as waiting', () => {
  let Q;
  beforeAll(() => {
    window.p86Api = { get: () => Promise.resolve({ jobs: [] }), post: () => Promise.resolve({ ok: true }) };
    // eslint-disable-next-line no-eval
    window.eval(QUEUE_SRC);
    Q = window.p86Queue;
  });

  test('only a task that actually asked something is a queue item', () => {
    const w = Q.__test.isWaiting;
    expect(w({ status: 'needs_input', pause_question: 'Which client?' })).toBe(true);
    // Paused with no question is not a decision anyone can take.
    expect(w({ status: 'needs_input', pause_question: null })).toBe(false);
    expect(w({ status: 'running', pause_question: 'Which client?' })).toBe(false);
    expect(w({ status: 'done', result: 'x' })).toBe(false);
    expect(w({ status: 'failed', error: 'x' })).toBe(false);
    expect(w(null)).toBe(false);
  });

  test('the question is shown in full, and the prompt is escaped, not run', () => {
    const html = Q.__test.cardHTML({ id: 'aj_1', title: '<img src=x onerror=alert(1)>', pause_question: 'A & B < C', prompt: 'do the thing' });
    expect(html).toContain('A &amp; B &lt; C');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('data-q-send="aj_1"');
    expect(html).toContain('data-q-answer="aj_1"');
  });
});

describe('answering, end to end, against the real module', () => {
  let Q, posted, host;
  const job = { id: 'aj_7', status: 'needs_input', title: 'Price the Saddlebrook decks', pause_question: 'Which cluster?', paused_at: new Date().toISOString() };

  beforeEach(() => {
    posted = [];
    document.body.innerHTML = '<div id="queueHost"></div>';
    host = document.getElementById('queueHost');
    window.p86Toast = () => {};
    window.p86Api = {
      get: () => Promise.resolve({ jobs: [job] }),
      post: (url, body) => { posted.push([url, body]); return Promise.resolve({ ok: true }); },
    };
    // eslint-disable-next-line no-eval
    window.eval(QUEUE_SRC);
    Q = window.p86Queue;
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('the card renders, and answering posts to the task it belongs to', async () => {
    Q.render(host);
    await flush(); await flush();
    expect(host.textContent).toContain('Which cluster?');
    expect(host.textContent).toContain('1 waiting on you');

    host.querySelector('[data-q-answer="aj_7"]').value = '  Cluster 8  ';
    host.querySelector('[data-q-send="aj_7"]').click();
    await flush(); await flush();

    expect(posted).toEqual([['/api/agent-jobs/aj_7/answer', { answer: 'Cluster 8' }]]);
  });

  test('an empty answer is not sent', async () => {
    Q.render(host);
    await flush(); await flush();
    host.querySelector('[data-q-answer="aj_7"]').value = '   ';
    host.querySelector('[data-q-send="aj_7"]').click();
    await flush();
    expect(posted).toEqual([]);
  });

  test('once answered it leaves the queue, rather than sitting there until the worker ticks', async () => {
    // The row stays needs_input for up to 10s after /answer, so a page that
    // trusted the next poll would show the question as still waiting and
    // invite a second answer — the race the server now refuses.
    Q.render(host);
    await flush(); await flush();
    host.querySelector('[data-q-answer="aj_7"]').value = 'Cluster 8';
    host.querySelector('[data-q-send="aj_7"]').click();
    await flush(); await flush();
    expect(host.textContent).not.toContain('Which cluster?');
    expect(Q.pendingCount()).toBe(0);
  });

  test('a failed answer says so instead of looking like it worked', async () => {
    const said = [];
    window.p86Toast = (msg, kind) => said.push([kind, msg]);
    window.p86Api.post = () => Promise.reject(new Error('offline'));
    Q.render(host);
    await flush(); await flush();
    host.querySelector('[data-q-answer="aj_7"]').value = 'Cluster 8';
    host.querySelector('[data-q-send="aj_7"]').click();
    await flush(); await flush();
    expect(said.map((s) => s[0])).toContain('error');
    // and the question is still there to answer again
    expect(host.textContent).toContain('Which cluster?');
  });

  test('the badge counts what is WAITING, not what is unseen', async () => {
    document.body.innerHTML += '<span id="navQueueBadge" style="display:none"></span>';
    Q.render(host);
    await flush(); await flush();
    const badge = document.getElementById('navQueueBadge');
    expect(badge.textContent).toBe('1');
    expect(badge.style.display).not.toBe('none');
  });
});

describe('the server fixes this page made necessary', () => {
  test('one answer wins: a second one cannot overwrite it', () => {
    // Two surfaces could write pause_answer inside the worker's 10s tick.
    expect(JOB_ROUTES).toContain("AND pause_answer IS NULL RETURNING id");
    expect(JOB_ROUTES).toMatch(/already answered/);
  });

  test('a second question clears seen_at, or the badge never shows it', () => {
    const i = AI.indexOf("UPDATE agent_jobs SET status='needs_input'");
    expect(i).toBeGreaterThan(-1);
    expect(AI.slice(i, i + 220)).toContain('seen_at=NULL');
  });

  test('the opt-out reads the key My Account actually writes', () => {
    // notify-events registers the singular 'agent_task'; both email gates read
    // the plural, so muting Background tasks silenced push and left email on.
    expect(read('server/notify-events.js')).toContain("key: 'agent_task'");
    expect(AI).not.toMatch(/\.agent_tasks === false/);
    expect((AI.match(/\.agent_task === false/g) || []).length).toBe(2);
  });

  test('the notification leads here, not to the app root', () => {
    // the quote after /queue closes the HTML href attribute
    expect(AI).toContain("esc(appUrl) + '/queue\"");
    expect(AI).toMatch(/needs your answer[^\n]*url: '\/queue'/);
  });
});

describe('there is ONE place to answer', () => {
  test('the Crew panel shows the question but hands the answering to the Queue', () => {
    expect(PANEL).toContain('data-q-go="');
    expect(PANEL).toContain('Answer in the Queue');
    // the old inline box is gone — two live boxes was the race itself
    expect(PANEL).not.toContain('p86-bgt-answer-in');
  });
});
