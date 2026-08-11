typedef PatientLockScreenCopy = ({String title, String body});

const _patientLockScreenTitle = 'VH Health';
const _patientLockScreenBody =
    'You have a new update. Open the app to view it.';

/// Returns the only copy that patient push content may render outside the
/// authenticated app. Remote display fields are intentionally untrusted.
PatientLockScreenCopy patientLockScreenCopy({
  String? remoteTitle,
  String? remoteBody,
  Map<String, dynamic> payload = const {},
}) => (title: _patientLockScreenTitle, body: _patientLockScreenBody);

/// Keeps navigation metadata but drops display copy before it is attached to
/// an operating-system notification.
Map<String, dynamic> patientNotificationPayload(Map<String, dynamic> data) {
  final normalized = <String, dynamic>{};
  data.forEach((key, value) {
    if (key == 'title' || key == 'body') return;
    normalized[key] = value?.toString();
  });
  return normalized;
}
