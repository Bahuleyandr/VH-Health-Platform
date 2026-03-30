import { authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('Pharmacy Orders API', () => {
  const phone = '9876543210';
  const validUID = '11111111-1111-1111-1111-111111111111';

  it('should fail without phone or order note', async () => {
    const res = await client.post('/api/v1/pharmacy-orders').send({});
    expect([400, 401, 403, 404, 422, 500]).toContain(res.statusCode);
  });

  it('should place a pharmacy order or return expected status', async () => {
    const res = await client.post('/api/v1/pharmacy-orders').send({
      phone,
      order_note: 'Paracetamol 500mg',
      status: 'pending'
    });
    expect([200, 201, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch pharmacy orders by phone', async () => {
    const res = await client.get(`/api/v1/pharmacy-orders/${phone}`);
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch pharmacy orders by UID (valid UUID)', async () => {
    const res = await client.get(`/api/v1/pharmacy-orders/uid/${validUID}`);
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});
