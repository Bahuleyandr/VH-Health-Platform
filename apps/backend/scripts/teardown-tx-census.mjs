#!/usr/bin/env node
// Census of `users` / `tenants` deletes in the backend test corpus, and of the
// two DISTINCT defects a teardown can carry. Static: it parses JavaScript, it
// never imports the application and never connects to a database.
//
// WHY THIS EXISTS. The 2026-09-08 census that produced the "41 files, 36
// mitigated, 5 in class" figures lived only in the bodies of PR #1048 / #1050,
// never as a repo script, and its arm matched the LITERAL text
// `DELETE FROM users` / `DELETE FROM tenants` inside a transaction call's
// balanced argument. Suites that delete the same two tables through a
// `DELETE FROM ${table}` loop over an array containing 'users' were invisible
// to it, and `session_replication_role = 'replica'` appearing anywhere in the
// file was read as a mitigation. Both readings are wrong, in opposite
// directions: the loop hides the delete, and the replica window is the defect
// rather than the fix. This script re-derives the population with both arms
// and prints the predicate beside every count.
//
// THE TWO DEFECTS. They are separable: a file can carry either alone.
//
//   (a) SUPPRESSED CASCADE. `users` or `tenants` deleted while
//       `session_replication_role = 'replica'` is in effect. The role
//       suppresses the internal ON DELETE triggers, so the 19 CASCADE and 105
//       SET NULL foreign keys referencing `users` (310 CASCADE referencing
//       `tenants`) do not fire and their children survive the parent row.
//       Measured on med03-billing-safety-regressions: 3 orphaned
//       `pharmacy_patient_safety_versions` rows per run, 0 after the delete
//       moved to phase 2 at 'origin'. The delete looks fast because it is not
//       doing the work: 0.551 ms under replica against 6,626.9 ms at origin.
//       A suite with defect (a) can be nowhere near any transaction budget.
//
//   (b) FAN-OUT INSIDE AN INTERACTIVE TRANSACTION. `users` or `tenants`
//       deleted at 'origin' inside a Prisma interactive transaction. Every
//       referencing foreign key costs one trigger call (466 reference `users`,
//       791 reference `tenants` at schema >= migration 790), which is seconds
//       of real work held inside a budget the suite declared. On expiry Prisma
//       rolls the WHOLE transaction back, so the earlier evidence deletes are
//       undone too and the fixture survives; a teardown that swallows the
//       error then reports the suite green.
//
// The accepted fix pattern is src/tests/helpers/tenantTeardown.js (phase 1:
// the evidence deletes in one short transaction under `app.audit_bypass`;
// phase 2: the users/tenants deletes as autocommit statements at 'origin').
// This script does not edit or propose edits to any suite; it counts.
//
// USAGE
//   node scripts/teardown-tx-census.mjs                 # JSON to stdout
//   node scripts/teardown-tx-census.mjs --write [--revision <sha>]
//   node scripts/teardown-tx-census.mjs --check         # regenerate + compare
//
// `--check` regenerates using the revision recorded in the committed JSON, so
// the comparison is revision-neutral. Nothing in this file wires a CI gate.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

import { computeCounts } from './lib/teardown-census-counts.mjs';

export const SCHEMA = 'teardown-tx-census/v1';

// ---------------------------------------------------------------------------
// Predicates. Every count in the output names the predicate that produced it;
// these strings are the single source of that text.
// ---------------------------------------------------------------------------

