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

function assignedIdentifier(pattern) {
  if (pattern?.type === 'Identifier') return pattern;
  if (pattern?.type === 'AssignmentPattern') return assignedIdentifier(pattern.left);
  return null;
}

function isPromiseCatchCallback(node) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (
      (ancestor.type === 'ArrowFunctionExpression' || ancestor.type === 'FunctionExpression')
      && ancestor.parent?.type === 'CallExpression'
      && ancestor.parent.arguments.includes(ancestor)
      && memberName(ancestor.parent.callee) === 'catch'
    ) {
      return true;
    }
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow success responses from catch blocks',
    },
    schema: [],
    messages: {
      fakeSuccess: 'Do not return a success response from a catch block. Report the failure honestly or move a proven no-data branch outside the catch.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const successBindings = new Set();
    const aliasAssignments = [];
    const candidateCalls = [];

    function variableFor(identifier) {
      if (identifier?.type !== 'Identifier') return null;
      for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
      }
      return null;
    }

    function resolvesToSuccess(expression) {
      const node = unwrapExpression(expression);
      if (node?.type === 'ConditionalExpression') {
        return resolvesToSuccess(node.consequent) || resolvesToSuccess(node.alternate);
      }
      if (node?.type === 'LogicalExpression') {
        return resolvesToSuccess(node.left) || resolvesToSuccess(node.right);
      }
      if (node?.type === 'AssignmentExpression') return resolvesToSuccess(node.right);
      if (node?.type === 'CallExpression' && memberName(node.callee) === 'bind') {
        return resolvesToSuccess(node.callee.object);
      }
      if (node?.type === 'Identifier') {
        const variable = variableFor(node);
        return variable ? successBindings.has(variable) : node.name === 'success';
      }
      return memberName(node) === 'success';
    }

    function recordDeclaredAlias(node, name, expression) {
      for (const variable of sourceCode.getDeclaredVariables(node)) {
        if (variable.name !== name) continue;
        aliasAssignments.push({ variable, expression });
      }
    }

    return {
      ImportSpecifier(node) {
        if (node.imported?.name === 'success') {
          for (const variable of sourceCode.getDeclaredVariables(node)) {
            if (variable.name === node.local.name) successBindings.add(variable);
          }
        }
      },
      VariableDeclarator(node) {
        if (node.id?.type === 'Identifier') {
          recordDeclaredAlias(node, node.id.name, node.init);
          return;
        }
        if (node.id?.type === 'ObjectPattern') {
          for (const property of node.id.properties) {
            if (property.type !== 'Property') continue;
            const key = property.computed ? property.key?.value : property.key?.name;
            const identifier = assignedIdentifier(property.value);
            if (key === 'success' && identifier) {
              for (const variable of sourceCode.getDeclaredVariables(node)) {
                if (variable.name === identifier.name) successBindings.add(variable);
              }
            }
          }
        }
      },
      AssignmentPattern(node) {
        const identifier = assignedIdentifier(node.left);
        const variable = variableFor(identifier);
        if (variable) aliasAssignments.push({ variable, expression: node.right });
      },
      AssignmentExpression(node) {
        if (!['=', '&&=', '||=', '??='].includes(node.operator)) return;
        if (node.left?.type === 'Identifier') {
          const variable = variableFor(node.left);
          if (variable) aliasAssignments.push({ variable, expression: node.right });
          return;
        }
        if (node.operator !== '=' || node.left?.type !== 'ObjectPattern') return;
        for (const property of node.left.properties) {
          if (property.type !== 'Property') continue;
          const key = property.computed ? property.key?.value : property.key?.name;
          const identifier = assignedIdentifier(property.value);
          if (key !== 'success' || !identifier) continue;
          const variable = variableFor(identifier);
          if (variable) successBindings.add(variable);
        }
      },
      CallExpression(node) {
        if (isPromiseCatchCallback(node)) candidateCalls.push(node);
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
          if (ancestor.type === 'CatchClause') {
            candidateCalls.push(node);
            return;
          }
        }
      },
      'Program:exit'() {
        let changed = true;
        while (changed) {
          changed = false;
          for (const { variable, expression } of aliasAssignments) {
            if (successBindings.has(variable) || !resolvesToSuccess(expression)) continue;
            successBindings.add(variable);
            changed = true;
          }
        }

        for (const node of new Set(candidateCalls)) {
          if (resolvesToSuccess(node.callee)) context.report({ node, messageId: 'fakeSuccess' });
        }
      },
    };
  },
};
