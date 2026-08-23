// test/agent-prompt-caps.test.js — the unbounded halves of the cached prefix.
//
// composedAgentSystem() appends two per-tenant blocks to the registered agent
// system prompt with no bound of any kind:
//
//   org_memory              SELECT name, body ... no LIMIT, no length cap
//   organizations.identity_body   appended whole
//
// That prompt is the CACHED PREFIX. It is not paid once — every session on the
// agent pays it via cache_read on its first turn, and pays it again as
// cache_creation each time the entry lapses. At 6,536 and 1,132 chars today
// they are innocent; both are free-text admin fields, so they are innocent by
// coincidence, not by construction. One pasted document and the biggest line
// in the token ledger is something nobody remembers pasting.
//
// The reference-links block already carries a cap (REF_LINKS_PROMPT_CAP,
// 60,000). These two never did.
//
// What is pinned here is a PROPERTY, not an example: for org_memory content of
// ANY size and ANY shape, the composed block stays under the cap AND says out
// loud that it truncated — in the prompt text the model reads, in the
// structured return the audit renders, and in a log line. A silent cut means
// 86 quietly stops knowing something and nobody is told; that is the exact
// failure mode agent-tool-description.js exists to prevent for tool
// descriptions, and it was wide open here.

const {
  ORG_MEMORY_PROMPT_CAP,
  IDENTITY_BODY_PROMPT_CAP,
  NOTICE_RESERVE,
  capIdentityBody,
  buildOrgMemoryBlock,
} = require('../server/services/agent-prompt-caps');

// A deterministic spread of adversarial shapes. Every property below runs
// against ALL of them — that is what makes them properties rather than cases.
function rowsOfTotal(totalChars, rowCount, namePrefix) {
  const per = Math.max(1, Math.floor(totalChars / rowCount));
  const out = [];
  for (let i = 0; i < rowCount; i++) {
    out.push({ name: (namePrefix || 'row') + '-' + i, body: 'b'.repeat(per) });
  }
  return out;
}

const SHAPES = [
  { label: 'no rows', rows: [] },
  { label: 'one tiny row', rows: [{ name: 'Posture', body: 'Be terse.' }] },
  { label: 'live AGX size (7 rows / ~6.5k)', rows: rowsOfTotal(6536, 7) },
  { label: 'just under the cap', rows: rowsOfTotal(ORG_MEMORY_PROMPT_CAP - 2000, 8) },
  { label: 'just over the cap', rows: rowsOfTotal(ORG_MEMORY_PROMPT_CAP + 500, 8) },
  { label: 'one pasted spec document (200k, single row)', rows: rowsOfTotal(200000, 1) },
  { label: 'a thousand small rows', rows: rowsOfTotal(200000, 1000) },
  { label: 'two rows, first alone over cap', rows: [
    { name: 'Huge', body: 'x'.repeat(ORG_MEMORY_PROMPT_CAP * 3) },
    { name: 'Small', body: 'tiny' },
  ] },
  { label: 'empty names and bodies', rows: [
    { name: '', body: '' }, { name: null, body: null }, { name: 'ok', body: 'y'.repeat(50000) },
  ] },
  { label: 'names longer than the notice reserve', rows: [
    { name: 'N'.repeat(2000), body: 'z'.repeat(30000) },
    { name: 'M'.repeat(2000), body: 'z'.repeat(30000) },
  ] },
];

