import moment from 'moment';
import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';

export const formatDate = (date) => {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
};

export const parseDate = (dateString) => {
  const ddmmyyyyRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
  if (ddmmyyyyRegex.test(dateString)) {
    const [, day, month, year] = dateString.match(ddmmyyyyRegex);
    return new Date(`${year}-${month}-${day}`);
  }
  return new Date(dateString);
};

export const formatTime = (time) => {
  return moment(time, 'HH:mm:ss').format(APPOINTMENT_CONFIG.TIME_FORMAT);
};

export const getCurrentDate = () => {
  return moment().format('YYYY-MM-DD');
};

export const combineDateAndTime = (date, time) => {
  const dateStr = moment(date).format('YYYY-MM-DD');
  return new Date(`${dateStr}T${time}`);
};

export const isValidTimeSlot = (time) => {
  return moment(time, APPOINTMENT_CONFIG.TIME_FORMAT, true).isValid();
};