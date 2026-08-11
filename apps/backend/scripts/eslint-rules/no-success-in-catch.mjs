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
            if (key === 'success' && property.value?.type === 'Identifier') {
              for (const variable of sourceCode.getDeclaredVariables(node)) {
                if (variable.name === property.value.name) successBindings.add(variable);
              }
            }
          }
        }
      },
      AssignmentExpression(node) {
        if (node.operator !== '=' || node.left?.type !== 'Identifier') return;
        const variable = variableFor(node.left);
        if (!variable) return;
        aliasAssignments.push({ variable, expression: node.right });
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
