import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../..');

// Migration SQL is LF-pinned at checkout, but normalise defensively for
// historical CRLF blobs or tools that bypass attributes. The digests below are
// already taken over LF-normalised text, and a stray \r is no part of any
// contract.
function read(relativePath) {
  return fs.readFileSync(path.join(backend, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function normalizedSha256(contents) {
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n')).digest('hex');
}

describe('ABDM/UHI security migration contract', () => {
  it('keeps the published 701/703/705/707 migrations immutable', () => {
    const expected = new Map([
      ['701_abha_enrolment_sessions.sql', 'dc347d06c8e6b9a8dc2490f8c560027feba68523339166e9013d9ddc22d3a6e5'],
      ['703_abdm_hiu_fetch_sessions.sql', 'bc9eb0b481dae15e64673ecb156dd4d0e03af5c0842ab6bb0736bdab7c477470'],
      ['705_uhi_transactions.sql', 'dd8facdeb867cde94a66daace5bfcde10cfd547e07e0d6405c90512889717509'],
      ['707_abdm_uhi_security_upgrade.sql', '5a199be36108305db0b049cf4d27a2d976b2b51de3cdf2b2d31df2bf18b2686d'],
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
    expect(sql).toContain(
      'legacy HIU base-1000 page identity is not proven by callback evidence',
    );
    expect(sql).toMatch(
      /event_type = 'hiu_data_push'[\s\S]*?signature_verified IS TRUE[\s\S]*?entry_count > 1000/,
    );
    expect(sql).toMatch(/entry_count <= MOD\(b\.part_number, 1000\)/);
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

  it('repairs published 707 page evidence and counts through additive migration 714', () => {
    const sql = read('src/migrations/714_abdm_hiu_page_evidence_reconciliation.sql');
    expect(sql).toContain('exactly one authenticated callback receipt');
    expect(sql).toContain("event.payload->>'authenticatedHipId'");
    expect(sql).toContain("parsed_payload #>> '{hip,id}'");
    expect(sql).toMatch(/UPDATE abdm_consent_artifacts artifact[\s\S]*?\{hip_id\}/);
    expect(sql).toMatch(/event\.signature_verified IS TRUE/);
    expect(sql).toMatch(/authenticated_hip_id <> e\.expected_hip_id/);
    expect(sql).toMatch(/NOT e\.authenticated_hip_recorded/);
    expect(sql).not.toMatch(/tenant_interop_secrets/);
    expect(sql).not.toMatch(/kind = 'abdm_callback'/);
    expect(sql).toMatch(
      /evidence_page_number > 2147483647[\s\S]*?evidence_page_count > 2147483647/,
    );
    expect(sql).toMatch(/evidence_entry_count > 1000/);
    expect(sql).toMatch(/evidence_entry_count <> e\.bundle_count/);
    expect(sql).toContain('native and 707-backfilled HIU parts are mixed on one page');
    expect(sql).toMatch(
      /COUNT\(b\.id\)::integer AS bundle_count[\s\S]*?parts_received = stats\.bundle_count/,
    );
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
    // `prisma db pull` aligns each model's name/type columns on that model's
    // widest field, so the padding inside a field line moves whenever an
    // unrelated field is added or removed. Two of these assertions used to
    // spell that padding out: 'payload_sha256  String' only ever matched
    // because hl7_outbound_acknowledgements.acknowledgement_payload_sha256
    // happened to align to two spaces — a different model entirely, so the
    // check said nothing about abdm_hiu_fetch_pages and survived a re-pull
    // only by luck. Read the model out and assert the field inside it, with
    // the @db mapping the migration actually declares.
    const modelBody = (name) => {
      const match = new RegExp(`^model ${name} \\{$([\\s\\S]*?)^\\}$`, 'm').exec(schema);
      expect(match).not.toBeNull();
      return match[1];
    };

    expect(schema).toMatch(/pages_expected\s+Int\?/);
    expect(schema).toMatch(/next_page_number\s+Int\s+@default\(1\)/);
    const fetchPages = modelBody('abdm_hiu_fetch_pages');
    // CHAR(64) NOT NULL in 707 — a nullable or re-typed digest column would
    // let an unverified page body through the reconciliation in 714.
    expect(fetchPages).toMatch(/^\s*payload_sha256\s+String\s+@db\.Char\(64\)\s*$/m);
    expect(fetchPages).toContain('@@unique([tenant_id, fetch_session_id, page_number]');
    const uhiTransactions = modelBody('uhi_transactions');
    expect(uhiTransactions).toMatch(
      /^\s*counterparty_subscriber_id\s+String\s+@db\.VarChar\(200\)\s*$/m,
    );
    expect(uhiTransactions).toContain(
      '@@unique([tenant_id, environment, counterparty_subscriber_id, transaction_id, message_id, action, direction, signature_verified], map: "uq_uhi_txn_leg")',
    );
  });
});
