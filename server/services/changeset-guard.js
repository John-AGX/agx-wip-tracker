// changeset-guard.js — is this array a real before/after changeset?
//
// Lives in services/ (not routes/) deliberately: routes/* pull in the auth
// module, which hard-fails without JWT_SECRET, so pure logic parked there
// can only be tested where that env var happens to be set.
//
// The guard exists because driveScribeWrite returns
//   changeset: (dry.apply_changeset || dry.affected_targets) || []
// and `affected_targets` is a DIFFERENT shape — {entity_type, entity_id},
// no before, no after. Persisting that as a draft diff would advertise
// has_draft=true to the client and then render an empty diff, which reads
// to the user as "the agent did nothing".
//
// TWO checks, and the length one is the load-bearing half: `[].every(...)`
// is `true` in JavaScript, so without it an EMPTY changeset — what a
// schedule / system / assembly / deal_memory write produces, because the
// dispatcher has no snapshot table for those entity types — would sail
// through and be stored as '[]'::jsonb.
function isRenderableChangeset(cs) {
  return Array.isArray(cs) && cs.length > 0 && cs.every(
    (e) => e && typeof e === 'object' && ('before' in e) && ('after' in e)
  );
}

module.exports = { isRenderableChangeset };
