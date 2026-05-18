import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn() },
}));

const theatreService = (await import('../../services/theatre/theatreService.js')).default;

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

function rightEyeSchedule() {
  return {
    id: 3,
    status: 'pre_op',
    procedure_name: 'Right eye cataract surgery',
    procedure_code: null,
  };
}

describe('theatreService.completeChecklist', () => {
  it('rejects OT-ready when the surgical site is not marked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([rightEyeSchedule()]);

    await expect(theatreService.completeChecklist(3, {
      ot_ready: true,
      fasting_confirmed: true,
      site_marked: false,
      site_marked_eye: 'right',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'SURGICAL_SITE_MARK_REQUIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects OT-ready when the marked side does not match the procedure', async () => {
    queryUnsafeMock.mockResolvedValueOnce([rightEyeSchedule()]);

    await expect(theatreService.completeChecklist(3, {
      ot_ready: true,
      fasting_confirmed: true,
      site_marked: true,
      site_marked_eye: 'left',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'SURGICAL_SITE_SIDE_MISMATCH',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('persists OT-ready when the site mark matches the scheduled side', async () => {
    const checklist = {
      ot_ready: true,
      fasting_confirmed: true,
      site_marked: true,
      site_marked_eye: 'right',
    };
    queryUnsafeMock
      .mockResolvedValueOnce([rightEyeSchedule()])
      .mockResolvedValueOnce([{ id: 3, pre_op_checklist: checklist }]);

    const result = await theatreService.completeChecklist(3, checklist);

    expect(result.id).toBe(3);
    expect(JSON.parse(queryUnsafeMock.mock.calls[1][1])).toMatchObject(checklist);
  });

  it('rejects OT-ready when the checklist itself marks the patient diabetic without glucose', async () => {
    queryUnsafeMock.mockResolvedValueOnce([rightEyeSchedule()]);

    await expect(theatreService.completeChecklist(3, {
      ot_ready: true,
      fasting_confirmed: true,
      site_marked: true,
      site_marked_eye: 'right',
      diabetic_patient: true,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'DIABETIC_GLUCOSE_CHECK_REQUIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });
});
