// apps/backend/src/tests/unit/exposureHandlerBootstrap.test.js
//
// The blood-borne exposure fan-out is only real in a process that has imported
// the handler owners: `registerExposureHandler(quarantineDevicesExposedToPatient)`
// is a MODULE-LOAD side effect at the bottom of cathDeviceReuseService.js. In
// the API process the cath route files pull it in; the reconciliation sweep's
// script did not, so it repaired REACTIVE markers into a process whose handler
// set was empty — the marker landed, `notifyExposureHandlers` iterated nothing,
// and the cath devices used on that patient were never quarantined, while the
// sweep reported a clean repair.
//
// services/clinical/exposureHandlerBootstrap.js exists to make that
// registration explicit. These cases pin the three things that can rot:
//   1. importing the bootstrap really does register a handler;
//   2. the bootstrap imports EVERY module in the tree that registers one, so a
//      second owner added later cannot be silently left out;
//   3. the two entry points that need it — src/app.js and the sweep script —
//      still import it. Deleting the import from the script is the mutation
//      this file is calibrated against.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../..');
const SRC = path.join(BACKEND, 'src');

const BOOTSTRAP_PATH = path.join(SRC, 'services/clinical/exposureHandlerBootstrap.js');
const SCRIPT_PATH = path.join(BACKEND, 'scripts/reconcile-bloodborne-markers.mjs');
const APP_PATH = path.join(SRC, 'app.js');
const WWW_PATH = path.join(SRC, 'bin', 'www.js');
const REGISTRY_PATH = path.join(SRC, 'services/clinical/bloodborneMarkerRules.js');

const read = (file) => fs.readFileSync(file, 'utf8');

// Line comments and the named import both NAME the registrar without calling
// it, so neither may count as ownership.
function executableSource(file) {
  return read(file)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/import\s*\{[\s\S]*?\}\s*from[^;]+;/g, '');
}

// Every production module whose module body CALLS registerExposureHandler.
// This is the `grep -rn 'registerExposureHandler(' src/` the bootstrap's header
// names as its authority, run as an assertion instead of as advice — the tests
// tree, the registry module that DEFINES the function, and the bootstrap that
// merely imports the owners are excluded.
function registrationOwners(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'node_modules') continue;
      registrationOwners(full, found);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    if (full === REGISTRY_PATH || full === BOOTSTRAP_PATH) continue;
    if (/(^|[^.\w])registerExposureHandler\(/m.test(executableSource(full))) {
      found.push(full);
    }
  }
  return found;
}

describe('exposure handler bootstrap', () => {
  test('importing it registers at least one exposure handler', async () => {
    // Order matters and cannot be rearranged: the registry is cleared BEFORE
    // the bootstrap's first import in this module registry, so the count that
    // follows was produced by that import and not by some earlier one. Jest
    // gives each test file its own module registry, and nothing above imports
    // the bootstrap.
    const registry = await import('../../services/clinical/bloodborneMarkerRules.js');
    registry.__clearExposureHandlersForTests();
    expect(registry.exposureHandlerCount()).toBe(0);

    const bootstrap = await import('../../services/clinical/exposureHandlerBootstrap.js');

    expect(bootstrap.exposureHandlerCount()).toBeGreaterThanOrEqual(1);
    // The bootstrap reports the registry's own count, not a count of its
    // imports — a module that imported an owner which had stopped registering
    // would otherwise still claim to be wired.
    expect(bootstrap.exposureHandlerCount()).toBe(registry.exposureHandlerCount());
  }, 60000);

  test('it imports every module in the tree that registers a handler', () => {
    const owners = registrationOwners();
    // If this is ever 0 the assertion below becomes vacuous, so state the
    // expectation about the tree itself.
    expect(owners.length).toBeGreaterThanOrEqual(1);
    expect(owners.map((file) => path.basename(file)).sort())
      .toEqual(['cathDeviceReuseService.js']);

    const bootstrap = read(BOOTSTRAP_PATH);
    for (const owner of owners) {
      expect(bootstrap).toContain(`./${path.basename(owner)}`);
    }
  });

  test('the sweep script imports the bootstrap before it can repair anything', () => {
    const script = read(SCRIPT_PATH);
    expect(script).toContain('services/clinical/exposureHandlerBootstrap.js');
    // Ahead of the service that does the repairing, so the count is knowable
    // before the first write — an import that landed after would still
    // register, but the ordering is the documented contract and the thing a
    // careless reorder would break.
    expect(script.indexOf('exposureHandlerBootstrap.js'))
      .toBeLessThan(script.indexOf('bloodborneMarkerReconciliationService.js'));
    // ...and it refuses to write when the count is still zero.
    expect(script).toContain('exposureHandlerCount()');
    expect(script).toContain('--allow-no-handlers');
    expect(script).toMatch(/EXIT_NO_EXPOSURE_HANDLERS\s*=\s*2/);
  });

  test('src/app.js imports the bootstrap, so the API process is not route-dependent', () => {
    expect(read(APP_PATH)).toContain("import './services/clinical/exposureHandlerBootstrap.js';");
  });

  test('src/bin/www.js refuses to listen when the registry is empty, measured without registering', () => {
    const www = read(WWW_PATH);
    // The guard reads the registry directly. Importing the bootstrap here would
    // register the handlers itself and make the check a tautology.
    expect(www).toContain("import { exposureHandlerCount } from '../services/clinical/bloodborneMarkerRules.js';");
    const bootstrapImportLines = www
      .split(String.fromCharCode(10))
      .filter((line) => line.startsWith('import ') && line.includes('exposureHandlerBootstrap'));
    expect(bootstrapImportLines).toEqual([]);
    // ...and the refusal sits BEFORE listen, inside the startup promise so the
    // existing 'startup failed before listen' catch turns it into exit(1).
    const guard = www.indexOf('registeredExposureHandlers === 0');
    const listenAt = www.indexOf('server.listen(PORT);');
    expect(guard).toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(guard);
    expect(www).toContain("err.code = 'EXPOSURE_HANDLERS_MISSING';");
  });
});
