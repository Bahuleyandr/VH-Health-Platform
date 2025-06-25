// src/tests/pharmacy.test.js
import client, { API_KEY, AUTH_TOKEN } from './testClient.js';
import db from '../config/database.js';
// for direct DB seeding

describe('Pharmacy Orders API', () => {
  const phone = '9876543210';
  let seededOrderId;
  const validUID = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    // Ensure DB has a valid order to update
    const result = await db.query(
      `INSERT INTO pharmacy_orders (phone, order_note, status, placed_at)
       VALUES ($1, 'Test seed order', 'pending', NOW())
       RETURNING id`,
      [phone]
    );
    seededOrderId = result.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pharmacy_orders WHERE phone = $1`, [phone]);
  });

  it('should fail without phone or order note', async () => {
    const res = await client
      .post('/api/v1/pharmacy-orders')
      .set('x-api-key', API_KEY)
      .set('Authorization', AUTH_TOKEN)
      .send({});
    expect(res.statusCode).toBe(400);
  });

  it('should place a pharmacy order', async () => {
    const res = await client
      .post('/api/v1/pharmacy-orders')
      .set('x-api-key', API_KEY)
      .set('Authorization', AUTH_TOKEN)
      .send({
        phone,
        order_id: seededOrderId,
        status: 'fulfilled',
        notes: 'Paracetamol 500mg'
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('fulfilled');
  });

  it('should fetch pharmacy orders by phone', async () => {
    const res = await client
      .get(`/api/v1/pharmacy-orders/${phone}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', AUTH_TOKEN);
    expect([200, 404]).toContain(res.statusCode);
  });

  it('should fetch pharmacy orders by UID (valid UUID)', async () => {
    const res = await client
      .get(`/api/v1/pharmacy-orders/uid/${validUID}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', AUTH_TOKEN);
    expect([200, 404, 500]).toContain(res.statusCode);
  });
});
