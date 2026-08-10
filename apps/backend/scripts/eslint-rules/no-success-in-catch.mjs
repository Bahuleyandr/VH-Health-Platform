function memberName(node) {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed && node.property?.type === 'Literal') return node.property.value;
  return null;
}

function isSuccessCall(node, successAliases) {
  if (node.callee?.type === 'Identifier') return successAliases.has(node.callee.name);
  return memberName(node.callee) === 'success';
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
    const successAliases = new Set(['success']);
    return {
      ImportSpecifier(node) {
        if (node.imported?.name === 'success') successAliases.add(node.local.name);
      },
      VariableDeclarator(node) {
        if (node.id?.type !== 'ObjectPattern') return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const key = property.computed ? property.key?.value : property.key?.name;
          if (key === 'success' && property.value?.type === 'Identifier') {
            successAliases.add(property.value.name);
          }
        }
      },
      CallExpression(node) {
        if (!isSuccessCall(node, successAliases)) return;
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
