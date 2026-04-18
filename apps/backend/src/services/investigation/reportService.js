// src/services/investigation/reportService.js
// Migrated from raw pg to Prisma ORM

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import prisma from '../../lib/prisma.js';
import { formatDateDDMMYYYY, formatDateTimeDDMMYYYY } from '../../utils/investigation/investigationHelpers.js';

async function getInvestigationWithDetails(id) {
  const rows = await prisma.$queryRaw`
    SELECT i.id, i.uid, i.phone, i.test_name, i.test_code, i.type, i.status,
           i.priority, i.notes, i.results, i.interpretation, i.normal_range,
           i.unit, i.cost, i.ordered_date, i.completed_date, i.created_at, i.updated_at,
           p.name AS patient_name, p.birthday, p.gender,
           d.name AS doctor_name,
           dept.department, dept.specialization
    FROM investigations i
    JOIN users p ON i.patient_id = p.id
    JOIN users d ON i.doctor_id = d.id
    LEFT JOIN doctors dept ON d.id = dept.user_id
    WHERE i.id = ${parseInt(id)}
  `;

  if (rows.length === 0) throw new Error('Investigation not found');
  return rows[0];
}

function calculateAge(birthday) {
  const birth = new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

export const generateInvestigationReport = async (investigationId) => {
  const investigation = await getInvestigationWithDetails(investigationId);

  const doc = new PDFDocument();
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));

  doc.fontSize(20).text('Investigation Report', { align: 'center' });
  doc.moveDown();

  doc.fontSize(14).text('Patient Information', { underline: true });
  doc.fontSize(12);
  doc.text(`Name: ${investigation.patient_name}`);
  doc.text(`ID: ${investigation.id}`);
  doc.text(`Gender: ${investigation.gender}`);
  doc.text(`Age: ${calculateAge(investigation.birthday)} years`);
  doc.moveDown();

  doc.fontSize(14).text('Investigation Details', { underline: true });
  doc.fontSize(12);
  doc.text(`Test Name: ${investigation.test_name}`);
  doc.text(`Test Code: ${investigation.test_code || 'N/A'}`);
  doc.text(`Type: ${investigation.type}`);
  doc.text(`Ordered Date: ${formatDateDDMMYYYY(investigation.ordered_date)}`);
  doc.text(`Completed Date: ${formatDateDDMMYYYY(investigation.completed_date)}`);
  doc.moveDown();

  doc.fontSize(14).text('Results', { underline: true });
  doc.fontSize(12);
  doc.text(`Result: ${investigation.results}`);
  doc.text(`Normal Range: ${investigation.normal_range || 'N/A'}`);
  doc.text(`Unit: ${investigation.unit || 'N/A'}`);
  doc.moveDown();

  if (investigation.interpretation) {
    doc.fontSize(14).text('Interpretation', { underline: true });
    doc.fontSize(12);
    doc.text(investigation.interpretation);
    doc.moveDown();
  }

  doc.fontSize(14).text('Ordered By', { underline: true });
  doc.fontSize(12);
  doc.text(`Dr. ${investigation.doctor_name}`);
  doc.text(`Department: ${investigation.department}`);
  doc.text(`Specialization: ${investigation.specialization}`);

  doc.fontSize(10).text(`Generated on: ${formatDateTimeDDMMYYYY(new Date())}`, 50, 700);
  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};

export const generatePatientSummaryReport = async ({ patient_id, date_from, date_to, type }) => {
  let rows;
  if (date_from && date_to && type) {
    rows = await prisma.$queryRaw`
      SELECT id, uid, phone, test_name, type, status, priority, notes, results,
             ordered_date, completed_date, created_at, updated_at
      FROM investigations
      WHERE patient_id = ${parseInt(patient_id)} AND status = 'COMPLETED'
        AND ordered_date BETWEEN ${new Date(date_from)} AND ${new Date(date_to)}
        AND type = ${type}
      ORDER BY ordered_date DESC
    `;
  } else if (date_from && date_to) {
    rows = await prisma.$queryRaw`
      SELECT id, uid, phone, test_name, type, status, priority, notes, results,
             ordered_date, completed_date, created_at, updated_at
      FROM investigations
      WHERE patient_id = ${parseInt(patient_id)} AND status = 'COMPLETED'
        AND ordered_date BETWEEN ${new Date(date_from)} AND ${new Date(date_to)}
      ORDER BY ordered_date DESC
    `;
  } else if (type) {
    rows = await prisma.$queryRaw`
      SELECT id, uid, phone, test_name, type, status, priority, notes, results,
             ordered_date, completed_date, created_at, updated_at
      FROM investigations
      WHERE patient_id = ${parseInt(patient_id)} AND status = 'COMPLETED'
        AND type = ${type}
      ORDER BY ordered_date DESC
    `;
  } else {
    rows = await prisma.$queryRaw`
      SELECT id, uid, phone, test_name, type, status, priority, notes, results,
             ordered_date, completed_date, created_at, updated_at
      FROM investigations
      WHERE patient_id = ${parseInt(patient_id)} AND status = 'COMPLETED'
      ORDER BY ordered_date DESC
    `;
  }

  const doc = new PDFDocument();
  doc.fontSize(18).text(`Investigation Summary for Patient ID: ${patient_id}`, { align: 'center' });
  doc.moveDown();

  rows.forEach(inv => {
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

export const exportInvestigationsToExcel = async (filters) => {
  const status = filters.status || 'COMPLETED';
  const rows = await prisma.$queryRaw`
    SELECT id, uid, phone, test_name, type, status, priority, notes, results,
           ordered_date, completed_date, created_at, updated_at
    FROM investigations WHERE status = ${status} LIMIT 100
  `;

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Investigations');

  worksheet.columns = [
    { header: 'ID', key: 'id', width: 10 },
    { header: 'Test Name', key: 'test_name', width: 30 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Ordered Date', key: 'ordered_date', width: 20 },
  ];

  worksheet.addRows(rows);
  return workbook.xlsx.writeBuffer();
};

export const generateStatisticsReport = async ({ _period, year }) => {
  const rows = await prisma.$queryRaw`
    SELECT to_char(ordered_date, 'YYYY-MM') AS month, type, COUNT(*)::int AS count
    FROM investigations
    WHERE extract(year FROM ordered_date) = ${parseInt(year)}
    GROUP BY month, type
    ORDER BY month, type
  `;

  return rows.reduce((acc, row) => {
    if (!acc[row.month]) acc[row.month] = {};
    acc[row.month][row.type] = row.count;
    return acc;
  }, {});
};

export const emailInvestigationReport = async (investigationId, emailOptions, _sentBy) => {
  const pdfBuffer = await generateInvestigationReport(investigationId);
  const investigation = await getInvestigationWithDetails(investigationId);

  const _mailOptions = {
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

  return { success: true, messageId: 'mock-message-id' };
};
