/**
 * Split a Postgres SQL script into individual statements.
 *
 * Why this exists: Prisma's `$executeRawUnsafe(sql)` uses prepared statements,
 * which Postgres restricts to a single command per call. A multi-statement
 * `.sql` file (most of our migrations — they have BEGIN/COMMIT plus several
 * CREATE TABLE / CREATE INDEX / INSERT statements) is rejected with
 * `42601 — cannot insert multiple commands into a prepared statement`.
 *
 * The split has to respect Postgres-specific syntax that contains semicolons
 * which mustn't be treated as statement boundaries:
 *
 *   - Line comments    `-- ... \n`
 *   - Block comments   `/* ... *\/`
 *   - Single quotes    `'...'` with `''` escape
 *   - Double quotes    `"..."` with `""` escape  (identifier quoting)
 *   - Dollar quotes    `$$ ... $$`  and  `$tag$ ... $tag$`  (function bodies,
 *                      DO blocks, CREATE OR REPLACE FUNCTION ... AS $$ ... $$;)
 *
 * The splitter is a simple character-level state machine. Migration files
 * are small (<50 KB typically), so the linear walk is fine.
 *
 * Returns an array of statement strings, each trimmed and non-empty.
 * Comments and whitespace-only blocks between statements are dropped.
 *
 * @example
 *   splitStatements("CREATE TABLE x (id int);\n-- comment\nINSERT INTO x VALUES (1);")
 *   // → ["CREATE TABLE x (id int)", "INSERT INTO x VALUES (1)"]
 *
 *   splitStatements("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql;")
 *   // → ["CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql"]
 *
 * @param {string} sql - the full SQL script
 * @returns {string[]} - individual statements (trimmed, non-empty)
 */
export function splitStatements(sql) {
  if (typeof sql !== 'string' || sql.length === 0) return [];

  const statements = [];
  let buffer = '';
  let i = 0;
  const n = sql.length;

  // State machine. Only one mode is active at a time.
  let mode = 'normal';
  // Tag for dollar-quoted blocks. '' for `$$`, otherwise the inner identifier.
  let dollarTag = '';

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (mode === 'line_comment') {
      buffer += ch;
      if (ch === '\n') mode = 'normal';
      i += 1;
      continue;
    }

    if (mode === 'block_comment') {
      buffer += ch;
      if (ch === '*' && next === '/') {
        buffer += next;
        mode = 'normal';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (mode === 'single_quote') {
      buffer += ch;
      if (ch === "'") {
        // `''` is an escaped single quote — stay in the same mode.
        if (next === "'") {
          buffer += next;
          i += 2;
          continue;
        }
        mode = 'normal';
      }
      i += 1;
      continue;
    }

    if (mode === 'double_quote') {
      buffer += ch;
      if (ch === '"') {
        if (next === '"') {
          buffer += next;
          i += 2;
          continue;
        }
        mode = 'normal';
      }
      i += 1;
      continue;
    }

    if (mode === 'dollar_quote') {
      // Look for the matching closing `$tag$`.
      if (ch === '$') {
        const close = readDollarTag(sql, i);
        if (close !== null && close.tag === dollarTag) {
          buffer += close.literal;
          i += close.literal.length;
          mode = 'normal';
          dollarTag = '';
          continue;
        }
      }
      buffer += ch;
      i += 1;
      continue;
    }

    // mode === 'normal' from here.

    if (ch === '-' && next === '-') {
      buffer += ch + next;
      mode = 'line_comment';
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      buffer += ch + next;
      mode = 'block_comment';
      i += 2;
      continue;
    }

    if (ch === "'") {
      buffer += ch;
      mode = 'single_quote';
      i += 1;
      continue;
    }

    if (ch === '"') {
      buffer += ch;
      mode = 'double_quote';
      i += 1;
      continue;
    }

    if (ch === '$') {
      const open = readDollarTag(sql, i);
      if (open !== null) {
        buffer += open.literal;
        mode = 'dollar_quote';
        dollarTag = open.tag;
        i += open.literal.length;
        continue;
      }
      // Bare `$` not part of a quote opener — pass through.
      buffer += ch;
      i += 1;
      continue;
    }

    if (ch === ';') {
      const stmt = buffer.trim();
      if (stmt.length > 0 && !isCommentOnly(stmt)) {
        statements.push(stmt);
      }
      buffer = '';
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  // Trailing statement without a final `;` — common at end of files.
  const tail = buffer.trim();
  if (tail.length > 0 && !isCommentOnly(tail)) {
    statements.push(tail);
  }

  return statements;
}

/**
 * Try to parse a dollar-quote tag opener at position `i` of `sql`.
 *
 * Recognizes `$$` and `$tag$` where `tag` matches `[A-Za-z_][A-Za-z0-9_]*`.
 * Returns `{ tag, literal }` if matched, else `null`. `literal` is the full
 * matched string including both `$` characters.
 *
 * @param {string} sql
 * @param {number} i - position of the leading `$`
 */
function readDollarTag(sql, i) {
  if (sql[i] !== '$') return null;
  // `$$` → tag = ''
  if (sql[i + 1] === '$') return { tag: '', literal: '$$' };
  // `$tag$`
  let j = i + 1;
  while (j < sql.length) {
    const c = sql[j];
    const isFirst = j === i + 1;
    const validFirst = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
    const validRest = validFirst || (c >= '0' && c <= '9');
    if (isFirst && !validFirst) return null;
    if (!isFirst && !validRest && c !== '$') return null;
    if (c === '$') {
      // tag was sql[i+1 .. j-1]
      const tag = sql.slice(i + 1, j);
      if (tag.length === 0) return null; // `$$` already handled above
      return { tag, literal: sql.slice(i, j + 1) };
    }
    j += 1;
  }
  return null;
}

/**
 * Check whether a statement consists only of comments and whitespace.
 * Used so a file like `-- header\n\n` doesn't produce a no-op statement
 * that Prisma would reject as "empty query".
 */
function isCommentOnly(stmt) {
  // Strip line + block comments and check what's left.
  let i = 0;
  let mode = 'normal';
  let body = '';
  while (i < stmt.length) {
    const ch = stmt[i];
    const next = i + 1 < stmt.length ? stmt[i + 1] : '';
    if (mode === 'line_comment') {
      if (ch === '\n') mode = 'normal';
      i += 1;
      continue;
    }
    if (mode === 'block_comment') {
      if (ch === '*' && next === '/') {
        mode = 'normal';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      mode = 'line_comment';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = 'block_comment';
      i += 2;
      continue;
    }
    body += ch;
    i += 1;
  }
  return body.trim().length === 0;
}

export default splitStatements;
