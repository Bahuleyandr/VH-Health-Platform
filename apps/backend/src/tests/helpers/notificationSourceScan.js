// Shared source scanner for the two patient-notification gates:
//   src/tests/unit/patientPushFeedRowCensus.test.js  — every mechanism that can
//     put a notification in front of a patient is accounted for, and the ones
//     that send a privacy-stripped push also write the inbox row it points at.
//   src/tests/unit/patientInboxTypeRouting.test.js   — every `notifications.type`
//     this backend writes for a patient is a type the patient app routes.
//
// WHY THIS MODULE EXISTS. Both gates answer the same question first — "where
// in src/ does this happen?" — and the re-audit that produced them found the
// same failure twice: a gate that read as complete while a whole MECHANISM was
// invisible to it. Two copies of the scanner is two places to remember to add
// the next mechanism to, and the copies had already diverged (the census could
// not see `dispatch()`; neither could see `prisma.notifications.create`). One
// copy means adding a mechanism here shows up in both gates at once.
//
// This file lives under src/tests/, which every walk below skips, so the
// scanner never scans itself or the gates that import it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `apps/backend/src` — the tree both gates scan. */
export const SRC_DIR = path.resolve(HERE, '..', '..');

/** Read one source file by its path relative to SRC_DIR. */
export const readSource = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'coverage', 'dist']);

/** Visit every .js file under src/, excluding the dirs above. */
export function walkSources(visit) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      visit(path.relative(SRC_DIR, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'));
    }
  };
  walk(SRC_DIR);
}

/**
 * Regex source matching a reference to `table` in every spelling Postgres
 * accepts for the same table: bare, schema-qualified, and double-quoted in
 * either position — `notifications`, `public.notifications`,
 * `"notifications"`, `public."notifications"`, `"public"."notifications"`.
 *
 * WHY THIS IS NOT A LITERAL. `INSERT INTO notifications` was pinned as a bare
 * literal, and both gates check their writer sets against it in BOTH
 * directions. A writer spelled `INSERT INTO public.notifications` was
 * therefore not merely missed: it made the set equality itself vacuous, which
 * is the single property that makes these gates worth having. One word was
 * enough to leave the census, with the census still reporting green.
 *
 * The trailing `(?![\w$"])` is what keeps the neighbouring tables in this
 * schema out. `failed_notifications`, `scheduled_notifications`,
 * `stemi_team_notifications`, `referral_patient_notifications` and
 * `diagnostic_result_patient_notifications` all end in the same word and all
 * are written by this tree; none of them is the patient inbox. The leading
 * `(?<![\w$."])` is the mirror of that, so the fragment is safe to use without
 * an `INSERT INTO`/`UPDATE` prefix in front of it.
 */
export const sqlTableRef = (table) => '(?<![\\w$."])'
  + `(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\\s*\\.\\s*)?"?${table}"?(?![\\w$"])`;

/**
 * `INSERT INTO <table>` in any of those spellings. `suffix` appends to the
 * pattern (the routing gate needs `\s*\(` to find the column list).
 */
export const insertIntoTable = (table, { flags = 'gi', suffix = '' } = {}) => new RegExp(
  `INSERT\\s+INTO\\s+${sqlTableRef(table)}${suffix}`,
  flags,
);

/** `UPDATE <table>` in any of those spellings. */
export const updateTable = (table, { flags = 'gi', suffix = '' } = {}) => new RegExp(
  `UPDATE\\s+${sqlTableRef(table)}${suffix}`,
  flags,
);

/**
 * The mechanisms by which this backend either sends a patient-facing message
 * or writes the inbox row behind one. Every one of these is a way a patient
 * notification can come into existence; a gate that scans a subset of them is
 * a gate with a blind spot, which is the specific defect both gates exist for.
 *
 *   push        a direct `sendPushNotification(...)` transport call
 *   queue       `notificationOutbox.queue(...)` / `outbox.queue(...)` — the
 *               drain turns the intent into a push whenever the resolved
 *               channel set contains `push`, and into an inbox row whenever it
 *               contains `inapp`
 *   raw         a raw `INSERT INTO notification_outbox` that bypasses queue()
 *   rowInsert   a raw `INSERT INTO notifications`
 *
 * Two mechanisms are NOT regexes in this map, because a regex is the wrong
 * shape for them:
 *
 *   dispatch    call sites of `dispatch()` / `dispatchToPatient()`, found by
 *               `dispatchCallSites()` below, which excludes the two
 *               declarations and anything on a comment line.
 *   orm         a Prisma write on the `notifications` MODEL, found by
 *               `ormWriteCalls()` below, which matches the model and then
 *               classifies the method. See ORM_METHOD_EFFECTS for why the
 *               method cannot be pinned into the pattern.
 */
