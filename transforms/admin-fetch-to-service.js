/**
 * jscodeshift codemod
 * - Replaces fetch('/admin/...') or fetch(`${API_BASE_URL}/admin/...`) with adminService.request('/api/v1/admin/...')
 * - Removes trailing `.then(r => r.json())`
 * - Replaces `await (await fetch(...)).json()` with `await adminService.request(...)`
 *
 * Run:
 *   npx jscodeshift -t transforms/admin-fetch-to-service.js "src/**/*.{ts,tsx,js,jsx}" --parser=tsx
 */

const ADMINISH_PREFIXES = [
  '/admin/',
  '/staff/',
  '/appointments/admin/',
  '/notifications/admin/',
  '/investigations/admin/',
  '/pharmacy/admin/',
  '/api/v1/admin/', // keep as-is (already prefixed)
];

function isAdminishPath(p) {
  return ADMINISH_PREFIXES.some((pref) => p.startsWith(pref));
}

function normalizePath(raw) {
  // raw is a path beginning with '/admin/...' or '/api/v1/admin/...'
  if (raw.startsWith('/api/v1/')) return raw;
  if (raw.startsWith('/')) return '/api/v1' + raw;
  return '/api/v1/' + raw.replace(/^\/+/, '');
}

function stringFromTemplateWithApiBase(j, node) {
  // Matches `${API_BASE_URL}/admin/...`
  if (node.type !== 'TemplateLiteral') return null;
  if (node.expressions.length !== 1) return null;
  const expr = node.expressions[0];
  const head = node.quasis[0]?.value?.cooked ?? '';
  const tail = node.quasis[1]?.value?.cooked ?? '';
  if (head !== '' || expr.type !== 'Identifier' || expr.name !== 'API_BASE_URL') return null;
  return tail.startsWith('/') ? tail : '/' + tail;
}

function stringFromBinaryApiBase(j, node) {
  // Matches API_BASE_URL + '/admin/...'
  if (node.type !== 'BinaryExpression' || node.operator !== '+') return null;
  if (node.left.type !== 'Identifier' || node.left.name !== 'API_BASE_URL') return null;
  if (node.right.type === 'Literal' && typeof node.right.value === 'string') {
    return node.right.value.startsWith('/') ? node.right.value : '/' + node.right.value;
  }
  return null;
}

function extractAdminishPath(j, arg0) {
  // Returns a string like '/admin/foo?bar=1' or '/api/v1/admin/...', or null if not adminish
  if (!arg0) return null;

  if (arg0.type === 'Literal' && typeof arg0.value === 'string') {
    const s = arg0.value;
    return isAdminishPath(s) ? s : null;
  }

  if (arg0.type === 'TemplateLiteral') {
    const s = stringFromTemplateWithApiBase(j, arg0);
    return s && isAdminishPath(s) ? s : null;
  }

  if (arg0.type === 'BinaryExpression') {
    const s = stringFromBinaryApiBase(j, arg0);
    return s && isAdminishPath(s) ? s : null;
  }

  // fetch(API_BASE_URL + '/admin/...') inside TemplateLiteral or other shape is not handled
  return null;
}

function ensureAdminImport(j, root) {
  const hasImport = root
    .find(j.ImportDeclaration)
    .filter((p) => p.node.source.value === '@/services/admin.service')
    .filter((p) =>
      p.node.specifiers?.some(
        (s) => s.type === 'ImportSpecifier' && s.imported.name === 'adminService'
      )
    ).length > 0;

  if (!hasImport) {
    const firstImport = root.find(j.ImportDeclaration).at(0);
    const newDecl = j.importDeclaration(
      [j.importSpecifier(j.identifier('adminService'))],
      j.literal('@/services/admin.service')
    );
    if (firstImport.length) {
      firstImport.insertBefore(newDecl);
    } else {
      root.get().node.program.body.unshift(newDecl);
    }
  }
}

function replaceWithAdminService(j, fetchCall, pathString, initArg) {
  const normalized = normalizePath(pathString);
  const args = [j.literal(normalized)];
  if (initArg) args.push(initArg);
  return j.callExpression(
    j.memberExpression(j.identifier('adminService'), j.identifier('request')),
    args
  );
}

