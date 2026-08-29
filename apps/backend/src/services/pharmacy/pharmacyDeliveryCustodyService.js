import { AppError } from '../../utils/AppError.js';

function canonicalArray(value) {
  return Array.isArray(value) ? value : [];
}

export function pharmacyDeliveryPackageEvidence(order) {
  const lines = canonicalArray(order?.items_list);
  const inventoryEvidence = lines.flatMap((line) => (
    canonicalArray(line?.inventory_allocation_evidence).map((allocation) => ({
      order_line_index: Number(line?.order_line_index),
      catalog_id: Number(line?.catalog_id),
      inventory_item_id: Number(line?.inventory_item_id),
      inventory_batch_id: Number(
        allocation?.inventory_batch_id ?? allocation?.batch_id,
      ),
      movement_id: Number(allocation?.movement_id),
      quantity: Number(allocation?.quantity),
    }))
  ));
  const complete = lines.length > 0
    && inventoryEvidence.length > 0
    && inventoryEvidence.every((entry) => (
      Number.isSafeInteger(entry.order_line_index)
      && entry.order_line_index >= 0
      && Number.isSafeInteger(entry.catalog_id)
      && entry.catalog_id > 0
      && Number.isSafeInteger(entry.inventory_item_id)
      && entry.inventory_item_id > 0
      && Number.isSafeInteger(entry.inventory_batch_id)
      && entry.inventory_batch_id > 0
      && Number.isSafeInteger(entry.movement_id)
      && entry.movement_id > 0
      && Number.isFinite(entry.quantity)
      && entry.quantity > 0
    ));
  if (!complete) {
    throw AppError.conflict(
      'The delivery package has no exact Inventory V2 custody evidence',
      'PHARMACY_DELIVERY_INVENTORY_CUSTODY_REQUIRED',
    );
  }

  const projection = order?.payment_metadata || {};
  if (order?.payment_status !== 'paid'
      || projection.contract !== 'pharmacy_delivery_funding_projection_v1'
      || !projection.dispatch_command_sha256) {
    throw AppError.conflict(
      'The delivery package has no exact posted funding custody evidence',
      'PHARMACY_DELIVERY_FUNDING_CUSTODY_REQUIRED',
    );
  }

  return {
    inventoryEvidence,
    fundingEvidence: {
      contract: 'pharmacy_funding_authority_v1',
      projection_contract: projection.contract,
      funding_source: projection.funding_source || null,
      funding_reference: projection.funding_reference || null,
      funding_tpa_claim_id: projection.funding_tpa_claim_id || null,
      funded_amount: Number(projection.funded_amount || 0),
      payment_ids: canonicalArray(projection.payment_ids),
      funding_authority: projection.funding_authority || null,
      dispatch_command_sha256: projection.dispatch_command_sha256,
    },
  };
}

export async function appendPharmacyDeliveryCustodyEventTx(tx, {
  tenantId,
  orderId,
  facilityId,
  eventType,
  actorUid,
  actorRole,
  commandKeySha256,
  requestSha256,
  orderAuthorityVersion,
  orderItemsSha256,
  handoffGeneration,
  handoffTokenSha256,
  notificationOutboxIds = [],
  inventoryEvidence,
  fundingEvidence,
  custodyEvidence,
  reason = null,
}) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_delivery_custody_events
       (tenant_id, pharmacy_order_id, facility_id, event_type,
        actor_uid, actor_role, command_key_sha256, request_sha256,
        order_authority_version, order_items_sha256, handoff_generation,
        handoff_token_sha256, notification_outbox_ids, inventory_evidence,
        funding_evidence, custody_evidence, reason)
     VALUES ($1::uuid, $2::int, $3::int, $4, $5::uuid, $6, $7, $8,
             $9::int, $10, $11::int, $12, $13::int[], $14::jsonb,
             $15::jsonb, $16::jsonb, $17)
     ON CONFLICT (tenant_id, command_key_sha256) DO NOTHING
     RETURNING *`,
    tenantId,
    Number(orderId),
    Number(facilityId),
    eventType,
    actorUid,
    actorRole,
    commandKeySha256,
    requestSha256,
    Number(orderAuthorityVersion),
    orderItemsSha256,
    Number(handoffGeneration),
    handoffTokenSha256,
    notificationOutboxIds.map(Number),
    JSON.stringify(inventoryEvidence),
    JSON.stringify(fundingEvidence),
    JSON.stringify(custodyEvidence),
    reason,
  );
  if (rows[0]) return { event: rows[0], idempotentReplay: false };

  const existing = await tx.$queryRawUnsafe(
    `SELECT *
       FROM pharmacy_delivery_custody_events
      WHERE tenant_id=$1::uuid AND command_key_sha256=$2
      FOR SHARE`,
    tenantId,
    commandKeySha256,
  );
  const event = existing[0];
  if (!event
      || Number(event.pharmacy_order_id) !== Number(orderId)
      || event.event_type !== eventType
      || event.request_sha256 !== requestSha256) {
    throw AppError.conflict(
      'The delivery custody command key was already used for different evidence',
      'PHARMACY_DELIVERY_CUSTODY_IDEMPOTENCY_CONFLICT',
    );
  }
  return { event, idempotentReplay: true };
}
