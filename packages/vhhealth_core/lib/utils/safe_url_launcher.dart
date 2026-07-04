import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

import 'log_sanitizer.dart';

/// Safe URL launcher that validates schemes before opening.
///
/// Prevents javascript:, data:, and other dangerous URL schemes from being
/// launched. Only allows known-safe schemes.
class SafeUrlLauncher {
  SafeUrlLauncher._();

  /// Allowed URL schemes. Everything else is blocked.
  /// Cleartext `http` is permitted only in debug builds (local dev); release
  /// builds require `https` for any externally-sourced URL so a MITM cannot
  /// downgrade a server-supplied link to cleartext.
  static const _allowedSchemes = {
    'https',
    if (kDebugMode) 'http',
    'tel',
    'mailto',
    'geo',
    'sms',
    // UPI deep links (NPCI URI spec) — used by the patient bill-pay
    // flow to hand off to PhonePe / GPay / Paytm with the amount
    // pre-filled. The link is generated server-side by our own
    // payment-link service, so the scheme is trusted.
    'upi',
  };

  /// Launch a URL after validating its scheme is safe.
  /// Returns true if launched, false if blocked or failed.
  static Future<bool> launch(
    String url, {
    LaunchMode mode = LaunchMode.platformDefault,
  }) async {
    final uri = Uri.tryParse(url);
    if (uri == null) {
      if (kDebugMode) {
        debugPrint('SafeUrlLauncher: invalid URL: ${logSafePath(url)}');
      }
      return false;
    }
    return launchUri(uri, mode: mode);
  }

  /// Launch a pre-parsed URI after validating its scheme.
  static Future<bool> launchUri(
    Uri uri, {
    LaunchMode mode = LaunchMode.platformDefault,
  }) async {
    if (!_isAllowedScheme(uri)) {
      if (kDebugMode) {
        debugPrint('SafeUrlLauncher: blocked unsafe scheme: ${uri.scheme}');
      }
      return false;
    }
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: mode);
        return true;
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('SafeUrlLauncher: launch failed: ${logSafeError(e)}');
      }
    }
    return false;
  }

  /// Launch a phone number after sanitizing it.
  /// Strips everything except digits, +, and # to prevent USSD injection.
  static Future<bool> launchPhone(String phone) async {
    final sanitized = phone.replaceAll(RegExp(r'[^\d+]'), '');
    if (sanitized.isEmpty) {
      return false;
    }
    final uri = Uri.parse('tel:$sanitized');
    return launchUri(uri);
  }

  static bool _isAllowedScheme(Uri uri) {
    if (uri.scheme.isEmpty) return false;
    return _allowedSchemes.contains(uri.scheme.toLowerCase());
  }
}
