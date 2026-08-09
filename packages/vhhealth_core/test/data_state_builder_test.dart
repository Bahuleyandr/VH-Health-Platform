import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/theme/app_theme.dart';
import 'package:vhhealth_core/widgets/data_state_builder.dart';

void main() {
  testWidgets('loading state exposes a semantic label for screen readers', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        home: DataStateBuilder<int>(
          isLoading: true,
          data: const [],
          builder: (_, data) => Text('Loaded ${data.length}'),
        ),
      ),
    );

    expect(find.bySemanticsLabel('Loading'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('loading semantic label is customisable (for localisation)', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        home: DataStateBuilder<int>(
          isLoading: true,
          data: const [],
          loadingSemanticLabel: 'Cargando',
          builder: (_, data) => Text('Loaded ${data.length}'),
        ),
      ),
    );

    expect(find.bySemanticsLabel('Cargando'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('error state is announced as a live region', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        home: DataStateBuilder<int>(
          isLoading: false,
          error: 'Unable to load records.',
          data: const [],
          errorTitle: 'Could not load this',
          builder: (_, data) => Text('Loaded ${data.length}'),
        ),
      ),
    );

    final node = tester.getSemantics(find.text('Could not load this'));
    expect(
      node,
      isSemantics(
        isLiveRegion: true,
        label: 'Could not load this\nUnable to load records.',
      ),
    );
    handle.dispose();
  });

  testWidgets('empty state text is readable and not a live region', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        home: DataStateBuilder<int>(
          isLoading: false,
          data: const [],
          emptyTitle: 'No records',
          emptySubtitle: 'Records will appear here.',
          builder: (_, data) => Text('Loaded ${data.length}'),
        ),
      ),
    );

    final node = tester.getSemantics(find.text('No records'));
    expect(node, isSemantics(label: 'No records\nRecords will appear here.'));
    expect(node, isNot(isSemantics(isLiveRegion: true)));
    handle.dispose();
  });

  testWidgets('error state meets WCAG AA text contrast in the light theme', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.getLightTheme(16),
        home: Scaffold(
          body: DataStateBuilder<int>(
            isLoading: false,
            error: 'Unable to load records.',
            data: const [],
            builder: (_, data) => Text('Loaded ${data.length}'),
          ),
        ),
      ),
    );

    await expectLater(tester, meetsGuideline(textContrastGuideline));
    handle.dispose();
  });
  testWidgets('uses localized/custom labels for error and empty actions', (
    tester,
  ) async {
    var retries = 0;
    var emptyActions = 0;

    await tester.pumpWidget(
      MaterialApp(
        home: DataStateBuilder<int>(
          isLoading: false,
          error: 'Unable to load records.',
          data: const [],
          onRetry: () => retries += 1,
          emptyTitle: 'No records',
          emptySubtitle: 'Records will appear here.',
          errorTitle: 'Could not load this',
          errorActionLabel: 'Try again',
          emptyActionLabel: 'Add record',
          onEmptyAction: () => emptyActions += 1,
          builder: (_, data) => Text('Loaded ${data.length}'),
        ),
      ),
    );

    expect(find.text('Could not load this'), findsOneWidget);
    expect(find.text('Unable to load records.'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await tester.pump();
    expect(retries, 1);

    await tester.pumpWidget(
      MaterialApp(
        home: DataStateBuilder<int>(
          isLoading: false,
          data: const [],
          onRetry: () => retries += 1,
          emptyTitle: 'No records',
          emptySubtitle: 'Records will appear here.',
          errorActionLabel: 'Try again',
          emptyActionLabel: 'Add record',
          onEmptyAction: () => emptyActions += 1,
          builder: (_, data) => Text('Loaded ${data.length}'),
        ),
      ),
    );

    expect(find.text('No records'), findsOneWidget);
    expect(find.text('Records will appear here.'), findsOneWidget);
    await tester.tap(find.text('Add record'));
    await tester.pump();
    expect(emptyActions, 1);
    expect(retries, 1);
  });
}
