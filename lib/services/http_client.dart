import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/api_response.dart';
import 'auth_service.dart';

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

  /// Authenticated GET request. Automatically retries once on 401 after
  /// refreshing the JWT token.
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
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      // Token was refreshed — retry with new headers
      final retryHeaders = await _headers(auth: true);
      final retry = await http
          .get(uri, headers: retryHeaders)
          .timeout(timeout ?? _defaultTimeout);
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated POST request with JSON body. Automatically retries once
  /// on 401 after refreshing the JWT token.
  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final headers = await _headers(auth: auth, json: true);
    final response = await http
        .post(uri, headers: headers, body: encoded)
        .timeout(timeout ?? _defaultTimeout);
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(auth: true, json: true);
      final retry = await http
          .post(uri, headers: retryHeaders, body: encoded)
          .timeout(timeout ?? _defaultTimeout);
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated PUT request with JSON body.
  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final headers = await _headers(auth: auth, json: true);
    final response = await http
        .put(uri, headers: headers, body: encoded)
        .timeout(timeout ?? _defaultTimeout);
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(auth: true, json: true);
      final retry = await http
          .put(uri, headers: retryHeaders, body: encoded)
          .timeout(timeout ?? _defaultTimeout);
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated PATCH request with optional JSON body.
  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final headers = await _headers(auth: auth, json: true);
    final response = await http
        .patch(uri, headers: headers, body: encoded)
        .timeout(timeout ?? _defaultTimeout);
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(auth: true, json: true);
      final retry = await http
          .patch(uri, headers: retryHeaders, body: encoded)
          .timeout(timeout ?? _defaultTimeout);
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
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
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(auth: true);
      final retry = await http
          .delete(uri, headers: retryHeaders)
          .timeout(timeout ?? _defaultTimeout);
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
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

  // ── Token refresh ────────────────────────────────────────────────────

  static bool _isRefreshing = false;

  /// Attempt to refresh the JWT via `/auth/refresh-token`.
  /// Returns `true` if a new token was stored, `false` otherwise.
  static Future<bool> _tryRefreshToken() async {
    if (_isRefreshing) return false;
    _isRefreshing = true;
    try {
      final uri = _buildUri('/auth/refresh-token');
      final headers = await _headers(auth: true, json: true);
      final response = await http
          .post(uri, headers: headers)
          .timeout(_defaultTimeout);
      final parsed = ApiResponse.fromHttp(response);
      if (parsed.isSuccess) {
        final data = parsed.data;
        final newToken = (data is Map)
            ? (data['token'] as String? ?? data['accessToken'] as String?)
            : null;
        if (newToken != null && newToken.isNotEmpty) {
          await AuthService.setJwt(newToken);
          if (kDebugMode) debugPrint('VHHttpClient: token refreshed');
          return true;
        }
      }
      return false;
    } catch (e) {
      if (kDebugMode) debugPrint('VHHttpClient: token refresh failed — $e');
      return false;
    } finally {
      _isRefreshing = false;
    }
  }

  /// If the response is 401, attempt a single token refresh.
  /// If refresh succeeds, the caller should retry the request.
  /// If refresh fails, notify the app to redirect to login.
  static Future<bool> _handleUnauthorized(ApiResponse response) async {
    if (!response.isUnauthorized) return false;

    final refreshed = await _tryRefreshToken();
    if (refreshed) return true; // caller should retry

    if (kDebugMode) {
      debugPrint('VHHttpClient: 401 Unauthorized — session expired');
    }
    onSessionExpired?.call(
      response.message ?? 'Session expired. Please log in again.',
    );
    return false;
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
