import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/features/portal/models/discharge_summary.dart';
import 'package:vhhealth_core/services/http_client.dart';

class DischargeSummariesPage {
  const DischargeSummariesPage({
    required this.summaries,
    this.staleLabel,
    this.onFresh,
  });

  final List<DischargeSummary> summaries;
  final String? staleLabel;
  final Future<List<DischargeSummary>>? onFresh;
}

abstract class DischargeSummariesRepository {
  Future<DischargeSummariesPage> listSummaries();
  Future<DischargeSummary> getSummary(int id);
}

class ApiDischargeSummariesRepository implements DischargeSummariesRepository {
  const ApiDischargeSummariesRepository();

  @override
  Future<DischargeSummariesPage> listSummaries() async {
    final result = await ApiClient.cachedGet('/portal/discharge-summaries');
    if (!result.isSuccess) {
      throw Exception(
        result.failureMessage('Failed to load discharge summaries'),
      );
    }

    return DischargeSummariesPage(
      summaries: _parseSummaries(result.data),
      staleLabel: result.staleLabel,
      onFresh: result.onFresh?.then((fresh) {
        if (!fresh.isSuccess) {
          throw Exception(fresh.failureMessage('Failed to refresh summaries'));
        }
        return _parseSummaries(fresh.data);
      }),
    );
  }

  @override
  Future<DischargeSummary> getSummary(int id) async {
    final result = await ApiClient.cachedGet('/portal/discharge-summaries/$id');
    if (!result.isSuccess) {
      throw Exception(
        result.failureMessage('Failed to load discharge summary'),
      );
    }
    final data = result.data;
    if (data is Map<String, dynamic>) {
      return DischargeSummary.fromJson(data);
    }
    if (data is Map) {
      return DischargeSummary.fromJson(Map<String, dynamic>.from(data));
    }
    throw Exception('Invalid discharge summary response');
  }
}

typedef DischargeSummaryPdfOpener =
    Future<void> Function(DischargeSummary summary);

Future<void> openDischargeSummaryPdf(DischargeSummary summary) async {
  final response = await VHHttpClient.getBytes(
    '/portal/discharge-summaries/${summary.id}/pdf',
    timeout: const Duration(seconds: 30),
  );
  if (response.statusCode != 200 || response.bodyBytes.isEmpty) {
    throw Exception('Download failed (HTTP ${response.statusCode})');
  }

  final date = DateTime.now().toIso8601String().split('T').first;
  final file = await CacheFileUtils.saveBytesToCache(
    'DischargeSummary_${summary.id}_$date.pdf',
    response.bodyBytes,
  );
  if (file == null) throw Exception('Could not save file');
  await CacheFileUtils.openCachedFile(file.path);
}

List<DischargeSummary> _parseSummaries(dynamic raw) {
  final list = raw is List
      ? raw
      : raw is Map
      ? (raw['summaries'] ?? raw['records'] ?? raw['data'] ?? const [])
      : const [];

  if (list is! List) return const [];
  return list
      .whereType<Map>()
      .map((item) => DischargeSummary.fromJson(Map<String, dynamic>.from(item)))
      .where((summary) => summary.id > 0)
      .toList();
}
