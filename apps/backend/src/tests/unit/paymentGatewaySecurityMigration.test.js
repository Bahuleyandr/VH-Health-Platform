import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const migration = (name) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const normalizedSha256 = (contents) => createHash('sha256')
  .update(contents.replace(/\r\n/g, '\n'))
  .digest('hex');

describe('payment gateway security migration contracts', () => {
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
});
