import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/your_health/models/consultation_note.dart';

class ConsultationNotesPage {
  const ConsultationNotesPage({
    required this.notes,
    this.staleLabel,
    this.cachedAt,
    this.onFresh,
  });

  final List<ConsultationNote> notes;
  final String? staleLabel;
  final DateTime? cachedAt;
  final Future<List<ConsultationNote>>? onFresh;
}

class ConsultationNoteSnapshot {
  const ConsultationNoteSnapshot({required this.note, this.cachedAt});

  final ConsultationNote note;
  final DateTime? cachedAt;
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
      throw Exception(
        result.failureMessage('Failed to load consultation notes'),
      );
    }

    return ConsultationNotesPage(
      notes: _parseNotes(result.data),
      staleLabel: result.staleLabel,
      cachedAt: result.cachedAt,
      onFresh: result.onFresh?.then((fresh) {
        if (!fresh.isSuccess) {
          throw Exception(fresh.failureMessage('Failed to refresh notes'));
        }
        return _parseNotes(fresh.data);
      }),
    );
  }

  @override
  Future<ConsultationNote> getNote(int id) async =>
      (await getNoteSnapshot(id)).note;

  Future<ConsultationNoteSnapshot> getNoteSnapshot(int id) async {
    final result = await ApiClient.cachedGet('/portal/clinical-notes/$id');
    if (!result.isSuccess) {
      throw Exception(
        result.failureMessage('Failed to load consultation note'),
      );
    }

    final data = result.data;
    if (data is Map<String, dynamic>) {
      return ConsultationNoteSnapshot(
        note: ConsultationNote.fromJson(data),
        cachedAt: result.cachedAt,
      );
    }
    if (data is Map) {
      return ConsultationNoteSnapshot(
        note: ConsultationNote.fromJson(Map<String, dynamic>.from(data)),
        cachedAt: result.cachedAt,
      );
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
