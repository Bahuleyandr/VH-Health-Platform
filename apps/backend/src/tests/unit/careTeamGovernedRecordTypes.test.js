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
// routePatientGuard (middleware/routePatientAccessGuards.js) is a factory that
// sets careTeamModeGoverned: true UNCONDITIONALLY, so its call sites are
// governed without carrying the flag in their own options — the 2026-08 lane
// that moved 17 mount guards in-router declares ICU/DIALYSIS/ANESTHESIA_CHART/
// OPERATING_THEATRE through it, and the scan went blind to all four until it
// learned the factory. If the factory ever grows a way to pass
// careTeamModeGoverned: false, this constant must become a per-call check.
const alwaysGovernedFactories = new Set(['routePatientGuard']);

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

function stringConstsOf(ast) {
  const consts = new Map();
  for (const stmt of ast.body ?? []) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type !== 'VariableDeclaration' || decl.kind !== 'const') continue;
    for (const d of decl.declarations) {
      if (
        d.id?.type === 'Identifier'
        && d.init?.type === 'Literal'
        && typeof d.init.value === 'string'
      ) {
        consts.set(d.id.name, d.init.value);
      }
    }
  }
  return consts;
}

function visit(node, file, found, unsupported, consts) {
  if (!node || typeof node !== 'object') return;
  if (
    node.type === 'CallExpression'
    && node.callee?.type === 'Identifier'
    && (
      (guardNames.has(node.callee.name) && node.arguments.some(isGovernedOptions))
      || alwaysGovernedFactories.has(node.callee.name)
    )
  ) {
    const recordType = node.arguments[0];
    if (recordType?.type === 'Literal' && typeof recordType.value === 'string') {
      found.add(recordType.value);
    } else if (
      recordType?.type === 'Identifier'
      && consts?.has(recordType.name)
    ) {
      found.add(consts.get(recordType.name));
    } else {
      unsupported.push(`${file}:${node.loc.start.line}`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) value.forEach((child) => visit(child, file, found, unsupported, consts));
    else if (value && typeof value === 'object') visit(value, file, found, unsupported, consts);
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
      // Guard modules name their record type once (const CATH_RECORD_TYPE =
      // 'CLINICAL_WORKFLOW') and pass the identifier to every factory call.
      // Resolving module-level string consts keeps those sites countable
      // while anything genuinely dynamic still lands in `unsupported`.
      const consts = stringConstsOf(ast);
      visit(ast, file, found, unsupported, consts);
    }

    expect(unsupported).toEqual([]);
    expect([...found].sort()).toEqual([...CARE_TEAM_GOVERNED_RECORD_TYPES].sort());
  });
});
