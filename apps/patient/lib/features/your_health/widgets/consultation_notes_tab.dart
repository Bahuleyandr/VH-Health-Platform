import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/widgets/biometric_gate.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/your_health/models/consultation_note.dart';
import 'package:vhhealth/features/your_health/services/consultation_notes_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/l10n/app_localizations_ext.dart';

class ConsultationNotesTab extends StatefulWidget {
  const ConsultationNotesTab({
    super.key,
    this.repository = const ApiConsultationNotesRepository(),
  });

  final ConsultationNotesRepository repository;

  @override
  State<ConsultationNotesTab> createState() => _ConsultationNotesTabState();
}

class _ConsultationNotesTabState extends State<ConsultationNotesTab> {
  List<ConsultationNote> _notes = [];
  bool _isLoading = true;
  String? _error;
  String? _staleLabel;
  DateTime? _cachedAt;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _fetchNotes();
      }
    });
  }

  Future<void> _fetchNotes() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });

    final l10n = AppLocalizations.of(context)!;
    try {
      final page = await widget.repository.listNotes();
      if (!mounted) return;
      setState(() {
        _notes = page.notes;
        _staleLabel = page.staleLabel;
        _cachedAt = page.cachedAt;
        _isLoading = false;
      });

      unawaited(
        page.onFresh
            ?.then((freshNotes) async {
              final cached = await ApiCacheManager.load(
                '/portal/clinical-notes',
              );
              if (!mounted) return;
              setState(() {
                _notes = freshNotes;
                _staleLabel = null;
                _cachedAt = cached?.cachedAt;
              });
            })
            .catchError((Object e) {
              debugPrint('Consultation notes background refresh failed: $e');
            }),
      );
    } catch (e) {
      debugPrint('Consultation notes fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _error = l10n.consultationNotesLoadFailed;
      });
    }
  }

  Future<void> _openNote(ConsultationNote note) async {
    await context.push(
      '/health/consultation-notes/${note.id}',
      extra: ConsultationNoteDetailRouteArgs(
        initialNote: note,
        repository: widget.repository,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Column(
      children: [
        OfflineBanner(staleLabel: _staleLabel, cachedAt: _cachedAt),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _fetchNotes,
            child: DataStateBuilder<ConsultationNote>(
              isLoading: _isLoading,
              error: _error,
              data: _notes,
              onRetry: _fetchNotes,
              emptyIcon: Icons.description_outlined,
              emptyTitle: l10n.consultationNotesEmptyTitle,
              emptySubtitle: l10n.consultationNotesEmptySubtitle,
              builder: (context, notes) {
                return ListView.separated(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(12),
                  itemCount: notes.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (_, index) => _ConsultationNoteCard(
                    note: notes[index],
                    onTap: () => _openNote(notes[index]),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

class _ConsultationNoteCard extends StatelessWidget {
  const _ConsultationNoteCard({required this.note, required this.onTap});

  final ConsultationNote note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final dateFmt = DateFormat.yMMMd(locale);
    final date = note.displayDate == null
        ? l10n.notAvailable
        : dateFmt.format(note.displayDate!);
    final title = note.title.isEmpty
        ? l10n.consultationNotesUntitled
        : note.title;
    final role = _displayRole(note.authorRole, l10n);

    return Card(
      child: ListTile(
        key: ValueKey('consultation-note-${note.id}'),
        leading: CircleAvatar(
          backgroundColor: cs.primaryContainer,
          foregroundColor: cs.onPrimaryContainer,
          child: const Icon(Icons.description_outlined),
        ),
        title: Text(
          title,
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(date),
              const SizedBox(height: 2),
              Text('${l10n.consultationNotesDoctorRole}: $role'),
              const SizedBox(height: 2),
              Text(
                '${l10n.consultationNotesType}: '
                '${l10n.consultationNoteTypeLabel(note.noteType)}',
              ),
            ],
          ),
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}

class ConsultationNoteDetailRouteArgs {
  const ConsultationNoteDetailRouteArgs({this.initialNote, this.repository});

  final ConsultationNote? initialNote;
  final ConsultationNotesRepository? repository;
}

class ConsultationNoteDetailScreen extends StatefulWidget {
  const ConsultationNoteDetailScreen({
    super.key,
    required this.noteId,
    this.initialNote,
    this.repository = const ApiConsultationNotesRepository(),
  });

  final int noteId;
  final ConsultationNote? initialNote;
  final ConsultationNotesRepository repository;

  @override
  State<ConsultationNoteDetailScreen> createState() =>
      _ConsultationNoteDetailScreenState();
}

class _ConsultationNoteDetailScreenState
    extends State<ConsultationNoteDetailScreen> {
  ConsultationNote? _note;
  bool _isLoading = true;
  String? _error;
  DateTime? _cachedAt;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _fetchNote();
      }
    });
  }

  Future<void> _fetchNote() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });

    final l10n = AppLocalizations.of(context)!;
    try {
      final snapshot = widget.repository is ApiConsultationNotesRepository
          ? await (widget.repository as ApiConsultationNotesRepository)
                .getNoteSnapshot(widget.noteId)
          : ConsultationNoteSnapshot(
              note: await widget.repository.getNote(widget.noteId),
            );
      if (!mounted) return;
      setState(() {
        _note = snapshot.note;
        _cachedAt = snapshot.cachedAt;
        _isLoading = false;
      });
    } catch (e) {
      debugPrint('Consultation note detail fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _error = l10n.consultationNotesDetailLoadFailed;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    // FL-H1: deep-linkable records detail — gated like the /health hub.
    // The static grace window keeps hub -> detail from double-prompting.
    return BiometricGate(builder: _buildUnlocked);
  }

  Widget _buildUnlocked(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final initialTitle = widget.initialNote?.title ?? '';
    final fallbackTitle = initialTitle.isEmpty
        ? l10n.consultationNotesUntitled
        : initialTitle;

    return Scaffold(
      appBar: AppBar(title: Text(fallbackTitle)),
      body: Column(
        children: [
          OfflineBanner(cachedAt: _cachedAt),
          Expanded(
            child: DataStateBuilder<ConsultationNote>(
              isLoading: _isLoading,
              error: _error,
              data: _note == null ? const [] : [_note!],
              onRetry: _fetchNote,
              emptyIcon: Icons.description_outlined,
              emptyTitle: l10n.consultationNotesUntitled,
              emptySubtitle: l10n.consultationNotesNoDetails,
              builder: (context, notes) =>
                  _ConsultationNoteDetail(note: notes.first),
            ),
          ),
        ],
      ),
    );
  }
}

class _ConsultationNoteDetail extends StatelessWidget {
  const _ConsultationNoteDetail({required this.note});

  final ConsultationNote note;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    final sections = _contentSections(note.content);

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _NoteMetadataCard(note: note),
        const SizedBox(height: 16),
        Text(
          l10n.consultationNotesDetails,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 8),
        if (sections.isEmpty)
          Text(
            l10n.consultationNotesNoDetails,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          )
        else
          ...sections.map((section) => _NoteSectionCard(section: section)),
      ],
    );
  }
}

class _NoteMetadataCard extends StatelessWidget {
  const _NoteMetadataCard({required this.note});

  final ConsultationNote note;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final dateFmt = DateFormat.yMMMd(locale).add_jm();
    final signedAt = note.signedAt == null
        ? l10n.notAvailable
        : dateFmt.format(note.signedAt!);
    final updatedAt = note.updatedAt == null
        ? l10n.notAvailable
        : dateFmt.format(note.updatedAt!);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _MetadataLine(
              label: l10n.consultationNotesType,
              value: l10n.consultationNoteTypeLabel(note.noteType),
            ),
            _MetadataLine(
              label: l10n.consultationNotesDoctorRole,
              value: _displayRole(note.authorRole, l10n),
            ),
            _MetadataLine(
              label: l10n.consultationNotesSignedAt,
              value: signedAt,
            ),
            _MetadataLine(
              label: l10n.consultationNotesUpdatedAt,
              value: updatedAt,
            ),
          ],
        ),
      ),
    );
  }
}

