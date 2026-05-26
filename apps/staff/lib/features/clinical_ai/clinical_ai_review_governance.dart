enum ClinicalAiReviewGovernanceBadgeKind {
  ai,
  fallback,
  blocked,
  schemaUnavailable,
  deepTier,
}

class ClinicalAiReviewGovernanceBadge {
  const ClinicalAiReviewGovernanceBadge(this.kind);

  final ClinicalAiReviewGovernanceBadgeKind kind;
}

class ClinicalAiReviewGovernance {
  const ClinicalAiReviewGovernance({
    required this.usedAi,
    required this.generationMode,
    required this.providerStatus,
    required this.tier,
    required this.modelTier,
    required this.fallbackReason,
    required this.readinessReason,
    required this.badges,
  });

  final bool usedAi;
  final String generationMode;
  final String providerStatus;
  final String tier;
  final String modelTier;
  final String? fallbackReason;
  final String? readinessReason;
  final List<ClinicalAiReviewGovernanceBadge> badges;

  bool get blocksSignoff => badges.any(
    (badge) =>
        badge.kind == ClinicalAiReviewGovernanceBadgeKind.blocked ||
        badge.kind == ClinicalAiReviewGovernanceBadgeKind.schemaUnavailable,
  );

  String? get reason => fallbackReason ?? readinessReason;
}

ClinicalAiReviewGovernance clinicalAiReviewGovernanceFor(
  Map<String, dynamic> review,
) {
  final metadata = _asMap(review['metadata']);
  final usedAi = _boolish(review['used_ai'] ?? metadata['used_ai']);
  final generationMode = _clean(
    review['generation_mode'] ??
        metadata['generation_mode'] ??
        (usedAi ? 'ai' : 'template_fallback'),
  );
  final providerStatus = _clean(
    review['provider_status'] ??
        metadata['provider_status'] ??
        (usedAi ? 'used' : generationMode),
  );
  final tier = _clean(
    review['tier'] ?? metadata['tier'] ?? metadata['model_tier'] ?? 'quick',
  );
  final modelTier = _clean(
    review['model_tier'] ?? metadata['model_tier'] ?? tier,
  );
  final generationStatus = _clean(
    review['generation_status'] ?? review['status'] ?? metadata['status'],
  );
  final fallbackReason = _nullableClean(
    review['fallback_reason'] ?? metadata['fallback_reason'],
  );
  final readinessReason = _nullableClean(
    review['readiness_reason'] ?? metadata['readiness_reason'],
  );

  final schemaUnavailable = _matchesAny(
    [
      generationMode,
      providerStatus,
      generationStatus,
      fallbackReason,
      readinessReason,
    ],
    ['schema_unavailable', 'schema unavailable'],
  );
  final blocked =
      !schemaUnavailable &&
      _matchesAny(
        [generationMode, providerStatus, generationStatus, readinessReason],
        ['blocked'],
      );
  final fallback =
      !blocked &&
      !schemaUnavailable &&
      _matchesAny(
        [generationMode, providerStatus, fallbackReason],
        ['fallback', 'error', 'not_configured'],
      );
  final deepTier = tier == 'deep' || modelTier == 'deep';

  final badges = <ClinicalAiReviewGovernanceBadge>[
    if (schemaUnavailable)
      const ClinicalAiReviewGovernanceBadge(
        ClinicalAiReviewGovernanceBadgeKind.schemaUnavailable,
      )
    else if (blocked)
      const ClinicalAiReviewGovernanceBadge(
        ClinicalAiReviewGovernanceBadgeKind.blocked,
      )
    else if (fallback || !usedAi)
      const ClinicalAiReviewGovernanceBadge(
        ClinicalAiReviewGovernanceBadgeKind.fallback,
      )
    else
      const ClinicalAiReviewGovernanceBadge(
        ClinicalAiReviewGovernanceBadgeKind.ai,
      ),
    if (deepTier)
      const ClinicalAiReviewGovernanceBadge(
        ClinicalAiReviewGovernanceBadgeKind.deepTier,
      ),
  ];

  return ClinicalAiReviewGovernance(
    usedAi: usedAi,
    generationMode: generationMode,
    providerStatus: providerStatus,
    tier: tier,
    modelTier: modelTier,
    fallbackReason: fallbackReason,
    readinessReason: readinessReason,
    badges: badges,
  );
}

String humanizeClinicalAiReason(String value) {
  return value
      .replaceAll('_', ' ')
      .split(RegExp(r'\s+'))
      .where((part) => part.isNotEmpty)
      .join(' ');
}

Map<String, dynamic> _asMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return const {};
}

String _clean(Object? value) {
  return value?.toString().trim().toLowerCase() ?? '';
}

String? _nullableClean(Object? value) {
  final cleaned = _clean(value);
  return cleaned.isEmpty ? null : cleaned;
}

bool _boolish(Object? value) {
  if (value is bool) return value;
  final cleaned = _clean(value);
  return cleaned == 'true' || cleaned == '1' || cleaned == 'yes';
}

bool _matchesAny(List<String?> values, List<String> needles) {
  return values.whereType<String>().any(
    (value) => needles.any((needle) => value.contains(needle)),
  );
}
