import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  const retiredWidgets = <String>[
    'appointment_card.dart',
    'feature_grid.dart',
    'health_points_widget.dart',
    'quick_action_button.dart',
    'smart_investigation_card.dart',
    'smart_pharmacy_card.dart',
    'smart_prescription_card.dart',
    'today_appointment_card.dart',
  ];

  test('retired dashboard widgets stay absent', () {
    for (final filename in retiredWidgets) {
      expect(
        File('lib/features/dashboard/widgets/$filename').existsSync(),
        isFalse,
        reason: filename,
      );
    }
  });

  test('the live appointments card remains outside the dashboard', () {
    expect(
      File(
        'lib/features/appointments/widgets/appointment_card.dart',
      ).existsSync(),
      isTrue,
    );
  });

  test('patient documentation does not point at retired dashboard widgets', () {
    final documentation = <File>[
      File('docs/DARK_MODE_AUDIT.md'),
      File(
        '../../docs/superpowers/specs/2026-07-07-nl9-engagement-crm-design.md',
      ),
    ];

    for (final file in documentation) {
      final source = file.readAsStringSync();
      for (final filename in retiredWidgets) {
        expect(source, isNot(contains('dashboard/widgets/$filename')));
      }
    }
  });
}
