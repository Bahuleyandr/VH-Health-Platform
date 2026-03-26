// src/utils/payslipPDF.js
// PDFKit-based payslip generator
import PDFDocument from 'pdfkit';

function getMonthName(m) {
  return ['January','February','March','April','May','June','July','August','September','October','November','December'][m - 1];
}

function formatAmount(n) {
  const num = parseFloat(n || 0);
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function numberToWords(n) {
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  if (n === 0) return 'Zero';
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' And ' + numberToWords(n % 100) : '');
  if (n < 100000) return numberToWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '');
  return numberToWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + numberToWords(n % 100000) : '');
}

/**
 * Generate a PDF payslip buffer.
 * @param {Object} payslipData - from calculatePayslip()
 * @param {Object} staffDetails - { name, role, department }
 * @returns {Promise<Buffer>}
 */
export async function generatePayslipPDF(payslipData, staffDetails) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const sal = payslipData.salary_config || {};
    const leftX = 40;
    const rightX = 315;
    const pageWidth = 555;

    // ─── Header ──────────────────────────────────────────────────────────────
    doc.rect(leftX, 30, pageWidth, 60).fill('#007A64');
    doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
      .text('VENKATAESWARA HOSPITALS', leftX + 10, 38, { align: 'center', width: pageWidth });
    doc.fontSize(9).font('Helvetica')
      .text('Nandanam, Chennai – 600 035 | Tel: 044-24334455', leftX + 10, 58, { align: 'center', width: pageWidth });

    doc.fillColor('#333').fontSize(13).font('Helvetica-Bold')
      .text('SALARY SLIP', leftX, 100, { align: 'center', width: pageWidth });
    doc.fontSize(10).font('Helvetica')
      .text(`For the month of ${getMonthName(payslipData.month)} ${payslipData.year}`, leftX, 116, { align: 'center', width: pageWidth });

    doc.moveDown(0.5);

    // ─── Employee Info Box ────────────────────────────────────────────────────
    const infoTop = 140;
    doc.rect(leftX, infoTop, pageWidth, 110).stroke('#ccc');
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555').text('EMPLOYEE DETAILS', leftX + 5, infoTop + 5);

    const infoRows = [
      ['Employee Name', staffDetails.name || '—'],
      ['Employee ID', sal.employee_id || '—'],
      ['Designation', sal.designation || staffDetails.role || '—'],
      ['Department', sal.department || staffDetails.department || '—'],
      ['Date of Joining', sal.date_of_joining ? new Date(sal.date_of_joining).toLocaleDateString('en-IN') : '—'],
      ['PF UAN', sal.pf_uan || '—'],
    ];
    const col1 = leftX + 5, col2 = leftX + 130, col3 = rightX, col4 = rightX + 125;
    let infoY = infoTop + 18;
    for (let i = 0; i < infoRows.length; i += 2) {
      doc.font('Helvetica-Bold').fillColor('#444').fontSize(8)
        .text(infoRows[i][0] + ':', col1, infoY, { width: 120 });
      doc.font('Helvetica').fillColor('#000')
        .text(infoRows[i][1], col2, infoY, { width: 160 });
      if (infoRows[i + 1]) {
        doc.font('Helvetica-Bold').fillColor('#444')
          .text(infoRows[i + 1][0] + ':', col3, infoY, { width: 120 });
        doc.font('Helvetica').fillColor('#000')
          .text(infoRows[i + 1][1], col4, infoY, { width: 150 });
      }
      infoY += 14;
    }

    // Masked PAN and bank
    const maskedPAN = sal.pan_number
      ? sal.pan_number.substring(0, 2) + '***' + sal.pan_number.slice(-3)
      : '—';
    const maskedBank = sal.bank_account
      ? `${sal.bank_name || ''} ****${String(sal.bank_account).slice(-4)}`
      : '—';
    doc.font('Helvetica-Bold').fillColor('#444').fontSize(8).text('PAN:', col1, infoY, { width: 120 });
    doc.font('Helvetica').fillColor('#000').text(maskedPAN, col2, infoY, { width: 160 });
    doc.font('Helvetica-Bold').fillColor('#444').text('Bank Account:', col3, infoY, { width: 120 });
    doc.font('Helvetica').fillColor('#000').text(maskedBank, col4, infoY, { width: 150 });

    // ─── Attendance Summary ───────────────────────────────────────────────────
    const attTop = infoTop + 120;
    doc.rect(leftX, attTop, pageWidth, 26).fill('#f0faf9').stroke('#ccc');
    doc.fillColor('#007A64').fontSize(8).font('Helvetica-Bold')
      .text('Working Days', leftX + 10, attTop + 5);
    doc.text('Days Present', leftX + 100, attTop + 5);
    doc.text('Days Absent', leftX + 195, attTop + 5);
    doc.text('Leave Days', leftX + 285, attTop + 5);
    doc.text('Overtime Hours', leftX + 370, attTop + 5);

    const attValY = attTop + 14;
    doc.fillColor('#000').font('Helvetica').fontSize(8)
      .text(String(payslipData.total_working_days), leftX + 30, attValY)
      .text(String(payslipData.days_present), leftX + 120, attValY)
      .text(String(payslipData.days_absent), leftX + 215, attValY)
      .text(String(payslipData.days_leave), leftX + 305, attValY)
      .text(String(parseFloat(payslipData.overtime_hours || 0).toFixed(1)) + ' hrs', leftX + 393, attValY);

    // ─── Earnings & Deductions Table ─────────────────────────────────────────
    const tableTop = attTop + 36;
    const tableH = 210;
    const midX = leftX + (pageWidth / 2);

    doc.rect(leftX, tableTop, pageWidth / 2, tableH).stroke('#ccc');
    doc.rect(midX, tableTop, pageWidth / 2, tableH).stroke('#ccc');

    // Headers
    doc.rect(leftX, tableTop, pageWidth / 2, 16).fill('#007A64');
    doc.rect(midX, tableTop, pageWidth / 2, 16).fill('#c0392b');
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
      .text('EARNINGS', leftX + 5, tableTop + 4)
      .text('AMOUNT (₹)', leftX + 175, tableTop + 4)
      .text('DEDUCTIONS', midX + 5, tableTop + 4)
      .text('AMOUNT (₹)', midX + 170, tableTop + 4);

    const earnings = [
      ['Basic Salary', payslipData.basic_earned],
      ['HRA', payslipData.hra_earned],
      ['DA', payslipData.da_earned],
      ['Special Allowance', payslipData.special_allowance_earned],
      ['Transport Allowance', payslipData.transport_allowance_earned],
      ['Medical Allowance', payslipData.medical_allowance_earned],
      ['Overtime Pay', payslipData.overtime_pay],
      ['Bonus', payslipData.bonus_this_month],
    ].filter(([, v]) => parseFloat(v || 0) > 0);

    const deductions = [
      ['PF (Employee 12%)', payslipData.pf_employee],
      ['ESI (0.75%)', payslipData.esi_employee],
      ['Professional Tax', payslipData.professional_tax],
      ['TDS', payslipData.tds],
    ].filter(([, v]) => parseFloat(v || 0) > 0);

    let rowY = tableTop + 20;
    const maxRows = Math.max(earnings.length, deductions.length);
    for (let i = 0; i < maxRows; i++) {
      if (i % 2 === 1) {
        doc.rect(leftX + 1, rowY - 1, pageWidth / 2 - 2, 13).fill('#fafafa');
        doc.rect(midX + 1, rowY - 1, pageWidth / 2 - 2, 13).fill('#fafafa');
      }
      doc.fillColor('#333').font('Helvetica').fontSize(7.5);
      if (earnings[i]) {
        doc.text(earnings[i][0], leftX + 5, rowY, { width: 160 });
        doc.text('₹' + formatAmount(earnings[i][1]), leftX + 170, rowY, { width: 80, align: 'right' });
      }
      if (deductions[i]) {
        doc.text(deductions[i][0], midX + 5, rowY, { width: 155 });
        doc.text('₹' + formatAmount(deductions[i][1]), midX + 165, rowY, { width: 80, align: 'right' });
      }
      rowY += 13;
    }

    // Totals row
    const totalRowY = tableTop + tableH - 18;
    doc.rect(leftX, totalRowY, pageWidth / 2, 18).fill('#e8f5e9');
    doc.rect(midX, totalRowY, pageWidth / 2, 18).fill('#fdecea');
    doc.fillColor('#1b5e20').font('Helvetica-Bold').fontSize(8.5)
      .text('Gross Salary', leftX + 5, totalRowY + 4)
      .text('₹' + formatAmount(payslipData.gross_salary), leftX + 170, totalRowY + 4, { width: 80, align: 'right' });
    doc.fillColor('#b71c1c')
      .text('Total Deductions', midX + 5, totalRowY + 4)
      .text('₹' + formatAmount(payslipData.total_deductions), midX + 165, totalRowY + 4, { width: 80, align: 'right' });

    // ─── Net Pay Box ─────────────────────────────────────────────────────────
    const netTop = tableTop + tableH + 10;
    doc.rect(leftX, netTop, pageWidth, 38).fill('#007A64');
    doc.fillColor('white').font('Helvetica-Bold').fontSize(13)
      .text('NET PAY:', leftX + 15, netTop + 12)
      .text('₹' + formatAmount(payslipData.net_salary), leftX + 100, netTop + 12);

    // Amount in words
    const wordsY = netTop + 48;
    doc.fillColor('#333').font('Helvetica').fontSize(8)
      .text(`Net Pay in Words: ${numberToWords(Math.round(payslipData.net_salary))} Rupees Only`, leftX, wordsY);

    // ─── Footer ───────────────────────────────────────────────────────────────
    const footerY = wordsY + 30;
    doc.moveTo(leftX, footerY).lineTo(leftX + pageWidth, footerY).lineWidth(0.5).stroke('#aaa');
    doc.fillColor('#888').fontSize(7).font('Helvetica')
      .text('This is a computer-generated payslip and does not require a signature.', leftX, footerY + 6, { align: 'center', width: pageWidth })
      .text(`Generated on: ${new Date().toLocaleDateString('en-IN')} | ${getMonthName(payslipData.month)} ${payslipData.year} | Venkataeswara Hospitals`, leftX, footerY + 16, { align: 'center', width: pageWidth });

    doc.end();
  });
}
