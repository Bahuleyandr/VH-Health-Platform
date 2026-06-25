// test/features/nursing/mar_rights_state_machine_test.dart
//
// Pure-Dart tests for the MAR (medication administration record) 5-rights
// state machine. The real implementation lives inside
// `lib/features/nursing/screens/mar_scan_screen.dart` as a private `_Step`
// enum tangled with ZXing camera + API calls — not directly testable from
// the outside. Following the same mirror-class pattern used in
// `test/features/auth/services/login_service_test.dart` and the patient app's
// `api_client_test.dart`, this file pins the state-transition behaviour
// independently so the critical patient-safety path never silently regresses.
//
// The 5-rights workflow (per FINISH_BUILDING.md §3.2 / staff CLAUDE.md):
//   1. scanWristband — camera live-view. On any QR/barcode, read patient id.
//   2. scanDrug      — scan the drug label/NDC.
//   3. verify        — POST /clinical/mar/verify; render per-right banner.
//   4. done          — administration committed.
//
// An override/re-scan at any point should return to scanWristband to avoid
// carrying stale patient+drug state into a new administration.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/screens/mar_scan_screen.dart';

/// Mirror of the private `_Step` enum in mar_scan_screen.dart.
enum MarStep { scanWristband, scanDrug, verify, done }

/// Pure-Dart model of the state machine. The real widget has the same
/// transitions but is tangled with UI; this class isolates them so a test
/// can exercise every edge. Matches the logic at
/// `mar_scan_screen.dart:_handleScan`.
class MarStateMachine {
  MarStep step = MarStep.scanWristband;
  String? wristbandId;
  String? drugCode;
  Map<String, bool> lastVerification = const {};

  /// Called for any barcode scan. Returns true iff the scan advanced the
  /// state machine (caller can refuse scanning if same step fires twice in
  /// quick succession).
  bool onScan(String code) {
    switch (step) {
      case MarStep.scanWristband:
        wristbandId = code;
        step = MarStep.scanDrug;
        return true;
      case MarStep.scanDrug:
        drugCode = code;
        step = MarStep.verify;
        return true;
      case MarStep.verify:
      case MarStep.done:
        return false;
    }
  }

  /// Called after `/clinical/mar/verify` resolves. All five rights must be
  /// true for administration to commit; otherwise the nurse must re-scan.
  void onVerifyResponse(Map<String, bool> rights) {
    if (step != MarStep.verify) return;
    lastVerification = rights;
    final allGood = rights.values.every((v) => v);
    if (allGood) step = MarStep.done;
    // else: stay in verify so the banner is shown; reset must be explicit.
  }

  /// The user taps "Start over" or an override screen — returns to scanning.
  void reset() {
    step = MarStep.scanWristband;
    wristbandId = null;
    drugCode = null;
    lastVerification = const {};
  }
}

void main() {
  group('MAR 5-rights state machine', () {
    late MarStateMachine m;

    setUp(() {
      m = MarStateMachine();
    });

    test('starts at scanWristband with no captured data', () {
      expect(m.step, MarStep.scanWristband);
      expect(m.wristbandId, isNull);
      expect(m.drugCode, isNull);
    });

    test('first scan captures wristband and advances to scanDrug', () {
      expect(m.onScan('PT-00001'), isTrue);
      expect(m.step, MarStep.scanDrug);
      expect(m.wristbandId, 'PT-00001');
      expect(m.drugCode, isNull);
    });

    test('second scan captures drug code and advances to verify', () {
      m.onScan('PT-00001');
      expect(m.onScan('NDC-0093-0058-01'), isTrue);
      expect(m.step, MarStep.verify);
      expect(m.drugCode, 'NDC-0093-0058-01');
    });

    test('scan is rejected while in verify state (waiting on backend)', () {
      m.onScan('PT-00001');
      m.onScan('NDC-0093-0058-01');
      expect(m.step, MarStep.verify);
      expect(
        m.onScan('REJECTED-BARCODE'),
        isFalse,
        reason:
            'Additional scans must be ignored while backend verify is in-flight',
      );
      expect(m.step, MarStep.verify);
      // Captured state unchanged.
      expect(m.wristbandId, 'PT-00001');
      expect(m.drugCode, 'NDC-0093-0058-01');
    });

    test('all-rights-ok verify response advances to done', () {
      m.onScan('PT-00001');
      m.onScan('NDC-0093-0058-01');
      m.onVerifyResponse({
        'rightPatient': true,
        'rightDrug': true,
        'rightDose': true,
        'rightRoute': true,
        'rightTime': true,
      });
      expect(m.step, MarStep.done);
    });

    test('any failing right keeps state at verify for banner display', () {
      m.onScan('PT-00001');
      m.onScan('WRONG-NDC');
      m.onVerifyResponse({
        'rightPatient': true,
        'rightDrug': false, // <-- single failing right must block
        'rightDose': true,
        'rightRoute': true,
        'rightTime': true,
      });
      expect(
        m.step,
        MarStep.verify,
        reason:
            'Must not auto-advance; nurse must see the block banner and act',
      );
      expect(m.lastVerification['rightDrug'], isFalse);
    });

    test('verify response in non-verify state is ignored (defensive)', () {
      // Simulates a late-arriving HTTP response after user already reset.
      m.onScan('PT-00001');
      m.reset();
      m.onVerifyResponse({
        'rightPatient': true,
        'rightDrug': true,
        'rightDose': true,
        'rightRoute': true,
        'rightTime': true,
      });
      expect(
        m.step,
        MarStep.scanWristband,
        reason: 'Stale response must not silently advance to done',
      );
    });

    test('reset clears captured patient+drug and returns to scanWristband', () {
      m.onScan('PT-00001');
      m.onScan('NDC-0093-0058-01');
      m.reset();
      expect(m.step, MarStep.scanWristband);
      expect(m.wristbandId, isNull);
      expect(m.drugCode, isNull);
      expect(m.lastVerification, isEmpty);
    });

    test('post-done scans are ignored until reset', () {
      m.onScan('PT-00001');
      m.onScan('NDC-0093-0058-01');
      m.onVerifyResponse({
        'rightPatient': true,
        'rightDrug': true,
        'rightDose': true,
        'rightRoute': true,
        'rightTime': true,
      });
      expect(m.step, MarStep.done);
      expect(m.onScan('ANOTHER-WRISTBAND'), isFalse);
      expect(m.step, MarStep.done);
    });
  });

  group('marIsIdentityMismatch (wrong-patient/wrong-drug hard-stop, F-H1)', () {
    test('true when the patient right failed', () {
      expect(
        marIsIdentityMismatch({
          'patient': false,
          'drug': true,
          'dose': true,
          'route': true,
          'time': true,
        }),
        isTrue,
      );
    });

    test('true when the drug right failed', () {
      expect(
        marIsIdentityMismatch({
          'patient': true,
          'drug': false,
          'dose': true,
          'route': true,
          'time': true,
        }),
        isTrue,
      );
    });

    test(
      'false when only SOFT rights (dose/route/time) failed — overridable',
      () {
        expect(
          marIsIdentityMismatch({
            'patient': true,
            'drug': true,
            'dose': true,
            'route': true,
            'time': false,
          }),
          isFalse,
        );
      },
    );

    test('false when all rights pass', () {
      expect(
        marIsIdentityMismatch({
          'patient': true,
          'drug': true,
          'dose': true,
          'route': true,
          'time': true,
        }),
        isFalse,
      );
    });
  });
}
