import 'offline_command_envelope.dart';
import '../services/offline_write_containment.dart';

enum OfflineWriteStatus {
  pending('pending'),
  inFlight('in_flight'),
  retryWait('retry_wait'),
  applied('applied'),
  superseded('superseded'),
  cancelled('cancelled'),

  /// Read-only C0A compatibility projection for a durable v6
  /// `needs_review/legacy_conflict` row.
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
    this.clientEventId,
    this.actionId,
    this.commandFingerprint,
    this.envelopeReady = false,
    this.orderingKeyDigest,
    this.sequence,
    this.predecessorClientEventId,
    this.supersessionGeneration = 0,
    this.humanReviewRequired = false,
    this.leaseId,
    this.leaseExpiresAt,
    this.nextAttemptAt,
    this.attemptCount = 0,
    this.lastAttemptAt,
    this.appliedAt,
    this.stateReasonCode,
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
  final String? clientEventId;
  final String? actionId;
  final String? commandFingerprint;
  final bool envelopeReady;
  final String? orderingKeyDigest;
  final int? sequence;
  final String? predecessorClientEventId;
  final int supersessionGeneration;
  final bool humanReviewRequired;
  final String? leaseId;
  final DateTime? leaseExpiresAt;
  final DateTime? nextAttemptAt;
  final int attemptCount;
  final DateTime? lastAttemptAt;
  final DateTime? appliedAt;
  final String? stateReasonCode;

  String get familyKey => classification.familyKey;
  String get partitionKey {
    final tenant = tenantId ?? '<unknown-tenant>';
    final owner = staffId ?? '<unknown-owner>';
    if (envelopeReady) {
      return '$tenant\u0000$owner\u0000'
          '${actionId ?? '<unknown-action>'}\u0000'
          '${orderingKeyDigest ?? '<unknown-ordering>'}';
    }
    return '$tenant\u0000$owner\u0000$familyKey';
  }

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
      clientEventId: clientEventId,
      actionId: actionId,
      commandFingerprint: commandFingerprint,
      envelopeReady: envelopeReady,
      orderingKeyDigest: orderingKeyDigest,
      sequence: sequence,
      predecessorClientEventId: predecessorClientEventId,
      supersessionGeneration: supersessionGeneration,
      humanReviewRequired: humanReviewRequired,
      leaseId: leaseId,
      leaseExpiresAt: leaseExpiresAt,
      nextAttemptAt: nextAttemptAt,
      attemptCount: attemptCount,
      lastAttemptAt: lastAttemptAt,
      appliedAt: appliedAt,
      stateReasonCode: stateReasonCode,
    );
  }

  OfflineCommandState? get durableState {
    if (status == OfflineWriteStatus.conflict) {
      return OfflineCommandState.needsReview;
    }
    return OfflineCommandState.fromValue(status.value);
  }
}
