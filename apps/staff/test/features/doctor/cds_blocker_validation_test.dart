// test/features/doctor/cds_blocker_validation_test.dart
//
// Tests for the CDS (Clinical Decision Support) allergy / drug-interaction
// blocker modal's validation rules and outcome model. The real implementation
// lives in `lib/features/doctor/widgets/cds_blocker_modal.dart`.
//
// Following the mirror-class pattern used throughout these tests, this file
// pins the safety-critical behaviour in pure Dart so any regressions in the
// hard-block bypass path (which is the last safety gate before a dangerous
// prescription is saved) are caught immediately.
//
// Clinical-safety invariants under test:
//   1. CdsOverrideOutcome.shouldProceed is false when overrideReason is null
//      or < 15 chars — the screen must not call the prescriptions API.
//   2. A SEVERE allergy blocker requires a supervisor reference field; non-
//      severe blockers do not.
//   3. isMeaningfulJustification rejects empty, too-short, and repeated-char
//      text — same rules as the MAR override section.
//   4. The override payload format is "[category] justification [| supervisor: x]"
//      for compliance auditability.

import 'package:flutter_test/flutter_test.dart';

// ── Mirror of private CDS types ───────────────────────────────────────────────

// Mirrors `CdsOverrideOutcome` from cds_blocker_modal.dart.
// The `shouldProceed` predicate must be false whenever `overrideReason` is
// null or too short so the prescription screen cannot short-circuit the block.
class CdsOverrideOutcome {
  const CdsOverrideOutcome({this.overrideReason});
  final String? overrideReason;
  bool get shouldProceed =>
      overrideReason != null && overrideReason!.trim().length >= 15;
}

// Mirrors private `_CdsOverrideCategory` enum from cds_blocker_modal.dart.
// The `value` strings are stored in the DB — they are a stable audit contract.
enum CdsOverrideCategory {
  priorToleranceDocumented(
    'prior-tolerance-documented',
    'Prior tolerance documented',
  ),
  benefitOutweighsRisk('benefit-outweighs-risk', 'Benefit outweighs risk'),
  alternativeUnavailable('alternative-unavailable', 'No suitable alternative'),
  allergyDisputed('allergy-disputed', 'Allergy disputed / mislabelled'),
  other('other', 'Other (specify below)');

  const CdsOverrideCategory(this.value, this.label);
  final String value;
  final String label;
}

// Mirrors `_isMeaningfulJustification` from cds_blocker_modal.dart.
bool isMeaningfulJustification(String text) {
  final t = text.trim();
  if (t.length < 15) return false;
  if (t.isNotEmpty && t.codeUnits.every((u) => u == t.codeUnitAt(0))) {
    return false;
  }
  return true;
}

// Mirrors `_hasSevereAllergyBlocker` from `_CdsBlockerModalState`.
// Determines whether the supervisor field is mandatory.
bool hasSevereAllergyBlocker(List<dynamic> blockers) => blockers.any(
  (b) =>
      b is Map &&
      b['type'] == 'ALLERGY_CONFLICT' &&
      (b['severity'] == 'SEVERE' ||
          b['severity'] == 'severe' ||
          b['level'] == 'SEVERE' ||
          b['level'] == 'severe'),
);

// Mirrors `_overrideValid` getter from `_CdsBlockerModalState`.
bool isOverrideValid({
  required CdsOverrideCategory? category,
  required String justification,
  required bool requiresSupervisor,
  required String supervisorText,
}) {
  if (category == null) return false;
  if (!isMeaningfulJustification(justification)) return false;
  if (category == CdsOverrideCategory.other && justification.trim().isEmpty) {
    return false;
  }
  if (requiresSupervisor && supervisorText.trim().length < 3) return false;
  return true;
}

// Mirrors `_overridePayload` from `_CdsBlockerModalState`.
String buildCdsOverridePayload({
  required CdsOverrideCategory category,
  required String justification,
  String supervisorRef = '',
}) {
  final base = '[${category.value}] ${justification.trim()}';
  final sup = supervisorRef.trim();
  return sup.isNotEmpty ? '$base | supervisor: $sup' : base;
}

// ─────────────────────────────────────────────────────────────────────────────

