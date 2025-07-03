import PDFDocument from 'pdfkit';
import { formatDateDDMMYYYY, formatDateTimeDDMMYYYY } from '../../utils/investigation/investigationHelpers.js';

export const generateInvestigationReport = async (investigationId) => {
  // Fetch investigation details
  const investigation = await getInvestigationWithDetails(investigationId);
  
  const doc = new PDFDocument();
  const chunks = [];
  
  doc.on('data', chunk => chunks.push(chunk));
  
  // Header
  doc.fontSize(20).text('Investigation Report', { align: 'center' });
  doc.moveDown();
  
  // Patient Information
  doc.fontSize(14).text('Patient Information', { underline: true });
  doc.fontSize(12);
  doc.text(`Name: ${investigation.patient_name}`);
  doc.text(`ID: ${investigation.patient_id}`);
  doc.text(`Gender: ${investigation.gender}`);
  doc.text(`Age: ${calculateAge(investigation.birthday)} years`);
  doc.moveDown();
  
  // Investigation Details
  doc.fontSize(14).text('Investigation Details', { underline: true });
  doc.fontSize(12);
  doc.text(`Test Name: ${investigation.test_name}`);
  doc.text(`Test Code: ${investigation.test_code || 'N/A'}`);
  doc.text(`Type: ${investigation.type}`);
  doc.text(`Ordered Date: ${formatDateDDMMYYYY(investigation.ordered_date)}`);
  doc.text(`Completed Date: ${formatDateDDMMYYYY(investigation.completed_date)}`);
  doc.moveDown();
  
  // Results
  doc.fontSize(14).text('Results', { underline: true });
  doc.fontSize(12);
  doc.text(`Result: ${investigation.results}`);
  doc.text(`Normal Range: ${investigation.normal_range || 'N/A'}`);
  doc.text(`Unit: ${investigation.unit || 'N/A'}`);
  doc.moveDown();
  
  // Interpretation
  if (investigation.interpretation) {
    doc.fontSize(14).text('Interpretation', { underline: true });
    doc.fontSize(12);
    doc.text(investigation.interpretation);
    doc.moveDown();
  }
  
  // Doctor Information
  doc.fontSize(14).text('Ordered By', { underline: true });
  doc.fontSize(12);
  doc.text(`Dr. ${investigation.doctor_name}`);
  doc.text(`Department: ${investigation.department}`);
  doc.text(`Specialization: ${investigation.specialization}`);
  
  // Footer
  doc.fontSize(10);
  doc.text(`Generated on: ${formatDateTimeDDMMYYYY(new Date())}`, 50, 700);
  
  doc.end();
  
  return new Promise((resolve) => {
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      resolve(pdfBuffer);
    });
  });
};

async function getInvestigationWithDetails(id) {
  const result = await db.query(`
    SELECT i.*, 
           p.name as patient_name, p.birthday, p.gender,
           d.name as doctor_name,
           dept.department, dept.specialization
    FROM investigations i
    JOIN users p ON i.patient_id = p.id
    JOIN users d ON i.doctor_id = d.id
    LEFT JOIN doctors dept ON d.id = dept.user_id
    WHERE i.id = $1
  `, [id]);
  
  if (result.rows.length === 0) {
    throw new Error('Investigation not found');
  }
  
  return result.rows[0];
}

function calculateAge(birthday) {
  const birth = new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  
  return age;
}