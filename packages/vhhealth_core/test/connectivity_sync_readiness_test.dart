import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/models/client_readiness.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/offline_queue.dart';

import 'helpers/offline_queue_test_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late OfflineQueueTestHarness harness;
  final service = ConnectivitySyncService.instance;

  setUp(() async {
    harness = OfflineQueueTestHarness('connectivity_sync_readiness');
    await harness.setUp();
    await AuthService.setStaffId('staff-1');
    await AuthService.setJwt('test-jwt');
  });

  tearDown(() async {
    VHHttpClient.resetClientForTesting();
    await service.resetForTesting();
    await harness.tearDown();
  });

  test(
    'failed readiness leaves clinical retry counts and C0A rows unchanged',
    () async {
      var probes = 0;
      await service.resetForTesting(
        readinessProbe: () async {
          probes++;
          return ClientReadinessOutcome.notReady;
        },
      );
      final id = await service.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: const {'pulse': 70},
      );
      final before = Map<String, Object?>.from(
        (await OfflineQueue.debugAllRows()).single,
      );
      var clinicalRequests = 0;
      VHHttpClient.setClientForTesting(
        MockClient((_) async {
          clinicalRequests++;
          return http.Response('{"data":{}}', 200);
        }),
      );

      await service.syncPending();

      final after = (await OfflineQueue.debugAllRows()).single;
      expect(probes, 1);
      expect(clinicalRequests, 0);
      expect(after, before);
      expect(after['id'], id);
      expect(after['status'], 'pending');
      expect(after['retry_count'], 0);
      expect(service.pendingCount, 1);
      expect(service.conflictCount, 0);
      expect(service.needsReviewCount, 0);
      expect(
        service.continuityLifecycleState,
        ContinuityLifecycleState.notReady,
      );
    },
  );

  test('successful readiness enters the unchanged scoped drain', () async {
    await service.resetForTesting(
      readinessProbe: () async => ClientReadinessOutcome.alwaysReadyForTesting,
    );
    await service.enqueue(
      endpoint: '/emr/notes/draft',
      method: 'PUT',
      body: const {'text': 'safe draft'},
    );
    var clinicalRequests = 0;
    VHHttpClient.setClientForTesting(
      MockClient((_) async {
        clinicalRequests++;
        return http.Response('{"data":{}}', 200);
      }),
    );

    await service.syncPending();

    expect(clinicalRequests, 1);
    expect(await OfflineQueue.debugAllRows(), isEmpty);
    expect(
      service.continuityLifecycleState,
      ContinuityLifecycleState.readyPublic,
    );
  });

  test(
    'session barrier raised during readiness prevents drain entry',
    () async {
      final probeStarted = Completer<void>();
      final probeResult = Completer<ClientReadinessOutcome>();
      await service.resetForTesting(
        readinessProbe: () {
          probeStarted.complete();
          return probeResult.future;
        },
      );
      await service.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: const {'pulse': 70},
      );

      final sync = service.syncPending();
      await probeStarted.future;
      await service.beginSessionBarrier();
      probeResult.complete(ClientReadinessOutcome.alwaysReadyForTesting);
      await sync;

      final row = (await OfflineQueue.debugAllRows()).single;
      expect(row['status'], 'pending');
      expect(row['retry_count'], 0);
      expect(service.isSessionBarrierActive, isTrue);
      expect(
        service.continuityLifecycleState,
        ContinuityLifecycleState.notReady,
      );
      service.endSessionBarrier();
    },
  );

  test(
    'later wakes coalesce into one follow-up readiness evaluation',
    () async {
      final firstStarted = Completer<void>();
      final firstResult = Completer<ClientReadinessOutcome>();
      var probes = 0;
      await service.resetForTesting(
        readinessProbe: () {
          probes++;
          if (probes == 1) {
            firstStarted.complete();
            return firstResult.future;
          }
          return Future.value(ClientReadinessOutcome.notReady);
        },
      );

      final first = service.syncPending();
      await firstStarted.future;
      final second = service.syncPending();
      final third = service.syncPending();
      firstResult.complete(ClientReadinessOutcome.notReady);
      await Future.wait([first, second, third]);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(probes, 2);
    },
  );

  test(
    'transport wake events use the 750ms-style injectable debounce',
    () async {
      var probes = 0;
      await service.resetForTesting(
        readinessDebounce: const Duration(milliseconds: 25),
        readinessProbe: () async {
          probes++;
          return ClientReadinessOutcome.notReady;
        },
      );

      service.setTransportAvailableForTesting(false);
      service.setTransportAvailableForTesting(true);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      service.setTransportAvailableForTesting(true);
      await Future<void>.delayed(const Duration(milliseconds: 15));
      expect(probes, 0);

      await Future<void>.delayed(const Duration(milliseconds: 25));
      expect(probes, 1);
    },
  );
}
