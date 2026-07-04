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

  /// Fetch patient info by ABHA number.
  static Future<Map<String, dynamic>?> getPatientByAbha(
    String abhaNumber,
  ) async {
    try {
      final response = await ApiClient.get('/abdm/patient-by-abha/$abhaNumber');
      if (response.isSuccess) {
        return response.dataAsMap();
      }
      if (response.statusCode == 404) return null;
      throw AbdmException(
        response.failureMessage('Failed to fetch ABHA patient info'),
      );
    } catch (e) {
      if (e is AbdmException) rethrow;
      if (kDebugMode) debugPrint('ABDM getPatientByAbha error: $e');
      return null;
    }
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

/// Exception thrown when an ABDM operation fails.
class AbdmException implements Exception {
  final String message;
  const AbdmException(this.message);
  @override
  String toString() => message;
}
