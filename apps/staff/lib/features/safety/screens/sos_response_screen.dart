import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/services/sos_responder_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

/// HIGH-1 — SOS responder surface. The backend responder endpoints
/// (dashboard/analytics/respond/resolve) existed with zero clients, so alerts
/// raised by the patient app were visible only on the nav-orphaned admin
/// console and nobody could perform the workflow the admin ack/resolve
/// latency tiles measure.
///
/// Data source is the responder dashboard list (durable `sos_alerts` rows,
/// severity-first then oldest-first). The EMERGENCY push deep-links to
/// `/sos-response/:alertId`; the detail screen re-fetches the list and picks
/// the alert so a stale notification lands on an honest "no longer active"
/// state instead of stale data.

@visibleForTesting
Color sosSeverityColor(String severity) => switch (severity.toUpperCase()) {
  'CRITICAL' => AppTheme.errorOnSurface,
  'HIGH' => AppTheme.warningOnSurface,
  'MEDIUM' => AppTheme.primaryBlue,
  _ => AppTheme.textSecondary,
};

@visibleForTesting
String sosAlertAgeLabel(Object? raisedAt, {DateTime? now}) {
  final parsed = DateTime.tryParse(raisedAt?.toString() ?? '');
  if (parsed == null) return '';
  final minutes = (now ?? DateTime.now())
      .difference(parsed.toLocal())
      .inMinutes;
  if (minutes < 1) return 'now';
  if (minutes < 60) return '${minutes}m';
  return '${minutes ~/ 60}h ${minutes % 60}m';
}

class SosResponseScreen extends StatefulWidget {
  /// When non-null the screen opens focused on one alert (push deep-link).
  final int? focusAlertId;

  const SosResponseScreen({super.key, this.focusAlertId});

  @override
  State<SosResponseScreen> createState() => _SosResponseScreenState();
}

