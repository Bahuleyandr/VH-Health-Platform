// Accessibility regression guard — key patient screens (audit PR 4).
//
// Pumps real route-level screens with faked services (no network, no
// Firebase) under BOTH app themes and runs Flutter's accessibility
// guideline checks. Screens named by the audit: my bookings, appointment
// booking (time-slot grid), prescriptions, medication reminders, and the
// dashboard dial. Login/OTP is covered by auth_otp_guard_test.dart, and the
// SOS outage overlay by shared_widgets_guard_test.dart.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/widgets/appointment_book_tab.dart';
import 'package:vhhealth/features/appointments/widgets/appointments_list_tab.dart';
import 'package:vhhealth/features/medications/screens/medication_reminders_screen.dart';
import 'package:vhhealth/features/your_health/widgets/prescriptions_tab.dart';

import 'a11y_guards.dart';

/// One realistic upcoming appointment (kept in the future so status logic
/// treats it as active).
String _appointmentsBody() {
  final future = DateTime.now().add(const Duration(days: 7));
  final date =
      '${future.year.toString().padLeft(4, '0')}-'
      '${future.month.toString().padLeft(2, '0')}-'
      '${future.day.toString().padLeft(2, '0')}';
  return '{"data":{"appointments":[{"id":101,"doctor_name":"Dr. Meera",'
      '"department":"Cardiology","appointment_date":"$date",'
      '"appointment_time":"10:30","status":"SCHEDULED",'
      '"reason":"Follow-up"}]}}';
}

const String _departmentsBody =
    '{"data":{"departments":[{"id":1,"name":"Cardiology","doctors":'
    '[{"id":11,"name":"Dr. Meera","specialization":"Cardiologist"}]}]}}';

const String _slotsBody =
    '{"data":{"slots":[{"time":"09:00","available":true},'
    '{"time":"09:30","available":false},{"time":"10:00","available":true}]}}';

