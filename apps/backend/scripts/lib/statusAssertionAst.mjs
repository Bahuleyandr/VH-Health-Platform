import { parse } from 'espree';

import { classifyStatusSet } from './statusAssertionPolicy.mjs';

function memberName(node) {
  if (node?.type === 'ChainExpression') return memberName(node.expression);
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed && node.property?.type === 'Literal') return node.property.value;
  return null;
}

function unwrapExpression(node) {
  let current = node;
  while (current?.type === 'ChainExpression') current = current.expression;
  return current;
}

function expressionKey(node, source) {
  if (!node?.range) return null;
  return source.slice(node.range[0], node.range[1]).replace(/\s+/g, '');
}

function isScopeNode(node) {
  return [
    'Program',
    'BlockStatement',
    'StaticBlock',
    'SwitchStatement',
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
  ].includes(node?.type);
}

function collectConstBindings(ast) {
  const byName = new Map();
  visit(ast, [], (node, ancestors) => {
    const declaration = ancestors.at(-1);
    if (
      node.type !== 'VariableDeclarator'
      || node.id?.type !== 'Identifier'
      || declaration?.type !== 'VariableDeclaration'
      || declaration.kind !== 'const'
      || !node.init
    ) return;

    const scope = [...ancestors].reverse().find(isScopeNode);
    if (!scope) return;
    const bindings = byName.get(node.id.name) || [];
    bindings.push({ declaration: node, init: node.init, scope });
    byName.set(node.id.name, bindings);
  });
  return byName;
}

function constBinding(identifier, bindings) {
  if (identifier?.type !== 'Identifier') return null;
  return (bindings.get(identifier.name) || [])
    .filter(({ declaration, scope }) => (
      isWithin(identifier, scope)
      && declaration.range[0] < identifier.range[0]
    ))
    .sort((a, b) => {
      const aSpan = a.scope.range[1] - a.scope.range[0];
      const bSpan = b.scope.range[1] - b.scope.range[0];
      return aSpan - bSpan || b.declaration.range[0] - a.declaration.range[0];
    })[0] || null;
}

function numericValue(node, bindings, seen = new Set()) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Literal' && Number.isFinite(expression.value)) {
    return expression.value;
  }
  if (expression?.type !== 'Identifier') return null;
  const binding = constBinding(expression, bindings);
  if (!binding || seen.has(binding)) return null;
  const nextSeen = new Set(seen).add(binding);
  return numericValue(binding.init, bindings, nextSeen);
}

function numericArray(node, bindings, seen = new Set()) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Identifier') {
    const binding = constBinding(expression, bindings);
    if (!binding || seen.has(binding)) return null;
    return numericArray(binding.init, bindings, new Set(seen).add(binding));
  }
  if (expression?.type !== 'ArrayExpression') return null;
  const codes = expression.elements
    .map((element) => numericValue(element, bindings, seen))
    .filter((code) => code != null);
  return codes.length > 0 ? codes : null;
}

function statusArrayAssertion(node, bindings) {
  if (node?.type !== 'CallExpression' || memberName(node.callee) !== 'toContain') return null;

  const expectCall = node.callee.object;
  if (expectCall?.type === 'MemberExpression' && memberName(expectCall) === 'not') return null;
  if (
    expectCall?.type !== 'CallExpression'
    || expectCall.callee?.type !== 'Identifier'
    || expectCall.callee.name !== 'expect'
  ) return null;

  const codes = numericArray(expectCall.arguments[0], bindings);
  if (!codes) return null;

  return { codes, actual: node.arguments[0] };
}

function isWithin(node, container) {
  return Boolean(
    node?.range
    && container?.range
    && node.range[0] >= container.range[0]
    && node.range[1] <= container.range[1]
  );
}

