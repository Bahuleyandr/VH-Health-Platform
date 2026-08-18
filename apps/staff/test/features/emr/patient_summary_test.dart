// test/features/emr/patient_summary_test.dart
//
// Pins the pure aggregation logic behind the one-screen patient summary
// (roadmap E5): order partitioning into active meds / pending results,
// the compact latest-vitals line, allergy dedupe/cap, and command-board
// entry extraction. lib/features/emr/models/patient_summary.dart.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/models/patient_summary.dart';

void main() {
  group('partitionOrdersForSummary', () {
    test('splits active meds from pending results, drops the rest', () {
      final r = partitionOrdersForSummary([
        {
          'order_type': 'medication',
          'status': 'ordered',
          'details': {'medication_name': 'Amoxicillin'},
        },
        {
          'order_type': 'medication',
          'status': 'discontinued',
          'details': {'medication_name': 'Old drug'},
        },
        {
          'order_type': 'medication',
          'status': 'in_progress',
          'details': {'medication_name': 'Vancomycin infusion'},
        },
        {
          'order_type': 'investigation',
          'status': 'verified',
          'details': {'test_name': 'CBC'},
        },
        {
          'order_type': 'radiology',
          'status': 'ordered',
          'details': {'test_name': 'Chest X-ray'},
        },
        {
          'order_type': 'investigation',
          'status': 'completed',
          'details': {'test_name': 'RFT'},
        },
        {
          'order_type': 'nursing',
          'status': 'ordered',
          'details': {'description': 'Hourly vitals'},
        },
        'junk',
      ]);

      expect(r.activeMeds, hasLength(2));
      expect(
        r.activeMeds.map((o) => (o['details'] as Map)['medication_name']),
        containsAll(['Amoxicillin', 'Vancomycin infusion']),
      );
      expect(r.pendingResults, hasLength(2));
      expect(
        r.pendingResults.map((o) => (o['details'] as Map)['test_name']),
        containsAll(['CBC', 'Chest X-ray']),
      );
    });

    test('empty input yields empty buckets', () {
      final r = partitionOrdersForSummary(const []);
      expect(r.activeMeds, isEmpty);
      expect(r.pendingResults, isEmpty);
    });
  });

  group('latestVitalsLine', () {
    test('compacts a full row and skips missing values', () {
      final line = latestVitalsLine({
        'systolic_bp': 120,
        'diastolic_bp': 80,
        'heart_rate': 82,
        'spo2': 98,
        'temperature': 37.0,
        'respiratory_rate': 18,
      });
      expect(line, 'BP 120/80 · HR 82 · SpO2 98% · T 98.6 °F · RR 18');
    });

    test('temperature converts canonical °C to a unit-labelled °F', () {
      expect(latestVitalsLine({'temperature': 37.0}), 'T 98.6 °F');
      expect(latestVitalsLine({'temperature': '36.5'}), 'T 97.7 °F');
    });

    test(
      'implausible-as-°C temperature renders raw without a fabricated unit',
      () {
        // A legacy raw-°F residue row must not display as ~209 °F.
        expect(latestVitalsLine({'temperature': 98.6}), 'T 98.6');
      },
    );

    test('tolerates legacy bp field spellings', () {
      final line = latestVitalsLine({'bp_systolic': 110, 'bp_diastolic': 70});
      expect(line, 'BP 110/70');
    });

    test('partial rows render partial lines; null renders empty', () {
      expect(latestVitalsLine({'heart_rate': 90}), 'HR 90');
      expect(latestVitalsLine(null), '');
      expect(latestVitalsLine({}), '');
    });

    test('BP needs both numbers', () {
      expect(latestVitalsLine({'systolic_bp': 120}), '');
    });
  });

  group('summarizeAllergies', () {
    test('dedupes case-insensitively and appends severity', () {
      final out = summarizeAllergies([
        {'allergy': 'Penicillin', 'severity': 'severe'},
        {'allergy_name': 'penicillin'},
        {'name': 'Sulfa'},
        'Latex',
        {'allergy': '  '},
      ]);
      expect(out, ['Penicillin (severe)', 'Sulfa', 'Latex']);
    });

    test('caps the list', () {
      final out = summarizeAllergies([
        for (var i = 0; i < 20; i++) 'Allergen $i',
      ], cap: 5);
      expect(out, hasLength(5));
    });

    test(
      'reads the unified endpoint shape ({allergen, severity, sources})',
      () {
        final out = summarizeAllergies([
          {
            'allergen': 'Penicillin',
            'severity': 'SEVERE',
            'sources': ['patient_allergies', 'users.allergies'],
          },
          {
            'allergen': 'Dust mites',
            'severity': null,
            'sources': ['users.allergies'],
          },
        ]);
        expect(out, ['Penicillin (SEVERE)', 'Dust mites']);
      },
    );
  });

  group('extractBoardEntry', () {
    test('finds the admission row across envelope spellings', () {
      for (final key in ['admissions', 'patients', 'items', 'data']) {
        final entry = extractBoardEntry({
          key: [
            {
              'admission_id': 7,
              'patient': {'uid': 'uid-1', 'name': 'Ravi'},
            },
          ],
        }, 'uid-1');
        expect(entry, isNotNull, reason: key);
        expect(entry!['admission_id'], 7);
      }
    });

    test('matches top-level patient_uid rows too', () {
      final entry = extractBoardEntry({
        'admissions': [
          {'patient_uid': 'uid-2', 'admission_id': 9},
        ],
      }, 'uid-2');
      expect(entry!['admission_id'], 9);
    });

    test('returns null when the patient is not on the board', () {
      expect(extractBoardEntry({'admissions': const []}, 'uid-3'), isNull);
      expect(extractBoardEntry(const {}, 'uid-3'), isNull);
    });
  });
}
