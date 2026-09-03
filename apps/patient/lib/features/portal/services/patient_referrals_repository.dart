import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/portal/models/patient_referral.dart';

class PatientReferralsPage {
  const PatientReferralsPage({
    required this.referrals,
    this.staleLabel,
    this.cachedAt,
    this.onFresh,
  });

  final List<PatientReferral> referrals;
  final String? staleLabel;
  final DateTime? cachedAt;
  final Future<List<PatientReferral>>? onFresh;
}

abstract class PatientReferralsRepository {
  Future<PatientReferralsPage> listReferrals({
    required String loadFailureMessage,
    required String refreshFailureMessage,
  });
}

class ApiPatientReferralsRepository implements PatientReferralsRepository {
  const ApiPatientReferralsRepository();

  @override
  Future<PatientReferralsPage> listReferrals({
    required String loadFailureMessage,
    required String refreshFailureMessage,
  }) async {
    final response = await ApiClient.cachedGet('/portal/referrals');
    if (!response.isSuccess) {
      throw Exception(response.failureMessage(loadFailureMessage));
    }
    return PatientReferralsPage(
      referrals: _parse(response.data),
      staleLabel: response.staleLabel,
      cachedAt: response.cachedAt,
      onFresh: response.onFresh?.then((fresh) {
        if (!fresh.isSuccess) {
          throw Exception(fresh.failureMessage(refreshFailureMessage));
        }
        return _parse(fresh.data);
      }),
    );
  }
}

List<PatientReferral> _parse(dynamic raw) {
  final list = raw is List
      ? raw
      : raw is Map
      ? (raw['referrals'] ?? raw['data'] ?? const [])
      : const [];
  if (list is! List) return const [];
  return list
      .whereType<Map>()
      .map((item) => PatientReferral.fromJson(Map<String, dynamic>.from(item)))
      .where((item) => item.id > 0)
      .toList(growable: false);
}
