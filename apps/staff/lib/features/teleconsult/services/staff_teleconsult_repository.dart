import '../../../core/services/api_client.dart';
import '../models/staff_teleconsult_models.dart';

class StaffTeleconsultRepository {
  const StaffTeleconsultRepository();

  Future<StaffTeleconsultLobbyState> ensureForAppointment(
    int appointmentId,
  ) async {
    final response = await ApiClient.post(
      '/teleconsult/appointments/$appointmentId/ensure',
    );
    if (!response.isSuccess) {
      throw StaffTeleconsultRepositoryException(
        response.failureMessage('Could not provision the video consult'),
      );
    }
    final data = response.dataAsMap();
    final teleconsultation = _mapFrom(data['teleconsultation']);
    return StaffTeleconsultLobbyState.fromJson({
      ...data,
      if (teleconsultation != null) ...teleconsultation,
      'teleconsultation_id':
          data['teleconsultation_id'] ?? teleconsultation?['id'],
      'recording_enabled': false,
      'livekit_enabled': data['livekit_enabled'] ?? true,
    });
  }

  Future<StaffTeleconsultLobbyState> fetchRoomState(
    int teleconsultationId,
  ) async {
    final response = await ApiClient.get(
      '/teleconsult/$teleconsultationId/room-state',
    );
    if (!response.isSuccess) {
      throw StaffTeleconsultRepositoryException(
        response.failureMessage('Could not load the video consult'),
      );
    }
    return StaffTeleconsultLobbyState.fromJson(response.dataAsMap());
  }

  Future<StaffTeleconsultToken> requestJoinToken(int teleconsultationId) async {
    final response = await ApiClient.post(
      '/teleconsult/$teleconsultationId/token',
      body: const {'role': 'clinician'},
    );
    if (!response.isSuccess) {
      throw StaffTeleconsultRepositoryException(
        response.failureMessage('Could not join the video consult'),
      );
    }
    return StaffTeleconsultToken.fromJson(response.dataAsMap());
  }
}

class StaffTeleconsultRepositoryException implements Exception {
  const StaffTeleconsultRepositoryException(this.message);

  final String message;

  @override
  String toString() => message;
}

Map<String, dynamic>? _mapFrom(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}
