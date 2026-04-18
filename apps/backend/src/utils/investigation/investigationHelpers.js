// Format date to DD-MM-YYYY
export function formatDateDDMMYYYY(date) {
  if (!date) {return null;}
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// Format datetime to DD-MM-YYYY HH:mm
export function formatDateTimeDDMMYYYY(date) {
  if (!date) {return null;}
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

// Calculate priority score
export function calculatePriorityScore(priority, orderedDate) {
  const priorityWeights = {
    URGENT: 100,
    HIGH: 75,
    NORMAL: 50,
    LOW: 25
  };
  
  const ageInHours = (new Date() - new Date(orderedDate)) / (1000 * 60 * 60);
  const ageWeight = Math.min(ageInHours / 24, 10); // Max 10 days weight
  
  return priorityWeights[priority] + ageWeight;
}

// Determine if investigation is overdue
export function isOverdue(scheduledDate, status) {
  if (!scheduledDate || status === 'COMPLETED' || status === 'CANCELLED') {
    return false;
  }
  
  return new Date(scheduledDate) < new Date();
}

// Calculate turnaround time
export function calculateTurnaroundTime(orderedDate, completedDate) {
  if (!orderedDate || !completedDate) {return null;}
  
  const diff = new Date(completedDate) - new Date(orderedDate);
  const hours = diff / (1000 * 60 * 60);
  
  if (hours < 24) {
    return `${Math.round(hours)} hours`;
  } else {
    return `${Math.round(hours / 24)} days`;
  }
}