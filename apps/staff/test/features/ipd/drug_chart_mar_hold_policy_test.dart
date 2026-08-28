import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/platform_info.dart';
import 'package:vhhealth_staff/features/ipd/screens/drug_chart_screen.dart';

void main() {
  test('held MAR rows never open the administration scanner', () {
    expect(
      canOpenDrugChartMarScanner('scheduled', canAdminister: true),
      isTrue,
    );
    expect(canOpenDrugChartMarScanner('held', canAdminister: true), isFalse);
    expect(
      canOpenDrugChartMarScanner('administered', canAdminister: true),
      isFalse,
    );
  });

  test('only a prescribing chart actor can release a held MAR row', () {
    for (final deviceMode in AppDeviceMode.values) {
      expect(
        canReleaseDrugChartMarHold(
          'held',
          canPrescribe: true,
          deviceMode: deviceMode,
        ),
        isTrue,
        reason: deviceMode.name,
      );
      expect(
        canReleaseDrugChartMarHold(
          'held',
          canPrescribe: false,
          deviceMode: deviceMode,
        ),
        isFalse,
        reason: deviceMode.name,
      );
    }
    expect(
      canReleaseDrugChartMarHold(
        'scheduled',
        canPrescribe: true,
        deviceMode: AppDeviceMode.desktop,
      ),
      isFalse,
    );
  });
}
