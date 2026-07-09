import {
  runTransformDsl,
  transformMatchesExpected,
  validateTransformDsl,
} from '../../services/interfaceEngine/transformDsl.js';

const HL7 = 'MSH|^~\\&|ACME|FAC|VH|VH_UNIT|202607080930||ADT^A01|CTRL-1|P|2.5\rPID|||11111111-1111-4111-8111-111111111111||KUMAR^Asha\rPV1||I|WARD^101^A||||DR01';

describe('interface engine transform DSL', () => {
  it('extracts deterministic HL7 fields without exposing raw payload execution', () => {
    const result = runTransformDsl({
      protocol: 'hl7v2',
      payload: HL7,
      dsl: {
        kind: 'hl7v2-to-preview',
        output: {
          patientUid: { select: 'PID.3' },
          controlId: { select: 'MSH.10' },
          ward: { normalize: 'uppercase', from: { select: 'PV1.3' } },
        },
        validate: [
          { path: 'patientUid', required: true },
          { path: 'controlId', required: true },
        ],
      },
    });

    expect(result.output).toEqual({
      patientUid: '11111111-1111-4111-8111-111111111111',
      controlId: 'CTRL-1',
      ward: 'WARD^101^A',
    });
    expect(result.findings).toEqual([]);
  });

  it('rejects forbidden operation keys before execution', () => {
    expect(() => validateTransformDsl({
      kind: 'bad',
      output: {
        unsafe: { eval: 'process.env.SECRET' },
      },
    })).toThrow(/forbidden/i);
  });

  it('fails closed on transform operation budget exhaustion', () => {
    expect(() => runTransformDsl({
      protocol: 'hl7v2',
      payload: HL7,
      maxOperations: 0,
      dsl: {
        output: {
          controlId: { select: 'MSH.10' },
        },
      },
    })).toThrow(/timed out/i);
  });

  it('compares expected fixture output independent of key order', () => {
    expect(transformMatchesExpected(
      { b: 2, a: { z: 1, y: 0 } },
      { a: { y: 0, z: 1 }, b: 2 },
    )).toBe(true);
  });
});
