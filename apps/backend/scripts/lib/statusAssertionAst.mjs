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
  if (current?.type === 'SequenceExpression') {
    return unwrapExpression(current.expressions.at(-1));
  }
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
    'CatchClause',
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
  ].includes(node?.type);
}

function isFunctionNode(node) {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
  ].includes(node?.type);
}

function patternIdentifiers(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern];
  if (pattern.type === 'AssignmentPattern') return patternIdentifiers(pattern.left);
  if (pattern.type === 'RestElement') return patternIdentifiers(pattern.argument);
  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.flatMap(patternIdentifiers);
  }
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) => (
      property.type === 'RestElement'
        ? patternIdentifiers(property.argument)
        : patternIdentifiers(property.value)
    ));
  }
  return [];
}

function parameterBindings(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [{ identifier: pattern, value: null }];
  if (pattern.type === 'AssignmentPattern') {
    if (pattern.left?.type === 'Identifier') {
      return [{ identifier: pattern.left, value: pattern.right }];
    }
    return parameterBindings(pattern.left);
  }
  if (pattern.type === 'RestElement') return parameterBindings(pattern.argument);
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(parameterBindings);
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) => (
      property.type === 'RestElement'
        ? parameterBindings(property.argument)
        : parameterBindings(property.value)
    ));
  }
  return [];
}

function bindingFor(identifier, bindings) {
  if (identifier?.type !== 'Identifier') return null;
  return (bindings.get(identifier.name) || [])
    .filter(({ scope }) => isWithin(identifier, scope))
    .sort((a, b) => {
      const aSpan = a.scope.range[1] - a.scope.range[0];
      const bSpan = b.scope.range[1] - b.scope.range[0];
      return aSpan - bSpan;
    })[0] || null;
}

function collectBindings(ast) {
  const byName = new Map();

  function register(identifier, scope, value) {
    if (identifier?.type !== 'Identifier' || !scope) return;
    const namedBindings = byName.get(identifier.name) || [];
    let binding = namedBindings.find((candidate) => candidate.scope === scope);
    if (!binding) {
      binding = { scope, values: [], additions: [] };
      namedBindings.push(binding);
      byName.set(identifier.name, namedBindings);
    }
    if (value) binding.values.push(value);
  }

  visit(ast, [], (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (node.type === 'VariableDeclarator' && parent?.type === 'VariableDeclaration') {
      const scope = parent.kind === 'var'
        ? [...ancestors].reverse().find((ancestor) => (
          isFunctionNode(ancestor) || ancestor.type === 'Program'
        ))
        : [...ancestors].reverse().find(isScopeNode);
      for (const identifier of patternIdentifiers(node.id)) {
        register(identifier, scope, node.id.type === 'Identifier' ? node.init : null);
      }
      return;
    }

    if (isFunctionNode(node)) {
      for (const parameter of node.params) {
        for (const { identifier, value } of parameterBindings(parameter)) {
          register(identifier, node, value);
        }
      }
      if (node.type === 'FunctionExpression' && node.id) register(node.id, node, null);
      if (node.type === 'FunctionDeclaration' && node.id) {
        const outerScope = [...ancestors].reverse().find(isScopeNode);
        register(node.id, outerScope, null);
      }
      return;
    }

    if (node.type === 'CatchClause') {
      for (const identifier of patternIdentifiers(node.param)) register(identifier, node, null);
      return;
    }

    if (node.type === 'ClassDeclaration' && node.id) {
      const scope = [...ancestors].reverse().find(isScopeNode);
      register(node.id, scope, null);
      return;
    }

    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers) register(specifier.local, ast, null);
    }
  });

  visit(ast, [], (node) => {
    if (
      node.type === 'AssignmentExpression'
      && ['=', '&&=', '||=', '??='].includes(node.operator)
    ) {
      if (node.left?.type === 'Identifier') {
        const binding = bindingFor(node.left, byName);
        if (binding) binding.values.push(node.right);
        return;
      }
      if (
        node.operator === '='
        && node.left?.type === 'MemberExpression'
        && memberName(node.left) !== 'length'
      ) {
        const target = unwrapExpression(node.left.object);
        const binding = bindingFor(target, byName);
        if (binding) binding.additions.push(node.right);
      }
      return;
    }

    if (node.type !== 'CallExpression') return;
    const callee = unwrapExpression(node.callee);
    const mutation = memberName(callee);
    if (!['push', 'unshift', 'splice'].includes(mutation)) return;
    const target = unwrapExpression(callee.object);
    const binding = bindingFor(target, byName);
    if (!binding) return;
    const additions = mutation === 'splice' ? node.arguments.slice(2) : node.arguments;
    binding.additions.push(...additions);
  });

  function directAliasBindings(expression) {
    const node = unwrapExpression(expression);
    if (node?.type === 'Identifier') {
      const binding = bindingFor(node, byName);
      return binding ? [binding] : [];
    }
    if (node?.type === 'ConditionalExpression') {
      return [
        ...directAliasBindings(node.consequent),
        ...directAliasBindings(node.alternate),
      ];
    }
    if (node?.type === 'LogicalExpression') {
      return [...directAliasBindings(node.left), ...directAliasBindings(node.right)];
    }
    if (node?.type === 'AssignmentExpression') return directAliasBindings(node.right);
    return [];
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of [...byName.values()].flat()) {
      if (!binding.additions.length) continue;
      const targets = binding.values.flatMap(directAliasBindings);
      for (const target of targets) {
        for (const addition of binding.additions) {
          if (target.additions.includes(addition)) continue;
          target.additions.push(addition);
          changed = true;
        }
      }
    }
  }

  return byName;
}

