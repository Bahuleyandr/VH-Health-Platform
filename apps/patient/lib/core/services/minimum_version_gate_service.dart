import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/config/store_urls.dart';

class MinimumVersionGateResult {
  const MinimumVersionGateResult({
    required this.updateRequired,
    required this.currentVersionCode,
    required this.minPatientVersionCode,
    required this.storeUrl,
  });

  final bool updateRequired;
  final int currentVersionCode;
  final int minPatientVersionCode;
  final String storeUrl;
}

class MinimumVersionGateService {
  MinimumVersionGateService._();

  static const defaultTimeout = Duration(seconds: 5);

  static Future<MinimumVersionGateResult> check({
    http.Client? client,
    String? currentBuildNumber,
    TargetPlatform? platform,
    Duration timeout = defaultTimeout,
  }) async {
    final storeUrl = StoreUrls.forTargetPlatform(
      platform ?? defaultTargetPlatform,
    );
    final ownedClient = client == null ? http.Client() : null;
    final httpClient = client ?? ownedClient!;

    try {
      final currentCode = _parseNonNegativeInt(
        currentBuildNumber ?? (await PackageInfo.fromPlatform()).buildNumber,
      );
      final response = await httpClient
          .get(
            Uri.parse('${ApiConfig.baseUrl}/config'),
            headers: ApiConfig.jsonHeaders,
          )
          .timeout(timeout);

      if (response.statusCode != 200) {
        return _allow(currentCode: currentCode, storeUrl: storeUrl);
      }

      final decoded = jsonDecode(response.body);
      final payload = decoded is Map<String, dynamic>
          ? decoded
          : <String, dynamic>{};
      final data = payload['data'] is Map<String, dynamic>
          ? payload['data'] as Map<String, dynamic>
          : payload;
      final minCode = _parseConfigInt(
        data['min_patient_version_code'] ?? data['minPatientVersionCode'],
      );

      if (minCode <= 0 || currentCode >= minCode) {
        return _allow(
          currentCode: currentCode,
          minPatientVersionCode: minCode,
          storeUrl: storeUrl,
        );
      }

      return MinimumVersionGateResult(
        updateRequired: true,
        currentVersionCode: currentCode,
        minPatientVersionCode: minCode,
        storeUrl: storeUrl,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('MinimumVersionGateService: fail-open: $e');
      return _allow(storeUrl: storeUrl);
    } finally {
      ownedClient?.close();
    }
  }

  static MinimumVersionGateResult _allow({
    int currentCode = 0,
    int minPatientVersionCode = 0,
    required String storeUrl,
  }) {
    return MinimumVersionGateResult(
      updateRequired: false,
      currentVersionCode: currentCode,
      minPatientVersionCode: minPatientVersionCode,
      storeUrl: storeUrl,
    );
  }

  static int _parseConfigInt(Object? value) {
    if (value is int && value >= 0) return value;
    if (value is num && value % 1 == 0 && value >= 0) return value.toInt();
    if (value is String) return _parseNonNegativeInt(value);
    return 0;
  }

  static int _parseNonNegativeInt(String value) {
    final parsed = int.tryParse(value.trim());
    return parsed != null && parsed >= 0 ? parsed : 0;
  }
}
