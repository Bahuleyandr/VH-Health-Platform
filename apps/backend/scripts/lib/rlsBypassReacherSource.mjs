import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

export function collectBypassReachers(repoRoot, { sourceFiles = null } = {}) {
  const root = path.resolve(repoRoot).replaceAll('\\', '/');
  const files =
    sourceFiles ||
    execFileSync(
      'rg',
      ['--files', 'apps/backend/src', 'apps/backend/admin', '-g', '*.js', '-g', '!**/tests/**'],
      { cwd: root, encoding: 'utf8' }
    )
      .trim()
      .split(/\r?\n/)
      .map(f => path.resolve(root, f))
      .sort();
  const compilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    maxNodeModuleJsDepth: 0,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext
  };
  const host = ts.createCompilerHost(compilerOptions);
  const readSource = host.readFile;
  host.readFile = file => readSource(file)?.replaceAll('\r\n', '\n');
  const program = ts.createProgram(files, compilerOptions, host);
  const checker = program.getTypeChecker();
  const sources = program
    .getSourceFiles()
    .filter(
      s =>
        s.fileName.replaceAll('\\', '/').startsWith(`${root}/apps/backend/`) &&
        !s.fileName.includes('node_modules') &&
        !s.fileName.includes('/tests/')
    );
  const rel = s => path.relative(root, s.fileName).replaceAll('\\', '/');
  const line = n => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const key = n =>
    `${rel(n.getSourceFile())}:${line(n)}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).character + 1}`;
  const func = n => ts.isFunctionLike(n) && n.body;
  const functions = new Map();
  const nodeToFunction = new Map();
  const sql = [];
  const roots = [];
  const registrations = [];
  const pendingCalls = [];
  const assignments = new Map();
  const callSites = new Map();
  const residualRoots = [];
  const rawNodes = new Map();
  const registrationErrors = [];
  const directPgImports = [];
  const routerRegistrations = new Map();
  const targets = new Set([
    'users',
    'housekeeping_logs',
    'housekeeping_floor_assignments',
    'housekeeping_zones',
    'staff',
    'housekeeping_requests',
    'doctors',
    'investigations',
    'investigation_bookings',
    'appointment_queues',
    'appointments',
    'emergency_visits',
    'maternity_pregnancies',
    'staff_performance_reviews',
    'leave_applications',
    'staff_attendance',
    'incident_reports',
    'report_updates',
    'staff_grievances',
    'wards',
    'patient_data_rights_requests',
    'e_prescriptions'
  ]);
  function walk(n, cb) {
    cb(n);
    ts.forEachChild(n, c => walk(c, cb));
  }
  function name(n) {
    if (n.name) return n.name.getText();
    if (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent))
      return n.parent.name.getText();
    return `<callback@${line(n)}>`;
  }
  function property(n) {
    return ts.isPropertyAccessExpression(n)
      ? n.name.text
      : ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)
        ? n.argumentExpression.text
        : ts.isIdentifier(n)
          ? n.text
          : '';
  }
  function symbol(n) {
    try {
      let s = ts.isShorthandPropertyAssignment(n.parent)
        ? checker.getShorthandAssignmentValueSymbol(n.parent)
        : checker.getSymbolAtLocation(n);
      if (s?.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
      return s;
    } catch {
      return null;
    }
  }
  for (const s of sources) {
    walk(s, n => {
      if (ts.isImportDeclaration(n) && n.moduleSpecifier.text === 'pg')
        directPgImports.push({ file: rel(s), line: line(n) });
      if (func(n)) {
        const f = {
          id: key(n),
          file: rel(s),
          line: line(n),
          end: s.getLineAndCharacterOfPosition(n.end).line + 1,
          name: name(n),
          edges: [],
          sql: []
        };
        functions.set(f.id, f);
        nodeToFunction.set(n, f.id);
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const sym = symbol(n.left);
        if (sym) assignments.set(sym, [...(assignments.get(sym) || []), n.right]);
      }
    });
  }
  function resolve(n, seen = new Set()) {
    if (!n || seen.has(n)) return [];
    seen.add(n);
    if (nodeToFunction.has(n)) return [nodeToFunction.get(n)];
    if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n))
      return resolve(n.expression, seen);
    if (ts.isConditionalExpression(n))
      return [...new Set([...resolve(n.whenTrue, seen), ...resolve(n.whenFalse, seen)])];
    if (ts.isBinaryExpression(n))
      return [...new Set([...resolve(n.left, seen), ...resolve(n.right, seen)])];
    const result = [];
    const sym = symbol(n);
    for (const d of sym?.declarations || []) {
      if (nodeToFunction.has(d)) result.push(nodeToFunction.get(d));
      if (d.initializer) result.push(...resolve(d.initializer, seen));
    }
    if (ts.isElementAccessExpression(n)) {
      const base = symbol(n.expression);
      for (const d of base?.declarations || []) {
        let value = d.initializer;
        if (value && ts.isCallExpression(value) && value.expression.getText() === 'Object.freeze')
          value = value.arguments[0];
        if (value && ts.isObjectLiteralExpression(value)) {
          for (const p of value.properties) {
            if (nodeToFunction.has(p)) result.push(nodeToFunction.get(p));
            if (p.initializer) result.push(...resolve(p.initializer, seen));
          }
        }
      }
    }
    try {
      const type = checker.getTypeAtLocation(n);
      for (const t of type.isUnion?.() ? type.types : [type]) {
        for (const sig of t.getCallSignatures())
          if (nodeToFunction.has(sig.declaration)) result.push(nodeToFunction.get(sig.declaration));
      }
    } catch {
      /* unresolved expressions are reported below */
    }
    return [...new Set(result)];
  }
  for (const s of sources) {
    walk(s, n => {
      if (!ts.isCallExpression(n)) return;
      const nm = property(n.expression);
      if (/^\$(queryRaw|executeRaw)(Unsafe)?$/.test(nm)) return;
      for (const id of resolve(n.expression)) callSites.set(id, [...(callSites.get(id) || []), n]);
    });
  }
  function texts(n, seen = new Set()) {
    if (!n || seen.has(n)) return [];
    seen.add(n);
    if (ts.isStringLiteralLike(n)) return [n.text];
    if (ts.isTemplateExpression(n)) {
      const base =
        n.head.text + n.templateSpans.map(s => ` __DYNAMIC__ ${s.literal.text}`).join('');
      const fragments = [];
      let prefix = n.head.text;
      for (const span of n.templateSpans) {
        const expanded = texts(span.expression, new Set(seen));
        const verb = prefix.match(/\b(FROM|JOIN|UPDATE|INTO|TRUNCATE(?:\s+TABLE)?)\s*$/i)?.[1];
        fragments.push(...expanded.map(text => (verb ? `${verb} ${text}` : text)));
        prefix = span.literal.text;
      }
      return [base, ...fragments];
    }
    if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n))
      return texts(n.expression, seen);
    if (ts.isTaggedTemplateExpression(n)) return texts(n.template, seen);
    if (ts.isConditionalExpression(n))
      return [...texts(n.whenTrue, seen), ...texts(n.whenFalse, seen)];
    if (ts.isBinaryExpression(n)) return [...texts(n.left, seen), ...texts(n.right, seen)];
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const selector = ts.isPropertyAccessExpression(n)
        ? n.name.text
        : ts.isStringLiteralLike(n.argumentExpression)
          ? n.argumentExpression.text
          : null;
      const values = objectValues(n.expression, new Set(seen));
      const selected = values.flatMap(value => {
        if (!ts.isObjectLiteralExpression(value)) return [];
        return value.properties
          .filter(
            p => p.name && (!selector || p.name.getText().replace(/^['"]|['"]$/g, '') === selector)
          )
          .flatMap(p => texts(p.initializer || p.name, new Set(seen)));
      });
      if (selected.length) return [...new Set(selected)];
    }
    const sym = symbol(n);
    const found = [];
    for (const d of sym?.declarations || []) {
      if (d.initializer) found.push(...texts(d.initializer, seen));
      if (ts.isBindingElement(d) && ts.isVariableDeclaration(d.parent.parent)) {
        const selector = (d.propertyName || d.name).getText();
        for (const value of objectValues(d.parent.parent.initializer, new Set(seen))) {
          if (ts.isObjectLiteralExpression(value))
            for (const p of value.properties) {
              if (p.name?.getText() === selector)
                found.push(...texts(p.initializer || p.name, new Set(seen)));
            }
        }
      }
      if (ts.isParameter(d) && nodeToFunction.has(d.parent)) {
        const parameterIndex = d.parent.parameters.indexOf(d);
        for (const call of callSites.get(nodeToFunction.get(d.parent)) || [])
          found.push(...texts(call.arguments[parameterIndex], seen));
      }
    }
    for (const rhs of assignments.get(sym) || []) found.push(...texts(rhs, seen));
    if (ts.isCallExpression(n)) {
      if (ts.isPropertyAccessExpression(n.expression))
        found.push(...texts(n.expression.expression, seen));
      for (const a of n.arguments) found.push(...texts(a, seen));
      for (const target of resolve(n.expression)) {
        const source = sources.find(s => rel(s) === functions.get(target).file);
        const functionNode = [...nodeToFunction.entries()].find(([, id]) => id === target)?.[0];
        if (source && functionNode) {
          if (ts.isArrowFunction(functionNode) && !ts.isBlock(functionNode.body))
            found.push(...texts(functionNode.body, seen));
          else
            walk(functionNode.body, c => {
              if (ts.isReturnStatement(c)) found.push(...texts(c.expression, seen));
            });
        }
      }
    }
    return [...new Set(found)];
  }
  function objectValues(n, seen = new Set()) {
    if (!n || seen.has(n)) return [];
    seen.add(n);
    if (ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)) return [n];
    if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n))
      return objectValues(n.expression, seen);
    if (ts.isConditionalExpression(n))
      return [
        ...objectValues(n.whenTrue, new Set(seen)),
        ...objectValues(n.whenFalse, new Set(seen))
      ];
    if (ts.isCallExpression(n) && n.expression.getText() === 'Object.freeze')
      return objectValues(n.arguments[0], seen);
    if (ts.isElementAccessExpression(n) || ts.isPropertyAccessExpression(n)) {
      const selector = ts.isPropertyAccessExpression(n)
        ? n.name.text
        : ts.isStringLiteralLike(n.argumentExpression)
          ? n.argumentExpression.text
          : null;
      return objectValues(n.expression, seen).flatMap(value =>
        ts.isObjectLiteralExpression(value)
          ? value.properties
              .filter(
                p =>
                  p.name && (!selector || p.name.getText().replace(/^['"]|['"]$/g, '') === selector)
              )
              .flatMap(p => objectValues(p.initializer || p.name, new Set(seen)))
          : []
      );
    }
    const values = [];
    for (const d of symbol(n)?.declarations || []) {
      if (d.initializer) values.push(...objectValues(d.initializer, new Set(seen)));
      if (ts.isParameter(d) && nodeToFunction.has(d.parent)) {
        for (const call of callSites.get(nodeToFunction.get(d.parent)) || [])
          values.push(
            ...objectValues(call.arguments[d.parent.parameters.indexOf(d)], new Set(seen))
          );
      }
      if (
        ts.isVariableDeclaration(d) &&
        ts.isVariableDeclarationList(d.parent) &&
        ts.isForOfStatement(d.parent.parent)
      ) {
        for (const collection of objectValues(d.parent.parent.expression, new Set(seen)))
          if (ts.isArrayLiteralExpression(collection))
            for (const element of collection.elements)
              values.push(...objectValues(element, new Set(seen)));
      }
      if (ts.isBindingElement(d) && ts.isVariableDeclaration(d.parent.parent)) {
        const selector = (d.propertyName || d.name).getText();
        for (const value of objectValues(d.parent.parent.initializer, new Set(seen))) {
          if (ts.isObjectLiteralExpression(value))
            for (const p of value.properties) {
              if (p.name?.getText() === selector)
                values.push(...objectValues(p.initializer || p.name, new Set(seen)));
            }
        }
      }
    }
    if (ts.isCallExpression(n)) {
      for (const target of resolve(n.expression)) {
        const fn = [...nodeToFunction.entries()].find(([, id]) => id === target)?.[0];
        if (!fn) continue;
        if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
          values.push(...objectValues(fn.body, new Set(seen)));
          continue;
        }
        const returns = node => {
          if (node !== fn && func(node)) return;
          if (ts.isReturnStatement(node))
            values.push(...objectValues(node.expression, new Set(seen)));
          ts.forEachChild(node, returns);
        };
        returns(fn);
      }
    }
    return [...new Set(values)];
  }
  function tables(text) {
    const found = [];
    const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    const ctes = new Set(
      [
        ...cleaned.matchAll(
          /(?:\bWITH(?:\s+RECURSIVE)?|,)\s*"?([a-z_][a-z_0-9]*)"?\s*(?:\([^)]*\))?\s+AS\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(/gi
        )
      ].map(m => m[1].toLowerCase())
    );
    for (const m of cleaned.matchAll(
      /\b(?:FROM|JOIN|UPDATE|INTO|TRUNCATE(?:\s+TABLE)?|LOCK\s+TABLE)\s+(?:ONLY\s+)?(public\.)?"?([a-z_][a-z_0-9]*)"?/gi
    ))
      if (targets.has(m[2].toLowerCase()) && (m[1] || !ctes.has(m[2].toLowerCase())))
        found.push(m[2].toLowerCase());
    return [...new Set(found)];
  }
  function callbackContext(call) {
    const nm = property(call.expression);
    if (['runWithSuperAdmin', 'withJobLock', 'withReplicaLocalJobGuard'].includes(nm))
      return 'bypass';
    if (['setTenant', 'setTenantTx', 'runInTenantContext'].includes(nm)) {
      const options = call.arguments[2]?.getText() || '';
      if (/superAdmin\s*:\s*true\b/.test(options)) return 'bypass';
      if (call.arguments[0]?.kind === ts.SyntaxKind.NullKeyword) return 'unset-or-bypass';
      return 'tenant';
    }
    if (['runForEachTenant', 'withTenantContext', 'withTenantTransaction'].includes(nm))
      return 'tenant';
    if (nm === '$transaction') return 'bare-transaction';
    return null;
  }
  function rawAlias(n, seen = new Set()) {
    if (!n || seen.has(n)) return null;
    seen.add(n);
    const method = property(n);
    if (/^\$(queryRaw|executeRaw)(Unsafe)?$/.test(method)) return method;
    if (ts.isCallExpression(n) && property(n.expression) === 'bind')
      return rawAlias(n.expression.expression, seen);
    if (ts.isConditionalExpression(n))
      return rawAlias(n.whenTrue, seen) || rawAlias(n.whenFalse, seen);
    if (ts.isBinaryExpression(n)) return rawAlias(n.left, seen) || rawAlias(n.right, seen);
    for (const d of symbol(n)?.declarations || []) {
      const found = d.initializer && rawAlias(d.initializer, seen);
      if (found) return found;
    }
    return null;
  }
  function modelTables(n, seen = new Set()) {
    if (!n || seen.has(n)) return [];
    seen.add(n);
    if (ts.isPropertyAccessExpression(n) && targets.has(property(n))) return [property(n)];
    if (ts.isElementAccessExpression(n))
      return texts(n.argumentExpression).filter(text => targets.has(text));
    if (ts.isConditionalExpression(n))
      return [
        ...modelTables(n.whenTrue, new Set(seen)),
        ...modelTables(n.whenFalse, new Set(seen))
      ];
    const found = [];
    for (const declaration of symbol(n)?.declarations || [])
      if (declaration.initializer)
        found.push(...modelTables(declaration.initializer, new Set(seen)));
    return [...new Set(found)];
  }
  function routerSymbol(n, seen = new Set()) {
    if (!n || seen.has(n)) return null;
    seen.add(n);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression))
      return routerSymbol(n.expression.expression, seen);
    if (ts.isCallExpression(n) && n.arguments.length) return routerSymbol(n.arguments[0], seen);
    const value = symbol(n);
    for (const declaration of value?.declarations || []) {
      if (ts.isExportAssignment(declaration)) return routerSymbol(declaration.expression, seen);
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isIdentifier(declaration.initializer)
      )
        return routerSymbol(declaration.initializer, seen);
    }
    return value;
  }
  for (const s of sources) {
    function visit(n, owner = null) {
      if (nodeToFunction.has(n)) owner = nodeToFunction.get(n);
      if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) {
        const expression = ts.isCallExpression(n) ? n.expression : n.tag;
        const nm = property(expression);
        const args = ts.isCallExpression(n) ? [...n.arguments] : [n.template];
        const record = { file: rel(s), line: line(n), owner, expression: expression.getText() };
        const rawMethod = rawAlias(expression);
        const raw = Boolean(rawMethod);
        const pg = nm === 'query' && ts.isPropertyAccessExpression(expression);
        const ormModels =
          /^(find|count|aggregate|groupBy|create|update|upsert|delete)/.test(nm) &&
          ts.isPropertyAccessExpression(expression)
            ? modelTables(expression.expression)
            : [];
        const orm =
          ormModels.length > 0 &&
          /^(find|count|aggregate|groupBy|create|update|upsert|delete)/.test(nm);
        if (raw || pg || orm) {
          const strings = orm ? [] : texts(args[0]);
          const reachedTables = orm ? ormModels : [...new Set(strings.flatMap(tables))];
          const id = `${key(n)}:${rawMethod || nm}`;
          const q = {
            ...record,
            id,
            method: rawMethod || nm,
            tables: reachedTables,
            sql: strings
              .filter(t =>
                /\b(SELECT|INSERT|UPDATE|DELETE|WITH|FROM|ALTER|CREATE|CALL|SET|SAVEPOINT|ROLLBACK|RELEASE|LOCK|SHOW)\b/i.test(
                  t
                )
              )
              .join('\n-- possible fragment --\n'),
            unknown:
              !orm &&
              !strings.some(t =>
                /\b(SELECT|INSERT|UPDATE|DELETE|WITH|FROM|ALTER|CREATE|CALL|SET|SAVEPOINT|ROLLBACK|RELEASE|LOCK|SHOW)\b/i.test(
                  t
                )
              )
          };
          sql.push(q);
          rawNodes.set(id, { node: n, argument: args[0] });
          if (owner) functions.get(owner).sql.push(id);
        }
        if (ts.isCallExpression(n)) {
          if (
            ['use', 'get', 'post', 'put', 'patch', 'delete', 'options', 'all', 'head'].includes(
              nm
            ) &&
            ts.isPropertyAccessExpression(expression)
          ) {
            const router = routerSymbol(expression.expression);
            if (router)
              routerRegistrations.set(router, [
                ...(routerRegistrations.get(router) || []),
                { ...record, node: n, args, receiver: expression.expression.getText() }
              ]);
          }
          if (nm === 'registerCron' && record.file.endsWith('/utils/scheduler.js')) {
            const wrapper = args[1];
            const conditions = [];
            let loop = false;
            for (let parent = n.parent; parent; parent = parent.parent) {
              if (ts.isIfStatement(parent)) conditions.push(parent.expression.getText());
              if (
                ts.isForStatement(parent) ||
                ts.isForOfStatement(parent) ||
                ts.isForInStatement(parent) ||
                ts.isWhileStatement(parent) ||
                ts.isDoStatement(parent)
              )
                loop = true;
            }
            if (loop || owner !== null)
              registrationErrors.push(
                `${record.file}:${record.line}: registration multiplicity requires explicit expansion`
              );
            registrations.push({
              ...record,
              schedule: args[0]?.getText(),
              job: ts.isCallExpression(wrapper) ? texts(wrapper.arguments[0])[0] : null,
              wrapper: wrapper?.getText().slice(0, 100),
              callbacks: ts.isCallExpression(wrapper)
                ? resolve(wrapper.arguments[1])
                : resolve(wrapper),
              guard: ts.isCallExpression(wrapper) ? property(wrapper.expression) : null,
              conditions: conditions.reverse(),
              loop
            });
          }
          if (['runWithSuperAdmin', 'withJobLock', 'withReplicaLocalJobGuard'].includes(nm)) {
            roots.push({
              ...record,
              kind: nm,
              callbacks: resolve(args[nm === 'runWithSuperAdmin' ? 0 : 1])
            });
          }
          if (nm === '$transaction' && !record.file.endsWith('/lib/prisma.js')) {
            residualRoots.push({
              ...record,
              kind: 'bare-transaction',
              callbacks: resolve(args[0])
            });
          }
          if (
            ['setTenant', 'setTenantTx'].includes(nm) &&
            /readOnly\s*:\s*true\b/.test(args[2]?.getText() || '')
          ) {
            residualRoots.push({
              ...record,
              kind: 'read-only-transaction',
              context: callbackContext(n),
              callbacks: resolve(args[1])
            });
          }
          if (['setInterval', 'setTimeout'].includes(nm)) {
            residualRoots.push({
              ...record,
              kind: 'timer-context-candidate',
              callbacks: resolve(args[0])
            });
          }
          if (owner === null) {
            residualRoots.push({
              ...record,
              kind: 'module-initializer',
              callbacks: resolve(expression)
            });
          }
          if (owner) {
            const direct = resolve(expression);
            for (const to of direct)
              functions.get(owner).edges.push({ to, at: record.line, context: null, kind: 'call' });
            for (const a of args) {
              const callbacks = resolve(a);
              if (ts.isObjectLiteralExpression(a))
                for (const p of a.properties) {
                  if (p.initializer) callbacks.push(...resolve(p.initializer));
                  if (ts.isShorthandPropertyAssignment(p)) callbacks.push(...resolve(p.name));
                }
              for (const to of new Set(callbacks))
                functions.get(owner).edges.push({
                  to,
                  at: record.line,
                  context: callbackContext(n),
                  kind: 'callback'
                });
            }
            if (
              !direct.length &&
              !raw &&
              !pg &&
              !orm &&
              (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression))
            ) {
              const sym = symbol(expression);
              const declarations = (sym?.declarations || [])
                .map(d => ({
                  file: rel(d.getSourceFile()),
                  line: line(d),
                  kind: ts.SyntaxKind[d.kind]
                }))
                .filter(
                  d => d.file.startsWith('apps/backend/') && !d.file.includes('node_modules')
                );
              if (declarations.length) pendingCalls.push({ ...record, declarations });
            }
          }
        }
      }
      ts.forEachChild(n, c => visit(c, owner));
    }
    visit(s);
  }
  function sqlParameters(n, seen = new Set()) {
    if (!n || seen.has(n) || ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) return [];
    seen.add(n);
    const out = [];
    for (const d of symbol(n)?.declarations || []) {
      if (ts.isParameter(d) && nodeToFunction.has(d.parent)) out.push(d);
      else if (d.initializer) out.push(...sqlParameters(d.initializer, seen));
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression))
      out.push(...sqlParameters(n.expression.expression, seen));
    if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n))
      out.push(...sqlParameters(n.expression, seen));
    return [...new Set(out)];
  }
  function ownFunction(n) {
    for (let p = n.parent; p; p = p.parent) if (nodeToFunction.has(p)) return nodeToFunction.get(p);
    return null;
  }
  function ultimateSqlCalls(parameter, seen = new Set()) {
    if (seen.has(parameter)) return [];
    seen.add(parameter);
    const wrapper = nodeToFunction.get(parameter.parent);
    const index = parameter.parent.parameters.indexOf(parameter);
    const out = [];
    for (const call of callSites.get(wrapper) || []) {
      const argument = call.arguments[index];
      const forwarded = sqlParameters(argument);
      if (forwarded.length)
        for (const p of forwarded) out.push(...ultimateSqlCalls(p, new Set(seen)));
      else out.push({ call, strings: texts(argument) });
    }
    return out;
  }
  const wrapperSql = [];
  const readOnlyFunctions = new Set();
  function markReadOnly(id) {
    if (readOnlyFunctions.has(id)) return;
    readOnlyFunctions.add(id);
    for (const edge of functions.get(id)?.edges || []) markReadOnly(edge.to);
  }
  for (const root of residualRoots.filter(row => row.kind === 'read-only-transaction'))
    for (const callback of root.callbacks) markReadOnly(callback);
  for (const q of sql) {
    const raw = rawNodes.get(q.id);
    if (!raw || !/^\$/.test(q.method)) continue;
    const parameters = sqlParameters(raw.argument);
    if (!parameters.length) continue;
    const callers = parameters.flatMap(p => ultimateSqlCalls(p));
    if (!callers.length) continue;
    q.dispatcher = true;
    q.tables = [];
    let boundContext = null;
    for (let p = raw.node.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const ctx = callbackContext(p);
        if (ctx) {
          boundContext = ctx;
          break;
        }
      }
    }
    const body =
      [...nodeToFunction.entries()].find(([, id]) => id === q.owner)?.[0]?.getText() || '';
    const readDispatcher = /\bif\s*\(isReadQuery\)/.test(body);
    const unique = new Set();
    for (const { call, strings } of callers) {
      const text = strings
        .filter(t => /\b(SELECT|WITH|INSERT|UPDATE|DELETE|FROM)\b/i.test(t))
        .join('\n-- possible fragment --\n');
      if (!text) continue;
      const read = /^\s*(SELECT|WITH)\b/i.test(text) || /\bRETURNING\b/i.test(text);
      if (readDispatcher && read !== /^\$queryRaw/.test(q.method)) continue;
      const id = `${key(call)}:via:${q.id}`;
      if (unique.has(id)) continue;
      unique.add(id);
      const owner = ownFunction(call);
      const derived = {
        id,
        file: rel(call.getSourceFile()),
        line: line(call),
        owner,
        expression: call.expression.getText(),
        method: q.method,
        sink: q.id,
        tables: tables(text),
        sql: text,
        boundContext,
        readOnly: readOnlyFunctions.has(q.owner),
        unknown: false
      };
      wrapperSql.push(derived);
      if (owner) functions.get(owner).sql.push(id);
    }
  }
  sql.push(...wrapperSql);
  function routeCallbacks(argument) {
    if (ts.isArrayLiteralExpression(argument)) return argument.elements.flatMap(routeCallbacks);
    return [
      ...resolve(argument),
      ...(ts.isCallExpression(argument) ? argument.arguments.flatMap(routeCallbacks) : [])
    ];
  }
  function traceRouter(router, context, mount, seen = new Set()) {
    if (!router || seen.has(router)) return;
    seen.add(router);
    let currentContext = context;
    const prefixContexts = new Map();
    for (const registration of routerRegistrations.get(router) || []) {
      const prefix = ts.isStringLiteralLike(registration.args[0]) ? registration.args[0].text : '';
      let registrationContext = prefixContexts.get(prefix) || currentContext;
      for (const argument of registration.args) {
        const value = argument.getText();
        if (['tenantRlsMiddleware', 'preAuthTenantContextMiddleware'].includes(value)) {
          registrationContext = 'tenant';
          if (prefix) prefixContexts.set(prefix, registrationContext);
          else currentContext = registrationContext;
          continue;
        }
        const callbacks = routeCallbacks(argument);
        if (callbacks.length)
          residualRoots.push({
            file: registration.file,
            line: registration.line,
            kind: 'pre-global-tenant-route',
            context: registrationContext,
            mount: `${mount}${prefix}`,
            callbacks
          });
        traceRouter(
          routerSymbol(argument),
          registrationContext,
          `${mount}${prefix}`,
          new Set(seen)
        );
      }
    }
  }
  for (const [router, registrations] of routerRegistrations) {
    if (
      !registrations.some(row => row.file === 'apps/backend/src/app.js' && row.receiver === 'app')
    )
      continue;
    const boundary = registrations.findIndex(row =>
      row.args.some(argument => argument.getText() === 'tenantRlsMiddleware')
    );
    if (boundary < 0) throw new Error('Cannot locate app global tenant middleware boundary');
    const prefix = registrations.slice(0, boundary);
    routerRegistrations.set(router, prefix);
    traceRouter(router, 'pre-global-tenant-route', '');
    routerRegistrations.set(router, registrations);
  }
  const registrySource = sources.find(
    s => rel(s) === 'apps/backend/src/services/events/pathwayProjectorRegistry.js'
  );
  const registryTargets = [];
  if (registrySource)
    walk(registrySource, n => {
      if (ts.isImportSpecifier(n)) registryTargets.push(...resolve(n.name));
    });
  for (const pending of pendingCalls) {
    if (
      pending.file === 'apps/backend/src/services/events/pathwayProjectorService.js' &&
      pending.expression === 'handler'
    ) {
      for (const to of new Set(registryTargets))
        functions
          .get(pending.owner)
          .edges.push({ to, at: pending.line, context: null, kind: 'frozen-projector-registry' });
      pending.resolution =
        'All function imports in the frozen generation-specific pathway projector registry; generation/event filters remain pending proof.';
    }
  }
  const queryById = new Map(sql.map(q => [q.id, q]));
  const reachers = new Map();
  const tracedFunctions = new Set();
  function trace(id, context, origin, route = [], visited = new Set()) {
    const visitKey = `${id}:${context}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const f = functions.get(id);
    if (!f) return;
    tracedFunctions.add(id);
    const chain = [...route, `${f.file}:${f.line} ${f.name}`];
    for (const qid of f.sql) {
      const q = queryById.get(qid);
      for (const table of q.tables) {
        const effectiveContext = q.boundContext || context;
        const rkey = `${table}:${qid}:${effectiveContext}`;
        if (!reachers.has(rkey))
          reachers.set(rkey, {
            ...q,
            table,
            context: effectiveContext,
            origins: [],
            samplePath: chain
          });
        const rec = reachers.get(rkey);
        if (!rec.origins.includes(origin)) rec.origins.push(origin);
      }
    }
    for (const edge of f.edges) trace(edge.to, edge.context || context, origin, chain, visited);
  }
  for (const job of registrations)
    for (const callback of job.callbacks) trace(callback, 'bypass', `job:${job.job}`);
  for (const r of roots.filter(r => r.kind === 'runWithSuperAdmin'))
    for (const callback of r.callbacks) trace(callback, 'bypass', `entry:${r.file}:${r.line}`);
  for (const r of residualRoots)
    for (const callback of r.callbacks)
      trace(callback, r.context || r.kind, `residual:${r.kind}:${r.file}:${r.line}`);
  for (const f of functions.values())
    if (f.file.endsWith('/bin/www.js')) trace(f.id, 'startup', `startup:${f.file}:${f.line}`);
  for (const q of sql) {
    if (q.owner !== null && !q.expression.includes('prismaReadOnly') && !q.readOnly) continue;
    for (const table of q.tables) {
      const context = q.owner === null ? 'module-sql' : q.boundContext || 'read-only-client';
      reachers.set(`${table}:${q.id}:${context}`, {
        ...q,
        table,
        context,
        origins: [`residual:${context}:${q.file}:${q.line}`],
        samplePath: []
      });
    }
  }
  const result = {
    method:
      'Static symbol and callback trace with separately reported unresolved expressions; no jobs executed and no policy or behavior change.',
    targetTables: [...targets],
    sourceManifest: sources
      .map(s => ({
        file: rel(s),
        sha256: createHash('sha256').update(s.text.replaceAll('\r\n', '\n')).digest('hex')
      }))
      .sort((a, b) => a.file.localeCompare(b.file, 'en')),
    registrationErrors,
    directPgImports,
    unresolvedSql: sql
      .filter(
        row =>
          row.unknown &&
          !row.dispatcher &&
          (tracedFunctions.has(row.owner) || row.expression.includes('prismaReadOnly'))
      )
      .map(({ id, file, line, expression, owner }) => ({
        id,
        file,
        line,
        expression,
        function: functions.get(owner)?.name
      })),
    callbackBoundaries: pendingCalls
      .filter(row => tracedFunctions.has(row.owner))
      .map(({ file, line, expression, declarations, resolution }) => ({
        file,
        line,
        expression,
        declarations,
        resolution:
          resolution ||
          'Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.'
      })),
    counts: {
      sources: sources.length,
      functions: functions.size,
      registrations: registrations.length,
      roots: roots.length,
      residualRoots: residualRoots.length,
      sql: sql.length,
      targetSql: sql.filter(q => q.tables.length).length,
      reachingTableStatementsByContext: reachers.size
    },
    registrations,
    roots,
    residualRoots,
    reachers: [...reachers.values()],
    pendingCalls,
    sql,
    functions: [...functions.values()]
  };
  return result;
}
