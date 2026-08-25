import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/utils/safe_url_launcher.dart';

import 'package:vhhealth/core/services/abdm_api_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';
import 'package:vhhealth/features/abdm/widgets/abha_enrolment_flow.dart';

/// Links an EXISTING ABHA to the signed-in patient's account.
typedef LinkAbha = Future<void> Function({
  required String abhaNumber,
  String? abhaAddress,
});

class AbdmScreen extends StatefulWidget {
  const AbdmScreen({super.key, this.loadLinkage, this.linkAbha});

  /// Overrides the `/abdm/my-abha` fetch. Tests only — production passes null
  /// and the tab calls [AbdmApiService.getMyAbha].
  final Future<AbhaLinkage> Function()? loadLinkage;

  /// Overrides the ABHA link call. Tests only.
  final LinkAbha? linkAbha;

  @override
  State<AbdmScreen> createState() => _AbdmScreenState();
}

class _AbdmScreenState extends State<AbdmScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l.settingsHealthIdLabel,
      icon: Icons.health_and_safety,
      color: colors.primary,
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: colors.primary,
            unselectedLabelColor: colors.onSurfaceVariant,
            indicatorColor: colors.primary,
            tabs: const [
              Tab(icon: Icon(Icons.badge), text: 'My ABHA'),
              Tab(icon: Icon(Icons.handshake), text: 'Consent Requests'),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                MyAbhaTab(
                  loadLinkage: widget.loadLinkage,
                  linkAbha: widget.linkAbha,
                ),
                const _ConsentRequestsTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── My ABHA Tab ───

/// Public so widget tests can drive its states directly, without standing up
/// the whole screen (whose consent tab does its own network fetch).
@visibleForTesting
class MyAbhaTab extends StatefulWidget {
  const MyAbhaTab({super.key, this.loadLinkage, this.linkAbha});

  final Future<AbhaLinkage> Function()? loadLinkage;
  final LinkAbha? linkAbha;

  @override
  State<MyAbhaTab> createState() => _MyAbhaTabState();
}

class _MyAbhaTabState extends State<MyAbhaTab> {
  // Starts true: the first frame is the spinner, never a momentary flash of the
  // "not registered" prompt before the status is known.
  bool _loading = true;
  String? _loadError;
  bool? _linked;
  String? _abhaNumber;
  String? _abhaAddress;
  bool _showRegistration = false;
  bool _showEnrolment = false;

  final _formKey = GlobalKey<FormState>();
  final _abhaNumberController = TextEditingController();
  final _abhaAddressController = TextEditingController();

  @override
  void dispose() {
    _abhaNumberController.dispose();
    _abhaAddressController.dispose();
    super.dispose();
  }

  Future<void> _checkAbha() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final linkage = await (widget.loadLinkage ?? AbdmApiService.getMyAbha)();
      if (!mounted) return;
      setState(() {
        _linked = linkage.linked;
        _abhaNumber = linkage.abhaNumber;
        _abhaAddress = linkage.abhaAddress;
      });
    } on AbdmException catch (e) {
      // Surface the failure. Swallowing it would render the registration form,
      // which tells an already-linked patient to register a second ABHA.
      if (mounted) setState(() => _loadError = e.message);
    } catch (e) {
      if (kDebugMode) debugPrint('ABDM check error: $e');
      if (mounted) {
        setState(
          () => _loadError =
              'Could not check your ABHA status. Please try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void initState() {
    super.initState();
    _checkAbha();
  }

  Future<void> _linkAbha() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _loading = true);
    try {
      await (widget.linkAbha ?? AbdmApiService.linkAbha)(
        abhaNumber: _normalisedAbhaNumber(_abhaNumberController.text),
        abhaAddress: _abhaAddressController.text.trim().isEmpty
            ? null
            : _abhaAddressController.text.trim(),
      );
      if (!mounted) return;
      setState(() => _showRegistration = false);
      _showSnackBar('ABHA linked to your account');
      // Re-read the canonical linkage rather than trusting what we posted, so
      // the card always reflects what the server actually stored. A failure
      // here lands in the error+retry state; the link itself already succeeded.
      await _checkAbha();
    } on AbdmException catch (e) {
      if (mounted) _showSnackBar(e.message, isError: true);
    } catch (e) {
      if (kDebugMode) debugPrint('ABDM link error: $e');
      if (mounted) {
        _showSnackBar('Could not link your ABHA', isError: true);
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// ABHA numbers are shown as 12-3456-7890-1234 but stored as 14 digits.
  static String _normalisedAbhaNumber(String raw) =>
      raw.replaceAll(RegExp(r'[\s-]'), '');

  Future<void> _openAbhaPortal() async {
    await SafeUrlLauncher.launch(
      'https://abha.abdm.gov.in',
      mode: LaunchMode.externalApplication,
    );
  }

  void _showSnackBar(String msg, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      LiveRegionSnackBar.build(
        message: msg,
        backgroundColor: isError ? Theme.of(context).colorScheme.error : null,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_loading) {
      return const Center(
        key: ValueKey('abha_loading'),
        child: CircularProgressIndicator(),
      );
    }

    // Status unknown — say so and offer a retry, rather than guessing "unlinked"
    if (_loadError != null) {
      return _buildErrorState(theme);
    }

    // Aadhaar-OTP self-enrolment for a NEW ABHA (P13/#809 Flutter half).
    if (_showEnrolment) {
      return AbhaEnrolmentFlow(
        onEnrolled: () {
          setState(() => _showEnrolment = false);
          _checkAbha();
        },
        onCancelled: () => setState(() => _showEnrolment = false),
      );
    }

    // Link-an-existing-ABHA form
    if (_showRegistration) {
      return _buildLinkForm(theme);
    }

    // The server's linkage verdict is authoritative. The response parser
    // rejects a verdict that disagrees with the returned details.
    if (_linked == true) {
      return _buildAbhaCard(theme);
    }

    // Not linked — show info + register button
    return _buildInfoCard(theme);
  }

  Widget _buildErrorState(ThemeData theme) {
    return SingleChildScrollView(
      key: const ValueKey('abha_error'),
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Icon(Icons.cloud_off, size: 64, color: theme.colorScheme.error),
          const SizedBox(height: 16),
          Text(
            'Could not check your ABHA status',
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.bold,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            _loadError!,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            "We can't tell whether you already have an ABHA linked, so "
            'registration is hidden until this loads.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          FilledButton.icon(
            key: const ValueKey('abha_retry'),
            onPressed: _checkAbha,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ],
      ),
    );
  }

  Widget _buildInfoCard(ThemeData theme) {
    final l = AppLocalizations.of(context)!;
    return SingleChildScrollView(
      key: const ValueKey('abha_info'),
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Icon(
            Icons.health_and_safety,
            size: 64,
            color: theme.colorScheme.primary,
          ),
          const SizedBox(height: 16),
          Text(
            l.abdmHeading,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.bold,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 12),
          Text(
            l.abdmDescription,
            style: theme.textTheme.bodyMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            l.abdmDataSecurityNote,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: () => setState(() => _showRegistration = true),
            icon: const Icon(Icons.app_registration),
            label: Text(l.abdmRegister),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const ValueKey('abha_enrol_entry'),
            onPressed: () => setState(() => _showEnrolment = true),
            icon: const Icon(Icons.fingerprint),
            label: Text(l.abdmCreateAbhaCta),
          ),
        ],
      ),
    );
  }

  Widget _buildAbhaCard(ThemeData theme) {
    final l = AppLocalizations.of(context)!;
    final abhaNumber = _abhaNumber;
    final abhaAddress = _abhaAddress;
    return SingleChildScrollView(
      key: const ValueKey('abha_card'),
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Icon(Icons.verified, size: 64, color: theme.colorScheme.primary),
          const SizedBox(height: 16),
          if (abhaNumber != null) ...[
            Text(l.abdmYourNumber, style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Expanded(
                      child: Text(
                        abhaNumber,
                        style: theme.textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.bold,
                          letterSpacing: 1.2,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.copy),
                      tooltip: 'Copy ABHA Number',
                      onPressed: () {
                        // PAT-9: Copy the ABHA number and schedule a clipboard
                        // clear after 30 s so PHI does not linger in the
                        // clipboard indefinitely (pastes into other apps, etc.).
                        Clipboard.setData(ClipboardData(text: abhaNumber));
                        _showSnackBar(
                          'ABHA number copied — clipboard clears in 30 s',
                        );
                        Timer(const Duration(seconds: 30), () {
                          Clipboard.setData(const ClipboardData(text: ''));
                        });
                      },
                    ),
                  ],
                ),
              ),
            ),
          ],
          if (abhaAddress != null) ...[
            const SizedBox(height: 16),
            Text('ABHA Address', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              abhaAddress,
              style: theme.textTheme.bodyLarge?.copyWith(
                fontWeight: FontWeight.w600,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildLinkForm(ThemeData theme) {
    final l = AppLocalizations.of(context)!;

    return SingleChildScrollView(
      key: const ValueKey('abha_link_form'),
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l.abdmRegister,
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Enter the ABHA you already have. This links it to your hospital '
              'record — it does not create a new ABHA.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _abhaNumberController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'ABHA Number *',
                hintText: '12-3456-7890-1234',
                prefixIcon: Icon(Icons.badge),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                final digits = _normalisedAbhaNumber(v ?? '');
                if (digits.isEmpty) return 'ABHA number is required';
                if (!RegExp(r'^\d{14}$').hasMatch(digits)) {
                  return 'ABHA number must be 14 digits';
                }
                return null;
              },
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _abhaAddressController,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'ABHA Address (optional)',
                hintText: 'yourname@abdm',
                prefixIcon: Icon(Icons.alternate_email),
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => setState(() => _showRegistration = false),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    key: const ValueKey('abha_link_submit'),
                    onPressed: _linkAbha,
                    child: const Text('Link ABHA'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            const Divider(),
            const SizedBox(height: 8),
            Text(
              "Don't have an ABHA yet?",
              style: theme.textTheme.bodyMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 4),
            TextButton.icon(
              key: const ValueKey('abha_create_portal'),
              onPressed: _openAbhaPortal,
              icon: const Icon(Icons.open_in_new),
              label: const Text('Create one at abha.abdm.gov.in'),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Consent Requests Tab ───

class _ConsentRequestsTab extends StatefulWidget {
  const _ConsentRequestsTab();

  @override
  State<_ConsentRequestsTab> createState() => _ConsentRequestsTabState();
}

class _ConsentRequestsTabState extends State<_ConsentRequestsTab> {
  bool _loading = true;
  List<dynamic> _consents = [];

  @override
  void initState() {
    super.initState();
    _loadConsents();
  }

  Future<void> _loadConsents() async {
    setState(() => _loading = true);
    try {
      _consents = await AbdmApiService.getConsents();
    } catch (e) {
      if (kDebugMode) debugPrint('ABDM loadConsents error: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _confirmAction(
    String action,
    String consentId,
    Future<void> Function(String) apiCall,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('$action Consent?'),
        content: Text(
          'Are you sure you want to ${action.toLowerCase()} this consent request?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(action),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    try {
      await apiCall(consentId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: 'Consent ${action.toLowerCase()}ed successfully',
            behavior: SnackBarBehavior.floating,
          ),
        );
        unawaited(_loadConsents());
      }
    } on AbdmException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: e.message,
            backgroundColor: Theme.of(context).colorScheme.error,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  Color _statusColor(String status, ColorScheme colors) {
    switch (status.toUpperCase()) {
      case 'REQUESTED':
        return colors.primary;
      case 'GRANTED':
        return colors.tertiary;
      case 'DENIED':
        return colors.error;
      case 'EXPIRED':
      case 'REVOKED':
        return colors.onSurfaceVariant;
      default:
        return colors.onSurfaceVariant;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;

    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_consents.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.handshake_outlined,
              size: 48,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 12),
            Text(
              AppLocalizations.of(context)!.abdmNoConsents,
              style: theme.textTheme.bodyLarge?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: _loadConsents,
              icon: const Icon(Icons.refresh),
              label: const Text('Refresh'),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadConsents,
      child: ListView.builder(
        padding: const EdgeInsets.all(8),
        itemCount: _consents.length,
        itemBuilder: (context, index) {
          final consent = _consents[index] as Map<String, dynamic>;
          final status = (consent['status'] as String?) ?? 'UNKNOWN';
          final purpose =
              (consent['purpose'] as String?) ?? 'Health data access';
          final requester = (consent['requester'] as String?) ?? 'Unknown';
          final dateFrom = consent['dateFrom'] as String?;
          final dateTo = consent['dateTo'] as String?;
          final id = consent['id']?.toString() ?? '';

          return Card(
            margin: const EdgeInsets.symmetric(vertical: 4),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          purpose,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Chip(
                        label: Text(
                          status,
                          style: TextStyle(
                            color: _statusColor(status, colors),
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        backgroundColor: _statusColor(
                          status,
                          colors,
                        ).withAlpha(26),
                        side: BorderSide(
                          color: _statusColor(status, colors).withAlpha(76),
                        ),
                        padding: EdgeInsets.zero,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Requested by: $requester',
                    style: theme.textTheme.bodySmall,
                  ),
                  if (dateFrom != null || dateTo != null)
                    Text(
                      'Period: ${dateFrom ?? '?'} — ${dateTo ?? '?'}',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  if (status.toUpperCase() == 'REQUESTED') ...[
                    const SizedBox(height: 12),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        OutlinedButton(
                          onPressed: () => _confirmAction(
                            'Deny',
                            id,
                            AbdmApiService.denyConsent,
                          ),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: colors.error,
                          ),
                          child: const Text('Deny'),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: () => _confirmAction(
                            'Grant',
                            id,
                            AbdmApiService.grantConsent,
                          ),
                          child: const Text('Grant'),
                        ),
                      ],
                    ),
                  ],
                  if (status.toUpperCase() == 'GRANTED') ...[
                    const SizedBox(height: 12),
                    Align(
                      alignment: Alignment.centerRight,
                      child: OutlinedButton(
                        onPressed: () => _confirmAction(
                          'Revoke',
                          id,
                          AbdmApiService.revokeConsent,
                        ),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: colors.error,
                        ),
                        child: const Text('Revoke'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
