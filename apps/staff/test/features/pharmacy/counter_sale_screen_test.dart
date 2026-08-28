import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_staff/features/pharmacy/screens/counter_sale_screen.dart';

Map<String, dynamic> _item({
  int id = 1,
  String name = 'Paracetamol 500',
  String? schedule,
  bool narcotic = false,
  num stock = 40,
  num? price = 10.5,
}) {
  return {
    'id': id,
    'sku_code': 'SKU-$id',
    'display_name': name,
    'schedule_class': schedule,
    'is_narcotic': narcotic,
    'in_stock_quantity': stock,
    'fefo_batch_id': 7,
    'fefo_batch_number': 'B-77',
    'fefo_expiry_date': '2027-01-31',
    'fefo_unit_price': price,
  };
}

Widget _screen({
  CounterSaleItemSearcher? searchItems,
  CounterSaleCreator? createSale,
  CounterSaleWitnessApprovalRequester? requestWitnessApproval,
  CounterSaleWitnessApprovalApprover? approveWitnessApproval,
  CounterSaleLister? listSales,
  CounterSaleVoider? voidSale,
  CounterSaleGetter? getSale,
  CounterSaleVoidStatusGetter? getVoidStatus,
  CounterSaleVoidReconciler? reconcileVoid,
  CounterSaleRejectedVoidResolver? resolveRejectedVoid,
  String? initialSaleId,
}) {
  return MaterialApp(
    home: CounterSaleScreen(
      searchItems: searchItems ?? ({String? search}) async => [_item()],
      createSale:
          createSale ??
          ({
            required List<Map<String, dynamic>> lines,
            String? patientUid,
            String? customerName,
            String? customerPhone,
            Map<String, dynamic>? rx,
            String? witnessApprovalId,
            required String paymentMode,
            String? paymentReference,
            String? notes,
            required String idempotencyKey,
          }) async => {
            'sale': {'id': '1', 'status': 'COMPLETED'},
            'invoice': {'invoice_number': 'INV-2026-000001'},
          },
      requestWitnessApproval: requestWitnessApproval,
      approveWitnessApproval: approveWitnessApproval,
      listSales: listSales ?? ({String? status, String? date}) async => [],
      voidSale:
          voidSale ??
          (id, reason, {required disposition, required idempotencyKey}) async =>
              {
                'sale': {'id': id, 'status': 'VOID_PENDING_REFUND'},
              },
      getSale: getSale,
      getVoidStatus:
          getVoidStatus ??
          (id) async => {
            'workflow_status': 'AWAITING_FINANCE_APPROVAL',
            'sale': {'id': id, 'status': 'VOID_PENDING_REFUND'},
          },
      reconcileVoid: reconcileVoid,
      resolveRejectedVoid: resolveRejectedVoid,
      initialSaleId: initialSaleId,
    ),
  );
}

/// The sell tab is a lazy ListView; grow the surface so every section
/// (customer, rx, witness, sell button) is built during the test.
void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1000, 3200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

Future<void> _addFirstResult(WidgetTester tester) async {
  await tester.enterText(
    find.byKey(const ValueKey('counter-sale-search')),
    'para',
  );
  await tester.testTextInput.receiveAction(TextInputAction.done);
  await tester.pumpAndSettle();
  await tester.tap(find.byIcon(Icons.add_circle_outline).first);
  await tester.pumpAndSettle();
  // Quantity dialog: confirm the default of 1.
  await tester.tap(find.byType(FilledButton).last);
  await tester.pumpAndSettle();
}