export const PREDICATES = {
  files:
    'Every file under apps/backend/src/tests, recursively, whose name matches '
    + '/\\.(js|mjs|cjs)$/. No other filter: helpers, fixtures and non-.test.js '
    + 'files are included, because a delete behind a helper is still a delete. '
    + 'Files that fail to parse are reported under parseFailures and are NOT '
    + 'counted as clean.',
  literalDelete:
    'A string literal or template literal whose text matches '
    + '/\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?"?([A-Za-z_][\\w$]*)"?/i and whose '
    + 'captured relation is `users` or `tenants`. This is the arm the '
    + '2026-09-08 census had.',
  dynamicDelete:
    'A template literal whose text matches /\\bDELETE\\s+FROM\\s+/i with a '
    + 'substituted expression in the relation position. When that expression is '
    + 'an Identifier bound by an enclosing for-of - either directly, '
    + '`for (const t of SOURCE)`, or through an array pattern, '
    + '`for (const [t, column] of SOURCE)` - SOURCE is resolved to string '
    + 'literals through: inline array expressions, same-file variables whose '
    + 'initialiser is an array (transitively, with a cycle guard), '
    + 'Object.freeze(<array>), and spread elements of any of those. The delete '
    + 'then targets every resolved name. A source that resolves to SOME names '
    + 'but not all is kind `dynamic-partial`: the names it did resolve count as '
    + 'hits, its silence does not count as absence. Anything that resolves to no '
    + 'names at all (member expression, call, concatenation, a name declared '
    + 'outside the file, a name with conflicting declarations) is `unresolved`. '
    + 'Both are reported, never dropped.',
  replicaWindow:
    'LEXICAL APPROXIMATION. Toggle statements are string/template literals '
    + "matching /session_replication_role\\s*(?:=|\\bTO\\b)\\s*'?([A-Za-z]+)/i; "
    + '`replica` opens a window, any other value closes it. Windows are '
    + 'computed per toggle-scope = the nearest enclosing function body (or '
    + 'Program) of the toggle, over character offsets: a window runs from the '
    + 'end of the opening toggle to the start of the next closing toggle in the '
    + 'same scope, or to the end of that scope when none follows (which is what '
    + 'SET LOCAL does at COMMIT). A delete is `inside` when its start offset '
    + 'falls in such a window. Stated limits are in the `limits` field.',
  transaction:
    'A delete is `inTransaction` when it lies inside a function expression '
    + 'passed as an argument to a call in the recognised set, or is itself a '
    + 'direct argument of such a call. Recognised set: '
    + '$transaction, setTenantTx, setTenant, withAuditBypass, '
    + 'deleteWithAuditBypass, teardownTenantFixture. Additionally, a function '
    + 'declared in the SAME file that forwards one of its own parameters into a '
    + 'recognised call is itself recognised (one hop, resolved lexically); such '
    + 'a hit is labelled local-wrapper:<name>. A callback passed as a PROPERTY '
    + 'of an options object argument counts too - '
    + 'teardownTenantFixture(prisma, { evidence: async (tx) => ... }) is the '
    + 'shape the accepted fix pattern uses - and is labelled <call>#<property>. '
    + 'Deeper indirection and cross-file wrappers are NOT followed.',
  helper:
    'A file `usesTenantTeardownHelper` when it names '
    + 'helpers/tenantTeardown.js or calls teardownTenantFixture.',
  classA:
    'Class (a) suppressed-cascade: at least one delete whose relation is '
    + '`users` or `tenants` is inside a replica window. aUsers / aTenants split '
    + 'the two relations; the 2026-09-09 brief defines (a) on `users`, and '
    + '`tenants` is reported beside it because 310 CASCADE foreign keys '
    + 'reference tenants and a replica-role tenant delete skips them too.',
  classB:
    'Class (b) fan-out-in-transaction: at least one delete whose relation is '
    + '`users` or `tenants` is NOT inside a replica window AND is inTransaction.',
  classUnknown:
    'Class `unknown`: the file has an unresolved or partially resolved dynamic '
    + 'delete and no (a) or (b) hit. It is NOT evidence of safety - the arm '
    + 'could not read what the delete targets.',
};

export const LIMITS = [
  'The replica window is lexical. A delete executed by a function CALLED from '
  + 'inside the window (a helper, an imported cleanup) is reported `outside`, '
  + 'though at runtime the session role still applies. Under-counts (a).',
  'The converse: a delete that merely sits lexically inside the window but runs '
  + 'later (a callback stored and invoked elsewhere) is reported `inside`. '
  + 'Over-counts (a).',
  'A toggle inside an `if`/`try` branch is treated as unconditional, and a '
  + 'toggle string that is never executed (an assertion of expected SQL text) '
  + 'is indistinguishable lexically from one that is.',
  'A toggle whose SQL is built from a variable, or issued through a Prisma '
  + 'model API rather than raw SQL text, is invisible to the toggle scan.',
  'Relation names built by concatenation, read from a config module, or looped '
  + 'over an array assembled at runtime resolve to UNRESOLVED. They are counted '
  + 'and listed, never treated as absent.',
  'The transaction arm follows ONE hop of same-file wrapper. A delete two '
  + 'wrappers deep, or behind a wrapper imported from another file that is not '
  + 'in the recognised set, is reported inTransaction=false. Under-counts (b).',
  'Effective transaction budgets are not read: (b) says the delete is inside an '
  + 'interactive transaction, not that it exceeds that suite\'s timeout. Of the '
  + 'five suites converted before this census only one was on the 5,000 ms '
  + 'default.',
  'An explicit `BEGIN` / `COMMIT` pair issued through a raw pg client is NOT '
  + 'counted as a transaction, and that is deliberate: (b) is about the Prisma '
  + 'interactive-transaction budget, which such a block does not have. It is '
  + 'still one transaction holding the whole fan-out, so it can still be slow '
  + 'and it is still subject to statement_timeout - it is simply not defect (b). '
  + 'cath-readiness-expansion.deep.test.js is the corpus example.',
  'Only apps/backend/src/tests is walked. A delete in a script, a seeder or '
  + 'another workspace is out of scope by construction.',
];

const RECOGNISED_TRANSACTION_CALLS = Object.freeze([
  '$transaction',
  'setTenantTx',
  'setTenant',
  'withAuditBypass',
  'deleteWithAuditBypass',
  'teardownTenantFixture',
]);

export const TARGET_RELATIONS = Object.freeze(['users', 'tenants']);

