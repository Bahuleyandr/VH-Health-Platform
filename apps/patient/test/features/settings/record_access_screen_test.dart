import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/settings/models/record_access_grant.dart';
import 'package:vhhealth/features/settings/screens/record_access_screen.dart';
import 'package:vhhealth/features/settings/services/record_access_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

void main() {
  testWidgets('shows active, revoked, and held record access grants', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: RecordAccessScreen(
          repository: _FakeRecordAccessRepository(
            grantedByMe: [
              _grant(
                id: 1,
                proxyUid: '11111111-1111-4111-8111-111111111111',
                relationship: 'Spouse',
                status: 'active',
                grantedAt: DateTime.utc(2026, 7, 1, 8, 30),
              ),
              _grant(
                id: 2,
                proxyUid: '22222222-2222-4222-8222-222222222222',
                relationship: 'Caregiver',
                status: 'revoked',
                grantedAt: DateTime.utc(2026, 6, 1, 8, 30),
                revokedAt: DateTime.utc(2026, 6, 10, 8, 30),
              ),
            ],
            heldByMe: [
              const HeldRecordAccessGrant(
                id: 8,
                patientUid: '33333333-3333-4333-8333-333333333333',
                relationship: 'Mother',
                scope: ['results'],
                status: 'active',
                grantedAt: null,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('People who can see my records'), findsOneWidget);
    expect(find.text('Spouse'), findsOneWidget);
    expect(find.text('Caregiver'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Records shared with me'), 300);
    expect(find.text('Records shared with me'), findsOneWidget);
    expect(find.text('Mother'), findsOneWidget);
    expect(find.textContaining('Active', skipOffstage: false), findsWidgets);
    expect(find.textContaining('Revoked', skipOffstage: false), findsWidgets);
  });

  testWidgets('grants and revokes record access through confirmations', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1000, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final repository = _FakeRecordAccessRepository(
      grantedByMe: [
        _grant(
          id: 1,
          proxyUid: '11111111-1111-4111-8111-111111111111',
          relationship: 'Spouse',
          status: 'active',
          grantedAt: DateTime.utc(2026, 7, 1, 8, 30),
        ),
      ],
    );

    await tester.pumpWidget(
      _LocalizedHarness(child: RecordAccessScreen(repository: repository)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Grant access'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextFormField).at(0),
      '44444444-4444-4444-8444-444444444444',
    );
    await tester.enterText(find.byType(TextFormField).at(1), 'Brother');
    await tester.ensureVisible(find.byType(SignaturePadField));
    final canvas = find
        .descendant(
          of: find.byType(SignaturePadField),
          matching: find.byType(CustomPaint),
        )
        .last;
    await tester.dragFrom(tester.getCenter(canvas), const Offset(80, 0));
    await tester.pump();
    await tester.scrollUntilVisible(
      find.widgetWithText(FilledButton, 'Continue'),
      180,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
      await Future<void>.delayed(const Duration(milliseconds: 300));
    });
    await tester.pumpAndSettle();

    expect(find.text('Grant record access?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Grant access').last);
    await tester.pumpAndSettle();

    expect(repository.createdProxyUid, '44444444-4444-4444-8444-444444444444');
    expect(repository.createdRelationship, 'Brother');
    expect(
      repository.createdScope,
      containsAll(['results', 'claim_documents']),
    );
    expect(repository.createdConsentMethod, 'written');
    expect(repository.createdSignatureBytes, isNotNull);
    expect(repository.createdSignatureBytes!.take(8).toList(), [
      0x89,
      0x50,
      0x4E,
      0x47,
      0x0D,
      0x0A,
      0x1A,
      0x0A,
    ]);
    expect(find.text('Brother'), findsOneWidget);

    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.widgetWithText(TextButton, 'Revoke').first);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Revoke').first);
    await tester.pumpAndSettle();

    expect(find.text('Revoke access?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(repository.revokedGrantIds, [1]);
    expect(find.text('Record access revoked'), findsOneWidget);
  });

  testWidgets('shows empty state when no grants exist', (tester) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: RecordAccessScreen(repository: _FakeRecordAccessRepository()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No record access grants'), findsOneWidget);
    expect(find.textContaining('People you allow'), findsOneWidget);
  });
}

class _LocalizedHarness extends StatelessWidget {
  const _LocalizedHarness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    );
  }
}

class _FakeRecordAccessRepository implements RecordAccessRepository {
  _FakeRecordAccessRepository({
    List<RecordAccessGrant> grantedByMe = const [],
    List<HeldRecordAccessGrant> heldByMe = const [],
  }) : _grantedByMe = List<RecordAccessGrant>.from(grantedByMe),
       _heldByMe = List<HeldRecordAccessGrant>.from(heldByMe);

  final List<RecordAccessGrant> _grantedByMe;
  final List<HeldRecordAccessGrant> _heldByMe;
  final revokedGrantIds = <int>[];
  String? createdProxyUid;
  String? createdRelationship;
  List<String>? createdScope;
  String? createdConsentMethod;
  List<int>? createdSignatureBytes;

  @override
  Future<RecordAccessGrantsPage> listGrants() async {
    return RecordAccessGrantsPage(
      grantedByMe: List<RecordAccessGrant>.from(_grantedByMe),
      heldByMe: List<HeldRecordAccessGrant>.from(_heldByMe),
    );
  }

  @override
  Future<RecordAccessGrant> createGrant({
    required String proxyUid,
    required String relationship,
    required List<String> scope,
    required String consentMethod,
    Uint8List? signaturePngBytes,
  }) async {
    createdProxyUid = proxyUid;
    createdRelationship = relationship;
    createdScope = scope;
    createdConsentMethod = consentMethod;
    createdSignatureBytes = signaturePngBytes;
    final grant = _grant(
      id: 99,
      proxyUid: proxyUid,
      relationship: relationship,
      status: 'active',
      grantedAt: DateTime.utc(2026, 7, 2, 8, 30),
    );
    _grantedByMe.add(grant);
    return grant;
  }

  @override
  Future<void> revokeGrant(int id, {String? reason}) async {
    revokedGrantIds.add(id);
    final index = _grantedByMe.indexWhere((grant) => grant.id == id);
    if (index >= 0) {
      final old = _grantedByMe[index];
      _grantedByMe[index] = RecordAccessGrant(
        id: old.id,
        proxyUid: old.proxyUid,
        relationship: old.relationship,
        scope: old.scope,
        status: 'revoked',
        consentMethod: old.consentMethod,
        grantedAt: old.grantedAt,
        expiresAt: old.expiresAt,
        revokedAt: DateTime.utc(2026, 7, 3, 8, 30),
      );
    }
  }
}

RecordAccessGrant _grant({
  required int id,
  required String proxyUid,
  required String relationship,
  required String status,
  required DateTime? grantedAt,
  DateTime? revokedAt,
}) {
  return RecordAccessGrant(
    id: id,
    proxyUid: proxyUid,
    relationship: relationship,
    scope: const ['results', 'claim_documents'],
    status: status,
    consentMethod: 'otp',
    grantedAt: grantedAt,
    revokedAt: revokedAt,
  );
}
