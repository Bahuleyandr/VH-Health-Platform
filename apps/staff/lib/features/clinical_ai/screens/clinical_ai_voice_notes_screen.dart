// Clinical AI voice notes — apps/staff Flutter.
//
// Bridges the existing M3 `voiceSoapService` backend to the staff app.
// Lists this clinician's recent voice notes (transcribed but not yet
// drafted into a SOAP), and exposes a single tap-to-generate-SOAP
// action that pushes the resulting draft into the review queue.
//
// Audio recording is intentionally NOT in this screen — that needs the
// `record` Flutter package + iOS/Android microphone permissions and is
// scoped as a follow-up. Until then, voice notes are uploaded via the
// existing multipart /clinical/voice-note/transcribe endpoint by other
// clients (admin web, clinician's desktop, ambient diarization), and
// this screen consumes them.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/widgets/staff_scaffold.dart';

class ClinicalAiVoiceNotesScreen extends StatefulWidget {
  const ClinicalAiVoiceNotesScreen({super.key});

  @override
  State<ClinicalAiVoiceNotesScreen> createState() => _ClinicalAiVoiceNotesScreenState();
}

class _ClinicalAiVoiceNotesScreenState extends State<ClinicalAiVoiceNotesScreen> {
  List<Map<String, dynamic>> _notes = const [];
  bool _loading = true;
  String? _error;
  int? _generatingId;

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
      final notes = await ClinicalAiApiService.listMyVoiceNotes(limit: 100);
      if (!mounted) return;
      setState(() {
        _notes = notes;
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err.toString();
        _loading = false;
      });
    }
  }

  Future<void> _generateSoap(Map<String, dynamic> note) async {
    final id = note['id'];
    final intId = id is int ? id : int.tryParse(id?.toString() ?? '');
    if (intId == null) return;
    setState(() => _generatingId = intId);
    try {
      final result = await ClinicalAiApiService.generateSoapFromVoiceNote(intId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('SOAP draft generated; opening review queue.')),
      );
      final reviewId = result['review_id'] ?? result['draft']?['review_id'];
      if (reviewId is int) {
        context.push('/clinical-ai/review/$reviewId', extra: result);
      } else if (reviewId is String) {
        context.push('/clinical-ai/review/$reviewId', extra: result);
      } else {
        context.push('/clinical-ai/queue');
      }
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('SOAP generation failed: $err')),
      );
    } finally {
      if (mounted) setState(() => _generatingId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Voice notes',
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return _ErrorState(message: _error!, onRetry: _load);
    if (_notes.isEmpty) return const _EmptyState();
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: _notes.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final note = _notes[index];
          final id = note['id'];
          final intId = id is int ? id : int.tryParse(id?.toString() ?? '');
          return _VoiceNoteTile(
            note: note,
            generating: _generatingId == intId,
            onGenerate: () => _generateSoap(note),
          );
        },
      ),
    );
  }
}

class _VoiceNoteTile extends StatelessWidget {
  const _VoiceNoteTile({required this.note, required this.generating, required this.onGenerate});
  final Map<String, dynamic> note;
  final bool generating;
  final VoidCallback onGenerate;

  @override
  Widget build(BuildContext context) {
    final id = note['id']?.toString() ?? '—';
    final status = note['status']?.toString() ?? note['transcription_status']?.toString() ?? '—';
    final transcript = note['transcript']?.toString() ?? note['final_transcript']?.toString();
    final patientUid = note['patient_uid']?.toString();
    final createdAt = note['created_at']?.toString() ?? note['recorded_at']?.toString();
    final draftId = note['soap_draft_id'] ?? note['draft_id'];
    final hasDraft = draftId != null && draftId.toString() != 'null';

    final canGenerate = status.toLowerCase() == 'completed' &&
        !hasDraft &&
        (transcript != null && transcript.isNotEmpty);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.mic, size: 18),
                  const SizedBox(width: 6),
                  Text('Voice note #$id', style: const TextStyle(fontWeight: FontWeight.bold)),
                  const Spacer(),
                  _StatusChip(label: status),
                ],
              ),
              if (patientUid != null && patientUid != 'null')
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    'Patient: $patientUid',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 11),
                  ),
                ),
              if (createdAt != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    createdAt,
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 11),
                  ),
                ),
              if (transcript != null && transcript.isNotEmpty) Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  transcript,
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13),
                ),
              ),
              if (hasDraft)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.green.shade50,
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(color: Colors.green.shade200),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.check_circle_outline, size: 14, color: Colors.green),
                        const SizedBox(width: 4),
                        Text(
                          'SOAP draft already generated',
                          style: TextStyle(color: Colors.green.shade800, fontSize: 11),
                        ),
                      ],
                    ),
                  ),
                ),
              if (canGenerate)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: FilledButton.icon(
                    onPressed: generating ? null : onGenerate,
                    icon: generating
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.auto_awesome, size: 16),
                    label: Text(generating ? 'Drafting...' : 'Generate SOAP draft'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.label});
  final String label;
  @override
  Widget build(BuildContext context) {
    Color color;
    switch (label.toLowerCase()) {
      case 'completed': color = Colors.green.shade700; break;
      case 'transcribing': case 'pending': color = Colors.blue.shade700; break;
      case 'failed': color = Theme.of(context).colorScheme.error; break;
      default: color = Theme.of(context).colorScheme.onSurfaceVariant;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(label, style: TextStyle(color: color, fontSize: 11)),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.mic_none, size: 48, color: Colors.grey),
            SizedBox(height: 8),
            Text('No voice notes yet.'),
            SizedBox(height: 4),
            Text(
              'Record a voice note from the desktop client; it will appear here for SOAP drafting.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: Colors.red, size: 48),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
