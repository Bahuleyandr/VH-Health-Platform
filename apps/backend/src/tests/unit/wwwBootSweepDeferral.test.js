// src/tests/unit/wwwBootSweepDeferral.test.js
//
// bin/www.js starts an HTTP server as an import side effect, so its boot
// ordering cannot be exercised by importing it. It is pinned here by parsing
// the module with a real ES parser and asserting on the call graph.
//
// The property under test comes straight from the 2026-09-09 06:40Z incident:
// the boot-time scheduler sweep used to be awaited inside prepareApplication(),
// i.e. BEFORE server.listen(), so it delayed the listener and then overlapped
// the freshly registered cron roster. It must now be scheduled from the
// listening path, deferred, and cancellable by graceful shutdown — with the
// pre-existing "stop crons before Prisma disconnects" ordering left intact.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW_PATH = path.resolve(__dirname, '../../bin/www.js');
const source = fs.readFileSync(WWW_PATH, 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') { return; }
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') { continue; }
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((child) => walk(child, visit));
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

function functionNamed(name) {
  let found = null;
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) { found = node; }
  });
  return found;
}

/** Every callee name (`f()` and `o.f()`) reachable inside `node`. */
function calleeNamesIn(node) {
  const names = [];
  walk(node, (child) => {
    if (child.type !== 'CallExpression') { return; }
    const callee = child.callee;
    if (callee?.type === 'Identifier') { names.push(callee.name); }
    if (callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
      names.push(callee.property.name);
    }
  });
  return names;
}

/** Source offset of the first call to `name` inside `node`, or -1. */
function firstCallOffset(node, name) {
  let offset = -1;
  walk(node, (child) => {
    if (child.type !== 'CallExpression') { return; }
    const callee = child.callee;
    const calleeName = callee?.type === 'Identifier'
      ? callee.name
      : callee?.property?.name;
    if (calleeName === name && (offset === -1 || child.range[0] < offset)) {
      offset = child.range[0];
    }
  });
  return offset;
}

describe('bin/www.js boot sweep deferral', () => {
  const prepareApplication = functionNamed('prepareApplication');
  const onListening = functionNamed('onListening');
  const gracefulShutdown = functionNamed('gracefulShutdown');

  it('finds the three boot functions it pins', () => {
    expect(prepareApplication).not.toBeNull();
    expect(onListening).not.toBeNull();
    expect(gracefulShutdown).not.toBeNull();
  });

  it('does not run the scheduler roster from prepareApplication, before listen', () => {
    const names = calleeNamesIn(prepareApplication);
    // Population guard: prepareApplication is a long function; an empty call
    // list would mean the walker is broken, not that the sweep is gone.
    expect(names.length).toBeGreaterThan(5);
    expect(names).not.toContain('runAllScheduledTasksNow');
    expect(names).not.toContain('scheduleDeferredBootRun');
  });

  it('still imports scheduler.js from prepareApplication, behind the boot gates', () => {
    const body = source.slice(prepareApplication.range[0], prepareApplication.range[1]);
    expect(body).toContain("import('../utils/scheduler.js')");
  });

  it('schedules the deferred sweep from the listening path', () => {
    const names = calleeNamesIn(onListening);
    expect(names).toContain('scheduleDeferredBootRun');
    const body = source.slice(onListening.range[0], onListening.range[1]);
    expect(body).toContain('runAllScheduledTasksNow');
    expect(body).toContain('stepDelayMs');
  });

  it('imports the deferral helpers from the pacing module', () => {
    const imported = new Set();
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration'
        && node.source.value === '../utils/schedulerBootPacing.js') {
        for (const spec of node.specifiers) { imported.add(spec.imported?.name || spec.local.name); }
      }
    }
    expect([...imported].sort()).toEqual(['resolveBootRunStepDelayMs', 'scheduleDeferredBootRun']);
  });

  it('cancels the deferred sweep on graceful shutdown, before stopping the crons', () => {
    const body = source.slice(gracefulShutdown.range[0], gracefulShutdown.range[1]);
    expect(body).toContain('bootRunBox.handle?.cancel()');

    const cancelAt = body.indexOf('bootRunBox.handle?.cancel()');
    const stopAt = body.indexOf('stopAllScheduledTasks()');
    expect(stopAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(stopAt);
  });

  it('keeps stopping cron tasks before Prisma disconnects', () => {
    const stopAt = firstCallOffset(gracefulShutdown, 'stopAllScheduledTasks');
    const disconnectAt = firstCallOffset(gracefulShutdown, '$disconnect');
    expect(stopAt).toBeGreaterThan(-1);
    expect(disconnectAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(disconnectAt);
  });
});
