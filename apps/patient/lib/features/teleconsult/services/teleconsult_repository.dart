import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';

class TeleconsultRepository {
  const TeleconsultRepository();

  Future<TeleconsultLobbyState> fetchLobbyState(int appointmentId) async {
    final response = await ApiClient.get(
      '/portal/teleconsult/appointments/$appointmentId/lobby-state',
    );
    if (!response.isSuccess) {
      final message = response.failureMessage(
        'Teleconsultation is not available yet',
      );
      return TeleconsultLobbyState(
        livekitEnabled: false,
        recordingEnabled: false,
        joinState: TeleconsultJoinState.unavailable,
        joinable: false,
        appointmentId: appointmentId,
        message: message,
      );
    }
    return TeleconsultLobbyState.fromJson(response.dataAsMap());
  }

  Future<TeleconsultLobbyState> submitConsent({
    required int teleconsultationId,
    required TeleconsultConsentPayload payload,
  }) async {
    final response = await ApiClient.post(
      '/portal/teleconsult/teleconsultations/$teleconsultationId/consent',
      body: {'consent_payload': payload.toJson()},
    );
    if (!response.isSuccess) {
      throw TeleconsultRepositoryException(
        response.failureMessage('Could not record consent'),
      );
    }
    final data = response.dataAsMap();
    return TeleconsultLobbyState(
      livekitEnabled: true,
      recordingEnabled: false,
      joinState: TeleconsultJoinState.lobbyOpen,
      joinable: true,
      teleconsultationId: _toInt(data['id']) ?? teleconsultationId,
      appointmentId: _toInt(data['appointment_id']),
      status: data['status']?.toString(),
      consentRecorded: true,
    );
  }

  Future<TeleconsultToken> requestJoinToken(int teleconsultationId) async {
    final response = await ApiClient.post(
      '/portal/teleconsult/teleconsultations/$teleconsultationId/token',
    );
    if (!response.isSuccess) {
      throw TeleconsultRepositoryException(
        response.failureMessage('Could not join the video consult'),
      );
    }
    return TeleconsultToken.fromJson(response.dataAsMap());
  }

  Future<int> ensureSecureMessageFallback({
    required int appointmentId,
    required String subject,
    required String body,
  }) async {
    final response = await ApiClient.post(
      '/portal/messages/appointment/$appointmentId/teleconsult-fallback',
      body: {'subject': subject, 'body': body},
    );
    if (!response.isSuccess) {
      throw TeleconsultRepositoryException(
        response.failureMessage('Could not open secure messages'),
      );
    }
    final id = _toInt(response.dataAsMap()['id']);
    if (id == null) {
      throw const TeleconsultRepositoryException(
        'Secure message thread was not returned',
      );
    }
    return id;
  }
}

class TeleconsultRepositoryException implements Exception {
  const TeleconsultRepositoryException(this.message);
  final String message;

  @override
  String toString() => message;
}

int? _toInt(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  return int.tryParse(value.toString());
}
