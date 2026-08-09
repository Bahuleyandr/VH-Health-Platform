import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/api_client.dart';

/// Backend API calls for ABDM (Ayushman Bharat Digital Mission) features.
class AbdmApiService {
  AbdmApiService._();

  /// Link the patient's EXISTING ABHA to their VH Health account.
  ///
  /// This does not create an ABHA. The backend has no enrolment path — the
  /// ABDM gateway client exposes only `verifyABHA`, and `POST /abdm/register-abha`
  /// is an UPDATE of the caller's `abha_number`/`abha_address` columns. Patients
  /// without an ABHA create one on the official ABDM portal first.
  ///
  /// `patient_uid` is deliberately omitted: the backend defaults the target to
  /// the caller's own JWT uid, and sending someone else's is refused anyway.
  static Future<void> linkAbha({
    required String abhaNumber,
    String? abhaAddress,
  }) async {
    final response = await ApiClient.post(
      '/abdm/register-abha',
      body: {
        'abha_number': abhaNumber,
        if (abhaAddress != null && abhaAddress.isNotEmpty)
          'abha_address': abhaAddress,
      },
    );
    if (!response.isSuccess) {
      throw AbdmException(response.failureMessage('Could not link your ABHA'));
    }
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
      if (value == null) return null;
      if (value is! String) {
        throw const FormatException('Invalid ABHA linkage response');
      }
      final text = value.trim();
      return text.isEmpty ? null : text;
    }

    final linked = map['linked'];
    if (linked is! bool) {
      throw const FormatException('Invalid ABHA linkage response');
    }

    final abhaNumber = clean(map['abhaNumber']);
    final abhaAddress = clean(map['abhaAddress']);
    if (linked != (abhaNumber != null || abhaAddress != null)) {
      throw const FormatException('Invalid ABHA linkage response');
    }

    return AbhaLinkage(
      linked: linked,
      abhaNumber: abhaNumber,
      abhaAddress: abhaAddress,
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
