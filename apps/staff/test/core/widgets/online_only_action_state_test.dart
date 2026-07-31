import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_staff/core/widgets/online_only_action_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    await ConnectivitySyncService.instance.resetForTesting();
  });

  tearDown(() async {
    await ConnectivitySyncService.instance.resetForTesting();
  });

  testWidgets('reactively disables an online-only control while offline', (
    tester,
  ) async {
    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.unavailable,
      continuity: ContinuityLifecycleState.notReady,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: OnlineOnlyActionState(
            builder: (context, isOnline, offlineMessage) => Column(
              children: [
                Text(isOnline ? 'online' : offlineMessage),
                FilledButton(
                  onPressed: isOnline ? () {} : null,
                  child: const Text('Commit'),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    expect(
      find.text(
        'Reconnect to continue. This action cannot be completed offline.',
      ),
      findsOneWidget,
    );
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
  });

  testWidgets('press-time guard shows the shared offline explanation', (
    tester,
  ) async {
    ConnectivitySyncService.instance.setConnectionStateForTesting(
      transport: ClientTransportState.unavailable,
      continuity: ContinuityLifecycleState.notReady,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => FilledButton(
            onPressed: () => OnlineOnlyActionGuard.require(context),
            child: const Text('Commit'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Commit'));
    await tester.pumpAndSettle();

    expect(find.text('Online connection required'), findsOneWidget);
    expect(
      find.text(
        'Reconnect to continue. This action cannot be completed offline.',
      ),
      findsOneWidget,
    );
  });
}
