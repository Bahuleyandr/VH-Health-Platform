import 'dart:async';

import 'package:flutter/material.dart';
import '../services/telemetry_service.dart';
import '../services/voice_dictation_service.dart';
import '../theme/app_theme.dart';
import 'states/success_toast.dart';

/// Microphone button that dictates into a [TextEditingController].
///
/// Tap → mic permission prompt (handled by the `record` package on
/// first use) → recording overlay with a live timer + Stop button →
/// upload + transcribe via [VoiceDictationService] → append the
/// returned transcript to the controller's text.
///
/// Drop next to any text field that takes free-form clinical text:
/// bed notes, nursing notes, handover notes, vitals notes, the
/// quick-edit notes dialog, etc.
///
/// Optional [patientUid] / [admissionId] thread through to the backend
/// so the saved voice-note row in `clinical_voice_notes` links to the
/// right patient automatically.
class VoiceDictateButton extends StatefulWidget {
  final TextEditingController controller;
  final String? patientUid;
  final int? admissionId;
  final String tooltip;
  const VoiceDictateButton({
    super.key,
    required this.controller,
    this.patientUid,
    this.admissionId,
    this.tooltip = 'Dictate (voice → text)',
  });

  @override
  State<VoiceDictateButton> createState() => _VoiceDictateButtonState();
}

class _VoiceDictateButtonState extends State<VoiceDictateButton> {
  bool _busy = false;

  Future<void> _start() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await VoiceDictationService.start();
    } catch (e) {
      if (mounted) {
        ErrorToast.show(
          context,
          e.toString().replaceFirst('Exception: ', ''),
        );
      }
      if (mounted) setState(() => _busy = false);
      return;
    }
    if (!mounted) {
      await VoiceDictationService.cancel();
      return;
    }
    // Show recording dialog. Closes on Stop or Cancel; the result tells
    // us whether to transcribe (true) or discard (false).
    final transcribe = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const _RecordingDialog(),
    );
    if (!mounted) {
      if (transcribe == true) {
        await VoiceDictationService.cancel();
      }
      return;
    }
    if (transcribe != true) {
      await VoiceDictationService.cancel();
      setState(() => _busy = false);
      return;
    }

    // Show a brief "transcribing…" indicator while the upload is in flight.
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const _TranscribingDialog(),
    );
    try {
      final transcript = await VoiceDictationService.stopAndTranscribe(
        patientUid: widget.patientUid,
        admissionId: widget.admissionId,
      );
      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).pop();
      _appendTranscript(transcript);
      Telemetry.event('voice_dictation.completed', {
        'has_patient': widget.patientUid != null ? 'true' : 'false',
        'transcript_chars': transcript.length.toString(),
      });
      SuccessToast.show(context, 'Dictation added to notes');
    } catch (e) {
      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).pop();
      ErrorToast.show(
        context,
        e.toString().replaceFirst('Exception: ', ''),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _appendTranscript(String transcript) {
    final ctrl = widget.controller;
    final existing = ctrl.text;
    final glue = existing.isEmpty || existing.endsWith('\n') ? '' : ' ';
    ctrl.text = '$existing$glue$transcript';
    ctrl.selection = TextSelection.fromPosition(
      TextPosition(offset: ctrl.text.length),
    );
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: _busy
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.mic_none),
      tooltip: widget.tooltip,
      color: AppTheme.primaryBlue,
      onPressed: _busy ? null : _start,
    );
  }
}

/// Modal shown while the mic is hot. Pulses a red dot, ticks the
/// elapsed timer once a second, and offers Stop / Cancel.
class _RecordingDialog extends StatefulWidget {
  const _RecordingDialog();
  @override
  State<_RecordingDialog> createState() => _RecordingDialogState();
}

class _RecordingDialogState extends State<_RecordingDialog>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;
  Timer? _ticker;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat(reverse: true);
    _ticker = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (!mounted) return;
      setState(() => _elapsed = VoiceDictationService.elapsed);
    });
  }

  @override
  void dispose() {
    _pulse.dispose();
    _ticker?.cancel();
    super.dispose();
  }

  String _format(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Dictating…'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedBuilder(
            animation: _pulse,
            builder: (context, _) {
              return Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: AppTheme.errorRed.withValues(
                    alpha: 0.2 + (_pulse.value * 0.4),
                  ),
                  shape: BoxShape.circle,
                ),
                child: const Center(
                  child: Icon(Icons.mic, color: AppTheme.errorRed, size: 32),
                ),
              );
            },
          ),
          const SizedBox(height: 12),
          Text(
            _format(_elapsed),
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 4),
          Text(
            'Speak naturally. Tap Stop when done.',
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton.icon(
          onPressed: () => Navigator.of(context).pop(true),
          icon: const Icon(Icons.stop),
          label: const Text('Stop & Transcribe'),
        ),
      ],
    );
  }
}

class _TranscribingDialog extends StatelessWidget {
  const _TranscribingDialog();
  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      content: Row(
        mainAxisSize: MainAxisSize.min,
        children: const [
          SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(width: 16),
          Text('Transcribing…'),
        ],
      ),
    );
  }
}
