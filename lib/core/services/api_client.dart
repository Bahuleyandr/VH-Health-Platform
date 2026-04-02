// lib/core/services/api_client.dart
import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_staff/core/config/api_config.dart';

/// Centralized HTTP client for all backend API calls.
///
/// Provides authenticated requests with consistent timeout, response parsing,
/// 401 session-expiry detection, and error handling so individual screens
/// don't have to repeat this logic.
class ApiClient {
  ApiClient._();

  static const Duration _defaultTimeout = Duration(seconds: 15);
  static const Duration _uploadTimeout = Duration(seconds: 30);

  /// Listener called when the backend returns 401 (unauthorized).
  /// Set this from the app's root widget to trigger a redirect to login.
  /// The callback receives an optional error message from the backend.
  static void Function(String? message)? onSessionExpired;

  // ── Convenience HTTP methods ───────────────────────────────────────────────

  /// Authenticated GET request. Returns parsed response body.
  static Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path, queryParameters);
    final headers = await ApiConfig.authenticatedHeaders();
    final response = await http
        .get(uri, headers: headers)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated POST request with JSON body.
  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await ApiConfig.authenticatedHeaders();
    final response = await http
        .post(uri,
            headers: headers, body: body != null ? jsonEncode(body) : null)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated PUT request with JSON body.
  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await ApiConfig.authenticatedHeaders();
    final response = await http
        .put(uri,
            headers: headers, body: body != null ? jsonEncode(body) : null)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated PATCH request with optional JSON body.
  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await ApiConfig.authenticatedHeaders();
    final response = await http
        .patch(uri,
            headers: headers, body: body != null ? jsonEncode(body) : null)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated DELETE request.
  static Future<ApiResponse> delete(
    String path, {
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await ApiConfig.authenticatedHeaders();
    final response = await http
        .delete(uri, headers: headers)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated multipart POST (for file uploads).
  /// Returns [ApiResponse] after streaming the request.
  static Future<ApiResponse> multipart(
    String path, {
    Map<String, String> fields = const {},
    List<http.MultipartFile> files = const [],
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await ApiConfig.authenticatedHeaders();
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  static Uri _buildUri(String path, [Map<String, String>? queryParameters]) {
    final base = Uri.parse('${ApiConfig.baseUrl}$path');
    if (queryParameters != null && queryParameters.isNotEmpty) {
      return base.replace(queryParameters: queryParameters);
    }
    return base;
  }

  /// Process an HTTP response: parse JSON and check for 401.
  static ApiResponse _processResponse(http.Response response) {
    final parsed = ApiResponse.fromHttp(response);
    _checkUnauthorized(parsed);
    return parsed;
  }

  /// If the response is 401, clear local tokens and notify the app to redirect.
  static void _checkUnauthorized(ApiResponse response) {
    if (response.statusCode == 401) {
      if (kDebugMode) {
        debugPrint('ApiClient: 401 Unauthorized — session expired');
      }
      // Clear stored staff JWT so stale tokens aren't reused
      const FlutterSecureStorage().delete(key: 'staff_jwt');
      // Notify the app to redirect to login
      onSessionExpired
          ?.call(response.message ?? 'Session expired. Please log in again.');
    }
  }
}
