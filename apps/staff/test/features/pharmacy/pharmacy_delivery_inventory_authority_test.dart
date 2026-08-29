import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'dispatch closes inventory recovery before token-only delivery handoff',
    () {
      final source = File('lib/features/pharmacy/screens/pharmacy_screen.dart')
          .readAsStringSync();
      final dispatch = source.substring(
        source.indexOf('Future<void> _dispatchOrder'),
        source.indexOf('Future<void> _markDelivered'),
      );
      final completion = source.substring(
        source.indexOf('Future<void> _markDelivered'),
        source.indexOf('void _clearControlledDeliveryWitnessState'),
      );

      expect(
        dispatch,
        contains('PHARMACY_ORDER_CONTROLLED_ALLOCATION_REQUIRED'),
      );
      expect(dispatch, contains('PHARMACY_ORDER_INVENTORY_ITEM_AMBIGUOUS'));
      expect(dispatch, contains('_collectAmbiguousInventoryItemSelection'));
      expect(dispatch, contains('_controlledDeliveryAllocations.putIfAbsent'));
      expect(
        dispatch,
        contains('error.statusCode >= 400 && error.statusCode < 500'),
      );
      expect(
        dispatch,
        contains('_clearControlledDeliveryWitnessState(orderId)'),
      );
      expect(
        dispatch,
        contains('final maximumDispatchAttempts = (orderLineCount * 2) + 1'),
      );
      expect(dispatch, contains('seenRecoverySteps'));
      expect(dispatch, contains('made no authoritative progress'));
      expect(completion, contains('completePharmacyDelivery'));
      expect(completion, contains('pharmacy-delivery-handoff-token'));
      expect(completion, contains('breakGlassReason'));
      expect(completion, isNot(contains('dispensed_items')));
      expect(completion, isNot(contains('payment_mode')));
      expect(source, contains('getInventoryBatches'));
      expect(source, contains('requestControlledDispenseWitnessApproval'));
      expect(source, contains('approveControlledDispenseWitnessApproval'));
      expect(source, contains("'witness_approval_id'"));
      expect(source, isNot(contains('dispenseControlledInventory')));
      expect(source, isNot(contains('_stopLocationSharing')));
    },
  );
}
