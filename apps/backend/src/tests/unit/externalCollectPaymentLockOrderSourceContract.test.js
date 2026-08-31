import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const servicesRoot = path.join(sourceRoot, 'services');
const BILLING_V2_BASENAME = 'billingV2Service.js';

function readService(...parts) {
  return fs.readFileSync(path.join(servicesRoot, ...parts), 'utf8');
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectOrdered(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker);
    expect(current).toBeGreaterThan(previous);
    previous = current;
  }
}

function productionFiles(dir = sourceRoot) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && entry.name === 'tests') return [];
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

function walk(node, parent, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, node, visit);
    } else if (value && typeof value === 'object') {
      walk(value, node, visit);
    }
  }
}

function billingV2Module(node) {
  return node?.type === 'Literal'
    && typeof node.value === 'string'
    && node.value.replaceAll('\\', '/').endsWith(`/${BILLING_V2_BASENAME}`);
}

function unwrapExpression(node) {
  let current = node;
  while (current?.type === 'AwaitExpression' || current?.type === 'ChainExpression') {
    // ESTree names these operands differently: AwaitExpression carries
    // `argument`, ChainExpression carries `expression`. Reading `.expression`
    // off an await yielded undefined, so every awaited callee — notably
    // `(await import('./billingV2Service.js')).collectPayment(...)` and
    // `const billing = await import(...)` — resolved to no kind at all and
    // slipped past discovery entirely instead of being enumerated.
    current = current.type === 'AwaitExpression' ? current.argument : current.expression;
  }
  if (current?.type === 'SequenceExpression') {
    return unwrapExpression(current.expressions.at(-1));
  }
  return current;
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal') return String(node.property.value);
  return null;
}

function propertyName(node) {
  if (node?.type !== 'Property') return null;
  if (!node.computed && node.key.type === 'Identifier') return node.key.name;
  if (node.key.type === 'Literal') return String(node.key.value);
  return null;
}

