import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/portal/models/lab_result.dart';

class LabResultsPage {
  const LabResultsPage({required this.results, this.staleLabel, this.onFresh});

  final List<LabResult> results;
  final String? staleLabel;
  final Future<List<LabResult>>? onFresh;
}

abstract class LabResultsRepository {
  Future<LabResultsPage> listResults();
  Future<LabResult> getResult(int id);
  Future<LabResultTrend> getTrend(LabResult result, {int months = 24});
}

class ApiLabResultsRepository implements LabResultsRepository {
  const ApiLabResultsRepository();

  @override
  Future<LabResultsPage> listResults() async {
    final result = await ApiClient.cachedGet('/portal/lab-results');
    if (!result.isSuccess) {
      throw Exception(result.message ?? 'Failed to load lab results');
    }

    return LabResultsPage(
      results: _parseResults(result.data),
      staleLabel: result.staleLabel,
      onFresh: result.onFresh?.then((fresh) {
        if (!fresh.isSuccess) {
          throw Exception(fresh.message ?? 'Failed to refresh lab results');
        }
        return _parseResults(fresh.data);
      }),
    );
  }

  @override
  Future<LabResult> getResult(int id) async {
    final result = await ApiClient.cachedGet('/portal/lab-results/$id');
    if (!result.isSuccess) {
      throw Exception(result.message ?? 'Failed to load lab result');
    }
    final data = result.data;
    if (data is Map<String, dynamic>) return LabResult.fromJson(data);
    if (data is Map) return LabResult.fromJson(Map<String, dynamic>.from(data));
    throw Exception('Invalid lab result response');
  }

  @override
  Future<LabResultTrend> getTrend(LabResult result, {int months = 24}) async {
    final key = result.trendQueryKey;
    final value = result.trendQueryValue;
    if (key == null || value == null) {
      throw ArgumentError('Lab result does not have a trend code');
    }

    final response = await ApiClient.cachedGet(
      '/portal/lab-results/trends',
      queryParameters: {key: value, 'months': months.toString()},
    );
    if (!response.isSuccess) {
      throw Exception(response.message ?? 'Failed to load lab trend');
    }
    final data = response.data;
    if (data is Map<String, dynamic>) return LabResultTrend.fromJson(data);
    if (data is Map) {
      return LabResultTrend.fromJson(Map<String, dynamic>.from(data));
    }
    throw Exception('Invalid lab trend response');
  }
}

List<LabResult> _parseResults(dynamic raw) {
  final list = raw is List
      ? raw
      : raw is Map
      ? (raw['results'] ?? raw['records'] ?? raw['data'] ?? const [])
      : const [];

  if (list is! List) return const [];
  return list
      .whereType<Map>()
      .map((item) => LabResult.fromJson(Map<String, dynamic>.from(item)))
      .where((result) => result.id > 0)
      .toList();
}
