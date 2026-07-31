import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/clinical_continuity_action_policy.dart';

void main() {
  test('wire dispositions are closed and round-trip exactly', () {
    for (final disposition in ClinicalContinuityActionDisposition.values) {
      expect(
        ClinicalContinuityActionDisposition.fromWireName(disposition.wireName),
        disposition,
      );
    }

    expect(
      ClinicalContinuityActionDisposition.fromWireName('queueable'),
      isNull,
    );
    expect(ClinicalContinuityActionDisposition.fromWireName(null), isNull);
  });

  test('only the two electronic draft dispositions expose capabilities', () {
    final queueable = _rule(
      ClinicalContinuityActionDisposition.queueableCapture,
    );
    final local = _rule(ClinicalContinuityActionDisposition.localDraftOnly);
    final paper = _rule(ClinicalContinuityActionDisposition.paperOnlyBackfill);
    final blocked = _rule(
      ClinicalContinuityActionDisposition.blockedElectronic,
    );
    final denied = _rule(ClinicalContinuityActionDisposition.defaultDeny);

    expect(queueable.isQueueable, isTrue);
    expect(queueable.isLocalDraftOnly, isFalse);
    expect(local.isLocalDraftOnly, isTrue);
    expect(local.isQueueable, isFalse);
    for (final rule in [paper, blocked, denied]) {
      expect(rule.isQueueable, isFalse);
      expect(rule.isLocalDraftOnly, isFalse);
    }
  });
}

ClinicalContinuityActionRule _rule(
  ClinicalContinuityActionDisposition disposition,
) {
  return ClinicalContinuityActionRule(
    actionId: 'test',
    disposition: disposition,
    captureReady: true,
    actionVersion: 1,
    actionChecksum: 'a' * 64,
    actionSchemaId: 'test.v1',
    actionSchemaVersion: 1,
    actionSchemaChecksum: 'b' * 64,
    allowedRoles: const {'NURSING_STAFF'},
    requiredCapabilityGroups: const {},
  );
}
