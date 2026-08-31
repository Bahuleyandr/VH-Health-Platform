// Deep integration tests for the rich pharmacy lifecycle (pharmacyOrderController)
// as it stands AFTER migration 753 (facility custody + inventory authority).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE LOOKS DIFFERENT FROM ITS PREVIOUS SHAPE
//
// The old suite drove PENDING → CONFIRMED → PREPARING → DISPATCHED → DELIVERED
// end-to-end on an ADMIN token, with orders seeded straight into the default
// tenant and no facility at all. Every one of those preconditions is gone:
//
//  1. FACILITY CUSTODY. Every :id lifecycle handler now opens with
//     resolveOrderPharmacyFacility() → assertPharmacyFacilityGrant(), which
//     demands the order carry a facility_id, the facility be active, the actor
//     exist as an active users row in a FACILITY_OPERATION_ROLES role WITH a
//     matching staff row, and an ACTIVE pharmacy_staff_facility_grants row for
//     that exact facility (assertPharmacyFacilityGrant opens at
//     pharmacyFacilityAuthorityService.js:249). There is no admin bypass any
//     more (`admin_bypass: false`). A seeded order also has to
//     satisfy chk_pharmacy_orders_facility_progression_753 (migration 753:1675 —
//     facility_id IS NOT NULL OR status IN CANCELLED/DELIVERED/DISPENSED/
//     UNAVAILABLE), so a PENDING fixture MUST name a real facility.
//     Batches likewise must satisfy trg_pharmacy_batch_storage_authority_supply_753
//     (753:5874): in_stock/reserved/quarantined stock needs an ACTIVE
//     facility_locations storage row in its own facility.
//     → the suite now owns a tenant, a default facility, a storage location,
//       staff rows and grants, mirroring pharmacy-inventory-ledger-hardening.
//
//  2. IDEMPOTENCY. Every lifecycle POST is wrapped in
//     orderDispenseIdempotency(action) with `required: true`
//     (routes/pharmacy/orderRoutes.js) — confirm/verify/preparing/dispatch/
//     unavailable/cancel all 400 without an Idempotency-Key header. The old
//     suite sent one only on /delivered.
//
//  3. CONFIRM IS CATALOG-AUTHORITATIVE. confirmOrder no longer stores whatever
//     items_list the caller posted. resolveManualConfirmationLinesTx
//     (pharmacyOrderController.js:1108) requires every line to carry a stable
//     order_line_index matching its position, a catalog_id that resolves to
//     EXACTLY ONE active inventory item in the order's facility, and a positive
//     quantity; pricing and the total come from pharmacy_catalog.unit_price, and
//     a submitted total that disagrees is refused.
//
//  4. TRANSITION FAILURES ARE 409, NOT 400. "Can only confirm PENDING orders",
//     "Order must be CONFIRMED before preparation" and "Cannot cancel a closed
//     order" are all AppError.conflict now.
//
//  5. DISPATCH AND DELIVERY MOVED OUT OF REACH OF THIS SUITE.
//     • dispatchOrder refuses caller-supplied delivery_person /
//       delivery_person_phone (identity is resolved from delivery_assignee_uid,
//       which must name an active DELIVERY_STAFF courier holding a grant for the
//       facility), sets delivery_tracking_active=FALSE, and — after staging —
//       requires materializePharmacyFundingAuthority() to return 'funded', i.e.
//       a posted billingV2 pharmacy invoice + payment allocations covering the
//       exact order version and items hash. It is also where inventory is now
//       allocated (allocateOrderInventoryTx), which is why the old
//       "markDelivered decrements the batch" assertions no longer describe
//       delivery at all.
//     • POST /orders/:id/delivered is no longer a router route. It is an EXACT
//       app.js mount (app.js:1204) gated by
//       requireRole(...PHARMACY_DELIVERY_CUSTODY_ROLES) and then
//       requireExactDeliveryCustody, and markDelivered consumes a one-time
//       patient handoff token that only ever exists inside the dispatch
//       notification outbox row.
//     Reproducing a successful dispatch/delivery from here would mean building
//     a billingV2 funding fixture and a courier custody fixture — coverage that
//     now lives with those owners (unit/pharmacyDeliveryCustodySourceContract
//     .test.js pins the custody contract). What this suite keeps is the exact
//     gate each of those surfaces now presents, asserted end-to-end over HTTP.
//
//  6. VERIFICATION. markPreparing/dispatchOrder call assertVerificationClearedTx
//     first, so an unverified order is refused with 409. A SUCCESSFUL
//     verification depends on the drug-KB revision and the safety engine
//     (validatePrescriptionSafety with requireActiveTherapyAuthority), which are
//     fixtures this suite does not own and which bcma-closed-loop.deep.test.js
//     already covers — so the verified branch is asserted there, and the GATE is
//     asserted here.
//
//  7. CASES THAT LEFT THIS FILE, AND WHERE THEY WENT.
//
//     ★ HOW TO CHECK THIS LEDGER, because two review rounds caught it
//     over-claiming. The pre-753 file held NINETEEN `it(` cases. THIRTEEN are
//     still here, EIGHT of them under a new title (the other five kept their
//     exact old title). SIX left the file, and each of those six has a bullet
//     below. (There are eight bullets, not six: two of them describe cases
//     that are still present — one narrowed into a pair, one kept unchanged.)
//     Every bullet for a case that left
//     ends in a COVERAGE STATUS line that says either where the behaviour is
//     asserted now, with a file:line, or that it is UNCOVERED and who owns it.
//     Re-derive all of that, do not trust it:
//         git show <pre-753-sha>:apps/backend/src/tests/pharmacy-lifecycle-deep.test.js \
//           | grep -n "  it("
//     and match each title against this list. "Covered" is never asserted here
//     without a file:line; where there is no file:line, the word is UNCOVERED.
//
//     ▲ Three of the six that left are the lifecycle's happy-path advances
//     (preparing / dispatch / delivered). They are NOT re-homed in full —
//     read their COVERAGE STATUS lines before treating this suite, or this
//     ledger, as evidence that the pharmacy lifecycle is covered end to end.
//
//     • describe('multi-item inventory lock order') >
//       it('completes concurrent reversed A/B and B/A deliveries without
//       deadlock') — DELETED, NOT REPLACED. It cannot be rebuilt in its old
//       form: it seeded two DISPATCHED orders with facility_id NULL (now
//       rejected by chk_pharmacy_orders_facility_progression_753, since
//       DISPATCHED is not in the constraint's exempt status list) and drove
//       POST /delivered on an ADMIN token (now 403 at the custody mount, as
//       asserted below). Rebuilding it after 753 means a funded dispatch plus
//       courier custody for BOTH orders — the same two fixtures item 5 puts
//       out of this suite's reach — because allocation moved to dispatch.
//       ▶ COVERAGE STATUS: the runtime deadlock-freedom property is now
//       UNCOVERED anywhere in the corpus. What survives is a SOURCE-TEXT pin,
//       unit/pharmacyInventoryAuthorityContract.test.js:151-156, which greps
//       pharmacyOrderInventoryService.js for `ORDER BY id ... FOR UPDATE` on
//       pharmacy_catalog / pharmacy_inventory_items / pharmacy_inventory_batches
//       plus the lineContexts .sort(). That proves the ordering is WRITTEN
//       (the single batch lock is pharmacyOrderInventoryService.js:969-992);
//       it cannot prove two concurrent reversed-line transactions do not
//       deadlock at runtime. Reported to the pharmacyOrderInventoryService.js
//       owner to re-home against a funded-dispatch fixture.
//     • it('markPreparing refuses to run from a non-CONFIRMED state') —
//       DELETED, NOT REPLACED. PHARMACY_ORDER_PREPARING_WRONG_STATUS
//       (pharmacyOrderController.js:1498-1501) is now UNREACHABLE from a
//       fixture this suite can build: assertVerificationClearedTx runs at
//       :1462, ahead of the status-guarded UPDATE at :1472, so any order this
//       suite can seed answers the verification 409 first and the transition
//       conflict never fires. Reaching it needs the cleared-verification
//       fixture item 6 assigns to bcma-closed-loop.deep.test.js.
//     • it('markPreparing advances CONFIRMED → PREPARING and stamps
//       preparing_at') — SPLIT, and only PARTLY re-homed.
//       ▶ The refusal half is HERE: 'blocks CONFIRMED → PREPARING until
//         pharmacist verification clears' (below) asserts the 409, the exact
//         code, and that the order is still CONFIRMED with preparing_at NULL.
//       ▶ The 200 advance is re-homed to bcma-closed-loop.deep.test.js:857-879
//         ('clean order verifies; preparing then proceeds …'), which owns the
//         cleared-verification fixture item 6 assigns and asserts
//         `preparing.status === 200`.
//       ▶ COVERAGE STATUS: the DB-side half is UNCOVERED anywhere in the
//         corpus. Nothing asserts pharmacy_orders.status='PREPARING' or a
//         non-null preparing_at after a cleared /preparing — the bcma case
//         stops at the HTTP status code, and a corpus-wide grep finds
//         preparing_at read by no other suite. Owner: the
//         bcma-closed-loop.deep.test.js owner, the only fixture that reaches
//         200; the assertion is two lines on a case that already exists.
//     • it('dispatchOrder advances PREPARING → DISPATCHED with delivery
//       contact + SLA') — SPLIT; the refusals are here, the advance is not.
//       ▶ Three refusals are HERE, in 'dispatch — courier custody staging':
//         the caller-identity refusal, the missing-assignee refusal, and the
//         verification gate — the last also pinning delivery_assignee_uid and
//         delivery_custody_status NULL with delivery_tracking_active FALSE.
//       ▶ Two of the old assertions are DEAD CONTRACT, not missing coverage.
//         delivery_person / delivery_person_phone came from the request body,
//         which dispatchOrder now refuses outright (item 5), and
//         delivery_tracking_active=TRUE inverted — dispatch now sets it FALSE.
//         Both are pinned in their new form by the refusal cases below.
//       ▶ COVERAGE STATUS: the 200 advance and the dispatched_at /
//         sla_delivery_target stamps are UNCOVERED anywhere in the corpus. No
//         suite drives POST /dispatch to 200:
//         unit/pharmacyOrderLifecycleAtomicity.test.js:728-746 calls
//         dispatchOrder against a fully mocked tx and asserts only that
//         assertVerificationClearedTx runs before the first write — never a
//         column value — and pharmacy-dispense-substitution.deep.test.js:397
//         reaches DISPATCHED by raw UPDATE, never through the handler.
//         Reaching 200 needs the billingV2 funding fixture plus courier grant
//         item 5 puts out of this suite's reach. Owner: the
//         pharmacyOrderController.js dispatchOrder owner, against a
//         funded-dispatch fixture.
//     • it('markDelivered advances DISPATCHED → DELIVERED and clears
//       tracking') — DELETED here, PARTLY re-homed.
//       ▶ What is HERE is the gate the mount now presents: an ADMIN token is
//         403 at both the /pharmacy-orders and /pharmacy mounts, and a
//         DELIVERY_STAFF courier that clears requireRole but holds no custody
//         is 404 PHARMACY_DELIVERY_CUSTODY_NOT_FOUND.
//       ▶ unit/pharmacyOrderLifecycleAtomicity.test.js:397-419 covers
//         markDelivered's committed-success payload (status DELIVERED plus the
//         barcode recovery obligation) against a mocked transaction.
//       ▶ COVERAGE STATUS: the end-to-end advance is UNCOVERED. Nothing
//         asserts delivered_at, or delivery_tracking_active FALSE after
//         delivery, over HTTP. The old case's batch-decrement assertions are
//         DEAD CONTRACT — allocation moved to dispatch (item 5) — and their
//         replacement, 'leaves facility inventory untouched', is below.
//         Reaching 200 needs a funded dispatch, courier custody, AND the
//         one-time patient handoff token that exists only inside the dispatch
//         notification outbox row. Owner: the pharmacyOrderController.js
//         markDelivered owner.
//     • it('cancelOrder blocks cancellation after DELIVERED') — DELETED; the
//       BEHAVIOUR it pinned is covered. DELIVERED is unreachable here (item 5),
//       but PHARMACY_ORDER_CANCEL_CLOSED is the single closed-order branch and
//       it is asserted below from the CANCELLED terminal state instead.
//     • it('records the pharmacy lifecycle in the canonical clinical audit
//       stream') — NARROWED, not dropped: it is now 'records the confirmed
//       transition …' plus 'records the cancelled transition …'. The
//       preparing/dispatched/delivered actions it also asserted go with the
//       handlers named in items 5 and 6.
//     • it('returns 404 for an unknown order id') — KEPT, unchanged, in the
//       cancelOrder branch below and still pinned at 404. It was red for most
//       of this round: every :id lifecycle handler consults facility custody
//       before its own not-found branch, and resolveOrderPharmacyFacility used
//       to report an id naming no row as 409
//       PHARMACY_ORDER_FACILITY_UNRESOLVED. The pin was deliberately held at
//       404 rather than re-pinned at the defect, and the defect is now FIXED
//       at the root: resolveOrderPharmacyFacility probes order existence on
//       its MISS path only (pharmacyFacilityAuthorityService.js:444-454) and
//       raises AppError.notFound('Order not found') for an absent row, while a
//       real order whose custody is genuinely unresolved falls through that
//       probe to the identical 409 at :455-459. The case is expected GREEN;
//       do not re-derive the old red from a stale copy of this ledger.
//     Every other case in the old file is still here. Two were renamed
//     because the old TITLE over-promised what the old BODY asserted, and
//     both are now STRICTLY STRONGER, not narrowed:
//       • 'returns the orders ordered by status rank then creation time' →
//         'returns this facility's orders with the computed queue fields'.
//         The old body asserted no ordering at all — only `ours.length >= 2`
//         and a typeof check per field. The new body pins an exact length of
//         2, the exact facility_id, the exact status set, and
//         facility_recovery_required.
//       • 'SLA dashboard returns aggregate counts + revenue + avg-times
//         blocks' → '… + avg-times blocks for the facility'. The old body
//         never asserted revenue, and its counts were `>=`; the new body
//         pins summary.total/confirmed/cancelled/delivered exactly.
//     The remaining renames track a contract that genuinely changed shape
//     (400 → 409 transition failures, catalog-authoritative confirm).
// ─────────────────────────────────────────────────────────────────────────────

