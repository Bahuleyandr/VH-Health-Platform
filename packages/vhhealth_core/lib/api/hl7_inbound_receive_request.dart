import 'generated/openapi.swagger.dart' show Hl7I03RecoveryEnvelope;

/// Typed request wrapper for the shared live/recovery HL7 receive operation.
///
/// Recovery selection is based on JSON property presence. A live request must
/// therefore omit `recovery`, not serialize it as `null`.
class Hl7InboundReceiveRequest {
  const Hl7InboundReceiveRequest({required this.message, this.recovery});

  factory Hl7InboundReceiveRequest.fromJson(Map<String, dynamic> json) =>
      Hl7InboundReceiveRequest(
        message: json['message'] as String,
        recovery: json['recovery'] == null
            ? null
            : Hl7I03RecoveryEnvelope.fromJson(
                json['recovery'] as Map<String, dynamic>,
              ),
      );

  final String message;
  final Hl7I03RecoveryEnvelope? recovery;

  static Hl7InboundReceiveRequest fromJsonFactory(Map<String, dynamic> json) =>
      Hl7InboundReceiveRequest.fromJson(json);

  static Map<String, dynamic> toJsonFactory(
    Hl7InboundReceiveRequest instance,
  ) => instance.toJson();

  Map<String, dynamic> toJson() => <String, dynamic>{
    'message': message,
    if (recovery != null) 'recovery': recovery!.toJson(),
  };
}
