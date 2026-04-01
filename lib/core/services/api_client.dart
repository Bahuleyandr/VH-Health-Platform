// lib/core/services/api_client.dart
import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/services/connectivity_service.dart';

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
    final headers = await ApiConfig.authenticatedAuthHeaders();
    final response = await http
        .get(uri, headers: headers)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Cache-first GET: returns cached data immediately (if available),
  /// then fetches from network in background and updates the cache.
  ///
  /// Returns a [CachedApiResponse] that includes the data, whether it came
  /// from cache, and an optional [onFresh] callback stream for when the
  /// network response arrives.
  ///
  /// Usage:
  /// ```dart
  /// final result = await ApiClient.cachedGet('/prescriptions/patient/my');
  /// setState(() => _items = result.dataAsList());
  /// // Optionally listen for fresh data:
  /// result.onFresh?.then((fresh) {
  ///   if (mounted) setState(() => _items = fresh.dataAsList());
  /// });
  /// ```
  static Future<CachedApiResponse> cachedGet(
    String path, {
    Map<String, String>? queryParameters,
    Duration? timeout,
    Duration cacheTtl = ApiCacheManager.defaultTtl,
  }) async {
    final cacheKey = queryParameters != null && queryParameters.isNotEmpty
        ? '${path}_${queryParameters.entries.map((e) => '${e.key}=${e.value}').join('_')}'
        : path;

    // 1. Try loading from cache
    final cached = await ApiCacheManager.load(cacheKey);

    // 2. If offline, return cache (or empty)
    if (!ConnectivityService.isOnline) {
      if (cached != null) {
        return CachedApiResponse._(
          response: ApiResponse._(
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
      return CachedApiResponse._(
        response: ApiResponse._(
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

    // 3. If cache is fresh enough, return it and refresh in background
    if (cached != null && !cached.isStale(cacheTtl)) {
      // Fire background refresh (don't await)
      final freshFuture = get(path, queryParameters: queryParameters, timeout: timeout)
          .then((response) {
        if (response.isSuccess) {
          ApiCacheManager.save(cacheKey, response.data);
        }
        return response;
      }).catchError((_) => ApiResponse._(
            statusCode: 0,
            isSuccess: false,
            data: cached.data,
            raw: null,
            message: 'Background refresh failed',
          ));

      return CachedApiResponse._(
        response: ApiResponse._(
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

    // 4. Cache is stale or missing — fetch from network
    try {
      final response = await get(path, queryParameters: queryParameters, timeout: timeout);
      if (response.isSuccess) {
        await ApiCacheManager.save(cacheKey, response.data);
      }
      return CachedApiResponse._(
        response: response,
        fromCache: false,
        staleLabel: null,
      );
    } catch (e) {
      // Network failed — fall back to stale cache if available
      if (cached != null) {
        return CachedApiResponse._(
          response: ApiResponse._(
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
    final headers = await ApiConfig.authenticatedAuthHeaders();
    final response = await http
        .post(uri, headers: headers, body: body != null ? jsonEncode(body) : null)
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
    final headers = await ApiConfig.authenticatedAuthHeaders();
    final response = await http
        .put(uri, headers: headers, body: body != null ? jsonEncode(body) : null)
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
    final headers = await ApiConfig.authenticatedAuthHeaders();
    final response = await http
        .patch(uri, headers: headers, body: body != null ? jsonEncode(body) : null)
        .timeout(timeout ?? _defaultTimeout);
    return _processResponse(response);
  }

  /// Authenticated DELETE request.
  static Future<ApiResponse> delete(
    String path, {
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await ApiConfig.authenticatedAuthHeaders();
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
    final headers = await ApiConfig.authenticatedAuthHeaders();
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
      // Clear stored JWT so stale tokens aren't reused
      const FlutterSecureStorage().delete(key: 'jwt');
      // Notify the app to redirect to login
      onSessionExpired?.call(response.message ?? 'Session expired. Please log in again.');
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
    if (key != null) {
      // Key specified: only look up in a Map; return [] for any other type.
      if (data is Map) return (data[key] as List?) ?? [];
      return [];
    }
    if (data is List) return data as List<dynamic>;
    return [];
  }

  /// Extract a map from [data].
  Map<String, dynamic> dataAsMap() {
    if (data is Map<String, dynamic>) return data;
    return {};
  }
}

/// Response from [ApiClient.cachedGet] that includes cache metadata.
class CachedApiResponse {
  /// The API response (from cache or network).
  final ApiResponse response;

  /// Whether this data was served from local cache.
  final bool fromCache;

  /// Human-readable age label if serving stale cached data (e.g., "5 min ago").
  /// Null if data is fresh.
  final String? staleLabel;

  /// Future that resolves with fresh network data (when cache was served first).
  /// Null if data came directly from the network.
  final Future<ApiResponse>? onFresh;

  const CachedApiResponse._({
    required this.response,
    required this.fromCache,
    required this.staleLabel,
    this.onFresh,
  });

  // Delegate common accessors to the inner response
  bool get isSuccess => response.isSuccess;
  dynamic get data => response.data;
  String? get message => response.message;
  List<dynamic> dataAsList([String? key]) => response.dataAsList(key);
  Map<String, dynamic> dataAsMap() => response.dataAsMap();
}
