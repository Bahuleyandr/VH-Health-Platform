import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/outage/patient_mutation_policy.dart';
import 'package:vhhealth/core/outage/patient_outage_config.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class PatientOutageScope extends StatefulWidget {
  const PatientOutageScope({super.key, required this.child});

  final Widget child;

  @override
  State<PatientOutageScope> createState() => _PatientOutageScopeState();
}

class _PatientOutageScopeState extends State<PatientOutageScope> {
  late final PatientOutageController _controller;
  late final PatientOutageConfigStore _config;
  StreamSubscription<PatientBlockedMutation>? _blockedSubscription;
  PatientBlockedMutation? _blocked;

  @override
  void initState() {
    super.initState();
    _controller = PatientOutageController.instance;
    _config = PatientOutageConfigStore.instance;
    _blockedSubscription = _controller.blockedMutations.listen((event) {
      if (mounted) setState(() => _blocked = event);
    });
  }

  @override
  void dispose() {
    _blockedSubscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([_controller, _config]),
      builder: (context, _) {
        final showStatus = _controller.isOutage || _controller.isChecking;
        return Stack(
          children: [
            Column(
              children: [
                if (showStatus) _buildBannerBoundary(context),
                Expanded(child: widget.child),
              ],
            ),
            if (_blocked != null) _buildBlockedOverlay(context, _blocked!),
          ],
        );
      },
    );
  }

  Widget _buildBannerBoundary(BuildContext context) {
    final viewportHeight = MediaQuery.maybeSizeOf(context)?.height ?? 800;
    final maxHeight = (viewportHeight * 0.4).clamp(160.0, 320.0);

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: ClipRect(
        child: SingleChildScrollView(child: Builder(builder: _buildBanner)),
      ),
    );
  }

  Widget _buildBanner(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    final message = _message(context, l);
    final contact = _config.current?.facilityContactNumber;

    return SafeArea(
      bottom: false,
      child: Semantics(
        liveRegion: true,
        container: true,
        child: Material(
          color: colors.errorContainer,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(Icons.cloud_off, color: colors.onErrorContainer),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _controller.isChecking
                            ? l.patientOutageChecking
                            : l.patientOutageTitle,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          color: colors.onErrorContainer,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  message,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onErrorContainer,
                  ),
                ),
                const SizedBox(height: 4),
                Wrap(
                  spacing: 8,
                  children: [
                    TextButton.icon(
                      onPressed: () => unawaited(_controller.probeNow()),
                      icon: const Icon(Icons.refresh),
                      label: Text(l.patientOutageRetry),
                    ),
                    if (contact != null)
                      TextButton.icon(
                        onPressed: () => unawaited(_call(contact)),
                        icon: const Icon(Icons.call),
                        label: Text(l.patientOutageCallHospital),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBlockedOverlay(
    BuildContext context,
    PatientBlockedMutation blocked,
  ) {
    final l = AppLocalizations.of(context)!;
    final contact = _config.current?.facilityContactNumber;
    final prefix = blocked.category == PatientMutationCategory.emergency
        ? l.patientOutageEmergencyNotSent
        : l.patientOutageMutationNotSent;

    return Positioned.fill(
      child: Material(
        color: Colors.black54,
        child: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Card(
                margin: const EdgeInsets.all(24),
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              l.patientOutageDialogTitle,
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                          ),
                          IconButton(
                            onPressed: () => setState(() => _blocked = null),
                            tooltip: MaterialLocalizations.of(
                              context,
                            ).closeButtonTooltip,
                            icon: const Icon(Icons.close),
                          ),
                        ],
                      ),
                      Text(
                        prefix,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(_message(context, l)),
                      const SizedBox(height: 16),
                      if (contact != null)
                        FilledButton.icon(
                          onPressed: () => unawaited(_call(contact)),
                          icon: const Icon(Icons.call),
                          label: Text(l.patientOutageCallHospital),
                        )
                      else
                        Text(l.patientOutageContactUnavailable),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _message(BuildContext context, AppLocalizations l) {
    final languageCode = Localizations.localeOf(context).languageCode;
    final communication = _config.current;
    if (communication == null) {
      return l.patientOutageMessage(patientOutageFacilityContactToken);
    }
    final operatorMessage = communication.localizedMessage(languageCode);
    if (operatorMessage == null) {
      return l.patientOutageMessage(communication.facilityContactNumber);
    }
    return operatorMessage.replaceFirst(
      patientOutageFacilityContactToken,
      communication.facilityContactNumber,
    );
  }

  Future<void> _call(String contact) async {
    final dialable = contact.replaceAll(RegExp(r'[^0-9+]'), '');
    if (dialable.isEmpty) return;
    await launchUrl(Uri(scheme: 'tel', path: dialable));
  }
}
