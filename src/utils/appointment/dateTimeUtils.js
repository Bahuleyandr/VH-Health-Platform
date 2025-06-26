import moment from 'moment';
import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';

export const formatDate = (date) => {
  return moment(date).format(APPOINTMENT_CONFIG.DATE_FORMAT);
};

export const parseDate = (dateString) => {
  return moment(dateString, APPOINTMENT_CONFIG.DATE_FORMAT).toDate();
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