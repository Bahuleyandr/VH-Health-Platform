import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class DocumentOpener {
  DocumentOpener._();

  static const _storage = FlutterSecureStorage();

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
      // Build headers — add auth for backend URLs
      final headers = <String, String>{};
      if (_isBackendUrl(url)) {
        final jwt = await _storage.read(key: 'jwt');
        if (jwt != null) {
          headers['Authorization'] = 'Bearer $jwt';
        }
      }

      // Download the file
      final response = await http.get(Uri.parse(url), headers: headers);
      if (response.statusCode != 200) {
        throw HttpException('HTTP ${response.statusCode}');
      }

      // Determine file extension
      final ext = _detectExtension(url, response.headers['content-type']);
      final resolvedFilename = filename ?? 'document';
      final safeName = resolvedFilename.contains('.')
          ? resolvedFilename
          : '$resolvedFilename$ext';

      // Write to temp directory
      final tempDir = await getTemporaryDirectory();
      final file = File('${tempDir.path}/$safeName');
      await file.writeAsBytes(response.bodyBytes);

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
            SnackBar(content: Text(AppLocalizations.of(context)!.documentCouldNotOpen)),
          );
        }
      }
    }
  }

  static bool _isBackendUrl(String url) {
    return url.contains('api.vhhealth.app');
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
