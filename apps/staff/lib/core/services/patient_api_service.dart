// Lightweight patient lookup helper used by the global Cmd+K picker.
//
// Backed by `GET /api/v1/patients/search?q=...&limit=20` which RBAC's
// open to clinical, front-office, billing, records, and admin roles. Returns a small payload (uid, name,
// phone, hospital_number, gender, age, abha_address) per match — enough for the picker
// row to render and route to /emr/timeline/:uid?name=… on tap. `id` is also
// returned for staff workflows that need to create orders or appointments.

import 'package:http/http.dart' as http;

import 'api_client.dart';

class PatientDuplicateReviewException implements Exception {
  final String message;
  final List<Map<String, dynamic>> candidates;

  const PatientDuplicateReviewException(this.message, this.candidates);

  @override
  String toString() => message;
}

class PatientApiService {
  PatientApiService._();

  static Map<String, dynamic> _patientFromResponse(ApiResponse response) {
    if (!response.isSuccess) {
      final raw = response.raw;
      if (raw is Map<String, dynamic>) {
        final details = raw['details'];
        final candidates = details is Map ? details['candidates'] : null;
        if (response.code == 'PATIENT_DUPLICATE_REVIEW_REQUIRED' &&
            candidates is List) {
          throw PatientDuplicateReviewException(
            response.failureMessage(
              'Potential duplicate patient requires review',
            ),
            candidates
                .whereType<Map>()
                .map((e) => Map<String, dynamic>.from(e))
                .toList(growable: false),
          );
        }
      }
      throw Exception(response.failureMessage('Patient request failed'));
    }
    final raw = response.raw;
    if (raw is Map<String, dynamic>) {
      final data = raw['data'];
      if (data is Map<String, dynamic>) {
        final patient = data['patient'];
        if (patient is Map<String, dynamic>) {
          return Map<String, dynamic>.from(patient);
        }
        if (patient is Map) return Map<String, dynamic>.from(patient);
        return Map<String, dynamic>.from(data);
      }
    }
    return const {};
  }

  /// Search patients by hospital number / name / phone / ABHA address. The backend
  /// silently returns an empty list for queries shorter than 2 chars
  /// (the picker debounces but may fire on the first keystroke), so
  /// callers don't need to short-circuit.
  ///
  /// Returns a list of `{ id, uid, name, phone, hospital_number, gender, age, abha_address }`.
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
      throw Exception(response.failureMessage('Patient search failed'));
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

  static Future<Map<String, dynamic>> createPatient({
    required String name,
    required String phone,
    String? gender,
    String? birthday,
    String? address,
    String? duplicateOverrideReason,
    String? photoPath,
  }) async {
    final fields = {
      'name': name.trim(),
      'phone': phone.trim(),
      if (gender != null && gender.trim().isNotEmpty) 'gender': gender.trim(),
      if (birthday != null && birthday.trim().isNotEmpty)
        'birthday': birthday.trim(),
      if (address != null && address.trim().isNotEmpty)
        'address': address.trim(),
      if (duplicateOverrideReason != null &&
          duplicateOverrideReason.trim().isNotEmpty)
        'duplicate_override_reason': duplicateOverrideReason.trim(),
    };
    final response = photoPath == null || photoPath.trim().isEmpty
        ? await ApiClient.post('/patients', body: fields)
        : await ApiClient.multipart(
            '/patients',
            fields: fields.map((key, value) => MapEntry(key, value.toString())),
            fileBuilder: () async => <http.MultipartFile>[
              await ApiClient.multipartFileFromPath('file', photoPath),
            ],
          );
    return _patientFromResponse(response);
  }

  static Future<Map<String, dynamic>> updatePatient({
    required String uid,
    String? name,
    String? phone,
    String? gender,
    String? birthday,
    String? address,
  }) async {
    final response = await ApiClient.put(
      '/patients/$uid',
      body: {
        if (name != null) 'name': name.trim(),
        if (phone != null) 'phone': phone.trim(),
        if (gender != null) 'gender': gender.trim(),
        if (birthday != null) 'birthday': birthday.trim(),
        if (address != null) 'address': address.trim(),
      },
    );
    return _patientFromResponse(response);
  }
}
