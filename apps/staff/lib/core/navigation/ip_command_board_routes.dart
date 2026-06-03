String ipCommandBoardRoute({
  String? patientUid,
  Object? admissionId,
  String? patientName,
  String? action,
  String? context,
}) {
  final params = <String, String>{};
  final uid = _trim(patientUid);
  final admission = _trim(admissionId);
  final name = _trim(patientName);
  final actionKey = _trim(action);
  final contextKey = _trim(context);

  if (uid.isNotEmpty) params['patient_uid'] = uid;
  if (admission.isNotEmpty && admission != '0') {
    params['admission_id'] = admission;
  }
  if (actionKey.isNotEmpty) params['action'] = actionKey;
  if (name.isNotEmpty) params['name'] = name;
  if (contextKey.isNotEmpty) params['context'] = contextKey;

  if (params.isEmpty) return '/patient-command-board';
  final query = params.entries
      .map(
        (entry) =>
            '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}',
      )
      .join('&');
  return '/patient-command-board?$query';
}

String _trim(Object? value) => (value ?? '').toString().trim();
