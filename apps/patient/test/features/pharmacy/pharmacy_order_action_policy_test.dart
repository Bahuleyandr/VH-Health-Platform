// test/features/pharmacy/pharmacy_order_action_policy_test.dart
//
// Pure-Dart tests for the pharmacy order action-policy UI logic. The
// PharmacyOrderCard + order-detail sheet show different action buttons
// (Cancel / Track / Reorder / View Prescription) depending on the status
// returned by the backend. This file pins the decision matrix so a backend
// status rename (like the 2026-04-14 `PLACED` → `PENDING` rename) never
// silently puts a stuck order in a state where the user has no way out.
//
// Uses the same mirror-class pattern as `api_client_test.dart` — the real
// policy is tangled with Material widgets and theme colours; the logic
// under test is the status → {allowed actions} mapping.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/models/status_enums.dart';

class OrderActions {
  const OrderActions({
    required this.canCancel,
    required this.canTrack,
    required this.canReorder,
    required this.canViewPrescription,
  });

  final bool canCancel;   // cancel button shown
  final bool canTrack;    // live delivery tracking button shown
  final bool canReorder;  // re-order button shown (terminal delivered only)
  final bool canViewPrescription;  // always true when Rx is attached
}

/// Decide which action buttons appear for a given canonical status.
///
/// Rules (pin them here so the UI and tests share one source):
///  * cancel: only while the order is still within the patient's control
///    (PENDING, CONFIRMED). Once PREPARING or later, cancellation goes
///    through support, not the app.
///  * track: live tracking is only meaningful once the order is moving
///    (DISPATCHED). READY + DELIVERED + terminal states have no live map.
///  * reorder: delivered orders get a "Re-order" shortcut.
///  * viewPrescription: always shown if an Rx is attached. This flag is
///    a function of the Rx presence, not status.
OrderActions actionsFor(PharmacyOrderStatus? status, {required bool hasRx}) {
  final canCancel = status == PharmacyOrderStatus.pending ||
      status == PharmacyOrderStatus.confirmed;
  final canTrack = status == PharmacyOrderStatus.dispatched;
  final canReorder = status == PharmacyOrderStatus.delivered;
  return OrderActions(
    canCancel: canCancel,
    canTrack: canTrack,
    canReorder: canReorder,
    canViewPrescription: hasRx,
  );
}

void main() {
  group('pharmacy order action policy', () {
    test('PENDING order allows cancel; no track / reorder yet', () {
      final a = actionsFor(PharmacyOrderStatus.pending, hasRx: true);
      expect(a.canCancel, isTrue);
      expect(a.canTrack, isFalse);
      expect(a.canReorder, isFalse);
      expect(a.canViewPrescription, isTrue);
    });

    test('CONFIRMED still cancellable by the patient', () {
      final a = actionsFor(PharmacyOrderStatus.confirmed, hasRx: false);
      expect(a.canCancel, isTrue);
      expect(a.canViewPrescription, isFalse,
          reason: 'Non-Rx (walk-in) order should not show "View Prescription"');
    });

    test('PREPARING removes cancel — requires support contact', () {
      final a = actionsFor(PharmacyOrderStatus.preparing, hasRx: true);
      expect(a.canCancel, isFalse,
          reason: 'Once pharmacy has started preparation the patient cannot self-cancel');
      expect(a.canTrack, isFalse);
    });

    test('DISPATCHED enables live tracking, blocks cancel', () {
      final a = actionsFor(PharmacyOrderStatus.dispatched, hasRx: true);
      expect(a.canTrack, isTrue);
      expect(a.canCancel, isFalse);
      expect(a.canReorder, isFalse);
    });

    test('DELIVERED — only re-order + Rx view', () {
      final a = actionsFor(PharmacyOrderStatus.delivered, hasRx: true);
      expect(a.canReorder, isTrue);
      expect(a.canTrack, isFalse, reason: 'Tracking ends at delivery');
      expect(a.canCancel, isFalse);
    });

    test('CANCELLED is fully terminal — no buttons besides Rx view', () {
      final a = actionsFor(PharmacyOrderStatus.cancelled, hasRx: true);
      expect(a.canCancel, isFalse);
      expect(a.canTrack, isFalse);
      expect(a.canReorder, isFalse);
      expect(a.canViewPrescription, isTrue);
    });

    test('legacy PLACED folds into PENDING (same affordances)', () {
      // Simulates an old backend deployment still emitting PLACED.
      final parsed = PharmacyOrderStatus.fromString('PLACED');
      expect(parsed, PharmacyOrderStatus.pending);
      final a = actionsFor(parsed, hasRx: true);
      expect(a.canCancel, isTrue,
          reason: 'Cancel must still work for old-status orders — '
              'regression guard for the 2026-04-14 rename');
    });

    test('unknown/null status → safe empty set of actions', () {
      final a = actionsFor(null, hasRx: true);
      expect(a.canCancel, isFalse);
      expect(a.canTrack, isFalse);
      expect(a.canReorder, isFalse);
      expect(a.canViewPrescription, isTrue,
          reason: 'Rx view is independent of status');
    });
  });
}
