import 'package:printing/printing.dart';

import 'medical_api_service.dart';

class ClinicalPrintService {
  ClinicalPrintService._();

  static Future<void> printDischargeSummary({required int admissionId}) async {
    final bytes =
        await MedicalApiService.downloadDischargeSummaryPdfForAdmission(
          admissionId,
        );
    await Printing.layoutPdf(
      name: 'discharge_summary_$admissionId.pdf',
      onLayout: (_) async => bytes,
    );
  }

  static Future<void> printPrescription({required int prescriptionId}) async {
    final bytes = await MedicalApiService.downloadPrescriptionPrintPdf(
      prescriptionId,
    );
    await Printing.layoutPdf(
      name: 'prescription_$prescriptionId.pdf',
      onLayout: (_) async => bytes,
    );
  }
}
