import 'package:flutter/material.dart';

import '../../phone/services/staff_phone_api_service.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

class StaffQueryScreen extends StatefulWidget {
  const StaffQueryScreen({super.key});

  @override
  State<StaffQueryScreen> createState() => _StaffQueryScreenState();
}

class _StaffQueryScreenState extends State<StaffQueryScreen> {
  final _formKey = GlobalKey<FormState>();
  final _subjectCtrl = TextEditingController();
  final _bodyCtrl = TextEditingController();
  String _category = 'general';
  String _priority = 'normal';
  bool _submitting = false;
  late Future<List<Map<String, dynamic>>> _queriesFuture;

  @override
  void initState() {
    super.initState();
    _queriesFuture = StaffPhoneApiService.getMyQueries();
  }

  @override
  void dispose() {
    _subjectCtrl.dispose();
    _bodyCtrl.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() => _queriesFuture = StaffPhoneApiService.getMyQueries());
    await _queriesFuture;
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _submitting = true);
    try {
      await StaffPhoneApiService.submitQuery(
        category: _category,
        subject: _subjectCtrl.text.trim(),
        body: _bodyCtrl.text.trim(),
        priority: _priority,
      );
      if (!mounted) return;
      _subjectCtrl.clear();
      _bodyCtrl.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: AppText('s4.lib.staff_query.query_submitted')),
      );
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const AppText('s4.lib.staff_query.staff_query')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Form(
              key: _formKey,
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      AppText(
                        's4.lib.staff_query.raise_query',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: _category,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(context)
                              .lookup('vitals_chart.category'),
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'general',
                            child: AppText('department.general'),
                          ),
                          DropdownMenuItem(
                            value: 'hr',
                            child: AppText('vitals_chart.col.hr'),
                          ),
                          DropdownMenuItem(
                            value: 'roster',
                            child: AppText('s4.lib.hr_dashboard.roster'),
                          ),
                          DropdownMenuItem(
                            value: 'payroll',
                            child: AppText('s4.lib.staff_query.payroll'),
                          ),
                          DropdownMenuItem(
                            value: 'it',
                            child: AppText('s4.lib.staff_query.it'),
                          ),
                          DropdownMenuItem(
                            value: 'maintenance',
                            child: AppText('bed.status.maintenance'),
                          ),
                        ],
                        onChanged: (v) =>
                            setState(() => _category = v ?? 'general'),
                      ),
                      const SizedBox(height: 10),
                      DropdownButtonFormField<String>(
                        initialValue: _priority,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(context)
                              .lookup('clinical_inbox.priority'),
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'low',
                            child: AppText('priority.low'),
                          ),
                          DropdownMenuItem(
                            value: 'normal',
                            child: AppText('priority.normal'),
                          ),
                          DropdownMenuItem(
                            value: 'high',
                            child: AppText('priority.high'),
                          ),
                          DropdownMenuItem(
                            value: 'urgent',
                            child: AppText('priority.urgent'),
                          ),
                        ],
                        onChanged: (v) =>
                            setState(() => _priority = v ?? 'normal'),
                      ),
                      const SizedBox(height: 10),
                      TextFormField(
                        controller: _subjectCtrl,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(context)
                              .lookup('s4.lib.messaging_inbox.subject'),
                        ),
                        textInputAction: TextInputAction.next,
                        validator: (v) => (v ?? '').trim().isEmpty
                            ? 'Subject is required'
                            : null,
                      ),
                      const SizedBox(height: 10),
                      TextFormField(
                        controller: _bodyCtrl,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(context)
                              .lookup('timeline.details'),
                        ),
                        minLines: 4,
                        maxLines: 8,
                        validator: (v) => (v ?? '').trim().isEmpty
                            ? 'Details are required'
                            : null,
                      ),
                      const SizedBox(height: 12),
                      FilledButton.icon(
                        onPressed: _submitting ? null : _submit,
                        icon: _submitting
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.send),
                        label: const AppText('s4.lib.staff_query.submit_query'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            AppText(
              's4.lib.staff_query.my_queries',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            FutureBuilder<List<Map<String, dynamic>>>(
              future: _queriesFuture,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Text(
                    snapshot.error.toString().replaceFirst('Exception: ', ''),
                  );
                }
                final queries = snapshot.data ?? const [];
                if (queries.isEmpty) {
                  return const Card(
                    child: Padding(
                      padding: EdgeInsets.all(18),
                      child: AppText(
                        's4.lib.staff_query.no_queries_raised_yet',
                      ),
                    ),
                  );
                }
                return Column(
                  children: queries
                      .map(
                        (row) => Card(
                          child: ListTile(
                            title: Text(row['subject']?.toString() ?? 'Query'),
                            subtitle: Text(
                              '${row['category'] ?? 'general'} • ${row['priority'] ?? 'normal'}',
                            ),
                            trailing: Chip(
                              label: Text(
                                row['status']?.toString() ?? 'submitted',
                              ),
                            ),
                          ),
                        ),
                      )
                      .toList(),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
