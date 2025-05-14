// controllers/pharmacyController.js
const pool = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../responseHelper');

exports.placePharmacyOrder = async (req, res) => {
  const { phone, order_note } = req.body;
  if (!phone || !order_note) {
    return res.status(400).json({ error: 'Phone and order note are required' });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO pharmacy_orders (phone, order_note)
      VALUES ($1, $2)
      RETURNING *;
      `,
      [phone, order_note]
    );
    success(res, result.rows[0], 'Pharmacy order placed');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

exports.getPharmacyOrdersByPhone = async (req, res) => {
  try {
    const { phone } = req.params;

    const result = await pool.query(
      `
      SELECT * FROM pharmacy_orders
      WHERE phone = $1;
      `,
      [phone]
    );

    success(res, result.rows, 'Pharmacy orders fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};
