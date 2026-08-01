import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../services/continuity_print_service.dart';
import '../services/staff_continuity_repository.dart';
import '../widgets/continuity_pack_view.dart';

class ContinuityCacheScreen extends StatefulWidget {
  final StaffContinuityRepository? repository;
  final ContinuityPrintService? printService;

  const ContinuityCacheScreen({super.key, this.repository, this.printService});

  @override
  State<ContinuityCacheScreen> createState() => _ContinuityCacheScreenState();
}

class _ContinuityCacheScreenState extends State<ContinuityCacheScreen> {
  late final StaffContinuityRepository _repository =
      widget.repository ?? StaffContinuityRepository.instance;
  late final ContinuityPrintService _printService =
      widget.printService ?? ContinuityPrintService();
  VerifiedClinicalContinuitySet? _set;
  String? _denial;
  bool _opening = true;
  int _selected = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  Future<void> _open() async {
    setState(() {
      _opening = true;
      _set = null;
      _denial = null;
      _selected = 0;
    });
    final decision = await _repository.openCached();
    if (!mounted) return;
    setState(() {
      _opening = false;
      _set = decision.verifiedSet;
      _denial = decision.denialReason;
      _selected = 0;
    });
  }

  Future<void> _refresh() async {
    await _repository.requestRefresh();
    if (!mounted) return;
    await _open();
  }

  @override
  void dispose() {
    unawaited(_repository.clearDecryptedState());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final set = _set;
    return StaffScaffold(
      title: strings.lookup('continuity.title'),
      actions: [
        IconButton(
          tooltip: strings.lookup('continuity.reconciliation.open'),
          onPressed: () => context.push('/clinical-continuity/reconciliation'),
          icon: const Icon(Icons.fact_check_outlined),
        ),
        IconButton(
          tooltip: strings.lookup('continuity.action.refresh'),
          onPressed: _opening ? null : _refresh,
          icon: const Icon(Icons.refresh),
        ),
        if (set != null && set.packs.isNotEmpty)
          IconButton(
            tooltip: strings.lookup('continuity.action.print'),
            onPressed: () => _print(set.packs[_selected]),
            icon: const Icon(Icons.print_outlined),
          ),
      ],
      body: _body(context),
    );
  }

  Widget _body(BuildContext context) {
    final strings = AppStrings.of(context);
    if (_opening) {
      return Center(
        child: Semantics(
          label: strings.lookup('continuity.loading'),
          child: const CircularProgressIndicator(),
        ),
      );
    }
    final set = _set;
    if (set == null) return _refusal(context, _denial);
    if (set.packs.isEmpty) {
      return _refusal(context, 'CACHE_NOT_AVAILABLE');
    }
    return Column(
      children: [
        if (set.packs.length > 1)
          SizedBox(
            height: 56,
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              scrollDirection: Axis.horizontal,
              itemCount: set.packs.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, index) {
                final pack = set.packs[index];
                return ChoiceChip(
                  label: Text(pack.locationLabel),
                  selected: _selected == index,
                  onSelected: (_) => setState(() => _selected = index),
                );
              },
            ),
          ),
        Expanded(
          child: ContinuityPackView(set: set, pack: set.packs[_selected]),
        ),
      ],
    );
  }

  Widget _refusal(BuildContext context, String? reason) {
    final strings = AppStrings.of(context);
    final messageKey = switch (reason) {
      ClinicalContinuityVerificationReasons.clockUncertain =>
        'continuity.refusal.clock',
      ClinicalContinuityVerificationReasons.packExpired =>
        'continuity.refusal.expired',
      'LOCAL_UNLOCK_POLICY_UNAVAILABLE' ||
      'LOCAL_AUTHORIZATION_EXPIRED' ||
      'DEVICE_BOUND_FACTOR_REQUIRED' => 'continuity.refusal.locked',
      _ => 'continuity.refusal.verification',
    };
    final message = strings.lookup(messageKey);
    final fallback = strings.lookup('continuity.refusal.paper_phone');
    return Center(
      child: Semantics(
        liveRegion: true,
        label: '$message $fallback',
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Card(
            margin: const EdgeInsets.all(24),
            color: const Color(0xffffe0b2),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const ExcludeSemantics(
                    child: Icon(
                      Icons.warning_amber_rounded,
                      size: 48,
                      color: Color(0xff7c2d12),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    message,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                      color: const Color(0xff431407),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    fallback,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: const Color(0xff431407),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _print(ClinicalContinuityPack pack) async {
    final strings = AppStrings.of(context);
    try {
      await _printService.printVerifiedPack(pack);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(strings.lookup('continuity.print_failed'))),
      );
    }
  }
}
