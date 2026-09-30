import 'package:vhhealth/core/services/api_client.dart';

/// Backend API calls for ABDM (Ayushman Bharat Digital Mission) features.
class AbdmApiService {
  AbdmApiService._();

  /// Link an ABHA the patient ALREADY HOLDS to their account.
  ///
  /// `POST /abdm/register-abha` is a linkage endpoint despite its name — it
  /// binds an existing ABHA number to the patient row. It is NOT an enrolment
  /// call: creating a new ABHA is an ABDM Aadhaar/mobile-OTP flow the backend
  /// does not implement (the ABDM gateway client exposes only `verifyABHA`).
  /// This method previously posted an enrolment payload
  /// (`mobile`/`name`/`yearOfBirth`/`gender`/`email`) that the endpoint has
  /// never accepted, so every call 400'd. Patients without an ABHA create one
  /// on the official ABDM portal first.
  ///
  /// `patient_uid` is deliberately omitted: the backend defaults the target to
  /// the caller's own JWT uid, and sending someone else's is refused anyway.
  ///
  /// Returns the resulting `{linked, abhaNumber, abhaAddress}` linkage — the
  /// same shape `GET /abdm/my-abha` returns.
  static Future<Map<String, dynamic>> linkAbha({
    required String abhaNumber,
    String? abhaAddress,
  }) async {
    final address = abhaAddress?.trim();
    final response = await ApiClient.post(
      '/abdm/register-abha',
      body: {
        'abha_number': abhaNumber.trim(),
        if (address != null && address.isNotEmpty) 'abha_address': address,
      },
    );
    if (response.isSuccess) {
      return response.dataAsMap();
    }
    throw AbdmException.fromResponse(response);
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
    throw AbdmException.fromResponse(response);
  }

  /// Fetch consent requests for the current patient.
  static Future<List<dynamic>> getConsents() async {
    final response = await ApiClient.get('/abdm/consents');
    if (!response.isSuccess) {
      throw AbdmException.fromResponse(response);
    }
    final data = response.data;
    final consents = data is Map ? data['consents'] : data;
    if (consents is! List ||
        consents.any((consent) => consent is! Map<String, dynamic>)) {
      throw const FormatException('Invalid ABDM consent list response');
    }
    for (final consent in consents.cast<Map<String, dynamic>>()) {
      if ([
        'consent_id',
        'status',
        'purpose',
        'requester_name',
        'date_range_from',
        'date_range_to',
      ].any((field) => consent[field] != null && consent[field] is! String)) {
        throw const FormatException('Invalid ABDM consent list response');
      }
    }
    return consents;
  }

  /// Grant a consent request.
  static Future<void> grantConsent(String id) async {
    final response = await ApiClient.post(_consentPath(id, 'grant'));
    if (!response.isSuccess) {
      throw AbdmException.fromResponse(response);
    }
  }

  /// Deny a consent request.
  static Future<void> denyConsent(String id) async {
    final response = await ApiClient.post(_consentPath(id, 'deny'));
    if (!response.isSuccess) {
      throw AbdmException.fromResponse(response);
    }
  }

  /// Revoke a previously granted consent.
  static Future<void> revokeConsent(String id) async {
    final response = await ApiClient.post(_consentPath(id, 'revoke'));
    if (!response.isSuccess) {
      throw AbdmException.fromResponse(response);
    }
  }

  static String _consentPath(String id, String action) {
    if (id.trim().isEmpty) {
      throw ArgumentError('A consent identity is required');
    }
    return '/abdm/consents/${Uri.encodeComponent(id)}/$action';
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
  const AbdmException({this.code, this.statusCode, this.requestId});

  factory AbdmException.fromResponse(ApiResponse response) => AbdmException(
    code: response.code,
    statusCode: response.statusCode,
    requestId: response.requestId,
  );

  final String? code;
  final int? statusCode;
  final String? requestId;

  @override
  String toString() => 'ABDM request failed';
}
