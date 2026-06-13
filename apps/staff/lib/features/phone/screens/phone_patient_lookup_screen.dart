import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/role_config.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/theme/app_theme.dart';

class PhonePatientLookupScreen extends StatefulWidget {
  const PhonePatientLookupScreen({super.key});

  @override
  State<PhonePatientLookupScreen> createState() =>
      _PhonePatientLookupScreenState();
}

class _PhonePatientLookupScreenState extends State<PhonePatientLookupScreen> {
  final _ctrl = TextEditingController();
  Timer? _debounce;
  bool _loading = false;
  bool? _allowed;
  String? _error;
  List<Map<String, dynamic>> _patients = const [];

  @override
  void initState() {
    super.initState();
    _loadRoleGate();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _loadRoleGate() async {
    try {
      final role = StaffRole.fromString(await AuthService.getRole());
      if (!mounted) return;
      setState(() {
        _allowed = RoleFeatures.hasPhoneReadOnlyPatientLookup(role);
      });
    } catch (_) {
      if (mounted) setState(() => _allowed = false);
    }
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 320), () => _search(value));
  }

  Future<void> _search(String value) async {
    final q = value.trim();
    if (q.length < 2) {
      setState(() {
        _patients = const [];
        _error = null;
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final rows = await PatientApiService.search(q, limit: 20);
      if (!mounted) return;
      setState(() => _patients = rows);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final allowed = _allowed;
    if (allowed == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Read-Only Patient Lookup')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    if (!allowed) {
      return const _LookupDeniedScreen();
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Read-Only Patient Lookup')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppTheme.primaryBlue.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: AppTheme.primaryBlue.withValues(alpha: 0.25),
              ),
            ),
            child: const Row(
              children: [
                Icon(Icons.visibility_outlined, color: AppTheme.primaryBlue),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Read-only on phone. Clinical entries must be completed on Staff Desktop.',
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _ctrl,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              labelText: 'Hospital ID / phone / name',
              suffixIcon: _loading
                  ? const Padding(
                      padding: EdgeInsets.all(12),
                      child: SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  : null,
            ),
            onChanged: _onChanged,
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(
              _error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
          const SizedBox(height: 16),
          if (_patients.isEmpty && _ctrl.text.trim().length >= 2 && !_loading)
            const Card(
              child: Padding(
                padding: EdgeInsets.all(18),
                child: Text('No matching patient found.'),
              ),
            ),
          ..._patients.map((patient) {
            final uid = patient['uid']?.toString() ?? '';
            final name = patient['name']?.toString() ?? 'Patient';
            final phone = patient['phone']?.toString() ?? '';
            final hospitalNo =
                patient['hospital_number']?.toString() ??
                patient['hospitalNumber']?.toString() ??
                '';
            return Card(
              child: ListTile(
                leading: const Icon(Icons.folder_shared_outlined),
                title: Text(name),
                subtitle: Text(
                  [hospitalNo, phone].where((v) => v.isNotEmpty).join(' • '),
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: uid.isEmpty
                    ? null
                    : () => context.push(
                        '/emr/timeline/$uid?name=${Uri.encodeQueryComponent(name)}',
                      ),
              ),
            );
          }),
        ],
      ),
    );
  }
}

class _LookupDeniedScreen extends StatelessWidget {
  const _LookupDeniedScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Read-Only Patient Lookup')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppTheme.warningAmber.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: AppTheme.warningAmber.withValues(alpha: 0.35),
              ),
            ),
            child: const Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.lock_outline, color: AppTheme.warningAmber),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Patient lookup on phone is limited to doctor-class read-only access. Use Staff Desktop for clinical workflows.',
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
