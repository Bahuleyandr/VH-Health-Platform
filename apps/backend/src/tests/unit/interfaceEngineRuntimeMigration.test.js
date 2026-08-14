import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'src/migrations/665_interface_engine_runtime_truthfulness.sql'),
  'utf8',
);

describe('interface-engine runtime migration', () => {
  test('adds durable retry and truthful replay accounting', () => {
    expect(migration).toContain('ADD COLUMN retry_at TIMESTAMPTZ(6)');
    expect(migration).toContain('last_delivery_outcome VARCHAR(40)');
    expect(migration).toContain('selected_count = queued_count + skipped_count');
    expect(migration).toContain('CREATE INDEX idx_interop_messages_due_outbound_v2');
  });

  test('guards activation and database delivery truthfulness', () => {
    expect(migration).toContain('assert_interop_runtime_activation');
    expect(migration).toContain('active http_outbound versions require an endpoint URL');
    expect(migration).toContain('http_outbound runtime supports auth_kind none only');
    expect(migration).toContain('http_inbound runtime requires tenant_interop_secret authentication');
    expect(migration).toContain('preview-only inbound versions cannot be activated');
    expect(migration).toContain('non-empty IP allowlist');
    expect(migration).toContain("channel_record.direction NOT IN ('outbound', 'bidirectional')");
    expect(migration).toContain('preview-only interface messages cannot be marked delivered');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF status ON public.interop_messages');
    expect(migration).toContain("SET status = 'transformed'");
    expect(migration).toContain("receipt.evidence ->> 'network_call_performed' = 'false'");
    expect(migration).toContain('inbound interface delivery requires an accepted same-message receipt');
    expect(migration).toContain('outbound interface delivery requires an accepted same-message receipt');
  });

  test('preserves owner-released authority while allowing a fenced claim', () => {
    expect(migration).toContain("send_authority = 'owner_authorized'");
    expect(migration).toContain('owner_release_client_event_id IS NOT NULL');
    expect(migration).toContain('chk_interop_messages_delivery_claim_shape_v2');
    expect(migration).toContain('I05 late acceptance requires the applied owner-release proof');
    expect(migration).toContain('cc_held_release_proof_matches');
  });
});
