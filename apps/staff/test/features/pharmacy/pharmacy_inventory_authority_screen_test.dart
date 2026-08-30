import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/pharmacy/screens/pharmacy_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    // ThemeProvider hydrates its persisted mode from SharedPreferences the
    // moment it is constructed, so the store has to exist before the widget
    // tree that owns it is pumped.
    SharedPreferences.setMockInitialValues({});
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
    jsonEncode({'success': true, 'data': data, 'meta': ?meta}),
    200,
    headers: {'content-type': 'application/json'},
  );

  Future<void> pumpQueue(
    WidgetTester tester, {
    required String role,
    required List<Map<String, dynamic>> orders,
    Future<http.Response?> Function(http.Request request)? onRequest,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1200, 2200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    FlutterSecureStorage.setMockInitialValues({'staff_role': role});
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        final override = onRequest == null ? null : await onRequest(request);
        if (override != null) return override;
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

    // PharmacyScreen renders through StaffScaffold, whose app bar carries
    // ThemeToggleAction — a Consumer<ThemeProvider>. main.dart supplies that
    // provider above every route, so the harness has to do the same or the
    // whole scaffold is replaced by an error widget before a single queue
    // assertion runs.
    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ThemeProvider(),
        child: const MaterialApp(home: PharmacyScreen()),
      ),
    );
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
      // Flutter 3.47's DropdownButtonFormField no longer exposes `items`:
      // it builds an inner DropdownButton via _formField carrying the same
      // list, and that button's onChanged routes through didChange back to
      // the field's own onChanged. Read both off the inner button so this
      // authority assertion keeps its exact meaning.
      final decision = tester.widget<DropdownButton<String>>(
        find.descendant(
          of: find.byKey(const ValueKey('pharmacy-verification-decision')),
          matching: find.byType(DropdownButton<String>),
        ),
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
      // Flutter 3.47's DropdownButtonFormField no longer exposes `items`:
      // it builds an inner DropdownButton via _formField carrying the same
      // list, and that button's onChanged routes through didChange back to
      // the field's own onChanged. Read both off the inner button so this
      // authority assertion keeps its exact meaning.
      final decision = tester.widget<DropdownButton<String>>(
        find.descendant(
          of: find.byKey(const ValueKey('pharmacy-verification-decision')),
          matching: find.byType(DropdownButton<String>),
        ),
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

  testWidgets(
    'controlled counter dispense closes through exact allocation and independent witness',
    (tester) async {
      var dispenseCalls = 0;
      var witnessRequestCalls = 0;
      var witnessApprovalCalls = 0;
      Map<String, dynamic>? completedPayload;
      await pumpQueue(
        tester,
        role: 'PHARMACY_STAFF',
        orders: [order(id: 201, verification: 'verified')],
        onRequest: (request) async {
          final path = request.url.path;
          if (path.endsWith('/orders/201/dispense-counter')) {
            dispenseCalls += 1;
            if (dispenseCalls == 1) {
              return http.Response(
                jsonEncode({
                  'success': false,
                  'code': 'PHARMACY_ORDER_CONTROLLED_ALLOCATION_REQUIRED',
                  'message': 'Exact controlled allocation required',
                  'details': {
                    'facility_id': 8,
                    'order_line_index': 0,
                    'recovery_action': {
                      'witness_required': true,
                      'request_shape': {
                        'dispensed_items': [
                          {
                            'order_line_index': 0,
                            'catalog_id': 17,
                            'inventory_item_id': 71,
                            'inventory_allocations': [
                              {
                                'inventory_batch_id': 'required',
                                'quantity': 1,
                                'witness_approval_id': 'required',
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                }),
                409,
                headers: {'content-type': 'application/json'},
              );
            }
            completedPayload = Map<String, dynamic>.from(
              jsonDecode(request.body) as Map,
            );
            return ok({'status': 'DISPENSED'});
          }
          if (path.endsWith('/pharmacy/inventory/v2/batches')) {
            expect(request.url.queryParameters['facility_id'], '8');
            return ok({
              'batches': [
                {
                  'id': 501,
                  'inventory_item_id': 71,
                  'facility_id': 8,
                  'batch_number': 'SX-501',
                  'lot_number': 'LOT-501',
                  'expiry_date': '2027-08-30',
                  'remaining_quantity': 3,
                  'status': 'in_stock',
                  'schedule_class': 'X',
                  'is_narcotic': true,
                },
              ],
            });
          }
          if (path.endsWith('/controlled-dispense/witness-approvals')) {
            witnessRequestCalls += 1;
            return ok({'id': '91'});
          }
          if (path.endsWith(
            '/controlled-dispense/witness-approvals/91/approve',
          )) {
            witnessApprovalCalls += 1;
            final body = Map<String, dynamic>.from(
              jsonDecode(request.body) as Map,
            );
            expect(body['employeeId'], 'NURSE-002');
            expect(body['password'], 'witness-secret');
            return ok({
              'id': '91',
              'witness': {'name': 'Independent Nurse'},
            });
          }
          return null;
        },
      );

      await tester.tap(find.text('Complete counter dispense'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('pharmacy-counter-complete-submit')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('pharmacy-delivery-controlled-batch-501')),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const ValueKey('pharmacy-delivery-witness-employee-id')),
        'NURSE-002',
      );
      await tester.enterText(
        find.byKey(const ValueKey('pharmacy-delivery-witness-password')),
        'witness-secret',
      );
      await tester.tap(
        find.byKey(const ValueKey('pharmacy-delivery-controlled-confirm')),
      );
      await tester.pumpAndSettle();

      expect(dispenseCalls, 2);
      expect(witnessRequestCalls, 1);
      expect(witnessApprovalCalls, 1);
      final lines = completedPayload!['dispensed_items'] as List;
      final line = Map<String, dynamic>.from(lines.single as Map);
      final batch = Map<String, dynamic>.from(
        (line['inventory_allocations'] as List).single as Map,
      );
      expect(line['inventory_item_id'], 71);
      expect(batch, {
        'inventory_batch_id': 501,
        'quantity': 1,
        'witness_approval_id': '91',
      });
    },
  );

  testWidgets(
    'controlled counter recovery cancellation records no witness or stock mutation',
    (tester) async {
      var dispenseCalls = 0;
      var witnessCalls = 0;
      await pumpQueue(
        tester,
        role: 'PHARMACY_STAFF',
        orders: [order(id: 202, verification: 'verified')],
        onRequest: (request) async {
          final path = request.url.path;
          if (path.endsWith('/orders/202/dispense-counter')) {
            dispenseCalls += 1;
            return http.Response(
              jsonEncode({
                'success': false,
                'code': 'PHARMACY_ORDER_CONTROLLED_ALLOCATION_REQUIRED',
                'message': 'Exact controlled allocation required',
                'details': {
                  'facility_id': 8,
                  'order_line_index': 0,
                  'recovery_action': {
                    'witness_required': true,
                    'request_shape': {
                      'dispensed_items': [
                        {
                          'order_line_index': 0,
                          'catalog_id': 17,
                          'inventory_item_id': 71,
                          'inventory_allocations': [
                            {
                              'inventory_batch_id': 'required',
                              'quantity': 1,
                              'witness_approval_id': 'required',
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              }),
              409,
              headers: {'content-type': 'application/json'},
            );
          }
          if (path.endsWith('/pharmacy/inventory/v2/batches')) {
            return ok({
              'batches': [
                {
                  'id': 502,
                  'expiry_date': '2027-08-30',
                  'remaining_quantity': 2,
                  'batch_number': 'SX-502',
                },
              ],
            });
          }
          if (path.contains('witness-approvals')) witnessCalls += 1;
          return null;
        },
      );

      await tester.tap(find.text('Complete counter dispense'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('pharmacy-counter-complete-submit')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel').last);
      await tester.pumpAndSettle();

      expect(dispenseCalls, 1);
      expect(witnessCalls, 0);
      expect(find.text('Counter dispense complete'), findsNothing);
    },
  );

  testWidgets(
    'controlled counter recovery fails closed when batch authority is refused',
    (tester) async {
      var dispenseCalls = 0;
      var witnessCalls = 0;
      await pumpQueue(
        tester,
        role: 'PHARMACY_STAFF',
        orders: [order(id: 203, verification: 'verified')],
        onRequest: (request) async {
          final path = request.url.path;
          if (path.endsWith('/orders/203/dispense-counter')) {
            dispenseCalls += 1;
            return http.Response(
              jsonEncode({
                'success': false,
                'code': 'PHARMACY_ORDER_CONTROLLED_ALLOCATION_REQUIRED',
                'message': 'Exact controlled allocation required',
                'details': {
                  'facility_id': 8,
                  'order_line_index': 0,
                  'recovery_action': {
                    'witness_required': true,
                    'request_shape': {
                      'dispensed_items': [
                        {
                          'order_line_index': 0,
                          'catalog_id': 17,
                          'inventory_item_id': 71,
                          'inventory_allocations': [
                            {
                              'inventory_batch_id': 'required',
                              'quantity': 1,
                              'witness_approval_id': 'required',
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              }),
              409,
              headers: {'content-type': 'application/json'},
            );
          }
          if (path.endsWith('/pharmacy/inventory/v2/batches')) {
            return http.Response(
              jsonEncode({
                'success': false,
                'code': 'PHARMACY_FACILITY_GRANT_REQUIRED',
                'message': 'The active facility grant was revoked',
              }),
              403,
              headers: {'content-type': 'application/json'},
            );
          }
          if (path.contains('witness-approvals')) witnessCalls += 1;
          return null;
        },
      );

      await tester.tap(find.text('Complete counter dispense'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('pharmacy-counter-complete-submit')),
      );
      await tester.pumpAndSettle();

      expect(dispenseCalls, 1);
      expect(witnessCalls, 0);
      expect(find.textContaining('facility grant was revoked'), findsOneWidget);
      expect(find.text('Counter dispense complete'), findsNothing);
    },
  );
}