describe('buildOrgMemoryBlock — the cap holds for any content', () => {
  for (const shape of SHAPES) {
    test('never exceeds the cap: ' + shape.label, () => {
      const r = buildOrgMemoryBlock(shape.rows, ORG_MEMORY_PROMPT_CAP);
      expect(r.text.length).toBeLessThanOrEqual(ORG_MEMORY_PROMPT_CAP);
    });
  }

  // The cap is a parameter, so the property must hold at every cap — including
  // caps smaller than the truncation notice itself, which is where a
  // reserve-based implementation is most likely to overrun.
  for (const cap of [0, 1, 50, 400, NOTICE_RESERVE, NOTICE_RESERVE + 1, 5000, ORG_MEMORY_PROMPT_CAP, 500000]) {
    test('never exceeds a cap of ' + cap + ', for every shape', () => {
      for (const shape of SHAPES) {
        const r = buildOrgMemoryBlock(shape.rows, cap);
        expect(r.text.length).toBeLessThanOrEqual(cap);
      }
    });
  }

  test('content below the cap passes through byte-identical and silent', () => {
    const rows = [{ name: 'A', body: 'alpha' }, { name: 'B', body: 'beta' }];
    const r = buildOrgMemoryBlock(rows, ORG_MEMORY_PROMPT_CAP);
    expect(r.text).toBe('## Working posture\n\n### A\nalpha\n\n### B\nbeta');
    expect(r.truncated).toBe(false);
    expect(r.warning).toBeNull();
    expect(r.droppedNames).toEqual([]);
    expect(r.rowsKept).toBe(2);
  });

  test('TODAY\'S live size truncates nothing — this change removes no capability', () => {
    // 7 rows / 6,536 chars, the measured live AGX org_memory.
    const r = buildOrgMemoryBlock(rowsOfTotal(6536, 7), ORG_MEMORY_PROMPT_CAP);
    expect(r.truncated).toBe(false);
    expect(r.rowsKept).toBe(7);
    expect(r.droppedNames).toEqual([]);
  });
});

// The change must register NOTHING new today. Introducing a cap that also
// reflows the text would bump the agent version and pay a full cache_creation
// on the whole prefix — this fix causing the very cost it exists to stop. So
// the under-cap output is pinned byte-for-byte against the pre-cap
// construction that composedAgentSystem used to inline.
describe('under the cap the bytes are IDENTICAL to the pre-cap construction', () => {
  function legacyBlock(rows) {
    return ['## Working posture'].concat(
      rows.map(r => '### ' + String(r.name).trim() + '\n' + String(r.body).trim())
    ).join('\n\n');
  }

  const UNDER_CAP = [
    [{ name: 'A', body: 'alpha' }],
    [{ name: 'A', body: 'alpha' }, { name: 'B', body: 'beta' }],
    rowsOfTotal(6536, 7),                       // today's live AGX content
    [{ name: '  padded  ', body: '  trimmed  ' }],
    [{ name: 'multi', body: 'line one\nline two\n\nline four' }],
  ];

  for (let i = 0; i < UNDER_CAP.length; i++) {
    test('byte-identical, shape ' + i, () => {
      const r = buildOrgMemoryBlock(UNDER_CAP[i], ORG_MEMORY_PROMPT_CAP);
      expect(r.truncated).toBe(false);
      expect(r.text).toBe(legacyBlock(UNDER_CAP[i]));
    });
  }

  test('identity_body under the cap is byte-identical to .trim()', () => {
    for (const b of ['AGX', '  padded  ', 'i'.repeat(1132), 'multi\nline\nbody']) {
      expect(capIdentityBody(b, IDENTITY_BODY_PROMPT_CAP).text).toBe(String(b).trim());
    }
  });
});

