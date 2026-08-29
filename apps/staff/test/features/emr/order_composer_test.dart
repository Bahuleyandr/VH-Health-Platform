// test/features/emr/order_composer_test.dart
//
// Pure-Dart tests for the CPOE order composer logic (roadmap E1):
// lib/features/emr/models/order_draft.dart. Pins the payload contract of
// POST /emr/orders/bulk (nested `details`, canonical order_type values),
// the order-set item → draft mapping, the CDS pre-check partitioning, the
// CDS_BLOCKER error-envelope parsing, the medication role gate (mirror of
// MEDICATION_ORDER_WRITE_ROLES in apps/backend orderRoutes.js), and the
// persisted-row display helper. Same no-plugin-channel philosophy as
// cds_allergy_blocker_test.dart / vitals_chart_screen_test.dart.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/order_payloads.dart';
import 'package:vhhealth_staff/features/emr/models/order_draft.dart';

void main() {
  test('both order-set exits run medication reconciliation before handoff', () {
    final source = File(
      'lib/features/productivity/screens/order_sets_screen.dart',
    ).readAsStringSync();
    const reconciliationCall =
        'final ready = await _reconcileSelectedMedicationItems();';

    expect(
      RegExp(RegExp.escape(reconciliationCall)).allMatches(source),
      hasLength(2),
    );
    expect(
      source,
      contains("'payload': _reconciledMedicationPayloads[it.id] ?? it.payload"),
    );
    expect(
      RegExp(r'_selectedCatalog = null;').allMatches(source),
      hasLength(2),
      reason: 'editing catalog search must invalidate the prior selection',
    );
  });

  group('canPrescribeMedicationOrders', () {
    test('doctor-class roles can prescribe', () {
      for (final role in [
        'DOCTOR',
        'DUTY_DOCTOR',
        'CONSULTANT',
        'JUNIOR_DOCTOR',
        'RESIDENT',
      ]) {
        expect(canPrescribeMedicationOrders(role), isTrue, reason: role);
      }
    });

    test('normalises case and whitespace', () {
      expect(canPrescribeMedicationOrders(' doctor '), isTrue);
      expect(canPrescribeMedicationOrders('Duty_Doctor'), isTrue);
    });

    test('nurse/pharmacy/null cannot prescribe', () {
      for (final role in [
        'ADMIN',
        'SUPER_ADMIN',
        'MEDICAL_SUPERINTENDENT',
        'NURSE',
        'PHARMACY',
        'IP_STAFF_NURSE',
      ]) {
        expect(canPrescribeMedicationOrders(role), isFalse, reason: role);
      }
      expect(canPrescribeMedicationOrders(null), isFalse);
      expect(canPrescribeMedicationOrders(''), isFalse);
    });
  });

  group('buildBulkOrderItem', () {
    test('uses the canonical nested-details contract', () {
      final draft = OrderDraft(
        orderType: 'medication',
        priority: 'stat',
        details: {
          'medication_name': 'Amoxicillin',
          'dose': '500mg',
          'route': 'PO',
          'frequency': 'TDS',
          'duration_days': 5,
          'quantity_requested': 15,
          'unit': 'capsule',
        },
      );
      final item = buildBulkOrderItem(
        draft,
        patientUid: 'uid-1',
        encounterId: 'enc-9',
      );

      expect(item['patient_uid'], 'uid-1');
      expect(item['encounter_id'], 'enc-9');
      expect(item['order_type'], 'medication');
      expect(item['priority'], 'stat');
      final details = item['details'] as Map<String, dynamic>;
      expect(details['medication_name'], 'Amoxicillin');
      expect(details['duration_days'], 5);
      expect(details['quantity_requested'], 15);
      expect(details['unit'], 'capsule');
      // No flat legacy fields on the item itself.
      expect(item.containsKey('medication'), isFalse);
      expect(item.containsKey('dosage'), isFalse);
    });

    test('omits encounter when absent and scrubs empty detail values', () {
      final draft = OrderDraft(
        orderType: 'investigation',
        details: {'test_name': 'CBC', 'test_code': '', 'reason': null},
      );
      final item = buildBulkOrderItem(draft, patientUid: 'uid-1');

      expect(item.containsKey('encounter_id'), isFalse);
      final details = item['details'] as Map<String, dynamic>;
      expect(details.containsKey('test_code'), isFalse);
      expect(details.containsKey('reason'), isFalse);
      expect(details['test_name'], 'CBC');
      expect(item['priority'], 'routine');
    });

    test('carries trimmed notes only when non-empty', () {
      final withNotes = buildBulkOrderItem(
        OrderDraft(
          orderType: 'diet',
          details: {'description': 'NPO'},
          notes: ' pre-op ',
        ),
        patientUid: 'u',
      );
      expect(withNotes['notes'], 'pre-op');

      final noNotes = buildBulkOrderItem(
        OrderDraft(
          orderType: 'diet',
          details: {'description': 'NPO'},
          notes: '  ',
        ),
        patientUid: 'u',
      );
      expect(noNotes.containsKey('notes'), isFalse);
    });
  });

  group('orderDraftFromSetItem', () {
    test('med item maps to a medication draft', () {
      final draft = orderDraftFromSetItem({
        'kind': 'med',
        'payload': {
          'drug': 'Ceftriaxone',
          'dose': '1g',
          'route': 'IV',
          'frequency': 'BD',
          'duration_days': 7,
          'catalog_id': 41,
          'quantity_requested': 14,
          'unit': 'vial',
        },
      });
      expect(draft, isNotNull);
      expect(draft!.orderType, 'medication');
      expect(draft.details['medication_name'], 'Ceftriaxone');
      expect(draft.details['duration_days'], 7);
      expect(draft.details['catalog_id'], 41);
      expect(draft.details['quantity_requested'], 14);
      expect(draft.details['unit'], 'vial');
      expect(draft.source, 'order-set');
      expect(medicationHasAuthoritativeCatalog(draft), isTrue);

      final item = buildBulkOrderItem(draft, patientUid: 'patient-1');
      final details = item['details'] as Map<String, dynamic>;
      expect(details['catalog_id'], 41);
      expect(details['quantity_requested'], 14);
      expect(details['unit'], 'vial');
    });

    test('seeded medication items require live catalog reconciliation', () {
      final seeded = <String, dynamic>{
        'drug': 'Ceftriaxone',
        'dose': '1g',
        'route': 'PO',
        'frequency': 'q12h',
        'duration_days': 7,
      };

      expect(medicationOrderSetPayloadNeedsReconciliation(seeded), isTrue);

      final reconciled = reconcileMedicationOrderSetPayload(
        payload: seeded,
        catalogRow: {
          'id': 41,
          'name': 'Ceftriaxone 1 g vial',
          'generic_name': 'Ceftriaxone',
          'strength': '1 g',
          'form': 'vial',
          'route': 'IV',
        },
        dose: '1 g every 12 hours',
        quantityRequested: '14',
        unit: 'VIAL',
      );

      expect(reconciled['drug'], 'Ceftriaxone 1 g vial');
      expect(reconciled['medication_name'], 'Ceftriaxone 1 g vial');
      expect(reconciled['catalog_id'], 41);
      expect(reconciled['quantity_requested'], 14);
      expect(reconciled['unit'], 'vial');
      expect(reconciled['dose'], '1 g every 12 hours');
      expect(reconciled['route'], 'IV');
      expect(reconciled['frequency'], 'q12h');
      expect(
        medicationOrderSetPayloadNeedsReconciliation(reconciled),
        isTrue,
        reason: 'a future application must re-confirm the live catalog row',
      );
      expect(
        medicationOrderSetPayloadNeedsReconciliation(
          reconciled,
          liveCatalogSelected: true,
        ),
        isFalse,
      );
    });

    test(
      'medication directions require an explicit dose and catalog route',
      () {
        final complete = OrderDraft(
          orderType: 'medication',
          details: {'dose': '500 mg', 'route': 'PO'},
        );
        expect(medicationClinicalDirectionsFailure(complete), isNull);

        final noDose = OrderDraft(
          orderType: 'medication',
          details: {'route': 'PO'},
        );
        expect(
          medicationClinicalDirectionsFailure(noDose),
          MedicationClinicalDirectionsValidationFailure.doseRequired,
        );

        final noRoute = OrderDraft(
          orderType: 'medication',
          details: {'dose': '500 mg'},
        );
        expect(
          medicationClinicalDirectionsFailure(noRoute),
          MedicationClinicalDirectionsValidationFailure.routeRequired,
        );

        expect(
          medicationClinicalDirectionsFailure(
            OrderDraft(orderType: 'investigation', details: const {}),
          ),
          isNull,
        );
      },
    );

    test(
      'reconciliation rejects blank dose and catalog rows without route',
      () {
        final catalog = <String, dynamic>{
          'id': 41,
          'name': 'Ceftriaxone 1 g vial',
          'route': 'IV',
        };
        expect(
          () => reconcileMedicationOrderSetPayload(
            payload: const {'drug': 'Ceftriaxone'},
            catalogRow: catalog,
            dose: ' ',
            quantityRequested: 1,
            unit: 'vial',
          ),
          throwsArgumentError,
        );
        expect(
          () => reconcileMedicationOrderSetPayload(
            payload: const {'drug': 'Ceftriaxone'},
            catalogRow: const {'id': 41, 'name': 'Ceftriaxone 1 g vial'},
            dose: '1 g',
            quantityRequested: 1,
            unit: 'vial',
          ),
          throwsArgumentError,
        );
      },
    );

    test('generic dose aliases are not accepted as ward-supply quantity', () {
      for (final alias in ['quantity', 'qty', 'units']) {
        final draft = orderDraftFromSetItem({
          'kind': 'med',
          'payload': {
            'drug': 'Metformin',
            'catalog_id': 73,
            alias: 1,
            'unit': 'tablet',
          },
        });

        expect(draft!.details['quantity_requested'], isNull, reason: alias);
        expect(
          medicationWardSupplyFailure(draft),
          MedicationWardSupplyValidationFailure.quantityRequired,
          reason: alias,
        );
      }
    });

    test('lab item maps to an investigation draft', () {
      final draft = orderDraftFromSetItem({
        'kind': 'lab',
        'payload': {'test_name': 'Blood culture', 'test_code': 'BC01'},
      });
      expect(draft!.orderType, 'investigation');
      expect(draft.details['test_name'], 'Blood culture');
      expect(draft.details['test_code'], 'BC01');
    });

    test('radiology item uses study as test_name', () {
      final draft = orderDraftFromSetItem({
        'kind': 'radiology',
        'payload': {'study': 'Chest X-ray PA'},
      });
      expect(draft!.orderType, 'radiology');
      expect(draft.details['test_name'], 'Chest X-ray PA');
    });

    test('consult/diet/nursing/vitals/monitor map to canonical types', () {
      expect(
        orderDraftFromSetItem({
          'kind': 'consult',
          'payload': {'specialty': 'Cardiology'},
        })!.orderType,
        'consultation',
      );
      expect(
        orderDraftFromSetItem({
          'kind': 'diet',
          'payload': {'label': 'Diabetic diet'},
        })!.orderType,
        'diet',
      );
      for (final kind in ['nursing', 'vitals', 'monitor']) {
        final d = orderDraftFromSetItem({
          'kind': kind,
          'payload': {'label': 'Hourly vitals'},
        });
        expect(d!.orderType, 'nursing', reason: kind);
        expect(d.details['description'], 'Hourly vitals');
      }
    });

    test('note/other and payloads without a name are not placeable', () {
      expect(orderDraftFromSetItem({'kind': 'note', 'payload': {}}), isNull);
      expect(orderDraftFromSetItem({'kind': 'other', 'payload': {}}), isNull);
      expect(orderDraftFromSetItem({'kind': 'med', 'payload': {}}), isNull);
      expect(
        orderDraftFromSetItem({
          'kind': 'lab',
          'payload': {'test_name': '  '},
        }),
        isNull,
      );
    });
  });

  group('catalog row mapping', () {
    test('pharmacy formulary row pre-fills a medication draft', () {
      final draft = orderDraftFromMedCatalogRow({
        'id': 73,
        'name': 'Metformin',
        'strength': '500mg',
        'generic_name': 'Metformin HCl',
      });
      expect(draft.orderType, 'medication');
      expect(draft.details['medication_name'], 'Metformin');
      expect(draft.details['dose'], '500mg');
      expect(draft.details['catalog_id'], 73);
      expect(draft.details['generic_name'], 'Metformin HCl');
      expect(draft.details.containsKey('quantity_requested'), isFalse);
      expect(draft.details.containsKey('unit'), isFalse);
      expect(draft.source, 'catalog');
      expect(medicationHasAuthoritativeCatalog(draft), isTrue);
    });

    test('medication supply remains incomplete until explicitly captured', () {
      final draft = orderDraftFromMedCatalogRow({
        'id': 73,
        'name': 'Metformin',
        'strength': '500mg',
        'form': 'tablet',
        'pack_size': '10 x 10',
      });

      expect(
        medicationWardSupplyFailure(draft),
        MedicationWardSupplyValidationFailure.quantityRequired,
      );
      draft.details['quantity_requested'] = 20;
      expect(
        medicationWardSupplyFailure(draft),
        MedicationWardSupplyValidationFailure.unitRequired,
      );
      draft.details['unit'] = 'tablet';
      expect(medicationWardSupplyFailure(draft), isNull);
    });

    test('free-form medication draft has no authoritative catalog', () {
      final draft = OrderDraft(
        orderType: 'medication',
        details: {
          'medication_name': 'Free-text medicine',
          'quantity_requested': 1,
          'unit': 'each',
        },
      );

      expect(medicationHasAuthoritativeCatalog(draft), isFalse);
    });

    test('lab catalog row maps to investigation with code + fasting', () {
      final draft = orderDraftFromTestCatalogRow({
        'name': 'Fasting blood sugar',
        'code': 'FBS',
        'category': 'BIOCHEMISTRY',
        'requires_fasting': true,
      });
      expect(draft.orderType, 'investigation');
      expect(draft.details['test_code'], 'FBS');
      expect(draft.details['fasting_required'], isTrue);
    });

    test('imaging categories map to radiology, ECG to ecg', () {
      expect(
        orderDraftFromTestCatalogRow({
          'name': 'CT Brain',
          'category': 'Radiology',
        }).orderType,
        'radiology',
      );
      expect(
        orderDraftFromTestCatalogRow({
          'name': 'USG Abdomen',
          'category': 'ultrasound',
        }).orderType,
        'radiology',
      );
      expect(
        orderDraftFromTestCatalogRow({'name': '12-lead ECG', 'category': 'ECG'})
            .orderType,
        'ecg',
      );
    });
  });

  group('classifyPrecheckAlerts', () {
    test('splits critical vs warning and drops info + junk', () {
      final r = classifyPrecheckAlerts([
        {'severity': 'critical', 'title': 'Allergy conflict'},
        {'severity': 'warning', 'title': 'Duplicate order'},
        {'severity': 'info', 'title': 'FYI'},
        'not-a-map',
      ]);
      expect(r.criticals, hasLength(1));
      expect(r.criticals.single['title'], 'Allergy conflict');
      expect(r.cautions, hasLength(1));
      expect(r.cautions.single['title'], 'Duplicate order');
    });

    test('empty input yields empty partitions', () {
      final r = classifyPrecheckAlerts(const []);
      expect(r.criticals, isEmpty);
      expect(r.cautions, isEmpty);
    });
  });

  group('parseCdsBlockerDetails', () {
    test('reads order_index, blockers, warnings from the error envelope', () {
      final r = parseCdsBlockerDetails({
        'success': false,
        'code': 'CDS_BLOCKER',
        'details': {
          'order_index': 2,
          'blockers': [
            {'type': 'ALLERGY_CONFLICT', 'message': 'Penicillin allergy'},
          ],
          'warnings': [
            {'message': 'Monitor INR'},
          ],
        },
      });
      expect(r.orderIndex, 2);
      expect(r.blockers, hasLength(1));
      expect(r.warnings, hasLength(1));
    });

    test('tolerates missing details / non-map payloads', () {
      expect(parseCdsBlockerDetails(null).blockers, isEmpty);
      expect(parseCdsBlockerDetails('oops').blockers, isEmpty);
      expect(parseCdsBlockerDetails({'success': false}).orderIndex, isNull);
    });

    test('parses string order_index defensively', () {
      final r = parseCdsBlockerDetails({
        'details': {'order_index': '1', 'blockers': [], 'warnings': []},
      });
      expect(r.orderIndex, 1);
    });
  });

  group('isDeviceWriteGate', () {
    test('matches both phone-mode gate codes', () {
      expect(
        isDeviceWriteGate({'code': 'CLINICAL_WRITE_DESKTOP_ONLY'}),
        isTrue,
      );
      expect(isDeviceWriteGate({'code': 'DEVICE_TYPE_MISSING'}), isTrue);
      expect(isDeviceWriteGate({'error_code': 'DEVICE_TYPE_MISSING'}), isTrue);
    });

    test('everything else is not the device gate', () {
      expect(isDeviceWriteGate({'code': 'CDS_BLOCKER'}), isFalse);
      expect(isDeviceWriteGate(null), isFalse);
      expect(isDeviceWriteGate('x'), isFalse);
    });
  });

  group('orderDisplayFields', () {
    test('renders canonical nested-details medication rows', () {
      final d = orderDisplayFields({
        'order_type': 'medication',
        'details': {
          'medication_name': 'Amoxicillin',
          'dose': '500mg',
          'route': 'PO',
          'frequency': 'TDS',
          'duration_days': 5,
        },
      });
      expect(d.title, 'Amoxicillin');
      expect(d.subtitle, '500mg | PO | TDS | 5');
    });

    test('renders investigation rows with code and reason', () {
      final d = orderDisplayFields({
        'order_type': 'investigation',
        'details': {
          'test_name': 'CBC',
          'test_code': 'LAB001',
          'reason': 'fever',
        },
      });
      expect(d.title, 'CBC');
      expect(d.subtitle, 'LAB001 | fever');
    });

    test('falls back to legacy flat fields on very old rows', () {
      final d = orderDisplayFields({
        'order_type': 'medication',
        'medication': 'Paracetamol',
        'dosage': '650mg',
        'frequency': 'QID',
      });
      expect(d.title, 'Paracetamol');
      expect(d.subtitle, contains('650mg'));
    });

    test('consultation rows show specialty + reason', () {
      final d = orderDisplayFields({
        'order_type': 'consultation',
        'details': {'specialty': 'Nephrology', 'reason': 'AKI review'},
      });
      expect(d.title, 'Nephrology');
      expect(d.subtitle, 'AKI review');
    });

    test('empty/malformed rows degrade to empty strings', () {
      final d = orderDisplayFields({'order_type': 'medication'});
      expect(d.title, '');
      expect(d.subtitle, '');
    });
  });

  group('OrderDraft display', () {
    test('title/subtitle per type', () {
      expect(
        OrderDraft(
          orderType: 'medication',
          details: {
            'medication_name': 'Insulin',
            'dose': '10U',
            'route': 'SC',
            'frequency': 'OD',
          },
        ).title,
        'Insulin',
      );
      expect(
        OrderDraft(
          orderType: 'radiology',
          details: {'test_name': 'CT Brain'},
        ).title,
        'CT Brain',
      );
      expect(
        OrderDraft(
          orderType: 'consultation',
          details: {'specialty': 'Cardiology', 'reason': 'pre-op'},
        ).subtitle,
        'pre-op',
      );
    });
  });
}
