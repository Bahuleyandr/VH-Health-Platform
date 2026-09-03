# Comprehensive Seed Column-Bound CHECK Values Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the comprehensive seeder's `checkedValue()` literal heuristic with a column-bound, order-independent policy backed by a small parser, retire the three override pins that only compensated for it, and prove both orders in a unit test.

**Architecture:** A pure ESM module `apps/backend/scripts/lib/checkConstraintValues.mjs` tokenizes `pg_get_constraintdef` output, parses its boolean skeleton (parens, AND, OR, NOT) with opaque atoms, classifies the atoms that bind a string literal to a column, and computes the value for a column from the *set* of a table's definitions (tier 1: single-column enumeration minus trigger literals; tier 2: the enumeration when every member is a trigger; else null). The seeder's `checkedValue` keeps its text-type gate and delegates; its `checksByTable` map and constraint query are untouched.

**Tech Stack:** Node 26.5.0 (`D:\Dev\Tools\node-26.5.0`), ESM, Jest 30 run through `npm test` (`--experimental-vm-modules`), PostgreSQL 17 QA cluster at `127.0.0.1:55432` for the fresh-database proof. Spec: `docs/superpowers/specs/2026-09-03-comprehensive-seed-column-bound-check-values-design.md`.

---

## File structure

- Create `apps/backend/scripts/lib/checkConstraintValues.mjs` — tokenizer, boolean-skeleton parser, atom classifier, column-bound value policy. No I/O. Exports `tokenizeCheckExpression`, `parseCheckDefinition`, `referencedColumns`, `classifyAtom`, `explainColumnBoundValue`, `columnBoundValue`.
- Create `apps/backend/src/tests/unit/comprehensiveSeedCheckedValue.test.js` — unit test over synthetic and real definitions in both orders and shuffles.
- Modify `apps/backend/scripts/seed-comprehensive-test-data.mjs` — import the module (line 12 area), replace `checkedValue` (lines 551-581), remove three pins from `TABLE_COLUMN_SEED_OVERRIDES` (lines 773-784 and 1046-1065 region).

All commands below run from `C:\Users\subas\AppData\Local\Temp\claude\D--Dev\2f11079d-26a5-4494-b8f9-583c88a21415\scratchpad\wt\o22\apps\backend` with `D:\Dev\Tools\node-26.5.0` first on `PATH`, unless stated otherwise.

---

### Task 1: Failing unit test for the module

**Files:**
- Test: `apps/backend/src/tests/unit/comprehensiveSeedCheckedValue.test.js`

- [ ] **Step 1: Write the failing test**

