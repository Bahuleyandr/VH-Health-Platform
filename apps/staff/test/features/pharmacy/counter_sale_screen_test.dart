import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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
            int? witnessApprovalId,
            required String paymentMode,
            String? paymentReference,
            String? notes,
          }) async => {
            'sale': {'id': '1', 'status': 'COMPLETED'},
            'invoice': {'invoice_number': 'INV-2026-000001'},
          },
      requestWitnessApproval: requestWitnessApproval,
      approveWitnessApproval: approveWitnessApproval,
      listSales: listSales ?? ({String? status, String? date}) async => [],
      voidSale: voidSale ?? (id, reason) async => {'sale': {}},
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

void main() {
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
              int? witnessApprovalId,
              required String paymentMode,
              String? paymentReference,
              String? notes,
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
      int? submittedApprovalId;
      _useTallViewport(tester);
      await tester.pumpWidget(
        _screen(
          searchItems: ({String? search}) async => [
            _item(name: 'Morphine 10', schedule: 'X', narcotic: true),
          ],
          requestWitnessApproval: ({required sale}) async {
            requestedSale = Map<String, dynamic>.from(sale);
            return {'id': '71', 'status': 'pending'};
          },
          approveWitnessApproval:
              ({
                required approvalId,
                required sale,
                required employeeId,
                required password,
              }) async {
                expect(approvalId, 71);
                approvedSale = Map<String, dynamic>.from(sale);
                witnessEmployeeId = employeeId;
                witnessPassword = password;
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
      await tester.pumpAndSettle();
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
      expect(approvedSale, requestedSale);
      expect(find.text('Approved by Canonical Nurse'), findsOneWidget);
      expect(find.text('witness-secret'), findsNothing);

      await tester.ensureVisible(
        find.byKey(const ValueKey('counter-sale-sell')),
      );
      await tester.tap(find.byKey(const ValueKey('counter-sale-sell')));
      await tester.pumpAndSettle();
      expect(submittedApprovalId, 71);
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
        requestWitnessApproval: ({required sale}) async => {'id': '72'},
        approveWitnessApproval:
            ({
              required approvalId,
              required sale,
              required employeeId,
              required password,
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
    await tester.pumpAndSettle();
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

  testWidgets('recent tab lists sales and voids with a reason', (tester) async {
    String? voidedId;
    String? voidedReason;
    await tester.pumpWidget(
      _screen(
        listSales: ({String? status, String? date}) async => [
          {
            'id': '5',
            'status': 'COMPLETED',
            'invoice_number': 'INV-2026-000005',
            'customer_name': 'Walk-in Customer',
            'total_amount': 651,
            'payment_mode': 'CASH',
          },
        ],
        voidSale: (id, reason) async {
          voidedId = id;
          voidedReason = reason;
          return {'sale': {}};
        },
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Recent sales'));
    await tester.pumpAndSettle();
    expect(find.textContaining('INV-2026-000005'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('counter-sale-void-5')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Customer returned');
    await tester.tap(find.byType(FilledButton).last);
    await tester.pumpAndSettle();

    expect(voidedId, '5');
    expect(voidedReason, 'Customer returned');
  });
}
