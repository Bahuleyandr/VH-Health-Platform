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
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

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
  static const _relationships = <String>[
    'parent',
    'mother',
    'father',
    'legal_guardian',
    'grandparent',
    'sibling',
    'spouse',
    'other',
  ];

  String _relationshipLabel(AppLocalizations l, String value) {
    return switch (value) {
      'parent' => l.addDependentRelationshipParent,
      'mother' => l.addDependentRelationshipMother,
      'father' => l.addDependentRelationshipFather,
      'legal_guardian' => l.addDependentRelationshipLegalGuardian,
      'grandparent' => l.addDependentRelationshipGrandparent,
      'sibling' => l.addDependentRelationshipSibling,
      'spouse' => l.addDependentRelationshipSpouse,
      _ => l.addDependentRelationshipOther,
    };
  }

  @override
  void dispose() {
    _identifierCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final l = AppLocalizations.of(context)!;
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
          title: Text(l.addDependentLinkedTitle),
          content: Text(l.addDependentLinkedBody(dep.name)),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(l.addDependentNotYetButton),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(l.addDependentSwitchProfileButton),
            ),
          ],
        ),
      );
      if (!mounted) return;
      if (shouldSwitch == true) {
        provider.switchTo(dep);
      }
      messenger.showSnackBar(
        LiveRegionSnackBar.build(message: l.addDependentLinkedToast(dep.name)),
      );
      // A deep link (vhhealth://app/add-dependent) arrives via GoRouter.go,
      // which REPLACES the stack — so canPop() is false and a bare pop() throws
      // GoError after the patient has already saved and seen the success
      // message. Fall back to the screen this one belongs to.
      if (!mounted) return;
      if (context.canPop()) {
        context.pop();
      } else {
        context.go('/settings');
      }
    } on DependentApiException catch (e) {
      setState(() {
        _serverError = e.message;
        _submitting = false;
      });
    } catch (e) {
      if (kDebugMode) debugPrint('AddDependentScreen.submit: $e');
      setState(() {
        _serverError = l.addDependentLinkFailed;
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l = AppLocalizations.of(context)!;
    return FeatureScreenScaffold(
      title: l.addDependentTitle,
      icon: Icons.escalator_warning,
      color: cs.tertiary,
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l.addDependentHeading,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              l.addDependentIntro,
              style: theme.textTheme.bodySmall?.copyWith(
                color: cs.onSurface.withValues(alpha: 0.7),
              ),
            ),
            const SizedBox(height: 20),
            TextFormField(
              controller: _identifierCtrl,
              keyboardType: TextInputType.text,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(
                labelText: l.addDependentIdentifierLabel,
                hintText: l.addDependentIdentifierHint,
                prefixIcon: const Icon(Icons.contact_phone_outlined),
                border: const OutlineInputBorder(),
              ),
              validator: (v) {
                final value = v?.trim() ?? '';
                if (value.isEmpty) return l.addDependentIdentifierRequired;
                final isUuid = RegExp(
                  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                  caseSensitive: false,
                ).hasMatch(value);
                final isPhone = RegExp(r'^[+]?[0-9]{10,15}$')
                    .hasMatch(value.replaceAll(RegExp(r'\s'), ''));
                if (!isUuid && !isPhone) {
                  return l.addDependentIdentifierInvalid;
                }
                return null;
              },
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              initialValue: _relationship,
              decoration: InputDecoration(
                labelText: l.addDependentRelationshipLabel,
                prefixIcon: const Icon(Icons.family_restroom_outlined),
                border: const OutlineInputBorder(),
              ),
              items: _relationships
                  .map(
                    (value) => DropdownMenuItem(
                      value: value,
                      child: Text(_relationshipLabel(l, value)),
                    ),
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
              label: Text(
                _submitting
                    ? l.addDependentLinkingButton
                    : l.addDependentLinkButton,
              ),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
            const SizedBox(height: 12),
            Text(
              l.addDependentReceptionHint,
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