```js
import {
  classifyAtom,
  columnBoundValue,
  explainColumnBoundValue,
  parseCheckDefinition,
  referencedColumns
} from '../../../scripts/lib/checkConstraintValues.mjs';

// Until 2026-09-03 the seeder's checkedValue() harvested the FIRST quoted literal
// of the first CHECK definition whose text merely contained the column name.
// Which definition came first was decided by the catalog (and, after
// dce625f48, by constraint name), so the same column seeded differently on
// databases with the same schema, and a neighbouring column's literal was
// returned whenever a multi-column CHECK sorted first. These tests pin the
// replacement: a literal belongs to a column only when the atom carrying it
// compares that column, literals that engage a side condition on another
// column are avoided, and the answer is a function of the SET of definitions.

// Real definitions from main (migration tip 762), verbatim from
// pg_get_constraintdef. Each set previously needed an override pin.
const BODY_CUSTODY_EVENTS = [
  "CHECK (((event_type)::text = ANY ((ARRAY['receive'::character varying, 'store'::character varying, 'release'::character varying])::text[])))",
  "CHECK (((release_method IS NULL) OR ((release_method)::text = ANY ((ARRAY['family'::character varying, 'mortuary_van'::character varying, 'unclaimed_to_municipality'::character varying])::text[]))))",
  "CHECK ((((event_type)::text <> 'release'::text) OR (release_method IS NOT NULL)))",
  "CHECK ((((event_type)::text <> 'store'::text) OR (slot_id IS NOT NULL)))"
];
const FACILITY_ASSET_EVENTS = [
  "CHECK ((((event_type)::text <> ALL ((ARRAY['status_changed'::character varying, 'repair_opened'::character varying, 'repair_closed'::character varying, 'condemned'::character varying, 'disposed'::character varying])::text[])) OR (to_status IS NOT NULL)))",
  "CHECK (((event_type)::text = ANY ((ARRAY['created'::character varying, 'updated'::character varying, 'moved'::character varying, 'custodian_assigned'::character varying, 'condition_changed'::character varying, 'status_changed'::character varying, 'repair_opened'::character varying, 'repair_closed'::character varying, 'maintenance'::character varying, 'condemned'::character varying, 'disposed'::character varying])::text[])))"
];
const PHARMACY_FUNDING_DECISION_EVENTS = [
  "CHECK (((source_authority_version > 0) AND (source_authority_sha256 ~ '^[0-9a-f]{64}$'::text) AND (command_key_sha256 ~ '^[0-9a-f]{64}$'::text) AND (amount >= (0)::numeric)))",
  "CHECK (((((event_type)::text = ANY ((ARRAY['FUNDING_RESOLVED'::character varying, 'AUTHORITY_INVALIDATED'::character varying])::text[])) AND (authority_generation IS NOT NULL) AND (authority_generation > 0) AND ((((event_type)::text = 'FUNDING_RESOLVED'::text) AND (authority_generation = 1) AND (supersedes_event_id IS NULL)) OR ((authority_generation > 1) AND (supersedes_event_id IS NOT NULL)))) OR (((event_type)::text <> ALL ((ARRAY['FUNDING_RESOLVED'::character varying, 'AUTHORITY_INVALIDATED'::character varying])::text[])) AND (authority_generation IS NULL) AND (supersedes_event_id IS NULL))))",
  "CHECK (((event_type)::text = ANY ((ARRAY['LINE_MATERIALIZED'::character varying, 'AUTHORITY_INVALIDATED'::character varying, 'TPA_DECISION_RECORDED'::character varying, 'PAYMENT_VERIFIED'::character varying, 'FUNDING_RESOLVED'::character varying])::text[])))"
];
// pharmacy_orders.status is constrained ONLY inside multi-column CHECKs
// (each `x OR status = ANY(...)`, all NOT VALID). There is no allowed set.
const PHARMACY_ORDERS = [
  "CHECK (((facility_id IS NOT NULL) OR ((status)::text = ANY ((ARRAY['CANCELLED'::character varying, 'DELIVERED'::character varying, 'DISPENSED'::character varying, 'UNAVAILABLE'::character varying])::text[])))) NOT VALID",
  "CHECK (((legacy_verification_grandfathered = false) OR ((status)::text = ANY ((ARRAY['CANCELLED'::character varying, 'DELIVERED'::character varying, 'DISPENSED'::character varying, 'UNAVAILABLE'::character varying])::text[])))) NOT VALID",
  "CHECK ((((clinical_verification_status)::text <> 'rejected'::text) OR ((status)::text = ANY ((ARRAY['ON_HOLD'::character varying, 'CANCELLED'::character varying, 'UNAVAILABLE'::character varying])::text[])))) NOT VALID"
];

// Deterministic shuffles so a failure reproduces.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, seed) {
  const random = mulberry32(seed);
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function everyOrder(definitions) {
  const orders = [definitions, [...definitions].reverse()];
  for (let seed = 1; seed <= 8; seed += 1) orders.push(shuffled(definitions, seed));
  return orders;
}
function answersInEveryOrder(definitions, column) {
  return new Set(everyOrder(definitions).map(order => columnBoundValue(order, column)));
}

describe('columnBoundValue: the three definition sets that used to need pins', () => {
  it.each([
    ['body_custody_events', BODY_CUSTODY_EVENTS, 'receive'],
    ['facility_asset_events', FACILITY_ASSET_EVENTS, 'created'],
    ['pharmacy_funding_decision_events', PHARMACY_FUNDING_DECISION_EVENTS, 'LINE_MATERIALIZED']
  ])('%s.event_type resolves to the pinned value in every order', (_table, definitions, expected) => {
    expect(answersInEveryOrder(definitions, 'event_type')).toEqual(new Set([expected]));
  });

  it('avoids every literal that would engage a side condition on another column', () => {
    expect(explainColumnBoundValue(BODY_CUSTODY_EVENTS, 'event_type')).toEqual({
      value: 'receive',
      tier: 1,
      allowed: ['receive', 'store', 'release'],
      triggers: ['release', 'store']
    });
    expect(explainColumnBoundValue(FACILITY_ASSET_EVENTS, 'event_type').triggers).toEqual([
      'status_changed',
      'repair_opened',
      'repair_closed',
      'condemned',
      'disposed'
    ]);
    expect(explainColumnBoundValue(PHARMACY_FUNDING_DECISION_EVENTS, 'event_type').triggers).toEqual([
      'FUNDING_RESOLVED',
      'AUTHORITY_INVALIDATED'
    ]);
  });
});

describe('columnBoundValue: column binding', () => {
  it('never returns a neighbouring conjunct literal', () => {
    const definitions = [
      "CHECK (((kind)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])) AND ((status)::text = ANY ((ARRAY['x'::character varying, 'y'::character varying])::text[])))"
    ];
    expect(columnBoundValue(definitions, 'status')).toBe('x');
    expect(columnBoundValue(definitions, 'kind')).toBe('a');
  });

  it('matches the column as a whole identifier, never as a substring', () => {
    const definitions = ["CHECK (((order_status)::text = ANY ((ARRAY['open'::character varying, 'closed'::character varying])::text[])))"];
    expect(columnBoundValue(definitions, 'status')).toBeNull();
    expect(columnBoundValue(definitions, 'order_status')).toBe('open');
  });

  it('returns null when the column is constrained only inside multi-column conjuncts', () => {
    expect(answersInEveryOrder(PHARMACY_ORDERS, 'status')).toEqual(new Set([null]));
    expect(explainColumnBoundValue(PHARMACY_ORDERS, 'status')).toEqual({
      value: null,
      tier: null,
      allowed: [],
      triggers: ['CANCELLED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE', 'ON_HOLD']
    });
  });

  it('returns null when the only mention of the column is a negative trigger', () => {
    const definitions = [
      "CHECK ((((indent_type)::text <> 'pharmacy'::text) OR ((status)::text = ANY ((ARRAY['rejected'::character varying, 'cancelled'::character varying, 'closed'::character varying])::text[])) OR (facility_id IS NOT NULL))) NOT VALID"
    ];
    expect(columnBoundValue(definitions, 'indent_type')).toBeNull();
    expect(columnBoundValue(definitions, 'status')).toBeNull();
  });
});

describe('columnBoundValue: policy tiers', () => {
  const enumeration = "CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))";

  it('falls back to the enumeration when every allowed value is a trigger (tier 2)', () => {
    const definitions = [
      enumeration,
      "CHECK ((((status)::text <> 'a'::text) OR (x IS NOT NULL)))",
      "CHECK ((((status)::text <> 'b'::text) OR (y IS NOT NULL)))"
    ];
    expect(answersInEveryOrder(definitions, 'status')).toEqual(new Set(['a']));
    expect(explainColumnBoundValue(definitions, 'status').tier).toBe(2);
  });

  it('intersects two single-column enumerations of the same column, in every order', () => {
    const definitions = [
      "CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying, 'c'::character varying])::text[])))",
      "CHECK (((status)::text = ANY ((ARRAY['c'::character varying, 'b'::character varying])::text[])))"
    ];
    expect(answersInEveryOrder(definitions, 'status')).toEqual(new Set(['b']));
  });

  it('keeps the authored list order, so the first allowed value is the initial state', () => {
    expect(columnBoundValue([enumeration], 'status')).toBe('a');
  });
});

describe('columnBoundValue: atom shapes from pg_get_constraintdef', () => {
  it('reads a single equality, with and without casts', () => {
    expect(columnBoundValue(["CHECK ((realm = 'staff'::text))"], 'realm')).toBe('staff');
    expect(columnBoundValue(["CHECK (((realm)::text = 'staff'::text))"], 'realm')).toBe('staff');
  });

  it('reads an OR of equalities inside a single-column conjunct as one enumeration', () => {
    const definitions = ["CHECK ((((mode)::text = 'CASH'::text) OR ((mode)::text = 'CARD'::text)))"];
    expect(columnBoundValue(definitions, 'mode')).toBe('CASH');
  });

  it('binds a literal compared through a function of the column', () => {
    expect(columnBoundValue(["CHECK ((upper((code)::text) = 'ABC'::text))"], 'code')).toBe('ABC');
  });

  it('unescapes doubled quotes inside a literal', () => {
    expect(columnBoundValue(["CHECK ((label = 'it''s'::text))"], 'label')).toBe("it's");
  });

  it('takes nothing from a format constraint', () => {
    expect(columnBoundValue(["CHECK (((digest)::text ~ '^[0-9a-f]{64}$'::text))"], 'digest')).toBeNull();
    expect(columnBoundValue(["CHECK (((path)::text ~~ '/%'::text))"], 'path')).toBeNull();
    expect(columnBoundValue(["CHECK ((path ~~* '/%'::text))"], 'path')).toBeNull();
  });

  it('ignores a trailing NOT VALID and a NO INHERIT clause', () => {
    expect(columnBoundValue(["CHECK ((status = 'open'::text)) NOT VALID"], 'status')).toBe('open');
    expect(columnBoundValue(["CHECK ((status = 'open'::text)) NO INHERIT"], 'status')).toBe('open');
  });

  it('treats a CASE expression as one opaque atom that still references its columns', () => {
    const definitions = ["CHECK (CASE WHEN ((kind)::text = 'a'::text) THEN (x IS NOT NULL) ELSE true END)"];
    expect(columnBoundValue(definitions, 'kind')).toBeNull();
    expect([...referencedColumns(parseCheckDefinition(definitions[0]))].sort()).toEqual(['kind', 'x']);
  });

  it('rejects text that is not a CHECK definition', () => {
    expect(() => parseCheckDefinition('FOREIGN KEY (a) REFERENCES b(id)')).toThrow(/not a CHECK definition/);
  });
});

describe('classifyAtom', () => {
  const atomsOf = definition => {
    const found = [];
    const walk = node => {
      if (node.kind === 'atom') found.push(node);
      else if (node.kind === 'not') walk(node.child);
      else node.children.forEach(walk);
    };
    walk(parseCheckDefinition(definition));
    return found.map(classifyAtom);
  };

  it('classifies the shapes that bind a literal to a column', () => {
    expect(atomsOf("CHECK ((((event_type)::text <> 'release'::text) OR (release_method IS NOT NULL)))")).toEqual([
      { column: 'event_type', polarity: 'negative', literals: ['release'] },
      { column: 'release_method', polarity: 'null', literals: [] }
    ]);
    expect(atomsOf("CHECK (((event_type)::text <> ALL ((ARRAY['x'::character varying, 'y'::character varying])::text[])))")).toEqual([
      { column: 'event_type', polarity: 'negative', literals: ['x', 'y'] }
    ]);
    expect(atomsOf("CHECK ((length((code)::text) <= 12))")).toEqual([
      { column: 'code', polarity: 'opaque', literals: [] }
    ]);
    expect(atomsOf("CHECK ((metadata ? 'acceptance_snapshot'::text))")).toEqual([
      { column: 'metadata', polarity: 'opaque', literals: [] }
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails for the right reason**

Run: `npm test -- --runTestsByPath src/tests/unit/comprehensiveSeedCheckedValue.test.js 2>&1 | grep -E "Cannot find module|FAIL|Tests:"`
Expected: `FAIL` with `Cannot find module '../../../scripts/lib/checkConstraintValues.mjs'`.

---

### Task 2: The module

**Files:**
- Create: `apps/backend/scripts/lib/checkConstraintValues.mjs`
- Test: `apps/backend/src/tests/unit/comprehensiveSeedCheckedValue.test.js` (from Task 1)

- [ ] **Step 1: Write the module**

```js
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

