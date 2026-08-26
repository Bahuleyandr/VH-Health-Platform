import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const getAppointmentByIdMock = jest.fn();

jest.unstable_mockModule('../../services/appointment/appointmentQueryService.js', () => ({
  default: { getAppointmentById: getAppointmentByIdMock }
}));

const { getAppointmentById } =
  await import('../../controllers/appointment/appointmentListController.js');

function responseDouble() {
  const res = { req: { id: 'request-id' } };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  getAppointmentByIdMock.mockReset();
});

test('stable-ID appointment detail hydrates inside the authenticated tenant', async () => {
  getAppointmentByIdMock.mockResolvedValue({
    id: 42,
    patient_id: 7,
    doctor_name: 'Dr Example'
  });
  const req = {
    params: { id: '42' },
    tenantId: TENANT_ID,
    user: { id: 7, role: 'PATIENT', name: 'Patient' }
  };
  const res = responseDouble();

  await getAppointmentById(req, res);

  expect(getAppointmentByIdMock).toHaveBeenCalledWith('42', TENANT_ID);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        appointment: expect.objectContaining({ id: 42 })
      })
    })
  );
});
