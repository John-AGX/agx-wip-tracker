/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * A REFUSAL THE USER CANNOT GET OUT OF IS AN OUTAGE WEARING A BOUNDARY'S CLOTHES.
 *
 * app_settings('email') is ONE global row for the whole platform, so a BCC
 * address in it receives every tenant's mail. PUT /api/email/settings therefore
 * refuses an org admin who ADDS or CHANGES a BCC address. That gate is right
 * and it stays.
 *
 * What went wrong was the next second. Every control on the Email settings
 * panel — global BCC, digest mode, quiet-hours enable, start, end — is wired
 * to the same syncAndSave(), which re-reads the BCC input and PUTs the WHOLE
 * blob. After the 403 the rejected address was still in the input and still on
 * _emailSettings, so the next flick of an unrelated toggle re-sent it and was
 * refused again. And again, and again: the panel stopped saving the settings
 * the org admin WAS entitled to change, showed only "Save failed: <server
 * text>", and stayed that way until a full page reload rebuilt the input from
 * the server row. A boundary that costs a feature is a trade, not a fix, and
 * this wave has already revived several features taken that way.
 *
 * THE PROPERTIES, and they are about recovery rather than about the gate:
 *   1. after a refusal, the NEXT save carries the stored BCC, not the rejected
 *      one — so an unrelated toggle saves
 *   2. the input the user is looking at agrees with what will be sent
 *   3. the message explains ownership instead of echoing an API error
 *   4. a NON-403 failure still reports plainly — the recovery path must not
 *      swallow real errors
 *   5. the field is read-only for a non-owner in the first place, so the
 *      recovery path is a backstop and not the daily experience
 *
 * SLICED FROM THE SHIPPED SOURCE. The functions under test are pulled out of
 * js/admin.js by name and evaluated here. A copy pasted into the test would
 * pass forever while the app regressed; this way, deleting the recovery from
 * admin.js turns this file red.
 * ────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const ADMIN_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');

