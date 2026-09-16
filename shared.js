/**
 * Loading the pages' pure modules into Node.
 *
 * `public/pilot.js`, `sonar.js`, `route.js` and the rest are plain browser
 * scripts: they are loaded with `<script src=…>`, they declare their names at
 * the top level of one shared global scope, and `test_globals.mjs` exists to
 * police exactly that. They cannot be ES modules, because a page loads five of
 * them and expects them to see each other.
 *
 * This package is `"type": "module"`, so `require('./public/sonar.js')` does
 * not read the CommonJS tail at the bottom of those files — Node treats the
 * file as ESM, `module` is undefined, the guard is false, and you get an empty
 * object rather than an error. That is a genuinely confusing failure, which is
 * why it is worth one file to never meet it again.
 *
 * So the source is evaluated the same way `test/test_sonar.mjs` has always
 * evaluated it: in a function scope, returning the names asked for. The server
 * and the tests then run the same bytes the browser runs — not a port of them.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const cache = new Map();

/**
 * @param {string|string[]} file   e.g. 'sonar.js' — or several, in the order a
 *                                 page loads them, when one reads another's
 *                                 globals (qrnav.js reads field.js's)
 * @param {string[]} names  the top-level names to hand back
 */
export function loadShared(file, names) {
  const files = Array.isArray(file) ? file : [file];
  const key = `${files.join('+')}:${names.join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const src = files.map((f) => readFileSync(path.join(PUB, f), 'utf8')).join('\n;\n');
  // eslint-disable-next-line no-new-func
  const out = new Function(`${src}\nreturn { ${names.join(', ')} };`)();
  for (const n of names) {
    if (out[n] === undefined) {
      throw new Error(`${file} does not define ${n} at the top level`);
    }
  }
  cache.set(key, out);
  return out;
}
