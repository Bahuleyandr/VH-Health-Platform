import rbacConfig from '../../config/rbacConfig.js';
import { PATIENT } from '../../utils/roles.js';

describe('patient record route RBAC', () => {
  it('allows authenticated patients to reach self-scoped record routes', () => {
    expect(rbacConfig.recordRoutes).toContain(PATIENT);
  });
});
