import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as espree from 'espree';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAFETY_IMPLEMENTATION = path.join(
  SRC_ROOT,
  'utils',
  'clinical',
  'prescriptionSafetyCheck.js',
);
const SUPPORTED_SAFETY_NAMED_IMPORTS = new Set([
  'checkAntithromboticInteractions',
  'loadActiveTherapySnapshot',
  'validatePrescriptionSafety',
]);

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);
    const entry = statSync(child);
    if (entry.isDirectory()) {
      if (name === 'node_modules' || name === 'tests') continue;
      filesUnder(child, out);
    } else if (name.endsWith('.js')) {
      out.push(child);
    }
  }
  return out;
}

function visit(node, parent, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, node, visitor));
    } else if (value && typeof value === 'object') {
      visit(value, node, visitor);
    }
  }
}

function propertyName(property) {
  if (property?.type !== 'Property' || property.computed) return null;
  return property.key?.name ?? property.key?.value ?? null;
}

function hasExplicitTenantId(options) {
  if (options?.type !== 'ObjectExpression') return false;
  let tenantPropertyIndex = -1;
  for (let index = 0; index < options.properties.length; index += 1) {
    if (propertyName(options.properties[index]) === 'tenantId') tenantPropertyIndex = index;
  }
  if (tenantPropertyIndex < 0) return false;
  return !options.properties.slice(tenantPropertyIndex + 1).some((property) => (
    property.type === 'SpreadElement' || property.computed === true
  ));
}

function isSafetyModuleSource(value) {
  return typeof value === 'string'
    && /(?:^|\/)prescriptionSafetyCheck\.js$/.test(value.replace(/\\/g, '/'));
}

function isNonReferenceIdentifier(node, parent) {
  if (!parent) return false;
  if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(parent.type)) {
    return true;
  }
  if (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) {
    return true;
  }
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
    return true;
  }
  if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) {
    return true;
  }
  return false;
}

function analyzeSource(source, file) {
  const ast = espree.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    loc: true,
  });
  const bindings = new Map();
  const violations = [];

  for (const statement of ast.body) {
    if (statement.type === 'ImportDeclaration') {
      const moduleSource = statement.source?.value;
      for (const specifier of statement.specifiers) {
        if (!isSafetyModuleSource(moduleSource)) continue;
        if (specifier.type !== 'ImportSpecifier') {
          violations.push(
            `${file}:${specifier.loc.start.line} unsupported default/namespace prescription-safety import`,
          );
          continue;
        }
        const importedName = specifier.imported?.name ?? specifier.imported?.value;
        if (!SUPPORTED_SAFETY_NAMED_IMPORTS.has(importedName)) {
          violations.push(
            `${file}:${specifier.loc.start.line} unsupported named prescription-safety import`,
          );
          continue;
        }
        if (importedName === 'validatePrescriptionSafety') {
          bindings.set(specifier.local.name, {
            line: specifier.loc.start.line,
            calls: 0,
          });
        }
      }
    }
    if (statement.type === 'ExportNamedDeclaration' && isSafetyModuleSource(statement.source?.value)) {
      violations.push(
        `${file}:${statement.loc.start.line} unsupported prescription-safety re-export`,
      );
    }
    if (statement.type === 'ExportAllDeclaration' && isSafetyModuleSource(statement.source?.value)) {
      violations.push(
        `${file}:${statement.loc.start.line} unsupported prescription-safety export-all`,
      );
    }
  }

  const directCallees = new Set();
  visit(ast, null, (node, parent) => {
    if (node.type === 'ImportExpression' && isSafetyModuleSource(node.source?.value)) {
      violations.push(`${file}:${node.loc.start.line} unsupported dynamic prescription-safety import`);
    }
    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && node.callee.name === 'require'
      && isSafetyModuleSource(node.arguments[0]?.value)
    ) {
      violations.push(`${file}:${node.loc.start.line} unsupported require prescription-safety import`);
    }
    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && bindings.has(node.callee.name)
    ) {
      directCallees.add(node.callee);
      const binding = bindings.get(node.callee.name);
      binding.calls += 1;
      if (node.optional) {
        violations.push(`${file}:${node.loc.start.line} unsupported optional prescription-safety call`);
      } else if (node.arguments.length < 3) {
        violations.push(`${file}:${node.loc.start.line} prescription-safety call has fewer than three arguments`);
      } else if (!hasExplicitTenantId(node.arguments[2])) {
        violations.push(
          `${file}:${node.loc.start.line} prescription-safety options must be an object with explicit tenantId`,
        );
      }
    }
    if (
      node.type === 'Identifier'
      && bindings.has(node.name)
      && !directCallees.has(node)
      && !isNonReferenceIdentifier(node, parent)
    ) {
      violations.push(
        `${file}:${node.loc.start.line} prescription-safety import must be called directly`,
      );
    }
  });

  for (const [name, binding] of bindings) {
    if (binding.calls === 0) {
      violations.push(`${file}:${binding.line} imported ${name} has no supported direct call`);
    }
  }

  return {
    callCount: [...bindings.values()].reduce((count, binding) => count + binding.calls, 0),
    violations: [...new Set(violations)],
  };
}

