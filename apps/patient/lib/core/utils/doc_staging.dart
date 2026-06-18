// lib/core/utils/doc_staging.dart

import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

/// Staging area for the brief window a decrypted PHI document must exist as a
/// plaintext file on disk so the OS viewer (`open_filex`) can read it.
///
/// At-rest copies in `vhhealth_cache` are encrypted (see [ApiCacheManager] /
/// [CacheFileUtils]). The system viewer can't read ciphertext, so the bytes are
/// decrypted into a dedicated subdirectory of the OS temp dir whenever the user
/// opens a document. Everything here is plaintext PHI and MUST be purged on
/// logout — [LogoutService] calls [purge], and [purge] also wipes the whole
/// temp dir (older builds wrote documents straight into it).
class DocStaging {
  DocStaging._();

  /// Subdirectory name under the OS temp dir holding decrypted documents.
  static const String dirName = 'vhhealth_doc_staging';

  static Future<Directory> _dir() async {
    final tmp = await getTemporaryDirectory();
    final dir = Directory('${tmp.path}/$dirName');
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    return dir;
  }

  /// Write [bytes] to a plaintext staging file named [safeName] and return it.
  /// [safeName] MUST already be sanitised (see `safeFileName`) — it is joined
  /// straight onto the staging dir.
  static Future<File> writePlaintext(String safeName, List<int> bytes) async {
    final dir = await _dir();
    final file = File('${dir.path}/$safeName');
    await file.writeAsBytes(bytes, flush: true);
    return file;
  }

  /// Purge every plaintext document the app has staged.
  ///
  /// Deletes the staging subdirectory AND best-effort clears the OS temp dir
  /// itself, because earlier builds (and any third-party plugin) may have
  /// dropped plaintext PHI directly into the temp root. Failures are logged but
  /// never thrown — logout must always complete.
  static Future<void> purge() async {
    try {
      final tmp = await getTemporaryDirectory();
      final staging = Directory('${tmp.path}/$dirName');
      if (await staging.exists()) {
        await staging.delete(recursive: true);
      }
      // Best-effort sweep of leftover entries in the temp root (legacy
      // straight-to-temp document writes). Delete entries individually so one
      // locked/odd entry can't abort the rest, and never delete the temp root
      // itself (the OS owns it).
      if (await tmp.exists()) {
        await for (final entity in tmp.list(followLinks: false)) {
          try {
            await entity.delete(recursive: true);
          } catch (e) {
            if (kDebugMode) debugPrint('DocStaging: skip temp entry: $e');
          }
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('DocStaging.purge failed: $e');
    }
  }
}
