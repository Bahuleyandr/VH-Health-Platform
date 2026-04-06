import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class FamilyScreen extends StatefulWidget {
  final String phone;
  const FamilyScreen({super.key, required this.phone});

  @override
  State<FamilyScreen> createState() => _FamilyScreenState();
}

class _FamilyScreenState extends State<FamilyScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _members = [];

  @override
  void initState() {
    super.initState();
    _fetchMembers();
  }

  Future<void> _fetchMembers() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/users/family-members');
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _members = list.cast<Map<String, dynamic>>();
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.message ?? 'Failed to load family members';
          _loading = false;
        });
      }
    } catch (e) {
      if (kDebugMode) debugPrint('FamilyScreen: fetch error: $e');
      if (mounted) {
        setState(() {
          _error = 'Failed to load family members';
          _loading = false;
        });
      }
    }
  }

  Future<void> _addMember() async {
    final result = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: const _AddFamilyMemberSheet(),
      ),
    );
    if (result == true && mounted) {
      _fetchMembers();
    }
  }

  Future<void> _removeMember(Map<String, dynamic> member) async {
    final id = (member['_id'] as String?) ?? (member['id']?.toString());
    if (id == null || id.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Member ID not found')),
        );
      }
      return;
    }
    final name = member['name'] as String? ?? 'this family member';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove Family Member'),
        content: Text('Are you sure you want to remove $name?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            child: const Text('Remove'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    try {
      final response = await ApiClient.delete('/users/family-members/$id');
      if (!mounted) return;
      if (response.isSuccess) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$name removed from family members')),
        );
        _fetchMembers();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(response.message ?? 'Failed to remove member')),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('FamilyScreen: remove error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to remove member. Please try again.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Family Members',
      icon: Icons.family_restroom,
      color: const Color(0xFFCE93D8),
      floatingActionButton: FloatingActionButton(
        onPressed: _addMember,
        backgroundColor: const Color(0xFFCE93D8),
        child: const Icon(Icons.person_add),
      ),
      child: _buildBody(),
    );
  }

  Widget _buildBody() {
    final theme = Theme.of(context);

    if (_loading) {
      return const SizedBox(
        height: 200,
        child: Center(child: CircularProgressIndicator()),
      );
    }

    if (_error != null) {
      return SizedBox(
        height: 200,
        child: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.error_outline, size: 48, color: theme.colorScheme.error),
              const SizedBox(height: 12),
              Text(_error!, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _fetchMembers,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (_members.isEmpty) {
      return SizedBox(
        height: 200,
        child: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.family_restroom, size: 48, color: Colors.grey.shade400),
              const SizedBox(height: 12),
              Text('No family members yet', style: theme.textTheme.bodyMedium),
              const SizedBox(height: 8),
              Text(
                'Add family members to manage shared care.',
                style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: _addMember,
                icon: const Icon(Icons.person_add),
                label: const Text('Add Family Member'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: const Color(0xFFCE93D8),
                  side: const BorderSide(color: Color(0xFFCE93D8)),
                ),
              ),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Your Family',
          style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 4),
        Text(
          'Manage family members linked to your account.',
          style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey),
        ),
        const SizedBox(height: 16),
        ListView.separated(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: _members.length,
          separatorBuilder: (_, _) => const SizedBox(height: 12),
          itemBuilder: (context, index) {
            return _FamilyMemberCard(
              member: _members[index],
              onRemove: () => _removeMember(_members[index]),
            );
          },
        ),
      ],
    );
  }
}

// ── Family Member Card ──────────────────────────────────────────────────────

class _FamilyMemberCard extends StatelessWidget {
  final Map<String, dynamic> member;
  final VoidCallback onRemove;