export const MECHANISM_PATTERNS = Object.freeze({
  push: /\bsendPushNotification\s*\(/g,
  queue: /\.queue\s*\(/g,
  raw: insertIntoTable('notification_outbox'),
  rowInsert: insertIntoTable('notifications'),
});

/**
 * Mechanisms whose sites are counted by classifying each match rather than by
 * counting raw regex hits, keyed the same way `MECHANISM_PATTERNS` is so
 * `scanMechanismCounts` can take either kind by name.
 */
const MECHANISM_SITE_COUNTERS = Object.freeze({
  orm: (source) => ormWriteCalls(source).length,
});

/**
 * `{ 'relative/path.js': { mechanism: siteCount } }` for the named mechanisms.
 * Files with no hit for any of them are omitted.
 */
export function scanMechanismCounts(mechanisms) {
  const found = {};
  walkSources((file, source) => {
    const counts = {};
    for (const mechanism of mechanisms) {
      const counter = MECHANISM_SITE_COUNTERS[mechanism];
      if (counter) {
        const sites = counter(source);
        if (sites > 0) counts[mechanism] = sites;
        continue;
      }
      const pattern = MECHANISM_PATTERNS[mechanism];
      if (!pattern) throw new Error(`unknown mechanism '${mechanism}'`);
      const hits = source.match(pattern);
      if (hits && hits.length > 0) counts[mechanism] = hits.length;
    }
    if (Object.keys(counts).length > 0) found[file] = counts;
  });
  return found;
}

/**
 * Code-only text of the argument list of the call whose opening paren is at
 * `openParen`. Quote-, template-literal- and comment-aware: a `)` inside a
 * string must not close the call early, and an apostrophe inside an explaining
 * comment ("the app's inbox") must not open one. Comments are dropped from the
 * returned text so only real arguments are matched against. Returns null when
 * the parens are unbalanced.
 */
export function callArgumentText(source, openParen) {
  let depth = 0;
  let out = '';
  let i = openParen;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
        out += source[i];
        if (source[i] === ch) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return out.slice(1);
    }
    out += ch;
    i += 1;
  }
  return null;
}

/**
 * The value expression of every `type:` property in a chunk of call-argument
 * text, including nested ones (`data: { type: … }`). The expression runs to the
 * next comma or closing bracket at its own nesting depth.
 */
export function typeValueExpressions(text) {
  const source = String(text ?? '');
  const expressions = [];
  for (const match of source.matchAll(/\btype\s*:/g)) {
    let i = match.index + match[0].length;
    let depth = 0;
    let expression = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        expression += ch;
        i += 1;
        while (i < source.length) {
          if (source[i] === '\\') { expression += source.slice(i, i + 2); i += 2; continue; }
          expression += source[i];
          if (source[i] === ch) { i += 1; break; }
          i += 1;
        }
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ',' && depth === 0) break;
      expression += ch;
      i += 1;
    }
    expressions.push(expression.trim());
  }
  return expressions;
}

/**
 * Split `cond ? a : b` at its top-level `?`/`:`, skipping `?.` and `??` and
 * anything inside strings or brackets. Returns null when the text is not a
 * conditional expression.
 */
function splitTernary(text) {
  let depth = 0;
  let question = -1;
  let pending = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < text.length && text[i] !== ch) i += (text[i] === '\\' ? 2 : 1);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (ch === '?') {
      if (text[i + 1] === '.' || text[i + 1] === '?') { i += 1; continue; }
      if (question < 0) question = i;
      else pending += 1;
      continue;
    }
    if (ch === ':' && question >= 0) {
      if (pending > 0) { pending -= 1; continue; }
      return {
        consequent: text.slice(question + 1, i),
        alternate: text.slice(i + 1),
      };
    }
  }
  return null;
}

