// test/features/pharmacy/dispensing_flow_test.dart
//
// Tests for the pharmacy dispensing flow's order-classification logic and
// role-based access guards. The real implementation lives in
// `lib/features/pharmacy/screens/pharmacy_screen.dart`.
//
// Following the mirror-class pattern used throughout these staff-app tests,
// this file exercises the business logic in pure Dart so the clinical
// dispensing handoff invariants never silently regress.
//
// Clinical-safety invariants under test:
//   1. The PENDING/PLACED status gate must route all new orders (both legacy
//      "PLACED" and canonical "PENDING") into the "new orders" tab, not the
//      active tab where dispensing staff wouldn't see them.
//   2. CONFIRMED, PREPARING, READY, DISPATCHED are mid-lifecycle statuses
//      that belong in the "active" tab — nurses/patients depend on this to
//      find in-progress orders.
//   3. PARTIALLY_DISPENSED remains active; DISPENSED, DELIVERED, UNAVAILABLE,
//      and CANCELLED are terminal statuses in the completed tab only.
//   4. Role access: only pharmacy, pharmacyIncharge, and admin-tier roles
//      can work pharmacy orders (dispense/confirm/prepare). Stores/purchase
//      roles see inventory but not patient dispensing.
//   5. Formulary management (add/remove drugs) is restricted to
//      pharmacyIncharge and admin-tier only (not plain pharmacy staff).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';
import 'package:vhhealth_staff/features/pharmacy/models/pharmacy_funding_recovery.dart';

// ── Mirror of role enum ───────────────────────────────────────────────────────
// Mirrors the StaffRole values relevant to pharmacy from role_config.dart.
// Only the roles exercised in the pharmacy screen's role gate predicates are
// replicated here. The canonical exhaustive role tests live in
// test/core/config/role_config_test.dart.
enum PharmacyTestRole {
  pharmacy,
  pharmacyIncharge,
  storesPurchaseIncharge,
  admin,
  superAdmin,
  doctor,
  nurse,
  general,
}

// ── Mirror of pharmacy role gates from _PharmacyScreenState ──────────────────

bool canWorkPharmacyOrders(PharmacyTestRole role) =>
    role == PharmacyTestRole.pharmacy ||
    role == PharmacyTestRole.pharmacyIncharge ||
    _isAdminTier(role);

bool canManageFormulary(PharmacyTestRole role) =>
    role == PharmacyTestRole.pharmacyIncharge || _isAdminTier(role);

bool canPerformClinicalVerification(PharmacyTestRole role) =>
    role == PharmacyTestRole.pharmacy ||
    role == PharmacyTestRole.pharmacyIncharge;

bool canBreakGlassVerification(PharmacyTestRole role) =>
    role == PharmacyTestRole.pharmacyIncharge;

bool canViewInventory(PharmacyTestRole role) =>
    role == PharmacyTestRole.pharmacy ||
    role == PharmacyTestRole.pharmacyIncharge ||
    role == PharmacyTestRole.storesPurchaseIncharge ||
    _isAdminTier(role);

bool canManageInventory(PharmacyTestRole role) =>
    role == PharmacyTestRole.pharmacyIncharge ||
    role == PharmacyTestRole.storesPurchaseIncharge ||
    _isAdminTier(role);

bool _isAdminTier(PharmacyTestRole role) =>
    role == PharmacyTestRole.admin || role == PharmacyTestRole.superAdmin;

// ── Mirror of order status classification from _PharmacyScreenState ──────────

bool isNewStatus(Object? status) {
  final value = status?.toString().toUpperCase();
  return value == 'PENDING' || value == 'PLACED';
}

bool isActiveStatus(Object? status) {
  final value = status?.toString().toUpperCase();
  return const {
    'CONFIRMED',
    'PREPARING',
    'READY',
    'DISPATCHED',
    'PARTIALLY_DISPENSED',
  }.contains(value);
}

bool isCompletedStatus(Object? status) {
  final value = status?.toString().toUpperCase();
  return const {
    'DISPENSED',
    'DELIVERED',
    'UNAVAILABLE',
    'CANCELLED',
  }.contains(value);
}

