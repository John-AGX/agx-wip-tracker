// Public client config endpoints — values the browser needs that
// don't fit in the static asset bundle. Each value is server-rendered
// per request so we can rotate keys without rebuilding the client.
//
// Currently serves:
//   GET /api/config/maps-key — Google Maps JS API key for client-side
//                              map rendering. Requires auth so unauth'd
//                              scrapers can't grab the key. The key
//                              itself is domain-restricted (referrer)
//                              at the Google side, so even if it leaks
//                              from a user's devtools it's only usable
//                              from project86.net or *.up.railway.app.
//
// Returns { key: null } when the env var isn't set so the client can
// gracefully fall back to non-map views without erroring.

'use strict';

const express = require('express');
const { requireAuth } = require('../auth');

const router = express.Router();

router.get('/maps-key', requireAuth, (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || null;
  res.json({ key });
});

module.exports = router;
