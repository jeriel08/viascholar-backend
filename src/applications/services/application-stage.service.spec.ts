import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationStageService } from './application-stage.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { ApplicationStatus } from '../../generated/prisma/enums.js';
import type { UpdateApplicationStageDto } from '../dto/update-stage.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  employee: {
    findUnique: vi.fn(),
  },
  application: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  scholarDocument: {
    findMany: vi.fn(),
  },
  scholarProfile: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  user: {
    update: vi.fn(),
  },
});

const createCacheMock = () => ({ delPattern: vi.fn() });

const createAuditMock = () => ({ log: vi.fn() });
const createMailMock = () => ({
  sendApplicationApproved: vi.fn(),
  sendApplicationRejected: vi.fn(),
  sendStageUpdated: vi.fn(),
});
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createNotificationsMock = () => ({
  notifyStaff: vi.fn(),
  notifyUser: vi.fn(),
});

const makeApplication = (overrides: Record<string, unknown> = {}) => ({
  application_id: 42,
  scholar_profile_id: 11,
  scholarship_track: 'Academic Track',
  interview_at: null as Date | null,
  status: 'UNDER_REVIEW',
  stage: 'Under review',
  scholar_profile: {
    profile_id: 11,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    scholarship_track: 'Academic Track',
    user_id: 7,
    user: { user_id: 7, email: 'juan@example.com' },
  },
  ...overrides,
});

const makeStageDto = (overrides: Partial<UpdateApplicationStageDto> = {}) => ({
  status: ApplicationStatus.UNDER_REVIEW,
  stage: 'Under review',
  ...overrides,
});

