import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AcademicAppealService } from './academic-appeal.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import type { SubmitAppealDto } from '../dto/submit-appeal.dto.js';
import type { ReviewAppealDto } from '../dto/review-appeal.dto.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const stringMatching = (re: RegExp) => expect.stringMatching(re) as string;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  employee: {
    findUnique: vi.fn(),
  },
  gradeReport: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
  conversation: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  message: {
    create: vi.fn(),
  },
  contract: {
    updateMany: vi.fn(),
  },
  disbursement: {
    updateMany: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createMailMock = () => ({ sendGradeReportStatusUpdated: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
  emitToRoom: vi.fn(),
});

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  user_id: 7,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  student_number: '202300123',
  user: { user_id: 7, email: 'juan@example.com', role: 'SCHOLAR' },
  school_grading_system: null,
  ...overrides,
});

const makeReport = (overrides: Record<string, unknown> = {}) => ({
  report_id: 71,
  scholar_profile_id: 11,
  document_id: 55,
  academic_year: '2026-2027',
  semester: '1st Semester',
  gpa: 4.5,
  evaluation_flag: 'BELOW_PASSING_MARK',
  status: 'FLAGGED',
  is_eligible: false,
  appeal_status: null,
  ...overrides,
});

const makeUpdatedReport = (overrides: Record<string, unknown> = {}) => ({
  ...makeReport(),
  appeal_status: 'PENDING_GRANTOR',
  appeal_submitted_at: new Date('2026-09-01T00:00:00.000Z'),
  appeal_reviewed_at: new Date('2026-09-02T00:00:00.000Z'),
  scholar_profile: makeScholar(),
  grade_items: [],
  document: null,
  ...overrides,
});

const makeSubmitDto = (
  overrides: Record<string, unknown> = {},
): SubmitAppealDto => ({
  appeal_notes: 'I had a medical emergency during finals week.',
  appeal_document_id: 990,
  ...overrides,
});

const makeReviewDto = (
  overrides: Record<string, unknown> = {},
): ReviewAppealDto => ({
  decision: 'APPROVED',
  decision_notes: 'Maintain passing grades.',
  ...overrides,
});

