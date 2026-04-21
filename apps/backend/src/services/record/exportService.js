import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatDateForDisplay } from '../../utils/record/recordHelpers.js';
import * as recordService from './recordService.js';

export async function exportRecordsToPDF(filters, userRole) {
  const doc = new PDFDocument();
  const chunks = [];
  
  doc.on('data', chunk => chunks.push(chunk));
  
  // Header
  doc.fontSize(20).text('Medical Records Report', 50, 50);
  doc.fontSize(12).text(`Generated: ${formatDateForDisplay(new Date())}`, 50, 80);
  
  // Get records
  const { records } = await recordService.getMedicalRecords(filters, userRole);
  
  // Table headers
  let yPosition = 120;
  doc.fontSize(10);
  doc.text('Date', 50, yPosition);
  doc.text('Patient', 150, yPosition);
  doc.text('Type', 250, yPosition);
  doc.text('Doctor', 350, yPosition);
  doc.text('Title', 450, yPosition);
  
  // Records
  yPosition += 20;
  records.forEach(record => {
    if (yPosition > 700) {
      doc.addPage();
      yPosition = 50;
    }
    
    doc.text(formatDateForDisplay(record.created_at), 50, yPosition);
    doc.text(record.patient_name || 'N/A', 150, yPosition);
    doc.text(record.record_type, 250, yPosition);
    doc.text(record.doctor_name || 'N/A', 350, yPosition);
    doc.text((record.title || '').substring(0, 30), 450, yPosition);
    
    yPosition += 20;
  });
  
  doc.end();
  
  return new Promise((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

export async function exportRecordsToExcel(filters, userRole) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Medical Records');
  
  // Headers
  worksheet.columns = [
    { header: 'Record ID', key: 'id', width: 10 },
    { header: 'Date', key: 'created_at_formatted', width: 15 },
    { header: 'Patient Name', key: 'patient_name', width: 20 },
    { header: 'Patient Phone', key: 'patient_phone', width: 15 },
    { header: 'Record Type', key: 'record_type', width: 15 },
    { header: 'Title', key: 'title', width: 30 },
    { header: 'Doctor', key: 'doctor_name', width: 20 },
    { header: 'Department', key: 'department', width: 20 },
    { header: 'Privacy Level', key: 'privacy_level', width: 15 }
  ];
  
  // Style headers
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };
  
  // Get records
  const { records } = await recordService.getMedicalRecords(filters, userRole);
  
  // Add data
  records.forEach(record => {
    worksheet.addRow({
      ...record,
      created_at_formatted: formatDateForDisplay(record.created_at)
    });
  });
  
  // Auto-filter
  worksheet.autoFilter = {
    from: 'A1',
    to: `I${records.length + 1}`
  };
  
  return await workbook.xlsx.writeBuffer();
}
