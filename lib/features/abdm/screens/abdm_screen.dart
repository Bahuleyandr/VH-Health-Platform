import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/abdm_api_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class AbdmScreen extends StatefulWidget {
  const AbdmScreen({super.key});

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
    return FeatureScreenScaffold(
      title: 'Health ID (ABHA)',
      icon: Icons.health_and_safety,
      color: const Color(0xFF26A69A),
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: const Color(0xFF26A69A),
            unselectedLabelColor: Colors.grey,
            indicatorColor: const Color(0xFF26A69A),
            tabs: const [
              Tab(icon: Icon(Icons.badge), text: 'My ABHA'),
              Tab(icon: Icon(Icons.handshake), text: 'Consent Requests'),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: const [
                _MyAbhaTab(),
                _ConsentRequestsTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── My ABHA Tab ───

class _MyAbhaTab extends StatefulWidget {
  const _MyAbhaTab();

  @override
  State<_MyAbhaTab> createState() => _MyAbhaTabState();
}

class _MyAbhaTabState extends State<_MyAbhaTab> {
  bool _loading = false;
  String? _abhaNumber;
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
    final phone = context.read<UserProvider>().phone;
    if (phone.isEmpty) return;

    setState(() => _loading = true);
    try {
      final result = await AbdmApiService.getPatientByAbha(phone);
      if (!mounted) return;
      if (result != null && result['abhaNumber'] != null) {
        setState(() => _abhaNumber = result['abhaNumber'] as String);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('ABDM check error: $e');
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
        backgroundColor: isError ? Colors.red : null,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    // OTP verification step
    if (_showOtpVerification) {
      return _buildOtpVerification(theme);
    }

    // Registration form
    if (_showRegistration) {
      return _buildRegistrationForm(theme);
    }

    // Already registered — show ABHA card
    if (_abhaNumber != null) {
      return _buildAbhaCard(theme);
    }

    // Not registered — show info + register button
    return _buildInfoCard(theme);
  }

  Widget _buildInfoCard(ThemeData theme) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Icon(Icons.health_and_safety, size: 64, color: theme.colorScheme.primary),
          const SizedBox(height: 16),
          Text(
            'Ayushman Bharat Health Account',
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.bold,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 12),
          Text(
            'ABHA (Ayushman Bharat Health Account) is a unique health ID '
            'that allows you to share your health records digitally with '
            'healthcare providers across India. It enables seamless, '
            'consent-based access to your medical history.',
            style: theme.textTheme.bodyMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            'Your data stays secure and is shared only with your consent.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: () => setState(() => _showRegistration = true),
            icon: const Icon(Icons.app_registration),
            label: const Text('Register ABHA'),
          ),
        ],
      ),
    );
  }

  Widget _buildAbhaCard(ThemeData theme) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Icon(Icons.verified, size: 64, color: theme.colorScheme.primary),
          const SizedBox(height: 16),
          Text(
            'Your ABHA Number',
            style: theme.textTheme.titleMedium,
          ),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Expanded(
                    child: Text(
                      _abhaNumber!,
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
                      Clipboard.setData(ClipboardData(text: _abhaNumber!));
                      _showSnackBar('ABHA number copied');
                    },
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildRegistrationForm(ThemeData theme) {
    final phone = context.read<UserProvider>().phone;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Register ABHA',
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
              value: _gender,
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
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Icon(Icons.sms, size: 48, color: theme.colorScheme.primary),
          const SizedBox(height: 16),
          Text(
            'Verify Your ABHA',
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Enter the OTP sent to your mobile number',
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
        content: Text('Are you sure you want to ${action.toLowerCase()} this consent request?'),
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
            backgroundColor: Colors.red,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  Color _statusColor(String status) {
    switch (status.toUpperCase()) {
      case 'REQUESTED':
        return Colors.blue;
      case 'GRANTED':
        return Colors.green;
      case 'DENIED':
        return Colors.red;
      case 'EXPIRED':
      case 'REVOKED':
        return Colors.grey;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_consents.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.handshake_outlined, size: 48,
                color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(
              'No consent requests',
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
          final purpose = (consent['purpose'] as String?) ?? 'Health data access';
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
                            color: _statusColor(status),
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        backgroundColor:
                            _statusColor(status).withAlpha(26),
                        side: BorderSide(
                          color: _statusColor(status).withAlpha(76),
                        ),
                        padding: EdgeInsets.zero,
                        materialTapTargetSize:
                            MaterialTapTargetSize.shrinkWrap,
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
                              'Deny', id, AbdmApiService.denyConsent),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: Colors.red,
                          ),
                          child: const Text('Deny'),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: () => _confirmAction(
                              'Grant', id, AbdmApiService.grantConsent),
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
                            'Revoke', id, AbdmApiService.revokeConsent),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.red,
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
