// R15: the degraded-realtime indicator must actually consume the
// RealtimeClient degraded-state APIs (connectionState + deniedChannels)
// instead of leaving them Crashlytics-only.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/core/widgets/realtime_status_banner.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  final en = AppStrings.forLocale(const Locale('en'));
  final staleCopy = en.lookup('s4.lib.realtime_status.stale');
  final codeBlueDeniedCopy = en.lookup(
    's4.lib.realtime_status.code_blue_denied',
  );
  final bedsDeniedCopy = en.lookup('s4.lib.realtime_status.beds_denied');

  late StreamController<RealtimeConnectionState> stateChanges;
  late StreamController<Set<String>> deniedChanges;
  late RealtimeConnectionState state;
  late Set<String> denied;

  setUp(() {
    // sync controllers so each add() reaches the banner's listener before the
    // following pump — async delivery needs an extra event-loop turn, which
    // made back-to-back add/pump sequences nondeterministic.
    stateChanges = StreamController<RealtimeConnectionState>.broadcast(
      sync: true,
    );
    deniedChanges = StreamController<Set<String>>.broadcast(sync: true);
    state = RealtimeConnectionState.connected;
    denied = <String>{};
  });

  tearDown(() async {
    await stateChanges.close();
    await deniedChanges.close();
  });

  RealtimeStatusSource source() => RealtimeStatusSource(
    connectionStateOf: () => state,
    connectionStateChanges: stateChanges.stream,
    deniedChannelsOf: () => denied,
    deniedChannelsChanges: deniedChanges.stream,
  );

  Future<void> pumpBanner(
    WidgetTester tester, {
    Set<String> watchChannels = const {},
    String? deniedMessageKey,
    Future<void> Function()? fallbackPoll,
    Duration fallbackInterval = const Duration(seconds: 30),
  }) {
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RealtimeStatusBanner(
            watchChannels: watchChannels,
            deniedMessageKey: deniedMessageKey,
            source: source(),
            fallbackPoll: fallbackPoll,
            fallbackInterval: fallbackInterval,
          ),
        ),
      ),
    );
  }

  testWidgets('renders nothing while connected with no denials', (
    tester,
  ) async {
    await pumpBanner(tester);
    expect(find.text(staleCopy), findsNothing);
    expect(find.byType(Container), findsNothing);
  });

  testWidgets('shows the stale strip when the transport is degraded', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    state = RealtimeConnectionState.reconnecting;
    await pumpBanner(tester);
    expect(find.text(staleCopy), findsOneWidget);
    expect(
      tester.getSemantics(find.bySemanticsLabel(staleCopy)),
      isSemantics(label: staleCopy, isLiveRegion: true),
    );
    semantics.dispose();
  });

  testWidgets('reacts to connection-state transitions from the stream', (
    tester,
  ) async {
    await pumpBanner(tester);
    expect(find.text(staleCopy), findsNothing);

    stateChanges.add(RealtimeConnectionState.disconnected);
    await tester.pump();
    expect(find.text(staleCopy), findsOneWidget);

    stateChanges.add(RealtimeConnectionState.connected);
    await tester.pump();
    expect(find.text(staleCopy), findsNothing);
  });

  testWidgets('surfaces a denied watched channel while connected', (
    tester,
  ) async {
    await pumpBanner(
      tester,
      watchChannels: {'staff:code-blue'},
      deniedMessageKey: 's4.lib.realtime_status.code_blue_denied',
    );
    expect(find.text(codeBlueDeniedCopy), findsNothing);

    deniedChanges.add({'staff:code-blue'});
    await tester.pump();
    expect(find.text(codeBlueDeniedCopy), findsOneWidget);

    // Denial resolved (successful rejoin) — strip clears.
    deniedChanges.add(const <String>{});
    await tester.pump();
    expect(find.text(codeBlueDeniedCopy), findsNothing);
  });

  testWidgets('surfaces bed update denial as a live region', (tester) async {
    final semantics = tester.ensureSemantics();
    expect(
      bedsDeniedCopy,
      isNot('s4.lib.realtime_status.beds_denied'),
      reason: 'bed denial copy must be localized',
    );
    denied = {'staff:beds'};
    await pumpBanner(
      tester,
      watchChannels: {'staff:beds'},
      deniedMessageKey: 's4.lib.realtime_status.beds_denied',
    );

    expect(find.text(bedsDeniedCopy), findsOneWidget);
    expect(
      tester.getSemantics(find.bySemanticsLabel(bedsDeniedCopy)),
      isSemantics(label: bedsDeniedCopy, isLiveRegion: true),
    );
    semantics.dispose();
  });

  testWidgets('ignores denials of channels it is not watching', (tester) async {
    await pumpBanner(
      tester,
      watchChannels: {'staff:code-blue'},
      deniedMessageKey: 's4.lib.realtime_status.code_blue_denied',
    );
    deniedChanges.add({'staff:beds'});
    await tester.pump();
    expect(find.text(codeBlueDeniedCopy), findsNothing);
  });

  testWidgets('transport degradation outranks the denial strip', (
    tester,
  ) async {
    state = RealtimeConnectionState.reconnecting;
    denied = {'staff:code-blue'};
    await pumpBanner(
      tester,
      watchChannels: {'staff:code-blue'},
      deniedMessageKey: 's4.lib.realtime_status.code_blue_denied',
    );
    expect(find.text(staleCopy), findsOneWidget);
    expect(find.text(codeBlueDeniedCopy), findsNothing);
  });

  testWidgets('reads the initial denied set at mount', (tester) async {
    denied = {'staff:code-blue'};
    await pumpBanner(
      tester,
      watchChannels: {'staff:code-blue'},
      deniedMessageKey: 's4.lib.realtime_status.code_blue_denied',
    );
    expect(find.text(codeBlueDeniedCopy), findsOneWidget);
  });

  testWidgets('polls only while the realtime transport is degraded', (
    tester,
  ) async {
    var polls = 0;
    await pumpBanner(
      tester,
      fallbackInterval: const Duration(seconds: 5),
      fallbackPoll: () async => polls += 1,
    );

    await tester.pump(const Duration(seconds: 10));
    expect(polls, 0);

    stateChanges.add(RealtimeConnectionState.disconnected);
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(polls, 1);

    stateChanges.add(RealtimeConnectionState.connected);
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(polls, 1);
  });

  testWidgets('polls only while a watched realtime channel is denied', (
    tester,
  ) async {
    var polls = 0;
    await pumpBanner(
      tester,
      watchChannels: {'staff:appointments'},
      deniedMessageKey: 's4.lib.realtime_status.stale',
      fallbackInterval: const Duration(seconds: 5),
      fallbackPoll: () async => polls += 1,
    );

    deniedChanges.add({'staff:beds'});
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(polls, 0);

    deniedChanges.add({'staff:appointments'});
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(polls, 1);

    deniedChanges.add(const <String>{});
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(polls, 1);
  });

  testWidgets('a failed fallback poll does not stop later retries', (
    tester,
  ) async {
    var polls = 0;
    await pumpBanner(
      tester,
      fallbackInterval: const Duration(seconds: 5),
      fallbackPoll: () async {
        polls += 1;
        if (polls == 1) throw Exception('synthetic poll failure');
      },
    );

    stateChanges.add(RealtimeConnectionState.disconnected);
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(polls, 1);
    await tester.pump(const Duration(seconds: 5));
    expect(polls, 2);
  });
}
