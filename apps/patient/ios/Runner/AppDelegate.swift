import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    excludePhiCachesFromBackup()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  /// PHI caches must never land in iCloud/iTunes backups. The Dart layer
  /// persists its encrypted caches under Documents/vhhealth (ApiCacheManager,
  /// api_cache) and Documents/vhhealth_cache (CacheFileUtils document cache).
  /// Create each directory if missing so the exclusion flag is set before the
  /// first write. Idempotent — safe to run on every launch, and re-running
  /// matters because a restore from an old backup can bring the tree back
  /// without the flag.
  private func excludePhiCachesFromBackup() {
    guard
      let documents = FileManager.default.urls(
        for: .documentDirectory, in: .userDomainMask
      ).first
    else { return }
    for name in ["vhhealth", "vhhealth_cache"] {
      excludeFromBackup(documents.appendingPathComponent(name, isDirectory: true))
    }
  }

  private func excludeFromBackup(_ directory: URL) {
    var url = directory
    do {
      try FileManager.default.createDirectory(
        at: url, withIntermediateDirectories: true
      )
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    } catch {
      NSLog("Backup exclusion failed for \(url.lastPathComponent): \(error)")
    }
  }
}
