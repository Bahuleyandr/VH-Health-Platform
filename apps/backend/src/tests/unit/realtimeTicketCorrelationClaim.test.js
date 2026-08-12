import express from 'express';
import request from 'supertest';

import realtimeTicketRoutes from '../../routes/realtime/realtimeTicketRoutes.js';
import { verifyToken } from '../../utils/jwtUtils.js';

const ACCESS_JTI = 'authenticated-access-session-jti';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = 'd0000000-0000-4000-8000-000000000003';
  req.user = {
    uid: 'b0000000-0000-4000-8000-000000000001',
    role: 'PATIENT',
    jti: ACCESS_JTI,
    scope: 'full',
  };
  next();
});
app.use('/api/v1/realtime', realtimeTicketRoutes);

describe('POST /api/v1/realtime/ticket access-session correlation claim', () => {
  it('signs the authenticated access jti and ignores a request-supplied substitute', async () => {
    const response = await request(app)
      .post('/api/v1/realtime/ticket')
      .send({ accessSessionJti: 'attacker-selected-jti' });

    expect(response.status).toBe(200);
    const decoded = verifyToken(response.body.data.ticket);
    expect(decoded.accessSessionJti).toBe(ACCESS_JTI);
    expect(decoded.jti).not.toBe(ACCESS_JTI);
  });
});
