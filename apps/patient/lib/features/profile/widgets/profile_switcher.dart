// lib/features/profile/widgets/profile_switcher.dart
//
// Compact "viewing as" chip + sheet that lets a guardian toggle between
// their own profile and any linked minor dependent. Renders inline above
// the dashboard / your-health screens.
//
// Self-hiding when there are no dependents AND the load hasn't surfaced
// an error — first-time users never see this UI until they link someone.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class ProfileSwitcher extends StatefulWidget {
  /// Padding applied around the chip (so callers can match the surrounding
  /// section padding).
  final EdgeInsetsGeometry padding;

  const ProfileSwitcher({
    super.key,
    this.padding = const EdgeInsets.fromLTRB(16, 0, 16, 8),
  });

  @override
  State<ProfileSwitcher> createState() => _ProfileSwitcherState();
}

class _ProfileSwitcherState extends State<ProfileSwitcher> {
  @override
  void initState() {
    super.initState();
    // Defer the load so we're past the first build before kicking off an
    // ApiClient call.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<DependentsProvider>().loadDependents();
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dependents = context.watch<DependentsProvider>();
    final userProv = context.watch<UserProvider>();

    // First-time users with no dependents: don't surface this UI at all.
    if (!dependents.hasDependents && !dependents.isViewingDependent) {
      return const SizedBox.shrink();
    }

    final active = dependents.activeDependent;
    final isSelf = active == null;
    final displayName = isSelf
        ? (userProv.name.isNotEmpty ? userProv.name : 'You')
        : active.name;
    final cs = theme.colorScheme;
    final badgeColor = isSelf ? cs.primary : cs.tertiary;

    return Padding(
      padding: widget.padding,
      child: Material(
        color: badgeColor.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => _openSheet(context),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            child: Row(
              children: [
                Icon(
                  isSelf ? Icons.person : Icons.escalator_warning,
                  size: 18,
                  color: badgeColor,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        isSelf ? 'Viewing your profile' : 'Viewing as guardian',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurface.withValues(alpha: 0.7),
                        ),
                      ),
                      Text(
                        displayName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                          color: badgeColor,
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(Icons.unfold_more, size: 20, color: badgeColor),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _openSheet(BuildContext context) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const _ProfileSwitcherSheet(),
    );
  }
}

class _ProfileSwitcherSheet extends StatelessWidget {
  const _ProfileSwitcherSheet();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final dependents = context.watch<DependentsProvider>();
    final userProv = context.watch<UserProvider>();
    final active = dependents.activeDependent;
    final l = AppLocalizations.of(context)!;
    final selfName = userProv.name.isNotEmpty
        ? userProv.name
        : l.profileSwitcherSelfName;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: cs.outlineVariant,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              l.profileSwitcherTitle,
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              l.profileSwitcherSubtitle,
              style: theme.textTheme.bodySmall?.copyWith(
                color: cs.onSurface.withValues(alpha: 0.7),
              ),
            ),
            const SizedBox(height: 16),
            _ProfileTile(
              icon: Icons.person,
              name: selfName,
              subtitle: l.profileSwitcherYourProfile,
              selected: active == null,
              onTap: () {
                context.read<DependentsProvider>().switchTo(null);
                Navigator.of(context).pop();
              },
            ),
            const Divider(height: 24),
            if (dependents.error != null) ...[
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  dependents.error!,
                  style: theme.textTheme.bodySmall?.copyWith(color: cs.error),
                ),
              ),
            ],
            if (dependents.dependents.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  l.profileSwitcherNoDependents,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: cs.onSurface.withValues(alpha: 0.6),
                  ),
                ),
              )
            else
              ...dependents.dependents.map(
                (dep) => _ProfileTile(
                  icon: Icons.escalator_warning,
                  name: dep.name,
                  subtitle: _subtitleFor(dep),
                  selected: active?.uid == dep.uid,
                  onTap: () {
                    context.read<DependentsProvider>().switchTo(dep);
                    Navigator.of(context).pop();
                  },
                  onRemove: () => _confirmUnlink(context, dep),
                ),
              ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () {
                Navigator.of(context).pop();
                context.push('/add-dependent');
              },
              icon: const Icon(Icons.person_add_alt_1),
              label: Text(l.addDependentTitle),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _subtitleFor(Dependent dep) {
    final parts = <String>[];
    if (dep.relationship != null && dep.relationship!.isNotEmpty) {
      parts.add(dep.relationship!.replaceAll('_', ' '));
    }
    if (dep.isMinor) parts.add('minor');
    if (dep.phone != null && dep.phone!.isNotEmpty) parts.add(dep.phone!);
    return parts.isEmpty ? 'Dependent' : parts.join(' • ');
  }

  Future<void> _confirmUnlink(BuildContext context, Dependent dep) async {
    final messenger = ScaffoldMessenger.of(context);
    final l = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.profileSwitcherRemoveDependentTitle),
        content: Text(l.profileSwitcherRemoveDependentBody(dep.name)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(l.commonCancelButton),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(ctx).colorScheme.error,
            ),
            child: Text(l.profileSwitcherRemoveButton),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;

    try {
      await context.read<DependentsProvider>().unlinkDependent(dep.id);
      if (context.mounted) {
        Navigator.of(context).pop();
        messenger.showSnackBar(
          SnackBar(content: Text(l.profileSwitcherRemovedToast(dep.name))),
        );
      }
    } on DependentApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } catch (_) {
      messenger.showSnackBar(
        SnackBar(content: Text(l.profileSwitcherRemoveFailed)),
      );
    }
  }
}

class _ProfileTile extends StatelessWidget {
  final IconData icon;
  final String name;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback? onRemove;

  const _ProfileTile({
    required this.icon,
    required this.name,
    required this.subtitle,
    required this.selected,
    required this.onTap,
    this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l = AppLocalizations.of(context)!;
    return Material(
      color: selected ? cs.primary.withValues(alpha: 0.08) : Colors.transparent,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
          child: Row(
            children: [
              CircleAvatar(
                radius: 18,
                backgroundColor: cs.primary.withValues(alpha: 0.15),
                child: Icon(icon, color: cs.primary, size: 18),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      name,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.7),
                      ),
                    ),
                  ],
                ),
              ),
              if (selected) Icon(Icons.check, color: cs.primary, size: 20),
              if (onRemove != null)
                IconButton(
                  tooltip: l.profileSwitcherRemoveButton,
                  icon: Icon(Icons.link_off, color: cs.error, size: 20),
                  onPressed: onRemove,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
