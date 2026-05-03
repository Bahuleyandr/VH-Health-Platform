import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/feedback_api_service.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// Shows the user's submitted feedback history and stats.
class FeedbackHistoryScreen extends StatefulWidget {
  const FeedbackHistoryScreen({super.key});

  @override
  State<FeedbackHistoryScreen> createState() => _FeedbackHistoryScreenState();
}

class _FeedbackHistoryScreenState extends State<FeedbackHistoryScreen> {
  List<dynamic> _feedback = [];
  String? _averageRating;
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
    final result = await FeedbackApiService.getMyFeedback();
    if (mounted) {
      setState(() {
        _loading = false;
        if (result != null && result['data'] != null) {
          _feedback = (result['data']['feedback'] ?? []) as List<dynamic>;
          _averageRating = result['data']['averageRating']?.toString();
        } else {
          _feedback = [];
          _error = result == null ? 'Failed to load feedback' : null;
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(AppLocalizations.of(context)!.feedbackHistoryTitle)),
      body: DataStateBuilder<dynamic>(
        isLoading: _loading,
        error: _error,
        data: _feedback,
        onRetry: _load,
        emptyIcon: Icons.feedback_outlined,
        emptyTitle: 'No feedback submitted yet',
        emptySubtitle: 'Your feedback history will appear here',
        builder: (context, feedback) => Column(
          children: [
            if (_averageRating != null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    const Icon(Icons.star, color: Colors.amber),
                    const SizedBox(width: 8),
                    Text(
                      'Average rating: $_averageRating',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ],
                ),
              ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView.separated(
                  itemCount: feedback.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final item = feedback[index] as Map<String, dynamic>;
                    final rating = item['rating'] as int? ?? 0;
                    final comment = item['comment'] as String? ?? '';
                    final category = item['category'] as String? ?? '';
                    final date = item['created_at'] as String? ?? '';
                    final doctor = item['doctor_name'] as String?;

                    return ListTile(
                      leading: CircleAvatar(
                        backgroundColor: rating >= 4
                            ? Colors.green
                            : rating <= 2
                            ? Colors.red
                            : Colors.orange,
                        child: Text(
                          '$rating',
                          style: const TextStyle(color: Colors.white),
                        ),
                      ),
                      title: Text(comment.isNotEmpty ? comment : '($category)'),
                      subtitle: Text(
                        [
                          if (doctor != null) 'Dr. $doctor',
                          if (date.length >= 10) date.substring(0, 10),
                        ].join(' · '),
                      ),
                    );
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
