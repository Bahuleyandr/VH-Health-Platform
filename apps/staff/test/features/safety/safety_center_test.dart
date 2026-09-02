import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/features/safety/screens/safety_center_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  group('Safety Center localized presentation helpers', () {
    final strings = AppStrings.forLocale(const Locale('en'));

    test('routes critical lab alerts to localized ownership', () {
      final item = NotificationItem(
        id: '1',
        title: 'Critical potassium',
        body: 'K+ 6.7',
        timestamp: DateTime(2026, 6, 3, 10),
        type: 'CRITICAL_LAB_RESULT',
        priority: 'CRITICAL',
      );

      expect(safetyOwnerForAlert(item, strings), 'Lab / treating doctor');
      expect(
        safetyEscalationLabel(item, strings, now: DateTime(2026, 6, 3, 10, 5)),
        'Escalates in 10 min if unread',
      );
      expect(
        safetyEscalationLabel(item, strings, now: DateTime(2026, 6, 3, 10, 20)),
        'Escalated until acknowledged',
      );
    });

    test('maps discharge blockers to the accountable department', () {
      expect(
        safetyOwnerForDischargeBlocker({
          'code': 'NO_INVOICE',
          'message': 'Finalized IPD invoice missing',
        }),
        'Billing',
      );
      expect(
        safetyOwnerForDischargeBlocker({
          'type': 'pharmacy',
          'message': 'Discharge drugs not dispensed',
        }),
        'Pharmacy',
      );
      expect(
        safetyOwnerForDischargeBlocker({
          'message': 'Discharge summary must be signed',
        }),
        'Doctor',
      );
    });

    test('renders housekeeping SLA timing without needing UI state', () {
      expect(
        safetyHousekeepingSlaLabel({
          'sla_due_at': '2026-06-03T10:30:00.000Z',
        }, now: DateTime.parse('2026-06-03T10:00:00.000Z').toLocal()),
        startsWith('Due in'),
      );
      expect(
        safetyHousekeepingSlaLabel({
          'sla_due_at': '2026-06-03T09:30:00.000Z',
        }, now: DateTime.parse('2026-06-03T10:00:00.000Z').toLocal()),
        startsWith('Overdue'),
      );
    });
  });

  testWidgets(
    'real Malayalam screen hides unreviewed server English from critical row',
    (tester) async {
      const rawTitle = 'RAW ENGLISH CLINICAL TITLE';
      const rawBody = 'RAW ENGLISH CLINICAL BODY';
      const rawAction = 'RAW ENGLISH ACTION';
      const rawOwner = 'RAW ENGLISH OWNER';
      final strings = AppStrings.forLocale(const Locale('ml'));

      await tester.pumpWidget(
        _testApp(
          SafetyCenterScreen(
            enableRealtime: false,
            roleLoader: () async => null,
            notificationLoader: () async => [
              {
                'id': 'critical-1',
                'title': rawTitle,
                'message': rawBody,
                'created_at': DateTime.now().toIso8601String(),
                'type': 'UNMAPPED_CRITICAL_ALERT',
                'priority': 'CRITICAL',
                'data': {
                  'route': '/notifications',
                  'action_label': rawAction,
                  'owner_label': rawOwner,
                },
              },
            ],
            dischargeLoader: () async => <String, dynamic>{},
            housekeepingLoader: () async => <String, dynamic>{},
            resusLoader: () async => <Map<String, dynamic>>[],
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text(rawTitle), findsNothing);
      expect(find.text(rawBody), findsNothing);
      expect(find.text(rawAction), findsNothing);
      expect(find.text(rawOwner), findsNothing);
      expect(find.text('UNMAPPED_CRITICAL_ALERT'), findsNothing);
      expect(find.text('CRITICAL'), findsNothing);
      expect(
        find.text(strings.lookup('safety_center.alert.type.workflow')),
        findsWidgets,
      );
      expect(
        find.text(strings.lookup('safety_center.alert.action.open_workflow')),
        findsOneWidget,
      );
      expect(
        find.textContaining(
          strings.lookup('safety_center.alert.owner.receiving_team'),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('real Malayalam screen renders localized critical empty state', (
    tester,
  ) async {
    final strings = AppStrings.forLocale(const Locale('ml'));
    await tester.pumpWidget(
      _testApp(
        SafetyCenterScreen(
          enableRealtime: false,
          roleLoader: () async => null,
          notificationLoader: () async => const [],
          dischargeLoader: () async => <String, dynamic>{},
          housekeepingLoader: () async => <String, dynamic>{},
          resusLoader: () async => <Map<String, dynamic>>[],
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text(strings.safetyCenterCriticalAlertsEmpty), findsOneWidget);
    expect(find.text('No critical alerts waiting.'), findsNothing);
    expect(find.text('Open Alerts'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

Widget _testApp(Widget home) {
  return MaterialApp(
    locale: const Locale('ml'),
    supportedLocales: AppStrings.supportedLocales,
    localizationsDelegates: const [
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: home,
  );
}
