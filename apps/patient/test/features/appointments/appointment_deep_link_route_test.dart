import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/screens/appointment_deep_link_route.dart';
import 'package:vhhealth/features/appointments/services/appointment_deep_link_loader.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/features/teleconsult/screens/teleconsult_consult_screen.dart';
import 'package:vhhealth/features/teleconsult/screens/teleconsult_lobby_screen.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('a cold consult link re-enters the lobby safety sequence', (
    tester,
  ) async {
    await tester.pumpWidget(
      _Harness(
        child: AppointmentDeepLinkRoute(
          appointmentId: 42,
          destination: AppointmentDeepLinkDestination.consult,
          loader: _Loader(
            const AppointmentHydrated(
              appointment: _teleAppointment,
              fromCache: false,
            ),
          ),
          teleconsultRepository: const _UnavailableTeleconsultRepository(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(TeleconsultLobbyScreen), findsOneWidget);
    expect(find.byType(TeleconsultConsultScreen), findsNothing);
  });

  testWidgets('a denied stable ID shows a retryable safe error', (
    tester,
  ) async {
    final loader = _Loader(
      const AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.forbidden,
      ),
    );
    await tester.pumpWidget(
      _Harness(
        child: AppointmentDeepLinkRoute(
          appointmentId: 42,
          destination: AppointmentDeepLinkDestination.detail,
          loader: loader,
        ),
      ),
    );
    await tester.pumpAndSettle();

    final l = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.text(l.appointmentsLoadFailed), findsOneWidget);
    await tester.tap(find.text(l.commonRetry));
    await tester.pumpAndSettle();
    expect(loader.calls, 2);
  });

  testWidgets('an older hydration cannot overwrite a newer route ID', (
    tester,
  ) async {
    final loader = _CompletingLoader();
    await tester.pumpWidget(
      _Harness(
        child: AppointmentDeepLinkRoute(
          appointmentId: 41,
          destination: AppointmentDeepLinkDestination.detail,
          loader: loader,
        ),
      ),
    );
    await tester.pumpWidget(
      _Harness(
        child: AppointmentDeepLinkRoute(
          appointmentId: 42,
          destination: AppointmentDeepLinkDestination.detail,
          loader: loader,
        ),
      ),
    );

    loader.complete(42, _appointment(42, 'Dr Current'));
    await tester.pump();
    expect(find.text('Dr Current'), findsOneWidget);

    loader.complete(41, _appointment(41, 'Dr Stale'));
    await tester.pump();
    expect(find.text('Dr Current'), findsOneWidget);
    expect(find.text('Dr Stale'), findsNothing);
  });

  testWidgets('an unexpected loader exception renders a safe error', (
    tester,
  ) async {
    await tester.pumpWidget(
      const _Harness(
        child: AppointmentDeepLinkRoute(
          appointmentId: 42,
          destination: AppointmentDeepLinkDestination.detail,
          loader: _ThrowingLoader(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final l = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.text(l.appointmentsLoadFailed), findsOneWidget);
  });
}

class _Harness extends StatelessWidget {
  const _Harness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    );
  }
}

class _Loader implements AppointmentDeepLinkLoader {
  _Loader(this.result);

  final AppointmentHydrationResult result;
  int calls = 0;

  @override
  Future<AppointmentHydrationResult> load(int appointmentId) async {
    calls += 1;
    return result;
  }
}

class _CompletingLoader implements AppointmentDeepLinkLoader {
  final _requests = <int, Completer<AppointmentHydrationResult>>{};

  @override
  Future<AppointmentHydrationResult> load(int appointmentId) {
    return (_requests[appointmentId] ??= Completer()).future;
  }

  void complete(int appointmentId, AppointmentInfo appointment) {
    _requests[appointmentId]!.complete(
      AppointmentHydrated(appointment: appointment, fromCache: false),
    );
  }
}

class _ThrowingLoader implements AppointmentDeepLinkLoader {
  const _ThrowingLoader();

  @override
  Future<AppointmentHydrationResult> load(int appointmentId) async =>
      throw StateError('unexpected loader failure');
}

class _UnavailableTeleconsultRepository extends TeleconsultRepository {
  const _UnavailableTeleconsultRepository();

  @override
  Future<TeleconsultLobbyState> fetchLobbyState(int appointmentId) async {
    return TeleconsultLobbyState(
      livekitEnabled: false,
      recordingEnabled: false,
      joinState: TeleconsultJoinState.unavailable,
      joinable: false,
      appointmentId: appointmentId,
    );
  }
}

const _teleAppointment = AppointmentInfo(
  id: 42,
  doctorName: 'Dr Rao',
  department: 'Cardiology',
  date: '2026-08-27',
  time: '10:30',
  status: 'confirmed',
  visitType: 'TELE',
);

AppointmentInfo _appointment(int id, String doctorName) => AppointmentInfo(
  id: id,
  doctorName: doctorName,
  department: 'General Medicine',
  date: '2026-08-27',
  time: '10:30',
  status: 'confirmed',
);
