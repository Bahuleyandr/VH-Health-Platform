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

    function setDeclaredBinding(node, name, isSuccess) {
      for (const variable of sourceCode.getDeclaredVariables(node)) {
        if (variable.name !== name) continue;
        if (isSuccess) successBindings.add(variable);
        else successBindings.delete(variable);
      }
    }

    return {
      ImportSpecifier(node) {
        if (node.imported?.name === 'success') {
          setDeclaredBinding(node, node.local.name, true);
        }
      },
      VariableDeclarator(node) {
        if (node.id?.type === 'Identifier') {
          setDeclaredBinding(node, node.id.name, resolvesToSuccess(node.init));
          return;
        }
        if (node.id?.type === 'ObjectPattern') {
          for (const property of node.id.properties) {
            if (property.type !== 'Property') continue;
            const key = property.computed ? property.key?.value : property.key?.name;
            if (key === 'success' && property.value?.type === 'Identifier') {
              setDeclaredBinding(node, property.value.name, true);
            }
          }
        }
      },
      AssignmentExpression(node) {
        if (node.operator !== '=' || node.left?.type !== 'Identifier') return;
        const variable = variableFor(node.left);
        if (!variable) return;
        if (resolvesToSuccess(node.right)) successBindings.add(variable);
        else successBindings.delete(variable);
      },
      CallExpression(node) {
        if (!resolvesToSuccess(node.callee)) return;
        if (isPromiseCatchCallback(node)) {
          context.report({ node, messageId: 'fakeSuccess' });
          return;
        }
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
          if (ancestor.type === 'CatchClause') {
            context.report({ node, messageId: 'fakeSuccess' });
            return;
          }
        }
      },
    };
  },
};
