enum StaffTeleconsultJoinState {
  notYet,
  lobbyOpen,
  inProgress,
  ended,
  cancelled,
  unavailable,
  unknown,
}

StaffTeleconsultJoinState staffTeleconsultJoinStateFromWire(String? value) {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'not-yet':
    case 'not_yet':
      return StaffTeleconsultJoinState.notYet;
    case 'lobby-open':
    case 'lobby_open':
    case 'waiting':
      return StaffTeleconsultJoinState.lobbyOpen;
    case 'in-progress':
    case 'in_progress':
      return StaffTeleconsultJoinState.inProgress;
    case 'ended':
    case 'completed':
    case 'closed':
      return StaffTeleconsultJoinState.ended;
    case 'cancelled':
    case 'canceled':
      return StaffTeleconsultJoinState.cancelled;
    case 'unavailable':
      return StaffTeleconsultJoinState.unavailable;
    default:
      return StaffTeleconsultJoinState.unknown;
  }
}

class StaffTeleconsultLobbyState {
  const StaffTeleconsultLobbyState({
    required this.livekitEnabled,
    required this.recordingEnabled,
    required this.joinState,
    required this.joinable,
    this.appointmentId,
    this.teleconsultationId,
    this.status,
    this.consentRecorded = false,
    this.message,
  });

  factory StaffTeleconsultLobbyState.fromJson(Map<String, dynamic> json) {
    final rawState = json['teleconsult_join_state'] ?? json['join_state'];
    final rawStatus = json['teleconsult_status'] ?? json['status'];
    final state = staffTeleconsultJoinStateFromWire(
      rawState?.toString() ?? rawStatus?.toString(),
    );
    final livekitEnabled =
        json['teleconsult_livekit_enabled'] == true ||
        json['livekit_enabled'] == true;
    return StaffTeleconsultLobbyState(
      livekitEnabled: livekitEnabled,
      recordingEnabled:
          json['teleconsult_recording_enabled'] == true ||
          json['recording_enabled'] == true,
      joinState: livekitEnabled ? state : StaffTeleconsultJoinState.unavailable,
      joinable:
          livekitEnabled &&
          (json['teleconsult_joinable'] == true ||
              json['joinable'] == true ||
              state == StaffTeleconsultJoinState.lobbyOpen ||
              state == StaffTeleconsultJoinState.inProgress),
      appointmentId: _toInt(json['appointment_id']),
      teleconsultationId: _toInt(
        json['teleconsultation_id'] ?? json['teleconsultationId'],
      ),
      status: rawStatus?.toString(),
      consentRecorded:
          json['teleconsult_consent_recorded'] == true ||
          json['consent_recorded'] == true,
      message: json['message']?.toString(),
    );
  }

  final bool livekitEnabled;
  final bool recordingEnabled;
  final StaffTeleconsultJoinState joinState;
  final bool joinable;
  final int? appointmentId;
  final int? teleconsultationId;
  final String? status;
  final bool consentRecorded;
  final String? message;

  bool get isTerminal =>
      joinState == StaffTeleconsultJoinState.ended ||
      joinState == StaffTeleconsultJoinState.cancelled;
}

class StaffTeleconsultToken {
  const StaffTeleconsultToken({
    required this.serverUrl,
    required this.roomName,
    required this.participantToken,
    required this.expiresAt,
  });

  factory StaffTeleconsultToken.fromJson(Map<String, dynamic> json) {
    return StaffTeleconsultToken(
      serverUrl: json['server_url']?.toString() ?? '',
      roomName: json['room_name']?.toString() ?? '',
      participantToken: json['participant_token']?.toString() ?? '',
      expiresAt:
          DateTime.tryParse(json['expires_at']?.toString() ?? '') ??
          DateTime.now(),
    );
  }

  final String serverUrl;
  final String roomName;
  final String participantToken;
  final DateTime expiresAt;
}

int? _toInt(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  return int.tryParse(value.toString());
}
