import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/radiology_api_service.dart';
import '../../../core/theme/app_theme.dart';

class RadiologyScreen extends StatefulWidget {
  const RadiologyScreen({super.key});

  @override
  State<RadiologyScreen> createState() => _RadiologyScreenState();
}

class _RadiologyScreenState extends State<RadiologyScreen> {
  bool _loading = true;
  String? _error;
  List<dynamic> _orders = [];

  String _statusFilter = 'all';
  String _modalityFilter = 'all';

  static const _statusOptions = ['all', 'pending', 'in_progress', 'completed'];
  static const _modalityOptions = [
    'all',
    'X-Ray',
    'CT',
    'MRI',
    'Ultrasound',
    'PET',
  ];

  @override
  void initState() {
    super.initState();
    _fetchWorklist();
  }

  Future<void> _fetchWorklist() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final data = await RadiologyApiService.getWorklist(
        status: _statusFilter == 'all' ? null : _statusFilter,
        modality: _modalityFilter == 'all' ? null : _modalityFilter,
      );
      final list = data['orders'] as List? ?? data['data'] as List? ?? [];
      if (mounted) {
        setState(() {
          _orders = list;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Color _statusColor(String? status) {
    return switch (status?.toLowerCase()) {
      'pending' => AppTheme.primaryBlue,
      'in_progress' => AppTheme.warningAmber,
      'completed' => AppTheme.successGreen,
      'cancelled' => Colors.grey,
      _ => Colors.grey,
    };
  }

  String _statusLabel(String? status) {
    return switch (status?.toLowerCase()) {
      'pending' => 'Pending',
      'in_progress' => 'In Progress',
      'completed' => 'Completed',
      'cancelled' => 'Cancelled',
      _ => status ?? 'Unknown',
    };
  }

  Color _priorityColor(String? priority) {
    return switch (priority?.toLowerCase()) {
      'routine' => Colors.grey,
      'urgent' => AppTheme.warningAmber,
      'stat' => AppTheme.errorRed,
      _ => Colors.grey,
    };
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        title: const Text('Radiology'),
        actions: [
          IconButton(
            icon: const Icon(Icons.filter_list),
            onPressed: _showFilterSheet,
            tooltip: 'Filters',
          ),
        ],
      ),
      body: Column(
        children: [
          _buildFilterRow(),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildFilterRow() {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Expanded(
            child: DropdownButtonFormField<String>(
              initialValue: _statusFilter,
              decoration: const InputDecoration(
                labelText: 'Status',
                contentPadding: EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                isDense: true,
              ),
              items: _statusOptions.map((s) {
                return DropdownMenuItem(
                  value: s,
                  child: Text(s == 'all' ? 'All' : _statusLabel(s)),
                );
              }).toList(),
              onChanged: (v) {
                if (v != null) {
                  _statusFilter = v;
                  _fetchWorklist();
                }
              },
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: DropdownButtonFormField<String>(
              initialValue: _modalityFilter,
              decoration: const InputDecoration(
                labelText: 'Modality',
                contentPadding: EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                isDense: true,
              ),
              items: _modalityOptions.map((m) {
                return DropdownMenuItem(
                  value: m,
                  child: Text(m == 'all' ? 'All' : m),
                );
              }).toList(),
              onChanged: (v) {
                if (v != null) {
                  _modalityFilter = v;
                  _fetchWorklist();
                }
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(
                Icons.error_outline,
                size: 48,
                color: AppTheme.errorRed,
              ),
              const SizedBox(height: 16),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppTheme.textSecondary),
              ),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: _fetchWorklist,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (_loading) return const Center(child: CircularProgressIndicator());

    return RefreshIndicator(
      onRefresh: _fetchWorklist,
      child: _orders.isEmpty
          ? ListView(
              children: const [
                SizedBox(height: 120),
                Center(
                  child: Column(
                    children: [
                      Icon(
                        Icons.image_not_supported,
                        size: 64,
                        color: Colors.grey,
                      ),
                      SizedBox(height: 12),
                      Text(
                        'No radiology orders',
                        style: TextStyle(color: Colors.grey, fontSize: 16),
                      ),
                    ],
                  ),
                ),
              ],
            )
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: _orders.length,
              itemBuilder: (context, i) {
                final o = _orders[i] as Map<String, dynamic>;
                return _buildOrderCard(o);
              },
            ),
    );
  }

  Widget _buildOrderCard(Map<String, dynamic> o) {
    final status = o['status']?.toString();
    final priority = o['priority']?.toString();
    final patientUid = o['patient_uid']?.toString() ?? '';
    final displayUid = patientUid.length > 8
        ? '${patientUid.substring(0, 8)}...'
        : patientUid;
    final orderedDate =
        o['created_at']?.toString() ?? o['ordered_date']?.toString() ?? '';
    String dateStr = '';
    if (orderedDate.isNotEmpty) {
      try {
        dateStr = DateFormat('dd MMM yyyy').format(DateTime.parse(orderedDate));
      } catch (_) {
        dateStr = orderedDate;
      }
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _showDetailSheet(o),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '${o['study_type'] ?? 'Study'} - ${o['modality'] ?? ''}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: _priorityColor(priority).withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      (priority ?? 'routine').toUpperCase(),
                      style: TextStyle(
                        color: _priorityColor(priority),
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  const Icon(
                    Icons.person,
                    size: 14,
                    color: AppTheme.textSecondary,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    displayUid,
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                  const SizedBox(width: 16),
                  const Icon(
                    Icons.accessibility_new,
                    size: 14,
                    color: AppTheme.textSecondary,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    o['body_part']?.toString() ?? '-',
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: _statusColor(status).withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      _statusLabel(status),
                      style: TextStyle(
                        color: _statusColor(status),
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const Spacer(),
                  if (dateStr.isNotEmpty)
                    Text(
                      dateStr,
                      style: const TextStyle(fontSize: 11, color: Colors.grey),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showDetailSheet(Map<String, dynamic> o) {
    final status = o['status']?.toString().toLowerCase();
    final id = o['id'] as int?;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.55,
          maxChildSize: 0.85,
          builder: (_, scrollController) {
            return SingleChildScrollView(
              controller: scrollController,
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: Colors.grey[300],
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    '${o['study_type'] ?? 'Study'} - ${o['modality'] ?? ''}',
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 16),
                  _detailRow(
                    'Patient UID',
                    o['patient_uid']?.toString() ?? '-',
                  ),
                  _detailRow('Study Type', o['study_type']?.toString() ?? '-'),
                  _detailRow('Modality', o['modality']?.toString() ?? '-'),
                  _detailRow('Body Part', o['body_part']?.toString() ?? '-'),
                  _detailRow('Priority', o['priority']?.toString() ?? '-'),
                  _detailRow('Status', _statusLabel(status)),
                  _detailRow(
                    'Clinical Indication',
                    o['clinical_indication']?.toString() ?? '-',
                  ),
                  if (o['notes'] != null)
                    _detailRow('Notes', o['notes'].toString()),
                  if (o['report'] != null)
                    _detailRow('Report', o['report'].toString()),
                  if (o['findings'] != null)
                    _detailRow('Findings', o['findings'].toString()),
                  if (o['impression'] != null)
                    _detailRow('Impression', o['impression'].toString()),
                  const SizedBox(height: 24),
                  if (id != null) ...[
                    if (status == 'pending' || status == 'in_progress')
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: () {
                            Navigator.pop(ctx);
                            _showReportForm(id);
                          },
                          icon: const Icon(Icons.description),
                          label: const Text('Submit Report'),
                        ),
                      ),
                    if (status != 'completed' && status != 'cancelled') ...[
                      const SizedBox(height: 10),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: () => _cancelOrder(ctx, id),
                          icon: const Icon(Icons.cancel),
                          label: const Text('Cancel Order'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppTheme.errorRed,
                            side: const BorderSide(color: AppTheme.errorRed),
                          ),
                        ),
                      ),
                    ],
                  ],
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 140,
            child: Text(
              label,
              style: const TextStyle(
                color: AppTheme.textSecondary,
                fontSize: 13,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  void _showReportForm(int id) {
    final findingsCtrl = TextEditingController();
    final impressionCtrl = TextEditingController();

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return Padding(
          padding: EdgeInsets.only(
            left: 24,
            right: 24,
            top: 24,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.grey[300],
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'Submit Report',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: findingsCtrl,
                maxLines: 4,
                decoration: const InputDecoration(
                  labelText: 'Findings',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: impressionCtrl,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Impression',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () async {
                    final findings = findingsCtrl.text.trim();
                    final impression = impressionCtrl.text.trim();
                    if (findings.isEmpty) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Findings are required')),
                      );
                      return;
                    }
                    Navigator.pop(ctx);
                    try {
                      await RadiologyApiService.submitReport(id, {
                        'findings': findings,
                        'impression': impression,
                      });
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Report submitted')),
                        );
                      }
                      _fetchWorklist();
                    } catch (e) {
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text('Failed to submit: $e'),
                            backgroundColor: AppTheme.errorRed,
                          ),
                        );
                      }
                    }
                  },
                  child: const Text('Submit'),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _cancelOrder(BuildContext sheetCtx, int id) async {
    Navigator.pop(sheetCtx);
    try {
      await RadiologyApiService.cancelOrder(id);
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Order cancelled')));
      }
      _fetchWorklist();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to cancel: $e'),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  void _showFilterSheet() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Filters',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'Status',
                style: TextStyle(fontWeight: FontWeight.w500),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: _statusOptions.map((s) {
                  final selected = _statusFilter == s;
                  return ChoiceChip(
                    label: Text(s == 'all' ? 'All' : _statusLabel(s)),
                    selected: selected,
                    onSelected: (_) {
                      setState(() => _statusFilter = s);
                      Navigator.pop(ctx);
                      _fetchWorklist();
                    },
                  );
                }).toList(),
              ),
              const SizedBox(height: 16),
              const Text(
                'Modality',
                style: TextStyle(fontWeight: FontWeight.w500),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: _modalityOptions.map((m) {
                  final selected = _modalityFilter == m;
                  return ChoiceChip(
                    label: Text(m == 'all' ? 'All' : m),
                    selected: selected,
                    onSelected: (_) {
                      setState(() => _modalityFilter = m);
                      Navigator.pop(ctx);
                      _fetchWorklist();
                    },
                  );
                }).toList(),
              ),
              const SizedBox(height: 16),
            ],
          ),
        );
      },
    );
  }
}