describe('buildOrgMemoryBlock — truncation is never silent', () => {
  const over = SHAPES.filter(s =>
    buildOrgMemoryBlock(s.rows, ORG_MEMORY_PROMPT_CAP).truncated);

  test('the adversarial set actually contains over-cap shapes', () => {
    expect(over.length).toBeGreaterThan(0);
  });

  for (const shape of over) {
    test('says it truncated, three ways: ' + shape.label, () => {
      const r = buildOrgMemoryBlock(shape.rows, ORG_MEMORY_PROMPT_CAP);
      // 1. In the prompt the model actually reads.
      expect(r.text).toMatch(/TRUNCATED/);
      // 2. In the structured return the audit renders.
      expect(r.truncated).toBe(true);
      expect(r.originalChars).toBeGreaterThan(r.keptChars);
      // 3. In a log line.
      expect(r.warning).toBeTruthy();
      expect(r.warning).toMatch(/ORG MEMORY TRUNCATED/);
    });
  }

  test('the in-prompt notice names the rows that were dropped', () => {
    const rows = [
      { name: 'Keeper', body: 'k'.repeat(ORG_MEMORY_PROMPT_CAP - 3000) },
      { name: 'DroppedPosture', body: 'd'.repeat(5000) },
    ];
    const r = buildOrgMemoryBlock(rows, ORG_MEMORY_PROMPT_CAP);
    expect(r.truncated).toBe(true);
    expect(r.droppedNames).toContain('DroppedPosture');
    expect(r.text).toContain('DroppedPosture');
    expect(r.warning).toContain('DroppedPosture');
  });

  test('the notice tells the model to SAY its posture is partial, not guess', () => {
    const r = buildOrgMemoryBlock(rowsOfTotal(200000, 20), ORG_MEMORY_PROMPT_CAP);
    expect(r.text).toMatch(/truncated/i);
    expect(r.text).toMatch(/ask|say/i);
  });

  test('the warning says the TAIL goes — i.e. the NEWEST posture', () => {
    const r = buildOrgMemoryBlock(rowsOfTotal(200000, 20), ORG_MEMORY_PROMPT_CAP);
    expect(r.warning).toMatch(/TAIL/);
    expect(r.warning).toMatch(/MOST RECENTLY/);
  });

  test('it steers to archiving rows or a lookup link, not to raising the cap', () => {
    const r = buildOrgMemoryBlock(rowsOfTotal(200000, 20), ORG_MEMORY_PROMPT_CAP);
    expect(r.warning).toMatch(/lookup/);
    expect(r.warning).toMatch(/do NOT raise the cap/);
  });

  test('it names the cached prefix — WHY one row costs every session', () => {
    const r = buildOrgMemoryBlock(rowsOfTotal(200000, 20), ORG_MEMORY_PROMPT_CAP);
    expect(r.warning).toMatch(/CACHED PREFIX/);
  });

  test('a single row bigger than the whole budget is cut, marked, and reported', () => {
    const r = buildOrgMemoryBlock(
      [{ name: 'Monster', body: 'x'.repeat(ORG_MEMORY_PROMPT_CAP * 4) }],
      ORG_MEMORY_PROMPT_CAP
    );
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(ORG_MEMORY_PROMPT_CAP);
    expect(r.text).toMatch(/row cut at the prompt cap/);
    expect(r.text).toContain('Monster');
  });

  test('rows are dropped WHOLE — a kept row is never half a row', () => {
    const rows = [
      { name: 'One', body: 'a'.repeat(4000) },
      { name: 'Two', body: 'b'.repeat(4000) },
      { name: 'Three', body: 'c'.repeat(4000) },
      { name: 'Four', body: 'd'.repeat(40000) },
    ];
    const r = buildOrgMemoryBlock(rows, ORG_MEMORY_PROMPT_CAP);
    expect(r.truncated).toBe(true);
    // Every row the block still claims to carry is carried in full.
    for (const kept of ['One', 'Two', 'Three']) {
      const row = rows.find(x => x.name === kept);
      if (r.droppedNames.indexOf(kept) === -1) expect(r.text).toContain(row.body);
    }
  });

  test('rowsKept + dropped accounts for every row given', () => {
    for (const shape of SHAPES) {
      const r = buildOrgMemoryBlock(shape.rows, ORG_MEMORY_PROMPT_CAP);
      expect(r.rowsGiven).toBe(shape.rows.length);
      expect(r.rowsKept + r.droppedNames.length).toBe(shape.rows.length);
    }
  });

  test('malformed rows are not a crash', () => {
    expect(() => buildOrgMemoryBlock(null, ORG_MEMORY_PROMPT_CAP)).not.toThrow();
    expect(() => buildOrgMemoryBlock(undefined, ORG_MEMORY_PROMPT_CAP)).not.toThrow();
    expect(() => buildOrgMemoryBlock([null, undefined, {}], ORG_MEMORY_PROMPT_CAP)).not.toThrow();
    expect(buildOrgMemoryBlock([], ORG_MEMORY_PROMPT_CAP).text).toBe('');
  });
});