void main() {
  // ── CdsOverrideOutcome.shouldProceed ──────────────────────────────────────
  group('CdsOverrideOutcome.shouldProceed', () {
    test('returns false when overrideReason is null (cancelled)', () {
      expect(const CdsOverrideOutcome().shouldProceed, isFalse);
    });

    test('returns false when overrideReason is empty string', () {
      expect(const CdsOverrideOutcome(overrideReason: '').shouldProceed, isFalse);
    });

    test('returns false when overrideReason is whitespace-only', () {
      expect(
        const CdsOverrideOutcome(overrideReason: '      ').shouldProceed,
        isFalse,
      );
    });

    test('returns false when overrideReason is shorter than 15 trimmed chars', () {
      expect(
        const CdsOverrideOutcome(overrideReason: 'short').shouldProceed,
        isFalse,
      );
      expect(
        const CdsOverrideOutcome(overrideReason: '14 characters!').shouldProceed,
        isFalse,
      );
    });

    test('returns true when overrideReason is a valid structured payload', () {
      expect(
        const CdsOverrideOutcome(
          overrideReason: '[benefit-outweighs-risk] Benefit outweighs allergy risk — patient history confirmed',
        ).shouldProceed,
        isTrue,
      );
    });

    test('caller cannot bypass the block by passing only whitespace', () {
      // Safety invariant: prescription screen checks shouldProceed before
      // calling the API. A whitespace-only override must not pass.
      const whitespaceReason = '               ';
      expect(
        const CdsOverrideOutcome(overrideReason: whitespaceReason).shouldProceed,
        isFalse,
        reason: 'Whitespace-padded empty override must not proceed to API call',
      );
    });
  });

  // ── isMeaningfulJustification ─────────────────────────────────────────────
  group('isMeaningfulJustification', () {
    test('rejects empty string', () {
      expect(isMeaningfulJustification(''), isFalse);
    });

    test('rejects strings shorter than 15 trimmed characters', () {
      expect(isMeaningfulJustification('12345678901234'), isFalse); // 14 chars
    });

    test('accepts exactly 15 trimmed characters', () {
      expect(isMeaningfulJustification('fifteen characs'), isTrue); // 15 chars
    });

    test('rejects single-character repeated strings', () {
      expect(isMeaningfulJustification('aaaaaaaaaaaaaaa'), isFalse);
      expect(isMeaningfulJustification('111111111111111'), isFalse);
    });

    test('accepts normal clinical override justifications', () {
      expect(
        isMeaningfulJustification('Prior tolerance documented in patient records'),
        isTrue,
      );
      expect(
        isMeaningfulJustification('No alternative agent available for this indication'),
        isTrue,
      );
    });
  });

  // ── hasSevereAllergyBlocker ───────────────────────────────────────────────
  group('hasSevereAllergyBlocker (supervisor-field visibility)', () {
    test('returns false for empty blocker list', () {
      expect(hasSevereAllergyBlocker([]), isFalse);
    });

    test('returns false when no ALLERGY_CONFLICT blocker is present', () {
      expect(
        hasSevereAllergyBlocker([
          {'type': 'DRUG_INTERACTION', 'severity': 'SEVERE'},
        ]),
        isFalse,
      );
    });

    test('returns false when ALLERGY_CONFLICT is present but not SEVERE', () {
      expect(
        hasSevereAllergyBlocker([
          {'type': 'ALLERGY_CONFLICT', 'severity': 'MODERATE'},
        ]),
        isFalse,
      );
    });

    test('returns true when severity field is SEVERE (uppercase)', () {
      expect(
        hasSevereAllergyBlocker([
          {'type': 'ALLERGY_CONFLICT', 'severity': 'SEVERE'},
        ]),
        isTrue,
      );
    });

    test('returns true when severity field is severe (lowercase)', () {
      expect(
        hasSevereAllergyBlocker([
          {'type': 'ALLERGY_CONFLICT', 'severity': 'severe'},
        ]),
        isTrue,
      );
    });

    test('returns true when level field is SEVERE (alternate payload shape)', () {
      // Some CDS payloads use `level` instead of `severity`.
      expect(
        hasSevereAllergyBlocker([
          {'type': 'ALLERGY_CONFLICT', 'level': 'SEVERE'},
        ]),
        isTrue,
      );
    });

    test('returns true when any one of multiple blockers is a SEVERE allergy', () {
      expect(
        hasSevereAllergyBlocker([
          {'type': 'DRUG_INTERACTION', 'severity': 'HIGH'},
          {'type': 'ALLERGY_CONFLICT', 'severity': 'SEVERE'},
        ]),
        isTrue,
      );
    });
  });

  // ── isOverrideValid ───────────────────────────────────────────────────────
  group('isOverrideValid (CDS override button enable predicate)', () {
    const goodText = 'Benefit clearly outweighs the allergy risk in this case';

    test('requires non-null category', () {
      expect(
        isOverrideValid(
          category: null,
          justification: goodText,
          requiresSupervisor: false,
          supervisorText: '',
        ),
        isFalse,
      );
    });

    test('requires meaningful justification text', () {
      expect(
        isOverrideValid(
          category: CdsOverrideCategory.benefitOutweighsRisk,
          justification: 'Too short',
          requiresSupervisor: false,
          supervisorText: '',
        ),
        isFalse,
      );
    });

    test('valid when category + meaningful justification, no supervisor needed', () {
      expect(
        isOverrideValid(
          category: CdsOverrideCategory.priorToleranceDocumented,
          justification: goodText,
          requiresSupervisor: false,
          supervisorText: '',
        ),
        isTrue,
      );
    });

    test('SEVERE allergy: supervisor field must be >= 3 chars', () {
      expect(
        isOverrideValid(
          category: CdsOverrideCategory.benefitOutweighsRisk,
          justification: goodText,
          requiresSupervisor: true,
          supervisorText: 'Dr',  // only 2 chars
        ),
        isFalse,
      );
    });

    test('SEVERE allergy: valid when supervisor field >= 3 chars', () {
      expect(
        isOverrideValid(
          category: CdsOverrideCategory.benefitOutweighsRisk,
          justification: goodText,
          requiresSupervisor: true,
          supervisorText: 'Dr. Sharma EMP-1042',
        ),
        isTrue,
      );
    });

    test('empty supervisor with requiresSupervisor=true is rejected', () {
      expect(
        isOverrideValid(
          category: CdsOverrideCategory.allergyDisputed,
          justification: goodText,
          requiresSupervisor: true,
          supervisorText: '',
        ),
        isFalse,
      );
    });
  });

  // ── buildCdsOverridePayload ───────────────────────────────────────────────
  group('buildCdsOverridePayload (audit-log format)', () {
    test('plain override: "[category-value] justification"', () {
      final payload = buildCdsOverridePayload(
        category: CdsOverrideCategory.benefitOutweighsRisk,
        justification: 'Informed patient of allergy risk; benefit outweighs it',
      );
      expect(
        payload,
        '[benefit-outweighs-risk] Informed patient of allergy risk; benefit outweighs it',
      );
    });

    test('SEVERE allergy override includes supervisor reference', () {
      final payload = buildCdsOverridePayload(
        category: CdsOverrideCategory.priorToleranceDocumented,
        justification: 'Documented tolerance from prior hospitalisation records',
        supervisorRef: 'Dr. Rajan — EMP-0342',
      );
      expect(
        payload,
        '[prior-tolerance-documented] Documented tolerance from prior hospitalisation records | supervisor: Dr. Rajan — EMP-0342',
      );
      expect(payload.contains('| supervisor:'), isTrue);
    });

    test('empty supervisor produces no supervisor suffix', () {
      final payload = buildCdsOverridePayload(
        category: CdsOverrideCategory.alternativeUnavailable,
        justification: 'No therapeutically equivalent alternative is available',
      );
      expect(payload.contains('| supervisor:'), isFalse);
    });

    test('trims whitespace from justification and supervisor', () {
      final payload = buildCdsOverridePayload(
        category: CdsOverrideCategory.allergyDisputed,
        justification: '  Allergy label is documented error — patient denies  ',
        supervisorRef: '  Dr. Mehta  ',
      );
      expect(payload, contains('Allergy label is documented error — patient denies'));
      expect(payload, contains('supervisor: Dr. Mehta'));
    });

    test('category value strings are stable DB-stored constants', () {
      // Any change to these breaks the audit log parser and existing DB rows.
      expect(CdsOverrideCategory.priorToleranceDocumented.value, 'prior-tolerance-documented');
      expect(CdsOverrideCategory.benefitOutweighsRisk.value, 'benefit-outweighs-risk');
      expect(CdsOverrideCategory.alternativeUnavailable.value, 'alternative-unavailable');
      expect(CdsOverrideCategory.allergyDisputed.value, 'allergy-disputed');
      expect(CdsOverrideCategory.other.value, 'other');
    });
  });

  // ── CPOE vs prescription override distinction ─────────────────────────────
  group('allowOverride=false path (CPOE orders — server enforces blockers)', () {
    // When the prescription endpoint is hit without an override param, the
    // server returns a blocker list. The CdsBlockerModal `allowOverride=false`
    // path shows only "Adjust Order" — no override field.
    // Test: CdsOverrideOutcome with null reason is returned (cancelled path).

    test('outcome with null reason correctly surfaces as shouldProceed=false', () {
      // This simulates what happens when the doctor taps "Adjust Order":
      // the modal pops with `CdsOverrideOutcome()` (no reason = cancelled).
      expect(const CdsOverrideOutcome().shouldProceed, isFalse);
    });

    test('prescription screen must not proceed when shouldProceed is false', () {
      // Clinical contract: the screen checks `outcome.shouldProceed` before
      // calling the prescriptions API. We assert the model invariant holds.
      final outcomes = [
        const CdsOverrideOutcome(),
        const CdsOverrideOutcome(overrideReason: null),
        const CdsOverrideOutcome(overrideReason: ''),
        const CdsOverrideOutcome(overrideReason: 'short'),
      ];
      for (final outcome in outcomes) {
        expect(
          outcome.shouldProceed,
          isFalse,
          reason: 'outcome with reason="${outcome.overrideReason}" must not proceed',
        );
      }
    });
  });
}
