// slugify.js — shared slug helper for Anthropic skill `name:` fields
// and any other identifier that needs to be lowercase-ASCII-dash-only
// with a length cap.
//
// Extracted from three byte-identical copies (slugifySkillName in
// admin-agents-routes.js, slugifyPackName in admin-organizations-
// routes.js, slugifyMirrorName in ai-routes.js) as part of audit
// finding C3 (memoized-inventing-mountain.md).
//
// Rules:
//   - falsy input → 'skill' (matches Anthropic Skills' required name)
//   - lowercase
//   - any non-[a-z0-9] run collapses to a single '-'
//   - strip leading/trailing dashes
//   - cap at 64 characters
//   - empty result after stripping → 'skill' (never return '')

function slugify(input) {
  return String(input == null ? 'skill' : input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

module.exports = { slugify };
