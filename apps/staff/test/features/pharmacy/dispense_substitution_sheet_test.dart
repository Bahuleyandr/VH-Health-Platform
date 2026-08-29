import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/models/composition_alternatives.dart';
import 'package:vhhealth_staff/core/services/pharmacy_api_service.dart';
import 'package:vhhealth_staff/features/pharmacy/widgets/dispense_substitution_sheet.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

CompositionAlternativesResult _alts() =>
    CompositionAlternativesResult.fromJson(const {
      'selected': {
        'catalog_id': 101,
        'composition_id': 3,
        'strength': '625 mg',
        'strength_key': '625mg',
        'form': 'tablet',
        'form_key': 'tablet',
        'release_key': 'ir',
      },
      'groups': [
        {
          'strength': '625 mg',
          'strength_key': '625mg',
          'form': 'tablet',
          'form_key': 'tablet',
          'matched': true,
          'items': [
            {
              'catalog_id': 202,
              'name': 'Clavam 625',
              'manufacturer': 'Alkem',
              'strength': '625 mg',
              'strength_key': '625mg',
              'form': 'tablet',
              'form_key': 'tablet',
              'stock_quantity': 14,
              'availability_status': 'in_stock',
              'substitutable': true,
            },
          ],
        },
      ],
      'alternatives': [
        {
          'catalog_id': 202,
          'name': 'Clavam 625',
          'availability_status': 'in_stock',
          'substitutable': true,
        },
      ],
    });

