import 'package:flutter/material.dart';

import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class OrganizationHierarchyScreen extends StatefulWidget {
  const OrganizationHierarchyScreen({super.key});

  @override
  State<OrganizationHierarchyScreen> createState() =>
      _OrganizationHierarchyScreenState();
}

class _OrganizationHierarchyScreenState
    extends State<OrganizationHierarchyScreen> {
  Map<String, dynamic>? _data;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await HrApiService.getOrganizationHierarchy();
      if (mounted) setState(() => _data = data);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Hospital hierarchy',
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
            ? _ErrorState(message: _error!, onRetry: _load)
            : _HierarchyBody(data: _data ?? const {}),
      ),
    );
  }
}

class _HierarchyBody extends StatelessWidget {
  final Map<String, dynamic> data;

  const _HierarchyBody({required this.data});

  List<Map<String, dynamic>> _maps(String key) {
    final value = data[key];
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final lanes = _maps('lanes');
    final nodes = _maps('nodes');
    final edges = _maps('edges');
    final boundaries = _maps('role_boundaries');
    final recommendations = _maps('recommendations');
    final guardrails = (data['guardrails'] as List? ?? const [])
        .map((item) => item.toString())
        .toList();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _OverviewCard(data: data),
        const SizedBox(height: 14),
        const _RelationshipLegend(),
        const SizedBox(height: 14),
        _LaneChart(lanes: lanes, nodes: nodes, edges: edges),
        const SizedBox(height: 18),
        const _SectionTitle(
          icon: Icons.rule_folder_outlined,
          title: 'Role boundaries',
          subtitle: 'What each authority line can and cannot do.',
        ),
        const SizedBox(height: 8),
        ...boundaries.map((boundary) => _BoundaryCard(boundary: boundary)),
        const SizedBox(height: 18),
        const _SectionTitle(
          icon: Icons.verified_user_outlined,
          title: 'Guardrails',
          subtitle: 'Rules that prevent roles from overstepping.',
        ),
        const SizedBox(height: 8),
        _GuardrailList(items: guardrails),
        const SizedBox(height: 18),
        const _SectionTitle(
          icon: Icons.auto_awesome_outlined,
          title: 'Suggested improvements',
          subtitle: 'A cleaner structure for hospital-scale operations.',
        ),
        const SizedBox(height: 8),
        ...recommendations.map(
          (item) => _RecommendationCard(recommendation: item),
        ),
      ],
    );
  }
}

class _OverviewCard extends StatelessWidget {
  final Map<String, dynamic> data;

  const _OverviewCard({required this.data});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final tenantScoped = data['tenant_scoped'] == true;
    final countsStatus = data['counts_status']?.toString() ?? 'unknown';
    final version = data['version']?.toString() ?? 'v1';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: AppTheme.primaryBlue.withValues(alpha: 0.16),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(
                    Icons.account_tree_outlined,
                    color: AppTheme.primaryBlue,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Central hierarchy and role map',
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        data['design_note']?.toString() ??
                            'Access, work supervision, and leave approval are separate.',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _InfoPill(
                  icon: Icons.label_outline,
                  label: version,
                  color: AppTheme.primaryBlue,
                ),
                _InfoPill(
                  icon: tenantScoped
                      ? Icons.domain_verification_outlined
                      : Icons.warning_amber_outlined,
                  label: tenantScoped ? 'Tenant scoped' : 'Tenant unavailable',
                  color: tenantScoped
                      ? AppTheme.successGreen
                      : AppTheme.warningOnSurface,
                ),
                _InfoPill(
                  icon: Icons.groups_outlined,
                  label: 'Counts: $countsStatus',
                  color: AppTheme.primaryTeal,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _RelationshipLegend extends StatelessWidget {
  const _RelationshipLegend();

  @override
  Widget build(BuildContext context) {
    return const Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _LegendChip(type: 'governance', label: 'Executive / governance'),
        _LegendChip(type: 'work', label: 'Daily work supervision'),
        _LegendChip(type: 'leave', label: 'HR leave process'),
        _LegendChip(type: 'leave_recommendation', label: 'Coverage advice'),
      ],
    );
  }
}

class _LaneChart extends StatelessWidget {
  final List<Map<String, dynamic>> lanes;
  final List<Map<String, dynamic>> nodes;
  final List<Map<String, dynamic>> edges;

  const _LaneChart({
    required this.lanes,
    required this.nodes,
    required this.edges,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 900;
        final itemWidth = wide
            ? (constraints.maxWidth - 12) / 2
            : constraints.maxWidth;

        return Wrap(
          spacing: 12,
          runSpacing: 12,
          children: lanes.map((lane) {
            final laneId = lane['id']?.toString();
            final laneNodes = nodes
                .where((node) => node['lane']?.toString() == laneId)
                .toList();
            return SizedBox(
              width: itemWidth,
              child: _LaneCard(lane: lane, nodes: laneNodes, edges: edges),
            );
          }).toList(),
        );
      },
    );
  }
}

class _LaneCard extends StatelessWidget {
  final Map<String, dynamic> lane;
  final List<Map<String, dynamic>> nodes;
  final List<Map<String, dynamic>> edges;

  const _LaneCard({
    required this.lane,
    required this.nodes,
    required this.edges,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: scheme.primaryContainer.withValues(alpha: 0.45),
              border: Border(
                bottom: BorderSide(
                  color: scheme.outline.withValues(alpha: 0.18),
                ),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  lane['title']?.toString() ?? 'Hierarchy lane',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  lane['description']?.toString() ?? '',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              children: nodes.map((node) {
                final incoming = edges
                    .where((edge) => edge['to']?.toString() == node['id'])
                    .toList();
                return _HierarchyNodeCard(node: node, incomingEdges: incoming);
              }).toList(),
            ),
          ),
        ],
      ),
    );
  }
}

