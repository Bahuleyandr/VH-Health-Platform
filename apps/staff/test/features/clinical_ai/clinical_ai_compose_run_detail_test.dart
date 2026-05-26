import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/clinical_ai/screens/clinical_ai_compose_run_detail_screen.dart';

void main() {
  group('normalizeComposeRunDetail', () {
    test('unwraps the backend run envelope and keeps children attached', () {
      final detail = normalizeComposeRunDetail({
        'run': {
          'id': 501,
          'status': 'paused',
          'admission_id': 8801,
          'pause_reason': 'await_governance',
        },
        'children': [
          {'id': 7101, 'module_key': 'medication_reconciliation'},
          {'id': 7102, 'module_key': 'patient_aftercare_instructions'},
        ],
        'child_count': 2,
      });

      expect(detail['id'], 501);
      expect(detail['status'], 'paused');
      expect(detail['admission_id'], 8801);
      expect(detail['children'], isA<List>());
      expect(detail['children'], hasLength(2));
      expect(detail['child_count'], 2);
    });

    test(
      'preserves initial list-row fields while detail loads partial data',
      () {
        final detail = normalizeComposeRunDetail(
          {
            'children': [
              {'id': 7101, 'status': 'completed'},
            ],
          },
          fallbackRun: {'id': 501, 'status': 'paused', 'admission_id': 8801},
        );

        expect(detail['id'], 501);
        expect(detail['status'], 'paused');
        expect(detail['admission_id'], 8801);
        expect(detail['children'], hasLength(1));
        expect(detail['child_count'], 1);
      },
    );
  });
}
