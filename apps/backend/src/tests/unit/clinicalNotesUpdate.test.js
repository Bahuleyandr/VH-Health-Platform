// Unit test — clinicalNotesService.updateNote (admin override path).
// Confirms: clinical roles get a 403; ADMIN overwrites content + bumps
// version; missing note → 404; content failing the per-type required-
// fields validator → 400.
//
// Append-only is still the rule for everyone else — addAddendum + signNote
// remain the only state-mutating paths for DOCTOR / NURSE / etc. updateNote
// exists for explicit corrections that must replace the original row.

import { jest } from '@jest/globals';

const findUniqueMock = jest.fn();
const updateMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    clinical_notes: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
}));

const { updateNote } = await import('../../services/emr/clinicalNotesService.js');

const EDITOR_UID = '00000000-0000-4000-8000-00000000aaaa';
const ORIGINAL_AUTHOR_UID = '11111111-1111-4111-8111-1111111111bb';
const VALID_SOAP_CONTENT = {
  subjective: 'Patient reports chest pain has resolved overnight.',
  objective: 'HR 72, BP 124/78, afebrile.',
  assessment: 'Non-cardiac chest pain, low risk.',
  plan: 'Discharge home with PRN antacid; follow up in 2 weeks.',
};

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
});

describe('updateNote — admin gate', () => {
  it('throws 403 ADMIN_ONLY_NOTE_EDIT when editor is a DOCTOR', async () => {
    await expect(
      updateNote(1, VALID_SOAP_CONTENT, EDITOR_UID, 'DOCTOR'),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'ADMIN_ONLY_NOTE_EDIT',
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws 403 when editor is a NURSE (even on a note the nurse authored)', async () => {
    await expect(
      updateNote(1, VALID_SOAP_CONTENT, ORIGINAL_AUTHOR_UID, 'NURSE'),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'ADMIN_ONLY_NOTE_EDIT',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws 400 when editorUid is missing', async () => {
    await expect(
      updateNote(1, VALID_SOAP_CONTENT, null, 'ADMIN'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 when content is empty / not an object', async () => {
    await expect(
      updateNote(1, null, EDITOR_UID, 'ADMIN'),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      updateNote(1, {}, EDITOR_UID, 'ADMIN'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('updateNote — admin overwrite path', () => {
  it('throws 404 when the note id does not exist', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    await expect(
      updateNote(999, VALID_SOAP_CONTENT, EDITOR_UID, 'ADMIN'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 400 when new content is missing per-note-type required fields', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 1,
      note_type: 'soap',
      version: 1,
      content: VALID_SOAP_CONTENT,
      author_uid: ORIGINAL_AUTHOR_UID,
      author_role: 'DOCTOR',
    });

    await expect(
      updateNote(1, { subjective: 'only this' }, EDITOR_UID, 'ADMIN'),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_NOTE_CONTENT',
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
      updated_at: data.updated_at,
    }));

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
    expect(result.content).toEqual(VALID_SOAP_CONTENT);
  });
});
