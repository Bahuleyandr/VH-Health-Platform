import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth_core/config/api_config.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:open_filex/open_filex.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/utils/doc_staging.dart';
import 'package:vhhealth/core/utils/safe_filename.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class DocumentOpener {
  DocumentOpener._();

  /// Download a file from a URL and open it with the system viewer.
  /// Shows a loading dialog while downloading.
  /// Adds auth headers for backend URLs.
  /// Falls back to url_launcher on failure.
  static Future<void> openFromUrl(
    BuildContext context,
    String url, {
    String? filename,
  }) async {
    // Show loading dialog
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
    );

    try {
      // Download the file. Backend PHI URLs go through the SPKI-pinned client
      // (auth + 401-refresh handled there) — never a raw http.get with a
      // hand-attached bearer, which bypasses cert pinning AND the refresh flow.
      // Genuinely off-host URLs (e.g. pre-signed R2 links on a different host)
      // can't be pinned to the API host, so they keep a plain GET.
      final http.Response response;
      if (url.startsWith(ApiConfig.baseUrl)) {
        final rest = url.substring(ApiConfig.baseUrl.length);
        final qIndex = rest.indexOf('?');
        final path = qIndex == -1 ? rest : rest.substring(0, qIndex);
        final query = qIndex == -1
            ? null
            : Uri.splitQueryString(rest.substring(qIndex + 1));
        response = await VHHttpClient.getBytes(path, queryParameters: query);
      } else {
        response = await http.get(Uri.parse(url));
      }
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
      final file = await DocStaging.writePlaintext(
        safeName,
        response.bodyBytes,
      );

      // Close loading dialog
      if (context.mounted) Navigator.of(context, rootNavigator: true).pop();

      // Open with system viewer
      final result = await OpenFilex.open(file.path);
      if (result.type != ResultType.done && context.mounted) {
        // Fallback to browser
        await SafeUrlLauncher.launch(url, mode: LaunchMode.externalApplication);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('DocumentOpener error: $e');

      // Close loading dialog
      if (context.mounted) Navigator.of(context, rootNavigator: true).pop();

      // Fallback to browser
      if (context.mounted) {
        final launched = await SafeUrlLauncher.launch(
          url,
          mode: LaunchMode.externalApplication,
        );
        if (!launched && context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(AppLocalizations.of(context)!.documentCouldNotOpen),
            ),
          );
        }
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
