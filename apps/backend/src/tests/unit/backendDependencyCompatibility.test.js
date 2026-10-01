import { jest } from '@jest/globals';
import { once } from 'node:events';
import { createServer } from 'node:net';
import nodemailer from 'nodemailer';

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const ORIGINAL_ENV = { ...process.env };
const attachment = Buffer.from('synthetic-report-bytes');
const message = {
  from: 'sender@example.test',
  to: 'recipient@example.test',
  cc: 'copy@example.test',
  subject: 'Synthetic report',
  text: 'Plain report body',
  html: '<p>HTML report body</p>',
  attachments: [{ filename: 'report.pdf', content: attachment, contentType: 'application/pdf' }],
};

async function smtpFixture({ acknowledge = true, rejectRecipient = false } = {}) {
  const sockets = new Set();
  const commands = [];
  const messages = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy());
    socket.setEncoding('utf8');
    let buffered = '';
    let receivingData = false;
    socket.write('220 localhost synthetic SMTP\r\n');
    socket.on('data', (chunk) => {
      buffered += chunk;
      while (buffered.includes('\r\n')) {
        if (receivingData) {
          const end = buffered.indexOf('\r\n.\r\n');
          if (end === -1) {
            return;
          }
          messages.push(buffered.slice(0, end));
          buffered = buffered.slice(end + 5);
          receivingData = false;
          if (!acknowledge) {
            socket.destroy();
            return;
          }
          socket.write('250 2.0.0 synthetic-message-accepted\r\n');
          continue;
        }
        const end = buffered.indexOf('\r\n');
        const command = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        commands.push(command);
        if (command.startsWith('EHLO ')) {
          socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        } else if (command.startsWith('AUTH PLAIN ')) {
          socket.write('235 2.7.0 authenticated\r\n');
        } else if (command.startsWith('RCPT TO:') && rejectRecipient) {
          socket.write('550 5.1.1 synthetic recipient rejected\r\n');
        } else if (command.startsWith('MAIL FROM:') || command.startsWith('RCPT TO:')) {
          socket.write('250 2.1.0 accepted\r\n');
        } else if (command === 'DATA') {
          receivingData = true;
          socket.write('354 end with a single dot\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 goodbye\r\n');
        } else {
          socket.end('500 unexpected command\r\n');
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    commands,
    messages,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

async function configuredSendEmail(port) {
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_USER = 'sender@example.test';
  process.env.SMTP_PASS = 'synthetic-password';
  process.env.SMTP_FROM = message.from;
  jest.resetModules();
  return (await import('../../utils/notifications/sendEmailNotification.js')).sendEmail;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('backend dependency compatibility with real packages', () => {
  it('composes multipart mail with the ESM default import and Buffer attachments', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    try {
      const info = await transport.sendMail(message);
      expect(info.envelope).toEqual({
        from: message.from,
        to: [message.to, message.cc],
      });
      expect(info.messageId).toMatch(/^<[^<>]+@example\.test>$/);
      expect(Buffer.isBuffer(info.message)).toBe(true);
      const mime = info.message.toString('utf8');
      expect(mime).toContain(`Message-ID: ${info.messageId}`);
      expect(mime).toContain(`To: ${message.to}`);
      expect(mime).toContain(`Cc: ${message.cc}`);
      expect(mime).toContain('Content-Type: multipart/mixed;');
      expect(mime).toContain('Content-Type: multipart/alternative;');
      expect(mime).toContain(message.text);
      expect(mime).toContain(message.html);
      expect(mime).toContain('Content-Type: application/pdf; name=report.pdf');
      expect(mime).toContain('Content-Disposition: attachment; filename=report.pdf');
      expect(mime).toContain(attachment.toString('base64'));
    } finally {
      transport.close();
    }
  });

  it('preserves SMTP authentication, recipients and acknowledgement through sendEmail', async () => {
    const smtp = await smtpFixture();
    try {
      const sendEmail = await configuredSendEmail(smtp.port);
      const info = await sendEmail({ ...message, receiptMode: true });
      expect(info.accepted).toEqual([message.to, message.cc]);
      expect(info.rejected).toEqual([]);
      expect(info.envelope).toEqual({ from: message.from, to: [message.to, message.cc] });
      expect(info.response).toBe('250 2.0.0 synthetic-message-accepted');
      const auth = smtp.commands.find((command) => command.startsWith('AUTH PLAIN '));
      expect(Buffer.from(auth.slice('AUTH PLAIN '.length), 'base64').toString()).toBe(
        '\0sender@example.test\0synthetic-password',
      );
      expect(smtp.commands).toContain(`MAIL FROM:<${message.from}>`);
      expect(smtp.commands).toContain(`RCPT TO:<${message.to}>`);
      expect(smtp.commands).toContain(`RCPT TO:<${message.cc}>`);
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]).toContain(`Message-ID: ${info.messageId}`);
      expect(smtp.messages[0]).toContain(attachment.toString('base64'));
    } finally {
      await smtp.close();
    }
  });

  it.each([
    ['"user"@example.com(x)evil.com', 'user@example.com'],
    ['"a"@b.com(c)d.com(e)f.com', 'a@b.com'],
  ])('keeps comment-separated trailing atoms out of the envelope for %s', async (to, expected) => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    try {
      const info = await transport.sendMail({ from: message.from, to, subject: 'Synthetic', text: 'body' });
      expect(info.envelope.to).toEqual([expected]);
    } finally {
      transport.close();
    }
  });

  it('keeps a disconnect after DATA uncertain in receiptMode', async () => {
    const smtp = await smtpFixture({ acknowledge: false });
    try {
      const sendEmail = await configuredSendEmail(smtp.port);
      await expect(sendEmail({ ...message, receiptMode: true })).rejects.toMatchObject({
        message: 'SMTP delivery outcome is uncertain',
        code: 'ECONNECTION',
        cause: { code: 'ECONNECTION' },
      });
      expect(smtp.messages).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });

  it('retains the default null result after an unacknowledged SMTP send', async () => {
    const smtp = await smtpFixture({ acknowledge: false });
    try {
      const sendEmail = await configuredSendEmail(smtp.port);
      await expect(sendEmail(message)).resolves.toBeNull();
      expect(smtp.messages).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });

  it('preserves receiptMode error semantics when SMTP refuses every recipient', async () => {
    const smtp = await smtpFixture({ rejectRecipient: true });
    try {
      const sendEmail = await configuredSendEmail(smtp.port);
      await expect(sendEmail({ ...message, receiptMode: true })).rejects.toMatchObject({
        message: 'SMTP delivery outcome is uncertain',
        code: 'EENVELOPE',
        cause: { code: 'EENVELOPE', responseCode: 550 },
      });
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('round-trips an in-memory ExcelJS export with values, styles and a filter', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Synthetic export');
    worksheet.columns = [
      { header: 'Record ID', key: 'id', width: 10 },
      { header: 'Title', key: 'title', width: 30 },
      { header: 'Count', key: 'count', width: 10 },
    ];
    worksheet.getRow(1).font = { bold: true };
    worksheet.addRow({ id: 'synthetic-1', title: 'Report {a,b}', count: 7 });
    worksheet.autoFilter = { from: 'A1', to: 'C2' };

    const data = await workbook.xlsx.writeBuffer();
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(data);
    const result = restored.getWorksheet('Synthetic export');
    expect(restored.worksheets).toHaveLength(1);
    expect(result.rowCount).toBe(2);
    expect(result.getRow(1).values.slice(1)).toEqual(['Record ID', 'Title', 'Count']);
    expect(result.getRow(2).values.slice(1)).toEqual(['synthetic-1', 'Report {a,b}', 7]);
    expect(result.getCell('A1').font.bold).toBe(true);
    expect(result.autoFilter).toBe('A1:C2');
  });
});
