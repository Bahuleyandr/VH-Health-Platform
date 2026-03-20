import 'dart:async';                           // ← add for unawaited
import 'package:flutter/material.dart';        // NEW: only for SnackBar (optional)
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/config/api_config.dart';

class SOSService {
  static const String emergencyNumber = '+919841433995';



  /// Triggers the SOS flow: send location to backend and open dialer.
  /// Supply a [BuildContext] **only if** you want in-app SnackBars; pass
  /// `null` when calling from a background isolate.
  static Future<void> triggerSOS([BuildContext? ctx]) async {
    final storage = const FlutterSecureStorage();
    final phone   = await storage.read(key: 'phone') ?? 'unknown';

    /* ── 1. location ─────────────────────────────────────────────── */
    double? lat, lng;
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        await Geolocator.openLocationSettings();
      }
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      if (perm == LocationPermission.always ||
          perm == LocationPermission.whileInUse) {
        final pos = await Geolocator.getCurrentPosition(
  locationSettings: const LocationSettings(
    accuracy: LocationAccuracy.high,
  ),
);
        lat = pos.latitude;
        lng = pos.longitude;
      }
    } catch (e) {
      debugPrint('⚠️  Geolocator error: $e');
    }

    /* ── 2. backend POST (don’t block UI) ────────────────────────── */
    unawaited(http.post(
      Uri.parse('${ApiConfig.baseUrl}/sos'),
      headers: ApiConfig.jsonHeaders,
      body: '''
      {
        "phone"    : "$phone",
        "latitude" : ${lat ?? "null"},
        "longitude": ${lng ?? "null"}
      }
      ''',
    ));

    /* ── 3. launch dialer ────────────────────────────────────────── */
    final telUri = Uri.parse('tel:$emergencyNumber');
    if (await canLaunchUrl(telUri)) {
      await launchUrl(telUri);
    } else {
      debugPrint('⚠️  Could not launch dialer for $emergencyNumber');
      if (ctx != null && ctx.mounted) {
        ScaffoldMessenger.of(ctx).showSnackBar(
          const SnackBar(content: Text('Unable to open dialer')),
        );
      }
    }
  }
}
