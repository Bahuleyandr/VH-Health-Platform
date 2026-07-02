class CompositionAlternativesResult {
  const CompositionAlternativesResult({
    required this.selected,
    required this.groups,
    required this.alternatives,
  });

  final CompositionAlternativeSelection? selected;
  final List<CompositionAlternativeGroup> groups;
  final List<CompositionAlternativeItem> alternatives;

  bool get hasRenderableAlternatives =>
      selected != null && groups.any((group) => group.items.isNotEmpty);

  factory CompositionAlternativesResult.fromJson(Map<String, dynamic> json) {
    final selectedRaw = json['selected'];
    final groupsRaw = json['groups'];
    final alternativesRaw = json['alternatives'];
    return CompositionAlternativesResult(
      selected: selectedRaw is Map
          ? CompositionAlternativeSelection.fromJson(
              selectedRaw.cast<String, dynamic>(),
            )
          : null,
      groups: groupsRaw is List
          ? groupsRaw
                .whereType<Map>()
                .map(
                  (row) => CompositionAlternativeGroup.fromJson(
                    row.cast<String, dynamic>(),
                  ),
                )
                .toList(growable: false)
          : const [],
      alternatives: alternativesRaw is List
          ? alternativesRaw
                .whereType<Map>()
                .map(
                  (row) => CompositionAlternativeItem.fromJson(
                    row.cast<String, dynamic>(),
                  ),
                )
                .toList(growable: false)
          : const [],
    );
  }
}

class CompositionAlternativeSelection {
  const CompositionAlternativeSelection({
    required this.catalogId,
    this.compositionId,
    this.compositionLabel,
    this.strength,
    this.strengthKey,
    this.form,
    this.formKey,
    this.releaseKey,
  });

  final int catalogId;
  final int? compositionId;
  final String? compositionLabel;
  final String? strength;
  final String? strengthKey;
  final String? form;
  final String? formKey;
  final String? releaseKey;

  factory CompositionAlternativeSelection.fromJson(Map<String, dynamic> json) {
    return CompositionAlternativeSelection(
      catalogId: _asInt(json['catalog_id']) ?? _asInt(json['id']) ?? 0,
      compositionId: _asInt(json['composition_id']),
      compositionLabel: _asString(json['composition_label']),
      strength: _asString(json['strength']),
      strengthKey: _asString(json['strength_key']),
      form: _asString(json['form']),
      formKey: _asString(json['form_key']),
      releaseKey: _asString(json['release_key']),
    );
  }
}

class CompositionAlternativeGroup {
  const CompositionAlternativeGroup({
    this.strength,
    this.strengthKey,
    this.form,
    this.formKey,
    required this.matched,
    required this.items,
  });

  final String? strength;
  final String? strengthKey;
  final String? form;
  final String? formKey;
  final bool matched;
  final List<CompositionAlternativeItem> items;

  String get label {
    final bits = [
      if ((strength ?? '').trim().isNotEmpty) strength!.trim(),
      if ((form ?? '').trim().isNotEmpty) form!.trim(),
    ];
    if (bits.isEmpty) {
      bits.addAll([
        if ((strengthKey ?? '').trim().isNotEmpty) strengthKey!.trim(),
        if ((formKey ?? '').trim().isNotEmpty) formKey!.trim(),
      ]);
    }
    final base = bits.isEmpty ? 'Same composition' : bits.join(' / ');
    return matched ? '$base - matched strength/form' : base;
  }

  factory CompositionAlternativeGroup.fromJson(Map<String, dynamic> json) {
    final itemsRaw = json['items'];
    return CompositionAlternativeGroup(
      strength: _asString(json['strength']),
      strengthKey: _asString(json['strength_key']),
      form: _asString(json['form']),
      formKey: _asString(json['form_key']),
      matched: json['matched'] == true,
      items: itemsRaw is List
          ? itemsRaw
                .whereType<Map>()
                .map(
                  (row) => CompositionAlternativeItem.fromJson(
                    row.cast<String, dynamic>(),
                  ),
                )
                .toList(growable: false)
          : const [],
    );
  }
}

class CompositionAlternativeItem {
  const CompositionAlternativeItem({
    required this.catalogId,
    this.name,
    this.manufacturer,
    this.genericName,
    this.strength,
    this.strengthKey,
    this.form,
    this.formKey,
    this.releaseKey,
    this.route,
    this.stockQuantity,
    required this.availabilityStatus,
    required this.substitutable,
  });

  final int catalogId;
  final String? name;
  final String? manufacturer;
  final String? genericName;
  final String? strength;
  final String? strengthKey;
  final String? form;
  final String? formKey;
  final String? releaseKey;
  final String? route;
  final int? stockQuantity;
  final String availabilityStatus;
  final bool substitutable;

  bool get inStock => availabilityStatus == 'in_stock';

  String get displayName =>
      (name ?? genericName ?? 'Catalog item #$catalogId').trim();

  String get stockLabel {
    if (availabilityStatus == 'in_stock') {
      final count = stockQuantity;
      return count != null && count > 0 ? 'In stock ($count)' : 'In stock';
    }
    if (availabilityStatus == 'may_be_available') return 'May be available';
    return 'Out of stock';
  }

  Map<String, dynamic> toCatalogRow({
    int? compositionId,
    String? compositionLabel,
    String compositionConfidence = 'high',
  }) {
    return {
      'id': catalogId,
      'catalog_id': catalogId,
      'name': name,
      'generic_name': genericName,
      'manufacturer': manufacturer,
      'strength': strength,
      'strength_key': strengthKey,
      'form': form,
      'form_key': formKey,
      'release_key': releaseKey,
      'route': route,
      'stock_quantity': stockQuantity,
      'stock': stockQuantity,
      'in_stock':
          availabilityStatus == 'in_stock' ||
          availabilityStatus == 'may_be_available',
      'composition_id': compositionId,
      'composition_label': compositionLabel,
      'composition_confidence': compositionConfidence,
    };
  }

  factory CompositionAlternativeItem.fromJson(Map<String, dynamic> json) {
    return CompositionAlternativeItem(
      catalogId: _asInt(json['catalog_id']) ?? _asInt(json['id']) ?? 0,
      name: _asString(json['name']),
      manufacturer: _asString(json['manufacturer']),
      genericName: _asString(json['generic_name']),
      strength: _asString(json['strength']),
      strengthKey: _asString(json['strength_key']),
      form: _asString(json['form']),
      formKey: _asString(json['form_key']),
      releaseKey: _asString(json['release_key']),
      route: _asString(json['route']),
      stockQuantity: _asInt(json['stock_quantity'] ?? json['stock']),
      availabilityStatus:
          _asString(json['availability_status']) ?? 'out_of_stock',
      substitutable: json['substitutable'] == true,
    );
  }
}

bool shouldShowCompositionAlternativesPanel({
  required int? catalogId,
  required String? compositionConfidence,
}) {
  return catalogId != null &&
      (compositionConfidence ?? '').trim().toLowerCase() == 'high';
}

int? _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

String? _asString(Object? value) {
  final text = value?.toString().trim() ?? '';
  if (text.isEmpty || text.toLowerCase() == 'null') return null;
  return text;
}
