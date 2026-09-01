import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function source(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('accepted NHCX projection recovery source contract', () => {
  it('terminally receipts gateway 2xx before local projection and never redrives it', () => {
    const service = source('../../services/nhcx/nhcxOutboundDispatcherService.js');
    expect(service).toMatch(/transport_accepted_at = NOW\(\)[\s\S]*projection_status = 'pending'/);
    expect(service).toMatch(/status IN \('failed', 'dead', 'rejected'\)/);
    expect(service).toMatch(/transport_accepted_at IS NULL/);
    expect(service).toMatch(/await applyAcceptedGatewayProjection\(transportReceipt/);
  });

  it('never strands a cycle that owns no local claim or pre-auth row', () => {
    const service = source('../../services/nhcx/nhcxOutboundDispatcherService.js');
    // Only `claim` and `preauth` own a local workflow row. Eligibility,
    // claim-status (`task`), Communication and payment-notice accepts must
    // close out instead of raising into a reconciliation task no retry could
    // ever clear.
    expect(service).toMatch(/function hasLocalProjectionTarget\(row\)/);
    expect(service).toMatch(/if \(!hasLocalProjectionTarget\(lockedMessage\)\)/);
    expect(service).toMatch(
      /PROJECTION_NOT_APPLICABLE_CONTRACT = 'nhcx_gateway_projection_not_applicable_v1'/,
    );
    const apply = service.slice(
      service.indexOf('async function applyAcceptedGatewayProjection'),
      service.indexOf('async function markGatewayProjectionReconciliation'),
    );
    expect(apply).toMatch(/cycle_has_no_local_projection_target/);
    expect(apply).toMatch(/local_target_not_in_projectable_state/);
    // The retry endpoint must be able to clear whatever it is pointed at.
    const retry = service.slice(
      service.indexOf('export async function retryAcceptedNHCXProjection'),
      service.indexOf('export async function materializeAcceptedNHCXProjectionOrphans'),
    );
    expect(retry).toMatch(
      /hasLocalProjectionTarget\(message\)[\s\S]{0,40}\? await lockGatewayProjectionAuthorityTx/,
    );
    expect(retry).toMatch(/if \(authority && !projection\)/);
    // The orphan sweeper must not open a task for those cycles either.
    const orphans = service.slice(
      service.indexOf('export async function materializeAcceptedNHCXProjectionOrphans'),
      service.indexOf('export async function reapStaleNHCXDispatches'),
    );
    expect(orphans).toMatch(/if \(!hasLocalProjectionTarget\(row\)\)/);
    expect(orphans.indexOf('hasLocalProjectionTarget'))
      .toBeLessThan(orphans.indexOf('markGatewayProjectionReconciliation'));
  });

  it('claims the exact retry receipt before local mutation and completes its task atomically', () => {
    const service = source('../../services/nhcx/nhcxOutboundDispatcherService.js');
    const retry = service.slice(
      service.indexOf('export async function retryAcceptedNHCXProjection'),
      service.indexOf('export async function materializeAcceptedNHCXProjectionOrphans'),
    );
    expect(retry.indexOf('INSERT INTO nhcx_projection_commands')).toBeGreaterThan(-1);
    expect(retry.indexOf('INSERT INTO nhcx_projection_commands'))
      .toBeLessThan(retry.indexOf('projectGatewayAcceptanceTargetTx'));
    expect(retry.indexOf('SELECT * FROM nhcx_messages'))
      .toBeLessThan(retry.indexOf('lockGatewayProjectionAuthorityTx'));
    expect(retry).toMatch(/NHCX_PROJECTION_IDEMPOTENCY_MISMATCH/);
    expect(retry).toMatch(/transport_response_sha256/);
    expect(retry).not.toMatch(/fetchImpl|safeFetch|gatewayBaseUrl/);
    expect(service).toMatch(/UPDATE tasks[\s\S]*status='completed'/);
    expect(service).toMatch(/metadata->>'transport_response_sha256'/);
  });

  it('has exact task, command, orphan, route, OpenAPI, and Staff deep-link coverage', () => {
    const service = source('../../services/nhcx/nhcxOutboundDispatcherService.js');
    const migration = source('../../migrations/753_pharmacy_order_inventory_authority.sql');
    const routes = source('../../routes/insurance/claimsRoutes.js');
    const openapi = source('../../../scripts/openapi/schemas/nhcx.mjs');
    const staffRouter = source('../../../../staff/lib/core/navigation/app_router.dart');
    const staffDesk = source('../../../../staff/lib/features/reception/screens/billing_desk_screen.dart');

    expect(migration).toMatch(/CREATE TABLE nhcx_projection_commands/);
    expect(migration).toMatch(/enforce_nhcx_projection_task_binding_753/);
    expect(migration).toMatch(/NHCX projection command receipts cannot be deleted/);
    expect(migration).toMatch(/NEW\.cycle IS DISTINCT FROM OLD\.cycle/);
    expect(migration).toMatch(/task\.metadata->>'transport_response_sha256'=btrim\(NEW\.transport_response_sha256\)/);
    expect(migration).toMatch(/UPPER\(actor\.role\)=NEW\.actor_role/);
    expect(routes).toMatch(/router\.get\([\s\S]*\/nhcx\/projections\/:messageId/);
    expect(routes).toMatch(/\/nhcx\/projections\/:messageId\/retry/);
    expect(openapi).toMatch(/additionalProperties: false/);
    expect(openapi).toMatch(/expected_transport_response_sha256/);
    expect(staffRouter).toMatch(/nhcx_projection_message_id/);
    expect(staffDesk).toMatch(/retryAcceptedNhcxProjection/);
    expect(staffDesk).toMatch(/med03\.nhcx\.projection\.help/);
    const scheduler = source('../../utils/scheduler.js');
    expect(scheduler).toMatch(/reapStaleNHCXDispatches/);
    expect(service).toMatch(/reapStaleNHCXDispatches[\s\S]*materializeAcceptedNHCXProjectionOrphans/);
  });
});
