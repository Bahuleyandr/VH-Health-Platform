import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_route_args.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_device_service.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_room_client.dart';
import 'package:vhhealth/features/teleconsult/widgets/teleconsult_status_panel.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class TeleconsultLobbyScreen extends StatefulWidget {
  const TeleconsultLobbyScreen({
    super.key,
    required this.appointment,
    this.initialState,
    this.repository = const TeleconsultRepository(),
    this.deviceService = const PermissionHandlerTeleconsultDeviceService(),
    this.roomClient = const LiveKitTeleconsultRoomClient(),
  });

  final AppointmentInfo appointment;
  final TeleconsultLobbyState? initialState;
  final TeleconsultRepository repository;
  final TeleconsultDeviceService deviceService;
  final TeleconsultRoomClient roomClient;

  @override
  State<TeleconsultLobbyScreen> createState() => _TeleconsultLobbyScreenState();
}

class _TeleconsultLobbyScreenState extends State<TeleconsultLobbyScreen> {
  TeleconsultLobbyState? _state;
  TeleconsultDeviceReadiness? _readiness;
  bool _loading = false;
  bool _checkingDevices = false;
  bool _submitting = false;
  String? _error;

  bool _identityConfirmed = false;
  bool _remoteConsultConsent = false;
  bool _degradationAcknowledged = false;
  bool _emergencyAcknowledged = false;
  bool _recordingOffAcknowledged = false;

  @override
  void initState() {
    super.initState();
    _state = widget.initialState;
    if (_state == null) {
      unawaited(_refreshLobbyState());
    } else {
      if (_state!.joinable) unawaited(_checkDevices());
      unawaited(_refreshLobbyState(showSpinner: false));
    }
  }

