// Lightweight patient lookup helper used by the global Cmd+K picker.
//
// Backed by `GET /api/v1/patients/search?q=…&limit=20` which RBAC's
// open to clinical roles + admins. Returns a small payload (uid, name,
// phone, gender, age, abha_address) per match — enough for the picker
// row to render and route to /emr/timeline/:uid?name=… on tap. `id` is also
// returned for staff workflows that need to create orders or appointments.

import 'api_client.dart';

class PatientApiService {
  PatientApiService._();

  /// Search patients by name / phone / ABHA address. The backend
  /// silently returns an empty list for queries shorter than 2 chars
  /// (the picker debounces but may fire on the first keystroke), so
  /// callers don't need to short-circuit.
  ///
  /// Returns a list of `{ id, uid, name, phone, gender, age, abha_address }`.
  /// `age` is computed server-side from `users.birthday`.
  static Future<List<Map<String, dynamic>>> search(
    String query, {
    int limit = 20,
  }) async {
    final response = await ApiClient.get(
      '/patients/search',
      queryParameters: {'q': query, 'limit': '$limit'},
    );
    if (!response.isSuccess) {
      throw Exception(response.message ?? 'Patient search failed');
    }
    final raw = response.raw;
    if (raw is Map<String, dynamic>) {
      final data = raw['data'];
      if (data is Map<String, dynamic>) {
        final list = data['patients'];
        if (list is List) {
          return list
              .whereType<Map<String, dynamic>>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        }
      }
    }
    return const [];
  }
}
