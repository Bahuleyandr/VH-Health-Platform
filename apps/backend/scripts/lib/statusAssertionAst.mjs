import { parse } from 'espree';

import { classifyStatusSet } from './statusAssertionPolicy.mjs';

function memberName(node) {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed && node.property?.type === 'Literal') return node.property.value;
  return null;
}

function numericLiteral(node) {
  return node?.type === 'Literal' && Number.isFinite(node.value) ? node.value : null;
}

function expressionKey(node, source) {
  if (!node?.range) return null;
  return source.slice(node.range[0], node.range[1]).replace(/\s+/g, '');
}

function statusArrayAssertion(node) {
  if (node?.type !== 'CallExpression' || memberName(node.callee) !== 'toContain') return null;

  const expectCall = node.callee.object;
  if (expectCall?.type === 'MemberExpression' && memberName(expectCall) === 'not') return null;
  if (
    expectCall?.type !== 'CallExpression'
    || expectCall.callee?.type !== 'Identifier'
    || expectCall.callee.name !== 'expect'
  ) return null;

  const array = expectCall.arguments[0];
  if (array?.type !== 'ArrayExpression') return null;
  const codes = array.elements.map(numericLiteral).filter((code) => code != null);
  if (codes.length === 0) return null;

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

function comparedSuccess(test, actualKey, source) {
  if (!test) return null;
  if (test.type === 'LogicalExpression') {
    return comparedSuccess(test.left, actualKey, source)
      || comparedSuccess(test.right, actualKey, source);
  }
  if (test.type !== 'BinaryExpression') return null;

  const leftNumber = numericLiteral(test.left);
  const rightNumber = numericLiteral(test.right);
  if (leftNumber >= 200 && leftNumber < 300 && expressionKey(test.right, source) === actualKey) {
    return { code: leftNumber, operator: test.operator };
  }
  if (rightNumber >= 200 && rightNumber < 300 && expressionKey(test.left, source) === actualKey) {
    return { code: rightNumber, operator: test.operator };
  }
  return null;
}

function conditionalSuccessCode(ifNode, assertionNode, actualKey, source) {
  const comparison = comparedSuccess(ifNode?.test, actualKey, source);
  if (!comparison) return null;

  if (['!=', '!=='].includes(comparison.operator) && isWithin(assertionNode, ifNode.consequent)) {
    return comparison.code;
  }
  if (['==', '==='].includes(comparison.operator) && isWithin(assertionNode, ifNode.alternate)) {
    return comparison.code;
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
  const findings = [];

  visit(ast, [], (node, ancestors) => {
    const assertion = statusArrayAssertion(node);
    if (!assertion) return;

    let codes = assertion.codes;
    let policy = classifyStatusSet(codes);
    let kind = 'status_set';

    if (!policy.mixesServerFailure && !policy.mixesAuthOutcome) {
      const actualKey = expressionKey(assertion.actual, source);
      const enclosingIf = [...ancestors].reverse().find((ancestor) => ancestor.type === 'IfStatement');
      const implicitSuccess = conditionalSuccessCode(enclosingIf, node, actualKey, source);
      if (implicitSuccess != null) {
        codes = [...new Set([implicitSuccess, ...codes])];
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
