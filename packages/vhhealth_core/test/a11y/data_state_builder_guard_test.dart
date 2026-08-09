// Accessibility regression guard — DataStateBuilder (audit PR 4).
//
// DataStateBuilder renders the loading / error / empty state of 22 patient
// screens and the staff app, so a silent regression here is the widest
// possible a11y regression. Audit blocker 1: the loading spinner was
// unlabeled and the error swap was not announced.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/theme/app_theme.dart';
import 'package:vhhealth_core/widgets/data_state_builder.dart';

void main() {
  final themes = <String, ThemeData>{
    'light': AppTheme.getLightTheme(16),
    'dark': AppTheme.getDarkTheme(16),
  };

  Future<void> pump(
    WidgetTester tester, {
    required ThemeData theme,
    required bool isLoading,
    String? error,
    List<String> data = const <String>[],
  }) {
    return tester.pumpWidget(
      MaterialApp(
        theme: theme,
        home: Scaffold(
          body: DataStateBuilder<String>(
            isLoading: isLoading,
            error: error,
            data: data,
            onRetry: () {},
            emptySubtitle: 'Pull to refresh to try again',
            builder: (context, items) => Text(items.join(', ')),
          ),
        ),
      ),
    );
  }

  for (final entry in themes.entries) {
    final String themeName = entry.key;
    final ThemeData theme = entry.value;

    group('[$themeName] active DataStateBuilder guards (green on main)', () {
      testWidgets('error state meets tap-target and label guidelines', (
        tester,
      ) async {
        final handle = tester.ensureSemantics();
        await pump(
          tester,
          theme: theme,
          isLoading: false,
          error: 'Backend unavailable',
        );
        await tester.pump();

        expect(find.text('Something went wrong'), findsOneWidget);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        handle.dispose();
      });

      testWidgets('empty state meets tap-target and label guidelines', (
        tester,
      ) async {
        final handle = tester.ensureSemantics();
        await pump(tester, theme: theme, isLoading: false);
        await tester.pump();

        expect(find.text('Nothing here yet'), findsOneWidget);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(tester, meetsGuideline(textContrastGuideline));
        handle.dispose();
      });
    });

    group('[$themeName] DataStateBuilder announcement guards '
        '(fixed by PR #780)', () {
      testWidgets('loading spinner carries a semantic label', (tester) async {
        final handle = tester.ensureSemantics();
        await pump(tester, theme: theme, isLoading: true);
        await tester.pump();

        // Audit blocker 1: an unlabeled spinner leaves TalkBack/VoiceOver
        // users with no indication the screen is loading.
        expect(find.bySemanticsLabel('Loading'), findsOneWidget);
        expect(
          tester
              .widget<CircularProgressIndicator>(
                find.byType(CircularProgressIndicator),
              )
              .semanticsLabel,
          isNotNull,
        );
        handle.dispose();
      });

      testWidgets('error state is announced via a live region', (tester) async {
        final handle = tester.ensureSemantics();
        await pump(
          tester,
          theme: theme,
          isLoading: false,
          error: 'Backend unavailable',
        );
        await tester.pump();

        expect(
          tester.getSemantics(
            find.bySemanticsLabel(RegExp('Something went wrong')),
          ),
          isSemantics(isLiveRegion: true),
        );
        handle.dispose();
      });
    });
  }
}
