import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/widgets/main_scaffold.dart';

void main() {
  group('shouldPushWorkbenchNav', () {
    test('preserves history for desktop workbench destinations', () {
      expect(
        shouldPushWorkbenchNav(
          currentRoute: '/front-office',
          targetRoute: '/emr/admissions',
        ),
        isTrue,
      );
    });

    test('does not push duplicate routes or Home', () {
      expect(
        shouldPushWorkbenchNav(
          currentRoute: '/front-office',
          targetRoute: '/front-office',
        ),
        isFalse,
      );
      expect(
        shouldPushWorkbenchNav(
          currentRoute: '/emr/admissions',
          targetRoute: '/dashboard',
        ),
        isFalse,
      );
    });
  });
}
