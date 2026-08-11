typedef PatientLockScreenCopy = ({String title, String body});

const _patientLockScreenTitle = 'VH Health';
const _patientLockScreenBody =
    'You have a new update. Open the app to view it.';
const _patientNotificationRoute = '/notifications';
const _patientNotificationAction = 'open_notification_inbox';
final _opaquePatientNotificationId = RegExp(
  r'^push_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

/// Returns the only copy that patient push content may render outside the
/// authenticated app. Remote display fields are intentionally untrusted.
PatientLockScreenCopy patientLockScreenCopy({
  String? remoteTitle,
  String? remoteBody,
  Map<String, dynamic> payload = const {},
}) => (title: _patientLockScreenTitle, body: _patientLockScreenBody);

/// Rebuilds the only data envelope allowed outside the authenticated app.
Map<String, dynamic> patientNotificationPayload(Map<String, dynamic> data) {
  final notificationId = data['notification_id']?.toString();
  return {
    if (notificationId != null &&
        _opaquePatientNotificationId.hasMatch(notificationId))
      'notification_id': notificationId,
    'route': _patientNotificationRoute,
    'action': _patientNotificationAction,
  };
}
