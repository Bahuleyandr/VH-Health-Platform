import { format, parse, isValid } from 'date-fns';
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
  // Parse HH:mm:ss or HH:mm and format to APPOINTMENT_CONFIG.TIME_FORMAT (HH:mm)
  const parsed = parse(time, 'HH:mm:ss', new Date());
  if (isValid(parsed)) {
    return format(parsed, APPOINTMENT_CONFIG.TIME_FORMAT);
  }
  const parsedShort = parse(time, 'HH:mm', new Date());
  if (isValid(parsedShort)) {
    return format(parsedShort, APPOINTMENT_CONFIG.TIME_FORMAT);
  }
  return time;
};

export const getCurrentDate = () => {
  return format(new Date(), 'yyyy-MM-dd');
};

export const combineDateAndTime = (date, time) => {
  const dateStr = format(new Date(date), 'yyyy-MM-dd');
  return new Date(`${dateStr}T${time}`);
};

export const isValidTimeSlot = (time) => {
  const parsed = parse(time, APPOINTMENT_CONFIG.TIME_FORMAT, new Date());
  return isValid(parsed);
};
