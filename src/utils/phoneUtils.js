// src/utils/phoneUtils.js

exports.normalizePhone = (phone) => {
  if (!phone) return phone;

  phone = phone.replace(/\D/g, '');

  if (phone.length === 11 && phone.startsWith('0')) {
    phone = phone.substring(1);
  }

  if (phone.length === 10) {
    phone = '+91' + phone;
  }

  if (!phone.startsWith('+')) {
    phone = '+' + phone;
  }

  return phone;
};
