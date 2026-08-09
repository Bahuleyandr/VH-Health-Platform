import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth_core/theme/app_theme.dart';
import 'package:vhhealth_core/utils/color_contrast.dart';

/// Accessibility regression tests for the shared feature-screen scaffold
/// (used by all feature screens): the back button must carry a screen-reader
/// label and the pastel title must meet WCAG AA contrast in both themes.
void main() {
  const pastel = Color(0xFFD1C4E9); // 'pharmacy' feature colour, ~1.2:1 raw.

  Future<void> pumpScaffold(WidgetTester tester, {required ThemeData theme}) {
    return tester.pumpWidget(
      MaterialApp(
        theme: theme,
        home: const FeatureScreenScaffold(
          title: 'Pharmacy',
          icon: Icons.local_pharmacy,
          color: pastel,
          child: Text('body'),
        ),
      ),
    );
  }

  testWidgets('back button exposes an accessible label', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpScaffold(tester, theme: AppTheme.getLightTheme(16));
    await tester.pump(const Duration(milliseconds: 700));

    // MaterialLocalizations.backButtonTooltip — 'Back' in English; IconButton
    // surfaces it to assistive tech via the semantics tooltip attribute.
    expect(find.byTooltip('Back'), findsOneWidget);
    expect(
      tester.getSemantics(find.widgetWithIcon(IconButton, Icons.arrow_back)),
      isSemantics(hasTapAction: true, tooltip: 'Back'),
    );
    handle.dispose();
  });

  testWidgets('title meets 4.5:1 against the light scaffold background', (
    tester,
  ) async {
    final theme = AppTheme.getLightTheme(16);
    await pumpScaffold(tester, theme: theme);
    await tester.pump(const Duration(milliseconds: 700));

    final title = tester.widget<Text>(find.text('Pharmacy'));
    expect(
      contrastRatio(title.style!.color!, theme.scaffoldBackgroundColor),
      greaterThanOrEqualTo(4.5),
    );

    // Back-button icon is a non-text control: 3:1 minimum (WCAG 1.4.11).
    final backButton = tester.widget<IconButton>(
      find.widgetWithIcon(IconButton, Icons.arrow_back),
    );
    expect(
      contrastRatio(backButton.color!, theme.scaffoldBackgroundColor),
      greaterThanOrEqualTo(3.0),
    );
  });

  testWidgets('title meets 4.5:1 against the dark scaffold background', (
    tester,
  ) async {
    final theme = AppTheme.getDarkTheme(16);
    await pumpScaffold(tester, theme: theme);
    await tester.pump(const Duration(milliseconds: 700));

    final title = tester.widget<Text>(find.text('Pharmacy'));
    expect(
      contrastRatio(title.style!.color!, theme.scaffoldBackgroundColor),
      greaterThanOrEqualTo(4.5),
    );
  });
}
