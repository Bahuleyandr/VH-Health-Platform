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

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/models/order_draft.dart';

void main() {
  group('canPrescribeMedicationOrders', () {
    test('doctor-class roles can prescribe', () {
      for (final role in [
        'DOCTOR',
        'DUTY_DOCTOR',
        'CONSULTANT',
        'JUNIOR_DOCTOR',
        'RESIDENT',
        'MEDICAL_SUPERINTENDENT',
        'ADMIN',
        'SUPER_ADMIN',
      ]) {
        expect(canPrescribeMedicationOrders(role), isTrue, reason: role);
      }
    });

    test('normalises case and whitespace', () {
      expect(canPrescribeMedicationOrders(' doctor '), isTrue);
      expect(canPrescribeMedicationOrders('Duty_Doctor'), isTrue);
    });

    test('nurse/pharmacy/null cannot prescribe', () {
      expect(canPrescribeMedicationOrders('NURSE'), isFalse);
      expect(canPrescribeMedicationOrders('PHARMACY'), isFalse);
      expect(canPrescribeMedicationOrders('IP_STAFF_NURSE'), isFalse);
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
        },
      });
      expect(draft, isNotNull);
      expect(draft!.orderType, 'medication');
      expect(draft.details['medication_name'], 'Ceftriaxone');
      expect(draft.details['duration_days'], 7);
      expect(draft.source, 'order-set');
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
        'name': 'Metformin',
        'strength': '500mg',
        'generic_name': 'Metformin HCl',
      });
      expect(draft.orderType, 'medication');
      expect(draft.details['medication_name'], 'Metformin');
      expect(draft.details['dose'], '500mg');
      expect(draft.source, 'catalog');
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
        orderDraftFromTestCatalogRow({
          'name': '12-lead ECG',
          'category': 'ECG',
        }).orderType,
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
