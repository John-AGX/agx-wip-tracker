/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * The Buildertrend provenance mark.
 *
 * Three states, and the whole value of the badge is that they are not
 * guesses: `local` must mean "nothing in Buildertrend knows about this", and
 * it is shown beside money. A badge that says the wrong thing here is worse
 * than no badge, because it is believed.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'js', 'bt-badge.js');
const MARK = path.join(__dirname, '..', 'images', 'buildertrend-mark.png');

let B;
beforeAll(() => {
  // eslint-disable-next-line no-eval
  window.eval(fs.readFileSync(SRC, 'utf8'));
  B = window.p86BtBadge;
});

describe('which system a record lives in', () => {
  test('no Buildertrend id anywhere means Project 86 only', () => {
    expect(B.state({})).toBe('local');
    expect(B.state(null)).toBe('local');
    expect(B.state({ id: 'job1', title: 'x' })).toBe('local');
  });

  test('every entity’s id column is recognised', () => {
    for (const k of ['bt_job_id', 'bt_lead_id', 'bt_worksheet_id', 'bt_po_id',
                     'bt_co_id', 'bt_bill_id', 'bt_task_id', 'bt_contact_id']) {
      expect(B.state({ [k]: '1234' })).toBe('synced');
    }
  });

  test('camelCase reaches the same answer, for the stores that use it', () => {
    expect(B.state({ btJobId: '88213' })).toBe('synced');
    expect(B.state({ btPoId: '5510' })).toBe('synced');
  });

  test('an EMPTY id is not an id — blank, spaces and null all read local', () => {
    // A column that exists but was never filled must not paint a record as
    // synced; SELECTing the column is not the same as being linked.
    expect(B.state({ bt_job_id: '' })).toBe('local');
    expect(B.state({ bt_job_id: '   ' })).toBe('local');
    expect(B.state({ bt_job_id: null })).toBe('local');
    expect(B.state({ bt_job_id: undefined })).toBe('local');
  });

  test('a numeric id counts — Buildertrend ids arrive as numbers', () => {
    expect(B.state({ bt_job_id: 88213 })).toBe('synced');
    expect(B.btId({ bt_job_id: 88213 })).toBe('88213');
  });

  test('an id plus a Project 86 origin is `pushed`', () => {
    expect(B.state({ bt_job_id: '1', bt_origin: 'project86' })).toBe('pushed');
    expect(B.state({ bt_job_id: '1', btOrigin: 'Project86' })).toBe('pushed');
  });

  test('an origin WITHOUT an id is still local — origin alone is not a link', () => {
    expect(B.state({ bt_origin: 'project86' })).toBe('local');
  });

  test('an unrecognised origin falls back to `synced`, never to `pushed`', () => {
    // Today nothing writes bt_origin at all, so every linked row lands here.
    // Guessing "pushed" on an unknown value would claim we sent something we
    // did not.
    expect(B.state({ bt_job_id: '1', bt_origin: 'buildertrend' })).toBe('synced');
    expect(B.state({ bt_job_id: '1', bt_origin: '' })).toBe('synced');
    expect(B.state({ bt_job_id: '1', bt_origin: 'something-new' })).toBe('synced');
  });
});

describe('what gets drawn', () => {
  test('Buildertrend’s own file is used for both states that are in Buildertrend', () => {
    for (const st of ['synced', 'pushed']) {
      expect(B.render(null, { state: st })).toContain(B.MARK_SRC);
    }
  });

  test('their mark is never recoloured or redrawn — it is an <img>, untouched', () => {
    // The `pushed` state pins our cube NEXT to their icon rather than editing
    // it. If this ever becomes an inline <svg> of their logo, someone has
    // started redrawing a trademark.
    const pushed = B.render(null, { state: 'pushed' });
    expect(pushed).toMatch(/<img src="images\/buildertrend-mark\.png"/);
    expect(pushed).toContain('p86-bt-pin');
    expect(pushed).not.toMatch(/filter:/i);
  });

  test('Project 86 only draws our cube and no Buildertrend asset at all', () => {
    const local = B.render({});
    expect(local).not.toContain(B.MARK_SRC);
    expect(local).toContain('<polygon');
  });

  test('every badge says in words what it means, for hover and for a screen reader', () => {
    for (const st of ['local', 'synced', 'pushed']) {
      const h = B.render(null, { state: st });
      expect(h).toContain('role="img"');
      expect(h).toContain('aria-label="' + B.LABEL[st] + '"');
      expect(h).toContain('title="' + B.TITLE[st] + '"');
    }
    // The three sentences are distinct — a shared label would defeat the badge.
    expect(new Set(Object.values(B.TITLE)).size).toBe(3);
    expect(new Set(Object.values(B.LABEL)).size).toBe(3);
  });

  test('hideLocal suppresses ONLY the local badge', () => {
    expect(B.render({}, { hideLocal: true })).toBe('');
    expect(B.render({ bt_job_id: '1' }, { hideLocal: true })).not.toBe('');
  });

  test('size is honoured, and defaults to something that fits a table row', () => {
    expect(B.render({}, { size: 40 })).toContain('width="40"');
    expect(B.render({})).toContain('width="15"');
  });

  test('the legend shows all three, so the marks can be looked up', () => {
    const l = B.legend();
    for (const st of ['local', 'synced', 'pushed']) expect(l).toContain(B.LABEL[st]);
  });
});

describe('the Buildertrend asset itself', () => {
  test('it is a real, uncorrupted PNG — every chunk CRC checks out', () => {
    // A hand-transferred copy of this file arrived with a broken IDAT: right
    // length, wrong bytes, and it rendered as noise. Byte count alone does not
    // catch that, so the CRCs are checked.
    const f = fs.readFileSync(MARK);
    expect(f.slice(1, 4).toString()).toBe('PNG');
    expect(f.readUInt32BE(16)).toBe(192);
    expect(f.readUInt32BE(20)).toBe(192);

    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    let o = 8, seen = [];
    while (o < f.length) {
      const len = f.readUInt32BE(o);
      const typ = f.slice(o + 4, o + 8).toString();
      const body = f.slice(o + 4, o + 8 + len);
      const crc = f.readUInt32BE(o + 8 + len);
      let cr = 0xFFFFFFFF;
      for (const b of body) cr = table[(cr ^ b) & 0xff] ^ (cr >>> 8);
      expect([typ, (cr ^ 0xFFFFFFFF) >>> 0]).toEqual([typ, crc]);
      seen.push(typ);
      o += 12 + len;
      if (typ === 'IEND') break;
    }
    expect(seen[0]).toBe('IHDR');
    expect(seen[seen.length - 1]).toBe('IEND');
  });
});
