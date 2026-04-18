export function calculateWorkingHours(checkIn, checkOut, breakMinutes = 0) {
  if (!checkIn || !checkOut) {return 0;}
  const diff = new Date(checkOut) - new Date(checkIn);
  const hours = diff / (1000 * 60 * 60);
  const breakHours = breakMinutes / 60;
  return Math.max(0, hours - breakHours);
}

export function calculateOvertimeHours(workingHours, standardHours = 8) {
  return Math.max(0, workingHours - standardHours);
}

export function isLateCheckIn(checkIn, shiftStart) {
  const checkInTime = new Date(checkIn);
  const [hours, minutes] = shiftStart.split(':');
  const shiftTime = new Date(checkIn);
  shiftTime.setHours(parseInt(hours), parseInt(minutes), 0);
  
  return checkInTime > shiftTime;
}

export function formatAttendanceTime(date) {
  if (!date) {return null;}
  return new Date(date).toLocaleString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}