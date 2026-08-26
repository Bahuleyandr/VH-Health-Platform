import 'api_config.dart';
import 'role_config.dart';

Future<void> replaceSpecialtyGateModeSnapshot(
  Map<String, String>? modes,
) async {
  RoleFeatures.setSpecialtyGateModes(modes);
  await ApiConfig.saveSpecialtyGateModes(modes);
}