/**
 * The complete set of string values an expression can evaluate to, or null
 * when that cannot be decided from source. A bare quoted literal resolves to
 * itself; a conditional resolves to the union of its two branches (each of
 * which must itself resolve). Anything else — a variable, a template literal,
 * a lookup, a concatenation — is null, which callers must treat as a FAILURE
 * rather than "no types found".
 */
export function literalSetForExpression(expression) {
  const text = String(expression ?? '').trim();
  if (!text) return null;
  const literal = text.match(/^'([^']*)'$/);
  if (literal) return [literal[1]];
  const parts = splitTernary(text);
  if (!parts) return null;
  const consequent = literalSetForExpression(parts.consequent);
  const alternate = literalSetForExpression(parts.alternate);
  if (!consequent || !alternate) return null;
  return [...consequent, ...alternate];
}

/**
 * Every string value the `type:` properties in `text` can carry.
 * `{ literals: string[], unresolved: string[] }` — `unresolved` holds the
 * expressions this cannot decide, and a non-empty `unresolved` must fail the
 * gate that asked. This replaces a plain `type: '…'` regex, which silently
 * returned NOTHING for `type: cond ? 'a' : 'b'` and so could not tell an
 * unroutable computed type from a call with no type at all.
 */
export function typeLiteralsFrom(text) {
  const literals = [];
  const unresolved = [];
  for (const expression of typeValueExpressions(text)) {
    const resolved = literalSetForExpression(expression);
    if (resolved) literals.push(...resolved);
    else unresolved.push(expression);
  }
  return { literals, unresolved };
}

/** True when `index` falls inside a `//` or ` * ` comment line. */
export function isOnCommentLine(source, index) {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const line = source.slice(lineStart, index);
  return line.includes('//') || /^\s*\*/.test(line);
}

/**
 * Offsets of the opening paren of each call to `name(` that is a call rather
 * than the function's own declaration, skipping mentions inside comments.
 */
export function callSites(source, name) {
  const sites = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const before = source.slice(Math.max(0, match.index - 30), match.index);
    if (/\bfunction\s+$/.test(before)) continue;
    if (isOnCommentLine(source, match.index)) continue;
    sites.push(match.index + match[0].length - 1);
  }
  return sites;
}

/**
 * The dispatcher's two entry points. `dispatchToPatient` resolves the
 * patient's `preferred_channel` and then calls `dispatch()` itself, so a
 * caller of either can reach both the push transport and the inbox-row write.
 * It has no caller anywhere in src/ today; it is scanned so that the FIRST one
 * is not invisible, because `\bdispatch\s*\(` does not match
 * `dispatchToPatient(` — the exact shape of blind spot these gates exist to
 * prevent.
 */
export const DISPATCH_ENTRY_POINTS = Object.freeze(['dispatch', 'dispatchToPatient']);

/** Opening-paren offsets of every dispatch()/dispatchToPatient() call site. */
export function dispatchCallSites(source) {
  return DISPATCH_ENTRY_POINTS
    .flatMap((name) => callSites(source, name))
    .sort((a, b) => a - b);
}

/**
 * `{ 'relative/path.js#<0-based occurrence>': argumentText }` for every
 * dispatch()/dispatchToPatient() call site under src/. `argumentText` is null
 * when the parens are unbalanced, which each gate asserts against.
 */
export function scanDispatchSites() {
  const sites = {};
  walkSources((file, source) => {
    dispatchCallSites(source).forEach((openParen, index) => {
      sites[`${file}#${index}`] = callArgumentText(source, openParen);
    });
  });
  return sites;
}

/**
 * `<anything>.notifications.<method>(` — the MODEL, with the method captured.
 * `\b` before the model name is what keeps `failed_notifications.map(` and the
 * other `*_notifications` locals out: `_` is a word character, so there is no
 * boundary in front of the `n`.
 */
