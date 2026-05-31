import '../../core/config/role_config.dart';

bool opAiModuleEnabled(Map<String, dynamic> module) {
  final value = module['enabled'];
  if (value is bool) return value;
  if (value is num) return value != 0;
  return value?.toString().trim().toLowerCase() == 'true';
}

bool hasEnabledOpAiAssistModule(Iterable<Map<String, dynamic>> modules) {
  return modules.any(opAiModuleEnabled);
}

bool shouldShowOpAiAssistEntryPoint({
  required StaffRole role,
  required Iterable<Map<String, dynamic>> modules,
}) {
  return RoleFeatures.hasOpAiAssist(role) &&
      hasEnabledOpAiAssistModule(modules);
}
