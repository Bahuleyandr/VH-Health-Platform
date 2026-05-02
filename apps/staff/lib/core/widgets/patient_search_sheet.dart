import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/patient_api_service.dart';
import '../theme/app_theme.dart';

/// Global patient picker — opens as a top-of-screen modal sheet.
///
/// Type a few characters → debounced search hits
/// `GET /api/v1/patients/search?q=…` → tap a row jumps to
/// `/emr/timeline/:uid?name=…` for that patient. Replaces the
/// "navigate to /emr/admissions, scroll, find patient, tap" loop
/// nurses and doctors used to do for every patient handoff.
///
/// Open via [PatientSearchSheet.show] from any screen — typically a
/// magnifier icon in the AppBar or a Cmd+K shortcut.
class PatientSearchSheet extends StatefulWidget {
  const PatientSearchSheet({super.key});

  static Future<void> show(BuildContext context) {
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => const Padding(
        padding: EdgeInsets.only(top: 32),
        child: PatientSearchSheet(),
      ),
    );
  }

  @override
  State<PatientSearchSheet> createState() => _PatientSearchSheetState();
}

class _PatientSearchSheetState extends State<PatientSearchSheet> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();
  Timer? _debounce;
  String _lastQuery = '';
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _results = [];

  @override
  void initState() {
    super.initState();
    // Auto-focus the field so the user can start typing immediately.
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _focusNode.requestFocus(),
    );
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      setState(() {
        _results = [];
        _loading = false;
        _error = null;
        _lastQuery = '';
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), () => _runSearch(trimmed));
  }

  Future<void> _runSearch(String query) async {
    if (query == _lastQuery && _loading) return;
    _lastQuery = query;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final rows = await PatientApiService.search(query);
      if (!mounted || query != _lastQuery) return;
      setState(() {
        _results = rows;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  void _openPatient(BuildContext context, Map<String, dynamic> patient) {
    final uid = (patient['uid'] ?? '').toString();
    if (uid.isEmpty) return;
    final name = (patient['name'] ?? 'Patient').toString();
    Navigator.of(context).pop();
    context.go(
      '/emr/timeline/$uid?name=${Uri.encodeQueryComponent(name)}',
    );
  }

  @override
  Widget build(BuildContext context) {
    final viewInsets = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: viewInsets),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: MediaQuery.of(context).size.height * 0.7,
          child: Column(
            children: [
              // Drag handle
              Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(top: 8, bottom: 12),
                decoration: BoxDecoration(
                  color: Colors.grey.shade300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),

              // Search input
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: TextField(
                  controller: _controller,
                  focusNode: _focusNode,
                  decoration: InputDecoration(
                    hintText: 'Find a patient by name, phone, or ABHA…',
                    prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                    suffixIcon: _controller.text.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.close),
                            onPressed: () {
                              _controller.clear();
                              _onChanged('');
                            },
                          )
                        : null,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                    filled: true,
                    fillColor: AppTheme.backgroundGrey,
                  ),
                  textInputAction: TextInputAction.search,
                  onChanged: (v) {
                    setState(() {}); // refresh suffixIcon visibility
                    _onChanged(v);
                  },
                  onSubmitted: (v) => _runSearch(v.trim()),
                ),
              ),

              const Divider(height: 1),

              // Results
              Expanded(child: _buildBody()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_lastQuery.isEmpty && _controller.text.isEmpty) {
      return _emptyHint(
        Icons.search_outlined,
        'Type a name, phone, or ABHA address to find a patient.',
      );
    }
    if (_loading && _results.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return _emptyHint(Icons.error_outline, _error!);
    }
    if (_results.isEmpty) {
      return _emptyHint(
        Icons.person_search_outlined,
        'No matches for "$_lastQuery"',
      );
    }
    return ListView.separated(
      itemCount: _results.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final p = _results[index];
        final name = (p['name'] ?? 'Unnamed').toString();
        final age = p['age'];
        final gender = (p['gender'] ?? '').toString();
        final phone = (p['phone'] ?? '').toString();
        final abha = (p['abha_address'] ?? '').toString();
        final subtitleParts = <String>[
          if (age != null && age.toString().isNotEmpty)
            '${age.toString()} yr',
          if (gender.isNotEmpty)
            gender[0].toUpperCase() + gender.substring(1).toLowerCase(),
          if (phone.isNotEmpty) phone,
          if (abha.isNotEmpty) abha,
        ];
        return ListTile(
          leading: CircleAvatar(
            backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.1),
            child: Text(
              name.isNotEmpty ? name[0].toUpperCase() : '?',
              style: const TextStyle(
                color: AppTheme.primaryBlue,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          title: Text(
            name,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: subtitleParts.isEmpty
              ? null
              : Text(subtitleParts.join(' · ')),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => _openPatient(context, p),
        );
      },
    );
  }

  Widget _emptyHint(IconData icon, String message) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 36, color: AppTheme.textSecondary),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
