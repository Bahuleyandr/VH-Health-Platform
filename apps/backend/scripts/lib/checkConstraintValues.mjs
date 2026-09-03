// Column-bound literal extraction from PostgreSQL CHECK constraints, for the
// comprehensive test-data seeder.
//
// Given every CHECK definition of a table (as returned by
// pg_get_constraintdef) and a column name, answer: which string literal may
// this column be seeded with? The answer is a function of the SET of
// definitions, never of the order they were supplied in.
//
// Terms used below, for column C:
//   conjunct   — a top-level AND operand of one definition.
//   single-column conjunct — a conjunct whose only referenced column is C.
//   allowed set — literals positively bound to C in single-column conjuncts
//                 (C = 'x', C = ANY (ARRAY[...])), in the authored order.
//   trigger    — a literal bound to C (positively or negatively) inside a
//                multi-column conjunct. Seeding it engages a side condition
//                on another column that the generic walker does not
//                coordinate: `C <> 'release' OR other IS NOT NULL` makes
//                'release' a trigger.
// Tier 1 is the first allowed value that is not a trigger; tier 2 is the
// first allowed value when all of them are triggers; otherwise null. Literals
// bound to C only inside multi-column conjuncts are never returned: choosing
// one branch of a multi-column condition for one column alone is the defect
// this module replaces, one level down.
//
// Design note: docs/superpowers/specs/2026-09-03-comprehensive-seed-column-bound-check-values-design.md

const KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'NULL',
  'ANY',
  'ALL',
  'ARRAY',
  'IN',
  'LIKE',
  'ILIKE',
  'SIMILAR',
  'TO',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'TRUE',
  'FALSE',
  'CHECK',
  'DISTINCT',
  'FROM',
  'ESCAPE',
  'SYMMETRIC',
  'ASYMMETRIC',
  'UNKNOWN',
  'COLLATE'
]);
// Words that continue a multi-word type name after `::` (character varying,
// double precision, timestamp with time zone, ...).
const TYPE_TAIL = new Set(['varying', 'precision', 'with', 'without', 'time', 'zone']);
// Longest first so `<>` wins over `<`, `!~*` over `!~`, `->>` over `->`.
const OPERATORS = [
  '!~~*',
  '!~~',
  '~~*',
  '~~',
  '!~*',
  '!~',
  '~*',
  '<>',
  '!=',
  '<=',
  '>=',
  '->>',
  '->',
  '#>>',
  '#>',
  '@>',
  '<@',
  '?|',
  '?&',
  '||',
  '=',
  '<',
  '>',
  '~',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '?'
];
const PUNCTUATION = new Set(['(', ')', '[', ']', ',']);
const FORMAT_OPERATORS = new Set(['~', '~*', '!~', '!~*', '~~', '~~*', '!~~', '!~~*']);
const FORMAT_KEYWORDS = new Set(['LIKE', 'ILIKE', 'SIMILAR']);

const isPunct = (token, value) =>
  token !== undefined && token.type === 'punct' && token.value === value;
const isKeyword = (token, value) =>
  token !== undefined && token.type === 'keyword' && token.value === value;

/**
 * Tokenize a deparsed SQL boolean expression.
 * Token types: string (unescaped value), ident (lower-cased), keyword (upper-cased),
 * cast (type name after `::`, lower-cased, array suffix dropped), number, op, punct.
 */
