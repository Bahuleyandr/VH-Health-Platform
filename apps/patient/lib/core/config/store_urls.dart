import 'package:flutter/foundation.dart';

class StoreUrls {
  StoreUrls._();

  // Real Android applicationId (android/app/build.gradle.kts).
  static const defaultAndroidStoreUrl =
      'https://play.google.com/store/apps/details?id=com.vh.vhhealth';

  // No App Store listing exists yet, and the numeric Apple track id cannot be
  // derived from the bundle id — a wrong-but-plausible URL would strand a
  // hard-blocked patient on a dead listing. Empty means "not configured";
  // provision the real URL via the PATIENT_IOS_STORE_URL dart-define once the
  // listing exists. The splash update screen hides its Update CTA when the
  // resolved URL is empty.
  static const defaultIosStoreUrl = '';

  static const androidStoreUrl = String.fromEnvironment(
    'PATIENT_ANDROID_STORE_URL',
    defaultValue: defaultAndroidStoreUrl,
  );
  static const iosStoreUrl = String.fromEnvironment(
    'PATIENT_IOS_STORE_URL',
    defaultValue: defaultIosStoreUrl,
  );

  static String forTargetPlatform(TargetPlatform platform) {
    return platform == TargetPlatform.iOS ? iosStoreUrl : androidStoreUrl;
  }

  /// Whether a non-blank store URL is configured for [platform].
  static bool hasStoreUrl(TargetPlatform platform) =>
      forTargetPlatform(platform).trim().isNotEmpty;

  static bool get hasStoreUrlForCurrentPlatform =>
      hasStoreUrl(defaultTargetPlatform);
}
