import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class FeatureScreenScaffold extends StatefulWidget {
  final String title;
  final IconData icon;
  final Color color;
  final Widget child;
  final String? heroTag;
  final Widget? floatingActionButton;
  final List<Widget>? actions;

  /// Whether the body is wrapped in a SingleChildScrollView. Default
  /// is `false` because almost every screen here uses a Column with
  /// Expanded children (lists, tabs, page views) — those collapse to
  /// zero height when wrapped in a scroll view. Set explicitly to
  /// `true` only for screens whose child is short, fixed-height content
  /// (e.g. a settings/info card list with no Expanded children).
  final bool scrollable;

  const FeatureScreenScaffold({
    super.key,
    required this.title,
    required this.icon,
    required this.color,
    required this.child,
    this.heroTag,
    this.floatingActionButton,
    this.actions,
    this.scrollable = false,
  });

  static const Map<String, Color> featureColors = {
    'your-health': Color(0xFFA8E6CF),
    'appointments': Color(0xFFB3E5FC),
    'pharmacy': Color(0xFFD1C4E9),
    'investigations': Color(0xFF80DEEA),
    'ask-a-doubt': Color(0xFFFFE082),
    'trivia': Color(0xFF9FA8DA),
    'departments': Color(0xFFC5E1A5),
    'about-us': Color(0xFFFFCCBC),
  };

  @override
  State<FeatureScreenScaffold> createState() => _FeatureScreenScaffoldState();
}

class _FeatureScreenScaffoldState extends State<FeatureScreenScaffold>
    with SingleTickerProviderStateMixin {
  late final AnimationController _fadeController;

  @override
  void initState() {
    super.initState();
    _fadeController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    )..forward();
  }

  @override
  void dispose() {
    _fadeController.dispose();
    super.dispose();
  }

  void _goBack() {
    if (context.canPop()) {
      context.pop();
    } else {
      context.go('/home');
    }
  }

  @override
  Widget build(BuildContext context) {
    final isWide = MediaQuery.of(context).size.width > 600;
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      floatingActionButton: widget.floatingActionButton,
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              theme.scaffoldBackgroundColor,
              widget.color.withAlpha(26), // ~0.1 alpha
              widget.color.withAlpha(51), // ~0.2 alpha
              widget.color.withAlpha(77), // ~0.3 alpha
            ],
            stops: const [0.0, 0.3, 0.7, 1.0],
          ),
        ),
        child: SafeArea(
          child: FadeTransition(
            opacity: _fadeController,
            child: Column(
              children: [
                // App Bar
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8.0,
                    vertical: 8.0,
                  ),
                  child: Row(
                    children: [
                      // Back button
                      IconButton(
                        icon: const Icon(Icons.arrow_back),
                        onPressed: _goBack,
                        color: widget.color,
                      ),
                      const SizedBox(width: 8),
                      // Hero icon
                      Hero(
                        tag: widget.heroTag ?? widget.title,
                        child: Material(
                          color: Colors.transparent,
                          child: Icon(
                            widget.icon,
                            size: 32,
                            color: widget.color,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      // Title
                      Expanded(
                        child: Text(
                          widget.title,
                          style: theme.textTheme.titleLarge?.copyWith(
                            color: widget.color,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                      // Actions
                      if (widget.actions != null) ...widget.actions!,
                    ],
                  ),
                ),

                // Scrollable content with watermark
                Expanded(
                  child: Stack(
                    children: [
                      // Icon watermark - positioned absolutely
                      Positioned(
                        bottom: 80,
                        left: 0,
                        right: 0,
                        child: Center(
                          child: Icon(
                            widget.icon,
                            size: 140,
                            color: widget.color.withAlpha(20), // ~0.08 alpha
                          ),
                        ),
                      ),
                      // Main content — scroll-wrapped or full-height
                      // depending on widget.scrollable. Tabbed / list /
                      // page-view children need full-height parents.
                      widget.scrollable
                          ? SingleChildScrollView(
                              padding: const EdgeInsets.all(16.0),
                              child: Center(
                                child: _GlassCard(
                                  isWide: isWide,
                                  color: widget.color,
                                  surface: theme.colorScheme.surface,
                                  child: widget.child,
                                ),
                              ),
                            )
                          : Padding(
                              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                              child: _GlassCard(
                                isWide: isWide,
                                color: widget.color,
                                surface: theme.colorScheme.surface,
                                fillHeight: true,
                                child: widget.child,
                              ),
                            ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Frosted-glass card used by [FeatureScreenScaffold]. Pulled out so
/// the scrollable / non-scrollable branches in the parent can share the
/// same visual treatment.
class _GlassCard extends StatelessWidget {
  final bool isWide;
  final Color color;
  final Color surface;
  final Widget child;
  final bool fillHeight;

  const _GlassCard({
    required this.isWide,
    required this.color,
    required this.surface,
    required this.child,
    this.fillHeight = false,
  });

  @override
  Widget build(BuildContext context) {
    final card = Container(
      constraints: BoxConstraints(maxWidth: isWide ? 600 : double.infinity),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
          child: Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: surface.withAlpha(179), // ~0.7 alpha
              borderRadius: BorderRadius.circular(24),
              border: Border.all(
                color: color.withAlpha(51), // ~0.2 alpha
                width: 1,
              ),
              boxShadow: [
                BoxShadow(
                  color: color.withAlpha(26), // ~0.1 alpha
                  blurRadius: 10,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: child,
          ),
        ),
      ),
    );
    return fillHeight ? SizedBox.expand(child: card) : card;
  }
}
