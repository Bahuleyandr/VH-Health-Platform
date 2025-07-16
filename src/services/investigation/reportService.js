import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import db from '../../config/database.js';
import { formatDateDDMMYYYY, formatDateTimeDDMMYYYY } from '../../utils/investigation/investigationHelpers.js';
// import { sendEmail } from '../../utils/emailService.js'; // Assuming you have an email utility

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

/**
 * Generates a summary PDF for a patient's investigations.
 */
export const generatePatientSummaryReport = async ({ patient_id, date_from, date_to, type }) => {
  let query = `SELECT * FROM investigations WHERE patient_id = $1 AND status = 'COMPLETED'`;
  const params = [patient_id];

  if (date_from && date_to) {
    query += ` AND ordered_date BETWEEN $${params.length + 1} AND $${params.length + 2}`;
    params.push(date_from, date_to);
  }
  if (type) {
    query += ` AND type = $${params.length + 1}`;
    params.push(type);
  }
  query += ' ORDER BY ordered_date DESC';
  
  const investigations = await db.query(query, params);
  
  const doc = new PDFDocument();
  doc.fontSize(18).text(`Investigation Summary for Patient ID: ${patient_id}`, { align: 'center' });
  doc.moveDown();
  
  investigations.rows.forEach(inv => {
    doc.fontSize(12).text(`Test: ${inv.test_name}`, { underline: true });
    doc.text(`Date: ${formatDateDDMMYYYY(inv.ordered_date)} | Result: ${inv.results}`);
    doc.moveDown(0.5);
  });
  
  doc.end();
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  
  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};

/**
 * Exports a list of investigations to an Excel buffer.
 */
export const exportInvestigationsToExcel = async (filters) => {
  // This would contain query logic similar to your controller to fetch data
  const result = await db.query('SELECT * FROM investigations WHERE status = $1 LIMIT 100', [filters.status || 'COMPLETED']);
  const investigations = result.rows;

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Investigations');

  worksheet.columns = [
    { header: 'ID', key: 'id', width: 10 },
    { header: 'Patient ID', key: 'patient_id', width: 15 },
    { header: 'Test Name', key: 'test_name', width: 30 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Ordered Date', key: 'ordered_date', width: 20 },
  ];

  worksheet.addRows(investigations);
  return workbook.xlsx.writeBuffer();
};

/**
 * Generates an object with investigation statistics.
 */
export const generateStatisticsReport = async ({ period, year }) => {
  const result = await db.query(`
    SELECT to_char(ordered_date, 'YYYY-MM') as month, type, COUNT(*) as count
    FROM investigations
    WHERE extract(year from ordered_date) = $1
    GROUP BY month, type
    ORDER BY month, type;
  `, [year]);
  
  return result.rows.reduce((acc, row) => {
    if (!acc[row.month]) acc[row.month] = {};
    acc[row.month][row.type] = parseInt(row.count, 10);
    return acc;
  }, {});
};

/**
 * Emails an investigation report.
 */
export const emailInvestigationReport = async (investigationId, emailOptions, sentBy) => {
  const pdfBuffer = await generateInvestigationReport(investigationId);
  const investigation = await getInvestigationWithDetails(investigationId);

  const mailOptions = {
    to: emailOptions.email,
    cc: emailOptions.cc,
    subject: `Investigation Report: ${investigation.test_name}`,
    text: emailOptions.message || `Please find the attached report for ${investigation.patient_name}.`,
    attachments: [{
      filename: `investigation_report_${investigationId}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  };
  
  // await sendEmail(mailOptions); // This calls your email utility

  return { success: true, messageId: 'mock-message-id' }; // Mock response
};