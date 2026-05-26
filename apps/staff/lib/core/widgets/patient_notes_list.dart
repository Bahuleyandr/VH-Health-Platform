import 'package:flutter/material.dart';

import '../config/api_config.dart';
import '../services/medical_api_service.dart';
import '../theme/app_theme.dart';

/// Read-only list of every clinical note on a patient — doctor + nurse +
/// any other authoring role surfaced as visible, badged rows. The point is
/// cross-role visibility: a doctor opens the nursing screen and can see
/// nursing notes (read-only); a nurse on the doctor screen sees doctor
/// notes. Edits are blocked for clinical roles by both the backend
/// (append-only) and this widget (no pencil icon).
///
/// If the current user is ADMIN / SUPER_ADMIN, every row exposes a pencil
/// icon that opens a free-text edit sheet and PUTs to /emr/notes/:id —
/// the admin-override path. The original author_uid / author_role / note_type
/// are preserved server-side; only `content` and `version` change.
///
/// Filter chips at the top let the reader narrow to "Doctor notes" or
/// "Nursing notes" without re-querying the backend.
class PatientNotesList extends StatefulWidget {
  final String patientUid;
  final String? patientName;
  const PatientNotesList({
    super.key,
    required this.patientUid,
    this.patientName,
  });

  @override
  State<PatientNotesList> createState() => _PatientNotesListState();
}

enum _NoteFilter { all, doctor, nursing }

class _PatientNotesListState extends State<PatientNotesList> {
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _notes = const [];
  String _currentRole = '';
  _NoteFilter _filter = _NoteFilter.all;

  static const _doctorRoles = {
    'DOCTOR',
    'CONSULTANT',
    'JUNIOR_DOCTOR',
    'RESIDENT',
    'SURGEON',
  };
  static const _nursingRoles = {
    'NURSE',
    'NURSING_STAFF',
    'ICU_NURSE',
    'OT_NURSE',
  };

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final role = await ApiConfig.getRole();
      final res = await MedicalApiService.getPatientNotes(widget.patientUid);
      final data = res['data'];
      final notes = <Map<String, dynamic>>[];
      if (data is List) {
        for (final n in data) {
          if (n is Map<String, dynamic>) notes.add(n);
        }
      } else if (data is Map<String, dynamic>) {
        final inner = data['notes'] ?? data['items'];
        if (inner is List) {
          for (final n in inner) {
            if (n is Map<String, dynamic>) notes.add(n);
          }
        }
      }
      // Newest first — backend already orders by created_at DESC but we
      // defend the contract so a future API change does not flip the order.
      notes.sort((a, b) {
        final ta = DateTime.tryParse('${a['created_at']}') ?? DateTime(1970);
        final tb = DateTime.tryParse('${b['created_at']}') ?? DateTime(1970);
        return tb.compareTo(ta);
      });
      if (!mounted) return;
      setState(() {
        _currentRole = role;
        _notes = notes;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  bool get _isAdmin => _currentRole == 'ADMIN' || _currentRole == 'SUPER_ADMIN';

  List<Map<String, dynamic>> get _visibleNotes {
    if (_filter == _NoteFilter.all) return _notes;
    return _notes.where((n) {
      final role = '${n['author_role'] ?? ''}'.toUpperCase();
      if (_filter == _NoteFilter.doctor) return _doctorRoles.contains(role);
      if (_filter == _NoteFilter.nursing) return _nursingRoles.contains(role);
      return true;
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: Colors.red, size: 40),
              const SizedBox(height: 8),
              Text(
                'Failed to load notes',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
              const SizedBox(height: 4),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12),
              ),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: _load, child: const Text('Retry')),
            ],
          ),
        ),
      );
    }

    final visible = _visibleNotes;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: [
              for (final f in _NoteFilter.values) ...[
                ChoiceChip(
                  label: Text(_filterLabel(f)),
                  selected: _filter == f,
                  onSelected: (_) => setState(() => _filter = f),
                ),
                const SizedBox(width: 6),
              ],
              const Spacer(),
              IconButton(
                tooltip: 'Refresh',
                onPressed: _load,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
        ),
        Expanded(
          child: visible.isEmpty
              ? Center(
                  child: Text(
                    'No notes to show',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
                  itemCount: visible.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (_, i) => _NoteCard(
                    note: visible[i],
                    canEdit: _isAdmin,
                    onEdited: _load,
                  ),
                ),
        ),
      ],
    );
  }

  String _filterLabel(_NoteFilter f) {
    switch (f) {
      case _NoteFilter.all:
        return 'All';
      case _NoteFilter.doctor:
        return 'Doctor';
      case _NoteFilter.nursing:
        return 'Nursing';
    }
  }
}

class _NoteCard extends StatelessWidget {
  final Map<String, dynamic> note;
  final bool canEdit;
  final VoidCallback onEdited;
  const _NoteCard({
    required this.note,
    required this.canEdit,
    required this.onEdited,
  });

