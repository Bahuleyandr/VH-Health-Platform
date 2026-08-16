import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/http_client.dart';
import '../services/secure_storage.dart';

/// Emergency contact number for the SOS feature.
/// Override at build time: `--dart-define=VH_SOS_NUMBER=+91XXXXXXXXXX`
const String kSosEmergencyNumber = String.fromEnvironment(
  'VH_SOS_NUMBER',
  defaultValue: '+919841433995',
);

/// Outcome of the backend half of an SOS trigger.
enum SosBackendOutcome {
  /// The backend accepted the alert.
  reported,

  /// The POST was attempted and failed — the caller MUST surface this.
  failed,

  /// No POST was attempted (guest / no stored phone). Not a success:
  /// callers must not claim an alert was "triggered".
  skipped,
}

/// Result of [triggerSOS]. The phone dialer is the safety net and is launched
/// regardless of the backend outcome; [backendOutcome] tells the caller
/// honestly whether the hospital was actually alerted.
class SosTriggerResult {
  const SosTriggerResult({
    required this.backendOutcome,
    required this.dialerLaunched,
    this.error,
  });

  final SosBackendOutcome backendOutcome;
  final bool dialerLaunched;

  /// The error thrown by the backend post when [backendOutcome] is
  /// [SosBackendOutcome.failed] (e.g. the patient app's `SosException`).
  final Object? error;

  bool get backendReported => backendOutcome == SosBackendOutcome.reported;
}

/// Backend half of the SOS trigger. Implementations MUST throw on failure —
/// a swallowed error here is exactly the dishonest-success bug this contract
/// exists to prevent. The patient app injects its throwing
/// `SosApiService.triggerAlert` here.
typedef SosBackendPoster =
    Future<void> Function({
      required String phone,
      double? latitude,
      double? longitude,
    });

Future<void> _defaultBackendPoster({
  required String phone,
  double? latitude,
  double? longitude,
}) async {
  final resp = await VHHttpClient.post(
    '/sos/',
    body: {
      'phone': phone,
      'latitude': latitude,
      'longitude': longitude,
      'emergencyType': 'medical',
    },
  );
  if (!resp.isSuccess) {
    throw Exception(
      resp.message ?? 'Failed to send SOS alert (${resp.statusCode})',
    );
  }
}

/// Triggers the SOS flow: opens the dialer and reports the alert to the
/// backend, returning an honest [SosTriggerResult].
///
/// Ordering is deliberate: the backend POST is started but NOT awaited before
/// the dialer launches — the phone call is the safety net and must never wait
/// on the network. The POST outcome is then awaited and returned, so callers
/// can show a real success/failure state instead of an unconditional toast
/// (the pre-2026-08 flow swallowed every backend failure with an unawaited
/// catchError, so "SOS triggered!" was shown even when nothing was sent).
///
/// Supply a [BuildContext] only if you want in-app SnackBars; pass
/// `null` when calling from a background isolate. [backendPoster] lets an app
/// route the POST through its own throwing SOS client.
Future<SosTriggerResult> triggerSOS([
  BuildContext? ctx,
  SosBackendPoster? backendPoster,
]) async {
  final storage = VHSecureStorage.instance;
  final storedPhone =
      await storage.read(key: 'user_phone') ?? await storage.read(key: 'phone');
  final phone = storedPhone?.trim();

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

  // ── 2. Backend POST (started now, awaited AFTER the dialer launch) ───────
  // The helper materializes the outcome instead of throwing so the pending
  // future can never surface as an unhandled async error while the dialer
  // launch is awaited.
  final canPost = phone != null && phone.isNotEmpty && phone != 'guest';
  final backendFuture = canPost
      ? _postAlert(backendPoster ?? _defaultBackendPoster, phone, lat, lng)
      : Future.value(const _BackendAttempt(SosBackendOutcome.skipped));

  // ── 3. Open dialer (unconditional — never blocked on the network) ────────
  var dialerLaunched = false;
  final telUri = Uri.parse('tel:$kSosEmergencyNumber');
  try {
    if (await canLaunchUrl(telUri)) {
      dialerLaunched = await launchUrl(telUri);
    }
  } catch (e) {
    debugPrint('⚠️  Dialer launch error: $e');
  }
  if (!dialerLaunched) {
    debugPrint('⚠️  Could not launch dialer for $kSosEmergencyNumber');
    if (ctx != null && ctx.mounted) {
      ScaffoldMessenger.of(
        ctx,
      ).showSnackBar(const SnackBar(content: Text('Unable to open dialer')));
    }
  }

  // ── 4. Await + report the backend outcome honestly ───────────────────────
  final attempt = await backendFuture;
  return SosTriggerResult(
    backendOutcome: attempt.outcome,
    dialerLaunched: dialerLaunched,
    error: attempt.error,
  );
}

class _BackendAttempt {
  const _BackendAttempt(this.outcome, [this.error]);
  final SosBackendOutcome outcome;
  final Object? error;
}

Future<_BackendAttempt> _postAlert(
  SosBackendPoster poster,
  String phone,
  double? lat,
  double? lng,
) async {
  try {
    await poster(phone: phone, latitude: lat, longitude: lng);
    return const _BackendAttempt(SosBackendOutcome.reported);
  } catch (e) {
    debugPrint('SOS POST error: $e');
    return _BackendAttempt(SosBackendOutcome.failed, e);
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

  /// Optional throwing backend client (see [SosBackendPoster]).
  final SosBackendPoster? backendPoster;

  const SosButton({
    super.key,
    this.tooltip = 'SOS',
    this.heroTag = 'sos',
    this.onBeforeTrigger,
    this.backendPoster,
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
        final result = await triggerSOS(context, backendPoster);
        // The dialer already carries the emergency; the backend outcome is
        // still surfaced honestly instead of pretending the alert was sent.
        if (result.backendOutcome == SosBackendOutcome.failed &&
            context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Could not send the SOS alert to the hospital — '
                'stay on the emergency call.',
              ),
            ),
          );
        }
      },
      child: const Icon(Icons.favorite),
    );
  }
}
