/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/browser-fn.js — drive a function out of a browser script.
 *
 * js/jobs.js and its neighbours are multi-thousand-line browser scripts with
 * no module seam. The alternative to this is a test that models what the
 * function does, and a model of buggy code is green the whole time the bug is
 * live — which is exactly how the job-info card shipped a save that rewrote
 * the project manager. So the function's TEXT is lifted out and evaluated with
 * its free variables injected: anything that changes inside it changes what
 * the test runs.
 *
 *   const src = extractFunction(fs.readFileSync('js/jobs.js', 'utf8'), 'toggleEditJobInfo');
 *   const fn  = compile([src], ['appData', 'document'], [appData, document], 'toggleEditJobInfo');
 *
 * Brace-counting is deliberate and sufficient here: it fails loudly (an
 * unbalanced count, or a SyntaxError out of new Function) rather than
 * silently returning something that looks like a function.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('extractFunction: no function ' + name);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('extractFunction: unbalanced braces in ' + name);
}

/* Evaluate the given function sources together and hand back one of them. */
function compile(sources, paramNames, paramValues, returnName) {
  const factory = new Function(...paramNames, sources.join('\n') + '\nreturn ' + returnName + ';');
  return factory(...paramValues);
}

module.exports = { extractFunction, compile };
