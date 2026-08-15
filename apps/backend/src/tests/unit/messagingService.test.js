import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn()
};

const notificationQueueMock = jest.fn();
const emitStaffMessageMock = jest.fn();
const uploadFileToR2Mock = jest.fn();
const getFileFromR2Mock = jest.fn();
const scanBufferVerdictMock = jest.fn();
const loggerMock = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  // Delegate to the per-test $transaction mock (each test wires it to its own
  // tx object and asserts on that tx), so setTenantTx-converted code paths use
  // the same tx the test instrumented rather than the generic default mock.
  setTenantTx: async (_tenantId, fn) => prismaMock.$transaction(fn),
  setTenant: async (_tenantId, fn) => prismaMock.$transaction(fn),
  runTenantScopedTransaction: async (_client, _guc, fn) => prismaMock.$transaction(fn),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: loggerMock
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: {
    queue: notificationQueueMock
  },
  notificationOutbox: {
    queue: notificationQueueMock
  }
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitStaffMessage: emitStaffMessageMock
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: uploadFileToR2Mock,
  getFileFromR2: getFileFromR2Mock
}));

// Mocked at the transport layer so these tests exercise the real
// FILE_SCAN_POLICY decision (src/config/fileScanPolicy.js).
jest.unstable_mockModule('../../utils/virusScanner.js', () => ({
  SCAN_OUTCOME: { CLEAN: 'clean', INFECTED: 'infected', UNAVAILABLE: 'unavailable', ERROR: 'error' },
  scanBufferVerdict: scanBufferVerdictMock,
  default: { scanBufferVerdict: scanBufferVerdictMock }
}));

const messagingService = (await import('../../services/messaging/messagingService.js')).default;
const { FILE_SCAN_POLICY } = await import('../../config/fileScanPolicy.js');

const tenantId = '00000000-0000-4000-8000-000000000001';
const senderUid = '11111111-1111-4111-8111-111111111111';
const recipientOne = '22222222-2222-4222-8222-222222222222';
const recipientTwo = '33333333-3333-4333-8333-333333333333';
const threadOne = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const threadTwo = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let previousScanPolicy;

beforeEach(() => {
  previousScanPolicy = process.env.FILE_SCAN_POLICY;
  // Default these suites to the strict posture; the no-scanner cases opt in.
  process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
});

afterEach(() => {
  if (previousScanPolicy === undefined) delete process.env.FILE_SCAN_POLICY;
  else process.env.FILE_SCAN_POLICY = previousScanPolicy;
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
  prismaMock.$transaction.mockReset();
  notificationQueueMock.mockReset();
  emitStaffMessageMock.mockReset();
  uploadFileToR2Mock.mockReset();
  getFileFromR2Mock.mockReset();
  scanBufferVerdictMock.mockReset();
  Object.values(loggerMock).forEach(fn => fn.mockReset());
});