class _SosResponseScreenState extends State<SosResponseScreen> {
  final _dateFmt = DateFormat('dd MMM, HH:mm');
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _alerts = const [];
  Map<String, dynamic> _analytics = const {};

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
      final results = await Future.wait<Object?>([
        SosResponderApiService.listActiveAlerts(),
        SosResponderApiService.getMyAnalytics().catchError(
          (_) => <String, dynamic>{},
        ),
      ]);
      if (!mounted) return;
      setState(() {
        _alerts = (results[0] as List).whereType<Map<String, dynamic>>().toList();
        _analytics = results[1] is Map<String, dynamic>
            ? results[1] as Map<String, dynamic>
            : const {};
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  int? _id(Map<String, dynamic> alert) => int.tryParse(_text(alert['id']));

  Future<void> _respond(Map<String, dynamic> alert) async {
    final s = AppStrings.of(context);
    final id = _id(alert);
    if (id == null) return;
    final message = await _promptText(
      title: s.lookup('sos.respond_title'),
      hint: s.lookup('sos.respond_hint'),
      confirmLabel: s.lookup('sos.respond_confirm'),
      required: true,
    );
    if (message == null || !mounted) return;
    await _perform(
      () => SosResponderApiService.respond(alertId: id, responseMessage: message),
      s.lookup('sos.respond_done'),
    );
  }

  Future<void> _resolve(Map<String, dynamic> alert) async {
    final s = AppStrings.of(context);
    final id = _id(alert);
    if (id == null) return;
    final notes = await _promptText(
      title: s.lookup('sos.resolve_title'),
      hint: s.lookup('sos.resolve_hint'),
      confirmLabel: s.lookup('sos.resolve_confirm'),
      required: false,
    );
    if (notes == null || !mounted) return;
    await _perform(
      () => SosResponderApiService.resolve(
        alertId: id,
        resolutionNotes: notes.isEmpty ? null : notes,
      ),
      s.lookup('sos.resolve_done'),
    );
  }

  Future<void> _perform(
    Future<Map<String, dynamic>> Function() action,
    String successMessage,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await action();
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(successMessage)));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: AppTheme.errorOnSurface,
        ),
      );
    }
    await _load();
  }

  /// Returns null on cancel; empty string means "confirmed without text"
  /// (only reachable when [required] is false).
  Future<String?> _promptText({
    required String title,
    required String hint,
    required String confirmLabel,
    required bool required,
  }) {
    return showDialog<String>(
      context: context,
      builder: (ctx) => _SosPromptDialog(
        title: title,
        hint: hint,
        confirmLabel: confirmLabel,
        required: required,
      ),
    );
  }

  Future<void> _call(Map<String, dynamic> alert) async {
    final phone = _text(alert['phone']);
    if (phone.isEmpty) return;
    final uri = Uri.parse('tel:$phone');
    if (await canLaunchUrl(uri)) await launchUrl(uri);
  }

  Future<void> _openMap(Map<String, dynamic> alert) async {
    final lat = double.tryParse(_text(alert['latitude']));
    final lng = double.tryParse(_text(alert['longitude']));
    if (lat == null || lng == null) return;
    final uri = Uri.parse('https://maps.google.com/?q=$lat,$lng');
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);

    final focusId = widget.focusAlertId;
    final focused = focusId == null
        ? null
        : _alerts.where((alert) => _id(alert) == focusId).toList();

    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('sos.title')),
        actions: [
          IconButton(
            tooltip: s.actionRefresh,
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? _ErrorState(message: _error!, onRetry: _load)
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
                children: [
                  if (focusId != null && (focused == null || focused.isEmpty))
                    Container(
                      margin: const EdgeInsets.only(bottom: 12),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppTheme.cardSurface,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AppTheme.divider),
                      ),
                      child: Text(
                        s.lookup('sos.alert_not_active'),
                        style: theme.textTheme.bodyMedium,
                      ),
                    ),
                  _buildAnalytics(theme, s),
                  const SizedBox(height: 14),
                  if (_alerts.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 32),
                      child: Center(
                        child: Text(
                          s.lookup('sos.empty'),
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    )
                  else
                    ..._alerts.map(
                      (alert) => _AlertCard(
                        alert: alert,
                        dateFmt: _dateFmt,
                        highlighted: focusId != null && _id(alert) == focusId,
                        onRespond: () => _respond(alert),
                        onResolve: () => _resolve(alert),
                        onCall: () => _call(alert),
                        onMap: () => _openMap(alert),
                      ),
                    ),
                ],
              ),
            ),
    );
  }

  Widget _buildAnalytics(ThemeData theme, AppStrings s) {
    final total = _text(_analytics['total_responded'], '0');
    final resolved = _text(_analytics['resolved_count'], '0');
    final avgSeconds = int.tryParse(_text(_analytics['avg_response_seconds']));
    final avgLabel = avgSeconds == null
        ? '—'
        : avgSeconds < 60
        ? '${avgSeconds}s'
        : '${avgSeconds ~/ 60}m ${avgSeconds % 60}s';
    Widget metric(String label, String value) => Expanded(
      child: Container(
        constraints: const BoxConstraints(minHeight: 72),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              value,
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
            Text(
              label,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
    return Row(
      children: [
        metric(s.lookup('sos.metric_responded'), total),
        const SizedBox(width: 10),
        metric(s.lookup('sos.metric_resolved'), resolved),
        const SizedBox(width: 10),
        metric(s.lookup('sos.metric_avg_response'), avgLabel),
      ],
    );
  }
}

/// Owns its [TextEditingController] so disposal follows the dialog's own
/// widget lifecycle (a whenComplete-dispose races the exit transition).
class _SosPromptDialog extends StatefulWidget {
  final String title;
  final String hint;
  final String confirmLabel;
  final bool required;

  const _SosPromptDialog({
    required this.title,
    required this.hint,
    required this.confirmLabel,
    required this.required,
  });

  @override
  State<_SosPromptDialog> createState() => _SosPromptDialogState();
}

class _SosPromptDialogState extends State<_SosPromptDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLines: 3,
        maxLength: 500,
        decoration: InputDecoration(hintText: widget.hint),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          onPressed: () {
            final value = _controller.text.trim();
            if (widget.required && value.isEmpty) return;
            Navigator.of(context).pop(value);
          },
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}

class _AlertCard extends StatelessWidget {
  final Map<String, dynamic> alert;
  final DateFormat dateFmt;
  final bool highlighted;
  final VoidCallback onRespond;
  final VoidCallback onResolve;
  final VoidCallback onCall;
  final VoidCallback onMap;

  const _AlertCard({
    required this.alert,
    required this.dateFmt,
    required this.highlighted,
    required this.onRespond,
    required this.onResolve,
    required this.onCall,
    required this.onMap,
  });

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    final severity = _text(alert['severity'], 'HIGH').toUpperCase();
    final status = _text(alert['status'], 'ACTIVE').toUpperCase();
    final active = status == 'ACTIVE';
    final color = sosSeverityColor(severity);
    final raised = DateTime.tryParse(_text(alert['raised_at']));
    final hasLocation =
        double.tryParse(_text(alert['latitude'])) != null &&
        double.tryParse(_text(alert['longitude'])) != null;
    final responseMessage = _text(alert['response_message']);

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: highlighted ? color : AppTheme.divider,
          width: highlighted ? 2 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(Icons.sos, color: color),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '#${_text(alert['id'])} - ${_text(alert['phone'], s.lookup('sos.unknown_caller'))}',
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      [
                        severity,
                        _text(alert['alert_type']),
                        if (raised != null) dateFmt.format(raised.toLocal()),
                        if (raised != null)
                          '${s.lookup('sos.age_prefix')} ${sosAlertAgeLabel(alert['raised_at'])}',
                      ].where((part) => part.isNotEmpty).join(' - '),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 4,
                ),
                decoration: BoxDecoration(
                  color: (active ? AppTheme.errorOnSurface : AppTheme.primaryTeal)
                      .withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  active
                      ? s.lookup('sos.status_active')
                      : s.lookup('sos.status_responding'),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: active
                        ? AppTheme.errorOnSurface
                        : AppTheme.primaryTeal,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
          if (_text(alert['message']).isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(_text(alert['message']), style: theme.textTheme.bodyMedium),
          ],
          if (responseMessage.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              '${s.lookup('sos.response_prefix')}: $responseMessage',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (active)
                FilledButton.icon(
                  onPressed: onRespond,
                  icon: const Icon(Icons.directions_run, size: 16),
                  label: Text(s.lookup('sos.action_respond')),
                ),
              FilledButton.tonalIcon(
                onPressed: onResolve,
                icon: const Icon(Icons.task_alt, size: 16),
                label: Text(s.lookup('sos.action_resolve')),
              ),
              if (_text(alert['phone']).isNotEmpty)
                TextButton.icon(
                  onPressed: onCall,
                  icon: const Icon(Icons.call, size: 16),
                  label: Text(s.lookup('sos.action_call')),
                ),
              if (hasLocation)
                TextButton.icon(
                  onPressed: onMap,
                  icon: const Icon(Icons.map_outlined, size: 16),
                  label: Text(s.lookup('sos.action_map')),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: Text(s.safetyCenterRetry),
            ),
          ],
        ),
      ),
    );
  }
}