const DELETE_TEXT = /\bDELETE\s+FROM\s+/i;
const DELETE_RELATION = /\bDELETE\s+FROM\s+(?:ONLY\s+)?"?([A-Za-z_][\w$]*)"?/i;
const TOGGLE = /session_replication_role\s*(?:=|\bTO\b)\s*'?([A-Za-z]+)/i;
const REPLICA_OPEN = 'replica';
const PLACEHOLDER = '\u0000';

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function isFunctionNode(node) {
  return node.type === 'ArrowFunctionExpression'
    || node.type === 'FunctionExpression'
    || node.type === 'FunctionDeclaration';
}

function walkWithParents(root, visit) {
  const stack = [{ node: root, parents: [] }];
  while (stack.length > 0) {
    const { node, parents } = stack.pop();
    visit(node, parents);
    const chain = [...parents, node];
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && child.type) stack.push({ node: child, parents: chain });
        }
      } else if (value && typeof value === 'object' && value.type) {
        stack.push({ node: value, parents: chain });
      }
    }
  }
}

// Text of a string-ish node with each substituted expression replaced by one
// NUL, so the count of NULs before a match identifies the expression.
function stringishText(node) {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node.type !== 'TemplateLiteral') return null;
  let text = '';
  node.quasis.forEach((quasi, index) => {
    text += quasi.value.cooked ?? quasi.value.raw;
    if (index < node.expressions.length) text += PLACEHOLDER;
  });
  return text;
}

function callName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    return callee.property?.name ?? (typeof callee.property?.value === 'string' ? callee.property.value : null);
  }
  return null;
}

function nearestFunction(parents) {
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    if (isFunctionNode(parents[index])) return parents[index];
  }
  return null;
}

// A list of relation names, and whether anything in it could not be read.
// `partial: true` means the names present are real but the list is incomplete,
// so a hit on them still counts while an absence proves nothing.
function emptyList() {
  return { names: [], partial: false, reasons: [] };
}

function mergeList(target, source) {
  target.names.push(...source.names);
  if (source.partial) target.partial = true;
  target.reasons.push(...source.reasons);
  return target;
}

// `Object.freeze([...])` and `[...].map(String)`-free wrappers are unwrapped so
// the idiom the corpus actually uses resolves instead of reporting unknown.
function unwrapArrayExpression(node) {
  if (node?.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && node.callee.object?.name === 'Object'
    && node.callee.property?.name === 'freeze'
    && node.arguments.length === 1) {
    return unwrapArrayExpression(node.arguments[0]);
  }
  return node;
}

/**
 * Resolve an expression to the relation names it can contribute.
 * @param {object} node
 * @param {(name: string, seen: Set<string>) => object} resolveVariable
 * @param {Set<string>} seen cycle guard for variable references
 */
function resolveNameList(node, resolveVariable, seen = new Set()) {
  const unwrapped = unwrapArrayExpression(node);
  if (!unwrapped) return { names: [], partial: true, reasons: ['missing initialiser'] };
  if (unwrapped.type === 'Identifier') return resolveVariable(unwrapped.name, seen);
  if (unwrapped.type !== 'ArrayExpression') {
    return { names: [], partial: true, reasons: [`expression is ${unwrapped.type}`] };
  }
  const list = emptyList();
  for (const element of unwrapped.elements) {
    if (element && element.type === 'Literal' && typeof element.value === 'string') {
      list.names.push(element.value);
    } else if (element && element.type === 'SpreadElement') {
      mergeList(list, resolveNameList(element.argument, resolveVariable, seen));
    } else {
      list.partial = true;
      list.reasons.push(`element is ${element?.type ?? 'a hole'}`);
    }
  }
  return list;
}

function forwardsParameterIntoTransaction(fn) {
  const parameters = new Set(fn.params.filter((p) => p.type === 'Identifier').map((p) => p.name));
  if (parameters.size === 0) return false;
  let forwards = false;
  walkWithParents(fn.body, (node) => {
    if (forwards || node.type !== 'CallExpression') return;
    if (!RECOGNISED_TRANSACTION_CALLS.includes(callName(node.callee))) return;
    const carries = (argument) => {
      if (!argument) return false;
      if (argument.type === 'Identifier') return parameters.has(argument.name);
      if (isFunctionNode(argument)) {
        let used = false;
        walkWithParents(argument.body, (inner) => {
          if (inner.type === 'Identifier' && parameters.has(inner.name)) used = true;
        });
        return used;
      }
      return false;
    };
    if (node.arguments.some(carries)) forwards = true;
  });
  return forwards;
}

// The position `name` occupies in a for-of binding, or null when it is not
// bound by this loop. `Identifier` -> the whole element; `ArrayPattern` -> the
// index inside each element, which is how `for (const [table, column] of ...)`
// reaches the relation.
function bindingPosition(left, name) {
  const target = left.type === 'VariableDeclaration' ? left.declarations[0]?.id : left;
  if (target?.type === 'Identifier') return target.name === name ? { kind: 'whole' } : null;
  if (target?.type === 'ArrayPattern') {
    const index = target.elements.findIndex((element) => element?.type === 'Identifier' && element.name === name);
    return index >= 0 ? { kind: 'index', index } : null;
  }
  return null;
}