const isPunct = (token, value) => token !== undefined && token.type === 'punct' && token.value === value;
const isKeyword = (token, value) => token !== undefined && token.type === 'keyword' && token.value === value;

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
        for (match = nextWord(); match && TYPE_TAIL.has(match[1].toLowerCase()); match = nextWord()) {
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
        KEYWORDS.has(upper) ? { type: 'keyword', value: upper } : { type: 'ident', value: raw.toLowerCase() }
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
    if (!op) throw new Error(`tokenize: unexpected character ${JSON.stringify(ch)} at ${i} in ${sql}`);
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
      else if (depth === 0 && caseDepth === 0 && (isKeyword(token, 'AND') || isKeyword(token, 'OR'))) {
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
        after === undefined || isKeyword(after, 'AND') || isKeyword(after, 'OR') || isPunct(after, ')');
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
  if (pos !== tokens.length) throw new Error(`parse: trailing tokens at ${pos} of ${tokens.length}`);
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
  if (isKeyword(operator, 'NOT') && rest[0] && rest[0].type === 'keyword' && FORMAT_KEYWORDS.has(rest[0].value)) {
    return { column, polarity: 'format', literals: [] };
  }
  if (operator.type === 'op' && (operator.value === '=' || operator.value === '<>' || operator.value === '!=')) {
    const positive = operator.value === '=';
    const quantifier = rest[0];
    if (isKeyword(quantifier, 'ANY') || isKeyword(quantifier, 'ALL')) {
      if (literals.length === 0) return opaque();
      if (positive && isKeyword(quantifier, 'ANY')) return { column, polarity: 'positive', literals };
      if (!positive && isKeyword(quantifier, 'ALL')) return { column, polarity: 'negative', literals };
      return opaque();
    }
    const plain = rest.every(
      token => token.type === 'string' || token.type === 'cast' || isPunct(token, '(') || isPunct(token, ')')
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
```

- [ ] **Step 2: Run the unit test**

Run: `npm test -- --runTestsByPath src/tests/unit/comprehensiveSeedCheckedValue.test.js 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕"`
Expected: `PASS`, `Tests: 22 passed, 22 total` (count may differ by one or two if `it.each` rows are counted separately; no `✕` lines).

- [ ] **Step 3: Format and lint the two new files**

Run:
```bash
node node_modules/prettier/bin/prettier.cjs --write scripts/lib/checkConstraintValues.mjs src/tests/unit/comprehensiveSeedCheckedValue.test.js
node node_modules/eslint/bin/eslint.js --max-warnings=0 scripts/lib/checkConstraintValues.mjs src/tests/unit/comprehensiveSeedCheckedValue.test.js && echo eslint-ok
```
Expected: prettier rewrites both (only whitespace/wrapping), `eslint-ok`. Re-run Step 2 after formatting; still PASS.

- [ ] **Step 4: Whole-schema proof against the live schema (not committed)**

From the scratchpad `o14` directory, with `DATABASE_URL` pointing at `vh_dq14m` (schema at migration 762):

```bash
node -e "
import('file:///C:/Users/subas/AppData/Local/Temp/claude/D--Dev/2f11079d-26a5-4494-b8f9-583c88a21415/scratchpad/wt/o22/apps/backend/scripts/lib/checkConstraintValues.mjs').then(async m => {
  const { createRequire } = await import('node:module');
  const { Client } = createRequire(process.env.BACKEND_DIR + '/package.json')('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const checks = (await c.query(\"SELECT conrelid::regclass::text t, pg_get_constraintdef(oid) d FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace\")).rows;
  const cols = (await c.query(\"SELECT table_name t, column_name col FROM information_schema.columns WHERE table_schema='public' AND udt_name IN ('bpchar','char','name','text','varchar')\")).rows;
  await c.end();
  const by = new Map(); for (const r of checks) { if (!by.has(r.t)) by.set(r.t, []); by.get(r.t).push(r.d); }
  let parsed = 0; for (const r of checks) { m.parseCheckDefinition(r.d); parsed++; }
  let flips = 0, answered = 0; for (const x of cols) { const d = by.get(x.t); if (!d) continue; const a = m.columnBoundValue(d, x.col), b = m.columnBoundValue([...d].reverse(), x.col); if (a !== b) flips++; if (a !== null) answered++; }
  console.log(JSON.stringify({ definitions: checks.length, parsed, textColumnsAnswered: answered, orderFlips: flips }));
});"
```
Expected: `definitions` 2107, `parsed` 2107, `orderFlips` 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/checkConstraintValues.mjs src/tests/unit/comprehensiveSeedCheckedValue.test.js
git commit -m "feat(seed): column-bound, order-independent CHECK literal extraction module

Tokenizer + boolean-skeleton parser over pg_get_constraintdef output with
classified atoms; explainColumnBoundValue/columnBoundValue compute a text
column's seed value from the SET of its table's CHECK definitions: the
single-column enumeration minus literals that would engage a side condition
on another column, else the enumeration, else null. Unit test asserts the
same answer in forward, reversed and shuffled orders, including the three
real definition sets that previously needed override pins.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wire the seeder to the module

**Files:**
- Modify: `apps/backend/scripts/seed-comprehensive-test-data.mjs:12` (import) and `:551-581` (`checkedValue`)

- [ ] **Step 1: Add the import after line 12**

Old (line 12):
```js
import { assertSyntheticSeedTarget } from './lib/testDataSeedGuard.mjs';
```
New:
```js
import { assertSyntheticSeedTarget } from './lib/testDataSeedGuard.mjs';
import { columnBoundValue } from './lib/checkConstraintValues.mjs';
```

- [ ] **Step 2: Replace `checkedValue` (the whole function from `function checkedValue(` up to the blank line before `function semanticValue(`)**

New:
```js
function checkedValue(checksByTable, table, column) {
  const textTypes = new Set(['bpchar', 'char', 'name', 'text', 'varchar']);
  if (!textTypes.has(column.udt_name)) return null;
  // A literal belongs to THIS column only when the atom carrying it compares
  // this column; a literal that would engage a side condition on another
  // column (`event_type <> 'release' OR release_method IS NOT NULL`) is
  // avoided; and the answer is a function of the set of definitions, never of
  // the order the catalog returned them in. Format constraints (regex, LIKE)
  // contribute nothing, so semanticValue answers those as before. See
  // scripts/lib/checkConstraintValues.mjs.
  return columnBoundValue(checksByTable.get(table) || [], column.column_name);
}
```

- [ ] **Step 3: Run the seeder-reading unit suites and the new suite**

Run: `npm test -- --runTestsByPath src/tests/unit/comprehensiveSeedCheckedValue.test.js src/tests/unit/structuredReportSeedOverrides.test.js src/tests/unit/comprehensiveSeedCoreRefs.test.js src/tests/unit/clinicalImportComprehensiveSeed.test.js src/tests/unit/carePathwaySeedOwnership.test.js src/tests/unit/clinicalContinuitySeedFixture.test.js src/tests/unit/clinicalContinuitySeedInertTables.test.js src/tests/unit/fhirVitalObservationSeedCoverage.test.js src/tests/unit/ciSetupDbFailClosed.test.js 2>&1 | grep -E "^(PASS|FAIL)|Tests:"`
Expected: all `PASS`.

- [ ] **Step 4: Lint the seeder**

Run: `node node_modules/eslint/bin/eslint.js --max-warnings=0 scripts/seed-comprehensive-test-data.mjs && echo eslint-ok`
Expected: `eslint-ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-comprehensive-test-data.mjs
git commit -m "fix(seed): make checkedValue column-bound and order-independent

Delegates to scripts/lib/checkConstraintValues.mjs. The old function matched
the column as a substring, harvested the first literal of the whole
definition and returned whichever definition came first; since dce625f48
that order was frozen by constraint name, which froze wrong answers
(facility_asset_events.event_type = 'status_changed', the failing branch)
rather than fixing them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Retire the three compensating pins

**Files:**
- Modify: `apps/backend/scripts/seed-comprehensive-test-data.mjs` (`TABLE_COLUMN_SEED_OVERRIDES`)

- [ ] **Step 1: Confirm no test anchors on the removed blocks**

Run: `grep -rn -E "body_custody_events|facility_asset_events|LINE_MATERIALIZED" src/tests/unit/*.test.js | head`
Expected: no anchors on `body_custody_events: {` / `facility_asset_events: {` blocks in the override map (any hits must be reviewed; the structured-report test anchors on radiology/AP tables only).

- [ ] **Step 2: Rewrite the pharmacy pin comment and drop `event_type`**

Old:
```js
  // mig 753: chk_pharmacy_funding_event_generation_753 splits on event_type —
  // FUNDING_RESOLVED and AUTHORITY_INVALIDATED carry an authority_generation
  // and, past generation 1, a supersedes_event_id; every other kind must carry
  // NEITHER. checkedValue() would pick whichever literal happens to come first
  // across two different CHECK definitions that both mention event_type, so
  // this table's validity depended on pg_constraint row order: it passed on one
  // database and failed on another with the same schema. Pin the plain,
  // lineage-free event kind so the row is correct either way.
  pharmacy_funding_decision_events: {
    event_type: 'LINE_MATERIALIZED',
    authority_generation: null,
    supersedes_event_id: null
```
New:
```js
  // mig 753: chk_pharmacy_funding_event_generation_753 splits on event_type —
  // FUNDING_RESOLVED and AUTHORITY_INVALIDATED carry an authority_generation
  // and, past generation 1, a supersedes_event_id; every other kind must carry
  // NEITHER. event_type needs no pin: checkedValue() derives LINE_MATERIALIZED
  // from the allowed-values CHECK because both lineage kinds appear in the
  // multi-column CHECK and are avoided. The two lineage columns are not text,
  // so the walker would fill them (1 and an FK) and satisfy neither branch;
  // they stay pinned NULL.
  pharmacy_funding_decision_events: {
    authority_generation: null,
    supersedes_event_id: null
```

- [ ] **Step 3: Remove the body_custody_events and facility_asset_events blocks**

Old:
```js
  // mig 414: body_custody_release_has_method requires release_method whenever
  // event_type = 'release'. checkedValue() scans the table's CHECK definitions
  // in pg_constraint order — which is UNORDERED — and event_type appears in
  // two of them: the IN-list (first literal 'receive', row passes) and the
  // conditional CHECK (first literal 'release', row fails because the nullable
  // release_method is never filled). Whichever definition the catalog returns
  // first decided pass vs fail — the intermittent 801/802 seeded-coverage
  // failure. Pin the safe branch deterministically.
  body_custody_events: {
    event_type: 'receive'
  },
  // mig 704 has the same catalog-order ambiguity: event_type appears in both
  // its allowed-values CHECK and a conditional transition-evidence CHECK. If
  // the latter is visited first, checkedValue() chooses status_changed while
  // nullable to_status remains unset. Pin a non-transition event so the seed
  // is deterministic on fresh PostgreSQL catalogs.
  facility_asset_events: {
    event_type: 'created'
  },
```
New: (nothing; the `stemi_activations` block above is followed directly by the `cath_lab_cases` comment).

- [ ] **Step 4: Run the seeder-reading unit suites again and lint**

Run: `npm test -- --runTestsByPath src/tests/unit/comprehensiveSeedCheckedValue.test.js src/tests/unit/structuredReportSeedOverrides.test.js src/tests/unit/comprehensiveSeedCoreRefs.test.js 2>&1 | grep -E "^(PASS|FAIL)|Tests:"; node node_modules/eslint/bin/eslint.js --max-warnings=0 scripts/seed-comprehensive-test-data.mjs && echo eslint-ok`
Expected: all `PASS`, `eslint-ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-comprehensive-test-data.mjs
git commit -m "fix(seed): retire the three event_type pins that compensated for checkedValue

body_custody_events, facility_asset_events and pharmacy_funding_decision_events
event_type now resolve to 'receive', 'created' and 'LINE_MATERIALIZED' from
the CHECK definitions alone, in every order. The pharmacy lineage columns
stay pinned NULL for the unrelated reason recorded in their comment.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Fresh-database proof, delta, mutation tests, full lint

**Files:** none committed (evidence for the pull request).

- [ ] **Step 1: Fresh schema-only database seed with the change**

From the scratchpad `o14` directory (runner recreates `vh_dq14` from the schema-only template `vh_dq14_schema`, applies any pending migrations, seeds, snapshots values):

Run: `bash run-seed-fresh.sh candidate vh_dq14`
Expected: `seed rc=0`, `"newlySeededTables": 654`, no `Comprehensive seed incomplete`, no `violates check constraint`, and `values-candidate.tsv` written.

- [ ] **Step 2: Delta against the baseline snapshot**

Run:
```bash
diff <(sort values-baseline.tsv) <(sort values-candidate.tsv) | grep -E '^[<>]' | awk -F'\t' '{print $1"\t"$2}' | sort -u | wc -l
diff <(sort values-baseline.tsv) <(sort values-candidate.tsv) | grep -E '^[<>]' | sort -t$'\t' -k1,2 | head -80
```
Expected: changed (table, column) pairs on the order of the offline estimate (170 changed + 113 fallen to semanticValue on NOT NULL generic-walker columns, plus their knock-on effects); every listed change explicable as (a) a column-bound enumeration value, (b) a semanticValue default replacing a neighbour's literal, or (c) a downstream row that changed because a referenced row changed. Save the full list to `delta-final.txt` for the PR.

- [ ] **Step 3: Mutation test A — first-literal reversion**

Temporarily change `explainColumnBoundValue` in the module so that `single` is treated as always true (replace `const single = columns.size === 1;` with `const single = true;`), run the unit test, expect `FAIL` (`body_custody_events`/`facility_asset_events` triggers vanish and neighbours' literals leak), then restore the line. Run: `npm test -- --runTestsByPath src/tests/unit/comprehensiveSeedCheckedValue.test.js 2>&1 | grep -E "^(PASS|FAIL)|Tests:"`.

- [ ] **Step 4: Mutation test B — drop the trigger exclusion**

Temporarily replace `const safe = allowed.find(value => !seenTrigger.has(value));` with `const safe = allowed[0];`, run the unit test, expect `FAIL` (`facility_asset_events` yields `'created'` still but `body_custody_events` still `'receive'`; the tier-2 test and the explain assertions fail), then restore. Then run the test once more and expect `PASS`; `git diff --stat` must be empty.

- [ ] **Step 5: Full backend lint and the CI-mode unit run**

Run: `npm run lint 2>&1 | tail -3` — expected rc 0 (`Secret scan passed`).
Run: `npm test -- --runTestsByPath src/tests/unit/comprehensiveSeedCheckedValue.test.js 2>&1 | grep -E "Tests:"` — expected all passed.

---

### Task 6: Marker, push, draft PR, hand-back

- [ ] **Step 1: Marker commit (must be last)**

```bash
git commit --allow-empty -m "ci: run the full canonical gate for the column-bound seed values [full-ci]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Push both remotes and verify**

```bash
git push -u github fix/seed-checked-value-column-bound
git push origin fix/seed-checked-value-column-bound
git ls-remote --heads github fix/seed-checked-value-column-bound
```
Expected: remote head equals `git rev-parse HEAD`.

- [ ] **Step 3: Open the draft PR**

`gh pr create -R Bahuleyandr/VH-Health-Platform --draft --base main --head fix/seed-checked-value-column-bound --title "fix(seed): column-bound, order-independent CHECK values in the comprehensive seed (OPEN-14)" --body-file <scratchpad>/o14/pr-body.md`

The body states: the defect and why `ORDER BY conname` froze wrong answers (facility_asset_events proof); the decisions (parser module; tiers 1-2, no branch tier; text tie-break); retired vs kept pins; the delta table; mutation-test results; verification; the flake signatures to distinguish (40001 / 23505 / teardown FK) if a backend shard goes red.

- [ ] **Step 4: Hand back to dev-ea**

Report PR number, head SHA, and then, after `poll-pr.ps1 -Pr <N>`, `Merge Gate` and `Full Merge Gate` by name. Do not merge, mark ready, or delete branches. Drop scratch DBs `vh_dq14`, `vh_dq14m`, `vh_dq14_schema` when done.
