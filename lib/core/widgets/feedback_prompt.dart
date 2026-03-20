import 'dart:async'; // Add this import for TimeoutException
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/config/api_config.dart';

class FeedbackPrompt extends StatefulWidget {
  final String phone;
  final String refId;
  final String type; // appointment, pharmacy, investigation

  const FeedbackPrompt({
    super.key,
    required this.phone,
    required this.refId,
    required this.type,
  });

  @override
  State<FeedbackPrompt> createState() => _FeedbackPromptState();
}

class _FeedbackPromptState extends State<FeedbackPrompt> {
  static const Duration _requestTimeout = Duration(seconds: 10);
  
  int _rating = 0;
  final _commentController = TextEditingController();
  bool _submitting = false;
  DateTime? _lastSubmitTime;

  @override
  void dispose() {
    _commentController.dispose();
    super.dispose();
  }

  Future<void> _submitFeedback() async {
    // Prevent double submission
    if (_submitting) return;
    
    // Debounce check
    final now = DateTime.now();
    if (_lastSubmitTime != null && 
        now.difference(_lastSubmitTime!) < const Duration(seconds: 2)) {
      return;
    }

    if (_rating == 0) {
      _showSnackBar('Please select a rating.');
      return;
    }

    setState(() => _submitting = true);
    _lastSubmitTime = now;

    try {
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/feedback'),
        headers: ApiConfig.jsonHeaders,
        body: jsonEncode({
          'phone': widget.phone,
          'ref_id': widget.refId,
          'type': widget.type,
          'rating': _rating,
          'comment': _commentController.text.trim(),
        }),
      ).timeout(_requestTimeout);

      if (!mounted) return;

      if (response.statusCode == 200) {
        _showSnackBar('Thank you for your feedback!', isSuccess: true);
        context.pop();
      } else {
        _showSnackBar('Failed to submit feedback. Please try again.');
      }
    } on TimeoutException catch (_) {
      _showSnackBar('Request timed out. Please try again.');
    } on http.ClientException catch (_) {
      _showSnackBar('Network error. Please check your connection.');
    } catch (e) {
      _showSnackBar('An error occurred. Please try again.');
      debugPrint('Feedback submission error: $e');
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  void _showSnackBar(String message, {bool isSuccess = false}) {
    if (!mounted) return;
    
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isSuccess ? Colors.green : null,
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.all(16),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Container(
      height: MediaQuery.of(context).size.height * 0.5,
      padding: EdgeInsets.fromLTRB(
        16,
        16,
        16,
        MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Drag handle
          Container(
            width: 40,
            height: 4,
            margin: const EdgeInsets.only(bottom: 16),
            decoration: BoxDecoration(
              color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.4),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          
          Text(
            'Rate your experience',
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 16),
          
          // Star rating
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(5, (i) {
              final isSelected = i < _rating;
              return IconButton(
                icon: Icon(
                  isSelected ? Icons.star_rounded : Icons.star_outline_rounded,
                  size: 40,
                ),
                color: isSelected ? Colors.amber : theme.colorScheme.outline,
                onPressed: _submitting ? null : () => setState(() => _rating = i + 1),
              );
            }),
          ),
          const SizedBox(height: 24),
          
          // Comment field
          TextField(
            controller: _commentController,
            decoration: InputDecoration(
              labelText: 'Comments (optional)',
              hintText: 'Share your experience...',
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              enabled: !_submitting,
            ),
            maxLines: 3,
            maxLength: 500,
            textCapitalization: TextCapitalization.sentences,
          ),
          const SizedBox(height: 24),
          
          // Submit button
          SizedBox(
            width: double.infinity,
            height: 48,
            child: ElevatedButton(
              onPressed: _submitting ? null : _submitFeedback,
              style: ElevatedButton.styleFrom(
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: _submitting
                  ? const SizedBox(
                      width: 24,
                      height: 24,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Submit Feedback'),
            ),
          ),
        ],
      ),
    );
  }
}