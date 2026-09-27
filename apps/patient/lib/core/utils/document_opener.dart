import 'dart:async';

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/utils/doc_staging.dart';
import 'package:vhhealth/core/utils/document_download.dart';
import 'package:vhhealth/core/utils/safe_filename.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

class DocumentOpener {
  DocumentOpener._();

  /// Download a file from a URL and open it with the system viewer.
  /// Shows a loading dialog while downloading.
  /// Adds auth headers for backend URLs.
  /// Never delegates a document URL to an external browser on failure.
  static Future<void> openFromUrl(
    BuildContext context,
    String url, {
    String? filename,
  }) async {
    final session = CacheProfileScope.current();
    File? stagedFile;
    var opened = false;
    // Show loading dialog
    unawaited(
      showDialog(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => PopScope(
          canPop: false,
          child: Center(
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const CircularProgressIndicator(),
                    const SizedBox(height: 16),
                    Text(AppLocalizations.of(ctx)!.documentOpening),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );

    try {
      final response = await DocumentDownload.get(url);
      if (response.statusCode != 200) {
        throw HttpException('HTTP ${response.statusCode}');
      }

      // Determine file extension. `filename` is caller/server-supplied, so
      // sanitise it to a single safe segment before joining onto tempDir —
      // otherwise a `../`-laden name writes raw PHI bytes outside the temp
      // sandbox. Audit #6.
      final ext = _detectExtension(url, response.headers['content-type']);
      final resolvedFilename = safeFileName(filename, fallback: 'document');
      final safeName = resolvedFilename.contains('.')
          ? resolvedFilename
          : '$resolvedFilename$ext';

      // The OS viewer can only open a plaintext file. Write into the purgeable
      // staging dir (logout wipes it via LogoutService → DocStaging) instead of
      // leaving cleartext PHI loose in the temp root, so no decrypted document
      // survives logout on a shared/family device. `safeName` is already
      // sanitised above. Audit §3 (patient).
      stagedFile = await DocStaging.writePlaintext(
        safeName,
        response.bodyBytes,
        profile: session,
      );

      // Close loading dialog
      if (context.mounted) Navigator.of(context, rootNavigator: true).pop();

      // Open with system viewer
      final result = await OpenFilex.open(stagedFile.path);
      opened = result.type == ResultType.done;
      if (result.type != ResultType.done && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: AppLocalizations.of(context)!.documentCouldNotOpen,
          ),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('DocumentOpener error: $e');

      // Close loading dialog
      if (context.mounted) Navigator.of(context, rootNavigator: true).pop();

      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: AppLocalizations.of(context)!.documentCouldNotOpen,
          ),
        );
      }
    } finally {
      if (!opened && stagedFile != null) {
        await DocStaging.delete(stagedFile);
      }
    }
  }

  static String _detectExtension(String url, String? contentType) {
    // Try from URL path
    final uri = Uri.tryParse(url);
    if (uri != null) {
      final path = uri.path.toLowerCase();
      if (path.endsWith('.pdf')) return '.pdf';
      if (path.endsWith('.jpg')) return '.jpg';
      if (path.endsWith('.jpeg')) return '.jpeg';
      if (path.endsWith('.png')) return '.png';
    }

    // Try from Content-Type
    if (contentType != null) {
      if (contentType.contains('pdf')) return '.pdf';
      if (contentType.contains('jpeg')) return '.jpg';
      if (contentType.contains('png')) return '.png';
    }

    return '.pdf'; // Default to PDF
  }
}
