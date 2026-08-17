import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(backend, relativePath), 'utf8');
}

function normalizedSha256(contents) {
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n')).digest('hex');
}

describe('ABDM/UHI security migration contract', () => {
  it('keeps the published 701/703/705 migrations immutable', () => {
    const expected = new Map([
      ['701_abha_enrolment_sessions.sql', 'dc347d06c8e6b9a8dc2490f8c560027feba68523339166e9013d9ddc22d3a6e5'],
      ['703_abdm_hiu_fetch_sessions.sql', 'bc9eb0b481dae15e64673ecb156dd4d0e03af5c0842ab6bb0736bdab7c477470'],
      ['705_uhi_transactions.sql', 'dd8facdeb867cde94a66daace5bfcde10cfd547e07e0d6405c90512889717509'],
    ]);
    for (const [name, digest] of expected) {
      expect(normalizedSha256(read(`src/migrations/${name}`))).toBe(digest);
    }
  });

  it('keeps the published enrolment FK initially immediate', () => {
    const sql = read('src/migrations/701_abha_enrolment_sessions.sql');
    expect(sql).toMatch(
      /CONSTRAINT fk_abha_enrolment_patient[\s\S]*?FOREIGN KEY \(tenant_id, patient_uid\)[\s\S]*?DEFERRABLE INITIALLY IMMEDIATE/,
    );
  });

  it('upgrades OTP verification through an additive idempotent claim-token CAS schema', () => {
    const sql = read('src/migrations/707_abdm_uhi_security_upgrade.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS verification_claim_id UUID/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS verification_claimed_at TIMESTAMPTZ/);
    expect(sql).toMatch(/'otp_sent', 'otp_verifying', 'otp_verified'/);
    expect(sql).toMatch(
      /WHERE status IN \('initiated', 'otp_sent', 'otp_verifying', 'otp_verified'\)/,
    );
  });

  it('upgrades strict ordered-page state with guarded legacy backfill', () => {
    const sql = read('src/migrations/707_abdm_uhi_security_upgrade.sql');
    expect(sql).toMatch(/pages_expected\s+INTEGER[\s\S]*?pages_expected >= 1/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS next_page_number INTEGER DEFAULT 1/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS abdm_hiu_fetch_pages/);
    expect(sql).toMatch(/payload_sha256\s+CHAR\(64\) NOT NULL/);
    expect(sql).toContain('legacy HIU bundles collide on derived page and part identity');
    expect(sql).toContain('legacy HIU bundle pages are not contiguous from page one');
    expect(sql).toMatch(/ENCODE\(DIGEST\([\s\S]*?'sha256'[\s\S]*?\), 'hex'\)/);
    expect(sql).toMatch(/ALTER COLUMN fetch_page_id SET NOT NULL/);
    expect(sql).toMatch(
      /UNIQUE \(tenant_id, fetch_session_id, page_number, part_number\)/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(tenant_id, fetch_session_id, fetch_page_id, page_number\)[\s\S]*?\(tenant_id, fetch_session_id, id, page_number\)/,
    );
    expect(sql).toMatch(/NOT VALID[\s\S]*?VALIDATE CONSTRAINT fk_abdm_hiu_bundle_page/);
  });

  it('backfills and binds UHI replay identity to sender, direction and signature outcome', () => {
    const sql = read('src/migrations/707_abdm_uhi_security_upgrade.sql');
    expect(sql).toMatch(/payload #>> '\{context,bap_id\}'/);
    expect(sql).toContain('UHI transaction lacks signed counterparty identity');
    expect(sql).toMatch(/ALTER COLUMN counterparty_subscriber_id SET NOT NULL/);
    expect(sql).toMatch(
      /UNIQUE \(tenant_id, environment, counterparty_subscriber_id,\s*transaction_id, message_id, action, direction, signature_verified\)/,
    );
  });

  it('keeps Prisma aligned with the migration security fields', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).toMatch(/pages_expected\s+Int\?/);
    expect(schema).toMatch(/next_page_number\s+Int\s+@default\(1\)/);
    expect(schema).toContain('model abdm_hiu_fetch_pages');
    expect(schema).toContain('payload_sha256  String');
    expect(schema).toContain('@@unique([tenant_id, fetch_session_id, page_number]');
    expect(schema).toContain('counterparty_subscriber_id  String        @db.VarChar(200)');
    expect(schema).toContain(
      '@@unique([tenant_id, environment, counterparty_subscriber_id, transaction_id, message_id, action, direction, signature_verified], map: "uq_uhi_txn_leg")',
    );
  });
});
