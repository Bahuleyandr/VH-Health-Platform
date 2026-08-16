// HIGH-1 regression pins for the SOS responder loop:
//   * the generated sos_response contract group mirrors backend
//     emergencyResponderRoutes RBAC exactly (+ SUPER_ADMIN bypass);
//   * StaffRoutePolicy admits exactly those roles on /sos-response;
//   * the EMERGENCY push finally has an action route (deep-linked to the
//     alert when data.sos_alert_id is present) and an "Open SOS alert" label;
//   * local-notification tap payloads map to the responder surface;
//   * the screen renders from the responder dashboard and the respond flow
//     POSTs the required responseMessage to the backend endpoint.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/config/staff_role_contract.g.dart';
import 'package:vhhealth_staff/core/navigation/staff_route_policy.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/core/services/staff_local_notifications.dart';
import 'package:vhhealth_staff/features/safety/screens/sos_response_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('sos_response role contract', () {
    test(
      'pins the roster to backend emergencyResponderRoutes + SUPER_ADMIN',
      () {
        // rbacConfig.js emergencyResponderRoutes = [EMERGENCY_RESPONDER,
        // SECURITY, DRIVER, ADMIN, CMO, MEDICAL_SUPERINTENDENT]; SUPER_ADMIN
        // is included because requireRole grants it an un-scoped bypass.
        expect(canonicalStaffFeatureRouteRoleCodes['sos_response'], {
          'SUPER_ADMIN',
          'MEDICAL_SUPERINTENDENT',
          'ADMIN',
          'DRIVER',
          'SECURITY',
          'EMERGENCY_RESPONDER',
          'CMO',
        });
      },
    );

    test('route policy admits exactly the contract roster', () {
      final allowedRoster =
          canonicalStaffFeatureRouteRoleCodes['sos_response']!;
      for (final rawRole in canonicalStaffRoleCodes) {
        for (final path in const ['/sos-response', '/sos-response/42']) {
          expect(
            StaffRoutePolicy.authorize(
              Uri.parse(path),
              rawRole: rawRole,
            ).allowed,
            allowedRoster.contains(rawRole),
            reason: '$rawRole $path',
          );
        }
      }
      // ER_STAFF is deliberately NOT admitted: the backend does not alias it
      // into emergencyResponderRoutes, so mirroring exactly means it stays
      // out until the backend group changes.
      expect(
        StaffRoutePolicy.authorize(
          Uri.parse('/sos-response'),
          rawRole: 'ER_STAFF',
        ).allowed,
        isFalse,
      );
    });

    test('responder-tier roles surface the dashboard feature tile', () {
      for (final rawRole in const [
        'EMERGENCY_RESPONDER',
        'SECURITY',
        'DRIVER',
        'ADMIN',
        'CMO',
        'MEDICAL_SUPERINTENDENT',
        'SUPER_ADMIN',
      ]) {
        final ids = RoleFeatures.getFeaturesForRawRole(rawRole)
            .map((feature) => feature.id)
            .toSet();
        expect(ids, contains('sos_response'), reason: rawRole);
      }
      final nurseIds = RoleFeatures.getFeaturesForRawRole('NURSING_STAFF')
          .map((feature) => feature.id)
          .toSet();
      expect(nurseIds, isNot(contains('sos_response')));
    });
  });

  group('EMERGENCY push routing', () {
    NotificationItem item(String type, [Map<String, dynamic> data = const {}]) {
      return NotificationItem(
        title: 'SOS Alert',
        body: 'help',
        timestamp: DateTime(2026, 8, 15, 10),
        type: type,
        data: data,
      );
    }

    test('EMERGENCY with sos_alert_id deep-links to the alert', () {
      expect(
        item('EMERGENCY', {'sos_alert_id': '42'}).actionRoute,
        '/sos-response/42',
      );
    });

    test('EMERGENCY without an id routes to the responder list', () {
      expect(item('EMERGENCY').actionRoute, '/sos-response');
      expect(item('SOS_ALERT').actionRoute, '/sos-response');
    });

    test('SOS_BROADCAST stays informational (no responder route)', () {
      expect(item('SOS_BROADCAST').actionRoute, isNull);
    });

    test('EMERGENCY carries the Open SOS alert action label', () {
      expect(item('EMERGENCY').actionLabel, 'Open SOS alert');
    });

    test('an explicit backend route still wins', () {
      expect(
        item('EMERGENCY', {'route': '/sos-response/7'}).actionRoute,
        '/sos-response/7',
      );
    });
  });

  group('local notification payloads', () {
    test('payload builder embeds the durable alert id when usable', () {
      expect(sosAlertPayloadFromData({'sos_alert_id': 42}), 'sos_alert:42');
      expect(sosAlertPayloadFromData({'sos_alert_id': 'nope'}), 'sos_alert');
      expect(sosAlertPayloadFromData(const {}), 'sos_alert');
    });

    test('tap routes mirror the Code Blue deep-link precedent', () {
      expect(routeForNotificationPayload('sos_alert:42'), '/sos-response/42');
      expect(routeForNotificationPayload('sos_alert:0'), '/sos-response');
      expect(routeForNotificationPayload('sos_alert'), '/sos-response');
      // Existing mappings unchanged.
      expect(routeForNotificationPayload('code_blue:7'), '/safety/resus/7');
      expect(routeForNotificationPayload('staff_message'), '/messaging');
    });
  });

  group('SosResponseScreen', () {
    setUp(() {
      FlutterSecureStorage.setMockInitialValues({});
      VHHttpClient.resetClientForTesting();
    });

    tearDown(VHHttpClient.resetClientForTesting);

    Map<String, dynamic> alertRow({
      int id = 42,
      String status = 'ACTIVE',
      String severity = 'CRITICAL',
    }) {
      return {
        'id': id,
        'phone': '+919999999999',
        'latitude': 13.0827,
        'longitude': 80.2707,
        'alert_type': 'medical',
        'severity': severity,
        'status': status,
        'message': 'Chest pain, need help',
        'raised_at': DateTime.now()
            .subtract(const Duration(minutes: 3))
            .toIso8601String(),
        'responded_by': null,
        'responded_at': null,
        'response_message': null,
      };
    }

    http.Response ok(Object data) => http.Response(
      jsonEncode({'success': true, 'data': data}),
      200,
      headers: {'content-type': 'application/json'},
    );

    testWidgets('renders active alerts from the responder dashboard', (
      tester,
    ) async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.url.path.endsWith('/sos/responder/dashboard')) {
            return ok({
              'alerts': [alertRow()],
            });
          }
          if (request.url.path.endsWith('/sos/responder/analytics')) {
            return ok({
              'total_responded': 3,
              'avg_response_seconds': 95,
              'resolved_count': 2,
            });
          }
          fail('unexpected request: ${request.url}');
        }),
      );

      await tester.pumpWidget(const MaterialApp(home: SosResponseScreen()));
      await tester.pump();
      await tester.pump();

      expect(find.textContaining('#42'), findsOneWidget);
      expect(find.text('Chest pain, need help'), findsOneWidget);
      expect(find.text('ACTIVE'), findsOneWidget);
      expect(find.text('Respond'), findsOneWidget);
      expect(find.text('Resolve'), findsOneWidget);
    });

    testWidgets('respond flow POSTs the required message to the backend', (
      tester,
    ) async {
      String? postedBody;
      String? postedPath;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.url.path.endsWith('/sos/responder/dashboard')) {
            return ok({
              'alerts': [alertRow()],
            });
          }
          if (request.url.path.endsWith('/sos/responder/analytics')) {
            return ok(const <String, dynamic>{});
          }
          if (request.method == 'POST' &&
              request.url.path.contains('/sos/responder/respond/')) {
            postedPath = request.url.path;
            postedBody = request.body;
            return ok({'id': 42, 'status': 'RESPONDING'});
          }
          fail('unexpected request: ${request.method} ${request.url}');
        }),
      );

      await tester.pumpWidget(const MaterialApp(home: SosResponseScreen()));
      await tester.pump();
      await tester.pump();

      await tester.tap(find.text('Respond'));
      await tester.pumpAndSettle();

      // Confirm without text is blocked (validator parity: required).
      await tester.tap(find.widgetWithText(FilledButton, 'Respond').last);
      await tester.pumpAndSettle();
      expect(postedBody, isNull);

      await tester.enterText(
        find.byType(TextField).last,
        'On my way, 2 minutes out',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Respond').last);
      await tester.pump();
      await tester.pump();

      expect(postedPath, endsWith('/sos/responder/respond/42'));
      expect(jsonDecode(postedBody!), {
        'responseMessage': 'On my way, 2 minutes out',
      });
    });

    testWidgets('deep-linked focus on a no-longer-active alert is honest', (
      tester,
    ) async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.url.path.endsWith('/sos/responder/dashboard')) {
            return ok({'alerts': const []});
          }
          if (request.url.path.endsWith('/sos/responder/analytics')) {
            return ok(const <String, dynamic>{});
          }
          fail('unexpected request: ${request.url}');
        }),
      );

      await tester.pumpWidget(
        const MaterialApp(home: SosResponseScreen(focusAlertId: 99)),
      );
      await tester.pump();
      await tester.pump();

      expect(find.textContaining('no longer active'), findsOneWidget);
      expect(find.text('No active SOS alerts.'), findsOneWidget);
    });
  });

  group('screen helpers', () {
    test('severity colors and age labels', () {
      expect(sosSeverityColor('CRITICAL'), isNot(sosSeverityColor('MEDIUM')));
      final now = DateTime.parse('2026-08-15T10:30:00Z');
      expect(
        sosAlertAgeLabel('2026-08-15T10:27:00Z', now: now.toLocal()),
        '3m',
      );
      expect(
        sosAlertAgeLabel('2026-08-15T09:00:00Z', now: now.toLocal()),
        '1h 30m',
      );
      expect(sosAlertAgeLabel(null), '');
    });
  });
}
