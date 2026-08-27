import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    excludePhiCachesFromBackup()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }

  /// PHI must never land in iCloud/iTunes backups. The Dart layer saves
  /// downloaded message attachments (clinical documents) under
  /// Downloads/VH Health Staff — create it if missing so the exclusion flag
  /// is set before the first write. Voice-dictation audio lives in the temp
  /// directory, which iOS never backs up. Idempotent — safe to run on every
  /// launch, and re-running matters because a restore from an old backup can
  /// bring the tree back without the flag.
  private func excludePhiCachesFromBackup() {
    guard
      let downloads = FileManager.default.urls(
        for: .downloadsDirectory, in: .userDomainMask
      ).first
    else { return }
    excludeFromBackup(downloads.appendingPathComponent("VH Health Staff", isDirectory: true))
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
