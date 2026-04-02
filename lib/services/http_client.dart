import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/api_response.dart';

/// Production-grade HTTP client for all VHHealth backend API calls.
///
/// Features:
/// - Automatic JWT auth header injection
/// - Configurable timeouts (15s default, 30s uploads)
/// - JSON response parsing via [ApiResponse]
/// - 401 session-expiry detection with callback
/// - Multipart file upload support
/// - Query parameter support
class VHHttpClient {
  VHHttpClient._();

  static const Duration _defaultTimeout = Duration(seconds: 15);
  static const Duration _uploadTimeout = Duration(seconds: 30);

  /// Called when the backend returns 401 (unauthorized / session expired).
  /// Set this from the app's root widget to trigger a redirect to login.
  static void Function(String? message)? onSessionExpired;

  // ── Convenience HTTP methods ──────────────────────────────────────────

  /// Authenticated GET request.
  static Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path, queryParameters);
    final headers = await _headers(auth: auth);
    final response = await http
        .get(uri, headers: headers)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated POST request with JSON body.
  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await _headers(auth: auth, json: true);
    final response = await http
        .post(uri, headers: headers, body: body != null ? jsonEncode(body) : null)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated PUT request with JSON body.
  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await _headers(auth: auth, json: true);
    final response = await http
        .put(uri, headers: headers, body: body != null ? jsonEncode(body) : null)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated PATCH request with optional JSON body.
  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await _headers(auth: auth, json: true);
    final response = await http
        .patch(uri, headers: headers, body: body != null ? jsonEncode(body) : null)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated DELETE request.
  static Future<ApiResponse> delete(
    String path, {
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await _headers(auth: auth);
    final response = await http
        .delete(uri, headers: headers)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated multipart POST (for file uploads).
  static Future<ApiResponse> multipart(
    String path, {
    Map<String, String> fields = const {},
    List<http.MultipartFile> files = const [],
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await _headers(auth: auth);
    final req = http.MultipartRequest('POST', uri)
      ..headers.addAll(headers)
      ..fields.addAll(fields)
      ..files.addAll(files);
    final streamed = await req.send().timeout(timeout ?? _uploadTimeout);
    final body = await streamed.stream.bytesToString();
    final parsed = ApiResponse.parse(streamed.statusCode, body);
    _checkUnauthorized(parsed);
    return parsed;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  static Future<Map<String, String>> _headers({bool auth = true, bool json = false}) async {
    if (auth && json) {
      return ApiConfig.authenticatedHeaders();
    } else if (auth) {
      return ApiConfig.authenticatedAuthHeaders();
    } else if (json) {
      return ApiConfig.jsonHeaders;
    }
    return ApiConfig.authHeaders;
  }

  static Uri _buildUri(String path, [Map<String, String>? queryParameters]) {
    final base = Uri.parse('${ApiConfig.baseUrl}$path');
    if (queryParameters != null && queryParameters.isNotEmpty) {
      return base.replace(queryParameters: queryParameters);
    }
    return base;
  }

  /// Parse HTTP response and check for 401.
  static ApiResponse _processResponse(http.Response response) {
    final parsed = ApiResponse.fromHttp(response);
    _checkUnauthorized(parsed);
    return parsed;
  }

  /// If the response is 401, notify the app to redirect to login.
  static void _checkUnauthorized(ApiResponse response) {
    if (response.isUnauthorized) {
      if (kDebugMode) {
        debugPrint('VHHttpClient: 401 Unauthorized — session expired');
      }
      onSessionExpired?.call(response.message ?? 'Session expired. Please log in again.');
    }
  }
}