class _HierarchyNodeCard extends StatelessWidget {
  final Map<String, dynamic> node;
  final List<Map<String, dynamic>> incomingEdges;

  const _HierarchyNodeCard({required this.node, required this.incomingEdges});

  List<String> _strings(String key) {
    final value = node[key];
    if (value is! List) return const [];
    return value.map((item) => item.toString()).toList();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final roles = _strings('role_codes');
    final futureRoles = _strings('recommended_role_codes');
    final responsibilities = _strings('responsibilities');
    final boundaries = _strings('boundaries');
    final count = node['active_staff_count']?.toString() ?? '0';

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.outline.withValues(alpha: 0.18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      node['title']?.toString() ?? 'Role',
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      node['subtitle']?.toString() ?? '',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              _InfoPill(
                icon: Icons.person_outline,
                label: count,
                color: AppTheme.primaryTeal,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              ...roles.map((role) => _RoleChip(label: role)),
              ...futureRoles.map(
                (role) => _RoleChip(label: '$role later', muted: true),
              ),
            ],
          ),
          if (incomingEdges.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: incomingEdges
                  .map(
                    (edge) => _EdgeChip(
                      type: edge['type']?.toString() ?? 'work',
                      label: edge['label']?.toString() ?? 'Reports here',
                    ),
                  )
                  .toList(),
            ),
          ],
          if (responsibilities.isNotEmpty) ...[
            const SizedBox(height: 10),
            _MiniList(
              icon: Icons.task_alt,
              color: AppTheme.successGreen,
              items: responsibilities,
            ),
          ],
          if (boundaries.isNotEmpty) ...[
            const SizedBox(height: 8),
            _MiniList(
              icon: Icons.block_outlined,
              color: AppTheme.warningOnSurface,
              items: boundaries,
            ),
          ],
        ],
      ),
    );
  }
}

class _BoundaryCard extends StatelessWidget {
  final Map<String, dynamic> boundary;

  const _BoundaryCard({required this.boundary});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final roles = (boundary['role_codes'] as List? ?? const [])
        .map((item) => item.toString())
        .toList();

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              boundary['title']?.toString() ?? 'Boundary',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: roles.map((role) => _RoleChip(label: role)).toList(),
            ),
            const SizedBox(height: 10),
            Text(
              boundary['scope']?.toString() ?? '',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Cannot: ${boundary['cannot'] ?? ''}',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.error,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GuardrailList extends StatelessWidget {
  final List<String> items;

  const _GuardrailList({required this.items});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          children: items
              .map(
                (item) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(
                        Icons.check_circle_outline,
                        color: AppTheme.successGreen,
                        size: 18,
                      ),
                      const SizedBox(width: 8),
                      Expanded(child: Text(item)),
                    ],
                  ),
                ),
              )
              .toList(),
        ),
      ),
    );
  }
}

class _RecommendationCard extends StatelessWidget {
  final Map<String, dynamic> recommendation;

  const _RecommendationCard({required this.recommendation});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.lightbulb_outline, color: AppTheme.warningOnSurface),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    recommendation['title']?.toString() ?? 'Suggestion',
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    recommendation['detail']?.toString() ?? '',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;

  const _SectionTitle({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AppTheme.primaryBlue),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              Text(
                subtitle,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _MiniList extends StatelessWidget {
  final IconData icon;
  final Color color;
  final List<String> items;

  const _MiniList({
    required this.icon,
    required this.color,
    required this.items,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      children: items
          .map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(icon, color: color, size: 16),
                  const SizedBox(width: 6),
                  Expanded(child: Text(item, style: theme.textTheme.bodySmall)),
                ],
              ),
            ),
          )
          .toList(),
    );
  }
}

class _RoleChip extends StatelessWidget {
  final String label;
  final bool muted;

  const _RoleChip({required this.label, this.muted = false});

  @override
  Widget build(BuildContext context) {
    final color = muted ? AppTheme.textSecondary : AppTheme.primaryBlue;
    return _TextChip(label: label.replaceAll('_', ' '), color: color);
  }
}

class _LegendChip extends StatelessWidget {
  final String type;
  final String label;

  const _LegendChip({required this.type, required this.label});

  @override
  Widget build(BuildContext context) {
    return _TextChip(label: label, color: _colorForType(type));
  }
}

class _EdgeChip extends StatelessWidget {
  final String type;
  final String label;

  const _EdgeChip({required this.type, required this.label});

  @override
  Widget build(BuildContext context) {
    return _TextChip(label: label, color: _colorForType(type));
  }
}

class _InfoPill extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _InfoPill({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: color, size: 15),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w800,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}

class _TextChip extends StatelessWidget {
  final String label;
  final Color color;

  const _TextChip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const SizedBox(height: 80),
        const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 42),
        const SizedBox(height: 12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium,
        ),
        const SizedBox(height: 12),
        Center(
          child: OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ),
      ],
    );
  }
}

Color _colorForType(String type) {
  return switch (type) {
    'governance' => AppTheme.primaryBlue,
    'leave' => AppTheme.warningOnSurface,
    'leave_recommendation' => const Color(0xFF8E24AA),
    _ => AppTheme.primaryTeal,
  };
}