describe('prescription-safety tenant-authority source contract', () => {
  test('detector accepts explicit tenant authority and rejects unsupported call shapes', () => {
    const valid = analyzeSource(
      `import {
         checkAntithromboticInteractions,
         validatePrescriptionSafety as validate,
       } from './prescriptionSafetyCheck.js';
       checkAntithromboticInteractions(medications);
       await validate(patientId, medications, { ...defaults, db, tenantId });`,
      'valid.js',
    );
    expect(valid).toEqual({ callCount: 1, violations: [] });

    const unrelated = analyzeSource(
      `export * from './unrelated.js';
       import { default as safety, validatePrescriptionSafety } from './unrelated.js';
       safety.validatePrescriptionSafety(patientId, medications);
       validatePrescriptionSafety(patientId, medications);`,
      'unrelated.js',
    );
    expect(unrelated).toEqual({ callCount: 0, violations: [] });

    for (const invalidSource of [
      `import { validatePrescriptionSafety } from './prescriptionSafetyCheck.js';
       validatePrescriptionSafety(patientId, medications);`,
      `import { validatePrescriptionSafety } from './prescriptionSafetyCheck.js';
       validatePrescriptionSafety(patientId, medications, options);`,
      `import { validatePrescriptionSafety } from './prescriptionSafetyCheck.js';
       validatePrescriptionSafety(patientId, medications, { tenantId, ...options });`,
      `import { validatePrescriptionSafety } from './prescriptionSafetyCheck.js';
       const delegated = validatePrescriptionSafety; delegated(patientId, medications, { tenantId });`,
      `import * as safety from './prescriptionSafetyCheck.js';
       safety.validatePrescriptionSafety(patientId, medications, { tenantId });`,
      `import { default as safety } from './prescriptionSafetyCheck.js';
       safety.validatePrescriptionSafety(patientId, medications, { tenantId });`,
      `import { unknownSafetyExport } from './prescriptionSafetyCheck.js';
       unknownSafetyExport(patientId, medications, { tenantId });`,
      `export * from './prescriptionSafetyCheck.js';`,
    ]) {
      expect(analyzeSource(invalidSource, 'invalid.js').violations.length).toBeGreaterThan(0);
    }
  });

  test('every production import calls prescription safety with explicit tenant authority', () => {
    const violations = [];
    let callCount = 0;
    for (const file of filesUnder(SRC_ROOT)) {
      if (path.resolve(file) === path.resolve(SAFETY_IMPLEMENTATION)) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('validatePrescriptionSafety') && !source.includes('prescriptionSafetyCheck.js')) {
        continue;
      }
      const relativeFile = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
      const result = analyzeSource(source, relativeFile);
      callCount += result.callCount;
      violations.push(...result.violations);
    }

    expect(callCount).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
