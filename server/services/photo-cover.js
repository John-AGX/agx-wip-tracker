// ONE opinion about which photo represents a site, and one about which rows
// count as photos at all.
//
// WHY THIS FILE EXISTS
// 7bc0c225 ("Photos: one list instead of two views, and a cover that fills
// itself in") settled the cover question for PROJECTS, inside
// server/routes/project-routes.js as a local `firstPhotoSql(col)`. The Photos
// hub now carries two more rosters — Jobs and Leads — off the same polymorphic
// `attachments` table. A second cover rule beside that one is the drift this
// repo keeps paying for: a markup is a drawing OF the site, not the site, and a
// close-up of caulk is not what identifies a job, and those decisions must not
// be re-litigated per roster.
//
// So the rule is stated ONCE, here, generalised over the parent type. The
// project route is deliberately NOT edited to call it:
// test/project-cover-fallback.test.js re-evaluates that route's shipped helper
// BODY in isolation (`new Function('col', body)`), so turning it into a wrapper
// around a require() would make the body reference a binding that does not
// exist in that scope and redden a suite that is proving something real.
// Instead the two are held together by execution:
// test/photo-roster-cover-parity.test.js asserts the string this file emits for
// ('thumb_url', 'project', 'p.id') is BYTE-IDENTICAL to the one the route
// emits. Change either and that test names the divergence.
//
// THE OTHER HALF: WHAT COUNTS AS A PHOTO.
// A roster that says "12 photos" and opens to 3 is the silent-success class.
// The number therefore has to be computed with the VIEWER's predicate, not a
// plausible-looking one. js/attachments.js:23 is the viewer:
//
//     function isImageAttachment(att) {
//       return att && att.mime_type && att.mime_type.indexOf('image/') === 0
//              && !!att.thumb_url;
//     }
//
// mime family AND a generated thumbnail — an image whose derivative never came
// back is not rendered by the grid, so it must not be counted by the roster.
// viewerImageSql() below is that function in SQL and nothing else. Note it does
// NOT exclude markups: the viewer DOES show them (js/attachments.js:1417 splits
// them into their own "Annotated" section but they are inside `allPhotos`), so
// excluding them here would make the count smaller than what opens. The COVER
// does exclude them. Two different questions, two different predicates, both
// stated against the surface they have to agree with.
'use strict';

// The parent types a photo roster / cover may be computed for. entity_type is
// interpolated into SQL as a LITERAL, so it is never taken from a caller —
// only ever looked up here, the same whitelist discipline
// attachment-org-scope.js's ENTITY_TABLES uses.
const COVER_ENTITY_TYPES = new Set(['project', 'job', 'lead']);

// An id EXPRESSION, not a value: 'p.id', 'e.id'. Restricted to a bare
// qualified identifier so the concatenation below cannot become an injection
// point if a future caller passes something computed.
const ID_EXPR_RE = /^[a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?$/;

// The FIRST photo TAKEN on `idExpr`'s row, as a correlated scalar subquery.
//
// Verbatim in shape and content from project-routes.js's firstPhotoSql, with
// the entity type and the parent-id expression lifted out as parameters. Every
// clause is load-bearing and carries its reason there:
//
//   FIRST, not newest — the opening shot of a walkthrough identifies the site.
//   COALESCE(taken_at, uploaded_at) — taken_at is EXIF DateTimeOriginal and is
//     null on a screenshot or a re-saved image, which would otherwise drop out
//     of the running entirely.
//   mime_type LIKE 'image/%' — never a PDF.
//   thumb_url IS NOT NULL — a derivative that never generated cannot be shown.
//   markup_of IS NULL — a markup is a derived drawing OF the site, not the site.
//   position, id tiebreak — so the choice is stable across calls rather than
//     whatever the planner happens to return first.
//
// A correlated subquery rather than LEFT JOIN LATERAL, for the reason
// 7bc0c225 gives: LATERAL is Postgres-only and the harness runs the REAL
// emitted SQL through SQLite against a schema derived from db.js. A rule that
// cannot be executed in a test is a rule whose behaviour is asserted rather
// than proven.
function firstPhotoSql(col, entityType, idExpr) {
  if (col !== 'thumb_url' && col !== 'web_url') {
    throw new Error('firstPhotoSql: unsupported column ' + col);
  }
  if (!COVER_ENTITY_TYPES.has(entityType)) {
    throw new Error('firstPhotoSql: unsupported entity type ' + entityType);
  }
  if (!ID_EXPR_RE.test(String(idExpr || ''))) {
    throw new Error('firstPhotoSql: unsupported id expression ' + idExpr);
  }
  return '(SELECT a2.' + col + ' FROM attachments a2 ' +
         '  WHERE a2.entity_type = \'' + entityType + '\' AND a2.entity_id = ' + idExpr + ' ' +
         '    AND a2.mime_type LIKE \'image/%\' ' +
         '    AND a2.thumb_url IS NOT NULL ' +
         '    AND a2.markup_of IS NULL ' +
         '  ORDER BY COALESCE(a2.taken_at, a2.uploaded_at) ASC, a2.position ASC, a2.id ASC ' +
         '  LIMIT 1)';
}

// js/attachments.js's isImageAttachment(), in SQL. `alias` is the attachments
// alias in the enclosing statement.
function viewerImageSql(alias) {
  if (!ID_EXPR_RE.test(String(alias || ''))) {
    throw new Error('viewerImageSql: unsupported alias ' + alias);
  }
  return alias + '.mime_type LIKE \'image/%\' AND ' + alias + '.thumb_url IS NOT NULL';
}

module.exports = { firstPhotoSql, viewerImageSql, COVER_ENTITY_TYPES };
