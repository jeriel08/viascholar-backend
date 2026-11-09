import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CoordinatorEnrollmentService } from './coordinator-enrollment.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { EnrollmentOcrService } from './enrollment-ocr.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { EnrollmentReviewAction } from '../dto/review-enrollment.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const makeEnrollment = (overrides: Record<string, unknown> = {}) => ({
  enrollment_id: 44,
  scholar_profile_id: 10,
  academic_year: '2026-2027',
  semester: '1st Semester',
  total_assessment: '15000',
  status: 'PENDING_REVIEW',
  cor_document_id: 77,
  soa_document_id: 88,
  coordinator_notes: null,
  enrolled_subjects: [
    { subject_code: 'IT 101', descriptive_title: 'Intro', units: 3 },
    { subject_code: 'MATH 2', descriptive_title: 'Math', units: 3 },
    { subject_code: 'UNKNOWN 9', descriptive_title: 'Elective', units: 3 },
  ],
  scholar_profile: {
    user_id: 3,
    profile_id: 10,
    prospectus: {
      prospectus_id: 55,
      subjects: [
        { subject_id: 1, subject_code: 'IT 101', status: 'UNTAKEN' },
        { subject_id: 2, subject_code: 'MATH 2', status: 'PASSED' },
      ],
    },
  },
  ...overrides,
});

