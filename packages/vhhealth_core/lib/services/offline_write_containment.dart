/// The small, always-on C0A containment classification.
///
/// This is deliberately not the future C4 action registry. Only method case is
/// normalized. Callers must supply the existing unprefixed relative path
/// exactly; malformed or decorated paths fail closed as [unknown].
enum OfflineWriteActionFamily {
  prescriptionCreate('prescription_create'),
  drugChartOrder('drug_chart_order'),
  marAdministration('mar_administration'),
  specimenCollection('specimen_collection'),
  transfusionVerification('transfusion_verification'),
  authoritativeNote('authoritative_note'),
  vitals('vitals'),
  noteDraft('note_draft'),
  unknown('unknown');

  const OfflineWriteActionFamily(this.key);

  final String key;
}

enum OfflineWriteReviewReason {
  containedPrescriptionCreate('contained_prescription_create'),
  containedDrugChartOrder('contained_drug_chart_order'),
  containedMarAdministration('contained_mar_administration'),
  containedSpecimenCollection('contained_specimen_collection'),
  containedTransfusionVerification('contained_transfusion_verification'),
  containedAuthoritativeNote('contained_authoritative_note'),
  unknownAction('unknown_action'),
  unknownTenant('unknown_tenant'),
  unknownOwner('unknown_owner'),
  unknownEncryptionVersion('unknown_encryption_version'),
  decryptFailed('decrypt_failed'),
  retryExhausted('retry_exhausted'),
  legacyClientRowRequiresReconciliation(
    'legacy_client_row_requires_reconciliation',
  );

  const OfflineWriteReviewReason(this.code);

  final String code;

  static OfflineWriteReviewReason? fromCode(String? code) {
    for (final value in values) {
      if (value.code == code) return value;
    }
    return null;
  }
}

class OfflineWriteClassification {
  const OfflineWriteClassification({
    required this.family,
    required this.method,
    required this.path,
    this.reviewReason,
    this.isContained = false,
    this.isControl = false,
  });

  final OfflineWriteActionFamily family;
  final String method;
  final String path;
  final OfflineWriteReviewReason? reviewReason;
  final bool isContained;
  final bool isControl;

  bool get isKnown => family != OfflineWriteActionFamily.unknown;
  bool get isEnqueueAllowed => isControl;
  String? get reviewReasonCode => reviewReason?.code;
  String get familyKey => family.key;
}

class OfflineWriteContainment {
  OfflineWriteContainment._();

  static final RegExp _canonicalInteger = RegExp(r'^(0|[1-9][0-9]*)$');

  static OfflineWriteClassification classify({
    required String method,
    required String path,
  }) {
    final normalizedMethod = method.toUpperCase();
    if (!_isStrictRelativePath(path)) {
      return _unknown(normalizedMethod, path);
    }

    if (normalizedMethod == 'POST' && path == '/prescriptions/create') {
      return _contained(
        OfflineWriteActionFamily.prescriptionCreate,
        normalizedMethod,
        path,
        OfflineWriteReviewReason.containedPrescriptionCreate,
      );
    }
    if (normalizedMethod == 'POST' && path == '/emr/orders') {
      return _contained(
        OfflineWriteActionFamily.drugChartOrder,
        normalizedMethod,
        path,
        OfflineWriteReviewReason.containedDrugChartOrder,
      );
    }
    if (normalizedMethod == 'POST' &&
        _matchesIntegerRoute(
          path,
          prefix: '/clinical/mar/',
          suffix: '/administer-with-scan',
        )) {
      return _contained(
        OfflineWriteActionFamily.marAdministration,
        normalizedMethod,
        path,
        OfflineWriteReviewReason.containedMarAdministration,
      );
    }
    if (normalizedMethod == 'POST' &&
        _matchesIntegerRoute(
          path,
          prefix: '/lab/samples/',
          suffix: '/collect',
        )) {
      return _contained(
        OfflineWriteActionFamily.specimenCollection,
        normalizedMethod,
        path,
        OfflineWriteReviewReason.containedSpecimenCollection,
      );
    }
    if (normalizedMethod == 'POST' &&
        _matchesIntegerRoute(
          path,
          prefix: '/blood-bank/',
          suffix: '/verify-bedside',
        )) {
      return _contained(
        OfflineWriteActionFamily.transfusionVerification,
        normalizedMethod,
        path,
        OfflineWriteReviewReason.containedTransfusionVerification,
      );
    }
    if (normalizedMethod == 'POST' && path == '/emr/notes') {
      return _contained(
        OfflineWriteActionFamily.authoritativeNote,
        normalizedMethod,
        path,
        OfflineWriteReviewReason.containedAuthoritativeNote,
      );
    }
    if (normalizedMethod == 'POST' && path == '/health/records') {
      return OfflineWriteClassification(
        family: OfflineWriteActionFamily.vitals,
        method: normalizedMethod,
        path: path,
        isControl: true,
      );
    }
    if (normalizedMethod == 'PUT' && path == '/emr/notes/draft') {
      return OfflineWriteClassification(
        family: OfflineWriteActionFamily.noteDraft,
        method: normalizedMethod,
        path: path,
        isControl: true,
      );
    }
    return _unknown(normalizedMethod, path);
  }

  /// Whether a conflict represents physical/final clinical evidence whose
  /// deletion must follow a confirmed reconciliation review.
  ///
  /// This guard intentionally has a wider route scope than enqueue
  /// containment. Every mutation under `/emr/notes` is protected, including
  /// drafts, note edits, signing, and deletion.
  static bool requiresReconciledDiscard({
    required String method,
    required String path,
  }) {
    final normalizedMethod = method.toUpperCase();
    if (!_isStrictRelativePath(path)) return false;

    final classification = classify(method: normalizedMethod, path: path);
    if (classification.isContained ||
        classification.family == OfflineWriteActionFamily.vitals) {
      return true;
    }
    return const {
          'POST',
          'PUT',
          'PATCH',
          'DELETE',
        }.contains(normalizedMethod) &&
        (path == '/emr/notes' || path.startsWith('/emr/notes/'));
  }

  static OfflineWriteClassification _contained(
    OfflineWriteActionFamily family,
    String method,
    String path,
    OfflineWriteReviewReason reason,
  ) {
    return OfflineWriteClassification(
      family: family,
      method: method,
      path: path,
      reviewReason: reason,
      isContained: true,
    );
  }

  static OfflineWriteClassification _unknown(String method, String path) {
    return OfflineWriteClassification(
      family: OfflineWriteActionFamily.unknown,
      method: method,
      path: path,
      reviewReason: OfflineWriteReviewReason.unknownAction,
    );
  }

  static bool _isStrictRelativePath(String path) {
    if (path.isEmpty ||
        !path.startsWith('/') ||
        path == '/' ||
        path.endsWith('/') ||
        path.contains('?') ||
        path.contains('#') ||
        path.contains(r'\') ||
        path.startsWith('//') ||
        path.startsWith('/api/v1/')) {
      return false;
    }
    final uri = Uri.tryParse(path);
    return uri != null &&
        !uri.hasScheme &&
        uri.host.isEmpty &&
        uri.userInfo.isEmpty &&
        uri.query.isEmpty &&
        uri.fragment.isEmpty &&
        uri.path == path;
  }

  static bool _matchesIntegerRoute(
    String path, {
    required String prefix,
    required String suffix,
  }) {
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
    final start = prefix.length;
    final end = path.length - suffix.length;
    if (end <= start) return false;
    return _canonicalInteger.hasMatch(path.substring(start, end));
  }
}
