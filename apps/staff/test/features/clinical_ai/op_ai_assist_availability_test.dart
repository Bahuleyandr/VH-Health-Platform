import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/features/clinical_ai/op_ai_assist_availability.dart';

void main() {
  group('opAiModuleEnabled', () {
    test('accepts backend boolean, numeric, and string enabled values', () {
      expect(opAiModuleEnabled({'enabled': true}), isTrue);
      expect(opAiModuleEnabled({'enabled': 1}), isTrue);
      expect(opAiModuleEnabled({'enabled': 'true'}), isTrue);
      expect(opAiModuleEnabled({'enabled': false}), isFalse);
      expect(opAiModuleEnabled({'enabled': 0}), isFalse);
      expect(opAiModuleEnabled({'enabled': 'false'}), isFalse);
      expect(opAiModuleEnabled({}), isFalse);
    });
  });

  group('shouldShowOpAiAssistEntryPoint', () {
    test('requires both a doctor OP role and an enabled Admin module', () {
      final enabledModules = [
        {'module_key': 'op_visit_prep', 'enabled': true},
      ];
      final disabledModules = [
        {'module_key': 'op_visit_prep', 'enabled': false},
        {'module_key': 'op_follow_up_plan', 'enabled': false},
      ];

      expect(
        shouldShowOpAiAssistEntryPoint(
          role: StaffRole.doctor,
          modules: enabledModules,
        ),
        isTrue,
      );
      expect(
        shouldShowOpAiAssistEntryPoint(
          role: StaffRole.medicalSuperintendent,
          modules: enabledModules,
        ),
        isTrue,
      );
      expect(
        shouldShowOpAiAssistEntryPoint(
          role: StaffRole.doctor,
          modules: disabledModules,
        ),
        isFalse,
      );
      expect(
        shouldShowOpAiAssistEntryPoint(
          role: StaffRole.admin,
          modules: enabledModules,
        ),
        isFalse,
      );
    });
  });
}
