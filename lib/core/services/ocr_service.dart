import 'dart:io';
import 'package:flutter/foundation.dart';

/// Prescription OCR service — extracts text from prescription photos.
///
/// **Integration status**: Stub — requires an OCR provider.
///
/// **Recommended options** (pick one):
/// 1. **google_mlkit_text_recognition** (on-device, free, no network)
///    - Add `google_mlkit_text_recognition: ^0.14.0` to pubspec.yaml
///    - Implement [extractText] using `TextRecognizer().processImage()`
/// 2. **Backend OCR** via Tesseract/AWS Textract
///    - Upload image to backend, get structured text back
///    - Add endpoint: POST /api/v1/prescriptions/ocr
/// 3. **Google Cloud Vision API** (cloud, paid, high accuracy)
///    - Use `googleapis` package with Cloud Vision
///
/// After extracting text, parse medication names, dosages, and frequencies
/// from the raw text using regex or backend NLP.
class OcrService {
  OcrService._();

  /// Extract text from a prescription photo.
  ///
  /// Returns extracted text lines, or empty list if OCR is not available.
  static Future<List<String>> extractText(File imageFile) async {
    // TODO: Replace with real OCR implementation.
    //
    // Example with google_mlkit_text_recognition:
    // ```dart
    // final inputImage = InputImage.fromFile(imageFile);
    // final recognizer = TextRecognizer();
    // final recognized = await recognizer.processImage(inputImage);
    // recognizer.close();
    // return recognized.blocks
    //     .expand((block) => block.lines)
    //     .map((line) => line.text)
    //     .toList();
    // ```

    if (kDebugMode) {
      debugPrint('OcrService: OCR not yet integrated — returning empty result');
    }
    return [];
  }

  /// Whether OCR is available on this device.
  static bool get isAvailable => false; // Flip to true after integration

  /// Parse medication info from raw OCR text lines.
  ///
  /// Returns a list of maps with keys: name, dosage, frequency.
  /// This is a basic heuristic — improve with backend NLP for accuracy.
  static List<Map<String, String>> parseMedications(List<String> lines) {
    final medications = <Map<String, String>>[];
    final dosePattern = RegExp(
      r'(\d+\s*(?:mg|ml|mcg|g|iu|units?))',
      caseSensitive: false,
    );
    final freqPattern = RegExp(
      r'(once|twice|thrice|daily|BD|TDS|QDS|OD|HS|SOS|PRN|q\d+h)',
      caseSensitive: false,
    );

    for (final line in lines) {
      final trimmed = line.trim();
      if (trimmed.length < 3) continue;

      final doseMatch = dosePattern.firstMatch(trimmed);
      final freqMatch = freqPattern.firstMatch(trimmed);

      if (doseMatch != null || freqMatch != null) {
        // Likely a medication line
        String name = trimmed;
        if (doseMatch != null) {
          name = trimmed.substring(0, doseMatch.start).trim();
        }
        // Remove trailing numbers, punctuation
        name = name.replaceAll(RegExp(r'[\d\.\,\-]+$'), '').trim();

        if (name.length >= 2) {
          medications.add({
            'name': name,
            'dosage': doseMatch?.group(0) ?? '',
            'frequency': freqMatch?.group(0) ?? '',
          });
        }
      }
    }

    return medications;
  }
}
