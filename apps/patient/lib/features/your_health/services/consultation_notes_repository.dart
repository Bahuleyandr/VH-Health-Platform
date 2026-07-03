import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/your_health/models/consultation_note.dart';

class ConsultationNotesPage {
  const ConsultationNotesPage({
    required this.notes,
    this.staleLabel,
    this.onFresh,
  });

  final List<ConsultationNote> notes;
  final String? staleLabel;
  final Future<List<ConsultationNote>>? onFresh;
}

abstract class ConsultationNotesRepository {
  Future<ConsultationNotesPage> listNotes();
  Future<ConsultationNote> getNote(int id);
}

class ApiConsultationNotesRepository implements ConsultationNotesRepository {
  const ApiConsultationNotesRepository();

  @override
  Future<ConsultationNotesPage> listNotes() async {
    final result = await ApiClient.cachedGet('/portal/clinical-notes');
    if (!result.isSuccess) {
      throw Exception(result.message ?? 'Failed to load consultation notes');
    }

    return ConsultationNotesPage(
      notes: _parseNotes(result.data),
      staleLabel: result.staleLabel,
      onFresh: result.onFresh?.then((fresh) {
        if (!fresh.isSuccess) {
          throw Exception(fresh.message ?? 'Failed to refresh notes');
        }
        return _parseNotes(fresh.data);
      }),
    );
  }

  @override
  Future<ConsultationNote> getNote(int id) async {
    final result = await ApiClient.cachedGet('/portal/clinical-notes/$id');
    if (!result.isSuccess) {
      throw Exception(result.message ?? 'Failed to load consultation note');
    }

    final data = result.data;
    if (data is Map<String, dynamic>) {
      return ConsultationNote.fromJson(data);
    }
    if (data is Map) {
      return ConsultationNote.fromJson(Map<String, dynamic>.from(data));
    }
    throw Exception('Invalid consultation note response');
  }
}

List<ConsultationNote> _parseNotes(dynamic raw) {
  final list = raw is List
      ? raw
      : raw is Map
      ? (raw['notes'] ?? raw['records'] ?? raw['data'] ?? const [])
      : const [];

  if (list is! List) return const [];
  return list
      .whereType<Map>()
      .map((item) => ConsultationNote.fromJson(Map<String, dynamic>.from(item)))
      .where((note) => note.id > 0)
      .toList();
}
