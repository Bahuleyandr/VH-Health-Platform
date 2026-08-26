import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';
import 'package:vhhealth/core/services/push_notification_service.dart';

void main() {
  group('DeepLinkService custom-scheme routing', () {
    test('normalizes exact allowlisted custom links to internal routes', () {
      expect(
        DeepLinkService.parseExternalRoute('vhhealth://app/appointments'),
        '/appointments',
      );
      expect(
        DeepLinkService.parseExternalRoute('vhhealth://app/portal/messages/42'),
        '/portal/messages/42',
      );
    });

    test('rejects ambiguous, privileged, and externally-owned link shapes', () {
      for (final link in <String>[
        'vhhealth://app/login',
        'vhhealth://app/admin/users',
        'vhhealth://other/appointments',
        'vhhealth://app:443/appointments',
        'vhhealth://user@app/appointments',
        'vhhealth://app/appointments?returnTo=/admin',
        'vhhealth://app/appointments#fragment',
        'https://vhhealth.app/appointments',
        ' vhhealth://app/appointments',
      ]) {
        expect(DeepLinkService.parseExternalRoute(link), isNull, reason: link);
      }
    });

    test('rejects malformed parameterized routes', () {
      expect(
        DeepLinkService.parseExternalRoute(
          'vhhealth://app/portal/messages/not-a-number',
        ),
        isNull,
      );
      expect(
        DeepLinkService.parseExternalRoute(
          'vhhealth://app/portal/messages/42/edit',
        ),
        isNull,
      );
    });
  });

  group('DeepLinkService notification routing', () {
    test('accepts stable appointment and period-tracker destinations', () {
      for (final route in <String>[
        '/appointments/42',
        '/teleconsult/appointments/42/lobby',
        '/teleconsult/appointments/42/consult',
        '/period-tracker',
      ]) {
        expect(
          DeepLinkService.parseNotificationRoute({'route': route}),
          route,
          reason: route,
        );
      }

      expect(
        DeepLinkService.parseExternalRoute(
          'vhhealth://app/teleconsult/appointments/42/lobby',
        ),
        '/teleconsult/appointments/42/lobby',
      );
    });

    test('rejects malformed appointment hydration IDs and suffixes', () {
      for (final route in <String>[
        '/appointments/0',
        '/appointments/-1',
        '/appointments/+1',
        '/appointments/999999999999999999999999999999999999999999',
        '/appointments/not-a-number',
        '/appointments/42/edit',
        '/teleconsult/appointments/0/lobby',
        '/teleconsult/appointments/-1/lobby',
        '/teleconsult/appointments/999999999999999999999999999999999999999999/lobby',
        '/teleconsult/appointments/42',
        '/teleconsult/appointments/42/edit',
        '/teleconsult/appointments/42/lobby/extra',
      ]) {
        expect(
          DeepLinkService.parseNotificationRoute({'route': route}),
          isNull,
          reason: route,
        );
      }
    });

    test('rejects non-string route and type payloads without throwing', () {
      expect(DeepLinkService.parseNotificationRoute({'route': 42}), isNull);
      expect(DeepLinkService.parseNotificationRoute({'type': 42}), isNull);
    });

    test('accepts every explicit allowlisted app route', () {
      expect(DeepLinkService.debugAllowedRoutes, isNotEmpty);

      for (final route in DeepLinkService.debugAllowedRoutes) {
        expect(
          DeepLinkService.parseNotificationRoute({'route': route}),
          route,
          reason: route,
        );
      }
    });

    test('accepts explicit allowlisted backend route', () {
      expect(
        DeepLinkService.parseNotificationRoute({
          'type': 'lab_result_ready',
          'route': '/portal/lab-results',
        }),
        '/portal/lab-results',
      );
    });

    test('rejects explicit non-allowlisted route', () {
      expect(
        DeepLinkService.parseNotificationRoute({
          'type': 'appointment_reminder',
          'route': '/admin/users',
        }),
        isNull,
      );
    });

    test('maps backend type field when route is absent', () {
      expect(
        DeepLinkService.parseNotificationRoute({
          'type': 'appointment_reminder',
        }),
        '/appointments',
      );
      expect(
        DeepLinkService.parseNotificationRoute({'type': 'lab_result_ready'}),
        '/portal/lab-results',
      );
      expect(
        DeepLinkService.parseNotificationRoute({'type': 'payment_link'}),
        '/portal/bills',
      );
      expect(
        DeepLinkService.parseNotificationRoute({'type': 'secure_message'}),
        '/portal/messages',
      );
    });

    test('allows numeric detail routes but rejects malformed IDs', () {
      expect(DeepLinkService.debugNumericIdPrefixes, isNotEmpty);

      for (final prefix in DeepLinkService.debugNumericIdPrefixes) {
        expect(
          DeepLinkService.parseNotificationRoute({'route': '${prefix}42'}),
          '${prefix}42',
          reason: prefix,
        );
        expect(
          DeepLinkService.parseNotificationRoute({'route': '${prefix}abc'}),
          isNull,
          reason: '$prefix rejects non-numeric IDs',
        );
        expect(
          DeepLinkService.parseNotificationRoute({'route': '$prefix-1'}),
          isNull,
          reason: '$prefix rejects negative IDs',
        );
        expect(
          DeepLinkService.parseNotificationRoute({'route': '$prefix+1'}),
          isNull,
          reason: '$prefix rejects signed IDs',
        );
        expect(
          DeepLinkService.parseNotificationRoute({'route': '${prefix}42/edit'}),
          isNull,
          reason: '$prefix rejects extra path segments',
        );
      }
    });

    test('maps FCM payload types to patient routes', () {
      final cases = <String, String>{
        'appointment_reminder': '/appointments',
        'appointment_confirmed': '/appointments',
        'pharmacy_order_update': '/pharmacy',
        'order_delivered': '/pharmacy',
        'investigation_result_ready': '/investigations',
        'collector_dispatched': '/investigations',
        'lab_result_ready': '/portal/lab-results',
        'results_ready': '/portal/lab-results',
        'diagnostic_result_ready': '/portal/diagnostic-results',
        'prescription_ready': '/health',
        'document_uploaded': '/health',
        'bill_ready': '/portal/bills',
        'payment_link': '/portal/bills',
        'secure_message': '/portal/messages',
        'portal_message': '/portal/messages',
        'sos_alert': '/home',
        'feedback_reply': '/feedback-history',
        'step_reward': '/steps',
        'medication_reminder': '/reminders',
      };

      for (final entry in cases.entries) {
        expect(
          PushNotificationService.routeFromPayload({'type': entry.key}),
          entry.value,
          reason: entry.key,
        );
      }
    });

    test('rejects unsafe FCM payload routes', () {
      expect(
        PushNotificationService.routeFromPayload({'route': '/admin/users'}),
        isNull,
      );
      expect(
        PushNotificationService.routeFromPayload({
          'route': '/portal/messages/not-a-number',
        }),
        isNull,
      );
    });
  });
}
