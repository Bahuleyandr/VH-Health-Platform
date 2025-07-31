import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'; // for debugPrint
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

class SOSUtils {
  /// Sends location + phone to backend **and** opens the dialer.
  static Future<void> sendSOS(String phone) async {
    const emergencyNumber = '+919841433995';
    double? lat, lng;

    /* ── 1. Get location (if allowed) ─────────────────────────────────── */
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        perm = await Geolocator.requestPermission();
      }

      if (perm == LocationPermission.always || perm == LocationPermission.whileInUse) {
        final pos = await Geolocator.getCurrentPosition(
  locationSettings: const LocationSettings(
    accuracy: LocationAccuracy.high,
    distanceFilter: 0,
  ),
);
        lat = pos.latitude;
        lng = pos.longitude;
      }
    } catch (e) {
      debugPrint('⚠️  Location fetch failed: $e');
    }

    /* ── 2. Notify backend ────────────────────────────────────────────── */
    final payload = {
      'phone': phone,
      'latitude': lat,
      'longitude': lng,
      'timestamp': DateTime.now().toIso8601String(),
    };

    try {
      await http.post(
        Uri.parse('https://vh-health-backend.onrender.com/api/v1/sos'),
        headers: {
          HttpHeaders.contentTypeHeader: 'application/json',
          'x-api-key': 'vhhealth123',
        },
        body: jsonEncode(payload),
      );
    } catch (e) {
      debugPrint('⚠️  SOS backend log failed: $e');
    }

    /* ── 3. Launch dialer ─────────────────────────────────────────────── */
    final uri = Uri.parse(
      Platform.isIOS ? 'telprompt:$emergencyNumber' : 'tel:$emergencyNumber',
    );

    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else {
      debugPrint('⚠️  Cannot launch dialer for $emergencyNumber');
    }
  }
}