describe('messagingService', () => {
  it('persists a direct staff message with tenant and queues a notification', async () => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: threadOne,
            priority: 'urgent',
            subject: 'Bed update',
            patient_uid: null,
            admission_id: null
          }
        ])
        .mockResolvedValueOnce([
          {
            id: 7,
            thread_id: threadOne,
            sender_uid: senderUid,
            recipient_uid: recipientOne,
            patient_uid: null,
            subject: 'Bed update',
            body: 'Patient shifted to B block.',
            priority: 'urgent',
            is_read: false,
            read_at: null,
            created_at: new Date('2026-06-03T08:00:00Z'),
            tenant_id: tenantId
          }
        ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    };
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ muted_until: null, urgent_only: false }])
      .mockResolvedValueOnce([{ id: 42 }]);
    notificationQueueMock.mockResolvedValueOnce({ id: 99 });

    const message = await messagingService.sendMessage(
      senderUid,
      recipientOne,
      'Patient shifted to B block.',
      'urgent',
      null,
      'Bed update',
      tenantId
    );

    expect(message).toEqual(
      expect.objectContaining({
        id: 7,
        thread_id: threadOne,
        tenant_id: tenantId,
        priority: 'urgent'
      })
    );
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(notificationQueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 42,
        title: 'New staff message',
        data: expect.objectContaining({
          type: 'staff_message',
          message_id: 7,
          thread_id: threadOne,
          sender_uid: senderUid,
          priority: 'urgent'
        })
      })
    );
    expect(emitStaffMessageMock).toHaveBeenCalledTimes(1);
    expect(emitStaffMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUid: recipientOne,
        senderUid,
        priority: 'urgent',
        subject: 'Bed update',
        message: expect.objectContaining({ id: 7, thread_id: threadOne })
      })
    );
  });

  it('returns the committed message when notification enqueue fails after commit', async () => {
    const saved = {
      id: 70,
      thread_id: threadOne,
      sender_uid: senderUid,
      recipient_uid: recipientOne,
      patient_uid: null,
      subject: 'Bed update',
      body: 'Patient shifted to B block.',
      priority: 'urgent',
      is_read: false,
      read_at: null,
      created_at: new Date('2026-06-03T08:00:00Z'),
      tenant_id: tenantId
    };
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: threadOne,
          priority: 'urgent',
          subject: 'Bed update',
          patient_uid: null,
          admission_id: null
        }])
        .mockResolvedValueOnce([saved]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    };
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ muted_until: null, urgent_only: false }])
      .mockResolvedValueOnce([{ id: 42 }]);
    notificationQueueMock.mockRejectedValueOnce(new Error('notification database unavailable'));

    await expect(messagingService.sendMessage(
      senderUid,
      recipientOne,
      saved.body,
      'urgent',
      null,
      saved.subject,
      tenantId
    )).resolves.toEqual(saved);

    expect(emitStaffMessageMock).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Staff message notification failed after commit',
      expect.objectContaining({ messageId: saved.id, tenantId })
    );
  });

  it('suppresses muted thread notifications without dropping the saved message', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([
        {
          id: threadOne,
          priority: 'normal',
          subject: null,
          patient_uid: null,
          admission_id: null
        }
      ]).mockResolvedValueOnce([
        {
          id: 8,
          thread_id: threadOne,
          sender_uid: senderUid,
          recipient_uid: recipientOne,
          patient_uid: null,
          subject: null,
          body: 'Quiet update',
          priority: 'normal',
          is_read: false,
          read_at: null,
          created_at: new Date('2026-06-03T08:00:00Z'),
          tenant_id: tenantId
        }
      ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    };
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      {
        muted_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        urgent_only: false
      }
    ]);

    const message = await messagingService.sendMessage(
      senderUid,
      recipientOne,
      'Quiet update',
      'normal',
      null,
      null,
      tenantId
    );

    expect(message).toEqual(
      expect.objectContaining({
        id: 8,
        thread_id: threadOne
      })
    );
    expect(notificationQueueMock).not.toHaveBeenCalled();
    expect(emitStaffMessageMock).not.toHaveBeenCalled();
  });

  it('sends a scanned attachment as a linked thread message', async () => {
    const threadRow = {
      id: threadOne,
      thread_type: 'direct',
      subject: null,
      patient_uid: null,
      admission_id: null,
      priority: 'normal',
      status: 'active',
      tenant_id: tenantId
    };
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([threadRow])
        .mockResolvedValueOnce([
          {
            id: 21,
            thread_id: threadOne,
            sender_uid: senderUid,
            recipient_uid: recipientOne,
            patient_uid: null,
            subject: null,
            body: 'Please review attached handover.',
            priority: 'normal',
            is_read: false,
            read_at: null,
            created_at: new Date('2026-06-03T09:00:00Z'),
            tenant_id: tenantId
          }
        ])
        .mockResolvedValueOnce([
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            thread_id: threadOne,
            message_id: 21,
            uploaded_by_uid: senderUid,
            file_name: 'handover.pdf',
            content_type: 'application/pdf',
            file_size: 20,
            storage_key: `staff-messages/${tenantId}/${threadOne}/handover.pdf`,
            scan_status: 'clean',
            metadata: { scanner: 'clamav' },
            created_at: new Date('2026-06-03T09:00:00Z'),
            updated_at: new Date('2026-06-03T09:00:00Z')
          }
        ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    };
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([threadRow])
      .mockResolvedValueOnce([threadRow])
      .mockResolvedValueOnce([{ muted_until: null, urgent_only: false }])
      .mockResolvedValueOnce([{ id: 42 }]);
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));
    scanBufferVerdictMock.mockResolvedValueOnce({ outcome: 'clean', signature: null, detail: null });
    uploadFileToR2Mock.mockResolvedValueOnce('local://staff-messages/thread/handover.pdf');
    notificationQueueMock.mockResolvedValueOnce({ id: 99 });

    const result = await messagingService.sendThreadAttachment({
      senderUid,
      recipientUid: recipientOne,
      threadId: threadOne,
      tenantId,
      body: 'Please review attached handover.',
      file: {
        originalname: 'handover.pdf',
        mimetype: 'application/pdf',
        size: 20,
        buffer: Buffer.from('%PDF-1.4 attachment')
      }
    });

    expect(scanBufferVerdictMock).toHaveBeenCalledWith(Buffer.from('%PDF-1.4 attachment'));
    expect(uploadFileToR2Mock).toHaveBeenCalledWith(
      Buffer.from('%PDF-1.4 attachment'),
      expect.stringContaining(`staff-messages/${tenantId}/${threadOne}/`),
      'application/pdf'
    );
    expect(result.message).toEqual(
      expect.objectContaining({
        id: 21,
        thread_id: threadOne,
        attachments: [
          expect.objectContaining({
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            file_name: 'handover.pdf',
            scan_status: 'clean'
          })
        ]
      })
    );
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(notificationQueueMock).toHaveBeenCalledTimes(1);
    expect(emitStaffMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUid: recipientOne,
        message: expect.objectContaining({ id: 21, thread_id: threadOne })
      })
    );
  });

  describe('attachment scan gate', () => {
    const attachmentRow = (scanStatus) => ({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      thread_id: threadOne,
      message_id: 21,
      uploaded_by_uid: senderUid,
      file_name: 'handover.pdf',
      content_type: 'application/pdf',
      file_size: 20,
      storage_key: `staff-messages/${tenantId}/${threadOne}/handover.pdf`,
      scan_status: scanStatus,
      metadata: {},
      created_at: new Date('2026-06-03T09:00:00Z'),
      updated_at: new Date('2026-06-03T09:00:00Z')
    });

    // assertThreadAccess runs one lookup after the attachment row is fetched.
    const threadAccessRow = {
      id: threadOne,
      thread_type: 'direct',
      subject: null,
      patient_uid: null,
      admission_id: null,
      priority: 'normal',
      status: 'active',
      tenant_id: tenantId
    };

    async function download(scanStatus) {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([attachmentRow(scanStatus)])
        .mockResolvedValueOnce([threadAccessRow]);
      getFileFromR2Mock.mockResolvedValueOnce(Buffer.from('bytes'));
      return messagingService
        .getAttachmentDownload(senderUid, attachmentRow(scanStatus).id, tenantId)
        .catch(err => err);
    }

    it('THE FAIL-OPEN BUG: never serves a `failed` attachment, under either policy', async () => {
      // With no clamd deployed every attachment landed as 'failed', and the old
      // gate tested only `=== 'quarantined'`, so unscanned bytes were served by
      // a path whose code read as though scanning protected it.
      for (const policy of [FILE_SCAN_POLICY.REQUIRED, FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK]) {
        process.env.FILE_SCAN_POLICY = policy;
        prismaMock.$queryRawUnsafe.mockReset();
        getFileFromR2Mock.mockReset();

        const result = await download('failed');

        expect(result).toBeInstanceOf(Error);
        expect(result.statusCode).toBe(423);
        expect(result.code).toBe('ATTACHMENT_SCAN_NOT_CLEAN');
        expect(getFileFromR2Mock).not.toHaveBeenCalled();
      }
    });

    it('never serves a `pending` attachment, under either policy', async () => {
      for (const policy of [FILE_SCAN_POLICY.REQUIRED, FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK]) {
        process.env.FILE_SCAN_POLICY = policy;
        prismaMock.$queryRawUnsafe.mockReset();
        getFileFromR2Mock.mockReset();

        const result = await download('pending');

        expect(result.statusCode).toBe(423);
        expect(getFileFromR2Mock).not.toHaveBeenCalled();
      }
    });

    it('never serves a quarantined attachment, under either policy', async () => {
      for (const policy of [FILE_SCAN_POLICY.REQUIRED, FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK]) {
        process.env.FILE_SCAN_POLICY = policy;
        prismaMock.$queryRawUnsafe.mockReset();
        getFileFromR2Mock.mockReset();

        const result = await download('quarantined');

        expect(result.statusCode).toBe(409);
        expect(result.code).toBe('ATTACHMENT_QUARANTINED');
        expect(getFileFromR2Mock).not.toHaveBeenCalled();
      }
    });

    it('serves a clean attachment, under either policy', async () => {
      for (const policy of [FILE_SCAN_POLICY.REQUIRED, FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK]) {
        process.env.FILE_SCAN_POLICY = policy;
        prismaMock.$queryRawUnsafe.mockReset();
        getFileFromR2Mock.mockReset();

        const result = await download('clean');

        expect(result.bytes).toEqual(Buffer.from('bytes'));
        expect(result.attachment).toEqual(
          expect.objectContaining({ scan_status: 'clean', download_available: true })
        );
      }
    });

    it('serves a not_scanned attachment only where the deployment declared no scanner', async () => {
      process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
      const served = await download('not_scanned');
      expect(served.bytes).toEqual(Buffer.from('bytes'));

      prismaMock.$queryRawUnsafe.mockReset();
      getFileFromR2Mock.mockReset();
      process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
      const blocked = await download('not_scanned');
      expect(blocked.statusCode).toBe(423);
      expect(getFileFromR2Mock).not.toHaveBeenCalled();
    });
  });

  it('refuses to store an attachment when scanning is required and the scanner is unreachable', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    const threadRow = {
      id: threadOne,
      thread_type: 'direct',
      subject: null,
      patient_uid: null,
      admission_id: null,
      priority: 'normal',
      status: 'active',
      tenant_id: tenantId
    };
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([threadRow])
      .mockResolvedValueOnce([threadRow]);
    scanBufferVerdictMock.mockResolvedValueOnce({
      outcome: 'unavailable',
      signature: null,
      detail: 'no clamd daemon answered at 127.0.0.1:3310'
    });

    const err = await messagingService
      .sendThreadAttachment({
        senderUid,
        recipientUid: recipientOne,
        threadId: threadOne,
        tenantId,
        body: 'handover',
        file: {
          originalname: 'handover.pdf',
          mimetype: 'application/pdf',
          size: 20,
          buffer: Buffer.from('%PDF-1.4 attachment')
        }
      })
      .catch(e => e);

    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('FILE_SCAN_UNAVAILABLE');
    // Nothing was stored: no R2 object, no ledger row.
    expect(uploadFileToR2Mock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('stores an attachment as not_scanned where the deployment declared no scanner', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    const threadRow = {
      id: threadOne,
      thread_type: 'direct',
      subject: null,
      patient_uid: null,
      admission_id: null,
      priority: 'normal',
      status: 'active',
      tenant_id: tenantId
    };
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([threadRow])
        .mockResolvedValueOnce([
          {
            id: 21,
            thread_id: threadOne,
            sender_uid: senderUid,
            recipient_uid: recipientOne,
            patient_uid: null,
            subject: null,
            body: 'handover',
            priority: 'normal',
            is_read: false,
            read_at: null,
            created_at: new Date('2026-06-03T09:00:00Z'),
            tenant_id: tenantId
          }
        ])
        .mockResolvedValueOnce([
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            thread_id: threadOne,
            message_id: 21,
            uploaded_by_uid: senderUid,
            file_name: 'handover.pdf',
            content_type: 'application/pdf',
            file_size: 20,
            storage_key: `staff-messages/${tenantId}/${threadOne}/handover.pdf`,
            scan_status: 'not_scanned',
            metadata: { scanner: 'none' },
            created_at: new Date('2026-06-03T09:00:00Z'),
            updated_at: new Date('2026-06-03T09:00:00Z')
          }
        ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    };
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([threadRow])
      .mockResolvedValueOnce([threadRow])
      .mockResolvedValueOnce([{ muted_until: null, urgent_only: false }])
      .mockResolvedValueOnce([{ id: 42 }]);
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));
    uploadFileToR2Mock.mockResolvedValueOnce('local://staff-messages/thread/handover.pdf');
    notificationQueueMock.mockResolvedValueOnce({ id: 99 });

    const result = await messagingService.sendThreadAttachment({
      senderUid,
      recipientUid: recipientOne,
      threadId: threadOne,
      tenantId,
      body: 'handover',
      file: {
        originalname: 'handover.pdf',
        mimetype: 'application/pdf',
        size: 20,
        buffer: Buffer.from('%PDF-1.4 attachment')
      }
    });

    // No probe was made, and the persisted status says so honestly.
    expect(scanBufferVerdictMock).not.toHaveBeenCalled();
    // query() spreads its params, so args[0] is the SQL and the rest are binds.
    expect(tx.$queryRawUnsafe.mock.calls[2].slice(1)).toContain('not_scanned');
    expect(result.attachment).toEqual(
      expect.objectContaining({ scan_status: 'not_scanned', download_available: true })
    );
  });

  it('allows HR/Admin all-staff broadcast and creates one saved row per recipient', async () => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([
          {
            uid: senderUid,
            name: 'HR User',
            role: 'HR_STAFF',
            tenant_id: tenantId,
            department: 'HR'
          }
        ])
        .mockResolvedValueOnce([{ uid: recipientOne }, { uid: recipientTwo }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: threadOne,
            priority: 'normal',
            subject: 'Policy',
            patient_uid: null,
            admission_id: null
          }
        ])
        .mockResolvedValueOnce([
          {
            id: 11,
            thread_id: threadOne,
            sender_uid: senderUid,
            recipient_uid: recipientOne,
            patient_uid: null,
            subject: 'Policy',
            body: 'New shift policy is live.',
            priority: 'normal',
            is_read: false,
            read_at: null,
            created_at: new Date('2026-06-03T08:00:00Z'),
            tenant_id: tenantId
          }
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: threadTwo,
            priority: 'normal',
            subject: 'Policy',
            patient_uid: null,
            admission_id: null
          }
        ])
        .mockResolvedValueOnce([
          {
            id: 12,
            thread_id: threadTwo,
            sender_uid: senderUid,
            recipient_uid: recipientTwo,
            patient_uid: null,
            subject: 'Policy',
            body: 'New shift policy is live.',
            priority: 'normal',
            is_read: false,
            read_at: null,
            created_at: new Date('2026-06-03T08:00:01Z'),
            tenant_id: tenantId
          }
        ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    };
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ muted_until: null, urgent_only: false }])
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([{ muted_until: null, urgent_only: false }])
      .mockResolvedValueOnce([{ id: 43 }]);
    notificationQueueMock.mockResolvedValue({ id: 99 });

    const result = await messagingService.sendBroadcast({
      senderUid,
      tenantId,
      actorRole: 'HR_STAFF',
      scope: 'all',
      body: 'New shift policy is live.',
      subject: 'Policy'
    });

    expect(result.count).toBe(2);
    expect(result.messages.map(msg => msg.recipient_uid)).toEqual([recipientOne, recipientTwo]);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(8);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(4);
    expect(notificationQueueMock).toHaveBeenCalledTimes(2);
    expect(emitStaffMessageMock).toHaveBeenCalledTimes(2);
    expect(emitStaffMessageMock.mock.calls.map(call => call[0].recipientUid)).toEqual([
      recipientOne,
      recipientTwo
    ]);
  });

  it('blocks department incharges from messaging a different department', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([
        {
          uid: senderUid,
          name: 'Nursing Incharge',
          role: 'NURSING_INCHARGE',
          tenant_id: tenantId,
          department: 'Nursing'
        }
      ]),
      $executeRawUnsafe: jest.fn()
    };
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));

    await expect(
      messagingService.sendBroadcast({
        senderUid,
        tenantId,
        actorRole: 'NURSING_INCHARGE',
        scope: 'department',
        department: 'Billing',
        body: 'Please review this update.'
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Department incharges can only message their own department'
    });

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(notificationQueueMock).not.toHaveBeenCalled();
    expect(emitStaffMessageMock).not.toHaveBeenCalled();
  });
});
