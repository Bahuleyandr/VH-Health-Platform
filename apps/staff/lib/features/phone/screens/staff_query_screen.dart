import 'package:flutter/material.dart';

import '../../phone/services/staff_phone_api_service.dart';

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
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Query submitted')));
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
      appBar: AppBar(title: const Text('Staff Query')),
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
                      Text(
                        'Raise query',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: _category,
                        decoration: const InputDecoration(
                          labelText: 'Category',
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'general',
                            child: Text('General'),
                          ),
                          DropdownMenuItem(value: 'hr', child: Text('HR')),
                          DropdownMenuItem(
                            value: 'roster',
                            child: Text('Roster'),
                          ),
                          DropdownMenuItem(
                            value: 'payroll',
                            child: Text('Payroll'),
                          ),
                          DropdownMenuItem(value: 'it', child: Text('IT')),
                          DropdownMenuItem(
                            value: 'maintenance',
                            child: Text('Maintenance'),
                          ),
                        ],
                        onChanged: (v) =>
                            setState(() => _category = v ?? 'general'),
                      ),
                      const SizedBox(height: 10),
                      DropdownButtonFormField<String>(
                        initialValue: _priority,
                        decoration: const InputDecoration(
                          labelText: 'Priority',
                        ),
                        items: const [
                          DropdownMenuItem(value: 'low', child: Text('Low')),
                          DropdownMenuItem(
                            value: 'normal',
                            child: Text('Normal'),
                          ),
                          DropdownMenuItem(value: 'high', child: Text('High')),
                          DropdownMenuItem(
                            value: 'urgent',
                            child: Text('Urgent'),
                          ),
                        ],
                        onChanged: (v) =>
                            setState(() => _priority = v ?? 'normal'),
                      ),
                      const SizedBox(height: 10),
                      TextFormField(
                        controller: _subjectCtrl,
                        decoration: const InputDecoration(labelText: 'Subject'),
                        textInputAction: TextInputAction.next,
                        validator: (v) => (v ?? '').trim().isEmpty
                            ? 'Subject is required'
                            : null,
                      ),
                      const SizedBox(height: 10),
                      TextFormField(
                        controller: _bodyCtrl,
                        decoration: const InputDecoration(labelText: 'Details'),
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
                        label: const Text('Submit query'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text('My queries', style: Theme.of(context).textTheme.titleMedium),
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
                      child: Text('No queries raised yet.'),
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
