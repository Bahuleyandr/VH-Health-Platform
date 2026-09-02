import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('polished patient screens keep visible copy in AppLocalizations', () {
    const files = [
      // Lane L: the ABHA self-enrolment wizard was hardcoded English in a
      // five-language app. Listed here so it cannot drift back.
      'lib/features/abdm/screens/abdm_screen.dart',
      'lib/features/abdm/widgets/abha_enrolment_flow.dart',
      'lib/core/widgets/main_scaffold_go_router.dart',
      'lib/features/appointments/screens/appointments_screen.dart',
      'lib/features/pharmacy/screens/pharmacy_screen.dart',
      'lib/features/pharmacy/widgets/order_form_tab.dart',
      'lib/features/portal/screens/bills_screen.dart',
      'lib/features/portal/screens/tpa_claims_screen.dart',
      'lib/features/profile/screens/add_dependent_screen.dart',
      'lib/features/medications/screens/medication_reminders_screen.dart',
      'lib/features/investigations/screens/book_investigation_screen.dart',
      'lib/features/investigations/widgets/book_investigation_step_choose.dart',
      'lib/features/investigations/widgets/book_investigation_step_collection.dart',
      'lib/features/vitals/widgets/vitals_form_tab.dart',
      'lib/features/vitals/widgets/vitals_history_tab.dart',
      'lib/features/your_health/screens/your_health_screen.dart',
    ];
    final patterns = <RegExp>[
      RegExp(r'''Text\(\s*(?:const\s+)?['"]'''),
      RegExp(r'''Tab\([^\n]*text:\s*['"]'''),
      RegExp(r'''SnackBar\([^\n]*content:\s*(?:const\s+)?Text\(\s*['"]'''),
      RegExp(r'''labelText:\s*['"]'''),
      RegExp(r'''hintText:\s*['"]'''),
      RegExp(r'''tooltip:\s*['"]'''),
    ];
    final abdmScreenPatterns = <RegExp>[
      RegExp(r'''message:\s*['"]'''),
      RegExp(r'''_loadError\s*=\s*['"]'''),
      RegExp(r'''_showSnackBar\(\s*['"]'''),
      RegExp(r'''\?\?\s*['"][A-Z][a-z]'''),
      RegExp(r'''return\s+['"][A-Z][a-z]'''),
    ];

    final hits = <String>[];
    for (final filePath in files) {
      final filePatterns = [
        ...patterns,
        if (filePath == 'lib/features/abdm/screens/abdm_screen.dart')
          ...abdmScreenPatterns,
      ];
      final lines = File(filePath).readAsLinesSync();
      for (var i = 0; i < lines.length; i += 1) {
        final line = lines[i];
        if (filePatterns.any((pattern) => pattern.hasMatch(line))) {
          hits.add('$filePath:${i + 1}: ${line.trim()}');
        }
      }
    }

    expect(
      hits,
      isEmpty,
      reason: 'Move user-visible copy in polished screens to AppLocalizations.',
    );
  });
}
