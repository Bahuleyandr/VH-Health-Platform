import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('S4 item 2 shared state widgets', () {
    test('named list screens use shared loading empty and error states', () {
      final screens = <String, Set<String>>{
        'lib/features/theatre/screens/theatre_screen.dart': {
          'SkeletonList(',
          'EmptyState(',
          'ErrorState(',
        },
        'lib/features/maternity/screens/maternity_screen.dart': {
          'SkeletonList(',
          'EmptyState(',
          'ErrorState(',
        },
        'lib/features/nursing/screens/vitals_screen.dart': {
          'EmptyState(',
          'ErrorState(',
        },
        'lib/features/investigations/screens/investigations_screen.dart': {
          'SkeletonList(',
          'EmptyState(',
          'ErrorState(',
        },
        'lib/features/investigations/screens/lab_bookings_screen.dart': {
          'SkeletonList(',
          'EmptyState(',
          'ErrorState(',
        },
        'lib/features/pharmacy/screens/pharmacy_screen.dart': {
          'SkeletonList(',
          'EmptyState(',
          'ErrorState(',
        },
        'lib/features/housekeeping/screens/tasks_screen.dart': {
          'SkeletonList(',
          'EmptyState(',
          'ErrorState(',
        },
        'lib/features/housekeeping/screens/my_housekeeping_screen.dart': {
          'SkeletonList(',
          'EmptyState(',
        },
        'lib/features/housekeeping/screens/housekeeping_command_screen.dart': {
          'SkeletonList(',
          'ErrorState(',
        },
        'lib/features/housekeeping/screens/housekeeping_roster_board_screen.dart':
            {'SkeletonList(', 'ErrorState('},
        'lib/features/clinical_ai/screens/clinical_ai_review_queue_screen.dart':
            {'SkeletonList(', 'EmptyState(', 'ErrorState('},
        'lib/features/reception/screens/front_office_workbench_screen.dart': {
          'SkeletonList(',
        },
        'lib/features/ipd/screens/drug_chart_screen.dart': {
          'SkeletonList(',
          'EmptyState(',
          'ErrorState(',
        },
      };

      for (final entry in screens.entries) {
        final source = File(entry.key).readAsStringSync();
        for (final expected in entry.value) {
          expect(
            source,
            contains(expected),
            reason: '${entry.key} should use shared $expected state widget.',
          );
        }
      }
    });

    test('clinical AI review queue no longer carries private state widgets', () {
      final source = File(
        'lib/features/clinical_ai/screens/clinical_ai_review_queue_screen.dart',
      ).readAsStringSync();

      expect(source, isNot(contains('class _EmptyState')));
      expect(source, isNot(contains('class _ErrorState')));
    });
  });
}
