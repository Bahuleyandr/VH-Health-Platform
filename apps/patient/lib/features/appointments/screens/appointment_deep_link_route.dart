import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/features/appointments/services/appointment_deep_link_loader.dart';
import 'package:vhhealth/features/teleconsult/screens/appointment_detail_screen.dart';
import 'package:vhhealth/features/teleconsult/screens/teleconsult_lobby_screen.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_device_service.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_room_client.dart';
import 'package:vhhealth/generated/app_localizations.dart';

enum AppointmentDeepLinkDestination { detail, lobby, consult }

class AppointmentDeepLinkRoute extends StatefulWidget {
  const AppointmentDeepLinkRoute({
    super.key,
    required this.appointmentId,
    required this.destination,
    this.loader = const ApiAppointmentDeepLinkLoader(),
    this.teleconsultRepository = const TeleconsultRepository(),
    this.deviceService = const PermissionHandlerTeleconsultDeviceService(),
    this.roomClient = const LiveKitTeleconsultRoomClient(),
  });

  final int appointmentId;
  final AppointmentDeepLinkDestination destination;
  final AppointmentDeepLinkLoader loader;
  final TeleconsultRepository teleconsultRepository;
  final TeleconsultDeviceService deviceService;
  final TeleconsultRoomClient roomClient;

  @override
  State<AppointmentDeepLinkRoute> createState() =>
      _AppointmentDeepLinkRouteState();
}

class _AppointmentDeepLinkRouteState extends State<AppointmentDeepLinkRoute> {
  AppointmentHydrationResult? _result;
  int _loadRevision = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant AppointmentDeepLinkRoute oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.appointmentId != widget.appointmentId ||
        oldWidget.loader != widget.loader) {
      _load();
    }
  }

  Future<void> _load() async {
    final revision = ++_loadRevision;
    setState(() => _result = null);
    AppointmentHydrationResult result;
    try {
      result = await widget.loader.load(widget.appointmentId);
    } catch (_) {
      result = const AppointmentHydrationFailed(
        AppointmentHydrationFailureKind.unavailable,
      );
    }
    if (!mounted || revision != _loadRevision) return;
    setState(() => _result = result);
  }

  @override
  Widget build(BuildContext context) {
    final result = _result;
    if (result == null) return const _AppointmentHydrationLoading();
    if (result case final AppointmentHydrationFailed failure) {
      return _AppointmentHydrationError(failure: failure, onRetry: _load);
    }

    final hydrated = result as AppointmentHydrated;
    return switch (widget.destination) {
      AppointmentDeepLinkDestination.detail => AppointmentDetailScreen(
        appointment: hydrated.appointment,
        repository: widget.teleconsultRepository,
        staleLabel: hydrated.staleLabel,
        cachedAt: hydrated.cachedAt,
      ),
      AppointmentDeepLinkDestination.lobby ||
      AppointmentDeepLinkDestination.consult => TeleconsultLobbyScreen(
        appointment: hydrated.appointment,
        repository: widget.teleconsultRepository,
        deviceService: widget.deviceService,
        roomClient: widget.roomClient,
      ),
    };
  }
}

class _AppointmentHydrationLoading extends StatelessWidget {
  const _AppointmentHydrationLoading();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}

class _AppointmentHydrationError extends StatelessWidget {
  const _AppointmentHydrationError({
    required this.failure,
    required this.onRetry,
  });

  final AppointmentHydrationFailed failure;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final message = switch (failure.kind) {
      AppointmentHydrationFailureKind.unauthenticated =>
        l.appointmentsLogOutAndBack,
      AppointmentHydrationFailureKind.offlineUnavailable =>
        l.patientOutageCacheUnavailable,
      _ => l.appointmentsLoadFailed,
    };
    return Scaffold(
      appBar: AppBar(title: Text(l.appointmentDetailTitle)),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.event_busy_outlined,
                size: 48,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 16),
              Text(message, textAlign: TextAlign.center),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_outlined),
                label: Text(l.commonRetry),
              ),
              TextButton(
                onPressed: () => context.go('/appointments'),
                child: Text(l.commonBackButton),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
