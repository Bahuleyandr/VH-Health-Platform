import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../../l10n/app_strings.dart';
import '../services/telemetry_service.dart';
import '../services/voice_dictation_service.dart';
import '../theme/app_theme.dart';
import 'states/success_toast.dart';

class VoiceDictateButtonController {
  _VoiceDictateButtonState? _state;

  Future<void> start() async {
    await _state?._start();
  }
}

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
  final String? tooltip;
  final VoiceDictateButtonController? dictateController;
  final Future<bool> Function(BuildContext context, String transcript)?
  onTranscript;
  const VoiceDictateButton({
    super.key,
    required this.controller,
    this.patientUid,
    this.admissionId,
    this.tooltip,
    this.dictateController,
    this.onTranscript,
  });

  @override
  State<VoiceDictateButton> createState() => _VoiceDictateButtonState();
}

class _VoiceDictateButtonState extends State<VoiceDictateButton> {
  bool _busy = false;
  VoiceDictationAvailability? _availability;
  Timer? _holdTimer;
  bool _holdStarting = false;
  bool _holdRecording = false;
  bool _holdStopQueued = false;
  bool _holdCancelQueued = false;
  bool _suppressNextTap = false;

  @override
  void initState() {
    super.initState();
    widget.dictateController?._state = this;
    unawaited(_loadAvailability());
  }

