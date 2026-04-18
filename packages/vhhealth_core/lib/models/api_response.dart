import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Parsed backend response envelope.
class ApiResponse {
  final int statusCode;
  final bool isSuccess;
  final dynamic data;
  final dynamic raw;
  final String? message;

  bool get isUnauthorized => statusCode == 401;

  const ApiResponse({
    required this.statusCode,
    required this.isSuccess,
    this.data,
    this.raw,
    this.message,
  });

  factory ApiResponse.fromHttp(http.Response response) {
    return ApiResponse.parse(response.statusCode, response.body);
  }

  static ApiResponse parse(int statusCode, String body) {
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
        debugPrint('ApiResponse: failed to parse response body: $e');
      }
      decoded = body;
      data = body;
    }

    return ApiResponse(
      statusCode: statusCode,
      isSuccess: isSuccess,
      data: data,
      raw: decoded,
      message: message,
    );
  }

  List<dynamic> dataAsList([String? key]) {
    if (key != null && data is Map) {
      return (data[key] as List?) ?? [];
    }
    if (data is List) return data;
    return [];
  }

  Map<String, dynamic> dataAsMap() {
    if (data is Map<String, dynamic>) return data;
    return {};
  }
}

/// Response wrapper for cache-first reads.
class CachedApiResponse {
  final ApiResponse response;
  final bool fromCache;
  final String? staleLabel;
  final Future<ApiResponse>? onFresh;

  const CachedApiResponse({
    required this.response,
    required this.fromCache,
    required this.staleLabel,
    this.onFresh,
  });

  bool get isSuccess => response.isSuccess;
  dynamic get data => response.data;
  String? get message => response.message;
  List<dynamic> dataAsList([String? key]) => response.dataAsList(key);
  Map<String, dynamic> dataAsMap() => response.dataAsMap();
}