function resolveDynamicRelation(expression, parents, resolveVariable) {
  if (!expression || expression.type !== 'Identifier') {
    return { kind: 'unresolved', relations: [], binding: `relation expression is ${expression?.type ?? 'missing'}` };
  }
  const name = expression.name;
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const node = parents[index];
    if (node.type !== 'ForOfStatement' && node.type !== 'ForInStatement') continue;
    const position = bindingPosition(node.left, name);
    if (!position) continue;
    if (node.type === 'ForInStatement') {
      return { kind: 'unresolved', relations: [], binding: `${name} is bound by for-in over <${node.right.type}>` };
    }
    const source = node.right.type === 'Identifier'
      ? `for (const ... of ${node.right.name})`
      : `for (const ... of <${node.right.type}>)`;

    if (position.kind === 'index') {
      // Each element must itself be an array literal; take the slot.
      const outer = unwrapArrayExpression(node.right);
      if (outer?.type !== 'ArrayExpression') {
        return { kind: 'unresolved', relations: [], binding: `${source} destructured at [${position.index}] over a non-literal source` };
      }
      const list = emptyList();
      for (const element of outer.elements) {
        const inner = unwrapArrayExpression(element);
        const slot = inner?.type === 'ArrayExpression' ? inner.elements[position.index] : null;
        if (slot && slot.type === 'Literal' && typeof slot.value === 'string') list.names.push(slot.value);
        else {
          list.partial = true;
          list.reasons.push(`element ${inner?.type ?? 'missing'} has no literal at [${position.index}]`);
        }
      }
      return finishResolution(list, `${source} destructured at [${position.index}]`);
    }

    return finishResolution(resolveNameList(node.right, resolveVariable), source);
  }
  return { kind: 'unresolved', relations: [], binding: `${name} is not bound by an enclosing for-of` };
}

function finishResolution(list, source) {
  const relations = list.names.map((item) => item.toLowerCase());
  const reasons = [...new Set(list.reasons)].join('; ');
  if (relations.length === 0) {
    return { kind: 'unresolved', relations: [], binding: `${source}: ${reasons || 'resolved to no names'}` };
  }
  return {
    kind: list.partial ? 'dynamic-partial' : 'dynamic',
    relations,
    binding: list.partial ? `${source}, partially resolved: ${reasons}` : source,
  };
}

// Every relation a single DELETE-bearing string targets. One string can carry
// several DELETE statements; each is a site.
function deleteSites(entry, resolveVariable) {
  const sites = [];
  const text = entry.text;
  const pattern = /\bDELETE\s+FROM\s+/gi;
  let match = pattern.exec(text);
  while (match !== null) {
    const consumed = match.index + match[0].length;
    if (text.slice(consumed).startsWith(PLACEHOLDER)) {
      const index = text.slice(0, consumed).split(PLACEHOLDER).length - 1;
      sites.push(resolveDynamicRelation(entry.node.expressions?.[index], entry.parents, resolveVariable));
    } else {
      const relation = DELETE_RELATION.exec(text.slice(match.index));
      if (relation) sites.push({ kind: 'literal', relations: [relation[1].toLowerCase()], binding: null });
      else sites.push({ kind: 'unresolved', relations: [], binding: 'relation token unparsed' });
    }
    match = pattern.exec(text);
  }
  return sites;
}

