import 'package:flutter/foundation.dart';

/// Where a hard-blocked staff install is sent to fetch a current build.
///
/// Mirrors the patient app's `StoreUrls` (dart-define provisioned in #877),
/// with one deliberate difference: the staff app does not ship through public
/// app stores. Android builds are distributed via Firebase App Distribution
/// (staging) and signed GitHub Releases on `staff-v*` tags; Windows desktop
/// builds attach their MSIX to the same GitHub Release. So the "store URL"
/// here is a release link, not a store listing.
class ReleaseUrls {
  ReleaseUrls._();

  // The public GitHub Releases page for this monorepo — where every signed
  // `staff-v*` APK/AAB/MSIX artifact is published. Deployments that
  // distribute through Firebase App Distribution instead should stamp the
  // tester invite link via the STAFF_ANDROID_RELEASE_URL dart-define.
  static const defaultAndroidReleaseUrl =
      'https://github.com/Bahuleyandr/VH-Health-Platform/releases';

  // No iOS distribution channel exists for the staff app. Empty means "not
  // configured"; a wrong-but-plausible URL would strand a hard-blocked staff
  // member on a dead page, so the update screen hides its CTA when the
  // resolved URL is empty (same contract as the patient app's iOS default).
  static const defaultIosReleaseUrl = '';

  static const androidReleaseUrl = String.fromEnvironment(
    'STAFF_ANDROID_RELEASE_URL',
    defaultValue: defaultAndroidReleaseUrl,
  );
  static const iosReleaseUrl = String.fromEnvironment(
    'STAFF_IOS_RELEASE_URL',
    defaultValue: defaultIosReleaseUrl,
  );

  /// iOS resolves its own (unconfigured-by-default) link; every other
  /// platform — Android, and the Windows/Linux desktop builds whose MSIX
  /// artifacts land on the same GitHub Release — resolves the release link.
  static String forTargetPlatform(TargetPlatform platform) {
    return platform == TargetPlatform.iOS ? iosReleaseUrl : androidReleaseUrl;
  }

  /// Whether a non-blank release URL is configured for [platform].
  static bool hasReleaseUrl(TargetPlatform platform) =>
      forTargetPlatform(platform).trim().isNotEmpty;

  static bool get hasReleaseUrlForCurrentPlatform =>
      hasReleaseUrl(defaultTargetPlatform);
}