void main() {
  testWidgets(
    'full flow: load context → swap → batch → dispense with correct args',
    (tester) async {
      Map<String, dynamic>? captured;
      final idempotencyKeys = <String>[];
      var dispenseAttempts = 0;
      await tester.pumpWidget(
        _host(
          DispenseSubstitutionSheet(
            orderId: 7,
            contextLoader: (id) async => {
              'order_id': id,
              'patient_uid': 'p-uid-1',
              'payment_mode': 'cash',
              'amount_collected': 0,
              'lines': [
                {
                  'prescription_id': 77,
                  'order_line_index': 0,
                  'prescription_line_index': 0,
                  'catalog_id': 101,
                  'name': 'Augmentin 625',
                  'quantity': 10,
                },
              ],
            },
            alternativesLoader: (catalogId) async => _alts(),
            batchLoader: (catalogId) async => [
              {
                'inventory_item_id': 55,
                'inventory_batch_id': 900,
                'batch_number': 'B-NEAR',
                'remaining_quantity': 50,
                'expiry_date': '2027-01-01',
              },
            ],
            dispenser:
                ({
                  required orderId,
                  required prescriptionId,
                  required orderLineIndex,
                  required prescriptionLineIndex,
                  required patientUid,
                  encounterId,
                  required inventoryItemId,
                  required inventoryBatchId,
                  required quantity,
                  required originalCatalogId,
                  required finalCatalogId,
                  reason,
                  witnessApprovalId,
                  required paymentMode,
                  required amountCollected,
                  tpaReference,
                  required idempotencyKey,
                }) async {
                  dispenseAttempts++;
                  idempotencyKeys.add(idempotencyKey);
                  captured = {
                    'orderId': orderId,
                    'prescriptionId': prescriptionId,
                    'orderLineIndex': orderLineIndex,
                    'prescriptionLineIndex': prescriptionLineIndex,
                    'patientUid': patientUid,
                    'inventoryItemId': inventoryItemId,
                    'inventoryBatchId': inventoryBatchId,
                    'quantity': quantity,
                    'originalCatalogId': originalCatalogId,
                    'finalCatalogId': finalCatalogId,
                    'witnessApprovalId': witnessApprovalId,
                    'paymentMode': paymentMode,
                    'amountCollected': amountCollected,
                    'tpaReference': tpaReference,
                  };
                  if (dispenseAttempts == 1) {
                    throw Exception('response lost after durable write');
                  }
                  if (dispenseAttempts == 2) {
                    throw const PharmacyApiException(
                      statusCode: 503,
                      message: 'Upstream response unavailable',
                      code: 'SERVICE_UNAVAILABLE',
                    );
                  }
                  if (dispenseAttempts == 3) {
                    throw const PharmacyApiException(
                      statusCode: 409,
                      message: 'Approved TPA allocation required',
                      code: 'PHARMACY_TPA_FUNDING_REQUIRED',
                      details: {
                        'next_action': 'select_exact_tpa_claim_allocation',
                        'funding_recovery': {
                          'task_id': 'TPA-7',
                          'status': 'in_progress',
                          'owner_role': 'INSURANCE_COORDINATOR',
                          'deep_link': '/billing-desk?pharmacy_order_id=7&invoice_item_id=81&tpa_claim_id=71',
                        },
                      },
                    );
                  }
                },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Augmentin 625'),
        findsWidgets,
      ); // prescribed line surfaced

      // Expand the alternatives panel, then swap to the equivalent brand.
      await tester.tap(find.text('Composition alternatives'));
      await tester.pumpAndSettle();
      final swapBtn = find.widgetWithText(TextButton, 'Swap').first;
      await tester.ensureVisible(swapBtn);
      await tester.pumpAndSettle();
      await tester.tap(swapBtn);
      await tester.pumpAndSettle(); // onSwap → batchLoader → batch picker + enabled dispense

      final dispenseBtn = find.widgetWithText(
        FilledButton,
        'Dispense substitute',
      );
      await tester.ensureVisible(dispenseBtn);
      await tester.pumpAndSettle();
      await tester.tap(dispenseBtn);
      await tester.pumpAndSettle();

      // Ambiguous timeout and 5xx retries retain the exact command key. A
      // correctable 4xx rotates it before the subsequent retry.
      for (var retry = 0; retry < 3; retry++) {
        await tester.tap(
          find.widgetWithText(FilledButton, 'Dispense substitute'),
        );
        await tester.pumpAndSettle();
        if (retry == 1) {
          expect(find.textContaining('Funding task TPA-7'), findsOneWidget);
          expect(
            find.byKey(const ValueKey('substitution-open-billing-desk')),
            findsNothing,
          );
        }
      }

      expect(captured, isNotNull);
      expect(captured!['orderId'], 7);
      expect(captured!['prescriptionId'], 77);
      expect(captured!['patientUid'], 'p-uid-1');
      expect(captured!['originalCatalogId'], 101); // the prescribed brand
      expect(captured!['finalCatalogId'], 202); // the chosen substitute
      expect(captured!['inventoryItemId'], 55);
      expect(captured!['inventoryBatchId'], 900);
      expect(captured!['quantity'], 10); // defaulted from the prescribed line
      // Non-controlled batch: no witness approval attached.
      expect(captured!['witnessApprovalId'], isNull);
      expect(captured!['paymentMode'], 'cash');
      expect(captured!['amountCollected'], 0);
      expect(idempotencyKeys, hasLength(4));
      expect(idempotencyKeys[1], idempotencyKeys[0]);
      expect(idempotencyKeys[2], idempotencyKeys[0]);
      expect(idempotencyKeys[3], isNot(idempotencyKeys[0]));
    },
  );

  testWidgets(
    'Schedule X batch: dispense stays disabled until the two-person witness '
    'flow completes, rotating correctable request and approval keys',
    (tester) async {
      Map<String, dynamic>? captured;
      Map<String, dynamic>? requestedSubstitution;
      Map<String, dynamic>? approvedSubstitution;
      String? approvedEmployeeId;
      final witnessRequestKeys = <String>[];
      final witnessApprovalKeys = <String>[];
      var witnessRequestCalls = 0;
      var witnessApprovalCalls = 0;
      await tester.pumpWidget(
        _host(
          DispenseSubstitutionSheet(
            orderId: 9,
            contextLoader: (id) async => {
              'order_id': id,
              'patient_uid': 'p-uid-2',
              'payment_mode': 'cash',
              'amount_collected': 0,
              'lines': [
                {
                  'prescription_id': 99,
                  'order_line_index': 0,
                  'prescription_line_index': 0,
                  'catalog_id': 101,
                  'name': 'Augmentin 625',
                  'quantity': 5,
                },
              ],
            },
            alternativesLoader: (catalogId) async => _alts(),
            batchLoader: (catalogId) async => [
              {
                'inventory_item_id': 66,
                'inventory_batch_id': 901,
                'batch_number': 'B-X',
                'remaining_quantity': 30,
                'expiry_date': '2027-01-01',
                'schedule_class': 'X',
                'is_narcotic': true,
              },
            ],
            requestWitnessApproval:
                ({required substitution, required idempotencyKey}) async {
                  witnessRequestCalls++;
                  witnessRequestKeys.add(idempotencyKey);
                  requestedSubstitution = substitution;
                  if (witnessRequestCalls == 1) {
                    throw Exception('witness request response lost');
                  }
                  if (witnessRequestCalls == 2) {
                    throw const PharmacyApiException(
                      statusCode: 503,
                      message: 'Witness store unavailable',
                      code: 'SERVICE_UNAVAILABLE',
                    );
                  }
                  if (witnessRequestCalls == 3) {
                    throw const PharmacyApiException(
                      statusCode: 409,
                      message: 'Verification state changed',
                      code: 'PHARMACY_VERIFICATION_REQUIRED',
                    );
                  }
                  return {'id': '41', 'status': 'pending'};
                },
            approveWitnessApproval:
                ({
                  required approvalId,
                  required substitution,
                  required employeeId,
                  required password,
                  required idempotencyKey,
                }) async {
                  witnessApprovalCalls++;
                  witnessApprovalKeys.add(idempotencyKey);
                  approvedSubstitution = substitution;
                  approvedEmployeeId = employeeId;
                  if (witnessApprovalCalls == 1) {
                    throw Exception('witness approval response lost');
                  }
                  if (witnessApprovalCalls == 2) {
                    throw const PharmacyApiException(
                      statusCode: 503,
                      message: 'Witness store unavailable',
                      code: 'SERVICE_UNAVAILABLE',
                    );
                  }
                  if (witnessApprovalCalls == 3) {
                    throw const PharmacyApiException(
                      statusCode: 401,
                      message: 'Witness credentials invalid',
                      code: 'CONTROLLED_DISPENSE_WITNESS_CREDENTIALS_INVALID',
                    );
                  }
                  return {
                    'id': approvalId,
                    'status': 'approved',
                    'witness': {'name': 'Roster Witness'},
                  };
                },
            dispenser:
                ({
                  required orderId,
                  required prescriptionId,
                  required orderLineIndex,
                  required prescriptionLineIndex,
                  required patientUid,
                  encounterId,
                  required inventoryItemId,
                  required inventoryBatchId,
                  required quantity,
                  required originalCatalogId,
                  required finalCatalogId,
                  reason,
                  witnessApprovalId,
                  required paymentMode,
                  required amountCollected,
                  tpaReference,
                  required idempotencyKey,
                }) async {
                  captured = {
                    'orderId': orderId,
                    'prescriptionId': prescriptionId,
                    'orderLineIndex': orderLineIndex,
                    'prescriptionLineIndex': prescriptionLineIndex,
                    'inventoryItemId': inventoryItemId,
                    'witnessApprovalId': witnessApprovalId,
                    'paymentMode': paymentMode,
                    'amountCollected': amountCollected,
                    'tpaReference': tpaReference,
                    'idempotencyKey': idempotencyKey,
                  };
                },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Composition alternatives'));
      await tester.pumpAndSettle();
      final swapBtn = find.widgetWithText(TextButton, 'Swap').first;
      await tester.ensureVisible(swapBtn);
      await tester.pumpAndSettle();
      await tester.tap(swapBtn);
      await tester.pumpAndSettle();

      // Controlled batch → the dispense button is disabled pre-witness.
      final dispenseBtn = find.widgetWithText(
        FilledButton,
        'Dispense substitute',
      );
      await tester.ensureVisible(dispenseBtn);
      await tester.pumpAndSettle();
      expect(
        tester.widget<FilledButton>(dispenseBtn).onPressed,
        isNull,
        reason: 'Schedule X substitute must not be dispensable pre-witness',
      );

      // Ambiguous request failures retain the key; a cached correctable
      // request failure rotates it before the next retry.
      final witnessBtn = find.byKey(
        const ValueKey('substitution-witness-request'),
      );
      await tester.ensureVisible(witnessBtn);
      await tester.pumpAndSettle();
      for (var failedRequest = 0; failedRequest < 3; failedRequest++) {
        await tester.tap(witnessBtn);
        await tester.pumpAndSettle();
      }

      await tester.tap(witnessBtn);
      // The credentials dialog is up while _witnessBusy still animates the
      // request button's indeterminate spinner, so pumpAndSettle would never
      // settle here — bounded pumps, same as counter_sale_screen_test.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(requestedSubstitution, isNotNull);
      expect(requestedSubstitution!['order_id'], 9);
      expect(requestedSubstitution!['prescription_id'], 99);
      expect(requestedSubstitution!['inventory_item_id'], 66);
      expect(requestedSubstitution!['final_catalog_id'], 202);
      expect(requestedSubstitution!['payment_mode'], 'cash');
      expect(requestedSubstitution!['amount_collected'], 0);
      expect(
        requestedSubstitution!.containsKey('witness_approval_id'),
        isFalse,
      );

      Future<void> submitWitnessCredentials() async {
        await tester.enterText(
          find.byKey(const ValueKey('substitution-witness-employee-id')),
          'emp-9',
        );
        await tester.enterText(
          find.byKey(const ValueKey('substitution-witness-password')),
          'secret',
        );
        await tester.tap(
          find.byKey(const ValueKey('substitution-witness-approve-submit')),
        );
        await tester.pumpAndSettle();
      }

      await submitWitnessCredentials();
      for (var failedApproval = 1; failedApproval < 3; failedApproval++) {
        await tester.tap(witnessBtn);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        await submitWitnessCredentials();
      }

      // The correctable third approval failure rotated only that command;
      // the already-created pending approval remains reusable.
      await tester.tap(witnessBtn);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await submitWitnessCredentials();

      expect(approvedEmployeeId, 'EMP-9');
      expect(approvedSubstitution, equals(requestedSubstitution));
      expect(find.textContaining('Roster Witness'), findsOneWidget);
      expect(witnessRequestKeys, hasLength(4));
      expect(witnessRequestKeys[1], witnessRequestKeys[0]);
      expect(witnessRequestKeys[2], witnessRequestKeys[0]);
      expect(witnessRequestKeys[3], isNot(witnessRequestKeys[0]));
      expect(witnessApprovalKeys, hasLength(4));
      expect(witnessApprovalKeys[1], witnessApprovalKeys[0]);
      expect(witnessApprovalKeys[2], witnessApprovalKeys[0]);
      expect(witnessApprovalKeys[3], isNot(witnessApprovalKeys[0]));

      // Now the dispense goes through and carries the approval id.
      await tester.ensureVisible(dispenseBtn);
      await tester.pumpAndSettle();
      await tester.tap(dispenseBtn);
      await tester.pumpAndSettle();
      expect(captured, isNotNull);
      expect(captured!['orderId'], 9);
      expect(captured!['prescriptionId'], 99);
      expect(captured!['witnessApprovalId'], '41');
    },
  );

  testWidgets(
    'posted-authority recovery only opens an exact backend-materialized task',
    (tester) async {
      var dispenseCalls = 0;
      await tester.pumpWidget(
        _host(
          DispenseSubstitutionSheet(
            orderId: 17,
            canOpenBillingDesk: true,
            contextLoader: (id) async => {
              'order_id': id,
              'patient_uid': 'p-uid-17',
              'payment_mode': 'cash',
              'amount_collected': 0,
              'lines': [
                {
                  'prescription_id': 177,
                  'order_line_index': 0,
                  'prescription_line_index': 0,
                  'catalog_id': 101,
                  'name': 'Augmentin 625',
                  'quantity': 1,
                },
              ],
            },
            alternativesLoader: (catalogId) async => _alts(),
            batchLoader: (catalogId) async => [
              {
                'inventory_item_id': 55,
                'inventory_batch_id': 917,
                'batch_number': 'B-FUND',
                'remaining_quantity': 5,
                'expiry_date': '2027-01-01',
              },
            ],
            dispenser:
                ({
                  required orderId,
                  required prescriptionId,
                  required orderLineIndex,
                  required prescriptionLineIndex,
                  required patientUid,
                  encounterId,
                  required inventoryItemId,
                  required inventoryBatchId,
                  required quantity,
                  required originalCatalogId,
                  required finalCatalogId,
                  reason,
                  witnessApprovalId,
                  required paymentMode,
                  required amountCollected,
                  tpaReference,
                  required idempotencyKey,
                }) async {
                  dispenseCalls++;
                  if (dispenseCalls == 1) {
                    throw const PharmacyApiException(
                      statusCode: 409,
                      message: 'Posted authority required',
                      code: 'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED',
                      details: {
                        'next_action': 'materialize_pharmacy_funding',
                        'funding_recovery': null,
                      },
                    );
                  }
                  throw const PharmacyApiException(
                    statusCode: 409,
                    message: 'Posted authority required',
                    code: 'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED',
                    details: {
                      'next_action': 'open_exact_pharmacy_funding_task',
                      'funding_recovery': {
                        'task_id': '82',
                        'status': 'in_progress',
                        'owner_role': 'FINANCE_INCHARGE',
                        'deep_link': '/billing-desk?pharmacy_order_id=17&invoice_item_id=72',
                      },
                    },
                  );
                },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Composition alternatives'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Swap').first);
      await tester.pumpAndSettle();

      final dispense = find.widgetWithText(FilledButton, 'Dispense substitute');
      await tester.ensureVisible(dispense);
      await tester.tap(dispense);
      await tester.pumpAndSettle();
      expect(find.textContaining('Funding task'), findsNothing);
      expect(
        find.byKey(const ValueKey('substitution-open-billing-desk')),
        findsNothing,
      );

      await tester.tap(dispense);
      await tester.pumpAndSettle();
      expect(find.textContaining('Funding task 82'), findsOneWidget);
    },
  );

  testWidgets(
    'missing durable payment mode stays fail closed and cannot be self-attested',
    (tester) async {
      await tester.pumpWidget(
        _host(
          DispenseSubstitutionSheet(
            orderId: 10,
            contextLoader: (id) async => {
              'order_id': id,
              'patient_uid': 'p-uid-3',
              'amount_collected': 0,
              'lines': [
                {
                  'prescription_id': 100,
                  'order_line_index': 0,
                  'prescription_line_index': 0,
                  'catalog_id': 101,
                  'name': 'Augmentin 625',
                  'quantity': 2,
                },
              ],
            },
            alternativesLoader: (catalogId) async => _alts(),
            batchLoader: (catalogId) async => [
              {
                'inventory_item_id': 77,
                'inventory_batch_id': 902,
                'batch_number': 'B-OP',
                'remaining_quantity': 20,
                'expiry_date': '2027-01-01',
              },
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Composition alternatives'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Swap').first);
      await tester.pumpAndSettle();

      final paymentMode = tester.widget<DropdownButtonFormField<String>>(
        find.byKey(const ValueKey('substitution-payment-mode')),
      );
      final dispense = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Dispense substitute'),
      );
      expect(paymentMode.onChanged, isNull);
      expect(dispense.onPressed, isNull);
    },
  );

  testWidgets(
    'no prescribed catalog lines → shows the cannot-resolve message',
    (tester) async {
      await tester.pumpWidget(
        _host(
          DispenseSubstitutionSheet(
            orderId: 8,
            contextLoader: (id) async => {
              'order_id': id,
              'patient_uid': 'p',
              'lines': const [],
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('No prescribed catalog lines'),
        findsOneWidget,
      );
    },
  );
}