function discoverCollectPaymentCalls(source, file = '<synthetic>') {
  const ast = espree.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    loc: true,
    range: true,
  });
  const nodes = [];
  const parents = new WeakMap();
  walk(ast, null, (node, parent) => {
    nodes.push(node);
    if (parent) parents.set(node, parent);
  });

  for (const node of nodes) {
    if (node.type === 'TemplateLiteral'
        && node.quasis.some((quasi) => (
          quasi.value.cooked || quasi.value.raw
        ).includes(BILLING_V2_BASENAME))) {
      throw new Error(`Noncanonical billingV2Service module reference in ${file}`);
    }
    if (node.type !== 'Literal'
        || typeof node.value !== 'string'
        || !node.value.includes(BILLING_V2_BASENAME)) continue;
    const parent = parents.get(node);
    const canonicalModuleSource = billingV2Module(node)
      && ((parent?.type === 'ImportDeclaration' && parent.source === node)
        || (parent?.type === 'ImportExpression' && parent.source === node)
        || (parent?.type === 'ExportNamedDeclaration' && parent.source === node)
        || (parent?.type === 'ExportAllDeclaration' && parent.source === node));
    if (!canonicalModuleSource) {
      throw new Error(`Noncanonical billingV2Service module reference in ${file}`);
    }
  }

  const directBindings = new Set();
  const namespaceBindings = new Set();
  for (const node of nodes) {
    if (node.type !== 'ImportDeclaration' || !billingV2Module(node.source)) continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaceBindings.add(specifier.local.name);
      } else if (specifier.type === 'ImportSpecifier'
          && (specifier.imported.name || specifier.imported.value) === 'collectPayment') {
        directBindings.add(specifier.local.name);
      }
    }
  }
  for (const node of nodes) {
    if (node.type === 'ExportAllDeclaration' && billingV2Module(node.source)) {
      throw new Error(`Re-exporting billingV2Service can evade caller discovery in ${file}`);
    }
    if (node.type === 'ExportNamedDeclaration' && billingV2Module(node.source)
        && node.specifiers.some((specifier) => (
          specifier.local?.name || specifier.local?.value
        ) === 'collectPayment')) {
      throw new Error(`Re-exporting collectPayment can evade caller discovery in ${file}`);
    }
  }

  const expressionKind = (rawNode) => {
    const node = unwrapExpression(rawNode);
    if (!node) return null;
    if (node.type === 'Identifier') {
      if (directBindings.has(node.name)) return 'direct';
      if (namespaceBindings.has(node.name)) return 'namespace';
    }
    if (node.type === 'MemberExpression'
        && memberName(node) === 'collectPayment'
        && expressionKind(node.object) === 'namespace') {
      return 'direct';
    }
    if (node.type === 'ImportExpression' && billingV2Module(node.source)) return 'namespace';
    return null;
  };

  const bindPattern = (pattern, kind) => {
    if (!kind || !pattern) return false;
    if (pattern.type === 'Identifier') {
      const bindings = kind === 'direct' ? directBindings : namespaceBindings;
      const previousSize = bindings.size;
      bindings.add(pattern.name);
      return bindings.size !== previousSize;
    }
    let changed = false;
    if (pattern.type === 'ObjectPattern' && kind === 'namespace') {
      for (const property of pattern.properties) {
        if (property.type !== 'Property' || propertyName(property) !== 'collectPayment') continue;
        const target = property.value?.type === 'AssignmentPattern'
          ? property.value.left
          : property.value;
        changed = bindPattern(target, 'direct') || changed;
      }
    }
    return changed;
  };

  const aliasPatternIsTracked = (pattern, kind) => {
    if (!pattern || !kind) return false;
    if (pattern.type === 'Identifier') return true;
    if (kind !== 'namespace' || pattern.type !== 'ObjectPattern') return false;
    return pattern.properties.every((property) => {
      if (property.type !== 'Property' || propertyName(property) == null) return false;
      if (propertyName(property) !== 'collectPayment') return true;
      const target = property.value?.type === 'AssignmentPattern'
        ? property.value.left
        : property.value;
      return target?.type === 'Identifier' && directBindings.has(target.name);
    });
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.type === 'VariableDeclarator') {
        changed = bindPattern(node.id, expressionKind(node.init)) || changed;
      } else if (node.type === 'AssignmentExpression' && node.operator === '=') {
        changed = bindPattern(node.left, expressionKind(node.right)) || changed;
      }
    }
  }

  const patternBindingNames = (pattern) => {
    if (!pattern) return [];
    if (pattern.type === 'Identifier') return [pattern.name];
    if (pattern.type === 'AssignmentPattern') return patternBindingNames(pattern.left);
    if (pattern.type === 'RestElement') return patternBindingNames(pattern.argument);
    if (pattern.type === 'ObjectPattern') {
      return pattern.properties.flatMap((property) => property.type === 'RestElement'
        ? patternBindingNames(property.argument)
        : patternBindingNames(property.value));
    }
    if (pattern.type === 'ArrayPattern') {
      return pattern.elements.flatMap((element) => patternBindingNames(element));
    }
    return [];
  };
  const forwardedBinding = (name) => directBindings.has(name) || namespaceBindings.has(name);
  for (const node of nodes) {
    if (node.type === 'ExportDefaultDeclaration'
        && expressionKind(node.declaration)) {
      throw new Error(`Exporting a collectPayment binding can evade caller discovery in ${file}`);
    }
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.specifiers.some((specifier) => specifier.local?.type === 'Identifier'
        && forwardedBinding(specifier.local.name))) {
      throw new Error(`Exporting a collectPayment binding can evade caller discovery in ${file}`);
    }
    if (node.declaration?.type === 'VariableDeclaration'
        && node.declaration.declarations.some((declaration) => patternBindingNames(declaration.id)
          .some(forwardedBinding))) {
      throw new Error(`Exporting a collectPayment binding can evade caller discovery in ${file}`);
    }
  }

  const calls = nodes.filter((node) => node.type === 'CallExpression'
    && expressionKind(node.callee) === 'direct');

  const isAliasUse = (node, parent) => (parent?.type === 'VariableDeclarator'
      && parent.init === node
      && aliasPatternIsTracked(parent.id, expressionKind(node)))
    || (parent?.type === 'AssignmentExpression'
      && parent.right === node
      && parent.left.type === 'Identifier'
      && aliasPatternIsTracked(parent.left, expressionKind(node)));
  const isDeclaration = (node, parent) => parent?.type?.startsWith('Import')
    || (parent?.type === 'VariableDeclarator'
      && parent.id?.range?.[0] <= node.range[0]
      && parent.id?.range?.[1] >= node.range[1])
    || (parent?.type === 'AssignmentExpression' && parent.left === node)
    || (parent?.type === 'Property' && parents.get(parent)?.type === 'ObjectPattern')
    || (parent?.type === 'Property'
      && parent.key === node && !parent.computed && !parent.shorthand);
  const isDirectCalleeUse = (node, parent) => parent?.type === 'CallExpression'
    && unwrapExpression(parent.callee) === node;
  const isStaticNamespaceMemberUse = (node, parent) => parent?.type === 'MemberExpression'
    && unwrapExpression(parent.object) === node
    && memberName(parent) != null
    && memberName(parent) !== 'then';

  for (const node of nodes) {
    const parent = parents.get(node);
    if (node.type === 'Identifier' && directBindings.has(node.name)) {
      if (isDeclaration(node, parent) || isAliasUse(node, parent)
          || isDirectCalleeUse(node, parent)) continue;
      throw new Error(
        `Unsupported indirect collectPayment reference at ${file}:${node.loc.start.line}`,
      );
    }
    if (node.type === 'Identifier' && namespaceBindings.has(node.name)) {
      if (isDeclaration(node, parent) || isAliasUse(node, parent)
          || isStaticNamespaceMemberUse(node, parent)) continue;
      throw new Error(
        `Unsupported indirect billingV2 namespace at ${file}:${node.loc.start.line}`,
      );
    }
    if (node.type === 'MemberExpression'
        && memberName(node) === 'collectPayment'
        && expressionKind(node) === 'direct') {
      if (isAliasUse(node, parent) || isDirectCalleeUse(node, parent)) continue;
      throw new Error(
        `Unsupported indirect collectPayment member at ${file}:${node.loc.start.line}`,
      );
    }
    if (node.type === 'ImportExpression' && billingV2Module(node.source)) {
      let expression = node;
      let expressionParent = parent;
      let awaited = false;
      while (expressionParent?.type === 'AwaitExpression'
          || expressionParent?.type === 'ChainExpression') {
        awaited = awaited || expressionParent.type === 'AwaitExpression';
        expression = expressionParent;
        expressionParent = parents.get(expressionParent);
      }
      const assigned = expressionParent?.type === 'VariableDeclarator'
        && expressionParent.init === expression
        && awaited
        && aliasPatternIsTracked(expressionParent.id, 'namespace');
      const aliased = expressionParent?.type === 'AssignmentExpression'
        && expressionParent.right === expression
        && expressionParent.left.type === 'Identifier'
        && awaited
        && aliasPatternIsTracked(expressionParent.left, 'namespace');
      const staticMember = expressionParent?.type === 'MemberExpression'
        && (expressionParent.object === expression
          || unwrapExpression(expressionParent.object) === node)
        && awaited
        && memberName(expressionParent) === 'collectPayment';
      if (!assigned && !aliased && !staticMember) {
        throw new Error(
          `Unsupported indirect dynamic billingV2 namespace at ${file}:${node.loc.start.line}`,
        );
      }
    }
  }

  return calls.map((call) => {
    const options = call.arguments[1];
    const optionProperties = options?.type === 'ObjectExpression'
      ? options.properties.filter((property) => property.type === 'Property')
      : [];
    const txProperty = optionProperties.find((property) => propertyName(property) === 'tx');
    const leaseProperty = optionProperties.find(
      (property) => propertyName(property) === 'mergeStabilityLease',
    );
    const legacyProperty = optionProperties.find(
      (property) => propertyName(property) === 'mergeStabilityHeld',
    );
    return {
      file,
      line: call.loc.start.line,
      argumentCount: call.arguments.length,
      transaction: Boolean(txProperty),
      hasOpaqueLease: Boolean(leaseProperty
        && leaseProperty.value.type !== 'Literal'
        && leaseProperty.value.type !== 'ObjectExpression'),
      hasLegacyBoolean: Boolean(legacyProperty),
      optionsType: options?.type || null,
    };
  });
}

