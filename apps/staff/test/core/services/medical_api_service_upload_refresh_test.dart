import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:http_parser/http_parser.dart';
import 'package:vhhealth_core/config/api_config.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/medical_api_service.dart';

class _UploadCase {
  const _UploadCase({
    required this.name,
    required this.path,
    required this.field,
    required this.filename,
    required this.contentType,
    required this.fields,
    required this.invoke,
  });

  final String name;
  final String path;
  final String field;
  final String filename;
  final String contentType;
  final Map<String, String> fields;
  final Future<Map<String, dynamic>> Function(File, Uint8List) invoke;
}

class _GrowingFile extends Fake implements File {
  _GrowingFile(this.limit);

  final int limit;

  @override
  Future<int> length() async => 1;

  @override
  Stream<List<int>> openRead([int? start, int? end]) => Stream.fromIterable([
    Uint8List(limit),
    [1],
  ]);
}

final _cases = [
  _UploadCase(
    name: 'uploadInvestigation',
    path: '/staff/medical/investigations',
    field: 'file',
    filename: 'result.PDF',
    contentType: 'application/pdf',
    fields: {
      'phone': '9000000000',
      'testType': 'LAB',
      'result': 'synthetic result',
      'notes': 'synthetic notes',
      'date': '2026-09-08',
    },
    invoke: (file, _) => MedicalApiService.uploadInvestigation(
      phone: '9000000000',
      testType: 'LAB',
      result: 'synthetic result',
      notes: 'synthetic notes',
      date: '2026-09-08',
      fileUrl: 'must-not-enter-multipart-fields',
      filePath: file.path,
      fileName: 'result.PDF',
    ),
  ),
  _UploadCase(
    name: 'createInvestigationBooking',
    path: '/investigations/bookings/create',
    field: 'slip_photo',
    filename: 'slip.jpeg',
    contentType: 'image/jpeg',
    fields: {
      'patient_phone': '9000000000',
      'patient_name': 'Synthetic Patient',
      'custom_test_names': 'Synthetic test',
      'collection_type': 'walk_in',
      'preferred_date': '2026-09-08',
      'preferred_time_slot': 'morning',
      'notes': 'synthetic notes',
    },
    invoke: (file, _) => MedicalApiService.createInvestigationBooking(
      patientPhone: '9000000000',
      patientName: ' Synthetic Patient ',
      customTestNames: ' Synthetic test ',
      preferredDate: '2026-09-08',
      preferredTimeSlot: 'morning',
      notes: ' synthetic notes ',
      slipPath: file.path,
      slipFileName: 'slip.jpeg',
    ),
  ),
  _UploadCase(
    name: 'uploadBookingResult',
    path: '/investigations/bookings/71/result',
    field: 'file',
    filename: 'selected.png',
    contentType: 'image/png',
    fields: {'result_notes': 'synthetic notes'},
    invoke: (file, _) => MedicalApiService.uploadBookingResult(
      71,
      file.path,
      notes: 'synthetic notes',
    ),
  ),
  _UploadCase(
    name: 'createEPrescription',
    path: '/prescriptions/create',
    field: 'handwritten_photo',
    filename: 'selected.png',
    contentType: 'image/png',
    fields: {
      'patient_id': '77',
      'notes': 'synthetic notes',
      'items': '[{"catalog_id":91}]',
      'draft': 'true',
    },
    invoke: (file, _) => MedicalApiService.createEPrescription({
      'patient_id': 77,
      'notes': 'synthetic notes',
      'items': [
        {'catalog_id': 91},
      ],
      'draft': true,
      'omitted': null,
    }, photo: file),
  ),
  _UploadCase(
    name: 'uploadPatientPriorRecord',
    path: '/appointments/patient/records/upload',
    field: 'file',
    filename: 'prior.txt',
    contentType: 'text/plain',
    fields: {
      'patient_id': '77',
      'patient_phone': '9000000000',
      'patient_name': 'Synthetic Patient',
      'title': 'Prior synthetic record',
      'document_type': 'other',
      'source_hospital': 'Synthetic Hospital',
      'record_date': '2026-09-08',
      'notes': 'synthetic notes',
    },
    invoke: (file, _) => MedicalApiService.uploadPatientPriorRecord(
      patientId: 77,
      patientPhone: ' 9000000000 ',
      patientName: ' Synthetic Patient ',
      title: 'Prior synthetic record',
      documentType: 'other',
      filePath: file.path,
      fileName: 'prior.txt',
      sourceHospital: ' Synthetic Hospital ',
      recordDate: '2026-09-08',
      notes: ' synthetic notes ',
    ),
  ),
  _UploadCase(
    name: 'uploadConsentSignature',
    path: '/consent/81/signatures',
    field: 'file',
    filename: 'patient-signature.png',
    contentType: 'image/png',
    fields: {'signature_role': 'patient', 'signer_name': 'Synthetic Signer'},
    invoke: (_, bytes) => MedicalApiService.uploadConsentSignature(
      consentId: 81,
      signatureRole: 'patient',
      pngBytes: bytes,
      signerName: ' Synthetic Signer ',
    ),
  ),
];

