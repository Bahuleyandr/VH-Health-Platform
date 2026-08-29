import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

const controller = read('controllers/pharmacy/pharmacyOrderController.js');
const tracking = read('controllers/delivery/deliveryTrackingController.js');
const routes = read('routes/pharmacy/orderRoutes.js');
const appSource = read('app.js');
const migration = read('migrations/753_pharmacy_order_inventory_authority.sql');

// Delivery custody is reachable only through EXACT, non-overlapping full-path
// mounts in app.js, each carrying its own mount-level requireRole. An
// overlapping `/api/v1/pharmacy-orders/orders` prefix mount would sit over the
// whole order lifecycle: it would fail the Phase-3 RBAC coverage gate without a
// role gate, and with fall-through it would run the broad pharmacy-orders
// mount's patientRateLimiter and phiAccessLogger a second time on every
// lifecycle request (phiAccessLogger does not dedupe its res.on('finish')).
const DELIVERY_MOUNT_SUFFIXES = [
  '/orders/assigned',
  '/orders/:id/delivered',
  '/orders/:id/delivery-handoff/reissue',
  '/orders/:id/delivery-return/request',
  '/orders/:id/delivery-return/complete',
];

describe('pharmacy delivery custody source contract', () => {
  it('issues the package with exact generation, notices, funding, and inventory proof', () => {
    const dispatch = controller.slice(
      controller.indexOf('export const dispatchOrder'),
      controller.indexOf('export const markDelivered'),
    );
    expect(dispatch).toContain('delivery_handoff_generation=$17::int');
    expect(dispatch).toContain('delivery_handoff_notice_outbox_ids=$18::int[]');
    expect(dispatch).toContain("eventType: 'PACKAGE_ISSUED'");
    expect(dispatch).toContain("contract: 'pharmacy_delivery_funding_projection_v1'");
    expect(dispatch).toContain('inventoryEvidence: packageEvidence.inventoryEvidence');
    expect(dispatch).toContain('patientNotice.id');
    expect(dispatch).toContain('courierNotice?.id');
  });

  it('keeps completion token-only and appends immutable patient-notified custody', () => {
    const delivered = controller.slice(
      controller.indexOf('export const markDelivered'),
      controller.indexOf('function deliveryCustodyReason'),
    );
    for (const forbidden of [
      "'dispensed_items'", "'payment_mode'", "'amount_collected'",
      "'tpa_reference'", "'cap_override'",
    ]) {
      expect(delivered).toContain(forbidden);
    }
    expect(delivered).toContain('delivery_handoff_token_sha256=$4');
    expect(delivered).toContain("eventType: 'DELIVERED'");
    expect(delivered).toContain('patientDeliveryNotice.id');
    expect(delivered).not.toContain('allocateOrderInventoryTx');
    expect(delivered).not.toContain('resolveAuthoritativeCounterFundingTx');
  });

  it('closes reissue, rotation, return-pending, returned, and quarantine authority', () => {
    expect(controller).toContain("eventType: rotated ? 'HANDOFF_ROTATED' : 'HANDOFF_REISSUED'");
    expect(controller).toContain("eventType: 'RETURN_REQUESTED'");
    expect(controller).toContain("eventType: disposition === 'quarantined' ? 'QUARANTINED' : 'RETURNED'");
    expect(controller).toContain("delivery_custody_status='return_pending'");
    expect(controller).toContain("package_stock_disposition: 'issued_not_restocked'");
    expect(routes).toContain('export const pharmacyDeliveryHandoffReissueRoutes');
    expect(routes).toContain('export const pharmacyDeliveryReturnRequestRoutes');
    expect(routes).toContain('export const pharmacyDeliveryReturnCompletionRoutes');
  });

  it('binds tracking to the exact active courier without rewriting destination', () => {
    const pharmacyTracking = tracking.slice(
      tracking.indexOf("if (orderType === 'pharmacy')"),
      tracking.indexOf("} else if (orderType === 'investigation')"),
    );
    expect(pharmacyTracking).toContain('pharmacy_delivery_location_updates');
    expect(pharmacyTracking).toContain('delivery_assignee_uid=$3::uuid');
    expect(pharmacyTracking).toContain("facility_grant.status='active'");
    expect(pharmacyTracking).not.toContain('SET delivery_lat=');
    expect(pharmacyTracking).not.toContain('delivery_lng=$');
    expect(routes).toContain('export const pharmacyAssignedDeliveryRoutes');
    expect(routes).toContain("PHARMACY_DELIVERY_ASSIGNED_ROLES = ['DELIVERY_STAFF']");
  });

  it('mounts every delivery surface at an exact path with its own role gate', () => {
    // The overlapping prefix mount must not come back: it fails the Phase-3
    // RBAC gate ungated, and gated or not its fall-through double-writes the
    // PHI trail and double-counts the shared patient rate limiter.
    expect(appSource).not.toContain("'/api/v1/pharmacy-orders/orders'");
    expect(appSource).not.toContain("'/api/v1/pharmacy/orders'");
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      for (const suffix of DELIVERY_MOUNT_SUFFIXES) {
        const mountPath = `'${prefix}${suffix}'`;
        expect(appSource).toContain(mountPath);
        const statement = appSource.slice(
          appSource.indexOf(mountPath),
          appSource.indexOf(');', appSource.indexOf(mountPath)),
        );
        expect(statement).toContain('requireRole(');
        expect(statement).toContain("phiAccessLogger('PHARMACY_ORDER')");
      }
    }
  });

  it('makes custody and courier location receipts append-only at the database boundary', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS pharmacy_delivery_custody_events');
    expect(migration).toContain('trg_pharmacy_delivery_custody_events_append_only_753');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS pharmacy_delivery_location_updates');
    expect(migration).toContain('trg_pharmacy_delivery_location_append_only_753');
    expect(migration).toContain("NEW.delivery_handoff_generation=OLD.delivery_handoff_generation+1");
    expect(migration).toContain("OLD.delivery_custody_status='return_pending'");
    expect(migration).toContain("NEW.delivery_custody_status IN ('returned','quarantined')");
    expect(migration).toContain('RETURN NEW;\nEND;\n$$;');
  });
});
