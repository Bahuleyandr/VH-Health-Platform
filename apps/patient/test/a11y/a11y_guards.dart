// Shared helpers for the accessibility regression-guard suite (audit PR 4).
//
// Every test in `test/a11y/` goes through these helpers so adding a guard for
// a new screen stays ~10 lines: pump it with [pumpGuarded] under each entry
// of [themeCases], then call [expectMeetsA11yGuidelines].
//
// The suite is designed to be green on current `main`.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/theme/app_theme.dart';

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/// A named theme under test. The guards must hold in BOTH app themes.
class ThemeCase {
  const ThemeCase(this.name, this.theme);

  final String name;
  final ThemeData theme;
}

/// The two real app themes (the patient app's ThemeProvider builds on
/// exactly these), at the default 16 pt base font size.
final List<ThemeCase> themeCases = <ThemeCase>[
  ThemeCase('light', AppTheme.getLightTheme(16)),
  ThemeCase('dark', AppTheme.getDarkTheme(16)),
];

// ---------------------------------------------------------------------------
// Pumping
// ---------------------------------------------------------------------------

/// Pumps [child] inside a real-theme MaterialApp with the app's localization
/// delegates, mirroring how feature screens are hosted by the real app.
Future<void> pumpGuarded(
  WidgetTester tester,
  Widget child, {
  required ThemeData theme,
  bool useScaffold = true,
  Size? surfaceSize,
}) async {
  if (surfaceSize != null) {
    await tester.binding.setSurfaceSize(surfaceSize);
    addTearDown(() => tester.binding.setSurfaceSize(null));
  }
  await tester.pumpWidget(
    MaterialApp(
      theme: theme,
      locale: const Locale('en'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: useScaffold ? Scaffold(body: child) : child,
    ),
  );
}

/// Runs [body] with a live semantics tree, disposing the handle afterwards.
Future<void> withSemantics(
  WidgetTester tester,
  Future<void> Function() body,
) async {
  final handle = tester.ensureSemantics();
  try {
    await body();
  } finally {
    handle.dispose();
  }
}

// ---------------------------------------------------------------------------
// Guideline bundle
// ---------------------------------------------------------------------------

/// Asserts Flutter's accessibility guidelines on the currently pumped tree:
///
///  * [androidTapTargetGuideline] — 48x48 dp minimum tap targets;
///  * [iOSTapTargetGuideline] — 44x44 dp minimum tap targets;
///  * [labeledTapTargetGuideline] — every tappable node carries a label;
///  * [textContrastGuideline] (opt-in) — WCAG AA contrast on rendered text.
///
/// Text contrast is opt-in because the pixel-sampling estimator misreads
/// gradient / frosted-glass backgrounds; screens with flat surfaces should
/// pass `textContrast: true`, decorative-background screens are covered by
/// the direct [wcagContrastRatio] guards instead.
/// Pass `labeled: false` only when a screen has a KNOWN unlabeled tap target
/// awaiting its own fix — that screen must then carry a separate, skipped
/// labeled-guideline guard naming the pending fix.
Future<void> expectMeetsA11yGuidelines(
  WidgetTester tester, {
  bool textContrast = false,
  bool labeled = true,
}) async {
  await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
  await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
  if (labeled) {
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  }
  if (textContrast) {
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  }
}

// ---------------------------------------------------------------------------
// WCAG contrast math (self-contained on purpose)
// ---------------------------------------------------------------------------
// PR #780 adds `package:vhhealth_core/utils/color_contrast.dart`, but that
// file is not on main yet; keeping the math local lets the theme guards run
// un-skipped today. Once #780 merges this can be swapped for the shared
// helper if desired — the formulas are the same (WCAG 2.x relative
// luminance).

double _linearize(double channel) {
  return channel <= 0.03928
      ? channel / 12.92
      : math.pow((channel + 0.055) / 1.055, 2.4).toDouble();
}

/// WCAG 2.x relative luminance of [color] (alpha ignored).
double wcagRelativeLuminance(Color color) {
  return 0.2126 * _linearize(color.r) +
      0.7152 * _linearize(color.g) +
      0.0722 * _linearize(color.b);
}

/// WCAG 2.x contrast ratio between two opaque colours, in `[1, 21]`.
double wcagContrastRatio(Color a, Color b) {
  final double la = wcagRelativeLuminance(a);
  final double lb = wcagRelativeLuminance(b);
  final double lighter = math.max(la, lb);
  final double darker = math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Service fakes (same pattern as the existing widget tests)
// ---------------------------------------------------------------------------

/// Installs an in-memory `flutter_secure_storage` fake so screens that read
/// the patient id / JWT can pump without the plugin. Seeds `user_id` and
/// `user_phone` with stable test values.
void installSecureStorageFake() {
  const MethodChannel channel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );
  final Map<String, String> store = <String, String>{
    'user_id': 'patient-1',
    'user_phone': '5551234567',
  };

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final Map<String, dynamic> args = Map<String, dynamic>.from(
          call.arguments as Map,
        );
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}

/// Routes every VHHttpClient/ApiClient request to a canned JSON response by
/// longest-matching path suffix. Unmatched paths get an empty success body.
void mockApi(Map<String, String> responsesByPathSuffix) {
  VHHttpClient.setClientForTesting(
    MockClient((http.Request request) async {
      for (final MapEntry<String, String> entry
          in responsesByPathSuffix.entries) {
        if (request.url.path.endsWith(entry.key)) {
          return http.Response(
            entry.value,
            200,
            headers: <String, String>{
              'content-type': 'application/json; charset=utf-8',
            },
          );
        }
      }
      return http.Response(
        '{"data":[]}',
        200,
        headers: <String, String>{
          'content-type': 'application/json; charset=utf-8',
        },
      );
    }),
  );
}

/// Undoes [mockApi].
void resetMockApi() {
  VHHttpClient.resetClientForTesting();
}