describe('external collectPayment transaction lock order', () => {
  it('requires the transaction-bound lease before any payment preflight', () => {
    const billing = readService('billing', 'billingV2Service.js');
    const api = sliceBetween(
      billing,
      'export async function collectPayment',
      'function paymentFundingAdvisoryTuple',
    );
    expectOrdered(api, [
      '{ tx = null, mergeStabilityLease = null }',
      'if (tx)',
      'assertTenantPatientMergeStabilityLease(mergeStabilityLease, { tx, tenantId })',
      '// ── Phase 0 — preflight',
      'return collectPaymentTx(tx, args, { mergeStabilityLease })',
    ]);
    expect(api).not.toContain('mergeStabilityHeld');

    const core = sliceBetween(
      billing,
      'async function collectPaymentTx',
      'export async function collectPayment',
    );
    expectOrdered(core, [
      '{ mergeStabilityLease = null }',
      'if (mergeStabilityLease)',
      'assertTenantPatientMergeStabilityLease(mergeStabilityLease',
      'await lockTenantPatientMergeStability(tx, tenant)',
      'findBillingInvoice(',
    ]);
    expect(core).not.toContain('mergeStabilityHeld');
  });

  it('locks patient-merge stability before payment-link authority and passes its lease', () => {
    const paymentLink = readService('billing', 'paymentLinkService.js');
    const reconciliation = sliceBetween(
      paymentLink,
      'export async function markPaymentLinkPaid',
      'export async function cancelPaymentLink',
    );

    expectOrdered(reconciliation, [
      'setTenantTx(tenant',
      'const mergeStabilityLease = await lockTenantPatientMergeStability(tx, tenant)',
      'FROM billing_payment_links',
      'FOR UPDATE',
      'collectPayment({',
      '}, { tx, mergeStabilityLease })',
    ]);
    expect(reconciliation.match(/lockTenantPatientMergeStability\(tx, tenant\)/g))
      .toHaveLength(1);
  });

  it('reuses the counter-sale finalize lease instead of acquiring a late lock', () => {
    const counterSale = readService('pharmacy', 'counterSaleService.js');
    const finalize = sliceBetween(
      counterSale,
      'const result = await setTenantTx(tenant, async (tx) => {',
      "const updated = await tx.$queryRawUnsafe(\n        `UPDATE pharmacy_counter_sales",
    );

    expectOrdered(finalize, [
      'const mergeStabilityLease = await lockTenantPatientMergeStability(tx, tenant)',
      'assertPharmacyFacilityGrant(tx',
      'issueInvoiceTx(tx',
      'collectPayment({',
      '}, { tx, mergeStabilityLease })',
    ]);
    expect(finalize.match(/lockTenantPatientMergeStability\(tx, tenant\)/g))
      .toHaveLength(1);
  });

  it('enumerates every production call, including the namespace route call', () => {
    const calls = productionFiles().flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('billingV2Service.js')) return [];
      const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
      return discoverCollectPaymentCalls(source, relative);
    }).sort((left, right) => left.file.localeCompare(right.file)
      || left.line - right.line);

    expect(calls.map(({ file, transaction }) => ({ file, transaction })))
      .toEqual([
        { file: 'routes/billing/billingV2Routes.js', transaction: false },
        { file: 'services/billing/paymentGatewayService.js', transaction: true },
        { file: 'services/billing/paymentLinkService.js', transaction: true },
        { file: 'services/pharmacy/counterSaleService.js', transaction: true },
      ]);
    for (const call of calls) {
      expect(call.hasLegacyBoolean).toBe(false);
      if (call.transaction) {
        expect(call.argumentCount).toBe(2);
        expect(call.optionsType).toBe('ObjectExpression');
        expect(call.hasOpaqueLease).toBe(true);
      } else {
        expect(call.argumentCount).toBe(1);
      }
    }
  });

  it('detects aliases, namespaces, computed members, and wrapped or non-awaited calls', () => {
    const calls = discoverCollectPaymentCalls(`
      import { collectPayment as bookPayment } from './billingV2Service.js';
      import * as billing from './billingV2Service.js';
      const alias = bookPayment;
      alias({ tenantId: 'a' });
      void billing.collectPayment({ tenantId: 'b' });
      Promise.resolve(billing['collectPayment']({ tenantId: 'c' }));
      (await import('./billingV2Service.js')).collectPayment({ tenantId: 'd' });
    `);

    expect(calls).toHaveLength(4);
  });

  it('fails closed when collectPayment is passed through an uninspected wrapper', () => {
    expect(() => discoverCollectPaymentCalls(`
      import { collectPayment as bookPayment } from './billingV2Service.js';
      const wrapped = withRetry(bookPayment);
      wrapped({ tenantId: 'a' });
    `)).toThrow(/Unsupported indirect collectPayment reference/);
    expect(() => discoverCollectPaymentCalls(`
      export { collectPayment as bookPayment } from './billingV2Service.js';
    `)).toThrow(/Re-exporting collectPayment/);
    expect(() => discoverCollectPaymentCalls(`
      import * as billing from './billingV2Service.js';
      const forwardedBilling = billing;
      export { forwardedBilling };
    `, 'namespace-wrapper.js')).toThrow(/Exporting a collectPayment binding/);
    expect(() => discoverCollectPaymentCalls(`
      import * as billing from './billingV2Service.js';
      registerBillingFacade(billing);
    `, 'namespace-wrapper.js')).toThrow(/Unsupported indirect billingV2 namespace/);
    expect(() => discoverCollectPaymentCalls(`
      import * as billing from './billingV2Service.js';
      const { ...billingCopy } = billing;
      billingCopy.collectPayment({ tenantId: 'a' });
    `, 'namespace-wrapper.js')).toThrow(/Unsupported indirect billingV2 namespace/);
    expect(() => discoverCollectPaymentCalls(`
      import('./billingV2Service.js').then(({ collectPayment }) => {
        collectPayment({ tenantId: 'a' });
      });
    `, 'dynamic-wrapper.js')).toThrow(/Unsupported indirect dynamic billingV2 namespace/);
    expect(() => discoverCollectPaymentCalls(`
      const { ...billingCopy } = await import('./billingV2Service.js');
      billingCopy.collectPayment({ tenantId: 'a' });
    `, 'dynamic-wrapper.js')).toThrow(/Unsupported indirect dynamic billingV2 namespace/);
    expect(() => discoverCollectPaymentCalls(`
      const billingPromise = import('./billingV2Service.js');
      billingPromise.then(({ collectPayment }) => collectPayment({ tenantId: 'a' }));
    `, 'dynamic-wrapper.js')).toThrow(/Unsupported indirect billingV2 namespace|Unsupported indirect dynamic billingV2 namespace/);
    expect(() => discoverCollectPaymentCalls(`
      import(new URL('./billingV2Service.js', import.meta.url));
    `, 'dynamic-wrapper.js')).toThrow(/Noncanonical billingV2Service module reference/);
    expect(() => discoverCollectPaymentCalls(`
      import('./billingV2Service.js?lease-bypass');
    `, 'dynamic-wrapper.js')).toThrow(/Noncanonical billingV2Service module reference/);
    expect(() => discoverCollectPaymentCalls(`
      import(\`./billingV2Service.js\`);
    `, 'dynamic-wrapper.js')).toThrow(/Noncanonical billingV2Service module reference/);
  });
});
