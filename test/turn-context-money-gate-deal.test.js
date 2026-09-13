// Per-turn context money + tenant gate, DEAL_THREADS=on (production's setting).
// The whole property lives in test/helpers/turn-context-money-gate-suite.js;
// DEAL_THREADS is read once at module load, so each value needs its own file.
'use strict';

require('./helpers/turn-context-money-gate-suite')({ dealThreads: true });