String _multipartBody(Map<String, String> headers, List<int> bytes) {
  final type = MediaType.parse(headers['content-type']!);
  expect(type.mimeType, 'multipart/form-data');
  final boundary = type.parameters['boundary'];
  expect(boundary, isNotNull);
  expect(boundary, isNotEmpty);
  return latin1.decode(bytes).replaceAll('--$boundary', '--test-boundary');
}

http.Response _response(int status) => http.Response(
  jsonEncode({
    'success': status == 200,
    if (status == 200) 'data': {'id': 901},
    if (status != 200) 'message': 'synthetic denial',
  }),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory directory;
  late File file;
  late Uint8List bytes;
  late int expired;

  setUp(() async {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    expired = 0;
    VHHttpClient.onSessionExpired = (_) => expired++;
    await AuthService.setTokens(
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    );
    directory = await Directory.systemTemp.createTemp('staff-upload-refresh-');
    bytes = Uint8List.fromList([0, 255, 128, 13, 10, 80, 78, 71]);
    file = await File('${directory.path}/selected.png').writeAsBytes(bytes);
  });

  tearDown(() async {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    await AuthService.clearAll();
    await directory.delete(recursive: true);
  });

  for (final upload in _cases) {
    group(upload.name, () {
      if (upload.name != 'uploadConsentSignature') {
        final byteLimit =
            (upload.name == 'uploadPatientPriorRecord' ? 25 : 10) * 1024 * 1024;

        for (final growsDuringRead in [false, true]) {
          test(
            'rejects oversized source before network (growing=$growsDuringRead)',
            () async {
              final handle = await file.open(mode: FileMode.write);
              await handle.truncate(byteLimit + 1);
              await handle.close();
              var calls = 0;
              VHHttpClient.setClientForTesting(
                MockClient((_) async {
                  calls++;
                  return _response(200);
                }),
              );
              await expectLater(
                growsDuringRead
                    ? IOOverrides.runZoned(
                        () => upload.invoke(file, bytes),
                        createFile: (_) => _GrowingFile(byteLimit),
                      )
                    : upload.invoke(file, bytes),
                throwsA(isA<FileSystemException>()),
              );
              expect(calls, 0);
              expect(expired, 0);
              expect(await AuthService.getJwt(), 'old-access');
              expect(await AuthService.getRefreshToken(), 'old-refresh');
            },
          );
        }

        test('accepts source at existing route maximum', () async {
          final handle = await file.open(mode: FileMode.write);
          await handle.truncate(byteLimit);
          await handle.close();
          var calls = 0;
          VHHttpClient.setClientForTesting(
            MockClient((request) async {
              calls++;
              expect(request.url.path, endsWith(upload.path));
              expect(request.bodyBytes.length, greaterThan(byteLimit));
              return _response(200);
            }),
          );
          expect(await upload.invoke(file, bytes), {'id': 901});
          expect(calls, 1);
          expect(expired, 0);
        });

        test(
          'missing selected file fails before network without expiring session',
          () async {
            await file.delete();
            var calls = 0;
            VHHttpClient.setClientForTesting(
              MockClient((_) async {
                calls++;
                return _response(200);
              }),
            );
            await expectLater(
              upload.invoke(file, bytes),
              throwsA(isA<FileSystemException>()),
            );
            expect(calls, 0);
            expect(expired, 0);
            expect(await AuthService.getJwt(), 'old-access');
            expect(await AuthService.getRefreshToken(), 'old-refresh');
          },
        );
      }
      for (final change in ['replace', 'delete']) {
        test(
          '401 refresh replays original material after source $change',
          () async {
            final expected =
                http.MultipartRequest(
                    'POST',
                    Uri.parse('${ApiConfig.baseUrl}${upload.path}'),
                  )
                  ..fields.addAll(upload.fields)
                  ..files.add(
                    http.MultipartFile.fromBytes(
                      upload.field,
                      List<int>.of(bytes),
                      filename: upload.filename,
                      contentType: MediaType.parse(upload.contentType),
                    ),
                  );
            final expectedBytes = await expected.finalize().toBytes();
            final expectedBody = _multipartBody(
              expected.headers,
              expectedBytes,
            );
            var uploads = 0;
            var refreshes = 0;
            VHHttpClient.setClientForTesting(
              MockClient((request) async {
                if (request.url.path.endsWith('/auth/refresh-token')) {
                  refreshes++;
                  expect(request.method, 'POST');
                  expect(
                    jsonDecode(request.body)['refreshToken'],
                    'old-refresh',
                  );
                  if (change == 'replace') {
                    await file.writeAsBytes([10, 20, 30]);
                  } else {
                    await file.delete();
                  }
                  bytes.fillRange(0, bytes.length, 42);
                  return http.Response(
                    jsonEncode({
                      'success': true,
                      'data': {
                        'accessToken': 'new-access',
                        'refreshToken': 'new-refresh',
                      },
                    }),
                    200,
                    headers: {'content-type': 'application/json'},
                  );
                }
                uploads++;
                expect(
                  request.url.toString(),
                  '${ApiConfig.baseUrl}${upload.path}',
                );
                expect(request.method, 'POST');
                expect(
                  request.headers['authorization'],
                  uploads == 1 ? 'Bearer old-access' : 'Bearer new-access',
                );
                expect(
                  _multipartBody(request.headers, request.bodyBytes),
                  expectedBody,
                );
                return _response(uploads == 1 ? 401 : 200);
              }),
            );

            expect(await upload.invoke(file, bytes), {'id': 901});
            expect(uploads, 2);
            expect(refreshes, 1);
            expect(expired, 0);
            expect(await AuthService.getJwt(), 'new-access');
            expect(await AuthService.getRefreshToken(), 'new-refresh');
          },
        );
      }

      for (final status in [200, 403, 500]) {
        test('$status does not refresh or replay', () async {
          var calls = 0;
          VHHttpClient.setClientForTesting(
            MockClient((request) async {
              calls++;
              expect(request.url.path, endsWith(upload.path));
              return _response(status);
            }),
          );
          if (status == 200) {
            expect(await upload.invoke(file, bytes), {'id': 901});
          } else {
            await expectLater(upload.invoke(file, bytes), throwsException);
          }
          expect(calls, 1);
          expect(expired, 0);
          expect(await AuthService.getJwt(), 'old-access');
        });
      }

      test('failed refresh never replays and expires session once', () async {
        var uploads = 0;
        var refreshes = 0;
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            if (request.url.path.endsWith('/auth/refresh-token')) {
              refreshes++;
            } else {
              expect(request.url.path, endsWith(upload.path));
              uploads++;
            }
            return _response(401);
          }),
        );
        await expectLater(upload.invoke(file, bytes), throwsException);
        expect(uploads, 1);
        expect(refreshes, 1);
        expect(expired, 1);
        expect(await AuthService.getJwt(), isNull);
        expect(await AuthService.getRefreshToken(), isNull);
      });

      test('retried 401 expires session without another refresh', () async {
        var uploads = 0;
        var refreshes = 0;
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            if (request.url.path.endsWith('/auth/refresh-token')) {
              refreshes++;
              return http.Response(
                jsonEncode({
                  'success': true,
                  'data': {'accessToken': 'new-access'},
                }),
                200,
                headers: {'content-type': 'application/json'},
              );
            }
            uploads++;
            expect(request.url.path, endsWith(upload.path));
            expect(
              request.headers['authorization'],
              uploads == 1 ? 'Bearer old-access' : 'Bearer new-access',
            );
            return _response(401);
          }),
        );
        await expectLater(upload.invoke(file, bytes), throwsException);
        expect(uploads, 2);
        expect(refreshes, 1);
        expect(expired, 1);
      });
    });
  }

  test('consent signature snapshots caller bytes before yielding', () async {
    final original = List<int>.of(bytes);
    var uploads = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.url.path.endsWith('/auth/refresh-token')) {
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'accessToken': 'new-access'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        uploads++;
        final body = latin1.decode(request.bodyBytes);
        expect(body, contains('\r\n\r\n${latin1.decode(original)}\r\n'));
        return _response(uploads == 1 ? 401 : 200);
      }),
    );
    final pending = MedicalApiService.uploadConsentSignature(
      consentId: 81,
      signatureRole: 'patient',
      pngBytes: bytes,
    );
    bytes.fillRange(0, bytes.length, 42);
    expect(await pending, {'id': 901});
    expect(uploads, 2);
    expect(expired, 0);
  });
}