function numericValues(node, bindings, seen = new Set()) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Literal' && Number.isFinite(expression.value)) {
    return [expression.value];
  }
  if (expression?.type === 'ConditionalExpression') {
    return [...new Set([
      ...numericValues(expression.consequent, bindings, seen),
      ...numericValues(expression.alternate, bindings, seen),
    ])];
  }
  if (expression?.type === 'LogicalExpression') {
    return [...new Set([
      ...numericValues(expression.left, bindings, seen),
      ...numericValues(expression.right, bindings, seen),
    ])];
  }
  if (expression?.type === 'AssignmentExpression') {
    return numericValues(expression.right, bindings, seen);
  }
  if (expression?.type !== 'Identifier') return [];
  const binding = bindingFor(expression, bindings);
  if (!binding || seen.has(binding)) return [];
  const nextSeen = new Set(seen).add(binding);
  return [...new Set(binding.values.flatMap((value) => numericValues(value, bindings, nextSeen)))];
}

function numericArray(node, bindings, seen = new Set()) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'ConditionalExpression' || expression?.type === 'LogicalExpression') {
    const branches = expression.type === 'ConditionalExpression'
      ? [expression.consequent, expression.alternate]
      : [expression.left, expression.right];
    const codes = branches.flatMap((branch) => numericArray(branch, bindings, seen) || []);
    return codes.length > 0 ? [...new Set(codes)] : null;
  }
  if (expression?.type === 'AssignmentExpression') {
    return numericArray(expression.right, bindings, seen);
  }
  if (expression?.type === 'Identifier') {
    const binding = bindingFor(expression, bindings);
    if (!binding || seen.has(binding)) return null;
    const nextSeen = new Set(seen).add(binding);
    const codes = [
      ...binding.values.flatMap((value) => numericArray(value, bindings, nextSeen) || []),
      ...binding.additions.flatMap((value) => (
        value.type === 'SpreadElement'
          ? numericArray(value.argument, bindings, nextSeen) || []
          : numericValues(value, bindings, nextSeen)
      )),
    ];
    return codes.length > 0 ? [...new Set(codes)] : null;
  }
  if (expression?.type === 'CallExpression' && memberName(expression.callee) === 'concat') {
    const callee = unwrapExpression(expression.callee);
    const codes = [
      ...(numericArray(callee.object, bindings, seen) || []),
      ...expression.arguments.flatMap((argument) => (
        numericArray(argument.type === 'SpreadElement' ? argument.argument : argument, bindings, seen)
        || numericValues(argument, bindings, seen)
      )),
    ];
    return codes.length > 0 ? [...new Set(codes)] : null;
  }
  if (expression?.type !== 'ArrayExpression') return null;
  const codes = expression.elements
    .flatMap((element) => (
      element?.type === 'SpreadElement'
        ? numericArray(element.argument, bindings, seen) || []
        : numericValues(element, bindings, seen)
    ));
  return codes.length > 0 ? [...new Set(codes)] : null;
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

  const leftNumbers = numericValues(test.left, bindings)
    .filter((code) => code >= 200 && code < 300);
  const rightNumbers = numericValues(test.right, bindings)
    .filter((code) => code >= 200 && code < 300);
  if (leftNumbers.length && expressionKey(test.right, source) === actualKey) {
    return { codes: leftNumbers, operator: test.operator };
  }
  if (rightNumbers.length && expressionKey(test.left, source) === actualKey) {
    return { codes: rightNumbers, operator: test.operator };
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
      return comparison.codes;
    }
    if (['==', '==='].includes(comparison.operator) && isWithin(assertionNode, ifNode.alternate)) {
      return comparison.codes;
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
  const bindings = collectBindings(ast);
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
