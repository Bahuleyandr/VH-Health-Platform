import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/config/store_urls.dart';

void main() {
  group('StoreUrls', () {
    test('Android default carries the real applicationId com.vh.vhhealth', () {
      expect(
        StoreUrls.defaultAndroidStoreUrl,
        'https://play.google.com/store/apps/details?id=com.vh.vhhealth',
      );
    });

    test('iOS default stays unset until a real App Store listing exists', () {
      // A wrong-but-plausible URL is worse than none: SafeUrlLauncher would
      // "successfully" open a dead listing for a hard-blocked patient. The
      // PATIENT_IOS_STORE_URL dart-define provisions the real URL later.
      expect(StoreUrls.defaultIosStoreUrl, isEmpty);
    });

    test('forTargetPlatform resolves per platform', () {
      expect(
        StoreUrls.forTargetPlatform(TargetPlatform.android),
        StoreUrls.androidStoreUrl,
      );
      expect(
        StoreUrls.forTargetPlatform(TargetPlatform.iOS),
        StoreUrls.iosStoreUrl,
      );
    });

    test('hasStoreUrl reads a blank URL as not configured', () {
      // Built without dart-defines, iOS resolves to the empty default and
      // must report "no store URL" so the update screen hides its CTA...
      expect(StoreUrls.hasStoreUrl(TargetPlatform.iOS), isFalse);
      // ...while Android's real Play listing counts as configured.
      expect(StoreUrls.hasStoreUrl(TargetPlatform.android), isTrue);
    });
  });
}