describe('capIdentityBody — the cap holds and announces itself', () => {
  const BODIES = [
    '', 'AGX is a Central Florida GC.', 'x'.repeat(IDENTITY_BODY_PROMPT_CAP - 1),
    'x'.repeat(IDENTITY_BODY_PROMPT_CAP), 'x'.repeat(IDENTITY_BODY_PROMPT_CAP + 1),
    'x'.repeat(200000),
  ];

  for (const cap of [0, 1, 100, NOTICE_RESERVE, IDENTITY_BODY_PROMPT_CAP, 100000]) {
    test('never exceeds a cap of ' + cap + ', for any body', () => {
      for (const b of BODIES) {
        expect(capIdentityBody(b, cap).text.length).toBeLessThanOrEqual(cap);
      }
    });
  }

  test('at or under the cap it is byte-identical and silent', () => {
    const b = 'AGX is a Central Florida GC.';
    const r = capIdentityBody(b, IDENTITY_BODY_PROMPT_CAP);
    expect(r.text).toBe(b);
    expect(r.truncated).toBe(false);
    expect(r.warning).toBeNull();
  });

  test('TODAY\'S live identity_body (1,132 chars) truncates nothing', () => {
    const r = capIdentityBody('i'.repeat(1132), IDENTITY_BODY_PROMPT_CAP);
    expect(r.truncated).toBe(false);
  });

  test('one char over truncates AND announces — in prompt, struct, and log', () => {
    const r = capIdentityBody('x'.repeat(IDENTITY_BODY_PROMPT_CAP + 1), IDENTITY_BODY_PROMPT_CAP);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/TRUNCATED/);
    expect(r.warning).toMatch(/ORG IDENTITY TRUNCATED/);
    expect(r.warning).toMatch(/CACHED PREFIX/);
    expect(r.warning).toMatch(/do NOT raise the cap/);
    expect(r.droppedChars).toBeGreaterThan(0);
  });

  test('a missing identity is not a crash', () => {
    expect(capIdentityBody(null, IDENTITY_BODY_PROMPT_CAP).text).toBe('');
    expect(capIdentityBody(undefined, IDENTITY_BODY_PROMPT_CAP).truncated).toBe(false);
  });
});

// ── Mutation guard ────────────────────────────────────────────────────────
//
// The properties above are only worth anything if they FAIL when the cap is
// bypassed. Each bypass below is the shape of a real regression: someone
// "simplifies" the builder back to a join, or reserves nothing for the notice,
// or drops the notice entirely to save tokens. All three must go red.
describe('the cap properties detect their own bypasses', () => {
  const rows = rowsOfTotal(200000, 20);

  function bypassNoCap(rs) {
    return { text: ['## Working posture'].concat(
      rs.map(r => '### ' + r.name + '\n' + r.body)).join('\n\n'), truncated: false, warning: null };
  }
  function bypassSilentSlice(rs, cap) {
    const full = ['## Working posture'].concat(
      rs.map(r => '### ' + r.name + '\n' + r.body)).join('\n\n');
    return { text: full.slice(0, cap), truncated: full.length > cap, warning: 'x' };
  }
  function bypassNoReserve(rs, cap) {
    // Fits rows to the FULL cap, then appends the notice on top — the
    // off-by-the-notice overrun.
    let out = '## Working posture';
    for (const r of rs) {
      const c = '\n\n### ' + r.name + '\n' + r.body;
      if (out.length + c.length > cap) break;
      out += c;
    }
    return { text: out + '\n\n[TRUNCATED: some rows were dropped]'.repeat(20), truncated: true, warning: 'x' };
  }

  test('the real builder passes both properties', () => {
    const r = buildOrgMemoryBlock(rows, ORG_MEMORY_PROMPT_CAP);
    expect(r.text.length).toBeLessThanOrEqual(ORG_MEMORY_PROMPT_CAP);
    expect(r.text).toMatch(/TRUNCATED/);
  });

  test('RED — no cap at all breaks the size property', () => {
    expect(bypassNoCap(rows).text.length).toBeGreaterThan(ORG_MEMORY_PROMPT_CAP);
  });

  test('RED — a silent slice() keeps the size but loses the announcement', () => {
    const b = bypassSilentSlice(rows, ORG_MEMORY_PROMPT_CAP);
    expect(b.text.length).toBeLessThanOrEqual(ORG_MEMORY_PROMPT_CAP); // size ok…
    expect(b.text).not.toMatch(/TRUNCATED/);                          // …voice gone
  });

  test('RED — reserving nothing for the notice overruns the cap', () => {
    // Small rows so the greedy fill packs right up to the cap; the notice
    // appended afterwards is then pure overrun. This is the off-by-the-notice
    // bug the NOTICE_RESERVE + separator arithmetic exists to prevent, and it
    // was live in the first draft of this file.
    const tight = rowsOfTotal(200000, 1000);
    expect(bypassNoReserve(tight, ORG_MEMORY_PROMPT_CAP).text.length)
      .toBeGreaterThan(ORG_MEMORY_PROMPT_CAP);
    // …while the real builder, given the identical rows, stays under.
    expect(buildOrgMemoryBlock(tight, ORG_MEMORY_PROMPT_CAP).text.length)
      .toBeLessThanOrEqual(ORG_MEMORY_PROMPT_CAP);
  });
});