describe('CoordinatorEnrollmentService', () => {
  let service: CoordinatorEnrollmentService;
  let prisma: {
    employee: { findUnique: ReturnType<typeof vi.fn> };
    termEnrollment: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    disbursement: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    prospectusSubject: { update: ReturnType<typeof vi.fn> };
    scholarDocument: { update: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let tx: {
    disbursement: { create: ReturnType<typeof vi.fn> };
    termEnrollment: { update: ReturnType<typeof vi.fn> };
    prospectusSubject: { update: ReturnType<typeof vi.fn> };
    scholarDocument: { update: ReturnType<typeof vi.fn> };
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let events: {
    emitToStaff: ReturnType<typeof vi.fn>;
    emitToUser: ReturnType<typeof vi.fn>;
  };
  let ocr: { normalizeSubjectCode: ReturnType<typeof vi.fn> };
  let cache: {
    del: ReturnType<typeof vi.fn>;
    delPattern: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    tx = {
      disbursement: { create: vi.fn() },
      termEnrollment: { update: vi.fn() },
      prospectusSubject: { update: vi.fn() },
      scholarDocument: { update: vi.fn() },
    };
    const transaction = vi.fn();
    prisma = {
      employee: { findUnique: vi.fn() },
      termEnrollment: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      disbursement: { create: vi.fn(), update: vi.fn() },
      prospectusSubject: { update: vi.fn() },
      scholarDocument: { update: vi.fn() },
      $transaction: transaction,
    };
    audit = { log: vi.fn() };
    events = { emitToStaff: vi.fn(), emitToUser: vi.fn() };
    ocr = {
      normalizeSubjectCode: vi.fn((code: string) =>
        (code || '').replace(/\s/g, '').toUpperCase(),
      ),
    };
    cache = { del: vi.fn(), delPattern: vi.fn() };

    prisma.employee.findUnique.mockResolvedValue({ employee_id: 9 });
    prisma.termEnrollment.findUnique.mockResolvedValue(null);
    prisma.termEnrollment.findMany.mockResolvedValue([]);
    prisma.termEnrollment.update.mockResolvedValue({});
    transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    tx.disbursement.create.mockResolvedValue({
      disbursement_id: 500,
      amount: 15000,
    });
    tx.termEnrollment.update.mockResolvedValue({
      enrollment_id: 44,
      status: 'APPROVED',
    });
    tx.prospectusSubject.update.mockResolvedValue({});
    tx.scholarDocument.update.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoordinatorEnrollmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        { provide: EnrollmentOcrService, useValue: ocr },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<CoordinatorEnrollmentService>(
      CoordinatorEnrollmentService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getPendingEnrollments', () => {
    it('excludes drafts by default and orders the queue by most recently updated', async () => {
      await service.getPendingEnrollments();

      expect(prisma.termEnrollment.findMany).toHaveBeenCalledWith({
        where: { status: { not: 'DRAFT' } },
        orderBy: { updated_at: 'desc' },
        include: {
          scholar_profile: {
            include: { school_grading_system: true },
          },
          cor_document: true,
          soa_document: true,
          reviewed_by_employee: {
            select: {
              employee_id: true,
              first_name: true,
              last_name: true,
              title: true,
            },
          },
          disbursement: true,
        },
      });
    });

    it('filters by an explicit status', async () => {
      await service.getPendingEnrollments(undefined, 'PENDING_REVIEW');

      expect(prisma.termEnrollment.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { status: 'PENDING_REVIEW' },
        }),
      );
    });

    it('treats the ALL status as the default non-draft queue', async () => {
      await service.getPendingEnrollments(undefined, 'ALL');

      expect(prisma.termEnrollment.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { status: { not: 'DRAFT' } },
        }),
      );
    });

    it('searches scholar name, student number, and school case-insensitively', async () => {
      await service.getPendingEnrollments('ana', 'APPROVED');

      expect(prisma.termEnrollment.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: {
            status: 'APPROVED',
            scholar_profile: {
              OR: [
                { first_name: { contains: 'ana', mode: 'insensitive' } },
                { last_name: { contains: 'ana', mode: 'insensitive' } },
                { student_number: { contains: 'ana', mode: 'insensitive' } },
                { school_name: { contains: 'ana', mode: 'insensitive' } },
              ],
            },
          },
        }),
      );
    });
  });

  describe('getEnrollmentDetails', () => {
    it('returns the full enrollment with prospectus subjects in curriculum order', async () => {
      const enrollment = makeEnrollment();
      prisma.termEnrollment.findUnique.mockResolvedValue(enrollment);

      await expect(service.getEnrollmentDetails(44)).resolves.toBe(enrollment);

      expect(prisma.termEnrollment.findUnique).toHaveBeenCalledWith({
        where: { enrollment_id: 44 },
        include: objectMatching({
          scholar_profile: {
            include: {
              school_grading_system: true,
              prospectus: {
                include: {
                  subjects: {
                    orderBy: [
                      { year_level: 'asc' },
                      { semester: 'asc' },
                      { subject_code: 'asc' },
                    ],
                  },
                },
              },
            },
          },
          cor_document: true,
          soa_document: true,
          reviewed_by_employee: true,
          disbursement: true,
        }),
      });
    });

    it('throws NotFoundException for a missing enrollment', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(null);

      await expect(service.getEnrollmentDetails(404)).rejects.toThrow(
        new NotFoundException('Term enrollment #404 not found.'),
      );
    });
  });

  describe('reviewEnrollment', () => {
    it('throws NotFoundException when the reviewer has no employee record', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.reviewEnrollment(5, 44, {
          action: EnrollmentReviewAction.APPROVE,
        }),
      ).rejects.toThrow(
        new NotFoundException('Coordinator employee record not found.'),
      );
      expect(prisma.termEnrollment.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a missing enrollment', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.reviewEnrollment(5, 404, {
          action: EnrollmentReviewAction.APPROVE,
        }),
      ).rejects.toThrow(
        new NotFoundException('Term enrollment #404 not found.'),
      );
    });

    it.each(['APPROVED', 'COMPLETED'])(
      'rejects review of an enrollment already in %s state',
      async (status) => {
        prisma.termEnrollment.findUnique.mockResolvedValue(
          makeEnrollment({ status }),
        );

        await expect(
          service.reviewEnrollment(5, 44, {
            action: EnrollmentReviewAction.APPROVE,
          }),
        ).rejects.toThrow(
          new BadRequestException(
            'Term enrollment #44 has already been reviewed and endorsed.',
          ),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('approves, creates a pending disbursement, verifies documents, transitions subjects, and notifies', async () => {
      const enrollment = makeEnrollment();
      prisma.termEnrollment.findUnique.mockResolvedValue(enrollment);

      const result = await service.reviewEnrollment(5, 44, {
        action: EnrollmentReviewAction.APPROVE,
        coordinator_notes: 'All good',
      });

      expect(prisma.employee.findUnique).toHaveBeenCalledWith({
        where: { user_id: 5 },
      });
      expect(tx.disbursement.create).toHaveBeenCalledWith({
        data: {
          scholar_profile_id: 10,
          academic_year: '2026-2027',
          semester: '1st Semester',
          amount: 15000,
          status: 'PENDING',
          approved_by_employee_id: 9,
          remarks:
            'Tuition & fees disbursement endorsed from Start-of-Term Enrollment Audit. All good',
        },
      });
      expect(tx.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 44 },
        data: {
          status: 'APPROVED',
          reviewed_by_employee_id: 9,
          reviewed_at: anyArg(Date),
          coordinator_notes: 'All good',
          disbursement_id: 500,
          enrolled_subjects: enrollment.enrolled_subjects,
        },
      });
      expect(tx.prospectusSubject.update).toHaveBeenCalledTimes(1);
      expect(tx.prospectusSubject.update).toHaveBeenCalledWith({
        where: { subject_id: 1 },
        data: {
          status: 'ENROLLED',
          remarks: 'Enrolled in 2026-2027 1st Semester',
        },
      });
      expect(tx.scholarDocument.update).toHaveBeenCalledTimes(2);
      expect(tx.scholarDocument.update).toHaveBeenNthCalledWith(1, {
        where: { document_id: 77 },
        data: {
          status: 'VERIFIED',
          verified_at: anyArg(Date),
          reviewed_by_employee_id: 9,
        },
      });
      expect(tx.scholarDocument.update).toHaveBeenNthCalledWith(2, {
        where: { document_id: 88 },
        data: {
          status: 'VERIFIED',
          verified_at: anyArg(Date),
          reviewed_by_employee_id: 9,
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        5,
        'APPROVE_TERM_ENROLLMENT',
        'Approved enrollment #44 for Scholar #10 and queued disbursement of PHP 15000',
      );
      expect(events.emitToStaff).toHaveBeenNthCalledWith(
        1,
        'disbursement:created',
        {
          disbursement_id: 500,
          scholar_id: 10,
          amount: 15000,
          academic_year: '2026-2027',
          semester: '1st Semester',
        },
      );
      expect(events.emitToUser).toHaveBeenCalledWith(3, 'enrollment:approved', {
        enrollment_id: 44,
        scholar_id: 10,
        disbursement_id: 500,
      });
      expect(events.emitToStaff).toHaveBeenNthCalledWith(
        2,
        'enrollment:approved',
        {
          enrollment_id: 44,
          scholar_id: 10,
          disbursement_id: 500,
        },
      );
      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:3');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:10');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:3');
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:coordinator:');
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:grantor:');
      expect(result).toEqual({
        message:
          'Term enrollment approved and endorsed to Grantor disbursement queue.',
        enrollment: { enrollment_id: 44, status: 'APPROVED' },
        disbursement: { disbursement_id: 500, amount: 15000 },
      });
    });

    it('uses an explicit approved amount and adjusted subjects when provided', async () => {
      const adjusted = [
        { subject_code: 'IT 101', descriptive_title: 'Intro', units: 3 },
      ];
      prisma.termEnrollment.findUnique.mockResolvedValue(makeEnrollment());

      await service.reviewEnrollment(5, 44, {
        action: EnrollmentReviewAction.APPROVE,
        approved_amount: 5000,
        adjusted_subjects: adjusted,
      });

      expect(tx.disbursement.create).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({
            amount: 5000,
            remarks:
              'Tuition & fees disbursement endorsed from Start-of-Term Enrollment Audit.',
          }),
        }),
      );
      expect(tx.termEnrollment.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ enrolled_subjects: adjusted }),
        }),
      );
      expect(tx.prospectusSubject.update).toHaveBeenCalledTimes(1);
      expect(events.emitToStaff).toHaveBeenNthCalledWith(
        1,
        'disbursement:created',
        objectMatching({ amount: 5000 }),
      );
    });

    it('skips subject transitions when the scholar has no frozen prospectus', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(
        makeEnrollment({
          scholar_profile: {
            user_id: 3,
            profile_id: 10,
            prospectus: null,
          },
        }),
      );

      await service.reviewEnrollment(5, 44, {
        action: EnrollmentReviewAction.APPROVE,
      });

      expect(tx.prospectusSubject.update).not.toHaveBeenCalled();
      expect(tx.scholarDocument.update).toHaveBeenCalledTimes(2);
    });

    it('verifies a consolidated COR/SOA document only once', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(
        makeEnrollment({ cor_document_id: 77, soa_document_id: 77 }),
      );

      await service.reviewEnrollment(5, 44, {
        action: EnrollmentReviewAction.APPROVE,
      });

      expect(tx.scholarDocument.update).toHaveBeenCalledTimes(1);
      expect(tx.scholarDocument.update).toHaveBeenCalledWith(
        objectMatching({ where: { document_id: 77 } }),
      );
    });

    it('skips document verification when no documents are attached', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(
        makeEnrollment({ cor_document_id: null, soa_document_id: null }),
      );

      await service.reviewEnrollment(5, 44, {
        action: EnrollmentReviewAction.APPROVE,
      });

      expect(tx.scholarDocument.update).not.toHaveBeenCalled();
    });

    it('requests changes with notes, audit trail, and scholar/staff notifications', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(makeEnrollment());
      prisma.termEnrollment.update.mockResolvedValue({
        enrollment_id: 44,
        status: 'CHANGES_REQUESTED',
      });

      const result = await service.reviewEnrollment(5, 44, {
        action: EnrollmentReviewAction.REQUEST_CHANGES,
        coordinator_notes: 'Fix the COR scan',
      });

      expect(prisma.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 44 },
        data: {
          status: 'CHANGES_REQUESTED',
          reviewed_by_employee_id: 9,
          reviewed_at: anyArg(Date),
          coordinator_notes: 'Fix the COR scan',
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        5,
        'REQUEST_CHANGES_TERM_ENROLLMENT',
        'Requested changes for enrollment #44: Fix the COR scan',
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        3,
        'enrollment:changes_requested',
        {
          enrollment_id: 44,
          scholar_id: 10,
          notes: 'Fix the COR scan',
        },
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'enrollment:changes_requested',
        {
          enrollment_id: 44,
          scholar_id: 10,
          notes: 'Fix the COR scan',
        },
      );
      expect(result).toEqual({
        message: 'Changes requested from scholar.',
        enrollment: { enrollment_id: 44, status: 'CHANGES_REQUESTED' },
      });
    });

    it('defaults change-request notes in the audit message', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(makeEnrollment());

      await service.reviewEnrollment(5, 44, {
        action: EnrollmentReviewAction.REQUEST_CHANGES,
      });

      expect(audit.log).toHaveBeenCalledWith(
        5,
        'REQUEST_CHANGES_TERM_ENROLLMENT',
        'Requested changes for enrollment #44: No notes',
      );
    });

    it('rejects the enrollment and notifies the scholar and staff', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(makeEnrollment());
      prisma.termEnrollment.update.mockResolvedValue({
        enrollment_id: 44,
        status: 'REJECTED',
      });

      const result = await service.reviewEnrollment(5, 44, {
        action: EnrollmentReviewAction.REJECT,
        coordinator_notes: 'Invalid assessment',
      });

      expect(prisma.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 44 },
        data: {
          status: 'REJECTED',
          reviewed_by_employee_id: 9,
          reviewed_at: anyArg(Date),
          coordinator_notes: 'Invalid assessment',
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        5,
        'REJECT_TERM_ENROLLMENT',
        'Rejected enrollment #44: Invalid assessment',
      );
      expect(events.emitToUser).toHaveBeenCalledWith(3, 'enrollment:rejected', {
        enrollment_id: 44,
        scholar_id: 10,
        notes: 'Invalid assessment',
      });
      expect(events.emitToStaff).toHaveBeenCalledWith('enrollment:rejected', {
        enrollment_id: 44,
        scholar_id: 10,
        notes: 'Invalid assessment',
      });
      expect(result).toEqual({
        message: 'Term enrollment rejected.',
        enrollment: { enrollment_id: 44, status: 'REJECTED' },
      });
    });
  });

  describe('grantorAuthorizeDisbursement', () => {
    const makePendingEnrollment = (
      overrides: Record<string, unknown> = {},
    ) => ({
      enrollment_id: 44,
      disbursement_id: 500,
      scholar_profile_id: 10,
      scholar_profile: { user_id: 3 },
      disbursement: {
        disbursement_id: 500,
        amount: 15000,
        remarks: 'Original remark',
      },
      ...overrides,
    });

    it('throws NotFoundException for a missing enrollment', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.grantorAuthorizeDisbursement(4, 404),
      ).rejects.toThrow(
        new NotFoundException('Term enrollment #404 not found.'),
      );
    });

    it('rejects authorization when no disbursement is linked', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(
        makePendingEnrollment({ disbursement_id: null, disbursement: null }),
      );

      await expect(service.grantorAuthorizeDisbursement(4, 44)).rejects.toThrow(
        new BadRequestException(
          'No pending disbursement found for this enrollment.',
        ),
      );
      expect(prisma.disbursement.update).not.toHaveBeenCalled();
    });

    it('rejects authorization when the linked disbursement record is missing', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(
        makePendingEnrollment({ disbursement: null }),
      );

      await expect(service.grantorAuthorizeDisbursement(4, 44)).rejects.toThrow(
        new BadRequestException(
          'No pending disbursement found for this enrollment.',
        ),
      );
    });

    it('marks the disbursement released, appends the grantor remark, and notifies both audiences', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(
        makePendingEnrollment(),
      );
      prisma.disbursement.update.mockResolvedValue({
        disbursement_id: 500,
        amount: 15000,
        status: 'RELEASED',
      });

      const result = await service.grantorAuthorizeDisbursement(4, 44, {
        remarks: 'Approved by grantor',
        check_number: 'CHK-001',
        payment_method: 'CHECK',
      });

      expect(prisma.disbursement.update).toHaveBeenCalledWith({
        where: { disbursement_id: 500 },
        data: {
          status: 'RELEASED',
          date_issued: anyArg(Date),
          check_number: 'CHK-001',
          payment_method: 'CHECK',
          remarks:
            'Original remark\nGrantor Authorization: Approved by grantor',
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        4,
        'GRANTOR_APPROVE_DISBURSEMENT',
        'Grantor authorized disbursement #500 of PHP 15000 for scholar #10',
      );
      expect(events.emitToStaff).toHaveBeenCalledWith('disbursement:updated', {
        disbursement_id: 500,
        status: 'RELEASED',
        scholar_id: 10,
      });
      expect(events.emitToUser).toHaveBeenCalledWith(
        3,
        'disbursement:updated',
        {
          disbursement_id: 500,
          status: 'RELEASED',
          amount: 15000,
        },
      );
      expect(result).toEqual({
        message: 'Disbursement authorized and marked as released.',
        disbursement: {
          disbursement_id: 500,
          amount: 15000,
          status: 'RELEASED',
        },
      });
    });

    it('defaults the payment method and preserves existing remarks without a dto', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(
        makePendingEnrollment(),
      );
      prisma.disbursement.update.mockResolvedValue({
        disbursement_id: 500,
        amount: 15000,
        status: 'RELEASED',
      });

      await service.grantorAuthorizeDisbursement(4, 44);

      expect(prisma.disbursement.update).toHaveBeenCalledWith({
        where: { disbursement_id: 500 },
        data: {
          status: 'RELEASED',
          date_issued: anyArg(Date),
          check_number: undefined,
          payment_method: 'BANK_TRANSFER',
          remarks: 'Original remark',
        },
      });
    });

    it('builds a grantor-only remark when the disbursement has no prior notes', async () => {
      prisma.termEnrollment.findUnique.mockResolvedValue(
        makePendingEnrollment({
          disbursement: {
            disbursement_id: 500,
            amount: 15000,
            remarks: null,
          },
        }),
      );
      prisma.disbursement.update.mockResolvedValue({
        disbursement_id: 500,
        amount: 15000,
        status: 'RELEASED',
      });

      await service.grantorAuthorizeDisbursement(4, 44, {
        remarks: 'Released in cash',
      });

      expect(prisma.disbursement.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({
            remarks: 'Grantor Authorization: Released in cash',
          }),
        }),
      );
    });
  });
});
