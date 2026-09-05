/**
 * STRUCTURAL PIN for the outside-laboratory escape.
 *
 * A lab_results row with no in-house order behind it, naming an outside
 * laboratory, is a real clinical exception: the pre-cath checklist has to be
 * able to file the report a patient brings in from another lab, and manual
 * entry requires an order such a report will never have. Everything else that
 * writes a result goes through an order.
 *
 * That used to be enforced by a boolean — recordResultManual took
 * `allowUnlinkedExternal`, and "only the cath checklist passes it" was a fact
 * about the call graph, not about the code. Nothing failed when a new caller
 * copied a call and flipped the flag; a reviewer noticing was the only guard.
 *
 * It is a separate entry point now (recordExternalLabResultRow, which no route
 * imports), and this suite is the second half of that: the set of SHIPPING
 * modules that so much as name it is pinned. A new caller fails here, and
 * whoever adds it has to argue for it in a diff a reviewer reads.
 *
 * Textual on purpose. It scans source, so it catches the import that is not
 * wired up yet, a re-export that would widen the surface, and a dynamic
 * `await import(...)` — none of which a runtime assertion on the module object
 * would see.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// The internal entry point, and the flag it replaced.
const ENTRY_POINT = 'recordExternalLabResultRow';
const RETIRED_FLAG = 'allowUnlinkedExternal';

// Where the escape may appear in shipping code, as repo-relative POSIX paths:
// the module that DEFINES it, and the one permitted caller. Deliberately a
// literal list, not a prefix or a glob — a second clinical service that "also
// needs" an outside result has to be added here by hand.
const ALLOWED_SHIPPING = Object.freeze([
  'services/clinical/cathLabReadinessService.js',
  'services/lab/labResultsService.js',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', 'generated']);

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

// COMMENTS DO NOT COUNT. The rule is about what the code can REACH, and both
// names are deliberately discussed in prose elsewhere — the origin guard's
// header has to be able to say which entry point it is the route-level half of.
// Only whole comment lines and block comments are dropped, never a trailing
// `//` on a line of code, so a call can never be stripped away with a note
// beside it.
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

const FILES = sourceFiles(SRC_ROOT).map((full) => ({
  path: relative(SRC_ROOT, full).split(sep).join('/'),
  text: withoutComments(readFileSync(full, 'utf8')),
}));

// Tests are not the shipping graph: a suite may drive either entry point, and a
// new deep test for the cath path must not have to edit a list here.
const isTest = (path) => path.startsWith('tests/');

describe('the outside-lab entry point is reachable from exactly one module', () => {
  test('the scan actually found the source tree', () => {
    // A pin that silently scans nothing passes forever. Two anchors: a healthy
    // file count, and the defining module being among what was read.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.some((file) => file.path === 'services/lab/labResultsService.js')).toBe(true);
  });

  test(`exactly ${ALLOWED_SHIPPING.length} shipping modules name ${ENTRY_POINT}`, () => {
    const naming = FILES
      .filter((file) => file.text.includes(ENTRY_POINT))
      .map((file) => file.path)
      .filter((path) => !isTest(path))
      .sort();
    expect(naming).toEqual([...ALLOWED_SHIPPING].sort());
  });

  test('no route, middleware or job reaches it', () => {
    const reachable = FILES
      .filter((file) => /^(routes|middleware|jobs|workers|controllers)\//.test(file.path))
      .filter((file) => file.text.includes(ENTRY_POINT))
      .map((file) => file.path);
    expect(reachable).toEqual([]);
  });

  test(`no shipping module still passes ${RETIRED_FLAG}`, () => {
    // It was an OPTION on the public entry point, so any caller could set it.
    // If it reappears in shipping code the structural gate is decoration. The
    // deep suite still passes it deliberately, to prove it is now inert.
    const survivors = FILES
      .filter((file) => file.text.includes(RETIRED_FLAG))
      .map((file) => file.path)
      .filter((path) => !isTest(path))
      .sort();
    expect(survivors).toEqual([]);
  });

  test('the public entry point cannot ask for an external origin', () => {
    // Comment-stripped, so these match declarations rather than prose.
    const service = FILES.find((file) => file.path === 'services/lab/labResultsService.js').text;
    const signature = /export async function recordResultManual\(\{([\s\S]*?)\n\}\)/.exec(service);
    expect(signature).not.toBeNull();
    // No parameter of its own names an external origin -- case-INSENSITIVELY,
    // because `isExternal`, `allowExternal` and `externalLabName` are exactly
    // the shapes such a parameter would take, and a case-sensitive /external/
    // reads straight past the first two.
    expect(signature[1]).not.toMatch(/external/i);
    // ...and what it forwards to the shared implementation closes it explicitly
    // rather than relying on the default.
    const call = /export async function recordResultManual\([\s\S]*?\n\}\)\s*\{([\s\S]*?)\n\}/
      .exec(service);
    expect(call[1]).toMatch(/external:\s*false/);
  });
});