describe('ApplicationStageService', () => {
  let service: ApplicationStageService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let mail: ReturnType<typeof createMailMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    mail = createMailMock();
    events = createEventsMock();
    notifications = createNotificationsMock();

    prisma.employee.findUnique.mockResolvedValue({
      employee_id: 2,
      first_name: 'Maria',
      last_name: 'Santos',
    });
    prisma.application.findUnique.mockResolvedValue(makeApplication());
    prisma.application.update.mockResolvedValue({
      application_id: 42,
      stage: 'Under review',
      status: 'UNDER_REVIEW',
    });
    prisma.scholarDocument.findMany.mockResolvedValue([
      { document_id: 1, status: 'STUDENT_CONFIRMED' },
    ]);
    prisma.scholarProfile.findUnique.mockResolvedValue({
      profile_id: 11,
      user_id: 7,
      archived_at: null,
      archive_reason: null,
      first_name: 'Juan',
      last_name: 'Dela Cruz',
    });
    prisma.scholarProfile.update.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationStageService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MailService, useValue: mail },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
        { provide: AppCacheService, useValue: createCacheMock() },
      ],
    }).compile();

    service = module.get<ApplicationStageService>(ApplicationStageService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('permissions', () => {
    it('forbids a coordinator from approving an application', async () => {
      await expect(
        service.updateStage(
          2,
          42,
          makeStageDto({ status: 'APPROVED', stage: 'Approved' }),
          'COORDINATOR',
        ),
      ).rejects.toThrow(
        new ForbiddenException(
          'Only grantors and administrators can approve applications.',
        ),
      );
    });

    it('allows grantors and administrators to approve with a completed interview', async () => {
      prisma.application.findUnique.mockResolvedValue(
        makeApplication({ interview_at: new Date('2020-01-01T00:00:00.000Z') }),
      );

      await service.updateStage(
        2,
        42,
        makeStageDto({ status: 'APPROVED', stage: 'Approved' }),
        'GRANTOR',
      );

      expect(prisma.application.update).toHaveBeenCalled();
    });

    it('forbids an applicant from rejecting an application', async () => {
      await expect(
        service.updateStage(
          2,
          42,
          makeStageDto({ status: 'REJECTED', stage: 'Rejected' }),
          'APPLICANT',
        ),
      ).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to reject applications.',
        ),
      );
    });

    it('throws BadRequestException when the staff employee record is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStage(2, 42, makeStageDto(), 'COORDINATOR'),
      ).rejects.toThrow(
        new BadRequestException('Reviewing staff employee record not found.'),
      );
    });

    it('throws NotFoundException when the application does not exist', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStage(2, 999, makeStageDto(), 'COORDINATOR'),
      ).rejects.toThrow('Application ID 999 not found.');
    });
  });

  describe('interview document gate', () => {
    it('blocks moving to interview when the applicant has no documents', async () => {
      prisma.scholarDocument.findMany.mockResolvedValue([]);

      await expect(
        service.updateStage(
          2,
          42,
          makeStageDto({ stage: 'Interview Scheduled' }),
          'COORDINATOR',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot pass applicant to interview because no documents have been submitted.',
        ),
      );
    });

    it('blocks moving to interview when documents are not confirmed', async () => {
      prisma.scholarDocument.findMany.mockResolvedValue([
        { document_id: 1, status: 'PENDING_REVIEW' },
      ]);

      await expect(
        service.updateStage(
          2,
          42,
          makeStageDto({ stage: 'Interview Scheduled' }),
          'COORDINATOR',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot pass applicant to interview: Submitted document(s) have not been confirmed by the applicant yet.',
        ),
      );
    });

    it('allows moving to the interview stage once documents are confirmed', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({ stage: 'Interview Scheduled' }),
        'COORDINATOR',
      );

      expect(prisma.application.update).toHaveBeenCalled();
    });
  });

  describe('interview completion requirement', () => {
    const expectMeetingRequired = async (promise: Promise<unknown>) => {
      try {
        await promise;
        throw new Error('Expected MEETING_CONFIRMATION_REQUIRED to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = (error as BadRequestException).getResponse() as {
          code?: string;
        };
        expect(response.code).toBe('MEETING_CONFIRMATION_REQUIRED');
      }
    };

    it('requires a completed interview before a coordinator accepts', async () => {
      await expectMeetingRequired(
        service.updateStage(
          2,
          42,
          makeStageDto({ stage: 'Accepted', status: 'UNDER_REVIEW' }),
          'COORDINATOR',
        ),
      );
    });

    it('allows a coordinator accept after a completed interview', async () => {
      prisma.application.findUnique.mockResolvedValue(
        makeApplication({ interview_at: new Date('2020-01-01T00:00:00.000Z') }),
      );

      await service.updateStage(
        2,
        42,
        makeStageDto({ stage: 'Accepted', status: 'UNDER_REVIEW' }),
        'COORDINATOR',
      );

      expect(prisma.application.update).toHaveBeenCalled();
    });

    it('proceeds with an explicit confirmation without a meeting', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({
          stage: 'Recommended',
          status: 'UNDER_REVIEW',
          confirm_without_meeting: true,
        }),
        'COORDINATOR',
      );

      expect(prisma.application.update).toHaveBeenCalled();
    });

    it('requires a completed interview before an approving grantor decides', async () => {
      await expectMeetingRequired(
        service.updateStage(
          2,
          42,
          makeStageDto({ status: 'APPROVED', stage: 'Approved' }),
          'GRANTOR',
        ),
      );
    });

    it('approves without a meeting when explicitly confirmed', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({
          status: 'APPROVED',
          stage: 'Approved',
          confirm_without_meeting: true,
        }),
        'GRANTOR',
      );

      expect(prisma.application.update).toHaveBeenCalled();
    });

    it('approves after a completed interview without an explicit confirmation', async () => {
      prisma.application.findUnique.mockResolvedValue(
        makeApplication({ interview_at: new Date('2020-01-01T00:00:00.000Z') }),
      );

      await service.updateStage(
        2,
        42,
        makeStageDto({ status: 'APPROVED', stage: 'Approved' }),
        'GRANTOR',
      );

      expect(prisma.application.update).toHaveBeenCalled();
    });
  });

  describe('data updates', () => {
    it('trims and stores a rejection reason only when rejected', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({
          status: 'REJECTED',
          stage: 'Rejected',
          rejection_reason: '  GWA did not meet the threshold.  ',
        }),
        'GRANTOR',
      );

      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: objectMatching({
          rejection_reason: 'GWA did not meet the threshold.',
        }),
      });
    });

    it('stores null rejection reason for non-rejection decisions', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({ stage: 'Under review', status: 'UNDER_REVIEW' }),
        'COORDINATOR',
      );

      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: objectMatching({ rejection_reason: null }),
      });
    });

    it('sets decision_at only for terminal decisions', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({
          status: 'APPROVED',
          stage: 'Approved',
          confirm_without_meeting: true,
        }),
        'GRANTOR',
      );

      const call = prisma.application.update.mock.calls[0][0] as {
        where: { application_id: number };
        data: { decision_at: Date | null };
      };
      expect(call.data.decision_at).toEqual(anyArg(Date));

      await service.updateStage(
        2,
        42,
        makeStageDto({ stage: 'Under review', status: 'UNDER_REVIEW' }),
        'COORDINATOR',
      );

      const reviewCall = prisma.application.update.mock.calls[1][0] as {
        data: { decision_at: Date | null };
      };
      expect(reviewCall.data.decision_at).toBeNull();
    });
  });

  describe('notifications', () => {
    it('sends the approved email when the application is approved', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({
          status: 'APPROVED',
          stage: 'Approved',
          confirm_without_meeting: true,
        }),
        'ADMIN',
      );

      expect(mail.sendApplicationApproved).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({ studentName: 'Juan Dela Cruz' }),
      );
      expect(mail.sendStageUpdated).not.toHaveBeenCalled();
    });

    it('sends the rejected email when the application is rejected', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({
          status: 'REJECTED',
          stage: 'Rejected',
          rejection_reason: 'Insufficient grade documents',
        }),
        'ADMIN',
      );

      expect(mail.sendApplicationRejected).toHaveBeenCalledWith(
        'juan@example.com',
        {
          studentName: 'Juan Dela Cruz',
          reason: 'Insufficient grade documents',
        },
      );
    });

    it('sends the stage-updated email for other transitions', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({ stage: 'Under review', status: 'UNDER_REVIEW' }),
        'COORDINATOR',
      );

      expect(mail.sendStageUpdated).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({
          studentName: 'Juan Dela Cruz',
          stage: 'Under review',
          status: 'UNDER_REVIEW',
        }),
      );
    });

    it('emits a real-time stage event to staff and the applicant', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({
          stage: 'Recommended',
          status: 'UNDER_REVIEW',
          confirm_without_meeting: true,
        }),
        'COORDINATOR',
      );

      expect(events.emitToStaff).toHaveBeenCalledWith(
        'application:stage_updated',
        objectMatching({ applicationId: 42 }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'application:stage_updated',
        objectMatching({ applicationId: 42 }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({ title: 'Milestone Updated' }),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({ title: 'Milestone Updated' }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'APPLICATION_STAGE_UPDATED',
        expect.stringContaining("stage updated to 'Recommended'"),
      );
    });
  });

  describe('auto archive on rejection', () => {
    it('archives the applicant while keeping their account active when rejected', async () => {
      await service.updateStage(
        2,
        42,
        makeStageDto({
          status: 'REJECTED',
          stage: 'Rejected',
          rejection_reason: 'GWA did not meet the threshold.',
        }),
        'GRANTOR',
      );

      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: expect.objectContaining({
          archived_at: expect.any(Date),
        }),
      });
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: objectMatching({
          archive_reason: 'APPLICATION_REJECTED',
          archive_notes: 'GWA did not meet the threshold.',
        }),
      });
      expect(prisma.user.update).not.toHaveBeenCalledWith({
        where: { user_id: 7 },
        data: { is_active: false },
      });
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'APPLICANT_ARCHIVED',
        expect.any(String),
      );
    });

    it('restores the applicant when the decision is reversed to APPROVED', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue({
        profile_id: 11,
        user_id: 7,
        archived_at: new Date('2026-10-01T00:00:00.000Z'),
        archive_reason: 'APPLICATION_REJECTED',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
      });

      await service.updateStage(
        2,
        42,
        makeStageDto({
          status: 'APPROVED',
          stage: 'Approved',
          confirm_without_meeting: true,
        }),
        'GRANTOR',
      );

      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: objectMatching({ archived_at: null, archive_reason: null }),
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { user_id: 7 },
        data: { is_active: true },
      });
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'APPLICANT_RESTORED',
        expect.any(String),
      );
    });
  });
});