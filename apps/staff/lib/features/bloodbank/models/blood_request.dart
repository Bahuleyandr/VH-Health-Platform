import '../../../core/utils/patient_identity.dart';

enum BloodComponent {
  wholeBlood('whole_blood'),
  packedRedBloodCells('prbc'),
  freshFrozenPlasma('ffp'),
  platelets('platelets'),
  cryoprecipitate('cryoprecipitate');

  final String apiValue;
  const BloodComponent(this.apiValue);
}

enum BloodUrgency {
  routine('routine'),
  urgent('urgent'),
  emergency('emergency');

  final String apiValue;
  const BloodUrgency(this.apiValue);
}

class BloodRequestPatient {
  final String uid;
  final String name;
  final String hospitalNumber;

  const BloodRequestPatient({
    required this.uid,
    required this.name,
    required this.hospitalNumber,
  });

  static final RegExp _uuidPattern = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  static BloodRequestPatient? fromSearchResult(Map<String, dynamic> patient) {
    final uid = patientUidFrom(patient);
    if (!_uuidPattern.hasMatch(uid)) return null;
    return BloodRequestPatient(
      uid: uid,
      name: patientNameFrom(patient),
      hospitalNumber: patientHospitalNumberFrom(patient),
    );
  }
}

class BloodRequestPayload {
  final String patientUid;
  final String bloodGroup;
  final int units;
  final BloodComponent component;
  final String clinicalIndication;
  final BloodUrgency urgency;

  const BloodRequestPayload({
    required this.patientUid,
    required this.bloodGroup,
    required this.units,
    required this.component,
    required this.clinicalIndication,
    required this.urgency,
  });

  Map<String, dynamic> toJson() => {
    'patient_uid': patientUid,
    'blood_group': bloodGroup,
    'units': units,
    'component': component.apiValue,
    'clinical_indication': clinicalIndication,
    'urgency': urgency.apiValue,
  };
}
