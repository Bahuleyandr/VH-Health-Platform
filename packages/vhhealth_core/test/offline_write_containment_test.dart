import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/offline_write_containment.dart';

void main() {
  group('OfflineWriteContainment', () {
    const contained = <(String, String, OfflineWriteActionFamily, String)>[
      (
        'POST',
        '/prescriptions/create',
        OfflineWriteActionFamily.prescriptionCreate,
        'contained_prescription_create',
      ),
      (
        'POST',
        '/emr/orders',
        OfflineWriteActionFamily.drugChartOrder,
        'contained_drug_chart_order',
      ),
      (
        'POST',
        '/clinical/mar/0/administer-with-scan',
        OfflineWriteActionFamily.marAdministration,
        'contained_mar_administration',
      ),
      (
        'POST',
        '/lab/samples/42/collect',
        OfflineWriteActionFamily.specimenCollection,
        'contained_specimen_collection',
      ),
      (
        'POST',
        '/blood-bank/9/verify-bedside',
        OfflineWriteActionFamily.transfusionVerification,
        'contained_transfusion_verification',
      ),
      (
        'POST',
        '/emr/notes',
        OfflineWriteActionFamily.authoritativeNote,
        'contained_authoritative_note',
      ),
    ];

    for (final item in contained) {
      test('${item.$1} ${item.$2} is contained', () {
        final result = OfflineWriteContainment.classify(
          method: item.$1,
          path: item.$2,
        );
        expect(result.family, item.$3);
        expect(result.reviewReasonCode, item.$4);
        expect(result.isContained, isTrue);
        expect(result.isEnqueueAllowed, isFalse);
      });
    }

    test('normalizes method case only', () {
      expect(
        OfflineWriteContainment.classify(
          method: 'post',
          path: '/prescriptions/create',
        ).family,
        OfflineWriteActionFamily.prescriptionCreate,
      );
      expect(
        OfflineWriteContainment.classify(
          method: ' post ',
          path: '/prescriptions/create',
        ).family,
        OfflineWriteActionFamily.unknown,
      );
    });

    test('all nine frozen note categories share the route-only containment', () {
      // `classify` deliberately has no body or note_type input. These are the
      // exact nine values from the frozen Staff census; each therefore receives
      // the same authoritative-note result solely from method + route.
      const categories = [
        'Observation',
        'Medication Note',
        'Post-Procedure',
        'Intake/Output',
        'Patient Complaint',
        'Wound Care',
        'Shift Handover',
        'Emergency Note',
        'Other',
      ];
      for (final noteType in categories) {
        expect(
          OfflineWriteContainment.classify(
            method: 'POST',
            path: '/emr/notes',
          ).family,
          OfflineWriteActionFamily.authoritativeNote,
          reason: '$noteType must not select a different replay family',
        );
      }
    });

    test('recognizes only the two unchanged controls', () {
      final vitals = OfflineWriteContainment.classify(
        method: 'POST',
        path: '/health/records',
      );
      final draft = OfflineWriteContainment.classify(
        method: 'PUT',
        path: '/emr/notes/draft',
      );
      expect(vitals.family, OfflineWriteActionFamily.vitals);
      expect(draft.family, OfflineWriteActionFamily.noteDraft);
      expect(vitals.isControl, isTrue);
      expect(draft.isControl, isTrue);
      expect(vitals.isEnqueueAllowed, isTrue);
      expect(draft.isEnqueueAllowed, isTrue);
    });

    test('wrong methods fail closed', () {
      for (final item in contained) {
        expect(
          OfflineWriteContainment.classify(
            method: item.$1 == 'POST' ? 'PUT' : 'POST',
            path: item.$2,
          ).family,
          OfflineWriteActionFamily.unknown,
        );
      }
      expect(
        OfflineWriteContainment.classify(
          method: 'POST',
          path: '/emr/notes/draft',
        ).family,
        OfflineWriteActionFamily.unknown,
      );
    });

    test('decorated and lookalike paths fail closed', () {
      const invalid = [
        'https://api.vhhealth.app/prescriptions/create',
        '//api.vhhealth.app/prescriptions/create',
        '/prescriptions/create?x=1',
        '/prescriptions/create#fragment',
        '/prescriptions/create/',
        '/api/v1/prescriptions/create',
        r'\prescriptions\create',
        '/prescriptions/create-more',
        '/x/prescriptions/create',
        '/emr/orders/bulk',
        '/emr/notes-draft',
        '/health/records/1',
      ];
      for (final path in invalid) {
        expect(
          OfflineWriteContainment.classify(method: 'POST', path: path).family,
          OfflineWriteActionFamily.unknown,
          reason: path,
        );
      }
    });

    test('integer route segments require canonical non-negative decimals', () {
      const invalidIds = ['', '-1', '+1', '01', '1.0', '1e2', '%31', 'abc'];
      for (final id in invalidIds) {
        expect(
          OfflineWriteContainment.classify(
            method: 'POST',
            path: '/clinical/mar/$id/administer-with-scan',
          ).family,
          OfflineWriteActionFamily.unknown,
          reason: id,
        );
      }
      expect(
        OfflineWriteContainment.classify(
          method: 'POST',
          path: '/clinical/mar/1/administer-with-scan/extra',
        ).family,
        OfflineWriteActionFamily.unknown,
      );
    });

    test('unknown action defaults to deny with typed reason', () {
      final result = OfflineWriteContainment.classify(
        method: 'PATCH',
        path: '/some/future/clinical-action',
      );
      expect(result.family, OfflineWriteActionFamily.unknown);
      expect(result.isKnown, isFalse);
      expect(result.isEnqueueAllowed, isFalse);
      expect(result.reviewReasonCode, 'unknown_action');
    });

    test('reconciled-discard guard covers the wider clinical evidence set', () {
      for (final item in contained) {
        expect(
          OfflineWriteContainment.requiresReconciledDiscard(
            method: item.$1,
            path: item.$2,
          ),
          isTrue,
        );
      }
      expect(
        OfflineWriteContainment.requiresReconciledDiscard(
          method: 'POST',
          path: '/health/records',
        ),
        isTrue,
      );
      for (final route in const [
        ('PUT', '/emr/notes/draft'),
        ('DELETE', '/emr/notes/draft'),
        ('PUT', '/emr/notes/7'),
        ('POST', '/emr/notes/7/sign'),
        ('PATCH', '/emr/notes/7'),
      ]) {
        expect(
          OfflineWriteContainment.requiresReconciledDiscard(
            method: route.$1,
            path: route.$2,
          ),
          isTrue,
          reason: '${route.$1} ${route.$2}',
        );
      }
      expect(
        OfflineWriteContainment.requiresReconciledDiscard(
          method: 'GET',
          path: '/emr/notes/7',
        ),
        isFalse,
      );
    });
  });
}