function transactionContext(parents, node, recognisedCalls, localWrappers) {
  const label = (name) => (localWrappers.has(name) && !RECOGNISED_TRANSACTION_CALLS.includes(name)
    ? `local-wrapper:${name}`
    : name);
  // The SQL passed straight to a recognised call, e.g. deleteWithAuditBypass().
  const direct = parents.at(-1);
  if (direct?.type === 'CallExpression' && direct.arguments.includes(node)) {
    const name = callName(direct.callee);
    if (name && recognisedCalls.has(name)) return label(name);
  }
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const candidate = parents[index];
    if (!isFunctionNode(candidate)) continue;
    // The callback passed as a bare argument: $transaction(async (tx) => ...).
    const parent = parents[index - 1];
    if (parent?.type === 'CallExpression' && parent.arguments.includes(candidate)) {
      const name = callName(parent.callee);
      if (name && recognisedCalls.has(name)) return label(name);
    }
    // The callback passed as a property of an options object, which is the
    // shape the accepted fix pattern uses:
    //   teardownTenantFixture(prisma, { evidence: async (tx) => ... })
    // Its `evidence` callback runs inside phase 1's interactive transaction, so
    // a delete there IS in a transaction. Without this the one construction the
    // conversion programme is standardising on would read as untransacted.
    if (parent?.type === 'Property' && parent.value === candidate) {
      const object = parents[index - 2];
      const call = parents[index - 3];
      if (object?.type === 'ObjectExpression'
        && call?.type === 'CallExpression'
        && call.arguments.includes(object)) {
        const name = callName(call.callee);
        if (name && recognisedCalls.has(name)) {
          const key = parent.key?.name ?? parent.key?.value;
          return `${label(name)}#${key ?? '<computed>'}`;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

/**
 * Analyse one source file. Pure: no filesystem, no database.
 * @param {string} source
 * @param {string} path repo-relative, forward slashes
 */
export function analyzeSource(source, path) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

  // --- Pass 1: index the string-ish nodes, array variables and local wrappers.
  // walkWithParents is depth-first over an explicit stack, so it does NOT visit
  // in source order. Everything collected here is either sorted before use or
  // order-independent, so the output does not depend on traversal order.
  const stringish = [];
  const arrayDeclarations = new Map();
  const localWrappers = new Set();

  walkWithParents(ast, (node, parents) => {
    if (node.type === 'Literal' || node.type === 'TemplateLiteral') {
      const text = stringishText(node);
      if (text !== null) stringish.push({ node, parents, text });
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      if (!arrayDeclarations.has(node.id.name)) arrayDeclarations.set(node.id.name, []);
      arrayDeclarations.get(node.id.name).push(node.init);
    }
    if (isFunctionNode(node)) {
      const name = node.id?.name
        ?? (parents.at(-1)?.type === 'VariableDeclarator' ? parents.at(-1).id?.name : null);
      if (name && forwardsParameterIntoTransaction(node)) localWrappers.add(name);
    }
  });
  stringish.sort((left, right) => left.node.start - right.node.start);
  for (const declarations of arrayDeclarations.values()) {
    declarations.sort((left, right) => left.start - right.start);
  }

  // Resolve a name to the relation list it can contribute. Memoised, with a
  // cycle guard. A name declared more than once is only usable when every
  // declaration yields the same list; otherwise the answer would depend on
  // which declaration the traversal happened to reach first.
  const memo = new Map();
  const resolveVariable = (name, seen) => {
    if (seen.has(name)) return { names: [], partial: true, reasons: [`${name} resolves through itself`] };
    if (memo.has(name)) return memo.get(name);
    const declarations = arrayDeclarations.get(name);
    if (!declarations) return { names: [], partial: true, reasons: [`${name} is not declared in this file`] };
    const nested = new Set([...seen, name]);
    const resolved = declarations.map((init) => resolveNameList(init, resolveVariable, nested));
    const distinct = new Set(resolved.map((item) => JSON.stringify([item.names, item.partial])));
    const answer = distinct.size === 1
      ? resolved[0]
      : { names: [], partial: true, reasons: [`${name} is declared ${declarations.length} times with different initialisers`] };
    // Only a top-level resolution is cacheable: one computed under an active
    // cycle guard is specific to that guard.
    if (seen.size === 0) memo.set(name, answer);
    return answer;
  };

  const recognisedCalls = new Set([...RECOGNISED_TRANSACTION_CALLS, ...localWrappers]);

  // --- Pass 2: replica windows, per toggle-scope.
  const togglesByScope = new Map();
  for (const entry of stringish) {
    const match = TOGGLE.exec(entry.text);
    if (!match) continue;
    const scope = nearestFunction(entry.parents) ?? ast;
    if (!togglesByScope.has(scope)) togglesByScope.set(scope, []);
    togglesByScope.get(scope).push({ offset: entry.node.start, end: entry.node.end, mode: match[1].toLowerCase() });
  }
  const replicaWindows = [];
  for (const [scope, toggles] of togglesByScope) {
    toggles.sort((a, b) => a.offset - b.offset);
    let open = null;
    for (const toggle of toggles) {
      if (toggle.mode === REPLICA_OPEN) {
        if (open === null) open = toggle.end;
      } else if (open !== null) {
        replicaWindows.push({ start: open, end: toggle.offset });
        open = null;
      }
    }
    if (open !== null) replicaWindows.push({ start: open, end: scope.end });
  }
  replicaWindows.sort((a, b) => a.start - b.start);
  const insideReplica = (offset) => replicaWindows.some((w) => offset >= w.start && offset < w.end);

  // --- Pass 3: the deletes.
  const deletes = [];
  let otherRelationDeletes = 0;
  for (const entry of stringish) {
    if (!DELETE_TEXT.test(entry.text)) continue;
    for (const site of deleteSites(entry, resolveVariable)) {
      const targeted = site.relations.filter((relation) => TARGET_RELATIONS.includes(relation));
      // A fully resolved site that targets neither table is just counted. An
      // unresolved or partially resolved one is RECORDED even when it shows no
      // target, because its silence is not evidence of absence.
      if (site.kind !== 'unresolved' && site.kind !== 'dynamic-partial' && targeted.length === 0) {
        otherRelationDeletes += 1;
        continue;
      }
      const via = transactionContext(entry.parents, entry.node, recognisedCalls, localWrappers);
      deletes.push({
        line: entry.node.loc.start.line,
        kind: site.kind,
        // For a dynamic site the resolved list can be long; only the relations
        // this census is about are kept, plus the size of the resolved list so
        // a reader can tell a two-name loop from a fifty-name purge.
        relations: targeted,
        resolvedRelationCount: site.relations.length,
        binding: site.binding,
        replica: insideReplica(entry.node.start) ? 'inside' : 'outside',
        inTransaction: via !== null,
        transactionVia: via,
      });
    }
  }

  const hits = (relation, predicate) => deletes.some(
    (item) => item.relations.includes(relation) && predicate(item),
  );
  const aUsers = hits('users', (item) => item.replica === 'inside');
  const aTenants = hits('tenants', (item) => item.replica === 'inside');
  const bUsers = hits('users', (item) => item.replica === 'outside' && item.inTransaction);
  const bTenants = hits('tenants', (item) => item.replica === 'outside' && item.inTransaction);
  const unresolved = deletes.filter((item) => item.kind === 'unresolved');
  const partiallyResolved = deletes.filter((item) => item.kind === 'dynamic-partial');

  const a = aUsers || aTenants;
  const b = bUsers || bTenants;
  let classification = 'none';
  if (a && b) classification = 'both';
  else if (a) classification = 'a';
  else if (b) classification = 'b';
  else if (unresolved.length + partiallyResolved.length > 0) classification = 'unknown';

  return {
    file: path,
    classification,
    a: { users: aUsers, tenants: aTenants },
    b: { users: bUsers, tenants: bTenants },
    usesTenantTeardownHelper:
      source.includes('helpers/tenantTeardown.js') || /\bteardownTenantFixture\s*\(/.test(source),
    hasReplicaWindow: replicaWindows.length > 0,
    localWrappers: [...localWrappers].sort(),
    unresolvedDynamicDeletes: unresolved.length,
    partiallyResolvedDynamicDeletes: partiallyResolved.length,
    otherRelationDeletes,
    deletes,
  };
}

// ---------------------------------------------------------------------------
// Corpus walk
// ---------------------------------------------------------------------------

const BACKEND_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const TEST_ROOT = join(BACKEND_ROOT, 'src', 'tests');

export function testSources(root = TEST_ROOT) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return testSources(path);
    return /\.(?:js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  }).sort();
}

export function census({ revision = null, root = TEST_ROOT } = {}) {
  const files = testSources(root);
  const records = [];
  const parseFailures = [];
  let filesUsingHelper = 0;
  for (const path of files) {
    const relativePath = `apps/backend/src/tests/${relative(root, path).replaceAll('\\', '/')}`;
    const source = readFileSync(path, 'utf8');
    if (source.includes('helpers/tenantTeardown.js') || /\bteardownTenantFixture\s*\(/.test(source)) {
      filesUsingHelper += 1;
    }
    try {
      const record = analyzeSource(source, relativePath);
      if (record.deletes.length > 0) records.push(record);
    } catch (error) {
      // ONLY a parser rejection is a parse failure. A defect in this script
      // must not be able to hide in that bucket: during development a stray
      // reference turned every dynamic-arm file into a "parse failure" and the
      // dynamic count silently read 0. Rethrow anything that is not acorn's.
      if (!(error instanceof SyntaxError)) {
        throw new Error(`teardown-tx-census failed on ${relativePath}: ${error?.stack ?? error}`);
      }
      parseFailures.push({ file: relativePath, error: String(error?.message ?? error) });
    }
  }
  records.sort((a, b) => a.file.localeCompare(b.file));

  // The count expressions live in ./lib/teardown-census-counts.mjs so this
  // artifact and the CI gate that re-checks it cannot drift apart. Today's
  // corpus exercises only two of the four delete kinds, which makes several
  // competing rules produce identical numbers - a second hand-written copy
  // "matches" without being right.
  const counts = computeCounts(records, {
    filesWalked: files.length,
    parseFailureCount: parseFailures.length,
    filesUsingHelper,
  });

  return {
    schema: SCHEMA,
    kind: 'CENSUS_ONLY',
    revision,
    predicates: PREDICATES,
    limits: LIMITS,
    recognisedTransactionCalls: RECOGNISED_TRANSACTION_CALLS,
    targetRelations: TARGET_RELATIONS,
    counts,
    parseFailures,
    files: records,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const CLASS_LABEL = { a: '(a)', b: '(b)', both: 'both', none: 'none', unknown: 'unknown' };

const isDynamic = (item) => item.kind === 'dynamic' || item.kind === 'dynamic-partial';

function relationSummary(record) {
  const parts = [];
  if (record.a.users) parts.push('users@replica');
  if (record.a.tenants) parts.push('tenants@replica');
  if (record.b.users) parts.push('users@origin-in-tx');
  if (record.b.tenants) parts.push('tenants@origin-in-tx');
  if (record.unresolvedDynamicDeletes > 0) parts.push(`${record.unresolvedDynamicDeletes} unresolved`);
  return parts.length > 0 ? parts.join(', ') : 'users/tenants deleted outside any transaction';
}

export function renderMarkdown(data) {
  const { counts } = data;
  const lines = [];
  const escape = (text) => text.replaceAll('|', '\\|');
  lines.push('# Teardown transaction census - `users` / `tenants` deletes in the backend test corpus');
  lines.push('');
  lines.push(`Generated by \`node apps/backend/scripts/teardown-tx-census.mjs --write\`${data.revision ? ` at \`${data.revision}\`` : ''}. **Census only.** No suite is edited here, no disposition is accepted, and no suite is claimed safe.`);
  lines.push('');
  lines.push('This replaces the 2026-09-08 predicate that lived only in the bodies of PR #1048 and PR #1050. That arm matched the literal text `DELETE FROM users` / `DELETE FROM tenants` inside a transaction call, and read `session_replication_role = \'replica\'` appearing in the file as a mitigation. It was wrong in both directions: a `DELETE FROM ${table}` loop over an array containing `users` was invisible to it, and the replica window is a defect rather than a fix.');
  lines.push('');
  lines.push('## The two defects');
  lines.push('');
  lines.push('They are separable. A file can carry either alone, and neither implies the other.');
  lines.push('');
  lines.push('- **(a) suppressed cascade** - `users` or `tenants` deleted while `session_replication_role = \'replica\'` is in effect. The internal ON DELETE triggers do not fire, so the 19 CASCADE and 105 SET NULL foreign keys referencing `users` (310 CASCADE referencing `tenants`) leave children behind. Measured on `med03-billing-safety-regressions`: 3 orphaned `pharmacy_patient_safety_versions` rows per run, 0 once the delete moved to phase 2 at `origin`. The delete reads as fast because it is not doing the work - 0.551 ms under replica against 6,626.9 ms at origin. A suite with (a) can sit nowhere near any transaction budget.');
  lines.push('- **(b) fan-out inside an interactive transaction** - `users` or `tenants` deleted at `origin` inside a Prisma interactive transaction. 466 foreign keys reference `users` and 791 reference `tenants` at schema >= migration 790; each is one trigger call. On expiry Prisma rolls the whole transaction back, undoing the evidence deletes too, and a teardown that swallows the error reports the suite green.');
  lines.push('');
  lines.push('## Counts, each beside the predicate that produced it');
  lines.push('');
  lines.push('| Count | Value | Predicate |');
  lines.push('|---|---:|---|');
  const row = (label, value, predicate) => lines.push(`| ${label} | ${value} | ${escape(predicate)} |`);
  row('Files walked', counts.filesWalked, data.predicates.files);
  row('Parse failures', counts.parseFailures, 'A file the parser rejected. Not counted as clean; listed below.');
  row('Files carrying a `users`/`tenants` delete or an unresolved dynamic delete', counts.filesWithTargetDelete, `${data.predicates.literalDelete} OR ${data.predicates.dynamicDelete}`);
  row('... reached by the literal arm', counts.filesReachedByLiteralArm, data.predicates.literalDelete);
  row('... reached by the dynamic arm', counts.filesReachedByDynamicArm, data.predicates.dynamicDelete);
  row('... reached ONLY by the dynamic arm', counts.filesReachedOnlyByDynamicArm, 'The file has a resolved dynamic `users`/`tenants` delete and no literal one at all.');
  row('... with a dynamic `users` delete and no literal `users` delete', counts.filesWithDynamicUsersAndNoLiteralUsers, 'The exact blind spot of the 2026-09-08 census: `users` reached only through the loop.');
  row('Class (a)', counts.classA, data.predicates.classA);
  row('Class (b)', counts.classB, data.predicates.classB);
  row('Class both', counts.classBoth, 'Both (a) and (b) hold for the file.');
  row('Class none', counts.classNone, 'Neither holds and nothing was unresolved. The file deletes `users`/`tenants` outside every replica window and outside every recognised transaction - the shape the helper produces.');
  row('Class unknown', counts.classUnknown, data.predicates.classUnknown);
  row('Files with a `users` delete under replica', counts.aUsers, 'A `users` delete inside a replica window.');
  row('Files with a `tenants` delete under replica', counts.aTenants, 'A `tenants` delete inside a replica window.');
  row('Files with a `users` delete at origin in a transaction', counts.bUsers, 'A `users` delete outside every replica window and inside a recognised transaction callback.');
  row('Files with a `tenants` delete at origin in a transaction', counts.bTenants, 'A `tenants` delete outside every replica window and inside a recognised transaction callback.');
  row('Files using `tenantTeardown.js` (whole corpus)', counts.filesUsingTenantTeardownHelper, `${data.predicates.helper} Counted over every walked file, including the ones this table does not list because they have no remaining users/tenants delete of their own - which is exactly what a converted suite looks like.`);
  row('... of those, still carrying a users/tenants delete of their own', counts.filesUsingHelperAndStillDeletingTargets, 'The file both calls the helper and still deletes one of the two tables directly.');
  row('Files with an UNRESOLVED dynamic delete', counts.filesWithUnresolvedDynamicDelete, 'The relation expression resolved to no names at all. Counted, never dropped.');
  row('Files with a PARTIALLY resolved dynamic delete', counts.filesWithPartiallyResolvedDynamicDelete, 'Some names in the source array resolved and some did not: hits count, absence does not.');
  lines.push('');
  lines.push('**The counts are a floor.** The arm cannot see the constructions listed under "What this arm still cannot see"; each of those under-counts rather than over-counts, except where noted.');
  lines.push('');
  lines.push('## Recognised transaction calls');
  lines.push('');
  lines.push(`\`${data.recognisedTransactionCalls.join('`, `')}\`, plus one hop of same-file wrapper (reported as \`local-wrapper:<name>\`). ${data.predicates.transaction}`);
  lines.push('');
  const blindSpot = data.files.filter(
    (record) => record.deletes.some((item) => isDynamic(item) && item.relations.includes('users'))
      && !record.deletes.some((item) => item.kind === 'literal' && item.relations.includes('users')),
  );
  lines.push('## The files the 2026-09-08 arm could not see');
  lines.push('');
  lines.push(`These ${blindSpot.length} files delete \`users\` only through a \`for\`-loop over an array of relation names, so no literal \`${'DELETE'} ${'FROM'} users\` appears in them and the literal-only arm reported nothing. Some of them did enter the earlier population - but through their separate literal \`tenants\` delete, which is a different statement with a different defect. Being absent from a population is not evidence of safety, and being present in it for the wrong statement is not evidence that the right one was examined.`);
  lines.push('');
  lines.push('| File | Class | Where the `users` delete sits | How the relation name is bound |');
  lines.push('|---|---|---|---|');
  for (const record of blindSpot) {
    const hit = record.deletes.find((item) => isDynamic(item) && item.relations.includes('users'));
    const where = `${hit.replica === 'inside' ? 'inside a replica window' : "at 'origin'"}, ${hit.inTransaction ? `inside \`${hit.transactionVia}\`` : 'outside every recognised transaction'}`;
    lines.push(`| \`${record.file.replace('apps/backend/src/tests/', '')}\` | ${CLASS_LABEL[record.classification]} | ${escape(where)} | ${escape(hit.binding ?? '')} |`);
  }
  lines.push('');
  lines.push('## Per-file classification');
  lines.push('');
  lines.push('Every file carrying a `users`/`tenants` delete, including the ones above. `@replica` and `@origin-in-tx` say where the delete sits, not what it costs; (b) does not claim the suite exceeds its own declared timeout.');
  lines.push('');
  lines.push('| File | Class | Hits | Dynamic arm | Uses `tenantTeardown.js` |');
  lines.push('|---|---|---|---|---|');
  for (const record of data.files) {
    const dynamic = record.deletes.some((item) => isDynamic(item) && item.relations.length > 0)
      ? (record.deletes.some((item) => item.kind === 'literal') ? 'yes (+literal)' : 'yes (only)')
      : 'no';
    lines.push(`| \`${record.file.replace('apps/backend/src/tests/', '')}\` | ${CLASS_LABEL[record.classification]} | ${escape(relationSummary(record))} | ${dynamic} | ${record.usesTenantTeardownHelper ? 'yes' : 'no'} |`);
  }
  lines.push('');
  if (data.parseFailures.length > 0) {
    lines.push('## Parse failures');
    lines.push('');
    for (const failure of data.parseFailures) lines.push(`- \`${failure.file}\` - ${escape(failure.error)}`);
    lines.push('');
  }
  lines.push('## What this arm still cannot see');
  lines.push('');
  for (const limit of data.limits) lines.push(`- ${escape(limit)}`);
  lines.push('');
  lines.push('## Reproduction');
  lines.push('');
  lines.push('```bash');
  lines.push('node apps/backend/scripts/teardown-tx-census.mjs --check');
  lines.push('```');
  lines.push('');
  lines.push('`--check` regenerates from the working tree using the revision recorded in the adjacent JSON and diffs against the committed pair. **No CI gate is wired to it.** The detector-capability probes are in `apps/backend/src/tests/unit/teardownTxCensus.test.js`: each mutates a fixture and asserts the classification changes, after first asserting the unmutated baseline disagrees.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const JSON_PATH = fileURLToPath(new URL('../../../docs/security/teardown-tx-census.json', import.meta.url));
const MARKDOWN_PATH = fileURLToPath(new URL('../../../docs/security/teardown-tx-census.md', import.meta.url));

function serialise(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const revisionIndex = argv.indexOf('--revision');
  const revision = revisionIndex >= 0 ? argv[revisionIndex + 1] : null;
  if (argv.includes('--write')) {
    const data = census({ revision });
    mkdirSync(dirname(JSON_PATH), { recursive: true });
    writeFileSync(JSON_PATH, serialise(data));
    writeFileSync(MARKDOWN_PATH, renderMarkdown(data));
    process.stdout.write(`wrote ${JSON_PATH} and ${MARKDOWN_PATH}\n`);
  } else if (argv.includes('--check')) {
    const committedJson = readFileSync(JSON_PATH, 'utf8');
    const data = census({ revision: JSON.parse(committedJson).revision });
    const drift = [];
    if (serialise(data) !== committedJson) drift.push(JSON_PATH);
    if (renderMarkdown(data) !== readFileSync(MARKDOWN_PATH, 'utf8')) drift.push(MARKDOWN_PATH);
    if (drift.length > 0) {
      process.stderr.write(`teardown-tx-census: stale ${drift.join(', ')} - regenerate with --write\n`);
      process.exit(1);
    }
    process.stdout.write('teardown-tx-census: committed census matches the working tree\n');
  } else {
    process.stdout.write(serialise(census({ revision })));
  }
}
