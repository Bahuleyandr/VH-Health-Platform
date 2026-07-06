import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_device_service.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_room_client.dart';

class TeleconsultRouteArgs {
  const TeleconsultRouteArgs({
    required this.appointment,
    this.initialState,
    this.repository,
    this.deviceService,
    this.roomClient,
  });

  final AppointmentInfo appointment;
  final TeleconsultLobbyState? initialState;
  final TeleconsultRepository? repository;
  final TeleconsultDeviceService? deviceService;
  final TeleconsultRoomClient? roomClient;
}

class TeleconsultConsultArgs extends TeleconsultRouteArgs {
  const TeleconsultConsultArgs({
    required super.appointment,
    required this.lobbyState,
    required this.readiness,
    super.repository,
    super.deviceService,
    super.roomClient,
  }) : super(initialState: lobbyState);

  final TeleconsultLobbyState lobbyState;
  final TeleconsultDeviceReadiness readiness;
}
