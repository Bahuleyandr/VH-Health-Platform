import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import '../config/api_config.dart';

/// Emergency contact number for the SOS feature.
/// Override at build time: `--dart-define=VH_SOS_NUMBER=+91XXXXXXXXXX`
const String kSosEmergencyNumber = String.fromEnvironment(
  'VH_SOS_NUMBER',
  defaultValue: '+919841433995',
);

/// Triggers the SOS flow: sends location to backend and opens the dialer.
///
/// Supply a [BuildContext] only if you want in-app SnackBars; pass
/// `null` when calling from a background isolate.
Future<void> triggerSOS([BuildContext? ctx]) async {
  const storage = FlutterSecureStorage();
  final phone = await storage.read(key: 'phone') ?? 'unknown';

  // ── 1. Location ──────────────────────────────────────────────────────────
  double? lat, lng;
  try {
    if (!await Geolocator.isLocationServiceEnabled()) {
      await Geolocator.openLocationSettings();
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.always || perm == LocationPermission.whileInUse) {
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
      );
      lat = pos.latitude;
      lng = pos.longitude;
    }
  } catch (e) {
    debugPrint('⚠️  Geolocator error: $e');
  }

  // ── 2. Backend POST (fire-and-forget) ────────────────────────────────────
  unawaited(ApiConfig.authenticatedHeaders().then(
    (headers) => http.post(
      Uri.parse('${ApiConfig.baseUrl}/sos/'),
      headers: headers,
      body: '{"phone":"$phone","latitude":${lat ?? "null"},"longitude":${lng ?? "null"},"emergencyType":"medical"}',
    ),
  ));

  // ── 3. Open dialer ───────────────────────────────────────────────────────
  final telUri = Uri.parse('tel:$kSosEmergencyNumber');
  if (await canLaunchUrl(telUri)) {
    await launchUrl(telUri);
  } else {
    debugPrint('⚠️  Could not launch dialer for $kSosEmergencyNumber');
    if (ctx != null && ctx.mounted) {
      ScaffoldMessenger.of(ctx).showSnackBar(
        const SnackBar(content: Text('Unable to open dialer')),
      );
    }
  }
}

/// A reusable SOS floating action button widget.
///
/// Usage:
/// ```dart
/// Scaffold(
///   floatingActionButton: SosButton(),
/// )
/// ```
class SosButton extends StatelessWidget {
  /// Optional tooltip label. Defaults to 'SOS'.
  final String tooltip;

  /// Optional hero tag. Defaults to 'sos'.
  final String heroTag;

  /// Optional callback invoked before the SOS flow runs (e.g. show a SnackBar).
  final VoidCallback? onBeforeTrigger;

  const SosButton({
    super.key,
    this.tooltip = 'SOS',
    this.heroTag = 'sos',
    this.onBeforeTrigger,
  });

  @override
  Widget build(BuildContext context) {
    return FloatingActionButton(
      heroTag: heroTag,
      tooltip: tooltip,
      backgroundColor: Colors.red,
      foregroundColor: Colors.white,
      onPressed: () async {
        onBeforeTrigger?.call();
        await triggerSOS(context);
      },
      child: const Icon(Icons.favorite),
    );
  }
}
