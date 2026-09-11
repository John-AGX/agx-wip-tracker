'use strict';

// link_ops elements were shape-checked at the top key only. Every other key
// sailed through emit-time validation and was then silently ignored at apply
// time — so a Scribe asked to write photo descriptions emitted
//
//   attach_files { attachment_ids, target_entity_type, target_entity_id,
//                  caption, captions }
//
// which VALIDATED, re-pointed three rows to a different parent, wrote no
// caption, and reported "~1 updated". The Scribe's own baseline promises "the
// dispatcher rejects unknown columns and lists the valid set in its error" —
// true for every other entity type, false here, and that asymmetry is what let
// a wrong shape look like a working one.

const pd = require('../server/services/payload-dispatcher');

const target = (ops) => ({ entity_type: 'system', entity_id: 'sys', ops });
const validate = (ops) => pd.validateTarget(target(ops));
const refusal = (ops) => {
  try { validate(ops); return null; } catch (e) { return e.message; }
};

describe('link_ops elements are key-checked at emit time', () => {
  test('the shape that caused this: attach_files carrying caption keys is refused BY NAME', () => {
    const msg = refusal({ link_ops: [{
      op: 'attach_files',
      attachment_ids: ['a1', 'a2', 'a3'],
      target_entity_type: 'project',
      target_entity_id: 'p1',
      caption: 'North elevation after framing',
      captions: { a1: 'one', a2: 'two' },
    }] });
    expect(msg).toBeTruthy();
    expect(msg).toContain("'caption'");
    expect(msg).toContain("'captions'");
    // and it lists the valid set, which is what lets the Scribe self-correct
    expect(msg).toContain('attachment_ids');
    expect(msg).toContain('target_entity_type');
    expect(msg).toContain('target_entity_id');
  });

  test.each([
    ['attach_files', { op: 'attach_files', attachment_ids: ['a1'], target_entity_type: 'project', target_entity_id: 'p1' }],
    ['link_job_to_client', { op: 'link_job_to_client', job_id: 'j1', client_id: 'c1' }],
    ['link_property_to_parent', { op: 'link_property_to_parent', property_id: 'pr1', parent_client_id: 'c1' }],
  ])('the legitimate shape of %s still validates', (_label, lk) => {
    expect(() => validate({ link_ops: [lk] })).not.toThrow();
  });

  test.each([
    ['attach_files', { op: 'attach_files', attachment_ids: ['a1'], target_entity_type: 'project', target_entity_id: 'p1', tags: ['x'] }, 'tags'],
    ['link_job_to_client', { op: 'link_job_to_client', job_id: 'j1', client_id: 'c1', notes: 'hi' }, 'notes'],
    ['link_property_to_parent', { op: 'link_property_to_parent', property_id: 'pr1', parent_client_id: 'c1', address: 'x' }, 'address'],
  ])('%s refuses an unknown key rather than ignoring it', (_label, lk, key) => {
    const msg = refusal({ link_ops: [lk] });
    expect(msg).toBeTruthy();
    expect(msg).toContain("'" + key + "'");
  });

  test('an unknown op is left to apply time, which already names the valid set', () => {
    // Not our job to duplicate that list in two places; the point is only that
    // emit-time validation does not invent a refusal for an op it knows nothing
    // about.
    expect(() => validate({ link_ops: [{ op: 'set_caption', attachment_id: 'a1', caption: 'x' }] })).not.toThrow();
  });

  test('a non-object element is left to apply time', () => {
    expect(() => validate({ link_ops: ['nonsense'] })).not.toThrow();
    expect(() => validate({ link_ops: [null] })).not.toThrow();
  });

  test('link_ops that is not an array is still refused as before', () => {
    expect(refusal({ link_ops: { op: 'attach_files' } })).toContain('must be an array');
  });

  // MUTATION: with the allowlist removed the defect returns. This test exists
  // to be the thing that fails if someone deletes the check.
  test('the allowlist is what refuses it, not something else in the chain', () => {
    const withCaption = { op: 'attach_files', attachment_ids: ['a1'], target_entity_type: 'project', target_entity_id: 'p1', caption: 'x' };
    const without = { op: 'attach_files', attachment_ids: ['a1'], target_entity_type: 'project', target_entity_id: 'p1' };
    // identical but for the one key, and only one of them is refused
    expect(() => validate({ link_ops: [without] })).not.toThrow();
    expect(() => validate({ link_ops: [withCaption] })).toThrow();
  });
});