export const ORM_MODEL_CALL = /\bnotifications\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Prisma delegate methods, classified by what each can do to a `notifications`
 * row.
 *
 * WHY CLASSIFY RATHER THAN PIN. The previous pattern was
 * `\bnotifications\.create(?:Many)?\s*\(` — the METHOD NAMES were inside the
 * regex. `upsert(`, `createManyAndReturn(` and every `update(` that sets
 * `type` were therefore invisible to both gates, and because both gates check
 * their site sets in both directions, a writer spelled with any of those left
 * the census without failing anything. Matching the model and classifying the
 * method here means a method is either known or it stops the build.
 *
 *   creates    puts a NEW row in the patient's inbox
 *   retypes    can set columns on a row that already exists — `type` among
 *              them, which is exactly what the routing gate resolves at INSERT
 *   inert      reads or deletes; can neither create a row nor retype one
 *   not-prisma not a delegate method at all. `notifications` is also the name
 *              of ordinary local arrays in this tree (adminNotificationService,
 *              notificationService), and these are the methods they call.
 *
 * A method in none of these lists is `unclassified`, which the census FAILS on
 * rather than guessing — see "classifies every Prisma call it finds on the
 * notifications model" in patientPushFeedRowCensus.test.js. Clearing that
 * failure costs one line here; the alternative is the silent blind spot this
 * module exists to prevent.
 */
export const ORM_METHOD_EFFECTS = Object.freeze({
  create: 'creates',
  createMany: 'creates',
  createManyAndReturn: 'creates',
  upsert: 'creates',
  update: 'retypes',
  updateMany: 'retypes',
  updateManyAndReturn: 'retypes',
  delete: 'inert',
  deleteMany: 'inert',
  findUnique: 'inert',
  findUniqueOrThrow: 'inert',
  findFirst: 'inert',
  findFirstOrThrow: 'inert',
  findMany: 'inert',
  aggregate: 'inert',
  groupBy: 'inert',
  count: 'inert',
  map: 'not-prisma',
  flat: 'not-prisma',
});

/** The effects that make a call a WRITE to the model. */
const ORM_WRITE_EFFECTS = new Set(['creates', 'retypes']);

/**
 * Every `notifications.<method>(` in `source` that is not on a comment line,
 * in file order: `{ method, effect, openParen }`.
 */
export function ormModelCalls(source) {
  const calls = [];
  for (const match of source.matchAll(ORM_MODEL_CALL)) {
    if (isOnCommentLine(source, match.index)) continue;
    calls.push({
      method: match[1],
      effect: ORM_METHOD_EFFECTS[match[1]] || 'unclassified',
      openParen: match.index + match[0].length - 1,
    });
  }
  return calls;
}

/** The write calls of `ormModelCalls()` — row creations and retypings. */
export function ormWriteCalls(source) {
  return ormModelCalls(source).filter((call) => ORM_WRITE_EFFECTS.has(call.effect));
}

/** The subset that puts a NEW row in the inbox; an `update` does not. */
export function ormRowCreations(source) {
  return ormModelCalls(source).filter((call) => call.effect === 'creates');
}

/**
 * `{ 'relative/path.js': ['method', …] }` for every `notifications.<method>(`
 * whose method ORM_METHOD_EFFECTS does not classify. Empty is the only
 * passing value; anything here is a call the gates cannot reason about.
 */
export function scanUnclassifiedOrmMethods() {
  const found = {};
  walkSources((file, source) => {
    const methods = ormModelCalls(source)
      .filter((call) => call.effect === 'unclassified')
      .map((call) => call.method);
    if (methods.length > 0) found[file] = methods;
  });
  return found;
}

/**
 * `{ 'relative/path.js#<0-based occurrence>': argumentText }` for every Prisma
 * WRITE on the `notifications` model under src/ — the ORM form of an inbox-row
 * write. The row's `type` is a plain object property here, so unlike the
 * raw-SQL form it can be read straight out of the argument text.
 */
export function scanOrmRowWrites() {
  const sites = {};
  walkSources((file, source) => {
    ormWriteCalls(source).forEach((call, index) => {
      sites[`${file}#${index}`] = callArgumentText(source, call.openParen);
    });
  });
  return sites;
}
