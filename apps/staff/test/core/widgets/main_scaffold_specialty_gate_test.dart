import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/api_config.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/config/specialty_gate_mode_snapshot.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    RoleFeatures.setSpecialtyGateModes(null);
  });

  tearDown(() => RoleFeatures.setSpecialtyGateModes(null));

  test(
    'successful null snapshot replaces memory and persisted enforce mode',
    () async {
      await ApiConfig.saveSpecialtyGateModes(const {'oncology': 'enforce'});
      RoleFeatures.setSpecialtyGateModes(const {'oncology': 'enforce'});

      await replaceSpecialtyGateModeSnapshot(null);

      expect(RoleFeatures.specialtyGateModes, isNull);
      expect(await ApiConfig.getSpecialtyGateModes(), isNull);
    },
  );

  test('successful report snapshot replaces an older enforce mode', () async {
    RoleFeatures.setSpecialtyGateModes(const {'oncology': 'enforce'});

    await replaceSpecialtyGateModeSnapshot(const {'oncology': 'report'});

    expect(RoleFeatures.specialtyGateModes, const {'oncology': 'report'});
    expect(await ApiConfig.getSpecialtyGateModes(), const {
      'oncology': 'report',
    });
  });
}
