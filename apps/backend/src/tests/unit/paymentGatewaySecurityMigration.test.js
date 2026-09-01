import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const migration = (name) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const normalizedSha256 = (contents) => createHash('sha256')
  .update(contents.replace(/\r\n/g, '\n'))
  .digest('hex');

describe('payment gateway security migration contracts', () => {
  it('keeps every published payment migration immutable', () => {
    const published = {
      '693_payment_gateway_provider_configs.sql': 'c4cad9d0f23ab70a156a4b8d4303d720efea98312b8f996fc707049f454c09ef',
      '694_payment_gateway_orders.sql': 'd96c6762313999c3abec8c7827c1760269b2ac5eae14e2a57196a58935c1b4ac',
      '695_payment_gateway_webhook_events.sql': 'c08684b7534e93ba04194810eb7a4fab55bad3d95cb6e11d9bfcc4afbf10cd8a',
      '697_payment_gateway_refunds.sql': '811dfb84df7980f86fea63da318077005fb9a10c0fff6d84e462876405ecf727',
      '708_payment_gateway_refund_security_upgrade.sql': '3f46084137f77d6c4a10da3819ed98348b1a957258dc568669d785cbdff234dc',
      '712_payment_gateway_operational_safety.sql': 'f7d5eff70c0b0eb50e7db385f325baccf91ee723f6fa3e5bb985b49e1009413e',
      '713_payment_gateway_settlement_integrity.sql': '2efbdae1d74020ddacdce6af71fb2c6a4f0906845f33dccc61a0f9db7c009c4d',
    };
    for (const [name, digest] of Object.entries(published)) {
      expect(normalizedSha256(migration(name))).toBe(digest);
    }
  });

  it('cannot enable a live provider without the webhook verification secret', () => {
    const sql = migration('693_payment_gateway_provider_configs.sql');
    expect(sql).toMatch(/key_id IS NOT NULL[\s\S]*key_secret_ciphertext IS NOT NULL[\s\S]*webhook_secret_ciphertext IS NOT NULL/i);
  });

  it('keeps the published migration 697 immutable', () => {
    expect(normalizedSha256(migration('697_payment_gateway_refunds.sql')))
      .toBe('811dfb84df7980f86fea63da318077005fb9a10c0fff6d84e462876405ecf727');
  });

  it('additively persists a constrained, provider-unique refund idempotency key', () => {
    const sql = migration('708_payment_gateway_refund_security_upgrade.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS provider_idempotency_key VARCHAR\(120\)/i);
    expect(sql).toMatch(/ALTER COLUMN provider_idempotency_key SET NOT NULL/i);
    expect(sql).toContain("CHECK (provider_idempotency_key ~ '^[A-Za-z0-9_-]{10,120}$')");
    expect(sql).toMatch(/UNIQUE INDEX[\s\S]*\(tenant_id, provider, provider_idempotency_key\)/i);
  });

  it('keeps evidence-mismatched refunds live and blocked for reconciliation', () => {
    const sql = migration('708_payment_gateway_refund_security_upgrade.sql');
    expect(sql).toMatch(/ALTER COLUMN status TYPE VARCHAR\(30\)/i);
    expect(sql).toMatch(/CHECK \(status IN \([^)]+requires_reconciliation[^)]+\)\)/i);
    expect(sql).toMatch(/ux_pg_refund_billing_refund_live[\s\S]*requires_reconciliation/i);
    expect(sql).toMatch(/provider_idempotency_key IS NULL[\s\S]*status = 'initiated'/i);
    expect(sql).toContain("status = 'requires_reconciliation'");
  });

  it('keeps the published migration 712 immutable', () => {
    expect(normalizedSha256(migration('712_payment_gateway_operational_safety.sql')))
      .toBe('f7d5eff70c0b0eb50e7db385f325baccf91ee723f6fa3e5bb985b49e1009413e');
    const sql = migration('712_payment_gateway_operational_safety.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reconciliation_note VARCHAR\(500\)/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reconciled_by UUID/i);
    expect(sql).toMatch(/status = 'requires_reconciliation'[\s\S]*reconciled_at IS NULL/i);
    expect(sql).toMatch(/length\(btrim\(reconciliation_note\)\) BETWEEN 10 AND 500/i);
  });

  it('applies payment credential, payout-rail, actor, and execution integrity forward in 713', () => {
    const sql = migration('713_payment_gateway_settlement_integrity.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS webhook_credential_version INTEGER/i);
    expect(sql).toMatch(/chk_pg_provider_config_live_credentials[\s\S]*webhook_secret_ciphertext IS NOT NULL/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS payout_rail VARCHAR\(20\)/i);
    expect(sql).toMatch(/reconciled_by IS NOT NULL/i);
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, reconciled_by\)[\s\S]*REFERENCES users \(tenant_id, uid\)/i);
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, id, gateway_refund_id\)[\s\S]*REFERENCES payment_gateway_refunds \(tenant_id, billing_refund_id, id\)/i);
    expect(sql).toMatch(/retained_manual_payout_conflict/i);
  });

  it('requires a tenant-bound actor for every resolved gateway order in 715', () => {
    const sql = migration('715_payment_gateway_order_reconciliation_actor.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reconciled_by UUID/i);
    expect(sql).toMatch(/legacy_actorless_reconciliation/i);
    expect(sql).toMatch(/reconciled_at IS NULL[\s\S]*reconciliation_note IS NULL[\s\S]*reconciled_by IS NULL/i);
    expect(sql).toMatch(/status = 'requires_reconciliation'[\s\S]*reconciled_by IS NOT NULL/i);
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, reconciled_by\)[\s\S]*REFERENCES users \(tenant_id, uid\)/i);
  });

  it('registers a fenced, typed, structured refund recovery contract in 752', () => {
    const sql = migration('752_payment_gateway_refund_recovery.sql');
    expect(sql).toMatch(/provider_request_fingerprint CHAR\(64\)/i);
    expect(sql).toMatch(/provider_request_replay_authorized BOOLEAN/i);
    expect(sql).toMatch(/provider_request_replay_authorized = FALSE[\s\S]*SET DEFAULT FALSE[\s\S]*SET NOT NULL/i);
    expect(sql).toMatch(/legacy_refund_authority_invalid/i);
    expect(sql).toMatch(/legacy_refund_replay_identity_unavailable/i);
    expect(sql).toMatch(/initiated_at > billing\.approved_at/i);
    expect(sql).toMatch(/recovery_claim_token IS NULL[\s\S]*recovery_state <> 'claimed'/i);
    expect(sql).toMatch(/recovery_claim_token IS NOT NULL[\s\S]*recovery_state = 'claimed'/i);
    expect(sql).toContain("'payment_gateway_refund_recovery'");
    expect(sql).toContain("'payment_gateway_refunds'");
    expect(sql).toContain("'domain_evidence'");
    expect(sql).toMatch(/reconciliation_disposition IN \([\s\S]*provider_status_unknown/i);
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, reconciliation_reviewed_by\)[\s\S]*REFERENCES users \(tenant_id, uid\)/i);
    expect(sql).toMatch(/legacy_gateway_refund_reconciliation[\s\S]*migration_752_structured_reconciliation_required/i);
    expect(sql).toMatch(/reconciled_at IS NULL[\s\S]*reconciliation_note IS NULL[\s\S]*reconciled_by IS NULL/i);
    expect(sql).toMatch(/recovery_state NOT IN \('succeeded', 'failed'\)[\s\S]*recovery_task_id IS NULL/i);
    expect(sql).toMatch(/automatic gateway refund recovery requires independent same-tenant post-approval authority/i);
    expect(sql).toMatch(/provider refund creation requires an explicitly authorized replay identity/i);
    expect(sql).toMatch(/gateway refund reconciliation evidence cannot be future-dated/i);
    expect(sql).toMatch(/reconciliation_disposition = 'provider_failed'[\s\S]*provider_refund_id IS NOT NULL[\s\S]*reconciled_at IS NOT NULL/i);
    expect(sql).toMatch(/reconciliation_disposition = 'provider_failed'[\s\S]*provider_refund_id IS NULL[\s\S]*reconciled_at IS NULL/i);
    expect(sql).toMatch(/INSERT INTO workflow_sla_instances[\s\S]*backfilled_by'[\s\S]*migration_752/i);
    expect(sql).toMatch(/INSERT INTO tasks[\s\S]*workflow_sla_instance_id[\s\S]*domain_evidence/i);
    expect(sql).toMatch(/752 postflight: unresolved gateway refund lacks an exact task\/SLA obligation/i);
    expect(sql).toMatch(/provider_request_fingerprint = payment_gateway_refund_request_fingerprint/i);
    const dueIndex = sql.match(/CREATE INDEX IF NOT EXISTS idx_pg_refund_recovery_due[\s\S]*?;/i)?.[0];
    expect(dueIndex).not.toContain('blocked_authority');
  });

  it('seeds the refund recovery SLA as a global rule in 752', () => {
    const sql = migration('752_payment_gateway_refund_recovery.sql');
    expect(sql).toMatch(
      /INSERT INTO workflow_sla_rules\s*\(\s*tenant_id,\s*rule_code,[\s\S]*?\)\s*VALUES\s*\(\s*NULL::uuid,\s*'payment_gateway_refund_recovery'/i,
    );
  });
});
