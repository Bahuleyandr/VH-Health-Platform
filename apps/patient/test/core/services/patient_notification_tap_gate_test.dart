import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/patient_notification_tap_gate.dart';

void main() {
  test(
    'waits for current backend session revalidation before navigating',
    () async {
      final readiness = Completer<bool>();
      final routes = <String>[];
      final gate = PatientNotificationTapGate(
        revalidateSession: () => readiness.future,
        navigate: routes.add,
      );

      final pending = gate.open(const {
        'route': '/notifications',
        'action': 'open_notification_inbox',
      });
      await Future<void>.delayed(Duration.zero);

      expect(routes, isEmpty);

      readiness.complete(true);

      expect(await pending, isTrue);
      expect(routes, ['/notifications']);
    },
  );

  test(
    'does not navigate when the backend session cannot be revalidated',
    () async {
      final routes = <String>[];
      final gate = PatientNotificationTapGate(
        revalidateSession: () async => false,
        navigate: routes.add,
      );

      expect(
        await gate.open(const {
          'route': '/notifications',
          'action': 'open_notification_inbox',
        }),
        isFalse,
      );
      expect(routes, isEmpty);
    },
  );

  test('fails closed when session revalidation throws', () async {
    final routes = <String>[];
    final gate = PatientNotificationTapGate(
      revalidateSession: () => throw StateError('readiness unavailable'),
      navigate: routes.add,
    );

    expect(
      await gate.open(const {
        'route': '/notifications',
        'action': 'open_notification_inbox',
      }),
      isFalse,
    );
    expect(routes, isEmpty);
  });

  test('rejects an invalid payload without probing the session', () async {
    var probes = 0;
    final routes = <String>[];
    final gate = PatientNotificationTapGate(
      revalidateSession: () async {
        probes++;
        return true;
      },
      navigate: routes.add,
    );

    expect(await gate.open(const {'route': '/not-allowed'}), isFalse);
    expect(probes, 0);
    expect(routes, isEmpty);
  });

  test(
    'notification inbox route keeps cache reads behind the biometric gate',
    () {
      final source = File(
        'lib/core/navigation/app_router.dart',
      ).readAsStringSync();

      expect(
        RegExp(
          r"path: '/notifications',[\s\S]{0,180}_biometricGated\([\s\S]{0,100}NotificationsScreen\(\)",
        ).hasMatch(source),
        isTrue,
      );
    },
  );

  test('push tap handlers use the current-session gate', () {
    final source = File(
      'lib/core/services/push_notification_service.dart',
    ).readAsStringSync();

    expect(
      source,
      contains(
        'revalidateSession: () => '
        'PatientOutageController.instance.probeNow()',
      ),
    );
    expect(
      RegExp(r'_notificationTapGate\.open\(').allMatches(source).length,
      2,
    );
  });

  test('app root forwards lifecycle changes to the biometric grant owner', () {
    final source = File('lib/main.dart').readAsStringSync();

    expect(source, contains('BiometricGate.handleAppLifecycleState(state)'));
  });
}
