import 'package:flutter/material.dart';

import '../../../core/models/composition_alternatives.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

typedef CompositionAlternativesLoader =
    Future<CompositionAlternativesResult> Function(int catalogId);
typedef CompositionAlternativeSwap = void Function(CompositionAlternativeItem);

class CompositionAlternativesPanel extends StatefulWidget {
  const CompositionAlternativesPanel({
    super.key,
    required this.catalogId,
    required this.visible,
    required this.doNotSubstitute,
    required this.onSwap,
    this.selectedLabel,
    this.loader,
  });

  final int? catalogId;
  final bool visible;
  final bool doNotSubstitute;
  final String? selectedLabel;
  final CompositionAlternativesLoader? loader;
  final CompositionAlternativeSwap onSwap;

  @override
  State<CompositionAlternativesPanel> createState() =>
      _CompositionAlternativesPanelState();
}

class _CompositionAlternativesPanelState
    extends State<CompositionAlternativesPanel> {
  Future<CompositionAlternativesResult>? _future;
  int? _loadedCatalogId;

  @override
  void didUpdateWidget(covariant CompositionAlternativesPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.catalogId != widget.catalogId ||
        oldWidget.visible != widget.visible ||
        oldWidget.loader != widget.loader) {
      _future = null;
      _loadedCatalogId = null;
    }
  }

  Future<CompositionAlternativesResult> _load(int catalogId) {
    if (_future != null && _loadedCatalogId == catalogId) return _future!;
    _loadedCatalogId = catalogId;
    final loader = widget.loader ?? MedicalApiService.getCatalogAlternatives;
    return _future = loader(catalogId);
  }

  @override
  Widget build(BuildContext context) {
    final catalogId = widget.catalogId;
    if (!widget.visible || catalogId == null) {
      return const SizedBox.shrink();
    }
    return FutureBuilder<CompositionAlternativesResult>(
      future: _load(catalogId),
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const SizedBox.shrink();
        }
        final result = snapshot.data!;
        if (!result.hasRenderableAlternatives) {
          return const SizedBox.shrink();
        }
        return _CompositionAlternativesLoadedPanel(
          result: result,
          selectedLabel: widget.selectedLabel,
          doNotSubstitute: widget.doNotSubstitute,
          onSwap: widget.onSwap,
        );
      },
    );
  }
}

class _CompositionAlternativesLoadedPanel extends StatelessWidget {
  const _CompositionAlternativesLoadedPanel({
    required this.result,
    required this.doNotSubstitute,
    required this.onSwap,
    this.selectedLabel,
  });

  final CompositionAlternativesResult result;
  final bool doNotSubstitute;
  final String? selectedLabel;
  final CompositionAlternativeSwap onSwap;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    final subtitle = [
      if ((selectedLabel ?? '').trim().isNotEmpty) selectedLabel!.trim(),
      if (doNotSubstitute)
        s.lookup('s4.lib.composition_alternatives_panel.daw_info_only'),
    ].join(' - ');
    return Container(
      margin: const EdgeInsets.only(top: 8),
      decoration: BoxDecoration(
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 12),
        childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        leading: const Icon(Icons.compare_arrows, color: Color(0xFF00838F)),
        title: AppText(
          's4.lib.composition_alternatives_panel.composition_alternatives',
          style: theme.textTheme.titleSmall?.copyWith(
            color: AppTheme.textPrimary,
            fontWeight: FontWeight.w800,
          ),
        ),
        subtitle: subtitle.isEmpty
            ? null
            : Text(
                subtitle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: AppTheme.textSecondary),
              ),
        children: [
          for (final group in result.groups)
            if (group.items.isNotEmpty)
              _CompositionAlternativeGroupView(
                group: group,
                doNotSubstitute: doNotSubstitute,
                onSwap: onSwap,
              ),
        ],
      ),
    );
  }
}

class _CompositionAlternativeGroupView extends StatelessWidget {
  const _CompositionAlternativeGroupView({
    required this.group,
    required this.doNotSubstitute,
    required this.onSwap,
  });

  final CompositionAlternativeGroup group;
  final bool doNotSubstitute;
  final CompositionAlternativeSwap onSwap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            group.label,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w800,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 6),
          for (final item in group.items)
            _CompositionAlternativeTile(
              item: item,
              doNotSubstitute: doNotSubstitute,
              onSwap: onSwap,
            ),
        ],
      ),
    );
  }
}

class _CompositionAlternativeTile extends StatelessWidget {
  const _CompositionAlternativeTile({
    required this.item,
    required this.doNotSubstitute,
    required this.onSwap,
  });

  final CompositionAlternativeItem item;
  final bool doNotSubstitute;
  final CompositionAlternativeSwap onSwap;

  @override
  Widget build(BuildContext context) {
    final canSwap = item.substitutable && !doNotSubstitute;
    final detail = [
      if ((item.genericName ?? '').trim().isNotEmpty) item.genericName!.trim(),
      if ((item.manufacturer ?? '').trim().isNotEmpty)
        item.manufacturer!.trim(),
      item.stockLabel,
    ].join(' - ');
    final stockColor = item.inStock
        ? AppTheme.successOnSurface
        : item.availabilityStatus == 'may_be_available'
        ? AppTheme.warningOnSurface
        : AppTheme.errorOnSurface;
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(Icons.circle, size: 10, color: stockColor),
      title: Text(
        item.displayName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: AppTheme.textPrimary,
          fontWeight: FontWeight.w700,
        ),
      ),
      subtitle: Text(
        detail,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
      ),
      trailing: canSwap
          ? TextButton.icon(
              onPressed: () => onSwap(item),
              icon: const Icon(Icons.swap_horiz, size: 16),
              label: const AppText(
                's4.lib.composition_alternatives_panel.swap',
              ),
            )
          : _InfoOnlyPill(
              label: AppStrings.of(context).lookup(
                doNotSubstitute
                    ? 's4.lib.composition_alternatives_panel.daw_locked'
                    : 's4.lib.composition_alternatives_panel.info_only',
              ),
            ),
    );
  }
}

class _InfoOnlyPill extends StatelessWidget {
  const _InfoOnlyPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: AppTheme.warningOnSurface.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(
          color: AppTheme.warningOnSurface.withValues(alpha: 0.3),
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: AppTheme.warningOnSurface,
          fontWeight: FontWeight.w800,
          fontSize: 11,
        ),
      ),
    );
  }
}
