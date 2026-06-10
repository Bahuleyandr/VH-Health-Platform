// test/a11y/screen_reader_plan_test.dart
//
// Automated execution of the machine-verifiable parts of
// docs/SCREEN_READER_TEST_PLAN.md (roadmap E3). A human still owns the
// by-ear NVDA/TalkBack pass — these tests pin the SEMANTICS TREE the
// screen reader consumes, so the plan's failure modes regress loudly in
// CI instead of waiting for the next manual session:
//
//   * S3  — toast live regions (SuccessToast / ErrorToast announce).
//   * S8  — skeleton respects reduce-motion + announces "Loading…".
//   * S9  — text scaling: the composed TextScaler honours both the OS
//           factor and the in-app preference, with sane clamps
//           (lib/core/utils/font_scale.dart, wired in main.dart).
//   * ThemeProvider font-size preference: clamped + persisted.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/core/utils/font_scale.dart';
import 'package:vhhealth_staff/core/widgets/states/skeleton_list.dart';
import 'package:vhhealth_staff/core/widgets/states/success_toast.dart';

void main() {
  group('S9 — composeTextScaleFactor', () {
    test('neutral preference passes the system factor through', () {
      expect(
        composeTextScaleFactor(systemFactor: 1.0, userPt: kBaseFontPt),
        1.0,
      );
      expect(
        composeTextScaleFactor(systemFactor: 1.3, userPt: kBaseFontPt),
        closeTo(1.3, 0.001),
      );
    });

    test('user preference multiplies the system factor', () {
      expect(
        composeTextScaleFactor(systemFactor: 1.0, userPt: 22.0),
        closeTo(22 / 16, 0.001),
      );
      expect(
        composeTextScaleFactor(systemFactor: 1.0, userPt: 12.0),
        closeTo(12 / 16, 0.001),
      );
    });

    test('composed factor clamps at both ends', () {
      // OS at 200% and slider maxed must not exceed the ceiling.
      expect(
        composeTextScaleFactor(systemFactor: 2.0, userPt: kMaxFontPt),
        kMaxComposedFactor,
      );
      // Tiny system factor + smallest preference floors at the minimum.
      expect(
        composeTextScaleFactor(systemFactor: 0.5, userPt: kMinFontPt),
        kMinComposedFactor,
      );
      // The slider minimum at a neutral OS setting is honoured exactly —
      // the floor must not swallow legitimate slider positions.
      expect(
        composeTextScaleFactor(systemFactor: 1.0, userPt: kMinFontPt),
        closeTo(kMinFontPt / kBaseFontPt, 0.001),
      );
    });

    test('out-of-range preferences are clamped before composing', () {
      expect(
        composeTextScaleFactor(systemFactor: 1.0, userPt: 99.0),
        composeTextScaleFactor(systemFactor: 1.0, userPt: kMaxFontPt),
      );
      expect(
        composeTextScaleFactor(systemFactor: 1.0, userPt: 1.0),
        composeTextScaleFactor(systemFactor: 1.0, userPt: kMinFontPt),
      );
    });
  });

  group('ThemeProvider font-size preference', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
    });

    test('defaults to the neutral 16 pt', () async {
      final provider = ThemeProvider();
      await Future<void>.delayed(Duration.zero);
      expect(provider.fontSize, kBaseFontPt);
    });

    test('setFontSize clamps and persists', () async {
      final provider = ThemeProvider();
      await Future<void>.delayed(Duration.zero);

      await provider.setFontSize(99);
      expect(provider.fontSize, kMaxFontPt);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getDouble('font_size'), kMaxFontPt);
    });

    test('restores a saved preference (clamped)', () async {
      SharedPreferences.setMockInitialValues({'font_size': 20.0});
      final provider = ThemeProvider();
      await Future<void>.delayed(Duration.zero);
      expect(provider.fontSize, 20.0);
    });
  });

  group('S8 — SkeletonList reduce-motion + loading semantics', () {
    Future<void> pumpSkeleton(
      WidgetTester tester, {
      required bool disableAnimations,
    }) {
      return tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(disableAnimations: disableAnimations),
            child: const Scaffold(body: SkeletonList(itemCount: 2)),
          ),
        ),
      );
    }

    List<Color?> rowColors(WidgetTester tester) {
      return tester
          .widgetList<Container>(find.byType(Container))
          .map(
            (c) => (c.decoration is BoxDecoration)
                ? (c.decoration as BoxDecoration).color
                : null,
          )
          .whereType<Color>()
          .toList();
    }

    testWidgets('announces a single Loading… live region', (tester) async {
      final handle = tester.ensureSemantics();
      await pumpSkeleton(tester, disableAnimations: true);

      expect(
        tester.getSemantics(find.bySemanticsLabel(RegExp('Loading…'))),
        isSemantics(label: 'Loading…', isLiveRegion: true),
      );
      handle.dispose();
    });

    testWidgets('freezes the pulse when reduce-motion is on', (tester) async {
      await pumpSkeleton(tester, disableAnimations: true);
      final before = rowColors(tester);
      await tester.pump(const Duration(milliseconds: 550));
      final after = rowColors(tester);
      expect(
        after,
        equals(before),
        reason: 'reduce-motion must freeze the shimmer colours',
      );
    });

    testWidgets('pulses normally when animations are allowed', (tester) async {
      await pumpSkeleton(tester, disableAnimations: false);
      final before = rowColors(tester);
      await tester.pump(const Duration(milliseconds: 550));
      final after = rowColors(tester);
      expect(
        after,
        isNot(equals(before)),
        reason: 'shimmer should animate when motion is not reduced',
      );
    });
  });

  group('S3 — toast live regions', () {
    testWidgets('SuccessToast announces "Success: <message>"', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: SizedBox.shrink())),
      );
      final context = tester.element(find.byType(Scaffold));
      SuccessToast.show(context, 'Bed notes saved');
      await tester.pump();
      // Let the SnackBar entrance animation finish so its semantics
      // are fully attached.
      await tester.pump(const Duration(milliseconds: 750));

      expect(find.text('Bed notes saved'), findsOneWidget);
      // The Semantics(label:) node may merge with the visible Text child
      // (labels join with newlines) — match on the announcement prefix
      // and assert the live-region flag survives the merge.
      expect(
        tester.getSemantics(
          find.bySemanticsLabel(RegExp('Success: Bed notes saved')),
        ),
        isSemantics(isLiveRegion: true),
      );
      handle.dispose();
    });

    testWidgets('ErrorToast announces "Error: <message>"', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: SizedBox.shrink())),
      );
      final context = tester.element(find.byType(Scaffold));
      ErrorToast.show(context, 'Save failed');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750));

      expect(
        tester.getSemantics(
          find.bySemanticsLabel(RegExp('Error: Save failed')),
        ),
        isSemantics(isLiveRegion: true),
      );
      handle.dispose();
    });
  });
}
