import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/desktop_scroll_controls.dart';
import '../../../core/widgets/staff_scaffold.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

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
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.lookup('s4.lib.organization_hierarchy.hospital_hierarchy'),
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
    final s = AppStrings.of(context);
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
        _SectionTitle(
          icon: Icons.rule_folder_outlined,
          title: s.lookup('s4.lib.organization_hierarchy.role_boundaries'),
          subtitle: s.lookup(
            's4.lib.organization_hierarchy.role_boundaries_subtitle',
          ),
        ),
        const SizedBox(height: 8),
        ...boundaries.map((boundary) => _BoundaryCard(boundary: boundary)),
        const SizedBox(height: 18),
        _SectionTitle(
          icon: Icons.verified_user_outlined,
          title: s.lookup('s4.lib.organization_hierarchy.guardrails'),
          subtitle: s.lookup(
            's4.lib.organization_hierarchy.guardrails_subtitle',
          ),
        ),
        const SizedBox(height: 8),
        _GuardrailList(items: guardrails),
        const SizedBox(height: 18),
        _SectionTitle(
          icon: Icons.auto_awesome_outlined,
          title: s.lookup(
            's4.lib.organization_hierarchy.suggested_improvements',
          ),
          subtitle: s.lookup(
            's4.lib.organization_hierarchy.suggested_improvements_subtitle',
          ),
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
    final s = AppStrings.of(context);
    final tenantScoped = data['tenant_scoped'] == true;
    final countsStatus = data['counts_status']?.toString() ?? 'unknown';
    final version = data['version']?.toString() ?? 'v1';
    final policyVersion = data['policy_version']?.toString();
    final policyHash = data['policy_hash']?.toString();
    final gitCommit = data['git_commit']?.toString();
    final shortPolicyHash = policyHash == null || policyHash.length < 12
        ? policyHash
        : policyHash.substring(0, 12);
    final shortCommit = gitCommit == null || gitCommit.length < 12
        ? gitCommit
        : gitCommit.substring(0, 12);

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
                      AppText(
                        's4.lib.organization_hierarchy.central_hierarchy_and_role_map',
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        data['design_note']?.toString() ??
                            s.lookup(
                              's4.lib.organization_hierarchy.design_note_fallback',
                            ),
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
                  label: tenantScoped
                      ? s.lookup('s4.lib.organization_hierarchy.tenant_scoped')
                      : s.lookup(
                          's4.lib.organization_hierarchy.tenant_unavailable',
                        ),
                  color: tenantScoped
                      ? AppTheme.successGreen
                      : AppTheme.warningOnSurface,
                ),
                _InfoPill(
                  icon: Icons.groups_outlined,
                  label: s.format(
                    's4.dynamic.organization_hierarchy.counts_status',
                    {'status': countsStatus},
                  ),
                  color: AppTheme.primaryTeal,
                ),
                if (policyVersion != null)
                  _InfoPill(
                    icon: Icons.verified_outlined,
                    label: policyVersion,
                    color: scheme.onSurfaceVariant,
                  ),
                if (shortPolicyHash != null)
                  _InfoPill(
                    icon: Icons.tag,
                    label: s.format(
                      's4.dynamic.organization_hierarchy.policy_hash',
                      {'hash': shortPolicyHash},
                    ),
                    color: scheme.onSurfaceVariant,
                  ),
                if (shortCommit != null)
                  _InfoPill(
                    icon: Icons.commit,
                    label: s.format(
                      's4.dynamic.organization_hierarchy.commit_hash',
                      {'hash': shortCommit},
                    ),
                    color: scheme.onSurfaceVariant,
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
    final s = AppStrings.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _LegendChip(
          type: 'governance',
          label: s.lookup(
            's4.lib.organization_hierarchy.legend.executive_governance',
          ),
        ),
        _LegendChip(
          type: 'work',
          label: s.lookup(
            's4.lib.organization_hierarchy.legend.daily_work_supervision',
          ),
        ),
        _LegendChip(
          type: 'leave',
          label: s.lookup(
            's4.lib.organization_hierarchy.legend.hr_leave_process',
          ),
        ),
        _LegendChip(
          type: 'leave_recommendation',
          label: s.lookup(
            's4.lib.organization_hierarchy.legend.coverage_advice',
          ),
        ),
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
        if (wide) {
          return _HierarchyFlowChart(
            nodes: nodes,
            edges: edges,
            viewportWidth: constraints.maxWidth,
          );
        }

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

const _treeNodeWidth = 270.0;
const _treeGap = 16.0;

class _HierarchyFlowChart extends StatelessWidget {
  final List<Map<String, dynamic>> nodes;
  final List<Map<String, dynamic>> edges;
  final double viewportWidth;

  const _HierarchyFlowChart({
    required this.nodes,
    required this.edges,
    required this.viewportWidth,
  });

  @override
  Widget build(BuildContext context) {
    final trees = _buildHierarchyTrees(nodes, edges);
    final contentWidth = math.max(
      viewportWidth,
      trees.fold<double>(0, (total, tree) => total + tree.width) +
          math.max(0, trees.length - 1) * _treeGap +
          28,
    );

    return Card(
      clipBehavior: Clip.antiAlias,
      child: DesktopScrollControls(
        axis: Axis.horizontal,
        child: SizedBox(
          width: contentWidth,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var i = 0; i < trees.length; i++) ...[
                  _HierarchyTreeBranch(tree: trees[i]),
                  if (i < trees.length - 1) const SizedBox(width: _treeGap),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _HierarchyTreeBranch extends StatelessWidget {
  final _HierarchyTreeNode tree;

  const _HierarchyTreeBranch({required this.tree});

  @override
  Widget build(BuildContext context) {
    final children = tree.children;
    return SizedBox(
      width: tree.width,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          SizedBox(
            width: _treeNodeWidth,
            child: _FlowNodeCard(
              node: tree.node,
              incomingEdges: [
                if (tree.incomingEdge != null) tree.incomingEdge!,
              ],
            ),
          ),
          if (children.isNotEmpty) ...[
            SizedBox(
              height: 32,
              width: tree.width,
              child: CustomPaint(
                painter: _TreeConnectorPainter(
                  childWidths: children.map((child) => child.width).toList(),
                ),
              ),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var i = 0; i < children.length; i++) ...[
                  _HierarchyTreeBranch(tree: children[i]),
                  if (i < children.length - 1) const SizedBox(width: _treeGap),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _TreeConnectorPainter extends CustomPainter {
  final List<double> childWidths;

  const _TreeConnectorPainter({required this.childWidths});

  @override
  void paint(Canvas canvas, Size size) {
    if (childWidths.isEmpty) return;
    final paint = Paint()
      ..color = AppTheme.primaryBlue.withValues(alpha: 0.45)
      ..strokeWidth = 1.4
      ..style = PaintingStyle.stroke;

    final parentX = size.width / 2;
    const jointY = 16.0;
    final childY = size.height;
    final totalChildrenWidth =
        childWidths.fold<double>(0, (total, width) => total + width) +
        math.max(0, childWidths.length - 1) * _treeGap;
    var cursor = (size.width - totalChildrenWidth) / 2;
    final childCenters = <double>[];
    for (final childWidth in childWidths) {
      childCenters.add(cursor + childWidth / 2);
      cursor += childWidth + _treeGap;
    }

    canvas.drawLine(Offset(parentX, 0), Offset(parentX, jointY), paint);
    canvas.drawLine(
      Offset(childCenters.first, jointY),
      Offset(childCenters.last, jointY),
      paint,
    );
    for (final center in childCenters) {
      canvas.drawLine(Offset(center, jointY), Offset(center, childY), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _TreeConnectorPainter oldDelegate) {
    if (oldDelegate.childWidths.length != childWidths.length) return true;
    for (var i = 0; i < childWidths.length; i++) {
      if (oldDelegate.childWidths[i] != childWidths[i]) return true;
    }
    return false;
  }
}

class _HierarchyTreeNode {
  final Map<String, dynamic> node;
  final Map<String, dynamic>? incomingEdge;
  final List<_HierarchyTreeNode> children;
  final double width;

  const _HierarchyTreeNode({
    required this.node,
    required this.incomingEdge,
    required this.children,
    required this.width,
  });
}

List<_HierarchyTreeNode> _buildHierarchyTrees(
  List<Map<String, dynamic>> nodes,
  List<Map<String, dynamic>> edges,
) {
  final byId = {
    for (final node in nodes)
      if (node['id'] != null) node['id'].toString(): node,
  };
  final treeEdges = edges.where(_isTreeEdge).toList();
  final childIds = treeEdges.map((edge) => edge['to']?.toString()).toSet();
  final childrenByParent = <String, List<Map<String, dynamic>>>{};
  for (final edge in treeEdges) {
    final from = edge['from']?.toString();
    final to = edge['to']?.toString();
    if (from == null || to == null || !byId.containsKey(to)) continue;
    childrenByParent.putIfAbsent(from, () => []).add(edge);
  }

  final rootIds = <String>[
    if (byId.containsKey('ceo_coo')) 'ceo_coo',
    ...nodes
        .map((node) => node['id']?.toString())
        .whereType<String>()
        .where((id) => id != 'ceo_coo' && !childIds.contains(id)),
  ];

  return rootIds
      .map(
        (id) => _buildHierarchyTreeNode(id, byId, childrenByParent, null, {}),
      )
      .whereType<_HierarchyTreeNode>()
      .toList();
}

_HierarchyTreeNode? _buildHierarchyTreeNode(
  String id,
  Map<String, Map<String, dynamic>> byId,
  Map<String, List<Map<String, dynamic>>> childrenByParent,
  Map<String, dynamic>? incomingEdge,
  Set<String> path,
) {
  final node = byId[id];
  if (node == null || path.contains(id)) return null;
  final nextPath = {...path, id};
  final children = (childrenByParent[id] ?? const [])
      .map(
        (edge) => _buildHierarchyTreeNode(
          edge['to'].toString(),
          byId,
          childrenByParent,
          edge,
          nextPath,
        ),
      )
      .whereType<_HierarchyTreeNode>()
      .toList();
  final childrenWidth = children.isEmpty
      ? 0.0
      : children.fold<double>(0, (total, child) => total + child.width) +
            (children.length - 1) * _treeGap;
  return _HierarchyTreeNode(
    node: node,
    incomingEdge: incomingEdge,
    children: children,
    width: math.max(_treeNodeWidth, childrenWidth),
  );
}

bool _isTreeEdge(Map<String, dynamic> edge) {
  final type = edge['type']?.toString();
  return type == 'governance' || type == 'work';
}

class _FlowNodeCard extends StatelessWidget {
  final Map<String, dynamic> node;
  final List<Map<String, dynamic>> incomingEdges;

  const _FlowNodeCard({required this.node, required this.incomingEdges});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = AppStrings.of(context);
    final roles = _stringsFrom(node, 'role_codes');
    final staff = _staffMembers(node);
    final count = node['active_staff_count']?.toString() ?? '${staff.length}';

    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () => _showStaffSheet(
        context,
        title:
            node['title']?.toString() ??
            s.lookup('s4.lib.organization_hierarchy.role_fallback'),
        subtitle: s.lookup(
          's4.lib.organization_hierarchy.current_enrolled_staff_for_role',
        ),
        staff: staff,
      ),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: scheme.outline.withValues(alpha: 0.22)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 8,
              offset: const Offset(0, 3),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    node['title']?.toString() ??
                        s.lookup('s4.lib.organization_hierarchy.role_fallback'),
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                _InfoPill(
                  icon: Icons.person_outline,
                  label: count,
                  color: AppTheme.primaryTeal,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              node['subtitle']?.toString() ?? '',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: roles
                  .map(
                    (role) => _RoleActionChip(
                      label: _roleDisplayLabel(context, role),
                      staff: _staffForRole(node, role),
                    ),
                  )
                  .toList(),
            ),
            if (incomingEdges.isNotEmpty) ...[
              const SizedBox(height: 8),
              _EdgeChip(
                type: incomingEdges.first['type']?.toString() ?? 'work',
                label:
                    incomingEdges.first['label']?.toString() ??
                    s.lookup('s4.lib.organization_hierarchy.reports_here'),
              ),
            ],
            const SizedBox(height: 10),
            _StaffPreview(staff: staff),
          ],
        ),
      ),
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
    final s = AppStrings.of(context);

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
                  lane['title']?.toString() ??
                      s.lookup(
                        's4.lib.organization_hierarchy.hierarchy_lane_fallback',
                      ),
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
    return _stringsFrom(node, key);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = AppStrings.of(context);
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
                      node['title']?.toString() ??
                          s.lookup(
                            's4.lib.organization_hierarchy.role_fallback',
                          ),
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
              ...roles.map(
                (role) => _RoleActionChip(
                  label: _roleDisplayLabel(context, role),
                  staff: _staffForRole(node, role),
                ),
              ),
              ...futureRoles.map(
                (role) => _RoleChip(
                  label: s.format(
                    's4.dynamic.organization_hierarchy.role_later',
                    {'role': _roleDisplayLabel(context, role)},
                  ),
                  muted: true,
                ),
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
                      label:
                          edge['label']?.toString() ??
                          s.lookup(
                            's4.lib.organization_hierarchy.reports_here',
                          ),
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
          const SizedBox(height: 8),
          _StaffPreview(staff: _staffMembers(node)),
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
    final s = AppStrings.of(context);
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
              boundary['title']?.toString() ??
                  s.lookup('s4.lib.organization_hierarchy.boundary_fallback'),
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: roles
                  .map(
                    (role) =>
                        _RoleChip(label: _roleDisplayLabel(context, role)),
                  )
                  .toList(),
            ),
            const SizedBox(height: 10),
            Text(
              boundary['scope']?.toString() ?? '',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 8),
            Text(
              s.format('s4.dynamic.organization_hierarchy.cannot_value', {
                'value': boundary['cannot'] ?? '',
              }),
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
    final s = AppStrings.of(context);

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
                    recommendation['title']?.toString() ??
                        s.lookup(
                          's4.lib.organization_hierarchy.suggestion_fallback',
                        ),
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

class _StaffPreview extends StatelessWidget {
  final List<Map<String, dynamic>> staff;

  const _StaffPreview({required this.staff});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = AppStrings.of(context);
    if (staff.isEmpty) {
      return AppText(
        's4.lib.organization_hierarchy.no_registered_staff_under_this_role_yet',
        style: theme.textTheme.bodySmall?.copyWith(
          color: scheme.onSurfaceVariant,
          fontStyle: FontStyle.italic,
        ),
      );
    }

    final visible = staff.take(2).toList();
    final remaining = staff.length - visible.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ...visible.map(
          (member) => Padding(
            padding: const EdgeInsets.only(bottom: 5),
            child: Row(
              children: [
                Icon(Icons.person, size: 15, color: scheme.onSurfaceVariant),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    _staffName(context, member),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        Text(
          remaining > 0
              ? s.format(
                  's4.dynamic.organization_hierarchy.tap_to_view_all_staff',
                  {'count': staff.length},
                )
              : s.lookup(
                  's4.lib.organization_hierarchy.tap_to_view_staff_details',
                ),
          style: theme.textTheme.bodySmall?.copyWith(
            color: AppTheme.primaryBlue,
            fontWeight: FontWeight.w800,
          ),
        ),
      ],
    );
  }
}

class _RoleActionChip extends StatelessWidget {
  final String label;
  final List<Map<String, dynamic>> staff;

  const _RoleActionChip({required this.label, required this.staff});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(999),
      onTap: () => _showStaffSheet(
        context,
        title: label,
        subtitle: AppStrings.of(context).format(
          's4.dynamic.organization_hierarchy.registered_staff_count',
          {'count': staff.length},
        ),
        staff: staff,
      ),
      child: _RoleChip(label: '$label (${staff.length})'),
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
    return _TextChip(label: label, color: color);
  }
}

void _showStaffSheet(
  BuildContext context, {
  required String title,
  required String subtitle,
  required List<Map<String, dynamic>> staff,
}) {
  showModalBottomSheet(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      maxChildSize: 0.92,
      minChildSize: 0.35,
      builder: (context, controller) => _StaffListSheet(
        title: title,
        subtitle: subtitle,
        staff: staff,
        controller: controller,
      ),
    ),
  );
}

class _StaffListSheet extends StatelessWidget {
  final String title;
  final String subtitle;
  final List<Map<String, dynamic>> staff;
  final ScrollController controller;

  const _StaffListSheet({
    required this.title,
    required this.subtitle,
    required this.staff,
    required this.controller,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          Expanded(
            child: staff.isEmpty
                ? Center(
                    child: AppText(
                      's4.lib.organization_hierarchy.no_registered_staff_found_under_this_role',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  )
                : ListView.separated(
                    controller: controller,
                    itemCount: staff.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) =>
                        _StaffMemberTile(member: staff[index]),
                  ),
          ),
        ],
      ),
    );
  }
}

class _StaffMemberTile extends StatelessWidget {
  final Map<String, dynamic> member;

  const _StaffMemberTile({required this.member});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final active = member['is_active'] != false;
    final role = _roleDisplayLabel(context, member['role']?.toString());
    final details = [
      _staffText(member, 'employee_id'),
      _staffText(member, 'department'),
      _staffText(member, 'position'),
      _staffText(member, 'current_status').replaceAll('_', ' '),
    ].where((item) => item.isNotEmpty).join(' • ');

    return ListTile(
      contentPadding: const EdgeInsets.symmetric(vertical: 6),
      leading: CircleAvatar(
        backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.14),
        child: Text(
          _staffName(context, member).isNotEmpty
              ? _staffName(context, member)[0].toUpperCase()
              : '?',
          style: const TextStyle(
            color: AppTheme.primaryBlue,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
      title: Text(
        _staffName(context, member),
        style: theme.textTheme.titleSmall?.copyWith(
          fontWeight: FontWeight.w800,
        ),
      ),
      subtitle: Text(details.isEmpty ? role : '$role\n$details'),
      isThreeLine: details.isNotEmpty,
      trailing: _InfoPill(
        icon: active ? Icons.check_circle_outline : Icons.pause_circle_outline,
        label: active
            ? AppStrings.of(context).lookup('staff_mgmt.active')
            : AppStrings.of(context).lookup('staff_mgmt.inactive'),
        color: active ? AppTheme.successGreen : scheme.onSurfaceVariant,
      ),
    );
  }
}

List<String> _stringsFrom(Map<String, dynamic> source, String key) {
  final value = source[key];
  if (value is! List) return const [];
  return value.map((item) => item.toString()).toList();
}

List<Map<String, dynamic>> _staffMembers(Map<String, dynamic> node) {
  final value = node['staff_members'];
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((item) => Map<String, dynamic>.from(item))
      .toList();
}

List<Map<String, dynamic>> _staffForRole(
  Map<String, dynamic> node,
  String role,
) {
  final normalized = role.trim().toUpperCase();
  return _staffMembers(node)
      .where((member) => member['role']?.toString().toUpperCase() == normalized)
      .toList();
}

String _staffText(Map<String, dynamic> member, String key) {
  final value = member[key];
  if (value == null) return '';
  return value.toString().trim();
}

String _staffName(BuildContext context, Map<String, dynamic> member) {
  return _staffText(member, 'name').isNotEmpty
      ? _staffText(member, 'name')
      : AppStrings.of(context)
            .lookup('s4.lib.organization_hierarchy.unnamed_staff');
}

String _roleDisplayLabel(BuildContext context, String? roleCode) {
  final raw = roleCode?.trim().toUpperCase() ?? '';
  if (raw.isEmpty) {
    return AppStrings.of(context).lookup('role.display.general_staff');
  }
  final key = 'role.display.${raw.toLowerCase()}';
  final label = AppStrings.of(context).lookup(key);
  return label == key ? raw.replaceAll('_', ' ') : label;
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
            label: const AppText('action.retry'),
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