const String _remindersBody =
    '{"data":[{"id":1,"medication_name":"Metformin","dosage":"500 mg",'
    '"frequency":"daily","reminder_times":["08:00","20:00"],'
    '"start_date":"2026-08-01","is_active":true,'
    '"source":"medication_reminder"}]}';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(installSecureStorageFake);
  tearDown(resetMockApi);

  Widget withProviders(Widget child, {String phone = '5551234567'}) {
    final user = UserProvider();
    // Seed identity synchronously — screens read `UserProvider.phone` in
    // initState. (The storage write inside setUser lands in the fake.)
    user.setUser(phone, 'Test Patient');
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<UserProvider>.value(value: user),
        ChangeNotifierProvider<WebSocketProvider>(
          create: (_) => WebSocketProvider(),
        ),
      ],
      child: child,
    );
  }

  for (final themeCase in themeCases) {
    group('[${themeCase.name}]', () {
      testWidgets('my bookings list meets tap-target guidelines', (
        tester,
      ) async {
        await withSemantics(tester, () async {
          mockApi({'/appointments/patient/patient-1': _appointmentsBody()});
          await pumpGuarded(
            tester,
            withProviders(AppointmentsListTab(onBookOne: () {})),
            theme: themeCase.theme,
            surfaceSize: const Size(1080, 2400),
          );
          await tester.pumpAndSettle();

          expect(find.text('Dr. Meera'), findsOneWidget);
          await expectMeetsA11yGuidelines(tester);
        });
      });

      testWidgets('my bookings empty state meets guidelines with contrast', (
        tester,
      ) async {
        await withSemantics(tester, () async {
          mockApi({
            '/appointments/patient/patient-1': '{"data":{"appointments":[]}}',
          });
          await pumpGuarded(
            tester,
            withProviders(AppointmentsListTab(onBookOne: () {})),
            theme: themeCase.theme,
          );
          await tester.pumpAndSettle();

          expect(find.text('No appointments yet'), findsOneWidget);
          await expectMeetsA11yGuidelines(tester, textContrast: true);
        });
      });

      testWidgets('appointment booking form meets tap-target guidelines', (
        tester,
      ) async {
        await withSemantics(tester, () async {
          mockApi({'/departments/departments-with-doctors': _departmentsBody});
          await pumpGuarded(
            tester,
            withProviders(AppointmentBookTab(onBooked: () {})),
            theme: themeCase.theme,
            surfaceSize: const Size(1080, 2400),
          );
          await tester.pumpAndSettle();

          await expectMeetsA11yGuidelines(tester);
        });
      });

      testWidgets('medication reminders meet tap-target guidelines', (
        tester,
      ) async {
        await withSemantics(tester, () async {
          mockApi({'/reminders/medication': _remindersBody});
          await pumpGuarded(
            tester,
            withProviders(const MedicationRemindersScreen()),
            theme: themeCase.theme,
            useScaffold: false,
            surfaceSize: const Size(1080, 2400),
          );
          await tester.pumpAndSettle();

          expect(find.text('Metformin'), findsOneWidget);
          // labeled: false — the add-reminder FAB is a known unlabeled tap
          // target; the skipped guard below owns that assertion.
          await expectMeetsA11yGuidelines(tester, labeled: false);
        });
      });

      testWidgets('prescriptions empty state meets guidelines with contrast', (
        tester,
      ) async {
        await withSemantics(tester, () async {
          mockApi({'/prescriptions/patient/my': '{"data":[]}'});
          await pumpGuarded(
            tester,
            withProviders(const PrescriptionsTab(phone: '5551234567')),
            theme: themeCase.theme,
          );
          await tester.pumpAndSettle();

          await expectMeetsA11yGuidelines(tester, textContrast: true);
        });
      });

      testWidgets('dashboard dial entries are labeled buttons meeting '
          'guidelines', (tester) async {
        await withSemantics(tester, () async {
          await pumpGuarded(
            tester,
            Center(
              child: CircularFeatureDial(
                size: 420,
                enableHaptics: false,
                features: [
                  FeatureIconData(
                    icon: Icons.calendar_month,
                    label: 'Appointments',
                    color: Colors.blue,
                    onTap: (_) {},
                  ),
                  FeatureIconData(
                    icon: Icons.local_pharmacy,
                    label: 'Pharmacy',
                    color: Colors.green,
                    onTap: (_) {},
                  ),
                  FeatureIconData(
                    icon: Icons.science,
                    label: 'Investigations',
                    color: Colors.teal,
                    onTap: (_) {},
                  ),
                ],
              ),
            ),
            theme: themeCase.theme,
            surfaceSize: const Size(1080, 1400),
          );
          await tester.pump(const Duration(seconds: 2));

          final appointments = find.semantics
              .byLabel('Appointments')
              .evaluate()
              .single;
          expect(appointments.flagsCollection.isButton, isTrue);
          expect(
            find.semantics
                .byLabel('Pharmacy')
                .evaluate()
                .single
                .flagsCollection
                .isButton,
            isTrue,
          );
          await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        });
      });
    });
  }

  group('medication reminders FAB', () {
    testWidgets('every tappable node on the reminders screen is labeled', (
      tester,
    ) async {
      await withSemantics(tester, () async {
        mockApi({'/reminders/medication': _remindersBody});
        await pumpGuarded(
          tester,
          withProviders(const MedicationRemindersScreen()),
          theme: themeCases.first.theme,
          useScaffold: false,
          surfaceSize: const Size(1080, 2400),
        );
        await tester.pumpAndSettle();

        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      });
    });
  });

  group('dashboard dial centre control', () {
    testWidgets('every tappable node in the dial is labeled', (tester) async {
      await withSemantics(tester, () async {
        await pumpGuarded(
          tester,
          Center(
            child: CircularFeatureDial(
              size: 420,
              enableHaptics: false,
              features: [
                FeatureIconData(
                  icon: Icons.calendar_month,
                  label: 'Appointments',
                  color: Colors.blue,
                  onTap: (_) {},
                ),
              ],
            ),
          ),
          theme: themeCases.first.theme,
          surfaceSize: const Size(1080, 1400),
        );
        await tester.pump(const Duration(seconds: 2));

        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      });
    });
  });

  group('appointment time-slot chips', () {
    testWidgets('slot chips meet tap-target and label guidelines', (
      tester,
    ) async {
      await withSemantics(tester, () async {
        mockApi({
          '/departments/departments-with-doctors': _departmentsBody,
          '/appointments/slots': _slotsBody,
        });
        await pumpGuarded(
          tester,
          withProviders(AppointmentBookTab(onBooked: () {})),
          theme: themeCases.first.theme,
          surfaceSize: const Size(1080, 2400),
        );
        await tester.pumpAndSettle();

        // Drive the form far enough for the slot grid to render:
        // department → doctor → date (via the material date picker).
        await tester.tap(find.byType(DropdownButtonFormField<DeptInfo>));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Cardiology').last);
        await tester.pumpAndSettle();

        await tester.tap(find.byType(DropdownButtonFormField<DoctorInfo>));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Dr. Meera (Cardiologist)').last);
        await tester.pumpAndSettle();

        await tester.tap(find.text('Select Date'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        // The slot grid is on screen …
        expect(find.text('Select Time Slot'), findsOneWidget);
        expect(find.text('09:00'), findsOneWidget);

        // … and every chip must be a >=48dp labeled tap target.
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      });
    });
  });
}
