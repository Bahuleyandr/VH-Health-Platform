import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(backend, relativePath), 'utf8');
}

describe('ABDM/UHI security migration contract', () => {
  it('keeps the enrolment patient FK deferrable for atomic patient merge', () => {
    const sql = read('src/migrations/701_abha_enrolment_sessions.sql');
    expect(sql).toMatch(
      /CONSTRAINT fk_abha_enrolment_patient[\s\S]*?FOREIGN KEY \(tenant_id, patient_uid\)[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
    );
  });

  it('pins strict ordered-page state in the HIU fetch ledger', () => {
    const sql = read('src/migrations/703_abdm_hiu_fetch_sessions.sql');
    expect(sql).toMatch(/pages_expected\s+INTEGER[\s\S]*?pages_expected >= 1/);
    expect(sql).toMatch(/next_page_number\s+INTEGER NOT NULL DEFAULT 1/);
  });

  it('binds UHI replay identity to sender, direction and signature outcome', () => {
    const sql = read('src/migrations/705_uhi_transactions.sql');
    expect(sql).toMatch(/counterparty_subscriber_id\s+VARCHAR\(200\) NOT NULL/);
    expect(sql).toMatch(
      /UNIQUE \(tenant_id, environment, counterparty_subscriber_id,\s*transaction_id, message_id, action, direction, signature_verified\)/,
    );
  });

  it('keeps Prisma aligned with the migration security fields', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).toMatch(/pages_expected\s+Int\?/);
    expect(schema).toMatch(/next_page_number\s+Int\s+@default\(1\)/);
    expect(schema).toContain('counterparty_subscriber_id  String        @db.VarChar(200)');
    expect(schema).toContain(
      '@@unique([tenant_id, environment, counterparty_subscriber_id, transaction_id, message_id, action, direction, signature_verified], map: "uq_uhi_txn_leg")',
    );
  });
});
