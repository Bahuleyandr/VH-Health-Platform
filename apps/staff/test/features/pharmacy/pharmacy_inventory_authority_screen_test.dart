import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/pharmacy/screens/pharmacy_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  Map<String, dynamic> order({
    required int id,
    String status = 'CONFIRMED',
    String deliveryType = 'counter',
    String verification = 'pending',
    bool facilityRecovery = false,
    bool lineRecovery = false,
    bool fundingRecovery = false,
    bool fundingDeepLink = true,
  }) => {
    'id': id,
    'status': status,
    'facility_id': facilityRecovery ? null : 8,
    'facility_recovery_required': facilityRecovery,
    'facility_recovery_target_id': facilityRecovery ? 8 : null,
    'line_identity_recovery_required': lineRecovery,
    'order_number': 'PH-$id',
    'patient_name': 'Patient $id',
    'patient_phone': '9999999999',
    'delivery_type': deliveryType,
    'total_amount': 125,
    'payment_mode': 'cash',
    'payment_status': 'pending',
    'amount_collected': 0,
    'payment_metadata': <String, dynamic>{},
    if (fundingRecovery)
      'funding_recovery': {
        'task_id': 'TPA-$id',
        'status': 'in_progress',
        'owner_role': 'INSURANCE_COORDINATOR',
        'deep_link': fundingDeepLink
            ? '/billing-desk?pharmacy_order_id=$id&invoice_item_id=81&tpa_claim_id=71'
            : null,
      },
    'items_list': [
      {
        'order_line_index': 0,
        'prescription_line_index': 0,
        'catalog_id': 17,
        'inventory_item_id': 71,
        'name': 'Medicine $id',
        'quantity': 1,
      },
    ],
    'inventory_authority_version': 1,
    'clinical_verification_status': verification,
    'clinically_verified_order_version': verification == 'pending' ? null : 1,
    'prescription_id': 77,
    'linked_prescription_count': 1,
    'prescription_medications': [
      {'catalog_id': 17, 'name': 'Medicine $id', 'quantity': 1},
    ],
    'created_at': '2026-08-29T08:00:00.000Z',
    'updated_at': '2026-08-29T08:00:00.000Z',
    'mins_since_placed': 5,
    'sla_breached': false,
  };

  http.Response ok(Object data, {Map<String, dynamic>? meta}) => http.Response(
    jsonEncode({'success': true, 'data': data, if (meta != null) 'meta': meta}),
    200,
    headers: {'content-type': 'application/json'},
  );

  Future<void> pumpQueue(
    WidgetTester tester, {
    required String role,
    required List<Map<String, dynamic>> orders,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1200, 2200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    FlutterSecureStorage.setMockInitialValues({'staff_role': role});
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/pharmacy-orders/orders/queue')) {
          return ok({'orders': orders});
        }
        if (path.endsWith('/pharmacy-orders/catalog')) {
          return ok({'catalog': <Object>[]});
        }
        if (path.endsWith('/pharmacy/inventory/v2/items')) {
          return ok({'items': <Object>[]});
        }
        if (path.endsWith('/pharmacy/inventory/v2/expiry-alerts')) {
          return ok({'alerts': <Object>[]});
        }
        if (path.endsWith('/pharmacy-orders/ward-indents')) {
          return ok(
            {'indents': <Object>[]},
            meta: {
              'pagination': {'has_more': false},
            },
          );
        }
        return ok(<String, dynamic>{});
      }),
    );

    await tester.pumpWidget(const MaterialApp(home: PharmacyScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.byType(Tab).at(1));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'production screen lets pharmacy staff verify or reject but never override',
    (tester) async {
      await pumpQueue(tester, role: 'PHARMACY_STAFF', orders: [order(id: 91)]);

      await tester.tap(find.text('Verify order'));
      await tester.pumpAndSettle();
      final decision = tester.widget<DropdownButtonFormField<String>>(
        find.byKey(const ValueKey('pharmacy-verification-decision')),
      );
      expect(decision.items!.map((item) => item.value), [
        'verified',
        'rejected',
      ]);
    },
  );

  testWidgets(
    'production screen makes incharge override a documented break-glass act',
    (tester) async {
      await pumpQueue(
        tester,
        role: 'PHARMACY_INCHARGE',
        orders: [order(id: 92)],
      );

      await tester.tap(find.text('Verify order'));
      await tester.pumpAndSettle();
      final decision = tester.widget<DropdownButtonFormField<String>>(
        find.byKey(const ValueKey('pharmacy-verification-decision')),
      );
      expect(decision.items!.map((item) => item.value), [
        'verified',
        'override',
        'rejected',
      ]);
      decision.onChanged!('override');
      await tester.pump();
      expect(
        find.byKey(
          const ValueKey('pharmacy-verification-manual-allergy-review'),
        ),
        findsOneWidget,
      );
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const ValueKey('pharmacy-verification-submit')),
            )
            .onPressed,
        isNull,
      );
    },
  );

  testWidgets('administrator oversight cannot make a clinical decision', (
    tester,
  ) async {
    await pumpQueue(
      tester,
      role: 'ADMIN',
      orders: [order(id: 93, fundingRecovery: true)],
    );

    expect(find.text('Verify order'), findsNothing);
    expect(find.textContaining('Funding task TPA-93'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('pharmacy-funding-recovery-TPA-93')),
      findsOneWidget,
    );
  });

  testWidgets(
    'pharmacy role sees owned TPA task evidence without billing authority',
    (tester) async {
      await pumpQueue(
        tester,
        role: 'PHARMACY_STAFF',
        orders: [order(id: 94, fundingRecovery: true, fundingDeepLink: false)],
      );

      expect(find.textContaining('Funding task TPA-94'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('pharmacy-funding-recovery-TPA-94')),
        findsNothing,
      );
    },
  );

  testWidgets(
    'production queue exposes every governed recovery and dispense closure',
    (tester) async {
      await pumpQueue(
        tester,
        role: 'PHARMACY_INCHARGE',
        orders: [
          order(id: 101, facilityRecovery: true),
          order(id: 102, lineRecovery: true),
          order(id: 103, verification: 'verified'),
          order(
            id: 104,
            status: 'PARTIALLY_DISPENSED',
            verification: 'verified',
          ),
          order(
            id: 105,
            status: 'DISPATCHED',
            deliveryType: 'delivery',
            verification: 'verified',
          ),
        ],
      );

      expect(find.text('Assign pharmacy facility'), findsOneWidget);
      expect(find.text('Resolve prescription lines'), findsOneWidget);
      expect(find.text('Complete counter dispense'), findsOneWidget);
      expect(find.text('Dispense remaining quantity'), findsOneWidget);
      expect(find.text('Mark Delivered'), findsOneWidget);
      expect(find.text('Mark unavailable'), findsWidgets);
      expect(find.text('Cancel'), findsWidgets);
    },
  );
}
