function isSuccessCall(node) {
  if (node.callee?.type === 'Identifier') return node.callee.name === 'success';
  if (node.callee?.type !== 'MemberExpression' || node.callee.computed) return false;
  return node.callee.property?.type === 'Identifier' && node.callee.property.name === 'success';
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
    return {
      CallExpression(node) {
        if (!isSuccessCall(node)) return;
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
