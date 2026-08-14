import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

import { CARE_TEAM_GOVERNED_RECORD_TYPES } from '../../config/careTeamGovernedRecordTypes.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const guardNames = new Set([
  'patientAccessGuard',
  'patientAccessGuardForResource',
  'patientAccessGuardForPaths',
]);

function filesUnder(target) {
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return entry.name.endsWith('.js') ? [child] : [];
  });
}

function isGovernedOptions(node) {
  return node?.type === 'ObjectExpression' && node.properties.some((property) => (
    property.type === 'Property'
    && property.computed === false
    && (property.key.name ?? property.key.value) === 'careTeamModeGoverned'
    && property.value.type === 'Literal'
    && property.value.value === true
  ));
}

function visit(node, file, found, unsupported) {
  if (!node || typeof node !== 'object') return;
  if (
    node.type === 'CallExpression'
    && node.callee?.type === 'Identifier'
    && guardNames.has(node.callee.name)
    && node.arguments.some(isGovernedOptions)
  ) {
    const recordType = node.arguments[0];
    if (recordType?.type === 'Literal' && typeof recordType.value === 'string') {
      found.add(recordType.value);
    } else {
      unsupported.push(`${file}:${node.loc.start.line}`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) value.forEach((child) => visit(child, file, found, unsupported));
    else if (value && typeof value === 'object') visit(value, file, found, unsupported);
  }
}

describe('care-team governed record-type inventory', () => {
  it('exactly matches every governed guard call site', () => {
    const found = new Set();
    const unsupported = [];
    const files = [
      path.join(backendRoot, 'src', 'app.js'),
      ...filesUnder(path.join(backendRoot, 'src', 'routes')),
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const ast = espree.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        loc: true,
      });
      visit(ast, file, found, unsupported);
    }

    expect(unsupported).toEqual([]);
    expect([...found].sort()).toEqual([...CARE_TEAM_GOVERNED_RECORD_TYPES].sort());
  });
});
