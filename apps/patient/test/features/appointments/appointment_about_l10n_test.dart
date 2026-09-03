import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/features/about/screens/about_us_screen.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/widgets/appointment_book_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

import '../../a11y/a11y_guards.dart';

const _fiveLocales = ['en', 'hi', 'ta', 'te', 'ml'];

const _ownedKeys = [
  'appointmentSelectDateError',
  'appointmentSelectAvailableSlotError',
  'appointmentSelectDoctorError',
  'appointmentSessionMissingError',
  'appointmentReasonForVisitLabel',
  'appointmentReasonForVisitHint',
  'appointmentSelectDateLabel',
  'appointmentSelectedTime',
  'appointmentSelectTimeLabel',
  'aboutDoctorAppointmentsTitle',
  'aboutHomeSampleAction',
  'aboutFreeHomeSampleCollectionTitle',
  'aboutAmbulanceAction',
  'aboutEmergencyAmbulanceTitle',
  'aboutNavigateAction',
];

const _departmentsBody =
    '{"data":{"departments":[{"id":1,"name":"Cardiology","doctors":'
    '[{"id":11,"name":"Dr. Meera","specialization":"Cardiologist"}]}]}}';

Widget _localizedApp(Locale locale, Widget home) => MaterialApp(
  locale: locale,
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: home,
);

Widget _appointmentHarness(Locale locale) {
  final user = UserProvider()..setUser('5551234567', 'Test Patient');
  return _localizedApp(
    locale,
    MultiProvider(
      providers: [
        ChangeNotifierProvider<UserProvider>.value(value: user),
        ChangeNotifierProvider<DependentsProvider>(
          create: (_) => DependentsProvider(),
        ),
      ],
      child: Scaffold(body: AppointmentBookTab(onBooked: () {})),
    ),
  );
}

Map<String, dynamic> _readArb(String locale) =>
    jsonDecode(File('lib/l10n/intl_$locale.arb').readAsStringSync())
        as Map<String, dynamic>;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    installSecureStorageFake();
    mockApi({'/departments/departments-with-doctors': _departmentsBody});
  });

  tearDown(resetMockApi);

  test(
    'appointment and About keys are generated for all five locales',
    () async {
      final arbs = {
        for (final locale in _fiveLocales) locale: _readArb(locale),
      };

      for (final key in _ownedKeys) {
        final english = arbs['en']![key];
        expect(english, isA<String>(), reason: 'English is missing $key');
        for (final locale in _fiveLocales.skip(1)) {
          expect(
            arbs[locale]![key],
            isA<String>(),
            reason: '$locale is missing $key',
          );
          expect(
            arbs[locale]![key],
            isNot(english),
            reason: '$key silently falls back to English in $locale',
          );
        }
      }

      for (final locale in _fiveLocales) {
        final l10n = await AppLocalizations.delegate.load(Locale(locale));
        expect(l10n.appointmentSelectDateError, isNotEmpty);
        expect(l10n.appointmentSelectAvailableSlotError, isNotEmpty);
        expect(l10n.appointmentSelectDoctorError, isNotEmpty);
        expect(l10n.appointmentSessionMissingError, isNotEmpty);
        expect(l10n.appointmentReasonForVisitLabel, isNotEmpty);
        expect(l10n.appointmentReasonForVisitHint, isNotEmpty);
        expect(l10n.appointmentSelectDateLabel, isNotEmpty);
        expect(l10n.appointmentSelectedTime('09:30'), contains('09:30'));
        expect(l10n.appointmentSelectTimeLabel, isNotEmpty);
        expect(l10n.aboutDoctorAppointmentsTitle, isNotEmpty);
        expect(l10n.aboutHomeSampleAction, isNotEmpty);
        expect(l10n.aboutFreeHomeSampleCollectionTitle, isNotEmpty);
        expect(l10n.aboutAmbulanceAction, isNotEmpty);
        expect(l10n.aboutEmergencyAmbulanceTitle, isNotEmpty);
        expect(l10n.aboutNavigateAction, isNotEmpty);
      }
    },
  );

  testWidgets('appointment form and validation render in Malayalam', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final ml = await AppLocalizations.delegate.load(const Locale('ml'));

    await tester.pumpWidget(_appointmentHarness(const Locale('ml')));
    await tester.pumpAndSettle();

    expect(find.text(ml.appointmentReasonForVisitLabel), findsOneWidget);
    expect(find.text(ml.appointmentReasonForVisitHint), findsOneWidget);
    expect(find.text(ml.appointmentSelectDateLabel), findsOneWidget);
    expect(find.text(ml.appointmentSelectTimeLabel), findsOneWidget);
    expect(find.text('Reason for visit'), findsNothing);
    expect(find.text('Select Date'), findsNothing);
    expect(find.text('Select Time'), findsNothing);

    await tester.tap(find.byType(DropdownButtonFormField<DeptInfo>));
    await tester.pumpAndSettle();
    await tester.tap(find.text(ml.cardiology).last);
    await tester.pumpAndSettle();

    await tester.tap(find.text(ml.submitRequest));
    await tester.pump();
    expect(find.text(ml.appointmentSelectDoctorError), findsOneWidget);

    await tester.tap(find.byType(DropdownButtonFormField<DoctorInfo>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Dr. Meera (Cardiologist)').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text(ml.submitRequest));
    await tester.pump();
    expect(find.text(ml.appointmentSelectDateError), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('About contact actions and sheet title render in Malayalam', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final ml = await AppLocalizations.delegate.load(const Locale('ml'));

    await tester.pumpWidget(
      _localizedApp(const Locale('ml'), const AboutUsScreen()),
    );
    await tester.pumpAndSettle();

    expect(find.text(ml.appointments), findsOneWidget);
    expect(find.text(ml.aboutHomeSampleAction), findsOneWidget);
    expect(find.text(ml.aboutAmbulanceAction), findsOneWidget);
    expect(find.text(ml.aboutNavigateAction), findsOneWidget);
    expect(find.text('Home Sample'), findsNothing);
    expect(find.text('Ambulance'), findsNothing);

    await tester.tap(find.text(ml.aboutHomeSampleAction));
    await tester.pumpAndSettle();
    expect(find.text(ml.aboutFreeHomeSampleCollectionTitle), findsOneWidget);
    expect(find.text('Free Home Sample Collection'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  test('the owned source no longer carries the English literals', () {
    final source = [
      File('lib/features/appointments/widgets/appointment_book_tab.dart')
          .readAsStringSync(),
      File('lib/features/about/screens/about_us_screen.dart')
          .readAsStringSync(),
    ].join('\n');

    for (final literal in const [
      'Please select a date',
      'Please select an available time slot',
      'Please select a doctor',
      'User session not found. Please log out and log back in.',
      'Reason for visit',
      'e.g. Regular checkup, headache, follow-up...',
      'Select Date',
      'Selected: ',
      'Select Time',
      'Doctor Appointments',
      'Home Sample',
      'Free Home Sample Collection',
      'Emergency Ambulance',
      "label: 'Ambulance'",
      "label: 'Navigate'",
    ]) {
      expect(source, isNot(contains(literal)), reason: 'hardcoded: $literal');
    }
  });
}
