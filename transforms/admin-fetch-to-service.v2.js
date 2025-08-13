/**
 * jscodeshift codemod (Windows-friendly)
 * Converts admin-ish calls to adminService.request('/api/v1/...'):
 *  - fetch('/admin/...'), fetch(`${API_BASE_URL}/admin/...`), fetch(process.env.NEXT_PUBLIC_API_URL + '/admin/...')
 *  - axios.get/post/put/delete('.../admin/...') and axios({ url: '.../admin/...' })
 *  - buildUrl('/admin/...') → keep buildUrl but prefix '/api/v1' (safer)
 *
 * Run:
 *   npx jscodeshift -t transforms/admin-fetch-to-service.v2.js src --extensions=ts,tsx,js,jsx --parser=tsx -d -p
 *   npx jscodeshift -t transforms/admin-fetch-to-service.v2.js src --extensions=ts,tsx,js,jsx --parser=tsx
 */

const ADMINISH_PREFIXES = [
  '/admin/',
  '/staff/',
  '/appointments/admin/',
  '/notifications/admin/',
  '/investigations/admin/',
  '/pharmacy/admin/',
  '/api/v1/admin/',
];

const ENV_URL_NAMES = new Set([
  'API_BASE_URL',
  'BASE_URL',
  'API_URL',
  'NEXT_PUBLIC_API_URL',
]);

function isAdminishPath(s) {
  return ADMINISH_PREFIXES.some((p) => s.startsWith(p));
}

function normalizePath(s) {
  if (s.startsWith('/api/v1/')) return s;
  if (s.startsWith('/')) return '/api/v1' + s;
  return '/api/v1/' + s.replace(/^\/+/, '');
}

function litString(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : null;
}

function strFromTemplateIfEnvUrl(j, node) {
  if (node.type !== 'TemplateLiteral') return null;
  // Allow any number of expressions; first should be an env url var or process.env.*
  const [expr] = node.expressions;
  if (!expr) return null;

  const isId = expr.type === 'Identifier' && ENV_URL_NAMES.has(expr.name);
  const isProcEnv =
    expr.type === 'MemberExpression' &&
    expr.object &&
    expr.object.type === 'MemberExpression' &&
    expr.object.object?.name === 'process' &&
    expr.object.property?.name === 'env';

  if (!isId && !isProcEnv) return null;

  // Rebuild the tail after the first expression
  const tail = node.quasis.slice(1).map((q) => q.value?.cooked ?? '').join('${...}');
  return tail.startsWith('/') ? tail : '/' + tail;
}

function strFromBinaryIfEnvUrl(j, node) {
  if (node.type !== 'BinaryExpression' || node.operator !== '+') return null;

  function isEnvUrl(n) {
    if (n.type === 'Identifier' && ENV_URL_NAMES.has(n.name)) return true;
    if (
      n.type === 'MemberExpression' &&
      n.object?.object?.name === 'process' &&
      n.object?.property?.name === 'env'
    ) return true;
    return false;
  }

  if (!isEnvUrl(node.left)) return null;

  if (node.right.type === 'Literal' && typeof node.right.value === 'string') {
    const s = node.right.value;
    return s.startsWith('/') ? s : '/' + s;
  }
  return null;
}

function extractAdminishPath(j, arg0) {
  if (!arg0) return null;

  // fetch('/admin/..')
  const lit = litString(arg0);
  if (lit && isAdminishPath(lit)) return lit;

  // fetch(`${API_BASE_URL}/admin/...`)
  const tpl = strFromTemplateIfEnvUrl(j, arg0);
  if (tpl && isAdminishPath(tpl)) return tpl;

  // fetch(API_BASE_URL + '/admin/...')
  const bin = strFromBinaryIfEnvUrl(j, arg0);
  if (bin && isAdminishPath(bin)) return bin;

  return null;
}

