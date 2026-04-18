import 'package:flutter/material.dart';

class HeartbeatLogo extends StatefulWidget {
  const HeartbeatLogo({super.key});

  @override
  State<HeartbeatLogo> createState() => _HeartbeatLogoState();
}

class _HeartbeatLogoState extends State<HeartbeatLogo> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _heartbeat;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    )..repeat();

    _heartbeat = TweenSequence([
      TweenSequenceItem(tween: Tween(begin: 1.0, end: 1.15), weight: 10),
      TweenSequenceItem(tween: Tween(begin: 1.15, end: 1.0), weight: 10),
      TweenSequenceItem(tween: Tween(begin: 1.0, end: 1.12), weight: 8),
      TweenSequenceItem(tween: Tween(begin: 1.12, end: 1.0), weight: 8),
      TweenSequenceItem(tween: ConstantTween(1.0), weight: 64), // rest phase
    ]).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ScaleTransition(
      scale: _heartbeat,
      child: CircleAvatar(
        radius: 40,
        backgroundColor: Colors.white,
        child: Image.asset(
          'assets/images/hospital_icon.png',
          height: 64,
          fit: BoxFit.contain,
        ),
      ),
    );
  }
}