export function tokenizeCheckExpression(sql) {
  const tokens = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let value = '';
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          value += "'";
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        value += sql[j];
        j += 1;
      }
      if (j >= n) throw new Error(`tokenize: unterminated string literal in ${sql}`);
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < n && sql[j] !== '"') {
        value += sql[j];
        j += 1;
      }
      if (j >= n) throw new Error(`tokenize: unterminated quoted identifier in ${sql}`);
      tokens.push({ type: 'ident', value: value.toLowerCase() });
      i = j + 1;
      continue;
    }
    if (sql.startsWith('::', i)) {
      let j = i + 2;
      const words = [];
      const nextWord = () => sql.slice(j).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
      let match = nextWord();
      if (match) {
        words.push(match[1].toLowerCase());
        j += match[0].length;
        for (
          match = nextWord();
          match && TYPE_TAIL.has(match[1].toLowerCase());
          match = nextWord()
        ) {
          words.push(match[1].toLowerCase());
          j += match[0].length;
        }
      }
      const modifier = sql.slice(j).match(/^\s*\(\s*\d+(\s*,\s*\d+)?\s*\)/);
      if (modifier) j += modifier[0].length;
      let suffix = sql.slice(j).match(/^\s*\[\s*\]/);
      while (suffix) {
        j += suffix[0].length;
        suffix = sql.slice(j).match(/^\s*\[\s*\]/);
      }
      tokens.push({ type: 'cast', value: words.join(' ') });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.$]/.test(sql[j])) j += 1;
      const raw = sql.slice(i, j);
      const upper = raw.toUpperCase();
      tokens.push(
        KEYWORDS.has(upper)
          ? { type: 'keyword', value: upper }
          : { type: 'ident', value: raw.toLowerCase() }
      );
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9.]/.test(sql[j])) j += 1;
      if (/[eE]/.test(sql[j] || '') && /[0-9+-]/.test(sql[j + 1] || '')) {
        j += 2;
        while (j < n && /[0-9]/.test(sql[j])) j += 1;
      }
      tokens.push({ type: 'number', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    const op = OPERATORS.find(candidate => sql.startsWith(candidate, i));
    if (!op) {
      throw new Error(`tokenize: unexpected character ${JSON.stringify(ch)} at ${i} in ${sql}`);
    }
    tokens.push({ type: 'op', value: op });
    i += op.length;
  }
  return tokens;
}

/**
 * Parse the boolean skeleton of a CHECK definition.
 * Node shapes: { kind: 'and' | 'or', children }, { kind: 'not', child },
 * { kind: 'atom', tokens }. Atoms are opaque token spans between boolean
 * operators; parenthesised spans are groups only when a boolean operator, a
 * closing paren or the end follows them, so `(col)::text = ...` stays an atom.
 */
export function parseCheckDefinition(definition) {
  // pg_get_constraintdef appends NOT VALID / NO INHERIT after the closing paren.
  const trimmed = definition.trim().replace(/\s+(NOT\s+VALID|NO\s+INHERIT)\s*$/gi, '');
  const body = trimmed.match(/^CHECK\s*\(([\s\S]*)\)$/i);
  if (!body) throw new Error(`not a CHECK definition: ${definition.slice(0, 80)}`);
  return parseBoolean(tokenizeCheckExpression(body[1]));
}

function parseBoolean(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];

  function matchingClose(start) {
    let depth = 0;
    for (let k = start; k < tokens.length; k += 1) {
      const token = tokens[k];
      if (isPunct(token, '(') || isPunct(token, '[')) depth += 1;
      else if (isPunct(token, ')') || isPunct(token, ']')) {
        depth -= 1;
        if (depth === 0) return k;
      }
    }
    throw new Error('parse: unbalanced parentheses');
  }

  // End of an atom: the next top-level AND/OR, an unmatched ')', or the end.
  // CASE ... END is nested like parentheses so its WHEN/AND/OR stay inside.
  function atomEnd(start) {
    let depth = 0;
    let caseDepth = 0;
    let k = start;
    for (; k < tokens.length; k += 1) {
      const token = tokens[k];
      if (isPunct(token, '(') || isPunct(token, '[')) depth += 1;
      else if (isPunct(token, ')') || isPunct(token, ']')) {
        if (depth === 0) return k;
        depth -= 1;
      } else if (isKeyword(token, 'CASE')) caseDepth += 1;
      else if (isKeyword(token, 'END')) caseDepth -= 1;
      else if (
        depth === 0 &&
        caseDepth === 0 &&
        (isKeyword(token, 'AND') || isKeyword(token, 'OR'))
      ) {
        return k;
      }
    }
    return k;
  }

  function primary() {
    const token = peek();
    if (token === undefined) throw new Error('parse: unexpected end of expression');
    if (isKeyword(token, 'NOT')) {
      pos += 1;
      return { kind: 'not', child: primary() };
    }
    if (isPunct(token, '(')) {
      const close = matchingClose(pos);
      const after = tokens[close + 1];
      const isGroup =
        after === undefined ||
        isKeyword(after, 'AND') ||
        isKeyword(after, 'OR') ||
        isPunct(after, ')');
      if (isGroup) {
        pos += 1;
        const inner = orExpression();
        if (!isPunct(peek(), ')')) throw new Error('parse: expected )');
        pos += 1;
        return inner;
      }
    }
    const end = atomEnd(pos);
    if (end === pos) throw new Error(`parse: empty atom at token ${pos}`);
    const atom = { kind: 'atom', tokens: tokens.slice(pos, end) };
    pos = end;
    return atom;
  }

  function andExpression() {
    const children = [primary()];
    while (isKeyword(peek(), 'AND')) {
      pos += 1;
      children.push(primary());
    }
    return children.length === 1 ? children[0] : { kind: 'and', children };
  }

  function orExpression() {
    const children = [andExpression()];
    while (isKeyword(peek(), 'OR')) {
      pos += 1;
      children.push(andExpression());
    }
    return children.length === 1 ? children[0] : { kind: 'or', children };
  }

  const tree = orExpression();
  if (pos !== tokens.length) {
    throw new Error(`parse: trailing tokens at ${pos} of ${tokens.length}`);
  }
  return tree;
}

