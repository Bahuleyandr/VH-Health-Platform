import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/abdm_api_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class AbdmScreen extends StatefulWidget {
  const AbdmScreen({super.key, this.loadLinkage});

  /// Overrides the `/abdm/my-abha` fetch. Tests only — production passes null
  /// and the tab calls [AbdmApiService.getMyAbha].
  final Future<AbhaLinkage> Function()? loadLinkage;

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
                MyAbhaTab(loadLinkage: widget.loadLinkage),
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
  const MyAbhaTab({super.key, this.loadLinkage});

  final Future<AbhaLinkage> Function()? loadLinkage;

  @override
  State<MyAbhaTab> createState() => _MyAbhaTabState();
}

class _MyAbhaTabState extends State<MyAbhaTab> {
  // Starts true: the first frame is the spinner, never a momentary flash of the
  // "not registered" prompt before the status is known.
  bool _loading = true;
  String? _loadError;
  String? _abhaNumber;
  String? _abhaAddress;
  bool _showRegistration = false;
  bool _showOtpVerification = false;

  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _yearController = TextEditingController();
  final _emailController = TextEditingController();
  final _otpController = TextEditingController();
  String _gender = 'M';

  @override
  void dispose() {
    _nameController.dispose();
    _yearController.dispose();
    _emailController.dispose();
    _otpController.dispose();
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

  Future<void> _register() async {
    if (!_formKey.currentState!.validate()) return;

    final phone = context.read<UserProvider>().phone;
    setState(() => _loading = true);
    try {
      final result = await AbdmApiService.registerAbha(
        mobile: phone,
        name: _nameController.text.trim(),
        yearOfBirth: _yearController.text.trim(),
        gender: _gender,
        email: _emailController.text.trim().isEmpty
            ? null
            : _emailController.text.trim(),
      );
      if (!mounted) return;

      if (result['otpRequired'] == true) {
        setState(() {
          _abhaNumber = result['abhaNumber'] as String?;
          _showOtpVerification = true;
          _showRegistration = false;
        });
        _showSnackBar('OTP sent to your mobile number');
      } else {
        setState(() {
          _abhaNumber = result['abhaNumber'] as String?;
          _showRegistration = false;
        });
        _showSnackBar('ABHA registered successfully!');
      }
    } on AbdmException catch (e) {
      if (mounted) _showSnackBar(e.message, isError: true);
    } catch (e) {
      if (kDebugMode) debugPrint('ABDM register error: $e');
      if (mounted) _showSnackBar('Registration failed', isError: true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _verifyOtp() async {
    if (_otpController.text.trim().isEmpty || _abhaNumber == null) return;

    final phone = context.read<UserProvider>().phone;
    setState(() => _loading = true);
    try {
      await AbdmApiService.verifyAbha(
        abhaNumber: _abhaNumber!,
        otp: _otpController.text.trim(),
        mobile: phone,
      );
      if (!mounted) return;
      setState(() => _showOtpVerification = false);
      _showSnackBar('ABHA verified successfully!');
    } on AbdmException catch (e) {
      if (mounted) _showSnackBar(e.message, isError: true);
    } catch (e) {
      if (kDebugMode) debugPrint('ABDM verify error: $e');
      if (mounted) _showSnackBar('Verification failed', isError: true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _showSnackBar(String msg, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
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

    // OTP verification step
    if (_showOtpVerification) {
      return _buildOtpVerification(theme);
    }

    // Registration form
    if (_showRegistration) {
      return _buildRegistrationForm(theme);
    }

    // Already linked — show ABHA card (number, address, or both)
    if (_abhaNumber != null || _abhaAddress != null) {
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

  Widget _buildRegistrationForm(ThemeData theme) {
    final l = AppLocalizations.of(context)!;
    final phone = context.read<UserProvider>().phone;

    return SingleChildScrollView(
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
            const SizedBox(height: 16),
            TextFormField(
              initialValue: phone,
              readOnly: true,
              decoration: const InputDecoration(
                labelText: 'Mobile Number',
                prefixIcon: Icon(Icons.phone),
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _nameController,
              decoration: const InputDecoration(
                labelText: 'Full Name *',
                prefixIcon: Icon(Icons.person),
                border: OutlineInputBorder(),
              ),
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Name is required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _yearController,
              keyboardType: TextInputType.number,
              maxLength: 4,
              decoration: const InputDecoration(
                labelText: 'Year of Birth *',
                prefixIcon: Icon(Icons.calendar_today),
                border: OutlineInputBorder(),
                counterText: '',
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) return 'Year is required';
                final year = int.tryParse(v.trim());
                if (year == null || year < 1900 || year > DateTime.now().year) {
                  return 'Enter a valid year';
                }
                return null;
              },
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _gender,
              decoration: const InputDecoration(
                labelText: 'Gender *',
                prefixIcon: Icon(Icons.wc),
                border: OutlineInputBorder(),
              ),
              items: const [
                DropdownMenuItem(value: 'M', child: Text('Male')),
                DropdownMenuItem(value: 'F', child: Text('Female')),
                DropdownMenuItem(value: 'O', child: Text('Other')),
              ],
              onChanged: (v) {
                if (v != null) setState(() => _gender = v);
              },
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _emailController,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'Email (optional)',
                prefixIcon: Icon(Icons.email),
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
                    onPressed: _register,
                    child: const Text('Register'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildOtpVerification(ThemeData theme) {
    final l = AppLocalizations.of(context)!;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Icon(Icons.sms, size: 48, color: theme.colorScheme.primary),
          const SizedBox(height: 16),
          Text(
            l.abdmVerifyHeading,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            l.abdmEnterOtp,
            style: theme.textTheme.bodyMedium,
            textAlign: TextAlign.center,
          ),
          if (_abhaNumber != null) ...[
            const SizedBox(height: 8),
            Text(
              'ABHA: $_abhaNumber',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 24),
          TextField(
            controller: _otpController,
            keyboardType: TextInputType.number,
            maxLength: 6,
            textAlign: TextAlign.center,
            style: theme.textTheme.headlineSmall,
            decoration: const InputDecoration(
              labelText: 'OTP',
              border: OutlineInputBorder(),
              counterText: '',
            ),
          ),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => setState(() {
                    _showOtpVerification = false;
                    _showRegistration = true;
                  }),
                  child: const Text('Back'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: _verifyOtp,
                  child: const Text('Verify'),
                ),
              ),
            ],
          ),
        ],
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
          SnackBar(
            content: Text('Consent ${action.toLowerCase()}ed successfully'),
            behavior: SnackBarBehavior.floating,
          ),
        );
        _loadConsents();
      }
    } on AbdmException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.message),
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
