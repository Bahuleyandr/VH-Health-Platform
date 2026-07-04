import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/widgets/data_state_builder.dart';

void main() {
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
