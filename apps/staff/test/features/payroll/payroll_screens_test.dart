import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/payroll/screens/investment_declaration_screen.dart';
import 'package:vhhealth_staff/features/payroll/screens/payslip_detail_screen.dart';
import 'package:vhhealth_staff/features/payroll/screens/payslip_query_screen.dart';
import 'package:vhhealth_staff/features/payroll/screens/payslip_screen.dart';
import 'package:vhhealth_staff/features/payroll/screens/tax_summary_screen.dart';

void main() {
  testWidgets('payslip list renders Decimal-string payroll rows', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        PayslipScreen(loadPayslips: ({int months = 3}) async => [_payslip()]),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('My Payslips'), findsOneWidget);
    expect(find.text('April 2026'), findsOneWidget);
    expect(find.textContaining('₹48,123.45'), findsOneWidget);
  });

  testWidgets('payslip detail renders Decimal-string breakdown', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        PayslipDetailScreen(
          payslipId: '7',
          monthLabel: 'April 2026',
          loadPayslip: (_) async => _payslipDetail(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Payslip — April 2026'), findsOneWidget);
    expect(find.text('₹48,123.45'), findsOneWidget);
    expect(find.text('Gross Salary'), findsOneWidget);
    expect(find.text('PF (Employee 12%)'), findsOneWidget);
  });

  testWidgets(
    'payslip password requires one gesture, starts masked, and clears on close',
    (tester) async {
      final pendingReveal = Completer<String>();
      String? copiedPassword;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
            if (call.method == 'Clipboard.setData') {
              copiedPassword = (call.arguments as Map)['text'] as String?;
            }
            return null;
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, null),
      );
      var revealCalls = 0;
      await tester.pumpWidget(
        _host(
          PayslipDetailScreen(
            payslipId: '7',
            monthLabel: 'April 2026',
            loadPayslip: (_) async => {..._payslipDetail(), 'pdf_key': 'pdf'},
            revealPassword: (_) {
              revealCalls += 1;
              return pendingReveal.future;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(revealCalls, 0);
      final revealButton = find.byKey(
        const Key('payslip-password-reveal-button'),
      );
      await tester.ensureVisible(revealButton);
      await tester.pumpAndSettle();
      await tester.tap(revealButton);
      await tester.pump();
      await tester.tap(revealButton, warnIfMissed: false);
      await tester.pump();
      expect(revealCalls, 1);

      pendingReveal.complete('PDF-only-secret');
      await tester.pumpAndSettle();

      final passwordField = tester.widget<TextField>(
        find.byKey(const Key('payslip-password-field')),
      );
      expect(passwordField.obscureText, isTrue);

      await tester.tap(find.text('Copy'));
      await tester.pump();
      expect(copiedPassword, 'PDF-only-secret');

      await tester.tap(find.byTooltip('Show password'));
      await tester.pump();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('payslip-password-field')))
            .obscureText,
        isFalse,
      );

      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('payslip-password-field')), findsNothing);
      expect(find.text('PDF-only-secret'), findsNothing);
    },
  );

  testWidgets('payslip password failure is generic and does not echo details', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        PayslipDetailScreen(
          payslipId: '7',
          monthLabel: 'April 2026',
          loadPayslip: (_) async => {..._payslipDetail(), 'pdf_key': 'pdf'},
          revealPassword: (_) async =>
              throw Exception('backend credential PDF-only-secret'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final revealButton = find.byKey(
      const Key('payslip-password-reveal-button'),
    );
    await tester.ensureVisible(revealButton);
    await tester.pumpAndSettle();
    await tester.tap(revealButton);
    await tester.pumpAndSettle();

    expect(
      find.text('Unable to retrieve the payslip password. Try again.'),
      findsOneWidget,
    );
    expect(find.textContaining('PDF-only-secret'), findsNothing);
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets('payslip query screen renders and submits once while pending', (
    tester,
  ) async {
    final pendingSubmit = Completer<Object?>();
    final submittedPayloads = <Map<String, dynamic>>[];

    await tester.pumpWidget(
      _host(
        PayslipQueryScreen(
          loadQueries: () async => [_query()],
          loadPayslips: ({int months = 3}) async => [_payslip()],
          raiseQuery: (payload) {
            submittedPayloads.add(payload);
            return pendingSubmit.future;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Payslip Queries'), findsOneWidget);
    expect(find.text('Payroll issue'), findsOneWidget);

    await tester.tap(find.text('Raise Query'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Apr 2026').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).at(0), 'PF mismatch');
    await tester.enterText(
      find.byType(TextFormField).at(1),
      'Please review the PF deduction.',
    );
    final submitButton = find.byType(FilledButton).last;

    await tester.tap(submitButton);
    await tester.pump();
    await tester.tap(submitButton, warnIfMissed: false);
    await tester.pump();

    expect(submittedPayloads, hasLength(1));
    expect(submittedPayloads.single['payslip_id'], 7);
    expect(submittedPayloads.single['subject'], 'PF mismatch');
    expect(find.byType(CircularProgressIndicator), findsWidgets);

    pendingSubmit.complete({});
    await tester.pumpAndSettle();
  });

  testWidgets('investment declaration renders and submits once while pending', (
    tester,
  ) async {
    final pendingSubmit = Completer<Object?>();
    final submittedPayloads = <Map<String, dynamic>>[];

    await tester.pumpWidget(
      _host(
        InvestmentDeclarationScreen(
          loadDeclarations: () async => [],
          submitDeclaration: (payload) {
            submittedPayloads.add(payload);
            return pendingSubmit.future;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Tax Declaration (80C/80D)'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextFormField, 'PPF'), '25000');
    await tester.dragUntilVisible(
      find.text('Submit Declaration'),
      find.byType(ListView),
      const Offset(0, -500),
    );
    final submitButton = find.byType(FilledButton).last;

    await tester.tap(submitButton);
    await tester.pump();
    await tester.tap(submitButton, warnIfMissed: false);
    await tester.pump();

    expect(submittedPayloads, hasLength(1));
    expect(submittedPayloads.single['ppf'], 25000);
    expect(find.byType(CircularProgressIndicator), findsWidgets);

    pendingSubmit.complete({});
    await tester.pumpAndSettle();
  });

  testWidgets('tax summary renders mixed numeric and Decimal-string amounts', (
    tester,
  ) async {
    final now = DateTime.now();
    final fyStart = now.month >= 4 ? now.year : now.year - 1;
    final expectedFy =
        '$fyStart-${((fyStart + 1) % 100).toString().padLeft(2, '0')}';

    await tester.pumpWidget(
      _host(
        TaxSummaryScreen(
          loadTaxSummary: ({String? fy}) async => {
            'total_gross': '120000.50',
            'total_net': 98000,
            'taxable_income': '65000.25',
            'tax_payable': 3000,
            'months_included': 2,
            'total_basic': '50000.00',
            'total_hra': '25000.00',
            'total_da': '0.00',
            'total_special_allowance': '0.00',
            'total_transport_allowance': '0.00',
            'total_medical_allowance': '0.00',
            'total_overtime': '0.00',
            'total_bonus': '0.00',
            'total_arrears': '0.00',
            'total_pf': '7200.00',
            'total_esi': '0.00',
            'total_professional_tax': '2400.00',
            'total_tds': '1000.00',
            'total_advance_deductions': '0.00',
            'total_deductions': '10600.00',
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Annual Tax Summary'), findsOneWidget);
    expect(find.text('₹1,20,000.50'), findsWidgets);
    expect(find.text('2 payslips included in FY $expectedFy'), findsOneWidget);
  });
}

Widget _host(Widget child) => MaterialApp(home: child);

Map<String, dynamic> _payslip() => {
  'id': 7,
  'month': 4,
  'year': 2026,
  'status': 'issued',
  'gross_salary': '60000.00',
  'net_salary': '48123.45',
  'total_deductions': '11876.55',
};

Map<String, dynamic> _payslipDetail() => {
  ..._payslip(),
  'total_working_days': 26,
  'days_present': 25,
  'days_absent': '1',
  'lop_days': '1',
  'days_leave': 0,
  'overtime_hours': '2.5',
  'basic_earned': '30000.00',
  'hra_earned': '12000.00',
  'da_earned': '0.00',
  'special_allowance_earned': '5000.00',
  'transport_allowance_earned': '0.00',
  'medical_allowance_earned': '0.00',
  'overtime_pay': '1123.45',
  'bonus_this_month': '0.00',
  'arrears_amount': '0.00',
  'lop_deduction': '2300.00',
  'pf_employee': '3600.00',
  'esi_employee': '0.00',
  'professional_tax': '200.00',
  'tds': '5776.55',
  'advance_deduction': '0.00',
  'pdf_key': null,
  'pdf_url': null,
};

Map<String, dynamic> _query() => {
  'id': 11,
  'payslip_id': 7,
  'month': 4,
  'year': 2026,
  'subject': 'Payroll issue',
  'description': 'Please review PF.',
  'category': 'pf',
  'status': 'open',
  'replies': const [],
};
