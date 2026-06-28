// CSV formula-injection neutralization (CAN-005).
//
// The shared helper now backs the RBAC, department, staff-ops attendance, and
// payroll exporters; the logs/HR-reporting/research exporters apply the same
// formula-lead guard inline. This locks the helper's behavior.
import { escapeCsvField, rowsToCsv } from '../../utils/csv.js';

describe('csv helper formula neutralization (CAN-005)', () => {
  it.each(['=cmd', '+1', '-1', '@x', '\tx', '\rx'])('neutralizes formula-leading cell %j', (v) => {
    // After any RFC-4180 quote wrap is stripped, the cell starts with the
    // single-quote guard so a spreadsheet renders it as literal text.
    expect(escapeCsvField(v).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('leaves a benign cell untouched', () => {
    expect(escapeCsvField('Alice')).toBe('Alice');
  });

  it('quotes + escapes embedded quotes/commas/newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('rowsToCsv neutralizes a formula cell within a row', () => {
    const out = rowsToCsv(['name'], [['=HYPERLINK("http://evil")']]);
    const dataLine = out.split('\r\n')[1];
    expect(dataLine.replace(/^"/, '').startsWith("'")).toBe(true);
  });
});
