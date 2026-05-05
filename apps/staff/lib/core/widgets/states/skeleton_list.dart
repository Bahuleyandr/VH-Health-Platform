import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

/// Shimmer-style placeholder list shown while a list endpoint is fetching.
///
/// Renders [itemCount] ghost rows that pulse between two grey shades.
/// Replaces plain `CircularProgressIndicator`s on list screens — gives
/// staff a sense of "the list is coming, here's roughly how it'll look"
/// instead of a frozen spinner.
///
/// Width-fixed height per row so the list doesn't reflow when real data
/// lands. [itemHeight] defaults to 88 (matches a typical Card with
/// title + subtitle + trailing widget).
class SkeletonList extends StatefulWidget {
  final int itemCount;
  final double itemHeight;
  final EdgeInsets padding;
  const SkeletonList({
    super.key,
    this.itemCount = 6,
    this.itemHeight = 88,
    this.padding = const EdgeInsets.all(16),
  });

  @override
  State<SkeletonList> createState() => _SkeletonListState();
}

class _SkeletonListState extends State<SkeletonList>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = AppTheme.brightness == Brightness.dark;
    final base = isDark ? const Color(0xFF2A2D31) : const Color(0xFFE8EAF0);
    final highlight = isDark
        ? const Color(0xFF34373C)
        : const Color(0xFFF6F7F9);
    // Honour the OS "Reduce motion" / "Disable animations" preference.
    // Some users find the constant pulse triggering for vestibular
    // sensitivity; we keep the placeholder layout but freeze the colour.
    final reduceMotion = MediaQuery.disableAnimationsOf(context);

    return Semantics(
      // Tell screen readers this is a loading state so they don't try
      // to announce all the placeholder rows.
      label: 'Loading…',
      liveRegion: true,
      child: ListView.separated(
        padding: widget.padding,
        itemCount: widget.itemCount,
        separatorBuilder: (_, _) => const SizedBox(height: 12),
        itemBuilder: (context, _) {
          return AnimatedBuilder(
            animation: _ctrl,
            builder: (context, _) {
              final t = reduceMotion ? 0.5 : _ctrl.value;
              return Container(
                height: widget.itemHeight,
                decoration: BoxDecoration(
                  color: Color.lerp(base, highlight, t),
                  borderRadius: BorderRadius.circular(12),
                ),
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: Color.lerp(highlight, base, t),
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Container(
                            height: 12,
                            width: 180,
                            decoration: BoxDecoration(
                              color: Color.lerp(highlight, base, t),
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Container(
                            height: 10,
                            width: 110,
                            decoration: BoxDecoration(
                              color: Color.lerp(highlight, base, t),
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              );
            },
          );
        },
      ),
    );
  }
}

/// Grid variant of [SkeletonList] used by the Bed Board.
class SkeletonGrid extends StatefulWidget {
  final int itemCount;
  final int crossAxisCount;
  final double childAspectRatio;
  final EdgeInsets padding;
  const SkeletonGrid({
    super.key,
    this.itemCount = 8,
    this.crossAxisCount = 2,
    this.childAspectRatio = 1.3,
    this.padding = const EdgeInsets.all(16),
  });

  @override
  State<SkeletonGrid> createState() => _SkeletonGridState();
}

class _SkeletonGridState extends State<SkeletonGrid>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = AppTheme.brightness == Brightness.dark;
    final base = isDark ? const Color(0xFF2A2D31) : const Color(0xFFE8EAF0);
    final highlight = isDark
        ? const Color(0xFF34373C)
        : const Color(0xFFF6F7F9);
    // Same reduce-motion treatment as SkeletonList.
    final reduceMotion = MediaQuery.disableAnimationsOf(context);

    return Semantics(
      label: 'Loading…',
      liveRegion: true,
      child: GridView.builder(
        padding: widget.padding,
        gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: widget.crossAxisCount,
          childAspectRatio: widget.childAspectRatio,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
        ),
        itemCount: widget.itemCount,
        itemBuilder: (context, _) {
          return AnimatedBuilder(
            animation: _ctrl,
            builder: (context, _) {
              final t = reduceMotion ? 0.5 : _ctrl.value;
              return Container(
                decoration: BoxDecoration(
                  color: Color.lerp(base, highlight, t),
                  borderRadius: BorderRadius.circular(12),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