  @override
  Widget build(BuildContext context) {
    final role = '${note['author_role'] ?? 'UNKNOWN'}';
    final type = _displayNoteType('${note['note_type'] ?? 'note'}');
    final authorName = _authorName(note);
    final version = note['version'];
    final createdAt = DateTime.tryParse('${note['created_at']}');
    final signed = note['is_signed'] == true;
    final isAddendum = note['is_addendum'] == true;
    final content = note['content'];
    final accent = _roleColor(role);

    return Card(
      elevation: 0,
      color: accent.withValues(alpha: 0.04),
      shape: RoundedRectangleBorder(
        side: BorderSide(color: accent.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Container(
        decoration: BoxDecoration(
          border: Border(left: BorderSide(color: accent, width: 4)),
          borderRadius: BorderRadius.circular(8),
        ),
        padding: const EdgeInsets.fromLTRB(12, 10, 8, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _Badge(label: role, color: accent),
                const SizedBox(width: 6),
                _Badge(label: type, color: AppTheme.textSecondary),
                if (signed) ...[
                  const SizedBox(width: 6),
                  _Badge(label: 'SIGNED', color: Colors.green.shade700),
                ],
                if (isAddendum) ...[
                  const SizedBox(width: 6),
                  _Badge(label: 'ADDENDUM', color: Colors.orange.shade700),
                ],
                const Spacer(),
                if (createdAt != null)
                  Text(
                    _formatDate(createdAt),
                    style: TextStyle(
                      fontSize: 11,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                if (canEdit)
                  IconButton(
                    tooltip: 'Admin: edit prior note',
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.edit_note, size: 20),
                    onPressed: () => _openEditor(context),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            if (authorName.isNotEmpty) ...[
              Row(
                children: [
                  Icon(
                    Icons.person_outline,
                    size: 14,
                    color: AppTheme.textSecondary,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    authorName,
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
            ],
            if (content is Map)
              ..._renderContent(context, content.cast<String, dynamic>())
            else
              Text('$content'),
            if (version is num && version > 1)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  'rev $version (admin-edited)',
                  style: TextStyle(fontSize: 11, color: Colors.orange.shade900),
                ),
              ),
          ],
        ),
      ),
    );
  }

  List<Widget> _renderContent(
    BuildContext context,
    Map<String, dynamic> content,
  ) {
    return [
      for (final entry in content.entries)
        if ('${entry.value}'.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: RichText(
              text: TextSpan(
                style: DefaultTextStyle.of(context).style,
                children: [
                  TextSpan(
                    text: '${_humanLabel(entry.key)}: ',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  TextSpan(text: '${entry.value}'),
                ],
              ),
            ),
          ),
    ];
  }

  String _humanLabel(String key) => key
      .replaceAll('_', ' ')
      .replaceFirstMapped(RegExp(r'^.'), (m) => m[0]!.toUpperCase());

  String _formatDate(DateTime t) {
    final l = t.toLocal();
    return '${l.year}-${l.month.toString().padLeft(2, '0')}-${l.day.toString().padLeft(2, '0')} '
        '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
  }

  Color _roleColor(String role) {
    final r = role.toUpperCase();
    if (r.contains('DOCTOR') ||
        r.contains('CONSULTANT') ||
        r.contains('SURGEON')) {
      return Colors.blue.shade700;
    }
    if (r.contains('NURSE') || r.contains('NURS')) {
      return Colors.teal.shade700;
    }
    if (r.contains('ADMIN')) return Colors.purple.shade700;
    return AppTheme.textSecondary;
  }

  String _displayNoteType(String type) {
    final normalized = type.toLowerCase();
    if (normalized == 'soap' || normalized == 'progress') {
      return 'Progress';
    }
    return type;
  }

  String _authorName(Map<String, dynamic> note) {
    for (final value in [
      note['author_name'],
      note['doctor_name'],
      note['created_by_name'],
      note['author'] is Map ? (note['author'] as Map)['name'] : null,
    ]) {
      final text = value?.toString().trim() ?? '';
      if (text.isNotEmpty && text.toLowerCase() != 'null') return text;
    }
    return '';
  }

  Future<void> _openEditor(BuildContext ctx) async {
    final id = note['id'];
    if (id is! num) return;
    final initial = note['content'];
    if (initial is! Map) return;

    final controllers = <String, TextEditingController>{
      for (final entry in initial.entries)
        '${entry.key}': TextEditingController(text: '${entry.value}'),
    };

    final result = await showModalBottomSheet<Map<String, dynamic>>(
      context: ctx,
      isScrollControlled: true,
      builder: (sheetCtx) {
        return Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(sheetCtx).viewInsets.bottom,
            left: 16,
            right: 16,
            top: 16,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.edit_note, color: Colors.purple),
                    const SizedBox(width: 8),
                    const Text(
                      'Admin edit',
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 16,
                      ),
                    ),
                    const Spacer(),
                    IconButton(
                      onPressed: () => Navigator.pop(sheetCtx),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
                Text(
                  'Overwrites the original prose. The note\'s author, role, and creation time are preserved.',
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
                const SizedBox(height: 12),
                for (final entry in controllers.entries) ...[
                  Text(
                    _humanLabel(entry.key),
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 4),
                  TextField(
                    controller: entry.value,
                    decoration: const InputDecoration(
                      border: OutlineInputBorder(),
                    ),
                    minLines: 2,
                    maxLines: 6,
                  ),
                  const SizedBox(height: 10),
                ],
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: () => Navigator.pop(sheetCtx),
                      child: const Text('Cancel'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: () {
                        Navigator.pop(sheetCtx, {
                          for (final e in controllers.entries)
                            e.key: e.value.text,
                        });
                      },
                      child: const Text('Save'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
              ],
            ),
          ),
        );
      },
    );

    for (final c in controllers.values) {
      c.dispose();
    }

    if (result == null) return;

    try {
      await MedicalApiService.updateClinicalNote(id.toInt(), result);
      onEdited();
      if (ctx.mounted) {
        ScaffoldMessenger.of(
          ctx,
        ).showSnackBar(const SnackBar(content: Text('Note updated')));
      }
    } catch (e) {
      if (ctx.mounted) {
        ScaffoldMessenger.of(
          ctx,
        ).showSnackBar(SnackBar(content: Text('Update failed: $e')));
      }
    }
  }
}

class _Badge extends StatelessWidget {
  final String label;
  final Color color;
  const _Badge({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          color: color,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