function comparedSuccess(test, actualKey, source, bindings) {
  if (!test) return null;
  if (test.type === 'LogicalExpression') {
    return comparedSuccess(test.left, actualKey, source, bindings)
      || comparedSuccess(test.right, actualKey, source, bindings);
  }
  if (test.type !== 'BinaryExpression') return null;

  const leftNumber = numericValue(test.left, bindings);
  const rightNumber = numericValue(test.right, bindings);
  if (leftNumber >= 200 && leftNumber < 300 && expressionKey(test.right, source) === actualKey) {
    return { code: leftNumber, operator: test.operator };
  }
  if (rightNumber >= 200 && rightNumber < 300 && expressionKey(test.left, source) === actualKey) {
    return { code: rightNumber, operator: test.operator };
  }
  return null;
}

function includedSuccess(test, actualKey, source, bindings) {
  if (!test) return null;
  if (test.type === 'LogicalExpression') {
    return includedSuccess(test.left, actualKey, source, bindings)
      || includedSuccess(test.right, actualKey, source, bindings);
  }

  const negated = test.type === 'UnaryExpression' && test.operator === '!';
  const expression = unwrapExpression(negated ? test.argument : test);
  if (expression?.type !== 'CallExpression' || memberName(expression.callee) !== 'includes') {
    return null;
  }
  if (expressionKey(expression.arguments[0], source) !== actualKey) return null;
  const codes = numericArray(expression.callee.object, bindings)
    ?.filter((code) => code >= 200 && code < 300);
  return codes?.length ? { codes, negated } : null;
}

function conditionalSuccessCodes(ifNode, assertionNode, actualKey, source, bindings) {
  const comparison = comparedSuccess(ifNode?.test, actualKey, source, bindings);
  if (comparison) {
    if (['!=', '!=='].includes(comparison.operator) && isWithin(assertionNode, ifNode.consequent)) {
      return [comparison.code];
    }
    if (['==', '==='].includes(comparison.operator) && isWithin(assertionNode, ifNode.alternate)) {
      return [comparison.code];
    }
  }

  const included = includedSuccess(ifNode?.test, actualKey, source, bindings);
  if (!included) return null;
  if (included.negated && isWithin(assertionNode, ifNode.consequent)) {
    return included.codes;
  }
  if (!included.negated && isWithin(assertionNode, ifNode.alternate)) {
    return included.codes;
  }
  return null;
}

function hasExemption(source, line) {
  const lines = source.split(/\r?\n/);
  const marker = /\/\/\s*ban-exempt:\s*(\S.*)/;
  return marker.test(lines[line - 1] || '') || marker.test(lines[line - 2] || '');
}

function visit(node, ancestors, callback) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  callback(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (['type', 'loc', 'range', 'start', 'end', 'raw'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, nextAncestors, callback);
    } else {
      visit(value, nextAncestors, callback);
    }
  }
}

export function findMixedStatusAssertions(source) {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    loc: true,
    range: true,
  });
  const bindings = collectConstBindings(ast);
  const findings = [];

  visit(ast, [], (node, ancestors) => {
    const assertion = statusArrayAssertion(node, bindings);
    if (!assertion) return;

    let codes = assertion.codes;
    let policy = classifyStatusSet(codes);
    let kind = 'status_set';

    if (!policy.mixesServerFailure && !policy.mixesAuthOutcome) {
      const actualKey = expressionKey(assertion.actual, source);
      const enclosingIf = [...ancestors].reverse().find((ancestor) => ancestor.type === 'IfStatement');
      const implicitSuccess = conditionalSuccessCodes(enclosingIf, node, actualKey, source, bindings);
      if (implicitSuccess) {
        codes = [...new Set([...implicitSuccess, ...codes])];
        policy = classifyStatusSet(codes);
        kind = 'conditional_split';
      }
    }

    if (!policy.mixesServerFailure && !policy.mixesAuthOutcome) return;
    const line = node.loc.start.line;
    findings.push({
      line,
      codes,
      kind,
      ...policy,
      exempt: hasExemption(source, line),
    });
  });

  return findings;
}