function atomsOf(node, out = []) {
  if (node.kind === 'atom') out.push(node);
  else if (node.kind === 'not') atomsOf(node.child, out);
  else node.children.forEach(child => atomsOf(child, out));
  return out;
}

/** Column identifiers referenced anywhere under a node (function names excluded). */
export function referencedColumns(node) {
  const columns = new Set();
  for (const atom of atomsOf(node)) {
    atom.tokens.forEach((token, k) => {
      if (token.type !== 'ident') return;
      if (isPunct(atom.tokens[k + 1], '(')) return; // a function name
      columns.add(token.value);
    });
  }
  return columns;
}

/**
 * Classify one atom as { column, polarity, literals }:
 *   positive — `col = 'x'`, `col = ANY (ARRAY['x', ...])`, also through `func(col)`
 *   negative — `col <> 'x'`, `col <> ALL (ARRAY['x', ...])`
 *   format   — regex / LIKE / SIMILAR TO comparisons (no literal belongs to the column)
 *   null     — `col IS [NOT] NULL`
 *   opaque   — anything else; column is the leading column reference when there is one
 */
export function classifyAtom(atom) {
  const tokens = stripWrappingParens(atom.tokens);
  let k = 0;
  const skipCasts = () => {
    while (tokens[k] && tokens[k].type === 'cast') k += 1;
  };
  let column = null;
  const readColumnReference = () => {
    let depth = 0;
    while (isPunct(tokens[k], '(')) {
      depth += 1;
      k += 1;
    }
    if (!(tokens[k] && tokens[k].type === 'ident')) return false;
    const name = tokens[k].value;
    k += 1;
    skipCasts();
    while (depth > 0) {
      if (!isPunct(tokens[k], ')')) return false;
      k += 1;
      depth -= 1;
      skipCasts();
    }
    column = name;
    return true;
  };
  const opaque = () => ({ column, polarity: 'opaque', literals: [] });

  if (tokens[k] && tokens[k].type === 'ident' && isPunct(tokens[k + 1], '(')) {
    k += 2; // function(
    if (!readColumnReference()) return opaque();
    if (!isPunct(tokens[k], ')')) return opaque();
    k += 1;
    skipCasts();
  } else if (!readColumnReference()) {
    return opaque();
  }

  const operator = tokens[k];
  if (operator === undefined) return opaque();
  const rest = tokens.slice(k + 1);
  const literals = rest.filter(token => token.type === 'string').map(token => token.value);

  if (isKeyword(operator, 'IS')) return { column, polarity: 'null', literals: [] };
  if (operator.type === 'op' && FORMAT_OPERATORS.has(operator.value)) {
    return { column, polarity: 'format', literals: [] };
  }
  if (operator.type === 'keyword' && FORMAT_KEYWORDS.has(operator.value)) {
    return { column, polarity: 'format', literals: [] };
  }
  if (
    isKeyword(operator, 'NOT') &&
    rest[0] &&
    rest[0].type === 'keyword' &&
    FORMAT_KEYWORDS.has(rest[0].value)
  ) {
    return { column, polarity: 'format', literals: [] };
  }
  if (
    operator.type === 'op' &&
    (operator.value === '=' || operator.value === '<>' || operator.value === '!=')
  ) {
    const positive = operator.value === '=';
    const quantifier = rest[0];
    if (isKeyword(quantifier, 'ANY') || isKeyword(quantifier, 'ALL')) {
      if (literals.length === 0) return opaque();
      if (positive && isKeyword(quantifier, 'ANY')) {
        return { column, polarity: 'positive', literals };
      }
      if (!positive && isKeyword(quantifier, 'ALL')) {
        return { column, polarity: 'negative', literals };
      }
      return opaque();
    }
    const plain = rest.every(
      token =>
        token.type === 'string' ||
        token.type === 'cast' ||
        isPunct(token, '(') ||
        isPunct(token, ')')
    );
    if (literals.length === 1 && plain) {
      return { column, polarity: positive ? 'positive' : 'negative', literals };
    }
  }
  return opaque();
}