import { generateTestToken } from './testClient.js';
import prisma, { setTenantTx } from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

// Suite-owned tenant: resolvePharmacyFacility() requires EXACTLY ONE active
// is_default facility per tenant (uq_facility_default is a partial UNIQUE on
// tenant_id), so the queue/SLA surfaces cannot share the platform default
// tenant with other suites.
const TENANT = '00000000-0000-4000-8000-0000c1fe0301';
const PATIENT_UID = 'c1fe0301-0000-4000-8000-000000000001';
const INCHARGE_UID = 'c1fe0301-0000-4000-8000-000000000002';
const COURIER_UID = 'c1fe0301-0000-4000-8000-000000000003';
const ADMIN_UID = 'c1fe0301-0000-4000-8000-000000000004';
const PATIENT_PHONE = '+919000060001';

function clientFor(role, uid, id) {
  const token = generateTestToken(role, { uid, id, tenant_id: TENANT });
  const auth = (req) => req.set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
  return {
    get: (p) => auth(request(app).get(p)),
    post: (p) => auth(request(app).post(p)),
  };
}

describe('Rich pharmacy lifecycle — deep integration', () => {
  let patientIntId;
  let inchargeIntId;
  let courierIntId;
  let adminIntId;
  let facilityId;
  let storageLocationId;
  let paracetamolCatalogId;
  let coughCatalogId;
  let paracetamolItemId;
  let coughItemId;
  let paracetamolBatchId;
  let coughBatchId;

  // The pharmacy in-charge drives every lifecycle transition: PHARMACY_INCHARGE
  // is in FACILITY_OPERATION_ROLES (so it can hold a grant), in the
  // pharmacyLifecycleRoutes RBAC group, and in PHARMACY_DELIVERY_CUSTODY_ROLES.
  let incharge;
  // The courier exists ONLY to reach the far side of the delivery-custody
  // mount: DELIVERY_STAFF clears requireRole, and because COURIER_UID is
  // deliberately granted NOTHING (no pharmacy_staff_facility_grants row), the
  // custody predicate that follows is guaranteed to miss.
  let courier;
  let admin;

  // The sweep runs against a shared database, so its cost tracks whatever
  // earlier suites left behind, not this fixture's own row count. Prisma's
  // default interactive-transaction budget is 5s and the sweep has already
  // blown it on a warm DB, which failed beforeAll and took all 28 cases with
  // it. The budget is stated explicitly here (and on the two hooks below) so
  // the result never depends on the runner's defaults.
  async function cleanup() {
    await setTenantTx(TENANT, async (tx) => {
      // Three of this fixture's tables are append-only under migration 753 and
      // its predecessors — trg_pharmacy_order_command_receipts_append_only_753,
      // trg_pharmacy_staff_facility_grant_events_append_only_753 and
      // pharmacy_stock_movements_medication_evidence_append_only — so a plain
      // DELETE raises 23514 'pharmacy order command receipts are append-only'
      // the moment a previous run has left a receipt behind. afterAll swallows
      // its cleanup failure, so the damage only surfaced in the NEXT run's
      // beforeAll, which does not.
      //
      // The fixture drops its own rows under session_replication_role='replica'
      // exactly the way pharmacy-dispensable-context.deep.test.js and
      // ipd-support-money-authz.deep.test.js do. It is SET LOCAL, so it lasts
      // only for this transaction and only for this superuser test session —
      // the append-only guards stay live everywhere else, including for the
      // product code this suite drives over HTTP.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_order_command_receipts WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grant_events WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_order_history
          WHERE order_id IN (SELECT id FROM pharmacy_orders WHERE tenant_id=$1::uuid)`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_orders WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_patient_safety_versions WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM idempotency_keys WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_catalog WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grants WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM facility_locations WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM staff WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM facilities WHERE tenant_id=$1::uuid`, TENANT);
    }, { maxWait: 30_000, timeout: 120_000 });
  }

  // Every fixture read/write runs inside setTenantTx: facilities,
  // facility_locations, pharmacy_inventory_items and pharmacy_inventory_batches
  // all carry tenant RLS policies (migration 304), and pharmacy_orders /
  // pharmacy_order_history default tenant_id from app.current_tenant_id.
  async function readOrder(orderId, columns) {
    return setTenantTx(TENANT, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT ${columns} FROM pharmacy_orders WHERE tenant_id=$1::uuid AND id=$2::int`,
        TENANT,
        Number(orderId),
      );
      return rows[0];
    });
  }

  async function seedPendingOrder(note) {
    return setTenantTx(TENANT, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_orders (
           tenant_id, facility_id, authority_origin, phone, patient_id, patient_name,
           patient_phone, order_note, delivery_type, delivery_address, delivery_lat,
           delivery_lng, delivery_phone, status, prescribed_by, ordered_at, updated_at,
           sla_confirm_target
         ) VALUES (
           $1::uuid, $2::int, 'patient_manual', $3, $4::int, 'MED03 Lifecycle Patient',
           $3, $5, 'delivery', '42 Test Lane, Kottarakkara', 9.003,
           76.781, $3, 'PENDING', $6::uuid, NOW(), NOW(),
           NOW() + INTERVAL '30 minutes')
         RETURNING id, order_number`,
        TENANT,
        facilityId,
        PATIENT_PHONE,
        patientIntId,
        note,
        PATIENT_UID,
      );
      // The PENDING history row placeOrder would have written.
      await tx.$executeRawUnsafe(
        `INSERT INTO pharmacy_order_history
           (tenant_id, order_id, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2::int, 'PENDING', $3::int, 'patient', 'Order placed')`,
        TENANT,
        Number(rows[0].id),
        patientIntId,
      );
      return { id: Number(rows[0].id), orderNumber: rows[0].order_number };
    });
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, 'med03-pharmacy-lifecycle', 'MED03 Pharmacy Lifecycle',
               'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    await cleanup();

    await setTenantTx(TENANT, async (tx) => {
      const facilityRows = await tx.$queryRawUnsafe(
        `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
         VALUES ($1::uuid, 'MED03-LIFECYCLE-PHARMACY', 'MED03 Lifecycle Pharmacy',
                 'active', TRUE)
         RETURNING id`,
        TENANT,
      );
      facilityId = Number(facilityRows[0].id);

      const locationRows = await tx.$queryRawUnsafe(
        `INSERT INTO facility_locations
           (tenant_id, facility_id, location_code, display_name, status)
         VALUES ($1::uuid, $2::int, 'MED03-LIFECYCLE-STORE', 'MED03 Lifecycle Store',
                 'active')
         RETURNING id`,
        TENANT,
        facilityId,
      );
      storageLocationId = Number(locationRows[0].id);

      const users = await tx.$queryRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES
           ($1::uuid, $5::uuid, $6, 'MED03 Lifecycle Patient', 'PATIENT', TRUE, 'active', NOW()),
           ($2::uuid, $5::uuid, '9000060002', 'MED03 Lifecycle Incharge',
            'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
           ($3::uuid, $5::uuid, '9000060003', 'MED03 Lifecycle Courier',
            'DELIVERY_STAFF', TRUE, 'active', NOW()),
           ($4::uuid, $5::uuid, '9000060004', 'MED03 Lifecycle Admin',
            'ADMIN', TRUE, 'active', NOW())
         RETURNING id, uid`,
        PATIENT_UID,
        INCHARGE_UID,
        COURIER_UID,
        ADMIN_UID,
        TENANT,
        PATIENT_PHONE,
      );
      const idByUid = new Map(users.map((row) => [String(row.uid), Number(row.id)]));
      patientIntId = idByUid.get(PATIENT_UID);
      inchargeIntId = idByUid.get(INCHARGE_UID);
      courierIntId = idByUid.get(COURIER_UID);
      adminIntId = idByUid.get(ADMIN_UID);

      // assertPharmacyFacilityGrant only accepts an actor that ALSO has an
      // active, unarchived staff row (`actor.staff_id != null`).
      await tx.$executeRawUnsafe(
        `INSERT INTO staff
           (tenant_id, user_id, employee_id, name, designation, skills,
            certifications, is_active, archived, created_at, updated_at)
         VALUES
           ($1::uuid, $2::uuid, 'MED03-LC-INCHARGE', 'MED03 Lifecycle Incharge',
            'Pharmacist', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW()),
           ($1::uuid, $3::uuid, 'MED03-LC-COURIER', 'MED03 Lifecycle Courier',
            'Delivery Staff', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())`,
        TENANT,
        INCHARGE_UID,
        COURIER_UID,
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO pharmacy_staff_facility_grants
           (tenant_id, facility_id, staff_uid, status, grant_source,
            grant_reason, granted_by)
         VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'test_fixture',
                 'MED03 pharmacy lifecycle authority fixture', $3::uuid)`,
        TENANT,
        facilityId,
        INCHARGE_UID,
      );

      const catalogs = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_catalog
           (tenant_id, name, generic_name, category, unit_price, stock_quantity,
            is_active, in_stock, updated_at)
         VALUES
           ($1::uuid, 'LIFECYCLE TEST Paracetamol 500mg', 'Paracetamol', 'analgesic',
            2.5, 777, TRUE, TRUE, NOW()),
           ($1::uuid, 'LIFECYCLE TEST Benadryl cough syrup', 'Diphenhydramine', 'other',
            120, 888, TRUE, TRUE, NOW())
         RETURNING id, name`,
        TENANT,
      );
      paracetamolCatalogId = Number(
        catalogs.find((row) => row.name.includes('Paracetamol')).id,
      );
      coughCatalogId = Number(catalogs.find((row) => row.name.includes('Benadryl')).id);

      // chk_pharmacy_inventory_items_active_authority_753: an ACTIVE item needs
      // both a facility and a catalog identity. resolveManualConfirmationLinesTx
      // then matches catalog_id → exactly one active item in THIS facility.
      const inventoryItems = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_items
           (tenant_id, facility_id, catalog_id, sku_code, display_name,
            unit_label, status)
         VALUES
           ($1::uuid, $2::int, $3::int, 'LIFECYCLE-PARA', 'Paracetamol 500mg',
            'tab', 'active'),
           ($1::uuid, $2::int, $4::int, 'LIFECYCLE-COUGH', 'Benadryl cough syrup',
            'bottle', 'active')
         RETURNING id, sku_code`,
        TENANT,
        facilityId,
        paracetamolCatalogId,
        coughCatalogId,
      );
      paracetamolItemId = Number(
        inventoryItems.find((row) => row.sku_code === 'LIFECYCLE-PARA').id,
      );
      coughItemId = Number(
        inventoryItems.find((row) => row.sku_code === 'LIFECYCLE-COUGH').id,
      );

      // trg_pharmacy_batch_storage_authority_supply_753: in_stock batches need an
      // ACTIVE facility_locations row in their own facility.
      const batches = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_batches
           (tenant_id, inventory_item_id, facility_id, storage_location_id,
            batch_number, expiry_date, received_quantity, remaining_quantity, status)
         VALUES
           ($1::uuid, $2::int, $4::int, $5::int, 'LIFECYCLE-PARA-B1',
            (NOW()+INTERVAL '1 year')::date, 100, 100, 'in_stock'),
           ($1::uuid, $3::int, $4::int, $5::int, 'LIFECYCLE-COUGH-B1',
            (NOW()+INTERVAL '1 year')::date, 10, 10, 'in_stock')
         RETURNING id, inventory_item_id`,
        TENANT,
        paracetamolItemId,
        coughItemId,
        facilityId,
        storageLocationId,
      );
      paracetamolBatchId = Number(
        batches.find((row) => Number(row.inventory_item_id) === paracetamolItemId).id,
      );
      coughBatchId = Number(
        batches.find((row) => Number(row.inventory_item_id) === coughItemId).id,
      );
    });

    incharge = clientFor('PHARMACY_INCHARGE', INCHARGE_UID, inchargeIntId);
    courier = clientFor('DELIVERY_STAFF', COURIER_UID, courierIntId);
    admin = clientFor('ADMIN', ADMIN_UID, adminIntId);
  });

  afterAll(async () => {
    await cleanup().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  describe('placeOrder (no file upload)', () => {
    it('rejects placement with neither file nor order_note', async () => {
      const res = await admin.post('/api/v1/pharmacy-orders/orders/place').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects unsupported prescription attachment as a client error', async () => {
      const res = await admin.post('/api/v1/pharmacy-orders/orders/place')
        .field('order_note', 'Attach wrong file type')
        .attach('prescription', Buffer.from('not a prescription image'), {
          filename: 'prescription.txt',
          contentType: 'text/plain',
        });

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(expect.objectContaining({
        success: false,
        code: 'INVALID_PRESCRIPTION_ATTACHMENT',
      }));
      expect(res.body.message).toMatch(/Only images and PDFs are allowed/i);
    });
  });

  // The order is seeded directly (placeOrder is a multipart patient-app surface;
  // the drift this suite exists to catch is in the transition handlers).
  describe('confirmOrder — catalog-authoritative PENDING → CONFIRMED', () => {
    let orderId;
    let orderNumber;

    const authoritativeItems = () => ([
      {
        order_line_index: 0,
        catalog_id: paracetamolCatalogId,
        inventory_item_id: paracetamolItemId,
        quantity: 20,
      },
      {
        order_line_index: 1,
        catalog_id: coughCatalogId,
        inventory_item_id: coughItemId,
        quantity: 1,
      },
    ]);

    beforeAll(async () => {
      const seeded = await seedPendingOrder('Deliver paracetamol + cough syrup');
      orderId = seeded.id;
      orderNumber = seeded.orderNumber;
    });

    it('refuses a confirm with no Idempotency-Key', async () => {
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`)
        .send({ items_list: authoritativeItems(), total_amount: 170 });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Idempotency-Key header is required/i);

      const row = await readOrder(orderId, 'status');
      expect(row.status).toBe('PENDING');
    });

    it('rejects items_list that is not an array', async () => {
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`)
        .set('Idempotency-Key', `med03-confirm-nonarray-${orderId}`)
        .send({ items_list: 'not-an-array' });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('items_list must be an array');
    });

    it('rejects a line without a stable order_line_index', async () => {
      const [first, second] = authoritativeItems();
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`)
        .set('Idempotency-Key', `med03-confirm-noindex-${orderId}`)
        .send({
          items_list: [{ ...first, order_line_index: undefined }, second],
          total_amount: 170,
        });
      expect(res.statusCode).toBe(422);
      expect(res.body.code).toBe('PHARMACY_ORDER_CATALOG_RESOLUTION_REQUIRED');

      const row = await readOrder(orderId, 'status');
      expect(row.status).toBe('PENDING');
    });

    it('rejects a total that disagrees with authoritative catalog pricing', async () => {
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`)
        .set('Idempotency-Key', `med03-confirm-badtotal-${orderId}`)
        .send({ items_list: authoritativeItems(), total_amount: 1 });
      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('PHARMACY_ORDER_TOTAL_MISMATCH');
      expect(res.body.details).toEqual(expect.objectContaining({
        submitted_total_amount: 1,
        authoritative_total_amount: 170,
      }));

      const row = await readOrder(orderId, 'status');
      expect(row.status).toBe('PENDING');
    });

    it('advances PENDING → CONFIRMED, projecting catalog price onto every line', async () => {
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`)
        .set('Idempotency-Key', `med03-confirm-${orderId}`)
        .send({
          confirmation_notes: 'All items in stock',
          items_list: authoritativeItems(),
          total_amount: 170,
        });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('CONFIRMED');
      expect(Number(res.body.data.total_amount)).toBe(170);

      const row = await readOrder(
        orderId,
        `status, items_list, confirmation_notes, confirmed_at,
         clinical_verification_status, inventory_authority_version,
         sla_dispatch_target > NOW() AS sla_future`,
      );
      expect(row.status).toBe('CONFIRMED');
      expect(row.confirmation_notes).toBe('All items in stock');
      expect(row.confirmed_at).toBeTruthy();
      expect(row.sla_future).toBe(true);
      // Confirm re-opens the clinical gate and bumps the authority version the
      // verification/dispatch tuples are pinned to.
      expect(row.clinical_verification_status).toBe('pending');
      expect(Number(row.inventory_authority_version)).toBe(2);

      expect(Array.isArray(row.items_list)).toBe(true);
      expect(row.items_list).toHaveLength(2);
      expect(row.items_list[0]).toEqual(expect.objectContaining({
        order_line_index: 0,
        catalog_id: paracetamolCatalogId,
        inventory_item_id: paracetamolItemId,
        name: 'LIFECYCLE TEST Paracetamol 500mg',
        quantity: 20,
        ordered_qty: 20,
        price: 2.5,
        line_total: 50,
      }));
      expect(row.items_list[1]).toEqual(expect.objectContaining({
        order_line_index: 1,
        catalog_id: coughCatalogId,
        inventory_item_id: coughItemId,
        name: 'LIFECYCLE TEST Benadryl cough syrup',
        quantity: 1,
        ordered_qty: 1,
        price: 120,
        line_total: 120,
      }));
    });

    it('blocks a second confirm once the order is no longer PENDING', async () => {
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`)
        .set('Idempotency-Key', `med03-confirm-again-${orderId}`)
        .send({ items_list: authoritativeItems(), total_amount: 170 });
      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('PHARMACY_ORDER_CONFIRM_WRONG_STATUS');
    });

    describe('clinical verification gate', () => {
      it('refuses preparing with no Idempotency-Key', async () => {
        const res = await incharge
          .post(`/api/v1/pharmacy-orders/orders/${orderId}/preparing`)
          .send({});
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Idempotency-Key header is required/i);
      });

      it('blocks CONFIRMED → PREPARING until pharmacist verification clears', async () => {
        const res = await incharge
          .post(`/api/v1/pharmacy-orders/orders/${orderId}/preparing`)
          .set('Idempotency-Key', `med03-preparing-${orderId}`)
          .send({});
        expect(res.statusCode).toBe(409);
        // assertClearedStatus (pharmacistVerificationService.js:315-327) is the
        // FIRST conflict markPreparing can raise after the facility grant, and
        // relayAppError puts AppError.code at the envelope root. Pinning the
        // code stops an unrelated 409 on the same path from passing as this gate.
        expect(res.body.code).toBe('PHARMACY_VERIFICATION_REQUIRED');

        const row = await readOrder(orderId, 'status, preparing_at');
        expect(row.status).toBe('CONFIRMED');
        expect(row.preparing_at).toBeNull();
      });
    });

    describe('dispatch — courier custody staging', () => {
      it('refuses a caller-supplied delivery identity', async () => {
        const res = await incharge
          .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispatch`)
          .set('Idempotency-Key', `med03-dispatch-identity-${orderId}`)
          .send({
            delivery_person: 'Ramesh Kumar',
            delivery_person_phone: '+919000060099',
          });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('PHARMACY_DELIVERY_CALLER_IDENTITY_FORBIDDEN');

        const row = await readOrder(orderId, 'status, delivery_person, delivery_person_phone');
        expect(row.status).toBe('CONFIRMED');
        expect(row.delivery_person).toBeNull();
        expect(row.delivery_person_phone).toBeNull();
      });

      it('requires the assigned courier uid', async () => {
        const res = await incharge
          .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispatch`)
          .set('Idempotency-Key', `med03-dispatch-noassignee-${orderId}`)
          .send({});
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('PHARMACY_DELIVERY_ASSIGNEE_REQUIRED');
      });

      it('blocks dispatch until pharmacist verification clears', async () => {
        const res = await incharge
          .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispatch`)
          .set('Idempotency-Key', `med03-dispatch-${orderId}`)
          .send({ delivery_assignee_uid: COURIER_UID });
        expect(res.statusCode).toBe(409);
        // dispatchOrder reaches assertVerificationClearedTx
        // (pharmacyOrderController.js:1652) before it reads the order row, so
        // this is the verification gate and not a status/funding conflict.
        expect(res.body.code).toBe('PHARMACY_VERIFICATION_REQUIRED');

        const row = await readOrder(
          orderId,
          'status, delivery_assignee_uid, delivery_custody_status, delivery_tracking_active',
        );
        expect(row.status).toBe('CONFIRMED');
        expect(row.delivery_assignee_uid).toBeNull();
        expect(row.delivery_custody_status).toBeNull();
        expect(row.delivery_tracking_active).toBe(false);
      });
    });

    describe('delivery completion is behind its own exact mount', () => {
      it('refuses a pharmacy-lifecycle ADMIN token at the custody mount', async () => {
        const res = await admin
          .post(`/api/v1/pharmacy-orders/orders/${orderId}/delivered`)
          .set('Idempotency-Key', `med03-delivered-admin-${orderId}`)
          .send({});
        // app.js mounts /orders/:id/delivered with
        // requireRole(...PHARMACY_DELIVERY_CUSTODY_ROLES) = DELIVERY_STAFF |
        // PHARMACY_INCHARGE. ADMIN — which drove the whole lifecycle before this
        // train — is no longer admitted to delivery custody.
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('Forbidden');

        const row = await readOrder(orderId, 'status, delivered_at');
        expect(row.status).toBe('CONFIRMED');
        expect(row.delivered_at).toBeNull();
      });

      it('serves the alias mount under the same role gate', async () => {
        const res = await admin
          .post(`/api/v1/pharmacy/orders/${orderId}/delivered`)
          .set('Idempotency-Key', `med03-delivered-alias-${orderId}`)
          .send({});
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('Forbidden');
      });

      // The DELIVERY_STAFF side of the mount: a courier clears requireRole and
      // then meets requireExactDeliveryCustody (orderRoutes.js:184-230), whose
      // predicate demands DISPATCHED + delivery_custody_status='in_transit' +
      // an unconsumed handoff + an ACTIVE facility grant for this actor. This
      // courier holds NONE of that — the order is CONFIRMED and COURIER_UID was
      // deliberately seeded without a pharmacy_staff_facility_grants row — so
      // the predicate returns no row.
      //
      // Pinning the exact CODE, not just 404, is the point. The refusal used to
      // be a hand-stamped `new Error()` carrying `error.status = 404`, which
      // errorHandlerMiddleware (it reads `err.statusCode`, never `err.status`)
      // answered 500 with no code at all. It is now AppError.notFound with
      // PHARMACY_DELIVERY_CUSTODY_NOT_FOUND, and the code is what distinguishes
      // this refusal from the several other 404s the path could produce.
      it('refuses a courier with no custody over the order, as an exact 404', async () => {
        const res = await courier
          .post(`/api/v1/pharmacy-orders/orders/${orderId}/delivered`)
          .set('Idempotency-Key', `med03-delivered-nocustody-${orderId}`)
          .send({});
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('PHARMACY_DELIVERY_CUSTODY_NOT_FOUND');

        const row = await readOrder(
          orderId,
          'status, delivered_at, delivery_handoff_consumed_at',
        );
        expect(row.status).toBe('CONFIRMED');
        expect(row.delivered_at).toBeNull();
        expect(row.delivery_handoff_consumed_at).toBeNull();
      });

      it('refuses an unparseable order id at the custody guard, not the engine', async () => {
        // The same AppError branch guards a non-numeric :id. It matters that
        // this is a 404 miss and not the 500 the guard still (correctly) raises
        // for missing tenant/actor context — an id that cannot name a row is a
        // miss, an absent auth context is an environment failure.
        const res = await courier
          .post('/api/v1/pharmacy-orders/orders/not-an-id/delivered')
          .set('Idempotency-Key', 'med03-delivered-badid')
          .send({});
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('PHARMACY_DELIVERY_CUSTODY_NOT_FOUND');
      });
    });

    it('getOrderDetail returns the history trail in order', async () => {
      const res = await incharge.get(`/api/v1/pharmacy-orders/orders/${orderId}/detail`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.order.id).toBe(orderId);
      expect(res.body.data.order.status).toBe('CONFIRMED');
      expect(res.body.data.order.order_number).toBe(orderNumber);
      expect(Number(res.body.data.order.facility_id)).toBe(facilityId);

      const transitions = res.body.data.history.map(
        (h) => `${h.from_status || 'NEW'}->${h.to_status}`,
      );
      expect(transitions).toEqual(['NEW->PENDING', 'PENDING->CONFIRMED']);
    });

    it('records the confirmed transition in the canonical clinical audit stream', async () => {
      const events = await setTenantTx(TENANT, (tx) => tx.$queryRawUnsafe(
        `SELECT action, patient_uid, actor_uid
           FROM clinical_audit_events
          WHERE resource_type = 'pharmacy_order'
            AND resource_id = $1
          ORDER BY occurred_at ASC`,
        String(orderId),
      ));

      expect(events.map((event) => event.action)).toEqual(
        expect.arrayContaining(['pharmacy.order_confirmed']),
      );
      expect(events.every((event) => event.patient_uid === PATIENT_UID)).toBe(true);
      expect(events.every((event) => event.actor_uid === INCHARGE_UID)).toBe(true);
    });

    it('leaves facility inventory untouched — allocation now happens at dispatch', async () => {
      const inventory = await setTenantTx(TENANT, (tx) => tx.$queryRawUnsafe(
        `SELECT id, remaining_quantity
           FROM pharmacy_inventory_batches
          WHERE tenant_id=$1::uuid AND id = ANY($2::int[])
          ORDER BY id`,
        TENANT,
        [paracetamolBatchId, coughBatchId],
      ));
      const balanceById = new Map(
        inventory.map((batch) => [Number(batch.id), Number(batch.remaining_quantity)]),
      );
      expect(balanceById.get(paracetamolBatchId)).toBe(100);
      expect(balanceById.get(coughBatchId)).toBe(10);

      const movements = await setTenantTx(TENANT, (tx) => tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM pharmacy_stock_movements
          WHERE tenant_id=$1::uuid
            AND (metadata->>'order_id')::int = $2::int`,
        TENANT,
        Number(orderId),
      ));
      expect(movements[0].count).toBe(0);
    });
  });

  describe('cancelOrder branch', () => {
    let orderId;

    beforeAll(async () => {
      const seeded = await seedPendingOrder('Cancel flow test');
      orderId = seeded.id;
    });

    it('requires a cancellation reason', async () => {
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/cancel`)
        .set('Idempotency-Key', `med03-cancel-noreason-${orderId}`)
        .send({});
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('PHARMACY_ORDER_CANCELLATION_REASON_REQUIRED');

      const row = await readOrder(orderId, 'status');
      expect(row.status).toBe('PENDING');
    });

    it('cancels a PENDING order and records the reason', async () => {
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/cancel`)
        .set('Idempotency-Key', `med03-cancel-${orderId}`)
        .send({ cancellation_reason: 'Patient requested cancellation' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
      expect(res.body.data.cancellation_reason).toBe('Patient requested cancellation');

      const row = await readOrder(orderId, 'status, cancellation_reason, cancelled_at');
      expect(row.status).toBe('CANCELLED');
      expect(row.cancellation_reason).toBe('Patient requested cancellation');
      expect(row.cancelled_at).toBeTruthy();

      const hist = await setTenantTx(TENANT, (tx) => tx.$queryRawUnsafe(
        `SELECT from_status, to_status, notes FROM pharmacy_order_history
          WHERE tenant_id=$1::uuid AND order_id=$2::int
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        TENANT,
        Number(orderId),
      ));
      expect(hist[0].from_status).toBe('PENDING');
      expect(hist[0].to_status).toBe('CANCELLED');
      expect(hist[0].notes).toBe('Patient requested cancellation');
    });

    it('blocks further cancel attempts from the terminal CANCELLED state', async () => {
      const res = await incharge
        .post(`/api/v1/pharmacy-orders/orders/${orderId}/cancel`)
        .set('Idempotency-Key', `med03-cancel-closed-${orderId}`)
        .send({ cancellation_reason: 'Second attempt on a closed order' });
      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('PHARMACY_ORDER_CANCEL_CLOSED');
    });

    // Carried over in INTENT from the pre-753 suite (the old case posted to
    // the same path with no Idempotency-Key and expected 404). The key is
    // supplied here because orderDispenseIdempotency sits between the guard
    // and the handler and 400s without it, which would answer this request
    // before anything ever looked the order up. A well-formed
    // cancellation_reason is sent for the same reason, though on this path it
    // is never reached: cancelOrder resolves facility custody first.
    //
    // ★ THIS CASE WAS RED FOR MOST OF THIS ROUND AND IS NOW GREEN. The pin
    // never moved — 404 was always the declared contract — but the route did
    // not deliver it until the root fix landed late in the round. Keeping the
    // derivation here so the next reader does not re-open it as a defect:
    //   • selectOrderPatient resolves an unknown id to null, so under this
    //     suite's tenant (no care_team_enforcement_mode setting → the
    //     documented SHADOW default) patientAccessGuard takes its
    //     no_patient_context branch, cannot block in shadow
    //     (phiAccessMiddleware.js:134-147), and calls next().
    //   • cancelOrder still consults facility custody BEFORE its own not-found
    //     branch — resolveOrderPharmacyFacility at pharmacyOrderController.js
    //     :4124 vs the `result?.error === 'NOT_FOUND'` branch at :4215 — and
    //     that ordering is UNCHANGED. What changed is the classification at
    //     the root, which is where the two callers' 404 branches were being
    //     shadowed from.
    //   • resolveOrderPharmacyFacility's custody JOIN still misses for an id
    //     naming no row, but its MISS path now probes order existence first
    //     (pharmacyFacilityAuthorityService.js:444-454, tenant-scoped by an
    //     explicit `tenant_id=$1::uuid` predicate so a cross-tenant row reads
    //     as absent rather than leaking existence) and raises the same
    //     AppError.notFound('Order not found') the handlers raise. A REAL
    //     order whose facility is unset / inactive passes that probe and still
    //     gets 409 PHARMACY_ORDER_FACILITY_UNRESOLVED from :455-459, so the
    //     conflict has not been weakened into a 404.
    //   • relayAppError (responseHelper.js:184-199) reads err.statusCode, so
    //     the 404 reaches the client as a 404 rather than as a bare 500.
    // ⚠ The controller line numbers above moved repeatedly during this round
    // as sibling lanes edited around cancelOrder. Trust the ORDERING claim —
    // custody resolution before the handler's own NOT_FOUND branch, with the
    // classification made inside the service — over the numbers, and re-grep
    // rather than assuming they still point at it.
    // ⚠ One stale artefact of the old red survives OUTSIDE this file: the
    // selectOrderPatient docblock in routes/pharmacy/pharmacyOrderPatientGuards
    // .js still says an unknown id "is answered 409
    // PHARMACY_ORDER_FACILITY_UNRESOLVED rather than 404" and that this case
    // pins it red. That prose is now wrong; it is that file's owner to correct,
    // not this fixture lane's. Do not re-derive the defect from it.
    //
    // The delivery-custody guard had the mirror-image defect (a hand-stamped
    // `error.status = 404` that errorHandlerMiddleware answered 500), fixed in
    // this same wave to AppError.notFound + an exact code, and the 'refuses a
    // courier with no custody' case above now pins it. Both defects are CLOSED;
    // do not re-derive either from an older copy of this ledger.
    it('returns 404 for an unknown order id', async () => {
      const res = await incharge
        .post('/api/v1/pharmacy-orders/orders/99999999/cancel')
        .set('Idempotency-Key', 'med03-cancel-unknown-order')
        .send({ cancellation_reason: 'Cancel an order that does not exist' });
      expect(res.statusCode).toBe(404);
    });

    it('records the cancelled transition in the canonical clinical audit stream', async () => {
      const events = await setTenantTx(TENANT, (tx) => tx.$queryRawUnsafe(
        `SELECT action, patient_uid, actor_uid
           FROM clinical_audit_events
          WHERE resource_type = 'pharmacy_order'
            AND resource_id = $1
          ORDER BY occurred_at ASC`,
        String(orderId),
      ));
      expect(events.map((event) => event.action)).toEqual(
        expect.arrayContaining(['pharmacy.order_cancelled']),
      );
      expect(events.every((event) => event.patient_uid === PATIENT_UID)).toBe(true);
      expect(events.every((event) => event.actor_uid === INCHARGE_UID)).toBe(true);
    });
  });

  describe('getOrderQueue + SLA dashboard', () => {
    it('returns this facility\'s orders with the computed queue fields', async () => {
      const res = await incharge.get('/api/v1/pharmacy-orders/orders/queue');
      expect(res.statusCode).toBe(200);
      const arr = res.body.data;
      expect(Array.isArray(arr)).toBe(true);

      const ours = arr.filter((o) => o.patient_id === patientIntId);
      expect(ours).toHaveLength(2);
      for (const o of ours) {
        expect(Number(o.facility_id)).toBe(facilityId);
        expect(Number(o.mins_since_placed)).toBeGreaterThanOrEqual(0);
        expect(typeof o.sla_breached).toBe('boolean');
        expect(o.facility_recovery_required).toBe(false);
      }
      expect(ours.map((o) => o.status).sort()).toEqual(['CANCELLED', 'CONFIRMED']);
    });

    it('filters the queue by status', async () => {
      const res = await incharge.get('/api/v1/pharmacy-orders/orders/queue?status=CANCELLED');
      expect(res.statusCode).toBe(200);
      // The tenant holds exactly two orders and only one is CANCELLED.
      expect(res.body.data).toHaveLength(1);
      for (const o of res.body.data) {
        expect(o.status).toBe('CANCELLED');
      }
    });

    it('SLA dashboard returns aggregate counts + avg-times blocks for the facility', async () => {
      // Postgres `current_date` so the date matches what the rows were stamped
      // with (NOW() in server timezone). JS UTC drifts at midnight IST.
      const dateRows = await setTenantTx(TENANT, (tx) => tx.$queryRawUnsafe(
        `SELECT current_date::text AS today`,
      ));
      const today = dateRows[0].today;
      const res = await incharge.get(
        `/api/v1/pharmacy-orders/orders/sla?from_date=${today}&to_date=${today}`,
      );
      expect(res.statusCode).toBe(200);
      const d = res.body.data;
      expect(d.summary.total).toBe(2);
      expect(d.summary.confirmed).toBe(1);
      expect(d.summary.cancelled).toBe(1);
      expect(d.summary.delivered).toBe(0);
      expect(d.avg_times).toBeDefined();
      expect(typeof d.sla_breaches).toBe('number');
      expect(d.date_range).toEqual({ from: today, to: today });
    });
  });
});
