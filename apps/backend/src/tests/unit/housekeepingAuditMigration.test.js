import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sql = fs.readFileSync(
  path.join(root, 'src/migrations/575_housekeeping_mutation_audit_triggers.sql'),
  'utf8',
);

describe('housekeeping semantic audit migration', () => {
  it('audits requests, cleaning logs, and floor assignments in their source transactions', () => {
    expect(sql).toContain('AFTER INSERT OR UPDATE ON housekeeping_requests');
    expect(sql).toContain('AFTER INSERT OR UPDATE ON housekeeping_logs');
    expect(sql).toContain('AFTER INSERT OR UPDATE ON housekeeping_floor_assignments');
    expect(sql.match(/INSERT INTO audit_logs/g)).toHaveLength(3);
  });

  it('stores operational metadata without duplicating free-text notes or descriptions', () => {
    expect(sql).toContain("'request_type', NEW.request_type");
    expect(sql).toContain("'staff_uid', NEW.staff_uid");
    expect(sql).not.toMatch(/NEW\.(?:notes|description|completion_notes|reason)/);
  });
});