  Future<void> _refreshLobbyState({bool showSpinner = true}) async {
    if (showSpinner) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final state = await widget.repository.fetchLobbyState(
        widget.appointment.id,
      );
      if (!mounted) return;
      setState(() {
        _state = state;
        _loading = false;
      });
      if (state.joinable && _readiness == null) {
        unawaited(_checkDevices());
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _checkDevices() async {
    if (_checkingDevices) return;
    setState(() {
      _checkingDevices = true;
      _error = null;
    });
    try {
      final readiness = await widget.deviceService.checkReadiness();
      if (!mounted) return;
      setState(() {
        _readiness = readiness;
        _checkingDevices = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _checkingDevices = false;
        _readiness = const TeleconsultDeviceReadiness(
          kind: TeleconsultReadinessKind.unavailable,
          cameraGranted: false,
          microphoneGranted: false,
        );
      });
    }
  }

  TeleconsultConsentPayload get _consentPayload => TeleconsultConsentPayload(
    identityConfirmed: _identityConfirmed,
    remoteConsultConsent: _remoteConsultConsent,
    degradationAcknowledged: _degradationAcknowledged,
    emergencyLimitationsAcknowledged: _emergencyAcknowledged,
    recordingOffAcknowledged: _recordingOffAcknowledged,
  );

  Future<void> _continueToCall() async {
    final l = AppLocalizations.of(context)!;
    final state = _state;
    final readiness = _readiness;
    if (state?.canRequestConsent != true) return;
    if (readiness?.canContinue != true) {
      setState(() => _error = l.teleconsultDeviceRequired);
      return;
    }
    final payload = _consentPayload;
    if (!payload.isComplete) {
      setState(() => _error = l.teleconsultConsentRequired);
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final updated = await widget.repository.submitConsent(
        teleconsultationId: state!.teleconsultationId!,
        payload: payload,
      );
      if (!mounted) return;
      setState(() {
        _state = updated;
        _submitting = false;
      });
      unawaited(
        context.push(
          '/teleconsult/appointments/${widget.appointment.id}/consult',
          extra: TeleconsultConsultArgs(
            appointment: widget.appointment,
            lobbyState: updated,
            readiness: readiness!,
            repository: widget.repository,
            deviceService: widget.deviceService,
            roomClient: widget.roomClient,
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = l.teleconsultConsentFailed;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final color = Theme.of(context).colorScheme.primary;
    return FeatureScreenScaffold(
      title: l.teleconsultLobbyTitle,
      icon: Icons.video_call_outlined,
      color: color,
      scrollable: true,
      actions: [
        IconButton(
          tooltip: l.teleconsultRefresh,
          onPressed: _loading ? null : _refreshLobbyState,
          icon: const Icon(Icons.refresh_outlined),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            widget.appointment.doctorName,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 4),
          Text('${widget.appointment.date} • ${widget.appointment.time}'),
          const SizedBox(height: 16),
          if (_loading)
            const Center(child: CircularProgressIndicator())
          else
            TeleconsultStatusPanel(state: _state),
          if (_error != null) ...[
            const SizedBox(height: 12),
            _InlineError(message: _error!),
          ],
          const SizedBox(height: 16),
          _DeviceReadinessCard(
            readiness: _readiness,
            checking: _checkingDevices,
            onCheck: _state?.joinable == true ? _checkDevices : null,
          ),
          const SizedBox(height: 16),
          _ConsentCard(
            enabled: _state?.canRequestConsent == true,
            identityConfirmed: _identityConfirmed,
            remoteConsultConsent: _remoteConsultConsent,
            degradationAcknowledged: _degradationAcknowledged,
            emergencyAcknowledged: _emergencyAcknowledged,
            recordingOffAcknowledged: _recordingOffAcknowledged,
            onIdentityChanged: (value) =>
                setState(() => _identityConfirmed = value),
            onRemoteConsultChanged: (value) =>
                setState(() => _remoteConsultConsent = value),
            onDegradationChanged: (value) =>
                setState(() => _degradationAcknowledged = value),
            onEmergencyChanged: (value) =>
                setState(() => _emergencyAcknowledged = value),
            onRecordingOffChanged: (value) =>
                setState(() => _recordingOffAcknowledged = value),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed:
                _submitting ||
                    _state?.canRequestConsent != true ||
                    _readiness?.canContinue != true
                ? null
                : _continueToCall,
            icon: _submitting
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.video_call_outlined),
            label: Text(l.teleconsultContinueToCall),
          ),
        ],
      ),
    );
  }
}

class _DeviceReadinessCard extends StatelessWidget {
  const _DeviceReadinessCard({
    required this.readiness,
    required this.checking,
    required this.onCheck,
  });

  final TeleconsultDeviceReadiness? readiness;
  final bool checking;
  final VoidCallback? onCheck;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final text = switch (readiness?.kind) {
      TeleconsultReadinessKind.videoReady => l.teleconsultDeviceVideoReady,
      TeleconsultReadinessKind.audioOnlyRecommended =>
        l.teleconsultDeviceAudioOnly,
      TeleconsultReadinessKind.unavailable => l.teleconsultDeviceUnavailable,
      null => l.teleconsultDeviceNotChecked,
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Icon(
              readiness?.canContinue == true
                  ? Icons.check_circle_outline
                  : Icons.perm_device_information_outlined,
              color: readiness?.canContinue == true
                  ? theme.colorScheme.primary
                  : theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 10),
            Expanded(child: Text(text)),
            TextButton.icon(
              onPressed: checking ? null : onCheck,
              icon: checking
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.settings_input_component_outlined),
              label: Text(
                checking
                    ? l.teleconsultCheckingDevices
                    : l.teleconsultCheckDevices,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ConsentCard extends StatelessWidget {
  const _ConsentCard({
    required this.enabled,
    required this.identityConfirmed,
    required this.remoteConsultConsent,
    required this.degradationAcknowledged,
    required this.emergencyAcknowledged,
    required this.recordingOffAcknowledged,
    required this.onIdentityChanged,
    required this.onRemoteConsultChanged,
    required this.onDegradationChanged,
    required this.onEmergencyChanged,
    required this.onRecordingOffChanged,
  });

  final bool enabled;
  final bool identityConfirmed;
  final bool remoteConsultConsent;
  final bool degradationAcknowledged;
  final bool emergencyAcknowledged;
  final bool recordingOffAcknowledged;
  final ValueChanged<bool> onIdentityChanged;
  final ValueChanged<bool> onRemoteConsultChanged;
  final ValueChanged<bool> onDegradationChanged;
  final ValueChanged<bool> onEmergencyChanged;
  final ValueChanged<bool> onRecordingOffChanged;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
              child: Text(
                l.teleconsultConsentTitle,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
            _ConsentCheckbox(
              enabled: enabled,
              value: identityConfirmed,
              label: l.teleconsultConsentIdentity,
              onChanged: onIdentityChanged,
            ),
            _ConsentCheckbox(
              enabled: enabled,
              value: remoteConsultConsent,
              label: l.teleconsultConsentRemote,
              onChanged: onRemoteConsultChanged,
            ),
            _ConsentCheckbox(
              enabled: enabled,
              value: degradationAcknowledged,
              label: l.teleconsultConsentDegradation,
              onChanged: onDegradationChanged,
            ),
            _ConsentCheckbox(
              enabled: enabled,
              value: emergencyAcknowledged,
              label: l.teleconsultConsentEmergency,
              onChanged: onEmergencyChanged,
            ),
            _ConsentCheckbox(
              enabled: enabled,
              value: recordingOffAcknowledged,
              label: l.teleconsultConsentRecordingOff,
              onChanged: onRecordingOffChanged,
            ),
          ],
        ),
      ),
    );
  }
}

class _ConsentCheckbox extends StatelessWidget {
  const _ConsentCheckbox({
    required this.enabled,
    required this.value,
    required this.label,
    required this.onChanged,
  });

  final bool enabled;
  final bool value;
  final String label;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return CheckboxListTile(
      value: value,
      onChanged: enabled ? (value) => onChanged(value ?? false) : null,
      controlAffinity: ListTileControlAffinity.leading,
      contentPadding: EdgeInsets.zero,
      title: Text(label),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(message, style: TextStyle(color: scheme.onErrorContainer)),
    );
  }
}
