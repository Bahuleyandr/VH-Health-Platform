/**
 * CSV injection / escaping util (audit §3 Admin: appointment CSV export
 * interpolated PHI fields verbatim — formula-injection + broken-quoting risk).
 *
 * escapeCsvField must:
 *   - neutralize spreadsheet formula-injection (a cell starting with = + - @ or
 *     tab/CR is prefixed with a single quote so Excel/Sheets treats it as text)
 *   - double embedded double-quotes and wrap fields containing , " CR or LF
 *   - render null/undefined as empty, coerce non-strings
 * rowsToCsv builds a full CSV (header + escaped rows, CRLF-joined).
 */
import { escapeCsvField, rowsToCsv } from '../../utils/csv.js';

describe('escapeCsvField', () => {
  it('prefixes a formula-leading field so a spreadsheet treats it as text', () => {
    for (const lead of ['=', '+', '-', '@']) {
      // no comma/quote → not wrapped, so it starts with the neutralizing quote
      expect(escapeCsvField(`${lead}cmd`).startsWith("'")).toBe(true);
      expect(escapeCsvField(`${lead}cmd`).startsWith(lead)).toBe(false);
    }
  });

  it('doubles embedded quotes and wraps', () => {
    expect(escapeCsvField('a "b" c')).toBe('"a ""b"" c"');
  });

  it('wraps fields containing a comma or newline', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralizes AND quotes a formula field that also contains a comma', () => {
    // '=1,2' -> prefix "'" -> "'=1,2" -> contains comma -> wrapped
    expect(escapeCsvField('=1,2')).toBe('"\'=1,2"');
  });

  it('passes plain text through unchanged', () => {
    expect(escapeCsvField('John Doe')).toBe('John Doe');
  });

  it('renders null/undefined as empty and coerces numbers', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
    expect(escapeCsvField(42)).toBe('42');
  });
});

describe('rowsToCsv', () => {
  it('escapes every field in every row and CRLF-joins', () => {
    const csv = rowsToCsv(
      ['Name', 'Note'],
      [['=HYPERLINK("http://evil")', 'a,b'], ['John', 'plain']],
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Name,Note');
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://evil"")","a,b"');
    expect(lines[2]).toBe('John,plain');
  });

  it('escapes header fields too', () => {
    expect(rowsToCsv(['=evil', 'ok'], [])).toBe("'=evil,ok");
  });
});
