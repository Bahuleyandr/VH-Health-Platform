import '../services/offline_write_containment.dart';

enum OfflineWriteStatus {
  pending('pending'),
  conflict('conflict'),
  needsReview('needs_review');

  const OfflineWriteStatus(this.value);

  final String value;

  static OfflineWriteStatus? fromValue(String? value) {
    for (final status in values) {
      if (status.value == value) return status;
    }
    return null;
  }
}

/// Typed, reader-facing representation of a v5 offline write.
///
/// [isSkipped] and its blocker fields are computed from durable rows on every
/// read. They are not persisted as another queue state.
class OfflineWriteEntry {
  const OfflineWriteEntry({
    required this.id,
    required this.endpoint,
    required this.method,
    required this.createdAt,
    required this.retryCount,
    required this.status,
    required this.classification,
    this.contextLabel,
    this.conflictReason,
    this.idempotencyKey,
    this.staffId,
    this.tenantId,
    this.encryptionVersion,
    this.reviewReasonCode,
    this.reconciliationOwnerId,
    this.handoffAttestedAt,
    this.handoffAttestedBy,
    this.isSkipped = false,
    this.blockerRowId,
    this.blockerReasonCode,
  });

  final int id;
  final String endpoint;
  final String method;
  final DateTime createdAt;
  final int retryCount;
  final String? contextLabel;
  final OfflineWriteStatus status;
  final String? conflictReason;
  final String? idempotencyKey;
  final String? staffId;
  final String? tenantId;
  final int? encryptionVersion;
  final String? reviewReasonCode;
  final String? reconciliationOwnerId;
  final DateTime? handoffAttestedAt;
  final String? handoffAttestedBy;
  final OfflineWriteClassification classification;
  final bool isSkipped;
  final int? blockerRowId;
  final String? blockerReasonCode;

  String get familyKey => classification.familyKey;
  String get partitionKey =>
      '${tenantId ?? '<unknown-tenant>'}\u0000'
      '${staffId ?? '<unknown-owner>'}\u0000'
      '$familyKey';
  bool get isHandoffAttested =>
      handoffAttestedAt != null && handoffAttestedBy != null;
  bool get isRetryExhausted =>
      reviewReasonCode == OfflineWriteReviewReason.retryExhausted.code ||
      retryCount >= 6;
  bool get canAttestHandoff =>
      status == OfflineWriteStatus.needsReview &&
      !isHandoffAttested &&
      staffId != null &&
      tenantId != null &&
      reconciliationOwnerId != null;
  bool get canRetry =>
      status == OfflineWriteStatus.conflict &&
      !isSkipped &&
      classification.isControl &&
      encryptionVersion == 1 &&
      tenantId != null &&
      staffId != null;
  bool get canDiscard => canRetry;

  OfflineWriteEntry copyWithComputedBlocker({
    required int blockerRowId,
    required String blockerReasonCode,
  }) {
    return OfflineWriteEntry(
      id: id,
      endpoint: endpoint,
      method: method,
      createdAt: createdAt,
      retryCount: retryCount,
      contextLabel: contextLabel,
      status: status,
      conflictReason: conflictReason,
      idempotencyKey: idempotencyKey,
      staffId: staffId,
      tenantId: tenantId,
      encryptionVersion: encryptionVersion,
      reviewReasonCode: reviewReasonCode,
      reconciliationOwnerId: reconciliationOwnerId,
      handoffAttestedAt: handoffAttestedAt,
      handoffAttestedBy: handoffAttestedBy,
      classification: classification,
      isSkipped: true,
      blockerRowId: blockerRowId,
      blockerReasonCode: blockerReasonCode,
    );
  }
}
