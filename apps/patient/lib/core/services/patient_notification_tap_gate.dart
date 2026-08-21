import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';

typedef PatientSessionRevalidator = Future<bool> Function();
typedef PatientNotificationNavigator = void Function(String route);
typedef PatientNotificationRouteResolver = String? Function(
  Map<String, dynamic> payload,
);

/// Holds notification-tap navigation until the current backend session and
/// hospital readiness have been revalidated.
class PatientNotificationTapGate {
  PatientNotificationTapGate({
    required PatientSessionRevalidator revalidateSession,
    required PatientNotificationNavigator navigate,
    PatientNotificationRouteResolver? resolveRoute,
  }) : _revalidateSession = revalidateSession,
       _navigate = navigate,
       _resolveRoute = resolveRoute ?? DeepLinkService.parseNotificationRoute;

  final PatientSessionRevalidator _revalidateSession;
  final PatientNotificationNavigator _navigate;
  final PatientNotificationRouteResolver _resolveRoute;

  Future<bool> open(Map<String, dynamic> payload) async {
    final route = _resolveRoute(payload);
    if (route == null) return false;

    try {
      if (!await _revalidateSession()) return false;
      _navigate(route);
      return true;
    } catch (error) {
      if (kDebugMode) {
        debugPrint('Patient notification tap held by session gate: $error');
      }
      return false;
    }
  }
}
