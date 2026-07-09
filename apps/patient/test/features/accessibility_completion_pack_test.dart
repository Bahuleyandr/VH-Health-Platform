import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('NL12-S6 patient font scaling', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
    });

    test('ThemeProvider persists the selected font size', () async {
      final provider = ThemeProvider();

      await provider.setFontSize(20);

      expect(provider.fontSize, 20);
      expect(provider.lightTheme.textTheme.bodyLarge?.fontSize, 20);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getDouble('font_size'), 20);
    });
  });

  group('NL12-S6 patient live-region snack bars', () {
    testWidgets('announces the semantic label while preserving visible text', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: SizedBox.shrink())),
      );

      final context = tester.element(find.byType(Scaffold));
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(
          message: 'Font size changed to 20 pt',
          announcementPrefix: 'Accessibility',
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750));

      expect(find.text('Font size changed to 20 pt'), findsOneWidget);
      expect(
        tester.getSemantics(
          find.bySemanticsLabel(
            RegExp('Accessibility: Font size changed to 20 pt'),
          ),
        ),
        isSemantics(isLiveRegion: true),
      );
      semantics.dispose();
    });
  });
}
