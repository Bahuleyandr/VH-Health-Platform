// lib/core/services/api_client.dart
import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
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
    final parsed = ApiResponse._parse(streamed.statusCode, body);
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
    final parsed = ApiResponse._fromHttp(response);
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

/// Parsed backend response.
///
/// The backend envelope is `{ success, data: {...} }`.
/// [data] unwraps `body['data']` automatically; [raw] holds the full decoded body.
class ApiResponse {
  final int statusCode;
  final bool isSuccess;
  final dynamic data;
  final dynamic raw;
  final String? message;

  /// Whether this response is a 401 Unauthorized (session expired).
  bool get isUnauthorized => statusCode == 401;

  const ApiResponse._({
    required this.statusCode,
    required this.isSuccess,
    this.data,
    this.raw,
    this.message,
  });

  factory ApiResponse._fromHttp(http.Response response) {
    return ApiResponse._parse(response.statusCode, response.body);
  }

  static ApiResponse _parse(int statusCode, String body) {
    final isSuccess = statusCode >= 200 && statusCode < 300;
    dynamic decoded;
    dynamic data;
    String? message;

    try {
      decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) {
        data = decoded['data'];
        message = decoded['message']?.toString();
      } else {
        data = decoded;
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('ApiClient: failed to parse response body: $e');
      }
      decoded = body;
      data = body;
    }

    return ApiResponse._(
      statusCode: statusCode,
      isSuccess: isSuccess,
      data: data,
      raw: decoded,
      message: message,
    );
  }

  /// Extract a list from [data], handling both direct lists and nested keys.
  List<dynamic> dataAsList([String? key]) {
    if (key != null && data is Map) {
      return (data[key] as List?) ?? [];
    }
    if (data is List) return data;
    return [];
  }

  /// Extract a map from [data].
  Map<String, dynamic> dataAsMap() {
    if (data is Map<String, dynamic>) return data;
    return {};
  }
}
