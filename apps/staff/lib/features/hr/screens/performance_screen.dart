import 'package:flutter/material.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// Performance Reviews screen — HR/Admin manages staff performance records.
/// TODO: Integrate with backend when /staff/hr/performance endpoint is available.
class PerformanceScreen extends StatefulWidget {
  const PerformanceScreen({super.key});

  @override
  State<PerformanceScreen> createState() => _PerformanceScreenState();
}

class _PerformanceScreenState extends State<PerformanceScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Performance Reviews',
      body: Column(
        children: [
          Container(
            color: Colors.white,
            child: TabBar(
              controller: _tabController,
              labelColor: const Color(0xFFF57F17),
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: const Color(0xFFF57F17),
              tabs: const [
                Tab(text: 'Add Review'),
                Tab(text: 'Reviews'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: const [_AddReviewTab(), _ReviewListTab()],
            ),
          ),
        ],
      ),
    );
  }
}

class _AddReviewTab extends StatefulWidget {
  const _AddReviewTab();

  @override
  State<_AddReviewTab> createState() => _AddReviewTabState();
}

class _AddReviewTabState extends State<_AddReviewTab> {
  final _formKey = GlobalKey<FormState>();
  final _employeeIdCtrl = TextEditingController();
  final _commentsCtrl = TextEditingController();
  final _goalsCtrl = TextEditingController();
  double _overallRating = 3.0;
  String _reviewPeriod = 'Q1 2026';
  bool _submitting = false;

  static const _periods = [
    'Q1 2025',
    'Q2 2025',
    'Q3 2025',
    'Q4 2025',
    'Q1 2026',
    'Q2 2026',
    'Q3 2026',
    'Q4 2026',
    'Annual 2025',
    'Annual 2026',
  ];

  @override
  void dispose() {
    _employeeIdCtrl.dispose();
    _commentsCtrl.dispose();
    _goalsCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      await HrApiService.createPerformanceReview(
        staffId: _employeeIdCtrl.text.trim(),
        period: _reviewPeriod,
        overallRating: _overallRating,
        comments: _commentsCtrl.text.trim(),
        goals: _goalsCtrl.text.trim().isNotEmpty
            ? _goalsCtrl.text.trim()
            : null,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('✅ Performance review saved'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _formKey.currentState!.reset();
        setState(() => _overallRating = 3.0);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Employee ID
                TextFormField(
                  controller: _employeeIdCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Employee ID',
                    hintText: 'e.g. EMP-001',
                    prefixIcon: Icon(Icons.badge_outlined),
                  ),
                  validator: (v) => (v == null || v.trim().isEmpty)
                      ? 'Employee ID is required'
                      : null,
                ),
                const SizedBox(height: 14),

                // Review period
                DropdownButtonFormField<String>(
                  initialValue: _reviewPeriod,
                  decoration: const InputDecoration(
                    labelText: 'Review Period',
                    prefixIcon: Icon(Icons.date_range_outlined),
                  ),
                  items: _periods
                      .map((p) => DropdownMenuItem(value: p, child: Text(p)))
                      .toList(),
                  onChanged: (v) => setState(() => _reviewPeriod = v!),
                ),
                const SizedBox(height: 20),

                // Overall rating
                const Text(
                  'Overall Rating',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textPrimary,
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Expanded(
                      child: Slider(
                        value: _overallRating,
                        min: 1,
                        max: 5,
                        divisions: 8,
                        activeColor: const Color(0xFFF57F17),
                        onChanged: (v) => setState(() => _overallRating = v),
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF57F17).withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.star,
                            color: Color(0xFFF57F17),
                            size: 16,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            _overallRating.toStringAsFixed(1),
                            style: const TextStyle(
                              fontWeight: FontWeight.bold,
                              color: Color(0xFFF57F17),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                _RatingLabel(rating: _overallRating),
                const SizedBox(height: 14),

                // Comments
                TextFormField(
                  controller: _commentsCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Performance Comments',
                    hintText:
                        'Describe performance, achievements, areas of improvement...',
                    prefixIcon: Icon(Icons.comment_outlined),
                    alignLabelWithHint: true,
                  ),
                  maxLines: 4,
                  validator: (v) => (v == null || v.trim().isEmpty)
                      ? 'Comments are required'
                      : null,
                ),
                const SizedBox(height: 14),

                // Goals
                TextFormField(
                  controller: _goalsCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Goals for Next Period (optional)',
                    hintText: 'Set goals and expectations...',
                    prefixIcon: Icon(Icons.flag_outlined),
                    alignLabelWithHint: true,
                  ),
                  maxLines: 3,
                ),
                const SizedBox(height: 24),

                ElevatedButton.icon(
                  onPressed: _submitting ? null : _submit,
                  icon: _submitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            color: Colors.white,
                            strokeWidth: 2,
                          ),
                        )
                      : const Icon(Icons.save, color: Colors.white),
                  label: Text(_submitting ? 'Saving...' : 'Save Review'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFFF57F17),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RatingLabel extends StatelessWidget {
  final double rating;
  const _RatingLabel({required this.rating});

  @override
  Widget build(BuildContext context) {
    final label = switch (rating) {
      >= 4.5 => 'Exceptional',
      >= 3.5 => 'Exceeds Expectations',
      >= 2.5 => 'Meets Expectations',
      >= 1.5 => 'Needs Improvement',
      _ => 'Unsatisfactory',
    };
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 12,
          fontStyle: FontStyle.italic,
          color: AppTheme.textSecondary,
        ),
      ),
    );
  }
}

class _ReviewListTab extends StatefulWidget {
  const _ReviewListTab();

  @override
  State<_ReviewListTab> createState() => _ReviewListTabState();
}

class _ReviewListTabState extends State<_ReviewListTab> {
  List<dynamic> _reviews = [];
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
      final data = await HrApiService.getPerformanceReport();
      _reviews =
          data['reviews'] as List? ??
          data['reports'] as List? ??
          data['data'] as List? ??
          [];
    } catch (e) {
      _error = e.toString().replaceFirst('Exception: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 40),
            const SizedBox(height: 8),
            Text(
              _error!,
              style: const TextStyle(color: AppTheme.textSecondary),
            ),
            TextButton(onPressed: _load, child: const Text('Retry')),
          ],
        ),
      );
    }
    if (_reviews.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.star_rate_outlined,
              size: 56,
              color: AppTheme.textSecondary,
            ),
            SizedBox(height: 16),
            Text(
              'No reviews yet',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _reviews.length,
        itemBuilder: (_, i) {
          final r = _reviews[i];
          final name =
              r['staffName'] ?? r['staff_id'] ?? r['employeeId'] ?? '—';
          final period = r['period'] ?? '—';
          final rating = r['overall_rating'] ?? r['overallRating'] ?? 0;
          final comments = r['comments'] ?? '';
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          name.toString(),
                          style: const TextStyle(
                            fontWeight: FontWeight.bold,
                            color: AppTheme.textPrimary,
                          ),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF57F17).withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(
                              Icons.star,
                              color: Color(0xFFF57F17),
                              size: 14,
                            ),
                            const SizedBox(width: 2),
                            Text(
                              rating.toString(),
                              style: const TextStyle(
                                fontWeight: FontWeight.bold,
                                color: Color(0xFFF57F17),
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    period,
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                  if (comments.toString().isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(
                      comments.toString(),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
