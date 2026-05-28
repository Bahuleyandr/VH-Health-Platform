// lib/core/services/api_client.dart
//
// Thin façade over `vhhealth_core.VHHttpClient`. All HTTP + JWT refresh + 401
// single-flight + retry logic lives in core; this file exists so existing
// call sites (`ApiClient.get('/path')`) keep compiling. When a new app-level
// HTTP concern appears, add it *here* — don't duplicate logic from core.
//
// Deprecation path: individual call sites can migrate to `VHHttpClient.xxx`
// directly over time. The façade is a compatibility layer, not a permanent
// abstraction.

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

export 'package:vhhealth_core/models/api_response.dart' show ApiResponse;

/// Staff-app HTTP client. Every method delegates to [VHHttpClient].
class ApiClient {
  ApiClient._();

  /// Registered once at startup; forwarded to [VHHttpClient.onSessionExpired]
  /// so the single refresh/relogin flow owns both app-HTTP calls and the
  /// realtime WS.
  static set onSessionExpired(void Function(String? message)? cb) {
    VHHttpClient.onSessionExpired = cb;
  }

  static Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
    bool auth = true,
    Duration? timeout,
  }) => VHHttpClient.get(
    path,
    queryParameters: queryParameters,
    auth: auth,
    timeout: timeout,
  );

  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) => VHHttpClient.post(path, body: body, auth: auth, timeout: timeout);

  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) => VHHttpClient.put(path, body: body, auth: auth, timeout: timeout);

  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) => VHHttpClient.patch(path, body: body, auth: auth, timeout: timeout);

  static Future<ApiResponse> delete(
    String path, {
    bool auth = true,
    Duration? timeout,
  }) => VHHttpClient.delete(path, auth: auth, timeout: timeout);

  static Future<ApiResponse> multipart(
    String path, {
    Map<String, String> fields = const {},
    List<http.MultipartFile> files = const [],
    Future<List<http.MultipartFile>> Function()? fileBuilder,
    bool auth = true,
    Duration? timeout,
  }) => VHHttpClient.multipart(
    path,
    fields: fields,
    files: files,
    fileBuilder: fileBuilder,
    auth: auth,
    timeout: timeout,
  );

  static Future<http.MultipartFile> multipartFileFromPath(
    String field,
    String filePath, {
    String? filename,
  }) {
    return http.MultipartFile.fromPath(
      field,
      filePath,
      filename: filename,
      contentType: _contentTypeForPath(filename ?? filePath),
    );
  }

  static MediaType _contentTypeForPath(String path) {
    final lower = path.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      return MediaType('image', 'jpeg');
    }
    if (lower.endsWith('.png')) return MediaType('image', 'png');
    if (lower.endsWith('.gif')) return MediaType('image', 'gif');
    if (lower.endsWith('.webp')) return MediaType('image', 'webp');
    if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
      return MediaType('image', 'tiff');
    }
    if (lower.endsWith('.bmp')) return MediaType('image', 'bmp');
    if (lower.endsWith('.pdf')) return MediaType('application', 'pdf');
    if (lower.endsWith('.txt')) return MediaType('text', 'plain');
    if (lower.endsWith('.csv')) return MediaType('text', 'csv');
    if (lower.endsWith('.rtf')) return MediaType('text', 'rtf');
    if (lower.endsWith('.doc')) return MediaType('application', 'msword');
    if (lower.endsWith('.docx')) {
      return MediaType(
        'application',
        'vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    }
    if (lower.endsWith('.xls')) {
      return MediaType('application', 'vnd.ms-excel');
    }
    if (lower.endsWith('.xlsx')) {
      return MediaType(
        'application',
        'vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    }
    return MediaType('application', 'octet-stream');
  }
}