  @override
  void didUpdateWidget(covariant VoiceDictateButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.dictateController != widget.dictateController) {
      if (oldWidget.dictateController?._state == this) {
        oldWidget.dictateController?._state = null;
      }
      widget.dictateController?._state = this;
    }
  }

  @override
  void dispose() {
    _holdTimer?.cancel();
    if (widget.dictateController?._state == this) {
      widget.dictateController?._state = null;
    }
    super.dispose();
  }

  Future<void> _loadAvailability() async {
    try {
      final availability = await VoiceDictationService.fetchAvailability();
      if (mounted) setState(() => _availability = availability);
    } catch (_) {
      // Press-time policy checks still surface the concrete error. A failed
      // discovery request should not permanently hide a mic after transient
      // network/auth refresh issues.
    }
  }

  bool get _disabledByConfig =>
      _availability != null && !_availability!.canDictate;

  Future<void> _start() async {
    if (_suppressNextTap) {
      _suppressNextTap = false;
      return;
    }
    if (_busy || _disabledByConfig) return;
    final started = await _beginRecording();
    if (!started || !mounted) return;

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
    await _finishRecordingAndTranscribe();
  }

  Future<bool> _beginRecording() async {
    final strings = AppStrings.of(context);
    final textDirection = Directionality.of(context);
    final view = View.of(context);
    setState(() => _busy = true);
    try {
      await VoiceDictationService.start();
      // Audio + haptic cue so blind users get the same "recording
      // started" feedback sighted users get from the pulsing red mic.
      // SemanticsService.sendAnnouncement reads the message via TalkBack/NVDA;
      // HapticFeedback gives a vibration on devices that support it.
      unawaited(
        SemanticsService.sendAnnouncement(
          view,
          strings.voiceDictateRecordingStarted,
          textDirection,
        ),
      );
      unawaited(HapticFeedback.lightImpact());
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
      }
      if (mounted) setState(() => _busy = false);
      return false;
    }
    if (!mounted) {
      await VoiceDictationService.cancel();
      return false;
    }
    return true;
  }

  Future<void> _finishRecordingAndTranscribe() async {
    final strings = AppStrings.of(context);
    final textDirection = Directionality.of(context);
    final view = View.of(context);
    // Show a brief "transcribing…" indicator while the upload is in flight.
    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => const _TranscribingDialog(),
      ),
    );
    try {
      // Announce that recording has ended and transcription is in
      // flight. Followed by the success/failure announcement once the
      // upload settles.
      if (mounted) {
        unawaited(
          SemanticsService.sendAnnouncement(
            view,
            strings.voiceDictateRecordingStopped,
            textDirection,
          ),
        );
        unawaited(HapticFeedback.selectionClick());
      }
      final transcript = await VoiceDictationService.stopAndTranscribe(
        patientUid: widget.patientUid,
        admissionId: widget.admissionId,
      );
      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).pop();
      final inserted = widget.onTranscript == null
          ? _appendTranscript(transcript)
          : await widget.onTranscript!(context, transcript);
      if (!mounted) return;
      unawaited(
        Telemetry.event('voice_dictation.completed', {
          'has_patient': widget.patientUid != null ? 'true' : 'false',
          'inserted': inserted ? 'true' : 'false',
          'transcript_chars': transcript.length.toString(),
        }),
      );
      if (inserted) {
        SuccessToast.show(
          context,
          AppStrings.of(context).voiceDictateAddedToast,
        );
      }
    } catch (e) {
      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).pop();
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _onPointerDown(PointerDownEvent event) {
    if (_busy || _disabledByConfig) return;
    if (event.kind != PointerDeviceKind.mouse &&
        event.kind != PointerDeviceKind.trackpad &&
        event.kind != PointerDeviceKind.stylus) {
      return;
    }
    _holdTimer?.cancel();
    _holdTimer = Timer(const Duration(milliseconds: 450), () {
      _suppressNextTap = true;
      unawaited(_startHoldRecording());
    });
  }

  void _onPointerUp(PointerUpEvent event) {
    _holdTimer?.cancel();
    if (_holdStarting && !_holdRecording) {
      _holdStopQueued = true;
      return;
    }
    if (_holdRecording || _holdStopQueued) {
      unawaited(_stopHoldRecording());
    }
  }

  void _onPointerCancel(PointerCancelEvent event) {
    _holdTimer?.cancel();
    if (_holdStarting && !_holdRecording) {
      _holdCancelQueued = true;
      return;
    }
    if (_holdRecording || _holdStopQueued) {
      unawaited(_cancelHoldRecording());
    }
  }

  Future<void> _startHoldRecording() async {
    if (_busy || _disabledByConfig) return;
    _holdStarting = true;
    final started = await _beginRecording();
    _holdStarting = false;
    if (!started) {
      _holdRecording = false;
      _holdStopQueued = false;
      _holdCancelQueued = false;
      return;
    }
    _holdRecording = true;
    if (_holdCancelQueued) {
      await _cancelHoldRecording();
      return;
    }
    if (_holdStopQueued) {
      await _stopHoldRecording();
    }
  }

  Future<void> _stopHoldRecording() async {
    if (_holdStarting && !_holdRecording) {
      _holdStopQueued = true;
      return;
    }
    if (!_holdRecording) {
      _holdStopQueued = true;
      return;
    }
    _holdRecording = false;
    _holdStopQueued = false;
    if (!mounted) {
      await VoiceDictationService.cancel();
      return;
    }
    await _finishRecordingAndTranscribe();
  }

  Future<void> _cancelHoldRecording() async {
    if (_holdStarting && !_holdRecording) {
      _holdCancelQueued = true;
      return;
    }
    _holdRecording = false;
    _holdStopQueued = false;
    _holdCancelQueued = false;
    await VoiceDictationService.cancel();
    if (mounted) setState(() => _busy = false);
  }

  bool _appendTranscript(String transcript) {
    final ctrl = widget.controller;
    final existing = ctrl.text;
    final glue = existing.isEmpty || existing.endsWith('\n') ? '' : ' ';
    ctrl.text = '$existing$glue$transcript';
    ctrl.selection = TextSelection.fromPosition(
      TextPosition(offset: ctrl.text.length),
    );
    return transcript.trim().isNotEmpty;
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final tooltip = _disabledByConfig
        ? strings.voiceDictateNotConfiguredTooltip
        : (widget.tooltip ?? strings.voiceDictateTooltip);
    return Listener(
      onPointerDown: _onPointerDown,
      onPointerUp: _onPointerUp,
      onPointerCancel: _onPointerCancel,
      child: IconButton(
        icon: _busy
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.mic_none),
        tooltip: tooltip,
        color: AppTheme.primaryBlue,
        onPressed: _busy || _disabledByConfig ? null : _start,
      ),
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
    final s = AppStrings.of(context);
    return AlertDialog(
      title: Text(s.voiceDictateRecording),
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
            s.voiceDictateHint,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(s.actionCancel),
        ),
        FilledButton.icon(
          onPressed: () => Navigator.of(context).pop(true),
          icon: const Icon(Icons.stop),
          label: Text(s.voiceDictateStop),
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
        children: [
          const SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 16),
          Text(AppStrings.of(context).voiceDictateTranscribing),
        ],
      ),
    );
  }
}