  const _FamilyMemberCard({required this.member, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = member['name'] as String? ?? 'Unknown';
    final relationship = member['relationship'] as String? ?? '';
    final phone = member['phone'] as String? ?? '';
    final dobRaw = member['dateOfBirth'] as String? ?? '';

    String dob = '';
    if (dobRaw.isNotEmpty) {
      try {
        final dt = DateTime.parse(dobRaw);
        dob = DateFormat('MMM dd, yyyy').format(dt);
      } catch (_) {
        dob = dobRaw;
      }
    }

    return Card(
      elevation: 1,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            CircleAvatar(
              backgroundColor: const Color(0xFFCE93D8).withAlpha(51),
              radius: 24,
              child: Text(
                name.isNotEmpty ? name[0].toUpperCase() : '?',
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFFCE93D8),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  if (relationship.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      relationship,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: const Color(0xFFCE93D8),
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                  if (phone.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      phone,
                      style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey.shade600),
                    ),
                  ],
                  if (dob.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      'DOB: $dob',
                      style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey.shade600),
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              onPressed: onRemove,
              icon: const Icon(Icons.delete_outline, color: Colors.red),
              tooltip: 'Remove member',
            ),
          ],
        ),
      ),
    );
  }
}

// ── Add Family Member Sheet ─────────────────────────────────────────────────

class _AddFamilyMemberSheet extends StatefulWidget {
  const _AddFamilyMemberSheet();

  @override
  State<_AddFamilyMemberSheet> createState() => _AddFamilyMemberSheetState();
}

class _AddFamilyMemberSheetState extends State<_AddFamilyMemberSheet> {
  final _formKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _dobCtrl = TextEditingController();
  String _relationship = 'Spouse';
  bool _submitting = false;
  DateTime? _selectedDob;

  static const _relationships = [
    'Spouse',
    'Parent',
    'Child',
    'Sibling',
    'Grandparent',
    'Grandchild',
    'Other',
  ];

  @override
  void dispose() {
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _dobCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDob ?? DateTime(1990),
      firstDate: DateTime(1900),
      lastDate: DateTime.now(),
    );
    if (picked != null && mounted) {
      setState(() {
        _selectedDob = picked;
        _dobCtrl.text = DateFormat('yyyy-MM-dd').format(picked);
      });
    }
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _submitting = true);
    try {
      final body = <String, dynamic>{
        'name': _nameCtrl.text.trim(),
        'phone': _phoneCtrl.text.trim(),
        'relationship': _relationship,
      };
      if (_dobCtrl.text.isNotEmpty) {
        body['dateOfBirth'] = _dobCtrl.text;
      }

      final response = await ApiClient.post('/users/family-members', body: body);
      if (!mounted) return;

      if (response.isSuccess) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Family member added successfully')),
        );
        Navigator.pop(context, true);
      } else {
        setState(() => _submitting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(response.message ?? 'Failed to add family member')),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('AddFamilyMemberSheet: submit error: $e');
      if (mounted) {
        setState(() => _submitting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to add family member. Please try again.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: Colors.grey.shade300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Add Family Member',
              style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 20),

            // Name
            TextFormField(
              controller: _nameCtrl,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                labelText: 'Full Name',
                prefixIcon: Icon(Icons.person_outline),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) return 'Name is required';
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Phone
            TextFormField(
              controller: _phoneCtrl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Phone Number',
                prefixIcon: Icon(Icons.phone_outlined),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) return 'Phone is required';
                if (!RegExp(r'^[+]?[0-9]{10,15}$').hasMatch(v.trim())) {
                  return 'Enter a valid phone number';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Relationship
            DropdownButtonFormField<String>(
              value: _relationship,
              decoration: const InputDecoration(
                labelText: 'Relationship',
                prefixIcon: Icon(Icons.people_outline),
                border: OutlineInputBorder(),
              ),
              items: _relationships
                  .map((r) => DropdownMenuItem(value: r, child: Text(r)))
                  .toList(),
              onChanged: (v) {
                if (v != null) setState(() => _relationship = v);
              },
            ),
            const SizedBox(height: 16),

            // Date of Birth
            TextFormField(
              controller: _dobCtrl,
              readOnly: true,
              onTap: _pickDate,
              decoration: const InputDecoration(
                labelText: 'Date of Birth (optional)',
                prefixIcon: Icon(Icons.cake_outlined),
                border: OutlineInputBorder(),
                hintText: 'Tap to select',
              ),
            ),
            const SizedBox(height: 24),

            // Submit
            FilledButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.person_add),
              label: Text(_submitting ? 'Adding...' : 'Add Member'),
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFCE93D8),
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
