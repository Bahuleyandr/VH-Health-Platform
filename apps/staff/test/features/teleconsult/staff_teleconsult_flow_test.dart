import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/appointments/models/staff_appointment.dart';
import 'package:vhhealth_staff/features/teleconsult/models/staff_teleconsult_models.dart';
import 'package:vhhealth_staff/features/teleconsult/models/staff_teleconsult_route_args.dart';
import 'package:vhhealth_staff/features/teleconsult/screens/staff_teleconsult_consult_screen.dart';
import 'package:vhhealth_staff/features/teleconsult/services/staff_teleconsult_repository.dart';
import 'package:vhhealth_staff/features/teleconsult/services/staff_teleconsult_room_client.dart';
import 'package:vhhealth_staff/features/teleconsult/widgets/staff_teleconsult_badge.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('queue badge renders waiting and in-progress lobby states', (
    tester,
  ) async {
    await tester.pumpWidget(
      _localized(
        const Column(
          children: [
            StaffTeleconsultBadge(
              state: StaffTeleconsultLobbyState(
                livekitEnabled: true,
                recordingEnabled: false,
                joinState: StaffTeleconsultJoinState.lobbyOpen,
                joinable: true,
                teleconsultationId: 77,
              ),
            ),
            StaffTeleconsultBadge(
              state: StaffTeleconsultLobbyState(
                livekitEnabled: true,
                recordingEnabled: false,
                joinState: StaffTeleconsultJoinState.inProgress,
                joinable: true,
                teleconsultationId: 78,
              ),
            ),
          ],
        ),
      ),
    );

    expect(find.text('Waiting in lobby'), findsOneWidget);
    expect(find.text('In progress'), findsOneWidget);
    expect(
      find.byKey(const Key('staff-teleconsult-queue-badge')),
      findsNWidgets(2),
    );
  });

  testWidgets('requests token then joins LiveKit through the room boundary', (
    tester,
  ) async {
    final repository = _FakeStaffTeleconsultRepository();
    final roomClient = _FakeRoomClient();

    await tester.pumpWidget(
      _routerApp(_router(repository: repository, roomClient: roomClient)),
    );
    await tester.pumpAndSettle();

    expect(repository.roomStateRequests, 1);
    expect(repository.tokenRequests, 1);
    expect(roomClient.connectRequests, 1);
    expect(find.text('Video consult'), findsOneWidget);
    expect(
      find.byKey(const Key('staff-teleconsult-participant-state')),
      findsOneWidget,
    );
  });

  testWidgets('end consult disconnects media without appointment completion', (
    tester,
  ) async {
    final repository = _FakeStaffTeleconsultRepository();
    final session = FakeStaffTeleconsultRoomSession();
    final roomClient = _FakeRoomClient(session: session);

    await tester.pumpWidget(
      _routerApp(_router(repository: repository, roomClient: roomClient)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('staff-teleconsult-end-consult')));
    await tester.pumpAndSettle();

    expect(session.disconnectCount, 1);
    expect(repository.appointmentCompletionRequests, 0);
    expect(
      find.text(
        'Media is closed. The appointment remains open for clinical completion.',
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'OP note deep-link carries appointment, patient, and OP note type',
    (tester) async {
      Uri? captured;
      final router = _router(
        repository: _FakeStaffTeleconsultRepository(),
        roomClient: _FakeRoomClient(),
        extraRoutes: [
          GoRoute(
            path: '/emr/notes/:uid',
            builder: (context, state) {
              captured = state.uri;
              return const Scaffold(body: Text('OP note route'));
            },
          ),
        ],
      );

      await tester.pumpWidget(_routerApp(router));
      await tester.pumpAndSettle();

      await _tapConsultAction(
        tester,
        const Key('staff-teleconsult-op-note-action'),
      );

      expect(captured?.path, '/emr/notes/patient-uid');
      expect(captured?.queryParameters['appointment_id'], '42');
      expect(captured?.queryParameters['patient_id'], '11');
      expect(captured?.queryParameters['context'], 'op');
      expect(captured?.queryParameters['note_type'], 'op_consultation');
    },
  );

  testWidgets(
    'e-Rx action launches existing prescribing surface with context',
    (tester) async {
      Map<String, dynamic>? capturedExtra;
      final router = _router(
        repository: _FakeStaffTeleconsultRepository(),
        roomClient: _FakeRoomClient(),
        extraRoutes: [
          GoRoute(
            path: '/prescriptions',
            builder: (context, state) {
              capturedExtra = state.extra as Map<String, dynamic>?;
              return const Scaffold(body: Text('Prescription route'));
            },
          ),
        ],
      );

      await tester.pumpWidget(_routerApp(router));
      await tester.pumpAndSettle();

      await _tapConsultAction(
        tester,
        const Key('staff-teleconsult-prescription-action'),
      );

      expect(capturedExtra?['id'], 42);
      expect(capturedExtra?['patient_id'], 11);
      expect(capturedExtra?['patient_uid'], 'patient-uid');
      expect(capturedExtra?['doctor_id'], 99);
    },
  );

  test('assigned clinician can join; other staff cannot', () {
    final appointment = _staffAppointment(doctorId: 99);

    expect(appointment.canCurrentStaffJoinTeleconsult(99), isTrue);
    expect(appointment.canCurrentStaffJoinTeleconsult(100), isFalse);
    expect(appointment.canCurrentStaffJoinTeleconsult(null), isFalse);
  });

  testWidgets('recording affordance is absent from the consult surface', (
    tester,
  ) async {
    await tester.pumpWidget(
      _routerApp(
        _router(
          repository: _FakeStaffTeleconsultRepository(),
          roomClient: _FakeRoomClient(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final visibleText = tester
        .widgetList<Text>(find.byType(Text))
        .map((widget) => widget.data ?? '')
        .join(' ')
        .toLowerCase();
    expect(visibleText.contains('recording'), isFalse);
    expect(visibleText.contains('record'), isFalse);
    expect(find.byIcon(Icons.fiber_manual_record), findsNothing);
  });
}

Widget _localized(Widget child) {
  return MaterialApp(
    localizationsDelegates: const [
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    supportedLocales: AppStrings.supportedLocales,
    home: Scaffold(body: child),
  );
}

Widget _routerApp(GoRouter router) {
  return ChangeNotifierProvider(
    create: (_) => ThemeProvider(),
    child: MaterialApp.router(
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppStrings.supportedLocales,
      routerConfig: router,
    ),
  );
}

Future<void> _tapConsultAction(WidgetTester tester, Key key) async {
  final finder = find.byKey(key);
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      260,
      scrollable: find.byType(Scrollable).last,
    );
  }
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

GoRouter _router({
  required _FakeStaffTeleconsultRepository repository,
  required _FakeRoomClient roomClient,
  List<RouteBase> extraRoutes = const [],
}) {
  return GoRouter(
    initialLocation: '/teleconsult/appointments/42/consult',
    routes: [
      GoRoute(
        path: '/teleconsult/appointments/:appointmentId/consult',
        builder: (context, state) => StaffTeleconsultConsultScreen(
          appointment: _appointmentContext,
          repository: repository,
          roomClient: roomClient,
        ),
      ),
      ...extraRoutes,
    ],
  );
}

const _appointmentContext = StaffTeleconsultAppointmentContext(
  appointmentId: 42,
  teleconsultationId: 77,
  patientUid: 'patient-uid',
  patientName: 'Ravi Kumar',
  patientId: 11,
  doctorId: 99,
  doctorName: 'Dr Asha Rao',
  department: 'General Medicine',
  reason: 'Fever',
  appointmentDate: '2026-07-06',
  appointmentTime: '10:30',
  status: 'CONFIRMED',
);

StaffAppointment _staffAppointment({required int doctorId}) {
  return StaffAppointment.fromJson({
    'id': 42,
    'patient_id': 11,
    'patient_uid': 'patient-uid',
    'patient_name': 'Ravi Kumar',
    'doctor_id': doctorId,
    'doctor_name': 'Dr Asha Rao',
    'visit_type': 'TELE',
    'teleconsultation_id': 77,
    'teleconsult_livekit_enabled': true,
    'teleconsult_recording_enabled': false,
    'teleconsult_join_state': 'waiting',
    'teleconsult_joinable': true,
    'teleconsult_consent_recorded': true,
  });
}

class _FakeStaffTeleconsultRepository extends StaffTeleconsultRepository {
  final StaffTeleconsultLobbyState state = const StaffTeleconsultLobbyState(
    livekitEnabled: true,
    recordingEnabled: false,
    joinState: StaffTeleconsultJoinState.lobbyOpen,
    joinable: true,
    appointmentId: 42,
    teleconsultationId: 77,
    consentRecorded: true,
  );
  int ensureRequests = 0;
  int roomStateRequests = 0;
  int tokenRequests = 0;
  int appointmentCompletionRequests = 0;

  @override
  Future<StaffTeleconsultLobbyState> ensureForAppointment(
    int appointmentId,
  ) async {
    ensureRequests += 1;
    return state;
  }

  @override
  Future<StaffTeleconsultLobbyState> fetchRoomState(
    int teleconsultationId,
  ) async {
    roomStateRequests += 1;
    return state;
  }

  @override
  Future<StaffTeleconsultToken> requestJoinToken(int teleconsultationId) async {
    tokenRequests += 1;
    return StaffTeleconsultToken(
      serverUrl: 'wss://teleconsult.vhhealth.test',
      roomName: 'tc_test_77',
      participantToken: 'token',
      expiresAt: DateTime(2026, 7, 6, 10, 40),
    );
  }
}

class _FakeRoomClient implements StaffTeleconsultRoomClient {
  _FakeRoomClient({FakeStaffTeleconsultRoomSession? session})
    : session = session ?? FakeStaffTeleconsultRoomSession();

  final FakeStaffTeleconsultRoomSession session;
  int connectRequests = 0;

  @override
  Future<StaffTeleconsultRoomSession> connect({
    required StaffTeleconsultToken token,
    required bool publishVideo,
  }) async {
    connectRequests += 1;
    return session;
  }
}
