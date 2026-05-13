// lib/features/profile/screens/add_dependent_screen.dart
//
// Guardian-facing flow to link an existing minor patient (with their own
// users.uid) under this account. Distinct from the Family screen, which
// is an address book of non-account contacts.
//
// The minor must already exist as a PATIENT user (typically created via
// the admin walk-in dialog post-Wave-3-batch-2). This screen does NOT
// create new minor accounts — that path lives in the staff/admin tooling.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class AddDependentScreen extends StatefulWidget {
  const AddDependentScreen({super.key});

  @override
  State<AddDependentScreen> createState() => _AddDependentScreenState();
}

class _AddDependentScreenState extends State<AddDependentScreen> {
  final _formKey = GlobalKey<FormState>();
  final _identifierCtrl = TextEditingController();
  String _relationship = 'parent';
  bool _submitting = false;
  String? _serverError;

  // Mirror the backend `VALID_LINK_RELATIONSHIPS` allowlist in
  // dependentsService.js. Keep these two in sync — a value that doesn't
  // match the backend allowlist returns INVALID_RELATIONSHIP.
  static const _relationships = <String, String>{
    'parent': 'Parent',
    'mother': 'Mother',
    'father': 'Father',
    'legal_guardian': 'Legal guardian',
    'grandparent': 'Grandparent',
    'sibling': 'Sibling',
    'spouse': 'Spouse',
    'other': 'Other',
  };

  @override
  void dispose() {
    _identifierCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _submitting = true;
      _serverError = null;
    });

    final provider = context.read<DependentsProvider>();
    final messenger = ScaffoldMessenger.of(context);
    try {
      final dep = await provider.linkDependent(
        dependentUidOrPhone: _identifierCtrl.text.trim(),
        relationship: _relationship,
      );
      if (!mounted) return;

      // Offer to switch to the new dependent immediately.
      final shouldSwitch = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Dependent linked'),
          content: Text(
            '${dep.name} is now linked under your account. '
            'Switch to their profile now?',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Not yet'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Switch profile'),
            ),
          ],
        ),
      );
      if (!mounted) return;
      if (shouldSwitch == true) {
        provider.switchTo(dep);
      }
      messenger.showSnackBar(SnackBar(content: Text('Linked ${dep.name}')));
      if (mounted) context.pop();
    } on DependentApiException catch (e) {
      setState(() {
        _serverError = e.message;
        _submitting = false;
      });
    } catch (e) {
      if (kDebugMode) debugPrint('AddDependentScreen.submit: $e');
      setState(() {
        _serverError = 'Failed to link dependent. Please try again.';
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    return FeatureScreenScaffold(
      title: 'Add a dependent',
      icon: Icons.escalator_warning,
      color: cs.tertiary,
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Link a minor patient',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Enter the phone number or VH Health UID of the minor patient. '
              'The minor must already be registered (typically at reception '
              'during their first visit).',
              style: theme.textTheme.bodySmall?.copyWith(
                color: cs.onSurface.withValues(alpha: 0.7),
              ),
            ),
            const SizedBox(height: 20),
            TextFormField(
              controller: _identifierCtrl,
              keyboardType: TextInputType.text,
              textInputAction: TextInputAction.next,
              decoration: const InputDecoration(
                labelText: 'Phone number or UID',
                hintText: '+91 9876543210 or a-uuid-from-reception',
                prefixIcon: Icon(Icons.contact_phone_outlined),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                final value = v?.trim() ?? '';
                if (value.isEmpty) return 'Phone or UID is required';
                final isUuid = RegExp(
                  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                  caseSensitive: false,
                ).hasMatch(value);
                final isPhone = RegExp(
                  r'^[+]?[0-9]{10,15}$',
                ).hasMatch(value.replaceAll(RegExp(r'\s'), ''));
                if (!isUuid && !isPhone) {
                  return 'Enter a phone (10–15 digits) or a UID';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              initialValue: _relationship,
              decoration: const InputDecoration(
                labelText: 'Your relationship to them',
                prefixIcon: Icon(Icons.family_restroom_outlined),
                border: OutlineInputBorder(),
              ),
              items: _relationships.entries
                  .map(
                    (e) => DropdownMenuItem(value: e.key, child: Text(e.value)),
                  )
                  .toList(growable: false),
              onChanged: _submitting
                  ? null
                  : (v) {
                      if (v != null) setState(() => _relationship = v);
                    },
            ),
            if (_serverError != null) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: cs.errorContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    Icon(Icons.error_outline, color: cs.onErrorContainer),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _serverError!,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: cs.onErrorContainer,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.link),
              label: Text(_submitting ? 'Linking…' : 'Link dependent'),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
            const SizedBox(height: 12),
            Text(
              "Don't see the dependent? Ask reception to register them "
              'first — they need a VH Health UID before you can link them.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: cs.onSurface.withValues(alpha: 0.6),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
