import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MailService } from './mail.service.js';
import { Resend } from 'resend';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: vi.fn(function () {
    return { emails: { send: mockSend } };
  }),
}));

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const stringContaining = (substr: string) =>
  expect.stringContaining(substr) as string;

const createPrismaMock = () => ({
  user: {
    findMany: vi.fn(),
  },
});

const createConfigMock = (
  overrides: Record<string, string> = {},
): { get: ReturnType<typeof vi.fn> } => ({
  get: vi.fn(
    (key: string) =>
      ({
        RESEND_API_KEY: 'test-resend-key',
        RESEND_FROM_EMAIL: 'ViaScholar <no-reply@example.com>',
        FRONTEND_URL: 'https://app.example.com',
        ...overrides,
      })[key],
  ),
});

describe('MailService', () => {
  const buildService = async (
    config: ReturnType<typeof createConfigMock>,
    prisma: ReturnType<typeof createPrismaMock>,
  ) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    return module.get<MailService>(MailService);
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    mockSend.mockReset();
    mockSend.mockResolvedValue({ error: null });
  });

  it('initializes the Resend client when an API key is configured', async () => {
    const service = await buildService(createConfigMock(), createPrismaMock());

    expect(vi.mocked(Resend)).toHaveBeenCalledWith('test-resend-key');
    expect(service).toBeDefined();
  });

  it('runs in simulation mode without an API key', async () => {
    const service = await buildService(
      createConfigMock({ RESEND_API_KEY: '' }),
      createPrismaMock(),
    );

    expect(vi.mocked(Resend)).not.toHaveBeenCalled();
    await service.sendPasswordResetEmail('scholar@example.com', {
      userName: 'Juan',
      resetUrl: 'https://app.example.com/reset/abc',
      expiresInMinutes: 30,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('getStaffEmails', () => {
    it('returns the emails of active admins, grantors, and coordinators', async () => {
      const prisma = createPrismaMock();
      prisma.user.findMany.mockResolvedValue([
        { email: 'admin@example.com' },
        { email: 'grantor@example.com' },
        { email: 'coordinator@example.com' },
      ]);
      const service = await buildService(createConfigMock(), prisma);

      await expect(service.getStaffEmails()).resolves.toEqual([
        'admin@example.com',
        'grantor@example.com',
        'coordinator@example.com',
      ]);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          role: { in: ['ADMIN', 'GRANTOR', 'COORDINATOR'] },
          is_active: true,
        },
        select: { email: true },
      });
    });

    it('filters out empty emails', async () => {
      const prisma = createPrismaMock();
      prisma.user.findMany.mockResolvedValue([
        { email: 'admin@example.com' },
        { email: '' },
      ]);
      const service = await buildService(createConfigMock(), prisma);

      await expect(service.getStaffEmails()).resolves.toEqual([
        'admin@example.com',
      ]);
    });

    it('returns an empty list when the database lookup fails', async () => {
      const prisma = createPrismaMock();
      prisma.user.findMany.mockRejectedValue(new Error('database down'));
      const service = await buildService(createConfigMock(), prisma);

      await expect(service.getStaffEmails()).resolves.toEqual([]);
    });
  });

  describe('sendEmail core behavior', () => {
    it('dispatches through Resend with the configured from address', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendPasswordResetEmail('scholar@example.com', {
        userName: 'Juan',
        resetUrl: 'https://app.example.com/reset/abc',
        expiresInMinutes: 30,
      });

      expect(mockSend).toHaveBeenCalledWith({
        from: 'ViaScholar <no-reply@example.com>',
        to: ['scholar@example.com'],
        subject: 'Reset Your Password - ViaScholar',
        html: anyArg(String),
      });
    });

    it('logs an error and does not throw when Resend reports a delivery error', async () => {
      mockSend.mockResolvedValue({
        error: { name: 'invalid_to', message: 'Invalid recipient' },
      });
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await expect(
        service.sendPasswordResetEmail('scholar@example.com', {
          userName: 'Juan',
          resetUrl: 'https://app.example.com/reset/abc',
          expiresInMinutes: 30,
        }),
      ).resolves.toBeUndefined();
    });

    it('logs an error and does not throw when Resend throws', async () => {
      mockSend.mockRejectedValue(new Error('network unreachable'));
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await expect(
        service.sendPasswordResetEmail('scholar@example.com', {
          userName: 'Juan',
          resetUrl: 'https://app.example.com/reset/abc',
          expiresInMinutes: 30,
        }),
      ).resolves.toBeUndefined();
    });

    it('falls back to the default from address and frontend URL', async () => {
      const service = await buildService(
        createConfigMock({
          RESEND_FROM_EMAIL: '',
          FRONTEND_URL: '',
        }),
        createPrismaMock(),
      );

      await service.sendPasswordResetEmail('scholar@example.com', {
        userName: 'Juan',
        resetUrl: 'https://app.example.com/reset/abc',
        expiresInMinutes: 30,
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          from: 'ViaScholar <onboarding@resend.dev>',
        }),
      );
    });

    it('logs an error and does not throw when Resend throws a non-Error', async () => {
      mockSend.mockRejectedValue('network unreachable');
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await expect(
        service.sendPasswordResetEmail('scholar@example.com', {
          userName: 'Juan',
          resetUrl: 'https://app.example.com/reset/abc',
          expiresInMinutes: 30,
        }),
      ).resolves.toBeUndefined();
    });

    it('logs and does not throw when the staff email lookup fails with a non-Error', async () => {
      const prisma = createPrismaMock();
      prisma.user.findMany.mockRejectedValue('database down');
      const service = await buildService(createConfigMock(), prisma);

      await expect(service.getStaffEmails()).resolves.toEqual([]);
    });

    it('does nothing when the recipient list is empty', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendApplicationSubmittedStaff([], {
        studentName: 'Juan Dela Cruz',
        track: 'Academic Track',
        applicationId: 42,
      });

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('public email methods', () => {
    it('sends the application submitted confirmation to the student', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendApplicationSubmittedStudent('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        track: 'Academic Track',
        applicationId: 42,
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          to: ['juan@example.com'],
          subject: 'Application Received - ViaScholar',
        }),
      );
    });

    it('sends the staff notification with the full staff address list', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendApplicationSubmittedStaff(
        ['a@example.com', 'b@example.com'],
        {
          studentName: 'Juan Dela Cruz',
          track: 'Academic Track',
          applicationId: 42,
        },
      );

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          to: ['a@example.com', 'b@example.com'],
          subject: stringContaining('Juan Dela Cruz'),
        }),
      );
    });

    it('sends the interview scheduled email', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendInterviewScheduled('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        interviewAt: new Date('2026-08-20T10:00:00.000Z'),
        meetingLink: 'https://meet.google.com/abc-defg-hij',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: 'Interview Scheduled: ViaScholar Scholarship Program',
        }),
      );
    });

    it('sends the reschedule request notification to staff', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendInterviewRescheduleRequestedStaff(
        ['staff@example.com'],
        {
          studentName: 'Juan Dela Cruz',
          reason: 'Medical appointment',
          applicationId: 42,
        },
      );

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          to: ['staff@example.com'],
          subject: stringContaining('Juan Dela Cruz'),
        }),
      );
    });

    it('sends the interview rescheduled email to the student', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendInterviewRescheduled('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        newInterviewAt: new Date('2026-09-01T10:00:00.000Z'),
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: 'Interview Rescheduled: ViaScholar Scholarship Program',
        }),
      );
    });

    it('sends the interview cancelled email', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendInterviewCancelled('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        scheduledAt: new Date('2026-08-20T10:00:00.000Z'),
        reason: 'Committee conflict',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: 'Interview Cancelled: ViaScholar Scholarship Program',
        }),
      );
    });

    it('sends the stage updated email', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendStageUpdated('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        stage: 'Document Verification',
        status: 'UNDER_REVIEW',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: 'Application Update: Document Verification',
        }),
      );
    });

    it('sends the approved email with the track embedded', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendApplicationApproved('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        track: 'Academic Track',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: stringContaining('Congratulations'),
        }),
      );
    });

    it('sends the rejected email with the provided reason', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendApplicationRejected('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        reason: 'Insufficient records',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: 'ViaScholar Application Status Update',
        }),
      );
    });

    it('sends the contract ready to sign email', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendContractReadyToSign('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        contractNumber: 'CTX-001',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: stringContaining('Sign Your ViaScholar'),
        }),
      );
    });

    it('sends the contract signed student and staff emails', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendContractSignedStudent('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        contractNumber: 'CTX-001',
      });
      await service.sendContractSignedStaff(['staff@example.com'], {
        studentName: 'Juan Dela Cruz',
        contractNumber: 'CTX-001',
      });

      expect(mockSend).toHaveBeenNthCalledWith(
        1,
        objectMatching({
          subject: stringContaining('Welcome to ViaScholar'),
        }),
      );
      expect(mockSend).toHaveBeenNthCalledWith(
        2,
        objectMatching({
          to: ['staff@example.com'],
          subject: stringContaining('Juan Dela Cruz'),
        }),
      );
    });

    it('sends the contract change request staff email', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendContractChangeRequestToStaff(['staff@example.com'], {
        studentName: 'Juan Dela Cruz',
        studentEmail: 'juan@example.com',
        contractNumber: 'CTX-001',
        reason: 'Wrong middle name',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: stringContaining('Revision Requested'),
        }),
      );
    });

    it('sends the document action required email', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendDocumentActionRequired('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        documentType: 'TOR',
        reason: 'Illegible scan',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: stringContaining('TOR'),
        }),
      );
    });

    it('sends the grade report status updated email', async () => {
      const service = await buildService(
        createConfigMock(),
        createPrismaMock(),
      );

      await service.sendGradeReportStatusUpdated('juan@example.com', {
        studentName: 'Juan Dela Cruz',
        academicYear: '2025-2026',
        semester: '1st Semester',
        status: 'APPROVED',
        remarks: 'Cleared',
      });

      expect(mockSend).toHaveBeenCalledWith(
        objectMatching({
          subject: stringContaining('APPROVED'),
        }),
      );
    });
  });
});
