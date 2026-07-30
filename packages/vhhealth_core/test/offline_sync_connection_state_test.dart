import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/widgets/offline_sync_badge.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;
  final service = ConnectivitySyncService.instance;

  setUp(() async {
    harness = OfflineQueueTestHarness('offline_sync_connection_state');
    await harness.setUp();
    await service.resetForTesting();
    await AuthService.setStaffId('staff-1');
    await AuthService.setJwt('test-jwt');
  });

  tearDown(() async {
    await service.resetForTesting();
    await harness.tearDown();
  });

  testWidgets('sheet exposes transport and continuity as separate axes', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    service.setConnectionStateForTesting(
      transport: ClientTransportState.available,
      continuity: ContinuityLifecycleState.readyInternal,
      routeKind: ClientReadinessRouteKind.internal,
    );

    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: SyncStatusSheet())),
    );
    for (var attempt = 0; attempt < 10; attempt++) {
      await tester.pump(const Duration(milliseconds: 50));
      if (find.text('Transport — available').evaluate().isNotEmpty) break;
    }

    expect(find.text('Transport — available'), findsOneWidget);
    expect(find.text('Continuity — ready via internal route'), findsOneWidget);
    expect(find.text('Online'), findsNothing);
    expect(
      find.bySemanticsLabel(RegExp('Transport — available')),
      findsOneWidget,
    );
    expect(
      find.bySemanticsLabel(RegExp('Continuity — ready via internal route')),
      findsOneWidget,
    );

    service.setConnectionStateForTesting(
      transport: ClientTransportState.unavailable,
      continuity: ContinuityLifecycleState.clockUncertain,
    );
    await tester.pump();

    expect(find.text('Transport — unavailable'), findsOneWidget);
    expect(find.text('Continuity — device clock uncertain'), findsOneWidget);
    expect(
      find.bySemanticsLabel(RegExp('Continuity — device clock uncertain')),
      findsOneWidget,
    );
    semantics.dispose();
  });
}