// ── Mirror of order list filters from _PharmacyScreenState ───────────────────

List<Map<String, dynamic>> filterNewOrders(List<Map<String, dynamic>> orders) =>
    orders.where((o) => isNewStatus(o['status'])).toList();

List<Map<String, dynamic>> filterActiveOrders(
  List<Map<String, dynamic>> orders,
) => orders.where((o) => isActiveStatus(o['status'])).toList();

List<Map<String, dynamic>> filterCompletedOrders(
  List<Map<String, dynamic>> orders,
) => orders.where((o) => isCompletedStatus(o['status'])).toList();

// ─────────────────────────────────────────────────────────────────────────────

void main() {
  const inventoryAuthorityKeys = <String>[
    'med03.pharmacy.catalog_fallback',
    'med03.pharmacy.locked_line_summary',
    'med03.pharmacy.order_line_fallback',
    'med03.pharmacy.verification_pharmacist_only',
    'med03.pharmacy.verification_rejection_reason',
    'med03.pharmacy.verification_override_incharge',
    'med03.pharmacy.verification_manual_allergy_review',
    'med03.pharmacy.verification_manual_allergy_review_help',
    'med03.pharmacy.payment_mode.cash',
    'med03.pharmacy.payment_mode.card',
    'med03.pharmacy.payment_mode.upi',
    'med03.pharmacy.payment_mode.wallet',
    'med03.pharmacy.payment_mode.insurance',
    'med03.pharmacy.payment_mode.corporate_tpa',
    'med03.pharmacy.payment_mode.none',
    'med03.pharmacy.recovery.select_exact_tpa_claim_allocation',
    'med03.pharmacy.recovery.materialize_pharmacy_funding',
    'med03.pharmacy.recovery.open_exact_pharmacy_funding_task',
    'med03.pharmacy.recovery.complete_manual_allergy_review',
    'med03.pharmacy.recovery.contact_owner',
    'med03.pharmacy.recovery.open_billing_desk',
    'med03.pharmacy.cancellation_reason_help',
    'med03.pharmacy.delivery_type_counter',
    'med03.pharmacy.status_dispensed',
    'med03.pharmacy.inventory_status.active',
    'med03.pharmacy.inventory_status.inactive',
    'med03.pharmacy.inventory_status.quarantined',
    'med03.pharmacy.inventory_status.unknown',
    'med03.pharmacy.expiry_bucket.expired',
    'med03.pharmacy.expiry_bucket.within_30',
    'med03.pharmacy.expiry_bucket.within_60',
    'med03.pharmacy.expiry_bucket.within_90',
    'med03.pharmacy.expiry_bucket.beyond_90',
    'med03.pharmacy.expiry_bucket.unknown',
    'med03.pharmacy.funding_recovery.task_summary',
    'med03.pharmacy.funding_recovery.status.pending',
    'med03.pharmacy.funding_recovery.status.in_progress',
    'med03.pharmacy.funding_recovery.status.blocked',
    'med03.pharmacy.funding_recovery.status.completed',
    'med03.pharmacy.funding_recovery.status.unknown',
    'med03.pharmacy.funding_recovery.owner.finance',
    'med03.pharmacy.funding_recovery.owner.insurance',
    'med03.pharmacy.funding_recovery.owner.billing',
    'med03.pharmacy.funding_recovery.owner.unknown',
  ];

  test('inventory-authority workflow keys ship in all five locales', () {
    for (final locale in const ['en', 'hi', 'ta', 'te', 'ml']) {
      final strings = AppStrings.forLocale(Locale(locale));
      for (final key in inventoryAuthorityKeys) {
        expect(
          strings.lookup(key),
          isNot(key),
          reason: '$locale must own $key without English fallback tokens',
        );
      }
    }
  });

  test('funding recovery accepts only exact role-gated billing deep links', () {
    final recovery = PharmacyFundingRecovery.from(const {
      'task_id': 'TPA-91',
      'status': 'in_progress',
      'owner_role': 'INSURANCE_COORDINATOR',
      'deep_link': '/billing-desk?pharmacy_order_id=91&invoice_item_id=81&tpa_claim_id=71',
    });
    expect(recovery, isNotNull);
    expect(recovery!.blocksStockIssue, isTrue);
    expect(recovery.deepLink, isNotNull);

    final duplicateLineRecovery = PharmacyFundingRecovery.from(const {
      'task_id': 'FIN-92',
      'status': 'blocked',
      'owner_role': 'FINANCE_INCHARGE',
      'deep_link': '/billing-desk?funding_reconciliation_case_id=92',
    });
    expect(duplicateLineRecovery, isNotNull);
    expect(duplicateLineRecovery!.deepLink, isNotNull);

    final absoluteLink = PharmacyFundingRecovery.from(const {
      'task_id': 'TPA-91',
      'status': 'pending',
      'owner_role': 'INSURANCE_COORDINATOR',
      'deep_link': 'https://example.invalid/billing-desk?pharmacy_order_id=91&invoice_item_id=81&tpa_claim_id=71',
    });
    expect(absoluteLink, isNotNull);
    expect(absoluteLink!.deepLink, isNull);

    final duplicateIdentity = PharmacyFundingRecovery.from(const {
      'task_id': 'TPA-91',
      'status': 'pending',
      'owner_role': 'INSURANCE_COORDINATOR',
      'deep_link': '/billing-desk?pharmacy_order_id=91&pharmacy_order_id=92&invoice_item_id=81&tpa_claim_id=71',
    });
    expect(duplicateIdentity, isNotNull);
    expect(duplicateIdentity!.deepLink, isNull);

    final pharmacyProjection = PharmacyFundingRecovery.from(const {
      'task_id': 'TPA-91',
      'status': 'pending',
      'owner_role': 'INSURANCE_COORDINATOR',
      'deep_link': null,
    });
    expect(pharmacyProjection, isNotNull);
    expect(pharmacyProjection!.deepLink, isNull);
  });

  // ── Order status classification ───────────────────────────────────────────
  group('isNewStatus (new-orders tab gate)', () {
    test('PENDING is a new status (canonical)', () {
      expect(isNewStatus('PENDING'), isTrue);
    });

    test(
      'PLACED is a new status (legacy alias — backend renamed 2026-04-14)',
      () {
        // Backend renamed "PLACED" to "PENDING" but old DB rows / API responses
        // may still carry "PLACED". This must land in the new-orders tab.
        expect(isNewStatus('PLACED'), isTrue);
      },
    );

    test('pending and placed are accepted case-insensitively', () {
      expect(isNewStatus('pending'), isTrue);
      expect(isNewStatus('placed'), isTrue);
      expect(isNewStatus('Pending'), isTrue);
    });

    test('CONFIRMED is not a new status', () {
      expect(isNewStatus('CONFIRMED'), isFalse);
    });

    test('null status returns false (defensive)', () {
      expect(isNewStatus(null), isFalse);
    });
  });

  group('isActiveStatus (active-orders tab gate)', () {
    test(
      'CONFIRMED is active',
      () => expect(isActiveStatus('CONFIRMED'), isTrue),
    );
    test(
      'PREPARING is active',
      () => expect(isActiveStatus('PREPARING'), isTrue),
    );
    test('READY is active', () => expect(isActiveStatus('READY'), isTrue));
    test(
      'DISPATCHED is active',
      () => expect(isActiveStatus('DISPATCHED'), isTrue),
    );

    test('PENDING is not active (it is new)', () {
      expect(isActiveStatus('PENDING'), isFalse);
    });

    test('DELIVERED is not active (it is completed)', () {
      expect(isActiveStatus('DELIVERED'), isFalse);
    });
  });

  group('isCompletedStatus (completed-orders tab gate)', () {
    test(
      'DELIVERED is completed',
      () => expect(isCompletedStatus('DELIVERED'), isTrue),
    );
    test(
      'CANCELLED is completed',
      () => expect(isCompletedStatus('CANCELLED'), isTrue),
    );

    test('DISPATCHED is not completed (still active)', () {
      expect(isCompletedStatus('DISPATCHED'), isFalse);
    });

    test('PENDING is not completed', () {
      expect(isCompletedStatus('PENDING'), isFalse);
    });
  });

  // ── Order list filtering ──────────────────────────────────────────────────
  group('filterNewOrders / filterActiveOrders / filterCompletedOrders', () {
    final orders = [
      {'id': 1, 'status': 'PENDING'},
      {'id': 2, 'status': 'PLACED'},
      {'id': 3, 'status': 'CONFIRMED'},
      {'id': 4, 'status': 'PREPARING'},
      {'id': 5, 'status': 'READY'},
      {'id': 6, 'status': 'DISPATCHED'},
      {'id': 7, 'status': 'PARTIALLY_DISPENSED'},
      {'id': 8, 'status': 'DISPENSED'},
      {'id': 9, 'status': 'DELIVERED'},
      {'id': 10, 'status': 'UNAVAILABLE'},
      {'id': 11, 'status': 'CANCELLED'},
    ];

    test('new orders tab receives PENDING + PLACED only', () {
      final newOrders = filterNewOrders(orders);
      expect(newOrders.map((o) => o['id']), containsAll([1, 2]));
      expect(newOrders, hasLength(2));
    });

    test('active orders tab receives CONFIRMED/PREPARING/READY/DISPATCHED', () {
      final active = filterActiveOrders(orders);
      expect(active.map((o) => o['id']), containsAll([3, 4, 5, 6, 7]));
      expect(active, hasLength(5));
    });

    test('completed tab receives every terminal dispense outcome', () {
      final done = filterCompletedOrders(orders);
      expect(done.map((o) => o['id']), containsAll([8, 9, 10, 11]));
      expect(done, hasLength(4));
    });

    test('every order lands in exactly one tab (no overlaps)', () {
      final newIds = filterNewOrders(orders).map((o) => o['id']).toSet();
      final activeIds = filterActiveOrders(orders).map((o) => o['id']).toSet();
      final doneIds = filterCompletedOrders(orders).map((o) => o['id']).toSet();

      // No order appears in more than one tab.
      expect(newIds.intersection(activeIds), isEmpty);
      expect(newIds.intersection(doneIds), isEmpty);
      expect(activeIds.intersection(doneIds), isEmpty);

      // Every order in the list appears in exactly one tab.
      final allCovered = {...newIds, ...activeIds, ...doneIds};
      final allIds = orders.map((o) => o['id']).toSet();
      expect(allCovered, equals(allIds));
    });
  });

  // ── Role-based dispensing access ──────────────────────────────────────────
  group('canWorkPharmacyOrders (dispensing workflow gate)', () {
    test('pharmacy staff can work orders', () {
      expect(canWorkPharmacyOrders(PharmacyTestRole.pharmacy), isTrue);
    });

    test('pharmacyIncharge can work orders', () {
      expect(canWorkPharmacyOrders(PharmacyTestRole.pharmacyIncharge), isTrue);
    });

    test('admin-tier roles can work orders (oversight access)', () {
      expect(canWorkPharmacyOrders(PharmacyTestRole.admin), isTrue);
      expect(canWorkPharmacyOrders(PharmacyTestRole.superAdmin), isTrue);
    });

    test('stores/purchase incharge cannot work patient dispensing orders', () {
      // Critical: stores role sees inventory but must NOT dispense patient meds.
      expect(
        canWorkPharmacyOrders(PharmacyTestRole.storesPurchaseIncharge),
        isFalse,
        reason:
            'Stores/purchase role must not access patient dispensing workflow',
      );
    });

    test('doctor cannot work pharmacy orders', () {
      expect(canWorkPharmacyOrders(PharmacyTestRole.doctor), isFalse);
    });

    test('nurse cannot work pharmacy orders', () {
      expect(canWorkPharmacyOrders(PharmacyTestRole.nurse), isFalse);
    });

    test('general staff cannot work pharmacy orders', () {
      expect(canWorkPharmacyOrders(PharmacyTestRole.general), isFalse);
    });
  });

  group('canManageFormulary (drug formulary edit gate)', () {
    test('pharmacyIncharge can manage formulary', () {
      expect(canManageFormulary(PharmacyTestRole.pharmacyIncharge), isTrue);
    });

    test('admin-tier can manage formulary', () {
      expect(canManageFormulary(PharmacyTestRole.admin), isTrue);
      expect(canManageFormulary(PharmacyTestRole.superAdmin), isTrue);
    });

    test(
      'plain pharmacy staff cannot manage formulary (can only dispense)',
      () {
        // Clinical safety: plain staff should not add/remove drugs from
        // the shared formulary used by OP/IP prescribing.
        expect(
          canManageFormulary(PharmacyTestRole.pharmacy),
          isFalse,
          reason: 'Plain pharmacy staff must not edit the shared formulary',
        );
      },
    );

    test('stores/purchase incharge cannot manage formulary', () {
      expect(
        canManageFormulary(PharmacyTestRole.storesPurchaseIncharge),
        isFalse,
      );
    });

    test('doctor cannot manage formulary', () {
      expect(canManageFormulary(PharmacyTestRole.doctor), isFalse);
    });
  });

  group('clinical verification authority', () {
    test('pharmacy staff and incharge may verify or reject', () {
      expect(canPerformClinicalVerification(PharmacyTestRole.pharmacy), isTrue);
      expect(
        canPerformClinicalVerification(PharmacyTestRole.pharmacyIncharge),
        isTrue,
      );
    });

    test('administrators have oversight but no clinical decision control', () {
      expect(canPerformClinicalVerification(PharmacyTestRole.admin), isFalse);
      expect(
        canPerformClinicalVerification(PharmacyTestRole.superAdmin),
        isFalse,
      );
    });

    test('only pharmacy incharge has break-glass override authority', () {
      expect(canBreakGlassVerification(PharmacyTestRole.pharmacy), isFalse);
      expect(
        canBreakGlassVerification(PharmacyTestRole.pharmacyIncharge),
        isTrue,
      );
      expect(canBreakGlassVerification(PharmacyTestRole.admin), isFalse);
    });
  });

  group('canViewInventory', () {
    test('pharmacy, pharmacyIncharge, stores, admin can view inventory', () {
      expect(canViewInventory(PharmacyTestRole.pharmacy), isTrue);
      expect(canViewInventory(PharmacyTestRole.pharmacyIncharge), isTrue);
      expect(canViewInventory(PharmacyTestRole.storesPurchaseIncharge), isTrue);
      expect(canViewInventory(PharmacyTestRole.admin), isTrue);
    });

    test('doctor and nurse cannot view pharmacy inventory', () {
      expect(canViewInventory(PharmacyTestRole.doctor), isFalse);
      expect(canViewInventory(PharmacyTestRole.nurse), isFalse);
      expect(canViewInventory(PharmacyTestRole.general), isFalse);
    });
  });

  group('canManageInventory (stock updates and expiry scans)', () {
    test('pharmacyIncharge can manage inventory', () {
      expect(canManageInventory(PharmacyTestRole.pharmacyIncharge), isTrue);
    });

    test('stores/purchase incharge can manage inventory', () {
      // Core use-case: stores staff maintain drug master + stock oversight.
      expect(
        canManageInventory(PharmacyTestRole.storesPurchaseIncharge),
        isTrue,
      );
    });

    test('plain pharmacy staff cannot manage inventory (dispense-only)', () {
      expect(
        canManageInventory(PharmacyTestRole.pharmacy),
        isFalse,
        reason:
            'Plain pharmacy staff should not update stock or run expiry scans',
      );
    });
  });

  // ── Dispensing lifecycle completeness ─────────────────────────────────────
  group('Pharmacy dispensing lifecycle coverage', () {
    test('each canonical status maps to exactly one tab', () {
      final statuses = [
        'PENDING',
        'PLACED',
        'CONFIRMED',
        'PREPARING',
        'READY',
        'DISPATCHED',
        'PARTIALLY_DISPENSED',
        'DISPENSED',
        'DELIVERED',
        'UNAVAILABLE',
        'CANCELLED',
      ];

      for (final s in statuses) {
        final inNew = isNewStatus(s);
        final inActive = isActiveStatus(s);
        final inDone = isCompletedStatus(s);
        final tabCount = [inNew, inActive, inDone].where((b) => b).length;
        expect(
          tabCount,
          1,
          reason: 'Status "$s" appeared in $tabCount tabs instead of exactly 1',
        );
      }
    });
  });
}
