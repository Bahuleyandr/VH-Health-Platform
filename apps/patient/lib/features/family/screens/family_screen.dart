import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class FamilyScreen extends StatefulWidget {
  const FamilyScreen({super.key});

  @override
  State<FamilyScreen> createState() => _FamilyScreenState();
}

class _FamilyScreenState extends State<FamilyScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _members = [];
  bool _didLoad = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_didLoad) return;
    _didLoad = true;
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
        if (!mounted) return;
        setState(() {
          _error =
              response.message ??
              AppLocalizations.of(context)!.familyLoadFailed;
          _loading = false;
        });
      }
    } catch (e) {
      if (kDebugMode) debugPrint('FamilyScreen: fetch error: $e');
      if (mounted) {
        setState(() {
          _error = AppLocalizations.of(context)!.familyLoadFailed;
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
    final l = AppLocalizations.of(context)!;
    final id = (member['_id'] as String?) ?? (member['id']?.toString());
    if (id == null || id.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.familyMemberIdNotFound)));
      }
      return;
    }
    final name = member['name'] as String? ?? l.familyUnknown;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.familyRemoveTitle),
        content: Text(l.familyRemoveConfirm(name)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.commonCancelButton),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(ctx).colorScheme.error,
              foregroundColor: Theme.of(ctx).colorScheme.onError,
            ),
            child: Text(l.familyRemoveButton),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    try {
      final response = await ApiClient.delete('/users/family-members/$id');
      if (!mounted) return;
      if (response.isSuccess) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.familyRemoved(name))));
        _fetchMembers();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(response.message ?? l.familyRemoveFailed)),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('FamilyScreen: remove error: $e');
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.familyRemoveFailedRetry)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l.familyTitle,
      icon: Icons.family_restroom,
      color: colors.tertiary,
      floatingActionButton: FloatingActionButton(
        onPressed: _addMember,
        backgroundColor: colors.tertiary,
        foregroundColor: colors.onTertiary,
        child: const Icon(Icons.person_add),
      ),
      child: _buildBody(),
    );
  }

  Widget _buildBody() {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;

    return DataStateBuilder<Map<String, dynamic>>(
      isLoading: _loading,
      error: _error,
      data: _members,
      onRetry: _fetchMembers,
      onEmptyAction: _addMember,
      emptyIcon: Icons.family_restroom,
      emptyTitle: l.familyNoMembers,
      emptySubtitle: l.familyNoMembersHint,
      emptyActionLabel: l.familyAddMember,
      errorTitle: l.genericError,
      errorActionLabel: l.commonRetryButton,
      builder: (context, members) {
        return RefreshIndicator(
          onRefresh: _fetchMembers,
          child: ListView.separated(
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: members.length + 1,
            separatorBuilder: (_, index) => index == 0
                ? const SizedBox(height: 16)
                : const SizedBox(height: 12),
            itemBuilder: (context, index) {
              if (index == 0) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      l.familyYourFamily,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      l.familyManageHint,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                );
              }
              final member = members[index - 1];
              return _FamilyMemberCard(
                member: member,
                onRemove: () => _removeMember(member),
              );
            },
          ),
        );
      },
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
    final colors = theme.colorScheme;
    final l = AppLocalizations.of(context)!;
    final name = member['name'] as String? ?? l.familyUnknown;
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
              backgroundColor: colors.tertiaryContainer,
              radius: 24,
              child: Text(
                name.isNotEmpty ? name[0].toUpperCase() : '?',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                  color: colors.onTertiaryContainer,
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
                        color: colors.tertiary,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                  if (phone.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      phone,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                  if (dob.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      '${l.familyDobPrefix} $dob',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              onPressed: onRemove,
              icon: Icon(Icons.delete_outline, color: colors.error),
              tooltip: l.familyRemoveTooltip,
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
    final l = AppLocalizations.of(context)!;

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

      final response = await ApiClient.post(
        '/users/family-members',
        body: body,
      );
      if (!mounted) return;

      if (response.isSuccess) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.familyAddedSuccess)));
        Navigator.pop(context, true);
      } else {
        setState(() => _submitting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(response.message ?? l.familyAddFailed)),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('AddFamilyMemberSheet: submit error: $e');
      if (mounted) {
        setState(() => _submitting = false);
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l.familyAddFailedRetry)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final l = AppLocalizations.of(context)!;
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
                  color: colors.outlineVariant,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              l.familyAddMember,
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 20),

            // Name
            TextFormField(
              controller: _nameCtrl,
              textCapitalization: TextCapitalization.words,
              decoration: InputDecoration(
                labelText: l.familyFullName,
                prefixIcon: const Icon(Icons.person_outline),
                border: const OutlineInputBorder(),
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) return l.familyNameRequired;
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Phone
            TextFormField(
              controller: _phoneCtrl,
              keyboardType: TextInputType.phone,
              decoration: InputDecoration(
                labelText: l.familyPhone,
                prefixIcon: const Icon(Icons.phone_outlined),
                border: const OutlineInputBorder(),
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) return l.familyPhoneRequired;
                if (!RegExp(r'^[+]?[0-9]{10,15}$').hasMatch(v.trim())) {
                  return l.familyPhoneInvalid;
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Relationship
            DropdownButtonFormField<String>(
              initialValue: _relationship,
              decoration: InputDecoration(
                labelText: l.familyRelationship,
                prefixIcon: const Icon(Icons.people_outline),
                border: const OutlineInputBorder(),
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
              decoration: InputDecoration(
                labelText: l.familyDateOfBirth,
                prefixIcon: const Icon(Icons.cake_outlined),
                border: const OutlineInputBorder(),
                hintText: l.familyTapToSelect,
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
              label: Text(
                _submitting ? l.familyAdding : l.familyAddMemberShort,
              ),
              style: FilledButton.styleFrom(
                backgroundColor: colors.tertiary,
                foregroundColor: colors.onTertiary,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