module.exports = function transform(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);
  let changed = false;

  // Helper: replace `await (await fetch(...)).json()` → `await adminService.request(...)`
  root.find(j.AwaitExpression, {
    argument: {
      type: 'CallExpression',
      callee: { type: 'MemberExpression', property: { name: 'json' } },
      arguments: [],
    },
  }).forEach((p) => {
    const inner = p.node.argument.callee.object; // (await fetch(...))
    if (
      inner &&
      inner.type === 'AwaitExpression' &&
      inner.argument.type === 'CallExpression'
    ) {
      const call = inner.argument; // fetch(...)
      const callee = call.callee;
      const isFetch =
        (callee.type === 'Identifier' && callee.name === 'fetch') ||
        (callee.type === 'MemberExpression' &&
          callee.object.name === 'window' &&
          callee.property.name === 'fetch');

      if (isFetch) {
        const adminish = extractAdminishPath(j, call.arguments[0]);
        if (adminish) {
          const initArg = call.arguments[1];
          const newCall = replaceWithAdminService(j, call, adminish, initArg);
          p.replace(j.awaitExpression(newCall));
          changed = true;
        }
      }
    }
  });

  // Helper: replace `fetch(...).then(r => r.json())` → `adminService.request(...)`
  root.find(j.CallExpression, {
    callee: { type: 'MemberExpression', property: { name: 'then' } },
  }).forEach((p) => {
    const obj = p.node.callee.object;
    if (obj?.type !== 'CallExpression') return;
    const callee = obj.callee;
    const isFetch =
      (callee.type === 'Identifier' && callee.name === 'fetch') ||
      (callee.type === 'MemberExpression' &&
        callee.object.name === 'window' &&
        callee.property.name === 'fetch');
    if (!isFetch) return;

    // Check that `.then(arg)` is `(res) => res.json()` or function returning res.json()
    const [thenArg] = p.node.arguments;
    let isJsonThen = false;
    if (thenArg && (thenArg.type === 'ArrowFunctionExpression' || thenArg.type === 'FunctionExpression')) {
      const body = thenArg.body;
      if (body.type === 'CallExpression' && body.callee.type === 'MemberExpression' && body.callee.property.name === 'json') {
        isJsonThen = true;
      }
      if (body.type === 'BlockStatement') {
        const ret = body.body.find((s) => s.type === 'ReturnStatement');
        if (
          ret &&
          ret.argument &&
          ret.argument.type === 'CallExpression' &&
          ret.argument.callee.type === 'MemberExpression' &&
          ret.argument.callee.property.name === 'json'
        ) {
          isJsonThen = true;
        }
      }
    }

    const adminish = extractAdminishPath(j, obj.arguments[0]);
    if (isJsonThen && adminish) {
      const initArg = obj.arguments[1];
      const newCall = replaceWithAdminService(j, obj, adminish, initArg);
      p.replace(newCall);
      changed = true;
    }
  });

  // Base case: plain `fetch('/admin/...', init)`
  root.find(j.CallExpression, {
    callee: (n) =>
      (n.type === 'Identifier' && n.name === 'fetch') ||
      (n.type === 'MemberExpression' && n.object.name === 'window' && n.property.name === 'fetch'),
  }).forEach((p) => {
    const args = p.node.arguments;
    if (!args || !args.length) return;
    const adminish = extractAdminishPath(j, args[0]);
    if (!adminish) return;

    // If parent was already handled (e.g., `.then(...).json()`), skip
    const parent = p.parentPath.value;
    if (
      parent &&
      parent.type === 'MemberExpression' &&
      parent.property &&
      parent.property.name === 'then'
    ) {
      return;
    }

    const initArg = args[1];
    const newCall = replaceWithAdminService(j, p.node, adminish, initArg);
    j(p).replaceWith(newCall);
    changed = true;
  });

  if (changed) ensureAdminImport(j, root);
  return changed ? root.toSource({ quote: 'single' }) : null;
};
