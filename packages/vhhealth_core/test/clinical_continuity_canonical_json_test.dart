import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/clinical_continuity_canonical_json.dart';

void main() {
  test('matches the RFC 8785 serialization vector', () {
    final value = {
      'numbers': [double.parse('333333333.33333329'), 1e30, 4.50, 2e-3, 1e-27],
      'string': '€\$\u000f\nA\'B"\\\\\\"/',
      'literals': [null, true, false],
    };
    expect(
      ClinicalContinuityCanonicalJson.canonicalize(value),
      '{"literals":[null,true,false],'
      '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
      '"string":"€\$\\u000f\\nA\'B\\"\\\\\\\\\\\\\\"/"}',
    );
  });

  test('sorts object keys by UTF-16 code units', () {
    expect(
      ClinicalContinuityCanonicalJson.canonicalize({
        '€': 'euro',
        '\r': 'carriage',
        'דּ': 'hebrew',
        '1': 'one',
        '😀': 'emoji',
        '\u0080': 'control',
        'ö': 'latin',
      }),
      '{"\\r":"carriage","1":"one","\u0080":"control","ö":"latin",'
      '"€":"euro","😀":"emoji","דּ":"hebrew"}',
    );
  });

  test('uses ECMAScript number boundaries and normalizes negative zero', () {
    expect(
      ClinicalContinuityCanonicalJson.canonicalize([
        -0.0,
        1e30,
        1e-7,
        0.000001,
        double.parse('333333333.33333329'),
      ]),
      '[0,1e+30,1e-7,0.000001,333333333.3333333]',
    );
  });

  test('strict parser rejects duplicate names and malformed UTF-8', () {
    expect(
      () => ClinicalContinuityCanonicalJson.parse(
        Uint8List.fromList(utf8.encode('{"safe":1,"safe":2}')),
      ),
      throwsA(
        isA<ClinicalContinuityCanonicalizationException>().having(
          (error) => error.code,
          'code',
          'CANONICAL_DUPLICATE_KEY',
        ),
      ),
    );
    expect(
      () => ClinicalContinuityCanonicalJson.parse(
        Uint8List.fromList([0x22, 0xc3, 0x28, 0x22]),
      ),
      throwsFormatException,
    );
  });

  test('rejects lone surrogates, non-finite numbers, and limit excess', () {
    expect(
      () => ClinicalContinuityCanonicalJson.canonicalize('\ud800'),
      throwsA(
        isA<ClinicalContinuityCanonicalizationException>().having(
          (error) => error.code,
          'code',
          'CANONICAL_LONE_SURROGATE',
        ),
      ),
    );
    expect(
      () => ClinicalContinuityCanonicalJson.canonicalize(double.nan),
      throwsA(isA<ClinicalContinuityCanonicalizationException>()),
    );
    expect(
      () => ClinicalContinuityCanonicalJson.canonicalize({
        'first': {
          'second': {'third': true},
        },
      }, limits: const ClinicalContinuityCanonicalLimits(maxDepth: 1)),
      throwsA(
        isA<ClinicalContinuityCanonicalizationException>().having(
          (error) => error.code,
          'code',
          'CANONICAL_DEPTH_LIMIT',
        ),
      ),
    );
    expect(
      () => ClinicalContinuityCanonicalJson.canonicalize([
        1,
        2,
      ], limits: const ClinicalContinuityCanonicalLimits(maxNodes: 2)),
      throwsA(
        isA<ClinicalContinuityCanonicalizationException>().having(
          (error) => error.code,
          'code',
          'CANONICAL_NODE_LIMIT',
        ),
      ),
    );
  });
}
