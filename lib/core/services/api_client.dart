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
    Duration? timeout,
  }) =>
      VHHttpClient.get(path, queryParameters: queryParameters, timeout: timeout);

  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) =>
      VHHttpClient.post(path, body: body, timeout: timeout);

  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) =>
      VHHttpClient.put(path, body: body, timeout: timeout);

  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) =>
      VHHttpClient.patch(path, body: body, timeout: timeout);

  static Future<ApiResponse> delete(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) =>
      VHHttpClient.delete(path, body: body, timeout: timeout);

  static Future<ApiResponse> multipart(
    String path, {
    Map<String, String>? fields,
    List<http.MultipartFile>? files,
    Future<List<http.MultipartFile>> Function()? fileBuilder,
    Duration? timeout,
  }) =>
      VHHttpClient.multipart(
        path,
        fields: fields,
        files: files,
        fileBuilder: fileBuilder,
        timeout: timeout,
      );
}
