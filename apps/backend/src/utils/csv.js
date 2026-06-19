// src/utils/csv.js
//
// CSV serialization helpers that are safe against BOTH classic CSV breakage
// (embedded quotes/commas/newlines) AND spreadsheet formula injection (a cell
// beginning with = + - @ or a tab/CR is executed as a formula by Excel/Sheets).
//
// Audit 2026-06-18 §3 (Admin): the appointment CSV export interpolated PHI text
// fields (patient_name, doctor_name, department, reason) straight into the row
// with only naive double-quote wrapping — neither escaping embedded quotes nor
// neutralizing formula-leading cells. Route exports must build rows through
// rowsToCsv()/escapeCsvField() so attacker-influenceable fields can't inject a
// formula or break the row structure.

// Characters that make a spreadsheet treat the cell as a formula.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
// Characters that require the field to be quoted in RFC-4180 CSV.
const NEEDS_QUOTING = /[",\n\r]/;

/**
 * Escape a single CSV cell: neutralize formula injection, then RFC-4180 quote.
 * @param {*} value - any value; null/undefined become an empty cell.
 * @returns {string}
 */
export function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Formula-injection guard: prefix a single quote so the spreadsheet renders
  // the literal text instead of evaluating it.
  if (FORMULA_LEAD.test(s)) {
    s = `'${s}`;
  }
  // RFC-4180: double embedded quotes and wrap when the cell carries a quote,
  // comma, or line break.
  if (NEEDS_QUOTING.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build a full CSV document (header + rows), escaping every field, joined with
 * CRLF per RFC-4180.
 * @param {Array<string>} headers
 * @param {Array<Array<*>>} rows  - array of field arrays, column-aligned to headers
 * @returns {string}
 */
export function rowsToCsv(headers, rows) {
  const lines = [headers, ...(rows || [])].map(
    (row) => (row || []).map(escapeCsvField).join(','),
  );
  return lines.join('\r\n');
}

export default { escapeCsvField, rowsToCsv };