Future<void> _pumpWitnessDialog(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

Future<void> _prepareOtcSale(WidgetTester tester) async {
  await _addFirstResult(tester);
  await tester.enterText(
    find.byKey(const ValueKey('counter-sale-customer-name')),
    'Walk-in Customer',
  );
  await tester.ensureVisible(find.byKey(const ValueKey('counter-sale-sell')));
}

Future<void> _pumpUntil(WidgetTester tester, bool Function() condition) async {
  for (var i = 0; i < 20 && !condition(); i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  setUp(() async {
    await ConnectivitySyncService.instance.resetForTesting();
    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.available,
      continuity: ContinuityLifecycleState.readyInternal,
    );
  });

  tearDown(() async {
    await ConnectivitySyncService.instance.resetForTesting();
  });

  testWidgets('search shows FEFO batch, expiry, stock and price', (
    tester,
  ) async {
    _useTallViewport(tester);
    await tester.pumpWidget(_screen());
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-search')),
      'para',
    );
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();

    expect(find.text('Paracetamol 500'), findsOneWidget);
    expect(find.textContaining('40 in stock'), findsOneWidget);
    expect(find.textContaining('B-77'), findsOneWidget);
    expect(find.textContaining('2027-01-31'), findsOneWidget);
    expect(find.textContaining('₹10.50'), findsOneWidget);
  });

  testWidgets('OTC cart shows no rx/witness sections and sells', (
    tester,
  ) async {
    List<Map<String, dynamic>>? sentLines;
    String? sentMode;
    String? sentCustomer;
    _useTallViewport(tester);
    await tester.pumpWidget(
      _screen(
        createSale:
            ({
              required List<Map<String, dynamic>> lines,
              String? patientUid,
              String? customerName,
              String? customerPhone,
              Map<String, dynamic>? rx,
              String? witnessApprovalId,
              required String paymentMode,
              String? paymentReference,
              String? notes,
              required String idempotencyKey,
            }) async {
              sentLines = lines;
              sentMode = paymentMode;
              sentCustomer = customerName;
              return {
                'sale': {'id': '9', 'status': 'COMPLETED'},
                'invoice': {'invoice_number': 'INV-2026-000042'},
              };
            },
      ),
    );
    await tester.pumpAndSettle();
    await _addFirstResult(tester);

    expect(find.byKey(const ValueKey('counter-sale-rx')), findsNothing);
    expect(find.byKey(const ValueKey('counter-sale-witness')), findsNothing);

    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-customer-name')),
      'Walk-in Customer',
    );
    await tester.ensureVisible(find.byKey(const ValueKey('counter-sale-sell')));
    await tester.tap(find.byKey(const ValueKey('counter-sale-sell')));
    await tester.pumpAndSettle();

    expect(sentLines, hasLength(1));
    expect(sentLines!.first['inventory_item_id'], 1);
    expect(sentMode, 'CASH');
    expect(sentCustomer, 'Walk-in Customer');
    expect(find.textContaining('INV-2026-000042'), findsOneWidget);
  });

  testWidgets(
    'scheduled narcotic item reveals prescription and witness capture',
    (tester) async {
      _useTallViewport(tester);
      await tester.pumpWidget(
        _screen(
          searchItems: ({String? search}) async => [
            _item(name: 'Morphine 10', schedule: 'X', narcotic: true),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await _addFirstResult(tester);

      expect(find.byKey(const ValueKey('counter-sale-rx')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('counter-sale-witness')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('counter-sale-witness-request')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('counter-sale-witness-employee-id')),
        findsNothing,
      );
    },
  );

  testWidgets(
    'controlled sale requires an independently authenticated approval for the unchanged payload',
    (tester) async {
      Map<String, dynamic>? requestedSale;
      Map<String, dynamic>? approvedSale;
      String? witnessEmployeeId;
      String? witnessPassword;
      String? witnessRequestIdempotencyKey;
      String? witnessApprovalIdempotencyKey;
      String? submittedApprovalId;
      _useTallViewport(tester);
      await tester.pumpWidget(
        _screen(
          searchItems: ({String? search}) async => [
            _item(name: 'Morphine 10', schedule: 'X', narcotic: true),
          ],
          requestWitnessApproval:
              ({required sale, required idempotencyKey}) async {
                requestedSale = Map<String, dynamic>.from(sale);
                witnessRequestIdempotencyKey = idempotencyKey;
                return {'id': '71', 'status': 'pending'};
              },
          approveWitnessApproval:
              ({
                required approvalId,
                required sale,
                required employeeId,
                required password,
                required idempotencyKey,
              }) async {
                expect(approvalId, '71');
                approvedSale = Map<String, dynamic>.from(sale);
                witnessEmployeeId = employeeId;
                witnessPassword = password;
                witnessApprovalIdempotencyKey = idempotencyKey;
                return {
                  'id': '71',
                  'status': 'approved',
                  'witness': {'name': 'Canonical Nurse'},
                };
              },
          createSale:
              ({
                required lines,
                patientUid,
                customerName,
                customerPhone,
                rx,
                witnessApprovalId,
                required paymentMode,
                paymentReference,
                notes,
                required idempotencyKey,
              }) async {
                submittedApprovalId = witnessApprovalId;
                return {
                  'sale': {'id': '9', 'status': 'COMPLETED'},
                  'invoice': {'invoice_number': 'INV-2026-000043'},
                };
              },
        ),
      );
      await tester.pumpAndSettle();
      await _addFirstResult(tester);
      await tester.enterText(
        find.byKey(const ValueKey('counter-sale-customer-name')),
        'Walk-in Customer',
      );
      await tester.enterText(find.byType(TextField).at(2), '9876543210');
      await tester.enterText(find.byType(TextField).at(3), 'Dr Rao');
      await tester.enterText(find.byType(TextField).at(4), 'RX-77');

      final sellButton = tester.widget<FilledButton>(
        find.byKey(const ValueKey('counter-sale-sell')),
      );
      expect(sellButton.onPressed, isNull);

      await tester.ensureVisible(
        find.byKey(const ValueKey('counter-sale-witness-request')),
      );
      await tester.tap(
        find.byKey(const ValueKey('counter-sale-witness-request')),
      );
      await _pumpWitnessDialog(tester);
      await tester.enterText(
        find.byKey(const ValueKey('counter-sale-witness-employee-id')),
        'nurse-002',
      );
      await tester.enterText(
        find.byKey(const ValueKey('counter-sale-witness-password')),
        'witness-secret',
      );
      await tester.tap(
        find.byKey(const ValueKey('counter-sale-witness-approve-submit')),
      );
      await tester.pumpAndSettle();

      expect(witnessEmployeeId, 'NURSE-002');
      expect(witnessPassword, 'witness-secret');
      expect(
        witnessRequestIdempotencyKey,
        startsWith('counter-sale-witness-request:'),
      );
      expect(
        witnessApprovalIdempotencyKey,
        startsWith('counter-sale-witness-approval:'),
      );
      expect(
        witnessApprovalIdempotencyKey,
        isNot(witnessRequestIdempotencyKey),
      );
      expect(approvedSale, requestedSale);
      expect(find.text('Approved by Canonical Nurse'), findsOneWidget);
      expect(find.text('witness-secret'), findsNothing);

      await tester.ensureVisible(
        find.byKey(const ValueKey('counter-sale-sell')),
      );
      await tester.tap(find.byKey(const ValueKey('counter-sale-sell')));
      await tester.pumpAndSettle();
      expect(submittedApprovalId, '71');
    },
  );

  testWidgets('changing the sale invalidates an approved witness id', (
    tester,
  ) async {
    _useTallViewport(tester);
    await tester.pumpWidget(
      _screen(
        searchItems: ({String? search}) async => [
          _item(name: 'Morphine 10', schedule: 'X', narcotic: true),
        ],
        requestWitnessApproval: ({
          required sale,
          required idempotencyKey,
        }) async => {'id': '72'},
        approveWitnessApproval:
            ({
              required approvalId,
              required sale,
              required employeeId,
              required password,
              required idempotencyKey,
            }) async => {
              'id': '72',
              'status': 'approved',
              'witness': {'name': 'Canonical Nurse'},
            },
      ),
    );
    await tester.pumpAndSettle();
    await _addFirstResult(tester);
    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-customer-name')),
      'Walk-in Customer',
    );
    await tester.ensureVisible(
      find.byKey(const ValueKey('counter-sale-witness-request')),
    );
    await tester.tap(
      find.byKey(const ValueKey('counter-sale-witness-request')),
    );
    await _pumpWitnessDialog(tester);
    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-witness-employee-id')),
      'NURSE-002',
    );
    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-witness-password')),
      'witness-secret',
    );
    await tester.tap(
      find.byKey(const ValueKey('counter-sale-witness-approve-submit')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Approved by Canonical Nurse'), findsOneWidget);

    await tester.enterText(find.byType(TextField).at(4), 'RX-CHANGED');
    await tester.pump();
    expect(find.text('Approval not requested'), findsOneWidget);
    final sellButton = tester.widget<FilledButton>(
      find.byKey(const ValueKey('counter-sale-sell')),
    );
    expect(sellButton.onPressed, isNull);
  });

  testWidgets(
    'manual retry reuses the witness request key after an indeterminate lost response',
    (tester) async {
      final requestKeys = <String>[];
      _useTallViewport(tester);
      await tester.pumpWidget(
        _screen(
          searchItems: ({String? search}) async => [
            _item(name: 'Morphine 10', schedule: 'X', narcotic: true),
          ],
          requestWitnessApproval:
              ({required sale, required idempotencyKey}) async {
                requestKeys.add(idempotencyKey);
                if (requestKeys.length == 1) {
                  throw Exception('response lost after durable write');
                }
                return {'id': '81', 'status': 'pending'};
              },
        ),
      );
      await tester.pumpAndSettle();
      await _addFirstResult(tester);

      final witnessButton = find.byKey(
        const ValueKey('counter-sale-witness-request'),
      );
      await tester.ensureVisible(witnessButton);
      await tester.tap(witnessButton);
      await tester.pumpAndSettle();
      await tester.tap(witnessButton);
      await _pumpWitnessDialog(tester);

      expect(requestKeys, hasLength(2));
      expect(requestKeys[1], requestKeys[0]);
      expect(
        find.byKey(const ValueKey('counter-sale-witness-employee-id')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'manual retry reuses an indeterminate approval key but rotates after a credential rejection',
    (tester) async {
      final approvalKeys = <String>[];
      var approvalAttempt = 0;
      _useTallViewport(tester);
      await tester.pumpWidget(
        _screen(
          searchItems: ({String? search}) async => [
            _item(name: 'Morphine 10', schedule: 'X', narcotic: true),
          ],
          requestWitnessApproval: ({
            required sale,
            required idempotencyKey,
          }) async => {'id': '82', 'status': 'pending'},
          approveWitnessApproval:
              ({
                required approvalId,
                required sale,
                required employeeId,
                required password,
                required idempotencyKey,
              }) async {
                approvalAttempt += 1;
                approvalKeys.add(idempotencyKey);
                if (approvalAttempt == 1) {
                  throw Exception('response lost after durable write');
                }
                if (approvalAttempt == 2) {
                  throw Exception('Invalid employee ID or password');
                }
                return {
                  'id': '82',
                  'status': 'approved',
                  'witness': {'name': 'Canonical Nurse'},
                };
              },
        ),
      );
      await tester.pumpAndSettle();
      await _addFirstResult(tester);

      Future<void> submitWitnessCredentials() async {
        await tester.tap(
          find.byKey(const ValueKey('counter-sale-witness-request')),
        );
        await _pumpWitnessDialog(tester);
        await tester.enterText(
          find.byKey(const ValueKey('counter-sale-witness-employee-id')),
          'NURSE-002',
        );
        await tester.enterText(
          find.byKey(const ValueKey('counter-sale-witness-password')),
          'witness-secret',
        );
        await tester.tap(
          find.byKey(const ValueKey('counter-sale-witness-approve-submit')),
        );
        await tester.pumpAndSettle();
      }

      await tester.ensureVisible(
        find.byKey(const ValueKey('counter-sale-witness-request')),
      );
      await submitWitnessCredentials();
      await submitWitnessCredentials();
      await submitWitnessCredentials();

      expect(approvalKeys, hasLength(3));
      expect(approvalKeys[1], approvalKeys[0]);
      expect(approvalKeys[2], isNot(approvalKeys[1]));
      expect(find.text('Approved by Canonical Nurse'), findsOneWidget);
    },
  );

  testWidgets('recent tab lists sales and voids with a reason', (tester) async {
    String? voidedId;
    String? voidedReason;
    String? voidedDisposition;
    String? voidIdempotencyKey;
    await tester.pumpWidget(
      _screen(
        listSales: ({String? status, String? date}) async => [
          {
            'id': '5',
            'status': 'COMPLETED',
            'void_readiness': 'READY',
            'invoice_number': 'INV-2026-000005',
            'customer_name': 'Walk-in Customer',
            'total_amount': 651,
            'payment_mode': 'CASH',
          },
        ],
        voidSale:
            (
              id,
              reason, {
              required disposition,
              required idempotencyKey,
            }) async {
              voidedId = id;
              voidedReason = reason;
              voidedDisposition = disposition;
              voidIdempotencyKey = idempotencyKey;
              return {
                'sale': {'id': id, 'status': 'VOID_PENDING_REFUND'},
              };
            },
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Recent sales'));
    await tester.pumpAndSettle();
    expect(find.textContaining('INV-2026-000005'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('counter-sale-void-5')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('counter-sale-void-disposition')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Never handed to the patient').last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-void-reason')),
      'Cancelled before handoff',
    );
    await tester.pump();
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.ensureVisible(
      find.byKey(const ValueKey('counter-sale-void-submit')),
    );
    tester
        .widget<FilledButton>(
          find.byKey(const ValueKey('counter-sale-void-submit')),
        )
        .onPressed!();
    await tester.pumpAndSettle();
    await _pumpUntil(tester, () => voidedId != null);
    await tester.pumpAndSettle();

    expect(voidedId, '5');
    expect(voidedReason, 'Cancelled before handoff');
    expect(voidedDisposition, 'NEVER_HANDED_OVER');
    expect(voidIdempotencyKey, startsWith('counter-sale-5-void:'));
    expect(find.text('Awaiting independent finance approval'), findsOneWidget);
  });

  testWidgets('lost create response retries with the same protected key', (
    tester,
  ) async {
    _useTallViewport(tester);
    final keys = <String>[];
    var calls = 0;
    await tester.pumpWidget(
      _screen(
        createSale:
            ({
              required lines,
              patientUid,
              customerName,
              customerPhone,
              rx,
              witnessApprovalId,
              required paymentMode,
              paymentReference,
              notes,
              required idempotencyKey,
            }) async {
              keys.add(idempotencyKey);
              calls++;
              if (calls == 1) throw Exception('response lost after write');
              return {
                'sale': {'id': '19', 'status': 'COMPLETED'},
                'invoice': {'invoice_number': 'INV-19'},
              };
            },
      ),
    );
    await tester.pumpAndSettle();
    await _prepareOtcSale(tester);

    tester
        .widget<FilledButton>(find.byKey(const ValueKey('counter-sale-sell')))
        .onPressed!();
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('counter-sale-ambiguous-sale')),
      findsOneWidget,
    );

    tester
        .widget<FilledButton>(find.byKey(const ValueKey('counter-sale-sell')))
        .onPressed!();
    await tester.pumpAndSettle();
    expect(keys, hasLength(2));
    expect(keys[1], keys[0]);
  });

  testWidgets('changed payload requires acknowledgement and a new create key', (
    tester,
  ) async {
    _useTallViewport(tester);
    final keys = <String>[];
    var calls = 0;
    await tester.pumpWidget(
      _screen(
        createSale:
            ({
              required lines,
              patientUid,
              customerName,
              customerPhone,
              rx,
              witnessApprovalId,
              required paymentMode,
              paymentReference,
              notes,
              required idempotencyKey,
            }) async {
              keys.add(idempotencyKey);
              calls++;
              if (calls == 1) throw Exception('response lost after write');
              return {
                'sale': {'id': '20', 'status': 'COMPLETED'},
                'invoice': {'invoice_number': 'INV-20'},
              };
            },
      ),
    );
    await tester.pumpAndSettle();
    await _prepareOtcSale(tester);
    await tester.tap(find.byKey(const ValueKey('counter-sale-sell')));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-customer-name')),
      'Different Customer',
    );
    await tester.tap(find.byKey(const ValueKey('counter-sale-sell')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('counter-sale-new-attempt-confirm')),
      findsOneWidget,
    );
    await tester.tap(
      find.byKey(const ValueKey('counter-sale-new-attempt-confirm')),
    );
    await tester.pumpAndSettle();

    expect(keys, hasLength(2));
    expect(keys[1], isNot(keys[0]));
  });

  testWidgets('non-cash sale is blocked until original reference is present', (
    tester,
  ) async {
    _useTallViewport(tester);
    String? sentReference;
    await tester.pumpWidget(
      _screen(
        createSale:
            ({
              required lines,
              patientUid,
              customerName,
              customerPhone,
              rx,
              witnessApprovalId,
              required paymentMode,
              paymentReference,
              notes,
              required idempotencyKey,
            }) async {
              sentReference = paymentReference;
              return {
                'sale': {'id': '21', 'status': 'COMPLETED'},
                'invoice': {'invoice_number': 'INV-21'},
              };
            },
      ),
    );
    await tester.pumpAndSettle();
    await _prepareOtcSale(tester);
    await tester.tap(find.byKey(const ValueKey('counter-sale-payment-mode')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('UPI').last);
    await tester.pumpAndSettle();

    expect(
      tester
          .widget<FilledButton>(find.byKey(const ValueKey('counter-sale-sell')))
          .onPressed,
      isNull,
    );
    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-payment-reference')),
      'UPI-ORIGINAL-21',
    );
    await tester.pump();
    await tester.ensureVisible(find.byKey(const ValueKey('counter-sale-sell')));
    tester
        .widget<FilledButton>(find.byKey(const ValueKey('counter-sale-sell')))
        .onPressed!();
    await tester.pumpAndSettle();
    await _pumpUntil(tester, () => sentReference != null);
    expect(sentReference, 'UPI-ORIGINAL-21');
  });

  testWidgets('patient-returned custody outcome blocks void locally', (
    tester,
  ) async {
    var calls = 0;
    await tester.pumpWidget(
      _screen(
        listSales: ({String? status, String? date}) async => [
          {
            'id': '22',
            'status': 'COMPLETED',
            'void_readiness': 'READY',
            'payment_mode': 'CASH',
          },
        ],
        voidSale:
            (
              id,
              reason, {
              required disposition,
              required idempotencyKey,
            }) async {
              calls++;
              return {};
            },
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Recent sales'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('counter-sale-void-22')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('counter-sale-void-disposition')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Returned after patient handling').last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-void-reason')),
      'Returned at counter',
    );
    await tester.pump();

    expect(
      find.textContaining('cannot re-enter sellable stock'),
      findsOneWidget,
    );
    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const ValueKey('counter-sale-void-submit')),
          )
          .onPressed,
      isNull,
    );
    expect(calls, 0);
  });

  testWidgets('lost void response retries with the same protected key', (
    tester,
  ) async {
    final keys = <String>[];
    var calls = 0;
    await tester.pumpWidget(
      _screen(
        listSales: ({String? status, String? date}) async => [
          {
            'id': '23',
            'status': 'COMPLETED',
            'void_readiness': 'READY',
            'payment_mode': 'CASH',
          },
        ],
        voidSale:
            (
              id,
              reason, {
              required disposition,
              required idempotencyKey,
            }) async {
              keys.add(idempotencyKey);
              calls++;
              if (calls == 1) throw Exception('lost response');
              return {
                'sale': {'id': id, 'status': 'VOID_PENDING_REFUND'},
              };
            },
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Recent sales'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('counter-sale-void-23')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('counter-sale-void-disposition')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Never handed to the patient').last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('counter-sale-void-reason')),
      'Cancelled before handoff',
    );
    await tester.pump();
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.ensureVisible(
      find.byKey(const ValueKey('counter-sale-void-submit')),
    );
    tester
        .widget<FilledButton>(
          find.byKey(const ValueKey('counter-sale-void-submit')),
        )
        .onPressed!();
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('counter-sale-void-23')));
    await tester.pumpAndSettle();
    tester
        .widget<FilledButton>(
          find.byKey(const ValueKey('counter-sale-void-submit')),
        )
        .onPressed!();
    await tester.pumpAndSettle();
    expect(keys, hasLength(2));
    expect(keys[1], keys[0]);
  });

  testWidgets('authoritative readiness blocks an ineligible void', (
    tester,
  ) async {
    await tester.pumpWidget(
      _screen(
        listSales: ({String? status, String? date}) async => [
          {
            'id': '24',
            'status': 'COMPLETED',
            'void_readiness': 'OUTSIDE_SAME_DAY_WINDOW',
            'payment_mode': 'CASH',
          },
        ],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Recent sales'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('counter-sale-void-24')), findsNothing);
    expect(
      find.textContaining('same-day void window has closed'),
      findsOneWidget,
    );
  });

  testWidgets(
    'refund rejection resolution reuses its key and refreshes terminal state',
    (tester) async {
      final keys = <String>[];
      var calls = 0;
      await tester.pumpWidget(
        _screen(
          listSales: ({String? status, String? date}) async => [
            {
              'id': '25',
              'status': 'VOID_PENDING_REFUND',
              'void_readiness': 'PENDING_REFUND',
              'void_request_id': '125',
              'void_request_status': 'REFUND_REJECTED_REVIEW',
              'void_refund_id': '225',
              'void_refund_status': 'REJECTED',
              'payment_mode': 'CASH',
            },
          ],
          resolveRejectedVoid:
              (id, {required reason, required idempotencyKey}) async {
                keys.add(idempotencyKey);
                calls++;
                if (calls == 1) throw Exception('response lost');
                return {'outcome': 'handover_confirmed'};
              },
          getVoidStatus: (id) async => {
            'workflow_status': 'CANCELLED_HANDOVER_CONFIRMED',
            'sale': {
              'id': id,
              'status': 'COMPLETED',
              'void_readiness': 'NOT_COMPLETED',
              'void_request_id': '125',
              'void_request_status': 'CANCELLED_HANDOVER_CONFIRMED',
              'void_refund_id': '225',
              'void_refund_status': 'REJECTED',
              'payment_mode': 'CASH',
            },
            'void_request': {
              'id': '125',
              'status': 'CANCELLED_HANDOVER_CONFIRMED',
            },
            'refund': {'id': '225', 'approval_status': 'REJECTED'},
          },
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Recent sales'));
      await tester.pumpAndSettle();
      final action = find.byKey(
        const ValueKey('counter-sale-handover-resolution-25'),
      );
      await tester.tap(action);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('counter-sale-handover-resolution-reason')),
        'Customer retained medicine',
      );
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.ensureVisible(
        find.byKey(const ValueKey('counter-sale-handover-resolution-submit')),
      );
      tester
          .widget<FilledButton>(
            find.byKey(
              const ValueKey('counter-sale-handover-resolution-submit'),
            ),
          )
          .onPressed!();
      await tester.pumpAndSettle();

      await tester.tap(action);
      await tester.pumpAndSettle();
      tester
          .widget<FilledButton>(
            find.byKey(
              const ValueKey('counter-sale-handover-resolution-submit'),
            ),
          )
          .onPressed!();
      await tester.pumpAndSettle();
      expect(keys, hasLength(2));
      expect(keys[1], keys[0]);
      expect(
        find.textContaining('no refund or restock occurred'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('counter-sale-void-25')), findsNothing);
    },
  );

  testWidgets('offline state disables create and void actions', (tester) async {
    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.unavailable,
      continuity: ContinuityLifecycleState.notReady,
    );
    _useTallViewport(tester);
    await tester.pumpWidget(_screen());
    await tester.pumpAndSettle();
    await _prepareOtcSale(tester);
    expect(
      tester
          .widget<FilledButton>(find.byKey(const ValueKey('counter-sale-sell')))
          .onPressed,
      isNull,
    );
    expect(
      find.byKey(const ValueKey('counter-sale-offline-message')),
      findsOneWidget,
    );
  });
}
