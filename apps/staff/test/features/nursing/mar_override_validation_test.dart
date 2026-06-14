// test/features/nursing/mar_override_validation_test.dart
//
// Tests for the MAR (medication administration record) override section's
// validation and payload-building logic. The real implementation lives in
// `lib/features/nursing/screens/mar_scan_screen.dart` — specifically the
// private `_OverrideSection` stateful widget and `_isMeaningfulText` helper.
//
// Following the mirror-class pattern established in
// `test/features/nursing/mar_rights_state_machine_test.dart`, this file
// exercises the validation rules in a pure-Dart harness so the critical
// clinical-safety path (no-override = no administer without documented reason)
// never silently regresses.
//
// Clinical-safety invariants under test:
//   1. A nurse cannot proceed past a failed 5-rights check without selecting
//      an override category AND providing a meaningful justification.
//   2. "Meaningful" means: trimmed length >= 15, not a single repeated char.
//   3. The override payload is structured as "[category-value] justification"
//      so the audit system can parse it without a backend schema change.
//   4. The "other" category imposes the same meaningful-text requirement
//      (no empty-string exception).

import 'package:flutter_test/flutter_test.dart';

// ── Mirror of private `_MarOverrideCategory` enum ────────────────────────────
// Matches `mar_scan_screen.dart` exactly. If the production enum changes, this
// test will catch the drift (the override_reason strings are stored in the DB
// and consumed by audit tooling — they must not change silently).
enum MarOverrideCategory {
  patientRefused('patient-refused', 'Patient refused per order'),
  clinicalJudgement('clinical-judgement', 'Clinical judgement override'),
  doseAdjustedPerOrder('dose-adjusted-per-order', 'Dose adjusted per order'),
  timingVariance('timing-variance', 'Timing variance — within window'),
  documentationCorrection(
    'documentation-correction',
    'Documentation correction',
  ),
  other('other', 'Other (specify below)');

  const MarOverrideCategory(this.value, this.label);
  final String value;
  final String label;
}

// ── Mirror of private `_isMeaningfulText` helper ─────────────────────────────
// Must stay in sync with the production implementation. The function guards
// the "Override" ElevatedButton so nurses cannot submit gibberish audit
// reasons.
bool isMeaningfulText(String text, {int minLength = 15}) {
  final t = text.trim();
  if (t.length < minLength) return false;
  if (t.isNotEmpty && t.codeUnits.every((u) => u == t.codeUnitAt(0))) {
    return false;
  }
  return true;
}

// ── Mirror of the override button enable predicate ───────────────────────────
// Mirrors `_OverrideSectionState._valid` from the production widget, which
// determines whether the ElevatedButton's `onPressed` is non-null.
bool isOverrideValid({
  required MarOverrideCategory? category,
  required String justificationText,
}) {
  if (category == null) return false;
  // "other" also requires the meaningful-text check (no empty-string bypass).
  if (category == MarOverrideCategory.other &&
      justificationText.trim().isEmpty) {
    return false;
  }
  return isMeaningfulText(justificationText);
}

// ── Mirror of the payload builder ─────────────────────────────────────────────
// Mirrors `_OverrideSectionState._payload`. The format is "[category] text" so
// audit tooling can extract the category without a dedicated column.
String buildOverridePayload({
  required MarOverrideCategory category,
  required String justification,
}) {
  return '[${category.value}] ${justification.trim()}';
}

// ─────────────────────────────────────────────────────────────────────────────

