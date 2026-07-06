import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/widgets/appointment_card.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_route_args.dart';
import 'package:vhhealth/features/teleconsult/screens/teleconsult_consult_screen.dart';
import 'package:vhhealth/features/teleconsult/screens/teleconsult_lobby_screen.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_device_service.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_room_client.dart';
import 'package:vhhealth/features/teleconsult/widgets/teleconsult_status_panel.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('renders the five patient lobby states', (tester) async {
    final cases = <TeleconsultJoinState, String>{
      TeleconsultJoinState.notYet: 'Lobby opens closer to your visit',
      TeleconsultJoinState.lobbyOpen: 'Lobby is open',
      TeleconsultJoinState.inProgress: 'Consultation in progress',
      TeleconsultJoinState.ended: 'Consultation ended',
      TeleconsultJoinState.cancelled: 'Consultation cancelled',
    };

    for (final entry in cases.entries) {
      await tester.pumpWidget(
        _localized(
          TeleconsultStatusPanel(
            state: _lobbyState(joinState: entry.key, joinable: true),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(entry.value), findsOneWidget);
    }
  });

  testWidgets('does not request a token before consent succeeds', (
    tester,
  ) async {
    final repository = _FakeTeleconsultRepository(
      lobbyState: _lobbyState(joinable: true),
    );
    final roomClient = _FakeRoomClient();
    final router = _teleconsultRouter(
      repository: repository,
      deviceService: const _FakeDeviceService(
        TeleconsultDeviceReadiness(
          kind: TeleconsultReadinessKind.videoReady,
          cameraGranted: true,
          microphoneGranted: true,
        ),
      ),
      roomClient: roomClient,
    );

    await tester.pumpWidget(_routerApp(router));
    await tester.pumpAndSettle();

    expect(repository.tokenRequests, 0);
    await _tapVisible(tester, 'Continue to call');
    await tester.pumpAndSettle();
    expect(
      find.text('Please accept all consent items before joining.'),
      findsOneWidget,
    );
    expect(repository.tokenRequests, 0);

    for (final label in const [
      'I confirm this appointment is for me.',
      'I agree to a remote video or audio consultation.',
      'I understand video may switch to audio-only or secure messages.',
      'I understand this is not for emergencies.',
      'I understand recording is off.',
    ]) {
      await _tapVisible(tester, label);
      await tester.pump();
    }

    await _tapVisible(tester, 'Continue to call');
    await tester.pumpAndSettle();

    expect(repository.consentRequests, 1);
    expect(repository.tokenRequests, 1);
    expect(roomClient.connectRequests, 1);
    expect(find.text('Video consultation'), findsOneWidget);
  });

  testWidgets('shows permission denied readiness in the lobby', (tester) async {
    await tester.pumpWidget(
      _localized(
        TeleconsultLobbyScreen(
          appointment: _teleAppointment,
          initialState: _lobbyState(joinable: true),
          repository: _FakeTeleconsultRepository(
            lobbyState: _lobbyState(joinable: true),
          ),
          deviceService: const _FakeDeviceService(
            TeleconsultDeviceReadiness(
              kind: TeleconsultReadinessKind.unavailable,
              cameraGranted: false,
              microphoneGranted: false,
            ),
          ),
          roomClient: _FakeRoomClient(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('Microphone permission is required to join.'),
      findsOneWidget,
    );
    final button = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Continue to call'),
    );
    expect(button.onPressed, isNull);
  });

  testWidgets('audio-only degradation banner appears after switching modes', (
    tester,
  ) async {
    final session = FakeTeleconsultRoomSession();
    await tester.pumpWidget(
      _localized(
        TeleconsultConsultScreen(
          appointment: _teleAppointment,
          lobbyState: _lobbyState(joinable: true, consentRecorded: true),
          readiness: const TeleconsultDeviceReadiness(
            kind: TeleconsultReadinessKind.videoReady,
            cameraGranted: true,
            microphoneGranted: true,
          ),
          repository: _FakeTeleconsultRepository(),
          roomClient: _FakeRoomClient(session: session),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await _tapVisible(tester, 'Audio only');
    await tester.pumpAndSettle();

    expect(find.text('Audio-only mode is active.'), findsOneWidget);
    expect(session.cameraEnabled, isFalse);
  });

  testWidgets('secure message fallback deep-links to the thread', (
    tester,
  ) async {
    final repository = _FakeTeleconsultRepository(threadId: 77);
    final router = GoRouter(
      initialLocation: '/consult',
      routes: [
        GoRoute(
          path: '/consult',
          builder: (context, state) => TeleconsultConsultScreen(
            appointment: _teleAppointment,
            lobbyState: _lobbyState(joinable: true, consentRecorded: true),
            readiness: const TeleconsultDeviceReadiness(
              kind: TeleconsultReadinessKind.videoReady,
              cameraGranted: true,
              microphoneGranted: true,
            ),
            repository: repository,
            roomClient: _FakeRoomClient(),
          ),
        ),
        GoRoute(
          path: '/portal/messages/:id',
          builder: (context, state) =>
              Text('Thread ${state.pathParameters['id']}'),
        ),
      ],
    );

    await tester.pumpWidget(_routerApp(router));
    await tester.pumpAndSettle();

    await _tapVisible(tester, 'Secure messages');
    await tester.pumpAndSettle();

    expect(repository.messageFallbackRequests, 1);
    expect(find.text('Thread 77'), findsOneWidget);
  });

  testWidgets('appointment card gates join action to joinable TELE visits', (
    tester,
  ) async {
    var joins = 0;
    await tester.pumpWidget(
      _localized(
        AppointmentCard(
          appt: _teleAppointment,
          teleconsultState: _lobbyState(joinable: true),
          onJoinTeleconsult: (_) => joins += 1,
          onViewPrescription: (_) {},
          onReschedule: (_) {},
          onCancel: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('TELE'), findsOneWidget);
    await tester.tap(find.text('Join video consult'));
    expect(joins, 1);

    await tester.pumpWidget(
      _localized(
        AppointmentCard(
          appt: _teleAppointment,
          teleconsultState: _lobbyState(
            joinState: TeleconsultJoinState.unavailable,
            joinable: false,
          ),
          onJoinTeleconsult: (_) => joins += 1,
          onViewPrescription: (_) {},
          onReschedule: (_) {},
          onCancel: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Teleconsultation is not available yet'), findsOneWidget);
    expect(find.text('Join video consult'), findsNothing);
    expect(joins, 1);
  });
}

final _teleAppointment = AppointmentInfo(
  id: 42,
  doctorName: 'Dr. Rao',
  department: 'Cardiology',
  date: DateTime.now()
      .add(const Duration(days: 1))
      .toIso8601String()
      .split('T')
      .first,
  time: '10:30',
  status: 'scheduled',
  visitType: 'TELE',
);

TeleconsultLobbyState _lobbyState({
  TeleconsultJoinState joinState = TeleconsultJoinState.lobbyOpen,
  bool joinable = true,
  bool consentRecorded = false,
}) {
  return TeleconsultLobbyState(
    livekitEnabled: true,
    recordingEnabled: false,
    joinState: joinState,
    joinable: joinable,
    appointmentId: _teleAppointment.id,
    teleconsultationId: 909,
    status: 'waiting',
    consentRecorded: consentRecorded,
  );
}

Widget _localized(Widget child) {
  return MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: Scaffold(body: child),
  );
}

Widget _routerApp(GoRouter router) {
  return MaterialApp.router(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    routerConfig: router,
  );
}

GoRouter _teleconsultRouter({
  required _FakeTeleconsultRepository repository,
  required TeleconsultDeviceService deviceService,
  required TeleconsultRoomClient roomClient,
}) {
  return GoRouter(
    initialLocation: '/teleconsult/appointments/42/lobby',
    routes: [
      GoRoute(
        path: '/teleconsult/appointments/:appointmentId/lobby',
        builder: (context, state) => TeleconsultLobbyScreen(
          appointment: _teleAppointment,
          initialState: _lobbyState(joinable: true),
          repository: repository,
          deviceService: deviceService,
          roomClient: roomClient,
        ),
      ),
      GoRoute(
        path: '/teleconsult/appointments/:appointmentId/consult',
        builder: (context, state) {
          final args = state.extra! as TeleconsultConsultArgs;
          return TeleconsultConsultScreen(
            appointment: args.appointment,
            lobbyState: args.lobbyState,
            readiness: args.readiness,
            repository: repository,
            roomClient: roomClient,
          );
        },
      ),
    ],
  );
}

Future<void> _tapVisible(WidgetTester tester, String text) async {
  final finder = find.text(text);
  await tester.ensureVisible(finder);
  await tester.tap(finder);
}

class _FakeTeleconsultRepository extends TeleconsultRepository {
  _FakeTeleconsultRepository({
    TeleconsultLobbyState? lobbyState,
    this.threadId = 123,
  }) : lobbyState = lobbyState ?? _lobbyState();

  final TeleconsultLobbyState lobbyState;
  final int threadId;
  int consentRequests = 0;
  int tokenRequests = 0;
  int messageFallbackRequests = 0;

  @override
  Future<TeleconsultLobbyState> fetchLobbyState(int appointmentId) async {
    return lobbyState;
  }

  @override
  Future<TeleconsultLobbyState> submitConsent({
    required int teleconsultationId,
    required TeleconsultConsentPayload payload,
  }) async {
    consentRequests += 1;
    return TeleconsultLobbyState(
      livekitEnabled: true,
      recordingEnabled: false,
      joinState: TeleconsultJoinState.lobbyOpen,
      joinable: true,
      appointmentId: _teleAppointment.id,
      teleconsultationId: teleconsultationId,
      status: 'waiting',
      consentRecorded: true,
    );
  }

  @override
  Future<TeleconsultToken> requestJoinToken(int teleconsultationId) async {
    tokenRequests += 1;
    return TeleconsultToken(
      serverUrl: 'wss://livekit.example.test',
      roomName: 'test-room',
      participantToken: 'token',
      expiresAt: DateTime.now().add(const Duration(minutes: 10)),
    );
  }

  @override
  Future<int> ensureSecureMessageFallback({
    required int appointmentId,
    required String subject,
    required String body,
  }) async {
    messageFallbackRequests += 1;
    return threadId;
  }
}

class _FakeDeviceService implements TeleconsultDeviceService {
  const _FakeDeviceService(this.readiness);

  final TeleconsultDeviceReadiness readiness;

  @override
  Future<TeleconsultDeviceReadiness> checkReadiness() async => readiness;
}

class _FakeRoomClient implements TeleconsultRoomClient {
  _FakeRoomClient({FakeTeleconsultRoomSession? session})
    : session = session ?? FakeTeleconsultRoomSession();

  final FakeTeleconsultRoomSession session;
  int connectRequests = 0;

  @override
  Future<TeleconsultRoomSession> connect({
    required TeleconsultToken token,
    required bool publishVideo,
  }) async {
    connectRequests += 1;
    await session.setCameraEnabled(publishVideo);
    return session;
  }
}
