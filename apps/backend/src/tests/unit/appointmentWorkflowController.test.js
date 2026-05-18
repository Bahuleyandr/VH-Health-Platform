import { deptPrefix } from '../../controllers/appointment/appointmentWorkflowController.js';

describe('appointmentWorkflowController.deptPrefix', () => {
  it('does not classify medicine-like department names as emergency via the ed alias', () => {
    expect(deptPrefix('Smoke Medicine')).toBe('OPD');
    expect(deptPrefix('General Medicine')).toBe('OPD');
  });

  it('still supports explicit emergency abbreviations', () => {
    expect(deptPrefix('ED')).toBe('EMER');
    expect(deptPrefix('ER')).toBe('EMER');
  });
});
