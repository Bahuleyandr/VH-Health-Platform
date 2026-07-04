import 'package:vhhealth/core/offline/api_cache_manager.dart';

class PatientCacheInvalidation {
  const PatientCacheInvalidation._();

  static const _commandCenter = '/portal/command-center';

  static Future<void> afterAppointmentMutation() {
    return _invalidate([
      _commandCenter,
      '/appointments/uid',
      '/appointments/patient',
      '/appointments/slots',
    ]);
  }

  static Future<void> afterPharmacyOrderMutation() {
    return _invalidate([_commandCenter, '/pharmacy-orders/orders']);
  }

  static Future<void> afterRefillMutation() {
    return _invalidate([_commandCenter, '/prescriptions']);
  }

  static Future<void> afterVitalsMutation() {
    return _invalidate([_commandCenter, '/health/patient']);
  }

  static Future<void> afterProfileMutation() {
    return _invalidate([_commandCenter, '/users']);
  }

  static Future<void> afterDependentMutation() {
    return _invalidate([
      '/portal',
      '/appointments',
      '/pharmacy-orders',
      '/prescriptions',
      '/health',
      '/users',
      '/notifications',
    ], allProfiles: true);
  }

  static Future<void> _invalidate(
    List<String> prefixes, {
    bool allProfiles = false,
  }) async {
    await Future.wait(
      prefixes.map(
        (prefix) => ApiCacheManager.invalidateByPrefix(
          prefix,
          allProfiles: allProfiles,
        ),
      ),
    );
  }
}
