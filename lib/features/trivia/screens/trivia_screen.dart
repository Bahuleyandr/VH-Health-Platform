import 'dart:math';
import 'package:flutter/material.dart';

import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/services/sos_service.dart';

class TriviaScreen extends StatefulWidget {
  const TriviaScreen({super.key});

  @override
  State<TriviaScreen> createState() => _TriviaScreenState();
}

class _TriviaScreenState extends State<TriviaScreen> {
  late String _currentTriviaKey;

  final List<String> _triviaKeys = List.generate(10, (i) => 'trivia.fact${i + 1}');
  final String heroTag = 'trivia';

  @override
  void initState() {
    super.initState();
    _pickRandomTrivia();
  }

  void _pickRandomTrivia() {
    final random = Random();
    setState(() {
      _currentTriviaKey = _triviaKeys[random.nextInt(_triviaKeys.length)];
    });
  }

  String _translateTrivia(AppLocalizations l10n) {
    switch (_currentTriviaKey) {
      case 'trivia.fact1': return l10n.triviaFact1;
      case 'trivia.fact2': return l10n.triviaFact2;
      case 'trivia.fact3': return l10n.triviaFact3;
      case 'trivia.fact4': return l10n.triviaFact4;
      case 'trivia.fact5': return l10n.triviaFact5;
      case 'trivia.fact6': return l10n.triviaFact6;
      case 'trivia.fact7': return l10n.triviaFact7;
      case 'trivia.fact8': return l10n.triviaFact8;
      case 'trivia.fact9': return l10n.triviaFact9;
      case 'trivia.fact10': return l10n.triviaFact10;
      default: return _currentTriviaKey;
    }
  }

  Future<void> _triggerSOS() async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(l10n.authSosTriggered),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
    await SOSService.triggerSOS();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final color = FeatureScreenScaffold.featureColors['trivia']!;

    return FeatureScreenScaffold(
      title: l10n.triviaTitle,
      icon: Icons.emoji_objects_outlined,
      color: color,
      heroTag: heroTag,
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.sos_outlined),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            l10n.triviaDidYouKnow,
            style: theme.textTheme.headlineSmall?.copyWith(
              color: cs.primary,
              fontWeight: FontWeight.bold,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
            decoration: BoxDecoration(
              color: cs.surfaceContainerHighest.withOpacity(.75),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: cs.outline.withOpacity(.4)),
            ),
            child: Text(
              _translateTrivia(l10n),
              style: theme.textTheme.bodyLarge?.copyWith(
                color: cs.onSurfaceVariant,
                height: 1.5,
              ),
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(height: 40),
          ElevatedButton.icon(
            onPressed: _pickRandomTrivia,
            icon: const Icon(Icons.refresh_outlined, size: 22),
            label: Text(l10n.triviaNewTriviaButton),
            style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
            ),
          ),
        ],
      ),
    );
  }
}