// Pull `function NAME(...) { ... }` out of the file by brace matching. Throws
// rather than returning empty, so a rename is a loud failure and not a
// vacuously green suite.
function slice(name) {
  const start = ADMIN_SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('admin.js no longer defines ' + name);
  let i = ADMIN_SRC.indexOf('{', start);
  let depth = 0;
  for (; i < ADMIN_SRC.length; i++) {
    const c = ADMIN_SRC[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return ADMIN_SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces slicing ' + name);
}

// Build a scope holding the real function bodies plus the few globals they
// close over in the app.
function makePanel(opts) {
  const o = opts || {};
  const calls = { put: [], get: 0 };
  const api = {
    put: (url, body) => {
      calls.put.push(JSON.parse(JSON.stringify(body)));
      const next = o.putResults.shift();
      // Deep-clone the echo. Handing back the same object the fixture uses as
      // "what the server stores" would let the panel's own assignment mutate
      // the fixture, and the test would be measuring itself.
      if (next && next.ok) return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      const err = new Error(next ? next.message : 'unexpected extra PUT');
      err.status = next ? next.status : 500;
      return Promise.reject(err);
    },
    get: () => {
      calls.get++;
      return o.getRejects
        ? Promise.reject(new Error('network'))
        : Promise.resolve({ settings: JSON.parse(JSON.stringify(o.stored)) });
    }
  };

  const factory = new Function('window', 'document', 'escapeHTML', 'seed', 'isOwner', `
    var _emailSettings = seed;
    var _emailSaveTimer = null;
    function isPlatformOwner() { return isOwner; }
    ${slice('saveEmailSettings')}
    ${slice('renderEmailGlobals')}
    return {
      render: renderEmailGlobals,
      save: saveEmailSettings,
      settings: function () { return _emailSettings; },
      set: function (k, v) { _emailSettings[k] = v; }
    };
  `);

  document.body.innerHTML = '<div id="email-globals"></div>';
  window.p86Api = api;
  const panel = factory(
    window, document,
    (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    JSON.parse(JSON.stringify(o.draft)),
    !!o.owner
  );
  panel.calls = calls;
  return panel;
}

const STORED = {
  globalBcc: 'ops@agxco.com',
  events: {},
  digestMode: false,
  quietHours: { enabled: false, start: '21:00', end: '07:00' }
};

const REFUSAL = {
  status: 403,
  message: 'Only a system administrator can change BCC recipients. Email settings are a ' +
           'single platform-wide record, so a BCC address here receives every organization\'s mail.'
};

// The debounce inside saveEmailSettings is a real 250ms setTimeout.
function tick() { return new Promise((r) => setTimeout(r, 320)); }

describe('the panel recovers from the BCC refusal instead of wedging', () => {
  test('after a 403, the next save carries the STORED bcc — not the rejected one', async () => {
    const panel = makePanel({
      owner: false,
      draft: Object.assign({}, STORED, { globalBcc: 'exfil@attacker.example' }),
      stored: STORED,
      putResults: [REFUSAL, { ok: true, value: { ok: true, settings: STORED } }]
    });
    panel.render();

    panel.save();
    await tick();
    expect(panel.calls.put[0].globalBcc).toBe('exfil@attacker.example');

    // An unrelated toggle, the exact move that used to 403 forever.
    panel.set('digestMode', true);
    panel.save();
    await tick();
    expect(panel.calls.put.length).toBe(2);
    expect(panel.calls.put[1].globalBcc).toBe('ops@agxco.com');
    expect(panel.calls.put[1].digestMode).toBe(true);
  });

  test('the input the user is looking at agrees with what will be sent', async () => {
    const panel = makePanel({
      owner: false,
      draft: Object.assign({}, STORED, { globalBcc: 'exfil@attacker.example' }),
      stored: STORED,
      putResults: [REFUSAL]
    });
    panel.render();
    panel.save();
    await tick();
    expect(document.getElementById('email-global-bcc').value).toBe('ops@agxco.com');
    expect(panel.settings().globalBcc).toBe('ops@agxco.com');
  });

  test('the message explains WHO owns the field, not what the API said', async () => {
    const panel = makePanel({
      owner: false,
      draft: Object.assign({}, STORED, { globalBcc: 'exfil@attacker.example' }),
      stored: STORED,
      putResults: [REFUSAL]
    });
    panel.render();
    panel.save();
    await tick();
    const status = document.getElementById('email-globals-status').textContent;
    expect(status).toMatch(/platform-wide/i);
    expect(status).toMatch(/other changes still save/i);
    expect(status).not.toMatch(/Save failed/i);
  });

  test('even if the re-read fails, the rejected address does not stay in the payload', async () => {
    const panel = makePanel({
      owner: false,
      draft: Object.assign({}, STORED, { globalBcc: 'exfil@attacker.example' }),
      stored: STORED,
      getRejects: true,
      putResults: [REFUSAL, { ok: true, value: { ok: true, settings: STORED } }]
    });
    panel.render();
    panel.save();
    await tick();
    panel.save();
    await tick();
    // Empty still saves; the rejected value never could.
    expect(panel.calls.put[1].globalBcc).toBe('');
  });

  test('a refusal is recoverable more than once — no latched broken state', async () => {
    const panel = makePanel({
      owner: false,
      draft: Object.assign({}, STORED, { globalBcc: 'one@attacker.example' }),
      stored: STORED,
      putResults: [
        REFUSAL,
        { ok: true, value: { ok: true, settings: STORED } },
        REFUSAL,
        { ok: true, value: { ok: true, settings: STORED } }
      ]
    });
    panel.render();
    for (const attempt of ['one@attacker.example', 'two@attacker.example']) {
      panel.set('globalBcc', attempt);
      panel.save();
      await tick();
      panel.save();
      await tick();
      expect(panel.settings().globalBcc).toBe('ops@agxco.com');
    }
    expect(panel.calls.put.length).toBe(4);
  });
});

describe('a real failure is still reported as one', () => {
  test('a 500 says "Save failed" and does not pretend it was a BCC refusal', async () => {
    const panel = makePanel({
      owner: false,
      draft: Object.assign({}, STORED),
      stored: STORED,
      putResults: [{ status: 500, message: 'Server error' }]
    });
    panel.render();
    panel.save();
    await tick();
    const status = document.getElementById('email-globals-status').textContent;
    expect(status).toMatch(/Save failed/i);
    expect(status).not.toMatch(/platform-wide/i);
    expect(panel.calls.get).toBe(0); // no pointless re-read
  });
});

describe('the field is read-only for a non-owner, so the wedge is unreachable by hand', () => {
  test('an org admin gets a read-only input and is told whose it is', () => {
    const panel = makePanel({ owner: false, draft: STORED, stored: STORED, putResults: [] });
    panel.render();
    const input = document.getElementById('email-global-bcc');
    expect(input.hasAttribute('readonly')).toBe(true);
    expect(document.getElementById('email-globals').textContent).toMatch(/platform owner/i);
  });

  test('the platform owner still gets an editable one', () => {
    const panel = makePanel({ owner: true, draft: STORED, stored: STORED, putResults: [] });
    panel.render();
    expect(document.getElementById('email-global-bcc').hasAttribute('readonly')).toBe(false);
  });

  test('the settings an org admin DOES own are editable either way', () => {
    const panel = makePanel({ owner: false, draft: STORED, stored: STORED, putResults: [] });
    panel.render();
    ['email-digest-mode', 'email-quiet-enabled', 'email-quiet-start', 'email-quiet-end']
      .forEach((id) => {
        const el = document.getElementById(id);
        expect({ id, present: !!el, readonly: !!(el && el.hasAttribute('readonly')) })
          .toEqual({ id, present: true, readonly: false });
      });
  });
});