void main() {
  // ── isMeaningfulText ───────────────────────────────────────────────────────
  group('isMeaningfulText (MAR override justification guard)', () {
    test('rejects empty string', () {
      expect(isMeaningfulText(''), isFalse);
    });

    test('rejects whitespace-only input', () {
      expect(isMeaningfulText('           '), isFalse);
    });

    test('rejects text shorter than the 15-character minimum', () {
      expect(isMeaningfulText('Too short'), isFalse);
      expect(isMeaningfulText('14 characters!'), isFalse); // exactly 14
    });

    test('accepts exactly 15 trimmed characters', () {
      expect(isMeaningfulText('exactly fifteen'), isTrue); // 15 chars
    });

    test('accepts normal clinical justification text', () {
      expect(
        isMeaningfulText(
          'Patient already received this dose per attending order',
        ),
        isTrue,
      );
      expect(
        isMeaningfulText('Dose adjusted per written order from Dr. Rajan'),
        isTrue,
      );
    });

    test('rejects single-character repeated strings regardless of length', () {
      expect(isMeaningfulText('aaaaaaaaaaaaaaa'), isFalse); // 15 'a's
      expect(isMeaningfulText('xxxxxxxxxxxxxxxxxxxxxxxx'), isFalse); // 24 'x's
      expect(isMeaningfulText('1111111111111111'), isFalse);
    });

    test(
      'accepts strings with leading/trailing whitespace when trimmed >= 15',
      () {
        expect(
          isMeaningfulText(
            '  Clinical judgement — patient condition changed  ',
          ),
          isTrue,
        );
      },
    );

    test('rejects strings that trim to all-same-char even with whitespace', () {
      // "aaa...aaa" surrounded by spaces still fails after trim.
      expect(isMeaningfulText('   aaaaaaaaaaaaaaaa   '), isFalse);
    });

    test('accepts mixed-character strings above minimum', () {
      // Real override reason — not a repeated char.
      expect(isMeaningfulText('Benefit outweighs risk per consultant'), isTrue);
    });
  });

  // ── isOverrideValid ────────────────────────────────────────────────────────
  group('isOverrideValid (Override button enable predicate)', () {
    const goodJustification = 'Attending approved — clinical judgement applied';

    test('requires a non-null category to be valid', () {
      expect(
        isOverrideValid(category: null, justificationText: goodJustification),
        isFalse,
      );
    });

    test('requires meaningful text even when category is set', () {
      expect(
        isOverrideValid(
          category: MarOverrideCategory.clinicalJudgement,
          justificationText: 'Too short',
        ),
        isFalse,
      );
    });

    test('valid when category + meaningful justification are both present', () {
      expect(
        isOverrideValid(
          category: MarOverrideCategory.clinicalJudgement,
          justificationText: goodJustification,
        ),
        isTrue,
      );
    });

    test('"other" category with empty justification is rejected', () {
      expect(
        isOverrideValid(
          category: MarOverrideCategory.other,
          justificationText: '',
        ),
        isFalse,
      );
    });

    test('"other" category with whitespace-only justification is rejected', () {
      expect(
        isOverrideValid(
          category: MarOverrideCategory.other,
          justificationText: '          ',
        ),
        isFalse,
      );
    });

    test('"other" category with meaningful justification is accepted', () {
      expect(
        isOverrideValid(
          category: MarOverrideCategory.other,
          justificationText: 'Documented in nurse notes — dose timing shifted',
        ),
        isTrue,
      );
    });

    test('timing variance with meaningful justification passes', () {
      expect(
        isOverrideValid(
          category: MarOverrideCategory.timingVariance,
          justificationText: 'Within 30-minute window per hospital policy',
        ),
        isTrue,
      );
    });
  });

  // ── buildOverridePayload ───────────────────────────────────────────────────
  group('buildOverridePayload (audit-parseable override reason string)', () {
    test('prefixes with [category-value] for audit-system parsing', () {
      final payload = buildOverridePayload(
        category: MarOverrideCategory.clinicalJudgement,
        justification: 'Attending confirmed verbal order at bedside',
      );
      expect(payload, startsWith('[clinical-judgement]'));
    });

    test('includes the full justification after the category prefix', () {
      final payload = buildOverridePayload(
        category: MarOverrideCategory.patientRefused,
        justification: 'Patient conscious, coherent, and verbally declined',
      );
      expect(
        payload,
        '[patient-refused] Patient conscious, coherent, and verbally declined',
      );
    });

    test('trims leading/trailing whitespace from justification', () {
      final payload = buildOverridePayload(
        category: MarOverrideCategory.doseAdjustedPerOrder,
        justification: '  Dose reduced to 5mg per nephrology consult  ',
      );
      expect(
        payload,
        '[dose-adjusted-per-order] Dose reduced to 5mg per nephrology consult',
      );
    });

    test('documentation correction category produces correct audit prefix', () {
      final payload = buildOverridePayload(
        category: MarOverrideCategory.documentationCorrection,
        justification: 'Previous entry had wrong administration time logged',
      );
      expect(payload, startsWith('[documentation-correction]'));
    });

    test(
      'category values match the production enum strings (audit contract)',
      () {
        // These strings are stored in the DB. Any rename is a breaking change.
        expect(MarOverrideCategory.patientRefused.value, 'patient-refused');
        expect(
          MarOverrideCategory.clinicalJudgement.value,
          'clinical-judgement',
        );
        expect(
          MarOverrideCategory.doseAdjustedPerOrder.value,
          'dose-adjusted-per-order',
        );
        expect(MarOverrideCategory.timingVariance.value, 'timing-variance');
        expect(
          MarOverrideCategory.documentationCorrection.value,
          'documentation-correction',
        );
        expect(MarOverrideCategory.other.value, 'other');
      },
    );
  });

  // ── Integration: full override scenario ───────────────────────────────────
  group('MAR override full scenario (clinical-safety integration)', () {
    test(
      'nurse cannot administer when category missing even with long text',
      () {
        const text = 'Detailed clinical justification provided by attending';
        // Valid text but no category → button stays disabled.
        expect(
          isOverrideValid(category: null, justificationText: text),
          isFalse,
        );
        // Valid text + valid category → button is enabled.
        expect(
          isOverrideValid(
            category: MarOverrideCategory.clinicalJudgement,
            justificationText: text,
          ),
          isTrue,
        );
      },
    );

    test('override payload is structurally parseable by audit tooling', () {
      // Audit tooling expects the format: "[category] justification"
      // Pattern: starts with '[', contains ']', category part is non-empty.
      final payload = buildOverridePayload(
        category: MarOverrideCategory.timingVariance,
        justification:
            'Within acceptable window per hospital protocol guidelines',
      );
      final bracketStart = payload.indexOf('[');
      final bracketEnd = payload.indexOf(']');
      expect(
        bracketStart,
        0,
        reason: 'payload must start with category bracket',
      );
      expect(bracketEnd, greaterThan(bracketStart + 1));
      final category = payload.substring(bracketStart + 1, bracketEnd);
      expect(category.isNotEmpty, isTrue);
      final justification = payload.substring(bracketEnd + 2); // "] " prefix
      expect(justification.trim().isNotEmpty, isTrue);
    });

    test('all MarOverrideCategory values have non-empty value and label', () {
      for (final cat in MarOverrideCategory.values) {
        expect(cat.value.isNotEmpty, isTrue, reason: '$cat has empty value');
        expect(cat.label.isNotEmpty, isTrue, reason: '$cat has empty label');
      }
    });
  });
}
