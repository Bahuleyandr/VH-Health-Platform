export function parseMigrationDirectives(sql) {
  const noTransaction = /^[ \t]*--[ \t]*@no-transaction\b/im.test(sql);
  const timeoutMatch = sql.match(/^[ \t]*--[ \t]*@statement_timeout:[ \t]*(\S+)/im);
  return {
    noTransaction,
    statementTimeout: timeoutMatch ? timeoutMatch[1].trim() : null,
  };
}

export function safeMigrationStatementTimeout(value, fallback = '120s') {
  if (value == null) return fallback;
  if (value === '0' || /^\d+(ms|s|min)?$/i.test(value)) return value;
  return fallback;
}
