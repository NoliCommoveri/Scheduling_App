// Lets `node --test` import the Worker.
//
// worker/index.js imports migrations.js, which imports `/migrations/*.sql` as
// text. In production that works because wrangler.toml declares a `[[rules]]`
// Text glob (§3.7.2) and esbuild inlines each file. Node has no such rule, so
// the import fails and the Worker cannot be loaded by a test at all.
//
// This hook does the same job for the test runner: a `.sql` specifier resolves
// to a module whose default export is the file's contents. Deliberately the
// narrowest possible shim — it teaches Node one thing, and that one thing is
// what Wrangler already does.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function load(url, context, next) {
  if (url.endsWith('.sql')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
  }
  return next(url, context);
}
