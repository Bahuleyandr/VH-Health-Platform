import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/portal/models/structured_diagnostic_result.dart';

class StructuredDiagnosticResultsPage {
  const StructuredDiagnosticResultsPage({
    required this.results,
    this.staleLabel,
    this.cachedAt,
    this.onFresh,
  });

  final List<StructuredDiagnosticResult> results;
  final String? staleLabel;
  final DateTime? cachedAt;
  final Future<List<StructuredDiagnosticResult>>? onFresh;
}

class StructuredDiagnosticResultSnapshot {
  const StructuredDiagnosticResultSnapshot({
    required this.result,
    this.cachedAt,
  });

  final StructuredDiagnosticResult result;
  final DateTime? cachedAt;
}

abstract class StructuredDiagnosticResultsRepository {
  Future<StructuredDiagnosticResultsPage> listResults();
  Future<StructuredDiagnosticResult> getResult(String id);
}

class ApiStructuredDiagnosticResultsRepository
    implements StructuredDiagnosticResultsRepository {
  const ApiStructuredDiagnosticResultsRepository();

  @override
  Future<StructuredDiagnosticResultsPage> listResults() async {
    final response = await ApiClient.cachedGet('/portal/diagnostic-results');
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Failed to load diagnostic results'),
      );
    }

    return StructuredDiagnosticResultsPage(
      results: _parseResults(response.data),
      staleLabel: response.staleLabel,
      cachedAt: response.cachedAt,
      onFresh: response.onFresh?.then((fresh) {
        if (!fresh.isSuccess) {
          throw Exception(
            fresh.failureMessage('Failed to refresh diagnostic results'),
          );
        }
        return _parseResults(fresh.data);
      }),
    );
  }

  @override
  Future<StructuredDiagnosticResult> getResult(String id) async =>
      (await getResultSnapshot(id)).result;

  Future<StructuredDiagnosticResultSnapshot> getResultSnapshot(
    String id,
  ) async {
    final response = await ApiClient.cachedGet(
      '/portal/diagnostic-results/$id',
    );
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Failed to load diagnostic result'),
      );
    }
    final data = response.data;
    if (data is Map<String, dynamic>) {
      return StructuredDiagnosticResultSnapshot(
        result: StructuredDiagnosticResult.fromJson(data),
        cachedAt: response.cachedAt,
      );
    }
    if (data is Map) {
      return StructuredDiagnosticResultSnapshot(
        result: StructuredDiagnosticResult.fromJson(
          Map<String, dynamic>.from(data),
        ),
        cachedAt: response.cachedAt,
      );
    }
    throw Exception('Invalid diagnostic result response');
  }
}

List<StructuredDiagnosticResult> _parseResults(dynamic raw) {
  final list = raw is List
      ? raw
      : raw is Map
      ? (raw['results'] ?? raw['records'] ?? raw['data'] ?? const [])
      : const [];
  if (list is! List) return const [];
  return list
      .whereType<Map>()
      .map(
        (item) => StructuredDiagnosticResult.fromJson(
          Map<String, dynamic>.from(item),
        ),
      )
      .where((result) => result.id.isNotEmpty)
      .toList(growable: false);
}