class _MetadataLine extends StatelessWidget {
  const _MetadataLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 108,
            child: Text(
              label,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(child: Text(value, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}

class _NoteSectionCard extends StatelessWidget {
  const _NoteSectionCard({required this.section});

  final _NoteSection section;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              section.title,
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            Text(section.body, style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
    );
  }
}

class _NoteSection {
  const _NoteSection({required this.title, required this.body});

  final String title;
  final String body;
}

List<_NoteSection> _contentSections(Map<String, dynamic> content) {
  return content.entries
      .where((entry) => !_isEmptyValue(entry.value))
      .map(
        (entry) => _NoteSection(
          title: _titleize(entry.key),
          body: _formatValue(entry.value),
        ),
      )
      .where((section) => section.body.trim().isNotEmpty)
      .toList();
}

bool _isEmptyValue(dynamic value) {
  if (value == null) return true;
  if (value is String) return value.trim().isEmpty;
  if (value is Iterable) return value.isEmpty;
  if (value is Map) return value.isEmpty;
  return false;
}

String _formatValue(dynamic value) {
  if (value is Map) {
    return value.entries
        .where((entry) => !_isEmptyValue(entry.value))
        .map(
          (entry) =>
              '${_titleize(entry.key.toString())}: ${_formatValue(entry.value)}',
        )
        .join('\n');
  }
  if (value is Iterable) {
    return value
        .where((item) => !_isEmptyValue(item))
        .map((item) => '- ${_formatValue(item)}')
        .join('\n');
  }
  return value.toString();
}

String _displayRole(String raw, AppLocalizations l10n) {
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return l10n.consultationNotesUnknownRole;
  return _titleize(trimmed);
}

String _titleize(String raw) {
  return raw
      .replaceAll('_', ' ')
      .replaceAll('-', ' ')
      .trim()
      .split(RegExp(r'\s+'))
      .where((part) => part.isNotEmpty)
      .map((part) => part[0].toUpperCase() + part.substring(1).toLowerCase())
      .join(' ');
}
