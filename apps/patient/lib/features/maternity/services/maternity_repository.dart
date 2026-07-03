import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/maternity/models/anc_timeline.dart';

abstract class MaternityRepository {
  Future<AncTimelineData> loadTimeline({required String languageCode});

  Future<AncFetalKick> recordFetalKicks({
    required int kickCount,
    required int observationWindowMinutes,
    String? notes,
  });

  Future<AncSupplement> setSupplementReminder({
    required AncSupplement supplement,
    required bool enabled,
  });
}

class ApiMaternityRepository implements MaternityRepository {
  const ApiMaternityRepository();

  @override
  Future<AncTimelineData> loadTimeline({required String languageCode}) async {
    final timelineResult = await ApiClient.cachedGet(
      '/portal/maternity/timeline',
    );
    final timelineResponse = timelineResult.response;
    if (!timelineResponse.isSuccess) {
      throw MaternityRepositoryException(
        timelineResponse.message ?? 'Failed to load ANC timeline',
      );
    }

    final timelineMap = asStringMap(timelineResponse.data);
    if (timelineMap == null) {
      return AncTimelineData.fromResponses(
        timelineData: null,
        packagesData: const [],
        adviceData: const {'advice': []},
        staleLabel: timelineResult.staleLabel,
      );
    }

    final pregnancy = AncPregnancy.fromJson(
      asStringMap(timelineMap['pregnancy']) ?? const {},
    );
    final trimester = pregnancy.trimester;

    final packagesFuture = ApiClient.cachedGet('/portal/maternity/packages');
    final adviceFuture = _loadAdvice(
      languageCode: languageCode,
      trimester: trimester,
    );
    final packagesResult = await packagesFuture;
    final adviceResult = await adviceFuture;

    return AncTimelineData.fromResponses(
      timelineData: timelineMap,
      packagesData: packagesResult.response.isSuccess
          ? packagesResult.response.data
          : const [],
      adviceData: adviceResult.data,
      staleLabel: timelineResult.staleLabel,
      adviceLoadFailed: adviceResult.loadFailed,
    );
  }

  Future<_AdviceLoadResult> _loadAdvice({
    required String languageCode,
    required int? trimester,
  }) async {
    final query = <String, String>{
      'language': languageCode,
      if (trimester != null) 'trimester': '$trimester',
    };

    final primary = await ApiClient.cachedGet(
      '/portal/maternity/anc-advice',
      queryParameters: query,
    );
    final primaryData = asStringMap(primary.response.data);
    if (primary.response.isSuccess &&
        listOfMaps(primaryData?['advice']).isNotEmpty) {
      return _AdviceLoadResult(data: primaryData);
    }

    if (languageCode != 'hi') {
      final fallback = await ApiClient.cachedGet(
        '/portal/maternity/anc-advice',
        queryParameters: {
          'language': 'hi',
          if (trimester != null) 'trimester': '$trimester',
        },
      );
      if (fallback.response.isSuccess) {
        return _AdviceLoadResult(data: asStringMap(fallback.response.data));
      }
    }

    return _AdviceLoadResult(
      data: primaryData ?? const {'advice': []},
      loadFailed: !primary.response.isSuccess,
    );
  }

  @override
  Future<AncFetalKick> recordFetalKicks({
    required int kickCount,
    required int observationWindowMinutes,
    String? notes,
  }) async {
    final response = await ApiClient.post(
      '/portal/maternity/fetal-kicks',
      body: {
        'kick_count': kickCount,
        'observation_window_minutes': observationWindowMinutes,
        if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
      },
    );
    if (!response.isSuccess) {
      throw MaternityRepositoryException(
        response.message ?? 'Could not save kick count',
      );
    }
    return AncFetalKick.fromJson(asStringMap(response.data) ?? const {});
  }

  @override
  Future<AncSupplement> setSupplementReminder({
    required AncSupplement supplement,
    required bool enabled,
  }) async {
    final response = await ApiClient.patch(
      '/portal/maternity/supplements/${supplement.id}/reminder',
      body: {'reminder_enabled': enabled},
    );
    if (!response.isSuccess) {
      throw MaternityRepositoryException(
        response.message ?? 'Could not update reminder',
      );
    }
    return supplement.mergeServerUpdate(asStringMap(response.data) ?? const {});
  }
}

class MaternityRepositoryException implements Exception {
  const MaternityRepositoryException(this.message);

  final String message;

  @override
  String toString() => message;
}

class _AdviceLoadResult {
  const _AdviceLoadResult({required this.data, this.loadFailed = false});

  final Map<String, dynamic>? data;
  final bool loadFailed;
}
