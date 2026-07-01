// test/features/emr/widgets/note_draft_status_indicator_test.dart
//
// Widget tests for the autosave status indicator. Covers the two additions
// flagged by review: the transient "Unsaved changes…" (dirty) state and the
// RELATIVE saved-time label ("Saved 2m ago") instead of a static clock time.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/note_draft_autosave.dart';
import 'package:vhhealth_staff/features/emr/widgets/note_draft_status_indicator.dart';

void main() {
  Future<void> pump(
    WidgetTester tester,
    NoteDraftStatus status, {
    DateTime Function()? now,
  }) {
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NoteDraftStatusIndicator(
            status: ValueNotifier<NoteDraftStatus>(status),
            now: now,
          ),
        ),
      ),
    );
  }

  testWidgets('dirty state renders "Unsaved changes…"', (tester) async {
    await pump(tester, const NoteDraftStatus.dirty());
    expect(find.text('Unsaved changes…'), findsOneWidget);
  });

  testWidgets('idle state renders nothing', (tester) async {
    await pump(tester, const NoteDraftStatus.idle());
    expect(find.byType(Text), findsNothing);
  });

  testWidgets('saved state renders a RELATIVE time (2m ago)', (tester) async {
    final savedAt = DateTime(2026, 6, 17, 14, 0);
    await pump(
      tester,
      NoteDraftStatus.saved(savedAt),
      now: () => DateTime(2026, 6, 17, 14, 2), // 2 minutes later
    );
    expect(find.text('Saved 2m ago'), findsOneWidget);
  });

  testWidgets('saved just now reads "Saved just now"', (tester) async {
    final savedAt = DateTime(2026, 6, 17, 14, 0, 0);
    await pump(
      tester,
      NoteDraftStatus.saved(savedAt),
      now: () => DateTime(2026, 6, 17, 14, 0, 10), // 10s later
    );
    expect(find.text('Saved just now'), findsOneWidget);
  });

  testWidgets('a stalled save reads visibly old (hours)', (tester) async {
    final savedAt = DateTime(2026, 6, 17, 12, 0);
    await pump(
      tester,
      NoteDraftStatus.saved(savedAt),
      now: () => DateTime(2026, 6, 17, 15, 0), // 3h later
    );
    expect(find.text('Saved 3h ago'), findsOneWidget);
  });
}
