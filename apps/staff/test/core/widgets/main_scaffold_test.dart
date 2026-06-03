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

  group('shouldNavigateWorkbenchNav', () {
    test('always allows Home navigation so nested screens can exit', () {
      expect(
        shouldNavigateWorkbenchNav(
          currentRoute: '/dashboard',
          targetRoute: '/dashboard',
        ),
        isTrue,
      );
      expect(
        shouldNavigateWorkbenchNav(
          currentRoute: '/messaging/thread/staff-1',
          targetRoute: '/dashboard',
        ),
        isTrue,
      );
    });

    test('skips duplicate non-Home workbench navigation', () {
      expect(
        shouldNavigateWorkbenchNav(
          currentRoute: '/messaging',
          targetRoute: '/messaging',
        ),
        isFalse,
      );
      expect(
        shouldNavigateWorkbenchNav(
          currentRoute: '/messaging',
          targetRoute: '/front-office',
        ),
        isTrue,
      );
    });
  });
}
