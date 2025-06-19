// src/utils/smsService.js

import axios from 'axios';
import logger from '../logging/logger.js';

const MSG91_API_KEY = process.env.MSG91_API_KEY;
const SENDER_ID = 'VHHEAL'; // Ensure this is approved in MSG91 dashboard
const ROUTE = '4'; // Transactional route

const BASE_URL = 'https://api.msg91.com/api/v2/sendsms';

export default {
  /**
   * 📩 Send an SMS using MSG91
   * @param {string} phone - Recipient's phone number in international format (e.g., 919876543210)
   * @param {string} message - Message content to be sent
   */
  async sendSMS(phone, message) {
    if (!MSG91_API_KEY) {
      logger.error('❌ MSG91 API key is missing in environment variables');
      throw new Error('MSG91 API key is not configured');
    }

    const payload = {
      sender: SENDER_ID,
      route: ROUTE,
      country: '91',
      sms: [
        {
          message,
          to: [phone],
        },
      ],
    };

    try {
      const response = await axios.post(BASE_URL, payload, {
        headers: {
          authkey: MSG91_API_KEY,
          'Content-Type': 'application/json',
        },
      });

      const { data } = response;
      if (data && data.type === 'success') {
        logger.info(`✅ SMS sent successfully to ${phone}`);
      } else {
        logger.warn(`⚠️ SMS sent but not confirmed as success: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      logger.error(`❌ Failed to send SMS to ${phone}: ${err.message}`);
      throw new Error('SMS sending failed');
    }
  },
};
