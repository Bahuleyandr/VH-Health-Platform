import 'package:flutter/foundation.dart';

class StoreUrls {
  StoreUrls._();

  static const defaultAndroidStoreUrl =
      'https://play.google.com/store/apps/details?id=com.vhhealth.patient';
  static const defaultIosStoreUrl = 'https://apps.apple.com/app/vh-health/id0';

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
}
