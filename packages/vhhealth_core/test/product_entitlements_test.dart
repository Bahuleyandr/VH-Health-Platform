import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/entitlements/product_entitlements.dart';

void main() {
  group('ProductCapabilityManifest', () {
    test('parses mobile and navigation capability rows', () {
      final manifest = ProductCapabilityManifest.fromJson({
        'tenantId': '00000000-0000-4000-8000-000000000001',
        'generatedAt': '2026-07-08T10:00:00.000Z',
        'mobile': [
          {
            'surface': 'patient.app',
            'featureKey': ProductEntitlementKeys.mobilePatientPortal,
            'visible': true,
            'status': 'active',
          },
        ],
        'nav': [
          {
            'surface': 'admin.api_clients',
            'featureKey': ProductEntitlementKeys.developerApiClients,
            'visible': false,
            'status': 'not_entitled',
          },
        ],
      });

      expect(manifest.tenantId, '00000000-0000-4000-8000-000000000001');
      expect(manifest.mobile, hasLength(1));
      expect(manifest.nav.single.surface, 'admin.api_clients');
      expect(manifest.canShowMobileSurface('patient.app'), isTrue);
    });

    test('never hides urgent clinical mobile features', () {
      final manifest = ProductCapabilityManifest.fromJson({
        'mobile': [
          {
            'surface': 'patient.sos',
            'featureKey': ProductEntitlementKeys.clinicalEmergency,
            'visible': false,
            'status': 'not_entitled',
          },
        ],
      });

      expect(manifest.canShowMobileSurface('patient.sos'), isTrue);
      expect(
        manifest.isMobileFeatureEnabled(
          ProductEntitlementKeys.clinicalEmergency,
        ),
        isTrue,
      );
    });

    test('hides denied non-urgent mobile surfaces', () {
      final manifest = ProductCapabilityManifest.fromJson({
        'mobile': [
          {
            'surface': 'staff.app',
            'featureKey': ProductEntitlementKeys.mobileStaffWorkbench,
            'visible': false,
            'status': 'not_entitled',
          },
        ],
      });

      expect(manifest.canShowMobileSurface('staff.app'), isFalse);
      expect(
        manifest.isMobileFeatureEnabled(
          ProductEntitlementKeys.mobileStaffWorkbench,
        ),
        isFalse,
      );
    });
  });
}
