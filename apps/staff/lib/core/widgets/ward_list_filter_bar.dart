import 'package:flutter/material.dart';

import '../../l10n/app_strings.dart';

class WardListFilterOption {
  const WardListFilterOption({required this.value, required this.label});

  final String value;
  final String label;
}

class WardListFilterBar extends StatelessWidget {
  const WardListFilterBar({
    super.key,
    required this.wardOptions,
    required this.selectedWardValue,
    required this.onWardChanged,
    required this.filterLabel,
    required this.filterOptions,
    required this.selectedFilterValue,
    required this.onFilterChanged,
    required this.onClear,
    this.hasActiveFilters = false,
    this.wardLabel,
    this.clearTooltip,
    this.keyPrefix = 'ward-list',
    this.padding = const EdgeInsets.fromLTRB(16, 8, 16, 8),
  });

  final List<WardListFilterOption> wardOptions;
  final String selectedWardValue;
  final ValueChanged<String> onWardChanged;
  final String? wardLabel;
  final String filterLabel;
  final List<WardListFilterOption> filterOptions;
  final String selectedFilterValue;
  final ValueChanged<String> onFilterChanged;
  final VoidCallback onClear;
  final bool hasActiveFilters;
  final String? clearTooltip;
  final String keyPrefix;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final theme = Theme.of(context);
    final wardValue = _valueInOptions(selectedWardValue, wardOptions);
    final filterValue = _valueInOptions(selectedFilterValue, filterOptions);
    final effectiveWardLabel =
        wardLabel ?? strings.lookup('s4.lib.ward_list_filter_bar.ward');
    final effectiveClearTooltip =
        clearTooltip ??
        strings.lookup('s4.lib.ward_list_filter_bar.clear_filters');

    return Padding(
      padding: padding,
      child: Row(
        children: [
          Expanded(
            child: _FilterDropdown(
              key: Key('$keyPrefix-ward-filter'),
              label: effectiveWardLabel,
              icon: Icons.local_hospital_outlined,
              value: wardValue,
              options: wardOptions,
              onChanged: onWardChanged,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: _FilterDropdown(
              key: Key('$keyPrefix-secondary-filter'),
              label: filterLabel,
              icon: Icons.tune_outlined,
              value: filterValue,
              options: filterOptions,
              onChanged: onFilterChanged,
            ),
          ),
          const SizedBox(width: 8),
          Tooltip(
            message: effectiveClearTooltip,
            child: IconButton.filledTonal(
              key: Key('$keyPrefix-clear-filters'),
              onPressed: hasActiveFilters ? onClear : null,
              icon: const Icon(Icons.filter_alt_off_outlined),
              style: IconButton.styleFrom(
                fixedSize: const Size.square(44),
                foregroundColor: hasActiveFilters
                    ? theme.colorScheme.primary
                    : theme.disabledColor,
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _valueInOptions(String value, List<WardListFilterOption> options) {
    return options.any((option) => option.value == value)
        ? value
        : (options.isEmpty ? '' : options.first.value);
  }
}

class _FilterDropdown extends StatelessWidget {
  const _FilterDropdown({
    super.key,
    required this.label,
    required this.icon,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  final String label;
  final IconData icon;
  final String value;
  final List<WardListFilterOption> options;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return DropdownButtonFormField<String>(
      initialValue: value,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: label,
        prefixIcon: ExcludeSemantics(child: Icon(icon, size: 20)),
        border: const OutlineInputBorder(),
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 12,
        ),
      ),
      items: options
          .map(
            (option) => DropdownMenuItem<String>(
              value: option.value,
              child: Text(option.label, overflow: TextOverflow.ellipsis),
            ),
          )
          .toList(),
      onChanged: options.isEmpty ? null : (value) => onChanged(value ?? ''),
    );
  }
}
