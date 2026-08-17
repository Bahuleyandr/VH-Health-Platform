import { readFileSync } from 'node:fs';

const migration = (name) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

describe('payment gateway security migration contracts', () => {
  it('cannot enable a live provider without the webhook verification secret', () => {
    const sql = migration('693_payment_gateway_provider_configs.sql');
    expect(sql).toMatch(/key_id IS NOT NULL[\s\S]*key_secret_ciphertext IS NOT NULL[\s\S]*webhook_secret_ciphertext IS NOT NULL/i);
  });

  it('persists a constrained, provider-unique refund idempotency key', () => {
    const sql = migration('697_payment_gateway_refunds.sql');
    expect(sql).toMatch(/provider_idempotency_key\s+VARCHAR\(120\)\s+NOT NULL/i);
    expect(sql).toContain("CHECK (provider_idempotency_key ~ '^[A-Za-z0-9_-]{10,120}$')");
    expect(sql).toMatch(/UNIQUE INDEX[\s\S]*\(tenant_id, provider, provider_idempotency_key\)/i);
  });

  it('keeps evidence-mismatched refunds live and blocked for reconciliation', () => {
    const sql = migration('697_payment_gateway_refunds.sql');
    expect(sql).toMatch(/status\s+VARCHAR\(30\)\s+NOT NULL/i);
    expect(sql).toMatch(/CHECK \(status IN \([^)]+requires_reconciliation[^)]+\)\)/i);
    expect(sql).toMatch(/ux_pg_refund_billing_refund_live[\s\S]*requires_reconciliation/i);
  });
});
