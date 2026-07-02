// Unit test — clinicalNotesService.updateNote.
// Confirms: ADMIN overwrites content + bumps version; the original assigned
// doctor may revise an unsigned OP note while the appointment is open; signed,
// terminal, peer-authored, and non-OP notes remain protected.

import { jest } from '@jest/globals';

const findUniqueMock = jest.fn();
const findFirstMock = jest.fn();
const createMock = jest.fn();
const appointmentFindUniqueMock = jest.fn();
const updateMock = jest.fn();
const usersFindManyMock = jest.fn();
const userFindUniqueMock = jest.fn();

// The clinical-notes service now wraps its detail write + canonical event
// write in `prisma.$transaction(async (tx) => {...})` (B0.5 — atomic clinical
// writes). The mock $transaction faithfully runs the callback with a `tx` that
// is this same mocked prisma object, so `tx.clinical_notes.update(...)` etc.
// hit the per-model mocks above and every recorded call / assertion still
// works. The canonical event write inside the tx no-ops by design: it guards
// on `typeof db.$queryRawUnsafe === 'function'` and this mock intentionally
// exposes no raw client, so `recordCanonicalClinicalEvent` returns null
// without touching the timeline/audit tables — these unit tests validate the
// note service's own logic, not the canonical layer.
const prismaMock = {
  clinical_notes: {
    findUnique: findUniqueMock,
    findFirst: findFirstMock,
    create: createMock,
    update: updateMock
  },
  appointments: {
    findUnique: appointmentFindUniqueMock
  },
  users: {
    findUnique: userFindUniqueMock,
    findMany: usersFindManyMock
  },
  $transaction: jest.fn(async (cb) => cb(prismaMock))
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

const { createNote, updateNote } = await import('../../services/emr/clinicalNotesService.js');

const EDITOR_UID = '00000000-0000-4000-8000-00000000aaaa';
const ORIGINAL_AUTHOR_UID = '11111111-1111-4111-8111-1111111111bb';
const VALID_SOAP_CONTENT = {
  subjective: 'Patient reports chest pain has resolved overnight.',
  objective: 'HR 72, BP 124/78, afebrile.',
  assessment: 'Non-cardiac chest pain, low risk.',
  plan: 'Discharge home with PRN antacid; follow up in 2 weeks.'
};

beforeEach(() => {
  findUniqueMock.mockReset();
  findFirstMock.mockReset();
  createMock.mockReset();
  appointmentFindUniqueMock.mockReset();
  updateMock.mockReset();
  userFindUniqueMock.mockReset();
  usersFindManyMock.mockReset();
});

describe('updateNote — edit gate', () => {
  it('throws 403 when a peer doctor edits another doctor authored OP note', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 1,
      note_type: 'soap',
      version: 1,
      content: VALID_SOAP_CONTENT,
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      is_signed: false,
      appointment_id: 101
    });

    await expect(
      updateNote(1, VALID_SOAP_CONTENT, EDITOR_UID, 'DOCTOR', {
        id: 990902,
        uid: EDITOR_UID,
        role: 'DOCTOR'
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'NOTE_AUTHOR_ONLY_EDIT'
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws 403 when editor is a NURSE (even on a note the nurse authored)', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 1,
      note_type: 'soap',
      version: 1,
      content: VALID_SOAP_CONTENT,
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'NURSE',
      is_signed: false,
      appointment_id: 101
    });

    await expect(
      updateNote(1, VALID_SOAP_CONTENT, ORIGINAL_AUTHOR_UID, 'NURSE')
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'DOCTOR_ONLY_OP_NOTE_EDIT'
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws 409 when original doctor edits after the OP appointment is completed', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 1,
      note_type: 'soap',
      version: 1,
      content: VALID_SOAP_CONTENT,
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      is_signed: false,
      appointment_id: 101
    });
    appointmentFindUniqueMock.mockResolvedValueOnce({
      id: 101,
      doctor_id: 990902,
      status: 'COMPLETED'
    });

    await expect(
      updateNote(1, VALID_SOAP_CONTENT, ORIGINAL_AUTHOR_UID, 'DOCTOR', {
        id: 990902,
        uid: ORIGINAL_AUTHOR_UID,
        role: 'DOCTOR'
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'OP_NOTE_SESSION_CLOSED'
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws 409 when a signed note is edited by a clinical author', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 1,
      note_type: 'soap',
      version: 1,
      content: VALID_SOAP_CONTENT,
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      is_signed: true,
      appointment_id: 101
    });

    await expect(
      updateNote(1, VALID_SOAP_CONTENT, ORIGINAL_AUTHOR_UID, 'DOCTOR')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SIGNED_NOTE_IMMUTABLE'
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws 400 when editorUid is missing', async () => {
    await expect(updateNote(1, VALID_SOAP_CONTENT, null, 'ADMIN')).rejects.toMatchObject({
      statusCode: 400
    });
  });

  it('throws 400 when content is empty / not an object', async () => {
    await expect(updateNote(1, null, EDITOR_UID, 'ADMIN')).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(updateNote(1, {}, EDITOR_UID, 'ADMIN')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('updateNote — admin overwrite path', () => {
  it('throws 404 when the note id does not exist', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    await expect(updateNote(999, VALID_SOAP_CONTENT, EDITOR_UID, 'ADMIN')).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it('throws 400 when new content is missing per-note-type required fields', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 1,
      note_type: 'soap',
      version: 1,
      content: VALID_SOAP_CONTENT,
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      is_signed: false,
      appointment_id: null
    });

    await expect(
      updateNote(1, { subjective: 'only this' }, EDITOR_UID, 'ADMIN')
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_NOTE_CONTENT'
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('overwrites content, bumps version, preserves author_uid/author_role/note_type', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 42,
      note_type: 'soap',
      version: 1,
      content: { subjective: 'old', objective: 'old', assessment: 'old', plan: 'old' },
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      is_signed: true,
      appointment_id: 101
    });

    updateMock.mockImplementationOnce(async ({ where, data, select }) => ({
      id: where.id,
      encounter_id: null,
      patient_uid: 'patient-uid',
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      note_type: 'soap',
      content: data.content,
      version: data.version,
      parent_note_id: null,
      is_addendum: false,
      is_signed: false,
      signed_at: null,
      signed_by: null,
      created_at: new Date('2026-05-15T00:00:00Z'),
      updated_at: data.updated_at
    }));
    usersFindManyMock.mockResolvedValueOnce([
      { uid: ORIGINAL_AUTHOR_UID, name: 'Original Doctor' }
    ]);

    const result = await updateNote(42, VALID_SOAP_CONTENT, EDITOR_UID, 'ADMIN');

    expect(updateMock).toHaveBeenCalledTimes(1);
    const callArgs = updateMock.mock.calls[0][0];
    expect(callArgs.where).toEqual({ id: 42 });
    expect(callArgs.data.content).toEqual(VALID_SOAP_CONTENT);
    expect(callArgs.data.version).toBe(2);
    // The mutation MUST NOT touch author_uid / author_role / note_type —
    // the original author is the legal record-keeper. Admin can rewrite
    // prose but not impersonate.
    expect(callArgs.data.author_uid).toBeUndefined();
    expect(callArgs.data.author_role).toBeUndefined();
    expect(callArgs.data.note_type).toBeUndefined();
    expect(callArgs.data.updated_at).toBeInstanceOf(Date);

    expect(result.author_uid).toBe(ORIGINAL_AUTHOR_UID);
    expect(result.author_role).toBe('DOCTOR');
    expect(result.note_type).toBe('soap');
    expect(result.version).toBe(2);
    expect(result.author_name).toBe('Original Doctor');
    expect(result.content).toEqual(VALID_SOAP_CONTENT);
  });
});

describe('updateNote — original doctor OP session edit path', () => {
  it('allows the original assigned doctor to revise an unsigned OP consultation note', async () => {
    const opContent = {
      chief_complaint: 'Fever and cough for 2 days.',
      history: 'No breathlessness. No chest pain.',
      examination: 'Afebrile now, throat congestion present.',
      diagnosis: 'Viral upper respiratory infection.',
      plan: 'Symptomatic treatment and review if worsening.'
    };
    findUniqueMock.mockResolvedValueOnce({
      id: 55,
      note_type: 'op_consultation',
      version: 1,
      content: { ...opContent, diagnosis: 'Old diagnosis' },
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      is_signed: false,
      appointment_id: 101
    });
    appointmentFindUniqueMock.mockResolvedValueOnce({
      id: 101,
      doctor_id: 990902,
      status: 'CONFIRMED'
    });
    userFindUniqueMock.mockResolvedValueOnce({ uid: ORIGINAL_AUTHOR_UID });
    updateMock.mockImplementationOnce(async ({ where, data }) => ({
      id: where.id,
      encounter_id: null,
      appointment_id: 101,
      patient_uid: 'patient-uid',
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      note_type: 'op_consultation',
      content: data.content,
      version: data.version,
      parent_note_id: null,
      is_addendum: false,
      is_signed: false,
      signed_at: null,
      signed_by: null,
      created_at: new Date('2026-06-05T10:00:00Z'),
      updated_at: data.updated_at
    }));
    usersFindManyMock.mockResolvedValueOnce([
      { uid: ORIGINAL_AUTHOR_UID, name: 'Original Doctor' }
    ]);

    const result = await updateNote(55, opContent, ORIGINAL_AUTHOR_UID, 'DOCTOR', {
      id: 990902,
      uid: ORIGINAL_AUTHOR_UID,
      role: 'DOCTOR'
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].data.content).toEqual(opContent);
    expect(updateMock.mock.calls[0][0].data.version).toBe(2);
    expect(result.content).toEqual(opContent);
    expect(result.version).toBe(2);
    expect(result.author_name).toBe('Original Doctor');
  });
});

describe('createNote — OP appointment session guard', () => {
  const opContent = {
    chief_complaint: 'Chest discomfort since morning.',
    history: 'No syncope. No fever.',
    examination: 'Pulse 78/min, BP 126/80 mm Hg.',
    diagnosis: 'CAD under evaluation.',
    plan: 'ECG, troponin, and cardiology follow-up.'
  };

  it('throws 409 when the OP appointment already has a consultation note', async () => {
    appointmentFindUniqueMock.mockResolvedValueOnce({
      id: 101,
      doctor_id: 990902,
      status: 'CONFIRMED',
      appointment_date: new Date()
    });
    findFirstMock.mockResolvedValueOnce({ id: 55 });
    userFindUniqueMock.mockResolvedValueOnce({ uid: ORIGINAL_AUTHOR_UID });

    await expect(
      createNote({
        patient_uid: 'patient-uid',
        author_uid: ORIGINAL_AUTHOR_UID,
        author_role: 'DOCTOR',
        note_type: 'op_consultation',
        content: opContent,
        appointment_id: 101,
        acting_user: { id: 990902, uid: ORIGINAL_AUTHOR_UID, role: 'DOCTOR' }
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'OP_NOTE_ALREADY_EXISTS'
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('throws 409 when a new OP note is created after the appointment date', async () => {
    appointmentFindUniqueMock.mockResolvedValueOnce({
      id: 101,
      doctor_id: 990902,
      status: 'CONFIRMED',
      appointment_date: new Date('2000-01-01T00:00:00.000Z')
    });

    await expect(
      createNote({
        patient_uid: 'patient-uid',
        author_uid: ORIGINAL_AUTHOR_UID,
        author_role: 'DOCTOR',
        note_type: 'op_consultation',
        content: opContent,
        appointment_id: 101,
        acting_user: { id: 990902, uid: ORIGINAL_AUTHOR_UID, role: 'DOCTOR' }
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'OP_NOTE_SESSION_CLOSED'
    });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('creates one OP consultation note for an open same-day appointment', async () => {
    appointmentFindUniqueMock.mockResolvedValueOnce({
      id: 101,
      doctor_id: 990902,
      status: 'CONFIRMED',
      appointment_date: new Date()
    });
    findFirstMock.mockResolvedValueOnce(null);
    userFindUniqueMock.mockResolvedValueOnce({ uid: ORIGINAL_AUTHOR_UID });
    createMock.mockImplementationOnce(async ({ data }) => ({
      id: 56,
      encounter_id: null,
      appointment_id: data.appointment_id,
      patient_uid: data.patient_uid,
      author_uid: data.author_uid,
      author_role: data.author_role,
      note_type: data.note_type,
      title: data.title,
      content: data.content,
      version: data.version,
      parent_note_id: null,
      is_addendum: false,
      is_signed: false,
      signed_at: null,
      signed_by: null,
      created_at: new Date(),
      updated_at: new Date()
    }));
    usersFindManyMock.mockResolvedValueOnce([
      { uid: ORIGINAL_AUTHOR_UID, name: 'Original Doctor' }
    ]);

    const result = await createNote({
      patient_uid: 'patient-uid',
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
      note_type: 'op_consultation',
      title: 'OP consultation - Patient',
      content: opContent,
      appointment_id: 101,
      acting_user: { id: 990902, uid: ORIGINAL_AUTHOR_UID, role: 'DOCTOR' }
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data).toMatchObject({
      appointment_id: 101,
      note_type: 'op_consultation',
      version: 1,
      is_signed: false
    });
    expect(result.id).toBe(56);
    expect(result.author_name).toBe('Original Doctor');
  });
});
