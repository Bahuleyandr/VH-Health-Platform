enum TeleconsultJoinState {
  notYet,
  lobbyOpen,
  inProgress,
  ended,
  cancelled,
  unavailable,
  unknown,
}

TeleconsultJoinState teleconsultJoinStateFromWire(String? value) {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'not-yet':
    case 'not_yet':
      return TeleconsultJoinState.notYet;
    case 'lobby-open':
    case 'lobby_open':
    case 'waiting':
      return TeleconsultJoinState.lobbyOpen;
    case 'in-progress':
    case 'in_progress':
      return TeleconsultJoinState.inProgress;
    case 'ended':
    case 'completed':
    case 'closed':
      return TeleconsultJoinState.ended;
    case 'cancelled':
    case 'canceled':
      return TeleconsultJoinState.cancelled;
    case 'unavailable':
      return TeleconsultJoinState.unavailable;
    default:
      return TeleconsultJoinState.unknown;
  }
}

class TeleconsultLobbyState {
  const TeleconsultLobbyState({
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

  factory TeleconsultLobbyState.fromJson(Map<String, dynamic> json) {
    final rawState = json['join_state']?.toString();
    final fallbackStatus = json['status']?.toString();
    final state = teleconsultJoinStateFromWire(rawState ?? fallbackStatus);
    final livekitEnabled = json['livekit_enabled'] == true;
    return TeleconsultLobbyState(
      livekitEnabled: livekitEnabled,
      recordingEnabled: json['recording_enabled'] == true,
      joinState: livekitEnabled ? state : TeleconsultJoinState.unavailable,
      joinable:
          livekitEnabled &&
          (json['joinable'] == true ||
              state == TeleconsultJoinState.lobbyOpen ||
              state == TeleconsultJoinState.inProgress),
      appointmentId: _toInt(json['appointment_id']),
      teleconsultationId: _toInt(json['teleconsultation_id']),
      status: fallbackStatus,
      consentRecorded: json['consent_recorded'] == true,
      message: json['message']?.toString(),
    );
  }

  final bool livekitEnabled;
  final bool recordingEnabled;
  final TeleconsultJoinState joinState;
  final bool joinable;
  final int? appointmentId;
  final int? teleconsultationId;
  final String? status;
  final bool consentRecorded;
  final String? message;

  bool get canRequestConsent =>
      livekitEnabled &&
      teleconsultationId != null &&
      (joinState == TeleconsultJoinState.lobbyOpen ||
          joinState == TeleconsultJoinState.inProgress);

  bool get isTerminal =>
      joinState == TeleconsultJoinState.ended ||
      joinState == TeleconsultJoinState.cancelled;
}

class TeleconsultToken {
  const TeleconsultToken({
    required this.serverUrl,
    required this.roomName,
    required this.participantToken,
    required this.expiresAt,
  });

  factory TeleconsultToken.fromJson(Map<String, dynamic> json) {
    return TeleconsultToken(
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

class TeleconsultConsentPayload {
  const TeleconsultConsentPayload({
    required this.identityConfirmed,
    required this.remoteConsultConsent,
    required this.degradationAcknowledged,
    required this.emergencyLimitationsAcknowledged,
    required this.recordingOffAcknowledged,
  });

  final bool identityConfirmed;
  final bool remoteConsultConsent;
  final bool degradationAcknowledged;
  final bool emergencyLimitationsAcknowledged;
  final bool recordingOffAcknowledged;

  bool get isComplete =>
      identityConfirmed &&
      remoteConsultConsent &&
      degradationAcknowledged &&
      emergencyLimitationsAcknowledged &&
      recordingOffAcknowledged;

  Map<String, dynamic> toJson() {
    return {
      'identity_confirmed': identityConfirmed,
      'remote_consult_consent': remoteConsultConsent,
      'degradation_acknowledged': degradationAcknowledged,
      'emergency_limitations_acknowledged': emergencyLimitationsAcknowledged,
      'recording_off_acknowledged': recordingOffAcknowledged,
      'recording_enabled': false,
      'consent_method': 'checkbox',
      'purpose': 'Remote video/audio consultation',
      'statement':
          'Patient accepted remote consultation, degradation fallback, emergency limitations, and recording-off terms.',
    };
  }
}

int? _toInt(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  return int.tryParse(value.toString());
}
