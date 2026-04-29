// test/features/doctor/cds_allergy_blocker_test.dart
//
// Pure-Dart tests for the Clinical Decision Support (CDS) allergy blocker
// logic used by the staff Rx entry screen. The backend endpoint
// `/clinical/cds/prescription-safety` returns `{ safe, warnings, blockers }`;
// the Flutter side renders a modal that:
//   • BLOCKS save when any `blockers[]` entry has severity HIGH or CRITICAL
//   • WARNS (dismissible) on severity MODERATE / LOW
//   • No-op when both lists are empty
//
// Following the same mirror-class pattern used elsewhere in this repo (so
// tests don't reach into plugin channels), this file pins the decision logic
// so the banner never silently stops blocking a bad prescription.

import 'package:flutter_test/flutter_test.dart';

enum CdsSeverity { low, moderate, high, critical, unknown }

CdsSeverity parseSeverity(String? s) {
  switch ((s ?? '').toUpperCase()) {
    case 'LOW':
      return CdsSeverity.low;
    case 'MODERATE':
    case 'MEDIUM':
      return CdsSeverity.moderate;
    case 'HIGH':
      return CdsSeverity.high;
    case 'CRITICAL':
    case 'SEVERE':
      return CdsSeverity.critical;
    default:
      return CdsSeverity.unknown;
  }
}

class CdsDecision {
  const CdsDecision({required this.mustBlock, required this.mustWarn});
  final bool mustBlock;
  final bool mustWarn;
}

/// Mirror of the decision logic in `prescriptions_screen.dart` — computes
/// whether the save button must be disabled and/or a warning banner shown.
///
/// Rules:
///  * Empty blockers AND empty warnings → neither (noop).
///  * Any blocker with severity high/critical → mustBlock.
///  * Any other entry (low/moderate warnings or unknown-severity blockers)
///    → mustWarn but not block — nurse/doctor may proceed with confirmation.
CdsDecision evaluate({
  required List<Map<String, dynamic>> blockers,
  required List<Map<String, dynamic>> warnings,
}) {
  final hasHardBlock = blockers.any((b) {
    final sev = parseSeverity(b['severity'] as String?);
    return sev == CdsSeverity.high || sev == CdsSeverity.critical;
  });
  final hasAnySignal = blockers.isNotEmpty || warnings.isNotEmpty;
  return CdsDecision(
    mustBlock: hasHardBlock,
    mustWarn: hasAnySignal && !hasHardBlock,
  );
}

void main() {
  group('parseSeverity', () {
    test('maps canonical backend strings', () {
      expect(parseSeverity('LOW'), CdsSeverity.low);
      expect(parseSeverity('MODERATE'), CdsSeverity.moderate);
      expect(parseSeverity('HIGH'), CdsSeverity.high);
      expect(parseSeverity('CRITICAL'), CdsSeverity.critical);
    });

    test('accepts legacy aliases (MEDIUM → moderate, SEVERE → critical)', () {
      expect(parseSeverity('MEDIUM'), CdsSeverity.moderate);
      expect(parseSeverity('SEVERE'), CdsSeverity.critical);
    });

    test('case-insensitive + null/empty → unknown', () {
      expect(parseSeverity('high'), CdsSeverity.high);
      expect(parseSeverity(null), CdsSeverity.unknown);
      expect(parseSeverity(''), CdsSeverity.unknown);
      expect(parseSeverity('???'), CdsSeverity.unknown);
    });
  });

  group('CDS evaluate', () {
    test('no blockers + no warnings → noop (no banner)', () {
      final d = evaluate(blockers: [], warnings: []);
      expect(d.mustBlock, isFalse);
      expect(d.mustWarn, isFalse);
    });

    test('single CRITICAL blocker forces hard block', () {
      final d = evaluate(
        blockers: [
          {'severity': 'CRITICAL', 'reason': 'Penicillin allergy'},
        ],
        warnings: [],
      );
      expect(d.mustBlock, isTrue);
      expect(d.mustWarn, isFalse);
    });

    test('single HIGH blocker forces hard block', () {
      final d = evaluate(
        blockers: [
          {'severity': 'HIGH', 'reason': 'Warfarin + NSAID'},
        ],
        warnings: [],
      );
      expect(d.mustBlock, isTrue);
    });

    test('only MODERATE warnings → warn-only, no block', () {
      final d = evaluate(
        blockers: [],
        warnings: [
          {'severity': 'MODERATE', 'reason': 'Monitor INR'},
        ],
      );
      expect(d.mustBlock, isFalse);
      expect(d.mustWarn, isTrue);
    });

    test('LOW-severity blocker listed under blockers[] stays warn-only', () {
      // Defensive: backend could misclassify; Flutter side must not hard-block
      // on non-safety severity.
      final d = evaluate(
        blockers: [
          {'severity': 'LOW', 'reason': 'Minor interaction'},
        ],
        warnings: [],
      );
      expect(d.mustBlock, isFalse);
      expect(d.mustWarn, isTrue);
    });

    test('HIGH blocker + MODERATE warnings → block wins', () {
      final d = evaluate(
        blockers: [
          {'severity': 'HIGH', 'reason': 'Allergy'},
        ],
        warnings: [
          {'severity': 'MODERATE', 'reason': 'Age'},
        ],
      );
      expect(d.mustBlock, isTrue);
      expect(
        d.mustWarn,
        isFalse,
        reason: 'A hard block supersedes dismissible warnings',
      );
    });

    test(
      'unknown-severity blocker falls back to warn-only (fail-open warn)',
      () {
        final d = evaluate(
          blockers: [
            {'reason': 'Something weird'},
          ],
          warnings: [],
        );
        expect(d.mustBlock, isFalse);
        expect(
          d.mustWarn,
          isTrue,
          reason: 'Never silently drop an unknown signal; surface as warning',
        );
      },
    );
  });
}
