class ProductEntitlementKeys {
  const ProductEntitlementKeys._();

  static const clinicalEmergency = 'clinical.emergency';
  static const clinicalCore = 'clinical.core';
  static const mobilePatientPortal = 'mobile.patient_portal';
  static const mobileStaffWorkbench = 'mobile.staff_workbench';
  static const adminOperations = 'admin.operations';
  static const developerApiClients = 'developer.api_clients';
  static const commercialBillingPackages = 'commercial.billing_packages';

  static const urgentClinicalFeatures = <String>{clinicalEmergency};
}

class ProductCapability {
  final String surface;
  final String featureKey;
  final bool visible;
  final String status;

  const ProductCapability({
    required this.surface,
    required this.featureKey,
    required this.visible,
    required this.status,
  });

  factory ProductCapability.fromJson(Map<String, dynamic> json) {
    return ProductCapability(
      surface: json['surface']?.toString() ?? '',
      featureKey:
          json['featureKey']?.toString() ??
          json['feature_key']?.toString() ??
          '',
      visible: json['visible'] == true,
      status: json['status']?.toString() ?? 'unknown',
    );
  }

  bool get isUrgentClinical =>
      ProductEntitlementKeys.urgentClinicalFeatures.contains(featureKey);

  bool get isVisibleForMobile => visible || isUrgentClinical;
}

class ProductCapabilityManifest {
  final String? tenantId;
  final DateTime? generatedAt;
  final List<ProductCapability> mobile;
  final List<ProductCapability> nav;

  const ProductCapabilityManifest({
    required this.tenantId,
    required this.generatedAt,
    required this.mobile,
    required this.nav,
  });

  factory ProductCapabilityManifest.fromJson(Map<String, dynamic> json) {
    List<ProductCapability> parseList(Object? value) {
      if (value is! List) return const [];
      return value
          .whereType<Map>()
          .map(
            (entry) => ProductCapability.fromJson(
              entry.map((key, value) => MapEntry(key.toString(), value)),
            ),
          )
          .toList(growable: false);
    }

    return ProductCapabilityManifest(
      tenantId: json['tenantId']?.toString() ?? json['tenant_id']?.toString(),
      generatedAt: DateTime.tryParse(
        json['generatedAt']?.toString() ??
            json['generated_at']?.toString() ??
            '',
      ),
      mobile: parseList(json['mobile']),
      nav: parseList(json['nav']),
    );
  }

  bool canShowMobileSurface(String surface) {
    return mobile.any(
      (capability) =>
          capability.surface == surface && capability.isVisibleForMobile,
    );
  }

  bool isMobileFeatureEnabled(String featureKey) {
    return mobile.any(
      (capability) =>
          capability.featureKey == featureKey && capability.isVisibleForMobile,
    );
  }
}
