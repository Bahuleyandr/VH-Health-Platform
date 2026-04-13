// lib/core/services/api_client.dart
import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/connectivity_service.dart';

/// Centralized HTTP client for all backend API calls.
///
/// Provides authenticated requests with:
/// - Consistent timeout + response parsing
/// - 401 single-flight token refresh (mirrors `vhhealth_core.VHHttpClient`)
/// - Single retry on a successful refresh
/// - Session-expiry callback if refresh fails
class ApiClient {
  ApiClient._();

  static const Duration _defaultTimeout = Duration(seconds: 15);
  static const Duration _uploadTimeout = Duration(seconds: 30);
  static const _storage = FlutterSecureStorage();

  /// Listener called when the backend returns 401 (unauthorized).
  /// Set this from the app's root widget to trigger a redirect to login.
  /// The callback receives an optional error message from the backend.
  static void Function(String? message)? onSessionExpired;

  // ── Convenience HTTP methods ───────────────────────────────────────────────

  /// Authenticated GET request. Single retry on timeout; single retry after
  /// a successful token refresh when the backend returns 401.
  static Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path, queryParameters);
    final effectiveTimeout = timeout ?? _defaultTimeout;

    Future<http.Response> send() async {
      final headers = await ApiConfig.authenticatedAuthHeaders();
      return http.get(uri, headers: headers).timeout(effectiveTimeout);
    }

    http.Response response;
    try {
      response = await send();
    } on TimeoutException {
      if (kDebugMode) debugPrint('ApiClient.get: timeout on $path — retrying');
      final headers = await ApiConfig.authenticatedAuthHeaders();
      response = await http
          .get(uri, headers: headers)
          .timeout(effectiveTimeout + const Duration(seconds: 5));
    }

    final parsed = ApiResponse.fromHttp(response);
    if (parsed.statusCode == 401 && await _handleUnauthorized(parsed)) {
      final retry = await send();
      return _processResponse(retry);
    }
    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Cache-first GET: returns cached data immediately (if available),
  /// then fetches from network in background and updates the cache.
  static Future<CachedApiResponse> cachedGet(
    String path, {
    Map<String, String>? queryParameters,
    Duration? timeout,
    Duration cacheTtl = ApiCacheManager.defaultTtl,
  }) async {
    final cacheKey = queryParameters != null && queryParameters.isNotEmpty
        ? '${path}_${queryParameters.entries.map((e) => '${e.key}=${e.value}').join('_')}'
        : path;

    final cached = await ApiCacheManager.load(cacheKey);

    if (!ConnectivityService.isOnline) {
      if (cached != null) {
        return CachedApiResponse(
          response: ApiResponse(
            statusCode: 200,
            isSuccess: true,
            data: cached.data,
            raw: {'data': cached.data},
            message: null,
          ),
          fromCache: true,
          staleLabel: cached.ageLabel,
        );
      }
      return CachedApiResponse(
        response: ApiResponse(
          statusCode: 0,
          isSuccess: false,
          data: null,
          raw: null,
          message: 'No internet connection',
        ),
        fromCache: false,
        staleLabel: null,
      );
    }

    if (cached != null && !cached.isStale(cacheTtl)) {
      final freshFuture = get(path, queryParameters: queryParameters, timeout: timeout)
          .then((response) {
        if (response.isSuccess) {
          ApiCacheManager.save(cacheKey, response.data);
        }
        return response;
      }).catchError((_) => ApiResponse(
            statusCode: 0,
            isSuccess: false,
            data: cached.data,
            raw: null,
            message: 'Background refresh failed',
          ));

      return CachedApiResponse(
        response: ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: cached.data,
          raw: {'data': cached.data},
          message: null,
        ),
        fromCache: true,
        staleLabel: null,
        onFresh: freshFuture,
      );
    }

    try {
      final response = await get(path, queryParameters: queryParameters, timeout: timeout);
      if (response.isSuccess) {
        await ApiCacheManager.save(cacheKey, response.data);
      }
      return CachedApiResponse(
        response: response,
        fromCache: false,
        staleLabel: null,
      );
    } catch (e) {
      if (cached != null) {
        return CachedApiResponse(
          response: ApiResponse(
            statusCode: 200,
            isSuccess: true,
            data: cached.data,
            raw: {'data': cached.data},
            message: null,
          ),
          fromCache: true,
          staleLabel: cached.ageLabel,
        );
      }
      rethrow;
    }
  }

  /// Authenticated POST request with JSON body.
  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    Future<http.Response> send() async {
      final headers = await ApiConfig.authenticatedAuthHeaders();
      return http
          .post(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout);
    }

    final response = await send();
    final parsed = ApiResponse.fromHttp(response);
    if (parsed.statusCode == 401 && await _handleUnauthorized(parsed)) {
      final retry = await send();
      return _processResponse(retry);
    }
    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated PUT request with JSON body.
  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    Future<http.Response> send() async {
      final headers = await ApiConfig.authenticatedAuthHeaders();
      return http
          .put(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout);
    }

    final response = await send();
    final parsed = ApiResponse.fromHttp(response);
    if (parsed.statusCode == 401 && await _handleUnauthorized(parsed)) {
      final retry = await send();
      return _processResponse(retry);
    }
    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated PATCH request with optional JSON body.
  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    Future<http.Response> send() async {
      final headers = await ApiConfig.authenticatedAuthHeaders();
      return http
          .patch(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout);
    }

    final response = await send();
    final parsed = ApiResponse.fromHttp(response);
    if (parsed.statusCode == 401 && await _handleUnauthorized(parsed)) {
      final retry = await send();
      return _processResponse(retry);
    }
    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated DELETE request.
  static Future<ApiResponse> delete(
    String path, {
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    Future<http.Response> send() async {
      final headers = await ApiConfig.authenticatedAuthHeaders();
      return http.delete(uri, headers: headers).timeout(timeout ?? _defaultTimeout);
    }

    final response = await send();
    final parsed = ApiResponse.fromHttp(response);
    if (parsed.statusCode == 401 && await _handleUnauthorized(parsed)) {
      final retry = await send();
      return _processResponse(retry);
    }
    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated multipart POST (for file uploads).
  /// Multipart streams are single-use; 401 retry is not attempted here —
  /// a 401 fires [onSessionExpired] as before.
  static Future<ApiResponse> multipart(
    String path, {
    Map<String, String> fields = const {},
    List<http.MultipartFile> files = const [],
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await ApiConfig.authenticatedAuthHeaders();
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

  /// If the response is 401 without a retry opportunity (e.g. after the
  /// retry itself), clear the stored JWT and notify the app to redirect.
  static void _checkUnauthorized(ApiResponse response) {
    if (response.statusCode == 401) {
      if (kDebugMode) {
        debugPrint('ApiClient: 401 Unauthorized — session expired');
      }
      _storage.delete(key: 'jwt');
      onSessionExpired?.call(
        response.message ?? 'Session expired. Please log in again.',
      );
    }
  }

  // ── Token refresh (single-flight) ──────────────────────────────────────────

  /// Concurrent 401s share one refresh call.
  static Completer<bool>? _refreshInFlight;

  /// On 401: attempt a single-flight refresh.
  /// Returns `true` if refresh succeeded and the caller should retry the
  /// original request. Returns `false` if the session is unrecoverable —
  /// in which case tokens are cleared and [onSessionExpired] fires.
  static Future<bool> _handleUnauthorized(ApiResponse response) async {
    if (response.statusCode != 401) return false;
    final refreshed = await _tryRefreshToken();
    if (refreshed) return true;
    if (kDebugMode) {
      debugPrint('ApiClient: 401 refresh failed — clearing session');
    }
    await _storage.delete(key: 'jwt');
    onSessionExpired?.call(
      response.message ?? 'Session expired. Please log in again.',
    );
    return false;
  }

  static Future<bool> _tryRefreshToken() {
    final existing = _refreshInFlight;
    if (existing != null) return existing.future;

    final completer = Completer<bool>();
    _refreshInFlight = completer;

    _performRefresh().then((ok) {
      completer.complete(ok);
    }).catchError((Object e, StackTrace st) {
      if (kDebugMode) debugPrint('ApiClient: refresh failed — $e');
      completer.complete(false);
    }).whenComplete(() {
      _refreshInFlight = null;
    });

    return completer.future;
  }

  static Future<bool> _performRefresh() async {
    final uri = _buildUri('/auth/refresh-token');
    // Use current (possibly expired) access token as the bearer — backend
    // verifyTokenAllowExpired accepts it as long as signature is valid.
    final headers = await ApiConfig.authenticatedHeaders();
    final response =
        await http.post(uri, headers: headers).timeout(_defaultTimeout);
    final parsed = ApiResponse.fromHttp(response);
    if (!parsed.isSuccess) return false;

    final data = parsed.data;
    if (data is! Map) return false;

    final newToken = (data['accessToken'] as String?) ?? (data['token'] as String?);
    if (newToken == null || newToken.isEmpty) return false;

    await _storage.write(key: 'jwt', value: newToken);
    if (kDebugMode) debugPrint('ApiClient: token refreshed');
    return true;
  }
}