describe('AcademicAppealService', () => {
  let service: AcademicAppealService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let mail: ReturnType<typeof createMailMock>;
  let events: ReturnType<typeof createEventsMock>;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = createPrismaMock();
    audit = createAuditMock();
    mail = createMailMock();
    events = createEventsMock();

    prisma.scholarProfile.findUnique.mockResolvedValue(makeScholar());
    prisma.scholarProfile.update.mockResolvedValue({});
    prisma.employee.findUnique.mockResolvedValue({
      employee_id: 301,
      first_name: 'Gail',
      last_name: 'Grantor',
      user: { user_id: 42 },
    });
    prisma.gradeReport.findUnique.mockResolvedValue(makeReport());
    prisma.gradeReport.findMany.mockResolvedValue([makeReport()]);
    prisma.gradeReport.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeUpdatedReport({ ...data })),
    );
    prisma.user.findMany.mockResolvedValue([
      { user_id: 42, role: 'GRANTOR', is_active: true },
    ]);
    prisma.conversation.findUnique.mockResolvedValue(null);
    prisma.conversation.create.mockResolvedValue({
      conversation_id: 777,
      scholar_user_id: 7,
      coordinator_user_id: 42,
    });
    prisma.conversation.update.mockResolvedValue({});
    prisma.message.create.mockResolvedValue({
      message_id: 555,
      sent_at: new Date('2026-09-01T01:00:00.000Z'),
    });
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    prisma.disbursement.updateMany.mockResolvedValue({ count: 2 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AcademicAppealService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MailService, useValue: mail },
        { provide: EventsGateway, useValue: events },
      ],
    }).compile();

    service = module.get<AcademicAppealService>(AcademicAppealService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('submitAppeal', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.submitAppeal(7, 71, makeSubmitDto()),
      ).rejects.toThrow(new NotFoundException('Scholar profile not found.'));
    });

    it('throws NotFoundException when the grade report does not exist', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(null);

      await expect(
        service.submitAppeal(7, 999, makeSubmitDto()),
      ).rejects.toThrow(
        new NotFoundException('Grade report ID 999 not found.'),
      );
    });

    it('throws ForbiddenException when the report belongs to someone else', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(
        makeReport({ scholar_profile_id: 99 }),
      );

      await expect(
        service.submitAppeal(7, 71, makeSubmitDto()),
      ).rejects.toThrow(
        new ForbiddenException(
          'You cannot appeal a grade report that is not yours.',
        ),
      );
    });

    it('throws BadRequestException when an appeal is already pending for the term', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(
        makeReport({ appeal_status: 'PENDING_GRANTOR' }),
      );

      await expect(
        service.submitAppeal(7, 71, makeSubmitDto()),
      ).rejects.toThrow(
        new BadRequestException(
          'An academic appeal is already under review for this term.',
        ),
      );
    });

    it('flags the report as PENDING_GRANTOR and audits the submission', async () => {
      await service.submitAppeal(7, 71, makeSubmitDto());

      expect(prisma.gradeReport.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { report_id: 71 },
          data: objectMatching({
            appeal_status: 'PENDING_GRANTOR',
            appeal_notes: 'I had a medical emergency during finals week.',
            appeal_document_id: 990,
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'ACADEMIC_APPEAL_SUBMITTED',
        stringMatching(/#71/),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'grade_report:appealed',
        objectMatching({ reportId: 71, gpa: 4.5 }),
      );
    });

    it('creates a conversation for each active grantor when none exists', async () => {
      await service.submitAppeal(7, 71, makeSubmitDto());

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: objectMatching({
          scholar_user_id: 7,
          coordinator_user_id: 42,
          subject: 'Academic Second Chance Appeal - 2026-2027 1st Semester',
        }),
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: objectMatching({
          conversation_id: 777,
          sender_user_id: 7,
          message_type: 'SYSTEM_APPEAL_SUBMITTED',
        }),
      });
      expect(events.emitToRoom).toHaveBeenCalledWith(
        'conversation_777',
        'chat:new_message',
        objectMatching({ conversation_id: 777 }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        42,
        'chat:new_message',
        objectMatching({ conversation_id: 777 }),
      );
    });

    it('reuses the existing conversation when one is already open', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        conversation_id: 888,
      });

      await service.submitAppeal(7, 71, makeSubmitDto());

      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(events.emitToRoom).toHaveBeenCalledWith(
        'conversation_888',
        'chat:new_message',
        objectMatching({ conversation_id: 888 }),
      );
    });

    it('bumps last_message_at and the preview on the conversation', async () => {
      await service.submitAppeal(7, 71, makeSubmitDto());

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { conversation_id: 777 },
        data: objectMatching({
          last_message_preview: stringMatching(/Academic Appeal/),
        }),
      });
    });

    it('swallows a chat notification failure and does not reach audit or events', async () => {
      prisma.conversation.findUnique.mockRejectedValue(
        new Error('chat backend down'),
      );

      await service.submitAppeal(7, 71, makeSubmitDto());

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'ACADEMIC_APPEAL_SUBMITTED',
        expect.any(String),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'grade_report:appealed',
        expect.any(Object),
      );
    });
  });

  describe('reviewAppeal', () => {
    const makePendingReport = () =>
      makeReport({
        appeal_status: 'PENDING_GRANTOR',
        scholar_profile: {
          ...makeScholar(),
          user_id: 7,
          prospectus: null,
        },
      });

    it('throws NotFoundException when the grantor is not an employee', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.reviewAppeal(42, 71, makeReviewDto()),
      ).rejects.toThrow(new NotFoundException('Employee profile not found.'));
    });

    it('throws NotFoundException when the report does not exist', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(null);

      await expect(
        service.reviewAppeal(42, 71, makeReviewDto()),
      ).rejects.toThrow(new NotFoundException('Grade report ID 71 not found.'));
    });

    it('throws BadRequestException when the appeal is not pending', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(
        makeReport({ appeal_status: 'APPROVED' }),
      );

      await expect(
        service.reviewAppeal(42, 71, makeReviewDto()),
      ).rejects.toThrow(/not currently awaiting an appeal decision/);
    });

    it('approves the appeal, puts the scholar on probation, and emails them', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(makePendingReport());

      const result = await service.reviewAppeal(42, 71, makeReviewDto());

      expect(prisma.gradeReport.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectMatching({
            appeal_status: 'APPROVED',
            is_eligible: true,
            status: 'APPROVED',
            appeal_reviewed_by_employee_id: 301,
          }),
        }),
      );
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: { academic_baseline_status: 'ON_PROBATION' },
      });
      expect(prisma.contract.updateMany).not.toHaveBeenCalled();
      expect(mail.sendGradeReportStatusUpdated).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({ status: 'APPROVED' }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'grade_report:appeal_decided',
        objectMatching({ decision: 'APPROVED' }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'grade_report:appeal_decided',
        objectMatching({ decision: 'APPROVED' }),
      );
      expect(result.appeal_status).toBe('APPROVED');
    });

    it('denies the appeal, terminates contracts, discontinues the scholar, and cancels pending disbursements', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(makePendingReport());

      await service.reviewAppeal(
        42,
        71,
        makeReviewDto({
          decision: 'DENIED',
          decision_notes: 'Criteria not met.',
        }),
      );

      expect(prisma.gradeReport.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectMatching({
            appeal_status: 'DENIED',
            is_eligible: false,
            status: 'FLAGGED',
          }),
        }),
      );
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: { academic_baseline_status: 'DISCONTINUED' },
      });
      expect(prisma.contract.updateMany).toHaveBeenCalledWith({
        where: {
          scholar_profile_id: 11,
          status: { in: ['SIGNED', 'PENDING'] },
        },
        data: { status: 'TERMINATED' },
      });
      expect(prisma.disbursement.updateMany).toHaveBeenCalledWith({
        where: {
          scholar_profile_id: 11,
          status: { in: ['PENDING', 'AUTHORIZED'] },
        },
        data: objectMatching({
          status: 'CANCELLED',
          remarks: stringMatching(/appeal denied/i),
        }),
      });
    });

    it('posts the verdict into the existing conversation and emits chat events', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(makePendingReport());
      prisma.conversation.findUnique.mockResolvedValue({
        conversation_id: 888,
      });

      await service.reviewAppeal(42, 71, makeReviewDto());

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: objectMatching({
          conversation_id: 888,
          sender_user_id: 42,
          message_type: 'SYSTEM_APPEAL_APPROVED',
        }),
      });
      expect(events.emitToRoom).toHaveBeenCalledWith(
        'conversation_888',
        'chat:new_message',
        objectMatching({ conversation_id: 888 }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'chat:new_message',
        objectMatching({ conversation_id: 888 }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        42,
        'ACADEMIC_APPEAL_DECIDED',
        stringMatching(/APPROVED/),
      );
    });

    it('skips the verdict chat path when no conversation exists with the grantor', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue(makePendingReport());
      prisma.conversation.findUnique.mockResolvedValue(null);

      await service.reviewAppeal(42, 71, makeReviewDto());

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(events.emitToRoom).not.toHaveBeenCalled();
    });

    it('skips the email when the student has no linked email', async () => {
      prisma.gradeReport.findUnique.mockResolvedValue({
        ...makePendingReport(),
        scholar_profile: { ...makeScholar(), user: null },
      });

      await service.reviewAppeal(42, 71, makeReviewDto());

      expect(mail.sendGradeReportStatusUpdated).not.toHaveBeenCalled();
    });
  });

  describe('getPendingAppeals', () => {
    it('returns pending appeals newest first', async () => {
      const result = await service.getPendingAppeals();

      expect(prisma.gradeReport.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { appeal_status: 'PENDING_GRANTOR' },
          orderBy: { appeal_submitted_at: 'desc' },
        }),
      );
      expect(result).toBeDefined();
    });
  });
});
