// lib/core/utils/doc_staging.dart

import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';

/// Staging area for the brief window a decrypted PHI document must exist as a
/// plaintext file on disk so the OS viewer (`open_filex`) can read it.
///
/// At-rest copies in `vhhealth_cache` are encrypted (see [ApiCacheManager] /
/// [CacheFileUtils]). The system viewer can't read ciphertext, so the bytes are
/// decrypted into a dedicated subdirectory of the OS temp dir whenever the user
/// opens a document. Everything here is plaintext PHI and MUST be purged on
/// logout, cold start, and foreground recovery — [LogoutService] and the app
/// lifecycle call [purge].
class DocStaging {
  DocStaging._();

  /// Subdirectory name under the OS temp dir holding decrypted documents.
  static const String dirName = 'vhhealth_doc_staging';
  static int _generation = 0;
  static int _fileSequence = 0;
  static Future<void> _io = Future<void>.value();

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
  static Future<File> writePlaintext(
    String safeName,
    List<int> bytes, {
    CacheProfileScope? profile,
  }) {
    final generation = _generation;
    return _serialize(() async {
      if (generation != _generation ||
          (profile != null && !profile.isCurrent)) {
        throw StateError('Document staging session was retired');
      }
      final dir = await _dir();
      final prefix =
          '${DateTime.now().microsecondsSinceEpoch}_${_fileSequence++}';
      final file = File('${dir.path}/${prefix}_$safeName');
      await file.writeAsBytes(bytes, flush: true);
      if (generation != _generation ||
          (profile != null && !profile.isCurrent)) {
        if (await file.exists()) await file.delete();
        throw StateError('Document staging session was retired');
      }
      return file;
    });
  }

  /// Delete one staged file after a viewer-open failure. The resolved-path
  /// containment check prevents a caller from turning cleanup into an
  /// arbitrary-file delete.
  static Future<void> delete(File file) async {
    try {
      final dir = await _dir();
      if (!await file.exists()) return;
      var root = '${await dir.resolveSymbolicLinks()}${Platform.pathSeparator}';
      var path = await file.resolveSymbolicLinks();
      if (Platform.isWindows) {
        root = root.toLowerCase();
        path = path.toLowerCase();
      }
      if (!path.startsWith(root)) return;
      await File(await file.resolveSymbolicLinks()).delete();
    } catch (e) {
      if (kDebugMode) debugPrint('DocStaging.delete failed: $e');
    }
  }

  /// Purge every plaintext document the app has staged.
  ///
  /// Deletes only the dedicated staging subdirectory. Wiping the entire OS temp
  /// root can corrupt unrelated plugins and is not necessary for current builds.
  /// Failures are logged but never thrown — cleanup must always complete.
  static Future<void> purge() {
    _generation += 1;
    return _serialize(() async {
      try {
        final tmp = await getTemporaryDirectory();
        final staging = Directory('${tmp.path}/$dirName');
        if (await staging.exists()) {
          await staging.delete(recursive: true);
        }
      } catch (e) {
        if (kDebugMode) debugPrint('DocStaging.purge failed: $e');
      }
    });
  }

  static Future<T> _serialize<T>(Future<T> Function() operation) {
    final result = _io.then((_) => operation());
    _io = result.then<void>((_) {}, onError: (_) {});
    return result;
  }
}
