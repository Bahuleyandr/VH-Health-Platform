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

List<DashboardFeature> featuresWithOpAiAssistAvailability({
  required StaffRole role,
  required List<DashboardFeature> features,
  required Iterable<Map<String, dynamic>> modules,
}) {
  if (shouldShowOpAiAssistEntryPoint(role: role, modules: modules)) {
    return features;
  }
  return features
      .where((feature) => feature.id != 'op_ai_assist')
      .toList(growable: false);
}
