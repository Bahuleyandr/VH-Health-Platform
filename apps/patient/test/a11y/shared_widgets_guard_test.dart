// Accessibility regression guard — shared patient-app widgets (audit PR 4).
//
// Covers the widgets every feature screen composes: FeatureScreenScaffold
// (all pastel variants), LiveRegionSnackBar, the unadopted Accessible*
// wrappers, and the patient outage overlay. Guards blocked on an unmerged
// PR are grouped under `skip:` with the PR number — un-skip on merge.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsFlag;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/outage/patient_outage_config.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/widgets/accessible_button.dart';
import 'package:vhhealth/core/widgets/accessible_card.dart';
import 'package:vhhealth/core/widgets/accessible_image.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';
import 'package:vhhealth/core/widgets/patient_outage_scope.dart';

import 'a11y_guards.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ── FeatureScreenScaffold — used by every feature screen ────────────────

  Future<void> pumpFeatureScaffold(
    WidgetTester tester, {
    required ThemeData theme,
    String title = 'Pharmacy',
    Color color = const Color(0xFFD1C4E9),
  }) async {
    await pumpGuarded(
      tester,
      FeatureScreenScaffold(
        title: title,
        icon: Icons.local_pharmacy,
        color: color,
        child: const Text('body'),
      ),
      theme: theme,
      useScaffold: false,
    );
    // Let the scaffold's 600 ms entry fade finish.
    await tester.pump(const Duration(milliseconds: 700));
  }

  for (final themeCase in themeCases) {
    group('[${themeCase.name}] FeatureScreenScaffold', () {
      testWidgets('meets tap-target guidelines', (tester) async {
        await withSemantics(tester, () async {
          await pumpFeatureScaffold(tester, theme: themeCase.theme);
          await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
          await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
        });
      });
    });
  }

  group('FeatureScreenScaffold back button (fixed by PR #780)', () {
    for (final themeCase in themeCases) {
      testWidgets('[${themeCase.name}] back button is labeled for screen '
          'readers', (tester) async {
        await withSemantics(tester, () async {
          await pumpFeatureScaffold(tester, theme: themeCase.theme);
          // MaterialLocalizations.backButtonTooltip — 'Back' in English.
          expect(find.byTooltip('Back'), findsOneWidget);
          await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        });
      });
    }
  });

  group('FeatureScreenScaffold pastel titles (fixed by PR #780)', () {
    // All pastel variants actually passed to the scaffold by feature screens.
    // Raw, the pastels are ~1.2:1 against the light scaffold background —
    // #780 derives a same-hue WCAG AA variant for the title/back icon.
    FeatureScreenScaffold.featureColors.forEach((name, pastel) {
      testWidgets('[light] "$name" title meets 4.5:1 on the scaffold '
          'background', (tester) async {
        final theme = themeCases.first.theme;
        await pumpFeatureScaffold(
          tester,
          theme: theme,
          title: name,
          color: pastel,
        );
        final titleStyle = tester.widget<Text>(find.text(name)).style!;
        expect(
          wcagContrastRatio(titleStyle.color!, theme.scaffoldBackgroundColor),
          greaterThanOrEqualTo(4.5),
        );
      });
    });
  });

  group('FeatureScreenScaffold pastel titles in dark mode (green on main)', () {
    // The raw pastels are all >= 8:1 on the dark background; this guard
    // pins that so a palette change cannot silently regress dark mode.
    FeatureScreenScaffold.featureColors.forEach((name, pastel) {
      testWidgets('[dark] "$name" title meets 4.5:1 on the scaffold '
          'background', (tester) async {
        final theme = themeCases.last.theme;
        await pumpFeatureScaffold(
          tester,
          theme: theme,
          title: name,
          color: pastel,
        );
        final titleStyle = tester.widget<Text>(find.text(name)).style!;
        expect(
          wcagContrastRatio(titleStyle.color!, theme.scaffoldBackgroundColor),
          greaterThanOrEqualTo(4.5),
        );
      });
    });
  });

  // ── LiveRegionSnackBar — the app's accessible announcement channel ──────

  for (final themeCase in themeCases) {
    testWidgets('[${themeCase.name}] LiveRegionSnackBar announces via a live '
        'region and keeps readable text', (tester) async {
      await withSemantics(tester, () async {
        await pumpGuarded(
          tester,
          const SizedBox.shrink(),
          theme: themeCase.theme,
        );
        final context = tester.element(find.byType(Scaffold));
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: 'Appointment booked',
            announcementPrefix: 'Success',
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 750));

        expect(find.text('Appointment booked'), findsOneWidget);
        expect(
          tester.getSemantics(
            find.bySemanticsLabel(RegExp('Success: Appointment booked')),
          ),
          isSemantics(isLiveRegion: true),
        );
        await expectLater(tester, meetsGuideline(textContrastGuideline));
      });
    });
  }

  // ── Accessible* wrappers — defined but unadopted; keep them correct ─────

  group('Accessible* wrapper widgets stay correct while awaiting adoption', () {
    testWidgets('AccessibleButton exposes button role, label and hint', (
      tester,
    ) async {
      await withSemantics(tester, () async {
        await pumpGuarded(
          tester,
          Center(
            child: AccessibleButton(
              label: 'Trigger SOS',
              hint: 'Sends an emergency alert to the hospital',
              onPressed: () {},
              child: const SizedBox(width: 64, height: 64),
            ),
          ),
          theme: themeCases.first.theme,
        );
        final node = tester.getSemantics(find.bySemanticsLabel('Trigger SOS'));
        expect(
          node,
          isSemantics(
            isButton: true,
            hasTapAction: true,
            label: 'Trigger SOS',
            hint: 'Sends an emergency alert to the hospital',
          ),
        );
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      });
    });

    testWidgets('AccessibleCard exposes container label and value', (
      tester,
    ) async {
      await withSemantics(tester, () async {
        await pumpGuarded(
          tester,
          const AccessibleCard(
            label: 'Blood pressure',
            value: '120 over 80',
            child: SizedBox(width: 120, height: 64),
          ),
          theme: themeCases.first.theme,
        );
        expect(
          tester.getSemantics(find.bySemanticsLabel('Blood pressure')),
          isSemantics(label: 'Blood pressure', value: '120 over 80'),
        );
      });
    });

    testWidgets('AccessibleImage exposes image role and description', (
      tester,
    ) async {
      await withSemantics(tester, () async {
        await pumpGuarded(
          tester,
          AccessibleImage(
            image: MemoryImage(kTransparentImage),
            description: 'Hospital campus map',
            width: 48,
            height: 48,
          ),
          theme: themeCases.first.theme,
        );
        // Both the wrapper Semantics and the inner Image carry the label;
        // assert on the outer (first in traversal) node.
        expect(
          tester.getSemantics(
            find.bySemanticsLabel('Hospital campus map').first,
          ),
          isSemantics(isImage: true, label: 'Hospital campus map'),
        );
      });
    });
  });

  // ── Patient outage overlay (safety-critical; fixed by PR #806) ──────────

  group('blocked-mutation outage overlay (fixed by PR #806)', () {
    late PatientOutageController controller;

    setUp(() async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      await PatientOutageConfigStore.instance.resetForTesting();
      controller = PatientOutageController.forTesting(
        request: () => throw StateError('network must not be used'),
        authentication: () async => 'patient-session',
        tenantId: () async => 'tenant-a',
        maxClockSkew: const Duration(seconds: 5),
      );
      controller.closeForTesting(PatientOutageReason.transportUnavailable);
      PatientOutageController.setForTesting(controller);
    });

    tearDown(() async {
      PatientOutageController.resetAfterTesting();
      controller.dispose();
      await PatientOutageConfigStore.instance.resetForTesting();
    });

    testWidgets('blocked-SOS notice is modal to assistive tech and announced', (
      tester,
    ) async {
      await withSemantics(tester, () async {
        await pumpGuarded(
          tester,
          const PatientOutageScope(child: Scaffold(body: Text('cached view'))),
          theme: themeCases.first.theme,
          useScaffold: false,
          surfaceSize: const Size(1080, 2520),
        );
        await tester.pump();

        // A failed emergency SOS raises the overlay.
        controller.reportBlockedMutation('POST', '/sos/');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));

        // The failure text must be announced (live region) …
        expect(
          tester.getSemantics(
            find.bySemanticsLabel(
              RegExp('The hospital emergency alert was not sent'),
            ),
          ),
          isSemantics(isLiveRegion: true),
        );
        // … the overlay must present as the current route …
        expect(
          find.semantics.byFlag(SemanticsFlag.scopesRoute),
          findsAtLeast(1),
        );
        // … and the app behind the scrim must be unreachable by traversal.
        expect(find.text('cached view'), findsOneWidget);
        expect(find.semantics.byLabel('cached view'), findsNothing);
      });
    });
  }, skip: kBlockedOnPr806);
}

/// 1x1 transparent PNG for [AccessibleImage].
const List<int> _kTransparentImageBytes = <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, //
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, //
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, //
  0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, //
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, //
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

final Uint8List kTransparentImage = Uint8List.fromList(_kTransparentImageBytes);