function stripWrappingParens(tokens) {
  let a = 0;
  let b = tokens.length;
  const wraps = () => {
    if (!isPunct(tokens[a], '(') || !isPunct(tokens[b - 1], ')')) return false;
    let depth = 0;
    for (let k = a; k < b; k += 1) {
      if (isPunct(tokens[k], '(')) depth += 1;
      else if (isPunct(tokens[k], ')')) {
        depth -= 1;
        if (depth === 0 && k !== b - 1) return false;
      }
    }
    return true;
  };
  while (b - a > 2 && wraps()) {
    a += 1;
    b -= 1;
  }
  return tokens.slice(a, b);
}

/**
 * Explain the column-bound answer for `columnName` over a table's CHECK
 * definitions: { value, tier: 1 | 2 | null, allowed, triggers }.
 * Definitions are processed in their own text order, so the result does not
 * depend on the order supplied or on constraint names.
 */
export function explainColumnBoundValue(definitions, columnName) {
  const column = columnName.toLowerCase();
  const enumerations = [];
  const triggers = [];
  const seenTrigger = new Set();
  for (const definition of [...definitions].sort()) {
    const tree = parseCheckDefinition(definition);
    const conjuncts = tree.kind === 'and' ? tree.children : [tree];
    for (const conjunct of conjuncts) {
      const columns = referencedColumns(conjunct);
      if (!columns.has(column)) continue;
      const single = columns.size === 1;
      const positives = [];
      for (const atom of atomsOf(conjunct)) {
        const classified = classifyAtom(atom);
        if (classified.column !== column) continue;
        if (single) {
          if (classified.polarity === 'positive') positives.push(...classified.literals);
        } else if (classified.polarity === 'positive' || classified.polarity === 'negative') {
          for (const literal of classified.literals) {
            if (!seenTrigger.has(literal)) {
              seenTrigger.add(literal);
              triggers.push(literal);
            }
          }
        }
      }
      if (positives.length) enumerations.push(positives);
    }
  }
  let allowed = [];
  enumerations.forEach((list, index) => {
    allowed = index === 0 ? [...list] : allowed.filter(value => list.includes(value));
  });
  if (allowed.length === 0) return { value: null, tier: null, allowed, triggers };
  const safe = allowed.find(value => !seenTrigger.has(value));
  if (safe !== undefined) return { value: safe, tier: 1, allowed, triggers };
  return { value: allowed[0], tier: 2, allowed, triggers };
}

/** The seed value for `columnName`, or null when no single-column enumeration binds one. */
export function columnBoundValue(definitions, columnName) {
  return explainColumnBoundValue(definitions, columnName).value;
}
