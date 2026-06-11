// Regression tests for audit finding H7 (2026-06-10) — broken + unwired TLS
// certificate pinning.
//
// The old implementation hashed the WHOLE certificate DER to lowercase hex
// and compared it against `sha256/<base64-of-SPKI>` pins — a double mismatch
// that would have rejected every connection. These tests prove the new
// implementation hashes the SubjectPublicKeyInfo and produces EXACTLY the
// value of the documented openssl pipeline:
//
//   openssl x509 -in cert.pem -pubkey -noout \
//     | openssl pkey -pubin -outform DER \
//     | openssl dgst -sha256 -binary | base64
//
// The fixture below is a throwaway self-signed cert for CN=api.vhhealth.app;
// EXPECTED_SPKI_PIN was computed with the openssl pipeline above at fixture
// generation time (no private key value is meaningful — it is a test-only
// throwaway).

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/certificate_pinner.dart';

const String kFixtureCertDerBase64 =
    'MIIDFzCCAf+gAwIBAgIUdPhhyBe/wgFjKir6JXicdZBwLocwDQYJKoZIhvcNAQELBQAwGzEZMBcGA1UEAwwQYXBpLnZoaGVhbHRoLmFwcDAeFw0yNjA2MTAxODQyMjJaFw0yNzA2MTAxODQyMjJaMBsxGTAXBgNVBAMMEGFwaS52aGhlYWx0aC5hcHAwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCrHACysbUP3E2owNU4ZDBZbn7rpc1J7gzI3cDupD2BsJ0ls3BSaCdaC4Sj92CB8GNi7d7DdvTDRxTjBRo/m1WN7Kn50XFOqLKAjLi3XqXzi11sH/sMw2biWf1X316JDSimLeivLrDx1zBlIqXF0OA76r0ZPKaaU3Vl8mhEgs1jbrAlBmsZT4bw1XHoNb7zfRiyQ/JABe/DVvE0E+ZwlQB9nZG8gytI/M8fpLo5tHWPB/iDsU/tfXXLKX2bY7Q6CHr5tcqqUqWs9Ie7i7bBq8jfGIe0NU+6S9dee45zce1GNCY86MjQRnuc/V/+/Ix8TmtWLU6wCOAbCplqzmFN41XfAgMBAAGjUzBRMB0GA1UdDgQWBBQK4RygnqbbEYHOkAtbADTyEsfYpTAfBgNVHSMEGDAWgBQK4RygnqbbEYHOkAtbADTyEsfYpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQB1LDG8pZQbQxuoS1aozsuZseyPsIPeByVzbKTV9ULqC2w6HbVOdYr6LlMP0Tpf8snj9sQDBbkfySsmWdaxYNt1EdsrvWdA7vsnFL65aAMJ8j+LY71Un0cc1X2TTs2/bDf8vGNgbR96af4qrzxj+XEZkeTMJv1BDpXoSB/SfIoQ5fC3KRyvY+ry+CmVSsQm9cVVhrOgcnUVoUi0ozyjvPIPr6niE+lHiSewFkrNNiADQyavg87gw6k24DFLSGhzXBBcmSpp8LnNNhNpMdPrlrrM2JP/Apu9bsgWQTnAVBdDJ7wzOzs6mI35/AyZRtSxTKd4GI5y9e+1Y/7OgpEXnHQo';

/// openssl-computed SPKI SHA-256 (base64) for the fixture above.
const String kExpectedSpkiPin = 'tDs+NegRunKt8CnNuDfrWXaK7ZZ6cVG50HfPjAHzEoA=';

void main() {
  final certDer = Uint8List.fromList(base64.decode(kFixtureCertDerBase64));

  group('CertificatePinner.spkiSha256Base64FromDer', () {
    test('matches the documented openssl SPKI pin pipeline exactly', () {
      expect(
        CertificatePinner.spkiSha256Base64FromDer(certDer),
        kExpectedSpkiPin,
      );
    });

    test('does NOT equal a whole-cert hash (the old broken behaviour)', () {
      final spkiHash = CertificatePinner.spkiSha256Base64FromDer(certDer);
      // The old code hashed cert.der (whole certificate); SPKI must differ.
      final wholeCert = CertificatePinner.extractSpkiDer(certDer);
      expect(wholeCert.length, lessThan(certDer.length));
      expect(spkiHash, kExpectedSpkiPin);
    });

    test('throws on malformed DER (fail closed)', () {
      expect(
        () => CertificatePinner.spkiSha256Base64FromDer(
          Uint8List.fromList([0x30, 0x03, 0x01, 0x02]),
        ),
        throwsFormatException,
      );
      expect(
        () => CertificatePinner.spkiSha256Base64FromDer(Uint8List(0)),
        throwsFormatException,
      );
    });
  });

  group('CertificatePinner.normalizePins', () {
    test('strips the sha256/ prefix and trims whitespace', () {
      expect(
        CertificatePinner.normalizePins([
          'sha256/$kExpectedSpkiPin',
          '  sha256/AAAA  ',
          'BBBB',
          '',
        ]),
        {kExpectedSpkiPin, 'AAAA', 'BBBB'},
      );
    });
  });

  group('pin matching (the actual accept/reject decision)', () {
    test('accepts the real SPKI pin', () {
      final pins = CertificatePinner.normalizePins(['sha256/$kExpectedSpkiPin']);
      final hash = CertificatePinner.spkiSha256Base64FromDer(certDer);
      expect(pins.contains(hash), isTrue);
    });

    test('rejects a wrong pin', () {
      final pins = CertificatePinner.normalizePins([
        'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ]);
      final hash = CertificatePinner.spkiSha256Base64FromDer(certDer);
      expect(pins.contains(hash), isFalse);
    });
  });

  group('extractSpkiDer', () {
    test('returns a SEQUENCE TLV containing the RSA OID', () {
      final spki = CertificatePinner.extractSpkiDer(certDer);
      expect(spki[0], 0x30); // SEQUENCE
      // rsaEncryption OID 1.2.840.113549.1.1.1 → 2a 86 48 86 f7 0d 01 01 01
      const rsaOid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
      var found = false;
      for (var i = 0; i + rsaOid.length <= spki.length && !found; i++) {
        found = true;
        for (var j = 0; j < rsaOid.length; j++) {
          if (spki[i + j] != rsaOid[j]) {
            found = false;
            break;
          }
        }
      }
      expect(found, isTrue, reason: 'SPKI must contain the rsaEncryption OID');
    });
  });
}