function ensureAdminImport(j, root) {
  const has = root.find(j.ImportDeclaration, {
    source: { value: '@/services/admin.service' },
  }).some((p) =>
    p.value.specifiers?.some(
      (s) => s.type === 'ImportSpecifier' && s.imported.name === 'adminService'
    )
  );

  if (!has) {
    const imp = j.importDeclaration(
      [j.importSpecifier(j.identifier('adminService'))],
      j.literal('@/services/admin.service')
    );
    const first = root.find(j.ImportDeclaration).at(0);
    if (first.size()) first.insertBefore(imp);
    else root.get().node.program.body.unshift(imp);
  }
}

function adminRequestCall(j, pathStr, initArg) {
  const args = [j.literal(normalizePath(pathStr))];
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

  // --- fetch(...).then(r=>r.json()) → adminService.request(...)
  root.find(j.CallExpression, {
    callee: { type: 'MemberExpression', property: { name: 'then' } },
  }).forEach((p) => {
    const call = p.node.callee.object;
    if (!call || call.type !== 'CallExpression') return;
    const callee = call.callee;
    const isFetch =
      (callee.type === 'Identifier' && callee.name === 'fetch') ||
      (callee.type === 'MemberExpression' &&
        callee.object.name === 'window' &&
        callee.property.name === 'fetch');
    if (!isFetch) return;

    const adminish = extractAdminishPath(j, call.arguments[0]);
    if (!adminish) return;

    const [arg] = p.node.arguments;
    const isJsonThen =
      arg &&
      (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') &&
      (
        (arg.body.type === 'CallExpression' &&
          arg.body.callee.type === 'MemberExpression' &&
          arg.body.callee.property.name === 'json') ||
        (arg.body.type === 'BlockStatement' &&
          arg.body.body.some(
            (s) =>
              s.type === 'ReturnStatement' &&
              s.argument &&
              s.argument.type === 'CallExpression' &&
              s.argument.callee.type === 'MemberExpression' &&
              s.argument.callee.property.name === 'json'
          ))
      );

    if (isJsonThen) {
      const initArg = call.arguments[1];
      j(p).replaceWith(adminRequestCall(j, adminish, initArg));
      changed = true;
    }
  });

  // --- await (await fetch(...)).json() → await adminService.request(...)
  root.find(j.AwaitExpression, {
    argument: {
      type: 'CallExpression',
      callee: { type: 'MemberExpression', property: { name: 'json' } },
    },
  }).forEach((p) => {
    const innerAwait = p.node.argument.callee.object;
    if (!innerAwait || innerAwait.type !== 'AwaitExpression') return;
    const innerCall = innerAwait.argument;
    if (!innerCall || innerCall.type !== 'CallExpression') return;

    const callee = innerCall.callee;
    const isFetch =
      (callee.type === 'Identifier' && callee.name === 'fetch') ||
      (callee.type === 'MemberExpression' &&
        callee.object.name === 'window' &&
        callee.property.name === 'fetch');
    if (!isFetch) return;

    const adminish = extractAdminishPath(j, innerCall.arguments[0]);
    if (!adminish) return;

    const initArg = innerCall.arguments[1];
    j(p).replaceWith(j.awaitExpression(adminRequestCall(j, adminish, initArg)));
    changed = true;
  });

  // --- Plain fetch('/admin/...', init)
  root.find(j.CallExpression, {
    callee: (n) =>
      (n.type === 'Identifier' && n.name === 'fetch') ||
      (n.type === 'MemberExpression' && n.object.name === 'window' && n.property.name === 'fetch'),
  }).forEach((p) => {
    const [arg0, initArg] = p.node.arguments;
    const adminish = extractAdminishPath(j, arg0);
    if (!adminish) return;

    // skip if part of .then(...).json(), already handled
    const parent = p.parentPath.value;
    if (parent?.type === 'MemberExpression' && parent.property?.name === 'then') return;

    j(p).replaceWith(adminRequestCall(j, adminish, initArg));
    changed = true;
  });

  // --- axios.<method>('.../admin/...') → adminService.request(..., { method })
  root.find(j.CallExpression, {
    callee: {
      type: 'MemberExpression',
      object: { name: 'axios' },
      property: (p) => ['get', 'post', 'put', 'delete', 'patch'].includes(p.name),
    },
  }).forEach((p) => {
    const method = p.node.callee.property.name.toUpperCase();
    const [urlArg, bodyArg, configArg] = p.node.arguments;

    const urlLit = litString(urlArg);
    if (!urlLit || !isAdminishPath(urlLit.replace(/https?:\/\/[^/]+/, '').replace(/^.*?\/(?=admin)/, '/'))) return;

    const pathOnly = urlLit.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '/'); // remove domain
    const init = method === 'GET'
      ? (configArg || null)
      : (configArg
          ? { type: 'ObjectExpression', value: { body: bodyArg, method, config: configArg } }
          : null);

    const initNode =
      method === 'GET'
        ? configArg
        : j.objectExpression([
            j.property('init', j.identifier('method'), j.literal(method)),
            ...(bodyArg ? [j.property('init', j.identifier('headers'), j.objectExpression([j.property('init', j.identifier('Content-Type'), j.literal('application/json'))]))] : []),
            ...(bodyArg ? [j.property('init', j.identifier('body'), j.callExpression(j.identifier('JSON.stringify'), [bodyArg]))] : []),
          ]);

    j(p).replaceWith(adminRequestCall(j, pathOnly, initNode));
    changed = true;
  });

  // --- axios({ url: '.../admin/...', method, data }) → adminService.request(...)
  root.find(j.CallExpression, {
    callee: { type: 'Identifier', name: 'axios' },
    arguments: (args) => args.length === 1 && args[0].type === 'ObjectExpression',
  }).forEach((p) => {
    const obj = p.node.arguments[0];
    const urlProp = obj.properties.find(
      (pr) => pr.type === 'Property' && pr.key.type === 'Identifier' && pr.key.name === 'url'
    );
    if (!urlProp || urlProp.value.type !== 'Literal') return;
    const url = urlProp.value.value;
    if (typeof url !== 'string') return;

    const pathOnly = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '/');
    if (!isAdminishPath(pathOnly)) return;

    // Build init from method/data/headers if present
    const methodProp = obj.properties.find(
      (pr) => pr.type === 'Property' && pr.key.type === 'Identifier' && pr.key.name === 'method'
    );
    const dataProp = obj.properties.find(
      (pr) => pr.type === 'Property' && pr.key.type === 'Identifier' && pr.key.name === 'data'
    );

    const method =
      methodProp && methodProp.value.type === 'Literal' && typeof methodProp.value.value === 'string'
        ? methodProp.value.value.toUpperCase()
        : 'GET';

    const initProps = [j.property('init', j.identifier('method'), j.literal(method))];
    if (dataProp) {
      initProps.push(
        j.property('init', j.identifier('headers'),
          j.objectExpression([j.property('init', j.identifier('Content-Type'), j.literal('application/json'))])
        ),
        j.property('init', j.identifier('body'), j.callExpression(j.identifier('JSON.stringify'), [dataProp.value]))
      );
    }
    j(p).replaceWith(adminRequestCall(j, pathOnly, j.objectExpression(initProps)));
    changed = true;
  });

  // --- buildUrl('/admin/...') → buildUrl('/api/v1/admin/...')
  root.find(j.CallExpression, {
    callee: { type: 'Identifier', name: 'buildUrl' },
    arguments: (args) => args[0] && args[0].type === 'Literal' && typeof args[0].value === 'string' && isAdminishPath(args[0].value),
  }).forEach((p) => {
    const lit = p.node.arguments[0];
    lit.value = normalizePath(lit.value);
    changed = true;
  });

  if (changed) ensureAdminImport(j, root);
  return changed ? root.toSource({ quote: 'single' }) : null;
};
