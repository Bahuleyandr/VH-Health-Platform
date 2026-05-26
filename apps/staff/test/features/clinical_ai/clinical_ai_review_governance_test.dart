import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/clinical_ai/clinical_ai_review_governance.dart';

void main() {
  group('clinicalAiReviewGovernanceFor', () {
    test('labels deep local AI as AI and deep tier', () {
      final governance = clinicalAiReviewGovernanceFor({
        'used_ai': true,
        'generation_mode': 'ai',
        'provider_status': 'used',
        'tier': 'deep',
        'model_tier': 'deep',
      });

      expect(governance.blocksSignoff, isFalse);
      expect(
        governance.badges.map((badge) => badge.kind),
        containsAllInOrder([
          ClinicalAiReviewGovernanceBadgeKind.ai,
          ClinicalAiReviewGovernanceBadgeKind.deepTier,
        ]),
      );
    });

    test('labels template fallback with its fallback reason', () {
      final governance = clinicalAiReviewGovernanceFor({
        'used_ai': false,
        'generation_mode': 'template_fallback',
        'provider_status': 'template_fallback',
        'fallback_reason': 'Clinical AI provider is template fallback',
      });

      expect(governance.blocksSignoff, isFalse);
      expect(governance.reason, 'clinical ai provider is template fallback');
      expect(
        governance.badges.map((badge) => badge.kind),
        contains(ClinicalAiReviewGovernanceBadgeKind.fallback),
      );
    });

    test('blocks signoff for provider-blocked generations', () {
      final governance = clinicalAiReviewGovernanceFor({
        'used_ai': false,
        'generation_mode': 'blocked',
        'provider_status': 'blocked',
        'readiness_reason': 'external_provider_blocked_for_region:AP',
      });

      expect(governance.blocksSignoff, isTrue);
      expect(
        governance.badges.map((badge) => badge.kind),
        contains(ClinicalAiReviewGovernanceBadgeKind.blocked),
      );
    });

    test('blocks signoff and labels schema-unavailable generations', () {
      final governance = clinicalAiReviewGovernanceFor({
        'metadata': {
          'generation_mode': 'schema_unavailable',
          'provider_status': 'schema_unavailable',
        },
      });

      expect(governance.blocksSignoff, isTrue);
      expect(
        governance.badges.map((badge) => badge.kind),
        contains(ClinicalAiReviewGovernanceBadgeKind.schemaUnavailable),
      );
    });
  });
}
