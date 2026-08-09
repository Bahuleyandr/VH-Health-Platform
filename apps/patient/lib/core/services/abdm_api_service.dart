import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/api_client.dart';

/// Backend API calls for ABDM (Ayushman Bharat Digital Mission) features.
class AbdmApiService {
  AbdmApiService._();

  /// Register a new ABHA (Ayushman Bharat Health Account).
  /// Returns the response map which may contain abhaNumber or otpRequired flag.
  static Future<Map<String, dynamic>> registerAbha({
    required String mobile,
    required String name,
    required String yearOfBirth,
    required String gender,
    String? email,
  }) async {
    final response = await ApiClient.post(
      '/abdm/register-abha',
      body: {
        'mobile': mobile,
        'name': name,
        'yearOfBirth': yearOfBirth,
        'gender': gender,
        if (email != null && email.isNotEmpty) 'email': email,
      },
    );
    if (response.isSuccess) {
      return response.dataAsMap();
    }
    throw AbdmException(
      response.failureMessage(
        'Failed to register ABHA (${response.statusCode})',
      ),
    );
  }

  /// Verify ABHA with OTP.
  /// Returns the response map with verified ABHA details.
  static Future<Map<String, dynamic>> verifyAbha({
    required String abhaNumber,
    required String otp,
    required String mobile,
  }) async {
    final response = await ApiClient.post(
      '/abdm/verify-abha',
      body: {'abhaNumber': abhaNumber, 'otp': otp, 'mobile': mobile},
    );
    if (response.isSuccess) {
      return response.dataAsMap();
    }
    throw AbdmException(
      response.failureMessage('Failed to verify ABHA (${response.statusCode})'),
    );
  }

  /// Fetch the signed-in patient's own ABHA linkage state.
  ///
  /// Identity is derived server-side from the JWT — there is no lookup
  /// parameter — so this can never return another patient's linkage. Throws
  /// [AbdmException] on failure instead of returning null: a swallowed failure
  /// here is indistinguishable from "not linked" and would invite an
  /// already-linked patient to register a duplicate ABHA.
  static Future<AbhaLinkage> getMyAbha() async {
    final response = await ApiClient.get('/abdm/my-abha');
    if (response.isSuccess) {
      return AbhaLinkage.fromMap(response.dataAsMap());
    }
    throw AbdmException(
      response.failureMessage('Could not check your ABHA status'),
    );
  }

  /// Fetch consent requests for the current patient.
  static Future<List<dynamic>> getConsents() async {
    try {
      final response = await ApiClient.get('/abdm/consents');
      if (response.isSuccess) {
        return response.dataAsList('consents');
      }
    } catch (e) {
      if (kDebugMode) debugPrint('ABDM getConsents error: $e');
    }
    return [];
  }

  /// Grant a consent request.
  static Future<void> grantConsent(String id) async {
    final response = await ApiClient.post('/abdm/consents/$id/grant');
    if (!response.isSuccess) {
      throw AbdmException(response.failureMessage('Failed to grant consent'));
    }
  }

  /// Deny a consent request.
  static Future<void> denyConsent(String id) async {
    final response = await ApiClient.post('/abdm/consents/$id/deny');
    if (!response.isSuccess) {
      throw AbdmException(response.failureMessage('Failed to deny consent'));
    }
  }

  /// Revoke a previously granted consent.
  static Future<void> revokeConsent(String id) async {
    final response = await ApiClient.post('/abdm/consents/$id/revoke');
    if (!response.isSuccess) {
      throw AbdmException(response.failureMessage('Failed to revoke consent'));
    }
  }
}

/// The signed-in patient's ABHA linkage state, from `GET /abdm/my-abha`.
///
/// [linked] is the backend's own verdict rather than something inferred from
/// the number being non-null — a patient may be linked by ABHA address alone.
class AbhaLinkage {
  const AbhaLinkage({required this.linked, this.abhaNumber, this.abhaAddress});

  final bool linked;
  final String? abhaNumber;
  final String? abhaAddress;

  factory AbhaLinkage.fromMap(Map<String, dynamic> map) {
    String? clean(Object? value) {
      final text = (value as String?)?.trim();
      return (text == null || text.isEmpty) ? null : text;
    }

    return AbhaLinkage(
      linked: map['linked'] == true,
      abhaNumber: clean(map['abhaNumber']),
      abhaAddress: clean(map['abhaAddress']),
    );
  }
}

/// Exception thrown when an ABDM operation fails.
class AbdmException implements Exception {
  final String message;
  const AbdmException(this.message);
  @override
  String toString() => message;
}
