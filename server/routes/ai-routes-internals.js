// Tiny indirection module — re-exports the AG internals attached to
// the ai-routes module export. Lets sibling modules (e.g. the eval
// harness in admin-agents-routes) reuse buildEstimateContext / the
// tool list / the default model without importing the whole router.
const aiRoutes = require('./ai-routes');
module.exports = aiRoutes.internals;
